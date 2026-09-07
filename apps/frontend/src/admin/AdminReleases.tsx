import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { MoreHorizontal } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import {
  adminPullReleases, adminListReleases, adminSetReleaseStatus, adminRegenerateRelease,
} from '../store'
import { unwrap } from '../api'
import { useSession } from '../SessionContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, SortableHeader } from '@/components/ui/data-table'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import ReleaseSummary from '../components/ReleaseSummary'
import type { AdminRelease } from '../types'

// Handlers + language + in-flight id ride on table.options.meta so the column defs
// stay stable (defined once) and never reset sorting when a row action refetches.
interface AdminTableMeta {
  t: (en: string, zh: string) => string
  busy: string | null
  onPreview: (row: AdminRelease) => void
  onRegenerate: (row: AdminRelease) => void
  onTogglePublish: (row: AdminRelease) => void
}

// A pull answers as soon as the drafts are stored; Claude rewrites them into merchant-facing
// copy afterwards, so a fresh row arrives with no title. A row is PENDING until it resolves
// one way or the other — a title, or a humanize_error. Both terminal states end the wait,
// which is what stops the poll below from running forever on a release Claude refused.
function isPending(r: AdminRelease) {
  return !r.title && !r.humanize_error
}

const POLL_INTERVAL_MS = 2000
// Generous against a pull of ten rewriting at once, and still short enough that a backend
// that died mid-write stops being waited on within a minute and a half.
const POLL_CEILING_MS = 90_000

const columns: ColumnDef<AdminRelease>[] = [
  {
    accessorKey: 'tag',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as AdminTableMeta).t('Tag', '版本')} />
    ),
    cell: ({ row }) => <span className="font-medium">{row.original.tag}</span>,
  },
  {
    id: 'title',
    accessorFn: (r) => r.title ?? r.name,
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as AdminTableMeta).t('Title', '标题')} />
    ),
    cell: ({ row, table }) => {
      const { t } = table.options.meta as AdminTableMeta
      const r = row.original
      return (
        <div>
          <span>{r.title ?? r.name}</span>
          {isPending(r) && (
            // Says the row is unfinished rather than leaving the raw GitHub name looking like
            // the final copy. Without this a pending row and a rewritten one are identical at
            // a glance, and the Publish action is already disabled on a row with no title —
            // this is the line that explains why.
            <div className="text-[11px] text-muted-foreground italic mt-0.5">
              {t('Writing summary…', '正在生成摘要…')}
            </div>
          )}
          {r.humanize_error && (
            <div className="text-[11px] text-danger-fg mt-0.5">{r.humanize_error}</div>
          )}
        </div>
      )
    },
  },
  {
    accessorKey: 'status',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as AdminTableMeta).t('Status', '状态')} />
    ),
    cell: ({ row, table }) => {
      const { t } = table.options.meta as AdminTableMeta
      const s = row.original.status
      return (
        <Badge variant={s === 'published' ? 'success' : 'outline'}>
          {s === 'published' ? t('Published', '已发布') : t('Draft', '草稿')}
        </Badge>
      )
    },
  },
  {
    accessorKey: 'published_at',
    header: ({ column, table }) => (
      <SortableHeader column={column} label={(table.options.meta as AdminTableMeta).t('Published', '发布时间')} />
    ),
    cell: ({ row }) => new Date(row.original.published_at).toLocaleDateString(),
  },
  {
    id: 'actions',
    header: ({ table }) => (
      <div className="text-right whitespace-nowrap">{(table.options.meta as AdminTableMeta).t('Actions', '操作')}</div>
    ),
    cell: ({ row, table }) => {
      const meta = table.options.meta as AdminTableMeta
      const { t, busy } = meta
      const r = row.original
      return (
        // Row click opens the preview (see onRowClick on DataTable below) — stop that click
        // from also firing when it lands in this cell, or opening the actions menu would
        // simultaneously pop the preview dialog underneath it.
        <div className="text-right" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="none"
                  className="size-9 p-0 rounded-pill cursor-pointer pointer-coarse:size-11 hover:bg-brand-wash hover:text-primary"
                  disabled={busy === r.id}
                  aria-label={t('Actions', '操作')}
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="cursor-pointer" onClick={() => meta.onRegenerate(r)}>
                {t('Regenerate', '重新生成')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!r.title}
                className="cursor-pointer"
                onClick={() => meta.onTogglePublish(r)}
              >
                {r.status === 'published' ? t('Unpublish', '取消发布') : t('Publish', '发布')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )
    },
  },
]

export default function AdminReleases() {
  const { t } = useSession()
  const [rows, setRows] = useState<AdminRelease[] | null>(null)
  const [pulling, setPulling] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // Lets superadmin read a draft's full title + summary before publishing — the public
  // /releases/:tag endpoint 404s on a draft by design, so this reuses the row data
  // adminListReleases already fetched rather than adding a second endpoint.
  const [previewRow, setPreviewRow] = useState<AdminRelease | null>(null)

  async function load() {
    setRows(unwrap(await adminListReleases()))
  }

  // Refetch every couple of seconds while any row is still being written, then stop. The
  // ceiling is what keeps a crashed or redeployed backend from spinning a timer forever:
  // those rows keep a null title and a null humanize_error and would otherwise stay pending
  // for good, so the wait ends and the operator is pointed at Regenerate.
  const pollTimer = useRef<number | null>(null)
  function stopPolling() {
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
  }
  // Also cancels an in-flight poll on unmount — a setRows after the component is gone is a
  // React warning at best and a leak at worst.
  useEffect(() => stopPolling, [])

  async function pollUntilWritten(deadline: number) {
    stopPolling()
    const r = await adminListReleases()
    // A blip mid-poll is not worth a toast: the rows on screen are still valid, and the next
    // poll (or the next pull) re-drives it. Only a hard stop is reported, below.
    if (!r.ok) return
    setRows(r.data)
    if (!r.data.some(isPending)) return
    if (Date.now() >= deadline) {
      toast.error(t(
        'Some summaries were not written. Use Regenerate on those rows.',
        '部分摘要未生成。请对这些行使用「重新生成」。',
      ))
      return
    }
    pollTimer.current = window.setTimeout(() => { void pollUntilWritten(deadline) }, POLL_INTERVAL_MS)
  }

  useEffect(() => {
    adminListReleases().then((r) => {
      setRows(unwrap(r))
      // Picks up a reload that lands mid-rewrite — the summaries are still coming, and the
      // page should finish the wait rather than sit on "Writing summary…" until a manual pull.
      if (r.ok && r.data.some(isPending)) void pollUntilWritten(Date.now() + POLL_CEILING_MS)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function pull() {
    setPulling(true)
    const r = await adminPullReleases()
    if (r.ok) {
      // Deliberately not "Pulled N" alone: the pull stored N drafts, and the copy for them is
      // still being written. Saying so is what makes the empty titles below read as expected.
      toast.success(r.data.pulled > 0
        ? t(
          `Pulled ${r.data.pulled} release(s) — writing summaries…`,
          `已拉取 ${r.data.pulled} 条更新 — 正在生成摘要…`,
        )
        : t('No new releases', '没有新的更新'))
      await load()
      if (r.data.pulled > 0) void pollUntilWritten(Date.now() + POLL_CEILING_MS)
    } else {
      toast.error(r.error.message || t('Pull failed', '拉取失败'))
    }
    setPulling(false)
  }

  async function togglePublish(row: AdminRelease) {
    setBusy(row.id)
    const next = row.status === 'published' ? 'draft' : 'published'
    const r = await adminSetReleaseStatus(row.id, next)
    if (r.ok) { toast.success(t('Updated', '已更新')); await load() }
    else toast.error(r.error.message || t('Could not update', '无法更新'))
    setBusy(null)
  }

  async function regenerate(row: AdminRelease) {
    setBusy(row.id)
    const r = await adminRegenerateRelease(row.id)
    if (r.ok) { toast.success(t('Regenerated', '已重新生成')); await load() }
    else toast.error(r.error.message || t('Regenerate failed', '重新生成失败'))
    setBusy(null)
  }

  const meta: AdminTableMeta = {
    t, busy,
    // Deferred a tick: opening the Dialog synchronously inside the DropdownMenuItem's onClick
    // mounts it while the menu's own closing click is still bubbling, and the Dialog's
    // outside-click listener catches that same event and closes it right back — the classic
    // Base UI/Radix overlay-inside-overlay trap. A fresh event-loop tick decouples them.
    onPreview: (row) => setTimeout(() => setPreviewRow(row), 0),
    onRegenerate: regenerate,
    onTogglePublish: togglePublish,
  }

  const data = useMemo(() => rows ?? [], [rows])

  if (!rows) return (
    <p className="text-[13px] text-muted-foreground italic pt-4">{t('Loading…', '加载中…')}</p>
  )

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-heading text-foreground">{t('Releases', '更新日志')}</h2>
        <Button variant="default" size="sm" onClick={pull} disabled={pulling}>
          {pulling ? t('Pulling…', '拉取中…') : t('Pull releases from GitHub', '从 GitHub 拉取更新')}
        </Button>
      </div>
      <div className="bg-card border-[0.5px] border-border rounded-2xl p-5 mb-8 w-full box-border">
        <DataTable
          columns={columns}
          data={data}
          meta={meta}
          onRowClick={(row) => { if (row.title) meta.onPreview(row) }}
          searchPlaceholder={t('Search releases…', '搜索更新…')}
          emptyText={t('No releases pulled yet.', '尚未拉取任何更新。')}
          prevLabel={t('Previous', '上一页')}
          nextLabel={t('Next', '下一页')}
        />
      </div>
      <Dialog open={!!previewRow} onOpenChange={(open) => { if (!open) setPreviewRow(null) }}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{previewRow?.title}</DialogTitle>
          </DialogHeader>
          {previewRow && <ReleaseSummary text={previewRow.summary ?? ''} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
