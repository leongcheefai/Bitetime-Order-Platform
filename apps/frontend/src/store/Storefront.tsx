import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMerchant } from '../MerchantContext'
import { useSession } from '../SessionContext'
import { useEnterTransition } from '../motion'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { lookupProducts, placeOrder, lookupMerchantVoucher, voucherFullyUsed, notifyOrderPlacedRemote, saveCustomerDetails, fetchGuestInvoice, fetchMyInvoice, reviewMyOrder, reviewGuestOrder } from '../store'
import { orderRefusalPlan, quoteRefusalPlan, type RefusalAction } from './orderRefusal'
import { noticeText, type Notice } from './notice'
import { useDeliveryQuote } from './useDeliveryQuote'
import { submitGate } from './submitGate'
import { pruneCart, pruneMessage, nextCart, repairCart, plainQty, cartRefusalMessage } from './cartRules'
import type { CartTarget } from './cartRules'
import { canIssueInvoice, priceOrder, voucherError, shopRates, shopTax, shopDistance, shopMethods, firstOfferedMethod, FULFILMENT_METHODS, productFromRow, optionGroupsFromRow, menuCategoriesFromRow, cartLineKey, promoState, selectableDates, fulfilmentConfig, DEFAULT_TIMEZONE } from '@bitetime/shared'
import type { FulfilmentMethod, CartLine, PickSnapshot } from '@bitetime/shared'
import { prefillFromProfile, savedDetailsFromOrder, carriesAddress } from '../savedDetails'
import { fulfilmentLabel, feeLineLabel } from '../fulfilmentLabel'
import { formatMoney, DEFAULT_CURRENCY } from '../currency'
// The SHOP's pixel, never TinyOrder's (#220). A no-op unless this shop set an id, is on Pro, and
// its customer accepted — so nothing here has to ask any of those three questions.
import { useShopPixelTrack } from '../pixels/ShopPixels'
import { formatTaxRate } from '../taxRate'
import { formatUnit } from '../productUnit'
import { productName as label, productDescr as descr, shopDescr } from '../productLabel'
import { menuSections } from '../menuGroups'
import { useServerClock } from '../serverClock'
import { lookupPostcode } from '../postcodes'
import { MY_STATES } from '../states-my'
import type { Product, Voucher, AddressParts } from '../types'
import LanguageSelect from '../components/LanguageSelect'
import ImageLightbox from '../components/ImageLightbox'
import InvoiceButton from '../components/InvoiceButton'
import MenuRow from '../components/MenuRow'
import SignInDialog from './SignInDialog'
import { OptionPicker } from './OptionPicker'
import { ItemSelections } from '../ItemSelections'
import CheckoutGate, { GuestStrip } from './CheckoutGate'
import FulfilDatePicker from './FulfilDatePicker'
import AddressAutocomplete from './AddressAutocomplete'
import MoneyLine from './MoneyLine'
import PaymentProofUpload from './PaymentProofUpload'
import PaymentInstructions from './PaymentInstructions'
import OrderReviewCard from './OrderReviewCard'
import { checkoutStep, readGuestChoice, rememberGuestChoice } from '../checkoutGate'
import { cn } from '@/lib/utils'
import { formatCalendarDate } from '../orderDate'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'

const EMPTY_ADDRESS: AddressParts = { line1: '', postcode: '', city: '', state: '' }

/**
 * A priced line for DISPLAY. Renamed off `CartLine` in #145: that name now means what the
 * customer put in the cart (`{productId, qty, selections}`), and one name for both is what the
 * promo split was already straining.
 */
interface ReceiptLine {
  /**
   * The CART LINE this row was priced from. Absent for an extra line, which has no cart entry.
   * NOT the product id: a promo split renders one cart line as two rows that must remove
   * together, and one product holds several lines once its options differ.
   */
  key?: string
  /** The options chosen on it, resolved — so the row says what the customer actually ordered. */
  selections?: PickSnapshot[]
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
  orderId: string
  orderNumber: string
  items: ReceiptLine[]
  subtotal: number
  fee: number
  discount: number
  taxAmount: number
  taxRate: number
  total: number
  /**
   * The distance the fee above was actually derived from — the SAME value the live summary
   * labelled its own fee with a tap earlier, so the confirmation the customer keeps reconciles
   * with what they agreed to instead of naming no distance at all (#101 review, Finding 7).
   * `null` for a pickup order, a region-priced order, or a distance order the summary never
   * priced (which `canSubmit` already refuses).
   */
  feeKm: number | null
  /**
   * The date they asked for, echoed back. `null` only defensively — `canSubmit` will not let a
   * dateless order be submitted, so a placed order always has one.
   */
  fulfilDate: string | null
  /**
   * The status intake assigned, READ BACK rather than re-derived here.
   *
   * It decides whether this screen can offer the invoice at all: an order at a shop taking manual
   * payment is born `pending_payment`, and that order has no invoice yet. The rule for which
   * shops those are ("has bank, note or QR") is stated in the INSERT that writes the status, and
   * a second copy on this screen would be a rule that can disagree with the row it describes.
   */
  status: string
}

export default function Storefront() {
  const { merchant: merchantNullable, refresh: refreshMerchant } = useMerchant()
  const merchant = merchantNullable as NonNullable<typeof merchantNullable>
  const { lang, t, account, profile, refreshProfile } = useSession()
  // ?preview=1 — the shop, without the order form. Read by the sample-shop screenshot sweep
  // (apps/backend/scripts/captureSampleShopScreenshots.ts) so the card on /sample-shops shows a
  // menu rather than sign-in links, a language picker and an empty date calendar, which is what
  // a 390x844 capture of the real page is mostly made of.
  //
  // PRESENTATION ONLY, and it must stay that way. Nothing below branches on it: the cart still
  // works, the totals still price, the submit still submits. It hides chrome through one CSS rule
  // in index.css and hides nothing that decides anything, so a customer who somehow arrives with
  // the parameter is looking at a shop, not at a different application. Making it a mode with its
  // own code path is how a marketing screenshot ends up able to break a real checkout.
  const [searchParams] = useSearchParams()
  const preview = searchParams.get('preview') === '1'
  // Enter-only, and deliberately not inside an AnimatePresence: an exit-gated swap between the
  // form and the success view would never complete in a backgrounded tab — a customer who
  // switched to their banking app to pay would come back to a storefront frozen mid-order.
  const enterView = useEnterTransition()

  const [products, setProducts] = useState<Product[]>([])
  // WHICH shop's menu request has answered — not "are there products", and a shop id rather
  // than a flag so that switching shops un-answers it without a synchronous reset in the effect
  // below. It gates the sample-shop capture marker and nothing else: an empty menu and a menu
  // that has not arrived yet render identically, and the sweep was photographing the second one.
  const [answeredFor, setAnsweredFor] = useState<string | null>(null)
  const [cart, setCart] = useState<CartLine[]>([])   // one entry per product+selections (ADR 0009)
  // See `adoptProducts`: the freshly-adopted menu, readable before the render that carries it.
  const latestProducts = useRef<Product[]>([])
  // The product whose questions the customer is answering, or null. See `OptionPicker`.
  const [picking, setPicking] = useState<Product | null>(null)
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

  // The one function that writes `line1` and drops the place id with it — Google's guarantee is
  // good only for the exact text the customer picked, not for whatever they type next.
  //
  // It no longer touches the quote at all. `useDeliveryQuote` keys everything it holds to the
  // place id and SELECTS against the one in the form, so dropping the id here is already the
  // whole invalidation: the fee stops being shown, the spinner stops being true, and a response
  // still in flight for the abandoned address lands on a slot that no longer wants it. The
  // "every writer of `line1` MUST go through this helper" hazard — which cost a stuck spinner
  // (#101 review, Finding 1) and a fee quoted for an address the customer no longer had in the
  // field (Finding 5's predecessor) — is gone with it: there is nothing left to forget.
  const clearAddressForNewText = (text: string) => {
    patchAddress({ line1: text, place_id: undefined })
  }

  // Fires on a SELECTION, never on a keystroke: every quote is a request the platform pays for,
  // and a free-text address cannot be routed anyway. Writing the place id is the whole of it —
  // the hook asks for the quote itself, on the same rule that prices a returning customer's
  // saved address on load.
  function pickDestination(detail: { placeId: string; formatted: string; postcode: string; city: string; state: string }) {
    patchAddress({
      line1: detail.formatted,
      postcode: detail.postcode,
      city: detail.city,
      state: detail.state,
      place_id: detail.placeId,
    })
  }

  const [busy, setBusy] = useState(false)
  // WHAT HAPPENED, not a sentence about it — see `notice.ts`. Rendered at paint time so it
  // follows a language switch and a merchant refresh instead of freezing at the moment it was set.
  const [error, setError] = useState<Notice | null>(null)
  const [success, setSuccess] = useState<SuccessState | null>(null)

  const [gallery, setGallery] = useState<Product | null>(null)
  const [signInOpen, setSignInOpen] = useState(false)

  const [voucherInput, setVoucherInput] = useState('')
  const [appliedVoucher, setAppliedVoucher] = useState<Voucher | null>(null)
  const [voucherMsg, setVoucherMsg] = useState<Notice | null>(null)
  const [voucherBusy, setVoucherBusy] = useState(false)

  const shopTrack = useShopPixelTrack()

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

  // Memoised, all of it: this component holds the checkout form's every keystroke in state,
  // and unmemoised these four passes over the whole menu re-ran per character typed.
  const activeProducts = useMemo(() => products.filter(p => p.active), [products])
  // The shop's menu sections (ADR 0013), already on the merchant row `MerchantProvider` loaded —
  // no second request. `menuSections` decides everything about how they render, including the
  // three ways a product ends up in the trailing un-headed block; a shop with none gets one
  // section holding its whole menu, which is the storefront that existed before this feature.
  const productCategories = merchant?.product_categories
  const sections = useMemo(
    () => menuSections(activeProducts, menuCategoriesFromRow(productCategories)),
    [activeProducts, productCategories],
  )
  // The rates come from the SAME function the backend prices with: it commits at its own
  // total and refuses a quote that disagrees (`price_changed`), so a fallback that differed
  // by a ringgit would not be a display bug — it would refuse the checkout.
  const { WM: rateWM, EM: rateEM } = shopRates(merchant?.shipping)
  const baseDeliveryFee = rateWM // shown on the Delivery toggle before a state is known
  // The SAME mapper the order transaction charges with — see the comment on the `priceOrder`
  // call below.
  const tax = shopTax(merchant)

  // The SAME mapper the order transaction charges with — a second reading of these columns here
  // is a second rule, and the customer meets it as a refused checkout.
  const distance = shopDistance(merchant)
  // The SAME mapper intake refuses with. A second reading of these columns here is a second
  // rule, and the customer meets it as a refusal of a button they were just offered.
  const methods = shopMethods(merchant)
  // `null` when the shop offers nothing — a state the CHECK constraint makes unconstructible,
  // and which this form must still refuse rather than invent a method for.
  const defaultMode = firstOfferedMethod(methods)
  // Only offer the escape the shop actually has. "Please choose pickup instead" at a shop that
  // does not do pickup is worse than no suggestion at all — it sends the customer looking for a
  // button that is not there.
  const pickupEscape = methods.pickup

  const [modeInput, setModeInput] = useState<FulfilmentMethod | null>(null)
  // DERIVED, not seeded by an effect — the same shape as the profile prefill above: `null` means
  // "the customer has not chosen", so the shop's first offered method fills in until they do.
  // `?? 'pickup'` is unreachable (see `defaultMode`) and is here only so `mode` is never null
  // for the price call; `noMethods` below is what actually stops such a shop taking an order.
  const mode = modeInput ?? defaultMode ?? 'pickup'
  const setMode = setModeInput
  const noMethods = defaultMode === null

  // Is the CUSTOMER'S CHOICE the distance-priced one? This is what `priceOrder` branches on
  // internally (`mode === 'express'`), and gating the storefront on anything else is how a
  // region form's fee leaked into a distance quote (#101 review, Finding 1).
  const expressChosen = mode === 'express'
  // Chosen AND priceable. `!distance.usable` is a REFUSAL of express at this shop, not a
  // fallback to the delivery form or its rate — see `ShopDistance.usable`'s own contract
  // ("FALSE IS A REFUSAL, NOT A FALLBACK"). Unreachable today (the DB constraint and the
  // backend's allowlist make it unconstructible) and honoured anyway.
  const expressPriced = expressChosen && distance.usable

  /**
   * The distance quote, and every decision about when to ask for one — `quoteMachine.ts`, wired
   * up by `useDeliveryQuote`. What used to live here was three pieces of state, a `useRef`
   * sequencing token and two effects; what is left is one call and the values it hands back.
   *
   * Three properties this replaces, all of them now structural rather than remembered:
   *
   * - A quote, a refusal and the spinner are each SELECTED against the place id in the form, so
   *   none of them can outlive the address they belong to (#101 review, Findings 1 and 5).
   * - A refusal is invalidated by the ADDRESS changing and by nothing else — a mode flip leaves
   *   it standing, which is what Finding 2 asked for and what an effect keyed on `mode` broke.
   * - A returning customer's saved, already-routable address prices itself on load rather than
   *   waiting for a re-pick. A saved address that predates #101 carries no place id and still
   *   simply stays uncalculated until they pick it from the list once (Finding 6); silently
   *   geocoding an old string into a fee they never confirmed was rejected.
   *
   * `expressPriced` is the enable: a region-priced order asks for nothing, and every quote is a
   * request the platform pays for. The cost objection to the load-time quote is weak besides —
   * the endpoint peeks the distance cache before metering, so the normal case for a saved,
   * previously-quoted address consumes no quota at all.
   */
  const { quote, quoteError, quoting, invalidate: invalidateQuote, requote } =
    useDeliveryQuote(merchant?.id, address.place_id, expressPriced)

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
      setVoucherMsg({ kind: 'voucher_signed_out', voucherCode: appliedVoucher.code })
    }
  }

  // The RULE lives in `productLabel.ts`, shared with the merchant's Storefront tab: that screen
  // claims to preview this one, and a second copy of "which name, which description" is how the
  // preview drifts. These two close over `lang` so the call sites below stay `productName(p)`.
  const productName = (p: Product) => label(p, lang)
  const productDescr = (p: Product) => descr(p, lang)

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
    // The menu as of RIGHT NOW, for a `setCart` updater that runs before this render commits.
    // `repair_selections` fires immediately after `refresh_sources` inside one handler, so
    // reading `products` there would read the menu the option was withdrawn FROM.
    latestProducts.current = fresh

    // What goes, and what can be said about it, is `cartRules.ts`'s decision. This performs it.
    const pruned = pruneCart(cart, fresh)
    if (pruned.removed === 0) return
    // Re-run against `prev` rather than writing `pruned.cart` wholesale: a tap on + between this
    // render and this write would otherwise be thrown away with it. `pruneCart` is pure, so an
    // updater React chooses to run twice still lands the same cart.
    setCart(prev => pruneCart(prev, fresh).cart)

    // The names are resolved HERE because only this component knows which language the customer
    // is reading — `productName` picks `name_zh` or `name` off the row. The module decides WHICH
    // ids can be named at all; it never invents one.
    const names = pruned.nameableIds
      .map(id => fresh.find(p => p.id === id))
      .filter((p): p is Product => !!p)
      .map(productName)
    toast(pruneMessage(names, pruned.unnameable, t))
  }

  // The menu, loaded once per shop. It stands below adoptProducts because it calls it, and the
  // compiler's lint (rightly) refuses a hook that reaches back up for a value declared later.
  useEffect(() => {
    if (!merchantId) return
    // Adopt only a real answer: a could-not-ask must not prune the (empty, at mount) cart or
    // blank the menu — same rule the recovery path below leans on. `answeredFor` follows the
    // same rule for the same reason: a could-not-ask must not be photographed as an empty shop.
    lookupProducts(merchantId).then(r => { if (r.ok) { adoptProducts(r.data); setAnsweredFor(merchantId) } })
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
  // breakdown prices with. The list is derived, never stored, so ANY re-render recomputes it
  // from the current corrected clock — but nothing schedules a re-render at midnight by
  // itself, and `handleSubmit` reads `chosenDate` from the closure it was called with, not
  // from a fresh render. So a checkout left open past midnight CAN still submit a stale date;
  // what closes that case is the backend's refusal plus the `setFulfilDate(null)` recovery in
  // handleSubmit's catch branch (see `fulfil_date_unavailable` below), not this list by itself.
  const fulfilDates = useMemo(
    () => selectableDates(fulfilmentConfig(merchant.config), merchant.timezone ?? DEFAULT_TIMEZONE, now),
    [merchant.config, merchant.timezone, now],
  )
  // A date the shop stopped offering while the page sat open is not a selection any more.
  const chosenDate = fulfilDate && fulfilDates.includes(fulfilDate) ? fulfilDate : null

  // The menu, mapped once for the pricing rule: the rows arrive snake_cased from PostgREST and
  // `priceOrder` reads `promoPrice`. Unmapped, every promo silently prices at the base price here
  // and at the promo price on the backend — which is a refused checkout for every promo order.
  const pricedProducts = useMemo(() => activeProducts.map(productFromRow), [activeProducts])
  // Memoised on the MINUTE, not on `now`: the clock is a fresh Date every render, so keyed on it
  // this map would rebuild per keystroke as before. Promo windows are set to the day, so a
  // minute-old answer is the same answer.
  const nowMinute = Math.floor(now.getTime() / 60000)
  const promoById = useMemo(
    () => new Map(pricedProducts.map(p => [p.id, promoState(p, new Date(nowMinute * 60000))])),
    [pricedProducts, nowMinute],
  )
  // Which products ask a question before they go in the cart — computed once per menu rather
  // than by mapping every product's option groups on every render.
  const hasActiveOptions = useMemo(
    () => new Set(activeProducts.filter(p => optionGroupsFromRow(p.option_groups).some(g => g.active)).map(p => p.id)),
    [activeProducts],
  )
  // Which products have a line in the cart, as a set: the menu used to ask `cart.some(...)`
  // once per product, products × cart lines on every render.
  const inCart = useMemo(() => new Set(cart.map(l => l.productId)), [cart])

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
    //
    // The region placeholder is for the `delivery` method specifically — a `delivery` order is
    // region-priced at every shop now, whatever else that shop offers. Express shows no fee at
    // all until one is calculated: an estimate the customer might mistake for their fee is the
    // invented number this feature exists to never produce.
    resolvedShipping: mode === 'delivery' && !address.state ? baseDeliveryFee : undefined,
    distance,
    // `quote.km` is already the rounded km the backend derived, so `km × 1000` re-enters
    // `routedKm` unchanged (`routedKm(25200) === 25.2`) and reproduces the same fee. `quote` is
    // already the quote for the address in the form or nothing at all — the hook selects it
    // against the place id, so there is no second "is this still ours" test to get wrong.
    routedMetres: quote ? quote.km * 1000 : null,
    voucher: appliedVoucher,
    // The SAME mapper the order transaction charges with. A second reading of these columns
    // here is a second rule, and the customer meets it as a refused checkout (`price_changed`).
    tax,
  })

  /**
   * How much more this basket needs before the applied voucher does anything, or 0.
   *
   * DERIVED, never stored: the storefront keeps an applied voucher across cart edits, so a number
   * captured when the code was typed would go stale on the next tap — stating a gap the customer
   * has already closed, or none when they have opened one. `priceOrder` has meanwhile dropped the
   * discount to zero on its own (`voucherApplies`), so the total on screen is already honest; this
   * is what explains it.
   */
  const voucherShortfall = (() => {
    const min = Number(appliedVoucher?.minOrder ?? NaN)
    if (!Number.isFinite(min)) return 0
    return Math.max(0, Math.round((min - bd.subtotal) * 100) / 100)
  })()

  const cartItems: ReceiptLine[] = bd.lines.map(l => ({
    id: l.id, name: l.name, qty: l.qty, price: l.unitPrice, promo: l.promo,
    key: l.key, selections: l.selections,
  }))
  const subtotal = bd.subtotal
  const discount = bd.discount
  const total = bd.total
  const fee = bd.shipping
  const taxAmount = bd.tax
  const taxRate = bd.taxRate
  // Whether this order may be placed, decided in `submitGate.ts` rather than in render scope.
  // It is the last thing standing between a customer and an order the shop would have to cancel,
  // and it is load-bearing for the PRICE, not just for form validity — see the module.
  const { canSubmit } = submitGate({
    lineCount: cartItems.length,
    name, wa, mode, address,
    distanceUsable: distance.usable,
    quoted: quote !== null,
    chosenDate, noMethods, busy,
  })

  /**
   * Everything a stored notice needs in order to become a sentence — read HERE, during render,
   * which is the whole point: the language, the shop's currency and whether pickup can be offered
   * are all things that can change while a message sits on screen (#134).
   */
  const noticeCtx = { t, currency, pickupEscape, canRequote: expressPriced && Boolean(address.place_id) }

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
    setVoucherMsg({ kind: 'voucher_checking' })
    // A could-not-ask reads as "no voucher" here — applyVoucher was never going to apply a
    // voucher it could not read, so the customer sees the invalid message and can retry.
    const lookup = await lookupMerchantVoucher(merchant.id, code)
    const v = lookup.ok ? lookup.data : null
    setVoucherBusy(false)
    const err = voucherError(v, {
      userEmail: voucherEntry,
      fullyUsed: v ? voucherFullyUsed(v) : true,
      customerLimitReached: v?.customerLimitReached,
      subtotal: bd.subtotal,
      now: new Date(),
    })
    // `min_order` is the ONE code that does not reject. A basket under the minimum KEEPS the
    // voucher — asking for a little more is what a minimum-order voucher is for, and the customer
    // re-qualifies the moment they add the item, with the reason still on screen. The gap itself
    // is not set here: it is derived below, so it tracks every cart edit instead of freezing the
    // number that happened to be true when the code was typed. Every other code is terminal —
    // adding to the cart cannot revive a spent or expired voucher.
    if (err && err !== 'min_order') {
      setAppliedVoucher(null)
      setVoucherMsg({ kind: 'voucher_error', code: err })
      return
    }
    if (!v) {
      setAppliedVoucher(null)
      setVoucherMsg({ kind: 'voucher_error', code: err ?? 'invalid' })
      return
    }
    setAppliedVoucher(v)
    setVoucherMsg({ kind: 'voucher_applied', type: (v as any).type, value: (v as any).value })
  }

  const removeVoucher = () => {
    setAppliedVoucher(null)
    setVoucherInput('')
    setVoucherMsg(null)
  }

  /**
   * A row's cart line, when it has one.
   *
   * `extraLines` (a gift line) have no cart entry behind them and must not offer a remove — the
   * same reason `promoClaims` refuses to claim one.
   */
  const removableKey = (item: ReceiptLine) => item.key

  /**
   * Take a whole cart line out, by its derived key.
   *
   * Removes the LINE, not one unit: a product with options has an Add button rather than a
   * stepper, so this is the only exit that line has. A promo split shows it as two rows and both
   * carry the same key, so removing either takes the entry with it.
   */
  const removeLine = (key: string) =>
    setCart(prev => prev.filter(l => cartLineKey(l) !== key))

  /**
   * The only place a cart can grow. What the ceilings are and when they bind is `cartRules.ts`'s
   * decision; the toast is this component's, which is why the module RETURNS a refusal rather
   * than performing one — a setState updater must stay pure, and React may run one twice.
   */
  const updateQty = (target: CartTarget, delta: number) => {
    const change = nextCart(cart, target, delta)
    if (change.refused) {
      // `noop` says nothing — refusing to go below zero is not something the customer did wrong.
      const message = cartRefusalMessage(change.refused, t)
      if (message) toast(message)
      return
    }
    // Re-run against `prev`, for the same reason the prune does: two taps on DIFFERENT lines
    // before a re-render both read the same stale `cart`, and writing a whole cart computed from
    // it would drop the first one. `?? prev` keeps a ceiling that only binds against the newer
    // cart from blanking the line instead of refusing it.
    setCart(prev => nextCart(prev, target, delta).cart ?? prev)
    // The shop's own pixel, if it has one (#220). Only a growing cart is an AddToCart — a
    // stepper's minus is not one, and neither is a refused tap, which is why this sits after the
    // refusal return above rather than at the top of the function.
    if (delta > 0) shopTrack('AddToCart')
  }

  /**
   * Re-read everything the quote is built from: the products, the applied voucher, AND the
   * merchant row.
   *
   * All three are inputs to `priceOrder` (the merchant row carries shipping rates, tax and the
   * promo config), and the backend prices from its own fresh copy of all of them, so a refusal
   * that refreshed only some left the rest of the quote stale — and a stale input re-quotes to
   * the same refused number on the next tap. A voucher that has since been deleted comes back
   * null and is dropped, said out loud rather than silently: the customer can re-apply a code,
   * but not one that no longer exists. The merchant refresh (`useMerchant().refresh`) applies
   * itself internally and only ever adopts a real answer — see `MerchantContext.refresh` for why
   * a failed fetch there must never blank the storefront.
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
      // No `.catch`: apiGet turns a rejection into `{ ok:false }` itself, so these never reject.
      lookupProducts(merchant.id),
      code ? lookupMerchantVoucher(merchant.id, code) : null,
      serverNow ? Promise.resolve(adoptClock(serverNow)) : resyncClock(),
      // Tax/shipping/config all live on this row. Self-contained: unlike the other two fetches,
      // it applies its own result (or nothing, on failure) rather than returning data for us to
      // adopt below — see MerchantContext.refresh for why a dropped packet here changes nothing.
      refreshMerchant().catch(() => null),
    ])
    // `{ ok:true, data:[] }` is an ANSWER — the shop really sells nothing, and pruning the whole
    // cart is right. `{ ok:false }` is the absence of one, and prunes nothing.
    // adoptProducts, not setProducts: a refusal that refreshed the menu but left the dead id in
    // the cart would be refused again on the very next tap.
    if (freshProducts.ok) adoptProducts(freshProducts.data)
    if (voucher?.ok) {
      setAppliedVoucher(voucher.data)
      if (!voucher.data) {
        setVoucherMsg({ kind: 'voucher_gone' })
      }
    }
  }

  /**
   * Run a refusal's recovery, IN ORDER. The order is `orderRefusal.ts`'s decision, not this
   * function's — `refresh_sources` adopts the server clock the refusal carried, and re-quoting
   * before that would re-quote against the same skewed offset and be refused again (I-3, #69).
   *
   * `serverNow` is `price_changed`'s own `now` field; every other refusal passes undefined and
   * `refreshQuoteSources` falls back to re-syncing.
   */
  const applyActions = async (actions: readonly RefusalAction[], serverNow?: string) => {
    for (const action of actions) {
      if (action === 'drop_voucher') {
        setAppliedVoucher(null)
      } else if (action === 'refresh_sources') {
        await refreshQuoteSources(serverNow)
      } else if (action === 'clear_quote') {
        // The one invalidation the hook cannot make for itself: the address has not moved, but a
        // merchant editing the distance rate mid-checkout moved the ANSWER. Every other way a
        // quote stops applying is a change of place id, which the hook already handles by not
        // selecting it.
        invalidateQuote()
      } else if (action === 'requote') {
        // A re-quote moments after the original is a cache HIT, which consumes no ceiling.
        //
        // Kept EXPLICIT even though the hook's own auto-quote would now fire for a slot that
        // `clear_quote` just emptied. The recovery's steps are `orderRefusal.ts`'s decision and
        // are asserted there as an ordered list; leaning on a side effect to supply one of them
        // would trade a recovery a test can read for one it cannot. The hook writes its pending
        // slot synchronously, so this and the effect cannot both fire — one request, not two.
        requote()
      } else if (action === 'clear_date') {
        setFulfilDate(null)
      } else if (action === 'repair_selections') {
        // AFTER `refresh_sources`, which is why the plan returns an ORDERED list and this loop
        // walks it rather than choosing for itself: against the stale menu this would keep the
        // very option that was just withdrawn, and the retry would be refused identically.
        const menu = latestProducts.current.map(p => ({
          id: p.id, active: p.active, optionGroups: optionGroupsFromRow(p.option_groups),
        }))
        // Decided from `cart`, WRITTEN against `prev` — the same split `adoptProducts` makes,
        // and for the same reason: the decision needs a value to reason about, while the write
        // must survive a tap that landed between this render and it. `repairCart` is pure, so an
        // updater React chooses to run twice still lands the same cart.
        const repaired = repairCart(cart, menu)
        setCart(prev => repairCart(prev, menu).cart)

        // REPAIR first, drop second. Losing a coffee because one milk ran out, while three
        // remain, is the wrong answer to a menu that merely moved — so a product that can still
        // be answered reopens its picker. Dropping is the TERMINATING case, and something must
        // terminate: a picker with nothing valid to pick is the same dead end in nicer manners.
        const askAgain = repaired.reask
          .map(id => latestProducts.current.find(p => p.id === id))
          .find(Boolean)
        if (askAgain) {
          setPicking(askAgain)
          toast(t(
            'An option you chose is no longer available — please choose again.',
            '你选择的选项已不可用，请重新选择。',
          ))
        } else if (repaired.removed > 0) {
          toast(t(
            'An option you chose is no longer available, so that item was removed.',
            '你选择的选项已不可用，该商品已移除。',
          ))
        }
      }
    }
  }

  const handleSubmit = async () => {
    if (!canSubmit) return
    // The shop's own pixel, if it has one (#220). Fired before the work rather than after the
    // voucher re-read: an InitiateCheckout is the customer TRYING to buy, and a refusal further
    // down is a checkout that started and did not finish — which is exactly the funnel step an
    // ad platform is being asked to optimize.
    shopTrack('InitiateCheckout')
    setBusy(true)
    setError(null)
    try {
      // Re-validate the voucher against fresh DB state, not the page-load
      // snapshot — that snapshot never reflects this session's own redemption,
      // so a customer could otherwise re-apply and be granted the discount again
      // while used_by stayed at 1. On a fetch miss, fall through to the RPC guard.
      if (appliedVoucher) {
        // On a fetch miss, fall through to the server's own guard (fresh = null).
        const reread = await lookupMerchantVoucher(merchant.id, appliedVoucher.code)
        const fresh = reread.ok ? reread.data : null
        if (fresh) {
          const verr = voucherError(fresh, {
            userEmail: voucherEntry,
            fullyUsed: voucherFullyUsed(fresh),
            customerLimitReached: fresh.customerLimitReached,
            subtotal: bd.subtotal,
            now: new Date(),
          })
          // Here `min_order` DOES stop the submit, unlike at apply time: the customer is pressing
          // Place Order, and the backend would refuse it anyway (`voucher_below_minimum`). The gap
          // is already on screen from `voucherShortfall`, so this only has to block.
          if (verr === 'min_order') {
            setError({ kind: 'voucher_error', code: 'min_order' })
            return
          }
          if (verr) {
            setAppliedVoucher(null)
            setVoucherMsg({ kind: 'voucher_error', code: verr })
            setError({ kind: 'voucher_error', code: verr })
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
        // The SAME rule the profile save reads, not a second reading of it. Asking
        // `mode === 'delivery'` here while `savedDetailsFromOrder` asked `mode !== 'pickup'` is
        // what made every express order unplaceable: intake lifts `place_id` off this very object
        // and refuses an order without one (`delivery_place_required`), so the customer was told
        // to pick the address they had just picked, with no action left to take (#127).
        address: carriesAddress(mode) ? address : '',
        // What they want, and what they saw. Never what it costs: the shop's own rows are the
        // only thing that may say that, and `bd` is only ever a quote.
        cart: cart.filter(l => l.qty > 0),
        quotedTotal: total,
        voucherCode: appliedVoucher?.code ?? null,
        fulfilDate: chosenDate,
      })
      if (!result.ok) {
        // Which refusal this is, what the customer is told, and what we do about it are all one
        // decision, and it lives in `orderRefusal.ts` where it can be tested. This block only
        // performs it. A refused order wrote NOTHING — the transaction rolled back — which is why
        // several of the plans ask for the order again rather than reporting a failure.
        // `error.now` is the server clock the refusal carried (`price_changed` only), adopted to
        // close the #69 offset loop.
        const plan = orderRefusalPlan(result.error.code, {
          t,
          pickupEscape,
          // A re-quote is only possible for a distance-priced order that still holds a place id.
          canRequote: expressPriced && Boolean(address.place_id),
        })
        await applyActions(plan.actions, result.error.now)
        // The voucher's own strip echoes the refusal, so a customer who scrolls back up sees why
        // the discount went away. The strips remember the CODE; `plan.message` here is only for
        // the toast, which is transient and has nothing to re-render.
        const refusal: Notice = { kind: 'order_refusal', code: result.error.code }
        if (plan.actions.includes('drop_voucher')) setVoucherMsg(refusal)
        setError(refusal)
        toast.error(plan.message)
        return
      }
      // Remember what they typed, silently, so they never type it again — at this shop or any
      // other. Best-effort and unawaited: the order is already placed, and a profile write that
      // fails must cost the customer a retype next time, never their order. A guest saves nothing
      // (`saveCustomerDetails` checks the session itself), which is what keeps the gate honest.
      if (account) {
        saveCustomerDetails(savedDetailsFromOrder({ mode, wa, address }))
          .then(r => { if (r.ok) return refreshProfile() }) // so a second order this session prefills too
          .catch(() => {})
      }
      // Best-effort server-side Telegram notify; never blocks a placed order (Result ignored).
      await notifyOrderPlacedRemote(merchant.id, result.data.orderNumber, lang)
      setSuccess({
        orderId: result.data.id,
        orderNumber: result.data.orderNumber, items: cartItems, subtotal, fee, discount, taxAmount, taxRate, total,
        // The SAME value the summary just labelled the fee with — a non-null `quote` is what
        // gated submission in the first place (`submitGate`'s `quoted`), so at this point it can
        // only be present or this was never a distance order at all.
        feeKm: quote ? quote.km : null,
        fulfilDate: chosenDate,
        status: result.data.status,
      })
      toast.success(t('Order placed!', '订单已提交！'))
      // The sale, on the shop's own pixel (#220).
      //
      // `total` is NOT a browser-side recomputation, and that distinction is the whole reason
      // this line sits after the ok branch rather than beside the submit. Order intake re-prices
      // with the same `priceOrder` this page quoted with and REFUSES any total it disagrees with
      // (`price_changed`) — so a placeOrder that resolved ok is the backend stating that this
      // exact number is what it committed. An ad platform optimizing on a figure that does not
      // match revenue is worse than one told nothing.
      //
      // A refused order reports nothing: the transaction rolled back and there is no sale.
      // `currency` is what every money line on this page is already formatted in. The fallback is
      // the platform default rather than a blank: both vendors read `currency` as ISO 4217 and
      // discard a value they cannot parse, taking the amount with it.
      shopTrack('Purchase', { value: total, currency: currency ?? DEFAULT_CURRENCY })
    } catch {
      // Backstop for an UNEXPECTED throw — placeOrder's refusals are handled above via its Result,
      // so this only fires if something else in the try threw. Show the generic refusal message.
      const plan = orderRefusalPlan(undefined, {
        t, pickupEscape, canRequote: expressPriced && Boolean(address.place_id),
      })
      setError({ kind: 'order_refusal', code: undefined })
      toast.error(plan.message)
    } finally {
      setBusy(false)
    }
  }

  // "Place another order": clear the cart, and hand the fields back to the profile rather than to
  // blank — a signed-in customer's second order of the day should not make them retype either.
  const handleReset = () => {
    setSuccess(null)
    setCart([])
    setNameInput(null)
    setWaInput(null)
    setAddressInput(null)
    setError(null)
    removeVoucher()
  }

  return (
    <>
      {success ? (
        // ── Success view ──────────────────────────────────────────────────────
        <div key="success" role="main" {...enterView} className={cn('form-wrap', enterView.className)}>
          {/* Header */}
          <div className="flex items-start justify-between gap-4 mb-8 max-[480px]:flex-col max-[480px]:gap-2">
            <div>
              <h1 className="font-heading text-[26px] font-medium text-primary tracking-[0.3px]">{merchant.name}</h1>
            </div>
            <div className="flex justify-end flex-shrink-0 max-[480px]:justify-start">
              <LanguageSelect />
            </div>
          </div>

          {/* Success content */}
          <div className="text-center py-12 px-6">
            <h2 className="font-heading text-[24px] font-medium text-primary mb-2">
              {t('Order Placed!', '订单已提交！')}
            </h2>
            <p className="text-[14px] text-muted-foreground mb-6 leading-[1.6]">
              {t('Thank you for your order.', '感谢您的订单。')}
            </p>
            <p className="text-[15px] text-primary mb-3 tracking-[0.5px]">
              {t('Order number', '订单号')}:<br />
              <strong className="font-mono text-[16px]">{success.orderNumber}</strong>
            </p>

            {/* The date they picked, read back to them. A customer who chose a date and is shown
                only an order number has no confirmation that the one thing they had to decide was
                actually recorded — and the merchant is scheduling against it. formatCalendarDate,
                not formatOrderDate: this is a calendar date, and rendering it in the viewer's zone
                would show a customer abroad the day before the one they chose. */}
            {success.fulfilDate && (
              <p className="text-[15px] text-primary mb-5 tracking-[0.5px]">
                {t('For', '取货日期')}:<br />
                <strong className="text-[16px]">{formatCalendarDate(success.fulfilDate, lang)}</strong>
              </p>
            )}

            <div className="max-w-[360px] mx-auto mb-5 text-left px-4 py-3 bg-card border-[0.5px] border-border rounded-md">
              {success.items.map((item, i) => (
                <div key={i} className="flex justify-between items-start gap-2 text-sm text-muted-foreground py-[3px]">
                  {/* min-w-0 (not shrink-0): a long product name must wrap inside its own column.
                      shrink-0 let it push the price out past the card's right edge. */}
                  <span className="min-w-0 flex flex-col gap-0.5">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      {item.name} × {item.qty}
                      {item.promo && (
                        <span className="px-1.5 py-0.5 rounded-pill bg-primary text-primary-foreground text-[10px] leading-[14px] font-medium">
                          {t('Promo', '优惠')}
                        </span>
                      )}
                    </span>
                    <ItemSelections item={item} />
                  </span>
                  <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(item.price * item.qty, currency)}</span>
                </div>
              ))}
              {success.fee > 0 && (
                <div className="flex justify-between items-start gap-2 text-sm text-muted-foreground py-[3px]">
                  {/* Same house term as the summary and every other surface, with the distance
                      that priced it named in parentheses when there is one — the confirmation
                      the customer keeps must name what a tap earlier already did (Finding 7). */}
                  <span className="min-w-0">
                    {success.feeKm != null
                      ? t(`Delivery fee (${success.feeKm.toFixed(1)} km)`, `送货费（${success.feeKm.toFixed(1)} 公里）`)
                      : t('Delivery fee', '送货费')}
                  </span>
                  <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(success.fee, currency)}</span>
                </div>
              )}
              {success.discount > 0 && (
                <div className="flex justify-between items-start gap-2 text-sm text-muted-foreground py-[3px]">
                  <span className="min-w-0">{t('Voucher', '优惠券')}</span>
                  <span className="shrink-0 text-right whitespace-nowrap">−{formatMoney(success.discount, currency)}</span>
                </div>
              )}
              {success.taxRate > 0 && (
                <div className="flex justify-between items-start gap-2 text-sm text-muted-foreground py-[3px]">
                  <span className="min-w-0">{t('Tax', '税')} ({formatTaxRate(success.taxRate)}%)</span>
                  <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(success.taxAmount, currency)}</span>
                </div>
              )}
              <div className="flex justify-between items-start gap-2 text-[15px] font-medium text-foreground border-t border-border mt-2 pt-[10px]">
                <span className="min-w-0">{t('Total', '总计')}</span>
                <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(success.total, currency)}</span>
              </div>
            </div>

            {/* How to pay, and the reply to it — one component, mounted here and again in order
                history, because a customer who left this page to open their banking app cannot
                come back to it. The upload is the block's own last line: same guard, so a shop
                with no payment info shows neither. */}
            <PaymentInstructions merchant={merchant} className="max-w-[360px] mx-auto mb-4">
              <PaymentProofUpload orderId={success.orderId} />
            </PaymentInstructions>

            {/* The rating, asked at the one moment this customer is certainly still here. A guest
                order is orphaned the moment this tab closes, so any later screen would reach the
                signed-in customer only. It chooses its door exactly as the invoice button below
                does: the account's own `user_id`, or the same (shop, order number, phone) triple
                the guest already typed. */}
            <OrderReviewCard
              className="max-w-[360px] mx-auto mb-4"
              initial={null}
              submit={(rating, comment) => (account
                ? reviewMyOrder(success.orderId, rating, comment)
                : reviewGuestOrder(merchant.slug, success.orderNumber, wa, rating, comment))}
            />

            <div className="flex flex-col items-center gap-2 mt-5">
              {/* The invoice, at the moment of highest intent — this is what stops most of the
                  asking later. A shop taking manual payment has no invoice to give yet: its order
                  is born `pending_payment`, so the customer gets the SENTENCE instead of a button
                  that would 404. `canIssueInvoice` is shared with the backend, so the two agree. */}
              {canIssueInvoice(success.status) ? (
                <InvoiceButton
                  status={success.status}
                  orderNumber={success.orderNumber}
                  // A signed-in customer goes through their OWN door — the order carries their
                  // `user_id`, so proving the session is both cheaper and more honest than
                  // re-proving the phone, and it leaves the public door's rate limit to guests.
                  // The guest proves the pair with the SAME number this order was placed with
                  // (`wa` above), never a profile field: a guest has no profile, and the phone
                  // the door matches on is the one the order stored.
                  fetcher={() => (account
                    ? fetchMyInvoice(success.orderId)
                    : fetchGuestInvoice(merchant.slug, success.orderNumber, wa))}
                  className="text-[13px] font-medium"
                />
              ) : (
                <p className="text-[12px] text-muted-foreground max-w-[320px] leading-[1.5]">
                  {t(
                    'Your invoice will be available once the shop confirms your payment. Come back to this shop and open “Get an invoice”.',
                    '店家确认付款后即可获取账单。请返回本店并点击“获取账单”。',
                  )}
                </p>
              )}
              <Button type="button" variant="link" size="none" className="text-[13px] font-medium inline-block" onClick={handleReset}>
                {t('Back to shop', '返回商店')}
              </Button>
              {account && (
                <Link to={`/s/${merchant.slug}/orders`} className="text-[13px] text-muted-foreground underline">
                  {t('Your orders', '你的订单')}
                </Link>
              )}
            </div>
          </div>
        </div>
      ) : (
        // ── Order form ──────────────────────────────────────────────────────
        <div
          key="form"
          role="main"
          {...enterView}
          className={cn('form-wrap', enterView.className)}
          data-preview={preview ? '1' : undefined}
        >
          {/* Header with lang switch */}
          <div className="flex items-start justify-between gap-4 mb-8 max-[480px]:flex-col max-[480px]:gap-2">
            <div>
              <h1 className="font-heading text-[26px] font-medium text-primary tracking-[0.3px]">{merchant.name}</h1>
              {/* The shop's own line, in the reader's language and only when the shop wrote one —
                  an empty <p> here would hold the platform credit a line further down for every
                  shop that never filled it in. Not on the success view above: an order is placed,
                  and nobody reads a shop blurb after paying. */}
              {shopDescr(merchant, lang) && (
                <p className="text-[13px] text-muted-foreground mt-[6px] max-w-[420px] leading-[1.5]">
                  {shopDescr(merchant, lang)}
                </p>
              )}
              <p className="font-heading text-[13px] italic text-muted-foreground mt-[5px]">
                {t('Powered by TinyOrder', 'TinyOrder 提供技术支持')}
                {' · '}
                {/* The customer's name, phone and delivery address are collected on THIS page,
                    so the notice describing what happens to them belongs on it. Opens in a new
                    tab so reading it never costs a half-filled cart. */}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="not-italic underline underline-offset-2 hover:text-primary"
                >
                  {t('Privacy', '隐私政策')}
                </a>
              </p>
              <div className="flex items-center gap-3 mt-1" data-preview-hide>
                {account ? (
                  // History carries the courier and AWB inline, so it was already everything the
                  // old /track screen said and more — which is why that screen is gone. A signed-in
                  // customer is sent to their orders, never to a form demanding an order number
                  // they can already see.
                  <Link to={`/s/${merchant.slug}/orders`} className="text-[12px] text-primary underline inline-block">
                    {t('Your orders', '你的订单')}
                  </Link>
                ) : (
                  <Button
                    type="button"
                    variant="link"
                    size="none"
                    onClick={() => setSignInOpen(true)}
                    className="text-[12px] inline-block"
                  >
                    {t('Sign in', '登录')}
                  </Button>
                )}
                {/* The guest's way back to their own paperwork, and the only one there is: a guest
                    order is orphaned for ever, so nothing else on this platform can reach that
                    customer once the tab closes. Top-level URL, outside this shell's status gate,
                    carrying the shop because an order number is unique per shop only. */}
                <Link to={`/invoice?shop=${merchant.slug}`} className="text-[12px] text-muted-foreground underline inline-block">
                  {t('Get an invoice', '获取账单')}
                </Link>
              </div>
            </div>
            <div className="flex justify-end flex-shrink-0 max-[480px]:justify-start" data-preview-hide>
              <LanguageSelect />
            </div>
          </div>

          <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />
          <OptionPicker
            product={picking}
            onClose={() => setPicking(null)}
            productName={picking ? productName(picking) : ''}
            currency={currency}
            groups={picking ? optionGroupsFromRow(picking.option_groups) : []}
            t={t}
            label={(name, nameZh) => (lang === 'zh' && nameZh) ? nameZh : name}
            onAdd={selections => {
              // Straight through `updateQty`, so the ceilings and the MERGE rule stay the cart's
              // one decision rather than a second copy living in the sheet: adding the same drink
              // with the same milk twice raises the line the customer already has.
              if (picking) updateQty({ productId: picking.id, selections }, 1)
            }}
          />

          {/* Product list */}
          {/* data-sample-capture: the marker the sample-shop screenshot sweep waits for
              (apps/backend/scripts/captureSampleShopScreenshots.ts). The shop and its products
              are read after mount, so `load` alone fires on a page with no shop on it yet.
              Rename it and the sweep starts timing out.

              It is gated on this shop's menu having answered, NOT on this div existing: the div renders one round
              trip before the menu does, holding "This shop has no products yet." — which is what
              the sweep photographed on all three sample shops. The marker now means "the menu
              request answered", so a genuinely empty shop is still captured, and a shop whose
              menu could not be read is captured as nothing at all (the sweep times out, retries
              once, and the carousel simply omits it) rather than as a shop with no food. */}
          <div className="mb-7" data-sample-capture={answeredFor === merchantId ? 'menu' : undefined}>
            <div className="text-[11px] font-medium text-primary uppercase tracking-[0.09em] mb-3">{t('Menu', '菜单')}</div>
            {activeProducts.length === 0 ? (
              <p className="text-[14px] text-muted-foreground italic py-6 text-center">
                {t('This shop has no products yet.', '此店暂无商品。')}
              </p>
            ) : (
              <div className="flex flex-col gap-[10px]">
                {sections.map(section => (
                  <Fragment key={section.category?.id ?? ''}>
                    {/* The trailing block is deliberately un-headed: its members are the products
                        this shop has not filed, and naming them would be inventing a section the
                        merchant never authored. A shop with no categories has exactly one section,
                        and it is this one — so its menu is unchanged by all of this. */}
                    {section.category && (
                      <div className="text-[13px] font-semibold text-foreground mt-2 first:mt-0">
                        {(lang === 'zh' && section.category.name_zh) || section.category.name}
                      </div>
                    )}
                {section.products.map(p => (
                  // The row's SHELL — thumbnail, name, description — is `MenuRow`, shared with the
                  // merchant's Storefront tab so the arrangement screen previews the real thing
                  // (spec 2026-08-17). Everything that reads the cart stays here, in the slots.
                  <MenuRow
                    key={p.id}
                    imagePaths={p.image_urls ?? []}
                    onImageClick={() => setGallery(p)}
                    imageLabel={t('View photos', '查看图片')}
                    className={cn(inCart.has(p.id) && "border-primary bg-brand-wash")}
                    title={productName(p)}
                    subtitle={productDescr(p) || undefined}
                    meta={(() => {
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
                        // SUM, never `find`: one product can occupy several lines once its
                        // options differ, and `find` would report only the first — under-counting
                        // the units this cart has already claimed and advertising a promo price
                        // for a unit that will be charged at base.
                        const claimed = promo
                          ? bd.lines.reduce((n, l) => (l.id === p.id && l.promo ? n + l.qty : n), 0)
                          : 0
                        const remainingForNextUnit = promo && Number.isFinite(promo.remaining)
                          ? promo.remaining - claimed
                          : Infinity
                        if (!promo || remainingForNextUnit <= 0) {
                          return (
                            <div className="text-[13px] font-medium text-primary mt-[5px]">
                              {formatMoney(p.price, currency)} / {unit}
                            </div>
                          )
                        }
                        return (
                          <div className="flex items-center gap-2 mt-[5px] flex-wrap">
                            <span className="text-[13px] font-medium text-primary">
                              {formatMoney(promo.price, currency)} / {unit}
                            </span>
                            <span className="text-[12px] text-muted-foreground line-through">
                              {formatMoney(p.price, currency)}
                            </span>
                            <span className="px-1.5 py-0.5 rounded-pill bg-primary text-primary-foreground text-[10px] leading-[14px] font-medium">
                              {t('Promo', '优惠')}
                            </span>
                            {Number.isFinite(remainingForNextUnit) && (
                              <span className="text-[11px] text-muted-foreground">
                                {t(`${remainingForNextUnit} left at this price`, `此价格剩 ${remainingForNextUnit} 件`)}
                              </span>
                            )}
                          </div>
                        )
                      })()}
                    trailing={hasActiveOptions.has(p.id) ? (
                      /* A product that asks questions has no plain line to step: there is no
                         answer to which selection a bare + would raise. It gets Add, and the
                         quantity is adjusted in the cart or by adding again. */
                      <Button
                        size="sm"
                        className="pointer-coarse:h-11"
                        onClick={() => setPicking(p)}
                      >{t('Add', '加入')}</Button>
                    ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="soft"
                        size="iconRound"
                        className="text-[16px] pointer-coarse:size-11 pointer-coarse:text-[18px]"
                        onClick={() => updateQty({ productId: p.id, selections: [] }, -1)}
                        aria-label={t('Decrease quantity', '减少数量')}
                      >−</Button>
                      {/* The label is real text, hidden visually: `aria-label` is prohibited on a
                          plain span (no role), so assistive tech ignored it and read a bare
                          number. `sr-only` text reads "Quantity 2" and passes axe. */}
                      <span
                        className="text-[14px] font-medium min-w-[20px] pointer-coarse:min-w-[28px] text-center text-foreground"
                        aria-live="polite"
                      ><span className="sr-only">{t('Quantity', '数量')} </span>{plainQty(cart, p.id)}</span>
                      <Button
                        variant="soft"
                        size="iconRound"
                        className="text-[16px] pointer-coarse:size-11 pointer-coarse:text-[18px]"
                        onClick={() => updateQty({ productId: p.id, selections: [] }, 1)}
                        aria-label={t('Increase quantity', '增加数量')}
                      >+</Button>
                    </div>
                    )}
                  />
                ))}
                  </Fragment>
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

          <hr className="border-0 border-t border-border my-6" />

          {/* Fulfilment */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-primary uppercase tracking-[0.09em] mb-3">{t('Fulfilment', '配送方式')}</div>
            <div className="flex gap-[10px]" role="group" aria-label={t('Fulfilment method', '配送方式')}>
              {FULFILMENT_METHODS.filter(m => methods[m]).map(m => (
                <button
                  key={m}
                  type="button"
                  className={cn(
                    "flex-1 border rounded-md py-[10px] px-[14px] pointer-coarse:min-h-11 cursor-pointer text-[14px] font-sans text-center transition-all hover:border-primary focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2",
                    mode === m
                      ? "border-[0.5px] border-primary bg-brand-wash text-primary font-medium"
                      : "border-border bg-card text-foreground"
                  )}
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                >
                  {/* Delivery's flat fee is stated up front because it is the whole fee. Express
                      names no rate: `base` and `ratePerKm` are the merchant's pricing policy, not
                      the customer's business — the customer sees the quoted fee once an address
                      makes one computable. */}
                  {m === 'pickup'
                    ? fulfilmentLabel('pickup', t)
                    : m === 'delivery'
                      ? <>{fulfilmentLabel('delivery', t)} (+{formatMoney(baseDeliveryFee, currency)})</>
                      : fulfilmentLabel('express', t)}
                </button>
              ))}
            </div>
            {noMethods && (
              /* Unreachable past `merchants_one_fulfilment_method`. Said anyway, because the
                 alternative is a checkout with no buttons and no explanation. */
              <p className="text-[13px] text-primary mt-3">
                {t('This shop is not accepting orders right now.', '本店目前暂不接受订单。')}
              </p>
            )}
            {mode === 'pickup' && merchant?.pickup_address && (
              <div className="flex flex-col gap-1.5 mt-3">
                <div className="text-[13px] font-medium text-primary">{t('Pickup address', '自取地址')}</div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(merchant.pickup_address)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[14px] text-primary whitespace-pre-line leading-[1.5] underline decoration-primary/30 underline-offset-2 hover:decoration-primary transition-colors"
                >
                  {merchant.pickup_address}
                </a>
              </div>
            )}
            {mode === 'express' && (
              <div className="flex flex-col gap-3 mt-3">
                {distance.usable ? (
                  <>
                      <AddressAutocomplete
                        id="sf-address"
                        t={t}
                        label={t('Delivery address', '配送地址')}
                        value={address.line1}
                        placeholder={t('Start typing your address…', '输入您的地址…')}
                        onTextChange={clearAddressForNewText}
                        onPick={pickDestination}
                      />
                      <div className="flex flex-col gap-[6px]">
                        <Label htmlFor="sf-unit">{t('Unit / floor / landmark (optional)', '单位 / 楼层 / 地标（选填）')}</Label>
                        <Input id="sf-unit" value={address.unit ?? ''}
                          onChange={e => patchAddress({ unit: e.target.value })}
                          placeholder={t('e.g. A-3-2, next to the surau', '例如：A-3-2，祈祷室旁')} />
                        {/* Says it plainly, because the customer's worry is that it will cost them
                            money: it is passed to the rider and never routed (story 21). */}
                        <p className="text-[12px] text-muted-foreground leading-[1.5]">
                          {t('Passed to the rider. It does not change your delivery fee.',
                             '仅提供给骑手，不影响运费。')}
                        </p>
                      </div>
                      {quoting && <p className="text-[13px] text-muted-foreground">{t('Calculating delivery fee…', '正在计算运费…')}</p>}
                      {/* Rendered from the refusal CODE at paint time, not from a sentence frozen
                          when the request failed. `LanguageSelect` sits in this page's own header,
                          and `pickupEscape` can turn on under a merchant refresh — a stored string
                          would go on speaking English, and go on withholding a pickup offer the
                          shop now has, while the page around it changed. */}
                      {quoteError && (
                        <p className="text-[13px] text-primary">
                          {quoteRefusalPlan(quoteError, { t, pickupEscape })}
                        </p>
                      )}
                    </>
                ) : (
                  // `usable === false`: no address field at all. Offering one would invite a pick
                  // that can never quote, and a region form here is the exact fallback
                  // `ShopDistance.usable`'s contract forbids. Unreachable today — the DB and the
                  // backend cannot construct this state — but the storefront must not silently
                  // invent a fee if they ever could.
                  <p className="text-[13px] text-primary">
                    {methods.pickup
                      ? t('Express delivery is not available at this shop right now. Please choose pickup instead.',
                          '本店目前暂不提供快速配送，请改选自取。')
                      : t('Express delivery is not available at this shop right now.',
                          '本店目前暂不提供快速配送。')}
                  </p>
                )}
              </div>
            )}

            {mode === 'delivery' && (
              <div className="flex flex-col gap-3 mt-3">
                {/* The `line1` field goes through `clearAddressForNewText`, and it matters MORE
                    here, not less: a customer who switched from Express to Delivery at the same
                    shop is carrying a confirmed place id into a form with no field to confirm one.
                    Left attached, a LATER express visit's auto-quote would price to the OLD place
                    while this line names a different one (#101 review, Finding 5). */}
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="sf-line1">{t('Address line', '地址')}</Label>
                      <Input
                        id="sf-line1"
                        value={address.line1}
                        // The SAME helper the distance form's own address field uses — not a
                        // hand-rolled `patchAddress({ line1, place_id: undefined })` here. A
                        // region shop's form has no field to confirm a place id with, but
                        // `address` can still carry one: profiles are GLOBAL, so a place id this
                        // same account confirmed at a DISTANCE shop rides along as a prefill. Left
                        // uncleared, hand-editing this text would leave that id attached to
                        // whatever the customer now types, and a LATER distance shop's
                        // return-visit quote (the auto-fetch effect, above) would silently price
                        // to the OLD place while this line names a different one. Going through
                        // the shared helper is what makes that automatic rather than something
                        // this call site has to remember on its own (#101 review, Finding 5).
                        onChange={e => clearAddressForNewText(e.target.value)}
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
                      <Select
                        value={address.state || null}
                        onValueChange={v => patchAddress({ state: v ?? '' })}
                      >
                        {/* The class string is Input's, verbatim — this field sits between two
                            Inputs and has always been pixel-matched to them. text-[16px] is not
                            decorative: iOS Safari zooms the viewport on focus of any control
                            under 16px, and this is the checkout address form.
                            The height override has to be spelled `data-[size=default]:h-auto`,
                            not `h-auto`: the trigger sets its height under that same variant, and
                            an unprefixed h-auto neither out-specifies it nor gets deduped by
                            tailwind-merge — it just loses, leaving this field 36px beside a 46px
                            Input. Matching the variant lets the merge drop the h-9. */}
                        <SelectTrigger
                          id="sf-state"
                          className="w-full min-w-0 data-[size=default]:h-auto rounded-md border border-border bg-card px-[13px] py-2.5 text-[16px] text-foreground transition-colors outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/10 data-placeholder:text-muted-foreground"
                        >
                          <SelectValue placeholder={t('Select state…', '选择州属…')} />
                        </SelectTrigger>
                        <SelectContent>
                          {MY_STATES.map(s => (
                            <SelectItem key={s} value={s}>{s}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
              </div>
            )}
          </div>

          <hr className="border-0 border-t border-border my-6" />

          {/* When */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-primary uppercase tracking-[0.09em] mb-3">
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

          <hr className="border-0 border-t border-border my-6" />

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
            <div className="text-[11px] font-medium text-primary uppercase tracking-[0.09em] mb-3">{t('Your Details', '您的资料')}</div>
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

          <hr className="border-0 border-t border-border my-6" />

          {/* Voucher */}
          <div className="mb-7">
            <div className="text-[11px] font-medium text-primary uppercase tracking-[0.09em] mb-3">{t('Voucher', '优惠券')}</div>
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
              <Button
                type="button"
                variant="link"
                size="none"
                onClick={() => setSignInOpen(true)}
                className="text-[13px] text-muted-foreground inline-block hover:text-primary"
              >
                {t('Sign in to use a voucher', '登录后可使用优惠券')}
              </Button>
            ) : appliedVoucher ? (
              <div className="flex justify-between items-start gap-2 text-sm text-muted-foreground py-[3px]">
                <span className="shrink-0">{t('Applied', '已应用')}: <strong>{appliedVoucher.code}</strong></span>
                <Button type="button" variant="link" size="none" className="text-[13px] text-muted-foreground mt-5 inline-block" onClick={removeVoucher}>
                  {t('Remove', '移除')}
                </Button>
              </div>
            ) : (
              <div className="flex items-stretch gap-2">
                <Input
                  type="text"
                  value={voucherInput}
                  onChange={e => setVoucherInput(e.target.value)}
                  aria-label={t('Voucher code', '优惠码')}
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
            {appliedVoucher && voucherShortfall > 0 && (
              <p className="mt-2 text-[13px]">
                {noticeText(
                  { kind: 'voucher_shortfall', shortfall: voucherShortfall, voucherCode: appliedVoucher.code },
                  noticeCtx,
                )}
              </p>
            )}
            {/* The "✓ Voucher applied: 20% off" line is SUPPRESSED while a shortfall stands. Both
                statements are true, and together they read as a contradiction: the customer is
                told the discount is on and, one line up, that it is not doing anything. The gap is
                the more useful of the two, and it is the one that tells them what to do. */}
            {voucherMsg && !(voucherMsg.kind === 'voucher_applied' && voucherShortfall > 0) && (
              <p className="mt-2 text-[13px]">{noticeText(voucherMsg, noticeCtx)}</p>
            )}
          </div>

          <hr className="border-0 border-t border-border my-6" />

          {/* Live order summary */}
          <div className="bg-brand-wash border border-border rounded-xl py-4 px-5 mb-6">
            <div className="font-heading text-[14px] font-medium text-primary mb-[10px]">
              {t('Order Summary', '订单摘要')}
            </div>
            {cartItems.length === 0 ? (
              <p className="text-[13px] text-muted-foreground italic">
                {t('No items selected yet.', '尚未选择任何商品。')}
              </p>
            ) : (
              <>
                {cartItems.map((item, i) => {
                  const prod = activeProducts.find(p => p.id === item.id)
                  const displayName = (lang === 'zh' && prod?.name_zh) ? prod.name_zh : item.name
                  return (
                    <div key={i} className="flex justify-between items-start gap-2 text-sm text-muted-foreground py-[3px]">
                      {/* min-w-0, not shrink-0 — see the success view's line items (#92). */}
                      <span className="min-w-0 flex items-center gap-1.5 flex-wrap">
                        <span className="flex flex-col">
                          <span>{displayName} × {item.qty}</span>
                          {/* What they actually chose, under the name. The order snapshots this;
                              showing it is what lets them notice a wrong pick before paying. */}
                          <ItemSelections item={item} />
                        </span>
                        {item.promo && (
                          <span className="px-1.5 py-0.5 rounded-pill bg-primary text-primary-foreground text-[10px] leading-[14px] font-medium">
                            {t('Promo', '优惠')}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 flex items-center gap-3">
                        <span className="text-right whitespace-nowrap">{formatMoney(item.price * item.qty, currency)}</span>
                        {/* The ONLY way out for a line with options: its card has an Add button
                            rather than a stepper, because there is no answer to which selection a
                            bare + would raise. Without this a customer who picked the wrong milk
                            could not remove it at all. Keyed on the CART LINE — a promo split
                            renders two rows for one entry, and removing either removes the line. */}
                        {removableKey(item) && (
                          <button
                            type="button"
                            onClick={() => removeLine(removableKey(item)!)}
                            aria-label={t(`Remove ${displayName}`, `移除 ${displayName}`)}
                            title={t('Remove item', '移除商品')}
                            /* Bordered circle, not a bare × glyph: customers read the glyph as
                               decoration and did not try clicking it. The ring plus the fill on
                               hover/press is the whole affordance. The circle stays 28px so it
                               does not dominate a summary row; the `after` overlay is what makes
                               the touch target 44px, so a coarse pointer gets the size without
                               the visual weight. */
                            className="relative grid place-items-center shrink-0 size-7 -my-1 rounded-pill border border-border bg-white/60 text-muted-foreground cursor-pointer transition-colors hover:bg-danger-fg hover:border-danger-fg hover:text-white active:bg-danger-fg active:border-danger-fg active:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary after:absolute after:content-[''] after:-inset-2"
                          >
                            <X className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
                          </button>
                        )}
                      </span>
                    </div>
                  )
                })}
                <div className="flex justify-between items-start gap-2 text-sm text-muted-foreground py-[3px]">
                  <span className="min-w-0">{t('Subtotal', '小计')}</span>
                  <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(subtotal, currency)}</span>
                </div>
                {mode !== 'pickup' && (
                  // `feeLineLabel` is the ONE place that names this line — the same function the
                  // receipt and order history use, so a customer never meets two terms for one
                  // order (#103). It names the line after the METHOD (`Delivery fee` /
                  // `Express delivery fee`) and appends the distance only when there is one. The
                  // pending case is express-only (`shippingPending`) and keeps its own wording.
                  <MoneyLine
                    label={
                      bd.shippingPending
                        ? t('Express delivery fee (not calculated yet)', '快速配送费（尚未计算）')
                        : feeLineLabel(mode, quote ? quote.km : null, t)
                    }
                    value={bd.shippingPending ? t('—', '—') : formatMoney(fee, currency)}
                  />
                )}
                {discount > 0 && (
                  <div className="flex justify-between items-start gap-2 text-sm text-muted-foreground py-[3px]">
                    <span className="min-w-0">{t('Voucher', '优惠券')} ({appliedVoucher?.code})</span>
                    <span className="shrink-0 text-right whitespace-nowrap">−{formatMoney(discount, currency)}</span>
                  </div>
                )}
                {taxRate > 0 && (
                  <div className="flex justify-between items-start gap-2 text-sm text-muted-foreground py-[3px]">
                    <span className="min-w-0">{t('Tax', '税')} ({formatTaxRate(taxRate)}%)</span>
                    <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(taxAmount, currency)}</span>
                  </div>
                )}
                <div className="flex justify-between items-start gap-2 text-[15px] font-medium text-foreground border-t border-border mt-2 pt-[10px]">
                  <span className="min-w-0">{t('Total', '总计')}</span>
                  <span className="shrink-0 text-right whitespace-nowrap">{formatMoney(total, currency)}</span>
                </div>
                {bd.shippingPending && (
                  <p className="text-[12px] text-muted-foreground leading-[1.5] mt-2">
                    {t('This total does not include delivery yet. Pick your address to see the fee.',
                       '此金额尚未包含运费。请选择地址以查看运费。')}
                  </p>
                )}
              </>
            )}
          </div>

          {error && (
            <div role="alert" className="text-[13px] text-danger-fg bg-danger-100 border border-danger-500 rounded-md px-[13px] py-[10px] mb-[10px] leading-[1.5]">
              {noticeText(error, noticeCtx)}
            </div>
          )}

          <Button
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="active:scale-[0.99]"
          >
            {busy ? t('Placing order…', '提交中…') : t('Place Order', '提交订单')}
          </Button>
          </>
          )}
        </div>
      )}
    </>
  )
}
