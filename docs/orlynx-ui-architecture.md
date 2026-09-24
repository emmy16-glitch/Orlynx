# Orlynx UI architecture

## Product model

Orlynx is not an infrastructure dashboard. The primary user journey is:

```text
Connect GitHub
→ choose repository
→ enter project conversation
→ ask Orlynx to work
→ watch useful activity
→ review files/changes
→ approve publication
```

Implementation concepts such as OpenCode, Codespaces, bridge processes and GitHub
App credentials remain behind the product experience.

## First run

A disconnected user sees a simple GitHub connection path. The full workspace
navigation is not useful until a repository is available.

GitHub consent happens on GitHub. Orlynx uses the resulting installation to list
only authorized repositories.

## Project shell

The project is chat-first. Mobile primary navigation is:

- Chat
- Files
- Changes
- More

The project header keeps repository and branch context visible. Preview, Terminal,
workspace controls and Settings are contextual or live under More instead of
competing with Chat as top-level destinations.

On larger screens Orlynx may expose more context simultaneously, but it should not
turn the product into a dashboard of infrastructure modules.

## State and API boundaries

| UI flow | Real integration | Source of truth |
| --- | --- | --- |
| Restore/open project | `GET /v1/sessions`, `GET/POST /v1/sessions` | Postgres session/user state in production |
| Chat + activity | message routes + SSE | durable messages/tasks/events |
| AI model/mode/access | `/v1/ai/*` | durable session preferences + real OpenCode/provider state |
| Files/code | session file routes | GitHub when no workspace, workspace bridge when ready |
| Changes/review | change-set routes | durable change sets + real workspace Git |
| Publish | `POST /v1/changes/:id/push` | real GitHub push/PR result |
| GitHub picker | GitHub App routes | live authorized installation repositories |
| Attachments | multipart session route | durable metadata + workspace transfer |
| Cloud | session cloud routes | GitHub Codespaces + durable workspace state |
| Preview | session ports | real workspace bridge port discovery |
| Terminal | session terminal routes | real PTY in workspace bridge |

## Session continuity

localStorage may remember drafts, theme and a recent session pointer, but it is not
server truth. Orlynx refreshes recent sessions from the authenticated user's
durable account state and can recover the latest project on another device.

AI model/mode/access preferences are also stored server-side per session.

## Streaming

The browser consumes ordered SSE events with replay by sequence. If the user
scrolls away from the bottom, Orlynx does not force the viewport down; new activity
continues below and a New activity affordance returns to the latest point.

On online, focus and foreground transitions the client reconnects and refreshes the
authoritative session snapshot.

## Errors and recovery

Normal users see capability-oriented recovery:

- Connect/Reconnect GitHub
- Connect AI
- Start/Retry workspace
- Review changes
- Retry publication

Operator concepts such as environment variables, app private keys, bridge tokens
or OpenCode server URLs do not belong in normal product copy.

Production failures remain fail-closed; simplifying the UI must never mean
pretending a provider succeeded.

## Accessibility and performance

Controls use touch-sized targets, visible focus, semantic labels and text alongside
status color. Activity updates are batched; history/raw-output views are bounded;
screen readers should receive milestone announcements rather than token/log spam.
