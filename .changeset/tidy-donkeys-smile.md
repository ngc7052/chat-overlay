---
"chat-overlay": patch
---

Keep up with a busy chat. YouTube hands the overlay a whole poll's worth of
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
