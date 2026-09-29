# Orlynx screen inventory

This document describes the current product shell. Older prototype descriptions of a simulated native agent or fake cloud state are obsolete.

## Entry / GitHub

### Welcome

Purpose: explain the product and connect GitHub.

Current behavior:

- real GitHub App/OAuth flow;
- no PAT input;
- returns to Orlynx after authorization;
- fresh-device OAuth success immediately hydrates durable identity-owned conversations.

### Repository picker

Purpose: choose an authorized repository.

Current behavior:

- server-authorized GitHub repositories;
- repository search;
- branch selection/opening;
- opening an existing user + repository + branch resumes the durable conversation.

## Home / Projects

Recent projects are hydrated from the server-owned session list after authentication, not solely localStorage.

A project can be opened on a new device even when that browser has never seen the session before.

## Project workspace

Primary project navigation is:

~~~text
Chat · Files · Changes · More
~~~

Preview and Terminal are contextual surfaces under the project experience rather than permanent infrastructure-first top-level navigation.

### Chat

Current behavior includes:

- durable message history;
- direct Ask/Plan streaming;
- Build execution;
- same-run follow-up continuation;
- explicit durable queue;
- queue edit/cancel controls;
- typed tool/activity evidence;
- ordered Investigation blocks;
- Stop/Cancel behavior;
- mobile reconnect/replay;
- no forced autoscroll while reading old content.

### Files

Reads repository/workspace files through the appropriate current source.

The source may be GitHub when no mutable workspace is needed or the authenticated bridge when the workspace is ready.

### Changes

Shows durable/reviewable change state and publication actions.

Git publication is controlled by Orlynx rather than raw model credentials.

### More

Contextual surfaces include Preview, Terminal, workspace state and related project controls.

## AI controls

The composer exposes separate concepts for:

- Agent;
- Model;
- Mode;
- Access.

OpenCode is Agent Adapter #1.

The UI must not imply that an unavailable agent adapter means the entire workspace is unavailable.

## Workspace states

The UI can represent preparing, connecting, ready, reconnecting, failed/stopped and provider recovery.

Workspace readiness and agent-adapter readiness are separate.

Example:

~~~text
Workspace: ready
OpenCode adapter: unavailable (repairing)
~~~

is a valid state.

## Queue

Explicit next work has a compact queue surface with position, mode, edit and cancel controls.

Active work status is separate from queued work.

## Investigation

Reflection dialogue is grouped into ordered Investigation sections.

Each section can show the useful Orlynx observation and model hypothesis/next check, with actual tool evidence elsewhere in the same turn.

The product does not expose private hidden chain-of-thought.

## Cross-device behavior

Phone and laptop are clients of the same durable conversation.

Expected behavior after same-GitHub login:

- recent projects appear;
- latest durable session can restore automatically;
- opening the same repository/branch restores messages;
- queued/running task state is recovered;
- event replay catches up activity;
- local browser cache is not required for history.

## Responsive behavior

Core workflows must work at narrow phone widths and wide desktop widths.

Mobile remains a first-class control surface rather than a read-only companion.

See orlynx-responsive-behavior.md and orlynx-ui-architecture.md.
