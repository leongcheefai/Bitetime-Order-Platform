import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchMerchantOrders, setOrderStatus } from '../store'
import { formatMoney } from '../currency'
import { SkeletonText } from '../components/Loaders'
import { Badge } from '@/components/ui/badge'

const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

const STATUS_LABELS: Record<string, { en: string; zh: string }> = {
  new:       { en: 'New',       zh: '新订单' },
  preparing: { en: 'Preparing', zh: '备料中' },
  ready:     { en: 'Ready',     zh: '已备好' },
  completed: { en: 'Completed', zh: '已完成' },
  cancelled: { en: 'Cancelled', zh: '已取消' },
}

// Status → Badge config map.
// Verified against .mm-badge--order-* CSS literals:
//   new       → info-blue-bg / info-blue-fg  → infoBlue variant (exact match)
//   preparing → warn-bg-alt / warn-fg-alt    → no named variant; className override
//   ready     → success-bg-soft / success-deep → no named variant; className override
//   completed → prep-bg-alt / prep-fg-alt    → no named variant; className override
//   cancelled → danger-bg / danger-fg        → className override (danger variant adds a border the original lacked)
type BadgeConfig = { variant?: 'infoBlue' | 'danger'; className?: string }
const STATUS_BADGE: Record<string, BadgeConfig> = {
  new:       { variant: 'infoBlue' },
  preparing: { className: 'bg-warn-bg-alt text-warn-fg-alt border-transparent' },
  ready:     { className: 'bg-success-bg-soft text-success-deep border-transparent' },
  completed: { className: 'bg-prep-bg-alt text-prep-fg-alt border-transparent' },
  cancelled: { className: 'bg-danger-bg text-danger-fg border-transparent' },
}

// mm-order-label equivalent: 11px semibold uppercase, letter-spacing 0.06em, rose-muted, shrink-0
const LBL = 'text-[11px] font-semibold uppercase tracking-[0.06em] text-rose-muted shrink-0'

// Self-contained select classes — pixel-match of .admin-field-select (no dependency on that class)
const SELECT_CLS =
  'w-full py-[7px] pl-[10px] pr-[32px] border border-clay-border rounded-sm text-[13px] ' +
  'bg-cream text-ink font-sans appearance-none bg-no-repeat cursor-pointer min-w-[140px] ' +
  'focus:outline-none focus:border-oxblood focus:shadow-[0_0_0_2px_rgba(122,16,40,0.1)]'

// Chevron SVG data-URI — matches the one in .admin-field-select
const CHEVRON_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%237A4F55' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`

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
    return <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border"><SkeletonText lines={4} /></div>
  }

  if (orders.length === 0) {
    return (
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border text-center text-rose-muted text-sm">
        <p>{t('No orders yet.', '暂无订单。')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {orders.map((o: any) => {
        const badge = STATUS_BADGE[o.status || 'new'] ?? { variant: 'infoBlue' as const }
        return (
          // admin-panel provides bg/border/rounded/width; !py-4 overrides py 1.25rem→1rem
          <div key={o.id} className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border !py-4 flex flex-col gap-[10px]">

            {/* ── Header: order number · time · status badge ── */}
            <div className="flex items-center gap-[10px] flex-wrap">
              <span className="font-heading text-[15px] font-medium text-oxblood">
                {o.order_number}
              </span>
              <span className="text-[12px] text-text-tertiary ml-auto whitespace-nowrap max-[600px]:ml-0">
                {fmtTime(o.created_at)}
              </span>
              <Badge variant={badge.variant} className={badge.className}>
                {t(STATUS_LABELS[o.status]?.en ?? o.status, STATUS_LABELS[o.status]?.zh ?? o.status)}
              </Badge>
            </div>

            {/* ── Body: customer · items · meta · address ── */}
            <div className="flex flex-col gap-[6px] text-[13px] text-ink">

              {/* Customer */}
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className={LBL}>{t('Customer', '顾客')}</span>
                <span>{o.customer_name || '—'}</span>
                {o.customer_wa && (
                  <a
                    href={`https://wa.me/${o.customer_wa.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    // pixel-match of .mm-order-wa + :hover
                    className="text-oxblood no-underline font-medium hover:underline"
                  >
                    {o.customer_wa}
                  </a>
                )}
              </div>

              {/* Items */}
              <div className="flex gap-2 flex-wrap">
                <span className={LBL}>{t('Items', '商品')}</span>
                <span>{itemsSummary(o.items)}</span>
              </div>

              {/* Meta: total + mode */}
              <div className="flex gap-4 flex-wrap max-[600px]:gap-[10px]">
                <span>
                  <span className={LBL}>{t('Total', '总计')}</span>{' '}
                  <strong>{formatMoney(o.total, o.currency ?? merchant?.currency)}</strong>
                </span>
                <span>
                  <span className={LBL}>{t('Mode', '方式')}</span>{' '}
                  {o.mode || '—'}
                </span>
              </div>

              {/* Address */}
              {o.address && (
                <div className="flex gap-2 flex-wrap">
                  <span className={LBL}>{t('Address', '地址')}</span>
                  <span>{o.address}</span>
                </div>
              )}
            </div>

            {/* ── Footer: status select ── */}
            <div className="flex items-center gap-[10px] flex-wrap pt-[6px] border-t border-surface-sunken">
              <label className={LBL} htmlFor={`status-${o.id}`}>
                {t('Status', '状态')}
              </label>
              {/* Self-contained stack wrapper (replaces admin-field--stack dependency) */}
              <div className="flex flex-col gap-1 min-w-[200px] items-start">
                <select
                  id={`status-${o.id}`}
                  className={SELECT_CLS}
                  style={{ backgroundImage: CHEVRON_SVG, backgroundPosition: 'right 10px center' }}
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
        )
      })}
    </div>
  )
}
