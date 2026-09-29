# Orlynx screen inventory

This inventory describes the current product model, not the early prototype.

## Entry and repository selection

| Screen / surface | Current role |
| --- | --- |
| Welcome / connect | Connect GitHub and restore existing authenticated project state |
| Repository picker | Choose among GitHub repositories authorized to the Orlynx App installation |
| Branch selection | Select the working branch before opening/importing the project |
| Recent projects | Resume durable project sessions rather than opening disposable chat tabs |

## Project workspace

The primary workspace is conversation-first.

### Chat

Chat is the main orchestration surface.

It contains:

- durable user/assistant turns;
- selected model;
- selected mode: Ask / Plan / Build;
- selected access profile;
- selected coding-agent adapter;
- streamed model output;
- normalized execution evidence;
- ordered Investigation blocks;
- same-run follow-up messages;
- explicit queue tray;
- Stop/cancel controls;
- attachment entry points.

Natural follow-ups continue active work where possible.

Explicit next-task intent creates visible queued work.

### Files

Files exposes repository/workspace file context without turning the product into a full IDE clone.

The exact source may depend on workspace readiness and repository state.

### Changes

Changes is the review surface for modifications and publication preparation.

It should make it possible to understand:

- what files changed;
- the relevant diff/evidence;
- whether review/approval is required;
- whether commit/publication succeeded;
- the resulting receipt/branch target.

### Preview

Preview opens only a browser-usable forwarded surface.

API-only ports are not treated as Preview.

Codespaces and runner Preview use provider-specific forwarding under one Orlynx product contract.

### Terminal

Terminal is a real workspace PTY capability and is not the main chat transcript.

Raw terminal output stays separate from user-facing work summaries.

### More / contextual surfaces

Depending on viewport and current implementation, More/contextual surfaces expose secondary project functions such as:

- terminal;
- workspace/provider state;
- task/queue information;
- settings;
- integration details.

Infrastructure should remain secondary to the project conversation.

## Queue UI

The queue tray represents explicit future work only.

For each queued task the UI can surface:

- position;
- mode;
- prompt summary;
- Edit;
- Cancel.

Active work status is not duplicated inside the queued list.

Queued tasks are sequential.

## Investigation UI

Reflection/diagnostic dialogue is grouped into ordered:

- Investigation 1;
- Investigation 2;
- etc.

Each Investigation can show:

- Orlynx observation;
- model hypothesis/next check;
- evidence underneath.

Long Investigation content is scroll-bounded.

The UI does not expose private hidden chain-of-thought.

## Streaming behavior

The latest streamed output follows automatically while the user is reading at the bottom.

If the user scrolls upward, follow mode stops.

The user can return to current activity without losing their reading position.

## Mobile

Mobile remains a first-class control surface.

The project navigation is intentionally compact, with the primary set centered on:

~~~text
Chat · Files · Changes · More
~~~

Secondary tooling does not compete with the core project flow.

Queue, Investigation, composer and current-work status must remain usable on narrow screens.

## Desktop

Desktop can expose more repository/project context at once, but it should preserve the same mental model:

- conversation is primary;
- files/changes are supporting surfaces;
- infrastructure is contextual;
- current work and queued work remain distinct.

## GitHub publication

Publication controls must communicate the actual branch target.

If the user explicitly names a branch, the UI/backend must not silently substitute another target.

Publication is performed through controlled Orlynx/GitHub integration rather than exposing raw credentials to the agent shell.

## Current integrations represented in the UI

The deployed product architecture supports real state for:

- GitHub App connection;
- authorized repositories;
- connected model/provider state;
- Orlynx warm runner when configured;
- GitHub Codespaces fallback/recovery;
- authenticated bridge;
- OpenCode adapter;
- real workspace files/shell/Git;
- real Preview forwarding;
- durable queue state;
- approvals/change sets;
- controlled publication.

## Explicitly future surfaces

The following should not be presented as current unless implementation and production verification are added:

- additional real coding-agent adapters beyond OpenCode;
- team/shared project memory;
- multi-agent parallel orchestration;
- autonomous scheduled maintenance;
- production observability feedback loops;
- enterprise organization policy administration.

## Historical note

Older versions of this document described simulated native agents, local-only cloud state and unimplemented Codespaces behavior.

Those statements were prototype-era truth and are no longer current architecture.

For current behavior, use:

- [orlynx-overview.md](orlynx-overview.md)
- [architecture-overview.md](architecture-overview.md)
- [end-to-end-verification.md](end-to-end-verification.md)
