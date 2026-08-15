import { posix as posixPath } from 'node:path';
import { isVersion } from '../../shared/version.js';

/**
 * Update package format and its safety rules.
 *
 * Everything a downloaded package can do to the machine is decided here, so it
 * is deliberately free of I/O: the rules can be tested directly rather than
 * inferred from what ended up on disk.
 */

export const STAGED_MARKER = '.staged';   // written last; proves the directory is complete
export const REQUIRED_FILES = ['main.js', 'preload.js', 'version.json', 'renderer/index.html'];

export interface ManifestEntry {
  sha256: string;
  enc?: 'utf8' | 'base64';
  data: string;
}

export interface Manifest {
  version: string;
  files: Record<string, ManifestEntry>;
}

/**
 * Reject anything that could escape the payload directory.
 * Returns the normalised path, or null when it must not be written.
 */
export function safeRelativePath(rel: unknown): string | null {
  if (typeof rel !== 'string' || !rel) return null;
  // Backslashes would be a separator on Windows but not here, so a name like
  // "..\\evil" must never be treated as a plain filename.
  if (rel.includes('\\') || rel.includes('\0')) return null;
  if (posixPath.isAbsolute(rel)) return null;
  const normalised = posixPath.normalize(rel);
  if (normalised.startsWith('../') || normalised === '..') return null;
  if (posixPath.basename(normalised) === STAGED_MARKER) return null;   // ours, written last
  return normalised;
}

/** Decode one file, refusing anything without a usable checksum. */
export function decodeEntry(rel: string, entry: unknown): Buffer {
  if (!entry || typeof entry !== 'object') throw new Error('bad entry for ' + rel);
  const e = entry as Partial<ManifestEntry>;
  if (typeof e.data !== 'string') throw new Error('no data for ' + rel);
  if (!/^[0-9a-f]{64}$/i.test(String(e.sha256 ?? ''))) throw new Error('no checksum for ' + rel);
  if (e.enc === 'base64') return Buffer.from(e.data, 'base64');
  if (e.enc === 'utf8' || e.enc == null) return Buffer.from(e.data, 'utf8');
  throw new Error(`unknown encoding "${e.enc}" for ${rel}`);
}

/**
 * Check the package as a whole before a single byte is written.
 * `expectedVersion` is the release tag: a package that disagrees with it would
 * install a version the client then refuses to run.
 */
export function validateManifest(raw: unknown, expectedVersion?: string | null): Manifest {
  if (!raw || typeof raw !== 'object') throw new Error('update package has no files');
  const manifest = raw as Partial<Manifest>;
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('update package has no files');
  }
  if (!isVersion(manifest.version)) throw new Error('update package has no version');
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(`package is v${manifest.version}, release says v${expectedVersion}`);
  }
  for (const required of REQUIRED_FILES) {
    if (!manifest.files[required]) throw new Error('update package is missing ' + required);
  }
  return manifest as Manifest;
}
