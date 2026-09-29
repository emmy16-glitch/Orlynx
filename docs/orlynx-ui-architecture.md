# Orlynx UI architecture

## Product model

Orlynx is a conversation-first software-development workspace, not an infrastructure dashboard.

The primary journey is:

~~~text
Connect GitHub
→ restore/open repository conversation
→ ask Orlynx to work
→ watch useful verified activity
→ review files/changes/Preview
→ publish through controlled GitHub flow
~~~

## Cross-device first run

GitHub authentication establishes the user identity used to load durable server-owned sessions.

A fresh browser does not need an existing localStorage pointer. After OAuth, Orlynx hydrates recent conversations from the server and can open the latest durable project.

## Project shell

Mobile primary project navigation is:

- Chat
- Files
- Changes
- More

Preview and Terminal remain contextual project surfaces under More/contextual controls.

On desktop, Orlynx may expose more context simultaneously without turning the product into a provider dashboard.

## Conversation UI

Each logical user goal owns a stable turn/run.

Natural follow-ups attach to the active run while steerable.
Explicit next-task intent appears in the Queue.
Investigation blocks group safe diagnostic dialogue.
Typed tool parts expose evidence progressively.

The conversation does not render private chain-of-thought.

## State/API boundaries

| UI flow | Source of truth |
| --- | --- |
| User identity | GitHub OAuth/App connection |
| Project restore | durable sessions by GitHub user ID |
| Messages | Postgres durable messages |
| Tasks/queue | Postgres durable tasks/harness |
| Live activity | canonical durable events + SSE |
| Model/mode/access/agent | durable session prefs + admitted task snapshot |
| Files | GitHub or ready workspace bridge |
| Changes | durable change sets + workspace Git |
| Workspace | WorkspaceProvider + durable workspace row |
| Preview | verified provider/port forwarding state |
| Publication | controlled Orlynx GitHub path + receipt/audit |

## Infrastructure visibility

Normal product copy should say what capability is happening:

- Preparing workspace
- Reconnecting development environment
- AI runtime repairing
- Preview unavailable
- Waiting for approval

Provider internals are shown only when diagnostic detail helps.

## Error isolation

An adapter error must not be rendered as total workspace failure.

A workspace can remain available for files/Git/shell while OpenCode repairs or is unavailable.

## Accessibility / mobile

Core actions retain touch-sized controls, focus-visible states, textual status, bounded raw output and reduced-motion support.

Streaming must not steal scroll position when the user reads older history.
