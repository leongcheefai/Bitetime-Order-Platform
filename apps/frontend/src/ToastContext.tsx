/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type ToastKind = 'success' | 'error' | 'info'
export interface Toast { id: number; kind: ToastKind; message: string }

interface ToastApi {
  success(msg: string): void
  error(msg: string): void
  info(msg: string): void
}

const NOOP: ToastApi = { success: () => {}, error: () => {}, info: () => {} }

const ToastApiContext = createContext<ToastApi>(NOOP)
const ToastListContext = createContext<{ toasts: Toast[]; dismiss(id: number): void }>({ toasts: [], dismiss: () => {} })

const AUTO_DISMISS_MS = 4000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts(list => list.filter(t => t.id !== id))
  }, [])

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++
    setToasts(list => [...list, { id, kind, message }])
    setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
  }, [dismiss])

  const api = useMemo<ToastApi>(() => ({
    success: m => push('success', m),
    error: m => push('error', m),
    info: m => push('info', m),
  }), [push])

  const list = useMemo(() => ({ toasts, dismiss }), [toasts, dismiss])

  return (
    <ToastApiContext.Provider value={api}>
      <ToastListContext.Provider value={list}>
        {children}
      </ToastListContext.Provider>
    </ToastApiContext.Provider>
  )
}

export function useToast(): ToastApi {
  return useContext(ToastApiContext)
}

export function useToastList() {
  return useContext(ToastListContext)
}
