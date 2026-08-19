---
"chat-overlay": patch
---

A chat connection that dies without saying so is now noticed and reconnected,
instead of showing as connected forever. Sleeping a laptop, switching Wi-Fi or
sitting behind a router that quietly forgets the connection used to leave the
status dot green on a feed that would never carry another message; the app now
checks that the other end is still there, and when it is not, says so in the
feed and reconnects on its own. A channel that is simply quiet is left alone.
