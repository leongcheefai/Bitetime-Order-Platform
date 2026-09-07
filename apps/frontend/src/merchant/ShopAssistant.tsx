// The question box under the Overview figures (tasks/prd-shop-analytics-assistant.md).
//
// A shortcut through the charts above, not a replacement for them. The merchant types a question
// and gets a short answer read from their own order statistics — the same numbers the chart
// beside it draws, through the same shared function, so the two cannot disagree.
//
// Two things here are load-bearing rather than decorative:
//
//   * The example questions. Merchants do not know what they are allowed to ask, and an empty box
//     with a cursor in it gets typed into once and abandoned.
//   * The disclaimer. `isBooked` excludes cancelled orders from revenue, and a merchant who does
//     not know that reads a correct number as a wrong one. It is built from the window the model
//     actually queried — the server sends that back — never from the answer's own words.
import { useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { useSession } from '../SessionContext'
import { askShop, type ShopAnswer } from '../store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const MAX_QUESTION = 500

export default function ShopAssistant() {
  const { t, lang, merchant } = useSession()
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<ShopAnswer | null>(null)
  const [error, setError] = useState('')

  // Concrete and answerable, not a feature tour. Each one maps onto figures the tool actually
  // returns, so a merchant's first try succeeds rather than teaching them the box is useless.
  const examples = [
    t('How did the last 30 days compare with before?', '最近 30 天和之前相比如何？'),
    t('Which product made the least money?', '哪个产品的营收最少？'),
    t('How many orders were cancelled?', '有多少订单被取消？'),
  ]

  async function ask(q: string) {
    const trimmed = q.trim()
    if (!trimmed || !merchant) return
    setBusy(true); setError(''); setAnswer(null)

    const r = await askShop(merchant.id, trimmed.slice(0, MAX_QUESTION), lang === 'zh' ? 'zh' : 'en')
    setBusy(false)

    if (!r.ok) {
      // Each refusal means something different, and the merchant can act on the difference.
      const byCode: Record<string, string> = {
        assistant_unavailable: t('The assistant is not switched on for this platform yet.', '本平台尚未开启智能助手。'),
        daily_limit_reached: t('You have reached today’s limit of 50 questions.', '您已达到今天 50 个问题的上限。'),
        // Deliberately not the daily wording: "come back tomorrow" and "come back next month" are
        // different news, and the merchant can act on the difference.
        monthly_limit_reached: t('You have reached this month’s limit of 60 questions. It resets on the 1st of next month.', '您已达到本月 60 个问题的上限。下月 1 日重置。'),
        could_not_answer: t('The assistant could not answer that. Try asking it more simply.', '智能助手无法回答。请换个更简单的问法。'),
        question_too_long: t('That question is too long.', '问题太长了。'),
        shop_not_active: t('Your shop is not active, so the assistant is switched off.', '您的店铺未启用，智能助手已关闭。'),
      }
      setError(byCode[r.error.code ?? ''] ?? r.error.message)
      return
    }
    setAnswer(r.data)
  }

  return (
    <div className="rounded-xl border-[0.5px] border-border bg-card px-5 py-4">
      <h3 className="font-heading text-[15px] font-medium text-primary flex items-center gap-2 mb-1">
        <Sparkles className="size-4" />
        {t('Ask about your shop', '询问您的店铺')}
      </h3>
      <p className="text-[13px] text-muted-foreground mb-3">
        {t('Ask a question about your own orders in plain words.', '用日常语言询问您自己的订单。')}
      </p>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={e => { e.preventDefault(); ask(question) }}
      >
        <Input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          maxLength={MAX_QUESTION}
          placeholder={t('e.g. Which product sold best last month?', '例如：上个月哪个产品卖得最好？')}
          className="flex-1 min-w-[220px] h-9 text-[13px]"
          aria-label={t('Your question', '您的问题')}
        />
        <Button
          type="submit" size="none"
          className="rounded-lg py-[6px] px-[14px] text-[13px]"
          disabled={busy || question.trim() === ''}
        >
          {busy && <Loader2 className="size-4 mr-1 animate-spin" />}
          {busy ? t('Thinking…', '思考中…') : t('Ask', '提问')}
        </Button>
      </form>

      {/* One tap to a question that works. Hidden once there is something to read, so the answer
          is not competing with three prompts to ask something else. */}
      {!answer && !busy && !error && (
        <div className="flex flex-wrap gap-2 mt-3">
          {examples.map(ex => (
            <button
              key={ex}
              type="button"
              onClick={() => { setQuestion(ex); ask(ex) }}
              className="rounded-pill border-[0.5px] border-border bg-background/60 px-3 py-1 pointer-coarse:min-h-9 text-[12px] text-muted-foreground hover:text-foreground"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {error && <p role="alert" className="text-[13px] text-danger-fg mt-3">{error}</p>}

      {answer && (
        <div className="mt-3 rounded-lg border-[0.5px] border-border bg-background/50 px-4 py-3">
          {/* `whitespace-pre-wrap` rather than a markdown renderer: the answer is two or three
              sentences or a short list, and a dependency for that is not a trade worth making. */}
          <p className="text-[14px] text-foreground whitespace-pre-wrap">{answer.answer}</p>

          {/* Generated from the window the model actually read, not from what it wrote. Absent
              when it read nothing — a disclaimer naming a window that was never queried would be
              a more confident lie than no disclaimer at all. */}
          {answer.window && (
            <p className="text-[11px] text-muted-foreground mt-2 pt-2 border-t-[0.5px] border-border">
              {t(
                `Based on the last ${answer.window.days} days. Cancelled orders are not counted in revenue.`,
                `基于最近 ${answer.window.days} 天的数据。营收不计入已取消的订单。`,
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
