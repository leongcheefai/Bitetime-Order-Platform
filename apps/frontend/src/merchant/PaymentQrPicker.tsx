import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { paymentQrUrl, uploadPaymentQr, PAYMENT_QR_TYPES } from '../store'
import ConfirmDialog from '../components/ConfirmDialog'
import { Button } from '../components/ui/button'

type T = (en: string, zh: string) => string

// One payment QR per shop (#156). Uploads to Storage immediately and reports the resulting path
// via onChange; the PATH is persisted by the Payment tab's own Save, like every other field on
// that form. Sibling of ProductImages' picker, single-file and with no delete of its own: the
// tab drops the replaced object after the row that pointed at it has actually been saved, so a
// failed save can never leave a shop's row pointing at an image that is gone.
export default function PaymentQrPicker({
  merchantId,
  value,
  onChange,
  t,
}: {
  merchantId: string
  value: string
  onChange: (path: string) => void
  t: T
}) {
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    setBusy(true)
    try {
      onChange(await uploadPaymentQr(merchantId, file))
    } catch (err: any) {
      toast.error(err?.message || t('Upload failed', '上传失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex items-start gap-3">
        {value ? (
          <div className="relative size-28 shrink-0">
            <img
              src={paymentQrUrl(value)}
              alt={t('Payment QR', '付款二维码')}
              className="size-28 object-contain rounded-lg border-[0.5px] border-border bg-white p-1"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
              aria-label={t('Remove QR code', '删除二维码')}
              className="absolute -top-1.5 -right-1.5 size-6 pointer-coarse:size-8 pointer-coarse:text-[15px] rounded-pill bg-primary text-white text-[12px] leading-none flex items-center justify-center shadow-elev-1 hover:bg-brand-600 disabled:bg-disabled-bg disabled:text-disabled-fg cursor-pointer"
            >
              ×
            </button>
          </div>
        ) : (
          <Button
            type="button"
            variant="dashed"
            size="none"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="size-28 shrink-0 rounded-lg border-[0.5px] text-[11px] flex-col gap-0.5"
          >
            <span className="text-[18px] leading-none">＋</span>
            {busy ? t('Uploading…', '上传中…') : t('QR code', '二维码')}
          </Button>
        )}
        {value && (
          <Button
            type="button"
            variant="link"
            size="none"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="text-[13px]"
          >
            {busy ? t('Uploading…', '上传中…') : t('Replace', '更换')}
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={PAYMENT_QR_TYPES.join(',')}
        onChange={pick}
        className="hidden"
      />

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t('Remove the payment QR?', '删除付款二维码？')}
        body={
          <p>
            {t('Customers stop seeing a QR after they order. The image is deleted for good once you save this tab.',
               '顾客下单后将不再看到二维码。保存本页后该图片会被永久删除。')}
          </p>
        }
        confirmLabel={t('Remove QR code', '删除二维码')}
        onConfirm={() => onChange('')}
      />
    </div>
  )
}
