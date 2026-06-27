import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { signUp, signIn, createMerchant } from '../store'
import { toSlugBase } from '../slug'
import { useSession } from '../SessionContext'

export default function SignupScreen() {
  const { t, refreshMerchant } = useSession()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const slugPreview = toSlugBase(name) || 'shop-…'

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
      await createMerchant({ name })
      await refreshMerchant()
      navigate('/merchant')
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
        {msg && <div className="mm-auth-note">{msg}</div>}
        <form onSubmit={onSubmit}>
          <div className="auth-fields">
            <div className="field">
              <label>{t('Shop name', '店铺名称')}</label>
              <input value={name} onChange={e => setName(e.target.value)} required placeholder={t('e.g. Sunny Bakes', '如：阳光烘焙')} />
            </div>
            <p className="mm-slug-preview">{t('Your store URL', '店铺网址')}: /s/{slugPreview}</p>
            <div className="field">
              <label>{t('Email', '邮箱')}</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label>{t('Password', '密码')}</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
            </div>
          </div>
          <button type="submit" className="auth-btn" disabled={busy}>
            {busy ? t('Creating…', '创建中…') : t('Create shop', '创建店铺')}
          </button>
        </form>
        <p className="auth-switch">
          <Link to="/merchant/login">{t('Already have a shop? Log in', '已有店铺？登录')}</Link>
        </p>
      </div>
    </div>
  )
}
