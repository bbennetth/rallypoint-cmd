import type { ReactNode } from 'react'

// The panel's one table. Backups, Mods and Players each hand-rolled the
// same <table> markup with the same header and row classes; this is that
// markup, once.
//
// Written fresh rather than ported from @rallypoint/ui's Table: that one
// is value-model shaped (`{id} & Record<key, value>`) and carries a
// click-to-sort machine, while these three tables are JSX-cell and
// unsorted — we would have taken 265 lines to use about 40% of them. The
// <th> recipe below IS upstream's, so the two systems still look alike.

export interface DataColumn {
  key: string
  header: ReactNode
  align?: 'left' | 'right'
  /** Applied to the <td>s in this column (e.g. `mono text-xs`). */
  cellClassName?: string
}

export interface DataRow {
  id: string
  /** One node per column, in column order. */
  cells: ReactNode[]
}

export function DataTable({
  columns,
  rows,
  empty = 'Nothing here yet.',
}: {
  columns: readonly DataColumn[]
  rows: readonly DataRow[]
  empty?: ReactNode
}) {
  if (rows.length === 0) {
    return <p className="cmd-empty">{empty}</p>
  }
  return (
    <div className="cmd-table-wrap thin-scroll">
      <table className="cmd-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'is-right' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {columns.map((c, i) => (
                <td
                  key={c.key}
                  className={[c.align === 'right' ? 'is-right' : '', c.cellClassName ?? '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  {r.cells[i]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
