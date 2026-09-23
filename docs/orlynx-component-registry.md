# Orlynx Component Registry

The machine-readable approved index is `apps/web/src/ui/registry-data.json`; the
typed query service is `apps/web/src/ui/registry.tsx`. Search and reuse an approved
entry before making another button/card/status/activity pattern. All product
components are Orlynx-owned; external sources are inspiration only (see
[`ui-component-sources.md`](ui-component-sources.md)).

## Foundation (`ui/primitives.tsx`)

| Component | Use |
| --- | --- |
| `Button` | Primary/ghost/danger action with 44px minimum target |
| `IconButton` | Icon-only action with accessible label |
| `Badge` | Quiet status and classification |
| `Card` | Distinct elevated content group, used sparingly |
| `Input` | Shared semantic input |
| `Icon` | One 24-unit outline set with Orlynx stroke/size |
| `EmptyState`, `ErrorState` | Clear no-content and recovery states |
| `Spinner`, `Skeleton` | Waiting/restore/loading feedback |

## Product/activity components

`apps/web/src/ui/product.tsx`: `AgentStatusPill`, `CloudStatus`,
`TaskActivityRow`, `AgentApprovalCard`, `AgentErrorCard`, `DiffSummary`,
`AttachmentChip`, `PreviewStatus`, `CloudWorkspaceButton`, and `SessionResumeCard`.

`apps/web/src/ui/workstream.tsx`: `AgentWorkStream`, `LiveActivityPill`, and
`CloudTransition`.

## Screen patterns

The current application uses reusable Orlynx tokens and shell patterns in
`apps/web/src/App.tsx`: `ProjectWorkspaceShell`, `GitHubRepositoryPicker`,
`ProjectCodeViewer`, `CloudWorkspacePanel`, and `SettingsGroups`. These are screen
compositions and should be extracted into `ui/` if another route begins to reuse
their interaction logic. Do not copy markup into a parallel workflow before
checking `REGISTRY`.

Registry categories cover forms, navigation, agent, activity, approval, repository,
cloud, errors, changes, preview, settings, and empty states. Entries record target
platforms, accessibility review, motion level, intended use/avoidance, source, and
license. A component can only be called verified when keyboard/touch and responsive
behavior have been reviewed; device-specific checks are called out in the
responsive document.

## Adding or adapting components

1. Search `searchUIComponents({ intent, category, platform, tags })`.
2. Prefer the current Orlynx component and extend it with tokens/variants.
3. If adapting a pattern from an external source, re-implement it in Orlynx
   typography, color, icon, spacing, motion, and accessibility conventions.
4. Record source/license only if source code is copied; inspiration alone is not
   vendored code.
5. Add a registry entry and test its path/unique ID in `ui-intelligence.test.js`.
6. Run web/API types, tests, production build, and verify 360px + wide desktop.
