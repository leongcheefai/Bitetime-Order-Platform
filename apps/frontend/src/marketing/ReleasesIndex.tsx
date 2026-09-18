import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listPublishedReleases } from '../store'
import { useSession } from '../SessionContext'
import { Spinner } from '../components/Loaders'
import Wordmark from '../components/Wordmark'
import type { PublicRelease } from '../types'

// The whole published history, which the bell's popover no longer holds: it shows the three newest
// and links here. Not prerendered and not in sitemap.xml — the rows come from the database, and a
// build must not read it. See ReleasesBell.tsx.
export default function ReleasesIndex() {
  const { t } = useSession()
  const [releases, setReleases] = useState<PublicRelease[] | null>(null)

  useEffect(() => {
    let live = true
    listPublishedReleases().then((r) => {
      if (live) setReleases(r.ok ? r.data : [])
    })
    return () => { live = false }
  }, [])

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <div className="mb-2">
        <Wordmark className="h-7" />
      </div>
      <h1 className="text-2xl font-heading text-foreground mb-6">
        {t("What's new", '更新日志')}
      </h1>
      {releases === null ? (
        <div className="py-8 flex justify-center">
          <Spinner label={t('Loading…', '加载中…')} />
        </div>
      ) : releases.length === 0 ? (
        <p className="text-[14px] text-muted-foreground">{t('No updates yet', '暂无更新')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border border-y border-border">
          {releases.map((r) => (
            <li key={r.tag}>
              <Link
                to={`/releases/${r.tag}`}
                className="flex flex-col gap-1 py-3 no-underline hover:bg-muted/60 px-2 -mx-2 rounded-md"
              >
                <span className="text-[14px] text-foreground font-medium">{r.title}</span>
                <span className="text-[12px] text-muted-foreground">
                  {new Date(r.published_at).toLocaleDateString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
