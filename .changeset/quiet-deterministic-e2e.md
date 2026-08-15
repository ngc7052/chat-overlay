---
"chat-overlay": patch
---

End-to-end tests no longer depend on someone being live. A local fake server
speaks both chat protocols and serves the emote, badge and icon fixtures, so a
run is reproducible, needs no network, and either passes or has found a bug.
The README's screenshots and demo are captured from that same run.
