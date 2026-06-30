import { motion, AnimatePresence } from 'motion/react'
import { useListItemVariants } from '../motion'
import { useToastList } from '../ToastContext'
import { cn } from '@/lib/utils'

// Motion-based toast stack. AnimatePresence + motion.button structure is kept
// intact — only the CSS classes are migrated to Tailwind utilities.
// @keyframes / sonner NOT used; this is the existing custom toast system.
export default function Toaster() {
  const { toasts, dismiss } = useToastList()
  const variants = useListItemVariants()
  return (
    <div
      className="fixed left-1/2 bottom-6 -translate-x-1/2 z-toast flex flex-col gap-2 items-center pointer-events-none w-max max-w-[calc(100vw-2rem)]"
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {toasts.map(toast => (
          <motion.button
            key={toast.id}
            type="button"
            className={cn(
              // Base — all toast variants
              'pointer-events-auto cursor-pointer',
              'border rounded-pill px-[18px] py-[10px]',
              'font-sans text-[14px] font-medium text-center',
              'shadow-[0_6px_20px_rgba(43,10,16,0.14)]',
              // Default (success) appearance
              'bg-surface-raised text-ink border-clay-border',
              // Kind overrides — twMerge resolves conflicts; last matching class wins
              toast.kind === 'error' && 'bg-oxblood-tint text-oxblood border-rose-border',
              toast.kind === 'info'  && 'bg-cream text-rose-muted border-clay-border',
            )}
            variants={variants}
            initial="initial"
            animate="animate"
            exit="exit"
            layout
            onClick={() => dismiss(toast.id)}
          >
            {toast.message}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  )
}
