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
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = React.useState('')

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    state: { sorting, globalFilter },
    initialState: { pagination: { pageSize } },
    meta: meta as Record<string, unknown> | undefined,
  })

  return (
    <div>
      {searchPlaceholder && (
        <div className="pb-4">
          <Input
            placeholder={searchPlaceholder}
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="max-w-xs"
          />
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
              <TableRow key={row.id}>
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
                className="h-20 text-center text-text-tertiary italic"
              >
                {emptyText}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-end gap-2 pt-4">
          <Button
            variant="outline"
            size="none"
            className="py-[4px] px-3 rounded-pill text-[12px] bg-surface-raised hover:bg-oxblood-tint hover:text-oxblood hover:border-oxblood"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >{prevLabel}</Button>
          <Button
            variant="outline"
            size="none"
            className="py-[4px] px-3 rounded-pill text-[12px] bg-surface-raised hover:bg-oxblood-tint hover:text-oxblood hover:border-oxblood"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
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
      className="inline-flex items-center gap-1 -ml-1 px-1 py-0.5 rounded cursor-pointer hover:text-oxblood transition-colors"
      onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
    >
      {label}
      <ArrowUpDown className="size-3 opacity-60" />
    </button>
  )
}
