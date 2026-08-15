/**
 * Dotted numeric version handling, shared by the bootstrapper and the updater.
 *
 * These two must agree exactly: boot.ts decides which payload is newer, and the
 * updater decides whether a release is worth offering. If they disagreed, an
 * install could download an update it then refuses to run.
 */

/** Compare dotted numeric versions. Returns >0 when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The shape a release tag and a manifest version must both take. */
export const VERSION_RE = /^\d+(\.\d+)*$/;

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_RE.test(value);
}

/** `v1.2.3` / `V1.2.3` / ` 1.2.3 ` -> `1.2.3`; null when it is not a version. */
export function versionFromTag(tag: unknown): string | null {
  const stripped = String(tag ?? '').replace(/^v/i, '').trim();
  return isVersion(stripped) ? stripped : null;
}
