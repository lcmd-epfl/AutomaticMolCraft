import React, { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { shallow } from 'zustand/shallow'
import { Download, Settings, X } from 'lucide-react'
import 'rc-slider/assets/index.css'
import { useStore } from '../store/store'
import { useUIStore } from '../store/uiStore'
import type { Axis2DSettings, HistogramSettings, ScatterSettings } from '../models/dataModel'
import ScatterPlot from './ScatterPlot'
import ScatterPlot3D from './ScatterPlot3D'
import HistogramPlot from './HistogramPlot'
import { normalizeAxisSettings, normalizeRange } from '../utils/axisSettings'

type PlotSpecAny = any

function specEqual(a: PlotSpecAny, b: PlotSpecAny) {
  if (a === b) return true
  if (!a || !b) return false

  if (a.id !== b.id) return false
  if (a.type !== b.type) return false

  if (a.x !== b.x) return false
  if (a.type !== 'hist1d' && a.y !== b.y) return false
  if (a.type !== 'hist1d' && a.z !== b.z) return false
  if (a.type !== 'hist1d') {
    if (a.colorBy !== b.colorBy) return false
    if (a.sizeBy !== b.sizeBy) return false
    if (JSON.stringify(a.scatterSettings || {}) !== JSON.stringify(b.scatterSettings || {})) return false
  } else if (JSON.stringify(a.histSettings || {}) !== JSON.stringify(b.histSettings || {})) return false

  const ap = a.panel
  const bp = b.panel
  if (!!ap !== !!bp) return false
  if (ap && bp) {
    if (ap.i !== bp.i) return false
    if (ap.x !== bp.x) return false
    if (ap.y !== bp.y) return false
    if (ap.w !== bp.w) return false
    if (ap.h !== bp.h) return false
  }

  return true
}

function truncateLabel(s: string, maxLen = 36) {
  if (s.length <= maxLen) return s
  return s.slice(0, Math.max(0, maxLen - 3)) + '...'
}

function PlotPanel({ plotId }: { plotId: string }) {
  const spec = useStore(
    useCallback((s) => s.plots.find(p => p.id === plotId) ?? null, [plotId]),
    specEqual
  )

  const numericColumns = useStore(s => s.dataset?.meta.numericColumns || [], shallow)
  const categoricalColumns = useStore(s => s.dataset?.meta.categoricalColumns || [], shallow)
  const updatePlot = useStore(s => s.updatePlot)
  const removePlot = useStore(s => s.removePlot)
  const setActivePlotId = useUIStore(s => s.setActivePlotId)
  const pushToast = useUIStore(s => s.pushToast)

  const [axisPicker, setAxisPicker] = useState<null | { axis: 'x' | 'y' | 'z' }>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportNonce, setExportNonce] = useState(0)

  const isHist = spec?.type === 'hist1d'
  const isScatter3D = spec?.type === 'scatter3d'

  const onX = useCallback(
    (x: string) => {
      if (!spec || x === spec.x) return
      startTransition(() => {
        updatePlot({ ...spec, x })
      })
    },
    [updatePlot, spec]
  )

  const onY = useCallback(
    (y: string) => {
      if (!spec || y === spec.y) return
      startTransition(() => {
        updatePlot({ ...spec, y })
      })
    },
    [updatePlot, spec]
  )

  const onRemove = useCallback(() => removePlot(plotId), [removePlot, plotId])
  const onZ = useCallback(
    (z: string) => {
      if (!spec || spec.type === 'hist1d' || z === spec.z) return
      startTransition(() => {
        updatePlot({ ...spec, z })
      })
    },
    [updatePlot, spec]
  )

  if (!spec) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#9fb1c4' }}>
        <div className="legend">Plot not found.</div>
      </div>
    )
  }

  return (
    <>
      <div
        style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        onMouseDown={() => { if (!isHist) setActivePlotId(plotId) }}
      >
        <div className="card-title card-drag-handle">
          <span className="plot-title-label">
            {isHist ? 'Histogram' : isScatter3D ? '3D Scatter Plot' : '2D Scatter Plot'}
          </span>

          <div className="selects" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} onMouseDown={e => e.stopPropagation()}>
            <div>
              <label className="legend" style={{ marginRight: 6 }}>X:</label>
              <button
                type="button"
                onClick={() => setAxisPicker({ axis: 'x' })}
                title={spec.x}
                style={axisButtonStyle}
              >
                {truncateLabel(spec.x)}
              </button>
            </div>

            {!isHist && (
              <div>
                <label className="legend" style={{ marginRight: 6 }}>Y:</label>
                <button
                  type="button"
                  onClick={() => setAxisPicker({ axis: 'y' })}
                  title={spec.y}
                  style={axisButtonStyle}
                >
                  {truncateLabel(spec.y)}
                </button>
              </div>
            )}
            {!isHist && isScatter3D && (
              <div>
                <label className="legend" style={{ marginRight: 6 }}>Z:</label>
                <button
                  type="button"
                  onClick={() => setAxisPicker({ axis: 'z' })}
                  title={spec.z}
                  style={axisButtonStyle}
                >
                  {truncateLabel(spec.z || '')}
                </button>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', height: '100%', gap: 4 }} onMouseDown={e => e.stopPropagation()}>
            {!isHist && (
              <button
                onClick={() => setSettingsOpen(true)}
                title="Scatter settings"
                aria-label="Scatter settings"
                className="btn-icon"
                style={{ width: 24, height: 24, padding: 0 }}
              >
                <Settings size={14} />
              </button>
            )}
            {isHist && (
              <button
                onClick={() => setSettingsOpen(true)}
                title="Histogram settings"
                aria-label="Histogram settings"
                className="btn-icon"
                style={{ width: 24, height: 24, padding: 0 }}
              >
                <Settings size={14} />
              </button>
            )}
            <button
              onClick={() => setExportNonce(n => n + 1)}
              title="Download PNG"
              aria-label="Download PNG"
              className="btn-icon"
              style={{ width: 24, height: 24, padding: 0 }}
            >
              <Download size={14} />
            </button>
            <button
              onClick={onRemove}
              title="Delete plot"
              aria-label="Delete plot"
              className="btn-close"
            >
              &#x2715;
            </button>
          </div>
        </div>

        <div className="plot-host">
          {isHist
            ? <HistogramPlot spec={spec} exportNonce={exportNonce} onExportError={(m) => pushToast(m, 'warning')} />
            : (isScatter3D
              ? <ScatterPlot3D spec={spec} exportNonce={exportNonce} onExportError={(m) => pushToast(m, 'warning')} />
              : <ScatterPlot spec={spec} exportNonce={exportNonce} onExportError={(m) => pushToast(m, 'warning')} />)}
        </div>
      </div>

      {axisPicker && (
        <AxisPickerModal
          title={axisPicker.axis === 'x' ? 'Choose X axis' : axisPicker.axis === 'y' ? 'Choose Y axis' : 'Choose Z axis'}
          columns={numericColumns}
          currentValue={axisPicker.axis === 'x' ? spec.x : axisPicker.axis === 'y' ? spec.y : (spec.z || '')}
          onClose={() => setAxisPicker(null)}
          onPick={(col) => {
            if (axisPicker.axis === 'x') onX(col)
            else if (axisPicker.axis === 'y') onY(col)
            else onZ(col)
            setAxisPicker(null)
          }}
        />
      )}

      {settingsOpen && !isHist && createPortal(
        <ScatterSettingsModal
          spec={spec}
          numericColumns={numericColumns}
          categoricalColumns={categoricalColumns}
          is3D={isScatter3D}
          onClose={() => setSettingsOpen(false)}
          onUpdate={(scatterSettings) => {
            updatePlot({
              ...spec,
              scatterSettings,
              sizeBy: scatterSettings.sizeBy,
              colorBy: scatterSettings.colorBy,
            })
          }}
        />,
        document.body
      )}
      {settingsOpen && isHist && createPortal(
        <HistogramSettingsModal
          spec={spec}
          onClose={() => setSettingsOpen(false)}
          onUpdate={(histSettings) => {
            updatePlot({
              ...spec,
              histSettings,
            })
          }}
        />,
        document.body
      )}
    </>
  )
}

export default React.memo(PlotPanel)

function AxisPickerModal({
  title,
  columns,
  currentValue,
  onClose,
  onPick,
}: {
  title: string
  columns: string[]
  currentValue: string
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

    const sorted = [...base].sort((a, b) => {
      if (a === currentValue) return -1
      if (b === currentValue) return 1
      return a.localeCompare(b)
    })

    return sorted.slice(0, 80)
  }, [columns, query, currentValue])

  return (
    <div
      style={overlayStyle}
      onMouseDown={onClose}
    >
      <div
        className="card"
        style={modalStyle}
        onMouseDown={e => e.stopPropagation()}
      >
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>
          {title}
        </div>

        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Type to filter columns..."
          style={{
            width: '100%',
            marginBottom: 10,
            padding: '8px 10px',
            borderRadius: 8,
          }}
        />

        <div className="legend mb-sm">
          Showing {filtered.length.toLocaleString()} of {columns.length.toLocaleString()} matching columns.
        </div>

        <div
          style={{
            border: '1px solid #223246',
            borderRadius: 8,
            maxHeight: 320,
            overflow: 'auto',
            display: 'grid',
            gap: 4,
            padding: 6,
          }}
        >
          {filtered.length === 0 ? (
            <div className="legend" style={{ padding: 8 }}>
              No matching columns.
            </div>
          ) : (
            filtered.map(col => {
              const selected = col === currentValue
              return (
                <button
                  key={col}
                  type="button"
                  onClick={() => onPick(col)}
                  title={col}
                  style={{
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: selected ? '1px solid #4d7ea8' : '1px solid #223246',
                    background: selected ? '#13202b' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: selected ? 700 : 500 }}>
                    {truncateLabel(col, 64)}
                  </div>
                  {selected ? (
                    <div className="legend">Current axis</div>
                  ) : null}
                </button>
              )
            })
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10, gap: 8 }}>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

const axisButtonStyle: React.CSSProperties = {
  minWidth: 150,
  maxWidth: 220,
  textAlign: 'left',
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid #223246',
  background: 'transparent',
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  zIndex: 9999,
  display: 'grid',
  placeItems: 'center',
  padding: 16,
}

const modalStyle: React.CSSProperties = {
  width: 'min(720px, 96vw)',
  padding: 14,
  borderRadius: 12,
}

const DEFAULT_SCATTER_SETTINGS: ScatterSettings = {
  markerSize: 3,
  markerShape: 'circle',
  markerColor: '#5ac8fa',
  colorSource: 'fixed',
  forceCategoricalColorBy: false,
  colorPalette: 'tealSunset',
  densityMethod: 'binFrequency',
  densitySmoothing: 1.5,
  densityScale: 'linear',
  backgroundColor: '',
  showColorbar: true,
  showXAxis: true,
  showYAxis: true,
  showTickLabels: true,
  showGrid: false,
  gridDensity: 'auto',
  preserveAspectRatio: false,
  opacity: 0.86,
  dimUnselected: false,
  showStats: false,
}

function normalizeScatterSettings(spec: any): ScatterSettings {
  const stored = spec.scatterSettings || {}
  return {
    ...DEFAULT_SCATTER_SETTINGS,
    ...stored,
    sizeBy: stored.sizeBy ?? spec.sizeBy,
    colorBy: stored.colorBy ?? spec.colorBy,
    colorSource: stored.colorSource ?? ((stored.colorBy ?? spec.colorBy) ? 'column' : 'fixed'),
  }
}

function AxisSettingsSection({
  title,
  axis,
  fallbackLabel,
  fullRange,
  onChange,
}: {
  title: string
  axis: Axis2DSettings | undefined
  fallbackLabel: string
  fullRange: [number, number]
  onChange: (axis: Axis2DSettings) => void
}) {
  const normalized = normalizeAxisSettings(axis)
  const range = normalizeRange(normalized.range, fullRange)
  const [drafts, setDrafts] = useState(() => ({
    labelSize: String(normalized.labelSize),
    min: String(range[0]),
    max: String(range[1]),
    tickCount: String(normalized.tickCount),
    tickDecimals: String(normalized.tickDecimals),
    tickLabelSize: String(normalized.tickLabelSize),
  }))

  useEffect(() => {
    setDrafts({
      labelSize: String(normalized.labelSize),
      min: String(range[0]),
      max: String(range[1]),
      tickCount: String(normalized.tickCount),
      tickDecimals: String(normalized.tickDecimals),
      tickLabelSize: String(normalized.tickLabelSize),
    })
  }, [
    normalized.labelSize,
    normalized.tickCount,
    normalized.tickDecimals,
    normalized.tickLabelSize,
    range[0],
    range[1],
  ])

  const commitNumber = (
    key: keyof typeof drafts,
    apply: (value: number) => void
  ) => {
    const value = Number(drafts[key].trim())
    if (!Number.isFinite(value)) {
      setDrafts((prev) => ({ ...prev, [key]: String(key === 'min' ? range[0] : key === 'max' ? range[1] : normalized[key as keyof typeof normalized]) }))
      return
    }
    apply(value)
  }

  return (
    <SettingsSection title={title}>
      <label className="setting-row">
        <span>Label</span>
        <input
          type="text"
          value={normalized.label || ''}
          placeholder={fallbackLabel}
          onChange={e => onChange({ ...normalized, label: e.target.value })}
        />
      </label>
      <div className="setting-actions">
        <button type="button" onClick={() => onChange({ ...normalized, label: '' })}>Reset label</button>
      </div>
      <label className="setting-row">
        <span>Label size</span>
        <input
          type="number"
          min={6}
          max={48}
          step={1}
          value={drafts.labelSize}
          onChange={e => setDrafts((prev) => ({ ...prev, labelSize: e.target.value }))}
          onBlur={() => commitNumber('labelSize', (value) => onChange({ ...normalized, labelSize: clampNumber(value, 6, 48) }))}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
      </label>
      <label className="setting-row">
        <span>Min</span>
        <input
          type="number"
          value={drafts.min}
          onChange={e => setDrafts((prev) => ({ ...prev, min: e.target.value }))}
          onBlur={() => commitNumber('min', (value) => onChange({ ...normalized, range: [Math.min(value, range[1] - Number.EPSILON), range[1]] }))}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
      </label>
      <label className="setting-row">
        <span>Max</span>
        <input
          type="number"
          value={drafts.max}
          onChange={e => setDrafts((prev) => ({ ...prev, max: e.target.value }))}
          onBlur={() => commitNumber('max', (value) => onChange({ ...normalized, range: [range[0], Math.max(value, range[0] + Number.EPSILON)] }))}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
      </label>
      <div className="setting-actions">
        <button type="button" onClick={() => onChange({ ...normalized, range: fullRange })}>Reset range</button>
      </div>
      <label className="setting-row">
        <span>Tick count</span>
        <input
          type="number"
          min={2}
          max={100}
          step={1}
          value={drafts.tickCount}
          onChange={e => setDrafts((prev) => ({ ...prev, tickCount: e.target.value }))}
          onBlur={() => commitNumber('tickCount', (value) => onChange({ ...normalized, tickCount: clampNumber(value, 2, 100) }))}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
      </label>
      <label className="setting-row">
        <span>Tick decimals</span>
        <input
          type="number"
          min={0}
          max={12}
          step={1}
          value={drafts.tickDecimals}
          onChange={e => setDrafts((prev) => ({ ...prev, tickDecimals: e.target.value }))}
          onBlur={() => commitNumber('tickDecimals', (value) => onChange({ ...normalized, tickDecimals: clampNumber(value, 0, 12) }))}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
      </label>
      <label className="setting-row">
        <span>Tick label size</span>
        <input
          type="number"
          min={6}
          max={48}
          step={1}
          value={drafts.tickLabelSize}
          onChange={e => setDrafts((prev) => ({ ...prev, tickLabelSize: e.target.value }))}
          onBlur={() => commitNumber('tickLabelSize', (value) => onChange({ ...normalized, tickLabelSize: clampNumber(value, 6, 48) }))}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
        />
      </label>
    </SettingsSection>
  )
}

function ScatterSettingsModal({
  spec,
  numericColumns,
  categoricalColumns,
  is3D,
  onClose,
  onUpdate,
}: {
  spec: any
  numericColumns: string[]
  categoricalColumns: string[]
  is3D: boolean
  onClose: () => void
  onUpdate: (settings: ScatterSettings) => void
}) {
  const settings = normalizeScatterSettings(spec)
  const ds = useStore(s => s.dataset)
  const visibleMask = useStore(s => s.visibleMask)
  const theme = useUIStore(s => s.theme)
  const themeBg = useMemo(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#0f141a',
    [theme]
  )
  const shapeColumns = useMemo(
    () => Array.from(new Set([...categoricalColumns, ...numericColumns])),
    [categoricalColumns, numericColumns]
  )
  const colorColumns = useMemo(
    () => Array.from(new Set([...numericColumns, ...categoricalColumns])),
    [numericColumns, categoricalColumns]
  )
  const categoricalColorSelected = Boolean(
    settings.colorBy && (settings.forceCategoricalColorBy || categoricalColumns.includes(settings.colorBy))
  )

  const axisFullRange = useCallback((column: string): [number, number] => {
    const values = ds?.columns?.[column] as Float32Array | Int32Array | undefined
    if (!values?.length) return [0, 1]
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < values.length; i++) {
      if (visibleMask && visibleMask[i] !== 1) continue
      const v = Number(values[i])
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
    if (min === max) max = min + 1
    return [min, max]
  }, [ds, visibleMask])

  const xFullRange = useMemo(() => axisFullRange(spec.x), [axisFullRange, spec.x])
  const yFullRange = useMemo(() => axisFullRange(spec.y), [axisFullRange, spec.y])
  const zFullRange = useMemo(() => axisFullRange(spec.z || ''), [axisFullRange, spec.z])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const patch = (partial: Partial<ScatterSettings>) => {
    onUpdate({ ...settings, ...partial })
  }
  const requestView = (type: NonNullable<ScatterSettings['viewCommand']>['type']) => {
    patch({ viewCommand: { type, nonce: Date.now() } })
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-card scatter-settings-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="scatter-settings-header">
          <div className="modal-title" style={{ marginBottom: 0 }}>Scatter Settings</div>
          <button type="button" className="scatter-settings-close" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
            <X size={18} />
            <span>Close</span>
          </button>
        </div>

        <div className="scatter-settings-grid">
          <SettingsSection title="Marker Size">
            <label className="setting-row">
              <span>Fixed size</span>
              <input
                type="number"
                min={1}
                max={24}
                step={1}
                value={settings.markerSize}
                onChange={e => patch({ markerSize: clampNumber(Number(e.target.value), 1, 24) })}
              />
            </label>
            <label className="setting-row">
              <span>Size by</span>
              <select value={settings.sizeBy || ''} onChange={e => patch({ sizeBy: e.target.value || undefined })}>
                <option value="">Fixed</option>
                {numericColumns.map(col => <option key={col} value={col}>{col}</option>)}
              </select>
            </label>
          </SettingsSection>

          <SettingsSection title="Marker Shape">
            <label className="setting-row">
              <span>Fixed shape</span>
              <select value={settings.markerShape} disabled={is3D} onChange={e => patch({ markerShape: e.target.value as ScatterSettings['markerShape'] })}>
                <option value="circle">Circle</option>
                <option value="square">Square</option>
                <option value="diamond">Diamond</option>
                <option value="triangle">Triangle</option>
              </select>
            </label>
            <label className="setting-row">
              <span>Shape by</span>
              <select value={settings.shapeBy || ''} disabled={is3D} onChange={e => patch({ shapeBy: e.target.value || undefined })}>
                <option value="">Fixed</option>
                {shapeColumns.map(col => <option key={col} value={col}>{col}</option>)}
              </select>
            </label>
          </SettingsSection>

          <SettingsSection title="Marker Color">
            <label className="setting-row">
              <span>Fixed color</span>
              <input type="color" value={settings.markerColor} onChange={e => patch({ markerColor: e.target.value })} />
            </label>
            <label className="setting-row">
              <span>{categoricalColorSelected ? 'Categorical palette' : 'Palette'}</span>
              <select value={settings.colorPalette || 'tealSunset'} onChange={e => patch({ colorPalette: e.target.value as ScatterSettings['colorPalette'] })}>
                <option value="tealSunset">{categoricalColorSelected ? 'Tableau 20' : 'Teal Sunset'}</option>
                <option value="viridis">{categoricalColorSelected ? 'Viridis contrast' : 'Viridis'}</option>
                <option value="plasma">{categoricalColorSelected ? 'Plasma contrast' : 'Plasma'}</option>
                <option value="cividis">{categoricalColorSelected ? 'Cividis contrast' : 'Cividis'}</option>
                <option value="turbo">{categoricalColorSelected ? 'Turbo contrast' : 'Turbo'}</option>
              </select>
            </label>
            {!is3D && <label className="setting-row">
              <span>Color source</span>
              <select
                value={settings.colorSource || 'fixed'}
                onChange={e => patch({ colorSource: e.target.value as ScatterSettings['colorSource'] })}
              >
                <option value="fixed">Fixed</option>
                <option value="column">Column</option>
                <option value="density">Density / frequency</option>
              </select>
            </label>}
            {(is3D || settings.colorSource === 'column') && <label className="setting-row">
              <span>Color by</span>
              <select
                value={settings.colorBy || ''}
                onChange={e => {
                  const col = e.target.value || undefined
                  patch({ colorBy: col, forceCategoricalColorBy: col ? categoricalColumns.includes(col) : false })
                }}
              >
                <option value="">Fixed</option>
                {colorColumns.map(col => <option key={col} value={col}>{col}</option>)}
              </select>
            </label>}
            {!is3D && settings.colorSource === 'density' && <>
              <label className="setting-row">
                <span>Method</span>
                <select value={settings.densityMethod || 'binFrequency'} onChange={e => patch({ densityMethod: e.target.value as ScatterSettings['densityMethod'] })}>
                  <option value="binFrequency">Bin frequency</option>
                  <option value="kde">KDE density</option>
                </select>
              </label>
              <label className="setting-row">
                <span>Grid resolution</span>
                <select value={settings.densityGridSize || ''} onChange={e => patch({ densityGridSize: e.target.value ? Number(e.target.value) : undefined })}>
                  <option value="">Auto</option>
                  <option value="24">24 x 24</option>
                  <option value="48">48 x 48</option>
                  <option value="72">72 x 72</option>
                  <option value="96">96 x 96</option>
                </select>
              </label>
              {settings.densityMethod === 'kde' && <label className="setting-row">
                <span>Smoothing</span>
                <input type="range" min={0.5} max={4} step={0.25} value={settings.densitySmoothing || 1.5} onChange={e => patch({ densitySmoothing: Number(e.target.value) })} />
              </label>}
              <label className="setting-row">
                <span>Color scale</span>
                <select value={settings.densityScale || 'linear'} onChange={e => patch({ densityScale: e.target.value as ScatterSettings['densityScale'] })}>
                  <option value="linear">Linear</option>
                  <option value="log">Log</option>
                </select>
              </label>
            </>}
            <label className="setting-check">
              <input type="checkbox" checked={settings.showColorbar} disabled={is3D ? !settings.colorBy : settings.colorSource === 'fixed' || (settings.colorSource === 'column' && !settings.colorBy)} onChange={e => patch({ showColorbar: e.target.checked })} />
              <span>Show colorbar</span>
            </label>
            <label className="setting-check">
              <input type="checkbox" checked={!!settings.forceCategoricalColorBy} disabled={is3D ? !settings.colorBy : settings.colorSource !== 'column' || !settings.colorBy} onChange={e => patch({ forceCategoricalColorBy: e.target.checked })} />
              <span>Categorical</span>
            </label>
          </SettingsSection>

          <SettingsSection title="Graphical View">
            <label className="setting-row">
              <span>Background</span>
              <input type="color" value={settings.backgroundColor || themeBg} onChange={e => patch({ backgroundColor: e.target.value })} />
            </label>
            <div className="setting-check-grid">
              {!is3D && <label className="setting-check"><input type="checkbox" checked={settings.showXAxis} onChange={e => patch({ showXAxis: e.target.checked })} /><span>X axis</span></label>}
              {!is3D && <label className="setting-check"><input type="checkbox" checked={settings.showYAxis} onChange={e => patch({ showYAxis: e.target.checked })} /><span>Y axis</span></label>}
              {!is3D && <label className="setting-check"><input type="checkbox" checked={settings.showTickLabels} onChange={e => patch({ showTickLabels: e.target.checked })} /><span>Tick labels</span></label>}
              {!is3D && <label className="setting-check"><input type="checkbox" checked={settings.showGrid} onChange={e => patch({ showGrid: e.target.checked })} /><span>Grid</span></label>}
              {!is3D && <label className="setting-check"><input type="checkbox" checked={settings.preserveAspectRatio} onChange={e => patch({ preserveAspectRatio: e.target.checked })} /><span>Preserve aspect</span></label>}
              <label className="setting-check"><input type="checkbox" checked={settings.dimUnselected} onChange={e => patch({ dimUnselected: e.target.checked })} /><span>Dim unselected</span></label>
            </div>
            {!is3D && (
              <label className="setting-row">
                <span>Grid density</span>
                <select value={settings.gridDensity} disabled={!settings.showGrid} onChange={e => patch({ gridDensity: e.target.value as ScatterSettings['gridDensity'] })}>
                  <option value="auto">Auto</option>
                  <option value="light">Light</option>
                  <option value="dense">Dense</option>
                </select>
              </label>
            )}
            <label className="setting-row">
              <span>Point opacity</span>
              <input type="range" min={0.1} max={1} step={0.05} value={settings.opacity} onChange={e => patch({ opacity: Number(e.target.value) })} />
            </label>
            <div className="setting-actions">
              <button type="button" onClick={() => requestView('fitAll')}>Fit all</button>
              <button type="button" onClick={() => requestView('fitVisible')}>Fit visible</button>
              <button type="button" onClick={() => requestView('reset')}>Reset zoom</button>
            </div>
          </SettingsSection>

          <AxisSettingsSection
            title="X Axis"
            axis={settings.xAxis}
            fallbackLabel={spec.x}
            fullRange={xFullRange}
            onChange={(xAxis) => patch({ xAxis })}
          />

          <AxisSettingsSection
            title="Y Axis"
            axis={settings.yAxis}
            fallbackLabel={spec.y}
            fullRange={yFullRange}
            onChange={(yAxis) => patch({ yAxis })}
          />

          {is3D && (
            <AxisSettingsSection
              title="Z Axis"
              axis={settings.zAxis}
              fallbackLabel={spec.z || 'z'}
              fullRange={zFullRange}
              onChange={(zAxis) => patch({ zAxis })}
            />
          )}

          <SettingsSection title="Statistical View">
            <label className="setting-check">
              <input type="checkbox" checked={settings.showStats} onChange={e => patch({ showStats: e.target.checked })} />
              <span>Show summary and correlation</span>
            </label>
          </SettingsSection>
        </div>
      </div>
    </div>
  )
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="scatter-settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function clampNumber(v: number, lo: number, hi: number) {
  if (!Number.isFinite(v)) return lo
  return Math.max(lo, Math.min(hi, v))
}

const DEFAULT_HIST_SETTINGS: HistogramSettings = {
  binCount: 40,
  showStats: false,
  backgroundColor: '',
  barFillColor: '#5ac8fa',
  barBorderColor: '#285a78',
  barOpacity: 0.75,
  showXAxis: true,
  showYAxis: true,
  showTickLabels: true,
  showGrid: false,
  gridDensity: 'auto',
  highlightSelectedBin: true,
  dimUnselectedBins: false,
}

function normalizeHistSettings(spec: any): HistogramSettings {
  return {
    ...DEFAULT_HIST_SETTINGS,
    ...(spec.histSettings || {}),
    binCount: clampNumber(Number(spec.histSettings?.binCount ?? DEFAULT_HIST_SETTINGS.binCount), 1, 5000),
    barOpacity: clampNumber(Number(spec.histSettings?.barOpacity ?? DEFAULT_HIST_SETTINGS.barOpacity), 0.05, 1),
  }
}

function HistogramSettingsModal({
  spec,
  onClose,
  onUpdate,
}: {
  spec: any
  onClose: () => void
  onUpdate: (settings: HistogramSettings) => void
}) {
  const settings = normalizeHistSettings(spec)
  const ds = useStore(s => s.dataset)
  const visibleMask = useStore(s => s.visibleMask)
  const categoricalColumns = useStore(s => s.dataset?.meta.categoricalColumns || [], shallow)
  const theme = useUIStore(s => s.theme)
  const themeBg = useMemo(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#0f141a',
    [theme]
  )

  const fullRange = useMemo(() => {
    const values = ds?.columns?.[spec.x] as Float32Array | Int32Array | undefined
    if (!values || values.length === 0) return { min: 0, max: 1 }
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < values.length; i++) {
      if (visibleMask && visibleMask[i] !== 1) continue
      const v = Number(values[i])
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 }
    if (min === max) max = min + 1
    return { min, max }
  }, [ds, spec.x, visibleMask])

  const eligibleGroupColumns = useMemo(() => {
    if (!ds) return []
    return categoricalColumns.filter(col => {
      const vals = ds.columns[col]
      if (!Array.isArray(vals)) return false
      return new Set(vals).size <= 100
    })
  }, [ds, categoricalColumns])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const patch = (partial: Partial<HistogramSettings>) => onUpdate({ ...settings, ...partial })
  const requestView = (type: NonNullable<HistogramSettings['viewCommand']>['type']) => {
    patch({ viewCommand: { type, nonce: Date.now() } })
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal-card scatter-settings-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="scatter-settings-header">
          <div className="modal-title" style={{ marginBottom: 0 }}>Histogram Settings</div>
          <button type="button" className="scatter-settings-close" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
            <X size={18} />
            <span>Close</span>
          </button>
        </div>
        <div className="scatter-settings-grid">
          <SettingsSection title="Data">
            <label className="setting-row">
              <span>Bin count</span>
              <input
                type="number"
                min={1}
                max={5000}
                step={1}
                value={settings.binCount}
                onChange={e => patch({ binCount: clampNumber(Number(e.target.value), 1, 5000), binSize: undefined })}
              />
            </label>
            <label className="setting-row">
              <span>Bin size</span>
              <input
                type="number"
                min={0}
                step="any"
                value={settings.binSize ?? ''}
                onChange={e => {
                  const v = e.target.value === '' ? undefined : Number(e.target.value)
                  patch({ binSize: Number.isFinite(v as number) && (v as number) > 0 ? (v as number) : undefined })
                }}
              />
            </label>
            <label className="setting-check">
              <input type="checkbox" checked={settings.showStats} onChange={e => patch({ showStats: e.target.checked })} />
              <span>Show stats panel</span>
            </label>
            {eligibleGroupColumns.length > 0 && (
              <label className="setting-row">
                <span>Split by</span>
                <select
                  value={settings.groupBy ?? ''}
                  onChange={e => patch({ groupBy: e.target.value || undefined })}
                >
                  <option value="">None</option>
                  {eligibleGroupColumns.map(col => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </label>
            )}
          </SettingsSection>

          <SettingsSection title="Graphical View">
            <label className="setting-row"><span>Background</span><input type="color" value={settings.backgroundColor || themeBg} onChange={e => patch({ backgroundColor: e.target.value })} /></label>
            <label className="setting-row"><span>Bar fill</span><input type="color" value={settings.barFillColor} onChange={e => patch({ barFillColor: e.target.value })} /></label>
            <label className="setting-row"><span>Bar border</span><input type="color" value={settings.barBorderColor} onChange={e => patch({ barBorderColor: e.target.value })} /></label>
            <label className="setting-row"><span>Bar opacity</span><input type="range" min={0.05} max={1} step={0.05} value={settings.barOpacity} onChange={e => patch({ barOpacity: Number(e.target.value) })} /></label>
            <div className="setting-check-grid">
              <label className="setting-check"><input type="checkbox" checked={settings.showXAxis} onChange={e => patch({ showXAxis: e.target.checked })} /><span>X axis</span></label>
              <label className="setting-check"><input type="checkbox" checked={settings.showYAxis} onChange={e => patch({ showYAxis: e.target.checked })} /><span>Y axis</span></label>
              <label className="setting-check"><input type="checkbox" checked={settings.showTickLabels} onChange={e => patch({ showTickLabels: e.target.checked })} /><span>Tick labels</span></label>
              <label className="setting-check"><input type="checkbox" checked={settings.showGrid} onChange={e => patch({ showGrid: e.target.checked })} /><span>Grid</span></label>
              <label className="setting-check"><input type="checkbox" checked={settings.highlightSelectedBin} onChange={e => patch({ highlightSelectedBin: e.target.checked })} /><span>Highlight bin</span></label>
              <label className="setting-check"><input type="checkbox" checked={settings.dimUnselectedBins} onChange={e => patch({ dimUnselectedBins: e.target.checked })} /><span>Dim others</span></label>
            </div>
            <label className="setting-row">
              <span>Grid density</span>
              <select value={settings.gridDensity} disabled={!settings.showGrid} onChange={e => patch({ gridDensity: e.target.value as HistogramSettings['gridDensity'] })}>
                <option value="auto">Auto</option>
                <option value="light">Light</option>
                <option value="dense">Dense</option>
              </select>
            </label>
            <div className="setting-actions">
              <button type="button" onClick={() => requestView('fitAll')}>Fit all</button>
              <button type="button" onClick={() => requestView('reset')}>Reset zoom</button>
            </div>
          </SettingsSection>

          <AxisSettingsSection
            title="X Axis"
            axis={settings.xAxis}
            fallbackLabel={spec.x}
            fullRange={[fullRange.min, fullRange.max]}
            onChange={(xAxis) => patch({ xAxis })}
          />
        </div>
      </div>
    </div>
  )
}
