import React, { useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { SolidPolygonLayer } from '@deck.gl/layers'
import { OrthographicView } from '@deck.gl/core'
import Slider from 'rc-slider'
import 'rc-slider/assets/index.css'
import { useStore } from '../store/store'
import { useUIStore } from '../store/uiStore'
import { perfHasMark, perfMarkEnd } from '../utils/perfMetrics'
import { exportHostCanvasesToPng } from '../utils/plotExport'
import type { HistogramPlotSpec, HistogramSettings } from '../models/dataModel'
import { axisLabelExpressionToPlainText, formatAxisTick, generateLinearTicks, normalizeAxisSettings, normalizeRange, resolveAxisLabel } from '../utils/axisSettings'
import AxisLabelText from './AxisLabelText'

const ORTHO_VIEW = new OrthographicView({ id: 'ortho' })

type Bin = { i: number; x0: number; x1: number; count: number }
type SplitLegendPos = { x: number; y: number }

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

const QUALITATIVE_PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
]

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function autoTickStep(span: number, targetTicks = 6) {
  if (!Number.isFinite(span) || span <= 0) return 1
  const raw = span / targetTicks
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / pow
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return nice * pow
}

function autoTicksFromRange(min: number, max: number, targetTicks = 6) {
  const span = max - min
  const step = autoTickStep(span, targetTicks)
  const start = Math.ceil(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max + 1e-12; v += step) out.push(v)
  return out
}

function formatNum(v: number) {
  const a = Math.abs(v)
  if (a >= 1000 || (a > 0 && a < 0.001)) return v.toExponential(2)
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

function fitViewXY(xmin: number, xmax: number, ymin: number, ymax: number, w: number, h: number, pad = 0.9) {
  const cx = (xmin + xmax) / 2
  const cy = (ymin + ymax) / 2
  const dx = Math.max(1e-12, xmax - xmin)
  const dy = Math.max(1e-12, ymax - ymin)
  const sx = (pad * w) / dx
  const sy = (pad * h) / dy
  return { target: [cx, cy, 0], zoom: [Math.log2(Math.max(1e-12, sx)), Math.log2(Math.max(1e-12, sy))] as [number, number] }
}

function visibleWorldRange(vs: any, size: { w: number; h: number }) {
  const tx = vs.target?.[0] ?? 0
  const ty = vs.target?.[1] ?? 0
  const raw = vs.zoom ?? 0
  const zx = Array.isArray(raw) ? raw[0] : raw
  const zy = Array.isArray(raw) ? raw[1] : raw
  const sx = Math.pow(2, zx)
  const sy = Math.pow(2, zy)
  return { xmin: tx - size.w / (2 * sx), xmax: tx + size.w / (2 * sx), ymin: ty - size.h / (2 * sy), ymax: ty + size.h / (2 * sy) }
}

function worldToScreen(x: number, y: number, vs: any, size: { w: number; h: number }) {
  const raw = vs.zoom ?? 0
  const zx = Array.isArray(raw) ? raw[0] : raw
  const zy = Array.isArray(raw) ? raw[1] : raw
  const sx = Math.pow(2, zx)
  const sy = Math.pow(2, zy)
  const tx = vs.target?.[0] ?? 0
  const ty = vs.target?.[1] ?? 0
  return { x: size.w / 2 + (x - tx) * sx, y: size.h / 2 + (y - ty) * sy }
}

function hexToRgba(hex: string, alpha: number): [number, number, number, number] {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : '5ac8fa'
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16), clamp(Math.round(alpha), 0, 255)]
}

function normalizeHistSettings(spec: HistogramPlotSpec): HistogramSettings {
  return {
    ...DEFAULT_HIST_SETTINGS,
    ...(spec.histSettings || {}),
    binCount: clamp(Number(spec.histSettings?.binCount ?? DEFAULT_HIST_SETTINGS.binCount), 1, 5000),
    barOpacity: clamp(Number(spec.histSettings?.barOpacity ?? DEFAULT_HIST_SETTINGS.barOpacity), 0.05, 1),
  }
}

function hasMultiPickModifier(info: any, evt: any): boolean {
  const e0 = info?.srcEvent
  const e1 = e0?.srcEvent
  const e2 = e0?.nativeEvent
  const e3 = evt?.srcEvent
  const e4 = evt?.nativeEvent
  return !!(
    e0?.ctrlKey || e0?.metaKey ||
    e1?.ctrlKey || e1?.metaKey ||
    e2?.ctrlKey || e2?.metaKey ||
    e3?.ctrlKey || e3?.metaKey ||
    e4?.ctrlKey || e4?.metaKey ||
    evt?.ctrlKey || evt?.metaKey
  )
}

function mean(nums: number[]) {
  if (!nums.length) return NaN
  let s = 0
  for (let i = 0; i < nums.length; i++) s += nums[i]
  return s / nums.length
}

function median(nums: number[]) {
  if (!nums.length) return NaN
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export default function HistogramPlot({
  spec,
  exportNonce = 0,
  onExportError,
}: {
  spec: HistogramPlotSpec
  exportNonce?: number
  onExportError?: (message: string) => void
}) {
  const ds = useStore(s => s.dataset)
  const visibleMask = useStore(s => s.visibleMask)
  const selected = useStore(s => s.selectedIndices)
  const picked = useStore(s => s.pickedIndices)
  const setSelected = useStore(s => s.setSelected)
  const setPickedIndices = useStore(s => s.setPickedIndices)
  const updatePlot = useStore(s => s.updatePlot)
  const theme = useUIStore(s => s.theme)
  const themeBg = useMemo(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#0f141a',
    [theme]
  )

  const hostRef = useRef<HTMLDivElement>(null)
  const deckRef = useRef<any>(null)
  const firstFrameMarkedRef = useRef(false)
  const [size, setSize] = useState({ w: 300, h: 300 })
  const [viewState, setViewState] = useState<any>({ target: [0, 0, 0], zoom: [0, 0] })
  const [activeBinIndex, setActiveBinIndex] = useState<number | null>(null)
  const [activeBinMemberPos, setActiveBinMemberPos] = useState(0)
  const [splitLegendPos, setSplitLegendPos] = useState<SplitLegendPos | null>(null)

  const settings = useMemo(() => normalizeHistSettings(spec), [spec])
  const effectiveBg = settings.backgroundColor || themeBg
  const xAxisSettings = useMemo(() => normalizeAxisSettings(settings.xAxis), [settings.xAxis])

  const values = useMemo(() => (ds ? ds.columns[spec.x] as Float32Array : null), [ds, spec.x])

  const visibleValues = useMemo(() => {
    if (!values) return [] as Array<{ i: number; v: number }>
    const out: Array<{ i: number; v: number }> = []
    for (let i = 0; i < values.length; i++) {
      if (visibleMask && visibleMask[i] !== 1) continue
      const v = values[i]
      if (!Number.isFinite(v)) continue
      out.push({ i, v })
    }
    return out
  }, [values, visibleMask])

  const fullRange = useMemo(() => {
    if (!visibleValues.length) return { min: 0, max: 1 }
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < visibleValues.length; i++) {
      const v = visibleValues[i].v
      if (v < min) min = v
      if (v > max) max = v
    }
    if (min === max) max = min + 1
    return { min, max }
  }, [visibleValues])

  useEffect(() => {
    firstFrameMarkedRef.current = false
  }, [spec.x, ds, visibleMask, settings.binCount, settings.binSize, settings.xAxis?.range?.[0], settings.xAxis?.range?.[1]])

  useEffect(() => {
    if (!size.w || !size.h) return
    if (settings.xAxis?.range && settings.xAxis.range[1] > settings.xAxis.range[0]) return
    updatePlot({ id: spec.id, histSettings: { ...spec.histSettings, xAxis: { ...spec.histSettings?.xAxis, range: [fullRange.min, fullRange.max] } } })
  }, [size.w, size.h, fullRange.min, fullRange.max])

  const xRange: [number, number] = useMemo(() => {
    return normalizeRange(
      settings.xAxis?.range
        ? [clamp(settings.xAxis.range[0], fullRange.min, fullRange.max), clamp(settings.xAxis.range[1], fullRange.min, fullRange.max)]
        : undefined,
      [fullRange.min, fullRange.max]
    )
  }, [settings.xAxis?.range, fullRange.min, fullRange.max])

  const effectiveBinCount = useMemo(() => {
    const span = Math.max(1e-12, xRange[1] - xRange[0])
    if (Number.isFinite(settings.binSize || NaN) && (settings.binSize as number) > 0) {
      return clamp(Math.round(span / (settings.binSize as number)), 1, 5000)
    }
    return clamp(Math.round(settings.binCount), 1, 5000)
  }, [xRange, settings.binSize, settings.binCount])

  const effectiveBinSize = useMemo(() => {
    const span = Math.max(1e-12, xRange[1] - xRange[0])
    return span / effectiveBinCount
  }, [xRange, effectiveBinCount])

  useEffect(() => {
    const next = { ...spec.histSettings, binCount: effectiveBinCount, binSize: effectiveBinSize }
    if (spec.histSettings?.binCount === effectiveBinCount && spec.histSettings?.binSize === effectiveBinSize) return
    updatePlot({ id: spec.id, histSettings: next })
  }, [effectiveBinCount, effectiveBinSize])

  const bins = useMemo(() => {
    const span = Math.max(1e-12, xRange[1] - xRange[0])
    const dx = span / effectiveBinCount
    const counts = new Int32Array(effectiveBinCount)
    for (let i = 0; i < visibleValues.length; i++) {
      const v = visibleValues[i].v
      if (v < xRange[0] || v > xRange[1]) continue
      let b = Math.floor((v - xRange[0]) / dx)
      b = clamp(b, 0, effectiveBinCount - 1)
      counts[b]++
    }
    const out: Bin[] = new Array(effectiveBinCount)
    for (let b = 0; b < effectiveBinCount; b++) {
      out[b] = { i: b, x0: xRange[0] + b * dx, x1: xRange[0] + (b + 1) * dx, count: counts[b] }
    }
    return { bins: out, dx, maxCount: Math.max(1, ...counts) }
  }, [visibleValues, xRange, effectiveBinCount])

  const groupBy = settings.groupBy ?? null
  const groupColValues = useMemo(() => {
    if (!groupBy || !ds) return null
    const col = ds.columns[groupBy]
    return Array.isArray(col) ? col as string[] : null
  }, [ds, groupBy])

  const groupKeys = useMemo(() => {
    if (!groupColValues) return null
    const seen = new Set<string>()
    for (let i = 0; i < groupColValues.length; i++) {
      if (visibleMask && visibleMask[i] !== 1) continue
      seen.add(groupColValues[i])
    }
    const keys = Array.from(seen).sort()
    return keys.length > 0 && keys.length <= 100 ? keys : null
  }, [groupColValues, visibleMask])

  const groupedData = useMemo(() => {
    if (!groupKeys || !groupColValues || !values) return null
    const { bins: binsArr, dx } = bins
    const n = binsArr.length
    const perGroupCounts: Record<string, Int32Array> = {}
    const perGroupTotals: Record<string, number> = {}
    for (const key of groupKeys) {
      perGroupCounts[key] = new Int32Array(n)
      perGroupTotals[key] = 0
    }
    for (let i = 0; i < values.length; i++) {
      if (visibleMask && visibleMask[i] !== 1) continue
      const v = values[i]
      if (!Number.isFinite(v) || v < xRange[0] || v > xRange[1]) continue
      const b = clamp(Math.floor((v - xRange[0]) / bins.dx), 0, n - 1)
      const group = groupColValues[i]
      if (group in perGroupCounts) {
        perGroupCounts[group][b]++
        perGroupTotals[group]++
      }
    }
    const perGroupDensities: Record<string, Float32Array> = {}
    let maxDensity = 1e-12
    for (const key of groupKeys) {
      const total = perGroupTotals[key]
      const counts = perGroupCounts[key]
      const dens = new Float32Array(n)
      for (let b = 0; b < n; b++) {
        dens[b] = total > 0 ? counts[b] / (total * dx) : 0
        if (dens[b] > maxDensity) maxDensity = dens[b]
      }
      perGroupDensities[key] = dens
    }
    return { perGroupCounts, perGroupDensities, perGroupTotals, maxDensity }
  }, [groupKeys, groupColValues, bins, values, visibleMask, xRange])

  const groupedStats = useMemo(() => {
    if (!groupKeys || !groupColValues || !values || !groupedData) return null
    const sums: Record<string, number> = {}
    const sumsSq: Record<string, number> = {}
    for (const key of groupKeys) {
      sums[key] = 0
      sumsSq[key] = 0
    }
    for (let i = 0; i < values.length; i++) {
      if (visibleMask && visibleMask[i] !== 1) continue
      const v = values[i]
      if (!Number.isFinite(v) || v < xRange[0] || v > xRange[1]) continue
      const group = groupColValues[i]
      if (!(group in sums)) continue
      sums[group] += v
      sumsSq[group] += v * v
    }
    return [...groupKeys]
      .sort((a, b) => (groupedData.perGroupTotals[b] ?? 0) - (groupedData.perGroupTotals[a] ?? 0))
      .map((key) => {
        const n = groupedData.perGroupTotals[key] ?? 0
        const m = n > 0 ? sums[key] / n : NaN
        const variance = n > 0 ? Math.max(0, sumsSq[key] / n - m * m) : NaN
        return {
          key,
          n,
          mean: m,
          std: Math.sqrt(variance),
          color: QUALITATIVE_PALETTE[groupKeys.indexOf(key) % QUALITATIVE_PALETTE.length],
        }
      })
  }, [groupKeys, groupColValues, values, groupedData, visibleMask, xRange])

  const selectedIndex = selected.length ? selected[0] : -1

  const membersForBin = React.useCallback((binIndex: number) => {
    if (!values) return [] as number[]
    const members: number[] = []
    for (let i = 0; i < values.length; i++) {
      if (visibleMask && visibleMask[i] !== 1) continue
      const v = values[i]
      if (!Number.isFinite(v) || v < xRange[0] || v > xRange[1]) continue
      const b = clamp(Math.floor((v - xRange[0]) / bins.dx), 0, bins.bins.length - 1)
      if (b === binIndex) members.push(i)
    }
    return members
  }, [values, visibleMask, xRange, bins.dx, bins.bins.length])

  const selectedBinIndex = useMemo(() => {
    if (!values || selectedIndex < 0 || selectedIndex >= values.length) return null
    const v = values[selectedIndex]
    if (!Number.isFinite(v) || v < xRange[0] || v > xRange[1]) return null
    return clamp(Math.floor((v - xRange[0]) / bins.dx), 0, bins.bins.length - 1)
  }, [values, selectedIndex, xRange, bins])

  const selectedBinIndices = useMemo(() => {
    const out = new Set<number>()
    if (!values) return out
    const source = picked.length ? picked : selected
    for (let i = 0; i < source.length; i++) {
      const idx = source[i]
      if (idx < 0 || idx >= values.length) continue
      if (visibleMask && visibleMask[idx] !== 1) continue
      const v = values[idx]
      if (!Number.isFinite(v) || v < xRange[0] || v > xRange[1]) continue
      out.add(clamp(Math.floor((v - xRange[0]) / bins.dx), 0, bins.bins.length - 1))
    }
    return out
  }, [values, picked, selected, visibleMask, xRange, bins.dx, bins.bins.length])

  const activeBinMembers = useMemo(() => {
    const b = activeBinIndex ?? selectedBinIndex
    if (b == null || !values) return [] as number[]
    const out: number[] = []
    for (let i = 0; i < values.length; i++) {
      if (visibleMask && visibleMask[i] !== 1) continue
      const v = values[i]
      if (!Number.isFinite(v) || v < xRange[0] || v > xRange[1]) continue
      const bi = clamp(Math.floor((v - xRange[0]) / bins.dx), 0, bins.bins.length - 1)
      if (bi === b) out.push(i)
    }
    return out
  }, [values, visibleMask, xRange, bins, activeBinIndex, selectedBinIndex])

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
    if (!splitLegendPos) return
    setSplitLegendPos({
      x: clamp(splitLegendPos.x, 6, Math.max(6, size.w - 220)),
      y: clamp(splitLegendPos.y, 6, Math.max(6, size.h - 160)),
    })
  }, [size.w, size.h])

  const startSplitLegendDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const host = hostRef.current
    if (!host) return
    const hostRect = host.getBoundingClientRect()
    const panelRect = e.currentTarget.parentElement?.getBoundingClientRect()
    if (!panelRect) return
    const offsetX = e.clientX - panelRect.left
    const offsetY = e.clientY - panelRect.top
    const panelW = panelRect.width
    const panelH = panelRect.height

    const move = (evt: PointerEvent) => {
      setSplitLegendPos({
        x: clamp(evt.clientX - hostRect.left - offsetX, 6, Math.max(6, hostRect.width - panelW - 6)),
        y: clamp(evt.clientY - hostRect.top - offsetY, 6, Math.max(6, hostRect.height - panelH - 6)),
      })
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }

    setSplitLegendPos({
      x: clamp(panelRect.left - hostRect.left, 6, Math.max(6, hostRect.width - panelW - 6)),
      y: clamp(panelRect.top - hostRect.top, 6, Math.max(6, hostRect.height - panelH - 6)),
    })
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  useEffect(() => {
    if (!exportNonce) return
    const host = hostRef.current
    if (!host) return
    exportHostCanvasesToPng({
      host,
      filename: `${spec.type}_${spec.x}.png`,
      scale: 3,
      background: effectiveBg,
    }).catch((err: any) => {
      onExportError?.(`Failed to export PNG: ${err?.message || String(err)}`)
    })
  }, [exportNonce])

  useEffect(() => {
    const maxY = groupedData ? groupedData.maxDensity : bins.maxCount
    const fit = fitViewXY(xRange[0], xRange[1], -maxY, 0, size.w, size.h, 0.9)
    setViewState((prev: any) => ({ ...prev, ...fit }))
  }, [xRange[0], xRange[1], bins.maxCount, groupedData?.maxDensity, size.w, size.h])

  useEffect(() => {
    const cmd = settings.viewCommand
    if (!cmd) return
    const maxY = groupedData ? groupedData.maxDensity : bins.maxCount
    const fit = fitViewXY(fullRange.min, fullRange.max, -maxY, 0, size.w, size.h, 0.9)
    if (cmd.type === 'fitAll' || cmd.type === 'reset') {
      updatePlot({ id: spec.id, histSettings: { ...spec.histSettings, xAxis: { ...spec.histSettings?.xAxis, range: [fullRange.min, fullRange.max] }, viewCommand: undefined } })
      setViewState((prev: any) => ({ ...prev, ...fit }))
    }
  }, [settings.viewCommand?.nonce])

  const barsData = useMemo(() => {
    if (groupedData) return []
    const baseFill = hexToRgba(settings.barFillColor, settings.barOpacity * 255)
    const baseLine = hexToRgba(settings.barBorderColor, 230)
    const hasSelectedBins = selectedBinIndices.size > 0
    return bins.bins.map((bin) => {
      const isSel = selectedBinIndices.has(bin.i) && bin.count > 0
      const dimmed = settings.dimUnselectedBins && hasSelectedBins && !isSel
      const fill = isSel && settings.highlightSelectedBin ? [255, 255, 255, 240] as [number, number, number, number] : baseFill
      return {
        bin,
        polygon: [[bin.x0, 0], [bin.x1, 0], [bin.x1, -bin.count], [bin.x0, -bin.count]],
        fillColor: dimmed ? [fill[0], fill[1], fill[2], Math.max(35, Math.round(fill[3] * 0.3))] : fill,
        lineColor: isSel && settings.highlightSelectedBin ? [20, 120, 180, 255] : baseLine,
      }
    })
  }, [bins, selectedBinIndices, settings, groupedData])

  const groupedLayers = useMemo(() => {
    if (!groupedData || !groupKeys) return null
    const sortedKeys = [...groupKeys].sort((a, b) =>
      (groupedData.perGroupTotals[b] ?? 0) - (groupedData.perGroupTotals[a] ?? 0)
    )
    return sortedKeys.map((group) => {
      const ci = groupKeys.indexOf(group) % QUALITATIVE_PALETTE.length
      const fillColor = hexToRgba(QUALITATIVE_PALETTE[ci], 140)
      const lineColor: [number, number, number, number] = [Math.round(fillColor[0] * 0.6), Math.round(fillColor[1] * 0.6), Math.round(fillColor[2] * 0.6), 220]
      const dens = groupedData.perGroupDensities[group]
      const counts = groupedData.perGroupCounts[group]
      const data = bins.bins.map((bin) => ({
        bin: { ...bin, group, density: dens[bin.i], groupCount: counts[bin.i] },
        polygon: [[bin.x0, 0], [bin.x1, 0], [bin.x1, -dens[bin.i]], [bin.x0, -dens[bin.i]]],
        fillColor,
        lineColor,
      }))
      return new SolidPolygonLayer({
        id: `hist-${spec.id}-g-${group}`,
        data,
        getPolygon: (d: any) => d.polygon,
        getFillColor: (d: any) => d.fillColor,
        getLineColor: (d: any) => d.lineColor,
        filled: true,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        pickable: true,
        parameters: { depthTest: false }
      })
    })
  }, [groupedData, groupKeys, bins, spec.id])

  const layers = useMemo(() => groupedLayers ?? [new SolidPolygonLayer({
    id: `hist-${spec.id}`,
    data: barsData,
    getPolygon: (d: any) => d.polygon,
    getFillColor: (d: any) => d.fillColor,
    getLineColor: (d: any) => d.lineColor,
    filled: true,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 1.5,
    pickable: true,
    parameters: { depthTest: false }
  })], [barsData, groupedLayers, spec.id])

  const vis = useMemo(() => visibleWorldRange(viewState, size), [viewState, size.w, size.h])
  const tickTarget = settings.gridDensity === 'light' ? 4 : settings.gridDensity === 'dense' ? 10 : 7
  const ticksX = useMemo(() => generateLinearTicks(vis.xmin, vis.xmax, xAxisSettings.tickCount), [vis.xmin, vis.xmax, xAxisSettings.tickCount])
  const ticksYWorld = useMemo(() => autoTicksFromRange(vis.ymin, vis.ymax, tickTarget), [vis.ymin, vis.ymax, tickTarget])

  const statValues = useMemo(() => {
    const out: number[] = []
    for (let i = 0; i < visibleValues.length; i++) {
      const v = visibleValues[i].v
      if (v < xRange[0] || v > xRange[1]) continue
      out.push(v)
    }
    return out
  }, [visibleValues, xRange])

  const stats = useMemo(() => {
    if (!statValues.length) return null
    const m = mean(statValues)
    let min = Infinity, max = -Infinity, ss = 0
    for (let i = 0; i < statValues.length; i++) {
      const v = statValues[i]
      if (v < min) min = v
      if (v > max) max = v
      ss += (v - m) * (v - m)
    }
    return {
      visibleN: statValues.length,
      selectedBinN: activeBinMembers.length,
      selectedBinFraction: statValues.length > 0 ? activeBinMembers.length / statValues.length : 0,
      min,
      max,
      mean: m,
      median: median(statValues),
      std: Math.sqrt(ss / statValues.length)
    }
  }, [statValues, activeBinMembers.length])

  if (!ds) return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />

  return (
    <div className="plot-host" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        ref={hostRef}
        className="plot-canvas"
        style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, background: effectiveBg }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button !== 2) return
          e.preventDefault()
          const host = hostRef.current
          const deck = deckRef.current?.deck
          if (!host || !deck) return
          const rect = host.getBoundingClientRect()
          const x = e.clientX - rect.left
          const y = e.clientY - rect.top
          // Include grouped layers (`hist-<id>-g-<group>`) so split mode is pickable.
          const pick = deck.pickObject({ x, y, radius: 14, layerIds: layers.map((l: any) => l.id) })
          const bin = pick?.object?.bin
          if (!bin) {
            // Missed pick: clear the active bin, but keep the user's selection.
            setActiveBinIndex(null)
            return
          }
          const members = membersForBin(bin.i)
          const remove = new Set(members)
          const base = picked.length ? picked : selected
          const next = base.filter(idx => !remove.has(idx))
          const nextArr = new Int32Array(next)
          setActiveBinIndex(bin.i)
          setActiveBinMemberPos(0)
          setSelected(nextArr)
          setPickedIndices(nextArr)
        }}
      >
        <DeckGL
          ref={deckRef}
          layers={layers}
          views={ORTHO_VIEW}
          controller={false}
          viewState={viewState}
          pickingRadius={14}
          useDevicePixels={1}
          onClick={(info: any, evt: any) => {
            const btn = info?.srcEvent?.button ?? evt?.button
            if (btn != null && btn !== 0) return
            const bin = info?.object?.bin
            if (!bin || !values) return
            setActiveBinIndex(bin.i)
            setActiveBinMemberPos(0)
            const members = membersForBin(bin.i)
            const multi = hasMultiPickModifier(info, evt)
            if (multi) {
              const base = picked.length ? picked : selected
              const union = new Set<number>(base)
              for (let i = 0; i < members.length; i++) union.add(members[i])
              const merged = Array.from(union)
              const mergedArr = new Int32Array(merged)
              setSelected(mergedArr)
              setPickedIndices(mergedArr)
              return
            }
            const memberArray = new Int32Array(members)
            setSelected(memberArray)
            setPickedIndices(memberArray)
          }}
          getTooltip={(info: any) => {
            const bin = info?.object?.bin
            if (!bin) return null
            if (bin.group != null) {
              return { text: `${formatNum(bin.x0)} – ${formatNum(bin.x1)}\ngroup: ${bin.group}\ncount: ${bin.groupCount}\ndensity: ${bin.density.toExponential(3)}` }
            }
            return { text: `${formatNum(bin.x0)} – ${formatNum(bin.x1)}\ncount: ${bin.count}` }
          }}
          onAfterRender={() => {
            if (firstFrameMarkedRef.current || !perfHasMark('dataset_to_first_plot')) return
            firstFrameMarkedRef.current = true
            perfMarkEnd('dataset_to_first_plot', 'dataset_to_first_plot_ms')
          }}
        />

        {(settings.showGrid || settings.showXAxis || settings.showYAxis) && (
          <div className="axis-overlay">
            {settings.showGrid && ticksX.map((tx, i) => {
              const p = worldToScreen(tx, viewState.target?.[1] ?? 0, viewState, size)
              return <div key={`gx-${i}`} style={{ position: 'absolute', left: Math.round(p.x), top: 0, bottom: 0, width: 1, background: 'rgba(180,200,220,0.15)' }} />
            })}
            {settings.showGrid && ticksYWorld.map((ty, i) => {
              const p = worldToScreen(viewState.target?.[0] ?? 0, ty, viewState, size)
              return <div key={`gy-${i}`} style={{ position: 'absolute', top: Math.round(p.y), left: 0, right: 0, height: 1, background: 'rgba(180,200,220,0.15)' }} />
            })}

            {settings.showXAxis && (
              <div className="axis-x">
                {settings.showTickLabels && ticksX.map((tx, i) => {
                  const p = worldToScreen(tx, viewState.target?.[1] ?? 0, viewState, size)
                  return <div key={i} className="tick" style={{ left: Math.round(p.x) }}><div className="tick-line" /><div className="tick-label" style={{ fontSize: xAxisSettings.tickLabelSize }}>{formatAxisTick(tx, xAxisSettings.tickDecimals)}</div></div>
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
                {settings.showTickLabels && ticksYWorld.map((ty, i) => {
                  const p = worldToScreen(viewState.target?.[0] ?? 0, ty, viewState, size)
                  return <div key={i} className="tick" style={{ top: Math.round(p.y) }}><div className="tick-line" /><div className="tick-label">{formatNum(-ty)}</div></div>
                })}
                <div className="axis-title">{groupedData ? 'density' : 'count'}</div>
              </div>
            )}
          </div>
        )}

        {groupKeys && groupedData && groupedStats && (
          <div
            className="histogram-split-legend"
            style={splitLegendPos ? { left: splitLegendPos.x, top: splitLegendPos.y } : { right: 6, bottom: 6 }}
          >
            <div className="histogram-split-legend-handle" onPointerDown={startSplitLegendDrag} title="Drag legend">
              Split legend
            </div>
            <div className="histogram-split-legend-section">
              {groupKeys.map((key, ki) => (
                <div key={key} className="histogram-split-legend-row">
                  <div className="histogram-split-legend-swatch" style={{ background: QUALITATIVE_PALETTE[ki % QUALITATIVE_PALETTE.length] }} />
                  <span>{key}</span>
                </div>
              ))}
            </div>
            <div className="histogram-split-stats">
              <div className="histogram-split-stats-title">Group stats</div>
              {groupedStats.map(stat => (
                <div key={stat.key} className="histogram-split-stats-row">
                  <span className="histogram-split-stats-name" title={stat.key}>
                    <span className="histogram-split-stats-dot" style={{ background: stat.color }} />
                    {stat.key}
                  </span>
                  <span>N {stat.n}</span>
                  <span>mean {Number.isFinite(stat.mean) ? formatNum(stat.mean) : '-'}</span>
                  <span>std {Number.isFinite(stat.std) ? formatNum(stat.std) : '-'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="plot-ranges" style={{ padding: '3px 8px 10px 8px', borderTop: '1px solid var(--color-border)', background: effectiveBg }}>
        <div className="row row-between gap-sm">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 600 }}>Histogram</div>
            <div className="legend">{spec.x}</div>
            <label className="legend" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>Bin count</span>
              <input type="number" min={1} max={5000} value={effectiveBinCount} onChange={(e) => {
                const next = clamp(Math.round(Number(e.target.value) || 1), 1, 5000)
                updatePlot({ id: spec.id, histSettings: { ...spec.histSettings, binCount: next, binSize: undefined } })
              }} style={{ width: 90, padding: '2px 6px' }} />
            </label>
            <label className="legend" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>Bin size</span>
              <input type="number" min={0} step="any" value={effectiveBinSize} onChange={(e) => {
                const next = Number(e.target.value)
                if (!Number.isFinite(next) || next <= 0) return
                updatePlot({ id: spec.id, histSettings: { ...spec.histSettings, binSize: next } })
              }} style={{ width: 120, padding: '2px 6px' }} />
            </label>
            {(activeBinIndex ?? selectedBinIndex) != null && activeBinMembers.length > 0 && (
              <div className="legend">Bin {(activeBinIndex ?? selectedBinIndex)! + 1} - {activeBinMembers.length} molecule{activeBinMembers.length === 1 ? '' : 's'}</div>
            )}
          </div>

          <button className="pager-btn" onClick={() => updatePlot({ id: spec.id, histSettings: { ...spec.histSettings, xAxis: { ...spec.histSettings?.xAxis, range: [fullRange.min, fullRange.max] } } })} title="Reset view">Reset view</button>
        </div>

        {settings.showStats && stats && (
          <div className="legend" style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>Visible N: {stats.visibleN}</span>
            <span>Selected-bin N: {stats.selectedBinN}</span>
            <span>Selected fraction: {(stats.selectedBinFraction * 100).toFixed(2)}%</span>
            <span>Min: {formatNum(stats.min)}</span>
            <span>Max: {formatNum(stats.max)}</span>
            <span>Mean: {formatNum(stats.mean)}</span>
            <span>Median: {formatNum(stats.median)}</span>
            <span>Std: {formatNum(stats.std)}</span>
          </div>
        )}

        {/*
          {(activeBinIndex ?? selectedBinIndex) != null && activeBinMembers.length > 1 && (
            <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="legend filter-legend" style={{ minWidth: 60 }}>Bin member</span>
              <div style={{ minWidth: 220, flexGrow: 1 }}>
                <Slider min={0} max={activeBinMembers.length - 1} step={1} value={activeBinMemberPos} onChange={(val: any) => {
                  const pos = clamp(Array.isArray(val) ? val[0] : Number(val), 0, activeBinMembers.length - 1)
                  setActiveBinMemberPos(pos)
                  const idx = activeBinMembers[pos]
                  if (Number.isInteger(idx) && idx >= 0) setSelected(new Int32Array([idx]))
                }} />
              </div>
              <div className="legend" style={{ minWidth: 160 }}>{activeBinMemberPos + 1} / {activeBinMembers.length}</div>
              <div className="legend" style={{ minWidth: 220 }}>{ds.ids[activeBinMembers[activeBinMemberPos]]}</div>
            </div>
          )}
        */}

        <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="legend filter-legend" style={{ minWidth: 60 }}>X</span>
          <input type="number" className="input_number_no_spinner" value={xRange[0]} onChange={(e) => {
            const v = Number(e.target.value)
            if (!Number.isFinite(v)) return
            updatePlot({ id: spec.id, histSettings: { ...spec.histSettings, xAxis: { ...spec.histSettings?.xAxis, range: [clamp(v, fullRange.min, xRange[1]), xRange[1]] } } })
          }} style={{ width: 120 }} />
          <div style={{ minWidth: 220, flexGrow: 1 }}>
            <Slider range min={fullRange.min} max={fullRange.max} step={(fullRange.max - fullRange.min) * 0.01 || 1} value={[xRange[0], xRange[1]]} onChange={(vals: any) => {
              const [a, b] = vals as number[]
              updatePlot({ id: spec.id, histSettings: { ...spec.histSettings, xAxis: { ...spec.histSettings?.xAxis, range: [clamp(a, fullRange.min, fullRange.max), clamp(b, fullRange.min, fullRange.max)] } } })
            }} allowCross={false} />
          </div>
          <input type="number" className="input_number_no_spinner" value={xRange[1]} onChange={(e) => {
            const v = Number(e.target.value)
            if (!Number.isFinite(v)) return
            updatePlot({ id: spec.id, histSettings: { ...spec.histSettings, xAxis: { ...spec.histSettings?.xAxis, range: [xRange[0], clamp(v, xRange[0], fullRange.max)] } } })
          }} style={{ width: 120 }} />
        </div>
      </div>
    </div>
  )
}
