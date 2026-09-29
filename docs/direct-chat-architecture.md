# Direct chat architecture

Direct chat is the low-latency Orlynx lane for conversation, Ask and Plan work that does not require mutable workspace execution.

It shares the same durable session/task/message model as Build.

## Why a direct lane exists

Starting compute is unnecessary for:

- greetings;
- explanations;
- repository questions answerable from bounded context;
- planning;
- status/capability questions.

Orlynx should not make every message wait for runner/Codespaces startup.

## Provider runtime

The API owns its production AI SDK dependencies and uses normal Node module resolution.

The build verifies compiled provider imports so packaging failures should surface during deployment rather than the user's first message.

## Model catalog

The direct lane uses the maintained models.dev/OpenCode catalog metadata packaged/refreshed by Orlynx.

The selected model's declared provider/protocol determines the transport. Orlynx should not guess a provider protocol solely from a model display name.

## Authentication

Credentials are read/decrypted server-side.

Free/public OpenCode models can use the public path when no account credential is required.

Account-authenticated models use the saved connection appropriate to that provider/path.

## Streaming

Provider deltas are streamed into the existing durable Orlynx run.

The API does not buffer a complete response and then fake token animation.

Partial text is checkpointed for recovery.

## Same-run continuation

If the user sends another natural follow-up while direct output is active:

1. the message is stored durably;
2. it is attached to the same run;
3. Orlynx feeds the new context back to the connected model before finalization;
4. the model continues rather than creating an acknowledgement-only conversation.

A late follow-up crossing the finalization boundary keeps/requeues the same task identity so it is not lost.

Explicit queue intent remains a separate task.

## Cancellation

Explicit Cancel aborts the active provider request and marks the durable task cancelled.

Abort/failure is never converted into successful completion.

## Resource behavior

History/context is bounded.

Repository-aware direct context is intentionally constrained so ordinary Ask/Plan does not clone or scan an entire repository by default.

Operational timing can record durations/identifiers but not prompts or secret values.

## Relationship to Build

When the request requires mutable execution, Orlynx routes it to the workspace lane.

Direct and workspace lanes share:

- session;
- message history;
- task identity;
- queue semantics;
- model/mode/access persistence;
- canonical event/recovery behavior.

The user should experience one conversation, not two products.
