---
"chat-overlay": patch
---

A YouTube channel can be added without the `@`. Typing `PlayWithDeepx` now finds
the same channel as `@PlayWithDeepx`; before, only the form with the `@` worked
and the row sat on an `HTTP 404`. The name is still looked up exactly as typed
first, so a long-standing row holding a legacy custom url — `PewDiePie`,
`marquesbrownlee` — keeps meaning the channel it has always meant, and the `@`
form is only asked for when that misses.
