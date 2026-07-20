# Merchant feedback — design

Issue: [#89](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/89) — *feat: feedback form for merchant*

## Goal

Let a merchant send feedback about the BiteTime platform from inside their dashboard, and let a superadmin read and triage it.

This is feedback **from** merchants **about the platform** — not customer reviews of a shop.

## Decisions

| Question | Choice | Why |
|---|---|---|
| Destination | Postgres table + superadmin view | Durable and queryable; no external dependency to keep alive. |
| Fields | Category + message | Enough to triage. A rating adds a number nobody can act on at this volume. |
| Merchant entry point | Floating action button, bottom-right | Discoverable from every dashboard tab and needs no change to `DashboardShell`, which `/admin` also renders. |
| Admin triage | List + open/resolved toggle | Works as an inbox without becoming a ticket system. |

`DashboardShell` has no desktop header — only a mobile top bar (`components/DashboardShell.tsx:48`) — so a header button was not available. The FAB is rendered by `Dashboard.tsx`, leaving the shared shell untouched.

## Data

One migration: `merchant_feedback`.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key, `gen_random_uuid()` |
| `merchant_id` | `uuid` | → `merchants(id)` `on delete cascade` |
| `user_id` | `uuid` | → `auth.users(id)`; who submitted |
| `category` | `text` | check: `bug` \| `feature` \| `billing` \| `other` |
| `message` | `text` | check: length 1–2000 after trim |
| `status` | `text` | default `open`; check: `open` \| `resolved` |
| `created_at` | `timestamptz` | default `now()` |
| `resolved_at` | `timestamptz` | null until resolved |

Index on `(status, created_at desc)` — the admin list's only sort.

RLS enabled with **no browser grants**, following `20260718130000_revoke_all_browser_grants.sql`. The browser never touches this table; every read and write goes through the backend. RLS is the backstop, not the gate.

Run `pnpm --filter @bitetime/backend db:migrate` after adding the file — writing the migration does not apply it, and PostgREST's schema cache will not see the table until it runs.

## Backend

New `apps/backend/src/feedback.ts`. Every write here is a single statement, so it uses the service-role `admin` client; `db.ts` and `withTransaction()` are not needed.

`admin` is RLS-exempt, so the middleware **is** the tenant boundary — nothing downstream re-checks (CLAUDE.md → Backend).

### `POST /api/merchants/:id/feedback` — `requireMerchantOwns`

- Body passes through a `pickFeedback()` allowlist in `writes.ts`: `category` and `message` only.
- `merchant_id` comes from the route param the middleware already verified; `user_id` from the caller's JWT; `status` is forced to `open`. None of the three is ever read from the body.
- Validation lives in a pure `validateFeedback(body)` returning `{ ok, error }`, so it unit-tests with no Supabase running.
- Rate limited through the existing `rateLimit.ts`: 20 submissions per hour per user (raised from an initial 5 — the API suite files 7 rows under a single owner, and 5 would have 429'd two unrelated tests).
- Returns `201` with the created row, or `400` with the validation error.

### `GET /api/admin/feedback` — `requireSuperadmin`

Returns rows newest-first with the shop's `name` and `slug` joined in. Optional `?status=open` filter.

### `PATCH /api/admin/feedback/:feedbackId` — `requireSuperadmin`

Body `{ status }`, checked against `open` | `resolved`. Sets `resolved_at` to `now()` on resolve and back to `null` on reopen.

## Frontend — merchant

New `merchant/FeedbackFab.tsx`:

- Fixed bottom-right button (`MessageSquarePlus`), clear of the mobile content padding. `z-30` — below the mobile drawer's backdrop (`z-40`) and the drawer itself (`z-50`), so it does not bleed through an open menu. The modal it opens sits above both.
- Opens a modal: category select, textarea with a character counter, submit.
- On success the modal shows a thank-you state, then closes itself.
- Submit failures show the server's error inline and keep the typed message.

Rendered by `Dashboard.tsx` next to `BillingBanner`. `DashboardShell` and `/admin` are not modified.

`store.ts` gains `submitFeedback(merchantId, { category, message })`.

## Frontend — admin

New `admin/AdminFeedback.tsx`, added to `AdminHome`'s `SECTIONS` as `feedback`.

Newest-first cards, each showing shop name and slug, a category badge, the submission date, the message, and a single Resolve / Reopen button. A filter switches between open-only and all.

`store.ts` gains `fetchAdminFeedback(status?)` and `setFeedbackStatus(id, status)`.

Every string is passed as `t(english, chinese)`.

## Tests

**Unit** (`apps/backend/tests/unit/`, no Supabase) — `validateFeedback`: unknown category, empty message, whitespace-only message, 2001 characters, valid input.

**API** (`apps/backend/tests/api/feedback.test.ts`, needs local Supabase) — a merchant submits to their own shop and the row lands with the right `merchant_id` and `user_id`; a merchant submitting to another merchant's shop gets `403`; a body carrying `status: 'resolved'` or a foreign `user_id` is ignored; a superadmin lists and toggles; a merchant hitting either admin route gets `403`.

Never mock the database in the API suite.

**UI** — run-and-verify per CLAUDE.md. No component tests.

## Out of scope

Merchants viewing their own past submissions. Replies or any email loop back to the merchant. Attachments and screenshots. Star ratings. Each is additive later and none is needed to start reading what merchants say.
