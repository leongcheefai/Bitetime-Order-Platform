import { Copy } from 'lucide-react'
import { useSession } from '../../SessionContext'
import { fmtDateTime } from '../../merchantDate'
import { formatCalendarDate } from '../../orderDate'
import { StatusBadge } from '../../orderStatus'
import { fulfilmentLabel } from '../../fulfilmentLabel'
import { copyText } from './copyText'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SheetHeader, SheetTitle } from '@/components/ui/sheet'

/**
 * The drawer's header says WHICH order this is, and nothing else.
 *
 * It used to also carry a row of invoice controls, captioned INVOICE, under a title that is
 * mostly an order number — which wrapped onto its own line and made the header read as a wall
 * of text. Those controls are a card of their own now (`InvoiceCard`). They spent a version at
 * the end of this row, collapsing into a `⋯` menu on a phone, and that menu cost more than it
 * earned: a second copy of the download button for the other breakpoint, and a rule for
 * whether it would open empty. A card needs neither.
 */
export default function OrderHeader({ order }: { order: any }) {
  const { t, lang } = useSession()

  return (
    <SheetHeader className="shrink-0 border-b border-border">
      <div className="flex items-center gap-2">
        <SheetTitle className="text-[17px] sm:text-[19px]">{order.order_number || '—'}</SheetTitle>
        {/* The number is what a merchant reads back to a customer on the phone or pastes into
            their own books. Selecting six characters of a sheet title on a phone is the fiddly
            part, so it gets a button — at every width, now that no menu carries it. */}
        {order.order_number && (
          <Button
            variant="ghost"
            size="iconRound"
            aria-label={t('Copy order number', '复制订单号')}
            onClick={() => copyText(order.order_number!, { en: 'Order number copied', zh: '订单号已复制' }, t)}
          >
            <Copy className="size-3.5" />
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap pt-1.5">
        <StatusBadge status={order.status || 'new'} t={t} />
        <Badge className="bg-neutral-100 text-neutral-fg border-transparent">
          {fulfilmentLabel(order.mode, t)}
        </Badge>
      </div>

      <div className="flex items-center gap-2 flex-wrap pt-1 text-[12px] text-muted-foreground">
        <span>{t('Placed', '下单')} {fmtDateTime(order.created_at)}</span>
        {/* The date the CUSTOMER asked for — what the merchant schedules around — not
            `created_at` beside it. Shown as `—` rather than dropped for a legacy order: a
            missing date would read as "this order has no fulfilment info" rather than
            "placed before #91". */}
        <span aria-hidden="true" className="text-border">·</span>
        <span>
          {t('For', '取货日期')}{' '}
          {order.fulfil_date ? formatCalendarDate(order.fulfil_date, lang) : '—'}
        </span>
      </div>
    </SheetHeader>
  )
}
