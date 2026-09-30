# Compute Broker and execution routing

## Purpose

The Compute Broker is the Orlynx-owned routing layer that decides **where work should execute** without changing the user's project conversation, task identity, selected mode, permissions, or model.

Its job is to turn infrastructure failure into a routing decision instead of a conversation-ending error.

The broker currently reasons about four compute targets:

- the lightweight **direct OpenCode runtime** used by Ask/Plan-style conversational turns;
- **GitHub Codespaces**;
- **E2B** sandboxes;
- the **Orlynx runner pool**.

The direct runtime is a fast path. Workspace providers are the durable execution paths for real repository work.

## Mental model

~~~text
User message
    |
    v
Durable Orlynx task
    |
    v
Execution-plane decision
    |
    +-----------------------+
    |                       |
    v                       v
Direct lane             Workspace lane
    |                       |
    v                       v
Direct OpenCode         Compute Broker
runtime                 ranks providers
    |                       |
    | healthy               +-- Orlynx runner pool
    |                       +-- E2B
    |                       +-- GitHub Codespaces
    |
    | transient failure
    v
quarantine fast path
    |
    v
same durable task -> workspace lane
~~~

The important invariant is:

> Compute can change. The conversation and task must not.

## What the broker tracks

For each compute target Orlynx records in-process operational signals such as:

- successful uses;
- failures;
- consecutive failures;
- exponentially weighted moving-average latency;
- last success time;
- last failure time;
- short failure detail;
- quarantine expiry.

For the runner pool it also incorporates live cached capacity data:

- configured hosts;
- known hosts;
- healthy hosts;
- aggregate capacity;
- running workspaces;
- available capacity;
- best observed health-probe latency;
- browser/E2E capability.

The broker does not treat a Render deployment marked `live` as sufficient proof that a runner can execute work. Application-level health is the stronger signal.

## Baseline scoring

Current workspace-provider baselines are intentionally conservative:

~~~text
GitHub Codespaces  90
E2B                82
Orlynx runner      78
~~~

These are **starting weights**, not a fixed preference order.

Live health and history can change the effective score.

Examples:

- a healthy runner pool with available capacity receives a bonus;
- runner load lowers its score;
- higher measured latency lowers score;
- repeated failures lower score;
- quarantine applies a large penalty;
- a task that needs browser E2E strongly penalizes a runner pool with no browser-capable healthy host;
- an existing healthy workspace receives a stickiness bonus.

This allows a healthy, low-load runner to beat the Codespaces baseline without making the runner pool an unconditional dependency.

## Sticky healthy workspaces

Provider choice should not thrash between turns.

If a session already has a healthy workspace and its bridge/adapter state is usable, Orlynx preserves it when practical.

~~~text
Build turn 1 -> runner-2
Build turn 2 -> runner-2
Build turn 3 -> runner-2
~~~

rather than:

~~~text
turn 1 -> runner
turn 2 -> E2B
turn 3 -> Codespaces
~~~

The broker becomes relevant again when:

- no workspace exists;
- the existing workspace is degraded;
- the provider is quarantined;
- required capability is missing;
- preparation fails;
- the task needs a capability the current provider cannot supply.

## Quarantine and circuit breaking

Repeatedly retrying a known-bad provider makes the product look hung.

Orlynx therefore quarantines failing compute.

For workspace providers, the default threshold is multiple consecutive failures. The exact threshold and cooldown can be configured.

For the direct runtime, one confirmed transient infrastructure outage can quarantine the fast path immediately because a second long wake attempt is usually worse than moving the durable turn to healthy workspace compute.

The cooldown grows with repeated failure up to a bounded multiplier.

Quarantine is temporary. A later success clears it.

## Direct runtime failover

The direct OpenCode runtime exists so lightweight conversation does not need to wake a full development workspace.

When healthy:

~~~text
Ask/Plan -> direct runtime -> selected model -> streamed answer
~~~

When it returns a transient failure before producing useful output, such as HTTP 502/503/504 or a transport failure:

~~~text
same durable task
    |
    +-- direct runtime fails
    |
    +-- broker records/quarantines failure
    |
    +-- UI receives "Switching compute..."
    |
    +-- task plane becomes workspace
    |
    +-- broker selects healthy provider
    |
    +-- task continues without user resend
~~~

The run ID, message, selected model, mode, permission profile, and durable conversation remain the same.

## Workspace-provider failover

Workspace preparation is durable and retryable.

If the selected provider fails, the broker ranks the remaining configured providers while excluding providers already attempted in the same preparation cycle. This prevents loops such as:

~~~text
Codespaces -> E2B -> Codespaces -> E2B -> ...
~~~

A successful provider becomes the current workspace provider and subsequent healthy turns remain sticky there.

## Browser/E2E capability

Some tasks explicitly require browser automation or visual verification.

The runner pool reports whether healthy hosts have browser/E2E capability. Docker runner-runtime images are built with Playwright and Chromium. Native direct runners probe their installed runtime capability.

If the requested task requires browser E2E and the current runner capacity cannot provide it, the broker lowers that provider's score enough for another provider to win.

## Startup health

The production API feeds initial health signals into the broker for:

- GitHub/Codespaces;
- E2B;
- Orlynx runner pool;
- direct OpenCode runtime.

This does not permanently decide routing. It seeds the broker so the first real task starts from observed infrastructure state rather than a blind static preference.

## User-facing behavior

Infrastructure diagnostics should remain progressively disclosed.

The normal user-facing failover message is intentionally simple:

> Switching compute...

Raw provider details such as a transient 502, runner host ID, sandbox identifier, or bridge port belong in diagnostic evidence/logs, not as the primary product experience.

## Current production pool

The deployed Render control plane is configured with five direct Orlynx runner services. Each direct runner currently exposes one workspace slot. The broker sees them as a logical pool and chooses individual hosts using runner-pool health/capacity ranking.

The repository also contains a scalable Docker runner-manager/runtime architecture for hosts where Orlynx controls Docker directly. See [Runner runtime and Docker](runner-runtime-and-docker.md).

## Implementation map

| Concern | Code |
| --- | --- |
| Broker scoring/quarantine | `apps/api/src/compute-broker.ts` |
| Build admission | `apps/api/src/routes.ts` |
| Direct-to-workspace failover | `apps/api/src/agents.ts` |
| Workspace creation/recovery | `apps/api/src/workspaces.ts` |
| Durable preparation worker | `apps/api/src/workspace-jobs.ts` |
| Runner host selection/health | `apps/api/src/runner-pool.ts` |
| Provider abstraction | `apps/api/src/workspace-provider.ts`, `workspace-providers.ts` |
| Direct runtime health | `apps/api/src/opencode-local.ts` |

## Reliability rules

Future broker changes must preserve these invariants:

1. provider failure must not silently lose an admitted task;
2. failover must preserve session/task/run identity;
3. already-attempted providers must not create a routing loop;
4. healthy existing workspaces should remain sticky;
5. security/authorization failure must not be hidden as ordinary infrastructure fallback;
6. capability requirements must influence selection;
7. provider health must come from application-level evidence where possible;
8. the browser must not own provider truth;
9. raw provider errors should not become the normal user experience;
10. broker routing must remain covered by deterministic regression tests.

## Recovery hardening, 2026-09-30

Attempted providers and quarantined providers are hard exclusions, independent of score bonuses. When none is eligible, selection returns no provider. A cold/unready quarantined workspace is rerouted through the broker; an already-ready workspace stays sticky. Preparation records at most 36 provider attempts per durable job and has a bounded lease-attempt budget. No hard-coded warm-runner escape bypasses these constraints.
