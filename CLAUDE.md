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
npm run e2e:media          # re-capture the README demos (needs network)
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
| `src/main/updater/` | release parsing, manifest safety, staging |
| `src/renderer/sources/` | GoodGame + Twitch protocol clients |
| `src/renderer/emotes/` | emote and badge catalogues, caching |
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
both chat protocols and serves fixed emote/badge/icon fixtures. **No network, no
dependence on anyone being live.** A run either passes or has found a bug.

`npm run e2e` runs three scenarios, because the happy path is the one thing a
real chat rarely stays on:

| Scenario | What it puts the app through |
|---|---|
| default | messages, badges, emotes, colours, lock, settings, drag regions |
| `--scenario=drop` | both sockets terminated mid-transcript with no close frame — the app must notice, back off, reconnect and carry on, with nobody pressing anything |
| `--scenario=degraded` | every catalogue endpoint 503 — Twitch's own emotes and GoodGame's icons still render (they need no lookup), third-party emotes and Twitch badge artwork quietly do not, and not one message is lost |

Assert on what is *painted* — `getClientRects().length` — not on what an
attribute claims. Two bugs in this project passed an attribute check while the
element was plainly visible on screen.

The app is pointed at the fake server with `OVERLAY_TWITCH_WS`,
`OVERLAY_GOODGAME_WS`, `OVERLAY_TEST_API_BASE`, `OVERLAY_GG_ICON_BASE`,
`OVERLAY_GG_CHANNEL_ICON_BASE` and `OVERLAY_TWITCH_EMOTE_BASE`. Real installs
set none of these and behave exactly as before.

The emote, badge and icon artwork is the platforms' own, vendored under
`test/e2e/fixtures/` and served from disk, so a run is offline **and** shows
what a user sees. Stand-in artwork was tried and thrown away: it looks
plausible while the catalogue matches the wrong emote entirely, which is
exactly the bug the run exists to catch. Adding an emote to a transcript means
downloading its artwork too — see that directory's README.

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
| GoodGame chat | `wss://chat.goodgame.ru/chat2/` — JSON, joins by numeric id (**trailing slash required**) |
| GoodGame channel id | `goodgame.ru/api/getchannelstatus` |
| GoodGame smiles | `goodgame.ru/api/4/smiles` |
| GoodGame icons | `static.goodgame.ru/images/chat-svg-icons/` — white SVGs, no API, mapping read from their CSS |
| Twitch chat | `wss://irc-ws.chat.twitch.tv:443` — IRC with tags, anonymous `justinfan` nick |
| Twitch emotes | inline `emotes` tag, plus 7TV / BetterTTV / FrankerFaceZ |
| Twitch badges | IVR public mirror; artwork itself is on Twitch's own CDN |

HTTP goes through the main process against a host allowlist, so the renderer
never needs relaxed web security. The renderer has no Node integration.

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
- **Never write into the payload that is running.** The updater stages into
  `<userData>/payload-new`; `boot` installs it on the next launch. This is what
  stops Windows file locking from breaking an update.
- **The completion marker is written last.** A payload without it is treated as
  an interrupted download and discarded.
- **An empty channel list is legitimate.** Never repopulate it with defaults —
  that resurrects channels the user deleted.
- **A release without an `app-payload.json.gz` asset means "download the full
  zip".** That is correct when the Electron runtime itself changed.
- **GoodGame chat icons are plain white SVGs** (`fill="white"`), so they are
  drawn as `<img>`. An earlier version assumed they were fill-less and drew
  them as CSS masks, which turned every badge into the same silhouette.
- Chat is **read-only and anonymous** on both platforms. Do not add anything
  that needs a login.

## Things that will waste your time

- **Twitch and GoodGame are often quiet.** A manual check that renders nothing
  usually means nobody is talking, not that you broke it. Use `npm run e2e`.
- **`[hidden]` loses to any `display` rule.** Add
  `selector[hidden] { display: none !important }` when you style a container.
- **`-webkit-app-region` is the source of most of this project's UI bugs.**
  Three rules, each learned the hard way:
  1. A drag region is window chrome, so **the page never sees the mouse over
     it** — no `:hover`, no clicks. "Is the pointer over the window" therefore
     comes from the main process (`src/main/pointer.ts`), not from CSS.
  2. **Drawing on top of a drag region does not mask it.** An element with no
     app-region of its own contributes nothing; only an explicit `no-drag`
     subtracts. The settings panel, the resize corner and the scrollbar strip
     all have to say so.
  3. **Never resize a drag region on hover.** Chromium recomputes the region,
     which disturbs the pointer, which drops the hover, which resizes it back —
     a flicker loop several times a second. Hover may repaint; it may not
     reflow. The e2e measures the bar cold and hovered to enforce it.
- **Twitch emote ranges are code-point indexed.** Use `Array.from(text)`; an
  emoji earlier in the line shifts UTF-16 offsets.
- GoodGame's chat endpoint needs the **trailing slash** — without it, 301.
- Piping a long-running capture to a file and killing it loses the buffer.
  Append as you go.
