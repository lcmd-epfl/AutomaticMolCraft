import React, { useEffect, useRef, useState } from 'react'
import { FolderOpen, FileText, Database, Zap, CornerDownLeft, Upload } from 'lucide-react'
import { useStore } from '../store/store'
import type { Dataset } from '../models/dataModel'
import { BACKEND } from '../config'
import { useUIStore } from '../store/uiStore'
import { perfMarkStart } from '../utils/perfMetrics'
import type { DatasetSource } from '../utils/xyzLoader'

type Mode = 'csv' | 'ase'

type DatasetBuilderProps = {
  onRegisterSource?: (source: {
    kind: 'uploaded_csv' | 'ase'
    label: string
    dataset: Dataset
    source: DatasetSource | null
  }) => void
  onRegisterAndCompile?: (source: {
    kind: 'uploaded_csv' | 'ase'
    label: string
    dataset: Dataset
    source: DatasetSource | null
  }) => void
}

function molIdStem(v: any): string {
  return String(v ?? '')
    .trim()
    .split(/[\\/]/)
    .pop()!
    .replace(/\.xyz$/i, '')
    .trim()
}

// Uppercased form is used for case-insensitive match scoring only; the
// dataset keeps original-case IDs so later case-sensitive lookups
// (backend cache, folder files) still resolve.
function normalizeMolId(v: any): string {
  return molIdStem(v).toUpperCase()
}

function pickBestIdColumn(parsed: Dataset, xyzMap: Map<string, File>): string[] {
  const xyzStems = new Set(
    Array.from(xyzMap.keys())
      .map(k => normalizeMolId(k))
      .filter(Boolean)
  )

  const scoreOf = (values: any[]) =>
    values.filter(v => xyzStems.has(normalizeMolId(v))).length

  let bestValues: any[] = parsed.ids
  let bestScore = scoreOf(parsed.ids)

  for (const [, values] of Object.entries(parsed.columns)) {
    const arr = Array.from(values as any[])
    const score = scoreOf(arr)

    if (score > bestScore) {
      bestScore = score
      bestValues = arr
    }
  }

  return bestValues.map(molIdStem)
}

function addDefaultDataSource(ds: Dataset, label: string): Dataset {
  const sourceLabel = String(label || '').trim() || 'dataset_1'
  const existingSourceColumn = ds.columns.data_source || ds.columns.data_souce
  const existing = existingSourceColumn
    ? Array.from(existingSourceColumn as any).map(v => {
        const s = String(v ?? '').trim()
        return s || sourceLabel
      })
    : ds.ids.map(() => sourceLabel)

  const numericColumns = (ds.meta.numericColumns || []).filter(c => c !== 'data_source')
  const categoricalColumns = Array.from(
    new Set([...(ds.meta.categoricalColumns || []).filter(c => c !== 'data_source'), 'data_source'])
  )

  const orderBase = ds.columnOrder && ds.columnOrder.length ? ds.columnOrder : Object.keys(ds.columns)
  const columnOrder = ['data_source', ...orderBase.filter(c => c !== 'data_source')]

  return {
    ...ds,
    columns: {
      ...ds.columns,
      data_source: existing,
    },
    meta: {
      ...ds.meta,
      numericColumns,
      categoricalColumns,
    },
    columnOrder,
  }
}

function loadRecentPaths(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as string[]
  } catch {
    return []
  }
}

function saveRecentPath(key: string, path: string): string[] {
  const existing = loadRecentPaths(key).filter(p => p !== path)
  const updated = [path, ...existing].slice(0, 5)
  try { localStorage.setItem(key, JSON.stringify(updated)) } catch { /* quota */ }
  return updated
}

function truncatePath(p: string, max = 32): string {
  if (p.length <= max) return p
  const parts = p.replace(/\\/g, '/').split('/')
  const name = parts[parts.length - 1]
  if (name.length >= max - 3) return '…' + name.slice(-(max - 1))
  return '…/' + parts.slice(-2).join('/').slice(-(max - 1))
}

export default function DatasetBuilder({ onRegisterSource, onRegisterAndCompile }: DatasetBuilderProps) {
  const setParsing = useStore(s => s.setParsing)
  const setProgress = useStore(s => s.setProgress)
  const parsing = useStore(s => s.parsing)
  const progress = useStore(s => s.progress)
  const pushToast = useUIStore(s => s.pushToast)

  const [mode, setMode] = useState<Mode>('ase')

  const csvRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const aseRef = useRef<HTMLInputElement>(null)

  const [overlayMsg, setOverlayMsg] = useState<string | null>(null)
  const [overlayDetail, setOverlayDetail] = useState<string>('')
  const [localProgress, setLocalProgress] = useState<number>(0)
  const [parsedRows, setParsedRows] = useState<number>(0)

  const overlayTimer = useRef<number | null>(null)
  const folderPickerTimer = useRef<number | null>(null)
  const andCompileRef = useRef(false)

  const [csvName, setCsvName] = useState<string | null>(null)
  const [folderCount, setFolderCount] = useState<number | null>(null)
  const [aseName, setAseName] = useState<string | null>(null)

  // Path-based loading
  const [csvPathInput, setCsvPathInput] = useState('')
  const [xyzDirPathInput, setXyzDirPathInput] = useState('')
  const [asePathInput, setAsePathInput] = useState('')
  const [csvFileFromPath, setCsvFileFromPath] = useState<File | null>(null)
  const [xyzStemsFromPath, setXyzStemsFromPath] = useState<string[] | null>(null)
  const [preloadedAseData, setPreloadedAseData] = useState<any>(null)

  // Drag-and-drop
  const [droppedCsvFile, setDroppedCsvFile] = useState<File | null>(null)
  const [droppedAseFile, setDroppedAseFile] = useState<File | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  // Recent paths
  const [recentCsvPaths, setRecentCsvPaths] = useState<string[]>([])
  const [recentXyzDirPaths, setRecentXyzDirPaths] = useState<string[]>([])
  const [recentAsePaths, setRecentAsePaths] = useState<string[]>([])

  const visibleProgress = parsing ? progress || localProgress : localProgress

  const showOverlay = (msg: string, detail = '', pct = 0) => {
    if (overlayTimer.current) window.clearTimeout(overlayTimer.current)
    setOverlayMsg(msg)
    setOverlayDetail(detail)
    setLocalProgress(pct)
  }

  const updateOverlay = (msg: string, detail = '', pct?: number) => {
    setOverlayMsg(msg)
    setOverlayDetail(detail)
    if (typeof pct === 'number') setLocalProgress(pct)
  }

  const hideOverlay = () => {
    if (overlayTimer.current) window.clearTimeout(overlayTimer.current)
    overlayTimer.current = null

    if (folderPickerTimer.current) window.clearTimeout(folderPickerTimer.current)
    folderPickerTimer.current = null

    setOverlayMsg(null)
    setOverlayDetail('')
    setLocalProgress(0)
    setParsedRows(0)
  }

  const flashOverlay = (msg: string, detail = '', ms = 700) => {
    showOverlay(msg, detail, 100)

    overlayTimer.current = window.setTimeout(() => {
      setOverlayMsg(null)
      setOverlayDetail('')
      setLocalProgress(0)
      overlayTimer.current = null
    }, ms)
  }

  const nextPaint = () => new Promise<void>(r => requestAnimationFrame(() => r()))
  const tick = () => new Promise<void>(r => setTimeout(r, 0))

  useEffect(() => {
    if (folderRef.current) {
      folderRef.current.setAttribute('webkitdirectory', '')
      folderRef.current.setAttribute('directory', '')
      folderRef.current.setAttribute('multiple', '')
    }
    setCsvPathInput('')
    setXyzDirPathInput('')
    setAsePathInput('')
    setCsvFileFromPath(null)
    setXyzStemsFromPath(null)
    setPreloadedAseData(null)
    setRecentCsvPaths(loadRecentPaths('molviz_recent_csv_paths'))
    setRecentXyzDirPaths(loadRecentPaths('molviz_recent_xyz_dir_paths'))
    setRecentAsePaths(loadRecentPaths('molviz_recent_ase_paths'))
  }, [mode])

  const buildDataset = async (andCompile = false) => {
    andCompileRef.current = andCompile
    try {
      showOverlay('Building dataset…', 'Preparing files.', 2)
      await nextPaint()
      await tick()

      if (mode === 'csv') {
        await buildFromCSV()
      } else {
        await buildFromASE()
      }
    } catch (err) {
      console.error(err)
      hideOverlay()
      setParsing(false)
      pushToast(`Build failed: ${String(err)}`, 'error')
    }
  }

  const buildFromCSV = async () => {
    const csvFile = csvFileFromPath || droppedCsvFile || csvRef.current?.files?.[0]

    if (!csvFile) {
      hideOverlay()
      pushToast('Select a CSV file first', 'warning')
      return
    }

    let useBackendXyz = false
    const map = new Map<string, File>()

    if (xyzStemsFromPath !== null) {
      // Path mode: XYZ already loaded on backend; build fake map for ID matching only
      for (const s of xyzStemsFromPath) {
        map.set(s, null as unknown as File)
        map.set(`${s}.xyz`, null as unknown as File)
      }
      useBackendXyz = true
      setParsing(true)
      setProgress(0)
      setParsedRows(0)
      updateOverlay('Parsing CSV…', csvFile.name, 5)
    } else {
      const files = folderRef.current?.files

      if (!files || files.length === 0) {
        hideOverlay()
        pushToast('Select the XYZ folder first', 'warning')
        return
      }

      setParsing(true)
      setProgress(0)
      setParsedRows(0)
      updateOverlay('Indexing XYZ files…', 'Scanning selected folder.', 1)

      const allFiles = Array.from(files)
      const totalFiles = allFiles.length || 1

      for (let idx = 0; idx < allFiles.length; idx++) {
        const f = allFiles[idx]

        if (f.name.toLowerCase().endsWith('.xyz')) {
          const stem = f.name.replace(/\.xyz$/i, '')
          map.set(stem, f)
          map.set(`${stem}.xyz`, f)
        }

        if (idx % 250 === 0 || idx === allFiles.length - 1) {
          const pct = Math.max(1, Math.min(25, Math.round(((idx + 1) / totalFiles) * 25)))
          setProgress(pct)
          updateOverlay(
            'Indexing XYZ files…',
            `${(idx + 1).toLocaleString()} / ${totalFiles.toLocaleString()} files checked`,
            pct
          )
          await tick()
        }
      }

      updateOverlay(
        'Parsing CSV…',
        `${map.size.toLocaleString()} XYZ lookup keys created.`,
        28
      )
    }

    const worker = new Worker(new URL('../workers/csvWorker.ts', import.meta.url), {
      type: 'module',
    })

    worker.onerror = e => {
      console.error('CSV worker error:', e)
      setParsing(false)
      hideOverlay()
      worker.terminate()
      pushToast('Failed to parse CSV (worker error)', 'error')
    }

    const startPct = useBackendXyz ? 5 : 28

    worker.onmessage = (e: MessageEvent<any>) => {
      if (e.data.type === 'progress') {
        const parsePct = typeof e.data.progress === 'number' ? e.data.progress : 0
        const pct = Math.max(startPct, Math.min(96, Math.round(startPct + parsePct * (96 - startPct))))

        setProgress(pct)
        setLocalProgress(pct)

        if (typeof e.data.rows === 'number') {
          setParsedRows(e.data.rows)
          setOverlayDetail(`${e.data.rows.toLocaleString()} rows parsed`)
        }
      } else if (e.data.type === 'parsed') {
        updateOverlay('Finalizing dataset…', 'Matching molecule IDs.', 97)

        if (Array.isArray(e.data.warnings)) {
          for (const w of e.data.warnings) pushToast(String(w), 'warning')
        }

        const parsed: Dataset = {
          ids: e.data.ids,
          columns: e.data.columns,
          meta: e.data.meta,
        }

        const matchedIds = pickBestIdColumn(parsed, map)

        const csvSourceLabel =
          (csvFileFromPath?.name || csvRef.current?.files?.[0]?.name)
            ?.replace(/\.csv$/i, '')
            ?.trim() || 'dataset_1'

        const d: Dataset = addDefaultDataSource(
          {
            ...parsed,
            ids: matchedIds,
          },
          csvSourceLabel
        )

        perfMarkStart('dataset_to_first_plot')
        const csvCb = andCompileRef.current ? onRegisterAndCompile : onRegisterSource
        csvCb?.({
          kind: 'uploaded_csv',
          label: csvSourceLabel,
          dataset: d,
          source: useBackendXyz
            ? { mode: 'base', baseUrl: `${BACKEND}/xyz` }
            : { mode: 'folder', files: map },
        })
        setProgress(100)
        setLocalProgress(100)
        setParsing(false)
        worker.terminate()

        if (andCompileRef.current) {
          hideOverlay()
        } else {
          flashOverlay(
            'Source staged',
            `${d.ids.length.toLocaleString()} rows registered for compile.`,
            700
          )
        }
      }
    }

    worker.postMessage({ type: 'parse', file: csvFile })
  }

  const buildFromASE = async () => {
    if (preloadedAseData) {
      // Path mode: data already loaded on backend
      const name = (asePathInput.trim().split(/[\\/]/).pop() || 'database.db')
        .replace(/\.(db|sqlite|sqlite3)$/i, '')
        .trim() || 'dataset_1'
      const d: Dataset = addDefaultDataSource(
        {
          ids: preloadedAseData.ids,
          columns: preloadedAseData.columns,
          meta: preloadedAseData.meta,
          columnOrder: preloadedAseData.columnOrder,
        },
        name
      )
      perfMarkStart('dataset_to_first_plot')
      setProgress(100)
      setLocalProgress(100)
      const aseCb = andCompileRef.current ? onRegisterAndCompile : onRegisterSource
      aseCb?.({
        kind: 'ase',
        label: name,
        dataset: d,
        source: { mode: 'base', baseUrl: `${BACKEND}/xyz` },
      })
      if (andCompileRef.current) {
        hideOverlay()
      } else {
        flashOverlay(
          'Source staged',
          `${d.ids.length.toLocaleString()} rows registered for compile.`,
          700
        )
      }
      setParsing(false)
      return
    }

    const aseFile = droppedAseFile || aseRef.current?.files?.[0]

    if (!aseFile) {
      hideOverlay()
      pushToast('Select an ASE .db file first', 'warning')
      return
    }

    setParsing(true)
    setProgress(5)
    updateOverlay('Uploading ASE database…', aseFile.name, 5)

    // The backend parses every row and converts it to XYZ before responding — there is
    // no progress signal for that phase, so once the upload's own byte-progress caps out
    // the bar creeps toward (but never reaches) 100% instead of sitting frozen, which
    // otherwise reads as "stuck" for large databases that take a while to parse.
    let trickleInterval: number | null = null
    const stopTrickle = () => {
      if (trickleInterval !== null) {
        window.clearInterval(trickleInterval)
        trickleInterval = null
      }
    }

    try {
      const fd = new FormData()
      fd.append('file', aseFile)

      const xhr = new XMLHttpRequest()

      const responseText = await new Promise<string>((resolve, reject) => {
        xhr.open('POST', `${BACKEND}/ase/load`)

        xhr.upload.onprogress = event => {
          if (event.lengthComputable) {
            const uploadPct = Math.round((event.loaded / event.total) * 45)
            const pct = Math.max(5, Math.min(50, uploadPct))
            setProgress(pct)
            updateOverlay(
              'Uploading ASE database…',
              `${Math.round(event.loaded / 1024 / 1024)} MB / ${Math.round(
                event.total / 1024 / 1024
              )} MB`,
              pct
            )
          } else {
            updateOverlay('Uploading ASE database…', 'Uploading file to backend.', 20)
          }
        }

        xhr.upload.onload = () => {
          let trickleValue = 50
          const tick = () => {
            trickleValue += (92 - trickleValue) * 0.08
            setProgress(trickleValue)
            updateOverlay(
              'Processing ASE database…',
              'Parsing entries on the backend — large databases can take a while here.',
              trickleValue
            )
          }
          tick()
          trickleInterval = window.setInterval(tick, 400)
        }

        xhr.onload = () => {
          stopTrickle()
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.responseText)
          } else {
            reject(new Error(`HTTP ${xhr.status} ${xhr.statusText} ${xhr.responseText}`))
          }
        }

        xhr.onerror = () => {
          stopTrickle()
          reject(new Error('Network error while uploading ASE database'))
        }
        xhr.send(fd)
      })

      updateOverlay('Processing ASE database…', 'Reading backend response.', 96)

      const data = JSON.parse(responseText)

      const aseSourceLabel =
        aseFile.name
          ?.replace(/\.(db|sqlite|sqlite3)$/i, '')
          ?.trim() || 'dataset_1'

      const d: Dataset = addDefaultDataSource(
        {
          ids: data.ids,
          columns: data.columns,
          meta: data.meta,
          columnOrder: data.columnOrder,
        },
        aseSourceLabel
      )

      perfMarkStart('dataset_to_first_plot')
      setProgress(100)
      setLocalProgress(100)
      const aseCb = andCompileRef.current ? onRegisterAndCompile : onRegisterSource
      aseCb?.({
        kind: 'ase',
        label: aseSourceLabel,
        dataset: d,
        source: { mode: 'base', baseUrl: `${BACKEND}/xyz` },
      })

      if (andCompileRef.current) {
        hideOverlay()
      } else {
        flashOverlay(
          'Source staged',
          `${d.ids.length.toLocaleString()} rows registered for compile.`,
          700
        )
      }
    } catch (err: any) {
      console.error(err)
      pushToast(`Failed to load ASE DB: ${err?.message || String(err)}`, 'error')
      hideOverlay()
    } finally {
      stopTrickle()
      setParsing(false)
    }
  }

  const onCsvPicked = () => {
    const file = csvRef.current?.files?.[0]
    setCsvName(file?.name ?? null)
    setCsvFileFromPath(null)
    setCsvPathInput('')
    setDroppedCsvFile(null)

    if (file) {
      flashOverlay(
        'CSV selected',
        `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`,
        700
      )
    }
  }

  const onFolderPickStart = async () => {
    showOverlay(
      'Opening folder…',
      'Large folders may take a few seconds to prepare.',
      5
    )
  
    await nextPaint()
  }

  const onFolderPicked = async () => {
    const files = Array.from(folderRef.current?.files ?? [])
    const total = files.length
    setXyzStemsFromPath(null)
    setXyzDirPathInput('')

    if (total === 0) {
      setFolderCount(null)
      hideOverlay()
      return
    }
  
    updateOverlay(
      'Reading selected folder…',
      'Preparing selected files.',
      5
    )
  
    await nextPaint()
  
    let xyzCount = 0
  
    for (let i = 0; i < files.length; i++) {
      if (files[i].name.toLowerCase().endsWith('.xyz')) xyzCount++
  
      if (i % 500 === 0 || i === files.length - 1) {
        const pct = Math.max(
          5,
          Math.min(100, Math.round(((i + 1) / total) * 100))
        )
  
        updateOverlay(
          'Reading selected folder…',
          `${(i + 1).toLocaleString()} / ${total.toLocaleString()} files checked`,
          pct
        )
  
        await tick()
      }
    }
  
    setFolderCount(xyzCount)
  
    updateOverlay(
      'Folder ready',
      `${xyzCount.toLocaleString()} XYZ files found. Click Build Dataset when ready.`,
      100
    )
  
    if (overlayTimer.current) {
      window.clearTimeout(overlayTimer.current)
    }
  
    overlayTimer.current = window.setTimeout(() => {
      if (!useStore.getState().parsing) {
        hideOverlay()
      }
    }, 1000)
  }

  const onAsePicked = () => {
    const file = aseRef.current?.files?.[0]
    setAseName(file?.name ?? null)
    setPreloadedAseData(null)
    setAsePathInput('')
    setDroppedAseFile(null)

    if (file) {
      flashOverlay(
        'ASE database selected',
        `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`,
        700
      )
    }
  }

  const loadCsvFromPath = async () => {
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
      setRecentCsvPaths(saveRecentPath('molviz_recent_csv_paths', csvPath))
      setRecentXyzDirPaths(saveRecentPath('molviz_recent_xyz_dir_paths', xyzDir))
      flashOverlay(
        'Loaded from path',
        `${name} · ${(data.xyz_stems as string[]).length.toLocaleString()} XYZ files indexed.`,
        900
      )
    } catch (err: any) {
      hideOverlay()
      pushToast(`Path load failed: ${err.message || String(err)}`, 'error')
    }
  }

  const loadAseFromPath = async () => {
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
      setPreloadedAseData(data)
      const name = dbPath.split(/[\\/]/).pop() || 'database.db'
      setAseName(name)
      setRecentAsePaths(saveRecentPath('molviz_recent_ase_paths', dbPath))
      flashOverlay(
        'ASE loaded from path',
        `${(data.ids as string[]).length.toLocaleString()} rows indexed.`,
        900
      )
    } catch (err: any) {
      hideOverlay()
      pushToast(`Path load failed: ${err.message || String(err)}`, 'error')
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    if (file.name.toLowerCase().endsWith('.csv')) {
      setMode('csv')
      setDroppedCsvFile(file)
      setCsvName(file.name)
      flashOverlay('CSV dropped', `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`, 700)
    } else if (/\.(db|sqlite|sqlite3)$/i.test(file.name)) {
      setMode('ase')
      setDroppedAseFile(file)
      setAseName(file.name)
      flashOverlay('ASE dropped', `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`, 700)
    } else {
      pushToast('Drop a .csv or .db file', 'warning')
    }
  }

  return (
    <>
      <div
        className="source-register-panel"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="source-register-grid">
          <label className="source-register-mode">
            <span className="source-register-label">Mode</span>
            <select
              value={mode}
              onChange={e => setMode(e.target.value as Mode)}
            >
              <option value="csv">CSV + XYZ folder</option>
              <option value="ase">ASE database (.db)</option>
            </select>
          </label>

          {mode === 'csv' && (
            <div className="source-register-files">
              <input
                ref={csvRef}
                type="file"
                accept=".csv"
                onChange={onCsvPicked}
                style={{ display: 'none' }}
              />

              <input
                ref={folderRef}
                type="file"
                onClick={onFolderPickStart}
                onChange={onFolderPicked}
                style={{ display: 'none' }}
              />

              <div className="file-pick-group">
                <button
                  className="file-pick-btn"
                  onClick={() => csvRef.current?.click()}
                  title="Choose CSV file"
                >
                  <FileText size={13} strokeWidth={2} style={{ flexShrink: 0 }} />
                  <span className="file-pick-name">{csvName ?? 'Choose CSV…'}</span>
                </button>
                <div className="file-path-row">
                  <input
                    type="text"
                    className="file-path-input"
                    placeholder="or paste CSV path…"
                    value={csvPathInput}
                    onChange={e => setCsvPathInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); loadCsvFromPath() } }}
                  />
                  <button
                    className="file-path-load-btn"
                    onClick={loadCsvFromPath}
                    title="Load CSV from path"
                    disabled={!!overlayMsg}
                  >
                    <CornerDownLeft size={11} strokeWidth={2} />
                  </button>
                </div>
              </div>

              <div className="file-pick-group">
                <button
                  className="file-pick-btn"
                  onClick={() => folderRef.current?.click()}
                  title="Choose XYZ folder"
                >
                  <FolderOpen size={13} strokeWidth={2} style={{ flexShrink: 0 }} />
                  <span className="file-pick-name">
                    {folderCount != null
                      ? `${folderCount.toLocaleString()} XYZ files`
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
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); loadCsvFromPath() } }}
                  />
                  <button
                    className="file-path-load-btn"
                    onClick={loadCsvFromPath}
                    title="Load XYZ folder from path"
                    disabled={!!overlayMsg}
                  >
                    <CornerDownLeft size={11} strokeWidth={2} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {mode === 'ase' && (
            <div className="source-register-files source-register-files-ase">
              <input
                ref={aseRef}
                type="file"
                accept=".db,.sqlite,.sqlite3"
                onChange={onAsePicked}
                style={{ display: 'none' }}
              />

              <div className="file-pick-group">
                <button
                  className="file-pick-btn"
                  onClick={() => aseRef.current?.click()}
                  title="Choose ASE database"
                >
                  <Database size={13} strokeWidth={2} style={{ flexShrink: 0 }} />
                  <span className="file-pick-name">{aseName ?? 'Choose .db file…'}</span>
                </button>
                <div className="file-path-row">
                  <input
                    type="text"
                    className="file-path-input"
                    placeholder="or paste .db path…"
                    value={asePathInput}
                    onChange={e => setAsePathInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); loadAseFromPath() } }}
                  />
                  <button
                    className="file-path-load-btn"
                    onClick={loadAseFromPath}
                    title="Load ASE database from path"
                    disabled={!!overlayMsg}
                  >
                    <CornerDownLeft size={11} strokeWidth={2} />
                  </button>
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              className="btn-primary source-register-action"
              onClick={() => buildDataset(false)}
              disabled={!!overlayMsg}
            >
              <Zap
                size={13}
                strokeWidth={2.5}
                style={{ display: 'inline', verticalAlign: 'middle', marginRight: 5 }}
              />
              Register source
            </button>

            <button
              className="btn-primary source-register-action"
              onClick={() => buildDataset(true)}
              disabled={!!overlayMsg}
            >
              <Zap
                size={13}
                strokeWidth={2.5}
                style={{ display: 'inline', verticalAlign: 'middle', marginRight: 5 }}
              />
              Register and compile
            </button>
          </div>
        </div>

        {mode === 'csv' && (recentCsvPaths.length > 0 || recentXyzDirPaths.length > 0) && (
          <div className="source-recent-section">
            {recentCsvPaths.length > 0 && (
              <div className="source-recent-row">
                <span className="source-recent-label">CSV</span>
                {recentCsvPaths.slice(0, 3).map(p => (
                  <button
                    key={p}
                    className="recent-path-chip"
                    title={p}
                    onClick={() => setCsvPathInput(p)}
                  >
                    {truncatePath(p)}
                  </button>
                ))}
              </div>
            )}
            {recentXyzDirPaths.length > 0 && (
              <div className="source-recent-row">
                <span className="source-recent-label">XYZ dir</span>
                {recentXyzDirPaths.slice(0, 3).map(p => (
                  <button
                    key={p}
                    className="recent-path-chip"
                    title={p}
                    onClick={() => setXyzDirPathInput(p)}
                  >
                    {truncatePath(p)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {mode === 'ase' && recentAsePaths.length > 0 && (
          <div className="source-recent-section">
            <div className="source-recent-row">
              <span className="source-recent-label">Recent</span>
              {recentAsePaths.slice(0, 3).map(p => (
                <button
                  key={p}
                  className="recent-path-chip"
                  title={p}
                  onClick={() => setAsePathInput(p)}
                >
                  {truncatePath(p)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={`source-drop-zone${isDragOver ? ' source-drop-zone-active' : ''}`}>
          <Upload size={14} strokeWidth={1.8} style={{ flexShrink: 0 }} />
          <span>Drop a <code>.csv</code> or <code>.db</code> file here to load</span>
        </div>
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
                    width: `${Math.max(0, Math.min(100, visibleProgress || 0))}%`,
                    background: 'linear-gradient(90deg, #1aa3ff, #5dd6ff)',
                    transition: 'width 120ms linear',
                  }}
                />
              </div>

              <div style={{ marginTop: 6, color: 'var(--fg-dim)', fontSize: 12 }}>
                {Math.round(visibleProgress || 0)}%
                {parsedRows > 0 ? ` · ${parsedRows.toLocaleString()} rows parsed` : ''}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
