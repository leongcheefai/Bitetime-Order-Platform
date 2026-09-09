// The storefront findability document builder (#253, ADR 0022): the pure half of the edge
// function that serves /s/:slug. Everything a crawler reads is decided here — the function
// itself is a thin fetch-and-call shell that these tests deliberately do not cover.
import { describe, it, expect } from 'vitest'
import { buildStorefrontDocument } from './storefrontDocument'
import type { StorefrontResolution } from './storefrontDocument'

const SHELL = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<title>TinyOrder — Start Your Own Food Shop, Orders in One Place</title>',
  '<meta name="description" content="Start your own food shop online." />',
  '<meta property="og:title" content="TinyOrder — Start Your Own Food Shop, Orders in One Place" />',
  '<meta property="og:description" content="Start your own food shop online." />',
  '</head>',
  '<body><div id="root"></div></body>',
  '</html>',
].join('\n')

const req = (over: Partial<{ origin: string; slug: string; subpath: string }> = {}) => ({
  origin: 'https://tinyorder.shop',
  slug: 'uncle-lim',
  ...over,
})

const shop = (over: Record<string, unknown> = {}): StorefrontResolution => ({
  kind: 'shop',
  shop: {
    name: "Uncle Lim's Kitchen",
    slug: 'uncle-lim',
    status: 'active',
    description: 'Homemade nyonya kuih, baked fresh daily.',
    currency: 'MYR',
    ...over,
  },
  products: [
    { name: 'Kuih Lapis', price: 12 },
    { name: 'Onde-onde', price: 8.5 },
  ],
})

describe('an active shop', () => {
  it('serves the shop title, description and canonical', () => {
    const doc = buildStorefrontDocument(SHELL, req(), shop())
    expect(doc.status).toBe(200)
    expect(doc.headers['Content-Type']).toContain('text/html')
    expect(doc.body).toContain("<title>Uncle Lim's Kitchen | TinyOrder</title>")
    expect(doc.body).toContain('Homemade nyonya kuih, baked fresh daily.')
    expect(doc.body).not.toContain('Start Your Own Food Shop')
    expect(doc.body).toContain('<link rel="canonical" href="https://tinyorder.shop/s/uncle-lim" />')
    expect(doc.body).toContain('<meta property="og:url" content="https://tinyorder.shop/s/uncle-lim" />')
  })

  it('caches at the CDN and revalidates in the background', () => {
    const doc = buildStorefrontDocument(SHELL, req(), shop())
    expect(doc.headers['Cache-Control']).toBe('public, s-maxage=300, stale-while-revalidate=604800')
  })

  it('collapses subpaths onto the shop root canonical, without noindex', () => {
    const doc = buildStorefrontDocument(SHELL, req({ subpath: 'track/TO-260828-0051' }), shop())
    expect(doc.body).toContain('<link rel="canonical" href="https://tinyorder.shop/s/uncle-lim" />')
    expect(doc.body).not.toContain('noindex')
  })

  it('carries LocalBusiness JSON-LD with capped offers in the shop currency', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `Item ${i}`, price: i + 1 }))
    const res = { ...shop(), products: many } as StorefrontResolution
    const doc = buildStorefrontDocument(SHELL, req(), res)
    const m = doc.body.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)
    expect(m).not.toBeNull()
    const ld = JSON.parse(m![1].replace(/\\u003c/g, '<'))
    expect(ld['@type']).toBe('LocalBusiness')
    expect(ld.name).toBe("Uncle Lim's Kitchen")
    expect(ld.url).toBe('https://tinyorder.shop/s/uncle-lim')
    expect(ld.makesOffer).toHaveLength(20)
    expect(ld.makesOffer[0]).toEqual({
      '@type': 'Offer',
      name: 'Item 0',
      price: 1,
      priceCurrency: 'MYR',
      availability: 'https://schema.org/InStock',
    })
  })

  // Google reads every Product node it finds and demands offers/review/aggregateRating on it.
  // This module holds a name and a price per item and nothing else, so it names no Product at all.
  it('names no Product node in the JSON-LD', () => {
    const res = { ...shop(), products: [{ name: 'Item 0', price: 1 }] } as StorefrontResolution
    const doc = buildStorefrontDocument(SHELL, req(), res)
    const m = doc.body.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)
    expect(m![1]).not.toContain('Product')
  })

  it('escapes merchant text in head markup', () => {
    const res = shop({ name: '"><script>alert(1)</script>', description: 'A & B <shop>' })
    const doc = buildStorefrontDocument(SHELL, req(), res)
    expect(doc.body).not.toContain('<script>alert(1)</script>')
    expect(doc.body).toContain('&quot;&gt;&lt;script&gt;')
    expect(doc.body).toContain('A &amp; B &lt;shop&gt;')
  })

  it('cannot be broken out of inside the JSON-LD script block', () => {
    const res = shop({ name: 'Evil </script><script>alert(1)</script>' })
    const doc = buildStorefrontDocument(SHELL, req(), res)
    const after = doc.body.slice(doc.body.indexOf('application/ld+json'))
    expect(after).not.toContain('</script><script>')
  })

  it('derives a description from categories when the shop wrote none', () => {
    const res = shop({
      description: null,
      product_categories: [
        { id: 'a', name: 'Kuih', active: true },
        { id: 'b', name: 'Cakes', active: true },
        { id: 'c', name: 'Hidden', active: false },
      ],
    })
    const doc = buildStorefrontDocument(SHELL, req(), res)
    expect(doc.body).toContain("Order online from Uncle Lim's Kitchen")
    expect(doc.body).toContain('Kuih')
    expect(doc.body).toContain('Cakes')
    expect(doc.body).not.toContain('Hidden')
  })
})

describe('a shop that is not open', () => {
  it.each(['suspended', 'pending'] as const)('%s serves 200 with noindex', (status) => {
    const doc = buildStorefrontDocument(SHELL, req(), shop({ status }))
    expect(doc.status).toBe(200)
    expect(doc.body).toContain('<meta name="robots" content="noindex" />')
  })

  it('leaves noindex OFF its subpaths — the canonical to the root is the one signal', () => {
    const doc = buildStorefrontDocument(SHELL, req({ subpath: 'track/TO-1' }), shop({ status: 'suspended' }))
    expect(doc.body).not.toContain('noindex')
    expect(doc.body).toContain('<link rel="canonical" href="https://tinyorder.shop/s/uncle-lim" />')
  })
})

describe('a retired slug', () => {
  it('301s to the current slug, preserving the subpath', () => {
    const doc = buildStorefrontDocument(
      SHELL,
      req({ slug: 'old-name', subpath: 'track/TO-1' }),
      { kind: 'moved', movedTo: 'new-name' },
    )
    expect(doc.status).toBe(301)
    expect(doc.headers.Location).toBe('https://tinyorder.shop/s/new-name/track/TO-1')
  })

  it('caches the redirect briefly, never stale — it pins a target, not a head', () => {
    const doc = buildStorefrontDocument(SHELL, req({ slug: 'old' }), { kind: 'moved', movedTo: 'new' })
    expect(doc.headers['Cache-Control']).toBe('public, s-maxage=300')
  })
})

describe('an unknown slug', () => {
  it('404s with the untouched shell so the SPA renders its own not-found', () => {
    const doc = buildStorefrontDocument(SHELL, req({ slug: 'gone' }), { kind: 'not-found' })
    expect(doc.status).toBe(404)
    expect(doc.body).toBe(SHELL)
  })
})

describe('a shell this module does not understand', () => {
  it('fails open to the untouched shell', () => {
    const doc = buildStorefrontDocument('<html>no head here</html>', req(), shop())
    expect(doc.status).toBe(200)
    expect(doc.body).toBe('<html>no head here</html>')
  })
})
