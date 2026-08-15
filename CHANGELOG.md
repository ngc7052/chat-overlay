# chat-overlay

## 1.2.0

Released 2026-08-16.

### Changed

- **The top bar is no longer a titlebar.** It had a solid fill and a rule under
  it, which drew a hard seam across a transparent overlay and made the chrome
  heavier than the chat below it. At rest it is now invisible; hovering the
  overlay raises a translucent strip with a drag handle, and moving the pointer
  away takes it back off.
- **Drag the window by the chat.** The whole bar moves it, empty space
  included, and so does the feed itself while unlocked — no aiming for a strip.
  The scrollbar and the resize corner stay out of it.
- **Channel status is a coloured dot per channel** — green connected, amber
  connecting, red down — with the channel name revealed on hover. The
  `ChatOverlay` label is gone; it was the boldest text on screen and said
  nothing you did not know, and the names were repeating the `connected — …`
  lines already in the chat.
- **Settings is a short list of collapsible groups** instead of one long
  scroll. Channels is open to begin with, the rest are headings you expand, and
  which ones you left open is remembered.
- **Bar icons are larger targets**, and the settings scroll track no longer
  runs up behind them.

### Fixed

- **GoodGame smiles were blurry.** The catalogue took GoodGame's `small`
  artwork, 18px tall, while the overlay draws emotes at around 27px — more on a
  scaled display. The `big` variant is exactly twice the size and is what the
  site itself uses. Twitch and 7TV emotes were already high-resolution, which
  is why only GoodGame looked soft.
- Settings had two ways out, overlapping in the same corner: the panel carried
  its own "Back to chat" button underneath the bar's back arrow.
- Nothing in the settings panel responded once the chat became draggable —
  drawing on top of a drag region does not mask it, so every click was read as
  the start of a window drag.

### Internal

- **The update path is tested end to end**, against a real filesystem, a real
  HTTP server and a real Electron process: a package that is truncated,
  tampered with, mis-versioned or carrying an escaping path is refused before
  anything is written; the running payload is never touched; a downloaded one
  is installed and actually run; and one that fails to start, or throws while
  loading, is quarantined so the bundled version takes over. This is the code
  that decides which app you run, and a wrong answer bricks an install.
- **Six end-to-end scenarios**, including a connection dropped without a close
  frame and every emote provider unreachable at once. Neither costs a message.
- TypeScript 7, vitest 4, esbuild 0.28; jsdom dropped as unused. Between them
  they found a real type error and four paths that were counted as covered
  while never running. All development-only — the app still ships with no
  runtime dependencies.

## 1.1.0

Released 2026-08-15.

### Added

- **GoodGame chat icons.** Messages now show the icon the protocol actually
  sends — star, cup, eagle and the rest — plus a GoodGame+ badge for the tier
  held. Unlike Twitch, GoodGame publishes no badge API, so the name-to-file
  mapping was read out of their own stylesheet and confirmed against live
  traffic. Roles that have no icon of their own keep their text chip.
- **Each channel's own subscriber artwork.** Channels ship an image per
  subscription tier and the tier travels on the message, which is what makes a
  real GoodGame chat colourful; channels without artwork fall back to the
  shared icon.

### Changed

- **End-to-end tests no longer depend on anyone being live.** A local fake
  server speaks both chat protocols and serves the emote, badge and icon
  artwork, so a run is reproducible, needs no network, and either passes or has
  found a bug. The README's screenshots and demos are captured from that same
  run.
- **That run draws the platforms' real artwork**, vendored and served from
  disk. The generated stand-ins it used first looked plausible while telling
  you nothing: a catalogue matching the wrong emote would have drawn a
  placeholder just as happily.
- **Twitch's own emotes arrive the way Twitch sends them**, as character ranges
  on the `emotes` tag, so the code-point-indexed range parser is exercised by a
  real run rather than only by unit tests.
- **A simpler README**, example-led, with a separate demo per platform showing
  around fifteen different emotes each.

## 1.0.1

Released 2026-08-15.

### Added

- **In-app updates.** The app checks GitHub on startup and every six hours and
  tells you when a release exists; nothing downloads until you click. An update
  is a ~34 KB payload rather than the whole 137 MB runtime, because only the app
  itself changes.
- **A crash-safe bootstrapper.** `boot.js` runs whichever payload is newest —
  the one that shipped in the zip, or a downloaded one in `%APPDATA%`. Because
  the download lands somewhere else entirely, an update never overwrites a file
  Windows has open. Every file is SHA-256 checked, the completion marker is
  written last, and a payload that fails to start three times (or throws
  immediately) is quarantined so a bad release cannot brick an install.
- **Real Twitch badge artwork** — moderator, VIP, founder, per-channel
  subscriber tiers and bits, drawn as the actual images.
- **Platform logos** instead of `TW` / `GG` text, with the text still available
  as an option.
- **Exact Twitch nickname colours**, plus an option to lift very dark ones so
  they stay readable over a bright game.
- **Font picker** — presets including monospace, or any font installed on the
  machine.
- **Live custom CSS**, applied as you type through a constructable stylesheet so
  the strict Content-Security-Policy stays intact.
- **Icon bar** — a cog for settings that becomes a back arrow while the panel is
  open, circular arrows to reconnect, and a crossed-out eye to hide the bar and
  turn click-through on.
- **A second backdrop level.** Locked shows nothing but the text; unlocked, the
  backdrop fades in while the pointer is over the window so its edges can be
  found to move and resize.
- **CI.** Typecheck, tests and coverage on master and every pull request, and a
  release workflow that publishes only when the version has no tag yet.

### Changed

- **Ported to TypeScript**, bundled with esbuild into the same dependency-free
  output. Rules live in pure modules, Electron and DOM wiring stays thin.
- **367 tests at 100%** statements, branches, functions and lines over the logic
  modules, enforced by thresholds. The wiring is excluded deliberately: covering
  it would mean asserting that mocks were called, which passes just as happily
  when the app is broken.
- **No channels out of the box.** The list starts empty, is saved as soon as it
  is edited, and is never silently repopulated — that would resurrect channels
  the user deleted.
- Settings opens automatically only while no channels exist.

### Fixed

- The settings panel could not be closed. `#settings { display: flex }`
  out-specified the browser's `[hidden] { display: none }`, so the panel was
  painted over the chat permanently and the Close button did nothing.
- The Update button was painted even with the `hidden` attribute set, for the
  same reason, once the bar buttons became flex containers.
- Settings overflowed sideways, pushing channel names out of view, because a
  generic `#settings select` width beat the narrower rule meant for those rows.

## 1.0.0

Released 2026-08-14. First release.

- Transparent, always-on-top, click-through chat overlay for Windows.
- **GoodGame.ru and Twitch at the same time**, merged into one feed.
- Read-only and anonymous on both platforms — no login, no OAuth, no tokens.
- Emotes: GoodGame smiles, Twitch native emotes, and 7TV / BetterTTV /
  FrankerFaceZ, global and per channel.
- Lock and hide hotkeys, tray icon, draggable and resizable window, message
  lifetime and count limits, command and user filters.
- Portable: the zip carries its own runtime, so there is nothing to install and
  Node.js is not required.
