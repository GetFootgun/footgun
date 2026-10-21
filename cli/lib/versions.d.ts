import type { PackageRef } from "./rules.mjs";

/** true/false when decidable, null when the version or range is not understood. */
export function satisfiesNpm(version: string, range: string): boolean | null;
export function satisfiesPep440(version: string, spec: string): boolean | null;
/** True when satisfiesX can decide this range, so the rule gate may accept it. */
export function rangeSupported(ecosystem: PackageRef["ecosystem"], range: string): boolean;
