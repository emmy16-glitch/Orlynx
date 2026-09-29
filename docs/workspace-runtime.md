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

This separation is intentional.

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
