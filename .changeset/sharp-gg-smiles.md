---
'chat-overlay': patch
---

GoodGame smiles are no longer blurry. The catalogue was taking GoodGame's
`small` artwork, which is 18px tall, while the overlay draws emotes at around
27px — more again on a scaled display — so every static smile arrived upscaled.
The `big` variant is exactly twice the size, is published for every smile, and
is what the site itself uses; `small` remains the fallback for any that lacks
one. Twitch and 7TV emotes were already high-resolution, which is why only
GoodGame looked soft.

The cached catalogue is versioned, so the sharper artwork appears on the next
launch rather than up to twelve hours later.
