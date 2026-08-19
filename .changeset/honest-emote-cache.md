---
'chat-overlay': patch
---

Third-party emotes and Twitch badge artwork no longer stay missing for hours
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
