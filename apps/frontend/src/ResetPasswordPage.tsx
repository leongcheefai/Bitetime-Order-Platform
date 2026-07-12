import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MIN_PASSWORD_LENGTH, isPasswordLongEnough } from '@bitetime/shared'
import { useSession } from './SessionContext'
import { updatePassword } from './store'
import { authErrorCode } from './authError'
import { resetDestination } from './resetPassword'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Label } from './components/ui/label'
import { Spinner } from './components/Loaders'

/**
 * Where a recovery link lands. A TOP-LEVEL route, deliberately outside the storefront shell: nested
 * under `/s/:slug` the shell's merchant-status gate would swallow this page, and a shop being
 * suspended must never lock a customer out of their own account.
 *
 * Role-blind. The `shop` param decides where they go once they're done — back to the storefront
 * they were ordering from, or the merchant dashboard if there is none. Merchants have no reset path
 * today either, so their entry point later is a link and no new infrastructure.
 *
 * The cart does not survive, and cannot: the customer left the tab for their inbox, and the
 * storefront holds the order in ephemeral state. They come back signed in, with an empty cart.
 */
export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { t, account, loading } = useSession()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const shop = params.get('shop')
  const destination = resetDestination(shop)

  // The recovery link carries the session in the URL fragment; supabase-js consumes it and fires
  // an auth change. `account` arriving IS the token being accepted — there is nothing to verify
  // separately, and nothing to store.
  const ready = !loading && !!account

  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => navigate(destination), 1200)
    return () => clearTimeout(timer)
  }, [done, destination, navigate])

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // The same floor the signup endpoint enforces, from @bitetime/shared — one rule, both sides.
    if (!isPasswordLongEnough(password)) {
      setError(t(
        `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`,
        `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`,
      ))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await updatePassword(password)
      setDone(true)
    } catch (err) {
      setError(
        authErrorCode(err) === 'rate_limited'
          ? t('Too many attempts. Please try again in a moment.', '尝试次数过多，请稍后再试。')
          : t('Could not set your password. Open the link again from your email.', '设置密码失败，请重新打开邮件中的链接。'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form-wrap pt-12 pb-24">
      <h1 className="font-heading text-[22px] font-medium text-oxblood mb-1">
        {t('Set a new password', '设置新密码')}
      </h1>

      {done ? (
        <p role="status" className="text-[13px] text-oxblood bg-rose-pale border border-rose-pale rounded-md px-[13px] py-[10px] mt-4 leading-[1.5]">
          {t(
            "Password updated. You're signed in — taking you back…",
            '密码已更新。你已登录——正在返回…',
          )}
        </p>
      ) : loading ? (
        <div className="py-10 flex justify-center"><Spinner label={t('Checking your link…', '正在验证链接…')} /></div>
      ) : !ready ? (
        // No session means the link was never valid, has already been used, or has expired. Say
        // which and offer the only useful next step — asking for a fresh one.
        <>
          <p role="alert" className="text-[13px] text-danger bg-rose-pale border border-danger-border rounded-md px-[13px] py-[10px] mt-4 leading-[1.5]">
            {t(
              'This link has expired or has already been used. Request a new one from the shop you were ordering from.',
              '此链接已过期或已被使用。请在你下单的店铺重新申请。',
            )}
          </p>
          <button
            type="button"
            onClick={() => navigate(destination)}
            className="text-[13px] text-oxblood underline underline-offset-2 mt-4 inline-block cursor-pointer"
          >
            {shop ? t('Back to the shop', '返回店铺') : t('Back to sign in', '返回登录')}
          </button>
        </>
      ) : (
        <>
          <p className="text-[13px] text-rose-muted leading-[1.5] mb-5">
            {t(
              'Choose a new password for your account. You’ll stay signed in on this device.',
              '为你的账户设置新密码。此设备将保持登录状态。',
            )}
          </p>

          {error && (
            <div role="alert" className="text-[13px] text-danger bg-rose-pale border border-danger-border rounded-md px-[13px] py-[10px] mb-[10px] leading-[1.5]">
              {error}
            </div>
          )}

          <form onSubmit={onSubmit}>
            <div className="flex flex-col gap-1.5 mb-5">
              <Label htmlFor="reset-password">{t('New password', '新密码')}</Label>
              <Input
                id="reset-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
              <p className="text-[12px] text-rose-muted">
                {t(`At least ${MIN_PASSWORD_LENGTH} characters.`, `至少 ${MIN_PASSWORD_LENGTH} 个字符。`)}
              </p>
            </div>
            {/* Base UI's Button defaults to type="button" — explicit submit or the form never fires */}
            <Button type="submit" disabled={busy} className="disabled:opacity-60">
              {busy ? t('Saving…', '保存中…') : t('Set password', '设置密码')}
            </Button>
          </form>
        </>
      )}
    </div>
  )
}
