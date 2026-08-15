---
'chat-overlay': patch
---

The bootstrapper's decisions are now tested in a real Electron process: that a
downloaded payload is installed and actually run, that one which never starts
is quarantined and the bundled version used instead, and that one which throws
while loading is quarantined with the reason recorded before the app relaunches
without it.

That code decides which app you run, and a wrong answer bricks an install. It
was the last part of the update path with no test around it — the rest is
covered against a real filesystem and a real server.
