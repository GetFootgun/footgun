// Text and JSON output for `footgun scan`. Every server-supplied string goes through clean().
import { clean } from "./clean.mjs";

const GROUPS = [
  ["breaks", "Breaks now"],
  ["will-break", "Will break"],
  ["silent", "Wrong results with no error"],
  ["cost", "Costs money"],
];

/** Severities that trip `--fail-on`. Check-yourself items never do. */
export const FAIL_ON = { breaks: ["breaks"], "will-break": ["breaks", "will-break"] };

export function failed(findings, failOn) {
  if (!failOn) return false;
  return findings.some((f) => !f.manual && FAIL_ON[failOn].includes(f.severity));
}

function details(f) {
  const out = [`  Fix: ${clean(f.fix)}`];
  if (f.deadline) out.push(`  Deadline: ${clean(f.deadline)}`);
  if (f.url) out.push(`  ${clean(f.url)}`);
  return out;
}

export function textReport(findings) {
  if (!findings.length) return "No known traps found.";
  const found = findings.filter((f) => !f.manual);
  const manual = findings.filter((f) => f.manual);
  const out = [];
  for (const [sev, heading] of GROUPS) {
    const group = found.filter((f) => f.severity === sev);
    if (!group.length) continue;
    out.push(`${heading}:`, "");
    for (const f of group) out.push(`${clean(f.file)}:${f.line}  ${clean(f.title)}`, ...details(f), "");
  }
  if (manual.length) {
    out.push("Check these yourself:", "");
    for (const f of manual) out.push(clean(f.title), ...details(f), "");
  }
  const now = found.filter((f) => f.severity === "breaks").length;
  const dated = found.filter((f) => f.deadline).length;
  out.push(`${found.length} ${found.length === 1 ? "problem" : "problems"} (${now} break now, ${dated} with a deadline)`);
  return out.join("\n");
}

export function jsonReport({ findings, skippedRules, fromCache, version }) {
  return JSON.stringify({ version, fromCache, findings, skippedRules }, null, 2);
}
