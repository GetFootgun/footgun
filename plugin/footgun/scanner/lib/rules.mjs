// Shared trap-rule matcher. Dependency-free; used by the scanner and the rule gate.
// Rules must stay RE2-compatible: no backreferences, no lookarounds, no nested quantifiers.

const MAX_PATTERN = 300;
const MAX_LINE = 2000;
const MAX_GLOB = 200;
const MAX_GLOB_STARS = 6;

function scanPattern(src) {
  const problems = [];
  const groups = []; // each entry: { quant: has an unbounded/ranged quantifier inside, alt: has a top-level | }
  const rangeAt = (i) => /^\{\d+,\d*\}/.exec(src.slice(i));
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      if (!inClass && n && ((n >= "1" && n <= "9") || (n === "k" && src[i + 2] === "<"))) {
        problems.push("backreferences are not allowed");
      }
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") {
      if (src[i + 1] === "?" && (src[i + 2] === "=" || src[i + 2] === "!" ||
          (src[i + 2] === "<" && (src[i + 3] === "=" || src[i + 3] === "!")))) {
        problems.push("lookarounds are not allowed");
      }
      groups.push({ quant: false, alt: false });
      continue;
    }
    if (c === "*" || c === "+") {
      if (groups.length) groups[groups.length - 1].quant = true;
      continue;
    }
    if (c === "{") {
      const m = rangeAt(i);
      if (m) {
        if (groups.length) groups[groups.length - 1].quant = true;
        i += m[0].length - 1;
      }
      continue;
    }
    if (c === "|") {
      if (groups.length) groups[groups.length - 1].alt = true;
      continue;
    }
    if (c === ")") {
      const g = groups.pop();
      const next = src[i + 1];
      const quantified = next === "*" || next === "+" || (next === "{" && rangeAt(i + 1));
      if (g && quantified && g.quant) problems.push("nested quantifiers are not allowed");
      if (g && quantified && g.alt) problems.push("quantified alternation is not allowed");
      if (g && groups.length) {
        if (g.quant) groups[groups.length - 1].quant = true;
        if (g.alt) groups[groups.length - 1].alt = true;
      }
    }
  }
  return [...new Set(problems)];
}

export function ruleProblems(rule) {
  const problems = [];
  if (!rule || typeof rule !== "object") return ["rule must be an object"];
  if (!Array.isArray(rule.files) || rule.files.length === 0 || !rule.files.every((f) => typeof f === "string" && f)) {
    problems.push("files must be a non-empty list of globs");
  } else if (rule.files.some((g) => g.length > MAX_GLOB || g.split("*").length - 1 > MAX_GLOB_STARS)) {
    // glob matching runs outside the matcher's time cap, so its size is capped here
    problems.push(`files: a glob is longer than ${MAX_GLOB} characters or has more than ${MAX_GLOB_STARS} *`);
  }
  for (const key of ["pattern", "unless"]) {
    const src = rule[key];
    if (key === "unless" && src === undefined) continue;
    if (typeof src !== "string" || src === "") {
      problems.push(`${key} must be a non-empty string`);
      continue;
    }
    if (src.length > MAX_PATTERN) problems.push(`${key} is longer than ${MAX_PATTERN} characters`);
    problems.push(...scanPattern(src).map((p) => `${key}: ${p}`));
    try { new RegExp(src, "m"); } catch { problems.push(`${key} does not compile`); }
  }
  return problems;
}

const globCache = new Map();

function globToRegExp(glob) {
  glob = glob.replace(/(?:\*\*\/)+/g, "**/"); // **/**/ matches what **/ matches
  let out = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i++; }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") { out += "(?:"; braces++; }
    else if (c === "}" && braces) { out += ")"; braces--; }
    else if (c === "," && braces) out += "|";
    else out += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  while (braces--) out += ")";
  return new RegExp(`^${out}$`);
}

export function globMatch(glob, relPath) {
  let re = globCache.get(glob);
  if (!re) { re = globToRegExp(glob); globCache.set(glob, re); }
  return re.test(relPath);
}

const verdicts = new WeakMap();

function isSafe(rule) {
  if (!rule || typeof rule !== "object") return false;
  let v = verdicts.get(rule);
  if (v === undefined) {
    try { v = ruleProblems(rule).length === 0; } catch { v = false; }
    verdicts.set(rule, v);
  }
  return v;
}

// A line whose trimmed start is a comment marker is not matched (`#!` shebangs fall under `#`).
// Block comments are not parsed: only lines starting with `/*` or `*` are skipped.
const COMMENT_START = /^(?:\/\/|#|\/\*|\*|<!--|--)/;
// A rule whose pattern itself targets comment syntax (contains `<!--`, or starts with a comment marker) is not subject to the skip.
// For ordinary rules, `#[attr]`, `#include` and Markdown `*` bullets are skipped like any other comment-looking line.
const COMMENT_RULE = /<!--|^\^?(?:\\s\*|\(\?:|\()*(?:--|#|\/\/|\/\\\*|\\\*)/;

export function matchRule(rule, relPath, text) {
  if (!isSafe(rule)) return [];
  if (!rule.files.some((g) => globMatch(g, relPath))) return [];
  let re, unless;
  try {
    re = new RegExp(rule.pattern, "m");
    unless = rule.unless ? new RegExp(rule.unless, "m") : null;
  } catch {
    return [];
  }
  if (unless && unless.test(text)) return [];
  const skipComments = !COMMENT_RULE.test(rule.pattern);
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > MAX_LINE) continue;
    if (skipComments && COMMENT_START.test(lines[i].trimStart())) continue;
    if (re.test(lines[i])) hits.push(i + 1);
  }
  return hits;
}
