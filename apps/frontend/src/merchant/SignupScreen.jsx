import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { signUp, signIn, createMerchant, startCheckout } from '../store'
import { toSlugBase } from '../slug'
import { useSession } from '../SessionContext'

const PLANS = ['basic', 'pro']
const CYCLES = ['monthly', 'yearly']
// Monthly RM price per plan; yearly shown as effective /mo (2 months free = 10×/12).
const PRICE = { basic: 9.99, pro: 39.99 }

export default function SignupScreen() {
  const { t, refreshMerchant } = useSession()
  const [params] = useSearchParams()

  const plan = PLANS.includes(params.get('plan')) ? params.get('plan') : 'basic'
  const billing = CYCLES.includes(params.get('billing')) ? params.get('billing') : 'monthly'
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

  async function onSubmit(e) {
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
    } catch (err) {
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
      <div className="auth-card">
        <h2 className="auth-title">{t('Start your shop', '开店')}</h2>
        <p className="auth-subtitle">{t('Create your merchant account to get started.', '创建商家账号以开始使用。')}</p>

        <div className="mm-signup-plan">
          <span className="mm-signup-plan-label">{planName} · {cycleName}</span>
          <span className="mm-signup-plan-price">RM {perMo}{t('/mo', '/月')}</span>
          {plan === 'basic' && (
            <span className="mm-signup-plan-trial">{t('7-day free trial', '7 天免费试用')}</span>
          )}
        </div>

        {canceled && (
          <div className="mm-auth-note">
            {t('Checkout was canceled. Complete your details to try again.',
               '结账已取消。完善信息后可再次尝试。')}
          </div>
        )}
        {msg && <div className="mm-auth-note">{msg}</div>}
        <form onSubmit={onSubmit}>
          <div className="auth-fields">
            <div className="field">
              <label htmlFor="signup-1">{t('Shop name', '店铺名称')}</label>
              <input id="signup-1" value={name} onChange={e => setName(e.target.value)} required placeholder={t('e.g. Sunny Bakes', '如：阳光烘焙')} />
            </div>
            <p className="mm-slug-preview">{t('Your store URL', '店铺网址')}: /s/{slugPreview}</p>
            <div className="field">
              <label htmlFor="signup-2">{t('Email', '邮箱')}</label>
              <input id="signup-2" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="signup-3">{t('Password', '密码')}</label>
              <input id="signup-3" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
            </div>
          </div>
          <button type="submit" className="auth-btn" disabled={busy}>
            {busy
              ? t('Creating…', '创建中…')
              : plan === 'basic'
                ? t('Start free trial', '开始免费试用')
                : t('Continue to payment', '前往付款')}
          </button>
        </form>
        <p className="auth-switch">
          <Link to="/merchant/login">{t('Already have a shop? Log in', '已有店铺？登录')}</Link>
        </p>
      </div>
    </div>
  )
}
