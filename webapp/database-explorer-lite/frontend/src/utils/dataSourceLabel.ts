export function bumpDataSourceLabel(
  requestedLabel: string,
  existingValues: string[]
): string {
  const base = String(requestedLabel || '').trim()
  if (!base) return ''

  const used = new Set(
    existingValues
      .map(v => String(v ?? '').trim())
      .filter(Boolean)
      .map(v => v.toLowerCase())
  )

  if (!used.has(base.toLowerCase())) return base

  let i = 2
  let candidate = `${base}_${i}`
  while (used.has(candidate.toLowerCase())) {
    i += 1
    candidate = `${base}_${i}`
  }

  return candidate
}
