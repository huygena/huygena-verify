import type { Tolerance } from "./schema";

/**
 * Width of a numeric band around `reported`, per SPEC.md "Tolerance rules (draft v0)":
 *
 *   band = abs + rel * |reported|
 *
 * A bare number is `abs`. This is the same form as numpy.isclose (atol + rtol * |b|),
 * with the paper's value as the reference.
 */
export function numericBand(tol: Tolerance, reported: number): number {
  if (typeof tol === "number") return tol;
  return (tol.abs ?? 0) + (tol.rel ?? 0) * Math.abs(reported);
}

/** True when the tolerance has at least one numeric component (`abs` or `rel`). */
export function hasNumericBand(tol: Tolerance): boolean {
  return typeof tol === "number" || tol.abs !== undefined || tol.rel !== undefined;
}

/** True when the tolerance has an `rmsd` component (structure claims). */
export function hasRmsd(tol: Tolerance): tol is { rmsd: number } {
  return typeof tol === "object" && tol.rmsd !== undefined;
}

/**
 * Binary floating point cannot represent most decimals, so 0.917 - 0.912 is
 * 0.0050000000000000044, not 0.005. Bounds are inclusive and compared with this
 * relative slack so a value exactly on the edge of its band counts as inside.
 * It is a rounding allowance, not a scientific threshold.
 */
export const FLOAT_SLACK = 1e-12;

export function withinBand(delta: number, band: number, scale: number): boolean {
  return Math.abs(delta) <= band + FLOAT_SLACK * Math.max(1, Math.abs(scale), band);
}
