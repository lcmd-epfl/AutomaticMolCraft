/// <reference lib="webworker" />
import Papa from 'papaparse'
import type { ParseCSVMsg, ParsedMsg } from './types'


self.onmessage = (e: MessageEvent<ParseCSVMsg>) => {
if (e.data.type !== 'parse') return
const file = e.data.file
const totalBytes = file.size || 1
const ids: string[] = []
const columns: Record<string, any> = {}
let headers: string[] = []
let rowCount = 0


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
const id = rawId.split(/[\\/]/).pop()?.trim().replace(/\.xyz$/i, '') || rawId
ids.push(id)
for (let i = 1; i < headers.length; i++) {
const k = headers[i]
const v = row[k]
const num = v === '' ? NaN : Number(v)
if (!columns[k]) columns[k] = []
// If first non-empty is non-numeric, treat column as categorical
if (Number.isNaN(num) && v !== '') columns[k].__cat = true
columns[k].push(Number.isNaN(num) ? v : num)
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
if ((arr as any).__cat) { categoricalColumns.push(k); out[k] = arr.map(String) }
else { numericColumns.push(k); out[k] = Float32Array.from(arr.map(Number)) }
}
const msg: ParsedMsg = { type: 'parsed', ids, columns: out, meta: { numericColumns, categoricalColumns } }
postMessage({ type: 'progress', progress: 100, rows: rowCount } as any)
postMessage(msg)
}
})
}
