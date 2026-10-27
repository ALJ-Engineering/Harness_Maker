import type { LibraryPart, PartKind } from './librarySchema'

/**
 * Library search for the picker and the browser. Every whitespace-separated
 * term must match one of partNumber / description / manufacturer
 * (case-insensitive substring). Rank 0 = part-number prefix, 1 = part-number
 * substring, 2 = matched elsewhere; ties break on part number.
 */
export function searchParts(
  parts: readonly LibraryPart[],
  query: string,
  opts: { kinds?: readonly PartKind[] } = {}
): LibraryPart[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const kinds = opts.kinds ? new Set<PartKind>(opts.kinds) : null
  const ranked: { part: LibraryPart; rank: number }[] = []
  for (const part of parts) {
    if (kinds && !kinds.has(part.kind)) continue
    const pn = part.partNumber.toLowerCase()
    const hay = [pn, part.description, part.manufacturer]
      .filter((s): s is string => !!s)
      .map((s) => s.toLowerCase())
    let rank = terms.length ? 2 : 0
    let ok = true
    for (const t of terms) {
      if (!hay.some((h) => h.includes(t))) { ok = false; break }
      if (pn.startsWith(t)) rank = Math.min(rank, 0)
      else if (pn.includes(t)) rank = Math.min(rank, 1)
    }
    if (ok) ranked.push({ part, rank })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.part.partNumber.localeCompare(b.part.partNumber))
  return ranked.map((r) => r.part)
}
