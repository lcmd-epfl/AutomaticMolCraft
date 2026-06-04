import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Download,
  FolderOpen,
  Lock,
  LockOpen,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Copy,
  Upload,
} from 'lucide-react'
import { BACKEND } from '../config'
import PresetsBar from './PresetsBar'
import { useUIStore } from '../store/uiStore'

const api = (path: string) => `${BACKEND}${path}`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskFamily = {
  id: string
  label: string
  category: string
}

type TrainingJobSummary = {
  job_id: string
  mode: 'run' | 'dry'
  status: string
  created_at: string | null
  started_at: string | null
  finished_at: string | null
  task_family: string | null
  preset_name: string | null
  config_path: string | null
  output_dir: string | null
  error: string | null
  return_code: number | null
}

type TrainingJobDetail = TrainingJobSummary & {
  config_yaml: string | null
  log_tail: string | null
  suggested_command: string
  queue_position?: number
}

type FormState = {
  // meta
  name: string
  seed: string
  tags: string
  task_family: string
  mode: 'run' | 'dry'
  preset_name: string
  // data
  dataset_name: string
  data_root: string
  csv_path: string
  xyz_dir: string
  ase_db_path: string
  atom_vocab: string
  batch_size: string
  max_atom: string
  with_hydrogen: boolean
  use_ohe_feature: boolean
  allow_unknown: boolean
  train_ratio: string
  data_efficient_collator: boolean
  // model (common)
  hidden_size: string
  num_layers: string
  num_sublayers: string
  dropout: string
  attention: boolean
  tanh: boolean
  condition_names: string
  chkpt_path: string
  // diffusion / flow-matching
  diffusion_steps: string
  diffusion_noise_schedule: string
  diffusion_loss_type: string
  context_mask_rate: string
  mask_value: string
  normalize_condition: string
  normalize_condition_divisor: string
  use_adapter_module: boolean
  adapter_conditions: string
  sp_regularizer_deploy: boolean
  sp_regularizer_regularizer: string
  sp_regularizer_lambda_: string
  sp_regularizer_lambda_2: string
  sp_regularizer_lambda_update_value: string
  sp_regularizer_lambda_update_step: string
  sp_regularizer_polynomial_p: string
  sp_regularizer_warm_up_steps: string
  normalize_factors: string
  n_samples: string
  generative_analysis: boolean
  use_posebuster: boolean
  fm_min_t: string
  fm_num_timesteps: string
  fm_self_condition: boolean
  use_velocity: boolean
  // regression
  task_learn: string
  criterion: string
  metric: string
  num_mlp_layer: string
  mlp_batch_norm: string
  target_normalization: boolean
  mlp_dropout: string
  prediction_mlp_type: string
  // ssl3d
  ssl3d_denoise_weight: string
  ssl3d_mask_rate: string
  ssl3d_mtype_weight: string
  ssl3d_sigma_min: string
  ssl3d_sigma_max: string
  ssl3d_sigma_schedule: string
  // vae
  latent_dim: string
  augment_noise: string
  augment_rotation: boolean
  // trainer
  optimizer_choice: string
  lr: string
  weight_decay: string
  num_epochs: string
  num_steps: string
  scheduler: string
  validation_interval: string
  ema_decay: string
  precision: string
  save_top_k: string
  save_every_val_epoch: boolean
  gradient_clip_mode: string
  init_grad_norm: string
  resume_from_checkpoint: string
  load_weights_from: string
  monitor_metric: string
  monitor_mode: string
  // logger
  logger_backend: string
  log_interval: string
  wandb_name: string
  wandb_project: string
  wandb_tags: string
  // engine
  engine_type: string
  num_workers: string
}

const DEFAULT_FORM: FormState = {
  name: '',
  seed: '42',
  tags: '',
  task_family: 'diffusion',
  mode: 'run',
  preset_name: '',
  dataset_name: '',
  data_root: 'data/',
  csv_path: '',
  xyz_dir: '',
  ase_db_path: '',
  atom_vocab: 'H, B, C, N, O, F, Al, Si, P, S, Cl, As, Se, Br, I',
  batch_size: '48',
  max_atom: '86',
  with_hydrogen: true,
  use_ohe_feature: true,
  allow_unknown: false,
  train_ratio: '0.8',
  data_efficient_collator: true,
  hidden_size: '256',
  num_layers: '9',
  num_sublayers: '1',
  dropout: '0.0',
  attention: true,
  tanh: true,
  condition_names: '',
  chkpt_path: '',
  diffusion_steps: '500',
  diffusion_noise_schedule: 'polynomial_2',
  diffusion_loss_type: 'vlb',
  context_mask_rate: '0.0',
  mask_value: '5',
  normalize_condition: 'value',
  normalize_condition_divisor: '10',
  use_adapter_module: false,
  adapter_conditions: '',
  sp_regularizer_deploy: false,
  sp_regularizer_regularizer: 'hard',
  sp_regularizer_lambda_: '0',
  sp_regularizer_lambda_2: '1000',
  sp_regularizer_lambda_update_value: '1',
  sp_regularizer_lambda_update_step: '100',
  sp_regularizer_polynomial_p: '1.1',
  sp_regularizer_warm_up_steps: '100',
  normalize_factors: '1.0, 4.0, 10.0',
  n_samples: '48',
  generative_analysis: true,
  use_posebuster: true,
  fm_min_t: '0.01',
  fm_num_timesteps: '100',
  fm_self_condition: false,
  use_velocity: false,
  task_learn: '',
  criterion: 'mse',
  metric: 'mae',
  num_mlp_layer: '3',
  mlp_batch_norm: 'batchnorm',
  target_normalization: true,
  mlp_dropout: '0.2',
  prediction_mlp_type: 'pernode',
  ssl3d_denoise_weight: '1.0',
  ssl3d_mask_rate: '0.15',
  ssl3d_mtype_weight: '0.5',
  ssl3d_sigma_min: '0.01',
  ssl3d_sigma_max: '2.0',
  ssl3d_sigma_schedule: 'uniform',
  latent_dim: '8',
  augment_noise: '0.1',
  augment_rotation: true,
  optimizer_choice: 'adamw',
  lr: '0.0002',
  weight_decay: '1e-12',
  num_epochs: '200',
  num_steps: '',
  scheduler: 'cosineannealing',
  validation_interval: '3',
  ema_decay: '0.9999',
  precision: '32',
  save_top_k: '3',
  save_every_val_epoch: false,
  gradient_clip_mode: 'norm',
  init_grad_norm: '3000',
  resume_from_checkpoint: '',
  load_weights_from: '',
  monitor_metric: '',
  monitor_mode: 'max',
  logger_backend: 'logging',
  log_interval: '2',
  wandb_name: 'MolecularDiffusion',
  wandb_project: 'MolecularDiffusion',
  wandb_tags: '',
  engine_type: 'original',
  num_workers: '2',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formToPayload(f: FormState): Record<string, unknown> {
  const normalizeCondition =
    f.normalize_condition === 'value'
      ? `value_${Number(f.normalize_condition_divisor) || 10}`
      : f.normalize_condition

  return {
    ...f,
    normalize_condition: normalizeCondition,
    seed: Number(f.seed) || 42,
    batch_size: Number(f.batch_size) || 48,
    max_atom: Number(f.max_atom) || 86,
    train_ratio: Number(f.train_ratio) || 0.8,
    hidden_size: Number(f.hidden_size) || 256,
    num_layers: Number(f.num_layers) || 9,
    num_sublayers: Number(f.num_sublayers) || 1,
    dropout: Number(f.dropout) || 0,
    diffusion_steps: Number(f.diffusion_steps) || 500,
    context_mask_rate: Number(f.context_mask_rate) || 0,
    mask_value: Number(f.mask_value) || 5,
    sp_regularizer_lambda_: Number(f.sp_regularizer_lambda_) || 0,
    sp_regularizer_lambda_2: Number(f.sp_regularizer_lambda_2) || 1000,
    sp_regularizer_lambda_update_value: Number(f.sp_regularizer_lambda_update_value) || 1,
    sp_regularizer_lambda_update_step: Number(f.sp_regularizer_lambda_update_step) || 100,
    sp_regularizer_polynomial_p: Number(f.sp_regularizer_polynomial_p) || 1.1,
    sp_regularizer_warm_up_steps: Number(f.sp_regularizer_warm_up_steps) || 100,
    normalize_factors: f.normalize_factors
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => !isNaN(n)),
    n_samples: Number(f.n_samples) || 48,
    fm_min_t: Number(f.fm_min_t) || 0.01,
    fm_num_timesteps: Number(f.fm_num_timesteps) || 100,
    num_mlp_layer: Number(f.num_mlp_layer) || 3,
    mlp_dropout: Number(f.mlp_dropout) || 0.2,
    ssl3d_denoise_weight: Number(f.ssl3d_denoise_weight) || 1,
    ssl3d_mask_rate: Number(f.ssl3d_mask_rate) || 0.15,
    ssl3d_mtype_weight: Number(f.ssl3d_mtype_weight) || 0.5,
    ssl3d_sigma_min: Number(f.ssl3d_sigma_min) || 0.01,
    ssl3d_sigma_max: Number(f.ssl3d_sigma_max) || 2.0,
    latent_dim: Number(f.latent_dim) || 8,
    augment_noise: Number(f.augment_noise) || 0.1,
    lr: Number(f.lr) || 2e-4,
    weight_decay: Number(f.weight_decay) || 1e-12,
    num_epochs: f.num_steps ? undefined : Number(f.num_epochs) || 200,
    num_steps: f.num_steps ? Number(f.num_steps) : undefined,
    validation_interval: Number(f.validation_interval) || 3,
    ema_decay: Number(f.ema_decay) || 0.9999,
    precision: Number(f.precision) || 32,
    save_top_k: Number(f.save_top_k) || 3,
    init_grad_norm: Number(f.init_grad_norm) || 3000,
    log_interval: Number(f.log_interval) || 2,
    num_workers: Number(f.num_workers) || 2,
    task_learn: f.task_learn
      ? f.task_learn.split(',').map(s => s.trim()).filter(Boolean)
      : [],
    metric: f.metric
      ? f.metric.split(',').map(s => s.trim()).filter(Boolean)
      : ['mae'],
    adapter_conditions: f.adapter_conditions
      ? f.adapter_conditions.split(',').map(s => s.trim()).filter(Boolean)
      : [],
    output_path: 'auto',
  }
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return ''
  const s = new Date(start)
  const e = end ? new Date(end) : new Date()
  const sec = Math.round((e.getTime() - s.getTime()) / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'completed'
      ? 'generation-status completed'
      : status === 'failed'
        ? 'generation-status failed'
        : status === 'cancelled'
          ? 'generation-status cancelled'
          : status === 'running'
            ? 'generation-status running'
            : status === 'dry'
              ? 'generation-status dry'
              : 'generation-status queued'
  return <span className={cls}>{status}</span>
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FieldRow({
  label,
  children,
  hint,
}: {
  label: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, alignItems: 'center', marginBottom: 6 }}>
      <label style={{ fontSize: 12, color: 'var(--fg-muted)', textAlign: 'right', paddingRight: 8 }}>
        {label}
        {hint && (
          <span style={{ display: 'block', fontSize: 10, color: 'var(--fg-muted)', opacity: 0.7 }}>
            {hint}
          </span>
        )}
      </label>
      <div>{children}</div>
    </div>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <input
      className="gen-input"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={mono ? { fontFamily: 'var(--font-mono)', fontSize: 11 } : undefined}
    />
  )
}

function NumInput({
  value,
  onChange,
  placeholder,
  step,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  step?: string
}) {
  return (
    <input
      className="gen-input"
      type="number"
      value={value}
      step={step}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{ maxWidth: 140 }}
    />
  )
}

function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select className="gen-select" value={value} onChange={e => onChange(e.target.value)}>
      {options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function CheckInput({
  value,
  onChange,
  label,
}: {
  value: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
      <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function SectionHeader({ title, open, onToggle }: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--fg-muted)',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '6px 0 4px',
        width: '100%',
        textAlign: 'left',
        borderTop: '1px solid var(--border)',
        marginTop: 8,
      }}
    >
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      {title}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Job row
// ---------------------------------------------------------------------------

function JobRow({
  job,
  onCancel,
  onDelete,
  onClone,
  onRefresh,
}: {
  job: TrainingJobDetail
  onCancel: () => void
  onDelete: () => void
  onClone: () => void
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<'log' | 'yaml' | 'info'>('log')
  const [detail, setDetail] = useState<TrainingJobDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const isActive = job.status === 'queued' || job.status === 'running'

  // Fetch full detail (log_tail + config_yaml) when expanded
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    const load = async () => {
      setLoadingDetail(true)
      try {
        const r = await fetch(api(`/training/jobs/${job.job_id}`))
        if (!r.ok || cancelled) return
        const d = await r.json()
        if (!cancelled) setDetail(d)
      } finally {
        if (!cancelled) setLoadingDetail(false)
      }
    }
    load()
    // Refresh log every 3s while job is active
    const timer = isActive ? setInterval(load, 3000) : null
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [expanded, job.job_id, isActive])

  const d = detail ?? job  // fall back to summary until detail loads

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        overflow: 'hidden',
        marginBottom: 6,
        background: 'var(--surface)',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setExpanded(x => !x)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <StatusBadge status={job.status} />
        <span style={{ fontSize: 12, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.task_family ?? '—'}
          {job.preset_name ? ` · ${job.preset_name}` : ''}
        </span>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
          {job.mode === 'dry' ? 'dry' : formatDuration(job.started_at, job.finished_at)}
        </span>
        <span style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>
          {job.job_id}
        </span>
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 10 }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {(['log', 'yaml', 'info'] as const).map(t => (
              <button
                key={t}
                className={`tab-btn${tab === t ? ' active' : ''}`}
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => setTab(t)}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>

          {tab === 'log' && (
            <>
              {loadingDetail && !detail && (
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>Loading…</div>
              )}
              {d.error && !d.log_tail && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--color-danger)',
                    background: 'color-mix(in srgb, var(--color-danger) 8%, transparent)',
                    border: '1px solid var(--color-danger-border)',
                    borderRadius: 4,
                    padding: '6px 8px',
                    marginBottom: 6,
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {d.error}
                </div>
              )}
              <pre
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: 8,
                  maxHeight: 400,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  color: job.status === 'failed' ? 'var(--color-danger)' : 'var(--fg)',
                  margin: 0,
                }}
              >
                {d.log_tail
                  ? d.log_tail
                  : job.mode === 'dry'
                    ? '(dry run — no log)'
                    : job.status === 'queued'
                      ? '(waiting in queue…)'
                      : job.status === 'failed'
                        ? '(no output captured)'
                        : '(no output yet)'}
              </pre>
            </>
          )}

          {tab === 'yaml' && (
            <div style={{ position: 'relative' }}>
              <pre
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: 8,
                  maxHeight: 280,
                  overflow: 'auto',
                  whiteSpace: 'pre',
                  color: 'var(--fg)',
                  margin: 0,
                }}
              >
                {d.config_yaml || '(no YAML stored)'}
              </pre>
            </div>
          )}

          {tab === 'info' && (
            <div style={{ fontSize: 11, display: 'grid', gap: 4 }}>
              {[
                ['Job ID', job.job_id],
                ['Status', job.status],
                ['Mode', job.mode],
                ['Task family', job.task_family],
                ['Created', job.created_at],
                ['Started', job.started_at],
                ['Finished', job.finished_at],
                ['Config path', job.config_path],
                ['Output dir', job.output_dir],
                ['Return code', job.return_code != null ? String(job.return_code) : '—'],
                ['Error', d.error || '—'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8 }}>
                  <span style={{ color: 'var(--fg-muted)', fontWeight: 600 }}>{k}</span>
                  <span style={{ fontFamily: v && (k === 'Config path' || k === 'Output dir') ? 'var(--font-mono)' : undefined, wordBreak: 'break-all' }}>
                    {v || '—'}
                  </span>
                </div>
              ))}
              {d.suggested_command && (
                <>
                  <div style={{ marginTop: 6, fontWeight: 600, color: 'var(--fg-muted)' }}>
                    Run command
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <code
                      style={{
                        fontSize: 10,
                        fontFamily: 'var(--font-mono)',
                        background: 'var(--bg)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        padding: '4px 8px',
                        flex: 1,
                        wordBreak: 'break-all',
                      }}
                    >
                      {d.suggested_command}
                    </code>
                    <button
                      className="btn-action"
                      style={{ padding: '3px 7px' }}
                      onClick={() => navigator.clipboard.writeText(d.suggested_command)}
                      title="Copy command"
                    >
                      <ClipboardCopy size={12} />
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {isActive && (
              <button className="btn-action btn-danger" style={{ fontSize: 11 }} onClick={onCancel}>
                <Square size={12} /> Stop
              </button>
            )}
            <button className="btn-action" style={{ fontSize: 11 }} onClick={onClone}>
              <Copy size={12} /> Clone to form
            </button>
            {d.config_yaml && (
              <button
                className="btn-action"
                style={{ fontSize: 11 }}
                onClick={() => {
                  const blob = new Blob([d.config_yaml!], { type: 'text/yaml' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `training_${job.job_id}.yaml`
                  a.click()
                  URL.revokeObjectURL(url)
                }}
              >
                <Download size={12} /> Download YAML
              </button>
            )}
            {isActive && (
              <button className="btn-action" style={{ fontSize: 11 }} onClick={onRefresh}>
                <RefreshCw size={12} /> Refresh
              </button>
            )}
            <button
              className="btn-action btn-danger"
              style={{ fontSize: 11, marginLeft: 'auto' }}
              onClick={onDelete}
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function TrainingPage() {
  const pushToast = useUIStore(s => s.pushToast)

  const [families, setFamilies] = useState<TaskFamily[]>([])
  const [form, setForm] = useState<FormState>({ ...DEFAULT_FORM })
  const [jobs, setJobs] = useState<TrainingJobDetail[]>([])
  const [submitting, setSubmitting] = useState(false)

  // Dry-mode inline result
  const [dryResult, setDryResult] = useState<TrainingJobDetail | null>(null)

  // YAML import
  const [importPath, setImportPath] = useState('')
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Password-gated unlock
  const [unlockToken, setUnlockToken] = useState<string>(
    () => sessionStorage.getItem('training_unlock_token') ?? ''
  )
  const [unlockAvailable, setUnlockAvailable] = useState(false)
  const [unlocked, setUnlocked] = useState(false)
  const [unlockPassword, setUnlockPassword] = useState('')
  const [unlockError, setUnlockError] = useState('')
  const [unlocking, setUnlocking] = useState(false)

  useEffect(() => {
    if (unlockToken) sessionStorage.setItem('training_unlock_token', unlockToken)
    else sessionStorage.removeItem('training_unlock_token')
  }, [unlockToken])

  const authHeaders = (): HeadersInit =>
    unlockToken ? { 'X-Training-Token': unlockToken } : {}

  // Collapsible form sections
  const [openSections, setOpenSections] = useState({
    data: true,
    model: true,
    diffusion: true,
    regression: true,
    ssl3d: false,
    vae: false,
    trainer: false,
    logger: false,
    engine: false,
  })

  const toggleSection = (k: keyof typeof openSections) =>
    setOpenSections(s => ({ ...s, [k]: !s[k] }))

  const setField = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const category = families.find(f => f.id === form.task_family)?.category ?? ''
  const hasConditionNames = form.condition_names
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .length > 0

  // -----------------------------------------------------------------------
  // Load task families
  // -----------------------------------------------------------------------
  const loadFamilies = useCallback(async () => {
    try {
      const r = await fetch(api('/training/task-families'), { headers: authHeaders() })
      const d = await r.json()
      setFamilies(d.families ?? [])
      setUnlockAvailable(d.unlock_available ?? false)
      setUnlocked(d.unlocked ?? false)
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlockToken])

  useEffect(() => {
    loadFamilies()
  }, [loadFamilies])

  // -----------------------------------------------------------------------
  // Load / refresh jobs
  // -----------------------------------------------------------------------
  const loadJobs = useCallback(async () => {
    try {
      const r = await fetch(api('/training/jobs?mode=all'))
      if (!r.ok) return
      const d = await r.json()
      setJobs(d.jobs ?? [])
    } catch {}
  }, [])

  useEffect(() => {
    loadJobs()
  }, [loadJobs])

  // -----------------------------------------------------------------------
  // Polling for active jobs
  // -----------------------------------------------------------------------
  const hasActive = jobs.some(j => j.status === 'queued' || j.status === 'running')
  useEffect(() => {
    if (!hasActive) return
    const timer = setInterval(async () => {
      await loadJobs()
    }, 2000)
    return () => clearInterval(timer)
  }, [hasActive, loadJobs])

  // -----------------------------------------------------------------------
  // YAML import helpers
  // -----------------------------------------------------------------------
  const applyImportedPayload = (payload: Record<string, unknown>) => {
    setForm(f => ({
      ...f,
      ...Object.fromEntries(
        Object.entries(payload)
          .filter(([k]) => k in DEFAULT_FORM)
          .map(([k, v]) => {
            if (typeof v === 'boolean') return [k, v]
            return [k, String(v ?? '')]
          })
      ),
    }))
    pushToast('Form populated from YAML', 'success')
  }

  const handleImportPath = async () => {
    const path = importPath.trim()
    if (!path) return
    setImporting(true)
    try {
      const resp = await fetch(api('/training/import-yaml-path'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      const data = await resp.json()
      if (!resp.ok) { pushToast(data.detail ?? 'Import failed', 'error'); return }
      applyImportedPayload(data.payload)
    } catch (e: any) {
      pushToast(`Import error: ${e.message}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const resp = await fetch(api('/training/import-yaml'), { method: 'POST', body: fd })
      const data = await resp.json()
      if (!resp.ok) { pushToast(data.detail ?? 'Import failed', 'error'); return }
      applyImportedPayload(data.payload)
    } catch (e: any) {
      pushToast(`Import error: ${e.message}`, 'error')
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // -----------------------------------------------------------------------
  // Submit
  // -----------------------------------------------------------------------
  const handleSubmit = async () => {
    setSubmitting(true)
    setDryResult(null)
    try {
      const payload = formToPayload(form)
      const resp = await fetch(api('/training/jobs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          payload,
          preset_name: form.preset_name,
          mode: form.mode,
        }),
      })
      const data = await resp.json()
      if (!resp.ok) {
        pushToast(data.detail ?? 'Submission failed', 'error')
        return
      }
      if (form.mode === 'dry') {
        setDryResult(data)
        pushToast('YAML generated successfully', 'success')
      } else {
        pushToast('Training job queued', 'success')
      }
      await loadJobs()
    } catch (e: any) {
      pushToast(`Error: ${e.message}`, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  // -----------------------------------------------------------------------
  // Clone job → restore form
  // -----------------------------------------------------------------------
  const handleClone = async (job_id: string) => {
    try {
      const resp = await fetch(api(`/training/jobs/${job_id}/clone`), { method: 'POST' })
      if (!resp.ok) throw new Error('Clone failed')
      const data = await resp.json()
      const p = data.payload ?? {}
      // Map payload back to form fields
      setForm(f => ({
        ...f,
        ...Object.fromEntries(
          Object.entries(p).filter(([k]) => k in DEFAULT_FORM).map(([k, v]) => {
            if (Array.isArray(v)) return [k, v.join(', ')]
            return [k, String(v ?? '')]
          })
        ),
      }))
      pushToast('Form restored from job', 'success')
    } catch {
      pushToast('Failed to clone job', 'error')
    }
  }

  // -----------------------------------------------------------------------
  // Cancel job
  // -----------------------------------------------------------------------
  const handleCancel = async (job_id: string) => {
    await fetch(api(`/training/jobs/${job_id}`), { method: 'DELETE' })
    await loadJobs()
  }

  // -----------------------------------------------------------------------
  // Delete history
  // -----------------------------------------------------------------------
  const handleDelete = async (job_id: string) => {
    await fetch(api(`/training/jobs/${job_id}/history`), { method: 'DELETE' })
    await loadJobs()
  }

  // -----------------------------------------------------------------------
  // Unlock handlers
  // -----------------------------------------------------------------------
  const handleUnlock = async () => {
    const pwd = unlockPassword.trim()
    if (!pwd || unlocking) return
    setUnlocking(true)
    setUnlockError('')
    try {
      const resp = await fetch(api('/training/unlock'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      })
      const data = await resp.json()
      if (!resp.ok) {
        setUnlockError(data.detail ?? 'Incorrect password')
        return
      }
      setUnlockToken(data.token)
      setUnlockPassword('')
    } catch (e: any) {
      setUnlockError(e.message ?? 'Unlock failed')
    } finally {
      setUnlocking(false)
    }
  }

  const handleLock = () => {
    setUnlockToken('')
    setUnlocked(false)
  }

  // -----------------------------------------------------------------------
  // Preset bar interop
  // -----------------------------------------------------------------------
  const presetConfig = { ...form }

  const handlePresetLoad = (config: Record<string, unknown>) => {
    setForm(f => ({
      ...f,
      ...Object.fromEntries(
        Object.entries(config)
          .filter(([k]) => k in DEFAULT_FORM)
          .map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v ?? '')])
      ),
    }))
  }

  const presetBarRef = useRef<{ getCurrentConfig: () => Record<string, unknown> } | null>(null)

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div style={{ display: 'flex', gap: 16, padding: 12, height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* ----------------------------------------------------------------- */}
      {/* LEFT: Form                                                          */}
      {/* ----------------------------------------------------------------- */}
      <div
        style={{
          flex: '0 0 440px',
          overflowY: 'auto',
          paddingRight: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <PresetsBar
          page="training"
          currentConfig={presetConfig}
          onLoad={handlePresetLoad}
        />

        {/* Extended model unlock */}
        {unlockAvailable && (
          <div className="card" style={{ padding: 10, marginTop: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              Extended Models
            </div>
            {unlocked ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <LockOpen size={14} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: 12, color: 'var(--accent)', flex: 1 }}>Extended models unlocked</span>
                <button className="btn-action btn-danger" style={{ fontSize: 11 }} onClick={handleLock}>
                  <Lock size={12} /> Lock
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Lock size={14} style={{ color: 'var(--fg-muted)', flexShrink: 0, marginTop: 3 }} />
                  <input
                    type="password"
                    className="gen-input"
                    placeholder="Password to unlock extended models…"
                    value={unlockPassword}
                    onChange={e => { setUnlockPassword(e.target.value); setUnlockError('') }}
                    onKeyDown={e => { if (e.key === 'Enter') handleUnlock() }}
                    style={{ flex: 1, fontSize: 11 }}
                  />
                  <button
                    className="btn-action"
                    style={{ fontSize: 11 }}
                    onClick={handleUnlock}
                    disabled={!unlockPassword.trim() || unlocking}
                  >
                    {unlocking ? <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} /> : 'Unlock'}
                  </button>
                </div>
                {unlockError && (
                  <div style={{ fontSize: 11, color: 'var(--error, #e05c5c)', marginTop: 4 }}>
                    {unlockError}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* YAML import */}
        <div className="card" style={{ padding: 10, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>
            Import YAML config
          </div>
          {/* Path-based import */}
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="gen-input"
              value={importPath}
              onChange={e => setImportPath(e.target.value)}
              placeholder="/absolute/path/to/train_config.yaml"
              style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11 }}
              onKeyDown={e => { if (e.key === 'Enter') handleImportPath() }}
            />
            <button
              className="btn-action"
              onClick={handleImportPath}
              disabled={importing || !importPath.trim()}
              style={{ whiteSpace: 'nowrap' }}
            >
              {importing ? <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <FolderOpen size={12} />}
              Load
            </button>
          </div>
          {/* File upload */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>or</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".yaml,.yml"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
            <button
              className="btn-action"
              style={{ fontSize: 11 }}
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
            >
              <Upload size={12} /> Upload .yaml file
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: 12, marginTop: 8 }}>
          {/* Task family */}
          <FieldRow label="Task family">
            <select
              className="gen-select"
              value={form.task_family}
              onChange={e => setField('task_family', e.target.value)}
            >
              {families.map(f => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </FieldRow>

          {/* Mode */}
          <FieldRow label="Mode">
            <div style={{ display: 'flex', gap: 12 }}>
              {(['run', 'dry'] as const).map(m => (
                <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="mode"
                    value={m}
                    checked={form.mode === m}
                    onChange={() => setField('mode', m)}
                  />
                  {m === 'run' ? 'Run (queued)' : 'Dry (YAML only)'}
                </label>
              ))}
            </div>
          </FieldRow>

          <FieldRow label="Experiment name">
            <TextInput value={form.name} onChange={v => setField('name', v)} placeholder="my_experiment" />
          </FieldRow>
          <FieldRow label="Seed">
            <NumInput value={form.seed} onChange={v => setField('seed', v)} />
          </FieldRow>
          <FieldRow label="Tags" hint="comma-separated">
            <TextInput value={form.tags} onChange={v => setField('tags', v)} placeholder="exp1, baseline" />
          </FieldRow>
          <FieldRow label="Preset name">
            <TextInput value={form.preset_name} onChange={v => setField('preset_name', v)} placeholder="optional" />
          </FieldRow>

          {/* Data section */}
          <SectionHeader title="Data" open={openSections.data} onToggle={() => toggleSection('data')} />
          {openSections.data && (
            <>
              <FieldRow label="Dataset name" hint="unique cache key">
                <TextInput value={form.dataset_name} onChange={v => setField('dataset_name', v)} placeholder="qm9" />
              </FieldRow>
              <FieldRow label="Data root">
                <TextInput value={form.data_root} onChange={v => setField('data_root', v)} placeholder="data/" mono />
              </FieldRow>
              <FieldRow label="CSV path" hint="or leave blank if using ASE DB">
                <TextInput value={form.csv_path} onChange={v => setField('csv_path', v)} placeholder="data/molecules.csv" mono />
              </FieldRow>
              <FieldRow label="XYZ directory">
                <TextInput value={form.xyz_dir} onChange={v => setField('xyz_dir', v)} placeholder="data/xyz/" mono />
              </FieldRow>
              <FieldRow label="ASE DB path" hint="overrides CSV+XYZ">
                <TextInput value={form.ase_db_path} onChange={v => setField('ase_db_path', v)} placeholder="data/molecules.db" mono />
              </FieldRow>
              <FieldRow label="Atom vocab" hint="space or comma separated">
                <TextInput value={form.atom_vocab} onChange={v => setField('atom_vocab', v)} />
              </FieldRow>
              <FieldRow label="Batch size">
                <NumInput value={form.batch_size} onChange={v => setField('batch_size', v)} />
              </FieldRow>
              <FieldRow label="Max atoms">
                <NumInput value={form.max_atom} onChange={v => setField('max_atom', v)} />
              </FieldRow>
              <FieldRow label="Train ratio">
                <NumInput value={form.train_ratio} onChange={v => setField('train_ratio', v)} step="0.05" />
              </FieldRow>
              <FieldRow label="">
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <CheckInput value={form.with_hydrogen} onChange={v => setField('with_hydrogen', v)} label="Include H" />
                  <CheckInput value={form.use_ohe_feature} onChange={v => setField('use_ohe_feature', v)} label="OHE features" />
                  <CheckInput value={form.allow_unknown} onChange={v => setField('allow_unknown', v)} label="Allow unknown atom" />
                  <CheckInput value={form.data_efficient_collator} onChange={v => setField('data_efficient_collator', v)} label="Efficient collator" />
                </div>
              </FieldRow>
            </>
          )}

          {/* Model section */}
          <SectionHeader title="Model" open={openSections.model} onToggle={() => toggleSection('model')} />
          {openSections.model && (
            <>
              <FieldRow label="Hidden size">
                <NumInput value={form.hidden_size} onChange={v => setField('hidden_size', v)} />
              </FieldRow>
              <FieldRow label="Num layers">
                <NumInput value={form.num_layers} onChange={v => setField('num_layers', v)} />
              </FieldRow>
              <FieldRow label="Num sublayers">
                <NumInput value={form.num_sublayers} onChange={v => setField('num_sublayers', v)} />
              </FieldRow>
              <FieldRow label="Dropout">
                <NumInput value={form.dropout} onChange={v => setField('dropout', v)} step="0.05" />
              </FieldRow>
              <FieldRow label="Condition names" hint="comma-separated properties">
                <TextInput value={form.condition_names} onChange={v => setField('condition_names', v)} placeholder="prop1, prop2" />
              </FieldRow>
              <FieldRow label="">
                <div style={{ display: 'flex', gap: 12 }}>
                  <CheckInput value={form.attention} onChange={v => setField('attention', v)} label="Attention" />
                  <CheckInput value={form.tanh} onChange={v => setField('tanh', v)} label="Tanh" />
                </div>
              </FieldRow>
              <FieldRow label="Load weights from" hint="fine-tuning">
                <TextInput value={form.load_weights_from} onChange={v => setField('load_weights_from', v)} placeholder="/path/to/checkpoint.ckpt" mono />
              </FieldRow>
              <FieldRow label="Resume checkpoint">
                <TextInput value={form.resume_from_checkpoint} onChange={v => setField('resume_from_checkpoint', v)} placeholder="/path/to/checkpoint.ckpt" mono />
              </FieldRow>
            </>
          )}

          {/* Diffusion / Flow-matching */}
          {(category === 'diffusion' || category === 'flow_matching') && (
            <>
              <SectionHeader title="Diffusion settings" open={openSections.diffusion} onToggle={() => toggleSection('diffusion')} />
              {openSections.diffusion && (
                <>
                  <FieldRow label="Diffusion steps">
                    <NumInput value={form.diffusion_steps} onChange={v => setField('diffusion_steps', v)} />
                  </FieldRow>
                  <FieldRow label="Noise schedule">
                    <SelectInput
                      value={form.diffusion_noise_schedule}
                      onChange={v => setField('diffusion_noise_schedule', v)}
                      options={[
                        { value: 'polynomial_2', label: 'Polynomial 2' },
                        { value: 'cosine_x', label: 'Cosine X' },
                        { value: 'issnr_1_2', label: 'ISSNR 1_2' },
                        { value: 'learned', label: 'Learned' },
                      ]}
                    />
                  </FieldRow>
                  <FieldRow label="Loss type">
                    <SelectInput
                      value={form.diffusion_loss_type}
                      onChange={v => setField('diffusion_loss_type', v)}
                      options={[
                        { value: 'vlb', label: 'VLB' },
                        { value: 'l2', label: 'L2' },
                      ]}
                    />
                  </FieldRow>
                  <FieldRow label="CFG mask rate">
                    <NumInput value={form.context_mask_rate} onChange={v => setField('context_mask_rate', v)} step="0.05" />
                  </FieldRow>
                  <FieldRow label="Mask value">
                    <NumInput value={form.mask_value} onChange={v => setField('mask_value', v)} />
                  </FieldRow>
                  {hasConditionNames && (
                    <>
                      <FieldRow label="Normalize condition">
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <SelectInput
                            value={form.normalize_condition}
                            onChange={v => setField('normalize_condition', v)}
                            options={[
                              { value: 'none', label: 'None' },
                              { value: 'value', label: 'Value divisor' },
                              { value: 'maxmin', label: 'Max-min' },
                              { value: 'mad', label: 'MAD' },
                            ]}
                          />
                          {form.normalize_condition === 'value' && (
                            <>
                              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>N</span>
                              <NumInput
                                value={form.normalize_condition_divisor}
                                onChange={v => setField('normalize_condition_divisor', v)}
                                step="0.1"
                              />
                            </>
                          )}
                        </div>
                      </FieldRow>
                      <FieldRow label="Adapter conditions" hint="comma-separated subset">
                        <TextInput value={form.adapter_conditions} onChange={v => setField('adapter_conditions', v)} placeholder="prop1, prop2" />
                      </FieldRow>
                      <FieldRow label="">
                        <CheckInput value={form.use_adapter_module} onChange={v => setField('use_adapter_module', v)} label="Use adapter module" />
                      </FieldRow>
                    </>
                  )}
                  <FieldRow label="">
                    <CheckInput value={form.sp_regularizer_deploy} onChange={v => setField('sp_regularizer_deploy', v)} label="Deploy SP regularizer" />
                  </FieldRow>
                  {form.sp_regularizer_deploy && (
                    <>
                      <FieldRow label="SP regularizer">
                        <SelectInput
                          value={form.sp_regularizer_regularizer}
                          onChange={v => setField('sp_regularizer_regularizer', v)}
                          options={[
                            { value: 'hard', label: 'Hard' },
                            { value: 'soft', label: 'Soft' },
                            { value: 'polynomial', label: 'Polynomial' },
                          ]}
                        />
                      </FieldRow>
                      <FieldRow label="SP lambda">
                        <NumInput value={form.sp_regularizer_lambda_} onChange={v => setField('sp_regularizer_lambda_', v)} step="0.1" />
                      </FieldRow>
                      <FieldRow label="SP lambda 2">
                        <NumInput value={form.sp_regularizer_lambda_2} onChange={v => setField('sp_regularizer_lambda_2', v)} step="10" />
                      </FieldRow>
                      <FieldRow label="SP lambda update value">
                        <NumInput value={form.sp_regularizer_lambda_update_value} onChange={v => setField('sp_regularizer_lambda_update_value', v)} step="0.1" />
                      </FieldRow>
                      <FieldRow label="SP lambda update step">
                        <NumInput value={form.sp_regularizer_lambda_update_step} onChange={v => setField('sp_regularizer_lambda_update_step', v)} />
                      </FieldRow>
                      <FieldRow label="SP polynomial p">
                        <NumInput value={form.sp_regularizer_polynomial_p} onChange={v => setField('sp_regularizer_polynomial_p', v)} step="0.1" />
                      </FieldRow>
                      <FieldRow label="SP warm-up steps">
                        <NumInput value={form.sp_regularizer_warm_up_steps} onChange={v => setField('sp_regularizer_warm_up_steps', v)} />
                      </FieldRow>
                    </>
                  )}
                  <FieldRow label="Normalize factors" hint="coords, categorical, integer">
                    <TextInput value={form.normalize_factors} onChange={v => setField('normalize_factors', v)} placeholder="1.0, 4.0, 10.0" />
                  </FieldRow>
                  <FieldRow label="Val samples (n_samples)">
                    <NumInput value={form.n_samples} onChange={v => setField('n_samples', v)} />
                  </FieldRow>
                  <FieldRow label="">
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <CheckInput value={form.generative_analysis} onChange={v => setField('generative_analysis', v)} label="Generative analysis" />
                      <CheckInput value={form.use_posebuster} onChange={v => setField('use_posebuster', v)} label="Use PoseBuster" />
                    </div>
                  </FieldRow>
                  {category === 'flow_matching' && (
                    <>
                      <FieldRow label="FM min_t">
                        <NumInput value={form.fm_min_t} onChange={v => setField('fm_min_t', v)} step="0.001" />
                      </FieldRow>
                      <FieldRow label="FM timesteps">
                        <NumInput value={form.fm_num_timesteps} onChange={v => setField('fm_num_timesteps', v)} />
                      </FieldRow>
                      <FieldRow label="">
                        <div style={{ display: 'flex', gap: 12 }}>
                          <CheckInput value={form.fm_self_condition} onChange={v => setField('fm_self_condition', v)} label="Self-condition" />
                          <CheckInput value={form.use_velocity} onChange={v => setField('use_velocity', v)} label="Use velocity" />
                        </div>
                      </FieldRow>
                    </>
                  )}
                </>
              )}
            </>
          )}

          {/* Regression */}
          {category === 'regression' && (
            <>
              <SectionHeader title="Regression settings" open={openSections.regression} onToggle={() => toggleSection('regression')} />
              {openSections.regression && (
                <>
                  <FieldRow label="Target columns" hint="comma-separated property names">
                    <TextInput value={form.task_learn} onChange={v => setField('task_learn', v)} placeholder="prop1, prop2" />
                  </FieldRow>
                  <FieldRow label="Loss criterion">
                    <SelectInput
                      value={form.criterion}
                      onChange={v => setField('criterion', v)}
                      options={[{ value: 'mse', label: 'MSE' }, { value: 'mae', label: 'MAE' }]}
                    />
                  </FieldRow>
                  <FieldRow label="Metrics" hint="comma-separated">
                    <TextInput value={form.metric} onChange={v => setField('metric', v)} placeholder="mae" />
                  </FieldRow>
                  <FieldRow label="MLP layers">
                    <NumInput value={form.num_mlp_layer} onChange={v => setField('num_mlp_layer', v)} />
                  </FieldRow>
                  <FieldRow label="MLP norm">
                    <SelectInput
                      value={form.mlp_batch_norm}
                      onChange={v => setField('mlp_batch_norm', v)}
                      options={[
                        { value: 'batchnorm', label: 'Batch norm' },
                        { value: 'layernorm', label: 'Layer norm' },
                        { value: 'none', label: 'None' },
                      ]}
                    />
                  </FieldRow>
                  <FieldRow label="MLP dropout">
                    <NumInput value={form.mlp_dropout} onChange={v => setField('mlp_dropout', v)} step="0.05" />
                  </FieldRow>
                  <FieldRow label="">
                    <CheckInput value={form.target_normalization} onChange={v => setField('target_normalization', v)} label="Normalize targets" />
                  </FieldRow>
                </>
              )}
            </>
          )}

          {/* SSL3D */}
          {category === 'ssl3d' && (
            <>
              <SectionHeader title="SSL-3D settings" open={openSections.ssl3d} onToggle={() => toggleSection('ssl3d')} />
              {openSections.ssl3d && (
                <>
                  <FieldRow label="Denoise weight">
                    <NumInput value={form.ssl3d_denoise_weight} onChange={v => setField('ssl3d_denoise_weight', v)} step="0.1" />
                  </FieldRow>
                  <FieldRow label="Atom mask rate">
                    <NumInput value={form.ssl3d_mask_rate} onChange={v => setField('ssl3d_mask_rate', v)} step="0.05" />
                  </FieldRow>
                  <FieldRow label="Atom type weight">
                    <NumInput value={form.ssl3d_mtype_weight} onChange={v => setField('ssl3d_mtype_weight', v)} step="0.1" />
                  </FieldRow>
                  <FieldRow label="Sigma min">
                    <NumInput value={form.ssl3d_sigma_min} onChange={v => setField('ssl3d_sigma_min', v)} step="0.01" />
                  </FieldRow>
                  <FieldRow label="Sigma max">
                    <NumInput value={form.ssl3d_sigma_max} onChange={v => setField('ssl3d_sigma_max', v)} step="0.1" />
                  </FieldRow>
                  <FieldRow label="Sigma schedule">
                    <SelectInput
                      value={form.ssl3d_sigma_schedule}
                      onChange={v => setField('ssl3d_sigma_schedule', v)}
                      options={[
                        { value: 'uniform', label: 'Uniform' },
                        { value: 'log_uniform', label: 'Log-uniform' },
                      ]}
                    />
                  </FieldRow>
                </>
              )}
            </>
          )}

          {/* VAE */}
          {category === 'vae' && (
            <>
              <SectionHeader title="VAE settings" open={openSections.vae} onToggle={() => toggleSection('vae')} />
              {openSections.vae && (
                <>
                  <FieldRow label="Latent dim">
                    <NumInput value={form.latent_dim} onChange={v => setField('latent_dim', v)} />
                  </FieldRow>
                  <FieldRow label="Augment noise">
                    <NumInput value={form.augment_noise} onChange={v => setField('augment_noise', v)} step="0.05" />
                  </FieldRow>
                  <FieldRow label="">
                    <CheckInput value={form.augment_rotation} onChange={v => setField('augment_rotation', v)} label="Augment rotation" />
                  </FieldRow>
                </>
              )}
            </>
          )}

          {/* Trainer */}
          <SectionHeader title="Trainer" open={openSections.trainer} onToggle={() => toggleSection('trainer')} />
          {openSections.trainer && (
            <>
              <FieldRow label="Optimizer">
                <SelectInput
                  value={form.optimizer_choice}
                  onChange={v => setField('optimizer_choice', v)}
                  options={[
                    { value: 'adamw', label: 'AdamW' },
                    { value: 'adam', label: 'Adam' },
                    { value: 'amsgrad', label: 'AMSGrad' },
                    { value: 'radam', label: 'RAdam' },
                  ]}
                />
              </FieldRow>
              <FieldRow label="Learning rate">
                <NumInput value={form.lr} onChange={v => setField('lr', v)} step="0.0001" />
              </FieldRow>
              <FieldRow label="Weight decay">
                <NumInput value={form.weight_decay} onChange={v => setField('weight_decay', v)} step="1e-12" />
              </FieldRow>
              <FieldRow label="Num epochs" hint="leave blank to use num_steps">
                <NumInput value={form.num_epochs} onChange={v => setField('num_epochs', v)} />
              </FieldRow>
              <FieldRow label="Num steps" hint="overrides num_epochs">
                <NumInput value={form.num_steps} onChange={v => setField('num_steps', v)} placeholder="optional" />
              </FieldRow>
              <FieldRow label="Scheduler">
                <SelectInput
                  value={form.scheduler}
                  onChange={v => setField('scheduler', v)}
                  options={[
                    { value: 'cosineannealing', label: 'Cosine annealing' },
                    { value: 'reducelronplateau', label: 'ReduceLR on plateau' },
                    { value: 'steplr', label: 'Step LR' },
                    { value: 'onecyclelr', label: 'One-cycle LR' },
                    { value: 'exponentiallr', label: 'Exponential LR' },
                  ]}
                />
              </FieldRow>
              <FieldRow label="Validation interval">
                <NumInput value={form.validation_interval} onChange={v => setField('validation_interval', v)} />
              </FieldRow>
              <FieldRow label="EMA decay">
                <NumInput value={form.ema_decay} onChange={v => setField('ema_decay', v)} step="0.0001" />
              </FieldRow>
              <FieldRow label="Precision">
                <SelectInput
                  value={form.precision}
                  onChange={v => setField('precision', v)}
                  options={[
                    { value: '32', label: 'FP32' },
                    { value: '16', label: 'FP16' },
                    { value: 'bf16', label: 'BF16' },
                  ]}
                />
              </FieldRow>
              <FieldRow label="Save top K">
                <NumInput value={form.save_top_k} onChange={v => setField('save_top_k', v)} />
              </FieldRow>
              <FieldRow label="Init grad norm">
                <NumInput value={form.init_grad_norm} onChange={v => setField('init_grad_norm', v)} />
              </FieldRow>
              <FieldRow label="Grad clip mode">
                <SelectInput
                  value={form.gradient_clip_mode}
                  onChange={v => setField('gradient_clip_mode', v)}
                  options={[
                    { value: 'norm', label: 'Norm' },
                    { value: 'value', label: 'Value' },
                  ]}
                />
              </FieldRow>
              <FieldRow label="">
                <CheckInput value={form.save_every_val_epoch} onChange={v => setField('save_every_val_epoch', v)} label="Save every val epoch" />
              </FieldRow>
              <FieldRow label="Monitor metric">
                <TextInput value={form.monitor_metric} onChange={v => setField('monitor_metric', v)} placeholder="gen/Validity" />
              </FieldRow>
              <FieldRow label="Monitor mode">
                <SelectInput
                  value={form.monitor_mode}
                  onChange={v => setField('monitor_mode', v)}
                  options={[{ value: 'max', label: 'max' }, { value: 'min', label: 'min' }]}
                />
              </FieldRow>
            </>
          )}

          {/* Logger */}
          <SectionHeader title="Logger" open={openSections.logger} onToggle={() => toggleSection('logger')} />
          {openSections.logger && (
            <>
              <FieldRow label="Backend">
                <SelectInput
                  value={form.logger_backend}
                  onChange={v => setField('logger_backend', v)}
                  options={[
                    { value: 'logging', label: 'File (local)' },
                    { value: 'wandb', label: 'Weights & Biases' },
                  ]}
                />
              </FieldRow>
              <FieldRow label="Log interval">
                <NumInput value={form.log_interval} onChange={v => setField('log_interval', v)} />
              </FieldRow>
              {form.logger_backend === 'wandb' && (
                <>
                  <FieldRow label="W&B run name">
                    <TextInput value={form.wandb_name} onChange={v => setField('wandb_name', v)} />
                  </FieldRow>
                  <FieldRow label="W&B project">
                    <TextInput value={form.wandb_project} onChange={v => setField('wandb_project', v)} />
                  </FieldRow>
                  <FieldRow label="W&B tags" hint="comma-separated">
                    <TextInput value={form.wandb_tags} onChange={v => setField('wandb_tags', v)} />
                  </FieldRow>
                </>
              )}
            </>
          )}

          {/* Engine */}
          <SectionHeader title="Engine" open={openSections.engine} onToggle={() => toggleSection('engine')} />
          {openSections.engine && (
            <>
              <FieldRow label="Engine type">
                <SelectInput
                  value={form.engine_type}
                  onChange={v => setField('engine_type', v)}
                  options={[
                    { value: 'original', label: 'Original (custom loop)' },
                    { value: 'lightning', label: 'PyTorch Lightning' },
                  ]}
                />
              </FieldRow>
              {form.engine_type === 'lightning' && (
                <FieldRow label="Num workers">
                  <NumInput value={form.num_workers} onChange={v => setField('num_workers', v)} />
                </FieldRow>
              )}
            </>
          )}

          {/* Submit */}
          <div style={{ marginTop: 14 }}>
            <button
              className="btn-action"
              style={{ width: '100%', justifyContent: 'center', padding: '8px 0', fontWeight: 700 }}
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? (
                <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
              ) : form.mode === 'dry' ? (
                <>
                  <Download size={14} /> Generate YAML
                </>
              ) : (
                <>
                  <Play size={14} /> Queue training job
                </>
              )}
            </button>
          </div>

          {/* Dry-mode inline result */}
          {dryResult && (
            <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>
                YAML generated · <StatusBadge status="dry" />
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <button
                  className="btn-action"
                  style={{ fontSize: 11 }}
                  onClick={() => navigator.clipboard.writeText(dryResult.suggested_command)}
                >
                  <ClipboardCopy size={12} /> Copy command
                </button>
                <button
                  className="btn-action"
                  style={{ fontSize: 11 }}
                  onClick={() => {
                    const blob = new Blob([dryResult.config_yaml ?? ''], { type: 'text/yaml' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `training_${dryResult.job_id}.yaml`
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                >
                  <Download size={12} /> Download YAML
                </button>
              </div>
              <code
                style={{
                  display: 'block',
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '4px 8px',
                  marginBottom: 6,
                  wordBreak: 'break-all',
                }}
              >
                {dryResult.suggested_command}
              </code>
              <pre
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: 8,
                  maxHeight: 240,
                  overflow: 'auto',
                  whiteSpace: 'pre',
                  color: 'var(--fg)',
                  margin: 0,
                }}
              >
                {dryResult.config_yaml}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* RIGHT: History                                                      */}
      {/* ----------------------------------------------------------------- */}
      <div style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>Job History</span>
          <button className="btn-action" style={{ fontSize: 11 }} onClick={loadJobs}>
            <RefreshCw size={12} /> Refresh
          </button>
        </div>

        {jobs.length === 0 ? (
          <div className="card" style={{ padding: 16, textAlign: 'center', color: 'var(--fg-muted)', fontSize: 12 }}>
            No training jobs yet. Fill in the form and click "Queue training job" or "Generate YAML".
          </div>
        ) : (
          jobs.map(job => (
            <JobRow
              key={job.job_id}
              job={job}
              onCancel={() => handleCancel(job.job_id)}
              onDelete={() => handleDelete(job.job_id)}
              onClone={() => handleClone(job.job_id)}
              onRefresh={loadJobs}
            />
          ))
        )}
      </div>
    </div>
  )
}
