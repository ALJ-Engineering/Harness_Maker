import type { HarnessDocument, Id, Vec2, RouteNode, Span, LabelKind } from './schema'
import { routeNodeKey, segmentLengthMm, effectiveSegmentLengthMm, segmentLengthBroken } from './geometry'
import { computeBom, bomItemsForParts, type BomLine } from '../export/bom'
import { bodyPartNumbers } from './bodyParts'
import { LABEL_FONT, estTextWidthMm, placementPos } from './anchors'

// Text metrics and the anchor lookup live in anchors.ts — the single source of
// truth shared with geometry.ts so drawn lines and measured lengths cannot
// diverge. Re-exported here because callers (svg.ts, renderer nodes, tests)
// import them from the formboard module.
export { PT_TO_MM, MIN_FONT, LABEL_FONT, estTextWidthMm, natCompare } from './anchors'

/** Printed radius of a body dot (mm) — the branch-point glyph, so the builder sees one kind of node. */
export const BODY_DOT_R = 1.8
/** Body label text anchor relative to the dot (mm): right of and slightly above it. */
export const BODY_LABEL_OFFSET: Vec2 = { x: 3, y: -3.5 }

/**
 * Constant mm offset from an anchored label's on-wire bead to its text origin —
 * keeps the text clear of the wire while the bead slides along the segment. The
 * only label degree-of-freedom is the slide (fraction); this offset is fixed.
 */
export const LABEL_OFFSET: Vec2 = { x: 3, y: -7 }

/** Human-readable label-kind names (used in the SVG text and the panel dropdown). */
export const LABEL_KIND_LABELS: Record<LabelKind, string> = {
  callout: 'Callout',
  wireMarker: 'Wire marker',
  flag: 'Flag',
  heatshrinkPrint: 'Heatshrink print'
}

/** Print/tooltip text for a label: "Kind: text" (e.g. "Heatshrink print: CAN H"). */
export function labelDisplayText(kind: LabelKind, text: string): string {
  const k = LABEL_KIND_LABELS[kind]
  return text ? `${k}: ${text}` : k
}

export interface FbBody {
  id: Id
  kind: 'connector' | 'terminal' | 'splice'
  /** Dot centre = `placement.pos`. */
  pos: Vec2
  /** `C2 [14, 15]` — designator + BOM items of the body's parts, or just the designator. */
  label: string
  /** Text start point (SVG `text-anchor=start`, vertical centre). */
  labelPos: Vec2
}

export function bodyLabel(name: string, items: number[]): string {
  return items.length ? `${name} [${items.join(', ')}]` : name
}

export interface FbSegment {
  id: Id; a: Vec2; b: Vec2; wireIds: Id[]
  colour?: string; stripes?: string[]; bundle: boolean; gauge?: string
  /**
   * EFFECTIVE segment length in mm — what the label shows: the typed
   * `specifiedLengthMm` when set, else the drawn distance (`drawnLengthMm`).
   * Null if untyped and either node is unresolved.
   */
  lengthMm: number | null
  /** Distance between the two resolved node ANCHORS, i.e. exactly the `a`→`b` line (B1). */
  drawnLengthMm: number | null
  /** The typed manufacturing length, when the segment carries one. */
  specifiedLengthMm?: number
  /** Typed length no longer matches the drawing (see `segmentLengthBroken`). */
  broken: boolean
}
export interface FbTreatment { kind: 'sleeving' | 'twist'; points: Vec2[]; layLengthMm?: number }
export interface FbLabel { id: Id; kind: LabelKind; text: string; pos: Vec2; leader?: Vec2; bead?: Vec2 }
export interface FbLayout {
  bodies: FbBody[]; segments: FbSegment[]
  branchPoints: { id: Id; pos: Vec2 }[]
  treatments: FbTreatment[]; labels: FbLabel[]
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
}

/**
 * Build a combined gauge + length label string for a wire or segment run.
 *
 * Rules:
 *   - both gauge and lengthMm present → `"${gauge} · ${Math.round(lengthMm)} mm"`
 *   - only gauge                      → `gauge`
 *   - only lengthMm                   → `"${Math.round(lengthMm)} mm"`
 *   - neither                         → `""`
 *
 * `null` and `undefined` are treated identically (absent). A `lengthMm` of 0
 * is considered present and will render as `"0 mm"`.
 */
/**
 * A formboard limb's label: the length alone, `"${Math.round(lengthMm)} mm"`,
 * or `""` when unknown. The formboard never prints the wire size beside it
 * (user decision 2026-10-27); bundles print their wire count instead.
 */
export function lengthLabel(lengthMm?: number | null): string {
  return runLabel(null, lengthMm)
}

export function runLabel(gauge?: string | null, lengthMm?: number | null): string {
  const hasGauge = gauge != null && gauge !== ''
  const hasLength = lengthMm != null
  if (hasGauge && hasLength) return `${gauge} · ${Math.round(lengthMm)} mm`
  if (hasGauge) return gauge
  if (hasLength) return `${Math.round(lengthMm)} mm`
  return ''
}

export function computeFormboard(
  doc: HarnessDocument,
  bom: BomLine[] = computeBom(doc)
): FbLayout {
  const bodies: FbBody[] = []
  const pushBody = (id: Id, kind: FbBody['kind'], name: string): void => {
    const pos = placementPos(doc, id)
    if (!pos) return
    const label = bodyLabel(name, bomItemsForParts(bom, bodyPartNumbers(doc, id)))
    bodies.push({
      id,
      kind,
      pos,
      label,
      labelPos: { x: pos.x + BODY_LABEL_OFFSET.x, y: pos.y + BODY_LABEL_OFFSET.y }
    })
  }
  for (const c of doc.connectors) pushBody(c.id, 'connector', c.designator)
  for (const ft of doc.freeTerminals) {
    pushBody(ft.id, 'terminal', ft.landsOn ? `${ft.designator} ${ft.landsOn}` : ft.designator)
  }
  for (const sp of doc.splices) pushBody(sp.id, 'splice', sp.designator)

  const branchPoints = doc.branchPoints.map((b) => ({ id: b.id, pos: b.pos }))
  const branchPos = new Map(branchPoints.map((b) => [b.id, b.pos]))

  // The drawn anchor MUST be the same point geometry.ts measures to, or the 1:1
  // print disagrees with its own length labels — so a body node resolves to its
  // placement dot, exactly as `resolveNodePos` does.
  const anchorOf = (node: RouteNode): Vec2 | null =>
    node.type === 'branch' ? branchPos.get(node.branchId) ?? null : placementPos(doc, node.refId)

  // segment -> routed wireIds
  const segWires = new Map<Id, Id[]>()
  for (const r of doc.wireRoutes)
    for (const sid of r.path) {
      const arr = segWires.get(sid) ?? []
      if (!arr.includes(r.wireId)) arr.push(r.wireId)
      segWires.set(sid, arr)
    }

  const segments: FbSegment[] = []
  for (const seg of doc.segments) {
    const a = anchorOf(seg.from)
    const b = anchorOf(seg.to)
    if (!a || !b) continue
    const wireIds = segWires.get(seg.id) ?? []
    const seg2: FbSegment = { id: seg.id, a, b, wireIds, bundle: wireIds.length >= 2,
      lengthMm: effectiveSegmentLengthMm(doc, seg.id), drawnLengthMm: segmentLengthMm(doc, seg.id),
      broken: segmentLengthBroken(doc, seg.id)
    }
    if (seg.specifiedLengthMm != null) seg2.specifiedLengthMm = seg.specifiedLengthMm
    if (wireIds.length === 1) {
      const w = doc.wires.find((x) => x.id === wireIds[0])
      if (w) {
        seg2.colour = w.color.base
        seg2.stripes = w.color.stripes
        seg2.gauge = `${w.gauge.value} ${w.gauge.unit}`
      }
    }
    segments.push(seg2)
  }

  // treatments: orientation-aware polyline along the span's segments
  const segById = new Map(doc.segments.map((s) => [s.id, s]))
  const spanPoints = (span: Span): Vec2[] | null => {
    const segs = span.segmentIds.map((id) => segById.get(id))
    if (segs.some((s) => !s)) return null
    const pts: Vec2[] = []
    let prevExitKey: string | null = null
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!
      const fromKey = routeNodeKey(s.from), toKey = routeNodeKey(s.to)
      const fromPos = anchorOf(s.from), toPos = anchorOf(s.to)
      if (!fromPos || !toPos) return null
      let startPos: Vec2, endPos: Vec2, endKey: string
      if (prevExitKey === null) {
        // first segment: orient toward the shared node with seg[1] if present
        const next = segs[i + 1]
        const sharedWithNext = next
          ? [routeNodeKey(next.from), routeNodeKey(next.to)]
          : []
        if (sharedWithNext.includes(toKey)) { startPos = fromPos; endPos = toPos; endKey = toKey }
        else if (sharedWithNext.includes(fromKey)) { startPos = toPos; endPos = fromPos; endKey = fromKey }
        else { startPos = fromPos; endPos = toPos; endKey = toKey }
        const sf = i === 0 ? span.startFraction ?? 0 : 0
        pts.push(lerp(startPos, endPos, sf))
      } else {
        if (fromKey === prevExitKey) { startPos = fromPos; endPos = toPos; endKey = toKey }
        else { startPos = toPos; endPos = fromPos; endKey = fromKey }
      }
      if (i === segs.length - 1) pts.push(lerp(startPos, endPos, span.endFraction ?? 1))
      else pts.push(endPos)
      prevExitKey = endKey
    }
    return pts
  }
  const treatments: FbTreatment[] = []
  for (const s of doc.sleeving) { const p = spanPoints(s.span); if (p) treatments.push({ kind: 'sleeving', points: p }) }
  for (const t of doc.twists) { const p = spanPoints(t.span); if (p) treatments.push({ kind: 'twist', points: p, layLengthMm: t.layLengthMm }) }

  // labels — an anchored label rides a segment: a bead ON the wire (`bead`, at
  // lerp of the segment's two anchor points) with the text offset by LABEL_OFFSET
  // and a leader between them. Unanchored / branchPoint labels keep their free
  // `pos` (+ optional leader to the target, drawn only in the SVG today).
  const labels: FbLabel[] = doc.labels.map((l) => {
    if (l.anchor) {
      const s = segById.get(l.anchor.segmentId)
      const a = s ? anchorOf(s.from) : null
      const b = s ? anchorOf(s.to) : null
      if (a && b) {
        const bead = lerp(a, b, l.anchor.fraction)
        const pos = { x: bead.x + LABEL_OFFSET.x, y: bead.y + LABEL_OFFSET.y }
        return { id: l.id, kind: l.kind, text: l.text, pos, leader: bead, bead }
      }
    }
    let leader: Vec2 | undefined
    if (l.leader) {
      if (l.target.type === 'branchPoint') leader = branchPos.get(l.target.branchId) ?? undefined
      else if (l.target.type === 'branch') {
        const s = segById.get(l.target.segmentId)
        if (s) { const a = anchorOf(s.from), b = anchorOf(s.to); if (a && b) leader = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
      } else if (l.target.type === 'wire') {
        const wireTarget = l.target
        const r = doc.wireRoutes.find((x) => x.wireId === wireTarget.wireId)
        const s = r && segById.get(r.path[0]); const a = s && anchorOf(s.from), b = s && anchorOf(s.to)
        if (a && b) leader = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      }
    }
    return { id: l.id, kind: l.kind, text: l.text, pos: l.pos, leader }
  })

  // bbox
  const xs: number[] = [], ys: number[] = []
  for (const b of bodies) {
    xs.push(b.pos.x - BODY_DOT_R, b.pos.x + BODY_DOT_R, b.labelPos.x + estTextWidthMm(b.label, LABEL_FONT))
    ys.push(b.pos.y - BODY_DOT_R, b.pos.y + BODY_DOT_R, b.labelPos.y - LABEL_FONT / 2, b.labelPos.y + LABEL_FONT / 2)
  }
  for (const b of branchPoints) { xs.push(b.pos.x); ys.push(b.pos.y) }
  for (const s of segments) { xs.push(s.a.x, s.b.x); ys.push(s.a.y, s.b.y) }
  for (const l of labels) { xs.push(l.pos.x); ys.push(l.pos.y) }
  const bbox = xs.length
    ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
    : { minX: 0, minY: 0, maxX: 100, maxY: 60 }

  return { bodies, segments, branchPoints, treatments, labels, bbox }
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}
