import { describe, expect, it } from 'vitest';
import { compareVersions, isVersion, versionFromTag } from '../../src/shared/version.js';

describe('compareVersions', () => {
  it('orders by numeric component, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('pads missing components with zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0);
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0);
  });

  it('treats unparseable components as zero rather than NaN', () => {
    expect(compareVersions('1.x.3', '1.0.3')).toBe(0);
    expect(compareVersions('', '0')).toBe(0);
  });
});

describe('isVersion', () => {
  it.each(['1', '1.0', '1.2.3', '10.20.30'])('accepts %s', (v) => {
    expect(isVersion(v)).toBe(true);
  });

  it.each(['v1.0.0', '1.0.0-beta', '', 'abc', '1..2'])('rejects %s', (v) => {
    expect(isVersion(v)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isVersion(undefined)).toBe(false);
    expect(isVersion(123)).toBe(false);
    expect(isVersion(null)).toBe(false);
  });
});

describe('versionFromTag', () => {
  it('strips a leading v in either case and trims', () => {
    expect(versionFromTag('v1.2.3')).toBe('1.2.3');
    expect(versionFromTag('V1.2.3')).toBe('1.2.3');
    expect(versionFromTag(' 1.2.3 ')).toBe('1.2.3');
  });

  it('returns null for anything that is not a version', () => {
    expect(versionFromTag('release-2')).toBeNull();
    expect(versionFromTag(undefined)).toBeNull();
    expect(versionFromTag(null)).toBeNull();
    expect(versionFromTag({})).toBeNull();
  });
});
