// Customer sign-up, server-side.
//
// The project-wide email-confirmation setting stays ON — it is shared with merchants,
// and a merchant account controls a shop and its Stripe billing. So a customer cannot
// be created by a plain client-side signUp: that returns no session, which strands them
// in their inbox holding a cart. They are created pre-confirmed here instead, with the
// service role, and the client signs in normally afterwards.
//
// What that knowingly costs: a customer's email is never verified. The blast radius is
// small and self-correcting — whoever owns the address can reclaim it by password reset,
// and we send customers no other mail.
//
// The policy below is pure; the two things that touch the world (account creation, the
// profile write) are injected adapters, as is the rate-limit check.

import { isPasswordLongEnough } from '@bitetime/shared'

export type CreateUserResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'duplicate_email' | 'error' }

export interface SignupDeps {
  createUser: (input: { email: string; password: string }) => Promise<CreateUserResult>
  writeProfile: (input: { userId: string; email: string }) => Promise<void>
  /**
   * Records a hit against one rate-limit key and reports whether it was within the limit.
   * `kind` picks the window, so a caller cannot land in the wrong one by mistyping a prefix.
   */
  allow: (kind: 'ip' | 'email', value: string) => boolean
  logError: (message: string) => void
}

export type SignupErrorCode = 'invalid_email' | 'weak_password' | 'duplicate_email' | 'rate_limited' | 'server'

export type SignupResult =
  | { ok: true; userId: string }
  | { ok: false; error: SignupErrorCode; status: 400 | 409 | 429 | 502 }

// Deliberately loose: Supabase is the real validator. This only catches the obviously
// malformed before a request is worth spending rate-limit budget on.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function signUpCustomer(
  deps: SignupDeps,
  input: { email?: unknown; password?: unknown; ip?: string },
): Promise<SignupResult> {
  const email = String(input.email ?? '').trim().toLowerCase()
  const password = String(input.password ?? '')

  if (!EMAIL.test(email)) return { ok: false, error: 'invalid_email', status: 400 }
  // The rule is shared with the panel (@bitetime/shared) — one number, two workspaces.
  // Enforced here too, so no account is ever created with a password the product refuses:
  // Supabase's own floor is lower than ours, and the panel is not a security boundary.
  if (!isPasswordLongEnough(password)) return { ok: false, error: 'weak_password', status: 400 }

  // IP and email are separate windows, so exhausting one email cannot block a different one
  // from the same address. The IP is checked first and short-circuits: a blocked caller
  // spends none of a stranger's email budget.
  if (!deps.allow('ip', input.ip ?? 'unknown')) return { ok: false, error: 'rate_limited', status: 429 }
  if (!deps.allow('email', email)) return { ok: false, error: 'rate_limited', status: 429 }

  const created = await deps.createUser({ email, password })
  if (!created.ok) {
    if (created.reason === 'duplicate_email') {
      // Stated plainly rather than hidden behind a generic "check your email". This does
      // make the endpoint an email-enumeration oracle — accepted knowingly: for a food-
      // ordering app the leak is low-harm, and the alternative strands a returning
      // customer mid-checkout with no session and no error they can act on.
      return { ok: false, error: 'duplicate_email', status: 409 }
    }
    return { ok: false, error: 'server', status: 502 }
  }

  // The account exists from here on. A failed profile write must not fail the request —
  // the customer would meet their own duplicate email on the retry, with no session. The
  // client's idempotent profile upsert on SIGNED_IN closes the gap.
  try {
    await deps.writeProfile({ userId: created.userId, email })
  } catch (err) {
    deps.logError(`Profile write failed for new customer ${created.userId}: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { ok: true, userId: created.userId }
}

// Supabase reports an address that is already registered in more than one shape depending
// on version; treat any of them as the duplicate outcome.
export function isDuplicateEmailError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const { code, status, message } = err as { code?: string; status?: number; message?: string }
  if (code === 'email_exists') return true
  const text = (message ?? '').toLowerCase()
  if (status === 422 && text.includes('already been registered')) return true
  return text.includes('already registered') || text.includes('already been registered')
}
