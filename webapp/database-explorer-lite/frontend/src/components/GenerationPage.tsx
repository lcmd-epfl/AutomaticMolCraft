import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, ChevronDown, Download, FileArchive, Play, RefreshCw, Square, Wand2 } from 'lucide-react'
import { BACKEND } from '../config'
import RawXyzViewer from './RawXyzViewer'
import PresetsBar from './PresetsBar'
import { useUIStore } from '../store/uiStore'

type GenerationModel = {
  id: string
  name: string
  description: string
  task_type: string
  path: string
  has_stat: boolean
  properties: string[]
  property_labels: Record<string, string>
  defaults?: Record<string, any>
  capabilities?: {
    structure_completion?: boolean
    reference_indices?: number[]
    reference_freeze_mode?: string | null
    has_reference_scaffold?: boolean
  }
  model_details?: {
    architecture?: string | Record<string, unknown>
    num_parameters?: number
    hyperparameters?: Record<string, string | number | boolean>
    stats?: Array<{
      key: string
      label: string
      summary?: string | number
      histogram?: {
        bins: number[]
        counts: number[]
      }
    }>
  }
}

type MoleculeItem = {
  filename: string
  size: number
  modified_at: string
}

type JobStatus = {
  job_id: string
  status: string
  output_dir: string
  config_path: string
  log_tail?: string
  molecules?: string[]
  molecule_count?: number
  error?: string
  request?: {
    n_frames?: number
  }
}

type GenerationConfig = {
  numGenerate: number
  batchSize: number
  nFrames: number
  diffusionSteps: number
  seed: number
  sizeMode: 'random' | 'fixed' | 'range'
  fixedSize: number
  minSize: number
  maxSize: number
  cfgScale: number
  targets: Record<string, number>
  negativeTargets: Record<string, number | null>
}

const api = (path: string) => `${BACKEND}${path}`
const splitOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9]

async function downloadUrl(path: string, filename?: string) {
  const resp = await fetch(api(path))
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`)
  const blob = await resp.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || path.split('/').pop() || 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function downloadGenerated3dSvg(jobId: string, moleculeName: string) {
  const xyzResp = await fetch(
    api(`/generation/jobs/${jobId}/xyz/${encodeURIComponent(moleculeName)}`)
  )
  if (!xyzResp.ok) {
    throw new Error(`XYZ download failed: ${xyzResp.status} ${xyzResp.statusText}`)
  }
  const xyz = await xyzResp.text()
  const renderResp = await fetch(api('/render3d/from-xyz.svg'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mol_id: moleculeName, xyz }),
  })
  if (!renderResp.ok) {
    let detail = ''
    try {
      const payload = await renderResp.json()
      detail = payload?.detail || payload?.message || payload?.error || ''
    } catch {
      // use status fallback below
    }
    throw new Error(
      detail ||
      `xyzrender export failed: ${renderResp.status} ${renderResp.statusText}`
    )
  }
  const svgText = await renderResp.text()
  if (!svgText.slice(0, 4096).toLowerCase().includes('<svg')) {
    throw new Error('xyzrender returned invalid SVG output')
  }
  const blob = new Blob([svgText], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${moleculeName.replace(/\.[^/.]+$/, '') || 'molecule'}.svg`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function fetchXyzForTransfer(
  jobId: string,
  mol: string,
  cache: Record<string, string>
): Promise<string> {
  if (cache[mol]) return cache[mol]
  const resp = await fetch(api(`/generation/jobs/${jobId}/xyz/${encodeURIComponent(mol)}`))
  if (!resp.ok) throw new Error(`XYZ fetch failed: ${resp.status} ${resp.statusText}`)
  return resp.text()
}

function getGenerationGridClass(splitCount: number) {
  if (splitCount === 1) return 'viewer-split-1'
  if (splitCount === 2) return 'viewer-split-2'
  if (splitCount === 3) return 'viewer-split-3'
  if (splitCount === 4) return 'viewer-split-4'
  if (splitCount === 5) return 'viewer-split-5'
  if (splitCount >= 7) return 'viewer-split-9'
  return 'viewer-split-6'
}

function getGenerationViewerHeight(splitCount: number) {
  if (splitCount <= 1) return { minHeight: 280, height: '34vh' }
  if (splitCount <= 3) return { minHeight: 360, height: '42vh' }
  if (splitCount <= 6) return { minHeight: 520, height: '58vh' }
  return { minHeight: 680, height: '74vh' }
}

function getMinimumResultsFr(splitCount: number) {
  if (splitCount >= 7) return 1.7
  if (splitCount >= 4) return 1.35
  return 1.1
}

export default function GenerationPage({
  onSendToStructureGuided,
}: {
  onSendToStructureGuided: (xyz: string, name: string) => void
}) {
  const [models, setModels] = useState<GenerationModel[]>([])
  const [modelsDir, setModelsDir] = useState('')
  const [outputsDir, setOutputsDir] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelError, setModelError] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [showModelDetails, setShowModelDetails] = useState(false)
  const [showBasicParams, setShowBasicParams] = useState(true)
  const [showMolecularSize, setShowMolecularSize] = useState(true)
  const [showTargets, setShowTargets] = useState(true)
  const [expandedStatKey, setExpandedStatKey] = useState<string | null>(null)

  const [numGenerate, setNumGenerate] = useState(1)
  const [batchSize, setBatchSize] = useState(1)
  const [nFrames, setNFrames] = useState(1)
  const [diffusionSteps, setDiffusionSteps] = useState(50)
  const [seed, setSeed] = useState(86)
  const [sizeMode, setSizeMode] = useState<'random' | 'fixed' | 'range'>('random')
  const [fixedSize, setFixedSize] = useState(32)
  const [minSize, setMinSize] = useState(16)
  const [maxSize, setMaxSize] = useState(100)
  const [cfgScale, setCfgScale] = useState(1)
  const [targets, setTargets] = useState<Record<string, number>>({})
  const [negativeTargets, setNegativeTargets] = useState<Record<string, number | null>>({})
  const [negativeTargetDrafts, setNegativeTargetDrafts] = useState<Record<string, string>>({})

  const [job, setJob] = useState<JobStatus | null>(null)
  const [molecules, setMolecules] = useState<MoleculeItem[]>([])
  const [selectedMol, setSelectedMol] = useState('')
  const [recentGeneratedMols, setRecentGeneratedMols] = useState<string[]>([])
  const [splitCount, setSplitCount] = useState(1)
  const [xyzCache, setXyzCache] = useState<Record<string, string>>({})
  const [xyzErrors, setXyzErrors] = useState<Record<string, string>>({})
  const [paneViewMode, setPaneViewMode] = useState<Record<string, '3d' | 'denoising'>>({})
  const [trajectoryCache, setTrajectoryCache] = useState<Record<string, string>>({})
  const [trajectoryErrors, setTrajectoryErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [panelFr, setPanelFr] = useState<[number, number, number]>([0.9, 1.45, 1.1])
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth <= 1100)
  const [bgUserCustomized, setBgUserCustomized] = useState(false)
  const [backgroundColor, setBackgroundColor] = useState(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#0b0d10'
  )

  const theme = useUIStore(s => s.theme)

  useEffect(() => {
    if (bgUserCustomized) return
    const c = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim()
    if (c) setBackgroundColor(c)
  }, [theme, bgUserCustomized])

  const selectedModel = useMemo(
    () => models.find(m => m.id === selectedModelId) ?? null,
    [models, selectedModelId]
  )
  const selectedModelIsStructureCompletion = Boolean(selectedModel?.capabilities?.structure_completion)
  const visiblePaneMols = useMemo(() => recentGeneratedMols.slice(0, splitCount), [recentGeneratedMols, splitCount])
  const viewerHeight = useMemo(() => getGenerationViewerHeight(splitCount), [splitCount])
  const showTrajectoryUi = (job?.request?.n_frames ?? 1) > 1

  const currentConfig = useMemo<Record<string, unknown>>(
    () => ({ numGenerate, batchSize, nFrames, diffusionSteps, seed,
             sizeMode, fixedSize, minSize, maxSize, cfgScale,
             targets, negativeTargets }),
    [numGenerate, batchSize, nFrames, diffusionSteps, seed,
     sizeMode, fixedSize, minSize, maxSize, cfgScale, targets, negativeTargets]
  )

  const loadPreset = (config: Record<string, unknown>) => {
    if (typeof config.numGenerate === 'number') setNumGenerate(config.numGenerate)
    if (typeof config.batchSize === 'number') setBatchSize(config.batchSize)
    if (typeof config.nFrames === 'number') setNFrames(config.nFrames)
    if (typeof config.diffusionSteps === 'number') setDiffusionSteps(config.diffusionSteps)
    if (typeof config.seed === 'number') setSeed(config.seed)
    if (config.sizeMode === 'random' || config.sizeMode === 'fixed' || config.sizeMode === 'range')
      setSizeMode(config.sizeMode)
    if (typeof config.fixedSize === 'number') setFixedSize(config.fixedSize)
    if (typeof config.minSize === 'number') setMinSize(config.minSize)
    if (typeof config.maxSize === 'number') setMaxSize(config.maxSize)
    if (typeof config.cfgScale === 'number') setCfgScale(config.cfgScale)
    if (config.targets !== null && typeof config.targets === 'object' && !Array.isArray(config.targets))
      setTargets(config.targets as Record<string, number>)
    if (config.negativeTargets !== null && typeof config.negativeTargets === 'object' && !Array.isArray(config.negativeTargets)) {
      const loaded = config.negativeTargets as Record<string, number | null>
      setNegativeTargets(loaded)
      setNegativeTargetDrafts(
        Object.fromEntries(Object.entries(loaded).map(([k, v]) => [k, v == null ? '-' : String(v)]))
      )
    }
  }

  const clearGeneratedPreview = () => {
    setSelectedMol('')
    setRecentGeneratedMols([])
    setXyzCache({})
    setXyzErrors({})
    setPaneViewMode({})
    setTrajectoryErrors({})
    setTrajectoryCache(current => {
      Object.values(current).forEach(url => URL.revokeObjectURL(url))
      return {}
    })
  }

  const setTotalMolecules = (value: number) => {
    const next = Math.max(1, Math.floor(value || 1))
    setNumGenerate(next)
    if (batchSize > next) setBatchSize(next)
  }

  const setGenerationBatchSize = (value: number) => {
    const next = Math.max(1, Math.floor(value || 1))
    setBatchSize(next)
    if (numGenerate < next) setNumGenerate(next)
  }

  const loadModels = async () => {
    setLoadingModels(true)
    setModelError('')
    try {
      const resp = await fetch(api('/generation/models'))
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
      const data = await resp.json()
      const nextModels = Array.isArray(data.models) ? data.models : []
      setModels(nextModels)
      setModelsDir(data.models_dir || '')
      setOutputsDir(data.outputs_dir || '')
      setSelectedModelId(current => current || nextModels[0]?.id || '')
    } catch (err: any) {
      setModelError(err?.message || String(err))
    } finally {
      setLoadingModels(false)
    }
  }

  const [molcraftAvailable, setMolcraftAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    fetch(`${BACKEND}/healthz`)
      .then(r => r.json())
      .then(d => setMolcraftAvailable(d.molcraft_available ?? true))
      .catch(() => setMolcraftAvailable(null))
  }, [])

  useEffect(() => {
    loadModels()
  }, [])
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth <= 1100)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    setShowModelDetails(false)
    setExpandedStatKey(null)
    if (!selectedModel) return
    const defaults = selectedModel.defaults || {}
    if (typeof defaults.num_generate === 'number') setNumGenerate(defaults.num_generate)
    if (typeof defaults.batch_size === 'number') setBatchSize(defaults.batch_size)
    if (typeof defaults.diffusion_steps === 'number') setDiffusionSteps(defaults.diffusion_steps)
    const nextTargets: Record<string, number> = {}
    const nextNegative: Record<string, number | null> = {}
    for (const prop of selectedModel.properties || []) {
      nextTargets[prop] = Number(defaults?.target_values?.[prop] ?? 0)
      nextNegative[prop] = null
    }
    setTargets(nextTargets)
    setNegativeTargets(nextNegative)
    setNegativeTargetDrafts(
      Object.fromEntries((selectedModel.properties || []).map(prop => [prop, '-']))
    )
  }, [selectedModelId])

  useEffect(() => {
    if (!job?.job_id || !['queued', 'running'].includes(job.status)) return
    const timer = window.setInterval(async () => {
      try {
        const resp = await fetch(api(`/generation/jobs/${job.job_id}`))
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
        const data = await resp.json()
        setJob(data)
      } catch (err) {
        console.error('Failed to poll generation job:', err)
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [job?.job_id, job?.status])

  const refreshMolecules = async (jobId = job?.job_id) => {
    if (!jobId) return
    const resp = await fetch(api(`/generation/jobs/${jobId}/molecules`))
    if (!resp.ok) return
    const data = await resp.json()
    const next = Array.isArray(data.molecules) ? data.molecules : []
    const validFilenames = new Set(next.map((mol: MoleculeItem) => mol.filename))
    const defaultFilenames = next.slice(0, 9).map((mol: MoleculeItem) => mol.filename)
    setMolecules(next)
    setSelectedMol(current => validFilenames.has(current) ? current : defaultFilenames[0] || '')
    setRecentGeneratedMols(current => {
      const kept = current.filter(filename => validFilenames.has(filename))
      return kept.length ? kept : defaultFilenames
    })
    setXyzCache(current => {
      const entries = Object.entries(current).filter(([filename]) => validFilenames.has(filename))
      return Object.fromEntries(entries)
    })
    setXyzErrors(current => {
      const entries = Object.entries(current).filter(([filename]) => validFilenames.has(filename))
      return Object.fromEntries(entries)
    })
    setPaneViewMode(current => {
      const entries = Object.entries(current).filter(([filename]) => validFilenames.has(filename))
      return Object.fromEntries(entries)
    })
    setTrajectoryErrors(current => {
      const entries = Object.entries(current).filter(([filename]) => validFilenames.has(filename))
      return Object.fromEntries(entries)
    })
    setTrajectoryCache(current => {
      const entries = Object.entries(current).filter(([filename]) => validFilenames.has(filename))
      const next: Record<string, string> = Object.fromEntries(entries)
      Object.entries(current).forEach(([filename, url]) => {
        if (!validFilenames.has(filename)) URL.revokeObjectURL(url)
      })
      return next
    })
  }

  useEffect(() => {
    if (!job?.job_id) return
    refreshMolecules(job.job_id)
  }, [job?.job_id, job?.status, job?.molecule_count])

  useEffect(() => {
    if (!job?.job_id) return
    const missing = visiblePaneMols.filter(filename => !xyzCache[filename] && !xyzErrors[filename])
    if (!missing.length) return
    let cancelled = false
    missing.forEach(filename => {
      ;(async () => {
        try {
          const resp = await fetch(api(`/generation/jobs/${job.job_id}/xyz/${encodeURIComponent(filename)}`))
          if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
          const text = await resp.text()
          if (!cancelled) {
            setXyzCache(current => ({ ...current, [filename]: text }))
            setXyzErrors(current => {
              if (!current[filename]) return current
              const next = { ...current }
              delete next[filename]
              return next
            })
          }
        } catch (err: any) {
          if (!cancelled) {
            setXyzErrors(current => ({ ...current, [filename]: err?.message || String(err) }))
          }
        }
      })()
    })
    return () => { cancelled = true }
  }, [job?.job_id, visiblePaneMols, xyzCache, xyzErrors])

  useEffect(() => {
    if (isNarrow) return
    const minimumResultsFr = getMinimumResultsFr(splitCount)
    setPanelFr(current => {
      if (current[2] >= minimumResultsFr) return current
      return [current[0], current[1], minimumResultsFr]
    })
  }, [isNarrow, splitCount])

  const togglePaneMolecule = (filename: string, checked: boolean) => {
    setSelectedMol(filename)
    setRecentGeneratedMols(current => {
      if (!checked) return current.filter(item => item !== filename)
      if (current.includes(filename)) return current
      return [...current, filename].slice(0, 9)
    })
    if (checked) {
      setXyzErrors(current => {
        if (!current[filename]) return current
        const next = { ...current }
        delete next[filename]
        return next
      })
    }
  }

  const handleSplitCountChange = (value: string) => {
    const next = Math.max(1, Math.min(9, Number(value) || 1))
    setSplitCount(next)
  }

  const renderGeneratedPane = (filename: string | undefined, idx: number) => {
    if (!filename) {
      return <div className="generation-empty">Empty pane</div>
    }
    if (xyzErrors[filename]) {
      return <div className="generation-empty">Failed to load {filename}</div>
    }
    const xyz = xyzCache[filename]
    const mode = paneViewMode[filename] || '3d'
    const trajectoryUrl = trajectoryCache[filename]
    const trajectoryError = trajectoryErrors[filename]
    if (!xyz) {
      return <div className="generation-empty">Loading {filename}</div>
    }
    return (
      <>
        <button
          type="button"
          className={`viewer-pane-tab${selectedMol === filename ? ' viewer-pane-tab-active' : ''}`}
          onClick={() => setSelectedMol(filename)}
        >
          <span className="viewer-pane-id">Pane {idx + 1}: {filename}</span>
        </button>
        {showTrajectoryUi && (
          <div className="viewer-pane-modes">
            <button
              type="button"
              className={`viewer-pane-mode-btn${mode === '3d' ? ' active' : ''}`}
              onClick={() => setPaneViewMode(current => ({ ...current, [filename]: '3d' }))}
            >
              3D
            </button>
            <button
              type="button"
              className={`viewer-pane-mode-btn${mode === 'denoising' ? ' active' : ''}`}
              onClick={() => setPaneViewMode(current => ({ ...current, [filename]: 'denoising' }))}
            >
              Denoising
            </button>
          </div>
        )}
        <div className="viewer-pane-canvas">
          {mode === 'denoising' && showTrajectoryUi ? (
            trajectoryUrl ? (
              <img className="generation-trajectory-gif" src={trajectoryUrl} alt={`Denoising trajectory for ${filename}`} />
            ) : trajectoryError ? (
              <div className="generation-pane-warning">{trajectoryError}</div>
            ) : (
              <div className="generation-empty">Rendering denoising trajectory…</div>
            )
          ) : (
            <RawXyzViewer xyz={xyz} backgroundColor={backgroundColor} />
          )}
        </div>
      </>
    )
  }

  useEffect(() => {
    if (!job?.job_id || !showTrajectoryUi) return
    const pending = visiblePaneMols.filter(filename => {
      if ((paneViewMode[filename] || '3d') !== 'denoising') return false
      return !trajectoryCache[filename] && !trajectoryErrors[filename]
    })
    if (!pending.length) return
    let cancelled = false
    pending.forEach(filename => {
      ;(async () => {
        try {
          const resp = await fetch(api(`/generation/jobs/${job.job_id}/trajectory/${encodeURIComponent(filename)}`))
          const contentType = (resp.headers.get('content-type') || '').toLowerCase()
          if (!resp.ok) {
            let message = `${resp.status} ${resp.statusText}`
            if (contentType.includes('application/json')) {
              const data = await resp.json()
              message = data?.message || data?.detail || data?.error || message
            }
            throw new Error(message)
          }
          const blob = await resp.blob()
          const url = URL.createObjectURL(blob)
          if (cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          setTrajectoryCache(current => {
            const old = current[filename]
            if (old) URL.revokeObjectURL(old)
            return { ...current, [filename]: url }
          })
          setTrajectoryErrors(current => {
            if (!current[filename]) return current
            const next = { ...current }
            delete next[filename]
            return next
          })
        } catch (err: any) {
          if (!cancelled) {
            setTrajectoryErrors(current => ({ ...current, [filename]: err?.message || String(err) }))
          }
        }
      })()
    })
    return () => { cancelled = true }
  }, [job?.job_id, paneViewMode, showTrajectoryUi, visiblePaneMols, trajectoryCache, trajectoryErrors])

  useEffect(() => {
    if (!job?.job_id) {
      clearGeneratedPreview()
      return
    }
  }, [job?.job_id])

  const submitJob = async () => {
    if (!selectedModel) return
    let nextNumGenerate = Math.max(1, Math.floor(numGenerate || 1))
    let nextBatchSize = Math.max(1, Math.floor(batchSize || 1))
    let nextDiffusionSteps = Math.max(1, Math.floor(diffusionSteps || 50))
    if (!Number.isFinite(nextDiffusionSteps) || nextDiffusionSteps <= 0) nextDiffusionSteps = 50
    if (nextDiffusionSteps < 2) nextDiffusionSteps = 2
    let nextNFrames = Math.max(1, Math.floor(nFrames || 1))
    if (nextNFrames >= nextDiffusionSteps) nextNFrames = nextDiffusionSteps - 1
    if (nextNumGenerate <= nextBatchSize) nextNumGenerate = nextBatchSize + 1

    setNumGenerate(nextNumGenerate)
    setBatchSize(nextBatchSize)
    setDiffusionSteps(nextDiffusionSteps)
    setNFrames(nextNFrames)

    const propNames = selectedModel.properties || []
    const negatives = propNames.map(name => negativeTargets[name])
    const allNegativeNull = negatives.every(v => v == null)
    const allNegativeSet = negatives.every(v => v != null)
    if (!allNegativeNull && !allNegativeSet) {
      setJob({
        job_id: '',
        status: 'failed',
        output_dir: '',
        config_path: '',
        error: 'For multiple properties, negative targets must be all null ("-") or all specified.',
      })
      return
    }

    setSubmitting(true)
    try {
      const propertyTargets = (selectedModel.properties || []).map(name => ({
        name,
        target: Number(targets[name] ?? 0),
        negative_target: negativeTargets[name] == null ? null : Number(negativeTargets[name]),
      }))
      const resp = await fetch(api('/generation/jobs'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model_id: selectedModel.id,
          num_generate: nextNumGenerate,
          batch_size: nextBatchSize,
          n_frames: nextNFrames,
          diffusion_steps: nextDiffusionSteps,
          seed,
          size_mode: sizeMode,
          fixed_size: fixedSize,
          min_size: minSize,
          max_size: maxSize,
          cfg_scale: cfgScale,
          property_targets: selectedModel.properties.length ? propertyTargets : [],
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data?.detail || data?.message || `${resp.status} ${resp.statusText}`)
      setJob(data)
      setMolecules([])
      clearGeneratedPreview()
    } catch (err: any) {
      setJob({
        job_id: '',
        status: 'failed',
        output_dir: '',
        config_path: '',
        error: err?.message || String(err),
      })
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !event.shiftKey || event.repeat) return
      if (event.defaultPrevented || !selectedModel || submitting) return
      event.preventDefault()
      void submitJob()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedModel, submitting, submitJob])

  const cancelJob = async () => {
    if (!job?.job_id) return
    const resp = await fetch(api(`/generation/jobs/${job.job_id}`), { method: 'DELETE' })
    if (resp.ok) setJob(await resp.json())
  }

  const refreshGenerationState = async () => {
    setNumGenerate(1)
    setBatchSize(1)
    setNFrames(1)
    setDiffusionSteps(50)
    setSeed(86)
    setSizeMode('random')
    setFixedSize(32)
    setMinSize(16)
    setMaxSize(100)
    setCfgScale(1)
    setTargets({})
    setNegativeTargets({})
    setNegativeTargetDrafts({})
    setJob(null)
    setMolecules([])
    clearGeneratedPreview()
    await loadModels()
  }

  const dragSplitter = (splitterIndex: 0 | 1, startX: number) => {
    const start = [...panelFr] as [number, number, number]
    const onMove = (e: MouseEvent) => {
      const dx = (e.clientX - startX) / window.innerWidth
      const delta = dx * 2.2
      const next = [...start] as [number, number, number]
      if (splitterIndex === 0) {
        next[0] = Math.max(0.65, Math.min(2.2, start[0] + delta))
        next[1] = Math.max(0.85, Math.min(3.2, start[1] - delta))
      } else {
        next[1] = Math.max(0.85, Math.min(3.2, start[1] + delta))
        next[2] = Math.max(0.8, Math.min(2.4, start[2] - delta))
      }
      setPanelFr(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className="generation-page"
      style={isNarrow ? undefined : { gridTemplateColumns: `${panelFr[0]}fr 8px ${panelFr[1]}fr 8px ${panelFr[2]}fr` }}
    >
      {molcraftAvailable === false && (
        <div className="molcraft-banner">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            <strong>MolCraftDiff is not installed.</strong> This feature requires the MolCraftDiff
            command-line tool.{' '}
            <a
              href="https://preghosh.github.io/MolCraftDiffusion/installation.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              View installation guide →
            </a>
          </span>
        </div>
      )}
      <aside className="generation-panel generation-models">
        <div className="generation-panel-head">
          <div>
            <div className="generation-panel-title">Models</div>
            <div className="legend">{models.length} discovered</div>
          </div>
          <button className="btn-icon" onClick={loadModels} disabled={loadingModels} title="Refresh models">
            <RefreshCw size={15} />
          </button>
        </div>

        {modelError && <div className="generation-error">{modelError}</div>}
        <div className="generation-path">{modelsDir || 'No model directory reported'}</div>

        <div className="generation-model-list">
          {models.map(model => (
            <button
              key={model.id}
              className={`generation-model-row${selectedModelId === model.id ? ' active' : ''}`}
              onClick={() => setSelectedModelId(model.id)}
            >
              <span>{model.name}</span>
              <small>{model.properties.length ? 'CFG' : 'Unconditional'}</small>
            </button>
          ))}
          {!models.length && !loadingModels && (
            <div className="generation-empty">No folders containing edm_chem.pkl were found.</div>
          )}
        </div>

        {selectedModel && (
          <div className="generation-meta">
            <div className="generation-meta-title">{selectedModel.name}</div>
            <div className="legend">{selectedModel.description || 'No description available.'}</div>
            <dl>
              <dt>Task</dt><dd>{selectedModel.properties.length ? 'CFG conditional' : 'Unconditional'}</dd>
              <dt>Stat file</dt><dd>{selectedModel.has_stat ? 'edm_stat.pkl present' : 'Missing'}</dd>
              <dt>Path</dt><dd>{selectedModel.path}</dd>
            </dl>
            <button
              className="generation-details-toggle"
              onClick={() => setShowModelDetails(v => !v)}
            >
              {showModelDetails ? 'Hide' : 'Show'} Model Details
            </button>
            {showModelDetails && (
              <div className="generation-details-drawer">
                <dl>
                  <dt>Architecture</dt>
                  <dd>{renderArchitecture(selectedModel.model_details?.architecture)}</dd>
                  <dt>Parameters</dt>
                  <dd>{formatParameters(selectedModel.model_details?.num_parameters)}</dd>
                </dl>
                {selectedModel.model_details?.hyperparameters && (
                  <div className="generation-hparams">
                    {Object.entries(selectedModel.model_details.hyperparameters).map(([key, value]) => (
                      <div className="generation-hparam-row" key={key}>
                        <span>{key}</span>
                        <code>{String(value)}</code>
                      </div>
                    ))}
                  </div>
                )}
                {!selectedModel.model_details && (
                  <div className="legend">No model details were extracted.</div>
                )}
              </div>
            )}
            {showModelDetails && (
              <div className="generation-stat-grid">
                {(selectedModel.model_details?.stats || []).map(stat => (
                  <div className="generation-stat-card" key={stat.key}>
                    <div className="generation-stat-head">
                      <strong>{stat.label || stat.key}</strong>
                      <div className="generation-stat-head-actions">
                        {typeof stat.summary !== 'undefined' && <span>{String(stat.summary)}</span>}
                        {stat.histogram && (
                          <button
                            className="generation-stat-expand"
                            onClick={() => setExpandedStatKey(stat.key)}
                          >
                            Expand
                          </button>
                        )}
                      </div>
                    </div>
                    {stat.histogram ? (
                      <MiniHistogram bins={stat.histogram.bins} counts={stat.histogram.counts} />
                    ) : (
                      <div className="generation-stat-empty">No histogram available</div>
                    )}
                  </div>
                ))}
                {!selectedModel.model_details?.stats?.length && (
                  <div className="generation-stat-empty">No distribution stats found.</div>
                )}
              </div>
            )}
            {showModelDetails && expandedStatKey && (
              <ExpandedHistogramPanel
                stat={(selectedModel.model_details?.stats || []).find(s => s.key === expandedStatKey) || null}
                onClose={() => setExpandedStatKey(null)}
              />
            )}
          </div>
        )}
      </aside>
      {!isNarrow && <div className="generation-splitter" onMouseDown={e => dragSplitter(0, e.clientX)} />}

      <main className="generation-panel generation-settings">
        <div className="generation-panel-head">
          <div>
            <div className="generation-panel-title">Generation</div>
            <div className="legend">MolCraftDiff generate</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={refreshGenerationState} disabled={submitting} title="Refresh generation state">
              <RefreshCw size={14} />
              Refresh state
            </button>
            <button
              className="btn-primary"
              onClick={submitJob}
              disabled={!selectedModel || submitting}
              title="Generate (Shift+Enter)"
            >
              <Play size={14} />
              Generate
            </button>
          </div>
        </div>

        <PresetsBar page="generation" currentConfig={currentConfig} onLoad={loadPreset} />

        <section className="generation-section">
          <div className="generation-section-title collapsible" onClick={() => setShowBasicParams(v => !v)}>
            <ChevronDown size={13} style={{ transform: showBasicParams ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
            Basic Parameters
          </div>
          {showBasicParams && (
            <>
              <div className="generation-form-grid">
                <NumberField label="Total molecules" value={numGenerate} setValue={setTotalMolecules} min={1} />
                <NumberField label="Batch size" value={batchSize} setValue={setGenerationBatchSize} min={1} max={256} />
                <NumberField label="Frames" value={nFrames} setValue={setNFrames} min={1} max={100} />
                <NumberField label="Diffusion steps" value={diffusionSteps} setValue={setDiffusionSteps} min={1} max={1000} />
                <NumberField label="Seed" value={seed} setValue={setSeed} min={0} max={999999} />
                <NumberField label="Max size" value={maxSize} setValue={setMaxSize} min={1} max={512} />
              </div>
              <div className="generation-help">
                Batch size is the number of molecules sampled per diffusion pass. Total molecules controls how many XYZ files are produced.
              </div>
              {selectedModelIsStructureCompletion && (
                <div className="generation-warning">
                  This model was trained for structure completion, recommend to use strcutrue-direct gen tab (outpaint)
                </div>
              )}
            </>
          )}
        </section>

        <section className="generation-section">
          <div className="generation-section-title collapsible" onClick={() => setShowMolecularSize(v => !v)}>
            <ChevronDown size={13} style={{ transform: showMolecularSize ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
            Molecular Size
          </div>
          {showMolecularSize && (
            <>
              <div className="segmented">
                {(['random', 'fixed', 'range'] as const).map(mode => (
                  <button key={mode} className={sizeMode === mode ? 'active' : ''} onClick={() => setSizeMode(mode)}>
                    {mode}
                  </button>
                ))}
              </div>
              {sizeMode === 'fixed' && <NumberField label="Fixed atom count" value={fixedSize} setValue={setFixedSize} min={1} max={512} />}
              {sizeMode === 'range' && (
                <div className="generation-form-grid compact">
                  <NumberField label="Minimum" value={minSize} setValue={setMinSize} min={1} max={512} />
                  <NumberField label="Maximum" value={maxSize} setValue={setMaxSize} min={1} max={512} />
                </div>
              )}
            </>
          )}
        </section>

        {selectedModel?.properties?.length ? (
          <section className="generation-section">
            <div className="generation-section-title collapsible" onClick={() => setShowTargets(v => !v)}>
              <ChevronDown size={13} style={{ transform: showTargets ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
              Conditional Targets
            </div>
            {showTargets && (
              <>
                <NumberField label="CFG scale" value={cfgScale} setValue={setCfgScale} min={0} max={5} step={0.1} />
                {selectedModel.properties.map(prop => (
                  <div className="generation-property-row" key={prop}>
                    <div className="generation-property-name">{selectedModel.property_labels?.[prop] || prop}</div>
                    <NumberField label="Target" value={targets[prop] ?? 0} setValue={v => setTargets(t => ({ ...t, [prop]: v }))} min={-20} max={20} step={0.1} />
                    <label className="generation-field">
                      <span>Negative</span>
                      <input
                        type="text"
                        value={negativeTargetDrafts[prop] ?? '-'}
                        onChange={e => {
                          const raw = e.target.value
                          setNegativeTargetDrafts(t => ({ ...t, [prop]: raw }))
                          const trimmed = raw.trim()
                          if (trimmed === '' || trimmed === '-') {
                            setNegativeTargets(t => ({ ...t, [prop]: null }))
                            return
                          }
                          const parsed = Number(trimmed)
                          if (Number.isFinite(parsed)) {
                            setNegativeTargets(t => ({ ...t, [prop]: parsed }))
                          }
                        }}
                        onBlur={() => {
                          const raw = (negativeTargetDrafts[prop] ?? '').trim()
                          if (raw === '' || raw === '-') {
                            setNegativeTargetDrafts(t => ({ ...t, [prop]: '-' }))
                            setNegativeTargets(t => ({ ...t, [prop]: null }))
                            return
                          }
                          const parsed = Number(raw)
                          if (!Number.isFinite(parsed)) {
                            const prev = negativeTargets[prop]
                            setNegativeTargetDrafts(t => ({ ...t, [prop]: prev == null ? '-' : String(prev) }))
                            return
                          }
                          setNegativeTargetDrafts(t => ({ ...t, [prop]: String(parsed) }))
                          setNegativeTargets(t => ({ ...t, [prop]: parsed }))
                        }}
                      />
                    </label>
                  </div>
                ))}
              </>
            )}
          </section>
        ) : (
          <section className="generation-section">
            <div className="generation-section-title collapsible" onClick={() => setShowTargets(v => !v)}>
              <ChevronDown size={13} style={{ transform: showTargets ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
              Mode
            </div>
            {showTargets && (
              <div className="generation-mode"><Wand2 size={15} /> Unconditional generation</div>
            )}
          </section>
        )}
      </main>
      {!isNarrow && <div className="generation-splitter" onMouseDown={e => dragSplitter(1, e.clientX)} />}

      <aside className="generation-panel generation-results">
        <div className="generation-panel-head">
          <div>
            <div className="generation-panel-title">Results</div>
            <div className="legend">{job?.status || 'No job submitted'}</div>
          </div>
          {job?.job_id && ['queued', 'running'].includes(job.status) && (
            <button className="btn-danger" onClick={cancelJob}><Square size={13} /> Stop</button>
          )}
        </div>

        {job?.error && <div className="generation-error">{job.error}</div>}
        {job?.job_id && (
          <>
            <div className={`generation-status ${job.status}`}>{job.status}</div>
            <div className="generation-path">{job.output_dir}</div>
            <div className="generation-result-actions">
              <button disabled={!molecules.length} onClick={() => downloadUrl(`/generation/jobs/${job.job_id}/bundle.zip`)}>
                <FileArchive size={14} /> XYZ zip
              </button>
              <button onClick={() => refreshMolecules()}>
                <RefreshCw size={14} /> Refresh
              </button>
            </div>
          </>
        )}

        {molecules.length > 0 && (
          <div className="generation-display-picker">
            <div className="row gap-sm" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="legend">
                {molecules.length} molecule{molecules.length !== 1 ? 's' : ''} — showing {visiblePaneMols.length}
              </span>
              <button
                type="button"
                className="legend"
                style={{ padding: '1px 6px', cursor: 'pointer' }}
                onClick={() => setRecentGeneratedMols(molecules.slice(0, 9).map(m => m.filename))}
              >
                All
              </button>
              <button
                type="button"
                className="legend"
                style={{ padding: '1px 6px', cursor: 'pointer' }}
                onClick={() => { setRecentGeneratedMols([]); setSelectedMol('') }}
              >
                Reset
              </button>
              <label className="generation-split-select">
                <span>Split</span>
                <select value={splitCount} onChange={e => handleSplitCountChange(e.target.value)}>
                  {splitOptions.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 72, overflowY: 'auto', marginTop: 4 }}>
              {molecules.map(mol => {
                const active = recentGeneratedMols.includes(mol.filename)
                const disabled = !active && recentGeneratedMols.length >= 9
                return (
                  <button
                    key={mol.filename}
                    type="button"
                    className="legend"
                    disabled={disabled}
                    style={{
                      padding: '2px 8px',
                      borderRadius: 12,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      border: '1px solid',
                      borderColor: active ? 'var(--color-accent)' : 'var(--color-border)',
                      background: active ? 'var(--color-accent-soft)' : 'transparent',
                      color: 'var(--color-text)',
                      opacity: active ? 1 : disabled ? 0.25 : 0.55,
                    }}
                    onClick={() => togglePaneMolecule(mol.filename, !active)}
                  >
                    {mol.filename}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="generation-viewer-wrap" style={viewerHeight}>
          <div className={`viewer-split-grid ${getGenerationGridClass(splitCount)}`}>
            {Array.from({ length: splitCount }, (_, idx) => {
              const filename = visiblePaneMols[idx]
              return (
                <div
                  className={`viewer-pane${filename && selectedMol === filename ? ' viewer-pane-active' : ''}`}
                  key={`${idx}-${filename || 'empty'}`}
                >
                  {renderGeneratedPane(filename, idx)}
                </div>
              )
            })}
          </div>
        </div>

        {job?.job_id && selectedMol && (
          <div className="generation-result-actions">
            <button onClick={() => downloadUrl(`/generation/jobs/${job.job_id}/xyz/${encodeURIComponent(selectedMol)}`, selectedMol)}>
              <Download size={14} /> XYZ
            </button>
            <button
              onClick={() => {
                void downloadGenerated3dSvg(job.job_id, selectedMol).catch(err => {
                  console.error('Failed to export 3D SVG with xyzrender:', err)
                  window.alert(err?.message || 'Failed to export 3D SVG.')
                })
              }}
            >
              <Download size={14} /> SVG
            </button>
            <button
              onClick={() => {
                void fetchXyzForTransfer(job.job_id, selectedMol, xyzCache)
                  .then(xyz => onSendToStructureGuided(xyz, selectedMol))
                  .catch(err => window.alert(err?.message || 'Failed to fetch XYZ.'))
              }}
            >
              <ArrowRight size={14} /> Use as ref
            </button>
          </div>
        )}

        {job?.log_tail && <pre className="generation-log">{job.log_tail}</pre>}
        {!job && <div className="generation-path">Outputs root: {outputsDir || 'not loaded'}</div>}
      </aside>
    </div>
  )
}

function ExpandedHistogramPanel({
  stat,
  onClose,
}: {
  stat: { key: string; label: string; histogram?: { bins: number[]; counts: number[] } } | null
  onClose: () => void
}) {
  if (!stat?.histogram) return null
  const { bins, counts } = stat.histogram
  const n = Math.min(bins.length, counts.length)
  if (!n) return null
  const width = 520
  const height = 260
  const pad = { l: 54, r: 18, t: 14, b: 42 }
  const innerW = width - pad.l - pad.r
  const innerH = height - pad.t - pad.b
  const maxY = Math.max(...counts.map(v => Number(v) || 0), 1e-12)
  const yTicks = 4
  const xTicks = 6
  const tickIndices = Array.from({ length: xTicks + 1 }).map((_, i) =>
    Math.min(n - 1, Math.round((i / xTicks) * (n - 1)))
  )
  const uniqueBinValues = new Set(bins.map(v => Number(v))).size
  const minVal = bins[0]
  const maxVal = bins[n - 1]
  return (
    <div className="generation-expanded-hist">
      <div className="generation-expanded-head">
        <strong>{stat.label}</strong>
        <span className="generation-expanded-range">{fmtBinVal(minVal)} – {fmtBinVal(maxVal)}</span>
        <button onClick={onClose}>Back</button>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="generation-expanded-svg" role="img" aria-label={`${stat.label} histogram`}>
        <rect x={pad.l} y={pad.t} width={innerW} height={innerH} fill="transparent" stroke="var(--border)" />
        {Array.from({ length: yTicks + 1 }).map((_, i) => {
          const v = (maxY * i) / yTicks
          const y = pad.t + innerH - (v / maxY) * innerH
          return (
            <g key={`y-${i}`}>
              <line x1={pad.l} y1={y} x2={pad.l + innerW} y2={y} stroke="var(--border)" opacity="0.45" />
              <text x={pad.l - 6} y={y + 4} textAnchor="end" className="generation-axis-label">
                {v.toExponential(1)}
              </text>
            </g>
          )
        })}
        {Array.from({ length: xTicks + 1 }).map((_, i) => {
          const x = pad.l + (i / xTicks) * innerW
          const idx = tickIndices[i]
          const raw = bins[idx]
          const v = uniqueBinValues <= 1 ? idx : raw
          return (
            <g key={`x-${i}`}>
              <line x1={x} y1={pad.t} x2={x} y2={pad.t + innerH} stroke="var(--border)" opacity="0.3" />
              <text x={x} y={pad.t + innerH + 18} textAnchor="middle" className="generation-axis-label">
                {Number.isInteger(v) ? v : v.toFixed(1)}
              </text>
            </g>
          )
        })}
        {counts.slice(0, n).map((value, i) => {
          const barW = innerW / n
          const h = ((Number(value) || 0) / maxY) * innerH
          const x = pad.l + i * barW
          const y = pad.t + innerH - h
          return <rect key={i} x={x} y={y} width={Math.max(1, barW - 0.6)} height={h} fill="var(--accent)" opacity="0.86" />
        })}
      </svg>
    </div>
  )
}

function renderArchitecture(architecture?: string | Record<string, unknown>) {
  if (!architecture) return 'Not available'
  if (typeof architecture === 'string') return architecture
  try {
    return JSON.stringify(architecture)
  } catch {
    return String(architecture)
  }
}

function formatParameters(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Not available'
  return value.toLocaleString()
}

function fmtBinVal(v: number): string {
  const a = Math.abs(v)
  if (!Number.isFinite(v)) return String(v)
  if (Number.isInteger(v)) return String(v)
  if (a >= 1000 || (a > 0 && a < 0.01)) return v.toExponential(2)
  return v.toPrecision(3).replace(/\.?0+$/, '')
}

function MiniHistogram({ bins, counts }: { bins: number[]; counts: number[] }) {
  const n = Math.min(bins.length, counts.length)
  if (!n) return <div className="generation-stat-empty">Empty histogram</div>
  const targetBars = 40
  const step = Math.max(1, Math.ceil(n / targetBars))
  const compactBins: number[] = []
  const compactCounts: number[] = []
  for (let i = 0; i < n; i += step) {
    const chunkBins = bins.slice(i, i + step)
    const chunkCounts = counts.slice(i, i + step).map(v => Number(v) || 0)
    if (!chunkCounts.length) continue
    compactBins.push(chunkBins[Math.floor(chunkBins.length / 2)] ?? bins[i])
    compactCounts.push(chunkCounts.reduce((acc, v) => acc + v, 0))
  }
  const transformed = compactCounts.map(v => Math.log1p(Math.max(0, v)))
  const peak = Math.max(...transformed, 1e-9)
  const minVal = bins[0]
  const maxVal = bins[n - 1]
  return (
    <div className="generation-mini-hist-wrap">
      <div className="generation-mini-histogram" aria-label="histogram">
        {compactCounts.map((count, idx) => {
          const height = Math.max(2, Math.round((transformed[idx] / peak) * 100))
          return (
            <span
              key={`${idx}-${compactBins[idx]}`}
              style={{ height: `${height}%` }}
              title={`${compactBins[idx]}: ${count}`}
            />
          )
        })}
      </div>
      <div className="generation-mini-range">
        <span>{fmtBinVal(minVal)}</span>
        <span>{fmtBinVal(maxVal)}</span>
      </div>
    </div>
  )
}

function NumberField({
  label,
  value,
  setValue,
  min,
  max,
  step = 1,
}: {
  label: string
  value: number
  setValue: (value: number) => void
  min?: number
  max?: number
  step?: number
}) {
  const fallbackMin = min ?? (step < 1 ? -20 : 0)
  const fallbackMax = max ?? (step < 1 ? 20 : Math.max(fallbackMin + 100, value + 50))
  const [draft, setDraft] = React.useState(String(value))
  const [focused, setFocused] = React.useState(false)

  React.useEffect(() => {
    if (!focused) setDraft(String(value))
  }, [value, focused])

  const commitDraft = () => {
    const trimmed = draft.trim()
    if (!trimmed) {
      setDraft(String(value))
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    setValue(parsed)
    setDraft(String(parsed))
  }

  return (
    <label className="generation-field">
      <span>{label}</span>
      <input
        type="range"
        value={Number.isFinite(value) ? value : fallbackMin}
        min={fallbackMin}
        max={fallbackMax}
        step={step}
        onChange={e => setValue(Number(e.target.value))}
      />
      <input
        type="number"
        value={draft}
        min={fallbackMin}
        max={fallbackMax}
        step={step}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commitDraft()
        }}
        onChange={e => {
          const next = e.target.value
          setDraft(next)
          const trimmed = next.trim()
          if (!trimmed) return
          const parsed = Number(trimmed)
          if (Number.isFinite(parsed)) setValue(parsed)
        }}
      />
    </label>
  )
}
