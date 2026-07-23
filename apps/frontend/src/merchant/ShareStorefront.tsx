import { useState } from 'react'
import { Copy, ExternalLink, QrCode } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import { useSession } from '../SessionContext'
import { updateMerchantConfig } from '../store'
import { storefrontUrl } from '../storefrontUrl'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export default function ShareStorefront() {
  const { t, merchant, refreshMerchant } = useSession()
  const [qrOpen, setQrOpen] = useState(false)
  if (!merchant) return null

  const url = storefrontUrl(merchant.slug, window.location.origin)
  const isActive = merchant.status === 'active'

  // Sharing the link — by copy, open, or QR — completes the onboarding "share your
  // order link" step (#102). Fire-and-forget and guarded to fire at most once: a
  // failed flag write must never block or fail the share the merchant asked for.
  const markShared = () => {
    if (!merchant.onboarding_link_shared) {
      updateMerchantConfig(merchant.id, { onboarding_link_shared: true })
        .then(refreshMerchant)
        .catch(() => {})
    }
  }

  const copy = async () => {
    markShared()
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('Link copied', '链接已复制'))
    } catch {
      toast.error(t('Could not copy — copy it manually', '无法复制 — 请手动复制'))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Your storefront link', '您的店铺链接')}</CardTitle>
        <CardDescription>{t('Share this link with your customers so they can order.', '把这个链接分享给顾客即可下单。')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="rounded-lg border-[1.5px] border-clay-border bg-surface-sunken px-3 py-2 font-mono text-[13px] break-all text-ink">
          {url}
        </div>
        {isActive ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="default" size="sm" className="w-auto" onClick={copy}>
              <Copy /> {t('Copy link', '复制链接')}
            </Button>
            <Button variant="outline" size="sm" className="w-auto" onClick={markShared} render={<a href={url} target="_blank" rel="noopener" />}>
              <ExternalLink /> {t('Open storefront', '打开店铺')}
            </Button>
            <Button variant="outline" size="sm" className="w-auto" onClick={() => { markShared(); setQrOpen(true) }}>
              <QrCode /> {t('QR code', '二维码')}
            </Button>
          </div>
        ) : (
          <p className="text-[13px] text-rose-muted">{t('Storefront goes live after approval.', '店铺获批后上线。')}</p>
        )}
      </CardContent>

      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Scan to open storefront', '扫码打开店铺')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="rounded-lg bg-white p-3">
              <QRCodeSVG value={url} size={180} />
            </div>
            <p className="font-mono text-[12px] break-all text-center text-rose-muted">{url}</p>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
