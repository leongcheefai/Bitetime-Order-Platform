import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMerchant } from '../MerchantContext'
import { useSession } from '../SessionContext'
import { fetchOrderTracking } from '../store'
import { courierName, trackingUrl } from '../couriers'
import { StatusBadge } from '../orderStatus'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import LanguageSelect from '../components/LanguageSelect'

type Tracking = { status: string; mode: string; courier: string | null; awb: string | null; created_at: string }

export default function TrackOrder() {
  const { merchant } = useMerchant()
  const { t } = useSession()
  const [orderNo, setOrderNo] = useState('')
  const [result, setResult] = useState<Tracking | 'notfound' | null>(null)
  const [loading, setLoading] = useState(false)

  if (!merchant) return null

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const normalized = orderNo.trim().toUpperCase()
    if (!normalized) return
    setLoading(true)
    setResult(null)
    fetchOrderTracking(merchant!.id, normalized)
      .then(r => setResult(r ?? 'notfound'))
      .catch(() => setResult('notfound'))
      .finally(() => setLoading(false))
  }

  const link = result && result !== 'notfound' ? trackingUrl(result.courier, result.awb) : null

  return (
    <div className="form-wrap pt-8 pb-12">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-8 max-[480px]:flex-col max-[480px]:gap-2">
        <div>
          <h1 className="font-heading text-[26px] font-medium text-oxblood tracking-[0.3px]">{merchant.name}</h1>
          <p className="font-heading text-[13px] italic text-rose-muted mt-[5px]">{t('Track your order', '追踪订单')}</p>
        </div>
        <div className="flex justify-end flex-shrink-0 max-[480px]:justify-start">
          <LanguageSelect />
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 mb-6">
        <label className="text-[11px] font-medium text-oxblood uppercase tracking-[0.09em]" htmlFor="track-order-no">
          {t('Order number', '订单号')}
        </label>
        <Input
          id="track-order-no"
          value={orderNo}
          onChange={e => setOrderNo(e.target.value)}
          placeholder={t('e.g. FA-260704-0053', '例如 FA-260704-0053')}
          className="font-mono"
        />
        <Button type="submit" size="none" className="self-start rounded-pill py-[8px] px-[18px] text-[14px]" disabled={loading || !orderNo.trim()}>
          {loading ? t('Checking…', '查询中…') : t('Track', '追踪')}
        </Button>
      </form>

      {result === 'notfound' && (
        <p className="text-[14px] text-rose-muted italic py-4 text-center">
          {t('No order found with that number.', '找不到该订单号。')}
        </p>
      )}

      {result && result !== 'notfound' && (
        <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-5 flex flex-col gap-3">
          <div className="flex items-center gap-[10px] flex-wrap">
            <span className="font-mono text-[15px] text-oxblood">{orderNo.trim().toUpperCase()}</span>
            <StatusBadge status={result.status || 'new'} t={t} />
          </div>
          {result.courier && (
            <div className="text-[13px] text-ink">
              <span className="text-rose-muted">{t('Courier', '快递公司')}: </span>
              {courierName(result.courier) || result.courier}
            </div>
          )}
          {result.awb ? (
            <div className="text-[13px] text-ink">
              <span className="text-rose-muted">{t('AWB', '运单号')}: </span>
              <span className="font-mono">{result.awb}</span>
            </div>
          ) : (
            <p className="text-[13px] text-rose-muted italic">
              {t('No tracking number yet — check back once your order ships.', '暂无运单号 — 订单发货后再来查看。')}
            </p>
          )}
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer"
               className="text-[14px] text-oxblood font-medium hover:underline w-fit">
              {t('Track parcel →', '查看包裹 →')}
            </a>
          )}
          {result.awb && !link && (
            <p className="text-[12px] text-rose-muted">
              {t('Search this number on your courier’s website to track.', '请到快递公司官网查询此运单号。')}
            </p>
          )}
        </div>
      )}

      <Link to={`/s/${merchant.slug}`} className="text-[13px] text-rose-muted underline mt-6 inline-block">
        {t('← Back to shop', '← 返回店铺')}
      </Link>
    </div>
  )
}
