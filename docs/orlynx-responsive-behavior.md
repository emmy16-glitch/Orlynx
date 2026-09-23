# Orlynx Responsive Behavior

## Breakpoint intent

| Width | Layout |
| --- | --- |
| 1500px+ | desktop project rail, center conversation, contextual right column |
| 1201–1499px | desktop project rail + center workspace; optional context column hidden |
| 851–1200px | tablet/workstation: global rail, centered project work area, no right panel |
| 561–850px | mobile/tablet: rail becomes bottom navigation; workspace tabs remain visible |
| 320–560px | narrow phone: stacked forms/cards, compact chat, one-column lists and details |

These boundaries are in `apps/web/src/styles.css`. Content uses min-width:0,
wrapping/truncation, and scroll-bounded code/log areas to prevent long paths and
commands from introducing horizontal page overflow.

## Desktop

- The left rail remains at 254px with global navigation and recent projects.
- Repository/branch, search, cloud action, and profile action sit in the workspace
  header; project navigation is a horizontal secondary row.
- Chat and project views occupy the center; the right column summarizes cloud,
  repository, changes, and preview. It disappears instead of becoming a permanent
  third-party dashboard on smaller screens.
- The composer aligns to the workspace's content region and does not cover the
  contextual panel.

## Mobile and keyboard

- The global rail is replaced by Home/Projects/Agents/Cloud/Settings bottom nav on
  global screens. A project uses Chat/Files/Changes/Preview/More tabs; Terminal is
  inside More so the conversation tabs stay easy to reach.
- Tabs and bottom navigation reserve the device safe-area inset. The composer is
  pinned above project navigation; its text field shrinks before actions do.
- Context moves into dedicated Cloud/Changes/Preview views instead of squeezing a
  desktop side panel into a phone column.
- Repository selection, settings, commit confirmation, file list, and diff details
  become one-column / one-file-at-a-time flows.
- Chat page scroll follows only when already near the latest content; the keyboard
  and orientation do not initiate an auto-scroll. See
  [`chat-scroll-behavior.md`](chat-scroll-behavior.md).

## Density and touch

Use 44px action targets, full-width primary actions on narrow forms, 12–16px
content gutters, and no forced split diff. Status remains text + symbol, not color
alone. Raw logs and terminal output get an independent max-height only when
explicitly opened. Long text wraps; paths can break anywhere without widening the
page.

## Verification status

The production build covers all CSS/TS. Automated registry tests protect component
presence; no browser automation/emulator is configured. A visual device pass should
check 360, 390, 412, 768, 1024, 1280, and 1440px, keyboard open/close, rotation,
scroll follow, long paths, and external preview frame sizing before release.
