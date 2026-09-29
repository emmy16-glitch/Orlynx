# End-to-end verification

This document defines the production verification contract.

Passing unit tests or seeing a local screenshot is not proof that the deployed product works.

## Automated CI

Every pull request and push to main should run the repository's actual verification commands:

~~~text
npm ci
npm run typecheck
npm test
npm run build
~~~

Do not invent a lint gate when the repository has no lint script.

## Exact-revision rule

Every production verification report should identify:

- repository commit SHA;
- CI result for that SHA;
- deployed Render revision;
- runner revision/image where relevant;
- live checks performed.

Do not merge CI and production evidence into one vague “green” status.

## Core production scenario

A healthy release should support the following path where credentials and provider availability permit:

1. open Orlynx;
2. connect GitHub through the real GitHub App;
3. choose an authorized repository;
4. restore/open the durable project session;
5. select the connected model, mode, access level and agent;
6. send an Ask/Plan question and see real streaming output;
7. send a natural follow-up during the response and confirm it remains in the same run;
8. send a Build request;
9. confirm Orlynx uses the warm runner when configured/healthy;
10. confirm Codespaces can act as fallback/recovery when policy permits;
11. confirm authenticated bridge readiness;
12. confirm OpenCode adapter readiness independently from workspace readiness;
13. receive normalized live activity;
14. send “also check X” during Build and confirm same-run continuation;
15. send “queue this / do this next” and confirm a separate visible queued task;
16. edit/cancel a queued task;
17. confirm queued work never runs beside active/waiting work;
18. verify missing acceptance evidence keeps the run working instead of reporting success;
19. force a diagnosable contradiction and confirm ordered Investigation blocks;
20. background/lock the phone and return;
21. replay missed events without duplicate work rows;
22. inspect files and changes;
23. verify Preview from a browser-resolvable provider URL;
24. approve/publish through the controlled GitHub path;
25. confirm the exact requested branch target is preserved;
26. reload or open another authenticated device and recover the durable project session.

## Current production components

The architecture contains real implementations for:

- GitHub App install/OAuth flow and authorized repository listing;
- short-lived installation tokens and signed webhooks;
- durable Postgres control-plane storage;
- encrypted stored provider credentials;
- direct model Ask/Plan streaming;
- durable message/task admission;
- same-run live continuation;
- explicit sequential queueing;
- warm-runner workspace provider;
- GitHub Codespaces fallback/recovery provider;
- authenticated workspace bridge;
- OpenCode Agent Adapter #1;
- PTY terminal;
- filesystem operations;
- Git operations;
- test/build execution;
- Preview-port/browser-surface discovery;
- canonical durable event replay;
- ordered Investigation presentation;
- harness verification;
- approval records and audit log;
- controlled GitHub publication;
- verified learned lessons.

There is intentionally no production demo/native agent fallback.

## Conversation tests

Verify:

- greetings/general conversation route through the selected model;
- Ask/Plan do not require workspace startup when execution is unnecessary;
- Build uses workspace execution;
- “also...” stays in the active run;
- “queue...” creates new durable work;
- a follow-up arriving during finalization is not lost;
- retry/resend preserves immutable history expectations;
- cancelling a run does not report completion.

## Queue tests

Verify:

- only one active/waiting task owns execution;
- queue position matches durable scheduler order;
- edits persist in chat/history;
- cancellation persists;
- cross-lane queued work remains sequential behind active work;
- an API restart does not erase queued tasks.

## Investigation and verification tests

Verify:

- task acceptance criteria are inferred from the request;
- changes/tests/build/Preview/publication evidence satisfy only the relevant criterion;
- contradictory evidence starts bounded reflection;
- Investigation numbering/order is stable;
- useful model hypothesis is shown without private chain-of-thought;
- verification runs again after corrective work;
- learned memory is stored only after reflection + verification pass.

## Memory tests

Verify:

- lessons are isolated by user;
- repository lessons do not contaminate unrelated projects without relevance;
- environment lessons still require query overlap;
- at most the bounded relevant set is injected;
- fresh evidence can contradict remembered lessons;
- secrets are cleaned before lesson persistence.

## Preview tests

Verify:

- API-only JSON roots are not presented as browser Preview;
- Codespaces forwarding is checked before repository configuration edits;
- supported Vite repositories receive Orlynx-managed host compatibility;
- loopback-only/internal agent ports are not exposed as user Preview;
- runner Preview uses the signed gateway path;
- dev-server process exit invalidates Preview readiness.

## Mobile/reconnect checks

Manual or browser-automation verification should cover at least:

- 360px;
- 390px;
- 412px;
- keyboard open/close;
- long streaming task while reading older chat;
- auto-follow stops when scrolled upward;
- New activity affordance;
- Wi-Fi → cellular transition;
- background/sleep during a running task;
- foreground reconnect and event replay;
- offline draft preservation;
- Android back navigation;
- model/mode/access/agent controls;
- queue tray and edit/cancel behavior;
- Investigation block scrolling.

## Security checks

Verify:

- repository APIs reject unauthorized access;
- read-only/approval policies are server-enforced;
- webhook signatures are verified;
- duplicate GitHub delivery IDs are rejected durably;
- GitHub/provider/bridge secrets never appear in browser payloads;
- secret-like event content is redacted before persistence;
- historical replay remains sanitized;
- agent shell lacks unrestricted GitHub credentials;
- explicit publication branch is not silently changed;
- consequential actions create audit evidence;
- user A cannot retrieve user B's learned lessons.

## Production-data checks

Hosted production must not depend on:

- browser localStorage for authoritative session state;
- process memory for task truth;
- local JSON for production durable state.

Postgres remains authoritative.

Operational retention should be documented and tested for webhook receipts, bridge commands, event payloads, conversation data, learned lessons and audit records as policies evolve.

## Current explicit boundaries

Do not claim a feature exists merely because the architecture can support it.

Examples of roadmap items that require their own implementation/verification before being called current:

- additional coding-agent adapters beyond OpenCode;
- team/shared memory;
- multi-agent parallel orchestration;
- production-outcome learning;
- autonomous scheduled maintenance;
- enterprise policy packs;
- extra runner backends.

See [product-vision-and-roadmap.md](product-vision-and-roadmap.md).
