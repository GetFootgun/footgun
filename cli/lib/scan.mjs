// Local scanner core: reads manifests, decides which trap rules apply to which
// subtree, and runs detect patterns over files. Nothing leaves the machine.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { ruleProblems, globMatch } from "./rules.mjs";
import { satisfiesNpm, satisfiesPep440 } from "./versions.mjs";
import { buildManifests, normalizePypi } from "./manifests.mjs";

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "out", ".venv", "__pycache__"]);
const MAX_FILE = 1024 * 1024;
const BUDGET_MS = 200;
const BATCH_FILES = 64;
const BATCH_BYTES = 8 * 1024 * 1024;
const SEVERITIES = ["breaks", "will-break", "silent", "cost"];
const ECOSYSTEMS = ["npm", "pypi", "github-action", "service"];

// ---------- walking ----------

function loadGitignore(root) {
  let text = "";
  try { text = readFileSync(join(root, ".gitignore"), "utf8"); } catch { return []; }
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    let p = raw.trim();
    if (!p || p.startsWith("#") || p.startsWith("!")) continue;
    const dirOnly = p.endsWith("/");
    if (dirOnly) p = p.replace(/\/+$/, "");
    const anchored = p.includes("/");
    p = p.replace(/^\//, "");
    if (p) out.push({ p, dirOnly, anchored });
  }
  return out;
}

function ignored(rules, rel, name, isDir) {
  return rules.some((r) => (!r.dirOnly || isDir) && globMatch(r.p, r.anchored ? rel : name));
}

function isSecretEnv(name) {
  return (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";
}

// Test and fixture code is skipped by default; a detect whose globs name test code still runs there.
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "__mocks__", "__fixtures__", "fixtures", "e2e"]);
const TEST_FILE = /\.(test|spec|stories)\./;

function isTestPath(rel) {
  const parts = rel.split("/");
  return parts.slice(0, -1).some((p) => TEST_DIRS.has(p)) || TEST_FILE.test(parts[parts.length - 1]);
}

// a glob targets test code when one of its path segments is a test directory name or its file name is a test file
// pattern; "test" inside another word ("latest", "contest") does not count
const TEST_SEGMENT = /^(?:__tests__|tests?|specs?|e2e|playwright)$/;
const TEST_NAME = /[.{,](?:test|spec)[.},]/;

function targetsTests(d) {
  return d.files.some((g) => {
    const parts = g.split("/");
    return parts.some((p) => TEST_SEGMENT.test(p)) || TEST_NAME.test(parts[parts.length - 1]);
  });
}

function walk(root) {
  const rules = loadGitignore(root);
  const out = [];
  const visit = (dir) => {
    let entries;
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !ignored(rules, rel, e.name, true)) visit(rel);
      } else if (e.isFile() && !isSecretEnv(e.name) && !ignored(rules, rel, e.name, false)) {
        out.push(rel);
      }
    }
  };
  visit("");
  return out;
}

export function readManifests(root) {
  return buildManifests(root, walk(root));
}

function readText(abs) {
  try {
    if (statSync(abs).size > MAX_FILE) return null;
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

// ---------- rules ----------

function shapeProblem(rule) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return "rule must be an object";
  if (typeof rule.id !== "string" || !rule.id) return "id must be a non-empty string";
  for (const k of ["title", "provider", "fix"]) if (typeof rule[k] !== "string") return `${k} must be a string`;
  if (!SEVERITIES.includes(rule.severity)) return "severity is not recognised";
  for (const k of ["deadline", "url"]) {
    if (rule[k] != null && typeof rule[k] !== "string") return `${k} must be a string or null`;
  }
  if (typeof rule.checkManually !== "boolean") return "checkManually must be a boolean";
  if (!Array.isArray(rule.packages) || !rule.packages.every((p) =>
    p && ECOSYSTEMS.includes(p.ecosystem) && typeof p.name === "string" && typeof p.range === "string")) {
    return "packages must be a list of package refs";
  }
  if (!Array.isArray(rule.detect)) return "detect must be a list";
  const problems = rule.detect.flatMap((d) => ruleProblems(d));
  return problems.length ? [...new Set(problems)].join("; ") : null;
}

const BROAD = new Set(["*", "", "x", "X"]);

// "any version": a literal wildcard, or a range that both the lowest and a very high version satisfy (">=0", "^0 || >=1")
function isBroad(range, check) {
  return BROAD.has(range.trim()) || (check("0.0.0", range) === true && check("999999.0.0", range) === true);
}

/**
 * null when m satisfies none of the rule's npm, pypi or github-action refs (a rule with none of those,
 * such as one with only service refs, never applies to a local scan); else the satisfied ref as
 * { pkg: { ecosystem, name, version }, broad }, preferring one whose range is narrower than "any version".
 */
function applies(rule, m) {
  const gating = rule.packages.filter((p) => p.ecosystem !== "service");
  let found = null;
  for (const p of gating) {
    const table = p.ecosystem === "npm" ? m.npm : p.ecosystem === "pypi" ? m.pypi : m.actions;
    const name = p.ecosystem === "pypi" ? normalizePypi(p.name) : p.name;
    if (!Object.hasOwn(table, name)) continue;
    const check = p.ecosystem === "pypi" ? satisfiesPep440 : satisfiesNpm;
    if (check(table[name], p.range) !== true) continue;
    const broad = isBroad(p.range, check);
    if (!found || (found.broad && !broad)) found = { pkg: { ecosystem: p.ecosystem, name, version: table[name] }, broad };
    if (!broad) break;
  }
  return found;
}

// ---------- matching in a worker ----------

function matcherError(cause) {
  const why = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Footgun scanner could not start its matcher: ${why}`, { cause });
}

async function startWorker(detects, progress) {
  let worker;
  try {
    worker = new Worker(new URL("./scan-worker.mjs", import.meta.url), { workerData: { detects, progress } });
  } catch (err) {
    throw matcherError(err);
  }
  return new Promise((resolve, reject) => {
    const fail = (err) => { worker.off("message", ready); reject(matcherError(err)); };
    const exited = (code) => fail(`the matcher exited with code ${code}`);
    const ready = () => { worker.off("error", fail); worker.off("exit", exited); resolve(worker); };
    worker.once("message", ready);
    worker.once("error", fail);
    worker.once("exit", exited);
  });
}

/** Resolves with the hits, plus the detect index that stalled or crashed (if any) and the files not finished. */
function runBatch(worker, batch, progress) {
  return new Promise((resolve) => {
    const done = new Set();
    const hits = [];
    // The stall clock starts only once the worker reports its first (file, detect) pair.
    Atomics.store(progress, 1, -1);
    let seen = Atomics.load(progress, 0);
    let seenAt = null;
    const finish = (stuck, why) => {
      clearInterval(timer);
      worker.off("message", onMessage);
      worker.off("error", onFail);
      worker.off("exit", onFail);
      resolve({ hits, stuck, why, rest: batch.filter((_, i) => !done.has(i)) });
    };
    const onMessage = ({ i, hits: found }) => {
      done.add(i);
      for (const [d, lines] of found) for (const line of lines) hits.push({ rel: batch[i].rel, d, line });
      if (done.size === batch.length) finish();
    };
    const onFail = () => finish(Atomics.load(progress, 1), "rule failed");
    const timer = setInterval(() => {
      const now = Atomics.load(progress, 0);
      if (now !== seen) { seen = now; seenAt = Date.now(); }
      else if (seenAt !== null && Date.now() - seenAt > BUDGET_MS) finish(Atomics.load(progress, 1), "rule timed out");
    }, 20);
    worker.on("message", onMessage);
    worker.on("error", onFail);
    worker.on("exit", onFail);
    worker.postMessage(batch.map(({ rel, text, ds }) => ({ rel, text, ds })));
  });
}

/** Runs jobs ({ rel, ds }) and returns hits ({ rel, d, line }). Calls onSkip(ruleIndex, why) for a rule that stalls. */
async function runDetects(root, jobs, detects, onSkip) {
  const banned = new Set();
  const hits = [];
  const queue = jobs.slice();
  const nextBatch = () => {
    const batch = [];
    let bytes = 0;
    while (queue.length && batch.length < BATCH_FILES && bytes < BATCH_BYTES) {
      const job = queue.shift();
      const ds = job.ds.filter((d) => !banned.has(detects[d].ri));
      if (!ds.length) continue;
      const text = job.text ?? readText(join(root, job.rel));
      if (text === null) continue;
      batch.push({ rel: job.rel, text, ds });
      bytes += text.length;
    }
    return batch;
  };
  const payload = detects.map(({ files, pattern, unless }) => ({ files, pattern, unless }));
  let batch = nextBatch();
  while (batch.length) {
    const progress = new Int32Array(new SharedArrayBuffer(8));
    const worker = await startWorker(payload, progress.buffer);
    try {
      while (batch.length) {
        const res = await runBatch(worker, batch, progress);
        hits.push(...res.hits);
        if (res.stuck === -1) throw matcherError("the matcher stopped before checking any file");
        if (res.stuck !== undefined) {
          const ri = detects[res.stuck].ri;
          banned.add(ri);
          onSkip(ri, res.why);
          queue.unshift(...res.rest);
          batch = nextBatch();
          break;
        }
        batch = nextBatch();
      }
    } finally {
      await worker.terminate();
    }
  }
  return hits.filter((h) => !banned.has(detects[h.d].ri));
}

// ---------- scan ----------

function finding(rule, file, line, manual) {
  return {
    trapId: rule.id,
    title: rule.title,
    provider: rule.provider,
    severity: rule.severity,
    deadline: rule.deadline ?? null,
    file,
    line,
    fix: rule.fix,
    url: rule.url ?? null,
    private: rule.private === true,
    manual,
    launch: rule.launch === true,
  };
}

export async function scanProject(root, rules) {
  const skippedRules = [];
  const good = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    let why;
    try { why = shapeProblem(rule); } catch { why = "rule could not be read"; }
    if (why) skippedRules.push({ id: typeof rule?.id === "string" && rule.id ? rule.id : "(unknown)", why });
    else good.push(rule);
  }

  const files = walk(root);
  const manifests = buildManifests(root, files);
  const matches = manifests.map((m) => good.map((r) => applies(r, m)));
  const byDepth = manifests.map((m, i) => ({ dir: m.dir, i })).sort((a, b) => b.dir.length - a.dir.length);
  const owner = (rel) => byDepth.find(({ dir }) => dir === "" || rel.startsWith(`${dir}/`)).i;

  const detects = good.flatMap((r, ri) => r.detect.map((d) => ({ ri, ...d })));
  const jobs = [];
  for (const rel of files) {
    const ok = matches[owner(rel)];
    const ds = [];
    const inTests = isTestPath(rel);
    detects.forEach((d, k) => { if (ok[d.ri] && (!inTests || targetsTests(d)) && d.files.some((g) => globMatch(g, rel))) ds.push(k); });
    if (ds.length) jobs.push({ rel, ds });
  }

  const skipped = new Set();
  const hits = jobs.length
    ? await runDetects(root, jobs, detects, (ri, why) => {
        skipped.add(ri);
        skippedRules.push({ id: good[ri].id, why });
      })
    : [];

  const findings = [];
  // one finding per trap per file, at its lowest matching line
  const first = new Map();
  const hitRules = new Set();
  for (const { rel, d, line } of hits) {
    const ri = detects[d].ri;
    const key = `${ri}\0${rel}`;
    hitRules.add(ri);
    if (!first.has(key) || line < first.get(key).line) first.set(key, { ri, rel, line });
  }
  for (const { ri, rel, line } of first.values()) findings.push(finding(good[ri], rel, line, false));
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  // a manual finding and the applicable list both need a ref narrower than "any version": a broad ref
  // only shows the package is present, which is enough to run detect rules but not to say the trap applies
  const narrow = (ri) => matches.findIndex((row) => row[ri] && !row[ri].broad);
  const present = (ri) => matches.some((row) => row[ri]);
  good.forEach((r, ri) => {
    // a launch check ("you use Supabase, so check RLS") is about the package being there, so any ref counts
    const shows = r.launch === true ? present(ri) : narrow(ri) !== -1;
    if (r.checkManually && !skipped.has(ri) && !hitRules.has(ri) && shows) {
      findings.push(finding(r, null, null, true));
    }
  });
  // rules a manifest satisfies through a ref narrower than "any version", hit or not (the first such
  // manifest); a rule the matcher skipped is left out, as it is from findings
  const applicable = [];
  good.forEach((r, ri) => {
    const mi = narrow(ri);
    if (mi !== -1 && !skipped.has(ri)) applicable.push({ trapId: r.id, package: matches[mi][ri].pkg, dir: manifests[mi].dir });
  });
  return { findings, skippedRules, applicable };
}
