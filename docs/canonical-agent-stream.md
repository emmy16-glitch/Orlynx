# Orlynx agent protocol + conversation architecture (v2)

Orlynx conversations are produced by a server-authoritative canonical agent
protocol and projected in the browser as a thread of turns with typed message
parts. Raw provider/bridge/workspace events never dictate UI behavior
directly.

```text
RawProviderEvent
      ↓  AgentAdapter (server boundary)
OrlynxEvent / EventType (canonical protocol v1)
      ↓
Session/EventStore (durable, sequenced, idempotent)
      ↓
SSE / snapshot replay
      ↓
StreamProjectionEvent (browser-private reducer action)
      ↓
ThreadProjection (turns owned by run IDs)
      ↓
Typed message parts
      ↓
Part renderer registry
      ↓
Conversation UI
```

The implementation is original Orlynx code. Architectural patterns were
studied in AG-UI, ACP, Cline, OpenHands, assistant-ui/tool-ui, LangGraph
Agent Chat UI and Bolt.diy/E2B Surf; no third-party source is copied into
this repository. See "Design influences" at the end.

## Agent protocol boundary

`packages/shared/src/index.ts` declares the versioned vocabulary:

- `CANONICAL_PROTOCOL_VERSION = 1`.
- `EventType`: run lifecycle (`run.queued/started/completed/failed/state`),
  messages (`message.start/delta/end`), tools
  (`tool.requested/started/progress/output/completed/failed`), terminal
  (`terminal.started/output/exited`), files (`file.changed/files.changed`),
  results (`test.result/build.result`), preview (`preview.ready/state`),
  delegation (`subagent.started/finished`), permissions
  (`permission.request/resolved`, `approval.required/resolved`), workspace
  (`workspace.*`), state (`state.snapshot/delta`), product
  (`changes.updated/receipt.created`) and `extension.event`.
- `AgentAdapterCapabilities` in shared describes portable capabilities.
- The single production provider contract is `AgentAdapter` in
  `apps/api/src/agent-runtime.ts`. OpenCode implements that contract today;
  a future ACP-compatible adapter can implement the same operational surface
  without changing thread rendering or the durable protocol.

`apps/api/src/agent-protocol.ts` is the server-side adapter:

- `normalizeBridgeEvent(type, payload)` maps provider event names to canonical
  durable types. Unknown provider events become `extension.event` carrying
  `sourceType` + payload — semantics are preserved for debug/telemetry and
  never silently flattened into generic progress.
- Heartbeats (`heartbeat`, `ping`, adapter/bridge heartbeats) are telemetry and
  are never persisted as history.
- `scopeToolCallId(runId, rawId)` keeps provider tool-call IDs namespaced per
  run, so call id `"1"` in run A can never merge with call id `"1"` in run B.

## Bridge preserves semantics

`apps/api/src/bridge-gateway.ts` canonicalizes every bridge `EVENT` frame
through `normalizeBridgeEvent` before appending to the durable ledger. The old
behavior — an allowlist of ~7 types with everything else collapsed into
`activity.progress` — is gone. Terminal output, file changes, test/build
results, preview readiness, permission requests and subagent lifecycles each
persist under their own canonical type.

## Session / event store / transport

- The durable `OrlynxEvent` ledger (Postgres in production, bounded JSON
  fallback in development) is the source for recovery and audit.
- Every event has a stable `eventId` and a monotonically increasing session
  `sequence`. SSE (`/v1/sessions/:id/events?after=<sequence>`) is the hot
  path; reconnect replays missed events without duplicates.
- `apps/api/src/events.ts` bounds inline payloads so runaway command output
  cannot exhaust storage or mobile browsers; full diffs live in change sets.
- Recovery model: `snapshot at sequence N + events N+1… = current state`.
  `reconcileAgentStream()` applies durable run snapshots (partial text, run
  state) only when they are newer than live SSE state — a stale snapshot can
  never rewind fresher streamed text.

## Browser: adapter → store → thread → parts

`apps/web/src/agent-stream/`:

- `adapter.ts` — the browser projection boundary. It maps the single shared
  canonical `OrlynxEvent` vocabulary into private reducer actions and also
  carries compatibility for pre-v1 durable history. New server events already
  contain semantic identities/types; provider inference belongs at the server
  adapter/bridge boundary, not in React.
- `store.ts` — deterministic reducer. One logical tool owns one lifecycle
  (`TOOL_START → TOOL_UPDATE* → TOOL_END`) mutating in place; workspace
  startup/recovery owns one activity; infrastructure heartbeats stay
  state-only while actionable failures (`Model unavailable`, `AI connection
  needs attention`, `Connection issue`) surface once and resolve in place.
  Event IDs make replay idempotent; sequence (not timestamp) orders text.
- `thread.ts` — thread projection. Each run owns its message stream, tool
  calls, activities and result, grouped by `runId`/`userMessageId` — never by
  timestamp merging alone. Overlapping runs (direct + workspace) keep
  separate bubbles and separate work lists.
- `parts.ts` — typed message parts: `terminal`, `file-change`, `file-read`,
  `test-result`, `build-result`, `git`, `preview`, `approval`, `error`,
  `status`, `generic`. Pure classifier, unit-tested.
- `view.ts` — canonical selectors (`selectActivities`, `selectLiveReplies`).
  React performs no raw-event switching.

`apps/web/src/ui/tool-parts.tsx` is the renderer registry: each part kind
gets a purpose-built collapsed row plus a typed detail panel (terminal shows
command + bounded output; tests show pass/fail counts with failures first;
file changes show per-file actions + diffs; approvals stay interactive).
`generic` is fallback only, never the default. Every expandable row exposes
a persistent chevron (`aria-expanded`/`aria-controls`), raw output is
bounded (~220–320px, internal scroll, copy-safe), and only the current
running part animates — completed rows are static. Reduced motion is
respected.

`ProductionApp.tsx` renders thread turns: user message → assistant response
(live stream or durable text) → compact supporting work → message actions
(`Copy / Retry|Resume / ⋯`). Sending (`submitting`) and running (work bar
with `■ Stop`) are separate states; Stop waits for backend cancellation.

## Runtime / Preview boundary

Runtime execution is not the conversation. Preview has one source of truth:
the workspace's live forwarded-port state (`/ports` → usable previews →
Preview tab, `View preview` action, external open). Chat server-ready state
never guesses readiness from a string, process death invalidates Ready, and
the forwarded URL (never remote `localhost`) is what the user opens.

Direct (instant) chat bypasses workspace startup entirely; Build tasks
acknowledge immediately (`Preparing workspace`) while the warm Render runner
(or Codespaces fallback) prepares. Ask/plan modes never touch mutable
runtime state.

## Migration

No destructive event-history migration was performed. Legacy durable events
flow through the compatibility adapter into the same canonical store; new
sessions emit the canonical vocabulary directly from the server. The old
timestamp-merged timeline (`buildConversationTimeline`) and the single
generic activity row remain available only as compatibility exports — the
transcript no longer uses them.

## Design influences

- AG-UI: small canonical run/message/tool/state lifecycle, stable IDs,
  extension/custom events instead of silent drops.
- ACP: explicit agent boundary (sessions, tool calls/results, permissions,
  cancel/resume, capability negotiation) with OpenCode as one adapter.
- Cline: agent execution separated from session/core state and transport;
  the chat component is not the orchestrator.
- OpenHands: runtime actions/observations exist independently of how they
  are presented.
- assistant-ui/tool-ui: conversation-first threads, typed message parts,
  structured per-tool renderers with progressive disclosure.
- LangGraph Agent Chat UI: resumable streams, re-attachment, snapshot +
  idempotent replay recovery.
- Bolt.diy/E2B Surf: chat → code work → terminal → dev server → Preview →
  chat is one workflow with one Preview source of truth.

What Orlynx intentionally does differently: the canonical vocabulary is
persisted server-side in the existing durable `OrlynxEvent` ledger (no new
database or transport was introduced), identity scoping and thread
projection live beside the current SSE/snapshot recovery model, and
Preview/runtime truth stays outside the chat event protocol entirely.


## Current conversation extensions (2026-09-29)

The current protocol projection also preserves same-run user continuation.

Multiple durable user messages can carry the same runId when they genuinely steer one active task, but each human message projects as its own chronological visual turn. Work is attached beneath the human message that was current when the work happened, and the live/final response stays beneath the newest message in that run. This keeps the transcript stable while streaming instead of collapsing later messages upward and reorganizing after completion.

Referential continuation such as “any update?”, “finish it”, “check again” and “also…” stays on the active run. An unrelated new request is a distinct turn; if earlier work is still unresolved, the scheduler queues it behind that work rather than silently merging the two requests. Explicit queue language still forces next-task intent.

### Investigation grouping

Safe reflection dialogue uses source types agent.dialogue.orlynx and agent.dialogue.model with a reflectionId.

The browser groups matching dialogue into one ordered Investigation N status part.

This surface carries useful observation/hypothesis summaries without exposing private hidden chain-of-thought.

### Secret sanitization

Canonical event persistence sanitizes secret-like values before writing the durable ledger.

Historical events are sanitized again before replay/reflection, so old unsafe payloads are not blindly reintroduced into current model context.

### Adapter failure isolation

Agent-adapter state events remain distinct from workspace state.

An unavailable OpenCode adapter can surface one actionable status without changing a ready workspace into a failed workspace.

### Cross-device replay

Conversation restore starts from server-owned GitHub-user sessions. A fresh device can rebuild its thread from durable messages/run snapshots/activity history even when localStorage has no prior session pointer.
