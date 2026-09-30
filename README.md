# Orlynx

Orlynx is a **phone-first, GitHub-native AI software-development workspace** built around one durable project conversation.

It is not a thin chat wrapper around one model, a Codespaces dashboard, or a hosted terminal. Orlynx is the product and orchestration layer that keeps repository identity, conversation, tasks, execution, verification, recovery, memory, Preview, and publication coherent even when the model, coding agent, or compute provider changes.

> **Current production architecture:** Render control plane + Postgres durable state + direct OpenCode fast lane + adaptive Compute Broker + five-host Orlynx runner pool + E2B + GitHub Codespaces + authenticated workspace bridge + OpenCode as Agent Adapter #1.

Render is the active production control plane. Vercel is not part of the current runtime architecture.

## Product mental model

~~~text
Open repository
   |
   v
Talk to Orlynx
   |
   v
Ask / Plan / Build
   |
   v
Durable message + task
   |
   v
Choose execution lane
   |
   +-- Direct model lane for lightweight Ask/Plan
   |
   +-- Workspace lane for real repository work
           |
           v
      Compute Broker
           |
           +-- Orlynx runner pool
           +-- E2B
           +-- GitHub Codespaces
           |
           v
      Authenticated workspace bridge
           |
           v
      OpenCode adapter + selected model
           |
           v
      Real files / terminal / tests / build / browser / Preview
           |
           v
      Harness verification
           |
           v
Review / publish / durable lesson where eligible
~~~

The browser is a control surface. It is not the source of truth for active work.

## What Orlynx owns

Orlynx owns the durable product contracts around:

- authenticated user and GitHub identity;
- authorized repositories and branches;
- project sessions and message history;
- task admission and ordering;
- same-run continuation and explicit queued work;
- selected model, mode, permission profile, and agent;
- compute routing and provider failover;
- workspace lifecycle;
- agent-adapter readiness;
- canonical event history and replay;
- harness acceptance criteria and verification;
- approvals and change sets;
- Preview readiness;
- GitHub publication;
- verified learning/memory;
- secret redaction;
- audit.

The connected model provides reasoning. It does **not** own authorization, queue order, durable state, compute routing, publication policy, or the definition of “done.”

## Ask, Plan, and Build

### Ask

For explanation, normal conversation, and repository questions that do not require mutation.

Ask can use the direct model lane without starting a workspace.

### Plan

For architecture analysis, debugging strategy, implementation planning, and structured reasoning.

Plan can also stay in the direct lane when real execution is unnecessary.

### Build

For real project work: file edits, terminal commands, tests, builds, Git, browser verification, Preview, and deployment-related operations according to the task and permission profile.

Build work is stored durably before execution.

## Durable conversation and queue

Natural follow-ups such as “also check mobile”, “finish it”, “what have you done?”, or “make sure tests still pass” continue the **same active run** while it is still steerable.

Only explicit next-task wording such as “queue this”, “do this next”, or “after this finishes...” creates separate queued work.

Queued work is durable, ordered, editable, cancellable, and sequential. It must not accidentally execute beside a running task or a task waiting for user input/approval.

## Compute Broker

The Compute Broker decides where work should run.

It tracks operational signals for:

- direct OpenCode runtime;
- GitHub Codespaces;
- E2B;
- Orlynx runner pool.

Signals include success/failure history, consecutive failures, latency, temporary quarantine, runner capacity/load, and browser/E2E capability.

The broker keeps an already-healthy workspace sticky where practical so successive Build turns do not bounce between providers.

When the direct OpenCode fast path fails with a transient infrastructure error before useful output, Orlynx preserves the same durable task and automatically switches it to workspace compute instead of asking the user to resend the message.

See [docs/compute-broker.md](docs/compute-broker.md).

## Current runner pool

Production currently has five direct Orlynx runner services configured as one logical pool.

Each direct runner:

- owns one active workspace slot;
- clones/reuses the authorized repository branch;
- runs the Orlynx workspace bridge;
- runs the OpenCode adapter;
- reports health/capacity/capabilities to the control plane;
- exposes signed Preview forwarding.

The repository also contains a containerized runner architecture for Docker-capable hosts:

- `runner-runtime/Dockerfile` builds the prepared workspace image;
- `runner-manager/Dockerfile` builds the service that creates/manages workspace containers.

See [docs/runner-runtime-and-docker.md](docs/runner-runtime-and-docker.md).

## Docker mental model

~~~text
Dockerfile = build recipe
      |
      v
Docker image = packaged immutable environment
      |
      v
Docker container = running instance of that image
~~~

The Orlynx runner-runtime image contains Node 24, Git, Python/build tools, the compiled bridge, pinned OpenCode, Playwright, Chromium, Preview support, and required browser libraries.

GitHub CI builds the image and actually launches Chromium as a release gate.

## Control plane and Postgres

Render runs the persistent Orlynx API and the durable workspace orchestrator.

Postgres is authoritative production state for things such as:

- sessions;
- messages;
- tasks;
- harness checkpoints;
- events;
- workspace records;
- workspace preparation jobs;
- bridge commands/results;
- AI preferences;
- approvals;
- audit;
- verified lessons.

A phone refresh, browser disconnect, Render restart, runner failure, or provider change should not erase task identity.

## Orchestrator

The Compute Broker decides **where** work should run.

The workspace orchestrator makes that selected environment actually become ready.

Workspace preparation jobs are durable, leased, retryable, and recoverable. A worker claims a job, renews its lease while working, prepares the provider/bridge/runtime, and retries transient failures with bounded backoff.

Periodic recovery sweeps resume work after process restarts or infrastructure interruption.

## Workspace bridge

The authenticated Bridge is the boundary between the Render control plane and a real execution environment.

It exposes repository-scoped capabilities such as:

- filesystem;
- shell / PTY;
- Git;
- tests and builds;
- ports / Preview discovery;
- browser verification artifacts;
- agent-adapter lifecycle;
- structured command results.

Commands are persisted before relying on the live socket fast path. The Bridge keeps a command-result journal and protects against duplicate execution across reconnects.

## OpenCode and models

OpenCode is **Agent Adapter #1**. It is not the definition of Orlynx.

Orlynx owns task identity, permissions, queueing, execution routing, events, memory, verification, and publication. OpenCode supplies the coding-agent runtime and talks to the selected model.

The adapter boundary exists so future coding agents can implement the same Orlynx contract without rebuilding the product.

## Direct OpenCode runtime

A separate lightweight OpenCode runtime supports conversational Ask/Plan work without waking a full development environment.

It is an optimization, not a hard dependency.

If that runtime is unhealthy, the Compute Broker can quarantine it and move the same durable turn to workspace compute.

## Harness and verification

Orlynx uses an execution harness instead of trusting completion prose.

The harness tracks phase, step budget, allowed tool families, live steering, acceptance criteria, contradictions, reflection attempts, and verification evidence.

Depending on the request, evidence may include:

- changed files;
- tests;
- typecheck/build;
- Git state;
- publication receipt;
- deployment status;
- browser-reachable Preview;
- browser/E2E evidence.

A model saying “done” is not proof that the requested outcome happened.

## Streaming and recovery

Runtime/provider events are normalized into a versioned Orlynx event vocabulary before the UI depends on them.

Events have stable IDs and monotonically increasing session sequence numbers.

The browser receives activity through SSE and reconnects from its last sequence cursor. This supports phone sleep, backgrounding, network changes, refresh, API restart, and workspace reconnect without treating the browser as the owner of active work.

## Preview

Preview is not considered ready merely because a process binds a port.

Orlynx verifies:

1. a local listener exists;
2. the service is HTTP/browser-suitable;
3. provider forwarding works;
4. the URL is reachable from the user's browser.

Direct runners use signed Preview proxying. Codespaces uses provider forwarding. Docker runner-runtime images include Playwright/Chromium for browser verification.

## GitHub publication

GitHub credentials remain server-side.

The coding-agent shell does not receive unrestricted publication authority.

Publication uses Orlynx-controlled operations with explicit user intent, branch validation, policy checks, safe Git state, and durable receipts/audit.

## Learning and memory

Orlynx does **not** retrain the connected model.

It learns through an Orlynx-owned verified lesson memory. Lessons are user-scoped, normally repository-scoped, relevance-ranked, redacted, and subordinate to fresh evidence.

A lesson is eligible only after evidence-driven investigation/reflection and successful harness verification.

## Reliability philosophy

Orlynx should:

- fail closed on authorization/security;
- fail recoverably on infrastructure;
- preserve task identity across provider change;
- avoid duplicate execution;
- quarantine unhealthy compute;
- prefer application health over host “live” labels;
- keep healthy workspaces sticky;
- never require the user to understand infrastructure just to continue ordinary work.

## Documentation

Start with [docs/README.md](docs/README.md).

Important documents:

- [What Orlynx is](docs/orlynx-overview.md)
- [Architecture glossary](docs/glossary.md)
- [Architecture overview](docs/architecture-overview.md)
- [Production architecture](docs/production-architecture.md)
- [Compute Broker](docs/compute-broker.md)
- [Workspace runtime](docs/workspace-runtime.md)
- [Runner architecture](docs/warm-runner-architecture.md)
- [Runner runtime and Docker](docs/runner-runtime-and-docker.md)
- [Agent adapters](docs/agent-engine.md)
- [Streaming and reconnect](docs/streaming-and-reconnect.md)
- [Learning and memory](docs/learning-and-memory.md)
- [Render production](docs/render-production.md)
- [End-to-end verification](docs/end-to-end-verification.md)
- [Engineering standard](docs/engineering-standard.md)
- [Product vision and roadmap](docs/product-vision-and-roadmap.md)

## Local development

Requirements: Node.js 24 and npm.

~~~sh
npm install
npm run dev
~~~

Open **http://localhost:5173/**. Vite proxies `/v1` and `/health` to the API on **http://localhost:4000/**.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start web and API development servers |
| `npm run dev:web` | Start only the Vite client |
| `npm run dev:api` | Start only the API |
| `npm run typecheck` | Type-check workspaces |
| `npm test` | Run automated API tests |
| `npm run e2e` | Run API end-to-end checks against a live API |
| `npm run build` | Build all workspaces |
| `npm run render:build` | Production Render build entry point |

Pull requests and pushes to `main` run CI including API verification and the runner Docker/Chromium checks.

## Key code locations

| Layer | Location |
| --- | --- |
| Shared protocol/types | `packages/shared/src/index.ts` |
| HTTP/task admission | `apps/api/src/routes.ts` |
| Run execution | `apps/api/src/agents.ts` |
| Compute broker | `apps/api/src/compute-broker.ts` |
| Workspace lifecycle | `apps/api/src/workspaces.ts` |
| Durable workspace worker | `apps/api/src/workspace-jobs.ts` |
| Runner pool | `apps/api/src/runner-pool.ts` |
| Direct runner | `runner-direct/index.mjs` |
| Docker runner runtime | `runner-runtime/` |
| Docker runner manager | `runner-manager/` |
| Harness / steering / verification | `apps/api/src/harness.ts` |
| Verified learning memory | `apps/api/src/agent-memory.ts` |
| Canonical event persistence/redaction | `apps/api/src/events.ts` |
| Bridge gateway | `apps/api/src/bridge-gateway.ts` |
| Workspace bridge | `bridge/src/index.ts` |
| Direct OpenCode runtime | `apps/api/src/opencode-local.ts` |
| Agent adapter/runtime | `apps/api/src/agent-runtime.ts`, `apps/api/src/opencode*.ts` |
| Browser event projection | `apps/web/src/agent-stream/` |
| Main product shell | `apps/web/src/ProductionApp.tsx` |

## Production

Render is the active production control plane.

Pushes to `main` build/deploy through the configured Render service. The direct runner pool is configured separately and is health-checked by Orlynx itself.

Do not reintroduce Vercel into the active production runtime architecture.
