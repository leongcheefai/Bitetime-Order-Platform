import { useEffect, useState } from 'react'
import { Circle, CheckCircle2, PartyPopper, ChevronRight, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { fetchProducts, updateMerchantConfig } from '../store'
import { storefrontUrl } from '../storefrontUrl'
import { onboardingSteps } from './onboardingSteps'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

const ICON = { size: 20, strokeWidth: 1.75 }

// Onboarding checklist (#102). Renders at the top of the Overview section while a
// shop is still finding its feet, and never after the merchant dismisses the
// finished-state celebration. `onNavigate` jumps to the section that completes a
// step — the "hand to hand" guidance from the issue.
export default function OnboardingChecklist({ onNavigate }: { onNavigate: (section: string) => void }) {
  const { t, merchant, refreshMerchant } = useSession()
  const [productCount, setProductCount] = useState<number | null>(null)
  const [dismissing, setDismissing] = useState(false)

  useEffect(() => {
    const id = merchant?.id
    if (!id) return
    let active = true
    fetchProducts(id).then(ps => { if (active) setProductCount(ps.length) })
    return () => { active = false }
  }, [merchant?.id])

  // Hidden entirely once dismissed. Also wait for the product count before deciding
  // done-ness, so the card never flashes a wrong 0/3 for a shop with products.
  if (!merchant || merchant.onboarding_dismissed) return null
  if (productCount === null) return null

  const state = onboardingSteps(merchant, productCount)
  const url = storefrontUrl(merchant.slug, window.location.origin)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('Link copied', '链接已复制'))
    } catch {
      toast.error(t('Could not copy — copy it manually', '无法复制 — 请手动复制'))
    }
  }

  const dismiss = async () => {
    setDismissing(true)
    try {
      await updateMerchantConfig(merchant.id, { onboarding_dismissed: true })
      await refreshMerchant()
    } catch (e: any) {
      toast.error(e.message || t('Could not dismiss — try again', '无法关闭 — 请重试'))
      setDismissing(false)
    }
  }

  if (state.allDone) {
    return (
      <Card className="mb-5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PartyPopper {...ICON} /> {t('Your shop is ready!', '您的店铺已就绪！')}
          </CardTitle>
          <CardDescription>
            {t('Copy your order link and start accepting orders.', '复制您的下单链接，开始接单。')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button size="sm" className="w-auto" onClick={copy}>
            <Copy /> {t('Copy order link', '复制下单链接')}
          </Button>
          <Button variant="outline" size="sm" className="w-auto" onClick={dismiss} disabled={dismissing}>
            {dismissing ? t('Dismissing…', '关闭中…') : t('Got it', '知道了')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  const remaining = 3 - state.doneCount
  const rows = [
    { done: state.product,  label: t('Add your first product', '添加您的第一个产品'), section: 'products' },
    { done: state.shipping, label: t('Set your pickup / delivery', '设置自取 / 送货'),  section: 'settings' },
    { done: state.link,     label: t('Share your order link', '分享您的下单链接'),      section: 'overview' },
  ]

  return (
    <Card className="mb-5">
      <CardHeader>
        <CardTitle>{t('🎉 Welcome to TinyOrder', '🎉 欢迎使用 TinyOrder')}</CardTitle>
        <CardDescription>
          {t(
            `You’re only ${remaining} step${remaining === 1 ? '' : 's'} away from accepting your first order.`,
            `距离接收第一笔订单只差 ${remaining} 步。`,
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {rows.map(r => (
          <button
            key={r.section + r.label}
            type="button"
            onClick={() => onNavigate(r.section)}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-ink transition-colors hover:bg-surface-sunken"
          >
            {r.done
              ? <CheckCircle2 {...ICON} className="shrink-0 text-oxblood" />
              : <Circle {...ICON} className="shrink-0 text-rose-muted" />}
            <span className={r.done ? 'text-rose-muted line-through' : ''}>{r.label}</span>
            {!r.done && <ChevronRight size={16} strokeWidth={1.75} className="ml-auto shrink-0 text-rose-muted" />}
          </button>
        ))}
        <p className="mt-2 px-3 text-[13px] font-medium text-oxblood">
          {t(`Progress · ${state.doneCount} / 3 Complete`, `进度 · ${state.doneCount} / 3 完成`)}
        </p>
      </CardContent>
    </Card>
  )
}
