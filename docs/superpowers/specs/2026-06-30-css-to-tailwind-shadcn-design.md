# Native CSS → Tailwind v4 + shadcn migration

**Date:** 2026-06-30
**Status:** Approved design
**Scope:** `apps/frontend` only

## Goal

Replace the hand-written CSS layer (`index.css`, 1451 lines / 449 custom class
selectors) with Tailwind v4 utility classes and brand-themed shadcn/ui
components. **The rendered UI must look pixel-identical** before and after — this
is a refactor of the styling layer, not a redesign.

## Locked decisions

1. **Visual goal — pixel-identical.** The "Hand-Lettered Shopfront" brand
   (oxblood/cream palette, soft radii) is preserved exactly. Tokens become the
   Tailwind theme; shadcn components are themed to render the brand.
2. **Sequencing — incremental, screen-by-screen.** The app stays shippable at
   every step. Each screen's now-dead CSS classes are deleted from `index.css`
   as that screen is completed.
3. **shadcn depth — broad adoption.** Hand-rolled buttons, inputs, cards,
   modals, tables, badges, tabs, etc. are rebuilt on brand-themed shadcn
   primitives for long-term consistency and accessibility.

## Current state (as found)

- Tailwind v4 (`@tailwindcss/vite`) and shadcn (`shadcn@4`, `components.json`,
  `style: base-nova`, `baseColor: neutral`, `src/lib/utils.ts`) are already
  installed and wired. Only one shadcn component exists so far:
  `src/components/ui/select.tsx`.
- `src/index.css` (1451 lines): imports + `@layer base` reset + keyframes +
  media queries + **449 custom class selectors** using `var(--color-*)`,
  `var(--radius-*)`, `var(--z-*)`.
- `src/tokens.css` (105 lines): all design tokens as raw CSS custom properties
  in `:root`. Canonical source is `DESIGN.md` (frontmatter) — `tokens.css`
  mirrors it. **No `@theme` block exists yet**, so Tailwind utilities are not
  brand-aware and shadcn semantic tokens (`--primary`, `--background`, …) are
  not mapped to the brand.
- `src/App.css` (1 line, dead).
- ~28 `.tsx` files; 21 use `className`; inline `style={` in 9 files
  (AppRouter, AdminMerchants, DashCharts, Loaders, ShopSettings, VouchersManager,
  PendingScreen, Storefront ×8, ProductsManager).
- Only `src/main.tsx` imports `./index.css`.

## Architecture

### Unit 1 — Theme foundation (one-time, done first)

Add a `@theme inline` block to `index.css` that **references the existing
`tokens.css` custom properties** — no raw value is duplicated. `tokens.css` +
`DESIGN.md` remain the single canonical source of literal values.

Three mappings:

- **Color namespace** — every `--color-*` token (full list below) exposed as a
  Tailwind color so `bg-cream`, `text-ink`, `text-oxblood`,
  `border-clay-border`, `bg-success-bg`, `text-warn-fg`, etc. all resolve.
- **shadcn semantic tokens** — mapped to brand so installed components render
  correctly with zero per-component overrides:

  | shadcn token | brand source |
  |---|---|
  | `--primary` / `--primary-foreground` | `--color-oxblood` / `--color-cream` |
  | `--background` / `--foreground` | `--color-cream` / `--color-ink` |
  | `--card` / `--card-foreground` | `--color-surface-raised` / `--color-ink` |
  | `--popover` / `--popover-foreground` | `--color-surface-high` / `--color-ink` |
  | `--muted` / `--muted-foreground` | `--color-surface-sunken` / `--color-rose-muted` |
  | `--accent` / `--accent-foreground` | `--color-surface-sunken` / `--color-ink` |
  | `--secondary` / `--secondary-foreground` | `--color-surface-raised` / `--color-rose-muted` |
  | `--border` / `--input` | `--color-clay-border` |
  | `--ring` | `--color-oxblood` |
  | `--destructive` / `--destructive-foreground` | `--color-danger` / `--color-cream` |
  | `--radius` | `10px` (= `--radius-md`) |

- **Radius + z-index** — `--radius-*` → Tailwind `--radius-*` theme keys (so
  `rounded-sm/md/lg/xl/2xl` map to the brand's 8/10/12/14/16px and a
  `rounded-pill` for 20px); `--z-*` → `z-*` theme keys.

Acceptance: app renders identically; `bg-cream text-ink` on an element equals
the prior `body` styling; a default shadcn `<Button>` renders oxblood.

Full color token list to expose (from `tokens.css`):
`clay-border, clay-faint, clay-muted, clay-pale, clay-rose, clay-warm, cream,
danger, danger-bg, danger-border, danger-fg, divider, gold-accent, gold-bg,
gold-border, gold-deep, gold-deeper, info-bg, info-blue-bg, info-blue-fg,
info-fg, ink, ink-faint, ink-soft, oxblood, oxblood-deep, oxblood-deeper,
oxblood-light, oxblood-tint, oxblood-tint-soft, prep-bg, prep-bg-alt, prep-fg,
prep-fg-alt, rose-border, rose-deep, rose-hover, rose-muted, rose-pale,
rose-tint, status-done-fg, success-bg, success-bg-alt, success-bg-soft,
success-border, success-deep, success-fg, success-strong, surface-cream-soft,
surface-high, surface-raised, surface-sunken, surface-sunken-hover,
surface-warm, surface-warm-alt, text-tertiary, warn-bg, warn-bg-alt, warn-fg,
warn-fg-alt, white`.

### Unit 2 — Brand-themed shadcn primitives

Install via shadcn CLI then theme each to match current pixel values:
`button, input, textarea, label, card, dialog, sheet, table, tabs, badge,
dropdown-menu, tooltip, checkbox, radio-group, popover, sonner`. (`select`
already exists.)

Each primitive is a self-contained unit: themed through the Unit 1 semantic
tokens plus cva variants that reproduce existing classes. Key example —
**Button** variants derived from current CSS:

| variant | replaces classes | look |
|---|---|---|
| `primary` (default) | `.submit-btn .save-btn .auth-btn .voucher-apply-btn .add-btn(filled)` | oxblood fill, cream text |
| `outline` | `.cust-account-btn .lang-btn` | clay border, rose-muted text |
| `dashed` | `.add-btn .admin-toggle button` | dashed clay border |
| `ghost` | text-only nav/actions | transparent, hover sunken |
| `destructive` | delete affordances | oxblood-tint / danger |
| `icon` | `.hamburger-btn .notif-bell .qty-btn .del-btn` | square/round icon button |

Sizes carry the existing padding/height literals. Other primitives
(Input/Textarea/Card/Tabs/Badge/Dialog→Sheet for the mobile drawer, etc.) are
themed to their current class equivalents the same way. Where a status color set
is needed (order-status badges), Badge gains `success/info/prep/warn/done/danger`
variants mapping to the `--color-*-{fg,bg}` pairs.

Acceptance: each primitive rendered in isolation matches a screenshot of the
class it replaces.

### Unit 3 — Incremental screen migration

Order (each fully migrated + verified before the next; dead CSS deleted as we go):

1. **Shared shell/nav** — `DashboardShell`, sidebar, topbar, `Loaders`,
   `Toaster`/`ToastContext`, `LanguageSelect`, `motion` wrappers.
2. **Marketing** — `marketing/Landing.tsx`.
3. **Storefront** — `store/Storefront.tsx` (largest; 8 inline styles, cart,
   drawer, voucher, summary, sticky bar).
4. **Merchant** — auth (`LoginScreen`, `SignupScreen`, `PendingScreen`),
   `Overview`, `Dashboard`, `OrdersView`, `ProductsManager`, `VouchersManager`,
   `CustomersView`, `ShopSettings`, `MerchantHome`.
5. **Admin** — `AdminHome`, `AdminMerchants`, `AdminOverview`.

Charts (`components/charts/DashCharts.tsx`, recharts) keep their inline styles
where recharts requires JS props; only container/wrapper styling is migrated.

### Per-screen procedure (the repeatable unit of work)

1. Replace each custom `className` with Tailwind utilities and/or a Unit 2
   shadcn component.
2. Remove inline `style={…}` in favor of utilities (except recharts JS props).
3. Run the app, screenshot the screen, compare against a baseline screenshot of
   the same screen taken before the change — must match.
4. Delete the now-unused class selectors from `index.css`.
5. `pnpm typecheck && pnpm lint && pnpm test` green.

### Unit 4 — Final cleanup

- `index.css` reduced to: `@import`s, `@theme`, `@layer base` reset,
  `@keyframes`, `prefers-reduced-motion` / global rules only — no component
  classes left.
- Delete `src/App.css` and any stray import.
- `tokens.css` unchanged (still canonical mirror of `DESIGN.md`).
- Grep proves zero remaining references to deleted class names.

## Testing & verification strategy

Per project convention (`CLAUDE.md`), **UI is verified by running the app
(run-and-verify), not component tests.** Therefore:

- **Per screen:** before/after screenshot comparison (the pixel-identical gate)
  + `pnpm typecheck`, `pnpm lint`, `pnpm test` (existing Vitest: pricing, slug,
  store logic — must stay green; these are non-visual and should be unaffected).
- **Theme foundation (Unit 1):** verified by spot-checking that representative
  elements (body bg, a primary button, a card, a bordered input) are unchanged
  and that a vanilla shadcn component renders brand colors.
- **No new unit tests** for visual components (matches existing convention).

## Risks & mitigations

- **Pixel drift.** → Screenshot-compare every screen before deleting its CSS;
  the delete is the last step, gated on the match.
- **CSS specificity during transition.** Custom selectors in `index.css` are
  unlayered and outrank Tailwind utilities (which live in layers). → Migrate a
  whole component at once so no single element is styled by both systems
  simultaneously; classes are deleted only once their component no longer uses
  them.
- **shadcn `base-nova` defaults leaking generic styling.** → Unit 1 semantic
  token mapping is completed and verified before any screen migration.
- **Token name collisions / Tailwind v4 `@theme` syntax.** → Reference existing
  `var(--color-*)` rather than redefining; verify with a build after Unit 1.

## Out of scope

- Any visual/brand redesign.
- Backend, routing, data layer, business logic.
- Changes to `tokens.css` values or `DESIGN.md`.
- New automated visual/component tests.
