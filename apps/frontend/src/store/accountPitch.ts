import type { Translate } from '../types'

/**
 * The offer, in one place. Every host that asks a customer for an account makes the same promise
 * — the checkout gate (twice: its own headline, then the panel it opens) and the sign-in modal —
 * and the promise is only as good as what ships, so it must not drift between them.
 *
 * It promises exactly what ships today: the order is recorded against the account. The prefill
 * payoff ("your name and address fill in automatically next time") lands with the profile
 * prefill, not before it.
 */
export const accountPitch = (t: Translate) => ({
  heading: t('Sign in to keep your order history', '登录以保存订单记录'),
  subheading: t(
    'Orders you place at this shop while signed in are saved to your account.',
    '登录后在本店下的订单会保存到你的账户中。',
  ),
})
