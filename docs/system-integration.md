# System Integration — actual behavior

One product surface over repository, agent, compute layers. No route split between
chat / Codespaces / agent / Git: `apps/web/src/App.tsx` owns five tabs
(Agent/Files/Changes/Preview/More) over ONE session object.

## Request path
`POST /v1/sessions` → session row (+`state.snapshot` event). `POST
/v1/sessions/:id/messages` (idempotent by `clientId`) → `startRun` (sync, native
engine) → `GET changes/files/messages/runs` refresh + SSE live events.

## Ownership
- Session/task/Git truth: API (`apps/api/src/store.ts` JSON file; Git via shell in `github.ts`).
- Workspace truth: `workspaces.ts` (local provider; Codespaces via REST only with `GITHUB_TOKEN`).
- UI truth: React state per session; `localStorage` holds only last-session pointer,
  per-session event sequence, and composer draft — never message content authority.
- Activity truth for presentation: canonical `OrlynxEvent` envelopes are reconciled
  by stable ID/sequence, then projected by `apps/web/src/ui/mapping.ts` into shared
  `ActivityEvent` rows. Summaries/evidence/raw receipts are three views of the same
  stream, not a second activity subsystem.

## Activity presentation boundary

SSE/tool/runtime payloads are not rendered directly in the main conversation.
The work stream shows action/outcome summaries first; an explicit expansion reveals
structured test/file/command evidence, and a separate control reveals raw output.
Run lifecycle transitions update stable rows. The scroll contract is documented in
`docs/chat-scroll-behavior.md`; adapter/event contract details are in
`docs/agent-activity-presentation.md`.

## What is NOT yet real
GitHub OAuth/App install, OpenCode/Cline process control (engine string only),
PTY terminal (command exec only), multi-device sync (localStorage is per-device),
durable object-backed raw receipts, and provider-supplied structured test/file
metadata. The current native agent remains a local simulation.
