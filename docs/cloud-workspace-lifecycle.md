# Cloud workspace lifecycle

The durable Orlynx project conversation stays stable while compute changes underneath it.

Workspace creation/preparation is asynchronous and persisted. A browser request does not own the full lifecycle.

## Providers

Orlynx supports a provider boundary.

### Orlynx runner

Preferred when configured.

A runner workspace can be prewarmed when the repository session opens.

### GitHub Codespaces

Supported fallback/recovery provider.

Codespaces are normally created/started when execution is needed rather than prewarmed by default.

## Workspace states

Representative states are:

~~~text
not_created
→ creating
→ starting
→ bootstrapping
→ connecting
→ ready

ready → stopping → stopped

any preparation stage → failed
~~~

The authenticated bridge has its own state.

Agent adapters have another independent lifecycle.

A workspace can therefore be ready while OpenCode is starting, repairing or unavailable.

## Durable preparation

Workspace preparation is represented by durable workspace jobs.

A worker can lease/retry work after process restart.

Transient infrastructure failure should be retried/recovered without duplicating the user's project conversation.

## Provider fallback

When the preferred runner fails and policy permits fallback:

~~~text
runner failure
→ clean failed runner best-effort
→ preserve durable task/session
→ switch workspace provider
→ Codespaces preparation
→ bridge reconnect
→ continue queued Build
~~~

## OpenCode repair

The bridge does not treat one broken OpenCode path as permanent adapter failure.

It probes known locations and can install the pinned native package into a private repair directory before returning binary_unavailable.

This keeps adapter recovery separate from workspace recovery.

## Stop / reconnect

Stopping compute does not delete:

- session;
- messages;
- tasks;
- event history;
- changes;
- approvals;
- learned lessons.

Reconnect rotates/refreshes the bridge connection as required while preserving the conversation.

## Cross-device

Workspace state is server-owned.

A user can open the same durable project session from another authenticated device and observe the current workspace/task state rather than creating a new local project copy.
