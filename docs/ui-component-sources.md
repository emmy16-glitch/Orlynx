# UI Component Sources

No external component files are vendored in V1. All components in `apps/web/src/ui/` are Orlynx-owned.

| Source | Used | How | License note |
|---|---|---|---|
| shadcn/ui + Radix patterns | Patterns only | Focus-visible rings, 44px targets, explicit-verb approval, Badge/Card/Input anatomy | No code copied; no obligation. If primitives are later copied, record MIT + file + modifications here. |
| Beautiful UI (agent patterns) | Interaction inspiration | Activity rows (✓/●/○), tool→receipt grouping, collapsed history | No code copied. |
| 21st.dev | Discovery stub only | `TwentyFirstProvider` in `registry.tsx` returns [] — wire CLI/MCP as dev tool only; candidates must pass quality gate + copy-and-own | Respect per-component licenses at copy time; record here before merging. |
| beUI | Interaction inspiration | Pill float, drawers, toast stacking behavior | No code copied. |
| Transitions.dev | Motion inspiration | spinner→check, collapsed→expanded, cloud step transitions; CSS-only, reduced-motion safe | No code copied. |

## Quality gate (before any future copy)
1. Improves the user task? 2. No existing Orlynx component? 3. Accessible? 4. Mobile-friendly? 5. Weight justified? 6. Convertible to tokens? 7. License acceptable + recorded? 8. Reduced-motion safe? 9. Themeable? 10. No visual inconsistency? 11. Performant? 12. Simpler than a primitive?
