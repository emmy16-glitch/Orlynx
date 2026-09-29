# Workspace runtime

Orlynx separates the user-facing control plane from mutable repository execution.

- Render hosts the control plane.
- Postgres is product truth.
- WorkspaceProvider owns mutable compute.
- the authenticated Orlynx bridge exposes execution primitives.
- OpenCode is Agent Adapter #1.

## Providers

### Orlynx Runner

Preferred when configured.

The runner uses a prebuilt runtime image containing the bridge and pinned native OpenCode package.

Workspaces can prewarm after repository open.

### GitHub Codespaces

Supported fallback/recovery provider.

Codespaces bootstrap a private Orlynx runtime and install/smoke-test the CPU-compatible native OpenCode package.

When the deployment prefers the warm runner, a legacy Codespace may remain in use while its workspace and OpenCode adapter are healthy. If the bridge is healthy but the legacy Codespace adapter becomes unavailable/failed, the next Build admission migrates that session to the preferred warm runner instead of repeatedly paying adapter reconnect churn.

## Bridge

The bridge connects outbound to the Orlynx control plane with a short-lived scoped credential.

It exposes constrained repository operations including:

- filesystem;
- PTY/shell;
- Git;
- tests/builds;
- Preview discovery/forwarding;
- registered agent adapters.

Commands are persisted before relying on the WebSocket fast path.

## Readiness

Workspace readiness and agent readiness are separate.

A workspace is ready when the provider environment and authenticated bridge are ready.

OpenCode may still be starting/repairing/unavailable.

Heartbeat readiness is intentionally debounced: one transient OpenCode health-probe miss does not flip a previously ready adapter to unavailable. Consecutive failures are required before durable readiness changes, preventing normal short latency spikes from making Build appear to restart.

This separation is intentional.

## Repository freshness before Build

A ready runtime is not enough. Before a queued Build task is promoted to model/tool execution, Orlynx asks the bridge to reconcile the workspace branch with GitHub.

The preflight contract is:

- verify the workspace is on the conversation branch;
- fetch the latest target branch from `origin`;
- if the checkout is clean and only behind, fast-forward it automatically with `--ff-only`;
- if it is already current, continue immediately;
- if it is dirty while behind, diverged, or on the wrong branch, stop before model execution and preserve the local working tree exactly as-is.

This prevents a healthy-but-stale Codespace or runner from executing against old source code. Repository freshness is a Build admission requirement, not merely a publish-time check.

Dependency hydration should also avoid creating fake dirtiness: when `package-lock.json` already exists and dependencies are not intentionally changing, Build guidance prefers `npm ci` and does not leave lockfile churn behind.

## OpenCode self-healing

The bridge resolves the OpenCode executable through multiple known locations.

If none passes a version probe, it installs the pinned native package appropriate for the workspace CPU/libc into a private Orlynx repair directory.

The repaired binary is probed again before server startup.

This protects long-lived/stale workspaces from path drift or missing runtime packages.

## Preview

Workspace Preview is provider-aware.

Warm runner Preview uses the signed runner gateway.

Codespaces Preview uses verified port forwarding and browser-resolvable URLs.

API-only HTTP roots are not accepted as browser Preview.

## Prewarming

- runner: may prepare asynchronously when repository session opens;
- Codespaces: normally starts only when execution requires it.

Chat should remain usable while prewarming occurs.

## Session independence

Stopping/replacing compute must not delete the project conversation.

A different device can reconnect to the same durable session and recover current workspace/task state.

See cloud-workspace-lifecycle.md and warm-runner-architecture.md.
