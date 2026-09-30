# Orlynx system integration

Orlynx is a phone-first control plane over real GitHub repositories, durable project conversations, replaceable compute providers, and replaceable coding-agent runtimes.

Production never substitutes a fake agent or simulated workspace for an unavailable integration.

## End-to-end product flow

1. User connects GitHub through the Orlynx GitHub App and OAuth identity flow.
2. Orlynx lists repositories authorized to the installation.
3. Opening a repository creates or resumes the durable user + repository + branch conversation.
4. Ask/Plan may use the direct OpenCode lane when mutable execution is unnecessary.
5. Build work is admitted to the durable task ledger before execution.
6. The Compute Broker evaluates available compute.
7. New/recovering workspace work can route to Orlynx runners, E2B, or GitHub Codespaces.
8. Healthy existing workspaces remain sticky where practical.
9. The authenticated Orlynx Bridge exposes repository-scoped execution primitives.
10. OpenCode runs as Agent Adapter #1; adapter health remains independent from workspace health.
11. Runtime activity is normalized, redacted, persisted, and streamed to the browser.
12. The harness verifies acceptance evidence before Orlynx claims completion.
13. Consequential GitHub publication goes through Orlynx-controlled authorization, policy, and audit.

## Control plane

The Render control plane owns:

- GitHub identity and repository authorization;
- durable sessions/messages/tasks/events;
- direct AI chat;
- continuation and explicit queueing;
- Compute Broker;
- harness verification/reflection;
- verified lesson memory;
- encrypted provider credentials;
- workspace orchestration;
- approvals/change sets;
- controlled GitHub publication;
- audit.

Postgres is production truth.

## Direct conversational lane

The direct OpenCode runtime is optimized for lightweight Ask/Plan turns.

It is not the source of truth for the conversation and is not a hard dependency.

A transient 502/503/504 or transport failure before useful output can:

1. record a broker failure;
2. quarantine the direct runtime;
3. emit `Switching compute...`;
4. preserve the same task/run/model/mode;
5. promote the task to workspace execution;
6. continue without requiring the user to resend the message.

## Compute Broker

The broker ranks configured execution providers using:

- health and recent success/failure;
- consecutive failures;
- latency EMA;
- temporary quarantine;
- runner capacity and load;
- browser/E2E capability;
- healthy-workspace stickiness;
- providers already attempted during the current recovery.

Current workspace providers are:

- Orlynx runner pool;
- E2B;
- GitHub Codespaces.

See [compute-broker.md](compute-broker.md).

## Orlynx runner pool

Current hosted production uses five direct Render runner services.

Each direct runner owns one active workspace slot and runs:

- repository checkout;
- Orlynx Bridge;
- OpenCode runtime;
- health/capacity API;
- signed Preview forwarding.

The repository also includes the Docker runner-manager/runtime path for multi-container hosts.

## E2B

E2B supplies isolated programmable sandboxes and gives Orlynx an execution path independent of both the Render runner pool and Codespaces.

## GitHub Codespaces

Codespaces supplies GitHub-managed durable development compute.

Orlynx can create/reuse/repair/replace Codespaces and bootstrap the same Bridge/adapter contract used by other providers.

## Workspace bridge

Every execution provider ultimately exposes the Orlynx workspace contract through the Bridge.

The Bridge initiates an authenticated outbound connection to the control plane using a scoped credential tied to user/session/workspace/connection identity.

It exposes:

- filesystem;
- PTY/shell;
- Git;
- tests/builds;
- ports and Preview discovery;
- browser/verification artifacts;
- agent adapters.

Commands are durable before socket delivery and are deduplicated by command identity.

## Agent abstraction

OpenCode is the first production adapter.

Orlynx owns task identity, permissions, provider choice, verification, event persistence, memory, publication, and presentation.

Future adapters should implement the same contract rather than creating a second orchestration system.

## Conversation continuity

Durable conversation identity belongs to the authenticated user + repository + branch context, not one browser.

The same conversation can continue across:

- phone and desktop;
- browser refresh;
- Render restart;
- workspace restart;
- runner migration;
- E2B/Codespaces migration;
- OpenCode session recreation.

## Runtime self-healing

Adapter runtime failures are treated separately from workspace failures.

The Bridge can repair the pinned OpenCode native runtime into an Orlynx-private path and probe it again.

A healthy shell/files/Git environment should not be destroyed merely because the adapter is temporarily unhealthy.

## Security

- no PAT-entry workflow;
- GitHub installation/user credentials stay server-side;
- bridge credentials are scoped and short-lived;
- runner credentials remain infrastructure-only;
- secret-like event payloads are redacted before persistence/streaming;
- historical evidence is sanitized before reflection;
- lessons are user-isolated;
- repository execution stays outside the control-plane process;
- consequential publication is explicit and auditable.

See [architecture-overview.md](architecture-overview.md) for the full topology.
