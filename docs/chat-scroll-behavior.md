# Chat Scroll Behavior

The conversation and activity work stream scroll with the page (`window`), not a
nested chat container. This keeps touch scrolling natural and allows the mobile
keyboard and viewport to resize without trapping the composer in a second scroller.

## Follow mode

- A passive `window` scroll listener measures the distance to the page bottom.
- At less than 140px, the reader is considered near the latest content.
- Event reconciliation and React state updates are batched to one animation frame.
- New activity follows the page only if the reader was already near the bottom.
- Scrolling upward disables follow immediately. Incoming work continues below and
  the user gets a “↓ New activity” button instead of a forced scroll.
- Tapping that button smoothly scrolls to the latest content and clears the
  indicator. Returning close to the bottom resumes follow mode.
- Message send only scrolls when follow mode was already active.

The scroll listener does not react to every streamed token because assistant text
is committed as a message rather than a per-token event in the current adapter.
Meaningful stream event batches update the activity projection; unchanged IDs are
ignored before rendering.

## Expansion and output

Activity details expand inline to avoid replacing or resetting the chat viewport.
Only raw output becomes its own scrollable surface, only after an explicit user
action, and it has a bounded maximum height. Long code and output wrap safely.
Collapsing details does not invoke page scroll. Browsers preserve native keyboard,
rotation, and visual viewport behavior; viewport resize itself never triggers an
auto-scroll.

## Mobile and accessibility

The new-activity button sits above the composer and bottom tabs. Status is in the
sticky header rather than a floating overlay, keeping the composer unobstructed.
Touch controls retain minimum target sizing, status copy is textual (not color-only),
and the latest meaningful failure/completion is announced politely without
announcing raw log lines or individual tokens. Reduced-motion settings are
respected.

## Manual verification checklist

- Stay at bottom during activity and confirm follow mode.
- Scroll upward during activity; confirm no yank and the new-activity button.
- Tap new activity and verify return to bottom.
- Expand/collapse rows above and below the viewport.
- Open long raw output and confirm only that block scrolls.
- Check 360/390/412px layouts, keyboard open/close, orientation change, and
  desktop widths. Browser automation/device coverage is not currently configured.
