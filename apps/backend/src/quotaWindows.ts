// The spend ceilings for everything that can call Google on the platform's account.
//
// They live in their own module because there are TWO spenders, not one: the quote endpoint and
// ORDER INTAKE, which re-resolves a distance when the cache missed. They must share one bucket —
// it is one Google bill for one shop, and a ceiling that only half the spenders consult is not a
// ceiling.
//
// Same in-memory limiter weaknesses as everywhere else here, inherited knowingly: they reset on
// redeploy and stop protecting anything past one backend instance (#101, Out of Scope).
import { createSlidingWindow } from './rateLimit.js'

// The quote endpoint SPENDS MONEY per cache miss (see docs/adr/0001), so it is bounded twice
// over, and the two bounds guard different things:
//
//   * `quoteIpWindow` bounds REQUESTS by caller IP — cheap flood protection, applied to hits
//     and misses alike.
//   * `quoteMerchantWindow` bounds PROVIDER CALLS per shop per day — the runaway stop. It is
//     checked only when the cache missed, because a cache hit costs nothing and must never eat
//     a shop's ceiling.
//
// Both inherit the in-memory limiter's known weaknesses KNOWINGLY, exactly as customer signup
// does: they reset on redeploy and stop protecting anything past one backend instance. Fixing
// that is its own piece of work (#101 Out of Scope).
// 300/hour, for the same reason `placesIpWindow` is: behind carrier-grade NAT or mall wifi —
// most Malaysian mobile traffic, on a Malaysian platform — dozens of unrelated customers share
// one address, and at 60 a busy shop's customers would refuse each other. Note ORDER INTAKE's
// cache-miss path draws on this same bucket, so an over-tight value here does not merely fail a
// quote, it fails an ORDER. The per-shop ceiling below is what actually bounds the spend.
export const quoteIpWindow = createSlidingWindow({ limit: 300, windowMs: 60 * 60_000, now: () => Date.now() })
export const quoteMerchantWindow = createSlidingWindow({ limit: 500, windowMs: 24 * 60 * 60_000, now: () => Date.now() })

// The UNSPOOFABLE stop for the Places proxy. `placesIpWindow`'s key comes from `clientIp`, which
// trusts `cf-connecting-ip` first — and this backend does not sit behind Cloudflare, so a caller
// rotates that header and mints a fresh per-IP bucket per request. That window bounds accidents;
// this one bounds abuse. There is no merchant to key on here (the proxy serves the storefront and
// Shop Settings alike), so the ceiling is global and deliberately generous: it should never be
// reached by honest traffic, and it is the only thing standing between a curl loop and a
// four-figure invoice.
//
// Same in-memory weaknesses as every other limiter here, inherited knowingly: resets on redeploy,
// stops working past one backend instance (#101, Out of Scope).
export const placesGlobalWindow = createSlidingWindow({ limit: 20_000, windowMs: 24 * 60 * 60_000, now: () => Date.now() })

// AI menu import (tasks/prd-ai-menu-import.md). Belongs in this file rather than beside the route
// for the reason the file exists at all: it is a ceiling on money the PLATFORM spends on a
// merchant's behalf, same as the Google windows above — one Claude bill for one shop.
//
// Keyed by merchant, not by IP, and there is no IP twin. The Google windows carry both because
// their spender is reachable by an anonymous storefront visitor; this route is behind
// `requireMerchantOwns`, so every call already has a named shop attached to it and the shop IS
// the unit of spend.
//
// 20 a day is set against the WORKFLOW, not against a cost model there is no data for yet: a
// menu is one photo per page, a merchant re-shooting a blurry page needs a handful of tries, and
// a shop legitimately importing twenty pages in one day is not a shop this platform has. It is a
// runaway stop, not a rationing device — reaching it should mean something is wrong.
//
// Same in-memory weaknesses as every other limiter here, inherited knowingly: resets on redeploy,
// stops working past one backend instance (#101, Out of Scope).
export const menuImportMerchantWindow = createSlidingWindow({ limit: 20, windowMs: 24 * 60 * 60_000, now: () => Date.now() })

// The shop analytics assistant (tasks/prd-shop-analytics-assistant.md). Same argument as the
// import window above, and the same in-memory weaknesses: one shop, one Claude bill, a ceiling
// that resets on redeploy and stops protecting anything past one backend instance (#101).
//
// 50 a day is a runaway stop rather than a ration, and the number is chosen from nothing — there
// is no usage data yet. It sits where an honest merchant will never meet it and a loop will.
// Revisit it once there is a week of real usage; a figure picked from no evidence deserves no
// more confidence than that.
export const assistantMerchantWindow = createSlidingWindow({ limit: 50, windowMs: 24 * 60 * 60_000, now: () => Date.now() })

// ── The monthly ceilings ────────────────────────────────────────────────────────────────────
//
// The two windows above are burst stops. They are the right shape for a day and the WRONG shape
// for a month, for one reason: they live in memory and reset on redeploy. Over twenty-four hours
// that is a rounding error; over a month it means the ceiling is however long it has been since
// the last deploy, which is not a ceiling at all. So these are counts in Postgres
// (`aiUsageDb.ts`), keyed by the shop's own calendar month, and they are what actually bounds the
// Anthropic bill. They also survive a second backend instance, which nothing else in this file
// does (#101).
//
// These figures are set against the PRICE OF THE PLAN, which is the constraint the daily windows
// above never had to answer to. A shop pays RM39.90 a month — about USD 8.40 gross, less after
// Stripe — so a ceiling is only a ceiling if the spend it permits is a fraction of that. On
// Sonnet 5 a menu photograph costs roughly USD 0.06 and a question roughly USD 0.03, which puts
// the numbers below at about USD 2.30 a month for a shop that exhausts everything, and pennies
// for the shop that does not. An earlier draft of this file allowed 150 and 600; that was USD 16
// a month against USD 8.40 of revenue, which is not a ceiling, it is a subsidy.
//
// Menu import is TWO buckets, because it is a setup feature and a flat monthly ceiling cannot
// describe one. The lifetime grant covers photographing a menu for the first time — fifteen or
// twenty pages, re-shot when a page comes out blurry — and never comes back. The monthly figure
// is what a shop needs afterwards: a new page, a seasonal change. A single monthly number would
// have to be either too small for that first week or, renewed twelve times a year, wildly more
// than the job ever needs.
//
// The lifetime grant is also the answer to the exposure the monthly buckets cannot see: the trial
// is seven days and cardless, the shop is `active` throughout, and menu import is exactly what a
// merchant does on day one. Every import inside that window is spent before the platform has been
// paid anything at all, and no monthly ceiling notices, because it all happens inside one month.
//
// All three are guesses, and `ai_usage` is the thing that will replace them: it records calls per
// shop per feature per month, so after a month of real merchants these can be set from evidence
// rather than from arithmetic about a workflow nobody has measured yet.
export const MENU_IMPORT_LIFETIME_LIMIT = 30
export const MENU_IMPORT_MONTHLY_LIMIT = 5
export const ASSISTANT_MONTHLY_LIMIT = 60

// The guest invoice door (#242, docs/adr/0018). Unlike everything above it, this bounds no
// spending at all — no Google call, no Claude call, nothing the platform pays for. What it bounds
// is DISCLOSURE: the door opens on an order number plus a phone, and an order number is a
// structured, near-sequential string (`PREFIX-YYMMDD-XXXX`, the daily counter starting at 50), so
// the pair is guessable by anyone who knows a shop's prefix and a customer's number. ADR 0018
// accepts that knowingly; this is what makes guessing slow enough to be useless.
//
// Two windows, because one number cannot say both things. A customer who fat-fingers their phone
// tries three or four times in a minute; a script tries thousands. 10/minute leaves the honest
// customer untouched and takes a determined enumerator from minutes to weeks.
//
// Keyed by IP, which behind carrier-grade NAT is shared by many unrelated customers — hence 60 an
// hour rather than the 10×60 the per-minute figure would imply, and hence a per-minute ceiling
// generous enough that a shared address is not exhausted by two people at once.
//
// Same in-memory weaknesses as every other limiter here, inherited knowingly: resets on redeploy,
// and stops protecting anything past one backend instance (#101, Out of Scope). The fix, if this
// ever needs one, is a Postgres counter of the shape `ai_usage` already has.
/**
 * A per-IP bound built from TWO windows, because one number cannot say both things — see the two
 * paragraphs above. Each call gets its OWN pair of counters: two doors that share a shape must not
 * share a budget, or a customer who used one is refused at the other.
 */
function createIpDoorWindow(perMinute: number, perHour: number) {
  const minuteWindow = createSlidingWindow({ limit: perMinute, windowMs: 60_000, now: () => Date.now() })
  const hourWindow = createSlidingWindow({ limit: perHour, windowMs: 60 * 60_000, now: () => Date.now() })
  return {
    allow(key: string): boolean {
      // BOTH windows record the hit — an early return from the minute window would leave the hour
      // window under-counting exactly the caller it exists to stop.
      const minute = minuteWindow.allow(key)
      const hour = hourWindow.allow(key)
      return minute && hour
    },
  }
}

export const invoiceLookupIpWindow = createIpDoorWindow(10, 60)

// The guest review door (POST /api/orders/review) proves the SAME guessable pair the guest
// invoice door does — an order number and a phone — so it carries the same bound, and for the
// same reason. A customer who mistypes their phone tries three or four times in a minute; a
// script enumerating order numbers tries thousands.
//
// Its own windows, not a share of the invoice door's: a customer who downloaded their invoice and
// then rates the order must not be refused for having used a different door a moment earlier.
//
// Same in-memory weaknesses as every other limiter here, inherited knowingly: resets on redeploy,
// and stops protecting anything past one backend instance (#101, Out of Scope).
export const reviewSubmitIpWindow = createIpDoorWindow(10, 60)

// The customer's HitPay QR door (spec 2026-10-02). Addressed by an order UUID, unauthenticated
// like the payment-proof door. A QR costs a HitPay call, so it gets the guest-door bound; the
// status poll runs every 3 s for up to 15 minutes, so its bound is set above that (20/minute,
// 300 per QR) with room for a second open tab.
export const hitpayQrIpWindow = createIpDoorWindow(10, 60)
export const hitpayStatusIpWindow = createIpDoorWindow(45, 1200)

// How many devices one MERCHANT account may hold at once. A device is one GoTrue session.
//
// It sits here with the other platform figures rather than in deviceLimit.ts, so the numbers a
// shop is measured against are in one file. Unlike everything else in this module it bounds no
// spend and no request rate: it bounds credential sharing, which is why it is a small number and
// not a generous one.
//
// Customers and superadmins are not bounded at all. See
// docs/superpowers/specs/2026-08-25-merchant-device-limit-design.md.
export const MERCHANT_DEVICE_LIMIT = 2
