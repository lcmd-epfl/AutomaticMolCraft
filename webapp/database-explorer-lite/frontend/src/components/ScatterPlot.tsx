// frontend/src/components/ScatterPlot.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { ScatterplotLayer } from '@deck.gl/layers'
import { OrthographicView } from '@deck.gl/core'
import 'rc-slider/assets/index.css'
import { useStore } from '../store/store'
import { useUIStore } from '../store/uiStore'
import { perfHasMark, perfMarkEnd } from '../utils/perfMetrics'
import { exportHostCanvasesToPng } from '../utils/plotExport'
import type { ScatterPlotSpec, ScatterSettings } from '../models/dataModel'
import { axisLabelExpressionToPlainText, formatAxisTick, generateLinearTicks, normalizeAxisSettings, normalizeRange, resolveAxisLabel } from '../utils/axisSettings'
import { MAX_AUTO_CATEGORICAL_CLASSES, categoryLabelForValue, collectCategoryLegend, colorForCategoryLabel, paletteStops, rampColor, resolveScatterColorMode } from '../utils/scatterColor'
import AxisLabelText from './AxisLabelText'

type Bounds = { xmin: number; xmax: number; ymin: number; ymax: number }

const ZOOM_MIN = -8
const ZOOM_MAX = 22
const INTERACTION_SAMPLE_LIMIT = 50000
const LARGE_DATA_POINT_THRESHOLD = 75000

const COLOR_BASE: [number, number, number, number] = [90, 200, 250, 220]
const COLOR_NONE: [number, number, number, number] = [0, 0, 0, 0]
const COLOR_SEL_FILL: [number, number, number, number] = [255, 255, 255, 250]
const COLOR_SEL_LINE: [number, number, number, number] = [20, 120, 180, 255]
const COLOR_PICK_FILL: [number, number, number, number] = [255, 196, 64, 250]
const COLOR_PICK_LINE: [number, number, number, number] = [180, 110, 12, 255]
const SIZE_MIN = 2
const SIZE_MAX = 12
const STATS_SAMPLE_LIMIT = 50000
const EXACT_SHAPE_LIMIT = 4000

const DEFAULT_SCATTER_SETTINGS: ScatterSettings = {
  markerSize: 3,
  markerShape: 'circle',
  markerColor: '#5ac8fa',
  forceCategoricalColorBy: false,
  colorPalette: 'tealSunset',
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

// ✅ Fix 1: stable view object (do NOT recreate per render)
const ORTHO_VIEW = new OrthographicView({ id: 'ortho' })

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function hasMultiPickModifier(info: any, evt: any, keyActive: boolean): boolean {
  const e0 = info?.srcEvent
  const e1 = e0?.srcEvent
  const e2 = e0?.nativeEvent
  const e3 = evt?.srcEvent
  const e4 = evt?.nativeEvent
  return !!(
    keyActive ||
    e0?.ctrlKey || e0?.metaKey ||
    e1?.ctrlKey || e1?.metaKey ||
    e2?.ctrlKey || e2?.metaKey ||
    e3?.ctrlKey || e3?.metaKey ||
    e4?.ctrlKey || e4?.metaKey ||
    evt?.ctrlKey || evt?.metaKey
  )
}

function computeBounds(buf: Float32Array): Bounds | null {
  const n = Math.floor(buf.length / 2)
  if (n <= 0) return null
  let xmin = Infinity,
    xmax = -Infinity,
    ymin = Infinity,
    ymax = -Infinity
  for (let i = 0; i < n; i++) {
    const x = buf[2 * i]
    const y = buf[2 * i + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < xmin) xmin = x
    if (x > xmax) xmax = x
    if (y < ymin) ymin = y
    if (y > ymax) ymax = y
  }
  if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || !Number.isFinite(ymin) || !Number.isFinite(ymax)) return null
  if (xmax === xmin) xmax = xmin + 1
  if (ymax === ymin) ymax = ymin + 1
  return { xmin, xmax, ymin, ymax }
}

function fitViewXY(xmin: number, xmax: number, ymin: number, ymax: number, w: number, h: number, pad = 1) {
  const cx = (xmin + xmax) / 2
  const cy = -(ymin + ymax) / 2  // deck.gl Y-down: negate to place data-max at top
  const dx = Math.max(1e-12, xmax - xmin)
  const dy = Math.max(1e-12, ymax - ymin)

  const sx = (pad * w) / dx
  const sy = (pad * h) / dy

  const zx = Math.log2(Math.max(1e-12, sx))
  const zy = Math.log2(Math.max(1e-12, sy))

  return { target: [cx, cy, 0], zoom: [zx, zy] as [number, number] }
}

function visibleWorldRange(vs: any, size: { w: number; h: number }) {
  const tx = vs.target?.[0] ?? 0
  const ty = vs.target?.[1] ?? 0
  const raw = vs.zoom ?? 0
  const zx = Array.isArray(raw) ? raw[0] : raw
  const zy = Array.isArray(raw) ? raw[1] : raw

  const sx = Math.pow(2, zx)
  const sy = Math.pow(2, zy)

  const halfW = size.w / (2 * sx)
  const halfH = size.h / (2 * sy)

  return {
    xmin: tx - halfW,
    xmax: tx + halfW,
    ymin: ty - halfH,
    ymax: ty + halfH
  }
}

function worldToScreen(x: number, y: number, vs: any, size: { w: number; h: number }) {
  const raw = vs.zoom ?? 0
  const zx = Array.isArray(raw) ? raw[0] : raw
  const zy = Array.isArray(raw) ? raw[1] : raw

  const sx = Math.pow(2, zx)
  const sy = Math.pow(2, zy)

  const tx = vs.target?.[0] ?? 0
  const ty = vs.target?.[1] ?? 0

  const cx = size.w / 2
  const cy = size.h / 2

  return {
    x: cx + (x - tx) * sx,
    y: cy + (y - ty) * sy
  }
}

function screenToWorld(px: number, py: number, vs: any, size: { w: number; h: number }) {
  const raw = vs.zoom ?? 0
  const zx = Array.isArray(raw) ? raw[0] : raw
  const zy = Array.isArray(raw) ? raw[1] : raw

  const sx = Math.pow(2, zx)
  const sy = Math.pow(2, zy)

  const tx = vs.target?.[0] ?? 0
  const ty = vs.target?.[1] ?? 0

  const cx = size.w / 2
  const cy = size.h / 2

  return {
    x: tx + (px - cx) / sx,
    y: ty + (py - cy) / sy
  }
}

function pointInPolygon(x: number, y: number, poly: Array<{ x: number; y: number }>) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

function formatNum(v: number) {
  const a = Math.abs(v)
  if (a >= 1000 || (a > 0 && a < 0.001)) return v.toExponential(2)
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

function normalizeScatterSettings(spec: ScatterPlotSpec): ScatterSettings {
  return {
    ...DEFAULT_SCATTER_SETTINGS,
    ...(spec.scatterSettings || {}),
    sizeBy: spec.scatterSettings?.sizeBy ?? spec.sizeBy,
    colorBy: spec.scatterSettings?.colorBy ?? spec.colorBy,
  }
}

function hexToRgba(hex: string, alpha = 220): [number, number, number, number] {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : '5ac8fa'
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
    clamp(Math.round(alpha), 0, 255)
  ]
}

function finiteRange(values: any): { min: number; max: number } | null {
  if (!values) return null
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  if (min === max) max = min + 1
  return { min, max }
}

function medianSorted(values: number[]) {
  if (!values.length) return NaN
  const mid = Math.floor(values.length / 2)
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2
}

function pearson(xs: number[], ys: number[]) {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return NaN
  let sx = 0, sy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]
    sy += ys[i]
  }
  const mx = sx / n
  const my = sy / n
  let cov = 0, vx = 0, vy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    cov += dx * dy
    vx += dx * dx
    vy += dy * dy
  }
  const den = Math.sqrt(vx * vy)
  return den > 0 ? cov / den : NaN
}

function ranks(values: number[]) {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const out = new Array(values.length)
  for (let i = 0; i < sorted.length;) {
    let j = i + 1
    while (j < sorted.length && sorted[j].v === sorted[i].v) j++
    const rank = (i + j + 1) / 2
    for (let k = i; k < j; k++) out[sorted[k].i] = rank
    i = j
  }
  return out
}

function computeStats(positions: Float32Array, indices: Uint32Array | null, selectedCount: number) {
  const nAll = Math.floor(positions.length / 2)
  const count = indices ? indices.length : nAll
  const stride = count > STATS_SAMPLE_LIMIT ? Math.ceil(count / STATS_SAMPLE_LIMIT) : 1
  const xs: number[] = []
  const ys: number[] = []
  for (let src = 0; src < count; src += stride) {
    const gi = indices ? indices[src] : src
    const x = positions[2 * gi]
    const y = -positions[2 * gi + 1]  // positions store -y_data; negate back
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    xs.push(x)
    ys.push(y)
  }
  const sx = [...xs].sort((a, b) => a - b)
  const sy = [...ys].sort((a, b) => a - b)
  const rx = ranks(xs)
  const ry = ranks(ys)
  return {
    visibleCount: count,
    selectedCount,
    sampled: stride > 1,
    xMin: sx[0] ?? NaN,
    xMedian: medianSorted(sx),
    xMax: sx[sx.length - 1] ?? NaN,
    yMin: sy[0] ?? NaN,
    yMedian: medianSorted(sy),
    yMax: sy[sy.length - 1] ?? NaN,
    pearson: pearson(xs, ys),
    spearman: pearson(rx, ry)
  }
}

function shapeForValue(value: unknown, fallback: ScatterSettings['markerShape']): ScatterSettings['markerShape'] {
  if (value == null || value === '') return fallback
  const shapes: Array<ScatterSettings['markerShape']> = ['circle', 'square', 'diamond', 'triangle']
  const s = String(value)
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return shapes[Math.abs(h) % shapes.length]
}

function shapePolygonPoints(shape: ScatterSettings['markerShape'], x: number, y: number, r: number) {
  if (shape === 'square') {
    return `${x - r},${y - r} ${x + r},${y - r} ${x + r},${y + r} ${x - r},${y + r}`
  }
  if (shape === 'diamond') {
    return `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`
  }
  return `${x},${y - r} ${x + r * 0.9},${y + r * 0.72} ${x - r * 0.9},${y + r * 0.72}`
}

/**
 * Global cache:
 * - keyed by dataset object identity (WeakMap)
 * - within dataset, keyed by "x|y"
 */
const POS_CACHE: WeakMap<any, Map<string, Float32Array>> = new WeakMap()
const IDX_CACHE: WeakMap<Float32Array, Uint32Array> = new WeakMap()
const SAMPLE_CACHE: WeakMap<Uint32Array, Map<number, Uint32Array>> = new WeakMap()

function getPositionsCached(ds: any, xKey: string, yKey: string): Float32Array | null {
  if (!ds) return null
  let m = POS_CACHE.get(ds)
  if (!m) {
    m = new Map()
    POS_CACHE.set(ds, m)
  }
  const key = `${xKey}|${yKey}`
  const hit = m.get(key)
  if (hit) return hit

  const x = ds.columns?.[xKey] as Float32Array
  const y = ds.columns?.[yKey] as Float32Array
  if (!x || !y) return null
  const n = Math.min(x.length, y.length)
  const buf = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    buf[2 * i] = x[i]
    buf[2 * i + 1] = -y[i]  // flip Y so deck.gl places larger data-y higher on screen
  }
  m.set(key, buf)
  return buf
}

function buildBinaryData(
  indices: Uint32Array,
  positions: Float32Array,
  options: {
    radius: number
    opacity: number
    fixedColor: [number, number, number, number]
    sizeValues?: any
    sizeRange?: { min: number; max: number } | null
    colorValues?: any
    colorRange?: { min: number; max: number } | null
    colorMode?: 'continuous' | 'categorical'
    colorPalette?: ScatterSettings['colorPalette']
    dimSet?: Set<number> | null
  }
) {
  const n = indices.length
  const buf = new Float32Array(n * 2)
  const radii = new Float32Array(n)
  const colors = new Uint8ClampedArray(n * 4)
  const alpha = clamp(Math.round(options.opacity * 255), 20, 255)
  const dimAlpha = Math.max(18, Math.round(alpha * 0.2))

  for (let i = 0; i < n; i++) {
    const gi = indices[i]
    buf[2 * i] = positions[2 * gi]
    buf[2 * i + 1] = positions[2 * gi + 1]

    let radius = options.radius
    const sv = options.sizeValues?.[gi]
    if (options.sizeRange && Number.isFinite(sv)) {
      const t = (sv - options.sizeRange.min) / (options.sizeRange.max - options.sizeRange.min)
      radius = SIZE_MIN + clamp(t, 0, 1) * (SIZE_MAX - SIZE_MIN)
    }
    radii[i] = radius

    let c = options.fixedColor
    const cv = options.colorValues?.[gi]
    if (options.colorMode === 'categorical') {
      c = colorForCategoryLabel(categoryLabelForValue(cv), alpha, options.colorPalette || 'tealSunset')
    } else if (options.colorRange && Number.isFinite(cv)) {
      c = rampColor((cv - options.colorRange.min) / (options.colorRange.max - options.colorRange.min), alpha, options.colorPalette || 'tealSunset')
    }
    const a = options.dimSet && !options.dimSet.has(gi) ? dimAlpha : alpha
    colors[4 * i] = c[0]
    colors[4 * i + 1] = c[1]
    colors[4 * i + 2] = c[2]
    colors[4 * i + 3] = a
  }
  return {
    length: n,
    attributes: {
      getPosition: { value: buf, size: 2 },
      getRadius: { value: radii, size: 1 },
      getFillColor: { value: colors, size: 4 }
    }
  }
}

function getIndexArrayCached(positions: Float32Array): Uint32Array {
  const hit = IDX_CACHE.get(positions)
  if (hit) return hit
  const n = Math.floor(positions.length / 2)
  const idx = new Uint32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  IDX_CACHE.set(positions, idx)
  return idx
}

function getSampledIndicesCached(indices: Uint32Array, limit: number): Uint32Array {
  if (indices.length <= limit) return indices
  let byLimit = SAMPLE_CACHE.get(indices)
  if (!byLimit) {
    byLimit = new Map()
    SAMPLE_CACHE.set(indices, byLimit)
  }
  const hit = byLimit.get(limit)
  if (hit) return hit

  const stride = Math.ceil(indices.length / limit)
  const n = Math.ceil(indices.length / stride)
  const sample = new Uint32Array(n)
  for (let src = 0, dst = 0; src < indices.length; src += stride, dst++) {
    sample[dst] = indices[src]
  }
  byLimit.set(limit, sample)
  return sample
}

export default function ScatterPlot({
  spec,
  exportNonce = 0,
  onExportError,
}: {
  spec: ScatterPlotSpec
  exportNonce?: number
  onExportError?: (message: string) => void
}) {
  const ds = useStore(s => s.dataset)

  // ✅ use the *new* visibility representation from store.ts
  const visibleIndices = useStore(s => s.visibleIndices)
  const visibleMask = useStore(s => s.visibleMask)
  const selected = useStore(s => s.selectedIndices) // Int32Array
  const picked = useStore(s => s.pickedIndices)
  const setSelected = useStore(s => s.setSelected)
  const togglePicked = useStore(s => s.togglePicked)
  const setPickedIndices = useStore(s => s.setPickedIndices)
  const clearPicked = useStore(s => s.clearPicked)
  const activeViewerPane = useStore(s => s.activeViewerPane)
  const replaceMoleculeInDisplay = useStore(s => s.replaceMoleculeInDisplay)
  const updatePlot = useStore(s => s.updatePlot)
  const theme = useUIStore(s => s.theme)
  const themeBg = useMemo(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#0f141a',
    [theme]
  )

  const hostRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 300, h: 300 })

  const [viewState, setViewState] = useState<any>({ target: [0, 0, 0], zoom: [0, 0] })
  const [isInteracting, setIsInteracting] = useState(false)
  const firstFrameMarkedRef = useRef(false)
  const isInteractingRef = useRef(false)
  const interactionEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rafViewRef = useRef<number | null>(null)
  const pendingViewRef = useRef<any | null>(null)
  const lastRangeSyncAtRef = useRef(0)

  const rafPendingRef = useRef<number | null>(null)
  const pendingRangesRef = useRef<{ xr: [number, number]; yr: [number, number] } | null>(null)
  const multiPickKeyRef = useRef(false)
  const lassoDrawingRef = useRef(false)
  const lassoMovedRef = useRef(false)
  const suppressNextClickRef = useRef(false)
  const lassoPointsRef = useRef<Array<{ x: number; y: number }>>([])
  const lassoStartRef = useRef<{ x: number; y: number } | null>(null)
  const [lassoPoints, setLassoPoints] = useState<Array<{ x: number; y: number }>>([])

  const colorbarRef = useRef<HTMLDivElement>(null)
  const colorbarDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const [colorbarPos, setColorbarPos] = useState<{ x: number; y: number } | null>(null)
  const [colorbarDragging, setColorbarDragging] = useState(false)

  const isPanningRef = useRef(false)
  const panLastRef = useRef<{ x: number; y: number } | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const settings = useMemo(() => normalizeScatterSettings(spec), [spec])
  const effectiveBg = settings.backgroundColor || themeBg
  const xAxisSettings = useMemo(() => normalizeAxisSettings(settings.xAxis), [settings.xAxis])
  const yAxisSettings = useMemo(() => normalizeAxisSettings(settings.yAxis), [settings.yAxis])

  // ✅ Fix 1: stable controller object (do NOT recreate each render)
  const controller = useMemo(
    () => ({
      dragPan: false,
      dragRotate: false,
      doubleClickZoom: false,
      scrollZoom: true
    }),
    []
  )

  useEffect(() => {
    if (!hostRef.current) return
    const ro = new ResizeObserver(() => {
      const r = hostRef.current!.getBoundingClientRect()
      setSize({ w: Math.max(10, r.width), h: Math.max(10, r.height) })
    })
    ro.observe(hostRef.current)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    return () => {
      if (rafViewRef.current != null) cancelAnimationFrame(rafViewRef.current)
      if (rafPendingRef.current != null) cancelAnimationFrame(rafPendingRef.current)
      if (interactionEndTimerRef.current != null) clearTimeout(interactionEndTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) multiPickKeyRef.current = true
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) multiPickKeyRef.current = false
    }
    const onBlur = () => {
      multiPickKeyRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    if (!exportNonce) return
    const host = hostRef.current
    if (!host) return
    exportHostCanvasesToPng({
      host,
      filename: `${spec.type}_${spec.x}_${spec.y}.png`,
      scale: 3,
      background: effectiveBg,
    }).catch((err: any) => {
      onExportError?.(`Failed to export PNG: ${err?.message || String(err)}`)
    })
  }, [exportNonce])

  useEffect(() => {
    firstFrameMarkedRef.current = false
  }, [spec.x, spec.y, ds])

  useEffect(() => {
    setColorbarPos(null)
  }, [settings.colorBy])

  const sizeValues = settings.sizeBy && ds?.columns ? ds.columns[settings.sizeBy] : null
  const colorValues = settings.colorBy && ds?.columns ? ds.columns[settings.colorBy] : null
  const colorMode = useMemo(
    () => resolveScatterColorMode(colorValues, {
      maxCategoricalClasses: MAX_AUTO_CATEGORICAL_CLASSES,
      forceCategorical: !!settings.forceCategoricalColorBy,
    }),
    [settings.forceCategoricalColorBy, colorValues]
  )
  const isContinuousColor = !!settings.colorBy && colorMode === 'continuous'
  const isCategoricalColor = !!settings.colorBy && colorMode === 'categorical'
  const shapeValues = settings.shapeBy && ds?.columns ? ds.columns[settings.shapeBy] : null
  const sizeRange = useMemo(() => finiteRange(sizeValues), [sizeValues])
  const colorRange = useMemo(() => (isContinuousColor ? finiteRange(colorValues) : null), [isContinuousColor, colorValues])
  const categoryLegend = useMemo(() => (isCategoricalColor ? collectCategoryLegend(colorValues) : []), [isCategoricalColor, colorValues])

  const positions = useMemo(() => {
    if (!ds) return null
    return getPositionsCached(ds, spec.x, spec.y)
  }, [ds, spec.x, spec.y])

  const indexAll = useMemo(() => (positions ? getIndexArrayCached(positions) : null), [positions])
  const dataBounds = useMemo(() => {
    if (!positions) return null
    const b = computeBounds(positions)
    if (!b) return null
    return { xmin: b.xmin, xmax: b.xmax, ymin: -b.ymax, ymax: -b.ymin }
  }, [positions])

  const expandedBounds = useMemo(() => {
    if (!dataBounds) return null
    const dx = dataBounds.xmax - dataBounds.xmin
    const dy = dataBounds.ymax - dataBounds.ymin
    return {
      xMinAll: dataBounds.xmin - dx * 0.05,
      xMaxAll: dataBounds.xmax + dx * 0.05,
      yMinAll: dataBounds.ymin - dy * 0.05,
      yMaxAll: dataBounds.ymax + dy * 0.05
    }
  }, [dataBounds?.xmin, dataBounds?.xmax, dataBounds?.ymin, dataBounds?.ymax])

  const dataRangeX = useMemo<[number, number]>(() => [dataBounds?.xmin ?? 0, dataBounds?.xmax ?? 1], [dataBounds?.xmin, dataBounds?.xmax])
  const dataRangeY = useMemo<[number, number]>(() => [dataBounds?.ymin ?? 0, dataBounds?.ymax ?? 1], [dataBounds?.ymin, dataBounds?.ymax])
  const xCurrent = useMemo<[number, number]>(() => normalizeRange(xAxisSettings.range, dataRangeX), [xAxisSettings.range, dataRangeX])
  const yCurrent = useMemo<[number, number]>(() => normalizeRange(yAxisSettings.range, dataRangeY), [yAxisSettings.range, dataRangeY])

  const updateAxisRanges = (xr: [number, number], yr: [number, number], clearViewCommand = false) => {
    updatePlot({
      id: spec.id,
      scatterSettings: {
        ...spec.scatterSettings,
        xAxis: { ...spec.scatterSettings?.xAxis, range: xr },
        yAxis: { ...spec.scatterSettings?.yAxis, range: yr },
        ...(clearViewCommand ? { viewCommand: undefined } : {}),
      }
    })
  }

  // ✅ Fix 1 + big-data: feed deck.gl only the visible indices
  const deckData = useMemo(() => {
    if (!indexAll) return null
    return visibleIndices ?? indexAll
  }, [indexAll, visibleIndices])

  const deckDataCount = deckData?.length ?? 0
  const useInteractionSample = isInteracting && deckDataCount > INTERACTION_SAMPLE_LIMIT
  const renderData = useMemo(() => {
    if (!deckData) return null
    return useInteractionSample ? getSampledIndicesCached(deckData, INTERACTION_SAMPLE_LIMIT) : deckData
  }, [deckData, useInteractionSample])

  useEffect(() => {
    if (!dataBounds) return
    if (!size.w || !size.h) return
    const fit = fitViewXY(xCurrent[0], xCurrent[1], yCurrent[0], yCurrent[1], size.w, size.h, 1)
    setViewState((prev: any) => ({ ...prev, ...fit }))
  }, [dataBounds?.xmin, dataBounds?.xmax, dataBounds?.ymin, dataBounds?.ymax, size.w, size.h, spec.x, spec.y, xCurrent, yCurrent])

  const xMinAll = expandedBounds?.xMinAll ?? dataBounds?.xmin ?? 0
  const xMaxAll = expandedBounds?.xMaxAll ?? dataBounds?.xmax ?? 1
  const yMinAll = expandedBounds?.yMinAll ?? dataBounds?.ymin ?? 0
  const yMaxAll = expandedBounds?.yMaxAll ?? dataBounds?.ymax ?? 1

  const resetToAll = () => {
    if (!dataBounds) return
    const xr: [number, number] = [dataBounds.xmin, dataBounds.xmax]
    const yr: [number, number] = [dataBounds.ymin, dataBounds.ymax]
    updateAxisRanges(xr, yr, true)
    const fit = fitViewXY(xr[0], xr[1], yr[0], yr[1], size.w, size.h, 1)
    setViewState((prev: any) => ({ ...prev, ...fit }))
  }

  const fitToVisible = () => {
    if (!positions || !deckData || deckData.length === 0) {
      resetToAll()
      return
    }
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity
    for (let i = 0; i < deckData.length; i++) {
      const gi = deckData[i]
      const x = positions[2 * gi]
      const y = -positions[2 * gi + 1]  // positions store -y_data; negate back
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < xmin) xmin = x
      if (x > xmax) xmax = x
      if (y < ymin) ymin = y
      if (y > ymax) ymax = y
    }
    if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || !Number.isFinite(ymin) || !Number.isFinite(ymax)) return
    if (xmax === xmin) xmax = xmin + 1
    if (ymax === ymin) ymax = ymin + 1
    const xr: [number, number] = [xmin, xmax]
    const yr: [number, number] = [ymin, ymax]
    updateAxisRanges(xr, yr, true)
    const fit = fitViewXY(xr[0], xr[1], yr[0], yr[1], size.w, size.h, 1)
    setViewState((prev: any) => ({ ...prev, ...fit }))
  }

  useEffect(() => {
    const cmd = settings.viewCommand
    if (!cmd) return
    if (cmd.type === 'fitVisible') fitToVisible()
    else resetToAll()
  }, [settings.viewCommand?.nonce])

  const selectedIndex = selected?.length ? selected[0] : -1
  const dimSet = useMemo(() => {
    if (!settings.dimUnselected) return null
    const set = new Set<number>()
    for (let i = 0; i < selected.length; i++) set.add(selected[i])
    for (let i = 0; i < picked.length; i++) set.add(picked[i])
    return set.size ? set : null
  }, [settings.dimUnselected, selected, picked])

  const layers = useMemo(() => {
    if (!positions || !renderData) return []

    const nAll = Math.floor(positions.length / 2)
    const pointRadius = deckDataCount > LARGE_DATA_POINT_THRESHOLD ? Math.min(2, settings.markerSize) : settings.markerSize

    // Use binary attribute format: avoids per-point JS accessor calls entirely
    const binaryData = buildBinaryData(renderData, positions, {
      radius: pointRadius,
      opacity: settings.opacity,
      fixedColor: hexToRgba(settings.markerColor, settings.opacity * 255),
      sizeValues,
      sizeRange,
      colorValues,
      colorRange,
      colorMode,
      colorPalette: settings.colorPalette,
      dimSet
    })

    const base = new ScatterplotLayer({
      id: `scatter-base-${spec.x}-${spec.y}`,
      data: binaryData as any,
      pickable: true,
      radiusUnits: 'pixels',
      getPosition: (d: any) => d,  // identity — positions come from binary attribute
      getRadius: pointRadius,
      getFillColor: COLOR_BASE,
      getLineColor: COLOR_NONE,
      getLineWidth: 0,
      updateTriggers: { getPosition: renderData, getRadius: settings.markerSize, getFillColor: settings.markerColor }
    })

    const selOk =
      selectedIndex >= 0 &&
      selectedIndex < nAll &&
      (visibleMask == null || visibleMask[selectedIndex] === 1)

    const highlight =
      selOk && !isInteracting
        ? new ScatterplotLayer({
            id: `scatter-sel-${spec.x}-${spec.y}`,
            data: [selectedIndex] as any,
            pickable: false,
            radiusUnits: 'pixels',
            getPosition: (i: any) => [positions[2 * i], -positions[2 * i + 1]],
            getRadius: 7,
            getFillColor: COLOR_SEL_FILL,
            getLineColor: COLOR_SEL_LINE,
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            updateTriggers: { getPosition: selectedIndex }
          })
        : null

    const pickedVisible: number[] = []
    for (let i = 0; i < picked.length; i++) {
      const pi = picked[i]
      if (pi < 0 || pi >= nAll) continue
      if (visibleMask && visibleMask[pi] !== 1) continue
      pickedVisible.push(pi)
    }

    const pickedLayer =
      pickedVisible.length > 0
        ? new ScatterplotLayer({
            id: `scatter-picked-${spec.x}-${spec.y}`,
            data: pickedVisible as any,
            pickable: false,
            radiusUnits: 'pixels',
            getPosition: (i: any) => [positions[2 * i], -positions[2 * i + 1]],
            getRadius: 6,
            getFillColor: COLOR_PICK_FILL,
            getLineColor: COLOR_PICK_LINE,
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            updateTriggers: { getPosition: pickedVisible }
          })
        : null

    const out: any[] = [base]
    if (pickedLayer) out.push(pickedLayer)
    if (highlight) out.push(highlight)
    return out
  }, [positions, renderData, spec.x, spec.y, selectedIndex, visibleMask, isInteracting, deckDataCount, picked, settings.markerSize, settings.markerColor, settings.opacity, settings.colorPalette, sizeValues, sizeRange, colorValues, colorRange, colorMode, dimSet])

  const vis = useMemo(() => visibleWorldRange(viewState, size), [viewState, size.w, size.h])
  const ticksX = useMemo(() => generateLinearTicks(vis.xmin, vis.xmax, xAxisSettings.tickCount), [vis.xmin, vis.xmax, xAxisSettings.tickCount])
  const ticksY = useMemo(() => generateLinearTicks(-vis.ymax, -vis.ymin, yAxisSettings.tickCount), [vis.ymin, vis.ymax, yAxisSettings.tickCount])

  const stats = useMemo(() => {
    if (!settings.showStats || !positions) return null
    return computeStats(positions, deckData, picked.length || selected.length)
  }, [settings.showStats, positions, deckData, picked.length, selected.length])

  const colorbarTicks = useMemo(() => {
    if (!colorRange) return []
    const count = 5
    const out: Array<{ value: number; pct: number }> = []
    for (let i = 0; i < count; i++) {
      const pct = i / (count - 1)
      out.push({
        value: colorRange.min + (colorRange.max - colorRange.min) * pct,
        pct
      })
    }
    return out
  }, [colorRange])

  const lassoPath = useMemo(() => {
    if (lassoPoints.length < 2) return ''
    const head = `M ${lassoPoints[0].x} ${lassoPoints[0].y}`
    const rest = lassoPoints.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ')
    return `${head} ${rest}`
  }, [lassoPoints])

  const shapeOverlayPoints = useMemo(() => {
    if (!positions || !renderData) return []
    const wantsShapes = settings.markerShape !== 'circle' || !!shapeValues
    const smallExact = wantsShapes && renderData.length <= EXACT_SHAPE_LIMIT && !isInteracting
    const important = new Set<number>()
    for (let i = 0; i < picked.length; i++) important.add(picked[i])
    if (selectedIndex >= 0) important.add(selectedIndex)
    if (!smallExact && important.size === 0) return []

    const source: number[] = []
    if (smallExact) {
      for (let i = 0; i < renderData.length; i++) source.push(renderData[i])
    } else {
      important.forEach(v => source.push(v))
    }

    const fixed = hexToRgba(settings.markerColor, settings.opacity * 255)
    const out: Array<{ key: string; x: number; y: number; r: number; shape: ScatterSettings['markerShape']; fill: string; stroke: string }> = []
    const nAll = Math.floor(positions.length / 2)
    for (const gi of source) {
      if (gi < 0 || gi >= nAll) continue
      if (visibleMask && visibleMask[gi] !== 1) continue
      const xw = positions[2 * gi]
      const yw = positions[2 * gi + 1]
      if (!Number.isFinite(xw) || !Number.isFinite(yw)) continue
      const p = worldToScreen(xw, yw, viewState, size)
      const sv = sizeValues?.[gi]
      let r = settings.markerSize
      if (sizeRange && Number.isFinite(sv)) {
        const sn = Number(sv)
        r = SIZE_MIN + clamp((sn - sizeRange.min) / (sizeRange.max - sizeRange.min), 0, 1) * (SIZE_MAX - SIZE_MIN)
      }
      const cv = colorValues?.[gi]
      const rgba = colorRange && Number.isFinite(cv)
        ? rampColor((Number(cv) - colorRange.min) / (colorRange.max - colorRange.min), clamp(Math.round(settings.opacity * 255), 20, 255), settings.colorPalette)
        : (isCategoricalColor
          ? colorForCategoryLabel(categoryLabelForValue(cv), clamp(Math.round(settings.opacity * 255), 20, 255), settings.colorPalette)
          : fixed)
      out.push({
        key: String(gi),
        x: p.x,
        y: p.y,
        r: Math.max(3, r),
        shape: shapeForValue(shapeValues?.[gi], settings.markerShape),
        fill: `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3] / 255})`,
        stroke: important.has(gi) ? 'rgba(255,255,255,0.95)' : 'rgba(6,8,16,0.55)'
      })
    }
    return out
  }, [positions, renderData, settings.markerShape, settings.markerColor, settings.markerSize, settings.opacity, settings.colorPalette, shapeValues, sizeValues, sizeRange, colorValues, colorRange, isCategoricalColor, viewState, size.w, size.h, isInteracting, picked, selectedIndex, visibleMask])

  const colorbarStyle = useMemo(() => {
    const stops = paletteStops(settings.colorPalette)
      .map((c, i, arr) => `rgb(${c[0]}, ${c[1]}, ${c[2]}) ${(i / Math.max(1, arr.length - 1)) * 100}%`)
      .join(', ')
    return { background: `linear-gradient(to top, ${stops})` }
  }, [settings.colorPalette])

  return (
    <div className="plot-host" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        data-pickable="true"
        ref={hostRef}
        className="plot-canvas"
        style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, background: settings.backgroundColor }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          // ── Right-click pan ──────────────────────────────────────────────
          if (e.button === 2) {
            e.preventDefault()
            isPanningRef.current = true
            panLastRef.current = { x: e.clientX, y: e.clientY }
            setIsPanning(true)
            isInteractingRef.current = true
            setIsInteracting(true)

            const onPanMove = (me: PointerEvent) => {
              if (!isPanningRef.current || !panLastRef.current) return
              const dx = me.clientX - panLastRef.current.x
              const dy = me.clientY - panLastRef.current.y
              panLastRef.current = { x: me.clientX, y: me.clientY }
              setViewState((prev: any) => {
                const raw = prev.zoom ?? 0
                const zx = Array.isArray(raw) ? raw[0] : raw
                const zy = Array.isArray(raw) ? raw[1] : raw
                const sx = Math.pow(2, zx)
                const sy = Math.pow(2, zy)
                return {
                  ...prev,
                  target: [
                    (prev.target?.[0] ?? 0) - dx / sx,
                    (prev.target?.[1] ?? 0) - dy / sy,
                    0,
                  ]
                }
              })
            }

            const onPanUp = (ue: PointerEvent) => {
              if (ue.button !== 2) return
              window.removeEventListener('pointermove', onPanMove)
              window.removeEventListener('pointerup', onPanUp)
              isPanningRef.current = false
              panLastRef.current = null
              setIsPanning(false)
              isInteractingRef.current = false
              setIsInteracting(false)
            }

            window.addEventListener('pointermove', onPanMove)
            window.addEventListener('pointerup', onPanUp)
            return
          }

          // ── Left-click lasso ─────────────────────────────────────────────
          if (e.button !== 0) return
          if (e.ctrlKey || e.metaKey) return
          const host = hostRef.current
          if (!host) return
          const r = host.getBoundingClientRect()
          const start = { x: e.clientX - r.left, y: e.clientY - r.top }
          lassoStartRef.current = start
          lassoDrawingRef.current = true
          lassoMovedRef.current = false
          lassoPointsRef.current = [start]
          setLassoPoints([])

          const onMove = (me: PointerEvent) => {
            if (!lassoDrawingRef.current) return
            const hostNow = hostRef.current
            if (!hostNow) return
            const rr = hostNow.getBoundingClientRect()
            const p = { x: me.clientX - rr.left, y: me.clientY - rr.top }
            const st = lassoStartRef.current
            if (!st) return
            const fromStartDx = p.x - st.x
            const fromStartDy = p.y - st.y
            const fromStartDist2 = fromStartDx * fromStartDx + fromStartDy * fromStartDy
            if (!lassoMovedRef.current) {
              if (fromStartDist2 < 36) return
              lassoMovedRef.current = true
              setLassoPoints([st])
            }
            const prev = lassoPointsRef.current[lassoPointsRef.current.length - 1]
            const dx = p.x - prev.x
            const dy = p.y - prev.y
            if (dx * dx + dy * dy < 4) return
            lassoPointsRef.current = [...lassoPointsRef.current, p]
            setLassoPoints(lassoPointsRef.current)
          }

          const finish = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            window.removeEventListener('pointercancel', onCancel)
            if (!lassoDrawingRef.current) return
            lassoDrawingRef.current = false
            const pts = lassoPointsRef.current
            if (lassoMovedRef.current && pts.length >= 3 && positions && deckData) {
              const poly = pts.map(p => screenToWorld(p.x, p.y, viewState, size))
              const sel: number[] = []
              for (let i = 0; i < deckData.length; i++) {
                const gi = deckData[i]
                const x = positions[2 * gi]
                const y = positions[2 * gi + 1]
                if (pointInPolygon(x, y, poly)) sel.push(gi)
              }
              if (sel.length > 0) {
                setPickedIndices(new Int32Array(sel))
                setSelected(new Int32Array([sel[sel.length - 1]]))
              } else {
                clearPicked()
                setSelected(new Int32Array(0))
              }
              suppressNextClickRef.current = true
            }
            lassoStartRef.current = null
            lassoPointsRef.current = []
            setLassoPoints([])
          }

          const onUp = () => finish()
          const onCancel = () => finish()
          window.addEventListener('pointermove', onMove)
          window.addEventListener('pointerup', onUp)
          window.addEventListener('pointercancel', onCancel)
        }}
      >
        <DeckGL
          layers={layers}
          views={ORTHO_VIEW}
          controller={controller as any}
          viewState={viewState}
          onViewStateChange={({ viewState: vs, interactionState }) => {
            const interacting = !!(
              interactionState?.isDragging ||
              interactionState?.isPanning ||
              interactionState?.isZooming
            )
            if (interacting) {
              // Going into interaction: set immediately
              if (!isInteractingRef.current) {
                isInteractingRef.current = true
                setIsInteracting(true)
              }
              // Cancel any pending end-of-interaction timer
              if (interactionEndTimerRef.current != null) {
                clearTimeout(interactionEndTimerRef.current)
                interactionEndTimerRef.current = null
              }
            } else if (isInteractingRef.current) {
              // Debounce the end of interaction to avoid a flash re-render
              if (interactionEndTimerRef.current == null) {
                interactionEndTimerRef.current = setTimeout(() => {
                  interactionEndTimerRef.current = null
                  isInteractingRef.current = false
                  setIsInteracting(false)
                }, 80)
              }
            }

            const raw = vs.zoom ?? 0
            const zx = Array.isArray(raw) ? raw[0] : raw
            const zy = Array.isArray(raw) ? raw[1] : raw
            const clampedX = clamp(zx, ZOOM_MIN, ZOOM_MAX)
            const clampedY = clamp(zy, ZOOM_MIN, ZOOM_MAX)
            const aspectZoom = settings.preserveAspectRatio
              ? Math.min(clampedX, clampedY)
              : null

            const nextVS = {
              ...vs,
              zoom: settings.preserveAspectRatio
                ? [aspectZoom!, aspectZoom!] as [number, number]
                : [clampedX, clampedY] as [number, number]
            }
            pendingViewRef.current = nextVS
            if (rafViewRef.current == null) {
              rafViewRef.current = requestAnimationFrame(() => {
                rafViewRef.current = null
                const pending = pendingViewRef.current
                if (!pending) return
                setViewState((prev: any) => ({ ...prev, ...pending }))
              })
            }

            if (size.w > 0 && size.h > 0) {
              const now = performance.now()
              if (interacting) return
              if (now - lastRangeSyncAtRef.current < 80) return
              lastRangeSyncAtRef.current = now

              const r = visibleWorldRange(nextVS, size)
              const xr: [number, number] = [clamp(r.xmin, xMinAll, xMaxAll), clamp(r.xmax, xMinAll, xMaxAll)]
              const yr: [number, number] = [clamp(-r.ymax, yMinAll, yMaxAll), clamp(-r.ymin, yMinAll, yMaxAll)]
              pendingRangesRef.current = { xr, yr }
              if (rafPendingRef.current == null) {
                rafPendingRef.current = requestAnimationFrame(() => {
                  rafPendingRef.current = null
                  const pr = pendingRangesRef.current
                  if (!pr) return
                  updateAxisRanges(pr.xr, pr.yr)
                })
              }
            }
          }}
          pickingRadius={6}
          useDevicePixels={1}
          onClick={(info: any, evt: any) => {
            if (suppressNextClickRef.current) {
              suppressNextClickRef.current = false
              return
            }
            const isMultiPick = hasMultiPickModifier(info, evt, multiPickKeyRef.current)
            const localIdx = info?.index
            if (!Number.isInteger(localIdx) || localIdx < 0 || !renderData) {
              if (!isMultiPick) {
                clearPicked()
                setSelected(new Int32Array(0))
              }
              return
            }

            const globalIdx = Number((renderData as any)[localIdx])
            if (Number.isInteger(globalIdx) && globalIdx >= 0) {
              if (isMultiPick) {
                togglePicked(globalIdx)
              } else if (picked.length > 0) {
                replaceMoleculeInDisplay(activeViewerPane, globalIdx)
              } else {
                setPickedIndices(new Int32Array([globalIdx]))
              }
              setSelected(new Int32Array([globalIdx]))
            }
          }}
          onAfterRender={() => {
            if (firstFrameMarkedRef.current) return
            if (!perfHasMark('dataset_to_first_plot')) return
            firstFrameMarkedRef.current = true
            perfMarkEnd('dataset_to_first_plot', 'dataset_to_first_plot_ms')
          }}
        />

        <div style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none', cursor: isPanning ? 'grabbing' : lassoPoints.length ? 'crosshair' : 'default' }}>
          {(lassoPath || shapeOverlayPoints.length > 0) && (
            <svg width="100%" height="100%" style={{ display: 'block' }}>
              {shapeOverlayPoints.map(p => (
                p.shape === 'circle'
                  ? <circle key={p.key} cx={p.x} cy={p.y} r={p.r} fill={p.fill} stroke={p.stroke} strokeWidth={1} />
                  : <polygon key={p.key} points={shapePolygonPoints(p.shape, p.x, p.y, p.r)} fill={p.fill} stroke={p.stroke} strokeWidth={1} />
              ))}
              <path d={lassoPath} fill="rgba(90,200,250,0.12)" stroke="rgba(120,220,255,0.95)" strokeWidth={1.5} />
            </svg>
          )}
        </div>

        {settings.showGrid && (
          <div className="scatter-grid-overlay">
            {ticksX.map((tx, i) => {
              const p = worldToScreen(tx, viewState.target?.[1] ?? 0, viewState, size)
              return <div key={`gx-${i}`} className="scatter-grid-line vertical" style={{ left: Math.round(p.x) }} />
            })}
            {ticksY.map((ty, i) => {
              const p = worldToScreen(viewState.target?.[0] ?? 0, -ty, viewState, size)
              return <div key={`gy-${i}`} className="scatter-grid-line horizontal" style={{ top: Math.round(p.y) }} />
            })}
          </div>
        )}

        {settings.colorBy && settings.showColorbar && (colorRange || isCategoricalColor) && (
          <div
            ref={colorbarRef}
            className="scatter-colorbar"
            style={{
              pointerEvents: 'auto',
              cursor: colorbarDragging ? 'grabbing' : 'grab',
              userSelect: 'none',
              ...(colorbarPos
                ? { left: colorbarPos.x, top: colorbarPos.y, right: 'auto' }
                : {}),
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              const host = hostRef.current
              const bar = colorbarRef.current
              if (!host || !bar) return
              const hostRect = host.getBoundingClientRect()
              const barRect = bar.getBoundingClientRect()
              const origX = barRect.left - hostRect.left
              const origY = barRect.top - hostRect.top
              colorbarDragRef.current = { startX: e.clientX, startY: e.clientY, origX, origY }
              setColorbarDragging(true)

              const onMove = (me: PointerEvent) => {
                if (!colorbarDragRef.current) return
                const dx = me.clientX - colorbarDragRef.current.startX
                const dy = me.clientY - colorbarDragRef.current.startY
                const hostNow = hostRef.current
                const barNow = colorbarRef.current
                if (!hostNow || !barNow) return
                setColorbarPos({
                  x: clamp(colorbarDragRef.current.origX + dx, 0, hostNow.clientWidth - barNow.offsetWidth),
                  y: clamp(colorbarDragRef.current.origY + dy, 0, hostNow.clientHeight - barNow.offsetHeight),
                })
              }

              const onUp = () => {
                colorbarDragRef.current = null
                setColorbarDragging(false)
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
              }

              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
            }}
          >
            <div className="scatter-colorbar-title" title={settings.colorBy}>{settings.colorBy}</div>
            {colorRange && (
              <div className="scatter-colorbar-body">
                <div
                  className="scatter-colorbar-ramp"
                  style={colorbarStyle}
                  data-export-stops={paletteStops(settings.colorPalette).map(c => `${c[0]},${c[1]},${c[2]}`).join(';')}
                />
                <div className="scatter-colorbar-ticks">
                  {colorbarTicks.map(t => (
                    <div key={t.pct} className="scatter-colorbar-tick" style={{ bottom: `${t.pct * 100}%` }}>
                      <span className="scatter-colorbar-tick-line" />
                      <span className="scatter-colorbar-tick-label">{formatNum(t.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {isCategoricalColor && (
              <div style={{ maxHeight: 190, overflowY: 'auto', display: 'grid', gap: 4, marginTop: 6 }}>
                {categoryLegend.map(item => {
                  const c = colorForCategoryLabel(item.label, 230, settings.colorPalette)
                  return (
                    <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        className="scatter-colorbar-swatch"
                        data-export-color={`${c[0]},${c[1]},${c[2]},${c[3]}`}
                        style={{ width: 12, height: 12, borderRadius: 2, display: 'inline-block', background: `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3] / 255})`, border: '1px solid rgba(255,255,255,0.28)' }}
                      />
                      <span className="scatter-colorbar-tick-label" title={item.label}>{item.label}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Axis overlay */}
        <div className="axis-overlay" style={{ opacity: 1 }}>
          {settings.showXAxis && (
          <div className="axis-x">
            {ticksX.map((tx, i) => {
              const p = worldToScreen(tx, viewState.target?.[1] ?? 0, viewState, size)
              return (
                <div key={i} className="tick" style={{ left: Math.round(p.x) }}>
                  <div className="tick-line" />
                  {settings.showTickLabels && <div className="tick-label" style={{ fontSize: xAxisSettings.tickLabelSize }}>{formatAxisTick(tx, xAxisSettings.tickDecimals)}</div>}
                </div>
              )
            })}
            <div
              className="axis-title"
              style={{ fontSize: xAxisSettings.labelSize }}
              data-export-label={axisLabelExpressionToPlainText(resolveAxisLabel(settings.xAxis, spec.x))}
            >
              <AxisLabelText label={resolveAxisLabel(settings.xAxis, spec.x)} />
            </div>
          </div>
          )}

          {settings.showYAxis && (
          <div className="axis-y">
            {ticksY.map((ty, i) => {
              const p = worldToScreen(viewState.target?.[0] ?? 0, -ty, viewState, size)
              return (
                <div key={i} className="tick" style={{ top: Math.round(p.y) }}>
                  <div className="tick-line" />
                  {settings.showTickLabels && <div className="tick-label" style={{ fontSize: yAxisSettings.tickLabelSize }}>{formatAxisTick(ty, yAxisSettings.tickDecimals)}</div>}
                </div>
              )
            })}
            <div
              className="axis-title"
              style={{ fontSize: yAxisSettings.labelSize }}
              data-export-label={axisLabelExpressionToPlainText(resolveAxisLabel(settings.yAxis, spec.y))}
            >
              <AxisLabelText label={resolveAxisLabel(settings.yAxis, spec.y)} />
            </div>
          </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div
        className="plot-ranges"
        style={{ padding: '3px 8px 10px 8px', borderTop: '1px solid var(--color-border)', background: effectiveBg }}
      >
        <div className="row row-between gap-sm">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 600 }}>Scatter</div>
            <div className="legend">
              {spec.x} vs {spec.y}
            </div>
          </div>
          <div className="row gap-sm">
            <span className="legend" style={{ fontSize: 10 }}>
              Scroll: zoom · Right-drag: pan · Left-drag: lasso
            </span>
            <button className="pager-btn" onClick={resetToAll} title="Reset view">
              Reset view
            </button>
          </div>
        </div>

        {stats && (
          <div className="scatter-stats-panel">
            <StatItem label="Visible" value={stats.visibleCount.toLocaleString()} />
            <StatItem label="Selected" value={stats.selectedCount.toLocaleString()} />
            <StatItem label={`${spec.x} min / med / max`} value={`${formatNum(stats.xMin)} / ${formatNum(stats.xMedian)} / ${formatNum(stats.xMax)}`} />
            <StatItem label={`${spec.y} min / med / max`} value={`${formatNum(stats.yMin)} / ${formatNum(stats.yMedian)} / ${formatNum(stats.yMax)}`} />
            <StatItem label="Pearson" value={Number.isFinite(stats.pearson) ? stats.pearson.toFixed(3) : 'n/a'} />
            <StatItem label={stats.sampled ? 'Spearman sampled' : 'Spearman'} value={Number.isFinite(stats.spearman) ? stats.spearman.toFixed(3) : 'n/a'} />
          </div>
        )}
      </div>
    </div>
  )
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="scatter-stat-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
