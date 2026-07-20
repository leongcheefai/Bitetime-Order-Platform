import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Eye, EyeOff } from 'lucide-react'
import { signIn, requestPasswordReset } from '../store'
import { authErrorCode } from '../authError'
import { useSession } from '../SessionContext'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import Wordmark from '../components/Wordmark'

export default function LoginScreen() {
  const { t, refreshMerchant } = useSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [forgot, setForgot] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [notice, setNotice] = useState('')

  // Never surface a raw supabase message — a server-side failure (a 500) carries an English DB
  // string, or none, which is how a raw error once rendered as "{}". Map to the handful of
  // outcomes a merchant can act on; everything else is one neutral line.
  function signInErrorText(err: unknown): string {
    switch (authErrorCode(err)) {
      case 'invalid_credentials': return t('Wrong email or password.', '邮箱或密码不正确。')
      case 'email_not_confirmed': return t('Confirm your email address first — check your inbox.', '请先确认您的邮箱——请查看收件箱。')
      case 'rate_limited': return t('Too many attempts. Please try again in a moment.', '尝试次数过多，请稍后再试。')
      default: return t('Could not sign in. Please try again.', '登录失败，请重试。')
    }
  }

  // Merchant login carries no shop slug, so the recovery link lands at the role-blind top-level
  // /reset-password. Deliberate: a merchant is not standing in any storefront.
  function switchMode(next: boolean) {
    setForgot(next)
    setPassword('')
    setShowPassword(false)
    setMsg('')
    setNotice('')
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMsg(''); setNotice('')
    if (forgot) {
      // requestPasswordReset never throws and never reports the outcome — the message is neutral
      // by construction so it cannot become an enumeration oracle. See store.ts.
      await requestPasswordReset(email, null)
      setNotice(t(
        "If that email has an account, we've sent a link.",
        '如果该邮箱已注册，我们已发送重设链接。',
      ))
      setBusy(false)
      return
    }
    try { await signIn(email, password); await refreshMerchant(); navigate('/merchant') }
    catch (err) { setMsg(signInErrorText(err)); setBusy(false) }
  }

  return (
    <div className="w-[420px] max-w-[calc(100vw-2rem)] pt-8">
      <div className="text-center mb-10">
        <h1><Wordmark className="h-8 mx-auto" /></h1>
        <p className="font-heading text-[13px] italic text-rose-muted mt-[5px]">{t('Merchant Portal', '商家入口')}</p>
      </div>
      <Card className="rounded-pill px-8 pt-8 pb-7 gap-0">
        <h2 className="font-heading text-[20px] font-medium text-oxblood mb-1">
          {forgot ? t('Reset your password', '重设密码') : t('Merchant login', '商家登录')}
        </h2>
        <p className="text-[13px] text-rose-muted mb-6">
          {forgot
            ? t("Enter your email and we'll send you a link to set a new password.", '输入你的邮箱，我们会发送重设密码的链接。')
            : t('Sign in to manage your shop.', '登录以管理您的店铺。')}
        </p>
        {notice && (
          <div role="status" className="text-[13px] text-oxblood bg-rose-pale border border-rose-pale rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {notice}
          </div>
        )}
        {msg && (
          <div className="text-[13px] text-ink-soft bg-oxblood-tint border border-rose-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {msg}
          </div>
        )}
        <form onSubmit={onSubmit}>
          <div className="flex flex-col gap-3 mb-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-1">{t('Email', '邮箱')}</Label>
              <Input id="login-1" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            {/* No password field when resetting: the whole point is that they haven't got one. */}
            {!forgot && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor="login-2">{t('Password', '密码')}</Label>
                  <button
                    type="button"
                    onClick={() => switchMode(true)}
                    className="text-[12px] text-rose-muted underline underline-offset-2 cursor-pointer"
                  >
                    {t('Forgot password?', '忘记密码？')}
                  </button>
                </div>
                <div className="relative">
                  <Input
                    id="login-2"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    className="pr-11"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    aria-pressed={showPassword}
                    aria-label={showPassword ? t('Hide password', '隐藏密码') : t('Show password', '显示密码')}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-rose-muted hover:text-oxblood cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-[18px] h-[18px]" /> : <Eye className="w-[18px] h-[18px]" />}
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* Base UI's Button defaults to type="button" — explicit submit or the form never fires */}
          <Button type="submit" variant="default" size="md" className="py-3" disabled={busy}>
            {forgot
              ? busy ? t('Sending…', '发送中…') : t('Send reset link', '发送重设链接')
              : busy ? t('Logging in…', '登录中…') : t('Log in', '登录')}
          </Button>
        </form>
        <p className="text-[13px] text-rose-muted text-center mt-4">
          {forgot ? (
            <button type="button" onClick={() => switchMode(false)} className="text-oxblood cursor-pointer underline">
              {t('Back to sign in', '返回登录')}
            </button>
          ) : (
            <Link to="/merchant/signup" className="text-oxblood cursor-pointer underline">{t('New here? Start your shop', '新用户？开店')}</Link>
          )}
        </p>
      </Card>
    </div>
  )
}
