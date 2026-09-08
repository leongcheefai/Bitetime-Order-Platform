// The Hono app, with no server attached.
//
// It is exported rather than served here so the suites in tests/api can drive the real
// routes in-process via `app.request()` — no listening port, no HTTP stack, but the actual
// routing, auth and error mapping under test. src/index.ts is the entry that binds it to a
// port.
//
// Importing this does no I/O, but it is not free of side effects: it pulls in env.ts, which
// THROWS on a missing required var. That fail-fast is deliberate (a backend that boots
// without a Stripe key is worse than one that refuses to), and it is why vitest.db.config.ts
// has to stub the Stripe keys before a test can import this module. Keep it to that — no
// connections, no timers, no reads at import time.
import { timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { env } from './env.js'
import { admin, getUserFromToken } from './supabase.js'
import { requireUser, requireSuperadmin, requireMerchantOwns, requireOwnsChild, requireOwnMerchant, bearer, type AppEnv } from './mw.js'
import { voucherPublicView, voucherMerchantView } from './voucherView.js'
import { parseVoucherRules } from './voucherInput.js'
import { redemptionCounts, myRedemptionCount, voucherRedemptions } from './voucherRedemptionsDb.js'
import { stripe, priceFor, isValidCycle, isStripeError } from './stripe.js'
import { upsertBilling, setMerchantStatus, billingFromSubscription, reconcileBillingCycle, lapseMerchant, reopenAfterPayment, LIVE_STATUSES } from './billing.js'
import { canStartTrial, trialStartRefusal, buildTrialReminderEmail } from './billingLifecycle.js'
import { startCardlessTrial } from './trialSubscription.js'
import { renameMerchantSlug } from './slugRename.js'
import { runBillingSweep } from './billingSweep.js'
import { syncMerchantBilling, liveSubscriptionBesides } from './billingSync.js'
import { isOurEvent } from './webhookOwnership.js'
import { resendSend } from './email.js'
import { notifyOrderPlaced, telegramSend } from './notify.js'
import { emailOrderConfirmation, emailMerchantOrder } from './orderEmails.js'
import { signUpAccount, isDuplicateEmailError } from './accountSignup.js'
import { makeEmailVerifyToken, readEmailVerifyToken } from './emailVerifyToken.js'
import { buildEmailVerifyMail } from './emailVerifyMail.js'
import { createSlidingWindow } from './rateLimit.js'
import { clientIp } from './clientIp.js'
import { invoiceFileName, renderInvoicePdf } from './invoice.js'
import { invoiceFont } from './invoiceFont.js'
import { phoneKey } from './phone.js'
import {
  shopCustomers, isShopCustomerSort, pickShopCustomerFields, DEFAULT_SHOP_CUSTOMER_SORT,
  isShopCustomerSegment, DEFAULT_SHOP_CUSTOMER_SEGMENT,
} from './shopCustomers.js'
import { shopCustomerGroups, shopCustomerRecords, upsertShopCustomer } from './shopCustomersDb.js'
import { statsOrders, distinctCustomerCount, orderStatusCounts } from './ordersDb.js'
import { parseProductOrder } from './productOrder.js'
import { writeProductOrder } from './productOrderDb.js'
import { parseProductCopy, planProductCopy, dropMissingImages, type CopySourceProduct } from './productCopy.js'
import { applyProductCopy } from './productCopyDb.js'
import { parseOrderList, searchTerm } from './orderList.js'
import { resolveRoutedDistance } from './routedDistance.js'
import { liveDistanceDeps } from './distanceCache.js'
import { invoiceLookupIpWindow, reviewSubmitIpWindow, quoteIpWindow, quoteMerchantWindow, placesGlobalWindow, menuImportMerchantWindow, assistantMerchantWindow, MENU_IMPORT_LIFETIME_LIMIT, MENU_IMPORT_MONTHLY_LIMIT, ASSISTANT_MONTHLY_LIMIT, MERCHANT_DEVICE_LIMIT } from './quotaWindows.js'
import { chooseEvictions, sessionIdFromToken, lastSeen } from './deviceLimit.js'
import { listSessions, deleteSessions } from './deviceLimitDb.js'
import { deviceIdentity } from './deviceLabel.js'
import { usagePeriod, nextResetDate, LIFETIME_PERIOD, type AiFeature } from './aiUsage.js'
import { consumeAiCall } from './aiUsageDb.js'
import { googlePlaceSuggest, googlePlaceDetail } from './maps.js'
import { detectCountry } from './region.js'
import { fetchBasePricing, createPricingCache, type PricingPayload } from './pricing.js'
import { estimateFor } from './fx.js'
import { listReferredShops, listEarnedRewards, referralCodeIsShareable } from './referrals.js'
import { processReferralReward } from './referralRewardGrant.js'
import type { OrderEvent } from '@bitetime/shared'
import { listOrderEvents } from './orderEventsDb.js'
import { placeOrder, patchOrder, OrderError, orderMerchantId, setOrderPaymentProof, setOrderMerchantPaymentProof } from './orders.js'
import { insertFeedback, listFeedback, updateFeedbackStatus, updateFeedbackGithubIssue, updateFeedbackImages } from './feedback.js'
import {
  findDueTrials, claimSend, releaseSend,
  getOwnTrialFeedback, respondTrialFeedback, skipTrialFeedback, listTrialFeedbackForAdmin,
} from './trialFeedback.js'
import { buildTrialFeedbackEmail } from './trialFeedbackEmail.js'
import {
  createGithubIssue, closeGithubIssue, reopenGithubIssue, listGithubReleases,
  getGithubReleaseByTag, dispatchSampleScreenshot,
  buildIssueTitle, buildIssueBody, categoryToLabel,
  type CreateGithubIssue, type GithubIssueAction, type ListGithubReleases,
  type GetGithubReleaseByTag, type DispatchSampleScreenshot,
} from './github.js'
import { humanizeRelease, type HumanizeRelease } from './releases.js'
import { extractMenu, MAX_MENU_IMAGE_BYTES, type ExtractMenu } from './menuImport.js'
import { askShopAssistant, type AskShopAssistant } from './shopAssistant.js'
import {
  listReleaseTags, insertDraftRelease, listAllReleases, getReleaseById,
  updateReleaseStatus, updateReleaseHumanization,
  listPublishedReleases, getPublishedReleaseByTag,
} from './releasesDb.js'
import { canIssueInvoice, validateOrderReview, isCart, isBusinessNature, isCurrencyCode, DEFAULT_CURRENCY, validateOptionGroups, optionGroupsFromRow, validateFeedback, isFeedbackStatus, validateFeedbackImages, validateTrialFeedback, shopDistance, routedKm, distanceFee, REFUSAL_STATUS, QUOTE_REFUSAL_STATUS, DEFAULT_TIMEZONE, isTimezone, computeMerchantStats, ordersInWindow, windowTotals, todayInZone, granularityFor, fulfilmentConfig, validateCustomDates, MAX_CUSTOM_DATES, pendingShopFromBody, pendingShopMetadata, menuCategoriesFromRow } from '@bitetime/shared'
import type { CartLine, Granularity } from '@bitetime/shared'
import { buildRevenueWorkbook, reportFilename, type ReportWindow } from './report.js'
import { resolveRevenueRange, type ResolvedRevenueRange } from './revenueWindow.js'
import { resolveSlug, orderPrefix, referralCodeOf, resolveReferredByCode, normalizeReferralCode, RESERVED_SLUGS } from './slug.js'
import { pickMerchantConfig, pickProfileFields, pickProductFields, pickOrderFields, ORDER_STATUSES } from './writes.js'

export const app = new Hono<AppEnv>()

// `exposeHeaders` is what lets the browser READ Content-Disposition on a cross-origin response,
// and the frontend and backend ARE different origins in production (Vercel ↔ Railway). Without
// it the revenue report download arrives with a body and no filename, and saves itself as the
// URL's last path segment.
app.use('/api/*', cors({
  origin: env.frontendUrl,
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Disposition'],
}))

const ORDER_HISTORY_LIMIT = 20

/**
 * Streams one object out of a PRIVATE bucket, with the type Storage recorded for it.
 *
 * The private buckets (`payment-proof`, `feedback-images`) have no storage.objects policies at
 * all, so the browser cannot fetch these bytes directly in either direction — a backend route
 * reading them with the service-role client is the only way out, and every such route ended up
 * writing the same download-then-arrayBuffer tail. Three copies was the point to stop.
 *
 * Callers do the AUTHORISATION. This function proves nothing about who may see the object; it is
 * only the transport, and it must never be handed a path that came from a request.
 *
 * A row can name an object Storage no longer holds — the two are restored separately, and objects
 * can be removed by hand. That is a 404, not a 500: the caller asked for something that is gone,
 * and reporting it as our failure sends a reader looking for a broken backend. Every OTHER
 * download error stays a 500, so a genuine Storage outage is never dressed up as "no such image".
 */
/**
 * Storage's own "there is no such object". `statusCode` is the field to read and it is a STRING;
 * the sibling `status` is 400 for this case, so a numeric check on `status` sees a bad request
 * where Storage means not-found. Shape observed on storage-js: { status: 400, statusCode: '404' }.
 */
function isMissingObject(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { statusCode?: string }).statusCode === '404'
}

async function streamPrivateObject(bucket: string, path: string): Promise<Response> {
  const { data, error } = await admin.storage.from(bucket).download(path)
  if (isMissingObject(error)) return Response.json({ error: 'not_found' }, { status: 404 })
  if (error || !data) {
    console.error(`Private object download failed (${bucket}):`, error?.message ?? 'no data')
    return Response.json({ error: 'download_failed' }, { status: 500 })
  }
  return new Response(await data.arrayBuffer(), {
    status: 200,
    headers: { 'Content-Type': data.type || 'application/octet-stream' },
  })
}

// ── Payment proof, shared by both upload doors ────────────────────────────────────────────────
// One bucket, two slots on the order: the CUSTOMER's own screenshot (`payment_proof`, posted
// unauthenticated from the order-placed screen) and the SHOP's copy (`payment_proof_merchant`,
// posted by the signed-in owner when the customer sent the slip over WhatsApp instead). The
// limits below are the bucket's own, and both doors must agree on them — hence one copy here
// rather than one per route. See docs/superpowers/specs/2026-08-04-payment-proof-upload-design.md.
const PAYMENT_PROOF_BUCKET = 'payment-proof'
// Same ceiling as MAX_PAYMENT_PROOF_BYTES/PAYMENT_PROOF_TYPES in store.ts and the migration's
// bucket config (20260804160000) — three copies by CLAUDE.md's rule (no shared build step across
// browser/server), one number.
const MAX_PAYMENT_PROOF_BYTES = 2 * 1024 * 1024
const PAYMENT_PROOF_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

type ProofUpload =
  | { ok: true; buffer: ArrayBuffer; contentType: string; ext: string }
  | { ok: false; response: Response }

/**
 * Reads a raw image body and proves it is one this bucket accepts — type, non-empty, under the
 * ceiling. Says nothing about WHO may upload it: each route does its own authorisation first.
 */
async function readProofUpload(c: Context): Promise<ProofUpload> {
  const contentType = c.req.header('Content-Type') ?? ''
  const ext = PAYMENT_PROOF_EXT[contentType]
  if (!ext) return { ok: false, response: c.json({ error: 'unsupported_type' }, 400) }

  const buffer = await c.req.arrayBuffer()
  if (buffer.byteLength === 0) return { ok: false, response: c.json({ error: 'invalid_body' }, 400) }
  if (buffer.byteLength > MAX_PAYMENT_PROOF_BYTES) {
    return { ok: false, response: c.json({ error: 'too_large' }, 400) }
  }
  return { ok: true, buffer, contentType, ext }
}

app.get('/health', (c) => c.json({ ok: true }))

/**
 * The server's clock, published.
 *
 * `priceOrder` runs on both sides of the wire and the promo window reads a clock, so the CLOCK is
 * a price input — and a browser minutes off ours, on the promo's last day, would quote the promo,
 * be refused (`price_changed`), re-quote with the same skewed clock, and be refused again: a
 * permanent refusal loop for a legitimate customer. The storefront syncs against this and prices
 * against the corrected time, so the clock it quotes with is the clock we charge with. See #69.
 */
app.get('/api/time', (c) => c.json({ now: new Date().toISOString() }))

// ── Platform subscription pricing ───────────────────────────────────────────────
// Everyone is charged MYR — the base prices are the same for every visitor, cached
// under one key. Country comes from a CDN header (or the `?country=` override for
// local dev/QA) and only picks the approximate local-currency estimate (fx.ts).
const pricingCache = createPricingCache<PricingPayload>({ ttlMs: 5 * 60_000, now: () => Date.now() })

app.get('/api/pricing', async (c) => {
  const country = detectCountry({
    explicitCountry: c.req.query('country') || undefined,
    getHeader: (name) => c.req.header(name),
  })
  try {
    // Base MYR prices are the same for everyone → cached under one key; the estimate
    // is a cheap pure lookup that varies by country, so it is not cached.
    const base = await pricingCache.get('base', () =>
      fetchBasePricing({
        prices: env.prices,
        retrievePrice: (id) =>
          stripe.prices
            .retrieve(id)
            .then((p) => ({ unit_amount: p.unit_amount, currency: p.currency })),
      }),
    )
    return c.json({ ...base, estimate: estimateFor(country) })
  } catch (err) {
    console.error('Pricing resolution failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Pricing unavailable' }, 502)
  }
})

// ── Superadmin reads ──────────────────────────────────────────────────────────
app.get('/api/merchants', requireSuperadmin, async (c) => {
  const { data, error } = await admin
    .from('merchants').select('*').order('created_at', { ascending: false })
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

app.get('/api/billing', requireSuperadmin, async (c) => {
  const { data, error } = await admin.from('merchant_billing').select('*')
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

// ── Merchant creation (any authenticated user creates their own shop) ──────────
// The insert goes through `admin` (service_role), which bypasses guard_merchant_status —
// so `status: 'pending'`, `owner_id: user.id` and `billing_region: 'MY'` are forced here,
// never read from the body. Only name/billing/referredByCode are accepted from the
// client (Global Constraint 1). Slug uniqueness resolution moved server-side now that the
// browser can no longer SELECT merchants.slug directly.
app.post('/api/merchants', requireUser, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({} as any))
  const name = String(body?.name ?? '').trim()
  if (!name) return c.json({ error: 'Missing name' }, 400)

  // Mandatory at signup and never editable afterwards (business_nature is no longer in
  // MERCHANT_CONFIG_FIELDS — see writes.ts). Shops that signed up before this was required keep
  // whatever they have (including null); this only gates NEW rows.
  const businessNature = body?.businessNature
  if (!isBusinessNature(businessNature)) {
    return c.json({ error: 'Missing or unknown business nature' }, 400)
  }

  // Chosen at signup, never editable afterwards (see writes.ts) — so unlike businessNature this
  // one has a sane default rather than forcing a choice: a caller that sends nothing gets the
  // column's own default, MYR.
  const currency = body?.currency === undefined ? DEFAULT_CURRENCY : body.currency
  if (!isCurrencyCode(currency)) {
    return c.json({ error: 'Unknown currency' }, 400)
  }

  const { data: rows } = await admin.from('merchants').select('slug')
  const slug = await resolveSlug(name, { taken: (rows ?? []).map((r) => r.slug), id: user.id })
  // Claim-wins (#253): resolveSlug checks CURRENT slugs only, so a freed slug is claimable even
  // while it sits in another shop's rename history — the new shop's claim kills that redirect.
  await admin.from('merchant_slug_history').delete().eq('old_slug', slug)

  const { data, error } = await admin
    .from('merchants')
    .insert({
      name,
      slug,
      order_prefix: orderPrefix(slug),
      owner_id: user.id,
      status: 'pending',
      billing_cycle: body?.billing ?? 'monthly',
      billing_region: 'MY', // everyone is charged MYR
      business_nature: businessNature,
      currency,
      referred_by_code: resolveReferredByCode(body?.referredByCode, referralCodeOf(user.id)),
    })
    .select()
    .single()
  if (error) return c.json({ error: 'Create failed' }, 500)

  // Self-serve: the trial is provisioned HERE, not by an approval, and for EVERY shop — there is
  // one plan and one way in (#222). Two things this must not do — fail the signup because Stripe
  // did (the account, the slug and the form's answers are worth more than the retry), and return
  // an `active` shop with no subscription behind it (startCardlessTrial owns that ordering). A
  // shop Stripe refused stays `pending` and the owner retries from the dashboard via
  // POST /api/merchants/:id/start-trial.
  //
  // `null` billing is not a shortcut: a shop created milliseconds ago has no merchant_billing
  // row, so there is no customer id to reuse and nothing for canStartTrial to refuse.
  const outcome = await startCardlessTrial(data, null)
  if (!outcome.ok) {
    console.error('Trial provisioning failed at signup for', data.id, '—', outcome.error)
    return c.json({ ...data, trial: false })
  }
  // `data` was read back before the claim flipped it, so say what is true now rather than making
  // the client refetch to find out.
  return c.json({ ...data, status: 'active', trial: outcome.trial })
})

// Owner-editable shop config. The update goes through `admin` (service_role), which bypasses
// guard_merchant_status — so `pickMerchantConfig` is the ONLY thing stopping an owner from
// self-activating a suspended shop (or reassigning owner_id) via a crafted body. See
// writes.ts and Global Constraint 1.
app.patch('/api/merchants/:id', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const picked = pickMerchantConfig(await c.req.json().catch(() => ({})), id)
  if (!picked.ok) return c.json({ error: picked.error }, 400)
  const patch = picked.patch
  if (Object.keys(patch).length === 0) return c.json({ error: 'No updatable fields' }, 400)
  // These two rules must see the row's CURRENT flags as well as the patch's. A merchant who
  // turns delivery off in one save and pickup off in the next sends two bodies that are each
  // legal alone — and lands on a storefront no customer can order from. `c.get('merchant')` is
  // the row `requireMerchantOwns` already loaded (`select('*')`) for the ownership check above,
  // so this is a read of already-fetched data, not a second query.
  //
  // The columns' own CHECK constraints (`merchants_one_fulfilment_method`,
  // `merchants_express_requires_origin`) are the backstop. These are the checks that can say
  // WHY, in time for the merchant still looking at the form, instead of a bare 500 out of
  // PostgREST.
  const stored = c.get('merchant')
  // The body is merchant-controlled and `admin` bypasses RLS, so the fulfilment bag that lands in
  // the row is the one THIS function produces, never the one that arrived: sorted, deduped,
  // clamped, unknown keys dropped. One writer, one reader — the storefront can never read back a
  // shape the settings form did not save.
  //
  // Keyed on whether the body actually CARRIES a fulfilment bag, never on whether it carries a
  // `config`. Deriving
  // the bag from an absent key reads as DEFAULT_FULFILMENT and writes it over the row, which
  // clears `custom_dates` and lifts the ADR 0015 pause behind a success toast. `config` is a
  // whole-column overwrite, so an untouched bag has to be carried forward explicitly.
  if (patch.config !== undefined) {
    const submitted = { ...(patch.config as Record<string, unknown>) }
    const storedConfig = (stored.config ?? null) as Record<string, unknown> | null
    if (submitted.fulfilment !== undefined) {
      const fulfilment = fulfilmentConfig(submitted)
      if (fulfilment.mode === 'custom') {
        // Counted on the RAW array, before `fulfilmentConfig` caps it: validating the truncated
        // list could never report `too_many`, so a 200-date body saved 91 of them silently —
        // the exact "trimmed, not refused" outcome the rule below exists to prevent.
        const raw = (submitted.fulfilment as Record<string, unknown>)?.custom_dates
        if (Array.isArray(raw) && raw.length > MAX_CUSTOM_DATES) {
          return c.json({ error: 'too_many' }, 400)
        }
        // The horizon needs a clock, so it cannot live in `fulfilmentConfig`. Refused here rather
        // than silently trimmed: a merchant who ticked a date past it must be told it did not save,
        // not discover months later that it never did.
        // The SUBMITTED timezone wins over the stored one: the Fulfilment tab saves the clock and
        // the dates in one body, and judging tomorrow's date against yesterday's zone is how an
        // honest save gets refused on the horizon's edge.
        const tz = (patch.timezone as string | undefined) ?? stored.timezone ?? DEFAULT_TIMEZONE
        const bad = validateCustomDates(fulfilment.custom_dates, tz, new Date())
        if (bad) return c.json({ error: bad }, 400)
      }
      submitted.fulfilment = fulfilment
    } else if (storedConfig?.fulfilment !== undefined) {
      submitted.fulfilment = fulfilmentConfig(storedConfig)
    }
    patch.config = submitted
  }
  const merged = {
    pickup: patch.pickup_enabled ?? stored.pickup_enabled,
    delivery: patch.delivery_enabled ?? stored.delivery_enabled,
    express: patch.express_enabled ?? stored.express_enabled,
  }
  if (!merged.pickup && !merged.delivery && !merged.express) {
    return c.json({ error: 'Your shop must offer at least one fulfilment method' }, 400)
  }
  if (merged.express) {
    const origin = patch.origin_place_id !== undefined ? patch.origin_place_id : stored.origin_place_id
    if (!origin) return c.json({ error: 'Set your delivery origin before switching on express delivery' }, 400)
  }
  const { data, error } = await admin.from('merchants').update(patch).eq('id', id).select().single()
  if (error) return c.json({ error: 'Update failed' }, 500)
  return c.json(data)
})

// Slug rename. Uniqueness resolution moves here now that the browser can no longer SELECT
// merchants.slug directly — the last browser read of merchants.
//
// The rename records the outgoing slug in merchant_slug_history (#253, ADR 0022) so the
// storefront edge function can 301 old links — printed QR codes and indexed URLs survive.
// The rename, the history row and the claim-wins delete are one transaction in slugRename.ts;
// this handler keeps only the checks a refusal message needs.
app.patch('/api/merchants/:id/slug', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const s = String((await c.req.json().catch(() => ({}))).slug ?? '').trim().toLowerCase()
  if (!s || RESERVED_SLUGS.includes(s)) return c.json({ error: 'Reserved or empty slug' }, 400)
  const { data: existing } = await admin.from('merchants').select('id').eq('slug', s).maybeSingle()
  if (existing && existing.id !== id) return c.json({ error: 'Slug already taken' }, 409)
  try {
    const row = await renameMerchantSlug(id, s)
    if (!row) return c.json({ error: 'Update failed' }, 500)
    return c.json(row)
  } catch {
    // A concurrent claim on the same slug lands here via the unique constraint — the same
    // answer the pre-check gives when it sees the conflict first.
    return c.json({ error: 'Slug already taken' }, 409)
  }
})

// ── Owner-scoped reads (tenant enforced by requireMerchantOwns) ────────────────

/**
 * The merchant's order list, one page at a time (#144).
 *
 * This used to be an unbounded `select *`. PostgREST caps a response at `max_rows` and says so
 * only in a `Content-Range` header nothing read, so a shop past its 1000th order was handed a
 * partial list that looked complete — its oldest orders simply unreachable, and its revenue
 * chart short by however much history fell off the end.
 *
 * The fix is not a bigger cap. It is that the caller now NAMES the window it wants and is told
 * what that window is a slice of: `total` is the exact matched count, so a page is a page rather
 * than a truncation wearing one's clothes. Paging, sorting and searching all happen in Postgres
 * for the same reason — a browser cannot search rows it was never sent.
 *
 * Still on the REST client rather than `ordersDb.ts`: these rows are RENDERED, and they must be
 * the same shape as the row a status PATCH hands back through the same client. Only the
 * aggregates, which need the whole history and read four columns of it, go through the driver.
 */
/**
 * Narrow an orders query to ONE status.
 *
 * `status` is nullable and an absent status MEANS 'new' — the storefront writes the column, but
 * rows predating it do not have one, and the dashboard has always read them as new. Stated once
 * here so the list, the count and the per-status tallies cannot disagree about what "new" holds.
 */
interface StatusFilterable<T> {
  or(filter: string): T
  eq(column: string, value: string): T
}
function byStatus<T extends StatusFilterable<T>>(q: T, status: string): T {
  return status === 'new' ? q.or('status.is.null,status.eq.new') : q.eq('status', status)
}

app.get('/api/merchants/:id/orders', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const parsed = parseOrderList(new URL(c.req.url).searchParams)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  const { page, pageSize, sort, dir, search, status } = parsed.query

  let q = admin
    .from('orders').select('*', { count: 'exact' }).eq('merchant_id', m.id)

  // The three fields a merchant actually looks someone up by. `searchTerm` has already removed
  // everything that would change this filter's meaning rather than be searched for.
  if (search) {
    q = q.or(
      `order_number.ilike.%${search}%,customer_name.ilike.%${search}%,customer_wa.ilike.%${search}%`,
    )
  }

  if (status) q = byStatus(q, status)

  const from = (page - 1) * pageSize
  const { data, error, count } = await q
    // The tiebreak is not decoration: without a total order, two orders sharing a sort value
    // come back in whatever order Postgres happens to yield, and page 2 can repeat a row page 1
    // already showed. `id` is unique, so this makes the paging honest.
    .order(sort, { ascending: dir === 'asc', nullsFirst: false })
    .order('id', { ascending: true })
    .range(from, from + pageSize - 1)
  if (error) return c.json({ error: 'Lookup failed' }, 500)

  return c.json({ orders: data ?? [], total: count ?? 0, page, pageSize })
})

/**
 * Every figure on the dashboard's Overview, computed HERE (#144).
 *
 * The browser used to fetch the shop's entire order table and aggregate it on the client, which
 * meant the revenue chart was only ever as complete as the row cap allowed — and a merchant has
 * no way to tell a wrong revenue figure from a right one. The orders now never leave the server:
 * `statsOrders` reads them uncapped through the driver, and `computeMerchantStats` is the SAME
 * shared module the XLSX export uses, so "booked excludes cancelled" stays stated once.
 *
 * Free, like the Overview it draws. The export beside it is the Pro capability, not the chart.
 */
/**
 * One shop's statistics, assembled once.
 *
 * Extracted so the Overview endpoint below and the analytics assistant read the SAME five
 * arguments through the SAME function. Two assemblies of one set of inputs is exactly how the
 * assistant and the chart beside it come to disagree — and a merchant given two different revenue
 * figures for one window has no way to tell which is the wrong one.
 *
 * Takes the merchant ROW, not an id: the caller has already loaded and authorised it, and passing
 * a bare id here would be a second place where a wrong one could arrive.
 */
async function shopStatsFor(
  m: Record<string, any>,
  window: { days: number; granularity: 'day' | 'week'; endDate?: string },
) {
  // Vouchers are per-shop promotions, a handful of rows — the row cap is not in play, and this
  // one stays on the REST client alongside the endpoint that serves the same rows to the
  // Vouchers tab.
  const [orders, customerCount, vouchers] = await Promise.all([
    statsOrders(m.id),
    distinctCustomerCount(m.id),
    admin.from('vouchers').select('used_by').eq('merchant_id', m.id)
      .then(r => (r.data ?? []).map(v => ({ usedBy: (v.used_by as unknown[]) ?? [] }))),
  ])

  const timeZone = shopTimeZone(m)
  return {
    stats: computeMerchantStats(orders, customerCount, vouchers, new Date(), {
      days: window.days, granularity: window.granularity, endDate: window.endDate, timeZone,
    }),
    timeZone,
  }
}

/**
 * The shop's zone, resolved and validated once per request.
 *
 * An unusable `merchants.timezone` would otherwise bucket the chart in the server's zone while
 * the merchant reads it in their own — and, on the export, date the filename in one zone while
 * bucketing the sheets in another: the file disagreeing with itself.
 */
function shopTimeZone(m: Record<string, any>): string {
  return isTimezone(m.timezone) ? m.timezone : DEFAULT_TIMEZONE
}

/**
 * The window a revenue request asks for, or a 400.
 *
 * `resolveRevenueRange` owns the rule (see `revenueWindow.ts`); this only reads the query and
 * turns a refusal into the response. `defaultDays` is what the endpoint assumes when the request
 * names no window at all — the chart has one, the export deliberately does not.
 *
 * A custom range travels onward as `days` plus `endDate`, which is all `computeMerchantStats`
 * needs to point the same bucket rules at a window that ends in the past.
 */
function revenueWindow(
  c: Context,
  timeZone: string,
  defaultDays: number | null,
):
  | { ok: true; range: ResolvedRevenueRange & { ok: true }; granularity: Granularity; endDate?: string }
  | { ok: false; res: Response } {
  const range = resolveRevenueRange(
    c.req.query('days'), c.req.query('from'), c.req.query('to'),
    todayInZone(timeZone, new Date()),
    defaultDays,
  )
  if (!range.ok) return { ok: false, res: c.json({ error: 'bad_range' }, 400) }

  const granularity = c.req.query('granularity') ?? granularityFor(range.days)
  if (granularity !== 'day' && granularity !== 'week') {
    return { ok: false, res: c.json({ error: 'bad_granularity' }, 400) }
  }
  return {
    ok: true,
    range,
    granularity,
    endDate: range.kind === 'custom' ? range.to : undefined,
  }
}

app.get('/api/merchants/:id/stats', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const w = revenueWindow(c, shopTimeZone(m), 12)
  if (!w.ok) return w.res

  const { stats } = await shopStatsFor(m, {
    days: w.range.days, granularity: w.granularity, endDate: w.endDate,
  })
  return c.json(stats)
})

/**
 * The shop's customers (#143). See CONTEXT.md → Shop customer.
 *
 * Aggregated in SQL and folded in TypeScript, which is what keeps it clear of the PostgREST row
 * cap — a shop past its 1000th order still gets a complete customer list here. This was the
 * first escape from that cap; the orders endpoint above took its own in #144.
 *
 * The list, its sorting and its tag filter are one free feature. Sorting and filtering used to be
 * the paid half of it, gated inside the handler rather than by middleware because the list itself
 * never was — that split went with the tier (#222).
 */
app.get('/api/merchants/:id/customers', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const q = new URL(c.req.url).searchParams

  const sort = q.get('sort') ?? DEFAULT_SHOP_CUSTOMER_SORT
  if (!isShopCustomerSort(sort)) return c.json({ error: 'invalid_sort' }, 400)
  // Same refusal for the segment (#269): `members` is the sidebar's Members child, and anything
  // else is a 400 rather than a list quietly answering a different question.
  const segment = q.get('segment') ?? DEFAULT_SHOP_CUSTOMER_SEGMENT
  if (!isShopCustomerSegment(segment)) return c.json({ error: 'invalid_segment' }, 400)
  const tag = q.get('tag') ?? undefined

  const [groups, records] = await Promise.all([shopCustomerGroups(m.id), shopCustomerRecords(m.id)])
  return c.json(shopCustomers(groups, records, {
    now: new Date(),
    sort,
    segment,
    tag,
    search: q.get('search') ?? undefined,
    page: Number(q.get('page')) || undefined,
    pageSize: Number(q.get('pageSize')) || undefined,
  }))
})

/**
 * One customer's orders, for the drawer. Free, like the list it opens from.
 *
 * A separate call rather than orders nested in the list above: the list is a table of hundreds
 * and the drawer opens for exactly one of them. Nesting would ship every customer's full order
 * history to draw a table that shows none of it — the row-cap mistake in a new costume.
 *
 * Cancelled orders are included. The badge is right there on each row, and a history that
 * silently omitted them would contradict the drawer's own header count.
 */
app.get('/api/merchants/:id/customers/:phoneKey/orders', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const key = phoneKey(c.req.param('phoneKey'))
  if (key === null || key !== c.req.param('phoneKey')) return c.json({ error: 'invalid_phone_key' }, 400)

  const { data, error } = await admin
    .from('orders').select('*')
    .eq('merchant_id', m.id).eq('customer_phone_key', key)
    .order('created_at', { ascending: false }).limit(ORDER_HISTORY_LIMIT)
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

// `phoneKey` on the path parameter is a SHAPE check, not a lookup: a key with no orders behind it
// is a harmless
// row that never joins, but a path segment that is not a key at all is a caller bug.
app.put('/api/merchants/:id/customers/:phoneKey', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const key = phoneKey(c.req.param('phoneKey'))
  if (key === null || key !== c.req.param('phoneKey')) return c.json({ error: 'invalid_phone_key' }, 400)

  const picked = pickShopCustomerFields(await c.req.json().catch(() => ({})))
  if (!picked.ok) return c.json({ error: 'invalid_body' }, 400)

  return c.json(await upsertShopCustomer(m.id, key, picked.fields))
})

/**
 * How many orders this shop has, optionally of one status.
 *
 * `head: true` with an exact count, so the answer is a number Postgres computed and never a
 * length the caller measured on a list it was handed — which is what the "new orders" badge used
 * to do, by fetching every order the shop had ever taken and filtering it in the browser. Past
 * the row cap that badge was simply wrong, and it was also the most expensive read in the
 * dashboard, running on a poll from every section.
 */
app.get('/api/merchants/:id/orders/count', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const status = c.req.query('status')
  // Refused, not ignored: a filter we silently drop answers a bigger question than the one asked.
  if (status !== undefined && !ORDER_STATUSES.includes(status)) {
    return c.json({ error: 'invalid_status' }, 400)
  }

  let q = admin
    .from('orders').select('id', { count: 'exact', head: true }).eq('merchant_id', m.id)
  if (status !== undefined) q = byStatus(q, status)

  const { count, error } = await q
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json({ count: count ?? 0 })
})

/**
 * The shop's orders TALLIED BY STATUS — the figures over the order list's filter chips.
 *
 * One grouped statement rather than a count per status, and it takes the list's own `search` so
 * a tally can never claim more orders than the list beneath it will show. A status the shop has
 * no orders in is simply absent from the map; the caller decides whether a zero is worth drawing.
 */
app.get('/api/merchants/:id/orders/status-counts', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const search = searchTerm(c.req.query('search'))
  try {
    return c.json({ counts: await orderStatusCounts(m.id, search) })
  } catch {
    return c.json({ error: 'Lookup failed' }, 500)
  }
})

// The revenue export.
//
// Read-only and single-statement, so it goes through `admin` and not `db.ts`; there is nothing to
// keep atomic. Every sheet is confined to the window, which is why the orders are narrowed BEFORE
// the totals are taken: `MerchantStats`'s own KPI block is all-time by design, since on the
// dashboard those cards sit above the range pills.
/**
 * `YYYY-MM-DD HH:mm` in the shop's zone.
 *
 * Not an offset-bearing ISO instant: the Summary sheet names the zone in its own row, and what
 * has to be true is that this stamp and the file's date columns read off the same clock. A
 * locale-formatted string ("6:05 p.m.") would be neither sortable nor unambiguous in a
 * spreadsheet, so the parts are assembled explicitly.
 */
function stampInZone(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

app.get('/api/merchants/:id/report.xlsx', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  // Resolved before the query is read: the range is checked against the SHOP's today, and the
  // sheets, the Summary's stamp and the filename all have to read off one clock.
  const timeZone = shopTimeZone(m)
  // No default range — the export refuses a request that names none. A workbook gets filed, and a
  // filed workbook whose range nobody stated is worse than a refusal.
  const w = revenueWindow(c, timeZone, null)
  if (!w.ok) return w.res
  const { days } = w.range
  const granularity = w.granularity

  // Through the driver, uncapped: a spreadsheet of a shop's accounting that quietly stopped at
  // its 1000th order would be worse than the chart doing it, because it gets filed (#144).
  const orders = await statsOrders(m.id)

  const now = new Date()
  const windowed = ordersInWindow(orders, now, { days, endDate: w.endDate, timeZone })
  const totals = windowTotals(windowed)
  // `productTop: Infinity` — a spreadsheet lists every product, unlike the six-wedge donut.
  // The customer count is 0 because no sheet shows it; the export's KPI block is `windowTotals`.
  const stats = computeMerchantStats(windowed, 0, [], now, {
    days, granularity, endDate: w.endDate, timeZone, productTop: Infinity,
  })

  const today = todayInZone(timeZone, now)
  const reportWindow: ReportWindow = {
    kind: w.range.kind,
    days,
    granularity,
    from: stats.series[0]?.start ?? (w.range.kind === 'custom' ? w.range.from : today),
    to: stats.series[stats.series.length - 1]?.end ?? (w.range.kind === 'custom' ? w.range.to : today),
    // Stamped in the SHOP's zone, like every other date in the file.
    generatedAt: stampInZone(timeZone, now),
  }
  const buffer = await buildRevenueWorkbook(
    {
      totalOrders: totals.totalOrders,
      revenue: totals.revenue,
      avgOrder: totals.avgOrder,
      series: stats.series,
      products: stats.productRevenue,
      statuses: stats.statusBreakdown,
    },
    // `merchants.currency` is NOT NULL DEFAULT 'MYR' (20260701120000_merchant_currency.sql), so
    // there is nothing to fall back to — and a fallback here would silently relabel some other
    // shop's money as MYR rather than showing that something is wrong.
    { name: m.name, slug: m.slug, currency: m.currency, timeZone },
    reportWindow,
  )

  // A raw Response, not `c.body`: Hono's body type is string | ArrayBuffer | ReadableStream and
  // a Node Buffer is none of them, though it is a perfectly good BodyInit.
  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${reportFilename(m.slug, today, reportWindow)}"`,
    },
  })
})

// Owner-scoped, and STILL not a verbatim row. `used_by` holds the platform account emails of the
// shop's redeemers, and CONTEXT.md -> Shop customer draws that boundary explicitly: a shop sees
// shop-scoped facts plus the has-an-account flag, and no account email. A WhatsApp number was
// volunteered to this shop; an email was volunteered to the platform. The merchant gets the count
// they actually use — how many redemptions the code has taken — and never the keys behind it.
app.get('/api/merchants/:id/vouchers', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { data, error } = await admin
    .from('vouchers')
    .select('id, merchant_id, code, kind, amount, max_uses, per_customer_limit, expires_at, min_order, used_by, active, created_at')
    // Inactive rows INCLUDED. A deactivated voucher is a paused campaign the merchant can resume,
    // not a deleted one, and a row that vanishes from the list is what made "Turn off" read as
    // delete. The customer-facing lookup and `claimVoucher` still filter `active` themselves.
    .eq('merchant_id', m.id)
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  const rows = data ?? []
  // One grouped count for the whole list, not one query per voucher. `used_by` is still selected
  // only as `voucherMerchantView`'s fallback until the column is dropped.
  const counts = await redemptionCounts(rows.map(r => r.id as string))
  return c.json(rows.map(r => voucherMerchantView(r, m.timezone, counts[r.id as string] ?? 0)))
})

app.get('/api/merchants/:id/billing', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { data, error } = await admin
    .from('merchant_billing').select('*').eq('merchant_id', m.id).maybeSingle()
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? null)
})

app.get('/api/merchants/:id/secret', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  const { data, error } = await admin
    .from('merchant_secrets').select('tg_token, tg_chat_id').eq('merchant_id', m.id).maybeSingle()
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? null)
})

// Secret upsert. The write goes through `admin` (service_role), which bypasses RLS and the
// restricted grants on merchant_secrets — so picking only tg_token/tg_chat_id off the body is
// the ONLY guard (Global Constraint 1). merchant_id is FORCED from :id, never read from the
// body, AND is the upsert's conflict target (merchant_secrets.merchant_id is the primary key —
// see 20260627120150_secure_merchant_secrets.sql), so the product-PUT hijack class (Global
// Constraint 2) does not apply here: there is no client-supplied child id to nest a foreign
// row under. No separate tenancy check is needed.
app.put('/api/merchants/:id/secret', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const b = await c.req.json().catch(() => ({}) as any)
  const row: Record<string, unknown> = { merchant_id: id }
  if (b?.tg_token !== undefined) row.tg_token = b.tg_token
  if (b?.tg_chat_id !== undefined) row.tg_chat_id = b.tg_chat_id
  const { error } = await admin.from('merchant_secrets').upsert(row)
  if (error) return c.json({ error: 'Upsert failed' }, 500)
  return c.json({ ok: true })
})

// ── User-scoped reads ─────────────────────────────────────────────────────────
app.get('/api/me/profile', requireUser, async (c) => {
  const user = c.get('user')
  const { data } = await admin
    .from('profiles')
    .select('id, name, email, app_role, merchant_id, whatsapp, delivery_address')
    .eq('user_id', user.id).is('merchant_id', null).maybeSingle()
  return c.json(data ?? null)
})

// Upsert the caller's GLOBAL profile (merchant_id IS NULL). The partial unique index
// (user_id WHERE merchant_id IS NULL) can't be an ON CONFLICT target, so this mirrors the old
// browser-side select-then-insert/update. Goes through `admin` (service_role), which BYPASSES
// guard_profile_privileges — so pickProfileFields + forcing user_id/merchant_id here is the
// ONLY guard against a caller granting themselves app_role or attaching to another merchant
// (Global Constraint 1). Never read user_id/merchant_id from the body.
app.put('/api/me/profile', requireUser, async (c) => {
  const user = c.get('user')
  const fields = pickProfileFields(await c.req.json().catch(() => ({})))
  const { data: existing } = await admin
    .from('profiles').select('id').eq('user_id', user.id).is('merchant_id', null).maybeSingle()
  if (existing) {
    const { error } = await admin.from('profiles').update(fields).eq('id', existing.id)
    if (error) return c.json({ error: 'Update failed' }, 500)
  } else {
    const { error } = await admin.from('profiles').insert({
      ...fields,
      user_id: user.id,
      email: fields.email ?? user.email,
      created_at: new Date().toISOString(),
    })
    if (error) return c.json({ error: 'Insert failed' }, 500)
  }
  return c.json({ ok: true })
})

app.get('/api/me/merchant', requireUser, async (c) => {
  const user = c.get('user')
  const { data } = await admin.from('merchants').select('*').eq('owner_id', user.id).maybeSingle()
  return c.json(data ?? null)
})

// ── Device limit ──────────────────────────────────────────────────────────────
//
// A merchant account holds at most MERCHANT_DEVICE_LIMIT signed-in devices, and one device is one
// GoTrue session. See docs/superpowers/specs/2026-08-25-merchant-device-limit-design.md.
//
// THE SESSION ID COMES FROM THE JWT, never from a body or a path. `requireUser` has already handed
// the token to GoTrue, which rejects a bad signature, a stale expiry or a deleted session, so the
// claim below is read from a string that is already proven. A body-supplied id would let any
// merchant sign out any device by guessing a uuid.
//
// These sit under /api/me/ beside the two routes above, and carry no merchant id: a path with one
// in it would invite a handler that trusts it.

/** The caller's own user id and session id, or null when the token carries no session claim. */
function callerSession(c: Context<AppEnv>): { userId: string; sessionId: string } | null {
  const sessionId = sessionIdFromToken(bearer(c))
  return sessionId ? { userId: c.get('user').id, sessionId } : null
}

/** True when this account owns a shop. The limit is a merchant rule and applies to nobody else. */
async function ownsAShop(userId: string): Promise<boolean> {
  const { data } = await admin.from('merchants').select('id').eq('owner_id', userId).limit(1)
  return (data?.length ?? 0) > 0
}

// Called by the browser right after a sign-in succeeds.
//
// It answers 200 for a customer rather than 403, unlike the two routes below: every sign-in calls
// this, and a customer signing in must not see an error in their console for a rule that is not
// about them.
app.post('/api/me/devices/enforce', requireUser, async (c) => {
  const caller = callerSession(c)
  if (!caller) return c.json({ evicted: 0 })
  if (!(await ownsAShop(caller.userId))) return c.json({ evicted: 0 })

  const sessions = await listSessions(caller.userId)
  const doomed = chooseEvictions({
    sessions,
    currentSessionId: caller.sessionId,
    limit: MERCHANT_DEVICE_LIMIT,
  })
  const evicted = await deleteSessions(caller.userId, doomed)
  return c.json({ evicted })
})

app.get('/api/me/devices', requireUser, async (c) => {
  const caller = callerSession(c)
  if (!caller) return c.json({ error: 'no_session_claim' }, 401)
  if (!(await ownsAShop(caller.userId))) return c.json({ error: 'Forbidden' }, 403)

  const sessions = await listSessions(caller.userId)
  // The browser and platform go out as PARTS. The sentence joining them is prose, and prose is
  // t(en, zh)'s job in the browser — a finished "Chrome on macOS" from here is untranslatable.
  //
  // `lastSeen` comes from deviceLimit.ts rather than being re-coalesced here: the ranking rule the
  // eviction turns on has one home, so the list cannot drift out of step with what gets evicted.
  // Most recently used first, so the merchant reads the list in the order they expect.
  const devices = sessions
    .map(s => ({
      id: s.id,
      ...deviceIdentity(s.userAgent),
      current: s.id === caller.sessionId,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      // The eviction RANK, which is not the same field as `updatedAt` and is the one the limit
      // actually turns on. Sent so the order of this list is the order devices will go in.
      lastSeen: new Date(lastSeen(s)).toISOString(),
    }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
  return c.json({ devices, limit: MERCHANT_DEVICE_LIMIT })
})

app.delete('/api/me/devices/:sessionId', requireUser, async (c) => {
  const caller = callerSession(c)
  if (!caller) return c.json({ error: 'no_session_claim' }, 401)
  if (!(await ownsAShop(caller.userId))) return c.json({ error: 'Forbidden' }, 403)

  const id = c.req.param('sessionId')
  // Checked here rather than left to Postgres: `id = any('{not-a-uuid}'::uuid[])` is a 22P02 and
  // would reach the merchant as a 500 for what is an ordinary bad request.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return c.json({ error: 'bad_session_id' }, 400)
  }

  // ONE statement, and its own `user_id` predicate is the whole tenancy guard: `db.ts` runs no
  // policy, so a stranger's session id matches nothing and comes back as a 404. Reading the
  // caller's sessions first and checking membership in TypeScript would be a second round trip
  // for a decision Postgres already makes — and a wider window between the check and the delete.
  const removed = await deleteSessions(caller.userId, [id])
  if (removed === 0) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true })
})

// Any signed-in customer's own history at a shop. NOT requireMerchantOwns — the uid filter,
// not merchant ownership, is what scopes it. A guest (no token) is 401 and has no history.
app.get('/api/merchants/:id/my-orders', requireUser, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const { data, error } = await admin
    .from('orders').select('*')
    .eq('merchant_id', id).eq('user_id', user.id)
    .order('created_at', { ascending: false }).limit(ORDER_HISTORY_LIMIT)
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

// ── Public: landing-page sample-shops carousel (#107) ──────────────────────────────────────────
// Registered BEFORE /api/merchants/:slug so the literal path "samples" is never captured as a
// slug. Unauthenticated, like /api/merchants/:slug and /api/merchants/:id/products below — same
// trust level, no tenant scoping needed. Deliberately does NOT reuse productFromRow/PricedProduct
// from @bitetime/shared: this response has no promo/pricing-engine fields, because it prices
// nothing — see docs/superpowers/specs/2026-08-04-sample-shops-carousel-design.md.
app.get('/api/merchants/samples', async (c) => {
  const { data: merchants, error } = await admin
    .from('merchants')
    .select('id, slug, name, currency, sample_screenshot_path')
    .eq('is_sample', true)
    .eq('status', 'active')
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  if (!merchants?.length) return c.json([])

  const { data: products, error: pErr } = await admin
    .from('products')
    .select('id, merchant_id, name, name_zh, price, image_urls')
    .in('merchant_id', merchants.map((m) => m.id))
    .eq('active', true)
    .order('sort', { ascending: true })
    .order('created_at', { ascending: true })
  if (pErr) return c.json({ error: 'Lookup failed' }, 500)

  const byMerchant = new Map<string, typeof products>()
  for (const p of products ?? []) {
    const list = byMerchant.get(p.merchant_id) ?? []
    if (list.length < 3) list.push(p)
    byMerchant.set(p.merchant_id, list)
  }

  return c.json(merchants.map((m) => ({
    id: m.id,
    slug: m.slug,
    name: m.name,
    currency: m.currency,
    screenshotPath: m.sample_screenshot_path,
    products: (byMerchant.get(m.id) ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      nameZh: p.name_zh,
      price: p.price,
      imagePath: p.image_urls?.[0] ?? null,
    })),
  })))
})

// ── Public reads (no auth — storefront) ───────────────────────────────────────

// The shop sitemap's source (#253): active shops' slugs, nothing else. Public by definition —
// this is exactly the list /sitemap-shops.xml publishes to every crawler. A database error is a
// 500, never an empty list: the sitemap function must answer 503 rather than tell Google every
// shop page is gone.
app.get('/api/storefront-index', async (c) => {
  const { data, error } = await admin
    .from('merchants').select('slug').eq('status', 'active').order('slug')
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json({ shops: data ?? [] })
})

// Shaped: strip internal columns before returning to an unauthenticated caller.
app.get('/api/merchants/:slug', async (c) => {
  const s = (c.req.param('slug') || '').trim().toLowerCase()
  if (!s) return c.json(null)
  const { data, error } = await admin.from('merchants').select('*').eq('slug', s).maybeSingle()
  if (error) return c.json(null)
  if (!data) {
    // A retired slug answers with the shop's CURRENT one (#253): the storefront edge function
    // turns this into a 301, and MerchantContext client-navigates. History stores the merchant
    // id, not a target slug, so a chain of renames always resolves to the current slug in one
    // hop. `null` stays the answer for a slug that never existed — callers pin that contract.
    const { data: moved } = await admin
      .from('merchant_slug_history').select('merchant_id').eq('old_slug', s).maybeSingle()
    if (!moved) return c.json(null)
    const { data: target } = await admin
      .from('merchants').select('slug').eq('id', moved.merchant_id).maybeSingle()
    return c.json(target ? { moved_to: target.slug } : null)
  }
  const { owner_id: _owner_id, referred_by_code: _referred_by_code, ...pub } = data
  return c.json(pub)
})

app.get('/api/merchants/:id/products', async (c) => {
  const id = c.req.param('id')
  const { data, error } = await admin
    .from('products').select('*').eq('merchant_id', id)
    .order('sort', { ascending: true }).order('created_at', { ascending: true })
  // A 5xx here is the client's "could not ask" signal — do NOT return [] on error.
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  return c.json(data ?? [])
})

// Product upsert. The write goes through `admin` (service_role), so pickProductFields is the
// ONLY guard against a crafted body writing merchant_id (forced to :id here, never read from
// the body) or promo_sold (see writes.ts — the trigger that pins it for other roles does not
// run for service_role).
// requireMerchantOwns only proves the caller owns :id — it says nothing about productId, so an
// owner of shop A could otherwise take over shop B's product by nesting it under :id = A: .upsert()
// conflict-resolves on the primary key, so if a row with that id already exists it gets UPDATEd
// in place (including merchant_id reassigned to A) instead of a new row being inserted. Loading
// the product and checking merchant_id === :id before upserting is what closes that hole
// (Global Constraint 2), mirroring the DELETE handler below.
// The promo, option-group and category columns on this endpoint used to be gated on the shop's
// tier, which is what made the body-vs-stored comparison in writes.ts necessary. The tier is gone
// (#222) and so is that gate; all three are ordinary product fields now, saved like any other.
app.put('/api/merchants/:id/products/:productId', requireMerchantOwns, requireOwnsChild('products', 'productId', { mayCreate: true }), async (c) => {
  const id = c.req.param('id')
  const productId = c.req.param('productId')
  const fields = pickProductFields(await c.req.json().catch(() => ({})))
  // The submitted `category_id` is deliberately NOT checked against the shop's category list: an
  // id the list no longer holds is the "uncategorized" reading the whole delete story rests on
  // (ADR 0013), so validating it here would turn a stale dashboard into a refused save.
  // ADR 0008 traded every `check` constraint on these groups for atomic saves and a jsonb column
  // that both drivers parse identically. THIS is what stands in their place: Postgres will store
  // `minSelect: 9, maxSelect: 2` without complaint, and a customer would then meet a question no
  // answer can satisfy. Refused here, where the merchant is present to see it, rather than as a
  // storefront that silently cannot be ordered from.
  if (fields.option_groups !== undefined) {
    const bad = validateOptionGroups(optionGroupsFromRow(fields.option_groups))
    if (bad) return c.json({ error: bad }, 400)
  }
  const row = { ...fields, id: productId, merchant_id: id }
  const { data, error } = await admin.from('products').upsert(row).select().single()
  if (error) return c.json({ error: 'Upsert failed' }, 500)
  return c.json(data)
})

// Product delete. requireMerchantOwns only proves the caller owns :id — it says nothing about
// productId, so an owner of shop A could otherwise delete shop B's product by nesting it under
// :id = A. Loading the product and checking merchant_id === :id before deleting is what closes
// that hole (Global Constraint 2).
app.delete('/api/merchants/:id/products/:productId', requireMerchantOwns, requireOwnsChild('products', 'productId'), async (c) => {
  const productId = c.req.param('productId')
  const { error } = await admin.from('products').delete().eq('id', productId)
  if (error) return c.json({ error: 'Delete failed' }, 500)
  return c.json({ ok: true })
})

/**
 * The merchant's arrangement of their own menu: which section each product sits in, and in what
 * order (docs/superpowers/specs/2026-08-17-storefront-arrangement-design.md).
 *
 * A separate endpoint rather than a field on the product upsert, because a rearrangement is one
 * decision about the whole menu — N upserts would leave a shop half-arranged when the fourth one
 * failed, and would need `sort` in `PRODUCT_FIELDS`, where a stale dashboard could drag a product
 * back to where it used to be behind an ordinary rename.
 *
 * `requireMerchantOwns` proves the caller owns :id. It says nothing about the product ids in the
 * body — the statement's own `merchant_id` predicate is what handles those, by matching none of
 * them. Hence `updated`, which a caller can compare against what it sent.
 */
app.put('/api/merchants/:id/product-order', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const parsed = parseProductOrder(await c.req.json().catch(() => null))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  try {
    const updated = await writeProductOrder(id, parsed.items)
    return c.json({ ok: true, updated })
  } catch {
    return c.json({ error: 'Update failed' }, 500)
  }
})

/**
 * Spend one call against a shop's Claude allowance. Returns null when the call may proceed, or
 * the refusal body when the allowance is gone.
 *
 * Both AI routes are bounded twice over, and the two bounds guard different things — the same
 * argument the Google quote endpoint makes in `quotaWindows.ts`:
 *
 *   * the DAILY in-memory window is the burst stop: free, and reset by a redeploy, which over a
 *     day does not matter;
 *   * this PERSISTED counter is the bill stop: it is in Postgres precisely because a redeploy
 *     must not clear it, and it is what catches the loop that sits just under the daily figure.
 *
 * The daily window is checked FIRST, so a call the burst stop already refused never eats a
 * month's allowance — it spent no money. This runs last of all the checks, immediately before the
 * model call, for the same reason the key check runs before both: nothing that was going to be
 * refused anyway may cost a merchant a unit.
 *
 * `lifetimeLimit` is the once-ever grant, spent BEFORE the month's — which is the whole point of
 * having one. A merchant photographing their menu for the first time draws on the grant and
 * leaves the month untouched; only once the grant is exhausted does the ordinary monthly figure
 * start counting. Pass null for a feature that has no grant.
 *
 * The refusal always quotes the MONTHLY limit and its reset date, never the grant's: a merchant
 * who has used their setup allowance cannot be told to wait for it to come back, because it never
 * does. What returns on the 1st is the monthly figure, and that is the only true thing to say.
 */
async function spendAiAllowance(
  m: Record<string, any>,
  feature: AiFeature,
  lifetimeLimit: number | null,
  monthlyLimit: number,
): Promise<{ error: string; limit: number; resets: string } | null> {
  const timeZone = isTimezone(m.timezone) ? m.timezone : DEFAULT_TIMEZONE
  const period = usagePeriod(timeZone, new Date())

  if (
    lifetimeLimit !== null
    && await consumeAiCall({ merchantId: m.id, feature, period: LIFETIME_PERIOD, limit: lifetimeLimit })
  ) {
    return null
  }
  if (await consumeAiCall({ merchantId: m.id, feature, period, limit: monthlyLimit })) return null

  return { error: 'monthly_limit_reached', limit: monthlyLimit, resets: nextResetDate(period) }
}

// Same pattern as githubDeps and releaseDeps: held mutable so an API test can drive the real
// route without a live Claude call.
export const menuImportDeps: { extract: ExtractMenu } = { extract: extractMenu }

/**
 * AI menu import (tasks/prd-ai-menu-import.md).
 *
 * Reads a photograph of the shop's menu and returns DRAFT products. It is the one route in this
 * file whose contract is that it changes nothing: no `products` row is created here, and none is
 * updated. The merchant corrects the drafts in the editor and saves them through the ordinary
 * product upsert above, under every rule that already applies there.
 *
 * That split is not tidiness. A reader that both guesses a price and commits it puts a wrong
 * number in front of a customer with nobody in between; a reader that only proposes cannot.
 *
 * Refusals, not degradations. A missing API key answers 503 and an unreadable response answers
 * 502 — never an empty draft list, which on screen is indistinguishable from "your menu has no
 * items on it" and is the failure this endpoint exists to avoid.
 */
app.post('/api/merchants/:id/menu-import', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  // A suspended or pending shop cannot sell, so it has no business spending the platform's
  // Claude budget. Checked here rather than left to the storefront gate, which does not run on
  // dashboard routes.
  if (m.status !== 'active') return c.json({ error: 'shop_not_active' }, 403)

  const body = await c.req.json().catch(() => null) as { image?: unknown; media_type?: unknown } | null
  if (!body) return c.json({ error: 'bad_body' }, 400)

  const mediaType = body.media_type
  if (mediaType !== 'image/jpeg' && mediaType !== 'image/png') {
    return c.json({ error: 'bad_media_type' }, 400)
  }
  const image = typeof body.image === 'string' ? body.image : ''
  if (!image) return c.json({ error: 'missing_image' }, 400)

  // Base64 carries 3 bytes per 4 characters. Checked on the ENCODED length so the cap is applied
  // before anything decodes a payload an attacker chose the size of.
  if (Math.floor((image.length * 3) / 4) > MAX_MENU_IMAGE_BYTES) {
    return c.json({ error: 'image_too_large' }, 413)
  }

  // Ahead of the quota deliberately: an unconfigured platform must not burn a shop's daily
  // allowance answering 503.
  if (!env.anthropicApiKey) return c.json({ error: 'menu_import_unavailable' }, 503)

  if (!menuImportMerchantWindow.allow(m.id)) {
    return c.json({ error: 'daily_limit_reached', limit: 20 }, 429)
  }

  const importRefusal = await spendAiAllowance(
    m, 'menu_import', MENU_IMPORT_LIFETIME_LIMIT, MENU_IMPORT_MONTHLY_LIMIT,
  )
  if (importRefusal) return c.json(importRefusal, 429)

  const draft = await menuImportDeps.extract(env.anthropicApiKey, {
    imageBase64: image,
    mediaType,
    currency: m.currency ?? 'MYR',
  })
  if (!draft) return c.json({ error: 'could_not_read_menu' }, 502)

  return c.json(draft)
})

export const assistantDeps: { ask: AskShopAssistant } = { ask: askShopAssistant }

/** The longest question the assistant will read. Past this it is not a question. */
const MAX_QUESTION_CHARS = 500

/**
 * The shop analytics assistant (tasks/prd-shop-analytics-assistant.md).
 *
 * The merchant is resolved and authorised by `requireMerchantOwns` BEFORE the tool handler below
 * is built, and the handler closes over that row. Nothing the caller sends — and nothing the
 * model says — can name a different shop, because there is no parameter in which to name one.
 * That is the whole tenancy argument: on this path `db.ts` runs as the database owner and no RLS
 * policy applies, so the invariant has to be structural rather than checked.
 */
app.post('/api/merchants/:id/ask', requireMerchantOwns, async (c) => {
  const m = c.get('merchant')
  if (m.status !== 'active') return c.json({ error: 'shop_not_active' }, 403)

  const body = await c.req.json().catch(() => null) as { question?: unknown; lang?: unknown } | null
  if (!body) return c.json({ error: 'bad_body' }, 400)

  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (!question) return c.json({ error: 'missing_question' }, 400)
  if (question.length > MAX_QUESTION_CHARS) return c.json({ error: 'question_too_long' }, 400)
  const lang = body.lang === 'zh' ? 'zh' : 'en'

  // Ahead of the ceiling, so an unconfigured platform does not spend a merchant's daily
  // allowance answering 503.
  if (!env.anthropicApiKey) return c.json({ error: 'assistant_unavailable' }, 503)

  if (!assistantMerchantWindow.allow(m.id)) {
    return c.json({ error: 'daily_limit_reached', limit: 50 }, 429)
  }

  // No lifetime grant: asking questions is the ongoing use of the feature, not a setup burst.
  const askRefusal = await spendAiAllowance(m, 'assistant', null, ASSISTANT_MONTHLY_LIMIT)
  if (askRefusal) return c.json(askRefusal, 429)

  const timeZone = isTimezone(m.timezone) ? m.timezone : DEFAULT_TIMEZONE

  const answer = await assistantDeps.ask(env.anthropicApiKey, {
    question,
    lang,
    currency: m.currency ?? DEFAULT_CURRENCY,
    timeZone,
    today: todayInZone(timeZone, new Date()),
    // The tool handler. The merchant row is captured here, out of the model's reach.
    getStats: async ({ days, granularity }) => (await shopStatsFor(m, { days, granularity })).stats,
  })

  if (!answer) return c.json({ error: 'could_not_answer' }, 502)

  // Built from the tool call, never written by the model — so it cannot describe a window the
  // model did not actually read. Null when the model answered without reading the figures at all,
  // which must not carry a disclaimer claiming it did.
  return c.json({
    answer: answer.text,
    window: answer.queried,
  })
})

app.get('/api/merchants/:id/vouchers/:code', async (c) => {
  const id = c.req.param('id')
  const code = c.req.param('code')
  // `active` is filtered here, not just at redemption, so a customer typing a code from a shop
  // that has stepped down to Basic is told it is not a code rather than being quoted a discount
  // the order transaction will then refuse. Same answer, one screen earlier.
  const { data, error } = await admin
    .from('vouchers')
    .select('id, code, kind, amount, max_uses, per_customer_limit, expires_at, min_order, used_by')
    .eq('merchant_id', id).eq('code', code)
    // Also what disambiguates the PARTIAL unique index: a retired row and a live row may share a
    // code, so a lookup on the string alone would be ambiguous. `maybeSingle` would 500 on it.
    .eq('active', true).maybeSingle()
  // Same contract: 5xx = could-not-ask; 200 null = shop has no such voucher.
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  if (!data) return c.json(null)
  // This route is PUBLIC and a voucher code is printed on flyers, so the row must never leave
  // verbatim: `used_by` holds the account email of every redeemer. `voucherPublicView` derives
  // `fully_used` and drops the keys. The caller's own "have I used this?" is answered from THEIR
  // OWN verified email and only when they present one — auth-optional, because a signed-out
  // customer still needs to see the discount before being asked to sign in.
  const user = await getUserFromToken(bearer(c))
  const email = (user?.email ?? '').trim().toLowerCase()
  // Their OWN count, and only theirs — the query is keyed on the email off their verified JWT, so
  // there is no shape of this request that asks about a stranger.
  const mine = email ? await myRedemptionCount(data.id as string, email) : undefined
  return c.json(voucherPublicView(data, user?.email ?? null, mine))
})

// Voucher create. The insert goes through `admin` (service_role), so forcing merchant_id
// from :id (never read from the body) is what stops a crafted body from creating a voucher
// under someone else's shop. This is an INSERT, not an upsert, so the product-PUT hijack
// class (conflict-resolving onto a stranger's row) does not apply here — there is no
// client-supplied id to collide on. `code` is uppercased/trimmed server-side, matching the
// old client-side `input.code.trim().toUpperCase()`.
//
// The discount and its restrictions are read by `parseVoucherRules`, shared with the PATCH below,
// so the unbounded refusal and the shop-clock expiry cannot hold on one route and not the other.
app.post('/api/merchants/:id/vouchers', requireMerchantOwns, async (c) => {
  const id = c.req.param('id')
  const m = c.get('merchant')
  const b = await c.req.json().catch(() => ({} as any))
  const code = String(b?.code ?? '').trim().toUpperCase()
  if (!code) return c.json({ error: 'Missing code' }, 400)

  const parsed = parseVoucherRules(b, m.timezone)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const { data, error } = await admin.from('vouchers').insert({
    merchant_id: id,
    code,
    ...parsed.rules,
  }).select().single()
  // A duplicate code is the merchant's own mistake and gets its own answer. The index is PARTIAL
  // (`where active`), so this can only collide with a LIVE voucher — a retired code's string is
  // free to use again.
  if (error?.code === '23505') return c.json({ error: 'duplicate_code' }, 409)
  if (error) return c.json({ error: 'Create failed' }, 500)
  // Through the same view as the list, so the dashboard reads ONE voucher shape. A fresh row's
  // `used_by` is empty and leaks nothing today; the point is that it can never start to.
  return c.json(voucherMerchantView(data, m.timezone, 0))
})

// Voucher edit: everything except the code. The code is the campaign's identity — printed on
// flyers, held by customers, and what the partial unique index keys on — so an edit changes what
// the code DOES and never what it IS. A merchant who needs a different string deactivates this
// one and creates the next; that is deliberately a new row, so the old campaign keeps its
// redemptions.
//
// Two body shapes, and the presence of `kind` tells them apart:
//   - the rules (`kind`, `amount`, the four limits), optionally with `active` — the sheet's save.
//     A FULL replacement, not a merge: the form sends every field on every save, and a merge would
//     make "I unticked the expiry" indistinguishable from "I did not mention it".
//   - `{ active }` alone — the list's Activate/Deactivate action, which must not have to know the
//     rules to flip a switch.
// Rows already redeemed are untouched either way — lowering `max_uses` under the count taken
// simply reads as fully used from now on.
//
// `active` is a PAUSE, not a delete, and an inactive voucher is therefore still editable — it is
// the same campaign, waiting. Reactivation is where the partial unique index bites: the merchant
// may have created a second live voucher with the same code in the meantime, and two live rows
// cannot share one. That is a 409 `duplicate_code`, the same answer create gives, and the
// dashboard tells them to deactivate the other one first.
//
// `requireOwnsChild` is the tenancy guard — the same hole as DELETE: `:id` proves the caller's
// shop, not the voucher's.
app.patch('/api/merchants/:id/vouchers/:voucherId', requireMerchantOwns, requireOwnsChild('vouchers', 'voucherId'), async (c) => {
  const m = c.get('merchant')
  const existing = c.get('child')
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const b = await c.req.json().catch(() => ({} as any))

  const patch: Record<string, unknown> = {}
  if (b?.active !== undefined) {
    if (typeof b.active !== 'boolean') return c.json({ error: 'Invalid active' }, 400)
    patch.active = b.active
  }
  if (b?.kind !== undefined) {
    const parsed = parseVoucherRules(b, m.timezone)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    Object.assign(patch, parsed.rules)
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'Nothing to update' }, 400)

  const { data, error } = await admin.from('vouchers')
    .update(patch)
    .eq('id', existing.id)
    .select()
    .single()
  if (error?.code === '23505') return c.json({ error: 'duplicate_code' }, 409)
  if (error) return c.json({ error: 'Update failed' }, 500)
  const counts = await redemptionCounts([existing.id as string])
  return c.json(voucherMerchantView(data, m.timezone, counts[existing.id as string] ?? 0))
})

// A voucher's history: each redemption with the order it was spent on. The same tenancy guard
// as PATCH and DELETE. What the rows may carry is decided in `voucherRedemptions` — the account
// email behind a redemption never leaves the database on any route.
app.get('/api/merchants/:id/vouchers/:voucherId/redemptions', requireMerchantOwns, requireOwnsChild('vouchers', 'voucherId'), async (c) => {
  const existing = c.get('child')
  if (!existing) return c.json({ error: 'Not found' }, 404)
  try {
    return c.json(await voucherRedemptions(existing.id as string))
  } catch (err) {
    console.error('Voucher redemptions lookup failed', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Lookup failed' }, 500)
  }
})

// Voucher delete. requireMerchantOwns only proves the caller owns :id — it says nothing
// about voucherId, so an owner of shop A could otherwise delete shop B's voucher by nesting
// it under :id = A. Loading the voucher and checking merchant_id === :id before deleting is
// what closes that hole (Global Constraint 2), mirroring the product DELETE handler above.
// DEACTIVATE, not delete. A hard delete would take the redemption history with it, and
// delete-and-recreate was also how a merchant silently reset `used_by`. The same write as
// `PATCH { active: false }` above, which is what the dashboard now sends — this verb survives
// for any caller still speaking it, and because a DELETE that deletes would be the one thing
// this route must never become.
//
// The unique index is PARTIAL (`(merchant_id, code) where active`), so deactivating a code frees
// its string: creating it again makes a NEW row with a new id, and the old campaign's redemptions
// stay attached to the old campaign and count against nobody.
app.delete('/api/merchants/:id/vouchers/:voucherId', requireMerchantOwns, requireOwnsChild('vouchers', 'voucherId'), async (c) => {
  const voucherId = c.req.param('voucherId')
  const { error } = await admin.from('vouchers').update({ active: false }).eq('id', voucherId)
  if (error) return c.json({ error: 'Delete failed' }, 500)
  return c.json({ ok: true })
})

// Order patch (status/note/tracking). The update goes through `admin` (service_role), so
// pickOrderFields is the ONLY guard against a crafted body writing e.g. total/user_id/
// order_number (Global Constraint 1) — status is additionally re-validated against
// ORDER_STATUSES here since the client-side check in store.ts is not a security boundary.
// requireMerchantOwns only proves the caller owns :id — it says nothing about orderId, so an
// owner of shop A could otherwise patch shop B's order by nesting it under :id = A. Loading the
// order and checking merchant_id === :id before updating is what closes that hole (Global
// Constraint 2), mirroring the product/voucher handlers above.
app.patch('/api/merchants/:id/orders/:orderId', requireMerchantOwns, requireOwnsChild('orders', 'orderId'), async (c) => {
  const orderId = c.req.param('orderId')
  const patch = pickOrderFields(await c.req.json().catch(() => ({})))
  if ('status' in patch && !ORDER_STATUSES.includes(patch.status as string)) {
    return c.json({ error: 'Invalid status' }, 400)
  }

  // A completed order's status is FINAL (ADR 0024). This is the enforcement point, not the UI:
  // the drawer hides the control, but the control is not a boundary, and the one move this
  // refusal exists for — completed → cancelled — RELEASES the voucher redemption the order spent
  // (ADR 0023), on goods the shop already handed over.
  //
  // A null status MEANS 'new' (the storefront wrote the column late), so the coalesce matches the
  // rest of this file. Only a status that DIFFERS is refused: an identical value changes nothing,
  // and a retried patch must stay a no-op rather than becoming an error. Note, courier and awb
  // stay writable on a completed order — a shop files an AWB after the fact, and nothing about
  // that is a status change.
  const currentStatus = (c.get('child')?.status as string | null) ?? 'new'
  if ('status' in patch && currentStatus === 'completed' && patch.status !== currentStatus) {
    return c.json({ error: 'order_completed' }, 409)
  }

  if (Object.keys(patch).length === 0) return c.json({ error: 'No updatable fields' }, 400)

  // One transaction: the patch, the order log, and the voucher void of ADR 0023 (ADR 0025). This
  // used to be a supabase-js update with the void trailing it best-effort; the log needed a
  // transaction, and the void came in with it. `pickOrderFields` is still the only guard on
  // which columns the body can name — patchOrder spreads its keys into the statement.
  let events: OrderEvent[]
  try {
    const result = await patchOrder(orderId, patch, c.get('user').id)
    if (!result) return c.json({ error: 'not_found' }, 404)
    // The same refusal as the pre-check above, judged on the locked row (ADR 0024): the
    // pre-check answers the stale-drawer case fast, this one is the boundary. A refused DATE
    // carries intake's own `fulfil_date_unavailable` — the shop is not taking that day, by its
    // own Fulfilment settings — at the 409 that code already carries on `REFUSAL_STATUS`.
    if ('refused' in result) return c.json({ error: result.refused }, 409)
    events = result.events
  } catch (err) {
    console.error('Order patch failed for order', orderId, err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Update failed' }, 500)
  }

  // The row is re-read over PostgREST, not returned by the statement above: the dashboard
  // patches its own list row from this body, and the driver's row shape differs (numeric as
  // string, timestamptz as Date). Same bytes as before the rewrite, plus the events it recorded.
  const { data, error } = await admin.from('orders').select().eq('id', orderId).single()
  if (error) return c.json({ error: 'Update failed' }, 500)
  return c.json({ ...data, events })
})

// The order log (#268, ADR 0025), oldest first. Same ownership chain as the PATCH above:
// requireOwnsChild is what proves :orderId belongs to :id. A shop reads its own orders' logs and
// nothing else; the customer has no route to this at all.
app.get(
  '/api/merchants/:id/orders/:orderId/events',
  requireMerchantOwns,
  requireOwnsChild('orders', 'orderId'),
  async (c) => {
    try {
      return c.json({ events: await listOrderEvents(c.req.param('orderId')) })
    } catch (err) {
      console.error('Order log read failed:', err instanceof Error ? err.message : String(err))
      return c.json({ error: 'lookup_failed' }, 500)
    }
  },
)

// The image itself, for the merchant dashboard. Same ownership chain as the PATCH above — see
// its own comment for why requireOwnsChild is what actually proves :orderId belongs to :id, not
// just requireMerchantOwns. `child` here is the order row requireOwnsChild already loaded; no
// second query.
app.get(
  '/api/merchants/:id/orders/:orderId/payment-proof',
  requireMerchantOwns,
  requireOwnsChild('orders', 'orderId'),
  async (c) => {
    const order = c.get('child')
    const path = order?.payment_proof as string | null | undefined
    if (!path) return c.json({ error: 'not_found' }, 404)

    return streamPrivateObject(PAYMENT_PROOF_BUCKET, path)
  },
)

// ── The shop's own copy of the receipt ────────────────────────────────────────────────────────
// A customer paying by transfer often closes the browser before uploading anything and sends the
// slip over WhatsApp — the shop then holds the only copy. These two routes are where it goes.
//
// A SECOND column and a distinct object name (`{merchant_id}/{order_id}-merchant.{ext}`), never
// the customer's slot: what the customer attached and what the shop filed are different claims,
// and a merchant upload must not be able to replace the customer's own evidence.
//
// Same ownership chain as the PATCH and the customer-proof GET above — requireMerchantOwns proves
// the caller owns :id, requireOwnsChild proves :orderId belongs to that shop.
app.post(
  '/api/merchants/:id/orders/:orderId/merchant-payment-proof',
  requireMerchantOwns,
  requireOwnsChild('orders', 'orderId'),
  async (c) => {
    const merchantId = c.req.param('id')
    const orderId = c.req.param('orderId')
    const upload = await readProofUpload(c)
    if (!upload.ok) return upload.response

    // The shop id comes from the authorised route param, never from the body — the same rule the
    // customer door gets by looking the order's own merchant up.
    const path = `${merchantId}/${orderId}-merchant.${upload.ext}`
    const { error } = await admin.storage
      .from(PAYMENT_PROOF_BUCKET)
      .upload(path, upload.buffer, { contentType: upload.contentType, upsert: true })
    if (error) {
      console.error('Merchant payment proof upload failed:', error.message)
      return c.json({ error: 'upload_failed' }, 500)
    }

    // Returns the two fields the write moved — the path, and a status that may have left
    // pending_payment. The sheet patches its own list row from them rather than refetching, the
    // same shape every other order write on this route file hands back.
    // The events this write recorded ride along (ADR 0025), so the sheet appends them to the
    // log it is showing without a second request.
    const row = await setOrderMerchantPaymentProof(orderId, path, c.get('user').id)
    return c.json({ ok: true, ...row })
  },
)

// The image itself. `child` is the order row requireOwnsChild already loaded; no second query.
app.get(
  '/api/merchants/:id/orders/:orderId/merchant-payment-proof',
  requireMerchantOwns,
  requireOwnsChild('orders', 'orderId'),
  async (c) => {
    const order = c.get('child')
    const path = order?.payment_proof_merchant as string | null | undefined
    if (!path) return c.json({ error: 'not_found' }, 404)

    return streamPrivateObject(PAYMENT_PROOF_BUCKET, path)
  },
)

// The customer-facing twin of the route above — same bytes, scoped by the order's user_id
// instead of merchant ownership. No requireOwnsChild here: that middleware proves MERCHANT
// ownership of a child row, which is the wrong question for a customer — so the check is
// inline, same 404-for-both shape as requireOwnsChild uses (a stranger's guess and a missing
// order must look identical, or the 404 itself becomes an oracle).
app.get('/api/orders/:orderId/payment-proof', requireUser, async (c) => {
  const user = c.get('user')
  const orderId = c.req.param('orderId')
  const { data: order, error } = await admin
    .from('orders').select('user_id, payment_proof').eq('id', orderId).maybeSingle()
  if (error) return c.json({ error: 'lookup_failed' }, 500)
  if (!order || order.user_id !== user.id) return c.json({ error: 'not_found' }, 404)
  const path = order.payment_proof as string | null
  if (!path) return c.json({ error: 'not_found' }, 404)

  return streamPrivateObject(PAYMENT_PROOF_BUCKET, path)
})

// The customer's door to the receipt the SHOP filed for their order. Same bytes the merchant
// reads, scoped by the order's user_id — a customer who sent their slip over WhatsApp must be
// able to see that the shop has it, or the order sits at "we have your money" with nothing on
// screen to say so. Inline ownership check, same 404-for-everything shape as the twin above:
// a stranger, a guest order and an empty column must be indistinguishable.
app.get('/api/orders/:orderId/merchant-payment-proof', requireUser, async (c) => {
  const user = c.get('user')
  const orderId = c.req.param('orderId')
  const { data: order, error } = await admin
    .from('orders').select('user_id, payment_proof_merchant').eq('id', orderId).maybeSingle()
  if (error) return c.json({ error: 'lookup_failed' }, 500)
  if (!order || order.user_id !== user.id) return c.json({ error: 'not_found' }, 404)
  const path = order.payment_proof_merchant as string | null
  if (!path) return c.json({ error: 'not_found' }, 404)

  return streamPrivateObject(PAYMENT_PROOF_BUCKET, path)
})

// ── Invoice ───────────────────────────────────────────────────────────────────
//
// One document, three doors, and the SAME bytes through all three — a guest today is an account
// holder next month, and they must not be handed two different papers for two orders from one
// shop. See docs/adr/0017 and CONTEXT.md → Invoice.
//
// Every refusal here is the same 404. A status that cannot be issued, an order that does not
// exist, a stranger's order and a wrong phone are one answer, because any distinction between
// them tells a caller which order numbers are real.

/** The generated PDF, as a download. */
function invoicePdfResponse(pdf: Uint8Array, orderNumber: string): Response {
  // Copied into a plain ArrayBuffer: pdf-lib hands back a Uint8Array over a pooled buffer, which
  // is not the `BodyInit` the fetch types accept, and slicing is also what guarantees the body is
  // exactly this document's bytes.
  const body = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoiceFileName(orderNumber)}"`,
      // A shop can edit its payment note or its address, and the document reads both live. Never
      // cached, so a re-download is never yesterday's paper.
      'Cache-Control': 'no-store',
    },
  })
}

/** Render, or answer the one refusal this endpoint family has. */
async function invoiceFor(c: Context, order: Record<string, any> | null, merchant: Record<string, any> | null) {
  if (!order || !merchant || !canIssueInvoice(order.status)) return c.json({ error: 'not_found' }, 404)
  const pdf = await renderInvoicePdf(order, merchant, { font: invoiceFont(), frontendUrl: env.frontendUrl })
  return invoicePdfResponse(pdf, order.order_number)
}

// The merchant's own copy — the one they forward on WhatsApp when a customer asks them directly.
app.get(
  '/api/merchants/:id/orders/:orderId/invoice.pdf',
  requireMerchantOwns,
  requireOwnsChild('orders', 'orderId'),
  async (c) => invoiceFor(c, c.get('child'), c.get('merchant')),
)

// The signed-in customer's copy, scoped by the order's `user_id` — the same shape as the
// payment-proof twin above, and inline for the same reason: `requireOwnsChild` proves MERCHANT
// ownership, which is the wrong question for a customer.
app.get('/api/orders/:orderId/invoice.pdf', requireUser, async (c) => {
  const user = c.get('user')
  const { data: order, error } = await admin
    .from('orders').select('*').eq('id', c.req.param('orderId')).maybeSingle()
  if (error) return c.json({ error: 'lookup_failed' }, 500)
  if (!order || order.user_id !== user.id) return c.json({ error: 'not_found' }, 404)
  const { data: merchant } = await admin
    .from('merchants').select('*').eq('id', order.merchant_id).maybeSingle()
  return invoiceFor(c, order, merchant)
})

/**
 * The guest's door.
 *
 * A guest order carries `user_id = null` for ever and there is no `/track` any more, so this is
 * the only way that customer reaches their own document. What they can prove is the order number
 * and the phone they typed, matched on `phoneKey()` — the last-eight-digits rule that already
 * keys a shop customer (ADR 0007), reused rather than re-derived.
 *
 * The shop is REQUIRED, and is not decoration: an order number is unique per shop only — the
 * prefix is the first two alphanumerics of the slug — so without it `BI-260820-0051` can name
 * two orders at two shops.
 *
 * The pair is guessable, and ADR 0018 accepts that knowingly. The limit below is what bounds it;
 * it is in memory, so a second backend instance doubles it (#101).
 */
app.post('/api/orders/invoice', async (c) => {
  if (!invoiceLookupIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)

  const body = await c.req.json().catch(() => ({}))
  const slug = typeof body.shop === 'string' ? body.shop.trim().toLowerCase() : ''
  const orderNumber = typeof body.orderNumber === 'string' ? body.orderNumber.trim().toUpperCase() : ''
  // Null for a phone with no digits, which must never become a key: '' is what BOTH an absent
  // phone and a phone-less order reduce to, and matching those would hand back the enumeration
  // the phone requirement exists to remove.
  const key = phoneKey(typeof body.phone === 'string' ? body.phone : '')
  if (!slug || !orderNumber || !key) return c.json({ error: 'not_found' }, 404)

  const { data: merchant, error: mErr } = await admin
    .from('merchants').select('*').eq('slug', slug).maybeSingle()
  if (mErr) return c.json({ error: 'lookup_failed' }, 500)
  if (!merchant) return c.json({ error: 'not_found' }, 404)

  const { data: order, error } = await admin
    .from('orders').select('*')
    .eq('merchant_id', merchant.id)
    .eq('order_number', orderNumber)
    .eq('customer_phone_key', key)
    .maybeSingle()
  if (error) return c.json({ error: 'lookup_failed' }, 500)

  return invoiceFor(c, order, merchant)
})

// ── Order reviews — the customer's own 1-5 stars on their own order ────────────────────────────
//
// Two doors, and they are the invoice doors' twins on purpose: the same two customers exist here
// (a signed-in one holding a `user_id`, a guest holding nothing but the order number and the
// phone they typed), so the same two proofs answer them. See
// docs/superpowers/specs/2026-09-03-order-reviews-design.md.
//
// Both write through the service-role client. `orders` grants the browser nothing at all, so
// there is no client path to close and no policy to lean on — the ownership check IS the route's.

/**
 * The write itself, shared by both doors. The caller has already PROVED the order is the one it
 * may review; this does not re-check ownership and must never be reached before that proof.
 *
 * The parsed body is passed in rather than re-read, so the guest door reads the request once.
 */
interface ReviewableOrder {
  id: string
  status: string | null
}

async function writeOrderReview(c: Context, order: ReviewableOrder, body: unknown) {
  // A cancelled order has nothing to rate, and the shop cannot act on the answer. 409 rather
  // than 404: the customer proved this order, so pretending it is missing would be a lie they
  // can see through.
  if (order.status === 'cancelled') return c.json({ error: 'order_cancelled' }, 409)

  const parsed = validateOrderReview(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  // `review_at` is derived here and never taken from the body — the validator drops it, and this
  // is the other half of that rule. A change to a review moves the timestamp: it records the last
  // write, not the first.
  const { data, error } = await admin
    .from('orders')
    .update({
      review_rating: parsed.value.rating,
      review_comment: parsed.value.comment,
      review_at: new Date().toISOString(),
    })
    .eq('id', order.id)
    .select('review_rating, review_comment, review_at')
    .single()
  if (error) {
    console.error('Order review write failed:', error.message)
    return c.json({ error: 'review_failed' }, 500)
  }
  return c.json(data)
}

// The signed-in customer's door, scoped by the order's `user_id`. Inline ownership check for the
// same reason the payment-proof and invoice twins have one: `requireOwnsChild` proves MERCHANT
// ownership, which is the wrong question for a customer. A stranger's order, a guest order and a
// missing order all return the same 404, or the 404 becomes an oracle.
app.post('/api/orders/:orderId/review', requireUser, async (c) => {
  const user = c.get('user')
  const { data: order, error } = await admin
    .from('orders').select('id, status, user_id').eq('id', c.req.param('orderId')).maybeSingle()
  if (error) return c.json({ error: 'lookup_failed' }, 500)
  if (!order || order.user_id !== user.id) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  return writeOrderReview(c, order, body)
})

/**
 * The guest's door — the same proof `POST /api/orders/invoice` takes.
 *
 * A guest order carries `user_id = null` for ever, so the only thing that customer can prove is
 * the order number and the phone they typed, matched on `phoneKey()` (ADR 0007's last-eight-digit
 * rule). The shop is REQUIRED and is not decoration: an order number is unique per shop only.
 *
 * The pair is guessable, and ADR 0018 accepts that knowingly. `reviewSubmitIpWindow` is what
 * bounds it; it is in memory, so a second backend instance doubles it (#101). What a successful
 * guess wins here is the ability to leave a star rating on a stranger's order — no read of the
 * order, and nothing in the response that a guesser did not already send.
 */
app.post('/api/orders/review', async (c) => {
  if (!reviewSubmitIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)

  const body = await c.req.json().catch(() => ({}))
  const slug = typeof body.shop === 'string' ? body.shop.trim().toLowerCase() : ''
  const orderNumber = typeof body.orderNumber === 'string' ? body.orderNumber.trim().toUpperCase() : ''
  // Null for a phone with no digits, which must never become a key: '' is what BOTH an absent
  // phone and a phone-less order reduce to, and matching those would hand back the enumeration
  // the phone requirement exists to remove.
  const key = phoneKey(typeof body.phone === 'string' ? body.phone : '')
  if (!slug || !orderNumber || !key) return c.json({ error: 'not_found' }, 404)

  const { data: merchant, error: mErr } = await admin
    .from('merchants').select('id').eq('slug', slug).maybeSingle()
  if (mErr) return c.json({ error: 'lookup_failed' }, 500)
  if (!merchant) return c.json({ error: 'not_found' }, 404)

  // `user_id is null` is what keeps this the GUEST's door and not a second door onto everyone's
  // orders. The guest invoice door omits it knowingly (ADR 0018: the document is the customer's
  // own either way), but this one WRITES, so a guessed pair here would overwrite a signed-in
  // customer's own rating. That customer already has a door — their token — and loses nothing.
  const { data: order, error } = await admin
    .from('orders').select('id, status')
    .eq('merchant_id', merchant.id)
    .eq('order_number', orderNumber)
    .eq('customer_phone_key', key)
    .is('user_id', null)
    .maybeSingle()
  if (error) return c.json({ error: 'lookup_failed' }, 500)
  if (!order) return c.json({ error: 'not_found' }, 404)

  return writeOrderReview(c, order, body)
})

// ── Create a Stripe Checkout Session for the signed-in merchant ────────────────
app.post('/api/checkout', requireOwnMerchant, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { billing } = body
  if (!isValidCycle(billing)) {
    return c.json({ error: 'Invalid billing cycle' }, 400)
  }
  // Caller and their own shop both resolved by `requireOwnMerchant` — one merchant per owner.
  const user = c.get('user')
  const merchant = c.get('merchant')

  // Reuse an existing Stripe customer if we have one, else create and store it.
  const { data: existing } = await admin
    .from('merchant_billing')
    .select('stripe_customer_id, status, comped')
    .eq('merchant_id', merchant.id)
    .maybeSingle()

  // Comp is terminal until a superadmin revokes it. Ahead of the live-subscription check on
  // purpose: a comped row carries status 'active', so that check would fire first and tell the
  // merchant they already have a subscription — which is the one thing they do not have.
  if (existing?.comped) return c.json({ error: 'shop_is_comped' }, 409)

  // A live subscription means there is nothing to buy here — refuse rather
  // than create a second subscription (double-billing), e.g. for a shop an
  // admin suspended while its Stripe subscription is still running.
  if (existing && LIVE_STATUSES.includes(existing.status ?? '')) {
    return c.json({ error: 'This shop already has an active subscription' }, 409)
  }

  let customerId = existing?.stripe_customer_id
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: merchant.name,
      metadata: { merchant_id: merchant.id },
    })
    customerId = customer.id
    await upsertBilling(merchant.id, { stripe_customer_id: customerId })
  }

  const metadata = { merchant_id: merchant.id, billing, region: 'MY' }
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceFor(billing), quantity: 1 }],
    client_reference_id: merchant.id,
    metadata,
    // Stripe hides the promo-code field unless asked, so a coupon we hand a merchant is
    // unredeemable without this. It only surfaces the input — the code still has to exist
    // as a promotion code in Stripe (a bare coupon has nothing customer-facing to type).
    allow_promotion_codes: true,
    // No trial here: trials are granted only by superadmin approval (cardless).
    // Checkout is the paid path — pro signup and suspended-shop reactivation.
    subscription_data: { metadata },
    // `checkout=success` (query) drives MerchantHome's poll-until-active; the hash lands the new
    // subscriber on the Subscription tab once it clears. Query before hash — MerchantHome reads
    // the query, the hash survives the param clear and deep-links the tab.
    success_url: `${env.frontendUrl}/merchant?checkout=success#settings/subscription`,
    cancel_url: `${env.frontendUrl}/merchant/signup?billing=${billing}&canceled=1`,
  })

  return c.json({ url: session.url })
})

// ── Reconcile the signed-in merchant's own subscription from Stripe ────────────
// The recovery path for the route above. Checkout redirects to `?checkout=success`, and until
// this existed the only thing that could open the shop behind that redirect was one delivery of
// `checkout.session.completed` — so a webhook that never arrived left a merchant who had just
// been charged staring at "Setting up your subscription…" with nothing on either side able to
// move it. billingSync.ts holds the rule; see its header for why the sweep does not cover this.
//
// Rate-limited per SHOP rather than per IP: it costs a Stripe API call and its only legitimate
// caller is one dashboard retrying for a few seconds. Ten a minute is far above that and far
// below anything worth Stripe's notice.
const billingSyncWindow = createSlidingWindow({ limit: 10, windowMs: 60_000, now: () => Date.now() })

app.post('/api/billing/sync', requireOwnMerchant, async (c) => {
  const merchant = c.get('merchant')
  if (!billingSyncWindow.allow(merchant.id)) return c.json({ error: 'rate_limited' }, 429)
  try {
    return c.json(await syncMerchantBilling(merchant.id, merchant.status))
  } catch (err) {
    if (isStripeError(err)) return stripeFailed(c, `billing sync for merchant ${merchant.id}`, err)
    console.error(`Billing sync failed for merchant ${merchant.id}:`, err instanceof Error ? err.message : String(err))
    return c.json({ error: 'sync_failed' }, 500)
  }
})

// ── Superadmin: push a stuck merchant through to active ────────────────────────
// Signup provisions its own trial now (POST /api/merchants), so this is no longer a gate
// anybody waits at — it is the admin-side fallback for a shop parked at `pending` because
// Stripe refused during signup and the merchant never retried. Same rule, different caller:
// trialSubscription.ts holds it.
//
// Unlike the owner's retry below, this ACTIVATES a shop it cannot re-trial (`canStartTrial`
// false → `{ ok: true, trial: false }`): an admin pushing a shop through means "open this shop",
// and the one-trial-ever rule limits the trial, not the activation.
app.post('/api/admin/approve-merchant', requireSuperadmin, async (c) => {
  const { merchantId } = await c.req.json().catch(() => ({}))
  if (!merchantId) return c.json({ error: 'Missing merchantId' }, 400)

  // These reads are independent — the target merchant + its billing load in parallel.
  // merchant_billing keys on the merchants PK, so both use merchantId directly. Run them
  // concurrently to save cross-network round-trips (Railway → Supabase); requireSuperadmin
  // has already gated the caller before this handler runs.
  const [merchantRes, billingRes] = await Promise.all([
    admin
      .from('merchants')
      .select('id, name, status, billing_cycle, owner_id')
      .eq('id', merchantId)
      .maybeSingle(),
    admin.from('merchant_billing').select('*').eq('merchant_id', merchantId).maybeSingle(),
  ])

  const { data: merchant, error } = merchantRes
  if (error) return c.json({ error: 'Lookup failed' }, 500)
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const refusal = trialStartRefusal(merchant)
  if (refusal) return c.json({ error: refusal }, 409)

  const outcome = await startCardlessTrial(merchant, billingRes.data)
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.http)
  return c.json({ ok: true, trial: outcome.trial })
})

// ── Owner: retry trial provisioning for a shop parked at `pending` ─────────────
// The self-serve twin of approve-merchant above. `pending` means "provisioning did not finish"
// now, which is a Stripe failure during signup — so the merchant, not an admin, is who should
// be able to push it through.
//
// Every guard runs BEFORE the first Stripe call. That is what makes them assertable in
// tests/api, which is network-free, and it is why one-trial-ever is checked HERE rather than
// left to startCardlessTrial: that function deliberately activates a shop it cannot re-trial
// (approval's semantics), which is not what an owner asking for a trial should be handed.
app.post('/api/merchants/:id/start-trial', requireMerchantOwns, async (c) => {
  const merchant = c.get('merchant') // loaded by the guard with select('*')

  const refusal = trialStartRefusal(merchant)
  if (refusal) return c.json({ error: refusal }, 409)

  const { data: billing } = await admin
    .from('merchant_billing').select('*').eq('merchant_id', merchant.id).maybeSingle()
  if (!canStartTrial(billing)) {
    return c.json({ error: 'This shop has already used its free trial — subscribe to reopen it.' }, 409)
  }

  // Named rather than spread: `c.get('merchant')` is the whole row as `Record<string, any>`, and
  // listing the four columns the provisioning actually reads is what keeps that untyped bag from
  // reaching it.
  const outcome = await startCardlessTrial({
    id: merchant.id,
    name: merchant.name,
    owner_id: merchant.owner_id,
    billing_cycle: merchant.billing_cycle,
  }, billing)
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.http)
  return c.json({ ok: true, trial: outcome.trial })
})

// ── Superadmin: manual suspend / reject / reactivate ───────────────────────────
// merchants.status is service_role-only at the DB layer (guard_merchant_status),
// so the admin console can no longer flip it through PostgREST — these writes must
// come through here. Covers Reject (pending→suspended), Suspend (active→suspended),
// and Reactivate (suspended→active). Trial-granting stays in approve-merchant and its
// owner-side twin.
app.post('/api/admin/set-merchant-status', requireSuperadmin, async (c) => {
  const { merchantId, status } = await c.req.json().catch(() => ({}))
  if (!merchantId) return c.json({ error: 'Missing merchantId' }, 400)
  // 'pending' is never a manual target — it is reached only by revert paths.
  if (status !== 'active' && status !== 'suspended') {
    return c.json({ error: 'status must be active or suspended' }, 400)
  }

  const { data: merchant } = await admin
    .from('merchants').select('id').eq('id', merchantId).maybeSingle()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  try {
    await setMerchantStatus(merchantId, status)
  } catch (err) {
    console.error('set-merchant-status failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Status update failed' }, 500)
  }
  return c.json({ ok: true, status })
})

/**
 * Product copy (CONTEXT.md → Product copy): superadmin-only bulk duplication of products from one
 * shop into another, for setting up a new merchant's menu at their request. A dedicated write
 * path, NOT the product upsert — it carries `descr_zh` (real merchant data the product form
 * cannot edit) and stamps `sort` itself, both of which `PRODUCT_FIELDS` deliberately refuses.
 *
 * The order of the three steps is the failure semantics: plan (pure, refuses bad requests with
 * nothing spent), then image OBJECTS (a storage failure aborts with nothing in the database),
 * then ONE transaction for rows + categories. Orphaned files from an aborted run are tolerated;
 * orphaned ROWS would be broken products on a live storefront, which is why the files go first.
 */
app.post('/api/admin/copy-products', requireSuperadmin, async (c) => {
  const parsed = parseProductCopy(await c.req.json().catch(() => null))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  const { sourceMerchantId, targetMerchantId, productIds } = parsed

  const { data: shops } = await admin
    .from('merchants').select('id, product_categories')
    .in('id', [sourceMerchantId, targetMerchantId])
  const source = shops?.find(s => s.id === sourceMerchantId)
  const target = shops?.find(s => s.id === targetMerchantId)
  if (!source || !target) return c.json({ error: 'merchant_not_found' }, 404)

  // The source's own render order (sort, then age), so the copy reads like the source menu.
  const { data: sourceRows, error: readErr } = await admin
    .from('products').select('*')
    .eq('merchant_id', sourceMerchantId).in('id', productIds)
    .order('sort', { ascending: true }).order('created_at', { ascending: true })
  if (readErr) return c.json({ error: 'copy_failed' }, 500)

  // Where the target menu currently ends. head:true count would not carry max(sort).
  const { data: lastRow } = await admin
    .from('products').select('sort')
    .eq('merchant_id', targetMerchantId)
    .order('sort', { ascending: false }).limit(1).maybeSingle()

  const planned = planProductCopy({
    requestedIds: productIds,
    sourceProducts: (sourceRows ?? []) as CopySourceProduct[],
    sourceCategories: menuCategoriesFromRow(source.product_categories),
    targetCategories: menuCategoriesFromRow(target.product_categories),
    targetMerchantId,
    targetMaxSort: lastRow ? lastRow.sort : null,
    newId: () => crypto.randomUUID(),
  })
  if (!planned.ok) return c.json({ error: planned.error }, 400)

  // A SOURCE object that no longer exists is skipped, not fatal: image deletes are best-effort,
  // so a row can outlive its file, and the honest copy of a photo that is already gone at the
  // source is no photo. Any other storage failure still aborts — whole or nothing.
  const missing = new Set<string>()
  for (const { from, to } of planned.plan.imageCopies) {
    const { error } = await admin.storage.from('product-images').copy(from, to)
    if (!error) continue
    // storage-js reports the missing-object case as "Object not found" (a 404 wearing various
    // statusCode types across versions), so the message is the stable thing to match.
    if (/not.?found/i.test(error.message)) {
      missing.add(to)
      continue
    }
    console.error('copy-products: image copy failed:', from, error.message)
    return c.json({ error: 'copy_failed' }, 500)
  }

  try {
    const rows = dropMissingImages(planned.plan.rows, missing)
    const copied = await applyProductCopy(targetMerchantId, { ...planned.plan, rows })
    return c.json({ ok: true, copied, skippedImages: missing.size })
  } catch (err) {
    console.error('copy-products failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'copy_failed' }, 500)
  }
})

// ── Superadmin: flag/unflag a merchant for the landing-page sample-shops carousel (#107) ──────
// Pure flag flip — no billing/status side effects, unlike comp/uncomp. GET /api/merchants/samples
// is what actually reads it.
//
// Flagging ON also asks GitHub Actions to screenshot that one storefront now. The carousel shows
// only shops that HAVE a screenshot, and capture is a weekly cron, so without this a shop flagged
// on a Tuesday stays invisible until the following Monday. The request is best-effort in the
// strongest sense: `captureQueued: false` is reported to the admin, the flag stands either way,
// and the cron remains the thing that guarantees a shot eventually exists.
app.post('/api/admin/set-merchant-sample', requireSuperadmin, async (c) => {
  const { merchantId, isSample } = await c.req.json().catch(() => ({}))
  if (!merchantId || typeof isSample !== 'boolean') {
    return c.json({ error: 'Missing merchantId or isSample' }, 400)
  }

  const { data: merchant } = await admin
    .from('merchants').select('id').eq('id', merchantId).maybeSingle()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  const { error } = await admin.from('merchants').update({ is_sample: isSample }).eq('id', merchantId)
  if (error) {
    console.error('set-merchant-sample failed:', error.message)
    return c.json({ error: 'Update failed' }, 500)
  }

  let captureQueued = false
  if (isSample) {
    captureQueued = await githubDeps
      .dispatchSampleScreenshot(env.githubToken, merchantId)
      .catch(() => false)
  }
  return c.json({ ok: true, isSample, captureQueued })
})

// ── Superadmin: re-shoot every sample shop's storefront now ───────────────────────────────────
// A storefront redesign makes every stored screenshot stale at the same moment, and no shop has
// changed — so there is no per-shop toggle to flip, and until this existed the carousel showed
// the previous design until the following Monday. Production deploys now trigger the same sweep
// on their own (the workflow's `deployment_status` trigger); this is the manual path, for a shot
// that came out wrong or a design change that shipped without a frontend deploy.
app.post('/api/admin/recapture-samples', requireSuperadmin, async (c) => {
  const captureQueued = await githubDeps
    .dispatchSampleScreenshot(env.githubToken)
    .catch(() => false)
  return c.json({ ok: true, captureQueued })
})

// ── Superadmin: comp a merchant (billing does not apply) ───────────────────────
// A comp means the shop runs with NO subscription behind it — for partners, staff, and promo
// shops. It activates the shop and writes an 'active' billing row with a far-future period end
// and no trial, so the trial/past-due banners stay silent and nothing expires it. The shop is
// decoupled from Stripe: it has no real subscription, so the webhook-driven suspension path
// never touches it, and the reconciliation sweep skips it on the `comped` flag. Revoke with
// `/api/admin/uncomp-merchant`, which clears the flag without touching status — suspension is a
// separate decision.
app.post('/api/admin/comp-merchant', requireSuperadmin, async (c) => {
  const { merchantId } = await c.req.json().catch(() => ({}))
  if (!merchantId) return c.json({ error: 'Missing merchantId' }, 400)

  const { data: merchant } = await admin
    .from('merchants').select('id').eq('id', merchantId).maybeSingle()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  // Refuse a shop that is actually paying. Comping it would leave Stripe billing a card while
  // the local row claims the shop is free — and the customer id this route clears is the only
  // pointer back to that subscription. Cancel in Stripe first, then comp.
  const { data: existingBilling } = await admin
    .from('merchant_billing')
    .select('stripe_subscription_id, status')
    .eq('merchant_id', merchantId)
    .maybeSingle()
  if (existingBilling?.stripe_subscription_id
      && LIVE_STATUSES.includes(existingBilling.status ?? '')) {
    return c.json({ error: 'has_live_subscription' }, 409)
  }

  // Activate. Service role bypasses the guard_merchant_status trigger.
  const { error: mErr } = await admin
    .from('merchants').update({ status: 'active' }).eq('id', merchantId)
  if (mErr) {
    console.error('comp-merchant merchants update failed:', mErr.message)
    return c.json({ error: 'Comp failed' }, 500)
  }

  // Mark the comp and silence the billing banners: active status, far-future period end, no
  // trial. `stripe_customer_id` is cleared — on a comped shop it points at nothing we will ever
  // call, and a stale one is exactly what sent a dead id to Stripe and answered 502.
  // `stripe_subscription_id` is deliberately KEPT: canStartTrial reads it as the one-trial-ever
  // record, and clearing it would hand a previously-subscribed shop a fresh trial.
  try {
    const farFuture = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString()
    await upsertBilling(merchantId, {
      comped: true,
      stripe_customer_id: null,
      status: 'active',
      trial_ends_at: null,
      current_period_end: farFuture,
    })
  } catch (err) {
    console.error('comp-merchant billing upsert failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Comp failed' }, 500)
  }

  return c.json({ ok: true })
})

// ── Superadmin: revoke a comp ──────────────────────────────────────────────────
// Clears the flag, so the shop has to pay like any other. Deliberately does not touch
// `merchants.status`: suspension is a separate decision, and conflating the two is what makes a
// temporary suspension silently end a comp — or a later reactivation silently hand a free shop
// back.
//
// The billing row is wound back to "no subscription" (`status` and `current_period_end` null),
// which is what leaves the shop ABLE TO PAY. Those two are comp's own writes, not Stripe's: a
// comped row has no subscription behind it, so `status: 'active'` is a claim only this endpoint
// ever made. Leaving it strands the shop twice over — `/api/checkout` refuses anything in
// LIVE_STATUSES with "this shop already has an active subscription", naming a subscription that
// does not exist, and a re-comp trips the has_live_subscription precondition whenever a dead
// `stripe_subscription_id` survived the first comp.
app.post('/api/admin/uncomp-merchant', requireSuperadmin, async (c) => {
  const { merchantId } = await c.req.json().catch(() => ({}))
  if (!merchantId) return c.json({ error: 'Missing merchantId' }, 400)

  const { data: merchant } = await admin
    .from('merchants').select('id').eq('id', merchantId).maybeSingle()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  try {
    await upsertBilling(merchantId, { comped: false, status: null, current_period_end: null })
  } catch (err) {
    console.error('uncomp-merchant billing upsert failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Un-comp failed' }, 500)
  }

  return c.json({ ok: true })
})

/**
 * The one shape a failed Stripe call takes across the billing routes.
 *
 * Left unwrapped, a Stripe rejection throws past Hono and reaches the dashboard as a bare
 * `Internal Server Error` with an empty server log — indistinguishable from a bug in our own
 * code, which is exactly why a stale `stripe_customer_id` in a local database cost a session to
 * identify. 502 rather than 500: the request was well-formed and the caller can retry; it was
 * the upstream that refused.
 *
 * Only ever reached via `isStripeError`, so "the payment provider is down" is never said about
 * one of our own exceptions.
 */
function stripeFailed(c: Context<AppEnv>, where: string, err: unknown) {
  console.error(`Stripe ${where} failed:`, err instanceof Error ? err.message : String(err))
  return c.json({ error: 'stripe_unavailable' }, 502)
}

// ── Stripe billing portal for the signed-in merchant ───────────────────────────
// Where a trialing merchant adds their card, and a past_due one updates it.
// Requires the portal to be enabled once in the Stripe Dashboard.
app.post('/api/billing/portal', requireOwnMerchant, async (c) => {
  const merchant = c.get('merchant')
  const { data: billing } = await admin
    .from('merchant_billing').select('stripe_customer_id, comped').eq('merchant_id', merchant.id).maybeSingle()
  // The bug this whole change exists for. A comped shop has no Stripe customer to open a portal
  // against; before the flag existed it had a stale one, and this route sent it to Stripe.
  if (billing?.comped) return c.json({ error: 'shop_is_comped' }, 409)
  if (!billing?.stripe_customer_id) return c.json({ error: 'No billing account yet' }, 404)
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripe_customer_id,
      // Back to the Subscription tab the merchant left from, not the dashboard root — the portal is
      // only ever opened from there, so Overview is a lost-your-place jump. The hash deep-links via
      // useDashboardSection/Subsection (`#settings/subscription`).
      return_url: `${env.frontendUrl}/merchant#settings/subscription`,
    })
    return c.json({ url: session.url })
  } catch (err) {
    // The two live ones: a `stripe_customer_id` Stripe has never heard of (seed data, or a key
    // rotated to a different account), and the portal not being enabled in the Dashboard.
    if (isStripeError(err)) return stripeFailed(c, `portal session for merchant ${merchant.id}`, err)
    throw err
  }
})

// ── Cancellation ───────────────────────────────────────────────────────────────
// The Customer Portal could carry these, and these two are deliberately ours instead, for one
// reason — they land on a period boundary. `cancel_at_period_end` is a flag, so no money moves
// and there is nothing for a payment screen to explain. What is gained is the thing the portal
// cannot give: telling a merchant, in their own dashboard and in their own language, that
// cancelling suspends their shop on a named date.
//
// Stripe remains authoritative. Each route writes the outcome back to `merchant_billing`
// immediately so the tab does not lie for the seconds before the webhook lands, but
// `customer.subscription.updated` is what confirms it.

/** The signed-in merchant's live subscription, or the response explaining why there isn't one. */
async function liveSubscription(c: Context<AppEnv>) {
  // Caller and shop are `requireOwnMerchant`'s job — every route that calls this chains it.
  const merchant = c.get('merchant')
  const { data: billing } = await admin
    .from('merchant_billing')
    .select('stripe_subscription_id, status, comped')
    .eq('merchant_id', merchant.id).maybeSingle()
  // Ahead of the gate below, which a comped row passes on both terms: comp keeps
  // stripe_subscription_id (canStartTrial's one-trial-ever record) and leaves status 'active'.
  // Without this, cancel/resume would act on an id that is dead or belongs to a real cancelled
  // subscription.
  if (billing?.comped) return { res: c.json({ error: 'shop_is_comped' }, 409) }
  // 409 rather than 404: the shop is fine, the request just does not apply to it. The
  // Subscription tab hides these buttons in that state, so this is the long-open-tab case.
  if (!billing?.stripe_subscription_id || !LIVE_STATUSES.includes(billing.status ?? '')) {
    return { res: c.json({ error: 'no_live_subscription' }, 409) }
  }
  return { merchantId: merchant.id, subscriptionId: billing.stripe_subscription_id }
}

// End the subscription when the current period runs out. The shop stays open and fully
// functional until then; `customer.subscription.deleted` is what suspends it.
app.post('/api/billing/cancel', requireOwnMerchant, async (c) => {
  const found = await liveSubscription(c)
  if ('res' in found) return found.res
  const { merchantId, subscriptionId } = found

  let sub
  try {
    sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true })
  } catch (err) {
    if (isStripeError(err)) return stripeFailed(c, `cancel for merchant ${merchantId}`, err)
    throw err
  }

  await upsertBilling(merchantId, billingFromSubscription(sub))
  return c.json({ ok: true, endsAt: billingFromSubscription(sub).current_period_end })
})

// Undo the pending cancellation — the only wind-down there is (#222).
app.post('/api/billing/resume', requireOwnMerchant, async (c) => {
  const found = await liveSubscription(c)
  if ('res' in found) return found.res
  const { merchantId, subscriptionId } = found

  let sub
  try {
    sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false })
  } catch (err) {
    if (isStripeError(err)) return stripeFailed(c, `resume for merchant ${merchantId}`, err)
    throw err
  }

  await upsertBilling(merchantId, billingFromSubscription(sub))
  return c.json({ ok: true })
})

// ── Customer sign-up — creates the account pre-confirmed ───────────────────────
// Email confirmation stays ON project-wide (it is shared with merchants, who own shops
// and Stripe billing), so a client-side signUp returns no session and strands a customer
// in their inbox holding a cart. Created here with the service role instead, pre-confirmed,
// and the client signs in normally. See src/accountSignup.ts for what that costs.
//
// RATE LIMITING — read before touching the deploy shape:
// The window below lives in this process's memory. That works only because the backend is
// a long-lived Node process (`node dist/server.js` + @hono/node-server), and it comes with
// two consequences:
//   • it resets on redeploy — harmless;
//   • it SILENTLY STOPS PROTECTING ANYTHING if the backend is ever scaled past one
//     instance, or moved to serverless. Each instance would count its own hits, and this
//     endpoint goes around Supabase's own sign-up rate limits by design. If that day comes,
//     move the counter to a shared store (or put a captcha in front).
// CORS is not the guard: /api/* is pinned to env.frontendUrl, but that only constrains
// browsers — any server can POST here. The rate limit is the control.
// Escalation, if abuse ever actually happens, is a captcha — deliberately not now, because
// a captcha widget in the checkout path costs orders.
const signupIpWindow = createSlidingWindow({ limit: 10, windowMs: 60 * 60_000, now: () => Date.now() })
const signupEmailWindow = createSlidingWindow({ limit: 3, windowMs: 60 * 60_000, now: () => Date.now() })

// The merchant door's own pair, and SEPARATE from the customer pair above on purpose. The two
// doors serve different people through the same building: a busy shop's customers signing up
// behind one carrier-grade NAT address must not be able to spend the budget a merchant needs to
// open a shop from that same address, and neither must the reverse. Same figures, because the
// argument for them has not changed — what changes is whose bucket gets emptied.
const merchantSignupIpWindow = createSlidingWindow({ limit: 10, windowMs: 60 * 60_000, now: () => Date.now() })
const merchantSignupEmailWindow = createSlidingWindow({ limit: 3, windowMs: 60 * 60_000, now: () => Date.now() })

// Resends of the address-check link, per ACCOUNT per hour. Three is a merchant who mistyped,
// fixed it, and mistyped again; anything past that is a signed-in caller using us to post mail.
const verifyResendWindow = createSlidingWindow({ limit: 3, windowMs: 60 * 60_000, now: () => Date.now() })

// quoteIpWindow and quoteMerchantWindow moved to quotaWindows.ts — order intake shares
// quoteMerchantWindow, see that module's header.

// Bounds the Places proxy by caller IP. BOTH routes draw on this one bucket.
//
// 300/hour, deliberately five times `quoteIpWindow` above, because the two endpoints are called
// nothing alike: a quote happens ONCE per address the customer selects, while suggest fires per
// burst of typing — one address entry is realistically four to eight suggests plus one detail.
// At 60 this would be about six address entries per hour per IP, and behind carrier-grade NAT or
// a mall's wifi (most Malaysian mobile traffic, and this is a Malaysian platform) dozens of
// unrelated customers share one address. They would exhaust it in minutes, and the failure is
// silent and fatal: the address box returns nothing and the customer cannot place a delivery
// order at all.
//
// Raising a REQUEST ceiling does not raise the bill proportionally, because the billable unit is
// the SESSION: a burst of keystrokes carrying one session token, ending in a details call, bills
// as one lookup. Same in-memory limiter weaknesses as everything else here, inherited knowingly.
const placesIpWindow = createSlidingWindow({ limit: 300, windowMs: 60 * 60_000, now: () => Date.now() })

// Referral-code checks from the signup form, per IP per hour. The endpoint is public and reads
// one indexed column, so this bounds enumeration rather than spend: 8 hex characters is four
// billion codes, and 60 an hour makes walking them pointless while leaving a merchant who
// retypes a code far more room than they will ever use. Same in-memory weaknesses as every
// other limiter here, inherited knowingly (#101).
const referralCheckIpWindow = createSlidingWindow({ limit: 60, windowMs: 60 * 60_000, now: () => Date.now() })

/** The caller's IP, from the proxy headers with the socket as the local-dev fallback. */
function ipOf(c: { req: { header: (n: string) => string | undefined }; env: unknown }): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  return clientIp(
    { 'x-forwarded-for': c.req.header('x-forwarded-for'), 'cf-connecting-ip': c.req.header('cf-connecting-ip') },
    incoming?.socket?.remoteAddress,
  )
}

// Does this referral code name a shop? Public and unauthenticated, because it answers the SIGNUP
// form — the caller has no account yet, and catching a typo is only useful while the field is
// still on screen. Without it a mistyped code is dropped in silence by resolveReferredByCode and
// the merchant believes a referral was recorded.
//
// The answer is a bare boolean, deliberately. A code is 8 hex characters, so returning the
// referrer's name would make this a merchant directory anyone can walk one guess at a time —
// and it stays bare now that the answer also depends on the referrer's billing state, which is
// theirs and not the caller's business. "Invalid" covers both "no such code" and "that shop
// cannot refer today", on purpose.
//
// `valid` means the code names a shop that COULD earn the reward today (canShareReferral). It is
// still not a promise: the payout is decided when the referred shop's first invoice pays
// (referralReward.ts), against the referrer's billing state at that later moment. What this
// stops is the opposite failure — a code handed out by a shop that already cannot earn, which
// validates green here and forfeits in silence months later.
app.get('/api/referrals/check', async (c) => {
  if (!referralCheckIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)
  // The same normalization the stamp uses, so a code this route calls good is one that survives
  // POST /api/merchants. A malformed code is not an error here — the form asks about it while
  // the merchant is still typing.
  const code = normalizeReferralCode(c.req.query('code'))
  if (!code) return c.json({ valid: false })
  try {
    return c.json({ valid: await referralCodeIsShareable(code) })
  } catch {
    return c.json({ error: 'Lookup failed' }, 500)
  }
})

// ── Referred shops ────────────────────────────────────────────────────────────
// Replaces the my_referred_shops SECURITY DEFINER function. That function could read
// across tenants — it had to, since a referrer's shops are not their own — and was safe
// only because it filtered on a code derived from auth.uid(), which the caller could not
// choose. The same property holds here: the code comes from the verified JWT and from
// nothing else. Do not add a code parameter to this route.
app.get('/api/referrals/shops', requireUser, async (c) => {
  const user = c.get('user')

  return c.json(await listReferredShops(user.id))
})

// The referral rewards this member has earned. Same JWT-derived scoping as /shops — the
// caller's merchant comes from the verified token, never the request.
app.get('/api/referrals/rewards', requireUser, async (c) => {
  const user = c.get('user')

  return c.json(await listEarnedRewards(user.id))
})

// The GitHub adapter, held mutable so tests can capture what would be sent without a live
// network — same pattern as notifyDeps below. Production uses the real fetch adapters.
export const githubDeps: {
  createIssue: CreateGithubIssue
  closeIssue: GithubIssueAction
  reopenIssue: GithubIssueAction
  dispatchSampleScreenshot: DispatchSampleScreenshot
} = {
  createIssue: createGithubIssue,
  closeIssue: closeGithubIssue,
  reopenIssue: reopenGithubIssue,
  dispatchSampleScreenshot,
}

// ── Merchant platform feedback (#89) ────────────────────────────────────────────
// Per-user, not per-IP: the route is authenticated, so the user id is the real actor and
// is not spoofable behind a shared NAT the way an IP is. The check runs BEFORE validation
// so a script cannot hammer the write path with malformed bodies for free; a merchant
// cannot realistically hit twenty submissions an hour by accident, and the form enforces
// both rules client-side, so a 400 arriving here is already the abnormal case.
//
// EXPORTED for tests/api/feedback.test.ts, which fills the bucket by calling `allow()`
// directly rather than by paying for twenty real HTTP round-trips against Postgres. That
// loop had no wall-clock headroom and flaked as the DB suite grew (#147); what the test is
// actually about is that THIS ROUTE consults THIS window under the caller's user id, which
// one real submission proves as well as twenty. Nothing else may import it.
export const feedbackWindow = createSlidingWindow({ limit: 20, windowMs: 60 * 60_000, now: () => Date.now() })

const FEEDBACK_IMAGE_BUCKET = 'feedback-images'
// MIME -> extension. Deliberately NOT in @bitetime/shared: the browser never derives an
// extension, so this is not a rule both sides enforce — the same reason PAYMENT_PROOF_EXT
// lives here. Its keys are the same three types FEEDBACK_IMAGE_TYPES lists, and the route
// checks membership so the lookup is total and no `undefined` can reach a storage path.
const FEEDBACK_IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/**
 * Reads the submit body ONCE, in whichever of the two spellings arrived, and normalizes to a
 * shape validateFeedback can judge. The browser always sends multipart (even with no files);
 * JSON stays accepted because it costs eight lines and is the honest no-image case that
 * tests/api/feedback.test.ts already covers.
 *
 * parseBody({ all: true }) is what returns an ARRAY for a repeated `images` field rather than
 * only the last one — without it, three attached screenshots silently become one.
 */
async function readFeedbackSubmission(c: Context): Promise<{ body: unknown; files: File[] }> {
  const contentType = c.req.header('Content-Type') ?? ''
  if (!contentType.startsWith('multipart/form-data')) {
    return { body: await c.req.json().catch(() => ({})), files: [] }
  }
  const form = await c.req.parseBody({ all: true }).catch(() => ({} as Record<string, unknown>))
  const images = form['images']
  const files = (Array.isArray(images) ? images : [images]).filter((f): f is File => f instanceof File)
  return { body: { category: form['category'], message: form['message'] }, files }
}

app.post('/api/merchants/:id/feedback', requireMerchantOwns, async (c) => {
  const user = c.get('user')
  const merchant = c.get('merchant')

  if (!feedbackWindow.allow(user.id)) {
    return c.json({ error: 'Too many feedback submissions. Please try again later.' }, 429)
  }

  const { body, files } = await readFeedbackSubmission(c)

  const parsed = validateFeedback(body)
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  // The whole selection — count and every file — judged BEFORE the insert, so a rejected
  // submission leaves nothing behind: no row, no orphan object. One shared call rather than a
  // hand-rolled loop, so this and store.ts cannot drift from each other or from the database's
  // own cardinality CHECK.
  const images = validateFeedbackImages(files.map(f => ({ type: f.type, size: f.size })))
  if (!images.ok) {
    const name = images.index === null ? null : files[images.index]?.name
    return c.json({ error: name ? `${images.error}: ${name}` : images.error }, 400)
  }
  // Redundant with the type rule above (same three types) and kept anyway: it is what makes the
  // extension lookup below total instead of producing "undefined" in a storage path.
  for (const file of files) {
    if (!FEEDBACK_IMAGE_EXT[file.type]) return c.json({ error: `Unsupported image type: ${file.name}` }, 400)
  }

  // merchant.id comes from the route the middleware already verified; user.id from the
  // JWT. Neither is ever read from the body — see tests/api/feedback.test.ts.
  const row = await insertFeedback({ merchantId: merchant.id, userId: user.id, draft: parsed.value })

  // Upload AFTER the row is committed, on purpose. The reverse order trades an orphan object
  // for an orphan row claiming images it does not have, and risks losing a message the merchant
  // typed to a storage hiccup — the exact outcome FeedbackFab's error path exists to avoid.
  const paths: string[] = []
  let imagesFailed = 0
  for (const file of files) {
    const path = `${merchant.id}/${row.id}/${crypto.randomUUID()}.${FEEDBACK_IMAGE_EXT[file.type]}`
    const { error } = await admin.storage
      .from(FEEDBACK_IMAGE_BUCKET)
      .upload(path, file, { contentType: file.type, upsert: true })
    if (error) {
      console.error(`feedback ${row.id}: screenshot upload failed:`, error.message)
      imagesFailed++
      continue
    }
    paths.push(path)
  }
  await updateFeedbackImages(row.id, paths)

  // Best-effort (github.ts). Never changes what the merchant gets back — the row below is
  // the same whether or not this succeeds. The count is what ACTUALLY LANDED, so the issue
  // never claims a screenshot that is not there.
  const issue = await githubDeps.createIssue(env.githubToken, {
    title: buildIssueTitle(parsed.value.category, merchant.name),
    body: buildIssueBody({
      message: parsed.value.message,
      shopName: merchant.name,
      shopSlug: merchant.slug,
      feedbackId: row.id,
      createdAt: row.created_at,
      imageCount: paths.length,
      adminUrl: env.frontendUrl,
    }),
    labels: ['needs-triage', categoryToLabel(parsed.value.category)],
  })
  if (issue) await updateFeedbackGithubIssue(row.id, issue)

  // `row` was selected at insert time, before updateFeedbackImages ran, so its image_paths is
  // still []. Override with what actually landed.
  return c.json({ ...row, image_paths: paths, images_failed: imagesFailed }, 201)
})

app.get('/api/admin/feedback', requireSuperadmin, async (c) => {
  const status = c.req.query('status')
  if (status !== undefined && !isFeedbackStatus(status)) {
    return c.json({ error: 'Unknown feedback status' }, 400)
  }
  return c.json(await listFeedback(status))
})

/**
 * One screenshot from one feedback row, for the superadmin inbox. Same shape as the
 * payment-proof download: the backend reads the private bucket with the service-role client
 * and streams the bytes, because the browser has no access to that bucket in either direction
 * (20260806120000 gives it no policies at all).
 *
 * The caller names an INDEX, never a path. The path comes out of the row's own image_paths
 * array, so there is no path for a caller to point somewhere else — which is the whole
 * security property of this route, not a convenience.
 *
 * Missing feedback, an out-of-range index and a non-numeric index all return the same 404:
 * a distinguishable error here would be an oracle for which feedback ids exist.
 */
app.get('/api/admin/feedback/:feedbackId/images/:index', requireSuperadmin, async (c) => {
  const { data: row, error } = await admin
    .from('merchant_feedback')
    .select('image_paths')
    .eq('id', c.req.param('feedbackId'))
    .maybeSingle()
  if (error) return c.json({ error: 'lookup_failed' }, 500)

  const paths = (row?.image_paths ?? []) as string[]
  const index = Number(c.req.param('index'))
  if (!Number.isInteger(index) || index < 0 || index >= paths.length) {
    return c.json({ error: 'not_found' }, 404)
  }

  return streamPrivateObject(FEEDBACK_IMAGE_BUCKET, paths[index])
})

app.patch('/api/admin/feedback/:feedbackId', requireSuperadmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { status?: unknown }
  if (!isFeedbackStatus(body.status)) return c.json({ error: 'Unknown feedback status' }, 400)

  const row = await updateFeedbackStatus(c.req.param('feedbackId'), body.status)
  if (!row) return c.json({ error: 'Feedback not found' }, 404)

  // Best-effort keep-in-sync (github.ts). The dashboard's status is authoritative either way.
  if (row.github_issue_number) {
    const action = body.status === 'resolved' ? githubDeps.closeIssue : githubDeps.reopenIssue
    await action(env.githubToken, row.github_issue_number)
  }

  return c.json(row)
})

// Same pattern as githubDeps: held mutable so tests can capture what would be sent to GitHub
// and Claude without a live network call. Production uses the real fetch/SDK adapters.
export const releaseDeps: {
  listReleases: ListGithubReleases
  releaseByTag: GetGithubReleaseByTag
  humanize: HumanizeRelease
} = {
  listReleases: listGithubReleases,
  releaseByTag: getGithubReleaseByTag,
  humanize: humanizeRelease,
}

// ── Release notes (#163) ────────────────────────────────────────────────────
// Superadmin-triggered pull, not a live fetch or a cron sweep — pulling humanizes via Claude and
// stores drafts; a release only reaches merchants once explicitly published. See
// docs/superpowers/specs/2026-08-05-github-release-notes-design.md.

// Shared by /pull and /regenerate: best-effort, like every other call through releaseDeps.humanize
// — a missing key or a Claude outage is recorded as humanize_error, never a failed request.
async function humanizeAndStore(row: { id: string; tag: string; name: string; raw_body: string }) {
  const humanized = await releaseDeps.humanize(env.anthropicApiKey, {
    tag: row.tag,
    name: row.name,
    body: row.raw_body,
  })
  if (humanized) await updateReleaseHumanization(row.id, humanized)
  else await updateReleaseHumanization(row.id, { error: 'Claude could not summarize this release' })
}

// The humanization the pull route deliberately does NOT await, exposed so tests can. A test
// cannot assert on a summary that is still being written, and polling for one in a suite is
// how you get a flake. Production never reads this — it is the seam, in the same spirit as
// releaseDeps: the route's contract is "the drafts are stored", and this is the handle on
// the rest. Reassigned per pull, so awaiting it awaits the most recent pull's work.
export let releaseHumanization: Promise<unknown> = Promise.resolve()

// The pull itself, shared by the two doors onto it: the superadmin button in /admin and the
// release workflow's own call the moment it cuts a tag. One function, so an automatic pull and
// a hand pull cannot drift apart.
//
// Returns the number of NEW releases stored. Throws only what the DB throws; a GitHub that
// cannot be reached is reported as null, which each caller turns into its own status.
async function pullReleases(tag?: string): Promise<number | null> {
  // The list is served from a 60-second GitHub cache, and the release workflow calls about two
  // seconds after cutting its tag — so the list it reads regularly predates that release and the
  // pull stores nothing while answering 200. A named tag is read by tag instead (see
  // getGithubReleaseByTag), which is a key nothing has asked for before.
  //
  // The list is STILL read alongside it, and that is not belt-and-braces: it is the recovery for
  // every release the old behaviour missed. Those are old enough that no cache hides them, the
  // two results are merged by tag, and a stale list can only ever fail to add — never subtract.
  // A named tag that cannot be read is null even when the list came back, because that tag is
  // what the caller asked about and what it retries for.
  const named = tag ? await releaseDeps.releaseByTag(env.githubToken, tag) : null
  if (tag && named === null) return null
  const listed = await releaseDeps.listReleases(env.githubToken, 10)
  if (listed === null && named === null) return null

  const byTag = new Map((listed ?? []).map((r) => [r.tag_name, r]))
  if (named) byTag.set(named.tag_name, named)
  const fetched = [...byTag.values()]

  const existingTags = new Set(await listReleaseTags())
  const toPull = fetched.filter((r) => !existingTags.has(r.tag_name))

  // Store every draft first, and answer the moment they are stored. The rewrite is one Claude
  // call per release and the superadmin is sat on a button: awaiting it here made a first pull
  // of ten releases hold the request open for the slowest of ten round trips, which reads as a
  // hung page. The row IS the receipt — it carries the tag, the raw body and the GitHub URL,
  // and `title`/`summary` fill in behind it.
  const rows = await Promise.all(
    toPull.map((release) => insertDraftRelease({
      tag: release.tag_name,
      name: release.name,
      htmlUrl: release.html_url,
      rawBody: release.body,
      publishedAt: release.published_at,
    })),
  )

  // Fired, not awaited. All at once rather than one after another: the calls are independent
  // (each release rewrites from its own raw body, and every write is a single row keyed by its
  // own id). humanizeAndStore never rejects — it records a humanize_error instead — so the
  // catch is a backstop for the unforeseen, there so a rejection can never take down the
  // process as an unhandled rejection.
  releaseHumanization = Promise.all(rows.map((row) => humanizeAndStore(row)))
    .catch((e) => console.error('Release humanization batch failed:', e instanceof Error ? e.message : String(e)))

  // A crash or a redeploy between here and the last write leaves those rows with no title and
  // no humanize_error — indistinguishable from still-in-progress. That is what the per-row
  // Regenerate action is for; the dashboard stops waiting after a bounded spell and leaves
  // the row sat there rather than pretending the work is still coming.
  return rows.length
}

app.post('/api/admin/releases/pull', requireSuperadmin, async (c) => {
  const pulled = await pullReleases()
  if (pulled === null) return c.json({ error: 'Could not reach GitHub' }, 502)
  return c.json({ pulled })
})

app.get('/api/admin/releases', requireSuperadmin, async (c) => {
  return c.json(await listAllReleases())
})

app.patch('/api/admin/releases/:id', requireSuperadmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { status?: unknown }
  if (body.status !== 'draft' && body.status !== 'published') {
    return c.json({ error: 'Unknown release status' }, 400)
  }
  const row = await updateReleaseStatus(c.req.param('id'), body.status)
  if (!row) return c.json({ error: 'Release not found' }, 404)
  return c.json(row)
})

app.post('/api/admin/releases/:id/regenerate', requireSuperadmin, async (c) => {
  const row = await getReleaseById(c.req.param('id'))
  if (!row) return c.json({ error: 'Release not found' }, 404)

  await humanizeAndStore(row)

  return c.json(await getReleaseById(row.id))
})

app.get('/api/releases', async (c) => {
  return c.json(await listPublishedReleases(10))
})

app.get('/api/releases/:tag', async (c) => {
  const row = await getPublishedReleaseByTag(c.req.param('tag'))
  if (!row) return c.json({ error: 'Release not found' }, 404)
  return c.json(row)
})

// Not user-authenticated — called by .github/workflows/release.yml the moment it cuts a tag,
// gated by a shared secret header instead. `requireSuperadmin` cannot serve that caller: it
// wants a GoTrue access token, and an access token expires, so there is nothing to put in a
// repository secret that would still work next month.
//
// Fails CLOSED (503) when the secret is unset, matching the other internal routes. What that
// costs is small and worth stating: the tag and the GitHub release still exist, so a
// superadmin pulls them by hand from /admin exactly as they did before this was automated.
//
// This lands DRAFTS. Nothing here publishes, and nothing here should: the publish gate is a
// human reading what Claude wrote about the release before every merchant does.
app.post('/api/internal/releases-pull', async (c) => {
  if (!env.releasePullSecret) return c.json({ error: 'Release pull disabled' }, 503)
  const provided = c.req.header('x-sweep-secret') || ''
  if (!safeEqualSecret(provided, env.releasePullSecret)) return c.json({ error: 'Forbidden' }, 403)

  // The workflow names the tag it just cut. A 502 for a tag GitHub does not show yet is the
  // whole point: the caller retries across the cache window instead of reporting success on a
  // pull that stored nothing. A body without a tag keeps the old behaviour — read the list.
  const body = (await c.req.json().catch(() => ({}))) as { tag?: unknown }
  const tag = typeof body.tag === 'string' && body.tag.trim() ? body.tag.trim() : undefined

  const pulled = await pullReleases(tag)
  if (pulled === null) return c.json({ error: 'Could not reach GitHub' }, 502)
  return c.json({ pulled })
})

// ── Trial feedback (#155) ───────────────────────────────────────────────────────
// One-time, platform-initiated survey — see CONTEXT.md → Trial feedback. requireOwnMerchant
// scopes every route to the caller's own shop; there is no :id to name a different one.

app.get('/api/trial-feedback', requireOwnMerchant, async (c) => {
  const merchant = c.get('merchant')
  return c.json(await getOwnTrialFeedback(merchant.id))
})

app.post('/api/trial-feedback/respond', requireOwnMerchant, async (c) => {
  const merchant = c.get('merchant')
  const parsed = validateTrialFeedback(await c.req.json().catch(() => ({})))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)

  const result = await respondTrialFeedback(merchant.id, parsed.value)
  if (!result.ok) return c.json({ error: result.reason }, result.reason === 'not_found' ? 404 : 409)
  return c.json(result.row)
})

app.post('/api/trial-feedback/skip', requireOwnMerchant, async (c) => {
  const merchant = c.get('merchant')
  const result = await skipTrialFeedback(merchant.id)
  if (!result.ok) return c.json({ error: result.reason }, result.reason === 'not_found' ? 404 : 409)
  return c.json(result.row)
})

app.get('/api/admin/trial-feedback', requireSuperadmin, async (c) => {
  return c.json(await listTrialFeedbackForAdmin())
})

// Constant-time compare, guarding the length check first (a mismatched length would
// otherwise throw inside timingSafeEqual rather than answer false).
function safeEqualSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Not user-authenticated — called by a GitHub Actions schedule (see
// .github/workflows/trial-feedback-sweep.yml), gated by a shared secret header instead.
// Fails CLOSED (503) when the secret is unset, matching the house rule that an optional,
// unset credential means a refusal, never an open door.
app.post('/api/internal/trial-feedback-sweep', async (c) => {
  if (!env.trialFeedbackSweepSecret) return c.json({ error: 'Sweep disabled' }, 503)
  const provided = c.req.header('x-sweep-secret') || ''
  if (!safeEqualSecret(provided, env.trialFeedbackSweepSecret)) return c.json({ error: 'Forbidden' }, 403)

  const due = await findDueTrials(new Date())
  let sentCount = 0
  for (const trial of due) {
    const claimed = await claimSend(trial.merchantId)
    if (!claimed) continue // a concurrent run already has it

    const { data: ownerUser } = await admin.auth.admin.getUserById(trial.ownerId)
    const ownerEmail = ownerUser?.user?.email
    if (!ownerEmail) {
      console.error(`trial-feedback sweep: no email for merchant ${trial.merchantId}, releasing claim`)
      await releaseSend(trial.merchantId)
      continue
    }

    try {
      const { subject, text } = buildTrialFeedbackEmail({
        shopName: trial.shopName,
        dashboardUrl: `${env.frontendUrl}/merchant`,
      })
      await trialFeedbackDeps.email(ownerEmail, subject, { text })
      sentCount++
    } catch (err) {
      console.error(
        `trial-feedback sweep: send failed for merchant ${trial.merchantId}, releasing claim:`,
        err instanceof Error ? err.message : String(err),
      )
      await releaseSend(trial.merchantId)
    }
  }

  return c.json({ due: due.length, sent: sentCount })
})

// Not user-authenticated — called by a GitHub Actions schedule (see
// .github/workflows/billing-sweep.yml), gated by a shared secret header instead. Fails CLOSED
// (503) when the secret is unset, matching trial-feedback-sweep's house rule.
//
// This is the backstop for a lost `customer.subscription.deleted`: see billingSweep.ts for why
// push-only subscription state was not survivable. Hourly rather than daily, because the thing it
// repairs is a shop that should be shut and is not.
app.post('/api/internal/billing-sweep', async (c) => {
  if (!env.billingSweepSecret) return c.json({ error: 'Sweep disabled' }, 503)
  const provided = c.req.header('x-sweep-secret') || ''
  if (!safeEqualSecret(provided, env.billingSweepSecret)) return c.json({ error: 'Forbidden' }, 403)

  return c.json(await runBillingSweep(new Date()))
})

const SAMPLE_SCREENSHOT_BUCKET = 'sample-shop-screenshots'
const MAX_SAMPLE_SCREENSHOT_BYTES = 3 * 1024 * 1024 // 3 MiB — same ceiling as the migration's file_size_limit

// Not user-authenticated — called by a GitHub Actions schedule (see
// .github/workflows/sample-shop-screenshot-sweep.yml), gated by a shared secret header instead.
// Fails CLOSED (503) when the secret is unset, matching trial-feedback-sweep's house rule.
app.post('/api/internal/sample-shop-screenshot/:merchantId', async (c) => {
  if (!env.sampleShopScreenshotSweepSecret) return c.json({ error: 'Sweep disabled' }, 503)
  const provided = c.req.header('x-sweep-secret') || ''
  if (!safeEqualSecret(provided, env.sampleShopScreenshotSweepSecret)) return c.json({ error: 'Forbidden' }, 403)

  const merchantId = c.req.param('merchantId')
  if (c.req.header('Content-Type') !== 'image/png') return c.json({ error: 'unsupported_type' }, 400)

  const buffer = await c.req.arrayBuffer()
  if (buffer.byteLength === 0) return c.json({ error: 'invalid_body' }, 400)
  if (buffer.byteLength > MAX_SAMPLE_SCREENSHOT_BYTES) return c.json({ error: 'too_large' }, 400)

  const { data: merchant } = await admin.from('merchants').select('id').eq('id', merchantId).maybeSingle()
  if (!merchant) return c.json({ error: 'Merchant not found' }, 404)

  // `{merchant}/{ms}.png`, NOT a fixed `{merchant}.png` overwritten in place. The bucket is
  // public and Storage serves these with a max-age, so a stable path meant a recaptured
  // screenshot could not reach a browser that already held the previous one — the carousel went
  // on showing a storefront design that had been replaced weeks earlier, and re-shooting on every
  // deploy did nothing about it. A new name per capture is a new URL, which is the only thing a
  // cache respects. It also lets the bytes be cached hard rather than revalidated hourly.
  const { data: previous } = await admin
    .from('merchants').select('sample_screenshot_path').eq('id', merchantId).maybeSingle()
  const path = `${merchantId}/${Date.now()}.png`
  const { error } = await admin.storage
    .from(SAMPLE_SCREENSHOT_BUCKET)
    .upload(path, buffer, { contentType: 'image/png', cacheControl: '31536000', upsert: true })
  if (error) {
    console.error('Sample shot upload failed:', error.message)
    return c.json({ error: 'upload_failed' }, 500)
  }

  await admin.from('merchants').update({ sample_screenshot_path: path }).eq('id', merchantId)

  // Only AFTER the row points at the new file: a delete that ran first would leave the carousel
  // with a dead URL if the update failed. Weekly captures otherwise accumulate one PNG per shop
  // per week for ever. Best-effort — an orphan costs storage, never correctness.
  const stale = previous?.sample_screenshot_path
  if (stale && stale !== path) {
    const { error: rmErr } = await admin.storage.from(SAMPLE_SCREENSHOT_BUCKET).remove([stale])
    if (rmErr) console.error('Stale sample shot delete failed:', rmErr.message)
  }
  return c.json({ ok: true })
})

app.post('/api/customer/signup', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}))
  // Anything else the body carries — a role, a merchant_id — is ignored: only email and
  // password are read, createUser mints a plain auth user, and the profile row below pins
  // app_role itself. So this endpoint cannot manufacture a merchant or a superadmin.
  // @hono/node-server hangs the raw Node request off `c.env`, but types it as {} — the
  // socket address is the fallback when no proxy header is present (i.e. local dev).
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  const ip = clientIp(
    { 'x-forwarded-for': c.req.header('x-forwarded-for'), 'cf-connecting-ip': c.req.header('cf-connecting-ip') },
    incoming?.socket?.remoteAddress,
  )

  const result = await signUpAccount(
    {
      allow: (kind, value) => (kind === 'ip' ? signupIpWindow : signupEmailWindow).allow(value),
      logError: (message) => console.error(message),
      createUser: async ({ email, password }) => {
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true, // pre-confirmed — regressing this reintroduces the mid-checkout dead end
        })
        if (error || !data?.user) {
          if (isDuplicateEmailError(error)) return { ok: false, reason: 'duplicate_email' }
          console.error('Customer createUser failed:', error?.message ?? 'no user returned')
          return { ok: false, reason: 'error' }
        }
        return { ok: true, userId: data.user.id }
      },
      writeProfile: async ({ userId, email }) => {
        // Mirrors the client's ensureGlobalProfile: the global profile is the row with a null
        // merchant_id, and the only unique index on user_id alone is partial, so upsert can't
        // target it — select, then insert if absent. Idempotent by design; the client repeats
        // this on SIGNED_IN as a safety net, and that repeat is also what fills referral_code
        // (derived client-side from the uid).
        //
        // app_role is written explicitly rather than left to the column default: this insert
        // runs as service_role, which guard_profile_privileges deliberately exempts
        // (20260627120300_guard_profile_privileges.sql), so the trigger that would otherwise
        // force 'customer' never fires here. Naming it keeps a future extra field from
        // silently minting a superadmin.
        const { data: existing } = await admin
          .from('profiles').select('id').eq('user_id', userId).is('merchant_id', null).maybeSingle()
        if (existing) return
        const { error } = await admin.from('profiles').insert({
          user_id: userId,
          name: email.split('@')[0],
          email,
          email_confirmed: true,
          app_role: 'customer',
          created_at: new Date().toISOString(),
        })
        if (error) throw new Error(error.message)
      },
    },
    { email, password, ip },
  )

  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json({ ok: true })
})

// The address check that follows a merchant signup, and the one thing in this file that is
// allowed to do nothing at all.
//
// `EMAIL_VERIFY_SECRET` unset means the feature is OFF: no mail, and the dashboard shows no
// banner because nothing ever set the column. That is the whole failure mode, and it is the
// correct one — signup itself must never depend on this. A merchant is already looking at their
// dashboard by the time this runs.
//
// Best-effort in every direction: a Resend outage, a bad address, a thrown adapter. None of them
// may reach the caller, because the account and the shop both exist by then and there is nothing
// useful to tell them.
export const emailVerifyDeps: { email: typeof resendSend } = { email: resendSend }

//
// `origin` is the BACKEND's own, not the frontend's: the link is a server route that flips the
// column and then redirects. Routing it through the app first would mean shipping the token to a
// page and having that page post it back. It is taken from the REQUEST rather than from a new
// environment variable, because the request already knows the answer and a variable is one more
// thing that can be set wrong — set wrong, it would mint links to a host nobody can reach, and
// nothing would notice until a merchant said the button did nothing.
async function sendEmailVerification(userId: string, email: string, shopName: string, origin: string): Promise<void> {
  if (!env.emailVerifySecret) return
  try {
    const token = makeEmailVerifyToken({ userId, email }, env.emailVerifySecret, Date.now())
    const verifyUrl = `${origin}/api/merchant/verify-email?token=${encodeURIComponent(token)}`
    const { subject, text } = buildEmailVerifyMail({ shopName, verifyUrl })
    await emailVerifyDeps.email(email, subject, { text })
  } catch (err) {
    console.error(`Verification mail not sent for ${userId}:`, err instanceof Error ? err.message : String(err))
  }
}

// The merchant door. Same policy as the customer one above, different adapters — see
// accountSignup.ts for why one policy serves both.
//
// It exists because merchant signup used to be a client-side `auth.signUp`, and with email
// confirmation on project-wide that returns no session: the sign-in the browser makes next
// failed, `createMerchant` never ran, and the merchant was told to go and confirm before the
// platform would build anything. The shop details survived that round trip (they ride along in
// `user_metadata`, and FinishSignupScreen still reads them for accounts parked that way), but
// the MERCHANT largely did not — most arrive from an ad inside a webview, where leaving for the
// mail app is leaving for good. Created pre-confirmed here, the whole signup finishes in one
// submit.
app.post('/api/merchant/signup', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { email, password, name, shop } = (body ?? {}) as Record<string, unknown>

  // The shop is parsed BEFORE the account is created, and a bad one refuses the whole request.
  // The alternative is an auth user with no shop and no way to reach the form that would make
  // one — the exact orphan this endpoint exists to stop creating.
  const parsed = pendingShopFromBody(shop)
  if (!parsed) return c.json({ error: 'invalid_shop' }, 400)

  // Same as the customer door: @hono/node-server hangs the raw Node request off `c.env` but
  // types it as {}, and the socket address is the fallback when no proxy header is present.
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  const ip = clientIp(
    { 'x-forwarded-for': c.req.header('x-forwarded-for'), 'cf-connecting-ip': c.req.header('cf-connecting-ip') },
    incoming?.socket?.remoteAddress,
  )

  // The display name for the profile row. Falls back to the shop's name rather than to the
  // email's local part: a merchant told us what to call their business one field earlier.
  const displayName = typeof name === 'string' && name.trim() ? name.trim() : parsed.name

  const result = await signUpAccount(
    {
      allow: (kind, value) => (kind === 'ip' ? merchantSignupIpWindow : merchantSignupEmailWindow).allow(value),
      logError: (message) => console.error(message),
      createUser: async ({ email, password }) => {
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true, // pre-confirmed — regressing this reintroduces the inbox dead end
          // The shop's answers, in the ONE spelling @bitetime/shared defines. Not load-bearing
          // for this request, which hands the browser a working session and lets it call
          // POST /api/merchants directly — it is the fallback that lets a shop still be built
          // if the browser dies between the two calls.
          user_metadata: { name: displayName, ...pendingShopMetadata(parsed) },
        })
        if (error || !data?.user) {
          if (isDuplicateEmailError(error)) return { ok: false, reason: 'duplicate_email' }
          console.error('Merchant createUser failed:', error?.message ?? 'no user returned')
          return { ok: false, reason: 'error' }
        }
        return { ok: true, userId: data.user.id }
      },
      writeProfile: async ({ userId, email }) => {
        // Mirrors the customer door's write, and `app_role` is 'customer' here too — that is
        // not a mistake and must not be "fixed". A merchant is someone who OWNS A MERCHANTS
        // ROW (SessionContext derives the role from exactly that), so writing 'merchant' here
        // would hand out the role before any shop exists, on a request whose body a stranger
        // controls. The shop is created afterwards, by POST /api/merchants, under its own rules.
        const { data: existing } = await admin
          .from('profiles').select('id').eq('user_id', userId).is('merchant_id', null).maybeSingle()
        if (existing) return
        const { error } = await admin.from('profiles').insert({
          user_id: userId,
          name: displayName,
          email,
          email_confirmed: true,
          app_role: 'customer',
          created_at: new Date().toISOString(),
        })
        if (error) throw new Error(error.message)
      },
    },
    { email, password, ip },
  )

  if (!result.ok) return c.json({ error: result.error }, result.status)
  // AWAITED, but incapable of failing the request — see sendEmailVerification. Awaited rather
  // than floated so a serverless runtime cannot freeze the process with the send in flight.
  await sendEmailVerification(result.userId, String(email).trim().toLowerCase(), parsed.name, new URL(c.req.url).origin)
  return c.json({ ok: true })
})

// The other end of that link. NOT behind requireUser: it is clicked from a mail app, which is
// routinely a different device from the one that signed up, and demanding a session there would
// refuse exactly the merchant this exists to reach.
//
// It answers with a REDIRECT rather than JSON, because a human is looking at it. /merchant/login
// is the landing spot for both outcomes: RedirectSignedInMerchant bounces an already-signed-in
// merchant straight to their dashboard, where the banner is now gone — which is the confirmation
// — and a signed-out one reads the notice above the login form.
app.get('/api/merchant/verify-email', async (c) => {
  const land = (ok: boolean) => c.redirect(`${env.frontendUrl}/merchant/login?email_verified=${ok ? '1' : '0'}`, 302)
  if (!env.emailVerifySecret) return land(false)

  const read = readEmailVerifyToken(c.req.query('token'), env.emailVerifySecret, Date.now())
  if (!read.ok) return land(false)

  // The address is re-read from the account rather than trusted from the token. A merchant who
  // corrected a typo has a NEW address, and a link minted for the old one must not mark the new
  // one proved — which is the one case this whole feature exists for.
  const { data, error } = await admin.auth.admin.getUserById(read.claims.userId)
  if (error || !data?.user) return land(false)
  if ((data.user.email ?? '').toLowerCase() !== read.claims.email.toLowerCase()) return land(false)

  const { error: writeErr } = await admin
    .from('profiles')
    .update({ email_verified_at: new Date().toISOString() })
    .eq('user_id', read.claims.userId)
    .is('merchant_id', null)
  if (writeErr) {
    console.error('Marking email verified failed:', writeErr.message)
    return land(false)
  }
  return land(true)
})

// What the dashboard banner asks before it decides to exist.
//
// `configured` is here because the alternative is a banner that cannot tell "we are waiting for
// you to click" from "this platform never sends that mail". With EMAIL_VERIFY_SECRET unset no
// link is ever minted, so every merchant's column stays null for ever — and a banner reading the
// column alone would nag all of them, offering a button that can only answer 503.
//
// `verified` rather than the raw timestamp: the banner asks a yes/no question, and a date it
// does not render is a date it should not receive.
app.get('/api/me/verify-email', requireUser, async (c) => {
  const user = c.get('user')
  const { data } = await admin
    .from('profiles').select('email_verified_at').eq('user_id', user.id).is('merchant_id', null).maybeSingle()
  return c.json({
    configured: !!env.emailVerifySecret,
    verified: !!data?.email_verified_at,
    email: user.email ?? '',
  })
})

// Another copy of the link, for the merchant whose first one expired or never arrived — which is
// the typo case: they change the address in their account, then ask for this.
app.post('/api/me/verify-email/resend', requireUser, async (c) => {
  const user = c.get('user')
  if (!env.emailVerifySecret) return c.json({ error: 'not_configured' }, 503)
  const email = (user.email ?? '').trim().toLowerCase()
  if (!email) return c.json({ error: 'no_email' }, 400)

  // Keyed by the ACCOUNT, not by IP: the caller is authenticated, so there is a better key than
  // an address shared by everyone behind one NAT. It bounds mail sent in someone's name.
  if (!verifyResendWindow.allow(user.id)) return c.json({ error: 'rate_limited' }, 429)

  const { data: profile } = await admin
    .from('profiles').select('email_verified_at').eq('user_id', user.id).is('merchant_id', null).maybeSingle()
  // Already proved. Answered as success rather than as an error: the merchant asked for their
  // address to be confirmed and it is, so there is nothing to fix and nothing to send.
  if (profile?.email_verified_at) return c.json({ ok: true, alreadyVerified: true })

  const { data: shop } = await admin
    .from('merchants').select('name').eq('owner_id', user.id).limit(1).maybeSingle()
  await sendEmailVerification(user.id, email, shop?.name ?? 'your shop', new URL(c.req.url).origin)
  return c.json({ ok: true, alreadyVerified: false })
})

// ── Order intake — counter, voucher, PRICE and order in ONE transaction ───────
// The JWT is OPTIONAL: guest checkout is a first-class path and must keep working.
//
// The body carries a cart and the total the customer saw. It carries NO prices: every number
// on the order is derived from Postgres inside placeOrder. It used to carry `total`, which
// meant any client could POST total: 0 and have the order commit at zero.
//
// Attribution comes from the token and from nowhere else. `user_id` is never read from the
// body — see placeOrder's contract for why that is a security property rather than a tidiness
// one.
app.post('/api/orders', async (c) => {
  const bodyJson = await c.req.json().catch(() => null)
  if (!bodyJson || typeof bodyJson !== 'object') return c.json({ error: 'invalid_body' }, 400)

  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '')
  // No token is a guest, not a rejection. A token that is present but bad is also a guest:
  // the alternative is a checkout that dies on an expired session the customer cannot see.
  const user = token ? await getUserFromToken(token) : null

  const b = bodyJson as Record<string, unknown>

  // A cart is ids → positive whole quantities, within the caps — `isCart` from @bitetime/shared
  // is the rule, and it is shared for the same reason the pricing is: the storefront stops the
  // customer AT those caps, so the UI cannot build a cart this door then refuses. A local copy
  // of the numbers here is a copy that can drift, and a drifted cap is a dead checkout — the
  // customer sees `invalid_body` with nothing to do about it.
  const quotedTotal = typeof b.quotedTotal === 'number' && Number.isFinite(b.quotedTotal)
    ? b.quotedTotal
    : null

  // An ALLOWLIST, not a string check: `mode` SELECTS THE SHIPPING FEE. Any unrecognised value
  // prices shipping at 0, so a free string is a client-chosen value that zeroes a fee — the same
  // hole as a client-supplied `total`, and `mode: 'sameday'` walked straight through it with an
  // address attached.
  //
  // Whether the SHOP offers the method it names is `placeOrder`'s call, not HTTP's — the same
  // split as the delivery region, allowlisted for shape here and refused there.
  const mode = b.mode === 'pickup' || b.mode === 'delivery' || b.mode === 'express' ? b.mode : null

  // A string or nothing. The SHAPE is checked here; whether the shop is actually taking that
  // date is `placeOrder`'s call, because the window is the shop's rule and not HTTP's — the
  // same split as `mode` (allowlisted here) versus the delivery region (refused there).
  const fulfilDate = typeof b.fulfilDate === 'string' ? b.fulfilDate : null

  if (
    typeof b.merchantId !== 'string' || !b.merchantId ||
    typeof b.customerName !== 'string' ||
    typeof b.customerWa !== 'string' ||
    // A number with no digits in it is not a number. The submit gate has always required one
    // and this door only checked the TYPE, so `customerWa: ''` placed a real order — a rule
    // the form enforced and the door did not. It matters more since #143: the phone is what
    // identifies a shop customer, so an order with no usable number belongs to nobody and
    // shows up only as an unattributed count. Refuse it where it is cheap to refuse.
    phoneKey(b.customerWa) === null ||
    mode === null ||
    !isCart(b.cart) ||
    quotedTotal === null
  ) {
    return c.json({ error: 'invalid_body' }, 400)
  }

  try {
    const result = await placeOrder({
      merchantId: b.merchantId,
      userId: user?.id ?? null,
      // The voucher's one-per-customer key. From the token, exactly like `userId`, and for
      // exactly the same reason: a body-supplied key is one the customer can simply change.
      userEmail: user?.email ?? null,
      customerName: b.customerName,
      customerWa: b.customerWa,
      mode,
      address: b.address ?? null,
      cart: b.cart as CartLine[],
      quotedTotal,
      voucherCode: typeof b.voucherCode === 'string' ? b.voucherCode : null,
      fulfilDate,
      // Lifted off the ADDRESS, not a sibling body field: it is a property of where the parcel
      // goes, and keeping the two together is what stops an address and a place id from
      // disagreeing. The distance itself is never read from the body — see placeOrder.
      destinationPlaceId: typeof (b.address as Record<string, unknown> | null)?.place_id === 'string'
        ? ((b.address as Record<string, unknown>).place_id as string)
        : null,
      // For the miss-path spend bound only (Finding 2, fix wave 2) — see PlaceOrderInput.
      callerIp: ipOf(c),
    })
    return c.json(result)
  } catch (err) {
    // A refusal the customer can act on — a closed shop, a spent voucher, a price that moved —
    // carries its code so the storefront can say which, and can offer the right retry. Anything
    // else is a bug, and must not be dressed up as a domain error the customer can "fix".
    if (err instanceof OrderError) {
      // `price_changed` carries the server's own clock alongside the refusal. This is what
      // actually closes the recovery loop (see /api/time above and serverClock.ts): a browser
      // whose sync fetch is persistently unreachable can still recover here, because the SAME
      // response that refuses the order also timestamps itself — no second endpoint to fail.
      // Scoped to this one code (not every OrderError) so the exact-body assertions the other
      // refusals already have in tests/api stay exact.
      const body: Record<string, unknown> = { error: err.code }
      if (err.code === 'price_changed') body.now = new Date().toISOString()
      // The status is a property of the code, and it lives with the code (`REFUSAL_STATUS` is a
      // TOTAL Record, so a new refusal cannot reach here without someone deciding its status).
      return c.json(body, REFUSAL_STATUS[err.code])
    }
    console.error('Order intake failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'order_failed' }, 500)
  }
})

// ── Payment proof — the customer's own screenshot of a completed transfer ─────────────────────
// Unauthenticated, exactly like POST /api/orders itself: guest checkout has no token to scope an
// RLS write against, and an order id is not a secret a client-side policy could gate on either —
// so this goes through the service-role client, the same shape order intake already uses. See
// docs/superpowers/specs/2026-08-04-payment-proof-upload-design.md. The bucket, its limits and
// the body check live next to streamPrivateObject, shared with the merchant's own upload door.

app.post('/api/orders/:orderId/payment-proof', async (c) => {
  const orderId = c.req.param('orderId')
  const upload = await readProofUpload(c)
  if (!upload.ok) return upload.response
  const { buffer, contentType, ext } = upload

  let merchantId: string | null
  try {
    merchantId = await orderMerchantId(orderId)
  } catch (err) {
    console.error('Payment proof lookup failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'lookup_failed' }, 500)
  }
  if (!merchantId) return c.json({ error: 'not_found' }, 404)

  const path = `${merchantId}/${orderId}.${ext}`
  const { error } = await admin.storage
    .from(PAYMENT_PROOF_BUCKET)
    .upload(path, buffer, { contentType, upsert: true })
  if (error) {
    console.error('Payment proof upload failed:', error.message)
    return c.json({ error: 'upload_failed' }, 500)
  }

  // Returns the two fields the write moved — the path, and a status that may have left
  // pending_payment. Order history patches its own row from them, so a customer uploading from
  // there sees the timeline move without a reload. The merchant twin returns the same shape
  // PLUS the order events it recorded; the customer does not see the log, so they are dropped
  // here rather than handed to a browser that has no use for them.
  const row = await setOrderPaymentProof(orderId, path)
  if (!row) return c.json({ error: 'not_found' }, 404)
  const { events: _events, ...saved } = row
  return c.json({ ok: true, ...saved })
})

// The two outbound adapters, held in a mutable object so tests can capture what
// would be sent without a live network. Production uses the real fetch adapters.
export const notifyDeps: { telegram: typeof telegramSend; email: typeof resendSend } = {
  telegram: telegramSend,
  email: resendSend,
}

// Same seam as notifyDeps/githubDeps: production sends real email, tests capture what would
// have been sent.
export const trialFeedbackDeps: { email: typeof resendSend } = { email: resendSend }

// ── Order notification — fans out to three recipients ──────────────────────────
// The customer is anonymous; abuse is bounded by requiring a real order and by the
// one-shot stamp each email arm claims. One post-commit event produces three
// independent, best-effort notices: the merchant's Telegram, the signed-in
// customer's confirmation email, and the shop owner's new-order email. None blocks
// or suppresses the others, and none touches the already-committed order.
//
// The three are NOT interchangeable, and the differences are deliberate:
//   * Telegram needs a configured token and is undeduplicated — a repeat ping is merchant noise.
//   * The customer receipt is signed-in-only (a guest has no account, so no
//     recipient) and one-shot.
//   * The merchant email always sends and is one-shot. It exists because a
//     basic shop, having no Telegram, otherwise learned of an order by refreshing.
//
// `lang` selects the CUSTOMER email's presentation only (never identity or money),
// so a body-supplied value is acceptable; absent/invalid ⇒ English in the builder.
// It never reaches the merchant arm, whose surface is English by rule. No recipient
// is ever taken from the body — each is read from the order or the shop.
app.post('/api/notify/order', async (c) => {
  const { merchantId, orderNumber, lang } = await c.req.json().catch(() => ({}))
  const emailCfg = { frontendUrl: env.frontendUrl, emailFrom: env.emailFrom, qrBaseUrl: env.supabaseUrl }
  // Concurrent, not sequential: the three are independent best-effort sends and a slow Telegram
  // call must not delay either email. Each returns its own result and never throws, so
  // Promise.all cannot reject — no channel blocks or suppresses another.
  const [telegram, email, merchantEmail] = await Promise.all([
    notifyOrderPlaced(admin, notifyDeps.telegram, { merchantId, orderNumber }),
    emailOrderConfirmation(admin, admin, notifyDeps.email, { merchantId, orderNumber, lang }, emailCfg),
    emailMerchantOrder(admin, admin, notifyDeps.email, { merchantId, orderNumber }, emailCfg),
  ])
  // 404 only when the order genuinely does not exist — which every arm agrees on, since each
  // looks the same row up. Otherwise 200 with the combined result: any channel skipping or
  // erroring is normal and the fire-and-forget caller ignores the body.
  if (
    telegram.error === 'order not found' &&
    email.error === 'order not found' &&
    merchantEmail.error === 'order not found'
  ) {
    return c.json({ telegram, email, merchantEmail }, 404)
  }
  return c.json({ telegram, email, merchantEmail })
})

// ── Distance delivery quote ───────────────────────────────────────────────────
// Unauthenticated on purpose: a guest checkout must be able to see its delivery fee, and guest
// checkout is a first-class path.
//
// It takes a PLACE ID rather than an address, and that is an API-shape decision with a cost
// behind it: a free-text field invites a caller to mint unlimited distinct destinations, and
// every distinct destination is a billable lookup on the platform's own Maps account. Note the
// shape is the deterrent, not a validation — any non-empty string is accepted, because place ids
// have no stable public format and a shape check would refuse legitimate addresses. What
// actually bounds the spend is the pair of limits below. (docs/adr/0001)
//
// A hit on `distance_quotes` is the normal case and costs nothing; the same row is what order
// intake reads a moment later, which is what makes the quote and the charge the same number.
app.post('/api/shipping/quote', async (c) => {
  const body = await c.req.json().catch(() => null)
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.merchantId !== 'string' || !b.merchantId || typeof b.placeId !== 'string' || !b.placeId) {
    return c.json({ error: 'invalid_body' }, QUOTE_REFUSAL_STATUS.invalid_body)
  }

  if (!quoteIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, QUOTE_REFUSAL_STATUS.rate_limited)

  const { data: merchant } = await admin
    .from('merchants')
    .select('id, currency, status, express_enabled, delivery_base_fee, delivery_rate_per_km, delivery_max_km, origin_place_id')
    .eq('id', b.merchantId)
    .maybeSingle()
  if (!merchant) return c.json({ error: 'merchant_not_found' }, QUOTE_REFUSAL_STATUS.merchant_not_found)
  if (merchant.status !== 'active') return c.json({ error: 'merchant_inactive' }, QUOTE_REFUSAL_STATUS.merchant_inactive)

  // `shopDistance`, not a local read of these columns: the storefront quotes from this exact
  // function and order intake charges from it, and a third reading here is a third rule the
  // customer meets as a `price_changed` refusal.
  const policy = shopDistance(merchant)
  // `not_distance_priced` keeps its wire name — the storefront already branches on it, and
  // renaming a refusal code is a separate, customer-visible change.
  if (!policy.enabled || !policy.usable) return c.json({ error: 'not_distance_priced' }, QUOTE_REFUSAL_STATUS.not_distance_priced)

  // The peek, the per-shop daily ceiling and the no-route / beyond-max-km mapping all live in
  // `resolveRoutedDistance`, shared with order intake so the number quoted here and the number
  // charged there cannot drift apart (#119). What is quote-specific stays here: the per-IP request
  // bound checked up front above (hits and misses alike — this endpoint spends money on a miss, so
  // it is bounded twice over), and the mapping of the wire-agnostic outcome to this endpoint's
  // refusal codes.
  const outcome = await resolveRoutedDistance(policy, b.placeId, liveDistanceDeps, new Date(), {
    merchantKey: merchant.id,
    merchantWindow: quoteMerchantWindow,
    // No `onMiss`: the per-IP bound is handled up front, not on the miss path.
  })

  // NO ROUTE AND OUT-OF-RANGE ARE THE SAME ANSWER to the customer — "this shop does not deliver
  // there" — because they are the same fact. Only `failed` invites a retry; `quota_exceeded` is
  // the shop's ceiling, which the storefront branches on separately.
  if (outcome.status === 'out_of_range') return c.json({ error: 'out_of_range' }, QUOTE_REFUSAL_STATUS.out_of_range)
  if (outcome.status === 'quota_exceeded') return c.json({ error: 'quota_exceeded' }, QUOTE_REFUSAL_STATUS.quota_exceeded)
  if (outcome.status === 'failed') return c.json({ error: 'lookup_failed' }, QUOTE_REFUSAL_STATUS.lookup_failed)

  const km = routedKm(outcome.metres)
  return c.json({ km, fee: distanceFee(policy, km), currency: merchant.currency ?? 'MYR' })
})

// ── Address autocomplete proxy ────────────────────────────────────────────────
// Proxied for ONE reason above all: the Maps credential must never reach the browser, where a
// key can be lifted off a page and spent elsewhere (#101, story 49).
//
// `session` is money, not hygiene: a burst of keystrokes carrying one token bills as a single
// lookup when it ends in a details call. The browser mints it and passes the SAME one to
// /api/places/detail.
//
// Unauthenticated, because a guest picking a delivery address has no session. Bounded by IP for
// the same reason the quote endpoint is: these calls cost the platform money.
app.get('/api/places/suggest', async (c) => {
  if (!placesIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)
  // The per-IP window rotates away with a spoofed header (see the module comment on
  // `placesGlobalWindow`); this is the ceiling that actually holds.
  if (!placesGlobalWindow.allow('global')) {
    console.error('Places global quota exceeded on /api/places/suggest — investigate for abuse')
    return c.json({ error: 'rate_limited' }, 429)
  }
  const input = c.req.query('input') ?? ''
  const session = c.req.query('session') ?? ''
  // A short prefix is noise that still bills. Empty results, no call.
  if (input.trim().length < 3) return c.json({ suggestions: [] })
  return c.json({ suggestions: await googlePlaceSuggest(input, session) })
})

app.get('/api/places/detail/:placeId', async (c) => {
  if (!placesIpWindow.allow(ipOf(c))) return c.json({ error: 'rate_limited' }, 429)
  if (!placesGlobalWindow.allow('global')) {
    console.error('Places global quota exceeded on /api/places/detail — investigate for abuse')
    return c.json({ error: 'rate_limited' }, 429)
  }
  const placeId = c.req.param('placeId')
  // Same floor as `suggest`'s input check, missing here until now: place ids have no stable
  // public format, so this is a sanity guard against an empty or absurdly long value, not a
  // validation of shape.
  if (!placeId || placeId.length > 512) return c.json({ error: 'place_not_found' }, 404)
  const detail = await googlePlaceDetail(placeId, c.req.query('session') ?? '')
  if (!detail) return c.json({ error: 'place_not_found' }, 404)
  return c.json(detail)
})

// ── Stripe webhook — authoritative subscription state ──────────────────────────
app.post('/api/stripe/webhook', async (c) => {
  const sig = c.req.header('stripe-signature') || ''
  const raw = await c.req.text() // raw body required for signature verification

  let event
  try {
    event = stripe.webhooks.constructEvent(raw, sig, env.stripeWebhookSecret)
  } catch (err) {
    console.error('Webhook signature verification failed:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Invalid signature' }, 400)
  }

  // A webhook endpoint is account-wide — it cannot be scoped to a product, so every subscription
  // and invoice event from anything else this Stripe account sells arrives here correctly signed.
  // Drop those before any handler runs (webhookOwnership.ts holds the rule and the reasoning).
  // 200, not an error: a stranger's event is handled, not failed, and a non-2xx would make Stripe
  // retry it for three days.
  if (!isOurEvent(event, env.prices)) {
    return c.json({ received: true, ignored: true })
  }

  try {
    // FAILS CLOSED: an event type absent from webhookOwnership.ts is dropped above and never
    // reaches this switch. A new case here needs its extractor added there too.
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        // Metadata only. `client_reference_id` used to be the fallback, and it was the one hole
        // the ownership gate exists to close: a foreign Checkout that set it for its own purposes
        // reached upsertBilling with a value that is not a merchant id.
        const merchantId = session.metadata?.merchant_id
        if (merchantId && session.subscription) {
          const subscriptionId =
            typeof session.subscription === 'string' ? session.subscription : session.subscription.id
          const sub = await stripe.subscriptions.retrieve(subscriptionId)
          await upsertBilling(merchantId, billingFromSubscription(sub))
          // The tier comes from the price they just paid, not from what signup wrote (#112).
          await reconcileBillingCycle(merchantId, sub)
          await setMerchantStatus(merchantId, 'active')
        }
        break
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object
        const merchantId = sub.metadata?.merchant_id
        if (merchantId) {
          const fields = billingFromSubscription(sub)
          // The Customer Portal often stores an added card as the customer default
          // rather than on the subscription, leaving sub.default_payment_method null.
          // Resolve that so a merchant who added a card stops seeing the nag banner.
          if (!fields.has_payment_method) {
            const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
            const customer = await stripe.customers.retrieve(customerId)
            if (!('deleted' in customer) && customer.invoice_settings?.default_payment_method) {
              fields.has_payment_method = true
            }
          }
          await upsertBilling(merchantId, fields)
          // This is the plan-switch path: the Customer Portal swaps the price and Stripe fires
          // this event, so the tier follows the money (#112). Also repairs `billing_cycle`,
          // which a monthly↔yearly switch in the portal used to leave stale.
          await reconcileBillingCycle(merchantId, sub)

          // The fast path out of dunning. A shop the sweep closed for an unpaid invoice reopens
          // the moment Stripe says the subscription is live again — this event is what carries
          // `past_due` → `active`. Guarded on the stamp, so a shop a superadmin suspended is
          // never reopened by a renewal going through; the hourly sweep repeats this if the
          // event is lost.
          if (sub.status !== 'past_due' && LIVE_STATUSES.includes(sub.status)) {
            const { data: closed } = await admin
              .from('merchant_billing')
              .select('dunning_suspended_at')
              .eq('merchant_id', merchantId)
              .maybeSingle()
            if (closed?.dunning_suspended_at) {
              await reopenAfterPayment(merchantId)
              console.log(`Merchant ${merchantId} paid an overdue invoice — storefront reopened.`)
            }
          }
        }
        break
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const merchantId = sub.metadata?.merchant_id
        if (merchantId) {
          // Only the CURRENT subscription's cancellation suspends the shop — a
          // stale or replaced subscription (e.g. the old trial after the shop
          // reactivated via Checkout) must not re-suspend a paying merchant or
          // clobber the billing row.
          const { data: current } = await admin
            .from('merchant_billing')
            .select('stripe_subscription_id')
            .eq('merchant_id', merchantId)
            .maybeSingle()
          if (current?.stripe_subscription_id && current.stripe_subscription_id !== sub.id) break

          // The stored id said this IS the current subscription — but it says that from a row
          // only the activation events keep current, and those are exactly what goes missing.
          // So confirm against Stripe before closing anything: a customer still holding a live
          // subscription is a shop that is still paying, whatever our row believes.
          const replacement = await liveSubscriptionBesides(sub)
          if (replacement) {
            await upsertBilling(merchantId, billingFromSubscription(replacement))
            await reconcileBillingCycle(merchantId, replacement)
            console.log(
              `Subscription ${sub.id} ended for merchant ${merchantId}, but ${replacement.id} is ` +
                `live — reconciled to it instead of closing the shop.`,
            )
            break
          }

          await upsertBilling(merchantId, billingFromSubscription(sub))
          // Suspends the shop — see lapseMerchant. Shared with the reconciliation sweep so a
          // shop closed by either road is closed the same way.
          await lapseMerchant(merchantId)
        }
        break
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object
        // Stripe moved `subscription_details` under `invoice.parent` (API
        // version 2025-03-31+). The payload shape follows the ENDPOINT's
        // registered API version, so read the new location with a legacy
        // fallback (same drift-hardening as billingFromSubscription).
        const parent = (inv as { parent?: { subscription_details?: { metadata?: Record<string, string> } } }).parent
        const merchantId =
          (inv as { subscription_details?: { metadata?: Record<string, string> } }).subscription_details?.metadata?.merchant_id ||
          parent?.subscription_details?.metadata?.merchant_id ||
          inv.metadata?.merchant_id
        if (merchantId) {
          // The period this invoice bills for is the period the shop has not paid for, and the
          // grace clock counts from its start. Written HERE and not left to
          // `customer.subscription.updated`, because the order of those two deliveries is not
          // guaranteed: until the period advances on the row, the stored start is last month's
          // and the dashboard would tell the merchant their shop closes today. (The sweep never
          // reads it — it re-derives the date from Stripe before closing anything — so this is
          // the merchant's view being right, not the decision.)
          const periodStart = (inv as { period_start?: number }).period_start
          await upsertBilling(merchantId, {
            status: 'past_due',
            ...(periodStart ? { current_period_start: new Date(periodStart * 1000).toISOString() } : {}),
          })
        }
        break
      }
      case 'invoice.paid': {
        const inv = event.data.object
        // The referred merchant's FIRST real payment is the referral-reward trigger.
        // `amount_paid > 0` excludes the $0 trial-start invoice; the billing_reason
        // allowlist keeps it to a subscription's own invoices (create = paid signup /
        // reactivation, cycle = trial converting or renewing). The reward is granted at
        // most once per referred shop (referral_rewards PK), so a later renewal cycle
        // finds the row and no-ops — only the first qualifying paid invoice pays out.
        const reason = (inv as { billing_reason?: string }).billing_reason
        const firstPaid =
          (inv.amount_paid ?? 0) > 0 &&
          (reason === 'subscription_create' || reason === 'subscription_cycle')
        if (!firstPaid) break

        // Same metadata drift-hardening as invoice.payment_failed above.
        const parent = (inv as { parent?: { subscription_details?: { metadata?: Record<string, string> } } }).parent
        const merchantId =
          (inv as { subscription_details?: { metadata?: Record<string, string> } }).subscription_details?.metadata?.merchant_id ||
          parent?.subscription_details?.metadata?.merchant_id ||
          inv.metadata?.merchant_id
        if (merchantId) {
          const decision = await processReferralReward(merchantId)
          if (!decision.grant && decision.reason !== 'not_referred' && decision.reason !== 'already_rewarded') {
            console.log(`Referral reward skipped for referred merchant ${merchantId}: ${decision.reason}`)
          }
        }
        break
      }
      case 'customer.subscription.trial_will_end': {
        // Fires 72h before trial end — the out-of-app reminder. A thrown send
        // error 500s the webhook so Stripe retries delivery.
        const sub = event.data.object
        const merchantId = sub.metadata?.merchant_id
        if (merchantId && sub.trial_end) {
          const { data: merchant } = await admin
            .from('merchants').select('name, owner_id').eq('id', merchantId).maybeSingle()
          // Owner email from Auth, not profiles — the profiles row may not exist
          // (client-side profile upsert is currently RLS-blocked for new signups).
          const { data: ownerUser } = merchant?.owner_id
            ? await admin.auth.admin.getUserById(merchant.owner_id)
            : { data: { user: null } }
          const ownerEmail = ownerUser?.user?.email
          if (ownerEmail) {
            const { subject, text } = buildTrialReminderEmail({
              shopName: merchant?.name || 'your shop',
              trialEndsAt: new Date(sub.trial_end * 1000).toISOString(),
              dashboardUrl: `${env.frontendUrl}/merchant`,
            })
            await resendSend(ownerEmail, subject, { text })
          }
        }
        break
      }
      default:
        break // ignore unhandled event types
    }
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Handler error' }, 500)
  }

  return c.json({ received: true })
})
