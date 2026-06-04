import React, { useEffect, useMemo, useState } from 'react'
import { Sparkles, RefreshCw, GitMerge, RotateCcw, ChevronRight } from 'lucide-react'
import { BACKEND } from '../config'
import { useStore } from '../store/store'
import { useUIStore } from '../store/uiStore'
import type { Dataset } from '../models/dataModel'
import { bumpDataSourceLabel } from '../utils/dataSourceLabel'

type GeneratedRun = {
  name: string
  molecule_count: number
  config?: Record<string, any>
}

type GeneratedDate = {
  name: string
  runs: GeneratedRun[]
}

type GeneratedModel = {
  name: string
  dates: GeneratedDate[]
}

type GeneratedTree = {
  root: string
  default_root: string
  root_warning: string | null
  exists: boolean
  models: GeneratedModel[]
}

function nextGeneratedLabel(existingValues: string[]) {
  const used = new Set(existingValues)
  let i = 1
  while (used.has(`generated_${i}`)) i += 1
  return `generated_${i}`
}

function getExistingDataSources(ds: Dataset | null): string[] {
  if (!ds || !ds.columns.data_source) return []
  return Array.from(ds.columns.data_source as any[])
    .map(v => String(v ?? '').trim())
    .filter(Boolean)
}

type GeneratedMoleculesBuilderProps = {
  onRegisterSource?: (source: {
    kind: 'generated'
    label: string
    dataset: Dataset
    xyzById: Record<string, string>
  }) => void
}

export default function GeneratedMoleculesBuilder({ onRegisterSource }: GeneratedMoleculesBuilderProps) {
  const ds = useStore(s => s.dataset)
  const pushToast = useUIStore(s => s.pushToast)

  const [tree, setTree] = useState<GeneratedTree | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadingTree, setLoadingTree] = useState(false)

  const [model, setModel] = useState('')
  const [date, setDate] = useState('')
  const [run, setRun] = useState('')
  const [prefix, setPrefix] = useState('molGen')
  const [dataSourceLabel, setDataSourceLabel] = useState('generated_1')
  const [customRoot, setCustomRoot] = useState('')

  const [overlayMsg, setOverlayMsg] = useState<string | null>(null)
  const [overlayDetail, setOverlayDetail] = useState('')
  const [overlayProgress, setOverlayProgress] = useState(0)
  const [configOpen, setConfigOpen] = useState(false)

  const existingSources = useMemo(() => getExistingDataSources(ds), [ds])

  const selectedModel = tree?.models.find(m => m.name === model) ?? null
  const selectedDate = selectedModel?.dates.find(d => d.name === date) ?? null
  const selectedRun = selectedDate?.runs.find(r => r.name === run) ?? null

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

  const loadTree = async (rootOverride?: string) => {
    setLoadingTree(true)

    try {
      const root = rootOverride !== undefined ? rootOverride : customRoot
      const url = root.trim()
        ? `${BACKEND}/generated/tree?root=${encodeURIComponent(root.trim())}`
        : `${BACKEND}/generated/tree`

      const resp = await fetch(url)
      const data = await resp.json()

      if (!resp.ok) {
        throw new Error(data?.detail || `HTTP ${resp.status}`)
      }

      setTree(data)

      const firstModel = data.models?.[0]?.name ?? ''
      const firstDate = data.models?.[0]?.dates?.[0]?.name ?? ''
      const firstRun = data.models?.[0]?.dates?.[0]?.runs?.[0]?.name ?? ''

      setModel(firstModel)
      setDate(firstDate)
      setRun(firstRun)

      setDataSourceLabel(nextGeneratedLabel(existingSources))
    } catch (err: any) {
      console.error(err)
      pushToast(err?.message || String(err), 'error')
    } finally {
      setLoadingTree(false)
    }
  }

  useEffect(() => {
    loadTree()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedModel) return

    const nextDate = selectedModel.dates[0]?.name ?? ''
    setDate(nextDate)

    const nextRun = selectedModel.dates[0]?.runs?.[0]?.name ?? ''
    setRun(nextRun)
  }, [model])

  useEffect(() => {
    if (!selectedDate) return
    setRun(selectedDate.runs[0]?.name ?? '')
  }, [date])

  function existingDataSources(): string[] {
    if (!ds?.columns?.data_source) return []

    return Array.from(ds.columns.data_source as any[])
      .map(v => String(v ?? '').trim())
      .filter(Boolean)
  }

  const executeAddGenerated = async (finalSourceLabel: string) => {
    if (!model || !date || !run) {
      pushToast('Select model, date, and run first', 'warning')
      return
    }

    try {
      setBusy(true)
      showOverlay('Loading generated molecules…', 'Reading generated output folder.', 5)

      updateOverlay('Loading generated molecules…', 'Requesting generated XYZ files from backend.', 25)
      const resp = await fetch(`${BACKEND}/generated/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          date,
          token: run,
          prefix: prefix || 'molGen',
          root: customRoot.trim() || '',
        }),
      })

      const data = await resp.json()

      if (!resp.ok) {
        throw new Error(data?.detail || `HTTP ${resp.status}`)
      }

      updateOverlay(
        'Preparing generated molecules…',
        `${data.ids.length.toLocaleString()} molecules found.`,
        55
      )

      const incoming: Dataset = {
        ids: data.ids,
        columns: {
          data_source: data.ids.map(() => finalSourceLabel),
        },
        meta: {
          numericColumns: [],
          categoricalColumns: ['data_source'],
        },
        columnOrder: ['data_source'],
      }

      updateOverlay('Registering generated source…', 'Source will be compiled when requested.', 85)
      onRegisterSource?.({
        kind: 'generated',
        label: finalSourceLabel,
        dataset: incoming,
        xyzById: data.xyzById || {},
      })

      updateOverlay('Generated source staged', 'Compile dataset to make it active.', 100)
      window.setTimeout(() => hideOverlay(), 700)

      pushToast(
        `Staged ${data.ids.length.toLocaleString()} generated molecules`,
        'success'
      )
    } catch (err: any) {
      console.error(err)
      hideOverlay()
      pushToast(err?.message || String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const addGenerated = async () => {
    const label = dataSourceLabel.trim()

    if (!label) {
      pushToast('Choose a data source label', 'warning')
      return
    }

    const finalLabel = bumpDataSourceLabel(label, existingDataSources())
    if (finalLabel !== label) {
      setDataSourceLabel(finalLabel)
      pushToast(`Data source label bumped to '${finalLabel}'`, 'info')
    }
    await executeAddGenerated(finalLabel)
  }

  const bumpGeneratedSourceLabel = () => {
    const label = dataSourceLabel.trim()
    if (!label) return
    const finalLabel = bumpDataSourceLabel(label, existingDataSources())
    if (finalLabel !== label) {
      setDataSourceLabel(finalLabel)
      pushToast(`Data source label bumped to '${finalLabel}'`, 'info')
    }
  }

  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Sparkles size={16} />
        <div className="block-title">Add generated molecules</div>
      </div>

      <div className="legend mb-md">
        Add XYZ molecules from a generated output folder. These rows will only contain ID and data_source; all other existing columns are filled as missing values.
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <input
          value={customRoot}
          onChange={e => setCustomRoot(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') loadTree() }}
          placeholder={tree?.default_root ?? 'Default outputs directory'}
          title="Generated outputs root path"
          style={{ flex: 1, minWidth: 240, fontFamily: 'monospace', fontSize: 12 }}
        />
        {customRoot.trim() ? (
          <button
            onClick={() => { setCustomRoot(''); loadTree('') }}
            title="Reset to default outputs directory"
          >
            <RotateCcw size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            Reset
          </button>
        ) : null}
        <button onClick={() => loadTree()} disabled={loadingTree}>
          <RefreshCw size={13} style={{ marginRight: 6, verticalAlign: 'middle' }} />
          {loadingTree ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {tree?.root_warning ? (
        <div style={{ marginBottom: 8, color: 'var(--warning, #f0a500)', fontSize: 12 }}>
          ⚠ {tree.root_warning}
        </div>
      ) : null}

      {tree && !tree.exists ? (
        <div className="legend">
          Path does not exist: {tree.root}
        </div>
      ) : null}

      {tree && tree.exists && tree.models.length === 0 ? (
        <div className="legend">
          No generated molecule folders found in this directory.
        </div>
      ) : null}

      {tree && tree.models.length > 0 ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span>Model</span>
              <select value={model} onChange={e => setModel(e.target.value)}>
                {tree.models.map(m => (
                  <option key={m.name} value={m.name}>{m.name}</option>
                ))}
              </select>
            </label>

            <label style={{ display: 'grid', gap: 4 }}>
              <span>Date</span>
              <select value={date} onChange={e => setDate(e.target.value)}>
                {(selectedModel?.dates || []).map(d => (
                  <option key={d.name} value={d.name}>{d.name}</option>
                ))}
              </select>
            </label>

            <label style={{ display: 'grid', gap: 4 }}>
              <span>Token / run</span>
              <select value={run} onChange={e => setRun(e.target.value)}>
                {(selectedDate?.runs || []).map(r => (
                  <option key={r.name} value={r.name}>
                    {r.name} · {r.molecule_count} molecules
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: 'grid', gap: 4 }}>
              <span>ID prefix</span>
              <input
                value={prefix}
                onChange={e => setPrefix(e.target.value)}
                placeholder="molGen"
                style={{ width: 100 }}
              />
            </label>

            <label style={{ display: 'grid', gap: 4 }}>
              <span>Data source label</span>
              <input
                value={dataSourceLabel}
                onChange={e => setDataSourceLabel(e.target.value)}
                onBlur={bumpGeneratedSourceLabel}
                placeholder="generated_1"
                style={{ width: 120 }}
              />
            </label>
          </div>

          {selectedRun ? (
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--surface)',
                overflow: 'hidden',
              }}
            >
              <button
                onClick={() => setConfigOpen(o => !o)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  padding: '7px 10px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--fg-dim)',
                  fontSize: 12,
                  fontWeight: 600,
                  textAlign: 'left',
                }}
              >
                <ChevronRight
                  size={13}
                  strokeWidth={2.5}
                  style={{
                    flexShrink: 0,
                    transition: 'transform 150ms',
                    transform: configOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                  }}
                />
                Generation config
              </button>

              {configOpen && (
                <div style={{ padding: '0 10px 10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
                  {[
                    ['Total molecules', selectedRun.config?.num_generate ?? selectedRun.molecule_count],
                    ['Batch size', selectedRun.config?.batch_size],
                    ['Frames', selectedRun.config?.n_frames],
                    ['Diffusion steps', selectedRun.config?.diffusion_steps],
                    ['Seed', selectedRun.config?.seed],
                    ['Max size', selectedRun.config?.max_mol_size],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <div className="legend">{label}</div>
                      <div className="field-title">{value ?? '—'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          <div>
            <button className="btn-primary" onClick={addGenerated} disabled={busy}>
              <GitMerge size={13} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              {busy ? 'Registering…' : 'Register generated molecules'}
            </button>
          </div>
        </div>
      ) : null}

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
