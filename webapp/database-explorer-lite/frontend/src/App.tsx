import React, { useEffect, useRef, useState } from 'react'
import { shallow } from 'zustand/shallow'
import { BarChart2, Layers, Wrench, SquarePlus, BarChart, Trash2, Atom, Sparkles, BrainCircuit } from 'lucide-react'
import GridLayout, { WidthProvider } from 'react-grid-layout'
import TopBar from './components/TopBar'
import MoleculeViewer from './components/MoleculeViewer'
import PlotPanel from './components/PlotPanel'
import DataTable from './components/DataTable'
import ManagementPage from './components/ManagementPage'
import InfoPanel from './components/InfoPanel'
import ToastHost from './components/ToastHost'
// import PerformancePanel from './components/PerformancePanel'
import { useStore } from './store/store'
import { useUIStore } from './store/uiStore'
import { BACKEND } from './config'
import ExternalToolPage, { type ToolSpec } from './components/ExternalToolPage'
import GenerationPage from './components/GenerationPage'
import AnalysisToolsPage from './components/AnalysisToolsPage'
import StructureGuidedGenerationPage from './components/StructureGuidedGenerationPage'
import TrainingPage from './components/TrainingPage'
import type { StagedSource } from './utils/stagedSources'
import { useSplitPane } from './utils/useSplitPane'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import './styles.css'

const RGL = WidthProvider(GridLayout)

const tabDescriptions = {
  visualization:
    'Explore molecular datasets with linked plots, filters, tables, and interactive 3D structure views.',
  management:
    'Register, stage, merge, filter, and export molecular datasets from CSV, XYZ, ASE, or generated outputs.',
  generation:
    'Generate new 3D molecules with MolCraftDiffusion models and inspect trajectories, logs, and outputs.',
  'structure-generation':
    'Complete or modify molecules with MolCraftDiffusion using a reference scaffold and selected frozen atoms.',
  analysis:
    'Run MolCraftDiffusion analysis workflows for descriptors, optimizations, reductions, and property prediction.',
  training:
    'Configure and queue MolCraftDiffusion training jobs, monitor progress, view live logs, and export configs.',
  plugins:
    'Run custom external tools such as docking, QSAR, or scoring workflows from local plug-in manifests.',
} as const

const TABS = [
  { id: 'visualization', label: 'Visualization', Icon: BarChart2 },
  { id: 'management', label: 'Management', Icon: Layers },
  { id: 'generation', label: '3D molecule generation', Icon: Sparkles },
  { id: 'structure-generation', label: 'Structure-directed generation', Icon: Sparkles },
  { id: 'analysis', label: 'Analysis tools', Icon: Atom },
  { id: 'training', label: 'Model training', Icon: BrainCircuit },
  { id: 'plugins', label: 'Plug-in tools', Icon: Wrench },
] as const

type TabId = (typeof TABS)[number]['id']

function tabFromHash(): TabId {
  const h = window.location.hash.slice(1)
  return TABS.some(t => t.id === h) ? (h as TabId) : 'management'
}

const localToolManifestModules = {
  ...import.meta.glob('../../backend/tools/*/manifest.json', { eager: true }),
}

function normalizeToolManifest(mod: any): ToolSpec | null {
  const raw = mod?.default ?? mod

  if (!raw || typeof raw !== 'object') return null
  if (!raw.id || !raw.name) return null

  return {
    id: String(raw.id),
    name: String(raw.name),
    description: raw.description ?? '',
    inputs: Array.isArray(raw.inputs) ? raw.inputs : [],
    hasRequirements: Boolean(raw.hasRequirements),
    manifestVersion: raw.manifestVersion ?? 1,
    output: raw.output ?? { kind: 'add_columns' },
    needsXyz: Boolean(raw.needsXyz),
  }
}

function loadLocalManifestTools(): ToolSpec[] {
  const byId = new Map<string, ToolSpec>()

  for (const mod of Object.values(localToolManifestModules)) {
    const tool = normalizeToolManifest(mod)
    if (tool) byId.set(tool.id, tool)
  }

  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function extractTools(data: any): ToolSpec[] {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.tools)) return data.tools
  if (Array.isArray(data?.data?.tools)) return data.data.tools
  if (Array.isArray(data?.result?.tools)) return data.result.tools
  return []
}

function extractToolErrors(data: any): string[] {
  const errors = data?.errors ?? data?.data?.errors ?? data?.result?.errors ?? []

  return Array.isArray(errors)
    ? errors.map((e: any) =>
        typeof e === 'string'
          ? e
          : `${e.path ?? 'tool'}: ${e.error ?? JSON.stringify(e)}`
      )
    : []
}

export default function App() {
  const hasDataset = useStore(s => s.dataset != null)

  // Select scalars only — returning fresh arrays (slice) here defeats
  // `shallow` and re-renders the whole app on every store update.
  const datasetSummary = useStore(
    s => ({
      moleculeCount: s.dataset?.ids.length ?? 0,
      numericCount: s.dataset?.meta.numericColumns.length ?? 0,
      firstNumeric: s.dataset?.meta.numericColumns[0] ?? null,
      secondNumeric: s.dataset?.meta.numericColumns[1] ?? null,
      thirdNumeric: s.dataset?.meta.numericColumns[2] ?? null,
    }),
    shallow
  )

  const plotIds = useStore(s => s.plots.map(p => p.id), shallow)
  const plots = useStore(s => s.plots, shallow)
  const plotsRef = useRef(plots)
  plotsRef.current = plots

  const addPlot = useStore(s => s.addPlot)
  const updatePlot = useStore(s => s.updatePlot)
  const resetWorkspace = useStore(s => s.resetWorkspace)

  const VIEWER_KEY = 'viewer'

  const [viewerLayout, setViewerLayout] = useState({
    i: VIEWER_KEY,
    x: 6,
    y: 0,
    w: 6,
    h: 8,
  })

  const pushToast = useUIStore(s => s.pushToast)

  const [tab, setTab] = useState<TabId>(tabFromHash)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const tabBarRef = useRef<HTMLDivElement>(null)

  // Keep the active tab in the URL hash so refresh/back/forward preserve it.
  useEffect(() => {
    if (window.location.hash.slice(1) !== tab) window.location.hash = tab
  }, [tab])

  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Global shortcuts: 1-7 switch tabs, ? toggles the shortcut overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length && !e.shiftKey) {
        setTab(TABS[n - 1].id)
      } else if (e.key === '?') {
        setShortcutsOpen(o => !o)
      } else if (e.key === 'Escape') {
        setShortcutsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Position the single sliding tab indicator under the active tab.
  useEffect(() => {
    const bar = tabBarRef.current
    const active = bar?.querySelector<HTMLElement>('.tab-btn.active')
    if (!bar || !active) return
    bar.style.setProperty('--tab-ind-left', `${active.offsetLeft}px`)
    bar.style.setProperty('--tab-ind-width', `${active.offsetWidth}px`)
  }, [tab])
  const [tools, setTools] = useState<ToolSpec[]>([])
  const [toolErrors, setToolErrors] = useState<string[]>([])
  const [loadingTools, setLoadingTools] = useState(false)
  const [confirmResetOpen, setConfirmResetOpen] = useState(false)
  const [stagedSources, setStagedSources] = useState<StagedSource[]>([])
  const [pendingRef, setPendingRef] = useState<{ xyz: string; name: string } | null>(null)

  const { size: infoPanelWidth, startDrag: startInfoDrag } = useSplitPane('viz-info-panel-width', 300, 160, 640)

  useEffect(() => {
    let cancelled = false

    const loadTools = async () => {
      setLoadingTools(true)

      const localTools = loadLocalManifestTools()

      if (!cancelled && localTools.length > 0) {
        setTools(localTools)
        setToolErrors([])
        setLoadingTools(false)
        return
      }

      const bases = Array.from(
        new Set([
          BACKEND,
          'http://localhost:8000',
          'http://127.0.0.1:8000',
        ].filter(Boolean))
      )

      const errors: string[] = []

      try {
        for (const base of bases) {
          const cleanBase = String(base).replace(/\/$/, '')
          const url = `${cleanBase}/tools`

          try {
            const resp = await fetch(url)

            if (!resp.ok) {
              throw new Error(`${resp.status} ${resp.statusText}`)
            }

            const contentType = resp.headers.get('content-type') || ''

            if (!contentType.includes('application/json')) {
              throw new Error(`expected JSON, got ${contentType || 'unknown response'}`)
            }

            const data = await resp.json()
            const backendTools = extractTools(data)
            const backendErrors = extractToolErrors(data)

            if (cancelled) return

            if (backendTools.length > 0) {
              setTools(backendTools)
              setToolErrors(backendErrors)
              return
            }

            errors.push(`${url}: JSON response did not contain tools`)
          } catch (err: any) {
            errors.push(`${url}: ${err?.message || String(err)}`)
          }
        }

        if (!cancelled) {
          setTools([])
          setToolErrors([
            `No tools loaded. Local manifest count: ${localTools.length}. Backend checks: ${errors.join(
              ' | '
            )}`,
          ])
        }
      } finally {
        if (!cancelled) setLoadingTools(false)
      }
    }

    loadTools()

    return () => {
      cancelled = true
    }
  }, [])

  const addScatter = () => {
    const { firstNumeric: x, secondNumeric: y } = datasetSummary

    if (!x || !y) {
      pushToast('Need at least two numeric columns', 'warning')
      return
    }

    const id = `plot_${Math.random().toString(36).slice(2, 8)}`

    addPlot({
      id,
      type: 'scatter2d',
      x,
      y,
      panel: { i: id, x: 0, y: 9999, w: 6, h: 8 },
    })
  }

  const addScatter3D = () => {
    const { firstNumeric: x, secondNumeric: y, thirdNumeric: z } = datasetSummary

    if (!x || !y || !z) {
      pushToast('Need at least three numeric columns', 'warning')
      return
    }

    const id = `plot_${Math.random().toString(36).slice(2, 8)}`

    addPlot({
      id,
      type: 'scatter3d',
      x,
      y,
      z,
      panel: { i: id, x: 0, y: 9999, w: 6, h: 8 },
    })
  }

  const addHistogram = () => {
    const x = datasetSummary.firstNumeric

    if (!x) {
      pushToast('Need at least one numeric column', 'warning')
      return
    }

    const id = `plot_${Math.random().toString(36).slice(2, 8)}`

    addPlot({
      id,
      type: 'hist1d',
      x,
      panel: { i: id, x: 0, y: 9999, w: 6, h: 8 },
    })
  }

  return (
    <div className="container">
      <TopBar />

      <div className="tab-bar" ref={tabBarRef}>
        <span className="tab-indicator" aria-hidden />
        {TABS.map(({ id, label, Icon }, i) => (
          <button
            key={id}
            className={`tab-btn${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
            data-tip={`${label} — press ${i + 1}`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}

        {loadingTools && (
          <span className="legend" style={{ marginLeft: 8 }}>
            Loading tools...
          </span>
        )}
      </div>

      <div className="tab-description">{tabDescriptions[tab]}</div>

      {tab === 'visualization' && (
        <div className="notice">
          {hasDataset ? (
            <>
              <span className="notice-dot" />
              <span>
                <strong style={{ color: 'var(--fg)' }}>
                  {datasetSummary.moleculeCount.toLocaleString()}
                </strong>{' '}
                molecules ·{' '}
                <strong style={{ color: 'var(--fg)' }}>
                  {datasetSummary.numericCount}
                </strong>{' '}
                numeric columns
              </span>
            </>
          ) : (
            <>
              <span className="notice-dot notice-dot-idle" />
              <span>
                Select files in the toolbar above, then click{' '}
                <strong style={{ color: 'var(--fg)' }}>Build Dataset</strong> to begin.
              </span>
            </>
          )}
        </div>
      )}

      {toolErrors.length > 0 && (
        <div className="tool-warnings-banner">
          <span className="tool-warnings-title">Tool warnings</span>

          <div className="tool-warnings-list">
            {toolErrors.map(err => (
              <span key={err} className="legend">
                {err}
              </span>
            ))}
          </div>
        </div>
      )}

      <div
        className={tab === 'structure-generation' ? 'tab-pane tab-pane-active' : 'tab-pane'}
        style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
      >
        <StructureGuidedGenerationPage
          pendingRef={pendingRef}
          onPendingRefConsumed={() => setPendingRef(null)}
        />
      </div>

      <div
        className={tab === 'generation' ? 'tab-pane tab-pane-active' : 'tab-pane'}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
      >
        <GenerationPage
          onSendToStructureGuided={(xyz, name) => {
            setPendingRef({ xyz, name })
            setTab('structure-generation')
          }}
        />
      </div>

      <div
        className={tab === 'analysis' ? 'tab-pane tab-pane-active' : 'tab-pane'}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}
      >
        <AnalysisToolsPage stagedSources={stagedSources} setStagedSources={setStagedSources} />
      </div>

      <div
        className={tab === 'training' ? 'tab-pane tab-pane-active' : 'tab-pane'}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
      >
        <TrainingPage />
      </div>

      <div
        className={tab === 'management' ? 'tab-pane tab-pane-active' : 'tab-pane'}
        style={{ flex: 1, overflow: 'auto', padding: 12 }}
      >
        <ManagementPage
          stagedSources={stagedSources}
          setStagedSources={setStagedSources}
        />
      </div>

      {tab === 'plugins' ? (
        <div className="tab-pane-active" style={{ flex: 1, overflow: 'auto', padding: 12 }}>

          {tools.length === 0 ? (
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                No plug-in tools loaded
              </div>

              <div className="legend" style={{ lineHeight: 1.6 }}>
                No manifests were found by Vite and no backend tools endpoint was reachable.
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 16 }}>
              {tools.map(tool => (
                <ExternalToolPage key={tool.id} tool={tool} />
              ))}
            </div>
          )}
        </div>
      ) : tab === 'visualization' ? (
        <>
          <div className="action-bar">
            <button className="btn-action" onClick={addScatter} disabled={!hasDataset}>
              <SquarePlus size={14} />
              2D Scatter
            </button>

            <button className="btn-action" onClick={addScatter3D} disabled={!hasDataset}>
              <SquarePlus size={14} />
              3D Scatter
            </button>

            <button className="btn-action" onClick={addHistogram} disabled={!hasDataset}>
              <BarChart size={14} />
              Histogram
            </button>

            <div className="action-bar-sep" />

            <button
              className="btn-action btn-danger"
              onClick={() => setConfirmResetOpen(true)}
              disabled={!hasDataset}
            >
              <Trash2 size={14} />
              Reset
            </button>
          </div>

          <div className="main-area">
            {hasDataset && (
              <div className="table-info-row">
                <div className="card" style={{ paddingBottom: 4 }}>
                  <DataTable />
                </div>

                <div className="split-divider" onMouseDown={startInfoDrag} />
                <InfoPanel style={{ width: infoPanelWidth }} />
              </div>
            )}

            <div className="plot-area">
              {!hasDataset ? (
                <EmptyState />
              ) : (
                <RGL
                  className="rgl-grid"
                  cols={12}
                  rowHeight={60}
                  draggableHandle=".card-drag-handle"
                  compactType="vertical"
                  margin={[12, 12]}
                  containerPadding={[0, 0]}
                  resizeHandles={['s', 'e', 'se']}
                  onLayoutChange={layout => {
                    const currentPlots = plotsRef.current

                    for (const item of layout) {
                      if (item.i === VIEWER_KEY) {
                        setViewerLayout({
                          i: item.i,
                          x: item.x,
                          y: item.y,
                          w: item.w,
                          h: item.h,
                        })
                      } else {
                        const plot = currentPlots.find(p => p.id === item.i)

                        if (plot) {
                          updatePlot({
                            ...plot,
                            panel: {
                              i: item.i,
                              x: item.x,
                              y: item.y,
                              w: item.w,
                              h: item.h,
                            },
                          })
                        }
                      }
                    }
                  }}
                >
                  {plotIds.map(plotId => {
                    const panel = plots.find(p => p.id === plotId)?.panel

                    return (
                      <div
                        key={plotId}
                        className="card"
                        data-grid={panel ?? { x: 0, y: 9999, w: 6, h: 8 }}
                      >
                        <PlotPanel plotId={plotId} />
                      </div>
                    )
                  })}

                  <div key={VIEWER_KEY} className="card" data-grid={viewerLayout}>
                    <MoleculeViewer />
                  </div>
                </RGL>
              )}
            </div>
          </div>
        </>
      ) : null}

      {confirmResetOpen && (
        <div className="modal-overlay" onMouseDown={() => setConfirmResetOpen(false)}>
          <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-title">Reset workspace?</div>

            <div className="legend" style={{ marginBottom: 14, lineHeight: 1.6 }}>
              This will erase the current dataset, staged sources, descriptors, computed columns,
              filters, selections, plots, and source information from the current session. This
              action cannot be undone.
            </div>

            <div className="modal-actions">
              <button onClick={() => setConfirmResetOpen(false)}>Cancel</button>

              <button
                className="btn-danger"
                onClick={() => {
                  resetWorkspace()
                  setStagedSources([])
                  setPendingRef(null)
                  setConfirmResetOpen(false)
                  setTab('visualization')
                }}
              >
                Yes, reset
              </button>
            </div>
          </div>
        </div>
      )}

      {shortcutsOpen && (
        <div className="modal-overlay" onMouseDown={() => setShortcutsOpen(false)}>
          <div className="modal-card" onMouseDown={e => e.stopPropagation()}>
            <div className="modal-title">Keyboard shortcuts</div>
            <table className="shortcuts-table">
              <tbody>
                {TABS.map(({ id, label }, i) => (
                  <tr key={id}>
                    <td><kbd>{i + 1}</kbd></td>
                    <td>{label}</td>
                  </tr>
                ))}
                <tr>
                  <td><kbd>?</kbd></td>
                  <td>Show / hide this overlay</td>
                </tr>
                <tr>
                  <td><kbd>Esc</kbd></td>
                  <td>Close dialogs</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* <PerformancePanel /> */}
      <ToastHost />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <Atom size={34} strokeWidth={1.5} />
      </div>

      <div className="empty-state-title">No dataset loaded</div>

      <div className="empty-state-body">
        Choose a CSV file and XYZ folder or an ASE .db file using the controls in the toolbar,
        then click <strong>Build Dataset</strong> to begin exploring.
      </div>

      <div className="empty-state-arrow">
        <span>&#8593;</span> Use the toolbar above to load your data
      </div>
    </div>
  )
}
