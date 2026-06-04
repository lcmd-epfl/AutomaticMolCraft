import type {
  AtomPropertyRecord,
  Column,
  Dataset,
  DescriptorRecord,
  MolecularVectorRecord,
} from '../models/dataModel'
import type { DatasetSource } from './xyzLoader'

export type StagedSourceKind = 'uploaded_csv' | 'ase' | 'generated' | 'compiled_locked' | 'optimization_result'

export type StagedColumn = {
  original: string
  draftName: string
  included: boolean
  origin?: 'source' | 'computed'
}

export type ComputedOperand =
  | { kind: 'column'; column: string }
  | { kind: 'constant'; value: string }

export type ComputedOperator = '+' | '-' | '*' | '/'

export type ComputedColumnDefinition = {
  id: string
  name: string
  left: ComputedOperand
  operator: ComputedOperator
  right: ComputedOperand
}

export type StagedSource = {
  id: string
  kind: StagedSourceKind
  label: string
  dataset: Dataset
  source: DatasetSource | null
  xyzById?: Record<string, string>
  columns: StagedColumn[]
  included: boolean
  locked?: boolean
  warnings?: string[]
  computedColumns?: ComputedColumnDefinition[]
  subsampleN?: number | null
  subsampleSeed?: number | null
}

export type DuplicateIdPolicy = 'rename' | 'skip' | 'block'
export type ColumnConflictPolicy = 'block' | 'merge' | 'suffix'

export type CompileOptions = {
  duplicateIdPolicy: DuplicateIdPolicy
  columnConflictPolicy: ColumnConflictPolicy
}

export type CompileIssue = {
  sourceId?: string
  message: string
}

export type CompileResult =
  | { ok: true; dataset: Dataset; xyzById: Record<string, string>; warnings: string[] }
  | { ok: false; issues: CompileIssue[] }

const SOURCE_COLUMN = 'data_source'

function columnOrder(ds: Dataset) {
  const order = ds.columnOrder && ds.columnOrder.length ? ds.columnOrder : Object.keys(ds.columns)
  const vectorNames = vectorRecordNames(ds)
  return Array.from(new Set([...order, ...vectorNames]))
}

function sourceValues(ds: Dataset, label: string) {
  const values = ds.columns[SOURCE_COLUMN]
  if (!values) return ds.ids.map(() => label)
  return Array.from(values as any).map(v => {
    const s = String(v ?? '').trim()
    return s || label
  })
}

function hasColumn(ds: Dataset, name: string) {
  return Object.prototype.hasOwnProperty.call(ds.columns, name) || isVector(ds, name)
}

function isNumeric(ds: Dataset, name: string) {
  return (ds.meta.numericColumns || []).includes(name)
}

function computedColumnFor(source: StagedSource, id: string) {
  return (source.computedColumns || []).find(column => column.id === id)
}

function isComputedColumn(source: StagedSource, name: string) {
  return Boolean(computedColumnFor(source, name))
}

function hasVectorLabels(ds: Dataset, name: string) {
  const values = ds.columns?.[name] as any
  if (!values || typeof values.length !== 'number') return false
  for (let i = 0; i < values.length; i++) {
    const value = String(values[i] ?? '').trim()
    if (value) return /^vec\[\d+\]$/.test(value) || value === 'vec'
  }
  return false
}

function isVector(ds: Dataset, name: string) {
  return (
    (ds.meta.vectorColumns || []).includes(name)
    || Boolean(ds.descriptors?.[name])
    || Boolean(ds.molecularVectors?.[name])
    || Boolean(ds.atomProperties?.[name])
    || hasVectorLabels(ds, name)
  )
}

function normalizeName(name: string) {
  return String(name).trim().toLowerCase()
}

function columnNameKey(name: string) {
  return String(name).trim()
}

function cloneValue(value: any) {
  if (value === undefined) return null
  return value
}

function numericValue(value: any) {
  if (value === null || value === undefined || value === '') return Number.NaN
  const n = Number(value)
  return Number.isFinite(n) ? n : Number.NaN
}

function parseConstant(value: string) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function makeUnique(base: string, used: Set<string>) {
  if (!used.has(columnNameKey(base))) {
    used.add(columnNameKey(base))
    return base
  }

  let i = 2
  while (used.has(columnNameKey(`${base}_${i}`))) i += 1
  const out = `${base}_${i}`
  used.add(columnNameKey(out))
  return out
}

function makeUniqueId(id: string, used: Set<string>) {
  if (!used.has(id)) {
    used.add(id)
    return id
  }

  let i = 2
  while (used.has(`${id}_${i}`)) i += 1
  const out = `${id}_${i}`
  used.add(out)
  return out
}

function vectorRecordNames(ds: Dataset): string[] {
  return [
    ...Object.keys(ds.descriptors || {}),
    ...Object.keys(ds.molecularVectors || {}),
    ...Object.keys(ds.atomProperties || {}),
  ]
}

function describeOperand(operand: ComputedOperand) {
  return operand.kind === 'column' ? `column '${operand.column}'` : `constant '${operand.value}'`
}

function validateComputedOperand(source: StagedSource, computed: ComputedColumnDefinition, operand: ComputedOperand): string | null {
  if (operand.kind === 'constant') {
    return parseConstant(operand.value) == null
      ? `Computed column '${computed.name}' has a non-finite ${describeOperand(operand)}.`
      : null
  }

  if (!operand.column) return `Computed column '${computed.name}' needs a column operand.`
  if (!hasColumn(source.dataset, operand.column)) {
    return `Computed column '${computed.name}' references missing column '${operand.column}'.`
  }
  if (!isNumeric(source.dataset, operand.column)) {
    return `Computed column '${computed.name}' references non-numeric column '${operand.column}'.`
  }
  if (isVector(source.dataset, operand.column)) {
    return `Computed column '${computed.name}' references vector column '${operand.column}'.`
  }
  return null
}

function computedOperandValue(dataset: Dataset, operand: ComputedOperand, row: number) {
  if (operand.kind === 'constant') return parseConstant(operand.value) ?? Number.NaN
  return numericValue((dataset.columns[operand.column] as any)?.[row])
}

function evaluateComputedColumn(dataset: Dataset, computed: ComputedColumnDefinition): Float32Array {
  const out = new Float32Array(dataset.ids.length)
  for (let row = 0; row < dataset.ids.length; row++) {
    const left = computedOperandValue(dataset, computed.left, row)
    const right = computedOperandValue(dataset, computed.right, row)
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      out[row] = Number.NaN
      continue
    }
    if (computed.operator === '+') out[row] = left + right
    else if (computed.operator === '-') out[row] = left - right
    else if (computed.operator === '*') out[row] = left * right
    else out[row] = right === 0 ? Number.NaN : left / right
  }
  return out
}

function materializeComputedColumns(source: StagedSource): StagedSource {
  if (!source.computedColumns?.length) return source

  const columns: Record<string, Column> = { ...source.dataset.columns }
  const numericColumns = new Set(source.dataset.meta.numericColumns || [])
  const categoricalColumns = (source.dataset.meta.categoricalColumns || []).filter(name => (
    !source.computedColumns?.some(computed => computed.id === name)
  ))
  const columnOrderBase = source.dataset.columnOrder && source.dataset.columnOrder.length
    ? source.dataset.columnOrder
    : Object.keys(source.dataset.columns)
  const columnOrder = columnOrderBase.filter(name => (
    !source.computedColumns?.some(computed => computed.id === name)
  ))

  for (const computed of source.computedColumns) {
    columns[computed.id] = evaluateComputedColumn(source.dataset, computed)
    numericColumns.add(computed.id)
    if (!columnOrder.includes(computed.id)) columnOrder.push(computed.id)
  }

  return {
    ...source,
    dataset: {
      ...source.dataset,
      columns,
      meta: {
        ...source.dataset.meta,
        numericColumns: Array.from(numericColumns),
        categoricalColumns,
      },
      columnOrder,
    },
  }
}

function getXyz(xyzById: Record<string, string> | undefined, id: string) {
  if (!xyzById) return ''
  const stem = String(id).trim().replace(/\.xyz$/i, '')
  return xyzById[id] || xyzById[stem] || xyzById[`${stem}.xyz`] || ''
}

function emptyDataset(): Dataset {
  return {
    ids: [],
    columns: { [SOURCE_COLUMN]: [] },
    meta: { numericColumns: [], categoricalColumns: [SOURCE_COLUMN] },
    columnOrder: [SOURCE_COLUMN],
  }
}

function makeLcgRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

export function subsampleDataset(dataset: Dataset, n: number, seed?: number | null): Dataset {
  if (n >= dataset.ids.length) return dataset
  const m = dataset.ids.length
  const indices = Array.from({ length: m }, (_, i) => i)
  const rng = seed != null ? makeLcgRandom(seed) : Math.random.bind(Math)
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (m - i))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  const selected = indices.slice(0, n).sort((a, b) => a - b)
  const selectedIds = new Set(selected.map(i => dataset.ids[i]))
  const newIds = selected.map(i => dataset.ids[i])

  const newColumns: Record<string, Column> = {}
  for (const [key, col] of Object.entries(dataset.columns)) {
    if (col instanceof Float32Array) {
      const arr = new Float32Array(n)
      selected.forEach((si, di) => { arr[di] = (col as Float32Array)[si] })
      newColumns[key] = arr
    } else if (col instanceof Int32Array) {
      const arr = new Int32Array(n)
      selected.forEach((si, di) => { arr[di] = (col as Int32Array)[si] })
      newColumns[key] = arr
    } else {
      newColumns[key] = selected.map(i => (col as string[])[i])
    }
  }

  function filterRecord<T extends { valuesById: Record<string, any>; missingIds: string[] }>(r: T): T {
    const vb: Record<string, any> = {}
    for (const id of selectedIds) if (r.valuesById[id] !== undefined) vb[id] = r.valuesById[id]
    return { ...r, valuesById: vb, missingIds: newIds.filter(id => !vb[id]) }
  }

  return {
    ids: newIds,
    columns: newColumns,
    meta: { ...dataset.meta },
    columnOrder: dataset.columnOrder,
    descriptors: dataset.descriptors
      ? Object.fromEntries(Object.entries(dataset.descriptors).map(([k, v]) => [k, filterRecord(v)]))
      : undefined,
    molecularVectors: dataset.molecularVectors
      ? Object.fromEntries(Object.entries(dataset.molecularVectors).map(([k, v]) => [k, filterRecord(v)]))
      : undefined,
    atomProperties: dataset.atomProperties
      ? Object.fromEntries(Object.entries(dataset.atomProperties).map(([k, v]) => [k, filterRecord(v)]))
      : undefined,
  }
}

export function createStagedSource(input: {
  kind: StagedSourceKind
  label: string
  dataset: Dataset
  source: DatasetSource | null
  xyzById?: Record<string, string>
  locked?: boolean
}): StagedSource {
  const id = `${input.kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const columns = columnOrder(input.dataset)
    .filter(c => c !== SOURCE_COLUMN)
    .filter(c => hasColumn(input.dataset, c))
    .map(c => ({ original: c, draftName: c, included: true, origin: 'source' as const }))

  return {
    id,
    kind: input.kind,
    label: input.label,
    dataset: input.dataset,
    source: input.source,
    xyzById: input.xyzById,
    columns,
    included: true,
    locked: input.locked,
    warnings: [],
  }
}

export function validateStagedSources(sources: StagedSource[]): CompileIssue[] {
  const issues: CompileIssue[] = []
  const included = sources.filter(s => s.included)
  const labels = new Map<string, string>()

  if (included.length === 0) {
    issues.push({ message: 'Select at least one source to compile.' })
  }

  for (const source of included) {
    const label = source.label.trim()
    if (!label) {
      issues.push({ sourceId: source.id, message: 'Source label is required.' })
    } else {
      const key = normalizeName(label)
      const existing = labels.get(key)
      if (existing && existing !== source.id) {
        issues.push({ sourceId: source.id, message: `Duplicate source label '${label}'.` })
      }
      labels.set(key, source.id)
    }

    if (source.dataset.ids.length === 0) {
      issues.push({ sourceId: source.id, message: 'Source has no rows.' })
    }

    if (source.columns.length > 0 && !source.columns.some(c => c.included)) {
      issues.push({ sourceId: source.id, message: 'Select at least one column.' })
    }

    const names = new Map<string, string>()
    for (const column of source.columns.filter(c => c.included)) {
      const name = column.draftName.trim()
      if (!name) {
        issues.push({ sourceId: source.id, message: `Column '${column.original}' needs an output name.` })
      }
      const key = columnNameKey(name)
      const prior = names.get(key)
      if (prior && prior !== column.original) {
        issues.push({ sourceId: source.id, message: `Duplicate output column '${name}' inside this source.` })
      }
      names.set(key, column.original)
      if (isComputedColumn(source, column.original)) {
        continue
      }
      if (!hasColumn(source.dataset, column.original)) {
        issues.push({ sourceId: source.id, message: `Column '${column.original}' is missing from source data.` })
      }
    }

    for (const computed of source.computedColumns || []) {
      const column = source.columns.find(c => c.original === computed.id)
      if (!column) {
        issues.push({ sourceId: source.id, message: `Computed column '${computed.name}' is missing from the staged column list.` })
      }
      const outputName = (column?.draftName || computed.name).trim()
      if (!outputName) {
        issues.push({ sourceId: source.id, message: `Computed column '${computed.name}' needs an output name.` })
      }
      const leftIssue = validateComputedOperand(source, computed, computed.left)
      if (leftIssue) issues.push({ sourceId: source.id, message: leftIssue })
      const rightIssue = validateComputedOperand(source, computed, computed.right)
      if (rightIssue) issues.push({ sourceId: source.id, message: rightIssue })
    }
  }

  return issues
}

export function compileStagedSources(
  sources: StagedSource[],
  options: CompileOptions
): CompileResult {
  const issues = validateStagedSources(sources)
  const includedSources = sources.filter(s => s.included).map(source => {
    const n = source.subsampleN
    if (n == null || n >= source.dataset.ids.length) return materializeComputedColumns(source)
    const sampledDataset = subsampleDataset(source.dataset, n, source.subsampleSeed)
    const sampledIdSet = new Set(sampledDataset.ids)
    const sampledXyzById = source.xyzById
      ? Object.fromEntries(Object.entries(source.xyzById).filter(([id]) => sampledIdSet.has(id)))
      : source.xyzById
    return materializeComputedColumns({ ...source, dataset: sampledDataset, xyzById: sampledXyzById })
  })

  const requestedNames = new Map<string, number>()
  for (const source of includedSources) {
    for (const column of source.columns.filter(c => c.included)) {
      const key = columnNameKey(column.draftName)
      requestedNames.set(key, (requestedNames.get(key) || 0) + 1)
    }
  }

  if (options.columnConflictPolicy === 'block') {
    for (const [key, count] of requestedNames.entries()) {
      if (count > 1) {
        issues.push({ message: `Column output name '${key}' is used by multiple sources.` })
      }
    }
  }

  const seenIds = new Set<string>()
  for (const source of includedSources) {
    for (const id of source.dataset.ids) {
      if (seenIds.has(id) && options.duplicateIdPolicy === 'block') {
        issues.push({ sourceId: source.id, message: `Duplicate molecule ID '${id}'.` })
        break
      }
      seenIds.add(id)
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  if (includedSources.length === 0) return { ok: true, dataset: emptyDataset(), xyzById: {}, warnings: [] }

  const finalColumnFor = new Map<string, string>()
  const usedColumnNames = new Set<string>([columnNameKey(SOURCE_COLUMN)])
  const warnings: string[] = []

  for (const source of includedSources) {
    for (const column of source.columns.filter(c => c.included)) {
      const requested = column.draftName.trim()
      const key = `${source.id}:${column.original}`
      if (options.columnConflictPolicy === 'merge') {
        finalColumnFor.set(key, requested)
        usedColumnNames.add(columnNameKey(requested))
      } else if (options.columnConflictPolicy === 'suffix') {
        finalColumnFor.set(key, makeUnique(requested, usedColumnNames))
      } else {
        finalColumnFor.set(key, requested)
        usedColumnNames.add(columnNameKey(requested))
      }
    }
  }

  const finalColumns = Array.from(new Set(finalColumnFor.values()))
  const numericByColumn = new Map<string, boolean>()
  for (const name of finalColumns) numericByColumn.set(name, true)
  const vectorColumns = new Set<string>()

  for (const source of includedSources) {
    for (const column of source.columns.filter(c => c.included)) {
      const finalName = finalColumnFor.get(`${source.id}:${column.original}`)!
      if (isVector(source.dataset, column.original)) vectorColumns.add(finalName)
      if (!isNumeric(source.dataset, column.original)) numericByColumn.set(finalName, false)
    }
  }

  const outIds: string[] = []
  const outSourceValues: string[] = []
  const outValues = new Map<string, any[]>()
  for (const name of finalColumns) outValues.set(name, [])

  const usedIds = new Set<string>()
  const xyzById: Record<string, string> = {}
  const descriptors: Record<string, DescriptorRecord> = {}
  const molecularVectors: Record<string, MolecularVectorRecord> = {}
  const atomProperties: Record<string, AtomPropertyRecord> = {}
  const finalRecordNameFor = new Map<string, string>()
  const usedRecordNames = new Set<string>()

  for (const source of includedSources) {
    for (const name of vectorRecordNames(source.dataset)) {
      const key = `${source.id}:${name}`
      const includedColumn = source.columns.find(column => (
        column.included && column.original === name
      ))
      const finalColumnName = includedColumn
        ? finalColumnFor.get(`${source.id}:${includedColumn.original}`)
        : null

      if (finalColumnName) {
        finalRecordNameFor.set(key, finalColumnName)
        usedRecordNames.add(columnNameKey(finalColumnName))
      } else {
        finalRecordNameFor.set(key, makeUnique(name, usedRecordNames))
      }
    }
  }

  function copyVectorRecord(
    target: Record<string, any>,
    sourceId: string,
    record: any,
    originalId: string,
    finalId: string
  ) {
    const finalName = finalRecordNameFor.get(`${sourceId}:${record.name}`)
    if (!finalName || !Array.isArray(record.valuesById?.[originalId])) return

    if (!target[finalName]) {
      target[finalName] = {
        ...record,
        name: finalName,
        valuesById: {},
        missingIds: [],
      }
    }
    target[finalName].valuesById[finalId] = record.valuesById[originalId]
  }

  for (const source of includedSources) {
    const sourceLabel = source.label.trim() || 'dataset_1'
    const originalSourceValues = source.locked
      ? sourceValues(source.dataset, sourceLabel)
      : source.dataset.ids.map(() => sourceLabel)

    for (let row = 0; row < source.dataset.ids.length; row++) {
      const originalId = String(source.dataset.ids[row])
      let finalId = originalId

      if (usedIds.has(originalId)) {
        if (options.duplicateIdPolicy === 'skip') {
          warnings.push(`Skipped duplicate molecule '${originalId}'.`)
          continue
        }
        finalId = makeUniqueId(originalId, usedIds)
        warnings.push(`Renamed duplicate molecule '${originalId}' to '${finalId}'.`)
      } else {
        usedIds.add(originalId)
      }

      outIds.push(finalId)
      outSourceValues.push(source.locked ? originalSourceValues[row] : sourceLabel)

      for (const name of finalColumns) outValues.get(name)!.push(null)

      for (const column of source.columns.filter(c => c.included)) {
        const finalName = finalColumnFor.get(`${source.id}:${column.original}`)!
        const values = outValues.get(finalName)!
        if (isVector(source.dataset, column.original) && !Object.prototype.hasOwnProperty.call(source.dataset.columns, column.original)) {
          const record = (source.dataset.descriptors || {})[column.original]
            || (source.dataset.molecularVectors || {})[column.original]
            || (source.dataset.atomProperties || {})[column.original]
          values[values.length - 1] = Array.isArray(record?.valuesById?.[originalId]) ? 'vec' : null
        } else {
          values[values.length - 1] = cloneValue((source.dataset.columns[column.original] as any)[row])
        }
      }

      const xyz = getXyz(source.xyzById, originalId)
      if (xyz) xyzById[finalId] = xyz
      else warnings.push(`No XYZ found for molecule '${originalId}'.`)

      for (const record of Object.values(source.dataset.descriptors || {})) {
        copyVectorRecord(descriptors, source.id, record, originalId, finalId)
      }
      for (const record of Object.values(source.dataset.molecularVectors || {})) {
        copyVectorRecord(molecularVectors, source.id, record, originalId, finalId)
      }
      for (const record of Object.values(source.dataset.atomProperties || {})) {
        copyVectorRecord(atomProperties, source.id, record, originalId, finalId)
      }
    }
  }

  const columns: Record<string, Column> = {
    [SOURCE_COLUMN]: outSourceValues,
  }
  const numericColumns: string[] = []
  const categoricalColumns: string[] = [SOURCE_COLUMN]

  for (const name of finalColumns) {
    const values = outValues.get(name) || []
    if (vectorColumns.has(name)) {
      columns[name] = values.map(v => (v === null || v === undefined ? '' : String(v)))
    } else if (numericByColumn.get(name)) {
      columns[name] = new Float32Array(values.map(numericValue))
      numericColumns.push(name)
    } else {
      columns[name] = values.map(v => (v === null || v === undefined ? '' : String(v)))
      categoricalColumns.push(name)
    }
  }

  for (const record of Object.values(descriptors)) {
    record.missingIds = outIds.filter(id => !Array.isArray(record.valuesById[id]))
  }
  for (const record of Object.values(molecularVectors)) {
    record.missingIds = outIds.filter(id => !Array.isArray(record.valuesById[id]))
  }
  for (const record of Object.values(atomProperties)) {
    record.missingIds = outIds.filter(id => !Array.isArray(record.valuesById[id]))
  }
  for (const name of Object.keys(descriptors)) vectorColumns.add(name)
  for (const name of Object.keys(molecularVectors)) vectorColumns.add(name)
  for (const name of Object.keys(atomProperties)) vectorColumns.add(name)

  const dataset: Dataset = {
    ids: outIds,
    columns,
    meta: { numericColumns, categoricalColumns, vectorColumns: Array.from(vectorColumns) },
    columnOrder: [SOURCE_COLUMN, ...finalColumns],
  }
  if (Object.keys(descriptors).length) dataset.descriptors = descriptors
  if (Object.keys(molecularVectors).length) dataset.molecularVectors = molecularVectors
  if (Object.keys(atomProperties).length) dataset.atomProperties = atomProperties

  return {
    ok: true,
    dataset,
    xyzById,
    warnings,
  }
}
