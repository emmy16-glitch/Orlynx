# Runner runtime, Docker images, and containers

## Why this document exists

Orlynx has two related runner implementations:

1. **direct Render runners** used in the current hosted pool;
2. a **Docker runner-manager + runner-runtime** design for infrastructure where Orlynx controls a Docker daemon.

They share the same product purpose: provide isolated repository execution that can connect to the Orlynx control plane through the workspace bridge.

## Docker terminology

Three terms are easy to mix up.

### Dockerfile

A Dockerfile is the build recipe.

It contains instructions such as:

~~~dockerfile
FROM node:24-bookworm-slim
RUN apt-get install ...
COPY bridge ...
RUN npm install ...
CMD [...]
~~~

### Image

An image is the immutable packaged environment produced by building the Dockerfile.

Think of it as a prepared machine template containing the operating-system userspace, binaries, libraries, bridge, OpenCode, browser runtime and startup files required by Orlynx.

### Container

A container is a running instance of an image.

~~~text
Dockerfile
   |
   | docker build
   v
Image
   |
   | docker run
   v
Container
~~~

An image does not execute tasks by itself. A container does.

## The runner-runtime image

`runner-runtime/Dockerfile` builds the reusable development-workspace image.

The current image is based on Node 24 / Debian Bookworm slim and includes:

- Node.js 24;
- Git;
- curl and CA certificates;
- ripgrep;
- Python;
- native compiler/build tooling;
- process/network utilities;
- the compiled Orlynx workspace bridge;
- pinned OpenCode native binary;
- Playwright;
- Chromium and its required Debian libraries;
- Preview proxy;
- browser smoke-test utility.

The image creates a non-root `orlynx` user and uses `/workspace` as the workspace root.

OpenCode and other Orlynx-owned runtime files live under `/opt/orlynx`.

## Why prebuild the runtime

A cold blank machine would need to install all execution dependencies before it could work.

Prebuilding the image moves that cost to CI/image publication:

~~~text
Build time:
install Node/system packages
compile bridge
install OpenCode
install Playwright
download Chromium
verify binaries
        |
        v
versioned runner image

Task time:
start container
clone/reuse repository
connect bridge
work
~~~

That improves startup predictability and makes failures reproducible.

## CI verification

The GitHub Actions workflow does more than check TypeScript.

The runner-runtime job:

1. syntax-checks runner scripts;
2. builds the runtime Docker image;
3. launches Chromium from that image;
4. builds the runner-manager image.

A documentation or architecture change must not claim the Docker path is healthy merely because the API builds; the image checks are a separate release gate.

## The runner-manager image

`runner-manager/Dockerfile` is different from the runtime image.

The runtime image is **the workspace**.

The manager image is **the service that creates and manages workspace containers**.

The manager contains Docker tooling and `runner-manager/index.mjs`.

Conceptually:

~~~text
Orlynx control plane
       |
       | authenticated runner API
       v
Runner Manager
       |
       +-- workspace container A
       +-- workspace container B
       +-- workspace container C
       +-- ...
~~~

The manager can apply capacity limits, reclaim idle workspaces, reuse repository caches, and expose health/capability information to Orlynx.

## Current direct Render runners

The current production pool on Render uses the simpler direct-runner implementation:

~~~text
Render service
   |
   +-- runner-direct/index.mjs
   +-- compiled bridge
   +-- OpenCode binary
   +-- one repository working directory
   +-- one active workspace slot
~~~

This avoids depending on nested Docker inside an ordinary Render web service.

The production control plane currently knows five such runner hosts and treats them as one logical pool.

A direct runner exposes authenticated endpoints for lifecycle operations and `/health` for capability/capacity status.

## Runner authentication

The control plane and runner hosts share an internal `ORLYNX_RUNNER_TOKEN`.

Runner management requests use Bearer authentication and timing-safe comparison.

The token is infrastructure authentication. It must never be exposed to the browser or model-visible repository code.

## Runner health

Application health is stronger than the hosting provider's deployment label.

The direct runner considers itself healthy only when required runtime pieces exist, including:

- internal runner credential;
- compiled bridge;
- OpenCode binary.

Its health response also exposes operational state such as:

- capacity;
- running slots;
- available slots;
- draining state;
- browser/E2E capability;
- current workspace metadata where appropriate.

The Compute Broker consumes this information through the runner pool.

## Repository lifecycle on a direct runner

A typical direct-runner lifecycle is:

~~~text
broker selects host
    |
    v
control plane requests workspace creation
    |
    v
runner resolves authorized GitHub repository
    |
    v
runner clones requested branch
    |
    v
control plane sends scoped bridge/runtime configuration
    |
    v
runner starts bridge as child process
    |
    v
bridge authenticates back to control plane
    |
    v
OpenCode adapter becomes ready
    |
    v
Build task can execute
~~~

A runner can reclaim an idle/stopped workspace according to configured lifecycle thresholds.

## The workspace bridge inside a runner

The bridge is compiled separately and copied into the runner environment.

The bridge exposes Orlynx-owned execution primitives such as:

- shell/PTY;
- repository-scoped filesystem access;
- Git;
- tests/build commands;
- port/Preview discovery;
- verification artifact collection;
- agent-adapter lifecycle;
- command deduplication and result journal;
- activity heartbeat.

The bridge connects outbound to the control plane over an authenticated WebSocket.

## OpenCode inside a workspace

OpenCode is Agent Adapter #1.

The workspace bridge:

- resolves the pinned OpenCode binary;
- probes it;
- can repair a missing/stale native package into an Orlynx-private runtime directory;
- launches/monitors the OpenCode server;
- reports adapter lifecycle separately from workspace lifecycle.

This distinction matters: the shell/files/Git workspace can be healthy even when the coding-agent adapter needs recovery.

## Browser and Preview

The Docker runtime image contains browser dependencies so browser verification is a declared capability rather than an ad-hoc install.

The runner Preview proxy forwards a signed browser request to a development server bound inside the workspace, for example `127.0.0.1:5173`.

Preview tokens are signed and time-bounded.

The browser does not receive unrestricted runner control credentials.

## Direct runners versus Docker managers

| Area | Direct Render runner | Docker runner-manager |
| --- | --- | --- |
| Host model | one Render web service | host with Docker daemon |
| Workspace isolation | one active workspace/service | one container/workspace |
| Typical capacity | 1 per direct service | multiple per host |
| Runtime provisioning | installed during service build | prebuilt runtime image |
| Browser capability | host libraries are probed | baked into runtime image |
| Scaling model | add more services | start more containers/hosts |
| Current production | yes | code/CI foundation for compatible hosts |

## Long-term scaling path

The broker allows Orlynx to evolve from fixed direct runners toward dynamically managed container hosts without changing conversation or task semantics.

A future production topology may use multiple runner-manager hosts:

~~~text
Compute Broker
   |
   +-- manager host A -> N containers
   +-- manager host B -> N containers
   +-- manager host C -> N containers
   +-- E2B
   +-- Codespaces
~~~

That scaling step should remain invisible to the user's project conversation.

## Implementation map

| Concern | Code |
| --- | --- |
| Direct runner | `runner-direct/index.mjs` |
| Docker runtime image | `runner-runtime/Dockerfile` |
| Runtime bridge launcher | `runner-runtime/start-bridge.sh` |
| Runtime Preview proxy | `runner-runtime/preview-proxy.mjs` |
| Docker manager | `runner-manager/index.mjs` |
| Manager Dockerfile | `runner-manager/Dockerfile` |
| Runner pool | `apps/api/src/runner-pool.ts` |
| Runner provider client | `apps/api/src/orlynx-runner.ts` |
| Compute routing | `apps/api/src/compute-broker.ts` |
