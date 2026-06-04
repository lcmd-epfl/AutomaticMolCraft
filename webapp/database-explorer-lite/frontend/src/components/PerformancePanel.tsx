import React, { useEffect, useMemo, useState } from 'react'
import { perfClear, perfGetSamples, perfRecord, perfSubscribe, type PerfSample } from '../utils/perfMetrics'

function latestMetric(samples: PerfSample[], name: string): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].name === name) return samples[i].value
  }
  return null
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

function metricWindow(samples: PerfSample[], name: string, msWindow: number) {
  const now = performance.now()
  const out: number[] = []
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]
    if (s.name !== name) continue
    if (now - s.at > msWindow) break
    out.push(s.value)
  }
  return out
}

export default function PerformancePanel() {
  const [open, setOpen] = useState(false)
  const [samples, setSamples] = useState<PerfSample[]>(() => [...perfGetSamples()])
  const [fpsState, setFpsState] = useState({ fps: 0, lowFps: 0 })

  useEffect(() => perfSubscribe(() => setSamples([...perfGetSamples()])), [])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const fpsHistory: number[] = []
    const step = (t: number) => {
      const dt = Math.max(0.0001, t - last)
      last = t
      const fps = 1000 / dt
      fpsHistory.push(fps)
      if (fpsHistory.length > 300) fpsHistory.shift()

      const low = percentile(fpsHistory, 1) ?? fps
      setFpsState({ fps, lowFps: low })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        perfRecord('longtask_ms', e.duration)
      }
    })
    try {
      obs.observe({ entryTypes: ['longtask'] })
    } catch {
      return
    }
    return () => obs.disconnect()
  }, [])

  const summary = useMemo(() => {
    const filterMs = latestMetric(samples, 'filter_apply_ms')
    const ttfpMs = latestMetric(samples, 'dataset_to_first_plot_ms')
    const longTasks = metricWindow(samples, 'longtask_ms', 10000)
    const longTaskCount = longTasks.length
    const longTaskP95 = percentile(longTasks, 95)
    return { filterMs, ttfpMs, longTaskCount, longTaskP95 }
  }, [samples])

  return (
    <div className="perf-panel">
      <button className="perf-toggle" onClick={() => setOpen(v => !v)}>
        {open ? 'Perf: Hide' : 'Perf: Show'}
      </button>
      {open && (
        <div className="perf-body">
          <div className="perf-row">
            <span>Live FPS</span>
            <b>{Math.round(fpsState.fps)}</b>
          </div>
          <div className="perf-row">
            <span>1% Low FPS</span>
            <b>{Math.round(fpsState.lowFps)}</b>
          </div>
          <div className="perf-row">
            <span>Filter Apply</span>
            <b>{summary.filterMs == null ? '-' : `${summary.filterMs.toFixed(1)} ms`}</b>
          </div>
          <div className="perf-row">
            <span>First Plot</span>
            <b>{summary.ttfpMs == null ? '-' : `${summary.ttfpMs.toFixed(1)} ms`}</b>
          </div>
          <div className="perf-row">
            <span>Long Tasks (10s)</span>
            <b>{summary.longTaskCount}</b>
          </div>
          <div className="perf-row">
            <span>Long Task p95</span>
            <b>{summary.longTaskP95 == null ? '-' : `${summary.longTaskP95.toFixed(1)} ms`}</b>
          </div>
          <button className="perf-clear" onClick={perfClear}>Clear</button>
        </div>
      )}
    </div>
  )
}
