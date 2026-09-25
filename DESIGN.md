# Orlynx Design System

## Product model

Orlynx is a mobile-first GitHub-native AI coding workspace. The primary user loop is:

Connect GitHub → choose repository → chat with Orlynx → observe useful work → review files/changes → approve and push → continue.

The public interface is organized around the user's job, not infrastructure. GitHub App internals, OpenCode, workspace bridges, runtime servers, provider adapters and deployment configuration stay out of the normal product UI.

## Approved visual reference

The approved 12-screen Orlynx flow supplied on 2026-09-24 is the primary visual source of truth.

Key screens:
1. Landing
2. GitHub authorization handoff
3. Repository access selection
4. GitHub confirmation
5. Returning/syncing to Orlynx
6. Repository picker
7. Chat-first project workspace
8. Live agent activity
9. File browser
10. Changes review
11. Commit/push
12. Success

## Visual character

Quiet, warm, premium, developer-focused, trustworthy.

Avoid:
- purple AI SaaS styling
- neon/cyberpunk
- glassmorphism-heavy surfaces
- dashboard clutter
- random colored cards
- technical infrastructure language in normal UI

## Core light palette

- Canvas: #FBF8F3
- Elevated background: #FFFDF9
- Surface: #FFFDFA
- Muted surface: #F4EFE8
- Primary ink: #1D1C1A
- Muted ink: #716D67
- Subtle ink: #9A948D
- Border: #E5DED5
- Strong border: #D4C9BD
- Primary CTA: #242321
- Warm accent: #8A6247
- Warm accent surface: #F3E3D3
- Success: #2F9F69
- Warning: #C98935
- Danger: #D75A54
- Working/info: #3D78C5

Runtime tokens live in `apps/web/src/ui/tokens.css`. Durable changes to these values should update this file and the runtime tokens together.

## Typography

Primary UI: Inter/system sans stack.
Code/data: SFMono/Consolas/Liberation Mono/Menlo.

Use strong negative tracking only for major headings. Body text remains calm and readable.

## Geometry

- Buttons: 11–13px radius
- Standard controls/cards: 11–16px
- Sheets/major containers: 18–22px
- Pills: full radius
- Shadows: extremely soft and sparse

Use spacing and dividers before adding cards.

## Navigation

First run: no global dashboard navigation.

After GitHub connection: repository picker.

Inside a project, mobile primary navigation is:
- Chat
- Files
- Changes
- More

Repository switching belongs in the project header. Settings, Terminal, Preview and advanced workspace controls belong under More or contextual actions.

## AI controls

Normal project UI exposes:
- Model
- Mode: Build / Plan / Ask
- Access: Full project access / Ask first / Read only

OpenCode is an implementation detail and belongs only in advanced diagnostics/settings.

## Activity

Main conversation shows observable work, not private reasoning. Build mode is deliberately transparent: the user should be able to follow commands, files, patches, tests and resulting state without opening a separate IDE.

The activity stream has two remembered presentation modes:

- **Summary** — concise human progress with details on demand.
- **Code** — automatically reveals observable command/file/code evidence while work runs. Build uses this as the fresh-user default; Plan and Ask stay summary-first unless the user has chosen otherwise.

Both modes keep the same evidence hierarchy:

Layer 1: concise human progress and one clearly emphasized current step.
Layer 2: structured execution evidence — command, path, changed files, bounded code/diff snippets, exit/test results.
Layer 3: raw stdout/stderr behind explicit progressive disclosure.

Queue labels must describe what is waiting when Orlynx knows it (for example, waiting to run tests or a Git command) rather than using generic “Action is queued” copy. Completed history is visually quieter than the one current step. Technical detail is evidence of observable work; private reasoning is never shown.

## Interaction states

Always design explicit:
- disconnected
- connecting
- loading
- ready
- working
- waiting for input
- waiting for approval
- reconnecting
- failed
- completed
- offline/recovery

## Mobile behavior

Mobile is first-class. Preserve:
- safe areas
- visible composer above keyboard
- stable scroll position during streaming
- bottom-sheet selectors
- large touch targets
- system/browser back behavior
- no horizontal overflow

## Source hierarchy

When design sources disagree:
1. Current explicit product requirement
2. Approved Orlynx flow mockup
3. This DESIGN.md
4. Shared Orlynx primitives/tokens
5. External inspiration such as BeautifulUI, 21st.dev, BeUI, Rare UI, Transitions.dev or shadcn

External references may improve component craft and motion but must not change Orlynx's approved visual direction.
