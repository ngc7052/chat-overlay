---
'chat-overlay': patch
---

The update path is now covered against a real filesystem and a real HTTP
server, rather than only through mocked `fs` calls: a payload packed by the
same tool the release uses, served the way GitHub serves it, downloaded by the
real updater and handed to the real boot-time store.

No behaviour changes — but the guarantees that keep a bad release from bricking
an install are now checked rather than assumed: the running payload is never
written to, every file is re-read and hash-checked after it lands, the
completion marker really is the last write, and a package that is truncated,
tampered with, mis-versioned, missing a required file, or carrying a path that
escapes the payload directory is refused before anything is installed.
