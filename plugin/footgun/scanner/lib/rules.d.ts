export type PackageRef = {
  ecosystem: "npm" | "pypi" | "github-action" | "service";
  name: string;
  range: string;
};

export type DetectRule = {
  files: string[];
  pattern: string;
  unless?: string;
};

/** Empty array means the rule is safe to run. */
export function ruleProblems(rule: DetectRule): string[];
/** Paths are forward-slash and relative. Supports **, *, ? and {a,b}. */
export function globMatch(glob: string, relPath: string): boolean;
/** 1-based line numbers of matches; [] when not applicable. */
export function matchRule(rule: DetectRule, relPath: string, text: string): number[];
