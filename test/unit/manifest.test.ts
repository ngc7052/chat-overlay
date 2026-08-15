import { describe, expect, it } from 'vitest';
import {
  decodeEntry, REQUIRED_FILES, safeRelativePath, STAGED_MARKER, validateManifest,
} from '../../src/main/updater/manifest.js';

const sha = (hex: string) => hex.repeat(64).slice(0, 64);

describe('safeRelativePath', () => {
  it('accepts ordinary paths', () => {
    expect(safeRelativePath('main.js')).toBe('main.js');
    expect(safeRelativePath('renderer/index.html')).toBe('renderer/index.html');
    expect(safeRelativePath('a/b/c/d.png')).toBe('a/b/c/d.png');
  });

  it('normalises redundant segments', () => {
    expect(safeRelativePath('./main.js')).toBe('main.js');
    expect(safeRelativePath('a/../main.js')).toBe('main.js');
  });

  it('refuses to climb out of the payload directory', () => {
    // An update package is remote input; a path escape here writes anywhere
    // the user can write.
    expect(safeRelativePath('../evil.js')).toBeNull();
    expect(safeRelativePath('..')).toBeNull();
    expect(safeRelativePath('a/../../evil.js')).toBeNull();
    expect(safeRelativePath('/etc/passwd')).toBeNull();
  });

  it('refuses backslashes, which are separators on Windows', () => {
    expect(safeRelativePath('..\\evil.js')).toBeNull();
    expect(safeRelativePath('a\\b.js')).toBeNull();
  });

  it('refuses null bytes', () => {
    expect(safeRelativePath('a\0b.js')).toBeNull();
  });

  it('refuses anything that is not a usable string', () => {
    expect(safeRelativePath('')).toBeNull();
    expect(safeRelativePath(undefined)).toBeNull();
    expect(safeRelativePath(null)).toBeNull();
    expect(safeRelativePath(42)).toBeNull();
  });

  it('refuses to let a package write the completion marker itself', () => {
    // The marker is what tells boot the directory is complete; a package that
    // could write it early would get a half-installed payload promoted.
    expect(safeRelativePath(STAGED_MARKER)).toBeNull();
    expect(safeRelativePath('renderer/' + STAGED_MARKER)).toBeNull();
  });
});

describe('decodeEntry', () => {
  it('decodes utf8 by default and explicitly', () => {
    expect(decodeEntry('a.js', { sha256: sha('a'), data: 'hi' }).toString()).toBe('hi');
    expect(decodeEntry('a.js', { sha256: sha('a'), enc: 'utf8', data: 'hi' }).toString()).toBe('hi');
  });

  it('decodes base64', () => {
    const data = Buffer.from('binary').toString('base64');
    expect(decodeEntry('a.png', { sha256: sha('a'), enc: 'base64', data }).toString()).toBe('binary');
  });

  it('requires a checksum', () => {
    expect(() => decodeEntry('a.js', { data: 'hi' })).toThrow('no checksum');
    expect(() => decodeEntry('a.js', { sha256: 'short', data: 'hi' })).toThrow('no checksum');
  });

  it('requires data', () => {
    expect(() => decodeEntry('a.js', { sha256: sha('a') })).toThrow('no data');
    expect(() => decodeEntry('a.js', { sha256: sha('a'), data: 42 })).toThrow('no data');
  });

  it('rejects an entry that is not an object', () => {
    expect(() => decodeEntry('a.js', null)).toThrow('bad entry');
    expect(() => decodeEntry('a.js', 'text')).toThrow('bad entry');
  });

  it('rejects an unknown encoding rather than guessing', () => {
    expect(() => decodeEntry('a.js', { sha256: sha('a'), enc: 'rot13', data: 'x' }))
      .toThrow('unknown encoding');
  });
});

describe('validateManifest', () => {
  const files = Object.fromEntries(
    REQUIRED_FILES.map((f) => [f, { sha256: sha('a'), data: 'x' }]),
  );

  it('accepts a complete package', () => {
    expect(validateManifest({ version: '1.0.1', files }).version).toBe('1.0.1');
  });

  it('rejects anything without a files map', () => {
    expect(() => validateManifest(null)).toThrow('no files');
    expect(() => validateManifest({})).toThrow('no files');
    expect(() => validateManifest({ version: '1.0.0', files: [] })).toThrow('no files');
    expect(() => validateManifest({ version: '1.0.0', files: 'x' })).toThrow('no files');
  });

  it('rejects a missing or malformed version', () => {
    expect(() => validateManifest({ files })).toThrow('no version');
    expect(() => validateManifest({ version: 'v1', files })).toThrow('no version');
  });

  it('rejects a package that disagrees with the release tag', () => {
    // The client decides whether to update from the tag; a mismatch means it
    // would install something it then refuses to run.
    expect(() => validateManifest({ version: '1.0.1', files }, '1.0.2'))
      .toThrow('package is v1.0.1, release says v1.0.2');
  });

  it('accepts when no expected version is supplied', () => {
    expect(validateManifest({ version: '1.0.1', files }, null).version).toBe('1.0.1');
    expect(validateManifest({ version: '1.0.1', files }, undefined).version).toBe('1.0.1');
  });

  it.each(REQUIRED_FILES)('rejects a package missing %s', (missing) => {
    const partial = { ...files };
    delete (partial as Record<string, unknown>)[missing];
    expect(() => validateManifest({ version: '1.0.1', files: partial }))
      .toThrow('missing ' + missing);
  });
});
