import type { ScatterSettings } from '../models/dataModel'

export type ScatterColorMode = 'continuous' | 'categorical'
export const MAX_AUTO_CATEGORICAL_CLASSES = 20

export const MISSING_CATEGORY_LABEL = '(missing)'
export const MISSING_CATEGORY_COLOR: [number, number, number, number] = [130, 138, 148, 230]

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

export function paletteStops(palette: ScatterSettings['colorPalette']): Array<[number, number, number]> {
  if (palette === 'viridis') return [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]]
  if (palette === 'plasma') return [[13, 8, 135], [126, 3, 167], [203, 71, 119], [248, 149, 64], [240, 249, 33]]
  if (palette === 'cividis') return [[0, 34, 78], [53, 76, 110], [109, 111, 112], [166, 146, 99], [253, 234, 69]]
  if (palette === 'turbo') return [[48, 18, 59], [41, 122, 142], [40, 187, 116], [249, 210, 74], [122, 4, 3]]
  return [[39, 67, 130], [34, 150, 170], [80, 190, 125], [245, 202, 80]]
}

export function rampColor(tRaw: number, alpha: number, palette: ScatterSettings['colorPalette']): [number, number, number, number] {
  const t = clamp(tRaw, 0, 1)
  const stops = paletteStops(palette)
  const scaled = t * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(scaled))
  const f = scaled - i
  const a = stops[i]
  const b = stops[i + 1]
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
    alpha
  ]
}

function isMissingValue(value: unknown) {
  return value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value))
}

export function categoryLabelForValue(value: unknown): string {
  if (isMissingValue(value)) return MISSING_CATEGORY_LABEL
  return String(value)
}

export function resolveScatterColorMode(
  values: any,
  options?: { maxCategoricalClasses?: number; forceCategorical?: boolean }
): ScatterColorMode {
  if (!values || typeof values.length !== 'number') return 'categorical'
  const maxCategoricalClasses = options?.maxCategoricalClasses ?? MAX_AUTO_CATEGORICAL_CLASSES

  let nonMissing = 0
  let numericFinite = 0
  let nonNumeric = 0
  const uniqueCats = new Set<string>()
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (isMissingValue(v)) continue
    nonMissing += 1
    if (typeof v === 'number' && Number.isFinite(v)) numericFinite += 1
    else nonNumeric += 1
    uniqueCats.add(String(v))
  }

  if (nonMissing === 0) return 'categorical'
  if (options?.forceCategorical) {
    return uniqueCats.size <= maxCategoricalClasses ? 'categorical' : 'continuous'
  }
  if (nonNumeric === 0 && numericFinite >= 2) return 'continuous'
  if (numericFinite >= 8 && numericFinite / nonMissing >= 0.98) return 'continuous'
  if (uniqueCats.size > maxCategoricalClasses) return 'continuous'
  return 'categorical'
}

export type CategoryLegendItem = {
  key: string
  label: string
}

export function collectCategoryLegend(values: any): CategoryLegendItem[] {
  if (!values || typeof values.length !== 'number') return []
  const seen = new Set<string>()
  const out: CategoryLegendItem[] = []
  for (let i = 0; i < values.length; i++) {
    const label = categoryLabelForValue(values[i])
    if (seen.has(label)) continue
    seen.add(label)
    out.push({ key: label, label })
  }
  return out
}

// Qualitative palette — visually distinct colors for categorical data
const CATEGORICAL_COLORS: Array<[number, number, number]> = [
  [78, 121, 167],
  [242, 142, 43],
  [225, 87, 89],
  [118, 183, 178],
  [89, 161, 79],
  [237, 201, 72],
  [176, 122, 162],
  [255, 157, 167],
  [156, 117, 95],
  [186, 176, 172],
  [59, 162, 114],
  [255, 120, 70],
]

function hashString(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function colorForCategoryLabel(
  label: string,
  alpha: number,
  _palette: ScatterSettings['colorPalette']
): [number, number, number, number] {
  if (label === MISSING_CATEGORY_LABEL) return [MISSING_CATEGORY_COLOR[0], MISSING_CATEGORY_COLOR[1], MISSING_CATEGORY_COLOR[2], clamp(alpha, 0, 255)]
  const h = hashString(label)
  const c = CATEGORICAL_COLORS[h % CATEGORICAL_COLORS.length]
  return [c[0], c[1], c[2], clamp(alpha, 0, 255)]
}
