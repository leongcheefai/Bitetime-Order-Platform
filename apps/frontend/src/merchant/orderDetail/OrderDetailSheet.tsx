import { useEffect, useState } from 'react'
import type { OrderEvent } from '@bitetime/shared'
import { useSession } from '../../SessionContext'
import { setOrderStatus, setOrderNote, setOrderTracking, setOrderFulfilDate, fetchOrderEvents } from '../../store'
import { toast } from 'sonner'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import OrderHeader from './OrderHeader'
import StatusFooter from './StatusFooter'
import ItemsCard from './ItemsCard'
import PaymentCard from './PaymentCard'
import InvoiceCard from './InvoiceCard'
import CustomerCard from './CustomerCard'
import TrackingCard from './TrackingCard'
import NoteCard from './NoteCard'
import ReviewCard from './ReviewCard'
import LogCard from './LogCard'

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
  const { t, merchant } = useSession()
  const [noteDraft, setNoteDraft] = useState('')
  const [drawerFor, setDrawerFor] = useState<string | undefined>(undefined)
  const [savingNote, setSavingNote] = useState(false)
  const [courierDraft, setCourierDraft] = useState('')
  const [awbDraft, setAwbDraft] = useState('')
  const [savingTrack, setSavingTrack] = useState(false)
  const [dateDraft, setDateDraft] = useState('')
  const [savingDate, setSavingDate] = useState(false)
  // The order log (#268). Null while loading; keyed on the order id below so a different order
  // never shows the previous one's lines. Every write in this drawer returns the events it
  // recorded, and they are appended here rather than refetched — the same "patch your own row
  // from the response" rule the list follows, so three status presses cost three writes, not six.
  const [events, setEvents] = useState<OrderEvent[] | null | 'failed'>(null)

  // Re-seed the drafts when a different order opens (adjust-state-during-render:
  // keyed on id so a status/note/tracking patch that replaces `order` mid-view
  // keeps typing).
  if (order && order.id !== drawerFor) {
    setDrawerFor(order.id)
    setNoteDraft(order.note ?? '')
    setCourierDraft(order.courier ?? '')
    setAwbDraft(order.awb ?? '')
    setDateDraft(order.fulfil_date ?? '')
    setEvents(null)
  }

  useEffect(() => {
    if (!order?.id || !merchant?.id) return
    let live = true
    fetchOrderEvents(merchant.id, order.id).then(r => {
      if (live) setEvents(r.ok ? r.data : 'failed')
    })
    return () => { live = false }
  }, [order?.id, merchant?.id])

  // A write's response is the order row plus the events it recorded. The row goes up to the
  // list without the events — a list row must not grow a log — and the events join the card.
  function applyWrite(data: any) {
    const { events: written, ...row } = data ?? {}
    if (Array.isArray(written) && written.length) setEvents(prev => [...(Array.isArray(prev) ? prev : []), ...written])
    onOrderUpdated(row)
  }

  // `order_completed` is the backend refusing a status change on a completed order (ADR 0024).
  // The footer already hides the control, so this reaches a merchant only when their view is
  // stale — another device completed the order while this drawer was open. It says WHY, because
  // the generic failure would read as a bug on a screen still showing the old status.
  function handleStatusChange(o: any, status: string) {
    setOrderStatus(o.id, status, merchant!.id).then(r => {
      if (r.ok) applyWrite(r.data)
      else if (r.error.code === 'order_completed') {
        toast.error(t('This order is done. Its status cannot change.', '此订单已结束，状态无法更改。'))
      } else toast.error(t('Could not update order status.', '无法更新订单状态。'))
    })
  }

  function handleNoteSave() {
    if (!order) return
    setSavingNote(true)
    setOrderNote(order.id, noteDraft, merchant!.id).then(r => {
      if (r.ok) {
        applyWrite(r.data)
        toast.success(t('Note saved', '备注已保存'))
      } else {
        toast.error(t('Could not save note.', '无法保存备注。'))
      }
    }).finally(() => setSavingNote(false))
  }

  function handleTrackingSave() {
    if (!order) return
    setSavingTrack(true)
    setOrderTracking(order.id, courierDraft || null, awbDraft, merchant!.id).then(r => {
      if (r.ok) {
        applyWrite(r.data)
        toast.success(t('Tracking saved', '物流已保存'))
      } else {
        toast.error(t('Could not save tracking.', '无法保存物流。'))
      }
    }).finally(() => setSavingTrack(false))
  }

  // The date edit. `fulfil_date_unavailable` is the backend refusing a day the shop's own
  // Fulfilment settings do not offer. The picker already greys those days out, so it reaches a
  // merchant only when the settings moved under an open drawer, or the day went by while it was
  // open — and it says where the settings are, because the day looked open when it was picked.
  function handleDateSave() {
    if (!order || !dateDraft) return
    setSavingDate(true)
    setOrderFulfilDate(order.id, dateDraft, merchant!.id).then(r => {
      if (r.ok) {
        applyWrite(r.data)
        toast.success(t('Date saved', '日期已保存'))
      } else if (r.error.code === 'fulfil_date_unavailable') {
        toast.error(t('Your shop is not taking orders for that day. Check Settings → Fulfilment.', '你的店铺在该日期不接单。请查看设置 → 配送日期。'))
      } else if (r.error.code === 'order_completed') {
        toast.error(t('This order is done. Its date cannot change.', '此订单已结束，日期无法更改。'))
      } else {
        toast.error(t('Could not save date.', '无法保存日期。'))
      }
    }).finally(() => setSavingDate(false))
  }

  const orderCurrency = order?.currency ?? merchant?.currency
  const noteDirty = order != null && noteDraft.trim() !== (order.note ?? '')
  const trackDirty = order != null &&
    (courierDraft !== (order.courier ?? '') || awbDraft.trim() !== (order.awb ?? ''))
  const dateDirty = order != null && dateDraft !== '' && dateDraft !== (order.fulfil_date ?? '')

  return (
    <Sheet open={order !== null} onOpenChange={open => { if (!open) { onClose(); setDrawerFor(undefined) } }}>
      {/* `data-[side=right]:sm:max-w-[680px]`, not a bare `sm:max-w-[680px]`: the base
          SheetContent already carries `data-[side=right]:sm:max-w-sm`, and a plain utility
          has one variant against its two, so Tailwind orders it FIRST and the base wins.
          Matching the variant lets tailwind-merge drop the base one instead. `w-full` has the
          same problem against the base's `data-[side=right]:w-3/4`, and loses it the same way —
          which left a phone drawer three quarters of the screen wide with a dead strip beside
          it — so the width is spelled with the variant too.
          `gap-0` and `overflow-hidden` undo the base popup's `gap-4` and let the body be the
          only thing that scrolls. */}
      <SheetContent
        side="right"
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-[680px] gap-0 overflow-hidden"
      >
        {order && (
          <>
            <OrderHeader order={order} />

            <div className="flex-1 min-h-0 overflow-y-auto bg-background flex flex-col gap-3 p-3 sm:p-4">
              <ItemsCard items={order.items ?? []} currency={orderCurrency} />
              <PaymentCard
                order={order}
                currency={orderCurrency}
                merchantId={merchant!.id}
                readOnly={readOnly}
                onProofUploaded={saved => applyWrite({ ...order, ...saved })}
              />
              <InvoiceCard order={order} merchantId={merchant!.id} readOnly={readOnly} />
              <CustomerCard
                order={order}
                fulfilDate={dateDraft}
                onFulfilDate={setDateDraft}
                onSaveDate={handleDateSave}
                savingDate={savingDate}
                dateDirty={dateDirty}
                readOnly={readOnly}
              />

              <TrackingCard
                order={order}
                courier={courierDraft}
                awb={awbDraft}
                onCourier={setCourierDraft}
                onAwb={setAwbDraft}
                onSave={handleTrackingSave}
                saving={savingTrack}
                dirty={trackDirty}
                readOnly={readOnly}
              />

              <ReviewCard order={order} />

              <NoteCard
                note={noteDraft}
                saved={order.note ?? null}
                onChange={setNoteDraft}
                onSave={handleNoteSave}
                saving={savingNote}
                dirty={noteDirty}
                readOnly={readOnly}
              />

              <LogCard order={order} events={events} />
            </div>

            {!readOnly && (
              <StatusFooter
                status={order.status || 'new'}
                onChange={s => handleStatusChange(order, s)}
              />
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
