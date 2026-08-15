---
'chat-overlay': patch
---

Two conditions a real chat produces daily are now covered end to end, against
the real app: a connection dropped without a close frame, which it has to
notice, back off from and recover from on its own; and every emote/badge
provider unreachable at once, which must not cost a single message.

The second one pinned down what "degraded" should mean, which was never
written down: Twitch's own emotes and GoodGame's chat icons keep working
because their urls come from the message itself, while third-party emotes and
Twitch badge artwork need a lookup and so quietly do not appear — Twitch badges
falling back to their text chips.

Dependencies: vitest 2 to 4 and esbuild 0.24 to 0.28, which clears six
advisories in the test and build tooling (two critical). Nothing here ships in
the app, which has no runtime dependencies. Dependabot now watches both npm and
the actions, and CI reports `npm audit` without blocking an unrelated change.

Vitest 4 accounts for coverage more accurately than 2 did, and immediately
found four paths that were passing as covered while never running: a keepalive
that reschedules itself, a PING arriving after the socket is gone, a GoodGame
smile map actually reaching the parser, and a first install whose rename fails.
Those are tested now rather than the threshold being lowered.
