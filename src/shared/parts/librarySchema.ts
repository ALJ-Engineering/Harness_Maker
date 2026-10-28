import type { FreeTerminalKind, Gauge, PartRef, SpliceKind } from '../model/schema'
import { sanitisePartNumber } from './images'

/**
 * The parts library's own record format — one JSON file per part under
 * `<lib>/parts/<stem>.json`. Deliberately separate from the harness schema: a
 * document references parts by `PartRef` only and must open without any
 * library present. Versioned independently.
 */
export const LIBRARY_VERSION = '1.1.0'

export const PART_KINDS = [
  'connector', 'pin', 'seal', 'plug',
  'terminal', 'splice',
  'wire', 'cable', 'sleeving', 'tape', 'tie'
] as const
export type PartKind = (typeof PART_KINDS)[number]

/**
 * A wire lead the maker fitted to this position (an in-line fuse holder's
 * pigtail), in place of a contact. Becomes `Cavity.lead` when the part is placed.
 */
export interface LibraryLead {
  gaugeMm2?: number
  /** Base colour code, as `WireColor.base` ("RD"). */
  color?: string
  /** As supplied, before it is cut to length. */
  lengthMm?: number
}

export interface LibraryCavity {
  position: string
  defaultPin?: string
  defaultSeal?: string
  /** A factory-fitted lead: no contact goes in, so never alongside `defaultPin`. */
  lead?: LibraryLead
}

/** One core of a multi-core cable, as the datasheet describes it. */
export interface LibraryCableCore {
  /** As the datasheet labels it: "1", "CAN_H", "BK". */
  name: string
  /** Base colour code, as `WireColor.base` ("WH", "GN"). */
  color: string
  /** As `WireColor.stripes`. */
  stripes?: string[]
  gauge: Gauge
  /** Cores sharing a pair label are twisted together. */
  pair?: string
}

export type GaugeRange = [min: number, max: number]

export interface LibraryPart {
  libraryVersion: string
  partNumber: string
  kind: PartKind
  description: string
  manufacturer?: string
  datasheetUrl?: string
  notes?: string
  connector?: { gender?: 'male' | 'female' | 'hybrid'; matesWith?: string; cavities: LibraryCavity[] }
  terminal?: { kind: FreeTerminalKind; studMm?: number; gaugeMm2?: GaugeRange }
  splice?: { kind: SpliceKind; gaugeMm2?: GaugeRange }
  pin?: { gaugeMm2?: GaugeRange }
  wire?: { gauge: Gauge; color?: string }
  cable?: { cores: LibraryCableCore[]; shield?: { drain: boolean }; jacketColor?: string }
}

const TERMINAL_KINDS: readonly string[] = ['ring', 'ferrule', 'eyelet', 'blade', 'fork', 'bare', 'tinned']
const SPLICE_KINDS: readonly string[] = ['butt', 'solder_sleeve', 'clip', 'weld', 'ultrasonic']
const GENDERS: readonly string[] = ['male', 'female', 'hybrid']

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
function optRange(v: unknown): GaugeRange | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined
  const [a, b] = v
  return typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) ? [a, b] : undefined
}

/** The only shape the document ever receives from the library. */
export function refOf(p: LibraryPart): PartRef {
  const ref: PartRef = { partNumber: p.partNumber, description: p.description }
  if (p.manufacturer) ref.manufacturer = p.manufacturer
  return ref
}

/** An empty record of `kind`, with the kind detail a form needs to start from. */
export function newLibraryPart(kind: PartKind, partNumber: string): LibraryPart {
  const p: LibraryPart = { libraryVersion: LIBRARY_VERSION, partNumber, kind, description: '' }
  if (kind === 'connector') p.connector = { cavities: [] }
  if (kind === 'terminal') p.terminal = { kind: 'ring' }
  if (kind === 'splice') p.splice = { kind: 'butt' }
  if (kind === 'cable') p.cable = { cores: [] }
  return p
}

export function serializeLibraryPart(p: LibraryPart): string {
  return JSON.stringify(p, null, 2) + '\n'
}

/** A cavity's `lead` block, or why it is not one. Each field is optional; a given one must make sense. */
function parseLead(v: unknown): LibraryLead | string {
  if (!isRec(v)) return 'lead must be an object'
  const lead: LibraryLead = {}
  for (const k of ['gaugeMm2', 'lengthMm'] as const) {
    if (v[k] === undefined) continue
    const n = optNum(v[k])
    if (n === undefined || n <= 0) return `lead.${k} must be a positive number`
    lead[k] = n
  }
  if (v.color !== undefined) {
    const color = optStr(v.color)
    if (!color) return 'lead.color must be a colour code'
    lead.color = color
  }
  return lead
}

function parseCavities(v: unknown): LibraryCavity[] | string {
  if (!Array.isArray(v)) return 'connector.cavities must be an array'
  const out: LibraryCavity[] = []
  const seen = new Set<string>()
  for (const c of v) {
    if (!isRec(c) || typeof c.position !== 'string' || c.position === '')
      return 'each cavity needs a string position'
    if (seen.has(c.position)) return `duplicate cavity position "${c.position}"`
    seen.add(c.position)
    const cav: LibraryCavity = { position: c.position }
    const pin = optStr(c.defaultPin)
    const seal = optStr(c.defaultSeal)
    if (pin) cav.defaultPin = pin
    if (seal) cav.defaultSeal = seal
    if (c.lead !== undefined) {
      const lead = parseLead(c.lead)
      if (typeof lead === 'string') return `cavity "${c.position}": ${lead}`
      if (pin) return `cavity "${c.position}" has both a default pin and a factory lead`
      cav.lead = lead
    }
    out.push(cav)
  }
  return out
}

function parseCores(v: unknown): LibraryCableCore[] | string {
  if (!Array.isArray(v)) return 'cable.cores must be an array'
  const out: LibraryCableCore[] = []
  const seen = new Set<string>()
  for (const c of v) {
    const name = isRec(c) ? optStr(c.name) : undefined
    const color = isRec(c) ? optStr(c.color) : undefined
    const g = isRec(c) && isRec(c.gauge) ? c.gauge : undefined
    const value = g ? optNum(g.value) : undefined
    const unit = g?.unit
    if (!isRec(c) || !name || !color || value === undefined || (unit !== 'mm2' && unit !== 'AWG'))
      return 'each core needs a name, a color and a gauge'
    if (seen.has(name)) return `duplicate core name "${name}"`
    seen.add(name)
    const core: LibraryCableCore = { name, color, gauge: { value, unit } }
    if (Array.isArray(c.stripes)) {
      const stripes = c.stripes.filter((x): x is string => typeof x === 'string' && x !== '')
      if (stripes.length) core.stripes = stripes
    }
    const pair = optStr(c.pair)
    if (pair) core.pair = pair
    out.push(core)
  }
  return out
}

/**
 * Parse one library file. Never throws. `expectedStem` (the file's stem) is
 * checked against `sanitisePartNumber(partNumber)` because the stem is how the
 * picture and datasheet are found — a mismatch would orphan both.
 */
export function parseLibraryPart(
  text: string,
  expectedStem?: string
): { part: LibraryPart } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: 'not valid JSON' }
  }
  if (!isRec(raw)) return { error: 'not a JSON object' }
  const partNumber = optStr(raw.partNumber)
  if (!partNumber) return { error: 'missing partNumber' }
  if (typeof raw.kind !== 'string' || !(PART_KINDS as readonly string[]).includes(raw.kind))
    return { error: `unknown kind "${String(raw.kind)}"` }
  const kind = raw.kind as PartKind
  if (typeof raw.description !== 'string') return { error: 'missing description' }
  if (expectedStem !== undefined && sanitisePartNumber(partNumber) !== expectedStem)
    return { error: `partNumber "${partNumber}" does not match file stem "${expectedStem}"` }

  // The file's own `libraryVersion` field is ignored and overwritten with the
  // running app's `LIBRARY_VERSION`. 1.1.0 is additive (the optional `cable`
  // block), so no major-version gate is needed yet; add one here (read
  // `raw.libraryVersion`, refuse or migrate an incompatible major) when the format
  // first changes incompatibly.
  const part: LibraryPart = { libraryVersion: LIBRARY_VERSION, partNumber, kind, description: raw.description }
  const manufacturer = optStr(raw.manufacturer)
  const datasheetUrl = optStr(raw.datasheetUrl)
  const notes = optStr(raw.notes)
  if (manufacturer) part.manufacturer = manufacturer
  if (datasheetUrl) part.datasheetUrl = datasheetUrl
  if (notes) part.notes = notes

  if (kind === 'connector') {
    if (!isRec(raw.connector)) return { error: 'connector kind needs a connector block' }
    const cavities = parseCavities(raw.connector.cavities)
    if (typeof cavities === 'string') return { error: cavities }
    part.connector = { cavities }
    const gender = optStr(raw.connector.gender)
    if (gender && GENDERS.includes(gender)) part.connector.gender = gender as 'male' | 'female' | 'hybrid'
    const mates = optStr(raw.connector.matesWith)
    if (mates) part.connector.matesWith = mates
  }
  if (kind === 'terminal' && isRec(raw.terminal)) {
    const k = optStr(raw.terminal.kind)
    part.terminal = { kind: (k && TERMINAL_KINDS.includes(k) ? k : 'ring') as FreeTerminalKind }
    const stud = optNum(raw.terminal.studMm)
    const g = optRange(raw.terminal.gaugeMm2)
    if (stud !== undefined) part.terminal.studMm = stud
    if (g) part.terminal.gaugeMm2 = g
  }
  if (kind === 'splice' && isRec(raw.splice)) {
    const k = optStr(raw.splice.kind)
    part.splice = { kind: (k && SPLICE_KINDS.includes(k) ? k : 'butt') as SpliceKind }
    const g = optRange(raw.splice.gaugeMm2)
    if (g) part.splice.gaugeMm2 = g
  }
  if (kind === 'pin' && isRec(raw.pin)) {
    const g = optRange(raw.pin.gaugeMm2)
    if (g) part.pin = { gaugeMm2: g }
  }
  if (kind === 'wire' && isRec(raw.wire) && isRec(raw.wire.gauge)) {
    const value = optNum(raw.wire.gauge.value)
    const unit = raw.wire.gauge.unit
    if (value !== undefined && (unit === 'mm2' || unit === 'AWG')) {
      part.wire = { gauge: { value, unit } }
      const color = optStr(raw.wire.color)
      if (color) part.wire.color = color
    }
  }
  if (kind === 'cable') {
    // Lenient like connectors: a missing block is an empty core list (a 1.0.0
    // cable record, or one the form just created). The harness CLI enforces >= 1 core.
    if (!isRec(raw.cable)) part.cable = { cores: [] }
    else {
      const cores = parseCores(raw.cable.cores)
      if (typeof cores === 'string') return { error: cores }
      part.cable = { cores }
      if (isRec(raw.cable.shield)) part.cable.shield = { drain: raw.cable.shield.drain === true }
      const jacket = optStr(raw.cable.jacketColor)
      if (jacket) part.cable.jacketColor = jacket
    }
  }
  return { part }
}
