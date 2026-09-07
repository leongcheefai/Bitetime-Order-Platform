import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { MoreHorizontal } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import { fetchAllMerchants, setMerchantStatus, approveMerchant, compMerchant, uncompMerchant, setMerchantSample, recaptureSampleShops, fetchAllBilling, type MerchantBilling } from '../store'
import { unwrap } from '../api'
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
type MerchantRow = Merchant & { billingStatus?: string | null; comped?: boolean }

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
  onUncomp: (id: string) => void
  onToggleSample: (id: string, isSample: boolean) => void
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
        className="text-primary no-underline font-medium hover:underline"
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
            s === 'active' ? 'bg-success-100 text-success-fg' :
            s === 'pending' ? 'bg-warning-100 text-warning-fg' :
            'bg-danger-100 text-danger-fg'
          )
        }>{s}</Badge>
      )
    },
  },
  {
    id: 'subscription',
    accessorFn: (r) => r.billingStatus ?? '',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as AdminTableMeta).t('Subscription', '订阅')} />
    ),
    cell: ({ row, table }) => {
      const { t } = table.options.meta as AdminTableMeta
      const m = row.original
      const sub = m.billingStatus
      if (!sub) return <span className="text-muted-foreground">—</span>
      const subLabel = m.comped ? t('comped', '赠送')
        : sub === 'active' ? t('active', '有效')
        : sub === 'trialing' ? t('trialing', '试用')
        : sub === 'past_due' ? t('past due', '逾期')
        : sub === 'canceled' ? t('canceled', '已取消')
        : sub === 'incomplete' ? t('incomplete', '未完成')
        : sub
      // Neutral, not green: a comp is neither a healthy subscription nor a failing one, and
      // colouring it `active` is what made comped and paying shops indistinguishable here.
      const subCls = m.comped ? 'text-muted-foreground'
        : sub === 'active' ? 'text-success-fg'
        : sub === 'trialing' ? 'text-warning-fg'
        : (sub === 'past_due' || sub === 'canceled' || sub === 'incomplete') ? 'text-danger-fg'
        : 'text-muted-foreground'
      return (
        <span className="inline-flex items-center gap-[6px] whitespace-nowrap">
          <span className={'text-[12px] ' + subCls}>{subLabel}</span>
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
          className="py-[4px] px-[10px] border border-border rounded-pill text-muted-foreground text-[11px] font-semibold no-underline whitespace-nowrap transition-all hover:bg-brand-wash hover:text-primary [@media(pointer:coarse)]:min-h-9 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:items-center"
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
                  className="size-9 p-0 rounded-pill cursor-pointer pointer-coarse:size-11 hover:bg-brand-wash hover:text-primary"
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
                  {/* Not an approval any more — signup provisions its own trial. This is the
                      fallback for a shop whose provisioning failed and whose owner never retried. */}
                  <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onApprove(m.id)}>{t('Start trial', '开始试用')}</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" className="cursor-pointer" onClick={() => meta.onReject(m.id)}>{t('Reject', '拒绝')}</DropdownMenuItem>
                </>
              )}
              {m.status === 'active' && (
                <DropdownMenuItem variant="destructive" className="cursor-pointer" onClick={() => meta.onSuspend(m.id)}>{t('Suspend', '暂停')}</DropdownMenuItem>
              )}
              {m.status === 'suspended' && (
                <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onReactivate(m.id)}>{t('Reactivate', '恢复')}</DropdownMenuItem>
              )}
              {m.comped ? (
                <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onUncomp(m.id)}>
                  {t('Un-comp', '取消赠送')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onComp(m.id)}>
                  {t('Comp this shop', '赠送此店铺')}
                </DropdownMenuItem>
              )}
              {m.is_sample ? (
                <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onToggleSample(m.id, false)}>
                  {t('Remove from samples', '取消示例店铺')}
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onToggleSample(m.id, true)}>
                    {t('Mark as sample shop', '设为示例店铺')}
                  </DropdownMenuItem>
                  {/* The carousel links each sample shop into its live storefront, so this flag is
                      the ONLY thing standing between a shop and public strangers ordering from it.
                      Say that here, where the flag is set.
                      A plain div, not DropdownMenuLabel: that one is Base UI's Menu.GroupLabel and
                      throws "MenuGroupContext is missing" outside a Menu.Group. */}
                  <div className="max-w-[220px] px-2 pb-1.5 text-[12px] leading-[1.5] text-muted-foreground">
                    {t(
                      'Puts the shop on /sample-shops as a link to its live storefront. Visitors can place real orders on it.',
                      '店铺会出现在 /sample-shops，并链接到营业中的店面。访客可以在上面真实下单。',
                    )}
                  </div>
                </>
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
  const [recapturing, setRecapturing] = useState(false)

  // The admin list is a throw-preferring caller (no per-row error UI), so unwrap() surfaces a
  // could-not-ask as a throw — symmetric with fetchAllBilling, which still throws.
  // The admin list is a throw-preferring caller (no per-row error UI), so unwrap() surfaces a
  // could-not-ask as a throw for both the merchants and the billing reads.
  async function load() {
    const [ms, bs] = await Promise.all([fetchAllMerchants(), fetchAllBilling()])
    setBilling(Object.fromEntries(unwrap(bs).map(b => [b.merchant_id, b])))
    setRows(unwrap(ms))
  }
  useEffect(() => {
    Promise.all([fetchAllMerchants(), fetchAllBilling()]).then(([ms, bs]) => {
      setBilling(Object.fromEntries(unwrap(bs).map(b => [b.merchant_id, b])))
      setRows(unwrap(ms))
    })
  }, [])

  async function act(id: string, status: MerchantStatus) {
    setBusy(id)
    const r = await setMerchantStatus(id, status)
    if (r.ok) await load()
    else toast.error(r.error.message || t('Could not update status', '无法更新状态'))
    setBusy(null)
  }

  async function approve(id: string) {
    setBusy(id)
    const r = await approveMerchant(id)
    if (r.ok) await load()
    else toast.error(r.error.message || t('Could not start the trial', '无法开始试用'))
    setBusy(null)
  }

  async function comp(id: string) {
    setBusy(id)
    const r = await compMerchant(id)
    if (r.ok) { toast.success(t('Comped to Pro', '已赠送 Pro')); await load() }
    // The one refusal a superadmin can act on: cancel the subscription in Stripe, then comp.
    // Without this the toast reads `has_live_subscription`, which names the state but not the way out.
    else if (r.error.code === 'has_live_subscription') {
      toast.error(t('This shop has a live subscription. Cancel it in Stripe first.',
        '此店铺有生效中的订阅，请先在 Stripe 中取消。'))
    }
    else toast.error(r.error.message || t('Comp failed', '赠送失败'))
    setBusy(null)
  }

  async function uncomp(id: string) {
    setBusy(id)
    const r = await uncompMerchant(id)
    if (r.ok) { toast.success(t('Comp revoked', '已取消赠送')); await load() }
    else toast.error(r.error.message || t('Un-comp failed', '取消赠送失败'))
    setBusy(null)
  }

  async function toggleSample(id: string, isSample: boolean) {
    setBusy(id)
    const r = await setMerchantSample(id, isSample)
    if (r.ok) {
      // The carousel shows only shops that have a storefront screenshot, and the shop has none
      // until GitHub Actions captures one. Say which of the two happened: a queued capture puts
      // the shop on /sample-shops in a few minutes, a refused one leaves it off until Monday.
      if (isSample) {
        toast.success(
          r.data?.captureQueued
            ? t('Marked as sample shop — screenshot in a few minutes', '已设为示例店铺 — 截图将在几分钟后生成')
            : t('Marked as sample shop — screenshot at the next weekly capture', '已设为示例店铺 — 截图将在下次每周抓取时生成'),
        )
      } else {
        toast.success(t('Removed from samples', '已取消示例店铺'))
      }
      await load()
    } else {
      toast.error(r.error.message || t('Could not update', '无法更新'))
    }
    setBusy(null)
  }

  const data = useMemo<MerchantRow[]>(
    () => (rows ?? []).map(m => ({
      ...m,
      billingStatus: billing[m.id]?.status ?? null,
      comped: !!billing[m.id]?.comped,
    })),
    [rows, billing],
  )

  const meta: AdminTableMeta = {
    t, busy,
    onApprove: approve,
    onReject: (id) => act(id, 'suspended'),
    onSuspend: (id) => act(id, 'suspended'),
    onReactivate: (id) => act(id, 'active'),
    onComp: comp,
    onUncomp: uncomp,
    onToggleSample: toggleSample,
  }

  // The carousel on /sample-shops shows a photograph of each shop's storefront, taken by a
  // GitHub Actions sweep. A production deploy re-shoots them all on its own; this is the manual
  // path, for a shot that came out wrong or a design change that shipped without a deploy.
  async function recapture() {
    setRecapturing(true)
    const r = await recaptureSampleShops()
    if (r.ok && r.data?.captureQueued) {
      toast.success(t('Recapturing every sample shop — a few minutes', '正在重新抓取所有示例店铺 — 需要几分钟'))
    } else if (r.ok) {
      toast.error(t('GitHub refused the request. The weekly capture still runs.',
        'GitHub 拒绝了该请求。每周抓取仍会运行。'))
    } else {
      toast.error(r.error.message || t('Could not ask for a recapture', '无法请求重新抓取'))
    }
    setRecapturing(false)
  }

  if (!rows) return (
    <p className="text-[13px] text-muted-foreground italic pt-4">{t('Loading…', '加载中…')}</p>
  )

  return (
    <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border">
      <div className="flex justify-end pb-3">
        <button
          type="button"
          onClick={recapture}
          disabled={recapturing}
          className="py-[6px] px-[12px] border border-border rounded-pill bg-transparent text-muted-foreground text-[11px] font-semibold whitespace-nowrap cursor-pointer transition-all hover:bg-brand-wash hover:text-primary disabled:opacity-50 disabled:cursor-default"
        >
          {recapturing
            ? t('Asking…', '请求中…')
            : t('Recapture sample screenshots', '重新抓取示例店铺截图')}
        </button>
      </div>
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
