export type PerfSample = {
  name: string
  value: number
  at: number
}

type Listener = () => void

const MAX_SAMPLES = 400
const samples: PerfSample[] = []
const marks = new Map<string, number>()
const listeners = new Set<Listener>()

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function emit() {
  for (const fn of listeners) fn()
}

export function perfSubscribe(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function perfGetSamples() {
  return samples
}

export function perfRecord(name: string, value: number) {
  if (!Number.isFinite(value)) return
  samples.push({ name, value, at: nowMs() })
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES)
  }
  emit()
}

export function perfMarkStart(key: string) {
  marks.set(key, nowMs())
}

export function perfMarkEnd(key: string, metricName = key) {
  const start = marks.get(key)
  if (start == null) return
  marks.delete(key)
  perfRecord(metricName, nowMs() - start)
}

export function perfHasMark(key: string) {
  return marks.has(key)
}

export function perfClear() {
  samples.length = 0
  marks.clear()
  emit()
}
