# Support Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat bubble on the merchant dashboard answers from a fixed FAQ, then sends the merchant's question to a Telegram forum topic for the shop, and shows the superadmin's Telegram reply in the chat.

**Architecture:** Two new tables (`support_threads`, `support_messages`) and a private bucket hold the chat. The backend sends merchant messages to Telegram through a small Bot API adapter, and receives replies through a secret-guarded webhook. The browser polls one GET route. `SupportFab` replaces `FeedbackFab` and opens a panel with the FAQ, the chat and the existing feedback form.

**Tech Stack:** Hono, postgres.js (`db.ts`), Supabase (REST `admin` client, Storage), Telegram Bot API over `fetch`, Resend (`email.ts`), React 19 + Vite, Vitest, `@bitetime/shared`.

**Spec:** `docs/superpowers/specs/2026-10-02-support-chat-design.md`

## Global Constraints

- The merchant id always comes from `requireMerchantOwns`, never from a request body. `admin` and `db.ts` are RLS-exempt; the route guard is the tenant boundary.
- Message text: 1 to 2000 characters after trim (`SUPPORT_MAX_LENGTH = 2000`). The database CHECK is the authority; the shared validator tells the merchant first.
- Images: at most 3 for each message, JPEG / PNG / WebP, at most 5 MiB each. Reuse `validateFeedbackImages` and `FEEDBACK_MAX_IMAGES` from `@bitetime/shared`.
- Merchant text goes to Telegram with **no `parse_mode`**.
- The browser roles (`anon`, `authenticated`) hold **no grants** on `support_threads` or `support_messages`. The bucket `support-images` is private with **no** `storage.objects` policies.
- Away email: only when `merchant_last_seen_at` is older than **2 minutes**, and at most **one per hour** for each shop. The email holds no reply text.
- Poll intervals: **5 s** while the panel is open, **60 s** while it is closed, **no poll** while `document.hidden`.
- Sliding window on `POST …/support/messages`: **30 per hour per user**.
- `PLATFORM_SUPPORT_CHAT_ID` and `PLATFORM_TG_WEBHOOK_SECRET` are optional in `env.ts`. The bot token is the existing `PLATFORM_TG_TOKEN`.
- A superadmin never sees the bubble, gets `403` on `POST …/support/messages` and `POST …/support/read`, and a superadmin GET does not write `merchant_last_seen_at`.
- Every UI string uses `t(en, zh)`.
- Never run `db:push` or any `supabase` command that reaches production. Apply the migration locally with `db:migrate` only.
- The topic header carries the shop link, status and owner email. It carries **no plan line**: the platform has one plan (CLAUDE.md → "there is one plan"), so the spec's "plan" field has no data behind it.

### Two refinements of the spec

1. **Webhook status on an internal failure.** The spec says the webhook answers `200` for every update with a valid secret. This plan answers `200` for every *ignored* update, but `500` when the database write itself throws. Telegram then sends the update again, and the unique `tg_message_id` index makes the retry safe. A `200` there would lose the superadmin's reply for good.
2. **Poll cursor.** The cursor is the **id** of the last message the browser holds. The SQL compares `(created_at, id)` against that row's own values. A JavaScript `Date` keeps milliseconds and Postgres keeps microseconds, so a timestamp cursor sent through the browser would return the last message again.

## Review Focus

1. **A topic deleted by hand in Telegram.** The merchant's next message must still reach the superadmin in a new topic. Pinned in Task 5 ("recreates a topic deleted by hand").
2. **Telegram sends the same reply update twice** (a retry after a slow `200`, or after the `500` above). The merchant must see one reply, not two. Pinned in Task 6 ("stores a repeated update once").
3. **A superadmin in "view as shop" mode.** `merchant` is set in `SessionContext`, so a check on `merchant` alone shows the bubble to the superadmin. The bubble must stay hidden, and the superadmin's GET must not stop the away email. Pinned in Task 5 ("a superadmin read does not mark the merchant seen") and Task 11 (`role === 'superadmin'` check).
4. **Free text with Markdown characters, emoji and Chinese.** `Joe *Star* 🍰 蛋糕` must reach Telegram exactly as typed, not as a 400. Pinned in Task 4 ("sends text without parse_mode").
5. **The merchant's own message and a reply land between two polls.** The chat must show each message once, in time order, and must not skip the reply. Pinned in Task 5 ("the cursor returns only later messages") and Task 10 (`mergeMessages` tests).

---

## File Structure

| File | Create / Modify | Responsibility |
|---|---|---|
| `packages/shared/src/support.ts` | Create | `SUPPORT_MAX_LENGTH`, `validateSupportMessage`, the wire types `SupportMessage`, `SupportFeed`, `SupportSendResult`. |
| `packages/shared/src/support.test.ts` | Create | Validator tests. |
| `packages/shared/src/index.ts` | Modify | Export the new module. |
| `apps/backend/supabase/migrations/20261002120000_support_chat.sql` | Create | Two tables, indexes, grants, the private bucket. |
| `apps/backend/tests/rls/support-chat-grant.test.ts` | Create | Browser roles cannot read either table or the bucket. |
| `apps/backend/src/supportChat.ts` | Create | Pure: Telegram texts, update parser, reply clamp, secret compare, away-email copy, poll-mode guard. |
| `apps/backend/tests/unit/supportChat.test.ts` | Create | Unit tests for the pure module. |
| `apps/backend/src/supportTelegram.ts` | Create | Bot API adapter: `createTopic`, `sendText`, `sendPhoto`, `TelegramThreadGone`. |
| `apps/backend/tests/unit/supportTelegram.test.ts` | Create | Adapter tests with a fake `fetch`. |
| `apps/backend/src/supportChatDb.ts` | Create | The SQL for both tables. |
| `apps/backend/src/supportDelivery.ts` | Create | Merchant → Telegram orchestration (claim topic, header, text, photos, one retry). |
| `apps/backend/src/env.ts` | Modify | Two optional variables. |
| `apps/backend/src/app.ts` | Modify | `supportDeps`, `supportWindow`, five routes. |
| `apps/backend/tests/api/support-chat.test.ts` | Create | Merchant routes against real Postgres. |
| `apps/backend/tests/api/support-webhook.test.ts` | Create | Webhook and away email against real Postgres. |
| `apps/backend/scripts/telegramWebhook.ts` | Create | `set`, `info`, `poll` commands. |
| `apps/backend/package.json` | Modify | `telegram:webhook` script. |
| `apps/backend/.env.example` | Modify | Document the two variables. |
| `apps/frontend/src/store.ts` | Modify | `listSupportMessages`, `sendSupportMessage`, `markSupportRead`, `fetchSupportImage`. |
| `apps/frontend/src/merchant/supportFaq.ts` | Create | Bilingual FAQ data. |
| `apps/frontend/src/merchant/supportFaq.test.ts` | Create | Data shape tests. |
| `apps/frontend/src/merchant/supportFeed.ts` | Create | Pure: `pollDelay`, `mergeMessages`. |
| `apps/frontend/src/merchant/supportFeed.test.ts` | Create | Tests for both. |
| `apps/frontend/src/merchant/useSupportFeed.ts` | Create | The hook: poll, outbox, send, retry, mark read. |
| `apps/frontend/src/merchant/FeedbackForm.tsx` | Create | The form body moved out of `FeedbackFab.tsx`. |
| `apps/frontend/src/merchant/SupportChat.tsx` | Create | The chat view. |
| `apps/frontend/src/merchant/SupportPanel.tsx` | Create | The panel and its views. |
| `apps/frontend/src/merchant/SupportFab.tsx` | Create | The bubble and red dot. |
| `apps/frontend/src/merchant/FeedbackFab.tsx` | Delete | Replaced. |
| `apps/frontend/src/merchant/Dashboard.tsx` | Modify | Mount `SupportFab`. |
| `apps/frontend/src/merchant/PendingScreen.tsx` | Modify | Mount `SupportFab`. |
| `apps/frontend/src/merchant/SuspendedScreen.tsx` | Modify | Mount `SupportFab`. |
| `CLAUDE.md`, `CONTEXT.md` | Modify | Record the feature and its traps. |

---

### Task 1: Shared validator and wire types

**Files:**
- Create: `packages/shared/src/support.ts`
- Create: `packages/shared/src/support.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces:
  - `SUPPORT_MAX_LENGTH: 2000`
  - `validateSupportMessage(body: unknown): { ok: true; value: string } | { ok: false; code: 'empty' | 'too_long'; error: string }`
  - `type SupportSender = 'merchant' | 'admin'`
  - `interface SupportMessage { id: string; sender: SupportSender; body: string; image_count: number; created_at: string }`
  - `interface SupportFeed { messages: SupportMessage[]; unread: number; available: boolean }`
  - `interface SupportSendResult { message: SupportMessage; alerted: boolean; images_failed: number }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/support.test.ts
import { describe, it, expect } from 'vitest'
import { validateSupportMessage, SUPPORT_MAX_LENGTH } from './support'

describe('validateSupportMessage', () => {
  it('trims and accepts ordinary text', () => {
    expect(validateSupportMessage('  my QR does not show  ')).toEqual({ ok: true, value: 'my QR does not show' })
  })

  it('keeps Markdown characters, emoji and Chinese exactly', () => {
    expect(validateSupportMessage('Joe *Star* _x_ 🍰 蛋糕')).toEqual({ ok: true, value: 'Joe *Star* _x_ 🍰 蛋糕' })
  })

  it('refuses empty and whitespace-only text', () => {
    expect(validateSupportMessage('   ')).toMatchObject({ ok: false, code: 'empty' })
    expect(validateSupportMessage('')).toMatchObject({ ok: false, code: 'empty' })
  })

  it('refuses a non-string body', () => {
    expect(validateSupportMessage(undefined)).toMatchObject({ ok: false, code: 'empty' })
    expect(validateSupportMessage(42)).toMatchObject({ ok: false, code: 'empty' })
  })

  it('accepts exactly the limit and refuses one more', () => {
    expect(validateSupportMessage('a'.repeat(SUPPORT_MAX_LENGTH))).toMatchObject({ ok: true })
    expect(validateSupportMessage('a'.repeat(SUPPORT_MAX_LENGTH + 1))).toMatchObject({ ok: false, code: 'too_long' })
  })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @bitetime/shared test -- support`
Expected: FAIL, "Failed to resolve import './support'".

- [ ] **Step 3: Write the module**

```ts
// packages/shared/src/support.ts
// Support chat (docs/superpowers/specs/2026-10-02-support-chat-design.md). The message bound is
// duplicated in the support_messages CHECK, which is the authority; this copy exists so the
// panel can refuse before the merchant loses a message to a 400. Images reuse the feedback
// image rules (validateFeedbackImages), which are the same three types and the same 5 MiB.

export const SUPPORT_MAX_LENGTH = 2000

export type SupportSender = 'merchant' | 'admin'

export interface SupportMessage {
  id: string
  sender: SupportSender
  body: string
  image_count: number
  created_at: string
}

export interface SupportFeed {
  messages: SupportMessage[]
  unread: number
  /** False when the platform has no support chat configured. The panel then shows mail/WhatsApp. */
  available: boolean
}

export interface SupportSendResult {
  message: SupportMessage
  /** False when the row is stored but Telegram did not take it. */
  alerted: boolean
  images_failed: number
}

export type SupportMessageValidation =
  | { ok: true; value: string }
  | { ok: false; code: 'empty' | 'too_long'; error: string }

export function validateSupportMessage(body: unknown): SupportMessageValidation {
  const text = typeof body === 'string' ? body.trim() : ''
  if (!text) return { ok: false, code: 'empty', error: 'Message is empty' }
  if (text.length > SUPPORT_MAX_LENGTH) {
    return { ok: false, code: 'too_long', error: `Message is longer than ${SUPPORT_MAX_LENGTH} characters` }
  }
  return { ok: true, value: text }
}
```

- [ ] **Step 4: Export it from the package**

Add to `packages/shared/src/index.ts`, after the feedback block:

```ts
export { SUPPORT_MAX_LENGTH, validateSupportMessage } from './support.js'
export type {
  SupportSender, SupportMessage, SupportFeed, SupportSendResult, SupportMessageValidation,
} from './support.js'
```

- [ ] **Step 5: Run the test to see it pass**

Run: `pnpm --filter @bitetime/shared test -- support && pnpm typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/support.ts packages/shared/src/support.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add the support message validator and wire types"
```

---

### Task 2: Migration and grant test

**Files:**
- Create: `apps/backend/supabase/migrations/20261002120000_support_chat.sql`
- Create: `apps/backend/tests/rls/support-chat-grant.test.ts`

**Interfaces:**
- Produces: tables `public.support_threads`, `public.support_messages`; bucket `support-images`; partial unique index `support_messages_admin_tg_message_id` on `(tg_message_id) where sender = 'admin'`.

- [ ] **Step 1: Write the failing grant test**

```ts
// apps/backend/tests/rls/support-chat-grant.test.ts
// Belt on top of the code path: the browser cannot read the support chat directly, in either
// table or in the bucket. If a SELECT here ever returns rows, a grant crept back and the API is
// no longer the only door. Mirrors trial-feedback-grant.test.ts.
import { describe, it, expect } from 'vitest'
import { anonClient, makeUser, seedMerchant, serviceClient, resetMerchant } from './helpers.js'

function expectDenied(error: { code?: string; message: string } | null) {
  expect(error).not.toBeNull()
  expect(error?.code === '42501' || error?.message.toLowerCase().includes('permission denied')).toBe(true)
}

describe('support chat is not directly readable by the browser', () => {
  it('denies anonymous SELECTs on both tables', async () => {
    const threads = await anonClient().from('support_threads').select('*')
    expectDenied(threads.error)
    const messages = await anonClient().from('support_messages').select('*')
    expectDenied(messages.error)
  })

  it('denies the shop owner a SELECT on both tables and a download from the bucket', async () => {
    await resetMerchant('support-grant-shop')
    const owner = await makeUser('support-grant-owner@example.com', 'password123')
    const { data: session } = await owner.auth.getSession()
    const merchantId = await seedMerchant({ slug: 'support-grant-shop', owner_id: session.session!.user.id })

    const svc = serviceClient()
    const t = await svc.from('support_threads').insert({ merchant_id: merchantId })
    if (t.error) throw new Error(`seeding support_threads: ${t.error.message}`)
    const m = await svc.from('support_messages')
      .insert({ merchant_id: merchantId, sender: 'merchant', body: 'hello' }).select('id').single()
    if (m.error) throw new Error(`seeding support_messages: ${m.error.message}`)
    const path = `${merchantId}/${m.data.id}/a.png`
    const up = await svc.storage.from('support-images')
      .upload(path, new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), { upsert: true })
    if (up.error) throw new Error(`seeding support-images: ${up.error.message}`)

    expectDenied((await owner.from('support_threads').select('*').eq('merchant_id', merchantId)).error)
    expectDenied((await owner.from('support_messages').select('*').eq('merchant_id', merchantId)).error)
    const dl = await owner.storage.from('support-images').download(path)
    expect(dl.data).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @bitetime/backend test:db -- support-chat-grant`
Expected: FAIL. The service-role seed throws "relation \"public.support_threads\" does not exist" (or a schema-cache error).

- [ ] **Step 3: Write the migration**

```sql
-- apps/backend/supabase/migrations/20261002120000_support_chat.sql
-- Support chat between a merchant and the platform superadmin. See
-- docs/superpowers/specs/2026-10-02-support-chat-design.md.
--
-- The browser never touches these tables: every read and write goes through the backend's
-- service-role / owner connections, behind requireMerchantOwns. So RLS is enabled with NO
-- policies and the browser roles hold no grants — the withheld grant is what shuts the door,
-- and policy-less RLS is the belt for a grant reopened by accident.
-- tests/rls/support-chat-grant.test.ts is the proof.

create table if not exists public.support_threads (
  merchant_id            uuid primary key references public.merchants (id) on delete cascade,
  -- The forum topic in PLATFORM_SUPPORT_CHAT_ID. Null until the first message reaches Telegram,
  -- and cleared when Telegram reports the topic gone (deleted by hand).
  tg_topic_id            bigint unique,
  merchant_last_seen_at  timestamptz,
  merchant_last_read_at  timestamptz,
  last_away_email_at     timestamptz,
  created_at             timestamptz not null default now()
);

create table if not exists public.support_messages (
  id              uuid primary key default gen_random_uuid(),
  merchant_id     uuid not null references public.support_threads (merchant_id) on delete cascade,
  sender          text not null check (sender in ('merchant', 'admin')),
  author_user_id  uuid references auth.users (id) on delete set null,
  -- The database's copy of SUPPORT_MAX_LENGTH in @bitetime/shared. This CHECK is the authority.
  body            text not null check (char_length(btrim(body)) between 1 and 2000),
  -- Paths in the PRIVATE support-images bucket, never URLs.
  image_paths     text[] not null default '{}' check (cardinality(image_paths) <= 3),
  tg_message_id   bigint,
  created_at      timestamptz not null default now()
);

create index if not exists support_messages_thread_idx
  on public.support_messages (merchant_id, created_at, id);

-- A Telegram update can arrive twice (a retry after a slow or failed response). The reply's own
-- Telegram id makes the second insert a no-op. Partial: a merchant row's tg_message_id is the id
-- of the forwarded post, which nothing deduplicates on.
create unique index if not exists support_messages_admin_tg_message_id
  on public.support_messages (tg_message_id) where sender = 'admin';

alter table public.support_threads enable row level security;
alter table public.support_messages enable row level security;

revoke all on table public.support_threads from anon, authenticated;
revoke all on table public.support_messages from anon, authenticated;
grant select, insert, update on table public.support_threads to service_role;
grant select, insert, update on table public.support_messages to service_role;

-- PRIVATE: a merchant's screenshot is usually their own dashboard — customer names, phone
-- numbers, addresses. Same posture as feedback-images (20260806120000).
insert into storage.buckets (id, name, public)
values ('support-images', 'support-images', false)
on conflict (id) do nothing;

update storage.buckets
set
  file_size_limit = 5242880, -- 5 MiB — MAX_FEEDBACK_IMAGE_BYTES in @bitetime/shared
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'support-images';

-- Deliberately NO storage.objects policies: with public = false and zero policies, anon and
-- authenticated get nothing in either direction.
```

- [ ] **Step 4: Apply it locally**

Run: `cd apps/backend && pnpm db:migrate`
Expected: "Applying migration 20261002120000_support_chat.sql..." and no error. (`db:migrate` targets the LOCAL stack. Never run `db:push`.)

- [ ] **Step 5: Run the grant test to see it pass**

Run: `pnpm --filter @bitetime/backend test:db -- support-chat-grant`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/supabase/migrations/20261002120000_support_chat.sql apps/backend/tests/rls/support-chat-grant.test.ts
git commit -m "feat(db): add the support chat tables and private image bucket"
```

---

### Task 3: Pure support module

**Files:**
- Create: `apps/backend/src/supportChat.ts`
- Create: `apps/backend/tests/unit/supportChat.test.ts`

**Interfaces:**
- Consumes: `plainField(value: unknown): string` from `./platformNotify.js`.
- Produces:
  - `TOPIC_NAME_MAX = 128`
  - `AWAY_AFTER_SECONDS = 120`, `AWAY_EMAIL_EVERY_SECONDS = 3600`
  - `PHOTO_NOTICE: string`
  - `topicName(name: string, slug: string): string`
  - `topicHeader(input: { name: string; slug: string; status: string; ownerEmail: string | null; frontendUrl: string }): string`
  - `merchantText(body: string, imageCount: number): string`
  - `type ParsedUpdate = { kind: 'reply'; topicId: number; messageId: number; text: string } | { kind: 'photo'; topicId: number } | { kind: 'ignore' }`
  - `parseUpdate(update: unknown, chatId: string): ParsedUpdate`
  - `clampReply(text: string): string`
  - `secretMatches(given: string, expected: string): boolean`
  - `awayEmail(input: { shopName: string; dashboardUrl: string }): { subject: string; text: string }`
  - `pollRefusal(webhookUrl: string): string | null`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backend/tests/unit/supportChat.test.ts
import { describe, it, expect } from 'vitest'
import {
  topicName, topicHeader, merchantText, parseUpdate, clampReply, secretMatches, awayEmail,
  pollRefusal, TOPIC_NAME_MAX,
} from '../../src/supportChat.js'

const CHAT = '-1001234567890'

function update(message: Record<string, unknown>) {
  return {
    update_id: 1,
    message: {
      message_id: 77,
      chat: { id: Number(CHAT), type: 'supergroup' },
      from: { id: 5, is_bot: false },
      message_thread_id: 42,
      is_topic_message: true,
      ...message,
    },
  }
}

describe('topicName', () => {
  it('names the topic after the shop and its slug', () => {
    expect(topicName('Sunny Bakes', 'sunny-bakes')).toBe('Sunny Bakes (sunny-bakes)')
  })
  it('strips Markdown markers and stays within the Telegram limit', () => {
    const name = topicName('*Joe* '.repeat(60), 'joe')
    expect(name).not.toMatch(/[*_`[\]]/)
    expect(name.length).toBeLessThanOrEqual(TOPIC_NAME_MAX)
    expect(name.endsWith('(joe)')).toBe(true)
  })
})

describe('topicHeader', () => {
  it('carries the shop link, status and owner email', () => {
    const text = topicHeader({
      name: 'Sunny Bakes', slug: 'sunny-bakes', status: 'active',
      ownerEmail: 'owner@example.com', frontendUrl: 'https://tinyorder.shop/',
    })
    expect(text).toContain('https://tinyorder.shop/s/sunny-bakes')
    expect(text).toContain('active')
    expect(text).toContain('owner@example.com')
  })
  it('says unknown when the owner email is missing', () => {
    const text = topicHeader({ name: 'A', slug: 'a', status: 'pending', ownerEmail: null, frontendUrl: 'x' })
    expect(text).toContain('unknown')
  })
})

describe('merchantText', () => {
  it('keeps the body exactly as typed', () => {
    expect(merchantText('Joe *Star* 🍰 蛋糕', 0)).toBe('Joe *Star* 🍰 蛋糕')
  })
  it('notes how many screenshots follow', () => {
    expect(merchantText('see this', 2)).toBe('see this\n\n📎 2 screenshots below')
    expect(merchantText('see this', 1)).toBe('see this\n\n📎 1 screenshot below')
  })
})

describe('parseUpdate', () => {
  it('accepts a human text reply in a topic of the support chat', () => {
    expect(parseUpdate(update({ text: 'Hi! Please try again.' }), CHAT))
      .toEqual({ kind: 'reply', topicId: 42, messageId: 77, text: 'Hi! Please try again.' })
  })
  it('ignores another chat', () => {
    expect(parseUpdate(update({ text: 'x', chat: { id: -100999, type: 'supergroup' } }), CHAT)).toEqual({ kind: 'ignore' })
  })
  it('ignores a bot sender', () => {
    expect(parseUpdate(update({ text: 'x', from: { id: 9, is_bot: true } }), CHAT)).toEqual({ kind: 'ignore' })
  })
  it('ignores a message in General (no topic)', () => {
    expect(parseUpdate(update({ text: 'x', message_thread_id: undefined, is_topic_message: undefined }), CHAT))
      .toEqual({ kind: 'ignore' })
  })
  it('reports a photo so the bot can say photos do not reach the merchant', () => {
    expect(parseUpdate(update({ photo: [{ file_id: 'f' }] }), CHAT)).toEqual({ kind: 'photo', topicId: 42 })
  })
  it('ignores a service message such as forum_topic_created', () => {
    expect(parseUpdate(update({ forum_topic_created: { name: 'x' } }), CHAT)).toEqual({ kind: 'ignore' })
  })
  it('ignores an edited message and garbage', () => {
    expect(parseUpdate({ update_id: 2, edited_message: update({ text: 'x' }).message }, CHAT)).toEqual({ kind: 'ignore' })
    expect(parseUpdate(null, CHAT)).toEqual({ kind: 'ignore' })
    expect(parseUpdate('nope', CHAT)).toEqual({ kind: 'ignore' })
  })
  it('ignores whitespace-only text', () => {
    expect(parseUpdate(update({ text: '   ' }), CHAT)).toEqual({ kind: 'ignore' })
  })
})

describe('clampReply', () => {
  it('keeps a reply within the limit unchanged', () => {
    expect(clampReply('short')).toBe('short')
    expect(clampReply('a'.repeat(2000))).toHaveLength(2000)
  })
  it('cuts a longer reply to 2000 characters ending in an ellipsis', () => {
    const out = clampReply('a'.repeat(2500))
    expect(out).toHaveLength(2000)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('secretMatches', () => {
  it('matches only the exact secret', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true)
    expect(secretMatches('s3cre', 's3cret')).toBe(false)
    expect(secretMatches('', 's3cret')).toBe(false)
  })
  it('never matches when the expected secret is empty', () => {
    expect(secretMatches('', '')).toBe(false)
  })
})

describe('awayEmail', () => {
  it('links to the dashboard and does not need the reply text', () => {
    const mail = awayEmail({ shopName: 'Sunny Bakes', dashboardUrl: 'https://tinyorder.shop/merchant' })
    expect(mail.subject).toContain('reply')
    expect(mail.text).toContain('https://tinyorder.shop/merchant')
    expect(mail.text).toContain('Sunny Bakes')
  })
})

describe('pollRefusal', () => {
  it('refuses poll mode when the bot has a webhook', () => {
    expect(pollRefusal('https://api.example.com/api/telegram/support-webhook')).toMatch(/webhook/i)
  })
  it('allows poll mode when the bot has no webhook', () => {
    expect(pollRefusal('')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @bitetime/backend test -- supportChat`
Expected: FAIL, "Failed to resolve import '../../src/supportChat.js'".

- [ ] **Step 3: Write the module**

```ts
// apps/backend/src/supportChat.ts
// Support chat — the pure half. See docs/superpowers/specs/2026-10-02-support-chat-design.md.
//
// No env.ts, supabase.ts or db.ts import, so `pnpm test` drives every rule here with no stack.
// The SQL half is supportChatDb.ts; the Bot API adapter is supportTelegram.ts.
import { timingSafeEqual } from 'node:crypto'
import { plainField } from './platformNotify.js'
import { SUPPORT_MAX_LENGTH } from '@bitetime/shared'

/** Telegram's own limit on a forum topic name. */
export const TOPIC_NAME_MAX = 128

/** The away-email rule. supportChatDb.ts passes both into one SQL statement. */
export const AWAY_AFTER_SECONDS = 120
export const AWAY_EMAIL_EVERY_SECONDS = 3600

export const PHOTO_NOTICE = 'Photos do not reach the merchant. Send text.'

/** "<shop name> (<slug>)", cut from the NAME end so the slug — the unique part — survives. */
export function topicName(name: string, slug: string): string {
  const tail = ` (${plainField(slug)})`
  const head = plainField(name).slice(0, Math.max(0, TOPIC_NAME_MAX - tail.length)).trim()
  return `${head}${tail}`
}

/** The first post in a new topic. Plain text: it goes out with no parse_mode. */
export function topicHeader(input: {
  name: string; slug: string; status: string; ownerEmail: string | null; frontendUrl: string
}): string {
  const base = String(input.frontendUrl ?? '').replace(/\/+$/, '')
  return [
    '💬 New support thread',
    '',
    `Shop: ${plainField(input.name)}`,
    `Status: ${plainField(input.status)}`,
    `Owner: ${plainField(input.ownerEmail) || 'unknown'}`,
    '',
    `${base}/s/${plainField(input.slug)}`,
    '',
    'Reply in this topic. Text only — photos do not reach the merchant.',
  ].join('\n')
}

/** The merchant's words, verbatim. Sent with no parse_mode, so no character can break the send. */
export function merchantText(body: string, imageCount: number): string {
  if (imageCount <= 0) return body
  return `${body}\n\n📎 ${imageCount} screenshot${imageCount === 1 ? '' : 's'} below`
}

export type ParsedUpdate =
  | { kind: 'reply'; topicId: number; messageId: number; text: string }
  | { kind: 'photo'; topicId: number }
  | { kind: 'ignore' }

const IGNORE: ParsedUpdate = { kind: 'ignore' }

/**
 * Read one Telegram update. Only `message` counts: an `edited_message` does not change a reply
 * the merchant may already have read. The chat must be the support chat, the sender a human,
 * and the message inside a topic — "General" belongs to no shop.
 */
export function parseUpdate(update: unknown, chatId: string): ParsedUpdate {
  if (!update || typeof update !== 'object') return IGNORE
  const m = (update as { message?: any }).message
  if (!m || typeof m !== 'object') return IGNORE
  if (String(m.chat?.id ?? '') !== String(chatId)) return IGNORE
  if (!m.from || m.from.is_bot !== false) return IGNORE
  const topicId = m.message_thread_id
  if (m.is_topic_message !== true || !Number.isInteger(topicId)) return IGNORE

  if (typeof m.text === 'string' && m.text.trim()) {
    if (!Number.isInteger(m.message_id)) return IGNORE
    return { kind: 'reply', topicId, messageId: m.message_id, text: m.text.trim() }
  }
  if (Array.isArray(m.photo) && m.photo.length > 0) return { kind: 'photo', topicId }
  return IGNORE
}

/** The CHECK allows 2000 characters. A longer reply is cut, not refused: it must still land. */
export function clampReply(text: string): string {
  if (text.length <= SUPPORT_MAX_LENGTH) return text
  return `${text.slice(0, SUPPORT_MAX_LENGTH - 1)}…`
}

/** Constant-time compare. An empty expected secret matches nothing — the route also 503s on it. */
export function secretMatches(given: string, expected: string): boolean {
  if (!expected) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** No reply text in the mail: the dashboard is where the conversation lives. */
export function awayEmail(input: { shopName: string; dashboardUrl: string }): { subject: string; text: string } {
  return {
    subject: 'You have a reply from TinyOrder support',
    text: [
      `Hi ${plainField(input.shopName) || 'there'},`,
      '',
      'The TinyOrder team replied to your support message.',
      `Open your dashboard to read it: ${input.dashboardUrl}`,
      '',
      'The chat bubble at the bottom right shows the conversation.',
    ].join('\n'),
  }
}

/**
 * Telegram refuses getUpdates on a bot with a webhook, and the only way past that is to delete
 * the webhook — which, on the production bot, silently stops every merchant's replies. The poll
 * script therefore refuses outright and names the fix: a separate dev bot.
 */
export function pollRefusal(webhookUrl: string): string | null {
  if (!webhookUrl) return null
  return `This bot has a webhook (${webhookUrl}). Poll mode would have to delete it. Use a separate dev bot in apps/backend/.env.`
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @bitetime/backend test -- supportChat`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/supportChat.ts apps/backend/tests/unit/supportChat.test.ts
git commit -m "feat(backend): add the pure support chat rules"
```

---

### Task 4: Telegram adapter

**Files:**
- Create: `apps/backend/src/supportTelegram.ts`
- Create: `apps/backend/tests/unit/supportTelegram.test.ts`

**Interfaces:**
- Produces:
  - `interface SupportConfig { token: string; chatId: string; webhookSecret: string }`
  - `class TelegramThreadGone extends Error { topicId: number }`
  - `interface SupportTelegram { createTopic(cfg: SupportConfig, name: string): Promise<number>; sendText(cfg: SupportConfig, topicId: number, text: string): Promise<number>; sendPhoto(cfg: SupportConfig, topicId: number, photo: File): Promise<number> }`
  - `createSupportTelegram(fetchImpl?: typeof fetch): SupportTelegram`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backend/tests/unit/supportTelegram.test.ts
import { describe, it, expect } from 'vitest'
import { createSupportTelegram, TelegramThreadGone } from '../../src/supportTelegram.js'

const cfg = { token: 'T0K', chatId: '-100123', webhookSecret: 's' }

function fakeFetch(reply: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = reply(url, init)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('supportTelegram', () => {
  it('creates a forum topic and returns its thread id', async () => {
    const f = fakeFetch(() => ({ body: { ok: true, result: { message_thread_id: 314, name: 'x' } } }))
    const tg = createSupportTelegram(f.impl)
    expect(await tg.createTopic(cfg, 'Sunny Bakes (sunny-bakes)')).toBe(314)
    expect(f.calls[0].url).toBe('https://api.telegram.org/botT0K/createForumTopic')
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ chat_id: '-100123', name: 'Sunny Bakes (sunny-bakes)' })
  })

  it('sends text without parse_mode, into the topic, and returns the message id', async () => {
    const f = fakeFetch(() => ({ body: { ok: true, result: { message_id: 9 } } }))
    const tg = createSupportTelegram(f.impl)
    expect(await tg.sendText(cfg, 314, 'Joe *Star* 🍰 蛋糕')).toBe(9)
    const body = JSON.parse(String(f.calls[0].init.body))
    expect(body).toEqual({ chat_id: '-100123', message_thread_id: 314, text: 'Joe *Star* 🍰 蛋糕' })
    expect(body).not.toHaveProperty('parse_mode')
  })

  it('sends a photo as multipart into the topic', async () => {
    const f = fakeFetch(() => ({ body: { ok: true, result: { message_id: 10 } } }))
    const tg = createSupportTelegram(f.impl)
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
    expect(await tg.sendPhoto(cfg, 314, file)).toBe(10)
    expect(f.calls[0].url).toBe('https://api.telegram.org/botT0K/sendPhoto')
    const form = f.calls[0].init.body as FormData
    expect(form.get('chat_id')).toBe('-100123')
    expect(form.get('message_thread_id')).toBe('314')
    expect(form.get('photo')).toBeInstanceOf(File)
  })

  it('throws TelegramThreadGone when the topic no longer exists', async () => {
    const f = fakeFetch(() => ({ status: 400, body: { ok: false, description: 'Bad Request: message thread not found' } }))
    const tg = createSupportTelegram(f.impl)
    const err = await tg.sendText(cfg, 314, 'hi').catch(e => e)
    expect(err).toBeInstanceOf(TelegramThreadGone)
    expect(err.topicId).toBe(314)
  })

  it('throws a plain error with the description on any other failure', async () => {
    const f = fakeFetch(() => ({ status: 403, body: { ok: false, description: 'Forbidden: bot is not a member' } }))
    const tg = createSupportTelegram(f.impl)
    const err = await tg.createTopic(cfg, 'x').catch(e => e)
    expect(err).not.toBeInstanceOf(TelegramThreadGone)
    expect(String(err.message)).toContain('bot is not a member')
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @bitetime/backend test -- supportTelegram`
Expected: FAIL, "Failed to resolve import '../../src/supportTelegram.js'".

- [ ] **Step 3: Write the adapter**

```ts
// apps/backend/src/supportTelegram.ts
// The support chat's Bot API calls. Separate from notify.ts's telegramSend, which always sends
// Markdown into a plain chat: this one sends into forum TOPICS and never sets parse_mode,
// because the text is a merchant's free text and one stray `*` would make Telegram refuse it.
//
// Token and chat id are parameters, never read from env.ts — the same posture as the Claude
// adapters — so a unit test drives it with a fake fetch.

export interface SupportConfig {
  token: string
  chatId: string
  webhookSecret: string
}

/** The topic was deleted by hand. supportDelivery.ts clears it and makes a new one. */
export class TelegramThreadGone extends Error {
  constructor(public topicId: number) {
    super(`Telegram topic ${topicId} not found`)
  }
}

export interface SupportTelegram {
  createTopic(cfg: SupportConfig, name: string): Promise<number>
  sendText(cfg: SupportConfig, topicId: number, text: string): Promise<number>
  sendPhoto(cfg: SupportConfig, topicId: number, photo: File): Promise<number>
}

export function createSupportTelegram(fetchImpl: typeof fetch = fetch): SupportTelegram {
  async function call(cfg: SupportConfig, method: string, body: BodyInit, json: boolean, topicId?: number) {
    const res = await fetchImpl(`https://api.telegram.org/bot${cfg.token}/${method}`, {
      method: 'POST',
      headers: json ? { 'Content-Type': 'application/json' } : undefined,
      body,
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: any; description?: string }
    if (res.ok && data.ok) return data.result
    const description = data.description ?? `HTTP ${res.status}`
    if (topicId !== undefined && /thread not found/i.test(description)) throw new TelegramThreadGone(topicId)
    throw new Error(`Telegram ${method} failed: ${description}`)
  }

  return {
    async createTopic(cfg, name) {
      const r = await call(cfg, 'createForumTopic', JSON.stringify({ chat_id: cfg.chatId, name }), true)
      return Number(r.message_thread_id)
    },
    async sendText(cfg, topicId, text) {
      const body = JSON.stringify({ chat_id: cfg.chatId, message_thread_id: topicId, text })
      const r = await call(cfg, 'sendMessage', body, true, topicId)
      return Number(r.message_id)
    },
    async sendPhoto(cfg, topicId, photo) {
      const form = new FormData()
      form.append('chat_id', cfg.chatId)
      form.append('message_thread_id', String(topicId))
      form.append('photo', photo, photo.name)
      const r = await call(cfg, 'sendPhoto', form, false, topicId)
      return Number(r.message_id)
    },
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @bitetime/backend test -- supportTelegram`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/supportTelegram.ts apps/backend/tests/unit/supportTelegram.test.ts
git commit -m "feat(backend): add the Telegram forum-topic adapter for support chat"
```

---

### Task 5: Merchant routes (read, send, mark read, image)

**Files:**
- Create: `apps/backend/src/supportChatDb.ts`
- Create: `apps/backend/src/supportDelivery.ts`
- Modify: `apps/backend/src/env.ts` (after `platformTgChatId`)
- Modify: `apps/backend/src/app.ts` (imports; new block after the merchant feedback routes, before `releaseDeps`)
- Modify: `apps/backend/.env.example` (after `PLATFORM_TG_CHAT_ID=`)
- Test: `apps/backend/tests/api/support-chat.test.ts`

**Interfaces:**
- Consumes: Task 1 (`validateSupportMessage`, `SupportMessage`), Task 3 (`topicName`, `topicHeader`, `merchantText`), Task 4 (`SupportTelegram`, `SupportConfig`, `TelegramThreadGone`, `createSupportTelegram`).
- Produces (`supportChatDb.ts`):
  - `listMessages(merchantId: string, afterId: string | null): Promise<SupportMessage[]>`
  - `unreadCount(merchantId: string): Promise<number>`
  - `touchSeen(merchantId: string): Promise<void>`
  - `markRead(merchantId: string): Promise<void>`
  - `insertMerchantMessage(input: { merchantId: string; userId: string; body: string }): Promise<SupportMessage>`
  - `setMessageImages(messageId: string, paths: string[]): Promise<void>`
  - `setMessageTelegramId(messageId: string, tgMessageId: number): Promise<void>`
  - `messageImagePaths(merchantId: string, messageId: string): Promise<string[] | null>`
  - `claimTopic(merchantId: string, create: () => Promise<number>): Promise<{ topicId: number; created: boolean }>`
  - `clearTopic(merchantId: string, topicId: number): Promise<void>`
  - `merchantByTopic(topicId: number): Promise<string | null>` (used by Task 6)
  - `insertAdminReply(input: { merchantId: string; body: string; tgMessageId: number }): Promise<SupportMessage | null>` (Task 6)
  - `claimAwayEmail(merchantId: string): Promise<boolean>` (Task 6)
- Produces (`supportDelivery.ts`): `deliverMerchantMessage(deps: { telegram: SupportTelegram; config: SupportConfig }, input: DeliverInput): Promise<boolean>`
- Produces (`app.ts`): `export const supportDeps: { telegram: SupportTelegram; email: typeof resendSend; config: SupportConfig }`, `export const supportWindow`.

- [ ] **Step 1: Write the failing API tests**

```ts
// apps/backend/tests/api/support-chat.test.ts
// Support chat, merchant side, driven in-process against the real local Postgres.
//
// The load-bearing assertions are the tenancy ones: `admin` and db.ts are RLS-exempt, so
// requireMerchantOwns is the ONLY thing between a merchant and another shop's thread.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { app, supportDeps, supportWindow } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'
import { TelegramThreadGone, type SupportTelegram } from '../../src/supportTelegram.js'

async function tokenOf(client: Awaited<ReturnType<typeof makeUser>>) {
  const { data } = await client.auth.getSession()
  return { token: data.session!.access_token, userId: data.session!.user.id }
}

const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)
const png = (name: string) => new File([PNG_1X1], name, { type: 'image/png' })

function send(merchantId: string, token: string, body: string, files: File[] = []) {
  const form = new FormData()
  form.append('body', body)
  for (const f of files) form.append('images', f)
  return app.request(`/api/merchants/${merchantId}/support/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  })
}
const get = (path: string, token: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } })
const postEmpty = (path: string, token: string) =>
  app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })

// Topic ids are unique across shops and the tables outlive a run, so start each run somewhere new.
let nextId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000)

function fakeTelegram() {
  const calls = { topics: [] as string[], texts: [] as { topicId: number; text: string }[], photos: [] as number[] }
  const gone = new Set<number>()
  let failAll = false
  const tg: SupportTelegram = {
    async createTopic(_cfg, name) {
      if (failAll) throw new Error('Telegram down')
      calls.topics.push(name)
      await new Promise(r => setTimeout(r, 50)) // widen the race window for the concurrency test
      return nextId++
    },
    async sendText(_cfg, topicId, text) {
      if (failAll) throw new Error('Telegram down')
      if (gone.has(topicId)) throw new TelegramThreadGone(topicId)
      calls.texts.push({ topicId, text })
      return nextId++
    },
    async sendPhoto(_cfg, topicId) {
      calls.photos.push(topicId)
      return nextId++
    },
  }
  return { tg, calls, gone, setFailAll: (v: boolean) => { failAll = v } }
}

describe('support chat — merchant routes', () => {
  let ownerToken: string
  let ownerUserId: string
  let ownShopId: string
  let strangerToken: string
  let strangerShopId: string
  let suspendedToken: string
  let suspendedShopId: string
  let superToken: string
  let fake: ReturnType<typeof fakeTelegram>
  const orig = { ...supportDeps }

  beforeAll(async () => {
    for (const s of ['support-own', 'support-stranger', 'support-suspended']) await resetMerchant(s)
    const owner = await tokenOf(await makeUser('support-owner@example.com', 'password123'))
    ownerToken = owner.token
    ownerUserId = owner.userId
    ownShopId = await seedMerchant({ slug: 'support-own', owner_id: owner.userId, name: 'Own *Shop*' })
    const stranger = await tokenOf(await makeUser('support-stranger@example.com', 'password123'))
    strangerToken = stranger.token
    strangerShopId = await seedMerchant({ slug: 'support-stranger', owner_id: stranger.userId })
    const susp = await tokenOf(await makeUser('support-suspended@example.com', 'password123'))
    suspendedToken = susp.token
    suspendedShopId = await seedMerchant({ slug: 'support-suspended', owner_id: susp.userId, status: 'suspended' })

    const sup = await tokenOf(await makeUser('support-super@example.com', 'password123'))
    const svc = serviceClient()
    await svc.from('profiles').delete().eq('user_id', sup.userId)
    await svc.from('profiles').insert({ user_id: sup.userId, name: 'Super', app_role: 'superadmin' })
    superToken = sup.token
  })

  beforeEach(() => {
    fake = fakeTelegram()
    supportDeps.telegram = fake.tg
    supportDeps.config = { token: 'T', chatId: '-100123', webhookSecret: 'secret' }
  })

  afterAll(() => Object.assign(supportDeps, orig))

  it('stores the message, creates one topic with a header, and forwards the text verbatim', async () => {
    const res = await send(ownShopId, ownerToken, '  Joe *Star* 🍰 蛋糕  ')
    expect(res.status).toBe(201)
    const out = await res.json()
    expect(out.alerted).toBe(true)
    expect(out.message).toMatchObject({ sender: 'merchant', body: 'Joe *Star* 🍰 蛋糕', image_count: 0 })
    expect(fake.calls.topics).toEqual(['Own Shop (support-own)'])
    expect(fake.calls.texts).toHaveLength(2) // header, then the message
    expect(fake.calls.texts[0].text).toContain('/s/support-own')
    expect(fake.calls.texts[1].text).toBe('Joe *Star* 🍰 蛋糕')
  })

  it('reuses the topic for the next message, with no second header', async () => {
    const res = await send(ownShopId, ownerToken, 'second message')
    expect(res.status).toBe(201)
    expect(fake.calls.topics).toEqual([])
    expect(fake.calls.texts.map(t => t.text)).toEqual(['second message'])
  })

  it('creates exactly one topic when two first messages arrive together', async () => {
    await resetMerchant('support-race')
    const u = await tokenOf(await makeUser('support-race@example.com', 'password123'))
    const shop = await seedMerchant({ slug: 'support-race', owner_id: u.userId })
    const [a, b] = await Promise.all([send(shop, u.token, 'one'), send(shop, u.token, 'two')])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(fake.calls.topics).toHaveLength(1)
  })

  it('recreates a topic deleted by hand and still delivers', async () => {
    const { data } = await serviceClient().from('support_threads').select('tg_topic_id').eq('merchant_id', ownShopId).single()
    fake.gone.add(Number(data!.tg_topic_id))
    const res = await send(ownShopId, ownerToken, 'after delete')
    expect(res.status).toBe(201)
    expect((await res.json()).alerted).toBe(true)
    expect(fake.calls.topics).toHaveLength(1)
    expect(fake.calls.texts.at(-1)!.text).toBe('after delete')
  })

  it('keeps the message and answers alerted:false when Telegram is down', async () => {
    fake.setFailAll(true)
    const res = await send(ownShopId, ownerToken, 'telegram is down')
    expect(res.status).toBe(201)
    expect((await res.json()).alerted).toBe(false)
    const feed = await (await get(`/api/merchants/${ownShopId}/support/messages`, ownerToken)).json()
    expect(feed.messages.map((m: any) => m.body)).toContain('telegram is down')
  })

  it('uploads screenshots, forwards them, and serves them only to the owner', async () => {
    const res = await send(ownShopId, ownerToken, 'see screenshots', [png('a.png'), png('b.png')])
    expect(res.status).toBe(201)
    const out = await res.json()
    expect(out.message.image_count).toBe(2)
    expect(out.images_failed).toBe(0)
    expect(fake.calls.photos).toHaveLength(2)

    const own = await get(`/api/merchants/${ownShopId}/support/messages/${out.message.id}/images/0`, ownerToken)
    expect(own.status).toBe(200)
    // The stranger names their OWN shop in the route, with our message id: still a 404.
    const cross = await get(`/api/merchants/${strangerShopId}/support/messages/${out.message.id}/images/0`, strangerToken)
    expect(cross.status).toBe(404)
    const outOfRange = await get(`/api/merchants/${ownShopId}/support/messages/${out.message.id}/images/5`, ownerToken)
    expect(outOfRange.status).toBe(404)
  })

  it('refuses a stranger on every route of another shop', async () => {
    expect((await send(ownShopId, strangerToken, 'hi')).status).toBe(403)
    expect((await get(`/api/merchants/${ownShopId}/support/messages`, strangerToken)).status).toBe(403)
    expect((await postEmpty(`/api/merchants/${ownShopId}/support/read`, strangerToken)).status).toBe(403)
  })

  it('refuses a superadmin write, and a superadmin read does not mark the merchant seen', async () => {
    expect((await send(ownShopId, superToken, 'impersonated')).status).toBe(403)
    expect((await postEmpty(`/api/merchants/${ownShopId}/support/read`, superToken)).status).toBe(403)

    const svc = serviceClient()
    await svc.from('support_threads').update({ merchant_last_seen_at: null }).eq('merchant_id', ownShopId)
    expect((await get(`/api/merchants/${ownShopId}/support/messages`, superToken)).status).toBe(200)
    const { data } = await svc.from('support_threads').select('merchant_last_seen_at').eq('merchant_id', ownShopId).single()
    expect(data!.merchant_last_seen_at).toBeNull()
  })

  it('lets a suspended shop ask for help', async () => {
    expect((await send(suspendedShopId, suspendedToken, 'why am I suspended?')).status).toBe(201)
  })

  it('validates the text and the images', async () => {
    expect((await send(ownShopId, ownerToken, '   ')).status).toBe(400)
    expect((await send(ownShopId, ownerToken, 'a'.repeat(2001))).status).toBe(400)
    const four = [png('1.png'), png('2.png'), png('3.png'), png('4.png')]
    expect((await send(ownShopId, ownerToken, 'too many', four)).status).toBe(400)
  })

  it('answers 503 support_unavailable when the chat is not configured', async () => {
    supportDeps.config = { token: '', chatId: '', webhookSecret: '' }
    const res = await send(ownShopId, ownerToken, 'hello')
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('support_unavailable')
    const feed = await (await get(`/api/merchants/${ownShopId}/support/messages`, ownerToken)).json()
    expect(feed.available).toBe(false)
  })

  it('consults the rate window under the caller id', async () => {
    for (let i = 0; i < 30; i++) supportWindow.allow(ownerUserId)
    expect((await send(ownShopId, ownerToken, 'one too many')).status).toBe(429)
  })

  it('the cursor returns only later messages, and the GET marks the owner seen', async () => {
    await resetMerchant('support-cursor')
    const u = await tokenOf(await makeUser('support-cursor@example.com', 'password123'))
    const shop = await seedMerchant({ slug: 'support-cursor', owner_id: u.userId })
    // Two rows inserted in one statement share created_at; the id tie-break must still order them.
    const svc = serviceClient()
    await svc.from('support_threads').insert({ merchant_id: shop })
    await svc.from('support_messages').insert([
      { merchant_id: shop, sender: 'merchant', body: 'first' },
      { merchant_id: shop, sender: 'admin', body: 'second' },
    ])
    const all = await (await get(`/api/merchants/${shop}/support/messages`, u.token)).json()
    expect(all.messages).toHaveLength(2)
    expect(all.unread).toBe(1)
    const last = all.messages[1].id
    const later = await (await get(`/api/merchants/${shop}/support/messages?after=${last}`, u.token)).json()
    expect(later.messages).toEqual([])
    const fromFirst = await (await get(`/api/merchants/${shop}/support/messages?after=${all.messages[0].id}`, u.token)).json()
    expect(fromFirst.messages.map((m: any) => m.id)).toEqual([last])

    expect((await get(`/api/merchants/${shop}/support/messages?after=not-a-uuid`, u.token)).status).toBe(400)

    const { data } = await svc.from('support_threads').select('merchant_last_seen_at').eq('merchant_id', shop).single()
    expect(data!.merchant_last_seen_at).not.toBeNull()

    expect((await postEmpty(`/api/merchants/${shop}/support/read`, u.token)).status).toBe(200)
    const after = await (await get(`/api/merchants/${shop}/support/messages`, u.token)).json()
    expect(after.unread).toBe(0)
  })
})
```

The rate-window test fills the owner's window, so it must stay after every other test that posts as the owner. The cursor test after it uses its own user.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @bitetime/backend test:db -- support-chat.test`
Expected: FAIL, "does not provide an export named 'supportDeps'".

- [ ] **Step 3: Add the env variables**

In `apps/backend/src/env.ts`, after `platformTgChatId`:

```ts
  // The support chat (supportChat.ts): a forum SUPERGROUP where each shop gets one topic, and the
  // secret Telegram echoes back in X-Telegram-Bot-Api-Secret-Token on every webhook call. The bot
  // is PLATFORM_TG_TOKEN above. May equal PLATFORM_TG_CHAT_ID — the signup alerts then land in
  // "General". OPTIONAL: unset, "Talk to a person" answers 503 and the panel shows mail/WhatsApp.
  platformSupportChatId: process.env.PLATFORM_SUPPORT_CHAT_ID || '',
  platformTgWebhookSecret: process.env.PLATFORM_TG_WEBHOOK_SECRET || '',
```

In `apps/backend/.env.example`, after `PLATFORM_TG_CHAT_ID=`:

```bash

# Support chat. A forum supergroup ("Topics" on) with the PLATFORM_TG_TOKEN bot as an admin
# that can manage topics. The secret is any long random string; Telegram sends it back on
# every webhook call. For LOCAL work use a SEPARATE dev bot and dev group — poll mode cannot
# run on a bot that has a webhook. Optional: unset = the chat falls back to mail/WhatsApp.
PLATFORM_SUPPORT_CHAT_ID=
PLATFORM_TG_WEBHOOK_SECRET=
```

- [ ] **Step 4: Write `supportChatDb.ts`**

```ts
// apps/backend/src/supportChatDb.ts
// Support chat — the SQL. db.ts connects as the database OWNER, so no RLS runs here: every
// function takes the merchant id as an argument that a route guard has already proven.
import type postgres from 'postgres'
import type { SupportMessage, SupportSender } from '@bitetime/shared'
import { sql, withTransaction } from './db.js'
import { AWAY_AFTER_SECONDS, AWAY_EMAIL_EVERY_SECONDS } from './supportChat.js'

type Row = { id: string; sender: SupportSender; body: string; image_paths: string[]; created_at: Date }

const toMessage = (r: Row): SupportMessage => ({
  id: r.id,
  sender: r.sender,
  body: r.body,
  image_count: r.image_paths.length,
  created_at: r.created_at.toISOString(),
})

/** The newest LATEST_LIMIT on first load; everything after the cursor otherwise. */
const LATEST_LIMIT = 200

export async function listMessages(merchantId: string, afterId: string | null): Promise<SupportMessage[]> {
  if (!afterId) {
    const rows = await sql<Row[]>`
      select id, sender, body, image_paths, created_at from support_messages
       where merchant_id = ${merchantId}
       order by created_at desc, id desc limit ${LATEST_LIMIT}`
    return rows.reverse().map(toMessage)
  }
  // The cursor is an id, and the comparison reads that row's OWN created_at: a timestamp sent
  // through the browser loses microseconds and would return the last message again. An id from
  // another shop matches no row here, so the subquery is null and nothing comes back.
  const rows = await sql<Row[]>`
    select id, sender, body, image_paths, created_at from support_messages
     where merchant_id = ${merchantId}
       and (created_at, id) > (
         select created_at, id from support_messages where id = ${afterId} and merchant_id = ${merchantId})
     order by created_at, id limit ${LATEST_LIMIT}`
  return rows.map(toMessage)
}

export async function unreadCount(merchantId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from support_messages m
      left join support_threads t on t.merchant_id = m.merchant_id
     where m.merchant_id = ${merchantId} and m.sender = 'admin'
       and (t.merchant_last_read_at is null or m.created_at > t.merchant_last_read_at)`
  return r?.n ?? 0
}

export async function touchSeen(merchantId: string): Promise<void> {
  await sql`
    insert into support_threads (merchant_id, merchant_last_seen_at) values (${merchantId}, now())
    on conflict (merchant_id) do update set merchant_last_seen_at = now()`
}

export async function markRead(merchantId: string): Promise<void> {
  await sql`
    insert into support_threads (merchant_id, merchant_last_read_at) values (${merchantId}, now())
    on conflict (merchant_id) do update set merchant_last_read_at = now()`
}

export async function insertMerchantMessage(input: { merchantId: string; userId: string; body: string }): Promise<SupportMessage> {
  return withTransaction(async (tx) => {
    await tx`insert into support_threads (merchant_id) values (${input.merchantId}) on conflict do nothing`
    const [row] = await tx<Row[]>`
      insert into support_messages (merchant_id, sender, author_user_id, body)
      values (${input.merchantId}, 'merchant', ${input.userId}, ${input.body})
      returning id, sender, body, image_paths, created_at`
    return toMessage(row)
  })
}

export async function setMessageImages(messageId: string, paths: string[]): Promise<void> {
  await sql`update support_messages set image_paths = ${sql.array(paths)} where id = ${messageId}`
}

export async function setMessageTelegramId(messageId: string, tgMessageId: number): Promise<void> {
  await sql`update support_messages set tg_message_id = ${tgMessageId} where id = ${messageId}`
}

/** Null when the message does not exist OR belongs to another shop — the route 404s both alike. */
export async function messageImagePaths(merchantId: string, messageId: string): Promise<string[] | null> {
  const [r] = await sql<{ image_paths: string[] }[]>`
    select image_paths from support_messages where id = ${messageId} and merchant_id = ${merchantId}`
  return r ? r.image_paths : null
}

/**
 * The shop's topic, creating it on first use. The row lock makes two first messages at the same
 * time create ONE topic: the second waits, then reads the id the first wrote. The Telegram call
 * runs inside the transaction and holds the lock for one round trip — fine at support volume.
 */
export async function claimTopic(
  merchantId: string,
  create: () => Promise<number>,
): Promise<{ topicId: number; created: boolean }> {
  return withTransaction(async (tx: postgres.TransactionSql) => {
    await tx`insert into support_threads (merchant_id) values (${merchantId}) on conflict do nothing`
    const [t] = await tx<{ tg_topic_id: string | null }[]>`
      select tg_topic_id from support_threads where merchant_id = ${merchantId} for update`
    if (t.tg_topic_id !== null) return { topicId: Number(t.tg_topic_id), created: false }
    const topicId = await create()
    await tx`update support_threads set tg_topic_id = ${topicId} where merchant_id = ${merchantId}`
    return { topicId, created: true }
  })
}

/** Only clears the id it was told about, so a concurrent recreate is not undone. */
export async function clearTopic(merchantId: string, topicId: number): Promise<void> {
  await sql`update support_threads set tg_topic_id = null where merchant_id = ${merchantId} and tg_topic_id = ${topicId}`
}

export async function merchantByTopic(topicId: number): Promise<string | null> {
  const [r] = await sql<{ merchant_id: string }[]>`select merchant_id from support_threads where tg_topic_id = ${topicId}`
  return r?.merchant_id ?? null
}

/** Null when this Telegram message is already stored (a repeated update). */
export async function insertAdminReply(input: { merchantId: string; body: string; tgMessageId: number }): Promise<SupportMessage | null> {
  const [row] = await sql<Row[]>`
    insert into support_messages (merchant_id, sender, body, tg_message_id)
    values (${input.merchantId}, 'admin', ${input.body}, ${input.tgMessageId})
    on conflict (tg_message_id) where sender = 'admin' do nothing
    returning id, sender, body, image_paths, created_at`
  return row ? toMessage(row) : null
}

/**
 * Decide AND claim the away email in one statement, so two replies at the same time send one
 * email: only the statement that changed the row gets `true`.
 */
export async function claimAwayEmail(merchantId: string): Promise<boolean> {
  const rows = await sql`
    update support_threads set last_away_email_at = now()
     where merchant_id = ${merchantId}
       and (merchant_last_seen_at is null
            or merchant_last_seen_at < now() - make_interval(secs => ${AWAY_AFTER_SECONDS}))
       and (last_away_email_at is null
            or last_away_email_at < now() - make_interval(secs => ${AWAY_EMAIL_EVERY_SECONDS}))
    returning merchant_id`
  return rows.length > 0
}
```

- [ ] **Step 5: Write `supportDelivery.ts`**

```ts
// apps/backend/src/supportDelivery.ts
// Merchant → Telegram. The message row is ALREADY stored when this runs, so a failure here costs
// the alert, never the merchant's words. Returns whether the text reached Telegram.
import { claimTopic, clearTopic, setMessageTelegramId } from './supportChatDb.js'
import { topicName, topicHeader, merchantText } from './supportChat.js'
import { TelegramThreadGone, type SupportConfig, type SupportTelegram } from './supportTelegram.js'

export interface DeliverInput {
  merchant: { id: string; name: string; slug: string; status: string }
  /** Read lazily: only a NEW topic's header needs it, and it costs an Auth call. */
  ownerEmail: () => Promise<string | null>
  messageId: string
  body: string
  images: File[]
  frontendUrl: string
}

export async function deliverMerchantMessage(
  deps: { telegram: SupportTelegram; config: SupportConfig },
  input: DeliverInput,
): Promise<boolean> {
  const { telegram, config } = deps
  const { merchant } = input

  const attempt = async () => {
    const { topicId, created } = await claimTopic(merchant.id, () =>
      telegram.createTopic(config, topicName(merchant.name, merchant.slug)))
    if (created) {
      await telegram.sendText(config, topicId, topicHeader({
        name: merchant.name, slug: merchant.slug, status: merchant.status,
        ownerEmail: await input.ownerEmail(), frontendUrl: input.frontendUrl,
      }))
    }
    const tgId = await telegram.sendText(config, topicId, merchantText(input.body, input.images.length))
    await setMessageTelegramId(input.messageId, tgId)
    // A lost photo does not un-alert: the text, which says how many follow, already landed.
    for (const image of input.images) {
      await telegram.sendPhoto(config, topicId, image)
        .catch(e => console.error(`support ${input.messageId}: sendPhoto failed:`, e?.message ?? e))
    }
  }

  try {
    await attempt()
    return true
  } catch (e) {
    if (e instanceof TelegramThreadGone) {
      // The topic was deleted by hand. Forget it, make a new one, try once more.
      await clearTopic(merchant.id, e.topicId)
      try {
        await attempt()
        return true
      } catch (e2: any) {
        console.error(`support ${input.messageId}: retry after a lost topic failed:`, e2?.message ?? e2)
        return false
      }
    }
    console.error(`support ${input.messageId}: Telegram delivery failed:`, (e as any)?.message ?? e)
    return false
  }
}
```

- [ ] **Step 6: Add the routes to `app.ts`**

Add the imports at the top of `apps/backend/src/app.ts`, next to the feedback imports (`validateFeedbackImages` is already imported from `@bitetime/shared` for the feedback route — add `validateSupportMessage` to that same import):

```ts
import { validateSupportMessage } from '@bitetime/shared'
import { createSupportTelegram, type SupportConfig, type SupportTelegram } from './supportTelegram.js'
import {
  listMessages, unreadCount, touchSeen, markRead, insertMerchantMessage, setMessageImages,
  messageImagePaths, merchantByTopic, insertAdminReply, claimAwayEmail,
} from './supportChatDb.js'
import { deliverMerchantMessage } from './supportDelivery.js'
import { parseUpdate, clampReply, secretMatches, awayEmail, PHOTO_NOTICE } from './supportChat.js'
```

Add this block after the `app.patch('/api/admin/feedback/:feedbackId', …)` route and before `export const releaseDeps`:

```ts
// ── Support chat ────────────────────────────────────────────────────────────────
// docs/superpowers/specs/2026-10-02-support-chat-design.md. A merchant talks to the superadmin
// through one Telegram forum topic per shop. The browser polls GET …/support/messages; the
// superadmin's replies arrive on POST /api/telegram/support-webhook (Task 6).
//
// Same mutable seam as platformNotifyDeps: production uses the real Bot API and Resend, an API
// test swaps in fakes and turns the feature on without env vars.
export const supportDeps: {
  telegram: SupportTelegram
  email: typeof resendSend
  config: SupportConfig
} = {
  telegram: createSupportTelegram(),
  email: resendSend,
  config: { token: env.platformTgToken, chatId: env.platformSupportChatId, webhookSecret: env.platformTgWebhookSecret },
}

const supportAvailable = () => Boolean(supportDeps.config.token && supportDeps.config.chatId)

// EXPORTED for tests/api/support-chat.test.ts only, which fills it by calling allow() directly —
// the same reason feedbackWindow is exported (#147).
export const supportWindow = createSlidingWindow({ limit: 30, windowMs: 60 * 60_000, now: () => Date.now() })

const SUPPORT_IMAGE_BUCKET = 'support-images'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

app.get('/api/merchants/:id/support/messages', requireMerchantOwns, async (c) => {
  const user = c.get('user')
  const merchant = c.get('merchant')
  const after = c.req.query('after') || null
  if (after !== null && !UUID_RE.test(after)) return c.json({ error: 'Bad cursor' }, 400)

  // A superadmin passes requireMerchantOwns. Their read must not count as the MERCHANT being
  // here, or it would stop the away email the merchant needs.
  if (merchant.owner_id === user.id) await touchSeen(merchant.id)

  const [messages, unread] = await Promise.all([listMessages(merchant.id, after), unreadCount(merchant.id)])
  return c.json({ messages, unread, available: supportAvailable() })
})

app.post('/api/merchants/:id/support/read', requireMerchantOwns, async (c) => {
  const merchant = c.get('merchant')
  if (merchant.owner_id !== c.get('user').id) return c.json({ error: 'Forbidden' }, 403)
  await markRead(merchant.id)
  return c.json({ ok: true })
})

app.post('/api/merchants/:id/support/messages', requireMerchantOwns, async (c) => {
  const user = c.get('user')
  const merchant = c.get('merchant')
  // A row with sender = 'merchant' must come from the merchant, never from a superadmin viewing
  // the shop.
  if (merchant.owner_id !== user.id) return c.json({ error: 'Forbidden' }, 403)
  if (!supportAvailable()) return c.json({ error: 'support_unavailable' }, 503)
  if (!supportWindow.allow(user.id)) return c.json({ error: 'Too many messages. Please try again later.' }, 429)

  const form = await c.req.parseBody({ all: true }).catch(() => ({} as Record<string, unknown>))
  const parsed = validateSupportMessage(form['body'])
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const raw = form['images']
  const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File)
  const images = validateFeedbackImages(files.map(f => ({ type: f.type, size: f.size })))
  if (!images.ok) {
    const name = images.index === null ? null : files[images.index]?.name
    return c.json({ error: name ? `${images.error}: ${name}` : images.error }, 400)
  }
  for (const file of files) {
    if (!FEEDBACK_IMAGE_EXT[file.type]) return c.json({ error: `Unsupported image type: ${file.name}` }, 400)
  }

  // Store FIRST: nothing after this line can lose the merchant's words.
  const message = await insertMerchantMessage({ merchantId: merchant.id, userId: user.id, body: parsed.value })

  const paths: string[] = []
  const uploaded: File[] = []
  for (const file of files) {
    const path = `${merchant.id}/${message.id}/${crypto.randomUUID()}.${FEEDBACK_IMAGE_EXT[file.type]}`
    const { error } = await admin.storage.from(SUPPORT_IMAGE_BUCKET).upload(path, file, { contentType: file.type, upsert: true })
    if (error) {
      console.error(`support ${message.id}: screenshot upload failed:`, error.message)
      continue
    }
    paths.push(path)
    uploaded.push(file)
  }
  if (paths.length) await setMessageImages(message.id, paths)

  const alerted = await deliverMerchantMessage(supportDeps, {
    merchant: { id: merchant.id, name: merchant.name, slug: merchant.slug, status: merchant.status },
    ownerEmail: async () => user.email ?? null,
    messageId: message.id,
    body: parsed.value,
    images: uploaded,
    frontendUrl: env.frontendUrl,
  })

  return c.json({
    message: { ...message, image_count: paths.length },
    alerted,
    images_failed: files.length - paths.length,
  }, 201)
})

/** Same shape as the feedback image route: the caller names an INDEX, never a path. */
app.get('/api/merchants/:id/support/messages/:msgId/images/:index', requireMerchantOwns, async (c) => {
  const msgId = c.req.param('msgId')
  if (!UUID_RE.test(msgId)) return c.json({ error: 'not_found' }, 404)
  const paths = (await messageImagePaths(c.get('merchant').id, msgId)) ?? []
  const index = Number(c.req.param('index'))
  if (!Number.isInteger(index) || index < 0 || index >= paths.length) return c.json({ error: 'not_found' }, 404)
  return streamPrivateObject(SUPPORT_IMAGE_BUCKET, paths[index])
})
```

`FEEDBACK_IMAGE_EXT` and `streamPrivateObject` already exist in `app.ts`; reuse them. `ownerEmail` reads the caller's own email: the POST refuses anyone but the owner, so the caller IS the owner.

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter @bitetime/backend test:db -- support-chat.test`
Expected: PASS, all 13 tests.

If every test times out inside `makeUser`, read the memory note on local Supabase auth latency (`test-db-fails-on-loaded-machine`) before you change code.

- [ ] **Step 8: Run the unit suite, lint and typecheck**

Run: `pnpm --filter @bitetime/backend test && pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/supportChatDb.ts apps/backend/src/supportDelivery.ts apps/backend/src/env.ts \
  apps/backend/src/app.ts apps/backend/.env.example apps/backend/tests/api/support-chat.test.ts
git commit -m "feat(backend): add the support chat routes for merchants"
```

---

### Task 6: Telegram webhook and away email

**Files:**
- Modify: `apps/backend/src/app.ts` (append to the support chat block from Task 5)
- Test: `apps/backend/tests/api/support-webhook.test.ts`

**Interfaces:**
- Consumes: Task 3 (`parseUpdate`, `clampReply`, `secretMatches`, `awayEmail`, `PHOTO_NOTICE`), Task 5 (`supportDeps`, `merchantByTopic`, `insertAdminReply`, `claimAwayEmail`).
- Produces: `POST /api/telegram/support-webhook`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backend/tests/api/support-webhook.test.ts
// The superadmin's replies, arriving from Telegram. Real Postgres: the dedupe and the away-email
// claim are SQL properties, and a mocked database would prove neither.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { app, supportDeps } from '../../src/app.js'
import { makeUser, seedMerchant, serviceClient, resetMerchant } from '../rls/helpers.js'
import type { SupportTelegram } from '../../src/supportTelegram.js'

const CHAT = '-1009876543210'
const SECRET = 'webhook-secret'
let nextId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000)

function hook(update: unknown, secret = SECRET) {
  return app.request('/api/telegram/support-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(update),
  })
}

function reply(topicId: number, text: string, messageId = nextId++) {
  return {
    update_id: nextId++,
    message: {
      message_id: messageId, chat: { id: Number(CHAT), type: 'supergroup' },
      from: { id: 1, is_bot: false }, message_thread_id: topicId, is_topic_message: true, text,
    },
  }
}

describe('support webhook', () => {
  let shopId: string
  let topicId: number
  let ownerEmail: string
  const sentTexts: { topicId: number; text: string }[] = []
  const emails: { to: string; subject: string }[] = []
  const orig = { ...supportDeps }
  const svc = serviceClient()

  async function setThread(fields: Record<string, unknown>) {
    const { error } = await svc.from('support_threads').update(fields).eq('merchant_id', shopId)
    if (error) throw new Error(error.message)
  }
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

  beforeAll(async () => {
    await resetMerchant('support-hook')
    ownerEmail = 'support-hook-owner@example.com'
    const owner = await makeUser(ownerEmail, 'password123')
    const { data } = await owner.auth.getSession()
    shopId = await seedMerchant({ slug: 'support-hook', owner_id: data.session!.user.id, name: 'Hook Shop' })
    topicId = nextId++
    const { error } = await svc.from('support_threads').insert({ merchant_id: shopId, tg_topic_id: topicId })
    if (error) throw new Error(error.message)
  })

  beforeEach(async () => {
    sentTexts.length = 0
    emails.length = 0
    const tg: SupportTelegram = {
      async createTopic() { throw new Error('not expected') },
      async sendText(_c, t, text) { sentTexts.push({ topicId: t, text }); return nextId++ },
      async sendPhoto() { return nextId++ },
    }
    supportDeps.telegram = tg
    supportDeps.email = async (to, subject) => { emails.push({ to, subject }) }
    supportDeps.config = { token: 'T', chatId: CHAT, webhookSecret: SECRET }
    // Default: the merchant is on the dashboard right now, and no email went out recently.
    await setThread({ merchant_last_seen_at: new Date().toISOString(), last_away_email_at: null })
  })

  afterAll(() => Object.assign(supportDeps, orig))

  async function adminBodies() {
    const { data } = await svc.from('support_messages').select('body').eq('merchant_id', shopId).eq('sender', 'admin')
    return (data ?? []).map(r => r.body)
  }

  it('refuses a wrong secret with 401 and stores nothing', async () => {
    const res = await hook(reply(topicId, 'should not land'), 'wrong')
    expect(res.status).toBe(401)
    expect(await adminBodies()).not.toContain('should not land')
  })

  it('answers 503 when the webhook secret is not configured', async () => {
    supportDeps.config = { token: 'T', chatId: CHAT, webhookSecret: '' }
    expect((await hook(reply(topicId, 'x'), '')).status).toBe(503)
  })

  it('stores a text reply in the topic for that shop', async () => {
    const res = await hook(reply(topicId, 'Hi! Please try again.'))
    expect(res.status).toBe(200)
    expect(await adminBodies()).toContain('Hi! Please try again.')
  })

  it('stores a repeated update once', async () => {
    const u = reply(topicId, 'only once please')
    expect((await hook(u)).status).toBe(200)
    expect((await hook(u)).status).toBe(200)
    expect((await adminBodies()).filter(b => b === 'only once please')).toHaveLength(1)
  })

  it('ignores an unknown topic, another chat and a bot sender, with 200', async () => {
    expect((await hook(reply(nextId++, 'nobody owns this topic'))).status).toBe(200)
    const other = reply(topicId, 'other chat'); other.message.chat.id = -100111
    expect((await hook(other)).status).toBe(200)
    const bot = reply(topicId, 'from a bot'); bot.message.from.is_bot = true
    expect((await hook(bot)).status).toBe(200)
    const bodies = await adminBodies()
    expect(bodies).not.toContain('nobody owns this topic')
    expect(bodies).not.toContain('other chat')
    expect(bodies).not.toContain('from a bot')
  })

  it('answers a photo with a notice in the same topic', async () => {
    const u = reply(topicId, 'x') as any
    delete u.message.text
    u.message.photo = [{ file_id: 'abc' }]
    expect((await hook(u)).status).toBe(200)
    expect(sentTexts).toEqual([{ topicId, text: 'Photos do not reach the merchant. Send text.' }])
  })

  it('cuts a long reply to 2000 characters', async () => {
    await hook(reply(topicId, 'L'.repeat(2500)))
    const long = (await adminBodies()).find(b => b.startsWith('LLLL'))!
    expect(long).toHaveLength(2000)
  })

  it('sends no email while the merchant is on the dashboard', async () => {
    await setThread({ merchant_last_seen_at: ago(60) })
    await hook(reply(topicId, 'merchant is here'))
    expect(emails).toEqual([])
  })

  it('emails the owner once when the merchant is away, and not again within the hour', async () => {
    await setThread({ merchant_last_seen_at: ago(180) })
    await hook(reply(topicId, 'away one'))
    await hook(reply(topicId, 'away two'))
    expect(emails).toHaveLength(1)
    expect(emails[0].to).toBe(ownerEmail)
  })

  it('emails again after the hour has passed', async () => {
    await setThread({ merchant_last_seen_at: ago(7200), last_away_email_at: ago(3700) })
    await hook(reply(topicId, 'an hour later'))
    expect(emails).toHaveLength(1)
  })

  it('sends one email when two replies arrive together', async () => {
    await setThread({ merchant_last_seen_at: ago(600), last_away_email_at: null })
    await Promise.all([hook(reply(topicId, 'together a')), hook(reply(topicId, 'together b'))])
    expect(emails).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm --filter @bitetime/backend test:db -- support-webhook`
Expected: FAIL. The first request gets 404 (the route does not exist).

- [ ] **Step 3: Add the webhook route**

Append to the support chat block in `app.ts`:

```ts
/**
 * The superadmin's replies, from Telegram. Registered with setWebhook by
 * scripts/telegramWebhook.ts, which also sets the secret Telegram echoes back here.
 *
 * Status codes are a conversation with Telegram, not with a person: any non-2xx makes Telegram
 * send the update AGAIN. So an update we deliberately ignore gets 200, and only a failure we
 * want retried — the database write throwing — gets 500. The unique tg_message_id index makes
 * that retry safe.
 */
app.post('/api/telegram/support-webhook', async (c) => {
  const cfg = supportDeps.config
  if (!cfg.token || !cfg.chatId || !cfg.webhookSecret) return c.json({ error: 'support_unavailable' }, 503)
  if (!secretMatches(c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '', cfg.webhookSecret)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const parsed = parseUpdate(await c.req.json().catch(() => null), cfg.chatId)
  if (parsed.kind === 'ignore') return c.json({ ok: true })

  let merchantId: string | null
  try {
    merchantId = await merchantByTopic(parsed.topicId)
  } catch (e: any) {
    console.error('support webhook: topic lookup failed:', e?.message ?? e)
    return c.json({ error: 'lookup_failed' }, 500)
  }
  if (!merchantId) return c.json({ ok: true })

  if (parsed.kind === 'photo') {
    await supportDeps.telegram.sendText(cfg, parsed.topicId, PHOTO_NOTICE)
      .catch(e => console.error('support webhook: photo notice failed:', e?.message ?? e))
    return c.json({ ok: true })
  }

  let stored: Awaited<ReturnType<typeof insertAdminReply>>
  try {
    stored = await insertAdminReply({ merchantId, body: clampReply(parsed.text), tgMessageId: parsed.messageId })
  } catch (e: any) {
    console.error('support webhook: storing a reply failed:', e?.message ?? e)
    return c.json({ error: 'store_failed' }, 500)
  }

  // A repeated update stored nothing, so it must not email either.
  if (stored) {
    try {
      if (await claimAwayEmail(merchantId)) await sendSupportAwayEmail(merchantId)
    } catch (e: any) {
      console.error('support webhook: away email failed for', merchantId, '—', e?.message ?? e)
    }
  }
  return c.json({ ok: true })
})

async function sendSupportAwayEmail(merchantId: string) {
  const { data: shop } = await admin.from('merchants').select('name, owner_id').eq('id', merchantId).maybeSingle()
  if (!shop?.owner_id) return
  const { data: owner } = await admin.auth.admin.getUserById(shop.owner_id)
  const to = owner?.user?.email
  if (!to) return
  const mail = awayEmail({ shopName: shop.name, dashboardUrl: `${env.frontendUrl.replace(/\/+$/, '')}/merchant` })
  await supportDeps.email(to, mail.subject, { text: mail.text })
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @bitetime/backend test:db -- support-webhook`
Expected: PASS, all 11 tests.

- [ ] **Step 5: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/app.ts apps/backend/tests/api/support-webhook.test.ts
git commit -m "feat(backend): receive support replies from Telegram and email an away merchant"
```

---

### Task 7: Webhook registration script

**Files:**
- Create: `apps/backend/scripts/telegramWebhook.ts`
- Modify: `apps/backend/package.json` (scripts)

**Interfaces:**
- Consumes: Task 3 (`pollRefusal`).
- Produces: `pnpm --filter @bitetime/backend telegram:webhook <set <backend-url> | info | poll [target]>`.

`pollRefusal` already has its unit test (Task 3). The script itself is thin I/O, so this task checks it by running it.

- [ ] **Step 1: Write the script**

```ts
// apps/backend/scripts/telegramWebhook.ts
// Register or inspect the support chat webhook, or forward updates to a LOCAL backend.
//
//   telegram:webhook set https://api.example.com   → setWebhook (a HUMAN runs this for production)
//   telegram:webhook info                          → getWebhookInfo
//   telegram:webhook poll [http://localhost:8787]  → getUpdates → POST the local webhook route
//
// Reads process.env directly (loaded by --env-file), NOT src/env.ts: that module requires the
// Stripe variables, which have nothing to do with this.
//
// `poll` is the support chat's `stripe listen`. Telegram refuses getUpdates on a bot with a
// webhook, so poll mode needs a SEPARATE dev bot — and refuses to run on one with a webhook,
// because deleting it would silently stop every merchant's replies in production.
import { pollRefusal } from '../src/supportChat.js'

const token = process.env.PLATFORM_TG_TOKEN ?? ''
const secret = process.env.PLATFORM_TG_WEBHOOK_SECRET ?? ''
if (!token || !secret) {
  console.error('Set PLATFORM_TG_TOKEN and PLATFORM_TG_WEBHOOK_SECRET in apps/backend/.env first.')
  process.exit(1)
}

async function tg(method: string, body?: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const data = (await res.json()) as { ok: boolean; result?: any; description?: string }
  if (!data.ok) throw new Error(`${method}: ${data.description}`)
  return data.result
}

const [command, arg] = process.argv.slice(2)

if (command === 'set') {
  if (!arg) { console.error('Usage: telegram:webhook set <backend-url>'); process.exit(1) }
  const url = `${arg.replace(/\/+$/, '')}/api/telegram/support-webhook`
  await tg('setWebhook', { url, secret_token: secret, allowed_updates: ['message'] })
  console.log(`Webhook set: ${url}`)
} else if (command === 'info') {
  console.log(await tg('getWebhookInfo'))
} else if (command === 'poll') {
  const info = await tg('getWebhookInfo')
  const refusal = pollRefusal(info.url ?? '')
  if (refusal) { console.error(refusal); process.exit(1) }
  const target = `${(arg ?? 'http://localhost:8787').replace(/\/+$/, '')}/api/telegram/support-webhook`
  console.log(`Forwarding updates to ${target}. Ctrl-C stops.`)
  let offset = 0
  for (;;) {
    const updates = (await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] })) as { update_id: number }[]
    for (const u of updates) {
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
        body: JSON.stringify(u),
      }).catch((e) => { console.error('forward failed:', e.message); return null })
      console.log(`update ${u.update_id} → ${res?.status ?? 'no response'}`)
      // Advance only past what the backend accepted, like Telegram itself would retry.
      if (res && res.status < 500) offset = u.update_id + 1
    }
  }
} else {
  console.error('Usage: telegram:webhook <set <backend-url> | info | poll [target]>')
  process.exit(1)
}
```

- [ ] **Step 2: Add the package script**

In `apps/backend/package.json` `scripts`, after `release:version`:

```json
    "telegram:webhook": "node --import jiti/register --env-file=.env scripts/telegramWebhook.ts"
```

- [ ] **Step 3: Check the usage path runs**

Run: `pnpm --filter @bitetime/backend telegram:webhook`
Expected: with the two variables set, it prints the usage line and exits 1. Without them, it prints "Set PLATFORM_TG_TOKEN and PLATFORM_TG_WEBHOOK_SECRET…" and exits 1. Either output proves the script loads; it makes no Telegram call.

Do NOT run `set` against production. That is a human step after the merge.

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: PASS. If ESLint does not cover `scripts/`, that is the existing project setup; do not change it.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/scripts/telegramWebhook.ts apps/backend/package.json
git commit -m "feat(backend): add the Telegram webhook script with a local poll mode"
```

---

### Task 8: Frontend data layer and FAQ data

**Files:**
- Modify: `apps/frontend/src/store.ts` (after `setFeedbackStatus`)
- Create: `apps/frontend/src/merchant/supportFaq.ts`
- Create: `apps/frontend/src/merchant/supportFaq.test.ts`

**Interfaces:**
- Consumes: Task 1 types. `apiGet`, `apiSend`, `apiSendForm`, `apiGetFile`, `mapOk`, `toVoid` from `./api`.
- Produces:
  - `listSupportMessages(merchantId: string, after?: string): Promise<Result<SupportFeed>>`
  - `sendSupportMessage(merchantId: string, body: string, files?: File[]): Promise<Result<SupportSendResult>>`
  - `markSupportRead(merchantId: string): Promise<Result<void>>`
  - `fetchSupportImage(merchantId: string, messageId: string, index: number): Promise<Result<Blob>>`
  - `interface Bilingual { en: string; zh: string }`
  - `interface FaqItem { id: string; q: Bilingual; a: Bilingual; link?: { section: string; sub?: string; label: Bilingual } }`
  - `interface FaqGroup { id: string; title: Bilingual; items: FaqItem[] }`
  - `SUPPORT_FAQ: FaqGroup[]`

- [ ] **Step 1: Write the failing FAQ data test**

```ts
// apps/frontend/src/merchant/supportFaq.test.ts
import { describe, it, expect } from 'vitest'
import { SUPPORT_FAQ } from './supportFaq'

// The dashboard's own section and Settings sub-tab keys (Dashboard.tsx SECTIONS, ShopSettings.tsx
// tabs). A link to a key that does not exist lands the merchant on Overview with no explanation.
const SECTIONS = ['overview', 'orders', 'products', 'storefront', 'vouchers', 'customers', 'settings']
const SETTINGS_SUBS = ['shipping', 'fulfilment', 'payment', 'brand', 'marketing', 'notifications', 'subscription', 'referral', 'devices']

describe('SUPPORT_FAQ', () => {
  const items = SUPPORT_FAQ.flatMap(g => g.items)

  it('has groups, and every group has at least one question', () => {
    expect(SUPPORT_FAQ.length).toBeGreaterThan(0)
    for (const g of SUPPORT_FAQ) expect(g.items.length).toBeGreaterThan(0)
  })

  it('gives every title, question and answer both languages', () => {
    for (const g of SUPPORT_FAQ) {
      expect(g.title.en.trim()).not.toBe('')
      expect(g.title.zh.trim()).not.toBe('')
    }
    for (const i of items) {
      for (const text of [i.q.en, i.q.zh, i.a.en, i.a.zh]) expect(text.trim()).not.toBe('')
    }
  })

  it('uses unique ids', () => {
    const ids = [...SUPPORT_FAQ.map(g => g.id), ...items.map(i => i.id)]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('links only to sections and sub-tabs that exist', () => {
    for (const i of items) {
      if (!i.link) continue
      expect(SECTIONS).toContain(i.link.section)
      if (i.link.sub) {
        expect(i.link.section).toBe('settings')
        expect(SETTINGS_SUBS).toContain(i.link.sub)
      }
    }
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @bitetime/frontend test -- supportFaq`
Expected: FAIL, "Failed to resolve import './supportFaq'".

- [ ] **Step 3: Write the FAQ data**

Every answer below comes from facts recorded in `CLAUDE.md`. The owner must read the copy before release (see the hand-off note at the end of this plan).

```ts
// apps/frontend/src/merchant/supportFaq.ts
// The support panel's fixed FAQ. Data, not markup, so a copy change never touches layout — the
// same split as marketing/faq.ts. A merchant taps a question; nothing here matches free text.
// supportFaq.test.ts pins both languages, unique ids and that every link targets a real section.

export interface Bilingual { en: string; zh: string }

export interface FaqItem {
  id: string
  q: Bilingual
  a: Bilingual
  /** A dashboard section (and Settings sub-tab) the answer points to. */
  link?: { section: string; sub?: string; label: Bilingual }
}

export interface FaqGroup {
  id: string
  title: Bilingual
  items: FaqItem[]
}

export const SUPPORT_FAQ: FaqGroup[] = [
  {
    id: 'orders',
    title: { en: 'Orders', zh: '订单' },
    items: [
      {
        id: 'orders-notify',
        q: { en: 'How do I hear about a new order?', zh: '有新订单时我怎么知道？' },
        a: {
          en: 'Every shop gets an email for each new order. You can also connect your own Telegram bot, and then your phone buzzes for every order too.',
          zh: '每个店铺都会在有新订单时收到邮件。你也可以连接自己的 Telegram 机器人，这样每张订单手机都会提醒你。',
        },
        link: { section: 'settings', sub: 'notifications', label: { en: 'Open Notifications', zh: '打开通知设置' } },
      },
      {
        id: 'orders-number',
        q: { en: 'What does an order number mean?', zh: '订单号是什么意思？' },
        a: {
          en: 'An order number is your shop prefix, the date (YYMMDD), then a daily counter. The counter starts at 50 each day.',
          zh: '订单号由店铺前缀、日期（年月日）和每日序号组成。每天的序号从 50 开始。',
        },
      },
    ],
  },
  {
    id: 'billing',
    title: { en: 'Billing', zh: '账单' },
    items: [
      {
        id: 'billing-trial',
        q: { en: 'How does the free trial work?', zh: '免费试用怎么运作？' },
        a: {
          en: 'Every new shop gets a 7-day free trial. You do not need a card to start. Add a card before the trial ends to keep your shop open.',
          zh: '每个新店铺都有 7 天免费试用，开始时不需要信用卡。请在试用结束前添加信用卡，店铺才会继续营业。',
        },
        link: { section: 'settings', sub: 'subscription', label: { en: 'Open Subscription', zh: '打开订阅' } },
      },
      {
        id: 'billing-price',
        q: { en: 'How much does TinyOrder cost?', zh: 'TinyOrder 收费多少？' },
        a: {
          en: 'One plan, RM39.90 a month. You can also pay yearly.',
          zh: '只有一个方案，每月 RM39.90。你也可以按年付费。',
        },
        link: { section: 'settings', sub: 'subscription', label: { en: 'Open Subscription', zh: '打开订阅' } },
      },
    ],
  },
  {
    id: 'storefront',
    title: { en: 'Storefront', zh: '店面' },
    items: [
      {
        id: 'storefront-arrange',
        q: { en: 'How do I change the order of my products?', zh: '怎么调整产品的顺序？' },
        a: {
          en: 'Open the Storefront section. Drag a section or a product to a new position. The storefront shows the same order.',
          zh: '打开“店面”栏目，把分类或产品拖到新的位置。店面会按同样的顺序显示。',
        },
        link: { section: 'storefront', label: { en: 'Open Storefront', zh: '打开店面' } },
      },
      {
        id: 'storefront-colour',
        q: { en: 'Can I use my own brand colour?', zh: '可以用自己的品牌颜色吗？' },
        a: {
          en: 'Yes. Pick a colour in Settings → Brand. TinyOrder adjusts the shades so that all text stays easy to read.',
          zh: '可以。在“设置 → 品牌”里选择颜色。TinyOrder 会自动调整深浅，让文字始终清楚易读。',
        },
        link: { section: 'settings', sub: 'brand', label: { en: 'Open Brand', zh: '打开品牌设置' } },
      },
    ],
  },
  {
    id: 'account',
    title: { en: 'Account', zh: '账户' },
    items: [
      {
        id: 'account-devices',
        q: { en: 'Why did I get signed out on another device?', zh: '为什么另一台设备被登出了？' },
        a: {
          en: 'A merchant account can stay signed in on 2 devices. When you sign in on a third, the device you used least recently signs out.',
          zh: '一个商家账户最多可以在 2 台设备上保持登录。在第三台设备登录时，最久没用的那台会被登出。',
        },
        link: { section: 'settings', sub: 'devices', label: { en: 'Open Devices', zh: '打开设备' } },
      },
    ],
  },
]
```

- [ ] **Step 4: Run the FAQ test to see it pass**

Run: `pnpm --filter @bitetime/frontend test -- supportFaq`
Expected: PASS.

- [ ] **Step 5: Add the store functions**

Add the import of the types to the existing `@bitetime/shared` import in `store.ts`: `SupportFeed, SupportSendResult`, and `validateSupportMessage`. Then add after `setFeedbackStatus`:

```ts
// ── Support chat ──────────────────────────────────────────────────────────────
// docs/superpowers/specs/2026-10-02-support-chat-design.md. The panel polls listSupportMessages;
// `after` is the id of the last message it holds.

export async function listSupportMessages(merchantId: string, after?: string): Promise<Result<SupportFeed>> {
  const qs = after ? `?after=${encodeURIComponent(after)}` : ''
  return apiGet<SupportFeed>(`/api/merchants/${merchantId}/support/messages${qs}`, { auth: true })
}

export async function sendSupportMessage(
  merchantId: string,
  body: string,
  files: File[] = [],
): Promise<Result<SupportSendResult>> {
  // Both checks run here first so the merchant is told before the request, in the same words the
  // backend would use — the same reason submitFeedback validates before it sends.
  const text = validateSupportMessage(body)
  if (!text.ok) return { ok: false, error: { code: text.code, message: text.error } }
  const images = validateFeedbackImages(files.map(f => ({ type: f.type, size: f.size })))
  if (!images.ok) {
    const name = images.index === null ? null : files[images.index]?.name
    return { ok: false, error: { code: images.code, message: name ? `${images.error}: ${name}` : images.error } }
  }

  const form = new FormData()
  form.append('body', text.value)
  for (const file of files) form.append('images', file)
  return apiSendForm<SupportSendResult>(`/api/merchants/${merchantId}/support/messages`, form, { auth: true })
}

export async function markSupportRead(merchantId: string): Promise<Result<void>> {
  return toVoid(await apiSend(`/api/merchants/${merchantId}/support/read`, 'POST', undefined, { auth: true }))
}

export async function fetchSupportImage(merchantId: string, messageId: string, index: number): Promise<Result<Blob>> {
  const r = await apiGetFile(`/api/merchants/${merchantId}/support/messages/${messageId}/images/${index}`, { auth: 'required' })
  return mapOk(r, d => d.blob)
}
```

- [ ] **Step 6: Typecheck and test**

Run: `pnpm typecheck && pnpm --filter @bitetime/frontend test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/store.ts apps/frontend/src/merchant/supportFaq.ts apps/frontend/src/merchant/supportFaq.test.ts
git commit -m "feat(frontend): add the support chat store calls and the FAQ data"
```

---

### Task 9: Move the feedback form out of `FeedbackFab`

**Files:**
- Create: `apps/frontend/src/merchant/FeedbackForm.tsx`
- Modify: `apps/frontend/src/merchant/FeedbackFab.tsx` (temporarily uses `FeedbackForm`; deleted in Task 11)

**Interfaces:**
- Produces: `default function FeedbackForm({ onDone }: { onDone: () => void }): JSX.Element` — renders the category select, message, screenshots, error and thank-you; calls `onDone()` after the thank-you timer.

This is a move with no change in behaviour. No new test: UI is verified by running the app (CLAUDE.md), and Task 11's run-and-verify covers the form.

- [ ] **Step 1: Create `FeedbackForm.tsx` from `FeedbackFab.tsx`**

Copy `FeedbackFab.tsx` to `FeedbackForm.tsx`, then make exactly these changes in the copy:

1. Rename the component and change its signature:

```tsx
export default function FeedbackForm({ onDone }: { onDone: () => void }) {
```

2. Delete the `open` state, the `session` ref, and the `change()` function. A form now lives exactly as long as its panel view, so unmount does the reset that `change()` did.

3. Replace the `session` guard with a mounted guard. Add, next to the other refs:

```tsx
  // The form unmounts when the merchant leaves the feedback view. A submission still in flight
  // then resolves against a component that is gone; this guard keeps it from setting state.
  // The request itself is not cancelled and still writes the row.
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
```

In `send()`, delete `const startedIn = session.current` and replace `if (session.current !== startedIn) return` with `if (!mounted.current) return`.

4. In `send()`, replace the auto-close call `setTimeout(() => change(false), …)` with `setTimeout(onDone, …)`, keeping the same two delays (3200 / 1600).

5. Delete the floating `<Button …>` and the `<Dialog>` / `<DialogContent>` / `<DialogHeader>` wrappers. Return the body only:

```tsx
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">
        {t('Tell us what is working and what is not. We read every message.',
           '告诉我们哪些好用、哪些不好用。我们会阅读每一条留言。')}
      </p>
      {sent ? (
        /* the existing thank-you block, unchanged */
      ) : (
        /* the existing form block, unchanged — select, textarea, screenshots, error, submit, SupportLinks */
      )}
    </div>
  )
```

The two comments above mark where the existing JSX goes; move that JSX in without edits.

6. Remove the imports that are now unused: `MessageSquarePlus`, the `Dialog*` components. Keep `if (!merchant) return null`.

- [ ] **Step 2: Point `FeedbackFab` at the new form, so the app keeps working until Task 11**

Replace the dialog body in `FeedbackFab.tsx` with the new component. The whole file becomes:

```tsx
import { useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { useSession } from '../SessionContext'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Button } from '../components/ui/button'
import FeedbackForm from './FeedbackForm'
import { cn } from '@/lib/utils'

// Temporary shell around FeedbackForm. SupportFab replaces this file in the next task.
export default function FeedbackFab() {
  const { t, merchant } = useSession()
  const [open, setOpen] = useState(false)
  if (!merchant) return null
  const title = t('Send feedback', '发送反馈')
  return (
    <>
      <Button
        type="button"
        size="none"
        onClick={() => setOpen(true)}
        aria-label={title}
        title={title}
        className={cn(
          'fixed z-notif-panel bottom-[calc(1.5rem+env(safe-area-inset-bottom))] right-6 max-sm:bottom-[calc(1.25rem+env(safe-area-inset-bottom))] max-sm:right-5',
          'gap-2 rounded-pill px-4 py-3 shadow-elev-2',
          '[@media(pointer:coarse)]:min-h-[48px]',
        )}
      >
        <MessageSquarePlus size={18} strokeWidth={1.75} />
        <span className="text-[13px] font-medium max-sm:sr-only">{title}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="p-6">
          <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
          {open && <FeedbackForm onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  )
}
```

- [ ] **Step 3: Lint, typecheck and build**

Run: `pnpm lint && pnpm typecheck && pnpm --filter @bitetime/frontend build`
Expected: PASS.

- [ ] **Step 4: Check the form still works**

Run `pnpm dev`, sign in as a local merchant, open the feedback button, send one message with one screenshot. Expected: the thank-you shows, then the dialog closes. Then close the dialog during a send. Expected: no console error.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/merchant/FeedbackForm.tsx apps/frontend/src/merchant/FeedbackFab.tsx
git commit -m "refactor(frontend): move the feedback form out of FeedbackFab"
```

---

### Task 10: Poll rules and the feed hook

**Files:**
- Create: `apps/frontend/src/merchant/supportFeed.ts`
- Create: `apps/frontend/src/merchant/supportFeed.test.ts`
- Create: `apps/frontend/src/merchant/useSupportFeed.ts`

**Interfaces:**
- Consumes: Task 8 store calls; `SupportMessage` (Task 1).
- Produces:
  - `POLL_OPEN_MS = 5000`, `POLL_CLOSED_MS = 60000`
  - `pollDelay(s: { open: boolean; hidden: boolean }): number | null`
  - `mergeMessages(current: SupportMessage[], incoming: SupportMessage[]): SupportMessage[]`
  - `interface OutboxItem { localId: string; body: string; files: File[]; state: 'sending' | 'failed'; error?: string }`
  - `useSupportFeed(merchantId: string | null, open: boolean): { messages: SupportMessage[]; outbox: OutboxItem[]; unread: number; available: boolean; notAlerted: boolean; send(body: string, files: File[]): Promise<boolean>; retry(localId: string): Promise<void>; discard(localId: string): void; markRead(): void }`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/frontend/src/merchant/supportFeed.test.ts
import { describe, it, expect } from 'vitest'
import type { SupportMessage } from '@bitetime/shared'
import { pollDelay, mergeMessages, POLL_OPEN_MS, POLL_CLOSED_MS } from './supportFeed'

const msg = (id: string, created_at: string, sender: 'merchant' | 'admin' = 'merchant'): SupportMessage =>
  ({ id, sender, body: id, image_count: 0, created_at })

describe('pollDelay', () => {
  it('polls fast while open, slowly while closed, and never while hidden', () => {
    expect(pollDelay({ open: true, hidden: false })).toBe(POLL_OPEN_MS)
    expect(pollDelay({ open: false, hidden: false })).toBe(POLL_CLOSED_MS)
    expect(pollDelay({ open: true, hidden: true })).toBeNull()
    expect(pollDelay({ open: false, hidden: true })).toBeNull()
  })
})

describe('mergeMessages', () => {
  it('appends new messages in time order', () => {
    const a = msg('a', '2026-10-02T10:00:00.000Z')
    const b = msg('b', '2026-10-02T10:01:00.000Z', 'admin')
    expect(mergeMessages([a], [b])).toEqual([a, b])
  })

  it('shows a message once when the send response and a poll both carry it', () => {
    const a = msg('a', '2026-10-02T10:00:00.000Z')
    const mine = msg('mine', '2026-10-02T10:02:00.000Z')
    expect(mergeMessages(mergeMessages([a], [mine]), [mine])).toEqual([a, mine])
  })

  it('keeps a reply that landed before my own message, in its place', () => {
    // My send returned first; the poll then brings the reply AND my message.
    const mine = msg('mine', '2026-10-02T10:02:00.000Z')
    const reply = msg('reply', '2026-10-02T10:01:30.000Z', 'admin')
    expect(mergeMessages([mine], [reply, mine]).map(m => m.id)).toEqual(['reply', 'mine'])
  })

  it('returns the same array when nothing is new, so React skips a render', () => {
    const a = msg('a', '2026-10-02T10:00:00.000Z')
    const current = [a]
    expect(mergeMessages(current, [a])).toBe(current)
    expect(mergeMessages(current, [])).toBe(current)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @bitetime/frontend test -- supportFeed`
Expected: FAIL, "Failed to resolve import './supportFeed'".

- [ ] **Step 3: Write `supportFeed.ts`**

```ts
// apps/frontend/src/merchant/supportFeed.ts
// The support chat's two pure rules: how often to poll, and how a poll joins what is on screen.
import type { SupportMessage } from '@bitetime/shared'

export const POLL_OPEN_MS = 5_000
export const POLL_CLOSED_MS = 60_000

/** Null means "do not poll": a hidden tab asks nobody anything. */
export function pollDelay(s: { open: boolean; hidden: boolean }): number | null {
  if (s.hidden) return null
  return s.open ? POLL_OPEN_MS : POLL_CLOSED_MS
}

/**
 * Join by id, order by time then id — the same order the backend's cursor uses. A message can
 * arrive twice (in a send response, then in the next poll), and a reply can be OLDER than a
 * message already on screen, so this cannot simply append.
 */
export function mergeMessages(current: SupportMessage[], incoming: SupportMessage[]): SupportMessage[] {
  const known = new Set(current.map(m => m.id))
  const fresh = incoming.filter(m => !known.has(m.id))
  if (fresh.length === 0) return current
  return [...current, ...fresh].sort((x, y) =>
    x.created_at === y.created_at ? (x.id < y.id ? -1 : 1) : (x.created_at < y.created_at ? -1 : 1))
}
```

The sort's id tie-break compares the UUID strings, and Postgres compares `uuid` values byte by byte. For lower-case hex UUIDs the two orders are the same.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm --filter @bitetime/frontend test -- supportFeed`
Expected: PASS.

- [ ] **Step 5: Write the hook**

```ts
// apps/frontend/src/merchant/useSupportFeed.ts
// Polls the support chat and holds what is on screen. The cursor (the id of the last message the
// browser holds) moves ONLY on a poll, never on a send: a reply stored between the last poll and
// my message would otherwise sit behind the cursor and never show.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SupportMessage } from '@bitetime/shared'
import { listSupportMessages, sendSupportMessage, markSupportRead } from '../store'
import { pollDelay, mergeMessages } from './supportFeed'

export interface OutboxItem {
  localId: string
  body: string
  files: File[]
  state: 'sending' | 'failed'
  error?: string
}

export function useSupportFeed(merchantId: string | null, open: boolean) {
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [outbox, setOutbox] = useState<OutboxItem[]>([])
  const [unread, setUnread] = useState(0)
  const [available, setAvailable] = useState(true)
  const [notAlerted, setNotAlerted] = useState(false)
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  const cursor = useRef<string | null>(null)

  useEffect(() => {
    const onChange = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  // No reset on a merchantId change: a merchant owns one shop, and the one caller that could
  // switch shops — a superadmin in "view as shop" — never mounts the bubble (SupportFab).

  const poll = useCallback(async () => {
    if (!merchantId) return
    const r = await listSupportMessages(merchantId, cursor.current ?? undefined)
    if (!r.ok) return // the next interval tries again; one failed poll is not news
    setUnread(r.data.unread)
    setAvailable(r.data.available)
    const incoming = r.data.messages
    if (incoming.length) {
      cursor.current = incoming[incoming.length - 1].id
      setMessages(prev => mergeMessages(prev, incoming))
    }
  }, [merchantId])

  // Polls at once on every change (opening the panel, the tab coming back), then on the interval.
  useEffect(() => {
    const delay = pollDelay({ open, hidden })
    if (delay === null || !merchantId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      await poll()
      if (!stopped) timer = setTimeout(tick, delay)
    }
    void tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [open, hidden, merchantId, poll])

  const deliver = useCallback(async (item: OutboxItem): Promise<boolean> => {
    if (!merchantId) return false
    const r = await sendSupportMessage(merchantId, item.body, item.files)
    if (!r.ok) {
      setOutbox(prev => prev.map(o => o.localId === item.localId ? { ...o, state: 'failed', error: r.error.message } : o))
      return false
    }
    setOutbox(prev => prev.filter(o => o.localId !== item.localId))
    setMessages(prev => mergeMessages(prev, [r.data.message]))
    setNotAlerted(!r.data.alerted)
    return true
  }, [merchantId])

  const send = useCallback(async (body: string, files: File[]) => {
    const item: OutboxItem = { localId: crypto.randomUUID(), body, files, state: 'sending' }
    setOutbox(prev => [...prev, item])
    return deliver(item)
  }, [deliver])

  const retry = useCallback(async (localId: string) => {
    const item = outbox.find(o => o.localId === localId)
    if (!item) return
    setOutbox(prev => prev.map(o => o.localId === localId ? { ...o, state: 'sending', error: undefined } : o))
    await deliver({ ...item, state: 'sending' })
  }, [outbox, deliver])

  const discard = useCallback((localId: string) => {
    setOutbox(prev => prev.filter(o => o.localId !== localId))
  }, [])

  const markRead = useCallback(() => {
    if (!merchantId) return
    setUnread(0)
    void markSupportRead(merchantId)
  }, [merchantId])

  return { messages, outbox, unread, available, notAlerted, send, retry, discard, markRead }
}
```

- [ ] **Step 6: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/merchant/supportFeed.ts apps/frontend/src/merchant/supportFeed.test.ts apps/frontend/src/merchant/useSupportFeed.ts
git commit -m "feat(frontend): add the support chat poll and merge rules"
```

---

### Task 11: The bubble, the panel and the chat view

**Files:**
- Create: `apps/frontend/src/merchant/SupportChat.tsx`
- Create: `apps/frontend/src/merchant/SupportPanel.tsx`
- Create: `apps/frontend/src/merchant/SupportFab.tsx`
- Delete: `apps/frontend/src/merchant/FeedbackFab.tsx`
- Modify: `apps/frontend/src/merchant/Dashboard.tsx` (import line 15, mount line 161)
- Modify: `apps/frontend/src/merchant/PendingScreen.tsx`
- Modify: `apps/frontend/src/merchant/SuspendedScreen.tsx`

**Interfaces:**
- Consumes: Task 8 (`SUPPORT_FAQ`, `FaqGroup`, `FaqItem`, `fetchSupportImage`), Task 9 (`FeedbackForm`), Task 10 (`useSupportFeed`, `OutboxItem`). `SupportLinks` (existing). `FEEDBACK_MAX_IMAGES`, `FEEDBACK_IMAGE_TYPES`, `SUPPORT_MAX_LENGTH` from `@bitetime/shared`.
- Produces: `default function SupportFab({ onNavigate }: { onNavigate?: (section: string, sub?: string) => void })`.

No component tests: UI is verified by running the app (CLAUDE.md). The pure parts already have tests in Tasks 8 and 10.

- [ ] **Step 1: Write `SupportChat.tsx`**

```tsx
// apps/frontend/src/merchant/SupportChat.tsx
// The chat view. Messages come from useSupportFeed; this file only renders and collects input.
import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Send, X } from 'lucide-react'
import {
  FEEDBACK_IMAGE_TYPES, FEEDBACK_MAX_IMAGES, SUPPORT_MAX_LENGTH, type SupportMessage,
} from '@bitetime/shared'
import { useSession } from '../SessionContext'
import { fetchSupportImage } from '../store'
import { Textarea } from '../components/ui/textarea'
import { Button } from '../components/ui/button'
import SupportLinks from './SupportLinks'
import type { OutboxItem } from './useSupportFeed'
import { cn } from '@/lib/utils'

interface Props {
  merchantId: string
  messages: SupportMessage[]
  outbox: OutboxItem[]
  notAlerted: boolean
  onSend: (body: string, files: File[]) => Promise<boolean>
  onRetry: (localId: string) => void
  onDiscard: (localId: string) => void
}

export default function SupportChat({ merchantId, messages, outbox, notAlerted, onSend, onRetry, onDiscard }: Props) {
  const { t } = useSession()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const end = useRef<HTMLDivElement>(null)

  // Keep the newest message in view as messages arrive.
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages.length, outbox.length])

  const trimmed = text.trim()
  const canSend = trimmed.length > 0 && trimmed.length <= SUPPORT_MAX_LENGTH

  const submit = async () => {
    if (!canSend) return
    const body = trimmed
    const picked = files
    // Clear at once: the message now shows in the outbox, with Retry if it fails.
    setText(''); setFiles([])
    await onSend(body, picked)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
        {messages.length === 0 && outbox.length === 0 && (
          <p className="py-6 text-center text-[13px] text-muted-foreground">
            {t('Usually we reply within a few hours, 9am–6pm MYT.', '我们通常在几个小时内回复（马来西亚时间上午 9 点至下午 6 点）。')}
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {messages.map(m => (
            <li key={m.id} className={cn('flex', m.sender === 'merchant' ? 'justify-end' : 'justify-start')}>
              <div className={cn(
                'max-w-[85%] rounded-lg px-3 py-2 text-[14px] whitespace-pre-wrap break-words',
                m.sender === 'merchant' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
              )}>
                {m.sender === 'admin' && (
                  <span className="mb-0.5 block text-[11px] font-medium text-muted-foreground">
                    {t('TinyOrder team', 'TinyOrder 团队')}
                  </span>
                )}
                {m.body}
                {m.image_count > 0 && (
                  <div className="mt-2 flex gap-1.5">
                    {Array.from({ length: m.image_count }, (_, i) => (
                      <SupportImage key={i} merchantId={merchantId} messageId={m.id} index={i} />
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
          {outbox.map(o => (
            <li key={o.localId} className="flex flex-col items-end gap-1">
              <div className="max-w-[85%] rounded-lg bg-primary/60 px-3 py-2 text-[14px] text-primary-foreground whitespace-pre-wrap break-words">
                {o.body}
              </div>
              {o.state === 'sending' ? (
                <span className="text-[11px] text-muted-foreground">{t('Sending…', '发送中…')}</span>
              ) : (
                <span className="flex items-center gap-2 text-[11px] text-danger-fg">
                  {o.error || t('Not sent', '未发送')}
                  <button type="button" className="underline cursor-pointer" onClick={() => onRetry(o.localId)}>
                    {t('Retry', '重试')}
                  </button>
                  <button type="button" className="underline cursor-pointer" onClick={() => onDiscard(o.localId)}>
                    {t('Discard', '放弃')}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {notAlerted && (
          <div role="status" className="mt-3 rounded-md border border-border p-3 text-[12px]">
            <p className="mb-1">{t('We saved your message, but we could not alert the team. Email us instead.',
              '我们已保存你的留言，但未能通知团队。请改用邮件联系我们。')}</p>
            <SupportLinks compact />
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="border-t border-border p-3">
        {files.length > 0 && (
          <ul className="mb-2 flex gap-2">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px]">
                {f.name}
                <button type="button" aria-label={t(`Remove ${f.name}`, `移除 ${f.name}`)} className="cursor-pointer"
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit() } }}
            rows={2}
            aria-label={t('Your message', '你的留言')}
            placeholder={t('Type your question…', '输入你的问题…')}
            className="min-h-[44px] flex-1 resize-none"
          />
          <label className={cn('cursor-pointer p-2 text-primary', files.length >= FEEDBACK_MAX_IMAGES && 'pointer-events-none opacity-50')}
            title={t('Attach screenshots', '添加截图')}>
            <ImagePlus size={18} strokeWidth={1.75} />
            <input type="file" className="sr-only" multiple accept={FEEDBACK_IMAGE_TYPES.join(',')}
              aria-label={t('Attach screenshots', '添加截图')}
              onChange={e => {
                const chosen = Array.from(e.target.files ?? [])
                setFiles(prev => [...prev, ...chosen].slice(0, FEEDBACK_MAX_IMAGES))
                e.target.value = ''
              }} />
          </label>
          <Button type="button" size="icon" disabled={!canSend} onClick={() => void submit()} aria-label={t('Send', '发送')}>
            <Send size={16} />
          </Button>
        </div>
        {trimmed.length > SUPPORT_MAX_LENGTH && (
          <p className="mt-1 text-right text-[11px] text-danger-fg">{trimmed.length} / {SUPPORT_MAX_LENGTH}</p>
        )}
      </div>
    </div>
  )
}

/** One screenshot thumbnail. The bucket is private, so the bytes come through the backend. */
function SupportImage({ merchantId, messageId, index }: { merchantId: string; messageId: string; index: number }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let made: string | null = null
    void fetchSupportImage(merchantId, messageId, index).then(r => {
      if (!alive || !r.ok) return
      made = URL.createObjectURL(r.data)
      setUrl(made)
    })
    return () => { alive = false; if (made) URL.revokeObjectURL(made) }
  }, [merchantId, messageId, index])
  if (!url) return <div className="h-14 w-14 rounded-md bg-background/40" />
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      <img src={url} alt="" className="h-14 w-14 rounded-md object-cover" />
    </a>
  )
}
```

The image picker re-checks type and size in `sendSupportMessage` (Task 8), so a wrong file fails as a "Not sent" outbox item with the reason, and the merchant keeps the text.

- [ ] **Step 2: Write `SupportPanel.tsx`**

```tsx
// apps/frontend/src/merchant/SupportPanel.tsx
// The support panel: FAQ → answer, the chat, and the feedback form, as views of one card.
import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, MessageCircle, MessageSquarePlus, X } from 'lucide-react'
import { useSession } from '../SessionContext'
import { Button } from '../components/ui/button'
import SupportLinks from './SupportLinks'
import SupportChat from './SupportChat'
import FeedbackForm from './FeedbackForm'
import { SUPPORT_FAQ, type FaqGroup, type FaqItem } from './supportFaq'
import type { useSupportFeed } from './useSupportFeed'
import { cn } from '@/lib/utils'

type View =
  | { kind: 'home' }
  | { kind: 'group'; group: FaqGroup }
  | { kind: 'answer'; group: FaqGroup; item: FaqItem }
  | { kind: 'chat' }
  | { kind: 'feedback' }

interface Props {
  merchantId: string
  feed: ReturnType<typeof useSupportFeed>
  onClose: () => void
  onNavigate?: (section: string, sub?: string) => void
}

export default function SupportPanel({ merchantId, feed, onClose, onNavigate }: Props) {
  const { t } = useSession()
  const [view, setView] = useState<View>({ kind: 'home' })
  const T = (b: { en: string; zh: string }) => t(b.en, b.zh)

  // Esc closes, like the dialog this replaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // In the chat view, every new reply counts as read.
  const adminCount = feed.messages.filter(m => m.sender === 'admin').length
  useEffect(() => {
    if (view.kind === 'chat' && feed.unread > 0) feed.markRead()
  }, [view.kind, adminCount, feed])

  const back = () => setView(view.kind === 'answer' ? { kind: 'group', group: view.group } : { kind: 'home' })
  const talk = () => setView({ kind: 'chat' })

  const title =
    view.kind === 'chat' ? t('TinyOrder team', 'TinyOrder 团队')
    : view.kind === 'feedback' ? t('Send feedback', '发送反馈')
    : view.kind === 'group' || view.kind === 'answer' ? T(view.group.title)
    : t('Help', '帮助')

  const row = 'flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-[14px] hover:bg-muted cursor-pointer'

  return (
    <div
      role="dialog"
      aria-label={t('Help', '帮助')}
      className={cn(
        'fixed z-notif-panel flex flex-col overflow-hidden bg-background shadow-elev-3',
        'right-6 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] h-[560px] max-h-[calc(100dvh-7rem)] w-[380px] rounded-lg border border-border',
        'max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:rounded-none max-sm:border-0',
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        {view.kind !== 'home' && (
          <button type="button" onClick={back} aria-label={t('Back', '返回')} className="p-1 cursor-pointer">
            <ArrowLeft size={18} />
          </button>
        )}
        <h2 className="flex-1 text-[15px] font-medium">{title}</h2>
        <button type="button" onClick={onClose} aria-label={t('Close', '关闭')} className="p-1 cursor-pointer">
          <X size={18} />
        </button>
      </header>

      {view.kind === 'home' && (
        <div className="flex-1 overflow-y-auto p-3">
          {feed.messages.length > 0 && (
            <button type="button" className={cn(row, 'mb-2 bg-muted')} onClick={talk}>
              {t('Continue your conversation', '继续对话')}
              {feed.unread > 0 && <span className="rounded-pill bg-danger px-2 text-[11px] text-white">{feed.unread}</span>}
            </button>
          )}
          <p className="px-3 pb-2 text-[13px] text-muted-foreground">{t('Hi! How can we help?', '你好！需要什么帮助？')}</p>
          {SUPPORT_FAQ.map(g => (
            <button key={g.id} type="button" className={row} onClick={() => setView({ kind: 'group', group: g })}>
              {T(g.title)} <ChevronRight size={16} />
            </button>
          ))}
          <div className="mt-3 border-t border-border pt-3">
            <button type="button" className={row} onClick={talk}>
              <span className="flex items-center gap-2"><MessageCircle size={16} />{t('Talk to a person', '联系客服')}</span>
            </button>
            <button type="button" className={row} onClick={() => setView({ kind: 'feedback' })}>
              <span className="flex items-center gap-2"><MessageSquarePlus size={16} />{t('Send feedback', '发送反馈')}</span>
            </button>
          </div>
        </div>
      )}

      {view.kind === 'group' && (
        <div className="flex-1 overflow-y-auto p-3">
          {view.group.items.map(item => (
            <button key={item.id} type="button" className={row}
              onClick={() => setView({ kind: 'answer', group: view.group, item })}>
              {T(item.q)} <ChevronRight size={16} />
            </button>
          ))}
        </div>
      )}

      {view.kind === 'answer' && (
        <div className="flex-1 overflow-y-auto p-4">
          <h3 className="mb-2 text-[15px] font-medium">{T(view.item.q)}</h3>
          <p className="whitespace-pre-line text-[14px] text-foreground">{T(view.item.a)}</p>
          {view.item.link && onNavigate && (
            <Button type="button" variant="outline" className="mt-3"
              onClick={() => { onNavigate(view.item.link!.section, view.item.link!.sub); onClose() }}>
              {T(view.item.link.label)}
            </Button>
          )}
          <div className="mt-6 border-t border-border pt-4">
            <p className="mb-2 text-[13px] text-muted-foreground">{t('Did this help?', '这个回答有帮助吗？')}</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setView({ kind: 'home' })}>{t('Yes', '有')}</Button>
              <Button type="button" onClick={talk}>{t('Talk to a person', '联系客服')}</Button>
            </div>
          </div>
        </div>
      )}

      {view.kind === 'chat' && (
        feed.available ? (
          <SupportChat
            merchantId={merchantId}
            messages={feed.messages}
            outbox={feed.outbox}
            notAlerted={feed.notAlerted}
            onSend={feed.send}
            onRetry={(id) => void feed.retry(id)}
            onDiscard={feed.discard}
          />
        ) : (
          <div className="flex-1 p-4">
            <p className="mb-3 text-[14px]">{t('Chat is not available right now. Contact us here:', '目前无法使用聊天。请通过以下方式联系我们：')}</p>
            <SupportLinks />
          </div>
        )
      )}

      {view.kind === 'feedback' && (
        <div className="flex-1 overflow-y-auto p-4">
          <FeedbackForm onDone={() => setView({ kind: 'home' })} />
        </div>
      )}
    </div>
  )
}
```

Before you finish this step, check that `shadow-elev-3`, `bg-danger` and the `Button` variants `outline` and size `icon` exist (`grep -n "elev-3\|--color-danger" apps/frontend/src/index.css apps/frontend/src/tokens.css`, `grep -n "outline\|icon" apps/frontend/src/components/ui/button.tsx`). Use the nearest existing token or variant if one is missing. The memory note `shadcn-add-pitfalls` records that `icon-sm` is missing here.

- [ ] **Step 3: Write `SupportFab.tsx`**

```tsx
// apps/frontend/src/merchant/SupportFab.tsx
// The help bubble (docs/superpowers/specs/2026-10-02-support-chat-design.md). Replaces FeedbackFab
// in the same position and z-index, and adds the red dot for an unread reply.
//
// Hidden from a superadmin by ROLE, not by `merchant`: in "view as shop" mode SessionContext sets
// `merchant` to the impersonated shop, so a `!merchant` check alone would show the bubble.
import { useCallback, useState } from 'react'
import { LifeBuoy } from 'lucide-react'
import { useSession } from '../SessionContext'
import { Button } from '../components/ui/button'
import SupportPanel from './SupportPanel'
import { useSupportFeed } from './useSupportFeed'
import { cn } from '@/lib/utils'

export default function SupportFab({ onNavigate }: { onNavigate?: (section: string, sub?: string) => void }) {
  const { t, merchant, role } = useSession()
  const [open, setOpen] = useState(false)
  const hidden = !merchant || role === 'superadmin'
  // The hook runs before the early return (rules of hooks); a null id makes it do nothing.
  const feed = useSupportFeed(hidden ? null : merchant!.id, open)
  const close = useCallback(() => setOpen(false), [])

  if (hidden) return null
  const title = t('Help', '帮助')

  return (
    <>
      {!open && (
        <Button
          type="button"
          size="none"
          onClick={() => setOpen(true)}
          aria-label={feed.unread > 0 ? t(`${title} — new reply`, `${title}——有新回复`) : title}
          title={title}
          className={cn(
            'fixed z-notif-panel bottom-[calc(1.5rem+env(safe-area-inset-bottom))] right-6 max-sm:bottom-[calc(1.25rem+env(safe-area-inset-bottom))] max-sm:right-5',
            'gap-2 rounded-pill px-4 py-3 shadow-elev-2',
            '[@media(pointer:coarse)]:min-h-[48px]',
          )}
        >
          <LifeBuoy size={18} strokeWidth={1.75} />
          <span className="text-[13px] font-medium max-sm:sr-only">{title}</span>
          {feed.unread > 0 && (
            <span aria-hidden className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-pill bg-danger ring-2 ring-background" />
          )}
        </Button>
      )}
      {open && <SupportPanel merchantId={merchant!.id} feed={feed} onClose={close} onNavigate={onNavigate} />}
    </>
  )
}
```

- [ ] **Step 4: Mount it and delete `FeedbackFab`**

In `apps/frontend/src/merchant/Dashboard.tsx`:
- Replace `import FeedbackFab from './FeedbackFab'` with `import SupportFab from './SupportFab'`.
- Replace `<FeedbackFab />` with `<SupportFab onNavigate={selectSection} />`. `selectSection` is the guarded section switch already defined in this file (it routes through the unsaved-changes guard, so a dirty Settings form is not lost).

In `apps/frontend/src/merchant/PendingScreen.tsx` and `apps/frontend/src/merchant/SuspendedScreen.tsx`:
- Add `import SupportFab from './SupportFab'`.
- Render `<SupportFab />` as the last child of the outermost returned element. No `onNavigate`: these screens have no dashboard sections, so the FAQ hides its section links.

Delete the old file:

```bash
git rm apps/frontend/src/merchant/FeedbackFab.tsx
```

Then check that nothing else imports it: `grep -rn "FeedbackFab" apps/frontend/src` must print only comments, if any. Update a comment that names `FeedbackFab` to name `SupportFab`/`FeedbackForm` instead.

- [ ] **Step 5: Lint, typecheck, test, build**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: PASS.

- [ ] **Step 6: Run and verify in the browser**

Use the `/verify` skill (local Supabase + both dev servers). For the Telegram leg, put a DEV bot's token and a DEV forum supergroup's id in `apps/backend/.env` (`PLATFORM_TG_TOKEN`, `PLATFORM_SUPPORT_CHAT_ID`, `PLATFORM_TG_WEBHOOK_SECRET`), restart the backend, and run `pnpm --filter @bitetime/backend telegram:webhook poll` in a separate terminal.

Check each item and record the result:

| # | Do | Expected |
|---|---|---|
| 1 | Sign in as a merchant. | A "Help" bubble at the bottom right. No separate feedback button. |
| 2 | Open it → Billing → "How does the free trial work?" → "Open Subscription". | The panel closes. The dashboard shows Settings → Subscription. |
| 3 | Open the panel → "Send feedback" → send one message. | The thank-you shows, then the Home view returns. The row is in `/admin` feedback. |
| 4 | "Talk to a person" → send `Joe *Star* 🍰 蛋糕` with one screenshot. | It shows at once as "Sending…", then as a sent message with a thumbnail. In Telegram, a new topic "<shop> (<slug>)" holds the header, the exact text and the photo. |
| 5 | Reply in that Telegram topic. | Within about 5 seconds the reply shows in the panel as "TinyOrder team". |
| 6 | Close the panel. Reply again in Telegram. | Within about 60 seconds the bubble shows a red dot. Opening the chat clears it. |
| 7 | Close the dashboard tab for 3 minutes. Reply in Telegram. | One "You have a reply from TinyOrder support" email (with `RESEND_API_KEY` unset, the backend log shows the skip line with this subject). |
| 8 | Send a photo in the Telegram topic. | The bot answers in the topic: "Photos do not reach the merchant. Send text." Nothing new in the panel. |
| 9 | Stop the backend. Send a message. Start the backend. Press "Retry". | "Not sent" with Retry and Discard, then the message sends. |
| 10 | Phone width (375 px). Open the panel and the chat. | A full-screen sheet. The text box stays visible above the keyboard. No horizontal scroll. |
| 11 | Switch to 中文. | Every panel string is Chinese. |
| 12 | Sign in as the superadmin and "view as" the shop. | No bubble. |
| 13 | Unset `PLATFORM_SUPPORT_CHAT_ID`, restart, open "Talk to a person". | "Chat is not available right now" with the email and WhatsApp links. The FAQ still works. |
| 14 | Set a local shop to `suspended`. Sign in as its owner. | The suspended screen shows the bubble, and a message sends. |

If the bubble or a poll shows old code, read the memory notes `jiti-cache-staleness`, `taskstop-leaves-dev-servers-running` and `stale-service-worker-localhost-5173` before you debug.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/merchant/SupportChat.tsx apps/frontend/src/merchant/SupportPanel.tsx \
  apps/frontend/src/merchant/SupportFab.tsx apps/frontend/src/merchant/Dashboard.tsx \
  apps/frontend/src/merchant/PendingScreen.tsx apps/frontend/src/merchant/SuspendedScreen.tsx
git commit -m "feat(dashboard): replace the feedback button with a help panel and support chat"
```

---

### Task 12: Record the feature in the project docs

**Files:**
- Modify: `CLAUDE.md` (new subsection under `## Architecture`, after `### Claude API (@anthropic-ai/sdk)`; one line in `## Commands`)
- Modify: `CONTEXT.md` (new `## Support chat` entry, after `## Order notifications`)

- [ ] **Step 1: Add the CLAUDE.md subsection**

```markdown
### Support chat

The dashboard's **Help** bubble (`merchant/SupportFab.tsx`) answers from a fixed bilingual FAQ (`merchant/supportFaq.ts`), then lets the merchant talk to the superadmin through **Telegram**. Each shop gets one **forum topic** in the `PLATFORM_SUPPORT_CHAT_ID` supergroup, created on its first message; the superadmin replies in that topic and `POST /api/telegram/support-webhook` stores the reply. The browser **polls** (5 s open, 60 s closed, none while hidden) — there is no Realtime, because `src/supabase.ts` deliberately ships without `realtime-js`. The bubble replaced `FeedbackFab`; the feedback form lives on as one of its views (`FeedbackForm.tsx`). Spec: `docs/superpowers/specs/2026-10-02-support-chat-design.md`.

Split: `supportChat.ts` (pure — texts, update parser, secret compare), `supportTelegram.ts` (Bot API adapter, no `parse_mode` ever: the text is a merchant's free text), `supportChatDb.ts` (SQL), `supportDelivery.ts` (claim topic → header → text → photos, one retry when Telegram reports the topic deleted). `supportDeps` on `app.ts` is the test seam.

Three rules that are easy to break:

- **The webhook's status code is for Telegram, not a person.** Any non-2xx makes Telegram send the update again. An ignored update gets `200`; only a failed database write gets `500`, and the partial unique index on `tg_message_id` makes that retry safe.
- **A superadmin passes `requireMerchantOwns`**, so the routes check `merchant.owner_id === user.id` themselves: a superadmin cannot post as the merchant, cannot mark replies read, and their GET does not count as the merchant being "seen" (that would stop the away email). The bubble is hidden by `role`, not by `merchant`, because "view as shop" sets `merchant`.
- **Local work needs a separate dev bot.** Telegram refuses `getUpdates` on a bot with a webhook. `telegram:webhook poll` forwards updates to the local backend and refuses to run on a bot that has one, because deleting the production webhook would silently stop every merchant's replies.
```

In the `## Commands` code block, after the `release:version`-style lines (or at the end of the block), add:

```bash
pnpm --filter @bitetime/backend telegram:webhook poll   # forward a DEV bot's updates to the local support webhook (the support chat's `stripe listen`)
pnpm --filter @bitetime/backend telegram:webhook set <backend-url>   # HUMAN ONLY for production — registers the support webhook
```

- [ ] **Step 2: Add the CONTEXT.md entry**

```markdown
## Support chat

A conversation between **one shop** and the **platform** (the superadmin), never between a shop and its customers. One **support thread** per shop, for all time — there is no ticket and no closed state. A **support message** is from the `merchant` or from the `admin`. The merchant writes in the dashboard's Help panel; the admin writes in that shop's Telegram forum topic. Merchant messages may carry up to three screenshots; admin replies are text only.

The **FAQ** in the same panel is fixed content the merchant taps through; nothing matches free text and no model answers. **Talk to a person** is the step from the FAQ into the thread.

An **away email** tells a shop owner that the admin replied while they were not looking: only when the dashboard has not polled for two minutes, at most one per hour per shop, and it carries no reply text — the dashboard is where the conversation lives.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CONTEXT.md
git commit -m "docs: record the support chat in CLAUDE.md and CONTEXT.md"
```

---

## Hand-off notes for the owner

- **Production still needs four human steps** after the merge: make the forum supergroup and add the bot as an admin with "Manage topics"; set `PLATFORM_SUPPORT_CHAT_ID` and `PLATFORM_TG_WEBHOOK_SECRET` on Railway; run `db:push` for `20261002120000_support_chat.sql`; run `telegram:webhook set <backend-url>`.
- **Read the FAQ copy** in `supportFaq.ts` before release. Each answer comes from a fact in `CLAUDE.md`, but the wording and the choice of questions are yours.
- **The "9am–6pm MYT" promise** in the empty chat view is a placeholder for your real support hours. Change it in `SupportChat.tsx` if it is wrong.
