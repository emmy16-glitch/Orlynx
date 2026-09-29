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

## Distributed runner pool

Production Orlynx can treat several runner-manager hosts as one logical execution pool.

```text
Orlynx control plane
  -> health-aware pool scheduler
      -> runner-eu-1 (10 active)
      -> runner-eu-2 (10 active)
      -> runner-eu-3 (10 active)
      -> runner-eu-4 (10 active)
      -> runner-eu-5 (10 active)
  -> GitHub Codespaces only after runner-pool recovery/fallback is exhausted
```

`ORLYNX_RUNNER_HOSTS` supplies stable host identities and HTTPS origins. Each workspace persists its selected `runnerHostId`, so later start/stop/connect/preview calls return to the host that owns that container. The scheduler probes host health, ranks by current load and latency, refuses draining/full hosts, and opens a short circuit after repeated host failures.

`ORLYNX_RUNNER_GLOBAL_MAX_WORKSPACES` defaults to 50. Capacity is therefore a pool policy rather than one giant machine. A recommended starting topology is five Docker-capable hosts with `ORLYNX_RUNNER_MAX_WORKSPACES=10` each.

Runner managers expose `capacity`, `running`, `stopped`, `available`, `draining`, host identity and region from `/health`. A host can be drained without killing existing work by setting `ORLYNX_RUNNER_DRAINING=1`; the scheduler simply stops assigning new work there.

Each Docker host also maintains a credential-free bare Git object cache under `ORLYNX_RUNNER_GIT_CACHE_ROOT`. Authentication is used only while refreshing the cache. New isolated workspace containers clone from the local bare cache when possible, then point `origin` back at GitHub. This avoids repeatedly downloading the same repository objects for every new runner.

This pool is horizontally extensible: increasing 50 to 100 or 500 should be a capacity/configuration change, not a new workspace architecture.

## Runner hosts

Orlynx has two runner-host implementations behind the same provider contract.

### Render single-workspace runner

`runner-direct/index.mjs` is the production MVP used when no Docker-capable VM
is available yet. The Render service itself is the isolation boundary and it
accepts exactly one active workspace at a time.

It:

- clones one authorized repository with an ephemeral GitHub credential;
- launches the existing Orlynx bridge and preinstalled OpenCode runtime;
- keeps the checkout warm between tasks;
- supports signed HTTP/WebSocket preview forwarding;
- stops/reclaims idle workspace processes;
- returns capacity-full for a second workspace so the durable orchestrator can
  fall back to GitHub Codespaces instead of mixing repositories.

The service must be dedicated to runner execution only. It must not share the
control-plane process or its filesystem. This is an MVP isolation boundary, not
the final multi-tenant pool.

### Docker runner manager

`runner-manager/index.mjs` is the multi-workspace runner-host implementation. It requires
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
session queues a `workspace_jobs` preparation with `allowFallback=false`. The
session response never waits for infrastructure startup.

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

## Preview gateway

Warm runners support browser previews without requiring the user's dev server to
bind to the container network.

```text
browser
  -> signed short-lived runner preview URL
  -> runner manager validates HMAC
  -> internal preview proxy :4108
  -> 127.0.0.1:<discovered dev port>
```

The first signed request establishes an HttpOnly/Secure preview cookie so
root-relative asset requests and WebSocket/HMR connections can continue on the
same preview origin without putting the runner API token in the browser.

Configure `ORLYNX_RUNNER_PUBLIC_URL` to the public HTTPS origin of the runner
gateway. It may equal `ORLYNX_RUNNER_URL` when the control-plane API and browser
can reach the same host.

OpenCode's private port is explicitly excluded from preview forwarding.

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

## Capacity and idle reuse

The runner manager enforces a bounded number of simultaneously running
workspaces with `ORLYNX_RUNNER_MAX_WORKSPACES`.

Each bridge updates a private activity timestamp whenever a workspace command is
handled and while an agent/PTY remains active. The manager therefore does not
guess activity from browser connections.

```text
active workspace
  -> no activity for ORLYNX_RUNNER_IDLE_SECONDS
  -> container stopped (checkout preserved)
  -> later request can restart it quickly
  -> stopped for ORLYNX_RUNNER_RECLAIM_SECONDS
  -> container removed and disk reclaimed
```

When runner capacity is full, runner provisioning fails cleanly. A Build job
with fallback enabled can then continue through GitHub Codespaces; passive
prewarming does not spend that fallback.

## Security boundary

Do not turn the runner manager into one shared shell process. Repository code is
untrusted execution from the infrastructure point of view.

Production runner implementations must maintain per-workspace isolation and
resource limits. Future hardening should add outbound network policy, ephemeral
volumes, stronger secret isolation, image signing/provenance and optionally
microVM isolation.

## Durable orchestration

Workspace lifecycle work is persisted in `workspace_jobs` before execution.

```text
queued -> leased -> completed
          |
          +-> lease expires -> reclaimed by another worker
          +-> transient error -> queued with retry delay
          +-> terminal error -> failed
```

The worker uses `FOR UPDATE SKIP LOCKED`, bounded leases, heartbeat renewal and
retry backoff. Production runs `apps/api/dist/orchestrator-worker.js` as a
separate background worker with `ORLYNX_ORCHESTRATOR_MODE=worker`.

HTTP handlers, task promotion and bridge recovery only schedule durable jobs.
`prepareWorkspace()` remains the provider executor behind the orchestrator.

Inline mode exists only as a deployment/local-development compatibility path;
it still writes the durable job first, so later worker adoption does not change
the request contract.
