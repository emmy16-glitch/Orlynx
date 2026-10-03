# Orlynx product vision and roadmap

## Vision

Orlynx is intended to become a durable software-development operating layer between people, repositories, AI models, coding agents and compute.

The long-term product should make this workflow normal:

> Open any authorized repository from any device, continue one project conversation, choose the model or agent appropriate for the work, let Orlynx execute safely, watch evidence rather than theatre, recover from failures, and carry verified project intelligence forward.

The goal is not “an AI that writes code.”

The goal is a system that can **coordinate software work reliably**.

## Product north star

A mature Orlynx project session should behave more like a persistent engineering teammate/workspace than a disposable prompt box.

That means:

- it remembers verified project facts;
- it knows what work is active, queued, blocked and complete;
- it distinguishes asking from planning from execution;
- it can change compute providers without losing context;
- it can change coding agents without changing the product;
- it can prove what it did;
- it can recover after interruption;
- it can hand consequential decisions back to the user;
- it can operate comfortably from a phone;
- it does not require the user to babysit infrastructure.

## What “standard” should mean for Orlynx

The ambition is for Orlynx to establish a strong standard for AI development workspaces in six areas.

### 1. Conversation continuity standard

One user goal should remain one coherent turn/run until it is complete or genuinely becomes a separate task.

No acknowledgement spam.
No accidental duplicate runs.
No silent loss of follow-up instructions.

### 2. Evidence standard

A system should not say “done” merely because the model emitted a completion sentence.

Completion should connect to observable evidence such as:

- files changed;
- tests passed;
- build succeeded;
- Preview is reachable;
- commit exists;
- publication receipt exists;
- deployment is healthy.

### 3. Recovery standard

A serious development workspace should tolerate:

- phone sleep;
- network changes;
- tab closure;
- API restart;
- workspace reconnect;
- agent runtime restart;
- compute-provider failover and quarantine.

without losing the user's durable project state.

### 4. Agent portability standard

The product should own the contract.

Coding agents should plug in behind one adapter boundary instead of forcing a new UI, task scheduler, permission model and event protocol for every agent.

### 5. Verified memory standard

AI workspace memory should not mean “stuff every old chat into the prompt.”

It should mean:

- remember verified outcomes;
- preserve provenance;
- scope by user/project;
- retrieve by relevance;
- decay/correct stale knowledge;
- prefer fresh evidence.

### 6. Human-control standard

Higher autonomy must not mean invisible authority.

The system should make consequential state clear:

- what is active;
- what is queued;
- what requires approval;
- what will be published;
- where it will be published;
- what evidence supports completion.

## Current foundation

The present architecture already contains the foundation for that direction:

- durable GitHub-linked project sessions;
- direct Ask/Plan lane;
- Build workspace lane;
- adaptive Compute Broker;
- five-host direct Orlynx runner pool;
- E2B workspace provider;
- GitHub Codespaces workspace provider;
- provider quarantine and healthy-workspace stickiness;
- authenticated bridge;
- OpenCode adapter boundary;
- durable task ledger;
- sequential explicit queue;
- live same-run continuation;
- canonical event protocol;
- typed activity rendering;
- SSE replay;
- Investigation blocks;
- verification harness;
- verified lesson memory;
- server-side secret redaction;
- controlled GitHub publication;
- Preview provider diagnosis;
- mobile-first conversation UI.

## Roadmap

The roadmap is intentionally staged. Future items below are not current-product claims.

### Stage A — Harden the current single-project loop

Status: **current + hardening**

Goals:

- make every supported task lifecycle deterministic;
- expand regression coverage around continuation and queue races;
- strengthen broker telemetry and longer-lived provider health history;
- strengthen runner capacity/reclamation behavior;
- graduate Docker runner-manager/runtime from CI-proven foundation to production where appropriate;
- improve workspace resume after deploy/restart;
- tighten Preview diagnostics across more frameworks;
- improve publication receipts and Git state verification;
- improve event/log retention policy;
- finish stale-document removal and architecture checks;
- broaden mobile browser/device verification;
- keep production metrics tied to exact deployed commits.

Success condition:

A user can repeatedly move from request → execution → evidence → review → publish without needing to understand or repair Orlynx infrastructure.

### Stage B — Multi-agent runtime choice

Status: **future**

Goals:

- add at least one additional real coding-agent adapter;
- expose capability-aware agent selection;
- preserve the same task/event/permission/memory contracts;
- allow fallback between compatible agents where policy allows;
- compare agent health without duplicating product state.

Success condition:

Switching agent changes execution behavior, not the Orlynx product architecture.

### Stage C — Stronger project intelligence

Status: **current + hardening**

Implemented foundations:

- typed verified memory;
- confidence and time-based decay;
- contradiction-driven confidence reduction and automatic lesson supersession;
- bounded verified repository/environment knowledge edges;
- test/deploy/recovery lesson types;
- verified conventions;
- durable Investigation lifecycle through hypothesis → testing → repairing → verifying → resolved → learned;
- separate read-only architect delegation for stuck/unknown investigations;
- separate read-only reviewer delegation before Build finalization.

Still to harden/extend:

- full automatically extracted architecture map;
- richer package/service/route/dependency relationships beyond verified lesson edges;
- additional memory provenance/query surfaces;
- production-outcome feedback after later health/regression observation.

Success condition:

Orlynx becomes faster and more accurate on a repository over time without accumulating uncontrolled prompt baggage.

### Stage D — CI/CD and production feedback loop

Status: **future**

Goals:

- consume CI results as verification evidence;
- understand deployment status;
- connect a code change to the deployed revision;
- inspect production health/logs through approved connectors;
- learn from regressions and successful recoveries;
- support rollback/redeploy workflows with clear approval boundaries.

Success condition:

“Done” can mean not only local tests pass, but the intended deployed outcome is healthy.

### Stage E — Durable team workspaces

Status: **future**

Goals:

- team-owned projects;
- shared verified knowledge;
- role-based authorization;
- project policy;
- shared activity/audit;
- assignment/delegation;
- handoff between humans and agents;
- private versus team memory separation.

Success condition:

A team can treat Orlynx as a shared engineering workspace rather than a personal AI chat.

### Stage F — Parallel specialized agents under one coordinator

Status: **foundation implemented; parallel specialist execution remains future**

Current foundation:

- canonical subagent lifecycle events;
- bounded separate-session read-only architect delegation;
- bounded separate-session read-only reviewer delegation;
- parent task retains final authority and verification state.

Remaining goals:

- coordinator-owned task decomposition;
- specialist agents for code, security, tests, docs, release or research;
- isolated subtask evidence;
- bounded parallelism;
- conflict detection;
- final synthesis owned by one parent task;
- no uncontrolled swarm behavior.

Success condition:

Parallelism improves throughput without destroying coherence or reviewability.

### Stage G — Policy-aware autonomous execution

Status: **future**

Goals:

- repository-defined policies;
- allowed command/tool profiles;
- protected file/branch rules;
- deployment approval rules;
- cost/resource limits;
- scheduled/triggered maintenance jobs;
- autonomous dependency/security maintenance within explicit policy.

Success condition:

Orlynx can safely execute larger classes of work with less supervision because boundaries are stronger, not because safeguards were removed.

### Stage H — Self-hosted and enterprise-grade execution choices

Status: **future**

Goals:

- additional runner backends;
- organization-owned compute;
- hardened isolation;
- network egress controls;
- image provenance/signing;
- secret brokers;
- private package/network integration;
- audit export;
- retention controls.

Success condition:

Organizations can adopt Orlynx without giving up infrastructure or compliance control.

## What should not become the product

Orlynx should resist several tempting directions.

### Not an infrastructure dashboard

Infrastructure state is important, but the user should not spend their time managing containers and ports.

### Not a model leaderboard

Model choice matters, but the product value is the reliable engineering loop around the model.

### Not an autonomous black box

If higher autonomy hides intent, evidence, branch destination or security boundaries, it is a regression.

### Not an endless event transcript

Raw observability belongs behind progressive disclosure.

### Not a memory dump

More remembered tokens are not equivalent to better project intelligence.

### Not tied to one vendor

Render, Codespaces, OpenCode and any model provider are implementation choices behind Orlynx-owned contracts.

## Product metrics that matter

Future product measurement should prefer engineering outcomes over vanity chat metrics.

Useful categories include:

- time from message to first useful evidence;
- warm versus cold workspace startup;
- percentage of runs completed without user infrastructure intervention;
- continuation success without duplicate runs;
- queue ordering correctness;
- verification pass rate;
- false-completion rate;
- Preview success rate;
- reconnect/replay recovery rate;
- publish failure rate;
- memory lesson reuse rate;
- stale-memory contradiction rate;
- agent/provider failure isolation;
- mobile task completion rate.

Raw message count is not a meaningful success metric by itself.

## Roadmap governance

A roadmap item should move into “current” only when:

1. implementation exists;
2. automated tests protect the core contract;
3. relevant security boundary is enforced server-side;
4. failure state is designed;
5. recovery behavior is defined;
6. documentation is updated;
7. production verification has been performed where the feature depends on live infrastructure.

This keeps Orlynx's documentation honest as the product grows.
