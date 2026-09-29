# Orlynx system integration

Orlynx is a phone-first control plane over real GitHub repositories, durable project conversations, replaceable compute providers and real coding-agent runtimes.

Production never substitutes a fake agent or simulated workspace for an unavailable integration.

## Product flow

1. The user connects GitHub through the Orlynx GitHub App and OAuth identity flow.
2. Orlynx lists repositories authorized to the current installation.
3. Opening a repository creates or resumes the durable user + repository + branch conversation.
4. Ask and Plan can use the direct model lane when mutable execution is unnecessary.
5. Build work is admitted to the durable task ledger.
6. Orlynx prefers a prewarmed Orlynx runner when configured.
7. GitHub Codespaces remains a fallback/recovery provider.
8. The authenticated Orlynx bridge exposes repository-scoped execution primitives.
9. OpenCode runs as Agent Adapter #1; adapter health is independent from workspace health.
10. Runtime activity is normalized, redacted, persisted and streamed to the browser.
11. Orlynx verifies acceptance evidence before claiming completion.
12. Consequential GitHub publication goes through Orlynx-controlled authorization and audit.

## Control plane

The Render control plane owns:

- GitHub identity and repository authorization;
- durable sessions/messages/tasks/events;
- direct AI chat;
- same-run continuation and explicit queueing;
- harness verification/reflection;
- verified lesson memory;
- encrypted provider credentials;
- workspace orchestration;
- approvals and audit;
- controlled GitHub publication.

Postgres is production truth.

## Execution plane

Execution comes from WorkspaceProvider.

### Orlynx runner

Preferred when configured. It uses isolated, prebuilt workspaces and can prewarm before the user sends Build work.

### GitHub Codespaces

Supported fallback/recovery provider. Codespaces use the same bridge/task/event product contracts.

The product conversation does not change identity when the compute provider changes.

## Workspace bridge

Every execution provider runs the Orlynx bridge.

The bridge initiates an authenticated outbound connection to the control plane using a short-lived credential scoped to the user/session/workspace/connection.

The bridge exposes files, PTY/shell, Git, tests, builds, Preview discovery and registered agent adapters.

## Agent abstraction

OpenCode is the first production agent adapter.

Orlynx owns task identity, permissions, verification, event persistence, memory and presentation. Future adapters implement that contract rather than creating a second architecture.

## Conversation continuity

Durable conversations are owned by GitHub user identity, not one device.

After GitHub login on a new laptop or phone, the client retrieves server-owned sessions and restores the conversation even when localStorage is empty.

## Runtime self-healing

OpenCode binary availability is treated as a repairable adapter-runtime problem.

The bridge checks the configured path and known runner/workspace locations. If no usable binary exists, it can install the pinned CPU-compatible native OpenCode package into a private runtime repair directory and probe it again before declaring binary_unavailable.

The workspace itself remains independently usable when the agent adapter is unhealthy.

## Security

- no PAT-entry flow;
- installation/user tokens stay server-side;
- bridge credentials are scoped and short-lived;
- secret-like event payload data is redacted before durable storage/streaming;
- historical evidence is sanitized before reflection;
- lessons are user-isolated;
- repository execution is outside the Render control-plane process;
- consequential publication is explicit and audited.

See architecture-overview.md for the complete topology.
