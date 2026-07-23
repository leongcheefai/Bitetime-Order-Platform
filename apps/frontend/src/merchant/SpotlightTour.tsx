import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'

// A single spotlight step: dims the whole screen except a hole around the element
// matching `targetSelector`, and floats a tooltip beside it. The parent owns the
// step index and swaps the selector + copy on Next; this component only measures
// and paints. A selector (not a ref/element) keeps the parent from reading refs
// during render — the element is resolved here, inside a layout effect.
interface Props {
  targetSelector: string
  stepLabel: string
  title: string
  body: string
  ctaLabel: string
  skipLabel: string
  onNext: () => void
  onSkip: () => void
}

const PAD = 8            // breathing room around the highlighted element
const TOOLTIP_W = 300

export default function SpotlightTour({ targetSelector, stepLabel, title, body, ctaLabel, skipLabel, onNext, onSkip }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null)

  useLayoutEffect(() => {
    const target = document.querySelector(targetSelector) as HTMLElement | null
    if (!target) return
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const measure = () => setRect(target.getBoundingClientRect())
    // First measure is deferred to the next frame (not called synchronously in the
    // effect body), and re-run after the smooth scroll settles and on viewport moves.
    const raf = requestAnimationFrame(measure)
    const settle = window.setTimeout(measure, 320)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(settle)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [targetSelector])

  if (!rect) return null

  // Place the tooltip below the target when there's room, else above it.
  const placeBelow = window.innerHeight - rect.bottom > 220
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - TOOLTIP_W - 12))

  return createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label={title}>
      {/* Transparent box with a massive shadow: dims everything but the target. */}
      <div
        className="pointer-events-none absolute rounded-xl ring-2 ring-oxblood transition-all duration-200"
        style={{
          top: rect.top - PAD,
          left: rect.left - PAD,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
          boxShadow: '0 0 0 9999px rgba(43,20,20,0.62)',
        }}
      />
      <div
        className="absolute rounded-2xl border-[1.5px] border-rose-border bg-surface-raised p-4 shadow-xl"
        style={{
          width: TOOLTIP_W,
          left,
          ...(placeBelow
            ? { top: rect.bottom + 12 }
            : { bottom: window.innerHeight - rect.top + 12 }),
        }}
      >
        <p className="text-[11px] font-medium uppercase tracking-[0.09em] text-oxblood">{stepLabel}</p>
        <h4 className="mt-1 font-heading text-[15px] font-medium text-oxblood">{title}</h4>
        <p className="mt-1 text-[13px] leading-[1.5] text-ink">{body}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="text-[13px] text-rose-muted underline underline-offset-2 hover:text-oxblood"
          >
            {skipLabel}
          </button>
          <Button size="sm" className="w-auto" onClick={onNext}>{ctaLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
