---
'chat-overlay': patch
---

The end-to-end run now renders the platforms' real artwork. Emote, badge and
icon images are vendored under `test/e2e/fixtures/` and served from disk, so a
run is still entirely offline, but what it draws is what a user sees. The
generated stand-in images it used before looked plausible while telling you
nothing — a catalogue that matched the wrong emote would have drawn a
placeholder just as happily.

Twitch's own emotes now arrive the way Twitch sends them, as character ranges
on the `emotes` tag, so the code-point-indexed range parser is exercised by a
real run rather than only by unit tests.

The replayed transcripts were widened to around fifteen different emotes per
platform — Twitch natives and 7TV side by side, GoodGame's own smiles — and the
demo GIFs in the README were re-captured from them, so they show a chat rather
than the same two emotes repeating.
