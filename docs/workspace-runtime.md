# Workspace runtime

## Purpose

A workspace is the mutable execution environment for repository work. The browser and Render control plane do not execute arbitrary project code directly.

Current workspace providers are:

- `orlynx-runner`
- `e2b`
- `github-codespaces`

The Compute Broker selects among them.

## Lifecycle

~~~text
requested
  -> provisioning
  -> starting
  -> bridge connecting
  -> workspace ready
  -> agent adapter starting
  -> agent ready
  -> task execution
~~~

Workspace readiness and agent-adapter readiness are separate states.

## Provider-neutral task identity

A task remains an Orlynx task regardless of compute:

~~~text
session -> task -> run
                 |
                 +-- runner
                 +-- E2B
                 +-- Codespaces
~~~

Provider changes must not create a new logical conversation.

## Provider selection

Build admission consults the Compute Broker using:

- provider health/history
- temporary quarantine
- runner capacity/load
- browser/E2E capability
- providers already attempted
- current healthy-workspace stickiness

Healthy existing workspaces are preserved where practical.

See [compute-broker.md](compute-broker.md).

## Orlynx runner provider

Current production has five direct Render runner services exposed as one logical pool.

Each direct runner can:

- resolve an authorized GitHub repository
- clone the requested branch
- start the Orlynx Bridge
- start/probe OpenCode
- report health/capacity
- expose signed Preview forwarding

## E2B

E2B is an independent isolated sandbox provider. When configured and healthy, the broker can select it for new or recovering work.

## GitHub Codespaces

Codespaces is a GitHub-managed durable workspace provider. Orlynx can create, reuse, repair, or replace a Codespace, bootstrap the Bridge/OpenCode runtime, and wait for readiness.

## Durable preparation

Workspace startup is not tied to one HTTP request.

The control plane writes a durable workspace job and the orchestrator worker claims it using a lease. Long preparation renews the lease. Transient failures retry with bounded backoff.

## Bridge connection

The workspace Bridge connects outbound to the control plane using scoped credentials for workspace/session/user/connection identity.

The Bridge exposes repository-scoped capabilities such as:

- filesystem
- shell / PTY
- Git
- tests / builds
- ports / Preview discovery
- browser verification artifacts
- agent adapter lifecycle

## Command durability

Commands are persisted before relying on WebSocket delivery. The Bridge records completed command results and avoids duplicate execution for the same command ID across reconnects.

## OpenCode lifecycle

OpenCode is Adapter #1.

A workspace can remain healthy while OpenCode is starting, repairing, or restarting. This prevents an adapter problem from being misclassified as a dead workspace.

The Bridge can repair the pinned native OpenCode package into an Orlynx-private runtime directory.

## Git freshness

Before Build work relies on the checkout, Orlynx checks local/remote branch state.

Safe behind-only state can fast-forward.

Unsafe local source edits or divergence block rather than being discarded.

A narrow recovery path handles isolated incidental `package-lock.json` drift by preserving its patch outside the repository before restore/fast-forward.

## Preview

Preview requires more than a listening port.

Orlynx verifies:

1. local listener
2. HTTP/browser suitability
3. provider forwarding
4. browser-reachable URL

Direct runners use signed proxying. Codespaces uses provider forwarding. Browser-capable environments can provide Playwright evidence.

## Failure rules

Infrastructure failure should normally preserve task identity:

- lost Bridge -> reconnect/repair
- stale OpenCode -> repair/restart adapter
- unavailable provider -> broker reroute
- provisioning delay -> durable retry
- browser disconnect -> task continues server-side

Authorization/security failures fail closed.

## Implementation map

| Concern | Code |
| --- | --- |
| Provider contract | `apps/api/src/workspace-provider.ts` |
| Provider registry | `apps/api/src/workspace-providers.ts` |
| Workspace lifecycle | `apps/api/src/workspaces.ts` |
| Durable preparation | `apps/api/src/workspace-jobs.ts` |
| Compute Broker | `apps/api/src/compute-broker.ts` |
| Runner pool | `apps/api/src/runner-pool.ts` |
| Runner client | `apps/api/src/orlynx-runner.ts` |
| E2B | `apps/api/src/e2b-provider.ts` |
| Codespaces | `apps/api/src/github.ts` |
| Bridge gateway | `apps/api/src/bridge-gateway.ts` |
| Workspace Bridge | `bridge/src/index.ts` |
