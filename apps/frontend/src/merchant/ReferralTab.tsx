import { useEffect, useState } from 'react'
import { Copy, QrCode } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { referralCodeOf, fetchReferredShops, fetchEarnedRewards } from '../store'
import { referralSignupUrl } from '../referralSignupUrl'
import { currencyDef, formatMoney } from '../currency'
import type { EarnedReward, ReferredShop } from '../types'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Display-only referral card (mirrors ShareStorefront). The code is derived from the
// signed-in user's auth id so it matches profiles.referral_code written at signup.
export default function ReferralTab() {
  const { t, account } = useSession()
  const [qrOpen, setQrOpen] = useState(false)
  const [shops, setShops] = useState<ReferredShop[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [rewards, setRewards] = useState<EarnedReward[] | null>(null)
  const [rewardsError, setRewardsError] = useState(false)

  useEffect(() => {
    let alive = true
    fetchReferredShops()
      .then((rows) => { if (alive) setShops(rows) })
      .catch(() => { if (alive) setLoadError(true) })
    fetchEarnedRewards()
      .then((rows) => { if (alive) setRewards(rows) })
      .catch(() => { if (alive) setRewardsError(true) })
    return () => { alive = false }
  }, [])

  if (!account) return null

  const code = referralCodeOf(account.id)
  if (!code) return null
  const link = referralSignupUrl(code, window.location.origin)

  const copyText = async (text: string, ok: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(ok)
    } catch {
      toast.error(t('Could not copy — copy it manually', '无法复制 — 请手动复制'))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('Invite & earn', '邀请赚奖励')}</CardTitle>
          <CardDescription>
            {t('Share your referral code with other shop owners.', '把您的推荐码分享给其他店主。')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-rose-muted">{t('Your referral code', '您的推荐码')}</span>
            <div className="rounded-lg border-[1.5px] border-clay-border bg-surface-sunken px-3 py-2 font-mono text-[15px] tracking-wider break-all text-ink">
              {code}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] text-rose-muted">{t('Invite link', '邀请链接')}</span>
            <div className="rounded-lg border-[1.5px] border-clay-border bg-surface-sunken px-3 py-2 font-mono text-[13px] break-all text-ink">
              {link}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="default" size="sm" className="w-auto" onClick={() => copyText(code, t('Code copied', '推荐码已复制'))}>
              <Copy /> {t('Copy code', '复制推荐码')}
            </Button>
            <Button variant="outline" size="sm" className="w-auto" onClick={() => copyText(link, t('Link copied', '链接已复制'))}>
              <Copy /> {t('Copy link', '复制链接')}
            </Button>
            <Button variant="outline" size="sm" className="w-auto" onClick={() => setQrOpen(true)}>
              <QrCode /> {t('QR code', '二维码')}
            </Button>
          </div>
        </CardContent>

        <Dialog open={qrOpen} onOpenChange={setQrOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('Scan to sign up', '扫码注册')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="rounded-lg bg-white p-3">
                <QRCodeSVG value={link} size={180} />
              </div>
              <p className="font-mono text-[12px] break-all text-center text-rose-muted">{link}</p>
            </div>
          </DialogContent>
        </Dialog>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {t('Rewards earned', '已获得奖励')}{rewards ? ` (${rewards.length})` : ''}
          </CardTitle>
          <CardDescription>
            {t('One free month each time an invited shop starts paying.', '每有一家受邀店铺开始付费，即获得一个月免费。')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rewardsError ? (
            <p className="text-[13px] text-rose-muted">{t('Could not load rewards.', '无法加载奖励。')}</p>
          ) : rewards === null ? (
            <p className="text-[13px] text-rose-muted">{t('Loading…', '加载中…')}</p>
          ) : rewards.length === 0 ? (
            <p className="text-[13px] text-rose-muted">{t('No rewards yet — you earn one when an invited shop starts paying.', '还没有奖励 — 当受邀店铺开始付费时即可获得。')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-clay-border">
              {rewards.map((r, i) => (
                <li key={i} className="flex items-center justify-between py-2">
                  <div className="flex flex-col">
                    <span className="text-[14px] text-ink">{r.referred_shop_name}</span>
                    <span className="text-[12px] text-rose-muted">{new Date(r.created_at).toLocaleDateString()}</span>
                  </div>
                  <span className="text-[13px] font-medium text-oxblood">
                    {t('1 month free', '免费1个月')} · {formatRewardAmount(r)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {t('Invited shops', '已邀请店铺')}{shops ? ` (${shops.length})` : ''}
          </CardTitle>
          <CardDescription>
            {t('Shops that signed up with your code.', '使用您推荐码注册的店铺。')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="text-[13px] text-rose-muted">{t('Could not load invited shops.', '无法加载已邀请店铺。')}</p>
          ) : shops === null ? (
            <p className="text-[13px] text-rose-muted">{t('Loading…', '加载中…')}</p>
          ) : shops.length === 0 ? (
            <p className="text-[13px] text-rose-muted">{t('No invited shops yet.', '还没有已邀请的店铺。')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-clay-border">
              {shops.map((s, i) => (
                <li key={i} className="flex items-center justify-between py-2">
                  <div className="flex flex-col">
                    <span className="text-[14px] text-ink">{s.name}</span>
                    <span className="text-[12px] text-rose-muted">{new Date(s.created_at).toLocaleDateString()}</span>
                  </div>
                  <StatusBadge status={s.status} t={t} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// The reward `amount` is Stripe's smallest currency unit (cents); its `currency` is Stripe's
// lowercase code. Convert to major units by the currency's own decimals, then render through
// the shared money formatter (uppercased to match the currency registry's keys).
function formatRewardAmount(r: EarnedReward): string {
  const code = r.currency.toUpperCase()
  const major = r.amount / 10 ** currencyDef(code).decimals
  return formatMoney(major, code)
}

function StatusBadge({ status, t }: { status: ReferredShop['status']; t: (en: string, zh?: string) => string }) {
  const label = status === 'active' ? t('Active', '营业中')
    : status === 'suspended' ? t('Suspended', '已暂停')
    : t('Pending', '待审核')
  const tone = status === 'active' ? 'text-oxblood' : 'text-rose-muted'
  return (
    <span className={`rounded-full border-[1.5px] border-clay-border bg-surface-sunken px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {label}
    </span>
  )
}
