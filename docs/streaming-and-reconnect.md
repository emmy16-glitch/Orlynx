# Streaming and reconnect

Orlynx uses SSE for the server-to-browser activity stream and normal authenticated HTTP requests for user commands. This matches the dominant direction of traffic while keeping task control explicit.

## Event contract

Every durable event contains:

```text
eventId
sessionId
taskId?
runId?
workspaceId?
sequence
type
timestamp
payload
```

Provider/runtime output is normalized before the primary UI renders it. The conversation shows summary → evidence → raw detail instead of dumping terminal output into chat.

Large inline event payloads are bounded. Raw-output-like fields are clipped or omitted rather than allowing a single tool response to grow the durable event stream without limit.

## Replay

The client reconnects with:

```text
GET /v1/sessions/:id/events?after=<last-sequence>
```

The API replays missing durable events, then continues the live stream. Event IDs and sequence numbers protect the UI from duplicate rendering.

## Mobile reconnect

The client uses bounded exponential reconnect delays:

```text
1s → 2s → 4s → 8s
```

The retry counter resets after a live connection/message.

When the browser:

- comes back online,
- returns to the foreground, or
- regains window focus,

Orlynx refreshes the session snapshot and reconnects from the latest cursor. This is specifically intended for phone sleep/background and Wi-Fi/mobile-data transitions.

The server emits SSE heartbeats and deliberately recycles long-lived Vercel streams before platform timeout; replay fills the gap.

## Scroll contract

If the user is already near the bottom, new activity follows naturally. If the user scrolls upward, Orlynx stops auto-scrolling and shows a New activity affordance. Streaming continues without stealing the reading position.

## Why not switch to WebSocket for chat activity

The execution bridge itself uses an authenticated WebSocket because it is bidirectional. The browser activity feed does not need that transport merely because the product is mobile-first: durable replay, heartbeats, cursor recovery and authoritative task state are the reliability requirements. SSE remains replaceable behind the event contract if future measurements show a transport problem.
