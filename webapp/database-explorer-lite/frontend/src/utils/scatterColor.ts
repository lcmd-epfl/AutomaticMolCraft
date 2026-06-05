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
  if (options?.forceCategorical) return 'categorical'
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

const TABLEAU_20: Array<[number, number, number]> = [
  [78, 121, 167], [242, 142, 43], [225, 87, 89], [118, 183, 178], [89, 161, 79],
  [237, 201, 72], [176, 122, 162], [255, 157, 167], [156, 117, 95], [186, 176, 172],
  [114, 158, 206], [255, 190, 125], [255, 142, 144], [154, 218, 210], [140, 209, 125],
  [255, 226, 133], [211, 166, 201], [255, 188, 121], [214, 210, 207], [121, 199, 229],
]

const QUALITATIVE_PALETTES: Record<NonNullable<ScatterSettings['colorPalette']>, Array<[number, number, number]>> = {
  tealSunset: TABLEAU_20,
  viridis: [
    [68, 1, 84], [253, 231, 37], [33, 145, 140], [59, 82, 139], [144, 215, 67],
    [72, 40, 120], [40, 174, 128], [190, 223, 38], [49, 104, 142], [94, 201, 98],
    [90, 24, 120], [31, 158, 137], [216, 226, 25], [53, 183, 121], [44, 113, 142],
    [115, 208, 86], [72, 193, 110], [38, 130, 142], [173, 220, 48], [62, 73, 137],
  ],
  plasma: [
    [13, 8, 135], [240, 249, 33], [203, 71, 119], [126, 3, 167], [248, 149, 64],
    [75, 3, 161], [229, 107, 93], [156, 23, 158], [251, 180, 47], [183, 48, 139],
    [46, 5, 150], [218, 90, 105], [104, 0, 168], [244, 136, 73], [230, 246, 36],
    [142, 13, 164], [238, 121, 83], [88, 2, 165], [249, 164, 55], [169, 35, 149],
  ],
  cividis: [
    [0, 34, 78], [253, 234, 69], [109, 111, 112], [53, 76, 110], [166, 146, 99],
    [17, 53, 91], [207, 179, 83], [82, 94, 112], [137, 128, 107], [232, 207, 75],
    [35, 66, 103], [184, 162, 91], [68, 85, 112], [151, 137, 103], [220, 194, 79],
    [8, 45, 85], [193, 170, 87], [95, 103, 113], [123, 120, 110], [242, 220, 72],
  ],
  turbo: [
    [48, 18, 59], [249, 210, 74], [41, 122, 142], [122, 4, 3], [40, 187, 116],
    [70, 55, 170], [238, 82, 54], [30, 154, 137], [174, 22, 39], [141, 224, 67],
    [55, 89, 160], [220, 48, 43], [34, 174, 127], [199, 31, 47], [196, 238, 57],
    [45, 106, 151], [250, 117, 51], [37, 201, 101], [151, 13, 25], [229, 229, 64],
  ],
}

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
  palette: ScatterSettings['colorPalette'],
  categoryIndex?: number
): [number, number, number, number] {
  if (label === MISSING_CATEGORY_LABEL) return [MISSING_CATEGORY_COLOR[0], MISSING_CATEGORY_COLOR[1], MISSING_CATEGORY_COLOR[2], clamp(alpha, 0, 255)]
  const colors = QUALITATIVE_PALETTES[palette || 'tealSunset']
  const index = categoryIndex ?? hashString(label)
  const c = colors[index % colors.length]
  return [c[0], c[1], c[2], clamp(alpha, 0, 255)]
}

export function categoryIndexMap(legend: CategoryLegendItem[]): Map<string, number> {
  const out = new Map<string, number>()
  let index = 0
  for (const item of legend) {
    if (item.label === MISSING_CATEGORY_LABEL) continue
    out.set(item.label, index)
    index += 1
  }
  return out
}
