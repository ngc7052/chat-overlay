# chat-overlay

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
