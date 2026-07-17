import type { Lang } from './types'

/**
 * The date an order was placed, as a customer reads it.
 *
 * One rule, because two customer-facing screens show the same fact: order history and the
 * track-order screen. They disagreed before this existed — history followed the language, track
 * was pinned to English — which is the kind of drift nobody notices until a Chinese customer sees
 * one screen in each language.
 */
export function formatOrderDate(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * The same fact, to the minute — what a receipt states and a list row does not.
 *
 * A sibling rather than an option on `formatOrderDate`, because that function's output is pinned
 * by two screens (order history and /track) that must keep showing a bare date.
 */
export function formatOrderDateTime(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
