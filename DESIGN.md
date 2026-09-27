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

- Canvas: #F7F5F1
- Elevated background: #FFFFFF
- Surface: #FFFFFF
- Muted surface: #EFEEE9
- Primary ink: #181B20
- Muted ink: #5F6874
- Subtle ink: #7D8794
- Border: #D9DDE3
- Strong border: #C4CAD2
- Primary CTA: #181B20
- Warm accent: #9A654A
- Warm accent surface: #F0E3DA
- Success: #2F7D66
- Warning: #B98434
- Danger: #C95555
- Working/info: #3F6FA8

## Core dark palette

- Canvas: #111318
- Elevated background: #15181E
- Surface: #191D23
- Elevated surface: #20252D
- Primary ink: #F5F7FA
- Muted ink: #AAB2BD
- Subtle ink: #7D8794
- Border: #2D333C
- Strong border: #3C4552
- Warm accent: #D5A585
- Success: #6CC4A4
- Warning: #E2B05A
- Danger: #E17A7A
- Working/info: #7AA2D1

Runtime tokens live in `apps/web/src/ui/tokens.css`. Durable changes to these values should update this file and the runtime tokens together. Product surfaces must use semantic tokens rather than hard-coded light-only colors.

## Typography

Headings and brand moments: Manrope 600–700.
Primary UI and long-form/chat text: Source Sans 3 400–700.
Code, commands, file paths and technical metadata: IBM Plex Mono 400–600.

The three roles should remain visibly distinct but balanced. Monospace is reserved for actual code/data, not as a general “technical” decoration. Use strong negative tracking only for major headings. Body text remains calm and readable.

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

Normal project UI exposes one compact AI control that opens a single, coherent selection surface for:
- Agent
- Model

Mode and access remain separate because they answer different questions:
- Mode: Build / Plan / Ask
- Access: Full project access / Ask first / Read only

Do not use long native browser selects for agent/model choice. The control must show the current agent and model, expose adapter readiness truthfully, and scale cleanly when additional agents are added.

OpenCode account/provider details belong inside the AI management surface or advanced settings. The main workspace should present the user-facing agent name and current state, not infrastructure jargon.

## Activity

The Chat tab is the execution surface. Conversation and observable agent work are one chronological transcript rather than separate chat and “activity” panels.

For Build, Plan and Ask, preserve every observable event the product receives in order. Typical transcript labels include **Thought**, **Repository**, **Read**, **Search**, **Run command**, **Run tests**, **Build**, **Edit**, **Git**, **Workspace**, **Approval**, **Error**, **Response** and **Status**.

“Thought” is a short user-visible progress/status summary supplied by the agent or Orlynx orchestration. It is never private chain-of-thought or hidden model reasoning.

For repository-aware Ask/Plan turns, Orlynx should not present itself as reading only a small “context” bundle. It builds a recursive map of the current branch, understands the major project areas and entry points, and then loads representative/relevant source excerpts across that whole map. The transcript presents this as **Repository · Understanding repository**, not “Read context.” Large repositories remain bounded for model latency, so structural understanding can cover the whole tree while source contents are selected intelligently rather than pretending every byte fits into one model request.

The transcript contract is:

- user messages, execution events and assistant responses share one ordered timeline;
- command/file/tool input is visible when known;
- stdout/stderr streams into the active command block while it is running;
- file edits and diffs remain attached to the action that produced them;
- retries, provider/workspace transitions and failures remain visible where they occurred;
- completed history stays scrollable instead of being overwritten by the current status;
- the newest active action is visually emphasized without hiding earlier actions;
- follow-up messages can be submitted while work is running and appear as queued turns without erasing the current streamed response;
- a normal informational status must not use danger/red presentation; red is reserved for an actual failure requiring attention.

Detailed execution is the default presentation. A concise Summary view may remain available as an optional user choice, but it must not change or discard the underlying event history.

Model response text streams directly into the assistant message. Do not duplicate every token as activity rows. Technical output, tool events, status summaries, errors, commands, files, diffs and lifecycle transitions belong in the observable transcript.


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
