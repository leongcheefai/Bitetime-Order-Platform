# CSS → Tailwind + shadcn Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1451-line hand-written CSS layer in `apps/frontend` with Tailwind v4 utilities + brand-themed shadcn/ui components, with zero visual change.

**Architecture:** Map the existing `tokens.css` custom properties into the Tailwind v4 theme (`@theme inline`) and override shadcn's semantic tokens to the brand, so utilities and components render the "Hand-Lettered Shopfront" look out of the box. Build brand-themed shadcn primitives, then migrate screens one at a time, deleting each screen's now-dead CSS classes as it is verified pixel-identical.

**Tech Stack:** React 19, Vite 8, Tailwind CSS v4 (`@tailwindcss/vite`), shadcn@4 (style `base-nova`), Radix UI, cva, `clsx`+`tailwind-merge` (`cn`), lucide-react, Vitest.

## Global Constraints

- **Pixel-identical:** rendered UI must match before/after. No redesign. Verify each screen by before/after screenshot.
- **Scope:** `apps/frontend` only. Do not touch backend, routing, data layer, business logic.
- **Do not change** `apps/frontend/src/tokens.css` values or repo-root `DESIGN.md` — they stay the canonical source of literal values.
- **Reference, don't duplicate, token values.** `@theme` entries reference `var(--color-*)` etc.; never re-type hex literals.
- **Commands run from repo root:** `pnpm typecheck`, `pnpm lint`, `pnpm test` (turbo fans out). Single workspace: add `--filter @bitetime/frontend`.
- **shadcn conventions already in repo:** `cn()` from `@/lib/utils`, `@` → `src/`, components in `src/components/ui/`, `data-slot` attribute pattern (see `src/components/ui/select.tsx`).
- **Verification convention (`CLAUDE.md`):** UI is verified by running the app (run-and-verify), NOT component tests. Do not add component/visual unit tests. Existing Vitest (pricing/slug/store) must stay green.
- **Commit trailer:** end every commit message with `Claude-Session: https://claude.ai/code/session_01EeXkFWTgXxY7sr2ibcorEm`.
- **Branch:** work continues on `feat/lang-select-shadcn` (or a branch off it).

---

## Note on task shape

This is a styling refactor verified visually, so tasks do **not** follow red-green TDD. Each task's gate is: app builds, `typecheck`/`lint`/`test` green, and a before/after screenshot of the affected screen(s) matches. The "test" of a screen migration is the screenshot comparison plus the unchanged Vitest suite.

Baseline screenshots are captured once in Task 0 and reused as the comparison reference for every screen task.

---

### Task 0: Capture baseline screenshots + dev-server check

**Files:**
- Create: `apps/frontend/.migration-baselines/` (screenshots; gitignored)
- Modify: `apps/frontend/.gitignore` (add `.migration-baselines/`)

**Interfaces:**
- Produces: a baseline PNG per screen, used as the pixel-identical reference by all later screen tasks.

- [ ] **Step 1: Start the dev server**

Run: `pnpm --filter @bitetime/frontend dev`
Expected: Vite serves on `http://localhost:5173`.

- [ ] **Step 2: Capture baseline screenshots of every screen**

Use the browser automation tools (`mcp__claude-in-chrome__*`) — or manual screenshots — to capture each route at desktop (1280px) and mobile (390px) widths. Save into `apps/frontend/.migration-baselines/` with descriptive names:
- `landing` (`/`)
- `storefront-*` (`/s/<seeded-slug>` — menu, cart drawer, checkout, voucher, confirmation)
- `merchant-login` (`/merchant/login`), `merchant-signup` (`/merchant/signup`), `merchant-pending`
- `merchant-overview`, `merchant-dashboard`, `merchant-orders`, `merchant-products`, `merchant-vouchers`, `merchant-customers`, `merchant-settings`
- `admin-overview`, `admin-merchants`

If a route needs auth/data, sign in with a seeded merchant/superadmin (see `apps/backend/scripts`/seed) and note credentials used.

- [ ] **Step 3: Ignore the baselines directory**

Add to `apps/frontend/.gitignore`:

```
.migration-baselines/
```

- [ ] **Step 4: Commit the gitignore change**

```bash
git add apps/frontend/.gitignore
git commit -m "chore(frontend): ignore migration baseline screenshots

Claude-Session: https://claude.ai/code/session_01EeXkFWTgXxY7sr2ibcorEm"
```

---

### Task 1: Theme foundation — map tokens + shadcn semantics into Tailwind

**Files:**
- Modify: `apps/frontend/src/index.css` (top region: after imports, lines ~1–40)
- Read for values: `apps/frontend/src/tokens.css`
- Inspect: `node_modules/shadcn/tailwind.css` (resolve via the `@import "shadcn/tailwind.css"` already in `index.css`)

**Interfaces:**
- Produces: Tailwind color utilities for every brand token (`bg-cream`, `text-ink`, `text-oxblood`, `border-clay-border`, `bg-success-bg`, `text-warn-fg`, …); `rounded-pill` + brand-mapped `rounded-{sm,md,lg,xl,2xl}`; `z-{notif-panel,sticky,dropdown,overlay,drawer,modal,modal-popover,toast}`; and shadcn semantic tokens (`--primary`, `--background`, `--card`, `--popover`, `--muted`, `--accent`, `--secondary`, `--border`, `--input`, `--ring`, `--destructive`, `--radius`) pointing at brand values.

- [ ] **Step 1: Inspect shadcn's default semantic tokens**

Run: `cat node_modules/shadcn/tailwind.css | grep -nE -- '--(primary|background|foreground|card|popover|muted|accent|secondary|border|input|ring|destructive|radius)\b' | head -60`
Expected: see how `base-nova` defines the neutral `--primary`, `--background`, etc. in `:root` and how its `@theme` maps `--color-primary: var(--primary)` etc. Note whether the names are `--primary` or `--color-primary` so the override in Step 3 targets the right names.

- [ ] **Step 2: Add the brand `@theme inline` block to `index.css`**

Insert directly after the existing `@import './tokens.css';` / `@custom-variant dark` lines (before `@layer base`). This exposes brand tokens as Tailwind utilities by referencing the `var(--*)` already defined in `tokens.css` (no literal values duplicated):

```css
/* ── Brand tokens → Tailwind theme. Values live in tokens.css (canonical).
   `inline` means utilities emit var(--color-*) and resolve against :root. ── */
@theme inline {
  /* Surfaces / neutrals */
  --color-cream: var(--color-cream);
  --color-white: var(--color-white);
  --color-surface-raised: var(--color-surface-raised);
  --color-surface-high: var(--color-surface-high);
  --color-surface-sunken: var(--color-surface-sunken);
  --color-surface-sunken-hover: var(--color-surface-sunken-hover);
  --color-surface-warm: var(--color-surface-warm);
  --color-surface-warm-alt: var(--color-surface-warm-alt);
  --color-surface-cream-soft: var(--color-surface-cream-soft);
  --color-divider: var(--color-divider);

  /* Ink / text */
  --color-ink: var(--color-ink);
  --color-ink-soft: var(--color-ink-soft);
  --color-ink-faint: var(--color-ink-faint);
  --color-text-tertiary: var(--color-text-tertiary);

  /* Oxblood */
  --color-oxblood: var(--color-oxblood);
  --color-oxblood-deep: var(--color-oxblood-deep);
  --color-oxblood-deeper: var(--color-oxblood-deeper);
  --color-oxblood-light: var(--color-oxblood-light);
  --color-oxblood-tint: var(--color-oxblood-tint);
  --color-oxblood-tint-soft: var(--color-oxblood-tint-soft);

  /* Rose / clay */
  --color-rose-muted: var(--color-rose-muted);
  --color-rose-deep: var(--color-rose-deep);
  --color-rose-border: var(--color-rose-border);
  --color-rose-tint: var(--color-rose-tint);
  --color-rose-pale: var(--color-rose-pale);
  --color-rose-hover: var(--color-rose-hover);
  --color-clay-muted: var(--color-clay-muted);
  --color-clay-border: var(--color-clay-border);
  --color-clay-rose: var(--color-clay-rose);
  --color-clay-faint: var(--color-clay-faint);
  --color-clay-warm: var(--color-clay-warm);
  --color-clay-pale: var(--color-clay-pale);

  /* Gold (tracking/AWB) */
  --color-gold-accent: var(--color-gold-accent);
  --color-gold-deep: var(--color-gold-deep);
  --color-gold-deeper: var(--color-gold-deeper);
  --color-gold-border: var(--color-gold-border);
  --color-gold-bg: var(--color-gold-bg);

  /* Status: success / info / prep / warn / done / danger */
  --color-success-fg: var(--color-success-fg);
  --color-success-bg: var(--color-success-bg);
  --color-success-strong: var(--color-success-strong);
  --color-success-deep: var(--color-success-deep);
  --color-success-border: var(--color-success-border);
  --color-success-bg-soft: var(--color-success-bg-soft);
  --color-success-bg-alt: var(--color-success-bg-alt);
  --color-info-fg: var(--color-info-fg);
  --color-info-bg: var(--color-info-bg);
  --color-info-blue-fg: var(--color-info-blue-fg);
  --color-info-blue-bg: var(--color-info-blue-bg);
  --color-prep-fg: var(--color-prep-fg);
  --color-prep-bg: var(--color-prep-bg);
  --color-prep-fg-alt: var(--color-prep-fg-alt);
  --color-prep-bg-alt: var(--color-prep-bg-alt);
  --color-warn-fg: var(--color-warn-fg);
  --color-warn-bg: var(--color-warn-bg);
  --color-warn-fg-alt: var(--color-warn-fg-alt);
  --color-warn-bg-alt: var(--color-warn-bg-alt);
  --color-status-done-fg: var(--color-status-done-fg);
  --color-danger: var(--color-danger);
  --color-danger-fg: var(--color-danger-fg);
  --color-danger-bg: var(--color-danger-bg);
  --color-danger-border: var(--color-danger-border);

  /* Radii — brand scale (overrides Tailwind defaults) */
  --radius-xs: var(--radius-xs);
  --radius-sm: var(--radius-sm);
  --radius-md: var(--radius-md);
  --radius-lg: var(--radius-lg);
  --radius-xl: var(--radius-xl);
  --radius-2xl: var(--radius-2xl);
  --radius-pill: var(--radius-pill);
  --radius-round: var(--radius-round);

  /* Z-index scale → z-* utilities */
  --z-index-notif-panel: var(--z-notif-panel);
  --z-index-sticky: var(--z-sticky);
  --z-index-dropdown: var(--z-dropdown);
  --z-index-overlay: var(--z-overlay);
  --z-index-drawer: var(--z-drawer);
  --z-index-modal: var(--z-modal);
  --z-index-modal-popover: var(--z-modal-popover);
  --z-index-toast: var(--z-toast);
}
```

- [ ] **Step 3: Override shadcn semantic tokens to the brand**

Add a `:root` override block AFTER the `shadcn/tailwind.css` import resolves (place it right after `@import './tokens.css';`). Use the exact var names confirmed in Step 1 (shown here as the unprefixed shadcn names):

```css
/* shadcn semantic tokens → brand. Overrides base-nova neutral defaults. */
:root {
  --background: var(--color-cream);
  --foreground: var(--color-ink);
  --card: var(--color-surface-raised);
  --card-foreground: var(--color-ink);
  --popover: var(--color-surface-high);
  --popover-foreground: var(--color-ink);
  --primary: var(--color-oxblood);
  --primary-foreground: var(--color-cream);
  --secondary: var(--color-surface-raised);
  --secondary-foreground: var(--color-rose-muted);
  --muted: var(--color-surface-sunken);
  --muted-foreground: var(--color-rose-muted);
  --accent: var(--color-surface-sunken);
  --accent-foreground: var(--color-ink);
  --destructive: var(--color-danger);
  --destructive-foreground: var(--color-cream);
  --border: var(--color-clay-border);
  --input: var(--color-clay-border);
  --ring: var(--color-oxblood);
  --radius: 10px;
}
```

If Step 1 showed shadcn uses `--color-primary` (not `--primary`) as the source-of-truth name, target those names instead.

- [ ] **Step 4: Build to validate the theme compiles**

Run: `pnpm --filter @bitetime/frontend build`
Expected: build succeeds, no "unknown utility" / CSS parse errors.

- [ ] **Step 5: Visually confirm zero change + brand-aware utilities**

Start dev (`pnpm --filter @bitetime/frontend dev`). Confirm:
1. Existing screens look identical to Task 0 baselines (the old classes still drive everything).
2. In a scratch element, `class="bg-cream text-ink border border-clay-border rounded-md"` renders the brand cream/ink/clay (proves utilities resolve). Remove the scratch element after.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/index.css
git commit -m "feat(frontend): map brand tokens + shadcn semantics into Tailwind theme

Claude-Session: https://claude.ai/code/session_01EeXkFWTgXxY7sr2ibcorEm"
```

---

### Task 2: Install shadcn primitives

**Files:**
- Create: `apps/frontend/src/components/ui/{button,input,textarea,label,card,dialog,sheet,table,tabs,badge,dropdown-menu,tooltip,checkbox,radio-group,popover,sonner}.tsx`

**Interfaces:**
- Produces: unstyled-default shadcn primitive components (themed in Task 3). They consume the semantic tokens from Task 1, so they already render roughly brand-colored.

- [ ] **Step 1: Add the primitives via the shadcn CLI**

Run from `apps/frontend`:
```bash
cd apps/frontend && pnpm dlx shadcn@latest add button input textarea label card dialog sheet table tabs badge dropdown-menu tooltip checkbox radio-group popover sonner
```
Expected: files created under `src/components/ui/`. If the CLI prompts to overwrite `select.tsx`, decline.

- [ ] **Step 2: Verify they compile**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS (any new deps like `sonner` auto-installed by the CLI; if not, `pnpm --filter @bitetime/frontend add sonner`).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/components/ui apps/frontend/package.json pnpm-lock.yaml
git commit -m "feat(frontend): add shadcn ui primitives

Claude-Session: https://claude.ai/code/session_01EeXkFWTgXxY7sr2ibcorEm"
```

---

### Task 3: Brand-theme the Button primitive (exemplar)

**Files:**
- Modify: `apps/frontend/src/components/ui/button.tsx`
- Read for values: `apps/frontend/src/index.css` (`.submit-btn`, `.save-btn`, `.auth-btn`, `.voucher-apply-btn`, `.add-btn`, `.admin-toggle button`, `.cust-account-btn`, `.lang-btn`, `.hamburger-btn`, `.notif-bell`, `.qty-btn`, `.del-btn`, `.invoice-btn`)

**Interfaces:**
- Produces: `Button` + `buttonVariants` with variants `default`(=primary oxblood), `outline`, `dashed`, `ghost`, `destructive`, `icon`-friendly sizes — used by all screen tasks instead of the old `.*-btn` classes.

- [ ] **Step 1: Replace the cva variant config to match brand buttons**

Edit `button.tsx` so `buttonVariants` reproduces the existing button classes. Map exact padding/radius/weight from the CSS (read the listed selectors for literals). Use brand utilities from Task 1:

```tsx
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [font-family:'DM_Sans',sans-serif] [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // .submit-btn / .save-btn / .auth-btn / .voucher-apply-btn
        default: "bg-oxblood text-cream hover:bg-oxblood-deep",
        // .cust-account-btn / .lang-btn (outline pill)
        outline:
          "border-[1.5px] border-clay-border bg-transparent text-rose-muted hover:bg-surface-sunken hover:text-ink",
        // .add-btn / .admin-toggle button (dashed)
        dashed:
          "border border-dashed border-clay-border bg-transparent text-rose-muted hover:bg-surface-sunken hover:text-ink",
        ghost: "bg-transparent text-rose-muted hover:bg-surface-sunken hover:text-ink",
        // .del-btn / delete affordances
        destructive:
          "border border-rose-border bg-oxblood-tint text-oxblood hover:bg-rose-hover",
        // .invoice-btn (white w/ clay-rose text)
        invoice:
          "border border-rose-border bg-white text-clay-rose hover:bg-surface-sunken",
        link: "text-oxblood underline-offset-4 hover:underline",
      },
      size: {
        // .submit-btn (14px pad, radius-lg) — full-width primary
        default: "w-full px-4 py-3.5 text-[15px] rounded-lg",
        // .save-btn / .auth-btn
        md: "w-full px-3 py-2.5 text-sm rounded-md",
        // .voucher-apply-btn / .add-btn
        sm: "px-[18px] py-2.5 text-sm rounded-md",
        // .cust-account-btn / .lang-btn pill
        pill: "px-3.5 py-[5px] text-[13px] rounded-pill",
        // .hamburger-btn / .notif-bell (36px square)
        icon: "size-9 rounded-md border-[1.5px] border-clay-border text-rose-muted hover:bg-surface-sunken",
        // .qty-btn / .del-btn (round 26-30px)
        iconRound: "size-[26px] rounded-round",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)
```

Keep the file's existing `Button` function/`asChild`/`data-slot` wiring; only swap the variant config. Verify literal padding/sizes against the CSS selectors and adjust any that differ.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @bitetime/frontend typecheck`
Expected: PASS.

- [ ] **Step 3: Visually compare button variants**

Render each variant/size in a scratch route or reuse on the next screen; confirm each matches its old `.*-btn` baseline (color, padding, radius, hover). Remove scratch markup.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/components/ui/button.tsx
git commit -m "feat(frontend): brand-theme Button variants

Claude-Session: https://claude.ai/code/session_01EeXkFWTgXxY7sr2ibcorEm"
```

---

### Task 4: Brand-theme remaining primitives

**Files:**
- Modify: `apps/frontend/src/components/ui/{input,textarea,label,card,dialog,sheet,table,tabs,badge,dropdown-menu,tooltip,checkbox,radio-group,popover,sonner}.tsx`
- Read for values: `apps/frontend/src/index.css` (`.field input/select`, `.product-row input`, `.admin-field input/select`, `.voucher-text-input`; `.summary-card`, `.auth-card`, `.settings-section`, `.customer-list-panel`, `.admin-panel`, `.how-to`, `.cookie-card`, `.order-disclaimer`; `.cust-tab-nav`, `.cust-tab`; order-status badge colors; `.notif-panel`; `.radio-opt`; `.cookie-check-badge`)

**Interfaces:**
- Consumes: semantic tokens (Task 1).
- Produces: themed `Input, Textarea, Label, Card (+ Header/Content/Footer/Title), Dialog, Sheet, Table, Tabs, Badge, DropdownMenu, Tooltip, Checkbox, RadioGroup, Popover, Toaster(sonner)` matching existing styles. **Badge** gains brand variants: `success, info, infoBlue, prep, warn, done, danger` mapping to the `--color-*-{fg,bg}` pairs, plus default oxblood.

For each primitive, adjust the cva base/variants so it equals the corresponding CSS selector's literals (radius from `--radius-*`, borders `border-clay-border`/`border-[1.5px]`, fills `bg-cream`/`bg-surface-raised`, font `DM Sans`). Most need only border/radius/bg/text tweaks since semantic tokens already supply colors.

- [ ] **Step 1: Theme Input/Textarea/Label**

Match `.field input` (full-width, `px-[13px] py-2.5`, `rounded-md`, `bg-surface-raised`, `border-clay-border`, focus oxblood ring) and `.product-row input`/`.admin-field input` (compact `px-2.5 py-[7px] text-[13px] bg-cream`). Provide a `size`/className path for the compact form.

- [ ] **Step 2: Theme Card** to `.summary-card`/`.auth-card`/`.settings-section`/`.customer-list-panel`/`.admin-panel` family (bg `surface-raised`, border `clay-border` or `rose-border`, radius `2xl`/`pill`, padding `1.25rem`). Expose via className overrides rather than many variants.

- [ ] **Step 3: Theme Tabs** to `.cust-tab-nav`/`.cust-tab` (sunken pill track, active = white/raised pill, `text-rose-muted` inactive).

- [ ] **Step 4: Theme Badge** with the status variants:

```tsx
// add to badgeVariants.variants.variant
success: "bg-success-bg text-success-fg border-success-border",
info: "bg-info-bg text-info-fg border-transparent",
infoBlue: "bg-info-blue-bg text-info-blue-fg border-transparent",
prep: "bg-prep-bg text-prep-fg border-transparent",
warn: "bg-warn-bg text-warn-fg border-transparent",
done: "bg-surface-warm text-status-done-fg border-transparent",
danger: "bg-danger-bg text-danger-fg border-danger-border",
```

- [ ] **Step 5: Theme Dialog/Sheet/Popover/DropdownMenu/Tooltip** — surfaces `bg-surface-high`, border `clay-border`, radius `lg`, shadow matching `.notif-panel` (`shadow-[0_8px_24px_rgba(43,10,16,0.16)]`); set overlay/content `z-*` to the brand scale (`z-overlay`, `z-modal`, etc.). Sheet is the mobile drawer replacement (`z-drawer`).

- [ ] **Step 6: Theme Checkbox/RadioGroup** to `.cookie-check-badge` / `.radio-opt` looks where used.

- [ ] **Step 7: Theme Toaster (sonner)** to brand surface/border, `z-toast`.

- [ ] **Step 8: Typecheck + build**

Run: `pnpm --filter @bitetime/frontend typecheck && pnpm --filter @bitetime/frontend build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/src/components/ui
git commit -m "feat(frontend): brand-theme remaining shadcn primitives

Claude-Session: https://claude.ai/code/session_01EeXkFWTgXxY7sr2ibcorEm"
```

---

## Screen migration tasks (Tasks 5–16)

**Repeatable per-screen procedure — apply to every screen task below:**

1. Open the screen's `.tsx`. For each element using a custom class from `index.css`, read that selector's declarations and replace the `className` with equivalent Tailwind utilities (brand tokens from Task 1) and/or a themed shadcn component from Tasks 3–4.
2. Replace inline `style={…}` with utilities (exception: recharts JS props in `DashCharts.tsx`).
3. Run the app; screenshot the screen at desktop + mobile; compare to the Task 0 baseline — must match (layout, color, spacing, radius, hover/focus).
4. Grep that the classes you replaced are unused elsewhere, then delete those selectors from `index.css`:
   `grep -rn "class-name" apps/frontend/src` → only the just-migrated file (now gone) should have referenced them.
5. `pnpm typecheck && pnpm lint && pnpm test` green.
6. Commit (message: `refactor(frontend): migrate <screen> to Tailwind+shadcn`).

Each task below lists its files + the main class groups to migrate. The literals come from `index.css`; do not invent values.

---

### Task 5: Shared shell, nav & feedback components

**Files:**
- Modify: `apps/frontend/src/components/DashboardShell.tsx`, `src/components/Loaders.tsx`, `src/components/Toaster.tsx`, `src/ToastContext.tsx`, `src/components/LanguageSelect.tsx`, `src/motion.tsx`, `src/AppRouter.tsx` (inline styles)
- Modify (delete classes): `apps/frontend/src/index.css`

**Interfaces:**
- Produces: shared chrome (sidebar/topbar/loaders/toaster) on Tailwind+shadcn, reused by all later screens.

- [ ] **Step 1:** Migrate sidebar/shell classes (`.user-sidebar`, `.sidebar-*`, `.cust-topbar`, `.hamburger-btn`→Button `icon`, `.notif*`→Popover+Badge, `.preview-back-pill`) per the repeatable procedure.
- [ ] **Step 2:** Migrate `Loaders.tsx` (`shimmer` keyframe stays in `index.css`; skeleton classes → utilities) and `Toaster`/`ToastContext` → themed sonner from Task 4.
- [ ] **Step 3:** Replace inline styles in `AppRouter.tsx`.
- [ ] **Step 4:** Screenshot-compare; delete migrated classes from `index.css`.
- [ ] **Step 5:** `pnpm typecheck && pnpm lint && pnpm test` → green.
- [ ] **Step 6:** Commit.

---

### Task 6: Marketing landing

**Files:** Modify `apps/frontend/src/marketing/Landing.tsx`; delete its classes from `index.css`.

- [ ] **Step 1:** Migrate landing classes (hero, pricing cards, nav, `#pricing` anchor section) per the repeatable procedure; keep `scroll-behavior` rule in `index.css`.
- [ ] **Step 2:** Screenshot-compare (desktop + mobile).
- [ ] **Step 3:** Delete migrated classes; `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] **Step 4:** Commit.

---

### Task 7: Storefront

**Files:** Modify `apps/frontend/src/store/Storefront.tsx` (8 inline styles); delete its classes from `index.css`.

**Interfaces:** Consumes Button, Card, Input, Sheet (cart drawer), Badge, RadioGroup, Dialog, themed in Tasks 3–4.

- [ ] **Step 1:** Migrate menu/`.cookie-card`/`.qty-btn`/`.radio-opt`/`.field`/`.summary-*`/`.submit-btn`/`.voucher-*`/`.how-to`/`.order-disclaimer`/sticky checkout bar (`z-sticky`) and the cart drawer → Sheet (`z-drawer`).
- [ ] **Step 2:** Replace all 8 inline `style={}`.
- [ ] **Step 3:** Screenshot-compare every storefront state (menu, item qty, drawer open, voucher applied/error, checkout, confirmation) at desktop + mobile.
- [ ] **Step 4:** Delete migrated classes; `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] **Step 5:** Commit.

---

### Task 8: Merchant auth (Login / Signup / Pending)

**Files:** Modify `apps/frontend/src/merchant/LoginScreen.tsx`, `SignupScreen.tsx`, `PendingScreen.tsx`; delete their classes from `index.css`.

- [ ] **Step 1:** Migrate `.auth-card`/`.auth-btn`/`.auth-error`/`.field` and the pending-screen inline style → Card, Input, Button, alert utilities.
- [ ] **Step 2:** Screenshot-compare all three (incl. error states).
- [ ] **Step 3:** Delete classes; `pnpm typecheck && pnpm lint && pnpm test` green.
- [ ] **Step 4:** Commit.

---

### Task 9: Merchant Overview

**Files:** Modify `apps/frontend/src/merchant/Overview.tsx` (+ `MerchantHome.tsx` if it carries layout classes); delete classes from `index.css`.

- [ ] **Step 1:** Migrate stat cards / panels → Card; status pills → Badge variants.
- [ ] **Step 2:** Screenshot-compare; delete classes; checks green.
- [ ] **Step 3:** Commit.

---

### Task 10: Merchant Dashboard + charts

**Files:** Modify `apps/frontend/src/merchant/Dashboard.tsx`, `src/components/charts/DashCharts.tsx`; delete classes from `index.css`.

- [ ] **Step 1:** Migrate dashboard layout/cards. In `DashCharts.tsx` migrate only wrapper/container styling — **keep recharts JS-prop inline styles** (margins, colors passed as props).
- [ ] **Step 2:** Screenshot-compare charts render identically; delete classes; checks green.
- [ ] **Step 3:** Commit.

---

### Task 11: Merchant Orders

**Files:** Modify `apps/frontend/src/merchant/OrdersView.tsx`; delete classes from `index.css`.

- [ ] **Step 1:** Migrate `.order-accordion`/order rows/status badges → Card/accordion + Badge status variants; `.invoice-btn` → Button `invoice`.
- [ ] **Step 2:** Screenshot-compare (collapsed/expanded, each status color); delete classes; checks green.
- [ ] **Step 3:** Commit.

---

### Task 12: Merchant Products

**Files:** Modify `apps/frontend/src/merchant/ProductsManager.tsx` (1 inline style); delete classes from `index.css`.

- [ ] **Step 1:** Migrate `.product-row`/`.del-btn`/`.add-btn` → Input(compact)/Button `destructive`+`dashed`; replace inline style.
- [ ] **Step 2:** Screenshot-compare; delete classes; checks green.
- [ ] **Step 3:** Commit.

---

### Task 13: Merchant Vouchers

**Files:** Modify `apps/frontend/src/merchant/VouchersManager.tsx` (1 inline style); delete classes from `index.css`.

- [ ] **Step 1:** Migrate voucher list/form/badges; replace inline style.
- [ ] **Step 2:** Screenshot-compare; delete classes; checks green.
- [ ] **Step 3:** Commit.

---

### Task 14: Merchant Customers

**Files:** Modify `apps/frontend/src/merchant/CustomersView.tsx`; delete classes from `index.css`.

- [ ] **Step 1:** Migrate `.customer-list-panel`/`.cust-tab-nav`/`.cust-tab` → Card + themed Tabs.
- [ ] **Step 2:** Screenshot-compare; delete classes; checks green.
- [ ] **Step 3:** Commit.

---

### Task 15: Merchant Shop Settings

**Files:** Modify `apps/frontend/src/merchant/ShopSettings.tsx` (1 inline style); delete classes from `index.css`.

- [ ] **Step 1:** Migrate `.settings-section`/`.field`/`.save-btn`/gold AWB field classes → Card/Input/Button; replace inline style.
- [ ] **Step 2:** Screenshot-compare; delete classes; checks green.
- [ ] **Step 3:** Commit.

---

### Task 16: Admin screens

**Files:** Modify `apps/frontend/src/admin/AdminHome.tsx`, `AdminMerchants.tsx` (3 inline styles), `AdminOverview.tsx`; delete classes from `index.css`.

- [ ] **Step 1:** Migrate `.admin-panel`/`.admin-field`/`.admin-toggle`/merchant table/status → Card/Table/Badge/Button `dashed`; replace inline styles.
- [ ] **Step 2:** Screenshot-compare; delete classes; checks green.
- [ ] **Step 3:** Commit.

---

### Task 17: Final cleanup & verification

**Files:**
- Modify: `apps/frontend/src/index.css`
- Delete: `apps/frontend/src/App.css`
- Modify: any file importing `App.css` (expected: none)

**Interfaces:**
- Produces: an `index.css` containing only imports, `@theme`, semantic `:root` override, `@layer base` reset, `@keyframes`, and global/media rules — no component selectors.

- [ ] **Step 1: Confirm no component classes remain**

Run: `grep -oE '^\.[a-zA-Z][a-zA-Z0-9_-]*' apps/frontend/src/index.css | sort -u`
Expected: empty or only intentional globals. For any remaining selector, grep usage across `src`; if unused, delete it.

- [ ] **Step 2: Delete dead `App.css`**

Run: `grep -rn "App.css" apps/frontend/src` → expect no matches, then `git rm apps/frontend/src/App.css`.

- [ ] **Step 3: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all PASS.

- [ ] **Step 4: Final full-app screenshot sweep**

Re-screenshot every route from Task 0 and confirm pixel-identical to baselines.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(frontend): drop dead CSS; complete Tailwind+shadcn migration

Claude-Session: https://claude.ai/code/session_01EeXkFWTgXxY7sr2ibcorEm"
```

---

## Self-review notes

- **Spec coverage:** Unit 1 → Task 1; Unit 2 → Tasks 2–4; Unit 3 (screens, in spec order) → Tasks 5–16; Unit 4 cleanup → Task 17; baselines/verification convention → Task 0 + per-task screenshot gate. Status-badge color sets → Task 4 Step 4. Charts inline-style exception → Task 10. All covered.
- **Placeholders:** none — token list, semantic mapping, Button/Badge code, and per-screen class inventories are concrete; literal values are sourced from `tokens.css`/`index.css` by reference (intentional, to satisfy the "do not duplicate token values" constraint).
- **Type/name consistency:** Button variants (`default/outline/dashed/ghost/destructive/invoice/link`) and sizes (`default/md/sm/pill/icon/iconRound`) defined in Task 3 are the names referenced by screen tasks; Badge variants (`success/info/infoBlue/prep/warn/done/danger`) defined in Task 4 Step 4 are referenced by Tasks 9/11/16.
