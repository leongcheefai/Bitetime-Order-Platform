import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Truck, ExternalLink, ChevronDown } from 'lucide-react'
import { useMerchant } from '../MerchantContext'
import { useSession } from '../SessionContext'
import { Button } from '../components/ui/button'
import { fetchMyInvoice, fetchMyOrdersAtShop, fetchMyPaymentProof, fetchMyMerchantPaymentProof, lookupProducts, reviewMyOrder, signOut, ORDER_HISTORY_LIMIT, type PaymentProofSaved } from '../store'
import { StatusBadge } from '../orderStatus'
import { ItemSelections } from '../ItemSelections'
import { courierName, trackingUrl } from '../couriers'
import { formatMoney } from '../currency'
import { formatOrderDate, formatCalendarDate, formatSlotRange } from '../orderDate'
import { formatTaxRate } from '../taxRate'
import { fulfilmentLabel, feeLineLabel } from '../fulfilmentLabel'
import { cn } from '@/lib/utils'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import AuthPanel from './AuthPanel'
import MoneyLine from './MoneyLine'
import OrderTimeline from './OrderTimeline'
import PaymentProofUpload from './PaymentProofUpload'
import PaymentInstructions from './PaymentInstructions'
import OrderReviewCard from './OrderReviewCard'
import { canUploadPaymentProof } from '../paymentProof'
import LanguageSelect from '../components/LanguageSelect'
import InvoiceButton from '../components/InvoiceButton'
import ZoomableImage from '../components/ZoomableImage'
import type { Merchant, Order, OrderItem, Product, Translate } from '../types'

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
 * the courier's own page. There is no `/track` screen to hand off to any more — it was removed
 * once this row carried everything it said and more, and a customer already looking at their own
 * order should never be sent somewhere to re-type its number.
 *
 * The GUEST has no equivalent of this page and never will: their order carries `user_id = null`
 * for ever. What they get instead is `/invoice`, which asks for the order number and the phone
 * they typed — the same document this page offers, through the only door they can prove.
 */
export default function OrderHistory() {
  const { merchant } = useMerchant()
  const { t, lang, account, loading } = useSession()
  // What was loaded carries whose it is and where from. A bare `Order[]` would still hold the
  // previous customer's history for the beat after someone else signs in on the same device —
  // the one thing this screen must never show.
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [products, setProducts] = useState<Product[]>([])

  const merchantId = merchant?.id
  const userId = account?.id

  /**
   * Patch ONE loaded row in place — used after a payment-proof upload, which sets the path and
   * may move the order out of `pending_payment`. The whole list is not refetched: the write
   * already returned what it changed, and a refetch would drop the accordion's open row.
   *
   * Guarded on `state === 'orders'` so it can never resurrect a failed or a foreign load; the
   * ownership fields ride along untouched.
   */
  function patchLoadedOrder(orderId: string, patch: Partial<Order>) {
    setLoaded(prev =>
      prev && prev.state === 'orders'
        ? { ...prev, rows: prev.rows.map(r => (r.id === orderId ? { ...r, ...patch } : r)) }
        : prev,
    )
  }

  useEffect(() => {
    if (!merchantId || !userId) return
    let live = true
    fetchMyOrdersAtShop(merchantId)
      .then(r => {
        if (!live) return
        if (r.ok) setLoaded({ state: 'orders', userId, merchantId, rows: r.data })
        else setLoaded({ state: 'failed', userId, merchantId })
      })
    // The menu, only to read item names back in the customer's language: an order stores the name
    // as it was at checkout, in whichever language was on screen then.
    lookupProducts(merchantId).then(r => { if (live && r.ok) setProducts(r.data) })
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
    <div role="main" className="form-wrap pt-8 pb-24">
      <div className="flex items-start justify-between gap-4 mb-7 max-[480px]:flex-col max-[480px]:gap-2">
        <div>
          <h1 className="font-heading text-[26px] font-medium text-primary tracking-[0.3px]">{merchant.name}</h1>
          <p className="font-heading text-[13px] italic text-muted-foreground mt-[5px]">{t('Your orders', '你的订单')}</p>
          <Link to={`/s/${slug}`} className="text-[12px] text-primary underline mt-1 inline-block">
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
        <div className="flex items-center justify-between gap-3 bg-brand-wash border border-border rounded-md px-[13px] py-2.5 mb-6">
          <span className="text-[13px] text-muted-foreground leading-[1.4] truncate">
            {t('Signed in as', '已登录：')} <strong className="text-primary font-medium">{account.email}</strong>
          </span>
          <Button
            type="button"
            variant="link"
            size="none"
            onClick={() => signOut()}
            className="text-[13px] text-muted-foreground shrink-0"
          >
            {t('Sign out', '登出')}
          </Button>
        </div>
      )}

      {/* Signed out, this renders in place and does not redirect: bouncing a hungry customer to
          the merchant login — the role guard's destination — is the wrong screen entirely. */}
      {!loading && !account && (
        <div className="bg-card border-[0.5px] border-border rounded-2xl p-6">
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
        <div role="alert" className="bg-danger-100 border border-danger-500 rounded-md px-[13px] py-[10px] text-[13px] text-danger-fg leading-[1.5]">
          {t(
            "Couldn't load your orders. Check your connection and try again.",
            '无法加载你的订单。请检查网络后重试。',
          )}
        </div>
      )}

      {orders?.length === 0 && (
        <div className="bg-card border-[0.5px] border-border rounded-2xl p-6 text-center">
          <p className="text-[14px] text-muted-foreground leading-[1.6]">
            {t("You haven't ordered from this shop yet.", '你还没有在本店下过单。')}
          </p>
          <Link to={`/s/${slug}`} className="text-[13px] text-primary font-medium underline mt-3 inline-block">
            {t('See the menu', '查看菜单')}
          </Link>
        </div>
      )}

      {orders && orders.length > 0 && (
        <>
          {/* One-open-at-a-time accordion. The chevron is the point: the old plain rows gave a
              customer no sign they could be opened, so the receipt detail sat unfound. */}
          <Accordion multiple={false} className="border border-border rounded-xl overflow-hidden bg-card">
            {orders.map((o, i) => {
              const id = o.order_number ?? o.id ?? String(i)
              // The currency the order was PAID in, not the shop's current one. They are the same
              // today (the selector locks after a shop's first order), but a receipt re-denominated
              // by a later settings change would be a forgery.
              const currency = o.currency ?? merchant.currency
              const shipping = o.shipping_fee ?? 0
              const discount = o.discount ?? 0
              const tax = o.tax ?? 0
              const taxRate = o.tax_rate ?? 0
              return (
                <AccordionItem key={id} value={id} className={cn('border-border', i > 0 && 'border-t')}>
                  {/* Status and total sit on the row, unexpanded. "Where's my order?" is the single
                      most common reason this screen is opened — it must not cost a tap. The two
                      default up/down glyphs are hidden in favour of one chevron that rotates. */}
                  <AccordionTrigger className="items-center gap-3 px-4 py-3 rounded-none border-0 font-normal cursor-pointer hover:no-underline hover:bg-brand-wash/40 transition-colors [&_[data-slot=accordion-trigger-icon]]:hidden">
                    <div className="flex flex-1 min-w-0 items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-mono text-[13px] text-foreground truncate">{o.order_number}</div>
                        <div className="text-[12px] text-muted-foreground mt-0.5">{formatOrderDate(o.created_at, lang)}</div>
                        {/* When placed vs. when the customer wants it — a legacy order (placed
                            before #91) shows `—` rather than nothing, so it reads as "no date was
                            ever collected" and not as data this row lost. */}
                        <div className="text-[12px] text-muted-foreground mt-0.5">
                          {o.fulfil_date
                            ? `${t('For', '取货日期')} ${formatCalendarDate(o.fulfil_date, lang)}${o.fulfil_time_from ? ` · ${formatSlotRange(o.fulfil_time_from, o.fulfil_time_to)}` : ''}`
                            : '—'}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <StatusBadge status={o.status ?? 'new'} t={t} />
                        <span className="text-[14px] font-medium text-foreground tabular-nums">
                          {formatMoney(o.total, currency)}
                        </span>
                        <ChevronDown className="size-4 text-muted-foreground transition-transform duration-200 group-aria-expanded/accordion-trigger:rotate-180" strokeWidth={2} />
                      </div>
                    </div>
                  </AccordionTrigger>

                  <AccordionContent className="px-4 pb-4 pt-3 border-t border-border/60 bg-brand-wash/30">
                      {(o.items ?? []).map((item, n) => (
                        // Index (`n`) in the key, not just id: a split promo writes two lines
                        // sharing the same product id (base half + promo half), and an id-only
                        // key would collapse them into one row while the total still charges
                        // for both.
                        <MoneyLine
                          key={`${item.id ?? item.name}-${n}`}
                          label={
                            <span className="inline-flex flex-col gap-0.5 min-w-0">
                              <span className="inline-flex items-center gap-1.5 min-w-0">
                              <span className="truncate">{itemName(item)} × {item.qty}</span>
                              {/* Missing `promo` (rows written before I-2) reads as false. */}
                              {item.promo && (
                                <span className="shrink-0 px-1.5 py-0.5 rounded-pill bg-primary text-primary-foreground text-[10px] leading-[14px] font-medium">
                                  {t('Promo', '优惠')}
                                </span>
                              )}
                              </span>
                              <ItemSelections item={item} />
                            </span>
                          }
                          value={formatMoney((item.price ?? 0) * (item.qty ?? 0), currency)}
                        />
                      ))}
                      {/* Shipping, tax, and the voucher are all stated, or the lines above would not add
                          up to the total below them — a receipt that doesn't reconcile is worse
                          than one that shows only a total. */}
                      {shipping > 0 && (
                        // The STORED distance, not a re-derivation: a later rate change must
                        // never repaint an old order. Null (region-priced, or placed before
                        // #101) prints the plain label — never `0.0 km`.
                        <MoneyLine
                          label={feeLineLabel(
                            o.mode,
                            o.delivery_distance_km != null ? Number(o.delivery_distance_km) : null,
                            t,
                          )}
                          value={formatMoney(shipping, currency)}
                        />
                      )}
                      {discount > 0 && (
                        <MoneyLine
                          label={`${t('Voucher', '优惠券')}${o.voucher_code ? ` (${o.voucher_code})` : ''}`}
                          value={`−${formatMoney(discount, currency)}`}
                        />
                      )}
                      {taxRate > 0 && (
                        <MoneyLine
                          label={`${t('Tax', '税')} (${formatTaxRate(taxRate)}%)`}
                          value={formatMoney(tax, currency)}
                        />
                      )}
                      <div className="flex justify-between items-start gap-2 text-[14px] font-medium text-foreground border-t border-border mt-2 pt-2">
                        <span className="shrink-0">
                          {fulfilmentLabel(o.mode, t)}
                        </span>
                        <span className="text-right">{formatMoney(o.total, currency)}</span>
                      </div>
                      <OrderTimeline status={o.status ?? 'new'} mode={o.mode} t={t} />
                      <PaymentProofSection
                        order={o}
                        t={t}
                        merchant={merchant}
                        onUploaded={saved => patchLoadedOrder(o.id!, saved)}
                      />
                      <Tracking order={o} t={t} />
                      {/* The same card the order-placed screen shows, and the only way a
                          signed-in customer can change their mind afterwards. It writes through
                          the signed-in door — history is signed-in-only by construction, so there
                          is no guest branch to write here.

                          A CANCELLED order keeps a review it already has and offers no form: the
                          backend refuses the write with 409, but hiding the whole card would take
                          away a rating the customer left while the order was live — which they
                          would read as their words having been deleted. An unrated cancelled
                          order shows nothing, because there is nothing to show and nothing to
                          write. `key` on the order id keeps one row's card from carrying another
                          row's state when the accordion switches. */}
                      {(o.status !== 'cancelled' || o.review_rating) && (
                        <OrderReviewCard
                          key={o.id}
                          className="mt-3"
                          readOnly={o.status === 'cancelled'}
                          initial={o.review_rating
                            ? { rating: o.review_rating, comment: o.review_comment ?? null }
                            : null}
                          submit={async (rating, comment) => {
                            const r = await reviewMyOrder(o.id!, rating, comment)
                            // Patch the loaded row so the stored review survives collapsing and
                            // re-opening this order, without refetching the whole list (which
                            // would close the accordion).
                            if (r.ok) patchLoadedOrder(o.id!, {
                              review_rating: r.data.review_rating,
                              review_comment: r.data.review_comment,
                              review_at: r.data.review_at,
                            })
                            return r
                          }}
                        />
                      )}
                      {/* The document, for the customer who came here to get one. The same bytes
                          the merchant and a guest are handed — one order has one invoice. */}
                      <InvoiceButton
                        status={o.status}
                        orderNumber={o.order_number}
                        fetcher={() => fetchMyInvoice(o.id!)}
                        className="text-[13px] mt-3"
                      />
                  </AccordionContent>
                </AccordionItem>
              )
            })}
          </Accordion>

          {/* The cap is stated, not silently applied: a truncated list with nothing said reads as
              "these are all my orders" when it isn't. */}
          <p className="text-[12px] text-muted-foreground text-center mt-6">
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
 * The order's proof of payment: the screenshot the customer uploaded, or the chance to upload
 * one if they never did.
 *
 * The order-placed screen offers the upload once, on a page a customer often closes before their
 * banking app is done. This is the second door — the same widget, the same route — and the only
 * one that still exists a day later. `canUploadPaymentProof` decides where offering it is
 * honest; a cancelled order is not it.
 *
 * Once uploaded, the widget STAYS (`justUploaded`), holding the local preview of the file the
 * customer picked. Switching to the fetched image the moment the row gains a path would spend a
 * round trip re-downloading bytes this browser already has, and show "Loading…" over a thumbnail
 * that was on screen a second ago.
 *
 * Lazy by construction, not by a manual open/closed flag: this only ever mounts inside an
 * accordion panel that unmounts on collapse (`Accordion`'s default `keepMounted={false}`), so
 * the fetch starts when the row opens and `URL.revokeObjectURL` runs in this effect's own
 * cleanup when it closes — never fetched for orders the customer hasn't expanded.
 */
function PaymentProofSection({
  order,
  t,
  merchant,
  onUploaded,
}: {
  order: Order
  t: Translate
  merchant: Merchant
  onUploaded: (saved: PaymentProofSaved) => void
}) {
  const [justUploaded, setJustUploaded] = useState(false)
  const [url, setUrl] = useState<string | null>(null)

  // Which slip this row shows, decided once: the customer's own first — it is theirs, and they
  // know what they sent — then the shop's copy, for the customer who sent the slip over WhatsApp
  // and would otherwise see an order that took their money with nothing on screen to show for it.
  // Only when neither exists is there anything left to ask for.
  const source = order.payment_proof ? 'mine' : order.payment_proof_merchant ? 'shop' : null
  const hasProof = source !== null && !justUploaded

  useEffect(() => {
    if (!source || !order.id) return
    let cancelled = false
    let objectUrl: string | null = null
    const load = source === 'shop' ? fetchMyMerchantPaymentProof : fetchMyPaymentProof
    load(order.id).then((r) => {
      if (cancelled || !r.ok) return
      objectUrl = URL.createObjectURL(r.data)
      setUrl(objectUrl)
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [order.id, source])

  if (!hasProof) {
    if (!order.id || !canUploadPaymentProof(order.status)) return null
    return (
      <div className="mt-3">
        <Instructions merchant={merchant} status={order.status} />
        <div className="text-[11px] font-medium text-primary uppercase tracking-[0.09em] mb-1.5">
          {t('Payment proof', '付款凭证')}
        </div>
        <PaymentProofUpload
          orderId={order.id}
          onUploaded={saved => {
            setJustUploaded(true)
            onUploaded(saved)
          }}
        />
      </div>
    )
  }

  return (
    <div className="mt-3">
      {/* Above the slip, not instead of it: an order still awaiting the shop's word is one a
          customer may need to pay the rest of, or pay again after a failed transfer. */}
      <Instructions merchant={merchant} status={order.status} />
      <div className="text-[11px] font-medium text-primary uppercase tracking-[0.09em] mb-1.5">
        {t('Payment proof', '付款凭证')}
      </div>
      {url ? (
        <div className="flex flex-col gap-1 w-full max-w-[160px]">
          <ZoomableImage
            src={url}
            alt={t('Payment proof', '付款凭证')}
            triggerClassName="w-full"
            imgClassName="w-full h-auto object-contain rounded-md border border-border"
          />
          {/* Said only for the shop's copy. A customer looking at a slip they never uploaded
              needs to know where it came from; their own needs no label. */}
          {source === 'shop' && (
            <span className="text-[12px] text-muted-foreground">
              {t('Filed by the shop', '店家上传')}
            </span>
          )}
        </div>
      ) : (
        <span className="text-[13px] text-muted-foreground">{t('Loading…', '加载中…')}</span>
      )}
    </div>
  )
}

/**
 * The shop's payment details inside a history row — the same block the order-placed screen
 * showed, for the customer who closed that page before their banking app had finished.
 *
 * Bound to the same statuses as the upload, so "how to pay" and "send the slip" appear and
 * disappear together. A settled order shows neither: bank details on a completed or cancelled
 * order read as a request to pay again.
 */
function Instructions({ merchant, status }: { merchant: Merchant; status?: string | null }) {
  if (!canUploadPaymentProof(status)) return null
  return <PaymentInstructions merchant={merchant} className="mb-2.5" />
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
  const courierLabel = courierName(courier) || courier
  return (
    <div className="mt-3">
      <div className="text-[11px] font-medium text-primary uppercase tracking-[0.09em] mb-1.5">
        {t('Tracking number', '物流单号')}
      </div>
      {/* A real field, not a line of text: truck + AWB on the left, the courier link as a button on
          the right — the shape a customer reads as "here is the number, tap to follow it". */}
      <div className="flex items-stretch gap-2 rounded-lg border border-border bg-card p-1 pl-3">
        <span className="flex flex-1 min-w-0 items-center gap-2">
          <Truck className="size-4 shrink-0 text-primary" strokeWidth={1.75} />
          <span className="font-mono text-[13px] text-foreground truncate">{awb}</span>
        </span>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-primary transition-colors hover:bg-brand-wash"
          >
            {t('Track', '追踪')}
            <ExternalLink className="size-3.5" strokeWidth={2} />
          </a>
        )}
      </div>
      {/* Which courier's site, and that it leaves the shop — a tracking link that silently hands
          off is a small surprise this one line removes. */}
      <div className="text-[12px] text-muted-foreground mt-1.5">
        {courierLabel} · {t("Track on the courier's website.", '在物流商网站追踪。')}
      </div>
    </div>
  )
}
