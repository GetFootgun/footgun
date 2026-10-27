// Builds and sends the Watch body for `footgun scan --watch`. Only the project name, package names with resolved
// versions, and each finding's trap id, file and line are sent. No file content, snippet or match text, ever.
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// These mirror the server's limits (lib/watch.ts), so a big project is trimmed rather than refused.
const MAX_NAME = 200;
const MAX_VERSION = 100;
const MAX_MANIFESTS = 20;
const MAX_PACKAGES = 2000;
const MAX_FINDINGS = 500;
const MAX_LINE = 10_000_000;
const TRAP_ID = /^fg-\d{4,}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const okString = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && !CONTROL.test(v);

function readFile(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** package.json name, then the pyproject.toml [project] name, then the folder's name. */
export function defaultProjectName(root) {
  const abs = resolve(root);
  try {
    const n = JSON.parse(readFile(join(abs, "package.json")) ?? "null")?.name;
    if (okString(n, MAX_NAME)) return n;
  } catch {}
  const toml = readFile(join(abs, "pyproject.toml"));
  if (toml !== null) {
    let inProject = false;
    for (const line of toml.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (section) { inProject = section[1].trim() === "project"; continue; }
      const m = inProject ? /^\s*name\s*=\s*["']([^"']+)["']/.exec(line) : null;
      if (m && okString(m[1], MAX_NAME)) return m[1];
    }
  }
  return basename(abs) || "project";
}

// Name -> version, dropping entries the server would refuse, up to `budget` of them.
function packages(table, budget) {
  const out = {};
  let n = 0;
  for (const [name, version] of Object.entries(table ?? {})) {
    if (n >= budget) break;
    if (!okString(name, MAX_NAME) || !okString(version, MAX_VERSION) || name === "__proto__") continue;
    out[name] = version;
    n++;
  }
  return out;
}

/** The server's rule for repoUrl: http(s), no credentials, query or fragment, at most 200 characters. */
export function validRepoUrl(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !u.search && !u.hash;
  } catch { return false; }
}

/** No control characters, trimmed, cut by code point so a surrogate pair is never split; "project" if nothing is left. */
export function cleanProjectName(name) {
  const t = String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  let out = "";
  for (const ch of t) { if (out.length + ch.length > MAX_NAME) break; out += ch; }
  return out.trim() || "project";
}

export function buildWatchBody(name, manifests, findings, repoUrl) {
  const body = { project: cleanProjectName(name), manifests: [], findings: [] };
  if (validRepoUrl(repoUrl)) body.repoUrl = repoUrl;
  for (const m of manifests.slice(0, MAX_MANIFESTS)) {
    const npm = packages(m.npm, MAX_PACKAGES);
    const pypi = packages(m.pypi, MAX_PACKAGES - Object.keys(npm).length);
    const actions = packages(m.actions, MAX_PACKAGES - Object.keys(npm).length - Object.keys(pypi).length);
    body.manifests.push({ dir: okString(m.dir, MAX_NAME) ? m.dir : ".", npm, pypi, actions });
  }
  for (const f of findings) {
    if (body.findings.length >= MAX_FINDINGS) break;
    // a check-yourself item was not found in code, so it is not a finding for Watch
    if (f.manual === true) continue;
    if (typeof f.trapId !== "string" || !TRAP_ID.test(f.trapId)) continue;
    body.findings.push({
      trapId: f.trapId,
      file: okString(f.file, MAX_NAME) ? f.file : null,
      line: Number.isInteger(f.line) && f.line >= 0 && f.line <= MAX_LINE ? f.line : null,
    });
  }
  return body;
}

/** POSTs the body. Returns the one line to show; never throws, so a Watch failure cannot change a scan's result. */
export async function sendWatch({ url, key, body, timeoutMs = 15000 }) {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/api/v1/projects`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status === 200) return `Watching ${body.project}.`;
    let msg = "";
    try { msg = (await r.json())?.error; } catch {}
    return typeof msg === "string" && msg ? msg : `Watch failed (${r.status}).`;
  } catch {
    return "Could not send this project to Watch. The scan itself is unaffected.";
  }
}
