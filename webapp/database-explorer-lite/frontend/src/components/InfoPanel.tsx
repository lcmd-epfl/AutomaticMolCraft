import React, { useMemo, useState, useCallback } from 'react'
import Slider from 'rc-slider'
import 'rc-slider/assets/index.css'
import * as OCL from 'openchemlib'
import {
  ChevronRight, ChevronLeft, Search,
  SlidersHorizontal, X, BarChart3, MousePointer2, Plus, Filter
} from 'lucide-react'
import { STRUCTURE_FILTER_KEY, useStore } from '../store/store'
import { useUIStore } from '../store/uiStore'
import { shallow } from 'zustand/shallow'
import DatasetFilterPanel from './DatasetFilterPanel'

// ── Range cache (same logic as DataTable) ────────────────────────────────────
const RANGE_CACHE: WeakMap<object, Map<string, { min: number; max: number }>> = new WeakMap()

type FilterSpec =
  | { kind?: 'range'; min: number; max: number }
  | { kind: 'contains'; query: string; caseSensitive?: boolean }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'smarts'; smilesColumn: string; query: string }
  | { kind: 'similarity'; smilesColumn: string; referenceSmiles: string; threshold: number }

function isContainsFilter(filter: FilterSpec | undefined): filter is { kind: 'contains'; query: string; caseSensitive?: boolean } {
  return filter?.kind === 'contains'
}
function isRangeFilter(filter: FilterSpec | undefined): filter is { kind?: 'range'; min: number; max: number } {
  return !!filter && filter.kind !== 'contains' && filter.kind !== 'boolean' && filter.kind !== 'smarts' && filter.kind !== 'similarity'
}

function getRange(ds: any, col: string): { min: number; max: number } {
  const pre = ds?.stats?.numericRanges?.[col]
  if (pre && Number.isFinite(pre.min) && Number.isFinite(pre.max)) {
    return pre.min === pre.max ? { min: pre.min, max: pre.min + 1 } : pre
  }
  let m = RANGE_CACHE.get(ds as object)
  if (!m) { m = new Map(); RANGE_CACHE.set(ds as object, m) }
  const hit = m.get(col)
  if (hit) return hit
  const arr = ds.columns[col] as any
  let min = Infinity, max = -Infinity
  const n = arr?.length ?? 0
  for (let i = 0; i < n; i++) {
    const v = arr[i]; if (!Number.isFinite(v)) continue
    if (v < min) min = v; if (v > max) max = v
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) { const out = { min: 0, max: 1 }; m.set(col, out); return out }
  if (min === max) max = min + 1
  const out = { min, max }; m.set(col, out); return out
}

function fmt(v: number, short = false): string {
  const a = Math.abs(v)
  if (!Number.isFinite(v)) return '—'
  if (short) {
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M'
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  }
  if (a >= 1000 || (a > 0 && a < 0.01)) return v.toExponential(2)
  if (a >= 100) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

// ── Mini distribution bar ─────────────────────────────────────────────────────
function MiniDist({ ds, col }: { ds: any; col: string }) {
  const bins = useMemo(() => {
    const arr = ds.columns[col] as Float32Array | number[] | undefined
    if (!arr) return []
    const { min, max } = getRange(ds, col)
    const N = 12
    const counts = new Array(N).fill(0)
    const range = max - min || 1
    const n = arr.length
    for (let i = 0; i < n; i++) {
      const v = arr[i]
      if (!Number.isFinite(v)) continue
      const b = Math.min(N - 1, Math.floor(((v - min) / range) * N))
      counts[b]++
    }
    const peak = Math.max(...counts, 1)
    return counts.map(c => c / peak)
  }, [ds, col])

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 18, opacity: 0.7 }}>
      {bins.map((h, i) => (
        <div
          key={i}
          style={{
            width: 4,
            height: Math.max(2, Math.round(h * 18)),
            background: 'var(--accent)',
            borderRadius: 1,
            opacity: 0.6 + h * 0.4,
          }}
        />
      ))}
    </div>
  )
}

// ── Selection stats tab ───────────────────────────────────────────────────────
function computeStats(arr: any, indices: ArrayLike<number> | null, n: number) {
  const idxList = indices ? Array.from({ length: indices.length }, (_, i) => (indices as any)[i]) : null
  const count = idxList ? idxList.length : n
  if (count === 0) return { count: 0, mean: NaN, min: NaN, max: NaN, std: NaN }

  let sum = 0, mn = Infinity, mx = -Infinity
  const getV = idxList ? (k: number) => arr[idxList[k]] : (k: number) => arr[k]

  for (let k = 0; k < count; k++) {
    const v = getV(k)
    if (!Number.isFinite(v)) continue
    sum += v; if (v < mn) mn = v; if (v > mx) mx = v
  }
  const mean = sum / count
  let variance = 0
  for (let k = 0; k < count; k++) {
    const v = getV(k); if (!Number.isFinite(v)) continue
    variance += (v - mean) ** 2
  }
  return { count, mean, min: mn, max: mx, std: Math.sqrt(variance / count) }
}

function SelectionTab() {
  const ds = useStore(s => s.dataset)
  const selectedIndices = useStore(s => s.selectedIndices)
  const pickedIndices = useStore(s => s.pickedIndices)

  const selCount = selectedIndices?.length ?? 0
  const pickedCount = pickedIndices?.length ?? 0
  const totalCount = ds?.ids.length ?? 0

  // Use lasso selection if present, else picked, else nothing
  const activeIndices = selCount > 1 ? selectedIndices : pickedCount > 0 ? pickedIndices : null
  const activeCount = activeIndices ? (activeIndices as any).length : 0
  const label = selCount > 1 ? 'Brushed' : pickedCount > 0 ? 'Picked' : null

  const numericCols = ds?.meta.numericColumns ?? []
  const categoricalCols = ds?.meta.categoricalColumns ?? []
  const filterableCols = useMemo(
    () => Array.from(new Set([...numericCols, ...categoricalCols])),
    [numericCols, categoricalCols]
  )

  const stats = useMemo(() => {
    if (!ds || !activeIndices || activeCount === 0) return []
    return numericCols.slice(0, 40).map(col => {
      const arr = ds.columns[col]
      const sel = computeStats(arr, activeIndices, totalCount)
      const full = computeStats(arr, null, totalCount)
      return { col, sel, full }
    })
  }, [ds, activeIndices, activeCount, numericCols, totalCount])

  if (!ds) return <div className="info-empty">Load a dataset first.</div>

  if (!activeIndices || activeCount === 0) {
    return (
      <div className="info-empty">
        <MousePointer2 size={28} style={{ opacity: 0.3, marginBottom: 8 }} />
        <div>Brush the scatter plot or Ctrl+click rows to see selection statistics.</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <span className="badge badge-green" style={{ marginRight: 6 }}>{label}</span>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{activeCount.toLocaleString()}</span>
        <span className="legend"> / {totalCount.toLocaleString()} molecules</span>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: 'var(--panel)' }}>
              <th style={thStyle}>Column</th>
              <th style={thStyle}>Mean</th>
              <th style={thStyle}>Min</th>
              <th style={thStyle}>Max</th>
              <th style={thStyle} title="vs. full dataset mean">Δ mean</th>
            </tr>
          </thead>
          <tbody>
            {stats.map(({ col, sel, full }) => {
              const delta = sel.mean - full.mean
              const deltaColor = Math.abs(delta) < 0.001 * Math.abs(full.mean + 1e-9) ? 'var(--muted)'
                : delta > 0 ? '#34d399' : '#f87171'
              return (
                <tr key={col} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={tdStyle} title={col}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', maxWidth: 90 }}>
                      {col}
                    </span>
                  </td>
                  <td style={tdStyleNum}>{fmt(sel.mean)}</td>
                  <td style={tdStyleNum}>{fmt(sel.min)}</td>
                  <td style={tdStyleNum}>{fmt(sel.max)}</td>
                  <td style={{ ...tdStyleNum, color: deltaColor }}>
                    {delta > 0 ? '+' : ''}{fmt(delta, true)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const thStyle: React.CSSProperties = {
  padding: '4px 6px',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 10,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
  borderBottom: '1px solid var(--border)',
}
const tdStyle: React.CSSProperties = { padding: '3px 6px', verticalAlign: 'middle' }
const tdStyleNum: React.CSSProperties = { padding: '3px 6px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)', verticalAlign: 'middle' }

// ── Columns tab ───────────────────────────────────────────────────────────────
function ColumnRow({ col, ds, pending, active, activePlotId }: {
  col: string
  ds: any
  pending: FilterSpec | undefined
  active: FilterSpec | undefined
  activePlotId: string | null
}) {
  const range = useMemo(() => getRange(ds, col), [ds, col])
  const setPendingFilter = useStore(s => s.setPendingFilter)
  const updatePlot = useStore(s => s.updatePlot)
  const plots = useStore(s => s.plots, shallow)
  const [filterOpen, setFilterOpen] = useState(false)

  const targetPlot = useMemo(() => {
    if (!activePlotId) return plots.find(p => p.type === 'scatter2d') ?? null
    return plots.find(p => p.id === activePlotId && p.type === 'scatter2d') ?? plots.find(p => p.type === 'scatter2d') ?? null
  }, [activePlotId, plots])

  const setAxis = useCallback((axis: 'x' | 'y') => {
    if (!targetPlot) return
    updatePlot({ ...targetPlot, [axis]: col })
  }, [targetPlot, updatePlot, col])

  const rawCur = pending ?? active
  const cur = isRangeFilter(rawCur) ? rawCur : range
  const isFiltered = active != null

  return (
    <div className="info-col-row" style={{ borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px' }}>
        {/* Name */}
        <span
          style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isFiltered ? 'var(--accent)' : 'var(--fg-dim)' }}
          title={col}
        >
          {col}
        </span>

        {/* Mini dist */}
        <MiniDist ds={ds} col={col} />

        {/* Axis buttons */}
        <button
          className="info-axis-btn"
          onClick={() => setAxis('x')}
          disabled={!targetPlot}
          title={targetPlot ? `Set X axis of "${targetPlot.id}"` : 'No scatter plot active'}
        >
          X
        </button>
        <button
          className="info-axis-btn"
          onClick={() => setAxis('y')}
          disabled={!targetPlot}
          title={targetPlot ? `Set Y axis of "${targetPlot.id}"` : 'No scatter plot active'}
        >
          Y
        </button>

        {/* Filter toggle */}
        <button
          className={`info-axis-btn${filterOpen || isFiltered ? ' info-axis-btn-active' : ''}`}
          onClick={() => setFilterOpen(v => !v)}
          title="Toggle range filter"
        >
          <SlidersHorizontal size={10} />
        </button>
      </div>

      {filterOpen && (
        <div style={{ padding: '0 10px 8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--muted)', marginBottom: 4 }}>
            <span>{fmt(cur.min)}</span>
            <span style={{ opacity: 0.5 }}>{fmt(range.min)} – {fmt(range.max)}</span>
            <span>{fmt(cur.max)}</span>
          </div>
          <Slider
            range
            min={range.min}
            max={range.max}
            step={(range.max - range.min) / 200}
            value={[cur.min, cur.max]}
            onChange={(v: any) => {
              const [lo, hi] = v as number[]
              setPendingFilter(col, { min: lo, max: hi })
            }}
          />
        </div>
      )}
    </div>
  )
}

function ColumnsTab() {
  const ds = useStore(s => s.dataset)
  const pendingFilters = useStore(s => s.pendingFilters)
  const activeFilters = useStore(s => s.activeFilters)
  const clearFilters = useStore(s => s.clearFilters)
  const visibleCount = useStore(s => s.visibleCount)
  const activePlotId = useUIStore(s => s.activePlotId)

  const [query, setQuery] = useState('')

  const allCols = ds?.meta.numericColumns ?? []
  const totalCount = ds?.ids.length ?? 0
  const activeCount = Object.keys(activeFilters).length

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allCols
    return allCols.filter(c => c.toLowerCase().includes(q))
  }, [allCols, query])

  if (!ds) return <div className="info-empty">Load a dataset first.</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Search + filter controls */}
      <div style={{ padding: '8px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ position: 'relative' }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search columns…"
            style={{ width: '100%', paddingLeft: 26, fontSize: 12 }}
          />
        </div>

        {activeCount > 0 && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--fg-dim)', flex: 1 }}>
              <strong style={{ color: 'var(--fg)' }}>{visibleCount.toLocaleString()}</strong>
              {' / '}{totalCount.toLocaleString()} visible
            </span>
            <button
              style={{ padding: '4px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)' }}
              onClick={() => clearFilters()}
            >
              <X size={11} /> Clear
            </button>
          </div>
        )}

        <div className="legend" style={{ fontSize: 10 }}>
          {filtered.length.toLocaleString()} of {allCols.length.toLocaleString()} columns
          {!activePlotId && allCols.length > 0 && (
            <span style={{ color: 'var(--amber)', marginLeft: 6 }}>· click a scatter plot to enable axis buttons</span>
          )}
        </div>
      </div>

      {/* Column list */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {filtered.map(col => (
          <ColumnRow
            key={col}
            col={col}
            ds={ds}
            pending={pendingFilters[col]}
            active={activeFilters[col]}
            activePlotId={activePlotId}
          />
        ))}
        {filtered.length === 0 && (
          <div className="info-empty">No columns match.</div>
        )}
      </div>
    </div>
  )
}

// ── Filters tab ──────────────────────────────────────────────────────────────
function FilterTab() {
  const ds = useStore(s => s.dataset)
  const pendingFilters = useStore(s => s.pendingFilters)
  const activeFilters = useStore(s => s.activeFilters)
  const setPendingFilter = useStore(s => s.setPendingFilter)
  const clearFilters = useStore(s => s.clearFilters)
  const removeFilter = useStore(s => s.removeFilter)
  const visibleCount = useStore(s => s.visibleCount)

  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const structurePending = pendingFilters[STRUCTURE_FILTER_KEY] as FilterSpec | undefined

  const numericCols = ds?.meta.numericColumns ?? []
  const categoricalCols = ds?.meta.categoricalColumns ?? []
  const filterableCols = useMemo(
    () => Array.from(new Set([...numericCols, ...categoricalCols])),
    [numericCols, categoricalCols]
  )
  const totalCount = ds?.ids.length ?? 0
  const columnNames = ds ? (ds.columnOrder ?? Object.keys(ds.columns)) : []
  const smilesAuto = ds
    ? (['smiles', 'SMILES', 'sm'].find(c => Object.prototype.hasOwnProperty.call(ds.columns, c)) ?? '')
    : ''
  const stringCols = useMemo(() => {
    if (!ds) return []
    const out: string[] = []
    for (const c of columnNames) {
      const arr = ds.columns[c] as any
      if (!arr) continue
      if (categoricalCols.includes(c)) {
        out.push(c)
        continue
      }
      const sample = arr.find?.((v: any) => v != null)
      if (typeof sample === 'string') out.push(c)
    }
    return out
  }, [ds, columnNames, categoricalCols])
  const [manualSmilesCol, setManualSmilesCol] = useState('')
  const smilesColumn = manualSmilesCol || smilesAuto
  const [structureMode, setStructureMode] = useState<'smarts' | 'similarity'>('smarts')
  const [smartsQuery, setSmartsQuery] = useState('')
  const [referenceSmiles, setReferenceSmiles] = useState('')
  const [thresholdText, setThresholdText] = useState('0.7')
  const structureError = useMemo(() => {
    if (!ds) return 'Load a dataset to use structure filters.'
    if (!smilesColumn) return 'Select a SMILES column.'
    if (!Object.prototype.hasOwnProperty.call(ds.columns, smilesColumn)) return 'Selected SMILES column is missing.'
    if (structureMode === 'smarts') {
      const q = smartsQuery.trim()
      if (!q) return ''
      try {
        const parser = new OCL.SmilesParser({ smartsMode: 'smarts' })
        parser.parseMolecule(q)
        return ''
      } catch {
        return 'Invalid SMARTS query.'
      }
    }
    const ref = referenceSmiles.trim()
    if (!ref) return ''
    try {
      OCL.Molecule.fromSmiles(ref)
    } catch {
      return 'Invalid reference SMILES.'
    }
    const t = Number(thresholdText)
    if (!Number.isFinite(t) || t < 0 || t > 1) return 'Threshold must be between 0 and 1.'
    return ''
  }, [ds, smilesColumn, structureMode, smartsQuery, referenceSmiles, thresholdText])
  React.useEffect(() => {
    if (!smilesColumn || structureError) {
      if (structurePending) removeFilter(STRUCTURE_FILTER_KEY)
      return
    }
    if (structureMode === 'smarts') {
      const query = smartsQuery.trim()
      if (!query) {
        if (structurePending) removeFilter(STRUCTURE_FILTER_KEY)
        return
      }
      setPendingFilter(STRUCTURE_FILTER_KEY, { kind: 'smarts', smilesColumn, query })
      return
    }
    const reference = referenceSmiles.trim()
    if (!reference) {
      if (structurePending) removeFilter(STRUCTURE_FILTER_KEY)
      return
    }
    setPendingFilter(STRUCTURE_FILTER_KEY, {
      kind: 'similarity',
      smilesColumn,
      referenceSmiles: reference,
      threshold: Number(thresholdText)
    })
  }, [smilesColumn, structureMode, smartsQuery, referenceSmiles, thresholdText, structureError])
  React.useEffect(() => {
    if (!structurePending) return
    if (structurePending.kind === 'smarts') {
      setStructureMode('smarts')
      setSmartsQuery(structurePending.query)
      setManualSmilesCol(structurePending.smilesColumn || '')
      return
    }
    if (structurePending.kind === 'similarity') {
      setStructureMode('similarity')
      setReferenceSmiles(structurePending.referenceSmiles)
      setThresholdText(String(structurePending.threshold))
      setManualSmilesCol(structurePending.smilesColumn || '')
    }
  }, [structurePending])

  const pendingEntries = Object.entries(pendingFilters).filter(([c]) => c !== STRUCTURE_FILTER_KEY)
  const activeOnlyEntries = Object.entries(activeFilters).filter(([c]) => c !== STRUCTURE_FILTER_KEY && !(c in pendingFilters))
  const hasActive = Object.keys(activeFilters).length > 0

  const availableCols = useMemo(
    () => filterableCols.filter(c => !(c in pendingFilters)),
    [filterableCols, pendingFilters]
  )

  const pickerFiltered = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase()
    return q ? availableCols.filter(c => c.toLowerCase().includes(q)) : availableCols
  }, [availableCols, pickerQuery])

  const addFilter = (col: string) => {
    if (!ds) return
    if (numericCols.includes(col)) {
      const { min, max } = getRange(ds, col)
      setPendingFilter(col, { min, max })
    } else {
      setPendingFilter(col, { kind: 'contains', query: '' })
    }
    setPickerOpen(false)
    setPickerQuery('')
  }

  if (!ds) return <div className="info-empty">Load a dataset first.</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Visibility summary + action buttons */}
      <div style={{ padding: '8px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>
            {hasActive
              ? <><strong style={{ color: 'var(--fg)' }}>{visibleCount.toLocaleString()}</strong>{' / '}{totalCount.toLocaleString()} visible</>
              : <>{totalCount.toLocaleString()} molecules — no filters active</>
            }
          </span>
          {hasActive && (
            <button
              style={{ padding: '4px 8px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, color: 'var(--muted)' }}
              onClick={() => clearFilters()}
            >
              <X size={11} /> Clear all
            </button>
          )}
        </div>

        {/* Add filter button */}
        <button
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', fontSize: 12, width: '100%', justifyContent: 'flex-start' }}
          onClick={() => setPickerOpen(v => !v)}
          disabled={availableCols.length === 0}
        >
          <Plus size={13} />
          {availableCols.length === 0 ? 'All columns filtered' : 'Add filter…'}
        </button>

        {/* Column picker */}
        {pickerOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ position: 'relative' }}>
              <Search size={11} style={{ position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
              <input
                autoFocus
                value={pickerQuery}
                onChange={e => setPickerQuery(e.target.value)}
                placeholder="Search columns…"
                style={{ width: '100%', paddingLeft: 24, fontSize: 11 }}
              />
            </div>
            <div style={{ maxHeight: 140, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
              {pickerFiltered.length === 0
                ? <div className="legend" style={{ padding: 8 }}>No columns available.</div>
                : pickerFiltered.map(col => (
                  <button
                    key={col}
                    onClick={() => addFilter(col)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px', fontSize: 11, fontFamily: 'var(--font-mono)', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', borderRadius: 0 }}
                  >
                    {col}
                  </button>
                ))
              }
            </div>
          </div>
        )}
      </div>

      {/* Filter list */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 0 }}>
        <div style={{ borderBottom: '1px solid var(--border)', padding: '8px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
            <span style={{ flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>Structure filter</span>
            {structurePending && <span className="badge" style={{ fontSize: 9 }}>active</span>}
            <button
              className="btn-close"
              style={{ width: 18, height: 18 }}
              onClick={() => removeFilter(STRUCTURE_FILTER_KEY)}
              title="Remove structure filter"
              disabled={!structurePending}
            >
              <X size={10} />
            </button>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <select value={smilesColumn} onChange={e => setManualSmilesCol(e.target.value)} style={{ fontSize: 11, padding: '5px 8px' }}>
              <option value="">Select SMILES column</option>
              {stringCols.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
            <select value={structureMode} onChange={e => setStructureMode(e.target.value as 'smarts' | 'similarity')} style={{ fontSize: 11, padding: '5px 8px' }} disabled={!smilesColumn}>
              <option value="smarts">SMARTS</option>
              <option value="similarity">Similarity</option>
            </select>
            {structureMode === 'smarts' ? (
              <input
                value={smartsQuery}
                onChange={e => setSmartsQuery(e.target.value)}
                placeholder="SMARTS query"
                style={{ width: '100%', fontSize: 11, padding: '5px 8px' }}
                disabled={!smilesColumn}
              />
            ) : (
              <>
                <input
                  value={referenceSmiles}
                  onChange={e => setReferenceSmiles(e.target.value)}
                  placeholder="Reference SMILES"
                  style={{ width: '100%', fontSize: 11, padding: '5px 8px' }}
                  disabled={!smilesColumn}
                />
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={thresholdText}
                  onChange={e => setThresholdText(e.target.value)}
                  placeholder="Threshold 0-1"
                  style={{ width: '100%', fontSize: 11, padding: '5px 8px' }}
                  disabled={!smilesColumn}
                />
              </>
            )}
            {structureError && <div className="legend" style={{ color: '#ffb4b4', fontSize: 10 }}>{structureError}</div>}
            <div className="legend" style={{ fontSize: 10 }}>Live update enabled</div>
          </div>
        </div>

        {/* Pending (editable) filters */}
        {pendingEntries.map(([col, range]) => {
          const isNumeric = numericCols.includes(col)
          const fullRange = isNumeric ? getRange(ds, col) : { min: 0, max: 1 }
          const cur = isRangeFilter(range)
            ? { min: Number.isFinite(range.min) ? range.min : fullRange.min, max: Number.isFinite(range.max) ? range.max : fullRange.max }
            : fullRange
          return (
            <div key={col} style={{ borderBottom: '1px solid var(--border)', padding: '8px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                <span
                  style={{ flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={col}
                >
                  {col}
                </span>
                <button
                  className="btn-close"
                  style={{ width: 18, height: 18 }}
                  onClick={() => removeFilter(col)}
                  title="Remove filter"
                >
                  <X size={10} />
                </button>
              </div>

              {isNumeric && isRangeFilter(range) ? (
                <>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 6 }}>
                    <input
                      type="number"
                      className="input_number_no_spinner"
                      value={Number.isFinite(range.min) ? range.min : ''}
                      onChange={e => {
                        const v = e.target.value === '' ? NaN : Number(e.target.value)
                        setPendingFilter(col, { min: v, max: range.max })
                      }}
                      style={{ flex: 1, fontSize: 11, padding: '4px 6px', fontFamily: 'var(--font-mono)' }}
                    />
                    <span className="legend" style={{ fontSize: 10 }}>-</span>
                    <input
                      type="number"
                      className="input_number_no_spinner"
                      value={Number.isFinite(range.max) ? range.max : ''}
                      onChange={e => {
                        const v = e.target.value === '' ? NaN : Number(e.target.value)
                        setPendingFilter(col, { min: range.min, max: v })
                      }}
                      style={{ flex: 1, fontSize: 11, padding: '4px 6px', fontFamily: 'var(--font-mono)' }}
                    />
                  </div>
                  <Slider
                    range
                    min={fullRange.min}
                    max={fullRange.max}
                    step={(fullRange.max - fullRange.min) / 200 || 0.001}
                    value={[cur.min, cur.max]}
                    onChange={(v: any) => {
                      const [lo, hi] = v as number[]
                      setPendingFilter(col, { min: lo, max: hi })
                    }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--muted)', marginTop: 4 }}>
                    <span>min {fmt(fullRange.min)}</span>
                    <span>max {fmt(fullRange.max)}</span>
                  </div>
                </>
              ) : (
                <input
                  autoFocus
                  value={isContainsFilter(range) ? range.query : ''}
                  onChange={e => setPendingFilter(col, { kind: 'contains', query: e.target.value })}
                  placeholder="Contains..."
                  style={{ width: '100%', fontSize: 11, padding: '5px 8px' }}
                />
              )}
            </div>
          )
        })}

        {/* Applied-only filters (not in pending — shown read-only) */}
        {activeOnlyEntries.map(([col, range]) => (
          <div key={col} style={{ borderBottom: '1px solid var(--border)', padding: '8px 10px', opacity: 0.7 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ flex: 1, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--fg-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={col}>
                {col}
              </span>
              <span className="badge" style={{ fontSize: 9 }}>active</span>
              <button
                className="btn-close"
                style={{ width: 18, height: 18 }}
                onClick={() => removeFilter(col)}
                title="Remove filter"
              >
                <X size={10} />
              </button>
            </div>
            <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--muted)', marginTop: 4 }}>
              {isContainsFilter(range) ? `contains "${range.query}"` : isRangeFilter(range) ? `${fmt(range.min)} - ${fmt(range.max)}` : ''}
            </div>
          </div>
        ))}

        {pendingEntries.length === 0 && activeOnlyEntries.length === 0 && (
          <div className="info-empty">
            <Filter size={24} style={{ opacity: 0.25, marginBottom: 6 }} />
            <div>No filters added yet.</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>Click "Add filter..." to filter by numeric ranges or text contains.</div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── InfoPanel shell ───────────────────────────────────────────────────────────
type Tab = 'selection' | 'columns' | 'filters'

export default function InfoPanel({ style }: { style?: React.CSSProperties } = {}) {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<Tab>('columns')

  const selectedCount = useStore(s => s.selectedIndices?.length ?? 0)
  const pickedCount = useStore(s => s.pickedIndices?.length ?? 0)
  const hasSelection = selectedCount > 1 || pickedCount > 0
  const activeFilterCount = useStore(s => Object.keys(s.activeFilters).length)

  // Auto-switch to selection tab when user makes a selection
  const prevHasSelection = React.useRef(false)
  React.useEffect(() => {
    if (hasSelection && !prevHasSelection.current) setTab('selection')
    prevHasSelection.current = hasSelection
  }, [hasSelection])

  if (!open) {
    return (
      <div className="info-panel-collapsed" onClick={() => setOpen(true)} title="Open info panel">
        <ChevronLeft size={14} style={{ transform: 'rotate(180deg)' }} />
      </div>
    )
  }

  return (
    <div className="info-panel" style={style}>
      {/* Header tabs */}
      <div className="info-panel-header">
        <button
          className={`info-tab-btn${tab === 'selection' ? ' active' : ''}`}
          onClick={() => setTab('selection')}
        >
          <MousePointer2 size={12} />
          Selection
          {hasSelection && <span className="badge" style={{ fontSize: 9, padding: '1px 5px', marginLeft: 2 }}>
            {(selectedCount > 1 ? selectedCount : pickedCount).toLocaleString()}
          </span>}
        </button>
        <button
          className={`info-tab-btn${tab === 'columns' ? ' active' : ''}`}
          onClick={() => setTab('columns')}
        >
          <BarChart3 size={12} />
          Columns
        </button>
        <button
          className={`info-tab-btn${tab === 'filters' ? ' active' : ''}`}
          onClick={() => setTab('filters')}
        >
          <Filter size={12} />
          Filters
          {activeFilterCount > 0 && (
            <span className="badge" style={{ fontSize: 9, padding: '1px 5px', marginLeft: 2 }}>
              {activeFilterCount}
            </span>
          )}
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn-icon" style={{ width: 24, height: 24 }} onClick={() => setOpen(false)} title="Collapse panel">
          <ChevronRight size={13} />
        </button>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {tab === 'selection' ? <SelectionTab /> : tab === 'filters' ? <DatasetFilterPanel /> : <ColumnsTab />}
      </div>
    </div>
  )
}
