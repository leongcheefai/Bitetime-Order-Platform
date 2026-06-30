import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { signUp, signIn, createMerchant, startCheckout } from '../store'
import { toSlugBase } from '../slug'
import { useSession } from '../SessionContext'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

const PLANS = ['basic', 'pro']
const CYCLES = ['monthly', 'yearly']
// Monthly RM price per plan; yearly shown as effective /mo (2 months free = 10×/12).
const PRICE: Record<string, number> = { basic: 9.99, pro: 39.99 }

export default function SignupScreen() {
  const { t, refreshMerchant } = useSession()
  const [params] = useSearchParams()

  const plan = PLANS.includes(params.get('plan') as string) ? (params.get('plan') as string) : 'basic'
  const billing = CYCLES.includes(params.get('billing') as string) ? (params.get('billing') as string) : 'monthly'
  const canceled = params.get('canceled') === '1'

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const [slugPreview, setSlugPreview] = useState('shop-…')
  useEffect(() => {
    let active = true
    toSlugBase(name).then(base => { if (active) setSlugPreview(base || 'shop-…') })
    return () => { active = false }
  }, [name])

  const planName = plan === 'pro' ? 'Pro' : t('Basic', '基础版')
  const cycleName = billing === 'yearly' ? t('Yearly', '按年') : t('Monthly', '按月')
  const perMo = (billing === 'yearly' ? (PRICE[plan] * 10) / 12 : PRICE[plan]).toFixed(2)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true); setMsg('')
    try {
      await signUp(name, email, password)
      try {
        await signIn(email, password)
      } catch {
        setMsg(t('Account created. Check your email to confirm, then log in to finish setting up your shop.',
                 '账号已创建。请查收邮件确认，然后登录以完成店铺设置。'))
        setBusy(false); return
      }
      await createMerchant({ name, plan, billing })
      await refreshMerchant()
      // Hand off to Stripe Checkout; webhook activates the shop on success.
      const url = await startCheckout({ plan, billing })
      window.location.assign(url)
    } catch (err: any) {
      setMsg(err.message || t('Something went wrong.', '出错了。'))
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="brand">
        <h1>BiteTime</h1>
        <p className="tagline">{t('Merchant Portal', '商家入口')}</p>
      </div>
      <Card className="rounded-pill px-8 pt-8 pb-7 gap-0">
        <h2 className="auth-title">{t('Start your shop', '开店')}</h2>
        <p className="auth-subtitle">{t('Create your merchant account to get started.', '创建商家账号以开始使用。')}</p>

        {/* Plan banner: oxblood-tint bg, rose-border, md radius */}
        <div className="flex items-baseline flex-wrap gap-2 px-[13px] py-[10px] mb-[14px] bg-oxblood-tint border border-rose-border rounded-md">
          <span className="font-semibold text-oxblood text-[14px]">{planName} · {cycleName}</span>
          <span className="[font-family:'Lora',serif] text-ink text-[15px]">RM {perMo}{t('/mo', '/月')}</span>
          {plan === 'basic' && (
            <Badge variant="default" className="ml-auto py-[2px] tracking-[0.03em]">
              {t('7-day free trial', '7 天免费试用')}
            </Badge>
          )}
        </div>

        {canceled && (
          <div className="text-[13px] text-ink-soft bg-oxblood-tint border border-rose-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {t('Checkout was canceled. Complete your details to try again.',
               '结账已取消。完善信息后可再次尝试。')}
          </div>
        )}
        {msg && (
          <div className="text-[13px] text-ink-soft bg-oxblood-tint border border-rose-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {msg}
          </div>
        )}
        <form onSubmit={onSubmit}>
          <div className="auth-fields">
            <div className="field">
              <Label htmlFor="signup-1">{t('Shop name', '店铺名称')}</Label>
              <Input id="signup-1" value={name} onChange={e => setName(e.target.value)} required placeholder={t('e.g. Sunny Bakes', '如：阳光烘焙')} />
            </div>
            {/* Store-URL preview: sunken bg, monospace, sm radius */}
            <p className="text-[12px] text-rose-muted px-[10px] py-[5px] bg-surface-sunken rounded-sm font-mono tracking-[0.3px] leading-[1.5]">
              {t('Your store URL', '店铺网址')}: /s/{slugPreview}
            </p>
            <div className="field">
              <Label htmlFor="signup-2">{t('Email', '邮箱')}</Label>
              <Input id="signup-2" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <Label htmlFor="signup-3">{t('Password', '密码')}</Label>
              <Input id="signup-3" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
            </div>
          </div>
          <Button type="submit" variant="default" size="md" className="py-3" disabled={busy}>
            {busy
              ? t('Creating…', '创建中…')
              : plan === 'basic'
                ? t('Start free trial', '开始免费试用')
                : t('Continue to payment', '前往付款')}
          </Button>
        </form>
        <p className="auth-switch">
          <Link to="/merchant/login">{t('Already have a shop? Log in', '已有店铺？登录')}</Link>
        </p>
      </Card>
    </div>
  )
}
