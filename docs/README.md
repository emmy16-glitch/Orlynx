# Orlynx documentation

This directory is the maintained technical and product documentation for Orlynx.

Orlynx is a GitHub-native AI software-development workspace designed around a **durable project conversation** rather than a disposable chat, one model, or one remote computer.

The documentation has four jobs:

1. describe what the deployed product does now;
2. explain the runtime architecture and failure/recovery behavior;
3. define engineering/security invariants future changes must preserve;
4. clearly separate current production capability from roadmap direction.

## Start here

| Document | Purpose |
| --- | --- |
| [Orlynx overview](orlynx-overview.md) | Product definition, modes, durable conversation, execution lanes and user mental model |
| [Glossary](glossary.md) | Canonical definitions for broker, runner, image, container, bridge, adapter, lease, quarantine and other Orlynx terms |
| [Architecture overview](architecture-overview.md) | End-to-end control plane, Postgres, broker, workspaces, bridge, adapters, events and recovery |
| [Production architecture](production-architecture.md) | Current deployed topology and process boundaries |
| [Compute Broker](compute-broker.md) | Health scoring, quarantine, sticky workspaces, direct-runtime failover and provider selection |
| [Workspace runtime](workspace-runtime.md) | Provider-neutral workspace lifecycle, readiness, bridge and capability model |
| [Runner architecture](warm-runner-architecture.md) | Direct runner pool, host selection, capacity, Preview and lifecycle |
| [Runner runtime and Docker](runner-runtime-and-docker.md) | Dockerfile vs image vs container, runner-runtime image, runner-manager, current Render direct runners |
| [Agent adapters](agent-engine.md) | Replaceable coding-agent boundary; OpenCode is Adapter #1 |
| [Session lifecycle](session-lifecycle.md) | Durable conversation identity, continuation, queueing, restore and interruption |
| [Canonical agent stream](canonical-agent-stream.md) | Versioned event protocol, typed rendering and replay |
| [Streaming and reconnect](streaming-and-reconnect.md) | SSE delivery, recovery cursors and interruption handling |
| [Learning and memory](learning-and-memory.md) | Verified lesson memory without pretending to retrain the model |
| [Render production](render-production.md) | Deployment topology, health checks and post-deploy verification |
| [Secrets and environment](secrets-and-environment.md) | Trust boundaries and configuration classes |
| [End-to-end verification](end-to-end-verification.md) | Release acceptance contract |
| [Engineering standard](engineering-standard.md) | Non-negotiable reliability, security, UX and evidence rules |
| [Product vision and roadmap](product-vision-and-roadmap.md) | Current foundation and future direction |

## Current production topology

~~~text
Browser / phone
      |
      | HTTPS + SSE
      v
Orlynx control plane on Render
      |
      +-- GitHub App / repository authorization
      +-- direct OpenCode Ask/Plan fast lane
      +-- durable task admission + queue + harness
      +-- Compute Broker
      +-- workspace orchestrator
      +-- authenticated bridge gateway
      +-- event normalization / replay / redaction
      |
      +------------------------> Postgres
      |
      v
Workspace compute
      |
      +-- Orlynx direct runner pool (5 configured hosts)
      +-- E2B
      +-- GitHub Codespaces
      |
      v
Authenticated workspace bridge
      |
      +-- filesystem / PTY / Git
      +-- tests / build
      +-- ports / Preview
      +-- browser evidence where supported
      +-- OpenCode adapter
      |
      v
Selected model
~~~

The browser does not own active-work truth. Postgres and the server-side control plane do.

## Compute model

Orlynx no longer documents workspace execution as one hard-coded “runner then Codespaces” chain.

The Compute Broker ranks configured providers using live and historical signals, including:

- success/failure history;
- consecutive failure count;
- latency;
- quarantine;
- runner capacity/load;
- browser/E2E capability;
- current healthy workspace stickiness;
- providers already attempted in the current preparation.

The direct OpenCode runtime is also health-tracked. A confirmed transient direct-runtime outage can be quarantined immediately and the same durable turn can move to workspace compute.

See [compute-broker.md](compute-broker.md).

## Runner model

Current production uses five direct Render runner services. Each exposes one workspace slot and runs the repository, Orlynx bridge, and OpenCode adapter.

The repository also contains the scalable Docker runner-manager/runtime design for hosts where Orlynx controls Docker.

The two designs share the same workspace/provider contract.

See [runner-runtime-and-docker.md](runner-runtime-and-docker.md).

## Documentation truth hierarchy

When documents disagree, use this order:

1. deployed code on the current `main` branch;
2. this index and the canonical overview/architecture documents;
3. subsystem documents;
4. historical design notes.

Historical documents may explain how Orlynx evolved, but must not override current deployed behavior.

## Product principles

Orlynx should remain:

- **conversation-first** — one durable project conversation instead of disconnected command jobs;
- **GitHub-native** — repository identity, authorization and publication are first-class;
- **provider-agnostic** — models, coding agents and compute providers are replaceable behind Orlynx-owned boundaries;
- **broker-routed** — infrastructure health affects routing rather than user task identity;
- **evidence-driven** — completion means observable verification, not optimistic narration;
- **recoverable** — phone sleep, API restart, provider failure and workspace reconnect must not erase work;
- **secure by boundary** — repository code stays outside the control-plane process and secrets remain scoped;
- **mobile-first without becoming mobile-only**;
- **honest about uncertainty**;
- **progressively disclosed** — useful summaries first, detailed evidence on demand.

## Current versus future capability

The roadmap uses three statuses:

- **Current** — implemented and intended to be relied on now.
- **Hardening** — implemented foundation exists, but scale/coverage/operational maturity work remains.
- **Future** — architectural direction only.

Do not describe a roadmap item as deployed simply because code scaffolding exists.

For example, the Docker runner-manager/runtime path is real, CI-built and documented, but the present hosted pool is the direct Render-runner implementation.

## Documentation maintenance rule

Changes to any of the following require documentation review in the same pull request:

- task admission or queueing;
- continuation / steering;
- direct-runtime behavior;
- Compute Broker scoring/quarantine;
- workspace provider selection;
- runner pool/capacity;
- Docker runner images;
- agent-adapter contract;
- event/replay semantics;
- memory/lesson persistence;
- GitHub authorization/publication;
- Preview readiness;
- secret handling;
- deployment topology;
- user-visible modes, permissions, failover or recovery.

The README is the entry point; subsystem documents remain the detailed source of truth.
