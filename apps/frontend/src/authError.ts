// Supabase auth failures, reduced to the handful of outcomes a customer can act on.
// Kept pure so the panel that shows them stays a dumb view: the mapping is the logic.
export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'rate_limited'
  | 'unknown'

export function authErrorCode(err: unknown): AuthErrorCode {
  if (!err || typeof err !== 'object') return 'unknown'
  const { code, status, message } = err as { code?: string; status?: number; message?: string }

  if (code === 'invalid_credentials') return 'invalid_credentials'
  if (code === 'email_not_confirmed') return 'email_not_confirmed'
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') return 'rate_limited'
  if (status === 429) return 'rate_limited'

  // supabase-js only started sending `code` recently; the message is the fallback.
  const text = (message ?? '').toLowerCase()
  if (text.includes('invalid login credentials')) return 'invalid_credentials'
  if (text.includes('email not confirmed')) return 'email_not_confirmed'
  if (text.includes('rate limit')) return 'rate_limited'

  return 'unknown'
}
