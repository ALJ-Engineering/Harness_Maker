import type {
  DrawingBlocks,
  Endpoint,
  HarnessDocument,
  Id,
  LengthToleranceBand,
  PaperSize,
  PictureView,
  RouteNode,
  Segment,
  SheetConfig,
  TitleBlock,
  ToleranceTable,
  Vec2
} from './schema'
import { DEFAULT_SHEET, PLOTTER_DEFAULT_LENGTH_MM, PLOTTER_MAX_LENGTH_MM, PLOTTER_MIN_LENGTH_MM, SCHEMA_VERSION } from './schema'
import { emptyDocument } from './document'
import { backfillDesignators } from './designators'
import { LABEL_FONT, estTextWidthMm, sortedCavities } from './anchors'
import { bodyKey, endpointBodyId } from './endpoints'
// One definition of "identity" for the loader, the store and the renderer.
import { isIdentityView, normaliseView } from './pictureView'

/**
 * Serialize a document to the on-disk JSON form. Pretty-printed with the three
 * layers in their declared order so Git diffs stay readable (per spec §3).
 * Object key order follows insertion order, which our factories establish.
 */
export function serializeDocument(doc: HarnessDocument): string {
  return JSON.stringify(doc, null, 2) + '\n'
}

export class DocumentParseError extends Error {}

const TYPED_KEYS = new Set([
  'title',
  'partNumber',
  'description',
  'revision',
  'drawnBy',
  'engApproved',
  'mfgApproved',
  'qa',
  'confidentiality'
])
const LEGACY_ALIASES: Record<string, keyof TitleBlock> = {
  title: 'title',
  partnumber: 'partNumber',
  part_number: 'partNumber',
  'part number': 'partNumber',
  description: 'description',
  rev: 'revision',
  revision: 'revision'
}

/** Legacy free-form Record<string,string> → typed TitleBlock. Typed input passes through. */
export function migrateTitleBlock(raw: unknown): TitleBlock | undefined {
  return migrateTitleBlockWithNote(raw).titleBlock
}

/** As `migrateTitleBlock`, but says whether the legacy free-form path was taken. */
function migrateTitleBlockWithNote(raw: unknown): { titleBlock: TitleBlock | undefined; migrated: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { titleBlock: undefined, migrated: false }
  }
  const rec = raw as Record<string, unknown>
  const keys = Object.keys(rec)
  const isTyped = keys.some((k) => TYPED_KEYS.has(k)) || keys.length === 0
  if (isTyped) return { titleBlock: rec as TitleBlock, migrated: false }
  const out: TitleBlock = {}
  const leftovers: string[] = []
  for (const k of keys) {
    const v = rec[k]
    if (typeof v !== 'string') continue
    const target = LEGACY_ALIASES[k.toLowerCase()]
    if (target && (target === 'title' || target === 'partNumber' || target === 'description' || target === 'revision'))
      out[target] = v
    else leftovers.push(`${k}: ${v}`)
  }
  if (!out.description && leftovers.length) out.description = leftovers.join('\n')
  return { titleBlock: out, migrated: true }
}

// ─────────────────────────── sheet validation ────────────────────────────

const PAPER_SIZES = new Set<string>(['A4', 'A3', 'A2', 'A1', 'A0', 'Plotter'])
const ORIENTATIONS = new Set<string>(['portrait', 'landscape'])

/**
 * Validate a `SheetConfig` off disk, falling back to `DEFAULT_SHEET` PER FIELD.
 *
 * `sheetMm` indexes a fixed paper table (and sizes a plotter roll from `lengthMm`) and `wrapPage` writes the result
 * straight into the page `<svg>`, so an unknown paper size does not fail at the
 * boundary — it becomes `undefined` mm somewhere deep in the print pipeline. A
 * hand-edited or future-written file must not be able to do that.
 */
function validateSheet(raw: unknown): { sheet: SheetConfig; invalid: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { sheet: DEFAULT_SHEET, invalid: true }
  }
  const r = raw as Record<string, unknown>
  const paperOk = typeof r.paper === 'string' && PAPER_SIZES.has(r.paper)
  const orientationOk = typeof r.orientation === 'string' && ORIENTATIONS.has(r.orientation)
  const paper = paperOk ? (r.paper as PaperSize) : DEFAULT_SHEET.paper
  const sheet: SheetConfig = {
    paper,
    orientation: orientationOk ? (r.orientation as SheetConfig['orientation']) : DEFAULT_SHEET.orientation
  }
  // `lengthMm` belongs to the plotter roll only: a bad one resets to the
  // default length, and any other paper drops it.
  let lengthOk = true
  if (paper === 'Plotter') {
    const l = r.lengthMm
    lengthOk = typeof l === 'number' && Number.isFinite(l) && l >= PLOTTER_MIN_LENGTH_MM && l <= PLOTTER_MAX_LENGTH_MM
    sheet.lengthMm = lengthOk ? (l as number) : PLOTTER_DEFAULT_LENGTH_MM
  }
  return { sheet, invalid: !paperOk || !orientationOk || !lengthOk }
}

const isVec2 = (v: unknown): v is Vec2 =>
  typeof v === 'object' && v !== null &&
  Number.isFinite((v as Vec2).x) && Number.isFinite((v as Vec2).y)

/**
 * Validate `drawing.blocks` off disk. A pin whose owner no longer exists, or
 * with a non-finite coordinate, is dropped (noted); an empty result is
 * `undefined` so a clean file stays clean.
 *
 * `pinoutOwnerIds` is connectors ∪ free terminals: `connectorPinouts` draws a
 * pinout table for every wire-carrying free terminal too, so a free-terminal
 * pin is legitimate. `pictureOwnerIds` adds splices — a part picture is drawn
 * for any placed body that buys a part. Each must stay the same set the store's
 * `effectiveBlockMoves` accepts, or a block the user can drag would lose its
 * pin on reload.
 */
/**
 * `blocks.pictureView`, field by field: an entry must be an object owned by a
 * drawn body, its `rotationDeg` a finite number and its flips booleans —
 * anything else is dropped (a bad field, not the whole entry, so a typo'd flip
 * does not lose the rotation beside it).
 *
 * Each surviving entry goes through `normaliseView`, and one that comes out
 * IDENTITY is simply omitted: absent is exactly what identity means, so nothing
 * is lost and it is not reported as a drop. Same for a rotation outside
 * [0, 360) — it is normalised, not dropped.
 */
function pictureViews(
  value: unknown,
  ownerIds: Set<string>,
  onDrop: () => void
): Record<string, PictureView> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    onDrop()
    return undefined
  }
  const out: Record<string, PictureView> = {}
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!ownerIds.has(id) || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      onDrop()
      continue
    }
    const v = raw as Record<string, unknown>
    const view: PictureView = {}
    if (v.rotationDeg !== undefined) {
      if (typeof v.rotationDeg === 'number' && Number.isFinite(v.rotationDeg)) view.rotationDeg = v.rotationDeg
      else onDrop()
    }
    for (const k of ['flipH', 'flipV'] as const) {
      if (v[k] !== undefined) {
        if (typeof v[k] === 'boolean') view[k] = v[k] as boolean
        else onDrop()
      }
    }
    const norm = normaliseView(view)
    if (!isIdentityView(norm)) out[id] = norm
  }
  return Object.keys(out).length ? out : undefined
}

function validateBlocks(
  raw: unknown,
  pinoutOwnerIds: Set<string>,
  pictureOwnerIds: Set<string>
): { blocks: DrawingBlocks | undefined; dropped: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { blocks: undefined, dropped: raw !== undefined }
  const r = raw as Record<string, unknown>
  let dropped = false
  const out: DrawingBlocks = {}
  const keyedMap = (value: unknown, ownerIds: Set<string>): Record<string, Vec2> | undefined => {
    const pin: Record<string, Vec2> = {}
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [id, v] of Object.entries(value as Record<string, unknown>)) {
        if (ownerIds.has(id) && isVec2(v)) pin[id] = { x: v.x, y: v.y }
        else dropped = true
      }
    } else dropped = true
    return Object.keys(pin).length ? pin : undefined
  }
  if (r.pinout !== undefined) {
    const pin = keyedMap(r.pinout, pinoutOwnerIds)
    if (pin) out.pinout = pin
  }
  if (r.picture !== undefined) {
    const pic = keyedMap(r.picture, pictureOwnerIds)
    if (pic) out.picture = pic
  }
  if (r.pictureView !== undefined) {
    const views = pictureViews(r.pictureView, pictureOwnerIds, () => (dropped = true))
    if (views) out.pictureView = views
  }
  if (r.bom !== undefined) {
    if (isVec2(r.bom)) out.bom = { x: r.bom.x, y: r.bom.y }
    else dropped = true
  }
  if (r.tolerance !== undefined) {
    if (isVec2(r.tolerance)) out.tolerance = { x: r.tolerance.x, y: r.tolerance.y }
    else dropped = true
  }
  return { blocks: Object.keys(out).length ? out : undefined, dropped }
}

const isMeasure = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * Validate `drawing.toleranceTable` off disk, band by band: `plus`/`minus` must
 * be finite and ≥ 0, `unit` `mm` or `%`, and `upToMm`, when present, finite and
 * > 0. A bad band is dropped, not the table; a table that is not an object, or
 * whose `bands` is not an array, is dropped whole. A blank or non-string title
 * falls back to the default.
 */
function validateToleranceTable(raw: unknown): { table: ToleranceTable | undefined; dropped: boolean } {
  if (raw === undefined) return { table: undefined, dropped: false }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { table: undefined, dropped: true }
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.bands)) return { table: undefined, dropped: true }
  let dropped = false
  const bands: LengthToleranceBand[] = []
  for (const b of r.bands as unknown[]) {
    const v = (typeof b === 'object' && b !== null ? b : {}) as Record<string, unknown>
    const upOk = v.upToMm === undefined || (isMeasure(v.upToMm) && v.upToMm > 0)
    if (!upOk || !isMeasure(v.plus) || !isMeasure(v.minus) || (v.unit !== 'mm' && v.unit !== '%')) {
      dropped = true
      continue
    }
    const band: LengthToleranceBand = { plus: v.plus, minus: v.minus, unit: v.unit }
    if (v.upToMm !== undefined) band.upToMm = v.upToMm as number
    bands.push(band)
  }
  const table: ToleranceTable = { bands }
  if (typeof r.title === 'string' && r.title.trim()) table.title = r.title
  else if (r.title !== undefined) dropped = true
  return { table, dropped }
}

// ── 0.3 → 0.4: body-keyed route nodes ────────────────────────────────────────
//
// Before 0.4.0 a placement's `pos` was a body BOX's top-left and a segment end
// was a per-cavity Endpoint (so N wires from one connector were N coincident
// segments). Now `pos` is the one dot every wire on the body lands on and a
// segment end names the body. The old box geometry is reproduced ONCE, here,
// so an old file's limbs land where they were drawn; `anchors.ts` no longer
// knows it.

const LEGACY = {
  PIN_PITCH: 10,
  PAD: 4,
  MIN_CONNECTOR: 25,
  TERMINAL_DIA: 25,
  PIN_LABEL_BAND: 9,
  BODY_W: 18,
  MIN_H: 12
}
type LegacySide = 'left' | 'right' | 'top' | 'bottom'

/** Where the old body drawing anchored its wires, from the old top-left `pos`. */
export function legacyBodyAnchor(doc: HarnessDocument, refId: Id, side: LegacySide | undefined): Vec2 | null {
  const p = doc.placements.find((x) => x.refId === refId)
  if (!p) return null
  const c = doc.connectors.find((x) => x.id === refId)
  if (c) {
    const n = Math.max(1, sortedCavities(c).length)
    const s = Math.max(
      LEGACY.MIN_CONNECTOR,
      n * LEGACY.PIN_PITCH + 2 * LEGACY.PAD,
      estTextWidthMm(c.designator, LABEL_FONT) + LEGACY.PIN_LABEL_BAND + 2 * LEGACY.PAD
    )
    switch (side ?? 'right') {
      case 'right':
        return { x: p.pos.x + s, y: p.pos.y + s / 2 }
      case 'left':
        return { x: p.pos.x, y: p.pos.y + s / 2 }
      case 'top':
        return { x: p.pos.x + s / 2, y: p.pos.y }
      case 'bottom':
        return { x: p.pos.x + s / 2, y: p.pos.y + s }
    }
  }
  const ft = doc.freeTerminals.find((x) => x.id === refId)
  if (ft) {
    const dia = Math.max(LEGACY.TERMINAL_DIA, estTextWidthMm(ft.landsOn ?? ft.kind, LABEL_FONT) + 2 * LEGACY.PAD)
    return { x: p.pos.x, y: p.pos.y + dia / 2 }
  }
  if (doc.splices.some((x) => x.id === refId)) {
    return { x: p.pos.x + LEGACY.BODY_W / 2, y: p.pos.y + LEGACY.MIN_H / 2 }
  }
  return null
}

/** A route node as an OLD file may hold it: the pre-0.4.0 per-endpoint shape too. */
type LegacyRouteNode = RouteNode | { type: 'endpoint'; endpoint: Endpoint }

/**
 * Bring a pre-0.4.0 layout overlay forward, in place, reporting each change as
 * a note. Only called for files with `major === 0 && minor < 4`.
 *
 * `rawPlacements` is the file's own `placements` array — the old
 * `cavityExitSide` is not in the current `Placement` type, so the exit side has
 * to be read off the raw JSON before the field is stripped.
 */
export function migrateToBodyRouteNodes(doc: HarnessDocument, rawPlacements: unknown, notes: string[]): void {
  // 1. placements → dot centres (needs the old exit side, read from the raw file)
  const sides = new Map<string, LegacySide | undefined>()
  for (const rp of Array.isArray(rawPlacements) ? rawPlacements : []) {
    const r = rp as { refId?: unknown; cavityExitSide?: unknown }
    if (typeof r.refId === 'string') sides.set(r.refId, r.cavityExitSide as LegacySide | undefined)
  }
  let moved = false
  let stripped = false
  for (const p of doc.placements) {
    const anchor = legacyBodyAnchor(doc, p.refId, sides.get(p.refId))
    if (anchor && (anchor.x !== p.pos.x || anchor.y !== p.pos.y)) {
      p.pos = anchor
      moved = true
    }
    if ('cavityExitSide' in p) {
      delete (p as { cavityExitSide?: unknown }).cavityExitSide
      stripped = true
    }
  }
  if (moved) notes.push('placement moved to body dot centre')
  if (stripped) notes.push('cavityExitSide dropped (formboard bodies are dots)')

  // 2. endpoint ends → body ends
  let rekeyed = false
  const toBody = (n: LegacyRouteNode): RouteNode => {
    if (n.type !== 'endpoint') return n
    rekeyed = true
    const id = endpointBodyId(doc, n.endpoint)
    // Unknown owner: keep a body ref to a non-existent id — DRC reports it, we do not invent one.
    return { type: 'body', refId: id ?? `missing:${JSON.stringify(n.endpoint)}` }
  }
  for (const s of doc.segments as Array<{ from: LegacyRouteNode; to: LegacyRouteNode }>) {
    s.from = toBody(s.from)
    s.to = toBody(s.to)
  }
  if (rekeyed) notes.push('route nodes migrated to body keys')

  // 3. coalesce coincident segments (same unordered node pair)
  // 1 − f in binary floats leaves dust (1 − 0.9 = 0.0999…8) that would be
  // written to disk; a fraction is a position along a limb, so 1e-6 of a
  // segment (nanometres) is well below anything meaningful.
  const mirror = (f: number): number => Math.round((1 - f) * 1e6) / 1e6
  const key = (n: RouteNode): string => (n.type === 'branch' ? `b:${n.branchId}` : bodyKey(n.refId))
  const survivorByPair = new Map<string, Segment>()
  const replace = new Map<Id, { id: Id; reversed: boolean }>()
  const kept: Segment[] = []
  const selfLoops = new Set<Id>()
  for (const s of doc.segments) {
    const f = key(s.from),
      t = key(s.to)
    if (f === t) {
      selfLoops.add(s.id)
      continue
    }
    const pair = [f, t].sort().join('|')
    const sv = survivorByPair.get(pair)
    if (!sv) {
      survivorByPair.set(pair, s)
      kept.push(s)
      continue
    }
    replace.set(s.id, { id: sv.id, reversed: key(sv.from) !== f })
  }
  const before = doc.segments.length
  doc.segments = kept
  const mapId = (id: Id): Id | null => (selfLoops.has(id) ? null : replace.get(id)?.id ?? id)
  const mapIds = (ids: Id[], dedupeConsecutive: boolean): Id[] => {
    const out: Id[] = []
    for (const id of ids) {
      const m = mapId(id)
      if (m === null) continue
      if (dedupeConsecutive ? out[out.length - 1] === m : out.includes(m)) continue
      out.push(m)
    }
    return out
  }
  for (const r of doc.wireRoutes) r.path = mapIds(r.path, true)
  for (const b of doc.bundles) b.segmentIds = mapIds(b.segmentIds, false)
  const mirrorSpan = (span: { segmentIds: Id[]; startFraction?: number; endFraction?: number }): void => {
    // Only a SINGLE-segment span's fractions are tied to the segment's own direction
    // (a multi-segment span is oriented by its neighbours — see formboard.ts spanPoints).
    const rev = span.segmentIds.length === 1 && replace.get(span.segmentIds[0])?.reversed
    span.segmentIds = mapIds(span.segmentIds, false)
    if (rev) {
      const s = span.startFraction ?? 0,
        e = span.endFraction ?? 1
      span.startFraction = mirror(e)
      span.endFraction = mirror(s)
    }
  }
  for (const sl of doc.sleeving) mirrorSpan(sl.span)
  for (const tw of doc.twists) mirrorSpan(tw.span)
  doc.labels = doc.labels.filter((l) => !(l.target.type === 'branch' && selfLoops.has(l.target.segmentId)))
  for (const l of doc.labels) {
    if (l.target.type === 'branch') l.target = { type: 'branch', segmentId: mapId(l.target.segmentId)! }
    if (l.anchor) {
      const rep = replace.get(l.anchor.segmentId)
      if (selfLoops.has(l.anchor.segmentId)) delete l.anchor
      else if (rep)
        l.anchor = { segmentId: rep.id, fraction: rep.reversed ? mirror(l.anchor.fraction) : l.anchor.fraction }
    }
  }
  if (replace.size) notes.push(`coincident segments coalesced (${before - selfLoops.size} → ${kept.length})`)
  if (selfLoops.size) notes.push('self-loop segment dropped')
}

/** The major component of a `major.minor.patch` string, or NaN if unreadable. */
function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '', 10)
}

/** The thirteen top-level model collections — each must be an array when present. */
const ARRAY_FIELDS = [
  'connectors',
  'freeTerminals',
  'splices',
  'wires',
  'cables',
  'placements',
  'branchPoints',
  'segments',
  'wireRoutes',
  'bundles',
  'sleeving',
  'twists',
  'labels'
] as const

/** What a parse changed on the way in, alongside the document itself. */
export interface ParsedDocument {
  doc: HarnessDocument
  /**
   * One human-readable note per migration/repair the LOADER applied (older
   * shapes brought forward, invalid values reset). Distinct from
   * `reconcileDocument`'s `Repair[]`, which is about dangling references
   * between entities; these are about the file's own shape.
   */
  migrated: string[]
}

/**
 * Parse + lightly validate on-disk JSON into a HarnessDocument, reporting what
 * had to be migrated. Lenient by design: any array missing from an
 * older/partial file is backfilled from an empty document so forward/backward
 * compatibility doesn't crash the loader.
 *
 * Throws DocumentParseError when the input clearly isn't a harness doc, when a
 * present collection has the wrong type, or when the file was written by a
 * NEWER MAJOR schema version — a major bump means shapes this build cannot
 * read, and silently loading half of one would quietly destroy the other half
 * on the next save.
 */
export function parseDocumentWithNotes(text: string): ParsedDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new DocumentParseError(`Not valid JSON: ${(e as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new DocumentParseError('Top-level value is not an object')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.schemaVersion !== 'string') {
    throw new DocumentParseError('Missing "schemaVersion" — not a harness document')
  }

  const fileMajor = majorOf(obj.schemaVersion)
  const currentMajor = majorOf(SCHEMA_VERSION)
  // An unparseable version string is treated leniently (NaN comparisons are
  // false) — the structural checks below still have to pass.
  if (fileMajor > currentMajor) {
    throw new DocumentParseError(
      `Schema version ${obj.schemaVersion} is newer than this build supports (${SCHEMA_VERSION}) — upgrade the app to open it`
    )
  }

  // Every model collection must be an array WHEN PRESENT. A missing field is
  // backfilled from the empty document (lenient/forward-compatible); a present-
  // but-wrong-typed field is a corrupt file — reject it cleanly here instead of
  // letting a downstream `for..of`/`.map` crash the renderer mid-render.
  for (const f of ARRAY_FIELDS) {
    if (f in obj && !Array.isArray(obj[f])) {
      throw new DocumentParseError(`Field "${f}" must be an array`)
    }
  }
  if (
    'drawing' in obj &&
    (typeof obj.drawing !== 'object' || obj.drawing === null || Array.isArray(obj.drawing))
  ) {
    throw new DocumentParseError('Field "drawing" must be an object')
  }

  const migrated: string[] = []
  const base = emptyDocument()
  const rawDrawing = (obj.drawing ?? {}) as Record<string, unknown>
  const {
    sheets: legacySheets,
    titleBlock: rawTb,
    toleranceTable: rawTolerance,
    blocks: rawBlocks,
    ...restDrawing
  } = rawDrawing

  const legacySheet = Array.isArray(legacySheets) ? legacySheets[0] : undefined
  const fromLegacy = restDrawing.sheet === undefined && legacySheet !== undefined
  const rawSheet = restDrawing.sheet ?? legacySheet
  let sheet = base.drawing.sheet
  if (rawSheet !== undefined) {
    const checked = validateSheet(rawSheet)
    sheet = checked.sheet
    if (fromLegacy) migrated.push('sheet backfilled from legacy sheets[0]')
    if (checked.invalid) migrated.push('drawing.sheet invalid — reset to default')
  }

  // `sheetOrigin` must be a finite Vec2; anything else is dropped (absent = derive from content).
  const { sheetOrigin: rawOrigin, ...restDrawingNoOrigin } = restDrawing
  let sheetOrigin: Vec2 | undefined
  if (rawOrigin !== undefined) {
    if (isVec2(rawOrigin)) sheetOrigin = { x: rawOrigin.x, y: rawOrigin.y }
    else migrated.push('invalid drawing.sheetOrigin dropped')
  }

  const tb = migrateTitleBlockWithNote(rawTb)
  if (tb.migrated) migrated.push('titleBlock migrated from a free-form record')

  // Connectors AND free terminals: both get a pinout table, so both can own a pin.
  const idsOf = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).map((e: { id?: unknown }) => String(e?.id))
  const blockOwnerIds = new Set([...idsOf(obj.connectors), ...idsOf(obj.freeTerminals)])
  // A part picture can also be pinned for a splice, which owns no pinout table.
  const pictureOwnerIds = new Set([...blockOwnerIds, ...idsOf(obj.splices)])
  const blk = validateBlocks(rawBlocks, blockOwnerIds, pictureOwnerIds)
  // One note for every way `drawing.blocks` can be wrong — a pinout pin naming
  // an id that no longer exists, a non-finite coordinate on a pinout pin OR on
  // `bom`, and a `blocks` (or `blocks.pinout`) that is not an object at all.
  // It used to say "stale pinout-table position dropped", which named only the
  // first of those.
  if (blk.dropped) migrated.push('invalid drawing-block position dropped')

  const tol = validateToleranceTable(rawTolerance)
  if (tol.dropped) migrated.push('invalid length-tolerance entry dropped')

  const doc = {
    ...base,
    ...obj,
    schemaVersion: SCHEMA_VERSION,
    // drawing is an object, not an array — merge so defaults (units, printScale) survive
    drawing: {
      ...base.drawing,
      ...restDrawingNoOrigin,
      sheet,
      ...(sheetOrigin ? { sheetOrigin } : {}),
      ...(tb.titleBlock ? { titleBlock: tb.titleBlock } : {}),
      ...(tol.table ? { toleranceTable: tol.table } : {}),
      ...(blk.blocks ? { blocks: blk.blocks } : {})
    }
  } as HarnessDocument

  // Layout-overlay migrations run on the assembled document (they need the
  // electrical model to resolve an endpoint's owning body), before
  // `reconcileDocument` gets to see it.
  const fileMinor = Number.parseInt(obj.schemaVersion.split('.')[1] ?? '', 10)
  if (fileMajor === 0 && fileMinor < 4) migrateToBodyRouteNodes(doc, obj.placements, migrated)

  // A typed segment length must be a positive finite number; anything else is dropped.
  let badTyped = false
  for (const seg of doc.segments) {
    const v = (seg as { specifiedLengthMm?: unknown }).specifiedLengthMm
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      delete (seg as { specifiedLengthMm?: unknown }).specifiedLengthMm
      badTyped = true
    }
  }
  if (badTyped) migrated.push('invalid segment specifiedLengthMm dropped')

  const assigned = backfillDesignators(doc)
  if (assigned > 0) migrated.push(`designators assigned to ${assigned} terminals/splices`)

  return { doc, migrated }
}

/** `parseDocumentWithNotes` for the callers that only want the document. */
export function parseDocument(text: string): HarnessDocument {
  return parseDocumentWithNotes(text).doc
}
