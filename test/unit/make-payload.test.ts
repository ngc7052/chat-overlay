import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateManifest } from '../../src/main/updater/manifest.js';
import {
  buildPayload, encodeFile, listFiles, REQUIRED_FILES, serialisePayload, writePayload,
} from '../../tools/make-payload.js';

let tmp: string;
let src: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-payload-'));
  src = path.join(tmp, 'payload');
  fs.mkdirSync(path.join(src, 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(src, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(src, 'version.json'), JSON.stringify({ version: '1.2.3' }));
  fs.writeFileSync(path.join(src, 'main.js'), 'console.log("main")');
  fs.writeFileSync(path.join(src, 'preload.js'), 'console.log("preload")');
  fs.writeFileSync(path.join(src, 'renderer', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(src, 'assets', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('listFiles', () => {
  it('walks recursively and returns sorted posix paths', () => {
    expect(listFiles(src)).toEqual([
      'assets/icon.png', 'main.js', 'preload.js', 'renderer/index.html', 'version.json',
    ]);
  });

  it('skips dotfiles and editor droppings', () => {
    fs.writeFileSync(path.join(src, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(src, '.hidden'), 'x');
    expect(listFiles(src)).not.toContain('.DS_Store');
    expect(listFiles(src)).not.toContain('.hidden');
  });
});

describe('encodeFile', () => {
  it('keeps text readable and checksums it', () => {
    const raw = Buffer.from('hello', 'utf8');
    const entry = encodeFile('a.js', raw);
    expect(entry).toEqual({
      sha256: createHash('sha256').update(raw).digest('hex'),
      enc: 'utf8',
      data: 'hello',
    });
  });

  it('base64s anything binary', () => {
    const raw = Buffer.from([0, 1, 2, 255]);
    expect(encodeFile('a.png', raw)).toMatchObject({ enc: 'base64', data: raw.toString('base64') });
  });

  it('falls back to base64 for a text-suffixed file that is not valid utf8', () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00]);
    expect(encodeFile('a.js', raw).enc).toBe('base64');
  });
});

describe('buildPayload', () => {
  it('produces a manifest the client accepts', () => {
    const payload = buildPayload(src);
    expect(payload.version).toBe('1.2.3');
    expect(Object.keys(payload.files)).toHaveLength(5);
    // The packer and the client must agree, or a release installs nowhere.
    expect(() => validateManifest(payload, '1.2.3')).not.toThrow();
  });

  it('checksums match the bytes on disk', () => {
    const payload = buildPayload(src);
    const entry = payload.files['main.js'];
    const onDisk = fs.readFileSync(path.join(src, 'main.js'));
    expect(entry?.sha256).toBe(createHash('sha256').update(onDisk).digest('hex'));
  });

  it('refuses a payload with no version', () => {
    fs.writeFileSync(path.join(src, 'version.json'), '{}');
    expect(() => buildPayload(src)).toThrow('version.json has no version');
  });

  it.each(REQUIRED_FILES.filter((f) => f !== 'version.json'))(
    'refuses to ship a payload missing %s',
    (missing) => {
      fs.rmSync(path.join(src, missing));
      expect(() => buildPayload(src)).toThrow('missing ' + missing);
    },
  );
});

describe('serialisePayload', () => {
  it('round-trips through gzip with every file intact', () => {
    const payload = buildPayload(src);
    const restored = JSON.parse(gunzipSync(serialisePayload(payload)).toString('utf8'));
    // A replacer array here would silently drop every file entry.
    expect(Object.keys(restored.files)).toEqual(Object.keys(payload.files));
    expect(restored).toEqual(payload);
  });

  it('is deterministic for the same input', () => {
    const a = serialisePayload(buildPayload(src));
    const b = serialisePayload(buildPayload(src));
    expect(a.equals(b)).toBe(true);
  });
});

describe('writePayload', () => {
  it('writes the gzipped manifest, creating the directory', () => {
    const out = path.join(tmp, 'dist', 'app-payload.json.gz');
    const payload = writePayload(src, out);
    expect(payload.version).toBe('1.2.3');
    const restored = JSON.parse(gunzipSync(fs.readFileSync(out)).toString('utf8'));
    expect(restored.files['main.js'].data).toBe('console.log("main")');
  });
});
