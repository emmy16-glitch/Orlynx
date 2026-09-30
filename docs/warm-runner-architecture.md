# Orlynx runner architecture

## Purpose

The Orlynx runner is one workspace-compute provider behind the Compute Broker.

Current production exposes five direct Render runner services as one logical pool. The broker selects this pool when its live score/capability is appropriate; it is not an unconditional hard-coded first choice.

## Current hosted pool

~~~text
Orlynx control plane
       |
       v
Runner pool
       |
       +-- runner 1 (capacity 1)
       +-- runner 2 (capacity 1)
       +-- runner 3 (capacity 1)
       +-- runner 4 (capacity 1)
       +-- runner 5 (capacity 1)
~~~

Each current direct runner uses `runner-direct/index.mjs`.

## Health and capacity

The pool tracks per-host:

- health
- capacity
- running/available slots
- draining state
- latency
- browser/E2E capability
- circuit state
- current workspace ownership

A hosting provider saying “live” is not enough. Orlynx uses application-level `/health` evidence.

## Host selection

The pool ranks healthy available hosts. The Compute Broker then evaluates the runner provider against E2B and Codespaces.

Tasks that require browser E2E strongly penalize runner capacity that cannot truthfully advertise browser capability.

## Direct runner lifecycle

A direct runner typically:

1. authenticates the control-plane request
2. validates identifiers/branch
3. resolves the authorized GitHub repository
4. clones the branch
5. receives Bridge/OpenCode configuration
6. starts the Bridge child process
7. reports health/capacity
8. proxies signed Preview traffic
9. reclaims idle/stopped workspaces according to policy

## Authentication

Runner management uses shared internal `ORLYNX_RUNNER_TOKEN` Bearer authentication with timing-safe comparison.

The token is infrastructure-only and must never reach the browser or repository code.

## Idle reclamation

Each direct Render runner has one active workspace slot.

Stopped workspaces can be reassigned immediately. Running workspaces become reclaimable only after configured idle thresholds.

## Preview

Signed Preview tokens bind workspace identity, port, and expiry. The runner verifies the signature before proxying traffic to the local development server.

## Browser capability

Direct runners probe their installed Linux browser dependencies.

Docker runner-runtime hosts advertise browser capability because Playwright/Chromium and required libraries are baked into the image.

## Docker runner-manager path

On a Docker-capable host, `runner-manager/index.mjs` can create multiple isolated `runner-runtime` containers:

~~~text
Runner manager
   +-- workspace container A
   +-- workspace container B
   +-- workspace container C
~~~

See [runner-runtime-and-docker.md](runner-runtime-and-docker.md).

## Relationship to the Compute Broker

The runner pool supplies evidence; the broker makes the product-level routing decision.

The broker considers runner availability/load/latency/capability together with E2B, Codespaces, failure history, quarantine, and workspace stickiness.

See [compute-broker.md](compute-broker.md).

## CI

Runner architecture has independent CI gates:

- runner-runtime Docker image build
- Chromium launch inside the image
- runner-manager image build

This prevents the container architecture from silently rotting while current hosted production uses direct Render runners.

## Invariants

1. application health beats host deployment labels
2. one runner failure must not lose the task
3. capacity is bounded
4. idle reclamation must not kill active work
5. Preview access is signed
6. runner credentials stay server-side
7. provider changes preserve task/session identity
8. browser capability is truthful
9. unhealthy/circuit-open hosts are avoided
10. direct and Docker-managed runners obey the same workspace contract
