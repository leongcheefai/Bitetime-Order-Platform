import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { TRIAL_FEEDBACK_COMMENT_MAX_LENGTH } from '@bitetime/shared'
import { useSession } from '../SessionContext'
import { fetchTrialFeedback, respondTrialFeedback, skipTrialFeedback } from '../store'
import { Textarea } from '../components/ui/textarea'
import { Button } from '../components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The one-time trial-experience survey (#155) — shown once a merchant's `trial_feedback` row
 * exists and is neither answered nor skipped. Mounted from both Dashboard and SuspendedScreen,
 * since a lapsed trial is exactly the merchant most likely to have this waiting for them
 * (see CONTEXT.md → Trial feedback). Renders nothing while loading, and nothing once there
 * is nothing pending — including for a merchant with no shop yet.
 */
export default function TrialFeedbackPrompt() {
  const { t, merchant } = useSession()
  const [status, setStatus] = useState<'loading' | 'pending' | 'done'>('loading')
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchTrialFeedback().then(r => {
      if (cancelled) return
      const pending = !!(r.ok && r.data && !r.data.responded_at && !r.data.skipped_at)
      setStatus(pending ? 'pending' : 'done')
    })
    return () => { cancelled = true }
  }, [])

  if (!merchant || status !== 'pending') return null

  const trimmed = comment.trim()
  const tooLong = trimmed.length > TRIAL_FEEDBACK_COMMENT_MAX_LENGTH

  const submit = async () => {
    if (rating < 1 || tooLong || busy) return
    setBusy(true); setError('')
    const r = await respondTrialFeedback(rating, trimmed || null)
    if (r.ok) setStatus('done')
    else { setError(r.error.message || t('Could not send', '无法发送')); setBusy(false) }
  }

  const skip = async () => {
    if (busy) return
    setBusy(true); setError('')
    const r = await skipTrialFeedback()
    if (r.ok) setStatus('done')
    else { setError(r.error.message || t('Could not send', '无法发送')); setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4 mb-6 rounded-md border-[0.5px] border-primary/20 bg-card">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[14px] font-medium text-foreground">
          {t('How was your trial?', '试用体验如何？')}
        </p>
        <Button
          type="button"
          variant="link"
          size="none"
          onClick={() => void skip()}
          disabled={busy}
          className="text-[12px] text-muted-foreground shrink-0"
        >
          {t('No thanks', '不用了')}
        </Button>
      </div>

      <div className="flex gap-1" role="radiogroup" aria-label={t('Rating', '评分')}>
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={String(n)}
            onMouseEnter={() => setHoverRating(n)}
            onMouseLeave={() => setHoverRating(0)}
            onClick={() => setRating(n)}
          >
            <Star
              size={22}
              strokeWidth={1.75}
              className={cn((hoverRating || rating) >= n ? 'fill-primary text-primary' : 'text-muted-foreground')}
            />
          </button>
        ))}
      </div>

      <Textarea
        value={comment}
        onChange={e => setComment(e.target.value)}
        rows={3}
        placeholder={t('Anything you want to add? (optional)', '还有什么想说的吗？（可选）')}
        aria-label={t('Comment', '留言')}
      />
      {tooLong && (
        <p className="text-[12px] text-danger-fg">
          {t(`Comment must be ${TRIAL_FEEDBACK_COMMENT_MAX_LENGTH} characters or fewer`,
             `留言不能超过 ${TRIAL_FEEDBACK_COMMENT_MAX_LENGTH} 个字`)}
        </p>
      )}
      {error && <p role="alert" className="text-[13px] text-danger-fg">{error}</p>}

      <Button onClick={() => void submit()} disabled={rating < 1 || tooLong || busy} className="self-start">
        {busy ? t('Sending…', '发送中…') : t('Submit', '提交')}
      </Button>
    </div>
  )
}
