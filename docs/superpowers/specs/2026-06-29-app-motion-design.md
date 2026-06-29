# App-wide motion layer — design

**Date:** 2026-06-29
**Status:** Approved (brainstorm) — pending spec review
**Scope:** `@bitetime/frontend` only

## Goal

Make the app feel smoother with intentional, subtle motion across the live
router tree (`AppRouter` → storefront, merchant, admin surfaces). Polish, not
flash: short fades and small slides that read as premium and calm, consistent
with the existing warm editorial design. No behavior changes.

## Decisions (locked in brainstorm)

- **Scope:** app-wide / shared building blocks (not one surface).
- **Motion types:** route transitions, overlays (drawer / modal / notification
  dropdown), loading states, plus a minimal toast system.
- **Library:** `motion` (current name for framer-motion), imported from
  `motion/react`. React 19 compatible, WAAPI-accelerated.
- **Intensity:** subtle — 150–250ms, 8px slides, ease `cubic-bezier(0.4,0,0.2,1)`.
  No spring/scale-pop.
- **Accessibility:** honor `prefers-reduced-motion` globally.

## Non-goals (YAGNI)

- List enter/exit animations (orders/products/cart). Primitive ships for later
  reuse but is not adopted anywhere in this work.
- Touching the legacy `src/App.tsx` (not mounted) or its legacy
  `components/*` children that still use `alert()`. They are out of the live tree.
- Reworking visual design, colors, or layout. Motion only.

## Architecture

### 1. Dependency

Add `motion` to `apps/frontend/package.json`. Single import surface:
`import { motion, AnimatePresence, useReducedMotion } from 'motion/react'`.

### 2. Shared motion primitives — `src/motion.tsx`

One module that owns all motion constants so timing/easing stays consistent
instead of being re-invented per component. Exports:

- **Tokens:** `DUR` (`{ fast: 0.15, base: 0.22, slow: 0.28 }`), `EASE`
  (`[0.4, 0, 0.2, 1]`).
- **Variants:** `fadeSlide` (pages: opacity + 8px y), `overlayFade` (backdrops:
  opacity only), `panelSlide` (drawer: x translate; modal: opacity + small y),
  `listItem` (opacity + y, for future reuse).
- **`<PageTransition>`** — wraps a route's element: `motion.div` with
  `fadeSlide`, `initial`/`animate`/`exit`.
- **`useMotionSafe()`** — thin wrapper over `useReducedMotion()` returning either
  the real variant or a no-op (opacity-only, zero distance) variant. Every
  primitive routes through this so reduced-motion is handled in one place.

### 3. Route transitions — `src/AppRouter.tsx`

- Add `useLocation`; pass `location` and a `key={location.pathname}` to
  `<Routes>`.
- Wrap `<Routes>` in `<AnimatePresence mode="wait" initial={false}>`.
- Wrap each route element (or the shared shell) in `<PageTransition>` so the
  outgoing route fades out before the incoming fades in.
- `Suspense` fallback stays; lazy chunks resolve inside the transition.

### 4. Overlays — drawer, modal, notification dropdown

Convert conditionally-rendered overlays from plain `{open && <div>}` (CSS handles
enter only) to `AnimatePresence` + `motion.div` so they animate **out** too.

- **Backdrop:** `overlayFade`.
- **Drawer panel:** `panelSlide` (x: −100% → 0).
- **Notification dropdown** (`components/Notifications.tsx`): `panelSlide` small
  y + opacity.
- Live drawer markup lives in the storefront/merchant trees — adopt there, not in
  legacy `App.tsx`.

### 5. Loading states — `src/components/Skeleton.tsx`

- `<Skeleton>` (shimmer block, CSS keyframe `@keyframes shimmer`) and
  `<Spinner>` (small inline CSS spinner).
- Replace plain "Loading…" text at: `AppRouter` `RouteFallback` &
  `StorefrontShell` loading branch, `RequireRole` loading branch,
  `components/CustomerList` loading branch, and storefront/merchant initial loads.
- Shimmer keyframe respects reduced-motion (falls back to static tint).

### 6. Minimal toast system — `src/ToastContext.tsx` + `src/components/Toaster.tsx`

- `ToastProvider` (mounted high in `AppRouter`, inside `SessionProvider`) exposes
  `useToast()` → `toast.success(msg)`, `toast.error(msg)`, `toast.info(msg)`.
- State: array of `{ id, kind, message }`; auto-dismiss ~4s; manual dismiss.
- `<Toaster>` renders a fixed stack, `AnimatePresence` for enter/exit
  (`listItem` variant), bilingual messages passed by caller via existing `t()`.
- **Adoption (live tree only):** storefront order-place failure
  (`store/Storefront.tsx` `setError` path → `toast.error`) and order success
  confirmation cue. Inline `error`/`success` UI stays as the primary surface;
  toast is an additive cue, so no flow is removed.

## Data flow

No data-layer changes. `store.ts`, Supabase, types untouched. Motion is presentational; toasts are client-only ephemeral state in React context.

## Error handling

- Motion failures degrade gracefully — `motion.div` renders content even if
  animation is interrupted; no content is gated behind an animation completing.
- Reduced-motion path is the safe default for the no-op variants.
- Toast provider never throws into render; `useToast()` outside a provider returns
  no-op functions (guard) so legacy screens can't crash.

## Testing

- Per repo convention, UI is verified by run-and-verify (preview tools), not
  component tests. Verify: route swap fades, drawer slides out on close, skeletons
  show on slow load, toast appears + auto-dismisses, and `prefers-reduced-motion`
  collapses motion to instant.
- `pnpm typecheck` + `pnpm lint` must pass (new `.tsx` files, strict mode).
- No existing unit tests touched (pure logic / `store.ts` unchanged).

## Build sequence

1. Add `motion` dep; `src/motion.tsx` primitives + `useMotionSafe`.
2. Route transitions in `AppRouter`.
3. `Skeleton`/`Spinner` + swap loading-text sites.
4. Overlay enter/exit (drawer, notification dropdown).
5. Toast context + `Toaster` + live-tree adoption.
6. Reduced-motion verification pass + run-and-verify.
