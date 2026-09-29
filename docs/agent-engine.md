# Agent adapters

Orlynx owns the workspace, task ledger, permissions, events, verification, memory, review flow and UI.

Coding agents plug into that product through an adapter contract.

An adapter is not the workspace.

OpenCode is **Agent Adapter #1**.

## Adapter boundary

Each registered adapter can describe:

- stable ID/display name;
- capabilities;
- readiness;
- model parsing/discovery;
- session lifecycle;
- streaming;
- prompt/cancel;
- tool/change/diff support;
- bridge command mapping.

The task orchestrator resolves the adapter from durable task/session state.

## Durable identity

Adapter selection is persisted per session and snapshotted on admitted tasks.

Changing the picker during an active task applies to the appropriate future work rather than silently rewriting an already-admitted run.

## Workspace versus adapter

Workspace lifecycle and agent lifecycle are independent.

Workspace providers currently include:

- Orlynx runner;
- GitHub Codespaces fallback.

Adapter lifecycle can include:

~~~text
not_installed → installing → starting → ready → busy
                                  ↘ unavailable / failed
~~~

A workspace can remain healthy while OpenCode is unavailable.

Files, Git and shell capability should not disappear merely because one coding-agent runtime failed.

## OpenCode binary recovery

Before declaring OpenCode binary_unavailable, the bridge:

1. probes the configured binary;
2. probes known Orlynx runner/workspace locations;
3. checks native packages already installed in the private runtime;
4. if needed, installs the pinned CPU-compatible native package in a private self-heal directory;
5. probes again;
6. starts the OpenCode server when healthy.

Runner images and Codespaces bootstrap also smoke-test the pinned native binary before normal use.

This reduces stale-workspace/path failures.

It cannot guarantee availability during a genuine package/network/provider outage; in that case the adapter can be unavailable while the workspace remains intact.

## Adding another adapter

A new production adapter should require:

1. implement/register the adapter;
2. provision its private runtime;
3. map observable events into Orlynx canonical events;
4. define capabilities/model/session behavior;
5. add failure/recovery tests.

It must not create a second session system, queue, permission model or chat UI.

## UI contract

Agent selection is separate from model selection.

Infrastructure failure copy should identify the failed capability accurately. “AI runtime unavailable” must not imply repository/workspace loss when only the adapter is unhealthy.
