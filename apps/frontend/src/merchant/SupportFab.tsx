// The help bubble (docs/superpowers/specs/2026-10-02-support-chat-design.md). Replaces FeedbackFab
// in the same position and z-index, and adds a red dot for an unread reply.
//
// Hidden from a superadmin by ROLE, not by `merchant`: in "view as shop" mode SessionContext sets
// `merchant` to the impersonated shop, so a `!merchant` check alone would show the bubble.
//
// Rendered by Dashboard, PendingScreen and SuspendedScreen rather than DashboardShell: the shell
// is shared with /admin. z-notif-panel (50) keeps the bubble under the shell's mobile top bar
// (z-sticky, 90) and under the drawer's overlay.
import { useCallback, useState } from 'react'
import { LifeBuoy } from 'lucide-react'
import { useSession } from '../SessionContext'
import { Button } from '../components/ui/button'
import SupportPanel from './SupportPanel'
import { useSupportFeed } from './useSupportFeed'
import { cn } from '@/lib/utils'

export default function SupportFab({ onNavigate }: { onNavigate?: (section: string, sub?: string) => void }) {
  const { t, merchant, role } = useSession()
  const [open, setOpen] = useState(false)
  const merchantId = merchant && role !== 'superadmin' ? merchant.id : null
  // The hook runs before the early return (rules of hooks); a null id makes it do nothing.
  const feed = useSupportFeed(merchantId, open)
  const close = useCallback(() => setOpen(false), [])

  if (!merchantId) return null
  const title = t('Help', '帮助')

  return (
    <>
      {!open && (
        <Button
          type="button"
          size="none"
          onClick={() => setOpen(true)}
          aria-label={feed.unread > 0 ? t(`${title} — new reply`, `${title}——有新回复`) : title}
          title={title}
          className={cn(
            'fixed z-notif-panel bottom-[calc(1.5rem+env(safe-area-inset-bottom))] right-6 max-sm:bottom-[calc(1.25rem+env(safe-area-inset-bottom))] max-sm:right-5',
            'gap-2 rounded-pill px-4 py-3 shadow-elev-2',
            '[@media(pointer:coarse)]:min-h-[48px]',
          )}
        >
          <LifeBuoy size={18} strokeWidth={1.75} />
          <span className="text-[13px] font-medium max-sm:sr-only">{title}</span>
          {feed.unread > 0 && (
            <span aria-hidden className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-pill bg-danger ring-2 ring-background" />
          )}
        </Button>
      )}
      {open && <SupportPanel merchantId={merchantId} feed={feed} onClose={close} onNavigate={onNavigate} />}
    </>
  )
}
