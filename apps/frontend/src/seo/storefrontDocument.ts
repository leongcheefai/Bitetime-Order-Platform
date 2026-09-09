// The storefront findability document (#253, ADR 0022).
//
// The pure half of the edge function that serves /s/:slug: given the SPA shell, the requested
// URL and a resolution of the slug, decide the served bytes. Everything a crawler reads is
// decided here — per-shop <title>, meta description, canonical, og: tags and LocalBusiness
// JSON-LD — so it is unit-testable without a network. The function around it stays a thin
// fetch-and-call shell that fails open to the untouched shell on any error.
//
// The body stays the shell: humans get exactly the app they got before, and only the head
// differs. That is the whole design — see the ADR for what was rejected and why.
// Reached by its path inside the shared package, not by the bare `@bitetime/shared`
// specifier every other file uses, and the reason is the Vercel function runtime: @vercel/node
// transpiles each .ts file on its own instead of bundling, so the emitted import string is what
// Node resolves in the lambda. There is no node_modules there — the workspace symlink is gone —
// and the package's `exports` names `./src/index.ts`, which the build never emits. Both make a
// bare import a crash at invocation (FUNCTION_INVOCATION_FAILED), not a build error. The traced
// file lands at packages/shared/src/, so this relative path is the one that resolves.
import { menuCategoriesFromRow } from '../../../../packages/shared/src/menuCategories.js'

export interface StorefrontShop {
  name: string
  slug: string
  status: string
  description?: string | null
  currency?: string | null
  pickup_address?: string | null
  product_categories?: unknown
}

export interface StorefrontProduct {
  name: string
  price: number
}

export type StorefrontResolution =
  | { kind: 'shop'; shop: StorefrontShop; products: StorefrontProduct[] }
  | { kind: 'moved'; movedTo: string }
  | { kind: 'not-found' }

export interface StorefrontRequest {
  /** Scheme + host, no trailing slash — e.g. https://tinyorder.shop */
  origin: string
  slug: string
  /** Anything after /s/<slug>/ — canonicalised onto the shop root, preserved on redirects. */
  subpath?: string
}

export interface StorefrontDocument {
  status: number
  headers: Record<string, string>
  body: string
}

/** How many products the JSON-LD offers — the shop's own sort order decides which lead. */
export const OFFER_CAP = 20

const CACHE = 'public, s-maxage=300, stale-while-revalidate=604800'
const HTML = 'text/html; charset=utf-8'

// Merchant-controlled text lands in head markup and must never break out of it. `'` stays
// unescaped on purpose: every attribute this module writes is double-quoted.
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Inside a <script> block the ONLY dangerous sequence is a closing tag; escaping every `<`
// (legal inside JSON strings) closes that without changing what JSON.parse reads.
const jsonForScriptTag = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

export function buildStorefrontDocument(
  shell: string,
  req: StorefrontRequest,
  resolution: StorefrontResolution,
): StorefrontDocument {
  if (resolution.kind === 'not-found') {
    return { status: 404, headers: { 'Content-Type': HTML, 'Cache-Control': CACHE }, body: shell }
  }

  if (resolution.kind === 'moved') {
    const sub = req.subpath ? `/${req.subpath}` : ''
    return {
      status: 301,
      headers: {
        Location: `${req.origin}/s/${encodeURIComponent(resolution.movedTo)}${sub}`,
        // No stale-while-revalidate here, unlike the HTML: this header pins a REDIRECT TARGET,
        // and a claim-wins reversal must not keep sending one shop's visitors to another for
        // however long the CDN holds the stale copy.
        'Cache-Control': 'public, s-maxage=300',
      },
      body: '',
    }
  }

  const { shop, products } = resolution
  const canonical = `${req.origin}/s/${encodeURIComponent(shop.slug)}`
  const title = `${shop.name} | TinyOrder`
  const description = shopDescription(shop)

  let body = shell
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*" \/>/,
      `<meta name="description" content="${escapeHtml(description)}" />`,
    )
    .replace(
      /<meta property="og:title" content="[^"]*" \/>/,
      `<meta property="og:title" content="${escapeHtml(title)}" />`,
    )
    .replace(
      /<meta property="og:description" content="[^"]*" \/>/,
      `<meta property="og:description" content="${escapeHtml(description)}" />`,
    )

  const inject = [
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
    // noindex on the shop ROOT only. Subpaths carry a canonical to the root instead — a
    // cross-page canonical and a noindex on the same document are conflicting signals, and the
    // root's own noindex already covers the shop (spec decision 12).
    ...(shop.status !== 'active' && !req.subpath ? ['<meta name="robots" content="noindex" />'] : []),
    `<script type="application/ld+json">${jsonForScriptTag(jsonLd(shop, products, canonical, description))}</script>`,
  ].join('\n    ')
  // A shell with no </head> is not a shell we understand — serve it untouched (fail open)
  // rather than guess where the tags belong.
  body = body.includes('</head>') ? body.replace('</head>', `    ${inject}\n  </head>`) : shell

  return { status: 200, headers: { 'Content-Type': HTML, 'Cache-Control': CACHE }, body }
}

function shopDescription(shop: StorefrontShop): string {
  const own = shop.description?.trim()
  if (own) return own
  const categories = menuCategoriesFromRow(shop.product_categories)
    .filter((c) => c.active)
    .map((c) => c.name)
    .slice(0, 4)
  const menu = categories.length ? ` ${categories.join(', ')}.` : ''
  return `Order online from ${shop.name}.${menu} Every order in one place, on TinyOrder.`
}

function jsonLd(
  shop: StorefrontShop,
  products: StorefrontProduct[],
  canonical: string,
  description: string,
) {
  const currency = shop.currency || 'MYR'
  // The item name rides on the Offer, and there is deliberately no `itemOffered: {'@type':
  // 'Product'}` node. Google validates every Product it finds against the Product rich result,
  // which demands one of offers/review/aggregateRating on the Product ITSELF — a bare name is an
  // invalid item ("Either offers, review, or aggregateRating should be specified", first seen
  // 2026-09-07). Nesting a second Offer inside each Product would clear the error and then earn a
  // warning per item for the fields this module does not hold: a StorefrontProduct is a name and a
  // price, with no image and no description, so no menu item here can ever win a product snippet.
  // An Offer carrying `name` says the same true thing and claims nothing it cannot support.
  const offers = products.slice(0, OFFER_CAP).map((p) => ({
    '@type': 'Offer',
    name: p.name,
    price: p.price,
    priceCurrency: currency,
    availability: 'https://schema.org/InStock',
  }))
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: shop.name,
    description,
    url: canonical,
    ...(shop.pickup_address ? { address: shop.pickup_address } : {}),
    ...(offers.length ? { makesOffer: offers } : {}),
  }
}
