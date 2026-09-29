# Session lifecycle

An Orlynx session belongs to an authenticated user and project, not to a browser tab, one phone or one execution workspace.

The durable project conversation is intended to survive browser reloads, device changes, API restarts and workspace-provider changes.

## Session identity

A project session connects the authenticated user, project/repository, GitHub authorization, working branch, message history, task/run history, model/mode/access/agent preferences, optional workspace, normalized events, approvals/change state and learned repository context.

Production truth is persisted server-side in Postgres.

## Creation and restore

Opening an authorized repository creates or restores a project session.

The browser may remember a recent session ID as a convenience pointer, but localStorage is not authoritative.

On restore, Orlynx reconstructs the project from server state and reconnects event streaming from the durable sequence cursor.

## Message → task lifecycle

A user message is persisted before execution.

For work that creates a run, Orlynx stores a durable task and harness checkpoint before relying on the provider.

The run then proceeds through the direct or workspace execution lane.

## Same-run continuation

Natural follow-ups during active work normally remain attached to the same run.

Examples include “also check this”, “finish it”, “make sure mobile works”, “what have you done?” and “I meant this part”.

These updates are stored durably and fed back to the connected model when steering remains available.

The conversation UI can display every user message attached to the run while preserving immutable message history.

## Explicit queueing

A separate queued task is created only for clear next-task intent such as “queue this”, “do this next”, “after the current work finishes...” or “once this is done...”.

Queued tasks are durable and ordered.

The UI can expose queue position, mode, Edit and Cancel before execution.

Queued work is not promoted while another task is running, waiting for user input or waiting for approval.

## Late-follow-up finalization boundary

A user message can arrive while a run is verifying or preparing its final answer.

Orlynx re-reads durable task state before final completion.

If an unapplied follow-up exists, Orlynx preserves the same task/run identity and continues or requeues that run instead of silently completing and losing the message.

This boundary is regression-tested.

## Task states

Tasks use durable states such as queued, running, waiting_input, waiting_approval, completed, failed and cancelled.

The UI must not infer completion from a timer or from the browser no longer receiving output.

## Harness checkpoint

The task harness records phase, step budget, steering revision, live-update inbox, enabled tool families, acceptance verification, reflection attempts, contradictions/evidence, learned lessons applied and queue-after-active intent where applicable.

This makes execution inspectable and recoverable beyond a single provider request.

## Direct lane

Ask/Plan work can execute without mutable compute.

The direct lane still participates in durable run/message state, live streaming, same-run continuation, cancellation and interruption recovery.

## Workspace lane

Build work uses the selected workspace provider.

The same session can continue while compute is supplied by the Orlynx Runner or GitHub Codespaces fallback/recovery.

A provider change should not create a new conversation.

## Browser disconnect

Closing or backgrounding the browser does not cancel server work by itself.

On return, Orlynx refreshes authoritative session state, reconnects from the durable event cursor and replays missing events.

## Workspace or adapter disconnect

Stopping or losing a workspace does not delete the session.

Workspace health and coding-agent health are separate.

An agent adapter can fail while shell/files/Git remain available.

## AI preferences

Model, mode, access profile and agent selection are persisted per session.

A change during an active run normally applies to the next turn unless the specific operation supports live steering.

Older queued work retains its admission snapshot so picker changes cannot silently mutate already-admitted work.

## Memory relationship

Learned lessons are not the same thing as chat history.

A verified lesson may be created only after reflection and successful verification.

Lessons are user-scoped and retrieved by relevance on later work.

See [learning-and-memory.md](learning-and-memory.md).

## GitHub disconnect

Disconnecting GitHub removes active repository/GitHub capability but does not silently delete the project conversation.

Repository operations fail closed until authorization is restored.

## Retention

Operational records can have bounded retention policies.

Conversation, audit and learned-memory retention should remain explicit product policy rather than disappearing because a browser cache or workspace was deleted.
