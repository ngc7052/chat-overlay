import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Pack a built payload directory into the manifest the in-app updater consumes.
 *
 *   { "version": "1.0.1",
 *     "files": { "main.js": { "sha256": "…", "enc": "utf8", "data": "…" }, … } }
 *
 * Text goes in as UTF-8 so a release diff stays readable; binaries are base64.
 * This decides what every install downloads, so it is kept testable and its
 * output is checked against the same rules the client applies on the way in.
 */

const TEXT_SUFFIXES = new Set(['.js', '.json', '.html', '.css', '.svg', '.md', '.txt']);
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
export const REQUIRED_FILES = ['main.js', 'preload.js', 'version.json', 'renderer/index.html'];

export interface PayloadEntry { sha256: string; enc: 'utf8' | 'base64'; data: string }
export interface Payload { version: string; files: Record<string, PayloadEntry> }

/** Every file under `dir`, as posix-relative paths, sorted for a stable output. */
export function listFiles(dir: string, fsImpl: typeof fs = fs): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    const entries = [...fsImpl.readdirSync(current, { withFileTypes: true })]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = entry.name;
      if (SKIP_NAMES.has(name) || name.startsWith('.')) continue;
      const rel = prefix ? prefix + '/' + name : name;
      if (entry.isDirectory()) walk(path.join(current, name), rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

export function encodeFile(rel: string, raw: Buffer): PayloadEntry {
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (TEXT_SUFFIXES.has(path.extname(rel).toLowerCase())) {
    const text = raw.toString('utf8');
    // Round-trip check: anything that is not really UTF-8 goes in as base64.
    if (Buffer.from(text, 'utf8').equals(raw)) return { sha256, enc: 'utf8', data: text };
  }
  return { sha256, enc: 'base64', data: raw.toString('base64') };
}

export function buildPayload(dir: string, fsImpl: typeof fs = fs): Payload {
  const versionRaw = fsImpl.readFileSync(path.join(dir, 'version.json'), 'utf8') as string;
  const version = (JSON.parse(versionRaw) as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error('version.json has no version');

  const files: Record<string, PayloadEntry> = {};
  for (const rel of listFiles(dir, fsImpl)) {
    files[rel] = encodeFile(rel, fsImpl.readFileSync(path.join(dir, rel)) as Buffer);
  }
  for (const required of REQUIRED_FILES) {
    if (!files[required]) throw new Error(`payload is missing ${required}`);
  }
  return { version, files };
}

export function serialisePayload(payload: Payload): Buffer {
  // No replacer: an array replacer filters keys at *every* level, which would
  // drop every file entry. Stable ordering comes from listFiles() being sorted.
  return gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
}

export function writePayload(dir: string, out: string): Payload {
  const payload = buildPayload(dir);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, serialisePayload(payload));
  return payload;
}

/* c8 ignore start -- CLI entry, exercised through the build */
const invokedDirectly = process.argv[1] && /make-payload\.(ts|js|mjs|cjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) {
    console.error('usage: make-payload <payload-dir> <out.json.gz>');
    process.exit(1);
  }
  const payload = writePayload(dir, out);
  const size = fs.statSync(out).size;
  console.log(
    `    ${out}  v${payload.version}  ${Object.keys(payload.files).length} files  ` +
    `${Math.round(size / 1024)} KB`,
  );
}
/* c8 ignore stop */
