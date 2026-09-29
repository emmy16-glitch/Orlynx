# Workspace lifecycle

The project conversation stays stable while compute changes underneath it.

Orlynx no longer treats “cloud workspace” as synonymous with one provider.

## Providers

The current execution-provider model supports:

- **Orlynx Runner** — preferred when configured and healthy;
- **GitHub Codespaces** — fallback/recovery provider.

Both expose the same authenticated Orlynx bridge contract to the control plane.

## Durable lifecycle

Workspace preparation is asynchronous and durable.

Typical states are:

~~~text
not_created
→ creating
→ starting
→ bootstrapping
→ connecting
→ ready

ready → stopping → stopped

any preparation state → failed
~~~

The exact provider may add internal details, but the user-facing session remains the same.

## Readiness

Workspace ready means the provider environment exists and the authenticated Orlynx bridge is connected.

Agent-adapter health is separate.

A ready workspace can therefore still report one selected agent runtime as unavailable without losing shell/files/Git capability.

## Warm runner

The warm runner can be prepared in the background when the repository session opens.

Its runtime image already contains the bridge/runtime dependencies.

This is the preferred low-latency path.

## Codespaces fallback

Codespaces remains available when the runner is unavailable or when provider policy selects it.

Fallback should preserve the durable session/task identity rather than creating a second conversation.

## Reconnect

Reconnect rotates or re-establishes provider/bridge state without deleting:

- messages;
- tasks;
- events;
- approvals;
- changes;
- learned lessons.

## Stop

Stopping compute is not the same thing as deleting the Orlynx project.

A stopped workspace can later be restarted or replaced by another provider.

## Failure language

Normal UI copy should explain the capability that needs attention:

- workspace could not start;
- workspace connection was interrupted;
- coding agent could not start;
- Preview forwarding needs attention.

Provider-specific diagnostics can remain available behind details.

## Preview

Preview readiness is verified independently from workspace readiness.

A workspace can be ready while no browser Preview exists yet.

For current Preview rules see [architecture-overview.md](architecture-overview.md) and [warm-runner-architecture.md](warm-runner-architecture.md).
