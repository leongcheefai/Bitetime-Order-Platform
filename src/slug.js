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
  const latinised = hasCJK(raw)
    ? pinyin(raw, { toneType: 'none', type: 'array' }).join(' ') + ' ' + raw.replace(/[一-鿿]+/g, ' ')
    : raw
  return slugify(latinised)
}
