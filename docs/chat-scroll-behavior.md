# Chat Scroll Behavior

Chat scrolls with the page (`window`), not a nested container, so the mobile
keyboard and viewport resizing cannot trap the composer.

- A passive scroll listener tracks `nearBottom` (<140px from bottom).
- New events while the user reads upward set `showLatest` → a `↓ New activity`
  pill (fixed, above composer). Stream continues silently; scroll never yanked.
- Tapping the pill smooth-scrolls to latest and clears the flag.
- Auto-scroll after send happens only if the user was already near the bottom.
- `refresh()` replaces arrays (no per-token rerender of the whole tree: streaming
  deltas land in `AgentWorkStream`, chat messages update on run completion).
- Long content is capped (`pre` max-height 320px, scrollable; workstream shows
  last 5 with "Show N earlier steps").
