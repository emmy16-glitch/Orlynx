# Reliability audit — 2026-09-30

Baseline: main `41aea85`. This audit distinguishes reproduced code failures from live production evidence. It does not claim every external provider or authenticated production scenario is verified.

## Reproduced failures and fixes

| Failure | Evidence | Correction |
| --- | --- | --- |
| Direct task switched to workspace but remained queued forever | Actual PostgreSQL `putTask` upsert retained `direct:s` after receiving `ws-recovered`; recovery could not find the old workspace | Persist workspace_id on update; reconcile legacy bindings with complete ownership/repository/branch checks |
| Database claims bypassed human waits and another execution lane | PostgreSQL tests promoted Build past waiting_approval/waiting_input and running direct work | Session row lock and a fresh READ COMMITTED claim; consistent running/wait guards |
| Attempted provider could win again | Success/stickiness bonuses lifted a provider above the score cutoff despite the attempt penalty | Attempted and quarantined providers are hard exclusions |
| All-quarantined routing retried unhealthy targets | Broker explicitly selected a degraded quarantined target | Return no eligible provider; cold workspace preparation honors quarantine |
| Hard-coded runner recovery bypassed the broker | Separate Codespace-to-runner branch ignored scoring and attempt eligibility | Use the broker for fallback and provisioning alternatives |
| Stale worker could complete/retry/fail a newer lease | Terminal SQL originally filtered only by job ID | Fence writes and renewal by worker, attempt generation and unexpired lease |
| Later batch jobs lost their leases before processing began | Batch was claimed, then processed sequentially; only current job renewed | Start all claimed jobs with independent renewal immediately |
| Codespace provisioning and terminal job reset could retry forever | Provisioning bypassed maxAttempts; queued-task repair could create another job after exhaustion | Apply the attempt cap to provisioning; persist a recoverable task failure after terminal preparation failure |
| Cross-process event cursor could skip an earlier event | Sequence and event were written in separate committed statements | Atomic sequence allocation and event insert |
| Queued HTTP snapshot rewound newer SSE state | Lifecycle snapshot reducer unconditionally overwrote run state | Timestamp lifecycle versions, ordered lifecycle replay, terminal activity reconciliation |
| Workspace model stalled while heartbeat made it look alive | Bridge agent loop allowed 30 minutes and repeated provider retry events | Staged first-progress/silence limits; bounded provider retry count; active tools retain the execution budget |
| Missing OpenCode session immediately failed work | Workspace adapter reused persisted session without 404 recreation | Create a replacement engine session and publish its checkpoint |
| Stream abort raised unhandled promise rejection | New HTTP/SSE integration test reproduced AbortError from pending iterator.next | Observe pending rejection before abort/cleanup |
| A transient/public model route failure immediately ended the task | Gateway terminalized failure; adapter offered no bounded safe retry | One same-model retry only before output/tools, after acknowledged abort; no paid-model switch |
| Provider fallback destroyed the old checkout | Generic failure path called provider.destroy | Preserve resource and durable recovery metadata; stale connection frames are rejected |

## Actual server-dashboard reproduction

The authorized public repository was cloned at main and started locally without changing its source. Vite ran with `--host 0.0.0.0` on 5173; backend ran on 3001.

| Probe | Result |
| --- | --- |
| 127.0.0.1:5173 / | HTTP 200, HTML |
| localhost:5173 / | HTTP 200, HTML |
| [::1]:5173 / | Connection failure |
| 127.0.0.1:3001 /api/health | HTTP 200, JSON |
| localhost:3001 /api/health | HTTP 200, JSON |
| [::1]:3001 /api/health | HTTP 200, JSON |

This confirms the IPv4/IPv6 difference; it does not reproduce a live Codespace forwarding URL or the original authenticated Orlynx transcript. Harness tests demonstrate that verified Preview evidence remains satisfied despite an IPv6 probe failure and that unavailable forwarding exhausts the existing reflection cap. Instructions prohibit repeating equivalent localhost probes.

## Regression coverage

New executable tests: `postgres-recovery.test.js`, `bridge-runtime-recovery.test.js`, broker eligibility tests, lifecycle replay/refresh tests, and IPv4/reflection tests. PostgreSQL tests run repository SQL using PGlite; HTTP/SSE tests run the actual Bridge adapter against a controlled OpenCode server.

The requested scenarios map to:

| Scenario | Coverage |
| --- | --- |
| Direct 502/failover and quarantine | Existing direct-chat-smoothness/execution-plane tests plus new PostgreSQL workspace rebinding test |
| Provider attempt loops, sticky workspaces and next provider | compute-broker tests; durable lease-generation provider history |
| Ready workspace/adapter, completed preparation wake | Actual durable recovery-sweep test with no browser |
| Lease expiry | PostgreSQL reclamation and stale-worker fencing test |
| Bridge duplicate commands | Actual in-flight/completed command replay test |
| OpenCode restart isolation | Adapter repair changes only private server; retained resource metadata test; existing adapter/Bridge health contract tests |
| Free-route failure | Exact model preservation and one bounded route retry in HTTP/SSE test; existing free-account classification tests |
| IPv4 Preview and bounded Investigation | Executable harness verification/reflection tests |
| SSE replay and browser refresh | New lifecycle reducer tests and atomic PostgreSQL event insertion test |
| Repository freshness | New wake-up test asserts git.sync precedes agent.run; existing real Git/lockfile freshness tests |
| Late finalization follow-up | Existing steering-revision completion guard tests |
| Waiting task safety | PostgreSQL waiting_input/waiting_approval and concurrent claim tests |

Some pre-existing coverage asserts source contracts rather than running a full external integration. Passing these tests does not establish real runner/E2B/Codespaces readiness.

## Production evidence and remaining work

Public `https://orlynx.onrender.com/health` returned HTTP 200, ready=true, durableStorage=true, runtimeBootstrapConfigured=true and bridgeConfigured=true during this audit. The anonymous integrations response reports no connected user, which does not establish the owner's GitHub/model authentication state.

Render service discovery returned “no workspace selected” and explicitly required user confirmation. The connector lists `My Workspace` (`tea-d8knvde47okc73a3m210`); confirmation was requested. Until that is supplied, deployed revision, private startup/runtime logs, all five runner application health/capacity responses, E2B authorization, direct-runtime health and the original durable production task rows are unverified.

Important remaining architectural limits:

- Broker history/quarantine is process-local; durable provider history belongs to jobs. Cross-process/shared quarantine is not yet implemented.
- Job terminal writes are fenced; an already-dispatched provider bootstrap is not a distributed transaction and cannot be undone by fencing its job result.
- Retained provider resources preserve recovery options, but automatic transfer of uncommitted edits across compute providers is not implemented. Retained resources may continue to incur provider usage and require deliberate cleanup after work is recovered.
- Current Preview metadata proves local health/forwarding inventory; a real authenticated browser probe is still needed to establish private Codespace Preview reachability.
- A genuinely unavailable exact selected model fails specifically after the bounded retry. Alternative model selection requires an explicit authorized policy; no paid or different model is silently substituted.

Production verification must close these evidence gaps before describing the entire architecture as proven reliable.
