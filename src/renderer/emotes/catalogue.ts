import type { BadgeEntry, EmoteEntry } from '../sources/types.js';

/**
 * Turning each provider's payload into the two maps the renderer uses.
 *
 * Every provider has a different shape and all of them are third-party, so each
 * builder is written to survive missing or malformed fields rather than trust
 * the response.
 */

export interface GgSmile { k: string; c: number; u: string; g: string }

export function https(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith('//') ? 'https:' + url : url;
}

/* ------------------------------------------------------------- GoodGame ---- */

interface RawGgSmile {
  key?: unknown;
  channel_id?: unknown;
  animated?: unknown;
  images?: { small?: unknown; big?: unknown; gif?: unknown } | null;
}

/** Trim GoodGame's full catalogue (thousands of entries) to what we cache. */
export function normaliseGgCatalogue(raw: unknown): GgSmile[] {
  if (!Array.isArray(raw)) throw new Error('unexpected smiles payload');
  const out: GgSmile[] = [];
  for (const item of raw as RawGgSmile[]) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key ?? '').toLowerCase();
    const images = item.images ?? {};
    // "big" first: GoodGame's "small" is 18px tall, and the overlay draws
    // emotes at around 27px — more on a scaled display — so it arrived visibly
    // soft. "big" is exactly twice that and is published for every smile;
    // "small" stays as the fallback for any that is not.
    const url = https(String(images.big || images.small || '') || null);
    if (!key || !url) continue;
    out.push({
      k: key,
      c: Number(item.channel_id) || 0,
      u: url,
      g: item.animated ? (https(String(images.gif ?? '') || null) ?? '') : '',
    });
  }
  return out;
}

/**
 * `:key:` -> url for one channel.
 * Priority: this channel's own smiles > global > everyone else's, because
 * GoodGame premium users can post smiles from channels they subscribe to.
 */
export function buildGgMap(list: GgSmile[], channelId: string | number): Map<string, EmoteEntry> {
  const cid = Number(channelId) || 0;
  const map = new Map<string, EmoteEntry>();
  const put = (s: GgSmile) => {
    if (map.has(s.k)) return;
    const entry: EmoteEntry = { url: s.g || s.u };
    if (s.g) entry.fallback = s.u;
    map.set(s.k, entry);
  };
  list.filter((s) => s.c === cid).forEach(put);
  list.filter((s) => s.c === 0).forEach(put);
  list.forEach(put);
  return map;
}

/* --------------------------------------------------------- Twitch emotes ---- */

interface SevenTvFile { name?: unknown }
interface SevenTvEmote {
  id?: unknown;
  name?: unknown;
  data?: { host?: { url?: unknown; files?: unknown } | null } | null;
}
export interface SevenTvSet { emotes?: unknown }

export function addSevenTv(map: Map<string, EmoteEntry>, set: unknown): void {
  const s = set as SevenTvSet | null;
  if (!s || !Array.isArray(s.emotes)) return;
  for (const raw of s.emotes as SevenTvEmote[]) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') continue;
    const host = raw.data?.host ?? null;
    const base = host && typeof host.url === 'string'
      ? https(host.url)
      : 'https://cdn.7tv.app/emote/' + String(raw.id);
    if (!base) continue;
    let file = '2x.webp';
    if (host && Array.isArray(host.files)) {
      const names = (host.files as SevenTvFile[]).map((f) => String(f?.name ?? ''));
      const pick = ['2x.webp', '2x.avif', '2x.gif', '2x.png'].find((n) => names.includes(n));
      if (pick) file = pick;
    }
    map.set(raw.name, { url: base + '/' + file });
  }
}

interface BttvEmote { id?: unknown; code?: unknown }

export function addBttv(map: Map<string, EmoteEntry>, arr: unknown): void {
  if (!Array.isArray(arr)) return;
  for (const e of arr as BttvEmote[]) {
    if (!e || typeof e.code !== 'string' || !e.id) continue;
    map.set(e.code, { url: 'https://cdn.betterttv.net/emote/' + String(e.id) + '/2x' });
  }
}

interface FfzEmote { name?: unknown; urls?: Record<string, unknown> | null }

export function addFfz(map: Map<string, EmoteEntry>, sets: unknown): void {
  if (!sets || typeof sets !== 'object' || Array.isArray(sets)) return;
  for (const set of Object.values(sets as Record<string, { emoticons?: unknown }>)) {
    if (!set || !Array.isArray(set.emoticons)) continue;
    for (const e of set.emoticons as FfzEmote[]) {
      if (!e || typeof e.name !== 'string') continue;
      const urls = e.urls ?? {};
      const url = https(String(urls['2'] ?? urls['1'] ?? urls['4'] ?? '') || null);
      if (url) map.set(e.name, { url });
    }
  }
}

/* --------------------------------------------------------- Twitch badges ---- */

interface RawBadgeVersion { id?: unknown; image_url_2x?: unknown; image_url_1x?: unknown; image_url_4x?: unknown; title?: unknown }
interface RawBadgeSet { set_id?: unknown; versions?: unknown }

/**
 * "set/version" -> artwork.
 *
 * Twitch retired the old public badges host and the Helix replacement needs a
 * registered client id, which an anonymous read-only overlay cannot ship. The
 * mirror used here only supplies the mapping; the images are on Twitch's own CDN.
 */
export function buildBadgeMap(...lists: unknown[]): Map<string, BadgeEntry> {
  const map = new Map<string, BadgeEntry>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const set of list as RawBadgeSet[]) {
      if (!set || typeof set.set_id !== 'string' || !Array.isArray(set.versions)) continue;
      for (const v of set.versions as RawBadgeVersion[]) {
        if (!v || typeof v !== 'object') continue;
        const url = String(v.image_url_2x ?? v.image_url_1x ?? v.image_url_4x ?? '');
        if (!url) continue;
        map.set(set.set_id + '/' + String(v.id), {
          url,
          title: typeof v.title === 'string' && v.title ? v.title : set.set_id,
        });
      }
    }
  }
  return map;
}
