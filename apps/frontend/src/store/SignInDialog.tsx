import { useSession } from '../SessionContext'
import AuthPanel from './AuthPanel'
import { accountPitch } from './accountPitch'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'

/**
 * The storefront's sign-in host: a modal, never a route. Email+password has no
 * redirect round-trip — not even for a brand-new account, which the backend mints
 * pre-confirmed — so `Storefront` never unmounts and the cart survives by
 * construction: no lifting state, no storage, no restore logic.
 */
export default function SignInDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useSession()
  const label = t('Sign in or create an account', '登录或创建账户')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-6" aria-label={label}>
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <AuthPanel {...accountPitch(t)} onSignedIn={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
