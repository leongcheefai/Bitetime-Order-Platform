import { pinyin } from 'pinyin-pro'

// True if the string contains any CJK ideograph.
function hasCJK(s) {
  return /[一-鿿]/.test(s)
}

export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function toSlugBase(name) {
  const raw = String(name ?? '')
  if (!hasCJK(raw)) return slugify(raw)
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

export function resolveSlug(name, { taken = [], id = '' } = {}) {
  const base = toSlugBase(name) || `shop-${id.replace(/-/g, '').slice(0, 6)}`
  const used = new Set(taken)
  const blocked = (s) => used.has(s) || RESERVED_SLUGS.includes(s)
  if (!blocked(base)) return base
  let n = 2
  while (blocked(`${base}-${n}`)) n++
  return `${base}-${n}`
}
