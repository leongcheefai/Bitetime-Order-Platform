import { useEffect, useState } from 'react'
import { useSession } from '../SessionContext'
import { fetchEmailVerification, resendEmailVerification } from '../store'
import { Button } from '@/components/ui/button'

/**
 * "We have not proved we can reach you."
 *
 * Merchant accounts are created pre-confirmed (POST /api/merchant/signup), which is what lets a
 * signup finish in one submit — and it means nothing has ever checked the address. That matters
 * more for a merchant than for a customer: receipts, the trial-ending notice and every password
 * reset go there, so a typo is an owner who hears nothing and cannot get back in.
 *
 * DISMISSIBLE, unlike BillingBanner, and the difference is deliberate. Billing speaks about a
 * shop that is about to shut, which a merchant must not be able to hide from themselves. This
 * one speaks about mail that has already been sent and is waiting to be clicked — nagging a
 * merchant who simply has not opened their inbox yet costs attention and buys nothing. Dismissal
 * is per device (localStorage) and per account, because it is a note about this browser's state
 * of mind, not a fact about the shop.
 */
export default function VerifyEmailBanner() {
  const { t, account, impersonating } = useSession()
  const [needed, setNeeded] = useState(false)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  const userId = account?.id
  const dismissKey = userId ? `verifyEmailDismissed:${userId}` : ''

  useEffect(() => {
    if (!userId || impersonating) return
    let on = true
    fetchEmailVerification().then(r => {
      if (!on || !r.ok) return
      // The dismissal is read HERE rather than in its own state, and folded into one answer.
      // Read into state synchronously inside this effect it would be a cascading render, which
      // is the shape LoginScreen's sessionStorage read avoids the same way. A localStorage read
      // can also throw outright in a browser with site data blocked, and a banner is not worth
      // a crash — so a failed read means "not dismissed", the safe direction.
      let hidden: boolean
      try { hidden = localStorage.getItem(dismissKey) === '1' } catch { hidden = false }
      setNeeded(r.data.configured && !r.data.verified && !hidden)
      setEmail(r.data.email)
    })
    return () => { on = false }
  }, [userId, impersonating, dismissKey])

  // `impersonating` is checked at RENDER, not turned into state by the effect above. An
  // impersonating superadmin is never asked: the resend endpoint keys off the CALLER, so the
  // button would mail the admin and mark the ADMIN's address proved — a banner about someone
  // else's problem, wired to the wrong account.
  if (!needed || impersonating) return null

  function hide() {
    setNeeded(false)
    try { localStorage.setItem(dismissKey, '1') } catch { /* a banner is not worth a crash */ }
  }

  async function resend() {
    setSent('busy')
    const r = await resendEmailVerification()
    // `alreadyVerified` arrives when the merchant clicked the link in another tab while this one
    // sat here. Nothing to send, and nothing left to ask for — take the banner away.
    if (r.ok && r.data.alreadyVerified) { setNeeded(false); return }
    setSent(r.ok ? 'done' : 'failed')
  }

  return (
    <div
      role="status"
      className="flex items-center gap-3 flex-wrap px-4 py-3 mb-5 rounded-md border-[0.5px] text-[13px] leading-[1.5] bg-warning-100 text-warning-fg border-warning-fg/25"
    >
      <span className="flex-1 min-w-[200px] font-medium">
        {sent === 'done'
          ? t(`Sent again to ${email}. Check your inbox — and your spam folder.`,
              `已重新发送至 ${email}。请查收邮件，也请检查垃圾邮件。`)
          : sent === 'failed'
            ? t('Could not send it just now. Please try again in a moment.',
                '暂时无法发送。请稍后再试。')
            : t(`Confirm ${email} so we can reach you about receipts, your trial and password resets.`,
                `请确认 ${email}，以便我们就收据、试用和密码重置与你联系。`)}
      </span>
      {sent !== 'done' && (
        <Button
          size="none"
          variant="outline"
          className="py-[5px] px-3 rounded-pill text-[12px] whitespace-nowrap bg-card hover:bg-brand-100 hover:text-primary hover:border-primary"
          disabled={sent === 'busy'}
          onClick={resend}
        >
          {sent === 'busy' ? t('Sending…', '发送中…') : t('Resend the link', '重新发送链接')}
        </Button>
      )}
      <button
        type="button"
        onClick={hide}
        className="text-[12px] underline underline-offset-2 decoration-current/50 hover:decoration-current"
      >
        {t('Not now', '暂不')}
      </button>
    </div>
  )
}
