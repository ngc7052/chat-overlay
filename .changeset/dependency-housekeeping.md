---
'chat-overlay': patch
---

Dependency housekeeping, all of it development-only — the app itself still
ships with no runtime dependencies.

TypeScript 7 immediately caught a real mistake rather than a version skew: the
settings toggle passed `element.hidden` straight into a `boolean` parameter,
and current DOM types call that `boolean | "until-found"`. It is coerced now.

jsdom is gone. It was in the tree but imported nowhere; the tests run in the
node environment.
