import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchMerchantCustomers } from '../store'

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-MY', { dateStyle: 'medium' })
}

export default function CustomersView() {
  const { t, merchant } = useSession()
  const [customers, setCustomers] = useState(null)

  useEffect(() => {
    fetchMerchantCustomers(merchant.id).then(setCustomers)
  }, [merchant.id])

  if (customers === null) {
    return <p className="mm-orders-loading">{t('Loading…', '加载中…')}</p>
  }

  if (customers.length === 0) {
    return (
      <div className="admin-panel mm-orders-empty">
        <p>{t('No customers yet.', '暂无顾客。')}</p>
      </div>
    )
  }

  return (
    <div className="admin-panel mm-customers-wrap">
      <div className="mm-customers-table-wrap">
        <table className="mm-customers-table">
          <thead>
            <tr>
              <th>{t('Name', '姓名')}</th>
              <th>{t('WhatsApp', 'WhatsApp')}</th>
              <th>{t('Orders', '订单数')}</th>
              <th>{t('Last Order', '最近订单')}</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c, i) => (
              <tr key={c.wa || c.name || i}>
                <td>{c.name || '—'}</td>
                <td>
                  {c.wa ? (
                    <a
                      href={`https://wa.me/${c.wa.replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mm-order-wa"
                    >
                      {c.wa}
                    </a>
                  ) : '—'}
                </td>
                <td className="mm-customers-count">{c.orderCount}</td>
                <td>{fmtDate(c.lastOrder)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
