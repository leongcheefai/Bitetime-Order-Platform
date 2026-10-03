# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo

pnpm + Turborepo. Three workspaces: `@bitetime/frontend` (`apps/frontend`, Vite+React, **TypeScript**), `@bitetime/backend` (`apps/backend`, Hono+Stripe billing, **TypeScript** — also holds `supabase/`, `tests/`, `scripts/`), and `@bitetime/shared` (`packages/shared`). `docs/` stays at the repo root. Paths below are relative to `apps/frontend/` unless prefixed.

The whole codebase is TypeScript (`.ts`/`.tsx`). Each workspace has its own `tsconfig.json` extending the root `tsconfig.base.json` (both `strict: true`, `noEmit: true` — Vite/esbuild do the emitting). Vite, esbuild, and Vitest compile TS natively. Frontend uses `moduleResolution: bundler` (extensionless relative imports); backend uses `NodeNext` (relative imports keep `.js` specifiers that resolve to the `.ts` source — leave them as `.js`).

`@bitetime/shared` holds **rules that must hold identically on both sides of the wire** — today: order pricing and its row → domain mappers (`pricing.ts`, the biggest and the reason the rest followed), the fulfilment window (`fulfilment.ts`), the cart-size caps (`cart.ts`), feedback validation (`feedback.ts`) and the customer password floor (`password.ts`). It ships **TypeScript source, no build step** (`exports: "./src/index.ts"`): both consumers compile TS themselves, so there is no `dist` to keep in sync and no build ordering to get wrong. The one thing this costs: the backend's esbuild bundle can no longer say `--packages=external` (that would leave a bare `@bitetime/shared` import resolving to `.ts` at runtime), so its four real runtime deps are listed with explicit `--external:` flags — **add a new backend runtime dependency and you must add its `--external:` flag too**, or it gets bundled. Anything that is not a shared rule does not belong here; a duplicate with a comment (see `notify.ts`'s currency twin) is the cheaper answer when only one side is authoritative.

## Commands

Run from the repo root; turbo fans out to workspaces. `--filter` targets one.

```bash
pnpm dev           # all dev servers (frontend :5173, backend :8787)
pnpm build         # production build → apps/frontend/dist/
pnpm lint          # ESLint check (typescript-eslint)
pnpm typecheck     # tsc --noEmit across workspaces
pnpm deploy        # frontend production build (deploy via Vercel)
pnpm test          # Vitest unit tests across workspaces
pnpm --filter @bitetime/frontend preview   # serve built dist/ locally
pnpm --filter @bitetime/backend dev         # billing server only
pnpm --filter @bitetime/backend test        # backend unit tests (notify, etc.) — no Supabase needed
pnpm --filter @bitetime/backend test:db     # DB-backed tests: RLS + API (needs a running local Supabase; reads its keys itself)
pnpm --filter @bitetime/backend db:migrate   # apply pending SQL migrations to the LOCAL Supabase DB
pnpm --filter @bitetime/backend db:push      # HUMAN ONLY — writes to PRODUCTION. Never run this yourself.
pnpm --filter @bitetime/backend telegram:webhook poll   # forward a DEV bot's updates to the local support webhook (the support chat's `stripe listen`)
pnpm --filter @bitetime/backend telegram:webhook set <backend-url>   # HUMAN ONLY for production — registers the support webhook

stripe listen --project-name bitetimeco --forward-to http://localhost:8787/api/stripe/webhook   # REQUIRED for any local billing work

# Re-shoot the /sample-shops carousel's storefront photographs against your OWN stack. Needs both
# dev servers up. Nothing does this locally on its own, so a local shot stays whatever it was on
# the day it was taken — which is how the carousel came to show a three-week-old storefront design.
FRONTEND_URL=http://localhost:5173 BACKEND_URL=http://localhost:8787 \
  SAMPLE_SHOP_SCREENSHOT_SWEEP_SECRET=$(grep SAMPLE_SHOP_SCREENSHOT_SWEEP_SECRET apps/backend/.env | cut -d= -f2) \
  pnpm --filter @bitetime/backend screenshot:sweep
```

**Anything that involves paying must have `stripe listen` running before the payment.** Stripe cannot reach `localhost`, and every post-payment effect is webhook-driven — `merchant_billing` (subscription id, status), the `merchants.billing_cycle` reconciliation and the pending→active flip all happen in `POST /api/stripe/webhook` and nowhere else. Without the forwarder, Checkout completes, Stripe charges the card, and the app changes **nothing**: the shop stays shut, and the only trace is the `stripe_customer_id` that `/api/checkout` wrote before redirecting. It looks exactly like a broken feature.

**`--project-name bitetimeco` is not optional**, even though every earlier note here omitted it. `~/.config/stripe/config.toml` on this machine holds THREE profiles on three different Stripe accounts, and a bare `stripe listen` takes `default` — a different account from the one this project's keys belong to.

The CLI prints its own signing secret on startup; it must equal `STRIPE_WEBHOOK_SECRET` in `apps/backend/.env` or every event is rejected as an invalid signature (a `<-- [400]` in the listener's own output). That secret is **per (Stripe account, device)** and is fetched from Stripe on each run rather than cached in the config file, so Stripe never rotates it on you: the same account on the same machine prints the same secret for ever. A secret that does not match therefore means the PAIRING changed, and on this machine that is almost always the wrong profile — check that before editing `.env`, because editing it to match `default` breaks the listener that was already correct. Compare without printing either secret — `tr -d '\n'` on BOTH lines, or the CLI's trailing newline hashes into a mismatch that looks exactly like the real fault:

```bash
stripe listen --print-secret --project-name bitetimeco | tr -d '\n' | shasum
grep '^STRIPE_WEBHOOK_SECRET=' apps/backend/.env | cut -d= -f2- | tr -d '\n' | shasum
```

Started late? `stripe events resend <evt_id>` replays one — the handlers upsert, so a replay is safe. And check the listener is actually still up (`ps -eo command | grep stripe`) before concluding the code is at fault: a dead forwarder and a broken handler look identical from the app.

Migrations live in `apps/backend/supabase/migrations/`. Adding a migration file does **not** apply it — run `db:migrate` (local) so the running app (and PostgREST's schema cache) sees the new columns; otherwise queries fail with `Could not find the 'X' column … in the schema cache`.

**Never run `db:push`, or any other `supabase` command that reaches production. Writing a migration file and applying it locally is the whole job; a human runs the push.** Say plainly that production still needs it, and stop there.

`apps/backend/supabase` is **linked** (`supabase/.temp/project-ref` → the live project), and that makes the CLI's default target the trap:

| Command | Targets |
|---------|---------|
| `supabase migration up` / `db:migrate` | LOCAL stack |
| `supabase db push` | **PRODUCTION** |
| `supabase migration repair` / `list` | **PRODUCTION**, silently, unless given `--db-url` |

`repair` is the one that bites: it names no database, prompts for nothing, and reports success either way. To repair a LOCAL history row you must point it there explicitly:

```bash
supabase migration repair --status reverted <version> --db-url "postgresql://postgres:postgres@127.0.0.1:55322/postgres"
```

That URL comes from `supabase status` (`-o env` prints it as `DB_URL="…"`, quotes included — read the port off it rather than pasting the line into a flag). The port is **55321/55322 here, not the 54321/54322 default**. All of these run from `apps/backend/` only; from the repo root they fail with "Cannot find project ref".

This is not hypothetical. On 2026-07-29 a bare `repair --status applied <version>` intended to fix local drift instead marked a migration **applied on production that had only ever run locally** — which would have made the next `db:push` skip it and ship code reading a column production did not have. Nothing broke (repair touches history rows, never tables), and it was undone with `repair --status reverted <version>`, but the honest lesson is: **establish what a `supabase` subcommand targets before running it, and treat anything remote as the human's call.**

Local history drifts for an ordinary reason — one local Supabase shared across branches. Migrate on a feature branch, switch back to `dev`, and `db:migrate` refuses: the local history holds a version whose FILE is gone. The lossless fix is `repair --status reverted <version> --db-url <local>`, which costs nothing when that branch's migration is idempotent (`add column if not exists`). `supabase db reset` also fixes it and wipes every local shop, order and user — a last resort, and the user's decision, not yours.

Tests use Vitest (added during the multi-merchant build). Pure logic and `store.ts` functions have unit tests (`apps/frontend/src/*.test.ts`); the backend has pure unit tests in `apps/backend/tests/unit/` (run by `test`, no Supabase).

Everything that needs a database is run by `test:db` and needs a running local Supabase (`supabase start` from `apps/backend`): tenant isolation and order attribution in `apps/backend/tests/rls/`, and the API endpoints in `apps/backend/tests/api/`. The API suites drive the real routes **in-process** via Hono's `app.request()` — which is why `src/app.ts` exports the app and `src/index.ts` is a separate entry that only calls `serve()`. Keep `app.ts` free of import-time side effects or the seam closes.

`test:db` uses its own `vitest.db.config.ts`, which reads the stack's URL, keys and `DATABASE_URL` from `supabase status` (and stubs the Stripe keys, which these suites never call) — set them yourself only to point it elsewhere (CI). Missing credentials are a startup **error**, never a skip. **Never mock the database in these suites**: they exist to prove properties of real Postgres — that an order cannot be spoofed onto a stranger's account, that a transaction really rolls back — and a mocked run reports green while asserting nothing, which is worse than no suite at all.

UI is verified by running the app (run-and-verify), not component tests.

**All of it runs on every pull request** (`.github/workflows/ci.yml`): one job for lint, typecheck, `test` and both builds, and a second that stands up its own Supabase and runs `test:db` — so the suites that need a database are checked by the thing least likely to forget. It needs **no secrets**: the DB job reads its stack's keys out of `supabase status`, and the Stripe and Google keys are stubbed or forced empty by `vitest.db.config.ts`. Node is pinned once, in `.github/actions/setup`.

## Architecture

Multi-merchant ordering SaaS. React 19 + Vite + React Router (`react-router-dom` v7). Many independent shops, isolated per tenant by Postgres RLS. No global state library — auth/role/lang live in React context.

`main.tsx` mounts `AppRouter`. The legacy single-tenant single-page app (`src/App.tsx` and its components) has been **deleted**; all work goes through the router tree below.

### Routing (`src/AppRouter.tsx`)

| Path | Screen | Guard |
|------|--------|-------|
| `/` | marketing landing (`marketing/Landing.tsx`) | — |
| `/pricing` | the plan in full (`marketing/Pricing.tsx`) | — (prerendered; the landing page keeps a summary and links here, so the two are not one page's content at two URLs) |
| `/features` | every feature in full (`marketing/FeaturesPage.tsx`) | — (prerendered). Renders all of `marketing/features.ts`. The landing **no longer repeats any of it**: it used to render `FEATURES.slice(0, 3)` under a heading that argued the same thing as its own value props one section above, so that section is gone and only the link to here survives, under the value-prop grid. Each entry's short `teaser` is now unused by any page — the field is kept for the next hook that needs one |
| `/faq` | the questions asked before signing up (`marketing/FaqPage.tsx`) | — (prerendered, with its `FAQPage` JSON-LD baked via the prerender's `head` field — as `/for/:slug` also is, and no other route is) |
| `/for/:slug` | one page per business type (`marketing/UseCasePage.tsx`, from `marketing/useCases.ts`) | — (prerendered, one file each under `dist/for/`, each with its own `FAQPage` `@id` so four pages read as four pages) |
| `/releases/:tag` | a published release note (`marketing/ReleaseNotes.tsx`) | — (not prerendered and not in the sitemap: the rows are database-driven and a build must not read them) |
| `/reset-password` | set a new password after a recovery link (`ResetPasswordPage.tsx`) | none — **deliberately top-level**: nested under `/s/:slug` the shell's status gate would swallow it, and a suspended shop must never lock a customer out of their own account. Role-blind; `?shop=<slug>` decides where they land afterwards |
| `/s/:slug/*` | merchant storefront (`store/Storefront.tsx`) | `MerchantProvider` resolves shop by slug; gated on `status === 'active'` |
| `/merchant/signup`, `/merchant/login` | shop signup / login | — |
| `/merchant` | merchant dashboard (`merchant/MerchantHome.tsx`) | role `merchant` |
| `/admin`, `/admin/merchants` | manage merchants (`admin/AdminMerchants.tsx`) | role `superadmin` |

`RequireRole` is the route guard; `superadmin` passes any guard.

### Auth & roles

- Supabase Auth handles login/registration (`src/supabase.ts`, `src/store.ts`)
- `SessionContext` derives `role`: `superadmin` if `profiles.app_role === 'superadmin'` (transitional email fallback to `bitetime@praxor.dev`), else `merchant` if the user owns a `merchants` row, else `customer`
- `MerchantContext` resolves the active shop for `/s/:slug` storefronts
- A **merchant** account holds at most `MERCHANT_DEVICE_LIMIT` (2) signed-in devices, and one device is one GoTrue session. `POST /api/me/devices/enforce`, which the browser calls after every sign-in, deletes the surplus rows from `auth.sessions` — least recently used first, and never the caller's own session. That delete is the whole mechanism: GoTrue then rejects the removed device's still-unexpired access token with `403 session_not_found`, on this API, Storage and PostgREST alike, so eviction is instant rather than one `jwt_expiry` late. The rule is `deviceLimit.ts` (pure) over `deviceLimitDb.ts` (two statements against the `auth` schema — reads and deletes only, never a trigger or a column); the session id is read from the JWT's `session_id` claim and never from a body. Customers and superadmins are not bounded. `store.ts`'s `signOut` MUST keep `{ scope: 'local' }` — `@supabase/auth-js` defaults to `global`, which revokes every session and makes the limit behave as one device. See `docs/superpowers/specs/2026-08-25-merchant-device-limit-design.md`.

### Merchant onboarding & slugs (`src/slug.ts`)

Sign up with a shop name → auto slug: pinyin transliteration for Chinese names, `shop-<id>` fallback, uniqueness suffix (`-2`), reserved platform segments blocked (`RESERVED_SLUGS`: `s`, `admin`, `api`, `merchant`, …).

New shops go live at **signup**: `POST /api/merchants` provisions the 7-day cardless trial itself (`startCardlessTrial` in `apps/backend/src/trialSubscription.ts`) and activates the shop. `pending` therefore means **provisioning did not finish** — the Stripe call failed — which its owner retries via `POST /api/merchants/:id/start-trial`. `POST /api/admin/approve-merchant` survives as the admin-side fallback for a shop stuck there; it is no longer a gate anyone waits at, and moderation is reactive (suspend).

### Data layer (`src/store.ts`)

All Supabase calls go through `store.ts`. Shared domain types (Merchant, Profile, Product, Order, Voucher, SessionValue, …) live in `src/types.ts`. Postgres tables (`apps/backend/supabase/migrations/`), tenant-scoped by RLS **on the browser's path** — see the caveat under Backend below:

| Table | Purpose |
|-------|---------|
| `merchants` | shop record — slug, status (`pending`/`active`/suspended), prefix |
| `merchant_secrets` | per-merchant secrets (Telegram token etc.), restricted grants |
| `profiles` | user profile + `app_role` + saved delivery address |
| `products` | per-merchant menu items (EN/ZH name + description) |
| `orders` | per-merchant orders |
| `order_counters` | per-merchant daily order counter |
| `vouchers` | per-merchant promotions |
| `settings` | **not per-merchant, and not read by anything** — see below |

A shop's config lives in **columns on `merchants`** (shipping rates and mode, tax, fulfilment methods, currency, timezone, pickup address) and in its `products` rows. There is no per-merchant settings table.

A shop's **menu arrangement** is two stored things: the order of `merchants.product_categories` (array order is display order, ADR 0013) and `products.sort` + `products.category_id`. The merchant sets both by dragging, on the dashboard's **Storefront** section (`merchant/StorefrontArranger.tsx`, spec `docs/superpowers/specs/2026-08-17-storefront-arrangement-design.md`). `sort` is dense and **global per shop**, numbered across the sections in render order, so the storefront's one flat product read returns them ready to group. It is written by `PUT /api/merchants/:id/product-order` and by **nothing else** — deliberately absent from `PRODUCT_FIELDS`, so an ordinary product upsert can never move a product. That endpoint is one `unnest` statement through `db.ts`, whose `merchant_id` predicate is the whole tenancy guard.

`settings` is what the single-tenant app used before the pivot: a global key/value table keyed on `key`, holding one `main` row whose JSON still describes the deleted `src/store.js` — EmailJS template ids, a `sameday` block that became distance pricing, a hardcoded cookie menu. **It has no `merchant_id` column**, nothing in `apps/backend/src` or `apps/frontend/src` reads it, and the browser roles hold no grants on it (`20260718130000_revoke_all_browser_grants.sql`), so its permissive `using (true)` policies are unreachable. Do not write tenant code against it — a `.eq('merchant_id', …)` on this table is an error, not a filter, which is exactly how it sat in `resetMerchant` as a silent no-op.

### Order flow

`Storefront` collects items, delivery mode, voucher → `priceOrder()` for the total → `placeOrder()` → `notifyOrderPlacedRemote()` triggers the backend Telegram send → confirms order number.

`placeOrder()` is **one call to `POST /api/orders`**, which bumps the daily counter, inserts the order and claims the voucher **in a single transaction** (`apps/backend/src/orders.ts`). It commits whole or not at all: a failed voucher claim rolls the order back, and the storefront drops the voucher and asks the customer to retry without it. It used to be three separate browser-to-Postgres calls with the redemption's error swallowed — which handed the customer a discount on a voucher that was never marked used. **The browser holds no `INSERT` on `orders`**; attribution comes from the request's JWT, never from the body (see the `orders_set_user_id` carve-out in `20260714100000_orders_backend_intake.sql`).

The Telegram notify stays a **separate call after the order lands** — folding it into the transaction would let a Telegram outage roll back paid orders.

Order numbers: `<PREFIX>-YYMMDD-XXXX` — six-digit day, and the daily counter starts at **50**, not 1. Prefix = first two alphanumerics of the slug, uppercased (`src/orderPrefix.ts`). Both are customer-visible and pinned by `apps/backend/src/orderNumber.ts`.

### Backend (`apps/backend/src/`)

Hono. `app.ts` defines the routes and **exports the app without serving it**; `index.ts` is the entry that calls `serve()`. That split is what lets `tests/api` drive the real routes in-process via `app.request()` — keep `app.ts` free of I/O at import (it does read `env.ts`, which fails fast on a missing var; that is deliberate and is why the test config stubs the Stripe keys).

`GOOGLE_MAPS_API_KEY` is optional: unset, distance lookups fail closed (a refusal, never a fee) and region-priced shops are unaffected.

Two ways to reach Postgres, and the difference matters:

- **`supabase.ts`** — the REST clients. `admin` (service role, RLS-exempt) and an anon client used only to verify caller JWTs.
- **`db.ts`** — a direct `postgres.js` connection, and the only thing here that can open a **transaction**. `supabase-js` cannot, which is the sole reason the order rules were ever PL/pgSQL: the daily counter needs an atomic upsert and the voucher needs a row lock. Every multi-statement rule goes through `withTransaction()`.

**`db.ts` is RLS-exempt.** It connects as the database owner, so no policy runs on it: on the backend's path, which merchant a row belongs to is a **TypeScript invariant, not a Postgres one**, and any code using it must check tenancy itself. RLS remains in force for the browser's anon/authenticated path and is the backstop — `tests/rls` is the proof it is still shut. Do not read "RLS protects it" as true of anything the backend writes.

Migrating the remaining SQL functions into this layer is #61. Order intake (`orders.ts`), guest tracking (`orderTracking.ts`) and referrals (`referrals.ts`) have moved; `next_order_number`, `redeem_voucher`, `track_order` and `my_referred_shops` are dropped.

The **intake gate** (shop exists and is active; the order is born `status = 'new'`) is enforced in **`orders.ts`, inside the transaction** — not by RLS, which does not run on this connection. The `orders_insert_guest_or_customer` policy is kept as the backstop for a client path that no longer has the grant. Not to be confused with the **Checkout gate** (`CONTEXT.md`), which is the sign-in / guest step in the browser.

### Claude API (`@anthropic-ai/sdk`)

Three features call Claude, and they share one shape. Each lives in its own **pure adapter** whose API key is a **parameter, never read from `env.ts`**, and which imports nothing from `supabase.ts` or `db.ts` — that is what lets `pnpm --filter @bitetime/backend test` drive all three with no env and no Supabase. Each is reached through a mutable deps object on `app.ts` (`releaseDeps`, `menuImportDeps`, `assistantDeps`), the same seam `githubDeps` uses, so an API test drives the real route without a live call.

| Adapter | Model | Does |
|---|---|---|
| `releases.ts` | `claude-haiku-4-5` | Rewrites a GitHub release body into merchant-facing copy. Haiku because it rewrites text that already exists |
| `menuImport.ts` | `claude-sonnet-5` | Reads a menu photograph into **draft** products (vision + structured outputs) |
| `shopAssistant.ts` | `claude-sonnet-5` | Answers a merchant's plain-language question about their own orders (tool runner) |

Both merchant-facing adapters moved off `claude-opus-5` because **a shop pays RM39.90 a month — about USD 8.40 gross** — and on Opus the two features could bill more than that per shop. Sonnet 5 is roughly half the price and gives up nothing either call uses: it is in the **same 2576px high-resolution vision tier** as Opus 5 and supports structured outputs and adaptive thinking identically. Both run `thinking: {type:'adaptive'}` with `output_config.effort: 'medium'` — thinking stays on because reading a crowded menu board and picking a window for a vague question are both judgement, and effort bounds how deep it goes. Output tokens cost 5× input, so that one field is most of the cost model.

Haiku was rejected for menu import specifically: its vision caps at **1568px against Sonnet 5's 2576px**, and the input is a phone photograph of a crowded menu board — the exact case resolution decides. A misread price reaches the merchant as a plausible number, not an error.

`ANTHROPIC_API_KEY` is **optional**, same posture as `GOOGLE_MAPS_API_KEY` — but what an unset key *means* differs per feature, and that difference is the point. A release without a summary is cosmetic, so `releases.ts` stores a `humanize_error` and the pull still succeeds. The other two **refuse**: `503` for an unset key, `502` when the model could not answer. Neither may return an empty result, because "your menu has no items" and "we could not read your menu" look identical on screen and only one of them is true.

Both merchant-facing features are bounded **twice**, and the two bounds guard different things. Every figure lives in `quotaWindows.ts`, for the same reason the Google windows do: one Claude bill for one shop.

- The **daily** bound (`menuImportMerchantWindow` 20, `assistantMerchantWindow` 50) is the burst stop — an in-memory sliding window, free, and cleared by a redeploy, which over a day does not matter.
- The **persisted** bound is the bill stop, and it is a **row in Postgres** (`ai_usage`, one per shop per feature per bucket) precisely because a redeploy must not clear it: a month-long ceiling held in memory is really a ceiling on however long it has been since the last deploy. It is also what catches the loop that sits just under the daily figure, and the only limiter here that survives a second backend instance (#101). Split `aiUsage.ts` (pure: which bucket, when it resets) / `aiUsageDb.ts` (the counter), so the pure half stays reachable from `pnpm test`.

Menu import has **two** persisted buckets, and the reason is that it is a setup feature wearing a subscription's clothes. `MENU_IMPORT_LIFETIME_LIMIT` (30) is a once-ever grant covering the first photographing of a menu — fifteen or twenty pages, re-shot when one comes out blurry — and `MENU_IMPORT_MONTHLY_LIMIT` (5) is what a shop needs afterwards. A single monthly figure has to be either too small for that first week or, renewed twelve times a year, far more than the job ever needs. `spendAiAllowance` spends the grant **first**; only once it is gone does the month start counting. The assistant has no grant (`ASSISTANT_MONTHLY_LIMIT` 60) because asking questions is the ongoing use, not a burst.

The grant is also the only thing that sees the **trial exposure**: the trial is 7 days and cardless, the shop is `active` throughout, and photographing a menu is exactly what a merchant does on day one — so that spend lands before the platform has been paid anything, and no monthly ceiling notices, because it all happens inside one month.

The month is the **shop's** calendar month (`usagePeriod` reads `merchants.timezone`), so a merchant gets their allowance back at their own midnight on the 1st; the grant's bucket is the literal `'lifetime'`, which the table's own check constraint allows alongside `YYYY-MM`. The refusal always quotes the **monthly** figure and its reset date (`monthly_limit_reached`, `limit`, `resets`), never the grant's — a merchant whose setup allowance is gone must not be told to wait for it to come back, because it never does. The two dialogs word it differently from `daily_limit_reached`: "come back tomorrow" and "come back next month" are not the same news.

All three figures are guesses, and `ai_usage` is what replaces them — it records calls per shop per feature per month, so after a month of real merchants they can be set from evidence.

Order of checks, and each position is load-bearing: **key → daily → monthly → model**. The key check runs before both ceilings, so an unconfigured platform never spends a merchant's allowance to answer 503; the daily window runs before the monthly counter, so a call the burst stop already refused costs no allowance, having spent no money. The monthly unit is spent *before* the model call, so a 502 still costs one — the correct side to err on, since the request reached Anthropic. There is no refund path.

`consumeAiCall` is **one statement** (a conflicting insert whose `do update` carries the `where`), not a read then a write: unlike the single-process daily window, a database counter can be raced by two concurrent requests, and Postgres holding the row lock for the decision is what closes that.

**Neither call may pass `fallbacks`, and that is a hard constraint, not a preference.** Both adapters used to send `fallbacks: 'default'` on Opus 5, so a safety-classifier decline was re-run on another model inside the same request. **Sonnet 5 rejects the parameter outright** — `'claude-sonnet-5' does not support the `fallbacks` parameter`, HTTP 400 — and `/v1/models` reports its `allowed_fallback_models` as an empty list (Opus 5's is `['claude-opus-4-8']`). So reinstating it does not soften a failure mode, it breaks **every** request to that feature. `tests/unit/menuImport.test.ts` and `tests/unit/shopAssistant.test.ts` each assert the parameter is absent, because every other test in those files stubs a success and would not notice.

The cost of that: a decline now reaches the merchant as a 502 (`could_not_read_menu` / `could_not_answer`). Judged acceptable — a photograph of food and a question about one's own order counts are unlikely things to be declined over, and the failure is a refusal rather than a wrong price. `console.error('… was refused')` in either adapter is the signal that the judgement was wrong and the model choice has to change.

**The assistant's tenancy rule is structural, and must stay that way.** Its single tool takes a window and a bucket size — no merchant id, shop id or slug — and the handler closes over the merchant row `requireMerchantOwns` already authorised. A question about another shop is not refused, it is *unsayable*. This matters because `db.ts` is RLS-exempt: on the backend's path tenancy is a TypeScript invariant, and a tool that accepted a merchant id would leave that invariant one prompt away from being wrong. There is no SQL tool, no table name and no free-form filter. `tests/unit/shopAssistant.test.ts` asserts no tool parameter matches `/merchant|shop|tenant|slug|id/i`; `tests/api/ask.test.ts` seeds a stranger's orders and proves the bound handler still returns zeroes.

Menu import writes **nothing**. It returns drafts; the merchant saves them through the ordinary product upsert, under every rule that already applies there. Two fields it deliberately does not read: `descr_zh` (excluded from the product write allowlist, and the form has no input for it) and any `unit` outside the product form's own list.

Adding a Claude call means adding an adapter, not a call site inside a route — and remember `@anthropic-ai/sdk` already carries its `--external:` flag in the esbuild command.

### Support chat

The dashboard's **Help** bubble (`merchant/SupportFab.tsx`) answers from a fixed bilingual FAQ (`merchant/supportFaq.ts`), then lets the merchant talk to the superadmin through **Telegram**. Each shop gets one **forum topic** in the `PLATFORM_SUPPORT_CHAT_ID` supergroup, created on its first message; the superadmin replies in that topic and `POST /api/telegram/support-webhook` stores the reply. The browser **polls** (5 s open, 60 s closed, none while the tab is hidden) — there is no Realtime, because `src/supabase.ts` deliberately ships without `realtime-js`. The bubble replaced `FeedbackFab`; the feedback form lives on as one of its views (`FeedbackForm.tsx`). It is mounted on `Dashboard`, `PendingScreen` and `SuspendedScreen` — a suspended merchant is the one who most needs to ask. Spec: `docs/superpowers/specs/2026-10-02-support-chat-design.md`.

Split: `supportChat.ts` (pure — texts, update parser, secret compare), `supportTelegram.ts` (Bot API adapter, **no `parse_mode` ever**: the text is a merchant's free text), `supportChatDb.ts` (SQL), `supportDelivery.ts` (claim topic → header → text → photos, one retry when Telegram reports the topic deleted). `supportDeps` on `app.ts` is the test seam.

Rules that are easy to break:

- **The webhook's status code is for Telegram, not a person.** Any non-2xx makes Telegram send the update again. An ignored update gets `200`; only a failed database read or write gets `500`, and the partial unique index on `tg_message_id` makes that retry safe.
- **A superadmin passes `requireMerchantOwns`**, so the routes check `merchant.owner_id === user.id` themselves: a superadmin cannot post as the merchant, cannot mark replies read, and their GET does not count as the merchant being "seen" (that would stop the away email). The bubble is hidden by `role`, not by `merchant`, because "view as shop" sets `merchant`.
- **The poll cursor is a message id, not a timestamp.** A JS `Date` keeps milliseconds and Postgres keeps microseconds; a timestamp round-tripped through the browser returns the last message again.
- **A hidden tab does not poll**, so the backend sees that merchant as away and sends the away email. That is the design, and it is also why an automated browser tab (which reports `document.hidden`) never shows replies until it is made visible.
- **"Done" is Telegram's own Close topic.** The webhook stores `support_threads.resolved_at` from the `forum_topic_closed` / `forum_topic_reopened` service messages, and a merchant writing again clears it and calls `reopenForumTopic`. There is no resolve button and no command.
- **Local work needs a separate dev bot.** Telegram refuses `getUpdates` on a bot with a webhook. `telegram:webhook poll` forwards updates to the local backend and refuses to run on a bot that has one, because deleting the production webhook would silently stop every merchant's replies.
- **Feedback submitted locally files a real GitHub issue** when `GITHUB_TOKEN` is set in `apps/backend/.env`. Start the backend with `GITHUB_TOKEN=` on the command line to test the form.

### Customer payments (HitPay DuitNow QR)

A shop can connect its **own** HitPay account (Settings → Payment). The customer then pays each order with a DuitNow QR for the exact total, and the order moves from `pending_payment` to `new` by itself. TinyOrder never holds money: the key is the merchant's, the money settles to the merchant, and Stripe stays subscription-only. Spec: `docs/superpowers/specs/2026-10-02-hitpay-duitnow-qr-design.md`.

Split: `hitpay.ts` (adapter, key as a parameter), `hitpayPayment.ts` (pure rules), `hitpayPaymentDb.ts` (SQL), `hitpayConfirm.ts` (the one confirmation function). `hitpayDeps` and `hitpayAlertDeps` on `app.ts` are the test seams.

Rules that are easy to break:

- **The webhook body is never trusted.** HitPay's API-registered webhooks carry no salt we can read, so the body is a hint: the backend reads `payment_request_id`, then asks `GET /v1/payment-requests/{id}` with the key of the shop that owns the row. Do not "optimise" this by reading `status` from the body.
- **No route returns the key.** The browser gets `keyLast4`. `GET /api/merchants/:id/secret` returns only the Telegram columns.
- **One live QR for each order** is a partial unique index (`order_payments_one_pending`), and a QR whose time ran out is checked with HitPay before a new one is made — a customer who paid at 14:59 must not get a second QR that can take a second payment.
- **The merchant alert waits for the payment.** `/api/notify/order` skips the merchant arms for a connected shop's unpaid order; `hitpayAlertDeps.alert` sends them after the commit, with a banner. The email's `merchant_emailed_at` claim makes a repeated confirmation send one email. When the QR route cannot give the customer a QR (502, 503, or the shop disconnected), it releases the held alert once, with a warning; `orders.hitpay_fallback_alerted_at` is that once.
- **Only the shop owner connects or disconnects HitPay.** A superadmin passes `requireMerchantOwns` ("view as shop"), so the routes check `owner_id` themselves and answer `403 owner_only`, as the support chat does.
- **The webhook answers 200 for every ignored signal.** Only a database failure answers 500.
- **Local work needs the sandbox.** Set `HITPAY_API_BASE=https://api.sandbox.hit-pay.com/v1` and `BACKEND_PUBLIC_URL` to a public HTTPS tunnel to `:8787` — HitPay rejects localhost. Without a tunnel the browser poll still confirms payments; only the webhook path is missing.

### Shipping / pricing

All order totals come from one pure module, `packages/shared/src/pricing.ts` — `priceOrder()` (shipping region, promo, voucher, tax, rounding) and `voucherError()`. It lives in `@bitetime/shared` because it runs on **both** sides of the wire: the browser prices to quote, the backend prices to commit, and the backend refuses a quote it disagrees with (`price_changed`). The row → domain mappers (`shopRates`, `shopTax`, `productFromRow`, `voucherFromRow`) are shared for the same reason — mapping one side and not the other is a refused checkout, not a rounding gap. There is no order-level referral discount; it was removed in #70. Shipping rates are per-merchant: `WM` (West Malaysia) and `EM` (East Malaysia), with `EM_STATES` selecting the region; a storefront that collects no state passes `resolvedShipping` (flat fee). See `CONTEXT.md → Order pricing`.

A shop's **shipping policy** is `merchants.shipping_mode` (`region` | `distance`). Distance pricing is `base + rate × routed km`, with the km rounded to one decimal **before** the rate multiplies it; the road distance comes from `distance_quotes`, a 30-day cache keyed by `(origin place id, destination place id)` that the quote endpoint and order intake share — both read it first and write it on a miss. The routing call happens **outside** the order transaction. See `CONTEXT.md → Shipping policy` and `docs/adr/0001-distance-fees-from-a-cached-google-route.md`.

### Localisation

No i18n library. Every string is passed as `t(englishString, chineseString)` where `t = (en, zh) => lang === 'zh' ? zh : en`. `t` and the `lang` (`'en'` | `'zh'`) state live in `SessionContext`.

### Per-shop brand colour

A shop's accent is `merchants.brand_color` (a hex, null for the platform oxblood). One pure module,
`src/brandTheme.ts`, derives nine values from it — the whole `--brand-*` ramp plus the fill, its
hover, the text ON a fill and the accent AS text — walking lightness in HSL until each clears AA.
The three pale washes are then **warmed toward the cream page** in OKLab (`src/oklab.ts`), because
they measure toward WHITE and the page is not white: a blue wash bled to white lands on a warm page
as a second, colder ground. **The pull is capped at half the tint's own chroma**, and that cap is
the whole design — an uncapped pull moves a blue tint straight through neutral, since cream is the
far end of the a/b plane from blue, and it hands a grey-picking shop beige washes. `--brand-400` is
excluded: it is the dark-theme accent, not a wash. See ADR 0021.
`src/brandTheme.test.ts` sweeps ~8,400 colours to prove no choice can be illegible, sweeps the cap
itself, and pins `#7A1028` to the ramp `tokens.css` already ships — which means **`tokens.css`
follows this module**: changing the derivation moves `--brand-50/100/200`, and those literals move
with it or the pin fails. `normalizeBrandColor` in `@bitetime/shared` is the
one rule for which strings are colours; the picker and `pickMerchantConfig` both run it.

`components/BrandTheme.tsx` applies it, and **it must restate every token that carries the accent,
not just `--color-accent`**: `index.css` declares `--primary: var(--color-accent)` on `:root`, and
`var()` substitutes where the declaration lives, so a descendant override of `--color-accent` leaves
`--primary`, `--ring` and `--focus-ring` oxblood. The ramp is set as **`--brand-*` primitives, not
the `--color-brand-*` bridge**: both `@theme` blocks are `inline`, so `bg-brand-600` compiles to
`var(--brand-600)` and the bridge is never read at runtime.

`--primary` backs both `bg-primary` and `text-primary`, which the fill and text roles cannot share,
so `[data-brand] .text-primary` in `index.css` redefines the text role inside a branded subtree
only. `src/brandScope.test.ts` pins what makes that sound: no element carries both classes, none
pairs `bg-primary` with `text-background` (a fill labelled with the page colour — the bug that made
the computed on-fill colour unreachable), nothing reaches the accent through an arbitrary
`[var(--…)]`, and the override set still covers the stylesheets' accent closure.

Mounted in exactly two places — `StorefrontShell` in `AppRouter.tsx` and `Dashboard.tsx`. Marketing,
`/admin` and the auth screens stay platform-coloured because no wrapper is above them. The invoice
page and the invoice PDF are deliberately out of scope.

### Deployment

Deployed via Vercel; set the project **Root Directory** to `apps/frontend`. `pnpm deploy` runs the frontend `vite build`. Vite `base` is `/`.

`apps/frontend/vercel.json` — the project's Root Directory, so the repo root is **not** where a `vercel.json` is read from — carries a `headers` rule that JSON has no comments to explain: everything under `/assets` is content-hashed by Vite, so a changed file is a changed URL and `max-age=31536000, immutable` can never serve a stale one. Without it the deployment hands out `max-age=0, must-revalidate` for every hashed chunk — a conditional request per file per visit, which on a phone is a round trip each for the CSS, the entry chunk and every route chunk already sitting in the cache. **The HTML is deliberately not in that rule**: it is the file that names the hashes, and it has to revalidate for a deploy to reach anyone.

**The Latin webfont is self-hosted.** Poppins 400/500/600, latin and latin-ext, ships as six `.woff2` in `apps/frontend/public/fonts/`, declared by `@font-face` in `src/index.css` and preloaded (latin 400 + 500 only) from `index.html`. There is no `fonts.googleapis.com` stylesheet: it was render-blocking on a cold third-party origin and cost **793ms of a 2.75s mobile FCP for 1KB of CSS**, with the `.woff2` on `fonts.gstatic.com` — a second cold origin — one trip further down. Both are off the critical path now. The preload is the other half: a font named only inside a stylesheet is not requested until that stylesheet has downloaded, parsed and matched real text, so the CSS and its font are two serial trips; `<link rel="preload" as="font" crossorigin>` is found by the preload scanner in the first bytes of the document instead. Measured at −150ms FCP and CLS 0.0001 → 0 versus no preload. `crossorigin` is **required even same-origin** (fonts are fetched in CORS mode; without it the preload is a second uncredited request). Since `public/` is copied verbatim, the files carry no content hash — hence the `/fonts/(.*)` immutable rule in `vercel.json`, and hence **replacing a face means giving it a new file name**. `src/fonts.test.ts` pins the CSS ↔ HTML ↔ files join; a missing `.woff2` otherwise degrades in total silence, because the metric-matched `'Poppins Fallback'` next in the stack is built to occupy the same space. Chinese is unaffected and stays on Google: `src/cjkFont.ts` injects that stylesheet at runtime, only once the visitor is actually reading Chinese.

**The landing page's three "How it works" clips are self-hosted under the same convention.** `apps/frontend/public/images/steps/` holds twelve files — per step per language, a 960x720 `.mp4` (60–190KB) and its **first frame** as a `.webp` poster (18–27KB). `marketing/steps.ts` lists them; `Landing.tsx` joins `file`, the showing language and the extension; `LandingMotion.tsx`'s `StepClip` renders them. They are recorded against a **running local stack** with Playwright (already a backend devDependency), one frame per interaction beat rather than `recordVideo`, so each clip is exactly the beats wanted; nothing in the repo re-records them, so a clip stays whatever it was on the day it was taken — the same trap the `/sample-shops` carousel fell into. `public/` is copied verbatim, so they carry no content hash and `vercel.json` freezes `/images/(.*)` immutable: **re-recording a step means giving it a new file name.** `src/marketing/steps.test.ts` pins the array ↔ files join, because a missing file otherwise degrades in near silence — the row keeps its reserved box and shows nothing.

Three rules hold `StepClip` together and none is cosmetic. **Not a GIF**: the same four seconds is 3–8MB of 8-bit palette, and thin anti-aliased UI text is what GIF is worst at. **No `autoplay` attribute** — an IntersectionObserver starts playback, so with `preload="none"` nothing but the poster is fetched until the clip is on screen; the alternative pulls ~390KB before the reader has scrolled to it and keeps three video decoders alive for the whole visit. **The poster is frame zero**, so starting playback is not a cut, and it is the entire picture for everyone the video never reaches: `prefers-reduced-motion` (where the `.mp4` is never even requested — `videoWidth` stays 0), a blocked autoplay on iOS low-power mode, JavaScript off, and the crawler reading the prerendered markup. That is why the poster sits in the markup instead of being attached in the effect. `muted` is likewise assigned on the element in the effect, not left to the prop: React does not reliably render that attribute into server markup, and an unmuted video is refused autoplay outright.

The same rule holds for `@import url(…)` inside `src/index.css` — never do it. Inside the stylesheet a request is invisible to the preload scanner and is made only after the whole CSS bundle has downloaded and parsed, which is how two cold origins end up in series behind a render-blocking resource.

Inlining the CSS into the prerendered HTML was tried and is **worse** — FCP 2452ms → 2605ms. The bytes do not leave the critical path, they join the document that is already on it, and the round trip saved costs less than the larger document.

The build emits **one HTML file per prerendered route plus a shell, and which one serves a route matters**. `vite build` produces the usual empty SPA shell, then `scripts/prerender.tsx` (an SSR build, run by the same `build` script) renders each route in its `ROUTES` list to static markup: `/` is written over `dist/index.html`, `/pricing` becomes `dist/pricing.html`, and the untouched shell is kept as `dist/app.html`. The list is **every URL in `public/sitemap.xml`**. Four are marketing pages; `/sample-shops`, `/terms`, `/privacy`, `/merchant/signup` and `/merchant/login` are prerendered for a narrower reason: served the shell, a crawled sitemap URL gets the HOMEPAGE's title and description and no canonical at all. `/sample-shops` bakes only its chrome — its shop list is read from the database in an effect, and a build must not read the database, or a build that cannot reach it ships a page saying there are no shops. `vercel.json` rewrites everything to **`/app.html`**, not `index.html`. Point that rewrite back at `index.html` and every storefront starts life with the marketing page's markup inside it.

**Each prerendered route needs its own rewrite above that catch-all.** Vercel checks the filesystem before rewrites, but it does **not** try `<path>.html` for an extensionless request unless `cleanUrls` is on — so `/pricing` never finds `pricing.html` by itself and the catch-all serves it the empty shell. `/` is the one exception, resolving to `index.html` as the directory index, which is exactly what makes this easy to get wrong. The failure hides itself: the route still works in a browser because React boots and renders it client-side, and only the served bytes differ — which is all a JS-less crawler ever sees. It shipped once and was caught on a preview deploy (#169); `src/vercelRewrites.test.ts` now fails the build instead.

Adding an indexed page therefore means adding it in **six** places: a `<Route>` in `AppRouter.tsx`, an entry in the prerender `ROUTES` list, a title/description in `src/routeMeta.ts`, a rewrite in `apps/frontend/vercel.json`, a `<url>` in `public/sitemap.xml` and a link in `public/llms.txt`. Miss the prerender list and the page reaches a JS-less crawler as a blank document; miss `routeMeta.ts`, the rewrite or the llms.txt link and a test fails.

The prerender exists because most LLM crawlers do not execute JavaScript; Google does, so this is a GEO fix, not a ranking one. It runs offline — `renderToStaticMarkup` never fires effects, so no provider reaches Supabase or the billing backend — and it throws if `<div id="root"></div>` is missing from the built HTML rather than silently shipping a blank page.

Head tags follow the same split. Anything true of **every** route is static in `index.html` (the og: tags, the Organization/WebSite/SoftwareApplication identity JSON-LD). Anything true of **one** route is per-route — the canonical URL and `og:url` are baked in by the prerender and the canonical is then adopted at runtime by `src/canonical.ts`; the `<title>` and `<meta name="description">` come from `src/routeMeta.ts`, baked by the prerender and rewritten on client-side navigation by `src/documentMeta.ts`. `routeMeta.ts`'s `/` entry must stay character-identical to `index.html`'s own tags — that file is the fallback for every route without an entry, and `routeMeta.test.ts` is what pins them together.

The `FAQPage` JSON-LD lives on **`/faq` and each `/for/<slug>`**, never on `/` and never in `index.html` (`src/marketing/structuredData.ts`). A static block would claim that every storefront and every legal page is that FAQ. Each page bakes its own via the prerender's `head` field and then **adopts** the baked block at runtime rather than appending a second — `useFaqStructuredData` / `useUseCaseStructuredData` rewrite it in place, which is what lets a Chinese reader get Chinese markup instead of a page whose visible text and structured data disagree. Every `/for/<slug>` carries its own `@id`, so the four are four pages to a crawler and not one duplicated.

`index.html`'s static title and description are therefore the site's ONE default. Multiple pages with their own titles is what makes Google's **sitelinks** possible at all (#169) — a sitelink's label is the target page's `<title>` and its snippet is that page's meta description. Sitelinks stay algorithmic: no markup requests them, `SiteNavigationElement` is not used by Google, and they also need the site to rank first for its brand query.

### Releases

**Every push to `main` cuts a release** — `.github/workflows/release.yml`, so in practice every
dev → main merge. It works out the version, creates the tag and the GitHub release with
`--generate-notes`, then calls the backend so the release lands in the app as a draft. Nothing
about it publishes: a superadmin still reads the Claude-written copy in `/admin` and presses
Publish before merchants see it. The old `release: vX.Y.Z` pull request title is dead — the
version is no longer something a human types.

The version rule is `apps/backend/src/releaseVersion.ts` (pure, unit-tested): any `feat` in the
range bumps the minor, a `!` or a `BREAKING CHANGE:` footer bumps the major, anything else bumps
the patch. Only the commit SUBJECT decides `feat` versus `fix`, so a body that quotes another
commit cannot move the version; merge commits are excluded, because their subject describes
nothing and every commit they bring in is already in the range. Tags carry **no `v` prefix**, and
the rule reads the two-part `0.2` as `0.2.0`. `pnpm --filter @bitetime/backend release:version`
prints what the next tag would be, and nothing else — run it before a merge to see it.

The pull **names the tag it just cut**, and that is load-bearing: GitHub serves the release
LIST with `Cache-Control: max-age=60`, and the workflow calls about two seconds later — so a
list read there regularly predates the release, and the pull answered `{"pulled":0}` with a
green tick while storing nothing. Five releases shipped that way. `POST` with `{"tag":"X"}`
reads `releases/tags/X`, a key nothing has asked for before, and a tag GitHub cannot show yet
is a 502 the workflow's retry loop waits out. The list is still read alongside it, so a release
an earlier pull missed is carried in by the next one.

The workflow needs **`RELEASE_PULL_SECRET`** as a repo secret AND as the backend's own env var
(`BACKEND_URL` it reuses from the screenshot sweep). It gates
`POST /api/internal/releases-pull`, which is the same `pullReleases()` the superadmin button
calls — one function, so an automatic pull and a hand pull cannot drift apart. `requireSuperadmin`
could not serve this caller: that guard wants a GoTrue access token, and an access token expires,
so there is nothing to put in a repo secret that still works next month. Unset, the endpoint fails
closed with a 503 and the recovery is a superadmin pressing Pull — the tag and the GitHub release
exist either way.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues (`leongcheefai/Bitetime-Order-Platform`), via the `gh` CLI. External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
