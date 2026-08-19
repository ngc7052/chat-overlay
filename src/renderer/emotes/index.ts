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
/**
 * How long a catalogue assembled while a provider was unreachable is kept.
 *
 * A stored entry claims to be the whole catalogue, and the Twitch one is
 * stitched together from six endpoints that fail independently. One flaky
 * minute at the moment a channel connects must not freeze a half — or empty —
 * catalogue in localStorage for six hours, surviving restarts long after every
 * provider recovered. Minutes still spare a quick restart the re-download; only
 * a run where everyone answered earns the full TTL.
 */
export const DEGRADED_TTL_MS = 5 * 60 * 1000;

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
  /** Key -> the download, in flight or settled, so callers share one. */
  const memory = new Map<string, Promise<unknown>>();

  function cacheGet<T>(key: string, maxAgeMs: number): T | null {
    if (!deps.storage) return null;
    try {
      const raw = deps.storage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw) as { t?: unknown; v?: unknown; ttl?: unknown };
      if (!obj || typeof obj.t !== 'number') return null;
      // Entries carry the lifetime they were written with; ones from before
      // that was stored fall back to the caller's.
      const ttl = typeof obj.ttl === 'number' ? obj.ttl : maxAgeMs;
      if (now() - obj.t > ttl) return null;
      return obj.v as T;
    } catch {
      return null;
    }
  }

  function cacheSet(key: string, value: unknown, ttlMs: number): void {
    if (!deps.storage) return;
    try {
      deps.storage.setItem(key, JSON.stringify({ t: now(), v: value, ttl: ttlMs }));
    } catch {
      /* quota — caching is best effort */
    }
  }

  /**
   * One download per key, shared by everyone who asks while it is running.
   *
   * Two channels connecting at the same moment is the normal case on launch,
   * and remembering only the resolved value meant both missed the cache and
   * fetched the whole catalogue. A load that fails is forgotten, so the next
   * caller retries instead of inheriting the failure for the session.
   */
  function once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const running = memory.get(key) as Promise<T> | undefined;
    if (running) return running;
    const started = load().catch((err: unknown) => {
      memory.delete(key);
      throw err;
    });
    memory.set(key, started);
    return started;
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

  /**
   * Store a catalogue for as long as it is worth trusting.
   *
   * `answers` holds what each provider returned, null where it failed. Nobody
   * answering means nothing was learned, so nothing is written at all; a
   * catalogue missing a provider is kept only briefly, so the next launch finds
   * out whether that provider is back.
   */
  function persist(key: string, value: unknown, answers: unknown[], fullTtlMs: number): void {
    const answered = answers.filter((a) => a !== null).length;
    if (!answered) return;
    cacheSet(key, value, answered === answers.length ? fullTtlMs : DEGRADED_TTL_MS);
  }

  function ggCatalogue(): Promise<GgSmile[]> {
    return once('gg', async () => {
      // v2: entries hold the big artwork now, so a v1 cache would keep serving
      // the 18px one for up to twelve hours after the fix landed.
      const cached = cacheGet<GgSmile[]>('gg-smiles-v2', GG_TTL_MS);
      if (cached) return cached;
      const list = normaliseGgCatalogue(await deps.httpJson(URLS.ggSmiles));
      cacheSet('gg-smiles-v2', list, GG_TTL_MS);
      return list;
    });
  }

  function goodgameSmiles(channelId: string): Promise<Map<string, EmoteEntry>> {
    return once('ggmap:' + channelId, async () => buildGgMap(await ggCatalogue(), channelId));
  }

  function twitchThirdParty(roomId: string): Promise<Map<string, EmoteEntry>> {
    const key = 'tw3:' + roomId;
    return once(key, async () => {
      const cached = cacheGet<[string, EmoteEntry][]>(key, TW_TTL_MS);
      if (cached) return new Map(cached);

      const answers = await Promise.all([
        safe(deps.httpJson(URLS.sevenTvGlobal), '7tv global'),
        safe(deps.httpJson(URLS.sevenTvUser(roomId)), '7tv channel'),
        safe(deps.httpJson(URLS.bttvGlobal), 'bttv global'),
        safe(deps.httpJson(URLS.bttvUser(roomId)), 'bttv channel'),
        safe(deps.httpJson(URLS.ffzGlobal), 'ffz global'),
        safe(deps.httpJson(URLS.ffzRoom(roomId)), 'ffz room'),
      ]);
      const [sevenGlobal, sevenUser, bttvGlobal, bttvUser, ffzGlobal, ffzRoom] = answers;

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

      persist(key, Array.from(map.entries()), answers, TW_TTL_MS);
      return map;
    });
  }

  function twitchBadges(roomId: string): Promise<Map<string, BadgeEntry>> {
    const key = 'twbadge:' + roomId;
    return once(key, async () => {
      const cached = cacheGet<[string, BadgeEntry][]>(key, TW_TTL_MS);
      if (cached) return new Map(cached);

      const answers = await Promise.all([
        safe(deps.httpJson(URLS.badgesGlobal), 'badges global'),
        safe(deps.httpJson(URLS.badgesChannel(roomId)), 'badges channel'),
      ]);
      // Channel sub tiers and bits override the global placeholders.
      const map = buildBadgeMap(...answers);

      persist(key, Array.from(map.entries()), answers, TW_TTL_MS);
      return map;
    });
  }

  return { goodgameSmiles, twitchThirdParty, twitchBadges };
}
