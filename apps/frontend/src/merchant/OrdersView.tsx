import { useEffect, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import type { Lang, Translate } from '../types'
import { useSession } from '../SessionContext'
import { fetchMerchantOrders } from '../store'
import { formatMoney } from '../currency'
import { formatCalendarDate } from '../orderDate'
import { fmtDateTime } from '../merchantDate'
import { SkeletonText } from '../components/Loaders'
import { DataTable, SortableHeader } from '@/components/ui/data-table'
import { StatusBadge } from '../orderStatus'
import { fulfilmentLabel } from '../fulfilmentLabel'
import OrderDetailSheet from './OrderDetailSheet'

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
      <span className="font-heading text-[14px] font-medium text-oxblood whitespace-nowrap">
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
      <span className="whitespace-nowrap text-text-tertiary">{fmtDateTime(row.original.created_at)}</span>
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
        <span className="whitespace-nowrap">
          {row.original.fulfil_date ? formatCalendarDate(row.original.fulfil_date, meta.lang) : '—'}
        </span>
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
]

export default function OrdersView({ readOnly = false }: { readOnly?: boolean } = {}) {
  const { t, lang, merchant } = useSession()
  const [orders, setOrders] = useState<any[] | null>(null)
  const [selected, setSelected] = useState<any | null>(null)

  useEffect(() => {
    fetchMerchantOrders(merchant!.id).then(setOrders)
  }, [merchant!.id])

  function patchOrder(updated: any) {
    setOrders(prev => (prev ? prev.map(o => (o.id === updated.id ? updated : o)) : prev))
    setSelected((cur: any) => (cur && cur.id === updated.id ? updated : cur))
  }

  const meta: OrderTableMeta = { t, lang, currency: merchant?.currency }

  if (orders === null) {
    return (
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
        <SkeletonText lines={4} />
      </div>
    )
  }

  return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
      <DataTable
        columns={columns}
        data={orders}
        meta={meta}
        onRowClick={setSelected}
        pageSize={15}
        searchPlaceholder={t('Search orders…', '搜索订单…')}
        emptyText={t('No orders yet.', '暂无订单。')}
        prevLabel={t('Previous', '上一页')}
        nextLabel={t('Next', '下一页')}
      />

      <OrderDetailSheet
        order={selected}
        onClose={() => setSelected(null)}
        onOrderUpdated={patchOrder}
        readOnly={readOnly}
      />
    </div>
  )
}
