import type { ScatterDensityMethod } from '../models/dataModel'

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const value = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel[i + radius] = value
    sum += value
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum
  return kernel
}

function smoothGrid(grid: Float32Array, size: number, smoothing: number): Float32Array {
  const kernel = gaussianKernel(Math.max(0.35, smoothing))
  const radius = Math.floor(kernel.length / 2)
  const horizontal = new Float32Array(grid.length)
  const output = new Float32Array(grid.length)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        sum += grid[y * size + clamp(x + k, 0, size - 1)] * kernel[k + radius]
      }
      horizontal[y * size + x] = sum
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0
      for (let k = -radius; k <= radius; k++) {
        sum += horizontal[clamp(y + k, 0, size - 1) * size + x] * kernel[k + radius]
      }
      output[y * size + x] = sum
    }
  }
  return output
}

export function computeScatterDensity(
  positions: Float32Array,
  visibleMask: Uint8Array | null | undefined,
  options: {
    method: ScatterDensityMethod
    gridSize?: number
    smoothing: number
  }
): Float32Array {
  const pointCount = Math.floor(positions.length / 2)
  const values = new Float32Array(pointCount)
  values.fill(Number.NaN)

  let visibleCount = 0
  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  for (let i = 0; i < pointCount; i++) {
    if (visibleMask && visibleMask[i] !== 1) continue
    const x = positions[i * 2]
    const y = positions[i * 2 + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    visibleCount++
    xMin = Math.min(xMin, x)
    xMax = Math.max(xMax, x)
    yMin = Math.min(yMin, y)
    yMax = Math.max(yMax, y)
  }
  if (!visibleCount) return values

  const autoSize = clamp(Math.round(Math.sqrt(visibleCount) / 2), 16, 96)
  const size = clamp(Math.round(options.gridSize || autoSize), 8, 160)
  const xSpan = Math.max(Number.EPSILON, xMax - xMin)
  const ySpan = Math.max(Number.EPSILON, yMax - yMin)
  const cells = new Int32Array(pointCount)
  cells.fill(-1)
  const counts = new Float32Array(size * size)

  for (let i = 0; i < pointCount; i++) {
    if (visibleMask && visibleMask[i] !== 1) continue
    const x = positions[i * 2]
    const y = positions[i * 2 + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const gx = clamp(Math.floor(((x - xMin) / xSpan) * size), 0, size - 1)
    const gy = clamp(Math.floor(((y - yMin) / ySpan) * size), 0, size - 1)
    const cell = gy * size + gx
    cells[i] = cell
    counts[cell]++
  }

  const grid = options.method === 'kde'
    ? smoothGrid(counts, size, options.smoothing)
    : counts
  for (let i = 0; i < pointCount; i++) {
    if (cells[i] >= 0) values[i] = grid[cells[i]]
  }
  return values
}
