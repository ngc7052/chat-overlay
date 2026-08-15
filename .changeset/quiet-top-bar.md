---
'chat-overlay': minor
---

The top bar no longer looks like a window titlebar. It had a solid fill and a
1px rule under it, drawing a hard seam across a transparent overlay and making
the chrome heavier than the chat it sits above. It is now unfilled and
seamless, with the controls floating over the chat and carrying their own
shadow for contrast.

Because there is no strip to aim at any more, a drag handle and a faint fill
appear whenever the pointer is over the overlay, and the whole bar — empty
space included — moves the window.

The `ChatOverlay` label is gone; it was the boldest text on screen and told you
nothing. Channel status is now one coloured dot per channel — green connected,
amber connecting, red down — with the channel name revealed by the same hover
that fades the backdrop in. The names were repeating the `connected — …` lines
already written into the chat.

Settings is now a short list of collapsible groups rather than one long scroll.
Channels is open to begin with, everything else is a heading you can expand,
and which groups you left open is remembered. Its own header is gone too: it
carried a second "Back to chat" button that sat underneath the bar's back
arrow, so the two overlapped in the same corner.
