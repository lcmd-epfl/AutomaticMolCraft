import React, { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  CheckCircle2,
  PlusCircle,
  Database,
  FileText,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useStore } from '../store/store'
import DatasetBuilder from './DatasetBuilder'
import GeneratedMoleculesBuilder from './GeneratedMoleculesBuilder'
import DownloadDatasetSection from './DownloadDatasetSection'
import DataTable from './DataTable'
import DatasetFilterPanel from './DatasetFilterPanel'
import { useUIStore } from '../store/uiStore'
import { resolveXyzByIds } from '../utils/xyzLoader'
import type { DatasetSource } from '../utils/xyzLoader'
import {
  compileStagedSources,
  createStagedSource,
  lookupXyz,
  type ColumnConflictPolicy,
  type ComputedColumnDefinition,
  type ComputedOperand,
  type ComputedOperator,
  type DuplicateIdPolicy,
  type StagedSource,
  type StagedSourceKind,
} from '../utils/stagedSources'
import { bumpDataSourceLabel } from '../utils/dataSourceLabel'
import { useSplitPane } from '../utils/useSplitPane'

type SourceColumnEntry = {
  source: string
  column: string
}

type DraftField = {
  original: string
  value: string
}

type ComputedColumnDraft = {
  outputName: string
  leftKind: 'column' | 'constant'
  leftColumn: string
  leftConstant: string
  operator: ComputedOperator
  rightKind: 'column' | 'constant'
  rightColumn: string
  rightConstant: string
}

const DATA_SOURCE_COL = 'data_source'
const SEP = '|||'

function selectionKey(source: string, column: string) {
  return `${source}${SEP}${column}`
}

function parseSelectionKey(key: string): SourceColumnEntry {
  const [source, column] = key.split(SEP)
  return { source, column }
}

function isMissingValue(v: any) {
  if (v === null || v === undefined) return true
  if (typeof v === 'number') return !Number.isFinite(v)
  const s = String(v).trim()
  return s === '' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'null'
}

function isNumericColumn(ds: any, column: string) {
  return ds.meta.numericColumns.includes(column)
}

function hasVectorLabels(ds: any, column: string) {
  const values = ds.columns?.[column] as any
  if (!values || typeof values.length !== 'number') return false
  for (let i = 0; i < values.length; i++) {
    const value = String(values[i] ?? '').trim()
    if (value) return /^vec\[\d+\]$/.test(value) || value === 'vec'
  }
  return false
}

function isVectorColumn(ds: any, column: string) {
  return (
    (ds.meta.vectorColumns || []).includes(column)
    || Boolean(ds.descriptors?.[column])
    || Boolean(ds.molecularVectors?.[column])
    || Boolean(ds.atomProperties?.[column])
    || hasVectorLabels(ds, column)
  )
}

function vectorRecordForColumn(ds: any, column: string) {
  return ds.descriptors?.[column] || ds.molecularVectors?.[column] || ds.atomProperties?.[column] || null
}

function orderedColumns(ds: any): string[] {
  const order = ds.columnOrder && ds.columnOrder.length ? ds.columnOrder : Object.keys(ds.columns)
  const vectorNames = [
    ...(ds.meta.vectorColumns || []),
    ...Object.keys(ds.descriptors || {}),
    ...Object.keys(ds.molecularVectors || {}),
    ...Object.keys(ds.atomProperties || {}),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of [...order, ...vectorNames]) {
    if (!name || name === DATA_SOURCE_COL || seen.has(name)) continue
    if (Object.prototype.hasOwnProperty.call(ds.columns, name) || vectorRecordForColumn(ds, name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

function numericScalarColumns(ds: any): string[] {
  const ordered = orderedColumns(ds)
  const numeric = new Set(ds.meta.numericColumns || [])
  return ordered.filter(column => numeric.has(column) && !isVectorColumn(ds, column))
}

function makeComputedDraftForDataset(dataset: any): ComputedColumnDraft | null {
  const numericColumns = numericScalarColumns(dataset)
  if (numericColumns.length === 0) return null
  return {
    outputName: 'computed_column',
    leftKind: 'column',
    leftColumn: numericColumns[0],
    leftConstant: '',
    operator: '-',
    rightKind: 'column',
    rightColumn: numericColumns[1] || numericColumns[0],
    rightConstant: '',
  }
}

function computedOperandValueForRow(dataset: any, draft: ComputedColumnDraft, side: 'left' | 'right', row: number): number {
  const kind = side === 'left' ? draft.leftKind : draft.rightKind
  if (kind === 'constant') {
    const value = side === 'left' ? draft.leftConstant : draft.rightConstant
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : Number.NaN
  }
  const column = side === 'left' ? draft.leftColumn : draft.rightColumn
  const value = (dataset.columns[column] as any)?.[row]
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : Number.NaN
}

function evaluateComputedDraft(dataset: any, draft: ComputedColumnDraft): number[] {
  return dataset.ids.map((_id: string, row: number) => {
    const left = computedOperandValueForRow(dataset, draft, 'left', row)
    const right = computedOperandValueForRow(dataset, draft, 'right', row)
    if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.NaN
    if (draft.operator === '+') return left + right
    if (draft.operator === '-') return left - right
    if (draft.operator === '*') return left * right
    return right === 0 ? Number.NaN : left / right
  })
}

function isGeneratedSource(source: string) {
  return source.toLowerCase().includes('generated')
}

function numericColumnStats(col: Float32Array | Int32Array): { min: number; max: number } {
  let min = Infinity, max = -Infinity
  for (let i = 0; i < col.length; i++) {
    const v = col[i]
    if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v }
  }
  return { min, max }
}

function categoricalUniqueCount(col: string[]): number {
  return new Set(col).size
}

function miniHistogramBins(col: Float32Array | Int32Array, min: number, max: number, n = 8): number[] {
  const bins = new Array<number>(n).fill(0)
  const range = max - min || 1
  for (let i = 0; i < col.length; i++) {
    const v = col[i]
    if (!Number.isFinite(v)) continue
    const b = Math.min(Math.floor(((v - min) / range) * n), n - 1)
    bins[b]++
  }
  return bins
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '–'
  const abs = Math.abs(n)
  if (abs === 0) return '0'
  if (abs >= 1000 || abs < 0.001) return n.toExponential(2)
  return parseFloat(n.toPrecision(4)).toString()
}

function vectorDim(ds: any, column: string): number | null {
  return ds.descriptors?.[column]?.dim
    ?? ds.molecularVectors?.[column]?.dim
    ?? ds.atomProperties?.[column]?.dim
    ?? null
}

function columnMissingCount(ds: any, rows: number[], column: string) {
  const values = getColumnValues(ds, column)
  let missing = 0

  for (const row of rows) {
    if (isMissingValue(values[row])) missing += 1
  }

  return missing
}

function getColumnValues(ds: any, column: string): any[] {
  const vectorRecord = vectorRecordForColumn(ds, column)
  if (vectorRecord) {
    return ds.ids.map((id: string) => Array.isArray(vectorRecord.valuesById?.[id]) ? 'vec' : null)
  }
  return Array.from(ds.columns[column] as any)
}

function getDataSourceValues(ds: any): string[] {
  const n = ds.ids.length
  const col = ds.columns[DATA_SOURCE_COL]

  if (!col) return Array(n).fill('dataset_1')

  return Array.from(col as any).map(v => {
    const s = String(v ?? '').trim()
    return s || 'dataset_1'
  })
}

function makeMergedValues(ds: any, priorityColumns: string[], outputKind: 'numeric' | 'categorical') {
  const n = ds.ids.length
  const cols = priorityColumns.map(c => getColumnValues(ds, c))

  if (outputKind === 'numeric') {
    const out = new Array<number | null>(n)

    for (let i = 0; i < n; i++) {
      let chosen: any = null

      for (const col of cols) {
        const v = col[i]
        if (!isMissingValue(v)) {
          chosen = v
          break
        }
      }

      const num = Number(chosen)
      out[i] = Number.isFinite(num) ? num : null
    }

    return out
  }

  const out = new Array<string | null>(n)

  for (let i = 0; i < n; i++) {
    let chosen: any = null

    for (const col of cols) {
      const v = col[i]
      if (!isMissingValue(v)) {
        chosen = v
        break
      }
    }

    out[i] = isMissingValue(chosen) ? null : String(chosen)
  }

  return out
}

function countMergeConflicts(ds: any, columns: string[]) {
  const n = ds.ids.length
  const cols = columns.map(c => getColumnValues(ds, c))
  let conflicts = 0

  for (let i = 0; i < n; i++) {
    let filled = 0

    for (const col of cols) {
      if (!isMissingValue(col[i])) filled++
      if (filled > 1) {
        conflicts++
        break
      }
    }
  }

  return conflicts
}

function moveItem(arr: string[], from: number, to: number) {
  const next = [...arr]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

type ManagementPageProps = {
  stagedSources: StagedSource[]
  setStagedSources: React.Dispatch<React.SetStateAction<StagedSource[]>>
}

function ManagementPage({ stagedSources, setStagedSources }: ManagementPageProps) {
  const ds = useStore(s => s.dataset)
  const fullDataset = useStore(s => s.fullDataset)
  const source = useStore(s => s.source)
  const setDataset = useStore(s => s.setDataset)
  const setSource = useStore(s => s.setSource)
  const removeColumns = useStore(s => s.removeColumns)
  const addColumns = useStore(s => s.addColumns)
  const renameColumn = useStore(s => s.renameColumn)
  const renameDataSource = useStore(s => s.renameDataSource)

  const pushToast = useUIStore(s => s.pushToast)

  const { size: filterPanelWidth, startDrag: startFilterDrag } = useSplitPane('mgmt-filter-panel-width', 300, 200, 600)

  const [duplicateIdPolicy, setDuplicateIdPolicy] = useState<DuplicateIdPolicy>('rename')
  const [columnConflictPolicy, setColumnConflictPolicy] = useState<ColumnConflictPolicy>('merge')
  const [compileBusy, setCompileBusy] = useState(false)
  const [compileIssues, setCompileIssues] = useState<string[]>([])
  const [compileWarnings, setCompileWarnings] = useState<string[]>([])

  const [compileMsg, setCompileMsg] = useState<string | null>(null)
  const [compileDetail, setCompileDetail] = useState<string>('')
  const [compileProgress, setCompileProgress] = useState<number>(0)
  const compileMsgTimer = useRef<number | null>(null)

  const [searchBySource, setSearchBySource] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expandedCols, setExpandedCols] = useState<Set<string>>(new Set())
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, DraftField>>({})
  const [columnDrafts, setColumnDrafts] = useState<Record<string, DraftField>>({})
  const [cardWarnings, setCardWarnings] = useState<Record<string, string>>({})
  const [computedDrafts, setComputedDrafts] = useState<Record<string, ComputedColumnDraft | null>>({})
  const [compiledComputedDraft, setCompiledComputedDraft] = useState<ComputedColumnDraft | null>(null)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [mergeError, setMergeError] = useState('')
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeName, setMergeName] = useState('')
  const [priorityColumns, setPriorityColumns] = useState<string[]>([])
  const [prioritySourcesByColumn, setPrioritySourcesByColumn] = useState<Record<string, string>>({})
  const [conflictCount, setConflictCount] = useState(0)

  const [renameColumnName, setRenameColumnName] = useState('')
  const [renameColumnNewName, setRenameColumnNewName] = useState('')
  const [renameColumnError, setRenameColumnError] = useState('')

  const [renameSourceName, setRenameSourceName] = useState('')
  const [renameSourceNewName, setRenameSourceNewName] = useState('')
  const [renameSourceError, setRenameSourceError] = useState('')

  const [summaryExpanded, setSummaryExpanded] = useState(false)

  const sourceCounts = useMemo(() => {
    if (!ds) return []
    const labels = getDataSourceValues(ds)
    const counts: Record<string, number> = {}
    for (const l of labels) counts[l] = (counts[l] ?? 0) + 1
    const total = labels.length
    return Object.entries(counts).map(([label, count]) => ({
      label,
      count,
      pct: total > 0 ? (count / total) * 100 : 0,
    }))
  }, [ds])

  const coverageMap = useMemo(() => {
    if (!ds) return {} as Record<string, Set<string>>
    const labels = getDataSourceValues(ds)
    const map: Record<string, Set<string>> = {}
    for (const { label } of sourceCounts) map[label] = new Set()
    for (const colName of Object.keys(ds.columns)) {
      const vals = Array.from(ds.columns[colName] as any)
      for (let i = 0; i < labels.length; i++) {
        if (!isMissingValue(vals[i])) map[labels[i]]?.add(colName)
      }
    }
    return map
  }, [ds, sourceCounts])

  const numericStats = useMemo(() => {
    if (!ds) return []
    return (ds.meta.numericColumns as string[]).map(col => {
      const vals = Array.from(ds.columns[col] as any) as any[]
      let min = Infinity, max = -Infinity, sum = 0, count = 0
      for (const v of vals) {
        const n = Number(v)
        if (Number.isFinite(n)) { min = Math.min(min, n); max = Math.max(max, n); sum += n; count++ }
      }
      return { col, min: count ? min : 0, max: count ? max : 0, mean: count ? sum / count : 0 }
    })
  }, [ds])

  // Backend-served sources (mode 'base') keep their XYZ only in the backend's
  // in-memory cache, which a later upload can overwrite. Snapshot the
  // geometries onto the staged source right away so it owns its own data.
  const snapshotStagedXyz = (staged: StagedSource) => {
    if (!staged.source || staged.source.mode !== 'base') return
    const ids = (staged.dataset.ids || []).map(String)
    if (ids.length === 0) return

    resolveXyzByIds(ids, staged.source)
      .then(xyzById => {
        const missing = ids.filter(id => !lookupXyz(xyzById, id)).length
        setStagedSources(prev => prev.map(s => (
          s.id === staged.id
            ? {
                ...s,
                xyzById: { ...xyzById, ...(s.xyzById || {}) },
                warnings: missing > 0
                  ? [`${missing.toLocaleString()} / ${ids.length.toLocaleString()} molecules have no XYZ geometry.`]
                  : [],
              }
            : s
        )))
        if (missing > 0) {
          pushToast(
            `'${staged.label}': no XYZ found for ${missing.toLocaleString()} / ${ids.length.toLocaleString()} molecules`,
            'warning'
          )
        }
      })
      .catch(() => {
        // Compile-time resolution will retry and report any failures.
      })
  }

  const registerStagedSource = (input: {
    kind: StagedSourceKind
    label: string
    dataset: any
    source?: DatasetSource | null
    xyzById?: Record<string, string>
  }) => {
    const existing = new Set(
      stagedSources.map(s => s.label.trim().toLowerCase()).filter(Boolean)
    )
    const baseLabel = input.label.trim() || input.kind
    let label = baseLabel
    let i = 2
    while (existing.has(label.toLowerCase())) {
      label = `${baseLabel}_${i}`
      i += 1
    }

    const staged = createStagedSource({
      kind: input.kind,
      label,
      dataset: input.dataset,
      source: input.source ?? (input.xyzById ? { mode: 'mixed', xyzById: input.xyzById } : null),
      xyzById: input.xyzById,
    })

    setStagedSources(prev => [...prev, staged])
    setCompileIssues([])
    pushToast(`Staged source '${label}'`, 'success')
    snapshotStagedXyz(staged)
  }

  const registerStagedSourceAndCompile = (input: {
    kind: StagedSourceKind
    label: string
    dataset: any
    source?: DatasetSource | null
    xyzById?: Record<string, string>
  }) => {
    const existing = new Set(
      stagedSources.map(s => s.label.trim().toLowerCase()).filter(Boolean)
    )
    const baseLabel = input.label.trim() || input.kind
    let label = baseLabel
    let i = 2
    while (existing.has(label.toLowerCase())) {
      label = `${baseLabel}_${i}`
      i += 1
    }

    const staged = createStagedSource({
      kind: input.kind,
      label,
      dataset: input.dataset,
      source: input.source ?? (input.xyzById ? { mode: 'mixed', xyzById: input.xyzById } : null),
      xyzById: input.xyzById,
    })

    const newSources = [...stagedSources, staged]
    setStagedSources(newSources)
    setCompileIssues([])
    compileSources(newSources)
  }

  const updateStagedSource = (id: string, patch: Partial<StagedSource>) => {
    setStagedSources(prev => prev.map(source => (
      source.id === id ? { ...source, ...patch } : source
    )))
  }

  const bumpStagedSourceLabel = (sourceId: string) => {
    const current = stagedSources.find(s => s.id === sourceId)
    if (!current) return
    const requested = current.label.trim()
    if (!requested) return
    const existing = stagedSources
      .filter(s => s.id !== sourceId)
      .map(s => s.label)
    const finalLabel = bumpDataSourceLabel(requested, existing)
    if (finalLabel && finalLabel !== requested) {
      updateStagedSource(sourceId, { label: finalLabel })
      pushToast(`Data source label bumped to '${finalLabel}'`, 'info')
    }
  }

  const updateStagedColumn = (
    sourceId: string,
    original: string,
    patch: Partial<StagedSource['columns'][number]>
  ) => {
    setStagedSources(prev => prev.map(source => (
      source.id === sourceId
        ? {
            ...source,
            columns: source.columns.map(column => (
              column.original === original ? { ...column, ...patch } : column
            )),
          }
        : source
    )))
  }

  const makeComputedDraft = (source: StagedSource): ComputedColumnDraft | null => {
    return makeComputedDraftForDataset(source.dataset)
  }

  const showComputedColumnEditor = (source: StagedSource) => {
    const draft = makeComputedDraft(source)
    if (!draft) {
      pushToast('This source has no numeric scalar columns for computed columns', 'warning')
      return
    }
    setComputedDrafts({ [source.id]: computedDrafts[source.id] || draft })
  }

  const updateComputedDraft = (sourceId: string, patch: Partial<ComputedColumnDraft>) => {
    setComputedDrafts(prev => {
      const current = prev[sourceId]
      if (!current) return prev
      return { ...prev, [sourceId]: { ...current, ...patch } }
    })
  }

  const cancelComputedColumnEditor = (sourceId: string) => {
    setComputedDrafts(prev => {
      const next = { ...prev }
      delete next[sourceId]
      return next
    })
  }

  const addComputedColumn = (source: StagedSource) => {
    const draft = computedDrafts[source.id]
    if (!draft) return
    const numericColumns = new Set(numericScalarColumns(source.dataset))
    const outputName = draft.outputName.trim()
    if (!outputName) {
      pushToast('Computed column needs an output name', 'error')
      return
    }
    const existing = new Set(source.columns.map(column => column.draftName.trim()).filter(Boolean))
    if (existing.has(outputName)) {
      pushToast(`Column '${outputName}' already exists in this source`, 'error')
      return
    }

    const buildOperand = (side: 'left' | 'right'): ComputedOperand | null => {
      const kind = side === 'left' ? draft.leftKind : draft.rightKind
      if (kind === 'constant') {
        const value = side === 'left' ? draft.leftConstant : draft.rightConstant
        const trimmedValue = value.trim()
        const numberValue = Number(trimmedValue)
        if (!trimmedValue) return null
        if (!Number.isFinite(numberValue)) return null
        return { kind: 'constant', value: trimmedValue }
      }
      const column = side === 'left' ? draft.leftColumn : draft.rightColumn
      return numericColumns.has(column) ? { kind: 'column', column } : null
    }

    const left = buildOperand('left')
    const right = buildOperand('right')
    if (!left || !right) {
      pushToast('Computed operands must be numeric columns or finite constants', 'error')
      return
    }

    const id = `computed:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const computed: ComputedColumnDefinition = {
      id,
      name: outputName,
      left,
      operator: draft.operator,
      right,
    }

    updateStagedSource(source.id, {
      computedColumns: [...(source.computedColumns || []), computed],
      columns: [
        ...source.columns,
        { original: id, draftName: outputName, included: true, origin: 'computed' },
      ],
    })
    cancelComputedColumnEditor(source.id)
  }

  const removeComputedColumn = (sourceId: string, columnId: string) => {
    setStagedSources(prev => prev.map(source => (
      source.id === sourceId
        ? {
            ...source,
            computedColumns: (source.computedColumns || []).filter(column => column.id !== columnId),
            columns: source.columns.filter(column => column.original !== columnId),
          }
        : source
    )))
  }

  const showCompiledComputedColumnEditor = () => {
    const base = fullDataset || ds
    if (!base) return
    const draft = makeComputedDraftForDataset(base)
    if (!draft) {
      pushToast('Compiled data has no numeric scalar columns for computed columns', 'warning')
      return
    }
    setCompiledComputedDraft(compiledComputedDraft || draft)
  }

  const updateCompiledComputedDraft = (patch: Partial<ComputedColumnDraft>) => {
    setCompiledComputedDraft(prev => prev ? { ...prev, ...patch } : prev)
  }

  const addCompiledComputedColumn = () => {
    const base = fullDataset || ds
    const draft = compiledComputedDraft
    if (!base || !draft) return
    const outputName = draft.outputName.trim()
    if (!outputName) {
      pushToast('Computed column needs an output name', 'error')
      return
    }
    const existing = new Set(orderedColumns(base))
    if (existing.has(outputName) || Object.prototype.hasOwnProperty.call(base.columns, outputName)) {
      pushToast(`Column '${outputName}' already exists in compiled data`, 'error')
      return
    }
    const numericColumns = new Set(numericScalarColumns(base))
    const operandColumns = [
      draft.leftKind === 'column' ? draft.leftColumn : '',
      draft.rightKind === 'column' ? draft.rightColumn : '',
    ].filter(Boolean)
    if (operandColumns.some(column => !numericColumns.has(column))) {
      pushToast('Computed operands must be numeric columns or finite constants', 'error')
      return
    }
    if (
      (draft.leftKind === 'constant' && !Number.isFinite(Number(draft.leftConstant.trim()))) ||
      (draft.rightKind === 'constant' && !Number.isFinite(Number(draft.rightConstant.trim())))
    ) {
      pushToast('Computed operands must be numeric columns or finite constants', 'error')
      return
    }
    addColumns([{ name: outputName, kind: 'numeric', values: evaluateComputedDraft(base, draft) }])
    setCompiledComputedDraft(null)
    pushToast(`Added computed column '${outputName}'`, 'success')
  }

  const showCompileOverlay = (msg: string, detail = '', pct = 0) => {
    if (compileMsgTimer.current) window.clearTimeout(compileMsgTimer.current)
    setCompileMsg(msg)
    setCompileDetail(detail)
    setCompileProgress(pct)
  }

  const hideCompileOverlay = () => {
    if (compileMsgTimer.current) window.clearTimeout(compileMsgTimer.current)
    compileMsgTimer.current = null
    setCompileMsg(null)
    setCompileDetail('')
    setCompileProgress(0)
  }

  const flashCompileOverlay = (msg: string, detail = '', ms = 700) => {
    showCompileOverlay(msg, detail, 100)
    compileMsgTimer.current = window.setTimeout(() => {
      setCompileMsg(null)
      setCompileDetail('')
      setCompileProgress(0)
      compileMsgTimer.current = null
    }, ms)
  }

  // Resolve only the IDs that are still missing from each source's xyzById
  // and merge the results in. A partially resolved map can therefore always
  // be completed later, and already-resolved geometries are never discarded.
  const resolveSourcesForCompile = async (
    onProgress: (pct: number, detail: string) => void,
    sourcesToUse: StagedSource[] = stagedSources
  ) => {
    const resolved: StagedSource[] = []
    const plans = sourcesToUse.map(sourceRecord => ({
      sourceRecord,
      missing: sourceRecord.included && sourceRecord.source
        ? (sourceRecord.dataset.ids || []).map(String).filter(id => !lookupXyz(sourceRecord.xyzById, id))
        : [],
    }))
    const totalIds = plans.reduce((sum, plan) => sum + plan.missing.length, 0)
    let resolvedCount = 0

    for (const { sourceRecord, missing } of plans) {
      if (missing.length === 0 || !sourceRecord.source) {
        resolved.push(sourceRecord)
        continue
      }

      const resolvedBeforeSource = resolvedCount
      const xyzById = await resolveXyzByIds(missing, sourceRecord.source, {
        onProgress: count => {
          resolvedCount = resolvedBeforeSource + count
          if (count % 100 === 0 || count === missing.length) {
            const pct = totalIds > 0 ? Math.round((resolvedCount / totalIds) * 75) : 75
            onProgress(
              Math.max(5, pct),
              `${resolvedCount.toLocaleString()} / ${totalIds.toLocaleString()} molecules resolved`
            )
          }
        },
      })
      resolvedCount = resolvedBeforeSource + missing.length

      resolved.push({ ...sourceRecord, xyzById: { ...(sourceRecord.xyzById || {}), ...xyzById } })
      await new Promise<void>(r => setTimeout(r, 0))
    }

    return resolved
  }

  const compileSources = async (sourcesOverride?: StagedSource[]) => {
    setCompileBusy(true)
    setCompileIssues([])
    setCompileWarnings([])
    showCompileOverlay('Resolving XYZ data…', 'Preparing molecule geometries.', 2)

    try {
      const resolved = await resolveSourcesForCompile((pct, detail) => {
        setCompileProgress(pct)
        setCompileDetail(detail)
      }, sourcesOverride)

      // Persist resolved geometries on the staged sources so they survive
      // backend cache changes and don't need re-fetching on the next compile.
      setStagedSources(prev => prev.map(s => {
        const r = resolved.find(x => x.id === s.id)
        return r && r.xyzById !== s.xyzById ? { ...s, xyzById: r.xyzById } : s
      }))

      setCompileProgress(80)
      setCompileMsg('Compiling dataset…')
      setCompileDetail('Merging sources and columns.')
      await new Promise<void>(r => setTimeout(r, 0))

      const result = compileStagedSources(resolved, {
        duplicateIdPolicy,
        columnConflictPolicy,
      })

      if (result.ok === false) {
        hideCompileOverlay()
        setCompileIssues(result.issues.map(issue => issue.message))
        pushToast('Compile blocked by validation errors', 'error')
        return
      }

      const xyzCount = Object.keys(result.xyzById || {}).length
      if (result.dataset.ids.length > 0 && xyzCount !== result.dataset.ids.length) {
        hideCompileOverlay()
        const missingCount = result.dataset.ids.length - xyzCount
        const message = (
          `Compile blocked: XYZ geometries are required for every molecule, but ` +
          `${missingCount.toLocaleString()} / ${result.dataset.ids.length.toLocaleString()} rows are missing XYZ.`
        )
        setCompileIssues([
          message,
          ...result.warnings.filter(warning => warning.startsWith('No XYZ found')).slice(0, 10),
        ])
        pushToast(message, 'error')
        return
      }

      setDataset(result.dataset)
      setSource({ mode: 'mixed', xyzById: result.xyzById })
      const compileWarnings = [
        ...result.warnings,
      ]
      setCompileWarnings(compileWarnings.slice(0, 20))
      flashCompileOverlay(
        'Compile complete',
        `${result.dataset.ids.length.toLocaleString()} molecules compiled.`,
        800
      )
      pushToast(`Compiled ${result.dataset.ids.length.toLocaleString()} molecules`, 'success')
    } catch (err: any) {
      const message = err?.message || String(err)
      hideCompileOverlay()
      setCompileIssues([message])
      pushToast(message, 'error')
    } finally {
      setCompileBusy(false)
    }
  }

  const allColumns = useMemo(() => {
    if (!ds) return [] as string[]
    return orderedColumns(ds)
  }, [ds])

  const dataSources = useMemo(() => {
    if (!ds) return [] as string[]
    return Array.from(new Set(getDataSourceValues(ds))).sort((a, b) => a.localeCompare(b))
  }, [ds])

  const selectedEntries = useMemo(
    () => Array.from(selected).map(parseSelectionKey),
    [selected]
  )

  const selectedUniqueColumns = useMemo(
    () => Array.from(new Set(selectedEntries.map(e => e.column))),
    [selectedEntries]
  )

  const selectedCount = selectedUniqueColumns.length

  const toggle = (source: string, column: string) => {
    const key = selectionKey(source, column)

    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAllForSource = (source: string, columns: string[]) => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const col of columns) next.add(selectionKey(source, col))
      return next
    })
  }

  const clearForSource = (source: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const key of Array.from(next)) {
        if (key.startsWith(`${source}${SEP}`)) next.delete(key)
      }
      return next
    })
  }

  const clearSelection = () => setSelected(new Set())

  const setCardWarning = (key: string, message: string) => {
    setCardWarnings(prev => {
      const next = { ...prev }
      if (message) next[key] = message
      else delete next[key]
      return next
    })
  }

  const sourceDraftValue = (sourceName: string) =>
    sourceDrafts[sourceName]?.value ?? sourceName

  const columnDraftValue = (columnName: string) =>
    columnDrafts[columnName]?.value ?? columnName

  const commitSourceRename = (oldName: string) => {
    const draft = sourceDrafts[oldName]
    const nextName = (draft?.value ?? oldName).trim()
    const key = `source:${oldName}`

    if (!nextName) {
      setCardWarning(key, 'Dataset name is required.')
      return
    }

    if (nextName === oldName) {
      setCardWarning(key, '')
      setSourceDrafts(prev => {
        const next = { ...prev }
        delete next[oldName]
        return next
      })
      return
    }

    if (dataSources.includes(nextName)) {
      setCardWarning(key, `A dataset named '${nextName}' already exists.`)
      return
    }

    const result = renameDataSource(oldName, nextName)
    if (!result.ok) {
      setCardWarning(key, result.error || 'Could not rename dataset.')
      return
    }

    setSelected(prev => {
      const next = new Set<string>()
      for (const item of prev) {
        const entry = parseSelectionKey(item)
        next.add(selectionKey(entry.source === oldName ? nextName : entry.source, entry.column))
      }
      return next
    })
    setSearchBySource(prev => {
      const next = { ...prev }
      if (Object.prototype.hasOwnProperty.call(next, oldName)) {
        next[nextName] = next[oldName]
        delete next[oldName]
      }
      return next
    })
    setSourceDrafts(prev => {
      const next = { ...prev }
      delete next[oldName]
      return next
    })
    setCardWarning(key, '')
  }

  const commitColumnRename = (oldName: string) => {
    const draft = columnDrafts[oldName]
    const nextName = (draft?.value ?? oldName).trim()
    const key = `column:${oldName}`

    if (!nextName) {
      setCardWarning(key, 'Column name is required.')
      return
    }

    if (nextName === oldName) {
      setCardWarning(key, '')
      setColumnDrafts(prev => {
        const next = { ...prev }
        delete next[oldName]
        return next
      })
      return
    }

    if (ds?.columns[nextName]) {
      setCardWarning(key, `A column named '${nextName}' already exists.`)
      return
    }

    const result = renameColumn(oldName, nextName)
    if (!result.ok) {
      setCardWarning(key, result.error || 'Could not rename column.')
      return
    }

    setSelected(prev => {
      const next = new Set<string>()
      for (const item of prev) {
        const entry = parseSelectionKey(item)
        next.add(selectionKey(entry.source, entry.column === oldName ? nextName : entry.column))
      }
      return next
    })
    setColumnDrafts(prev => {
      const next = { ...prev }
      delete next[oldName]
      return next
    })
    setCardWarning(key, '')
  }

  const keyCommitHandler = (
    event: React.KeyboardEvent<HTMLInputElement>,
    commit: () => void,
    reset: () => void
  ) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      reset()
      event.currentTarget.blur()
    }
  }

  const openConfirm = () => {
    if (selectedCount === 0) return
    setConfirmOpen(true)
  }

  const doDelete = () => {
    removeColumns(selectedUniqueColumns)
    setConfirmOpen(false)
    setSelected(new Set())
  }

  const openMerge = () => {
    setMergeError('')

    if (!ds) return

    if (selectedEntries.length < 2) {
      setMergeError('Select at least two columns to merge.')
      return
    }

    const sources = selectedEntries.map(e => e.source)
    const uniqueSources = new Set(sources)

    if (uniqueSources.size !== selectedEntries.length) {
      setMergeError('Merge requires selected columns from different data sources. You selected more than one column from the same source.')
      return
    }

    const uniqueColumns = new Set(selectedEntries.map(e => e.column))

    if (uniqueColumns.size !== selectedEntries.length) {
      setMergeError('The same global column was selected more than once. Select different columns to merge.')
      return
    }

	const cols = selectedEntries.map(e => e.column)
	
	const sourcesByColumn: Record<string, string> = {}
	for (const entry of selectedEntries) {
	  sourcesByColumn[entry.column] = entry.source
	}
	
	setPriorityColumns(cols)
	setPrioritySourcesByColumn(sourcesByColumn)
	setMergeName(cols[0] || '')
	setConflictCount(countMergeConflicts(ds, cols))
	setMergeOpen(true)

  }

  const doMerge = () => {
    if (!ds) return

    const outputName = mergeName.trim()

    if (!outputName) {
      setMergeError('Choose a name for the merged column.')
      return
    }

    const selectedColumns = Array.from(new Set(priorityColumns))

    if (selectedColumns.length < 2) {
      setMergeError('Select at least two columns to merge.')
      return
    }

    const numeric = selectedColumns.every(c => isNumericColumn(ds, c))
    const kind = numeric ? 'numeric' : 'categorical'
    const mergedValues = makeMergedValues(ds, priorityColumns, kind)

    addColumns([
      {
        name: outputName,
        kind,
        values: mergedValues,
      },
    ])

    const colsToDelete = selectedColumns.filter(c => c !== outputName)
    if (colsToDelete.length > 0) removeColumns(colsToDelete)

    setMergeOpen(false)
    setMergeError('')
    setSelected(new Set())
	setPriorityColumns([])
	setPrioritySourcesByColumn({})
	setMergeName('')
	setConflictCount(0)

  }


  const doRenameColumn = () => {
    setRenameColumnError('')

    const oldName = renameColumnName.trim()
    const newName = renameColumnNewName.trim()

    if (!oldName) {
      setRenameColumnError('Choose a column to rename.')
      return
    }

    if (!newName) {
      setRenameColumnError('Enter a new column name.')
      return
    }

    if (ds?.columns[newName]) {
      setRenameColumnError(`A column named '${newName}' already exists. Choose a different name.`)
      return
    }

    const result = renameColumn(oldName, newName)
    if (!result.ok) {
      setRenameColumnError(result.error || 'Could not rename column.')
      return
    }

    setRenameColumnName(newName)
    setRenameColumnNewName('')
    setSelected(new Set())
  }

  const doRenameDataSource = () => {
    setRenameSourceError('')

    const oldName = renameSourceName.trim()
    const newName = renameSourceNewName.trim()

    if (!oldName) {
      setRenameSourceError('Choose a data_source to rename.')
      return
    }

    if (!newName) {
      setRenameSourceError('Enter a new data_source name.')
      return
    }

    if (oldName === newName) {
      setRenameSourceNewName('')
      return
    }

    const existingTargets = dataSources.filter(name => name !== oldName)
    const finalName = bumpDataSourceLabel(newName, existingTargets)
    if (!finalName) {
      setRenameSourceError('Enter a new data_source name.')
      return
    }

    if (finalName !== newName) {
      pushToast(`Data source label bumped to '${finalName}'`, 'info')
    }

    const result = renameDataSource(oldName, finalName)
    if (!result.ok) {
      setRenameSourceError(result.error || 'Could not rename data_source.')
      return
    }

    setRenameSourceName(finalName)
    setRenameSourceNewName('')
    setSearchBySource(prev => {
      const next = { ...prev }
      if (Object.prototype.hasOwnProperty.call(next, oldName)) {
        next[finalName] = next[oldName]
        delete next[oldName]
      }
      return next
    })
    setSelected(new Set())
  }

  const activeComputedSource = stagedSources.find(source => Boolean(computedDrafts[source.id])) || null
  const activeComputedDraft = compiledComputedDraft || (activeComputedSource ? computedDrafts[activeComputedSource.id] : null)
  const activeComputedNumericColumns = compiledComputedDraft
    ? numericScalarColumns(fullDataset || ds)
    : (activeComputedSource ? numericScalarColumns(activeComputedSource.dataset) : [])
  const activeComputedTitle = compiledComputedDraft ? 'Compiled data' : (activeComputedSource?.label || '')
  const cancelActiveComputed = () => {
    if (compiledComputedDraft) setCompiledComputedDraft(null)
    else if (activeComputedSource) cancelComputedColumnEditor(activeComputedSource.id)
  }
  const updateActiveComputedDraft = (patch: Partial<ComputedColumnDraft>) => {
    if (compiledComputedDraft) updateCompiledComputedDraft(patch)
    else if (activeComputedSource) updateComputedDraft(activeComputedSource.id, patch)
  }
  const addActiveComputedColumn = () => {
    if (compiledComputedDraft) addCompiledComputedColumn()
    else if (activeComputedSource) addComputedColumn(activeComputedSource)
  }

  return (
    <div className="page-stack">
      <div className="card section-card">
        <div className="section-title gradient-text">Management</div>
        {ds ? (
          <div>
            <button
              className="col-expand-btn"
              style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-dim)' }}
              onClick={() => setSummaryExpanded(v => !v)}
            >
              {summaryExpanded ? '▾' : '▸'}
              {' '}Active compiled dataset: {ds.ids.length.toLocaleString()} molecules — {Object.keys(ds.columns).length.toLocaleString()} columns
            </button>

            {summaryExpanded && (
              <div className="compiled-summary-dropdown">
                <div className="compiled-summary-section">
                  <div className="field-title" style={{ fontSize: 'var(--text-xs)' }}>Rows per source</div>
                  <table className="compiled-summary-table">
                    <thead><tr><th>Source</th><th>Rows</th><th>%</th></tr></thead>
                    <tbody>
                      {sourceCounts.map(({ label, count, pct }) => (
                        <tr key={label}>
                          <td>{label}</td>
                          <td>{count.toLocaleString()}</td>
                          <td>{pct.toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="compiled-summary-section">
                  <div className="field-title" style={{ fontSize: 'var(--text-xs)' }}>Column coverage per source</div>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="compiled-summary-table">
                      <thead>
                        <tr>
                          <th>Column</th>
                          {sourceCounts.map(s => <th key={s.label}>{s.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {Object.keys(ds.columns).map(col => (
                          <tr key={col}>
                            <td>{col}</td>
                            {sourceCounts.map(s => (
                              <td key={s.label} style={{ textAlign: 'center' }}>
                                {coverageMap[s.label]?.has(col) ? '✓' : '—'}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {numericStats.length > 0 && (
                  <div className="compiled-summary-section">
                    <div className="field-title" style={{ fontSize: 'var(--text-xs)' }}>Numeric column stats</div>
                    <table className="compiled-summary-table">
                      <thead><tr><th>Column</th><th>Min</th><th>Max</th><th>Mean</th></tr></thead>
                      <tbody>
                        {numericStats.map(({ col, min, max, mean }) => (
                          <tr key={col}>
                            <td>{col}</td>
                            <td>{min.toPrecision(4)}</td>
                            <td>{max.toPrecision(4)}</td>
                            <td>{mean.toPrecision(4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="legend">No compiled dataset is active. Register one or more sources, then compile.</div>
        )}
      </div>

      <div className="grid-pair gap-md">
        <div className="card section-card">
          <div className="field-title">Upload / Register source</div>
          <div className="legend mb-md">
            Parsed sources are staged here first. Visualization and Analysis keep using the last compiled dataset.
          </div>
          <DatasetBuilder
            onRegisterSource={registerStagedSource}
            onRegisterAndCompile={registerStagedSourceAndCompile}
          />
        </div>
        <GeneratedMoleculesBuilder onRegisterSource={registerStagedSource} />
      </div>

      <div className="card section-card card-stack-lg">
        <div>
          <div className="field-title">Dataset sources organizer</div>
          <div className="legend">
            Include sources and columns, edit staged labels and output column names, then compile the active dataset.
          </div>
        </div>

        {compileIssues.length > 0 ? (
          <div className="status-box status-error">
            {compileIssues.slice(0, 8).map((issue, idx) => (
              <div key={`${idx}-${issue}`}>{issue}</div>
            ))}
          </div>
        ) : null}

        {compileWarnings.length > 0 ? (
          <div className="status status-warning">
            {compileWarnings.map((warning, idx) => (
              <div key={`${idx}-${warning}`} className="legend">{warning}</div>
            ))}
          </div>
        ) : null}

        {stagedSources.length === 0 ? (
          <div className="status-box">
            No staged sources yet.
          </div>
        ) : null}

        <div className="dataset-card-grid">
          {stagedSources.map(staged => {
            const includedCount = staged.columns.filter(c => c.included).length
            const cardWarningsList = [
              !staged.label.trim() ? 'Source label is required' : '',
              staged.columns.length > 0 && includedCount === 0 ? 'No columns selected' : '',
            ].filter(Boolean)
            const readiness =
              !staged.included
                ? 'Excluded'
                : staged.columns.length > 0 && includedCount === 0
                ? 'No columns selected'
                : cardWarningsList.length > 0
                  ? 'Needs attention'
                  : 'Ready'
            const sourceLower = staged.label.toLowerCase()
            const numericColumns = numericScalarColumns(staged.dataset)
            const SourceIcon = staged.kind === 'generated' || isGeneratedSource(staged.label)
              ? Sparkles
              : staged.kind === 'ase' || sourceLower.includes('ase') || sourceLower.includes('db')
                ? Database
                : FileText

            return (
              <div
                key={staged.id}
                className={`dataset-flashcard${staged.kind === 'generated' ? ' dataset-flashcard-generated' : ''}${cardWarningsList.length ? ' dataset-flashcard-warning' : ''}`}
              >
                <div className="dataset-card-header">
                  <div className="dataset-card-title">
                    <input
                      type="checkbox"
                      checked={staged.included}
                      onChange={e => updateStagedSource(staged.id, { included: e.target.checked })}
                      aria-label={`Include ${staged.label}`}
                    />
                    <SourceIcon size={16} className="dataset-source-icon" />
                    <input
                      value={staged.label}
                      disabled={!!staged.locked}
                      onChange={e => updateStagedSource(staged.id, { label: e.target.value })}
                      onBlur={() => bumpStagedSourceLabel(staged.id)}
                      className={`dataset-name-input${!staged.label.trim() ? ' has-warning' : ''}`}
                      title={staged.label}
                      aria-label={`Dataset name for ${staged.label}`}
                    />
                  </div>

                  <div className="dataset-card-header-meta">
                    <span className="dataset-source-badge">
                      {staged.locked ? 'Compiled' : staged.kind === 'generated' ? 'Generated' : 'Staged'}
                    </span>
                    <span className="dataset-row-count">
                      {staged.dataset.ids.length.toLocaleString()} rows
                    </span>
                    {!staged.locked ? (
                      <button
                        className="btn btn-icon btn-ghost"
                        onClick={() => setStagedSources(prev => prev.filter(s => s.id !== staged.id))}
                        title="Remove staged source"
                        aria-label={`Remove ${staged.label}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="dataset-stat-strip">
                  <div className="dataset-stat">
                    <span>Entries</span>
                    <strong>{staged.dataset.ids.length.toLocaleString()}</strong>
                  </div>
                  <div className="dataset-stat">
                    <span>Columns</span>
                    <strong>{staged.columns.length.toLocaleString()}</strong>
                  </div>
                  <div className="dataset-stat">
                    <span>Included</span>
                    <strong>{includedCount.toLocaleString()}</strong>
                  </div>
                  <div className="dataset-stat">
                    <span>Kind</span>
                    <strong>{staged.kind === 'compiled_locked' ? 'locked' : staged.kind.replace('_', ' ')}</strong>
                  </div>
                </div>

                <div className={`dataset-subsample-row${staged.locked ? ' dataset-subsample-row-empty' : ''}`}>
                  {!staged.locked && (
                    <>
                      <span className="dataset-subsample-label">Subsample:</span>
                      <input
                        type="number"
                        className="dataset-subsample-input"
                        min={1}
                        max={staged.dataset.ids.length}
                        placeholder={`All ${staged.dataset.ids.length.toLocaleString()} rows`}
                        value={staged.subsampleN ?? ''}
                        onChange={e => {
                          const raw = e.target.value
                          updateStagedSource(staged.id, {
                            subsampleN: raw === '' ? null : Math.max(1, Math.min(parseInt(raw, 10), staged.dataset.ids.length)),
                          })
                        }}
                      />
                      <input
                        type="number"
                        className="dataset-subsample-seed"
                        placeholder="seed (opt.)"
                        value={staged.subsampleSeed ?? ''}
                        onChange={e => {
                          const raw = e.target.value
                          updateStagedSource(staged.id, { subsampleSeed: raw === '' ? null : parseInt(raw, 10) })
                        }}
                      />
                      {staged.subsampleN != null && staged.subsampleN < staged.dataset.ids.length && (
                        <span className="dataset-subsample-readout">
                          → {staged.subsampleN.toLocaleString()} / {staged.dataset.ids.length.toLocaleString()} rows
                        </span>
                      )}
                    </>
                  )}
                </div>

                <div className="dataset-column-toolbar">
                  <button
                    className="btn btn-sm"
                    onClick={() => updateStagedSource(staged.id, {
                      columns: staged.columns.map(column => ({ ...column, included: true })),
                    })}
                    disabled={staged.columns.length === 0}
                  >
                    <CheckCircle2 size={13} />
                    Select all
                  </button>

                  <button
                    className="btn btn-sm"
                    onClick={() => updateStagedSource(staged.id, {
                      columns: staged.columns.map(column => ({ ...column, included: false })),
                    })}
                    disabled={includedCount === 0}
                  >
                    <X size={13} />
                    Clear
                  </button>

                  <button
                    className="btn btn-sm"
                    onClick={() => showComputedColumnEditor(staged)}
                    disabled={staged.locked || numericColumns.length === 0}
                    title={numericColumns.length === 0 ? 'No numeric scalar columns available' : 'Add computed column'}
                  >
                    <PlusCircle size={13} />
                    Computed
                  </button>
                </div>

                <div className="dataset-column-list">
                  {staged.columns.length === 0 ? (
                    <div className="dataset-column-empty">No columns match.</div>
                  ) : (
                    staged.columns.map(column => {
                      const isComputed = column.origin === 'computed' || Boolean(staged.computedColumns?.some(computed => computed.id === column.original))
                      const kind = isComputed
                        ? 'num'
                        : isVectorColumn(staged.dataset, column.original)
                        ? 'vec'
                        : isNumericColumn(staged.dataset, column.original)
                          ? 'num'
                          : 'cat'
                      const colKey = `${staged.id}::${column.original}`
                      const isExpanded = expandedCols.has(colKey)

                      let inlineStats: React.ReactNode = null
                      if (isExpanded) {
                        if (kind === 'num' && !isComputed) {
                          const raw = staged.dataset.columns[column.original] as Float32Array | Int32Array
                          const precomp = staged.dataset.stats?.numericRanges?.[column.original]
                          const { min, max } = precomp ?? numericColumnStats(raw)
                          const bins = miniHistogramBins(raw, min, max)
                          const bmax = Math.max(...bins, 1)
                          inlineStats = (
                            <span className="col-inline-stats">
                              <span>{fmtNum(min)}</span>
                              <span className="mini-hist">
                                {bins.map((b, i) => (
                                  <span
                                    key={i}
                                    className="mini-bar"
                                    style={{ height: `${Math.max((b / bmax) * 100, 4)}%` }}
                                  />
                                ))}
                              </span>
                              <span>{fmtNum(max)}</span>
                            </span>
                          )
                        } else if (kind === 'cat') {
                          const col = staged.dataset.columns[column.original] as string[]
                          inlineStats = (
                            <span className="col-inline-stats">
                              {categoricalUniqueCount(col)} uniq
                            </span>
                          )
                        } else {
                          const dim = vectorDim(staged.dataset, column.original)
                          inlineStats = dim != null ? (
                            <span className="col-inline-stats">dim {dim}</span>
                          ) : null
                        }
                      }

                      return (
                        <div
                          key={`${staged.id}-${column.original}`}
                          title={column.original}
                          className={`dataset-column-row${!column.draftName.trim() ? ' has-warning' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={column.included}
                            disabled={!staged.included}
                            onChange={e => updateStagedColumn(staged.id, column.original, { included: e.target.checked })}
                            aria-label={`Include ${column.original} from ${staged.label}`}
                          />

                          <div className="col-name-stat-cell">
                            <input
                              value={column.draftName}
                              disabled={!staged.included}
                              onChange={e => updateStagedColumn(staged.id, column.original, { draftName: e.target.value })}
                              className="dataset-column-name-input"
                              title={column.draftName}
                              aria-label={`Output column name for ${column.original}`}
                            />
                            {inlineStats}
                          </div>

                          <span className={`dataset-type-badge dataset-type-${kind}`}>
                            {kind}
                          </span>

                          {isComputed ? (
                            <span className="dataset-computed-origin">
                              computed
                            </span>
                          ) : null}

                          {!isComputed && column.original !== column.draftName ? (
                            <span className="dataset-missing-count" title={column.original}>
                              from {column.original}
                            </span>
                          ) : null}

                          {isComputed ? (
                            <button
                              className="col-expand-btn"
                              onClick={() => removeComputedColumn(staged.id, column.original)}
                              aria-label={`remove computed column ${column.draftName}`}
                              title="Remove computed column"
                            >
                              ×
                            </button>
                          ) : (
                            <button
                              className="col-expand-btn"
                              onClick={() => setExpandedCols(prev => {
                                const next = new Set(prev)
                                next.has(colKey) ? next.delete(colKey) : next.add(colKey)
                                return next
                              })}
                              aria-label="toggle column stats"
                            >
                              {isExpanded ? '▾' : '▸'}
                            </button>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>

                <div className="dataset-warning-strip">
                  {cardWarningsList.length > 0 ? (
                    cardWarningsList.map(warning => (
                      <span key={warning} className="dataset-warning-chip">
                        <AlertTriangle size={12} />
                        {warning}
                      </span>
                    ))
                  ) : (
                    <span className="dataset-ready-chip">
                      <CheckCircle2 size={12} />
                      No card warnings
                    </span>
                  )}

                  <span className={`dataset-readiness dataset-readiness-${readiness.toLowerCase().replace(/\s+/g, '-')}`}>
                    {readiness}
                  </span>
                </div>
              </div>
            )
          })}
        </div>

        {activeComputedDraft ? createPortal(
          <div className="modal-overlay" onMouseDown={cancelActiveComputed}>
            <div className="modal-card scatter-settings-modal computed-column-modal" onMouseDown={e => e.stopPropagation()}>
              <div className="scatter-settings-header">
                <div>
                  <div className="modal-title" style={{ marginBottom: 0 }}>Computed Column</div>
                  <div className="legend">Source: {activeComputedTitle}</div>
                </div>
                <button
                  type="button"
                  className="scatter-settings-close"
                  onClick={cancelActiveComputed}
                  aria-label="Close computed column editor"
                  title="Close"
                >
                  <X size={18} />
                  <span>Close</span>
                </button>
              </div>

              <div className="computed-column-modal-body">
                <label className="setting-row">
                  <span>Output column</span>
                  <input
                    value={activeComputedDraft.outputName}
                    onChange={e => updateActiveComputedDraft({ outputName: e.target.value })}
                    placeholder="gap"
                    aria-label="Computed column output name"
                  />
                </label>

                <section className="computed-expression-grid">
                  <label className="setting-row">
                    <span>Left type</span>
                    <select
                      value={activeComputedDraft.leftKind}
                      onChange={e => updateActiveComputedDraft({ leftKind: e.target.value as 'column' | 'constant' })}
                      aria-label="Left operand type"
                    >
                      <option value="column">Column</option>
                      <option value="constant">Constant</option>
                    </select>
                  </label>

                  <label className="setting-row">
                    <span>Left value</span>
                    {activeComputedDraft.leftKind === 'column' ? (
                      <select
                        value={activeComputedDraft.leftColumn}
                        onChange={e => updateActiveComputedDraft({ leftColumn: e.target.value })}
                        aria-label="Left numeric column"
                      >
                        {activeComputedNumericColumns.map(column => (
                          <option key={column} value={column}>{column}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={activeComputedDraft.leftConstant}
                        onChange={e => updateActiveComputedDraft({ leftConstant: e.target.value })}
                        placeholder="0"
                        aria-label="Left constant"
                      />
                    )}
                  </label>

                  <label className="setting-row">
                    <span>Operator</span>
                    <select
                      value={activeComputedDraft.operator}
                      onChange={e => updateActiveComputedDraft({ operator: e.target.value as ComputedOperator })}
                      aria-label="Computed operator"
                    >
                      <option value="+">+</option>
                      <option value="-">-</option>
                      <option value="*">*</option>
                      <option value="/">/</option>
                    </select>
                  </label>

                  <label className="setting-row">
                    <span>Right type</span>
                    <select
                      value={activeComputedDraft.rightKind}
                      onChange={e => updateActiveComputedDraft({ rightKind: e.target.value as 'column' | 'constant' })}
                      aria-label="Right operand type"
                    >
                      <option value="column">Column</option>
                      <option value="constant">Constant</option>
                    </select>
                  </label>

                  <label className="setting-row">
                    <span>Right value</span>
                    {activeComputedDraft.rightKind === 'column' ? (
                      <select
                        value={activeComputedDraft.rightColumn}
                        onChange={e => updateActiveComputedDraft({ rightColumn: e.target.value })}
                        aria-label="Right numeric column"
                      >
                        {activeComputedNumericColumns.map(column => (
                          <option key={column} value={column}>{column}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={activeComputedDraft.rightConstant}
                        onChange={e => updateActiveComputedDraft({ rightConstant: e.target.value })}
                        placeholder="1"
                        aria-label="Right constant"
                      />
                    )}
                  </label>
                </section>

                <div className="computed-expression-preview">
                  {activeComputedDraft.outputName.trim() || 'new_column'} = {activeComputedDraft.leftKind === 'column' ? activeComputedDraft.leftColumn : activeComputedDraft.leftConstant || '?'} {activeComputedDraft.operator} {activeComputedDraft.rightKind === 'column' ? activeComputedDraft.rightColumn : activeComputedDraft.rightConstant || '?'}
                </div>

                <div className="setting-actions computed-column-actions">
                  <button className="btn btn-primary" onClick={addActiveComputedColumn}>
                    Add computed column
                  </button>
                  <button className="btn" onClick={cancelActiveComputed}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        ) : null}

        <div className="compile-controls">
          <label className="field-label">
            <span>Duplicate ID policy</span>
            <select
              value={duplicateIdPolicy}
              onChange={e => setDuplicateIdPolicy(e.target.value as DuplicateIdPolicy)}
            >
              <option value="rename">Rename duplicates</option>
              <option value="skip">Skip duplicates</option>
              <option value="block">Block compile</option>
            </select>
          </label>

          <label className="field-label">
            <span>Column conflict policy</span>
            <select
              value={columnConflictPolicy}
              onChange={e => setColumnConflictPolicy(e.target.value as ColumnConflictPolicy)}
            >
              <option value="block">Block compile</option>
              <option value="merge">Auto-merge by name</option>
              <option value="suffix">Auto-suffix names</option>
            </select>
          </label>

          <button className="btn-primary" onClick={() => compileSources()} disabled={compileBusy || stagedSources.length === 0}>
            {compileBusy ? 'Compiling...' : 'Compile dataset'}
          </button>
        </div>

        {ds ? (
          <div className="compiled-data-grid" style={{ gridTemplateColumns: `minmax(0, 1fr) 8px ${filterPanelWidth}px` }}>
            <div className="compiled-data-table">
              <div className="compiled-data-header">
                <div>
                  <div className="field-title">Current compiled data</div>
                  <div className="legend">
                    This table reflects the active global filters.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    className="btn btn-sm"
                    onClick={showCompiledComputedColumnEditor}
                    disabled={numericScalarColumns(fullDataset || ds).length === 0}
                    title={numericScalarColumns(fullDataset || ds).length === 0 ? 'No numeric scalar columns available' : 'Add computed column'}
                  >
                    <PlusCircle size={14} />
                    Computed
                  </button>
                  <button
                    className="btn btn-sm compiled-summary-toggle"
                    onClick={() => setSummaryExpanded(v => !v)}
                    aria-expanded={summaryExpanded}
                  >
                    {summaryExpanded ? 'Hide details' : 'Show details'}
                  </button>
                </div>
              </div>
              {summaryExpanded && (
                <div className="compiled-summary-dropdown compiled-summary-dropdown-table">
                  <div className="compiled-summary-section">
                    <div className="field-title" style={{ fontSize: 'var(--text-xs)' }}>Rows per source</div>
                    <table className="compiled-summary-table">
                      <thead><tr><th>Source</th><th>Rows</th><th>%</th></tr></thead>
                      <tbody>
                        {sourceCounts.map(({ label, count, pct }) => (
                          <tr key={label}>
                            <td>{label}</td>
                            <td>{count.toLocaleString()}</td>
                            <td>{pct.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="compiled-summary-section">
                    <div className="field-title" style={{ fontSize: 'var(--text-xs)' }}>Column coverage per source</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table className="compiled-summary-table">
                        <thead>
                          <tr>
                            <th>Column</th>
                            {sourceCounts.map(s => <th key={s.label}>{s.label}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {Object.keys(ds.columns).map(col => (
                            <tr key={col}>
                              <td>{col}</td>
                              {sourceCounts.map(s => (
                                <td key={s.label} style={{ textAlign: 'center' }}>
                                  {coverageMap[s.label]?.has(col) ? '✓' : '—'}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {numericStats.length > 0 && (
                    <div className="compiled-summary-section">
                      <div className="field-title" style={{ fontSize: 'var(--text-xs)' }}>Numeric column stats</div>
                      <table className="compiled-summary-table">
                        <thead><tr><th>Column</th><th>Min</th><th>Max</th><th>Mean</th></tr></thead>
                        <tbody>
                          {numericStats.map(({ col, min, max, mean }) => (
                            <tr key={col}>
                              <td>{col}</td>
                              <td>{min.toPrecision(4)}</td>
                              <td>{max.toPrecision(4)}</td>
                              <td>{mean.toPrecision(4)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
              <DataTable />
            </div>

            <div className="split-divider" onMouseDown={startFilterDrag} />

            <div className="compiled-filter-panel">
              <div className="compiled-data-header">
                <div>
                  <div className="field-title">Filters</div>
                  <div className="legend">
                    Shared with Visualization and permanent filtering.
                  </div>
                </div>
              </div>
              <div className="compiled-filter-body">
                <DatasetFilterPanel showPermanentActions />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <DownloadDatasetSection />

      {compileMsg && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(3px)',
            zIndex: 9999,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--border-bright)',
              borderRadius: 14,
              padding: '16px 20px',
              minWidth: 340,
              maxWidth: 540,
              color: 'var(--fg)',
              boxShadow: 'var(--shadow-lg)',
              textAlign: 'center',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{compileMsg}</div>
            {compileDetail ? (
              <div style={{ color: 'var(--fg-dim)', fontSize: 13, marginBottom: 12 }}>
                {compileDetail}
              </div>
            ) : null}
            <div style={{ textAlign: 'left' }}>
              <div
                style={{
                  height: 10,
                  borderRadius: 999,
                  border: '1px solid var(--border)',
                  background: '#0f141b',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.max(0, Math.min(100, compileProgress))}%`,
                    background: 'linear-gradient(90deg, #1aa3ff, #5dd6ff)',
                    transition: 'width 120ms linear',
                  }}
                />
              </div>
              <div style={{ marginTop: 6, color: 'var(--fg-dim)', fontSize: 12 }}>
                {Math.round(compileProgress)}%
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default React.memo(ManagementPage)
