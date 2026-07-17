import React, { useMemo, useState } from 'react'
import JSZip from 'jszip'
import { ChevronDown, ChevronRight, Download } from 'lucide-react'
import { useStore } from '../store/store'
import { useUIStore } from '../store/uiStore'
import type { Dataset } from '../models/dataModel'
import { resolveXyzByIds } from '../utils/xyzLoader'
import { BACKEND } from '../config'

const MAX_ZIP_ROWS = 5000
const ASE_EXPORTED_SOURCE_COLUMN = 'compiled_data_source'
type ExportScope = 'full' | 'filtered' | 'selected'

function valueToCsv(v: any) {
  if (v == null) return ''
  if (typeof v === 'number' && !Number.isFinite(v)) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function sanitizeFileName(s: string) {
  return String(s || 'molecule')
    .replace(/\.xyz$/i, '')
    .replace(/[^\w.-]+/g, '_')
}

function makeSubset(ds: Dataset, indices: number[]): Dataset {
  const columns: Dataset['columns'] = {}

  for (const [name, values] of Object.entries(ds.columns)) {
    const arr = Array.from(values as any)

    if (ds.meta.numericColumns.includes(name)) {
      const out = new Float32Array(indices.length)
      indices.forEach((idx, i) => {
        const n = Number(arr[idx])
        out[i] = Number.isFinite(n) ? n : NaN
      })
      columns[name] = out
    } else {
      columns[name] = indices.map(idx => {
        const v = arr[idx]
        return v == null ? '' : String(v)
      })
    }
  }

  return {
    ...ds,
    ids: indices.map(i => ds.ids[i]),
    columns,
    columnOrder: ds.columnOrder ? [...ds.columnOrder] : Object.keys(columns),
  }
}

function filterDatasetColumns(ds: Dataset, cols: Set<string>): Dataset {
  const columns: Dataset['columns'] = {}
  const colOrder = ds.columnOrder?.length ? ds.columnOrder : Object.keys(ds.columns)
  const kept: string[] = []

  for (const name of colOrder) {
    if (cols.has(name) && name in ds.columns) {
      columns[name] = ds.columns[name]
      kept.push(name)
    }
  }

  return {
    ...ds,
    columns,
    columnOrder: kept,
    meta: {
      ...ds.meta,
      numericColumns: ds.meta.numericColumns.filter(c => cols.has(c)),
    },
  }
}

function preferLegacyDataSouceForExport(ds: Dataset): Dataset {
  const legacySource = ds.columns.data_souce
  if (!legacySource) return ds

  return {
    ...ds,
    columns: {
      ...ds.columns,
      data_source: Array.from(legacySource as any).map(v => {
        const s = String(v ?? '').trim()
        return s
      }),
    },
    meta: {
      ...ds.meta,
      numericColumns: (ds.meta.numericColumns || []).filter(c => c !== 'data_source'),
      categoricalColumns: Array.from(
        new Set([...(ds.meta.categoricalColumns || []).filter(c => c !== 'data_source'), 'data_source'])
      ),
    },
    columnOrder: Array.from(
      new Set([
        'data_source',
        ...((ds.columnOrder && ds.columnOrder.length ? ds.columnOrder : Object.keys(ds.columns))
          .filter(c => c !== 'data_source')),
      ])
    ),
  }
}

// Vector records (descriptors / molecular vectors / atom properties) live in
// `valuesById` maps and only show a `vec[N]` placeholder string in `columns`.
// For export we expand each into real numeric columns `name_0..name_{dim-1}`
// so the data isn't lost as placeholder text.
function expandVectorRecordsForExport(ds: Dataset): Dataset {
  const records: Array<{ name: string; valuesById: Record<string, number[]>; dim?: number | null }> = [
    ...Object.values(ds.descriptors || {}),
    ...Object.values(ds.molecularVectors || {}),
    ...Object.values(ds.atomProperties || {}),
  ]
  if (records.length === 0) return ds

  const recordByName = new Map(records.map(r => [r.name, r]))
  const columns: Dataset['columns'] = {}
  const numericColumns = [...(ds.meta.numericColumns || [])]
  const baseOrder = ds.columnOrder?.length ? ds.columnOrder : Object.keys(ds.columns)
  const nextOrder: string[] = []

  const expandOne = (record: { name: string; valuesById: Record<string, number[]>; dim?: number | null }) => {
    const dim = record.dim
      ?? Object.values(record.valuesById).find(Array.isArray)?.length
      ?? 0
    for (let d = 0; d < dim; d++) {
      const colName = `${record.name}_${d}`
      const arr = new Float32Array(ds.ids.length)
      for (let i = 0; i < ds.ids.length; i++) {
        const vec = record.valuesById[ds.ids[i]]
        arr[i] = Array.isArray(vec) && Number.isFinite(vec[d]) ? vec[d] : NaN
      }
      columns[colName] = arr
      numericColumns.push(colName)
      nextOrder.push(colName)
    }
  }

  const expandedNames = new Set<string>()
  for (const name of baseOrder) {
    const record = recordByName.get(name)
    if (record) {
      expandOne(record)            // replace placeholder column with expanded numeric columns
      expandedNames.add(name)
    } else if (name in ds.columns) {
      columns[name] = ds.columns[name]
      nextOrder.push(name)
    }
  }
  // Records with no placeholder column in columnOrder but a real column entry
  // (legacy molecular vectors / atom properties) still get expanded; deselected
  // vectors are absent from `ds.columns` after column filtering and stay excluded.
  for (const record of records) {
    if (expandedNames.has(record.name)) continue
    if (record.name in ds.columns) expandOne(record)
  }

  return {
    ...ds,
    columns,
    columnOrder: nextOrder,
    meta: { ...ds.meta, numericColumns, vectorColumns: [] },
    descriptors: undefined,
    molecularVectors: undefined,
    atomProperties: undefined,
  }
}

function datasetToCsv(ds: Dataset) {
  const columns = ds.columnOrder?.length ? ds.columnOrder : Object.keys(ds.columns)
  const header = ['id', ...columns]
  const rows = [header.map(valueToCsv).join(',')]

  for (let i = 0; i < ds.ids.length; i++) {
    const row = [ds.ids[i]]

    for (const col of columns) {
      row.push((ds.columns[col] as any)?.[i])
    }

    rows.push(row.map(valueToCsv).join(','))
  }

  return rows.join('\n')
}

function makeUniqueColumnName(name: string, used: Set<string>) {
  if (!used.has(name)) return name
  let i = 2
  while (used.has(`${name}_${i}`)) i += 1
  return `${name}_${i}`
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function DownloadDatasetSection() {
  const dataset = useStore(s => s.dataset)
  const fullDataset = useStore(s => s.fullDataset)
  const source = useStore(s => s.source)
  const visibleIndices = useStore(s => s.visibleIndices)
  const selectedIndices = useStore(s => s.selectedIndices)
  const pushToast = useUIStore(s => s.pushToast)

  const [busy, setBusy] = useState<string | null>(null)
  const [progressText, setProgressText] = useState<string | null>(null)
  const [selectedScope, setSelectedScope] = useState<ExportScope>('full')
  const [filePrefix, setFilePrefix] = useState('')
  const [colPickerOpen, setColPickerOpen] = useState(false)
  const [includedCols, setIncludedCols] = useState<Set<string> | null>(null)

  const allColNames = useMemo(() => {
    if (!dataset) return [] as string[]
    const order = dataset.columnOrder?.length ? dataset.columnOrder : Object.keys(dataset.columns)
    return order.filter(c => c in dataset.columns)
  }, [dataset])

  if (!dataset || !fullDataset || !source) return null

  const effectiveIncluded: Set<string> = includedCols ?? new Set(allColNames)
  const includedCount = effectiveIncluded.size
  const selCount = selectedIndices?.length ?? 0

  const getBaseDataset = (): Dataset => {
    if (selectedScope === 'selected') {
      if (!selectedIndices || selectedIndices.length === 0) return fullDataset
      return makeSubset(fullDataset, Array.from(selectedIndices))
    }
    if (selectedScope === 'filtered') {
      if (!visibleIndices) return dataset
      return makeSubset(dataset, Array.from(visibleIndices))
    }
    return fullDataset
  }

  const getExportDataset = (): Dataset => {
    const base = getBaseDataset()
    const filtered =
      includedCols === null || includedCols.size === allColNames.length
        ? base
        : filterDatasetColumns(base, effectiveIncluded)
    return expandVectorRecordsForExport(preferLegacyDataSouceForExport(filtered))
  }

  const scopeSuffix =
    selectedScope === 'selected' ? 'selected'
    : selectedScope === 'filtered' ? 'filtered_view'
    : 'full_compiled'

  const prefixedName = (suffix: string) => {
    const p = filePrefix.trim() || 'compiled_dataset'
    return `${p}_${suffix}`
  }

  // Row count only — mirrors getBaseDataset() without deep-copying the dataset per render.
  const exportRowCount =
    selectedScope === 'selected'
      ? (selectedIndices && selectedIndices.length > 0 ? selectedIndices.length : fullDataset.ids.length)
      : selectedScope === 'filtered'
        ? (visibleIndices ? visibleIndices.length : dataset.ids.length)
        : fullDataset.ids.length
  const overZipLimit = exportRowCount > MAX_ZIP_ROWS

  const collectXyz = async (ds: Dataset) => {
    return resolveXyzByIds(ds.ids.map(String), source as any, {
      onProgress: count => {
        if (count % 50 === 0 || count === ds.ids.length) {
          setProgressText(`Resolving XYZ… ${count.toLocaleString()} / ${ds.ids.length.toLocaleString()}`)
        }
      },
    })
  }

  const downloadCsvOnly = async () => {
    const ds = getExportDataset()
    setBusy('csv')
    try {
      const csv = datasetToCsv(ds)
      downloadBlob(new Blob([csv], { type: 'text/csv' }), prefixedName(`${scopeSuffix}.csv`))
    } catch (err: any) {
      pushToast(err?.message || String(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const downloadCsvXyzZip = async () => {
    const ds = getExportDataset()

    if (ds.ids.length > MAX_ZIP_ROWS) {
      pushToast(
        `CSV+XYZ zip is limited to ${MAX_ZIP_ROWS.toLocaleString()} molecules. Use "CSV only" for larger exports.`,
        'warning'
      )
      return
    }

    setBusy('zip')
    setProgressText('Preparing…')

    try {
      const zip = new JSZip()
      zip.file('data.csv', datasetToCsv(ds))

      const xyzFolder = zip.folder('xyz')
      const xyzById = await collectXyz(ds)

      setProgressText('Building zip…')
      for (const id of ds.ids) {
        const xyz = xyzById[id]
        if (!xyz) continue
        xyzFolder?.file(`${sanitizeFileName(id)}.xyz`, xyz)
      }

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
      downloadBlob(blob, prefixedName(`${scopeSuffix}_csv_xyz.zip`))
    } catch (err: any) {
      pushToast(err?.message || String(err), 'error')
    } finally {
      setBusy(null)
      setProgressText(null)
    }
  }

  const downloadAse = async () => {
    const ds = getExportDataset()
    setBusy('ase')
    setProgressText('Resolving XYZ…')

    try {
      const xyzById = await collectXyz(ds)

      setProgressText('Sending to server…')
      const columns: Record<string, any[]> = {}
      const columnNames = ds.columnOrder?.length ? ds.columnOrder : Object.keys(ds.columns)
      const usedExportNames = new Set<string>()

      for (const name of columnNames) {
        const exportName = makeUniqueColumnName(
          name === 'data_source' ? ASE_EXPORTED_SOURCE_COLUMN : name,
          usedExportNames
        )
        usedExportNames.add(exportName)
        columns[exportName] = Array.from(ds.columns[name] as any)
      }

      const resp = await fetch(`${BACKEND}/export/ase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: ds.ids,
          columns,
          xyzById,
          filename: prefixedName(`${scopeSuffix}.db`),
        }),
      })

      if (!resp.ok) {
        const text = await resp.text()
        let message = text
        try {
          const parsed = JSON.parse(text)
          message = parsed?.message || parsed?.detail || parsed?.error || text
        } catch {
          // Response was not JSON; keep the raw server text.
        }
        throw new Error(message || `ASE export failed: ${resp.status}`)
      }

      const blob = await resp.blob()
      downloadBlob(blob, prefixedName(`${scopeSuffix}.db`))
    } catch (err: any) {
      pushToast(err?.message || String(err), 'error')
    } finally {
      setBusy(null)
      setProgressText(null)
    }
  }

  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Download size={16} />
        <div className="block-title">Download dataset</div>
      </div>

      <div className="legend mb-md">
        Download the compiled dataset as a full export, the current filtered view, or selected rows.
      </div>

      <div style={{ display: 'grid', gap: 14 }}>
        {/* Scope selector */}
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Export scope</div>
          <select
            value={selectedScope}
            onChange={e => setSelectedScope(e.target.value as ExportScope)}
            style={{ minWidth: 220 }}
          >
            <option value="full">Full compiled</option>
            <option value="filtered">Filtered view</option>
            <option value="selected" disabled={selCount === 0}>
              {`Selected rows${selCount === 0 ? ' (none)' : ` (${selCount.toLocaleString()})`}`}
            </option>
          </select>
        </div>

        {/* Preview stats */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="legend">
            Ready to export:{' '}
            <strong>{exportRowCount.toLocaleString()}</strong> molecules ·{' '}
            <strong>{includedCount.toLocaleString()}</strong> columns
          </span>
          {overZipLimit && (
            <span className="dataset-warning-chip" style={{ fontSize: 11 }}>
              {`⚠ >${MAX_ZIP_ROWS.toLocaleString()} rows — CSV+XYZ zip disabled`}
            </span>
          )}
        </div>

        {/* Filename prefix */}
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Filename prefix</div>
          <input
            type="text"
            placeholder="compiled_dataset"
            value={filePrefix}
            onChange={e => setFilePrefix(e.target.value)}
            style={{ minWidth: 220 }}
          />
        </div>

        {/* Column picker */}
        <div>
          <button
            className="col-expand-btn"
            style={{ fontWeight: 700, fontSize: 'var(--text-sm)', gap: 4 }}
            onClick={() => setColPickerOpen(v => !v)}
            aria-expanded={colPickerOpen}
          >
            {colPickerOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {`Columns (${includedCount} / ${allColNames.length})`}
          </button>

          {colPickerOpen && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button className="btn btn-sm" onClick={() => setIncludedCols(null)}>
                  Select all
                </button>
                <button className="btn btn-sm" onClick={() => setIncludedCols(new Set())}>
                  Clear
                </button>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                gap: '4px 10px',
                maxHeight: 180,
                overflowY: 'auto',
                paddingRight: 4,
              }}>
                {allColNames.map(col => (
                  <label
                    key={col}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={effectiveIncluded.has(col)}
                      onChange={e => {
                        setIncludedCols(prev => {
                          const next = new Set(prev ?? allColNames)
                          if (e.target.checked) next.add(col)
                          else next.delete(col)
                          return next
                        })
                      }}
                    />
                    <span
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={col}
                    >
                      {col}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Format buttons */}
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Formats</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={downloadAse} disabled={!!busy}>
              {busy === 'ase' ? (progressText ?? 'Preparing…') : 'Download ASE .db'}
            </button>

            <button
              onClick={downloadCsvXyzZip}
              disabled={!!busy || overZipLimit}
              title={overZipLimit ? `Limited to ${MAX_ZIP_ROWS.toLocaleString()} rows` : undefined}
            >
              {busy === 'zip' ? (progressText ?? 'Preparing…') : 'Download CSV + XYZ zip'}
            </button>

            <button onClick={downloadCsvOnly} disabled={!!busy}>
              {busy === 'csv' ? 'Preparing…' : 'Download CSV only'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
