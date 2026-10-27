import type { LibraryPart } from './librarySchema'

export interface CatalogEntry {
  partNumber: string
  manufacturer?: string
  description: string
  category?: string
}

export interface PartCatalog {
  resolve(partNumber: string): CatalogEntry | undefined
}

/** Bundled stub entries — plausible generic connector/wire/hardware parts. */
const STUB_ENTRIES: CatalogEntry[] = [
  { partNumber: 'HSG-DT04-2P', manufacturer: 'TE', description: 'Deutsch DT 2-way receptacle', category: 'connector housing' },
  { partNumber: 'PIN-0462-201', manufacturer: 'TE', description: 'Solid contact 16-20 AWG', category: 'pin' },
  { partNumber: 'RING-M6-25', manufacturer: 'Generic', description: 'Ring terminal M6 2.5mm2', category: 'free terminal' },
  { partNumber: 'SPL-BUTT-05', manufacturer: 'Generic', description: 'Butt splice 0.5mm2', category: 'splice' },
  { partNumber: 'SLV-BRD-6', manufacturer: 'Generic', description: 'Braided sleeving 6mm', category: 'sleeving' },
  { partNumber: 'WIRE-FLRY-0.5-RD', manufacturer: 'Generic', description: 'FLRY-B 0.5mm2 red', category: 'wire' }
]

/** A catalog backed by an in-memory list (bundled stub entries by default). A real
 *  distributor/ERP adapter implements PartCatalog as a later drop-in. */
export class StubCatalog implements PartCatalog {
  readonly entries: CatalogEntry[]
  private byPn: Map<string, CatalogEntry>

  constructor(entries: CatalogEntry[] = STUB_ENTRIES) {
    this.entries = entries
    this.byPn = new Map(entries.map((e) => [e.partNumber, e]))
  }

  resolve(partNumber: string): CatalogEntry | undefined {
    return this.byPn.get(partNumber)
  }
}

export function defaultStubCatalog(): StubCatalog {
  return new StubCatalog()
}

/** The real catalog: the in-memory listing of the parts library folder. */
export class LibraryCatalog implements PartCatalog {
  private byPn: Map<string, LibraryPart>
  constructor(parts: readonly LibraryPart[]) {
    this.byPn = new Map(parts.map((p) => [p.partNumber, p]))
  }
  part(partNumber: string): LibraryPart | undefined {
    return this.byPn.get(partNumber)
  }
  resolve(partNumber: string): CatalogEntry | undefined {
    const p = this.byPn.get(partNumber)
    if (!p) return undefined
    const e: CatalogEntry = { partNumber: p.partNumber, description: p.description, category: p.kind }
    if (p.manufacturer) e.manufacturer = p.manufacturer
    return e
  }
}
