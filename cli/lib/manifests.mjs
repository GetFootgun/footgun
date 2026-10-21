// Dependency-free manifest and lockfile readers for the local scanner.
// Every value is a resolved version string; anything not understood is left out.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { satisfiesNpm } from "./versions.mjs";

const PARTIAL = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function put(table, name, version) {
  if (name && name !== "__proto__" && version) table[name] = version;
}

function read(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function readJson(path) {
  const text = read(path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** "^23.0.0" -> "23.0.0", "~2.1" -> "2.1.0", "1.x" -> "1.0.0"; null when there is no lower bound. */
export function lowestNpm(range) {
  if (typeof range !== "string") return null;
  const first = range.split("||")[0].trim().replace(/^(?:\^|~>?|>=|=)\s*/, "").split(/\s+/)[0];
  const m = PARTIAL.exec(first ?? "");
  if (!m) return null;
  const n = (s) => (s === undefined || /[xX*]/.test(s) ? "0" : s);
  return `${m[1]}.${n(m[2])}.${n(m[3])}${m[4] ?? ""}`;
}

/** ">=2.0" -> "2.0", "==1.2.3" -> "1.2.3", "^2.5" -> "2.5"; null when there is no lower bound. */
export function lowestPep(spec) {
  if (typeof spec !== "string") return null;
  for (const clause of spec.split(",")) {
    const c = clause.trim();
    if (/^[<>!]/.test(c) && !c.startsWith(">=")) continue;
    const v = c.replace(/^(?:===|==|>=|~=|\^|~)\s*/, "").replace(/\.\*$/, "");
    if (/^\d+(?:\.\d+)*(?:[-_.]?[a-z0-9]+)*$/i.test(v)) return v;
  }
  return null;
}

export function normalizePypi(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, "-");
}

function pickVersion(candidates, range) {
  return (candidates ?? []).find((v) => satisfiesNpm(v, range) === true) ?? null;
}

// ---------- npm lockfiles ----------

/** A minimal YAML reader for pnpm-lock.yaml: block mappings only, scalars kept as strings. */
function readYamlMaps(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#") || raw.trimStart().startsWith("- ")) continue;
    const indent = raw.length - raw.trimStart().length;
    const m = /^(['"]?)(.+?)\1:(?:\s+(.*))?$/.exec(raw.trim());
    if (!m) continue;
    while (stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const key = m[2];
    if (key === "__proto__") continue;
    const value = m[3]?.trim();
    if (value) parent[key] = value.replace(/^(['"])(.*)\1$/, "$2");
    else {
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
    }
  }
  return root;
}

function pnpmResolver(text) {
  const doc = readYamlMaps(text);
  const importers = doc.importers ?? { ".": doc };
  const byName = new Map();
  for (const key of Object.keys(doc.packages ?? {})) {
    const k = key.replace(/^\//, "").replace(/\(.*$/, "");
    // pnpm v5 keys are "name/1.2.3_peer@x"; later ones are "name@1.2.3".
    const v5 = /^(.+)\/(\d[^/]*)$/.exec(k);
    const at = k.lastIndexOf("@");
    const [name, version] = v5 ? [v5[1], v5[2].replace(/_.*$/, "")] : [k.slice(0, at), k.slice(at + 1)];
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(version);
  }
  return (rel, name, range) => {
    const imp = importers[rel || "."];
    for (const sec of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const entry = imp?.[sec]?.[name];
      const v = typeof entry === "string" ? entry : entry?.version;
      if (typeof v === "string") return v.replace(/[(_].*$/, "");
    }
    return pickVersion(byName.get(name), range);
  };
}

function yarnResolver(text) {
  const bySpec = new Map();
  const byName = new Map();
  let specs = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\S.*:$/.test(line) && !line.startsWith("#")) {
      specs = line.slice(0, -1).split(/,\s*/).map((s) => s.replace(/^"|"$/g, ""));
      continue;
    }
    const m = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (!m || !specs.length) continue;
    for (const spec of specs) {
      const at = spec.lastIndexOf("@");
      if (at <= 0) continue;
      const name = spec.slice(0, at);
      bySpec.set(`${name}@${spec.slice(at + 1).replace(/^npm:/, "")}`, m[1]);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(m[1]);
    }
    specs = [];
  }
  return (_rel, name, range) => bySpec.get(`${name}@${range}`) ?? pickVersion(byName.get(name), range);
}

function packageLockResolver(lock) {
  const pkgs = lock?.packages ?? {};
  return (rel, name, range) => {
    const own = pkgs[posix.join(rel, "node_modules", name)]?.version;
    if (own) return own;
    const hoisted = pkgs[`node_modules/${name}`]?.version;
    // A nested manifest only shares the root copy when that copy fits its own range.
    if (!hoisted || (rel !== "" && satisfiesNpm(hoisted, range) !== true)) return null;
    return hoisted;
  };
}

/** Nearest lockfile at or above `dir` (both relative to root). */
function findNpmLock(root, dir) {
  for (let d = dir; ; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
    const abs = join(root, d);
    const rel = dir === d ? "" : dir.slice(d ? d.length + 1 : 0);
    if (existsSync(join(abs, "package-lock.json"))) {
      const lock = readJson(join(abs, "package-lock.json"));
      return { rel, resolve: packageLockResolver(lock), declared: lock?.packages?.[rel] };
    }
    const pnpm = read(join(abs, "pnpm-lock.yaml"));
    if (pnpm !== null) return { rel, resolve: pnpmResolver(pnpm) };
    const yarn = read(join(abs, "yarn.lock"));
    if (yarn !== null) return { rel, resolve: yarnResolver(yarn) };
    if (d === "") return null;
  }
}

function readNpm(root, dir) {
  const out = {};
  const pkg = readJson(join(root, dir, "package.json"));
  if (!pkg) return out;
  const lock = findNpmLock(root, dir);
  const ranges = {};
  for (const src of [lock?.declared, pkg]) {
    for (const sec of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries(src?.[sec] ?? {})) {
        if (typeof range === "string" && name !== "__proto__") ranges[name] = range;
      }
    }
  }
  for (const [name, range] of Object.entries(ranges)) {
    const locked = lock?.resolve(lock.rel, name, range);
    put(out, name, (locked && PARTIAL.test(locked) ? locked : null) ?? lowestNpm(range));
  }
  return out;
}

// ---------- python ----------

function parseRequirement(line) {
  const s = line.replace(/\s#.*$/, "").replace(/\s*\\\s*$/, "").replace(/\s--hash=\S+/g, "").split(";")[0].trim();
  if (!s || s.startsWith("-") || s.startsWith("#") || s.includes("://") || s.includes("@")) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(s);
  return m ? [normalizePypi(m[1]), lowestPep(m[2])] : null;
}

function readPyproject(text) {
  const out = {};
  let table = "";
  let inArray = false;
  const addQuoted = (s) => {
    for (const m of s.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const r = parseRequirement(m[1] ?? m[2]);
      if (r) put(out, ...r);
    }
    inArray = !s.includes("]");
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, "").trim();
    if (inArray) { addQuoted(line); continue; }
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { table = header[1].trim(); continue; }
    if (table === "project" && /^dependencies\s*=\s*\[/.test(line)) {
      addQuoted(line.slice(line.indexOf("[") + 1));
      continue;
    }
    if (/^tool\.poetry(?:\.group\.[^.]+)?\.dependencies$/.test(table)) {
      const m = /^["']?([A-Za-z0-9._-]+)["']?\s*=\s*(.*)$/.exec(line);
      if (!m || m[1].toLowerCase() === "python") continue;
      const spec = /^["']([^"']*)["']/.exec(m[2])?.[1] ?? /version\s*=\s*["']([^"']*)["']/.exec(m[2])?.[1];
      put(out, normalizePypi(m[1]), lowestPep(spec));
    }
  }
  return out;
}

function readPoetryLock(text) {
  const out = {};
  let name = null;
  let version = null;
  let top = false;
  const flush = () => { if (name && version) put(out, normalizePypi(name), version); name = version = null; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") { flush(); top = true; continue; }
    if (line.startsWith("[")) { top = false; continue; }
    if (!top) continue;
    const m = /^(name|version)\s*=\s*"([^"]*)"/.exec(line);
    if (m && m[1] === "name") name = m[2];
    else if (m) version = m[2];
  }
  flush();
  return out;
}

function readPypi(root, dir) {
  const out = {};
  const abs = join(root, dir);
  let names = [];
  try { names = readdirSync(abs).filter((n) => /^requirements.*\.txt$/.test(n)).sort(); } catch {}
  for (const n of names) {
    for (const line of (read(join(abs, n)) ?? "").split(/\r?\n/)) {
      const r = parseRequirement(line);
      if (r) put(out, ...r);
    }
  }
  const pyproject = read(join(abs, "pyproject.toml"));
  if (pyproject !== null) Object.assign(out, readPyproject(pyproject));
  const lock = read(join(abs, "poetry.lock"));
  if (lock !== null) {
    const locked = readPoetryLock(lock);
    for (const name of Object.keys(out)) if (Object.hasOwn(locked, name)) out[name] = locked[name];
  }
  return out;
}

// ---------- github actions ----------

function readActions(root) {
  const out = {};
  const dir = join(root, ".github", "workflows");
  let names = [];
  try { names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort(); } catch {}
  for (const n of names) {
    for (const line of (read(join(dir, n)) ?? "").split(/\r?\n/)) {
      const m = /^\s*(?:-\s*)?uses:\s*["']?([^"'\s#]+)/.exec(line);
      if (!m || m[1].startsWith("./") || m[1].startsWith("docker://")) continue;
      const at = m[1].lastIndexOf("@");
      const v = at > 0 ? /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(m[1].slice(at + 1)) : null;
      if (!v) continue;
      const name = m[1].slice(0, at).split("/").slice(0, 2).join("/");
      const version = `${v[1]}.${v[2] ?? 0}.${v[3] ?? 0}`;
      if (!Object.hasOwn(out, name) || satisfiesNpm(version, `<${out[name]}`) === true) put(out, name, version);
    }
  }
  return out;
}

// ---------- manifests ----------

const MANIFEST = /^(?:package\.json|pyproject\.toml|requirements.*\.txt)$/;

/** Manifests for the directories (relative to root) that hold a package.json, pyproject.toml or requirements*.txt. The root is always included. */
export function buildManifests(root, files) {
  const dirs = new Set([""]);
  for (const rel of files) {
    const slash = rel.lastIndexOf("/");
    if (MANIFEST.test(rel.slice(slash + 1))) dirs.add(slash < 0 ? "" : rel.slice(0, slash));
  }
  return [...dirs].sort().map((dir) => ({
    dir,
    npm: readNpm(root, dir),
    pypi: readPypi(root, dir),
    actions: dir === "" ? readActions(root) : {},
  }));
}
