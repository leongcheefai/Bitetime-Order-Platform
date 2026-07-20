import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import Wordmark from './Wordmark'

// Top-level catch-all. Without a boundary above `createRoot`, any uncaught throw
// during render unmounts the whole tree to a blank #root — recoverable only by a
// manual reload (the "blank first load, hard refresh fixes it" report). This turns
// that silent blank into a visible recovery panel AND logs the real error + the
// component stack, so the underlying throw finally surfaces instead of vanishing.
//
// Deliberately self-contained: no SessionContext / i18n / router imports. The
// context that threw might be exactly what a boundary is here to survive, so copy
// is static-bilingual and recovery is a full document reload, not a router action.

interface Props { children: ReactNode }
interface State { hasError: boolean }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Tagged so it is greppable in prod consoles / log drains.
    console.error('[app-error-boundary] uncaught render error:', error, info.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="min-h-screen w-full flex items-center justify-center p-6">
        <div className="bg-surface-raised border-[1.5px] border-rose-border rounded-2xl p-6 max-w-[420px] w-full box-border text-center">
          <h1><Wordmark className="h-7 mx-auto" /></h1>
          <p className="text-rose-muted text-[14px] leading-[1.6] mt-3">
            Something went wrong loading the page.
            <br />
            <span className="text-rose-muted/80">页面加载出错了。</span>
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center justify-center rounded-full bg-oxblood text-cream text-[14px] font-medium px-5 py-2.5 hover:opacity-90 transition-opacity"
          >
            Reload · 重新加载
          </button>
        </div>
      </div>
    )
  }
}
