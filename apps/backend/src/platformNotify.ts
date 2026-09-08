// The PLATFORM's Telegram arm — one chat, owned by the superadmin, told when a shop is born.
//
// Not to be confused with `notify.ts`, which is the MERCHANT's arm: that one reads a token out
// of `merchant_secrets` per shop, this one reads a single pair out of the environment. They
// share only the `TelegramSend` adapter, deliberately — one fetch of the Bot API is enough.
//
// Pure by construction: no `env.ts`, no `supabase.ts`, no `db.ts` import, so `pnpm test` drives
// it with no stack and no network. The caller passes the config in, the same way the Claude
// adapters take their API key as a parameter.
import type { NotifyResult } from './orderNotice.js'
import type { TelegramSend } from './notify.js'

/**
 * A merchant-chosen name reaches this message, and the message goes out with
 * `parse_mode: 'Markdown'`. One unbalanced `*` or `_` is not a formatting glitch — Telegram
 * refuses the whole `sendMessage` with a 400, and the superadmin never hears about the shop.
 *
 * The markers are REMOVED rather than backslash-escaped: Telegram's legacy Markdown does not
 * document `\` escapes (only MarkdownV2 does), so escaping would be a guess. A shop called
 * `Joe *Star*` reads as `Joe Star` in the alert, which costs nothing, and the send cannot fail.
 *
 * Clamped too. Nothing here is unbounded like a cart, but `merchants.name` is free text and the
 * ceiling (4096) is worth staying far below rather than measuring against.
 */
const FIELD_MAX = 120

export function plainField(value: unknown): string {
  return String(value ?? '')
    .replace(/[*_`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FIELD_MAX)
}

export interface MerchantSignupInput {
  merchant: {
    id: string
    name: string
    slug: string
    business_nature?: string | null
    currency?: string | null
    billing_cycle?: string | null
    status: string
  }
  /** The account that owns the shop. Null when the caller could not read it — see below. */
  ownerEmail?: string | null
  /** What `startCardlessTrial` returned. Decides the status line, never the status itself. */
  trial: boolean
  frontendUrl: string
}

/**
 * Pure: render the alert.
 *
 * The status line is the point of the message. A shop at `active` is open and selling; a shop at
 * `pending` is one Stripe refused, and until its owner retries it sells nothing. Both look like
 * a successful signup from every other angle, so the alert names which one happened.
 */
export function buildMerchantSignupMessage(input: MerchantSignupInput): string {
  const { merchant: m, frontendUrl } = input
  const status = `${plainField(m.status)} — ${input.trial ? 'trial started' : 'trial not started'}`
  const owner = plainField(input.ownerEmail) || 'unknown'
  const base = String(frontendUrl ?? '').replace(/\/+$/, '')

  let msg = '🏪 *New merchant*\n\n'
  msg += `*Shop:* ${plainField(m.name)}\n`
  msg += `*Slug:* ${plainField(m.slug)}\n`
  msg += `*Owner:* ${owner}\n`
  msg += `*Trade:* ${plainField(m.business_nature) || 'unknown'}\n`
  msg += `*Currency:* ${plainField(m.currency) || 'unknown'}\n`
  msg += `*Billing:* ${plainField(m.billing_cycle) || 'unknown'}\n`
  msg += `*Status:* ${status}\n`
  msg += `\n${base}/s/${plainField(m.slug)}\n`
  msg += `${base}/admin/merchants`
  return msg
}

export interface PlatformTelegramConfig {
  token: string
  chatId: string
}

/**
 * Send the alert, or skip it.
 *
 * An unset pair is the ordinary state of a dev machine and of any deployment that never
 * configured one, so it is a SKIP — never an error and never a throw. The signup that produced
 * this call has already committed, and nothing about telling the superadmin may undo it.
 */
export async function notifyMerchantSignup(
  send: TelegramSend,
  cfg: PlatformTelegramConfig,
  input: MerchantSignupInput,
): Promise<NotifyResult> {
  if (!cfg.token || !cfg.chatId) return { ok: true, skipped: true }
  try {
    await send(cfg.token, cfg.chatId, buildMerchantSignupMessage(input))
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}
