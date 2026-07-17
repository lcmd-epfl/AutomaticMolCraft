export async function exportHostCanvasesToPng(options: {
  host: HTMLElement
  filename: string
  scale?: number
  background?: string
}) {
  const { host, filename, scale = 3, background } = options
  const rect = host.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))

  const sourceCanvases = Array.from(host.querySelectorAll('canvas')) as HTMLCanvasElement[]
  if (!sourceCanvases.length) throw new Error('No canvas found to export')

  const out = document.createElement('canvas')
  out.width = width * scale
  out.height = height * scale
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('Unable to create output context')

  const bg = background || getComputedStyle(host).backgroundColor || '#0f141a'
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, out.width, out.height)

  for (const c of sourceCanvases) {
    if (c.width <= 0 || c.height <= 0) continue
    const cRect = c.getBoundingClientRect()
    const dx = (cRect.left - rect.left) * scale
    const dy = (cRect.top - rect.top) * scale
    const dw = cRect.width * scale
    const dh = cRect.height * scale
    ctx.drawImage(c, dx, dy, dw, dh)
  }

  drawAxisOverlay({ host, ctx, rect, scale })
  drawColorbarOverlay({ host, ctx, rect, scale })

  // toBlob avoids the giant base64 data-URL string of toDataURL.
  // Note: WebGL source canvases may capture blank unless created with
  // preserveDrawingBuffer (drawImage above reads their front buffer).
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Unable to encode PNG')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.png') ? filename : `${filename}.png`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function drawAxisOverlay(options: {
  host: HTMLElement
  ctx: CanvasRenderingContext2D
  rect: DOMRect
  scale: number
}) {
  const { host, ctx, rect, scale } = options
  const axisOverlays = Array.from(host.querySelectorAll('.axis-overlay')) as HTMLElement[]
  for (const overlay of axisOverlays) {
    const tickLines = Array.from(overlay.querySelectorAll('.tick-line')) as HTMLElement[]
    for (const t of tickLines) {
      const r = t.getBoundingClientRect()
      ctx.fillStyle = '#283d55'
      ctx.globalAlpha = 0.8
      ctx.fillRect((r.left - rect.left) * scale, (r.top - rect.top) * scale, Math.max(1, r.width * scale), Math.max(1, r.height * scale))
      ctx.globalAlpha = 1
    }

    const labels = Array.from(overlay.querySelectorAll('.tick-label, .axis-title')) as HTMLElement[]
    for (const el of labels) {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      const txt = (el.dataset.exportLabel || el.textContent || '').trim()
      if (!txt) continue
      const fontSize = Math.max(8, Number.parseFloat(style.fontSize || '10'))
      const fontFamily = style.fontFamily || 'monospace'
      const fontWeight = style.fontWeight || '400'
      ctx.fillStyle = style.color || '#c5cfdb'
      ctx.font = `${fontWeight} ${fontSize * scale}px ${fontFamily}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(txt, (r.left - rect.left) * scale, (r.top - rect.top) * scale)
    }
  }
}

function drawColorbarOverlay(options: {
  host: HTMLElement
  ctx: CanvasRenderingContext2D
  rect: DOMRect
  scale: number
}) {
  const { host, ctx, rect, scale } = options
  const bars = Array.from(host.querySelectorAll('.scatter-colorbar')) as HTMLElement[]
  for (const bar of bars) {
    const barRect = bar.getBoundingClientRect()
    const bx = (barRect.left - rect.left) * scale
    const by = (barRect.top - rect.top) * scale
    const bw = barRect.width * scale
    const bh = barRect.height * scale

    // background panel
    const bgStyle = getComputedStyle(bar)
    ctx.fillStyle = bgStyle.backgroundColor || 'rgba(12,15,22,0.9)'
    ctx.strokeStyle = bgStyle.borderTopColor || 'rgba(255,255,255,0.15)'
    ctx.lineWidth = Math.max(1, scale * 0.5)
    ctx.fillRect(bx, by, bw, bh)
    ctx.strokeRect(bx, by, bw, bh)

    // continuous gradient ramp — read stops from data attribute (avoids CSS background parsing)
    const ramp = bar.querySelector('.scatter-colorbar-ramp') as HTMLElement | null
    if (ramp) {
      const rr = ramp.getBoundingClientRect()
      const rx = (rr.left - rect.left) * scale
      const ry = (rr.top - rect.top) * scale
      const rw = rr.width * scale
      const rh = rr.height * scale
      const grad = ctx.createLinearGradient(rx, ry + rh, rx, ry)
      const stopsAttr = ramp.dataset.exportStops
      if (stopsAttr) {
        const stops = stopsAttr.split(';').map(s => s.split(',').map(Number))
        const n = stops.length
        for (let i = 0; i < n; i++) {
          const [r2, g, b] = stops[i]
          grad.addColorStop(i / Math.max(1, n - 1), `rgb(${r2},${g},${b})`)
        }
      } else {
        // fallback: parse inline/computed CSS
        const cssGrad = ramp.style.backgroundImage || ramp.style.background
          || getComputedStyle(ramp).backgroundImage || getComputedStyle(ramp).background
        const parsed = parseGradientStops(cssGrad)
        if (parsed.length > 0) {
          for (const s of parsed) grad.addColorStop(s.pct, s.color)
        } else {
          grad.addColorStop(0, '#274382')
          grad.addColorStop(0.33, '#2296aa')
          grad.addColorStop(0.66, '#50be7d')
          grad.addColorStop(1, '#f5ca50')
        }
      }
      ctx.fillStyle = grad
      ctx.fillRect(rx, ry, rw, rh)
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = Math.max(1, scale * 0.5)
      ctx.strokeRect(rx, ry, rw, rh)
    }

    // categorical swatches
    const swatches = Array.from(bar.querySelectorAll('.scatter-colorbar-swatch')) as HTMLElement[]
    for (const swatch of swatches) {
      const sr = swatch.getBoundingClientRect()
      const sx = (sr.left - rect.left) * scale
      const sy = (sr.top - rect.top) * scale
      const sw = sr.width * scale
      const sh = sr.height * scale
      const colorAttr = swatch.dataset.exportColor
      if (colorAttr) {
        const [r2, g, b, a] = colorAttr.split(',').map(Number)
        ctx.fillStyle = `rgba(${r2},${g},${b},${a / 255})`
      } else {
        ctx.fillStyle = getComputedStyle(swatch).backgroundColor || 'rgba(90,200,250,0.9)'
      }
      ctx.fillRect(sx, sy, sw, sh)
    }

    // text labels (title + tick labels)
    const labels = Array.from(bar.querySelectorAll('.scatter-colorbar-title, .scatter-colorbar-tick-label')) as HTMLElement[]
    for (const el of labels) {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      const txt = (el.textContent || '').trim()
      if (!txt) continue
      const fontSize = Math.max(8, Number.parseFloat(style.fontSize || '10'))
      ctx.fillStyle = style.color || '#c5cfdb'
      ctx.font = `${style.fontWeight || '400'} ${fontSize * scale}px ${style.fontFamily || 'monospace'}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(txt, (r.left - rect.left) * scale, (r.top - rect.top) * scale)
    }
  }
}

function parseGradientStops(background: string): Array<{ pct: number; color: string }> {
  const matches = [...background.matchAll(/(rgb[a]?\([^)]*\)|#[0-9a-fA-F]{3,8})\s+([0-9.]+)%/g)]
  const out: Array<{ pct: number; color: string }> = []
  for (const m of matches) {
    const pct = Number.parseFloat(m[2]) / 100
    if (!Number.isFinite(pct)) continue
    out.push({ pct: Math.max(0, Math.min(1, pct)), color: m[1] })
  }
  return out
}
