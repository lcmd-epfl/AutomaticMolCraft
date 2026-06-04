import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Settings, X } from 'lucide-react'
import { useStore } from '../store/store'
import { useUIStore } from '../store/uiStore'
import { getXYZ } from '../utils/xyzLoader'
import { exportHostCanvasesToPng } from '../utils/plotExport'
import { BACKEND } from '../config'
import * as OCL from 'openchemlib'

type StyleMode = 'ballstick' | 'sticks' | 'spacefill'
type MeasureMode = 'off' | 'distance' | 'angle'
type AtomLabelMode = 'off' | 'index' | 'atomicNumber' | 'element'
type SplitCount = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
type PaneViewMode = '3d' | '2d' | 'data'
type RowDetail = { key: string; value: string }

const ELEMENT_TO_NUMBER: Record<string, number> = {
  H: 1, He: 2, Li: 3, Be: 4, B: 5, C: 6, N: 7, O: 8, F: 9, Ne: 10,
  Na: 11, Mg: 12, Al: 13, Si: 14, P: 15, S: 16, Cl: 17, Ar: 18, K: 19, Ca: 20,
  Br: 35, I: 53
}

function normalizeSmiles(raw: string): string {
  let s = raw.trim()
  if (!s) return ''
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  return s
}

function applyStyle(viewer: any, mode: StyleMode, showHydrogens: boolean) {
  viewer.setStyle({}, {})

  const sel = showHydrogens ? {} : { not: { elem: 'H' } }

  if (mode === 'ballstick') {
    viewer.setStyle(sel, { stick: { radius: 0.15 }, sphere: { scale: 0.23 } })
  } else if (mode === 'sticks') {
    viewer.setStyle(sel, { stick: { radius: 0.2 } })
  } else {
    viewer.setStyle(sel, { sphere: { scale: 1.0 } })
  }
}

function atomNumber(atom: any): number | null {
  if (typeof atom?.serial === 'number') return atom.serial
  if (typeof atom?.index === 'number') return atom.index + 1
  return null
}

function atomLabel(atom: any): string {
  const elem = atom?.elem ?? '?'
  const n = atomNumber(atom)
  return `${elem}${n ?? '?'}`
}

function distÅ(a: any, b: any) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function angleLabelPosition(a: any, b: any, c: any, offset = 0.8) {
  const v1 = {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z
  }
  const v2 = {
    x: c.x - b.x,
    y: c.y - b.y,
    z: c.z - b.z
  }

  const n1 = Math.hypot(v1.x, v1.y, v1.z) || 1
  const n2 = Math.hypot(v2.x, v2.y, v2.z) || 1

  v1.x /= n1; v1.y /= n1; v1.z /= n1
  v2.x /= n2; v2.y /= n2; v2.z /= n2

  const bis = {
    x: v1.x + v2.x,
    y: v1.y + v2.y,
    z: v1.z + v2.z
  }

  const nb = Math.hypot(bis.x, bis.y, bis.z) || 1
  bis.x /= nb; bis.y /= nb; bis.z /= nb

  return {
    x: b.x + bis.x * offset,
    y: b.y + bis.y * offset,
    z: b.z + bis.z * offset
  }
}

function angleDeg(a: any, b: any, c: any) {
  const bax = a.x - b.x
  const bay = a.y - b.y
  const baz = a.z - b.z

  const bcx = c.x - b.x
  const bcy = c.y - b.y
  const bcz = c.z - b.z

  const dot = bax * bcx + bay * bcy + baz * bcz
  const n1 = Math.sqrt(bax * bax + bay * bay + baz * baz)
  const n2 = Math.sqrt(bcx * bcx + bcy * bcy + bcz * bcz)
  if (n1 === 0 || n2 === 0) return NaN

  let cos = dot / (n1 * n2)
  cos = Math.max(-1, Math.min(1, cos))
  return (Math.acos(cos) * 180) / Math.PI
}

function hexTo3DmolColor(hex: string) {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : '0b0d10'
  return Number.parseInt(clean, 16)
}

type MoleculePaneProps = {
  moleculeId: string | null
  smiles: string | null
  rowDetails: ReadonlyArray<RowDetail>
  source: any
  styleMode: StyleMode
  showHydrogens: boolean
  labelMode: AtomLabelMode
  backgroundColor: string
  measureMode: MeasureMode
  isActive: boolean
  label: string
  onActivate: () => void
  clearSignal: number
  onMeasurementResult: (text: string | null) => void
  onExportError: (text: string) => void
}

function MoleculePane({
  moleculeId,
  smiles,
  rowDetails,
  source,
  styleMode,
  showHydrogens,
  labelMode,
  backgroundColor,
  measureMode,
  isActive,
  label,
  onActivate,
  clearSignal,
  onMeasurementResult,
  onExportError,
}: MoleculePaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvas2dHostRef = useRef<HTMLDivElement>(null)
  const svg2dRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<any>(null)

  const [loading, setLoading] = useState(false)
  const [paneViewMode, setPaneViewMode] = useState<PaneViewMode>('3d')
  const [twodStatus, setTwodStatus] = useState<'idle' | 'ok' | 'no-smiles' | 'invalid' | 'unavailable'>('idle')
  const [twodRawInput, setTwodRawInput] = useState('')
  const [twodNormalizedInput, setTwodNormalizedInput] = useState('')
  const [twodError, setTwodError] = useState('')

  const pickedRef = useRef<any[]>([])
  const pickLabelsRef = useRef<any[]>([])
  const atomLabelsRef = useRef<any[]>([])
  const line1Ref = useRef<any>(null)
  const line2Ref = useRef<any>(null)
  const resultLabelRef = useRef<any>(null)

  const requiredPicks = measureMode === 'distance' ? 2 : measureMode === 'angle' ? 3 : 0

  function clearMeasurement(reapplyBaseStyle: boolean) {
    const v = viewerRef.current
    pickedRef.current = []
    onMeasurementResult(null)

    if (!v) return

    try {
      for (const lbl of pickLabelsRef.current) v.removeLabel(lbl)
      pickLabelsRef.current = []

      if (line1Ref.current) v.removeShape(line1Ref.current)
      line1Ref.current = null

      if (line2Ref.current) v.removeShape(line2Ref.current)
      line2Ref.current = null

      if (resultLabelRef.current) v.removeLabel(resultLabelRef.current)
      resultLabelRef.current = null

      if (reapplyBaseStyle) applyStyle(v, styleMode, showHydrogens)

      v.render()
    } catch {
      // ignore
    }
  }

  function clearAtomLabels() {
    const v = viewerRef.current
    if (!v) return
    try {
      for (const lbl of atomLabelsRef.current) v.removeLabel(lbl)
      atomLabelsRef.current = []
    } catch {
      // ignore
    }
  }

  function labelTextForAtom(atom: any): string {
    if (labelMode === 'index') return String(typeof atom?.index === 'number' ? atom.index + 1 : atom?.serial ?? '?')
    if (labelMode === 'atomicNumber') {
      const elem = String(atom?.elem ?? '')
      return String(ELEMENT_TO_NUMBER[elem] ?? '?')
    }
    return String(atom?.elem ?? '?')
  }

  function syncAtomLabels() {
    const v = viewerRef.current
    if (!v) return
    clearAtomLabels()
    if (labelMode === 'off') return
    try {
      const model = v.getModel?.()
      const atoms = model?.selectedAtoms ? model.selectedAtoms({}) : []
      for (const atom of atoms || []) {
        if (!showHydrogens && atom?.elem === 'H') continue
        const txt = labelTextForAtom(atom)
        if (!txt) continue
        const lbl = v.addLabel(txt, {
          position: { x: atom.x, y: atom.y + 0.2, z: atom.z },
          backgroundColor: 'rgba(0,0,0,0.45)',
          fontColor: 'white',
          fontSize: 12,
          borderThickness: 0,
          inFront: true
        })
        atomLabelsRef.current.push(lbl)
      }
    } catch {
      // ignore
    }
  }

  function recolorPickedAtomIfAllowed(atom: any, color: number) {
    const v = viewerRef.current
    if (!v) return
    if (styleMode === 'sticks') return

    const selAtom =
      typeof atom?.serial === 'number'
        ? { serial: atom.serial }
        : typeof atom?.index === 'number'
          ? { index: atom.index }
          : null
    if (!selAtom) return

    try {
      if (styleMode === 'ballstick') {
        v.setStyle(selAtom, {
          stick: { radius: 0.15 },
          sphere: { scale: 0.23, color }
        })
      } else if (styleMode === 'spacefill') {
        v.setStyle(selAtom, {
          sphere: { scale: 1.0, color }
        })
      }
    } catch {
      // ignore
    }
  }

  function addPickLabel(atom: any) {
    const v = viewerRef.current
    if (!v) return
    const txt = atomLabel(atom)

    try {
      const lbl = v.addLabel(txt, {
        position: { x: atom.x, y: atom.y + 0.35, z: atom.z },
        backgroundColor: 'rgba(0,0,0,0.65)',
        fontColor: 'white',
        fontSize: 14,
        borderThickness: 0,
        inFront: true
      })
      pickLabelsRef.current.push(lbl)
    } catch {
      // ignore
    }
  }

  function addOrReplaceLine(which: 1 | 2, a: any, b: any) {
    const v = viewerRef.current
    if (!v) return

    const line = v.addLine({
      start: { x: a.x, y: a.y, z: a.z },
      end: { x: b.x, y: b.y, z: b.z },
      color: 0xffffff,
      linewidth: 3
    })

    if (which === 1) {
      if (line1Ref.current) v.removeShape(line1Ref.current)
      line1Ref.current = line
    } else {
      if (line2Ref.current) v.removeShape(line2Ref.current)
      line2Ref.current = line
    }
  }

  function setResultLabel(text: string, pos: { x: number; y: number; z: number }) {
    const v = viewerRef.current
    if (!v) return

    try {
      if (resultLabelRef.current) v.removeLabel(resultLabelRef.current)
      resultLabelRef.current = v.addLabel(text, {
        position: pos,
        backgroundColor: 'rgba(0,0,0,0.70)',
        fontColor: 'white',
        fontSize: 14,
        borderThickness: 0,
        inFront: true
      })
    } catch {
      // ignore
    }
  }

  function finalizeDistance(a: any, b: any) {
    const v = viewerRef.current
    if (!v) return

    const d = distÅ(a, b)
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
    const txt = `${d.toFixed(3)} Å`

    addOrReplaceLine(1, a, b)
    setResultLabel(txt, mid)
    onMeasurementResult(txt)

    try {
      v.render()
    } catch {
      // ignore
    }
  }

  function finalizeAngle(a: any, b: any, c: any) {
    const v = viewerRef.current
    if (!v) return

    const ang = angleDeg(a, b, c)
    const txt = Number.isFinite(ang) ? `${ang.toFixed(2)}°` : 'NaN'

    addOrReplaceLine(1, a, b)
    addOrReplaceLine(2, b, c)

    const pos = angleLabelPosition(a, b, c, 0.9)
    setResultLabel(txt, pos)
    onMeasurementResult(txt)

    try {
      v.render()
    } catch {
      // ignore
    }
  }

  function onAtomClicked(atom: any) {
    const v = viewerRef.current
    if (!v) return
    if (measureMode === 'off') return

    if (pickedRef.current.length >= requiredPicks) {
      clearMeasurement(true)
    }

    if (pickedRef.current.length > 0) {
      const prev = pickedRef.current[pickedRef.current.length - 1]
      const prevN = atomNumber(prev)
      const curN = atomNumber(atom)
      if (prevN != null && curN != null && prevN === curN) return
    }

    pickedRef.current = [...pickedRef.current, atom]

    const pickIdx = pickedRef.current.length
    const color = pickIdx === 1 ? 0x00ffff : pickIdx === 2 ? 0xff00ff : 0xffff00
    recolorPickedAtomIfAllowed(atom, color)
    addPickLabel(atom)

    if (measureMode === 'distance' && pickedRef.current.length === 2) {
      finalizeDistance(pickedRef.current[0], pickedRef.current[1])
      return
    }

    if (measureMode === 'angle' && pickedRef.current.length === 3) {
      finalizeAngle(pickedRef.current[0], pickedRef.current[1], pickedRef.current[2])
      return
    }

    try {
      v.render()
    } catch {
      // ignore
    }
  }

  function syncPicking() {
    const v = viewerRef.current
    if (!v) return
    const enabled = measureMode !== 'off'

    try {
      v.setClickable(
        {},
        enabled,
        (atom: any) => {
          if (!enabled) return
          onAtomClicked(atom)
        }
      )
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!hostRef.current) return

    const $3Dmol = (window as any).$3Dmol
    if (!$3Dmol) return

    const v =
      typeof $3Dmol.createViewer === 'function'
        ? $3Dmol.createViewer(hostRef.current, { backgroundColor: hexTo3DmolColor(backgroundColor) })
        : new $3Dmol.GLViewer(hostRef.current, { backgroundColor: hexTo3DmolColor(backgroundColor) })

    viewerRef.current = v

    const ro = new ResizeObserver(() => {
      try {
        v.resize()
        v.render()
      } catch {
        // ignore
      }
    })
    ro.observe(hostRef.current)

    return () => {
      try {
        ro.disconnect()
        clearAtomLabels()
      } catch {
        // ignore
      }
      viewerRef.current = null
    }
  }, [])

  useEffect(() => {
    const v = viewerRef.current
    if (!v) return

    let cancelled = false

    ;(async () => {
      if (!moleculeId) {
        try {
          v.clear()
          v.render()
        } catch {
          // ignore
        }
        clearMeasurement(false)
        return
      }

      setLoading(true)
      try {
        const xyz = await getXYZ(moleculeId, source)
        if (cancelled) return

        v.clear()
        v.addModel(xyz, 'xyz')

        applyStyle(v, styleMode, showHydrogens)
        syncAtomLabels()
        clearMeasurement(false)

        v.zoomTo()
        v.render()

        syncPicking()
      } catch (e) {
        try {
          v.clear()
          v.render()
        } catch {
          // ignore
        }
        console.error('Failed to load XYZ for viewer:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [moleculeId, source])

  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    try {
      applyStyle(v, styleMode, showHydrogens)
      syncAtomLabels()
      if (pickedRef.current.length > 0) clearMeasurement(false)
      v.render()
    } catch {
      // ignore
    }
  }, [styleMode, showHydrogens, labelMode])

  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    try {
      v.setBackgroundColor(hexTo3DmolColor(backgroundColor))
      v.render()
    } catch {
      // ignore
    }
  }, [backgroundColor])

  useEffect(() => {
    syncPicking()
    clearMeasurement(true)
  }, [measureMode])

  useEffect(() => {
    clearMeasurement(true)
  }, [clearSignal])

  const draw2D = () => {
    const host = canvas2dHostRef.current
    const svgHost = svg2dRef.current
    if (!host || !svgHost) {
      setTwodStatus('unavailable')
      return
    }
    setTwodError('')

    const rect = host.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    svgHost.innerHTML = ''

    const smi = typeof smiles === 'string' ? normalizeSmiles(smiles) : ''
    setTwodRawInput(typeof smiles === 'string' ? smiles : '')
    setTwodNormalizedInput(smi)
    if (!smi || smi.toLowerCase() === 'nan') {
      setTwodStatus('no-smiles')
      return
    }

    try {
      const mol = OCL.Molecule.fromSmiles(smi)
      const svg = mol.toSVG(width, height, '', {
        suppressChiralText: true,
        suppressCIPParity: true
      })
      svgHost.innerHTML = svg
      setTwodStatus('ok')
      setTwodError('')
    } catch (err: any) {
      setTwodStatus('invalid')
      setTwodError(String(err?.message ?? err ?? 'depiction failed'))
    }
  }

  useEffect(() => {
    if (paneViewMode !== '2d') return
    draw2D()
  }, [paneViewMode, smiles, moleculeId])

  useEffect(() => {
    const host = canvas2dHostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => {
      if (paneViewMode === '2d') draw2D()
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [paneViewMode, smiles, moleculeId])

  useEffect(() => {
    if (paneViewMode !== '3d') return
    const v = viewerRef.current
    if (!v) return
    try {
      v.resize()
      v.render()
    } catch {
      // ignore
    }
  }, [paneViewMode])

  async function exportPanePng() {
    const idPart = moleculeId || label.replace(/\s+/g, '_').toLowerCase()
    if (paneViewMode === 'data') {
      onExportError('PNG export is unavailable in Data view. Switch to 2D or 3D.')
      return
    }
    if (paneViewMode === '3d') {
      await export3dPngFallback(idPart)
      return
    }

    const svgHost = svg2dRef.current
    const canvasHost = canvas2dHostRef.current
    const svg = svgHost?.querySelector('svg')
    if (!svg || !canvasHost) {
      onExportError('2D molecule image is not available for export.')
      return
    }

    const rect = canvasHost.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width))
    const height = Math.max(1, Math.round(rect.height))
    const scale = 3

    try {
      const svgText = new XMLSerializer().serializeToString(svg)
      const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = reject
        el.src = url
      })
      const out = document.createElement('canvas')
      out.width = width * scale
      out.height = height * scale
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('Unable to create canvas context')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, out.width, out.height)
      ctx.drawImage(img, 0, 0, out.width, out.height)
      URL.revokeObjectURL(url)

      const a = document.createElement('a')
      a.href = out.toDataURL('image/png')
      a.download = `molecule_2d_${idPart}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err: any) {
      onExportError(`Failed to export 2D PNG: ${err?.message || String(err)}`)
    }
  }

  async function export3dPngFallback(idPart: string) {
    const host = hostRef.current
    if (!host) {
      onExportError('3D viewer is not ready for export.')
      return
    }
    try {
      await exportHostCanvasesToPng({
        host,
        filename: `molecule_3d_${idPart}.png`,
        scale: 3,
        background: backgroundColor,
      })
    } catch (err: any) {
      onExportError(`Failed to export 3D PNG: ${err?.message || String(err)}`)
    }
  }

  async function download3dSvgWithFallback() {
    const idPart = moleculeId || label.replace(/\s+/g, '_').toLowerCase()
    if (!moleculeId) {
      onExportError('Select a molecule before exporting 3D SVG.')
      return
    }

    try {
      const sourceBase =
        source && source.mode === 'base' && typeof source.baseUrl === 'string'
          ? source.baseUrl.replace(/\/$/, '').replace(/\/xyz$/i, '')
          : ''
      const apiBase = sourceBase || BACKEND
      const url = `${apiBase}/render3d/${encodeURIComponent(moleculeId)}.svg`
      const res = await fetch(url)
      if (!res.ok) {
        if (res.status === 404) {
          try {
            const xyz = await getXYZ(moleculeId, source)
            const res2 = await fetch(`${apiBase}/render3d/from-xyz.svg`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mol_id: moleculeId, xyz }),
            })
            if (res2.ok) {
              const blob2 = await res2.blob()
              const svgText2 = await blob2.text()
              if (!svgText2.slice(0, 4096).toLowerCase().includes('<svg')) {
                onExportError('xyzrender returned invalid SVG output. Using 3D PNG fallback.')
                await export3dPngFallback(idPart)
                return
              }
              const checkedBlob2 = new Blob([svgText2], { type: 'image/svg+xml' })
              const blobUrl2 = URL.createObjectURL(checkedBlob2)
              const a2 = document.createElement('a')
              a2.href = blobUrl2
              a2.download = `molecule_3d_${idPart}.svg`
              document.body.appendChild(a2)
              a2.click()
              a2.remove()
              URL.revokeObjectURL(blobUrl2)
              return
            }
          } catch {
            // continue to normal warning + PNG fallback
          }
        }
        let warn = `xyzrender SVG export failed (HTTP ${res.status}) at ${url}.`
        try {
          const payload = await res.json()
          const detail = typeof payload?.detail === 'string' ? payload.detail : ''
          const code = typeof payload?.code === 'string' ? payload.code : ''
          const message = typeof payload?.message === 'string' ? payload.message : ''
          if (detail) warn = `${detail}. Using 3D PNG fallback.`
          else if (code === 'XYZRENDER_MISSING') warn = 'xyzrender is not installed on backend; using 3D PNG fallback.'
          else if (message) warn = `xyzrender failed: ${message}. Using 3D PNG fallback.`
          else warn = `${warn} Using 3D PNG fallback.`
        } catch {
          warn = `${warn} Using 3D PNG fallback.`
        }
        onExportError(warn)
        await export3dPngFallback(idPart)
        return
      }

      const blob = await res.blob()
      const svgText = await blob.text()
      if (!svgText.slice(0, 4096).toLowerCase().includes('<svg')) {
        onExportError('xyzrender returned invalid SVG output. Using 3D PNG fallback.')
        await export3dPngFallback(idPart)
        return
      }
      const checkedBlob = new Blob([svgText], { type: 'image/svg+xml' })
      const blobUrl = URL.createObjectURL(checkedBlob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `molecule_3d_${idPart}.svg`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(blobUrl)
    } catch (err: any) {
      onExportError(`xyzrender SVG export failed: ${err?.message || String(err)}. Using 3D PNG fallback.`)
      await export3dPngFallback(idPart)
    }
  }

  return (
    <div className={`viewer-pane ${isActive ? 'viewer-pane-active' : ''}`}>
      <div
        className={`viewer-pane-tab ${isActive ? 'viewer-pane-tab-active' : ''}`}
        onClick={onActivate}
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') onActivate()
        }}
      >
        <button
          type="button"
          className="legend"
          style={{ padding: '1px 6px', cursor: 'pointer' }}
          onClick={e => {
            e.stopPropagation()
            setPaneViewMode('3d')
          }}
          aria-label="Switch to 3D pane view"
        >
          3D
        </button>
        <button
          type="button"
          className="legend"
          style={{ padding: '1px 6px', cursor: 'pointer' }}
          onClick={e => {
            e.stopPropagation()
            setPaneViewMode('2d')
          }}
          aria-label="Switch to 2D pane view"
        >
          2D
        </button>
        <button
          type="button"
          className="legend"
          style={{ padding: '1px 6px', cursor: 'pointer' }}
          onClick={e => {
            e.stopPropagation()
            setPaneViewMode('data')
          }}
          aria-label="Switch to data pane view"
        >
          Data
        </button>
        <button
          type="button"
          className="btn-icon"
          onClick={e => {
            e.stopPropagation()
            void download3dSvgWithFallback()
          }}
          title="Download 3D SVG (xyzrender)"
          aria-label="Download 3D SVG (xyzrender)"
          style={{ width: 22, height: 22, padding: 0 }}
        >
          <Download size={13} />
        </button>
        <button
          type="button"
          className="btn-icon"
          onClick={e => {
            e.stopPropagation()
            exportPanePng()
          }}
          title="Download PNG"
          aria-label="Download PNG"
          style={{ width: 22, height: 22, padding: 0 }}
        >
          <Download size={13} />
        </button>
        <span className="viewer-pane-id">{moleculeId ?? 'Empty'}</span>
      </div>

      {paneViewMode === 'data' && (
        <div className="viewer-data-panel">
          {rowDetails.length === 0 ? (
            <div className="legend viewer-data-empty">
              No molecule data available for this pane.
            </div>
          ) : (
            <div className="viewer-data-table-wrap">
              <table className="viewer-data-table">
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rowDetails.map((row) => (
                    <tr key={row.key}>
                      <td>{row.key}</td>
                      <td title={row.value}>{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div
        className="viewer-pane-canvas"
        style={{ flex: 1, minHeight: 0, display: paneViewMode === '3d' ? 'block' : 'none' }}
      >
        <div
          className="viewer-host"
          ref={hostRef}
          style={{ height: '100%' }}
        />
      </div>
      <div
        ref={canvas2dHostRef}
        className="viewer-pane-canvas"
        style={{ flex: 1, minHeight: 0, display: paneViewMode === '2d' ? 'block' : 'none', background: '#fff' }}
      >
        <div ref={svg2dRef} className="viewer-2d-canvas" />
        {paneViewMode === '2d' && twodStatus !== 'ok' && (
          <div className="legend" style={{ position: 'absolute', left: 8, bottom: 8, maxWidth: 'calc(100% - 16px)', background: 'rgba(255,255,255,0.95)', padding: '4px 6px', borderRadius: 4, color: '#334155' }}>
            <div>
              {twodStatus === 'no-smiles' ? 'No SMILES for this entry' : twodStatus === 'invalid' ? 'SMILES not renderable' : '2D renderer unavailable'}
            </div>
            <div style={{ marginTop: 2, wordBreak: 'break-all' }}><b>raw:</b> {twodRawInput || '(empty)'}</div>
            <div style={{ marginTop: 2, wordBreak: 'break-all' }}><b>normalized:</b> {twodNormalizedInput || '(empty)'}</div>
            {twodError ? <div style={{ marginTop: 2, wordBreak: 'break-all' }}><b>error:</b> {twodError}</div> : null}
          </div>
        )}
      </div>

      {!moleculeId && <div className="legend viewer-pane-hint">Select a molecule for this pane.</div>}
      {loading && <div className="legend viewer-pane-hint">Loading…</div>}
    </div>
  )
}

function getGridClass(splitCount: SplitCount) {
  if (splitCount === 1) return 'viewer-split-1'
  if (splitCount === 2) return 'viewer-split-2'
  if (splitCount === 3) return 'viewer-split-3'
  if (splitCount === 4) return 'viewer-split-4'
  if (splitCount === 5) return 'viewer-split-5'
  if (splitCount >= 7) return 'viewer-split-9'
  return 'viewer-split-6'
}

export default function MoleculeViewer() {
  const source = useStore(s => s.source)
  const ds = useStore(s => s.dataset)
  const picked = useStore(s => s.pickedIndices)
  const displayedPicked = useStore(s => s.displayedPickedIndices)
  const setDisplayedPickedIndices = useStore(s => s.setDisplayedPickedIndices)
  const setActiveViewerPane = useStore(s => s.setActiveViewerPane)
  const pushToast = useUIStore(s => s.pushToast)
  const theme = useUIStore(s => s.theme)

  const [splitCount, setSplitCount] = useState<SplitCount>(1)
  const [activePane, setActivePane] = useState(0)
  const [styleMode, setStyleMode] = useState<StyleMode>('ballstick')
  const [showHydrogens, setShowHydrogens] = useState(true)
  const [labelMode, setLabelMode] = useState<AtomLabelMode>('off')
  const [bgUserCustomized, setBgUserCustomized] = useState(false)
  const [backgroundColor, setBackgroundColor] = useState(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#0b0d10'
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [measureMode, setMeasureMode] = useState<MeasureMode>('off')
  const [measurementText, setMeasurementText] = useState<string | null>(null)
  const [clearSignal, setClearSignal] = useState(0)
  const [smilesColumn, setSmilesColumn] = useState('')
  const [smilesColumnTouched, setSmilesColumnTouched] = useState(false)

  useEffect(() => {
    if (bgUserCustomized) return
    const c = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim()
    if (c) setBackgroundColor(c)
  }, [theme, bgUserCustomized])

  const [paneIds, setPaneIds] = useState<(string | null)[]>([null])
  const pickedRecent = useMemo(() => {
    const out: number[] = []
    for (let i = picked.length - 1; i >= 0; i--) out.push(picked[i])
    return out
  }, [picked])
  const defaultDisplay = useMemo(() => pickedRecent.slice(0, 9), [pickedRecent])
  const displaySelection = useMemo(
    () => (displayedPicked.length > 0 ? Array.from(displayedPicked) : defaultDisplay),
    [displayedPicked, defaultDisplay]
  )
  const pickedIds = useMemo(() => {
    if (!ds) return []
    const out: string[] = []
    for (const idx of pickedRecent) {
      if (idx >= 0 && idx < ds.ids.length) out.push(ds.ids[idx])
    }
    return out
  }, [pickedRecent, ds])
  const displayIds = useMemo(() => {
    if (!ds) return []
    const out: string[] = []
    for (const idx of displaySelection) {
      if (idx >= 0 && idx < ds.ids.length) out.push(ds.ids[idx])
    }
    return out
  }, [displaySelection, ds])
  const displaySet = useMemo(() => new Set(displaySelection), [displaySelection])
  const columnNames = useMemo(() => {
    if (!ds) return []
    return ds.columnOrder ?? Object.keys(ds.columns)
  }, [ds])

  useEffect(() => {
    if (!ds) {
      setSmilesColumn('')
      setSmilesColumnTouched(false)
      return
    }
    const preferred = ['smiles', 'SMILES', 'sm'].find(c => Object.prototype.hasOwnProperty.call(ds.columns, c)) ?? ''
    const exists = smilesColumn && Object.prototype.hasOwnProperty.call(ds.columns, smilesColumn)
    if (!smilesColumnTouched || !exists) setSmilesColumn(preferred)
  }, [ds, smilesColumnTouched, smilesColumn])

  const idToIndex = useMemo(() => {
    const map = new Map<string, number>()
    if (!ds) return map
    for (let i = 0; i < ds.ids.length; i++) map.set(ds.ids[i], i)
    return map
  }, [ds])

  const paneSmiles = useMemo(() => {
    if (!ds || !smilesColumn) return paneIds.map(() => null)
    const col = ds.columns[smilesColumn]
    if (!col) return paneIds.map(() => null)
    return paneIds.map(id => {
      if (!id) return null
      const row = idToIndex.get(id)
      if (row == null) return null
      const raw = (col as any)[row]
      if (typeof raw !== 'string') return null
      const txt = raw.trim()
      if (!txt || txt.toLowerCase() === 'nan') return null
      return txt
    })
  }, [ds, smilesColumn, paneIds, idToIndex])

  const paneRowDetails = useMemo(() => {
    function toDisplayString(value: unknown): string {
      if (value == null) return '—'
      if (typeof value === 'number') return Number.isNaN(value) ? '—' : String(value)
      if (typeof value === 'string') {
        const trimmed = value.trim()
        return !trimmed || trimmed.toLowerCase() === 'nan' ? '—' : value
      }
      if (typeof value === 'bigint' || typeof value === 'boolean') return String(value)
      return '—'
    }

    if (!ds) return paneIds.map((): RowDetail[] => [])
    const orderedColumns = ds.columnOrder ?? Object.keys(ds.columns)
    return paneIds.map((id): RowDetail[] => {
      if (!id) return []
      const row = idToIndex.get(id)
      if (row == null) return []
      const details: RowDetail[] = [{ key: 'id', value: id }]
      for (const columnName of orderedColumns) {
        const column = (ds.columns as Record<string, ArrayLike<unknown> | undefined>)[columnName]
        const cell = column && typeof column.length === 'number' ? column[row] : undefined
        details.push({ key: columnName, value: toDisplayString(cell) })
      }
      return details
    })
  }, [ds, paneIds, idToIndex])

  useEffect(() => {
    setPaneIds(prev => {
      const next = Array.from({ length: splitCount }, (_, i) => prev[i] ?? null)
      return next
    })
    setActivePane(prev => Math.min(prev, splitCount - 1))
    setMeasurementText(null)
  }, [splitCount])

  useEffect(() => {
    setPaneIds(prev => {
      const next = Array.from({ length: splitCount }, (_, i) => prev[i] ?? null)
      for (let i = 0; i < splitCount; i++) {
        next[i] = displayIds[i] ?? null
      }
      return next
    })
  }, [displayIds, splitCount])

  useEffect(() => {
    if (displayedPicked.length === 0) return
    const pickedSet = new Set<number>()
    for (let i = 0; i < picked.length; i++) pickedSet.add(picked[i])
    const next: number[] = []
    for (let i = 0; i < displayedPicked.length; i++) {
      const v = displayedPicked[i]
      if (pickedSet.has(v)) next.push(v)
    }
    if (next.length !== displayedPicked.length) {
      setDisplayedPickedIndices(new Int32Array(next))
    }
  }, [picked, displayedPicked, setDisplayedPickedIndices])

  const helperText =
    measureMode === 'distance'
      ? 'Click 2 atoms in any pane to measure distance.'
      : measureMode === 'angle'
        ? 'Click 3 atoms in any pane to measure angle (at the 2nd atom).'
        : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="card-title card-drag-handle" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} onMouseDown={e => { if ((e.target as HTMLElement).closest('select,button,input')) e.stopPropagation() }}>
        <div style={{ flex: 1, minWidth: 120 }}>3D Viewer</div>

        <label className="legend row gap-sm">
          <span>SMILES</span>
          <select
            value={smilesColumn}
            onChange={e => {
              setSmilesColumnTouched(true)
              setSmilesColumn(e.target.value)
            }}
            style={{ padding: '2px 6px' }}
            aria-label="SMILES column"
          >
            <option value="">Select column</option>
            {columnNames.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>

        <label className="legend row gap-sm">
          <span>Split</span>
          <select
            value={splitCount}
            onChange={e => setSplitCount(Number(e.target.value) as SplitCount)}
            style={{ padding: '2px 6px' }}
            aria-label="Viewer split count"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
            <option value={5}>5</option>
            <option value={6}>6</option>
            <option value={7}>7</option>
            <option value={8}>8</option>
            <option value={9}>9</option>
          </select>
        </label>

        <label className="legend row gap-sm">
          <span>Measure</span>
          <select
            value={measureMode}
            onChange={e => setMeasureMode(e.target.value as MeasureMode)}
            style={{ padding: '2px 6px' }}
            aria-label="Measurement mode"
          >
            <option value="off">Off</option>
            <option value="distance">Distance</option>
            <option value="angle">Angle</option>
          </select>
        </label>

        {measureMode !== 'off' && (
          <button
            type="button"
            onClick={() => {
              setMeasurementText(null)
              setClearSignal(v => v + 1)
            }}
            className="legend"
            style={{ padding: '2px 6px', cursor: 'pointer' }}
            aria-label="Clear measurement"
          >
            Clear
          </button>
        )}
        <button
          type="button"
          className="btn-icon"
          onClick={() => setSettingsOpen(true)}
          title="Viewer settings"
          aria-label="Viewer settings"
          style={{ width: 24, height: 24, padding: 0 }}
        >
          <Settings size={14} />
        </button>
      </div>

      {settingsOpen && (
        <div className="modal-overlay" onMouseDown={() => setSettingsOpen(false)}>
          <div className="modal-card scatter-settings-modal" onMouseDown={e => e.stopPropagation()}>
            <div className="scatter-settings-header">
              <div className="modal-title" style={{ marginBottom: 0 }}>3D Viewer Settings</div>
              <button type="button" className="btn-icon" onClick={() => setSettingsOpen(false)} aria-label="Close settings" title="Close">
                <X size={16} />
              </button>
            </div>
            <div className="scatter-settings-grid">
              <section className="scatter-settings-section">
                <h3>Style</h3>
                <label className="setting-row">
                  <span>Render style</span>
                  <select value={styleMode} onChange={e => setStyleMode(e.target.value as StyleMode)}>
                    <option value="ballstick">Ball + stick</option>
                    <option value="sticks">Sticks</option>
                    <option value="spacefill">Spacefill</option>
                  </select>
                </label>
                <label className="setting-check">
                  <input type="checkbox" checked={showHydrogens} onChange={e => setShowHydrogens(e.target.checked)} />
                  <span>Show hydrogens</span>
                </label>
              </section>
              <section className="scatter-settings-section">
                <h3>Labels</h3>
                <label className="setting-row">
                  <span>Atom labels</span>
                  <select value={labelMode} onChange={e => setLabelMode(e.target.value as AtomLabelMode)}>
                    <option value="off">Off</option>
                    <option value="index">Atomic index</option>
                    <option value="atomicNumber">Atomic number</option>
                    <option value="element">Atomic type</option>
                  </select>
                </label>
              </section>
              <section className="scatter-settings-section">
                <h3>Graphical View</h3>
                <label className="setting-row">
                  <span>Background</span>
                  <input type="color" value={backgroundColor} onChange={e => { setBgUserCustomized(true); setBackgroundColor(e.target.value) }} />
                </label>
              </section>
            </div>
          </div>
        </div>
      )}

      {helperText && (
        <div className="legend" style={{ paddingTop: 6 }}>
          {helperText}
          {measurementText ? <span style={{ marginLeft: 10 }}><b>{measurementText}</b></span> : null}
        </div>
      )}

      {pickedRecent.length > 0 && (
        <div style={{ paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="row gap-sm" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="legend">
              {pickedRecent.length} molecule{pickedRecent.length !== 1 ? 's' : ''} — showing {displayIds.length}
            </span>
            <button
              type="button"
              className="legend"
              style={{ padding: '1px 6px', cursor: 'pointer' }}
              onClick={() => setDisplayedPickedIndices(new Int32Array(pickedRecent.slice(0, 9)))}
            >
              All
            </button>
            <button
              type="button"
              className="legend"
              style={{ padding: '1px 6px', cursor: 'pointer' }}
              onClick={() => setDisplayedPickedIndices(new Int32Array(0))}
            >
              Reset
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 72, overflowY: 'auto' }}>
            {pickedRecent.map((idx, i) => {
              const label = pickedIds[i] ?? `#${idx}`
              const active = displaySet.has(idx)
              return (
                <button
                  key={idx}
                  type="button"
                  className="legend"
                  style={{
                    padding: '2px 8px',
                    borderRadius: 12,
                    cursor: 'pointer',
                    border: '1px solid',
                    borderColor: active ? 'var(--color-accent)' : 'var(--color-border)',
                    background: active ? 'var(--color-accent-soft)' : 'transparent',
                    color: 'var(--color-text)',
                    opacity: active ? 1 : 0.55,
                  }}
                  onClick={() => {
                    const next = new Set(displaySelection)
                    if (active) next.delete(idx)
                    else next.add(idx)
                    setDisplayedPickedIndices(new Int32Array(Array.from(next)))
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className={`viewer-split-grid ${getGridClass(splitCount)}`} style={{ flex: 1, minHeight: 0 }}>
        {paneIds.map((moleculeId, idx) => (
          <MoleculePane
            key={idx}
            moleculeId={moleculeId}
            smiles={paneSmiles[idx]}
            rowDetails={paneRowDetails[idx] ?? []}
            source={source}
            styleMode={styleMode}
            showHydrogens={showHydrogens}
            labelMode={labelMode}
            backgroundColor={backgroundColor}
            measureMode={measureMode}
            isActive={idx === activePane}
            label={`Pane ${idx + 1}`}
            onActivate={() => { setActivePane(idx); setActiveViewerPane(idx) }}
            clearSignal={clearSignal}
            onMeasurementResult={text => {
              if (idx === activePane) setMeasurementText(text)
            }}
            onExportError={(text) => pushToast(text, 'warning')}
          />
        ))}
      </div>

      {displayIds.length === 0 && (
        <div className="legend" style={{ paddingTop: 6 }}>
          Ctrl+click points or table rows to select molecules for 3D display.
        </div>
      )}
    </div>
  )
}
