import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { signIn } from '../store'
import { useSession } from '../SessionContext'

export default function LoginScreen() {
  const { t, refreshMerchant } = useSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('')
  async function onSubmit(e) {
    e.preventDefault(); setBusy(true); setMsg('')
    try { await signIn(email, password); await refreshMerchant(); navigate('/merchant') }
    catch (err) { setMsg(err.message || t('Login failed','登录失败')); setBusy(false) }
  }
  return (
    <div className="form-wrap" style={{ maxWidth: 420 }}>
      <h2>{t('Merchant login','商家登录')}</h2>
      <form onSubmit={onSubmit}>
        <label>{t('Email','邮箱')}<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label>
        <label>{t('Password','密码')}<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>
        <button disabled={busy}>{busy?t('Logging in…','登录中…'):t('Log in','登录')}</button>
      </form>
      {msg && <p style={{color:'#c00'}}>{msg}</p>}
      <p><Link to="/merchant/signup">{t('New here? Start your shop','新用户？开店')}</Link></p>
    </div>
  )
}
