# UI Architecture — Atomic Design

The React client (`src/client/src/`) follows the atomic design pattern (sibling-project convention).

## Tiers

| Tier | Path | What lives here | Examples |
|---|---|---|---|
| **Atoms** | `src/client/src/ui/atoms/` | Visual primitives — the single source for every shared visual. Includes the in-house surface over AntD (`primitives.ts`) plus display-only pieces. | `IconButton`, `CatBadge`, `StatusBadge`, `DayChip`, `DiffLine`, `Highlight`, `Stepper`, `Kbd` |
| **Molecules** | `src/client/src/ui/molecules/` | Configured / composed pieces built from atoms; reusable but not feature-specific. | `Carousel`, `Collapsible`, `MapCanvas` |
| **Organisms** | `src/client/src/ui/organisms/` | Feature blocks with business logic, built from atoms + molecules. | `ChatPanel`, `Sidebar`, `MarkdownView`, `TopBar`, `TOC`, `CommandPalette`, `TripMap`, `CityMap`, `TripDayNav`, `TripAssets`, `PlanActionsMenu`, `ChatReview`, `ChatRating` |
| **Screens** | `src/client/src/screens/` | Routed top-level surfaces composed of organisms. | `Home`, `Manage` (`/manage` console: 概览 health · 对话评估 eval · 校准 cortex-tuning) |

## The one-atom rule

**A shared visual lives in exactly ONE atom — never restyle the same element in two places.**
If two organisms need the same badge/chip/button treatment, that treatment is (or becomes) an atom, and both import it. Duplicated styling of the same element in two components is a bug.

Corollary: components never import `antd` directly — they import the re-exported primitives from `@/ui/atoms` (see `ui/atoms/primitives.ts`), so the underlying UI kit stays swappable and centralized.

## Design tokens

- **CSS variables** in `src/client/src/styles.css` — colors, spacing, theme (dark/light via `data-theme`).
- **AntD v6** token overrides in `src/client/src/lib/theme.ts` (`antdThemeConfig`), kept in sync with the CSS variables.

New colors/spacing go into the CSS vars + AntD token config — not hard-coded in components.

## Import convention

```ts
import { Button, CatBadge } from '@/ui/atoms';
import { Carousel } from '@/ui/molecules';
import { Sidebar, ChatPanel } from '@/ui/organisms';
import { Home } from '@/screens';
```

- Always import via the tier barrel (`index.ts`), not deep file paths — one exception: a screen importing a single organism may deep-import (e.g. `@/ui/organisms/PlanActionsMenu`) to avoid a barrel cycle.
- `@` aliases `src/client/src` (see `vite.config.ts` + `tsconfig.json`).
- Lower tiers never import from higher tiers (atoms ↛ molecules ↛ organisms ↛ screens). `ui/organisms/index.ts` re-exports `Home` from `@/screens` purely for legacy barrel-import compatibility.
