import React, { useEffect, useMemo, useRef, useState } from 'react'
import { shallow } from 'zustand/shallow'
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle, ListPlus, Pause, Play, RefreshCw, StopCircle, Terminal, Trash2, X } from 'lucide-react'
import { useStore } from '../store/store'
import { useUIStore } from '../store/uiStore'
import type { Dataset } from '../models/dataModel'
import { BACKEND } from '../config'
import { buildXyzById, resolveXyzByIds } from '../utils/xyzLoader'
import { createStagedSource } from '../utils/stagedSources'
import type { StagedSource } from '../utils/stagedSources'

const SERIALIZED_DATASET_CACHE: WeakMap<Dataset, any> = new WeakMap()
const ANALYSIS_QUEUE_STORAGE_KEY = 'molcraft.analysisJobsQueue.v1'
const ANALYSIS_WORKFLOW_STORAGE_KEY = 'molcraft.analysisWorkflow.v1'

function readStoredAnalysisQueue(): AnalysisQueueItem[] {
  try {
    const raw = window.localStorage.getItem(ANALYSIS_QUEUE_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeStoredAnalysisQueue(queue: AnalysisQueueItem[]) {
  try {
    if (queue.length) window.localStorage.setItem(ANALYSIS_QUEUE_STORAGE_KEY, JSON.stringify(queue))
    else window.localStorage.removeItem(ANALYSIS_QUEUE_STORAGE_KEY)
  } catch {
    // localStorage can be unavailable in private/embedded contexts; UI state still works for this mount.
  }
}

function readStoredAnalysisWorkflow(): AnalysisWorkflowState {
  try {
    const raw = window.localStorage.getItem(ANALYSIS_WORKFLOW_STORAGE_KEY)
    if (!raw) return makeEmptyWorkflow()
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.steps)) return makeEmptyWorkflow()
    const restoredStatus = parsed.status === 'running' ? 'paused' : (parsed.status || 'idle')
    return {
      steps: parsed.steps,
      status: restoredStatus,
      activeStepId: parsed.activeStepId || '',
      message: parsed.status === 'running'
        ? 'Workflow restored from browser storage. Resume when the required sources are loaded.'
        : (parsed.message || ''),
      error: parsed.error || '',
      updated_at: parsed.updated_at || '',
    }
  } catch {
    return makeEmptyWorkflow()
  }
}

function writeStoredAnalysisWorkflow(workflow: AnalysisWorkflowState) {
  try {
    if (workflow.steps.length) window.localStorage.setItem(ANALYSIS_WORKFLOW_STORAGE_KEY, JSON.stringify(workflow))
    else window.localStorage.removeItem(ANALYSIS_WORKFLOW_STORAGE_KEY)
  } catch {
    // localStorage can be unavailable in private/embedded contexts; UI state still works for this mount.
  }
}

type AnalysisInput = {
  key: string
  label?: string
  type:
    | 'string'
    | 'text'
    | 'integer'
    | 'float'
    | 'boolean'
    | 'select'
    | 'multiselect'
    | 'slider_int'
    | 'slider_float'
  default?: any
  required?: boolean
  options?: Array<string | { value: string; label: string }>
  optionsSource?: 'vector_columns' | 'smiles_columns' | string
  min?: number
  max?: number
  step?: number
  help?: string
}

type AnalysisToolSpec = {
  id: string
  name: string
  description?: string
  mode?: 'columns' | 'replace_xyz' | string
  output?: any
  requires_xyz?: boolean
  inputs: AnalysisInput[]
}

type AnalysisRunResponse = {
  message?: string
  warnings?: string[]
  addColumns?: { name: string; kind?: string; ids?: string[]; values: Array<number | string | null> }[]
  addDescriptor?: { name: string; valuesById: Record<string, number[]>; dtype?: 'float32'; source?: { kind: 'tool' | 'file'; label?: string } }
  addDescriptors?: { name: string; valuesById: Record<string, number[]>; dtype?: 'float32'; source?: { kind: 'tool' | 'file'; label?: string } }[]
  addMolecularVectors?: { name: string; valuesById: Record<string, number[]>; dtype?: 'float32'; source?: { kind: 'tool' | 'file'; label?: string } }[]
  addAtomProperties?: { name: string; valuesById: Record<string, number[]>; dtype?: 'float32'; source?: { kind: 'tool' | 'file'; label?: string } }[]
  replaceXyzById?: Record<string, string>
  stats?: Record<string, any>
}

type AnalysisJobStatus = {
  job_id?: string
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | string
  tool_id?: string
  tool_name?: string
  dataset_origin?: string
  message?: string
  error?: string
  has_result?: boolean
  job_dir?: string
  log_tail?: string
  created_at?: string
  started_at?: string
  finished_at?: string
  queue_position?: number
}

function withAnalysisColumnIds(result: AnalysisRunResponse, ids: string[]): AnalysisRunResponse {
  if (!result.addColumns?.length) return result
  return {
    ...result,
    addColumns: result.addColumns.map(column => (
      column.ids || column.values.length !== ids.length
        ? column
        : { ...column, ids }
    )),
  }
}

type AnalysisQueueItem = {
  job_id: string
  tool_id: string
  tool_name: string
  dataset_origin: string
  params: Record<string, any>
  molecule_count: number
  dataset_id_fingerprint: string[]
  status: AnalysisJobStatus['status']
  queue_position?: number
  created_at?: string
  started_at?: string
  finished_at?: string
  message?: string
  error?: string
  log_tail?: string
  warnings?: string[]
  applied?: boolean
  registered?: boolean
  registered_count?: number
  register_id_prefix?: string
  register_data_source?: string
  show_log?: boolean
  source_kind?: 'compiled' | 'compiled_all' | 'staged'
  staged_source_id?: string
}

type SourceOption = {
  value: string
  label: string
  originLabel: string
  kind: 'compiled' | 'compiled_all' | 'staged'
  stagedSourceId?: string
}

type WorkflowPostAction = 'none' | 'apply' | 'register_optimized'

type WorkflowStepStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

type WorkflowSourceRef = {
  kind: SourceOption['kind']
  originLabel: string
  stagedSourceId?: string
}

type AnalysisWorkflowStep = {
  id: string
  tool_id: string
  tool_name: string
  sourceRef: WorkflowSourceRef
  params: Record<string, any>
  postAction: WorkflowPostAction
  status: WorkflowStepStatus
  job_id?: string
  created_at?: string
  started_at?: string
  finished_at?: string
  error?: string
  applied?: boolean
  registered?: boolean
  registered_count?: number
  register_id_prefix?: string
  register_data_source?: string
  outputSourceLabel?: string
  usePreviousValidityFilter?: boolean
  filter_column?: string
}

type AnalysisWorkflowState = {
  steps: AnalysisWorkflowStep[]
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  activeStepId?: string
  message?: string
  error?: string
  updated_at?: string
}

type AnalysisPageStateCache = {
  tools?: AnalysisToolSpec[]
  toolsError?: string
  selectedToolId?: string
  datasetOrigin?: string
  formValues?: Record<string, any>
  formValuesByTool?: Record<string, Record<string, any>>
  addingToQueue?: boolean
  statusMessage?: string
  errorMessage?: string
  warnings?: string[]
  stats?: Record<string, any> | null
  queue?: AnalysisQueueItem[]
  workflow?: AnalysisWorkflowState
}

const ANALYSIS_PAGE_STATE_CACHE: AnalysisPageStateCache = {}

const FALLBACK_ANALYSIS_TOOLS: AnalysisToolSpec[] = [
  {
    id: 'validity_connectivity',
    name: 'Validity and connectivity metrics',
    description: 'Compute structural validity/connectivity metrics (core/posebuster/geom).',
    mode: 'columns',
    output: { kind: 'add_columns' },
    inputs: [
      { key: 'metrics', label: 'Metric set', type: 'select', default: 'posebuster', required: true, options: ['core', 'posebuster', 'geom_revised'] },
      { key: 'recheck_topo', label: 'Recheck topology with RDKit', type: 'boolean', default: false },
      { key: 'mol_converter', label: 'Molecule converter', type: 'select', default: 'xyz2mol', options: ['xyz2mol', 'openbabel'] },
    ],
  },
  {
    id: 'xyz_to_smiles',
    name: 'XYZ to SMILES conversion',
    description: 'Convert XYZ to SMILES and fingerprints/scaffold-derived columns.',
    mode: 'columns',
    output: { kind: 'add_columns' },
    inputs: [{ key: 'bits', label: 'Morgan fingerprint bits', type: 'integer', default: 2048, required: true }],
  },
  {
    id: 'xtb_electronic_properties',
    name: 'XTB electronic properties',
    description: 'Compute XTB electronic descriptors (energy/dipole/reactivity/etc.).',
    mode: 'columns',
    output: { kind: 'add_columns' },
    inputs: [
      { key: 'method', label: 'XTB method', type: 'select', default: '2', required: true, options: [{ value: '1', label: 'GFN1-xTB' }, { value: '2', label: 'GFN2-xTB' }, { value: 'ptb', label: 'PTB' }] },
      { key: 'charge', label: 'Charge', type: 'integer', default: 0 },
      { key: 'n_unpaired', label: 'Unpaired electrons', type: 'integer', default: 0 },
      { key: 'solvent', label: 'Solvent', type: 'string', default: '' },
      { key: 'properties', label: 'Property group', type: 'select', default: 'energy', required: true, options: ['energy', 'dipole', 'reactivity', 'global', 'charges', 'fukui', 'bond_orders', 'all'] },
      { key: 'timeout', label: 'Timeout per molecule, seconds', type: 'integer', default: 120 },
      { key: 'n_jobs', label: 'Parallel jobs', type: 'integer', default: 1 },
      { key: 'corrected', label: 'Apply empirical IP/EA correction', type: 'boolean', default: true },
    ],
  },
  {
    id: 'featurize',
    name: 'Featurize',
    description: 'Generate fixed-size molecular vectors (SOAP/UMA/fingerprints) for downstream ML.',
    mode: 'columns',
    output: { kind: 'add_columns' },
    inputs: [
      { key: 'backend', label: 'Backend', type: 'select', default: 'soap', options: ['soap', 'uma', 'fingerprint'] },
      { key: 'autodetect', label: 'Auto-detect species', type: 'boolean', default: true },
      { key: 'r_cut', label: 'SOAP r_cut', type: 'float', default: 6.0 },
      { key: 'n_max', label: 'SOAP n_max', type: 'integer', default: 8 },
      { key: 'l_max', label: 'SOAP l_max', type: 'integer', default: 6 },
      { key: 'sigma', label: 'SOAP sigma', type: 'float', default: 0.1 },
      { key: 'pooling', label: 'Pooling', type: 'select', default: 'mean', options: ['mean', 'sum'] },
      {
        key: 'model_path',
        label: 'UMA model path',
        type: 'string',
        default: '',
        help: 'Optional local UMA checkpoint/model path. Relative paths are resolved from the repository root.',
      },
      { key: 'device', label: 'UMA device', type: 'select', default: 'cpu', options: ['auto', 'cpu', 'cuda'] },
      { key: 'batch_size', label: 'UMA batch size', type: 'integer', default: 8 },
      { key: 'smiles_column', label: 'SMILES column', type: 'select', default: '', required: true, options: [], optionsSource: 'smiles_columns' },
      { key: 'fp_radius', label: 'Morgan radius', type: 'integer', default: 2 },
      { key: 'fp_bits', label: 'Morgan bits', type: 'integer', default: 2048 },
      { key: 'fp_use_chirality', label: 'Use chirality', type: 'boolean', default: false },
      { key: 'fp_use_features', label: 'Use feature invariants', type: 'boolean', default: false },
    ],
  },
  {
    id: 'dimensionality_reduction',
    name: 'Dimensionality reduction',
    description: 'Project molecular vectors to two numeric coordinates with t-SNE or UMAP.',
    mode: 'columns',
    requires_xyz: false,
    output: { kind: 'add_columns' },
    inputs: [
      { key: 'vector_column', label: 'Vector column', type: 'select', default: '', required: true, options: [], optionsSource: 'vector_columns' },
      { key: 'algorithm', label: 'Algorithm', type: 'select', default: 'umap', required: true, options: [{ value: 'umap', label: 'UMAP' }, { value: 'tsne', label: 't-SNE' }] },
      { key: 'device', label: 't-SNE device', type: 'select', default: 'cpu', options: [{ value: 'cpu', label: 'CPU (openTSNE)' }, { value: 'cuda', label: 'CUDA (tsne-cuda)' }] },
      { key: 'cuda_device', label: 'CUDA device', type: 'integer', default: 0 },
      { key: 'metric', label: 'Metric', type: 'select', default: 'euclidean', options: ['euclidean', 'cosine', 'manhattan'] },
      { key: 'random_state', label: 'Random seed', type: 'integer', default: 42 },
      { key: 'perplexity', label: 't-SNE perplexity', type: 'float', default: 30.0 },
      { key: 'tsne_learning_rate', label: 't-SNE learning rate', type: 'float', default: 200.0 },
      { key: 'n_iter', label: 't-SNE iterations', type: 'integer', default: 1000 },
      { key: 'early_exaggeration', label: 't-SNE early exaggeration', type: 'float', default: 12.0 },
      { key: 'theta', label: 't-SNE theta', type: 'float', default: 0.5 },
      { key: 'initialization', label: 'Initialization', type: 'select', default: 'pca', options: [{ value: 'pca', label: 'PCA' }, { value: 'random', label: 'Random' }, { value: 'spectral', label: 'Spectral' }] },
      { key: 'n_jobs', label: 'Parallel jobs', type: 'integer', default: 1 },
      { key: 'n_neighbors', label: 'UMAP neighbors', type: 'integer', default: 15 },
      { key: 'min_dist', label: 'UMAP min distance', type: 'float', default: 0.1 },
      { key: 'n_epochs', label: 'UMAP epochs', type: 'integer', default: 0 },
      { key: 'umap_learning_rate', label: 'UMAP learning rate', type: 'float', default: 1.0 },
      { key: 'spread', label: 'UMAP spread', type: 'float', default: 1.0 },
      { key: 'low_memory', label: 'UMAP low memory', type: 'boolean', default: true },
    ],
  },
  {
    id: 'predict_properties',
    name: 'Predict properties',
    description: 'Run MolCraftDiff property prediction from a selected checkpoint.',
    mode: 'columns',
    output: { kind: 'add_columns' },
    inputs: [
      { key: 'model_id', label: 'Predictive model', type: 'select', default: '', required: true, options: [] },
    ],
  },
  {
    id: 'xtb_geometry_optimization',
    name: 'XTB Geometry Optimization',
    description: 'Optimize XYZ geometry (GFN/MMFF) and replace XYZ by molecule ID.',
    mode: 'replace_xyz',
    output: { kind: 'replace_xyz' },
    inputs: [
      { key: 'level', label: 'Optimization level', type: 'select', default: 'gfn2', required: true, options: ['gfn1', 'gfn2', 'gfn-ff', 'mmff94'] },
      { key: 'charge', label: 'Charge', type: 'integer', default: 0 },
      { key: 'timeout', label: 'Timeout per molecule, seconds', type: 'integer', default: 240 },
      { key: 'scale_factor', label: 'Covalent radii scale factor', type: 'float', default: 1.3 },
    ],
  },
]

function serializeDataset(ds: Dataset) {
  const hit = SERIALIZED_DATASET_CACHE.get(ds)
  if (hit) return hit

  const plainColumns: Record<string, any[]> = {}
  for (const [name, values] of Object.entries(ds.columns)) {
    plainColumns[name] = Array.from(values as any)
  }

  const out = {
    ids: ds.ids,
    columns: plainColumns,
    meta: ds.meta,
    descriptors: ds.descriptors || {},
    molecularVectors: ds.molecularVectors || {},
    atomProperties: ds.atomProperties || {},
  }

  SERIALIZED_DATASET_CACHE.set(ds, out)
  return out
}

function valueAt(column: ArrayLike<unknown> | undefined, index: number): unknown {
  if (!column || typeof column.length !== 'number' || index < 0 || index >= column.length) return undefined
  return column[index]
}

function uniqueSortedStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.map(v => (v == null ? '' : String(v).trim())).filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

function normalizeOptions(options?: Array<string | { value: string; label: string }>) {
  return (options || []).map(opt => (typeof opt === 'string' ? { value: opt, label: opt } : opt))
}

function defaultValueFor(field: AnalysisInput) {
  if (field.default !== undefined) return field.default
  if (field.type === 'boolean') return false
  if (field.type === 'multiselect') return []
  return ''
}

function makeInitialFormValues(tool: AnalysisToolSpec | null) {
  const values: Record<string, any> = {}
  for (const field of tool?.inputs || []) {
    values[field.key] = defaultValueFor(field)
  }
  return values
}

function mergeFormValuesForTool(tool: AnalysisToolSpec | null, existing?: Record<string, any>) {
  const values: Record<string, any> = {}
  for (const field of tool?.inputs || []) {
    const existingValue = existing && Object.prototype.hasOwnProperty.call(existing, field.key)
      ? existing[field.key]
      : defaultValueFor(field)
    if (field.type === 'select' && !field.optionsSource) {
      const options = normalizeOptions(field.options)
      const optionValues = new Set(options.map(opt => opt.value))
      values[field.key] = options.length > 0 && !optionValues.has(String(existingValue ?? ''))
        ? defaultValueFor(field)
        : existingValue
    } else {
      values[field.key] = existingValue
    }
  }
  return values
}

function isFieldVisibleForValues(
  tool: AnalysisToolSpec | null,
  field: AnalysisInput,
  values: Record<string, any>
) {
  if (!tool) return true
  if (
    tool.id === 'validity_connectivity' &&
    field.key === 'recheck_topo'
  ) {
    return String(values.metrics ?? 'core') === 'core'
  }
  if (tool.id === 'featurize') {
    const backend = String(values.backend || 'soap')
    const soapFields = new Set(['autodetect', 'r_cut', 'n_max', 'l_max', 'sigma'])
    const umaFields = new Set(['model_path', 'device', 'batch_size'])
    const fingerprintFields = new Set(['smiles_column', 'fp_radius', 'fp_bits', 'fp_use_chirality', 'fp_use_features'])
    if (soapFields.has(field.key)) return backend === 'soap'
    if (umaFields.has(field.key)) return backend === 'uma'
    if (fingerprintFields.has(field.key)) return backend === 'fingerprint'
    if (field.key === 'pooling') return backend === 'soap' || backend === 'uma'
  }
  if (tool.id === 'dimensionality_reduction') {
    const algorithm = String(values.algorithm || 'umap')
    const device = String(values.device || 'cpu')
    const tsneFields = new Set(['device', 'cuda_device', 'perplexity', 'tsne_learning_rate', 'n_iter', 'early_exaggeration', 'theta'])
    const umapFields = new Set(['n_neighbors', 'min_dist', 'n_epochs', 'umap_learning_rate', 'spread', 'low_memory'])
    if (tsneFields.has(field.key)) {
      if (field.key === 'cuda_device') return algorithm === 'tsne' && device === 'cuda'
      return algorithm === 'tsne'
    }
    if (umapFields.has(field.key)) return algorithm === 'umap'
    if (field.key === 'initialization') return true
  }
  return true
}

function visibleInputsForValues(
  tool: AnalysisToolSpec | null,
  values: Record<string, any>
) {
  return (tool?.inputs || []).filter(field =>
    isFieldVisibleForValues(tool, field, values)
  )
}

function buildSubmitValues(
  tool: AnalysisToolSpec | null,
  currentValues: Record<string, any>
) {
  const merged = mergeFormValuesForTool(tool, currentValues)
  const submit: Record<string, any> = {}
  for (const field of visibleInputsForValues(tool, merged)) {
    submit[field.key] = merged[field.key]
  }
  return submit
}

function withBackfilledToolInputs(
  loadedTools: AnalysisToolSpec[]
) {
  const fallbackById = new Map(FALLBACK_ANALYSIS_TOOLS.map(t => [t.id, t]))
  return loadedTools.map(tool => {
    const fallback = fallbackById.get(tool.id)
    if (!fallback) return tool

    const existingKeys = new Set((tool.inputs || []).map(input => input.key))
    const missingFallbackInputs = (fallback.inputs || []).filter(
      input => !existingKeys.has(input.key)
    )
    if (missingFallbackInputs.length === 0) return tool

    return {
      ...tool,
      inputs: [...(tool.inputs || []), ...missingFallbackInputs],
    }
  })
}

function getErrorMessage(data: any, fallback: string) {
  const detail = data?.detail
  if (typeof detail === 'string') return detail
  if (detail?.message) return detail.message
  if (data?.message) return data.message
  if (data?.error) return data.error
  return fallback
}

function isTerminalAnalysisStatus(status?: string) {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function queueItemFromStatus(
  status: AnalysisJobStatus,
  existing?: AnalysisQueueItem
): AnalysisQueueItem {
  const merged: AnalysisQueueItem = {
    ...existing,
    job_id: status.job_id || existing?.job_id || '',
    tool_id: status.tool_id || existing?.tool_id || '',
    tool_name: status.tool_name || existing?.tool_name || status.tool_id || 'Analysis job',
    dataset_origin: status.dataset_origin || existing?.dataset_origin || '',
    params: existing?.params || {},
    molecule_count: existing?.molecule_count || 0,
    dataset_id_fingerprint: existing?.dataset_id_fingerprint || [],
    status: status.status || existing?.status || 'queued',
    queue_position: status.queue_position,
    created_at: status.created_at || existing?.created_at,
    started_at: status.started_at || existing?.started_at,
    finished_at: status.finished_at || existing?.finished_at,
    message: status.message || existing?.message,
    error: status.error || existing?.error,
    log_tail: status.log_tail ?? existing?.log_tail,
    warnings: existing?.warnings,
    applied: existing?.applied || false,
    registered: existing?.registered || false,
    registered_count: existing?.registered_count,
    register_id_prefix: existing?.register_id_prefix,
    register_data_source: existing?.register_data_source,
    show_log: existing?.show_log ?? status.status === 'running',
  }
  if (existing) {
    // Return the existing object when nothing changed so pollers don't
    // trigger pointless re-renders / localStorage rewrites.
    // merged = {...existing, ...overrides}, so its key set is a superset of
    // existing's; value-comparing merged's keys is a full equality check.
    const keys = Object.keys(merged) as Array<keyof AnalysisQueueItem>
    const unchanged = keys.every(k => merged[k] === existing[k])
    return unchanged ? existing : merged
  }
  return withOptimizationRegistrationLegacyFix(withOptimizationRegistrationDefaults(merged))
}

function datasetIdsMatch(currentIds: string[], expectedIds: string[]) {
  return currentIds.length === expectedIds.length && currentIds.every((id, i) => id === expectedIds[i])
}

const VALIDITY_FILTER_COLUMN_PRIORITY = [
  'valid_posebuster_connected',
  'valid_connected',
  'all_atoms_connected',
]

function isTruthyOrFalsyScalar(value: unknown) {
  if (value == null || String(value).trim() === '') return true
  const low = String(value).trim().toLowerCase()
  return ['true', 'false', '1', '0', 'yes', 'no', 'pass', 'fail', 'passed', 'valid', 'invalid', 'connected', 'ok'].includes(low)
}

function isValidityFilterColumnName(name: string) {
  const low = name.toLowerCase()
  return ['valid', 'connect', 'posebuster', 'geom'].some(token => low.includes(token))
}

function validityFilterColumnsForDataset(ds: Dataset | null) {
  if (!ds) return []
  return Object.entries(ds.columns)
    .filter(([name, values]) => {
      if (!isValidityFilterColumnName(name)) return false
      const sample = Array.from(values as ArrayLike<unknown>).filter(v => v != null && String(v).trim() !== '').slice(0, 100)
      return sample.length > 0 && sample.every(isTruthyOrFalsyScalar)
    })
    .map(([name]) => name)
}

function preferredValidityFilterColumn(columns: string[]) {
  for (const name of VALIDITY_FILTER_COLUMN_PRIORITY) {
    if (columns.includes(name)) return name
  }
  return columns[0] || ''
}

function makeRegistrationPrefix(label: string) {
  const clean = String(label || '')
    .trim()
    .replace(/\.[A-Za-z0-9]+$/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return clean ? `${clean}_` : ''
}

function defaultOptimizedSourceLabel(originalName?: string) {
  const base = String(originalName || '').trim() || 'dataset'
  return `${base}_optimized`
}

function withOptimizationRegistrationDefaults(item: AnalysisQueueItem): AnalysisQueueItem {
  if (item.tool_id !== 'xtb_geometry_optimization') return item
  const prefix = String(item.register_id_prefix ?? '').trim() ? item.register_id_prefix : 'molGen_optimized'
  const label = String(item.register_data_source || '').trim() || defaultOptimizedSourceLabel(item.dataset_origin)
  return {
    ...item,
    register_id_prefix: prefix,
    register_data_source: label,
  }
}

function withOptimizationRegistrationLegacyFix(item: AnalysisQueueItem): AnalysisQueueItem {
  if (item.tool_id !== 'xtb_geometry_optimization') return item
  const current = String(item.register_data_source || '').trim()
  const origin = String(item.dataset_origin || '').trim()
  if (!current || (origin && current === origin)) {
    return {
      ...item,
      register_data_source: defaultOptimizedSourceLabel(item.dataset_origin),
    }
  }
  return item
}

function newestMatchingValidityJob(
  queue: AnalysisQueueItem[],
  datasetOrigin: string,
  currentIds: string[]
) {
  const matches = queue.filter(item =>
    item.tool_id === 'validity_connectivity' &&
    item.status === 'completed' &&
    item.dataset_origin === datasetOrigin &&
    datasetIdsMatch(currentIds, item.dataset_id_fingerprint)
  )
  return matches.sort((a, b) => {
    const aTime = Date.parse(a.finished_at || a.started_at || a.created_at || '')
    const bTime = Date.parse(b.finished_at || b.started_at || b.created_at || '')
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime
    if (Number.isFinite(bTime)) return 1
    if (Number.isFinite(aTime)) return -1
    return queue.indexOf(a) - queue.indexOf(b)
  })[0] || null
}

function formatTimestamp(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function sourceOptionValue(kind: 'compiled' | 'compiled_all' | 'staged', id: string) {
  return `${kind}:${id}`
}

function lookupXyzById(xyzById: Record<string, string> | undefined, id: string) {
  if (!xyzById) return ''
  const cleanId = String(id).trim()
  const stem = cleanId.split(/[\\/]/).pop()?.replace(/\.xyz$/i, '') || cleanId
  return xyzById[cleanId] || xyzById[stem] || xyzById[`${stem}.xyz`] || ''
}

function makeEmptyWorkflow(): AnalysisWorkflowState {
  return {
    steps: [],
    status: 'idle',
    activeStepId: '',
    message: '',
    error: '',
  }
}

function makeWorkflowStepId() {
  return `workflow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function sourceRefFromOption(option: SourceOption): WorkflowSourceRef {
  return {
    kind: option.kind,
    originLabel: option.originLabel,
    stagedSourceId: option.stagedSourceId,
  }
}

function workflowSourceRefKey(ref: WorkflowSourceRef) {
  return `${ref.kind}:${ref.kind === 'staged' ? (ref.stagedSourceId || ref.originLabel) : ref.originLabel}`
}

function defaultPostActionForTool(tool: AnalysisToolSpec | null): WorkflowPostAction {
  if (!tool) return 'none'
  if (tool.id === 'xtb_geometry_optimization') return 'register_optimized'
  if (tool.mode === 'columns' || tool.output?.kind === 'add_columns') return 'apply'
  return 'none'
}

function postActionLabel(action: WorkflowPostAction) {
  if (action === 'apply') return 'Apply results'
  if (action === 'register_optimized') return 'Register optimized set'
  return 'No post-action'
}

function workflowSourceLabel(ref: WorkflowSourceRef) {
  if (ref.kind === 'compiled_all') return 'all compiled sources'
  if (ref.kind === 'staged') return `${ref.originLabel} (staged)`
  return `${ref.originLabel} (compiled)`
}

function paramsSummary(params: Record<string, any>) {
  const entries = Object.entries(params || {})
    .filter(([key]) => key !== 'filter_csv_job_id')
    .slice(0, 4)
  if (!entries.length) return 'default settings'
  const suffix = Object.keys(params || {}).length > entries.length ? ', ...' : ''
  return entries.map(([key, value]) => {
    const displayValue = value === '__previous_vector__' ? 'previous vector output' : value
    return `${key}: ${Array.isArray(displayValue) ? displayValue.join(',') : String(displayValue)}`
  }).join(', ') + suffix
}

function normXyzId(id: string) {
  return String(id).trim().replace(/\.xyz$/i, '')
}

function optimizedRegisteredId(idPrefix: string, rawId: string) {
  const prefix = String(idPrefix || '').trim()
  const id = String(rawId || '').trim()
  if (!prefix) return id
  const normalizedId = prefix.startsWith('molGen_') && id.startsWith('molGen_')
    ? id.slice('molGen_'.length)
    : id
  const needsSep = /[_-]$/.test(prefix) || !normalizedId ? '' : '_'
  return `${prefix}${needsSep}${normalizedId}`
}

function analysisToolRequiresXyz(tool: AnalysisToolSpec, values: Record<string, any>) {
  if (tool.id === 'featurize' && String(values.backend || '') === 'fingerprint') return false
  return tool.requires_xyz !== false
}

function makeVectorLabelColumn(ids: string[], valuesById: Record<string, number[]>, dim?: number | null): string[] {
  const fallbackDim = dim || Object.values(valuesById).find(Array.isArray)?.length || 0
  const label = fallbackDim > 0 ? `vec[${fallbackDim}]` : 'vec'
  return ids.map(id => (Array.isArray(valuesById[id]) ? label : ''))
}

function vectorColumnOptionsForDataset(dataset: Dataset | null | undefined, selectedIds: string[]) {
  if (!dataset || selectedIds.length === 0) return []
  const records = [
    ...Object.values(dataset.descriptors || {}).map(record => ({ ...record, sourceKind: 'descriptor' })),
    ...Object.values(dataset.molecularVectors || {}).map(record => ({ ...record, sourceKind: 'molecular vector' })),
  ] as Array<{ name?: string; valuesById?: Record<string, number[]>; dim?: number | null; sourceKind: string }>

  return records
    .map(record => {
      const name = String(record.name || '').trim()
      if (!name || !record.valuesById) return null
      let dim: number | null = null
      let validCount = 0
      for (const id of selectedIds) {
        const vec = record.valuesById[id]
        if (!Array.isArray(vec) || vec.length === 0) continue
        const finite = vec.every(x => typeof x === 'number' && Number.isFinite(x))
        if (!finite) continue
        if (dim == null) dim = vec.length
        else if (vec.length !== dim) return null
        validCount += 1
      }
      if (dim == null || validCount < 2) return null
      return {
        value: name,
        label: `${name} (${record.sourceKind}, ${dim}D, ${validCount.toLocaleString()} vectors)`,
      }
    })
    .filter((option): option is { value: string; label: string } => !!option)
    .sort((a, b) => a.label.localeCompare(b.label))
}

function smilesColumnOptionsForDataset(dataset: Dataset | null | undefined, selectedIds: string[]) {
  if (!dataset || selectedIds.length === 0) return []
  const selected = new Set(selectedIds)
  const vectorColumns = new Set(dataset.meta.vectorColumns || [])
  const idToIndex = new Map(dataset.ids.map((id, index) => [String(id), index]))
  const orderedNames = dataset.columnOrder || Object.keys(dataset.columns)

  return orderedNames
    .filter(name => dataset.columns[name] && !vectorColumns.has(name) && name !== 'data_source')
    .map(name => {
      const values = dataset.columns[name]
      let filledCount = 0
      for (const id of selected) {
        const index = idToIndex.get(id)
        if (index == null) continue
        const value = valueAt(values, index)
        if (value != null && String(value).trim() !== '') filledCount += 1
      }
      const lower = name.toLowerCase()
      const likelyRank = lower === 'smiles' || lower === 'smi' || lower === 'canonical_smiles'
        ? 0
        : (lower.includes('smiles') || lower.includes('smi') ? 1 : 2)
      const kind = (dataset.meta.numericColumns || []).includes(name) ? 'numeric' : 'text'
      return {
        value: name,
        label: `${name} (${kind}, ${filledCount.toLocaleString()} filled)`,
        rank: likelyRank,
        filledCount,
      }
    })
    .filter(option => option.filledCount > 0)
    .sort((a, b) => (
      a.rank - b.rank ||
      b.filledCount - a.filledCount ||
      a.value.localeCompare(b.value)
    ))
    .map(({ value, label }) => ({ value, label }))
}

function applyDescriptorToDataset(
  dataset: Dataset,
  descriptorInput: NonNullable<AnalysisRunResponse['addDescriptors']>[number]
): { dataset: Dataset; warning?: string } {
  const name = String(descriptorInput?.name || '').trim()
  if (!name) {
    throw new Error('Descriptor name must be non-empty')
  }
  if (dataset.columns[name] && !(dataset.meta.vectorColumns || []).includes(name)) {
    throw new Error(`A column named '${name}' already exists`)
  }
  const valuesById = descriptorInput.valuesById || {}
  const presentIds = Object.keys(valuesById)
  let dim: number | null = null
  for (const id of presentIds) {
    const vec = valuesById[id]
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error(`Descriptor '${name}' has an invalid vector for id '${id}'`)
    }
    for (const x of vec) {
      if (typeof x !== 'number' || !Number.isFinite(x)) {
        throw new Error(`Descriptor '${name}' has a non-numeric value for id '${id}'`)
      }
    }
    if (dim == null) dim = vec.length
    else if (vec.length !== dim) throw new Error(`Descriptor '${name}' has inconsistent vector dimensions`)
  }
  if (dim == null) {
    throw new Error(`Descriptor '${name}' contains no valid entries`)
  }

  const idSet = new Set(dataset.ids)
  for (const id of presentIds) {
    if (!idSet.has(id)) {
      throw new Error(`Descriptor '${name}' references unknown dataset id '${id}'`)
    }
  }

  const missingIds = dataset.ids.filter(id => !Object.prototype.hasOwnProperty.call(valuesById, id))
  const nextDataset: Dataset = {
    ...dataset,
    columns: {
      ...dataset.columns,
      [name]: makeVectorLabelColumn(dataset.ids, valuesById, dim),
    },
    descriptors: {
      ...(dataset.descriptors || {}),
      [name]: {
        name,
        dim,
        dtype: descriptorInput.dtype || 'float32',
        valuesById,
        missingIds,
        source: descriptorInput.source,
      },
    },
    meta: {
      ...dataset.meta,
      numericColumns: (dataset.meta.numericColumns || []).filter(col => col !== name),
      categoricalColumns: (dataset.meta.categoricalColumns || []).filter(col => col !== name),
      vectorColumns: Array.from(new Set([...(dataset.meta.vectorColumns || []), name])),
    },
    columnOrder: (dataset.columnOrder || Object.keys(dataset.columns)).includes(name)
      ? (dataset.columnOrder || Object.keys(dataset.columns))
      : [...(dataset.columnOrder || Object.keys(dataset.columns)), name],
  }

  return {
    dataset: nextDataset,
    warning: missingIds.length
      ? `Descriptor '${name}' was added, but ${missingIds.length} entries are missing values.`
      : undefined,
  }
}

function applyMolecularVectorToDataset(
  dataset: Dataset,
  vectorInput: NonNullable<AnalysisRunResponse['addMolecularVectors']>[number]
): { dataset: Dataset; warning?: string } {
  const name = String(vectorInput?.name || '').trim()
  if (!name) throw new Error('Molecular vector name must be non-empty')
  const valuesById = vectorInput.valuesById || {}
  const missingIds = dataset.ids.filter(id => !Array.isArray(valuesById[id]))
  return {
    dataset: {
      ...dataset,
      molecularVectors: {
        ...(dataset.molecularVectors || {}),
        [name]: {
          name,
          valuesById,
          dtype: vectorInput.dtype || 'float32',
          missingIds,
          source: vectorInput.source,
        },
      },
    },
    warning: missingIds.length
      ? `${missingIds.length.toLocaleString()} molecules are missing molecular vector '${name}'.`
      : undefined,
  }
}

function applyAtomPropertyToDataset(
  dataset: Dataset,
  propertyInput: NonNullable<AnalysisRunResponse['addAtomProperties']>[number]
): { dataset: Dataset; warning?: string } {
  const name = String(propertyInput?.name || '').trim()
  if (!name) throw new Error('Atom property name must be non-empty')
  const valuesById = propertyInput.valuesById || {}
  const missingIds = dataset.ids.filter(id => !Array.isArray(valuesById[id]))
  return {
    dataset: {
      ...dataset,
      atomProperties: {
        ...(dataset.atomProperties || {}),
        [name]: {
          name,
          valuesById,
          dtype: propertyInput.dtype || 'float32',
          missingIds,
          source: propertyInput.source,
        },
      },
    },
    warning: missingIds.length
      ? `${missingIds.length.toLocaleString()} molecules are missing atom property '${name}'.`
      : undefined,
  }
}

function buildOptimizedStagedSource(
  sourceDataset: import('../models/dataModel').Dataset,
  replaceXyzById: Record<string, string>,
  dataSourceLabel: string,
  idPrefix: string
): StagedSource | null {
  const optimizedIdSet = new Set(Object.keys(replaceXyzById).map(normXyzId))
  const optimizedIndices: Array<{ id: string; i: number }> = []
  sourceDataset.ids.forEach((rawId, i) => {
    const id = String(rawId)
    if (optimizedIdSet.has(normXyzId(id))) optimizedIndices.push({ id, i })
  })
  if (optimizedIndices.length === 0) return null

  const newIds = optimizedIndices.map(r => optimizedRegisteredId(idPrefix, r.id))
  const newColumns: Record<string, any> = {}
  for (const [colName, values] of Object.entries(sourceDataset.columns)) {
    if ((sourceDataset.meta.numericColumns || []).includes(colName)) {
      const arr = new Float32Array(optimizedIndices.length)
      for (let j = 0; j < optimizedIndices.length; j++) {
        const raw = (values as any)[optimizedIndices[j].i]
        arr[j] = typeof raw === 'number' ? raw : Number(raw)
      }
      newColumns[colName] = arr
    } else if (colName === 'data_source') {
      newColumns[colName] = newIds.map(() => dataSourceLabel)
    } else {
      newColumns[colName] = optimizedIndices.map(r => (values as any)[r.i])
    }
  }
  const newXyzById: Record<string, string> = {}
  for (const row of optimizedIndices) {
    const n = normXyzId(row.id)
    const xyz = replaceXyzById[row.id] || replaceXyzById[n] || replaceXyzById[`${n}.xyz`] || ''
    if (xyz) newXyzById[optimizedRegisteredId(idPrefix, row.id)] = xyz
  }
  return createStagedSource({
    kind: 'optimization_result',
    label: dataSourceLabel,
    dataset: { ids: newIds, columns: newColumns, meta: { ...sourceDataset.meta }, columnOrder: sourceDataset.columnOrder },
    source: null,
    xyzById: newXyzById,
  })
}

function baseXyzIdsNeededForOptimizedRegistration(
  dataset: Dataset,
  datasetOrigin: string,
  idPrefix: string,
  dataSourceLabel: string,
  replaceXyzById: Record<string, string>
) {
  const origin = String(datasetOrigin || '').trim()
  const label = String(dataSourceLabel || '').trim()
  const prefix = String(idPrefix ?? '')
  const optimizedIdSet = new Set(Object.keys(replaceXyzById || {}).map(normXyzId))
  const sourceValues = dataset.columns.data_source
    ? Array.from(dataset.columns.data_source as any).map(v => String(v ?? '').trim() || 'dataset_1')
    : dataset.ids.map(() => 'dataset_1')
  const allOrigins = origin === '__all__'
  const allOriginsInPlace = allOrigins && prefix === ''
  const replacementMode = !allOrigins && prefix === '' && label === origin
  const needed: string[] = []

  dataset.ids.forEach((rawId, i) => {
    const id = String(rawId)
    const skip = allOriginsInPlace
      ? optimizedIdSet.has(normXyzId(id))
      : replacementMode && sourceValues[i] === origin
    if (!skip) needed.push(id)
  })

  return needed
}

type AnalysisToolsPageProps = {
  stagedSources: StagedSource[]
  setStagedSources: React.Dispatch<React.SetStateAction<StagedSource[]>>
}

export default function AnalysisToolsPage({ stagedSources, setStagedSources }: AnalysisToolsPageProps) {
  const ds = useStore(s => s.dataset)
  const source = useStore(s => s.source)
  const addColumns = useStore(s => s.addColumns)
  const addDescriptor = useStore(s => s.addDescriptor)
  const addMolecularVector = useStore(s => s.addMolecularVector)
  const addAtomProperty = useStore(s => s.addAtomProperty)
  const registerOptimizedGeometrySet = useStore(s => s.registerOptimizedGeometrySet)
  const setSource = useStore(s => s.setSource)
  const pushToast = useUIStore(s => s.pushToast)
  const [datasetOrigin, setDatasetOrigin] = useState(() => ANALYSIS_PAGE_STATE_CACHE.datasetOrigin || '')
  const [molcraftAvailable, setMolcraftAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    fetch(`${BACKEND}/healthz`)
      .then(r => r.json())
      .then(d => setMolcraftAvailable(d.molcraft_available ?? true))
      .catch(() => setMolcraftAvailable(null))
  }, [])

  // Reference compare only — shallow-comparing the whole column array is O(rows) per store update.
  const dataSourceColumn = useStore(s => s.dataset?.columns.data_source) as ArrayLike<unknown> | undefined
  const sourceOptions = useMemo<SourceOption[]>(() => {
    const options: SourceOption[] = []

    if (ds) {
      const origins = uniqueSortedStrings(ds.ids.map((_id, i) => valueAt(dataSourceColumn, i)))
      if (origins.length > 1) {
        options.push({
          value: sourceOptionValue('compiled_all', '__all__'),
          label: `All compiled sources (${origins.length} subsets, ${ds.ids.length.toLocaleString()} molecules)`,
          originLabel: '__all__',
          kind: 'compiled_all',
        })
      }
      options.push(...origins.map(origin => ({
        value: sourceOptionValue('compiled', origin),
        label: `${origin} (compiled)`,
        originLabel: origin,
        kind: 'compiled' as const,
      })))
    }

    options.push(
      ...stagedSources
        .filter(s => s.dataset?.ids?.length > 0)
        .map(s => ({
          value: sourceOptionValue('staged', s.id),
          label: s.included
            ? `${s.label} (staged)`
            : `${s.label} (staged, excluded in organizer)`,
          originLabel: s.label,
          kind: 'staged' as const,
          stagedSourceId: s.id,
        }))
    )

    return options
  }, [ds, dataSourceColumn, stagedSources])
  const selectedSourceOption = useMemo(() => (
    sourceOptions.find(option => option.value === datasetOrigin) || null
  ), [sourceOptions, datasetOrigin])
  const selectedStagedSource = useMemo(() => {
    if (!selectedSourceOption || selectedSourceOption.kind !== 'staged') return null
    return stagedSources.find(s => s.id === selectedSourceOption.stagedSourceId) || null
  }, [selectedSourceOption, stagedSources])
  const selectedOriginLabel = selectedSourceOption?.originLabel || ''
  const sourceTypeLabel = selectedSourceOption?.kind === 'staged'
    ? 'staged source'
    : selectedSourceOption?.kind === 'compiled_all'
      ? 'all compiled sources'
      : 'compiled source'
  const hasAnyCompiledOption = sourceOptions.some(option => option.kind === 'compiled' || option.kind === 'compiled_all')
  const hasAnyStagedOption = sourceOptions.some(option => option.kind === 'staged')
  const selectedCompiledDatasetIds = useMemo(() => {
    if (!ds || !selectedSourceOption) return []
    if (selectedSourceOption.kind === 'compiled_all') return ds.ids.map(String)
    if (selectedSourceOption.kind !== 'compiled') return []
    return ds.ids
      .map(String)
      .filter((_id, i) => String(valueAt(dataSourceColumn, i) || '') === selectedSourceOption.originLabel)
  }, [ds, dataSourceColumn, selectedSourceOption])

  const [tools, setTools] = useState<AnalysisToolSpec[]>(
    () => ANALYSIS_PAGE_STATE_CACHE.tools || FALLBACK_ANALYSIS_TOOLS
  )
  const [toolsError, setToolsError] = useState(() => ANALYSIS_PAGE_STATE_CACHE.toolsError || '')
  const [loadingTools, setLoadingTools] = useState(false)
  const [selectedToolId, setSelectedToolId] = useState(
    () => ANALYSIS_PAGE_STATE_CACHE.selectedToolId || FALLBACK_ANALYSIS_TOOLS[0]?.id || ''
  )
  const [formValues, setFormValues] = useState<Record<string, any>>(
    () => ANALYSIS_PAGE_STATE_CACHE.formValues || {}
  )
  const [addingToQueue, setAddingToQueue] = useState(() => ANALYSIS_PAGE_STATE_CACHE.addingToQueue || false)
  const [statusMessage, setStatusMessage] = useState(() => ANALYSIS_PAGE_STATE_CACHE.statusMessage || '')
  const [errorMessage, setErrorMessage] = useState(() => ANALYSIS_PAGE_STATE_CACHE.errorMessage || '')
  const [warnings, setWarnings] = useState<string[]>(() => ANALYSIS_PAGE_STATE_CACHE.warnings || [])
  const [stats, setStats] = useState<Record<string, any> | null>(() => ANALYSIS_PAGE_STATE_CACHE.stats || null)
  const [queue, setQueue] = useState<AnalysisQueueItem[]>(
    () => (ANALYSIS_PAGE_STATE_CACHE.queue || readStoredAnalysisQueue())
      .map(withOptimizationRegistrationDefaults)
      .map(withOptimizationRegistrationLegacyFix)
  )
  const [workflow, setWorkflow] = useState<AnalysisWorkflowState>(
    () => ANALYSIS_PAGE_STATE_CACHE.workflow || readStoredAnalysisWorkflow()
  )
  const [workflowBusy, setWorkflowBusy] = useState(false)
  const [registeringJobId, setRegisteringJobId] = useState('')
  const [applyingAll, setApplyingAll] = useState(false)
  const xyzByIdRef = useRef<Record<string, string> | null>(null)
  const applyResultCacheRef = useRef<Record<string, AnalysisRunResponse>>({})
  const workflowRef = useRef<AnalysisWorkflowState>(workflow)
  const queueRef = useRef<AnalysisQueueItem[]>(queue)
  const dsRef = useRef<Dataset | null>(ds)
  const sourceRef = useRef(source)
  const stagedSourcesRef = useRef<StagedSource[]>(stagedSources)
  const workflowAbortRef = useRef(false)
  const workflowRunningRef = useRef(false)
  const formValuesByToolRef = useRef<Record<string, Record<string, any>>>(
    ANALYSIS_PAGE_STATE_CACHE.formValuesByTool || {}
  )
  const prevSelectedToolIdRef = useRef<string>('')

  const selectedTool = useMemo(
    () => tools.find(t => t.id === selectedToolId) || tools[0] || null,
    [tools, selectedToolId]
  )

  useEffect(() => {
    if (!sourceOptions.length) {
      if (datasetOrigin) setDatasetOrigin('')
      return
    }
    if (datasetOrigin && sourceOptions.some(option => option.value === datasetOrigin)) return
    const firstCompiled = sourceOptions.find(option => option.kind === 'compiled')
    setDatasetOrigin(firstCompiled?.value || sourceOptions[0].value)
  }, [sourceOptions, datasetOrigin])

  useEffect(() => {
    const currentToolId = selectedTool?.id || ''
    setFormValues(prev => {
      const prevToolId = prevSelectedToolIdRef.current
      if (prevToolId && prevToolId !== currentToolId) {
        formValuesByToolRef.current[prevToolId] = { ...prev }
      }

      if (!currentToolId) return {}

      const base = prevToolId === currentToolId
        ? prev
        : formValuesByToolRef.current[currentToolId]
      const next = base
        ? mergeFormValuesForTool(selectedTool, base)
        : makeInitialFormValues(selectedTool)
      formValuesByToolRef.current[currentToolId] = next
      return next
    })
    prevSelectedToolIdRef.current = currentToolId
  }, [selectedTool])

  const loadTools = async () => {
    setLoadingTools(true)
    setToolsError('')
    try {
      const resp = await fetch(`${BACKEND}/analysis-tools`)
      const data = await resp.json()
      if (!resp.ok) throw new Error(getErrorMessage(data, `HTTP ${resp.status}`))
      const loaded = Array.isArray(data?.tools) ? data.tools : []
      if (loaded.length) {
        setTools(withBackfilledToolInputs(loaded))
        setSelectedToolId(prev => loaded.some((t: AnalysisToolSpec) => t.id === prev) ? prev : loaded[0].id)
      }
    } catch (err: any) {
      setToolsError(err?.message || String(err))
      setTools(FALLBACK_ANALYSIS_TOOLS)
    } finally {
      setLoadingTools(false)
    }
  }

  useEffect(() => {
    loadTools()
  }, [])

  useEffect(() => {
    writeStoredAnalysisQueue(queue)
    queueRef.current = queue
  }, [queue])

  useEffect(() => {
    writeStoredAnalysisWorkflow(workflow)
    workflowRef.current = workflow
  }, [workflow])

  useEffect(() => {
    if (!workflow.steps.some(step => step.job_id)) return
    const queueByJobId = new Map(queue.map(item => [item.job_id, item]))
    setWorkflow(prev => {
      let changed = false
      const steps = prev.steps.map(step => {
        if (!step.job_id) return step
        const item = queueByJobId.get(step.job_id)
        if (!item) return step
        const nextStatus = isTerminalAnalysisStatus(item.status)
          ? (item.status as WorkflowStepStatus)
          : (item.status === 'running' || item.status === 'queued' ? item.status : step.status)
        if (
          nextStatus === step.status &&
          item.started_at === step.started_at &&
          item.finished_at === step.finished_at &&
          item.error === step.error
        ) {
          return step
        }
        changed = true
        return {
          ...step,
          status: nextStatus,
          started_at: item.started_at,
          finished_at: item.finished_at,
          error: item.error || step.error,
        }
      })
      return changed ? { ...prev, steps, updated_at: new Date().toISOString() } : prev
    })
  }, [queue, workflow.steps])

  useEffect(() => {
    dsRef.current = ds
  }, [ds])

  useEffect(() => {
    sourceRef.current = source
  }, [source])

  useEffect(() => {
    stagedSourcesRef.current = stagedSources
  }, [stagedSources])

  useEffect(() => {
    ANALYSIS_PAGE_STATE_CACHE.tools = tools
    ANALYSIS_PAGE_STATE_CACHE.toolsError = toolsError
    ANALYSIS_PAGE_STATE_CACHE.selectedToolId = selectedToolId
    ANALYSIS_PAGE_STATE_CACHE.datasetOrigin = datasetOrigin
    ANALYSIS_PAGE_STATE_CACHE.formValues = formValues
    ANALYSIS_PAGE_STATE_CACHE.formValuesByTool = formValuesByToolRef.current
    ANALYSIS_PAGE_STATE_CACHE.addingToQueue = addingToQueue
    ANALYSIS_PAGE_STATE_CACHE.statusMessage = statusMessage
    ANALYSIS_PAGE_STATE_CACHE.errorMessage = errorMessage
    ANALYSIS_PAGE_STATE_CACHE.warnings = warnings
    ANALYSIS_PAGE_STATE_CACHE.stats = stats
    ANALYSIS_PAGE_STATE_CACHE.queue = queue
    ANALYSIS_PAGE_STATE_CACHE.workflow = workflow
  }, [
    tools,
    toolsError,
    selectedToolId,
    datasetOrigin,
    formValues,
    addingToQueue,
    statusMessage,
    errorMessage,
    warnings,
    stats,
    queue,
    workflow,
  ])

  const selectedCount = useMemo(() => {
    if (!selectedSourceOption) return 0
    if (selectedSourceOption.kind === 'compiled_all') return ds?.ids.length || 0
    if (selectedSourceOption.kind === 'compiled') {
      return selectedCompiledDatasetIds.length
    }
    return selectedStagedSource?.dataset.ids.length || 0
  }, [ds, selectedSourceOption, selectedCompiledDatasetIds, selectedStagedSource])

  const currentDatasetIds = useMemo(() => {
    if (!selectedSourceOption) return []
    if (selectedSourceOption.kind === 'compiled_all') return ds?.ids.map(String) || []
    if (selectedSourceOption.kind === 'compiled') return selectedCompiledDatasetIds
    return selectedStagedSource?.dataset.ids.map(String) || []
  }, [ds, selectedSourceOption, selectedCompiledDatasetIds, selectedStagedSource])
  const selectedDatasetForAnalysis = selectedSourceOption?.kind === 'staged'
    ? selectedStagedSource?.dataset
    : ds
  const vectorColumnOptions = useMemo(
    () => vectorColumnOptionsForDataset(selectedDatasetForAnalysis, currentDatasetIds),
    [selectedDatasetForAnalysis, currentDatasetIds]
  )
  const smilesColumnOptions = useMemo(
    () => smilesColumnOptionsForDataset(selectedDatasetForAnalysis, currentDatasetIds),
    [selectedDatasetForAnalysis, currentDatasetIds]
  )
  const effectiveAnalysisField = (field: AnalysisInput): AnalysisInput => {
    if (
      selectedTool?.id === 'dimensionality_reduction' &&
      field.optionsSource === 'vector_columns'
    ) {
      return { ...field, options: vectorColumnOptions }
    }
    if (
      selectedTool?.id === 'featurize' &&
      field.optionsSource === 'smiles_columns'
    ) {
      return { ...field, options: smilesColumnOptions }
    }
    return field
  }
  const effectiveFieldForToolSource = (
    tool: AnalysisToolSpec | null,
    field: AnalysisInput,
    dataset: Dataset | null | undefined,
    selectedIds: string[]
  ): AnalysisInput => {
    if (tool?.id === 'dimensionality_reduction' && field.optionsSource === 'vector_columns') {
      return { ...field, options: vectorColumnOptionsForDataset(dataset, selectedIds) }
    }
    if (tool?.id === 'featurize' && field.optionsSource === 'smiles_columns') {
      return { ...field, options: smilesColumnOptionsForDataset(dataset, selectedIds) }
    }
    return field
  }
  const validityFilterColumns = useMemo(() => {
    const activeDs = selectedSourceOption?.kind === 'staged' ? (selectedStagedSource?.dataset ?? null) : ds
    return validityFilterColumnsForDataset(activeDs)
  }, [ds, selectedSourceOption, selectedStagedSource])
  const matchingValidityJob = useMemo(
    () => newestMatchingValidityJob(queue, selectedOriginLabel, currentDatasetIds),
    [queue, selectedOriginLabel, currentDatasetIds]
  )
  const showXtbValidityFilter =
    selectedTool?.id === 'xtb_geometry_optimization' &&
    !!matchingValidityJob &&
    validityFilterColumns.length > 0

  useEffect(() => {
    if (selectedTool?.id !== 'xtb_geometry_optimization') return
    setFormValues(prev => {
      const next = { ...prev }
      if (showXtbValidityFilter && matchingValidityJob) {
        next.filter_csv_job_id = matchingValidityJob.job_id
        if (!validityFilterColumns.includes(String(next.filter_column || ''))) {
          next.filter_column = preferredValidityFilterColumn(validityFilterColumns)
        }
      } else {
        delete next.filter_csv_job_id
        delete next.filter_column
      }
      formValuesByToolRef.current[selectedTool.id] = next
      return next
    })
  }, [selectedTool?.id, showXtbValidityFilter, matchingValidityJob?.job_id, validityFilterColumns])

  useEffect(() => {
    if (selectedTool?.id !== 'dimensionality_reduction') return
    setFormValues(prev => {
      const optionValues = new Set(vectorColumnOptions.map(opt => opt.value))
      const current = String(prev.vector_column || '')
      const nextValue = optionValues.has(current) ? current : (vectorColumnOptions[0]?.value || '')
      if (nextValue === current) return prev
      const next = { ...prev, vector_column: nextValue }
      formValuesByToolRef.current[selectedTool.id] = next
      return next
    })
  }, [selectedTool?.id, vectorColumnOptions])

  useEffect(() => {
    if (selectedTool?.id !== 'featurize' || String(formValues.backend || 'soap') !== 'fingerprint') return
    setFormValues(prev => {
      const optionValues = new Set(smilesColumnOptions.map(opt => opt.value))
      const current = String(prev.smiles_column || '')
      const nextValue = optionValues.has(current) ? current : (smilesColumnOptions[0]?.value || '')
      if (nextValue === current) return prev
      const next = { ...prev, smiles_column: nextValue }
      formValuesByToolRef.current[selectedTool.id] = next
      return next
    })
  }, [selectedTool?.id, formValues.backend, smilesColumnOptions])

  const setFieldValue = (key: string, value: any) => {
    setFormValues(prev => {
      const next = { ...prev, [key]: value }
      const toolId = selectedTool?.id
      if (toolId) formValuesByToolRef.current[toolId] = next
      return next
    })
  }

  const validateToolParams = (
    tool: AnalysisToolSpec | null,
    values: Record<string, any>,
    sourceOption: SourceOption | null,
    dataset: Dataset | null | undefined,
    selectedIds: string[]
  ) => {
    if (!tool) return 'Select an analysis tool.'
    if (!sourceOption) return 'Select a dataset origin.'
    for (const field of visibleInputsForValues(tool, values)) {
      const effectiveField = effectiveFieldForToolSource(tool, field, dataset, selectedIds)
      const value = values[field.key]
      if (
        tool.id === 'dimensionality_reduction' &&
        field.key === 'vector_column' &&
        value === '__previous_vector__'
      ) {
        continue
      }
      if (field.required && field.type === 'select' && normalizeOptions(effectiveField.options).length === 0) {
        return `No options available for field: ${field.label || field.key}`
      }
      if (field.required && (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0))) {
        return `Missing required field: ${field.label || field.key}`
      }
      if ((field.type === 'integer' || field.type === 'slider_int') && value !== '' && !Number.isInteger(Number(value))) {
        return `Field ${field.label || field.key} must be an integer.`
      }
      if ((field.type === 'float' || field.type === 'slider_float') && value !== '' && Number.isNaN(Number(value))) {
        return `Field ${field.label || field.key} must be a number.`
      }
    }
    return ''
  }

  const validateForm = (values = formValues) => (
    validateToolParams(selectedTool, values, selectedSourceOption, selectedDatasetForAnalysis, currentDatasetIds)
  )

  const resolveAnalysisXyzByIds = async (
    ids: string[],
    sourceOption: SourceOption,
    primarySource: any
  ): Promise<Record<string, string>> => {
    const out = await resolveXyzByIds(ids, primarySource)
    const missingIds = ids.filter(id => !lookupXyzById(out, id))
    if (missingIds.length === 0 || sourceOption.kind === 'staged') return out

    const sourceValues = selectedDatasetForAnalysis?.columns.data_source
      ? Array.from(selectedDatasetForAnalysis.columns.data_source as any).map(v => String(v ?? '').trim())
      : []
    const idToSource = new Map<string, string>()
    const allIds = selectedDatasetForAnalysis?.ids.map(String) || []
    allIds.forEach((id, idx) => {
      const label = sourceValues[idx] || ''
      if (label) idToSource.set(id, label)
    })

    for (const id of missingIds) {
      const expectedSource = sourceOption.kind === 'compiled_all'
        ? idToSource.get(id)
        : sourceOption.originLabel
      const candidates = expectedSource
        ? [
            ...stagedSourcesRef.current.filter(staged => staged.label === expectedSource),
            ...stagedSourcesRef.current.filter(staged => staged.label !== expectedSource),
          ]
        : stagedSourcesRef.current
      for (const staged of candidates) {
        if (
          sourceOption.kind === 'compiled' &&
          expectedSource &&
          staged.label !== expectedSource
        ) {
          continue
        }
        const xyz = lookupXyzById(staged.xyzById, id)
        if (xyz) {
          out[id] = xyz
          break
        }
      }
    }

    return out
  }

  const applyAnalysisResult = async (
    result: AnalysisRunResponse,
    allXyzById?: Record<string, string>,
    toolName = selectedTool?.name || 'Analysis tool'
  ) => {
    if (result.addColumns?.length) {
      addColumns(result.addColumns)
    }

    const descriptorsToAdd = [
      ...(result.addDescriptor ? [result.addDescriptor] : []),
      ...(result.addDescriptors || []),
    ]
    const descriptorWarnings: string[] = []
    for (const descriptor of descriptorsToAdd) {
      const out = addDescriptor(descriptor)
      if (out?.warning) descriptorWarnings.push(out.warning)
    }

    const molecularVectorWarnings: string[] = []
    for (const vector of result.addMolecularVectors || []) {
      const out = addMolecularVector(vector)
      if (out?.warning) molecularVectorWarnings.push(out.warning)
    }

    const atomPropertyWarnings: string[] = []
    for (const property of result.addAtomProperties || []) {
      const out = addAtomProperty(property)
      if (out?.warning) atomPropertyWarnings.push(out.warning)
    }

    if (result.replaceXyzById && Object.keys(result.replaceXyzById).length > 0) {
      const baseXyz = allXyzById || xyzByIdRef.current || {}
      const mergedXyzById = {
        ...baseXyz,
        ...result.replaceXyzById,
      }
      setSource({ mode: 'mixed', xyzById: mergedXyzById } as any)

      // Also write the replacements back onto any staged source that owns those
      // molecule IDs, so a subsequent "Compile dataset" keeps the optimized
      // geometry instead of reverting to the original staged XYZ. Best-effort:
      // only IDs a source actually contains are merged; renamed IDs are skipped.
      const replacements = result.replaceXyzById
      setStagedSources(prev => prev.map(s => {
        const owned: Record<string, string> = {}
        for (const id of s.dataset.ids) {
          const key = String(id)
          const xyz = replacements[key] ?? replacements[key.replace(/\.xyz$/i, '')]
          if (xyz) owned[key] = xyz
        }
        return Object.keys(owned).length
          ? { ...s, xyzById: { ...(s.xyzById || {}), ...owned } }
          : s
      }))
    }

    setStatusMessage(result.message || `${toolName} finished.`)
    setWarnings([...(result.warnings || []), ...descriptorWarnings, ...molecularVectorWarnings, ...atomPropertyWarnings])
    setStats(result.stats || null)
    setErrorMessage('')

    const molecularVectorCount = result.addMolecularVectors?.length || 0
    const atomPropertyCount = result.addAtomProperties?.length || 0
    if (result.addColumns?.length || descriptorsToAdd.length || molecularVectorCount || atomPropertyCount) {
      const parts = []
      if (result.addColumns?.length) parts.push(`${result.addColumns.length} analysis columns`)
      if (descriptorsToAdd.length) parts.push(`${descriptorsToAdd.length} descriptors`)
      if (molecularVectorCount) parts.push(`${molecularVectorCount} molecular vectors`)
      if (atomPropertyCount) parts.push(`${atomPropertyCount} atom properties`)
      pushToast(`Added ${parts.join(' and ')}.`, 'success')
    } else if (result.replaceXyzById && Object.keys(result.replaceXyzById).length > 0) {
      pushToast(`Replaced XYZ for ${Object.keys(result.replaceXyzById).length} molecules.`, 'success')
    } else {
      pushToast(`${toolName} finished.`, 'success')
    }
  }

  const refreshJobStatus = async (jobId: string) => {
    const resp = await fetch(`${BACKEND}/analysis-tools/jobs/${jobId}`)
    const data = await resp.json()
    if (!resp.ok) throw new Error(getErrorMessage(data, `HTTP ${resp.status}`))
    return data as AnalysisJobStatus
  }

  const fetchApplyResult = async (jobId: string) => {
    const cached = applyResultCacheRef.current[jobId]
    if (cached) return cached

    const resp = await fetch(`${BACKEND}/analysis-tools/jobs/${jobId}/apply`, { method: 'POST' })
    const data = await resp.json()
    if (!resp.ok) throw new Error(getErrorMessage(data, `HTTP ${resp.status}`))
    const result = data as AnalysisRunResponse
    applyResultCacheRef.current[jobId] = result
    return result
  }

  const applyCompletedJob = async (item: AnalysisQueueItem, throwOnError = false): Promise<boolean> => {
    const fail = (message: string) => {
      setErrorMessage(message)
      if (throwOnError) throw new Error(message)
      return false
    }
    if (item.source_kind === 'staged') {
      const staged = stagedSourcesRef.current.find(s => s.id === item.staged_source_id)
      if (!staged) {
        return fail('Cannot apply: the staged source this job was queued from no longer exists.')
      }
      if (!datasetIdsMatch(staged.dataset.ids.map(String), item.dataset_id_fingerprint)) {
        return fail(`Cannot apply ${item.tool_name}: the staged source dataset has changed since this job was queued.`)
      }
      try {
        const result = withAnalysisColumnIds(
          await fetchApplyResult(item.job_id),
          item.dataset_id_fingerprint
        )
        const descriptorWarnings: string[] = []
        const molecularVectorWarnings: string[] = []
        const atomPropertyWarnings: string[] = []
        setStagedSources(prev => prev.map(s => {
          if (s.id !== staged.id) return s
          let dataset: Dataset = {
            ...s.dataset,
            columns: { ...s.dataset.columns },
            meta: {
              ...s.dataset.meta,
              numericColumns: [...s.dataset.meta.numericColumns],
              categoricalColumns: [...s.dataset.meta.categoricalColumns],
              vectorColumns: [...(s.dataset.meta.vectorColumns || [])],
            },
            descriptors: s.dataset.descriptors ? { ...s.dataset.descriptors } : undefined,
            molecularVectors: s.dataset.molecularVectors ? { ...s.dataset.molecularVectors } : undefined,
            atomProperties: s.dataset.atomProperties ? { ...s.dataset.atomProperties } : undefined,
            columnOrder: s.dataset.columnOrder ? [...s.dataset.columnOrder] : undefined,
            stats: s.dataset.stats
              ? {
                  ...s.dataset.stats,
                  numericRanges: s.dataset.stats.numericRanges
                    ? { ...s.dataset.stats.numericRanges }
                    : s.dataset.stats.numericRanges,
                }
              : s.dataset.stats,
          }
          let columns = [...s.columns]
          let xyzById = { ...(s.xyzById || {}) }
          if (result.addColumns?.length) {
            for (const col of result.addColumns) {
              const isVector = col.kind === 'vector'
              const isNumeric = !isVector && (col.kind === 'numeric' || (col.kind == null && col.values.some(v => typeof v === 'number' && !Number.isNaN(v))))
              const hasExplicitIds = Array.isArray(col.ids)
              const valueById = hasExplicitIds && col.ids!.length === col.values.length
                ? new Map(col.ids.map((id, index) => [String(id), col.values[index]]))
                : null
              const alignedValues = hasExplicitIds
                ? (valueById ? dataset.ids.map(id => valueById.get(String(id)) ?? null) : [])
                : col.values
              if (alignedValues.length !== dataset.ids.length) continue
              dataset.columns[col.name] = isNumeric
                ? new Float32Array(alignedValues.map(v => (v == null || v === '' ? Number.NaN : Number(v))))
                : alignedValues.map(v => (v == null ? '' : String(v)))
              if (isVector) {
                dataset.meta.vectorColumns = Array.from(new Set([...(dataset.meta.vectorColumns || []), col.name]))
                dataset.meta.numericColumns = dataset.meta.numericColumns.filter(name => name !== col.name)
                dataset.meta.categoricalColumns = dataset.meta.categoricalColumns.filter(name => name !== col.name)
              } else if (isNumeric) {
                if (!dataset.meta.numericColumns.includes(col.name)) dataset.meta.numericColumns.push(col.name)
                dataset.meta.vectorColumns = (dataset.meta.vectorColumns || []).filter(name => name !== col.name)
              } else {
                if (!dataset.meta.categoricalColumns.includes(col.name)) dataset.meta.categoricalColumns.push(col.name)
                dataset.meta.vectorColumns = (dataset.meta.vectorColumns || []).filter(name => name !== col.name)
              }
              if (!columns.some(c => c.original === col.name)) {
                columns.push({ original: col.name, draftName: col.name, included: true })
              }
            }
            const existingOrder = new Set(dataset.columnOrder || Object.keys(dataset.columns))
            dataset.columnOrder = [
              ...(dataset.columnOrder || Object.keys(dataset.columns).filter(k => existingOrder.has(k))),
              ...result.addColumns.map(c => c.name).filter(n => !existingOrder.has(n)),
            ]
          }
          const descriptorsToAdd = [
            ...(result.addDescriptor ? [result.addDescriptor] : []),
            ...(result.addDescriptors || []),
          ]
          for (const descriptor of descriptorsToAdd) {
            const out = applyDescriptorToDataset(dataset, descriptor)
            dataset = out.dataset
            if (out.warning) descriptorWarnings.push(out.warning)
            if (!columns.some(c => c.original === descriptor.name)) {
              columns.push({ original: descriptor.name, draftName: descriptor.name, included: true })
            }
          }
          for (const vector of result.addMolecularVectors || []) {
            const out = applyMolecularVectorToDataset(dataset, vector)
            dataset = out.dataset
            if (out.warning) molecularVectorWarnings.push(out.warning)
          }
          for (const property of result.addAtomProperties || []) {
            const out = applyAtomPropertyToDataset(dataset, property)
            dataset = out.dataset
            if (out.warning) atomPropertyWarnings.push(out.warning)
          }
          if (result.replaceXyzById) Object.assign(xyzById, result.replaceXyzById)
          return { ...s, dataset, columns, xyzById }
        }))
        setStatusMessage(result.message || `${item.tool_name} applied to staged source '${staged.label}'.`)
        setWarnings([
          ...(result.warnings || []),
          ...descriptorWarnings,
          ...molecularVectorWarnings,
          ...atomPropertyWarnings,
        ])
        setErrorMessage('')
        setQueue(prev => prev.map(q => q.job_id === item.job_id ? { ...q, applied: true } : q))
        pushToast(`Applied ${item.tool_name} to staged source '${staged.label}'.`, 'success')
        return true
      } catch (err: any) {
        const message = err?.message || String(err)
        setErrorMessage(message)
        if (throwOnError) throw new Error(message)
      }
      return false
    }

    if (!ds) return fail('Cannot apply: no compiled dataset is loaded.')
    const currentIds = ds.ids.map(String)
    if (!datasetIdsMatch(currentIds, item.dataset_id_fingerprint)) {
      return fail(`Cannot apply ${item.tool_name}: the current dataset IDs do not match the dataset used when job ${item.job_id} was queued. Reload the original dataset before applying.`)
    }

    try {
      const result = withAnalysisColumnIds(
        await fetchApplyResult(item.job_id),
        item.dataset_id_fingerprint
      )
      let baseXyzById = xyzByIdRef.current || undefined
      if (result.replaceXyzById && Object.keys(result.replaceXyzById).length > 0) {
        try {
          baseXyzById = await buildXyzById(ds, source as any)
          xyzByIdRef.current = baseXyzById
        } catch {
          // applyAnalysisResult will still apply the replacement subset if rebuilding fails.
        }
      }

      await applyAnalysisResult(result, baseXyzById, item.tool_name)
      setQueue(prev => prev.map(q => q.job_id === item.job_id ? { ...q, applied: true } : q))
      return true
    } catch (err: any) {
      const message = err?.message || String(err)
      setErrorMessage(message)
      if (throwOnError) throw new Error(message)
    }
    return false
  }

  const updateQueueRegistrationField = (
    jobId: string,
    patch: Partial<AnalysisQueueItem>
  ) => {
    setQueue(prev => prev.map(item => item.job_id === jobId ? { ...item, ...patch } : item))
  }

  const updateQueueRegistrationSource = (item: AnalysisQueueItem, value: string) => {
    setQueue(prev => prev.map(q => {
      if (q.job_id !== item.job_id) return q
      const patch: Partial<AnalysisQueueItem> = { register_data_source: value }
      if (
        value.trim() &&
        value.trim() !== q.dataset_origin &&
        (q.register_id_prefix ?? '') === ''
      ) {
        patch.register_id_prefix = makeRegistrationPrefix(value)
      }
      return { ...q, ...patch }
    }))
  }

  const registerCompletedOptimizationJob = async (
    item: AnalysisQueueItem,
    throwOnError = false
  ): Promise<{ label: string; count: number } | null> => {
    const fail = (message: string) => {
      setErrorMessage(message)
      if (throwOnError) throw new Error(message)
      return null
    }
    if (item.source_kind === 'staged') {
      const staged = stagedSourcesRef.current.find(s => s.id === item.staged_source_id)
      if (!staged) {
        return fail('Cannot register: the staged source this job was queued from no longer exists.')
      }
      if (!datasetIdsMatch(staged.dataset.ids.map(String), item.dataset_id_fingerprint)) {
        return fail(`Cannot register ${item.tool_name}: the staged source dataset has changed since this job was queued.`)
      }
      setRegisteringJobId(item.job_id)
      setErrorMessage('')
      setStatusMessage(`Registering optimized geometry from staged source '${staged.label}'...`)
      try {
        const result = await fetchApplyResult(item.job_id)
        if (!result.replaceXyzById || Object.keys(result.replaceXyzById).length === 0) {
          throw new Error('No optimized molecules found in the job result.')
        }
        const rowCount = Object.keys(result.replaceXyzById).length
        const idPrefix = item.register_id_prefix ?? 'molGen_optimized'
        const defaultLabel = defaultOptimizedSourceLabel(item.dataset_origin || staged.label)
        const dataSourceLabel = (item.register_data_source ?? defaultLabel).trim() || defaultLabel
        const newStaged = buildOptimizedStagedSource(staged.dataset, result.replaceXyzById, dataSourceLabel, idPrefix)
        if (newStaged) {
          setStagedSources(prev => [...prev, newStaged])
        } else {
          // Fallback: patch XYZ in-place on the original staged source
          setStagedSources(prev => prev.map(s => {
            if (s.id !== staged.id) return s
            return { ...s, xyzById: { ...(s.xyzById || {}), ...result.replaceXyzById } }
          }))
        }
        setQueue(prev => prev.map(q => q.job_id === item.job_id ? { ...q, registered: true, registered_count: rowCount } : q))
        setStatusMessage(`Registered ${rowCount.toLocaleString()} optimized geometries as staged source '${dataSourceLabel}'.`)
        pushToast(`Registered ${rowCount.toLocaleString()} optimized geometries.`, 'success')
        return { label: dataSourceLabel, count: rowCount }
      } catch (err: any) {
        setStatusMessage('')
        const message = err?.message || String(err)
        setErrorMessage(message)
        if (throwOnError) throw new Error(message)
      } finally {
        setRegisteringJobId('')
      }
      return null
    }

    if (!ds) return fail('Cannot register: no compiled dataset is loaded.')
    const currentIds = ds.ids.map(String)
    if (!datasetIdsMatch(currentIds, item.dataset_id_fingerprint)) {
      return fail(`Cannot register ${item.tool_name}: the current dataset IDs do not match the dataset used when job ${item.job_id} was queued. Reload the original dataset before registering.`)
    }

    const idPrefix = item.register_id_prefix ?? 'molGen_optimized'
    const defaultLabel = defaultOptimizedSourceLabel(item.dataset_origin)
    const dataSourceLabel = (item.register_data_source ?? defaultLabel).trim()

    setRegisteringJobId(item.job_id)
    setErrorMessage('')
    setStatusMessage(`Registering optimized set from job ${item.job_id}...`)

    try {
      const result = await fetchApplyResult(item.job_id)
      if (!result.replaceXyzById || Object.keys(result.replaceXyzById).length === 0) {
        throw new Error('No optimized molecules found in the job result.')
      }

      let baseXyzById = xyzByIdRef.current || undefined
      try {
        const idsNeeded = baseXyzIdsNeededForOptimizedRegistration(
          ds,
          item.dataset_origin,
          idPrefix,
          dataSourceLabel,
          result.replaceXyzById
        )
        const resolvedBaseXyzById = await resolveXyzByIds(idsNeeded, source as any)
        baseXyzById = { ...(baseXyzById || {}), ...resolvedBaseXyzById }
        xyzByIdRef.current = baseXyzById
        // Warn (don't silently drop) if some carry-over rows have no geometry,
        // so the user knows the registered source may be missing structures.
        const stillMissing = idsNeeded.filter(id => !(baseXyzById as Record<string, string>)[id]).length
        if (stillMissing > 0) {
          pushToast(`${stillMissing.toLocaleString()} non-optimized molecules have no XYZ and will be registered without geometry.`, 'warning')
        }
      } catch {
        pushToast('Could not resolve original geometries; non-optimized molecules may be registered without XYZ.', 'warning')
        baseXyzById = baseXyzById || {}
      }

      const out = registerOptimizedGeometrySet({
        datasetOrigin: item.dataset_origin,
        idPrefix,
        dataSourceLabel,
        replaceXyzById: result.replaceXyzById,
        baseXyzById,
      })
      if (!out.ok) throw new Error(out.error || 'Could not register optimized set.')

      // Build a staged source containing only the optimized rows for the Management tab
      const matchAllOrigins = item.source_kind === 'compiled_all' || item.dataset_origin === '__all__'
      const sourceCol = ds.columns.data_source
        ? Array.from(ds.columns.data_source as any).map(v => String(v ?? '').trim() || 'dataset_1')
        : ds.ids.map(() => 'dataset_1')
      // For compiled_all: use all rows; for single source: filter to the matching source
      const filteredDataset = matchAllOrigins ? ds : (() => {
        const indices = ds.ids
          .map((rawId, i) => ({ id: String(rawId), i }))
          .filter(r => (sourceCol as string[])[r.i] === item.dataset_origin)
        if (indices.length === ds.ids.length) return ds
        const newColumns: Record<string, any> = {}
        for (const [col, vals] of Object.entries(ds.columns)) {
          if ((ds.meta.numericColumns || []).includes(col)) {
            const arr = new Float32Array(indices.length)
            for (let j = 0; j < indices.length; j++) arr[j] = (vals as any)[indices[j].i]
            newColumns[col] = arr
          } else {
            newColumns[col] = indices.map(r => (vals as any)[r.i])
          }
        }
        return { ...ds, ids: indices.map(r => r.id), columns: newColumns }
      })()
      const newStaged = buildOptimizedStagedSource(filteredDataset, result.replaceXyzById, dataSourceLabel, idPrefix)
      if (newStaged) setStagedSources(prev => [...prev, newStaged])

      const rowCount = out.rowCount || 0
      setQueue(prev => prev.map(q => q.job_id === item.job_id ? {
        ...q,
        registered: true,
        registered_count: rowCount,
        register_id_prefix: idPrefix,
        register_data_source: dataSourceLabel,
      } : q))
      setStatusMessage(`Registered ${rowCount.toLocaleString()} optimized molecules from job ${item.job_id}.`)
      pushToast(`Registered ${rowCount.toLocaleString()} optimized molecules.`, 'success')
      return { label: dataSourceLabel, count: rowCount }
    } catch (err: any) {
      setStatusMessage('')
      const message = err?.message || String(err)
      setErrorMessage(message)
      if (throwOnError) throw new Error(message)
    } finally {
      setRegisteringJobId('')
    }
    return null
  }

  const cancelQueuedJob = async (jobId: string) => {
    try {
      const resp = await fetch(`${BACKEND}/analysis-tools/jobs/${jobId}`, { method: 'DELETE' })
      const data = await resp.json()
      if (!resp.ok) throw new Error(getErrorMessage(data, `HTTP ${resp.status}`))
      const status = data as AnalysisJobStatus
      setQueue(prev => prev.map(q => q.job_id === jobId ? queueItemFromStatus(status, q) : q))
      setStatusMessage(`Analysis job ${jobId} cancelled.`)
      pushToast('Analysis job cancelled.', 'success')
    } catch (err: any) {
      setErrorMessage(err?.message || String(err))
    }
  }

  const clearAnalysisQueue = () => {
    setQueue([])
    setRegisteringJobId('')
    setStatusMessage('Analysis queue cleared.')
    setErrorMessage('')
    pushToast('Analysis queue cleared.', 'success')
  }

  const applyAllCompletedJobs = async () => {
    const applicable = queue.filter(
      item => item.status === 'completed' && (!item.applied || item.tool_id === 'featurize')
    )
    if (!applicable.length) return
    setApplyingAll(true)
    setErrorMessage('')
    setStatusMessage(`Applying ${applicable.length} completed job${applicable.length === 1 ? '' : 's'}...`)
    for (const item of applicable) {
      try {
        await applyCompletedJob(item)
      } catch {
        // applyCompletedJob already sets errorMessage; continue with remaining jobs
      }
    }
    setApplyingAll(false)
  }

  const resolveWorkflowSourceOption = (ref: WorkflowSourceRef): SourceOption | null => {
    const currentDs = useStore.getState().dataset || dsRef.current
    if (ref.kind === 'compiled_all') {
      if (!currentDs) return null
      return {
        value: sourceOptionValue('compiled_all', '__all__'),
        label: `All compiled sources (${currentDs.ids.length.toLocaleString()} molecules)`,
        originLabel: '__all__',
        kind: 'compiled_all',
      }
    }
    if (ref.kind === 'staged') {
      const staged = stagedSourcesRef.current.find(s => (
        (ref.stagedSourceId && s.id === ref.stagedSourceId) || s.label === ref.originLabel
      ))
      if (!staged?.dataset?.ids?.length) return null
      return {
        value: sourceOptionValue('staged', staged.id),
        label: `${staged.label} (staged)`,
        originLabel: staged.label,
        kind: 'staged',
        stagedSourceId: staged.id,
      }
    }
    if (!currentDs) return null
    const sourceValues = currentDs.columns.data_source
      ? Array.from(currentDs.columns.data_source as any).map(v => String(v ?? '').trim() || 'dataset_1')
      : currentDs.ids.map(() => 'dataset_1')
    if (!sourceValues.includes(ref.originLabel)) return null
    return {
      value: sourceOptionValue('compiled', ref.originLabel),
      label: `${ref.originLabel} (compiled)`,
      originLabel: ref.originLabel,
      kind: 'compiled',
    }
  }

  const submitAnalysisJob = async (
    tool: AnalysisToolSpec,
    sourceOption: SourceOption,
    submitValues: Record<string, any>,
    queueSeed?: Partial<AnalysisQueueItem>
  ): Promise<AnalysisQueueItem> => {
    const requiresXyz = analysisToolRequiresXyz(tool, submitValues)
    setStatusMessage(requiresXyz ? 'Collecting XYZ for selected dataset origin...' : 'Preparing selected dataset origin...')
    setErrorMessage('')
    setWarnings([])
    setStats(null)

    const isCompiledKind = sourceOption.kind === 'compiled' || sourceOption.kind === 'compiled_all'
    const selectedDataset = isCompiledKind
      ? (useStore.getState().dataset || dsRef.current)
      : stagedSourcesRef.current.find(s => s.id === sourceOption.stagedSourceId)?.dataset
    if (!selectedDataset) throw new Error('Selected source dataset is unavailable.')
    const selectedStaged = sourceOption.kind === 'staged'
      ? stagedSourcesRef.current.find(s => s.id === sourceOption.stagedSourceId)
      : null
    const selectedDatasetSource = isCompiledKind ? (useStore.getState().source || sourceRef.current) : selectedStaged?.source
    const sourceValues = selectedDataset.columns.data_source
      ? Array.from(selectedDataset.columns.data_source as any).map(v => String(v ?? '').trim() || 'dataset_1')
      : selectedDataset.ids.map(() => 'dataset_1')
    const selectedIds = selectedDataset.ids
      .map(String)
      .filter((_id, i) => (
        sourceOption.kind === 'compiled'
          ? sourceValues[i] === sourceOption.originLabel
          : true
      ))
    const validation = validateToolParams(tool, submitValues, sourceOption, selectedDataset, selectedIds)
    if (validation) throw new Error(validation)

    const xyzById: Record<string, string> = {}
    if (requiresXyz) {
      const allXyzById = sourceOption.kind === 'staged' && selectedStaged?.xyzById
        ? selectedStaged.xyzById
        : await resolveAnalysisXyzByIds(selectedIds, sourceOption, selectedDatasetSource as any)
      xyzByIdRef.current = allXyzById
      for (const id of selectedIds) {
        const xyz = lookupXyzById(allXyzById, id)
        if (xyz) xyzById[id] = xyz
      }
      if (Object.keys(xyzById).length === 0) {
        throw new Error('No XYZ content was found for the selected dataset origin.')
      }
      const missingXyzCount = selectedIds.length - Object.keys(xyzById).length
      if (missingXyzCount > 0) {
        setWarnings([
          `${missingXyzCount.toLocaleString()} selected molecules do not have XYZ content in the current compiled/staged sources and will be skipped.`,
        ])
      }
    }

    const moleculeCount = requiresXyz ? Object.keys(xyzById).length : selectedIds.length
    setStatusMessage(`Starting ${tool.name} job on ${moleculeCount.toLocaleString()} molecules...`)

    const resp = await fetch(`${BACKEND}/analysis-tools/${tool.id}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataset: {
          ...serializeDataset(selectedDataset),
          xyzById,
        },
        dataset_origin: sourceOption.kind === 'compiled_all' ? '' : sourceOption.originLabel,
        params: submitValues,
      }),
    })

    const data = await resp.json()
    if (!resp.ok) throw new Error(getErrorMessage(data, `HTTP ${resp.status}`))
    const status = data as AnalysisJobStatus
    const jobId = status.job_id || ''
    if (!jobId) throw new Error('Backend did not return an analysis job id.')
    const item = queueItemFromStatus(status, {
      job_id: jobId,
      tool_id: tool.id,
      tool_name: tool.name,
      dataset_origin: sourceOption.originLabel,
      params: submitValues,
      molecule_count: moleculeCount,
      dataset_id_fingerprint: selectedDataset.ids.map(String),
      status: status.status || 'queued',
      applied: false,
      show_log: status.status === 'running',
      source_kind: sourceOption.kind,
      staged_source_id: sourceOption.stagedSourceId,
      ...(tool.id === 'xtb_geometry_optimization' ? {
        register_id_prefix: queueSeed?.register_id_prefix ?? 'molGen_optimized',
        register_data_source: queueSeed?.register_data_source ?? defaultOptimizedSourceLabel(sourceOption.originLabel),
      } : {}),
      ...queueSeed,
    })
    setQueue(prev => [item, ...prev.filter(q => q.job_id !== jobId)])
    setStatusMessage(`Analysis job ${jobId} added to the queue.`)
    return item
  }

  const addSelectedToolToQueue = async () => {
    if (!selectedTool || !selectedSourceOption) return

    const mergedValues = mergeFormValuesForTool(selectedTool, formValues)
    const submitValues = buildSubmitValues(selectedTool, mergedValues)
    const cachedValues = { ...mergedValues }
    if (selectedTool.id === 'xtb_geometry_optimization' && showXtbValidityFilter && matchingValidityJob) {
      const filterColumn = String(formValues.filter_column || '').trim()
      if (filterColumn) {
        submitValues.filter_csv_job_id = matchingValidityJob.job_id
        submitValues.filter_column = filterColumn
        cachedValues.filter_csv_job_id = matchingValidityJob.job_id
        cachedValues.filter_column = filterColumn
      }
    }
    formValuesByToolRef.current[selectedTool.id] = cachedValues

    const validation = validateForm(submitValues)
    if (validation) {
      setErrorMessage(validation)
      return
    }

    setAddingToQueue(true)
    try {
      await submitAnalysisJob(selectedTool, selectedSourceOption, submitValues)
    } catch (err: any) {
      setStatusMessage('')
      setErrorMessage(err?.message || String(err))
      setWarnings([])
      setStats(null)
    } finally {
      setAddingToQueue(false)
    }
  }

  const addCurrentToolToWorkflow = () => {
    if (!selectedTool || !selectedSourceOption) return
    const mergedValues = mergeFormValuesForTool(selectedTool, formValues)
    const submitValues = buildSubmitValues(selectedTool, mergedValues)
    const sourceRef = sourceRefFromOption(selectedSourceOption)
    if (
      selectedTool.id === 'dimensionality_reduction' &&
      !String(submitValues.vector_column || '').trim()
    ) {
      const hasPriorVectorStep = workflow.steps.some(step => (
        step.tool_id === 'featurize' &&
        workflowSourceRefKey(step.sourceRef) === workflowSourceRefKey(sourceRef)
      ))
      if (hasPriorVectorStep) submitValues.vector_column = '__previous_vector__'
    }
    const validation = validateForm(submitValues)
    if (validation) {
      setErrorMessage(validation)
      return
    }
    const sameSourceValidityStep = workflow.steps
      .slice()
      .reverse()
      .find(step => (
        step.tool_id === 'validity_connectivity' &&
        workflowSourceRefKey(step.sourceRef) === workflowSourceRefKey(sourceRef)
      ))
    const defaultRegisterLabel = defaultOptimizedSourceLabel(selectedSourceOption.originLabel)
    const step: AnalysisWorkflowStep = {
      id: makeWorkflowStepId(),
      tool_id: selectedTool.id,
      tool_name: selectedTool.name,
      sourceRef,
      params: submitValues,
      postAction: defaultPostActionForTool(selectedTool),
      status: 'idle',
      register_id_prefix: selectedTool.id === 'xtb_geometry_optimization' ? 'molGen_optimized' : undefined,
      register_data_source: selectedTool.id === 'xtb_geometry_optimization' ? defaultRegisterLabel : undefined,
      outputSourceLabel: selectedTool.id === 'xtb_geometry_optimization' ? defaultRegisterLabel : undefined,
      usePreviousValidityFilter: selectedTool.id === 'xtb_geometry_optimization' ? !!sameSourceValidityStep : undefined,
      filter_column: selectedTool.id === 'xtb_geometry_optimization'
        ? String(formValues.filter_column || preferredValidityFilterColumn(validityFilterColumns) || VALIDITY_FILTER_COLUMN_PRIORITY[0])
        : undefined,
    }
    setWorkflow(prev => ({
      ...prev,
      steps: [...prev.steps, step],
      status: prev.status === 'completed' ? 'idle' : prev.status,
      message: `Added ${selectedTool.name} to workflow.`,
      error: '',
      updated_at: new Date().toISOString(),
    }))
    setStatusMessage(`Added ${selectedTool.name} to workflow.`)
    setErrorMessage('')
  }

  const updateWorkflowStep = (stepId: string, patch: Partial<AnalysisWorkflowStep>) => {
    setWorkflow(prev => ({
      ...prev,
      steps: prev.steps.map(step => step.id === stepId ? { ...step, ...patch } : step),
      updated_at: new Date().toISOString(),
    }))
  }

  const moveWorkflowStep = (stepId: string, direction: -1 | 1) => {
    setWorkflow(prev => {
      const index = prev.steps.findIndex(step => step.id === stepId)
      const nextIndex = index + direction
      if (index < 0 || nextIndex < 0 || nextIndex >= prev.steps.length) return prev
      const steps = [...prev.steps]
      const [step] = steps.splice(index, 1)
      steps.splice(nextIndex, 0, step)
      return { ...prev, steps, updated_at: new Date().toISOString() }
    })
  }

  const removeWorkflowStep = (stepId: string) => {
    setWorkflow(prev => ({
      ...prev,
      steps: prev.steps.filter(step => step.id !== stepId),
      activeStepId: prev.activeStepId === stepId ? '' : prev.activeStepId,
      status: prev.activeStepId === stepId && prev.status === 'running' ? 'paused' : prev.status,
      updated_at: new Date().toISOString(),
    }))
  }

  const loadWorkflowStepIntoForm = (step: AnalysisWorkflowStep) => {
    const tool = tools.find(t => t.id === step.tool_id)
    if (!tool) return
    setSelectedToolId(step.tool_id)
    setFormValues(mergeFormValuesForTool(tool, step.params))
    formValuesByToolRef.current[step.tool_id] = mergeFormValuesForTool(tool, step.params)
    const option = resolveWorkflowSourceOption(step.sourceRef)
    if (option) setDatasetOrigin(option.value)
    setStatusMessage(`Loaded workflow step '${step.tool_name}' into settings.`)
  }

  const findPriorWorkflowValidityStep = (stepIndex: number, step: AnalysisWorkflowStep) => {
    const sourceKey = workflowSourceRefKey(step.sourceRef)
    for (let i = stepIndex - 1; i >= 0; i--) {
      const prior = workflowRef.current.steps[i]
      if (
        prior.tool_id === 'validity_connectivity' &&
        prior.job_id &&
        prior.status === 'completed' &&
        workflowSourceRefKey(prior.sourceRef) === sourceKey
      ) {
        return prior
      }
    }
    return null
  }

  const findPriorWorkflowVectorStep = (stepIndex: number, step: AnalysisWorkflowStep) => {
    const sourceKey = workflowSourceRefKey(step.sourceRef)
    for (let i = stepIndex - 1; i >= 0; i--) {
      const prior = workflowRef.current.steps[i]
      if (
        prior.tool_id === 'featurize' &&
        prior.job_id &&
        prior.status === 'completed' &&
        workflowSourceRefKey(prior.sourceRef) === sourceKey
      ) {
        return prior
      }
    }
    return null
  }

  const vectorColumnFromWorkflowStep = async (step: AnalysisWorkflowStep) => {
    if (!step.job_id) return ''
    const result = await fetchApplyResult(step.job_id)
    const descriptors = [
      ...(result.addDescriptor ? [result.addDescriptor] : []),
      ...(result.addDescriptors || []),
      ...(result.addMolecularVectors || []),
    ]
    return descriptors.find(record => String(record?.name || '').trim())?.name || ''
  }

  const waitForWorkflowJob = async (item: AnalysisQueueItem): Promise<AnalysisQueueItem> => {
    let current = item
    while (!isTerminalAnalysisStatus(current.status)) {
      if (workflowAbortRef.current) throw new Error('Workflow paused.')
      await new Promise(resolve => window.setTimeout(resolve, 2000))
      const status = await refreshJobStatus(current.job_id)
      current = queueItemFromStatus(status, current)
      setQueue(prev => prev.map(q => q.job_id === current.job_id ? current : q))
    }
    if (current.status === 'failed') throw new Error(current.error || `${current.tool_name} failed.`)
    if (current.status === 'cancelled') throw new Error(`${current.tool_name} was cancelled.`)
    return current
  }

  const runWorkflow = async () => {
    if (workflowRunningRef.current || workflow.steps.length === 0) return
    workflowRunningRef.current = true
    workflowAbortRef.current = false
    setWorkflowBusy(true)
    setWorkflow(prev => ({ ...prev, status: 'running', error: '', message: 'Workflow running...', updated_at: new Date().toISOString() }))
    setErrorMessage('')

    try {
      for (let index = 0; index < workflowRef.current.steps.length; index++) {
        let step = workflowRef.current.steps[index]
        if (step.status === 'completed') continue
        if (workflowAbortRef.current) throw new Error('Workflow paused.')

        const tool = tools.find(t => t.id === step.tool_id)
        if (!tool) throw new Error(`Workflow step '${step.tool_name}' uses an unavailable tool.`)
        const sourceOption = resolveWorkflowSourceOption(step.sourceRef)
        if (!sourceOption) {
          throw new Error(`Workflow step '${step.tool_name}' cannot resolve source '${workflowSourceLabel(step.sourceRef)}'. Reload or compile that source before resuming.`)
        }

        let params = { ...step.params }
        if (tool.id === 'xtb_geometry_optimization' && step.usePreviousValidityFilter) {
          const validityStep = findPriorWorkflowValidityStep(index, step)
          if (!validityStep?.job_id) {
            throw new Error(`Workflow step '${step.tool_name}' is waiting for a prior validity/connectivity step on the same source.`)
          }
          params = {
            ...params,
            filter_csv_job_id: validityStep.job_id,
            filter_column: step.filter_column || VALIDITY_FILTER_COLUMN_PRIORITY[0],
          }
        }
        if (tool.id === 'dimensionality_reduction' && params.vector_column === '__previous_vector__') {
          const vectorStep = findPriorWorkflowVectorStep(index, step)
          if (!vectorStep?.job_id) {
            throw new Error(`Workflow step '${step.tool_name}' needs a prior featurize step on the same source.`)
          }
          const vectorColumn = await vectorColumnFromWorkflowStep(vectorStep)
          if (!vectorColumn) {
            throw new Error(`Workflow step '${step.tool_name}' could not resolve the vector column from prior featurize output.`)
          }
          params = { ...params, vector_column: vectorColumn }
        }

        setWorkflow(prev => ({
          ...prev,
          activeStepId: step.id,
          message: `Running ${step.tool_name}...`,
          steps: prev.steps.map(s => s.id === step.id ? { ...s, status: 'running', error: '', params } : s),
          updated_at: new Date().toISOString(),
        }))

        let item = await submitAnalysisJob(tool, sourceOption, params, {
          register_id_prefix: step.register_id_prefix,
          register_data_source: step.register_data_source || step.outputSourceLabel,
        })
        workflowRef.current = {
          ...workflowRef.current,
          activeStepId: step.id,
          steps: workflowRef.current.steps.map(s => s.id === step.id ? {
            ...s,
            job_id: item.job_id,
            status: item.status === 'queued' ? 'queued' : 'running',
            created_at: item.created_at,
          } : s),
        }
        setWorkflow(prev => ({
          ...prev,
          activeStepId: step.id,
          steps: prev.steps.map(s => s.id === step.id ? { ...s, job_id: item.job_id, status: item.status === 'queued' ? 'queued' : 'running', created_at: item.created_at } : s),
          updated_at: new Date().toISOString(),
        }))

        item = await waitForWorkflowJob(item)
        step = workflowRef.current.steps.find(s => s.id === step.id) || step
        let registered: { label: string; count: number } | null = null
        if (step.postAction === 'apply') {
          await applyCompletedJob(item, true)
        } else if (step.postAction === 'register_optimized') {
          registered = await registerCompletedOptimizationJob({
            ...item,
            register_id_prefix: step.register_id_prefix,
            register_data_source: step.register_data_source || step.outputSourceLabel,
          }, true)
        }

        workflowRef.current = {
          ...workflowRef.current,
          activeStepId: '',
          steps: workflowRef.current.steps.map(s => s.id === step.id ? {
            ...s,
            status: 'completed',
            job_id: item.job_id,
            started_at: item.started_at,
            finished_at: item.finished_at,
            applied: step.postAction === 'apply' ? true : s.applied,
            registered: step.postAction === 'register_optimized' ? !!registered : s.registered,
            registered_count: registered?.count ?? s.registered_count,
            outputSourceLabel: registered?.label || s.outputSourceLabel,
            error: '',
          } : s),
        }
        setWorkflow(prev => ({
          ...prev,
          activeStepId: '',
          steps: prev.steps.map(s => s.id === step.id ? {
            ...s,
            status: 'completed',
            job_id: item.job_id,
            started_at: item.started_at,
            finished_at: item.finished_at,
            applied: step.postAction === 'apply' ? true : s.applied,
            registered: step.postAction === 'register_optimized' ? !!registered : s.registered,
            registered_count: registered?.count ?? s.registered_count,
            outputSourceLabel: registered?.label || s.outputSourceLabel,
            error: '',
          } : s),
          message: `${step.tool_name} completed.`,
          error: '',
          updated_at: new Date().toISOString(),
        }))
      }
      setWorkflow(prev => ({ ...prev, status: 'completed', activeStepId: '', message: 'Workflow completed.', error: '', updated_at: new Date().toISOString() }))
      setStatusMessage('Workflow completed.')
      pushToast('Analysis workflow completed.', 'success')
    } catch (err: any) {
      const message = err?.message || String(err)
      const pausedStatus = workflowAbortRef.current ? 'paused' : 'failed'
      const activeStepId = workflowRef.current.activeStepId
      setWorkflow(prev => ({
        ...prev,
        status: pausedStatus,
        message: pausedStatus === 'paused' ? 'Workflow paused.' : '',
        error: pausedStatus === 'paused' ? '' : message,
        steps: prev.steps.map(step => step.id === activeStepId ? { ...step, status: pausedStatus === 'paused' ? 'idle' : 'failed', error: pausedStatus === 'paused' ? '' : message } : step),
        activeStepId: '',
        updated_at: new Date().toISOString(),
      }))
      if (pausedStatus === 'paused') setStatusMessage('Workflow paused.')
      else setErrorMessage(message)
    } finally {
      workflowRunningRef.current = false
      setWorkflowBusy(false)
    }
  }

  const pauseWorkflow = () => {
    workflowAbortRef.current = true
    setWorkflow(prev => ({ ...prev, status: 'paused', message: 'Workflow pause requested.', updated_at: new Date().toISOString() }))
  }

  const cancelActiveWorkflowJob = async () => {
    const active = workflow.steps.find(step => step.id === workflow.activeStepId)
    if (!active?.job_id) {
      pauseWorkflow()
      return
    }
    workflowAbortRef.current = true
    await cancelQueuedJob(active.job_id)
    setWorkflow(prev => ({
      ...prev,
      status: 'cancelled',
      activeStepId: '',
      message: 'Workflow cancelled.',
      steps: prev.steps.map(step => step.id === active.id ? { ...step, status: 'cancelled' } : step),
      updated_at: new Date().toISOString(),
    }))
  }

  useEffect(() => {
    // Stable 2s poll: read the latest queue via a ref so updating the queue
    // doesn't re-run this effect (which effectively polled at 0ms).
    let cancelled = false
    const tick = async () => {
      const pollable = queueRef.current.filter(item => item.job_id && !isTerminalAnalysisStatus(item.status))
      if (!pollable.length) return
      const updates: Record<string, AnalysisJobStatus> = {}
      for (const item of pollable) {
        try {
          updates[item.job_id] = await refreshJobStatus(item.job_id)
        } catch (err: any) {
          updates[item.job_id] = {
            job_id: item.job_id,
            status: item.status,
            error: err?.message || String(err),
          }
        }
      }
      if (cancelled) return
      setQueue(prev => {
        let changed = false
        const next = prev.map(item => {
          const status = updates[item.job_id]
          const merged = status ? queueItemFromStatus(status, item) : item
          if (merged !== item) changed = true
          return merged
        })
        return changed ? next : prev
      })
      const failed = Object.values(updates).find(status => status.status === 'failed')
      if (failed?.error) {
        setErrorMessage(failed.error)
      }
    }

    tick()
    const timer = window.setInterval(tick, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  if (sourceOptions.length === 0) {
    return (
      <div className="card section-card">
        <div style={{ fontWeight: 800, marginBottom: 6 }}>No analysis sources available</div>
        <div className="legend" style={{ lineHeight: 1.6 }}>
          Add at least one included staged source in Management, or compile a dataset with a <code>data_source</code> column.
        </div>
      </div>
    )
  }

  return (
    <div className="analysis-tools-page">
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
      {toolsError ? (
        <div className="notice" style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}>
          Backend analysis tool list could not be loaded, so the built-in frontend fallback list is shown: {toolsError}
        </div>
      ) : null}

      <div className="card analysis-settings-card">
        <section className="generation-section analysis-selection-section">
          <div className="generation-section-title"><span className="step-badge">1</span> Settings</div>
          <div className="analysis-selection-grid">
            <label className="generation-field">
              <span>Analysis tool</span>
              <select value={selectedTool?.id || ''} onChange={e => setSelectedToolId(e.target.value)}>
                {tools.map(tool => (
                  <option key={tool.id} value={tool.id}>{tool.name}</option>
                ))}
              </select>
            </label>

            <label className="generation-field">
              <span>Analysis source</span>
              <select value={datasetOrigin} onChange={e => setDatasetOrigin(e.target.value)}>
                {sourceOptions.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="generation-help analysis-origin-help">
            {selectedCount.toLocaleString()} molecules in this {sourceTypeLabel}. For optimization, the backend will additionally skip molecules that fail any validity/connectivity boolean check.
          </div>
        </section>

        {selectedTool ? (
          <>
            <div className="analysis-tool-head">
              <div className="analysis-tool-title">{selectedTool.name}</div>
              {selectedTool.description ? (
                <div className="legend">{selectedTool.description}</div>
              ) : null}
            </div>

            <section className="generation-section">
              <div className="generation-section-title"><span className="step-badge">2</span> Parameters</div>
              <div className="analysis-parameter-grid">
                {visibleInputsForValues(selectedTool, formValues).map(field => (
                  <AnalysisField
                    key={field.key}
                    field={effectiveAnalysisField(field)}
                    value={formValues[field.key]}
                    onChange={value => setFieldValue(field.key, value)}
                  />
                ))}
                {showXtbValidityFilter ? (
                  <AnalysisField
                    field={{
                      key: 'filter_column',
                      label: 'Filter column',
                      type: 'select',
                      options: validityFilterColumns,
                      help: `Using validity job ${matchingValidityJob?.job_id || ''}`,
                    }}
                    value={formValues.filter_column || preferredValidityFilterColumn(validityFilterColumns)}
                    onChange={value => setFieldValue('filter_column', value)}
                  />
                ) : null}
              </div>
            </section>
          </>
        ) : null}

        <div className="analysis-action-row">
          <button className="btn" onClick={addCurrentToolToWorkflow} disabled={!selectedTool || !datasetOrigin || addingToQueue}>
            <ListPlus size={16} />
            Add workflow step
          </button>
          <button className="btn btn-primary" onClick={addSelectedToolToQueue} disabled={addingToQueue || !selectedTool || !datasetOrigin}>
            {addingToQueue ? <RefreshCw size={16} className="spin" /> : <ListPlus size={16} />}
            {addingToQueue ? 'Adding...' : 'Add to queue'}
          </button>
          <button className="btn" onClick={loadTools} disabled={loadingTools}>
            <RefreshCw size={16} />
            Reload tool list
          </button>
        </div>
      </div>

      {statusMessage ? <div className="notice">{statusMessage}</div> : null}
      <div className="card section-card analysis-workflow-card">
        <div className="analysis-job-head">
          <div>
            <div className="analysis-tool-title gradient-text">Workflow</div>
            <div className="legend">{workflow.steps.length} step{workflow.steps.length === 1 ? '' : 's'} - {workflow.status}</div>
          </div>
          <div className="analysis-workflow-actions">
            <button
              className="btn btn-primary"
              onClick={runWorkflow}
              disabled={workflowBusy || workflow.steps.length === 0 || workflow.status === 'running'}
            >
              {workflowBusy ? <RefreshCw size={16} className="spin" /> : <Play size={16} />}
              {workflow.status === 'paused' || workflow.status === 'failed' ? 'Resume' : 'Run'}
            </button>
            <button className="btn" onClick={pauseWorkflow} disabled={workflow.status !== 'running'}>
              <Pause size={16} />
              Pause
            </button>
            <button className="btn btn-danger" onClick={cancelActiveWorkflowJob} disabled={workflow.status !== 'running' && !workflow.activeStepId}>
              <StopCircle size={16} />
              Cancel active
            </button>
            <button
              className="btn"
              onClick={() => setWorkflow(makeEmptyWorkflow())}
              disabled={workflow.status === 'running' || workflow.steps.length === 0}
            >
              <Trash2 size={16} />
              Clear workflow
            </button>
          </div>
        </div>
        {workflow.message ? <div className="notice analysis-workflow-notice">{workflow.message}</div> : null}
        {workflow.error ? <div className="notice analysis-workflow-notice" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{workflow.error}</div> : null}
        {workflow.steps.length ? (
          <div className="analysis-workflow-list">
            {workflow.steps.map((step, index) => {
              const sourceSelectValue = sourceOptions.find(option =>
                workflowSourceRefKey(sourceRefFromOption(option)) === workflowSourceRefKey(step.sourceRef)
              )?.value || ''
              const isLocked = workflow.status === 'running'
              return (
                <div className="analysis-workflow-step" key={step.id}>
                  <div className="analysis-workflow-step-head">
                    <div>
                      <div className="analysis-queue-title">{index + 1}. {step.tool_name}</div>
                      <div className="legend">{paramsSummary(step.params)}</div>
                    </div>
                    <div className={`generation-status ${step.status || 'idle'}`}>
                      {step.status || 'idle'}
                    </div>
                  </div>
                  <div className="analysis-workflow-grid">
                    <label className="generation-field">
                      <span>Source</span>
                      <select
                        value={sourceSelectValue}
                        disabled={isLocked}
                        onChange={e => {
                          const option = sourceOptions.find(opt => opt.value === e.target.value)
                          if (option) updateWorkflowStep(step.id, { sourceRef: sourceRefFromOption(option) })
                        }}
                      >
                        {!sourceSelectValue ? <option value="">{workflowSourceLabel(step.sourceRef)}</option> : null}
                        {sourceOptions.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    {step.sourceRef.kind === 'compiled' ? (
                      <label className="generation-field">
                        <span>Source label</span>
                        <input
                          value={step.sourceRef.originLabel}
                          disabled={isLocked}
                          onChange={e => updateWorkflowStep(step.id, {
                            sourceRef: { ...step.sourceRef, originLabel: e.target.value },
                          })}
                        />
                      </label>
                    ) : null}
                    <label className="generation-field">
                      <span>Post action</span>
                      <select
                        value={step.postAction}
                        disabled={isLocked}
                        onChange={e => updateWorkflowStep(step.id, { postAction: e.target.value as WorkflowPostAction })}
                      >
                        <option value="none">No post-action</option>
                        <option value="apply">Apply results</option>
                        <option value="register_optimized">Register optimized set</option>
                      </select>
                    </label>
                    {step.tool_id === 'xtb_geometry_optimization' ? (
                      <>
                        <label className="analysis-checkbox-field">
                          <span className="analysis-checkbox-row">
                            <input
                              type="checkbox"
                              checked={!!step.usePreviousValidityFilter}
                              disabled={isLocked}
                              onChange={e => updateWorkflowStep(step.id, { usePreviousValidityFilter: e.target.checked })}
                            />
                            <span>Use previous validity filter</span>
                          </span>
                        </label>
                        <label className="generation-field">
                          <span>Filter column</span>
                          <input
                            value={step.filter_column || VALIDITY_FILTER_COLUMN_PRIORITY[0]}
                            disabled={isLocked || !step.usePreviousValidityFilter}
                            onChange={e => updateWorkflowStep(step.id, { filter_column: e.target.value })}
                          />
                        </label>
                        <label className="generation-field">
                          <span>ID prefix</span>
                          <input
                            value={step.register_id_prefix ?? 'molGen_optimized'}
                            disabled={isLocked}
                            onChange={e => updateWorkflowStep(step.id, { register_id_prefix: e.target.value })}
                          />
                        </label>
                        <label className="generation-field">
                          <span>Output source label</span>
                          <input
                            value={step.register_data_source || step.outputSourceLabel || defaultOptimizedSourceLabel(step.sourceRef.originLabel)}
                            disabled={isLocked}
                            onChange={e => updateWorkflowStep(step.id, {
                              register_data_source: e.target.value,
                              outputSourceLabel: e.target.value,
                            })}
                          />
                        </label>
                      </>
                    ) : null}
                  </div>
                  <div className="analysis-queue-meta">
                    {step.job_id ? <span>Job ID: {step.job_id}</span> : null}
                    <span>{postActionLabel(step.postAction)}</span>
                    {step.applied ? <span className="text-success">Applied</span> : null}
                    {step.registered ? <span className="text-success">Registered {step.registered_count?.toLocaleString() || ''}</span> : null}
                    {step.error ? <span className="text-danger">{step.error}</span> : null}
                  </div>
                  <div className="analysis-queue-actions">
                    <button className="btn" onClick={() => moveWorkflowStep(step.id, -1)} disabled={isLocked || index === 0}>
                      <ArrowUp size={16} />
                    </button>
                    <button className="btn" onClick={() => moveWorkflowStep(step.id, 1)} disabled={isLocked || index === workflow.steps.length - 1}>
                      <ArrowDown size={16} />
                    </button>
                    <button className="btn" onClick={() => loadWorkflowStepIntoForm(step)} disabled={isLocked}>
                      <RefreshCw size={16} />
                      Load settings
                    </button>
                    <button className="btn btn-danger" onClick={() => removeWorkflowStep(step.id)} disabled={isLocked}>
                      <Trash2 size={16} />
                      Remove
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="legend">Add the current analysis tool and source as the first workflow step.</div>
        )}
      </div>
      {queue.length ? (
        <div className="card section-card analysis-job-card">
          <div className="analysis-job-head">
            <div>
              <div className="analysis-tool-title gradient-text">Analysis queue</div>
              <div className="legend">{queue.length} job{queue.length === 1 ? '' : 's'}</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                onClick={applyAllCompletedJobs}
                disabled={applyingAll || !queue.some(item => item.status === 'completed' && (!item.applied || item.tool_id === 'featurize'))}
              >
                {applyingAll ? <RefreshCw size={16} className="spin" /> : <CheckCircle size={16} />}
                {applyingAll ? 'Applying...' : 'Apply all results'}
              </button>
              <button className="btn btn-danger" onClick={clearAnalysisQueue}>
                <Trash2 size={16} />
                Clear queue
              </button>
            </div>
          </div>
          <div className="analysis-queue-list">
            {queue.map(item => {
              const canCancel = item.status === 'queued' || item.status === 'running'
              const isStagedJob = item.source_kind === 'staged'
              const canApply = item.status === 'completed' && (!item.applied || item.tool_id === 'featurize')
              const canDismiss = item.status === 'completed' && !!item.applied
              const showRegistration = item.tool_id === 'xtb_geometry_optimization' && item.status === 'completed'
              const isRegistering = registeringJobId === item.job_id
              const registrationPrefix = item.register_id_prefix ?? 'molGen_optimized'
              const registrationSource = String(item.register_data_source || '').trim() || defaultOptimizedSourceLabel(item.dataset_origin)
              const canRegister = showRegistration && !item.registered && !isRegistering
              const showLog = item.status === 'running' || !!item.show_log
              return (
                <div className="analysis-queue-item" key={item.job_id}>
                  <div className="analysis-queue-main">
                    <div>
                      <div className="analysis-queue-title">{item.tool_name}</div>
                      <div className="legend">
                        {item.source_kind === 'compiled_all' ? 'all compiled' : (item.dataset_origin || 'compiled')} ({item.source_kind === 'compiled_all' ? 'compiled_all' : item.source_kind || 'compiled'}) - {item.molecule_count.toLocaleString()} molecules - Job ID: {item.job_id}
                      </div>
                    </div>
                    <div className={`generation-status ${item.status || 'queued'}`}>
                      {item.status || 'queued'}
                      {item.status === 'queued' && item.queue_position ? ` #${item.queue_position}` : ''}
                    </div>
                  </div>
                  <div className="analysis-queue-meta">
                    {item.created_at ? <span>Queued {formatTimestamp(item.created_at)}</span> : null}
                    {item.started_at ? <span>Started {formatTimestamp(item.started_at)}</span> : null}
                    {item.finished_at ? <span>Finished {formatTimestamp(item.finished_at)}</span> : null}
                    {item.applied ? <span className="text-success">Applied</span> : null}
                    {item.registered ? <span className="text-success">Registered {item.registered_count?.toLocaleString() || ''}</span> : null}
                    {item.error ? <span className="text-danger">{item.error}</span> : null}
                  </div>
                  {showRegistration ? (
                    <div className="analysis-registration-panel">
                      <div className="analysis-registration-grid">
                        <label className="generation-field">
                          <span>ID prefix</span>
                          <input
                            value={registrationPrefix}
                            disabled={item.registered || isRegistering}
                            placeholder="Optional for replacement"
                            onChange={e => updateQueueRegistrationField(item.job_id, { register_id_prefix: e.target.value })}
                          />
                        </label>
                        <label className="generation-field">
                          <span>Data source label</span>
                          <input
                            value={registrationSource}
                            disabled={item.registered || isRegistering}
                            onChange={e => updateQueueRegistrationSource(item, e.target.value)}
                          />
                        </label>
                      </div>
                      <div className="legend">
                        {isStagedJob
                          ? 'Registers the optimized XYZ back into the staged source. Compile afterwards to propagate to the active dataset.'
                          : 'Empty prefix with the original label replaces that source with the optimized subset. Any changed prefix or label appends a new source and requires a non-empty prefix plus a new data_source label.'}
                      </div>
                    </div>
                  ) : null}
                  <div className="analysis-queue-actions">
                    {canCancel ? (
                      <button className="btn btn-danger" onClick={() => cancelQueuedJob(item.job_id)}>
                        <StopCircle size={16} />
                        Cancel
                      </button>
                    ) : null}
                    {canApply ? (
                      <button className="btn" onClick={() => applyCompletedJob(item)}>
                        <CheckCircle size={16} />
                        Apply results
                      </button>
                    ) : null}
                    {showRegistration ? (
                      <button
                        className="btn btn-primary"
                        onClick={() => registerCompletedOptimizationJob(item)}
                        disabled={!canRegister}
                      >
                        {isRegistering ? <RefreshCw size={16} className="spin" /> : <ListPlus size={16} />}
                        {isRegistering ? 'Registering...' : 'Register optimized set'}
                      </button>
                    ) : null}
                    {canDismiss ? (
                      <button
                        className="btn"
                        onClick={() => setQueue(prev => prev.filter(q => q.job_id !== item.job_id))}
                      >
                        <X size={16} />
                        Dismiss
                      </button>
                    ) : null}
                    <button
                      className="btn"
                      onClick={() => setQueue(prev => prev.map(q => q.job_id === item.job_id ? { ...q, show_log: !q.show_log } : q))}
                    >
                      <Terminal size={16} />
                      {showLog ? 'Hide log' : 'Show log'}
                    </button>
                  </div>
                  {showLog ? (
                    <pre className="generation-log analysis-queue-log">
                      {(item.log_tail || '').trim() || '[No log output yet]'}
                    </pre>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
      {errorMessage ? <div className="notice" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{errorMessage}</div> : null}

      {warnings.length ? (
        <div className="card section-card">
          <div className="analysis-tool-title">Warnings</div>
          <ul className="legend" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      ) : null}

      {stats ? (
        <div className="card section-card">
          <div className="analysis-tool-title">Run stats</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {Object.entries(stats).map(([key, value]) => (
              <div key={key} style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8 }}>
                <div className="legend subsection-title">{key}</div>
                <div className="legend" style={{ overflowWrap: 'anywhere' }}>{String(value)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function AnalysisField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: AnalysisInput
  value: any
  disabled?: boolean
  onChange: (value: any) => void
}) {
  const label = field.label || field.key
  const options = normalizeOptions(field.options)

  return (
    <label className={field.type === 'boolean' ? 'analysis-checkbox-field' : 'generation-field'}>
      {field.type === 'boolean' ? (
        <span className="analysis-checkbox-row">
          <input type="checkbox" checked={!!value} disabled={disabled} onChange={e => onChange(e.target.checked)} />
          <span>{label}</span>
        </span>
      ) : field.type === 'select' ? (
        <>
          <span>{label}</span>
          <select value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)}>
            {options.length === 0 ? (
              <option value="">No options available</option>
            ) : (
              options.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))
            )}
          </select>
        </>
      ) : field.type === 'multiselect' ? (
        <>
          <span>{label}</span>
          <select
            multiple
            value={Array.isArray(value) ? value : []}
            disabled={disabled}
            onChange={e => onChange(Array.from(e.currentTarget.selectedOptions).map(opt => opt.value))}
            style={{ minHeight: 90 }}
          >
            {options.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </>
      ) : field.type === 'text' ? (
        <>
          <span>{label}</span>
          <textarea value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} rows={3} />
        </>
      ) : (
        <>
          <span>{label}</span>
          <input
            type={field.type === 'integer' || field.type === 'float' || field.type === 'slider_int' || field.type === 'slider_float' ? 'number' : 'text'}
            value={value ?? ''}
            disabled={disabled}
            min={field.min}
            max={field.max}
            step={field.step ?? (field.type === 'integer' || field.type === 'slider_int' ? 1 : undefined)}
            onChange={e => onChange(e.target.value)}
          />
        </>
      )}

      {field.help ? <span className="legend">{field.help}</span> : null}
    </label>
  )
}
