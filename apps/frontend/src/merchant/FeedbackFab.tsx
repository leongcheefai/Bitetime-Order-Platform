import { useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { useSession } from '../SessionContext'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Button } from '../components/ui/button'
import FeedbackForm from './FeedbackForm'
import { cn } from '@/lib/utils'

// Temporary shell around FeedbackForm. SupportFab replaces this file in the next task.
export default function FeedbackFab() {
  const { t, merchant } = useSession()
  const [open, setOpen] = useState(false)
  if (!merchant) return null
  const title = t('Send feedback', '发送反馈')
  return (
    <>
      <Button
        type="button"
        size="none"
        onClick={() => setOpen(true)}
        aria-label={title}
        title={title}
        className={cn(
          'fixed z-notif-panel bottom-[calc(1.5rem+env(safe-area-inset-bottom))] right-6 max-sm:bottom-[calc(1.25rem+env(safe-area-inset-bottom))] max-sm:right-5',
          'gap-2 rounded-pill px-4 py-3 shadow-elev-2',
          '[@media(pointer:coarse)]:min-h-[48px]',
        )}
      >
        <MessageSquarePlus size={18} strokeWidth={1.75} />
        <span className="text-[13px] font-medium max-sm:sr-only">{title}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="p-6">
          <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
          {open && <FeedbackForm onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  )
}
