import { useState } from 'react'
import { Pencil, Star } from 'lucide-react'
import { ORDER_REVIEW_COMMENT_MAX_LENGTH } from '@bitetime/shared'
import { useSession } from '../SessionContext'
import { Button } from '../components/ui/button'
import { Textarea } from '../components/ui/textarea'
import { cn } from '@/lib/utils'
import { reviewErrorMessage } from './reviewError'
import type { Result } from '../api'
import type { OrderReview } from '../store'

/**
 * One customer, one order, one to five stars.
 *
 * It knows nothing about WHICH door it writes through: `submit` is handed in, so the same card
 * serves the signed-in customer (scoped by the order's `user_id`) and the guest (proving the
 * order number and their phone). The order-placed screen and order history both mount it.
 *
 * The star widget is the one `merchant/TrialFeedbackPrompt.tsx` already uses — a radiogroup of
 * five buttons, filled to the hovered or chosen star. Copied rather than shared: the two live on
 * opposite sides of the product and answer different questions, and a shared widget would tie a
 * merchant survey's layout to a storefront receipt's.
 */
export default function OrderReviewCard({
  initial,
  submit,
  readOnly = false,
  className,
}: {
  /** What is already stored for this order, or null when the customer has not rated it. */
  initial: { rating: number; comment: string | null } | null
  submit: (rating: number, comment: string | null) => Promise<Result<OrderReview>>
  /**
   * Show the stored review and offer no way to change it — a cancelled order, which the backend
   * refuses with 409. It STILL shows what the customer left while the order was live; taking that
   * off screen would read as their words having been deleted. Renders nothing when there is no
   * stored review, because then there is nothing to show and nothing they may write.
   */
  readOnly?: boolean
  className?: string
}) {
  const { t } = useSession()
  // `sent` is what is STORED. `editing` is whether the form is open. A card that opens with a
  // stored review shows it, and opens the form only when the customer asks to change it.
  const [sent, setSent] = useState(initial)
  const [editing, setEditing] = useState(!readOnly && initial === null)
  const [rating, setRating] = useState(initial?.rating ?? 0)
  const [hover, setHover] = useState(0)
  const [comment, setComment] = useState(initial?.comment ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const trimmed = comment.trim()
  const tooLong = trimmed.length > ORDER_REVIEW_COMMENT_MAX_LENGTH

  const send = async () => {
    if (rating < 1 || tooLong || busy) return
    setBusy(true); setError('')
    const r = await submit(rating, trimmed || null)
    setBusy(false)
    if (r.ok) {
      setSent({ rating: r.data.review_rating, comment: r.data.review_comment })
      setEditing(false)
    } else {
      // The CODE, never `r.error.message`: `api.ts` fills that with the wire code itself (or the
      // server's English validator sentence), and this side is bilingual.
      setError(reviewErrorMessage(r.error.code, t))
    }
  }

  const stars = (value: number, interactive: boolean) => (
    <div
      // Centred, while the heading and the comment stay left: five glyphs on a card whose other
      // rows are full-width fields read as a control, not as a line of text, and a control sits
      // on the card's centre line.
      className="flex gap-1 justify-center"
      role={interactive ? 'radiogroup' : undefined}
      aria-label={interactive ? t('Rating', '评分') : undefined}
    >
      {[1, 2, 3, 4, 5].map(n => {
        const filled = value >= n
        const cls = cn('size-[22px]', filled ? 'fill-primary text-primary' : 'text-muted-foreground')
        if (!interactive) return <Star key={n} size={22} strokeWidth={1.75} className={cls} aria-hidden />
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={String(n)}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            onClick={() => setRating(n)}
            // 22px glyph, 38px target: padded, with the padding pulled back into the gap so the
            // five stars sit where they did.
            className="p-2 -m-1 rounded-md focus-visible:outline-2 focus-visible:outline-primary"
          >
            <Star size={22} strokeWidth={1.75} className={cls} />
          </button>
        )
      })}
    </div>
  )

  if (readOnly && !sent) return null

  return (
    // `text-left` is not decoration: the success view that mounts this is `text-center`, and an
    // inherited centre leaves the heading centred over left-aligned stars and a left-aligned
    // link — beside the left-aligned payment card, which is its neighbour on that screen.
    <div className={cn('bg-card border-[0.5px] border-border rounded-2xl p-[15px] text-left', className)}>
      {!editing && sent ? (
        <div className="flex flex-col gap-2">
          {/* The line the pencil belongs to. An icon on its own row below the comment reads as a
              stray glyph; on the card's own first line it reads as "edit this card", which is
              what it does. */}
          <div className="flex items-start justify-between gap-3">
            <p className="text-[13px] text-muted-foreground">
              {t('Thank you for rating this order.', '感谢你的评价。')}
            </p>
            {!readOnly && (
              // Icon-only, so it keeps its NAME twice over: `aria-label` for a screen reader and
              // `title` for the pointer. A pencil with neither is a button nobody can name.
              <Button
                type="button"
                variant="link"
                size="none"
                aria-label={t('Change my rating', '修改评价')}
                title={t('Change my rating', '修改评价')}
                className="shrink-0 p-1 -m-1"
                onClick={() => { setRating(sent.rating); setComment(sent.comment ?? ''); setEditing(true) }}
              >
                <Pencil size={16} strokeWidth={1.75} aria-hidden />
              </Button>
            )}
          </div>
          {stars(sent.rating, false)}
          {sent.comment && (
            <p className="text-[13px] text-foreground break-words whitespace-pre-wrap">{sent.comment}</p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[14px] font-medium text-foreground">
            {t('How was ordering here?', '这次下单体验如何？')}
          </p>
          {stars(hover || rating, true)}
          <Textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            rows={3}
            placeholder={t('Anything you want the shop to know? (optional)', '有什么想告诉店家的吗？（可选）')}
            aria-label={t('Comment', '留言')}
          />
          {tooLong && (
            <p className="text-[12px] text-danger-fg">
              {t(`Comment must be ${ORDER_REVIEW_COMMENT_MAX_LENGTH} characters or fewer`,
                 `留言不能超过 ${ORDER_REVIEW_COMMENT_MAX_LENGTH} 个字`)}
            </p>
          )}
          {error && <p role="alert" className="text-[13px] text-danger-fg">{error}</p>}
          <Button
            type="button"
            onClick={() => void send()}
            disabled={rating < 1 || tooLong || busy}
            className="self-start"
          >
            {busy ? t('Sending…', '提交中…') : t('Send my rating', '提交评价')}
          </Button>
        </div>
      )}
    </div>
  )
}
