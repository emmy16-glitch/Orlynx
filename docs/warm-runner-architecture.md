# Warm runner architecture

Orlynx supports two workspace execution providers behind the same durable task,
bridge, event and review model:

1. **Orlynx Runner** — preferred when configured. A prebuilt runtime is prepared
   in the background as soon as a repository session opens.
2. **GitHub Codespaces** — fallback when the runner is unavailable or explicitly
   selected.

The browser and chat API do not need to know which provider owns the workspace.

## Request path

```text
Browser
  |
  +-- instant replies --------------------------> API memory/session state
  |
  +-- Ask / Plan / read-only questions --------> direct AI stream
  |
  +-- Build work -------------------------------> durable task
                                                   |
                                                   v
                                              Orchestrator
                                                   |
                                    +--------------+-------------+
                                    |                            |
                                    v                            v
                               Orlynx Runner                Codespaces
                               preferred                     fallback
                                    |                            |
                                    +-------------+--------------+
                                                  |
                                                  v
                                               Bridge
                                                  |
                                               OpenCode
```

Postgres remains product truth. The live bridge WebSocket is the low-latency
transport. Bridge commands are still persisted before delivery, so a reconnect
or API restart can redeliver them safely.

## Control-plane configuration

On the Render API service:

```text
ORLYNX_WORKSPACE_PROVIDER=auto
ORLYNX_RUNNER_URL=https://runner.example.internal
ORLYNX_RUNNER_TOKEN=<independent random secret>
ORLYNX_PREWARM_WORKSPACES=1
ORLYNX_RUNNER_FALLBACK_TO_CODESPACES=1
```

`auto` chooses the runner when both runner URL and token are configured. If
they are absent, Orlynx behaves exactly as before and uses GitHub Codespaces.

The runner endpoint must be HTTPS. Do not expose it without authentication.

## Runner host

`runner-manager/index.mjs` is the first runner-host implementation. It requires
a host with a Docker daemon. It creates one container per Orlynx workspace and
applies:

- separate container filesystem/process namespace;
- CPU, memory and PID limits;
- dropped Linux capabilities;
- `no-new-privileges`;
- no persistent GitHub credential in the container configuration;
- bridge/provider credentials streamed through `docker exec` stdin rather than
  command arguments.

A normal Render web service does **not** provide a Docker daemon/socket for
hosting child containers. Keep the Orlynx control plane on Render and deploy the
runner manager on a Docker-capable VM/container host, or replace the manager
implementation with another isolated compute provider later.

Runner-manager environment:

```text
ORLYNX_RUNNER_TOKEN=<same secret configured on control plane>
ORLYNX_RUNNER_IMAGE=orlynx-runner-runtime:<version>
ORLYNX_RUNNER_CPUS=2
ORLYNX_RUNNER_MEMORY=4g
ORLYNX_RUNNER_PIDS=512
PORT=8080
```

## Prebuilt runtime image

`runner-runtime/Dockerfile` contains:

- Node 24;
- Git;
- Python/build tooling;
- the compiled Orlynx bridge;
- `node-pty` and `ws`;
- a pinned native OpenCode binary;
- bridge health/startup tooling.

The runtime image is built in CI. Runtime dependencies are therefore not
installed when a user submits a Build task.

Workspace startup becomes:

```text
allocate container
  -> clone repository
  -> runner reports running
  -> inject short-lived bridge credentials
  -> start preinstalled bridge/OpenCode
  -> bridge READY
```

## Background prewarming

When the preferred provider is `orlynx-runner`, creating a durable repository
session starts `prepareWorkspace()` asynchronously. The session response is
not held open.

This means the user can chat immediately while the execution workspace warms in
parallel.

Codespaces are intentionally not prewarmed from session creation because they
remain the slower/costlier fallback.

## Bridge fast path

Every command is persisted to `bridge_commands` first.

When the authenticated bridge socket is attached to the same API process, the
command is then sent immediately over WebSocket. The one-second durable claim
loop is recovery for reconnects or multi-instance routing, not the normal
transport.

Command results also wake an in-process waiter immediately. Database polling is
kept as a recovery path when a result is completed by another API instance.

## Failure behavior

If an Orlynx runner fails during preparation and
`ORLYNX_RUNNER_FALLBACK_TO_CODESPACES` is enabled:

```text
runner failure
  -> destroy failed runner best-effort
  -> preserve workspace/task identity
  -> switch provider to github-codespaces
  -> continue preparation automatically
```

The user task remains durable throughout the transition.

## Security boundary

Do not turn the runner manager into one shared shell process. Repository code is
untrusted execution from the infrastructure point of view.

Production runner implementations must maintain per-workspace isolation and
resource limits. Future hardening should add outbound network policy, ephemeral
volumes, stronger secret isolation, image signing/provenance and optionally
microVM isolation.

## Next orchestration step

The current API still owns `prepareWorkspace()` lifecycle promises. The next
architecture milestone is a dedicated orchestrator worker with Postgres leases:

```text
queued -> claimed -> lease_until -> preparing -> ready/running
```

If the worker dies, another worker can claim the expired lease and continue.
That removes long-running infrastructure lifecycle ownership from the web
process without changing the provider or bridge interfaces introduced here.
