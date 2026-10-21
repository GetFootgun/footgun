// Copy of SECRET_PATTERNS in lib/sanitize.ts (this package cannot import from the app).
// tests/cli.test.ts fails if the two lists drift apart.
export const SECRET_PATTERNS = [
  ["anthropic key", /sk-ant-[a-z0-9-]{20,}/i],
  ["openai key", /(?<![A-Za-z0-9])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ["aws access key", /AKIA[0-9A-Z]{16}/],
  ["github token", /gh[pousr]_[A-Za-z0-9]{30,}/],
  ["github fine-grained token", /github_pat_[A-Za-z0-9_]{50,}/],
  ["slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["stripe key", /[sr]k_(live|test)_[A-Za-z0-9]{16,}/],
  ["google api key", /AIza[0-9A-Za-z_-]{35}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

// Replaces anything shaped like a known secret before the text leaves this machine.
export function scrub(text) {
  let t = String(text ?? "");
  for (const [name, re] of SECRET_PATTERNS) {
    t = t.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), `<${name} redacted>`);
  }
  return t;
}
