# Streaming and reconnect

Orlynx uses Server-Sent Events (SSE) for server-to-browser activity and authenticated HTTP for user commands.

The execution bridge uses a separate authenticated WebSocket because workspace control is bidirectional.

## Event contract

Every durable event contains the equivalent of:

~~~text
eventId
sessionId
taskId?
runId?
workspaceId?
sequence
type
timestamp
payload
~~~

Provider/runtime output is normalized before the main UI depends on it.

The conversation shows useful summary and structured evidence first; raw output is progressively disclosed.

## Persistence and sanitization

Events are persisted under stable IDs and monotonically increasing per-session sequence numbers.

Before persistence/streaming, secret-like values are sanitized recursively.

Historical events are sanitized again before replay/reflection.

Large inline payloads are bounded so one runaway command cannot grow the durable event stream indefinitely.

## Replay

The client reconnects with:

~~~text
GET /v1/sessions/:id/events?after=<last-sequence>
~~~

The API replays missing durable events and then continues live streaming.

Stable event IDs and sequence ordering protect the UI from duplicate work rows and out-of-order text.

The recovery model is:

~~~text
authoritative session/run snapshot
+ events after the snapshot cursor
= current presentation
~~~

A stale snapshot must not rewind fresher streamed state.

## Direct-model streaming

Ask/Plan direct chat uses the same durable project conversation.

Model deltas are streamed as they arrive rather than fully buffering a response and animating it later.

If the user sends a natural follow-up while the model is still answering, Orlynx can feed that update back into the same run before finalization.

A late update that arrives near the finalization boundary is preserved rather than silently discarded.

## Workspace streaming

Workspace execution events flow:

~~~text
agent/runtime
   ↓
workspace bridge
   ↓
server canonicalization + sanitization
   ↓
durable event ledger
   ↓
live SSE broadcast
   ↓
browser thread projection
~~~

The live in-process path provides low latency.

Durable replay remains the recovery path after restart, reconnect or cross-instance routing.

## Investigation streaming

Reflection/diagnostic dialogue is represented through ordered Investigation identity.

The browser groups Orlynx/model diagnostic messages by reflection ID into Investigation 1, Investigation 2, and so on.

These contain useful observation/hypothesis/correction information, not private hidden chain-of-thought.

## Mobile reconnect

When the browser comes back online, returns to the foreground, regains focus or reloads, Orlynx refreshes authoritative session state and reconnects from the latest known cursor.

This is designed for phone sleep, app backgrounding and Wi-Fi/mobile-data transitions.

## Scroll contract

Streaming must not make old messages unreadable.

If the user is near the bottom, new content follows naturally.

If the user scrolls upward:

- auto-follow stops;
- streaming continues;
- the viewport is not yanked downward;
- a New activity affordance can return to the newest content.

Returning near the bottom re-enables normal follow mode.

## Why SSE remains appropriate

The browser activity flow is primarily server-to-client.

The reliability requirements are durable replay, stable event identity, heartbeats, recovery after backgrounding and authoritative task state.

SSE satisfies those requirements without coupling browser chat transport to workspace WebSocket semantics.

The transport remains replaceable behind the canonical event contract if future production measurements justify a change.

## Verification checklist

A release touching streaming should test:

1. first-token live delivery;
2. direct-chat cancellation;
3. same-run follow-up during streaming;
4. late follow-up near finalization;
5. browser reload during a run;
6. API restart/reconnect;
7. duplicate event replay;
8. scroll-up while streaming;
9. return-to-latest behavior;
10. secret redaction in live and historical payloads.
