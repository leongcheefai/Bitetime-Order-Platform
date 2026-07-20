// Merchant platform feedback (#89) — data access.
//
// Every statement here is a single write or read, so this uses the REST `admin` client
// rather than db.ts; no transaction is needed. `admin` is the service-role client and is
// RLS-EXEMPT: the route middleware is the tenant boundary, and insertFeedback takes the
// merchant and user as explicit arguments precisely so a caller cannot supply them.
import { admin } from './supabase.js'
import type { FeedbackCategory, FeedbackStatus, FeedbackDraft } from '@bitetime/shared'

export interface FeedbackRow {
  id: string
  merchant_id: string
  user_id: string
  category: FeedbackCategory
  message: string
  status: FeedbackStatus
  created_at: string
  resolved_at: string | null
}

export interface FeedbackWithShop extends FeedbackRow {
  shop_name: string | null
  shop_slug: string | null
}

export async function insertFeedback(input: {
  merchantId: string
  userId: string
  draft: FeedbackDraft
}): Promise<FeedbackRow> {
  const { data, error } = await admin
    .from('merchant_feedback')
    .insert({
      merchant_id: input.merchantId,
      user_id: input.userId,
      category: input.draft.category,
      message: input.draft.message,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data as FeedbackRow
}

export async function listFeedback(status?: FeedbackStatus): Promise<FeedbackWithShop[]> {
  let query = admin
    .from('merchant_feedback')
    .select('*, merchants(name, slug)')
    .order('created_at', { ascending: false })
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw new Error(error.message)

  return (data ?? []).map((row: any) => {
    const { merchants, ...rest } = row
    return { ...rest, shop_name: merchants?.name ?? null, shop_slug: merchants?.slug ?? null }
  })
}

// Reopening clears resolved_at so the column never claims a resolution that was undone.
export async function updateFeedbackStatus(
  id: string,
  status: FeedbackStatus,
): Promise<FeedbackRow | null> {
  const { data, error } = await admin
    .from('merchant_feedback')
    .update({ status, resolved_at: status === 'resolved' ? new Date().toISOString() : null })
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as FeedbackRow) ?? null
}
