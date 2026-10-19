// Pulls the public trap data from getfootgun.com and rewrites data/ to match it. Run by
// .github/workflows/sync-data.yml. It checks the whole payload before writing anything, and it only ever
// writes data/providers.json and data/traps/<provider>/<slug>.json.
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SOURCE = process.env.MIRROR_URL ?? "https://getfootgun.com/api/v1/mirror";
const DATA = "data";
const TRAP_PATH = /^traps\/([a-z0-9-]+)\/[a-z0-9-]+\.json$/;
const MAX_DROP = 0.2; // a sync may remove at most this share of the traps already here
const MAX_BYTES = 30_000_000;

function fail(message) {
  console.error(`sync-data: ${message}`);
  process.exit(1);
}

function currentTraps() {
  const root = join(DATA, "traps");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(root, d.name)).filter((f) => f.endsWith(".json")).map((f) => `traps/${d.name}/${f}`));
}

const res = await fetch(SOURCE, { headers: { "user-agent": "footgun-mirror-sync" }, signal: AbortSignal.timeout(60_000) }).catch((e) => fail(`fetch failed: ${e.message}`));
if (!res.ok) fail(`${SOURCE} answered HTTP ${res.status}`);
const raw = await res.text();
if (raw.length > MAX_BYTES) fail("payload is too large");
let body;
try { body = JSON.parse(raw); } catch { fail("payload is not JSON"); }
const files = body?.files;
if (!files || typeof files !== "object") fail("payload has no files");

// Check everything first.
if (typeof files["providers.json"] !== "string") fail("payload has no providers.json");
let providers;
try { providers = new Set(JSON.parse(files["providers.json"]).map((p) => p.slug)); } catch { fail("providers.json is not a list of providers"); }
const trapPaths = [];
for (const [path, content] of Object.entries(files)) {
  if (path === "providers.json") continue;
  const m = path.match(TRAP_PATH);
  if (!m) fail(`refusing path ${JSON.stringify(path)}`);
  if (typeof content !== "string") fail(`${path} is not text`);
  let record;
  try { record = JSON.parse(content); } catch { fail(`${path} is not JSON`); }
  if (record.provider !== m[1]) fail(`${path} is filed under ${m[1]} but its provider is ${record.provider}`);
  if (!providers.has(m[1])) fail(`${path} names a provider missing from providers.json`);
  trapPaths.push(path);
}
if (body.count !== trapPaths.length) fail(`payload says ${body.count} traps but holds ${trapPaths.length}`);
const before = currentTraps();
const keep = new Set(trapPaths);
const dropped = before.filter((p) => !keep.has(p));
if (before.length && dropped.length > before.length * MAX_DROP) {
  fail(`refusing to remove ${dropped.length} of ${before.length} traps in one sync; check the site before syncing`);
}

// Then write.
for (const [path, content] of Object.entries(files)) {
  const file = join(DATA, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
for (const path of dropped) unlinkSync(join(DATA, path));
for (const d of readdirSync(join(DATA, "traps"), { withFileTypes: true })) {
  const dir = join(DATA, "traps", d.name);
  if (d.isDirectory() && readdirSync(dir).length === 0) rmdirSync(dir);
}

console.log(`sync-data: ${trapPaths.length} traps, ${dropped.length} removed`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `traps=${trapPaths.length}\nremoved=${dropped.length}\n`);
