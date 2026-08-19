import { describe, expect, it, vi } from 'vitest';
import { createAssetApi, DEGRADED_TTL_MS, GG_TTL_MS, TW_TTL_MS, URLS } from '../../src/renderer/emotes/index.js';
import type { StorageLike } from '../../src/renderer/emotes/index.js';

function memoryStorage(seed: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? (data[k] as string) : null),
    setItem: (k, v) => { data[k] = v; },
  };
}

const ggPayload = [{ key: 'peka', channel_id: 0, images: { small: '//gg/peka.png' } }];

function httpFor(map: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    if (url in map) return map[url];
    throw new Error('unexpected url ' + url);
  });
}

describe('goodgameSmiles', () => {
  it('fetches, trims and maps the catalogue', async () => {
    const httpJson = httpFor({ [URLS.ggSmiles]: ggPayload });
    const api = createAssetApi({ httpJson });
    const map = await api.goodgameSmiles('5');
    expect(map.get('peka')).toEqual({ url: 'https://gg/peka.png' });
  });

  it('only fetches once, however many channels ask', async () => {
    const httpJson = httpFor({ [URLS.ggSmiles]: ggPayload });
    const api = createAssetApi({ httpJson });
    await api.goodgameSmiles('5');
    await api.goodgameSmiles('9');
    await api.goodgameSmiles('5');
    expect(httpJson).toHaveBeenCalledTimes(1);
  });

  it('reuses a cached catalogue instead of downloading megabytes again', async () => {
    const storage = memoryStorage();
    const httpJson = httpFor({ [URLS.ggSmiles]: ggPayload });
    await createAssetApi({ httpJson, storage }).goodgameSmiles('5');
    expect(httpJson).toHaveBeenCalledTimes(1);

    const second = httpFor({ [URLS.ggSmiles]: ggPayload });
    const map = await createAssetApi({ httpJson: second, storage }).goodgameSmiles('5');
    expect(second).not.toHaveBeenCalled();
    expect(map.get('peka')).toBeDefined();
  });

  it('refetches once the cache has aged out', async () => {
    const storage = memoryStorage();
    let now = 1_000_000;
    const httpJson = httpFor({ [URLS.ggSmiles]: ggPayload });
    await createAssetApi({ httpJson, storage, now: () => now }).goodgameSmiles('5');

    now += GG_TTL_MS + 1;
    const second = httpFor({ [URLS.ggSmiles]: ggPayload });
    await createAssetApi({ httpJson: second, storage, now: () => now }).goodgameSmiles('5');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('ignores a corrupt or malformed cache entry', async () => {
    const httpJson = httpFor({ [URLS.ggSmiles]: ggPayload });
    const storage = memoryStorage({ 'gg-smiles-v2': 'not json' });
    await createAssetApi({ httpJson, storage }).goodgameSmiles('5');
    expect(httpJson).toHaveBeenCalledTimes(1);

    const httpJson2 = httpFor({ [URLS.ggSmiles]: ggPayload });
    const storage2 = memoryStorage({ 'gg-smiles-v2': JSON.stringify({ v: [] }) });
    await createAssetApi({ httpJson: httpJson2, storage: storage2 }).goodgameSmiles('5');
    expect(httpJson2).toHaveBeenCalledTimes(1);
  });

  it('survives storage that refuses to write', async () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceeded'); },
    };
    const api = createAssetApi({ httpJson: httpFor({ [URLS.ggSmiles]: ggPayload }), storage });
    await expect(api.goodgameSmiles('5')).resolves.toBeInstanceOf(Map);
  });

  it('works with no storage at all', async () => {
    const api = createAssetApi({ httpJson: httpFor({ [URLS.ggSmiles]: ggPayload }), storage: null });
    await expect(api.goodgameSmiles('5')).resolves.toBeInstanceOf(Map);
  });

  it('downloads the catalogue once when two channels connect at the same moment', async () => {
    const httpJson = httpFor({ [URLS.ggSmiles]: ggPayload });
    const api = createAssetApi({ httpJson });
    const [first, second] = await Promise.all([api.goodgameSmiles('5'), api.goodgameSmiles('9')]);
    expect(httpJson).toHaveBeenCalledTimes(1);
    expect(first.get('peka')).toBeDefined();
    expect(second.get('peka')).toBeDefined();
  });

  it('retries after a failed download instead of remembering the failure', async () => {
    let offline = true;
    const httpJson = vi.fn(async () => {
      if (offline) throw new Error('offline');
      return ggPayload;
    });
    const api = createAssetApi({ httpJson });
    await expect(api.goodgameSmiles('5')).rejects.toThrow('offline');

    offline = false;
    await expect(api.goodgameSmiles('5')).resolves.toEqual(expect.any(Map));
    expect((await api.goodgameSmiles('5')).get('peka')).toBeDefined();
  });
});

describe('twitchThirdParty', () => {
  const urls = (id: string) => ({
    [URLS.sevenTvGlobal]: { emotes: [{ id: 'g', name: 'GlobalSeven' }] },
    [URLS.sevenTvUser(id)]: { emote_set: { emotes: [{ id: 'c', name: 'ChannelSeven' }] } },
    [URLS.bttvGlobal]: [{ id: 'bg', code: 'BttvGlobal' }],
    [URLS.bttvUser(id)]: { sharedEmotes: [{ id: 'bs', code: 'BttvShared' }], channelEmotes: [{ id: 'bc', code: 'BttvChannel' }] },
    [URLS.ffzGlobal]: { sets: { 1: { emoticons: [{ name: 'FfzGlobal', urls: { 2: '//f/2' } }] } } },
    [URLS.ffzRoom(id)]: { sets: { 2: { emoticons: [{ name: 'FfzRoom', urls: { 2: '//f/r' } }] } } },
  });

  it('merges every provider', async () => {
    const api = createAssetApi({ httpJson: httpFor(urls('42')) });
    const map = await api.twitchThirdParty('42');
    for (const name of ['GlobalSeven', 'ChannelSeven', 'BttvGlobal', 'BttvShared', 'BttvChannel', 'FfzGlobal', 'FfzRoom']) {
      expect(map.has(name), name).toBe(true);
    }
  });

  it('carries on when a provider is down', async () => {
    const warnings: string[] = [];
    const partial = { ...urls('42') };
    delete (partial as Record<string, unknown>)[URLS.bttvGlobal];
    const api = createAssetApi({ httpJson: httpFor(partial), onWarn: (m) => warnings.push(m) });
    const map = await api.twitchThirdParty('42');
    expect(map.has('GlobalSeven')).toBe(true);
    expect(warnings.some((w) => w.startsWith('bttv global:'))).toBe(true);
  });

  it('caches per channel', async () => {
    const storage = memoryStorage();
    const httpJson = httpFor(urls('42'));
    await createAssetApi({ httpJson, storage }).twitchThirdParty('42');
    const calls = httpJson.mock.calls.length;

    const second = httpFor(urls('42'));
    const map = await createAssetApi({ httpJson: second, storage }).twitchThirdParty('42');
    expect(second).not.toHaveBeenCalled();
    expect(map.has('GlobalSeven')).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });

  it('serves a second call from memory', async () => {
    const httpJson = httpFor(urls('42'));
    const api = createAssetApi({ httpJson });
    await api.twitchThirdParty('42');
    const calls = httpJson.mock.calls.length;
    await api.twitchThirdParty('42');
    expect(httpJson.mock.calls.length).toBe(calls);
  });

  it('refetches after the cache expires', async () => {
    const storage = memoryStorage();
    let now = 5_000;
    await createAssetApi({ httpJson: httpFor(urls('42')), storage, now: () => now }).twitchThirdParty('42');
    now += TW_TTL_MS + 1;
    const second = httpFor(urls('42'));
    await createAssetApi({ httpJson: second, storage, now: () => now }).twitchThirdParty('42');
    expect(second).toHaveBeenCalled();
  });

  it('fetches each provider once when a room is asked for twice at once', async () => {
    const httpJson = httpFor(urls('42'));
    const api = createAssetApi({ httpJson });
    const [a, b] = await Promise.all([api.twitchThirdParty('42'), api.twitchThirdParty('42')]);
    expect(httpJson).toHaveBeenCalledTimes(6);   // one per endpoint, not two
    expect(a).toBe(b);
  });

  it('does not persist a catalogue assembled while every provider was down', async () => {
    const storage = memoryStorage();
    const down = httpFor({});
    const empty = await createAssetApi({ httpJson: down, storage }).twitchThirdParty('123');
    expect(empty.size).toBe(0);
    expect(Object.keys(storage.data)).toEqual([]);

    // Providers back, app restarted: the emotes must return, not the outage.
    const back = httpFor(urls('123'));
    const map = await createAssetApi({ httpJson: back, storage }).twitchThirdParty('123');
    expect(map.has('GlobalSeven')).toBe(true);
    expect(map.has('BttvGlobal')).toBe(true);
  });

  it('keeps a catalogue missing a provider for minutes, not hours', async () => {
    const storage = memoryStorage();
    let now = 1_000;
    const partial = { ...urls('42') };
    delete (partial as Record<string, unknown>)[URLS.sevenTvGlobal];
    const first = await createAssetApi({ httpJson: httpFor(partial), storage, now: () => now })
      .twitchThirdParty('42');
    expect(first.has('GlobalSeven')).toBe(false);
    expect(storage.data['tw3:42']).toBeDefined();

    // A restart moments later is still served what we had.
    now += DEGRADED_TTL_MS - 1;
    const soon = httpFor(urls('42'));
    const kept = await createAssetApi({ httpJson: soon, storage, now: () => now }).twitchThirdParty('42');
    expect(soon).not.toHaveBeenCalled();
    expect(kept.has('BttvGlobal')).toBe(true);

    // Minutes later — nowhere near the six hours a complete catalogue would
    // have earned — 7TV is tried again, and its emotes come back.
    now += 2;
    const later = httpFor(urls('42'));
    const healed = await createAssetApi({ httpJson: later, storage, now: () => now }).twitchThirdParty('42');
    expect(later).toHaveBeenCalled();
    expect(healed.has('GlobalSeven')).toBe(true);
  });

  it('honours an entry written before lifetimes were stored', async () => {
    const storage = memoryStorage({
      'tw3:42': JSON.stringify({ t: 1_000, v: [['OldEmote', { url: 'https://cdn/old' }]] }),
    });
    const httpJson = httpFor(urls('42'));
    const api = createAssetApi({ httpJson, storage, now: () => 1_000 + TW_TTL_MS });
    const map = await api.twitchThirdParty('42');
    expect(httpJson).not.toHaveBeenCalled();
    expect(map.get('OldEmote')?.url).toBe('https://cdn/old');
  });
});

describe('twitchBadges', () => {
  const badgeUrls = (id: string) => ({
    [URLS.badgesGlobal]: [{ set_id: 'moderator', versions: [{ id: '1', image_url_2x: 'https://cdn/mod' }] }],
    [URLS.badgesChannel(id)]: [{ set_id: 'subscriber', versions: [{ id: '0', image_url_2x: 'https://cdn/sub' }] }],
  });

  it('merges global and channel artwork', async () => {
    const api = createAssetApi({ httpJson: httpFor(badgeUrls('42')) });
    const map = await api.twitchBadges('42');
    expect(map.get('moderator/1')?.url).toBe('https://cdn/mod');
    expect(map.get('subscriber/0')?.url).toBe('https://cdn/sub');
  });

  it('caches, then serves from memory and storage', async () => {
    const storage = memoryStorage();
    const httpJson = httpFor(badgeUrls('42'));
    const api = createAssetApi({ httpJson, storage });
    await api.twitchBadges('42');
    await api.twitchBadges('42');
    expect(httpJson).toHaveBeenCalledTimes(2);   // one per endpoint, once only

    const second = httpFor(badgeUrls('42'));
    const map = await createAssetApi({ httpJson: second, storage }).twitchBadges('42');
    expect(second).not.toHaveBeenCalled();
    expect(map.size).toBe(2);
  });

  it('still returns the global set when the channel lookup fails', async () => {
    const warnings: string[] = [];
    const partial = { ...badgeUrls('42') };
    delete (partial as Record<string, unknown>)[URLS.badgesChannel('42')];
    const api = createAssetApi({ httpJson: httpFor(partial), onWarn: (m) => warnings.push(m) });
    const map = await api.twitchBadges('42');
    expect(map.has('moderator/1')).toBe(true);
    expect(warnings.some((w) => w.startsWith('badges channel:'))).toBe(true);
  });

  it('stays quiet when no warning handler is supplied', async () => {
    const api = createAssetApi({ httpJson: httpFor({}) });
    await expect(api.twitchBadges('42')).resolves.toBeInstanceOf(Map);
  });

  it('asks the mirror once when a room is requested twice at once', async () => {
    const httpJson = httpFor(badgeUrls('42'));
    const api = createAssetApi({ httpJson });
    await Promise.all([api.twitchBadges('42'), api.twitchBadges('42')]);
    expect(httpJson).toHaveBeenCalledTimes(2);   // one per endpoint, not four
  });

  it('does not persist badge artwork fetched while the mirror was down', async () => {
    const storage = memoryStorage();
    const empty = await createAssetApi({ httpJson: httpFor({}), storage }).twitchBadges('42');
    expect(empty.size).toBe(0);
    expect(Object.keys(storage.data)).toEqual([]);

    const back = httpFor(badgeUrls('42'));
    const map = await createAssetApi({ httpJson: back, storage }).twitchBadges('42');
    expect(map.get('moderator/1')?.url).toBe('https://cdn/mod');
  });

  it('keeps badges missing the channel set for minutes, not hours', async () => {
    const storage = memoryStorage();
    let now = 1_000;
    const partial = { ...badgeUrls('42') };
    delete (partial as Record<string, unknown>)[URLS.badgesChannel('42')];
    await createAssetApi({ httpJson: httpFor(partial), storage, now: () => now }).twitchBadges('42');

    now += DEGRADED_TTL_MS + 1;
    const later = httpFor(badgeUrls('42'));
    const map = await createAssetApi({ httpJson: later, storage, now: () => now }).twitchBadges('42');
    expect(map.get('subscriber/0')?.url).toBe('https://cdn/sub');
  });
});
