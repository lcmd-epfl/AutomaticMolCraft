/// <reference lib="webworker" />
import type { CrossfilterMsg, CrossfilterResp } from './types'

let baseMask: Uint8Array | null = null

self.onmessage = (e: MessageEvent<CrossfilterMsg>) => {
  const { type, op, payload, length } = e.data
  if (type !== 'mask') return

  // Ensure the mask exists and has the right length
  if (!baseMask || baseMask.length !== length) {
    baseMask = new Uint8Array(length)
    baseMask.fill(1)
  }

  if (op === 'reset') {
    baseMask.fill(1)
  } else if (op === 'ids') {
    // payload is Int32Array of indices to KEEP
    const keep = payload as Int32Array
    baseMask.fill(0)
    for (let i = 0; i < keep.length; i++) {
      const idx = keep[i]
      if (idx >= 0 && idx < baseMask.length) baseMask[idx] = 1
    }
  }
  // (range/category ops can be added here later)

  const resp: CrossfilterResp = { type: 'mask', mask: baseMask }
  // NOTE: If you want to transfer zero-copy, you can use:
  // postMessage(resp, [baseMask.buffer])
  postMessage(resp)
}

