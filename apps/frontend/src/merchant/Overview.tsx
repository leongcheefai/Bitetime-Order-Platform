import { useEffect, useMemo, useState } from 'react'
import { ReceiptText, Wallet, Users, TrendingUp, Download, Lock, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { saveBlob } from '../download'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { enGB, zhCN } from 'react-day-picker/locale'
import type { DateRange } from 'react-day-picker'
import { useSession } from '../SessionContext'
import { fetchMerchantStats, downloadRevenueReport } from '../store'
import { SkeletonText } from '../components/Loaders'
import { StatCard, ChartPanel, RevenueBarChart, DonutCard, BreakdownList } from '../components/charts/DashCharts'
import {
  granularityFor, parseCustomRange, todayInZone, DEFAULT_TIMEZONE, MAX_CUSTOM_SPAN_DAYS, REVENUE_RANGES,
  type CustomRangeError, type Granularity, type MerchantStats, type RevenueRange,
} from '@bitetime/shared'
import { selectionSpan, type RevenueSelection } from './revenueRange'
import { toDate, toIso } from './calendarDate'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { formatMoney } from '../currency'
import ShareStorefront from './ShareStorefront'
import ShopAssistant from './ShopAssistant'

const STAT_ICON = { size: 15, strokeWidth: 1.75 }


function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-pill border-[0.5px] px-2.5 py-0.5 pointer-coarse:min-h-9 pointer-coarse:px-3 text-[11px] font-semibold transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-transparent text-muted-foreground hover:text-primary',
      )}
    >
      {children}
    </button>
  )
}

/** The revenue export, as a button on the panel it exports. */
function DownloadReport({ selection, granularity }: { selection: RevenueSelection; granularity: Granularity }) {
  const { t, merchant } = useSession()
  const [busy, setBusy] = useState(false)

  async function download() {
    if (!merchant?.id) return
    setBusy(true)
    const r = await downloadRevenueReport(merchant.id, selection, granularity)
    setBusy(false)
    if (!r.ok) {
      toast.error(r.error.message || t('Could not build the report', '无法生成报表'))
      return
    }
    saveBlob(r.data.blob, r.data.filename ?? (selection.kind === 'custom'
      ? `revenue-${selection.from}_${selection.to}.xlsx`
      : `revenue-${selection.days}d.xlsx`))
  }

  // Icon-only, and built from the same geometry as the Pill above rather than from `Button`:
  // the shared button's smallest size is px-[18px] py-[10px], which next to 11px pills reads as
  // the panel's primary action when it is a quiet affordance on a chart header.
  //
  // The words the icon drops live in the tooltip and in `aria-label`.
  const label = t('Download revenue report', '下载营收报表')
  const hint = busy ? t('Preparing…', '生成中…') : label

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="none"
            aria-label={label}
            disabled={busy}
            onClick={download}
            className={cn(
              'rounded-pill p-1.5 pointer-coarse:p-3',
              'hover:border-primary hover:bg-transparent hover:text-primary',
              'disabled:cursor-default disabled:hover:border-border disabled:hover:text-muted-foreground',
            )}
          />
        }
      >
        {busy
          ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
          : <Download size={14} strokeWidth={1.75} />}
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The merchant's own two dates (#234), behind the pill that offers them.
 *
 * The grid is `ui/calendar` in `mode="range"` and not two `<input type="date">`: the native
 * control renders the browser's own calendar, which reads as a different product than the page
 * around it and cannot show a range at all — a merchant picking a quarter had two boxes and no
 * picture of what they had chosen. One click sets the first day, the next sets the last.
 *
 * Nothing is submitted until Apply: half a range is the ordinary state of picking one, and
 * refetching on the first click would ask the server a question nobody posed. Apply stays
 * disabled until the SHARED rule accepts the pair, so the button and the API's own 400 can never
 * disagree about what a range is.
 */
function CustomRangePill({
  active, today, selection, onApply,
}: {
  active: boolean
  today: string
  selection: RevenueSelection
  onApply: (from: string, to: string) => void
}) {
  const { t, lang } = useSession()
  const [open, setOpen] = useState(false)
  const [range, setRange] = useState<DateRange | undefined>(
    selection.kind === 'custom'
      ? { from: toDate(selection.from), to: toDate(selection.to) }
      : undefined,
  )

  const todayDate = toDate(today)
  // One click into a range is a single day, not an unfinished range: a merchant checking one
  // Saturday's takings should not have to click it twice.
  const from = range?.from ? toIso(range.from) : ''
  const to = range?.to ? toIso(range.to) : from
  const parsed = parseCustomRange(from, to, today)
  // Silent while either box is still empty — that is a range being typed, not a wrong one.
  const problem: CustomRangeError | null = parsed.ok || !from || !to ? null : parsed.reason
  const message: Record<CustomRangeError, string> = {
    bad_date: t('Enter two calendar dates.', '请输入两个日期。'),
    reversed: t('The first date must come before the second.', '开始日期必须早于结束日期。'),
    future: t('Pick a date up to today.', '结束日期不能晚于今天。'),
    too_long: t(`Pick a range of ${MAX_CUSTOM_SPAN_DAYS} days or less.`, `范围最多 ${MAX_CUSTOM_SPAN_DAYS} 天。`),
  }

  function apply() {
    if (!parsed.ok) return
    onApply(parsed.from, parsed.to)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-pressed={active}
            className={cn(
              'rounded-pill border-[0.5px] px-2.5 py-0.5 pointer-coarse:min-h-9 pointer-coarse:px-3 text-[11px] font-semibold transition-colors',
              active
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-transparent text-muted-foreground hover:text-primary',
            )}
          />
        }
      >
        {t('Custom', '自定义')}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-2">
        <div className="flex flex-col gap-2">
          <Calendar
            mode="range"
            required={false}
            selected={range}
            onSelect={setRange}
            locale={lang === 'zh' ? zhCN : enGB}
            defaultMonth={range?.from ?? todayDate}
            // A month dropdown rather than twelve presses of the arrow: the ranges this exists for
            // are quarters and tax years, which are months away from today. Three years back
            // covers any shop on the platform; the ceiling is the shop's today, because there is
            // no revenue past it to report.
            captionLayout="dropdown"
            startMonth={new Date(todayDate.getFullYear() - 3, 0, 1)}
            endMonth={todayDate}
            disabled={{ after: todayDate }}
            aria-label={t('Revenue range', '营收时间范围')}
          />
          <span className={cn('px-1 text-[12px]', problem ? 'text-danger-fg' : 'text-muted-foreground')}>
            {problem
              ? message[problem]
              : parsed.ok
                ? t(`${parsed.from} – ${parsed.to} · ${parsed.days} days`,
                    `${parsed.from} – ${parsed.to} · ${parsed.days}天`)
                : t(`Pick two days, up to ${MAX_CUSTOM_SPAN_DAYS} apart.`,
                    `请选择两天，最多相隔 ${MAX_CUSTOM_SPAN_DAYS} 天。`)}
          </span>
          <Button type="button" size="sm" disabled={!parsed.ok} onClick={apply}>
            {t('Apply', '应用')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default function Overview() {
  const { t, merchant } = useSession()
  const [stats, setStats] = useState<MerchantStats | null>(null)
  const [failed, setFailed] = useState(false)
  const [selection, setSelection] = useState<RevenueSelection>({ kind: 'last', days: 12 })
  // null = follow the default for the range. A merchant who picks a granularity keeps it
  // across range changes: they asked for daily 60 days, so switching to 90 shouldn't
  // silently re-bucket behind them.
  const [granularityChoice, setGranularityChoice] = useState<Granularity | null>(null)
  // The SHOP's today, not the browser's: the range is checked against the shop's civil day on the
  // server, and a merchant reading this abroad must be offered the same last day it will accept.
  // `todayInZone` falls back to DEFAULT_TIMEZONE on an unusable value, which is the same fallback
  // the backend applies to `merchants.timezone` — so both sides agree on the shop's last day.
  const today = useMemo(
    () => todayInZone(merchant?.timezone ?? DEFAULT_TIMEZONE, new Date()),
    [merchant?.timezone],
  )
  const span = selectionSpan(selection, today) ?? 12
  const granularity = granularityChoice ?? granularityFor(span)
  // Aggregates render in the merchant's current currency — safe because currency
  // is locked once ≥1 order exists, so totals never mix units.
  const money = (n: number) => formatMoney(n, merchant?.currency)

  // Every figure here is now computed by the backend, over the shop's WHOLE order history — the
  // browser used to fetch the orders and aggregate them itself, which meant the chart was only
  // ever as complete as PostgREST's row cap allowed and said nothing when it wasn't (#144).
  //
  // So a range or granularity switch is a REFETCH, not a recompute: the orders it would recompute
  // from are no longer here, and shipping them back just to re-bucket them is the thing this
  // change exists to stop.
  //
  // The shop's own zone still decides which day an order falls on — the backend resolves it from
  // `merchants.timezone`, so a merchant reading their chart abroad sees their shop's days.
  useEffect(() => {
    const id = merchant?.id
    if (!id) return
    let active = true
    fetchMerchantStats(id, selection, granularity).then(r => {
      if (!active) return
      // A could-not-ask must NOT render as zeroes. Collapsing failure to empty is exactly how a
      // merchant comes to trust a revenue figure that isn't one, which is the defect behind #144
      // — the row cap was only how it happened.
      if (!r.ok) { setFailed(true); return }
      setFailed(false)
      setStats(r.data)
    })
    return () => { active = false }
  }, [merchant?.id, selection, granularity])

  // One label for all three panel headings. A custom range says its own two dates — under
  // "last 90 days" a merchant reading a window that ended in March has nothing on screen
  // telling them so.
  const rangeLabel = selection.kind === 'custom'
    ? `${selection.from} – ${selection.to}`
    : t(`last ${selection.days} days`, `近${selection.days}天`)

  const statusLabel = (s: string) => ({
    new: t('New', '新订单'), preparing: t('Preparing', '准备中'), ready: t('Ready', '待取'),
    completed: t('Completed', '已完成'), cancelled: t('Cancelled', '已取消'),
  } as Record<string, string>)[s] ?? s

  // Said out loud rather than drawn as an empty chart: a merchant reading zeroes has no way to
  // tell "no sales" from "we could not ask".
  if (failed) return (
    <div className="flex flex-col gap-5">
      <ShareStorefront />
      <div className="rounded-xl border-[0.5px] border-border bg-card px-5 py-6 text-center text-sm text-muted-foreground">
        {t('Could not load your figures. Try again in a moment.', '无法加载数据，请稍后再试。')}
      </div>
    </div>
  )

  if (!stats) return (
    <div className="flex flex-col gap-5">
      <ShareStorefront />
      <div className="grid grid-cols-4 gap-[10px] max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border-[0.5px] border-border bg-card px-5 py-4"><SkeletonText lines={2} /></div>
        ))}
      </div>
      <div className="rounded-xl border-[0.5px] border-border bg-card px-5 py-4"><SkeletonText lines={6} /></div>
    </div>
  )

  return (
    <div className="flex flex-col gap-5">
      <ShareStorefront />
      <div className="grid grid-cols-4 gap-[10px] max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
        <StatCard label={t('Total orders', '总订单')} value={String(stats.totalOrders)} delta={stats.ordersDelta} icon={<ReceiptText {...STAT_ICON} />} />
        <StatCard label={t('Revenue', '营收')} value={money(stats.revenue)} delta={stats.revenueDelta} icon={<Wallet {...STAT_ICON} />} />
        <StatCard label={t('Customers', '顾客')} value={String(stats.customerCount)} icon={<Users {...STAT_ICON} />} />
        <StatCard label={t('Avg order', '平均订单')} value={money(stats.avgOrder)} icon={<TrendingUp {...STAT_ICON} />} />
      </div>

      {/* Between the KPI cards and the charts, deliberately.
          It started below the charts, on the argument that they are the primary surface and this
          is only a shortcut through them. That argument assumed a merchant knows the box is
          there — and below three full-height panels, nobody does. An unused shortcut is worse
          than one placed a little early.
          Still AFTER the headline figures, because a shop owner opening this page came to see
          today's orders, not a question box. And next to those figures rather than in a modal or
          behind a floating button: an answer routinely reconciles itself against the KPI cards
          ("your dashboard's own month-on-month figure reads down 15 percent…"), which the
          merchant can only check if the cards are on screen with it. */}
      <ShopAssistant />

      <ChartPanel
        title={t(`Revenue — ${rangeLabel}`, `营收 — ${rangeLabel}`)}
        legend={
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
            <div className="flex gap-1" role="group" aria-label={t('Chart range', '图表时间范围')}>
              {REVENUE_RANGES.map(d => (
                <Pill
                  key={d}
                  active={selection.kind === 'last' && selection.days === d}
                  onClick={() => setSelection({ kind: 'last', days: d })}
                >
                  {t(`${d}d`, `${d}天`)}
                </Pill>
              ))}
              <CustomRangePill
                active={selection.kind === 'custom'}
                today={today}
                selection={selection}
                onApply={(from, to) => setSelection({ kind: 'custom', from, to })}
              />
            </div>
            <div className="flex gap-1" role="group" aria-label={t('Chart detail', '图表粒度')}>
              <Pill active={granularity === 'day'} onClick={() => setGranularityChoice('day')}>
                {t('Daily', '每日')}
              </Pill>
              <Pill active={granularity === 'week'} onClick={() => setGranularityChoice('week')}>
                {t('Weekly', '每周')}
              </Pill>
            </div>
            <DownloadReport selection={selection} granularity={granularity} />
          </div>
        }
      >
        <RevenueBarChart data={stats.series} revenueLabel={t('Revenue', '营收')} ordersLabel={t('Orders', '订单')} />
      </ChartPanel>

      {/* Both panels cover the range picked above, so both say so — the pills live on the
          revenue chart, and without the label these read as all-time figures beside it. */}
      <div className="grid grid-cols-2 gap-5 max-[900px]:grid-cols-1">
        <ChartPanel title={t(`Revenue by product — ${rangeLabel}`, `产品营收 — ${rangeLabel}`)}>
          <DonutCard data={stats.productRevenue} />
        </ChartPanel>
        <ChartPanel title={t(`Orders by status — ${rangeLabel}`, `订单状态 — ${rangeLabel}`)}>
          <BreakdownList rows={stats.statusBreakdown.map(s => ({ label: statusLabel(s.status), value: String(s.count), pct: s.pct }))} />
        </ChartPanel>
      </div>
    </div>
  )
}
