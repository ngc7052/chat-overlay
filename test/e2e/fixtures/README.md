# e2e artwork fixtures

The emotes, badges and icons the end-to-end run renders, vendored so a run
needs no network and cannot flake on someone else's CDN.

| Directory | What | From |
|---|---|---|
| `twitch-emotes/` | Twitch's own emotes, named by emote id | `static-cdn.jtvnw.net/emoticons/v2/<id>/default/dark/2.0` |
| `7tv/` | third-party emotes, named by 7TV id | `cdn.7tv.app/emote/<id>/2x.webp` |
| `twitch-badges/` | moderator, VIP, broadcaster, subscriber | `static-cdn.jtvnw.net/badges/v1/...` |
| `gg-smiles/` | GoodGame's global smiles, named by key | `goodgame.ru/images/smiles/<key>.png` |
| `gg-icons/` | GoodGame chat icons and a GoodGame+ tier badge | `static.goodgame.ru/images/chat-svg-icons/` |
| `gg-channel-icons/` | one channel's per-tier subscriber artwork | `goodgame.ru/files/icons/<channel>-<tier>-48.png` |
| `yt-emotes/` | YouTube emoji, and one channel membership emoji | `fonts.gstatic.com/s/e/notoemoji/...` and `yt3.ggpht.com` |
| `yt-badges/` | a YouTube channel membership badge | `yt3.ggpht.com` |

`fake-chat-server.mjs` serves these at the same routes the real hosts use, and
the app is pointed at it by the `OVERLAY_*` overrides. The YouTube artwork is
the exception that proves the rule: YouTube puts the url on the message itself
rather than in a catalogue, so the fake server writes its own origin into the
transcript and no override is involved. A request with no file
behind it returns 404, which shows up as a broken image and fails the run —
so a fixture that goes missing is loud, not silent.

Using the real artwork is the point: a run that drew stand-ins would look
plausible while the catalogue matched the wrong emote entirely. Adding an
emote to a transcript means downloading its artwork here too.

This artwork belongs to Twitch, 7TV, GoodGame, YouTube and Google respectively. It is here to
test and demonstrate a client that displays it, and is not part of the
MIT-licensed source.
