'use strict';

/*
 * Emote catalogues.
 *
 *   GoodGame  -> https://goodgame.ru/api/4/smiles/<channelId>   (`:key:` tokens)
 *   Twitch    -> native emotes come inline on each PRIVMSG (`emotes` tag),
 *                third-party ones from 7TV / BTTV / FFZ (whole-word tokens).
 *
 * Every HTTP call goes through the main process (window.overlay.httpJson) so the
 * renderer never has to care about CORS. Results are cached in localStorage.
 */

const Emotes = (() => {
  const MEM = new Map();

  function cacheGet(key, maxAgeMs) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.t !== 'number') return null;
      if (Date.now() - obj.t > maxAgeMs) return null;
      return obj.v;
    } catch (err) {
      return null;
    }
  }

  function cacheSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value }));
    } catch (err) {
      /* quota — caching is best effort */
    }
  }

  function https(url) {
    if (!url) return null;
    return url.startsWith('//') ? 'https:' + url : url;
  }

  /* --------------------------------------------------------------- GoodGame */

  const GG_TTL = 12 * 60 * 60 * 1000;

  /** Fetch the full smile catalogue once; it is shared by every GG channel. */
  async function ggCatalogue() {
    if (MEM.has('gg')) return MEM.get('gg');

    let list = cacheGet('gg-smiles-v1', GG_TTL);
    if (!list) {
      const raw = await window.overlay.httpJson('https://goodgame.ru/api/4/smiles');
      if (!Array.isArray(raw)) throw new Error('unexpected smiles payload');
      list = raw.map((s) => ({
        k: String(s.key || '').toLowerCase(),
        c: Number(s.channel_id) || 0,
        u: https((s.images && (s.images.small || s.images.big)) || ''),
        g: s.animated ? https((s.images && s.images.gif) || '') : '',
      })).filter((s) => s.k && s.u);
      cacheSet('gg-smiles-v1', list);
    }
    MEM.set('gg', list);
    return list;
  }

  /**
   * Build a `:key:` -> url map for one channel.
   * Priority: this channel's own smiles > global smiles > everyone else's
   * (GoodGame premium users can post smiles from channels they subscribe to).
   */
  async function goodgame(channelId) {
    const key = 'ggmap:' + channelId;
    if (MEM.has(key)) return MEM.get(key);

    const list = await ggCatalogue();
    const cid = Number(channelId) || 0;
    const map = new Map();
    const put = (s) => {
      if (!map.has(s.k)) map.set(s.k, { url: s.g || s.u, fallback: s.u });
    };
    list.filter((s) => s.c === cid).forEach(put);
    list.filter((s) => s.c === 0).forEach(put);
    list.forEach(put);

    MEM.set(key, map);
    return map;
  }

  /* ----------------------------------------------------------- Twitch 3rd-party */

  const TW_TTL = 6 * 60 * 60 * 1000;

  async function safe(promise, label, errors) {
    try {
      return await promise;
    } catch (err) {
      errors.push(label + ': ' + err.message);
      return null;
    }
  }

  function addSevenTv(map, set) {
    if (!set || !Array.isArray(set.emotes)) return;
    for (const e of set.emotes) {
      const host = e.data && e.data.host;
      const base = host && host.url ? https(host.url) : 'https://cdn.7tv.app/emote/' + e.id;
      let file = '2x.webp';
      if (host && Array.isArray(host.files)) {
        const pick = host.files.find((f) => f.name === '2x.webp') ||
                     host.files.find((f) => f.name === '2x.avif') ||
                     host.files.find((f) => f.name === '2x.gif') ||
                     host.files.find((f) => f.name === '2x.png');
        if (pick) file = pick.name;
      }
      if (e.name) map.set(e.name, { url: base + '/' + file, provider: '7tv' });
    }
  }

  function addBttv(map, arr) {
    if (!Array.isArray(arr)) return;
    for (const e of arr) {
      if (!e || !e.code || !e.id) continue;
      map.set(e.code, { url: 'https://cdn.betterttv.net/emote/' + e.id + '/2x', provider: 'bttv' });
    }
  }

  function addFfz(map, sets) {
    if (!sets || typeof sets !== 'object') return;
    for (const setKey of Object.keys(sets)) {
      const emoticons = sets[setKey] && sets[setKey].emoticons;
      if (!Array.isArray(emoticons)) continue;
      for (const e of emoticons) {
        const urls = e.urls || {};
        const url = https(urls['2'] || urls['1'] || urls['4']);
        if (e.name && url) map.set(e.name, { url, provider: 'ffz' });
      }
    }
  }

  /** name -> {url} map of 7TV/BTTV/FFZ emotes, global + this channel's. */
  async function twitchThirdParty(roomId) {
    const key = 'tw3:' + roomId;
    if (MEM.has(key)) return MEM.get(key);

    const cached = cacheGet(key, TW_TTL);
    if (cached) {
      const restored = new Map(cached);
      MEM.set(key, restored);
      return restored;
    }

    const errors = [];
    const [sevenGlobal, sevenUser, bttvGlobal, bttvUser, ffzGlobal, ffzRoom] = await Promise.all([
      safe(window.overlay.httpJson('https://7tv.io/v3/emote-sets/global'), '7tv global', errors),
      roomId ? safe(window.overlay.httpJson('https://7tv.io/v3/users/twitch/' + roomId), '7tv channel', errors) : null,
      safe(window.overlay.httpJson('https://api.betterttv.net/3/cached/emotes/global'), 'bttv global', errors),
      roomId ? safe(window.overlay.httpJson('https://api.betterttv.net/3/cached/users/twitch/' + roomId), 'bttv channel', errors) : null,
      safe(window.overlay.httpJson('https://api.frankerfacez.com/v1/set/global'), 'ffz global', errors),
      roomId ? safe(window.overlay.httpJson('https://api.frankerfacez.com/v1/room/id/' + roomId), 'ffz room', errors) : null,
    ]);

    const map = new Map();
    // Globals first, channel emotes last so a channel override wins.
    addSevenTv(map, sevenGlobal);
    addBttv(map, bttvGlobal);
    addFfz(map, ffzGlobal && ffzGlobal.sets);
    if (bttvUser) {
      addBttv(map, bttvUser.sharedEmotes);
      addBttv(map, bttvUser.channelEmotes);
    }
    addFfz(map, ffzRoom && ffzRoom.sets);
    if (sevenUser) addSevenTv(map, sevenUser.emote_set);

    MEM.set(key, map);
    cacheSet(key, Array.from(map.entries()));
    if (errors.length) console.warn('third-party emotes partial:', errors.join('; '));
    return map;
  }

  function twitchNativeUrl(id) {
    return 'https://static-cdn.jtvnw.net/emoticons/v2/' + id + '/default/dark/2.0';
  }

  /* ------------------------------------------------------------ Twitch badges */

  /**
   * "set/version" -> {url, title} for the real Twitch badge artwork.
   *
   * Twitch retired the old public badges.twitch.tv host (it no longer resolves)
   * and the Helix replacement needs a registered client id + token, which an
   * anonymous read-only overlay cannot ship. IVR is a public unauthenticated
   * mirror; the images it points at are still on Twitch's own CDN.
   */
  async function twitchBadges(roomId) {
    const key = 'twbadge:' + (roomId || 'global');
    if (MEM.has(key)) return MEM.get(key);

    const cached = cacheGet(key, TW_TTL);
    if (cached) {
      const restored = new Map(cached);
      MEM.set(key, restored);
      return restored;
    }

    const errors = [];
    const [global, channel] = await Promise.all([
      safe(window.overlay.httpJson('https://api.ivr.fi/v2/twitch/badges/global'), 'badges global', errors),
      roomId
        ? safe(window.overlay.httpJson('https://api.ivr.fi/v2/twitch/badges/channel?id=' + roomId), 'badges channel', errors)
        : null,
    ]);

    const map = new Map();
    const add = (list) => {
      if (!Array.isArray(list)) return;
      for (const set of list) {
        if (!set || !set.set_id || !Array.isArray(set.versions)) continue;
        for (const v of set.versions) {
          const url = v.image_url_2x || v.image_url_1x || v.image_url_4x;
          if (url) map.set(set.set_id + '/' + v.id, { url, title: v.title || set.set_id });
        }
      }
    };
    add(global);
    add(channel);   // channel sub tiers / bits override the global placeholders

    MEM.set(key, map);
    cacheSet(key, Array.from(map.entries()));
    if (errors.length) console.warn('twitch badges partial:', errors.join('; '));
    return map;
  }

  return { goodgame, twitchThirdParty, twitchNativeUrl, twitchBadges };
})();

window.Emotes = Emotes;
