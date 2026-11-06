#!/usr/bin/env node
import { clean } from "../lib/clean.mjs";
import { scrub } from "../lib/scrub.mjs";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { loadPack, NoRulesError, pingCounts, sendPing } from "../lib/pack.mjs";
import { scanProject, readManifests } from "../lib/scan.mjs";
import { buildWatchBody, defaultProjectName, sendWatch, validRepoUrl } from "../lib/watch.mjs";
import { runContext } from "../lib/context.mjs";
import { runFailure, searchWith } from "../lib/failure.mjs";
import { hookAnswer } from "../lib/guard.mjs";
import { createCheckpoint, listCheckpoints, MANUAL_LIMITS, sessionNote, unsafePaths } from "../lib/checkpoint.mjs";
import { textReport, jsonReport, failed, FAIL_ON } from "../lib/report.mjs";
import { badgeMarkdown } from "../lib/badge.mjs";
const BASE = process.env.FOOTGUN_URL ?? "https://getfootgun.com";
const KEY = process.env.FOOTGUN_API_KEY;
const [a, ...rest] = process.argv.slice(2);

// stdin up to its end, or whatever arrived within ms
function readStdin(ms) {
  return new Promise((done) => {
    let input = "";
    const timer = setTimeout(() => done(input), ms);
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => { clearTimeout(timer); done(input); });
    process.stdin.on("error", () => { clearTimeout(timer); done(input); });
  });
}

function headers() { return KEY ? { authorization: `Bearer ${KEY}` } : {}; }

function print(traps) {
  if (!traps.length) { console.log("No matching trap yet. If you find the cause, file it: " + BASE); return; }
  for (const t of traps) {
    console.log(`\n${clean(t.id)}  ${clean(t.title)}`);
    console.log(`verified ${clean(t.verifiedOn ?? "never")} · confirmed by ${clean(t.confirmations)} · trust ${clean(t.trust)}/100`);
    console.log(`cause: ${clean(t.cause)}`);
    console.log(`fix:   ${clean(t.fix)}`);
    console.log(`apply:\n${clean(t.apply)}`);
    console.log(clean(t.url));
  }
}

// Exit codes: 0 clean (or below --fail-on), 1 --fail-on met, 2 no rules at all, 3 the scan itself could not run.
class UsageError extends Error {}

function scanArgs(args) {
  const o = { path: ".", json: false, failOn: null, key: KEY || undefined, watch: false, project: null, repoUrl: null };
  let path = null;
  for (let i = 0; i < args.length; i++) {
    const v = args[i];
    if (v === "--json") o.json = true;
    else if (v === "--watch") o.watch = true;
    else if (v === "--fail-on" || v === "--key" || v === "--project" || v === "--repo-url") {
      const val = args[++i];
      if (val === undefined) throw new UsageError(`${v} needs a value`);
      if (v === "--key") o.key = val;
      else if (v === "--project") o.project = val;
      else if (v === "--repo-url") {
        if (!validRepoUrl(val)) throw new UsageError("--repo-url must be an http or https URL of at most 200 characters, with no username, password, query or fragment");
        o.repoUrl = val;
      }
      else if (!Object.hasOwn(FAIL_ON, val)) throw new UsageError("--fail-on must be breaks or will-break");
      else o.failOn = val;
    } else if (v.startsWith("-") || path !== null) throw new UsageError(`unknown argument: ${v}`);
    else path = v;
  }
  if (path !== null) o.path = path;
  return o;
}

// One finding per trap, so a scan counts traps the way the session note does, not file and line hits.
function uniqueTraps(findings) {
  return [...new Map(findings.map((f) => [f.trapId, f])).values()];
}

// Watch sends names, versions and finding locations only. Messages go to stderr with --json so stdout stays JSON.
// Nothing here can change the scan's exit code.
async function watchProject(o, findings) {
  const say = o.json ? console.error : console.log;
  if (!o.key) { say("--watch needs an API key (--key or FOOTGUN_API_KEY) on a Pro or Team plan. Nothing was sent."); return; }
  try {
    const root = resolve(o.path);
    const body = buildWatchBody(o.project || defaultProjectName(root), readManifests(root), findings, o.repoUrl);
    say(clean(await sendWatch({ url: BASE, key: o.key, body })));
  } catch {
    say("Could not send this project to Watch. The scan itself is unaffected.");
  }
}

async function scan(args) {
  let o;
  try {
    o = scanArgs(args);
    if (!statSync(o.path, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`not a directory: ${o.path}`);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(e.message);
    process.exitCode = 3;
    return;
  }
  let loaded;
  try {
    loaded = await loadPack({ url: BASE, key: o.key });
  } catch (e) {
    if (!(e instanceof NoRulesError)) throw e;
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  const { pack, fromCache } = loaded;
  if (fromCache) console.error(`Using cached rules from ${pack.cachedAt.slice(0, 10)} (offline).`);
  // a matcher that cannot start rejects here and exits 3 in main, so no clean report is printed
  const result = await scanProject(resolve(o.path), pack.rules);
  const skippedRules = [...pack.skippedRules, ...result.skippedRules];
  const badge = badgeMarkdown(result.findings, { base: BASE, date: new Date().toISOString().slice(0, 10) });
  if (o.json) {
    console.log(jsonReport({ findings: result.findings, skippedRules, fromCache, version: pack.version, badge }));
  } else {
    for (const s of skippedRules) console.error(clean(`Skipped rule ${s.id}: ${s.why}`));
    console.log(textReport(result.findings));
    console.log(`\nREADME badge for this scan:\n${badge}`);
  }
  if (failed(result.findings, o.failOn)) process.exitCode = 1;
  if (o.watch) await watchProject(o, result.findings);
  // launch reminders only say a package is in use, so they are not counted as matched traps
  await sendPing({ url: BASE, kind: "scan", counts: pingCounts(uniqueTraps(result.findings.filter((f) => !(f.manual && f.launch)))) });
}

const USAGE = `usage:
  npx @getfootgun/footgun "<error text>"
  npx @getfootgun/footgun lookup <provider> [context]
  npx @getfootgun/footgun scan [path] [--json] [--fail-on breaks|will-break] [--key <key>] [--watch [--project <name>]]
  npx @getfootgun/footgun context [path]
  npx @getfootgun/footgun failure < hook-event.json
  npx @getfootgun/footgun guard < hook-event.json
  npx @getfootgun/footgun checkpoint [path] [--session-start < hook-event.json]
  npx @getfootgun/footgun checkpoints [path] --json
  npx @getfootgun/footgun checkpoints [path] --unsafe <old commit> <fresh commit>

scan flags:
  --json                        print machine-readable output
  --fail-on breaks|will-break   exit 1 when a finding of that kind is found
  --key <key>                   search and scan with your private namespaces too
  --watch                       send this project's package versions and finding locations (never code)
                                to Footgun Watch; needs a Pro or Team key
  --project <name>              Watch project name (default: package.json or pyproject name, then folder)
  --repo-url <url>              repository link to store with the Watch project

environment:
  FOOTGUN_API_KEY               same as --key
  FOOTGUN_URL                   point at another server
  FOOTGUN_SHARE=false           turn off the anonymous usage count
  FOOTGUN_AUTO_SEARCH=false     failure: guard retry loops only, send nothing`;

async function main() {
  if (!a || process.argv.slice(2).some((x) => x === "--help" || x === "-h")) { console.log(USAGE); return; }
  // FOOTGUN_CONTEXT_DEADLINE_MS exists for tests. Exiting ends a scan still running past the deadline.
  // FOOTGUN_SESSION_NOTE is the undo point line from session-start.sh, put first in the note.
  if (a === "context") {
    const deadlineMs = Number(process.env.FOOTGUN_CONTEXT_DEADLINE_MS) || undefined;
    return runContext(resolve(rest[0] ?? "."), { url: BASE, key: KEY || undefined, deadlineMs, note: process.env.FOOTGUN_SESSION_NOTE }).finally(() => process.exit(0));
  }
  // failure reads one Claude Code PostToolUseFailure event on stdin and is as quiet as context
  if (a === "failure") {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const autoSearch = process.env.FOOTGUN_AUTO_SEARCH !== "false";
    return runFailure(input, { search: searchWith({ url: BASE, key: KEY || undefined }), autoSearch }).finally(() => process.exit(0));
  }
  // guard reads one Claude Code PreToolUse event on stdin, prints a pause answer or nothing, and always exits 0
  if (a === "guard") {
    try {
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const out = hookAnswer(JSON.parse(input));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch {}
    process.exit(0);
  }
  // checkpoint saves an undo point of the working tree under refs/worktree/footgun/checkpoints and prints the result as JSON.
  // With --session-start it reads one SessionStart event on stdin, acts only when its source is "startup", prints
  // the session note line or nothing, and always exits 0 within the hook budget.
  if (a === "checkpoint") {
    const path = resolve(rest.find((x) => !x.startsWith("-")) ?? ".");
    if (!rest.includes("--session-start")) { console.log(JSON.stringify(await createCheckpoint(path, MANUAL_LIMITS))); return; }
    let out = "";
    try {
      const event = JSON.parse(await readStdin(1000));
      const now = new Date();
      if (event?.source === "startup") {
        const made = await createCheckpoint(path, { now });
        if (made?.created) out = sessionNote(now, made.leftOut) + "\n";
      }
    } catch {}
    process.stdout.write(out, () => process.exit(0));
    return;
  }
  // checkpoints lists the undo points, newest first, as JSON: [{ ref, commit, at, changedFiles }].
  // It never crashes: a git error or timeout prints {"error":"could not read undo points"} and exits 0.
  // With --unsafe <old> <fresh> it prints the paths a restore from old would overwrite with no saved copy in fresh,
  // as a JSON list, or {"error":"could not check the undo point"}.
  if (a === "checkpoints" && rest.includes("--unsafe")) {
    const i = rest.indexOf("--unsafe");
    const [oldRev, freshRev] = rest.slice(i + 1, i + 3);
    const path = rest.filter((x, j) => j < i || j > i + 2).find((x) => !x.startsWith("-")) ?? ".";
    let out;
    try {
      // commit ids only, so nothing here can be read as a git option
      if (![oldRev, freshRev].every((r) => /^[0-9a-f]{7,64}$/.test(r ?? ""))) throw new Error("bad commit");
      out = await unsafePaths(resolve(path), oldRev, freshRev);
    } catch { out = { error: "could not check the undo point" }; }
    console.log(JSON.stringify(out));
    return;
  }
  if (a === "checkpoints") {
    let list;
    try { list = await listCheckpoints(resolve(rest.find((x) => !x.startsWith("-")) ?? ".")); } catch { list = { error: "could not read undo points" }; }
    console.log(JSON.stringify(list));
    return;
  }
  if (a === "scan") return scan(rest).catch((e) => { console.error(clean(e.message)); process.exitCode = 3; });
  // error text goes in a POST body, scrubbed of secrets first, so it never lands in a URL or a log
  const r = a === "lookup"
    ? await fetch(`${BASE}/api/v1/lookup?provider=${encodeURIComponent(rest[0] ?? "")}&context=${encodeURIComponent(scrub(rest.slice(1).join(" ")))}`, { headers: headers() })
    : await fetch(`${BASE}/api/v1/search`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ q: scrub([a, ...rest].join(" ")) }) });
  let body;
  try { body = await r.json(); } catch { console.error(clean(`${r.status} ${r.statusText}`)); process.exit(1); }
  if (!r.ok) { console.error(clean(body.error ?? r.statusText)); process.exit(1); }
  print(body.traps);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
