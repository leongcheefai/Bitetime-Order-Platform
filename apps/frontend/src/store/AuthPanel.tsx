import { useState } from 'react'
import { signIn } from '../store'
import { useSession } from '../SessionContext'
import { authErrorCode } from '../authError'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

interface AuthPanelProps {
  heading: string
  subheading?: string
  onSignedIn?: () => void
  /** Rendered under the form — where a host adds "Continue as guest" or similar. */
  footer?: React.ReactNode
}

/**
 * Customer sign-in. One component, several hosts: the storefront's sign-in modal,
 * the checkout interstitial, and the signed-out order-history route — they differ
 * only in framing, which is what `heading`/`subheading`/`footer` carry.
 *
 * Deliberately does NOT reuse the merchant login screen: that one navigates to the
 * merchant dashboard, and merchant auth drags in the pinyin dictionary used for slug
 * transliteration, which is code-split out of the customer bundle on purpose.
 */
export default function AuthPanel({ heading, subheading, onSignedIn, footer }: AuthPanelProps) {
  const { t } = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const errorText = (err: unknown) => {
    switch (authErrorCode(err)) {
      case 'invalid_credentials':
        return t('Wrong email or password.', '邮箱或密码不正确。')
      case 'email_not_confirmed':
        return t('Confirm your email address first — check your inbox.', '请先确认您的邮箱——请查看收件箱。')
      case 'rate_limited':
        return t('Too many attempts. Please try again in a moment.', '尝试次数过多，请稍后再试。')
      default:
        return t('Could not sign in. Please try again.', '登录失败，请重试。')
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(email.trim(), password)
      // The session is platform-wide: signing in here signs the customer in at every
      // shop. Nothing else changes — the host stays mounted, so the cart survives.
      onSignedIn?.()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="text-left">
      <h2 className="font-heading text-[18px] font-medium text-oxblood mb-1">{heading}</h2>
      {subheading && (
        <p className="text-[13px] text-rose-muted leading-[1.5] mb-5">{subheading}</p>
      )}

      {error && (
        <div
          role="alert"
          className="text-[13px] text-danger bg-rose-pale border border-danger-border rounded-md px-[13px] py-[10px] mb-[10px] leading-[1.5]"
        >
          {error}
        </div>
      )}

      <form onSubmit={onSubmit}>
        <div className="flex flex-col gap-3 mb-5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="auth-email">{t('Email', '邮箱')}</Label>
            <Input
              id="auth-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="auth-password">{t('Password', '密码')}</Label>
            <Input
              id="auth-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>
        </div>
        {/* Base UI's Button defaults to type="button" — explicit submit or the form never fires */}
        <Button type="submit" disabled={busy} className="disabled:opacity-60">
          {busy ? t('Signing in…', '登录中…') : t('Sign in', '登录')}
        </Button>
      </form>

      {footer}
    </div>
  )
}
