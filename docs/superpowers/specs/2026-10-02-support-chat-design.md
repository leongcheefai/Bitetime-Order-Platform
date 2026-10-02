# Support chat — design

Date: 2026-10-02

## Purpose

A merchant asks for help from a chat bubble at the bottom right of the dashboard. The bubble
first answers from a fixed list of FAQ entries. When no entry helps, the merchant talks to a
person. The message goes to the platform's Telegram supergroup, in one forum topic for each
shop. The superadmin replies in that topic from Telegram, and the reply shows in the merchant's
chat.

Success means two things. A merchant gets an answer without email. The superadmin answers from a
phone without opening `/admin`.

## Decisions

| Decision | Choice |
|---|---|
| The existing `FeedbackFab` | Merged. One bubble opens one panel with the FAQ, "Talk to a person" and "Send feedback". |
| Who replies | The superadmin only, from one Telegram forum supergroup. |
| Shop ↔ Telegram mapping | One forum topic for each shop. The topic id identifies the shop. A reply needs no swipe-to-reply. |
| FAQ selection | The merchant taps a question from a grouped list. No free-text match, no Claude call. |
| Live replies | The browser polls the backend. No Supabase Realtime: `src/supabase.ts` leaves out `realtime-js` on purpose. |
| Merchant away | A red dot on the bubble, plus one email when the merchant did not poll in the last 2 minutes. Maximum one email per hour for each shop. |
| Images | The merchant can attach up to 3 screenshots. The superadmin replies with text only. |
| Who sees the bubble | Every merchant, every plan, every shop status (active, pending, suspended). Not a superadmin. |
| Bot | The existing platform bot (`PLATFORM_TG_TOKEN`). |

## Flow

```
 Merchant dashboard                Backend (Hono)                    Telegram supergroup
 ──────────────────                ──────────────                    ───────────────────
 SupportFab panel
   │ tap FAQ ──► answer (local data, no network)
   │
   │ "Talk to a person"
   │ POST /support/messages ──► insert support_messages
   │   (text + ≤3 images)        ensure topic for the shop ───────► createForumTopic "Shop (slug)"
   │                             sendMessage / sendPhoto ─────────► the shop's topic
   │                                                                     │
   │                                                                superadmin replies
   │                                                                     │
   │                             POST /api/telegram/support-webhook ◄────┘
   │                               check secret header + chat id
   │                               topic id → merchant
   │                               insert support_messages (admin)
   │                               merchant away? ──► one email (Resend), max 1/hour
   │
   │ GET /support/messages?after=… (poll)
   ◄── new messages + unread count
```

## Data

One migration adds two tables and one private storage bucket.

### `support_threads`

| Column | Type | Note |
|---|---|---|
| `merchant_id` | `uuid` PK, FK → `merchants(id)` on delete cascade | One thread for each shop, for all time. |
| `tg_topic_id` | `bigint` unique, nullable | Null until the first message reaches Telegram. Cleared when the topic is gone. |
| `merchant_last_seen_at` | `timestamptz`, nullable | Written by each poll. The away-email rule reads it. |
| `merchant_last_read_at` | `timestamptz`, nullable | Written when the chat view opens. The unread count reads it. |
| `last_away_email_at` | `timestamptz`, nullable | The away-email throttle. |
| `created_at` | `timestamptz` default `now()` | |

### `support_messages`

| Column | Type | Note |
|---|---|---|
| `id` | `uuid` PK default `gen_random_uuid()` | |
| `merchant_id` | `uuid` not null, FK → `support_threads(merchant_id)` on delete cascade | |
| `sender` | `text` not null, check in (`merchant`, `admin`) | |
| `author_user_id` | `uuid`, nullable | The merchant's user for a `merchant` row. Null for `admin`. |
| `body` | `text` not null, check `char_length(body) between 1 and 2000` | |
| `image_paths` | `text[]` not null default `'{}'`, check `cardinality(image_paths) <= 3` | Paths in the private `support-images` bucket, never URLs. |
| `tg_message_id` | `bigint`, nullable | The Telegram id of the reply (`admin`) or of the forwarded post (`merchant`). |
| `created_at` | `timestamptz` not null default `now()` | |

- Unique index on `(tg_message_id)` where `sender = 'admin'`. A repeated Telegram update makes no
  second row.
- Index on `(merchant_id, created_at)`.
- RLS on, and **no grants** to `anon` or `authenticated` on either table. Every read and write goes
  through the backend, the same as `merchant_feedback`.
- Bucket `support-images`: private, no `storage.objects` policies. The backend uploads with the
  service role and serves each image through its own route.

The `after` cursor of the poll is the `created_at` of the last message the browser holds, with
`id` as the tie-break.

## Environment

| Variable | Use | Unset |
|---|---|---|
| `PLATFORM_SUPPORT_CHAT_ID` | The forum supergroup. Can equal `PLATFORM_TG_CHAT_ID`; the signup alerts then go to "General". | "Talk to a person" answers `503 support_unavailable`. |
| `PLATFORM_TG_WEBHOOK_SECRET` | Telegram sends it in `X-Telegram-Bot-Api-Secret-Token`. | The webhook answers `503`. |

Both are optional in `env.ts`, the same posture as `GOOGLE_MAPS_API_KEY`. With either unset, the
panel shows `SupportLinks` (email, WhatsApp) in place of the chat, and the FAQ still works.

## Backend

### Modules

| File | Kind | Does |
|---|---|---|
| `supportChat.ts` | pure | Builds the Telegram texts (topic title, topic header, merchant message). Parses a Telegram update into `{ kind: 'reply', topicId, messageId, text }`, `{ kind: 'photo', topicId }` or `{ kind: 'ignore' }`. Decides the away email. Imports nothing from `env.ts`, `supabase.ts` or `db.ts`. |
| `supportChatDb.ts` | DB | The statements for the two tables. The topic claim uses `withTransaction()` in `db.ts`. |
| `supportTelegram.ts` | adapter | `createForumTopic`, `sendMessage` and `sendPhoto` with `message_thread_id`. Token and chat id are parameters. |
| `packages/shared/src/support.ts` | shared | `SUPPORT_MAX_LENGTH` (2000), `validateSupportMessage`. Images reuse `validateFeedbackImage` and `FEEDBACK_MAX_IMAGES`. |

`app.ts` gets a mutable `supportDeps` object (`telegram`, `email`, `config`), the same seam as
`platformNotifyDeps`, so the API tests drive the real routes with fakes.

### Routes

| Route | Guard | Does |
|---|---|---|
| `GET /api/merchants/:id/support/messages?after=<cursor>` | `requireMerchantOwns` | Returns `{ messages, unread, available }`. Writes `merchant_last_seen_at`. |
| `POST /api/merchants/:id/support/messages` | `requireMerchantOwns` + sliding window (30 per hour per user) | Multipart: `body` + up to 3 images. Answers `201 { message, alerted, images_failed }`. |
| `POST /api/merchants/:id/support/read` | `requireMerchantOwns` | Writes `merchant_last_read_at = now()`. |
| `GET /api/merchants/:id/support/messages/:msgId/images/:index` | `requireMerchantOwns` | Serves one screenshot. The message must belong to `:id`. Every miss is the same 404. |
| `POST /api/telegram/support-webhook` | secret header | Receives the superadmin's replies. |

The merchant id always comes from the route guard, never from the body. The backend writes
through the RLS-exempt clients, so this rule is the tenant boundary.

`requireMerchantOwns` (`mw.ts`) does not read the shop status, so `pending` and `suspended` shops
pass it, as this feature needs. It also passes a superadmin. A superadmin may read a thread, but
`POST …/support/messages` and `POST …/support/read` answer `403` unless `merchant.owner_id` equals
the caller: a row with `sender = 'merchant'` must come from the merchant, and the superadmin's
reads must not clear the merchant's red dot. For the same reason, a GET by a superadmin does not write `merchant_last_seen_at`, or it would stop the away email.

### Merchant → Telegram

1. Validate the text with the shared validator. Store the row **first**, then upload the images.
   A Telegram failure never loses the merchant's text.
2. Claim the topic. In one transaction: upsert the `support_threads` row, lock it
   (`for update`), and read `tg_topic_id`. When it is null, call `createForumTopic` with the
   title `<shop name> (<slug>)`, write the id, then commit. The lock makes two first messages at
   the same time create one topic. The Telegram call inside the transaction holds the lock for one
   round trip, which is acceptable at this volume.
3. After a new topic, post one header: the shop link, status, plan and owner email.
4. Send the merchant's text with **no `parse_mode`**. One stray `*` in free text makes Telegram
   refuse a Markdown message (the trap `platformNotify.ts` documents). Each image goes as
   `sendPhoto` in the same topic.
5. When Telegram answers "message thread not found" (the topic was deleted by hand), clear
   `tg_topic_id`, claim a new topic, and try once more.
6. When Telegram still fails, answer `201` with `alerted: false`. The row stays.

### Telegram → merchant (webhook)

The webhook stores a reply only when **all** of these are true:

| Check | Reason |
|---|---|
| The secret header equals `PLATFORM_TG_WEBHOOK_SECRET` (constant-time compare). | The URL is public. A miss answers `401`. |
| `message.chat.id` equals `PLATFORM_SUPPORT_CHAT_ID`. | The bot is in other chats. |
| `message.from.is_bot` is false. | The bot's own posts must not come back as replies. |
| `message.message_thread_id` maps to a `support_threads` row. | A message in "General" belongs to no shop. |
| `message.text` is present. | A photo gets a bot reply in the topic: "Photos do not reach the merchant. Send text." |

- The webhook answers `200` for every update with a valid secret, also an ignored one. On any
  other status, Telegram sends the same update again.
- `edited_message` updates are ignored.
- A reply longer than 2000 characters is cut to 2000, with `…` at the end.

### Away email

After the reply row lands, one statement decides and claims the email:

```sql
update support_threads
   set last_away_email_at = now()
 where merchant_id = $1
   and (merchant_last_seen_at is null or merchant_last_seen_at < now() - interval '2 minutes')
   and (last_away_email_at   is null or last_away_email_at   < now() - interval '1 hour')
returning merchant_id
```

The email goes out only when the statement returns a row, so two replies at the same time send one
email. It goes to the shop owner's address through `email.ts`. It holds no reply text: "You have a
reply from TinyOrder support", and a link to `/merchant`. An email failure is logged and changes
nothing else.

### Webhook registration

`pnpm --filter @bitetime/backend telegram:set-webhook <backend-url>` calls `setWebhook` with
`secret_token` and `allowed_updates: ["message"]`. The superadmin runs it for production.

Local work: Telegram cannot reach `localhost`. `telegram:set-webhook --poll` reads `getUpdates`
and posts each update, with the secret header, to the local webhook route — the same idea as
`stripe listen`. Telegram refuses `getUpdates` on a bot that has a webhook, so local work uses a
**separate dev bot and a dev supergroup**. The script refuses `--poll` when `getWebhookInfo`
reports a webhook URL, so it can never delete the production webhook.

## Frontend

### Files

| File | Does |
|---|---|
| `merchant/SupportFab.tsx` | Replaces `FeedbackFab` in `Dashboard.tsx`, with the same position and z-index. Also mounted on `PendingScreen` and `SuspendedScreen`. Shows a red dot when `unread > 0`. Opens the panel. |
| `merchant/SupportPanel.tsx` | The panel and its views. |
| `merchant/SupportChat.tsx` | The chat view: message list, text box, image picker, retry. |
| `merchant/FeedbackForm.tsx` | The form from `FeedbackFab`, moved out with its logic unchanged (session guard, object-URL cleanup). |
| `merchant/supportFaq.ts` | Bilingual FAQ data: groups → questions → answers. An answer can carry a link to a dashboard section. |
| `merchant/useSupportPoll.ts` | 5 s while the panel is open, 60 s while it is closed, no poll while `document.hidden`. |
| `store.ts` | `listSupportMessages`, `sendSupportMessage`, `markSupportRead`, on the `Result<T, E>` convention. |

`FeedbackFab.tsx` is deleted.

### Views

```
┌ Home ──────────────────┐   ┌ FAQ answer ────────────┐   ┌ Chat ──────────────────┐
│ Hi! How can we help?   │   │ ← Back                 │   │ ← Back   TinyOrder team│
│                        │   │ How do I connect       │   │                        │
│ Orders            ›    │   │ Telegram?              │   │  You: My QR does not   │
│ Billing           ›    │   │                        │   │       show… [img]      │
│ Storefront        ›    │   │ 1. Open Settings…      │   │                        │
│ Telegram          ›    │   │ [Open Settings]        │   │  Team: Hi! Please…     │
│                        │   │                        │   │                        │
│ 💬 Talk to a person    │   │ Did this help?         │   │ ┌────────────────┐📎 ➤ │
│ ✎  Send feedback       │   │ [Yes] [Talk to a person]│   │ └────────────────┘    │
└────────────────────────┘   └────────────────────────┘   └────────────────────────┘
```

The fourth view is the feedback form.

- Desktop: a 380 × 560 px card above the bubble. Phone: a full-screen sheet, with the text box
  above the on-screen keyboard.
- With a chat history, Home shows "Continue your conversation" first.
- An empty chat says: "Usually we reply within a few hours, 9am–6pm MYT."
- A sent message shows at once in a "sending" state. On failure it keeps the text and shows
  "Retry".
- With `available: false`, "Talk to a person" opens `SupportLinks` instead of the chat.
- Every string uses `t(en, zh)`. The panel takes the shop's brand colour from `BrandTheme` on the
  dashboard; on `PendingScreen` and `SuspendedScreen` it is platform-coloured.

## Errors

| Case | Result |
|---|---|
| Telegram variables unset | `POST` → `503 support_unavailable`. Panel shows `SupportLinks`. FAQ works. |
| Telegram fails after the row is stored | `201` with `alerted: false`. The message shows, with "We could not alert the team" and the links. |
| A screenshot upload fails | The text lands. `images_failed` names the count, as in the feedback form. |
| Too many messages | `429`. The panel keeps the text. |
| Empty text or more than 2000 characters | `400`, from the shared validator on both sides. |
| Webhook with a bad secret | `401`. Every other bad update → `200`, ignored. |
| A poll fails | The next interval tries again. No error for one failed poll. |

## Tests

| Suite | Covers |
|---|---|
| `tests/unit/supportChat.test.ts` | Update parser: wrong chat, bot sender, no topic, "General", photo only, edited message, accepted reply. Away-email rule at the 2-minute and 1-hour edges. Text build with `*`, `_` and a long shop name. |
| `tests/api/supportChat.test.ts` (real local Postgres) | Merchant A cannot read, post or fetch images in shop B's thread. Two first messages at the same time create one topic. A repeated `tg_message_id` makes one row. Two replies at the same time send one email. Bad secret → 401. "Thread not found" makes a new topic. Pending and suspended shops can post. |
| `tests/rls/` | `anon` and `authenticated` cannot read `support_threads` or `support_messages`. |
| `packages/shared` | `validateSupportMessage`. |
| Run and verify | Bubble, FAQ, a sent message with a screenshot, a reply through the dev bot with `--poll`, the red dot, the away email, the phone layout. |

## Not in version 1

- Photos from the superadmin to the merchant.
- Edits of a Telegram reply.
- A closed or resolved state for a thread.
- Claude answers. `supportFaq.ts` stays the data source for that later.
- Chat for storefront customers.
- An `/admin` inbox. Telegram is the inbox.

## Production steps (human)

1. Make the forum supergroup. Add the bot as an admin with "Manage topics".
2. Set `PLATFORM_SUPPORT_CHAT_ID` and `PLATFORM_TG_WEBHOOK_SECRET` on Railway.
3. Run `db:push` for the migration.
4. Run `telegram:set-webhook` against the production backend URL.
