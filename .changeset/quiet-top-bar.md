---
'chat-overlay': minor
---

The top bar no longer looks like a window titlebar. It had a solid fill and a
1px rule under it, which drew a hard seam across a transparent overlay and made
the chrome heavier than the chat it sits above. It is now unfilled and
seamless: the controls simply float over the chat, carrying their own shadow
for contrast, and the full width still drags the window.

The `ChatOverlay` label is gone — it was the boldest text on screen and told
you nothing — and the channel status is now one coloured dot per channel:
green connected, amber connecting, red down. Hovering the overlay reveals which
channel each dot is, the same hover that fades the backdrop in, and clicking a
red dot reconnects. The names were repeating the `connected — …` lines already
written into the chat.
