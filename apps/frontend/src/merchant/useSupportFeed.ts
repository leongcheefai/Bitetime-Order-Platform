// Polls the support chat and holds what is on screen. The cursor (the id of the last message the
// browser holds) moves ONLY on a poll, never on a send: a reply stored between the last poll and
// my message would otherwise sit behind the cursor and never show.
//
// No reset on a merchantId change: a merchant owns one shop, and the one caller that could
// switch shops — a superadmin in "view as shop" — never mounts the bubble (SupportFab).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SupportMessage } from '@bitetime/shared'
import { listSupportMessages, sendSupportMessage, markSupportRead } from '../store'
import { pollDelay, mergeMessages } from './supportFeed'

export interface OutboxItem {
  localId: string
  body: string
  files: File[]
  state: 'sending' | 'failed'
  error?: string
}

export function useSupportFeed(merchantId: string | null, open: boolean) {
  const [messages, setMessages] = useState<SupportMessage[]>([])
  const [outbox, setOutbox] = useState<OutboxItem[]>([])
  const [unread, setUnread] = useState(0)
  const [available, setAvailable] = useState(true)
  const [notAlerted, setNotAlerted] = useState(false)
  // Screenshots the last send could not store. The words still landed, so this is a caveat to
  // show, not a failed send — the same posture as the feedback form's thank-you.
  const [imagesFailed, setImagesFailed] = useState(0)
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  const cursor = useRef<string | null>(null)

  useEffect(() => {
    const onChange = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  const poll = useCallback(async () => {
    if (!merchantId) return
    const r = await listSupportMessages(merchantId, cursor.current ?? undefined)
    if (!r.ok) return // the next interval tries again; one failed poll is not news
    setUnread(r.data.unread)
    setAvailable(r.data.available)
    const incoming = r.data.messages
    if (incoming.length) {
      cursor.current = incoming[incoming.length - 1].id
      setMessages(prev => mergeMessages(prev, incoming))
    }
  }, [merchantId])

  // Polls at once on every change (opening the panel, the tab coming back), then on the interval.
  useEffect(() => {
    const delay = pollDelay({ open, hidden })
    if (delay === null || !merchantId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      await poll()
      if (!stopped) timer = setTimeout(tick, delay)
    }
    void tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [open, hidden, merchantId, poll])

  const deliver = useCallback(async (item: OutboxItem): Promise<boolean> => {
    if (!merchantId) return false
    const r = await sendSupportMessage(merchantId, item.body, item.files)
    if (!r.ok) {
      setOutbox(prev => prev.map(o => o.localId === item.localId ? { ...o, state: 'failed', error: r.error.message } : o))
      return false
    }
    setOutbox(prev => prev.filter(o => o.localId !== item.localId))
    setMessages(prev => mergeMessages(prev, [r.data.message]))
    setNotAlerted(!r.data.alerted)
    setImagesFailed(r.data.images_failed)
    return true
  }, [merchantId])

  const send = useCallback(async (body: string, files: File[]) => {
    const item: OutboxItem = { localId: crypto.randomUUID(), body, files, state: 'sending' }
    setOutbox(prev => [...prev, item])
    return deliver(item)
  }, [deliver])

  const retry = useCallback(async (localId: string) => {
    const item = outbox.find(o => o.localId === localId)
    if (!item) return
    setOutbox(prev => prev.map(o => o.localId === localId ? { ...o, state: 'sending', error: undefined } : o))
    await deliver({ ...item, state: 'sending' })
  }, [outbox, deliver])

  const discard = useCallback((localId: string) => {
    setOutbox(prev => prev.filter(o => o.localId !== localId))
  }, [])

  const markRead = useCallback(() => {
    if (!merchantId) return
    setUnread(0)
    void markSupportRead(merchantId)
  }, [merchantId])

  return { messages, outbox, unread, available, notAlerted, imagesFailed, send, retry, discard, markRead }
}
