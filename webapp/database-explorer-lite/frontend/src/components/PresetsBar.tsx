import React, { useEffect, useState } from 'react'
import { BACKEND } from '../config'
import { downloadTextFile } from '../utils/download'

type Preset = {
  id: string
  name: string
  page: string
  createdAt: string
  config: Record<string, unknown>
}

type PresetsBarProps = {
  page: 'generation' | 'structure-guided' | 'training'
  currentConfig: Record<string, unknown>
  onLoad: (config: Record<string, unknown>) => void
}

const api = (path: string) => `${BACKEND}${path}`

export default function PresetsBar({ page, currentConfig, onLoad }: PresetsBarProps) {
  const [presets, setPresets] = useState<Preset[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [saveName, setSaveName] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflicting, setConflicting] = useState<Preset | null>(null)

  const selectedPreset = presets.find(p => p.id === selectedId) ?? null

  useEffect(() => {
    fetch(api(`/presets/${page}`))
      .then(r => r.json())
      .then(data => setPresets(Array.isArray(data.presets) ? data.presets : []))
      .catch(err => console.error('Failed to load presets:', err))
  }, [page])

  const doSave = async (name: string, overwriteId?: string) => {
    setBusy(true)
    try {
      if (overwriteId) {
        await fetch(api(`/presets/${page}/${overwriteId}`), { method: 'DELETE' })
      }
      const resp = await fetch(api(`/presets/${page}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, config: currentConfig }),
      })
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
      const preset: Preset = await resp.json()
      setPresets(prev => prev.filter(p => p.id !== overwriteId).concat(preset))
      setSelectedId(preset.id)
      setSaveName('')
      setConflicting(null)
    } catch (err: any) {
      console.error('Failed to save preset:', err)
    } finally {
      setBusy(false)
    }
  }

  const handleSave = () => {
    const name = saveName.trim()
    if (!name || busy) return
    const existing = presets.find(p => p.name === name)
    if (existing) {
      setConflicting(existing)
      return
    }
    void doSave(name)
  }

  const handleOverwrite = () => {
    if (!conflicting || busy) return
    void doSave(conflicting.name, conflicting.id)
  }

  const handleLoad = () => {
    if (!selectedPreset) return
    onLoad(selectedPreset.config)
  }

  const handleDownload = () => {
    if (!selectedPreset) return
    downloadTextFile(`${selectedPreset.name}.json`, JSON.stringify(selectedPreset, null, 2))
  }

  const handleDelete = async () => {
    if (!selectedPreset || busy) return
    setBusy(true)
    try {
      const resp = await fetch(api(`/presets/${page}/${selectedPreset.id}`), { method: 'DELETE' })
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
      setPresets(prev => prev.filter(p => p.id !== selectedPreset.id))
      setSelectedId('')
    } catch (err: any) {
      console.error('Failed to delete preset:', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="generation-section">
      <div className="generation-section-title">Presets</div>
      <div className="presets-bar-row">
        <select value={selectedId} onChange={e => setSelectedId(e.target.value)}>
          <option value="">— select preset —</option>
          {presets.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <button type="button" onClick={handleLoad} disabled={!selectedPreset || busy}>
          Load
        </button>
        <button type="button" onClick={handleDownload} disabled={!selectedPreset} title="Download preset as JSON">
          Download
        </button>
        <button type="button" className="btn-danger btn-sm" onClick={handleDelete} disabled={!selectedPreset || busy} title="Delete preset">
          Delete
        </button>
      </div>
      <div className="presets-bar-row">
        <input
          type="text"
          className="presets-bar-name"
          placeholder="Preset name…"
          value={saveName}
          onChange={e => { setSaveName(e.target.value); setConflicting(null) }}
          onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
        />
        <button
          type="button"
          className="btn-primary btn-sm"
          onClick={handleSave}
          disabled={!saveName.trim() || busy}
        >
          Save current
        </button>
      </div>
      {conflicting && (
        <div className="presets-bar-conflict">
          <span>⚠ &ldquo;{conflicting.name}&rdquo; already exists.</span>
          <button type="button" className="btn-danger btn-sm" onClick={handleOverwrite} disabled={busy}>
            Overwrite
          </button>
          <button type="button" className="btn-sm" onClick={() => setConflicting(null)}>
            Cancel
          </button>
        </div>
      )}
      {!presets.length && (
        <div className="legend" style={{ marginTop: 4 }}>No presets saved yet.</div>
      )}
    </section>
  )
}
