# Orlynx glossary

This page defines the terms used across the Orlynx documentation.

## Control plane

The long-lived Orlynx application layer on Render. It owns identity, sessions, tasks, routing, orchestration, events, verification, memory, publication, and audit.

## Execution plane

The remote environment where repository code actually runs. Current providers are Orlynx runners, E2B, and GitHub Codespaces.

## Compute Broker

The routing layer that decides which compute path should execute work based on health, failures, latency, capacity, capability, quarantine, and workspace stickiness.

## Direct runtime

The lightweight OpenCode service used for conversational Ask/Plan work when a full workspace is unnecessary. It is an optimization, not durable conversation storage.

## Workspace

A mutable repository execution environment. A workspace can move between providers without changing the logical Orlynx task.

## Workspace provider

An implementation that can create/connect/stop/recover a workspace. Current provider IDs are `orlynx-runner`, `e2b`, and `github-codespaces`.

## Runner

Orlynx-owned execution compute. Current production uses five direct Render runner services. The repository also includes a Docker-managed runner architecture.

## Runner pool

The logical collection of runner hosts. Orlynx tracks host health, capacity, availability, latency, browser capability, and circuit state.

## Dockerfile

A text recipe that describes how to build a Docker image.

## Docker image

The packaged immutable runtime produced by a Dockerfile. The Orlynx runner-runtime image contains the bridge, OpenCode, Playwright/Chromium, Node, Git, and development dependencies.

## Container

A running instance of a Docker image.

## Runner manager

A service that controls a Docker daemon and creates/stops/destroys isolated runner-runtime containers.

## Bridge

The authenticated workspace-side process that connects back to the Orlynx control plane and exposes repository-scoped files, shell, Git, ports, Preview, verification, and agent-adapter capabilities.

## Agent adapter

A replaceable coding-agent integration beneath Orlynx. OpenCode is Adapter #1.

## OpenCode

The current coding-agent engine used by Orlynx. OpenCode is not the durable conversation store, compute broker, authorization system, or publication policy.

## Model

The selected LLM used through the agent/runtime layer. Model selection is separate from compute-provider selection.

## Harness

The Orlynx-owned task lifecycle and verification layer. It tracks phase, user steering, acceptance criteria, evidence, reflection, and finalization.

## Durable task

The server-owned record representing admitted work. It survives browser disconnects and infrastructure restarts.

## Run

An execution instance associated with a task.

## Steering

A natural follow-up attached to the same active run, such as “also check mobile” or “finish this too.”

## Queue

Explicit next work that should run after the active task. Queue state is durable and sequential.

## Lease

Temporary ownership of a durable workspace-preparation job by an orchestrator worker. If the worker dies, the lease expires so another recovery pass can continue.

## Canonical event

An Orlynx-owned normalized activity record with stable identity and sequence ordering. The browser renders these instead of depending directly on provider-specific event formats.

## SSE

Server-Sent Events, used for server-to-browser live activity. The browser reconnects using the durable sequence cursor.

## Preview

A browser-reachable development app surface verified through local listener, HTTP suitability, provider forwarding, and external reachability.

## Quarantine / circuit breaker

Temporary avoidance of a failing compute target. Quarantine prevents repeated user turns from waiting on a provider already known to be unhealthy.

## Sticky workspace

A healthy existing workspace that Orlynx intentionally keeps using instead of switching providers on every turn.

## Verified lesson

A small durable memory created from successful evidence-backed work. It is not model retraining.
