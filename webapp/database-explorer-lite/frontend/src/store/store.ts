// store.ts
import { create } from 'zustand'
import * as OCL from 'openchemlib'
import type { Dataset, PlotSpec, DescriptorRecord } from '../models/dataModel'
import { perfMarkEnd, perfMarkStart } from '../utils/perfMetrics'

type RangeFilter = { kind: 'range'; min: number; max: number }
type ContainsFilter = { kind: 'contains'; query: string; caseSensitive?: boolean }
type BooleanFilter = { kind: 'boolean'; value: boolean }
type SmartsFilter = { kind: 'smarts'; smilesColumn: string; query: string }
type SimilarityFilter = { kind: 'similarity'; smilesColumn: string; referenceSmiles: string; threshold: number }
type FilterSpec = RangeFilter | ContainsFilter | BooleanFilter | SmartsFilter | SimilarityFilter
type FilterInput = FilterSpec | { min: number; max: number } | { query: string; caseSensitive?: boolean }
type Filters = Record<string, FilterSpec>
export const STRUCTURE_FILTER_KEY = '__structure_filter__'

type Source =
  | { mode: 'folder'; files: Map<string, File> }
  | { mode: 'base'; baseUrl: string }
  | { mode: 'mixed'; xyzById: Record<string, string> }

type RegisterOptimizedGeometryOptions = {
  datasetOrigin: string
  idPrefix: string
  dataSourceLabel: string
  replaceXyzById: Record<string, string>
  baseXyzById?: Record<string, string>
}

// ---- selection debouncer (critical for INP) ----
let selRaf: number | null = null
let pendingSel: Int32Array | null = null

function makeVectorLabelColumn(ids: string[], valuesById: Record<string, number[]>, dim?: number | null): string[] {
  const fallbackDim = dim || Object.values(valuesById).find(Array.isArray)?.length || 0
  const label = fallbackDim > 0 ? `vec[${fallbackDim}]` : 'vec'
  return ids.map(id => (Array.isArray(valuesById[id]) ? label : ''))
}

function makeAllVisibleMask(n: number): Uint8Array | null {
  return null
}

function makeVisibleMask(n: number, indices: Uint32Array | null): Uint8Array | null {
  if (!indices) return null
  const mask = new Uint8Array(n)
  for (let i = 0; i < indices.length; i++) {
    mask[indices[i]] = 1
  }
  return mask
}

function normalizeFilter(filter: FilterInput): FilterSpec {
  if ((filter as any).kind === 'boolean') {
    const f = filter as BooleanFilter
    return { kind: 'boolean', value: !!f.value }
  }
  if ((filter as any).kind === 'smarts') {
    const f = filter as SmartsFilter
    return {
      kind: 'smarts',
      smilesColumn: String(f.smilesColumn ?? ''),
      query: String(f.query ?? '')
    }
  }
  if ((filter as any).kind === 'similarity') {
    const f = filter as SimilarityFilter
    return {
      kind: 'similarity',
      smilesColumn: String(f.smilesColumn ?? ''),
      referenceSmiles: String(f.referenceSmiles ?? ''),
      threshold: Number(f.threshold)
    }
  }
  if ((filter as any).kind === 'contains') {
    const f = filter as ContainsFilter
    return { kind: 'contains', query: String(f.query ?? ''), caseSensitive: !!f.caseSensitive }
  }
  if ((filter as any).kind === 'range' || 'min' in filter || 'max' in filter) {
    const f = filter as any
    return { kind: 'range', min: Number(f.min), max: Number(f.max) }
  }
  const f = filter as any
  return { kind: 'contains', query: String(f.query ?? ''), caseSensitive: !!f.caseSensitive }
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
    return filter.caseSensitive
      ? text.includes(query)
      : text.toLowerCase().includes(query.toLowerCase())
  }

  if (!Number.isFinite(value)) return false
  return value >= filter.min && value <= filter.max
}

type CachedRow = { mol: OCL.Molecule | null; index: number[] | null }
type StructureColumnCache = { byRow: Map<number, CachedRow> }
const STRUCTURE_CACHE: WeakMap<Dataset, Map<string, StructureColumnCache>> = new WeakMap()
let lastDatasetRef: Dataset | null = null
let smartsParser: OCL.SmilesParser | null = null
const similarityIndexer = new OCL.SSSearcherWithIndex()

function getStructureColumnCache(dataset: Dataset, smilesColumn: string): StructureColumnCache {
  let dsCache = STRUCTURE_CACHE.get(dataset)
  if (!dsCache) {
    dsCache = new Map()
    STRUCTURE_CACHE.set(dataset, dsCache)
  }
  let colCache = dsCache.get(smilesColumn)
  if (!colCache) {
    colCache = { byRow: new Map() }
    dsCache.set(smilesColumn, colCache)
  }
  return colCache
}

function parseSmilesRowCached(dataset: Dataset, smilesColumn: string, row: number): CachedRow {
  const cache = getStructureColumnCache(dataset, smilesColumn)
  const hit = cache.byRow.get(row)
  if (hit) return hit

  const col = dataset.columns[smilesColumn] as any
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

  cache.byRow.set(row, out)
  return out
}

function getSmartsParser(): OCL.SmilesParser {
  if (!smartsParser) smartsParser = new OCL.SmilesParser({ smartsMode: 'smarts' })
  return smartsParser
}

function makeStructurePredicate(dataset: Dataset, filter: FilterSpec): ((row: number) => boolean) | null {
  if (filter.kind === 'smarts') {
    const smilesColumn = filter.smilesColumn
    const query = filter.query.trim()
    if (!smilesColumn || !query || !dataset.columns[smilesColumn]) return null
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
      const rowMol = parseSmilesRowCached(dataset, smilesColumn, row)
      if (!rowMol.mol || !rowMol.index) return false
      searcher.setMolecule(rowMol.mol, rowMol.index)
      return searcher.isFragmentInMolecule()
    }
  }

  if (filter.kind === 'similarity') {
    const smilesColumn = filter.smilesColumn
    const referenceSmiles = filter.referenceSmiles.trim()
    const threshold = filter.threshold
    if (!smilesColumn || !referenceSmiles || !dataset.columns[smilesColumn]) return null
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return null
    let refIndex: number[]
    try {
      const refMol = OCL.Molecule.fromSmiles(referenceSmiles)
      refIndex = similarityIndexer.createIndex(refMol)
    } catch {
      return null
    }
    return (row) => {
      const rowMol = parseSmilesRowCached(dataset, smilesColumn, row)
      if (!rowMol.index) return false
      return OCL.SSSearcherWithIndex.getSimilarityTanimoto(refIndex, rowMol.index) >= threshold
    }
  }

  return null
}

function computeVisibleIndices(
  dataset: Dataset,
  filters: Filters
): { vis: Uint32Array | null; mask: Uint8Array | null; count: number } {
  const cols = Object.keys(filters)
  const n = dataset.ids.length
  if (cols.length === 0) {
    return { vis: null, mask: makeAllVisibleMask(n), count: n }
  }

  const columns = dataset.columns as Record<string, any>
  const structurePredicates = new Map<string, (row: number) => boolean>()
  for (const c of cols) {
    const f = filters[c]
    if (f.kind === 'smarts' || f.kind === 'similarity') {
      const pred = makeStructurePredicate(dataset, f)
      if (pred) structurePredicates.set(c, pred)
    }
  }
  const out = new Uint32Array(n)
  let outCount = 0

  outer: for (let i = 0; i < n; i++) {
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
      const v = arr[i]
      if (!matchesFilter(v, f)) continue outer
    }
    out[outCount++] = i
  }

  if (outCount === n) {
    return { vis: null, mask: makeAllVisibleMask(n), count: n }
  }

  const vis = out.slice(0, outCount)
  const mask = makeVisibleMask(n, vis)
  return { vis, mask, count: outCount }
}

let liveFilterTimer: ReturnType<typeof setTimeout> | null = null
let liveFilterRunId = 0
let filterDatasetVersion = 0
let filterWorkerDatasetVersion = -1
let filterWorker: Worker | null = null

type FilterWorkerResponse =
  | { type: 'progress'; version: number; jobId: number; scanned: number; total: number }
  | { type: 'result'; version: number; jobId: number; visibleIndices: Uint32Array | null; count: number }
  | { type: 'error'; version: number; jobId: number; message: string }

function getFilterWorker(): Worker {
  if (filterWorker) return filterWorker
  filterWorker = new Worker(new URL('../workers/filterWorker.ts', import.meta.url), { type: 'module' })
  return filterWorker
}

function ensureFilterWorkerDataset(dataset: Dataset) {
  const worker = getFilterWorker()
  if (filterWorkerDatasetVersion === filterDatasetVersion) return
  worker.postMessage({
    type: 'init',
    version: filterDatasetVersion,
    dataset: {
      ids: dataset.ids,
      columns: dataset.columns
    }
  })
  filterWorkerDatasetVersion = filterDatasetVersion
}

function cancelLiveFilterWork() {
  if (liveFilterTimer != null) {
    clearTimeout(liveFilterTimer)
    liveFilterTimer = null
  }
  liveFilterRunId++
}

function computeVisibleIndicesChunked(
  dataset: Dataset,
  filters: Filters,
  runId: number,
  done: (result: { vis: Uint32Array | null; mask: Uint8Array | null; count: number } | null) => void
) {
  const cols = Object.keys(filters)
  const n = dataset.ids.length
  if (cols.length === 0 || n < 25000) {
    done(runId === liveFilterRunId ? computeVisibleIndices(dataset, filters) : null)
    return
  }

  const columns = dataset.columns as Record<string, any>
  const structurePredicates = new Map<string, (row: number) => boolean>()
  for (const c of cols) {
    const f = filters[c]
    if (f.kind === 'smarts' || f.kind === 'similarity') {
      const pred = makeStructurePredicate(dataset, f)
      if (pred) structurePredicates.set(c, pred)
    }
  }
  const out = new Uint32Array(n)
  let outCount = 0
  let i = 0
  const chunkSize = 12000

  const step = () => {
    if (runId !== liveFilterRunId) {
      done(null)
      return
    }

    const end = Math.min(n, i + chunkSize)
    outer: for (; i < end; i++) {
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
        const v = arr[i]
        if (!matchesFilter(v, f)) continue outer
      }
      out[outCount++] = i
    }

    if (i < n) {
      setTimeout(step, 0)
      return
    }

    if (outCount === n) {
      done({ vis: null, mask: makeAllVisibleMask(n), count: n })
      return
    }

    const vis = out.slice(0, outCount)
    done({ vis, mask: makeVisibleMask(n, vis), count: outCount })
  }

  step()
}

function applyFiltersSnapshot(
  get: () => StoreState,
  set: (partial: Partial<StoreState>) => void,
  options: { clearSelection: boolean }
) {
  const { fullDataset, pendingFilters } = get()
  if (!fullDataset) return
  perfMarkStart('filter_apply')

  const cols = Object.keys(pendingFilters)

  if (cols.length === 0) {
    set({
      dataset: fullDataset,
      activeFilters: {},
      pendingFilters: {},
      visibleIndices: null,
      visibleMask: null,
      visibleCount: fullDataset.ids.length,
      ...(options.clearSelection
        ? {
            selectedIndices: new Int32Array(0),
            pickedIndices: new Int32Array(0),
            displayedPickedIndices: new Int32Array(0)
          }
        : {})
    })
    perfMarkEnd('filter_apply', 'filter_apply_ms')
    return
  }

  const { vis, mask, count } = computeVisibleIndices(fullDataset, pendingFilters)

  set({
    dataset: fullDataset,
    activeFilters: { ...pendingFilters },
    visibleIndices: vis,
    visibleMask: mask,
    visibleCount: count,
    ...(options.clearSelection
      ? {
          selectedIndices: new Int32Array(0),
          pickedIndices: new Int32Array(0),
          displayedPickedIndices: new Int32Array(0)
        }
      : {})
  })
  perfMarkEnd('filter_apply', 'filter_apply_ms')
}

function scheduleLiveFilterApply(get: () => StoreState, set: (partial: Partial<StoreState>) => void) {
  if (liveFilterTimer != null) clearTimeout(liveFilterTimer)
  liveFilterRunId++
  liveFilterTimer = setTimeout(() => {
    liveFilterTimer = null
    const { fullDataset, pendingFilters } = get()
    if (!fullDataset) return

    const runId = liveFilterRunId
    const filters = { ...pendingFilters }
    perfMarkStart('filter_apply')
    ensureFilterWorkerDataset(fullDataset)
    const worker = getFilterWorker()

    const onMessage = (ev: MessageEvent<FilterWorkerResponse>) => {
      const msg = ev.data
      if (msg.jobId !== runId || msg.version !== filterDatasetVersion || runId !== liveFilterRunId) return
      if (msg.type === 'result') {
        worker.removeEventListener('message', onMessage as EventListener)
        set({
          dataset: fullDataset,
          activeFilters: { ...filters },
          visibleIndices: msg.visibleIndices,
          visibleMask: makeVisibleMask(fullDataset.ids.length, msg.visibleIndices),
          visibleCount: msg.count
        })
        perfMarkEnd('filter_apply', 'filter_apply_ms')
      } else if (msg.type === 'error') {
        worker.removeEventListener('message', onMessage as EventListener)
        perfMarkEnd('filter_apply', 'filter_apply_ms')
      }
    }

    worker.addEventListener('message', onMessage as EventListener)
    worker.postMessage({
      type: 'run',
      version: filterDatasetVersion,
      jobId: runId,
      filters
    })
  }, 50)
}

interface StoreState {
  fullDataset: Dataset | null
  dataset: Dataset | null
  source: Source | null

  parsing: boolean
  progress: number

  plots: PlotSpec[]

  // null = all rows visible
  visibleIndices: Uint32Array | null
  visibleMask: Uint8Array | null
  visibleCount: number

  selectedIndices: Int32Array
  pickedIndices: Int32Array
  displayedPickedIndices: Int32Array
  activeViewerPane: number

  activeFilters: Filters
  pendingFilters: Filters

  setDataset: (d: Dataset | null) => void
  setSource: (s: Source | null) => void
  setParsing: (b: boolean) => void
  setProgress: (p: number) => void
  resetWorkspace: () => void

  addPlot: (p: PlotSpec) => void
  updatePlot: (p: Partial<PlotSpec> & { id: string }) => void
  removePlot: (id: string) => void

  setSelected: (sel: Int32Array) => void
  togglePicked: (idx: number) => void
  setPickedIndices: (indices: Int32Array) => void
  clearPicked: () => void
  setDisplayedPickedIndices: (indices: Int32Array) => void
  setActiveViewerPane: (n: number) => void
  replaceMoleculeInDisplay: (slot: number, newIdx: number) => void

  setPendingFilter: (col: string, range: FilterInput) => void
  removePendingFilter: (col: string) => void
  applyPendingFilters: () => void
  clearFilters: () => void
  removeFilter: (col: string) => void

  applyFiltersToDataset: () => void
  resetToFullDataset: () => void

  /**
   * Permanently remove columns from the in-memory dataset.
   * Updates dataset.meta, dataset.columnOrder, dataset.stats, removes plots/filters
   * that reference removed columns, and recomputes visibility.
   */
  removeColumns: (cols: string[]) => void
  addColumns: (cols: { name: string; kind?: string; ids?: string[]; values: Array<number | string | null> }[]) => void
  renameColumn: (oldName: string, newName: string) => { ok: boolean; error?: string }
  renameDataSource: (oldName: string, newName: string) => { ok: boolean; error?: string }
  registerOptimizedGeometrySet: (options: RegisterOptimizedGeometryOptions) => { ok: boolean; error?: string; rowCount?: number }
  addDescriptor: (descriptor: {
    name: string
    valuesById: Record<string, number[]>
    dtype?: 'float32'
    source?: { kind: 'tool' | 'file'; label?: string }
  }) => { warning?: string }  
  addMolecularVector: (descriptor: any) => { name: string; warning?: string }
  addAtomProperty: (descriptor: any) => { name: string; warning?: string }
}


function ensureDataSourceColumn(d: Dataset | null, defaultLabel = 'dataset_1'): Dataset | null {
  if (!d) return null

  const n = d.ids.length
  const label = String(defaultLabel || '').trim() || 'dataset_1'

  const existingSourceColumn = d.columns.data_source || d.columns.data_souce
  const existingDataSource = existingSourceColumn
    ? Array.from(existingSourceColumn as any).map(v => {
        const s = String(v ?? '').trim()
        return s || label
      })
    : Array(n).fill(label)

  const nextColumns: Dataset['columns'] = {
    ...d.columns,
    data_source: existingDataSource,
  }

  const nextNumeric = (d.meta.numericColumns || []).filter(c => c !== 'data_source')
  const nextVector = (d.meta.vectorColumns || []).filter(c => c !== 'data_source')
  const nextCategorical = Array.from(
    new Set([...(d.meta.categoricalColumns || []).filter(c => c !== 'data_source'), 'data_source'])
  )

  const vectorRecords: Array<{ name: string; valuesById: Record<string, number[]>; dim?: number | null }> = [
    ...Object.values(d.descriptors || {}),
    ...Object.values((d as any).molecularVectors || {}),
    ...Object.values((d as any).atomProperties || {}),
  ] as any
  for (const record of vectorRecords) {
    const name = String(record.name || '').trim()
    if (!name) continue
    nextColumns[name] = makeVectorLabelColumn(d.ids, record.valuesById || {}, record.dim)
    if (!nextVector.includes(name)) nextVector.push(name)
    const numericIdx = nextNumeric.indexOf(name)
    if (numericIdx >= 0) nextNumeric.splice(numericIdx, 1)
    const categoricalIdx = nextCategorical.indexOf(name)
    if (categoricalIdx >= 0) nextCategorical.splice(categoricalIdx, 1)
  }

  const baseOrder = d.columnOrder && d.columnOrder.length ? d.columnOrder : Object.keys(d.columns)
  const nextOrder = Array.from(new Set(['data_source', ...baseOrder.filter(c => c !== 'data_source'), ...nextVector]))

  return {
    ...d,
    columns: nextColumns,
    meta: {
      ...d.meta,
      numericColumns: nextNumeric,
      categoricalColumns: nextCategorical,
      vectorColumns: nextVector,
    },
    columnOrder: nextOrder,
  }
}

function cloneColumnValue(value: any) {
  if (value == null) return value
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
  return value
}

function rebuildNumericRanges(dataset: Dataset): Dataset['stats'] {
  const numericRanges: Record<string, { min: number; max: number }> = {}
  for (const name of dataset.meta.numericColumns || []) {
    const values = dataset.columns[name]
    if (!values) continue
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < values.length; i++) {
      const raw = (values as any)[i]
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) continue
      if (n < min) min = n
      if (n > max) max = n
    }
    if (Number.isFinite(min) && Number.isFinite(max)) numericRanges[name] = { min, max }
  }
  return { ...(dataset.stats || {}), numericRanges }
}

function remapVectorRecords<T extends { valuesById: Record<string, number[]>; missingIds: string[] }>(
  records: Record<string, T> | undefined,
  idPairs: Array<{ from: string; to: string }>,
  nextIds: string[]
): Record<string, T> | undefined {
  if (!records) return records
  const out: Record<string, T> = {}
  for (const [name, record] of Object.entries(records)) {
    const nextValues: Record<string, number[]> = {}
    for (const pair of idPairs) {
      const value = record.valuesById?.[pair.from]
      if (Array.isArray(value)) nextValues[pair.to] = [...value]
    }
    out[name] = {
      ...record,
      valuesById: nextValues,
      missingIds: nextIds.filter(id => !Array.isArray(nextValues[id])),
    }
  }
  return out
}

function subsetVectorRecords<T extends { valuesById: Record<string, number[]>; missingIds: string[] }>(
  records: Record<string, T> | undefined,
  ids: string[]
): Record<string, T> | undefined {
  if (!records) return records
  const out: Record<string, T> = {}
  for (const [name, record] of Object.entries(records)) {
    const nextValues: Record<string, number[]> = {}
    for (const id of ids) {
      const value = record.valuesById?.[id]
      if (Array.isArray(value)) nextValues[id] = [...value]
    }
    out[name] = {
      ...record,
      valuesById: nextValues,
      missingIds: ids.filter(id => !Array.isArray(nextValues[id])),
    }
  }
  return out
}

function subsetColumn(values: Dataset['columns'][string], rows: Uint32Array | number[]): Dataset['columns'][string] {
  if (ArrayBuffer.isView(values)) {
    const Ctor = (values as any).constructor
    const out = new Ctor(rows.length)
    for (let i = 0; i < rows.length; i++) out[i] = (values as any)[rows[i]]
    return out
  }
  const out: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const value = cloneColumnValue((values as any)[rows[i]])
    out.push(value == null ? '' : String(value))
  }
  return out
}

function subsetDatasetRows(base: Dataset, rows: Uint32Array | number[]): Dataset {
  const nextIds: string[] = []
  for (let i = 0; i < rows.length; i++) nextIds.push(String(base.ids[rows[i]]))
  const nextColumns: Dataset['columns'] = {}
  for (const [name, values] of Object.entries(base.columns)) {
    nextColumns[name] = subsetColumn(values, rows)
  }

  const nextDataset: Dataset = {
    ...base,
    ids: nextIds,
    columns: nextColumns,
    descriptors: subsetVectorRecords(base.descriptors, nextIds) as any,
    molecularVectors: subsetVectorRecords(base.molecularVectors, nextIds) as any,
    atomProperties: subsetVectorRecords(base.atomProperties, nextIds) as any,
  }
  nextDataset.stats = rebuildNumericRanges(nextDataset)
  return nextDataset
}

function subsetSourceRows(source: Source | null, ids: string[]): Source | null {
  if (!source || source.mode !== 'mixed') return source
  const nextXyzById: Record<string, string> = {}
  for (const id of ids) {
    const xyz = source.xyzById[id] || source.xyzById[`${id}.xyz`]
    if (xyz) nextXyzById[id] = xyz
  }
  return { mode: 'mixed', xyzById: nextXyzById }
}

function normalizeXyzResultId(id: string) {
  const raw = String(id).trim()
  const base = raw.split(/[\\/]/).pop() || raw
  return base.replace(/\.xyz$/i, '').trim()
}

function buildOptimizedXyzLookup(replacements: Record<string, string>) {
  const out = new Map<string, string>()
  for (const [key, xyz] of Object.entries(replacements || {})) {
    const raw = String(key).trim()
    if (!raw || !xyz) continue
    out.set(raw, xyz)
    out.set(normalizeXyzResultId(raw), xyz)
  }
  return out
}

function optimizedRegisteredId(idPrefix: string, rawId: string) {
  const prefix = String(idPrefix || '').trim()
  const id = String(rawId || '').trim()
  if (!prefix) return id
  const normalizedId = prefix.startsWith('molGen_') && id.startsWith('molGen_')
    ? id.slice('molGen_'.length)
    : id
  const needsSep = /[_-]$/.test(prefix) || !normalizedId ? '' : '_'
  return `${prefix}${needsSep}${normalizedId}`
}

function registerOptimizedGeometryInDataset(
  base: Dataset,
  options: RegisterOptimizedGeometryOptions
): { dataset: Dataset; xyzById: Record<string, string>; rowCount: number } | { error: string } {
  const origin = String(options.datasetOrigin || '').trim()
  const label = String(options.dataSourceLabel || '').trim()
  const prefix = String(options.idPrefix ?? '')
  const replacements = options.replaceXyzById || {}
  const optimizedXyzById = buildOptimizedXyzLookup(replacements)
  const sourceValues = base.columns.data_source
    ? Array.from(base.columns.data_source as any).map(v => String(v ?? '').trim() || 'dataset_1')
    : base.ids.map(() => 'dataset_1')
  // '__all__' means the job ran against all compiled sources; handle in-place replacement across origins
  const allOrigins = origin === '__all__'
  const allOriginsInPlace = allOrigins && prefix === ''
  const replacementMode = !allOrigins && prefix === '' && label === origin

  if (!allOrigins && !origin) return { error: 'Missing original data_source label.' }
  if (!label) return { error: 'Enter a data_source label.' }
  if (optimizedXyzById.size === 0) return { error: 'No optimized molecules found in the job result.' }
  if (!allOrigins && !replacementMode && prefix === '') return { error: 'Append mode requires a non-empty ID prefix.' }

  const existingSources = new Set(sourceValues.filter(Boolean))
  if (!replacementMode && !allOriginsInPlace && existingSources.has(label)) {
    return { error: `A data_source named '${label}' already exists. Choose a different name.` }
  }

  const optimizedRowIndices = base.ids
    .map((id, i) => ({ id: String(id), index: i }))
    .filter(row => (allOrigins || sourceValues[row.index] === origin) && optimizedXyzById.has(normalizeXyzResultId(row.id)))

  if (optimizedRowIndices.length === 0) {
    return { error: 'No optimized molecules from this job match the current dataset rows.' }
  }

  const nextRowRefs: Array<{ sourceIndex: number; fromId: string; toId: string; sourceLabel: string }> = []
  for (let i = 0; i < base.ids.length; i++) {
    const skip = allOriginsInPlace
      ? optimizedXyzById.has(normalizeXyzResultId(String(base.ids[i])))
      : replacementMode && sourceValues[i] === origin
    if (skip) continue
    nextRowRefs.push({
      sourceIndex: i,
      fromId: String(base.ids[i]),
      toId: String(base.ids[i]),
      sourceLabel: sourceValues[i],
    })
  }

  const usedIds = new Set(nextRowRefs.map(row => row.toId))
  for (const row of optimizedRowIndices) {
    const nextId = optimizedRegisteredId(prefix, row.id)
    if (usedIds.has(nextId)) {
      return { error: `Cannot register optimized set because ID '${nextId}' already exists.` }
    }
    usedIds.add(nextId)
    nextRowRefs.push({
      sourceIndex: row.index,
      fromId: row.id,
      toId: nextId,
      sourceLabel: allOriginsInPlace ? sourceValues[row.index] : label,
    })
  }

  const nextIds = nextRowRefs.map(row => row.toId)
  const nextColumns: Dataset['columns'] = {}
  for (const [name, values] of Object.entries(base.columns)) {
    if ((base.meta.numericColumns || []).includes(name)) {
      const arr = new Float32Array(nextRowRefs.length)
      for (let i = 0; i < nextRowRefs.length; i++) {
        const raw = (values as any)[nextRowRefs[i].sourceIndex]
        const n = typeof raw === 'number' ? raw : Number(raw)
        arr[i] = Number.isFinite(n) ? n : NaN
      }
      nextColumns[name] = arr
    } else {
      nextColumns[name] = nextRowRefs.map((row, i) => (
        name === 'data_source'
          ? row.sourceLabel
          : cloneColumnValue((values as any)[nextRowRefs[i].sourceIndex])
      ))
    }
  }
  nextColumns.data_source = nextRowRefs.map(row => row.sourceLabel)

  const nextDataset: Dataset = {
    ...base,
    ids: nextIds,
    columns: nextColumns,
    meta: {
      ...base.meta,
      numericColumns: (base.meta.numericColumns || []).filter(c => c !== 'data_source'),
      categoricalColumns: Array.from(new Set([...(base.meta.categoricalColumns || []).filter(c => c !== 'data_source'), 'data_source'])),
    },
    columnOrder: [
      'data_source',
      ...((base.columnOrder && base.columnOrder.length ? base.columnOrder : Object.keys(base.columns)).filter(c => c !== 'data_source')),
    ],
  }
  nextDataset.stats = rebuildNumericRanges(nextDataset)

  const idPairs = nextRowRefs.map(row => ({ from: row.fromId, to: row.toId }))
  nextDataset.descriptors = remapVectorRecords(base.descriptors, idPairs, nextIds) as any
  nextDataset.molecularVectors = remapVectorRecords(base.molecularVectors, idPairs, nextIds) as any
  nextDataset.atomProperties = remapVectorRecords(base.atomProperties, idPairs, nextIds) as any

  const baseXyz = options.baseXyzById || {}
  const nextXyzById: Record<string, string> = {}
  for (const row of nextRowRefs) {
    const optimized = optimizedXyzById.get(normalizeXyzResultId(row.fromId))
    const xyz = optimized && (allOriginsInPlace || row.sourceLabel === label) ? optimized : baseXyz[row.fromId]
    if (xyz) nextXyzById[row.toId] = xyz
  }

  return { dataset: nextDataset, xyzById: nextXyzById, rowCount: optimizedRowIndices.length }
}

export const useStore = create<StoreState>((set, get) => ({
  dataset: null,
  fullDataset: null,
  source: null,

  parsing: false,
  progress: 0,

  plots: [],

  visibleIndices: null,
  visibleMask: null,
  visibleCount: 0,

  selectedIndices: new Int32Array(0),
  pickedIndices: new Int32Array(0),
  displayedPickedIndices: new Int32Array(0),
  activeViewerPane: 0,

  activeFilters: {},
  pendingFilters: {},

  setDataset: (d) => {
    cancelLiveFilterWork()
    filterDatasetVersion++
    filterWorkerDatasetVersion = -1
    if (lastDatasetRef !== d) {
      smartsParser = null
      lastDatasetRef = d
    }
    const nextDataset = d
      ? ensureDataSourceColumn({
          ...d,
          descriptors: d.descriptors || {},
          molecularVectors: (d as any).molecularVectors || {},
          atomProperties: (d as any).atomProperties || {}
        } as Dataset)
      : null
  
    set({
      dataset: nextDataset,
      fullDataset: nextDataset,   // ⭐ ADD THIS
      visibleIndices: null,
      visibleMask: null,
      visibleCount: nextDataset ? nextDataset.ids.length : 0,
      selectedIndices: new Int32Array(0),
      pickedIndices: new Int32Array(0),
      displayedPickedIndices: new Int32Array(0),
      activeFilters: {},
      pendingFilters: {},
      plots: []
    })
  },

  setSource: (s) => set({ source: s }),
  setParsing: (b) => set({ parsing: b }),
  setProgress: (p) => set({ progress: p }),

  resetWorkspace: () => {
    cancelLiveFilterWork()
    filterDatasetVersion++
    filterWorkerDatasetVersion = -1
    set({
      dataset: null,
      fullDataset: null,
      source: null,
      parsing: false,
      progress: 0,
      plots: [],
      visibleIndices: null,
      visibleMask: null,
      visibleCount: 0,
      selectedIndices: new Int32Array(0),
      pickedIndices: new Int32Array(0),
      displayedPickedIndices: new Int32Array(0),
      activeFilters: {},
      pendingFilters: {},
    })
  },

  addPlot: (p) => set((s) => ({ plots: [...s.plots, p] })),

  // Fix TS build error: never let a generic patch change the discriminant `type`
  updatePlot: (p) =>
    set((s) => ({
      plots: s.plots.map((q) => {
        if (q.id !== p.id) return q
  
        const { type: _ignoredType, ...rest } = p as any
  
        return { ...q, ...rest, type: q.type } as PlotSpec
      })
    })),

  //updatePlot: (p) =>
  //  set((s) => ({
  //    plots: s.plots.map((q) => (q.id === p.id ? { ...q, ...p } : q))
  //  })),

  removePlot: (id) => set((s) => ({ plots: s.plots.filter((p) => p.id !== id) })),

  // 🔥 INP FIX: debounce selection updates
  setSelected: (sel) => {
    pendingSel = sel
    if (selRaf != null) return
    selRaf = requestAnimationFrame(() => {
      selRaf = null
      if (pendingSel) set({ selectedIndices: pendingSel })
      pendingSel = null
    })
  },

  togglePicked: (idx) =>
    set((s) => {
      if (!Number.isInteger(idx) || idx < 0) return {}
      const prev = s.pickedIndices
      let next: Int32Array
      let existedAt = -1
      for (let i = 0; i < prev.length; i++) {
        if (prev[i] === idx) {
          existedAt = i
          break
        }
      }

      if (existedAt >= 0) {
        next = new Int32Array(prev.length - 1)
        for (let i = 0, k = 0; i < prev.length; i++) {
          if (i === existedAt) continue
          next[k++] = prev[i]
        }
      } else {
        next = new Int32Array(prev.length + 1)
        next.set(prev, 0)
        next[prev.length] = idx
      }

      const nextSet = new Set<number>()
      for (let i = 0; i < next.length; i++) nextSet.add(next[i])

      const displayed = s.displayedPickedIndices
      let displayNext: Int32Array
      if (displayed.length === 0) {
        displayNext = new Int32Array(0)
      } else {
        const keep: number[] = []
        for (let i = 0; i < displayed.length; i++) {
          const v = displayed[i]
          if (nextSet.has(v)) keep.push(v)
        }
        displayNext = new Int32Array(keep)
      }

      return {
        pickedIndices: next,
        displayedPickedIndices: displayNext
      }
    }),

  setPickedIndices: (indices) =>
    set((s) => {
      const out: number[] = []
      const seen = new Set<number>()
      for (let i = 0; i < indices.length; i++) {
        const v = indices[i]
        if (!Number.isInteger(v) || v < 0 || seen.has(v)) continue
        seen.add(v)
        out.push(v)
      }
      const nextPicked = new Int32Array(out)
      const pickedSet = new Set<number>(out)

      const displayed = s.displayedPickedIndices
      const nextDisplayed: number[] = []
      for (let i = 0; i < displayed.length; i++) {
        const v = displayed[i]
        if (pickedSet.has(v)) nextDisplayed.push(v)
      }
      return {
        pickedIndices: nextPicked,
        displayedPickedIndices: new Int32Array(nextDisplayed)
      }
    }),

  clearPicked: () => set({ pickedIndices: new Int32Array(0), displayedPickedIndices: new Int32Array(0) }),

  setDisplayedPickedIndices: (indices) =>
    set((s) => {
      const pickedSet = new Set<number>()
      for (let i = 0; i < s.pickedIndices.length; i++) pickedSet.add(s.pickedIndices[i])
      const out: number[] = []
      const seen = new Set<number>()
      for (let i = 0; i < indices.length; i++) {
        const v = indices[i]
        if (pickedSet.has(v) && !seen.has(v)) {
          seen.add(v)
          out.push(v)
        }
      }
      return { displayedPickedIndices: new Int32Array(out) }
    }),

  setActiveViewerPane: (n) => set({ activeViewerPane: n }),

  replaceMoleculeInDisplay: (slot, newIdx) =>
    set((s) => {
      let current: number[]
      if (s.displayedPickedIndices.length > 0) {
        current = Array.from(s.displayedPickedIndices)
      } else if (s.pickedIndices.length > 0) {
        current = Array.from(s.pickedIndices).reverse().slice(0, 9)
      } else {
        return { pickedIndices: new Int32Array([newIdx]), selectedIndices: new Int32Array([newIdx]) }
      }
      const clampedSlot = Math.min(slot, current.length - 1)
      const oldIdx = current[clampedSlot]
      const newDisplay = [...current]
      newDisplay[clampedSlot] = newIdx
      const newPicked = Array.from(s.pickedIndices)
      const pos = newPicked.indexOf(oldIdx)
      if (pos >= 0) newPicked[pos] = newIdx
      else newPicked.push(newIdx)
      return {
        pickedIndices: new Int32Array(newPicked),
        displayedPickedIndices: new Int32Array(newDisplay),
        selectedIndices: new Int32Array([newIdx]),
      }
    }),


  setPendingFilter: (col, range) => {
    set((s) => ({
      pendingFilters: { ...s.pendingFilters, [col]: normalizeFilter(range) }
    }))
    scheduleLiveFilterApply(get, set)
  },

  removePendingFilter: (col) => {
    set((s) => {
      const n = { ...s.pendingFilters }
      delete n[col]
      return { pendingFilters: n }
    })
    scheduleLiveFilterApply(get, set)
  },

    applyPendingFilters: () => {
      set({
        selectedIndices: new Int32Array(0),
        pickedIndices: new Int32Array(0),
        displayedPickedIndices: new Int32Array(0)
      })
      scheduleLiveFilterApply(get, set)
    },


  removeFilter: (col) => {
    cancelLiveFilterWork()
    set((s) => {
      const pf = { ...s.pendingFilters }
      const af = { ...s.activeFilters }
      delete pf[col]
      delete af[col]

      const ds = s.dataset
      if (!ds) {
        return { pendingFilters: pf, activeFilters: af }
      }

      const { vis, mask, count } = computeVisibleIndices(ds, af)

      return {
        pendingFilters: pf,
        activeFilters: af,
        visibleIndices: vis,
        visibleMask: mask,
        visibleCount: count,
        selectedIndices: new Int32Array(0),
        pickedIndices: new Int32Array(0),
        displayedPickedIndices: new Int32Array(0)
      }

    })
  },

    clearFilters: () => {
      const { fullDataset } = get()
      const n = fullDataset ? fullDataset.ids.length : 0
      cancelLiveFilterWork()
    
      set({
        dataset: fullDataset,
        activeFilters: {},
        pendingFilters: {},
        visibleIndices: null,
        visibleMask: null,
        visibleCount: n,
        selectedIndices: new Int32Array(0),
        pickedIndices: new Int32Array(0),
        displayedPickedIndices: new Int32Array(0)
      })
    },


  renameColumn: (oldName, newName) => {
    const ds = get().dataset
    const full = get().fullDataset
    const oldKey = String(oldName || '').trim()
    const nextKey = String(newName || '').trim()

    if (!ds) return { ok: false, error: 'No dataset loaded.' }
    if (!oldKey) return { ok: false, error: 'Choose a column to rename.' }
    if (!nextKey) return { ok: false, error: 'Choose a new column name.' }
    if (oldKey === nextKey) return { ok: false, error: 'The new name is the same as the current name.' }
    if (Object.prototype.hasOwnProperty.call(ds.columns, nextKey)) {
      return { ok: false, error: `A column named '${nextKey}' already exists. Choose a different name.` }
    }

    function renameInDataset(base: Dataset | null): Dataset | null {
      if (!base || !Object.prototype.hasOwnProperty.call(base.columns, oldKey)) return base

      const nextColumns: Dataset['columns'] = {}
      const order = base.columnOrder && base.columnOrder.length ? base.columnOrder : Object.keys(base.columns)

      for (const name of Object.keys(base.columns)) {
        nextColumns[name === oldKey ? nextKey : name] = base.columns[name]
      }

      const nextNumeric = base.meta.numericColumns.map(c => c === oldKey ? nextKey : c)
      const nextCategorical = base.meta.categoricalColumns.map(c => c === oldKey ? nextKey : c)
      const nextVector = (base.meta.vectorColumns || []).map(c => c === oldKey ? nextKey : c)
      const nextOrder = order.map(c => c === oldKey ? nextKey : c)

      const nextRanges = base.stats?.numericRanges
        ? Object.fromEntries(
            Object.entries(base.stats.numericRanges).map(([k, v]) => [k === oldKey ? nextKey : k, v])
          )
        : undefined

      const nextDescriptors = base.descriptors
        ? Object.fromEntries(
            Object.entries(base.descriptors).map(([k, v]) => [
              k === oldKey ? nextKey : k,
              k === oldKey ? { ...v, name: nextKey } : v,
            ])
          )
        : base.descriptors

      const nextMolecularVectors = (base as any).molecularVectors
        ? Object.fromEntries(
            Object.entries((base as any).molecularVectors).map(([k, v]: [string, any]) => [
              k === oldKey ? nextKey : k,
              k === oldKey ? { ...v, name: nextKey } : v,
            ])
          )
        : (base as any).molecularVectors

      const nextAtomProperties = (base as any).atomProperties
        ? Object.fromEntries(
            Object.entries((base as any).atomProperties).map(([k, v]: [string, any]) => [
              k === oldKey ? nextKey : k,
              k === oldKey ? { ...v, name: nextKey } : v,
            ])
          )
        : (base as any).atomProperties

      return {
        ...base,
        columns: nextColumns,
        meta: {
          ...base.meta,
          numericColumns: nextNumeric,
          categoricalColumns: nextCategorical,
          vectorColumns: nextVector,
        },
        columnOrder: nextOrder,
        stats: nextRanges ? { ...(base.stats || {}), numericRanges: nextRanges } : base.stats,
        descriptors: nextDescriptors,
        molecularVectors: nextMolecularVectors,
        atomProperties: nextAtomProperties,
      } as Dataset
    }

    cancelLiveFilterWork()
    filterDatasetVersion++
    filterWorkerDatasetVersion = -1

    const nextDataset = renameInDataset(ds)!
    const nextFullDataset = renameInDataset(full) || nextDataset

    const renameValue = (value: any) => value === oldKey ? nextKey : value
    const nextPlots = get().plots.map(p => {
      const out: any = { ...p }
      for (const key of ['x', 'y', 'z', 'colorBy', 'sizeBy', 'shapeBy']) {
        if (out[key] === oldKey) out[key] = nextKey
      }
      if (out.scatterSettings) {
        out.scatterSettings = { ...out.scatterSettings }
        for (const key of ['colorBy', 'sizeBy', 'shapeBy']) {
          if (out.scatterSettings[key] === oldKey) out.scatterSettings[key] = nextKey
        }
      }
      return out as PlotSpec
    })

    function renameFilters(filters: Filters): Filters {
      const out: Filters = {}
      for (const [key, value] of Object.entries(filters)) {
        const nextName = key === oldKey ? nextKey : key
        const nextValue: any = value && typeof value === 'object' ? { ...(value as any) } : value
        if ((nextValue?.kind === 'smarts' || nextValue?.kind === 'similarity') && nextValue.smilesColumn === oldKey) {
          nextValue.smilesColumn = nextKey
        }
        out[nextName] = nextValue as any
      }
      return out
    }

    const nextActive = renameFilters(get().activeFilters)
    const nextPending = renameFilters(get().pendingFilters)
    const { vis, mask, count } = computeVisibleIndices(nextDataset, nextActive)

    set({
      dataset: nextDataset,
      fullDataset: nextFullDataset,
      plots: nextPlots,
      activeFilters: nextActive,
      pendingFilters: nextPending,
      visibleIndices: vis,
      visibleMask: mask,
      visibleCount: count,
      selectedIndices: new Int32Array(0),
      pickedIndices: new Int32Array(0),
      displayedPickedIndices: new Int32Array(0),
    })

    return { ok: true }
  },

  renameDataSource: (oldName, newName) => {
    const ds = get().dataset
    const full = get().fullDataset
    const oldKey = String(oldName || '').trim()
    const nextKey = String(newName || '').trim()

    if (!ds) return { ok: false, error: 'No dataset loaded.' }
    if (!oldKey) return { ok: false, error: 'Choose a data source to rename.' }
    if (!nextKey) return { ok: false, error: 'Choose a new data source name.' }
    if (oldKey === nextKey) return { ok: false, error: 'The new name is the same as the current name.' }

    const existing = new Set(Array.from((ds.columns.data_source || []) as any).map(v => String(v ?? '').trim()).filter(Boolean))
    if (existing.has(nextKey)) {
      return { ok: false, error: `A data_source named '${nextKey}' already exists. Choose a different name.` }
    }

    function renameSourceInDataset(base: Dataset | null): Dataset | null {
      if (!base) return base
      const sourceValues = base.columns.data_source
        ? Array.from(base.columns.data_source as any).map(v => {
            const s = String(v ?? '').trim() || 'dataset_1'
            return s === oldKey ? nextKey : s
          })
        : base.ids.map(() => 'dataset_1')

      return {
        ...base,
        columns: {
          ...base.columns,
          data_source: sourceValues,
        },
        meta: {
          ...base.meta,
          numericColumns: (base.meta.numericColumns || []).filter(c => c !== 'data_source'),
          categoricalColumns: Array.from(new Set([...(base.meta.categoricalColumns || []).filter(c => c !== 'data_source'), 'data_source'])),
        },
        columnOrder: [
          'data_source',
          ...((base.columnOrder && base.columnOrder.length ? base.columnOrder : Object.keys(base.columns)).filter(c => c !== 'data_source')),
        ],
      }
    }

    cancelLiveFilterWork()
    filterDatasetVersion++
    filterWorkerDatasetVersion = -1

    const nextDataset = renameSourceInDataset(ds)!
    const nextFullDataset = renameSourceInDataset(full) || nextDataset
    const { vis, mask, count } = computeVisibleIndices(nextDataset, get().activeFilters)

    set({
      dataset: nextDataset,
      fullDataset: nextFullDataset,
      visibleIndices: vis,
      visibleMask: mask,
      visibleCount: count,
    })

    return { ok: true }
  },

  registerOptimizedGeometrySet: (options) => {
    const ds = get().dataset
    if (!ds) return { ok: false, error: 'No dataset loaded.' }

    const result = registerOptimizedGeometryInDataset(ds, options)
    if ('error' in result) return { ok: false, error: result.error }

    cancelLiveFilterWork()
    filterDatasetVersion++
    filterWorkerDatasetVersion = -1

    const { vis, mask, count } = computeVisibleIndices(result.dataset, get().activeFilters)

    set({
      dataset: result.dataset,
      fullDataset: result.dataset,
      source: { mode: 'mixed', xyzById: result.xyzById },
      visibleIndices: vis,
      visibleMask: mask,
      visibleCount: count,
      selectedIndices: new Int32Array(0),
      pickedIndices: new Int32Array(0),
      displayedPickedIndices: new Int32Array(0),
    })

    return { ok: true, rowCount: result.rowCount }
  },

  addColumns: (cols) => {
      const ds = get().dataset
      const full = get().fullDataset
      if (!ds || !cols.length) return
    
      function applyAddColumns(base: Dataset): Dataset {
        const nextColumns: Dataset['columns'] = { ...base.columns }
        const nextNumeric = [...base.meta.numericColumns]
        const nextCategorical = [...base.meta.categoricalColumns]
        const nextVector = [...(base.meta.vectorColumns || [])]
        const nextOrder = base.columnOrder ? [...base.columnOrder] : Object.keys(base.columns)
        const nextRanges = { ...(base.stats?.numericRanges || {}) }
    
        for (const col of cols) {
          const name = String(col.name || '').trim()
          if (!name) continue
          const kind = col.kind === 'vector' ? 'vector' : col.kind === 'categorical' ? 'categorical' : 'numeric'
          const values = Array.isArray(col.values) ? col.values : []
          const hasExplicitIds = Array.isArray(col.ids)
          const explicitIds = hasExplicitIds && col.ids!.length === values.length
            ? col.ids.map(String)
            : null
          const sourceIds = hasExplicitIds ? explicitIds : (
            values.length === base.ids.length
              ? base.ids.map(String)
              : (full && values.length === full.ids.length ? full.ids.map(String) : null)
          )
          if (!sourceIds) continue
          const valueById = new Map<string, number | string | null>()
          sourceIds.forEach((id, index) => valueById.set(id, values[index]))
          const rowValues = base.ids.map(id => valueById.get(String(id)) ?? null)
    
          if (kind === 'vector') {
            nextColumns[name] = rowValues.map(v => (v == null ? '' : String(v)))
            if (!nextVector.includes(name)) nextVector.push(name)
            const numericIdx = nextNumeric.indexOf(name)
            if (numericIdx >= 0) nextNumeric.splice(numericIdx, 1)
            const categoricalIdx = nextCategorical.indexOf(name)
            if (categoricalIdx >= 0) nextCategorical.splice(categoricalIdx, 1)
            delete nextRanges[name]
          } else if (kind === 'categorical') {
            nextColumns[name] = rowValues.map(v => (v == null ? '' : String(v)))
            if (!nextCategorical.includes(name)) nextCategorical.push(name)
            const idx = nextNumeric.indexOf(name)
            if (idx >= 0) nextNumeric.splice(idx, 1)
            const vectorIdx = nextVector.indexOf(name)
            if (vectorIdx >= 0) nextVector.splice(vectorIdx, 1)
            delete nextRanges[name]
          } else {
            const arr = new Float32Array(rowValues.length)
            let min = Infinity
            let max = -Infinity
            for (let i = 0; i < rowValues.length; i++) {
              const raw = rowValues[i]
              const num = typeof raw === 'number' ? raw : Number(raw)
              const out = Number.isFinite(num) ? num : NaN
              arr[i] = out
              if (Number.isFinite(out)) {
                if (out < min) min = out
                if (out > max) max = out
              }
            }
            nextColumns[name] = arr
            if (!nextNumeric.includes(name)) nextNumeric.push(name)
            const idx = nextCategorical.indexOf(name)
            if (idx >= 0) nextCategorical.splice(idx, 1)
            const vectorIdx = nextVector.indexOf(name)
            if (vectorIdx >= 0) nextVector.splice(vectorIdx, 1)
            if (Number.isFinite(min) && Number.isFinite(max)) {
              nextRanges[name] = { min, max }
            }
          }
    
          if (!nextOrder.includes(name)) nextOrder.push(name)
        }
    
        return {
          ...base,
          columns: nextColumns,
          meta: { ...base.meta, numericColumns: nextNumeric, categoricalColumns: nextCategorical, vectorColumns: nextVector },
          columnOrder: nextOrder,
          stats: { ...(base.stats || {}), numericRanges: nextRanges }
        }
      }
    
      const nextDataset = applyAddColumns(ds)
      const nextFullDataset = full ? applyAddColumns(full) : nextDataset
      filterDatasetVersion++
      filterWorkerDatasetVersion = -1
    
      const { vis, mask, count } = computeVisibleIndices(nextDataset, get().activeFilters)
    
      set({
        dataset: nextDataset,
        fullDataset: nextFullDataset,
        visibleIndices: vis,
        visibleMask: mask,
        visibleCount: count
      })
    },

  resetToFullDataset: () => {
    const { fullDataset } = get()
    if (!fullDataset) return
    cancelLiveFilterWork()
  
    set({
      dataset: fullDataset,
      activeFilters: {},
      pendingFilters: {},
      visibleIndices: null,
      visibleMask: null,
      visibleCount: fullDataset.ids.length,
      selectedIndices: new Int32Array(0),
      pickedIndices: new Int32Array(0),
      displayedPickedIndices: new Int32Array(0)
    })
  },


  addMolecularVector: (descriptor: any) => {
    const ds = get().dataset
    if (!ds) return { name: descriptor.name, warning: 'No dataset loaded' }

    const name = descriptor.name
    const valuesById = descriptor.valuesById || {}
    const missingIds = ds.ids.filter(id => !Array.isArray(valuesById[id]))

    const nextDataset: Dataset = {
      ...ds,
      molecularVectors: {
        ...((ds as any).molecularVectors || {}),
        [name]: {
          name,
          valuesById,
          dtype: descriptor.dtype || 'float32',
          missingIds,
          source: descriptor.source,
        },
      } as any,
    } as Dataset

    set({ dataset: nextDataset, fullDataset: nextDataset })
    return missingIds.length
      ? { name, warning: `${missingIds.length.toLocaleString()} molecules are missing molecular vector '${name}'.` }
      : { name }
  },

  addAtomProperty: (descriptor: any) => {
    const ds = get().dataset
    if (!ds) return { name: descriptor.name, warning: 'No dataset loaded' }

    const name = descriptor.name
    const valuesById = descriptor.valuesById || {}
    const missingIds = ds.ids.filter(id => !Array.isArray(valuesById[id]))

    const nextDataset: Dataset = {
      ...ds,
      atomProperties: {
        ...((ds as any).atomProperties || {}),
        [name]: {
          name,
          valuesById,
          dtype: descriptor.dtype || 'float32',
          missingIds,
          source: descriptor.source,
        },
      } as any,
    } as Dataset

    set({ dataset: nextDataset, fullDataset: nextDataset })
    return missingIds.length
      ? { name, warning: `${missingIds.length.toLocaleString()} molecules are missing atom property '${name}'.` }
      : { name }
  },

  addDescriptor: (descriptorInput) => {
    const ds = get().dataset
    const full = get().fullDataset
    if (!ds) {
      throw new Error('No dataset loaded')
    }
  
    const name = descriptorInput.name?.trim()
    if (!name) {
      throw new Error('Descriptor name must be non-empty')
    }
  
    function applyAddDescriptor(base: Dataset): { dataset: Dataset; missingIds: string[] } {
      if (base.columns[name] && !(base.meta.vectorColumns || []).includes(name)) {
        throw new Error(`A column named '${name}' already exists`)
      }
  
      const valuesById = descriptorInput.valuesById || {}
      const presentIds = Object.keys(valuesById)
  
      let dim: number | null = null
      for (const id of presentIds) {
        const vec = valuesById[id]
        if (!Array.isArray(vec) || vec.length === 0) {
          throw new Error(`Descriptor '${name}' has an invalid vector for id '${id}'`)
        }
        for (const x of vec) {
          if (typeof x !== 'number' || !Number.isFinite(x)) {
            throw new Error(`Descriptor '${name}' has a non-numeric value for id '${id}'`)
          }
        }
        if (dim == null) dim = vec.length
        else if (vec.length !== dim) {
          throw new Error(`Descriptor '${name}' has inconsistent vector dimensions`)
        }
      }
  
      if (dim == null) {
        throw new Error(`Descriptor '${name}' contains no valid entries`)
      }
  
      const idSet = new Set(base.ids)
      for (const id of presentIds) {
        if (!idSet.has(id)) {
          throw new Error(`Descriptor '${name}' references unknown dataset id '${id}'`)
        }
      }
  
      const missingIds = base.ids.filter(id => !Object.prototype.hasOwnProperty.call(valuesById, id))
      const presence = makeVectorLabelColumn(base.ids, valuesById, dim)
  
      const nextDescriptors: Record<string, DescriptorRecord> = {
        ...(base.descriptors || {}),
        [name]: {
          name,
          dim,
          dtype: descriptorInput.dtype || 'float32',
          valuesById,
          missingIds,
          source: descriptorInput.source,
        },
      }
  
      const nextColumns: Dataset['columns'] = base.columns[name]
        ? { ...base.columns }
        : { ...base.columns, [name]: presence }
  
      const nextNumeric = (base.meta.numericColumns || []).filter(col => col !== name)
      const nextCategorical = (base.meta.categoricalColumns || []).filter(col => col !== name)
      const nextVector = Array.from(new Set([...(base.meta.vectorColumns || []), name]))
      const nextOrder = base.columnOrder ? [...base.columnOrder, name] : [...Object.keys(nextColumns)]
  
      return {
        dataset: {
          ...base,
          columns: nextColumns,
          descriptors: nextDescriptors,
          meta: {
            ...base.meta,
            numericColumns: nextNumeric,
            categoricalColumns: nextCategorical,
            vectorColumns: nextVector,
          },
          columnOrder: nextOrder,
        },
        missingIds
      }
    }
  
    const outDataset = applyAddDescriptor(ds)
    const outFull = full ? applyAddDescriptor(full) : outDataset
  
    const nextDataset = outDataset.dataset
    const nextFullDataset = outFull.dataset
    filterDatasetVersion++
    filterWorkerDatasetVersion = -1
  
    const { vis, mask, count } = computeVisibleIndices(nextDataset, get().activeFilters)
  
    set({
      dataset: nextDataset,
      fullDataset: nextFullDataset,
      visibleIndices: vis,
      visibleMask: mask,
      visibleCount: count,
      selectedIndices: new Int32Array(0),
      pickedIndices: new Int32Array(0),
      displayedPickedIndices: new Int32Array(0)
    })
  
    return outDataset.missingIds.length > 0
      ? { warning: `Descriptor '${name}' was added, but ${outDataset.missingIds.length} entries are missing values.` }
      : {}
  },

  applyFiltersToDataset: () => {
    const { fullDataset, activeFilters, source, visibleIndices, visibleCount } = get()
    if (!fullDataset) return
    cancelLiveFilterWork()

    const computed = visibleIndices
      ? { vis: visibleIndices, count: visibleIndices.length }
      : Object.keys(activeFilters).length > 0
        ? computeVisibleIndices(fullDataset, activeFilters)
        : { vis: null, count: visibleCount || fullDataset.ids.length }
    const rows = computed.vis ?? Uint32Array.from({ length: fullDataset.ids.length }, (_, i) => i)
    const nextDataset = computed.count === fullDataset.ids.length ? fullDataset : subsetDatasetRows(fullDataset, rows)

    filterDatasetVersion++
    filterWorkerDatasetVersion = -1
  
    set({
      fullDataset: nextDataset,
      dataset: nextDataset,
      source: subsetSourceRows(source, nextDataset.ids),
      visibleIndices: null,
      visibleMask: null,
      visibleCount: nextDataset.ids.length,
      activeFilters: {},
      pendingFilters: {},
      selectedIndices: new Int32Array(0),
      pickedIndices: new Int32Array(0),
      displayedPickedIndices: new Int32Array(0)
    })
  },

  removeColumns: (cols) => {
    const ds = get().dataset
    const full = get().fullDataset
    if (!ds) return
    cancelLiveFilterWork()
  
    const toRemove = new Set(cols.filter(Boolean))
    if (toRemove.size === 0) return
  
    function stripColumns(base: Dataset): Dataset {
      const nextColumns: Dataset['columns'] = {}
      const keptNames: string[] = []
      for (const name of Object.keys(base.columns)) {
        if (toRemove.has(name)) continue
        nextColumns[name] = base.columns[name]
        keptNames.push(name)
      }
  
      const nextNumeric = base.meta.numericColumns.filter(c => !toRemove.has(c))
      const nextCategorical = base.meta.categoricalColumns.filter(c => !toRemove.has(c))
      const nextVector = (base.meta.vectorColumns || []).filter(c => !toRemove.has(c))
      const nextOrder = base.columnOrder ? base.columnOrder.filter(c => !toRemove.has(c)) : keptNames
  
      const nextStats = base.stats?.numericRanges
        ? {
            ...base.stats,
            numericRanges: Object.fromEntries(
              Object.entries(base.stats.numericRanges).filter(([k]) => !toRemove.has(k))
            )
          }
        : base.stats
  
      const nextDescriptors = base.descriptors
        ? Object.fromEntries(
            Object.entries(base.descriptors).filter(([name]) => !toRemove.has(name))
          )
        : base.descriptors
  
      return {
        ...base,
        columns: nextColumns,
        meta: { ...base.meta, numericColumns: nextNumeric, categoricalColumns: nextCategorical, vectorColumns: nextVector },
        columnOrder: nextOrder,
        stats: nextStats,
        descriptors: nextDescriptors
      }
    }
  
    const nextDataset = stripColumns(ds)
    const nextFullDataset = full ? stripColumns(full) : null
    filterDatasetVersion++
    filterWorkerDatasetVersion = -1
  
    const nextPlots = get().plots
      .filter(p => {
        if (p.type === 'hist1d') return !toRemove.has(p.x)
        if (toRemove.has(p.x) || toRemove.has((p as any).y)) return false
        return true
      })
      .map(p => {
        if (p.type === 'hist1d') return p
        const settings = (p as any).scatterSettings
        if (!settings && !p.colorBy && !p.sizeBy) return p
        const nextSettings = settings ? { ...settings } : undefined
        if (nextSettings?.sizeBy && toRemove.has(nextSettings.sizeBy)) delete nextSettings.sizeBy
        if (nextSettings?.colorBy && toRemove.has(nextSettings.colorBy)) delete nextSettings.colorBy
        if (nextSettings?.shapeBy && toRemove.has(nextSettings.shapeBy)) delete nextSettings.shapeBy
        return {
          ...p,
          sizeBy: p.sizeBy && toRemove.has(p.sizeBy) ? undefined : p.sizeBy,
          colorBy: p.colorBy && toRemove.has(p.colorBy) ? undefined : p.colorBy,
          scatterSettings: nextSettings
        }
      })
  
    const af: Filters = { ...get().activeFilters }
    const pf: Filters = { ...get().pendingFilters }
    for (const c of toRemove) {
      delete af[c]
      delete pf[c]
    }
    const structFilter = af[STRUCTURE_FILTER_KEY]
    if ((structFilter?.kind === 'smarts' || structFilter?.kind === 'similarity') && toRemove.has(structFilter.smilesColumn)) {
      delete af[STRUCTURE_FILTER_KEY]
      delete pf[STRUCTURE_FILTER_KEY]
    }
  
    const { vis, mask, count } = computeVisibleIndices(nextDataset, af)
  
    set({
      dataset: nextDataset,
      fullDataset: nextFullDataset,
      plots: nextPlots,
      activeFilters: af,
      pendingFilters: pf,
      visibleIndices: vis,
      visibleMask: mask,
      visibleCount: count,
      selectedIndices: new Int32Array(0),
      pickedIndices: new Int32Array(0),
      displayedPickedIndices: new Int32Array(0)
    })
  },  

}))
