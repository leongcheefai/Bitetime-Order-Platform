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
