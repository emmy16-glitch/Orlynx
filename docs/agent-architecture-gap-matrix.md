# Agent independence audit

Baseline: main `2b1751e` (PRs #126–133 and reliability audit #127/#130 reviewed).

This is the implementation/review matrix, not a claim of production readiness.

| Requirement | Existing implementation | Missing pieces / affected components | Validation |
| --- | --- | --- | --- |
| Durable Orlynx ownership | Postgres sessions/tasks/harness/Investigation/events/changes; scoped lessons | Preserve existing ledgers; adapter handoff in task harness, not new agent conversation | PostgreSQL reload and identity tests |
| Generic adapters | agent-runtime.ts and bridge registry; OpenCode only | Portable execution/capability/model/failure contract; workspace adapters must not inherit OpenCode direct methods | Contract + real runtime protocol tests |
| mini-SWE | None | Actual Python DefaultAgent with Orlynx command environment; optional LiteLLM/local model configuration; bridge execution | Actual upstream agent with deterministic test model, command/edit/cancel tests |
| Cline | Disabled placeholder | Actual headless SDK boundary; explicit limitations where server policy cannot be proven | SDK execution tests; unavailable until configured and validated |
| Manual same-task switch | Selector writes preferences for next turn | Fenced transition, acknowledged shutdown, durable checkpoint, existing task requeue; routes/UI | Late-result, active-write, cancellation and identity regressions |
| Automatic adapter failover | Compute Broker changes compute; safe same-model retries before effects | Capability/model compatible adapter routing, durable circuit state, bounded attempted routes; gateway/recovery | Exhaustion, health, configuration and unsafe-side-effect tests |
| Safe reconciliation | Bridge command journal, session queue claims, provider-job leases | Workspace execution fence/lease, prevent concurrent agent runs, unresolved command/process blocks | Concurrent claims, stale holder and crash tests |
| Restart/replay | Durable queue/preparation worker, events, partial text; direct recovery | Handoff recovery and stale execution fencing; uncertain side effects must block | Restart boundary tests through actual repositories |
| Roles | Isolated OpenCode architect/reviewer sessions | Portable roles/capability routing; reviewer remains evidence | Existing harness review tests + portable role contract |
| Knowledge provenance | Lesson triples, confidence/decay/contradictions | Repository/source-task/file provenance; stale invalidation on relevant changes | Deleted/moved file and unrelated-change tests |
| Verified learning/publication | Harness evidence, exact commit deployment, GitHub App publisher | Preserve gates; agents never receive publication tokens | Full existing memory/publisher/deployment regression suite |
| Production verification | Render main + four active runner services (original fifth suspended), public health | Exact release and runtime validation for new adapters (optional model configuration required) | CI, Render revision/logs, application health; document unavailable routes honestly |

Reviewed sources: root README; architecture-overview; production-architecture;
learning-and-memory; compute-broker; runner-runtime-and-docker; workspace-runtime;
session-lifecycle; canonical-agent-stream; streaming-and-reconnect; agent-engine;
direct-chat-architecture; github-app-integration; render-production;
reliability-audit-2026-09-30; agents.ts; agent-runtime.ts; bridge/index.ts;
bridge-gateway.ts; storage.ts; harness.ts; agent-memory.ts; publisher.ts; routes.ts;
existing API/bridge/PostgreSQL/harness/publication/recovery test suites.

Upstream integration evidence: SWE-agent/mini-swe-agent DefaultAgent, Environment,
LiteLLM models; cline/cline headless @cline/agents SDK and host-provided tools.
No private model reasoning belongs in checkpoints or event history.
