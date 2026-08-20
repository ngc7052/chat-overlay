---
"chat-overlay": minor
---

YouTube live chat, alongside Twitch and GoodGame. Add a channel the same way —
Settings → **+ Add channel** → YouTube → `@somechannel` — and its chat joins the
same feed, with YouTube's emoji, channel membership emoji, membership badges and
moderator/owner/verified markers. Read-only and anonymous like the other two: no
login, no API key, no Google account.

A YouTube channel is a stream rather than an address, so a YouTube row behaves a
little differently: it connects while that channel is live, says so in the feed
when it is not, and picks the next stream up on its own without you touching
anything. Paste a stream's own link instead of the channel name to pin one.

A channel that is not streaming is a resting state and not a fault, so the top
bar stays quiet about it — no "1 of 2 offline" over your game for the evenings
somebody does not stream. It only counts channels that should be carrying chat
and are not.
