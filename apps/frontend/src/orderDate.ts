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
