import type { AssetApi, BadgeEntry, EmoteEntry, HttpJson } from '../sources/types.js';
import {
  addBttv, addFfz, addSevenTv, buildBadgeMap, buildGgMap, normaliseGgCatalogue, type GgSmile,
} from './catalogue.js';

/**
 * Fetching and caching the emote/badge catalogues.
 *
 * Every request goes through the main process (httpJson) so the renderer never
 * has to care about CORS, and results are cached so switching channels or
 * restarting does not re-download several megabytes of smile definitions.
 */

export const GG_TTL_MS = 12 * 60 * 60 * 1000;
export const TW_TTL_MS = 6 * 60 * 60 * 1000;

export const URLS = {
  ggSmiles: 'https://goodgame.ru/api/4/smiles',
  sevenTvGlobal: 'https://7tv.io/v3/emote-sets/global',
  sevenTvUser: (id: string) => 'https://7tv.io/v3/users/twitch/' + id,
  bttvGlobal: 'https://api.betterttv.net/3/cached/emotes/global',
  bttvUser: (id: string) => 'https://api.betterttv.net/3/cached/users/twitch/' + id,
  ffzGlobal: 'https://api.frankerfacez.com/v1/set/global',
  ffzRoom: (id: string) => 'https://api.frankerfacez.com/v1/room/id/' + id,
  badgesGlobal: 'https://api.ivr.fi/v2/twitch/badges/global',
  badgesChannel: (id: string) => 'https://api.ivr.fi/v2/twitch/badges/channel?id=' + id,
};

/** The slice of localStorage we use, so tests can pass a plain object. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AssetDeps {
  httpJson: HttpJson;
  storage?: StorageLike | null;
  now?: () => number;
  onWarn?: (message: string) => void;
}

export function createAssetApi(deps: AssetDeps): AssetApi {
  const now = deps.now ?? Date.now;
  const warn = deps.onWarn ?? (() => {});
  const memory = new Map<string, unknown>();

  function cacheGet<T>(key: string, maxAgeMs: number): T | null {
    if (!deps.storage) return null;
    try {
      const raw = deps.storage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw) as { t?: unknown; v?: unknown };
      if (!obj || typeof obj.t !== 'number') return null;
      if (now() - obj.t > maxAgeMs) return null;
      return obj.v as T;
    } catch {
      return null;
    }
  }

  function cacheSet(key: string, value: unknown): void {
    if (!deps.storage) return;
    try {
      deps.storage.setItem(key, JSON.stringify({ t: now(), v: value }));
    } catch {
      /* quota — caching is best effort */
    }
  }

  /** Never let one provider being down lose the others. */
  async function safe<T>(p: Promise<T>, label: string): Promise<T | null> {
    try {
      return await p;
    } catch (err) {
      warn(label + ': ' + (err as Error).message);
      return null;
    }
  }

  async function ggCatalogue(): Promise<GgSmile[]> {
    const cachedMemory = memory.get('gg') as GgSmile[] | undefined;
    if (cachedMemory) return cachedMemory;

    // v2: entries hold the big artwork now, so a v1 cache would keep serving
    // the 18px one for up to twelve hours after the fix landed.
    let list = cacheGet<GgSmile[]>('gg-smiles-v2', GG_TTL_MS);
    if (!list) {
      list = normaliseGgCatalogue(await deps.httpJson(URLS.ggSmiles));
      cacheSet('gg-smiles-v2', list);
    }
    memory.set('gg', list);
    return list;
  }

  async function goodgameSmiles(channelId: string): Promise<Map<string, EmoteEntry>> {
    const key = 'ggmap:' + channelId;
    const cached = memory.get(key) as Map<string, EmoteEntry> | undefined;
    if (cached) return cached;
    const map = buildGgMap(await ggCatalogue(), channelId);
    memory.set(key, map);
    return map;
  }

  async function twitchThirdParty(roomId: string): Promise<Map<string, EmoteEntry>> {
    const key = 'tw3:' + roomId;
    const cachedMemory = memory.get(key) as Map<string, EmoteEntry> | undefined;
    if (cachedMemory) return cachedMemory;

    const cached = cacheGet<[string, EmoteEntry][]>(key, TW_TTL_MS);
    if (cached) {
      const restored = new Map(cached);
      memory.set(key, restored);
      return restored;
    }

    const [sevenGlobal, sevenUser, bttvGlobal, bttvUser, ffzGlobal, ffzRoom] = await Promise.all([
      safe(deps.httpJson(URLS.sevenTvGlobal), '7tv global'),
      safe(deps.httpJson(URLS.sevenTvUser(roomId)), '7tv channel'),
      safe(deps.httpJson(URLS.bttvGlobal), 'bttv global'),
      safe(deps.httpJson(URLS.bttvUser(roomId)), 'bttv channel'),
      safe(deps.httpJson(URLS.ffzGlobal), 'ffz global'),
      safe(deps.httpJson(URLS.ffzRoom(roomId)), 'ffz room'),
    ]);

    const map = new Map<string, EmoteEntry>();
    // Globals first, channel emotes last so a channel override wins.
    addSevenTv(map, sevenGlobal);
    addBttv(map, bttvGlobal);
    addFfz(map, (ffzGlobal as { sets?: unknown } | null)?.sets);
    const user = bttvUser as { sharedEmotes?: unknown; channelEmotes?: unknown } | null;
    if (user) {
      addBttv(map, user.sharedEmotes);
      addBttv(map, user.channelEmotes);
    }
    addFfz(map, (ffzRoom as { sets?: unknown } | null)?.sets);
    addSevenTv(map, (sevenUser as { emote_set?: unknown } | null)?.emote_set);

    memory.set(key, map);
    cacheSet(key, Array.from(map.entries()));
    return map;
  }

  async function twitchBadges(roomId: string): Promise<Map<string, BadgeEntry>> {
    const key = 'twbadge:' + roomId;
    const cachedMemory = memory.get(key) as Map<string, BadgeEntry> | undefined;
    if (cachedMemory) return cachedMemory;

    const cached = cacheGet<[string, BadgeEntry][]>(key, TW_TTL_MS);
    if (cached) {
      const restored = new Map(cached);
      memory.set(key, restored);
      return restored;
    }

    const [globalSets, channelSets] = await Promise.all([
      safe(deps.httpJson(URLS.badgesGlobal), 'badges global'),
      safe(deps.httpJson(URLS.badgesChannel(roomId)), 'badges channel'),
    ]);
    // Channel sub tiers and bits override the global placeholders.
    const map = buildBadgeMap(globalSets, channelSets);

    memory.set(key, map);
    cacheSet(key, Array.from(map.entries()));
    return map;
  }

  return { goodgameSmiles, twitchThirdParty, twitchBadges };
}
