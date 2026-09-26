# Workspace runtime (execution plane)

Orlynx separates the user-facing control plane from repository execution.

- Render hosts the API, direct chat, task admission, SSE and bridge gateway.
- Postgres is product truth.
- A workspace provider owns the mutable repository checkout and execution
  environment.
- OpenCode is Agent Adapter #1 inside the workspace.

## Providers

### Orlynx Runner

When `ORLYNX_RUNNER_URL` and `ORLYNX_RUNNER_TOKEN` are configured and the
provider mode is `auto` or `orlynx-runner`, Orlynx prefers a prebuilt runner.

The runner is prepared in the background after repository selection. The runtime
already contains Node 24, bridge dependencies and the pinned OpenCode binary.

### GitHub Codespaces

Codespaces remain supported as the fallback provider. The existing GitHub
Codespaces lifecycle, SSH bootstrap and recovery code remains available.

This means a runner outage does not strand a durable Build task when fallback is
enabled.

## Bridge

Every workspace runs the same outbound Orlynx bridge.

The bridge authenticates to `/bridge` with a short-lived HMAC credential scoped
to user, session, workspace and connection IDs.

Commands are persisted before dispatch. A connected bridge receives commands
immediately over WebSocket. Durable command claiming remains the reconnect and
cross-instance recovery path.

The bridge exposes typed operations rather than an unrestricted remote shell API:
constrained test/build commands, policy-filtered PTY input, repository-scoped
files, Git operations, port discovery and registered agent adapters.

## Readiness

Workspace lifecycle remains:

```text
not_created -> creating -> starting -> bootstrapping -> connecting -> ready
                                                    \-> failed
ready -> stopping -> stopped
```

`ready` means the provider environment exists and the authenticated bridge is
connected. Agent adapter health is stored separately.

A workspace can therefore be usable for shell/files/Git while OpenCode is
temporarily unavailable.

## Prewarming

Prewarming is intentionally provider-aware.

- Orlynx Runner: prepare asynchronously when the durable repository session opens.
- Codespaces: start only when execution is requested, unless future product
  policy explicitly changes that.

Chat never waits for prewarming to finish.

## Runner host

The first implementation is under `runner-manager/` and
`runner-runtime/`. The manager requires a Docker-capable host and creates one
isolated container per workspace.

A standard Render web service remains the control plane and should not be treated
as a privileged Docker host.

See [warm-runner-architecture.md](warm-runner-architecture.md) for deployment and
security details.
