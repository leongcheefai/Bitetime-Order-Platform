import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Link } from 'react-router-dom'
import { useMerchant } from '../MerchantContext'
import { useSession } from '../SessionContext'
import { usePageVariants } from '../motion'
import { toast } from 'sonner'
import { fetchProducts, lookupProducts, placeOrder, fetchMerchantVoucher, lookupMerchantVoucher, voucherFullyUsed, notifyOrderPlacedRemote, productImageUrl, saveCustomerDetails } from '../store'
import { priceOrder, voucherError, shopRates, productFromRow, promoState, MAX_CART_QTY, MAX_CART_LINES, selectableDates, fulfilmentConfig, DEFAULT_TIMEZONE } from '@bitetime/shared'
import { prefillFromProfile, savedDetailsFromOrder } from '../savedDetails'
import { formatMoney } from '../currency'
import { formatUnit } from '../productUnit'
import { useServerClock } from '../serverClock'
import { lookupPostcode } from '../postcodes'
import { MY_STATES } from '../states-my'
import type { Product, Voucher, AddressParts } from '../types'
import LanguageSelect from '../components/LanguageSelect'
import ImageLightbox from '../components/ImageLightbox'
import SignInDialog from './SignInDialog'
import CheckoutGate, { GuestStrip } from './CheckoutGate'
import FulfilDatePicker from './FulfilDatePicker'
import { checkoutStep, readGuestChoice, rememberGuestChoice } from '../checkoutGate'
import { cn } from '@/lib/utils'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

const EMPTY_ADDRESS: AddressParts = { line1: '', postcode: '', city: '', state: '' }

interface CartLine {
  id: string
  name: string
  qty: number
  price: number
  // Which of a split pair this row is — the base and promo halves of the SAME product share an
  // `id`, so without this the two rows render identically and the arithmetic looks broken (a
  // "3 ×" row costing more than a "2 ×" row of the same thing, with nothing on screen to explain
  // why). See the `Promo` badge reused from the product card, below.
  promo: boolean
}

interface SuccessState {
  orderNumber: string
  items: CartLine[]
  subtotal: number
  fee: number
  discount: number
  total: number
}

/**
 * The three ways the server can refuse a voucher at checkout, each with something the
 * customer can actually do about it. Keyed by the backend's own error codes — these are a
 * wire contract, not prose (see OrderErrorCode in store.ts).
 *
 * Every one of them means the order was rolled back and NOTHING was written, so each message
 * has to end by asking for the order again, without the voucher.
 */
const VOUCHER_REFUSALS = {
  voucher_not_found: (t: (en: string, zh: string) => string) =>
    t('That voucher is no longer valid. Please place the order without it.', '该优惠券已失效，请不使用优惠券重新下单。'),
  voucher_already_used: (t: (en: string, zh: string) => string) =>
    t('You have already used this voucher. Please place the order without it.', '你已使用过此优惠券，请不使用优惠券重新下单。'),
  voucher_fully_used: (t: (en: string, zh: string) => string) =>
    t('This voucher has been fully claimed. Please place the order without it.', '此优惠券已被领完，请不使用优惠券重新下单。'),
  voucher_requires_account: (t: (en: string, zh: string) => string) =>
    t('Please sign in to use a voucher, then place the order again.', '使用优惠券需先登录，登录后请重新下单。'),
} as const

export default function Storefront() {
  const { merchant: merchantNullable } = useMerchant()
  const merchant = merchantNullable as NonNullable<typeof merchantNullable>
  const { lang, t, account, profile, refreshProfile } = useSession()
  const viewVariants = usePageVariants()

  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<Record<string, number>>({})        // { [productId]: qty }
  const [mode, setMode] = useState<'pickup' | 'delivery'>('pickup')  // 'pickup' | 'delivery'
  const [fulfilDate, setFulfilDate] = useState<string | null>(null)

  // Prefill is DERIVED, never copied into state by an effect. `null` means "the customer hasn't
  // touched this field", so a profile that arrives a beat after the page fills the form — while a
  // profile that arrives after they started typing cannot overwrite them. Typing wins, always,
  // which is also what keeps a prefilled field editable.
  const prefill = useMemo(() => prefillFromProfile(profile), [profile])
  const [nameInput, setNameInput] = useState<string | null>(null)
  const [waInput, setWaInput] = useState<string | null>(null)
  // Only the fields actually TOUCHED, not a whole replacement address. The profile resolves a beat
  // after the session does, and the form is live in that beat: holding a full address here would
  // mean one keystroke in `line1` froze all four fields at blank, because the object would already
  // be non-null when the saved address finally landed. Per field, typing wins — not per object.
  const [addressInput, setAddressInput] = useState<Partial<AddressParts> | null>(null)
  const name = nameInput ?? prefill.name ?? ''
  const wa = waInput ?? prefill.wa ?? ''
  const address = useMemo<AddressParts>(
    () => ({ ...EMPTY_ADDRESS, ...prefill.address, ...addressInput }),
    [prefill.address, addressInput],
  )
  // A functional updater, so the async postcode lookup cannot clobber a keystroke that landed
  // while it was in flight.
  const patchAddress = (patch: Partial<AddressParts>) => setAddressInput(prev => ({ ...prev, ...patch }))

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<SuccessState | null>(null)

  const [gallery, setGallery] = useState<Product | null>(null)
  const [signInOpen, setSignInOpen] = useState(false)

  const [voucherInput, setVoucherInput] = useState('')
  const [appliedVoucher, setAppliedVoucher] = useState<Voucher | null>(null)
  const [voucherMsg, setVoucherMsg] = useState('')
  const [voucherBusy, setVoucherBusy] = useState(false)

  const merchantId = merchant?.id
  const currency = merchant?.currency
  const slug = merchant?.slug

  // The guest choice is remembered per shop, so the gate is met once here and never again —
  // and a choice made at another shop cannot silence it at this one. `chosenAt` carries the
  // slug rather than a bare flag: this component can be reused across shops, and a bare flag
  // would follow the customer to the next storefront and swallow its gate.
  const [chosenAt, setChosenAt] = useState<string | null>(null)
  const guestRemembered = useMemo(() => (slug ? readGuestChoice(slug) : false), [slug])
  const guestChosen = guestRemembered || (!!slug && chosenAt === slug)
  const chooseGuest = () => {
    if (!slug) return
    rememberGuestChoice(slug)
    setChosenAt(slug)
  }

  const onPostcodeChange = async (raw: string) => {
    const pc = raw.replace(/\D/g, '').slice(0, 5)
    patchAddress({ postcode: pc })
    if (pc.length === 5) {
      const hit = await lookupPostcode(pc)
      if (hit) patchAddress({ postcode: pc, city: hit.city, state: hit.state })
    }
  }

  const activeProducts = products.filter(p => p.active)
  // The rates come from the SAME function the backend prices with: it commits at its own
  // total and refuses a quote that disagrees (`price_changed`), so a fallback that differed
  // by a ringgit would not be a display bug — it would refuse the checkout.
  const { WM: rateWM, EM: rateEM } = shopRates(merchant?.shipping)
  const baseDeliveryFee = rateWM // shown on the Delivery toggle before a state is known
  // The voucher's one-per-customer key — the account email, and nothing else. It must match
  // what the SERVER keys on (the JWT's email), or this pre-flight green-lights a claim the
  // server then refuses. A voucher requires an account: there is no guest key (#72).
  const voucherEntry = (account?.email ?? '').trim().toLowerCase()

  /**
   * The session can END under a mounted storefront — a SIGNED_OUT from another tab, a token
   * refresh that fails — and a voucher is keyed to an ACCOUNT (#72). So when the account goes,
   * the voucher must go with it.
   *
   * Nothing else here notices. The Voucher section tests `appliedVoucher` BEFORE `!account`, so
   * it would keep showing "Applied: CODE / Remove", and `priceOrder` would keep subtracting the
   * discount, for a customer who can no longer claim it: the backend refuses a guest's claim
   * outright (`voucher_requires_account`) and rolls the order back. Nothing commits, so this is
   * not a hole — it is a promise the checkout cannot keep, and the customer would only learn
   * that by submitting and eating the refusal.
   *
   * Reconciled during render against the account this voucher was applied under, not in an
   * effect: an effect would paint the stale discount first and take it back a frame later, and
   * `setState` in an effect is what the compiler's lint (rightly) refuses. Same instinct as
   * `adoptProducts` below — drop what can no longer be honoured at the moment the change
   * arrives, and SAY so rather than letting it vanish silently.
   */
  const [voucherAccount, setVoucherAccount] = useState(account)
  if (account !== voucherAccount) {
    setVoucherAccount(account)
    // Only a session that ENDED clears anything. `account` is a fresh object on every token
    // refresh, so an identity change with a still-signed-in customer must not confiscate their
    // voucher — and `undefined` (the session still resolving, at mount) can hold no voucher yet.
    if (!account && appliedVoucher) {
      setAppliedVoucher(null)
      setVoucherInput('')
      setVoucherMsg(t(
        `Signed out — the voucher ${appliedVoucher.code} was removed. Sign in again to use it.`,
        `已退出登录 — 优惠券 ${appliedVoucher.code} 已移除，请重新登录后使用。`,
      ))
    }
  }

  const productName = (p: Product) =>
    (lang === 'zh' && p.name_zh) ? p.name_zh : p.name
  const productDescr = (p: Product) =>
    (lang === 'zh' && p.descr_zh) ? p.descr_zh : (p.descr || '')

  /**
   * Take a freshly loaded menu — and DROP the cart entries it no longer sells, saying which.
   *
   * The pruning is the load-bearing half. The cart is what the browser POSTs, but the menu, the
   * summary and the quote are all built from `activeProducts` — so a product deactivated or
   * deleted mid-session leaves a cart entry that is invisible, has no −/+ control to remove it
   * with, and prices at nothing (`priceOrder` skips an id it cannot find). The backend refuses
   * the whole cart for it (`product_unavailable`), and without this the customer is trapped:
   * every retry re-sends the same unremovable id and is refused identically, forever, and only
   * a page reload gets them out. This is what makes that refusal's refetch RECOVER rather than
   * merely re-refuse.
   *
   * It happens HERE, where the menu arrives, and not in an effect watching it: every route by
   * which `products` can change goes through this function, and a `setCart` reacting to a render
   * would just be the same write one beat later.
   */
  const adoptProducts = (fresh: Product[]) => {
    setProducts(fresh)

    const gone = Object.keys(cart).filter(id => !fresh.some(p => p.id === id && p.active))
    if (gone.length === 0) return
    setCart(prev => {
      const next = { ...prev }
      for (const id of gone) delete next[id]
      return next
    })

    // A vanishing line is told, never silent — that would be the same bug wearing a nicer face.
    // A DEACTIVATED product is still in the rows (only `active` flipped), so it can be named; a
    // DELETED one is not, which is why the anonymous half of the message exists rather than a
    // name we would invent.
    //
    // A MIXED prune says both halves. Naming what we can and then throwing those names away
    // because one line came back unnameable would tell a customer who lost a cake and a coffee
    // strictly less than we know — and less than either of them alone would have been told.
    const names = gone
      .map(id => fresh.find(p => p.id === id))
      .filter((p): p is Product => !!p)
      .map(productName)
    const unnamed = gone.length - names.length
    const named = names.length > 0
      ? t(`Removed from your cart — no longer available: ${names.join(', ')}`,
          `已从购物车移除（已下架）：${names.join('、')}`)
      : ''
    const rest = unnamed > 0
      ? (unnamed === 1
          ? t('An item in your cart is no longer available and has been removed.',
              '购物车中有商品已下架，已为你移除。')
          : t(`${unnamed} items in your cart are no longer available and have been removed.`,
              `购物车中有 ${unnamed} 件商品已下架，已为你移除。`))
      : ''
    toast([named, rest].filter(Boolean).join(' '))
  }

  // The menu, loaded once per shop. It stands below adoptProducts because it calls it, and the
  // compiler's lint (rightly) refuses a hook that reaches back up for a value declared later.
  useEffect(() => {
    if (!merchantId) return
    fetchProducts(merchantId).then(adoptProducts)
    // adoptProducts is re-made every render, and depending on it would re-fetch the menu on each
    // one; the menu is a per-SHOP load. Its closure over `cart` is the mount's empty one, and
    // that is exactly right — nothing can be in the cart before the menu it is chosen from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId])

  // The SERVER's clock, not the device's — the promo window is priced on both sides of the wire and
  // a disagreement is a refusal. See serverClock.ts.
  const { now: serverNow, resync: resyncClock, adopt: adoptClock } = useServerClock()
  const now = serverNow()

  // The SHOP's window, on the SHOP's clock — `now` is the server-corrected time the same
  // breakdown prices with. The list is derived, never stored: a checkout left open across
  // midnight re-renders with yesterday dropped, so the customer cannot submit a date the
  // backend would refuse.
  const fulfilDates = useMemo(
    () => selectableDates(fulfilmentConfig(merchant.config), merchant.timezone ?? DEFAULT_TIMEZONE, now),
    [merchant.config, merchant.timezone, now],
  )
  // A date the shop stopped offering while the page sat open is not a selection any more.
  const chosenDate = fulfilDate && fulfilDates.includes(fulfilDate) ? fulfilDate : null

  // The menu, mapped once for the pricing rule: the rows arrive snake_cased from PostgREST and
  // `priceOrder` reads `promoPrice`. Unmapped, every promo silently prices at the base price here
  // and at the promo price on the backend — which is a refused checkout for every promo order.
  const pricedProducts = activeProducts.map(productFromRow)
  const promoById = new Map(pricedProducts.map(p => [p.id, promoState(p, now)]))

  // One pricing breakdown drives the summary, the order, and the success view.
  const bd = priceOrder({
    products: pricedProducts,
    cart,
    now,
    mode,
    state: mode === 'delivery' ? address.state : null,
    rates: { WM: rateWM, EM: rateEM },
    // Before a state is resolved, show the WM base estimate so the summary
    // matches the Delivery toggle instead of flashing RM 0.00; once the
    // postcode fills the state, region logic (WM/EM) takes over.
    //
    // This estimate is a DISPLAY fallback and nothing more, and what keeps it from becoming a
    // lie is `deliveryReady` below — which is now load-bearing for the PRICE, not just for form
    // validity. It is the only thing stopping a stateless delivery from being submitted: the
    // quote here would say WM, the backend derives its region from `address.state` and would
    // find none, and it refuses such an order outright (`delivery_state_required`) rather than
    // shipping it for free. Weaken the gate and the two sides diverge.
    resolvedShipping: mode === 'delivery' && !address.state ? baseDeliveryFee : undefined,
    voucher: appliedVoucher,
  })
  const cartItems: CartLine[] = bd.lines.map(l => ({ id: l.id, name: l.name, qty: l.qty, price: l.unitPrice, promo: l.promo }))
  const subtotal = bd.subtotal
  const discount = bd.discount
  const total = bd.total
  const fee = bd.shipping
  const deliveryReady =
    mode !== 'delivery' ||
    (address.line1.trim() !== '' &&
      address.postcode.length === 5 &&
      address.city.trim() !== '' &&
      address.state.trim() !== '')
  const canSubmit = cartItems.length > 0 && name.trim() !== '' && wa.trim() !== '' && !busy && deliveryReady && chosenDate !== null

  // The one decision that says whether this customer is ever asked to sign in. `account` is
  // `undefined` until the session resolves — 'pending' holds the checkout back for that beat
  // so a signed-in customer never sees the gate flash.
  const step = checkoutStep({ sessionLoading: account === undefined, signedIn: !!account, guestChosen })

  const applyVoucher = async () => {
    const code = voucherInput.trim().toUpperCase()
    if (!code) return
    // Validate against fresh DB state, not a page-load snapshot — otherwise a
    // customer who already redeemed this code (even earlier in this session)
    // sees a false "applied" that only fails at Place Order. Catch reuse here.
    setVoucherBusy(true)
    setVoucherMsg(t('Checking voucher…', '验证优惠券…'))
    const v = await fetchMerchantVoucher(merchant.id, code)
    setVoucherBusy(false)
    const err = voucherError(v, {
      userEmail: voucherEntry,
      fullyUsed: v ? voucherFullyUsed(v) : true,
    })
    if (err || !v) {
      setAppliedVoucher(null)
      setVoucherMsg(voucherErrorText(err ?? 'invalid'))
      return
    }
    setAppliedVoucher(v)
    const label = (v as any).type === 'percent' ? `${(v as any).value}% off` : `${formatMoney((v as any).value, currency)} off`
    setVoucherMsg(t(`✓ Voucher applied: ${label}`, `✓ 优惠券已应用：${label}`))
  }

  const removeVoucher = () => {
    setAppliedVoucher(null)
    setVoucherInput('')
    setVoucherMsg('')
  }

  function voucherErrorText(code: string): string {
    switch (code) {
      case 'invalid': return t('❌ Invalid voucher code.', '❌ 无效的优惠码。')
      case 'fully_used': return t('❌ This voucher has been fully redeemed.', '❌ 此优惠券已用完。')
      case 'already_used': return t('❌ You have already used this voucher.', '❌ 您已使用过此优惠券。')
      default: return ''
    }
  }

  /**
   * The cart's ceilings, MIRRORED from the backend — the same `MAX_CART_QTY`/`MAX_CART_LINES`
   * the intake route refuses on, imported from @bitetime/shared rather than retyped.
   *
   * They are enforced HERE, at the only place a cart can grow, so the UI cannot build a basket
   * the door will reject: an over-cap cart is refused with `invalid_body`, and a 400 at Place
   * Order is a dead end the customer cannot reason their way out of. Stopping them at the
   * ceiling, and SAYING so, turns a refusal into an instruction.
   *
   * Checked against `cart` in render scope rather than inside the updater: the toast is a side
   * effect, and setState updaters must stay pure (React may run one twice).
   */
  const updateQty = (productId: string, delta: number) => {
    const current = cart[productId] || 0
    const next = Math.max(0, current + delta)
    if (next === current) return

    if (next > MAX_CART_QTY) {
      toast(t(`You can order at most ${MAX_CART_QTY} of one item.`,
              `每种商品每单最多 ${MAX_CART_QTY} 件。`))
      return
    }
    // A new LINE, not a bigger one: only an id that is not in the cart yet can breach the
    // line cap, so raising an existing line is never blocked by it.
    if (current === 0 && Object.keys(cart).length >= MAX_CART_LINES) {
      toast(t(`You can order at most ${MAX_CART_LINES} different items in one order.`,
              `每单最多 ${MAX_CART_LINES} 种不同商品。`))
      return
    }

    setCart(prev => {
      if (next === 0) {
        const { [productId]: _removed, ...rest } = prev
        return rest
      }
      return { ...prev, [productId]: next }
    })
  }

  /**
   * Re-read everything the quote is built from: the products AND the applied voucher.
   *
   * Both are inputs to `priceOrder`, and the backend prices from its own fresh copy of both, so
   * a refusal that refreshed only the products left the other half of the quote stale — and a
   * stale input re-quotes to the same refused number on the next tap. A voucher that has since
   * been deleted comes back null and is dropped, said out loud rather than silently: the
   * customer can re-apply a code, but not one that no longer exists.
   *
   * IT ASKS WITH `lookupProducts`/`lookupMerchantVoucher`, AND THAT IS THE LOAD-BEARING PART.
   * This runs on the RECOVERY path — the one moment a connection is most likely to be flaky —
   * and everything it does is DESTRUCTIVE: `adoptProducts` deletes cart lines the menu no
   * longer has, and a null voucher is confiscated. The plain fetchers cannot report a failure
   * (supabase-js resolves `{ data: null, error }`, so `fetchProducts` returns `[]` and
   * `fetchMerchantVoucher` returns `null` — an ERROR wearing the face of an ANSWER), and
   * adopting that `[]` would empty the entire cart, blank the menu and blame the shop, for a
   * dropped packet. So: an answer we could not get changes NOTHING. The refusal costs a retry;
   * a wrong prune costs the order.
   */
  /**
   * @param serverNow - The backend's own clock, when the refusal that triggered this recovery
   * happened to carry one (`price_changed` only — see `OrderError.now` in store.ts). When
   * present, ADOPT it instead of re-fetching `/api/time`: that avoids a second network request
   * that can fail in exactly the way the first one just did (I-3, #69) — a browser whose
   * `/api/time` is persistently unreachable would otherwise `resync()`, fail again, and re-quote
   * against the still-skewed device clock, refused forever. When absent (`product_unavailable`,
   * or a `price_changed` from an older/unpatched backend), fall back to `resync()` as before.
   */
  const refreshQuoteSources = async (serverNow?: string) => {
    const code = appliedVoucher?.code ?? null
    // The clock is a quote input too, and the only one a menu refetch cannot repair: if the initial
    // sync failed we are pricing the promo window against the device's clock, and re-sending the
    // same quote would be refused identically, forever. AWAITED, alongside the other two quote
    // inputs: this function's callers await it and then let the customer retry — an un-awaited
    // resync/adopt landed the corrected offset a tick after the error toast, so an instant second
    // tap could eat a second `price_changed` refusal before the clock was actually fixed.
    const [freshProducts, voucher] = await Promise.all([
      lookupProducts(merchant.id).catch(() => null),
      code ? lookupMerchantVoucher(merchant.id, code).catch(() => ({ ok: false as const })) : null,
      serverNow ? Promise.resolve(adoptClock(serverNow)) : resyncClock(),
    ])
    // `[]` is an ANSWER — the shop really sells nothing, and pruning the whole cart is right.
    // `null` is the absence of one, and prunes nothing.
    // adoptProducts, not setProducts: a refusal that refreshed the menu but left the dead id in
    // the cart would be refused again on the very next tap.
    if (freshProducts) adoptProducts(freshProducts)
    if (voucher?.ok) {
      setAppliedVoucher(voucher.voucher)
      if (!voucher.voucher) {
        setVoucherMsg(t('❌ That voucher is no longer available.', '❌ 此优惠券已失效。'))
      }
    }
  }

  const handleSubmit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      // Re-validate the voucher against fresh DB state, not the page-load
      // snapshot — that snapshot never reflects this session's own redemption,
      // so a customer could otherwise re-apply and be granted the discount again
      // while used_by stayed at 1. On a fetch miss, fall through to the RPC guard.
      if (appliedVoucher) {
        const fresh = await fetchMerchantVoucher(merchant.id, appliedVoucher.code)
        if (fresh) {
          const verr = voucherError(fresh, {
            userEmail: voucherEntry,
            fullyUsed: voucherFullyUsed(fresh),
          })
          if (verr) {
            setAppliedVoucher(null)
            setVoucherMsg(voucherErrorText(verr))
            setError(voucherErrorText(verr))
            return
          }
          // ADOPT it, don't just read it. The fresh row is what the backend prices from — it
          // locks and reads that same row inside the transaction — so a merchant who edits the
          // voucher's amount mid-checkout leaves us quoting a discount that no longer exists,
          // and THIS attempt is refused (`price_changed`) whatever we do here: `quotedTotal` was
          // computed from the render that ran before this handler, and no setState can reach
          // back into a closure that has already captured it.
          //
          // What ends the loop is `refreshQuoteSources()` in the `price_changed` catch, whose
          // re-render makes the NEXT tap quote from fresh sources. This line is only a pre-warm
          // of that render — worth keeping, worthless alone. Do not read it as the fix and
          // delete the voucher half of refreshQuoteSources as redundant: that half IS the fix.
          setAppliedVoucher(fresh)
        }
      }
      // On a storefront every signed-in user is a customer, whatever role they hold elsewhere:
      // a shop owner buying lunch here is a customer, and a merchant ordering from their *own*
      // storefront gets the order attributed to themselves. That looks like a bug and isn't —
      // they can already read it as the owner.
      // One call. The order number, the order row and the voucher claim commit together in a
      // transaction server-side, so there is no second call whose failure could hand out a
      // discount on a voucher that was never marked used.
      const result = await placeOrder({
        merchantId: merchant.id,
        customerName: name.trim(),
        customerWa: wa.trim(),
        mode,
        address: mode === 'delivery' ? address : '',
        // What they want, and what they saw. Never what it costs: the shop's own rows are the
        // only thing that may say that, and `bd` is only ever a quote.
        cart: Object.fromEntries(Object.entries(cart).filter(([, qty]) => qty > 0)),
        quotedTotal: total,
        voucherCode: appliedVoucher?.code ?? null,
        fulfilDate: chosenDate,
      })
      // Remember what they typed, silently, so they never type it again — at this shop or any
      // other. Best-effort and unawaited: the order is already placed, and a profile write that
      // fails must cost the customer a retype next time, never their order. A guest saves nothing
      // (`saveCustomerDetails` checks the session itself), which is what keeps the gate honest.
      if (account) {
        saveCustomerDetails(savedDetailsFromOrder({ mode, wa, address }))
          .then(refreshProfile) // so a second order in this same session prefills too
          .catch(() => {})
      }
      // Best-effort server-side Telegram notify; never blocks a placed order.
      await notifyOrderPlacedRemote(merchant.id, result.orderNumber).catch(() => {})
      setSuccess({ orderNumber: result.orderNumber, items: cartItems, subtotal, fee, discount, total })
      toast.success(t('Order placed!', '订单已提交！'))
    } catch (err: any) {
      // A refused order wrote NOTHING — the transaction rolled back. So for the three voucher
      // refusals the honest thing is to drop the voucher and tell them to place the order
      // again without it: the discount they were promised is gone, but the order is theirs to
      // retry. Saying "failed, try again" while silently keeping a voucher the server has
      // already refused would just fail them again, forever.
      const code: string | undefined = err?.code
      const voucherRefusal = VOUCHER_REFUSALS[code as keyof typeof VOUCHER_REFUSALS]
      if (voucherRefusal) {
        setAppliedVoucher(null)
        setVoucherMsg(voucherRefusal(t))
        setError(voucherRefusal(t))
        toast.error(voucherRefusal(t))
      } else if (code === 'merchant_inactive' || code === 'merchant_not_found') {
        const msg = t('This shop is not taking orders right now.', '本店目前暂不接单。')
        setError(msg)
        toast.error(msg)
      } else if (code === 'price_changed') {
        // The shop's prices moved while they were checking out. NOTHING was written. Show them
        // the new numbers and let them decide — charging the new total silently would bill a
        // number they never agreed to, and honouring the stale one would let an old quote buy a
        // discount the shop withdrew.
        //
        // The VOUCHER is re-read alongside the products, and it has to be: an edited
        // `vouchers.amount` moves the total exactly as an edited price does, and re-quoting from
        // the stale voucher would be refused again on the very next tap — the same refusal loop,
        // forever, until the customer thought to remove and re-apply the code themselves.
        //
        // `err.now` (I-3, #69): this refusal is itself proof the connection to the backend
        // works, and it carries the backend's own clock — so recovery adopts THAT instead of
        // re-fetching `/api/time`, which is exactly the request that can be persistently
        // unreachable in the scenario this whole mechanism exists to fix.
        await refreshQuoteSources(err?.now)
        const msg = t(
          'Prices at this shop just changed. Please review your order and place it again.',
          '本店价格刚刚有所调整，请确认订单后重新下单。',
        )
        setError(msg)
        toast.error(msg)
      } else if (code === 'product_unavailable') {
        // Something in the cart stopped being on sale mid-checkout. Refetching is what RECOVERS
        // the checkout, not just what refreshes the menu: `adoptProducts` takes the new menu and
        // drops the cart ids that are gone, saying which. Without that, the invisible id stayed
        // in the cart and every retry was refused identically.
        await refreshQuoteSources()
        const msg = t(
          'Something in your cart is no longer available. It has been removed — please review your order and place it again.',
          '购物车中有商品已下架，已为你移除，请确认订单后重新下单。',
        )
        setError(msg)
        toast.error(msg)
      } else if (code === 'delivery_state_required') {
        // Unreachable from this form — `deliveryReady` will not let a stateless delivery be
        // submitted — and it is here precisely because that gate is the ONLY thing making it so.
        // A delivery with no state is priced at zero shipping, which is why the backend refuses
        // it rather than quietly eating the fee.
        const msg = t(
          'Please choose the state you are delivering to.',
          '请选择送货的州属。',
        )
        setError(msg)
        toast.error(msg)
      } else if (code === 'fulfil_date_unavailable' || code === 'fulfil_date_required') {
        // `fulfil_date_required` is unreachable from this form — `canSubmit` will not let a
        // dateless order be submitted — and it is here precisely because that gate is the ONLY
        // thing making it so. `fulfil_date_unavailable` IS reachable honestly: a checkout left
        // open past midnight, or a merchant who closed a day mid-checkout. Clearing the
        // selection is what recovers it, since the re-render drops the stale date from the grid.
        setFulfilDate(null)
        const msg = t(
          'Please choose a date for your order.',
          '请选择订单日期。',
        )
        setError(msg)
        toast.error(msg)
      } else if (code === 'invalid_body') {
        // The door refused the SHAPE of the order, not the order — almost always a cart past
        // the caps, which `updateQty` now stops at, so an honest checkout should never get
        // here. It is a permanent refusal: retrying the same cart is refused identically. Say
        // what would change it, in words. Without this branch the customer read the literal
        // string `invalid_body` on the checkout screen — `OrderError`'s `super(code)` puts the
        // wire code in `err.message`, and the final `else` renders it.
        const msg = t(
          `Your order is too large. Please order at most ${MAX_CART_QTY} of any one item, and at most ${MAX_CART_LINES} different items.`,
          `订单过大。每种商品最多 ${MAX_CART_QTY} 件，每单最多 ${MAX_CART_LINES} 种不同商品。`,
        )
        setError(msg)
        toast.error(msg)
      } else if (code === 'network') {
        // The request never landed, so no order exists and retrying is safe to suggest.
        const msg = t('Could not reach the shop. Check your connection and try again.', '无法连接店铺，请检查网络后重试。')
        setError(msg)
        toast.error(msg)
      } else {
        setError(err.message || t('Failed to place order. Please try again.', '下单失败，请重试。'))
        toast.error(t('Failed to place order. Please try again.', '下单失败，请重试。'))
      }
    } finally {
      setBusy(false)
    }
  }

  // "Place another order": clear the cart, and hand the fields back to the profile rather than to
  // blank — a signed-in customer's second order of the day should not make them retype either.
  const handleReset = () => {
    setSuccess(null)
    setCart({})
    setNameInput(null)
    setWaInput(null)
    setAddressInput(null)
    setError(null)
    removeVoucher()
  }

  return (
    <AnimatePresence mode="wait">
      {success ? (
        // ── Success view ──────────────────────────────────────────────────────
        <motion.div key="success" className="form-wrap" variants={viewVariants} initial="initial" animate="animate" exit="exit">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 mb-8 max-[480px]:flex-col max-[480px]:gap-2">
            <div>
              <h1 className="font-heading text-[26px] font-medium text-oxblood tracking-[0.3px]">{merchant.name}</h1>
            </div>
            <div className="flex justify-end flex-shrink-0 max-[480px]:justify-start">
              <LanguageSelect />
            </div>
          </div>

          {/* Success content */}
          <div className="text-center py-12 px-6">
            <h2 className="font-heading text-[24px] font-medium text-oxblood mb-2">
              {t('Order Placed!', '订单已提交！')}
            </h2>
            <p className="text-[14px] text-rose-muted mb-6 leading-[1.6]">
              {t('Thank you for your order.', '感谢您的订单。')}
            </p>
            <p className="text-[15px] text-oxblood mb-3 tracking-[0.5px]">
              {t('Order number', '订单号')}:<br />
              <strong className="font-mono text-[16px]">{success.orderNumber}</strong>
            </p>

            <div className="max-w-[360px] mx-auto mb-5 text-left px-4 py-3 bg-surface-raised border-[1.5px] border-divider rounded-md">
              {success.items.map((item, i) => (
                <div key={i} className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                  {/* min-w-0 (not shrink-0): a long product name must wrap inside its own column.
                      shrink-0 let it push the price out past the card's right edge. */}
                  <span className="min-w-0 flex items-center gap-1.5 flex-wrap">
                    {item.name} × {item.qty}
                    {item.promo && (
                      <span className="px-1.5 py-0.5 rounded-full bg-oxblood text-white text-[10px] leading-[14px] font-medium">
                        {t('Promo', '优惠')}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(item.price * item.qty, currency)}</span>
                </div>
              ))}
              {success.fee > 0 && (
                <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                  <span className="min-w-0">{t('Delivery fee', '送货费')}</span>
                  <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(success.fee, currency)}</span>
                </div>
              )}
              {success.discount > 0 && (
                <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                  <span className="min-w-0">{t('Voucher', '优惠券')}</span>
                  <span className="shrink-0 text-right whitespace-nowrap">−{formatMoney(success.discount, currency)}</span>
                </div>
              )}
              <div className="flex justify-between items-start gap-2 text-[15px] font-medium text-ink border-t border-rose-border mt-2 pt-[10px]">
                <span className="min-w-0">{t('Total', '总计')}</span>
                <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(success.total, currency)}</span>
              </div>
            </div>

            {(merchant.payment_note || merchant.payment_bank) && (
              <div className="max-w-[360px] mx-auto mb-4 text-left px-[14px] py-[10px] bg-surface-raised border-[1.5px] border-divider rounded-md text-[13px] text-ink-faint leading-[1.5]">
                <div className="font-semibold text-oxblood mb-1">
                  {t('Payment Instructions', '付款说明')}
                </div>
                {merchant.payment_bank && <p>{merchant.payment_bank}</p>}
                {merchant.payment_note && (
                  <p className={cn("whitespace-pre-line", merchant.payment_bank && "mt-[6px]")}>
                    {merchant.payment_note}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-col items-center gap-2 mt-5">
              <Link to={`/s/${merchant.slug}/track`} className="text-[13px] text-oxblood font-medium underline">
                {t('Track your order', '追踪订单')}
              </Link>
              <button type="button" className="text-[13px] text-rose-muted cursor-pointer underline inline-block" onClick={handleReset}>
                {t('Place another order', '再下一单')}
              </button>
            </div>
          </div>
        </motion.div>
      ) : (
        // ── Order form ──────────────────────────────────────────────────────
        <motion.div key="form" className="form-wrap" variants={viewVariants} initial="initial" animate="animate" exit="exit">
          {/* Header with lang switch */}
          <div className="flex items-start justify-between gap-4 mb-8 max-[480px]:flex-col max-[480px]:gap-2">
            <div>
              <h1 className="font-heading text-[26px] font-medium text-oxblood tracking-[0.3px]">{merchant.name}</h1>
              <p className="font-heading text-[13px] italic text-rose-muted mt-[5px]">
                {t('Powered by TinyOrder', 'TinyOrder 提供技术支持')}
              </p>
              <div className="flex items-center gap-3 mt-1">
                {account ? (
                  // History carries the courier and AWB inline, so it is already everything /track
                  // would say and more. Offering both here asked the customer to tell apart two
                  // links that do the same job, and pointed one of them at a form demanding an
                  // order number they can already see.
                  <Link to={`/s/${merchant.slug}/orders`} className="text-[12px] text-oxblood underline inline-block">
                    {t('Your orders', '你的订单')}
                  </Link>
                ) : (
                  <>
                    {/* The guest's entry point, and their only one: a guest order is stamped with a
                        null user_id and can never appear in any history. */}
                    <Link to={`/s/${merchant.slug}/track`} className="text-[12px] text-oxblood underline inline-block">
                      {t('Track an order', '追踪订单')}
                    </Link>
                    <button
                      type="button"
                      onClick={() => setSignInOpen(true)}
                      className="text-[12px] text-oxblood underline inline-block cursor-pointer"
                    >
                      {t('Sign in', '登录')}
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="flex justify-end flex-shrink-0 max-[480px]:justify-start">
              <LanguageSelect />
            </div>
          </div>

          <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />

          {/* Product list */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">{t('Menu', '菜单')}</div>
            {activeProducts.length === 0 ? (
              <p className="text-[14px] text-rose-muted italic py-6 text-center">
                {t('This shop has no products yet.', '此店暂无商品。')}
              </p>
            ) : (
              <div className="flex flex-col gap-[10px]">
                {activeProducts.map(p => (
                  <div
                    key={p.id}
                    className={cn(
                      "flex items-center gap-[14px] px-4 py-[14px] bg-surface-raised border-[1.5px] border-clay-border rounded-xl transition-colors",
                      (cart[p.id] || 0) > 0 && "border-oxblood bg-oxblood-tint"
                    )}
                  >
                    {p.image_urls?.length ? (
                      <button
                        type="button"
                        onClick={() => setGallery(p)}
                        aria-label={t('View photos', '查看图片')}
                        className="size-14 shrink-0 rounded-lg overflow-hidden border-[1.5px] border-clay-border cursor-pointer relative"
                      >
                        <img src={productImageUrl(p.image_urls[0])} alt="" className="size-full object-cover" />
                        {p.image_urls.length > 1 && (
                          <span className="absolute bottom-0.5 right-0.5 px-1 rounded-full bg-oxblood/85 text-white text-[10px] leading-[14px]">
                            {p.image_urls.length}
                          </span>
                        )}
                      </button>
                    ) : null}
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-medium text-ink">{productName(p)}</div>
                      {productDescr(p) && (
                        <div className="text-[12px] text-rose-muted mt-0.5 leading-[1.4]">{productDescr(p)}</div>
                      )}
                      {(() => {
                        const promo = promoById.get(p.id)
                        const unit = formatUnit(p.unit_quantity, p.unit || t('unit', '个'))
                        // `promo.remaining` is the page-load snapshot — it never moves as the
                        // customer adds units, so with 3 left and 3 already in the cart it kept
                        // saying "3 left" right up to the tap that priced at base. `bd.lines` is
                        // the one place that already knows how many promo units THIS cart has
                        // claimed (the cap binds inside `priceOrder`, per unit), so subtracting it
                        // here is what makes the count describe the NEXT unit rather than the
                        // page-load count — and keeps it honest with what the summary shows below.
                        //
                        // Hoisted ABOVE the `!promo` fallback (I-1): the card must show the price
                        // of the NEXT unit the customer would add, not the product's promo status.
                        // Once `remainingForNextUnit` hits 0 the cap is exhausted for this cart —
                        // the next tap prices at base — so the card must fall through to the same
                        // plain base-price display a non-promo product gets, badge and strike-
                        // through and all, or it advertises a price the backend will refuse.
                        const claimed = promo ? (bd.lines.find(l => l.id === p.id && l.promo)?.qty ?? 0) : 0
                        const remainingForNextUnit = promo && Number.isFinite(promo.remaining)
                          ? promo.remaining - claimed
                          : Infinity
                        if (!promo || remainingForNextUnit <= 0) {
                          return (
                            <div className="text-[13px] font-medium text-oxblood mt-[5px]">
                              {formatMoney(p.price, currency)} / {unit}
                            </div>
                          )
                        }
                        return (
                          <div className="flex items-center gap-2 mt-[5px] flex-wrap">
                            <span className="text-[13px] font-medium text-oxblood">
                              {formatMoney(promo.price, currency)} / {unit}
                            </span>
                            <span className="text-[12px] text-rose-muted line-through">
                              {formatMoney(p.price, currency)}
                            </span>
                            <span className="px-1.5 py-0.5 rounded-full bg-oxblood text-white text-[10px] leading-[14px] font-medium">
                              {t('Promo', '优惠')}
                            </span>
                            {Number.isFinite(remainingForNextUnit) && (
                              <span className="text-[11px] text-rose-muted">
                                {t(`${remainingForNextUnit} left at this price`, `此价格剩 ${remainingForNextUnit} 件`)}
                              </span>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="soft"
                        size="iconRound"
                        className="text-[16px] pointer-coarse:size-11 pointer-coarse:text-[18px]"
                        onClick={() => updateQty(p.id, -1)}
                        aria-label={t('Decrease quantity', '减少数量')}
                      >−</Button>
                      <span
                        className="text-[14px] font-medium min-w-[20px] pointer-coarse:min-w-[28px] text-center text-ink"
                        aria-live="polite"
                        aria-label={t('Quantity', '数量')}
                      >{cart[p.id] || 0}</span>
                      <Button
                        variant="soft"
                        size="iconRound"
                        className="text-[16px] pointer-coarse:size-11 pointer-coarse:text-[18px]"
                        onClick={() => updateQty(p.id, 1)}
                        aria-label={t('Increase quantity', '增加数量')}
                      >+</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <ImageLightbox
            key={gallery?.id}
            paths={gallery?.image_urls ?? []}
            open={!!gallery}
            onOpenChange={o => { if (!o) setGallery(null) }}
            title={gallery ? productName(gallery) : undefined}
            t={t}
          />

          <hr className="border-0 border-t border-clay-border my-6" />

          {/* Fulfilment */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">{t('Fulfilment', '配送方式')}</div>
            <div className="flex gap-[10px]" role="group" aria-label={t('Fulfilment method', '配送方式')}>
              <button
                type="button"
                className={cn(
                  "flex-1 border rounded-md py-[10px] px-[14px] pointer-coarse:min-h-11 cursor-pointer text-[14px] font-sans text-center transition-all hover:border-oxblood focus-visible:outline-2 focus-visible:outline-oxblood focus-visible:outline-offset-2",
                  mode === 'pickup'
                    ? "border-[1.5px] border-oxblood bg-oxblood-tint text-oxblood font-medium"
                    : "border-clay-border bg-surface-raised text-ink"
                )}
                aria-pressed={mode === 'pickup'}
                onClick={() => setMode('pickup')}
              >
                {t('Pickup', '自取')}
              </button>
              <button
                type="button"
                className={cn(
                  "flex-1 border rounded-md py-[10px] px-[14px] pointer-coarse:min-h-11 cursor-pointer text-[14px] font-sans text-center transition-all hover:border-oxblood focus-visible:outline-2 focus-visible:outline-oxblood focus-visible:outline-offset-2",
                  mode === 'delivery'
                    ? "border-[1.5px] border-oxblood bg-oxblood-tint text-oxblood font-medium"
                    : "border-clay-border bg-surface-raised text-ink"
                )}
                aria-pressed={mode === 'delivery'}
                onClick={() => setMode('delivery')}
              >
                {t('Delivery', '送货')} (+{formatMoney(baseDeliveryFee, currency)})
              </button>
            </div>
            {mode === 'pickup' && merchant?.pickup_address && (
              <div className="flex flex-col gap-1.5 mt-3">
                <div className="text-[13px] font-medium text-oxblood">{t('Pickup address', '自取地址')}</div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(merchant.pickup_address)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[14px] text-oxblood whitespace-pre-line leading-[1.5] underline decoration-oxblood/30 underline-offset-2 hover:decoration-oxblood transition-colors"
                >
                  {merchant.pickup_address}
                </a>
              </div>
            )}
            {mode === 'delivery' && (
              <div className="flex flex-col gap-3 mt-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sf-line1">{t('Address line', '地址')}</Label>
                  <Input
                    id="sf-line1"
                    value={address.line1}
                    onChange={e => patchAddress({ line1: e.target.value })}
                    placeholder={t('Street, building, unit…', '街道、建筑、单位…')}
                  />
                </div>
                <div className="flex gap-3">
                  <div className="flex flex-col gap-1.5 w-1/3">
                    <Label htmlFor="sf-postcode">{t('Postcode', '邮编')}</Label>
                    <Input
                      id="sf-postcode"
                      value={address.postcode}
                      onChange={e => onPostcodeChange(e.target.value)}
                      inputMode="numeric"
                      maxLength={5}
                      placeholder="43000"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 flex-1">
                    <Label htmlFor="sf-city">{t('City', '城市')}</Label>
                    <Input
                      id="sf-city"
                      value={address.city}
                      onChange={e => patchAddress({ city: e.target.value })}
                      placeholder={t('City', '城市')}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sf-state">{t('State', '州属')}</Label>
                  <select
                    id="sf-state"
                    value={address.state}
                    onChange={e => patchAddress({ state: e.target.value })}
                    className="w-full min-w-0 rounded-md border border-clay-border bg-surface-raised px-[13px] py-2.5 text-[16px] text-ink transition-colors outline-none focus-visible:border-oxblood focus-visible:ring-3 focus-visible:ring-oxblood/10"
                  >
                    <option value="">{t('Select state…', '选择州属…')}</option>
                    {MY_STATES.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          <hr className="border-0 border-t border-clay-border my-6" />

          {/* When */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">
              {t('Date', '日期')} *
            </div>
            <FulfilDatePicker
              available={fulfilDates}
              value={chosenDate}
              onChange={setFulfilDate}
              t={t}
              lang={lang}
            />
          </div>

          <hr className="border-0 border-t border-clay-border my-6" />

          {/* The gate stands where the checkout form would be, and replaces it top to bottom:
              details, voucher, summary, Place Order. The cart above it is untouched, so it
              survives the gate — and survives signing in through it, since AuthPanel never
              leaves the page. 'pending' renders neither: it is one beat of a resolving session. */}
          {step === 'pending' ? null : step === 'gate' ? (
            <CheckoutGate onGuest={chooseGuest} />
          ) : (
          <>
          {/* Customer details */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">{t('Your Details', '您的资料')}</div>
            {step === 'guest' && <GuestStrip onSignIn={() => setSignInOpen(true)} />}
            <div className="flex flex-col gap-1.5 mb-3">
              <Label htmlFor="sf-name">{t('Name', '姓名')} *</Label>
              <Input
                id="sf-name"
                type="text"
                value={name}
                onChange={e => setNameInput(e.target.value)}
                placeholder={t('Full name', '全名')}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sf-wa">{t('WhatsApp', 'WhatsApp')} *</Label>
              <Input
                id="sf-wa"
                type="tel"
                value={wa}
                onChange={e => setWaInput(e.target.value)}
                placeholder={t('e.g. 601X-XXXXXXX', '例：601X-XXXXXXX')}
              />
            </div>
          </div>

          <hr className="border-0 border-t border-clay-border my-6" />

          {/* Voucher */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em] mb-3">{t('Voucher', '优惠券')}</div>
            {!account ? (
              // A voucher is keyed to a verified account, so a guest cannot carry one (#72).
              // This is an OFFER, not a gate: the checkout path itself is untouched and guest
              // checkout is still one tap. You just cannot bring a discount through it.
              //
              // `!account` is asked FIRST, before `appliedVoucher`. The reconciliation above
              // already clears the voucher when the session ends, so the two can never disagree
              // — but asked the other way round, a signed-out customer holding an applied
              // voucher was shown "Applied: CODE" for a discount the backend would refuse. The
              // branch that decides is the one that cannot be wrong.
              <button
                type="button"
                onClick={() => setSignInOpen(true)}
                className="text-[13px] text-rose-muted cursor-pointer underline inline-block hover:text-oxblood"
              >
                {t('Sign in to use a voucher', '登录后可使用优惠券')}
              </button>
            ) : appliedVoucher ? (
              <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                <span className="shrink-0">{t('Applied', '已应用')}: <strong>{appliedVoucher.code}</strong></span>
                <button type="button" className="text-[13px] text-rose-muted cursor-pointer underline mt-5 inline-block" onClick={removeVoucher}>
                  {t('Remove', '移除')}
                </button>
              </div>
            ) : (
              <div className="flex items-stretch gap-2">
                <Input
                  type="text"
                  value={voucherInput}
                  onChange={e => setVoucherInput(e.target.value)}
                  placeholder={t('Enter voucher code', '输入优惠码')}
                  className="flex-1 min-w-0"
                />
                <Button
                  size="sm"
                  disabled={voucherBusy}
                  className="pointer-coarse:min-h-11"
                  onClick={applyVoucher}
                >
                  {voucherBusy ? t('Checking…', '验证中…') : t('Apply', '应用')}
                </Button>
              </div>
            )}
            {voucherMsg && (
              <p className="mt-2 text-[13px]">{voucherMsg}</p>
            )}
          </div>

          <hr className="border-0 border-t border-clay-border my-6" />

          {/* Live order summary */}
          <div className="bg-oxblood-tint border border-rose-border rounded-xl py-4 px-5 mb-6">
            <div className="font-heading text-[14px] font-medium text-oxblood mb-[10px]">
              {t('Order Summary', '订单摘要')}
            </div>
            {cartItems.length === 0 ? (
              <p className="text-[13px] text-text-tertiary italic">
                {t('No items selected yet.', '尚未选择任何商品。')}
              </p>
            ) : (
              <>
                {cartItems.map((item, i) => {
                  const prod = activeProducts.find(p => p.id === item.id)
                  const displayName = (lang === 'zh' && prod?.name_zh) ? prod.name_zh : item.name
                  return (
                    <div key={i} className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                      {/* min-w-0, not shrink-0 — see the success view's line items (#92). */}
                      <span className="min-w-0 flex items-center gap-1.5 flex-wrap">
                        {displayName} × {item.qty}
                        {item.promo && (
                          <span className="px-1.5 py-0.5 rounded-full bg-oxblood text-white text-[10px] leading-[14px] font-medium">
                            {t('Promo', '优惠')}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(item.price * item.qty, currency)}</span>
                    </div>
                  )
                })}
                <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                  <span className="min-w-0">{t('Subtotal', '小计')}</span>
                  <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(subtotal, currency)}</span>
                </div>
                {mode === 'delivery' && (
                  <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                    <span className="min-w-0">{t('Delivery fee', '送货费')}</span>
                    <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(fee, currency)}</span>
                  </div>
                )}
                {discount > 0 && (
                  <div className="flex justify-between items-start gap-2 text-sm text-rose-muted py-[3px]">
                    <span className="min-w-0">{t('Voucher', '优惠券')} ({appliedVoucher?.code})</span>
                    <span className="shrink-0 text-right whitespace-nowrap">−{formatMoney(discount, currency)}</span>
                  </div>
                )}
                <div className="flex justify-between items-start gap-2 text-[15px] font-medium text-ink border-t border-rose-border mt-2 pt-[10px]">
                  <span className="min-w-0">{t('Total', '总计')}</span>
                  <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(total, currency)}</span>
                </div>
              </>
            )}
          </div>

          {error && (
            <div className="text-[13px] text-danger bg-rose-pale border border-danger-border rounded-md px-[13px] py-[10px] mb-[10px] leading-[1.5]">
              {error}
            </div>
          )}

          <Button
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="disabled:opacity-60 active:scale-[0.99]"
          >
            {busy ? t('Placing order…', '提交中…') : t('Place Order', '提交订单')}
          </Button>
          </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
