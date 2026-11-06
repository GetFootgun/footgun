// `footgun guard`: the Claude Code PreToolUse hook (the safety net). Before a shell command runs, it checks the command
// against a short list of destructive patterns and asks the user first. In bypassPermissions and dontAsk modes,
// where "ask" is not documented to prompt, it denies and tells Claude how to rerun after the user says yes.
// This is a net, not a lock: it stops accidents, not an agent set on getting around it. It reads nothing but the
// event (and .git/HEAD and .git/refs/remotes for git rules), sends nothing, and any internal error lets the command through.
import { readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

const SHELLS = new Set(["Bash", "PowerShell"]);
const CONFIRMED = "FOOTGUN_CONFIRMED=1 ";
// PowerShell sets the variable in its own statement: $env:FOOTGUN_CONFIRMED=1; <command>
const PS_CONFIRMED = /^\$env:FOOTGUN_CONFIRMED\s*=\s*(?:1|'1'|"1")$/i;
const DENY_MODES = new Set(["bypassPermissions", "dontAsk"]);
const DENY_TAIL = "Explain the risk to the user. Only if they say yes, rerun it with FOOTGUN_CONFIRMED=1 directly before the risky command.";
const PS_DENY_TAIL = "Explain the risk to the user. Only if they say yes, rerun with $env:FOOTGUN_CONFIRMED=1; right before the risky command.";
// Longer commands are let through unchecked, so a huge command cannot slow the session.
const MAX_LEN = 100_000;
const MAX_DEPTH = 3;
// Only the first parts of a long chain are checked, and a cd path longer than this stops being followed.
const MAX_PARTS = 200;
const MAX_PATH = 4096;
// Programs whose quoted arguments are text, not SQL to run.
const TEXT_PROGRAMS = new Set(["echo", "printf", "grep", "egrep", "rg", "ag", "git", "gh", "sed"]);
const WRAPPERS = new Set(["sudo", "doas", "command", "exec", "nohup", "time", "env"]);
const SHELL_PROGRAMS = new Set(["bash", "sh", "zsh", "dash"]);
// Temp folders outside the project may be cleared, but only below them.
const TEMP_ROOTS = [...new Set([resolve(tmpdir()), "/tmp", "/private/tmp", "/var/tmp"])];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const SQL_RULES = [
  [/(?<![\w-])drop\s+table\b/i, "this deletes a database table", "Every row in it would be lost"],
  [/(?<![\w-])drop\s+schema\b/i, "this deletes a whole database schema", "Every table in it would be lost"],
  [/(?<![\w-])drop\s+database\b/i, "this deletes a whole database", "All of its data would be lost"],
  [/(?<![\w-])truncate\s+(?:table\s+)?["'`\w]/i, "this empties a database table", "Every row in it would be lost"],
  [/(?<![\w-])alter\s+role\b/i, "this changes a database user's login or role", "Apps that use it could stop working"],
  [/(?<![\w-])drop\s+owned\b/i, "this deletes everything a database user owns", "Those tables would be lost"],
];
const DELETE_ALL = ["this deletes every row in a table, with no WHERE", "All of those rows would be lost"];

// [pattern on the segment's words, flag word that must also be present (or null), reason, loss, is a database command].
// Flags are checked as whole words, not with .* in the pattern, so a long command stays linear.
const CLI_RULES = [
  [/(?<![\w-])prisma\s+migrate\s+reset\b/, null, "this wipes the database and reruns every migration", "All data would be lost", true],
  [/(?<![\w-])prisma\s+db\s+push\b/, "--force-reset", "this wipes the database before pushing the schema", "All data would be lost", true],
  [/(?<![\w-])prisma\s+db\s+push\b/, "--accept-data-loss", "this pushes a change that drops columns or tables", "Their data would be lost", true],
  [/(?<![\w-])drizzle-kit\s+drop\b/, null, "this deletes a migration file", "Its SQL and snapshot would be gone", false],
  [/(?<![\w-])supabase\s+db\s+reset\b/, "--linked", "this wipes your linked remote Supabase database", "All data would be lost", true],
  [/(?<![\w-])supabase\s+db\s+reset\b/, null, "this wipes the local Supabase database", "All local data would be lost", true],
  [/(?:^|[\s/])(?:rails|rake)\s+db:drop\b/, null, "this deletes the app's database", "All data would be lost", true],
  [/(?:^|[\s/])(?:rails|rake)\s+db:reset\b/, null, "this drops and recreates the app's database", "All data would be lost", true],
  [/(?:^|[\s/])dropdb(?:\s|$)/, null, "this deletes a whole Postgres database", "All of its data would be lost", true],
  [/(?<![\w-])terraform\s+destroy\b/, null, "this destroys every resource this Terraform setup manages", "Servers and data would be gone", false],
  [/(?<![\w-])terraform\s+apply\b/, "-destroy", "this destroys every resource this Terraform setup manages", "Servers and data would be gone", false],
  [/(?<![\w-])pulumi\s+(?:destroy|down)\b/, null, "this destroys every resource in this Pulumi stack", "Servers and data would be gone", false],
  [/(?<![\w-])vercel\s+(?:remove|rm)\b/, null, "this deletes a Vercel deployment or project", "The live site could go offline", false],
  [/(?<![\w-])vercel\s+env\s+(?:rm|remove)\b/, null, "this deletes an environment variable from Vercel", "Deploys that need it could break", false],
  [/(?<![\w-])railway\s+down\b/, null, "this removes the latest Railway deployment", "The service would stop running", false],
  [/(?<![\w-])(?:fly|flyctl)\s+apps\s+(?:destroy|delete|remove)\b/, null, "this deletes a Fly app", "Its machines and volumes would be gone", false],
  [/(?<![\w-])heroku\s+apps:destroy\b/, null, "this deletes a Heroku app", "Its add-ons and data would be gone", false],
];

const RM_LOSS = "Files deleted this way skip the trash";
const GIT = {
  reset: ["this throws away all uncommitted changes", "Unsaved edits would be lost"],
  clean: ["this deletes untracked files and folders", "Files never committed would be gone"],
  push: ["this overwrites the main branch on the remote", "Commits others pushed could be lost"],
  checkout: ["this throws away every uncommitted change here", "Unsaved edits would be lost"],
  branch: ["this deletes a branch even if it was never merged", "Its commits could be lost"],
};

/** Splits on unquoted &&, ||, ;, |, & and newlines. Quotes stay in the parts. */
function segments(command) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "\\" && i + 1 < command.length) { cur += c + command[++i]; continue; }
    // 2>&1 and &> are redirections, not separators
    if (c === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) { cur += c; continue; }
    if (c === "\n" || c === ";" || c === "&" || c === "|") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(tidy).filter(Boolean);
}

// trims and drops leading ( { and trailing ) }, in linear time
function tidy(s) {
  let a = 0;
  let b = s.length;
  const space = (c) => c === " " || c === "\t" || c === "\r" || c === "\n";
  while (a < b && (space(s[a]) || s[a] === "(" || s[a] === "{")) a++;
  while (b > a && (space(s[b - 1]) || s[b - 1] === ")" || s[b - 1] === "}")) b--;
  return s.slice(a, b);
}

/** Shell words with quotes removed. */
function words(segment) {
  const out = [];
  let cur = "";
  let has = false;
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === "\\" && i + 1 < segment.length) { cur += segment[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ""; has = false; continue; }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

/** Drops leading VAR=value words and wrappers like sudo and env, so words[0] is the real program. */
function program(ws) {
  let i = 0;
  while (i < ws.length) {
    if (isAssignment(ws[i])) { i++; continue; }
    if (WRAPPERS.has(ws[i])) { i++; while (i < ws.length && ws[i].startsWith("-")) i++; continue; }
    break;
  }
  return ws.slice(i);
}

/** Drops redirections (2>/dev/null, > file, 2>&1) from a word list. */
function withoutRedirects(ws) {
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    if (/^(?:\d*|&)[<>]{1,2}&?$/.test(ws[i])) { i++; continue; }
    if (/^(?:\d*|&)[<>]/.test(ws[i])) continue;
    out.push(ws[i]);
  }
  return out;
}

const stripQuoted = (s) => s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " ");

function production(segment) {
  if (/(?:^|\s)(?:NODE_ENV|RAILS_ENV)=["']?production\b/.test(segment)) return true;
  if (/(?:^|\s)--prod(?:uction)?(?:[\s=]|$)/.test(segment)) return true;
  const re = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|sqlserver|cockroachdb):\/\/(?:[^@\s/'"]*@)?(\[[^\]]*\]|[^:/\s?'"]+)/gi;
  for (const m of segment.matchAll(re)) if (!LOCAL_HOSTS.has(m[1].toLowerCase())) return true;
  return false;
}

// each match runs to the end of its statement, so the scan stays linear
function deleteWithoutWhere(text) {
  const re = /(?<![\w-])delete\s+from\s+["'`\w.]+([^;]*)/gi;
  for (const m of text.matchAll(re)) if (!/\bwhere\b/i.test(m[1])) return true;
  return false;
}

function inside(path, dir) {
  return path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

const VARIABLE = ["this deletes a folder named by a variable", "If the variable is empty it could delete far more than intended"];

function rmTarget(arg, cwd, root, home) {
  if (/^\$(?:[A-Za-z_]|\{)/.test(arg) && !/^\$(?:HOME|\{HOME\})(?=\/|$)/.test(arg)) return VARIABLE;
  let p = arg.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  // a bare * or .* means everything in its folder
  const parts = p.split("/");
  if (parts.length && (parts[parts.length - 1] === "*" || parts[parts.length - 1] === ".*")) { parts.pop(); p = parts.join("/") || (isAbsolute(p) ? "/" : "."); }
  const full = resolve(cwd, p);
  if (full === resolve("/")) return ["this deletes your whole computer's files", RM_LOSS];
  if (full === home) return ["this deletes your home folder", RM_LOSS];
  if (full === root) return ["this deletes this whole project folder", RM_LOSS];
  // anything below the project root is allowed (node_modules, dist, build and the rest included)
  if (inside(full, root)) return null;
  // a temp folder counts only below it, and never when the target holds the project
  if (!inside(root, full) && TEMP_ROOTS.some((t) => inside(full, t))) return null;
  return ["this deletes a folder outside this project", RM_LOSS];
}

function checkRm(args, cwd, root) {
  const flags = new Set();
  const targets = [];
  let opts = true;
  for (const a of args) {
    if (opts && a === "--") { opts = false; continue; }
    if (opts && a.startsWith("--")) { if (a === "--recursive") flags.add("r"); continue; }
    if (opts && a.startsWith("-") && a.length > 1) { for (const f of a.slice(1)) flags.add(f.toLowerCase()); continue; }
    targets.push(a);
  }
  if (!flags.has("r")) return null;
  const home = resolve(homedir());
  for (const t of targets) {
    const hit = rmTarget(t, cwd, root, home);
    if (hit) return { reason: hit[0], loss: hit[1] };
  }
  return null;
}

function currentBranch(cwd) {
  try {
    const head = readFileSync(join(cwd, ".git", "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice(16) : null;
  } catch {
    return null;
  }
}

// origin/main, refs/remotes/origin/main, or <name>/<branch> where .git/refs/remotes/<name> exists
function remoteRef(ref, cwd) {
  if (ref.startsWith("refs/remotes/")) return true;
  const m = /^([^/\s]+)\/\S+$/.exec(ref);
  if (!m) return false;
  if (m[1] === "origin" || m[1] === "upstream") return true;
  try { return statSync(join(cwd, ".git", "refs", "remotes", m[1])).isDirectory(); } catch { return false; }
}

function checkGit(args, cwd) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  const shorts = new Set(rest.filter((a) => /^-[a-zA-Z]+$/.test(a)).flatMap((a) => [...a.slice(1)]));
  const result = ([reason, loss]) => ({ reason, loss });
  if (sub === "reset" && rest.includes("--hard")) {
    const refs = rest.filter((a) => !a.startsWith("-"));
    // resetting to a remote-tracking ref is the usual "match the remote" step
    if (refs.length === 1 && remoteRef(refs[0], cwd)) return null;
    return result(GIT.reset);
  }
  if (sub === "clean" && (shorts.has("f") || rest.includes("--force")) && (shorts.has("d") || shorts.has("x") || shorts.has("X"))
    && !shorts.has("n") && !rest.includes("--dry-run")) return result(GIT.clean);
  if (sub === "push") {
    const force = shorts.has("f") || rest.some((a) => a === "--force" || a.startsWith("--force-with-lease"));
    const refs = rest.filter((a) => !a.startsWith("-"));
    const main = (r) => /^\+?(?:[^:]*:)?(?:refs\/heads\/)?(?:main|master)$/.test(r);
    if (refs.some((r) => r.startsWith("+") && main(r))) return result(GIT.push);
    if (force && refs.slice(1).some(main)) return result(GIT.push);
    if (force && refs.length <= 1 && ["main", "master"].includes(currentBranch(cwd))) return result(GIT.push);
  }
  if (sub === "checkout") {
    const dash = rest.indexOf("--");
    const paths = dash >= 0 ? rest.slice(dash + 1) : rest;
    if (paths.some((p) => p === "." || p === "./" || p === "*")) return result(GIT.checkout);
  }
  if (sub === "restore") {
    const dash = rest.indexOf("--");
    const paths = dash >= 0 ? rest.slice(dash + 1) : rest.filter((a) => !a.startsWith("-"));
    const staged = rest.includes("--staged") || shorts.has("S");
    const worktree = rest.includes("--worktree") || shorts.has("W");
    if ((!staged || worktree) && paths.some((p) => p === "." || p === "./" || p === "*")) return result(GIT.checkout);
  }
  if (sub === "branch" && (shorts.has("D") || (rest.includes("--delete") && rest.includes("--force")))) return result(GIT.branch);
  return null;
}

function checkSegment(segment, state, depth) {
  const ws = withoutRedirects(program(words(segment)));
  if (!ws.length) return null;
  const prog = basename(ws[0]);
  const args = ws.slice(1);

  if (prog === "cd") {
    const next = resolve(state.cwd, (args[0] ?? homedir()).replace(/^~(?=\/|$)/, homedir()));
    if (next.length <= MAX_PATH) state.cwd = next;
    return null;
  }
  if (SHELL_PROGRAMS.has(prog) && args[0] === "-c" && typeof args[1] === "string" && depth < MAX_DEPTH) {
    return check(args[1], { cwd: state.cwd, root: state.root, powershell: false }, depth + 1);
  }
  if (prog === "rm") return checkRm(args, state.cwd, state.root);
  if (prog === "git") return checkGit(args, state.cwd);

  const text = ws.join(" ");
  for (const [re, flag, reason, loss, db] of CLI_RULES) {
    if (re.test(text) && (!flag || args.includes(flag))) return db && production(segment) ? prod(reason) : { reason, loss };
  }

  if (prog === "truncate") return null;
  const sql = TEXT_PROGRAMS.has(prog) ? stripQuoted(segment) : segment;
  for (const [re, reason, loss] of SQL_RULES) {
    if (re.test(sql)) return production(segment) ? prod(reason) : { reason, loss };
  }
  if (deleteWithoutWhere(sql)) return production(segment) ? prod(DELETE_ALL[0]) : { reason: DELETE_ALL[0], loss: DELETE_ALL[1] };
  return null;
}

const prod = (reason) => ({ reason: `${reason}, in production`, loss: "Live data would be lost" });

// A part that starts with FOOTGUN_CONFIRMED=1 is skipped; in PowerShell, so is the part after $env:FOOTGUN_CONFIRMED=1.
function check(command, state, depth) {
  const parts = segments(command).slice(0, MAX_PARTS);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(CONFIRMED)) continue;
    if (state.powershell && PS_CONFIRMED.test(parts[i])) { i++; continue; }
    const hit = checkSegment(parts[i], state, depth);
    if (hit) return hit;
  }
  return null;
}

/** { reason, loss } for a destructive command, else null. cwd is the project root. */
export function checkCommand(command, cwd, { powershell = false } = {}) {
  if (typeof command !== "string" || command.length > MAX_LEN) return null;
  const root = resolve(cwd);
  return check(command, { cwd: root, root, powershell }, 0);
}

/** The PreToolUse hook answer for one event, or null for no output (let the command run). */
export function hookAnswer(input) {
  try {
    if (!input || typeof input !== "object") return null;
    if (input.tool_name !== undefined && !SHELLS.has(input.tool_name)) return null;
    const command = input.tool_input?.command;
    if (typeof command !== "string") return null;
    const powershell = input.tool_name === "PowerShell";
    const hit = checkCommand(command, typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd(), { powershell });
    if (!hit) return null;
    const ask = `Footgun: ${hit.reason}. ${hit.loss}.`;
    if (!DENY_MODES.has(input.permission_mode)) return answer("ask", ask);
    // the deny reason keeps the loss when it fits in 200 characters
    const tail = powershell ? PS_DENY_TAIL : DENY_TAIL;
    const full = `${ask} ${tail}`;
    return answer("deny", full.length < 200 ? full : `Footgun: ${hit.reason}. ${tail}`);
  } catch {
    return null;
  }
}

const answer = (permissionDecision, permissionDecisionReason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason },
});
