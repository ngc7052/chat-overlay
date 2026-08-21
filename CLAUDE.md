# Working on ChatOverlay

Read this before changing anything. It covers how the project is laid out, how
to check your work, and the few rules that exist because breaking them breaks
other people's installs.

## Commands

```bash
npm install                # ELECTRON_SKIP_BINARY_DOWNLOAD=1 if you only need to test
npm run typecheck          # tsc --noEmit
npm test                   # unit tests
npm run coverage           # unit + integration tests, and the 100% thresholds
npm run e2e                # end-to-end against a local fake chat server
npm run e2e:media          # re-capture the three README demos (needs ffmpeg)
npm run check              # typecheck + coverage + e2e — run this before pushing
npm run build              # compile into app/
./build.sh --zip           # full portable build + update payload
npx changeset              # describe a change for the changelog
npm run version            # consume changesets: bump package.json, write CHANGELOG.md
```

`npm run e2e` needs a display. On a headless box use `xvfb-run -a npm run e2e`.

## Layout

TypeScript, bundled with esbuild. `app/` and `dist/` are build output and are
not in git.

| Path | What lives there |
|---|---|
| `src/shared/version.ts` | version comparison, shared by boot and updater |
| `src/boot/` | picks which app payload to run; `payload.ts` holds the rules |
| `src/main/` | Electron: window, tray, hotkeys, IPC |
| `src/main/config.ts` | config defaults, migrations, invariants |
| `src/main/http.ts` | the host allowlist — the app's whole outbound surface |
| `src/main/updater/` | release parsing, manifest safety, staging |
| `src/renderer/sources/` | GoodGame + Twitch + YouTube protocol clients |
| `src/renderer/emotes/` | emote and badge catalogues, caching |
| `src/renderer/feed.ts` | what the feed holds and when it reaches the screen |
| `src/renderer/view.ts` | what to show: filtering, formatting, status text |
| `src/renderer/index.ts` | DOM wiring |
| `static/` | html, css, icons, app manifest |
| `test/unit/` | vitest |
| `test/e2e/` | fake chat server + Electron driver |
| `tools/make-payload.ts` | packs the update payload |

The split is deliberate: **rules go in pure modules, wiring stays thin.** If a
new rule is hard to test, that usually means it is in the wrong file.

## Testing

### Unit — held at 100%

`vitest.config.ts` enforces 100% statements, branches, functions and lines over
the logic modules. A drop fails CI. If coverage will not reach 100%:

- the code is unreachable → delete it
- the branch is defensive and genuinely cannot be hit → `/* c8 ignore next N */`
  **with a reason on the same line**
- otherwise → write the test

Electron and DOM wiring (`src/main/index.ts`, `src/boot/index.ts`,
`src/preload/`, `src/renderer/index.ts`) is **excluded** from coverage on
purpose. Covering it would mean asserting that mocks were called, which passes
just as happily when the app is broken. It is covered by the e2e instead.

### Integration — real filesystem, real HTTP

`test/integration/` covers the update path with nothing mocked out: a payload
packed by the same `tools/make-payload` the release uses, served over a local
HTTP server the way GitHub serves it, downloaded through the real updater into
a real temp directory, then handed to the real boot-time store.

This tier exists because the unit tests around those modules inject a fake
`fs`, so they prove the rules and not the outcome — and this is the one
subsystem that rewrites the app on disk, where a bad release bricks every
install. It covers the guarantees that matter: the running payload is never
touched, every file is re-read and hash-checked after it lands, the completion
marker is genuinely the last write, and a package that is truncated, tampered
with, mis-versioned, missing a required file, or carrying a path that escapes
the directory is refused before anything is installed.

Each of those was checked by mutation: break the guarantee in `src/`, confirm
a test goes red, put it back. An assertion nobody has seen fail is a guess. The
first version of the "marker written last" check passed against code that wrote
it first, because several files land in the same millisecond and it compared
mtimes; it records the write order now.

### End-to-end — deterministic

`test/e2e/` boots the real, unmodified app against a local server that speaks
all three chat protocols — two sockets and, for YouTube, a stateful HTTP
conversation that remembers where each caller's continuation token got to — and
serves fixed emote/badge/icon fixtures. **No network, no
dependence on anyone being live.** A run either passes or has found a bug.

`npm run e2e` runs eleven scenarios in a couple of minutes, because the happy path
is the one thing a real install rarely stays on:

| Scenario | What it puts the app through |
|---|---|
| default | messages, badges, emotes, colours, superchats, memberships, lock, settings, drag regions — and a YouTube row typed with no `@`, which the fake server 404s exactly as YouTube does for a handle-only channel |
| `--scenario=drop` | both sockets terminated mid-transcript with no close frame — the app must notice, back off, reconnect and carry on, with nobody pressing anything |
| `--scenario=stall` | both sockets held open and simply muted, in both directions — no close frame ever comes, so only the liveness watchdog can tell this apart from a quiet channel. It has to probe, get nothing back, say so and reconnect. `OVERLAY_TEST_WATCHDOG_MS` shrinks the wait for the run; every other scenario gets the shipped minutes |
| `--scenario=degraded` | every catalogue endpoint 503 — Twitch's own emotes and GoodGame's icons still render (they need no lookup), third-party emotes and Twitch badge artwork quietly do not, and not one message is lost |
| `--scenario=staged` | a downloaded payload in `payload-new` — boot must install it, run it, and clear the launch counter once the renderer reports in |
| `--scenario=trials` | the same payload after three launches that never reported in — quarantined, moved aside, bundled one runs instead |
| `--scenario=yt-offline` | a YouTube channel that is not live for the first six seconds — the state neither socket has. Nothing is broken, so it says so in the feed once, waits on its own slow cadence rather than a failure curve, and connects itself the moment a stream starts |
| `--scenario=yt-ended` | a YouTube stream that ends mid-chat, while the channel page goes on advertising it for a few more seconds — the app must report the loss, decline to re-resolve it in a hot loop, and settle back to "not live" |
| `--scenario=burst` | one poll answer carrying 300 messages, with a timeout and a ban for lines *inside the same batch* — what a busy YouTube channel does and what neither socket ever produces. Asserts the batch is written to the feed once rather than 300 times, that nothing over the cap is built at all, and that order, moderation, the cap, auto-scroll and message lifetimes all survive the queue — superchats among them, including one the ban takes down. Prints the layout count and the longest main-thread block, which is where the before/after numbers come from |
| `--scenario=rhythm` | a channel talking steadily at one, eight and thirty messages a second, answered at the 1300ms YouTube asks a busy chat to wait — the shape of a poll rather than its cost. Records every write into the feed: how many messages it carried, how far it moved the text, and how long since the last one. Asserts the feed is written a message at a time rather than in lumps, that nothing is lost or held past its interval, and that a quiet channel is not paced at all. Prints the before/after playout numbers |
| `--scenario=crash` | a payload whose `main.js` throws — quarantined with the load failure recorded, and the app relaunches without it |

`drop` and `stall` run the two socket channels alone. They exist to test what a
socket does when it dies without saying so, and the bar's "every channel is
down" wording; a polling source that carried on regardless would only make it
"two of three offline" and quietly retire the assertion that tells the two
messages apart. YouTube has its own two scenarios instead.

The last three stage a real payload into the profile and let `boot.js` decide,
in a real Electron process. They are the only tests of the code that picks
which app you run, and a wrong decision there bricks an install.

The profile lives in the system temp directory, **not** in the repo: node
resolves module type from the nearest `package.json`, and inside the repo the
root's `"type": "module"` makes a staged payload fail to load as CommonJS —
which no real install, sitting under `%APPDATA%`, would ever hit.

**Every run gets its own profile — `mkdtemp(chat-overlay-e2e-)` — and never a
fixed name.** It was a fixed name once, `chat-overlay-e2e-profile`, shared by
every checkout on the machine; worse, the run *began* by `rm -rf`-ing it. So
starting a run in one worktree deleted the profile a run in another worktree was
using, mid-flight, and nothing in either output named the cause. It cost this
project two misdiagnoses in a day: four hover assertions that failed while the
one asserting the pointer was over the window passed, filed as a pointer-poll
flake; and a `--scenario=trials` launch failure that "did not reproduce". Both
happened with two or three worktrees running `npm run check` at once. Do not
reintroduce a fixed name to make anything easier — with `mkdtemp`, no other run
can name this directory and this run deletes no other run's.

What removes them: **a run that passes deletes its own profile; a run that fails
keeps it and prints the path**, because a quarantined payload or a half-written
config is what one wants to read afterwards. Those leftovers are swept by the
next run, which removes any `chat-overlay-e2e-*` older than six hours — long
enough that a directory that old cannot belong to a run still going, which is
the whole point.

Assert on what is *painted* — `getClientRects().length` — not on what an
attribute claims. Two bugs in this project passed an attribute check while the
element was plainly visible on screen.

The app is pointed at the fake server with `OVERLAY_TWITCH_WS`,
`OVERLAY_GOODGAME_WS`, `OVERLAY_TEST_API_BASE`, `OVERLAY_GG_ICON_BASE`,
`OVERLAY_GG_CHANNEL_ICON_BASE` and `OVERLAY_TWITCH_EMOTE_BASE`, and its
liveness watchdog is shortened with `OVERLAY_TEST_WATCHDOG_MS`. Real installs
set none of these and behave exactly as before.

The emote, badge and icon artwork is the platforms' own, vendored under
`test/e2e/fixtures/` and served from disk, so a run is offline **and** shows
what a user sees. Stand-in artwork was tried and thrown away: it looks
plausible while the catalogue matches the wrong emote entirely, which is
exactly the bug the run exists to catch. Adding an emote to a transcript means
downloading its artwork too — see that directory's README.

### The README demos

The three GIFs in the README are captures of this same run — the real app, the
same fake server, the same vendored artwork. Nothing in them is mocked up and
nothing needs a live channel:

```bash
npm run e2e:media    # all three, a few minutes; needs a display and ffmpeg
```

`--only=<platform>` narrows the run to one channel, which is what makes a demo
show one chat rather than three interleaved, and `--media` writes 40 frames
half a second apart from the *locked* overlay — the state people actually use.
`scripts/demo-gif.mjs` turns those frames into `docs/media/demo-<platform>.gif`
and carries the reasoning for the encoding settings, of which `max_colors=64`
is the one that decides the file size.

Three things worth knowing before touching this:

- **`--only` is a supported run, not a shortcut.** It has to stay green, or the
  demos cannot be re-captured — and it failed silently for a while precisely
  because nothing in `npm run e2e` exercises it. Anything that measures one
  platform's example element, or expects a fixed list of three channels, needs
  to cope with the other two being absent.
- **The capture waits for the feed to be free of system lines.** The run drives
  the update button on its way past, and a failed update writes its own lines
  into the chat. They are the harness talking, and the first frame is the one a
  reader sees.
- **The transcript loops for a media run** — including YouTube's, which is a
  poll rather than a socket and so loops by having the repeats already in the
  script `ytPoll` walks. That keeps every item id distinct, which matters
  because the renderer de-dups on them.

### The CSP exception

The shipped Content-Security-Policy only allows the two real chat origins. The
e2e build widens it to loopback, and **only** that build:
`scripts/build.mjs` does it behind `OVERLAY_E2E`. `test/unit/csp.test.ts`
asserts the source policy stays strict, so the exception cannot leak into a
release. Do not relax the shipped policy to make a test pass.

## Changelog and releasing

Every change that a user would notice gets a changeset:

```bash
npx changeset        # pick patch / minor / major, describe it in a sentence or two
```

That writes a small file under `.changeset/`. Several can pile up across PRs.
When it is time to ship:

```bash
npm run version      # consumes them: bumps package.json, prepends CHANGELOG.md
```

Open a PR with that result and merge it — **the version bump is what triggers
the release**, and the release notes are read straight from the new CHANGELOG
section.

Rules that keep the changelog honest:

- **Write the changeset in the PR that makes the change**, not later. Writing
  them afterwards is how one ends up describing work that already shipped —
  which happened here once and had to be removed before it claimed the same
  feature under two versions.
- **Describe what changed for a user**, not which files moved.
- If the entry stops being true while the PR is in review, edit the changeset.
- `1.0.0` and `1.0.1` predate changesets, so their entries are hand-written.
  `changeset version` prepends above them and leaves them alone.

## How it talks to the platforms

Read-only and anonymous on both; the app never sees a password.

| | Endpoint |
|---|---|
| GoodGame chat | `wss://chat.goodgame.ru/chat2/` — JSON, joins by numeric id (**trailing slash required**); undocumented `{"type":"ping"}` is answered `pong`, and `channel_counters` is pushed every 20s |
| GoodGame channel id | `goodgame.ru/api/getchannelstatus` |
| GoodGame smiles | `goodgame.ru/api/4/smiles` |
| GoodGame icons | `static.goodgame.ru/images/chat-svg-icons/` — white SVGs, no API, mapping read from their CSS |
| Twitch chat | `wss://irc-ws.chat.twitch.tv:443` — IRC with tags, anonymous `justinfan` nick |
| Twitch emotes | inline `emotes` tag, plus 7TV / BetterTTV / FrankerFaceZ |
| Twitch badges | IVR public mirror; artwork itself is on Twitch's own CDN |
| YouTube live chat | `www.youtube.com/youtubei/v1/live_chat/get_live_chat` — **not** a socket; a JSON POST polled at the interval the server itself names. No key and no account; the one cookie that goes with it is Google's consent flag, which is not a credential |
| YouTube stream lookup | `youtube.com/<channel>/live`, then `youtube.com/live_chat?v=<id>` for the continuation token and client version |
| YouTube emotes & badges | inline on the message — no catalogue, no lookup, no cache |

HTTP goes through the main process against a host allowlist, so the renderer
never needs relaxed web security. The renderer has no Node integration. The
allowlist is only the whole outbound surface if it is checked against the url
that is actually fetched, so requests are made with `redirect: 'error'`: none of
these endpoints redirects any path the app asks for, and a 30x would otherwise
leave the list carrying the session's cookie jar. Every request is also bounded
by `REQUEST_TIMEOUT_MS` — nothing else is.

## How updating works

`boot` picks whichever payload is newest: the one that shipped in the zip
(`resources/app/payload`) or a downloaded one (`%APPDATA%/ChatOverlay/payload`).
The updater writes into `payload-new` and `boot` installs it on the next launch,
so nothing overwrites a file the running process holds open.

A release needs **both** assets: `ChatOverlay.zip` for new users and
`app-payload.json.gz` for existing installs. A release without the payload asset
means "the runtime changed, download the full zip", and the app opens the
release page instead of trying a partial update.

## Workflows

| Workflow | When | What |
|---|---|---|
| `ci.yml` | master + every PR | `Typecheck` and `Tests and coverage` as separate jobs |
| `release.yml` | push to master | calls `ci.yml`, then publishes **only if the version has no tag yet** |

Releasing is: add changesets → `npm run version` → merge. The version bump is
the trigger; ordinary merges run the workflow, see the tag exists, and stop.

## Rules that exist for a reason

- **`package.json` version is the only place the version is set.** The build
  stamps `app/package.json` and `version.json` from it. A release tag that
  disagrees makes every install offer an update that can never succeed.
- **The feed is written once per frame, not once per message.** Appending a
  message and then reading `scrollHeight` to follow it forces a synchronous
  layout. Twitch and GoodGame trickle a message per frame down a socket, so
  one each was survivable; YouTube is a poll, and one answer carrying 300
  messages became 300 forced layouts back to back before anything was painted.
  Arrivals are queued in `src/renderer/feed.ts` and built into one insert on
  the next frame. The consequence to keep in mind is that **a message can
  exist without having an element**: a ban has to reach it, its lifetime is
  already running, and the cap already counts it — none of which can be done
  by reading the DOM. That is why removals match against the messages rather
  than against `data-user`.
- **The queue is also let out across the interval, not all at once.** Batching
  fixed what a poll's answer costs; it did not touch the shape it arrives in.
  Measured against a channel answered every 1300ms, a chat running at eight
  messages a second wrote 9.6 of them into the feed in one frame — a 246px jump
  under the reader's eye — and then nothing for 1304ms, over and over. At thirty
  a second it was 883px in one frame, more than a window height, so lines
  appeared and were scrolled past without ever being painted once. So a source
  that arrives in lumps passes `paceMs` — the interval the server itself asked
  for — with each message, and the queue is released across 70% of it, capped at
  a second. Rules that keep it honest: **a socket passes nothing and is never
  paced**, and an unpaced arrival flushes the whole queue, so a Twitch message
  is never held behind somebody else's batch. **A batch the cap had to cut down
  is not paced either** — it replaces every line on screen however it is drawn,
  and spreading that is a wipe plus a write every frame throughout. The numbers
  are in `PACE_FRACTION` and `PACE_MAX_MS`; `--scenario=rhythm` is the
  measurement.
- **The feed's scroll position is not `justify-content: flex-end`.** Content
  overflowing the *start* edge of a flex container is not part of its
  scrollable overflow, so with `flex-end` a feed taller than the window had
  `scrollHeight === clientHeight` and could not be scrolled back at all — which
  also made the auto-follow rule unreachable, because nobody could ever be
  scrolled up. An auto top margin on the first message bottom-aligns a short
  feed without moving that edge.
- **Never write into the payload that is running.** The updater stages into
  `<userData>/payload-new`; `boot` installs it on the next launch. This is what
  stops Windows file locking from breaking an update.
- **The completion marker is written last.** A payload without it is treated as
  an interrupted download and discarded.
- **An empty channel list is legitimate.** Never repopulate it with defaults —
  that resurrects channels the user deleted.
- **The liveness watchdog asks before it gives up.** A quiet channel is the
  normal state of most channels, so silence alone is never evidence of death:
  the source sends something the server is known to answer, and only reconnects
  when the answer never comes. Reconnecting a healthy socket would drop chat for
  every user, which is worse than the bug the watchdog exists to catch. The
  numbers are in `KEEPALIVE_MS`, `GG_IDLE_MS` and `PROBE_GRACE_MS`, each with
  the measurement behind it written down beside it.
- **Any inbound frame counts as life** — an error reply, a viewer count,
  anything. Tracking a specific reply instead would break the moment either
  platform changed a message type. Note that WebSocket-level pings do *not*
  count: the browser answers those itself and they never reach `onmessage`,
  which is why the probe has to be app-level on both platforms.
- **A release without an `app-payload.json.gz` asset means "download the full
  zip".** That is correct when the Electron runtime itself changed.
- **GoodGame chat icons are plain white SVGs** (`fill="white"`), so they are
  drawn as `<img>`. An earlier version assumed they were fill-less and drew
  them as CSS masks, which turned every badge into the same silhouette.
- **The moderator and broadcaster badges are shipped in the app**, under
  `static/assets/`, and drawn for any badge of those kinds that arrives with no
  artwork of its own — which is every one on GoodGame and YouTube, and every one
  on Twitch when the badge mirror is down. They match the symbols Twitch uses so
  the same role reads the same on all three platforms. Do not fetch Twitch's
  artwork for another platform's message: it is a network dependency for a badge
  that has nothing to do with Twitch, and `--scenario=degraded` exists because
  that mirror goes down. They carry their own fills, for the mask reason above;
  `test/unit/badge-icons.test.ts` holds them to it. `badgeStyle` stays a user
  choice — `text` still means text for these, and `off` still means nothing.
- Chat is **read-only and anonymous** on every platform. Do not add anything
  that needs a login. This is why YouTube is read through the endpoint its own
  watch page polls and not through the YouTube Data API: the API needs a key the
  user has to create in a Google Cloud console, and its default 10,000-unit
  daily quota is spent by one channel left open for a day.
- **A YouTube channel is not an address.** It is a stream, which starts, ends
  and gets replaced — a 24/7 channel rolls one into the next, and the same
  channel can have several live at once. So "not live" is an ordinary state
  rather than a failure: it says so in the feed once, waits on `YT_NOT_LIVE_MS`
  rather than on the connection backoff, and connects itself when a stream
  starts. The page that answers "is it live" is over a megabyte, which is most
  of why that cadence is minutes and not seconds.
- **A bare YouTube name is asked for as typed, and only then with an `@` on
  it.** A word with no `@` is two things at once and nothing local tells them
  apart: a legacy custom url — `youtube.com/PewDiePie` predates handles and
  still resolves — or a handle typed the way anyone says a channel name aloud,
  which is the only form a channel made since 2022 has. Measured against real
  YouTube: `/PlayWithDeepx` is a 404 while `/@PlayWithDeepx` is the page, and
  `/@marquesbrownlee` is a 404 while the bare one is the page. So both forms
  are live and neither covers the other. The typed form goes first so that no
  row which resolves today can quietly change which channel it means; `@word`
  is the fallback. `chatTarget` decides the pair, `YouTubeSource.livePage`
  spends the requests, and the form that answered is remembered — otherwise a
  handle-only channel writes an `HTTP 404` into the log every YT_NOT_LIVE_MS
  while it is not streaming, because `ipcMain.handle` logs every rejection.
  Everything else — `@name`, a `UC…` id, a pasted url — already names one
  thing exactly and has no fallback and no second request.
- **Never resolve a YouTube stream from the first `"videoId"` in the HTML.**
  That is a recommendation shelf. Asked twice in a row for one channel it
  returned two different ids, one of them a different channel's stream.
  `currentVideoEndpoint.watchEndpoint.videoId` is the one the page is playing.
- **Take YouTube's unfiltered "Live chat" continuation, never the "Top chat"
  one the page opens on.** Top chat's own subtitle is "Some messages, such as
  potential spam, may not be visible". An overlay that silently drops messages
  looks exactly like one that works. Both titles arrive translated, so it is
  chosen by position.
- **"Not live" is `idle`, not `offline`.** The bar draws only what is wrong,
  and a channel that is not streaming is not wrong — it is where most channels
  are most of the time. `barAlert` counts only the channels that ought to be
  carrying chat, so a YouTube row that is merely not live never puts "1 of 2
  offline" over somebody's game for the five evenings a week they do not stream.
- **A repeated stale token is a lost connection, not a retry.** One
  `reloadContinuationData` answer is ordinary and re-resolves at once, silently.
  A second in a row means the token just fetched was spent too, and re-fetching
  on the spot is a loop over two pages — one of them over a megabyte — as fast
  as the network answers, writing a "connected" line into the feed each time. So
  it says "lost" once and takes the ordinary backoff, and only a poll that
  *advances* zeroes that curve: a chat that cannot be followed still resolves
  its pages perfectly, so a page that loaded proves nothing.
- **Every reconnect re-reads the chat page, and the page carries a backlog.**
  Remember which message ids have been rendered (bounded — `YT_SEEN_MAX`), or a
  stale token or a watchdog reconnect replays minutes-old chat at the bottom of
  the feed. The renderer's own de-dup only knows what is still in the DOM.
- **A removal names the platform's unique id where there is one.** YouTube bans
  arrive as `externalChannelId`, and display names there are freely reusable —
  matching by name takes the impersonated regular's messages down along with the
  impersonator. Same class of bug as a ban leaking across channels, which 1.3.0
  fixed.
- **Look YouTube's item renderers up in a table, and ignore a miss in silence.**
  `YT_ITEMS` in `src/renderer/sources/youtube.ts` holds the handful worth
  drawing — text, superchats, memberships, gift memberships, gifts. Anything
  else is skipped without a word. Switching exhaustively turns every type
  YouTube adds into a chat that stops, instead of a message that does not
  appear. Every entry in the table is a shape that was read off a live channel:
  a superchat parsed into an empty amount is worse than one that was skipped.
  Deliberately absent are `liveChatViewerEngagementMessage` (YouTube's own
  advice about guarding your privacy), the `…Ticker…` items (the strip along
  the top of YouTube's chat, which repeats every superchat already delivered)
  and `liveChatPaidSticker` (nobody has captured one to check the field names
  against).
- **The table is keyed on the name with the spelling taken off.** YouTube is
  mid-migration from `…Renderer` to `…ViewModel` across exactly these types,
  one at a time — `giftMessageViewModel` has already gone and its neighbours
  have not — and a live channel can be served either spelling for the same
  event. `ytItemKind` strips the suffix so both land on one entry, and the
  field readers take `{ simpleText }`, `{ runs }` and the ViewModel family's
  `{ content }` alike. A type that flips overnight keeps being drawn.
- **A superchat is a chat message with an amount on it.** Not a second kind of
  thing: it carries the author's channel id, so a ban reaches it; it goes
  through the same queue, cap and lifetime; and it is drawn at the same size as
  any other line. The amount is the platform's own formatted string and is
  *text* — YouTube's tier colour is a redundant second channel, so the line
  still says how much was paid to somebody who cannot tell the tiers apart. The
  chip is drawn the way a badge is, with its own solid background and no text
  shadow, because that is the mechanism this feed already trusts over a bright
  scene. A superchat with no message at all is ordinary and must still render.
- **Membership events are actions, not system lines.** Twitch's subs go through
  `system(…, 'event')`, which has no author. YouTube's arrive with an author,
  an id and a channel id, so they are ordinary chat messages with `action` set
  — the colon becomes a space — and moderation and the ignore list reach them.

## Things that will waste your time

- **Twitch and GoodGame are often quiet.** A manual check that renders nothing
  usually means nobody is talking, not that you broke it. Use `npm run e2e`.
- **Most YouTube channels are not live**, which the overlay reports as `not
  live` rather than as an error. That is the feature working. `--scenario=yt-offline`
  is the test; a real channel is not.
- **`[hidden]` loses to any `display` rule.** Add
  `selector[hidden] { display: none !important }` when you style a container.
- **`-webkit-app-region` is the source of most of this project's UI bugs.**
  Three rules, each learned the hard way:
  1. A drag region is window chrome, so **the page never sees the mouse over
     it** — no `:hover`, no clicks. "Is the pointer over the window" therefore
     comes from the main process (`src/main/pointer.ts`), not from CSS.
  2. **Drawing on top of a drag region does not mask it.** An element with no
     app-region of its own contributes nothing; only an explicit `no-drag`
     subtracts. The settings panel, the resize corner, the scrollbar strip and
     the links in the feed all have to say so.
  3. **Hover may repaint; it may not reflow.** Keep this as the standing
     discipline for the bar — but know that the flicker it was written for is
     history, so do not design around it as though it still binds.

     The loop needed a path from *layout* back to *hover state*, and it had one
     while the reveal was driven by CSS `:hover`: resizing the bar made Chromium
     recompute the drag region, which disturbed the pointer, which dropped the
     hover, which resized it back — several times a second. `a008ef1` moved that
     signal to `src/main/pointer.ts`, which polls the OS cursor against the
     window's own bounds. Neither of those can be touched by anything the page
     does, so the loop has nothing left to close. Re-tested when the top bar was
     redesigned: a prototype that deliberately reflowed the bar on hover — the
     second dot jumping 81px — produced zero oscillation over four seconds under
     a real pointer.

     What is left is a cheap invariant worth keeping, not a law of the platform.
     The e2e measures every element in the bar cold and hovered. It is worth
     knowing that it did not always: until the top-bar work it compared only the
     `#bar`, `#grip` and `#status` rects, all of which are flex-filled, so it
     passed against a prototype that plainly reflowed the bar's interior.
- **Two YouTube gates answer with a 200 and the wrong page**, so a client that
  meets either sees no error at all — only a channel that is mysteriously never
  live. Both were found by running the real app against real YouTube; neither
  is reachable from the unit tests, and both are now reproduced by the fake
  server so they cannot come back:
  1. **Google's cookie-consent interstitial**, served to any request without the
     consent cookie *from inside the EU only* — a CI box elsewhere never sees
     it. The cookie has to go in the session's jar, because Chromium treats
     `Cookie` as a forbidden header and drops it from a `fetch()` silently.
  2. **YouTube's live chat sniffs the User-Agent** and answers one it does not
     recognise with a 1.4 KB "update your browser" stub. So YouTube gets no
     `User-Agent` override and sees Electron's own Chrome one — which is not a
     disguise, this really is Chromium.
- **Twitch emote ranges are code-point indexed.** Use `Array.from(text)`; an
  emoji earlier in the line shifts UTF-16 offsets.
- GoodGame's chat endpoint needs the **trailing slash** — without it, 301.
- Piping a long-running capture to a file and killing it loses the buffer.
  Append as you go.
