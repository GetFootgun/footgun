// Dependency-free npm semver and PEP 440 range matching.
// Anything not understood yields null ("unknown, do not match").

const NUM = "0|[1-9]\\d*";
const PARTIAL = new RegExp(
  `^[v=]*(${NUM}|[xX*])(?:\\.(${NUM}|[xX*])(?:\\.(${NUM}|[xX*])(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?)?)?$`,
);

// ---------- npm ----------

function wild(s) {
  return s === undefined || s === "x" || s === "X" || s === "*";
}

/** Full version -> [maj, min, pat, pre[]] or null. */
function parseNpmVersion(v) {
  const m = PARTIAL.exec(String(v).trim());
  if (!m || wild(m[1]) || wild(m[2]) || wild(m[3])) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split(".") : []];
}

function cmpPre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d) return d < 0 ? -1 : 1;
    } else if (an !== bn) return an ? -1 : 1;
    else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function cmpNpm(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return cmpPre(a[3], b[3]);
}

/** Partial -> { n: [maj, min, pat] numbers or null for wildcard, pre, count: specified parts } or null. */
function parsePartial(s) {
  const m = PARTIAL.exec(s);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]];
  let count = 0;
  while (count < 3 && !wild(parts[count])) count++;
  for (let i = count; i < 3; i++) if (!wild(parts[i])) return null;
  if (m[4] && count < 3) return null;
  return { n: parts.map((p, i) => (i < count ? Number(p) : 0)), count, pre: m[4] ? m[4].split(".") : [] };
}

const lo = (p) => [p.n[0], p.n[1], p.n[2], p.pre];
const bump = (p, at) => {
  const n = [p.n[0], p.n[1], p.n[2]];
  n[at]++;
  for (let i = at + 1; i < 3; i++) n[i] = 0;
  return [...n, []];
};
const ge = (v) => ({ op: ">=", v });
const gt = (v) => ({ op: ">", v });
const lt = (v) => ({ op: "<", v });
const le = (v) => ({ op: "<=", v });

/** One token (operator + partial) -> comparator list, or null. */
function npmToken(tok) {
  const m = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(tok);
  const op = m[1] === "~>" ? "~" : m[1] || "";
  const p = parsePartial(m[2]);
  if (!p) return null;
  const { count } = p;
  if (count === 0) return op === "" || op === "=" || op === ">=" || op === "<=" || op === "^" || op === "~" ? [] : null;
  const at = Math.min(count, 3) - 1; // index of the last specified part
  switch (op) {
    case "":
    case "=":
      return count === 3 ? [ge(lo(p)), le(lo(p))] : [ge(lo(p)), lt(bump(p, at))];
    case "^": {
      // bump the left-most non-zero specified part
      let i = 0;
      while (i < at && p.n[i] === 0) i++;
      return [ge(lo(p)), lt(bump(p, i))];
    }
    case "~":
      return [ge(lo(p)), lt(bump(p, count === 1 ? 0 : 1))];
    case ">=":
      return [ge(lo(p))];
    case ">":
      return [count === 3 ? gt(lo(p)) : ge(bump(p, at))];
    case "<":
      return [lt(lo(p))];
    case "<=":
      return [count === 3 ? le(lo(p)) : lt(bump(p, at))];
  }
  return null;
}

/** Comparator set (AND) from a space-separated string, or null. */
function npmSet(text) {
  let s = text.trim();
  if (s === "") return [];
  const hy = /^(\S+)\s+-\s+(\S+)$/.exec(s);
  if (hy) {
    const a = parsePartial(hy[1].replace(/^v/, ""));
    const b = parsePartial(hy[2].replace(/^v/, ""));
    if (!a || !b) return null;
    const out = [];
    if (a.count) out.push(ge(lo(a)));
    if (b.count === 3) out.push(le(lo(b)));
    else if (b.count) out.push(lt(bump(b, b.count - 1)));
    return out;
  }
  s = s.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, "$1");
  const out = [];
  for (const tok of s.split(/\s+/)) {
    const c = npmToken(tok);
    if (!c) return null;
    out.push(...c);
  }
  return out;
}

function parseNpmRange(range) {
  if (typeof range !== "string") return null;
  const sets = [];
  for (const part of range.split("||")) {
    const set = npmSet(part);
    if (!set) return null;
    sets.push(set);
  }
  return sets;
}

function holds(c, v) {
  const d = cmpNpm(v, c.v);
  return c.op === ">=" ? d >= 0 : c.op === ">" ? d > 0 : c.op === "<" ? d < 0 : d <= 0;
}

export function satisfiesNpm(version, range) {
  const v = parseNpmVersion(version);
  const sets = parseNpmRange(range);
  if (!v || !sets) return null;
  return sets.some((set) => {
    if (!set.every((c) => holds(c, v))) return false;
    if (!v[3].length) return true;
    // a prerelease only matches a set that names a prerelease of the same major.minor.patch
    return set.some((c) => c.v[3].length && c.v[0] === v[0] && c.v[1] === v[1] && c.v[2] === v[2]);
  });
}

// ---------- PEP 440 ----------

const PEP_VERSION =
  /^v?(?:\d+!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:(?:-(\d+))|(?:[-_.]?(?:post|rev|r)[-_.]?(\d*)))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;

function parsePep(v) {
  const m = PEP_VERSION.exec(String(v).trim());
  if (!m) return null;
  const tag = m[2] && m[2].toLowerCase();
  const kind = !tag ? null : tag === "a" || tag === "alpha" ? 0 : tag === "b" || tag === "beta" ? 1 : 2;
  const hasPost = m[4] !== undefined || /post|rev|r/i.test(m[0].slice(m[1].length)) && m[5] !== undefined;
  return {
    rel: m[1].split(".").map(Number),
    pre: kind === null ? null : [kind, Number(m[3] || 0)],
    post: m[4] !== undefined ? Number(m[4]) : m[5] !== undefined && hasPost ? Number(m[5] || 0) : null,
    dev: m[6] !== undefined ? Number(m[6] || 0) : null,
  };
}

function cmpRel(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function cmpPep(a, b) {
  const r = cmpRel(a.rel, b.rel);
  if (r) return r;
  const preKey = (v) => (v.pre ? v.pre : v.post === null && v.dev !== null ? [-1, 0] : [Infinity, 0]);
  const pa = preKey(a);
  const pb = preKey(b);
  if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  const sa = a.post === null ? -1 : a.post;
  const sb = b.post === null ? -1 : b.post;
  if (sa !== sb) return sa < sb ? -1 : 1;
  const da = a.dev === null ? Infinity : a.dev;
  const db = b.dev === null ? Infinity : b.dev;
  return da === db ? 0 : da < db ? -1 : 1;
}

/** Clause -> predicate over a parsed version, or null. */
function pepClause(text) {
  const m = /^(~=|==|!=|>=|<=|>|<)\s*(\S+)$/.exec(text.trim());
  if (!m) return null;
  const [, op, raw] = m;
  const prefix = /^(.*)\.\*$/.exec(raw);
  if (prefix) {
    if (op !== "==" && op !== "!=") return null;
    const p = parsePep(prefix[1]);
    if (!p || p.pre || p.post !== null || p.dev !== null) return null;
    const hit = (v) => p.rel.every((n, i) => (v.rel[i] ?? 0) === n);
    return op === "==" ? hit : (v) => !hit(v);
  }
  const t = parsePep(raw);
  if (!t) return null;
  switch (op) {
    case "==":
      return (v) => cmpPep(v, t) === 0;
    case "!=":
      return (v) => cmpPep(v, t) !== 0;
    case ">=":
      return (v) => cmpPep(v, t) >= 0;
    case "<=":
      return (v) => cmpPep(v, t) <= 0;
    case ">":
      return (v) => cmpPep(v, t) > 0;
    case "<": {
      // <V never matches a prerelease of V itself
      const plain = !t.pre && t.dev === null && t.post === null;
      return (v) => cmpPep(v, t) < 0 && !(plain && (v.pre || v.dev !== null) && cmpRel(v.rel, t.rel) === 0);
    }
    case "~=": {
      if (t.rel.length < 2) return null;
      const head = t.rel.slice(0, -1);
      return (v) => cmpPep(v, t) >= 0 && head.every((n, i) => (v.rel[i] ?? 0) === n);
    }
  }
  return null;
}

function parsePepSpec(spec) {
  if (typeof spec !== "string" || spec.trim() === "") return null;
  const preds = [];
  for (const part of spec.split(",")) {
    const p = pepClause(part);
    if (!p) return null;
    preds.push(p);
  }
  return preds;
}

export function satisfiesPep440(version, spec) {
  const v = parsePep(version);
  const preds = parsePepSpec(spec);
  if (!v || !preds) return null;
  return preds.every((p) => p(v));
}

// ---------- rule gate ----------

export function rangeSupported(ecosystem, range) {
  const r = typeof range === "string" ? range.trim() : "";
  if (ecosystem === "service") return r === "" || r === "*";
  if (ecosystem === "pypi") return parsePepSpec(r) !== null;
  if (ecosystem === "npm" || ecosystem === "github-action") return parseNpmRange(r) !== null;
  return false;
}
