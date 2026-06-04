import React, { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, CornerDownLeft, Download, FileArchive, Play, RefreshCw, Square, Trash2, Wand2 } from 'lucide-react'
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
  molecule_count?: number
  error?: string
  request?: {
    n_frames?: number
  }
}

type ReferenceScaffoldResponse = {
  model_id: string
  model_name?: string
  source?: string
  reference_indices?: number[]
  reference_freeze_mode?: string | null
  atom_count?: number
  xyz?: string
}

type StructureGuidedConfig = {
  numGenerate: number
  batchSize: number
  nFrames: number
  diffusionSteps: number
  seed: number
  sizeMode: 'fixed' | 'range'
  fixedSize: number
  minSize: number
  maxSize: number
  cfgScale: number
  targets: Record<string, number>
  negativeTargets: Record<string, number | null>
  referenceXyz: string
  referenceName: string
  selectedAtoms: number[]
  connectorBonds: Record<string, number>
  structureMode: 'inpaint' | 'outpaint'
  constraintStrength: number
  scaleFactor: number
  seedDist: number
  minDist: number
  spread: number
  nBqAtom: number
  noiseInitialMask: boolean
  nRetrys: number
  tRetry: number
  denoisingStrength: number
  tStart: number
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
  const xyzResp = await fetch(api(`/generation/jobs/${jobId}/xyz/${encodeURIComponent(moleculeName)}`))
  if (!xyzResp.ok) throw new Error(`XYZ download failed: ${xyzResp.status} ${xyzResp.statusText}`)
  const xyz = await xyzResp.text()
  const renderResp = await fetch(api('/render3d/from-xyz.svg'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mol_id: moleculeName, xyz }),
  })
  if (!renderResp.ok) throw new Error(`xyzrender export failed: ${renderResp.status} ${renderResp.statusText}`)
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

function parseXyz(xyz: string): { atomCount: number; error: string } {
  const lines = xyz.split(/\r?\n/)
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const atomCount = Number(lines[0]?.trim())
  if (!Number.isInteger(atomCount) || atomCount <= 0) return { atomCount: 0, error: 'Invalid XYZ atom count.' }
  if (lines.length < atomCount + 2) return { atomCount, error: 'XYZ has fewer atom rows than declared.' }
  for (const [idx, line] of lines.slice(2, atomCount + 2).entries()) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4 || parts.slice(1, 4).some(value => !Number.isFinite(Number(value)))) {
      return { atomCount, error: `Invalid atom row ${idx + 1}.` }
    }
  }
  return { atomCount, error: '' }
}

function clampUnit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

export default function StructureGuidedGenerationPage({
  pendingRef,
  onPendingRefConsumed,
}: {
  pendingRef: { xyz: string; name: string } | null
  onPendingRefConsumed: () => void
}) {
  const [models, setModels] = useState<GenerationModel[]>([])
  const [modelsDir, setModelsDir] = useState('')
  const [outputsDir, setOutputsDir] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelError, setModelError] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [showModelDetails, setShowModelDetails] = useState(false)
  const [expandedStatKey, setExpandedStatKey] = useState<string | null>(null)
  const [loadingScaffold, setLoadingScaffold] = useState(false)
  const [scaffoldError, setScaffoldError] = useState('')

  const [referenceName, setReferenceName] = useState('')
  const [referenceXyz, setReferenceXyz] = useState('')
  const [xyzPathInput, setXyzPathInput] = useState('')
  const [selectedAtoms, setSelectedAtoms] = useState<number[]>([])
  const [structureMode, setStructureMode] = useState<'inpaint' | 'outpaint'>('inpaint')
  const [connectorBonds, setConnectorBonds] = useState<Record<number, number>>({})

  const [numGenerate, setNumGenerate] = useState(1)
  const [batchSize, setBatchSize] = useState(1)
  const [nFrames, setNFrames] = useState(1)
  const [diffusionSteps, setDiffusionSteps] = useState(50)
  const [seed, setSeed] = useState(86)
  const [sizeMode, setSizeMode] = useState<'fixed' | 'range'>('fixed')
  const [fixedSize, setFixedSize] = useState(32)
  const [minSize, setMinSize] = useState(16)
  const [maxSize, setMaxSize] = useState(100)
  const [cfgScale, setCfgScale] = useState(1)
  const [targets, setTargets] = useState<Record<string, number>>({})
  const [negativeTargets, setNegativeTargets] = useState<Record<string, number | null>>({})
  const [negativeTargetDrafts, setNegativeTargetDrafts] = useState<Record<string, string>>({})
  const [constraintStrength, setConstraintStrength] = useState(0.8)
  const [scaleFactor, setScaleFactor] = useState(1)
  const [seedDist, setSeedDist] = useState(1.5)
  const [minDist, setMinDist] = useState(1)
  const [spread, setSpread] = useState(1)
  const [nBqAtom, setNBqAtom] = useState(8)
  const [noiseInitialMask, setNoiseInitialMask] = useState(true)
  const [nRetrys, setNRetrys] = useState(5)
  const [tRetry, setTRetry] = useState(10)
  const [denoisingStrength, setDenoisingStrength] = useState(0.5)
  const [tStart, setTStart] = useState(0.8)
  const [refViewerHeight, setRefViewerHeight] = useState(300)
  const [showAdjustmentPanel, setShowAdjustmentPanel] = useState(false)
  const [showBasicParams, setShowBasicParams] = useState(true)
  const [showInputStructure, setShowInputStructure] = useState(true)
  const [showMolecularSize, setShowMolecularSize] = useState(true)
  const [showConditionalTargets, setShowConditionalTargets] = useState(true)
  const [showStructureSettings, setShowStructureSettings] = useState(true)

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
    () => models.find(model => model.id === selectedModelId) ?? null,
    [models, selectedModelId]
  )
  const selectedModelHasCheckpointScaffold = Boolean(selectedModel?.capabilities?.has_reference_scaffold)
  const samplingMode = selectedModel?.properties?.length ? 'sample_hybrid' : 'sample'

  useEffect(() => {
    if (!pendingRef) return
    setReferenceXyz(pendingRef.xyz)
    setReferenceName(pendingRef.name)
    setSelectedAtoms([])
    setConnectorBonds({})
    onPendingRefConsumed()
  }, [pendingRef])
  const xyzValidation = useMemo(() => parseXyz(referenceXyz), [referenceXyz])
  const visiblePaneMols = useMemo(() => recentGeneratedMols.slice(0, splitCount), [recentGeneratedMols, splitCount])
  const viewerHeight = useMemo(() => getGenerationViewerHeight(splitCount), [splitCount])
  const showTrajectoryUi = (job?.request?.n_frames ?? 1) > 1

  const currentConfig = useMemo<Record<string, unknown>>(
    () => ({
      numGenerate, batchSize, nFrames, diffusionSteps, seed,
      sizeMode, fixedSize, minSize, maxSize, cfgScale,
      targets, negativeTargets,
      referenceXyz, referenceName, selectedAtoms,
      connectorBonds: Object.fromEntries(Object.entries(connectorBonds).map(([k, v]) => [String(k), v])),
      structureMode,
      constraintStrength, scaleFactor, seedDist, minDist, spread,
      nBqAtom, noiseInitialMask, nRetrys, tRetry,
      denoisingStrength, tStart,
    }),
    [numGenerate, batchSize, nFrames, diffusionSteps, seed,
     sizeMode, fixedSize, minSize, maxSize, cfgScale,
     targets, negativeTargets,
     referenceXyz, referenceName, selectedAtoms, connectorBonds,
     structureMode,
     constraintStrength, scaleFactor, seedDist, minDist, spread,
     nBqAtom, noiseInitialMask, nRetrys, tRetry,
     denoisingStrength, tStart]
  )

  const loadPreset = (config: Record<string, unknown>) => {
    if (typeof config.numGenerate === 'number') setNumGenerate(config.numGenerate)
    if (typeof config.batchSize === 'number') setBatchSize(config.batchSize)
    if (typeof config.nFrames === 'number') setNFrames(config.nFrames)
    if (typeof config.diffusionSteps === 'number') setDiffusionSteps(config.diffusionSteps)
    if (typeof config.seed === 'number') setSeed(config.seed)
    if (config.sizeMode === 'fixed' || config.sizeMode === 'range') setSizeMode(config.sizeMode)
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
    if (typeof config.referenceXyz === 'string' && config.referenceXyz) {
      setReferenceXyz(config.referenceXyz)
      setReferenceName(typeof config.referenceName === 'string' ? config.referenceName : '')
    }
    if (Array.isArray(config.selectedAtoms) && config.selectedAtoms.every((v: unknown) => typeof v === 'number'))
      setSelectedAtoms(config.selectedAtoms as number[])
    if (config.connectorBonds !== null && typeof config.connectorBonds === 'object' && !Array.isArray(config.connectorBonds)) {
      const converted: Record<number, number> = {}
      for (const [k, v] of Object.entries(config.connectorBonds as Record<string, unknown>)) {
        const ki = Number(k)
        if (Number.isFinite(ki) && typeof v === 'number') converted[ki] = v
      }
      setConnectorBonds(converted)
    }
    if (config.structureMode === 'inpaint' || config.structureMode === 'outpaint')
      setStructureMode(config.structureMode)
    if (typeof config.constraintStrength === 'number') setConstraintStrength(config.constraintStrength)
    if (typeof config.scaleFactor === 'number') setScaleFactor(config.scaleFactor)
    if (typeof config.seedDist === 'number') setSeedDist(config.seedDist)
    if (typeof config.minDist === 'number') setMinDist(config.minDist)
    if (typeof config.spread === 'number') setSpread(config.spread)
    if (typeof config.nBqAtom === 'number') setNBqAtom(config.nBqAtom)
    if (typeof config.noiseInitialMask === 'boolean') setNoiseInitialMask(config.noiseInitialMask)
    if (typeof config.nRetrys === 'number') setNRetrys(config.nRetrys)
    if (typeof config.tRetry === 'number') setTRetry(config.tRetry)
    if (typeof config.denoisingStrength === 'number') setDenoisingStrength(config.denoisingStrength)
    if (typeof config.tStart === 'number') setTStart(config.tStart)
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
    if (batchSize >= next) setBatchSize(Math.max(1, next - 1))
  }

  const setGenerationBatchSize = (value: number) => {
    const next = Math.max(1, Math.floor(value || 1))
    setBatchSize(next)
    if (numGenerate <= next) setNumGenerate(next + 1)
  }

  const loadXyzFromPath = async (pathInput: string) => {
    const path = pathInput.trim()
    if (!path) return
    try {
      const resp = await fetch(`${BACKEND}/load-path/xyz`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xyz_path: path }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${resp.status}`)
      }
      const data = await resp.json()
      const text: string = data.content
      const parsed = parseXyz(text)
      setReferenceName(data.name)
      setReferenceXyz(text)
      setSelectedAtoms([])
      const defaultAtomCount = parsed.atomCount + (structureMode === 'outpaint' ? 1 : 0)
      setFixedSize(defaultAtomCount)
      setMinSize(parsed.atomCount)
      setMaxSize(defaultAtomCount)
    } catch (err: any) {
      setScaffoldError(err?.message || String(err))
    }
  }

  const loadCheckpointScaffold = async () => {
    if (!selectedModel) return
    setLoadingScaffold(true)
    setScaffoldError('')
    try {
      const resp = await fetch(api(`/generation/models/${encodeURIComponent(selectedModel.id)}/reference-scaffold`))
      const contentType = (resp.headers.get('content-type') || '').toLowerCase()
      const data: ReferenceScaffoldResponse = contentType.includes('application/json') ? await resp.json() : { model_id: selectedModel.id }
      if (!resp.ok) {
        throw new Error((data as any)?.detail || (data as any)?.message || `${resp.status} ${resp.statusText}`)
      }
      if (!data.xyz) throw new Error('Checkpoint scaffold response did not include XYZ text.')
      const parsed = parseXyz(data.xyz)
      if (parsed.error) throw new Error(parsed.error)
      const nextAtomCount = data.atom_count || parsed.atomCount
      const nextSize = nextAtomCount + 1
      const nextSelectedAtoms = (data.reference_indices || []).filter(idx => Number.isInteger(idx) && idx >= 0 && idx < nextAtomCount)

      setReferenceName(`${selectedModel.name} checkpoint scaffold`)
      setReferenceXyz(data.xyz)
      setStructureMode('outpaint')
      setSelectedAtoms(nextSelectedAtoms)
      setConnectorBonds({})
      setFixedSize(current => Math.max(current, nextSize))
      setMaxSize(current => Math.max(current, nextSize))
      setMinSize(current => Math.max(current, nextAtomCount))
      setJob(null)
      setMolecules([])
      clearGeneratedPreview()
    } catch (err: any) {
      setScaffoldError(err?.message || String(err))
    } finally {
      setLoadingScaffold(false)
    }
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
    setScaffoldError('')
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
        setJob(await resp.json())
      } catch (err) {
        console.error('Failed to poll structure-guided generation job:', err)
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
    setXyzCache(current => Object.fromEntries(Object.entries(current).filter(([filename]) => validFilenames.has(filename))))
    setXyzErrors(current => Object.fromEntries(Object.entries(current).filter(([filename]) => validFilenames.has(filename))))
    setPaneViewMode(current => Object.fromEntries(Object.entries(current).filter(([filename]) => validFilenames.has(filename))))
    setTrajectoryErrors(current => Object.fromEntries(Object.entries(current).filter(([filename]) => validFilenames.has(filename))))
    setTrajectoryCache(current => {
      const keptEntries = Object.entries(current).filter(([filename]) => validFilenames.has(filename))
      const nextCache: Record<string, string> = Object.fromEntries(keptEntries)
      Object.entries(current).forEach(([filename, url]) => {
        if (!validFilenames.has(filename)) URL.revokeObjectURL(url)
      })
      return nextCache
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
              const next = { ...current }
              delete next[filename]
              return next
            })
          }
        } catch (err: any) {
          if (!cancelled) setXyzErrors(current => ({ ...current, [filename]: err?.message || String(err) }))
        }
      })()
    })
    return () => { cancelled = true }
  }, [job?.job_id, visiblePaneMols, xyzCache, xyzErrors])

  useEffect(() => {
    if (!job?.job_id) clearGeneratedPreview()
  }, [job?.job_id])

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

  const toggleAtom = (idx: number) => {
    setSelectedAtoms(current =>
      current.includes(idx)
        ? current.filter(value => value !== idx)
        : [...current, idx].sort((a, b) => a - b)
    )
  }

  const removeAtom = (idx: number) => {
    setSelectedAtoms(current => current.filter(value => value !== idx))
  }

  const clearSelectedAtoms = () => {
    setSelectedAtoms([])
    setConnectorBonds({})
  }

  const togglePaneMolecule = (filename: string, checked: boolean) => {
    setSelectedMol(filename)
    setRecentGeneratedMols(current => {
      if (!checked) return current.filter(item => item !== filename)
      if (current.includes(filename)) return current
      return [...current, filename].slice(0, 9)
    })
  }

  const handleSplitCountChange = (value: string) => {
    setSplitCount(Math.max(1, Math.min(9, Number(value) || 1)))
  }

  const renderGeneratedPane = (filename: string | undefined, idx: number) => {
    if (!filename) return <div className="generation-empty">Empty pane</div>
    if (xyzErrors[filename]) return <div className="generation-empty">Failed to load {filename}</div>
    const xyz = xyzCache[filename]
    const mode = paneViewMode[filename] || '3d'
    const trajectoryUrl = trajectoryCache[filename]
    const trajectoryError = trajectoryErrors[filename]
    if (!xyz) return <div className="generation-empty">Loading {filename}</div>
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

  const submitJob = async () => {
    if (!selectedModel) return
    if (!referenceXyz || xyzValidation.error) {
      setJob({ job_id: '', status: 'failed', output_dir: '', config_path: '', error: xyzValidation.error || 'Upload a valid XYZ reference.' })
      return
    }
    if (structureMode === 'outpaint' && selectedAtoms.length === 0) {
      setJob({ job_id: '', status: 'failed', output_dir: '', config_path: '', error: 'Outpaint requires at least one selected atom.' })
      return
    }

    let nextNumGenerate = Math.max(1, Math.floor(numGenerate || 1))
    let nextBatchSize = Math.max(1, Math.floor(batchSize || 1))
    let nextDiffusionSteps = Math.max(1, Math.floor(diffusionSteps || 50))
    if (!Number.isFinite(nextDiffusionSteps) || nextDiffusionSteps <= 0) nextDiffusionSteps = 50
    if (nextDiffusionSteps < 2) nextDiffusionSteps = 2
    let nextNFrames = Math.max(1, Math.floor(nFrames || 1))
    if (nextNFrames >= nextDiffusionSteps) nextNFrames = nextDiffusionSteps - 1
    if (nextNumGenerate <= nextBatchSize) nextNumGenerate = nextBatchSize + 1
    const nextConstraintStrength = clampUnit(constraintStrength, 0.8)
    const nextDenoisingStrength = clampUnit(denoisingStrength, 0.5)

    setNumGenerate(nextNumGenerate)
    setBatchSize(nextBatchSize)
    setDiffusionSteps(nextDiffusionSteps)
    setNFrames(nextNFrames)
    setConstraintStrength(nextConstraintStrength)
    setDenoisingStrength(nextDenoisingStrength)

    const propNames = selectedModel.properties || []
    const negatives = propNames.map(name => negativeTargets[name])
    const allNegativeNull = negatives.every(v => v == null)
    const allNegativeSet = negatives.every(v => v != null)
    if (samplingMode === 'sample_hybrid' && !allNegativeNull && !allNegativeSet) {
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
      const propertyTargets = propNames.map(name => ({
        name,
        target: Number(targets[name] ?? 0),
        negative_target: negativeTargets[name] == null ? null : Number(negativeTargets[name]),
      }))
      const controls: Record<string, any> = {
        ...(structureMode === 'inpaint' ? { denoising_strength: nextDenoisingStrength } : {}),
        ...(structureMode === 'outpaint'
          ? {
              seed_dist: seedDist,
              min_dist: minDist,
              spread,
              t_start: tStart,
            }
          : {}),
        ...(samplingMode === 'sample'
          ? {
              constraint_strength: nextConstraintStrength,
              scale_factor: scaleFactor,
              n_bq_atom: nBqAtom,
              ...(structureMode === 'inpaint' ? { noise_initial_mask: noiseInitialMask } : {}),
              n_retrys: nRetrys,
              t_retry: tRetry,
            }
          : {}),
      }

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
          property_targets: samplingMode === 'sample_hybrid' ? propertyTargets : [],
          structure_guidance: {
            mode: structureMode,
            sampling_mode: samplingMode,
            reference_xyz: referenceXyz,
            selected_indices: selectedAtoms,
            connector_bonds: Object.fromEntries(selectedAtoms.map(idx => [String(idx), connectorBonds[idx] || 1])),
            ...controls,
          },
        }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data?.detail || data?.message || `${resp.status} ${resp.statusText}`)
      setJob(data)
      setMolecules([])
      clearGeneratedPreview()
    } catch (err: any) {
      setJob({ job_id: '', status: 'failed', output_dir: '', config_path: '', error: err?.message || String(err) })
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
    setReferenceName('')
    setReferenceXyz('')
    setSelectedAtoms([])
    setScaffoldError('')
    setStructureMode('inpaint')
    setConnectorBonds({})
    setNumGenerate(1)
    setBatchSize(1)
    setNFrames(1)
    setDiffusionSteps(50)
    setSeed(86)
    setSizeMode('fixed')
    setFixedSize(32)
    setMinSize(16)
    setMaxSize(100)
    setCfgScale(1)
    setConstraintStrength(0.8)
    setTargets({})
    setNegativeTargets({})
    setNegativeTargetDrafts({})
    setNoiseInitialMask(true)
    setDenoisingStrength(0.5)
    setTStart(0.8)
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
              <small>{model.properties.length ? 'sample_hybrid' : 'sample'}</small>
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
              <dt>Sampling</dt><dd>{samplingMode}</dd>
              <dt>Task</dt><dd>{selectedModel.properties.length ? 'CFG conditional' : 'Unconditional'}</dd>
              <dt>Stat file</dt><dd>{selectedModel.has_stat ? 'edm_stat.pkl present' : 'Missing'}</dd>
              <dt>Path</dt><dd>{selectedModel.path}</dd>
            </dl>
            <button className="generation-details-toggle" onClick={() => setShowModelDetails(v => !v)}>
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
            <div className="generation-panel-title">Structure Generation</div>
            <div className="legend">{samplingMode} · {structureMode}</div>
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

        <PresetsBar page="structure-guided" currentConfig={currentConfig} onLoad={loadPreset} />

        <section className="generation-section">
          <div className="generation-section-title collapsible" onClick={() => setShowBasicParams(v => !v)}>
            <ChevronDown size={13} style={{ transform: showBasicParams ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
            Basic Parameters
          </div>
          {showBasicParams && (
            <div className="generation-form-grid">
              <NumberField label="Total molecules" value={numGenerate} setValue={setTotalMolecules} min={1} />
              <NumberField label="Batch size" value={batchSize} setValue={setGenerationBatchSize} min={1} max={256} />
              <NumberField label="Frames" value={nFrames} setValue={setNFrames} min={1} max={100} />
              <NumberField label="Diffusion steps" value={diffusionSteps} setValue={setDiffusionSteps} min={1} max={1000} />
              <NumberField label="Seed" value={seed} setValue={setSeed} min={0} max={999999} />
              <NumberField label="Max size" value={maxSize} setValue={setMaxSize} min={1} max={512} />
            </div>
          )}
        </section>

        <section className="generation-section">
          <div className="generation-section-head">
            <div className="generation-section-title collapsible" onClick={() => setShowInputStructure(v => !v)}>
              <ChevronDown size={13} style={{ transform: showInputStructure ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
              Input Structure
            </div>
            {selectedModelHasCheckpointScaffold && (
              <button type="button" onClick={loadCheckpointScaffold} disabled={loadingScaffold}>
                <Wand2 size={14} />
                Load checkpoint scaffold
              </button>
            )}
          </div>
          {showInputStructure && (
            <>
              {scaffoldError && <div className="generation-error">{scaffoldError}</div>}
              <div className="segmented">
                {(['inpaint', 'outpaint'] as const).map(mode => (
                  <button key={mode} className={structureMode === mode ? 'active' : ''} onClick={() => setStructureMode(mode)}>
                    {mode}
                  </button>
                ))}
              </div>
              <label className="generation-field">
                <span>Reference XYZ</span>
                <input
                  type="file"
                  accept=".xyz"
                  onChange={async event => {
                    const file = event.target.files?.[0]
                    if (!file) return
                    const text = await file.text()
                    const parsed = parseXyz(text)
                    setReferenceName(file.name)
                    setReferenceXyz(text)
                    setXyzPathInput('')
                    setSelectedAtoms([])
                    const defaultAtomCount = parsed.atomCount + (structureMode === 'outpaint' ? 1 : 0)
                    setFixedSize(defaultAtomCount)
                    setMinSize(parsed.atomCount)
                    setMaxSize(defaultAtomCount)
                  }}
                />
              </label>
              <div className="file-path-row" style={{ marginTop: -4 }}>
                <input
                  type="text"
                  className="file-path-input"
                  placeholder="or paste .xyz path…"
                  value={xyzPathInput}
                  onChange={e => setXyzPathInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); loadXyzFromPath(xyzPathInput) } }}
                />
                <button
                  type="button"
                  className="file-path-load-btn"
                  onClick={() => loadXyzFromPath(xyzPathInput)}
                  title="Load XYZ from path"
                >
                  <CornerDownLeft size={11} strokeWidth={2} />
                </button>
              </div>
              {referenceName && (
                <>
                  <div className="generation-path">
                    {referenceName} · {xyzValidation.atomCount} atoms
                  </div>
                  {xyzValidation.error && <div className="generation-error">{xyzValidation.error}</div>}
                  <div className="ref-viewer-resizable" style={{ height: refViewerHeight }}>
                    <div
                      className="ref-viewer-canvas"
                      onContextMenu={event => {
                        event.preventDefault()
                        if (!selectedAtoms.length) return
                        clearSelectedAtoms()
                      }}
                    >
                      <RawXyzViewer
                        xyz={referenceXyz}
                        selectedAtomIndices={selectedAtoms}
                        onToggleAtomIndex={toggleAtom}
                        backgroundColor={backgroundColor}
                      />
                    </div>
                    <div
                      className="ref-viewer-resize-handle"
                      title="Drag to resize viewer"
                      onMouseDown={e => {
                        e.preventDefault()
                        const startY = e.clientY
                        const startH = refViewerHeight
                        const onMove = (mv: MouseEvent) => {
                          setRefViewerHeight(Math.max(120, Math.min(800, startH + mv.clientY - startY)))
                        }
                        const onUp = () => {
                          window.removeEventListener('mousemove', onMove)
                          window.removeEventListener('mouseup', onUp)
                        }
                        window.addEventListener('mousemove', onMove)
                        window.addEventListener('mouseup', onUp)
                      }}
                    />
                  </div>
                  <div className="generation-result-actions">
                    <span className="legend">Selected atoms: {selectedAtoms.length || 'none'}</span>
                    {selectedAtoms.map(idx => (
                      <button key={idx} type="button" onClick={() => removeAtom(idx)}>
                        <Trash2 size={13} />
                        {idx}
                      </button>
                    ))}
                  </div>
                </>
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
                {(['fixed', 'range'] as const).map(mode => (
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
              {structureMode === 'inpaint' && (
                <div className="generation-form-grid compact">
                  <NumberField
                    label="Denoising strength"
                    value={denoisingStrength}
                    setValue={setDenoisingStrength}
                    min={0}
                    max={1}
                    step={0.05}
                  />
                </div>
              )}
            </>
          )}
        </section>

        {samplingMode === 'sample_hybrid' && (
          <section className="generation-section">
            <div className="generation-section-title collapsible" onClick={() => setShowConditionalTargets(v => !v)}>
              <ChevronDown size={13} style={{ transform: showConditionalTargets ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
              Conditional Targets
            </div>
            {showConditionalTargets && (
              <>
                <NumberField label="CFG scale" value={cfgScale} setValue={setCfgScale} min={0} max={5} step={0.1} />
                {selectedModel?.properties.map(prop => (
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
                          if (Number.isFinite(parsed)) setNegativeTargets(t => ({ ...t, [prop]: parsed }))
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
        )}

        <section className="generation-section">
          <div className="generation-section-title collapsible" onClick={() => setShowStructureSettings(v => !v)}>
            <ChevronDown size={13} style={{ transform: showStructureSettings ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
            Structure Settings
          </div>
          {showStructureSettings && (
            <>
              <button className="generation-details-toggle" onClick={() => setShowAdjustmentPanel(v => !v)}>
                {showAdjustmentPanel ? 'Hide' : 'Show'} Adjustment Panel
              </button>
              {showAdjustmentPanel && (
                <div className="generation-details-drawer">
                  {samplingMode === 'sample' && (
                    <>
                      <div className="generation-mode"><Wand2 size={15} /> sample guidance</div>
                      <div className="generation-form-grid compact">
                        <NumberField label="Constraint strength" value={constraintStrength} setValue={setConstraintStrength} min={0} max={1} step={0.05} />
                        <NumberField label="Scale factor" value={scaleFactor} setValue={setScaleFactor} min={0} max={20} step={0.1} />
                        <NumberField label="BQ atoms" value={nBqAtom} setValue={setNBqAtom} min={0} max={512} />
                        <NumberField label="Retries" value={nRetrys} setValue={setNRetrys} min={0} max={100} />
                        <NumberField label="Retry t" value={tRetry} setValue={setTRetry} min={0} max={1000} />
                        {structureMode === 'inpaint' && (
                          <div className="generation-checkbox-field">
                            <span>Initial mask noise</span>
                            <label className="generation-checkbox-row">
                              <input
                                type="checkbox"
                                checked={noiseInitialMask}
                                onChange={event => setNoiseInitialMask(event.target.checked)}
                              />
                              <span>{noiseInitialMask ? 'true' : 'false'}</span>
                            </label>
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {structureMode === 'outpaint' && (
                    <>
                      <div className="generation-mode"><Wand2 size={15} /> outpaint initialization</div>
                      <div className="generation-form-grid compact">
                        <NumberField label="Seed dist" value={seedDist} setValue={setSeedDist} min={0} max={20} step={0.1} />
                        <NumberField label="Min dist" value={minDist} setValue={setMinDist} min={0} max={20} step={0.1} />
                        <NumberField label="Spread" value={spread} setValue={setSpread} min={0} max={20} step={0.1} />
                        <NumberField label="t_start" value={tStart} setValue={setTStart} min={0} max={1} step={0.05} />
                      </div>
                      {selectedAtoms.length > 0 && (
                        <div className="generation-form-grid compact">
                          {selectedAtoms.map(idx => (
                            <NumberField
                              key={idx}
                              label={`Connector ${idx}`}
                              value={connectorBonds[idx] || 1}
                              setValue={value => setConnectorBonds(current => ({ ...current, [idx]: Math.max(1, Math.floor(value || 1)) }))}
                              min={1}
                              max={8}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </section>
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
                <div className={`viewer-pane${filename && selectedMol === filename ? ' viewer-pane-active' : ''}`} key={`${idx}-${filename || 'empty'}`}>
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
          </div>
        )}

        {job?.log_tail && <pre className="generation-log">{job.log_tail}</pre>}
        {!job && <div className="generation-path">Outputs root: {outputsDir || 'not loaded'}</div>}
      </aside>
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
    const clamped = Math.max(fallbackMin, Math.min(fallbackMax, parsed))
    setValue(clamped)
    setDraft(String(clamped))
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
        onChange={event => setValue(Number(event.target.value))}
      />
      <input
        type="number"
        value={draft}
        min={fallbackMin}
        max={fallbackMax}
        step={step}
        onFocus={() => setFocused(true)}
        onChange={event => {
          const next = event.target.value
          setDraft(next)
          const trimmed = next.trim()
          if (!trimmed) return
          const parsed = Number(trimmed)
          if (Number.isFinite(parsed)) {
            const clamped = Math.max(fallbackMin, Math.min(fallbackMax, parsed))
            setValue(clamped)
          }
        }}
        onBlur={() => {
          setFocused(false)
          commitDraft()
        }}
      />
    </label>
  )
}
