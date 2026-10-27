#!/usr/bin/env node
import { clean } from "../lib/clean.mjs";
import { scrub } from "../lib/scrub.mjs";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { loadPack, NoRulesError, pingCounts, sendPing } from "../lib/pack.mjs";
import { scanProject, readManifests } from "../lib/scan.mjs";
import { buildWatchBody, defaultProjectName, sendWatch, validRepoUrl } from "../lib/watch.mjs";
import { runContext } from "../lib/context.mjs";
import { textReport, jsonReport, failed, FAIL_ON } from "../lib/report.mjs";
import { badgeMarkdown } from "../lib/badge.mjs";
const BASE = process.env.FOOTGUN_URL ?? "https://getfootgun.com";
const KEY = process.env.FOOTGUN_API_KEY;
const [a, ...rest] = process.argv.slice(2);

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
  FOOTGUN_SHARE=false           turn off the anonymous usage count`;

async function main() {
  if (!a || process.argv.slice(2).some((x) => x === "--help" || x === "-h")) { console.log(USAGE); return; }
  // FOOTGUN_CONTEXT_DEADLINE_MS exists for tests. Exiting ends a scan still running past the deadline.
  if (a === "context") {
    const deadlineMs = Number(process.env.FOOTGUN_CONTEXT_DEADLINE_MS) || undefined;
    return runContext(resolve(rest[0] ?? "."), { url: BASE, key: KEY || undefined, deadlineMs }).finally(() => process.exit(0));
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
