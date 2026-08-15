---
"chat-overlay": minor
---

GoodGame messages now show the icon the protocol actually sends — star, eagle,
sword and the rest — plus a GoodGame+ badge for the tier held. They ship as
fill-less SVGs meant to be masked, so they are drawn as CSS masks; an `<img>`
would paint a black square. Roles with no icon of their own keep a text chip.
