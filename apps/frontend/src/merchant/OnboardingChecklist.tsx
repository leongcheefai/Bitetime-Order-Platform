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

// The spotlight tour walks the three onboarding steps across their real pages: each
// step navigates to its section and highlights the actual control the merchant uses
// there (the Add-product button, the Shipping card, the storefront-link card). The
// selectors match `data-tour` attributes those controls carry.
interface TourStep { section: string; selector: string }
const TOUR_SECTIONS: TourStep[] = [
  { section: 'products', selector: '[data-tour="add-product"]' },
  { section: 'settings', selector: '[data-tour="set-shipping"]' },
  { section: 'overview', selector: '[data-tour="share-link"]' },
]

// Onboarding checklist + guided tour (#102). Always mounted by the dashboard (so the
// tour survives the section changes it drives); the checklist card itself shows only
// on the Overview section. `onNavigate` switches dashboard section — used both by the
// clickable rows and by the tour as it moves page to page. On a merchant's first visit
// the tour auto-opens once; it can be replayed from the card afterwards.
export default function OnboardingChecklist({ section, onNavigate }: { section: string; onNavigate: (section: string) => void }) {
  const { t, merchant, refreshMerchant } = useSession()
  const [productCount, setProductCount] = useState<number | null>(null)
  const [dismissing, setDismissing] = useState(false)
  // Active tour step (0-based), or null when the tour is closed.
  const [tourStep, setTourStep] = useState<number | null>(null)
  const tourOpenedRef = useRef(false)

  // Navigate to a step's page and show it. Used for open, replay, and Next.
  const goToStep = (i: number) => { setTourStep(i); onNavigate(TOUR_SECTIONS[i].section) }
  const closeTour = () => { setTourStep(null); onNavigate('overview') }

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
      goToStep(0)
      updateMerchantConfig(id, { onboarding_tour_seen: true }).then(refreshMerchant).catch(() => {})
    })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchant?.id])

  const url = merchant ? storefrontUrl(merchant.slug, window.location.origin) : ''

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('Link copied', '链接已复制'))
    } catch {
      toast.error(t('Could not copy — copy it manually', '无法复制 — 请手动复制'))
    }
  }

  const dismiss = async () => {
    if (!merchant) return
    setDismissing(true)
    try {
      await updateMerchantConfig(merchant.id, { onboarding_dismissed: true })
      await refreshMerchant()
    } catch (e: any) {
      toast.error(e.message || t('Could not dismiss — try again', '无法关闭 — 请重试'))
      setDismissing(false)
    }
  }

  // The tour's tooltip copy, per step. Kept beside TOUR_SECTIONS by index.
  const tourCopy = [
    {
      title: t('Add your first product', '添加您的第一个产品'),
      body: t('Tap here to add what you sell — customers order these from your storefront.',
              '点击这里添加您售卖的商品 — 顾客将从您的店面下单。'),
    },
    {
      title: t('Set pickup & delivery', '设置自取与送货'),
      body: t('Choose how customers receive their order and set your rates here.',
              '在这里选择顾客取货的方式并设定运费。'),
    },
    {
      title: t('Share your order link', '分享您的下单链接'),
      body: t('Copy this storefront link and send it to customers — that’s how orders come in.',
              '复制这个店铺链接并发送给顾客 — 订单就是这样进来的。'),
    },
  ]
  const total = TOUR_SECTIONS.length
  const nextTour = () => {
    if (tourStep === null) return
    if (tourStep + 1 >= total) closeTour()
    else goToStep(tourStep + 1)
  }

  const tour = tourStep !== null && (
    <SpotlightTour
      targetSelector={TOUR_SECTIONS[tourStep].selector}
      stepLabel={t(`Step ${tourStep + 1} of ${total}`, `第 ${tourStep + 1} 步，共 ${total} 步`)}
      title={tourCopy[tourStep].title}
      body={tourCopy[tourStep].body}
      ctaLabel={tourStep + 1 >= total ? t('Got it', '知道了') : t('Next', '下一步')}
      skipLabel={t('Skip', '跳过')}
      onNext={nextTour}
      onSkip={closeTour}
    />
  )

  // The card renders only on Overview; the tour (portalled) runs on any section.
  const showCard = section === 'overview' && merchant && !merchant.onboarding_dismissed && productCount !== null
  if (!showCard) return <>{tour}</>

  const state = onboardingSteps(merchant, productCount)

  if (state.allDone) {
    return (
      <>
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
        {tour}
      </>
    )
  }

  const remaining = total - state.doneCount
  const rows = [
    { done: state.product,  label: t('Add your first product', '添加您的第一个产品'), section: 'products' },
    { done: state.shipping, label: t('Set your pickup / delivery', '设置自取 / 送货'),  section: 'settings' },
    { done: state.link,     label: t('Share your order link', '分享您的下单链接'),      section: 'overview' },
  ]

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
          <div className="mt-2 flex items-center justify-between px-3">
            <p className="text-[13px] font-medium text-oxblood">
              {t(`Progress · ${state.doneCount} / 3 Complete`, `进度 · ${state.doneCount} / 3 完成`)}
            </p>
            <button
              type="button"
              onClick={() => goToStep(0)}
              className="flex items-center gap-1 text-[13px] text-rose-muted underline underline-offset-2 hover:text-oxblood"
            >
              <Sparkles size={14} strokeWidth={1.75} /> {t('Show me around', '带我了解一下')}
            </button>
          </div>
        </CardContent>
      </Card>
      {tour}
    </>
  )
}
