import { useEffect, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useSession } from '../SessionContext'
import { fetchMerchantOrders, setOrderStatus, setOrderNote, setOrderTracking } from '../store'
import { formatMoney } from '../currency'
import { formatAddress } from '../address'
import { SkeletonText } from '../components/Loaders'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { DataTable, SortableHeader } from '@/components/ui/data-table'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { COURIERS, trackingUrl, courierName } from '../couriers'
import { ORDER_STATUSES, STATUS_LABELS, StatusBadge } from '../orderStatus'

// Delivery mode → display label. Unknown modes fall back to capitalized raw.
const MODE_LABELS: Record<string, { en: string; zh: string }> = {
  pickup:   { en: 'Pickup',   zh: '自取' },
  delivery: { en: 'Delivery', zh: '送货' },
  sameday:  { en: 'Same-day', zh: '当日送达' },
}

function modeLabel(mode: string | null | undefined, t: (en: string, zh: string) => string) {
  if (!mode) return '—'
  const m = MODE_LABELS[mode]
  return m ? t(m.en, m.zh) : mode.charAt(0).toUpperCase() + mode.slice(1)
}

// 11px semibold uppercase rose-muted label.
const LBL = 'text-[11px] font-semibold uppercase tracking-[0.06em] text-rose-muted shrink-0'

// Self-contained select classes (pixel-match of .admin-field-select).
const SELECT_CLS =
  'w-full py-[7px] pl-[10px] pr-[32px] border border-clay-border rounded-sm text-[13px] ' +
  'bg-cream text-ink font-sans appearance-none bg-no-repeat cursor-pointer min-w-[140px] ' +
  'focus:outline-none focus:border-oxblood focus:shadow-[0_0_0_2px_rgba(122,16,40,0.1)]'

const CHEVRON_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%237A4F55' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`

function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-MY', { dateStyle: 'short', timeStyle: 'short' })
}

// Handlers + language + currency ride on table.options.meta so the column defs
// stay stable (defined once) and never reset sorting when the data refetches.
interface OrderTableMeta {
  t: (en: string, zh: string) => string
  currency?: string
}

const columns: ColumnDef<any>[] = [
  {
    accessorKey: 'order_number',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as OrderTableMeta).t('Order #', '订单号')} />
    ),
    cell: ({ row }) => (
      <span className="font-heading text-[14px] font-medium text-oxblood whitespace-nowrap">
        {row.original.order_number || '—'}
      </span>
    ),
  },
  {
    accessorKey: 'created_at',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as OrderTableMeta).t('Time', '时间')} />
    ),
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-text-tertiary">{fmtTime(row.original.created_at)}</span>
    ),
  },
  {
    accessorKey: 'customer_name',
    header: ({ table }) => (
      <span>{(table.options.meta as OrderTableMeta).t('Customer', '顾客')}</span>
    ),
    cell: ({ row }) => <span>{row.original.customer_name || '—'}</span>,
  },
  {
    accessorKey: 'total',
    header: ({ column, table }) => (
      <div className="text-right">
        <SortableHeader column={column} label={(table.options.meta as OrderTableMeta).t('Total', '总计')} />
      </div>
    ),
    cell: ({ row, table }) => {
      const meta = table.options.meta as OrderTableMeta
      return (
        <div className="text-right whitespace-nowrap font-medium">
          {formatMoney(row.original.total, row.original.currency ?? meta.currency)}
        </div>
      )
    },
  },
  {
    accessorKey: 'mode',
    header: ({ table }) => (
      <span>{(table.options.meta as OrderTableMeta).t('Mode', '方式')}</span>
    ),
    cell: ({ row, table }) => (
      <span>{modeLabel(row.original.mode, (table.options.meta as OrderTableMeta).t)}</span>
    ),
  },
  {
    accessorKey: 'status',
    enableSorting: false,
    header: ({ table }) => (
      <span>{(table.options.meta as OrderTableMeta).t('Status', '状态')}</span>
    ),
    cell: ({ row, table }) => (
      <StatusBadge status={row.original.status || 'new'} t={(table.options.meta as OrderTableMeta).t} />
    ),
  },
]

// A labelled key/value line in the detail sheet — label in a fixed left column,
// value aligned in the right column so rows scan like a receipt.
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] gap-x-3 items-baseline text-[13px]">
      <span className={LBL}>{label}</span>
      <span className="min-w-0 break-words text-ink">{children}</span>
    </div>
  )
}

// A visually separated group in the detail sheet. Sections after the first get a
// top divider + spacing; an optional caption heads the group.
function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 pt-4 mt-4 border-t border-surface-sunken first:pt-0 first:mt-0 first:border-t-0">
      {title && <span className={LBL}>{title}</span>}
      {children}
    </section>
  )
}

export default function OrdersView({ readOnly = false }: { readOnly?: boolean } = {}) {
  const { t, merchant } = useSession()
  const [orders, setOrders] = useState<any[] | null>(null)
  const [selected, setSelected] = useState<any | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [drawerFor, setDrawerFor] = useState<string | undefined>(undefined)
  const [savingNote, setSavingNote] = useState(false)
  const [courierDraft, setCourierDraft] = useState('')
  const [awbDraft, setAwbDraft] = useState('')
  const [savingTrack, setSavingTrack] = useState(false)

  useEffect(() => {
    fetchMerchantOrders(merchant!.id).then(setOrders)
  }, [merchant!.id])

  // Re-seed the drawer's editable drafts (note, courier, awb) when a different order
  // opens (adjust-state-during-render: keyed on id so a status/note/tracking patch that
  // replaces `selected` mid-view keeps typing).
  if (selected && selected.id !== drawerFor) {
    setDrawerFor(selected.id)
    setNoteDraft(selected.note ?? '')
    setCourierDraft(selected.courier ?? '')
    setAwbDraft(selected.awb ?? '')
  }

  function patchOrder(updated: any) {
    setOrders(prev => (prev ? prev.map(o => (o.id === updated.id ? updated : o)) : prev))
    setSelected((cur: any) => (cur && cur.id === updated.id ? updated : cur))
  }

  function handleStatusChange(order: any, status: string) {
    setOrderStatus(order.id, status).then(patchOrder).catch(() => {
      toast.error(t('Could not update order status.', '无法更新订单状态。'))
    })
  }

  function handleNoteSave() {
    if (!selected) return
    setSavingNote(true)
    setOrderNote(selected.id, noteDraft).then(updated => {
      patchOrder(updated)
      toast.success(t('Note saved', '备注已保存'))
    }).catch(() => {
      toast.error(t('Could not save note.', '无法保存备注。'))
    }).finally(() => setSavingNote(false))
  }

  function handleTrackingSave() {
    if (!selected) return
    setSavingTrack(true)
    setOrderTracking(selected.id, courierDraft || null, awbDraft).then(updated => {
      patchOrder(updated)
      toast.success(t('Tracking saved', '物流已保存'))
    }).catch(() => {
      toast.error(t('Could not save tracking.', '无法保存物流。'))
    }).finally(() => setSavingTrack(false))
  }

  const meta: OrderTableMeta = { t, currency: merchant?.currency }
  const orderCurrency = selected?.currency ?? merchant?.currency
  const noteDirty = selected != null && noteDraft.trim() !== (selected.note ?? '')
  const trackDirty = selected != null &&
    (courierDraft !== (selected.courier ?? '') || awbDraft.trim() !== (selected.awb ?? ''))

  if (orders === null) {
    return (
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
        <SkeletonText lines={4} />
      </div>
    )
  }

  return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
      <DataTable
        columns={columns}
        data={orders}
        meta={meta}
        onRowClick={setSelected}
        pageSize={15}
        searchPlaceholder={t('Search orders…', '搜索订单…')}
        emptyText={t('No orders yet.', '暂无订单。')}
        prevLabel={t('Previous', '上一页')}
        nextLabel={t('Next', '下一页')}
      />

      <Sheet open={selected !== null} onOpenChange={open => { if (!open) { setSelected(null); setDrawerFor(undefined) } }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          {selected && (
            <>
              <SheetHeader className="border-b border-surface-sunken">
                <div className="flex items-center gap-[10px] flex-wrap">
                  <SheetTitle className="text-[15px]">{selected.order_number || '—'}</SheetTitle>
                  <StatusBadge status={selected.status || 'new'} t={t} />
                </div>
                <span className="text-[12px] text-text-tertiary">{fmtTime(selected.created_at)}</span>
              </SheetHeader>

              <div className="flex flex-col px-4 pb-4">
                {/* Customer */}
                <Section title={t('Customer', '顾客')}>
                  <span className="text-[14px] font-medium text-ink">{selected.customer_name || '—'}</span>
                  {selected.customer_wa && (
                    <a
                      href={`https://wa.me/${selected.customer_wa.replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] text-oxblood no-underline font-medium hover:underline w-fit"
                    >
                      {selected.customer_wa}
                    </a>
                  )}
                </Section>

                {/* Items + totals */}
                <Section title={t('Items', '商品')}>
                  <ul className="flex flex-col gap-1.5">
                    {(selected.items ?? []).map((it: any, i: number) => (
                      <li key={i} className="flex justify-between gap-3 text-[13px] text-ink">
                        <span className="min-w-0 break-words">
                          <span className="text-rose-muted tabular-nums">{it.qty}×</span> {it.name}
                        </span>
                        <span className="tabular-nums text-text-secondary whitespace-nowrap">
                          {formatMoney((it.price ?? 0) * (it.qty ?? 0), orderCurrency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-col gap-1 pt-2 mt-1 border-t border-dashed border-clay-border text-[13px]">
                    {selected.shipping_fee != null && (
                      <div className="flex justify-between">
                        <span className="text-rose-muted">{t('Shipping', '运费')}</span>
                        <span className="tabular-nums text-ink">{formatMoney(selected.shipping_fee, orderCurrency)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-medium">
                      <span className="text-ink">{t('Total', '总计')}</span>
                      <span className="tabular-nums text-oxblood">{formatMoney(selected.total, orderCurrency)}</span>
                    </div>
                  </div>
                </Section>

                {/* Fulfilment */}
                <Section title={t('Fulfilment', '配送')}>
                  <DetailRow label={t('Mode', '方式')}>{modeLabel(selected.mode, t)}</DetailRow>
                  {selected.region && <DetailRow label={t('Region', '地区')}>{selected.region}</DetailRow>}
                  {selected.address && <DetailRow label={t('Address', '地址')}>{formatAddress(selected.address)}</DetailRow>}
                  {selected.preferred_date && (
                    <DetailRow label={t('Date', '日期')}>{selected.preferred_date}</DetailRow>
                  )}
                  {!(selected.mode === 'delivery' && !readOnly) && selected.courier && (
                    <DetailRow label={t('Courier', '快递公司')}>{courierName(selected.courier) || selected.courier}</DetailRow>
                  )}
                  {!(selected.mode === 'delivery' && !readOnly) && selected.awb && (
                    <DetailRow label={t('AWB', '运单号')}>{selected.awb}</DetailRow>
                  )}
                </Section>

                {/* Delivery tracking — merchant enters courier + AWB (delivery orders only) */}
                {selected.mode === 'delivery' && !readOnly && (
                  <Section title={t('Delivery tracking', '物流追踪')}>
                    <div className="flex flex-col gap-1">
                      <label className={LBL} htmlFor={`courier-${selected.id}`}>{t('Courier', '快递公司')}</label>
                      <select
                        id={`courier-${selected.id}`}
                        className={SELECT_CLS}
                        style={{ backgroundImage: CHEVRON_SVG, backgroundPosition: 'right 10px center' }}
                        value={courierDraft}
                        onChange={e => setCourierDraft(e.target.value)}
                      >
                        <option value="">{t('Select courier…', '选择快递…')}</option>
                        {COURIERS.map(c => (
                          <option key={c.code} value={c.code}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className={LBL} htmlFor={`awb-${selected.id}`}>{t('AWB / Tracking no.', '运单号')}</label>
                      <Input
                        id={`awb-${selected.id}`}
                        value={awbDraft}
                        onChange={e => setAwbDraft(e.target.value)}
                        placeholder={t('e.g. 630123456789', '例如 630123456789')}
                        className="text-[13px] bg-cream border-clay-border"
                      />
                    </div>
                    {trackingUrl(courierDraft, awbDraft) && (
                      <a
                        href={trackingUrl(courierDraft, awbDraft)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[13px] text-oxblood font-medium hover:underline w-fit"
                      >
                        {t('Preview track link →', '预览追踪链接 →')}
                      </a>
                    )}
                    <Button
                      type="button"
                      size="none"
                      className="self-end rounded-pill py-[6px] px-[14px] text-[13px]"
                      disabled={!trackDirty || savingTrack}
                      onClick={handleTrackingSave}
                    >
                      {savingTrack ? t('Saving…', '保存中…') : t('Save tracking', '保存物流')}
                    </Button>
                  </Section>
                )}

                {/* Note — editable for the live merchant view, read-only when suspended */}
                {readOnly ? (
                  selected.note && (
                    <Section title={t('Note', '备注')}>
                      <p className="rounded-md bg-cream border border-clay-border px-3 py-2 text-[13px] text-ink break-words">
                        {selected.note}
                      </p>
                    </Section>
                  )
                ) : (
                  <Section title={t('Note', '备注')}>
                    <Textarea
                      value={noteDraft}
                      onChange={e => setNoteDraft(e.target.value)}
                      rows={3}
                      placeholder={t('Add a note for this order…', '为此订单添加备注…')}
                      className="text-[13px] bg-cream border-clay-border resize-none"
                    />
                    <Button
                      type="button"
                      size="none"
                      className="self-end rounded-pill py-[6px] px-[14px] text-[13px]"
                      disabled={!noteDirty || savingNote}
                      onClick={handleNoteSave}
                    >
                      {savingNote ? t('Saving…', '保存中…') : t('Save note', '保存备注')}
                    </Button>
                  </Section>
                )}

                {/* Status control */}
                {!readOnly && (
                  <Section title={t('Status', '状态')}>
                    <select
                      id={`status-${selected.id}`}
                      className={SELECT_CLS}
                      style={{ backgroundImage: CHEVRON_SVG, backgroundPosition: 'right 10px center' }}
                      value={selected.status || 'new'}
                      onChange={e => handleStatusChange(selected, e.target.value)}
                    >
                      {ORDER_STATUSES.map(s => (
                        <option key={s} value={s}>{t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}</option>
                      ))}
                    </select>
                  </Section>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
