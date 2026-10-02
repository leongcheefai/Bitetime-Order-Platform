import { useEffect, useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import {
  FEEDBACK_CATEGORIES, FEEDBACK_MAX_LENGTH, FEEDBACK_MAX_IMAGES, FEEDBACK_IMAGE_TYPES,
  validateFeedbackImage, type FeedbackCategory, type FeedbackImageError,
} from '@bitetime/shared'
import { useSession } from '../SessionContext'
import { submitFeedback } from '../store'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Textarea } from '../components/ui/textarea'
import { Button } from '../components/ui/button'
import SupportLinks from './SupportLinks'
import { cn } from '@/lib/utils'

// Bilingual labels for the four categories the backend accepts. Keyed off the shared
// FEEDBACK_CATEGORIES tuple so adding a category there is a type error here until it is
// given a label — the list cannot silently drift out of sync with the server.
const CATEGORY_LABELS: Record<FeedbackCategory, { en: string; zh: string }> = {
  bug:     { en: 'Something is broken', zh: '出现故障' },
  feature: { en: 'Feature request',     zh: '功能建议' },
  billing: { en: 'Billing',             zh: '账单' },
  other:   { en: 'Something else',      zh: '其他' },
}

/**
 * The merchant feedback form (#89), one view of the support panel (SupportPanel.tsx). It used to
 * be the body of FeedbackFab's dialog; the dialog and its floating button are gone, and the form
 * now lives exactly as long as its panel view — so unmount does the reset FeedbackFab's change()
 * did on every open and close.
 */
export default function FeedbackForm({ onDone }: { onDone: () => void }) {
  const { t, merchant } = useSession()
  const [category, setCategory] = useState<FeedbackCategory | ''>('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  // A picked screenshot and the object URL that previews it, kept as ONE value. Splitting them
  // into two states is what lets them drift — a preview outliving the file it showed is a
  // revoked-URL broken image, and a file outliving its preview is a leak.
  const [picked, setPicked] = useState<{ file: File; url: string }[]>([])
  const [imageError, setImageError] = useState('')
  // How many screenshots the backend could not store. The message still landed — losing an
  // image must never cost the merchant the words — so this is a caveat on the thank-you, not
  // an error, and the merchant is told rather than left assuming the maintainer can see it.
  const [failedCount, setFailedCount] = useState(0)
  // Mirrors `picked` for the unmount cleanup below, which runs once and would otherwise close
  // over the empty first render. Written only by repick(), never during render.
  const pickedRef = useRef<{ file: File; url: string }[]>([])
  // Tracks the auto-close timer started after a successful send, so unmount can cancel it. Left
  // to fire on its own, it would call onDone() after the merchant has already moved to another
  // view, and pull them back out of it.
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The form unmounts when the merchant leaves the feedback view. A submission still in flight
  // then resolves against a component that is gone; this guard keeps it from setting state. The
  // request itself is not cancelled and still writes the row.
  //
  // Set to true IN the effect, not only in useRef's initial value: StrictMode mounts, unmounts
  // and mounts again in development, and a guard that only ever flips to false stays false after
  // that rehearsal — every send then lands on a form that thinks it is gone and sits on Sending….
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => () => {
    if (autoCloseTimer.current !== null) clearTimeout(autoCloseTimer.current)
    // The browser holds an object URL until it is revoked explicitly. Unmounting mid-message
    // (leaving the view, closing the panel) is the one path repick() never sees.
    for (const p of pickedRef.current) URL.revokeObjectURL(p.url)
  }, [])

  if (!merchant) return null

  const trimmed = message.trim()
  const tooLong = trimmed.length > FEEDBACK_MAX_LENGTH
  const canSubmit = category !== '' && trimmed.length > 0 && !tooLong && !busy

  // The single writer for the picked list. Every path that changes it — picking, removing,
  // resetting — goes through here, so there is exactly one place that revokes an object URL
  // and one place that keeps pickedRef in step with the state.
  const repick = (next: { file: File; url: string }[], revoke: { file: File; url: string }[]) => {
    for (const p of revoke) URL.revokeObjectURL(p.url)
    pickedRef.current = next
    setPicked(next)
  }

  // The shared validator returns a CODE, not a sentence, precisely so this form can say it in
  // the merchant's own language — an English string from @bitetime/shared would land untranslated
  // inside a Chinese UI.
  const imageErrorText = (code: FeedbackImageError, name: string) => {
    switch (code) {
      case 'unsupported_type':
        return t(`${name}: must be JPEG, PNG or WebP`, `${name}：必须是 JPEG、PNG 或 WebP`)
      case 'empty':
        return t(`${name}: file is empty`, `${name}：文件是空的`)
      case 'too_large':
        return t(`${name}: must be 5MB or smaller`, `${name}：不能超过 5MB`)
    }
  }

  // A bad file in the selection must not cost the merchant the good ones — the rejected file is
  // named, the rest are kept. Same reasoning as keeping the typed message on a failed send.
  const pick = (chosen: FileList | null) => {
    if (!chosen) return
    const room = FEEDBACK_MAX_IMAGES - picked.length
    const accepted: { file: File; url: string }[] = []
    const rejected: string[] = []

    for (const file of Array.from(chosen)) {
      if (accepted.length >= room) {
        rejected.push(t(
          `${file.name} (limit ${FEEDBACK_MAX_IMAGES})`,
          `${file.name}（最多 ${FEEDBACK_MAX_IMAGES} 张）`,
        ))
        continue
      }
      const check = validateFeedbackImage({ type: file.type, size: file.size })
      if (!check.ok) { rejected.push(imageErrorText(check.code, file.name)); continue }
      accepted.push({ file, url: URL.createObjectURL(file) })
    }

    // `room` came from this render's `picked`, which is one commit behind if two picks land
    // back to back. Slicing against the CURRENT list keeps the cap true regardless — the count
    // is the one rule the database CHECK would otherwise have to catch as a 400.
    if (accepted.length) {
      const next = [...pickedRef.current, ...accepted]
      const overflow = next.slice(FEEDBACK_MAX_IMAGES)
      repick(next.slice(0, FEEDBACK_MAX_IMAGES), overflow)
    }
    setImageError(rejected.join(' · '))
  }

  const removeFile = (index: number) => {
    const gone = pickedRef.current[index]
    repick(pickedRef.current.filter((_, i) => i !== index), gone ? [gone] : [])
    setImageError('')
  }

  const send = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    const r = await submitFeedback(
      merchant.id,
      { category: category as FeedbackCategory, message: trimmed },
      picked.map(p => p.file),
    )
    // The merchant may have left the feedback view while that await was pending. The row is
    // already written, so nothing is lost by staying quiet.
    if (!mounted.current) return
    if (r.ok) {
      setFailedCount(r.data.images_failed)
      setSent(true)
      // Let the thank-you land before the form goes away. Longer when there is a caveat to
      // read — a merchant who lost a screenshot needs time to notice they should re-send it.
      autoCloseTimer.current = setTimeout(onDone, r.data.images_failed > 0 ? 3200 : 1600)
    } else {
      // Keep what they typed — losing a long message to a failed request is the worst
      // possible outcome for a feedback form.
      setError(r.error.message || t('Could not send feedback', '无法发送反馈'))
      setBusy(false)
    }
  }

  // Still keyed off the shared FEEDBACK_CATEGORIES tuple, so a fifth category upstream is
  // still a compile error here until it is given a label.
  const categoryItems = FEEDBACK_CATEGORIES.map(key => ({
    value: key,
    label: t(CATEGORY_LABELS[key].en, CATEGORY_LABELS[key].zh),
  }))

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">
        {t('Tell us what is working and what is not. We read every message.',
           '告诉我们哪些好用、哪些不好用。我们会阅读每一条留言。')}
      </p>

      {sent ? (
        <div className="py-6 text-center text-[14px] text-foreground">
          <p>{t('Thanks — we got it.', '谢谢，我们已收到。')}</p>
          {failedCount > 0 && (
            <p className="mt-2 text-[13px] text-danger-fg">
              {t(
                `${failedCount} screenshot${failedCount === 1 ? '' : 's'} could not be attached.`,
                `有 ${failedCount} 张截图未能上传。`,
              )}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* `category` is '' when unset, but Base UI only shows a placeholder for null —
              the two spellings of "nothing chosen" meet here. */}
          <Select
            value={category || null}
            onValueChange={(v) => setCategory((v ?? '') as FeedbackCategory | '')}
            items={categoryItems}
          >
            <SelectTrigger aria-label={t('Category', '类别')}>
              <SelectValue placeholder={t('Pick a category', '选择类别')} />
            </SelectTrigger>
            <SelectContent>
              {categoryItems.map(i => (
                <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div>
            <Textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={6}
              aria-label={t('Your message', '你的留言')}
              placeholder={t('What happened, or what would help?', '发生了什么？或者什么能帮到你？')}
            />
            <div className={cn(
              'mt-1 text-right text-[11px]',
              tooLong ? 'text-danger-fg' : 'text-muted-foreground',
            )}>
              {trimmed.length} / {FEEDBACK_MAX_LENGTH}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label
                className={cn(
                  'inline-flex items-center gap-2 text-[13px] font-sans cursor-pointer',
                  'text-primary transition-colors duration-150 hover:text-brand-600',
                  picked.length >= FEEDBACK_MAX_IMAGES && 'pointer-events-none opacity-50',
                )}
              >
                <ImagePlus size={16} strokeWidth={1.75} />
                {t('Attach screenshots', '添加截图')}
                <input
                  type="file"
                  className="sr-only"
                  accept={FEEDBACK_IMAGE_TYPES.join(',')}
                  multiple
                  disabled={picked.length >= FEEDBACK_MAX_IMAGES}
                  // Cleared so re-picking the same file after removing it still fires onChange.
                  onChange={e => { pick(e.target.files); e.target.value = '' }}
                />
              </label>
              <span className="text-[11px] text-muted-foreground">
                {picked.length} / {FEEDBACK_MAX_IMAGES}
              </span>
            </div>

            {picked.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {picked.map((p, i) => (
                  <li key={p.url} className="relative">
                    <img
                      src={p.url}
                      alt={p.file.name}
                      className="h-16 w-16 rounded-md object-cover border border-border"
                    />
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      aria-label={t(`Remove ${p.file.name}`, `移除 ${p.file.name}`)}
                      className={cn(
                        'absolute -top-1.5 -right-1.5 rounded-pill bg-foreground text-background',
                        'flex items-center justify-center h-6 w-6 pointer-coarse:h-8 pointer-coarse:w-8 cursor-pointer',
                      )}
                    >
                      <X size={12} strokeWidth={2} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {imageError && <p role="alert" className="text-[12px] text-danger-fg">{imageError}</p>}
          </div>

          {error && <p role="alert" className="text-[13px] text-danger-fg">{error}</p>}

          <Button onClick={send} disabled={!canSubmit}>
            {busy ? t('Sending…', '发送中…') : t('Send', '发送')}
          </Button>
        </div>
      )}

      {/* Outside the sent/form branch on purpose: it belongs on BOTH screens. This form
          never replies — a merchant who has just reported a broken checkout is exactly the
          one who still needs a human, and the thank-you is the last thing they read. */}
      <div className="mt-4 pt-3 border-t border-border">
        <SupportLinks compact />
      </div>
    </div>
  )
}
