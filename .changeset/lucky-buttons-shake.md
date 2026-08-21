---
"chat-overlay": patch
---

YouTube chat now flows instead of arriving in clumps. YouTube is polled rather
than streamed, so one answer carries everything said since the last one — on a
busy channel that meant ten lines appearing at once and then nothing at all for
over a second, again and again, while Twitch and GoodGame trickled alongside it.
Each answer is now let out across the interval the server itself asked for, so
chat reads at the pace it was said. Nothing is held back longer than that
interval, and a quiet channel, a socket, and a burst too big for the message cap
are all painted immediately as before.
