# Canonical agent stream architecture

Orlynx no longer lets raw runtime/provider events define the chat UI.

The browser now consumes one Orlynx-owned canonical agent stream inspired by
the strongest common patterns in AG-UI, Cline, OpenHands, assistant-ui/tool-ui
and similar open agent interfaces. The implementation is original Orlynx code;
no third-party source is copied into this repository.

## Why this exists

The old UI projection had gradually become a second event engine:

```text
raw SSE event
  -> large switch in mapping.ts
  -> separate live-reply reducer
  -> activity rows
  -> React transcript
```

That made lifecycle identity easy to lose. A single logical tool could have
requested/started/output/completed fragments, workspace heartbeats could turn
into chat history, and live text had a different reducer from tool activity.

The new boundary is:

```text
durable OrlynxEvent ledger / SSE replay
              |
              v
      provider compatibility adapter
      apps/web/src/agent-stream/adapter.ts
              |
              v
       CanonicalAgentEvent
              |
              v
      deterministic stream store
      apps/web/src/agent-stream/store.ts
              |
              +---------------------+
              |                     |
              v                     v
       activity selector       live-text selector
              |                     |
              +----------+----------+
                         v
                      React UI
```

The durable backend event ledger remains the source for recovery and audit.
The canonical stream is the browser's semantic projection.

## Canonical lifecycle

The browser understands a deliberately small event vocabulary:

- run: `RUN_QUEUED`, `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`
- assistant text: `TEXT_START`, `TEXT_CONTENT`, `TEXT_END`
- tools: `TOOL_START`, `TOOL_UPDATE`, `TOOL_END`
- process activity: `ACTIVITY_START`, `ACTIVITY_UPDATE`, `ACTIVITY_END`
- workspace: `WORKSPACE_STATE`
- state: `STATE_SNAPSHOT`, `STATE_DELTA`
- product results: `CHANGES_UPDATED`, `RECEIPT`, `APPROVAL`

Provider-specific event names stop at the adapter.

## Stable identity

Identity is the core contract.

- a run owns its response message;
- a response message owns one incremental text stream;
- a tool call owns one tool lifecycle;
- provider tool-call IDs are scoped to the run;
- workspace startup/recovery owns one workspace activity;
- infrastructure state has one semantic identity per scope.

An update mutates the same semantic object. It does not create a new chat card.

## Streaming

SSE remains the hot transport. Events are still batched once per animation
frame by `ProductionApp.tsx`.

Text ordering uses the durable session sequence, not timestamps. Multiple chunks
can therefore share one timestamp without being dropped. Replayed event IDs are
idempotent.

A direct response and a workspace response can overlap without concatenating:
each run has its own canonical message stream.

HTTP run snapshots are recovery only. `reconcileAgentStream()` will extend an
older stream when the snapshot is newer, but an older snapshot cannot rewind
newer SSE text.

The transient stream is removed only after the durable assistant message exists.

## Tools and progress

Tool events follow one lifecycle:

```text
TOOL_START
   |
TOOL_UPDATE  (0..n)
   |
TOOL_END
```

The same tool row evolves in place. Raw output stays attached to that tool and
is bounded in the browser projection so runaway terminal output cannot freeze a
mobile device. The durable ledger retains the source events.

Provider progress is normalized into semantic phases. Low-level provider status
names do not create an activity per tick.

## Infrastructure versus conversation

Steady infrastructure is state, not chat:

- adapter ready heartbeat: hidden
- bridge connected heartbeat: hidden
- state snapshot: hidden
- message stream start/end markers: hidden

Actionable failures become semantic UI:

- AI runtime unavailable
- model unavailable
- AI connection needs attention
- connection issue

Recovery updates the same object instead of adding another error/success pair.

## UI projection

The UI selector exposes:

1. persisted user/assistant messages;
2. live assistant messages;
3. compact semantic activity rows.

Technical evidence remains inspectable. Any row with evidence has a permanently
visible chevron disclosure in its title row. Details are collapsed by default,
and raw output stays in a bounded internal scroller.

The main transcript no longer uses the words "Thought" as a label for generic
agent activity. Generic safe process state is labelled "Working"; no hidden
chain-of-thought is exposed.

## Scroll and composer

The existing smart live-follow model remains intact:

- while the user follows the live edge, streaming content stays in view;
- intentional upward scrolling pauses follow;
- new content does not drag the user back;
- returning to the live edge resumes follow.

The compact expanding composer and its Send/submitting/Stop state machines are
independent of stream state.

## Preview

Preview remains a sibling runtime projection rather than part of the chat event
protocol. Its source of truth is the workspace's live forwarded-port state.
Build activity can cause faster reconciliation, but the Preview tab never
guesses readiness from a chat string.

## Compatibility and migration

The backend still emits the current durable `OrlynxEvent` taxonomy. This lets
the new frontend architecture land without a destructive database/event-schema
migration.

`apps/web/src/ui/mapping.ts` is now only a compatibility facade. New streaming
behavior belongs under `apps/web/src/agent-stream/`.

A later backend protocol version can emit the canonical lifecycle directly. At
that point the compatibility adapter can become much smaller without changing
React or the stream store.

## Design influences

The architecture combines ideas rather than cloning one project:

- AG-UI: explicit run/text/tool/state lifecycle and stable IDs;
- Cline: session orchestration separated from agent/runtime events;
- OpenHands: runtime events separated from client presentation;
- assistant-ui/tool-ui: message-first UI, structured tools and progressive
  disclosure;
- modern coding-agent clients: durable recovery, resumable streams, compact
  execution evidence and a conversation-first hierarchy.

The Orlynx backend durability, Render warm runner, OpenCode bridge, Preview
gateway and repository safety model remain Orlynx-specific.
