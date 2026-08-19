---
"chat-overlay": patch
---

**Twitch display names and sub notifications keep a literal backslash intact.**
A backslash followed by a letter was decoded twice, so text like `\some` lost
the letter after the backslash and gained a space in its place.
