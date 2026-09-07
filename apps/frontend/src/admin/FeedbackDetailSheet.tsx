import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchFeedbackImage } from '../store'
import type { FeedbackItem } from '../types'
import { CATEGORY_LABELS, formatFeedbackDate } from './feedbackLabels'
import ZoomableImage from '../components/ZoomableImage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'

/**
 * One feedback item in full — the message unclipped, every screenshot, the GitHub link and the
 * one action there is.
 *
 * The inbox used to be a stack of expanded cards, which made triage a scroll through
 * everything: a long message and its screenshots pushed the next shop's report off the screen.
 * The list is a table now, and this is where a row opens. Same split as the merchant's order
 * drawer (OrderDetailSheet), and for the same reason.
 *
 * Deliberately not a ticket view: no assignment, no threading, no reply. If it grows one, that
 * is a separate decision.
 */
export default function FeedbackDetailSheet({
  item,
  onClose,
  onToggleStatus,
  busy,
}: {
  item: FeedbackItem | null
  onClose: () => void
  onToggleStatus: (item: FeedbackItem) => void
  busy: boolean
}) {
  const { t, lang } = useSession()

  return (
    <Sheet open={item !== null} onOpenChange={open => { if (!open) onClose() }}>
      {/* Same width and overflow rules as OrderDetailSheet — see the note there on why each
          class is spelled with its `data-[side=right]` variant. */}
      <SheetContent
        side="right"
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-[560px] gap-0 overflow-hidden"
      >
        {item && (
          <>
            <SheetHeader className="shrink-0 border-b border-border">
              <SheetTitle className="text-[17px] sm:text-[19px]">
                {item.shop_name ?? t('Deleted shop', '已删除的店铺')}
              </SheetTitle>

              <div className="flex items-center gap-2 flex-wrap pt-1.5">
                <Badge variant={CATEGORY_LABELS[item.category].variant}>
                  {t(CATEGORY_LABELS[item.category].en, CATEGORY_LABELS[item.category].zh)}
                </Badge>
                <Badge variant={item.status === 'open' ? 'warn' : 'success'}>
                  {item.status === 'open' ? t('Open', '未处理') : t('Resolved', '已处理')}
                </Badge>
              </div>

              <div className="flex items-center gap-2 flex-wrap pt-1 text-[12px] text-muted-foreground">
                {item.shop_slug && <span>/s/{item.shop_slug}</span>}
                {item.shop_slug && <span aria-hidden="true" className="text-border">·</span>}
                <span>{formatFeedbackDate(item.created_at, lang)}</span>
              </div>
            </SheetHeader>

            <div className="flex-1 min-h-0 overflow-y-auto bg-background flex flex-col gap-4 p-4">
              <p className="text-[14px] leading-[1.6] text-foreground whitespace-pre-wrap">
                {item.message}
              </p>

              {/* Keyed on the feedback id: the drawer stays mounted between rows, so without
                  this the previous row's blob URLs would survive into the next one's gallery. */}
              <FeedbackImages key={item.id} item={item} />

              {item.github_issue_url && (
                <a
                  href={item.github_issue_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] text-primary underline w-fit"
                >
                  {t('View issue', '查看 Issue')} #{item.github_issue_number} ↗
                </a>
              )}

              {item.resolved_at && (
                <p className="text-[12px] text-muted-foreground">
                  {t('Resolved', '已处理')} {formatFeedbackDate(item.resolved_at, lang)}
                </p>
              )}
            </div>

            <div className="shrink-0 border-t border-border bg-card px-4 py-3">
              <Button
                variant={item.status === 'open' ? 'default' : 'outline'}
                className="w-full sm:w-auto"
                disabled={busy}
                onClick={() => onToggleStatus(item)}
              >
                {item.status === 'open' ? t('Resolve', '标记已处理') : t('Reopen', '重新打开')}
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

/**
 * The screenshots on one feedback item. Its own component so the object-URL lifecycle belongs
 * to something that unmounts when the item leaves the drawer.
 *
 * These are AUTHENTICATED fetches, not <img src="…"> against a URL: the `feedback-images`
 * bucket is private with no storage policies, so the bytes only exist behind
 * GET /api/admin/feedback/:feedbackId/images/:index.
 *
 * A thumbnail opens the full image OVER this drawer (ZoomableImage), not in a new tab: a
 * screenshot is a detail of the report being read, and a tab throws the report away to show it.
 */
function FeedbackImages({ item }: { item: FeedbackItem }) {
  const { t } = useSession()
  // `null` is "still fetching"; an array is the settled answer, however many of the fetches
  // actually succeeded. Deriving "loading" from `urls.length < count` instead is what made a
  // single failed fetch sit under a Loading… hint forever — a terminal state wearing a
  // transient state's label.
  const [urls, setUrls] = useState<string[] | null>(null)
  const [failed, setFailed] = useState(0)
  // Paths never change for a given feedback id, so the COUNT plus the id is the whole of what
  // drives this — depending on the array itself would refetch every time a status toggle
  // rebuilds the row object with a fresh array reference.
  const count = item.image_paths.length

  // react-hooks/set-state-in-effect forbids a setState reachable synchronously from an effect
  // body, so every setState here rides a .then callback.
  useEffect(() => {
    let cancelled = false
    const created: string[] = []

    void Promise.all(Array.from({ length: count }, (_, i) => fetchFeedbackImage(item.id, i)))
      .then(results => {
        // Nothing has been created yet at this point, so an unmount here leaks nothing — the
        // cleanup below only ever has to revoke what this branch went on to make.
        if (cancelled) return
        for (const r of results) if (r.ok) created.push(URL.createObjectURL(r.data))
        setUrls(created)
        setFailed(results.filter(r => !r.ok).length)
      })

    return () => {
      cancelled = true
      for (const u of created) URL.revokeObjectURL(u)
    }
  }, [item.id, count])

  if (count === 0) return null

  return (
    <div className="flex flex-wrap gap-2">
      {(urls ?? []).map((url, i) => (
        <ZoomableImage
          key={url}
          src={url}
          alt={t(`Screenshot ${i + 1}`, `截图 ${i + 1}`)}
          triggerClassName="rounded-md overflow-hidden border border-border"
          imgClassName="size-24 object-cover"
        />
      ))}
      {urls === null && (
        <span className="self-center text-[12px] text-muted-foreground">
          {t('Loading screenshots…', '正在加载截图…')}
        </span>
      )}
      {failed > 0 && (
        <span className="self-center text-[12px] text-danger-fg">
          {t(
            `${failed} of ${count} could not be loaded.`,
            `${count} 张截图中有 ${failed} 张无法加载。`,
          )}
        </span>
      )}
    </div>
  )
}
