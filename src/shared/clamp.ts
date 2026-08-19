/**
 * Bounding a number to a range, shared by the main process and the renderer.
 *
 * It lives here rather than in `renderer/util.ts` because the config rules in
 * `main/config.ts` need it too, and the main process must not pull in renderer
 * code.
 */

/** Bound `n` to the inclusive range [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
