import { sanitisePartNumber } from '@shared/parts/images'
import type { PartKind } from '@shared/parts/librarySchema'
import type { LibraryContext } from './libraryContext'

/**
 * Why a library record is not a "complete record" (empty = complete): manufacturer,
 * datasheetUrl, datasheet file, plus kind detail (connector cavities and every pin/seal
 * they name, cable cores, wire gauge).
 */
export function incompleteReasons(pn: string, lib: LibraryContext, expectKind?: PartKind): string[] {
  // One line per distinct problem: N cavities naming the same incomplete pin report it once.
  return [...new Set(reasons(pn, lib, expectKind, new Set()))]
}

/** The parse error of `parts/<stem>.json` when that file exists but did not load; else null. */
export function unreadableRecord(lib: LibraryContext, pn: string): string | null {
  const file = `${sanitisePartNumber(pn)}.json`
  return lib.errors.find((e) => e.file === file)?.error ?? null
}

function reasons(pn: string, lib: LibraryContext, expectKind: PartKind | undefined, seen: Set<string>): string[] {
  const part = lib.catalog.part(pn)
  if (!part) {
    const bad = unreadableRecord(lib, pn)
    return [bad ? `${pn}: present but unreadable: ${bad}` : `${pn}: not in library`]
  }
  const out: string[] = []
  if (expectKind && part.kind !== expectKind) out.push(`${pn}: is a ${part.kind}, expected ${expectKind}`)
  if (!part.partNumber.trim()) out.push(`${pn}: missing part number`)
  if (!part.manufacturer?.trim()) out.push(`${pn}: missing manufacturer`)
  if (!part.datasheetUrl?.trim()) out.push(`${pn}: missing datasheet URL`)
  if (!lib.datasheets.has(sanitisePartNumber(pn))) out.push(`${pn}: no datasheet file`)
  if (part.kind === 'connector') {
    const cavs = part.connector?.cavities ?? []
    if (cavs.length === 0) out.push(`${pn}: connector has no cavities`)
    if (!seen.has(pn)) {
      seen.add(pn)
      for (const c of cavs) {
        // A cavity's default pin must be a pin record and its default seal a seal record — a
        // wire, plug or connector named there would put the wrong line on the BOM. (Cavity
        // plugs are set by the `cavity` op, never by defaultSeal.)
        for (const [what, ref] of [
          ['pin', c.defaultPin],
          ['seal', c.defaultSeal]
        ] as const) {
          if (!ref) continue
          for (const r of reasons(ref, lib, what, seen)) {
            out.push(`${pn}: default ${what} ${ref} — ${r.startsWith(`${ref}: `) ? r.slice(ref.length + 2) : r}`)
          }
        }
      }
    }
  }
  if (part.kind === 'cable' && (part.cable?.cores.length ?? 0) === 0) out.push(`${pn}: cable has no cores`)
  if (part.kind === 'wire' && !part.wire?.gauge) out.push(`${pn}: wire has no gauge`)
  return out
}
