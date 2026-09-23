# Orlynx Screen Inventory

The inventory separates UI that is functional against this repository's current
API from workflows blocked by provider infrastructure. A polished screen does not
imply a production service behind it.

## Entry and navigation

| Screen | UI state | Behavior / limitation |
| --- | --- | --- |
| Welcome | first visit, no restorable session | Connect GitHub details; continue into explicit local demo |
| Home | recent projects and GitHub summary | Open recents, local project form, repository picker |
| Projects | recent list, local open/create, GitHub entry | Session resumes per project; local repositories are local API data |
| GitHub connection | unconfigured, connected, expired, unavailable | Read-only connection details; authorization must be configured server-side |
| Repository picker | search, all/personal/organization/recent filters, selection, branch selection | Metadata and branches from configured GitHub access; import clones a selected branch |
| Agents | native agent, provider availability | Native is a demo adapter; OpenCode/Cline are explicitly unavailable |
| Tasks | empty or latest current-session run | Task history is limited to the active project/session; no cross-account task service |
| Global search | project and open-project files | Search is local and limited to recents/current file list, not a remote index |

## Project workspace

| View | Implemented behavior | Limitation |
| --- | --- | --- |
| Chat | restored conversation, live assistant response, attachments, normalized agent stream, composer, stop, offline draft | Native agent is simulated; tool/action coverage is illustrative |
| Activity | stable status, grouped actions, test/file evidence, explicit raw logs | raw receipt retention is event-bounded, not byte/TTL-bounded |
| Files | folder navigation, name filter, text file viewer | read-only; no in-browser edit/rename |
| Changes | change-set list, expandable file detail, approval, local commit, confirmed GitHub push | no syntax-highlighted line diff, accept/reject implementation, or push to arbitrary remotes |
| Preview | explicit URL, embedded sandboxed frame, reload and external open | no automatic dev-server discovery or port forwarder |
| Terminal | separate command panel, output, keyboard hint row | no PTY; keyboard hints are visual only; server shell adapter is local |
| More | Terminal, Cloud, Tasks, Settings entry points | no advanced provider control plane |

## Context and global screens

- **Cloud:** status, provider identity, work/stop/refresh and return-to-chat. The
  current local implementation simulates readiness; Codespaces provisioning is not
  wired even if the GitHub repository connection exists.
- **Settings:** Account/local profile, GitHub, AI provider availability, Cloud,
  appearance (System/Light/Dark), agent defaults, notification/security summary,
  and runtime data detail.
- **Approvals:** inline file-change approval and an explicit separate push-review
  confirmation. There is no generic Yes/No destructive dialog.
- **Attachments:** device file picker, upload states, chat attachment chips. Link,
  direct repository-file attach, camera UI variants, and attachment delete are not
  implemented by the current API.

## Shared visual states

Empty project/recent/tasks/files/changes/preview states; GitHub disconnected,
expired, no-access, loading, and network failure; project restore; working agent;
offline/draft preservation; cloud preparing/ready/stopped/failed; pending/stale/
committed/pushed change sets; upload progress/failure; preview unavailable; and
terminal idle/output are represented. Provider-specific OAuth return, real account
profile, model settings, cloud billing/machine selection, notification delivery,
and remote reconnect remain out of scope until their services exist.

## Screen map

```text
Welcome → GitHub details → Repository picker → Branch select → Import → Project/Chat
  ├─ Home → Projects → open/resume project
  ├─ Agents → Task history → original project session
  ├─ Cloud → same project conversation
  └─ Settings → GitHub / Agents / Cloud / Appearance / Security detail

Project header → Chat | Files | Changes | Preview | Terminal | More
More → Terminal | Cloud | Tasks | Settings
Changes → Review file details → Approve → Local commit → Review push → Push
```
