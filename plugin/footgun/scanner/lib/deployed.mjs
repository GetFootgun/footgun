// `footgun deployed`: the Claude Code PostToolUse hook that notices a production deploy. After a shell command succeeds,
// it checks whether the command was a production deploy (Vercel or Railway, directly or by pushing main) and, if so,
// tells Claude to call keys_deploy_check. It reads only the event and, for a git push, a few local files in the project
// (.vercel/project.json, railway.json, railway.toml, .git/HEAD). It never touches the network, and any error prints nothing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHELLS = new Set(["Bash", "PowerShell"]);
const MAX_LEN = 100_000;
const MAX_PARTS = 200;
const WRAPPERS = new Set(["sudo", "doas", "command", "exec", "nohup", "time", "env"]);
const MAIN = new Set(["main", "master"]);

const realFs = {
  exists: (p) => { try { return existsSync(p); } catch { return false; } },
  read: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
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
  return out.map((s) => s.trim()).filter(Boolean);
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

/** Drops leading VAR=value words and wrappers like sudo and env, so ws[0] is the real program. */
function program(ws) {
  let i = 0;
  while (i < ws.length) {
    if (isAssignment(ws[i])) { i++; continue; }
    if (WRAPPERS.has(ws[i])) { i++; while (i < ws.length && ws[i].startsWith("-")) i++; continue; }
    break;
  }
  return ws.slice(i);
}

/** Drops npx, bunx, pnpx, pnpm dlx, yarn dlx and npm exec (and their flags), so ws[0] is the tool they run. */
function unrun(ws) {
  let i = 0;
  const runner = ws[0];
  if (runner === "npx" || runner === "bunx" || runner === "pnpx") i = 1;
  else if ((runner === "pnpm" || runner === "yarn") && ws[1] === "dlx") i = 2;
  else if (runner === "npm" && ws[1] === "exec") i = 2;
  else return ws;
  while (i < ws.length && ws[i].startsWith("-")) i++;
  return ws.slice(i);
}

const isVercelProd = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--prod" || a === "--prod=true" || a === "--target=production") return true;
    if (a === "--target" && args[i + 1] === "production") return true;
  }
  return false;
};

/** The first argument that is not a flag (skipping the value of --target), or undefined. */
function firstPositional(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target") { i++; continue; }
    if (!args[i].startsWith("-")) return args[i];
  }
  return undefined;
}

// returns true when this git push targets main or master (explicitly, or via the current branch)
function pushesMain(args, cwd, fs) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  if (args[i] !== "push") return false;
  const pos = args.slice(i + 1).filter((a) => !a.startsWith("-"));
  const refs = pos.slice(1);
  if (refs.length > 0) return refs.some((r) => MAIN.has(r.split(":").pop().replace(/^refs\/heads\//, "")));
  const head = fs.read(join(cwd, ".git", "HEAD"));
  const m = head && /^ref:\s*refs\/heads\/(\S+)/.exec(head.trim());
  return !!m && MAIN.has(m[1]);
}

function linkedHost(cwd, fs) {
  if (fs.exists(join(cwd, ".vercel", "project.json"))) return "vercel";
  if (fs.exists(join(cwd, "railway.json")) || fs.exists(join(cwd, "railway.toml"))) return "railway";
  return null;
}

/** "vercel" or "railway" when the command is a production deploy, otherwise null. */
export function isProdDeploy(command, cwd, fs = realFs) {
  try {
    if (typeof command !== "string" || !command || command.length > MAX_LEN) return null;
    for (const seg of segments(command).slice(0, MAX_PARTS)) {
      const ws = unrun(program(words(seg)));
      const tool = ws[0];
      const args = ws.slice(1);
      if (tool === "vercel") {
        const sub = firstPositional(args);
        const deploys = sub === undefined || sub === "deploy" || sub === "--" || /^[./~]/.test(sub);
        if (deploys && isVercelProd(args)) return "vercel";
      } else if (tool === "railway") {
        if (firstPositional(args) === "up") return "railway";
      } else if (tool === "git") {
        if (pushesMain(args, cwd, fs)) {
          const host = linkedHost(cwd, fs);
          if (host) return host;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** The PostToolUse answer to print for this event, or null to print nothing. */
export function deployHookAnswer(input, fs = realFs) {
  try {
    if (!input || typeof input !== "object") return null;
    if (!SHELLS.has(input.tool_name)) return null;
    const command = input.tool_input?.command;
    if (typeof command !== "string") return null;
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    if (!isProdDeploy(command, cwd, fs)) return null;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `Footgun: a production deploy just started. Call keys_deploy_check with project_path "${cwd}" to check the live app once it is ready.`,
      },
    });
  } catch {
    return null;
  }
}
