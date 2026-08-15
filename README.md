# ChatOverlay

Transparent, always-on-top chat overlay for **GoodGame.ru** and **Twitch**.
Read-only and anonymous — no login, no OAuth, no tokens anywhere.

## Download

**[Get the latest release →](../../releases/latest)** — grab `ChatOverlay.zip`,
unzip anywhere, done. Windows 10/11, 64-bit.

Nothing to install, no Node.js, no admin rights. The zip already contains the
runtime, which is why it is ~140 MB.

> Windows shows a **SmartScreen** warning the first time, because the executable
> is not code-signed: **More info → Run anyway**. Once only.

## Run it

Double-click **`ChatOverlay.exe`**.

It starts **unlocked** with **Settings** open and no channels — add your own with
**+ Add channel**, pick GoodGame or Twitch, type the channel name, tick it to
connect. Your list is saved immediately and restored every time you launch.

Once at least one channel is enabled, press `Ctrl`+`Alt`+`O` to **lock** it: the
window pins above everything and goes fully click-through, so clicks land on the
game behind it. (An empty overlay would be invisible, so it refuses to start
locked until something is enabled.)

## Controls

| Action | How |
|---|---|
| Unlock / lock | `Ctrl` + `Alt` + `O`, or left-click the tray icon |
| Hide / show | `Ctrl` + `Alt` + `H` |
| Move | Unlock, then drag the top bar |
| Resize | Unlock, then drag the grip in the bottom-right corner |
| Add channels, fonts, emotes | Unlock → **Settings** |
| Quit | Tray icon → right-click → **Quit** |

The tray icon sits in the notification area next to the clock (click the `^`
arrow if Windows hid it).

While **locked** there is no title bar, no scrollbar and no background — just
the text — and the mouse passes straight through.

## Channels

Settings → **Channels**. Each row has a checkbox: tick to connect, untick to
disconnect. Any number of channels from either platform run at once and merge
into one feed; the logo on each line says where a message came from.

Type the channel name exactly as it appears in the site's address bar:

| Platform | Channel page | Type this |
|---|---|---|
| GoodGame | `goodgame.ru/`**`somechannel`** | `somechannel` (a numeric stream id also works) |
| Twitch | `twitch.tv/`**`somechannel`** | `somechannel` |

Names are not case sensitive. The list is saved as soon as you edit it.

## Emotes

- GoodGame smiles (the `:name:` tokens), animated ones included.
- Twitch native emotes.
- 7TV, BetterTTV and FrankerFaceZ — global plus each channel's own set.

Emote lists are cached locally for a few hours. Turn any of it off in Settings.

## Looking like the Twitch site

| Setting | What it does |
|---|---|
| **Badges → Real icons** | The actual Twitch badge artwork — moderator, VIP, founder, per-channel subscriber tiers, bits. GoodGame publishes no badge images, so those stay as text labels. |
| **Platform marker** | Twitch glitch / GoodGame logo instead of `TW` / `GG` text. Or hide it. |
| **Exact Twitch nickname colours** | The colour Twitch actually sends, unmodified. Turn it **off** and dark colours get lifted so they stay readable over a bright game. |
| **Bold nicknames** | Off by default — nicknames match the message weight. |
| **Font** | Preset list (including monospace) or any font installed on the machine via the CSS field. |

## Custom CSS

Settings → **Custom CSS**. Applied live as you type, saved with the rest of the
config. Hooks:

| Selector | Matches |
|---|---|
| `.msg` | one chat line |
| `.msg .name` / `.msg .text` | nickname / message body |
| `.badge` / `.badge-img` | text badge / real badge image |
| `.emote` | any emote image |
| `.plat-img` / `.plat.tw` / `.plat.gg` | platform logo / text marker |
| `.msg.system` | connection messages |

Example — thinner lines, lowercase names, bigger emotes:

```css
.msg { line-height: 1.15; }
.msg .name { text-transform: lowercase; }
.emote { height: calc(var(--emote-size) * 1.4); }
```

## Notes

- **Exclusive-fullscreen games hide every overlay**, this one included. Set the
  game to *borderless windowed* (sometimes called *fullscreen windowed*).
- If a hotkey does not work, another app already owns that combination —
  Settings → **Hotkeys** shows a warning and lets you pick another.
- Settings, window position and channel list live in
  `%APPDATA%\ChatOverlay\config.json`. Delete that file to reset everything.
- Chat is **read-only** — the overlay cannot send messages.

## Source layout

Plain JavaScript — no bundler, no build step, no dependencies. Everything lives
in `app/` (which becomes `resources\app\` inside a build):

| File | What it does |
|---|---|
| `boot.js` | picks the newest app payload and starts it (see *Updates*) |
| `payload/main.js` | window, click-through, tray, hotkeys, config, HTTP proxy, updater wiring |
| `payload/updater.js` | release check, download, verification |
| `payload/preload.js` | the small bridge the page is allowed to call |
| `payload/renderer/sources.js` | GoodGame + Twitch protocol clients |
| `payload/renderer/emotes.js` | GoodGame smiles, 7TV / BTTV / FFZ, Twitch badges |
| `payload/renderer/app.js` | rendering and the settings panel |
| `payload/renderer/util.js` | colours, URL splitting, small helpers |
| `payload/renderer/style.css` | all the styling |
| `payload/version.json` | the app version — the one place it is set |

To tweak an existing install, edit `resources\app\payload\` in place and restart
the exe — no rebuild needed. One catch: if you have ever applied an in-app
update, the newer copy in `%APPDATA%\ChatOverlay\payload` wins over
`resources\app\payload`, so edit that one instead (or delete it to go back to
what shipped).

## Updates

The app checks GitHub for a newer release on startup and every 6 hours, and
tells you — it never downloads or changes anything on its own. When one exists
an **Update** button appears in the top bar (and a line in the chat, since a
locked overlay has no bar). Clicking it downloads and restarts.

An update is about **35 KB**, not 137 MB: the Electron runtime never changes,
only the app itself. Turn the checking off in Settings → **Updates**.

### How it stays safe

`boot.js` is the only file an update cannot touch. It picks whichever app
payload is newest:

| Location | What it is |
|---|---|
| `resources\app\payload` | the version that shipped in the zip |
| `%APPDATA%\ChatOverlay\payload` | a newer one downloaded by the updater |

The updater never writes into either of those. It downloads into
`%APPDATA%\ChatOverlay\payload-new`, SHA-256 checks every file after it is
written, and only when all of them verify marks the directory complete. On the
next launch `boot.js` moves it into place — before anything is loaded from it —
so an update never overwrites a file the running process has open (the usual
reason self-updating breaks on Windows), and a download or move interrupted at
any point is finished or thrown away next time rather than left half-applied.

Every launch of a downloaded payload is counted until the payload reports that
its window is up. One that throws while loading, or crashes before that point,
is quarantined immediately and the app restarts on the bundled version; one that
silently never comes up is quarantined after three launches. A quarantined
version is remembered and not offered again — you can still re-download it by
hand from Settings → **Updates** if you want to retry — so a broken release
cannot brick an install or nag you into reinstalling it.

### Publishing one

```bash
# 1. bump app/payload/version.json — the only place the version is set
# 2. build; the last line prints the exact release command for that version
./build.sh --zip
gh release create v1.0.1 dist/ChatOverlay.zip dist/app-payload.json.gz \
  --title "ChatOverlay 1.0.1" --notes "..."
```

The release **tag must be `v` + the version in `version.json`** (`build.sh`
writes it to `dist/RELEASE_TAG` and refuses to build from a commit tagged with
anything else). Installs decide whether to update from the tag and refuse to
install a package whose version disagrees with it, so a tag that drifts from
`version.json` would make every install offer an update that can never succeed.

Both assets matter: `ChatOverlay.zip` is for new users, `app-payload.json.gz` is
what existing installs fetch. A release without the payload asset falls back to
opening the release page in a browser, which is the right behaviour when the
Electron runtime itself changed and a full re-download is genuinely needed.

## Building the portable zip

```bash
./build.sh --zip      # -> dist/ChatOverlay/ and dist/ChatOverlay.zip
```

Downloads the official Electron win32-x64 runtime, drops `app/` into
`resources/app`, renames `electron.exe` to `ChatOverlay.exe`. Runs on Linux,
WSL or macOS — no Windows machine, no wine, no code-signing toolchain.
Override the runtime with `ELECTRON_VERSION=43.4.0 ./build.sh`.

## How it talks to the platforms

Both are read-only anonymous connections; the app never sees a password.

| | Endpoint |
|---|---|
| GoodGame chat | `wss://chat.goodgame.ru/chat2/` — JSON, joins by numeric channel id (resolved from the channel name via `getchannelstatus`) |
| Twitch chat | `wss://irc-ws.chat.twitch.tv:443` — IRC with tags, anonymous `justinfan` nick |
| GoodGame smiles | `goodgame.ru/api/4/smiles` |
| Twitch emotes | inline `emotes` tag, plus 7TV / BetterTTV / FrankerFaceZ |
| Twitch badges | IVR public mirror; artwork itself is on Twitch's own CDN |

HTTP requests are made from the main process against a host allowlist, so the
page never needs relaxed web security. The renderer has no Node integration.

## Licence

MIT. Twitch and GoodGame names, logos and badge artwork belong to their owners.
