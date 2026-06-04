import type { Column, Dataset, DescriptorRecord } from '../models/dataModel'

export type DuplicateIdMode = 'skip' | 'rename'

export type MergeColumnRule = {
  incomingColumn: string
  targetColumn?: string
  action: 'auto' | 'map' | 'create' | 'skip'
}

export type MergeDatasetsInput = {
  base: Dataset
  incoming: Dataset
  baseLabel?: string
  incomingLabel: string
  duplicateIdMode: DuplicateIdMode
  columnRules?: MergeColumnRule[]
  baseXyzById?: Record<string, string>
  incomingXyzById?: Record<string, string>
}

export type MergeDatasetsResult = {
  dataset: Dataset
  xyzById: Record<string, string>
  warnings: string[]
  duplicateIds: string[]
  skippedDuplicateIds: string[]
  renamedIds: Array<{ from: string; to: string }>
}

const SOURCE_COLUMN = 'data_source'

function normName(s: string) {
  return String(s).trim().toLowerCase()
}

function toArray(col: Column | undefined, n: number): any[] {
  if (!col) return Array(n).fill(null)
  return Array.from(col as any)
}

function isNumericColumn(ds: Dataset, name: string) {
  return (ds.meta.numericColumns || []).some(c => c === name)
}

function isCategoricalColumn(ds: Dataset, name: string) {
  return (ds.meta.categoricalColumns || []).some(c => c === name)
}

function makeUniqueId(id: string, used: Set<string>) {
  if (!used.has(id)) return id

  let k = 2
  while (used.has(`${id}_${k}`)) k += 1
  return `${id}_${k}`
}

function makeUniqueColumnName(name: string, existingLower: Set<string>) {
  if (!existingLower.has(normName(name))) return name

  let k = 2
  while (existingLower.has(normName(`${name}_${k}`))) k += 1
  return `${name}_${k}`
}

function numericValue(v: any) {
  if (v === null || v === undefined || v === '') return Number.NaN
  const n = Number(v)
  return Number.isFinite(n) ? n : Number.NaN
}

function categoricalValue(v: any) {
  if (v === null || v === undefined) return ''
  return String(v)
}

function buildColumnOrder(base: Dataset, mergedColumns: Record<string, Column>) {
  const baseOrder =
    base.columnOrder && base.columnOrder.length
      ? base.columnOrder
      : Object.keys(base.columns)

  const out: string[] = []

  for (const c of baseOrder) {
    if (mergedColumns[c] && !out.includes(c)) out.push(c)
  }

  for (const c of Object.keys(mergedColumns)) {
    if (!out.includes(c)) out.push(c)
  }

  return out
}

export function planMergeColumns(base: Dataset, incoming: Dataset) {
  const baseColumns = base.columnOrder?.length ? base.columnOrder : Object.keys(base.columns)
  const incomingColumns = incoming.columnOrder?.length ? incoming.columnOrder : Object.keys(incoming.columns)

  const baseByLower = new Map(baseColumns.map(c => [normName(c), c]))

  const autoMatches: Array<{ incomingColumn: string; targetColumn: string }> = []
  const newColumns: string[] = []

  for (const incomingColumn of incomingColumns) {
    const match = baseByLower.get(normName(incomingColumn))
    if (match) autoMatches.push({ incomingColumn, targetColumn: match })
    else newColumns.push(incomingColumn)
  }

  const duplicateIds = incoming.ids.filter(id => new Set(base.ids).has(id))

  return {
    baseColumns,
    incomingColumns,
    autoMatches,
    newColumns,
    duplicateIds,
  }
}

export function mergeDatasets(input: MergeDatasetsInput): MergeDatasetsResult {
  const {
    base,
    incoming,
    baseLabel = 'Original',
    incomingLabel,
    duplicateIdMode,
    columnRules = [],
    baseXyzById = {},
    incomingXyzById = {},
  } = input

  const warnings: string[] = []
  const duplicateIds: string[] = []
  const skippedDuplicateIds: string[] = []
  const renamedIds: Array<{ from: string; to: string }> = []

  const baseN = base.ids.length
  const incomingN = incoming.ids.length

  const baseColumns = base.columnOrder?.length ? base.columnOrder : Object.keys(base.columns)
  const incomingColumns =
    incoming.columnOrder?.length ? incoming.columnOrder : Object.keys(incoming.columns)

  const baseColumnByLower = new Map(baseColumns.map(c => [normName(c), c]))
  const existingLower = new Set(baseColumns.map(normName))

  const ruleByIncoming = new Map<string, MergeColumnRule>()
  for (const rule of columnRules) {
    ruleByIncoming.set(rule.incomingColumn, rule)
  }

  const usedIds = new Set(base.ids)
  const incomingIndexToFinalId = new Map<number, string>()

  for (let i = 0; i < incomingN; i++) {
    const originalId = incoming.ids[i]

    if (usedIds.has(originalId)) {
      duplicateIds.push(originalId)

      if (duplicateIdMode === 'skip') {
        skippedDuplicateIds.push(originalId)
        continue
      }

      const renamed = makeUniqueId(originalId, usedIds)
      usedIds.add(renamed)
      incomingIndexToFinalId.set(i, renamed)
      renamedIds.push({ from: originalId, to: renamed })
    } else {
      usedIds.add(originalId)
      incomingIndexToFinalId.set(i, originalId)
    }
  }

  const keptIncomingIndices = Array.from(incomingIndexToFinalId.keys())
  const finalIncomingIds = keptIncomingIndices.map(i => incomingIndexToFinalId.get(i)!)

  const mergedIds = [...base.ids, ...finalIncomingIds]

  const incomingTargetByColumn = new Map<string, string>()

  for (const incomingColumn of incomingColumns) {
    if (incomingColumn === SOURCE_COLUMN) continue

    const rule = ruleByIncoming.get(incomingColumn)

    if (rule?.action === 'skip') continue

    if (rule?.action === 'map' && rule.targetColumn) {
      incomingTargetByColumn.set(incomingColumn, rule.targetColumn)
      continue
    }

    if (rule?.action === 'create') {
      const requested = rule.targetColumn || incomingColumn
      const unique = makeUniqueColumnName(requested, existingLower)
      existingLower.add(normName(unique))
      incomingTargetByColumn.set(incomingColumn, unique)
      continue
    }

    const autoTarget = baseColumnByLower.get(normName(incomingColumn))

    if (autoTarget) {
      incomingTargetByColumn.set(incomingColumn, autoTarget)
    } else {
      const unique = makeUniqueColumnName(incomingColumn, existingLower)
      existingLower.add(normName(unique))
      incomingTargetByColumn.set(incomingColumn, unique)
    }
  }

  const targetColumns = new Set<string>()
  for (const c of baseColumns) targetColumns.add(c)
  for (const target of incomingTargetByColumn.values()) targetColumns.add(target)
  targetColumns.add(SOURCE_COLUMN)

  const mergedColumns: Record<string, Column> = {}
  const numericColumns: string[] = []
  const categoricalColumns: string[] = []

  for (const targetColumn of targetColumns) {

	if (targetColumn === SOURCE_COLUMN) {
	  const existingSourceValues =
	    base.columns[SOURCE_COLUMN]
	      ? Array.from(base.columns[SOURCE_COLUMN] as any).map(v => {
	          const s = String(v ?? '').trim()
	          return s || baseLabel
	        })
	      : Array(baseN).fill(baseLabel)
	
	  mergedColumns[targetColumn] = [
	    ...existingSourceValues,
	    ...Array(finalIncomingIds.length).fill(incomingLabel),
	  ]
	
	  categoricalColumns.push(targetColumn)
	  continue
	}


    const incomingSourceColumns = incomingColumns.filter(
      c => incomingTargetByColumn.get(c) === targetColumn
    )

    const incomingSourceColumn = incomingSourceColumns[0]
    if (incomingSourceColumns.length > 1) {
      warnings.push(
        `Multiple incoming columns mapped to '${targetColumn}'. Used '${incomingSourceColumn}' and ignored ${incomingSourceColumns
          .slice(1)
          .map(c => `'${c}'`)
          .join(', ')}.`
      )
    }

    const targetExistsInBase = Object.prototype.hasOwnProperty.call(base.columns, targetColumn)

    const numeric =
      targetExistsInBase
        ? isNumericColumn(base, targetColumn)
        : incomingSourceColumn
          ? isNumericColumn(incoming, incomingSourceColumn)
          : false

    const baseValues = targetExistsInBase
      ? toArray(base.columns[targetColumn], baseN)
      : Array(baseN).fill(null)

    const incomingRawValues = incomingSourceColumn
      ? toArray(incoming.columns[incomingSourceColumn], incomingN)
      : Array(incomingN).fill(null)

    const keptIncomingValues = keptIncomingIndices.map(i => incomingRawValues[i])

    if (numeric) {
      mergedColumns[targetColumn] = new Float32Array([
        ...baseValues.map(numericValue),
        ...keptIncomingValues.map(numericValue),
      ])
      numericColumns.push(targetColumn)
    } else {
      mergedColumns[targetColumn] = [
        ...baseValues.map(categoricalValue),
        ...keptIncomingValues.map(categoricalValue),
      ]
      categoricalColumns.push(targetColumn)
    }
  }

  const xyzById: Record<string, string> = {}

  for (const id of base.ids) {
    const xyz = baseXyzById[id]
    if (xyz) xyzById[id] = xyz
  }

  for (const incomingIndex of keptIncomingIndices) {
    const oldId = incoming.ids[incomingIndex]
    const newId = incomingIndexToFinalId.get(incomingIndex)!
    const xyz = incomingXyzById[oldId]

    if (xyz) {
      xyzById[newId] = xyz
    } else {
      warnings.push(`No XYZ found for incoming molecule '${oldId}'.`)
    }
  }

  const descriptors: Record<string, DescriptorRecord> = {}

  if (base.descriptors) {
    for (const [name, desc] of Object.entries(base.descriptors)) {
      descriptors[name] = {
        ...desc,
        missingIds: Array.from(
          new Set([...(desc.missingIds || []), ...finalIncomingIds])
        ),
      }
    }
  }

  const dataset: Dataset = {
    ids: mergedIds,
    columns: mergedColumns,
    meta: {
      numericColumns,
      categoricalColumns,
    },
    columnOrder: buildColumnOrder(base, mergedColumns),
    descriptors,
  }

  if (Object.keys(descriptors).length === 0) {
    delete dataset.descriptors
  }

  if (duplicateIds.length > 0) {
    warnings.push(
      `Found ${duplicateIds.length.toLocaleString()} duplicate IDs. ${
        duplicateIdMode === 'skip'
          ? `${skippedDuplicateIds.length.toLocaleString()} were skipped.`
          : `${renamedIds.length.toLocaleString()} were renamed.`
      }`
    )
  }

  return {
    dataset,
    xyzById,
    warnings,
    duplicateIds,
    skippedDuplicateIds,
    renamedIds,
  }
}
