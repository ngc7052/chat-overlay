---
'chat-overlay': patch
---

A hand-edited or half-written `config.json` can no longer leave the overlay
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
