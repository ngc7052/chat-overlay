import { describe, expect, it } from 'vitest';
import { ASSET_NAME, parseRelease } from '../../src/main/updater/release.js';

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v1.0.1',
  html_url: 'https://github.com/o/r/releases/tag/v1.0.1',
  body: 'notes',
  assets: [{ name: ASSET_NAME, browser_download_url: 'https://cdn/app-payload.json.gz' }],
  ...over,
});

describe('parseRelease', () => {
  it('reads a normal release', () => {
    expect(parseRelease(release(), '1.0.0', null)).toEqual({
      version: '1.0.1',
      current: '1.0.0',
      newer: true,
      quarantined: false,
      url: 'https://cdn/app-payload.json.gz',
      page: 'https://github.com/o/r/releases/tag/v1.0.1',
      notes: 'notes',
    });
  });

  it('is not newer when it matches or trails the running version', () => {
    expect(parseRelease(release(), '1.0.1', null).newer).toBe(false);
    expect(parseRelease(release(), '1.1.0', null).newer).toBe(false);
  });

  it('rejects a tag that is not a version', () => {
    expect(() => parseRelease(release({ tag_name: 'nightly' }), '1.0.0', null))
      .toThrow('unexpected tag: nightly');
    expect(() => parseRelease({}, '1.0.0', null)).toThrow('unexpected tag');
    expect(() => parseRelease(null, '1.0.0', null)).toThrow('unexpected tag');
  });

  it('reports no url when the release carries no payload asset', () => {
    // Means the runtime itself changed: the app sends the user to the page
    // for a full download instead of trying a partial update.
    expect(parseRelease(release({ assets: [] }), '1.0.0', null).url).toBeNull();
    expect(parseRelease(release({ assets: [{ name: 'ChatOverlay.zip' }] }), '1.0.0', null).url).toBeNull();
    expect(parseRelease(release({ assets: 'nope' }), '1.0.0', null).url).toBeNull();
  });

  it('ignores an asset whose url is not a string', () => {
    const bad = release({ assets: [{ name: ASSET_NAME, browser_download_url: 42 }] });
    expect(parseRelease(bad, '1.0.0', null).url).toBeNull();
  });

  it('flags a version this install already threw out', () => {
    expect(parseRelease(release(), '1.0.0', '1.0.1').quarantined).toBe(true);
    expect(parseRelease(release(), '1.0.0', '9.9.9').quarantined).toBe(false);
  });

  it('copes with a missing page or notes', () => {
    const bare = parseRelease(release({ html_url: undefined, body: undefined }), '1.0.0', null);
    expect(bare.page).toBeNull();
    expect(bare.notes).toBe('');
  });

  it('truncates very long notes', () => {
    const long = parseRelease(release({ body: 'x'.repeat(9000) }), '1.0.0', null);
    expect(long.notes).toHaveLength(4000);
  });

  it('ignores null entries in the asset list', () => {
    const withNull = release({ assets: [null, { name: ASSET_NAME, browser_download_url: 'u' }] });
    expect(parseRelease(withNull, '1.0.0', null).url).toBe('u');
  });
});
