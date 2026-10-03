# Agent engine and adapter architecture

## Principle

A coding agent is replaceable.

Orlynx owns the product-level contracts. OpenCode is **Agent Adapter #1**, not the definition of Orlynx.

## Orlynx owns

- user/project/session identity
- durable task/run identity
- Ask / Plan / Build
- permission profile
- continuation and queue order
- Compute Broker routing
- workspace lifecycle
- harness / verification
- canonical events / replay
- memory
- approvals / publication
- UI projection

## Adapter owns

- adapter readiness
- engine session
- selected-model invocation
- agent tool lifecycle
- streaming
- cancel/resume integration
- engine-specific event translation

An adapter does not redefine authorization, queue semantics, or publication authority.

## OpenCode deployment forms

### Direct OpenCode runtime

A lightweight remote OpenCode server handles conversational Ask/Plan without waking a full workspace.

Orlynx remains authoritative for durable history. If an OpenCode runtime session disappears, Orlynx can recreate it and supply bounded recent durable conversation context.

The direct runtime is tracked by the Compute Broker and can be temporarily quarantined after a confirmed infrastructure outage.

### Workspace OpenCode

Each Build workspace can run OpenCode under Bridge control with repository/tool access bounded by Orlynx policy.

## Selected model

The selected model is stored by Orlynx and passed to the adapter for the run.

Changing compute provider must not silently change the selected model.

## Adapter lifecycle

Adapter state may include:

- starting
- ready
- busy
- unavailable
- failed

Workspace state and adapter state are intentionally independent.

## Direct-runtime failover

Transient direct-runtime failure before useful output can trigger:

1. broker failure record
2. direct-runtime quarantine
3. `Switching compute...`
4. same durable task moves to workspace plane
5. broker selects runner/E2B/Codespaces
6. conversation continues without resend

## Workspace adapter recovery

The Bridge probes the OpenCode binary and can repair the pinned native package into an Orlynx-private runtime path.

Health checks are bounded so a transient miss does not immediately become a permanent adapter failure.

## Engine sessions

Orlynx maps durable conversation/session identity to adapter engine-session identity. Engine sessions are replaceable implementation details beneath the project conversation.

## Events

Agent-specific events are normalized into Orlynx canonical events before the UI depends on them.

The frontend should not become coupled to raw OpenCode payloads.

## Permissions and secrets

The model/adapter does not receive unrestricted control-plane credentials.

Workspace tools are exposed through the Bridge/harness according to task permission. Consequential GitHub publication remains in Orlynx-controlled paths.

## Future adapters

A future coding agent should implement the same high-level contract for readiness, engine session, model selection, streaming, tools, cancellation, and evidence.

Adding another agent must not require rebuilding Postgres state, Compute Broker, workspace providers, queue, publication, memory, or frontend conversation architecture.

## Recovery hardening, 2026-09-30

Workspace OpenCode has a 60-second first-progress budget and a 90-second silence budget when no tool is active; active tools retain the larger execution budget. Retry status is bounded. A safe pre-output/pre-tool transient or public-route failure permits one retry of the exact selected model after acknowledged abort. Missing engine sessions are recreated. Adapter health can repair the private OpenCode server without replacing shell/files/Git.


See [Orlynx-owned multi-agent execution](multi-agent-architecture.md) for portable adapters, fenced same-task handoffs, provenance and rollout limitations; [implementation status](multi-agent-architecture-status.md) records the verified scope.
