/**
 * A stand-in for Twitch and GoodGame, so end-to-end runs are reproducible.
 *
 * Speaks both chat protocols for real — IRC-over-WebSocket with tags, and
 * GoodGame's JSON frames — and serves fixed emote/badge fixtures over HTTP. The
 * app is pointed at it with OVERLAY_TWITCH_WS / OVERLAY_GOODGAME_WS /
 * OVERLAY_TEST_API_BASE and is otherwise completely unmodified: the same
 * parsing, the same rendering, the same sockets.
 *
 * Nothing here depends on somebody being live, so a run either passes or has
 * found a bug.
 */
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { WebSocketServer } from 'ws';

const GG_CHANNEL_ID = '4242';

/* ------------------------------------------------------------- fixtures ---- */

/** Every image is served by this server too, so a run needs no network at all. */
const fixtures = (origin) => ({
  badgesGlobal: [
    { set_id: 'moderator', versions: [{ id: '1', image_url_2x: `${origin}/img/mod.png`, title: 'Moderator' }] },
    { set_id: 'vip', versions: [{ id: '1', image_url_2x: `${origin}/img/vip.png`, title: 'VIP' }] },
    { set_id: 'broadcaster', versions: [{ id: '1', image_url_2x: `${origin}/img/host.png`, title: 'Broadcaster' }] },
  ],
  badgesChannel: [
    { set_id: 'subscriber', versions: [{ id: '12', image_url_2x: `${origin}/img/sub.png`, title: 'Subscriber' }] },
  ],
  sevenTvGlobal: {
    emotes: [
      { id: 'catjam', name: 'catJAM', data: { host: { url: `${origin}/img`, files: [{ name: 'catjam.png' }] } } },
      { id: 'pogu', name: 'PogU', data: { host: { url: `${origin}/img`, files: [{ name: 'pogu.png' }] } } },
    ],
  },
  ggSmiles: [
    { key: 'pekaclap', channel_id: 0, animated: 0, images: { small: `${origin}/img/peka.png` } },
    { key: 'sing', channel_id: 0, animated: 0, images: { small: `${origin}/img/sing.png` } },
  ],
});

/**
 * A 24x24 PNG drawn from a shape, so demo badges and emotes read as icons
 * rather than flat blocks. Generated here so the repo carries no binary
 * fixtures and a run is byte-for-byte reproducible.
 *
 * These are deliberately generic glyphs, not imitations of anyone's artwork.
 */
function iconPng([r, g, b], shape) {
  const size = 24, mid = (size - 1) / 2;
  const px = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const dx = x - mid, dy = y - mid;
      let inside = false;
      if (shape === 'circle') inside = dx * dx + dy * dy <= 100;
      else if (shape === 'diamond') inside = Math.abs(dx) + Math.abs(dy) <= 10.5;
      else if (shape === 'rounded') {
        const ox = Math.max(Math.abs(dx) - 5, 0), oy = Math.max(Math.abs(dy) - 5, 0);
        inside = Math.hypot(ox, oy) <= 5.5;
      } else if (shape === 'face') {
        // A round face with eyes and a mouth, so demo emotes read as emotes
        // rather than as coloured dots.
        const inCircle = dx * dx + dy * dy <= 110;
        const eye = (ex) => (dx - ex) ** 2 + (dy + 2.5) ** 2 <= 3.2;
        const mouth = dy > 2 && dy < 5 && Math.abs(dx) < 5 && dx * dx + (dy - 1) * (dy - 1) > 9;
        inside = inCircle && !eye(-3.4) && !eye(3.4) && !mouth;
      } else if (shape === 'star') {
        const ang = Math.atan2(dy, dx);
        const rad = 6.5 + 4 * Math.cos(5 * ang);
        inside = Math.hypot(dx, dy) <= rad;
      }
      // A lighter core gives the glyph some shape instead of a solid blob.
      const core = Math.hypot(dx, dy) <= 3.2;
      if (!inside) row.push(0, 0, 0, 0);
      else if (core) row.push(Math.min(255, r + 70), Math.min(255, g + 70), Math.min(255, b + 70), 255);
      else row.push(r, g, b, 255);
    }
    px.push(Buffer.from(row));
  }
  const raw = Buffer.concat(px);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const IMAGES = {
  'mod.png': [[47, 168, 79], 'rounded'],
  'vip.png': [[224, 90, 168], 'diamond'],
  'host.png': [[230, 57, 70], 'circle'],
  'sub.png': [[111, 140, 255], 'star'],
  'catjam.png': [[250, 204, 21], 'face'],
  'pogu.png': [[147, 197, 253], 'face'],
  'peka.png': [[250, 204, 21], 'face'],
  'sing.png': [[250, 204, 21], 'face'],
};

/**
 * The transcripts the fake server replays.
 *
 * Every name here is invented. Earlier drafts used handles observed on real
 * channels, which is not something to put in a public README.
 *
 * Twitch talks English and GoodGame talks Russian, because that is what those
 * chats actually look like and a demo should not pretend otherwise.
 */
export const TWITCH_SCRIPT = [
  { at: 200, user: 'Halcyon_TV', color: '#FF7F50', badges: 'broadcaster/1', text: 'one more run and then we call it' },
  { at: 900, user: 'pixel_wraith', color: '#1E90FF', badges: 'subscriber/12', text: 'catJAM catJAM' },
  { at: 1600, user: 'mossy_toad', color: '#2FA84F', badges: '', text: 'that jump was frame perfect' },
  { at: 2300, user: 'LedgerBot', color: '#5F9EA0', badges: 'moderator/1', text: 'pixel_wraith has been here 14 months' },
  { at: 3000, user: 'quietstorm', color: '#DA70D6', badges: 'vip/1', text: 'PogU no way' },
  { at: 3700, user: 'BitCrusher88', color: '#0000FF', badges: '', text: 'dark blue name, still readable' },
  { at: 4400, user: 'orbital_cat', color: '#E6A400', badges: 'subscriber/12', text: 'chat is flying today' },
  { at: 5100, user: 'dust_devil', color: '#8A2BE2', badges: '', text: 'clip that' },
  { at: 5800, user: 'pixel_wraith', color: '#1E90FF', badges: 'subscriber/12', text: 'https://example.com/clip' },
  { at: 6500, user: 'NovaKestrel', color: '#20B2AA', badges: '', text: 'first time catching this live' },
  { at: 7200, user: 'quietstorm', color: '#DA70D6', badges: 'vip/1', text: 'PogU' },
  { at: 7900, user: 'mossy_toad', color: '#2FA84F', badges: '', text: 'how many attempts was that' },
  { at: 8600, user: 'Halcyon_TV', color: '#FF7F50', badges: 'broadcaster/1', text: 'forty one. i counted' },
  { at: 9300, user: 'orbital_cat', color: '#E6A400', badges: 'subscriber/12', text: 'catJAM' },
  { at: 10000, user: 'dust_devil', color: '#8A2BE2', badges: '', text: 'worth every one of them' },
  { at: 10700, user: 'Halcyon_TV', color: '#FF7F50', badges: 'broadcaster/1', text: 'thanks for hanging about, all' },
];

export const GOODGAME_SCRIPT = [
  { at: 400, user: 'Ветродуй', color: 'streamer', rights: 20, icon: 'eagle', text: 'так, ещё один заход и заканчиваем' },
  { at: 1100, user: 'КотБаюн', color: 'simple', icon: 'star', premium: 1, resub: 2, text: 'ну наконец-то :pekaclap:' },
  { at: 1800, user: 'Сумрак77', color: 'simple', text: 'вот это реакция конечно :pekaclap:' },
  { at: 2500, user: 'Печенька', color: 'premium-personal', premium: 1, icon: 'cup', text: 'я аж подпрыгнула :sing:' },
  { at: 3200, user: 'ЛунныйЗаяц', color: 'simple', text: 'сколько попыток было?' },
  { at: 3900, user: 'Ветродуй', color: 'streamer', rights: 20, icon: 'eagle', text: 'сорок одна, я считал' },
  { at: 4600, user: 'ГрозаМорей', color: 'simple', icon: 'star', premium: 1, ggPlus: 12, resub: 5, text: 'терпение и труд :sing:' },
  { at: 5300, user: 'Сумрак77', color: 'simple', text: 'красиво прошёл, без единой ошибки' },
  { at: 6000, user: 'Тихоня', color: 'simple', text: 'первый раз смотрю вживую' },
  { at: 6700, user: 'КотБаюн', color: 'simple', icon: 'star', premium: 1, resub: 2, text: 'клип обязательно' },
  { at: 7400, user: 'Печенька', color: 'premium-personal', premium: 1, icon: 'cup', text: 'https://example.com/клип' },
  { at: 8100, user: 'ЛунныйЗаяц', color: 'simple', text: 'подписался, спасибо за стрим :sing:' },
  { at: 8800, user: 'ГрозаМорей', color: 'simple', icon: 'star', premium: 1, ggPlus: 12, text: 'до завтра, всем добра!' },
  { at: 9500, user: 'Ветродуй', color: 'streamer', rights: 20, icon: 'eagle', text: 'всем спасибо, что были рядом' },
];

/** Both, interleaved — what the assertion run uses. */
export const SCRIPT = [
  ...TWITCH_SCRIPT.map((m) => ({ ...m, platform: 'twitch' })),
  ...GOODGAME_SCRIPT.map((m) => ({ ...m, platform: 'goodgame' })),
].sort((a, b) => a.at - b.at);

/* ---------------------------------------------------------------- server ---- */

export async function startFakeChat({ port = 0, script = SCRIPT, loop = false, only = null } = {}) {
  if (only) script = script.filter((m) => m.platform === only);
  let fx = null;
  const http = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/files/icons/')) {
      // Stand-in for a channel's own subscriber artwork: coloured per tier, the
      // way real GoodGame channels ship one image per tier.
      const tier = Number((/-(\d+)-48\.png$/.exec(url.pathname) || [])[1]) || 1;
      const palette = [[255, 179, 71], [244, 114, 182], [96, 165, 250], [52, 211, 153],
                       [251, 113, 133], [167, 139, 250], [250, 204, 21]];
      const png = iconPng(palette[(tier - 1) % palette.length], 'star');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    if (url.pathname.startsWith('/gg-icons/')) {
      // Fill-less white glyphs, exactly like GoodGame's, and distinct per name
      // so a demo does not show the same shape three times.
      const name = url.pathname.slice('/gg-icons/'.length);
      const paths = {
        star: 'M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z',
        cup: 'M7 3h10v3h3a3 3 0 0 1-3 3h-.4A5 5 0 0 1 13 12.9V16h3v3H8v-3h3v-3.1A5 5 0 0 1 7.4 9H7a3 3 0 0 1-3-3h3V3z',
        eagle: 'M12 3l4 4 5-1-3 4 3 3-5 1-2 7-2-4-2 4-2-7-5-1 3-3-3-4 5 1z',
        plus: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm1 4h-2v4H7v2h4v4h2v-4h4v-2h-4z',
      };
      const key = name.startsWith('gg-') ? 'plus'
        : name.startsWith('Cup') ? 'cup'
        : name.startsWith('Eagle') ? 'eagle'
        : 'star';
      const svg = '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
        `<path fill="white" d="${paths[key]}"/></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(svg);
    }
    if (url.pathname.startsWith('/img/')) {
      const [rgb, shape] = IMAGES[url.pathname.slice(5)] || [[128, 128, 128], 'circle'];
      const png = iconPng(rgb, shape);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    const send = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/getchannelstatus') {
      return send({ [GG_CHANNEL_ID]: { stream_id: Number(GG_CHANNEL_ID), key: url.searchParams.get('id'), status: 'Live' } });
    }
    if (url.pathname === '/api/4/smiles') return send(fx.ggSmiles);
    if (url.pathname === '/v3/emote-sets/global') return send(fx.sevenTvGlobal);
    if (url.pathname.startsWith('/v3/users/twitch/')) return send({ emote_set: { emotes: [] } });
    if (url.pathname === '/3/cached/emotes/global') return send([]);
    if (url.pathname.startsWith('/3/cached/users/twitch/')) return send({ channelEmotes: [], sharedEmotes: [] });
    if (url.pathname === '/v1/set/global') return send({ sets: {} });
    if (url.pathname.startsWith('/v1/room/id/')) return send({ sets: {} });
    if (url.pathname === '/v2/twitch/badges/global') return send(fx.badgesGlobal);
    if (url.pathname === '/v2/twitch/badges/channel') return send(fx.badgesChannel);
    res.writeHead(404).end('{}');
  });

  await new Promise((resolve) => http.listen(port, '127.0.0.1', resolve));
  const actualPort = http.address().port;
  fx = fixtures(`http://127.0.0.1:${actualPort}`);

  const wss = new WebSocketServer({ server: http });
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(fn, ms);
    timers.add(t);
    return t;
  };

  wss.on('connection', (ws, req) => {
    const isGoodGame = (req.url || '').includes('chat2');
    if (isGoodGame) return runGoodGame(ws);
    return runTwitch(ws);
  });

  function replay(send) {
    const run = (offset) => {
      for (const line of script) later(() => send(line), offset + line.at);
    };
    run(0);
    if (loop) {
      const span = script[script.length - 1].at + 1500;
      for (let i = 1; i < 20; i++) run(span * i);
    }
  }

  function runTwitch(ws) {
    let channel = 'channel';
    ws.on('message', (raw) => {
      for (const line of String(raw).split('\r\n')) {
        if (line.startsWith('NICK')) {
          ws.send(':tmi.twitch.tv CAP * ACK :twitch.tv/tags twitch.tv/commands\r\n');
          ws.send(':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!\r\n');
        }
        if (line.startsWith('JOIN')) {
          channel = line.split('#')[1] || 'channel';
          ws.send(`@emote-only=0;room-id=71092938 :tmi.twitch.tv ROOMSTATE #${channel}\r\n`);
          replay((m) => {
            if (m.platform !== 'twitch') return;
            const id = 'msg-' + Math.random().toString(36).slice(2, 10);
            // catJAM/PogU are third-party; a native emote is sent by range.
            const emotes = m.text.includes('Kappa') ? 'emotes=25:0-4;' : 'emotes=;';
            ws.send(
              `@badge-info=;badges=${m.badges};color=${m.color};display-name=${m.user};` +
              `${emotes}id=${id};mod=0;room-id=71092938;subscriber=0;tmi-sent-ts=${Date.now()};` +
              `user-id=1;user-type= :${m.user.toLowerCase()}!u@u.tmi.twitch.tv PRIVMSG #${channel} :${m.text}\r\n`,
            );
          });
        }
        if (line.startsWith('PING')) ws.send('PONG :tmi.twitch.tv\r\n');
      }
    });
  }

  function runGoodGame(ws) {
    ws.send(JSON.stringify({ type: 'welcome', data: { protocolVersion: 2 } }));
    ws.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.type !== 'join') return;
      ws.send(JSON.stringify({
        type: 'success_join',
        data: { channel_id: GG_CHANNEL_ID, channel_name: 'Fake stream', channel_key: 'fake' },
      }));
      replay((m) => {
        if (m.platform !== 'goodgame') return;
        ws.send(JSON.stringify({
          type: 'message',
          data: {
            channel_id: GG_CHANNEL_ID,
            user_id: 1,
            user_name: m.user,
            user_rights: m.rights ?? 0,
            premium: m.premium ?? 0,
            icon: m.icon ?? 'none',
            resubs: m.resub ? { [GG_CHANNEL_ID]: m.resub } : {},
            gg_plus_tier: m.ggPlus ?? 0,
            color: m.color,
            message_id: 'gg-' + Math.random().toString(36).slice(2, 10),
            timestamp: Math.floor(Date.now() / 1000),
            text: m.text,
          },
        }));
      });
    });
  }

  return {
    port: actualPort,
    env: {
      OVERLAY_TWITCH_WS: `ws://127.0.0.1:${actualPort}/irc`,
      OVERLAY_GOODGAME_WS: `ws://127.0.0.1:${actualPort}/chat2/`,
      OVERLAY_TEST_API_BASE: `http://127.0.0.1:${actualPort}`,
      OVERLAY_GG_ICON_BASE: `http://127.0.0.1:${actualPort}/gg-icons/`,
      OVERLAY_GG_CHANNEL_ICON_BASE: `http://127.0.0.1:${actualPort}/files/icons/`,
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const client of wss.clients) client.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => http.close(r));
    },
  };
}
