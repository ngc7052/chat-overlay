---
"chat-overlay": minor
---

**The top bar now says nothing while every channel is connected, and says
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
