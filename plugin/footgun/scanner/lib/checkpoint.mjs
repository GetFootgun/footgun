// `footgun checkpoint`: an undo point of the whole working tree, saved as a git commit under
// refs/worktree/footgun/checkpoints/ (per worktree since git 2.25, so linked worktrees never see each other's points).
// It never touches the working tree or the user's index: `git add -A` runs against a temporary copy of the index
// (GIT_INDEX_FILE), so tracked, staged, unstaged and untracked-but-not-ignored files are all captured, except
// untracked files over 25 MB, which are left out. Nothing is sent; a normal push does not send these refs.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PREFIX = "refs/worktree/footgun/checkpoints/";
const NAME = /^refs\/worktree\/footgun\/checkpoints\/(\d{8}T\d{6}Z)(?:-(\d+))?$/;
// untracked files bigger than this stay out of an undo point (a stray video or dump would bloat the repo)
export const MAX_UNTRACKED_BYTES = 25 * 1024 * 1024;
// commit-tree needs an identity; a repo without user.email must still work
const IDENTITY = { GIT_AUTHOR_NAME: "Footgun", GIT_AUTHOR_EMAIL: "noreply@getfootgun.com", GIT_COMMITTER_NAME: "Footgun", GIT_COMMITTER_EMAIL: "noreply@getfootgun.com" };
// the session-start budget; /footgun:undo passes a longer one
const HOOK = { callMs: 1500, totalMs: 3000 };
const MANUAL = { callMs: 15000, totalMs: 60000 };

// Runs git with argument arrays (no shell). Each call gets at most callMs, and all calls together at most totalMs.
function runner(cwd, { callMs, totalMs }) {
  const end = Date.now() + totalMs;
  const { GIT_INDEX_FILE: _ignored, ...base } = process.env;
  return (args, { env = {}, input = "", raw = false } = {}) => new Promise((done, fail) => {
    const left = Math.min(callMs, end - Date.now());
    if (left <= 0) { fail(new Error("out of time")); return; }
    const child = execFile("git", args, {
      cwd, timeout: left, maxBuffer: 64 << 20,
      env: { ...base, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...IDENTITY, ...env },
    }, (err, stdout) => (err ? fail(err) : done(raw ? stdout : stdout.trim())));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const gitDir = async (run, cwd) => resolve(cwd, await run(["rev-parse", "--git-dir"]));

// refs/worktree/ is per worktree from git 2.25 on
async function gitIsNewEnough(run) {
  const m = /(\d+)\.(\d+)/.exec(await run(["version"]));
  return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 25));
}

// The tree of the working tree as `git add -A` sees it, built in a temporary index seeded from the real one,
// without untracked files over MAX_UNTRACKED_BYTES. Returns { tree, leftOut } (how many were left out).
async function snapshotTree(run, dir) {
  const tmp = mkdtempSync(join(tmpdir(), "footgun-index-"));
  try {
    const index = join(tmp, "index");
    const real = statSync(join(dir, "index"), { throwIfNoEntry: false });
    if (real) {
      copyFileSync(join(dir, "index"), index);
      // git trusts an entry's cached stat only when the file is older than the index file (racy git). A fresh copy
      // is newer than the real index, so a same-second rewrite of the same size would look unchanged. Giving the
      // copy the real index's time (1 ms earlier, never later) keeps git's check exactly as strict.
      utimesSync(index, real.atimeMs / 1000, (real.mtimeMs - 1) / 1000);
    }
    const env = { GIT_INDEX_FILE: index };
    const top = await run(["rev-parse", "--show-toplevel"]);
    // untracked and not ignored, as `add -A` would add them; paths are from the top of the worktree
    const untracked = (await run(["-C", top, "ls-files", "-o", "--exclude-standard", "-z"], { env, raw: true })).split("\0").filter(Boolean);
    const big = untracked.filter((f) => (lstatSync(join(top, f), { throwIfNoEntry: false })?.size ?? 0) > MAX_UNTRACKED_BYTES);
    await run(["add", "-A"], { env });
    // literal pathspecs, so a file name with * or ? never matches other files
    if (big.length) await run(["--literal-pathspecs", "-C", top, "rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...big], { env });
    return { tree: await run(["write-tree"], { env }), leftOut: big.length };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Undo point refs, newest first: by timestamp, then by the -2, -3 suffix.
async function readRefs(run) {
  const out = await run(["for-each-ref", "--format=%(refname) %(objectname) %(tree)", PREFIX]);
  const refs = [];
  for (const line of out.split("\n")) {
    const [ref, commit, tree] = line.split(" ");
    const m = NAME.exec(ref ?? "");
    if (m) refs.push({ ref, commit, tree, stamp: m[1], n: Number(m[2] ?? 1) });
  }
  return refs.sort((a, b) => b.stamp.localeCompare(a.stamp) || b.n - a.n);
}

const stampOf = (now) => now.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
const isoOf = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;

async function prune(run, keep) {
  const old = (await readRefs(run)).slice(keep);
  if (old.length) await run(["update-ref", "--stdin"], { input: old.map((r) => `delete ${r.ref}\n`).join("") });
  return old.length;
}

/**
 * Saves an undo point of the working tree in the git repo at cwd. Returns { ref, commit, created: true, leftOut }, or
 * the newest undo point with created: false when the tree matches it, or null when skipped: not a git repo, git
 * older than 2.25, mid-merge or mid-rebase, any git error, or out of time. Never throws. Keeps the newest 20 per
 * worktree. leftOut counts untracked files over 25 MB that were not saved.
 */
export async function createCheckpoint(cwd, { now = new Date(), callMs = HOOK.callMs, totalMs = HOOK.totalMs } = {}) {
  try {
    const run = runner(cwd, { callMs, totalMs });
    const dir = await gitDir(run, cwd);
    if (!(await gitIsNewEnough(run))) return null;
    if (["MERGE_HEAD", "rebase-merge", "rebase-apply"].some((f) => existsSync(join(dir, f)))) return null;
    const { tree, leftOut } = await snapshotTree(run, dir);
    const refs = await readRefs(run);
    if (refs[0]?.tree === tree) return { ref: refs[0].ref, commit: refs[0].commit, created: false, leftOut };
    const head = await run(["rev-parse", "--verify", "-q", "HEAD^{commit}"]).catch(() => "");
    const commit = await run(["commit-tree", "--no-gpg-sign", tree, ...(head ? ["-p", head] : []), "-m", "Footgun undo point"]);
    const base = PREFIX + stampOf(now);
    const taken = new Set(refs.map((r) => r.ref));
    let ref = null;
    for (let n = 1; !ref; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      if (taken.has(name)) continue;
      // an empty old value means "must not exist yet", so two sessions in the same second never overwrite each other
      try { await run(["update-ref", name, commit, ""]); ref = name; } catch (e) { if (n >= 20) throw e; }
    }
    await prune(run, 20).catch(() => {});
    return { ref, commit, created: true, leftOut };
  } catch {
    return null;
  }
}

/**
 * Undo points of this worktree, newest first: { ref, commit, at, changedFiles }, changedFiles being how many files
 * differ between each and the working tree now. Restore by commit: a fresh undo point may prune the oldest ref.
 */
export async function listCheckpoints(cwd, limits = MANUAL) {
  const run = runner(cwd, limits);
  let dir;
  try { dir = await gitDir(run, cwd); } catch { return []; }
  const refs = await readRefs(run);
  if (!refs.length) return [];
  const { tree: now } = await snapshotTree(run, dir);
  const out = [];
  for (const r of refs) {
    const names = await run(["diff-tree", "-r", "-z", "--name-only", "--no-renames", r.tree, now]);
    out.push({ ref: r.ref, commit: r.commit, at: isoOf(r.stamp), changedFiles: names.split("\0").filter(Boolean).length });
  }
  return out;
}

/**
 * Paths a restore from oldRev would write that exist on disk now but have no saved copy in freshRev (the undo point
 * taken just before restoring): an untracked file that grew past 25 MB, a file that is ignored now, and the like.
 * Restoring over them would lose data with no way back, so /footgun:undo leaves them out unless the user says yes to
 * each one. Paths are from the top of the worktree.
 */
export async function unsafePaths(cwd, oldRev, freshRev, limits = MANUAL) {
  const run = runner(cwd, limits);
  const top = await run(["rev-parse", "--show-toplevel"]);
  const files = async (rev) => (await run(["-C", top, "ls-tree", "-r", "-z", "--name-only", "--full-tree", rev], { raw: true })).split("\0").filter(Boolean);
  const saved = new Set(await files(freshRev));
  const stat = (f) => { try { return lstatSync(join(top, f), { throwIfNoEntry: false }); } catch { return undefined; } };
  const out = new Set();
  for (const f of await files(oldRev)) {
    // git replaces a file that sits where the point has a folder (a is a file now, the point has a/b), deleting it
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const s = stat(dir);
      if (s && !s.isDirectory() && !saved.has(dir)) out.add(dir);
    }
    if (!saved.has(f) && stat(f)) out.add(f);
  }
  return [...out];
}

/** Deletes all but the newest `keep` undo points. Returns how many were deleted. */
export async function pruneCheckpoints(cwd, keep = 20, limits = MANUAL) {
  return prune(runner(cwd, limits), keep);
}

export const MANUAL_LIMITS = MANUAL;

/** The one line the session note carries when an undo point was saved, with the local time. */
export function sessionNote(now, leftOut = 0) {
  const two = (x) => String(x).padStart(2, "0");
  const big = leftOut > 0 ? ` (${leftOut} ${leftOut === 1 ? "file" : "files"} over 25 MB left out)` : "";
  return `Footgun saved an undo point (${two(now.getHours())}:${two(now.getMinutes())}). /footgun:undo restores it.${big}`;
}
