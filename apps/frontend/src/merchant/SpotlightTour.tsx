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
    let alive = true
    let raf = 0
    let settle = 0
    let tries = 0
    let target: HTMLElement | null = null
    let pending = 0
    // One measurement per frame, however many scroll events arrive in it. The listener below
    // is capture-phase, so it fires for every scrolling container on the page; measuring
    // synchronously in each event forced a layout per event and, with the scroll listener
    // non-passive, made the browser wait on it before it could scroll at all.
    const measure = () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = 0
        if (alive && target) setRect(target.getBoundingClientRect())
      })
    }
    // The target may not be mounted yet — a step navigates to another section and its
    // control mounts a frame or two later. Poll on animation frames until it appears
    // (~1.5s cap), then measure and track it. measure() runs inside the rAF callback,
    // never synchronously in the effect body, so it doesn't trip the cascading-render rule.
    const find = () => {
      if (!alive) return
      target = document.querySelector(targetSelector) as HTMLElement | null
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' })
        measure()
        settle = window.setTimeout(measure, 320)   // re-measure once the smooth scroll settles
        window.addEventListener('resize', measure, { passive: true })
        window.addEventListener('scroll', measure, { capture: true, passive: true })
        return
      }
      if (tries++ < 90) raf = requestAnimationFrame(find)
    }
    raf = requestAnimationFrame(find)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      cancelAnimationFrame(pending)
      window.clearTimeout(settle)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, { capture: true })
    }
  }, [targetSelector])

  if (!rect) return null

  // Place the tooltip below the target when there's room, else above it.
  const placeBelow = window.innerHeight - rect.bottom > 220
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - TOOLTIP_W - 12))

  return createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label={title}>
      {/* Transparent box with a massive shadow: dims everything but the target. Positioned by
          `transform`, not top/left, and transitioning only what moves between steps: the old
          `transition-all` on four layout properties repainted a 9999px shadow every frame of a
          smooth scroll. The scrim is `--ink-900` at 62%, the same ink the dialog scrim uses. */}
      <div
        className="pointer-events-none absolute top-0 left-0 rounded-xl ring-2 ring-primary transition-[transform,width,height] duration-200"
        style={{
          transform: `translate(${rect.left - PAD}px, ${rect.top - PAD}px)`,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
          boxShadow: '0 0 0 9999px rgba(24,24,27,0.62)',
        }}
      />
      <div
        className="absolute rounded-2xl border-[0.5px] border-border bg-card p-4 shadow-xl"
        style={{
          width: TOOLTIP_W,
          left,
          ...(placeBelow
            ? { top: rect.bottom + 12 }
            : { bottom: window.innerHeight - rect.top + 12 }),
        }}
      >
        <p className="text-[11px] font-medium uppercase tracking-[0.09em] text-primary">{stepLabel}</p>
        <h4 className="mt-1 font-heading text-[15px] font-medium text-primary">{title}</h4>
        <p className="mt-1 text-[13px] leading-[1.5] text-foreground">{body}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="link"
            size="none"
            onClick={onSkip}
            className="text-[13px] text-muted-foreground hover:text-primary"
          >
            {skipLabel}
          </Button>
          <Button size="sm" className="w-auto" onClick={onNext}>{ctaLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
