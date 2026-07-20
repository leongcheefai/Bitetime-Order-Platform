import { useSession } from '../SessionContext'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatMoney } from '../currency'
import { formatAddress } from '../address'
import { formatOrderDateTime } from '../orderDate'
import { receiptSubtotal } from '../receipt'
import MoneyLine from './MoneyLine'
import type { Merchant, Order, OrderItem } from '../types'

interface ReceiptDialogProps {
  order: Order
  merchant: Merchant
  /** The order's own item names, read back in the customer's language — owned by the caller,
      which already holds the menu this resolves against. */
  itemName: (item: OrderItem) => string
  onClose: () => void
}

/**
 * One order, as a document the customer can keep.
 *
 * The expanded history row already reconciles — it has stated the fee and the voucher since it
 * shipped. What it is not is a RECORD: it names no shop, no customer, no address, states no
 * subtotal, and cannot leave the screen. This can.
 *
 * Status and courier/AWB are deliberately absent. A print is a snapshot; status goes stale the
 * moment it leaves the printer, and a customer holding paper that says "preparing" about an
 * order delivered last week has been misinformed by us. Live status stays on the row, where it
 * can still change.
 *
 * `data-receipt` is the hook the print rules in index.css aim at — see the @media print block
 * there. It is load-bearing, not a test id.
 */
export default function ReceiptDialog({ order, merchant, itemName, onClose }: ReceiptDialogProps) {
  const { t, lang } = useSession()

  // The currency the order was PAID in, not the shop's current one — the same rule the history
  // row states. A receipt re-denominated by a later settings change would be a forgery.
  const currency = order.currency ?? merchant.currency
  const money = (n: number | null | undefined) => formatMoney(n, currency)

  const subtotal = receiptSubtotal(order.items)
  const shipping = order.shipping_fee ?? 0
  const discount = order.discount ?? 0
  const address = order.mode === 'delivery' ? formatAddress(order.address) : ''

  return (
    <Dialog open onOpenChange={(open: boolean) => { if (!open) onClose() }}>
      <DialogContent
        data-receipt
        showCloseButton={false}
        className="sm:max-w-md max-h-[85vh] overflow-y-auto gap-0 p-0"
      >
        <DialogTitle className="sr-only">{t('Receipt', '收据')} {order.order_number}</DialogTitle>
        <div className="p-5">
          {/* Shop name alone: `merchants` carries no address or phone, and inventing a
              header out of the payment fields — written to instruct payment BEFORE an
              order, not to identify a shop after it — would be worse than a plain name. */}
          <div className="border-b border-clay-border pb-3 mb-3">
            <h2 className="font-heading text-[18px] font-medium text-oxblood tracking-[0.3px]">
              {merchant.name}
            </h2>
            <p className="font-heading text-[12px] italic text-rose-muted mt-0.5">
              {t('Receipt', '收据')}
            </p>
          </div>

          <div className="text-[13px] text-rose-muted leading-[1.6] mb-4">
            <div className="font-mono text-ink">{order.order_number}</div>
            <div>{formatOrderDateTime(order.created_at, lang)}</div>
            {order.customer_name && <div className="mt-1.5 text-ink">{order.customer_name}</div>}
            {order.customer_wa && <div>{order.customer_wa}</div>}
            {/* Only a delivery has somewhere to go. A pickup order printing a blank
                address block would read as an order we lost the address for. */}
            {address && <div className="mt-1.5">{address}</div>}
          </div>

          <div className="border-t border-clay-border pt-3">
            {(order.items ?? []).map((item, n) => (
              // Index in the key, not the id: a split promo writes two lines sharing one
              // product id, and an id-only key would collapse them into one row while the
              // total below still charges for both.
              <MoneyLine
                key={`${item.id ?? item.name}-${n}`}
                label={
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    <span className="min-w-0">{itemName(item)} × {item.qty}</span>
                    {/* Rows written before the promo split lack the key; undefined is falsy. */}
                    {item.promo && (
                      <span
                        data-receipt-promo
                        className="shrink-0 px-1.5 py-0.5 rounded-full bg-oxblood text-white text-[10px] leading-[14px] font-medium"
                      >
                        {t('Promo', '优惠')}
                      </span>
                    )}
                  </span>
                }
                value={money((item.price ?? 0) * (item.qty ?? 0))}
              />
            ))}
          </div>

          {/* Subtotal is stated here and nowhere else in the app: it is what closes the
              arithmetic on a page that has to stand on its own — subtotal + fee − voucher
              = total, every term printed. */}
          <div className="border-t border-clay-border mt-2 pt-2">
            <MoneyLine label={t('Subtotal', '小计')} value={money(subtotal)} />
            {shipping > 0 && (
              <MoneyLine label={t('Delivery fee', '送货费')} value={money(shipping)} />
            )}
            {discount > 0 && (
              <MoneyLine
                label={`${t('Voucher', '优惠券')}${order.voucher_code ? ` (${order.voucher_code})` : ''}`}
                value={`−${money(discount)}`}
              />
            )}
          </div>

          <div className="flex justify-between items-start gap-2 text-[15px] font-medium text-ink border-t border-rose-border mt-2 pt-2">
            <span className="shrink-0">
              {order.mode === 'delivery' ? t('Delivery', '送货') : t('Pickup', '自取')}
            </span>
            <span className="text-right">{money(order.total)}</span>
          </div>
        </div>

        {/* data-receipt-actions: the print rules hide this. Paper does not need a Print button. */}
        <div
          data-receipt-actions
          className="flex justify-end gap-2 border-t border-clay-border bg-surface-sunken p-4 rounded-b-lg"
        >
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('Close', '关闭')}
          </Button>
          <Button size="sm" onClick={() => window.print()}>
            {t('Print', '打印')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
