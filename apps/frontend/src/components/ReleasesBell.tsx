import { useEffect, useState } from 'react'
import { Bell, PackageOpen } from 'lucide-react'
import { listPublishedReleases } from '../store'
import { useSession } from '../SessionContext'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import type { PublicRelease } from '../types'

const LAST_SEEN_KEY = 'bitetime_last_seen_release'

// The popover shows only this many releases. Every published release is a row, so the list grows
// for ever otherwise — at ten it was already taller than the viewport. The rest live on /releases.
const SHOWN = 3

// "What's new" bell — Notion-style: the three newest releases, each opening its own page in a new
// tab. See docs/superpowers/specs/2026-08-05-github-release-notes-design.md.
export default function ReleasesBell() {
  const { t } = useSession()
  const [releases, setReleases] = useState<PublicRelease[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    listPublishedReleases().then((r) => { if (r.ok) setReleases(r.data) })
  }, [])

  const newest = releases[0]?.tag ?? null
  const lastSeen = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_SEEN_KEY) : null
  const unread = newest !== null && newest !== lastSeen

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next && newest) window.localStorage.setItem(LAST_SEEN_KEY, newest)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            className="relative"
            aria-label={t("What's new", '更新日志')}
          />
        }
      >
        <Bell size={18} strokeWidth={1.75} />
        {unread && (
          <span
            aria-hidden="true"
            className="absolute top-1.5 right-1.5 size-2 rounded-pill bg-primary"
          />
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="text-[12px] font-medium text-muted-foreground px-2 pb-1">
          {t("What's new", '更新日志')}
        </div>
        {releases.length === 0 ? (
          <div className="text-[13px] text-muted-foreground px-2 py-2">
            {t('No updates yet', '暂无更新')}
          </div>
        ) : (
          <ul className="flex flex-col">
            {releases.slice(0, SHOWN).map((r) => (
              <li key={r.tag}>
                <a
                  href={`/releases/${r.tag}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  // One line per release, ellipsised: the title is the link, and a title that
                  // wraps to three lines is what made ten of these unreadable.
                  className="block truncate rounded-md px-2 py-1.5 text-[13px] text-foreground no-underline hover:bg-muted"
                  title={r.title}
                >
                  {r.title}
                </a>
              </li>
            ))}
          </ul>
        )}
        <a
          href="/releases"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground no-underline hover:bg-muted hover:text-foreground"
        >
          <PackageOpen size={15} strokeWidth={1.75} />
          {t('View all releases', '查看全部更新')}
        </a>
      </PopoverContent>
    </Popover>
  )
}
