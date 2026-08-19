---
"chat-overlay": minor
---

**Links in chat can be opened and copied.** A url posted in chat was styled
like a link but was inert: nothing happened when you clicked it, and global
text selection meant you could not even copy it off the screen. Unlocked, a
click now opens it in your normal browser and it can be selected like text.
Locked, the click still goes straight through to the game, and dragging the
window by the chat is unchanged — only the link itself opts out.

**The Update button keeps its icon.** As soon as an update was offered the
button replaced its own contents with plain text, so the download arrow
disappeared for exactly as long as there was an update to install.

**"Overall opacity" no longer fades the settings panel.** It was applied to the
whole window, so turning the chat down to its 20% floor took the settings panel
and the top bar with it — including the slider you needed to turn it back up.
It now applies to the chat feed alone.

**The lock button's tooltip names the hotkey you actually bound.** It was
hard-coded to `Ctrl+Alt+O` and never changed when you rebound the shortcut,
which is the worst possible moment to be told the wrong combination.
