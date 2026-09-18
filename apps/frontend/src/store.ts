import type { User } from '@supabase/auth-js';
import { voucherFromRow, QUOTE_REFUSALS, validateFeedbackImages } from '@bitetime/shared';
import type { FeedbackDraft, FeedbackStatus, Granularity, MerchantStats, OrderEvent, OrderRefusal, PendingShop, QuoteRefusal, Slot } from '@bitetime/shared';
import { revenueQuery, type RevenueSelection } from './merchant/revenueRange';
import { auth, storage } from './supabase';
import { RESERVED_SLUGS } from './slug';
import { SignupError, signupErrorCode } from './signupError'
import type { AddressParts, AdminRelease, EarnedReward, FeedbackItem, Order, PublicRelease, ReferredShop, ReleaseDetail, ShopCustomer, ShopCustomerPage, ShopCustomerSegment, ShopCustomerSort, TrialFeedbackAdminItem, TrialFeedbackOwn, Voucher, VoucherRedemption } from './types';
import type { SavedDetails } from './savedDetails';
import { resetRedirectUrl } from './resetPassword';
import { downscaleImage } from './imageResize';
import { API_URL, apiGet, apiGetFile, apiSend, apiSendFile, apiSendForFile, apiSendForm, mapOk, toVoid } from './api'
import type { Result } from './api'
import type { CartLine } from '@bitetime/shared'

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function signIn(email: string, password: string) {
  const { data, error } = await auth.signInWithPassword({ email, password });
  if (error) throw error;
  // The device limit, enforced by the backend against the session this sign-in just created.
  // Deliberately NOT awaited for its result and never thrown from: a merchant whose sign-in
  // worked must reach their dashboard even if this call did not land. The worst outcome of a
  // missed call is a third live session until the next sign-in, and the worst outcome of a
  // throw here is a merchant who cannot get in at all.
  void enforceDeviceLimit();
  return data.user;
}

/** Whether this account's email address still needs proving, and whether the platform even asks.
 *  See the route in app.ts for why `configured` travels with the answer. */
export function fetchEmailVerification() {
  return apiGet<{ configured: boolean; verified: boolean; email: string }>('/api/me/verify-email', { auth: 'required' })
}

/** Send the address-check link again. `alreadyVerified` is a success, not a failure — the
 *  merchant asked for a confirmed address and it already is one. */
export function resendEmailVerification() {
  return apiSend<{ ok: true; alreadyVerified: boolean }>('/api/me/verify-email/resend', 'POST', undefined, { auth: 'required' })
}

/** Ask the backend to trim this account to its device limit. Failures are swallowed by design. */
async function enforceDeviceLimit() {
  const r = await apiSend<{ evicted: number }>('/api/me/devices/enforce', 'POST', undefined, { auth: 'required' });
  if (!r.ok) console.error('Device limit not enforced:', r.error.message);
}

// Merchant sign-up. Goes through the backend for the SAME reason signUpCustomer below does, and
// through an endpoint of the same shape: email confirmation is on project-wide, so a client-side
// `auth.signUp` returns NO SESSION. The sign-in that follows it then fails, `createMerchant`
// never runs, and the merchant is left in their inbox holding a shop that does not exist — they
// had to confirm, come back and log in before the platform would build anything. Every one of
// those hops loses merchants, and most arrive from an ad inside a webview, where leaving for the
// mail app is leaving for good.
//
// The backend creates the account PRE-CONFIRMED with the service role, so the sign-in right
// after this call succeeds and the whole signup finishes in one submit.
//
// What that knowingly costs: a merchant's email is never verified here. Unlike a customer's, it
// is an address the platform really does write to — Stripe receipts, the trial-ending notice,
// password resets — so a typo is a merchant who hears nothing and cannot reset it. Catching that
// is its own piece of work; nothing in this path depends on the address being real.
//
// `shop` is what the form collected about the SHOP. It still rides along on the auth user's
// metadata: no longer load-bearing for a NEW signup, but it is what lets FinishSignupScreen
// build a shop for an account parked in an inbox before this shipped.
export async function signUp(name: string, email: string, password: string, shop?: PendingShop) {
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/merchant/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name, shop }),
    })
  } catch {
    throw new SignupError('network')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new SignupError(signupErrorCode(res.status, body))
  }
}

// Customer sign-up. Goes through the backend rather than auth.signUp because
// email confirmation is on project-wide (it protects merchants, who own shops and Stripe
// billing) — a client-side signUp would return no session and strand the customer in their
// inbox holding a cart. The backend creates the account pre-confirmed with the service role;
// signing in here is what puts the session in this tab, so the cart survives and the order
// they were placing is recorded against them.
export async function signUpCustomer(email: string, password: string) {
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/customer/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch {
    throw new SignupError('network')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new SignupError(signupErrorCode(res.status, body))
  }
  try {
    return await signIn(email, password)
  } catch {
    // The account exists from here on, so a failure now is NOT a wrong password — telling
    // the customer it was would be a lie about credentials we just set for them. Distinct
    // code, so the panel can say what actually happened and offer sign-in.
    throw new SignupError('signin_failed')
  }
}

// Upserts the caller's GLOBAL profile (merchant_id null) via the backend, which forces
// user_id/merchant_id server-side and allowlists the rest (pickProfileFields in
// apps/backend/src/writes.ts) — see Global Constraint 1. Best-effort: returns the failure as a
// Result rather than throwing, because its caller treats a failure as "try again later", not as
// a hard stop. Both signup endpoints write this row server-side already; the repeat from
// onAuthChange is what fills `referral_code` and what closes the gap when that server-side write
// failed.
async function ensureGlobalProfile(fields: {
  user_id: string
  name: string
  email?: string | null
  email_confirmed: boolean
  referral_code?: string
}): Promise<Result<void>> {
  // user_id is forced to the caller server-side; send everything else.
  const { user_id: _user_id, ...rest } = fields
  return toVoid(await apiSend('/api/me/profile', 'PUT', rest, { auth: true }))
}

export async function fetchProfileByUserId(_userId: string): Promise<Result<any | null>> {
  return apiGet<any | null>('/api/me/profile', { auth: true })
}

/**
 * Save what a signed-in customer just typed at checkout, so they never type it again — at this
 * shop or any other. Silent: the customer asked for none of this and is shown no checkbox.
 *
 * Best-effort by design. It runs after an order is already placed, so a failure here must cost
 * the customer nothing but a retype next time; it must never surface as a failed order — which
 * is now the CALLER's choice: it returns a Result<void> and the storefront simply does not act
 * on `{ ok:false }` (the swallow is at the call site, not baked in here).
 *
 * Writes the GLOBAL profile (merchant_id null) — the same row `ensureGlobalProfile` maintains,
 * via the same `PUT /api/me/profile` upsert. An address belongs to the customer, not to a shop.
 */
export async function saveCustomerDetails(fields: SavedDetails): Promise<Result<void>> {
  if (Object.keys(fields).length === 0) return { ok: true, data: undefined }
  const user = await getCurrentUser()
  // a guest saves nothing, ever — that is what makes the gate's warning true
  if (!user) return { ok: true, data: undefined }
  return toVoid(await apiSend('/api/me/profile', 'PUT', fields, { auth: true }))
}

const MERCHANT_STATUSES = ['pending', 'active', 'suspended']

export async function fetchAllMerchants(): Promise<Result<any[]>> {
  return apiGet<any[]>('/api/merchants', { auth: true })
}

// Status is the billing enforcement boundary and is service_role-only at the DB
// layer (guard_merchant_status trigger). Direct PostgREST updates are blocked, so
// admin suspend/reject/reactivate goes through the superadmin backend endpoint.
export async function setMerchantStatus(id: string, status: string): Promise<Result<any>> {
  if (!MERCHANT_STATUSES.includes(status)) return { ok: false, error: { code: 'invalid_status', message: 'Invalid status' } }
  return apiSend<any>('/api/admin/set-merchant-status', 'POST', { merchantId: id, status }, { auth: 'required' })
}

// Superadmin: comp a merchant — the shop runs with no subscription behind it. Goes through the
// backend, which writes status and the billing row with the service-role key.
export async function compMerchant(id: string): Promise<Result<any>> {
  return apiSend<any>('/api/admin/comp-merchant', 'POST', { merchantId: id }, { auth: 'required' })
}

// Superadmin: revoke a comp. Clears the flag so the shop has to pay; its own status is
// untouched, because suspending is a separate decision.
export async function uncompMerchant(id: string): Promise<Result<any>> {
  return apiSend<any>('/api/admin/uncomp-merchant', 'POST', { merchantId: id }, { auth: 'required' })
}

// Superadmin: flag/unflag a merchant for the landing-page sample-shops carousel (#107).
// Pure flag flip, no billing/status side effect — see set-merchant-sample in app.ts.
export async function setMerchantSample(id: string, isSample: boolean): Promise<Result<any>> {
  return apiSend<any>('/api/admin/set-merchant-sample', 'POST', { merchantId: id, isSample }, { auth: 'required' })
}

// The "could not ask" vs "the answer is empty" distinction, now the shared Result:
// `{ ok: false }` means the request itself never landed (network/CORS/5xx) and a caller that
// would DROP something on that must not treat it as an answer; `{ ok: true, data: null }` is a
// real answer — the slug is reserved, or the backend answered 200 with a null body (no such
// shop). The null-collapsing `fetchMerchantBySlug` twin is gone: a display-only caller takes
// `r.ok ? r.data : null` itself, and `MerchantContext.refresh` reads `r.ok`/`r.data` directly so
// a dropped packet mid-checkout cannot blank an already-loaded storefront.
export async function lookupMerchantBySlug(slug: string | undefined): Promise<Result<any | null>> {
  const s = (slug || '').trim().toLowerCase()
  if (!s || RESERVED_SLUGS.includes(s)) return { ok: true, data: null }
  return apiGet<any | null>(`/api/merchants/${encodeURIComponent(s)}`)
}

// The signed-in user's own shop — same "could not ask" vs "the answer is empty" shape as
// `lookupMerchantBySlug` above, and for a sharper reason. `{ ok: true, data: null }` is a
// real answer: this user owns no shop, so they are a customer. `{ ok: false }` means the
// request never landed, and the caller knows NOTHING about what they own.
//
// There is deliberately no collapsing wrapper. Collapsing "could not ask" into "owns no shop"
// is what broke #98: `SessionContext` derives `role` from this row, so a backend it could not
// reach read as "owns no shop" → role `customer` → `RequireRole` bounced the merchant to the
// landing page. In production every /api/* call was CORS-blocked (the backend's FRONTEND_URL
// did not match the deployed origin), so every merchant login ended on the marketing page
// with no error shown anywhere.
export async function lookupMyMerchant(userId: string): Promise<Result<any | null>> {
  if (!userId) return { ok: true, data: null }
  return apiGet<any | null>('/api/me/merchant', { auth: true })
}

export async function createMerchant({ name, billing = 'monthly', referredByCode, businessNature, currency }: { name: string; billing?: string; referredByCode?: string; businessNature?: string; currency?: string }): Promise<Result<any>> {
  return apiSend<any>('/api/merchants', 'POST', { name, billing, referredByCode, businessNature, currency }, { auth: true })
}

// ── Billing (Stripe via the Hono backend) ──────────────────────────────────────

// Create a Stripe Checkout Session for the current merchant and return its URL.
// Every subscription is charged in MYR; the backend no longer takes a region.
export async function startCheckout({ billing }: { billing: string }): Promise<Result<string>> {
  const r = await apiSend<{ url: string }>('/api/checkout', 'POST', { billing }, { auth: 'required' })
  return mapOk(r, (d) => d.url)
}

/** Why a sync changed nothing — mirrors `SyncReason` in the backend's billingSync.ts. */
export type BillingSyncReason =
  | 'no_billing' | 'comped' | 'no_subscription' | 'not_live' | 'suspended_by_admin'

export interface BillingSync {
  /** The shop's status AFTER the call — authoritative, so the caller need not re-read it. */
  merchantStatus: string
  subscriptionStatus: string | null
  /** True only when this call opened the shop. */
  activated: boolean
  reason?: BillingSyncReason
}

// Ask the backend to re-read this shop's subscription from Stripe and make the database agree.
// The recovery for a `checkout.session.completed` that never arrived: without it the only thing
// that could open a shop after a paid Checkout was that one webhook. Idempotent — safe to call
// on a shop that is already open, where it reports `activated: false`.
export async function syncBilling(): Promise<Result<BillingSync>> {
  return apiSend<BillingSync>('/api/billing/sync', 'POST', undefined, { auth: 'required' })
}

// Platform subscription pricing from the backend, always in MYR. `country` is an
// optional override forwarded as `?country=` (used to preview an estimate locally / in QA).
export interface PlatformPricing {
  currency: string
  prices: {
    pro: { monthly: number; yearly: number }
  }
  estimate: { currency: string; rate: number } | null
}

// A shop shown in the landing-page sample-shops carousel (#107). `imagePath` is a Storage PATH
// in the public `product-images` bucket, never a URL — resolve with productImageUrl() below.
export interface SampleShopProduct {
  id: string
  name: string
  nameZh: string | null
  price: number
  imagePath: string | null
}

export interface SampleShop {
  id: string
  slug: string
  name: string
  currency: string
  /** Storage path in the public `sample-shop-screenshots` bucket, or null if not yet captured
   *  (or never will be — capture is a weekly cron, not guaranteed). Resolve with
   *  sampleShopScreenshotUrl() below. Never render this as a URL directly. */
  screenshotPath: string | null
  products: SampleShopProduct[]
}

/** Re-shoot every sample shop's storefront. Superadmin only. Answers `captureQueued: false`
 *  rather than an error when GitHub refused the request — the weekly cron still covers it. */
export async function recaptureSampleShops(): Promise<Result<any>> {
  return apiSend<any>('/api/admin/recapture-samples', 'POST', {}, { auth: 'required' })
}

/** A sample shop that HAS a captured storefront screenshot — the only kind the carousel renders.
 *  `useSampleShops` narrows to this; see SampleShopsCarousel for why there is no second layout. */
export type CapturedSampleShop = SampleShop & { screenshotPath: string }

export async function fetchSampleShops(): Promise<Result<SampleShop[]>> {
  return apiGet<SampleShop[]>('/api/merchants/samples')
}

export const SAMPLE_SCREENSHOT_BUCKET = 'sample-shop-screenshots'

export function sampleShopScreenshotUrl(path: string): string {
  return storage.from(SAMPLE_SCREENSHOT_BUCKET).getPublicUrl(path).data.publicUrl
}

export async function fetchPlatformPricing(country?: string): Promise<Result<PlatformPricing>> {
  const qs = country ? `?country=${encodeURIComponent(country)}` : ''
  return apiGet<PlatformPricing>(`/api/pricing${qs}`)
}

/**
 * The backend's clock, and the two browser timestamps that bracket it.
 *
 * `null` on any failure — the caller falls back to the browser's own clock, which is exactly
 * today's behaviour, degraded but no worse.
 */
export async function fetchServerNow(): Promise<{ now: number; sentAt: number; receivedAt: number } | null> {
  const sentAt = Date.now()
  try {
    const res = await fetch(`${API_URL}/api/time`)
    const receivedAt = Date.now()
    if (!res.ok) return null
    const body = await res.json()
    const now = Date.parse(body?.now)
    return Number.isFinite(now) ? { now, sentAt, receivedAt } : null
  } catch {
    return null
  }
}

export interface MerchantBilling {
  merchant_id: string
  stripe_customer_id?: string | null
  stripe_subscription_id?: string | null
  status?: string | null
  trial_ends_at?: string | null
  current_period_end?: string | null
  /** Start of the period being billed for — the dunning grace clock (@bitetime/shared). */
  current_period_start?: string | null
  /** Set while this shop is closed for an unpaid invoice; cleared when the payment lands. */
  dunning_suspended_at?: string | null
  /** Complimentary tier — no Stripe subscription behind this shop. */
  comped?: boolean | null
}

// Superadmin: read every merchant's billing row (RLS grants superadmins read on all).
export async function fetchAllBilling(): Promise<Result<MerchantBilling[]>> {
  return apiGet<MerchantBilling[]>('/api/billing', { auth: true })
}

// Read the merchant's authoritative billing row (owner-readable via RLS).
export async function fetchMyBilling(merchantId: string): Promise<Result<any | null>> {
  if (!merchantId) return { ok: true, data: null }
  return apiGet<any | null>(`/api/merchants/${merchantId}/billing`, { auth: true })
}

// Superadmin fallback for a shop stuck at `pending` — signup provisions its own trial now, so
// nobody waits on this. Creates the Stripe customer + cardless trialing subscription and
// activates the shop in one step.
export async function approveMerchant(merchantId: string): Promise<Result<any>> {
  return apiSend<any>('/api/admin/approve-merchant', 'POST', { merchantId }, { auth: 'required' })
}

// The owner's own retry when trial provisioning failed during signup. Same rule as the admin
// fallback above, asked for by the merchant — who is the one actually looking at the screen.
export async function startShopTrial(merchantId: string): Promise<Result<{ ok: true; trial: boolean }>> {
  return apiSend<{ ok: true; trial: boolean }>(`/api/merchants/${merchantId}/start-trial`, 'POST', undefined, { auth: 'required' })
}

// Open the Stripe billing portal for the signed-in merchant (add/update card).
export async function openBillingPortal(): Promise<Result<string>> {
  const r = await apiSend<{ url: string }>('/api/billing/portal', 'POST', undefined, { auth: 'required' })
  return mapOk(r, (d) => d.url)
}

/**
 * The two wind-down actions, which unlike the portal stay inside the dashboard: cancelling lands
 * on a period boundary, so no money moves and there is nothing a payment screen needs to explain.
 * See CONTEXT.md → Subscription.
 *
 * Each returns `Result<void>` and carries the backend's error code in `error.code` on failure —
 * the caller decides what `no_live_subscription` should say, because it means "the subscription
 * changed under this tab", not "something broke".
 */
async function billingAction(path: 'cancel' | 'resume'): Promise<Result<void>> {
  return toVoid(await apiSend(`/api/billing/${path}`, 'POST', undefined, { auth: 'required' }))
}

/** End the subscription when the paid-for period ends. The shop is suspended at that point. */
export const cancelSubscription = () => billingAction('cancel')
/** Undo the pending cancellation. */
export const resumeSubscription = () => billingAction('resume')

export async function updateMerchantSlug(id: string, slug: string): Promise<Result<any>> {
  const s = (slug || '').trim().toLowerCase()
  if (!s || RESERVED_SLUGS.includes(s)) return { ok: false, error: { code: 'reserved_slug', message: 'Reserved or empty slug' } }
  return apiSend<any>(`/api/merchants/${id}/slug`, 'PATCH', { slug: s }, { auth: true })
}

/**
 * Ask Supabase to email a recovery link. Deliberately NOT mirrored on the custom signup endpoint:
 * going through Supabase buys two things for free that a custom endpoint would force us to rebuild
 * — its own rate limiting, and NON-ENUMERATION (the call succeeds whether or not the address has an
 * account, so the caller can only ever show the neutral message).
 *
 * Note the asymmetry with signup, which DOES disclose that an email already has an account. That
 * was accepted knowingly there. Do not "fix" reset to match it: the leak exists once already, and
 * there is no reason to open a second.
 */
export async function requestPasswordReset(email: string, shopSlug: string | null): Promise<void> {
  // NEVER throws, and never reports the outcome. That is the whole guarantee, and it lives here so
  // that no caller can leak it by accident: Supabase's per-email cooldown only fires when a mail is
  // actually SENT — i.e. only for an address that has an account — so an error surfaced to the UI
  // would tell an attacker which addresses are registered. Two requests a minute apart is the whole
  // attack. Callers show the neutral message unconditionally because there is nothing else to show.
  //
  // The cost is real and accepted: a genuine failure (network down) looks like success to the
  // customer, who waits for a mail that never comes. Enumeration is the worse of the two.
  try {
    await auth.resetPasswordForEmail(email.trim(), {
      redirectTo: resetRedirectUrl(window.location.origin, shopSlug),
    })
  } catch { /* swallowed on purpose — see above */ }
}

/** Set the new password for the session the recovery link just established. */
export async function updatePassword(password: string) {
  const { error } = await auth.updateUser({ password })
  if (error) throw error
}

/**
 * Set by `signOut` and CONSUMED by the `SIGNED_OUT` handler below — never read anywhere else.
 *
 * Without it, an intentional sign-out and an eviction are the same `SIGNED_OUT` event, and the
 * login screen would explain the device limit to someone who simply clicked Sign out.
 */
const SIGN_OUT_INTENT_KEY = 'bt.sign_out_intent';

/** Set when a sign-out was NOT this tab's doing. Read once and cleared by the login screen. */
export const SIGNED_OUT_ELSEWHERE_KEY = 'bt.signed_out_elsewhere';

export async function signOut() {
  // `scope: 'local'`, and the default is NOT that. `@supabase/auth-js` defaults `signOut()` to
  // `scope: 'global'`, which revokes EVERY session the account holds — so a merchant who signed
  // out on their phone lost the laptop too, and a two-device account behaved as a one-device
  // account. This line is what makes the device limit mean two devices.
  try { sessionStorage.setItem(SIGN_OUT_INTENT_KEY, '1'); } catch { /* private mode */ }
  await auth.signOut({ scope: 'local' });
}

/** One signed-in device, as the Devices panel shows it. */
export interface Device {
  id: string;
  /**
   * The browser and platform as PARTS — "Chrome", "macOS" — never a joined sentence. The join is
   * prose and belongs to `t(en, zh)`; both are null when the user agent could not be read. Read
   * from the user agent, so it is a claim, not a fact.
   */
  browser: string | null;
  platform: string | null;
  current: boolean;
  /** ISO 8601. When this device signed in. */
  createdAt: string;
  /** ISO 8601. When this session was last written to. */
  updatedAt: string;
  /**
   * ISO 8601, and the eviction RANK — `refreshed_at` falling back to `createdAt`. Not the same
   * field as `updatedAt`: this is the one the limit actually turns on, so the list's order is the
   * order devices will be signed out in.
   */
  lastSeen: string;
}

/** The devices on this account, and how many the server allows. */
export interface DeviceList {
  devices: Device[];
  /**
   * The server's own ceiling, quoted rather than restated. The rule is enforced by
   * MERCHANT_DEVICE_LIMIT in the backend's quotaWindows.ts and nowhere else, so a screen that
   * hardcoded "2" would keep saying 2 the day that number changes.
   */
  limit: number;
}

export async function fetchMyDevices(): Promise<Result<DeviceList>> {
  return apiGet<DeviceList>('/api/me/devices', { auth: 'required' });
}

export async function signOutDevice(sessionId: string): Promise<Result<void>> {
  return toVoid(await apiSend(`/api/me/devices/${sessionId}`, 'DELETE', undefined, { auth: 'required' }));
}

export async function getCurrentUser() {
  const { data } = await auth.getUser();
  return data?.user ?? null;
}

export function onAuthChange(callback: (user: User | null, event?: string) => void) {
  const { data: { subscription } } = auth.onAuthStateChange((event, session) => {
    const user = session?.user ?? null;
    // A SIGNED_OUT that this tab did not ask for means the session row is gone: either a third
    // device took the slot, or the merchant signed this device out from another one. Both read
    // the same way to the person holding it, and the login screen says so.
    if (event === 'SIGNED_OUT') {
      try {
        // The intent is CONSUMED here, whether or not it was set. Leaving it for the login screen
        // to clear was a bug: signing out lands on the marketing page, not on that screen, so the
        // flag survived — and silenced the notice for a genuine eviction later in the same tab.
        const mine = sessionStorage.getItem(SIGN_OUT_INTENT_KEY) === '1';
        sessionStorage.removeItem(SIGN_OUT_INTENT_KEY);
        if (!mine) sessionStorage.setItem(SIGNED_OUT_ELSEWHERE_KEY, 'yes');
      } catch { /* private mode: the login screen simply says nothing */ }
    }
    if (user && (event === 'SIGNED_IN' || event === 'USER_UPDATED')) {
      // Ensure profile exists and email_confirmed is up to date.
      // This handles the case where email confirmation was required at signUp
      // and the profile insert was blocked by RLS (no session at that point).
      // Deferred via setTimeout: awaiting a Supabase call inside onAuthStateChange
      // deadlocks the client's internal auth lock and hangs all later requests.
      setTimeout(() => {
        ensureGlobalProfile({
          user_id: user.id,
          name: user.user_metadata?.name || user.email?.split('@')[0] || '',
          email: user.email,
          email_confirmed: !!user.email_confirmed_at,
          referral_code: referralCodeOf(user.id),
        }).then((r) => {
          if (!r.ok) console.error('Profile upsert failed:', r.error.message);
        });
      }, 0);
    }
    callback(user, event);
  });
  return () => subscription.unsubscribe();
}

// ── Vouchers ──────────────────────────────────────────────────────────────────

// Uses left on a voucher. Infinity = no total cap (still capped to 1 per customer).
//
// `usedCount` is the API's own count. It replaced a `usedBy.length` read here: `used_by` is the
// list of redeemers' ACCOUNT EMAIL ADDRESSES and no longer leaves the backend, on either the
// public route or the merchant's own (see apps/backend/src/voucherView.ts). The array fallback
// survives for a legacy shape only and counts nothing that is not already in `usedCount`.
export function voucherUsesLeft(v: Voucher) {
  const count = v.usedCount ?? (Array.isArray(v.usedBy) ? v.usedBy.length : 0);
  if (v.maxUses == null || v.maxUses === '') return Infinity;
  return Math.max(0, Number(v.maxUses) - count);
}

// True when the voucher can no longer be redeemed by anyone.
export function voucherFullyUsed(v: Voucher) {
  // The server's own answer, when it gave one. It is derived from `max_uses` against a count the
  // browser is deliberately not shown, so it is the only reading that can be right here.
  if (typeof v.fullyUsed === 'boolean') return v.fullyUsed;
  // Legacy single-use vouchers: `used:true` with no usedBy list.
  if (v.used && !Array.isArray(v.usedBy)) return true;
  return voucherUsesLeft(v) <= 0;
}

// ── Multi-tenant vouchers (per-merchant `vouchers` table) ─────────────────────
// Reads the merchant-scoped `vouchers` table and maps its columns onto the
// Voucher shape the pricing module expects.

// The row → domain mapping now lives in @bitetime/shared: the backend prices orders from the
// same voucher rows, and a second copy of this mapping is a second way for the two sides to
// disagree about what a voucher is worth.
export { voucherFromRow } from '@bitetime/shared'

export async function fetchMerchantVouchers(merchantId: string): Promise<Result<Voucher[]>> {
  if (!merchantId) return { ok: true, data: [] }
  const r = await apiGet<any[]>(`/api/merchants/${merchantId}/vouchers`, { auth: true })
  return mapOk(r, (rows) => rows.map(voucherFromRow))
}

/**
 * The answer to "does this shop still have this voucher?", with "I could not ask" as its own
 * answer and not a `null` shaped like "no".
 *
 * `{ ok: true, data: null }` means we ASKED and the shop no longer has it — safe to drop.
 * `{ ok: false }` means the request never landed (network/CORS/non-2xx), and a caller that
 * would DROP the voucher on that must change nothing: confiscating a valid voucher the moment
 * the connection flickers — while telling the customer it "is no longer available" — is a lie
 * about their money. That distinction is now the shared `Result` shape, not a bespoke type.
 */
export async function lookupMerchantVoucher(merchantId: string, code: string): Promise<Result<Voucher | null>> {
  if (!merchantId || !code) return { ok: true, data: null }
  // `auth: true` — the guest-tolerant one: it attaches the session token when there is one and
  // sends the request unauthenticated when there is not. The route needs it to answer
  // `already_used`, which it derives from the CALLER'S OWN verified email; without a token it
  // simply omits that field. A signed-out customer must still be able to see what the code is
  // worth before being asked to sign in, so `auth: 'required'` would be wrong here.
  const r = await apiGet<any>(`/api/merchants/${merchantId}/vouchers/${encodeURIComponent(code)}`, { auth: true })
  return mapOk(r, (row) => (row ? voucherFromRow(row) : null))
}

// `fetchMerchantVoucher` (the null-collapsing convenience twin of `lookupMerchantVoucher`) is
// gone with the null contract: a caller that wants "a miss reads as no voucher, carry on" now
// says so at the call site by taking `r.ok ? r.data : null` itself, so the choice to discard a
// could-not-ask is visible where it is made rather than hidden in a wrapper.

// `redeemVoucher` is gone, and its absence is the fix. Redemption was a SECOND call made
// after the order was already committed, so a failure left the customer holding a discount on
// a voucher that was never marked used — reusable forever. The claim now happens inside
// placeOrder's transaction, server-side. There is no longer a second call to swallow.

// Merchant-facing voucher management (writes the merchant's own rows — allowed
// by vouchers_write_own).
export async function createMerchantVoucher(input: {
  merchantId: string; code: string; kind: string; amount: number; maxUses?: number | null;
  /** null = unlimited per customer. OMITTED means one each — the safe reading, since unlimited
   *  is the value that costs the merchant money and must therefore be said out loud. */
  perCustomerLimit?: number | null;
  /** A shop-local DATE ('YYYY-MM-DD'). The server resolves it to the instant that day ends. */
  expiresOn?: string | null;
  minOrder?: number | null;
}): Promise<Result<Voucher>> {
  const r = await apiSend<any>(`/api/merchants/${input.merchantId}/vouchers`, 'POST', {
    code: input.code,
    kind: input.kind,
    amount: input.amount,
    maxUses: input.maxUses ?? null,
    perCustomerLimit: input.perCustomerLimit === undefined ? 1 : input.perCustomerLimit,
    // A DATE, deliberately, not an instant. Which instant a merchant's chosen day ENDS depends on
    // the shop's timezone, and the browser must not be the one to decide that — see
    // apps/backend/src/voucherExpiry.ts.
    expiresOn: input.expiresOn ?? null,
    minOrder: input.minOrder ?? null,
  }, { auth: true })
  return mapOk(r, voucherFromRow)
}

/** Everything `createMerchantVoucher` takes except the code — see `updateMerchantVoucher`. */
export interface VoucherRulesInput {
  kind: string; amount: number; maxUses?: number | null;
  perCustomerLimit?: number | null; expiresOn?: string | null; minOrder?: number | null;
}

/**
 * Edit a voucher: the discount, every restriction and whether it is active — never the code.
 *
 * The code is what the merchant has printed and what customers are holding, so the server ignores
 * one in the body and this signature does not offer one. A merchant who needs a different string
 * deactivates this voucher and creates the next, which is deliberately a new campaign.
 *
 * Reactivating can be refused (`duplicate_code`, 409): the merchant may have created a second live
 * voucher with the same code while this one was paused, and two live rows cannot share one.
 */
export async function updateMerchantVoucher(
  id: string, merchantId: string, input: VoucherRulesInput & { active?: boolean },
): Promise<Result<Voucher>> {
  const r = await apiSend<any>(`/api/merchants/${merchantId}/vouchers/${id}`, 'PATCH', {
    kind: input.kind,
    amount: input.amount,
    maxUses: input.maxUses ?? null,
    perCustomerLimit: input.perCustomerLimit === undefined ? 1 : input.perCustomerLimit,
    expiresOn: input.expiresOn ?? null,
    minOrder: input.minOrder ?? null,
    ...(input.active === undefined ? {} : { active: input.active }),
  }, { auth: true })
  return mapOk(r, voucherFromRow)
}

/** A voucher's history, newest first. See `VoucherRedemption`. */
export async function fetchVoucherRedemptions(id: string, merchantId: string): Promise<Result<VoucherRedemption[]>> {
  const r = await apiGet<any[]>(`/api/merchants/${merchantId}/vouchers/${id}/redemptions`, { auth: true })
  return mapOk(r, rows => rows.map(row => ({
    id: row.id,
    redeemedAt: row.redeemed_at ?? null,
    voidedAt: row.voided_at ?? null,
    orderId: row.order_id ?? null,
    orderNumber: row.order_number ?? null,
    customerName: row.customer_name ?? null,
    // postgres.js hands `numeric` back as a string.
    discount: row.discount == null ? null : Number(row.discount),
    orderStatus: row.order_status ?? null,
  })))
}

/**
 * Pause or resume a voucher without touching its rules — the list's own action, which must not
 * have to know the discount to flip a switch. Deactivation is a PAUSE: the row keeps its code,
 * its limits and its redemption count, and comes back exactly as it was.
 */
export async function setMerchantVoucherActive(id: string, merchantId: string, active: boolean): Promise<Result<Voucher>> {
  const r = await apiSend<any>(`/api/merchants/${merchantId}/vouchers/${id}`, 'PATCH', { active }, { auth: true })
  return mapOk(r, voucherFromRow)
}

// ── Referral program ─────────────────────────────────────────────────────────
// A member's referral code is the first 8 hex chars of their profile UUID,
// so the code itself identifies the referrer. Also stored in
// profiles.referral_code for lookup.
export function referralCodeOf(userId: string) {
  return (userId || '').replace(/-/g, '').slice(0, 8).toUpperCase();
}

// Does a referral code name a shop? The one referral read that is NOT scoped to the caller —
// it answers the signup form, where there is no session yet and the code is exactly what the
// caller typed. Safe for the same reason it is useful: it returns `{ valid }` and nothing else,
// so a guessed code buys no name and no shop. See GET /api/referrals/check.
export async function checkReferralCode(code: string): Promise<Result<{ valid: boolean }>> {
  return apiGet<{ valid: boolean }>(`/api/referrals/check?code=${encodeURIComponent(code)}`)
}

// Shops that signed up with the current user's referral code.
//
// The code is never sent — the backend derives it from the bearer token, exactly as the
// my_referred_shops RPC this replaces derived it from auth.uid(). Sending it would turn the
// endpoint into a cross-tenant read of any referrer's shops.
export async function fetchReferredShops(): Promise<Result<ReferredShop[]>> {
  return apiGet<ReferredShop[]>('/api/referrals/shops', { auth: 'required' })
}

// The referral rewards the current user has earned — free months for shops they brought in
// that started paying. Like fetchReferredShops, the code is never sent: the backend scopes
// to the caller's own merchant from the bearer token.
export async function fetchEarnedRewards(): Promise<Result<EarnedReward[]>> {
  return apiGet<EarnedReward[]>('/api/referrals/rewards', { auth: 'required' })
}

// ── Multi-tenant order placement ─────────────────────────────────────────────

const ORDER_STATUSES = ['pending_payment', 'new', 'preparing', 'ready', 'completed', 'cancelled']

/**
 * A refusal the customer can act on, as opposed to a bug.
 *
 * The codes come from `@bitetime/shared` (`refusal.ts`). They used to be declared here as a
 * hand-copied twin of the backend's own union, and they drifted: `method_not_offered` was
 * thrown by the backend and handled in `Storefront.tsx` as a bare string, but was never added
 * here, so the compiler could not see the gap. `network` is the browser's own and has no
 * backend twin — a fetch that never landed.
 *
 * What each code SAYS to the customer, and what the checkout does about it, lives in
 * `store/orderRefusal.ts`.
 */
export class OrderError extends Error {
  constructor(
    readonly code: OrderRefusal | 'network',
    /**
     * The server's own clock, present only on `price_changed` (`app.ts`'s OrderError handler).
     * This is what lets `price_changed` recovery fix a persistently-unreachable `/api/time`
     * (I-3, #69): the refusal that proves the connection works also states the time, so
     * `serverClock.ts`'s `adopt()` can correct the offset without a second request that could
     * fail the same way. See serverClock.ts for the failure this closes.
     */
    readonly now?: string,
  ) {
    super(code)
    this.name = 'OrderError'
  }
}

/**
 * Place an order: ONE call, which commits the order number, the order row, the voucher claim
 * and THE PRICE in a single transaction server-side.
 *
 * This used to be three trips from the browser with no transaction around them — take a
 * number, insert the order, then record the redemption — and the storefront threw the third
 * one's error away. A failed redemption therefore left the order committed with the discount
 * applied and the voucher never marked used, so the customer kept the discount and could
 * reuse the voucher forever. The three trips are now one, and a failed claim rolls the order
 * back rather than gifting it.
 *
 * The browser no longer has INSERT on `orders` at all (the grant is revoked), so there is no
 * path back to the old shape even by accident. `user_id` is not sent: the backend takes it
 * from this request's JWT, and sending it would be ignored.
 *
 * We send what the customer WANTS (the cart) and what they SAW (`quotedTotal`) — never what it
 * costs. The backend derives every number from its own rows; sending a total would mean any
 * client could name its own. If the backend's price disagrees with our quote it refuses with
 * `price_changed` rather than charging a number the customer never confirmed.
 */
export async function placeOrder({ merchantId, customerName, customerWa, mode, address, cart, quotedTotal, voucherCode, fulfilDate, fulfilSlot }: {
  merchantId: string
  customerName: string
  customerWa: string
  // The wire contract, not a string: the backend allowlists exactly these three and 400s on
  // anything else, because `mode` selects the shipping fee. Mirrors PlaceOrderInput's union.
  mode: 'pickup' | 'delivery' | 'express'
  address?: AddressParts | string
  cart: CartLine[]
  quotedTotal: number
  voucherCode?: string | null
  /** `YYYY-MM-DD` on the shop's clock. The backend re-checks it against the shop's window. */
  fulfilDate: string | null
  /** The slot the customer picked, or null at a shop with slots off (#282). Re-checked against the shop's hours. */
  fulfilSlot: Slot | null
}): Promise<Result<{ orderNumber: string; id: string; status: string }, OrderError>> {
  // Optional: a guest has no session, and guest checkout is a first-class path.
  const { data: { session } } = await auth.getSession()
  const token = session?.access_token

  // `fetch` REJECTS on a network or CORS failure rather than returning a non-ok response, so
  // an offline customer would otherwise get a raw "Failed to fetch" on the checkout screen.
  // The Result's error is a full OrderError (not the generic ApiError): the storefront branches
  // on `error.code` (the refusal union) and adopts `error.now` — the server clock the refusal
  // carried — to close the #69 offset loop. That domain payload is why `E` is parameterised.
  const res = await fetch(`${API_URL}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      merchantId, customerName, customerWa, mode, address,
      cart, quotedTotal, voucherCode, fulfilDate,
      fulfilTimeFrom: fulfilSlot?.from ?? null, fulfilTimeTo: fulfilSlot?.to ?? null,
    }),
  }).catch(() => null)
  if (!res) return { ok: false, error: new OrderError('network') }

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}))
    return { ok: false, error: new OrderError(payload?.error ?? 'order_failed', typeof payload?.now === 'string' ? payload.now : undefined) }
  }
  return { ok: true, data: (await res.json()) as { orderNumber: string; id: string; status: string } }
}

/**
 * Why a delivery could not be quoted. Every code the endpoint can return survives to the caller:
 * this used to narrow eight into five, folding `merchant_not_found`, `merchant_inactive` and
 * `quota_exceeded` into `lookup_failed` — so a closed shop, and a shop out of daily lookup
 * budget, both told the customer to try again. The budget does not clear for up to 24 hours.
 *
 * See `store/orderRefusal.ts` for what each one now says.
 */
export class DeliveryQuoteError extends Error {
  constructor(readonly code: QuoteRefusal | 'network') {
    super(code)
    this.name = 'DeliveryQuoteError'
  }
}

/**
 * Ask what this delivery costs. Sends a PLACE ID and never a typed address: free text would let
 * a caller mint unlimited billable lookups on the platform's Maps account (docs/adr/0001).
 *
 * The row this writes is the same row order intake reads a moment later, which is what makes the
 * quote and the charge the same number.
 */
export async function quoteDelivery(merchantId: string, placeId: string): Promise<Result<{ km: number; fee: number }, DeliveryQuoteError>> {
  const res = await fetch(`${API_URL}/api/shipping/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantId, placeId }),
  }).catch(() => null)
  if (!res) return { ok: false, error: new DeliveryQuoteError('network') }
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    const code = payload.error
    // Recognised codes pass through untouched; anything else is a body we do not understand,
    // which is a lookup failure as far as the customer is concerned.
    return { ok: false, error: new DeliveryQuoteError(
      code && (QUOTE_REFUSALS as readonly string[]).includes(code) ? (code as QuoteRefusal) : 'lookup_failed',
    ) }
  }
  return { ok: true, data: (await res.json()) as { km: number; fee: number } }
}

// Trigger the server-side order notification fan-out: the merchant's Telegram and
// the signed-in customer's confirmation email. The bot token and the recipient
// address both stay on the backend — the browser sends only the order reference
// and `lang`, which selects the email's language (never who receives it).
//
// Best-effort: returns Result<void> and the storefront ignores it — a notify failure must never
// surface as a failed order, and the order is already committed by the time this runs.
export async function notifyOrderPlacedRemote(merchantId: string, orderNumber: string, lang: 'en' | 'zh'): Promise<Result<void>> {
  return toVoid(await apiSend('/api/notify/order', 'POST', { merchantId, orderNumber, lang }))
}

/**
 * How far back a customer's per-shop history goes. Stated on screen, never applied silently:
 * a truncated list with nothing said reads as "this is everything" when it isn't.
 */
export const ORDER_HISTORY_LIMIT = 20

/**
 * The orders *this* customer placed at *this* shop, newest first.
 *
 * The `user_id` filter is not belt-and-braces on top of RLS — it is the whole point. The select
 * policy grants a row to the ordering user OR the shop that owns it, so a merchant opening their
 * own storefront's history would be handed every customer's order at that shop. Filtering by the
 * signed-in uid is what makes "your orders" mean yours.
 */
export async function fetchMyOrdersAtShop(merchantId: string): Promise<Result<Order[]>> {
  if (!merchantId) return { ok: true, data: [] }
  const user = await getCurrentUser()
  if (!user) return { ok: true, data: [] } // a guest has no history — by design, and permanently
  return apiGet<Order[]>(`/api/merchants/${merchantId}/my-orders`, { auth: true })
}

/** 1-based, and always a slice: the whole list is not something this endpoint offers. */
export interface OrderPage {
  orders: any[]
  /** Orders matching the search, before paging — what the pager is a slice of. */
  total: number
  page: number
  pageSize: number
}

export interface OrderListQuery {
  page?: number
  pageSize?: number
  sort?: 'created_at' | 'order_number' | 'fulfil_date' | 'total'
  dir?: 'asc' | 'desc'
  search?: string
  /** One of ORDER_STATUSES, or blank/absent for every status. */
  status?: string
}

/**
 * One page of the merchant's orders, sorted and searched by the BACKEND (#144).
 *
 * This used to ask for every order the shop had ever taken and sort, search and page them here.
 * That silently stopped working at the shop's 1000th order — PostgREST caps a response and says
 * so only in a header nothing read — so the oldest orders became unreachable and the merchant
 * had no way to tell. Nothing here can page past what it was sent, which is why the paging moved
 * to where the rows are.
 */
export async function fetchMerchantOrders(
  merchantId: string,
  opts: OrderListQuery = {},
): Promise<Result<OrderPage>> {
  const empty = { orders: [], total: 0, page: 1, pageSize: 0 }
  if (!merchantId) return { ok: true, data: empty }
  const q = new URLSearchParams()
  if (opts.page) q.set('page', String(opts.page))
  if (opts.pageSize) q.set('pageSize', String(opts.pageSize))
  if (opts.sort) q.set('sort', opts.sort)
  if (opts.dir) q.set('dir', opts.dir)
  if (opts.search?.trim()) q.set('search', opts.search.trim())
  if (opts.status) q.set('status', opts.status)
  const qs = q.toString()
  return apiGet<OrderPage>(`/api/merchants/${merchantId}/orders${qs ? `?${qs}` : ''}`, { auth: true })
}

/**
 * Everything the Overview draws, computed by the backend from the shop's WHOLE history.
 *
 * The range and granularity are the panel's own pills, so switching one is a refetch rather than
 * a recompute — the browser no longer holds the orders to recompute from, which is the point.
 * A shop past the row cap used to be shown a revenue figure that was simply short, and trusted
 * it because nothing suggested otherwise (#144).
 */
export async function fetchMerchantStats(
  merchantId: string,
  selection: RevenueSelection,
  granularity: Granularity,
): Promise<Result<MerchantStats>> {
  return apiGet<MerchantStats>(
    `/api/merchants/${merchantId}/stats?${revenueQuery(selection, granularity)}`,
    { auth: true },
  )
}

/**
 * How many orders this shop has, optionally of one status — counted by Postgres.
 *
 * The "new orders" badge used to be `orders.filter(…).length` over the full list, which made the
 * most expensive read in the dashboard run on a poll from every section, and made the badge
 * wrong past the row cap besides.
 */
export async function fetchOrderCount(
  merchantId: string,
  status?: string,
): Promise<Result<number>> {
  if (!merchantId) return { ok: true, data: 0 }
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  const r = await apiGet<{ count: number }>(`/api/merchants/${merchantId}/orders/count${qs}`, { auth: true })
  return mapOk(r, d => d.count)
}

/**
 * How many orders this shop has in each status, counted by Postgres in one statement.
 *
 * `search` is the list's own search box, so the tally over a filter chip counts the same rows
 * the list under it would show. A status the shop has no orders in is absent from the map.
 */
export async function fetchOrderStatusCounts(
  merchantId: string,
  search = '',
): Promise<Result<Record<string, number>>> {
  if (!merchantId) return { ok: true, data: {} }
  const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''
  const r = await apiGet<{ counts: Record<string, number> }>(
    `/api/merchants/${merchantId}/orders/status-counts${qs}`, { auth: true },
  )
  return mapOk(r, d => d.counts)
}

/**
 * The revenue export. Hands back the workbook and the name the server chose for it.
 *
 * The range and granularity are the ones the merchant is looking at on the Overview chart — the
 * file is that panel's contents, not a second range concept in the dashboard. `auth: 'required'`
 * because a signed-out caller has no shop to report on, and the backend would only 401.
 */
export async function downloadRevenueReport(
  merchantId: string,
  selection: RevenueSelection,
  granularity: Granularity,
): Promise<Result<{ blob: Blob; filename: string | null }>> {
  return apiGetFile(
    `/api/merchants/${merchantId}/report.xlsx?${revenueQuery(selection, granularity)}`,
    { auth: 'required' },
  )
}

export async function setOrderStatus(orderId: string, status: string, merchantId: string): Promise<Result<any>> {
  if (!ORDER_STATUSES.includes(status)) return { ok: false, error: { code: 'invalid_status', message: 'Invalid status' } }
  return apiSend<any>(`/api/merchants/${merchantId}/orders/${orderId}`, 'PATCH', { status }, { auth: true })
}

export async function setOrderNote(orderId: string, note: string, merchantId: string): Promise<Result<any>> {
  return apiSend<any>(`/api/merchants/${merchantId}/orders/${orderId}`, 'PATCH', { note }, { auth: true })
}

export async function setOrderTracking(orderId: string, courier: string | null, awb: string, merchantId: string): Promise<Result<any>> {
  return apiSend<any>(`/api/merchants/${merchantId}/orders/${orderId}`, 'PATCH', { courier, awb }, { auth: true })
}

/**
 * Move the day — and, at a slot shop, the slot — an order is for. `fulfilDate` is `YYYY-MM-DD`
 * and never empty: a date cannot be cleared, only moved. `fulfilSlot` is sent only when given —
 * `null` clears (a shop with slots off only), a `Slot` moves. The backend judges both by the
 * shop's own Fulfilment settings, the same rules intake applies, and answers
 * `fulfil_date_unavailable`, `fulfil_time_unavailable` or `order_completed`.
 */
export async function setOrderFulfilment(
  orderId: string,
  patch: { fulfilDate: string; fulfilSlot?: Slot | null },
  merchantId: string,
): Promise<Result<any>> {
  const body: Record<string, unknown> = { fulfil_date: patch.fulfilDate }
  if (patch.fulfilSlot !== undefined) {
    body.fulfil_time_from = patch.fulfilSlot?.from ?? null
    body.fulfil_time_to = patch.fulfilSlot?.to ?? null
  }
  return apiSend<any>(`/api/merchants/${merchantId}/orders/${orderId}`, 'PATCH', body, { auth: true })
}

/**
 * The shop's customers (#143), aggregated by the BACKEND.
 *
 * This used to fetch every order and group them here, on the raw `customer_wa` string. That was
 * wrong three ways at once — two spellings of one number were two customers, cancelled orders
 * counted as business, and every order with no number collapsed into one fake row called `—` —
 * and it sat on top of an orders endpoint that truncated at 1000 rows without saying so (fixed
 * separately in #144). All of it now happens in SQL and one pure module; see CONTEXT.md → Shop
 * customer.
 */
export async function fetchShopCustomers(
  merchantId: string,
  opts: {
    sort?: ShopCustomerSort; segment?: ShopCustomerSegment; tag?: string; search?: string; page?: number; pageSize?: number
  } = {},
): Promise<Result<ShopCustomerPage>> {
  if (!merchantId) {
    return { ok: true, data: { customers: [], shopTags: [], stats: { customers: 0, bookedOrders: 0, spend: 0 }, total: 0, unattributedOrders: 0 } }
  }
  const q = new URLSearchParams()
  if (opts.sort) q.set('sort', opts.sort)
  if (opts.segment) q.set('segment', opts.segment)
  if (opts.tag) q.set('tag', opts.tag)
  if (opts.search?.trim()) q.set('search', opts.search.trim())
  if (opts.page) q.set('page', String(opts.page))
  if (opts.pageSize) q.set('pageSize', String(opts.pageSize))
  const qs = q.toString()
  const r = await apiGet<ShopCustomerPage>(`/api/merchants/${merchantId}/customers${qs ? `?${qs}` : ''}`, { auth: true })

  // `shopTags` is made true HERE rather than trusted from the wire, because the two halves of
  // this app deploy independently — the frontend to Vercel, the backend to Railway — so a
  // browser running this code can be talking to a backend that has never heard of the field
  // (#150). `ShopCustomerPage` promises callers an array; this is the one place that can keep
  // that promise. Without it the drawer throws on `undefined.filter` and takes the whole notes
  // panel down to avoid drawing one row of chips.
  if (!r.ok) return r
  return { ok: true, data: { ...r.data, shopTags: r.data.shopTags ?? [] } }
}

/** One customer's orders, newest-first — what the drawer opens. Cancelled orders included. */
export async function fetchShopCustomerOrders(merchantId: string, phoneKey: string): Promise<Result<Order[]>> {
  return apiGet<Order[]>(`/api/merchants/${merchantId}/customers/${phoneKey}/orders`, { auth: true })
}

/**
 * Save what the merchant wrote about one customer. The row is created on the first write — most
 * customers never have one.
 *
 * Sends BOTH fields every time rather than patching one: the dashboard edits them in one panel
 * with one save, and a partial write would need the server to distinguish "cleared the note"
 * from "did not mention the note", which is a distinction nothing on screen offers.
 */
export async function saveShopCustomer(
  merchantId: string,
  phoneKey: string,
  fields: { note: string | null; tags: string[] },
): Promise<Result<{ phoneKey: string; note: string | null; tags: string[] }>> {
  return apiSend(`/api/merchants/${merchantId}/customers/${phoneKey}`, 'PUT', fields, { auth: true })
}

// ── Products ──────────────────────────────────────────────────────────────────

/**
 * The shop's menu, on the one Result convention: `{ ok:true, data:[] }` is a real answer (the
 * shop genuinely sells nothing, so pruning the cart against it is CORRECT), while `{ ok:false }`
 * means WE COULD NOT ASK and a caller that PRUNES the cart against the menu (Storefront's
 * `adoptProducts`) must change nothing — answering a flaky connection by deleting every line the
 * customer chose is a destroyed order, not a retry. That is the whole reason this stays a Result
 * and there is no `[]`-on-failure twin: a display-only caller collapses `r.ok ? r.data : []`
 * itself, so the choice to treat a could-not-ask as "empty menu" is visible where it is made.
 */
export async function lookupProducts(merchantId: string): Promise<Result<any[]>> {
  if (!merchantId) return { ok: true, data: [] }
  return apiGet<any[]>(`/api/merchants/${merchantId}/products`)
}

// merchant_id and id are both threaded from `product` — ProductsManager's callers always set
// both (merchant_id from `merchant!.id`, id from the row or a client-generated draftId) — so
// the URL carries the same tenant/row identity the backend then forces server-side anyway.
/**
 * One item read off a menu photograph, before the merchant has corrected it.
 *
 * A deliberate twin of `MenuDraftItem` in apps/backend/src/menuImport.ts — the backend is not a
 * dependency of this workspace, and this shape is a wire format, not a rule that has to hold
 * identically on both sides, so it does not belong in @bitetime/shared (see CLAUDE.md).
 */
export interface MenuDraftItem {
  name: string
  name_zh?: string
  description?: string
  /** As printed on the menu. Shown to the merchant so they can check the parsed number. */
  price_text: string
  /** null when the printed price could not be read — an empty REQUIRED field, never a 0. */
  price: number | null
  unit?: string
  unit_quantity?: number
  /** The menu's own section heading, as words. Never a category id — see ADR 0013. */
  category_label?: string
}

/**
 * Reads a photograph of the shop's menu and returns DRAFT products (#menu-import).
 *
 * Writes nothing. The drafts become products only when the merchant saves them through
 * `upsertProduct` below, which is the same path the add-product form uses.
 */
export async function importMenu(
  merchantId: string,
  imageBase64: string,
  mediaType: 'image/jpeg' | 'image/png',
): Promise<Result<{ items: MenuDraftItem[] }>> {
  return apiSend<{ items: MenuDraftItem[] }>(
    `/api/merchants/${merchantId}/menu-import`,
    'POST',
    { image: imageBase64, media_type: mediaType },
    { auth: 'required' },
  )
}

/** What the assistant answered, and the window it actually read to answer it. */
export interface ShopAnswer {
  answer: string
  /** null when the assistant answered without reading any figures — then there is no window to cite. */
  window: { days: number; granularity: 'day' | 'week' } | null
}

/**
 * Asks the shop analytics assistant a question about this shop's own orders.
 *
 * The shop is the one in the URL, and the backend binds the model's only tool to it after
 * checking ownership — there is no way to ask about another shop from here, by design.
 */
export async function askShop(
  merchantId: string,
  question: string,
  lang: 'en' | 'zh',
): Promise<Result<ShopAnswer>> {
  return apiSend<ShopAnswer>(`/api/merchants/${merchantId}/ask`, 'POST', { question, lang }, { auth: 'required' })
}

export async function upsertProduct(product: any): Promise<Result<any>> {
  return apiSend<any>(`/api/merchants/${product.merchant_id}/products/${product.id}`, 'PUT', product, { auth: true })
}

/**
 * Product copy (CONTEXT.md → Product copy): superadmin-only bulk duplication of products from one
 * shop into the shop whose dashboard is open. The backend does everything — rows, categories,
 * sort, image objects — whole or not at all.
 */
export async function copyProducts(
  sourceMerchantId: string,
  targetMerchantId: string,
  productIds: string[],
): Promise<Result<{ copied: number; skippedImages: number }>> {
  return apiSend('/api/admin/copy-products', 'POST', { sourceMerchantId, targetMerchantId, productIds }, { auth: 'required' })
}

// Signature change: `merchantId` now threads the URL's tenant segment — the backend nests
// product deletes under /api/merchants/:id/products/:productId (see writes.ts /
// requireMerchantOwns) so it can verify tenancy before deleting. Callers must pass it.
export async function deleteProduct(id: string, merchantId: string): Promise<Result<void>> {
  return toVoid(await apiSend(`/api/merchants/${merchantId}/products/${id}`, 'DELETE', undefined, { auth: true }))
}

// ── Product images (Supabase Storage: public `product-images` bucket) ──────────

export const PRODUCT_IMAGE_BUCKET = 'product-images'
export const MAX_PRODUCT_IMAGES = 5
export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024
export const PRODUCT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

// Resolve a stored path to a public URL for rendering.
export function productImageUrl(path: string): string {
  return storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl
}

// Validate + upload files under {merchantId}/{productId}/…; returns stored paths.
export async function uploadProductImages(
  merchantId: string,
  productId: string,
  files: File[],
): Promise<string[]> {
  const paths: string[] = []
  for (const original of files) {
    if (!PRODUCT_IMAGE_TYPES.includes(original.type)) {
      throw new Error(`Unsupported image type: ${original.name}`)
    }
    if (original.size > MAX_PRODUCT_IMAGE_BYTES) {
      throw new Error(`Image too large (max 5MB): ${original.name}`)
    }
    // Bounded to 1600px on the long edge BEFORE it is stored (imageResize.ts): the bucket serves
    // originals, and a 4MB phone photo behind a 56px thumbnail was the storefront's largest
    // download. Validated on the original, uploaded as the smaller file; on any failure the
    // original goes up as before.
    const file = await downscaleImage(original)
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${merchantId}/${productId}/${crypto.randomUUID()}-${safe}`
    const { error } = await storage
      .from(PRODUCT_IMAGE_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: true })
    if (error) throw error
    paths.push(path)
  }
  return paths
}

export async function deleteProductImages(paths: string[]): Promise<void> {
  if (!paths?.length) return
  const { error } = await storage.from(PRODUCT_IMAGE_BUCKET).remove(paths)
  if (error) throw error
}

// ── Payment QR (Supabase Storage: public `payment-qr` bucket) ─────────────────
// One image per shop, shown to the customer on the order-placed screen (#156). Stored as a
// PATH under {merchantId}/…; the column is `merchants.payment_qr`, and the backend refuses a
// path that is not inside this merchant's own folder (writes.ts).

export const PAYMENT_QR_BUCKET = 'payment-qr'
export const MAX_PAYMENT_QR_BYTES = 2 * 1024 * 1024
export const PAYMENT_QR_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export function paymentQrUrl(path: string): string {
  return storage.from(PAYMENT_QR_BUCKET).getPublicUrl(path).data.publicUrl
}

// Validate + upload; returns the stored path. Same shape as uploadProductImages, one file: the
// limits are stated here so the merchant gets a readable message before a 2MB body crosses the
// wire, and again on the bucket (20260729130000) so they hold for any client.
export async function uploadPaymentQr(merchantId: string, file: File): Promise<string> {
  if (!PAYMENT_QR_TYPES.includes(file.type)) {
    throw new Error(`Unsupported image type: ${file.name}`)
  }
  if (file.size > MAX_PAYMENT_QR_BYTES) {
    throw new Error(`Image too large (max 2MB): ${file.name}`)
  }
  // Flattened to a single path segment: the backend only accepts {merchantId}/{file}, and the
  // file name is sanitised to the characters that check allows.
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const path = `${merchantId}/${crypto.randomUUID()}-${safe}`
  const { error } = await storage
    .from(PAYMENT_QR_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: true })
  if (error) throw error
  return path
}

export async function deletePaymentQr(path: string): Promise<void> {
  if (!path) return
  const { error } = await storage.from(PAYMENT_QR_BUCKET).remove([path])
  if (error) throw error
}

// ── Payment proof (Supabase Storage: private `payment-proof` bucket, via the backend) ─────────
// The customer's own screenshot of a completed transfer, attached to the order they just placed
// (optional). Unlike payment-qr, the browser never touches this bucket directly: a guest
// checkout has no token to scope an RLS write against, so the upload goes through the backend's
// service-role client instead — see docs/superpowers/specs/2026-08-04-payment-proof-upload-design.md.

export const MAX_PAYMENT_PROOF_BYTES = 2 * 1024 * 1024
export const PAYMENT_PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp']

/** What the upload moved on the order row — the stored path, and a status that may have left
 *  `pending_payment`. Order history patches its own row from it rather than refetching. */
export type PaymentProofSaved = { payment_proof: string; status: string }

/** Validates client-side (same limits the bucket itself enforces), then posts the raw file. */
export async function uploadPaymentProof(orderId: string, file: File): Promise<Result<PaymentProofSaved>> {
  if (!PAYMENT_PROOF_TYPES.includes(file.type)) {
    return { ok: false, error: { message: `Unsupported image type: ${file.name}` } }
  }
  if (file.size > MAX_PAYMENT_PROOF_BYTES) {
    return { ok: false, error: { message: `Image too large (max 2MB): ${file.name}` } }
  }
  return apiSendFile<PaymentProofSaved>(`/api/orders/${orderId}/payment-proof`, file)
}

/** For the merchant dashboard only — `auth: 'required'`, a signed-out caller has no shop to view. */
export async function fetchPaymentProof(merchantId: string, orderId: string): Promise<Result<Blob>> {
  const r = await apiGetFile(`/api/merchants/${merchantId}/orders/${orderId}/payment-proof`, { auth: 'required' })
  return mapOk(r, d => d.blob)
}

/** The merchant twin also returns the order events it recorded (#268), so the sheet can append
 *  them to the log it is showing without a second request. */
export type MerchantProofSaved = { payment_proof_merchant: string; status: string; events: OrderEvent[] }

/** The order log (#268, CONTEXT.md → Order log), oldest first. Merchant dashboard only. */
export async function fetchOrderEvents(merchantId: string, orderId: string): Promise<Result<OrderEvent[]>> {
  const r = await apiGet<{ events: OrderEvent[] }>(`/api/merchants/${merchantId}/orders/${orderId}/events`, { auth: 'required' })
  return mapOk(r, d => d.events)
}

/**
 * The SHOP's own copy of the receipt, filed from the order detail sheet when the customer sent
 * the slip over WhatsApp instead of uploading it. A separate slot from the customer's, so filing
 * one never replaces the other. `auth: 'required'` — the route is merchant-owned.
 */
export async function uploadMerchantPaymentProof(
  merchantId: string,
  orderId: string,
  file: File,
): Promise<Result<MerchantProofSaved>> {
  if (!PAYMENT_PROOF_TYPES.includes(file.type)) {
    return { ok: false, error: { message: `Unsupported image type: ${file.name}` } }
  }
  if (file.size > MAX_PAYMENT_PROOF_BYTES) {
    return { ok: false, error: { message: `Image too large (max 2MB): ${file.name}` } }
  }
  const path = `/api/merchants/${merchantId}/orders/${orderId}/merchant-payment-proof`
  return apiSendFile<MerchantProofSaved>(path, file, { auth: 'required' })
}

/** Reads back what `uploadMerchantPaymentProof` filed — merchant dashboard only. */
export async function fetchMerchantPaymentProof(merchantId: string, orderId: string): Promise<Result<Blob>> {
  const path = `/api/merchants/${merchantId}/orders/${orderId}/merchant-payment-proof`
  const r = await apiGetFile(path, { auth: 'required' })
  return mapOk(r, d => d.blob)
}

/** For the customer's own order history — scoped server-side by the order's user_id, not a
 * merchant id. `auth: 'required'`, same reason as fetchPaymentProof: a signed-out caller has
 * no order to view. */
export async function fetchMyPaymentProof(orderId: string): Promise<Result<Blob>> {
  const r = await apiGetFile(`/api/orders/${orderId}/payment-proof`, { auth: 'required' })
  return mapOk(r, d => d.blob)
}

/** The receipt the SHOP filed for this order, for the customer who sent it outside the app.
 *  Same scoping as `fetchMyPaymentProof` — the order's own user_id, server-side. */
export async function fetchMyMerchantPaymentProof(orderId: string): Promise<Result<Blob>> {
  const r = await apiGetFile(`/api/orders/${orderId}/merchant-payment-proof`, { auth: 'required' })
  return mapOk(r, d => d.blob)
}

// ── Invoice ───────────────────────────────────────────────────────────────────
//
// One document, three doors, the same bytes: a guest today is an account holder next month and
// must not be handed two different papers. Which door a caller uses is decided by what they can
// PROVE — a session, ownership of the shop, or the order number with the phone that placed it.
// See CONTEXT.md → Invoice.

/** The signed-in customer's own order. Scoped server-side by the order's `user_id`. */
export async function fetchMyInvoice(orderId: string): Promise<Result<{ blob: Blob; filename: string | null }>> {
  return apiGetFile(`/api/orders/${orderId}/invoice.pdf`, { auth: 'required' })
}

/** The merchant's copy of an order in their own shop — the one they forward when asked directly. */
export async function fetchOrderInvoice(
  merchantId: string,
  orderId: string,
): Promise<Result<{ blob: Blob; filename: string | null }>> {
  return apiGetFile(`/api/merchants/${merchantId}/orders/${orderId}/invoice.pdf`, { auth: 'required' })
}

/**
 * The guest door: an order number and the phone that placed it, scoped to one shop.
 *
 * Sends NO token even when one exists (`auth: false`): the caller is by definition someone with
 * no account, the door proves the pair and nothing else, and a signed-in customer reaching this
 * page still gets the same answer as everyone else. The shop is required because an order number
 * is unique per shop only; the backend answers every failure with the same 404, so this Result
 * carries nothing to branch on and the page says one sentence.
 */
export async function fetchGuestInvoice(
  shop: string,
  orderNumber: string,
  phone: string,
): Promise<Result<{ blob: Blob; filename: string | null }>> {
  return apiSendForFile('/api/orders/invoice', { shop, orderNumber, phone }, { auth: false })
}

/** The three fields either review door writes back. */
export interface OrderReview {
  review_rating: number
  review_comment: string | null
  review_at: string
}

/**
 * The signed-in customer's review of their own order. The order's `user_id` is what scopes it,
 * so the token is the whole proof and nothing about the order needs to be re-stated.
 */
export async function reviewMyOrder(
  orderId: string,
  rating: number,
  comment: string | null,
): Promise<Result<OrderReview>> {
  return apiSend<OrderReview>(`/api/orders/${orderId}/review`, 'POST', { rating, comment }, { auth: true })
}

/**
 * The guest's review, through the same door their invoice comes from: the shop, the order number
 * and the phone they typed. A guest order carries no `user_id`, so there is nothing else to prove.
 */
export async function reviewGuestOrder(
  shop: string,
  orderNumber: string,
  phone: string,
  rating: number,
  comment: string | null,
): Promise<Result<OrderReview>> {
  return apiSend<OrderReview>(
    '/api/orders/review',
    'POST',
    { shop, orderNumber, phone, rating, comment },
    { auth: false },
  )
}

// ── Merchant config & secrets ─────────────────────────────────────────────────

export async function updateMerchantConfig(id: string, patch: any): Promise<Result<any>> {
  return apiSend<any>(`/api/merchants/${id}`, 'PATCH', patch, { auth: true })
}

/**
 * Write a shop's whole arrangement: where every product sits, and in which section.
 *
 * The WHOLE list every time, never a diff — see `menuArrangement.ts`.
 *
 * The endpoint answers `{ ok, updated }`, and this DISCARDS the count on purpose. `updated` is
 * there for the API suite, which uses it to prove that a body naming a stranger's product moves
 * nothing; the dashboard only ever sends products it just read from this shop, so a short count
 * would mean a product was deleted from another tab — not something to interrupt a save over.
 */
export async function saveProductOrder(
  merchantId: string,
  items: { id: string; sort: number; category_id: string | null }[],
): Promise<Result<void>> {
  return toVoid(await apiSend(`/api/merchants/${merchantId}/product-order`, 'PUT', { items }, { auth: true }))
}

export async function fetchMerchantSecret(merchantId: string): Promise<Result<{ tg_token: string | null; tg_chat_id: string | null } | null>> {
  if (!merchantId) return { ok: true, data: null }
  return apiGet<{ tg_token: string | null; tg_chat_id: string | null } | null>(`/api/merchants/${merchantId}/secret`, { auth: true })
}

export async function upsertMerchantSecret(merchantId: string, secret: any): Promise<Result<void>> {
  return toVoid(await apiSend(`/api/merchants/${merchantId}/secret`, 'PUT', secret, { auth: true }))
}

// ── Merchant platform feedback (#89) ────────────────────────────────────────────
// merchantId scopes the route; the backend re-derives ownership from the bearer token
// and ignores anything else in the body, so there is nothing else to send.
//
/**
 * Sends the merchant's feedback and up to FEEDBACK_MAX_IMAGES screenshots as one multipart
 * request, so the row and its images arrive together.
 *
 * Validates every file against the shared rules FIRST — the same "readable error before the
 * bytes cross the wire" role uploadPaymentProof plays. The shared validator judges type and
 * size only, so the filename is prefixed here, where there is a merchant to show it to.
 *
 * Returns `images_failed`, not the row: the POST responds with a bare merchant_feedback row,
 * which is NOT a FeedbackItem — it carries no shop_name / shop_slug, and only the admin list
 * joins those in. Claiming the richer type here would be a cast the compiler cannot check.
 */
export async function submitFeedback(
  merchantId: string,
  draft: FeedbackDraft,
  files: File[] = [],
): Promise<Result<{ images_failed: number }>> {
  const images = validateFeedbackImages(files.map(f => ({ type: f.type, size: f.size })))
  if (!images.ok) {
    const name = images.index === null ? null : files[images.index]?.name
    return { ok: false, error: { code: images.code, message: name ? `${images.error}: ${name}` : images.error } }
  }

  const form = new FormData()
  form.append('category', draft.category)
  form.append('message', draft.message)
  for (const file of files) form.append('images', file)

  const r = await apiSendForm<{ images_failed?: number }>(
    `/api/merchants/${merchantId}/feedback`, form, { auth: true },
  )
  return mapOk(r, d => ({ images_failed: d?.images_failed ?? 0 }))
}

/**
 * One screenshot's bytes, for the superadmin inbox. `auth: 'required'` — a signed-out caller
 * has no feedback to view. Same shape as fetchPaymentProof; the bucket is private, so this
 * route is the only way to these bytes.
 */
export async function fetchFeedbackImage(feedbackId: string, index: number): Promise<Result<Blob>> {
  const r = await apiGetFile(`/api/admin/feedback/${feedbackId}/images/${index}`, { auth: 'required' })
  return mapOk(r, d => d.blob)
}

export async function fetchAdminFeedback(status?: FeedbackStatus): Promise<Result<FeedbackItem[]>> {
  const qs = status ? `?status=${status}` : ''
  return apiGet<FeedbackItem[]>(`/api/admin/feedback${qs}`, { auth: true })
}

// The PATCH route now joins the shop the same way the admin list does (see
// updateFeedbackStatus in apps/backend/src/feedback.ts), so this genuinely returns a full
// FeedbackItem — the spread in AdminFeedback is correct, not merely harmless.
export async function setFeedbackStatus(id: string, status: FeedbackStatus): Promise<Result<FeedbackItem>> {
  return apiSend<FeedbackItem>(`/api/admin/feedback/${id}`, 'PATCH', { status }, { auth: true })
}

// ── Trial feedback (#155) ───────────────────────────────────────────────────────
// One-time, platform-initiated survey — see CONTEXT.md → Trial feedback. Scoped to the
// caller's own shop by the backend (requireOwnMerchant), so there is no merchantId to pass.
export async function fetchTrialFeedback(): Promise<Result<TrialFeedbackOwn | null>> {
  return apiGet<TrialFeedbackOwn | null>('/api/trial-feedback', { auth: true })
}

export async function respondTrialFeedback(rating: number, comment: string | null): Promise<Result<TrialFeedbackOwn>> {
  return apiSend<TrialFeedbackOwn>('/api/trial-feedback/respond', 'POST', { rating, comment }, { auth: true })
}

export async function skipTrialFeedback(): Promise<Result<TrialFeedbackOwn>> {
  return apiSend<TrialFeedbackOwn>('/api/trial-feedback/skip', 'POST', undefined, { auth: true })
}

export async function fetchAdminTrialFeedback(): Promise<Result<TrialFeedbackAdminItem[]>> {
  return apiGet<TrialFeedbackAdminItem[]>('/api/admin/trial-feedback', { auth: true })
}

// ── Release notes (#163) ────────────────────────────────────────────────────

export async function listPublishedReleases(): Promise<Result<PublicRelease[]>> {
  return apiGet<PublicRelease[]>('/api/releases')
}

export async function getReleaseByTag(tag: string): Promise<Result<ReleaseDetail>> {
  return apiGet<ReleaseDetail>(`/api/releases/${encodeURIComponent(tag)}`)
}

export async function adminPullReleases(): Promise<Result<{ pulled: number }>> {
  return apiSend<{ pulled: number }>('/api/admin/releases/pull', 'POST', undefined, { auth: 'required' })
}

export async function adminListReleases(): Promise<Result<AdminRelease[]>> {
  return apiGet<AdminRelease[]>('/api/admin/releases', { auth: 'required' })
}

export async function adminSetReleaseStatus(
  id: string,
  status: 'draft' | 'published',
): Promise<Result<AdminRelease>> {
  return apiSend<AdminRelease>(`/api/admin/releases/${id}`, 'PATCH', { status }, { auth: 'required' })
}

export async function adminRegenerateRelease(id: string): Promise<Result<AdminRelease>> {
  return apiSend<AdminRelease>(`/api/admin/releases/${id}/regenerate`, 'POST', undefined, { auth: 'required' })
}
