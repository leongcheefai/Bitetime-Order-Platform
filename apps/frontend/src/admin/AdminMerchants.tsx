import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchAllMerchants, setMerchantStatus, approveMerchant, compMerchant, fetchAllBilling, type MerchantBilling } from '../store'
import { useSession } from '../SessionContext'
import { toast } from 'sonner'
import type { Merchant, MerchantStatus } from '../types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'

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

  if (!rows) return (
    <p className="text-[13px] text-text-tertiary italic pt-4">{t('Loading…', '加载中…')}</p>
  )

  return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-8 w-full box-border">
      {rows.length === 0 ? (
        <p className="text-[13px] text-text-tertiary italic">{t('No merchants yet.', '暂无商家。')}</p>
      ) : (
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="py-2 px-3">{t('Shop', '店铺')}</TableHead>
              <TableHead className="py-2 px-3">{t('Slug', '网址')}</TableHead>
              <TableHead className="py-2 px-3">{t('Status', '状态')}</TableHead>
              <TableHead className="py-2 px-3">{t('Subscription', '订阅')}</TableHead>
              <TableHead className="py-2 px-3">{t('Open', '打开')}</TableHead>
              <TableHead className="py-2 px-3 text-right whitespace-nowrap">{t('Actions', '操作')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m: Merchant) => (
              <TableRow key={m.id}>
                <TableCell className="p-3 font-medium">{m.name}</TableCell>
                <TableCell className="p-3">
                  <a
                    href={`/s/${m.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-oxblood no-underline font-medium hover:underline"
                  >/s/{m.slug}</a>
                </TableCell>
                <TableCell className="p-3">
                  {/* className overrides match .mm-badge--{status} exactly (px-[10px], no border;
                      active uses success-bg-soft/deep, not the success variant's success-bg/fg) */}
                  <Badge className={
                    'px-[10px] border-transparent ' + (
                      m.status === 'active' ? 'bg-success-bg-soft text-success-deep' :
                      m.status === 'pending' ? 'bg-warn-bg text-warn-fg' :
                      'bg-danger-bg text-danger-fg'
                    )
                  }>{m.status}</Badge>
                </TableCell>
                <TableCell className="p-3">
                  {(() => {
                    const b = billing[m.id]
                    const plan = m.plan === 'pro' ? t('Pro', 'Pro')
                      : m.plan === 'basic' ? t('Basic', '基础版') : null
                    const sub = b?.status
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
                  })()}
                </TableCell>
                <TableCell className="p-3">
                  <span className="inline-flex gap-[6px] flex-wrap">
                    <Link
                      to={`/merchant/${m.slug}`}
                      className="py-[4px] px-[10px] border border-clay-border rounded-pill text-rose-muted text-[11px] font-semibold no-underline whitespace-nowrap transition-all hover:bg-oxblood-tint hover:text-oxblood [@media(pointer:coarse)]:min-h-9 [@media(pointer:coarse)]:inline-flex [@media(pointer:coarse)]:items-center"
                    >{t('Dashboard', '后台')}</Link>
                  </span>
                </TableCell>
                <TableCell className="p-3 text-right whitespace-nowrap">
                  <span className="inline-flex gap-1 flex-wrap justify-end items-center">
                  {m.status === 'pending' && (
                    <span className="inline-flex gap-1">
                      <Button
                        size="none"
                        className="py-[4px] px-3 rounded-pill border-[1.5px] border-oxblood bg-oxblood text-cream text-[12px] whitespace-nowrap transition-all hover:bg-oxblood-deep hover:border-oxblood-deep"
                        disabled={busy === m.id}
                        onClick={() => approve(m.id)}
                      >{t('Approve', '批准')}</Button>
                      <Button
                        size="none"
                        variant="outline"
                        className="py-[4px] px-3 rounded-pill text-[12px] whitespace-nowrap bg-surface-raised hover:bg-oxblood-tint hover:text-oxblood hover:border-oxblood"
                        disabled={busy === m.id}
                        onClick={() => act(m.id, 'suspended')}
                      >{t('Reject', '拒绝')}</Button>
                    </span>
                  )}
                  {m.status === 'active' && (
                    <Button
                      size="none"
                      variant="outline"
                      className="py-[4px] px-3 rounded-pill text-[12px] whitespace-nowrap bg-surface-raised hover:bg-oxblood-tint hover:text-oxblood hover:border-oxblood"
                      disabled={busy === m.id}
                      onClick={() => act(m.id, 'suspended')}
                    >{t('Suspend', '暂停')}</Button>
                  )}
                  {m.status === 'suspended' && (
                    <Button
                      size="none"
                      className="py-[4px] px-3 rounded-pill border-[1.5px] border-oxblood bg-oxblood text-cream text-[12px] whitespace-nowrap transition-all hover:bg-oxblood-deep hover:border-oxblood-deep"
                      disabled={busy === m.id}
                      onClick={() => act(m.id, 'active')}
                    >{t('Reactivate', '恢复')}</Button>
                  )}
                  {!(m.status === 'active' && m.plan === 'pro') && (
                    <Button
                      size="none"
                      variant="outline"
                      className="py-[4px] px-3 rounded-pill text-[12px] whitespace-nowrap bg-surface-raised hover:bg-oxblood-tint hover:text-oxblood hover:border-oxblood"
                      disabled={busy === m.id}
                      onClick={() => comp(m.id)}
                    >{t('Comp Pro', '赠送 Pro')}</Button>
                  )}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
