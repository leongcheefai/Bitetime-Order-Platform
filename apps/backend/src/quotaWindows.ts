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
