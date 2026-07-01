import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { useSession } from '../SessionContext'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../components/ui/dialog'
import { Button } from '../components/ui/button'

// Generic unsaved-changes guard, scoped to the merchant Dashboard (issue #19).
// A section (currently only Settings) registers a "blocker" predicate reporting
// whether it holds unsaved edits. Any code that wants to navigate away calls
// `guard(proceed)`; if the blocker reports dirty, a Cancel / Discard confirm is
// raised and `proceed` runs only on Discard. Kept decoupled so the Dashboard need
// not know a section's internals — it just wraps `setSection` in `guard`.

interface NavGuardValue {
  /** Register the active section's dirty predicate; pass null to clear. */
  registerBlocker: (fn: (() => boolean) | null) => void
  /** Attempt a navigation. Runs `proceed` immediately if clean, else confirms first. */
  guard: (proceed: () => void) => void
}

const Ctx = createContext<NavGuardValue | null>(null)

export function useNavGuard(): NavGuardValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useNavGuard must be used within NavGuardProvider')
  return v
}

export function NavGuardProvider({ children }: { children: ReactNode }) {
  const { t } = useSession()
  const blockerRef = useRef<(() => boolean) | null>(null)
  const [pending, setPending] = useState<{ run: () => void } | null>(null)

  const registerBlocker = useCallback((fn: (() => boolean) | null) => {
    blockerRef.current = fn
  }, [])

  const guard = useCallback((proceed: () => void) => {
    if (blockerRef.current?.()) setPending({ run: proceed })
    else proceed()
  }, [])

  const cancel = () => setPending(null)
  const discard = () => {
    const p = pending
    setPending(null)
    p?.run()
  }

  return (
    <Ctx.Provider value={{ registerBlocker, guard }}>
      {children}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) cancel() }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('Unsaved changes', '未保存的更改')}</DialogTitle>
            <DialogDescription>
              {t(
                'You have unsaved changes on this tab. Leave without saving?',
                '此标签页有未保存的更改。要放弃并离开吗？',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={cancel}>
              {t('Cancel', '取消')}
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={discard}>
              {t('Discard changes', '放弃更改')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Ctx.Provider>
  )
}
