# What Orlynx is

## Product definition

Orlynx is a GitHub-native AI software-development workspace built around one durable project conversation.

The core idea is simple:

> A developer should be able to open a real repository, talk naturally, let Orlynx inspect or execute work when authorized, see what was actually observed and changed, recover from interruptions, and publish safely without needing to manually operate the infrastructure underneath.

Orlynx is therefore not just:

- a chat wrapper around a model;
- a hosted terminal;
- a Codespaces dashboard;
- a Git client;
- an AI autocomplete tool;
- or a single coding-agent frontend.

It is the orchestration and product layer that binds those capabilities together.

## The user mental model

A user should think in project terms:

~~~text
Open repository
   ↓
Talk to Orlynx
   ↓
Orlynx understands whether this is Ask, Plan or Build work
   ↓
Orlynx gathers evidence
   ↓
If execution is needed, Orlynx uses a workspace
   ↓
The connected model and Orlynx iterate against real evidence
   ↓
Orlynx verifies the requested outcome
   ↓
The user reviews result / changes / Preview
   ↓
Publish only through an authorized GitHub path
~~~

The user should not need to understand runner containers, bridge sockets, provider tokens, internal task leases, SSE cursors or OpenCode server ports in order to use the product.

Those details exist to make the simple experience reliable.

## What Orlynx owns

Orlynx owns the product-level truth around:

- authenticated user and GitHub identity;
- authorized repositories;
- durable project sessions;
- chat messages and turn identity;
- task admission and ordering;
- live continuation while a task is active;
- explicit next-task queueing;
- mode and permission state;
- workspace lifecycle;
- agent-adapter selection and readiness;
- normalized event history;
- approvals;
- change sets;
- publication receipts;
- Preview readiness;
- verified lessons learned from earlier successful work;
- security redaction and audit state.

The connected model is a reasoning component inside that system. It does not own session truth, authorization, queue order, workspace identity or publication policy.

## Ask, Plan and Build

Orlynx separates intent from execution.

### Ask

Ask is for explanation, repository understanding and normal conversation.

The direct model lane can answer without starting a mutable workspace when execution is unnecessary. Repository context may be loaded in a bounded way. Ask should not pretend to have changed files or run commands.

### Plan

Plan is for structured analysis and proposed implementation strategy.

Like Ask, Plan may use the direct lane when mutation is not required. It can inspect available context and reason about implementation without automatically modifying the repository.

### Build

Build is the execution lane.

A Build request can use repository files, filesystem mutation, terminal commands, tests, builds, Git, Preview and deployment-related tools according to the selected permission profile and the task's inferred acceptance criteria.

Build work is durable before execution starts.

## One conversation, not acknowledgement spam

A central Orlynx rule is that an active user goal should remain one conversation and one run where possible.

If the user sends:

- “also check this”;
- “what have you done?”;
- “finish it”;
- “make sure mobile works too”;
- “I meant this part”;

while the run is still steerable, Orlynx treats those messages as continuation of the same active task. It preserves them in durable history and feeds the new context back to the connected model before finalization.

This avoids fake assistant acknowledgements and fragmented task identity.

### Explicit queued work

A separate queued task is created only when the user expresses clear next-task intent such as:

- “queue this”;
- “do this next”;
- “after the current task finishes...”;
- “once this is done, then...”.

Queued tasks are durable, visible, ordered and sequential. They can be edited or cancelled before they start.

Queued work must not accidentally execute beside the active task.

## The Orlynx harness

Build execution is governed by an Orlynx-owned harness.

The harness tracks:

- current phase;
- step budget;
- allowed tool families;
- inferred acceptance criteria;
- satisfied and missing verification;
- live user steering;
- contradictions between expected and observed state;
- reflection attempts;
- final synthesis;
- verified lessons applied from memory.

Examples of inferred acceptance criteria include:

- file changes;
- tests;
- build/typecheck;
- commit;
- publish;
- deployment;
- Preview;
- browser research.

Orlynx does not accept “I changed it” as proof. It looks for durable evidence that satisfies the task's acceptance criteria.

## Orlynx ↔ model Investigation loop

When something does not line up, Orlynx exposes a structured diagnostic conversation rather than hidden mystery behavior.

The useful loop is:

~~~text
Orlynx observation
    ↓
Model hypothesis / next check
    ↓
Real tool evidence
    ↓
Orlynx verification
    ↓
repeat only if necessary
~~~

The UI groups this into ordered **Investigation 1, Investigation 2, ...** sections.

These blocks show useful observable reasoning artifacts: what Orlynx observed, what hypothesis the connected model chose to test, and what evidence came back.

They do not expose private hidden chain-of-thought.

## Execution providers

Orlynx separates the control plane from mutable repository execution.

The preferred execution path is the Orlynx warm runner when it is configured and healthy. GitHub Codespaces remains a supported fallback and recovery provider.

Both providers run the same Orlynx workspace bridge contract so the product experience remains stable even when compute changes underneath.

The user conversation should not restart because the execution provider changes.

## Agent adapters

OpenCode is the first production coding-agent adapter, not the definition of Orlynx itself.

Orlynx owns:

- task identity;
- permissions;
- tools exposed to the adapter;
- event normalization;
- queueing;
- verification;
- memory;
- publication controls;
- UI projection.

A future adapter can replace OpenCode for a task while keeping those product contracts unchanged.

## Preview

Preview is a verified browser surface, not “a process happened to bind a port.”

Orlynx distinguishes:

- a running process;
- an HTTP service;
- an API-only endpoint;
- a browser-renderable application;
- provider forwarding;
- a browser-resolvable public Preview URL.

The Preview diagnosis path checks Orlynx/provider forwarding before modifying project files merely to work around infrastructure.

Supported development servers such as Vite receive Orlynx-managed cloud-preview compatibility where possible.

## GitHub publication

The model runtime does not receive unrestricted GitHub credentials.

Publication is controlled by Orlynx. Explicit push/publish intent is parsed conservatively. Orlynx does not silently translate an explicitly named branch into another target.

Default-branch publication is permitted only through the controlled path when the user's explicit request and configured policy allow it. Publication evidence is stored and auditable.

Ambiguous branch intent is not guessed.

## Streaming and recovery

Orlynx persists normalized events before relying on the browser to display them.

The browser receives live Server-Sent Events and reconnects using a session sequence cursor.

This supports:

- network interruption;
- app backgrounding;
- phone sleep;
- API restart;
- workspace reconnect;
- replay without duplicate tool rows;
- recovery of partial assistant output.

While the user remains near the newest content, the UI follows streaming output. If the user scrolls upward to read older content, auto-follow stops instead of pulling them back down.

## How Orlynx learns

Orlynx has a verified lesson memory system. This is not model retraining.

A lesson is eligible to be stored only after a task required reflection and the Orlynx harness later verified the requested outcome.

Lessons are:

- scoped to the user;
- usually repository-specific;
- optionally environment-scoped for recurring infrastructure patterns;
- redacted;
- tagged from the problem, evidence and resolution;
- retrieved only when the new prompt has meaningful relevance;
- limited to a small top-ranked set;
- presented to the model as evidence, not truth.

Fresh current evidence wins whenever memory conflicts with reality.

See [learning-and-memory.md](learning-and-memory.md).

## Security model

The main security boundaries are:

- GitHub App authorization rather than a user PAT entry flow;
- server-side GitHub and model credentials;
- encryption for persisted sensitive provider credentials;
- short-lived scoped bridge credentials;
- secret redaction before streaming and durable event storage;
- re-sanitization of historical event replay;
- user-isolated learned lessons;
- per-workspace execution isolation;
- server-side permission enforcement;
- explicit audit for consequential actions.

Untrusted repository code runs in the execution plane, not inside the Render control-plane process.

## What Orlynx is becoming

The long-term direction is an independent software-development operating layer in which:

- one project conversation can span devices and compute providers;
- multiple coding-agent adapters can be selected without changing the product;
- memory improves repeated work without becoming stale dogma;
- testing, Preview, deployment and observability are native verification surfaces;
- tasks can become more autonomous while retaining evidence and human control;
- repository policies can be enforced consistently across every model and agent;
- teams can share durable project intelligence rather than isolated prompts;
- Orlynx can coordinate specialized agents while preserving one coherent user-facing conversation.

That future is defined in [product-vision-and-roadmap.md](product-vision-and-roadmap.md). Future items are aspirations until implemented and verified.
