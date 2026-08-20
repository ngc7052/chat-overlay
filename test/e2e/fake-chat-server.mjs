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
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * GoodGame channel 5, whose own subscriber artwork is vendored, so the
 * per-tier icons a real premium chat shows are exercised too.
 */
const GG_CHANNEL_ID = '5';

/* ------------------------------------------------------------- fixtures ---- */

/**
 * The artwork is the platforms' own, vendored under `fixtures/` and served
 * from disk. A run therefore needs no network and cannot flake, and what it
 * draws is what a user sees — which matters, because a screenshot of emotes
 * that are obviously stand-ins tells you nothing about whether the catalogue
 * matched the right one.
 */

/**
 * Twitch's own emotes, by the ids their CDN actually serves. Sent down the
 * `emotes` tag as character ranges, which is how Twitch delivers them, so the
 * range parser is exercised rather than bypassed.
 */
const TWITCH_NATIVE = {
  Kappa: '25', PogChamp: '305954156', LUL: '425618', Kreygasm: '41',
  '4Head': '354', TriHard: '120232', HeyGuys: '30259', SeemsGood: '64138',
  NotLikeThis: '58765', Jebaited: '90076',
};

/** Third-party emotes, by their real 7TV ids. */
const SEVEN_TV = {
  Clap: '01GAM8EFQ00004MXFXAJYKA859', peepoHappy: '01GAZ199Z8000FEWHS6AT5QZV0',
  PepePls: '01GAFTZ9K80003DHH026MC7JW0', FeelsDankMan: '01GB9W8JN80004CKF2H1TWA99H',
  EZ: '01GB4CK01800090V9B3D8CGEEX', WAYTOODANK: '01G98W833R0000BRQD106P0ZNT',
  Stare: '01GG3YGWK8000DWE419062SG28', AYAYA: '01GB32XE6R00018VJGJ4A9BNCV',
  peepoSad: '01GAZ4SBX80007YCE2RXBT44B2', forsenPls: '01GB8EQNJ8000497KFBZWNSDFZ',
  BillyApprove: '01GB2S7H7000018VJGJ4A9BMFS', FeelsOkayMan: '01GB46137R000BJ5HR8F6XV8J1',
};

/** GoodGame's global smiles, all of which exist under /images/smiles/. */
const GG_SMILES = [
  'pekaclap', 'peka', 'kekw', 'wow', 'cool', 'winner', 'fire', 'hug',
  'sing', 'love', 'metal', 'marvelous', 'flowers', 'goodboy', 'gosling', 'waiting',
];

const fixtures = (origin) => ({
  badgesGlobal: [
    { set_id: 'moderator', versions: [{ id: '1', image_url_2x: `${origin}/twitch-badges/moderator.png`, title: 'Moderator' }] },
    { set_id: 'vip', versions: [{ id: '1', image_url_2x: `${origin}/twitch-badges/vip.png`, title: 'VIP' }] },
    { set_id: 'broadcaster', versions: [{ id: '1', image_url_2x: `${origin}/twitch-badges/broadcaster.png`, title: 'Broadcaster' }] },
  ],
  badgesChannel: [
    { set_id: 'subscriber', versions: [{ id: '12', image_url_2x: `${origin}/twitch-badges/subscriber.png`, title: 'Subscriber' }] },
  ],
  sevenTvGlobal: {
    emotes: Object.entries(SEVEN_TV).map(([name, id]) => ({
      id, name, data: { host: { url: `${origin}/7tv/${id}`, files: [{ name: '2x.webp' }] } },
    })),
  },
  // Both variants, as GoodGame publishes them: 18px and 36px. The client is
  // expected to take the big one.
  ggSmiles: GG_SMILES.map((key) => ({
    key,
    channel_id: 0,
    animated: 0,
    images: {
      small: `${origin}/gg-smiles/${key}.png`,
      big: `${origin}/gg-smiles/${key}-big.png`,
    },
  })),
});


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
  { at: 200, user: 'Halcyon_TV', color: '#FF7F50', badges: 'broadcaster/1', text: 'one more run and then we call it HeyGuys' },
  { at: 900, user: 'pixel_wraith', color: '#1E90FF', badges: 'subscriber/12', text: 'Clap Clap PogChamp' },
  { at: 1600, user: 'mossy_toad', color: '#2FA84F', badges: '', text: 'that jump was frame perfect Kappa' },
  { at: 2300, user: 'LedgerBot', color: '#5F9EA0', badges: 'moderator/1', text: 'pixel_wraith has been here 14 months' },
  { at: 3000, user: 'quietstorm', color: '#DA70D6', badges: 'vip/1', text: 'peepoHappy no way' },
  { at: 3700, user: 'BitCrusher88', color: '#0000FF', badges: '', text: 'dark blue name, still readable' },
  { at: 4400, user: 'orbital_cat', color: '#E6A400', badges: 'subscriber/12', text: 'LUL LUL chat is flying today' },
  { at: 5100, user: 'dust_devil', color: '#8A2BE2', badges: '', text: 'clip that WAYTOODANK' },
  { at: 5800, user: 'pixel_wraith', color: '#1E90FF', badges: 'subscriber/12', text: 'https://example.com/clip' },
  { at: 6500, user: 'NovaKestrel', color: '#20B2AA', badges: '', text: 'first time catching this live Kreygasm' },
  { at: 7200, user: 'quietstorm', color: '#DA70D6', badges: 'vip/1', text: 'PepePls PepePls' },
  { at: 7900, user: 'mossy_toad', color: '#2FA84F', badges: '', text: 'how many attempts was that Stare' },
  { at: 8600, user: 'Halcyon_TV', color: '#FF7F50', badges: 'broadcaster/1', text: 'forty one. i counted 4Head' },
  { at: 9300, user: 'orbital_cat', color: '#E6A400', badges: 'subscriber/12', text: 'FeelsDankMan EZ' },
  { at: 10000, user: 'NovaKestrel', color: '#20B2AA', badges: '', text: 'TriHard worth every one of them' },
  { at: 10700, user: 'Halcyon_TV', color: '#FF7F50', badges: 'broadcaster/1', text: 'thanks for hanging about, all BillyApprove' },
];

export const GOODGAME_SCRIPT = [
  { at: 400, user: 'Ветродуй', color: 'streamer', rights: 20, icon: 'eagle', text: 'так, ещё один заход и заканчиваем' },
  { at: 1100, user: 'КотБаюн', color: 'simple', icon: 'star', premium: 1, resub: 2, text: 'ну наконец-то :pekaclap:' },
  { at: 1800, user: 'Сумрак77', color: 'simple', text: 'вот это реакция конечно :kekw:' },
  { at: 2500, user: 'Печенька', color: 'premium-personal', premium: 1, icon: 'cup', text: 'я аж подпрыгнула :wow:' },
  { at: 3200, user: 'ЛунныйЗаяц', color: 'simple', text: 'сколько попыток было? :peka:' },
  { at: 3900, user: 'Ветродуй', color: 'streamer', rights: 20, icon: 'eagle', text: 'сорок одна, я считал :cool:' },
  { at: 4600, user: 'ГрозаМорей', color: 'simple', icon: 'star', premium: 1, ggPlus: 12, resub: 5, text: 'терпение и труд :winner:' },
  { at: 5300, user: 'Сумрак77', color: 'simple', text: 'без единой ошибки прошёл :fire: :metal:' },
  { at: 6000, user: 'Тихоня', color: 'simple', text: 'первый раз смотрю вживую :hug:' },
  { at: 6700, user: 'КотБаюн', color: 'simple', icon: 'star', premium: 1, resub: 2, text: 'клип обязательно :sing:' },
  { at: 7400, user: 'Печенька', color: 'premium-personal', premium: 1, icon: 'cup', text: 'https://example.com/клип' },
  { at: 8100, user: 'ЛунныйЗаяц', color: 'simple', text: 'подписался, спасибо за стрим :love:' },
  { at: 8800, user: 'Сумрак77', color: 'simple', text: 'ну это сильно :marvelous:' },
  { at: 9500, user: 'ГрозаМорей', color: 'simple', icon: 'star', premium: 1, ggPlus: 12, text: 'до завтра, всем добра! :flowers:' },
  { at: 10200, user: 'Ветродуй', color: 'streamer', rights: 20, icon: 'eagle', text: 'всем спасибо, что были рядом :goodboy:' },
];

/**
 * YouTube's transcript.
 *
 * `emoji` names a file under `fixtures/yt-emotes/`; standard emoji carry the
 * character itself as their id, exactly as YouTube sends them, and the one
 * custom membership emoji carries a channel-scoped id and no character at all —
 * which is the difference the parts builder has to act on.
 */
export const YOUTUBE_SCRIPT = [
  { at: 300, user: '@northwind_ada', text: 'first time catching this one live', badges: ['MODERATOR'] },
  { at: 1000, user: '@quiet_lantern', text: 'that transition though ', emoji: ['fire'] },
  { at: 1700, user: '@marrow_and_moss', text: 'chat is flying ', emoji: ['face_with_tears_of_joy'], member: 'Member (2 months)' },
  { at: 2400, user: '@Tidewrack', text: 'been waiting all week for this ', emoji: ['partying_face'] },
  { at: 3100, user: '@northwind_ada', text: 'clip at https://example.com/clip', badges: ['MODERATOR'] },
  { at: 3800, user: '@sable_orbit', text: 'no words ', emoji: ['red_heart', 'red_heart'] },
  { at: 4500, user: '@marrow_and_moss', text: 'members know ', emoji: ['_channelBLINK'], member: 'Member (2 months)' },
  { at: 5200, user: '@HollowPine', text: 'how is this only 40 minutes in ', emoji: ['thinking_face'] },
  { at: 5900, user: '@Tidewrack', text: 'straight up ', emoji: ['rocket'] },
  { at: 6600, user: '@quiet_lantern', text: 'earned every bit of it ', emoji: ['clapping_hands'] },
  { at: 7300, user: '@sable_orbit', text: 'i need a nap after that ', emoji: ['yawning_face'] },
  { at: 8000, user: '@GraceOfHerons', text: 'thanks for streaming, all', badges: ['OWNER'] },
];

/**
 * Build the `emotes` tag Twitch would send for a line: `id:start-end,start-end`,
 * joined by `/`. Ranges are **code-point** indexed, which is why the offsets are
 * counted over `Array.from` rather than over the string's UTF-16 units.
 */
function twitchEmotesTag(text) {
  const found = new Map();
  let at = 0;
  for (const token of text.split(/(\s+)/)) {
    const len = Array.from(token).length;
    const id = TWITCH_NATIVE[token];
    if (id) {
      const range = `${at}-${at + len - 1}`;
      found.set(id, found.has(id) ? `${found.get(id)},${range}` : range);
    }
    at += len;
  }
  return Array.from(found, ([id, ranges]) => `${id}:${ranges}`).join('/');
}

/** Both, interleaved — what the assertion run uses. */
export const SCRIPT = [
  ...TWITCH_SCRIPT.map((m) => ({ ...m, platform: 'twitch' })),
  ...GOODGAME_SCRIPT.map((m) => ({ ...m, platform: 'goodgame' })),
  ...YOUTUBE_SCRIPT.map((m) => ({ ...m, platform: 'youtube' })),
].sort((a, b) => a.at - b.at);

/* ---------------------------------------------------------------- server ---- */

/**
 * Map a request path onto a vendored file. Everything the app asks for while
 * rendering the transcript is here; anything else 404s, which surfaces as a
 * broken image and fails the run rather than passing quietly.
 */
function fixtureFor(pathname) {
  const seg = pathname.split('/').filter(Boolean);
  // Twitch's own CDN: /emoticons/v2/<id>/default/dark/2.0
  if (seg[0] === 'emoticons' && seg[2]) return `twitch-emotes/${seg[2]}.png`;
  // 7TV: /7tv/<id>/2x.webp
  if (seg[0] === '7tv' && seg[1]) return `7tv/${seg[1]}.webp`;
  // GoodGame channel artwork: /files/icons/<channel>-<tier>-48.png
  if (seg[0] === 'files' && seg[1] === 'icons' && seg[2]) return `gg-channel-icons/${seg[2]}`;
  if ((seg[0] === 'gg-icons' || seg[0] === 'gg-smiles' || seg[0] === 'twitch-badges'
    || seg[0] === 'yt-emotes' || seg[0] === 'yt-badges') && seg[1]) {
    return `${seg[0]}/${seg[1]}`;
  }
  return null;
}

const CONTENT_TYPES = {
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif',
};

/* ------------------------------------------------------------------ youtube */

const YT_VIDEO_ID = 'e2eLiveVid0';
/** What the app is told to wait between polls; the shipped default is 10s. */
const YT_POLL_MS = 400;

/** Read a JSON request body — the two socket protocols never needed one. */
function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });
}

/**
 * A channel's `/live` page. Assigns `ytInitialData` with `var`, which is what
 * the watch page does — the chat page below uses the other form, and the app
 * has to read both.
 *
 * The recommendation shelf is here on purpose: it puts a *different* videoId
 * earlier in the document than the real one, which is exactly the trap that
 * made a naive "first videoId in the HTML" read return another channel's
 * stream. A page without it would let that bug pass.
 */
function watchPage(videoId) {
  const data = videoId
    ? {
      shelf: [{ videoRenderer: { videoId: 'notTheOneX' } }],
      currentVideoEndpoint: { watchEndpoint: { videoId } },
    }
    : { shelf: [{ videoRenderer: { videoId: 'notTheOneX' } }], contents: {} };
  return `<!doctype html><html><body><script>var ytInitialData = ${JSON.stringify(data)};</script></body></html>`;
}

/**
 * The chat pane, whose `subMenuItems` offer the filtered "Top chat" the page
 * opens on and the unfiltered "Live chat". Only the second one is a complete
 * feed, so the token handed out under "Top chat" is one this server refuses to
 * advance — an overlay that took the default would go permanently quiet here
 * instead of silently dropping messages in production.
 */
function chatPage() {
  const data = {
    contents: {
      liveChatRenderer: {
        continuations: [{ invalidationContinuationData: { continuation: 'top-chat', timeoutMs: YT_POLL_MS } }],
        header: {
          liveChatHeaderRenderer: {
            viewSelector: {
              sortFilterSubMenuRenderer: {
                subMenuItems: [
                  {
                    title: 'Top chat', selected: true,
                    subtitle: 'Some messages, such as potential spam, may not be visible',
                    continuation: { reloadContinuationData: { continuation: 'top-chat' } },
                  },
                  {
                    title: 'Live chat',
                    subtitle: 'All messages are visible',
                    continuation: { reloadContinuationData: { continuation: 'yt-0' } },
                  },
                ],
              },
            },
          },
        },
      },
    },
  };
  return '<!doctype html><html><body><script>window["ytInitialData"] = '
    + JSON.stringify(data)
    + ';var ytcfg={};ytcfg.set({"INNERTUBE_API_KEY":"AIzaFake","INNERTUBE_CLIENT_VERSION":"2.20260817.01.00"});</script></body></html>';
}

/**
 * Google's cookie-consent interstitial, served — with a 200 on it — to any
 * request that does not carry the consent cookie.
 *
 * Reproduced here because it is otherwise invisible: it only appears from
 * inside the EU, so a CI box elsewhere would never meet it, and what it costs
 * is the entire feature. Without the cookie the source finds no video on the
 * channel and reports it as permanently not live.
 */
function consentPage() {
  return '<!doctype html><html><body><h1>Before you continue to YouTube</h1>'
    + '<form action="https://consent.youtube.com/save"></form></body></html>';
}

/**
 * What YouTube's live chat answers a user agent it does not recognise: a 1.4 KB
 * stub, again with a 200 on it, telling the caller to update their browser.
 * The app must let Electron's own Chrome user agent out rather than name
 * itself, and this is what fails if it stops doing that.
 */
function oldBrowserPage() {
  return '<!doctype html><html><body>Oh no! It looks like you&#39;re using an older '
    + 'version of your browser. Please update it to use live chat.</body></html>';
}

/** YouTube's own "no chat here" pane. Its text arrives translated, so the app
    is expected to recognise the shape and not the words. */
function noChatPage() {
  const data = { contents: { messageRenderer: { text: { runs: [{ text: 'Šai tiešraides straumei ir atspējota tērzēšana.' }] } } } };
  return `<!doctype html><html><body><script>window["ytInitialData"] = ${JSON.stringify(data)};</script></body></html>`;
}

/** One scripted line, in the shape `get_live_chat` answers with. */
function ytItem(m, origin, index) {
  const runs = [];
  if (m.text) runs.push({ text: m.text });
  for (const name of m.emoji ?? []) {
    const custom = name.startsWith('_');
    runs.push({
      emoji: {
        // A standard emoji's id is the character itself; a custom one is
        // scoped to the channel and has no character at all.
        emojiId: custom ? `UCe2e/${name}` : name,
        shortcuts: [`:${name}:`],
        image: {
          thumbnails: [
            { url: `${origin}/yt-emotes/${name}${custom ? '.gif' : '.png'}`, width: 24, height: 24 },
            { url: `${origin}/yt-emotes/${name}${custom ? '.gif' : '.png'}`, width: 48, height: 48 },
          ],
        },
        ...(custom ? { isCustomEmoji: true } : {}),
      },
    });
  }
  const badges = (m.badges ?? []).map((icon) => ({
    liveChatAuthorBadgeRenderer: { icon: { iconType: icon }, tooltip: icon[0] + icon.slice(1).toLowerCase() },
  }));
  if (m.member) {
    badges.push({
      liveChatAuthorBadgeRenderer: {
        customThumbnail: {
          thumbnails: [
            { url: `${origin}/yt-badges/member-2.png`, width: 16, height: 16 },
            { url: `${origin}/yt-badges/member-2.png`, width: 32, height: 32 },
          ],
        },
        tooltip: m.member,
      },
    });
  }
  return {
    addChatItemAction: {
      item: {
        liveChatTextMessageRenderer: {
          id: `yt-msg-${index}`,
          authorName: { simpleText: m.user },
          authorExternalChannelId: `UCauthor${index}`,
          timestampUsec: String(Date.now() * 1000),
          message: { runs },
          ...(badges.length ? { authorBadges: badges } : {}),
        },
      },
    },
  };
}

export async function startFakeChat({
  port = 0, script = SCRIPT, loop = false, only = null,
  dropAfterMs = 0, stallAfterMs = 0, failCatalogues = false,
  // YouTube: a channel that is not live until this many ms in (0 = live from
  // the start), and a stream that ends this many ms in (0 = never).
  ytLiveAfterMs = 0, ytEndAfterMs = 0,
} = {}) {
  if (only) script = script.filter((m) => m.platform === only);
  let fx = null;
  let origin = '';
  const startedAt = Date.now();
  const ytScript = script.filter((m) => m.platform === 'youtube');


  /**
   * One poll, answered from where the caller's token says it got to.
   *
   * The token is the index of the next line to send, so successive polls walk
   * the transcript exactly once however often they are made — which is the
   * thing a push protocol never has to get right and a polling one always does.
   */
  function ytPoll(body) {
    const token = String(body?.continuation ?? '');
    // The filtered mode the chat page opens on. A real "Top chat" feed is
    // merely incomplete; here it is empty and never advances, so an overlay
    // that failed to decline it fails the run rather than passing quietly.
    if (token === 'top-chat') return ytFrame([], 'top-chat');

    const at = Number(/^yt-(\d+)$/.exec(token)?.[1] ?? -1);
    if (at < 0) return {};   // not a token this server ever issued

    if (ytEndAfterMs && Date.now() - startedAt >= ytEndAfterMs) {
      // The stream ended: still a well-formed answer, but with nothing left to
      // poll. Only the missing continuation says so.
      return ytFrame([], null);
    }

    const elapsed = Date.now() - startedAt;
    const actions = [];
    let next = at;
    while (next < ytScript.length && ytScript[next].at <= elapsed) {
      actions.push(ytItem(ytScript[next], origin, next));
      next++;
    }
    return ytFrame(actions, `yt-${next}`);
  }

  function ytFrame(actions, continuation) {
    return {
      continuationContents: {
        liveChatContinuation: {
          actions,
          continuations: continuation
            ? [{ invalidationContinuationData: { continuation, timeoutMs: YT_POLL_MS } }]
            : [],
        },
      },
    };
  }
  const http = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const fixture = fixtureFor(url.pathname);
    if (fixture) {
      // path.join collapses any '..', and the segments above are single path
      // components, so a request cannot escape the fixtures directory.
      const file = path.join(FIXTURES, fixture);
      let body;
      try {
        body = readFileSync(file);
      } catch {
        res.writeHead(404).end('missing fixture: ' + fixture);
        return;
      }
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Content-Length': body.length,
      });
      return res.end(body);
    }
    const send = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const html = (body) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };

    /* ------------------------------------------------------------ youtube --
     * The one source that is not a socket. YouTube publishes no chat socket,
     * so the app scrapes a continuation token out of two pages and then polls
     * for it — which means this server has to hold a conversation rather than
     * push a transcript, and remember where each caller got to.
     *
     * The pages are shaped the way YouTube's are, not simplified: the same two
     * different `ytInitialData` assignments, the same "Top chat" default that
     * the app has to decline, the same translated "no chat here" pane. A
     * fixture that skipped those would not exercise the code that reads them.
     */
    // Google answers a request with no consent cookie with an interstitial, and
    // its live chat answers a user agent it does not know with a stub. Both are
    // 200s carrying the wrong page, so a client that gets either one sees no
    // error at all — only a channel that is mysteriously never live.
    const youtubeRoute = url.pathname.endsWith('/live')
      || url.pathname === '/live_chat'
      || url.pathname.startsWith('/youtubei/');
    if (youtubeRoute && !/(^|;\s*)SOCS=/.test(req.headers.cookie ?? '')) {
      return html(consentPage());
    }
    if (url.pathname === '/live_chat' && !/^Mozilla\//.test(req.headers['user-agent'] ?? '')) {
      return html(oldBrowserPage());
    }

    if (url.pathname.endsWith('/live')) {
      const elapsed = Date.now() - startedAt;
      const started = !ytLiveAfterMs || elapsed >= ytLiveAfterMs;
      const over = !!ytEndAfterMs && elapsed >= ytEndAfterMs;
      // A channel page stops offering a stream once it is over — eventually.
      // The lag is deliberate: for a few seconds after the chat closes the page
      // still advertises it, which is what YouTube does and what makes an
      // ended stream look briefly like a live one.
      const lagging = over && elapsed < ytEndAfterMs + 4000;
      return html(watchPage(started && (!over || lagging) ? YT_VIDEO_ID : null));
    }
    if (url.pathname === '/live_chat') {
      if (url.searchParams.get('v') !== YT_VIDEO_ID) return html(noChatPage());
      return html(chatPage());
    }
    if (url.pathname === '/youtubei/v1/live_chat/get_live_chat') {
      return readJson(req).then((body) => send(ytPoll(body)));
    }

    if (url.pathname === '/api/getchannelstatus') {
      return send({
        [GG_CHANNEL_ID]: {
          stream_id: Number(GG_CHANNEL_ID), key: url.searchParams.get('id'), status: 'Live',
        },
      });
    }
    if (failCatalogues && url.pathname !== '/api/getchannelstatus') {
      // Every emote/badge provider unreachable at once. The chat itself must
      // carry on: the catalogues are an enhancement, not a dependency.
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('catalogue down');
      return;
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
  origin = `http://127.0.0.1:${actualPort}`;
  fx = fixtures(origin);
  const channelId = GG_CHANNEL_ID;

  const wss = new WebSocketServer({ server: http });
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(fn, ms);
    timers.add(t);
    return t;
  };

  const dropped = new Set();
  const stalled = new Set();
  wss.on('connection', (ws, req) => {
    const isGoodGame = (req.url || '').includes('chat2');
    const platform = isGoodGame ? 'goodgame' : 'twitch';
    // A real network drop: no close frame, just gone. That is what the client
    // has to notice and recover from, and it is nothing like a clean close.
    // Once per platform, so the reconnection is allowed to succeed.
    if (dropAfterMs && !dropped.has(platform)) {
      dropped.add(platform);
      later(() => ws.terminate(), dropAfterMs);
    }
    // The harder case: the socket stays open and simply stops carrying
    // anything, in both directions. No close frame is ever sent, so onclose
    // never fires and the transport still looks perfectly healthy — a laptop
    // waking from sleep, a Wi-Fi handover, a NAT timeout. Nothing but the
    // client's own watchdog can tell this apart from a channel gone quiet.
    let mute = false;
    if (stallAfterMs && !stalled.has(platform)) {
      stalled.add(platform);
      later(() => { mute = true; }, stallAfterMs);
    }
    const send = (data) => { if (!mute) ws.send(data); };
    if (isGoodGame) return runGoodGame(ws, send);
    return runTwitch(ws, send);
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

  function runTwitch(ws, send) {
    let channel = 'channel';
    ws.on('message', (raw) => {
      for (const line of String(raw).split('\r\n')) {
        if (line.startsWith('NICK')) {
          send(':tmi.twitch.tv CAP * ACK :twitch.tv/tags twitch.tv/commands\r\n');
          send(':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!\r\n');
        }
        if (line.startsWith('JOIN')) {
          channel = line.split('#')[1] || 'channel';
          send(`@emote-only=0;room-id=71092938 :tmi.twitch.tv ROOMSTATE #${channel}\r\n`);
          replay((m) => {
            if (m.platform !== 'twitch') return;
            const id = 'msg-' + Math.random().toString(36).slice(2, 10);
            // Twitch's own emotes arrive as ranges on the tag; third-party ones
            // are matched by name from the catalogues, as in production.
            const emotes = twitchEmotesTag(m.text);
            send(
              `@badge-info=;badges=${m.badges};color=${m.color};display-name=${m.user};` +
              `emotes=${emotes};id=${id};mod=0;room-id=71092938;subscriber=0;tmi-sent-ts=${Date.now()};` +
              `user-id=1;user-type= :${m.user.toLowerCase()}!u@u.tmi.twitch.tv PRIVMSG #${channel} :${m.text}\r\n`,
            );
          });
        }
        // Twitch answers a client PING, which is what makes it usable as a
        // liveness probe — and what a stalled connection stops doing.
        if (line.startsWith('PING')) send('PONG :tmi.twitch.tv\r\n');
      }
    });
  }

  function runGoodGame(ws, send) {
    send(JSON.stringify({ type: 'welcome', data: { protocolVersion: 2 } }));
    ws.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      // Undocumented, but this is what the live server does — and it is the
      // only app-level round trip GoodGame offers, since its WebSocket-level
      // pings are answered by the browser and never reach the page.
      if (frame.type === 'ping') return send(JSON.stringify({ type: 'pong', answer: 'pong' }));
      if (frame.type !== 'join') return;
      send(JSON.stringify({
        type: 'success_join',
        data: { channel_id: channelId, channel_name: 'Fake stream', channel_key: 'fake' },
      }));
      replay((m) => {
        if (m.platform !== 'goodgame') return;
        send(JSON.stringify({
          type: 'message',
          data: {
            channel_id: channelId,
            user_id: 1,
            user_name: m.user,
            user_rights: m.rights ?? 0,
            premium: m.premium ?? 0,
            icon: m.icon ?? 'none',
            resubs: m.resub ? { [channelId]: m.resub } : {},
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
      // Artwork the app builds urls for itself, rather than reading them out
      // of an API response, needs its base pointing here too.
      OVERLAY_GG_ICON_BASE: `http://127.0.0.1:${actualPort}/gg-icons/`,
      OVERLAY_GG_CHANNEL_ICON_BASE: `http://127.0.0.1:${actualPort}/files/icons/`,
      OVERLAY_TWITCH_EMOTE_BASE: `http://127.0.0.1:${actualPort}/emoticons/v2/`,
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const client of wss.clients) client.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => http.close(r));
    },
  };
}
