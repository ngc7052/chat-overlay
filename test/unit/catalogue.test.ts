import { describe, expect, it } from 'vitest';
import {
  addBttv, addFfz, addSevenTv, buildBadgeMap, buildGgMap, https, normaliseGgCatalogue,
} from '../../src/renderer/emotes/catalogue.js';
import type { EmoteEntry } from '../../src/renderer/sources/types.js';

describe('https', () => {
  it('upgrades protocol-relative urls', () => {
    expect(https('//cdn.x/y')).toBe('https://cdn.x/y');
  });

  it('leaves absolute urls alone and passes empties through', () => {
    expect(https('https://cdn.x/y')).toBe('https://cdn.x/y');
    expect(https('')).toBeNull();
    expect(https(null)).toBeNull();
    expect(https(undefined)).toBeNull();
  });
});

describe('normaliseGgCatalogue', () => {
  it('trims the payload down to what is cached', () => {
    const list = normaliseGgCatalogue([{
      key: 'PekaClap',
      channel_id: 5,
      animated: 1,
      images: { small: '//gg/small.png', big: '//gg/big.png', gif: '//gg/anim.gif' },
    }]);
    expect(list).toEqual([{
      k: 'pekaclap', c: 5, u: 'https://gg/small.png', g: 'https://gg/anim.gif',
    }]);
  });

  it('falls back to the big image and blanks the gif for still smiles', () => {
    const list = normaliseGgCatalogue([{ key: 'a', images: { big: '//gg/big.png' } }]);
    expect(list[0]).toMatchObject({ u: 'https://gg/big.png', g: '', c: 0 });
  });

  it('blanks the gif when an animated smile has none', () => {
    const list = normaliseGgCatalogue([{ key: 'a', animated: 1, images: { small: '//s.png' } }]);
    expect(list[0]?.g).toBe('');
  });

  it('skips entries with no key or no image', () => {
    expect(normaliseGgCatalogue([
      { key: '', images: { small: '//a' } },
      { key: 'a', images: {} },
      { key: 'b' },
      null,
      'nope',
    ])).toEqual([]);
  });

  it('refuses a payload that is not a list', () => {
    expect(() => normaliseGgCatalogue({})).toThrow('unexpected smiles payload');
  });
});

describe('buildGgMap', () => {
  const list = [
    { k: 'shared', c: 0, u: 'global.png', g: '' },
    { k: 'shared', c: 5, u: 'channel.png', g: '' },
    { k: 'shared', c: 9, u: 'other.png', g: '' },
    { k: 'elsewhere', c: 9, u: 'other-only.png', g: '' },
    { k: 'anim', c: 0, u: 'still.png', g: 'moving.gif' },
  ];

  it('prefers this channel over global over everyone else', () => {
    expect(buildGgMap(list, 5).get('shared')).toEqual({ url: 'channel.png' });
    expect(buildGgMap(list, 1).get('shared')).toEqual({ url: 'global.png' });
  });

  it('still includes other channels, for premium users posting their smiles', () => {
    expect(buildGgMap(list, 5).get('elsewhere')).toEqual({ url: 'other-only.png' });
  });

  it('uses the animation with the still image as a fallback', () => {
    expect(buildGgMap(list, 0).get('anim')).toEqual({ url: 'moving.gif', fallback: 'still.png' });
  });

  it('copes with a non-numeric channel id', () => {
    expect(buildGgMap(list, 'abc').get('shared')).toEqual({ url: 'global.png' });
  });
});

describe('addSevenTv', () => {
  it('builds a url from the host and picks a 2x file', () => {
    const map = new Map<string, EmoteEntry>();
    addSevenTv(map, {
      emotes: [{
        id: 'e1', name: 'GAMBA',
        data: { host: { url: '//cdn.7tv.app/emote/e1', files: [{ name: '1x.webp' }, { name: '2x.webp' }] } },
      }],
    });
    expect(map.get('GAMBA')).toEqual({ url: 'https://cdn.7tv.app/emote/e1/2x.webp' });
  });

  it('prefers webp but accepts the other formats', () => {
    const map = new Map<string, EmoteEntry>();
    addSevenTv(map, {
      emotes: [{ id: 'e', name: 'A', data: { host: { url: '//h/e', files: [{ name: '2x.gif' }] } } }],
    });
    expect(map.get('A')?.url).toBe('https://h/e/2x.gif');
  });

  it('falls back to the canonical cdn path when there is no host', () => {
    const map = new Map<string, EmoteEntry>();
    addSevenTv(map, { emotes: [{ id: 'e2', name: 'B' }] });
    expect(map.get('B')).toEqual({ url: 'https://cdn.7tv.app/emote/e2/2x.webp' });
  });

  it('defaults the file when none of the known sizes are offered', () => {
    const map = new Map<string, EmoteEntry>();
    addSevenTv(map, { emotes: [{ id: 'e', name: 'C', data: { host: { url: '//h/e', files: [{ name: '9x.tiff' }] } } }] });
    expect(map.get('C')?.url).toBe('https://h/e/2x.webp');
  });

  it('ignores malformed input', () => {
    const map = new Map<string, EmoteEntry>();
    addSevenTv(map, null);
    addSevenTv(map, {});
    addSevenTv(map, { emotes: 'no' });
    addSevenTv(map, { emotes: [null, { id: 'x' }, { name: 5 }] });
    expect(map.size).toBe(0);
  });
});

describe('addBttv', () => {
  it('builds the 2x cdn url', () => {
    const map = new Map<string, EmoteEntry>();
    addBttv(map, [{ id: 'b1', code: 'catJAM' }]);
    expect(map.get('catJAM')).toEqual({ url: 'https://cdn.betterttv.net/emote/b1/2x' });
  });

  it('ignores malformed input', () => {
    const map = new Map<string, EmoteEntry>();
    addBttv(map, null);
    addBttv(map, 'no');
    addBttv(map, [null, { id: 'x' }, { code: 'y' }]);
    expect(map.size).toBe(0);
  });
});

describe('addFfz', () => {
  it('picks the best available size', () => {
    const map = new Map<string, EmoteEntry>();
    addFfz(map, { 1: { emoticons: [{ name: 'PogChamp', urls: { 1: '//f/1', 2: '//f/2' } }] } });
    expect(map.get('PogChamp')).toEqual({ url: 'https://f/2' });
  });

  it('falls back through the sizes', () => {
    const map = new Map<string, EmoteEntry>();
    addFfz(map, { 1: { emoticons: [{ name: 'A', urls: { 1: '//f/1' } }] } });
    addFfz(map, { 2: { emoticons: [{ name: 'B', urls: { 4: '//f/4' } }] } });
    expect(map.get('A')?.url).toBe('https://f/1');
    expect(map.get('B')?.url).toBe('https://f/4');
  });

  it('ignores malformed input', () => {
    const map = new Map<string, EmoteEntry>();
    addFfz(map, null);
    addFfz(map, []);
    addFfz(map, { 1: null });
    addFfz(map, { 1: { emoticons: 'no' } });
    addFfz(map, { 1: { emoticons: [null, { name: 5 }, { name: 'C' }, { name: 'D', urls: {} }] } });
    expect(map.size).toBe(0);
  });
});

describe('buildBadgeMap', () => {
  const globalSets = [{
    set_id: 'moderator',
    versions: [{ id: '1', image_url_2x: 'https://cdn/mod2', title: 'Moderator' }],
  }, {
    set_id: 'subscriber',
    versions: [{ id: '0', image_url_2x: 'https://cdn/subgeneric', title: 'Subscriber' }],
  }];

  it('keys on set and version', () => {
    const map = buildBadgeMap(globalSets);
    expect(map.get('moderator/1')).toEqual({ url: 'https://cdn/mod2', title: 'Moderator' });
  });

  it('lets a channel override the global placeholder', () => {
    // The channel's own sub badge is the one viewers expect to see.
    const channelSets = [{
      set_id: 'subscriber',
      versions: [{ id: '0', image_url_2x: 'https://cdn/channelsub', title: 'Sub' }],
    }];
    const map = buildBadgeMap(globalSets, channelSets);
    expect(map.get('subscriber/0')?.url).toBe('https://cdn/channelsub');
  });

  it('falls back through the image sizes', () => {
    const map = buildBadgeMap([{ set_id: 'a', versions: [{ id: '1', image_url_1x: 'u1' }] }]);
    expect(map.get('a/1')?.url).toBe('u1');
  });

  it('uses the set id when a version has no title', () => {
    const map = buildBadgeMap([{ set_id: 'bits', versions: [{ id: '1', image_url_2x: 'u' }] }]);
    expect(map.get('bits/1')?.title).toBe('bits');
  });

  it('ignores malformed input', () => {
    const map = buildBadgeMap(null, 'no', [null, { set_id: 5 }, { set_id: 'a' }, { set_id: 'b', versions: [null, { id: '1' }] }]);
    expect(map.size).toBe(0);
  });
});
