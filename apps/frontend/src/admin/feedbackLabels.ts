import type { FeedbackCategory } from '@bitetime/shared'
import type { Lang } from '../types'

// Record<FeedbackCategory, …>, not Record<string, …> — same reasoning as FeedbackForm's
// CATEGORY_LABELS: a fifth category upstream should be a compile error here too, not a
// silent raw-key fallback. Wording is intentionally different (admin-facing vs
// merchant-facing); only the type is shared.
//
// Each category carries its own badge colour so a column of type badges is scannable rather
// than a column of identical grey pills. The two colours the STATUS column already owns are
// off limits here — amber is Open and green is Resolved, and a type badge wearing either
// would read as a status.
export const CATEGORY_LABELS: Record<
  FeedbackCategory,
  { en: string; zh: string; variant: 'danger' | 'info' | 'default' | 'secondary' }
> = {
  bug:     { en: 'Broken',  zh: '故障', variant: 'danger' },
  feature: { en: 'Request', zh: '建议', variant: 'info' },
  billing: { en: 'Billing', zh: '账单', variant: 'default' },
  other:   { en: 'Other',   zh: '其他', variant: 'secondary' },
}

// The list and the detail drawer show the same timestamp, so they read it the same way.
export function formatFeedbackDate(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-MY', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
