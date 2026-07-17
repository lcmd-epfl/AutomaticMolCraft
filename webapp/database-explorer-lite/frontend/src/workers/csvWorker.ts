/// <reference lib="webworker" />
import Papa from 'papaparse'
import type { ParseCSVMsg, ParsedMsg } from './types'


// Tokens that mean "missing numeric value", not "this column is categorical".
const MISSING_NUMERIC_TOKENS = new Set(['', 'nan', 'na', 'n/a', 'null', 'none'])

function isMissingNumericToken(v: string): boolean {
  return MISSING_NUMERIC_TOKENS.has(v.trim().toLowerCase())
}

self.onmessage = (e: MessageEvent<ParseCSVMsg>) => {
if (e.data.type !== 'parse') return
const file = e.data.file
const totalBytes = file.size || 1
const ids: string[] = []
const columns: Record<string, any> = {}
let headers: string[] = []
let rowCount = 0
// Path/extension stripping can collapse distinct ids (a/mol1.xyz, b/mol1.xyz).
// Track used ids and de-dupe with a numeric suffix instead of silently merging.
const usedIds = new Set<string>()
let idCollisions = 0


Papa.parse(file, {
header: true,
worker: false, // already in a worker
skipEmptyLines: true,
dynamicTyping: false,
step: (res, parser) => {
const row = res.data as Record<string, string>
if (rowCount === 0) headers = Object.keys(row)
// Expect Column 0 to be id
const rawId = String(row[headers[0]] ?? '').trim()
let id = rawId.split(/[\\/]/).pop()?.trim().replace(/\.xyz$/i, '') || rawId
if (usedIds.has(id)) {
  idCollisions++
  let n = 2
  while (usedIds.has(`${id}_${n}`)) n++
  id = `${id}_${n}`
}
usedIds.add(id)
ids.push(id)
for (let i = 1; i < headers.length; i++) {
const k = headers[i]
const v = row[k] ?? ''
if (!columns[k]) { columns[k] = []; columns[k].__nonNumeric = 0; columns[k].__present = 0 }
const col = columns[k]
const missing = isMissingNumericToken(v)
if (!missing) {
  col.__present += 1
  // Count tokens that are present but not parseable as a finite number.
  if (!Number.isFinite(Number(v))) col.__nonNumeric += 1
}
// Keep the raw string untouched; NA-token blanking is deferred to complete()
// so categorical columns keep values like 'none' / 'NA' verbatim.
col.push(v)
}
rowCount++
if (rowCount % 2000 === 0) {
const cursor = typeof res.meta?.cursor === 'number' ? res.meta.cursor : 0
const pct = Math.max(0, Math.min(99, Math.round((cursor / totalBytes) * 100)))
postMessage({ type: 'progress', progress: pct, rows: rowCount } as any)
}
},
complete: () => {
const numericColumns: string[] = []
const categoricalColumns: string[] = []
const out: Record<string, any> = {}
for (const [k, arr] of Object.entries(columns)) {
const present = (arr as any).__present || 0
const nonNumeric = (arr as any).__nonNumeric || 0
// Categorical only if a meaningful fraction of *present* values aren't numbers.
// A few stray non-numeric tokens (NaN/inf/typos) keep the column numeric, with
// those cells materialized as NaN rather than flipping the whole column.
const isCategorical = present > 0 && nonNumeric > Math.max(1, present * 0.1)
// A column with no present (non-missing) values has no numeric data either;
// keep it categorical rather than materializing an all-NaN Float32Array.
if (isCategorical || present === 0) {
  categoricalColumns.push(k)
  out[k] = (arr as string[]).map(v => (v == null ? '' : String(v)))
} else {
  numericColumns.push(k)
  // NA tokens / missing become NaN (missing), never 0.
  // Note: Float32 storage loses precision beyond ~7 significant digits.
  out[k] = Float32Array.from((arr as string[]).map(v => (v == null || isMissingNumericToken(v) ? NaN : Number(v))))
}
}
const warnings: string[] = []
if (idCollisions > 0) {
  warnings.push(`${idCollisions.toLocaleString()} molecule ID collision(s) after path/extension stripping; duplicates were suffixed (_2, _3, …).`)
}
const msg: ParsedMsg = { type: 'parsed', ids, columns: out, meta: { numericColumns, categoricalColumns }, warnings: warnings.length ? warnings : undefined }
postMessage({ type: 'progress', progress: 100, rows: rowCount } as any)
// Transfer numeric buffers instead of structured-cloning them.
;(self as any).postMessage(msg, Object.values(out).filter(v => ArrayBuffer.isView(v)).map((v: any) => v.buffer))
}
})
}
