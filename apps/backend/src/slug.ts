// Server-side slug resolution. Ported verbatim from apps/frontend/src/slug.ts +
// orderPrefix.ts + referralCode.ts (and referralCodeOf from store.ts) so the backend
// produces byte-identical slugs to the frontend.
// pinyin-pro is imported eagerly here (no browser bundle to keep lean).
import { pinyin } from 'pinyin-pro'

function hasCJK(s: string) {
  return /[一-鿿]/.test(s)
}

export function slugify(name: string) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function toSlugBase(name: string) {
  const raw = String(name ?? '')
  if (!hasCJK(raw)) return slugify(raw)
  const latinised = raw.replace(/[一-鿿]+/g, match =>
    pinyin(match, { toneType: 'none', separator: ' ' }),
  )
  return slugify(latinised)
}

export const RESERVED_SLUGS = [
  's', 'admin', 'api', 'merchant', 'app', 'www', 'auth',
  'login', 'signup', 'account', 'static', 'assets',
]

export async function resolveSlug(name: string, { taken = [], id = '' }: { taken?: string[]; id?: string } = {}) {
  const base = toSlugBase(name) || `shop-${id.replace(/-/g, '').slice(0, 6)}`
  const used = new Set(taken)
  const blocked = (s: string) => used.has(s) || RESERVED_SLUGS.includes(s)
  if (!blocked(base)) return base
  let n = 2
  while (blocked(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function orderPrefix(slug: string) {
  const alnum = String(slug ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return alnum.length >= 2 ? alnum.slice(0, 2) : 'SH'
}

export function referralCodeOf(userId: string) {
  return (userId || '').replace(/-/g, '').slice(0, 8).toUpperCase()
}

function normalizeReferralCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase()
  return /^[0-9A-F]{8}$/.test(code) ? code : null
}

export function resolveReferredByCode(raw: string | null | undefined, ownerCode: string): string | null {
  const code = normalizeReferralCode(raw)
  if (!code) return null
  return code === ownerCode ? null : code
}
