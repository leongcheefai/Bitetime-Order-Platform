import { useSession } from '../SessionContext'
import type { Lang } from '../types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/** Language switcher (EN / 中文) backed by the shadcn Select. */
export default function LanguageSelect({ className }: { className?: string }) {
  const { lang, setLang } = useSession()
  return (
    <Select value={lang} onValueChange={(v) => setLang(v as Lang)}>
      <SelectTrigger size="sm" className={className} aria-label="Language / 语言">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="en">EN</SelectItem>
        <SelectItem value="zh">中文</SelectItem>
      </SelectContent>
    </Select>
  )
}
