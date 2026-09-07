import type { ReactNode } from 'react'
import { Images, Expand } from 'lucide-react'
import { productImageUrl } from '../store'
import { cn } from '@/lib/utils'

/**
 * One product, drawn the way a customer sees it.
 *
 * Extracted from `Storefront.tsx` so the merchant's Storefront tab can draw the same row while
 * dragging it (docs/superpowers/specs/2026-08-17-storefront-arrangement-design.md). The merchant is
 * judging ORDER and LAYOUT, so the layout has to be the real one — a second, similar-looking row
 * would drift from this one and quietly stop being a preview.
 *
 * Only the SHELL is shared. Everything that reads a cart lives in `meta` and `trailing`: the
 * storefront passes its promo price line and its quantity control, the arranger passes a plain
 * price and a drag handle. That is what keeps a 60-line promo computation out of a screen that
 * prices nothing.
 */
export default function MenuRow({
  imagePaths = [], onImageClick, imageLabel, title, subtitle, meta, trailing, className,
}: {
  imagePaths?: string[]
  /** Given, the thumbnail becomes a button. Omitted, it is a plain image. */
  onImageClick?: () => void
  imageLabel?: string
  title: ReactNode
  subtitle?: ReactNode
  meta?: ReactNode
  trailing?: ReactNode
  className?: string
}) {
  const first = imagePaths[0]

  return (
    <div
      className={cn(
        'flex items-center gap-[14px] px-4 py-[14px] bg-card border-[0.5px] border-border rounded-xl transition-colors',
        className,
      )}
    >
      {first ? (
        onImageClick ? (
          <button
            type="button"
            onClick={onImageClick}
            aria-label={imageLabel}
            className="group size-14 shrink-0 rounded-lg overflow-hidden border-[0.5px] border-border cursor-pointer relative transition-transform active:scale-[0.97]"
          >
            <img
              src={productImageUrl(first)}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-full object-cover transition-transform duration-200 group-hover:scale-110"
            />
            {/* Desktop cue: a veil + expand glyph on hover says "this opens". */}
            <span className="absolute inset-0 flex items-center justify-center bg-primary/0 transition-colors group-hover:bg-primary/30">
              <Expand className="size-4 text-white opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2} />
            </span>
            {/* Touch cue (no hover on a phone): a persistent photo pill, with a count
                when there's more than one. The bare number badge read as decoration —
                nothing said "tap me". */}
            <span className="absolute bottom-1 right-1 flex items-center gap-0.5 rounded-pill bg-primary/90 px-1.5 py-[3px] text-white text-[10px] font-medium leading-none">
              <Images className="size-[11px]" strokeWidth={2} />
              {imagePaths.length > 1 && imagePaths.length}
            </span>
          </button>
        ) : (
          <img
            src={productImageUrl(first)}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-14 shrink-0 rounded-lg object-cover border-[0.5px] border-border"
          />
        )
      ) : null}

      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-medium text-foreground">{title}</div>
        {subtitle ? (
          <div className="text-[12px] text-muted-foreground mt-0.5 leading-[1.4]">{subtitle}</div>
        ) : null}
        {meta}
      </div>

      {trailing}
    </div>
  )
}
