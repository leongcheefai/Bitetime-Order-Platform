import { useState } from 'react'
import { useSession } from '../SessionContext'
import { setOrderStatus, setOrderNote, setOrderTracking } from '../store'
import { formatMoney } from '../currency'
import { formatAddress } from '../address'
import { formatCalendarDate } from '../orderDate'
import { fmtDateTime } from '../merchantDate'
import { formatTaxRate } from '../receipt'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { COURIERS, trackingUrl, courierName } from '../couriers'
import { ORDER_STATUSES, STATUS_LABELS, StatusBadge } from '../orderStatus'
import { fulfilmentLabel } from '../fulfilmentLabel'
import WaLink from './WaLink'

// 11px semibold uppercase rose-muted label.
const LBL = 'text-[11px] font-semibold uppercase tracking-[0.06em] text-rose-muted shrink-0'

// Self-contained select classes (pixel-match of .admin-field-select).
const SELECT_CLS =
  'w-full py-[7px] pl-[10px] pr-[32px] border border-clay-border rounded-sm text-[13px] ' +
  'bg-cream text-ink font-sans appearance-none bg-no-repeat cursor-pointer min-w-[140px] ' +
  'focus:outline-none focus:border-oxblood focus:shadow-[0_0_0_2px_rgba(122,16,40,0.1)]'

const CHEVRON_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%237A4F55' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`

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

// The order-detail drawer, shared by OrdersView and CustomersView. Open when
// `order` is non-null; owns its own note/courier/awb drafts and bubbles every
// status/note/tracking save up via `onOrderUpdated` so the parent can patch its
// own list.
export default function OrderDetailSheet({
  order,
  onClose,
  onOrderUpdated,
  readOnly = false,
}: {
  order: any | null
  onClose: () => void
  onOrderUpdated: (o: any) => void
  readOnly?: boolean
}) {
  const { t, lang, merchant } = useSession()
  const [noteDraft, setNoteDraft] = useState('')
  const [drawerFor, setDrawerFor] = useState<string | undefined>(undefined)
  const [savingNote, setSavingNote] = useState(false)
  const [courierDraft, setCourierDraft] = useState('')
  const [awbDraft, setAwbDraft] = useState('')
  const [savingTrack, setSavingTrack] = useState(false)

  // Re-seed the drafts when a different order opens (adjust-state-during-render:
  // keyed on id so a status/note/tracking patch that replaces `order` mid-view
  // keeps typing).
  if (order && order.id !== drawerFor) {
    setDrawerFor(order.id)
    setNoteDraft(order.note ?? '')
    setCourierDraft(order.courier ?? '')
    setAwbDraft(order.awb ?? '')
  }

  function handleStatusChange(o: any, status: string) {
    setOrderStatus(o.id, status, merchant!.id).then(onOrderUpdated).catch(() => {
      toast.error(t('Could not update order status.', '无法更新订单状态。'))
    })
  }

  function handleNoteSave() {
    if (!order) return
    setSavingNote(true)
    setOrderNote(order.id, noteDraft, merchant!.id).then(updated => {
      onOrderUpdated(updated)
      toast.success(t('Note saved', '备注已保存'))
    }).catch(() => {
      toast.error(t('Could not save note.', '无法保存备注。'))
    }).finally(() => setSavingNote(false))
  }

  function handleTrackingSave() {
    if (!order) return
    setSavingTrack(true)
    setOrderTracking(order.id, courierDraft || null, awbDraft, merchant!.id).then(updated => {
      onOrderUpdated(updated)
      toast.success(t('Tracking saved', '物流已保存'))
    }).catch(() => {
      toast.error(t('Could not save tracking.', '无法保存物流。'))
    }).finally(() => setSavingTrack(false))
  }

  const orderCurrency = order?.currency ?? merchant?.currency
  const noteDirty = order != null && noteDraft.trim() !== (order.note ?? '')
  const trackDirty = order != null &&
    (courierDraft !== (order.courier ?? '') || awbDraft.trim() !== (order.awb ?? ''))

  return (
    <Sheet open={order !== null} onOpenChange={open => { if (!open) { onClose(); setDrawerFor(undefined) } }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        {order && (
          <>
            <SheetHeader className="border-b border-surface-sunken">
              <div className="flex items-center gap-[10px] flex-wrap">
                <SheetTitle className="text-[15px]">{order.order_number || '—'}</SheetTitle>
                <StatusBadge status={order.status || 'new'} t={t} />
              </div>
              <span className="text-[12px] text-text-tertiary">{fmtDateTime(order.created_at)}</span>
            </SheetHeader>

            <div className="flex flex-col px-4 pb-4">
              {/* Customer */}
              <Section title={t('Customer', '顾客')}>
                <span className="text-[14px] font-medium text-ink">{order.customer_name || '—'}</span>
                {order.customer_wa && (
                  <span className="text-[13px] w-fit"><WaLink wa={order.customer_wa} /></span>
                )}
              </Section>

              {/* Items + totals */}
              <Section title={t('Items', '商品')}>
                <ul className="flex flex-col gap-1.5">
                  {(order.items ?? []).map((it: any, i: number) => (
                    // Index key, deliberately not id: a split promo puts two lines with the
                    // SAME product id in `items` (base half + promo half), and keying by id
                    // would collapse them into one row on screen while charging for both.
                    <li key={i} className="flex justify-between gap-3 text-[13px] text-ink">
                      <span className="min-w-0 break-words">
                        <span className="text-rose-muted tabular-nums">{it.qty}×</span> {it.name}
                        {/* `it.promo` missing (rows written before I-2) reads as false, not a crash. */}
                        {it.promo && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-oxblood text-white text-[10px] leading-[14px] font-medium align-middle">
                            {t('Promo', '优惠')}
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums text-text-secondary whitespace-nowrap">
                        {formatMoney((it.price ?? 0) * (it.qty ?? 0), orderCurrency)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-col gap-1 pt-2 mt-1 border-t border-dashed border-clay-border text-[13px]">
                  {order.shipping_fee != null && (
                    <div className="flex justify-between">
                      {/* The dashboard keeps its own word for this ("Shipping"), which is the
                          merchant's, not the customer's — only the DISTANCE is added here. The
                          stored value labels it, never a re-derivation: null (region-priced, or
                          placed before #101) prints the plain label, never `0.0 km`. */}
                      <span className="text-rose-muted">
                        {order.delivery_distance_km != null
                          ? t(`Shipping (${Number(order.delivery_distance_km).toFixed(1)} km)`,
                              `运费（${Number(order.delivery_distance_km).toFixed(1)} 公里）`)
                          : t('Shipping', '运费')}
                      </span>
                      <span className="tabular-nums text-ink">{formatMoney(order.shipping_fee, orderCurrency)}</span>
                    </div>
                  )}
                  {order.discount != null && order.discount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-rose-muted">
                        {t('Discount', '折扣')}{order.voucher_code ? ` (${order.voucher_code})` : ''}
                      </span>
                      <span className="tabular-nums text-ink">−{formatMoney(order.discount, orderCurrency)}</span>
                    </div>
                  )}
                  {order.tax_rate != null && order.tax_rate > 0 && (
                    <div className="flex justify-between">
                      <span className="text-rose-muted">{t('Tax', '税')} ({formatTaxRate(order.tax_rate)}%)</span>
                      <span className="tabular-nums text-ink">{formatMoney(order.tax ?? 0, orderCurrency)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-medium">
                    <span className="text-ink">{t('Total', '总计')}</span>
                    <span className="tabular-nums text-oxblood">{formatMoney(order.total, orderCurrency)}</span>
                  </div>
                </div>
              </Section>

              {/* Fulfilment */}
              <Section title={t('Fulfilment', '配送')}>
                <DetailRow label={t('Mode', '方式')}>{fulfilmentLabel(order.mode, t)}</DetailRow>
                {order.region && <DetailRow label={t('Region', '地区')}>{order.region}</DetailRow>}
                {order.address && <DetailRow label={t('Address', '地址')}>{formatAddress(order.address)}</DetailRow>}
                {/* The date the CUSTOMER asked for — what the merchant is scheduling around —
                    not `created_at` above, which is when the order was placed. Shown as `—`
                    rather than omitted for a legacy order: a missing row here would read as
                    "this order has no fulfilment info" rather than "placed before #91". */}
                <DetailRow label={t('Date', '日期')}>
                  {order.fulfil_date ? formatCalendarDate(order.fulfil_date, lang) : '—'}
                </DetailRow>
                {!(order.mode === 'delivery' && !readOnly) && order.courier && (
                  <DetailRow label={t('Courier', '快递公司')}>{courierName(order.courier) || order.courier}</DetailRow>
                )}
                {!(order.mode === 'delivery' && !readOnly) && order.awb && (
                  <DetailRow label={t('AWB', '运单号')}>{order.awb}</DetailRow>
                )}
              </Section>

              {/* Delivery tracking — merchant enters courier + AWB (delivery orders only) */}
              {order.mode === 'delivery' && !readOnly && (
                <Section title={t('Delivery tracking', '物流追踪')}>
                  <div className="flex flex-col gap-1">
                    <label className={LBL} htmlFor={`courier-${order.id}`}>{t('Courier', '快递公司')}</label>
                    <select
                      id={`courier-${order.id}`}
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
                    <label className={LBL} htmlFor={`awb-${order.id}`}>{t('AWB / Tracking no.', '运单号')}</label>
                    <Input
                      id={`awb-${order.id}`}
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
                order.note && (
                  <Section title={t('Note', '备注')}>
                    <p className="rounded-md bg-cream border border-clay-border px-3 py-2 text-[13px] text-ink break-words">
                      {order.note}
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
                    id={`status-${order.id}`}
                    className={SELECT_CLS}
                    style={{ backgroundImage: CHEVRON_SVG, backgroundPosition: 'right 10px center' }}
                    value={order.status || 'new'}
                    onChange={e => handleStatusChange(order, e.target.value)}
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
  )
}
