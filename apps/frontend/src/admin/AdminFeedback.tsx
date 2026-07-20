import { useEffect, useState } from 'react'
import type { FeedbackStatus } from '@bitetime/shared'
import { useSession } from '../SessionContext'
import { fetchAdminFeedback, setFeedbackStatus } from '../store'
import type { FeedbackItem } from '../types'
import { Card } from '../components/ui/card'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'

const CATEGORY_LABELS: Record<string, { en: string; zh: string }> = {
  bug:     { en: 'Broken',  zh: '故障' },
  feature: { en: 'Request', zh: '建议' },
  billing: { en: 'Billing', zh: '账单' },
  other:   { en: 'Other',   zh: '其他' },
}

/**
 * The superadmin's feedback inbox (#89). Newest-first, with an open-only filter and one
 * button per row to flip open ↔ resolved. Deliberately not a ticket system: no assignment,
 * no threading, no reply. If it grows one, that is a separate decision.
 */
export default function AdminFeedback() {
  const { t, lang } = useSession()
  const [openOnly, setOpenOnly] = useState(true)
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // react-hooks/set-state-in-effect forbids a setState reachable synchronously from an
  // effect body (even through a locally-defined function) — so unlike the rest of this
  // component's calls, every setState here rides a .then/.catch/.finally callback, never
  // the synchronous top of the effect. The "loading" / "error" resets for a *user-driven*
  // refetch happen in the filter button's onClick instead (an event handler, not an effect).
  useEffect(() => {
    let cancelled = false
    fetchAdminFeedback(openOnly ? 'open' : undefined)
      .then(rows => { if (!cancelled) { setItems(rows); setError('') } })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : t('Could not load feedback', '无法加载反馈'))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [openOnly, t])

  const toggle = async (item: FeedbackItem) => {
    const next: FeedbackStatus = item.status === 'open' ? 'resolved' : 'open'
    try {
      const updated = await setFeedbackStatus(item.id, next)
      // Filtering to open means a resolved row no longer belongs in the list.
      setItems(prev => openOnly && next === 'resolved'
        ? prev.filter(row => row.id !== item.id)
        : prev.map(row => (row.id === item.id ? { ...row, ...updated } : row)))
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not update feedback', '无法更新反馈'))
    }
  }

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-MY', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-heading text-[20px] text-oxblood">{t('Feedback', '反馈')}</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setLoading(true); setError(''); setOpenOnly(v => !v) }}
        >
          {openOnly ? t('Show all', '显示全部') : t('Show open only', '仅显示未处理')}
        </Button>
      </div>

      {error && <p className="text-[13px] text-danger-fg">{error}</p>}
      {loading && <p className="text-[13px] text-text-tertiary">{t('Loading…', '加载中…')}</p>}

      {!loading && items.length === 0 && (
        <p className="text-[13px] text-text-tertiary">
          {openOnly
            ? t('No open feedback.', '没有未处理的反馈。')
            : t('No feedback yet.', '还没有反馈。')}
        </p>
      )}

      {items.map(item => (
        <Card key={item.id} className="p-4 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-heading text-[15px] text-oxblood">
              {item.shop_name ?? t('Deleted shop', '已删除的店铺')}
            </span>
            {item.shop_slug && (
              <span className="text-[12px] text-text-tertiary">/s/{item.shop_slug}</span>
            )}
            <Badge variant="secondary">
              {t(CATEGORY_LABELS[item.category]?.en ?? item.category,
                 CATEGORY_LABELS[item.category]?.zh ?? item.category)}
            </Badge>
            {item.status === 'resolved' && (
              <Badge variant="outline">{t('Resolved', '已处理')}</Badge>
            )}
            <span className="ml-auto text-[12px] text-text-tertiary">{formatDate(item.created_at)}</span>
          </div>

          <p className="text-[14px] text-ink whitespace-pre-wrap">{item.message}</p>

          <div>
            <Button variant="outline" size="sm" onClick={() => void toggle(item)}>
              {item.status === 'open' ? t('Resolve', '标记已处理') : t('Reopen', '重新打开')}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  )
}
