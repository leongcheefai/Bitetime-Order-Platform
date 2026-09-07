import { useCallback, useEffect, useState } from 'react'
import { Plus, ReceiptText, UserCheck, Users, Wallet, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Order, ShopCustomer, ShopCustomerSegment, ShopCustomerSort, ShopCustomerStats } from '../types'
import { useSession } from '../SessionContext'
import { fetchShopCustomers, fetchShopCustomerOrders, saveShopCustomer } from '../store'
import { SkeletonText } from '../components/Loaders'
import { StatCard } from '../components/charts/StatCard'
import { formatMoney } from '../currency'
import { fmtDate } from '../merchantDate'
import { StatusBadge } from '../orderStatus'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import OrderDetailSheet from './orderDetail/OrderDetailSheet'
import { filterChips, mergeShopTags, TAG_CHIP_CAP, tagSuggestions } from './tagSuggestions'
import WaLink from './WaLink'

// Self-contained panel — pixel-match of .admin-panel
const PANEL = 'bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border'

// Table header cell — pixel-match of .mm-customers-table th
const TH = 'text-[10px] font-semibold uppercase tracking-[0.08em] text-primary px-[14px] py-[10px] border-b-[0.5px] border-border text-left whitespace-nowrap'

// Table data cell (base) — pixel-match of .mm-customers-table td + hover
const TD = 'px-[14px] py-[12px] border-b border-muted text-foreground align-middle group-hover:bg-brand-wash'

// Count cell — pixel-match of .mm-customers-count overrides
const TD_COUNT = 'px-[14px] py-[12px] border-b border-muted text-primary font-semibold text-center align-middle group-hover:bg-brand-wash'

/**
 * One tag chip, on `Badge` rather than hand-rolled — the filter row's, the table row's and the
 * drawer's, so three sets of pills cannot drift apart.
 *
 * The geometry and type come from the primitive (pill, 11px semibold, `border border-transparent`
 * so a bordered state costs no layout shift); this override supplies the padding and the brand
 * tint, in the `.mm-badge--{status}` shape `AdminMerchants` already uses. **10px, not the base's
 * 9px** — DESIGN.md's `status-chip` token is `3px 10px`. Brand 100 is the chip background and
 * Brand 700 the text on it (DESIGN.md → Colour), so a tag is *not* `text-primary`.
 *
 * Hand-rolled, these were 12px regular with a resting border, which is a fourth chip style on a
 * screen that already had three.
 */
const TAG_CHIP = 'px-[10px] border-transparent bg-brand-wash text-brand-700'

// `button.tsx`'s focus treatment, borrowed for the raw buttons `Badge` cannot cover — the two
// nested inside the drawer's chip. A control a keyboard reaches needs this app's ring, not the
// UA outline.
const FOCUS_RING = 'outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

// How many of a customer's tags their table row shows before it stops and counts the rest.
const ROW_TAG_CAP = 3

const PAGE_SIZE = 50

/**
 * A shop's customers (#143). See CONTEXT.md → Shop customer.
 *
 * Everything on screen is computed by the backend — this used to fetch every order and group
 * them here on the raw WhatsApp string, which made two spellings of one number two people and
 * silently sat on a 1000-row truncation (#144). The browser now asks a question and draws the
 * answer.
 *
 * Sorting, the tag filter and writing a note or tags were the paid half of this screen until the
 * tier went (#222); they are ordinary controls now.
 *
 * `segment` is the sidebar's choice (#269): the Customers group's two children, All customers
 * and Members, are this one screen asked two questions. The list, its controls, the drawer and
 * the stat row are identical on both; only the predicate the backend applies differs.
 */
export default function CustomersView({ segment }: { segment: ShopCustomerSegment }) {
  const { t, merchant } = useSession()
  const merchantId = merchant!.id

  const [customers, setCustomers] = useState<ShopCustomer[] | null>(null)
  const [shopTags, setShopTags] = useState<string[]>([])
  const [stats, setStats] = useState<ShopCustomerStats | null>(null)
  const [total, setTotal] = useState(0)
  const [unattributed, setUnattributed] = useState(0)
  const [failed, setFailed] = useState(false)

  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<ShopCustomerSort>('recent')
  const [tag, setTag] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const [selected, setSelected] = useState<ShopCustomer | null>(null)


  const load = useCallback(async () => {
    const r = await fetchShopCustomers(merchantId, {
      sort,
      segment,
      tag: tag ?? undefined,
      search,
      page,
      pageSize: PAGE_SIZE,
    })
    if (!r.ok) { setFailed(true); return }
    setFailed(false)
    setCustomers(r.data.customers)
    setShopTags(r.data.shopTags)
    setStats(r.data.stats ?? null)
    setTotal(r.data.total)
    setUnattributed(r.data.unattributedOrders)
  }, [merchantId, sort, segment, tag, search, page])

  // A segment switch is a narrowing too, but it arrives from the sidebar rather than a handler
  // here, so the page-1 reset for it cannot live in `narrow` below. Adjusted during render, the
  // way React asks for state derived from a prop change, rather than in an effect one paint
  // late: page 3 of everyone is nothing on page 3 of members, which reads as "no members".
  const [seenSegment, setSeenSegment] = useState(segment)
  if (segment !== seenSegment) { setSeenSegment(segment); setPage(1) }

  // Debounced so typing a name is one request per pause, not one per keystroke.
  useEffect(() => {
    const id = setTimeout(load, search ? 250 : 0)
    return () => clearTimeout(id)
  }, [load, search])

  // Every narrowing returns to page 1, and it happens in the handlers rather than in an effect
  // watching them: staying on page 4 of a list that now has one page shows an empty table and
  // reads as "no results".
  const narrow = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1) }

  /**
   * A saved note or tag has to land in the open drawer AND in the row behind it — and, since
   * #150, in the shop's tag vocabulary: a tag typed here is offered to the next customer whose
   * drawer the merchant opens, without a reload they have no reason to perform.
   */
  function applyWrite(phoneKey: string, fields: { note: string | null; tags: string[] }) {
    setCustomers(prev => prev?.map(c => (c.phoneKey === phoneKey ? { ...c, ...fields } : c)) ?? prev)
    setSelected(cur => (cur && cur.phoneKey === phoneKey ? { ...cur, ...fields } : cur))
    setShopTags(prev => mergeShopTags(prev, fields.tags))
  }

  if (customers === null && !failed) {
    return <div className={PANEL}><SkeletonText lines={4} /></div>
  }

  if (failed) {
    return (
      <div className={`${PANEL} text-center text-muted-foreground text-sm`}>
        <p>{t('Could not load your customers. Try again in a moment.', '无法加载顾客名单，请稍后再试。')}</p>
      </div>
    )
  }

  const narrowed = search.trim() !== '' || tag !== null
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <>
      {stats && <StatRow stats={stats} segment={segment} />}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={e => narrow(setSearch)(e.target.value)}
          aria-label={t('Search customers', '搜索顾客')}
          placeholder={t('Search by name or WhatsApp…', '按姓名或 WhatsApp 搜索…')}
          className="max-w-sm bg-background border-border text-[13px]"
        />

        <SortControl sort={sort} onSort={narrow(setSort)} />
      </div>

      {/* `|| tag !== null` is not belt-and-braces. A shop whose whole vocabulary was the one tag
          currently filtering loses it the moment its last holder does: the next load answers
          `shopTags: []`, and on `shopTags.length > 0` alone the row would vanish while the filter
          stayed on — an empty table, "No customers match that", and nothing on screen to clear it
          with. That is the dead end `filterChips` keeps an unrecognised selection for. */}
      {(shopTags.length > 0 || tag !== null) && (
        <TagFilterRow shopTags={shopTags} selectedTag={tag} onSelect={narrow(setTag)} />
      )}

      {customers!.length === 0 ? (
        <div className={`${PANEL} text-center text-muted-foreground text-sm`}>
          <p>
            {narrowed
              ? t('No customers match that.', '没有符合条件的顾客。')
              : t(...SEGMENT_COPY[segment].empty)}
          </p>
        </div>
      ) : (
        // pixel-match of .admin-panel + .mm-customers-wrap (padding: 0; overflow: hidden)
        <div className="bg-card border-[0.5px] border-border rounded-2xl p-0 mb-3 w-full box-border overflow-hidden">
          {/* pixel-match of .mm-customers-table-wrap */}
          <div className="overflow-x-auto">
            {/* pixel-match of .mm-customers-table */}
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH}>{t('Name', '姓名')}</th>
                  <th className={TH}>{t('WhatsApp', 'WhatsApp')}</th>
                  {segment === 'members' && <th className={TH}>{t('Email', '邮箱')}</th>}
                  <th className={TH}>{t('Orders', '订单数')}</th>
                  <th className={TH}>{t('Spent', '消费额')}</th>
                  <th className={TH}>{t('Last Order', '最近订单')}</th>
                  <th className={TH}>{t('Tags', '标签')}</th>
                </tr>
              </thead>
              <tbody>
                {customers!.map(c => (
                  // group enables hover wash; last-child clears bottom border
                  <tr
                    key={c.phoneKey}
                    onClick={() => setSelected(c)}
                    // The row is the only way to open a customer, so it is reachable and
                    // operable from the keyboard — the same shape ui/data-table.tsx gives its
                    // clickable rows. Space is claimed too, or it scrolls the page instead.
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(c) }
                    }}
                    className="group cursor-pointer [&:last-child>td]:border-b-0 focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2"
                  >
                    <td className={TD}>
                      <span className="inline-flex items-center gap-1.5">
                        {c.name || '—'}
                        {c.hasAccount && <AccountMark />}
                      </span>
                    </td>
                    <td className={TD}>{c.wa ? <WaLink wa={c.wa} stopClick /> : '—'}</td>
                    {/* Members only (ADR 0026): on the All list a column that is a dash for
                        most rows says "guests have no email", which the account mark already
                        says, and costs every row the width. */}
                    {segment === 'members' && (
                      <td className={`${TD} max-w-[180px] truncate`} title={c.email ?? undefined}>{c.email ?? '—'}</td>
                    )}
                    <td className={TD_COUNT}>{c.bookedOrders}</td>
                    <td className={`${TD} tabular-nums whitespace-nowrap`}>{formatMoney(c.lifetimeSpend, merchant?.currency)}</td>
                    <td className={`${TD} whitespace-nowrap`}>
                      <span className="flex flex-col">
                        <span>{fmtDate(c.lastOrderAt)}</span>
                        <span className="text-[11px] text-muted-foreground">{agoLabel(c.daysSinceLastOrder, t)}</span>
                      </span>
                    </td>
                    <td className={TD}><RowTags tags={c.tags} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ListFooter
        total={total}
        page={page}
        pageCount={pageCount}
        unattributed={unattributed}
        segment={segment}
        onPage={setPage}
      />

      <CustomerDrawer
        customer={selected}
        merchantId={merchantId}
        shopTags={shopTags}
        onClose={() => setSelected(null)}
        onWritten={applyWrite}
        onTagClicked={next => { setSelected(null); narrow(setTag)(next) }}
      />
    </>
  )
}

/**
 * What the merchant has written against one customer, on their row.
 *
 * **Display, not a control.** The whole row opens the drawer, and a tag that also filtered would
 * put two different outcomes under one pointer — the filter already has its own row of chips
 * above the table, and the drawer's copies stay clickable for the merchant who is already there.
 *
 * Capped at three with a `+N`, because a customer may carry up to `MAX_TAGS` (20) and one such
 * row would set the height of every row around it. Which three is the merchant's own order —
 * tags are stored as written, and re-sorting here would be a second opinion nothing asked for.
 *
 */
function RowTags({ tags }: { tags: string[] }) {
  const shown = tags.slice(0, ROW_TAG_CAP)
  const hidden = tags.length - shown.length
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map(tag => (
        <Badge key={tag} className={TAG_CHIP}>{tag}</Badge>
      ))}
      {hidden > 0 && <span className="text-[11px] text-muted-foreground">+{hidden}</span>}
    </span>
  )
}

/** The has-an-account marker. Says who receives an order confirmation email — nothing more. */
function AccountMark() {
  const { t } = useSession()
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="text-muted-foreground" />}>
        <UserCheck size={13} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>
        {t('Has an account — gets order confirmation emails.', '拥有账户，会收到订单确认邮件。')}
      </TooltipContent>
    </Tooltip>
  )
}

function SortControl({
  sort, onSort,
}: { sort: ShopCustomerSort; onSort: (s: ShopCustomerSort) => void }) {
  const { t } = useSession()
  // One array feeds both `items` (what the trigger reads a label from) and the rendered
  // list, so the two cannot drift apart. Annotated rather than inferred: a typo'd value would
  // otherwise widen to `string`, compile, and surface as a raw key on the trigger — the exact
  // failure `items` was added to prevent.
  const sortItems: { value: ShopCustomerSort; label: string }[] = [
    { value: 'recent', label: t('Most recent order', '最近下单') },
    { value: 'spend', label: t('Highest spend', '消费最高') },
    { value: 'orders', label: t('Most orders', '订单最多') },
  ]
  return (
    <div className="flex items-center gap-2">
      <Select value={sort} onValueChange={v => onSort(v as ShopCustomerSort)} items={sortItems}>
        <SelectTrigger className="w-[190px] bg-background border-border text-[13px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sortItems.map(i => (
            <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * The shop's own tags, as a row of filters (#205).
 *
 * The filter is not new — the endpoint has taken `tag` since #143 and the list response has
 * carried `shopTags` since #150, described in CONTEXT.md as "what the tag filter chooses from".
 * What was missing was the choosing: the only way to set a tag was to open a customer's drawer
 * and click one of theirs, so a merchant looking for their VIPs had to find a VIP first.
 *
 * A chip row rather than a dropdown because the gap being closed is DISCOVERABILITY — the
 * vocabulary has to be visible without a click, or the merchant still does not know the filter
 * is there.
 */
function TagFilterRow({
  shopTags, selectedTag, onSelect,
}: { shopTags: string[]; selectedTag: string | null; onSelect: (tag: string | null) => void }) {
  const { t } = useSession()
  const [expanded, setExpanded] = useState(false)
  const { chips, hidden } = filterChips(shopTags, selectedTag, expanded)

  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{t('Tags', '标签')}</span>

      {chips.map(chip => {
        const on = chip === selectedTag
        return (
          <Badge
            key={chip}
            // Clicking the selected chip clears the filter — the same act, reversed, so there is
            // one control and not a filter plus a separate way to undo it.
            render={<button type="button" aria-pressed={on} onClick={() => onSelect(on ? null : chip)} />}
            // Selected is a MATCHING-COLOUR border, which is DESIGN.md's own answer for a chip
            // acting as a filter. Not `border-border`: a neutral hairline reads as the resting
            // outline every other pill on this screen already wears.
            className={`${TAG_CHIP} cursor-pointer ${on ? 'border-primary' : 'hover:border-border'}`}
          >
            {chip}
            {on && <X size={11} />}
          </Badge>
        )
      })}

      {hidden > 0 && (
        <Button type="button" variant="link" size="none" onClick={() => setExpanded(true)} className="text-[12px]">
          {t(`+${hidden} more`, `还有 ${hidden} 个`)}
        </Button>
      )}

      {/* Guarded on the cap, not on `expanded` alone: a vocabulary that shrank below the cap
          while expanded would otherwise offer to collapse a row that is already whole. */}
      {expanded && shopTags.length > TAG_CHIP_CAP && (
        <Button type="button" variant="link" size="none" onClick={() => setExpanded(false)} className="text-[12px]">
          {t('Show fewer', '收起')}
        </Button>
      )}
    </div>
  )
}

const STAT_ICON = { size: 15, strokeWidth: 1.75 }

/**
 * The three numbers above the list (#269), on the Overview's own `StatCard`.
 *
 * They are the rows summed — scoped by the backend exactly as `total` is, after the segment,
 * search and tag filter and before paging — so what the header says and what the table shows
 * can never disagree. Which is also why the search narrows them: one scope per page, and the
 * unfiltered figure is one cleared search away. No share-of-trade percentage, deliberately —
 * it needs the OTHER segment's figure on this one, and a merchant compares by clicking.
 */
function StatRow({ stats, segment }: { stats: ShopCustomerStats; segment: ShopCustomerSegment }) {
  const { t, merchant } = useSession()
  const copy = SEGMENT_COPY[segment]
  return (
    <div className="mb-4 grid grid-cols-3 gap-[10px] max-[520px]:grid-cols-1">
      <StatCard label={t(...copy.customers)} value={String(stats.customers)} icon={<Users {...STAT_ICON} />} />
      <StatCard label={t(...copy.bookedOrders)} value={String(stats.bookedOrders)} icon={<ReceiptText {...STAT_ICON} />} />
      <StatCard label={t(...copy.spend)} value={formatMoney(stats.spend, merchant?.currency)} icon={<Wallet {...STAT_ICON} />} />
    </div>
  )
}

/**
 * Every word that changes with the segment, in one place. "Booked", spelled out, because the
 * Overview's KPI card says "Total orders" and counts cancelled ones; this figure does not, and
 * two numbers on one dashboard must not wear one word for two meanings (CONTEXT.md → Shop
 * customer, the `bookedOrders` rule).
 */
const SEGMENT_COPY: Record<ShopCustomerSegment, {
  customers: [string, string]
  bookedOrders: [string, string]
  spend: [string, string]
  count: (n: number) => [string, string]
  empty: [string, string]
}> = {
  all: {
    customers: ['Customers', '顾客'],
    bookedOrders: ['Booked orders', '有效订单'],
    spend: ['Spent', '消费额'],
    count: n => [`${n} customer${n === 1 ? '' : 's'}`, `${n} 位顾客`],
    empty: ['No customers yet.', '暂无顾客。'],
  },
  members: {
    customers: ['Members', '会员'],
    bookedOrders: ['Booked orders from members', '会员有效订单'],
    spend: ['Spent by members', '会员消费'],
    count: n => [`${n} member${n === 1 ? '' : 's'}`, `${n} 位会员`],
    empty: ['No members yet — a member is a customer who ordered while signed in.', '暂无会员 —— 会员是登录后下单的顾客。'],
  },
}

/**
 * The count, the pager, and the one line that keeps the numbers honest.
 *
 * `unattributed` is not a footnote for tidiness: without it a merchant comparing this screen to
 * their order list finds fewer orders here and nothing saying why.
 */
function ListFooter({
  total, page, pageCount, unattributed, segment, onPage,
}: { total: number; page: number; pageCount: number; unattributed: number; segment: ShopCustomerSegment; onPage: (p: number) => void }) {
  const { t } = useSession()
  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
      <div className="text-[12px] text-muted-foreground">
        <p>{t(...SEGMENT_COPY[segment].count(total))}</p>
        {unattributed > 0 && (
          <p className="mt-1">
            {t(
              `${unattributed} order${unattributed === 1 ? '' : 's'} without a contact number ${unattributed === 1 ? 'is' : 'are'} not shown here.`,
              `${unattributed} 个订单没有联系电话，未在此显示。`,
            )}
          </p>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            {t('Previous', '上一页')}
          </Button>
          <span className="text-[12px] text-muted-foreground tabular-nums">{page} / {pageCount}</span>
          <Button type="button" size="sm" variant="outline" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
            {t('Next', '下一页')}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * One customer: what they spent, what the merchant wrote, and every order they placed here.
 *
 * The orders are fetched when the drawer opens rather than carried on every row of the table —
 * shipping hundreds of customers' full order histories to draw a table that shows none of them
 * is the mistake this whole change removes.
 */
function CustomerDrawer({
  customer, merchantId, shopTags, onClose, onWritten, onTagClicked,
}: {
  customer: ShopCustomer | null
  merchantId: string
  shopTags: string[]
  onClose: () => void
  onWritten: (phoneKey: string, fields: { note: string | null; tags: string[] }) => void
  onTagClicked: (tag: string) => void
}) {
  return (
    <Sheet open={customer !== null} onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent side="right" className="data-[side=right]:w-full data-[side=right]:sm:max-w-md overflow-y-auto">
        {/* Keyed, so switching customers REMOUNTS this: the order list and the note draft
            reset because they are born fresh, not because an effect remembered to clear them. */}
        {customer && (
          <DrawerContents
            key={customer.phoneKey}
            customer={customer}
            merchantId={merchantId}
                shopTags={shopTags}
            onWritten={onWritten}
            onTagClicked={onTagClicked}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function DrawerContents({
  customer, merchantId, shopTags, onWritten, onTagClicked,
}: {
  customer: ShopCustomer
  merchantId: string
  shopTags: string[]
  onWritten: (phoneKey: string, fields: { note: string | null; tags: string[] }) => void
  onTagClicked: (tag: string) => void
}) {
  const { t, merchant } = useSession()
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)

  useEffect(() => {
    let live = true
    fetchShopCustomerOrders(merchantId, customer.phoneKey).then(r => {
      if (live) setOrders(r.ok ? r.data : [])
    })
    return () => { live = false }
  }, [customer.phoneKey, merchantId])

  // A status or note change inside the stacked order detail must reflect in this drawer's list,
  // so re-opening shows the new value.
  function handleOrderUpdated(updated: Order) {
    setOrders(prev => prev?.map(o => (o.id === updated.id ? updated : o)) ?? prev)
    setSelectedOrder(cur => (cur && cur.id === updated.id ? updated : cur))
  }

  return (
    <>
              <SheetHeader className="border-b border-muted">
                <SheetTitle className="text-[15px] flex items-center gap-1.5">
                  {customer.name || '—'}
                  {customer.hasAccount && <AccountMark />}
                </SheetTitle>
                {customer.wa && <span className="text-[13px]"><WaLink wa={customer.wa} /></span>}
                {/* A member's account email (ADR 0026) — a mailto so it does the one thing an
                    address on a contact card is for. Absent for a guest, who has none. */}
                {customer.email && (
                  <a
                    href={`mailto:${customer.email}`}
                    className="text-[13px] text-foreground underline-offset-2 hover:underline break-all"
                  >
                    {customer.email}
                  </a>
                )}
                <span className="text-[12px] text-muted-foreground">
                  {t(
                    `${customer.bookedOrders} order${customer.bookedOrders === 1 ? '' : 's'} · ${formatMoney(customer.lifetimeSpend, merchant?.currency)} · avg ${formatMoney(customer.avgOrder, merchant?.currency)}`,
                    `${customer.bookedOrders} 个订单 · ${formatMoney(customer.lifetimeSpend, merchant?.currency)} · 平均 ${formatMoney(customer.avgOrder, merchant?.currency)}`,
                  )}
                </span>
                <span className="text-[12px] text-muted-foreground">
                  {t(
                    `Since ${fmtDate(customer.firstOrderAt)} · last ${agoLabel(customer.daysSinceLastOrder, t)}`,
                    `自 ${fmtDate(customer.firstOrderAt)} · 最近 ${agoLabel(customer.daysSinceLastOrder, t)}`,
                  )}
                </span>
              </SheetHeader>

              <NotesPanel
                customer={customer}
                merchantId={merchantId}
                        shopTags={shopTags}
                onWritten={onWritten}
                onTagClicked={onTagClicked}
              />

              <div className="flex flex-col gap-2 px-4 pb-4">
                {orders === null ? (
                  <SkeletonText lines={3} />
                ) : (
                  orders.map(o => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setSelectedOrder(o)}
                      className="flex flex-col gap-1 w-full text-left rounded-lg border border-border bg-background px-3 py-2.5 hover:bg-brand-wash transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-heading text-[14px] font-medium text-primary">{o.order_number || '—'}</span>
                        <span className="tabular-nums text-[13px] font-medium text-foreground">
                          {formatMoney(o.total, o.currency ?? merchant?.currency)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] text-muted-foreground">{fmtDate(o.created_at)}</span>
                        <StatusBadge status={o.status || 'new'} t={t} />
                      </div>
                    </button>
                  ))
                )}
      </div>

      {/* Full order detail — stacked on top of the customer drawer */}
      <OrderDetailSheet
        order={selectedOrder}
        onClose={() => setSelectedOrder(null)}
        onOrderUpdated={handleOrderUpdated}
      />
    </>
  )
}

/**
 * What the merchant knows, in their own words. Shop-private and invisible to the customer,
 * which is what makes it worth writing candidly — so the panel says so.
 */
function NotesPanel({
  customer, merchantId, shopTags, onWritten, onTagClicked,
}: {
  customer: ShopCustomer
  merchantId: string
  shopTags: string[]
  onWritten: (phoneKey: string, fields: { note: string | null; tags: string[] }) => void
  onTagClicked: (tag: string) => void
}) {
  const { t } = useSession()
  const [note, setNote] = useState(customer.note ?? '')
  const [tagDraft, setTagDraft] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(fields: { note: string | null; tags: string[] }) {
    setBusy(true)
    const r = await saveShopCustomer(merchantId, customer.phoneKey, fields)
    setBusy(false)
    if (!r.ok) {
      toast.error(r.error.message || t('Could not save', '保存失败'))
      return
    }
    onWritten(customer.phoneKey, { note: r.data.note, tags: r.data.tags })
  }

  /** One way in for both routes — typing a tag and clicking a suggestion are the same act. */
  function addTag(next: string) {
    setTagDraft('')
    if (!next || customer.tags.includes(next)) return
    save({ note: customer.note, tags: [...customer.tags, next] })
  }

  const suggestions = tagSuggestions(shopTags, customer.tags, tagDraft)

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {customer.tags.map(tag => (
            <Badge key={tag} className={TAG_CHIP}>
              <button
                type="button"
                onClick={() => onTagClicked(tag)}
                className={`cursor-pointer rounded-pill ${FOCUS_RING}`}
              >
                {tag}
              </button>
              <button
                type="button"
                aria-label={t(`Remove tag ${tag}`, `移除标签 ${tag}`)}
                onClick={() => save({ note: customer.note, tags: customer.tags.filter(x => x !== tag) })}
                className={`cursor-pointer rounded-pill p-0.5 -m-0.5 pointer-coarse:p-2 pointer-coarse:-m-1.5 opacity-60 hover:opacity-100 ${FOCUS_RING}`}
              >
                <X size={11} />
              </button>
            </Badge>
          ))}
        </div>
        <Input
          value={tagDraft}
          onChange={e => setTagDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            addTag(tagDraft.trim())
          }}
          aria-label={t('Add a tag', '添加标签')}
          placeholder={t('Add a tag, press Enter…', '添加标签，按回车…')}
          className="bg-background border-border text-[13px]"
        />

        {suggestions.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">{t('Used before', '曾用标签')}</span>
            {suggestions.map(s => (
              <Button
                key={s}
                type="button"
                variant="dashed"
                size="none"
                disabled={busy}
                onClick={() => addTag(s)}
                className="gap-1 rounded-pill bg-background px-2.5 py-0.5 text-[12px] hover:border-border"
              >
                <Plus size={10} />
                {s}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div>
        <Textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={3}
          aria-label={t('Private note', '私密备注')}
          placeholder={t('Private note — only your shop sees this…', '私密备注，仅本店可见…')}
          className="bg-background border-border text-[13px]"
        />
        {note !== (customer.note ?? '') && (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => save({ note: note.trim() || null, tags: customer.tags })}
            className="mt-2"
          >
            {busy ? t('Saving…', '保存中…') : t('Save note', '保存备注')}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * How long ago, in the coarsest unit that is still true.
 *
 * Deliberately NOT a "dormant" verdict. What counts as gone quiet is a shop's own judgement —
 * two weeks at a lunch place, most of a year at a cake shop — and a flag the platform cannot
 * get right is worse than a number the merchant reads themselves (CONTEXT.md → Shop customer).
 */
function agoLabel(days: number, t: (en: string, zh?: string) => string): string {
  if (days <= 0) return t('today', '今天')
  if (days === 1) return t('yesterday', '昨天')
  if (days < 30) return t(`${days} days ago`, `${days} 天前`)
  const months = Math.floor(days / 30)
  if (months < 12) return t(`${months} month${months === 1 ? '' : 's'} ago`, `${months} 个月前`)
  const years = Math.floor(days / 365)
  return t(`${years} year${years === 1 ? '' : 's'} ago`, `${years} 年前`)
}
