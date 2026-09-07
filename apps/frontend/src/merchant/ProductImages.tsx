import { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  productImageUrl,
  uploadProductImages,
  deleteProductImages,
  MAX_PRODUCT_IMAGES,
  PRODUCT_IMAGE_TYPES,
} from '../store'
import ConfirmDialog from '../components/ConfirmDialog'
import { Button } from '../components/ui/button'

type T = (en: string, zh: string) => string

// Uploads immediately to Storage and reports the resulting paths via onChange.
// Used both by the "Add a product" draft (a client-generated productId) and by
// existing products (their real id).
export default function ImagePicker({
  merchantId,
  productId,
  value,
  onChange,
  t,
}: {
  merchantId: string
  productId: string
  value: string[]
  onChange: (paths: string[]) => void | Promise<void>
  t: T
}) {
  const [busy, setBusy] = useState(false)
  // The photo a × is asking about. The delete is not undoable — the object leaves Storage — so
  // it waits for a confirm even though the thumbnail makes the target obvious.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function add(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // allow re-picking the same file
    if (!files.length) return
    if (value.length + files.length > MAX_PRODUCT_IMAGES) {
      toast.error(t(`Up to ${MAX_PRODUCT_IMAGES} images per product`, `每个产品最多 ${MAX_PRODUCT_IMAGES} 张图片`))
      return
    }
    setBusy(true)
    try {
      const paths = await uploadProductImages(merchantId, productId, files)
      await onChange([...value, ...paths])
    } catch (err: any) {
      toast.error(err?.message || t('Upload failed', '上传失败'))
    } finally {
      setBusy(false)
    }
  }

  async function remove(path: string) {
    setBusy(true)
    try {
      await onChange(value.filter(p => p !== path))
      await deleteProductImages([path]) // best-effort cleanup after the row is updated
    } catch (err: any) {
      toast.error(err?.message || t('Could not remove image', '无法删除图片'))
    } finally {
      setBusy(false)
    }
  }

  const full = value.length >= MAX_PRODUCT_IMAGES

  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex flex-wrap gap-2">
        {value.map(path => (
          <div key={path} className="relative size-16 shrink-0">
            <img
              src={productImageUrl(path)}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-16 object-cover rounded-lg border-[0.5px] border-border"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => setPendingDelete(path)}
              aria-label={t('Remove image', '删除图片')}
              className="absolute -top-1.5 -right-1.5 size-6 pointer-coarse:size-8 pointer-coarse:text-[15px] rounded-pill bg-primary text-primary-foreground text-[12px] leading-none flex items-center justify-center shadow-elev-1 hover:bg-brand-600 disabled:bg-disabled-bg disabled:text-disabled-fg cursor-pointer"
            >
              ×
            </button>
          </div>
        ))}
        {!full && (
          <Button
            type="button"
            variant="dashed"
            size="none"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="size-16 shrink-0 rounded-lg border-[0.5px] text-[11px] flex-col gap-0.5"
          >
            <span className="text-[18px] leading-none">＋</span>
            {busy ? t('…', '…') : t('Photo', '图片')}
          </Button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={PRODUCT_IMAGE_TYPES.join(',')}
        multiple
        onChange={add}
        className="hidden"
      />

      {/* Opened from inside the product form's dialog, so it needs the z-modal-popover the
          form's Select menu uses to paint above that popup. */}
      <ConfirmDialog
        className="z-modal-popover"
        open={!!pendingDelete}
        onOpenChange={o => { if (!o) setPendingDelete(null) }}
        title={t('Remove this photo?', '删除这张图片？')}
        body={
          <div className="flex items-center gap-3">
            {pendingDelete && (
              <img
                src={productImageUrl(pendingDelete)}
                alt=""
                className="size-16 shrink-0 object-cover rounded-lg border-[0.5px] border-border"
              />
            )}
            <p>{t('The photo is deleted for good. You can upload it again afterwards.', '该图片将被永久删除。之后可以重新上传。')}</p>
          </div>
        }
        confirmLabel={t('Remove photo', '删除图片')}
        onConfirm={async () => { if (pendingDelete) await remove(pendingDelete) }}
      />
    </div>
  )
}
