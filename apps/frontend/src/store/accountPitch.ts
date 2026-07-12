import type { Translate } from '../types'

/**
 * The offer, in one place. Every host that asks a customer for an account makes the same promise
 * — the checkout gate (twice: its own headline, then the panel it opens) and the sign-in modal —
 * and the promise is only as good as what ships, so it must not drift between them.
 *
 * The second sentence was deliberately withheld until the profile prefill shipped, because until
 * then it was a half-truth. It is now the whole offer: history, and never typing this again.
 */
export const accountPitch = (t: Translate) => ({
  heading: t('Sign in to keep your order history', '登录以保存订单记录'),
  subheading: t(
    'Orders you place at this shop are saved to your account, and your name and address fill in automatically next time.',
    '你在本店的订单会保存到账户中，姓名和地址下次会自动填写。',
  ),
})
