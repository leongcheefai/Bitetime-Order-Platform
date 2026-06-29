import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { signIn } from '../store'
import { useSession } from '../SessionContext'

export default function LoginScreen() {
  const { t, refreshMerchant } = useSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function onSubmit(e) {
    e.preventDefault(); setBusy(true); setMsg('')
    try { await signIn(email, password); await refreshMerchant(); navigate('/merchant') }
    catch (err) { setMsg(err.message || t('Login failed', '登录失败')); setBusy(false) }
  }

  return (
    <div className="auth-wrap">
      <div className="brand">
        <h1>BiteTime</h1>
        <p className="tagline">{t('Merchant Portal', '商家入口')}</p>
      </div>
      <div className="auth-card">
        <h2 className="auth-title">{t('Merchant login', '商家登录')}</h2>
        <p className="auth-subtitle">{t('Sign in to manage your shop.', '登录以管理您的店铺。')}</p>
        {msg && <div className="mm-auth-note">{msg}</div>}
        <form onSubmit={onSubmit}>
          <div className="auth-fields">
            <div className="field">
              <label htmlFor="login-1">{t('Email', '邮箱')}</label>
              <input id="login-1" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="login-2">{t('Password', '密码')}</label>
              <input id="login-2" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
          </div>
          <button className="auth-btn" disabled={busy}>
            {busy ? t('Logging in…', '登录中…') : t('Log in', '登录')}
          </button>
        </form>
        <p className="auth-switch">
          <Link to="/merchant/signup">{t('New here? Start your shop', '新用户？开店')}</Link>
        </p>
      </div>
    </div>
  )
}
