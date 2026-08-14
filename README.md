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
into one feed; the `GG` / `TW` tag on each line says where a message came from.

- **GoodGame** — the name from the URL: `goodgame.ru/`**`annieflowers`** (a
  numeric stream id works too).
- **Twitch** — the login name: `twitch.tv/`**`xqc`**.

## Emotes

- GoodGame smiles (`:pekaclap:`), animated ones included.
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
| `main.js` | window, click-through, tray, hotkeys, config, HTTP proxy |
| `preload.js` | the small bridge the page is allowed to call |
| `renderer/sources.js` | GoodGame + Twitch protocol clients |
| `renderer/emotes.js` | GoodGame smiles, 7TV / BTTV / FFZ, Twitch badges |
| `renderer/app.js` | rendering and the settings panel |
| `renderer/util.js` | colours, URL splitting, small helpers |
| `renderer/style.css` | all the styling |

To tweak an existing install, edit `resources\app\` in place and restart the exe
— no rebuild needed.

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
