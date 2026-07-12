// The backend's /api/customer/signup failures, reduced to the outcomes a customer can act
// on. Kept pure and separate from the fetch so the panel showing them stays a dumb view —
// the same split as authError.ts, which covers the Supabase-side sign-in failures.
export type SignupErrorCode =
  | 'duplicate_email'
  | 'weak_password'
  | 'invalid_email'
  | 'rate_limited'
  | 'network'
  | 'server'
  /** The account was created, but the sign-in that follows it failed. */
  | 'signin_failed'

const BY_BODY: Record<string, SignupErrorCode> = {
  duplicate_email: 'duplicate_email',
  weak_password: 'weak_password',
  invalid_email: 'invalid_email',
  rate_limited: 'rate_limited',
}

export function signupErrorCode(status: number, body: unknown): SignupErrorCode {
  const code = (body as { error?: string } | null)?.error
  if (code && BY_BODY[code]) return BY_BODY[code]
  // Anything not shaped like our JSON — a proxy page, a crash — is a server failure.
  if (status === 409) return 'duplicate_email'
  if (status === 429) return 'rate_limited'
  return 'server'
}

// Carries the code through the store's throw so the panel can switch on it.
export class SignupError extends Error {
  constructor(public readonly code: SignupErrorCode) {
    super(code)
    this.name = 'SignupError'
  }
}
