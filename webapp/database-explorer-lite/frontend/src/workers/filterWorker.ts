/// <reference lib="webworker" />
import * as OCL from 'openchemlib'

type RangeFilter = { kind: 'range'; min: number; max: number }
type ContainsFilter = { kind: 'contains'; query: string; caseSensitive?: boolean }
type BooleanFilter = { kind: 'boolean'; value: boolean }
type SmartsFilter = { kind: 'smarts'; smilesColumn: string; query: string }
type SimilarityFilter = { kind: 'similarity'; smilesColumn: string; referenceSmiles: string; threshold: number }
type FilterSpec = RangeFilter | ContainsFilter | BooleanFilter | SmartsFilter | SimilarityFilter
type Filters = Record<string, FilterSpec>

type DatasetPayload = {
  ids: string[]
  columns: Record<string, Float32Array | Int32Array | string[]>
}

type FilterWorkerRequest =
  | { type: 'init'; version: number; dataset: DatasetPayload }
  | { type: 'run'; version: number; jobId: number; filters: Filters }

type FilterWorkerProgress = { type: 'progress'; version: number; jobId: number; scanned: number; total: number }
type FilterWorkerResult = { type: 'result'; version: number; jobId: number; visibleIndices: Uint32Array | null; count: number }
type FilterWorkerError = { type: 'error'; version: number; jobId: number; message: string }
type FilterWorkerSuperseded = { type: 'superseded'; version: number; jobId: number }
type FilterWorkerResponse = FilterWorkerProgress | FilterWorkerResult | FilterWorkerError | FilterWorkerSuperseded

type CachedRow = { mol: OCL.Molecule | null; index: number[] | null }

let dataset: DatasetPayload | null = null
let datasetVersion = -1
let activeJobId = 0
let smartsParser: OCL.SmilesParser | null = null
const similarityIndexer = new OCL.SSSearcherWithIndex()
const structureCache = new Map<string, Map<number, CachedRow>>()

function getSmartsParser(): OCL.SmilesParser {
  if (!smartsParser) smartsParser = new OCL.SmilesParser({ smartsMode: 'smarts' })
  return smartsParser
}

function sameColumnContent(a: any, b: any): boolean {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function resetForDataset(version: number, next: DatasetPayload) {
  const prev = dataset
  datasetVersion = version
  dataset = next
  // Only drop parsed-molecule caches for SMILES columns whose content actually
  // changed; an O(n) string compare is far cheaper than re-parsing molecules.
  for (const colName of Array.from(structureCache.keys())) {
    if (!sameColumnContent(prev?.columns[colName], next.columns[colName])) {
      structureCache.delete(colName)
    }
  }
  smartsParser = null
}

function normalizeBooleanValue(value: any): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true') return true
    if (text === 'false') return false
  }
  return null
}

function matchesFilter(value: any, filter: FilterSpec): boolean {
  if (filter.kind === 'smarts' || filter.kind === 'similarity') return true
  if (filter.kind === 'boolean') {
    return normalizeBooleanValue(value) === filter.value
  }
  if (filter.kind === 'contains') {
    const query = filter.query.trim()
    if (!query) return true
    const text = value == null ? '' : String(value)
    return filter.caseSensitive ? text.includes(query) : text.toLowerCase().includes(query.toLowerCase())
  }
  if (!Number.isFinite(value)) return false
  return value >= filter.min && value <= filter.max
}

function getStructureRowCached(ds: DatasetPayload, smilesColumn: string, row: number): CachedRow {
  let colCache = structureCache.get(smilesColumn)
  if (!colCache) {
    colCache = new Map()
    structureCache.set(smilesColumn, colCache)
  }
  const hit = colCache.get(row)
  if (hit) return hit

  const col = ds.columns[smilesColumn] as any
  const raw = col?.[row]
  let out: CachedRow = { mol: null, index: null }
  if (typeof raw === 'string') {
    const txt = raw.trim()
    if (txt && txt.toLowerCase() !== 'nan') {
      try {
        const mol = OCL.Molecule.fromSmiles(txt)
        out = { mol, index: similarityIndexer.createIndex(mol) }
      } catch {
        out = { mol: null, index: null }
      }
    }
  }

  colCache.set(row, out)
  return out
}

function makeStructurePredicate(ds: DatasetPayload, filter: FilterSpec): ((row: number) => boolean) | null {
  if (filter.kind === 'smarts') {
    const smilesColumn = filter.smilesColumn
    const query = filter.query.trim()
    if (!smilesColumn || !query || !ds.columns[smilesColumn]) return null
    let fragment: OCL.Molecule
    try {
      fragment = getSmartsParser().parseMolecule(query)
      fragment.setFragment(true)
    } catch {
      return null
    }
    const searcher = new OCL.SSSearcherWithIndex()
    const fragmentIndex = similarityIndexer.createIndex(fragment)
    searcher.setFragment(fragment, fragmentIndex)
    return (row) => {
      const rowMol = getStructureRowCached(ds, smilesColumn, row)
      if (!rowMol.mol || !rowMol.index) return false
      searcher.setMolecule(rowMol.mol, rowMol.index)
      return searcher.isFragmentInMolecule()
    }
  }

  if (filter.kind === 'similarity') {
    const smilesColumn = filter.smilesColumn
    const referenceSmiles = filter.referenceSmiles.trim()
    const threshold = filter.threshold
    if (!smilesColumn || !referenceSmiles || !ds.columns[smilesColumn]) return null
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return null

    let refIndex: number[]
    try {
      const refMol = OCL.Molecule.fromSmiles(referenceSmiles)
      refIndex = similarityIndexer.createIndex(refMol)
    } catch {
      return null
    }

    return (row) => {
      const rowMol = getStructureRowCached(ds, smilesColumn, row)
      if (!rowMol.index) return false
      return OCL.SSSearcherWithIndex.getSimilarityTanimoto(refIndex, rowMol.index) >= threshold
    }
  }

  return null
}

function computeFilterResult(ds: DatasetPayload, version: number, jobId: number, filters: Filters) {
  const cols = Object.keys(filters)
  const n = ds.ids.length
  if (cols.length === 0) {
    const resp: FilterWorkerResult = { type: 'result', version, jobId, visibleIndices: null, count: n }
    ;(self as any).postMessage(resp)
    return
  }

  const columns = ds.columns as Record<string, any>
  const structurePredicates = new Map<string, (row: number) => boolean>()
  for (const c of cols) {
    const f = filters[c]
    if (f.kind === 'smarts' || f.kind === 'similarity') {
      const pred = makeStructurePredicate(ds, f)
      if (pred) structurePredicates.set(c, pred)
    }
  }

  const out = new Uint32Array(n)
  let outCount = 0
  const chunkSize = 10000

  const step = (i0: number) => {
    if (jobId !== activeJobId || version !== datasetVersion || dataset !== ds) {
      // Tell the main thread this job was aborted so its listener detaches.
      const resp: FilterWorkerSuperseded = { type: 'superseded', version, jobId }
      ;(self as any).postMessage(resp)
      return
    }
    const end = Math.min(n, i0 + chunkSize)

    outer: for (let i = i0; i < end; i++) {
      for (const c of cols) {
        const f = filters[c]
        if (f.kind === 'smarts' || f.kind === 'similarity') {
          const pred = structurePredicates.get(c)
          if (!pred) continue
          if (!pred(i)) continue outer
          continue
        }
        const arr = columns[c]
        if (!arr) continue
        if (!matchesFilter(arr[i], f)) continue outer
      }
      out[outCount++] = i
    }

    const progress: FilterWorkerProgress = { type: 'progress', version, jobId, scanned: end, total: n }
    ;(self as any).postMessage(progress)

    if (end < n) {
      setTimeout(() => step(end), 0)
      return
    }

    const vis = outCount === n ? null : out.slice(0, outCount)
    const resp: FilterWorkerResult = { type: 'result', version, jobId, visibleIndices: vis, count: outCount }
    if (vis) {
      ;(self as any).postMessage(resp, [vis.buffer])
    } else {
      ;(self as any).postMessage(resp)
    }
  }

  step(0)
}

self.onmessage = (e: MessageEvent<FilterWorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'init') {
    resetForDataset(msg.version, msg.dataset)
    return
  }

  if (msg.type === 'run') {
    if (!dataset || msg.version !== datasetVersion) {
      const err: FilterWorkerError = { type: 'error', version: msg.version, jobId: msg.jobId, message: 'Dataset not initialized for filter run.' }
      ;(self as any).postMessage(err)
      return
    }
    activeJobId = msg.jobId
    try {
      computeFilterResult(dataset, msg.version, msg.jobId, msg.filters)
    } catch (error: any) {
      const err: FilterWorkerError = {
        type: 'error',
        version: msg.version,
        jobId: msg.jobId,
        message: error?.message || String(error)
      }
      ;(self as any).postMessage(err)
    }
  }
}
