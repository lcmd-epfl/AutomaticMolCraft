import type { Axis2DSettings, Axis3DSettings } from '../models/dataModel'

export const DEFAULT_AXIS_TICK_COUNT = 6
export const DEFAULT_AXIS_TICK_LABEL_SIZE = 10
export const DEFAULT_AXIS_TICK_DECIMALS = 2
export const DEFAULT_AXIS_LABEL_SIZE = 11

export type AxisLabelSegment = {
  text: string
  kind: 'text' | 'sub' | 'sup'
}

const SUBSCRIPT_MAP: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
  A: 'ₐ', E: 'ₑ', H: 'ₕ', I: 'ᵢ', J: 'ⱼ', K: 'ₖ', L: 'ₗ', M: 'ₘ', N: 'ₙ', O: 'ₒ', P: 'ₚ', R: 'ᵣ', S: 'ₛ', T: 'ₜ', U: 'ᵤ', V: 'ᵥ', X: 'ₓ',
}

const SUPERSCRIPT_MAP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
  A: 'ᴬ', B: 'ᴮ', D: 'ᴰ', E: 'ᴱ', G: 'ᴳ', H: 'ᴴ', I: 'ᴵ', J: 'ᴶ', K: 'ᴷ', L: 'ᴸ', M: 'ᴹ', N: 'ᴺ', O: 'ᴼ', P: 'ᴾ', R: 'ᴿ', T: 'ᵀ', U: 'ᵁ', V: 'ⱽ', W: 'ᵂ',
}

export function normalizeAxisSettings<T extends Axis2DSettings | Axis3DSettings | undefined>(axis: T): Axis2DSettings {
  return {
    range: axis?.range,
    tickCount: clampInt(axis?.tickCount, 2, 100, DEFAULT_AXIS_TICK_COUNT),
    tickLabelSize: clampNumber(axis?.tickLabelSize, 6, 48, DEFAULT_AXIS_TICK_LABEL_SIZE),
    tickDecimals: clampInt(axis?.tickDecimals, 0, 12, DEFAULT_AXIS_TICK_DECIMALS),
    label: axis?.label ?? '',
    labelSize: clampNumber(axis?.labelSize, 6, 48, DEFAULT_AXIS_LABEL_SIZE),
  }
}

export function resolveAxisLabel(axis: Axis2DSettings | Axis3DSettings | undefined, fallback: string) {
  const label = axis?.label?.trim()
  return label ? label : fallback
}

export function parseAxisLabelExpression(label: string): AxisLabelSegment[] {
  const out: AxisLabelSegment[] = []
  let i = 0
  while (i < label.length) {
    const nextSub = label.indexOf('$_', i)
    const nextSup = label.indexOf('^', i)
    const candidates = [nextSub, nextSup].filter(v => v >= 0)
    const next = candidates.length ? Math.min(...candidates) : -1
    if (next < 0) {
      out.push({ text: label.slice(i), kind: 'text' })
      break
    }
    if (next > i) out.push({ text: label.slice(i, next), kind: 'text' })

    if (next === nextSub) {
      const parsed = parseDelimitedExpression(label, next + 2)
      if (!parsed) {
        out.push({ text: '$_', kind: 'text' })
        i = next + 2
        continue
      }
      out.push({ text: parsed.value, kind: 'sub' })
      i = parsed.end
      continue
    }

    const parsed = parseDelimitedExpression(label, next + 1)
    if (!parsed) {
      out.push({ text: '^', kind: 'text' })
      i = next + 1
      continue
    }
    out.push({ text: parsed.value, kind: 'sup' })
    i = parsed.end
  }
  return out.filter(segment => segment.text.length > 0)
}

export function axisLabelExpressionToPlainText(label: string) {
  return parseAxisLabelExpression(label)
    .map(segment => {
      if (segment.kind === 'text') return segment.text
      if (segment.kind === 'sub') return mapDecoratedText(segment.text, SUBSCRIPT_MAP)
      return mapDecoratedText(segment.text, SUPERSCRIPT_MAP)
    })
    .join('')
}

function parseDelimitedExpression(input: string, start: number): { value: string; end: number } | null {
  if (start >= input.length) return null
  if (input[start] === '{') {
    const close = input.indexOf('}', start + 1)
    if (close < 0) return null
    let end = close + 1
    if (input[end] === '$') end += 1
    return { value: input.slice(start + 1, close), end }
  }
  const value = input[start]
  let end = start + 1
  if (input[end] === '$') end += 1
  return { value, end }
}

function mapDecoratedText(text: string, map: Record<string, string>) {
  let out = ''
  for (const char of text) out += map[char] || char
  return out
}

export function normalizeRange(range: [number, number] | undefined, fallback: [number, number]): [number, number] {
  if (!range) return fallback
  const [min, max] = range
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return fallback
  return [min, max]
}

export function formatAxisTick(value: number, decimals: number) {
  return value.toFixed(clampInt(decimals, 0, 12, DEFAULT_AXIS_TICK_DECIMALS))
}

export function generateLinearTicks(min: number, max: number, tickCount: number) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min]
  const count = clampInt(tickCount, 2, 100, DEFAULT_AXIS_TICK_COUNT)
  if (count === 2) return [min, max]
  const step = (max - min) / (count - 1)
  const ticks: number[] = []
  for (let i = 0; i < count; i++) {
    ticks.push(i === count - 1 ? max : min + step * i)
  }
  return ticks
}

export function clampNumber(value: number | undefined, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value as number))
}

export function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value as number)))
}
