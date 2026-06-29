# App-wide Motion Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add subtle, accessible, app-wide motion (route transitions, content swaps, loading skeletons, toasts) to the live frontend router tree without changing behavior.

**Architecture:** A single `motion.tsx` module owns all timing tokens, variants, and a reduced-motion-safe hook so motion stays consistent. The live router tree (`AppRouter` → Storefront / MerchantHome→Dashboard / AdminMerchants) adopts these primitives. A client-only toast context provides ephemeral success/error cues. The legacy `src/App.tsx` and its `components/*` children are NOT touched.

**Tech Stack:** React 19, Vite 8, TypeScript (strict), `motion` (framer-motion, imported from `motion/react`), vanilla CSS.

## Global Constraints

- Scope is `apps/frontend` only. Do NOT modify `src/App.tsx` or legacy `components/*` (`CustomerList`, `OrderForm`, `VoucherPanel`, `AdminPanel`, `CustomerSettings`, `Notifications`) except where a task names them explicitly.
- Library import surface is always `import { motion, AnimatePresence, useReducedMotion } from 'motion/react'`. No other animation lib.
- Intensity is subtle: durations 0.15–0.28s, slide distance 8px, easing `[0.4, 0, 0.2, 1]`. No spring, no scale-pop.
- All motion MUST collapse to instant (opacity-only, zero distance) under `prefers-reduced-motion`, routed through `useMotionSafe`.
- Every string shown to a user is bilingual via the existing `t(en, zh)` from `useSession()`. Never hardcode user-facing English.
- No data-layer changes: `store.ts`, `types.ts`, Supabase, migrations untouched.
- Verification per repo convention is run-and-verify + `pnpm typecheck` + `pnpm lint`. Do NOT add Vitest component tests for UI (CLAUDE.md: "UI is verified by running the app, not component tests"). `pnpm test` must still pass unchanged.
- Run all commands from repo root. Frontend dev server is `:5173`.

---

### Task 1: Motion primitives module + dependency + reduced-motion CSS

**Files:**
- Modify: `apps/frontend/package.json` (add `motion` dependency)
- Create: `apps/frontend/src/motion.tsx`
- Modify: `apps/frontend/src/index.css:1-9` (append reduced-motion + shimmer keyframe near top-level rules)

**Interfaces:**
- Produces:
  - `DUR: { fast: number; base: number; slow: number }` = `{ fast: 0.15, base: 0.22, slow: 0.28 }`
  - `EASE: [number, number, number, number]` = `[0.4, 0, 0.2, 1]`
  - `useMotionSafe(): boolean` — `true` when motion is allowed, `false` when `prefers-reduced-motion`.
  - `usePageVariants(): Variants` — `fadeSlide`, distance collapses to 0 when reduced.
  - `useOverlayVariants(): Variants` — `overlayFade` (opacity only).
  - `usePanelVariants(): Variants` — small y + opacity, distance collapses when reduced.
  - `useListItemVariants(): Variants` — opacity + y, distance collapses when reduced.
  - `PageTransition: React.FC<{ children: React.ReactNode }>` — wraps a route element in a `motion.div` using page variants with `initial="initial" animate="animate" exit="exit"`.

- [ ] **Step 1: Add the dependency**

Run:
```bash
pnpm --filter @bitetime/frontend add motion
```
Expected: `motion` appears under `dependencies` in `apps/frontend/package.json`; lockfile updates; exit 0.

- [ ] **Step 2: Create the primitives module**

Create `apps/frontend/src/motion.tsx`:
```tsx
import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { Variants } from 'motion/react'

// Subtle motion tokens — match the existing CSS feel (0.15s, cubic-bezier(0.4,0,0.2,1)).
export const DUR = { fast: 0.15, base: 0.22, slow: 0.28 } as const
export const EASE = [0.4, 0, 0.2, 1] as const

// True when motion is allowed; false under prefers-reduced-motion.
export function useMotionSafe(): boolean {
  return !useReducedMotion()
}

// Page/route transition: fade + small upward slide. Distance is 0 when reduced.
export function usePageVariants(): Variants {
  const safe = useMotionSafe()
  const d = safe ? 8 : 0
  return {
    initial: { opacity: 0, y: d },
    animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE } },
    exit: { opacity: 0, y: -d, transition: { duration: DUR.fast, ease: EASE } },
  }
}

// Backdrop / overlay: opacity only.
export function useOverlayVariants(): Variants {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: DUR.fast, ease: EASE } },
    exit: { opacity: 0, transition: { duration: DUR.fast, ease: EASE } },
  }
}

// Floating panel / dropdown: small y + opacity.
export function usePanelVariants(): Variants {
  const safe = useMotionSafe()
  const d = safe ? 6 : 0
  return {
    initial: { opacity: 0, y: -d },
    animate: { opacity: 1, y: 0, transition: { duration: DUR.fast, ease: EASE } },
    exit: { opacity: 0, y: -d, transition: { duration: DUR.fast, ease: EASE } },
  }
}

// List item (toasts, future list enter/exit).
export function useListItemVariants(): Variants {
  const safe = useMotionSafe()
  const d = safe ? 10 : 0
  return {
    initial: { opacity: 0, y: d },
    animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE } },
    exit: { opacity: 0, y: d, transition: { duration: DUR.fast, ease: EASE } },
  }
}

// Wraps a route element so it fades/slides on mount and unmount.
export function PageTransition({ children }: { children: ReactNode }) {
  const variants = usePageVariants()
  return (
    <motion.div variants={variants} initial="initial" animate="animate" exit="exit">
      {children}
    </motion.div>
  )
}
```

- [ ] **Step 3: Add reduced-motion + shimmer CSS**

In `apps/frontend/src/index.css`, immediately after the `*, *::before, *::after { ... }` reset rule (line ~4), insert:
```css
@keyframes shimmer { 0% { background-position: -468px 0; } 100% { background-position: 468px 0; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 4: Typecheck and lint**

Run:
```bash
pnpm typecheck && pnpm lint
```
Expected: PASS, no errors. (`motion.tsx` compiles under strict mode; `Variants` import resolves.)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/package.json pnpm-lock.yaml apps/frontend/src/motion.tsx apps/frontend/src/index.css
git commit -m "feat(frontend): add motion primitives + reduced-motion CSS"
```

---

### Task 2: Route transitions in AppRouter

**Files:**
- Modify: `apps/frontend/src/AppRouter.tsx`

**Interfaces:**
- Consumes: `PageTransition` from `./motion` (Task 1); `AnimatePresence` from `motion/react`.
- Produces: animated route swaps. No exported symbols.

- [ ] **Step 1: Import motion pieces and router location**

In `apps/frontend/src/AppRouter.tsx`, update the top imports. Change:
```tsx
import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
```
to:
```tsx
import { lazy, Suspense } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'motion/react'
import { PageTransition } from './motion'
```

- [ ] **Step 2: Wrap Routes in AnimatePresence keyed by pathname**

In the `AppRouter` component, replace the `<Suspense>...<Routes>...</Routes></Suspense>` block. The new body:
```tsx
export default function AppRouter() {
  return (
    <SessionProvider>
      <AnimatedRoutes />
    </SessionProvider>
  )
}

function AnimatedRoutes() {
  const location = useLocation()
  return (
    <Suspense fallback={<RouteFallback />}>
      <AnimatePresence mode="wait" initial={false}>
        <PageTransition key={location.pathname}>
          <Routes location={location}>
            <Route path="/" element={<Landing />} />
            <Route path="/s/:slug/*" element={<MerchantProvider><StorefrontShell /></MerchantProvider>} />
            <Route path="/merchant/signup" element={<SignupScreen />} />
            <Route path="/merchant/login" element={<LoginScreen />} />
            <Route path="/merchant" element={<RequireRole role="merchant"><MerchantHome /></RequireRole>} />
            <Route path="/merchant/:slug" element={<RequireRole role="superadmin"><MerchantHome /></RequireRole>} />
            <Route path="/admin/merchants" element={<RequireRole role="superadmin"><AdminMerchants /></RequireRole>} />
            <Route path="/admin" element={<RequireRole role="superadmin"><AdminMerchants /></RequireRole>} />
          </Routes>
        </PageTransition>
      </AnimatePresence>
    </Suspense>
  )
}
```
Note: keying the wrapper by `location.pathname` (not search/hash) keeps storefront sub-navigation within `/s/:slug/*` from re-triggering full-page transitions on query changes.

- [ ] **Step 3: Typecheck and lint**

Run:
```bash
pnpm typecheck && pnpm lint
```
Expected: PASS.

- [ ] **Step 4: Run and verify**

Start the dev server (preview_start / `pnpm dev`). Navigate `/` → `/merchant/login` → back. Verify: outgoing page fades/slides out, incoming fades in; no flash of unstyled content; no console errors. Capture a screenshot of a loaded route.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/AppRouter.tsx
git commit -m "feat(frontend): animate route transitions"
```

---

### Task 3: Skeleton + Spinner components, swap live loading text

**Files:**
- Create: `apps/frontend/src/components/Loaders.tsx`
- Modify: `apps/frontend/src/index.css` (append `.skeleton`, `.spinner` rules)
- Modify: `apps/frontend/src/AppRouter.tsx` (`RouteFallback`, `StorefrontShell` loading branch)
- Modify: `apps/frontend/src/RequireRole.tsx:8`
- Modify: `apps/frontend/src/merchant/ProductsManager.tsx:30-34`
- Modify: `apps/frontend/src/merchant/OrdersView.tsx:42-44`
- Modify: `apps/frontend/src/merchant/CustomersView.tsx:18-20`

**Interfaces:**
- Produces:
  - `Skeleton: React.FC<{ width?: string; height?: string; radius?: string; className?: string }>` — a shimmer block.
  - `SkeletonText: React.FC<{ lines?: number }>` — stacked `Skeleton` lines.
  - `Spinner: React.FC<{ label?: string }>` — small inline CSS spinner with optional bilingual label passed by caller.

- [ ] **Step 1: Create Loaders component**

Create `apps/frontend/src/components/Loaders.tsx`:
```tsx
export function Skeleton({ width = '100%', height = '1rem', radius = 'var(--radius-sm)', className = '' }:
  { width?: string; height?: string; radius?: string; className?: string }) {
  return <span className={`skeleton ${className}`} style={{ width, height, borderRadius: radius }} aria-hidden="true" />
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height="0.85rem" width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </span>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="spinner-label">{label}</span>}
    </span>
  )
}
```

- [ ] **Step 2: Add Skeleton + Spinner CSS**

Append to `apps/frontend/src/index.css`:
```css
.skeleton { display: block; background: linear-gradient(90deg, var(--color-cream) 25%, var(--color-surface-raised) 50%, var(--color-cream) 75%); background-size: 936px 100%; animation: shimmer 1.4s linear infinite; }
.skeleton-text { display: flex; flex-direction: column; gap: 8px; }
.spinner-wrap { display: inline-flex; align-items: center; gap: 10px; color: var(--color-rose-muted); font-size: 14px; }
.spinner { width: 18px; height: 18px; border: 2px solid var(--color-clay-border); border-top-color: var(--color-oxblood); border-radius: 50%; animation: spin 0.7s linear infinite; }
.spinner-label { font-family: 'DM Sans', sans-serif; }
@keyframes spin { to { transform: rotate(360deg); } }
```
(`@media (prefers-reduced-motion)` from Task 1 neutralizes the shimmer/spin animations automatically.)

- [ ] **Step 3: Swap AppRouter loading text**

In `apps/frontend/src/AppRouter.tsx`, add `import { Spinner } from './components/Loaders'`. In `RouteFallback`, replace `<p>Loading…</p>` with `<Spinner label="Loading…" />`. In `StorefrontShell`, replace the loading branch's `<p>Loading shop…</p>` with `<Spinner label="Loading shop…" />`. (These two are pre-i18n surfaces with literal English already; keep the literal to match existing behavior.)

- [ ] **Step 4: Swap RequireRole loading text**

In `apps/frontend/src/RequireRole.tsx`, add `import { Spinner } from './components/Loaders'`. Replace line 8:
```tsx
  if (loading) return <div style={{ padding: 24 }}>Loading…</div>
```
with:
```tsx
  if (loading) return <div style={{ padding: 24 }}><Spinner label="Loading…" /></div>
```

- [ ] **Step 5: Swap merchant view loading text**

In `apps/frontend/src/merchant/ProductsManager.tsx`, add `import { SkeletonText } from '../components/Loaders'`. Replace the `if (!rows) return (...)` block body's `<p className="empty-msg">{t('Loading…', '加载中…')}</p>` with `<SkeletonText lines={4} />`.

In `apps/frontend/src/merchant/OrdersView.tsx`, add `import { SkeletonText } from '../components/Loaders'`. Replace `return <p className="mm-orders-loading">{t('Loading…', '加载中…')}</p>` with:
```tsx
    return <div className="admin-panel"><SkeletonText lines={4} /></div>
```

In `apps/frontend/src/merchant/CustomersView.tsx`, add `import { SkeletonText } from '../components/Loaders'`. Replace `return <p className="mm-orders-loading">{t('Loading…', '加载中…')}</p>` with:
```tsx
    return <div className="admin-panel"><SkeletonText lines={4} /></div>
```

- [ ] **Step 6: Typecheck and lint**

Run:
```bash
pnpm typecheck && pnpm lint
```
Expected: PASS.

- [ ] **Step 7: Run and verify**

With dev server running, throttle network (or observe initial load) on the merchant dashboard Products/Orders/Customers tabs and a storefront load. Verify shimmer skeleton shows instead of plain "Loading…" and resolves to content. Screenshot one skeleton state.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/components/Loaders.tsx apps/frontend/src/index.css apps/frontend/src/AppRouter.tsx apps/frontend/src/RequireRole.tsx apps/frontend/src/merchant/ProductsManager.tsx apps/frontend/src/merchant/OrdersView.tsx apps/frontend/src/merchant/CustomersView.tsx
git commit -m "feat(frontend): skeleton + spinner loading states"
```

---

### Task 4: Content-swap transitions (Dashboard tabs + Storefront success view)

**Files:**
- Modify: `apps/frontend/src/merchant/Dashboard.tsx:18-46`
- Modify: `apps/frontend/src/store/Storefront.tsx` (wrap success vs form render)

**Interfaces:**
- Consumes: `useListItemVariants`/`usePageVariants` from `./motion` or `../motion`; `motion`, `AnimatePresence` from `motion/react`.
- Produces: crossfade on Dashboard section change and on Storefront form→success swap. No exported symbols.

- [ ] **Step 1: Animate Dashboard section content**

In `apps/frontend/src/merchant/Dashboard.tsx`, add imports:
```tsx
import { motion, AnimatePresence } from 'motion/react'
import { usePageVariants } from '../motion'
```
Inside the component (after `const [section, setSection] = useState<string>('products')`), add:
```tsx
  const variants = usePageVariants()
```
Replace the four conditional section renders:
```tsx
      {section === 'products'  && <ProductsManager />}
      {section === 'settings'  && <ShopSettings />}
      {section === 'orders'    && <OrdersView />}
      {section === 'customers' && <CustomersView />}
```
with an animated keyed swap:
```tsx
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={section} variants={variants} initial="initial" animate="animate" exit="exit">
          {section === 'products'  && <ProductsManager />}
          {section === 'settings'  && <ShopSettings />}
          {section === 'orders'    && <OrdersView />}
          {section === 'customers' && <CustomersView />}
        </motion.div>
      </AnimatePresence>
```

- [ ] **Step 2: Animate Storefront form↔success swap**

In `apps/frontend/src/store/Storefront.tsx`, add imports at top:
```tsx
import { motion, AnimatePresence } from 'motion/react'
import { usePageVariants } from '../motion'
```
After `const { lang, setLang, t } = useSession()`, add:
```tsx
  const viewVariants = usePageVariants()
```
Wrap the success-branch returned JSX and the order-form returned JSX so they crossfade. The simplest non-invasive change: keep both `return`s but wrap each top-level returned element in a keyed `motion.div`. For the success branch (`if (success) { return ( <div className="form-wrap"> ... </div> ) }`), change the outer element to:
```tsx
      <AnimatePresence mode="wait">
        <motion.div key="success" className="form-wrap" variants={viewVariants} initial="initial" animate="animate" exit="exit">
          {/* existing success-box contents unchanged */}
        </motion.div>
      </AnimatePresence>
```
For the order-form `return`, wrap its outer `form-wrap` element the same way with `key="form"`. Preserve all existing inner JSX and `className` values exactly; only the outer wrapper element type and the `key`/`variants` props change.

- [ ] **Step 3: Typecheck and lint**

Run:
```bash
pnpm typecheck && pnpm lint
```
Expected: PASS.

- [ ] **Step 4: Run and verify**

Dev server running: on merchant dashboard, click between Products/Settings/Orders/Customers tabs — content crossfades, no layout jump. On a storefront, place a test order — form crossfades to the success view. No console errors. Screenshot a mid-transition or post-swap state.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/Dashboard.tsx apps/frontend/src/store/Storefront.tsx
git commit -m "feat(frontend): crossfade dashboard tabs and storefront success view"
```

---

### Task 5: Toast context + Toaster component

**Files:**
- Create: `apps/frontend/src/ToastContext.tsx`
- Create: `apps/frontend/src/components/Toaster.tsx`
- Modify: `apps/frontend/src/index.css` (append `.toaster`, `.toast` rules)
- Modify: `apps/frontend/src/AppRouter.tsx` (mount `ToastProvider` + `Toaster`)

**Interfaces:**
- Produces:
  - `ToastProvider: React.FC<{ children: React.ReactNode }>`
  - `useToast(): { success(msg: string): void; error(msg: string): void; info(msg: string): void }` — outside a provider returns no-op functions (never throws).
  - `Toaster: React.FC` — renders the fixed toast stack; must be rendered once inside `ToastProvider`.
  - Internal type `Toast = { id: number; kind: 'success' | 'error' | 'info'; message: string }`.

- [ ] **Step 1: Create the toast context**

Create `apps/frontend/src/ToastContext.tsx`:
```tsx
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type ToastKind = 'success' | 'error' | 'info'
export interface Toast { id: number; kind: ToastKind; message: string }

interface ToastApi {
  success(msg: string): void
  error(msg: string): void
  info(msg: string): void
}

const NOOP: ToastApi = { success: () => {}, error: () => {}, info: () => {} }

const ToastApiContext = createContext<ToastApi>(NOOP)
const ToastListContext = createContext<{ toasts: Toast[]; dismiss(id: number): void }>({ toasts: [], dismiss: () => {} })

const AUTO_DISMISS_MS = 4000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts(list => list.filter(t => t.id !== id))
  }, [])

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++
    setToasts(list => [...list, { id, kind, message }])
    setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
  }, [dismiss])

  const api = useMemo<ToastApi>(() => ({
    success: m => push('success', m),
    error: m => push('error', m),
    info: m => push('info', m),
  }), [push])

  const list = useMemo(() => ({ toasts, dismiss }), [toasts, dismiss])

  return (
    <ToastApiContext.Provider value={api}>
      <ToastListContext.Provider value={list}>
        {children}
      </ToastListContext.Provider>
    </ToastApiContext.Provider>
  )
}

export function useToast(): ToastApi {
  return useContext(ToastApiContext)
}

export function useToastList() {
  return useContext(ToastListContext)
}
```
Note: `setTimeout` with no `Date.now()` is fine in app code (the `Date.now()` restriction is for Workflow scripts only, not the app).

- [ ] **Step 2: Create the Toaster component**

Create `apps/frontend/src/components/Toaster.tsx`:
```tsx
import { motion, AnimatePresence } from 'motion/react'
import { useListItemVariants } from '../motion'
import { useToastList } from '../ToastContext'

export default function Toaster() {
  const { toasts, dismiss } = useToastList()
  const variants = useListItemVariants()
  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      <AnimatePresence initial={false}>
        {toasts.map(toast => (
          <motion.button
            key={toast.id}
            type="button"
            className={`toast toast--${toast.kind}`}
            variants={variants}
            initial="initial"
            animate="animate"
            exit="exit"
            layout
            onClick={() => dismiss(toast.id)}
          >
            {toast.message}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  )
}
```

- [ ] **Step 3: Add Toaster CSS**

Append to `apps/frontend/src/index.css`:
```css
.toaster { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: var(--z-toast, 9999); display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; width: max-content; max-width: calc(100vw - 2rem); }
.toast { pointer-events: auto; cursor: pointer; border: 1px solid var(--color-clay-border); border-radius: var(--radius-pill); padding: 10px 18px; font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 500; box-shadow: 0 6px 20px rgba(43,10,16,0.14); background: var(--color-surface-raised); color: var(--color-ink); text-align: center; }
.toast--success { border-color: var(--color-clay-border); background: var(--color-surface-raised); color: var(--color-ink); }
.toast--error { border-color: var(--color-rose-border); background: var(--color-oxblood-tint); color: var(--color-oxblood); }
.toast--info { border-color: var(--color-clay-border); background: var(--color-cream); color: var(--color-rose-muted); }
```

- [ ] **Step 4: Mount provider + Toaster in AppRouter**

In `apps/frontend/src/AppRouter.tsx`, add imports:
```tsx
import { ToastProvider } from './ToastContext'
import Toaster from './components/Toaster'
```
Wrap the tree inside `SessionProvider` with `ToastProvider` and render `Toaster` once:
```tsx
export default function AppRouter() {
  return (
    <SessionProvider>
      <ToastProvider>
        <AnimatedRoutes />
        <Toaster />
      </ToastProvider>
    </SessionProvider>
  )
}
```

- [ ] **Step 5: Typecheck and lint**

Run:
```bash
pnpm typecheck && pnpm lint
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/ToastContext.tsx apps/frontend/src/components/Toaster.tsx apps/frontend/src/index.css apps/frontend/src/AppRouter.tsx
git commit -m "feat(frontend): toast context + animated toaster"
```

---

### Task 6: Adopt toasts in live flows

**Files:**
- Modify: `apps/frontend/src/store/Storefront.tsx` (order success + failure)
- Modify: `apps/frontend/src/merchant/ProductsManager.tsx` (save + delete)

**Interfaces:**
- Consumes: `useToast()` from `../ToastContext` (Task 5).
- Produces: user-facing success/error cues. Inline `error`/`success` UI stays as the primary surface; toasts are additive.

- [ ] **Step 1: Add toast cues to Storefront**

In `apps/frontend/src/store/Storefront.tsx`, add `import { useToast } from '../ToastContext'`. After `const viewVariants = usePageVariants()` (Task 4), add `const toast = useToast()`. In `handleSubmit`, in the success path after `setSuccess({ ... })` add:
```tsx
      toast.success(t('Order placed!', '订单已提交！'))
```
In the `catch` block after `setError(...)` add:
```tsx
      toast.error(t('Failed to place order. Please try again.', '下单失败，请重试。'))
```

- [ ] **Step 2: Add toast cues to ProductsManager**

In `apps/frontend/src/merchant/ProductsManager.tsx`, add `import { useToast } from '../ToastContext'`. After `const { t, merchant } = useSession()` add `const toast = useToast()`. In `save`, after `setForm(BLANK); await load()` add:
```tsx
      toast.success(t('Product saved', '产品已保存'))
```
In `remove`, change:
```tsx
  async function remove(id: string) { await deleteProduct(id); await load() }
```
to:
```tsx
  async function remove(id: string) { await deleteProduct(id); await load(); toast.success(t('Product deleted', '产品已删除')) }
```

- [ ] **Step 3: Typecheck and lint**

Run:
```bash
pnpm typecheck && pnpm lint
```
Expected: PASS.

- [ ] **Step 4: Run and verify**

Dev server running: place a storefront order → success toast appears bottom-center and auto-dismisses ~4s; clicking it dismisses early. On dashboard Products, save and delete a product → toast cues appear. Force an order error (e.g. offline) → error toast in oxblood styling. Screenshot a visible toast.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/store/Storefront.tsx apps/frontend/src/merchant/ProductsManager.tsx
git commit -m "feat(frontend): toast cues for order + product flows"
```

---

### Task 7: Reduced-motion verification pass + full check

**Files:** none modified (verification only; fix inline if a defect surfaces).

- [ ] **Step 1: Full automated gate**

Run:
```bash
pnpm typecheck && pnpm lint && pnpm test
```
Expected: all PASS. `pnpm test` unchanged from baseline (no UI component tests added).

- [ ] **Step 2: Reduced-motion run-and-verify**

With dev server running, enable OS "Reduce Motion" (or emulate `prefers-reduced-motion: reduce` in devtools). Re-exercise: route nav, dashboard tab swap, storefront order, toast. Verify all motion is effectively instant (no slide, no shimmer travel, no spinner spin) while content/behavior is identical. Screenshot one reduced-motion state.

- [ ] **Step 3: Production build sanity**

Run:
```bash
pnpm build
```
Expected: build succeeds; `apps/frontend/dist/` produced; no `motion` resolution errors.

- [ ] **Step 4: Commit (only if Step 1–3 surfaced fixes)**

```bash
git add -A
git commit -m "fix(frontend): reduced-motion + build verification adjustments"
```
If no fixes were needed, skip this commit.

---

## Notes on scope reconciliation (vs spec)

The design spec listed "drawer + notification dropdown" as overlay targets. Investigation found both live **only** in the legacy, unmounted `src/App.tsx` tree (`components/Notifications.tsx` is not imported by any live route; the live merchant UI uses tab navigation in `Dashboard.tsx`, not a side drawer). Per the Global Constraint to leave legacy code untouched, this plan retargets the overlay work to the equivalent live surfaces: **Dashboard tab-content crossfade** and the **Storefront form↔success transition** (Task 4). All other spec items (route transitions, loading states, minimal toasts, reduced-motion) are implemented as specified.
