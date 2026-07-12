import { useSession } from '../SessionContext'
import AuthPanel from './AuthPanel'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'

/**
 * The storefront's sign-in host: a modal, never a route. Email+password has no
 * redirect round-trip, so `Storefront` never unmounts and the cart survives by
 * construction — no lifting state, no storage, no restore logic.
 */
export default function SignInDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useSession()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-6" aria-label={t('Sign in', '登录')}>
        <DialogTitle className="sr-only">{t('Sign in', '登录')}</DialogTitle>
        {/* Promises only what already ships: the order is recorded against the account.
            The prefill half of the interstitial's copy ("your name and address fill in
            automatically next time") lands with the profile prefill, not before it. */}
        <AuthPanel
          heading={t('Sign in to keep your order history', '登录以保存订单记录')}
          subheading={t(
            'Orders you place at this shop while signed in are saved to your account.',
            '登录后在本店下的订单会保存到你的账户中。',
          )}
          onSignedIn={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
