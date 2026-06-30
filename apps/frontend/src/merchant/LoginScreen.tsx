import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { signIn } from '../store'
import { useSession } from '../SessionContext'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'

export default function LoginScreen() {
  const { t, refreshMerchant } = useSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMsg('')
    try { await signIn(email, password); await refreshMerchant(); navigate('/merchant') }
    catch (err: any) { setMsg(err.message || t('Login failed', '登录失败')); setBusy(false) }
  }

  return (
    <div className="w-[420px] max-w-[calc(100vw-2rem)] pt-8">
      <div className="text-center mb-10">
        <h1 className="font-heading text-[26px] font-medium text-oxblood tracking-[0.3px]">BiteTime</h1>
        <p className="font-heading text-[13px] italic text-rose-muted mt-[5px]">{t('Merchant Portal', '商家入口')}</p>
      </div>
      <Card className="rounded-pill px-8 pt-8 pb-7 gap-0">
        <h2 className="font-heading text-[20px] font-medium text-oxblood mb-1">{t('Merchant login', '商家登录')}</h2>
        <p className="text-[13px] text-rose-muted mb-6">{t('Sign in to manage your shop.', '登录以管理您的店铺。')}</p>
        {msg && (
          <div className="text-[13px] text-ink-soft bg-oxblood-tint border border-rose-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {msg}
          </div>
        )}
        <form onSubmit={onSubmit}>
          <div className="flex flex-col gap-3 mb-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-1">{t('Email', '邮箱')}</Label>
              <Input id="login-1" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-2">{t('Password', '密码')}</Label>
              <Input id="login-2" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
          </div>
          <Button variant="default" size="md" className="py-3" disabled={busy}>
            {busy ? t('Logging in…', '登录中…') : t('Log in', '登录')}
          </Button>
        </form>
        <p className="text-[13px] text-rose-muted text-center mt-4">
          <Link to="/merchant/signup" className="text-oxblood cursor-pointer underline">{t('New here? Start your shop', '新用户？开店')}</Link>
        </p>
      </Card>
    </div>
  )
}
