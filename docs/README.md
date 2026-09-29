# Orlynx documentation

This directory is the maintained technical and product documentation for Orlynx.

Orlynx is a GitHub-native AI software-development workspace designed around a durable conversation rather than a disposable chat or a remote-terminal dashboard. A user connects GitHub, opens a repository, talks to Orlynx, lets it inspect or change the project when permitted, watches verified work as it happens, reviews evidence, and publishes through controlled GitHub paths.

The documentation has three jobs:

1. describe what the deployed product does now;
2. explain why the architecture works the way it does;
3. define the standards future Orlynx development must preserve.

## Start here

| Document | Purpose |
| --- | --- |
| [Orlynx overview](orlynx-overview.md) | Product definition, mental model, modes, execution lanes, queueing, Preview, publishing and current boundaries |
| [Architecture overview](architecture-overview.md) | End-to-end control plane, durable state, runner/Codespaces execution, bridge, adapters, events and recovery |
| [Learning and memory](learning-and-memory.md) | How Orlynx learns from verified work without pretending to retrain the connected model |
| [Product vision and roadmap](product-vision-and-roadmap.md) | What Orlynx is intended to become and the staged roadmap toward that goal |
| [Engineering standard](engineering-standard.md) | Non-negotiable reliability, security, UX, evidence and compatibility rules |
| [Production architecture](production-architecture.md) | Current production topology |
| [Render production](render-production.md) | Deployment and post-deploy verification |
| [Canonical agent stream](canonical-agent-stream.md) | Versioned event protocol, thread projection, Investigation blocks and replay |
| [Session lifecycle](session-lifecycle.md) | Durable conversation identity, continuation, queueing, restore and interruption |
| [Workspace runtime](workspace-runtime.md) | Execution providers, bridge, readiness and isolation |
| [Warm runner architecture](warm-runner-architecture.md) | Preferred low-latency execution provider and Codespaces fallback |
| [Agent adapters](agent-engine.md) | Replaceable coding-agent boundary; OpenCode is Adapter #1 |
| [End-to-end verification](end-to-end-verification.md) | Release acceptance contract |

## Documentation truth hierarchy

When documents disagree, use this order:

1. deployed code on the current main branch;
2. this documentation index and the canonical overview/architecture documents;
3. subsystem documents;
4. historical design notes.

Historical documents are retained because they explain how Orlynx evolved, but they must be clearly labelled as historical. They are not allowed to override current deployed behavior.

## Current production model

At the time of this documentation refresh, the deployed architecture is:

~~~text
Browser / phone
      |
      v
Orlynx control plane on Render
      |
      +-- GitHub App + repository authorization
      +-- direct Ask / Plan model lane
      +-- durable session, task, event and audit state in Postgres
      +-- workspace orchestration
      +-- authenticated bridge gateway
      |
      v
Workspace provider
      |
      +-- Orlynx warm runner (preferred when configured)
      |
      +-- GitHub Codespaces (fallback / recovery)
              |
              v
      Orlynx workspace bridge
              |
              +-- filesystem / PTY / Git / tests / build / Preview discovery
              +-- OpenCode adapter today
              +-- future adapters behind the same contract
~~~

The browser does not own product truth. Postgres and the server-side control plane do.

## Product principles reflected across the docs

Orlynx should always remain:

- **conversation-first** — one durable project conversation instead of disconnected command jobs;
- **GitHub-native** — repository identity, authorization and publication are first-class;
- **provider-agnostic** — models, coding agents and compute providers are replaceable behind Orlynx-owned boundaries;
- **evidence-driven** — completion means observable verification, not optimistic narration;
- **recoverable** — phone sleep, API restarts, workspace reconnects and provider fallback must not erase work;
- **secure by boundary** — secrets stay server-side, untrusted repository code stays outside the control-plane process, and consequential actions are explicit and audited;
- **mobile-first without becoming mobile-only** — a phone must remain a first-class control surface while desktop can expose more context;
- **honest about uncertainty** — Orlynx distinguishes observed facts, model hypotheses, verified conclusions and remaining unknowns;
- **progressively disclosed** — users see useful summaries first and detailed evidence when they ask for it.

## Current versus future capability

The roadmap distinguishes three statuses:

- **Current** — implemented and intended to be relied on now.
- **Hardening** — implemented foundation exists, but operational maturity, coverage or scale work remains.
- **Future** — architectural direction only; it must not be described in the UI as already available.

This status language is important. Orlynx documentation must never turn an aspiration into a claim about the deployed product.

## Documentation maintenance rule

Any change to one of the following requires a documentation review in the same pull request:

- task admission or queueing;
- continuation / steering behavior;
- workspace provider selection;
- agent-adapter contract;
- event types or replay semantics;
- memory / lesson persistence;
- GitHub authorization or publication;
- Preview readiness;
- secret handling;
- deployment topology;
- user-visible modes, permissions or recovery behavior.

The README is the entry point, but subsystem documents remain the detailed source for their individual contracts.
