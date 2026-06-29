// pinyin-pro carries a ~1MB dictionary and is only needed to transliterate
// Chinese shop names at signup, so it's dynamically imported on demand
// (see toSlugBase) to keep it out of the core bundle every visitor loads.

// True if the string contains any CJK ideograph.
function hasCJK(s: string) {
  return /[一-鿿]/.test(s)
}

export function slugify(name: string) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Async: latin names resolve fast; CJK names lazily load the (large) pinyin-pro
// dictionary via dynamic import, so it stays out of every route's bundle and
// only downloads when a Chinese shop name is actually slugged.
export async function toSlugBase(name: string) {
  const raw = String(name ?? '')
  if (!hasCJK(raw)) return slugify(raw)
  const { pinyin } = await import('pinyin-pro')
  const latinised = raw.replace(/[一-鿿]+/g, match =>
    pinyin(match, { toneType: 'none', separator: ' ' })
  )
  return slugify(latinised)
}

// Every top-level route segment the router owns must be reserved here.
export const RESERVED_SLUGS = [
  's', 'admin', 'api', 'merchant', 'app', 'www', 'auth',
  'login', 'signup', 'account', 'static', 'assets',
]

export async function resolveSlug(name: string, { taken = [], id = '' }: { taken?: string[]; id?: string } = {}) {
  const base = (await toSlugBase(name)) || `shop-${id.replace(/-/g, '').slice(0, 6)}`
  const used = new Set(taken)
  const blocked = (s: string) => used.has(s) || RESERVED_SLUGS.includes(s)
  if (!blocked(base)) return base
  let n = 2
  while (blocked(`${base}-${n}`)) n++
  return `${base}-${n}`
}
