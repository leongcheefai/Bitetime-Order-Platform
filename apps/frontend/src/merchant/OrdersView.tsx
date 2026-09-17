import { useCallback, useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import type { ColumnDef, SortingState } from '@tanstack/react-table'
import type { Lang, Translate } from '../types'
import { useSession } from '../SessionContext'
import { fetchMerchantOrders, fetchOrderStatusCounts, type OrderListQuery } from '../store'
import { formatMoney } from '../currency'
import { formatCalendarDate, formatSlotRange } from '../orderDate'
import { fmtDateTime } from '../merchantDate'
import { SkeletonText } from '../components/Loaders'
import { DataTable, SortableHeader } from '@/components/ui/data-table'
import { StatusBadge } from '../orderStatus'
import { fulfilmentLabel } from '../fulfilmentLabel'
import { usePoll } from '../usePoll'
import OrderDetailSheet from './orderDetail/OrderDetailSheet'
import OrderStatusFilter from './OrderStatusFilter'

// Handlers + language + currency ride on table.options.meta so the column defs
// stay stable (defined once) and never reset sorting when the data refetches.
interface OrderTableMeta {
  t: Translate
  lang: Lang
  currency?: string
}

const columns: ColumnDef<any>[] = [
  {
    accessorKey: 'order_number',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as OrderTableMeta).t('Order #', '订单号')} />
    ),
    cell: ({ row }) => (
      <span className="font-heading text-[14px] font-medium text-primary whitespace-nowrap">
        {row.original.order_number || '—'}
      </span>
    ),
  },
  {
    accessorKey: 'created_at',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as OrderTableMeta).t('Time', '时间')} />
    ),
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-muted-foreground">{fmtDateTime(row.original.created_at)}</span>
    ),
  },
  {
    accessorKey: 'fulfil_date',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as OrderTableMeta).t('For', '取货日期')} />
    ),
    cell: ({ row, table }) => {
      const meta = table.options.meta as OrderTableMeta
      return (
        <div className="whitespace-nowrap">
          {row.original.fulfil_date ? formatCalendarDate(row.original.fulfil_date, meta.lang) : '—'}
          {row.original.fulfil_time_from && (
            <div className="text-[12px] text-muted-foreground tabular-nums">
              {formatSlotRange(row.original.fulfil_time_from, row.original.fulfil_time_to)}
            </div>
          )}
        </div>
      )
    },
  },
  {
    accessorKey: 'customer_name',
    header: ({ table }) => (
      <span>{(table.options.meta as OrderTableMeta).t('Customer', '顾客')}</span>
    ),
    cell: ({ row }) => <span>{row.original.customer_name || '—'}</span>,
  },
  {
    accessorKey: 'total',
    header: ({ column, table }) => (
      <div className="text-right">
        <SortableHeader column={column} label={(table.options.meta as OrderTableMeta).t('Total', '总计')} />
      </div>
    ),
    cell: ({ row, table }) => {
      const meta = table.options.meta as OrderTableMeta
      return (
        <div className="text-right whitespace-nowrap font-medium">
          {formatMoney(row.original.total, row.original.currency ?? meta.currency)}
        </div>
      )
    },
  },
  {
    accessorKey: 'mode',
    header: ({ table }) => (
      <span>{(table.options.meta as OrderTableMeta).t('Mode', '方式')}</span>
    ),
    cell: ({ row, table }) => (
      <span>{fulfilmentLabel(row.original.mode, (table.options.meta as OrderTableMeta).t)}</span>
    ),
  },
  {
    accessorKey: 'status',
    enableSorting: false,
    header: ({ table }) => (
      <span>{(table.options.meta as OrderTableMeta).t('Status', '状态')}</span>
    ),
    cell: ({ row, table }) => (
      <StatusBadge status={row.original.status || 'new'} t={(table.options.meta as OrderTableMeta).t} />
    ),
  },
  {
    accessorKey: 'review_rating',
    enableSorting: false,
    header: ({ table }) => (
      <span>{(table.options.meta as OrderTableMeta).t('Rating', '评分')}</span>
    ),
    // The number beside ONE star, not five drawn stars: this cell sits in a dense table, and five
    // glyphs in every row would out-shout the status badge next to it. A row of five EMPTY stars
    // would be worse still — it reads as "rated nothing", which is a different and untrue
    // statement. An unrated order gets the same em dash every other cell in this table uses for a
    // value the order does not carry.
    cell: ({ row }) => {
      const rating = row.original.review_rating as number | null | undefined
      if (!rating) return <span className="text-muted-foreground">—</span>
      return (
        <span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
          <Star size={14} strokeWidth={2} className="fill-primary text-primary" aria-hidden />
          {rating}
        </span>
      )
    },
  },
]

const PAGE_SIZE = 15

/** The sorts the backend offers; anything else is a 400, so the table may not invent one. */
type OrderSort = NonNullable<OrderListQuery['sort']>
const SORTABLE: readonly string[] = ['created_at', 'order_number', 'fulfil_date', 'total']

/**
 * The merchant's orders, PAGED BY THE BACKEND (#144).
 *
 * This used to fetch every order the shop had ever taken and page, sort and search them in the
 * browser. PostgREST caps a response at 1000 rows and reports it only in a header nothing read,
 * so past a shop's 1000th order the oldest orders were simply unreachable — no error, no empty
 * state, just a list that ended early and looked complete. Paging cannot fix that from this side:
 * a table cannot reach rows it was never sent. So the paging, the sort and the search all moved
 * to the query, and the count comes back with every page so the merchant can see what they are
 * looking at a slice of.
 */
export default function OrdersView(
  { readOnly = false, onOrdersChanged }: { readOnly?: boolean; onOrdersChanged?: () => void } = {},
) {
  const { t, lang, merchant } = useSession()
  const [orders, setOrders] = useState<any[] | null>(null)
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState<any | null>(null)

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  // '' is every status. The tallies above the table are the control that sets this.
  const [status, setStatus] = useState('')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'created_at', desc: true }])

  const merchantId = merchant!.id
  // The table's own sort state is the source; a column it cannot sort on server-side would be a
  // 400, so it falls back to the default rather than asking for something the backend refuses.
  const active = sorting[0]
  const sort = (active && SORTABLE.includes(active.id) ? active.id : 'created_at') as OrderSort
  const dir = active?.desc === false ? 'asc' : 'desc'

  const load = useCallback(() => {
    fetchMerchantOrders(merchantId, { page, pageSize: PAGE_SIZE, sort, dir, search, status }).then(r => {
      if (!r.ok) { setFailed(true); return }
      setFailed(false)
      setOrders(r.data.orders)
      setTotal(r.data.total)
    })
    // The tallies follow the SEARCH but not the status filter — narrowed to one status they
    // would all read zero but that one, and the merchant could no longer see what else is
    // waiting, which is most of what the row is for. A failed count leaves the last figures
    // standing rather than emptying the row the merchant is filtering with.
    fetchOrderStatusCounts(merchantId, search).then(r => { if (r.ok) setCounts(r.data) })
  }, [merchantId, page, sort, dir, search, status])

  // Debounced so typing a name is one request per pause, not one per keystroke — the same shape
  // the Customers tab uses for the same reason.
  useEffect(() => {
    const id = setTimeout(load, search ? 250 : 0)
    return () => clearTimeout(id)
  }, [load, search])

  // The list a merchant is reading must be the list that exists. The poll refetches the page they
  // are on, so an order arriving does not shuffle them somewhere else in the history.
  usePoll(load)

  function patchOrder(updated: any) {
    setOrders(prev => (prev ? prev.map(o => (o.id === updated.id ? updated : o)) : prev))
    setSelected((cur: any) => (cur && cur.id === updated.id ? updated : cur))
    // Status may have changed the "new" order count — let the shell refresh its badge.
    onOrdersChanged?.()
    // And the tallies, and — under a status filter — which orders belong on this page at all.
    // The local patch above is what keeps the drawer instant; this reconciles the list behind it.
    load()
  }

  // Every narrowing returns to page 1: staying on page 4 of a list that now has one page shows
  // an empty table, which reads as "no orders".
  const narrow = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1) }

  const meta: OrderTableMeta = { t, lang, currency: merchant?.currency }
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (failed) {
    return (
      <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border text-center text-sm text-muted-foreground">
        {t('Could not load your orders. Try again in a moment.', '无法加载订单，请稍后再试。')}
      </div>
    )
  }

  if (orders === null) {
    return (
      <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border">
        <SkeletonText lines={4} />
      </div>
    )
  }

  return (
    <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border">
      <DataTable
        columns={columns}
        data={orders}
        meta={meta}
        onRowClick={setSelected}
        pageSize={PAGE_SIZE}
        searchPlaceholder={t('Search orders…', '搜索订单…')}
        toolbar={
          <OrderStatusFilter counts={counts} selected={status} onSelect={narrow(setStatus)} t={t} />
        }
        emptyText={
          // "No orders yet" is a statement about the SHOP, and under a filter it is a false one —
          // a merchant reading it over an empty Cancelled list would conclude they had never
          // taken an order at all.
          search.trim() || status
            ? t('No orders match.', '没有匹配的订单。')
            : t('No orders yet.', '暂无订单。')
        }
        prevLabel={t('Previous', '上一页')}
        nextLabel={t('Next', '下一页')}
        server={{
          page,
          pageCount,
          onPageChange: setPage,
          sorting,
          onSortingChange: narrow(setSorting),
          search,
          onSearchChange: narrow(setSearch),
        }}
      />

      {/* The count, stated. A merchant reading fifteen rows should be able to tell fifteen
          orders from the first fifteen of nine hundred — which the old unbounded list, cut off
          at a thousand without saying so, gave them no way to do. */}
      <p className="pt-3 text-[12px] text-muted-foreground">
        {search.trim() || status
          ? t(`${total} matching order${total === 1 ? '' : 's'}`, `${total} 笔匹配订单`)
          : t(`${total} order${total === 1 ? '' : 's'}`, `${total} 笔订单`)}
      </p>

      <OrderDetailSheet
        order={selected}
        onClose={() => setSelected(null)}
        onOrderUpdated={patchOrder}
        readOnly={readOnly}
      />
    </div>
  )
}
