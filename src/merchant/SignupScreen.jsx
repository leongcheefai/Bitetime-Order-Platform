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
      navigate('/merchant/pending')
    } catch (err) {
      setMsg(err.message || t('Something went wrong.', '出错了。'))
      setBusy(false)
    }
  }

  return (
    <div className="form-wrap" style={{ maxWidth: 420 }}>
      <h2>{t('Start your shop', '开店')}</h2>
      <form onSubmit={onSubmit}>
        <label>{t('Shop name', '店铺名称')}
          <input value={name} onChange={e => setName(e.target.value)} required />
        </label>
        <p style={{ fontSize: 13, color: '#888' }}>{t('Your store URL', '店铺网址')}: /s/{slugPreview}</p>
        <label>{t('Email', '邮箱')}
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
        </label>
        <label>{t('Password', '密码')}
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
        </label>
        <button type="submit" disabled={busy}>{busy ? t('Creating…','创建中…') : t('Create shop','创建店铺')}</button>
      </form>
      {msg && <p style={{ color: '#c00' }}>{msg}</p>}
      <p><Link to="/merchant/login">{t('Already have a shop? Log in','已有店铺？登录')}</Link></p>
    </div>
  )
}
