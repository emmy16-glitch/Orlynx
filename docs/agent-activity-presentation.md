# Agent activity presentation

The current conversation renderer is based on the canonical Orlynx event protocol, thread projection and typed message parts.

Historical AgentWorkStream/TaskActivityRow paths may remain as compatibility surfaces, but they are not the source of truth for the current transcript.

See canonical-agent-stream.md.

## Experience contract

The default view should answer:

- what is happening?
- what changed?
- did it work?
- does it need me?

Detailed evidence is progressively disclosed.

The conversation is not a raw terminal transcript.

## Typed parts

Current activity can be projected into typed parts such as:

- terminal;
- file change/read;
- test result;
- build result;
- Git;
- Preview;
- approval;
- error;
- status;
- generic fallback.

One logical tool owns one stable UI lifecycle.

Repeated output updates the same object rather than adding a card for every event.

## Investigation blocks

Safe reflection dialogue is grouped into ordered Investigation sections.

An Investigation can show:

- Orlynx observation;
- connected model hypothesis/next check;
- evidence from actual tools;
- later correction.

Private hidden chain-of-thought is never rendered.

## Adapter/runtime status

Normal ready/heartbeat status remains quiet.

Actionable failures become visible.

When the adapter returns to ready, resolved infrastructure noise should disappear instead of permanently cluttering the transcript.

“AI runtime unavailable” refers to adapter health, not total workspace loss.

## Evidence

Useful evidence can include:

- command;
- file/path;
- bounded output;
- changed files;
- test counts/failures;
- build result;
- Preview URL/state;
- Git/publication receipt.

Large raw output is bounded and only exposed intentionally.

## Replay

Durable event IDs and per-session sequence make replay idempotent.

A reconnect must not turn one logical tool into multiple visible activities.

## Secret hygiene

Event payloads are sanitized before persistence/streaming and again when historical evidence is replayed.

UI rendering should never depend on displaying credentials.

## Scroll

Streaming follows the latest content only when the reader remains near the bottom.

Reading history disables auto-follow until the user returns to the latest point.

## Completion

Progress text is not a final answer.

Where the task has inferred acceptance criteria, completion should correspond to actual verification evidence.
