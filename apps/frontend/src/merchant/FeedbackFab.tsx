import { useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { FEEDBACK_CATEGORIES, FEEDBACK_MAX_LENGTH, type FeedbackCategory } from '@bitetime/shared'
import { useSession } from '../SessionContext'
import { submitFeedback } from '../store'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Textarea } from '../components/ui/textarea'
import { Button } from '../components/ui/button'
import { cn } from '@/lib/utils'

// Bilingual labels for the four categories the backend accepts. Keyed off the shared
// FEEDBACK_CATEGORIES tuple so adding a category there is a type error here until it is
// given a label — the list cannot silently drift out of sync with the server.
const CATEGORY_LABELS: Record<FeedbackCategory, { en: string; zh: string }> = {
  bug:     { en: 'Something is broken', zh: '出现故障' },
  feature: { en: 'Feature request',     zh: '功能建议' },
  billing: { en: 'Billing',             zh: '账单' },
  other:   { en: 'Something else',      zh: '其他' },
}

/**
 * Floating feedback button for the merchant dashboard (#89).
 *
 * Rendered by Dashboard.tsx rather than DashboardShell: the shell is shared with /admin,
 * and a superadmin does not need to send themselves feedback. z-30 keeps it under the
 * shell's mobile drawer backdrop (z-40) and the drawer itself (z-50), so it does not
 * bleed through an open menu; the dialog it opens portals above everything.
 */
export default function FeedbackFab() {
  const { t, merchant } = useSession()
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<FeedbackCategory | ''>('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  if (!merchant) return null

  const trimmed = message.trim()
  const tooLong = trimmed.length > FEEDBACK_MAX_LENGTH
  const canSubmit = category !== '' && trimmed.length > 0 && !tooLong && !busy

  // Reset on close so reopening never shows the previous submission's thank-you or error.
  const change = (next: boolean) => {
    setOpen(next)
    if (!next) { setCategory(''); setMessage(''); setError(''); setSent(false); setBusy(false) }
  }

  const send = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      await submitFeedback(merchant.id, { category: category as FeedbackCategory, message: trimmed })
      setSent(true)
      // Let the thank-you land before the dialog goes away.
      setTimeout(() => change(false), 1600)
    } catch (e) {
      // Keep what they typed — losing a long message to a failed request is the worst
      // possible outcome for a feedback form.
      setError(e instanceof Error ? e.message : t('Could not send feedback', '无法发送反馈'))
      setBusy(false)
    }
  }

  const title = t('Send feedback', '发送反馈')

  return (
    <>
      <button
        type="button"
        onClick={() => change(true)}
        aria-label={title}
        title={title}
        className={cn(
          'fixed z-30 bottom-6 right-6 max-sm:bottom-5 max-sm:right-5',
          'flex items-center gap-2 rounded-full px-4 py-3',
          'bg-oxblood text-cream shadow-lg cursor-pointer',
          'transition-colors duration-150 hover:bg-oxblood-deep',
          '[@media(pointer:coarse)]:min-h-[48px]',
        )}
      >
        <MessageSquarePlus size={18} strokeWidth={1.75} />
        <span className="text-[13px] font-sans font-medium max-sm:sr-only">{title}</span>
      </button>

      <Dialog open={open} onOpenChange={change}>
        <DialogContent className="p-6">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {t('Tell us what is working and what is not. We read every message.',
                 '告诉我们哪些好用、哪些不好用。我们会阅读每一条留言。')}
            </DialogDescription>
          </DialogHeader>

          {sent ? (
            <p className="py-6 text-center text-[14px] text-ink">
              {t('Thanks — we got it.', '谢谢，我们已收到。')}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <Select value={category} onValueChange={(v) => setCategory(v as FeedbackCategory)}>
                <SelectTrigger aria-label={t('Category', '类别')}>
                  <SelectValue placeholder={t('Pick a category', '选择类别')} />
                </SelectTrigger>
                <SelectContent>
                  {FEEDBACK_CATEGORIES.map(key => (
                    <SelectItem key={key} value={key}>
                      {t(CATEGORY_LABELS[key].en, CATEGORY_LABELS[key].zh)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div>
                <Textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  rows={6}
                  aria-label={t('Your message', '你的留言')}
                  placeholder={t('What happened, or what would help?', '发生了什么？或者什么能帮到你？')}
                />
                <div className={cn(
                  'mt-1 text-right text-[11px]',
                  tooLong ? 'text-danger-fg' : 'text-text-tertiary',
                )}>
                  {trimmed.length} / {FEEDBACK_MAX_LENGTH}
                </div>
              </div>

              {error && <p className="text-[13px] text-danger-fg">{error}</p>}

              <Button onClick={send} disabled={!canSubmit}>
                {busy ? t('Sending…', '发送中…') : t('Send', '发送')}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
