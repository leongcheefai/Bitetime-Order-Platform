import * as React from 'react'
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { ArrowUpDown } from 'lucide-react'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/**
 * Hand this in and `data` is understood to be ONE PAGE that the server already sorted and
 * searched — the table stops slicing, sorting and filtering, and forwards every such gesture
 * back to the owner instead.
 *
 * It exists because a table cannot page through rows it was never sent. The merchant's order
 * list used to be handed a shop's whole history and page it here, which quietly stopped being
 * the whole history at the shop's 1000th order (#144). Client paging is still the right answer
 * for the small, bounded lists elsewhere in the dashboard; this is the escape hatch for the ones
 * that grow without limit.
 */
export interface ServerTable {
  /** 1-based, to match the pager the merchant reads. */
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  sorting: SortingState
  onSortingChange: (sorting: SortingState) => void
  search: string
  onSearchChange: (search: string) => void
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  /** When set, renders a global search box that filters across all columns. */
  searchPlaceholder?: string
  emptyText?: string
  prevLabel?: string
  nextLabel?: string
  pageSize?: number
  /** Forwarded to TanStack as table.options.meta — cells read handlers/state from it. */
  meta?: unknown
  /** When set, clicking a row calls this with the row's original data. */
  onRowClick?: (row: TData) => void
  /** When set, `data` is one server-side page — see ServerTable. */
  server?: ServerTable
  /** Rendered on the toolbar's right, opposite the search box — filters, tallies, actions. */
  toolbar?: React.ReactNode
}

// Generic TanStack-backed table: global search, sortable columns, client pagination.
// Styling mirrors the app's existing bespoke table (13px, oxblood pills) so callers
// keep their custom cell renderers unchanged.
export function DataTable<TData, TValue>({
  columns,
  data,
  searchPlaceholder,
  emptyText = 'No results.',
  prevLabel = 'Previous',
  nextLabel = 'Next',
  pageSize = 10,
  meta,
  onRowClick,
  server,
  toolbar,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = React.useState('')

  const sortingState = server ? server.sorting : sorting
  const searchState = server ? server.search : globalFilter

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    // The `manual*` flags are what make the row models above no-ops in server mode: the rows
    // handed in are already the answer, and re-sorting or re-slicing them here would reorder a
    // page against the ordering the rest of the pages were cut from.
    manualPagination: !!server,
    manualSorting: !!server,
    manualFiltering: !!server,
    pageCount: server?.pageCount,
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sortingState) : updater
      if (server) server.onSortingChange(next)
      else setSorting(next)
    },
    onGlobalFilterChange: (updater) => {
      const next = typeof updater === 'function' ? updater(searchState) : updater
      if (server) server.onSearchChange(next as string)
      else setGlobalFilter(next as string)
    },
    state: { sorting: sortingState, globalFilter: searchState },
    initialState: { pagination: { pageSize } },
    meta: meta as Record<string, unknown> | undefined,
  })

  const pageCount = server ? server.pageCount : table.getPageCount()
  const pageIndex = server ? server.page - 1 : table.getState().pagination.pageIndex
  const goToPage = (i: number) => (server ? server.onPageChange(i + 1) : table.setPageIndex(i))
  // The box drives `searchState`, not the local state directly — in server mode the local one is
  // read by nothing, so binding to it would give the merchant a search box that types and filters
  // nothing at all.
  const setSearch = (v: string) => (server ? server.onSearchChange(v) : setGlobalFilter(v))

  return (
    <div>
      {(searchPlaceholder || toolbar) && (
        <div className="pb-4 flex flex-wrap items-center justify-between gap-3">
          {searchPlaceholder && (
            <Input
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              value={searchState}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs"
            />
          )}
          {/* `ml-auto` and not `justify-end` alone: with no search box the toolbar still sits
              right, and once the row wraps on a narrow screen it stays there. */}
          {toolbar && <div className="ml-auto">{toolbar}</div>}
        </div>
      )}
      <Table className="text-[13px]">
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id} className="hover:bg-transparent">
              {hg.headers.map((header) => (
                <TableHead key={header.id} className="py-2 px-3">
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                onKeyDown={onRowClick ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row.original) }
                } : undefined}
                role={onRowClick ? 'button' : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={onRowClick ? 'cursor-pointer' : undefined}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="p-3">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={columns.length}
                className="h-20 text-center text-muted-foreground italic"
              >
                {emptyText}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {pageCount > 1 && (
        <div className="flex items-center justify-end gap-2 pt-4">
          <Button
            variant="outline"
            size="none"
            className="py-[4px] px-3 pointer-coarse:min-h-10 pointer-coarse:px-4 rounded-pill text-[12px] bg-card hover:bg-brand-wash hover:text-primary hover:border-primary"
            onClick={() => goToPage(pageIndex - 1)}
            disabled={pageIndex <= 0}
          >{prevLabel}</Button>
          {/* Only in server mode: a merchant paging through a list too long to hold needs to
              know where in it they are. The client-paged tables elsewhere show the whole list
              on one screen's worth of pages and never needed it. */}
          {server && (
            <span className="text-[12px] text-muted-foreground tabular-nums">
              {pageIndex + 1} / {pageCount}
            </span>
          )}
          <Button
            variant="outline"
            size="none"
            className="py-[4px] px-3 pointer-coarse:min-h-10 pointer-coarse:px-4 rounded-pill text-[12px] bg-card hover:bg-brand-wash hover:text-primary hover:border-primary"
            onClick={() => goToPage(pageIndex + 1)}
            disabled={pageIndex >= pageCount - 1}
          >{nextLabel}</Button>
        </div>
      )}
    </div>
  )
}

// Sortable column header: a ghost button that cycles asc → desc on click. Pass the
// TanStack `column` from a header render fn plus the label to show.
export function SortableHeader<TData, TValue>({
  column, label,
}: {
  column: import('@tanstack/react-table').Column<TData, TValue>
  label: React.ReactNode
}) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 -ml-1 px-1 py-0.5 pointer-coarse:px-2 pointer-coarse:py-2 rounded cursor-pointer hover:text-primary transition-colors"
      onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
    >
      {label}
      <ArrowUpDown className="size-3 opacity-60" />
    </button>
  )
}
