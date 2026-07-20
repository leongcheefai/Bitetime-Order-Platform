import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useMerchant } from '../MerchantContext'
import { useSession } from '../SessionContext'
import { fetchMyOrdersAtShop, fetchProducts, signOut, ORDER_HISTORY_LIMIT } from '../store'
import { StatusBadge } from '../orderStatus'
import { courierName, trackingUrl } from '../couriers'
import { formatMoney } from '../currency'
import { formatOrderDate, formatCalendarDate } from '../orderDate'
import { cn } from '@/lib/utils'
import AuthPanel from './AuthPanel'
import MoneyLine from './MoneyLine'
import LanguageSelect from '../components/LanguageSelect'
import type { Order, OrderItem, Product, Translate } from '../types'

type Loaded =
  | { state: 'orders'; userId: string; merchantId: string; rows: Order[] }
  | { state: 'failed'; userId: string; merchantId: string }

/**
 * Every order this customer has placed at this shop — the payoff the checkout gate promises.
 *
 * A destination, so it earns a real route (deep-linkable, shareable, back-button-able), unlike
 * the auth panel, which is a modal precisely because it must not unmount the cart.
 *
 * History ABSORBS tracking: the expanded row carries the courier and AWB and links straight to
 * the courier's own page. It deliberately does not hand off to /track — sending a customer who is
 * already looking at the order to a screen where they would re-type its number is absurd. That
 * leaves /track as the GUEST path, which is exactly what the guest warning promises: the two
 * screens now have one job each.
 */
export default function OrderHistory() {
  const { merchant } = useMerchant()
  const { t, lang, account, loading } = useSession()
  // What was loaded carries whose it is and where from. A bare `Order[]` would still hold the
  // previous customer's history for the beat after someone else signs in on the same device —
  // the one thing this screen must never show.
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const merchantId = merchant?.id
  const userId = account?.id

  useEffect(() => {
    if (!merchantId || !userId) return
    let live = true
    fetchMyOrdersAtShop(merchantId)
      .then(rows => { if (live) setLoaded({ state: 'orders', userId, merchantId, rows }) })
      .catch(() => { if (live) setLoaded({ state: 'failed', userId, merchantId }) })
    // The menu, only to read item names back in the customer's language: an order stores the name
    // as it was at checkout, in whichever language was on screen then.
    fetchProducts(merchantId).then(rows => { if (live) setProducts(rows) }).catch(() => {})
    return () => { live = false }
  }, [merchantId, userId])

  if (!merchant) return null
  const { slug } = merchant

  const mine = loaded && loaded.userId === userId && loaded.merchantId === merchantId ? loaded : null
  const orders = mine?.state === 'orders' ? mine.rows : null
  const failed = mine?.state === 'failed'

  const itemName = (item: OrderItem) => {
    const p = products.find(p => p.id === item.id)
    return (lang === 'zh' && p?.name_zh ? p.name_zh : item.name) ?? ''
  }

  return (
    <div className="form-wrap pt-8 pb-24">
      <div className="flex items-start justify-between gap-4 mb-7 max-[480px]:flex-col max-[480px]:gap-2">
        <div>
          <h1 className="font-heading text-[26px] font-medium text-oxblood tracking-[0.3px]">{merchant.name}</h1>
          <p className="font-heading text-[13px] italic text-rose-muted mt-[5px]">{t('Your orders', '你的订单')}</p>
          <Link to={`/s/${slug}`} className="text-[12px] text-oxblood underline mt-1 inline-block">
            {t('Back to menu', '返回菜单')}
          </Link>
        </div>
        <div className="flex justify-end flex-shrink-0 max-[480px]:justify-start">
          <LanguageSelect />
        </div>
      </div>

      {/* Signed in: identity, and the only sign-out in the customer app — this is the one
          signed-in customer surface there is, so there is nowhere else sensible to put it. */}
      {account && (
        <div className="flex items-center justify-between gap-3 bg-oxblood-tint border border-rose-border rounded-md px-[13px] py-2.5 mb-6">
          <span className="text-[13px] text-rose-muted leading-[1.4] truncate">
            {t('Signed in as', '已登录：')} <strong className="text-oxblood font-medium">{account.email}</strong>
          </span>
          <button
            type="button"
            onClick={() => signOut()}
            className="text-[13px] text-rose-muted underline underline-offset-2 cursor-pointer shrink-0"
          >
            {t('Sign out', '登出')}
          </button>
        </div>
      )}

      {/* Signed out, this renders in place and does not redirect: bouncing a hungry customer to
          the merchant login — the role guard's destination — is the wrong screen entirely. */}
      {!loading && !account && (
        <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-6">
          <AuthPanel
            heading={t('Sign in to see your orders at this shop', '登录以查看你在本店的订单')}
            subheading={t(
              'Only orders placed while signed in appear here.',
              '只有登录后下的订单才会显示在这里。',
            )}
          />
        </div>
      )}

      {/* A failed read must never wear the empty state's clothes: "you haven't ordered here yet"
          is a lie to a customer whose history simply didn't load, and the one they'd believe. */}
      {failed && (
        <div className="bg-rose-pale border border-danger-border rounded-md px-[13px] py-[10px] text-[13px] text-danger leading-[1.5]">
          {t(
            "Couldn't load your orders. Check your connection and try again.",
            '无法加载你的订单。请检查网络后重试。',
          )}
        </div>
      )}

      {orders?.length === 0 && (
        <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-6 text-center">
          <p className="text-[14px] text-rose-muted leading-[1.6]">
            {t("You haven't ordered from this shop yet.", '你还没有在本店下过单。')}
          </p>
          <Link to={`/s/${slug}`} className="text-[13px] text-oxblood font-medium underline mt-3 inline-block">
            {t('See the menu', '查看菜单')}
          </Link>
        </div>
      )}

      {orders && orders.length > 0 && (
        <>
          <div className="border border-clay-border rounded-xl overflow-hidden bg-surface-raised">
            {orders.map((o, i) => {
              const id = o.order_number ?? o.id ?? String(i)
              const expanded = expandedId === id
              // The currency the order was PAID in, not the shop's current one. They are the same
              // today (the selector locks after a shop's first order), but a receipt re-denominated
              // by a later settings change would be a forgery.
              const currency = o.currency ?? merchant.currency
              const shipping = o.shipping_fee ?? 0
              const discount = o.discount ?? 0
              return (
                <div key={id} className={cn(i > 0 && 'border-t border-clay-border')}>
                  {/* Status and total sit on the row, unexpanded. "Where's my order?" is the single
                      most common reason this screen is opened — it must not cost a tap. */}
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : id)}
                    aria-expanded={expanded}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left cursor-pointer hover:bg-oxblood-tint/40 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-[13px] text-ink truncate">{o.order_number}</div>
                      <div className="text-[12px] text-rose-muted mt-0.5">{formatOrderDate(o.created_at, lang)}</div>
                      {/* When placed vs. when the customer wants it — a legacy order (placed
                          before #91) shows `—` rather than nothing, so it reads as "no date was
                          ever collected" and not as data this row lost. */}
                      <div className="text-[12px] text-rose-muted mt-0.5">
                        {o.fulfil_date
                          ? `${t('For', '取货日期')} ${formatCalendarDate(o.fulfil_date, lang)}`
                          : '—'}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <StatusBadge status={o.status ?? 'new'} t={t} />
                      <span className="text-[14px] font-medium text-ink tabular-nums">
                        {formatMoney(o.total, currency)}
                      </span>
                    </div>
                  </button>

                  {expanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-clay-border/60 bg-oxblood-tint/30">
                      {(o.items ?? []).map((item, n) => (
                        // Index (`n`) in the key, not just id: a split promo writes two lines
                        // sharing the same product id (base half + promo half), and an id-only
                        // key would collapse them into one row while the total still charges
                        // for both.
                        <MoneyLine
                          key={`${item.id ?? item.name}-${n}`}
                          label={
                            <span className="inline-flex items-center gap-1.5 min-w-0">
                              <span className="truncate">{itemName(item)} × {item.qty}</span>
                              {/* Missing `promo` (rows written before I-2) reads as false. */}
                              {item.promo && (
                                <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-oxblood text-white text-[10px] leading-[14px] font-medium">
                                  {t('Promo', '优惠')}
                                </span>
                              )}
                            </span>
                          }
                          value={formatMoney((item.price ?? 0) * (item.qty ?? 0), currency)}
                        />
                      ))}
                      {/* Shipping and the voucher are both stated, or the lines above would not add
                          up to the total below them — a receipt that doesn't reconcile is worse
                          than one that shows only a total. */}
                      {shipping > 0 && (
                        <MoneyLine label={t('Delivery fee', '送货费')} value={formatMoney(shipping, currency)} />
                      )}
                      {discount > 0 && (
                        <MoneyLine
                          label={`${t('Voucher', '优惠券')}${o.voucher_code ? ` (${o.voucher_code})` : ''}`}
                          value={`−${formatMoney(discount, currency)}`}
                        />
                      )}
                      <div className="flex justify-between items-start gap-2 text-[14px] font-medium text-ink border-t border-rose-border mt-2 pt-2">
                        <span className="shrink-0">
                          {o.mode === 'delivery' ? t('Delivery', '送货') : t('Pickup', '自取')}
                        </span>
                        <span className="text-right">{formatMoney(o.total, currency)}</span>
                      </div>
                      <Tracking order={o} t={t} />
                    </div>
                  )}

                </div>
              )
            })}
          </div>

          {/* The cap is stated, not silently applied: a truncated list with nothing said reads as
              "these are all my orders" when it isn't. */}
          <p className="text-[12px] text-rose-muted text-center mt-6">
            {t(
              `Showing your last ${ORDER_HISTORY_LIMIT} orders at this shop.`,
              `显示你在本店最近的 ${ORDER_HISTORY_LIMIT} 笔订单。`,
            )}
          </p>
        </>
      )}
    </div>
  )
}

/**
 * Courier and AWB, inline. With no tracking number yet — a pickup order, or one not yet shipped —
 * this renders nothing and the status badge on the row is the tracking. A "Track" affordance that
 * leads nowhere is worse than none.
 */
function Tracking({ order, t }: { order: Order; t: Translate }) {
  const { courier, awb } = order
  if (!awb) return null
  const link = trackingUrl(courier, awb)
  return (
    <div className="flex items-center justify-between gap-2 text-[13px] text-rose-muted mt-2">
      <span className="truncate">
        {courierName(courier) || courier} · <span className="font-mono">{awb}</span>
      </span>
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-oxblood underline underline-offset-2 shrink-0"
        >
          {t('Track', '追踪')}
        </a>
      )}
    </div>
  )
}
