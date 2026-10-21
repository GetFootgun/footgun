// Downloads, caches and validates the Footgun rule pack. Only the pack request leaves the machine.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ruleProblems } from "./rules.mjs";

export class NoRulesError extends Error {
  constructor() { super("Could not download Footgun rules and no cached copy exists."); this.name = "NoRulesError"; }
}

export function defaultCacheDir() { return join(homedir(), ".footgun"); }

// The key itself never reaches disk: a keyed pack is cached under a short hash of it.
function cacheFile(cacheDir, key) {
  return join(cacheDir, key ? `rules-${createHash("sha256").update(key).digest("hex").slice(0, 12)}.json` : "rules.json");
}

function isPack(p) {
  return !!p && typeof p === "object" && typeof p.version === "string" && Array.isArray(p.rules);
}

function readCache(file) {
  try {
    const c = JSON.parse(readFileSync(file, "utf8"));
    return c && typeof c.fetchedAt === "string" && isPack(c.pack) ? c : null;
  } catch {
    return null;
  }
}

function writeCache(cacheDir, file, pack) {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date().toISOString(), pack }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  } catch {
    // a cache we cannot write only costs the offline fallback next time
  }
}

// Drops rules whose detect patterns are unsafe or malformed. scanProject checks the rest of the shape.
function validate(raw) {
  const rules = [];
  const skippedRules = [];
  for (const rule of raw.rules) {
    const id = rule && typeof rule.id === "string" && rule.id ? rule.id : "(unknown)";
    let why = null;
    try {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) why = "rule must be an object";
      else if (!Array.isArray(rule.detect)) why = "detect must be a list";
      else {
        const problems = [...new Set(rule.detect.flatMap((d) => ruleProblems(d)))];
        if (problems.length) why = problems.join("; ");
      }
    } catch {
      why = "rule could not be read";
    }
    if (why) skippedRules.push({ id, why });
    else rules.push(rule);
  }
  return { version: raw.version, generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : null, rules, skippedRules };
}

/**
 * Returns { pack: { version, generatedAt, rules, skippedRules, cachedAt }, fromCache }.
 * fromCache is true only when the download failed and the last cached pack was used.
 */
export async function loadPack({ url, key, cacheDir = defaultCacheDir(), timeoutMs = 5000 }) {
  const file = cacheFile(cacheDir, key);
  const cached = readCache(file);
  const headers = { accept: "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  if (cached) headers["if-none-match"] = `"${cached.pack.version}"`;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const r = await fetch(`${url.replace(/\/+$/, "")}/api/v1/rules`, { headers, signal });
    if (r.status === 304 && cached) {
      writeCache(cacheDir, file, cached.pack);
      return { pack: { ...validate(cached.pack), cachedAt: null }, fromCache: false };
    }
    if (!r.ok) throw new Error(`rule pack request failed: ${r.status}`);
    const body = await r.json();
    if (!isPack(body)) throw new Error("rule pack has the wrong shape");
    writeCache(cacheDir, file, body);
    return { pack: { ...validate(body), cachedAt: null }, fromCache: false };
  } catch {
    if (!cached) throw new NoRulesError();
    return { pack: { ...validate(cached.pack), cachedAt: cached.fetchedAt }, fromCache: true };
  }
}

const SEVERITY_KEY = { breaks: "breaks", "will-break": "willBreak", silent: "silent", cost: "cost" };

/** Finding counts by severity for the usage ping. Manual "check yourself" findings count under their severity. */
export function pingCounts(findings) {
  const counts = { breaks: 0, willBreak: 0, silent: 0, cost: 0 };
  for (const f of findings) {
    const k = SEVERITY_KEY[f?.severity];
    if (k) counts[k] = Math.min(counts[k] + 1, 10000);
  }
  return counts;
}

/**
 * Anonymous usage ping: the kind of run, whether Node was found and finding counts by severity. Nothing else.
 * Skipped when FOOTGUN_SHARE is "false". Never throws, never prints, and gives up after timeoutMs.
 */
export async function sendPing({ url, kind, counts, nodeFound = true, timeoutMs = 2000 }) {
  if (process.env.FOOTGUN_SHARE === "false") return;
  try {
    await fetch(`${url.replace(/\/+$/, "")}/api/v1/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, nodeFound, counts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // a ping that fails costs nothing
  }
}
