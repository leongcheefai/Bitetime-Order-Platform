import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchMerchantVouchers } from '../store'
import { Badge } from '../components/ui/badge'
import type { Voucher } from '../types'

/**
 * The codes a shop handed out while it was on Pro, which stopped redeeming when it stepped down
 * to Basic (`revokeProArtifacts`).
 *
 * This exists because the Pro lock hides the thing it needs to explain. A Basic shop sees the
 * upgrade panel where the voucher list used to be, so a merchant who was told at the confirm
 * dialog that "your vouchers stop working" then has nowhere to find out WHICH — while their
 * customers are still holding the codes and trying them at checkout. Silence here means the
 * merchant learns about it from a complaint.
 *
 * Read-only by design: reactivating is a Pro write and the backend refuses it (`requires_pro`).
 * The point is to name what happened, not to offer a way around the gate.
 *
 * `GET /api/merchants/:id/vouchers` is `requireMerchantOwns` and NOT `requirePro` — the mutations
 * are gated, the owner's own read is not — which is what makes this reachable at all.
 */
export default function DeactivatedVouchers() {
  const { t, merchant } = useSession()
  const [rows, setRows] = useState<Voucher[] | null>(null)
  const merchantId = merchant?.id

  useEffect(() => {
    if (!merchantId) return
    let on = true
    // A failure is silent: this is a footnote to the upgrade panel, and an error card under it
    // would be louder than the thing it annotates.
    fetchMerchantVouchers(merchantId)
      .then(v => { if (on) setRows(v) })
      .catch(() => { if (on) setRows([]) })
    return () => { on = false }
  }, [merchantId])

  const dead = (rows ?? []).filter(v => (v as any).active === false)
  if (!dead.length) return null

  return (
    <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mt-6 w-full box-border max-sm:p-4">
      <h3 className="font-heading text-[15px] font-medium text-oxblood mb-2">
        {t('Codes that no longer work', '已失效的优惠码')}
      </h3>
      <p className="text-[13px] text-text-secondary leading-[1.6] mb-4">
        {t('These stopped being redeemable when this shop moved to Basic. Customers who still have them will be told the code is not valid.',
          '店铺转为基础版后，这些优惠码已无法使用。仍持有的顾客会看到优惠码无效的提示。')}
      </p>
      <div className="flex flex-col gap-2">
        {dead.map(v => (
          <div
            key={(v as any).id ?? v.code}
            className="flex items-center gap-3 px-[14px] py-[10px] bg-cream border-[1.5px] border-clay-border rounded-lg"
          >
            <span className="text-[14px] font-medium text-ink flex-1 min-w-0">{v.code}</span>
            <Badge variant="outline" className="uppercase tracking-[0.08em] shrink-0">
              {t('Inactive', '已停用')}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  )
}
