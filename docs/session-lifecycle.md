# Session lifecycle

An Orlynx project session belongs to the authenticated GitHub user identity and repository context, not to one browser tab, one phone, one laptop or localStorage.

## Durable ownership

In hosted production, Postgres stores the authoritative session and its related messages, tasks, events, AI preferences, workspace state, approvals, changes and audit information.

The browser may remember a recent session ID as a convenience pointer, but losing browser storage must not erase the conversation.

## Cross-device restore

After the same GitHub user connects Orlynx on another device:

1. Orlynx resolves the authenticated GitHub user identity.
2. GET /v1/sessions returns that user's durable sessions ordered by recent activity.
3. The client hydrates recent repositories from that server-owned list.
4. If there is no valid local pointer, the newest durable session can be opened automatically.
5. Opening the session restores messages, tasks, run snapshots, activity history, AI preferences and workspace metadata.
6. SSE reconnects from the restored event cursor.

The OAuth-success path performs this hydration immediately. A fresh laptop should not require a second page reload before existing conversations appear.

## Reopening a repository

Orlynx keeps one durable conversation for a user + repository + branch.

When the user reopens that repository/branch, Orlynx searches by stable GitHub user identity and project context instead of relying only on an old installation ID.

If the GitHub App was reinstalled and the user still has valid access, the durable session can be rebound to the current installation without creating a blank duplicate conversation.

## Messages do not live only in the browser

User and assistant messages are stored in the durable messages table.

Local browser state is used only for convenience such as:

- last-opened session pointer;
- event sequence cursor;
- unsent draft;
- theme and small UI preferences.

Deleting browser cache therefore must not be equivalent to deleting Orlynx chat history.

## Active task continuation

An active task can receive durable follow-up messages.

Natural follow-ups remain attached to the same run while steering is still possible. Before finalization, Orlynx re-reads task state so a message arriving during verification/final synthesis is not silently lost.

Explicit next-task wording creates separate queued work.

## Queue states

Tasks can move through states such as:

- queued;
- running;
- waiting_input;
- waiting_approval;
- paused/interrupted where supported;
- completed;
- failed;
- cancelled.

Queued work remains durable across browser disconnects and API restarts.

## Workspace independence

The session remains stable even when compute changes underneath it.

Stopping, replacing, or migrating among Orlynx runners, E2B, and GitHub Codespaces does not delete chat history or create a new logical task.

Agent-adapter health is also separate from session existence. An unavailable OpenCode runtime must not make the conversation disappear.

A transient direct-runtime outage can move the same durable turn onto broker-selected workspace compute. The run/message identity remains stable across that migration.

## GitHub disconnect

Disconnecting GitHub removes active repository authorization, but it does not intentionally delete the durable conversation.

The user must reconnect before protected repository operations continue.

## Retention

Operational dedupe/transport tables may be pruned according to their documented policies.

Conversation/session history and audit data are not silently expired merely because a workspace stopped or the user changed devices. A future user-facing deletion/retention feature must make destructive retention explicit.

## Recovery hardening, 2026-09-30

The task workspace_id is updated with execution_plane during failover. Recovery repairs legacy bindings using full ownership/repository/branch checks. Queued workspace claims cannot bypass running work in another lane or tasks waiting for input/approval; direct read-only chat can still pass a human wait.
