# Agent adapters

Orlynx owns the workspace, task ledger, permissions, events, review flow and UI.
Coding agents plug into that product through an adapter contract. An adapter is
not the workspace and cannot make shell/files/Git unavailable merely because its
own runtime is unhealthy.

OpenCode is **Agent Adapter #1**. Additional real adapters (for example Cline)
must implement the same Orlynx-owned contract instead of adding a parallel
workspace architecture.

## Adapter registry (`apps/api/src/agent-runtime.ts`)

Each registered adapter declares:

- stable `id` and human `displayName`;
- capabilities such as workspace execution, streaming, plan mode, approvals,
  resumable sessions and diff support;
- readiness/status methods;
- model parsing;
- session/messages/status/diff/prompt/abort methods;
- bridge run/cancel command names;
- a workspace payload builder.

The task orchestrator resolves the adapter from persisted task/session state and
does not hard-code OpenCode model/auth/bridge payload rules.

## Durable identity

Adapter selection survives API restarts:

- `tasks.adapter_id` snapshots the adapter chosen for admitted work;
- `ai_session_prefs.adapter_id` stores the current conversation default;
- `workspace_agent_adapters` stores health per workspace + adapter;
- `agent_sessions` stores engine-session IDs by session + adapter.

Legacy OpenCode workspace/session persistence has been migrated away. Production
uses the generic adapter tables as the only source of truth; the startup migration
copies any older data once and drops the old `engine_sessions` table and
`workspaces.opencode_state` column.

## Workspace vs adapter lifecycle

Workspace lifecycle describes GitHub Codespace + authenticated Orlynx bridge.

Adapter lifecycle is independent:

`not_installed → installing → starting → ready → busy`

and may enter `unavailable` or `failed`.

A workspace can therefore be healthy while OpenCode is failed. Shell, files,
Git, terminal and ports remain available. Only tasks assigned to the failed
adapter are blocked/failed.

## OpenCode adapter

OpenCode currently provides the first production adapter. Its implementation
uses the private OpenCode server inside the Codespace and the existing
OpenCode HTTP/session APIs, but those details are contained behind the adapter
boundary.

Queued work waits until the selected adapter is ready. Adapter-ready wake-ups
are coalesced without being dropped, so a readiness signal that arrives while a
queue-promotion pass is already running triggers another pass. A terminal adapter
failure produces an adapter-specific run failure and does not mark the
development environment failed.

The chat composer exposes an **Agent** picker separately from the model picker.
The selected adapter is persisted in session preferences and also snapshotted on
each admitted task so rapid picker changes cannot alter or race an already-sent
task.

When another adapter is added, the expected work is:

1. implement/register the adapter;
2. provision its private runtime inside the workspace;
3. map its observable events into Orlynx events;
4. define capabilities/model/session behavior;
5. add adapter-specific tests.

It should not require rewriting Codespaces, Git, files, terminal, queueing or
the primary chat UI.
