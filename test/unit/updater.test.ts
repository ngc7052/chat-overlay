import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdater } from '../../src/main/updater/index.js';
import { REQUIRED_FILES, STAGED_MARKER } from '../../src/main/updater/manifest.js';

/**
 * These run against a real temporary directory rather than a mocked fs: the
 * point of the staging code is what ends up on disk, so asserting on mock calls
 * would prove nothing.
 */

let tmp: string;
let incomingDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-updater-'));
  incomingDir = path.join(tmp, 'payload-new');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

function manifest(over: Record<string, unknown> = {}) {
  const files: Record<string, unknown> = {};
  for (const f of REQUIRED_FILES) files[f] = { sha256: sha256('body ' + f), enc: 'utf8', data: 'body ' + f };
  return { version: '1.0.1', files, ...over };
}

function gzOf(value: unknown): ArrayBuffer {
  const buf = gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function updaterWith(fetchImpl: unknown, over: Record<string, unknown> = {}) {
  return createUpdater({
    fetch: fetchImpl as never,
    releaseApi: 'https://api.example/releases/latest',
    incomingDir: () => incomingDir,
    currentVersion: () => '1.0.0',
    quarantinedVersion: () => null,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  });
}

const okJson = (value: unknown) => ({ ok: true, status: 200, json: async () => value, arrayBuffer: async () => new ArrayBuffer(0) });
const okBinary = (value: unknown) => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => gzOf(value) });

describe('check', () => {
  it('returns the parsed release', async () => {
    const updater = updaterWith(async () => okJson({
      tag_name: 'v1.0.1',
      assets: [{ name: 'app-payload.json.gz', browser_download_url: 'https://cdn/p' }],
    }));
    await expect(updater.check()).resolves.toMatchObject({ version: '1.0.1', newer: true });
  });

  it('sends the GitHub headers', async () => {
    const fetchSpy = vi.fn(async () => okJson({ tag_name: 'v1.0.1' }));
    await updaterWith(fetchSpy).check();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example/releases/latest',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'ChatOverlay' }),
      }),
    );
  });

  it('surfaces an HTTP failure', async () => {
    const updater = updaterWith(async () => ({ ok: false, status: 403, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(updater.check()).rejects.toThrow('HTTP 403');
  });

  it('reports a timeout in plain language', async () => {
    const updater = updaterWith(async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    });
    await expect(updater.check()).rejects.toThrow('timed out after 20s');
  });

  it('passes other network errors through', async () => {
    const updater = updaterWith(async () => { throw new Error('ENOTFOUND'); });
    await expect(updater.check()).rejects.toThrow('ENOTFOUND');
  });
});

describe('download', () => {
  it('writes every file and the completion marker last', async () => {
    const updater = updaterWith(async () => okBinary(manifest()));
    const result = await updater.download('https://cdn/p', '1.0.1');

    expect(result).toEqual({ version: '1.0.1', files: REQUIRED_FILES.length });
    for (const f of REQUIRED_FILES) {
      expect(fs.readFileSync(path.join(incomingDir, f), 'utf8')).toBe('body ' + f);
    }
    const marker = JSON.parse(fs.readFileSync(path.join(incomingDir, STAGED_MARKER), 'utf8'));
    expect(marker).toEqual({ version: '1.0.1', files: REQUIRED_FILES.length, at: '2026-01-01T00:00:00.000Z' });
  });

  it('creates nested directories', async () => {
    const updater = updaterWith(async () => okBinary(manifest()));
    await updater.download('https://cdn/p');
    expect(fs.existsSync(path.join(incomingDir, 'renderer', 'index.html'))).toBe(true);
  });

  it('replaces a previous incomplete attempt', async () => {
    fs.mkdirSync(incomingDir, { recursive: true });
    fs.writeFileSync(path.join(incomingDir, 'stale.js'), 'old');
    const updater = updaterWith(async () => okBinary(manifest()));
    await updater.download('https://cdn/p');
    expect(fs.existsSync(path.join(incomingDir, 'stale.js'))).toBe(false);
  });

  it('refuses a download that fails', async () => {
    const updater = updaterWith(async () => ({ ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(updater.download('https://cdn/p')).rejects.toThrow('download failed: HTTP 404');
  });

  it('reports a download timeout', async () => {
    const updater = updaterWith(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    await expect(updater.download('https://cdn/p')).rejects.toThrow('timed out after 120s');
  });

  it('refuses a package that is not valid gzip or json', async () => {
    const notGzip = updaterWith(async () => ({
      ok: true, status: 200, json: async () => ({}),
      arrayBuffer: async () => new TextEncoder().encode('plain text').buffer,
    }));
    await expect(notGzip.download('https://cdn/p')).rejects.toThrow('corrupt update package');
  });

  it('refuses a package whose version disagrees with the release', async () => {
    const updater = updaterWith(async () => okBinary(manifest()));
    await expect(updater.download('https://cdn/p', '2.0.0'))
      .rejects.toThrow('package is v1.0.1, release says v2.0.0');
  });

  it('refuses a path that escapes the payload directory', async () => {
    const evil = manifest();
    (evil.files as Record<string, unknown>)['../evil.js'] = { sha256: sha256('x'), data: 'x' };
    const updater = updaterWith(async () => okBinary(evil));
    await expect(updater.download('https://cdn/p'))
      .rejects.toThrow('refusing suspicious path in update: ../evil.js');
    expect(fs.existsSync(path.join(tmp, 'evil.js'))).toBe(false);
  });

  it('refuses a file whose contents do not match its checksum', async () => {
    const tampered = manifest();
    (tampered.files as Record<string, { sha256: string }>)['main.js']!.sha256 = sha256('something else');
    const updater = updaterWith(async () => okBinary(tampered));
    await expect(updater.download('https://cdn/p')).rejects.toThrow('checksum mismatch for main.js');
  });

  it('leaves no completion marker when anything fails', async () => {
    const tampered = manifest();
    (tampered.files as Record<string, { sha256: string }>)['main.js']!.sha256 = sha256('nope');
    const updater = updaterWith(async () => okBinary(tampered));
    await expect(updater.download('https://cdn/p')).rejects.toThrow();
    // Without the marker boot will discard the directory rather than install it.
    expect(fs.existsSync(path.join(incomingDir, STAGED_MARKER))).toBe(false);
  });

  it('accepts a base64 file', async () => {
    const withBinary = manifest();
    (withBinary.files as Record<string, unknown>)['assets/icon.png'] = {
      sha256: createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'),
      enc: 'base64',
      data: Buffer.from([1, 2, 3]).toString('base64'),
    };
    const updater = updaterWith(async () => okBinary(withBinary));
    await updater.download('https://cdn/p');
    expect([...fs.readFileSync(path.join(incomingDir, 'assets/icon.png'))]).toEqual([1, 2, 3]);
  });
});
