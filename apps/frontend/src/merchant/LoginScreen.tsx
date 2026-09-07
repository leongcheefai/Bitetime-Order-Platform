import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { signIn, requestPasswordReset, SIGNED_OUT_ELSEWHERE_KEY } from '../store'
import { authErrorCode } from '../authError'
import { trackEvent } from '../analytics/events'
import { useSession } from '../SessionContext'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '../components/PasswordInput'
import Wordmark from '../components/Wordmark'

export default function LoginScreen() {
  const { t, refreshMerchant } = useSession()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [forgot, setForgot] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [notice, setNotice] = useState('')

  // Set by onAuthChange when a SIGNED_OUT arrives that the tab did not ask for — the session row
  // is gone. Either another device took the last slot, or the merchant signed this one out from
  // another device. Both are the same news to the person reading it.
  //
  // Read as INITIAL STATE rather than in an effect: an effect that calls setState synchronously
  // is a cascading render, and this value is known before the first paint. A boolean and not the
  // sentence, so the sentence still follows a language switch.
  const [signedOutElsewhere] = useState(() => {
    try { return sessionStorage.getItem(SIGNED_OUT_ELSEWHERE_KEY) === 'yes' } catch { return false }
  })

  // Where GET /api/merchant/verify-email lands a merchant who clicked the address-check link.
  // This screen, rather than the dashboard, because the link is routinely opened on a phone that
  // never signed in — and RedirectSignedInMerchant sends an already-signed-in one straight past
  // this to their dashboard, where the banner being gone is the same news.
  const [params] = useSearchParams()
  const verified = params.get('email_verified')
  const verifyNotice = verified === '1'
    ? t('Email confirmed. Sign in to carry on.', '邮箱已确认。请登录以继续。')
    : verified === '0'
      // Deliberately vague about WHICH, because the merchant can act on all of them the same way,
      // and the three cases (expired, tampered, address since changed) are not worth three
      // sentences on a login screen.
      ? t('That link did not work — it may have expired. Sign in and ask for a new one.',
          '该链接无效，可能已过期。请登录后重新获取。')
      : ''

  // Cleared separately, so a later visit to this screen does not repeat old news. Clearing is an
  // external write and not state, which is exactly what an effect is for.
  useEffect(() => {
    try { sessionStorage.removeItem(SIGNED_OUT_ELSEWHERE_KEY) } catch { /* private mode */ }
  }, [])

  // Quotes NO figure. This screen is unauthenticated, so it cannot ask the server how many devices
  // an account allows, and a "2" typed in here would go on saying 2 the day that number changes.
  // The sentence is true without it; Settings → Devices quotes the real ceiling.
  const deviceNotice = signedOutElsewhere
    ? t(
      'You were signed out because your account was signed in on another device. Signing in on a new device signs out the one used longest ago.',
      '您已被登出，因为您的账号在另一台设备上登录了。在新设备登录后，最久未使用的设备会被登出。',
    )
    : ''

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
    // The reveal toggle needs no reset: the field is unmounted while `forgot` is true,
    // so coming back mounts a fresh PasswordInput with the password masked again.
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
    // `replace`, not a push: a used login screen is not a place to go back to. Pushed, Back put
    // an already-signed-in merchant in front of the login form again.
    try {
      await signIn(email, password)
      // After the sign-in resolves, so a failed attempt reports nothing.
      trackEvent('merchant_login')
      await refreshMerchant()
      navigate('/merchant', { replace: true })
    }
    catch (err) { setMsg(signInErrorText(err)); setBusy(false) }
  }

  return (
    <div role="main" className="w-[420px] max-w-full pt-8">
      <div className="text-center mb-10">
        <h1><Wordmark className="h-8 mx-auto" /></h1>
        <p className="font-heading text-[13px] italic text-muted-foreground mt-[5px]">{t('Merchant Portal', '商家入口')}</p>
      </div>
      <Card className="px-8 pt-8 pb-7 gap-0">
        <h2 className="font-heading text-[20px] font-medium text-primary mb-1">
          {forgot ? t('Reset your password', '重设密码') : t('Merchant login', '商家登录')}
        </h2>
        <p className="text-[13px] text-muted-foreground mb-6">
          {forgot
            ? t("Enter your email and we'll send you a link to set a new password.", '输入你的邮箱，我们会发送重设密码的链接。')
            : t('Sign in to manage your shop.', '登录以管理您的店铺。')}
        </p>
        {/* Rendered separately, not `notice || deviceNotice`: they answer different questions, and
            `||` meant a merchant who asked for a reset link stopped being told why they were
            signed out. This one explains the arrival, so it sits first. */}
        {verifyNotice && (
          <div role="status" className="text-[13px] text-primary bg-brand-wash border border-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {verifyNotice}
          </div>
        )}
        {deviceNotice && (
          <div role="status" className="text-[13px] text-primary bg-danger-100 border border-danger-100 rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {deviceNotice}
          </div>
        )}
        {notice && (
          <div role="status" className="text-[13px] text-primary bg-danger-100 border border-danger-100 rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {notice}
          </div>
        )}
        {msg && (
          <div className="text-[13px] text-foreground-secondary bg-brand-wash border border-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
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
                  <Button
                    type="button"
                    variant="link"
                    size="none"
                    onClick={() => switchMode(true)}
                    className="text-[12px] text-muted-foreground"
                  >
                    {t('Forgot password?', '忘记密码？')}
                  </Button>
                </div>
                <PasswordInput
                  id="login-2"
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                />
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
        <p className="text-[13px] text-muted-foreground text-center mt-4">
          {forgot ? (
            <Button type="button" variant="link" size="none" onClick={() => switchMode(false)}>
              {t('Back to sign in', '返回登录')}
            </Button>
          ) : (
            <Link to="/merchant/signup" className="text-primary cursor-pointer underline">{t('New here? Start your shop', '新用户？开店')}</Link>
          )}
        </p>
      </Card>
    </div>
  )
}
