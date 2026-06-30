import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

// Shimmer skeleton block. Width, height, and border-radius are dynamic so they
// are passed as CSS custom properties; the actual animation classes are Tailwind.
// @keyframes shimmer lives in index.css (shared — keeps the keyframe file-local).
export function Skeleton({ width = '100%', height = '1rem', radius = 'var(--radius-sm)', className = '' }:
  { width?: string; height?: string; radius?: string; className?: string }) {
  return (
    <span
      className={cn(
        'block',
        'bg-[linear-gradient(90deg,var(--color-cream)_25%,var(--color-surface-raised)_50%,var(--color-cream)_75%)]',
        'bg-[length:936px_100%]',
        'animate-[shimmer_1.4s_linear_infinite]',
        // Dynamic sizing via CSS custom properties set in inline style below
        'w-[var(--sk-w,100%)] h-[var(--sk-h,1rem)] rounded-[var(--sk-r,var(--radius-sm))]',
        className,
      )}
      style={{ '--sk-w': width, '--sk-h': height, '--sk-r': radius } as CSSProperties}
      aria-hidden="true"
    />
  )
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height="0.85rem" width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </span>
  )
}

// Full-page placeholder shaped like the merchant dashboard (title + tab row +
// content) so a guarded/resolving page fills the viewport instead of showing a
// lonely spinner.
// NOTE: form-wrap, form-wrap--wide, admin-panel are shared classes — kept in index.css.
export function PageSkeleton() {
  return (
    <div className="form-wrap form-wrap--wide flex flex-col gap-[18px] pt-2" aria-hidden="true">
      <div className="flex flex-col gap-[10px]">
        <Skeleton width="44%" height="1.9rem" />
        <Skeleton width="26%" height="0.85rem" />
      </div>
      <div className="flex gap-[10px] flex-wrap">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} width="84px" height="2.1rem" radius="var(--radius-pill)" />
        ))}
      </div>
      <div className="admin-panel mt-1">
        <SkeletonText lines={5} />
      </div>
    </div>
  )
}

// @keyframes spin lives in index.css (shared with Tailwind arbitrary animation).
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-[10px] text-rose-muted text-[14px]" role="status">
      <span
        className="w-[18px] h-[18px] rounded-full border-2 border-clay-border border-t-oxblood animate-[spin_0.7s_linear_infinite]"
        aria-hidden="true"
      />
      {label && <span className="font-sans">{label}</span>}
    </span>
  )
}
