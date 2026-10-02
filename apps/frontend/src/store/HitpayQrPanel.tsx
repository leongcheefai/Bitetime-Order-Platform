import { useEffect, useRef, useState, type ReactNode } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import { useSession } from '../SessionContext'
import { fetchHitpayStatus, requestHitpayQr, type HitpayQr } from '../store'
import type { Result } from '../api'
import { formatCountdown, isPaid, POLL_MS, secondsLeft } from '../hitpayQr'
import { formatMoney } from '../currency'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type View =
  | { kind: 'loading' }
  | { kind: 'live'; qrPayload: string; amount: string; currency: string; expiresAt: string }
  | { kind: 'paid' }
  | { kind: 'fallback' }

/** The view the QR request's answer leads to. Expiry is not a view: the render derives it. */
function viewFrom(r: Result<HitpayQr>): View {
  if (!r.ok) return { kind: 'fallback' }
  if (r.data.status === 'completed') return { kind: 'paid' }
  return { kind: 'live', ...r.data }
}

/**
 * The customer pays this order with the shop's own HitPay DuitNow QR (spec 2026-10-02).
 *
 * The QR holds the exact total, so the backend can confirm the payment by itself: this panel polls
 * while the QR is on screen and the tab is visible, and the HitPay webhook covers the rest. When
 * HitPay cannot make a QR, `fallback` — the static instructions and the proof upload — takes its
 * place, so a customer is never left with no way to pay.
 *
 * "Save QR" is not decoration: most customers order on a phone and cannot scan the screen they
 * are holding. They save the image and open it in their banking app.
 */
export default function HitpayQrPanel({
  orderId,
  onPaid,
  fallback,
  className,
}: {
  orderId: string
  onPaid: () => void
  fallback: ReactNode
  className?: string
}) {
  const { t } = useSession()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onPaidRef = useRef(onPaid)
  useEffect(() => { onPaidRef.current = onPaid })

  function show(next: View) {
    setView(next)
    if (next.kind === 'paid') onPaidRef.current()
  }

  useEffect(() => {
    let cancelled = false
    requestHitpayQr(orderId).then(r => {
      if (cancelled) return
      const next = viewFrom(r)
      setView(next)
      if (next.kind === 'paid') onPaidRef.current()
    })
    return () => { cancelled = true }
  }, [orderId])

  async function renew() {
    setView({ kind: 'loading' })
    show(viewFrom(await requestHitpayQr(orderId)))
  }

  // One timer drives both the countdown and the poll, and stops at the expiry. A hidden tab
  // neither polls nor ticks; the webhook covers it.
  useEffect(() => {
    if (view.kind !== 'live') return
    const expiresAt = Date.parse(view.expiresAt)
    let ticks = 0
    const id = setInterval(async () => {
      if (document.hidden) return
      const at = Date.now()
      setNow(at)
      if (at >= expiresAt) { clearInterval(id); return }
      ticks += 1
      if (ticks % (POLL_MS / 1000) !== 0) return
      const r = await fetchHitpayStatus(orderId)
      if (r.ok && isPaid(r.data)) { clearInterval(id); show({ kind: 'paid' }) }
    }, 1000)
    return () => clearInterval(id)
  }, [view, orderId])

  const expired = view.kind === 'live' && secondsLeft(view.expiresAt, now) === 0

  function save() {
    const canvas = canvasRef.current
    if (!canvas) return
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `duitnow-${orderId.slice(0, 8)}.png`
    a.click()
  }

  if (view.kind === 'fallback') return <>{fallback}</>

  return (
    <div className={cn('text-center px-[14px] py-[12px] bg-card border-[0.5px] border-border rounded-md', className)}>
      <div className="font-semibold text-primary mb-2 text-[13px]">{t('Pay with DuitNow', '使用 DuitNow 付款')}</div>
      {view.kind === 'loading' && (
        <div className="mx-auto w-[220px] h-[220px] rounded-md bg-muted animate-pulse" aria-label={t('Loading QR', '正在加载二维码')} />
      )}
      {view.kind === 'live' && !expired && (
        <>
          <div className="mx-auto w-fit bg-white p-2 rounded-md">
            <QRCodeCanvas ref={canvasRef} value={view.qrPayload} size={220} marginSize={2} />
          </div>
          <p className="mt-2 text-[15px] font-medium text-foreground">{formatMoney(Number(view.amount), view.currency)}</p>
          <p className="text-[12px] text-muted-foreground tabular-nums">
            {t(`Valid for ${formatCountdown(secondsLeft(view.expiresAt, now))}`, `有效时间 ${formatCountdown(secondsLeft(view.expiresAt, now))}`)}
          </p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={save}>
            {t('Save QR', '保存二维码')}
          </Button>
          <p className="mt-2 text-[12px] text-muted-foreground leading-[1.5]">
            {t('Open your banking app and scan this QR, or upload the saved image. This page updates by itself when you pay.',
               '打开您的银行应用扫描此二维码，或上传已保存的图片。付款后此页面会自动更新。')}
          </p>
        </>
      )}
      {expired && (
        <>
          <p className="text-[14px] text-foreground mb-2">{t('This QR expired.', '此二维码已过期。')}</p>
          <Button type="button" size="sm" onClick={renew}>{t('Get a new QR', '获取新的二维码')}</Button>
        </>
      )}
      {view.kind === 'paid' && (
        <p className="text-[14px] font-medium text-foreground">{t('Payment received. Thank you!', '已收到付款，谢谢！')}</p>
      )}
    </div>
  )
}
