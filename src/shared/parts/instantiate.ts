import type { Cable, Cavity, Connector, FreeTerminal, Id, PartRef, Splice } from '../model/schema'
import { sortedCavities } from '../model/anchors'
import { newLibraryPart, refOf, type LibraryCavity, type LibraryPart } from './librarySchema'

/**
 * Library record → document entity, and back. Pure: the store supplies ids and
 * the resolver, so this is testable without Zustand. The document receives
 * `PartRef`s only (`refOf`) — never a `LibraryPart`.
 */
export function instantiateConnector(
  part: LibraryPart,
  designator: string,
  resolve: (pn: string) => LibraryPart | undefined,
  newId: () => Id
): Omit<Connector, 'id'> {
  const refFor = (pn: string | undefined): PartRef | undefined => {
    if (!pn) return undefined
    const p = resolve(pn)
    return p ? refOf(p) : { partNumber: pn }
  }
  const tpl = part.connector ?? { cavities: [] }
  const cavities: Cavity[] = tpl.cavities.map((c) => {
    const cav: Cavity = { id: newId(), position: c.position, status: 'populated' }
    const pin = refFor(c.defaultPin)
    const seal = refFor(c.defaultSeal)
    if (pin) cav.pin = pin
    if (seal) cav.seal = seal
    return cav
  })
  const conn: Omit<Connector, 'id'> = { designator, housing: refOf(part), cavities }
  if (tpl.gender) conn.gender = tpl.gender
  return conn
}

export function instantiateFreeTerminal(part: LibraryPart): Omit<FreeTerminal, 'id' | 'designator'> {
  return { kind: part.terminal?.kind ?? 'ring', part: refOf(part) }
}

export function instantiateSplice(part: LibraryPart): Omit<Splice, 'id' | 'designator'> {
  return { kind: part.splice?.kind ?? 'butt', part: refOf(part) }
}

/** A cable record → the document `Cable` minus its id and core wires (those are the store's). */
export function instantiateCable(part: LibraryPart, name: string): Omit<Cable, 'id' | 'coreWireIds'> {
  const cable: Omit<Cable, 'id' | 'coreWireIds'> = { name, part: refOf(part) }
  if (part.cable?.jacketColor) cable.jacketColor = part.cable.jacketColor
  if (part.cable?.shield) cable.shield = { present: true }
  return cable
}

function base(kind: LibraryPart['kind'], ref: PartRef): LibraryPart {
  const p = newLibraryPart(kind, ref.partNumber)
  p.description = ref.description ?? ''
  if (ref.manufacturer) p.manufacturer = ref.manufacturer
  return p
}

/** The library record a connector in a document implies; null if it has no housing PN. */
export function partFromConnector(conn: Connector): LibraryPart | null {
  if (!conn.housing?.partNumber) return null
  const p = base('connector', conn.housing)
  const cavities: LibraryCavity[] = sortedCavities(conn).map((c) => {
    const lc: LibraryCavity = { position: c.position }
    if (c.pin?.partNumber) lc.defaultPin = c.pin.partNumber
    if (c.seal?.partNumber) lc.defaultSeal = c.seal.partNumber
    return lc
  })
  p.connector = conn.gender ? { gender: conn.gender, cavities } : { cavities }
  return p
}

export function partFromFreeTerminal(ft: FreeTerminal): LibraryPart | null {
  if (!ft.part?.partNumber) return null
  const p = base('terminal', ft.part)
  p.terminal = { kind: ft.kind }
  return p
}

export function partFromSplice(sp: Splice): LibraryPart | null {
  if (!sp.part?.partNumber) return null
  const p = base('splice', sp.part)
  p.splice = { kind: sp.kind }
  return p
}
