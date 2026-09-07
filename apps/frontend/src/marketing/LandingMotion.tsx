/* eslint-disable react-refresh/only-export-components */
/* Landing-page motion + craft pieces. Isolated + memoised so the perpetual
   storefront ping never re-renders the page. All effects honour
   prefers-reduced-motion via `useReducedMotion`. */
import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence, useMotionValue, useSpring, useReducedMotion } from 'motion/react'
import { ReceiptText } from 'lucide-react'
import type { VerticalWord } from './verticals'

// Editorial ease — slightly springier than the app's UI ease, still calm.
const EASE = [0.16, 1, 0.3, 1] as const

// ── Scroll reveal: fade + small rise once in view ───────────────────────────
export function Reveal({
  children,
  className,
  delay = 0,
  y = 18,
}: {
  children: ReactNode
  className?: string
  delay?: number
  y?: number
}) {
  const reduced = useReducedMotion()
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: reduced ? 0 : y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.55, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  )
}

// ── Hero stagger: container reveals children in a gentle waterfall ───────────
//
// CSS, not Motion, and the headline sits out of it entirely. Both halves of that are measured.
//
// `/` is prerendered (scripts/prerender.tsx), so the hero is painted markup before a line of the
// app has run — a mobile Lighthouse trace put first contentful paint at 157ms. This stagger was a
// Motion variant tree with `initial="hidden"` at `opacity: 0`, which React re-applied as an inline
// style the moment it took the page over, and then spent the stagger's delay plus its 0.55s
// duration fading back to the paint the visitor already had. LCP landed at 999ms: 842ms of it was
// the page hiding work it had finished. A CSS keyframe cannot do that — its RESTING opacity is 1
// and the keyframe only borrows it on the way in, which is the rule at the top of `motion.tsx` and
// the same reason `.page-enter` exists.
//
// The headline gets NO entry animation, because it is the LCP element and an LCP element that
// starts transparent is an LCP time that starts when the fade does. The eyebrow above it opens at
// 50ms, so the reading order still holds; nothing else in the waterfall is the largest paint.
//
// Delays live in `index.css` on `.hero-item:nth-child(n)` and reproduce the old variant timing
// exactly (delayChildren 0.05 + staggerChildren 0.09), so ORDER IS NOW LOAD-BEARING: reorder the
// children in Landing.tsx and the waterfall reorders with them.
export function HeroStagger({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className}>{children}</div>
}

export function HeroItem({
  children,
  className,
  /** Opts this item out of the fade. Set on the item holding the LCP element — see above. */
  instant = false,
}: {
  children: ReactNode
  className?: string
  instant?: boolean
}) {
  // The class is still present when `instant`: it is what keeps :nth-child counting, and index.css
  // is what turns the animation off for it. A plain <div> would shift every later item's delay.
  return (
    <div className={`hero-item${instant ? ' hero-item--instant' : ''}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}

// ── Magnetic CTA: pulls toward the cursor via motion values (never useState) ─
const MotionLink = motion.create(Link)

export function MagneticButton({
  to,
  className,
  children,
  strength = 0.3,
  cta,
}: {
  to: string
  className?: string
  children: ReactNode
  strength?: number
  /**
   * Which CTA this is, for `cta_click` (analytics/useAnalytics.ts). Passed through to BOTH
   * branches below: the reduced-motion visitor's click must not report as an unnamed link.
   */
  cta?: string
}) {
  const reduced = useReducedMotion()
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const sx = useSpring(x, { stiffness: 150, damping: 15, mass: 0.1 })
  const sy = useSpring(y, { stiffness: 150, damping: 15, mass: 0.1 })

  if (reduced) return <Link to={to} className={className} data-cta={cta}>{children}</Link>

  return (
    <MotionLink
      to={to}
      className={className}
      data-cta={cta}
      style={{ x: sx, y: sy }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        x.set((e.clientX - (r.left + r.width / 2)) * strength)
        y.set((e.clientY - (r.top + r.height / 2)) * strength)
      }}
      onMouseLeave={() => {
        x.set(0)
        y.set(0)
      }}
    >
      {children}
    </MotionLink>
  )
}

// ── Storefront preview: the craft anchor. A mock shop card with a live order
//    ping that surfaces every few seconds. Memoised + self-contained. ────────
type TFn = (en: string, zh: string) => string

export const StorefrontPreview = memo(function StorefrontPreview({ t }: { t: TFn }) {
  const reduced = useReducedMotion()
  const [ping, setPing] = useState(false)

  useEffect(() => {
    if (reduced) return
    let hide: ReturnType<typeof setTimeout>
    const show = () => {
      setPing(true)
      hide = setTimeout(() => setPing(false), 2600)
    }
    const first = setTimeout(show, 1400)
    const loop = setInterval(show, 4600)
    return () => {
      clearTimeout(first)
      clearTimeout(hide)
      clearInterval(loop)
    }
  }, [reduced])

  const products = [
    { name: t('Pandan Kaya Cake', '班兰咖椰蛋糕'), price: '$ 38' },
    { name: t('Kuih Lapis · box of 10', '娘惹千层糕 · 10 件装'), price: '$ 18' },
  ]

  return (
    <div className="relative mx-auto w-full max-w-[360px]">
      {/* Ping toast */}
      <AnimatePresence>
        {ping && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.9 }}
            // Ease-out, not a spring: the spring this replaced (stiffness 420, damping 18) overshot and
            // wobbled, the one bounce in an app whose every other motion is a decelerating curve.
            animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.32, ease: EASE } }}
            exit={{ opacity: 0, y: -6, scale: 0.96, transition: { duration: 0.18 } }}
            className="absolute -top-3 -right-2 z-10 flex items-center gap-2 rounded-pill border border-border bg-card py-1.5 px-3 shadow-elev-2"
          >
            <ReceiptText size={14} strokeWidth={1.5} className="text-primary" aria-hidden />
            <span className="text-[12px] font-medium text-foreground">{t('New order · BT-0242', '新订单 · BT-0242')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Card */}
      <div className="rounded-2xl border-[0.5px] border-border bg-card p-5 text-left shadow-elev-3">
        {/* Shop header */}
        <div className="flex items-center gap-3 pb-4 border-b border-border">
          <span className="grid h-10 w-10 place-items-center rounded-round bg-brand-wash font-heading text-[15px] font-medium text-primary">
            NK
          </span>
          <div className="min-w-0">
            <p className="font-heading text-[15px] font-medium text-foreground leading-tight">
              {t('Nyonya Kueh by Mei', '美的娘惹糕')}
            </p>
            <p className="text-[12px] text-muted-foreground leading-tight">/s/nyonya-kueh</p>
          </div>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-success-fg">
            <span className="h-1.5 w-1.5 rounded-round bg-success-fg" aria-hidden />
            {t('Open', '营业中')}
          </span>
        </div>

        {/* Products */}
        <ul className="list-none m-0 p-0 flex flex-col divide-y divide-border">
          {products.map((p) => (
            <li key={p.name} className="flex items-center justify-between gap-3 py-3">
              <span className="text-[13.5px] text-foreground">{p.name}</span>
              <span className="font-heading text-[13.5px] font-medium text-primary shrink-0">{p.price}</span>
            </li>
          ))}
        </ul>

        {/* Order bar (static mock) */}
        <div className="mt-4 flex items-center justify-center rounded-md bg-primary py-2.5 text-[13px] font-medium text-primary-foreground">
          {t('Place order', '下单')}
        </div>
      </div>
    </div>
  )
})

// ── Rotating vertical word: the hero's "we are not food-only" signal ─────────
// Only the ACTIVE word is ever in the DOM, and that is a hard constraint, not a preference.
// scripts/prerender.tsx freezes this markup into dist/index.html for crawlers that do not run JS,
// so keeping all five words mounted — the obvious way to let the browser size the slot — would
// hand them `Sell your food bakes art clothes crafts`.
//
// That leaves the slot to be sized from the outside, and the two ways to do it are not equal:
//   · one fixed width for the widest word never moves, but leaves a permanent hole after the short
//     ones ("food" is 2.06em against "clothes" at 3.34em — ~78px of dead space at the desktop
//     size), which reads as broken spacing rather than as design;
//   · animating the width to each word keeps the line tight and slides the text that follows,
//     at the cost of a width that changes — which is why the hero splits the headline so this word
//     ends its own line and the static half can never be rewrapped by it.
// The second is what this does. Widths come from `VerticalWord.em`.
const WORD_SLACK_EM = 0.06
const WORD_INTERVAL_MS = 2600

// The rule that marks this word as the changing part of the sentence. It belongs to the SLOT, not
// to the word: the slot outlives the swap, so the rule stays put while the word above it leaves and
// the next arrives, and it widens with the slot — a blank the words drop into, rather than an
// underline that blinks out for a quarter-second between them.
//
// Painted as an ::after rather than a border-bottom, which would add its own height to the line box
// and push the rest of the headline down by 3px. Everything is in em: the h1 runs from 2rem to
// 3.5rem, and a px rule reads heavy at the small end. The 0.145em offset puts the rule 0.14em under
// the baseline — where the browser's own underline sits, measured against the h1's font.
const WORD_RULE =
  'relative after:content-[\'\'] after:pointer-events-none after:absolute after:inset-x-0 ' +
  'after:bottom-[0.145em] after:h-[0.055em] after:bg-primary/60'

export const RotatingWord = memo(function RotatingWord({
  words,
}: {
  words: readonly VerticalWord[]
}) {
  const reduced = useReducedMotion()
  const [i, setI] = useState(0)

  useEffect(() => {
    if (reduced) return
    const loop = setInterval(() => setI((n) => (n + 1) % words.length), WORD_INTERVAL_MS)
    return () => clearInterval(loop)
  }, [reduced, words.length])

  // Reduced motion gets the first word and no timer at all — not a timer whose animation is
  // suppressed. It keeps the rule, sized to the one word it will ever show: the rule says which
  // word varies, and for this reader it is the only cue that anything does.
  if (reduced) {
    return <span className={`inline-block whitespace-pre ${WORD_RULE}`}>{words[0].text}</span>
  }

  const word = words[i % words.length]

  return (
    <motion.span
      // text-left, against the hero's inherited centring: while the width animates, a centred word
      // would drift sideways inside its own slot on top of the slot's own resize. Anchoring the
      // left edge means only the tail of the line moves, which is the movement being animated.
      className={`inline-block whitespace-pre align-baseline text-left ${WORD_RULE}`}
      initial={false}
      animate={{ width: `${word.em + WORD_SLACK_EM}em` }}
      transition={{ duration: 0.5, ease: EASE }}
    >
      {/* mode="wait" keeps exactly one word mounted: it fades the old one out before the new one
          arrives, so the width animation lands while the slot is empty and nothing is seen to
          overflow it. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={word.text}
          className="inline-block whitespace-pre"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25, ease: EASE }}
        >
          {word.text}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  )
})

// ── Step clip: the "How it works" screen recording ──────────────────────────
//
// A muted, looping <video>, not a GIF. The same four seconds as GIF is 3-8MB of 8-bit palette —
// which is the format least suited to what these actually are, thin anti-aliased text on flat
// colour — against 60-190KB of h264 that the phone decodes in hardware. `<video autoplay muted
// loop playsinline>` is what "GIF" means on the web now.
//
// Three things here are deliberate:
//
// NO `autoplay` ATTRIBUTE. Playback is started by the observer below, so with `preload="none"`
// nothing but the poster is fetched until the clip is actually on screen — three autoplaying
// loops would otherwise pull ~390KB before the reader has scrolled to them, and keep three video
// decoders alive for the whole visit.
//
// THE POSTER IS FRAME ZERO of the clip it belongs to, so starting playback is not a cut. It is
// also the whole picture for a reader who never gets the video: `prefers-reduced-motion`, a
// blocked autoplay (iOS low-power mode), JavaScript off, or a crawler reading the prerendered
// markup — which is why the poster stays in the markup rather than being attached in the effect.
//
// `muted` IS SET ON THE ELEMENT, not just as a prop. React does not reliably render the `muted`
// attribute into server markup, and an unmuted video is refused autoplay outright.
export const StepClip = memo(function StepClip({
  src,
  poster,
  label,
  className,
}: {
  src: string
  poster: string
  label: string
  className?: string
}) {
  const reduced = useReducedMotion()
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || reduced) return
    el.muted = true
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) void el.play().catch(() => {})
        else el.pause()
      },
      { threshold: 0.4 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [reduced])

  return (
    <video
      ref={ref}
      poster={poster}
      aria-label={label}
      muted
      loop
      playsInline
      preload="none"
      width={960}
      height={720}
      className={className}
    >
      <source src={src} type="video/mp4" />
    </video>
  )
})
