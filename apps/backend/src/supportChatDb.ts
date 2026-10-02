// Support chat — the SQL. db.ts connects as the database OWNER, so no RLS runs here: every
// function takes the merchant id as an argument that a route guard has already proven.
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

/**
 * A merchant writing again reopens a thread the superadmin marked done. `wasResolved` tells the
 * caller to reopen the Telegram topic too; the flag is cleared HERE, in the same transaction as
 * the insert, so the message and the reopening cannot be split by a crash between them.
 */
export async function insertMerchantMessage(
  input: { merchantId: string; userId: string; body: string },
): Promise<{ message: SupportMessage; wasResolved: boolean }> {
  return withTransaction(async (tx) => {
    await tx`insert into support_threads (merchant_id) values (${input.merchantId}) on conflict do nothing`
    const reopened = await tx`
      update support_threads set resolved_at = null
       where merchant_id = ${input.merchantId} and resolved_at is not null
      returning merchant_id`
    const [row] = await tx<Row[]>`
      insert into support_messages (merchant_id, sender, author_user_id, body)
      values (${input.merchantId}, 'merchant', ${input.userId}, ${input.body})
      returning id, sender, body, image_paths, created_at`
    return { message: toMessage(row), wasResolved: reopened.length > 0 }
  })
}

/** The superadmin closed (true) or reopened (false) the shop's topic in Telegram. */
export async function setThreadResolved(merchantId: string, resolved: boolean): Promise<void> {
  await sql`
    update support_threads set resolved_at = ${resolved ? sql`now()` : null}
     where merchant_id = ${merchantId}`
}

export async function threadResolvedAt(merchantId: string): Promise<string | null> {
  const [r] = await sql<{ resolved_at: Date | null }[]>`
    select resolved_at from support_threads where merchant_id = ${merchantId}`
  return r?.resolved_at ? r.resolved_at.toISOString() : null
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
  return withTransaction(async (tx) => {
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
