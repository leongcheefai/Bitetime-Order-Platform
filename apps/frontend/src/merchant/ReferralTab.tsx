import { useState } from 'react'
import { Copy, QrCode } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { referralCodeOf } from '../store'
import { referralSignupUrl } from '../referralSignupUrl'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

// Display-only referral card (mirrors ShareStorefront). The code is derived from the
// signed-in user's auth id so it matches profiles.referral_code written at signup.
export default function ReferralTab() {
  const { t, account } = useSession()
  const [qrOpen, setQrOpen] = useState(false)
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
  )
}
