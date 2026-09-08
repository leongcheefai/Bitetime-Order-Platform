import { useSession } from '../../SessionContext'
import { cn } from '@/lib/utils'
import { fmtDate, fmtTime } from '../../merchantDate'
import DrawerCard from './DrawerCard'
import { orderEventLine } from './orderEventLine'
import type { OrderEvent } from '@bitetime/shared'
import type { Order } from '../../types'

type Line =
  | { key: string; at: string; text: string }
  | { key: string; gap: true; text: string }

/**
 * The order log (#268) as a parcel-tracker timeline — NEWEST FIRST, one small dot per event on a
 * thin rail, the sentence beside it and "date at time" beneath in a muted line. The latest event
 * is the ringed dot at the top, which is where a merchant opening the drawer looks for "what
 * happened last". Read-only, always: the log is written by the backend with the action that
 * caused it (ADR 0025), and the merchant can neither edit nor clear it.
 *
 * An order placed before the log has no `created` event. Its bottom node is read off the order's
 * own `created_at` — a fact the row already holds, not an invented event — and the stretch of
 * rail above it is dashed beside a muted line saying nothing before the log began was recorded.
 * `events` is null while the log is loading and `'failed'` when the read did not come back —
 * shown as its own line, because an empty log and a log that could not be read look identical
 * and only one of them is true.
 */
export default function LogCard({ order, events }: { order: Order; events: OrderEvent[] | null | 'failed' }) {
  const { t } = useSession()

  const loaded = Array.isArray(events) ? events : null
  const hasCreated = loaded?.some(e => e.kind === 'created') ?? true
  const lines: Line[] = []
  for (const e of loaded ?? []) lines.push({ key: e.id, at: e.created_at, text: orderEventLine(e, t) })
  lines.reverse()
  if (loaded && !hasCreated && order.created_at) {
    lines.push({ key: 'gap', gap: true, text: t('Changes before the log began were not recorded', '日志开始前的变更未被记录') })
    lines.push({ key: 'placed', at: order.created_at, text: t('Order placed', '已下单') })
  }

  return (
    <DrawerCard title={t('Log', '日志')}>
      {events === null ? (
        <p className="text-[13px] text-muted-foreground">{t('Loading…', '加载中…')}</p>
      ) : events === 'failed' ? (
        <p role="alert" className="text-[13px] text-danger-fg">{t('Could not load the log.', '无法加载日志。')}</p>
      ) : lines.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('Nothing recorded yet.', '尚无记录。')}</p>
      ) : (
        <ol className="flex flex-col" aria-label={t('Order log', '订单日志')}>
          {lines.map((l, i) => {
            const last = i === lines.length - 1
            const gap = 'gap' in l
            // The rail is one segment per row, behind the size-3 (12px) dots at their horizontal
            // centre (5.5px). A dot's segment starts at its own centre — 4px of top offset plus
            // 6px — and runs 10px past the row's bottom to the NEXT dot's centre; the last row
            // draws none, so the rail ends on a dot. The segments touching the "not recorded"
            // row are dashed: the storefront tracker's idiom for a stretch the data does not cover.
            const dashed = gap || ('gap' in (lines[i + 1] ?? {}))
            return (
              <li key={l.key} className={cn('relative flex gap-3', !last && 'pb-4')}>
                {!last && (
                  <span
                    aria-hidden
                    className={cn(
                      'absolute left-[5.5px] -bottom-2.5 w-px',
                      gap ? 'top-0' : 'top-2.5',
                      dashed ? 'border-l border-dashed border-border' : 'bg-border',
                    )}
                  />
                )}
                {gap ? (
                  <>
                    <span aria-hidden className="size-3 shrink-0" />
                    <span className="min-w-0 flex-1 text-[12px] italic text-muted-foreground">{l.text}</span>
                  </>
                ) : (
                  <>
                    <span
                      aria-hidden
                      className={cn(
                        'relative z-[1] mt-1 size-3 shrink-0 rounded-pill bg-card',
                        i === 0 ? 'border-2 border-primary' : 'border-[1.5px] border-ink-300',
                      )}
                    />
                    <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                      <span className={cn('text-[13px] leading-5 text-foreground', i === 0 && 'font-medium')}>{l.text}</span>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {t(`${fmtDate(l.at)} at ${fmtTime(l.at)}`, `${fmtDate(l.at)} ${fmtTime(l.at)}`)}
                      </span>
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </DrawerCard>
  )
}
