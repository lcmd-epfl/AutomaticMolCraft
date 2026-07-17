import { LRU } from './lru'

export type DatasetSource =
  | { mode: 'folder'; files: Map<string, File> | Array<[string, File]> | Record<string, File> }
  | { mode: 'base'; baseUrl: string }
  | { mode: 'mixed'; xyzById: Record<string, string> }

const cache = new LRU<string, string>(50000)
const DEFAULT_XYZ_CONCURRENCY = 32
const XYZ_BATCH_SIZE = 250

function normalizeId(s: string) {
  const raw = String(s).trim()
  const base = raw.split(/[\\/]/).pop() || raw
  return base.trim().replace(/\.xyz$/i, '')
}

function asFileMap(files: any): Map<string, File> {
  if (files instanceof Map) return files
  if (Array.isArray(files)) return new Map(files)
  if (files && typeof files === 'object') return new Map(Object.entries(files))
  return new Map()
}

// Lowercase-keyed index per files object, so IDs and filenames match
// regardless of casing (built lazily, once per source).
const folderLowerIndex = new WeakMap<object, Map<string, File>>()

function lowerFileMap(files: any): Map<string, File> {
  const obj = files as object
  if (!obj || typeof obj !== 'object') return new Map()
  let index = folderLowerIndex.get(obj)
  if (!index) {
    index = new Map()
    for (const [key, file] of asFileMap(files)) {
      const lower = key.toLowerCase()
      if (!index.has(lower)) index.set(lower, file)
    }
    folderLowerIndex.set(obj, index)
  }
  return index
}

type ResolveXyzOptions = {
  concurrency?: number
  onProgress?: (resolved: number, total: number) => void
}

// Cache entries are namespaced per source object so two sources that share
// molecule IDs can never serve each other's geometry (or mask a missing one).
const sourceTokens = new WeakMap<object, string>()
let nextSourceToken = 1

function cacheKey(src: DatasetSource, id: string) {
  let token = sourceTokens.get(src)
  if (!token) {
    token = `src${nextSourceToken++}`
    sourceTokens.set(src, token)
  }
  return `${token}:${id}`
}

function setCached(src: DatasetSource, id: string, xyz: string) {
  cache.set(cacheKey(src, id), xyz)
}

function getCached(src: DatasetSource, id: string) {
  return cache.get(cacheKey(src, id))
}

export async function getXYZ(id: string, src: DatasetSource): Promise<string> {
  const cached = getCached(src, id)
  if (cached) return cached

  const cleanId = String(id).trim()
  const stem = normalizeId(cleanId)

  if (src.mode === 'mixed') {
    const xyz =
      src.xyzById[cleanId] ||
      src.xyzById[stem] ||
      src.xyzById[`${stem}.xyz`]

    if (!xyz) throw new Error(`XYZ not found for "${cleanId}" in mixed source`)

    setCached(src, id, xyz)
    return xyz
  }

  if (src.mode === 'folder') {
    const files = asFileMap(src.files)
    const lowerFiles = lowerFileMap(src.files)
    const lowerStem = stem.toLowerCase()
    const lowerCleanId = cleanId.toLowerCase()

    const f =
      files.get(stem) ||
      files.get(cleanId) ||
      files.get(`${stem}.xyz`) ||
      files.get(`${cleanId}.xyz`) ||
      lowerFiles.get(lowerStem) ||
      lowerFiles.get(lowerCleanId) ||
      lowerFiles.get(`${lowerStem}.xyz`) ||
      lowerFiles.get(`${lowerCleanId}.xyz`)

    if (!f) throw new Error(`XYZ not found for "${cleanId}"`)

    const txt = await f.text()
    setCached(src, id, txt)
    return txt
  }

  const url = `${src.baseUrl.replace(/\/$/, '')}/${encodeURIComponent(stem)}.xyz`
  const r = await fetch(url)

  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`)

  const txt = await r.text()
  setCached(src, id, txt)
  return txt
}

function batchUrlForBase(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, '')
  return `${base}/batch`
}

async function resolveBaseXyzByBatch(
  ids: string[],
  source: Extract<DatasetSource, { mode: 'base' }>,
  options: ResolveXyzOptions
) {
  const out: Record<string, string> = {}
  const pending = ids.filter(id => !getCached(source, id))

  for (const id of ids) {
    const cached = getCached(source, id)
    if (cached) out[id] = cached
  }

  if (pending.length === 0) return out

  let resolved = ids.length - pending.length
  const total = ids.length

  for (let i = 0; i < pending.length; i += XYZ_BATCH_SIZE) {
    const chunk = pending.slice(i, i + XYZ_BATCH_SIZE)
    const resp = await fetch(batchUrlForBase(source.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: chunk }),
    })
    if (!resp.ok) {
      throw new Error(`Batch XYZ fetch failed ${resp.status}`)
    }

    const data = await resp.json()
    const xyzById = data?.xyzById || data?.xyz_by_id || {}
    for (const id of chunk) {
      const xyz = xyzById[id]
      if (typeof xyz === 'string' && xyz) {
        out[id] = xyz
        setCached(source, id, xyz)
      }
      resolved += 1
    }
    options.onProgress?.(resolved, total)
  }

  return out
}

export async function resolveXyzByIds(
  ids: string[],
  source: DatasetSource | null,
  options: ResolveXyzOptions = {}
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!source || ids.length === 0) return out

  if (source.mode === 'base') {
    try {
      return await resolveBaseXyzByBatch(ids, source, options)
    } catch {
      // Fall back to bounded single-file fetches for older backends.
    }
  }

  const total = ids.length
  const concurrency = Math.max(1, Math.min(options.concurrency || DEFAULT_XYZ_CONCURRENCY, total))
  let next = 0
  let resolved = 0

  const worker = async () => {
    while (next < total) {
      const id = ids[next]
      next += 1
      try {
        out[id] = await getXYZ(id, source)
      } catch {
        // ignore missing xyz
      }
      resolved += 1
      options.onProgress?.(resolved, total)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  return out
}

export async function buildXyzById(ds: any, source: DatasetSource | null): Promise<Record<string, string>> {
  return resolveXyzByIds(Array.from(ds?.ids || []).map(String), source)
}
