import { useState } from 'react'
import { useSession } from '../SessionContext'
import AuthPanel from './AuthPanel'
import { accountPitch } from './accountPitch'
import { Button } from '../components/ui/button'

/**
 * The checkout interstitial: sign in, create account, or continue as guest. It replaces the
 * checkout form — a customer with items in the cart meets it once per shop, and the guest
 * path always works.
 *
 * Guest is ONE tap. The consequence is already on screen when they tap it, so a confirm step
 * would buy nothing; a confirm is only honest when the warning is hidden, and it isn't.
 *
 * The warning is muted, not alarming — muted type under a hairline, lead clause bolded. Tried
 * as a bordered danger box first (see the prototype) and it inverted the hierarchy: it
 * out-shouted the headline and made the guest path the loudest thing on a screen whose whole
 * purpose is to offer an account. Same words, quieter voice.
 *
 * It is also true. It does not claim the order is unfindable: /track still resolves a single
 * order by number. The order number really is the recourse, and really is the only one.
 */
export default function CheckoutGate({ onGuest }: { onGuest: () => void }) {
  const { t } = useSession()
  const [auth, setAuth] = useState<'signin' | 'signup' | null>(null)
  const pitch = accountPitch(t)

  if (auth) {
    return (
      <div className="py-2">
        <AuthPanel
          key={auth}
          initialMode={auth}
          {...pitch}
          footer={
            <p className="mt-4">
              <button
                type="button"
                onClick={() => setAuth(null)}
                className="text-[13px] text-rose-muted underline underline-offset-2 cursor-pointer"
              >
                {t('Back', '返回')}
              </button>
            </p>
          }
        />
      </div>
    )
  }

  return (
    <div className="py-2 flex flex-col gap-5">
      <div className="text-center">
        <h2 className="font-heading text-[19px] font-medium text-oxblood leading-snug">{pitch.heading}</h2>
        <p className="text-[13px] text-rose-muted leading-[1.6] mt-2">{pitch.subheading}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Button onClick={() => setAuth('signin')}>{t('Sign in', '登录')}</Button>
        <Button
          onClick={() => setAuth('signup')}
          className="bg-surface-raised text-ink border border-clay-border hover:border-oxblood"
        >
          {t('Create account', '注册账户')}
        </Button>
      </div>

      <hr className="border-0 border-t border-clay-border" />

      <div className="text-center">
        <button
          type="button"
          onClick={onGuest}
          className="text-[14px] text-ink font-medium underline underline-offset-2 cursor-pointer"
        >
          {t('Continue as guest', '以访客身份继续')} →
        </button>
        <p className="text-[12px] text-rose-muted leading-[1.6] mt-2.5 max-w-[340px] mx-auto">
          <strong className="font-medium text-ink">
            {t("Guest orders can't be traced back.", '访客订单无法追溯。')}
          </strong>{' '}
          {t(
            "This order won't be saved to any account. You'll get an order number — keep it. It's the only way to look this order up again.",
            '此订单不会保存到任何账户。你会收到一个订单号，请务必保存——这是日后查询此订单的唯一方式。',
          )}
        </p>
      </div>
    </div>
  )
}

/**
 * What is left of the gate for a returning guest: present, not nagging. The gate is not shown
 * again at this shop, but the path back to an account stays one tap away without an interstitial.
 */
export function GuestStrip({ onSignIn }: { onSignIn: () => void }) {
  const { t } = useSession()
  return (
    <div className="flex items-center justify-between gap-3 bg-oxblood-tint border border-rose-border rounded-md px-[13px] py-2.5 mb-3">
      <span className="text-[13px] text-rose-muted leading-[1.4]">
        {t('Ordering as a guest.', '正在以访客身份下单。')}
      </span>
      <button
        type="button"
        onClick={onSignIn}
        className="text-[13px] text-oxblood font-medium underline underline-offset-2 cursor-pointer shrink-0"
      >
        {t('Sign in', '登录')}
      </button>
    </div>
  )
}
