# Cloud workspace lifecycle

The durable Orlynx project conversation stays stable while compute changes underneath it.

Workspace creation/preparation is asynchronous and persisted. A browser request does not own the full lifecycle.

## Providers

Current workspace providers are:

- Orlynx runner pool;
- E2B;
- GitHub Codespaces.

The Compute Broker chooses among configured providers using health, failure history, latency, quarantine, capability, capacity/load, and healthy-workspace stickiness.

See [compute-broker.md](compute-broker.md).

## Workspace states

Representative lifecycle:

~~~text
not_created
→ creating
→ starting
→ bootstrapping
→ bridge connecting
→ workspace ready
→ adapter starting
→ adapter ready
→ task execution
~~~

Workspace readiness, Bridge readiness, and agent-adapter readiness are separate concerns.

A workspace may remain usable for shell/files/Git while OpenCode is repairing or restarting.

## Durable preparation

Workspace preparation is stored as a durable job.

The orchestrator:

1. claims the job with a lease;
2. renews ownership while preparation is active;
3. creates/starts the selected provider;
4. connects the Bridge;
5. waits for runtime readiness;
6. retries transient failure with bounded backoff;
7. records completion/failure durably.

If the worker dies, the lease expires so recovery can continue.

## Provider migration

Infrastructure failure should preserve the same task/session.

~~~text
selected provider fails
        |
        v
broker records failure
        |
        v
provider may be quarantined
        |
        v
rank remaining configured providers
        |
        v
prepare replacement workspace
        |
        v
bridge reconnect
        |
        v
continue same durable Build
~~~

Providers already attempted in the current preparation are excluded so failover cannot loop indefinitely.

## Healthy workspace stickiness

A healthy existing workspace is preserved where practical. Orlynx does not migrate merely because another provider has a slightly higher baseline score.

Migration is for real need: degraded health, missing capability, provider failure, or recovery.

## Direct-runtime promotion

The conversational direct OpenCode runtime is not a workspace provider, but the broker also tracks its health.

If it fails transiently before useful output, Orlynx can promote the same durable turn to workspace execution without requiring a resend.

## Repository freshness

Before Build execution, Orlynx checks the selected checkout against the remote branch.

Safe behind-only state can fast-forward.

Local source edits/divergence block unsafe automatic reset.

Isolated incidental `package-lock.json` drift has a narrow recovery path that preserves the exact patch before restore/fast-forward.

## OpenCode repair

The Bridge treats a broken/missing OpenCode binary as adapter recovery, not automatic workspace death.

It probes known locations and can install the pinned native package into an Orlynx-private runtime path.

## Stop / reconnect

Stopping compute does not delete:

- session;
- messages;
- tasks;
- queue;
- event history;
- changes;
- approvals;
- learned lessons.

Reconnect rotates/refreshes Bridge connection identity as required while preserving the project conversation.

## Cross-device

Workspace state is server-owned.

A user can open the same durable project session from another authenticated device and observe the current task/workspace state rather than creating a local duplicate.
