import { useEffect, useRef, useState } from 'react'
import { Circle, CheckCircle2, ChevronRight, Copy, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { fetchProducts, updateMerchantConfig } from '../store'
import { storefrontUrl } from '../storefrontUrl'
import { onboardingSteps } from './onboardingSteps'
import SpotlightTour from './SpotlightTour'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

const ICON = { size: 20, strokeWidth: 1.75 }

// Onboarding checklist (#102). Renders at the top of the Overview section while a
// shop is still finding its feet, and never after the merchant dismisses the
// finished-state celebration. `onNavigate` jumps to the section that completes a
// step — the "hand to hand" guidance from the issue. On a merchant's first visit a
// one-time spotlight tour auto-opens and walks the three steps; it can be replayed
// from the card afterwards.
export default function OnboardingChecklist({ onNavigate }: { onNavigate: (section: string) => void }) {
  const { t, merchant, refreshMerchant } = useSession()
  const [productCount, setProductCount] = useState<number | null>(null)
  const [dismissing, setDismissing] = useState(false)
  // Active tour step (0-based), or null when the tour is closed.
  const [tourStep, setTourStep] = useState<number | null>(null)
  const tourOpenedRef = useRef(false)

  useEffect(() => {
    const id = merchant?.id
    if (!id || !merchant) return
    let active = true
    fetchProducts(id).then(ps => {
      if (!active) return
      setProductCount(ps.length)
      // Auto-open the tour once, on the first visit of a shop that hasn't seen it and
      // still has work to do. Decided here in the async callback (not a synchronous
      // effect body) so it fires exactly once when the data first lands. Marked seen
      // the moment it opens — closing the tab mid-tour won't re-trigger it — while the
      // card's own dismissal (`onboarding_dismissed`) stays separate.
      if (tourOpenedRef.current) return
      if (merchant.onboarding_dismissed || merchant.onboarding_tour_seen) return
      if (onboardingSteps(merchant, ps.length).allDone) return
      tourOpenedRef.current = true
      setTourStep(0)
      updateMerchantConfig(id, { onboarding_tour_seen: true }).then(refreshMerchant).catch(() => {})
    })
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
          <CardTitle>{t('🎉 Your shop is ready!', '🎉 您的店铺已就绪！')}</CardTitle>
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
    {
      done: state.product, section: 'products',
      label: t('Add your first product', '添加您的第一个产品'),
      tourTitle: t('Add your first product', '添加您的第一个产品'),
      tourBody: t('Click here to open Products and add what you sell. Customers order from this menu.',
                  '点击这里打开“产品”，添加您售卖的商品。顾客将从这份菜单下单。'),
    },
    {
      done: state.shipping, section: 'settings',
      label: t('Set your pickup / delivery', '设置自取 / 送货'),
      tourTitle: t('Set pickup & delivery', '设置自取与送货'),
      tourBody: t('Open Settings to choose how customers receive their order and set your rates.',
                  '打开“设置”，选择顾客取货的方式并设定运费。'),
    },
    {
      done: state.link, section: 'overview',
      label: t('Share your order link', '分享您的下单链接'),
      tourTitle: t('Share your order link', '分享您的下单链接'),
      tourBody: t('Copy your storefront link just below and send it to customers — that’s how orders come in.',
                  '复制下方的店铺链接并发送给顾客 — 订单就是这样进来的。'),
    },
  ]

  const total = rows.length
  const nextTour = () => setTourStep(s => (s === null ? null : s + 1 >= total ? null : s + 1))

  return (
    <>
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
          {rows.map((r, i) => (
            <button
              key={r.section + r.label}
              type="button"
              data-tour={`onboard-${i}`}
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
          <div className="mt-2 flex items-center justify-between px-3">
            <p className="text-[13px] font-medium text-oxblood">
              {t(`Progress · ${state.doneCount} / 3 Complete`, `进度 · ${state.doneCount} / 3 完成`)}
            </p>
            <button
              type="button"
              onClick={() => setTourStep(0)}
              className="flex items-center gap-1 text-[13px] text-rose-muted underline underline-offset-2 hover:text-oxblood"
            >
              <Sparkles size={14} strokeWidth={1.75} /> {t('Show me around', '带我了解一下')}
            </button>
          </div>
        </CardContent>
      </Card>

      {tourStep !== null && (
        <SpotlightTour
          targetSelector={`[data-tour="onboard-${tourStep}"]`}
          stepLabel={t(`Step ${tourStep + 1} of ${total}`, `第 ${tourStep + 1} 步，共 ${total} 步`)}
          title={rows[tourStep].tourTitle}
          body={rows[tourStep].tourBody}
          ctaLabel={tourStep + 1 >= total ? t('Got it', '知道了') : t('Next', '下一步')}
          skipLabel={t('Skip', '跳过')}
          onNext={nextTour}
          onSkip={() => setTourStep(null)}
        />
      )}
    </>
  )
}
