# Orlynx architecture overview

## Architectural goal

Orlynx separates **product truth**, **reasoning**, **execution**, and **presentation** so no browser session, model, agent runtime, or compute provider becomes the whole system.

Five core ideas drive the design:

1. the conversation survives infrastructure change;
2. a task is admitted durably before execution;
3. execution compute is replaceable;
4. events/evidence are normalized before presentation;
5. completion is verified against the user's requested outcome.

## Current topology

~~~text
                          Browser / phone
                               |
                         HTTPS + SSE
                               |
                               v
┌──────────────────────────────────────────────────────────────────┐
│                 Orlynx control plane on Render                  │
│                                                                  │
│ Identity / GitHub App / sessions / messages / tasks / queue     │
│ Direct OpenCode conversational lane                              │
│ Harness / verification / reflection                              │
│ Compute Broker                                                   │
│ Workspace orchestrator                                           │
│ Bridge gateway                                                   │
│ Agent adapter registry                                           │
│ Events / replay / redaction                                      │
│ Memory / approvals / publication / audit                         │
└──────────────┬───────────────────────────────┬───────────────────┘
               │                               │
               │ Postgres                      │ workspace routing
               v                               v
       Durable product truth             Compute Broker
                                               |
                            ┌──────────────────┼──────────────────┐
                            v                  v                  v
                     Orlynx runners           E2B          GitHub Codespaces
                            \                  |                  /
                             \                 |                 /
                              └──────────┬──────┴────────────────┘
                                         v
                              Authenticated workspace bridge
                                         |
                            ┌────────────┼────────────┐
                            v            v            v
                          files        shell/Git    tests/Preview
                                         |
                                         v
                                   OpenCode adapter
                                         |
                                         v
                                    selected model
~~~

## Browser layer

The browser is responsible for:

- rendering the durable project conversation;
- submitting user messages;
- selecting model/mode/access/agent;
- showing queue state;
- projecting normalized live activity;
- files/changes/terminal/Preview surfaces;
- reconnecting from the last durable event cursor.

It is not responsible for deciding whether a task completed.

A browser refresh must not erase task identity.

## Control plane

The Render control plane is the Orlynx product brain.

It owns:

- authentication;
- GitHub authorization;
- sessions;
- task admission;
- continuation vs queue semantics;
- model/mode/permission preferences;
- Compute Broker routing;
- workspace orchestration;
- harness/verification;
- memory;
- event persistence/replay;
- approvals;
- publication/audit.

Arbitrary repository code does not run inside the web/API process.

## Production processes

`apps/api/scripts/production-start.mjs` supervises:

- the API process;
- the durable workspace-orchestrator worker when Postgres is configured.

If either supervised child exits unexpectedly, the supervisor shuts down so the host can restart cleanly instead of leaving a half-alive production instance.

## Postgres durable truth

Production Postgres stores authoritative state for subsystems such as:

- users;
- GitHub installations/connections;
- projects;
- sessions;
- messages;
- tasks;
- harness state;
- canonical events;
- AI preferences;
- workspaces;
- workspace jobs/leases;
- bridge commands/results;
- agent sessions;
- approvals/change sets;
- publication/deployment receipts;
- lessons;
- webhook/audit records.

Local JSON storage is development/test fallback only.

## Task admission

A user message that requires a run becomes durable before execution.

~~~text
user message
    |
    v
durable message
    |
    v
durable task
    |
    +-- continue active run
    +-- start current turn
    +-- queue explicit next task
    |
    v
execution
    |
    v
durable normalized evidence
    |
    v
verification
    |
    v
durable assistant result
~~~

## Queue and continuation

A natural follow-up stays attached to the active run when possible.

An explicit next-task request creates a separate durable queued task.

The scheduler must not promote queued work while another task is:

- running;
- waiting for user input;
- waiting for approval.

Completion is also guarded against a late steering race so a last-moment follow-up cannot be overwritten by an older finalization snapshot.

## Direct execution lane

Lightweight Ask/Plan work can use the direct OpenCode runtime without a workspace.

Direct runtime behavior includes:

- bounded health wake/probe;
- durable OpenCode conversation keying;
- re-creation of lost runtime sessions;
- recovery context from Orlynx durable history;
- streaming first-token/silence protection;
- temporary broker quarantine after infrastructure failure.

If the runtime fails before useful output, the same durable task can be promoted to workspace compute.

## Compute Broker

The broker chooses workspace providers and tracks direct-runtime health.

It scores:

- GitHub Codespaces;
- E2B;
- Orlynx runner pool.

Inputs include success history, consecutive failures, latency EMA, quarantine, current workspace preference, attempted providers, runner capacity/load, and browser capability.

See [compute-broker.md](compute-broker.md).

## Workspace provider abstraction

Workspace providers implement a common Orlynx lifecycle so provider choice does not change product semantics.

Current provider IDs are:

- `orlynx-runner`;
- `e2b`;
- `github-codespaces`.

A provider switch must preserve session/task identity.

## Orlynx runner pool

The runner pool treats several runner hosts as one logical execution backend.

Current hosted production uses five direct Render runner services.

The pool tracks per-host:

- health;
- capacity;
- running/available count;
- draining state;
- latency;
- browser/E2E capability;
- circuit-open state;
- workspace ownership.

A hosting-provider “live” status is not enough; Orlynx uses application-level health.

## E2B

E2B is an independent isolated workspace provider.

It gives Orlynx another recovery path outside both the direct Render runner pool and GitHub Codespaces.

## GitHub Codespaces

Codespaces provides GitHub-managed repository compute and remains a supported durable provider.

It uses the same bridge/task/event contracts after bootstrap.

## Workspace orchestrator

The broker chooses the provider; the orchestrator prepares it.

Workspace preparation jobs are stored durably.

The worker:

1. claims a job with a lease;
2. renews the lease during long preparation;
3. prepares provider/bridge/runtime;
4. retries transient failure with bounded backoff;
5. completes or records a precise failure;
6. periodically sweeps active sessions for recovery.

A dead worker does not own the job forever; its lease expires and another recovery pass can continue.

## Bridge

The Bridge connects outbound from the workspace to the control plane using scoped credentials.

Capabilities include:

- fs;
- exec/PTY;
- Git;
- ports;
- tests/builds;
- Preview discovery;
- verification artifacts;
- agent adapters.

Commands are persisted before socket delivery. The Bridge remembers completed command results and avoids double execution for the same command ID.

## Workspace readiness vs adapter readiness

A workspace and its coding agent are intentionally separate state machines.

A workspace can have:

~~~text
shell/files/Git ready
OpenCode starting
~~~

or:

~~~text
workspace ready
OpenCode temporarily unavailable
~~~

This allows Orlynx to repair the agent without falsely declaring the entire environment dead.

## OpenCode adapter

OpenCode is Adapter #1.

The adapter boundary translates OpenCode lifecycle, model selection, streaming, tools, cancel/resume, and change evidence into Orlynx-owned semantics.

Future coding agents should plug into that boundary rather than duplicating session/task/permission architecture.

## Runner runtime and Docker

The repository contains:

- current direct runner implementation;
- Docker runner-runtime image;
- Docker runner-manager.

The Dockerfile is the build recipe, the image is the packaged environment, and a container is a running image instance.

The runner-runtime image bakes in the bridge, OpenCode, Playwright/Chromium, and common development dependencies.

See [runner-runtime-and-docker.md](runner-runtime-and-docker.md).

## Harness and verification

The harness translates user intent into observable acceptance criteria.

Evidence may include:

- changed files;
- tests;
- build/typecheck;
- Preview;
- browser E2E;
- commit/publish/deploy receipts.

Missing evidence prevents optimistic completion.

## Canonical events

Provider/runtime events are normalized into Orlynx-owned event types with stable IDs and session sequence numbers.

The frontend renders typed Orlynx events instead of raw provider payloads.

## Streaming and recovery

SSE delivers browser activity.

Recovery is:

~~~text
authoritative snapshot + ordered events after cursor = current view
~~~

The architecture is designed for:

- phone sleep;
- network switching;
- browser refresh;
- API restart;
- bridge reconnect;
- provider migration.

## GitHub publication

GitHub credentials remain server-side.

Agents do not get unrestricted raw publication authority.

Orlynx enforces explicit intent, branch safety, policy, audit, and publication receipts.

## Learning

Verified lessons live above the model.

Fresh current evidence outranks prior memory.

## Failure philosophy

Orlynx should fail closed on security and recover on infrastructure.

Examples:

- missing repository authorization -> block mutation;
- browser offline -> server work continues;
- direct runtime 502 -> quarantine and switch compute;
- runner failure -> broker tries another provider;
- lost bridge -> durable reconnect/retry;
- stale checkout with only incidental lockfile drift -> preserve recovery patch and fast-forward;
- missing verification -> do not claim completion.

## Architecture invariants

Future refactors should preserve:

1. no browser-only source of truth;
2. no model-owned authorization state;
3. no fixed provider hard dependency for ordinary infrastructure failures;
4. no provider-specific UI protocol;
5. no hidden parallel queue execution;
6. no completion without required evidence;
7. no memory leakage across users;
8. no unrestricted secret exposure to repository code;
9. no Preview readiness based on a guessed URL;
10. no new agent/provider that forks the product architecture.

## Recovery hardening, 2026-09-30

Task promotion locks the session in a READ COMMITTED transaction, then checks running work across execution lanes and human-waiting workspace work. Workspace jobs fence terminal writes by worker, attempt generation and unexpired lease. Event sequence allocation and insertion commit in one statement. See [the reliability audit](reliability-audit-2026-09-30.md).
