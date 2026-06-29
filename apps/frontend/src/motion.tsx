/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { Variants } from 'motion/react'

// Subtle motion tokens — match the existing CSS feel (0.15s, cubic-bezier(0.4,0,0.2,1)).
export const DUR = { fast: 0.15, base: 0.22, slow: 0.28 } as const
export const EASE = [0.4, 0, 0.2, 1] as const

// True when motion is allowed; false under prefers-reduced-motion.
export function useMotionSafe(): boolean {
  return !useReducedMotion()
}

// Page/route transition: fade + small upward slide. Distance is 0 when reduced.
export function usePageVariants(): Variants {
  const safe = useMotionSafe()
  const d = safe ? 8 : 0
  return {
    initial: { opacity: 0, y: d },
    animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE } },
    exit: { opacity: 0, y: -d, transition: { duration: DUR.fast, ease: EASE } },
  }
}

// Backdrop / overlay: opacity only.
export function useOverlayVariants(): Variants {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: DUR.fast, ease: EASE } },
    exit: { opacity: 0, transition: { duration: DUR.fast, ease: EASE } },
  }
}

// Floating panel / dropdown: small y + opacity.
export function usePanelVariants(): Variants {
  const safe = useMotionSafe()
  const d = safe ? 6 : 0
  return {
    initial: { opacity: 0, y: -d },
    animate: { opacity: 1, y: 0, transition: { duration: DUR.fast, ease: EASE } },
    exit: { opacity: 0, y: -d, transition: { duration: DUR.fast, ease: EASE } },
  }
}

// List item (toasts, future list enter/exit).
export function useListItemVariants(): Variants {
  const safe = useMotionSafe()
  const d = safe ? 10 : 0
  return {
    initial: { opacity: 0, y: d },
    animate: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE } },
    exit: { opacity: 0, y: d, transition: { duration: DUR.fast, ease: EASE } },
  }
}

// Wraps a route element so it fades/slides on mount and unmount.
export function PageTransition({ children }: { children: ReactNode }) {
  const variants = usePageVariants()
  return (
    <motion.div variants={variants} initial="initial" animate="animate" exit="exit">
      {children}
    </motion.div>
  )
}
