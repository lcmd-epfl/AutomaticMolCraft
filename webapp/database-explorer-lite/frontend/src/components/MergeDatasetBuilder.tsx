import React, { useMemo, useRef, useState } from 'react'
import { Database, FileText, FolderOpen, GitMerge, AlertTriangle, CornerDownLeft } from 'lucide-react'
import { useStore } from '../store/store'
import { useUIStore } from '../store/uiStore'
import type { Dataset } from '../models/dataModel'
import { BACKEND } from '../config'
import { buildXyzById, resolveXyzByIds } from '../utils/xyzLoader'
import {
  mergeDatasets,
  planMergeColumns,
  type DuplicateIdMode,
} from '../utils/mergeDatasets'
import { bumpDataSourceLabel } from '../utils/dataSourceLabel'

type Mode = 'csv' | 'ase'

function normalizeMolId(v: any): string {
  return String(v ?? '')
    .trim()
    .split(/[\\/]/)
    .pop()!
    .replace(/\.xyz$/i, '')
    .trim()
    .toUpperCase()
}

function pickBestIdColumn(parsed: Dataset, xyzMap: Map<string, File>): string[] {
  const xyzStems = new Set(
    Array.from(xyzMap.keys())
      .map(k => normalizeMolId(k))
      .filter(Boolean)
  )

  let bestIds = parsed.ids.map(normalizeMolId)
  let bestScore = bestIds.filter(id => xyzStems.has(id)).length

  for (const [, values] of Object.entries(parsed.columns)) {
    const arr = Array.from(values as any[])
    const candidate = arr.map(normalizeMolId)
    const score = candidate.filter(v => xyzStems.has(v)).length

    if (score > bestScore) {
      bestScore = score
      bestIds = candidate
    }
  }

  return bestIds
}

export default function MergeDatasetBuilder() {
  const ds = useStore(s => s.dataset)
  const source = useStore(s => s.source)
  const setDataset = useStore(s => s.setDataset)
  const setSource = useStore(s => s.setSource)

  const pushToast = useUIStore(s => s.pushToast)

  const [mode, setMode] = useState<Mode>('csv')
  const [datasetLabel, setDatasetLabel] = useState('dataset_2')
  const [duplicateMode, setDuplicateMode] = useState<DuplicateIdMode>('rename')
  const [busy, setBusy] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])

  const [overlayMsg, setOverlayMsg] = useState<string | null>(null)
  const [overlayDetail, setOverlayDetail] = useState('')
  const [overlayProgress, setOverlayProgress] = useState(0)

  const csvRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const aseRef = useRef<HTMLInputElement>(null)

  const [csvName, setCsvName] = useState<string | null>(null)
  const [folderCount, setFolderCount] = useState<number | null>(null)
  const [aseName, setAseName] = useState<string | null>(null)

  // Path-based loading
  const [csvPathInput, setCsvPathInput] = useState('')
  const [xyzDirPathInput, setXyzDirPathInput] = useState('')
  const [asePathInput, setAsePathInput] = useState('')
  const [csvFileFromPath, setCsvFileFromPath] = useState<File | null>(null)
  const [xyzStemsFromPath, setXyzStemsFromPath] = useState<string[] | null>(null)
  const [preloadedAseDataForMerge, setPreloadedAseDataForMerge] = useState<any>(null)

  React.useEffect(() => {
    if (folderRef.current) {
      folderRef.current.setAttribute('webkitdirectory', '')
      folderRef.current.setAttribute('directory', '')
      folderRef.current.setAttribute('multiple', '')
    }
  }, [mode])

  const showOverlay = (msg: string, detail = '', progress = 5) => {
    setOverlayMsg(msg)
    setOverlayDetail(detail)
    setOverlayProgress(progress)
  }

  const updateOverlay = (msg: string, detail = '', progress = overlayProgress) => {
    setOverlayMsg(msg)
    setOverlayDetail(detail)
    setOverlayProgress(progress)
  }

  const hideOverlay = () => {
    setOverlayMsg(null)
    setOverlayDetail('')
    setOverlayProgress(0)
  }

  const waitForPaint = () =>
    new Promise<void>(resolve => {
      window.requestAnimationFrame(() => resolve())
    })

  const openPickerWithOverlay = (
    ref: React.RefObject<HTMLInputElement>,
    msg: string,
    detail: string
  ) => {
    showOverlay(msg, detail, 8)

    const hideIfNoSelection = () => {
      window.setTimeout(() => {
        if (!busy) hideOverlay()
      }, 350)
    }

    window.addEventListener('focus', hideIfNoSelection, { once: true })
    ref.current?.click()
  }

  const summary = useMemo(() => {
    if (!ds) return null
    return {
      rows: ds.ids.length,
      columns: ds.columnOrder?.length || Object.keys(ds.columns).length,
    }
  }, [ds])

  if (!ds || !source) return null

  async function loadCsvDataset(): Promise<{
    dataset: Dataset
    xyzById: Record<string, string>
  }> {
    const csvFile = csvFileFromPath || csvRef.current?.files?.[0]

    if (!csvFile) {
      throw new Error('Select a CSV file')
    }

    const map = new Map<string, File>()
    let xyzCount = 0

    if (xyzStemsFromPath !== null) {
      // Path mode: XYZ already loaded on backend; build map for ID matching only
      for (const s of xyzStemsFromPath) {
        map.set(s, null as unknown as File)
        map.set(`${s}.xyz`, null as unknown as File)
      }
      xyzCount = xyzStemsFromPath.length
    } else {
      const folderFiles = folderRef.current?.files
      if (!folderFiles || folderFiles.length === 0) {
        throw new Error('Select an XYZ folder')
      }

      const files = Array.from(folderFiles)

      updateOverlay(
        'Reading XYZ folder…',
        `Scanning 0 / ${files.length.toLocaleString()} files.`,
        45
      )
      await waitForPaint()

      for (let i = 0; i < files.length; i += 1) {
        const f = files[i]

        if (f.name.toLowerCase().endsWith('.xyz')) {
          const stem = f.name.replace(/\.xyz$/i, '')
          map.set(stem, f)
          map.set(`${stem}.xyz`, f)
          xyzCount += 1
        }

        if (i === files.length - 1 || i % 100 === 0) {
          updateOverlay(
            'Reading XYZ folder…',
            `Scanned ${(i + 1).toLocaleString()} / ${files.length.toLocaleString()} files · ${xyzCount.toLocaleString()} XYZ files found.`,
            45 + ((i + 1) / Math.max(1, files.length)) * 10
          )
          await waitForPaint()
        }
      }
    }

    updateOverlay('Loading CSV…', `Parsing ${csvFile.name}.`, 38)
    await waitForPaint()

    const worker = new Worker(new URL('../workers/csvWorker.ts', import.meta.url), {
      type: 'module',
    })

    const parsed = await new Promise<any>((resolve, reject) => {
      worker.onerror = e => reject(e)

      worker.onmessage = e => {
        if (e.data.type === 'parsed') {
          resolve(e.data)
          worker.terminate()
        }
      }

      worker.postMessage({ type: 'parse', file: csvFile })
    })

    const baseDataset: Dataset = {
      ids: parsed.ids,
      columns: parsed.columns,
      meta: parsed.meta,
    }

    const fixedIds = pickBestIdColumn(baseDataset, map)

    const dataset: Dataset = {
      ...baseDataset,
      ids: fixedIds,
    }

    updateOverlay(
      'Loading XYZ geometries…',
      `Reading 0 / ${dataset.ids.length.toLocaleString()} molecules from ${xyzCount.toLocaleString()} XYZ files.`,
      56
    )
    await waitForPaint()

    const xyzById = await resolveXyzByIds(
      dataset.ids.map(String),
      xyzStemsFromPath !== null
        ? { mode: 'base', baseUrl: `${BACKEND}/xyz` }
        : { mode: 'folder', files: map },
      {
        onProgress: (count) => {
          if (count === dataset.ids.length || count % 25 === 0) {
            updateOverlay(
              'Loading XYZ geometries…',
              `Read ${count.toLocaleString()} / ${dataset.ids.length.toLocaleString()} molecules.`,
              56 + (count / Math.max(1, dataset.ids.length)) * 12
            )
          }
        },
      }
    )
    await waitForPaint()

    return {
      dataset,
      xyzById,
    }
  }

  async function loadAseDataset(): Promise<{
    dataset: Dataset
    xyzById: Record<string, string>
  }> {
    let data: any

    if (preloadedAseDataForMerge) {
      data = preloadedAseDataForMerge
      updateOverlay('Loading ASE database…', 'Reading preloaded metadata.', 52)
      await waitForPaint()
    } else {
      const aseFile = aseRef.current?.files?.[0]

      if (!aseFile) {
        throw new Error('Select an ASE database')
      }

      updateOverlay('Uploading ASE database…', `Sending ${aseFile.name} to backend.`, 38)
      await waitForPaint()

      const fd = new FormData()
      fd.append('file', aseFile)

      const resp = await fetch(`${BACKEND}/ase/load`, {
        method: 'POST',
        body: fd,
      })

      if (!resp.ok) {
        throw new Error(`ASE upload failed (${resp.status})`)
      }

      data = await resp.json()
      updateOverlay('Loading ASE database…', 'Reading molecule metadata from backend.', 52)
      await waitForPaint()
    }

    const dataset: Dataset = {
      ids: data.ids,
      columns: data.columns,
      meta: data.meta,
    }

    const xyzById = await resolveXyzByIds(dataset.ids.map(String), { mode: 'base', baseUrl: `${BACKEND}/xyz` }, {
      onProgress: count => {
        if (count === dataset.ids.length || count % 25 === 0) {
          updateOverlay(
            'Loading ASE geometries…',
            `Read ${count.toLocaleString()} / ${dataset.ids.length.toLocaleString()} molecules.`,
            55 + (count / Math.max(1, dataset.ids.length)) * 13
          )
        }
      },
    })
    await waitForPaint()

    return {
      dataset,
      xyzById,
    }
  }

  function existingDataSources(): string[] {
    if (!ds?.columns?.data_source) return []

    return Array.from(ds.columns.data_source as any[])
      .map(v => String(v ?? '').trim())
      .filter(Boolean)
  }

  async function executeMerge(finalSourceLabel: string) {
    try {
      setBusy(true)
      setWarnings([])
      showOverlay('Preparing merge…', 'Reading current dataset and geometries.', 5)

      updateOverlay('Preparing current dataset…', 'Collecting existing XYZ geometries.', 15)
      const baseXyzById = await buildXyzById(ds, source)

      updateOverlay('Loading incoming dataset…', 'Reading selected files.', 35)
      const incoming =
        mode === 'csv'
          ? await loadCsvDataset()
          : await loadAseDataset()

      const plan = planMergeColumns(ds, incoming.dataset)

      updateOverlay('Merging datasets…', 'Combining rows, columns, and geometries.', 70)
      const merged = mergeDatasets({
        base: ds,
        incoming: incoming.dataset,
        baseLabel: 'dataset_1',
        incomingLabel: finalSourceLabel,
        duplicateIdMode: duplicateMode,
        baseXyzById,
        incomingXyzById: incoming.xyzById,
      })

      setDataset(merged.dataset)

      setSource({
        mode: 'mixed',
        xyzById: merged.xyzById,
      })

      setWarnings(merged.warnings)

      updateOverlay('Merge complete', 'Dataset updated successfully.', 100)
      window.setTimeout(() => hideOverlay(), 700)

      pushToast(
        `Merged ${incoming.dataset.ids.length.toLocaleString()} molecules`,
        'success'
      )

      console.log('Merge plan:', plan)
      console.log('Merge result:', merged)
    } catch (err: any) {
      console.error(err)
      hideOverlay()
      pushToast(err?.message || String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function mergeIncomingDataset() {
    const label = datasetLabel.trim()

    if (!label) {
      pushToast('Choose a data source label', 'warning')
      return
    }

    const finalLabel = bumpDataSourceLabel(label, existingDataSources())
    if (finalLabel !== label) {
      setDatasetLabel(finalLabel)
      pushToast(`Data source label bumped to '${finalLabel}'`, 'info')
    }
    await executeMerge(finalLabel)
  }

  const loadMergeCsvFromPath = async () => {
    const csvPath = csvPathInput.trim()
    const xyzDir = xyzDirPathInput.trim()
    if (!csvPath) { pushToast('Enter a CSV file path', 'warning'); return }
    if (!xyzDir) { pushToast('Enter the XYZ folder path', 'warning'); return }

    showOverlay('Loading from path…', 'Reading files from disk.', 10)
    try {
      const resp = await fetch(`${BACKEND}/load-path/csv-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv_path: csvPath, xyz_dir: xyzDir }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${resp.status}`)
      }
      const data = await resp.json()
      const name = csvPath.split(/[\\/]/).pop() || 'data.csv'
      const file = new File([data.csv_content], name, { type: 'text/csv' })
      setCsvFileFromPath(file)
      setCsvName(name)
      setXyzStemsFromPath(data.xyz_stems)
      setFolderCount(data.xyz_stems.length)
      window.setTimeout(() => hideOverlay(), 900)
    } catch (err: any) {
      hideOverlay()
      pushToast(`Path load failed: ${err.message || String(err)}`, 'error')
    }
  }

  const loadMergeAseFromPath = async () => {
    const dbPath = asePathInput.trim()
    if (!dbPath) { pushToast('Enter an ASE database path', 'warning'); return }

    showOverlay('Loading ASE from path…', dbPath, 10)
    try {
      const resp = await fetch(`${BACKEND}/load-path/ase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ db_path: dbPath }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${resp.status}`)
      }
      const data = await resp.json()
      setPreloadedAseDataForMerge(data)
      const name = dbPath.split(/[\\/]/).pop() || 'database.db'
      setAseName(name)
      window.setTimeout(() => hideOverlay(), 900)
    } catch (err: any) {
      hideOverlay()
      pushToast(`Path load failed: ${err.message || String(err)}`, 'error')
    }
  }

  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <GitMerge size={16} />
        <div className="block-title">Merge dataset</div>
      </div>

      <div className="legend" style={{ marginBottom: 14 }}>
        Add a second dataset into the current one.
      </div>

      {summary ? (
        <div
          style={{
            marginBottom: 14,
            padding: 10,
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Current dataset</div>
          <div className="legend">
            {summary.rows.toLocaleString()} molecules · {summary.columns} columns
          </div>
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>New dataset label</div>
          <input
            value={datasetLabel}
            onChange={e => setDatasetLabel(e.target.value)}
            placeholder="dataset_2"
            style={{ width: 220 }}
          />
        </div>

        <div>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Duplicate molecule IDs</div>

          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="radio"
                checked={duplicateMode === 'rename'}
                onChange={() => setDuplicateMode('rename')}
              />
              Keep duplicates and rename them (mol → mol_2)
            </label>

            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="radio"
                checked={duplicateMode === 'skip'}
                onChange={() => setDuplicateMode('skip')}
              />
              Skip duplicates
            </label>
          </div>
        </div>

        <div className="field-title">Upload mode</div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <select value={mode} onChange={e => setMode(e.target.value as Mode)}>
              <option value="csv">CSV + XYZ folder</option>
              <option value="ase">ASE database (.db)</option>
            </select>
          </div>

          {mode === 'csv' ? (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <input
                ref={csvRef}
                type="file"
                accept=".csv"
                onChange={() => {
                  const file = csvRef.current?.files?.[0]
                  setCsvName(file?.name ?? null)
                  setCsvFileFromPath(null)
                  setCsvPathInput('')

                  if (file) {
                    showOverlay('CSV selected', `Selected ${file.name}.`, 100)
                    window.setTimeout(() => hideOverlay(), 450)
                  } else {
                    hideOverlay()
                  }
                }}
                style={{ display: 'none' }}
              />

              <input
                ref={folderRef}
                type="file"
                multiple
                onChange={async () => {
                  const files = Array.from(folderRef.current?.files ?? [])
                  setFolderCount(files.length)
                  setXyzStemsFromPath(null)
                  setXyzDirPathInput('')

                  if (files.length === 0) {
                    hideOverlay()
                    return
                  }

                  let xyzCount = 0
                  showOverlay(
                    'Reading XYZ folder…',
                    `Scanning 0 / ${files.length.toLocaleString()} files.`,
                    10
                  )

                  for (let i = 0; i < files.length; i += 1) {
                    if (files[i].name.toLowerCase().endsWith('.xyz')) xyzCount += 1

                    if (i === files.length - 1 || i % 100 === 0) {
                      updateOverlay(
                        'Reading XYZ folder…',
                        `Scanned ${(i + 1).toLocaleString()} / ${files.length.toLocaleString()} files · ${xyzCount.toLocaleString()} XYZ files found.`,
                        10 + ((i + 1) / Math.max(1, files.length)) * 85
                      )
                      await waitForPaint()
                    }
                  }

                  updateOverlay(
                    'XYZ folder selected',
                    `${xyzCount.toLocaleString()} XYZ files found in ${files.length.toLocaleString()} files.`,
                    100
                  )
                  window.setTimeout(() => hideOverlay(), 650)
                }}
                style={{ display: 'none' }}
              />

              <div className="file-pick-group">
                <button
                  className="file-pick-btn"
                  onClick={() =>
                    openPickerWithOverlay(
                      csvRef,
                      'Opening CSV picker…',
                      'Choose the CSV file to merge.'
                    )
                  }
                >
                  <FileText size={13} />
                  <span>{csvName ?? 'Choose CSV…'}</span>
                </button>
                <div className="file-path-row">
                  <input
                    type="text"
                    className="file-path-input"
                    placeholder="or paste CSV path…"
                    value={csvPathInput}
                    onChange={e => setCsvPathInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); loadMergeCsvFromPath() } }}
                  />
                  <button
                    className="file-path-load-btn"
                    onClick={loadMergeCsvFromPath}
                    title="Load CSV from path"
                    disabled={busy}
                  >
                    <CornerDownLeft size={11} strokeWidth={2} />
                  </button>
                </div>
              </div>

              <div className="file-pick-group">
                <button
                  className="file-pick-btn"
                  onClick={() =>
                    openPickerWithOverlay(
                      folderRef,
                      'Opening XYZ folder picker…',
                      'Choose the folder containing XYZ files.'
                    )
                  }
                >
                  <FolderOpen size={13} />
                  <span>
                    {folderCount != null
                      ? `${folderCount.toLocaleString()} files`
                      : 'Choose XYZ folder…'}
                  </span>
                </button>
                <div className="file-path-row">
                  <input
                    type="text"
                    className="file-path-input"
                    placeholder="or paste folder path…"
                    value={xyzDirPathInput}
                    onChange={e => setXyzDirPathInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); loadMergeCsvFromPath() } }}
                  />
                  <button
                    className="file-path-load-btn"
                    onClick={loadMergeCsvFromPath}
                    title="Load XYZ folder from path"
                    disabled={busy}
                  >
                    <CornerDownLeft size={11} strokeWidth={2} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <input
                ref={aseRef}
                type="file"
                accept=".db,.sqlite,.sqlite3"
                onChange={() => {
                  const file = aseRef.current?.files?.[0]
                  setAseName(file?.name ?? null)
                  setPreloadedAseDataForMerge(null)
                  setAsePathInput('')

                  if (file) {
                    showOverlay('ASE database selected', `Selected ${file.name}.`, 100)
                    window.setTimeout(() => hideOverlay(), 450)
                  } else {
                    hideOverlay()
                  }
                }}
                style={{ display: 'none' }}
              />

              <div className="file-pick-group">
                <button
                  className="file-pick-btn"
                  onClick={() =>
                    openPickerWithOverlay(
                      aseRef,
                      'Opening ASE database picker…',
                      'Choose the ASE database to merge.'
                    )
                  }
                  style={{ width: 'fit-content' }}
                >
                  <Database size={13} />
                  <span>{aseName ?? 'Choose ASE database…'}</span>
                </button>
                <div className="file-path-row">
                  <input
                    type="text"
                    className="file-path-input"
                    placeholder="or paste .db path…"
                    value={asePathInput}
                    onChange={e => setAsePathInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); loadMergeAseFromPath() } }}
                  />
                  <button
                    className="file-path-load-btn"
                    onClick={loadMergeAseFromPath}
                    title="Load ASE database from path"
                    disabled={busy}
                  >
                    <CornerDownLeft size={11} strokeWidth={2} />
                  </button>
                </div>
              </div>
            </>
          )}

          <div className="topbar-sep" />

          <div>
            <button className="btn-primary" onClick={mergeIncomingDataset} disabled={busy}>
              <GitMerge size={13} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              {busy ? 'Merging…' : 'Merge dataset'}
            </button>
          </div>
        </div>

        {warnings.length > 0 ? (
          <div
            style={{
              border: '1px solid #7a5a1d',
              background: '#1a1610',
              borderRadius: 8,
              padding: 10,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
                fontWeight: 700,
              }}
            >
              <AlertTriangle size={15} />
              Merge warnings
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              {warnings.map((w, i) => (
                <div key={`${i}-${w}`} className="legend">
                  {w}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {overlayMsg && (
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
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{overlayMsg}</div>

            {overlayDetail ? (
              <div style={{ color: 'var(--fg-dim)', fontSize: 13, marginBottom: 12 }}>
                {overlayDetail}
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
                    width: `${Math.max(0, Math.min(100, overlayProgress || 0))}%`,
                    background: 'linear-gradient(90deg, #1aa3ff, #5dd6ff)',
                    transition: 'width 120ms linear',
                  }}
                />
              </div>

              <div style={{ marginTop: 6, color: 'var(--fg-dim)', fontSize: 12 }}>
                {Math.round(overlayProgress || 0)}%
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
