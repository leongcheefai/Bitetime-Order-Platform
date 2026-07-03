import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { productImageUrl } from '../store'
import { cn } from '@/lib/utils'

type T = (en: string, zh: string) => string

// Gallery lightbox for a product's images. `paths` are Storage paths.
export default function ImageLightbox({
  paths,
  open,
  onOpenChange,
  title,
  t,
}: {
  paths: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  t: T
}) {
  const [i, setI] = useState(0)
  if (!paths.length) return null
  const idx = Math.min(i, paths.length - 1)
  const prev = () => setI(v => (v - 1 + paths.length) % paths.length)
  const next = () => setI(v => (v + 1) % paths.length)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle className="sr-only">{title || t('Product photos', '产品图片')}</DialogTitle>
        <div className="flex flex-col gap-3">
          <div className="relative flex items-center justify-center bg-cream rounded-lg overflow-hidden">
            <img
              src={productImageUrl(paths[idx])}
              alt={title ? `${title} ${idx + 1}` : `${idx + 1}`}
              className="max-h-[60vh] w-full object-contain"
            />
            {paths.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={prev}
                  aria-label={t('Previous', '上一张')}
                  className="absolute left-2 top-1/2 -translate-y-1/2 size-9 rounded-full bg-surface-high/90 text-oxblood text-[18px] flex items-center justify-center shadow-sm hover:bg-surface-high cursor-pointer"
                >‹</button>
                <button
                  type="button"
                  onClick={next}
                  aria-label={t('Next', '下一张')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 size-9 rounded-full bg-surface-high/90 text-oxblood text-[18px] flex items-center justify-center shadow-sm hover:bg-surface-high cursor-pointer"
                >›</button>
              </>
            )}
          </div>
          {paths.length > 1 && (
            <div className="flex gap-2 flex-wrap">
              {paths.map((p, n) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setI(n)}
                  aria-label={t('View image', '查看图片') + ` ${n + 1}`}
                  className={cn(
                    'size-12 shrink-0 rounded-md overflow-hidden border-[1.5px] cursor-pointer',
                    n === idx ? 'border-oxblood' : 'border-clay-border opacity-70 hover:opacity-100',
                  )}
                >
                  <img src={productImageUrl(p)} alt="" className="size-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
