// Shared auth/tenant middleware. Resolves caller identity (and, for owner routes, the
// owned merchant) once against the service-role `admin` client, then stashes it on the
// context. admin is RLS-EXEMPT, so these functions ARE the tenant boundary on the backend
// path — nothing downstream re-checks. See CLAUDE.md → Backend.
import type { Context, MiddlewareHandler } from 'hono'
import { admin, getUserFromToken } from './supabase.js'

type AuthedUser = NonNullable<Awaited<ReturnType<typeof getUserFromToken>>>

export type AppEnv = {
  Variables: {
    user: AuthedUser
    merchant: Record<string, any>
  }
}

function bearer(c: Parameters<MiddlewareHandler>[0]): string {
  return (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
}

// TODO(P3): drop the email fallback once the superadmin role is seeded everywhere.
async function isSuperadmin(user: AuthedUser): Promise<boolean> {
  const { data } = await admin.from('profiles').select('app_role').eq('user_id', user.id).maybeSingle()
  return data?.app_role === 'superadmin' || user.email === 'bitetime@praxor.dev'
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await getUserFromToken(bearer(c))
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  c.set('user', user)
  await next()
}

export const requireSuperadmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await getUserFromToken(bearer(c))
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  if (!(await isSuperadmin(user))) return c.json({ error: 'Forbidden' }, 403)
  c.set('user', user)
  await next()
}

// For routes carrying `:id`. Loads the merchant, then requires the caller to own it —
// unless they are a superadmin, who passes any tenant guard (mirrors RequireRole in the app).
export const requireMerchantOwns: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await getUserFromToken(bearer(c))
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const id = c.req.param('id')
  if (!id) return c.json({ error: 'Missing merchant id' }, 400)
  const { data: merchant } = await admin.from('merchants').select('*').eq('id', id).maybeSingle()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)
  if (merchant.owner_id !== user.id && !(await isSuperadmin(user))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  c.set('user', user)
  c.set('merchant', merchant)
  await next()
}

/**
 * The one entitlement check (#110). A shop may use a Pro feature iff `merchants.plan === 'pro'`
 * — nothing else, and a NULL plan (every pre-billing shop) is not Pro. The field is trustworthy
 * because it is a field and not a request: the browser holds no grant on `merchants` and `plan`
 * is written only by signup, superadmin comp, or a future checkout/webhook reconciliation, never
 * by an owner request. See CONTEXT.md → Plan entitlement.
 *
 * Superadmins pass, mirroring `requireMerchantOwns` — support and impersonation must not be
 * obstructed by the tier the shop they are standing in pays for. That check costs a profiles
 * lookup, so it only runs on the refusal path, where the request is already lost anyway.
 *
 * Reads the merchant `requireMerchantOwns` already loaded — this MUST run after it.
 */
export async function hasProAccess(c: Context<AppEnv>): Promise<boolean> {
  if (c.get('merchant')?.plan === 'pro') return true
  return isSuperadmin(c.get('user'))
}

/**
 * The refusal every gated surface answers with — deliberately ONE code across all of them, so
 * the frontend maps one string to one upgrade prompt (`REQUIRES_PRO` in the browser's plan.ts).
 */
export const REQUIRES_PRO = 'requires_pro'

// Chain AFTER requireMerchantOwns on an endpoint that is wholly Pro-only. An endpoint shared
// with basic shops (the product upsert, which carries promo fields) cannot use this — it calls
// `hasProAccess` inside the handler instead, once it knows the body is asking for the Pro part.
export const requirePro: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await hasProAccess(c))) return c.json({ error: REQUIRES_PRO }, 403)
  await next()
}
