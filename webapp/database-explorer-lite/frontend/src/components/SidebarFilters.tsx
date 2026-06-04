import React, { useEffect, useMemo, useState } from 'react'
import Slider from 'rc-slider'
import 'rc-slider/assets/index.css'
import { SlidersHorizontal, ChevronLeft, ChevronRight, X } from 'lucide-react'
import * as OCL from 'openchemlib'
import { STRUCTURE_FILTER_KEY, useStore } from '../store/store'

const RANGE_CACHE: WeakMap<object, Map<string, { min: number; max: number }>> = new WeakMap()

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
    const v = arr[i]
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) { const out = { min: 0, max: 1 }; m.set(col, out); return out }
  if (min === max) max = min + 1
  const out = { min, max }
  m.set(col, out)
  return out
}

function fmt(v: number): string {
  const a = Math.abs(v)
  if (a >= 1000 || (a > 0 && a < 0.01)) return v.toExponential(2)
  if (a >= 100) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

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

function FilterRow({ col, ds, pending, active }: {
  col: string
  ds: any
  pending: FilterSpec | undefined
  active: FilterSpec | undefined
}) {
  const isNumeric = ds?.meta?.numericColumns?.includes(col)
  const range = useMemo(() => isNumeric ? getRange(ds, col) : { min: 0, max: 1 }, [ds, col, isNumeric])
  const setPendingFilter = useStore(s => s.setPendingFilter)
  const removeFilter = useStore(s => s.removeFilter)
  const [open, setOpen] = useState(false)

  const rawCur = pending ?? active
  const cur = isRangeFilter(rawCur) ? rawCur : range
  const containsCur = isContainsFilter(rawCur) ? rawCur : { kind: 'contains' as const, query: '' }
  const isDirty = pending != null
  const isActive = active != null

  return (
    <div className="filter-row">
      <div className="filter-row-header" onClick={() => setOpen(v => !v)}>
        <span className="filter-col-name" title={col}>{col}</span>
        {isActive && <span className="filter-active-dot" title="Filter active" />}
        <span style={{ marginLeft: 4, color: 'var(--muted)', flexShrink: 0 }}>
          {open ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
        </span>
      </div>

      {open && (
        <div className="filter-slider-area">
          {isNumeric ? (
            <>
              <div className="filter-range-vals">
                <span>{fmt(cur.min)}</span>
                <span style={{ color: 'var(--border-bright)' }}>{fmt(range.min)} – {fmt(range.max)}</span>
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
            </>
          ) : (
            <input
              autoFocus
              value={containsCur.query}
              onChange={e => setPendingFilter(col, { kind: 'contains', query: e.target.value })}
              placeholder="Contains..."
              style={{ width: '100%', fontSize: 12 }}
            />
          )}
          {isDirty && (
            <button
              style={{ marginTop: 6, fontSize: 11, padding: '3px 8px', color: 'var(--muted)' }}
              onClick={() => removeFilter(col)}
            >
              Reset
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function SidebarFilters({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const ds = useStore(s => s.dataset)
  const pendingFilters = useStore(s => s.pendingFilters)
  const activeFilters = useStore(s => s.activeFilters)
  const clearFilters = useStore(s => s.clearFilters)
  const setPendingFilter = useStore(s => s.setPendingFilter)
  const removeFilter = useStore(s => s.removeFilter)
  const visibleCount = useStore(s => s.visibleCount)
  const structurePending = pendingFilters[STRUCTURE_FILTER_KEY] as FilterSpec | undefined

  const filterColumns = useMemo(
    () => ds ? Array.from(new Set([...(ds.meta.numericColumns ?? []), ...(ds.meta.categoricalColumns ?? [])])) : [],
    [ds]
  )
  const columnNames = useMemo(() => ds ? (ds.columnOrder ?? Object.keys(ds.columns)) : [], [ds])
  const smilesColumnAuto = useMemo(() => {
    if (!ds) return ''
    return ['smiles', 'SMILES', 'sm'].find(c => Object.prototype.hasOwnProperty.call(ds.columns, c)) ?? ''
  }, [ds])
  const stringColumns = useMemo(() => {
    if (!ds) return []
    const out: string[] = []
    for (const c of columnNames) {
      const arr = ds.columns[c] as any
      if (!arr) continue
      if (ds.meta.categoricalColumns.includes(c)) {
        out.push(c)
        continue
      }
      const sample = arr.find?.((v: any) => v != null)
      if (typeof sample === 'string') out.push(c)
    }
    return out
  }, [ds, columnNames])

  const [manualSmilesColumn, setManualSmilesColumn] = useState('')
  const selectedSmilesColumn = manualSmilesColumn || smilesColumnAuto
  const [structureMode, setStructureMode] = useState<'smarts' | 'similarity'>('smarts')
  const [smartsQuery, setSmartsQuery] = useState('')
  const [referenceSmiles, setReferenceSmiles] = useState('')
  const [thresholdText, setThresholdText] = useState('0.7')

  useEffect(() => {
    if (!structurePending) return
    if (structurePending.kind === 'smarts') {
      setStructureMode('smarts')
      setSmartsQuery(structurePending.query)
      setManualSmilesColumn(structurePending.smilesColumn || '')
      return
    }
    if (structurePending.kind === 'similarity') {
      setStructureMode('similarity')
      setReferenceSmiles(structurePending.referenceSmiles)
      setThresholdText(String(structurePending.threshold))
      setManualSmilesColumn(structurePending.smilesColumn || '')
    }
  }, [structurePending])

  const structureError = useMemo(() => {
    if (!ds) return 'Load a dataset to use structure filters.'
    if (!selectedSmilesColumn) return 'Select a SMILES column.'
    if (!Object.prototype.hasOwnProperty.call(ds.columns, selectedSmilesColumn)) return 'Selected SMILES column is missing.'
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
  }, [ds, selectedSmilesColumn, structureMode, smartsQuery, referenceSmiles, thresholdText])

  useEffect(() => {
    if (!selectedSmilesColumn || structureError) {
      if (structurePending) removeFilter(STRUCTURE_FILTER_KEY)
      return
    }
    if (structureMode === 'smarts') {
      const query = smartsQuery.trim()
      if (!query) {
        if (structurePending) removeFilter(STRUCTURE_FILTER_KEY)
        return
      }
      setPendingFilter(STRUCTURE_FILTER_KEY, { kind: 'smarts', smilesColumn: selectedSmilesColumn, query })
      return
    }
    const reference = referenceSmiles.trim()
    if (!reference) {
      if (structurePending) removeFilter(STRUCTURE_FILTER_KEY)
      return
    }
    setPendingFilter(STRUCTURE_FILTER_KEY, {
      kind: 'similarity',
      smilesColumn: selectedSmilesColumn,
      referenceSmiles: reference,
      threshold: Number(thresholdText)
    })
  }, [selectedSmilesColumn, structureMode, smartsQuery, referenceSmiles, thresholdText, structureError])

  const clearStructureFilter = () => {
    removeFilter(STRUCTURE_FILTER_KEY)
  }
  const activeCount = Object.keys(activeFilters).length
  const totalCount = ds?.ids.length ?? 0

  if (collapsed) {
    return (
      <div className="sidebar-filters sidebar-collapsed" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 10, gap: 8 }}>
        <button className="btn-icon" onClick={onToggle} title="Expand filters">
          <SlidersHorizontal size={15} />
        </button>
        {activeCount > 0 && (
          <span className="badge" style={{ fontSize: 10, padding: '2px 5px' }}>{activeCount}</span>
        )}
      </div>
    )
  }

  return (
    <div className="sidebar-filters">
      <div className="sidebar-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <SlidersHorizontal size={13} style={{ color: 'var(--muted)' }} />
          <span className="sidebar-title">Filters</span>
          {activeCount > 0 && <span className="badge">{activeCount}</span>}
        </div>
        <button className="btn-icon" onClick={onToggle} title="Collapse">
          <ChevronLeft size={14} />
        </button>
      </div>

      {ds && (
        <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
            {activeCount > 0
              ? <><span style={{ color: 'var(--fg-dim)', fontWeight: 600 }}>{visibleCount.toLocaleString()}</span>{' / '}{totalCount.toLocaleString()} visible</>
              : <>{totalCount.toLocaleString()} molecules</>
            }
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {activeCount > 0 && (
              <button
                className="filter-clear-btn"
                style={{ flex: 1 }}
                onClick={clearFilters}
              >
                <X size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      <div className="sidebar-body">
        {!ds && <div className="sidebar-empty">Load a dataset to enable filters.</div>}
        {ds && (
          <div className="filter-row" style={{ paddingBottom: 8, marginBottom: 8, borderBottom: '1px solid var(--border)' }}>
            <div className="filter-row-header">
              <span className="filter-col-name">Structure Filter</span>
              {structurePending && <span className="filter-active-dot" title="Structure filter active" />}
            </div>
            <div className="filter-slider-area" style={{ display: 'grid', gap: 6 }}>
              <label className="legend" style={{ display: 'grid', gap: 4 }}>
                <span>SMILES column</span>
                <select value={selectedSmilesColumn} onChange={e => setManualSmilesColumn(e.target.value)} className="w-full">
                  <option value="">Select column</option>
                  {stringColumns.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <label className="legend" style={{ display: 'grid', gap: 4 }}>
                <span>Filter type</span>
                <select value={structureMode} onChange={e => setStructureMode(e.target.value as 'smarts' | 'similarity')} className="w-full" disabled={!selectedSmilesColumn}>
                  <option value="smarts">SMARTS</option>
                  <option value="similarity">Similarity</option>
                </select>
              </label>
              {structureMode === 'smarts' ? (
                <input
                  value={smartsQuery}
                  onChange={e => setSmartsQuery(e.target.value)}
                  placeholder="SMARTS query"
                  style={{ width: '100%', fontSize: 12 }}
                  disabled={!selectedSmilesColumn}
                />
              ) : (
                <>
                  <input
                    value={referenceSmiles}
                    onChange={e => setReferenceSmiles(e.target.value)}
                    placeholder="Reference SMILES"
                    style={{ width: '100%', fontSize: 12 }}
                    disabled={!selectedSmilesColumn}
                  />
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={thresholdText}
                    onChange={e => setThresholdText(e.target.value)}
                    placeholder="Tanimoto threshold (0-1)"
                    style={{ width: '100%', fontSize: 12 }}
                    disabled={!selectedSmilesColumn}
                  />
                </>
              )}
              {structureError && <div className="legend" style={{ color: '#ffb4b4' }}>{structureError}</div>}
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={clearStructureFilter} disabled={!structurePending}>Remove</button>
              </div>
            </div>
          </div>
        )}
        {ds && filterColumns.length === 0 && <div className="sidebar-empty">No filterable columns found.</div>}
        {ds && filterColumns.map(col => (
          <FilterRow
            key={col}
            col={col}
            ds={ds}
            pending={pendingFilters[col]}
            active={activeFilters[col]}
          />
        ))}
      </div>
    </div>
  )
}
