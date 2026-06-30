import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchMerchantCustomers } from '../store'
import { SkeletonText } from '../components/Loaders'

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

export default function CustomersView() {
  const { t, merchant } = useSession()
  const [customers, setCustomers] = useState<any[] | null>(null)

  useEffect(() => {
    fetchMerchantCustomers(merchant!.id).then(setCustomers)
  }, [merchant!.id])

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

  return (
    // pixel-match of .admin-panel + .mm-customers-wrap (padding: 0; overflow: hidden)
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
            {customers.map((c: any, i: number) => (
              // group enables hover wash; last-child clears bottom border
              <tr key={c.wa || c.name || i} className="group [&:last-child>td]:border-b-0">
                <td className={TD}>{c.name || '—'}</td>
                <td className={TD}>
                  {c.wa ? (
                    <a
                      href={`https://wa.me/${c.wa.replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      // pixel-match of .mm-order-wa + :hover
                      className="text-oxblood no-underline font-medium hover:underline"
                    >
                      {c.wa}
                    </a>
                  ) : '—'}
                </td>
                <td className={TD_COUNT}>{c.orderCount}</td>
                <td className={TD}>{fmtDate(c.lastOrder)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
