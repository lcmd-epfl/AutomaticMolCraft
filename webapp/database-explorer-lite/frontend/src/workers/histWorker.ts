
export type HistRequest = {
  values: Float32Array
  mask?: Uint8Array | Int8Array | Uint16Array | Int16Array | Int32Array | Uint32Array
  numBins: number
  // optional: precomputed bounds; if omitted worker computes
  xmin?: number
  xmax?: number
}

export type HistResponse = {
  xmin: number
  xmax: number
  dx: number
  maxCount: number
  counts: Int32Array
  rep: Int32Array
}

function isFiniteNumber(x: number) {
  return Number.isFinite(x)
}

self.onmessage = (e: MessageEvent<HistRequest>) => {
  const { values, mask, numBins } = e.data

  const n = values.length
  const binsN = Math.max(2, Math.min(500, Math.floor(numBins)))

  // bounds
  let xmin = e.data.xmin
  let xmax = e.data.xmax

  if (!(typeof xmin === 'number' && typeof xmax === 'number' && isFiniteNumber(xmin) && isFiniteNumber(xmax))) {
    let mn = Infinity
    let mx = -Infinity
    if (mask) {
      for (let i = 0; i < n; i++) {
        if (!mask[i]) continue
        const x = values[i]
        if (!isFiniteNumber(x)) continue
        if (x < mn) mn = x
        if (x > mx) mx = x
      }
    } else {
      for (let i = 0; i < n; i++) {
        const x = values[i]
        if (!isFiniteNumber(x)) continue
        if (x < mn) mn = x
        if (x > mx) mx = x
      }
    }
    xmin = mn
    xmax = mx
  }

  if (!isFiniteNumber(xmin!) || !isFiniteNumber(xmax!)) {
    // no data
    const counts = new Int32Array(binsN)
    const rep = new Int32Array(binsN)
    rep.fill(-1)
    const resp: HistResponse = { xmin: 0, xmax: 1, dx: 1 / binsN, maxCount: 1, counts, rep }
    ;(self as any).postMessage(resp, [counts.buffer, rep.buffer])
    return
  }

  if (xmax === xmin) xmax = xmin + 1

  const span = Math.max(1e-12, xmax - xmin)
  const dx = span / binsN

  const counts = new Int32Array(binsN)
  const rep = new Int32Array(binsN)
  rep.fill(-1)

  if (mask) {
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue
      const x = values[i]
      if (!isFiniteNumber(x)) continue
      let b = Math.floor((x - xmin) / dx)
      if (b < 0) b = 0
      if (b >= binsN) b = binsN - 1
      counts[b]++
      if (rep[b] === -1) rep[b] = i
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = values[i]
      if (!isFiniteNumber(x)) continue
      let b = Math.floor((x - xmin) / dx)
      if (b < 0) b = 0
      if (b >= binsN) b = binsN - 1
      counts[b]++
      if (rep[b] === -1) rep[b] = i
    }
  }

  let maxCount = 1
  for (let b = 0; b < binsN; b++) if (counts[b] > maxCount) maxCount = counts[b]

  const resp: HistResponse = { xmin, xmax, dx, maxCount, counts, rep }
  ;(self as any).postMessage(resp, [counts.buffer, rep.buffer])
}

