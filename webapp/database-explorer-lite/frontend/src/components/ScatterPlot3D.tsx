import React, { useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { ScatterplotLayer, LineLayer, TextLayer } from '@deck.gl/layers'
import { OrbitView } from '@deck.gl/core'
import { useStore } from '../store/store'
import { useUIStore } from '../store/uiStore'
import { exportHostCanvasesToPng } from '../utils/plotExport'
import type { ScatterPlotSpec, ScatterSettings } from '../models/dataModel'
import { axisLabelExpressionToPlainText, formatAxisTick, generateLinearTicks, normalizeAxisSettings, normalizeRange, resolveAxisLabel } from '../utils/axisSettings'
import { MAX_AUTO_CATEGORICAL_CLASSES, categoryIndexMap, categoryLabelForValue, collectCategoryLegend, colorForCategoryLabel, paletteStops, rampColor, resolveScatterColorMode } from '../utils/scatterColor'

type Point3D = {
  index: number
  position: [number, number, number]
  color: [number, number, number, number]
  radius: number
}

type Range = { min: number; max: number }
type AxisLine = { source: [number, number, number]; target: [number, number, number]; color: [number, number, number, number] }
type AxisTickLine = { source: [number, number, number]; target: [number, number, number]; color: [number, number, number, number] }
type AxisTickLabel = { position: [number, number, number]; text: string; color: [number, number, number, number] }

const ORBIT_VIEW = new OrbitView({ id: 'orbit', orbitAxis: 'Z' })

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

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function normalizeScatterSettings(spec: ScatterPlotSpec): ScatterSettings {
  return {
    ...DEFAULT_SCATTER_SETTINGS,
    ...(spec.scatterSettings || {}),
    sizeBy: spec.scatterSettings?.sizeBy ?? spec.sizeBy,
    colorBy: spec.scatterSettings?.colorBy ?? spec.colorBy,
  }
}

function finiteRange(values: any): Range | null {
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

function formatNum(v: number) {
  const a = Math.abs(v)
  if (a >= 1000 || (a > 0 && a < 0.001)) return v.toExponential(2)
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(3)
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

function fitToRanges(x: Range, y: Range, z: Range) {
  const cx = (x.min + x.max) / 2
  const cy = (y.min + y.max) / 2
  const cz = (z.min + z.max) / 2
  const span = Math.max(x.max - x.min, y.max - y.min, z.max - z.min, 1e-6)
  return {
    target: [cx, cy, cz],
    zoom: Math.log2(120 / span),
    rotationX: 25,
    rotationOrbit: 30,
  }
}

export default function ScatterPlot3D({
  spec,
  exportNonce = 0,
  onExportError,
}: {
  spec: ScatterPlotSpec
  exportNonce?: number
  onExportError?: (message: string) => void
}) {
  const dataset = useStore(s => s.dataset)
  const visibleMask = useStore(s => s.visibleMask)
  const selected = useStore(s => s.selectedIndices)
  const picked = useStore(s => s.pickedIndices)
  const setSelected = useStore(s => s.setSelected)
  const togglePicked = useStore(s => s.togglePicked)
  const setPickedIndices = useStore(s => s.setPickedIndices)
  const clearPicked = useStore(s => s.clearPicked)
  const updatePlot = useStore(s => s.updatePlot)
  const theme = useUIStore(s => s.theme)
  const themeBg = useMemo(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#0f141a',
    [theme]
  )

  const settings = useMemo(() => normalizeScatterSettings(spec), [spec])
  const effectiveBg = settings.backgroundColor || themeBg
  const xAxisSettings = useMemo(() => normalizeAxisSettings(settings.xAxis), [settings.xAxis])
  const yAxisSettings = useMemo(() => normalizeAxisSettings(settings.yAxis), [settings.yAxis])
  const zAxisSettings = useMemo(() => normalizeAxisSettings(settings.zAxis), [settings.zAxis])

  const xVals: any = dataset?.columns?.[spec.x]
  const yVals: any = dataset?.columns?.[spec.y]
  const zVals: any = dataset?.columns?.[spec.z || '']
  const sizeVals: any = settings.sizeBy ? dataset?.columns?.[settings.sizeBy] : null
  const colorVals: any = settings.colorBy ? dataset?.columns?.[settings.colorBy] : null
  const colorMode = useMemo(
    () => resolveScatterColorMode(colorVals, {
      maxCategoricalClasses: MAX_AUTO_CATEGORICAL_CLASSES,
      forceCategorical: !!settings.forceCategoricalColorBy,
    }),
    [settings.forceCategoricalColorBy, colorVals]
  )
  const isContinuousColor = !!settings.colorBy && colorMode === 'continuous'
  const isCategoricalColor = !!settings.colorBy && colorMode === 'categorical'

  const xRange = useMemo(() => finiteRange(xVals), [xVals])
  const yRange = useMemo(() => finiteRange(yVals), [yVals])
  const zRange = useMemo(() => finiteRange(zVals), [zVals])
  const sizeRange = useMemo(() => finiteRange(sizeVals), [sizeVals])
  const colorRange = useMemo(() => (isContinuousColor ? finiteRange(colorVals) : null), [isContinuousColor, colorVals])
  const categoryLegend = useMemo(() => (isCategoricalColor ? collectCategoryLegend(colorVals) : []), [isCategoricalColor, colorVals])
  const categoryIndices = useMemo(() => categoryIndexMap(categoryLegend), [categoryLegend])

  const dataRangeX = useMemo<[number, number]>(() => [xRange?.min ?? 0, xRange?.max ?? 1], [xRange?.min, xRange?.max])
  const dataRangeY = useMemo<[number, number]>(() => [yRange?.min ?? 0, yRange?.max ?? 1], [yRange?.min, yRange?.max])
  const dataRangeZ = useMemo<[number, number]>(() => [zRange?.min ?? 0, zRange?.max ?? 1], [zRange?.min, zRange?.max])
  const displayXRange = useMemo<Range>(() => {
    const [min, max] = normalizeRange(xAxisSettings.range, dataRangeX)
    return { min, max }
  }, [xAxisSettings.range, dataRangeX])
  const displayYRange = useMemo<Range>(() => {
    const [min, max] = normalizeRange(yAxisSettings.range, dataRangeY)
    return { min, max }
  }, [yAxisSettings.range, dataRangeY])
  const displayZRange = useMemo<Range>(() => {
    const [min, max] = normalizeRange(zAxisSettings.range, dataRangeZ)
    return { min, max }
  }, [zAxisSettings.range, dataRangeZ])

  const [viewState, setViewState] = useState<any>(() => {
    if (xRange && yRange && zRange) return fitToRanges(displayXRange, displayYRange, displayZRange)
    return { target: [0, 0, 0], zoom: 1, rotationX: 25, rotationOrbit: 30 }
  })

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const hostRef = useRef<HTMLDivElement>(null)

  const colorbarTicks = useMemo(() => {
    if (!colorRange) return []
    const steps = [0, 0.25, 0.5, 0.75, 1]
    return steps.map(pct => ({ pct, value: colorRange.min + pct * (colorRange.max - colorRange.min) }))
  }, [colorRange])

  const dimSet = useMemo(() => {
    if (!settings.dimUnselected) return null
    const set = new Set<number>()
    for (let i = 0; i < selected.length; i++) set.add(selected[i])
    for (let i = 0; i < picked.length; i++) set.add(picked[i])
    return set
  }, [settings.dimUnselected, selected, picked])

  const points = useMemo(() => {
    if (!dataset || !xVals || !yVals || !zVals) return [] as Point3D[]
    const n = dataset.ids.length
    const out: Point3D[] = []

    for (let i = 0; i < n; i++) {
      const x = xVals[i]
      const y = yVals[i]
      const z = zVals[i]
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      if (visibleMask && visibleMask[i] !== 1) continue
      if (x < displayXRange.min || x > displayXRange.max) continue
      if (y < displayYRange.min || y > displayYRange.max) continue
      if (z < displayZRange.min || z > displayZRange.max) continue

      const isActive = !dimSet || dimSet.has(i)
      const alpha = clamp(Math.round(255 * settings.opacity * (isActive ? 1 : 0.18)), 0, 255)

      let color = hexToRgba(settings.markerColor, alpha)
      if (settings.colorBy && colorVals && colorRange) {
        const cv = colorVals[i]
        if (Number.isFinite(cv)) {
          const t = (cv - colorRange.min) / (colorRange.max - colorRange.min)
          color = rampColor(t, alpha, settings.colorPalette)
        }
      } else if (settings.colorBy && colorVals && isCategoricalColor) {
        const label = categoryLabelForValue(colorVals[i])
        color = colorForCategoryLabel(label, alpha, settings.colorPalette, categoryIndices.get(label))
      }

      let radius = settings.markerSize
      if (settings.sizeBy && sizeVals && sizeRange) {
        const sv = sizeVals[i]
        if (Number.isFinite(sv)) {
          const t = clamp((sv - sizeRange.min) / (sizeRange.max - sizeRange.min), 0, 1)
          radius = 2 + t * 10
        }
      }

      out.push({ index: i, position: [x, y, z], color, radius })
    }

    return out
  }, [dataset, xVals, yVals, zVals, visibleMask, dimSet, settings.opacity, settings.markerColor, settings.markerSize, settings.colorBy, settings.colorPalette, colorVals, colorRange, isCategoricalColor, categoryIndices, settings.sizeBy, sizeVals, sizeRange, displayXRange.min, displayXRange.max, displayYRange.min, displayYRange.max, displayZRange.min, displayZRange.max])

  const colorbarStyle = useMemo(() => {
    const stops = paletteStops(settings.colorPalette)
      .map((c, i, arr) => `rgb(${c[0]}, ${c[1]}, ${c[2]}) ${(i / Math.max(1, arr.length - 1)) * 100}%`)
      .join(', ')
    return { background: `linear-gradient(to top, ${stops})` }
  }, [settings.colorPalette])

  useEffect(() => {
    if (!xRange || !yRange || !zRange) return
    setViewState((prev: any) => ({ ...prev, ...fitToRanges(displayXRange, displayYRange, displayZRange) }))
  }, [spec.x, spec.y, spec.z, displayXRange.min, displayXRange.max, displayYRange.min, displayYRange.max, displayZRange.min, displayZRange.max, xRange, yRange, zRange])

  useEffect(() => {
    const cmd = settings.viewCommand
    if (!cmd || !xRange || !yRange || !zRange) return
    if (cmd.type === 'fitAll' || cmd.type === 'fitVisible' || cmd.type === 'reset') {
      updatePlot({
        id: spec.id,
        scatterSettings: {
          ...spec.scatterSettings,
          xAxis: { ...spec.scatterSettings?.xAxis, range: dataRangeX },
          yAxis: { ...spec.scatterSettings?.yAxis, range: dataRangeY },
          zAxis: { ...spec.scatterSettings?.zAxis, range: dataRangeZ },
          viewCommand: undefined
        }
      })
      setViewState((prev: any) => ({ ...prev, ...fitToRanges({ min: dataRangeX[0], max: dataRangeX[1] }, { min: dataRangeY[0], max: dataRangeY[1] }, { min: dataRangeZ[0], max: dataRangeZ[1] }) }))
    }
  }, [settings.viewCommand?.nonce, xRange, yRange, zRange, dataRangeX, dataRangeY, dataRangeZ])

  useEffect(() => {
    if (!exportNonce) return
    const host = hostRef.current
    if (!host) return
    exportHostCanvasesToPng({
      host,
      filename: `${spec.type}_${spec.x}_${spec.y}_${spec.z || 'z'}.png`,
      scale: 3,
      background: effectiveBg,
    }).catch((err: any) => {
      onExportError?.(`Failed to export PNG: ${err?.message || String(err)}`)
    })
  }, [exportNonce])

  const layer = useMemo(() => {
    return new ScatterplotLayer<Point3D>({
      id: `scatter3d-${spec.id}`,
      data: points,
      pickable: true,
      radiusUnits: 'pixels',
      stroked: false,
      getPosition: d => d.position,
      getFillColor: d => d.color,
      getRadius: d => d.radius,
      radiusMinPixels: 1,
      radiusMaxPixels: 40,
    })
  }, [points, spec.id])

  const axisLayers = useMemo(() => {
    if (!xRange || !yRange || !zRange) return [] as any[]
    if (!settings.showTickLabels) return [] as any[]

    const axisColor: [number, number, number, number] = [212, 220, 230, 230]
    const tickColor: [number, number, number, number] = [174, 184, 196, 230]
    const labelColor: [number, number, number, number] = [235, 241, 248, 240]
    const tickLen = Math.max(displayXRange.max - displayXRange.min, displayYRange.max - displayYRange.min, displayZRange.max - displayZRange.min) * 0.015

    const origin: [number, number, number] = [displayXRange.min, displayYRange.min, displayZRange.min]
    const xEnd: [number, number, number] = [displayXRange.max, displayYRange.min, displayZRange.min]
    const yEnd: [number, number, number] = [displayXRange.min, displayYRange.max, displayZRange.min]
    const zEnd: [number, number, number] = [displayXRange.min, displayYRange.min, displayZRange.max]

    const axisLines: AxisLine[] = [
      { source: origin, target: xEnd, color: axisColor },
      { source: origin, target: yEnd, color: axisColor },
      { source: origin, target: zEnd, color: axisColor },
    ]
    const tickLines: AxisTickLine[] = []
    const tickLabels: AxisTickLabel[] = []

    for (const t of generateLinearTicks(displayXRange.min, displayXRange.max, xAxisSettings.tickCount)) {
      tickLines.push({
        source: [t, displayYRange.min, displayZRange.min],
        target: [t, displayYRange.min + tickLen, displayZRange.min],
        color: tickColor,
      })
      tickLabels.push({
        position: [t, displayYRange.min + tickLen * 2.2, displayZRange.min],
        text: formatAxisTick(t, xAxisSettings.tickDecimals),
        color: labelColor,
      })
    }
    for (const t of generateLinearTicks(displayYRange.min, displayYRange.max, yAxisSettings.tickCount)) {
      tickLines.push({
        source: [displayXRange.min, t, displayZRange.min],
        target: [displayXRange.min + tickLen, t, displayZRange.min],
        color: tickColor,
      })
      tickLabels.push({
        position: [displayXRange.min + tickLen * 2.2, t, displayZRange.min],
        text: formatAxisTick(t, yAxisSettings.tickDecimals),
        color: labelColor,
      })
    }
    for (const t of generateLinearTicks(displayZRange.min, displayZRange.max, zAxisSettings.tickCount)) {
      tickLines.push({
        source: [displayXRange.min, displayYRange.min, t],
        target: [displayXRange.min + tickLen, displayYRange.min, t],
        color: tickColor,
      })
      tickLabels.push({
        position: [displayXRange.min + tickLen * 2.2, displayYRange.min, t],
        text: formatAxisTick(t, zAxisSettings.tickDecimals),
        color: labelColor,
      })
    }

    const xAxisLabel = axisLabelExpressionToPlainText(resolveAxisLabel(settings.xAxis, spec.x))
    const yAxisLabel = axisLabelExpressionToPlainText(resolveAxisLabel(settings.yAxis, spec.y))
    const zAxisLabel = axisLabelExpressionToPlainText(resolveAxisLabel(settings.zAxis, spec.z || 'z'))

    tickLabels.push(
      { position: [displayXRange.max, displayYRange.min + tickLen * 3.6, displayZRange.min], text: xAxisLabel, color: labelColor },
      { position: [displayXRange.min + tickLen * 3.6, displayYRange.max, displayZRange.min], text: yAxisLabel, color: labelColor },
      { position: [displayXRange.min + tickLen * 3.6, displayYRange.min, displayZRange.max], text: zAxisLabel, color: labelColor },
    )

    return [
      new LineLayer<AxisLine>({
        id: `scatter3d-axes-${spec.id}`,
        data: axisLines,
        getSourcePosition: d => d.source,
        getTargetPosition: d => d.target,
        getColor: d => d.color,
        getWidth: 2,
        widthUnits: 'pixels',
        pickable: false,
      }),
      new LineLayer<AxisTickLine>({
        id: `scatter3d-axis-ticks-${spec.id}`,
        data: tickLines,
        getSourcePosition: d => d.source,
        getTargetPosition: d => d.target,
        getColor: d => d.color,
        getWidth: 1,
        widthUnits: 'pixels',
        pickable: false,
      }),
      new TextLayer<AxisTickLabel>({
        id: `scatter3d-axis-labels-${spec.id}`,
        data: tickLabels,
        getPosition: d => d.position,
        getText: d => d.text,
        getColor: d => d.color,
        getSize: d => d.text === axisLabelExpressionToPlainText(resolveAxisLabel(settings.xAxis, spec.x))
          ? xAxisSettings.labelSize
          : d.text === axisLabelExpressionToPlainText(resolveAxisLabel(settings.yAxis, spec.y))
            ? yAxisSettings.labelSize
            : d.text === axisLabelExpressionToPlainText(resolveAxisLabel(settings.zAxis, spec.z || 'z'))
              ? zAxisSettings.labelSize
              : Math.max(xAxisSettings.tickLabelSize, yAxisSettings.tickLabelSize, zAxisSettings.tickLabelSize),
        sizeUnits: 'pixels',
        billboard: true,
        pickable: false,
      })
    ]
  }, [settings.showTickLabels, settings.xAxis, settings.yAxis, settings.zAxis, xRange, yRange, zRange, displayXRange, displayYRange, displayZRange, xAxisSettings, yAxisSettings, zAxisSettings, spec.id, spec.x, spec.y, spec.z])

  if (!dataset || !spec.z) {
    return <div className="plot-empty">3D scatter requires X/Y/Z numeric columns.</div>
  }

  return (
    <div ref={hostRef} className="plot-canvas" style={{ position: 'relative', width: '100%', height: '100%', background: effectiveBg }}>
      <DeckGL
        views={ORBIT_VIEW as any}
        viewState={viewState}
        controller={true}
        layers={[layer, ...axisLayers]}
        onViewStateChange={({ viewState: vs }: any) => {
          setViewState(vs)
        }}
        pickingRadius={8}
        onClick={(info: any, evt: any) => {
          const idx = info?.object?.index
          const multi = !!(evt?.srcEvent?.ctrlKey || evt?.srcEvent?.metaKey || evt?.ctrlKey || evt?.metaKey)
          if (!Number.isInteger(idx) || idx < 0) {
            if (!multi) {
              clearPicked()
              setSelected(new Int32Array(0))
            }
            return
          }
          if (multi) {
            togglePicked(idx)
          } else {
            setPickedIndices(new Int32Array([idx]))
          }
          setSelected(new Int32Array([idx]))
        }}
      />

      {settings.colorBy && settings.showColorbar && colorRange && (
        <div className="scatter-colorbar">
          <div className="scatter-colorbar-title" title={settings.colorBy}>{settings.colorBy}</div>
          <div className="scatter-colorbar-body">
            <div className="scatter-colorbar-ramp" style={colorbarStyle} />
            <div className="scatter-colorbar-ticks">
              {colorbarTicks.map(t => (
                <div key={t.pct} className="scatter-colorbar-tick" style={{ bottom: `${t.pct * 100}%` }}>
                  <span className="scatter-colorbar-tick-line" />
                  <span className="scatter-colorbar-tick-label">{formatNum(t.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {settings.colorBy && settings.showColorbar && isCategoricalColor && (
        <div className="scatter-colorbar">
          <div className="scatter-colorbar-title" title={settings.colorBy}>{settings.colorBy}</div>
          <div style={{ maxHeight: 190, overflowY: 'auto', display: 'grid', gap: 4, marginTop: 6 }}>
            {categoryLegend.map(item => {
              const c = colorForCategoryLabel(item.label, 230, settings.colorPalette, categoryIndices.get(item.label))
              return (
                <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 2, display: 'inline-block', background: `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3] / 255})`, border: '1px solid rgba(255,255,255,0.28)' }} />
                  <span className="scatter-colorbar-tick-label" title={item.label}>{item.label}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
