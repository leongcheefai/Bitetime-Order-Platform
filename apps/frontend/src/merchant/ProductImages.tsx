import { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  productImageUrl,
  uploadProductImages,
  deleteProductImages,
  MAX_PRODUCT_IMAGES,
  PRODUCT_IMAGE_TYPES,
} from '../store'

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
              className="size-16 object-cover rounded-lg border-[1.5px] border-clay-border"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => remove(path)}
              aria-label={t('Remove image', '删除图片')}
              className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-oxblood text-white text-[12px] leading-none flex items-center justify-center shadow-sm hover:bg-oxblood/90 disabled:opacity-50 cursor-pointer"
            >
              ×
            </button>
          </div>
        ))}
        {!full && (
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="size-16 shrink-0 rounded-lg border-[1.5px] border-dashed border-clay-border text-rose-muted text-[11px] flex flex-col items-center justify-center gap-0.5 hover:border-oxblood hover:text-oxblood disabled:opacity-50 cursor-pointer"
          >
            <span className="text-[18px] leading-none">＋</span>
            {busy ? t('…', '…') : t('Photo', '图片')}
          </button>
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
    </div>
  )
}
