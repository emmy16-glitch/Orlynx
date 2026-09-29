# Orlynx architecture overview

## Architectural goal

Orlynx separates product truth, reasoning, execution and presentation so that no single model, provider or browser session is allowed to become the whole system.

The architecture is designed around five durable ideas:

1. the conversation survives infrastructure changes;
2. tasks are admitted before execution;
3. execution providers are replaceable;
4. evidence is normalized before presentation;
5. completion is verified against the user's requested outcome.

## Topology

~~~text
                          ┌─────────────────────────────┐
                          │ Browser / phone / desktop   │
                          │ Chat · Files · Changes      │
                          └──────────────┬──────────────┘
                                         │ HTTPS + SSE
                                         v
┌─────────────────────────────────────────────────────────────────────┐
│                    Orlynx control plane on Render                   │
│                                                                     │
│  Identity / GitHub App / sessions / messages / tasks / queue       │
│  Direct Ask + Plan lane                                             │
│  Harness + verification + reflection                                │
│  Memory retrieval + verified lesson persistence                     │
│  Workspace orchestration                                             │
│  Agent adapter registry                                              │
│  Event normalization / replay / redaction                           │
│  Changes / approvals / publication / audit                          │
└───────────────┬───────────────────────────┬───────────────────────────┘
                │                           │
                │ Postgres                  │ authenticated bridge WS
                v                           v
      ┌───────────────────┐        ┌──────────────────────────────┐
      │ Durable product   │        │ Workspace execution provider │
      │ truth             │        │                              │
      │ sessions/tasks    │        │  Orlynx Runner preferred     │
      │ events/audit/etc. │        │  Codespaces fallback         │
      └───────────────────┘        └──────────────┬───────────────┘
                                                  │
                                                  v
                                      ┌──────────────────────────┐
                                      │ Orlynx workspace bridge  │
                                      │ files / PTY / Git        │
                                      │ tests / builds / ports   │
                                      │ Preview / agent runtime  │
                                      └──────────────┬───────────┘
                                                     │
                                                     v
                                      ┌──────────────────────────┐
                                      │ Agent Adapter             │
                                      │ OpenCode today            │
                                      │ future adapters later     │
                                      └──────────────────────────┘
~~~

## 1. Browser layer

The browser is a client of durable state, not the owner of that state.

It is responsible for:

- rendering the project conversation;
- submitting user messages;
- selecting model, mode, access and agent;
- showing queued work;
- presenting normalized live activity;
- rendering Investigation blocks;
- showing files, changes, terminal and Preview;
- keeping draft/local convenience state;
- reconnecting from the last durable sequence.

It is not responsible for deciding whether a task actually completed.

A browser refresh must not erase task identity.

## 2. Control plane

The control plane is the Orlynx product brain.

It owns:

- authentication;
- GitHub authorization;
- session identity;
- task admission;
- active-versus-queued semantics;
- steering and continuation;
- selected workspace provider;
- model and agent preferences;
- harness state;
- verification requirements;
- event persistence;
- redaction;
- learned lessons;
- approvals;
- publication policy;
- audit.

The control plane intentionally does not execute arbitrary repository code inside the Render web process.

## 3. Durable state

Production uses Postgres as authoritative state.

Durable data includes, depending on subsystem:

- users;
- GitHub connections/installations;
- projects;
- sessions;
- messages;
- tasks;
- task harness checkpoints;
- normalized events;
- AI preferences;
- workspaces;
- agent sessions and adapter health;
- bridge commands/results;
- change sets;
- approvals;
- publication/deployment receipts;
- learned lessons;
- webhook delivery receipts;
- audit records.

Local JSON storage is a development/testing fallback only.

## 4. Task admission

A user message that requires a run becomes durable before execution.

The basic flow is:

~~~text
user message
   ↓
durable message
   ↓
durable task
   ↓
active continuation OR queued work
   ↓
execution
   ↓
durable normalized evidence
   ↓
verification
   ↓
durable assistant result
~~~

This gives Orlynx a stable answer to the question:

> What work did the user actually ask for, and what state is it in now?

## 5. Continuation and queueing

Orlynx distinguishes two kinds of follow-up.

### Continuation

A natural follow-up to the active task remains attached to the current run.

Examples:

- “also check mobile”;
- “finish the remaining part”;
- “what have you done?”;
- “make sure the tests still pass”.

These become durable steering input and are fed back to the connected model.

### Explicit next task

Clear queue intent creates a separate durable task.

Examples:

- “queue this”;
- “do this next”;
- “after this finishes, update docs”.

Queued work is sequential.

The scheduler must not promote a queued task while another task is running, waiting for input or waiting for approval.

## 6. Direct lane versus workspace lane

Orlynx has two execution planes.

### Direct lane

Used when the request can be answered without mutable project execution.

Typical work:

- conversation;
- repository explanation;
- Ask;
- Plan;
- bounded context lookup.

The direct lane can stream the connected model response through the same durable conversation model.

### Workspace lane

Used when the task needs real project execution.

Typical work:

- file edits;
- terminal commands;
- tests;
- builds;
- Git operations;
- Preview;
- deployment work;
- browser research when required by the task and supported.

Both lanes obey the same high-level conversation semantics.

## 7. Harness and verification

The harness is Orlynx's execution discipline.

It determines which tool families are available and what observable acceptance evidence is required.

A task may require proof of:

- changes;
- tests;
- build;
- commit;
- publish;
- deployment;
- Preview;
- browser research.

The harness keeps a bounded step budget and moves through phases such as receiving, context loading, executing, verifying, waiting, finalizing and completed/failed/cancelled.

If required evidence is missing, Orlynx should continue working or explain the precise unresolved boundary instead of claiming success.

## 8. Reflection / Investigation

When observed state contradicts the expected result, Orlynx can enter a reflection loop.

The reflection loop is bounded and evidence-driven.

~~~text
unexpected observation
    ↓
Orlynx records contradiction
    ↓
connected model proposes next hypothesis/check
    ↓
Orlynx executes allowed check
    ↓
new evidence
    ↓
verify again
~~~

The UI exposes this in ordered Investigation sections.

Private model chain-of-thought is not stored or rendered.

## 9. Workspace provider abstraction

Mutable project execution is behind a provider boundary.

### Orlynx Runner

The preferred provider when configured.

Characteristics:

- prebuilt runtime image;
- background prewarming;
- isolated workspace;
- preinstalled bridge;
- preinstalled/pinned agent runtime;
- low startup latency relative to cold Codespaces;
- controlled capacity and idle reclamation.

### GitHub Codespaces

Supported fallback and recovery provider.

Characteristics:

- GitHub-managed compute;
- existing repository authorization relationship;
- slower cold-start path;
- same bridge contract once connected.

A provider switch must preserve session and task identity.

## 10. Bridge

The bridge is the authenticated boundary between control plane and workspace.

It provides the operational primitives Orlynx needs without handing the model direct control-plane credentials.

Capabilities include:

- filesystem operations;
- PTY/shell;
- Git;
- tests/build commands;
- Preview port discovery;
- agent runtime startup/session;
- structured events;
- command result delivery.

Bridge credentials are short-lived and scoped.

Commands are persisted before relying on the socket fast path.

## 11. Agent adapter boundary

A coding agent is replaceable.

The adapter declares capabilities and translates between the selected agent runtime and Orlynx's canonical task/event model.

OpenCode is Adapter #1.

The adapter is not allowed to redefine:

- task ordering;
- durable session identity;
- permissions;
- publication policy;
- event replay;
- memory ownership;
- UI structure.

This makes future adapters possible without duplicating the application architecture.

## 12. Canonical event protocol

Provider events are normalized into Orlynx-owned event types.

Important categories include:

- run lifecycle;
- assistant messages;
- tools;
- terminal;
- files;
- tests;
- builds;
- Preview;
- approvals;
- workspace state;
- changes;
- receipts;
- extension events.

Events have stable IDs and session sequence numbers.

The browser projects them into typed message parts rather than rendering raw provider payloads.

## 13. Streaming and recovery

SSE is used for browser activity delivery.

The browser reconnects with its last durable sequence:

~~~text
GET /v1/sessions/:id/events?after=<sequence>
~~~

Recovery uses:

~~~text
authoritative snapshot + later ordered events = current view
~~~

The system is designed so replay cannot duplicate one logical tool call into multiple visible rows.

## 14. Secret redaction

Sensitive values are redacted before they become durable event payloads or streamed output.

Current protections recognize common forms of:

- GitHub tokens;
- API keys;
- authorization/bearer values;
- password/secret fields;
- token-like long values.

Historical event replay is sanitized again before reuse.

Memory evidence is separately cleaned before persistence.

Redaction is defense in depth; it does not replace proper credential isolation.

## 15. Preview architecture

Preview readiness is product state, not string matching.

Orlynx checks whether a port corresponds to a usable browser surface and whether provider forwarding resolves to a browser-reachable URL.

JSON/API-only roots are not treated as browser Preview.

The diagnostic order is provider-first:

1. local process/listener;
2. HTTP/browser suitability;
3. provider forwarding;
4. public URL;
5. project configuration only when evidence points there.

This reduces destructive “fix the app config until Preview works” behavior.

## 16. GitHub publication

GitHub credentials stay outside the agent shell.

Publication happens through Orlynx-controlled operations.

The system must preserve:

- exact branch intent;
- explicit user publish intent;
- policy checks;
- clean/valid Git state;
- audit trail;
- publication receipt.

An explicitly named branch is never silently remapped.

## 17. Learning

Orlynx learning happens above the model.

Verified post-reflection lessons are stored in Orlynx durable memory and selectively applied to future relevant work.

See [learning-and-memory.md](learning-and-memory.md).

## 18. Failure philosophy

Orlynx should fail closed on security and fail recoverably on infrastructure.

Examples:

- missing GitHub authorization → block repository mutation;
- lost browser connection → keep task alive and replay later;
- dead agent runtime → preserve workspace shell/files/Git where possible;
- runner failure → use Codespaces fallback if policy allows;
- stale remembered lesson → prefer fresh evidence;
- ambiguous branch target → investigate or ask, never guess;
- missing verification → do not claim completion.

## 19. Architecture invariants

Future refactors should preserve these invariants:

1. no browser-only source of truth for active work;
2. no model-owned authentication state;
3. no provider-specific UI protocol;
4. no unbounded raw event/log persistence;
5. no hidden parallel queue execution;
6. no completion without evidence where evidence is required;
7. no memory across users;
8. no direct secret exposure to repository code unless explicitly required by a narrow operation;
9. no Preview readiness based on a guessed URL;
10. no architecture fork for each new agent adapter or compute provider.
