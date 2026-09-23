# Orlynx UI Architecture

## Application shell

`apps/web/src/App.tsx` is the current route/state shell. The repository has no
router dependency; view transitions are modeled as typed `Page` and project `Tab`
state so navigation does not introduce an unrelated routing framework. The shell
has:

- a desktop project rail with Home, Projects, Agents, Cloud, Settings, and recents;
- a project header with repository, branch, global search, and Work on cloud;
- project tabs and a center work area;
- a contextual right column on wide screens;
- a compact bottom navigation on mobile.

Welcome hides the project rail until a user chooses to start or import a workspace.
Last-session and per-project session IDs live in localStorage; API session state
remains authoritative. Draft text, theme, recent project names, and SSE cursor are
device-local preferences.

## State and API boundaries

| UI flow | Existing/API integration | Product truth |
| --- | --- | --- |
| Restore/open project | `GET /v1/sessions/:id`, `POST /v1/sessions` | API session/run records |
| Chat + activity | session message routes, SSE event stream | API messages/runs + normalized `ActivityEvent` projection |
| Files/code viewer | session files/file routes | repository gateway data |
| Changes/commit | change sets, approve, commit routes | base-SHA guard and local Git commit |
| Remote push | `POST /v1/changes/:id/push` | server credential + imported remote + explicit client confirmation |
| GitHub picker/import | status, repository metadata, branch, import routes | server-configured GitHub credential; no credential entry in UI |
| Attachments | multipart session attachment route | API metadata/files |
| Cloud | existing workspace route | local simulation until Codespaces provisioning is connected |
| Preview | explicit user-provided URL | iframe/display only; no auto-detected preview provider |
| Terminal | existing exec route | command runs in the project root and is only exposed in Terminal |

No OAuth callback/App installation flow, provider credential management, or
Codespaces provisioning route exists. The UI says so and avoids implying a
successful connection. A GitHub token/app installation credential may be supplied
server-side; it is never requested from the user in a normal screen.

## Navigation and session behavior

The shell retains project Chat/Files/Changes/Preview/More view state. Terminal is
a dedicated in-project view reached through the desktop workspace tab or More on
mobile. Screens without an active project (Welcome, Home, Projects, GitHub picker,
Agents, Cloud, Settings, Search, Tasks) use the same warm-neutral shell. Project
recents reopen the stored per-project session instead of silently creating another.

## Progressive content

The chat centers on authored messages and the existing activity presentation. The
right panel shows only project context, optional cloud, recent changes, and preview
status. Long/raw command details remain in Terminal or the activity receipt's
explicit raw-output layer. File browsing is a simple list/code viewer, not an IDE.
Diff changes are expanded one file at a time and use separate prose for agent
context.

## Error and loading behavior

Each API action surfaces a readable inline alert; file and repository states have
explicit empty and loading copy. Offline preserves drafts and does not claim a
message was sent. A rejected push leaves the local commit available. Cloud failure
keeps the chat, files, and changes visible. Restore errors fall back to Welcome and
the user may continue with a local project.

## Accessibility and performance

Shared buttons and controls use 44px targets, visible focus, semantic tab/navigation
roles, textual state alongside color, and one polite activity milestone region.
The event client deduplicates stable IDs and batches updates to animation frames;
the activity mapper and output display are bounded. See
[`agent-activity-presentation.md`](agent-activity-presentation.md) and
[`orlynx-responsive-behavior.md`](orlynx-responsive-behavior.md).
