# Orlynx Design System

This system was extracted from the supplied Orlynx project-workspace reference
(desktop rail + warm work area, brown/tan primary accent, blue live work, and the
paired phone layout). It is the authority for every screen, not a styling preset
for only the chat view.

## Visual principles

- Warm, low-noise surfaces with restrained contrast and thin warm borders.
- Espresso/charcoal for primary actions and text; muted clay for selected
  navigation; blue only for active technical work; green/red/amber for meaningful
  success/failure/wait states.
- Whitespace and typography group information before cards do.
- Cards are reserved for distinct tasks/context. File rows, navigation, settings,
  and conversation messages primarily use alignment and dividers.
- Elevation is subtle. No gradients/glow as decoration. Motion communicates state.

## Color tokens

Defined in `apps/web/src/ui/tokens.css`:

| Token | Purpose | Light reference value |
| --- | --- | --- |
| `--background` | warm application canvas | `#f7f5f1` |
| `--surface` | primary raised surface | `#fffefd` |
| `--surface-muted` | sidebar/grouped background | `#f1efeb` |
| `--surface-elevated` / `--background-elevated` | inputs and nested regions | `#fbfaf8` |
| `--border`, `--border-strong` | hairline/divider hierarchy | warm neutral grays |
| `--foreground`, `--foreground-muted`, `--foreground-subtle` | text hierarchy | ink / gray |
| `--accent`, `--accent-soft` | Orlynx warm brand / selection | brown / pale sand |
| `--info`, `--success`, `--warning`, `--danger`, `--pending` | state colors | blue / green / amber / red / gray |

Use semantic variables, not literal colors, in components. A token-driven dark
variant is available under `[data-theme="dark"]`; light is the reference default.

## Typography

One UI stack: `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
sans-serif`. Inter is preferred when installed; the operating-system sans is the
offline fallback. A dedicated downloadable font is intentionally not a runtime
dependency. Monospace (`--font-mono`) is reserved for code, terminal content,
commands, hashes, and keyboard hints.

Tokens: `--text-display`, `--text-h1`, `--text-h2`, `--text-h3`, `--text-body`,
`--text-small`, `--text-meta`, and `--text-code`. Headings use tight tracking;
body copy uses a relaxed 1.5 line-height.

## Iconography

`Icon` in `apps/web/src/ui/primitives.tsx` is the single Orlynx-owned 24-unit outline
set, rendered at 14–19px with a consistent 1.7px stroke and round joins. No icon
package is needed in this offline-first build. GitHub's familiar Octocat mark is
the only provider/brand-specific silhouette; it uses the same size/alignment
wrapper. Do not add emoji icons or a second library to product UI.

## Spacing, radii, elevation, motion

- Four-pixel spacing base: `--sp-1` (4) through `--sp-12` (48).
- Radius: `--radius-sm` (8), `--radius-md` (11), `--radius-lg` (15),
  `--radius-xl` (20), `--radius-pill`.
- Shadows: `--shadow-1` separates rows/cards subtly; `--shadow-2` is reserved for
  floating confirmation/search surfaces.
- Motion: 120/190/280ms semantic durations. Activity pulse is small and limited to
  active state. Reduced-motion disables transitions, animation, and smooth scroll.
- Primary touch targets use `--touch-min` (44px). Compact metadata may be smaller,
  but actions remain full-size.

## Component rules

Use `Button`, `IconButton`, `Badge`, `Card`, `Input`, `EmptyState`, `ErrorState`,
`Spinner`, `Skeleton`, and `Icon` from `ui/primitives.tsx`. Product patterns live in
`ui/product.tsx`; activity and status patterns live in `ui/workstream.tsx`. Full
screens are listed in `ui/registry-data.json` and described in
[`orlynx-component-registry.md`](orlynx-component-registry.md).

Keep external interaction patterns only after translating them through these
tokens. Current UI components are Orlynx-owned; external code is not vendored.
