// The support panel: FAQ → answer, the chat, and the feedback form, as views of one card.
import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, MessageCircle, MessageSquarePlus, X } from 'lucide-react'
import { useSession } from '../SessionContext'
import { Button } from '../components/ui/button'
import SupportLinks from './SupportLinks'
import SupportChat from './SupportChat'
import FeedbackForm from './FeedbackForm'
import { SUPPORT_FAQ, type Bilingual, type FaqGroup, type FaqItem } from './supportFaq'
import type { useSupportFeed } from './useSupportFeed'
import { cn } from '@/lib/utils'

type View =
  | { kind: 'home' }
  | { kind: 'group'; group: FaqGroup }
  | { kind: 'answer'; group: FaqGroup; item: FaqItem }
  | { kind: 'chat' }
  | { kind: 'feedback' }

interface Props {
  merchantId: string
  feed: ReturnType<typeof useSupportFeed>
  onClose: () => void
  /** Absent on the pending and suspended screens, which have no dashboard sections to open. */
  onNavigate?: (section: string, sub?: string) => void
}

export default function SupportPanel({ merchantId, feed, onClose, onNavigate }: Props) {
  const { t } = useSession()
  const [view, setView] = useState<View>({ kind: 'home' })
  const T = (b: Bilingual) => t(b.en, b.zh)

  // Esc closes, like the dialog this replaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // In the chat view, every reply counts as read — including one that arrives while it is open.
  const { unread, markRead } = feed
  useEffect(() => {
    if (view.kind === 'chat' && unread > 0) markRead()
  }, [view.kind, unread, markRead])

  const back = () => setView(view.kind === 'answer' ? { kind: 'group', group: view.group } : { kind: 'home' })
  const talk = () => setView({ kind: 'chat' })

  const title =
    view.kind === 'chat' ? t('TinyOrder team', 'TinyOrder 团队')
    : view.kind === 'feedback' ? t('Send feedback', '发送反馈')
    : view.kind === 'group' || view.kind === 'answer' ? T(view.group.title)
    : t('Help', '帮助')

  const row = 'flex w-full items-center justify-between gap-2 rounded-md px-3 py-2.5 text-left text-[14px] hover:bg-muted cursor-pointer'

  return (
    // On a phone the panel is a full-screen sheet, and the shell's mobile top bar (z-sticky, 90)
    // would sit over its header — hiding Back and Close. So below `sm` it rises to z-modal (300),
    // still under the Select popover (z-modal-popover, 400) that the feedback form opens.
    <div
      role="dialog"
      aria-label={t('Help', '帮助')}
      className={cn(
        'fixed z-notif-panel flex flex-col overflow-hidden bg-background shadow-elev-3',
        'right-6 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] h-[560px] max-h-[calc(100dvh-3rem)] w-[380px] rounded-lg border border-border',
        'max-sm:z-modal max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:rounded-none max-sm:border-0',
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        {view.kind !== 'home' && (
          <button type="button" onClick={back} aria-label={t('Back', '返回')} className="p-1 cursor-pointer">
            <ArrowLeft size={18} />
          </button>
        )}
        <h2 className="flex-1 text-[15px] font-medium">{title}</h2>
        <button type="button" onClick={onClose} aria-label={t('Close', '关闭')} className="p-1 cursor-pointer">
          <X size={18} />
        </button>
      </header>

      {view.kind === 'home' && (
        <div className="flex-1 overflow-y-auto p-3">
          {feed.messages.length > 0 && (
            <button type="button" className={cn(row, 'mb-2 bg-muted')} onClick={talk}>
              {t('Continue your conversation', '继续对话')}
              {feed.unread > 0 && <span className="rounded-pill bg-danger-100 px-2 text-[11px] font-medium text-danger-fg">{feed.unread}</span>}
            </button>
          )}
          <p className="px-3 pb-2 text-[13px] text-muted-foreground">{t('Hi! How can we help?', '你好！需要什么帮助？')}</p>
          {SUPPORT_FAQ.map(g => (
            <button key={g.id} type="button" className={row} onClick={() => setView({ kind: 'group', group: g })}>
              {T(g.title)} <ChevronRight size={16} />
            </button>
          ))}
          <div className="mt-3 border-t border-border pt-3">
            <button type="button" className={row} onClick={talk}>
              <span className="flex items-center gap-2"><MessageCircle size={16} />{t('Talk to a person', '联系客服')}</span>
            </button>
            <button type="button" className={row} onClick={() => setView({ kind: 'feedback' })}>
              <span className="flex items-center gap-2"><MessageSquarePlus size={16} />{t('Send feedback', '发送反馈')}</span>
            </button>
          </div>
        </div>
      )}

      {view.kind === 'group' && (
        <div className="flex-1 overflow-y-auto p-3">
          {view.group.items.map(item => (
            <button
              key={item.id}
              type="button"
              className={row}
              onClick={() => setView({ kind: 'answer', group: view.group, item })}
            >
              {T(item.q)} <ChevronRight size={16} className="shrink-0" />
            </button>
          ))}
        </div>
      )}

      {view.kind === 'answer' && (
        <div className="flex-1 overflow-y-auto p-4">
          <h3 className="mb-2 text-[15px] font-medium">{T(view.item.q)}</h3>
          <p className="whitespace-pre-line text-[14px] text-foreground">{T(view.item.a)}</p>
          {view.item.link && onNavigate && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => { onNavigate(view.item.link!.section, view.item.link!.sub); onClose() }}
            >
              {T(view.item.link.label)}
            </Button>
          )}
          <div className="mt-6 border-t border-border pt-4">
            <p className="mb-2 text-[13px] text-muted-foreground">{t('Did this help?', '这个回答有帮助吗？')}</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setView({ kind: 'home' })}>{t('Yes', '有')}</Button>
              <Button type="button" size="sm" onClick={talk}>{t('Talk to a person', '联系客服')}</Button>
            </div>
          </div>
        </div>
      )}

      {view.kind === 'chat' && (
        feed.available ? (
          <SupportChat
            merchantId={merchantId}
            messages={feed.messages}
            outbox={feed.outbox}
            notAlerted={feed.notAlerted}
            imagesFailed={feed.imagesFailed}
            onSend={feed.send}
            onRetry={(id) => void feed.retry(id)}
            onDiscard={feed.discard}
          />
        ) : (
          <div className="flex-1 p-4">
            <p className="mb-3 text-[14px]">{t('Chat is not available right now. Contact us here:', '目前无法使用聊天。请通过以下方式联系我们：')}</p>
            <SupportLinks />
          </div>
        )
      )}

      {view.kind === 'feedback' && (
        <div className="flex-1 overflow-y-auto p-4">
          <FeedbackForm onDone={() => setView({ kind: 'home' })} />
        </div>
      )}
    </div>
  )
}
