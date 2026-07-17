import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { shallow } from 'zustand/shallow'
import Slider from 'rc-slider'
import 'rc-slider/assets/index.css'
import { useStore } from '../store/store'

const PAGE_SIZE = 50
const COLS_PER_PAGE = 7

// Cache numeric ranges per dataset object, per column.
const RANGE_CACHE: WeakMap<object, Map<string, { min: number; max: number }>> = new WeakMap()

function getColumnRangeCached(ds: any, col: string): { min: number; max: number } {
  // 1) prefer precomputed stats if present
  const pre = ds?.stats?.numericRanges?.[col]
  if (pre && Number.isFinite(pre.min) && Number.isFinite(pre.max)) {
    if (pre.min === pre.max) return { min: pre.min, max: pre.min + 1 }
    return pre
  }

  // 2) lazy cache
  let m = RANGE_CACHE.get(ds as object)
  if (!m) {
    m = new Map()
    RANGE_CACHE.set(ds as object, m)
  }
  const hit = m.get(col)
  if (hit) return hit

  const arr = ds.columns[col] as any
  let min = Infinity
  let max = -Infinity
  const n = arr?.length ?? 0
  for (let i = 0; i < n; i++) {
    const v = arr[i]
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    const out = { min: 0, max: 1 }
    m.set(col, out)
    return out
  }
  if (min === max) max = min + 1
  const out = { min, max }
  m.set(col, out)
  return out
}

function formatCellNumber(v: number): string {
  const a = Math.abs(v)
  if (a >= 1000 || (a > 0 && a < 0.001)) return v.toExponential(2)
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

function truncateText(s: string, maxLen = 24): string {
  if (s.length <= maxLen) return s
  return s.slice(0, Math.max(0, maxLen - 3)) + '...'
}

function formatCellValue(v: any): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return ''
    return formatCellNumber(v)
  }
  return truncateText(String(v))
}

function vectorRecordForColumn(ds: any, col: string) {
  return ds.descriptors?.[col] || ds.molecularVectors?.[col] || ds.atomProperties?.[col] || null
}

function hasVectorLabels(ds: any, col: string): boolean {
  const values = ds.columns?.[col] as any
  if (!values || typeof values.length !== 'number') return false
  for (let i = 0; i < values.length; i++) {
    const value = String(values[i] ?? '').trim()
    if (value) return /^vec\[\d+\]$/.test(value) || value === 'vec'
  }
  return false
}

function isVectorColumn(ds: any, col: string): boolean {
  return (ds.meta.vectorColumns || []).includes(col) || Boolean(vectorRecordForColumn(ds, col)) || hasVectorLabels(ds, col)
}

function formatVectorCell(ds: any, col: string, id: string): string {
  const record = vectorRecordForColumn(ds, col)
  const vec = record?.valuesById?.[id]
  if (!Array.isArray(vec)) {
    const idx = ds.ids.indexOf(id)
    const values = ds.columns?.[col] as any
    return idx >= 0 && values ? formatCellValue(values[idx]) : ''
  }
  const preview = vec
    .slice(0, 3)
    .map(v => (typeof v === 'number' && Number.isFinite(v) ? formatCellNumber(v) : ''))
    .join(', ')
  return `[${preview}${vec.length > 3 ? ', ...' : ''}] (${vec.length})`
}

function orderedTableColumns(ds: any): string[] {
  const order = ds.columnOrder && ds.columnOrder.length ? ds.columnOrder : Object.keys(ds.columns)
  const vectorNames = [
    ...(ds.meta.vectorColumns || []),
    ...Object.keys(ds.descriptors || {}),
    ...Object.keys(ds.molecularVectors || {}),
    ...Object.keys(ds.atomProperties || {}),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of [...order, ...vectorNames]) {
    if (!name || seen.has(name)) continue
    if (Object.prototype.hasOwnProperty.call(ds.columns, name) || vectorRecordForColumn(ds, name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

// --- Static style objects to avoid allocating on every render ---
const styles = {
  tableWrap: { maxHeight: 260, overflow: 'auto', borderRadius: 8, border: '1px solid var(--color-border)' } as const,
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } as const,
  th: {
    position: 'sticky' as const,
    top: 0,
    background: 'var(--color-panel)',
    color: 'var(--color-text-dim)',
    textAlign: 'left' as const,
    padding: '4px 6px',
    borderBottom: '1px solid var(--color-border)'
  } as const,
  td: { padding: '3px 6px', borderBottom: '1px solid var(--color-border)' } as const,
  filterChip: {
    padding: '4px 8px',
    borderRadius: 8,
    border: '1px solid var(--color-border)',
    background: 'var(--color-panel)',
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    flexWrap: 'wrap' as const
  } as const
}

type Filters = Record<string, { min: number; max: number }>

//export default function DataTable() {
function DataTable() {
  // Subscribe only to what this component needs.
  // Using shallow reduces rerenders when objects are same by reference.
  const ds = useStore(s => s.dataset)
  const fullDatasetCount = useStore(s => s.fullDataset?.ids.length ?? 0)
  const { visibleIndices, visibleCount, selected0 } = useStore(
    s => ({
      visibleIndices: s.visibleIndices,
      visibleCount: s.visibleCount,
      selected0: s.selectedIndices?.length ? s.selectedIndices[0] : -1
    }),
    shallow
  )
  const pickedIndices = useStore(s => s.pickedIndices)

  const setSelected = useStore(s => s.setSelected)
  const togglePicked = useStore(s => s.togglePicked)
  const clearPicked = useStore(s => s.clearPicked)
  const setPickedIndices = useStore(s => s.setPickedIndices)
  const activeViewerPane = useStore(s => s.activeViewerPane)
  const replaceMoleculeInDisplay = useStore(s => s.replaceMoleculeInDisplay)

  const [page, setPage] = useState(0)
  const [columnPage, setColumnPage] = useState(0)
  const [colSearch, setColSearch] = useState('')
  const [colDropdownOpen, setColDropdownOpen] = useState(false)

  // No early return before hooks — all hooks below tolerate ds === null and
  // the null check happens just before render (avoids conditional-hooks crash).
  const allCols = useMemo(() => {
    return ds ? orderedTableColumns(ds) : []
  }, [ds])

  const columnPageCount = Math.max(1, Math.ceil(allCols.length / COLS_PER_PAGE))

  const colSuggestions = useMemo(() => {
    if (!colSearch.trim()) return []
    const q = colSearch.toLowerCase()
    return allCols.filter(c => c.toLowerCase().includes(q)).slice(0, 12)
  }, [allCols, colSearch])

  function jumpToColumn(colName: string) {
    const idx = allCols.indexOf(colName)
    if (idx >= 0) setColumnPage(Math.floor(idx / COLS_PER_PAGE))
    setColSearch('')
    setColDropdownOpen(false)
  }

  const pageCount = useMemo(() => {
    const count = visibleIndices ? visibleIndices.length : visibleCount || (ds?.ids.length ?? 0)
    return Math.max(1, Math.ceil(count / PAGE_SIZE))
  }, [visibleIndices, visibleCount, ds?.ids.length])

  const clampedPage = Math.min(page, pageCount - 1)

  // When a point is selected from scatter, move table to the page containing that row.
  useEffect(() => {
    if (!ds) return
    if (selected0 == null || selected0 < 0) return

    let rowPos = -1
    if (!visibleIndices) {
      if (selected0 >= ds.ids.length) return
      rowPos = selected0
    } else {
      for (let i = 0; i < visibleIndices.length; i++) {
        if (visibleIndices[i] === selected0) {
          rowPos = i
          break
        }
      }
    }
    if (rowPos < 0) return
    const nextPage = Math.floor(rowPos / PAGE_SIZE)
    setPage(prev => (prev === nextPage ? prev : nextPage))
  }, [selected0, visibleIndices, ds?.ids.length])

  // ✅ Build only the row indices for the current page
  const pageRowIndices = useMemo(() => {
    const start = clampedPage * PAGE_SIZE
    const end = start + PAGE_SIZE
    if (!visibleIndices) {
      const n = ds?.ids.length ?? 0
      const out = new Array(Math.max(0, Math.min(end, n) - start))
      let k = 0
      for (let i = start; i < Math.min(end, n); i++) out[k++] = i
      return out
    }

    const n = visibleIndices.length
    const out = new Array(Math.max(0, Math.min(end, n) - start))
    let k = 0
    for (let i = start; i < Math.min(end, n); i++) out[k++] = visibleIndices[i]
    return out
  }, [clampedPage, visibleIndices, ds?.ids.length])

  const columnsToShow = useMemo(() => {
    const clampedColumnPage = Math.min(columnPage, columnPageCount - 1)
    const start = clampedColumnPage * COLS_PER_PAGE
    const end = start + COLS_PER_PAGE
    const visibleCols = allCols.slice(start, end)
    return ['id', ...visibleCols]
  }, [allCols, columnPage, columnPageCount])

  const onRowClick = useCallback((globalIndex: number, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      togglePicked(globalIndex)
      setSelected(new Int32Array([globalIndex]))
      return
    }
    setSelected(new Int32Array([globalIndex]))
    if (pickedIndices.length > 0) {
      replaceMoleculeInDisplay(activeViewerPane, globalIndex)
    } else {
      setPickedIndices(new Int32Array([globalIndex]))
    }
  }, [setSelected, togglePicked, setPickedIndices, replaceMoleculeInDisplay, pickedIndices, activeViewerPane])

  // ✅ Precompute cell strings once per page/columns (reduces allocations during render)
  const pageCells: string[][] = useMemo(() => {
    if (!ds) return []
    const out: string[][] = new Array(pageRowIndices.length)
    for (let r = 0; r < pageRowIndices.length; r++) {
      const idx = pageRowIndices[r]
      const row: string[] = new Array(columnsToShow.length)
      for (let c = 0; c < columnsToShow.length; c++) {
        const col = columnsToShow[c]
        if (col === 'id') {
          row[c] = truncateText(ds.ids[idx], 32)
        } else if (isVectorColumn(ds, col)) {
          row[c] = formatVectorCell(ds, col, ds.ids[idx])
        } else {
          const arr = ds.columns[col] as any
          const v = arr ? arr[idx] : ''
          row[c] = formatCellValue(v)
        }
      }
      out[r] = row
    }
    return out
  }, [ds, pageRowIndices, columnsToShow])

  if (!ds) return null

  const shownCount = visibleIndices ? visibleIndices.length : visibleCount || ds.ids.length

  return (
    <div>
      <div className="table-header-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span className="legend table-summary">
            Visible {shownCount.toLocaleString()} / Working {ds.ids.length.toLocaleString()} molecules
            {fullDatasetCount > 0 && fullDatasetCount !== ds.ids.length
              ? ` (Source total ${fullDatasetCount.toLocaleString()})`
              : ''}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {columnPageCount > 1 && (
            <div className="col-search-wrap">
              <input
                className="col-search-input"
                placeholder="jump to column…"
                value={colSearch}
                onChange={e => { setColSearch(e.target.value); setColDropdownOpen(true) }}
                onFocus={() => setColDropdownOpen(true)}
                onBlur={() => setTimeout(() => setColDropdownOpen(false), 150)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && colSuggestions.length > 0) jumpToColumn(colSuggestions[0])
                  if (e.key === 'Escape') { setColSearch(''); setColDropdownOpen(false) }
                }}
              />
              {colDropdownOpen && colSuggestions.length > 0 && (
                <div className="col-search-dropdown">
                  {colSuggestions.map(c => (
                    <div key={c} className="col-search-item" onMouseDown={() => jumpToColumn(c)}>{c}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {columnPageCount > 1 && (
            <div className="column-pager">
              <span className="legend column-pager-label">Columns</span>
              <button className="pager-btn" disabled={columnPage <= 0} onClick={() => setColumnPage(p => Math.max(0, p - 1))}>
                ‹
              </button>
              <span className="legend column-pager-label column-pager-info">
                {columnPage * COLS_PER_PAGE + 1}–{Math.min((columnPage + 1) * COLS_PER_PAGE, allCols.length)} of {allCols.length}
              </span>
              <button
                className="pager-btn"
                disabled={columnPage >= columnPageCount - 1}
                onClick={() => setColumnPage(p => Math.min(columnPageCount - 1, p + 1))}
              >
                ›
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        style={styles.tableWrap}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) return
          const el = e.target as HTMLElement
          if (el.closest('[data-pickable="true"]')) return
          clearPicked()
        }}
      >
        <table style={styles.table}>
          <thead>
            <tr>
              {columnsToShow.map(col => (
                <th key={col} style={styles.th}>{col}</th>
              ))}
            </tr>
          </thead>

          <TableBody
            rowIndices={pageRowIndices}
            cells={pageCells}
            selected0={selected0}
            pickedIndices={pickedIndices}
            onRowClick={onRowClick}
          />
        </table>
      </div>

      {pageCount > 1 && (
        <div className="row-pager">
          <button className="pager-btn" disabled={clampedPage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>
            ‹ Prev
          </button>
          <span className="legend" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Page{' '}
            <input
              key={clampedPage}
              className="page-input"
              type="number"
              min={1}
              max={pageCount}
              defaultValue={clampedPage + 1}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const n = parseInt((e.target as HTMLInputElement).value, 10)
                  if (!isNaN(n)) setPage(Math.max(0, Math.min(pageCount - 1, n - 1)))
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              onBlur={e => {
                const n = parseInt(e.target.value, 10)
                if (!isNaN(n)) setPage(Math.max(0, Math.min(pageCount - 1, n - 1)))
              }}
            />
            {' '}/ {pageCount}
          </span>
          <button
            className="pager-btn"
            disabled={clampedPage >= pageCount - 1}
            onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
          >
            Next ›
          </button>
        </div>
      )}

    </div>
  )
}

export default React.memo(DataTable)

/** Filters + buttons (memoized: avoids rerendering table body when only selection changes) */
const HeaderControls = memo(function HeaderControls(props: {
  pending: Filters
  active: Filters
  availableFilterCols: string[]
  onAddFilter: (c: string) => void
  onClear: () => void
  removeFilter: (c: string) => void
  ds: any
  onOpenFilterPicker: () => void
}) {
  const {
    pending,
    active,
    onClear,
    removeFilter,
    ds,
    onOpenFilterPicker
  } = props

  const hasFilters = Object.keys(pending).length > 0
  const canClear = hasFilters || Object.keys(active).length > 0

  return (
    <div className="mb-sm">
      <div className="row row-between gap-sm mb-sm">
        <div className="field-title">Dataset overview & filters</div>
        <div className="legend">Filters update the visible dataset as you adjust them. Clear filters restores the full dataset.</div>
      </div>

      <div className="row gap-sm wrap">
        <button type="button" onClick={onOpenFilterPicker}>
          + Add filter…
        </button>

        <button onClick={onClear} disabled={!canClear}>
          Clear filters
        </button>
      </div>

      {hasFilters && (
        <div className="row gap-md wrap mt-sm">
          {Object.entries(pending).map(([col, range]) => {
            const { min: overallMin, max: overallMax } = getColumnRangeCached(ds, col)
            const currentMin = Number.isFinite(range.min) ? range.min : overallMin
            const currentMax = Number.isFinite(range.max) ? range.max : overallMax

            return (
              <div key={col} style={styles.filterChip}>
                <span className="legend filter-legend table-filter-label">
                  {col}
                </span>

                <input
                  type="number"
                  value={Number.isFinite(range.min) ? range.min : ''}
                  onChange={e => {
                    const raw = e.target.value
                    const v = raw === '' ? NaN : Number(raw)
                    if (Number.isNaN(v)) {
                      useStore.getState().setPendingFilter(col, { min: NaN, max: range.max })
                      return
                    }
                    const clamped = Math.min(
                      Math.max(overallMin, v),
                      Number.isFinite(range.max) ? range.max : overallMax
                    )
                    useStore.getState().setPendingFilter(col, { min: clamped, max: range.max })
                  }}
                  className="table-filter-number input_number_no_spinner"
                />

                <div className="table-filter-slider">
                  <Slider
                    range
                    min={overallMin}
                    max={overallMax}
                    step={(overallMax - overallMin) * 0.01 || 1}
                    value={[currentMin, currentMax]}
                    onChange={(vals: any) => {
                      const [minVal, maxVal] = vals as number[]
                      useStore.getState().setPendingFilter(col, { min: minVal, max: maxVal })
                    }}
                  />
                </div>

                <input
                  type="number"
                  value={Number.isFinite(range.max) ? range.max : ''}
                  onChange={e => {
                    const raw = e.target.value
                    const v = raw === '' ? NaN : Number(raw)
                    if (Number.isNaN(v)) {
                      useStore.getState().setPendingFilter(col, { min: range.min, max: NaN })
                      return
                    }
                    const clamped = Math.max(
                      Number.isFinite(range.min) ? range.min : overallMin,
                      Math.min(overallMax, v)
                    )
                    useStore.getState().setPendingFilter(col, { min: range.min, max: clamped })
                  }}
                  className="table-filter-number input_number_no_spinner"
                />

                <button onClick={() => removeFilter(col)} className="btn-close" title="Remove this filter">
                  &#x2715;
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
})

/** Table body memoized: re-renders only when page/selection changes */
const TableBody = memo(function TableBody(props: {
  rowIndices: number[]
  cells: string[][]
  selected0: number
  pickedIndices: Int32Array
  onRowClick: (idx: number, e: React.MouseEvent) => void
}) {
  const { rowIndices, cells, selected0, pickedIndices, onRowClick } = props
  const pickedSet = useMemo(() => {
    const s = new Set<number>()
    for (let i = 0; i < pickedIndices.length; i++) s.add(pickedIndices[i])
    return s
  }, [pickedIndices])

  return (
    <tbody>
      {rowIndices.map((idx, r) => {
        const isSel = selected0 === idx
        const isPicked = pickedSet.has(idx)
        return (
          <tr className="table-row-hover"
            key={idx}
            data-pickable="true"
            onClick={(e) => onRowClick(idx, e)}
            style={{ cursor: 'pointer', background: isSel ? 'var(--table-row-selected)' : isPicked ? 'var(--table-row-picked)' : 'transparent' }}
          >
            {cells[r].map((text, c) => (
              <td key={c} style={styles.td} title={text}>
                {text}
              </td>
            ))}
          </tr>
        )
      })}
    </tbody>
  )
})

function truncateLabel(s: string, maxLen = 64) {
  if (s.length <= maxLen) return s
  return s.slice(0, Math.max(0, maxLen - 3)) + '...'
}

function ColumnPickerModal({
  title,
  columns,
  onClose,
  onPick,
}: {
  title: string
  columns: string[]
  onClose: () => void
  onPick: (col: string) => void
}) {
  const [query, setQuery] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = !q
      ? columns
      : columns.filter(c => c.toLowerCase().includes(q))

    return [...base].sort((a, b) => a.localeCompare(b)).slice(0, 80)
  }, [columns, query])

  return (
    <div
      className="modal-overlay"
      onMouseDown={onClose}
    >
      <div
        className="card modal-card modal-lg"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="modal-title">
          {title}
        </div>

        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Type to filter columns..."
          className="input-full mb-md"
        />

        <div className="legend mb-sm">
          Showing {filtered.length.toLocaleString()} of {columns.length.toLocaleString()} matching columns.
        </div>

        <div className="border-strong round-md scroll-panel grid gap-xs p-sm table-picker-list">
          {filtered.length === 0 ? (
            <div className="legend p-sm">
              No matching columns.
            </div>
          ) : (
            filtered.map(col => (
              <button
                key={col}
                type="button"
                onClick={() => onPick(col)}
                title={col}
                className="table-picker-option"
              >
                {truncateLabel(col)}
              </button>
            ))
          )}
        </div>

        <div className="row row-end gap-sm mt-md">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
