import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { connectHitpay, disconnectHitpay, fetchHitpayConnection, type HitpayConnection } from '../store'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

const HITPAY_KEYS_URL = 'https://dashboard.hit-pay.com/'

/**
 * Settings → Payment → "DuitNow by HitPay" (spec 2026-10-02). The merchant pastes ONE key; the
 * backend registers the webhook with it. Outside the Payment form on purpose: connecting is its
 * own action with its own answer from HitPay, not a field that waits for "Save payment".
 */
export default function HitpayCard({ className }: { className?: string }) {
  const { t, merchant, refreshMerchant } = useSession()
  const [conn, setConn] = useState<HitpayConnection | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const myr = (merchant?.currency ?? 'MYR') === 'MYR'

  useEffect(() => {
    if (!merchant?.id) return
    fetchHitpayConnection(merchant.id).then(r => { if (r.ok) setConn(r.data) })
  }, [merchant?.id])

  const ERRORS: Record<string, string> = {
    invalid_key: t('HitPay did not accept this key. Copy it again from your HitPay dashboard.', 'HitPay 不接受此密钥。请从 HitPay 后台重新复制。'),
    gateway_unavailable: t('We could not reach HitPay. Try again in a minute.', '无法连接 HitPay。请稍后再试。'),
    currency_not_supported: t('DuitNow works only for a shop in MYR.', 'DuitNow 仅适用于以马币（MYR）结算的商店。'),
    hitpay_not_configured: t('HitPay is not available yet.', 'HitPay 暂不可用。'),
  }

  async function connect() {
    if (!merchant || !key.trim()) return
    setBusy(true)
    const r = await connectHitpay(merchant.id, key.trim())
    setBusy(false)
    if (!r.ok) { toast.error(ERRORS[r.error.code ?? ''] ?? t('Could not connect HitPay', '无法连接 HitPay')); return }
    setConn(r.data)
    setKey('')
    await refreshMerchant()
    toast.success(t('HitPay connected', 'HitPay 已连接'))
  }

  async function disconnect() {
    if (!merchant) return
    setBusy(true)
    const r = await disconnectHitpay(merchant.id)
    setBusy(false)
    if (!r.ok) { toast.error(t('Could not disconnect HitPay', '无法断开 HitPay')); return }
    setConn(r.data)
    await refreshMerchant()
    toast.success(t('HitPay disconnected', 'HitPay 已断开'))
  }

  return (
    <div className={className}>
      <h3 className="font-heading text-[15px] font-medium text-primary mb-4 flex items-center gap-2">{t('DuitNow by HitPay', 'DuitNow（HitPay）')}</h3>
      <p className="text-[13px] text-muted-foreground leading-[1.5] mb-3">
        {t('Customers pay each order with a DuitNow QR for the exact amount. The order is marked paid by itself. The money goes to your HitPay account. TinyOrder takes no commission.',
           '顾客用金额准确的 DuitNow 二维码为每笔订单付款，订单会自动标记为已付款。款项直接进入您的 HitPay 账户，TinyOrder 不收佣金。')}
      </p>
      {!myr ? (
        <p className="text-[13px] text-muted-foreground">{ERRORS.currency_not_supported}</p>
      ) : conn?.connected ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[14px] text-foreground">
            {t(`Connected · key ending ${conn.keyLast4}`, `已连接 · 密钥尾号 ${conn.keyLast4}`)}
          </span>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={disconnect}>
            {t('Disconnect', '断开')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-[6px] max-w-[420px]">
          <Label htmlFor="hitpay-key">{t('HitPay API key', 'HitPay API 密钥')}</Label>
          <Input id="hitpay-key" type="password" autoComplete="off" value={key}
            onChange={e => setKey(e.target.value)} variant="compact" />
          <p className="text-[12px] text-muted-foreground leading-[1.5]">
            {t('In HitPay, open Settings → Payment Gateway → API Keys, and copy the API key.',
               '在 HitPay 中打开 设置 → 支付网关 → API 密钥，复制 API 密钥。')}{' '}
            <a href={HITPAY_KEYS_URL} target="_blank" rel="noreferrer" className="underline">
              {t('Open HitPay', '打开 HitPay')}
            </a>
          </p>
          <div>
            <Button type="button" size="sm" disabled={busy || !key.trim()} onClick={connect}>
              {busy ? t('Connecting…', '连接中…') : t('Connect HitPay', '连接 HitPay')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
