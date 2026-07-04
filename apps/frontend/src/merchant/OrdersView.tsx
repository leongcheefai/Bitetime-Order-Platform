import { useEffect, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useSession } from '../SessionContext'
import { fetchMerchantOrders, setOrderStatus } from '../store'
import { formatMoney } from '../currency'
import { SkeletonText } from '../components/Loaders'
import { Badge } from '@/components/ui/badge'
import { DataTable, SortableHeader } from '@/components/ui/data-table'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'

const ORDER_STATUSES = ['new', 'preparing', 'ready', 'completed', 'cancelled']

const STATUS_LABELS: Record<string, { en: string; zh: string }> = {
  new:       { en: 'New',       zh: '新订单' },
  preparing: { en: 'Preparing', zh: '备料中' },
  ready:     { en: 'Ready',     zh: '已备好' },
  completed: { en: 'Completed', zh: '已完成' },
  cancelled: { en: 'Cancelled', zh: '已取消' },
}

// Status → Badge config (unchanged from the card version).
type BadgeConfig = { variant?: 'infoBlue' | 'danger'; className?: string }
const STATUS_BADGE: Record<string, BadgeConfig> = {
  new:       { variant: 'infoBlue' },
  preparing: { className: 'bg-warn-bg-alt text-warn-fg-alt border-transparent' },
  ready:     { className: 'bg-success-bg-soft text-success-deep border-transparent' },
  completed: { className: 'bg-prep-bg-alt text-prep-fg-alt border-transparent' },
  cancelled: { className: 'bg-danger-bg text-danger-fg border-transparent' },
}

// 11px semibold uppercase rose-muted label.
const LBL = 'text-[11px] font-semibold uppercase tracking-[0.06em] text-rose-muted shrink-0'

// Self-contained select classes (pixel-match of .admin-field-select).
const SELECT_CLS =
  'w-full py-[7px] pl-[10px] pr-[32px] border border-clay-border rounded-sm text-[13px] ' +
  'bg-cream text-ink font-sans appearance-none bg-no-repeat cursor-pointer min-w-[140px] ' +
  'focus:outline-none focus:border-oxblood focus:shadow-[0_0_0_2px_rgba(122,16,40,0.1)]'

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

function StatusBadge({ status, t }: { status: string; t: (en: string, zh: string) => string }) {
  const badge = STATUS_BADGE[status] ?? { variant: 'infoBlue' as const }
  return (
    <Badge variant={badge.variant} className={badge.className}>
      {t(STATUS_LABELS[status]?.en ?? status, STATUS_LABELS[status]?.zh ?? status)}
    </Badge>
  )
}

// Handlers + language + currency ride on table.options.meta so the column defs
// stay stable (defined once) and never reset sorting when the data refetches.
interface OrderTableMeta {
  t: (en: string, zh: string) => string
  currency?: string
  onSelect: (o: any) => void
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
      <span className="whitespace-nowrap text-text-tertiary">{fmtTime(row.original.created_at)}</span>
    ),
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
    cell: ({ row }) => <span>{row.original.mode || '—'}</span>,
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

// A labelled key/value line in the detail sheet — value hidden when empty.
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 flex-wrap text-[13px] text-ink">
      <span className={LBL}>{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

export default function OrdersView({ readOnly = false }: { readOnly?: boolean } = {}) {
  const { t, merchant } = useSession()
  const [orders, setOrders] = useState<any[] | null>(null)
  const [selected, setSelected] = useState<any | null>(null)

  useEffect(() => {
    fetchMerchantOrders(merchant!.id).then(setOrders)
  }, [merchant!.id])

  function handleStatusChange(order: any, status: string) {
    setOrderStatus(order.id, status).then(updated => {
      setOrders(prev => (prev ? prev.map(o => (o.id === updated.id ? updated : o)) : prev))
      setSelected((cur: any) => (cur && cur.id === updated.id ? updated : cur))
    })
  }

  const meta: OrderTableMeta = { t, currency: merchant?.currency, onSelect: setSelected }

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

      <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null) }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          {selected && (
            <>
              <SheetHeader className="border-b border-surface-sunken">
                <div className="flex items-center gap-[10px] flex-wrap">
                  <SheetTitle className="text-[15px]">{selected.order_number || '—'}</SheetTitle>
                  <StatusBadge status={selected.status || 'new'} t={t} />
                </div>
                <span className="text-[12px] text-text-tertiary">{fmtTime(selected.created_at)}</span>
              </SheetHeader>

              <div className="flex flex-col gap-[10px] px-4 pb-4">
                <DetailRow label={t('Customer', '顾客')}>
                  {selected.customer_name || '—'}
                  {selected.customer_wa && (
                    <>
                      {'  '}
                      <a
                        href={`https://wa.me/${selected.customer_wa.replace(/\D/g, '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-oxblood no-underline font-medium hover:underline"
                      >
                        {selected.customer_wa}
                      </a>
                    </>
                  )}
                </DetailRow>

                <DetailRow label={t('Items', '商品')}>{itemsSummary(selected.items)}</DetailRow>

                <DetailRow label={t('Total', '总计')}>
                  <strong>{formatMoney(selected.total, selected.currency ?? merchant?.currency)}</strong>
                </DetailRow>

                {selected.shipping_fee != null && (
                  <DetailRow label={t('Shipping', '运费')}>
                    {formatMoney(selected.shipping_fee, selected.currency ?? merchant?.currency)}
                  </DetailRow>
                )}

                <DetailRow label={t('Mode', '方式')}>{selected.mode || '—'}</DetailRow>
                {selected.region && <DetailRow label={t('Region', '地区')}>{selected.region}</DetailRow>}
                {selected.address && <DetailRow label={t('Address', '地址')}>{selected.address}</DetailRow>}
                {selected.preferred_date && (
                  <DetailRow label={t('Preferred date', '首选日期')}>{selected.preferred_date}</DetailRow>
                )}
                {selected.note && <DetailRow label={t('Note', '备注')}>{selected.note}</DetailRow>}
                {selected.awb && <DetailRow label={t('AWB', '运单号')}>{selected.awb}</DetailRow>}

                {!readOnly && (
                  <div className="flex flex-col gap-1 pt-[10px] border-t border-surface-sunken">
                    <label className={LBL} htmlFor={`status-${selected.id}`}>{t('Status', '状态')}</label>
                    <select
                      id={`status-${selected.id}`}
                      className={SELECT_CLS}
                      style={{ backgroundImage: CHEVRON_SVG, backgroundPosition: 'right 10px center' }}
                      value={selected.status || 'new'}
                      onChange={e => handleStatusChange(selected, e.target.value)}
                    >
                      {ORDER_STATUSES.map(s => (
                        <option key={s} value={s}>{t(STATUS_LABELS[s].en, STATUS_LABELS[s].zh)}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
