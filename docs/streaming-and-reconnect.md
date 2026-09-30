# Streaming and reconnect

Orlynx uses Server-Sent Events for the server-to-browser activity stream and normal authenticated HTTP requests for user commands.

The workspace bridge uses WebSocket because workspace control is bidirectional.

## Durable event contract

Every durable event carries stable identity including event ID, session, optional task/run/workspace IDs, monotonically increasing session sequence, type, timestamp and payload.

Provider/runtime output is normalized before the primary UI depends on it.

Secret-like payload values are sanitized before persistence and streaming.

## Replay

The client reconnects with:

~~~text
GET /v1/sessions/:id/events?after=<last-sequence>
~~~

The server replays missing durable events, then continues live delivery.

Stable event IDs and sequence numbers prevent duplicate visible work.

## Mobile recovery

When the browser returns online, foregrounds or regains focus, Orlynx refreshes authoritative session state and reconnects the event stream.

This is intended to survive:

- phone sleep;
- backgrounding;
- Wi-Fi/mobile-data changes;
- temporary browser suspension;
- API process restart.

The active server task does not depend on the browser staying open.

## Scroll behavior

Streaming follows the latest output only while the user remains near the bottom.

If the user scrolls upward, Orlynx stops auto-follow and exposes a New activity affordance instead of forcing the viewport downward.

## Investigation streaming

Orlynx ↔ Model diagnostic summaries are persisted as normal safe events and grouped by reflection identity into ordered Investigation sections.

The surface exposes observation, hypothesis/next check and evidence without exposing private hidden chain-of-thought.

## Partial assistant output

Direct model deltas stream as they arrive rather than buffering a complete answer and faking a typing animation.

Run snapshots preserve partial text for recovery.

## Event hygiene

Heartbeat/telemetry events do not become conversation clutter.

One logical tool retains one stable lifecycle in the UI. Replay must update/reconcile that object rather than create duplicates.

Large inline payloads are bounded; full large artifacts belong in dedicated stores/change sets instead of an unbounded chat event.

## Transport standard

Render is the production control plane. This document does not depend on Vercel stream-lifetime behavior.

If the hosting topology changes later, the durable event/replay contract should remain stable even if transport implementation changes.

## Recovery hardening, 2026-09-30

Run snapshots include updatedAt. The browser versions lifecycle transitions independently of partial text, ignores older snapshots and older replayed lifecycle events, removes obsolete queue placeholders, and settles running activities when an authoritative terminal snapshot arrives. Cursor allocation and event insertion are atomic across control-plane processes.
