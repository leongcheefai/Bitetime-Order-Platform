import { useSession } from '../SessionContext'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import Wordmark from '../components/Wordmark'

/** Where a merchant whose activation never landed is told to write. */
const SUPPORT_EMAIL = 'support@tinyorder.shop'

/**
 * The screen between a completed Stripe Checkout and an open shop.
 *
 * It replaced a bare line of text — `Setting up your subscription…` — that had no end state at
 * all: it rendered whenever `?checkout=success` was in the URL and the shop was not yet active,
 * and the only thing that could ever clear it was a webhook arriving. When one did not, a
 * merchant who had just been charged sat on that sentence indefinitely, with no error, no retry
 * and no way out of the page. This screen always resolves — into the dashboard, or into an
 * honest account of what is stuck and what to do about it.
 */
export default function CheckoutActivating({ stalled, onRetry }: {
  /** True once every attempt has been spent — the retry and the way out only exist then. */
  stalled: boolean
  onRetry: () => void
}) {
  const { t, merchant } = useSession()

  return (
    <div role="main" className="w-[420px] max-w-full pt-8">
      <div className="text-center mb-10">
        <h1><Wordmark className="h-8 mx-auto" /></h1>
        <p className="font-heading text-[13px] italic text-muted-foreground mt-[5px]">{t('Merchant Portal', '商家入口')}</p>
      </div>
      <Card className="rounded-2xl px-8 pt-8 pb-7 gap-0">
        {stalled ? (
          <>
            <span className="inline-flex items-center gap-[5px] px-3 py-[4px] rounded-pill bg-warning-100 text-warning-fg text-[12px] font-semibold tracking-[0.04em] mb-4">
              {t('Still confirming', '仍在确认')}
            </span>
            <h2 className="font-heading text-[20px] font-medium text-primary mb-1">
              {t('Your payment went through', '款项已收到')}
            </h2>
            {/* Says the one thing that matters first — the money is not lost — then what is
                actually stuck. A merchant reading this has already been charged. */}
            <p className="text-[13px] text-muted-foreground mb-6">
              {t(
                'We have not had confirmation from Stripe yet, so your shop is not open. Nothing has been charged twice — try again, and if it keeps saying this, send us the message below.',
                '我们尚未收到 Stripe 的确认，因此店铺尚未开放。不会重复扣款——请重试；若仍是此提示，请按下方方式联系我们。'
              )}
            </p>
            <Button type="button" variant="default" size="md" className="py-3" onClick={onRetry}>
              {t('Try again', '重试')}
            </Button>
            <p className="text-[13px] text-muted-foreground mt-4">
              {t('Still stuck?', '仍未解决？')}{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Shop not activated after payment — ${merchant?.name ?? ''}`)}`}
                className="text-primary no-underline font-medium hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>
            </p>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-[5px] px-3 py-[4px] rounded-pill bg-warning-100 text-warning-fg text-[12px] font-semibold tracking-[0.04em] mb-4">
              ✓ {t('Payment received', '付款成功')}
            </span>
            <h2 className="font-heading text-[20px] font-medium text-primary mb-1">
              {t('Setting up your subscription…', '正在设置您的订阅…')}
            </h2>
            <p className="text-[13px] text-muted-foreground">
              {t('This takes a few seconds. Keep this page open.', '这需要几秒钟，请勿关闭此页面。')}
            </p>
          </>
        )}
      </Card>
    </div>
  )
}
