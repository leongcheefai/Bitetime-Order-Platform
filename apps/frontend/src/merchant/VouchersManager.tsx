import { useEffect, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal, Ticket } from 'lucide-react'
import { useSession } from '../SessionContext'
import { toast } from 'sonner'
import { fetchMerchantVouchers, setMerchantVoucherActive } from '../store'
import { formatMoney } from '../currency'
import { SkeletonText } from '../components/Loaders'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '../components/ui/dropdown-menu'
import { DataTable, SortableHeader } from '../components/ui/data-table'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from '../components/ui/empty'
import VoucherFormSheet from './VoucherFormSheet'
import type { Voucher } from '../types'

// Handlers + language + currency ride on table.options.meta so the column defs stay
// stable (defined once) and never reset sorting when a row action refetches — the same
// arrangement ProductsManager uses, so the two tables behave as one.
interface VoucherTableMeta {
  t: (en: string, zh: string) => string
  currency?: string
  onEdit: (v: Voucher) => void
  onSetActive: (v: Voucher, active: boolean) => void
}

function discountLabel(v: Voucher, currency: string | undefined, t: VoucherTableMeta['t']) {
  return v.type === 'percent'
    ? t(`${v.value}% off`, `减 ${v.value}%`)
    : t(`${formatMoney(v.value, currency)} off`, `减 ${formatMoney(v.value, currency)}`)
}

/**
 * The restrictions, as short clauses. Only what the merchant actually set is drawn — a row
 * reading "1 per customer · no expiry · no minimum" states three non-facts and buries the one
 * voucher on the list that does have a rule.
 */
function restrictionLabels(v: Voucher, currency: string | undefined, t: VoucherTableMeta['t']): string[] {
  const out: string[] = []
  if (v.perCustomerLimit == null) out.push(t('reusable', '可重复使用'))
  else if (v.perCustomerLimit > 1) out.push(t(`${v.perCustomerLimit} per customer`, `每人 ${v.perCustomerLimit} 次`))
  // `expiresOn` is the SHOP-LOCAL date the server derived. Never slice `expiresAt` here: east of
  // UTC the instant sits on the previous calendar day and would read a day early.
  if (v.expiresOn) out.push(t(`until ${v.expiresOn}`, `有效期至 ${v.expiresOn}`))
  if (v.minOrder != null) out.push(t(`min ${formatMoney(Number(v.minOrder), currency)}`, `最低 ${formatMoney(Number(v.minOrder), currency)}`))
  return out
}

const columns: ColumnDef<Voucher>[] = [
  {
    accessorKey: 'code',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as VoucherTableMeta).t('Code', '优惠码')} />
    ),
    cell: ({ row, table }) => {
      const { t } = table.options.meta as VoucherTableMeta
      const v = row.original
      const paused = v.active === false
      return (
        <div className={`font-heading text-[14px] font-medium flex items-center gap-2 flex-wrap ${paused ? 'text-muted-foreground' : 'text-primary'}`}>
          {v.code}
          {/* A paused voucher stays on the list, marked. It used to vanish, which is what made
              "Turn off" read as delete: the merchant needs to see that the code they handed out
              is off, and to have somewhere to switch it back on. */}
          {paused && (
            <Badge variant="danger" className="uppercase tracking-[0.08em]">
              {t('Paused', '已暂停')}
            </Badge>
          )}
        </div>
      )
    },
  },
  {
    id: 'discount',
    accessorFn: v => v.value,
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as VoucherTableMeta).t('Discount', '折扣')} />
    ),
    cell: ({ row, table }) => {
      const { t, currency } = table.options.meta as VoucherTableMeta
      return <span className="text-[13px] text-foreground whitespace-nowrap">{discountLabel(row.original, currency, t)}</span>
    },
  },
  {
    id: 'uses',
    accessorFn: v => v.usedCount ?? 0,
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as VoucherTableMeta).t('Used', '已用')} />
    ),
    cell: ({ row, table }) => {
      const { t } = table.options.meta as VoucherTableMeta
      const v = row.original
      // The API's count. It never sends the redeemer list to the merchant — a shop sees
      // shop-scoped facts and no account email (CONTEXT.md -> Shop customer).
      const used = v.usedCount ?? 0
      const cap = v.maxUses == null ? '∞' : v.maxUses
      return (
        <span className={`text-[13px] whitespace-nowrap ${v.fullyUsed ? 'text-muted-foreground italic' : 'text-foreground'}`}>
          {used} / {cap}{v.fullyUsed ? ` · ${t('fully used', '已用完')}` : ''}
        </span>
      )
    },
  },
  {
    id: 'restrictions',
    enableSorting: false,
    header: ({ table }) => (
      <span className="whitespace-nowrap">{(table.options.meta as VoucherTableMeta).t('Restrictions', '限制')}</span>
    ),
    cell: ({ row, table }) => {
      const { t, currency } = table.options.meta as VoucherTableMeta
      const labels = restrictionLabels(row.original, currency, t)
      if (labels.length === 0) return <span className="text-[13px] text-muted-foreground italic">{t('None', '无')}</span>
      return <span className="text-[13px] text-muted-foreground">{labels.join(' · ')}</span>
    },
  },
  {
    id: 'actions',
    header: ({ table }) => (
      <div className="text-right whitespace-nowrap">{(table.options.meta as VoucherTableMeta).t('Actions', '操作')}</div>
    ),
    cell: ({ row, table }) => {
      const meta = table.options.meta as VoucherTableMeta
      const { t } = meta
      const v = row.original
      return (
        // The row itself opens the drawer. A press on the menu — or on an item inside it, which
        // React bubbles through the portal — must not also count as a press on the row, or
        // "Deactivate" would pause the voucher AND open it for editing.
        <div className="text-right" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="none"
                  className="size-9 p-0 rounded-pill cursor-pointer pointer-coarse:size-11 hover:bg-brand-wash hover:text-primary"
                  aria-label={t('Actions', '操作')}
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onEdit(v)}>{t('Edit', '编辑')}</DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* Not destructive-styled and not confirmed: a pause is reversible from the same
                  menu, and a red item with a dialog is what told merchants it was a delete. */}
              {v.active === false ? (
                <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onSetActive(v, true)}>{t('Activate', '启用')}</DropdownMenuItem>
              ) : (
                <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onSetActive(v, false)}>{t('Deactivate', '停用')}</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )
    },
  },
]

export default function VouchersManager() {
  const { t, merchant } = useSession()
  const [rows, setRows] = useState<Voucher[] | null>(null)
  // editingVoucher = the row the form is open on (null → add mode).
  const [editingVoucher, setEditingVoucher] = useState<Voucher | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  // One id per opening of the form: what tells VoucherFormSheet a NEW opening has arrived, so the
  // same voucher opened twice still starts clean.
  const [formSession, setFormSession] = useState(() => crypto.randomUUID())
  const currency = merchant?.currency

  // Parity with the old `[]`-on-failure behaviour: a dashboard list that could not load shows
  // empty rather than a stuck spinner. The load-bearing could-not-ask handling lives on the
  // customer path (Storefront), not here.
  async function load() {
    const r = await fetchMerchantVouchers(merchant!.id)
    setRows(r.ok ? r.data : [])
  }
  useEffect(() => { fetchMerchantVouchers(merchant!.id).then(r => setRows(r.ok ? r.data : [])) }, [merchant!.id])

  function openAdd() {
    setEditingVoucher(null)
    setFormSession(crypto.randomUUID())
    setFormOpen(true)
  }
  function openEdit(v: Voucher) {
    setEditingVoucher(v)
    setFormSession(crypto.randomUUID())
    setFormOpen(true)
  }

  async function setActive(v: Voucher, active: boolean) {
    const r = await setMerchantVoucherActive(v.id as string, merchant!.id, active)
    if (r.ok) {
      await load()
      toast.success(active ? t('Voucher activated', '优惠券已启用') : t('Voucher paused', '优惠券已暂停'))
    } else if (r.error?.code === 'duplicate_code') {
      // The merchant created a second live voucher with this code while this one was paused.
      toast.error(t('Another active voucher already uses this code. Deactivate it first.', '另一张启用中的优惠券已使用此优惠码。请先停用它。'))
    } else {
      toast.error(active ? t('Could not activate voucher', '无法启用优惠券') : t('Could not pause voucher', '无法暂停优惠券'))
    }
  }

  const meta: VoucherTableMeta = {
    t, currency,
    onEdit: openEdit,
    onSetActive: setActive,
  }

  if (!rows) return (
    <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border">
      <SkeletonText lines={4} />
    </div>
  )

  // Live codes first, paused ones under them. The API already orders newest-first inside each
  // group, and a stable sort keeps that.
  const ordered = [...rows].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))

  return (
    <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h3 className="font-heading text-[15px] font-medium text-primary flex items-center gap-2">
          {t('Your vouchers', '您的优惠券')}
        </h3>
        <Button type="button" size="none" className="rounded-lg py-[6px] px-[14px] text-[13px]" onClick={openAdd}>
          {t('+ Add voucher', '+ 添加优惠券')}
        </Button>
      </div>

      {rows.length === 0 ? (
        <Empty className="border-[0.5px] border-dashed border-border bg-background/50">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-brand-wash text-primary">
              <Ticket />
            </EmptyMedia>
            <EmptyTitle className="text-primary">{t('No vouchers yet', '还没有优惠券')}</EmptyTitle>
            <EmptyDescription className="text-muted-foreground">
              {t('Create your first voucher to offer discounts at checkout.', '创建第一张优惠券，为结账提供折扣。')}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" size="none" className="rounded-lg py-[6px] px-[14px] text-[13px]" onClick={openAdd}>
              {t('+ Add voucher', '+ 添加优惠券')}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <DataTable
          columns={columns}
          data={ordered}
          meta={meta}
          onRowClick={openEdit}
          searchPlaceholder={t('Search vouchers…', '搜索优惠券…')}
          emptyText={t('No vouchers match your search.', '没有匹配的优惠券。')}
          prevLabel={t('Previous', '上一页')}
          nextLabel={t('Next', '下一页')}
        />
      )}

      <VoucherFormSheet
        open={formOpen}
        onOpenChange={setFormOpen}
        voucher={editingVoucher}
        sessionId={formSession}
        onSaved={load}
      />

    </div>
  )
}
