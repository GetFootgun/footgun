// The README badge `footgun scan` suggests. It claims only what this scan showed, on the day it ran:
// "no known API traps" when nothing at all was found (check-yourself items included), otherwise just "scanned".
// Launch reminders are the exception: they fire whenever a package is in use, so they say nothing about this code.

/** "clean" only when the scan found nothing, not even a check-yourself item, apart from launch reminders. */
export function badgeStatus(findings) {
  return findings.every((f) => f.manual && f.launch) ? "clean" : "scanned";
}

export function badgeMarkdown(findings, { base, date }) {
  const status = badgeStatus(findings);
  const alt = status === "clean" ? `No known API traps on ${date} · Footgun` : `Scanned by Footgun on ${date}`;
  return `[![${alt}](${base}/badge.svg?s=${status}&d=${date})](${base}/scan)`;
}
