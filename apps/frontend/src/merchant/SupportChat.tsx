// The chat view. Messages come from useSupportFeed; this file only renders and collects input.
import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Send, X } from 'lucide-react'
import {
  FEEDBACK_IMAGE_TYPES, FEEDBACK_MAX_IMAGES, SUPPORT_MAX_LENGTH, type SupportMessage,
} from '@bitetime/shared'
import { useSession } from '../SessionContext'
import { fetchSupportImage } from '../store'
import { Textarea } from '../components/ui/textarea'
import { Button } from '../components/ui/button'
import SupportLinks from './SupportLinks'
import type { OutboxItem } from './useSupportFeed'
import { cn } from '@/lib/utils'

interface Props {
  merchantId: string
  messages: SupportMessage[]
  outbox: OutboxItem[]
  notAlerted: boolean
  imagesFailed: number
  onSend: (body: string, files: File[]) => Promise<boolean>
  onRetry: (localId: string) => void
  onDiscard: (localId: string) => void
}

export default function SupportChat({ merchantId, messages, outbox, notAlerted, imagesFailed, onSend, onRetry, onDiscard }: Props) {
  const { t } = useSession()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const end = useRef<HTMLDivElement>(null)

  // Keep the newest message in view as messages arrive.
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages.length, outbox.length])

  const trimmed = text.trim()
  const canSend = trimmed.length > 0 && trimmed.length <= SUPPORT_MAX_LENGTH

  const submit = async () => {
    if (!canSend) return
    const body = trimmed
    const picked = files
    // Clear at once: the message now shows in the outbox, with Retry if it fails.
    setText('')
    setFiles([])
    await onSend(body, picked)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
        {messages.length === 0 && outbox.length === 0 && (
          <p className="py-6 text-center text-[13px] text-muted-foreground">
            {t('Usually we reply within a few hours, 9am–6pm MYT.', '我们通常在几个小时内回复（马来西亚时间上午 9 点至下午 6 点）。')}
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {messages.map(m => (
            <li key={m.id} className={cn('flex', m.sender === 'merchant' ? 'justify-end' : 'justify-start')}>
              <div className={cn(
                'max-w-[85%] rounded-lg px-3 py-2 text-[14px] whitespace-pre-wrap break-words',
                m.sender === 'merchant' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
              )}>
                {m.sender === 'admin' && (
                  <span className="mb-0.5 block text-[11px] font-medium text-muted-foreground">
                    {t('TinyOrder team', 'TinyOrder 团队')}
                  </span>
                )}
                {m.body}
                {m.image_count > 0 && (
                  <div className="mt-2 flex gap-1.5">
                    {Array.from({ length: m.image_count }, (_, i) => (
                      <SupportImage key={i} merchantId={merchantId} messageId={m.id} index={i} />
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
          {outbox.map(o => (
            <li key={o.localId} className="flex flex-col items-end gap-1">
              <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-[14px] text-primary-foreground opacity-70 whitespace-pre-wrap break-words">
                {o.body}
              </div>
              {o.state === 'sending' ? (
                <span className="text-[11px] text-muted-foreground">{t('Sending…', '发送中…')}</span>
              ) : (
                <span className="flex items-center gap-2 text-[11px] text-danger-fg">
                  {o.error || t('Not sent', '未发送')}
                  <button type="button" className="underline cursor-pointer" onClick={() => onRetry(o.localId)}>
                    {t('Retry', '重试')}
                  </button>
                  <button type="button" className="underline cursor-pointer" onClick={() => onDiscard(o.localId)}>
                    {t('Discard', '放弃')}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {imagesFailed > 0 && (
          <p role="status" className="mt-3 text-right text-[12px] text-danger-fg">
            {t(
              `${imagesFailed} screenshot${imagesFailed === 1 ? '' : 's'} could not be attached.`,
              `有 ${imagesFailed} 张截图未能上传。`,
            )}
          </p>
        )}
        {notAlerted && (
          <div role="status" className="mt-3 rounded-md border border-border p-3 text-[12px]">
            <p className="mb-1">{t('We saved your message, but we could not alert the team. Email us instead.',
              '我们已保存你的留言，但未能通知团队。请改用邮件联系我们。')}</p>
            <SupportLinks compact />
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="border-t border-border p-3">
        {files.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px]">
                {f.name}
                <button type="button" aria-label={t(`Remove ${f.name}`, `移除 ${f.name}`)} className="cursor-pointer"
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit() } }}
            rows={2}
            aria-label={t('Your message', '你的留言')}
            placeholder={t('Type your question…', '输入你的问题…')}
            className="min-h-[44px] flex-1 resize-none"
          />
          <label
            className={cn('cursor-pointer p-2 text-primary', files.length >= FEEDBACK_MAX_IMAGES && 'pointer-events-none opacity-50')}
            title={t('Attach screenshots', '添加截图')}
          >
            <ImagePlus size={18} strokeWidth={1.75} />
            <input
              type="file"
              className="sr-only"
              multiple
              accept={FEEDBACK_IMAGE_TYPES.join(',')}
              aria-label={t('Attach screenshots', '添加截图')}
              onChange={e => {
                const chosen = Array.from(e.target.files ?? [])
                setFiles(prev => [...prev, ...chosen].slice(0, FEEDBACK_MAX_IMAGES))
                e.target.value = ''
              }}
            />
          </label>
          <Button type="button" size="icon" disabled={!canSend} onClick={() => void submit()} aria-label={t('Send', '发送')}>
            <Send size={16} />
          </Button>
        </div>
        {trimmed.length > SUPPORT_MAX_LENGTH && (
          <p className="mt-1 text-right text-[11px] text-danger-fg">{trimmed.length} / {SUPPORT_MAX_LENGTH}</p>
        )}
      </div>
    </div>
  )
}

/** One screenshot thumbnail. The bucket is private, so the bytes come through the backend. */
function SupportImage({ merchantId, messageId, index }: { merchantId: string; messageId: string; index: number }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let made: string | null = null
    void fetchSupportImage(merchantId, messageId, index).then(r => {
      if (!alive || !r.ok) return
      made = URL.createObjectURL(r.data)
      setUrl(made)
    })
    return () => { alive = false; if (made) URL.revokeObjectURL(made) }
  }, [merchantId, messageId, index])
  if (!url) return <div className="h-14 w-14 rounded-md bg-background/40" />
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      <img src={url} alt="" className="h-14 w-14 rounded-md object-cover" />
    </a>
  )
}
