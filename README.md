# Orlynx

Orlynx is a **phone-first, GitHub-native AI software-development workspace** built around one durable project conversation.

A user connects GitHub, opens an authorized repository, talks naturally, lets Orlynx inspect or execute work when permitted, watches real evidence as the work happens, reviews changes and Preview, and publishes through a controlled GitHub path.

Orlynx is not a demo-agent UI, a Codespaces dashboard, a hosted terminal, or a thin chat wrapper around one model. It is the product and orchestration layer that keeps repository identity, conversation, tasks, execution, verification, recovery, memory and publication coherent even when the model, coding agent or compute provider changes.

> **Current production architecture:** Render control plane + Postgres durable state + Orlynx warm runner when available + GitHub Codespaces fallback + authenticated workspace bridge + OpenCode as Agent Adapter #1.

There is no production fake agent, fake cloud state, PAT-entry flow or silent local fallback. When a real required integration is unavailable, Orlynx fails closed or falls back only through an explicit supported provider path.

## Start with the documentation

- [Documentation index](docs/README.md)
- [What Orlynx is](docs/orlynx-overview.md)
- [Architecture overview](docs/architecture-overview.md)
- [How Orlynx learns and remembers](docs/learning-and-memory.md)
- [Product vision and roadmap](docs/product-vision-and-roadmap.md)
- [Orlynx engineering standard](docs/engineering-standard.md)
- [End-to-end verification](docs/end-to-end-verification.md)

## Product mental model

~~~text
Open repository
   ↓
Talk to Orlynx
   ↓
Ask / Plan / Build
   ↓
Orlynx gathers facts and chooses the correct execution lane
   ↓
Direct model lane OR real workspace execution
   ↓
Orlynx ↔ Model Investigation loop when evidence conflicts
   ↓
Verification against the requested outcome
   ↓
Review changes / tests / Preview / receipts
   ↓
Controlled GitHub publication
   ↓
Verified lessons may improve future relevant work
~~~

The browser is a control surface. It is not the source of truth for active work.

## What Orlynx owns

Orlynx owns the durable product contracts around:

- authenticated user and GitHub identity;
- authorized repositories and branches;
- project sessions and message history;
- task admission and ordering;
- same-run continuation;
- explicit queued next work;
- model, mode, permission and agent selection;
- workspace lifecycle;
- agent-adapter readiness;
- canonical event history and replay;
- acceptance criteria and verification;
- approvals and change sets;
- Preview readiness;
- GitHub publication;
- verified learning/memory;
- secret redaction;
- audit.

The connected model provides reasoning. It does not own authorization, queue order, durable state, publication policy or the definition of “done.”

## Ask, Plan and Build

### Ask

For explanation, normal conversation and repository questions that do not require mutation.

Ask can use the direct model lane without starting a workspace.

### Plan

For structured analysis and implementation planning.

Plan can also stay in the direct lane when real execution is unnecessary.

### Build

For real project work: file edits, terminal commands, tests, builds, Git, Preview and deployment-related operations according to the task, permission profile and available tools.

Build work is admitted durably before execution.

## Continuation versus queueing

Natural messages such as “also check this”, “what have you done?”, “finish it” and “make sure mobile works too” continue the **same active run** while it is still steerable. They are stored in durable history and fed back to the connected model before finalization.

Only explicit next-task wording such as “queue this”, “do this next” or “after this finishes...” creates a separate queued task.

Queued work is durable, visible, editable, cancellable and sequential. It must not accidentally execute beside active work.

## Harness and verification

Orlynx uses an execution harness rather than trusting a completion sentence from the model.

The harness tracks phase, step budget, allowed tool families, live user steering, inferred acceptance criteria, satisfied/missing verification, contradictions, reflection attempts, final synthesis and relevant learned lessons.

Depending on the request, acceptance evidence may include:

- file changes;
- passing tests;
- successful build/typecheck;
- commit receipt;
- publication receipt;
- deployment evidence;
- browser-reachable Preview;
- browser research.

A model saying “done” is not proof that the requested outcome happened.

## Investigation blocks

When reality disagrees with the expected outcome, Orlynx uses a bounded evidence loop:

~~~text
Orlynx observation
    ↓
Model hypothesis / next check
    ↓
actual tool evidence
    ↓
Orlynx verification
    ↓
repeat only when needed
~~~

The UI groups this into ordered **Investigation 1, Investigation 2, ...** sections.

These sections expose useful hypotheses, evidence, corrections and conclusions. They do not expose private hidden chain-of-thought.

## How Orlynx learns

Orlynx does **not** retrain the connected model.

It learns through an Orlynx-owned verified lesson memory. A lesson can be stored only after reflection/investigation occurred, real evidence was gathered, the harness verification passed, and a usable verified resolution existed.

Lessons are user-scoped, normally repository-scoped, optionally environment-scoped, redacted, relevance-ranked and limited to a small top-ranked set. They are supplied to the model as evidence, not absolute truth.

Fresh verified evidence always overrides remembered information.

See [docs/learning-and-memory.md](docs/learning-and-memory.md).

## Production architecture

~~~text
Phone / browser
      |
      v
Orlynx control plane (Render)
      |
      +-- GitHub App / repository authorization
      +-- direct Ask / Plan model lane
      +-- task admission + verification harness
      +-- Postgres durable sessions/tasks/events/audit/memory
      +-- workspace orchestration
      +-- authenticated bridge gateway
      |
      v
Workspace provider
      |
      +-- Orlynx warm runner (preferred when configured)
      |
      +-- GitHub Codespaces (fallback/recovery)
              |
              v
      Orlynx workspace bridge
              |
              +-- PTY / Git / filesystem
              +-- tests / builds / Preview discovery
              +-- OpenCode (Adapter #1)
              +-- future agent adapters
~~~

Render owns the persistent Node web/API process, SSE, bridge gateway, GitHub integration, task orchestration and direct model lane.

When DATABASE_URL or POSTGRES_URL is configured, Postgres is authoritative for production state. Local JSON under data/ is development/test fallback only.

## Workspace providers

The Orlynx runner is preferred when configured because it can be prebuilt and prewarmed.

GitHub Codespaces remains a real supported fallback/recovery provider.

A provider change must preserve the same project conversation and task identity.

## Agent adapters

OpenCode is **Agent Adapter #1**, not the definition of Orlynx.

The adapter boundary allows future coding agents to implement the same Orlynx-owned contract for readiness, sessions, models, streaming, tools, cancel/resume and diff/change evidence.

Adding an agent should not require rebuilding session state, task scheduling, publication rules or the conversation UI.

See [docs/agent-engine.md](docs/agent-engine.md).

## Canonical events, streaming and recovery

Runtime/provider events are normalized into a versioned Orlynx event vocabulary before the primary UI depends on them.

Events are persisted with stable IDs and monotonically increasing session sequence numbers.

The browser streams through SSE and reconnects with its last sequence cursor. This allows recovery after phone sleep, network switching, backgrounding, refresh, API restart and workspace reconnect.

While the reader is near the latest output, Orlynx follows the stream. When the reader scrolls upward, auto-follow stops rather than dragging the viewport back down.

See [docs/canonical-agent-stream.md](docs/canonical-agent-stream.md) and [docs/streaming-and-reconnect.md](docs/streaming-and-reconnect.md).

## Preview

Preview is not considered ready merely because a port answers.

Orlynx checks browser suitability and provider forwarding. API-only JSON roots are rejected as browser previews.

The diagnostic order is provider-first: verify Orlynx/GitHub forwarding before changing project configuration just to work around infrastructure.

Supported Vite workspaces receive Orlynx-managed Codespaces compatibility so repositories should not normally need manual Vite host-allowance edits.

## GitHub publication

GitHub credentials stay server-side.

The agent shell cannot perform an unrestricted authenticated raw push.

When the user explicitly requests publication and configured policy allows it, Orlynx uses its controlled publication path. Explicit branch names are preserved exactly; Orlynx does not silently map one named branch to another.

Publication is rejected when required Git state or authorization is unsafe, and consequential actions are auditable.

## Secret handling

Secret-like values are redacted before event streaming and durable event persistence.

Historical events are sanitized again before replay or reflection.

The redaction layer recognizes common forms of GitHub tokens, API keys, authorization/bearer values and password/secret/token fields.

This is defense in depth; credentials should still be kept out of model-visible evidence whenever possible.

## Interface

The project experience is conversation-first.

Mobile primary navigation is intentionally compact:

~~~text
Chat · Files · Changes · More
~~~

Agent/model/mode/access controls live near the composer.

Infrastructure concepts such as bridge credentials, provider ports and container lifecycle are implementation detail unless they are needed for diagnosis.

## Quick start

Requirements: Node.js 24 and npm.

~~~sh
npm install
npm run dev
~~~

Open **http://localhost:5173/**. Vite proxies /v1 and /health to the API on **http://localhost:4000/**.

| Command | Purpose |
| --- | --- |
| npm run dev | Start web and API development servers |
| npm run dev:web | Start only the Vite client |
| npm run dev:api | Start only the API |
| npm run typecheck | Type-check workspaces |
| npm test | Run automated API tests |
| npm run e2e | Run API end-to-end checks against a live API |
| npm run build | Build all workspaces |
| npm run render:build | Production Render build entry point |

Pull requests and pushes to main run repository verification through GitHub Actions.

## Key code locations

| Layer | Location |
| --- | --- |
| Shared protocol/types | packages/shared/src/index.ts |
| Task admission/direct execution | apps/api/src/agents.ts |
| Harness / verification / steering | apps/api/src/harness.ts |
| Verified learning memory | apps/api/src/agent-memory.ts |
| Canonical event persistence/redaction | apps/api/src/events.ts |
| Bridge gateway | apps/api/src/bridge-gateway.ts |
| Agent adapter/runtime | apps/api/src/agent-runtime.ts, apps/api/src/opencode*.ts |
| Workspace bridge | bridge/src/index.ts |
| Browser event store/projection | apps/web/src/agent-stream/ |
| Typed work renderers | apps/web/src/ui/tool-parts.tsx |
| Main product shell | apps/web/src/ProductionApp.tsx |
| Warm runner | runner-manager/, runner-runtime/ |

## Production

Render is the production control plane.

Do not reintroduce Vercel into the active Orlynx runtime architecture.

Pushes to main build/deploy through the configured Render service using scripts/render-build.sh.

See [Render production](docs/render-production.md), [Production architecture](docs/production-architecture.md), [Warm runner architecture](docs/warm-runner-architecture.md), [Secrets and environment](docs/secrets-and-environment.md) and [End-to-end verification](docs/end-to-end-verification.md).

## Long-term direction

Orlynx is intended to become a persistent engineering workspace with multiple interchangeable coding-agent adapters, stronger verified repository intelligence, CI/CD and production feedback as verification evidence, team/shared project memory with explicit access controls, policy-aware higher autonomy, specialized subagents coordinated under one durable parent task, additional/self-hosted execution backends, and stronger enterprise isolation/audit/retention controls.

Future roadmap items are not current-product claims.

See [docs/product-vision-and-roadmap.md](docs/product-vision-and-roadmap.md).
