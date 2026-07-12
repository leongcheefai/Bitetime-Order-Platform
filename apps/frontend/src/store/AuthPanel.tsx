import { useState } from 'react'
import { MIN_PASSWORD_LENGTH, isPasswordLongEnough } from '@bitetime/shared'
import { signIn, signUpCustomer } from '../store'
import { useSession } from '../SessionContext'
import { authErrorCode } from '../authError'
import { SignupError, type SignupErrorCode } from '../signupError'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

interface AuthPanelProps {
  heading: string
  subheading?: string
  /** Which form opens first. The checkout gate asks for one by name; the modal starts at sign-in. */
  initialMode?: 'signin' | 'signup'
  onSignedIn?: () => void
  /** Rendered under the form — where a host adds "Continue as guest" or similar. */
  footer?: React.ReactNode
}

/**
 * Customer sign-in and sign-up. One component, several hosts: the storefront's sign-in
 * modal, the checkout interstitial, and the signed-out order-history route — they differ
 * only in framing, which is what `heading`/`subheading`/`footer` carry.
 *
 * Creating an account never leaves the page: the backend mints it pre-confirmed and this
 * panel signs in immediately, in the same tab. The host stays mounted throughout, so a
 * cart being carried through checkout survives both paths by construction.
 *
 * Deliberately does NOT reuse the merchant login screen: that one navigates to the
 * merchant dashboard, and merchant auth drags in the pinyin dictionary used for slug
 * transliteration, which is code-split out of the customer bundle on purpose.
 */
export default function AuthPanel({ heading, subheading, initialMode = 'signin', onSignedIn, footer }: AuthPanelProps) {
  const { t } = useSession()
  const [mode, setMode] = useState<'signin' | 'signup'>(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const signingUp = mode === 'signup'

  // The email carries across the switch — a customer who typed it once never types it twice.
  const switchMode = (next: 'signin' | 'signup') => {
    setMode(next)
    setPassword('')
    setError(null)
    setNotice(null)
  }

  const signInErrorText = (err: unknown) => {
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

  const signUpErrorText = (code: SignupErrorCode) => {
    switch (code) {
      case 'weak_password':
        return t(
          `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`,
          `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`,
        )
      case 'invalid_email':
        return t('That email address does not look right.', '邮箱地址格式不正确。')
      case 'rate_limited':
        return t('Too many attempts. Please try again in a moment.', '尝试次数过多，请稍后再试。')
      case 'network':
        return t('Could not reach the server. Please try again.', '无法连接服务器，请重试。')
      default:
        return t('Could not create your account. Please try again.', '创建账户失败，请重试。')
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (signingUp) {
        // Same rule the endpoint enforces (@bitetime/shared), applied here only to save the
        // customer a round-trip. The backend is the boundary; this is a courtesy.
        if (!isPasswordLongEnough(password)) {
          setError(signUpErrorText('weak_password'))
          return
        }
        await signUpCustomer(email.trim(), password)
      } else {
        await signIn(email.trim(), password)
      }
      // The session is platform-wide: signing in here signs the customer in at every
      // shop. Nothing else changes — the host stays mounted, so the cart survives.
      onSignedIn?.()
    } catch (err) {
      if (err instanceof SignupError && err.code === 'duplicate_email') {
        // Said plainly instead of a generic failure: a returning customer mid-checkout is
        // then one password away from a session, with their email already in the field.
        setMode('signin')
        setPassword('')
        setNotice(t('You already have an account — sign in.', '你已经有账户了——请登录。'))
        return
      }
      if (err instanceof SignupError && err.code === 'signin_failed') {
        // The account was created and only the sign-in after it failed. Say so: the password
        // they just chose is correct, and retrying signup would only meet a duplicate email.
        setMode('signin')
        setNotice(t(
          'Your account is ready — sign in to continue.',
          '账户已创建——请登录以继续。',
        ))
        return
      }
      setError(err instanceof SignupError ? signUpErrorText(err.code) : signInErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="text-left">
      <h2 className="font-heading text-[18px] font-medium text-oxblood mb-1">
        {signingUp ? t('Create an account', '创建账户') : heading}
      </h2>
      {subheading && (
        <p className="text-[13px] text-rose-muted leading-[1.5] mb-5">{subheading}</p>
      )}

      {notice && (
        <div
          role="status"
          className="text-[13px] text-oxblood bg-rose-pale border border-rose-pale rounded-md px-[13px] py-[10px] mb-[10px] leading-[1.5]"
        >
          {notice}
        </div>
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
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
            {signingUp && (
              <p className="text-[12px] text-rose-muted">
                {t(`At least ${MIN_PASSWORD_LENGTH} characters.`, `至少 ${MIN_PASSWORD_LENGTH} 个字符。`)}
              </p>
            )}
          </div>
        </div>
        {/* Base UI's Button defaults to type="button" — explicit submit or the form never fires */}
        <Button type="submit" disabled={busy} className="disabled:opacity-60">
          {signingUp
            ? busy ? t('Creating account…', '创建中…') : t('Create account', '创建账户')
            : busy ? t('Signing in…', '登录中…') : t('Sign in', '登录')}
        </Button>
      </form>

      <p className="text-[13px] text-rose-muted mt-4">
        {signingUp ? (
          <>
            {t('Already have an account?', '已有账户？')}{' '}
            <button
              type="button"
              onClick={() => switchMode('signin')}
              className="text-oxblood underline underline-offset-2"
            >
              {t('Sign in', '登录')}
            </button>
          </>
        ) : (
          <>
            {t('New here?', '第一次来？')}{' '}
            <button
              type="button"
              onClick={() => switchMode('signup')}
              className="text-oxblood underline underline-offset-2"
            >
              {t('Create an account', '创建账户')}
            </button>
          </>
        )}
      </p>

      {footer}
    </div>
  )
}
