import type { PackageRef, DetectRule } from "./rules.mjs";

export type Severity = "breaks" | "will-break" | "silent" | "cost";

export type PackRule = {
  id: string;
  title: string;
  provider: string;
  severity: Severity;
  deadline: string | null;
  packages: PackageRef[];
  detect: DetectRule[];
  checkManually: boolean;
  fix: string;
  url: string | null;
  private?: boolean;
  /** Absent in packs from older servers; read as false. */
  launch?: boolean;
};

/** dir is relative to the scan root ("" for the root); values are resolved versions. */
export type Manifest = {
  dir: string;
  npm: Record<string, string>;
  pypi: Record<string, string>;
  actions: Record<string, string>;
};

export type Finding = {
  trapId: string;
  title: string;
  provider: string;
  severity: Severity;
  deadline: string | null;
  file: string | null;
  line: number | null;
  fix: string;
  url: string | null;
  private: boolean;
  manual: boolean;
  launch: boolean;
};

export type SkippedRule = { id: string; why: string };

/**
 * A rule whose package ref the manifest at dir satisfies, hit or not. Rules with no npm, pypi or github-action refs,
 * rules satisfied only through a broad range ("*", "", "x", "X", or any range that 0.0.0 and 999999.0.0 both satisfy) and rules skipped at run time never appear.
 */
export type Applicable = {
  trapId: string;
  package: { ecosystem: "npm" | "pypi" | "github-action"; name: string; version: string };
  dir: string;
};

export function readManifests(root: string): Manifest[];
/** Never rejects for a bad rule: unsafe, malformed or runaway rules land in skippedRules. */
export function scanProject(root: string, rules: PackRule[]): Promise<{ findings: Finding[]; skippedRules: SkippedRule[]; applicable: Applicable[] }>;
