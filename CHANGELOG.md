# chat-overlay

## 1.4.0

### Minor Changes

- 2e7a63e: Moderators and channel owners now get the same badge on every platform. YouTube
  and GoodGame publish no artwork for those two roles, so in icons mode they drew
  the letters MOD and HOST beside a Twitch message showing a sword and a camera
  for exactly the same thing. The app now ships its own sword and camera and draws
  them wherever the platform sent none — which also means a Twitch moderator keeps
  a badge when the badge mirror is unreachable, instead of falling back to text.
  Choosing text badges in the settings still gives text, and off still gives
  nothing.
- 41761bf: YouTube live chat, alongside Twitch and GoodGame. Add a channel the same way —
  Settings → **+ Add channel** → YouTube → `@somechannel` — and its chat joins the
  same feed, with YouTube's emoji, channel membership emoji, membership badges and
  moderator/owner/verified markers. Read-only and anonymous like the other two: no
  login, no API key, no Google account.
  
  A YouTube channel is a stream rather than an address, so a YouTube row behaves a
  little differently: it connects while that channel is live, says so in the feed
  when it is not, and picks the next stream up on its own without you touching
  anything. Paste a stream's own link instead of the channel name to pin one.
  
  A channel that is not streaming is a resting state and not a fault, so the top
  bar stays quiet about it — no "1 of 2 offline" over your game for the evenings
  somebody does not stream. It only counts channels that should be carrying chat
  and are not.
- f4bd733: Show YouTube superchats and membership events, which used to be dropped in
  silence.
  
  A superchat now reads as an ordinary chat line with the amount on it — the
  amount as YouTube formatted it, in a chip painted with YouTube's own tier
  colour, and readable without it. A superchat sent with no message at all still
  appears, which is how a good many of them are sent. New members, membership
  milestones, gifted memberships and gifts appear as they happen, in the author's
  own colour.
  
  Nothing is louder for it: no motion, nothing that resizes, and the same size,
  opacity, lifetime and message cap as every other line. Bans and timeouts reach
  a superchat exactly as they reach anything else.
  
  A type YouTube has not shipped yet is still skipped in silence rather than
  stopping the chat, and the two spellings YouTube is mid-migration between —
  `…Renderer` and `…ViewModel` — are both understood for every type.

### Patch Changes

- fd73f4c: A YouTube channel can be added without the `@`. Typing `PlayWithDeepx` now finds
  the same channel as `@PlayWithDeepx`; before, only the form with the `@` worked
  and the row sat on an `HTTP 404`. The name is still looked up exactly as typed
  first, so a long-standing row holding a legacy custom url — `PewDiePie`,
  `marquesbrownlee` — keeps meaning the channel it has always meant, and the `@`
  form is only asked for when that misses.
- 4812561: YouTube chat now flows instead of arriving in clumps. YouTube is polled rather
  than streamed, so one answer carries everything said since the last one — on a
  busy channel that meant ten lines appearing at once and then nothing at all for
  over a second, again and again, while Twitch and GoodGame trickled alongside it.
  Each answer is now let out across the interval the server itself asked for, so
  chat reads at the pace it was said. Nothing is held back longer than that
  interval, and a quiet channel, a socket, and a burst too big for the message cap
  are all painted immediately as before.
- 0433670: Keep up with a busy chat. YouTube hands the overlay a whole poll's worth of
  messages at once, and each one was being appended and scrolled to on its own,
  which forced the browser to lay the page out again before the next could be
  added — so a busy channel arrived faster than it could be drawn and the feed
  visibly fell behind. Messages are now collected and drawn together on the next
  frame. On a 300-message batch that is 2 layouts instead of 302, one write into
  the feed instead of 300, and 17ms of blocked rendering instead of 67ms; the
  messages the message cap was about to delete are no longer built at all.
  
  The feed can also be scrolled back now. Once there were more messages than
  fitted the window, the ones above it could not be reached — so scrolling up to
  read something that had gone past silently did nothing.

## 1.3.0

### Minor Changes

- 945b985: **The top bar now says nothing while every channel is connected, and says
  plainly what is wrong when one is not.** It used to show a row of small
  coloured dots — one per channel, names hidden until you moved the pointer over
  the window. Healthy or dead, that row looked much the same: two green dots
  became two amber ones, seven pixels each, at the far corner of the overlay,
  over whatever game was behind it. It cost screen space every second of every
  session to say "as expected", and it was easy to miss when it stopped saying
  that.
  
  Now the bar is empty while everything is working, and when a connection goes
  it writes what happened — `1 of 2 offline`, or `all channels offline` when
  nothing is getting through any more. Something appearing where there was
  nothing is far harder to miss than a dot changing colour, and the wording
  answers the question you actually have when chat goes quiet: is nobody talking,
  or has this stopped working? It waits a few seconds first, so an ordinary
  reconnect that fixes itself passes without a word. Moving the pointer over the
  window still shows every channel, each name now beside its own dot.
  
  **The chat itself now says when a connection is lost, not only when one comes
  back.** A channel coming up has always written `connected — twitch/name`; a
  channel going away wrote nothing at all, so after a drop the most recent thing
  the chat had to say about a dead connection was that it was connected. It now
  writes `lost — twitch/name` when a working connection goes — which is also the
  only place this can be said while the overlay is locked and the bar is hidden.
  
  A channel that has dropped is also no longer drawn in the same grey as one that
  was never switched on.
- 7e77edb: **Links in chat can be opened and copied.** A url posted in chat was styled
  like a link but was inert: nothing happened when you clicked it, and global
  text selection meant you could not even copy it off the screen. Unlocked, a
  click now opens it in your normal browser and it can be selected like text.
  Locked, the click still goes straight through to the game, and dragging the
  window by the chat is unchanged — only the link itself opts out.
  
  **The Update button keeps its icon.** As soon as an update was offered the
  button replaced its own contents with plain text, so the download arrow
  disappeared for exactly as long as there was an update to install.
  
  **"Overall opacity" no longer fades the settings panel.** It was applied to the
  whole window, so turning the chat down to its 20% floor took the settings panel
  and the top bar with it — including the slider you needed to turn it back up.
  It now applies to the chat feed alone.
  
  **The lock button's tooltip names the hotkey you actually bound.** It was
  hard-coded to `Ctrl+Alt+O` and never changed when you rebound the shortcut,
  which is the worst possible moment to be told the wrong combination.

### Patch Changes

- 24bc3b1: **A timeout or ban now only clears that person's messages in the channel they
  were moderated in.** Watching several channels of the same platform at once,
  one channel's moderators would wipe the user's lines out of all of them —
  their messages in channels where nothing had happened disappeared too. Each
  removal is now scoped to the channel that sent it, on both Twitch and
  GoodGame.
- c159c1d: Third-party emotes and Twitch badge artwork no longer stay missing for hours
  after a brief network blip. A channel that connected while 7TV, BetterTTV,
  FrankerFaceZ or the badge mirror happened to be unreachable stored the gaps as
  if they were the catalogue, and kept serving them for six hours — across
  restarts, long after every provider was back. One flaky minute was enough.
  
  Nothing is stored now unless at least one provider answered, and a catalogue
  assembled without one of them is kept for minutes rather than hours, so the
  next launch finds out whether that provider is back. Emotes already on screen
  in the running session are unaffected either way.
  
  Starting with two channels also no longer downloads the same catalogue twice.
  They connect at the same moment, and the cache was only filled once a download
  finished, so both missed it and each pulled the full list of smiles; they share
  the one download now.
- 24bc3b1: **Twitch display names and sub notifications keep a literal backslash intact.**
  A backslash followed by a letter was decoded twice, so text like `\some` lost
  the letter after the backslash and gained a space in its place.
- d904ee7: A hand-edited or half-written `config.json` can no longer leave the overlay
  unusable. Every numeric setting is now held to the same range its slider
  offers, and a value that is not a number falls back to the default instead of
  reaching the window or the stylesheet as it was written.
  
  This mattered most for opacity: `0` on a locked overlay is an app that is
  running, on top, invisible *and* click-through, with no way to reach Settings
  and put it right — and it came back that way on every launch. It clamps to 20%
  now. So do the rest: a `maxMessages` of 0 no longer trims every message the
  instant it arrives, a `fadeDuration` of `"nope"` no longer reaches CSS as
  `--fade: nopes`, and a window saved with a nonsense size still opens big enough
  to grab.
  
  Settings are also written to disk far less often. Dragging a slider used to
  mean a blocking file write for every tick of it, and typing a channel name one
  per keystroke; those are coalesced now. Locking and unlocking still saves
  immediately, as does quitting, so nothing is lost.
- 5dba319: A chat connection that dies without saying so is now noticed and reconnected,
  instead of showing as connected forever. Sleeping a laptop, switching Wi-Fi or
  sitting behind a router that quietly forgets the connection used to leave the
  status dot green on a feed that would never carry another message; the app now
  checks that the other end is still there, and when it is not, says so in the
  feed and reconnects on its own. A channel that is simply quiet is left alone.

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
