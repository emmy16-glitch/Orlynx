# What Orlynx is

## Product definition

Orlynx is a GitHub-native AI software-development workspace built around one durable project conversation.

The core idea is:

> A developer should be able to open an authorized repository, talk naturally, let Orlynx inspect or execute work when permitted, watch real evidence, survive infrastructure changes, and publish safely without manually operating the infrastructure underneath.

Orlynx is not just:

- a chat wrapper around a model;
- a hosted terminal;
- a Codespaces dashboard;
- a Git client;
- an AI autocomplete tool;
- a single coding-agent frontend;
- a runner dashboard.

It is the orchestration and product layer that binds those capabilities together.

## User mental model

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
Orlynx stores the request durably
   |
   v
Orlynx chooses direct or workspace execution
   |
   v
If workspace is needed, Compute Broker selects healthy compute
   |
   v
Model + tools work against real evidence
   |
   v
Harness verifies the requested outcome
   |
   v
Review result / changes / Preview
   |
   v
Publish only through controlled GitHub path
~~~

The user should not need to understand runner tokens, Docker layers, bridge sockets, provider health, task leases, SSE cursors, or OpenCode ports to use the product.

## What Orlynx owns

Orlynx owns product truth around:

- authenticated user and GitHub identity;
- authorized repositories;
- durable project sessions;
- chat messages and turn identity;
- task admission and ordering;
- active continuation and explicit queueing;
- mode, permission, model, and agent selection;
- compute routing and provider health;
- workspace lifecycle;
- adapter lifecycle;
- normalized event history;
- approvals/change sets;
- publication receipts;
- Preview readiness;
- verified lessons;
- secret redaction;
- audit.

The connected model is a reasoning component. It does not own durable state, authorization, provider routing, queue order, workspace identity, or publication policy.

## Ask, Plan, Build

### Ask

Ask is for explanation, normal conversation, and repository questions that do not require mutation.

It can use the direct model lane.

### Plan

Plan is for structured analysis, architecture work, debugging strategy, and implementation planning.

It can also use the direct lane when mutable execution is unnecessary.

### Build

Build is the execution lane.

It can use files, terminal, tests, builds, Git, browser/E2E, Preview, and deployment-related tooling according to permission and task requirements.

Build work is stored durably before execution starts.

## Direct lane versus workspace lane

The direct lane exists to avoid waking a development environment for lightweight conversation.

~~~text
Ask/Plan
   |
   v
direct OpenCode runtime
   |
   v
selected model
~~~

The direct runtime is an optimization. If it is temporarily unavailable before useful output, Orlynx can preserve the same durable task and move it to workspace compute.

Workspace execution is for real repository work.

~~~text
Build / execution-required task
   |
   v
Compute Broker
   |
   +-- Orlynx runner pool
   +-- E2B
   +-- GitHub Codespaces
   |
   v
workspace bridge
   |
   v
OpenCode adapter + model
~~~

Both lanes live under the same conversation.

## Compute Broker

The Compute Broker decides **where** mutable work should run and helps recover direct-runtime outages.

It uses:

- configured-provider availability;
- successes/failures;
- consecutive failures;
- latency history;
- temporary quarantine;
- runner capacity/load;
- browser/E2E capability;
- current healthy-workspace stickiness;
- providers already attempted during the current recovery.

It is not a model router. It is primarily an execution-compute router.

See [compute-broker.md](compute-broker.md).

## One conversation, not acknowledgement spam

Messages such as:

- “also check mobile”;
- “what have you done?”;
- “finish it”;
- “make sure tests pass too”;
- “I meant this part”;

continue the same active run when it is still steerable.

They are stored durably and fed into the active work before finalization.

Separate queued work is created only for clear next-task intent such as:

- “queue this”;
- “do this next”;
- “after this finishes...”.

Queued work is durable, ordered, editable, cancellable, and sequential.

## Harness and verification

The Orlynx harness tracks:

- lifecycle phase;
- step budget;
- allowed tool families;
- inferred acceptance criteria;
- satisfied/missing evidence;
- live user steering;
- contradictions;
- Investigation/reflection attempts;
- final synthesis;
- relevant verified lessons.

A model saying “done” is not enough.

Depending on the request, Orlynx may require proof of:

- file changes;
- tests;
- typecheck/build;
- Git state;
- commit/publication;
- deployment;
- Preview;
- browser research/E2E.

## Investigation loop

When reality conflicts with expectations, Orlynx uses a bounded evidence loop:

~~~text
Orlynx observation
    |
    v
Model hypothesis / next check
    |
    v
Real tool evidence
    |
    v
Harness verification
    |
    +-- resolved -> continue/finalize
    +-- unresolved -> another bounded Investigation
~~~

The UI can expose useful observable evidence and conclusions without exposing private hidden chain-of-thought.

## Workspace providers

Current workspace providers are:

### Orlynx runner pool

Current production has five direct Render runner services exposed as one logical pool.

The broker evaluates their health, capacity, load, latency, and browser capability.

### E2B

E2B provides isolated programmable sandboxes and is a supported workspace provider when configured.

### GitHub Codespaces

Codespaces remains a durable GitHub-managed provider and recovery path.

Provider change must preserve conversation and task identity.

## Runner implementations

There are two runner forms in the repository.

### Current direct Render runner

A Render service runs `runner-direct/index.mjs`, owns one workspace slot, clones the repository, starts the bridge/OpenCode runtime, and reports health.

### Docker runner-manager/runtime

For infrastructure with a Docker daemon, `runner-manager` can create multiple isolated containers from the prebuilt `runner-runtime` image.

See [runner-runtime-and-docker.md](runner-runtime-and-docker.md).

## Bridge

The Bridge is the authenticated boundary between control plane and workspace.

It exposes repository-scoped execution primitives:

- filesystem;
- PTY/shell;
- Git;
- tests/builds;
- ports;
- Preview;
- verification artifacts;
- agent runtime.

Commands are durable before relying on the socket fast path.

The Bridge also journals command results to reduce duplicate execution across reconnects.

## Agent adapters

OpenCode is Agent Adapter #1, not the definition of Orlynx.

Orlynx owns:

- task identity;
- permissions;
- compute;
- queueing;
- events;
- verification;
- memory;
- publication controls;
- UI projection.

Future adapters can replace OpenCode without recreating those contracts.

## Preview

Preview is a verified browser surface, not simply “a port exists.”

Orlynx checks local listener state, HTTP/browser suitability, provider forwarding, and public reachability.

Direct runners expose signed Preview routing. Codespaces uses provider forwarding. Browser-capable runner images include Playwright/Chromium.

## GitHub publication

The model runtime does not receive unrestricted GitHub publication authority.

Publication is controlled by Orlynx and requires explicit intent, branch validation, policy checks, safe Git state, and durable receipts.

Ambiguous branch targets are not guessed.

## Streaming and recovery

Normalized events are persisted and streamed through SSE.

The browser reconnects with its last durable sequence cursor.

This supports:

- network switching;
- app backgrounding;
- phone sleep;
- refresh;
- API restart;
- workspace reconnect;
- recovery of active work.

The browser is a view/controller over durable state, not the owner of the task.

## Learning

Orlynx does not retrain the connected model.

It stores a small set of verified lessons after evidence-driven work. Lessons are user-scoped, relevance-ranked, redacted, and subordinate to fresh evidence.

See [learning-and-memory.md](learning-and-memory.md).

## Current production status model

Current architecture should be described honestly:

- **Current:** Render control plane, Postgres durability, direct runtime, Compute Broker, five direct runners, E2B, Codespaces, bridge, OpenCode adapter, queue, harness, SSE replay.
- **Hardening:** larger-scale provider telemetry, longer-term broker history, additional runner capacity/manager deployment, broader browser/framework coverage.
- **Future:** additional agent adapters, organization-owned compute, advanced team memory, policy-driven autonomous maintenance.

See [product-vision-and-roadmap.md](product-vision-and-roadmap.md).
