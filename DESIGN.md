# Orlynx Design System

## Product model

Orlynx is a mobile-first GitHub-native AI coding workspace. The primary user loop is:

Connect GitHub → choose repository → chat with Orlynx → observe useful work → review files/changes → approve and publish → continue.

The public interface is organized around the user's job, not infrastructure. GitHub App internals, OpenCode runtime details, workspace bridges, provider adapters and deployment configuration stay out of the normal product UI unless the user needs them to recover or diagnose something.

## Current visual direction

The current visual direction is the editorial restraint of curated.design translated into a real developer workspace.

This is a reference, not a clone. Orlynx should borrow the qualities that make Curated easy to scan:
- strong type hierarchy
- generous whitespace
- restrained chrome
- thin borders instead of card-heavy grouping
- consistent list/grid geometry
- compact search and filtering controls
- a single visual language across pages
- quiet light/dark modes
- content first, controls second

Orlynx must still behave like a coding workspace. Chat, files, diffs, execution evidence, repository state and approvals remain product-specific.

## Workspace composition

The workspace is not a dashboard.

The default project screen is:
1. compact project header
2. quiet tab navigation
3. one primary working canvas
4. sticky composer
5. contextual execution/status UI only when needed

The old permanent right context rail is not part of the default workspace. Repository, AI, terminal, preview and settings information belongs in More, contextual controls, or lightweight inline state.

## Visual character

Editorial, calm, premium, developer-focused, trustworthy.

Avoid:
- purple AI SaaS styling
- neon/cyberpunk visuals
- heavy glassmorphism
- dashboard grids for primary workflows
- permanent status cards
- random colored surfaces
- oversized rounded containers
- infrastructure terminology in normal product copy
- decorative monospace typography

## Core light palette

- Canvas: #F7F7F3
- Elevated canvas: #FBFBF8
- Surface: #FFFFFF
- Muted surface: #F0F0EB
- Primary ink: #151515
- Muted ink: #6F716C
- Subtle ink: #969992
- Border: #D9D9D2
- Strong border: #C6C7BF
- Focus accent: #B7FF5A
- Focus accent surface: #EEFFD8
- Success: #3E8A63
- Warning: #B5802E
- Danger: #C95454
- Working/info: #4C72A8

## Core dark palette

- Canvas: #111310
- Elevated canvas: #151713
- Surface: #1E1F1C
- Muted surface: #181A17
- Elevated surface: #242622
- Primary ink: #F4F5EF
- Muted ink: #A9ADA3
- Subtle ink: #7C8177
- Border: #33362F
- Strong border: #464A41
- Focus accent: #B7FF5A
- Focus accent surface: #263218
- Success: #72BD91
- Warning: #D5A958
- Danger: #DF7676
- Working/info: #7C9AC8

Runtime tokens live in `apps/web/src/ui/tokens.css`. Durable palette changes must update this file and the runtime tokens together. Product surfaces use semantic tokens instead of hard-coded light-only colors.

## Typography

Heading/brand: Geist 500–700.
Primary UI, chat and long-form text: Inter 400–700.
Code, commands, branches, paths and technical metadata: IBM Plex Mono 400–600.

Rules:
- large headings use strong negative tracking
- body text stays neutral and highly readable
- monospace only indicates actual technical information
- labels and metadata stay small rather than shouting
- type hierarchy does more grouping work than boxes

## Geometry

- Small controls: 6–8px radius
- Standard controls: 8–10px radius
- Major floating surfaces: 10–14px radius
- Pills: only for true badges/status
- Shadows: sparse; borders and spacing come first

Do not use a rounded card when a divider or whitespace communicates the grouping better.

## Navigation

Before a repository is open:
- compact brand/header
- repository discovery
- settings when needed

Inside a project:
- Chat
- Files
- Changes
- More

Desktop navigation is visually equivalent to editorial categories: quiet text, restrained icons, and a thin active indicator.

Mobile remains first-class and keeps a bottom project navigation.

Repository switching belongs in the project header. Terminal, Preview, cloud/workspace controls and advanced project controls belong under More.

## Chat

Chat is the primary canvas.

Messages should read as an editorial thread, not a stack of chat bubbles:
- quiet avatars/icons
- author/time metadata
- readable full-width text
- thin separators
- code surfaces only where needed
- no colored assistant bubbles

The composer is sticky, compact and central. It exposes:
- attachment control
- current agent/model
- mode
- temporary access only when relevant
- send/cancel

Controls should remain subordinate to the writing area.

## AI controls

The agent/model selector is anchored to the composer control. It is a short dropdown, not a centered modal.

The selector:
- shows the current agent
- exposes truthful readiness
- supports model search
- shows only a few visible models at once
- scrolls for the rest
- closes on selection, Escape or outside click

Mode is separate because it controls behavior:
- Build
- Plan
- Ask

Access is shown only when Build can mutate the project.

Provider/account configuration belongs in Settings or the same compact selector when action is required.

## Repository discovery

Repository browsing uses scan-friendly rows and compact cards:
- search first
- thin separators
- small repository identity icon
- name and secondary metadata
- explicit Open action
- no large decorative dashboard cards

## Files

Files use a table/list mental model:
- breadcrumb path
- folder filter
- thin row separators
- restrained modified state
- code viewer with a compact title bar
- monospace only inside code/path contexts

## Changes

Changes are a review document, not another dashboard:
- change groups separated by rules
- file summaries first
- exact diffs behind disclosure
- approval, commit and publish as explicit stages
- success state remains calm and useful

## More and Settings

More is a clean list/grid of secondary project tools, not persistent chrome.

Settings is composed from quiet rows grouped by section dividers. Theme selection uses authored System / Light / Dark controls.

## Activity

Main conversation shows observable work, not private reasoning. Build mode is transparent: users can follow commands, files, patches, tests and results without opening a separate IDE.

Activity has two presentation modes:
- **Summary** — concise human progress with details on demand
- **Code** — automatically reveals observable command/file/code evidence while work runs

Evidence hierarchy:
1. concise human progress and one clearly emphasized current step
2. structured execution evidence — command, path, changed files, bounded code/diff snippets, exit/test results
3. raw stdout/stderr behind progressive disclosure

Completed history is visually quieter than the current step.

## Interaction states

Always design explicit:
- disconnected
- connecting
- loading
- ready
- working
- waiting for input
- waiting for approval
- reconnecting
- failed
- completed
- offline/recovery

Normal recovery states should be inline and calm. Large recovery cards are reserved for situations that genuinely require user action.

## Light and dark mode

Light and dark mode are the same system, not separate themes.

Every surface must map to semantic tokens. Never leave a light navigation/composer/dialog surface inside dark mode or vice versa.

Theme is resolved before React paints to avoid a flash of the wrong mode.

## Mobile behavior

Mobile is first-class:
- safe areas respected
- sticky composer stays above keyboard/navigation
- stable streaming scroll
- model/mode selectors remain compact
- minimum touch targets preserved
- no horizontal overflow
- no desktop context rail squeezed into mobile
- project navigation stays available at the bottom

## Implementation sources

- `apps/web/src/ui/tokens.css` — design tokens
- `apps/web/src/ui/components.css` — primitives
- `apps/web/src/styles.css` — legacy/functional styles
- `apps/web/src/curated.css` — current editorial visual layer
- `apps/web/src/ProductionApp.tsx` — product composition

## Source hierarchy

When design sources disagree:
1. current explicit product requirement
2. current Orlynx product behavior and accessibility needs
3. this DESIGN.md
4. shared Orlynx primitives/tokens
5. curated.design as the approved external visual reference
6. other external component inspiration

External references may improve craft and restraint but must never make Orlynx less usable as a real GitHub-native coding workspace.
