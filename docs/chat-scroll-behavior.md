# Chat scroll behavior

Orlynx treats scroll position as user intent.

## Follow mode

When the reader is near the newest content, streamed assistant output and meaningful work can keep the page pinned to the latest point.

If the user scrolls upward, follow mode stops immediately.

Incoming output continues below and a New activity affordance returns the reader to the newest content.

Orlynx must never repeatedly yank the viewport downward while the user is reading older history.

## Streaming

Direct assistant deltas can update incrementally.

Activity/event batches are reconciled by stable identity.

Scroll behavior is based on rendered content and the user's position, not on whether a particular update was a token, tool event or status transition.

## Expansion

Typed tool details and Investigation blocks expand inline.

Only intentionally bounded detail regions such as long raw output or long Investigation content use their own internal scroll.

Expanding/collapsing detail must not forcibly reset the page position.

## Mobile keyboard

Visual viewport/keyboard changes do not count as user intent to jump to the bottom.

The composer remains usable above project navigation and safe-area insets.

## Accessibility

Meaningful milestones may be announced politely.

Individual tokens, telemetry and raw log lines are not screen-reader announcement spam.

Reduced-motion preferences are respected.

## Verification

Test:

- live follow while already at bottom;
- manual scroll upward during streaming;
- New activity action;
- long assistant message;
- Queue/Investigation expansion;
- keyboard open/close;
- rotation;
- 360/390/412px phone widths;
- desktop widths.
