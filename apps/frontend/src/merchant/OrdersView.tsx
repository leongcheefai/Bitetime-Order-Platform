import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchMerchantOrders, setOrderStatus } from '../store'

const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

const STATUS_LABELS: Record<string, { en: string; zh: string }> = {
  new:       { en: 'New',       zh: '新订单' },
  preparing: { en: 'Preparing', zh: '备料中' },
  ready:     { en: 'Ready',     zh: '已备好' },
  completed: { en: 'Completed', zh: '已完成' },
  cancelled: { en: 'Cancelled', zh: '已取消' },
}

function itemsSummary(items: any[] | null | undefined) {
  if (!items || !items.length) return '—'
  return items.map((i: any) => `${i.qty}× ${i.name}`).join(', ')
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-MY', { dateStyle: 'short', timeStyle: 'short' })
}

export default function OrdersView() {
  const { t, merchant } = useSession()
  const [orders, setOrders] = useState<any[] | null>(null)

  useEffect(() => {
    fetchMerchantOrders(merchant!.id).then(setOrders)
  }, [merchant!.id])

  function reload() {
    fetchMerchantOrders(merchant!.id).then(setOrders)
  }

  function handleStatusChange(order: any, status: any) {
    setOrderStatus(order.id, status).then(reload)
  }

  if (orders === null) {
    return <p className="mm-orders-loading">{t('Loading…', '加载中…')}</p>
  }

  if (orders.length === 0) {
    return (
      <div className="admin-panel mm-orders-empty">
        <p>{t('No orders yet.', '暂无订单。')}</p>
      </div>
    )
  }

  return (
    <div className="mm-orders-wrap">
      {orders.map((o: any) => (
        <div key={o.id} className="admin-panel mm-order-card">
          <div className="mm-order-header">
            <span className="mm-order-number">{o.order_number}</span>
            <span className="mm-order-time">{fmtTime(o.created_at)}</span>
            <span className={`mm-badge mm-badge--order-${o.status || 'new'}`}>
              {t(STATUS_LABELS[o.status]?.en ?? o.status, STATUS_LABELS[o.status]?.zh ?? o.status)}
            </span>
          </div>

          <div className="mm-order-body">
            <div className="mm-order-customer">
              <span className="mm-order-label">{t('Customer', '顾客')}</span>
              <span>{o.customer_name || '—'}</span>
              {o.customer_wa && (
                <a
                  href={`https://wa.me/${o.customer_wa.replace(/\D/g, '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mm-order-wa"
                >
                  {o.customer_wa}
                </a>
              )}
            </div>

            <div className="mm-order-items">
              <span className="mm-order-label">{t('Items', '商品')}</span>
              <span>{itemsSummary(o.items)}</span>
            </div>

            <div className="mm-order-meta">
              <span>
                <span className="mm-order-label">{t('Total', '总计')}</span>{' '}
                <strong>RM {Number(o.total || 0).toFixed(2)}</strong>
              </span>
              <span>
                <span className="mm-order-label">{t('Mode', '方式')}</span>{' '}
                {o.mode || '—'}
              </span>
            </div>

            {o.address && (
              <div className="mm-order-address">
                <span className="mm-order-label">{t('Address', '地址')}</span>
                <span>{o.address}</span>
              </div>
            )}
          </div>

          <div className="mm-order-footer">
            <label className="mm-order-label" htmlFor={`status-${o.id}`}>
              {t('Status', '状态')}
            </label>
            <div className="admin-field--stack">
              <select
                id={`status-${o.id}`}
                className="admin-field-select"
                value={o.status || 'new'}
                onChange={e => handleStatusChange(o, e.target.value)}
              >
                {ORDER_STATUSES.map(s => (
                  <option key={s} value={s}>
                    {t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
