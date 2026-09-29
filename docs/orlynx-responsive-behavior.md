# Orlynx responsive behavior

Orlynx is mobile-first but not mobile-only.

## Intent

Wide screens may expose repository/context information beside the conversation.
Phones keep the project focused on the current task.

## Project navigation

The current compact project navigation is:

~~~text
Chat · Files · Changes · More
~~~

Preview and Terminal are contextual surfaces reached through More/project controls rather than permanent extra bottom tabs.

## Mobile

At narrow widths:

- one primary content column;
- composer remains reachable above safe-area navigation;
- queue tray fits within the viewport;
- Investigation blocks use bounded internal scrolling;
- long paths/output cannot create horizontal page overflow;
- file/change details become one-at-a-time flows;
- keyboard resize must not force the conversation to the bottom;
- streaming auto-follow stops as soon as the user intentionally scrolls upward.

## Desktop

Desktop may show a persistent navigation rail and additional context, but Chat remains the primary project work surface.

Do not turn wider layouts into a VS Code clone or infrastructure dashboard.

## Cross-device continuity

Responsive layout and conversation identity are separate concerns.

The same server-owned project session must restore on phone, tablet or laptop after the same GitHub user authenticates.

## Required manual viewport checks

At minimum verify:

- 360px;
- 390px;
- 412px;
- 768px;
- 1024px;
- 1280px;
- 1440px.

Also verify:

- keyboard open/close;
- orientation change;
- long streamed answer;
- reading old content while streaming;
- Queue edit/cancel;
- Investigation expansion;
- approvals;
- Preview;
- reconnect after background/sleep.
