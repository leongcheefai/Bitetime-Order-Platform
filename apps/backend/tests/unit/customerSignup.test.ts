import { describe, it, expect, vi } from 'vitest'
import {
  signUpCustomer,
  isDuplicateEmailError,
  MIN_PASSWORD_LENGTH,
  type SignupDeps,
} from '../../src/customerSignup.js'

// Adapters are injected: the account-creation call and the profile write are the only
// two things that touch the outside world, so the policy above them stays pure.
function deps(over: Partial<SignupDeps> = {}): SignupDeps {
  return {
    createUser: vi.fn(async () => ({ ok: true as const, userId: 'user-1' })),
    writeProfile: vi.fn(async () => {}),
    allow: () => true,
    logError: () => {},
    ...over,
  }
}

const GOOD = { email: 'sam@example.com', password: 'hunter2hunter', ip: '1.1.1.1' }

describe('signUpCustomer', () => {
  it('creates the account and its profile, and reports the new user', async () => {
    const d = deps()
    const result = await signUpCustomer(d, GOOD)

    expect(result).toEqual({ ok: true, userId: 'user-1' })
    expect(d.createUser).toHaveBeenCalledWith({ email: 'sam@example.com', password: 'hunter2hunter' })
    expect(d.writeProfile).toHaveBeenCalledWith({ userId: 'user-1', email: 'sam@example.com' })
  })

  it('normalises the email before it reaches either adapter', async () => {
    const d = deps()
    await signUpCustomer(d, { ...GOOD, email: '  Sam@Example.COM ' })

    expect(d.createUser).toHaveBeenCalledWith({ email: 'sam@example.com', password: 'hunter2hunter' })
  })

  it('rejects a short password before any account is created', async () => {
    const d = deps()
    const result = await signUpCustomer(d, { ...GOOD, password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) })

    expect(result).toEqual({ ok: false, error: 'weak_password', status: 400 })
    expect(d.createUser).not.toHaveBeenCalled()
  })

  it('rejects a malformed email before any account is created', async () => {
    const d = deps()
    const result = await signUpCustomer(d, { ...GOOD, email: 'not-an-email' })

    expect(result).toEqual({ ok: false, error: 'invalid_email', status: 400 })
    expect(d.createUser).not.toHaveBeenCalled()
  })

  it('discloses a duplicate email plainly, so the panel can flip to sign-in', async () => {
    const d = deps({ createUser: vi.fn(async () => ({ ok: false as const, reason: 'duplicate_email' as const })) })
    const result = await signUpCustomer(d, GOOD)

    expect(result).toEqual({ ok: false, error: 'duplicate_email', status: 409 })
    expect(d.writeProfile).not.toHaveBeenCalled()
  })

  it('never reaches the account-creation adapter when the request is rate limited', async () => {
    const d = deps({ allow: () => false })
    const result = await signUpCustomer(d, GOOD)

    expect(result).toEqual({ ok: false, error: 'rate_limited', status: 429 })
    expect(d.createUser).not.toHaveBeenCalled()
  })

  it('keys the rate limit by IP and by email independently', async () => {
    const seen: [string, string][] = []
    const d = deps({ allow: (kind, value) => { seen.push([kind, value]); return true } })
    await signUpCustomer(d, GOOD)

    expect(seen).toEqual([['ip', '1.1.1.1'], ['email', 'sam@example.com']])
  })

  it('spends no email budget when the IP is already blocked', async () => {
    const seen: [string, string][] = []
    const d = deps({ allow: (kind, value) => { seen.push([kind, value]); return false } })
    await signUpCustomer(d, GOOD)

    expect(seen).toEqual([['ip', '1.1.1.1']])
  })

  it('reports a failed account creation as a server error', async () => {
    const d = deps({ createUser: vi.fn(async () => ({ ok: false as const, reason: 'error' as const })) })

    expect(await signUpCustomer(d, GOOD)).toEqual({ ok: false, error: 'server', status: 502 })
  })

  it('still signs the customer in when only the profile write fails', async () => {
    // The account exists; failing the request would strand them behind their own duplicate
    // email on the retry. The client's profile upsert on SIGNED_IN is the safety net.
    const logError = vi.fn()
    const d = deps({ writeProfile: vi.fn(async () => { throw new Error('db down') }), logError })
    const result = await signUpCustomer(d, GOOD)

    expect(result).toEqual({ ok: true, userId: 'user-1' })
    expect(logError).toHaveBeenCalled()
  })
})

describe('isDuplicateEmailError', () => {
  it('recognises the error code Supabase sends for an address already registered', () => {
    expect(isDuplicateEmailError({ code: 'email_exists', message: 'Email address already registered' })).toBe(true)
  })

  it('falls back to the message and the 422 status', () => {
    expect(isDuplicateEmailError({ status: 422, message: 'A user with this email address has already been registered' })).toBe(true)
  })

  it('does not mistake an unrelated failure for a duplicate', () => {
    expect(isDuplicateEmailError({ status: 500, message: 'Database error creating new user' })).toBe(false)
    expect(isDuplicateEmailError(null)).toBe(false)
  })
})
