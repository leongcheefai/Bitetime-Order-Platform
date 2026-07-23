import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchMerchantCustomers } from '../store'
import { SkeletonText } from '../components/Loaders'
import { formatMoney } from '../currency'
import { StatusBadge } from '../orderStatus'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import OrderDetailSheet from './OrderDetailSheet'

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-MY', { dateStyle: 'medium' })
}

// Self-contained panel — pixel-match of .admin-panel
const PANEL = 'bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border'

// Table header cell — pixel-match of .mm-customers-table th
const TH = 'text-[10px] font-semibold uppercase tracking-[0.08em] text-oxblood px-[14px] py-[10px] border-b-[1.5px] border-rose-border text-left whitespace-nowrap'

// Table data cell (base) — pixel-match of .mm-customers-table td + hover
const TD = 'px-[14px] py-[12px] border-b border-surface-warm-alt text-ink align-middle group-hover:bg-oxblood-tint'

// Count cell — pixel-match of .mm-customers-count overrides
const TD_COUNT = 'px-[14px] py-[12px] border-b border-surface-warm-alt text-oxblood font-semibold text-center align-middle group-hover:bg-oxblood-tint'

function WaLink({ wa }: { wa: string }) {
  return (
    <a
      href={`https://wa.me/${wa.replace(/\D/g, '')}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()} // don't open the customer drawer
      // pixel-match of .mm-order-wa + :hover
      className="text-oxblood no-underline font-medium hover:underline"
    >
      {wa}
    </a>
  )
}

export default function CustomersView() {
  const { t, merchant } = useSession()
  const [customers, setCustomers] = useState<any[] | null>(null)
  const [query, setQuery] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<any | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<any | null>(null)

  useEffect(() => {
    fetchMerchantCustomers(merchant!.id).then(setCustomers)
  }, [merchant!.id])

  // A status/note/tracking save inside the stacked order detail must reflect in the
  // drawer's list AND the master aggregate, so re-opening shows the new value.
  function handleOrderUpdated(updated: any) {
    const patch = (o: any) => (o.id === updated.id ? updated : o)
    setCustomers(prev => prev?.map(c => ({ ...c, orders: c.orders?.map(patch) })) ?? prev)
    setSelectedCustomer((cur: any) => (cur ? { ...cur, orders: cur.orders?.map(patch) } : cur))
    setSelectedOrder((cur: any) => (cur && cur.id === updated.id ? updated : cur))
  }

  if (customers === null) {
    return <div className={PANEL}><SkeletonText lines={4} /></div>
  }

  if (customers.length === 0) {
    return (
      <div className={`${PANEL} text-center text-rose-muted text-sm`}>
        <p>{t('No customers yet.', '暂无顾客。')}</p>
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const qDigits = q.replace(/\D/g, '')
  const filtered = customers.filter(c => {
    if (!q) return true
    const nameHit = (c.name || '').toLowerCase().includes(q)
    const waHit = qDigits !== '' && (c.wa || '').replace(/\D/g, '').includes(qDigits)
    return nameHit || waHit
  })

  return (
    <>
      <div className="mb-4">
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('Search by name or WhatsApp…', '按姓名或 WhatsApp 搜索…')}
          className="max-w-sm bg-cream border-clay-border text-[13px]"
        />
      </div>

      {/* pixel-match of .admin-panel + .mm-customers-wrap (padding: 0; overflow: hidden) */}
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-0 mb-8 w-full box-border overflow-hidden">
        {/* pixel-match of .mm-customers-table-wrap */}
        <div className="overflow-x-auto">
          {/* pixel-match of .mm-customers-table */}
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH}>{t('Name', '姓名')}</th>
                <th className={TH}>{t('WhatsApp', 'WhatsApp')}</th>
                <th className={TH}>{t('Orders', '订单数')}</th>
                <th className={TH}>{t('Last Order', '最近订单')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td className={`${TD} text-center text-rose-muted`} colSpan={4}>
                    {t(`No customers match “${query.trim()}”.`, `没有顾客匹配“${query.trim()}”。`)}
                  </td>
                </tr>
              ) : (
                filtered.map((c: any, i: number) => (
                  // group enables hover wash; last-child clears bottom border
                  <tr
                    key={c.key || i}
                    onClick={() => setSelectedCustomer(c)}
                    className="group cursor-pointer [&:last-child>td]:border-b-0"
                  >
                    <td className={TD}>{c.name || '—'}</td>
                    <td className={TD}>{c.wa ? <WaLink wa={c.wa} /> : '—'}</td>
                    <td className={TD_COUNT}>{c.orderCount}</td>
                    <td className={TD}>{fmtDate(c.lastOrder)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Customer drawer — order history */}
      <Sheet open={selectedCustomer !== null} onOpenChange={open => { if (!open) setSelectedCustomer(null) }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          {selectedCustomer && (
            <>
              <SheetHeader className="border-b border-surface-sunken">
                <SheetTitle className="text-[15px]">{selectedCustomer.name || '—'}</SheetTitle>
                {selectedCustomer.wa && (
                  <span className="text-[13px]"><WaLink wa={selectedCustomer.wa} /></span>
                )}
                <span className="text-[12px] text-text-tertiary">
                  {t(`${selectedCustomer.orderCount} order${selectedCustomer.orderCount === 1 ? '' : 's'}`,
                     `${selectedCustomer.orderCount} 个订单`)}
                </span>
              </SheetHeader>

              <div className="flex flex-col gap-2 px-4 pb-4 pt-4">
                {selectedCustomer.orders.map((o: any) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setSelectedOrder(o)}
                    className="flex flex-col gap-1 w-full text-left rounded-lg border border-rose-border bg-cream px-3 py-2.5 hover:bg-oxblood-tint transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-heading text-[14px] font-medium text-oxblood">{o.order_number || '—'}</span>
                      <span className="tabular-nums text-[13px] font-medium text-ink">
                        {formatMoney(o.total, o.currency ?? merchant?.currency)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-text-tertiary">{fmtDate(o.created_at)}</span>
                      <StatusBadge status={o.status || 'new'} t={t} />
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Full order detail — stacked on top of the customer drawer */}
      <OrderDetailSheet
        order={selectedOrder}
        onClose={() => setSelectedOrder(null)}
        onOrderUpdated={handleOrderUpdated}
      />
    </>
  )
}
