import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSession } from './SessionContext'
import { fetchGuestInvoice } from './store'
import { saveBlob } from './download'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Label } from './components/ui/label'

/**
 * Where a guest fetches their own invoice.
 *
 * A TOP-LEVEL route, deliberately outside the storefront shell — the same rule
 * `ResetPasswordPage` follows: nested under `/s/:slug` the shell's merchant-status gate would
 * swallow this page, and a suspended shop must never hold its past customers' invoices hostage.
 *
 * It exists because a guest is unreachable by any other means. Their order carries `user_id =
 * null` for ever, the confirmation email skips such orders structurally, and once the tab closes
 * the platform has no way to hand them anything. What they still hold is the order number and the
 * phone they typed, so that is what the door asks for (ADR 0018).
 *
 * The shop rides in `?shop=<slug>` because an order number is unique per SHOP only — the prefix
 * is the first two alphanumerics of the slug — so without it one number can name two orders.
 *
 * ONE refusal sentence, and that is not laziness: the backend answers a wrong phone, a missing
 * order, a stranger's order and an unissuable status with the identical 404, precisely so this
 * page cannot become a way to discover which order numbers are real.
 */
export default function InvoicePage() {
  const [params] = useSearchParams()
  const { t } = useSession()
  const shop = params.get('shop') ?? ''
  // The QR code on a printed invoice lands here with `?order=` already set, so the reader who
  // scanned their own paper types only the phone. The number alone opens nothing — the door still
  // asks for the phone (ADR 0018), which is exactly why it is safe to put in a link.
  const [orderNumber, setOrderNumber] = useState(params.get('order') ?? '')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setDone(false)
    const r = await fetchGuestInvoice(shop, orderNumber, phone)
    setBusy(false)
    if (!r.ok) {
      setError(
        r.error.code === 'rate_limited'
          ? t('Too many tries. Please wait a minute and try again.', '尝试次数过多，请稍后再试。')
          : t(
            'We could not find that order. Check the order number and the WhatsApp number you ordered with. An invoice is available once the shop has confirmed your order.',
            '找不到该订单。请检查订单号和你下单时使用的 WhatsApp 号码。店家确认订单后才能开具账单。',
          ),
      )
      return
    }
    saveBlob(r.data.blob, r.data.filename ?? `Invoice-${orderNumber}.pdf`)
    setDone(true)
  }

  return (
    <div role="main" className="form-wrap pt-12 pb-24">
      <h1 className="font-heading text-[22px] font-medium text-primary mb-1">
        {t('Get your invoice', '获取账单')}
      </h1>
      <p className="text-[13px] text-muted-foreground leading-[1.5] mb-5">
        {t(
          'Enter your order number and the WhatsApp number you ordered with. Your invoice downloads as a PDF.',
          '请输入订单号和下单时使用的 WhatsApp 号码。账单将以 PDF 格式下载。',
        )}
      </p>

      {/* A page opened without a shop cannot look anything up, and says so instead of refusing
          every attempt with the same sentence as a wrong phone. The link always carries it; a
          hand-typed URL may not. */}
      {!shop ? (
        <p role="alert" className="text-[13px] text-danger-fg bg-danger-100 border border-danger-500 rounded-md px-[13px] py-[10px] leading-[1.5]">
          {t(
            'Open this page from the shop you ordered from — its link carries the shop name.',
            '请从你下单的店铺打开此页面——店铺链接中包含店名。',
          )}
        </p>
      ) : (
        <>
          {error && (
            <div role="alert" className="text-[13px] text-danger-fg bg-danger-100 border border-danger-500 rounded-md px-[13px] py-[10px] mb-[10px] leading-[1.5]">
              {error}
            </div>
          )}
          {done && (
            <p role="status" className="text-[13px] text-primary bg-success-100 border border-success-100 rounded-md px-[13px] py-[10px] mb-[10px] leading-[1.5]">
              {t('Your invoice has been downloaded.', '账单已下载。')}
            </p>
          )}

          <form onSubmit={onSubmit}>
            <div className="flex flex-col gap-1.5 mb-4">
              <Label htmlFor="invoice-order">{t('Order number', '订单号')}</Label>
              <Input
                id="invoice-order"
                value={orderNumber}
                onChange={e => setOrderNumber(e.target.value)}
                placeholder="AB-260820-0051"
                autoComplete="off"
                required
              />
            </div>
            <div className="flex flex-col gap-1.5 mb-5">
              <Label htmlFor="invoice-phone">{t('WhatsApp number', 'WhatsApp 号码')}</Label>
              <Input
                id="invoice-phone"
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="012-345 6789"
                autoComplete="tel"
                required
              />
            </div>
            {/* Base UI's Button defaults to type="button" — explicit submit or the form never fires */}
            <Button type="submit" disabled={busy}>
              {busy ? t('Looking…', '查询中…') : t('Download invoice', '下载账单')}
            </Button>
          </form>
        </>
      )}
    </div>
  )
}
