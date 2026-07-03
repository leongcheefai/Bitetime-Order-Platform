import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { MoreHorizontal } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import { fetchAllMerchants, setMerchantStatus, approveMerchant, compMerchant, fetchAllBilling, type MerchantBilling } from '../store'
import { useSession } from '../SessionContext'
import { toast } from 'sonner'
import type { Merchant, MerchantStatus } from '../types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, SortableHeader } from '@/components/ui/data-table'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu'

// Billing status is folded onto each row so the Subscription column can sort/filter
// on it (accessorFn only sees the row, not table meta).
type MerchantRow = Merchant & { billingStatus?: string | null }

// Handlers + language + in-flight id ride on table.options.meta so the column defs
// stay stable (defined once) and never reset sorting when a row action refetches.
interface AdminTableMeta {
  t: (en: string, zh: string) => string
  busy: string | null
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onSuspend: (id: string) => void
  onReactivate: (id: string) => void
  onComp: (id: string) => void
}

const columns: ColumnDef<MerchantRow>[] = [
  {
    accessorKey: 'name',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as AdminTableMeta).t('Shop', '店铺')} />
    ),
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
  },
  {
    accessorKey: 'slug',
    header: ({ table }) => (table.options.meta as AdminTableMeta).t('Slug', '网址'),
    cell: ({ row }) => (
      <a
        href={`/s/${row.original.slug}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-oxblood no-underline font-medium hover:underline"
      >/s/{row.original.slug}</a>
    ),
  },
  {
    accessorKey: 'status',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as AdminTableMeta).t('Status', '状态')} />
    ),
    cell: ({ row }) => {
      const s = row.original.status
      // className overrides match .mm-badge--{status} exactly (px-[10px], no border;
      // active uses success-bg-soft/deep, not the success variant's success-bg/fg).
      return (
        <Badge className={
          'px-[10px] border-transparent ' + (
            s === 'active' ? 'bg-success-bg-soft text-success-deep' :
            s === 'pending' ? 'bg-warn-bg text-warn-fg' :
            'bg-danger-bg text-danger-fg'
          )
        }>{s}</Badge>
      )
    },
  },
  {
    id: 'subscription',
    accessorFn: (r) => `${r.plan ?? ''} ${r.billingStatus ?? ''}`.trim(),
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as AdminTableMeta).t('Subscription', '订阅')} />
    ),
    cell: ({ row, table }) => {
      const { t } = table.options.meta as AdminTableMeta
      const m = row.original
      const plan = m.plan === 'pro' ? t('Pro', 'Pro')
        : m.plan === 'basic' ? t('Basic', '基础版') : null
      const sub = m.billingStatus
      if (!plan && !sub) return <span className="text-text-tertiary">—</span>
      const subLabel = sub === 'active' ? t('active', '有效')
        : sub === 'trialing' ? t('trialing', '试用')
        : sub === 'past_due' ? t('past due', '逾期')
        : sub === 'canceled' ? t('canceled', '已取消')
        : sub === 'incomplete' ? t('incomplete', '未完成')
        : sub
      const subCls = sub === 'active' ? 'text-success-deep'
        : sub === 'trialing' ? 'text-warn-fg'
        : (sub === 'past_due' || sub === 'canceled' || sub === 'incomplete') ? 'text-danger-fg'
        : 'text-text-tertiary'
      return (
        <span className="inline-flex items-center gap-[6px] whitespace-nowrap">
          {plan && (
            <Badge className={
              'px-[10px] ' + (m.plan === 'pro'
                ? 'border-transparent bg-oxblood-tint text-oxblood'
                : 'bg-transparent border-clay-border text-rose-muted')
            }>{plan}</Badge>
          )}
          {sub && <span className={'text-[12px] ' + subCls}>{subLabel}</span>}
        </span>
      )
    },
  },
  {
    id: 'open',
    header: ({ table }) => (table.options.meta as AdminTableMeta).t('Open', '打开'),
    cell: ({ row, table }) => {
      const { t } = table.options.meta as AdminTableMeta
      return (
        <Link
          to={`/merchant/${row.original.slug}`}
          className="py-[4px] px-[10px] border border-clay-border rounded-pill text-rose-muted text-[11px] font-semibold no-underline whitespace-nowrap transition-all hover:bg-oxblood-tint hover:text-oxblood [@media(pointer:coarse)]:min-h-9 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:items-center"
        >{t('Dashboard', '后台')}</Link>
      )
    },
  },
  {
    id: 'actions',
    header: ({ table }) => (
      <div className="text-right whitespace-nowrap">{(table.options.meta as AdminTableMeta).t('Actions', '操作')}</div>
    ),
    cell: ({ row, table }) => {
      const meta = table.options.meta as AdminTableMeta
      const { t, busy } = meta
      const m = row.original
      return (
        <div className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="none"
                  className="size-8 p-0 rounded-full cursor-pointer hover:bg-oxblood-tint hover:text-oxblood"
                  disabled={busy === m.id}
                  aria-label={t('Actions', '操作')}
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {m.status === 'pending' && (
                <>
                  <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onApprove(m.id)}>{t('Approve', '批准')}</DropdownMenuItem>
                  <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onReject(m.id)}>{t('Reject', '拒绝')}</DropdownMenuItem>
                </>
              )}
              {m.status === 'active' && (
                <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onSuspend(m.id)}>{t('Suspend', '暂停')}</DropdownMenuItem>
              )}
              {m.status === 'suspended' && (
                <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onReactivate(m.id)}>{t('Reactivate', '恢复')}</DropdownMenuItem>
              )}
              {!(m.status === 'active' && m.plan === 'pro') && (
                <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onComp(m.id)}>{t('Comp Pro', '赠送 Pro')}</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )
    },
  },
]

export default function AdminMerchants() {
  const { t } = useSession()
  const [rows, setRows] = useState<Merchant[] | null>(null)
  const [billing, setBilling] = useState<Record<string, MerchantBilling>>({})
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    const [ms, bs] = await Promise.all([fetchAllMerchants(), fetchAllBilling()])
    setBilling(Object.fromEntries(bs.map(b => [b.merchant_id, b])))
    setRows(ms)
  }
  useEffect(() => {
    Promise.all([fetchAllMerchants(), fetchAllBilling()]).then(([ms, bs]) => {
      setBilling(Object.fromEntries(bs.map(b => [b.merchant_id, b])))
      setRows(ms)
    })
  }, [])

  async function act(id: string, status: MerchantStatus) {
    setBusy(id)
    try { await setMerchantStatus(id, status); await load() }
    finally { setBusy(null) }
  }

  async function approve(id: string) {
    setBusy(id)
    try { await approveMerchant(id); await load() }
    catch (e) { toast.error(e instanceof Error ? e.message : t('Approval failed', '批准失败')) }
    finally { setBusy(null) }
  }

  async function comp(id: string) {
    setBusy(id)
    try { await compMerchant(id); toast.success(t('Comped to Pro', '已赠送 Pro')); await load() }
    catch (e) { toast.error(e instanceof Error ? e.message : t('Comp failed', '赠送失败')) }
    finally { setBusy(null) }
  }

  const data = useMemo<MerchantRow[]>(
    () => (rows ?? []).map(m => ({ ...m, billingStatus: billing[m.id]?.status ?? null })),
    [rows, billing],
  )

  const meta: AdminTableMeta = {
    t, busy,
    onApprove: approve,
    onReject: (id) => act(id, 'suspended'),
    onSuspend: (id) => act(id, 'suspended'),
    onReactivate: (id) => act(id, 'active'),
    onComp: comp,
  }

  if (!rows) return (
    <p className="text-[13px] text-text-tertiary italic pt-4">{t('Loading…', '加载中…')}</p>
  )

  return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
      <DataTable
        columns={columns}
        data={data}
        meta={meta}
        searchPlaceholder={t('Search shops…', '搜索店铺…')}
        emptyText={t('No merchants yet.', '暂无商家。')}
        prevLabel={t('Previous', '上一页')}
        nextLabel={t('Next', '下一页')}
      />
    </div>
  )
}
