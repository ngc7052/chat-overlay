import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { ReleaseInfo } from '../types.js';
import { decodeEntry, REQUIRED_FILES, safeRelativePath, STAGED_MARKER, validateManifest } from './manifest.js';
import { parseRelease } from './release.js';

/*
 * Update checking and staging.
 *
 * Electron's built-in autoUpdater needs a Squirrel/NSIS installer and a signed
 * binary, and cannot update a portable unpacked app at all. It is also aimed at
 * replacing the whole runtime. Here the runtime is fixed and only the app
 * payload changes, so an update is a small gzipped manifest:
 *
 *   { version, files: { "<relative path>": { sha256, enc, data } } }
 *
 * It is written to <userData>/payload-new — never into the payload that is
 * running — and boot.ts moves it into place on the next launch, so nothing ever
 * overwrites a file the running process holds open.
 */

export const CHECK_TIMEOUT_MS = 20 * 1000;
export const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const UA = 'ChatOverlay';

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface UpdaterDeps {
  fetch: FetchLike;
  releaseApi: string;
  /** Where a verified package is staged; boot installs it on the next launch. */
  incomingDir: () => string;
  currentVersion: () => string;
  quarantinedVersion: () => string | null;
  fs?: Pick<typeof nodeFs, 'rmSync' | 'mkdirSync' | 'writeFileSync' | 'readFileSync'>;
  now?: () => Date;
}

export interface StageResult { version: string; files: number }

function timeoutSignal(ms: number): AbortSignal | undefined {
  // Node <17.3 and some test doubles lack it; the fetch just runs untimed.
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

export function createUpdater(deps: UpdaterDeps) {
  const fs = deps.fs ?? nodeFs;
  const now = deps.now ?? (() => new Date());

  async function fetchWithTimeout(url: string, headers: Record<string, string>, timeoutMs: number) {
    try {
      const signal = timeoutSignal(timeoutMs);
      return await deps.fetch(url, signal ? { headers, signal } : { headers });
    } catch (err) {
      const e = err as { name?: string };
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    }
  }

  /** Ask GitHub what the latest release is. */
  async function check(): Promise<ReleaseInfo> {
    const res = await fetchWithTimeout(
      deps.releaseApi,
      { Accept: 'application/vnd.github+json', 'User-Agent': UA },
      CHECK_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return parseRelease(await res.json(), deps.currentVersion(), deps.quarantinedVersion());
  }

  /**
   * Download the manifest and write it to <userData>/payload-new.
   * Every file is hash-checked after it lands on disk, and the marker that lets
   * boot install the directory is written only once all of them verify.
   */
  async function download(url: string, expectedVersion?: string | null): Promise<StageResult> {
    const res = await fetchWithTimeout(
      url,
      { Accept: 'application/octet-stream', 'User-Agent': UA },
      DOWNLOAD_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error('download failed: HTTP ' + res.status);

    const gz = Buffer.from(await res.arrayBuffer());
    let parsed: unknown;
    try {
      parsed = JSON.parse(gunzipSync(gz).toString('utf8'));
    } catch (err) {
      throw new Error('corrupt update package: ' + (err as Error).message);
    }

    const manifest = validateManifest(parsed, expectedVersion);
    const incomingDir = deps.incomingDir();
    fs.rmSync(incomingDir, { recursive: true, force: true });
    fs.mkdirSync(incomingDir, { recursive: true });

    let count = 0;
    for (const [rel, entry] of Object.entries(manifest.files)) {
      const safe = safeRelativePath(rel);
      if (!safe) throw new Error('refusing suspicious path in update: ' + rel);

      const dest = nodePath.join(incomingDir, safe);
      /* c8 ignore next 2 -- belt-and-braces behind safeRelativePath, which already
         rejects every path that could land outside incomingDir */
      if (!dest.startsWith(incomingDir + nodePath.sep)) throw new Error('path escape: ' + rel);

      const buf = decodeEntry(rel, entry);
      fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);

      // Re-read rather than hashing the buffer: this is what actually landed.
      const actual = createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
      if (actual !== String(entry.sha256).toLowerCase()) throw new Error('checksum mismatch for ' + rel);
      count += 1;
    }

    // Marker last: boot only installs a payload-new that carries it.
    fs.writeFileSync(
      nodePath.join(incomingDir, STAGED_MARKER),
      JSON.stringify({ version: manifest.version, files: count, at: now().toISOString() }),
      'utf8',
    );

    return { version: manifest.version, files: count };
  }

  return { check, download };
}

export { REQUIRED_FILES, STAGED_MARKER };
