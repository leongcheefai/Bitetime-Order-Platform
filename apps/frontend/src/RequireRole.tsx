import { useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useSession } from './SessionContext'
import type { Role } from './types'
import { PageSkeleton } from './components/Loaders'
import { Button } from '@/components/ui/button'
import Wordmark from './components/Wordmark'

// Shown instead of the bounce when we could not read the user's shop at all. A merchant whose
// shop we failed to load is still a merchant: sending them to the marketing page states, as
// fact, something we never learned — and hides the outage that caused it.
function ShopUnreachable() {
  const { t, refreshMerchant } = useSession()
  const [busy, setBusy] = useState(false)

  async function retry() {
    setBusy(true)
    await refreshMerchant()
    setBusy(false)
  }

  return (
    <div className="form-wrap text-center pt-8 pb-12">
      <div className="text-center mb-10">
        <h1><Wordmark className="h-8 mx-auto" /></h1>
        <p className="font-heading text-[13px] italic text-rose-muted mt-[5px]">{t('Merchant Portal', '商家入口')}</p>
      </div>
      <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 mb-6 w-full box-border text-left">
        <p className="text-rose-muted text-[14px] leading-[1.6] mt-1.5">
          {t(
            "We couldn't reach the server to load your shop. You are still signed in — this is on our side, not yours.",
            '我们暂时无法连接服务器来加载您的店铺。您仍处于登录状态——这是我们这边的问题。',
          )}
        </p>
      </div>
      <Button variant="default" size="md" onClick={retry} disabled={busy}>
        {busy ? t('Retrying…', '重试中…') : t('Try again', '重试')}
      </Button>
    </div>
  )
}

export default function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { role: current, loading, merchantUnknown } = useSession()
  if (loading) return <PageSkeleton />
  if (current === 'superadmin') return children
  // A lookup that never landed is not an answer. Treating it as one is what turned an
  // unreachable API into "you are not a merchant" and bounced every login to the landing
  // page, silently (#98) — the role here is derived from a shop row we failed to read.
  if (current !== role) return merchantUnknown ? <ShopUnreachable /> : <Navigate to="/" replace />
  return children
}
