import React, { useMemo, useState } from 'react'
import Slider from 'rc-slider'
import 'rc-slider/assets/index.css'
import * as OCL from 'openchemlib'
import { Filter, Plus, Search, X } from 'lucide-react'
import { STRUCTURE_FILTER_KEY, useStore } from '../store/store'

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

function isBooleanFilter(filter: FilterSpec | undefined): filter is { kind: 'boolean'; value: boolean } {
  return filter?.kind === 'boolean'
}

function isRangeFilter(filter: FilterSpec | undefined): filter is { kind?: 'range'; min: number; max: number } {
  return !!filter && filter.kind !== 'contains' && filter.kind !== 'boolean' && filter.kind !== 'smarts' && filter.kind !== 'similarity'
}

function isMissingValue(v: any): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'number') return !Number.isFinite(v)
  const s = String(v).trim()
  return s === '' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'null'
}

function normalizeBooleanValue(v: any): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true') return true
    if (s === 'false') return false
  }
  return null
}

function isBooleanColumn(ds: any, col: string): boolean {
  const arr = ds?.columns?.[col] as any
  const n = arr?.length ?? 0
  let seen = false
  for (let i = 0; i < n; i++) {
    const v = arr[i]
    if (isMissingValue(v)) continue
    if (normalizeBooleanValue(v) === null) return false
    seen = true
  }
  return seen
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

function fmt(v: number): string {
  const a = Math.abs(v)
  if (!Number.isFinite(v)) return '-'
  if (a >= 1000 || (a > 0 && a < 0.01)) return v.toExponential(2)
  if (a >= 100) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

export default function DatasetFilterPanel({
  includeStructure = true,
  showPermanentActions = false,
}: {
  includeStructure?: boolean
  showPermanentActions?: boolean
}) {
  const ds = useStore(s => s.dataset)
  const pendingFilters = useStore(s => s.pendingFilters)
  const activeFilters = useStore(s => s.activeFilters)
  const setPendingFilter = useStore(s => s.setPendingFilter)
  const clearFilters = useStore(s => s.clearFilters)
  const removeFilter = useStore(s => s.removeFilter)
  const visibleCount = useStore(s => s.visibleCount)
  const applyFiltersToDataset = useStore(s => s.applyFiltersToDataset)
  const resetToFullDataset = useStore(s => s.resetToFullDataset)

  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmApplyOpen, setConfirmApplyOpen] = useState(false)
  const structurePending = pendingFilters[STRUCTURE_FILTER_KEY] as FilterSpec | undefined

  const numericCols = ds?.meta.numericColumns ?? []
  const categoricalCols = ds?.meta.categoricalColumns ?? []
  const columnNames = useMemo(() => (ds ? (ds.columnOrder ?? Object.keys(ds.columns)) : []), [ds])
  const booleanCols = useMemo(
    () => ds ? columnNames.filter(c => !numericCols.includes(c) && isBooleanColumn(ds, c)) : [],
    [ds, columnNames, numericCols]
  )
  const filterableCols = useMemo(
    () => Array.from(new Set([...numericCols, ...categoricalCols, ...booleanCols])),
    [numericCols, categoricalCols, booleanCols]
  )
  const totalCount = ds?.ids.length ?? 0
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
    if (!includeStructure) return ''
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
  }, [includeStructure, ds, smilesColumn, structureMode, smartsQuery, referenceSmiles, thresholdText])
  React.useEffect(() => {
    if (!includeStructure) return
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
  }, [includeStructure, smilesColumn, structureMode, smartsQuery, referenceSmiles, thresholdText, structureError])
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
  const hasPermanentSubset = hasActive && visibleCount < totalCount

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
    if (booleanCols.includes(col)) {
      setPendingFilter(col, { kind: 'boolean', value: true })
    } else if (numericCols.includes(col)) {
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
      <div style={{ padding: '8px', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1, fontSize: 11, color: 'var(--muted)' }}>
            {hasActive
              ? <><strong style={{ color: 'var(--fg)' }}>{visibleCount.toLocaleString()}</strong>{' / '}{totalCount.toLocaleString()} visible</>
              : <>{totalCount.toLocaleString()} molecules - no filters active</>
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

        <button
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', fontSize: 12, width: '100%', justifyContent: 'flex-start' }}
          onClick={() => setPickerOpen(v => !v)}
          disabled={availableCols.length === 0}
        >
          <Plus size={13} />
          {availableCols.length === 0 ? 'All columns filtered' : 'Add filter...'}
        </button>

        {pickerOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ position: 'relative' }}>
              <Search size={11} style={{ position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', pointerEvents: 'none' }} />
              <input
                autoFocus
                value={pickerQuery}
                onChange={e => setPickerQuery(e.target.value)}
                placeholder="Search columns..."
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

        {showPermanentActions && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, paddingTop: 2 }}>
            <button
              type="button"
              onClick={() => setConfirmApplyOpen(true)}
              disabled={!hasPermanentSubset}
              className="btn-danger"
              style={{ fontSize: 11, padding: '5px 8px' }}
              title={hasActive ? 'Delete rows outside the current filtered subset' : 'Add a filter before applying permanently'}
            >
              Apply permanently
            </button>
            <button
              type="button"
              onClick={resetToFullDataset}
              disabled={!hasActive}
              style={{ fontSize: 11, padding: '5px 8px' }}
            >
              Reset full set
            </button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 0 }}>
        {includeStructure ? (
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
        ) : null}

        {pendingEntries.map(([col, filter]) => {
          const isBoolean = booleanCols.includes(col)
          const isNumeric = numericCols.includes(col)
          const fullRange = isNumeric ? getRange(ds, col) : { min: 0, max: 1 }
          const cur = isRangeFilter(filter)
            ? { min: Number.isFinite(filter.min) ? filter.min : fullRange.min, max: Number.isFinite(filter.max) ? filter.max : fullRange.max }
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

              {isBoolean ? (
                <select
                  value={isBooleanFilter(filter) ? String(filter.value) : 'true'}
                  onChange={e => setPendingFilter(col, { kind: 'boolean', value: e.target.value === 'true' })}
                  style={{ width: '100%', fontSize: 11, padding: '5px 8px' }}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : isNumeric && isRangeFilter(filter) ? (
                <>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 6 }}>
                    <input
                      type="number"
                      className="input_number_no_spinner"
                      value={Number.isFinite(filter.min) ? filter.min : ''}
                      onChange={e => {
                        const v = e.target.value === '' ? NaN : Number(e.target.value)
                        setPendingFilter(col, { min: v, max: filter.max })
                      }}
                      style={{ flex: 1, fontSize: 11, padding: '4px 6px', fontFamily: 'var(--font-mono)' }}
                    />
                    <span className="legend" style={{ fontSize: 10 }}>-</span>
                    <input
                      type="number"
                      className="input_number_no_spinner"
                      value={Number.isFinite(filter.max) ? filter.max : ''}
                      onChange={e => {
                        const v = e.target.value === '' ? NaN : Number(e.target.value)
                        setPendingFilter(col, { min: filter.min, max: v })
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
                  value={isContainsFilter(filter) ? filter.query : ''}
                  onChange={e => setPendingFilter(col, { kind: 'contains', query: e.target.value })}
                  placeholder="Contains..."
                  style={{ width: '100%', fontSize: 11, padding: '5px 8px' }}
                />
              )}
            </div>
          )
        })}

        {activeOnlyEntries.map(([col, filter]) => (
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
              {isBooleanFilter(filter) ? `is ${String(filter.value)}` : isContainsFilter(filter) ? `contains "${filter.query}"` : isRangeFilter(filter) ? `${fmt(filter.min)} - ${fmt(filter.max)}` : ''}
            </div>
          </div>
        ))}

        {pendingEntries.length === 0 && activeOnlyEntries.length === 0 && (
          <div className="info-empty">
            <Filter size={24} style={{ opacity: 0.25, marginBottom: 6 }} />
            <div>No filters added yet.</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>Click "Add filter..." to filter by ranges, text, or boolean values.</div>
          </div>
        )}
      </div>

      {confirmApplyOpen && (
        <div
          className="modal-overlay"
          onMouseDown={() => setConfirmApplyOpen(false)}
        >
          <div
            className="modal-card modal-card-narrow"
            onMouseDown={e => e.stopPropagation()}
          >
            <div className="modal-title">Apply filters permanently?</div>
            <div className="legend mb-md">
              This will delete every molecule outside the current filtered subset.
              <br />
              <b>This cannot be undone.</b>
            </div>
            <div className="actions-row-nowrap">
              <button type="button" onClick={() => setConfirmApplyOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmApplyOpen(false)
                  applyFiltersToDataset()
                }}
                className="btn-danger"
              >
                Yes, delete rows
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
