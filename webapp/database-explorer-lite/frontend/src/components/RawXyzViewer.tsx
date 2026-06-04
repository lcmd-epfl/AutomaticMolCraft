import React, { useEffect, useRef } from 'react'

type RawXyzViewerProps = {
  xyz: string
  styleMode?: 'ballstick' | 'sticks' | 'spacefill'
  showHydrogens?: boolean
  backgroundColor?: string
  selectedAtomIndices?: number[]
  onToggleAtomIndex?: (index: number) => void
}

function hexTo3DmolColor(hex: string) {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : '0b0d10'
  return Number.parseInt(clean, 16)
}

function applyStyle(viewer: any, mode: string, showHydrogens: boolean) {
  viewer.setStyle({}, {})
  const sel = showHydrogens ? {} : { not: { elem: 'H' } }
  if (mode === 'sticks') {
    viewer.setStyle(sel, { stick: { radius: 0.2 } })
  } else if (mode === 'spacefill') {
    viewer.setStyle(sel, { sphere: { scale: 1.0 } })
  } else {
    viewer.setStyle(sel, { stick: { radius: 0.15 }, sphere: { scale: 0.23 } })
  }
}

export default function RawXyzViewer({
  xyz,
  styleMode = 'ballstick',
  showHydrogens = true,
  backgroundColor = '#0b0d10',
  selectedAtomIndices = [],
  onToggleAtomIndex,
}: RawXyzViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<any>(null)

  useEffect(() => {
    if (!hostRef.current) return
    const $3Dmol = (window as any).$3Dmol
    if (!$3Dmol) return

    const viewer =
      typeof $3Dmol.createViewer === 'function'
        ? $3Dmol.createViewer(hostRef.current, { backgroundColor: hexTo3DmolColor(backgroundColor) })
        : new $3Dmol.GLViewer(hostRef.current, { backgroundColor: hexTo3DmolColor(backgroundColor) })

    viewerRef.current = viewer
    const ro = new ResizeObserver(() => {
      try {
        viewer.resize()
        viewer.render()
      } catch {
        // ignore render cleanup races
      }
    })
    ro.observe(hostRef.current)

    return () => {
      ro.disconnect()
      try {
        viewer.clear()
        hostRef.current?.replaceChildren()
      } catch {
        // ignore viewer teardown races
      }
      viewerRef.current = null
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    try {
      viewer.setBackgroundColor(hexTo3DmolColor(backgroundColor))
      viewer.clear()
      if (xyz.trim()) {
        const model = viewer.addModel(xyz, 'xyz')
        applyStyle(viewer, styleMode, showHydrogens)
        if (selectedAtomIndices.length) {
          selectedAtomIndices.forEach(idx => {
            viewer.addStyle({ model: model.getID(), index: idx }, { sphere: { color: 'yellow', scale: 0.42 } })
          })
        }
        if (onToggleAtomIndex) {
          viewer.setClickable({}, true, (atom: any) => {
            const idx = Number.isFinite(Number(atom?.index))
              ? Number(atom.index)
              : Number(atom?.serial) - 1
            if (Number.isFinite(idx)) onToggleAtomIndex(idx)
          })
        }
        viewer.zoomTo()
      }
      viewer.render()
    } catch (err) {
      console.error('Failed to render generated XYZ:', err)
    }
  }, [xyz, styleMode, showHydrogens, backgroundColor, selectedAtomIndices, onToggleAtomIndex])

  return <div ref={hostRef} className="raw-xyz-viewer" />
}
