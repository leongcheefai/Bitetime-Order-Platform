/* eslint-disable react-refresh/only-export-components */
/* Landing-page motion + craft pieces. Isolated + memoised so the perpetual
   storefront ping never re-renders the page. All effects honour
   prefers-reduced-motion via `useReducedMotion`. */
import { memo, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence, useMotionValue, useSpring, useReducedMotion } from 'motion/react'
import { ReceiptText } from 'lucide-react'

// Editorial ease — slightly springier than the app's UI ease, still calm.
const EASE = [0.16, 1, 0.3, 1] as const

// ── Paper grain: fixed, pointer-events-none, painted once (perf guardrail) ──
const GRAIN = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'>" +
    "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter>" +
    "<rect width='100%' height='100%' filter='url(#n)'/></svg>"
)

export function GrainOverlay() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 opacity-[0.035] mix-blend-multiply max-[600px]:opacity-[0.025]"
      style={{ backgroundImage: `url("data:image/svg+xml,${GRAIN}")` }}
    />
  )
}

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
export const heroContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } },
}

export function useHeroItem() {
  const reduced = useReducedMotion()
  return {
    hidden: { opacity: 0, y: reduced ? 0 : 14 },
    show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE } },
  }
}

export function HeroStagger({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={heroContainer} initial="hidden" animate="show">
      {children}
    </motion.div>
  )
}

export function HeroItem({ children, className }: { children: ReactNode; className?: string }) {
  const item = useHeroItem()
  return (
    <motion.div className={className} variants={item}>
      {children}
    </motion.div>
  )
}

// ── Magnetic CTA: pulls toward the cursor via motion values (never useState) ─
const MotionLink = motion.create(Link)

export function MagneticButton({
  to,
  className,
  children,
  strength = 0.3,
}: {
  to: string
  className?: string
  children: ReactNode
  strength?: number
}) {
  const reduced = useReducedMotion()
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const sx = useSpring(x, { stiffness: 150, damping: 15, mass: 0.1 })
  const sy = useSpring(y, { stiffness: 150, damping: 15, mass: 0.1 })

  if (reduced) return <Link to={to} className={className}>{children}</Link>

  return (
    <MotionLink
      to={to}
      className={className}
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
    { name: t('Pandan Kaya Cake', '班兰咖椰蛋糕'), price: 'RM 38' },
    { name: t('Kuih Lapis · box of 10', '娘惹千层糕 · 10 件装'), price: 'RM 18' },
  ]

  return (
    <div className="relative mx-auto w-full max-w-[360px]">
      {/* Ping toast */}
      <AnimatePresence>
        {ping && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 420, damping: 18 } }}
            exit={{ opacity: 0, y: -6, scale: 0.96, transition: { duration: 0.18 } }}
            className="absolute -top-3 -right-2 z-10 flex items-center gap-2 rounded-pill border border-clay-border bg-surface-high py-1.5 px-3 shadow-[0_8px_24px_rgba(43,10,16,0.14)]"
          >
            <ReceiptText size={14} strokeWidth={1.5} className="text-oxblood" aria-hidden />
            <span className="text-[12px] font-medium text-ink">{t('New order · BT-0242', '新订单 · BT-0242')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Card */}
      <div className="rounded-2xl border-[1.5px] border-clay-border bg-surface-raised p-5 text-left shadow-[0_16px_40px_-18px_rgba(43,10,16,0.22)]">
        {/* Shop header */}
        <div className="flex items-center gap-3 pb-4 border-b border-divider">
          <span className="grid h-10 w-10 place-items-center rounded-round bg-oxblood-tint font-heading text-[15px] font-medium text-oxblood">
            NK
          </span>
          <div className="min-w-0">
            <p className="font-heading text-[15px] font-medium text-ink leading-tight">
              {t('Nyonya Kueh by Mei', '美的娘惹糕')}
            </p>
            <p className="text-[12px] text-rose-muted leading-tight">/s/nyonya-kueh</p>
          </div>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-success-strong">
            <span className="h-1.5 w-1.5 rounded-round bg-success-strong" aria-hidden />
            {t('Open', '营业中')}
          </span>
        </div>

        {/* Products */}
        <ul className="list-none m-0 p-0 flex flex-col divide-y divide-divider">
          {products.map((p) => (
            <li key={p.name} className="flex items-center justify-between gap-3 py-3">
              <span className="text-[13.5px] text-ink">{p.name}</span>
              <span className="font-heading text-[13.5px] font-medium text-oxblood shrink-0">{p.price}</span>
            </li>
          ))}
        </ul>

        {/* Order bar (static mock) */}
        <div className="mt-4 flex items-center justify-center rounded-md bg-oxblood py-2.5 text-[13px] font-medium text-cream">
          {t('Place order', '下单')}
        </div>
      </div>
    </div>
  )
})
