import { motion, AnimatePresence } from 'motion/react'
import { useListItemVariants } from '../motion'
import { useToastList } from '../ToastContext'

export default function Toaster() {
  const { toasts, dismiss } = useToastList()
  const variants = useListItemVariants()
  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      <AnimatePresence initial={false}>
        {toasts.map(toast => (
          <motion.button
            key={toast.id}
            type="button"
            className={`toast toast--${toast.kind}`}
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
