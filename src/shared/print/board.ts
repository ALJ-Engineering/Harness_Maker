/**
 * The shared 1:1 BOARD PLAN: where every pinout table, the BOM summary block,
 * the drawing sheet and the title block sit — all in MODEL mm at scale 1, so
 * one model mm is one printed mm (print scale is locked at 1:1).
 *
 * ── One space, not two ──────────────────────────────────────────────────────
 *
 * There are three kinds of block: a connector's/terminal's PINOUT table, the
 * BOM summary, and a body's PART PICTURE (`picture.ts` draws it; a body gets
 * one only when its primary part number is in the `images` map handed to
 * `planBoard`). All three are placed in one shared pass and share one obstacle
 * set, so a picture never lands on a table and neither lands on a wire.
 *
 * The old fit-to-sheet planner (`drawingSheet.ts`) had to juggle SHEET mm and
 * MODEL mm because the drawing shrank while the tables kept a constant printed
 * size — which is why its fit scale had to be solved as a piecewise-linear
 * problem. At 1:1 that whole apparatus collapses: `scale = 1`, every rect is
 * model mm and printed mm at once. What survives is the candidate/obstacle
 * search, evaluated once at `s = 1`.
 *
 * ── One fixed sheet ─────────────────────────────────────────────────────────
 *
 * The drawing prints on exactly ONE sheet of `drawing.sheet` paper. Its
 * printable area (`sheetRect`) has its top-left at `contentOrigin`, which is
 * `drawing.sheetOrigin` — a fixed model point the user's layout is planned
 * against — or, while that is absent (a CLI-built document), the harness bbox
 * framed by `TEMPLATE_GUTTER` (`framedSheetOrigin`). The sheet never moves or
 * grows with the content: changing the paper grows it right and down from that
 * corner. Whatever lies outside it is flagged per item as
 * `outside-sheet:<kind>:<id>` and is cut off in the PDF — choosing a big enough
 * sheet is the user's call, not the planner's. (It used to be a tile grid that
 * grew with the content bbox; the user reversed that on 2026-10-27 because a
 * frame that moves on every drag cannot be planned against.) Every `rect` in a
 * `BoardPlan` is model mm.
 *
 * `doc.drawing.blocks` records where the user has DRAGGED a block. A pinned
 * block's rect is taken verbatim and becomes an obstacle for everything the
 * planner still gets to choose; an absent entry means "auto-place me". A pin
 * whose connector has no drawn body is ignored (a hand-edited file can carry a
 * stale id — the loader drops those too).
 *
 * Because the sheet is fixed, the title block (bottom-right of `sheetRect`) is
 * known before any block is placed, so it is simply one more obstacle in the
 * single placement pass. Unpinned blocks are only placed where they lie
 * entirely inside `sheetRect`; when no candidate spot does, the block takes its
 * usual fallback spot and is flagged like any other off-sheet item. A pinned
 * block is never moved — that position is the user's own doing — only warned
 * about.
 *
 * This module is pure and DOM-free: `template.ts` renders a plan, the formboard
 * canvas draws the same plan on screen. Nothing here imports `template.ts` —
 * `TEMPLATE_GUTTER` and `TILE_STRIP_H` live here and `template.ts` re-exports
 * them, so there is exactly one definition of each.
 */
import type { HarnessDocument, Id, ToleranceTable, Vec2 } from '../model/schema'
import { DEFAULT_TOLERANCE_TITLE } from '../model/schema'
import {
  computeFormboard,
  lengthLabel,
  labelDisplayText,
  BODY_DOT_R,
  LABEL_FONT,
  MIN_FONT,
  type FbBody,
  type FbLabel,
  type FbLayout,
  type FbSegment
} from '../model/formboard'
import { TEMPLATE_MARGIN, type Rect, type SheetMm } from './sheet'
import {
  TABLE_STYLE_SHEET,
  paginateRows,
  rowHeight,
  tableWidth,
  type Column,
  type Row,
  type TableStyle
} from './tables'
import {
  bomSheetTable,
  connectorPinouts,
  toleranceSheetTable,
  type ConnectorPinout,
  type TableSpec
} from './tableData'
import { isIdentityView, normaliseView, pictureBlockSize, type PartImage, type PartImages } from './picture'
import type { PictureView } from '../model/schema'
import { primaryPartNumber } from '../model/bodyParts'
import { TITLE_BLOCK_H, TITLE_BLOCK_W } from './titleBlock'
import { estimateTextWidthMm } from './text'

/**
 * The picture block's own size constants and image types are DEFINED in
 * `./picture` (which draws the block) and re-exported here because the planner
 * is where callers reach for block geometry — `board.ts` needs
 * `pictureBlockSize`, so `picture.ts` cannot import back from here. One
 * definition, two import paths — the same arrangement as `TEMPLATE_GUTTER`.
 */
export { PICTURE_W, PICTURE_MAX_H, type PartImage, type PartImages } from './picture'
/** Re-exported for the callers that already take everything picture-shaped from the planner. */
export type { PictureView } from '../model/schema'

// ── Public shape ─────────────────────────────────────────────────────────────

/** A planned drawing block (pinout table, BOM summary, length tolerances or part picture) in MODEL mm. */
export interface PlacedBlock {
  kind: 'pinout' | 'bom' | 'tolerance' | 'picture'
  /**
   * Pinout: connector / free-terminal id. BOM: `BOM_BLOCK_ID`. Tolerance:
   * `TOLERANCE_BLOCK_ID`. Picture: the body id (connector, free terminal or
   * splice).
   */
  id: Id
  rect: Rect
  /** Tables only — a picture block has no table to draw. */
  spec?: TableSpec
  /** True when the rect came from `doc.drawing.blocks` verbatim. */
  pinned: boolean
  /** Picture only: the photo to draw. */
  image?: PartImage
  /** Picture only: the caption under the photo (the body's designator). */
  caption?: string
  /**
   * Picture only: the document's orientation for this body's photo, NORMALISED
   * and absent when it is the identity. The rect above was sized with it, so a
   * renderer must draw with the same view or the photo will not fit its frame.
   */
  view?: PictureView
  /** Banner text, when the block is drawn with a title row. */
  title?: string
  /** BOM only: rows were dropped to fit, with a `see BOM page` marker row. */
  truncated?: boolean
}

export interface BoardPlan {
  /**
   * The paper the drawing is printed on. Carried on the plan (rather than
   * passed alongside it) because everything else here is DERIVED from it:
   * `printable` is `printableSize(sheet)` and `sheetRect` follows from that. A
   * renderer handed a plan and a separate, mismatched sheet would draw the
   * wrong area at the wrong page size without a word of complaint.
   */
  sheet: SheetMm
  /** The sheet's printable area (mm), i.e. `printableSize(sheet)`. */
  printable: { w: number; h: number }
  /**
   * Model mm of the printable area's top-left: `drawing.sheetOrigin`, else
   * `framedSheetOrigin(layout)`.
   */
  contentOrigin: Vec2
  /** The printable area in model mm: `{ ...contentOrigin, w: printable.w, h: printable.h }`. */
  sheetRect: Rect
  tables: PlacedBlock[]
  bom: PlacedBlock
  /** The length-tolerance block; absent when the drawing has no `toleranceTable`. */
  tolerance?: PlacedBlock
  /** One part-picture block per body whose primary part has an image. */
  pictures: PlacedBlock[]
  /**
   * Bodies that got NO picture — their primary part is unknown or has no image
   * in the library. The UI offers these an "import a photo" prompt; an empty
   * `images` map therefore lists every drawn body.
   */
  bodiesWithoutPicture: Id[]
  /** Model mm, `TITLE_BLOCK_W × TITLE_BLOCK_H`, in the bottom-right corner of `sheetRect`. */
  titleBlockRect: Rect
  /**
   * `table-overlap:<id>` — that table OR PICTURE prints on top of a body or
   * another block. (The name predates picture blocks; the UI text says
   * "block".)
   * `table-over-wire:<id>` — that table or picture prints on top of a wire run
   * or its gauge/length label.
   * `title-block-over-content` — the title-block rect covers a body, a wire
   * run/label or any block. Unpinned blocks dodge it, so in practice this is a
   * pinned block, a body or a wire the user put there.
   * `outside-sheet:<kind>:<id>` — that item is not entirely inside `sheetRect`,
   * so it will be cut off the print. `kind` is `body` / `branch` (the dot's
   * position), `segment` (either end), `label` (its resolved position) or
   * `block` — its rect; the code is `outside-sheet:block:<kind>:<id>` with
   * `kind` = `PlacedBlock.kind` (`pinout` / `picture` / `bom` / `tolerance`)
   * because a body's pinout table and its picture share the body id (BOM:
   * `block:bom:bom`, tolerances: `block:tolerance:tolerance`).
   * All re-derived from the final geometry, so none of them can go stale.
   */
  warnings: string[]
}

/** `PlacedBlock.id` of the BOM summary block. */
export const BOM_BLOCK_ID = 'bom'
/** `PlacedBlock.id` of the length-tolerance block. */
export const TOLERANCE_BLOCK_ID = 'tolerance'

/** mm of white space kept around the content bbox on all sides (content-space gutter). */
export const TEMPLATE_GUTTER = 15
/**
 * Height (mm) of the info strip at the bottom of the drawing page, below the
 * printable area. Two rows: the page-space 100 mm scale bar on top, the
 * label/verify captions below.
 */
export const TILE_STRIP_H = 13

/** Clearance from a body to its pinout table (mm). */
export const TABLE_GAP = 8
/** Reserved slack around a pinout table's width (mm). */
export const TABLE_PAD = 2
/** Fraction of the sheet's printable width/height the BOM block may occupy. */
export const BOM_BLOCK_MAX_W_FRAC = 0.45
export const BOM_BLOCK_MAX_H_FRAC = 0.25

/** The sheet's printable area: the paper minus the printer margin and the info strip. */
export function printableSize(sheet: SheetMm): { w: number; h: number } {
  return { w: sheet.wMm - 2 * TEMPLATE_MARGIN, h: sheet.hMm - 2 * TEMPLATE_MARGIN - TILE_STRIP_H }
}

// ── Placement knobs (from drawingSheet.ts, at scale 1) ───────────────────────

/** Step by which a rejected opposite-side candidate is pushed further out (mm). */
const PUSH_STEP = 10
/** How many times to push out before giving up. */
const PUSH_TRIES = 5
/** Minimum clearance between a block and any body/block (mm). */
const CLEARANCE = 1
/**
 * Clearance between a block and a wire run / run label (mm). The rect is
 * inflated by this before the run is tested against it, so a table that merely
 * grazes a wire is rejected too.
 */
export const WIRE_CLEARANCE = 1.5

/** Containment slack for the inside-the-sheet tests (mm). */
const EPS = 1e-9

/** True when `r` lies entirely inside `outer` (to `EPS`). */
function inside(r: Rect, outer: Rect): boolean {
  return (
    r.x >= outer.x - EPS &&
    r.y >= outer.y - EPS &&
    r.x + r.w <= outer.x + outer.w + EPS &&
    r.y + r.h <= outer.y + outer.h + EPS
  )
}

/** True when the point lies inside `outer` (to `EPS`). */
function pointInside(p: Vec2, outer: Rect): boolean {
  return inside({ x: p.x, y: p.y, w: 0, h: 0 }, outer)
}

/** True when the rects overlap or sit closer than `CLEARANCE` in both axes. */
export function collides(a: Rect, b: Rect): boolean {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return ox > -CLEARANCE && oy > -CLEARANCE
}

// ── Wire runs as obstacles ───────────────────────────────────────────────────
//
// A pinout table dropped on a wire hides exactly what the drawing exists to
// show, so the runs — and the gauge/length text drawn at each run's midpoint —
// join the bodies and the other blocks as things a candidate must dodge.
//
// A run is tested as a LINE, not as its bounding box: a long diagonal's AABB
// covers most of the sheet, which would reject every candidate. `runHitsRect`
// is the Liang–Barsky slab clip.

/** A wire run as a line in model mm. */
interface RunLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

interface WireObstacles {
  runs: RunLine[]
  /** Run-label and sleeve-callout AABBs (mm). Both print at a constant `MIN_FONT`. */
  labels: Rect[]
}

/** Does the line intersect (or lie inside) the rect? Liang–Barsky parametric clip. */
function runHitsRect(l: RunLine, r: Rect): boolean {
  const dx = l.x2 - l.x1
  const dy = l.y2 - l.y1
  const p = [-dx, dx, -dy, dy]
  const q = [l.x1 - r.x, r.x + r.w - l.x1, l.y1 - r.y, r.y + r.h - l.y1]
  let t0 = 0
  let t1 = 1
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      // Parallel to this slab: outside it means no intersection at all.
      if (q[i] < 0) return false
    } else {
      const t = q[i] / p[i]
      if (p[i] < 0) {
        if (t > t1) return false
        if (t > t0) t0 = t
      } else {
        if (t < t0) return false
        if (t < t1) t1 = t
      }
    }
  }
  return true
}

/**
 * Every wire run and run label in model mm. Mirrors what `renderDrawingGroup`
 * actually draws: a bundle segment is labelled with its wire count, a
 * single-wire segment with `lengthLabel(length)`, and the text sits with its
 * baseline on the run's midpoint.
 */
function wireObstacles(layout: FbLayout): WireObstacles {
  const runs: RunLine[] = []
  const labels: Rect[] = []
  for (const seg of layout.segments) {
    runs.push({ x1: seg.a.x, y1: seg.a.y, x2: seg.b.x, y2: seg.b.y })
    const r = segmentLabelRect(seg)
    if (r) labels.push(r)
  }
  // A sleeve's callout is text beside the run, read with it like a run label.
  for (const t of layout.treatments) for (const c of t.callouts ?? []) labels.push(c.rect)
  return { runs, labels }
}

/**
 * A run's label box (wire count on a bundle, `lengthLabel(length)` on a
 * single wire), centred over the run's midpoint with its baseline there; null
 * when the run draws no label.
 */
function segmentLabelRect(seg: FbSegment): Rect | null {
  const text = seg.bundle ? String(seg.wireIds.length) : lengthLabel(seg.lengthMm)
  if (!text) return null
  const midX = (seg.a.x + seg.b.x) / 2
  const midY = (seg.a.y + seg.b.y) / 2
  const w = estimateTextWidthMm(text, MIN_FONT)
  const h = MIN_FONT * 1.4
  return { x: midX - w / 2, y: midY - h, w, h }
}

/**
 * A free / anchored label's text box as `renderDrawingGroup` draws it:
 * start-anchored at `pos`, baseline on `pos.y`, `MIN_FONT`, the kind-prefixed
 * display text (a descender allowance of 0.2 em below the baseline).
 */
function freeLabelRect(l: FbLabel): Rect {
  const w = estimateTextWidthMm(labelDisplayText(l.kind, l.text), MIN_FONT)
  return { x: l.pos.x, y: l.pos.y - MIN_FONT, w, h: MIN_FONT * 1.2 }
}

/** True when the rect (inflated by `WIRE_CLEARANCE`) touches a run or a run label. */
function hitsWire(r: Rect, o: WireObstacles): boolean {
  const inf: Rect = {
    x: r.x - WIRE_CLEARANCE,
    y: r.y - WIRE_CLEARANCE,
    w: r.w + 2 * WIRE_CLEARANCE,
    h: r.h + 2 * WIRE_CLEARANCE
  }
  return (
    o.runs.some((l) => runHitsRect(l, inf)) ||
    o.labels.some((b) => inf.x < b.x + b.w && b.x < inf.x + inf.w && inf.y < b.y + b.h && b.y < inf.y + inf.h)
  )
}

// ── Table sizing and candidate spots ─────────────────────────────────────────

/** Rendered height of a table: optional title banner + header row + body rows. */
function tableHeight(spec: TableSpec, style: TableStyle, hasTitle: boolean): number {
  const rows = spec.rows.reduce((s, r) => s + rowHeight(r, spec.cols, style), 0)
  return (hasTitle ? style.headerH : 0) + style.headerH + rows
}

/** One possible resting place for a table: top-left = `(ax + ox, ay + oy)`. */
interface Candidate {
  ax: number
  ox: number
  ay: number
  oy: number
}

type Side = 'left' | 'right' | 'top' | 'bottom'

/**
 * The side of the dot facing AWAY from its wires: the negated sum of unit
 * vectors toward the far end of every segment that starts or ends on the dot,
 * snapped to the dominant axis. No segments → 'left'.
 */
function awaySide(b: FbBody, layout: FbLayout): Side {
  let sx = 0
  let sy = 0
  const same = (p: Vec2): boolean => Math.abs(p.x - b.pos.x) < 1e-6 && Math.abs(p.y - b.pos.y) < 1e-6
  for (const s of layout.segments) {
    const far = same(s.a) ? s.b : same(s.b) ? s.a : null
    if (!far) continue
    const dx = far.x - b.pos.x
    const dy = far.y - b.pos.y
    const len = Math.hypot(dx, dy)
    if (len === 0) continue
    sx += dx / len
    sy += dy / len
  }
  if (sx === 0 && sy === 0) return 'left'
  return Math.abs(sx) >= Math.abs(sy) ? (sx > 0 ? 'left' : 'right') : sy > 0 ? 'top' : 'bottom'
}

/**
 * Candidate resting places, best first: `side` (the dot's away side), then
 * above, then below, then `side` pushed further out, then above and below
 * pushed further out. Each table is CENTRED on
 * the dot in the free axis and offset from the body's own FOOTPRINT — the dot
 * union its label — in the other.
 *
 * Offsetting from the dot alone (3.6 mm across) is not enough: the label sits
 * up-and-right of the dot, so a right-side first choice landed on the
 * designator whenever the text was long enough to reach past `TABLE_GAP` —
 * `X1` cleared it and `ring` did not, which made the away side win or lose on
 * the length of a string.
 */
function candidates(b: FbBody, side: Side, w: number, h: number): Candidate[] {
  const own = union(bodyRect(b), bodyLabelRect(b))
  const centredX = { ax: b.pos.x, ox: -w / 2 }
  const centredY = { ay: b.pos.y, oy: -h / 2 }
  const above: Candidate = { ...centredX, ay: own.y, oy: -(TABLE_GAP + h) }
  const below: Candidate = { ...centredX, ay: own.y + own.h, oy: TABLE_GAP }

  /** The away side, pushed `n · PUSH_STEP` mm further out. */
  const opposite = (n: number): Candidate => {
    const out = TABLE_GAP + n * PUSH_STEP
    switch (side) {
      case 'left':
        return { ax: own.x, ox: -(out + w), ...centredY }
      case 'right':
        return { ax: own.x + own.w, ox: out, ...centredY }
      case 'top':
        return { ...centredX, ay: own.y, oy: -(out + h) }
      case 'bottom':
        return { ...centredX, ay: own.y + own.h, oy: out }
    }
  }

  const list = [opposite(0), above, below]
  for (let n = 1; n <= PUSH_TRIES; n++) list.push(opposite(n))
  // Last resort before giving up: above and below, pushed further out too. On
  // a fixed sheet a body near its edge can lose the away side and both
  // centred spots at once; further out above/below is often still on paper.
  for (let n = 1; n <= PUSH_TRIES; n++) {
    list.push({ ...above, oy: above.oy - n * PUSH_STEP }, { ...below, oy: below.oy + n * PUSH_STEP })
  }
  return list
}

const at = (c: Candidate, w: number, h: number): Rect => ({ x: c.ax + c.ox, y: c.ay + c.oy, w, h })

/**
 * Furthest (mm) a candidate may be slid to get it onto the sheet — the same
 * reach as pushing a candidate out (`PUSH_TRIES · PUSH_STEP`). A block slid
 * further than this would no longer read as belonging to its dot: a body
 * metres off the sheet would get its table parked on the sheet edge with no
 * warning, when it should stay beside its body and be flagged.
 */
const MAX_CLAMP_SHIFT = PUSH_TRIES * PUSH_STEP

/**
 * `r` slid the least distance that puts it inside `outer`, or `null` when that
 * slide is longer than `MAX_CLAMP_SHIFT`. A rect larger than `outer` in an axis
 * is aligned to its top/left edge (and still does not fit).
 */
function clampInto(r: Rect, outer: Rect): Rect | null {
  const x = Math.max(outer.x, Math.min(r.x, outer.x + outer.w - r.w))
  const y = Math.max(outer.y, Math.min(r.y, outer.y + outer.h - r.h))
  if (Math.hypot(x - r.x, y - r.y) > MAX_CLAMP_SHIFT) return null
  return { ...r, x, y }
}

/** A body's dot as an obstacle rect. */
export function bodyRect(b: FbBody): Rect {
  return { x: b.pos.x - BODY_DOT_R, y: b.pos.y - BODY_DOT_R, w: 2 * BODY_DOT_R, h: 2 * BODY_DOT_R }
}

/** A body's label text box as an obstacle rect. */
export function bodyLabelRect(b: FbBody): Rect {
  const w = estimateTextWidthMm(b.label, LABEL_FONT)
  return { x: b.labelPos.x, y: b.labelPos.y - LABEL_FONT / 2, w, h: LABEL_FONT }
}

/**
 * All body obstacles: the dots and their labels. A dot is 3.6 mm across, so
 * without the labels a table could land squarely on the designator that says
 * which connector it belongs to.
 */
function bodyObstacles(layout: FbLayout): Rect[] {
  return layout.bodies.flatMap((b) => [bodyRect(b), bodyLabelRect(b)])
}

/** Union of two rects. */
function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

interface SizedPinout {
  nodeId: Id
  spec: TableSpec
  body: FbBody
  w: number
  h: number
}

/**
 * The pinouts that have a body to sit beside, with their drawn size. The order
 * is `connectorPinouts`' own (designator-sorted, deterministic) and it defines
 * the order of `BoardPlan.tables`.
 */
function sizedPinouts(layout: FbLayout, pinouts: ConnectorPinout[]): SizedPinout[] {
  const bodyById = new Map(layout.bodies.map((b) => [b.id, b]))
  const out: SizedPinout[] = []
  for (const p of pinouts) {
    // A pinout with no drawn body (an unplaced connector or free terminal) has
    // nothing to sit beside — the drawing simply does not show it.
    const body = bodyById.get(p.nodeId)
    if (!body) continue
    out.push({
      nodeId: p.nodeId,
      spec: p.table,
      body,
      w: tableWidth(p.table.cols) + TABLE_PAD,
      h: tableHeight(p.table, TABLE_STYLE_SHEET, false)
    })
  }
  return out
}

interface SizedPicture {
  nodeId: Id
  body: FbBody
  image: PartImage
  caption: string
  w: number
  h: number
  /** Normalised; absent for the identity view. */
  view?: PictureView
}

/**
 * The caption under a picture: the body's own designator (X1 / T1 / SP1). NOT
 * `FbBody.label`, which appends the body's BOM item numbers — those already
 * print beside the dot and would only crowd a 30 mm frame.
 */
function designatorOf(doc: HarnessDocument, b: FbBody): string {
  switch (b.kind) {
    case 'connector':
      return doc.connectors.find((c) => c.id === b.id)?.designator ?? b.id
    case 'terminal':
      return doc.freeTerminals.find((f) => f.id === b.id)?.designator ?? b.id
    case 'splice':
      return doc.splices.find((s) => s.id === b.id)?.designator ?? b.id
  }
}

/**
 * The bodies that have a part photo, with the drawn size of their block — and
 * the ones that do not, for the UI to offer an import. A body's picture is
 * keyed by its PRIMARY part number (`bodyParts.ts`: connector housing, terminal
 * part, splice part), so a body with no part number never has one. The order is
 * `layout.bodies`' own and it defines the order of `BoardPlan.pictures`.
 */
function sizedPictures(
  doc: HarnessDocument,
  layout: FbLayout,
  images: PartImages
): { pics: SizedPicture[]; without: Id[] } {
  const pics: SizedPicture[] = []
  const without: Id[] = []
  const views = doc.drawing.blocks?.pictureView ?? {}
  for (const b of layout.bodies) {
    const pn = primaryPartNumber(doc, b.id)
    const img = pn ? images[pn] : undefined
    if (!img) {
      without.push(b.id)
      continue
    }
    // A turned photo has a different bounding box, so the ROTATED size is what
    // the rect must reserve — a block sized upright and drawn on its side would
    // print outside its own frame.
    const view = normaliseView(views[b.id] ?? {})
    const { w, h } = pictureBlockSize(img, view)
    pics.push({
      nodeId: b.id,
      body: b,
      image: img,
      caption: designatorOf(doc, b),
      w,
      h,
      ...(isIdentityView(view) ? {} : { view })
    })
  }
  return { pics, without }
}

/**
 * Pinned blocks verbatim, then auto-placed ones dodging bodies, wires and
 * everything already placed, and staying inside `bounds` (the sheet's
 * printable area). Tables and pictures share ONE `placed` list — the
 * whole point, since both sit beside the same dots — and are visited pinned
 * first (a pin is the user's own doing and never moves, so it is an obstacle
 * for everyone else), tables before pictures within each group so that adding a
 * picture library never moves a table an existing drawing already placed.
 */
function placeBlocks(
  layout: FbLayout,
  pinouts: ConnectorPinout[],
  pictures: SizedPicture[],
  pins: Record<Id, Vec2>,
  picPins: Record<Id, Vec2>,
  extra: Rect[],
  bounds: Rect
): { tables: PlacedBlock[]; pictures: PlacedBlock[] } {
  const bodies = bodyObstacles(layout)
  const wires = wireObstacles(layout)
  const sized = sizedPinouts(layout, pinouts)
  const tables: PlacedBlock[] = []
  const pics: PlacedBlock[] = []
  const placed: Rect[] = [...extra]

  /**
   * The first candidate spot around the body that is clear and on the sheet,
   * else the best one. The candidates are tried as they are first, then each
   * one slid into `bounds` (`clampInto`, at most `MAX_CLAMP_SHIFT`) — a body
   * near the sheet edge has no centred spot that fits, but a table nudged
   * along that edge still sits beside its own dot. A body far off the sheet
   * gets no slid candidate at all, so its block falls back beside it and is
   * flagged.
   */
  const search = (body: FbBody, w: number, h: number): Rect => {
    const rects = candidates(body, awaySide(body, layout), w, h).map((c) => at(c, w, h))
    const slid = rects.map((r) => clampInto(r, bounds)).filter((r): r is Rect => r !== null)
    const clear = [...rects, ...slid].find(
      (r) =>
        inside(r, bounds) &&
        !bodies.some((b) => collides(r, b)) &&
        !placed.some((q) => collides(r, q)) &&
        !hitsWire(r, wires)
    )
    // Whether this pick was clear is deliberately NOT recorded — `planBoard`
    // re-derives every overlap and outside-sheet warning from the final
    // geometry.
    return clear ?? rects[0]
  }

  const take = (rect: Rect): Rect => {
    placed.push(rect)
    return rect
  }
  const tableBlock = (s: SizedPinout, rect: Rect, pinned: boolean): PlacedBlock => ({
    kind: 'pinout',
    id: s.nodeId,
    rect,
    spec: s.spec,
    pinned
  })
  const pictureBlock = (s: SizedPicture, rect: Rect, pinned: boolean): PlacedBlock => ({
    kind: 'picture',
    id: s.nodeId,
    rect,
    pinned,
    image: s.image,
    caption: s.caption,
    ...(s.view ? { view: s.view } : {})
  })

  for (const s of sized) {
    const pin = pins[s.nodeId]
    if (pin) tables.push(tableBlock(s, take({ x: pin.x, y: pin.y, w: s.w, h: s.h }), true))
  }
  for (const s of pictures) {
    const pin = picPins[s.nodeId]
    if (pin) pics.push(pictureBlock(s, take({ x: pin.x, y: pin.y, w: s.w, h: s.h }), true))
  }
  for (const s of sized) {
    if (!pins[s.nodeId]) tables.push(tableBlock(s, take(search(s.body, s.w, s.h)), false))
  }
  for (const s of pictures) {
    if (!picPins[s.nodeId]) pics.push(pictureBlock(s, take(search(s.body, s.w, s.h)), false))
  }

  // Keep the input order so the plan is stable for the UI.
  const inOrder = (list: PlacedBlock[], order: Map<Id, number>): PlacedBlock[] =>
    list.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  return {
    tables: inOrder(tables, new Map(sized.map((s, i) => [s.nodeId, i]))),
    pictures: inOrder(pics, new Map(pictures.map((s, i) => [s.nodeId, i])))
  }
}

/**
 * The BOM summary block. Height is truncated to `BOM_BLOCK_MAX_H_FRAC` of the
 * sheet's printable area with a trailing "see BOM page" row; width is held to
 * `BOM_BLOCK_MAX_W_FRAC` by narrowing the columns proportionally, so `rect.w`
 * is always exactly the width the table is drawn at.
 *
 * Default position: below the harness, left-aligned to its bbox, pushed further
 * down in `PUSH_STEP`s while it fouls a table, a body or a wire. Every spot
 * must also lie inside `bounds`; when none of those does, the sheet's free
 * corners (bottom-left, top-left, top-right — the title block owns
 * bottom-right) are tried, and if they fail too the block keeps the last
 * pushed-down spot and is flagged as off the sheet.
 */
function planBom(
  doc: HarnessDocument,
  printable: { w: number; h: number },
  harness: Rect,
  obstacles: Rect[],
  layout: FbLayout,
  pin: Vec2 | undefined,
  bounds: Rect
): PlacedBlock {
  const style = TABLE_STYLE_SHEET
  const full = bomSheetTable(doc)

  // Width first: the columns are what gets drawn, so narrow them rather than
  // letting the block overflow a rect that claims to be narrower.
  const maxW = printable.w * BOM_BLOCK_MAX_W_FRAC
  const natural = tableWidth(full.cols)
  const cols: Column[] =
    natural > maxW ? full.cols.map((c) => ({ ...c, wMm: (c.wMm * maxW) / natural })) : full.cols
  const w = tableWidth(cols)

  const maxH = printable.h * BOM_BLOCK_MAX_H_FRAC
  let spec: TableSpec = { cols, rows: full.rows }
  let truncated = false
  if (tableHeight(spec, style, true) > maxH) {
    // paginateRows budgets for the header row only, so hand it the space left
    // under the title banner.
    const first = paginateRows(spec.rows, cols, style, maxH - style.headerH)[0]
    const marker: Row = { id: '…', type: 'see BOM page' }
    spec = { cols, rows: [...first.slice(0, -1), marker] }
    truncated = true
  }

  const h = Math.min(tableHeight(spec, style, true), maxH)

  let rect: Rect = pin
    ? { x: pin.x, y: pin.y, w, h }
    : { x: harness.x, y: harness.y + harness.h + TABLE_GAP, w, h }
  if (!pin) {
    const wires = wireObstacles(layout)
    const bodies = bodyObstacles(layout)
    const clear = (r: Rect): boolean =>
      inside(r, bounds) &&
      !obstacles.some((o) => collides(r, o)) &&
      !bodies.some((b) => collides(r, b)) &&
      !hitsWire(r, wires)
    const below: Rect[] = [rect]
    for (let n = 1; n <= PUSH_TRIES; n++) below.push({ ...rect, y: rect.y + n * PUSH_STEP })
    const corners: Rect[] = [
      { x: bounds.x, y: bounds.y + bounds.h - h, w, h },
      { x: bounds.x, y: bounds.y, w, h },
      { x: bounds.x + bounds.w - w, y: bounds.y, w, h }
    ]
    rect = [...below, ...corners].find(clear) ?? below[below.length - 1]
    // If nothing is clear the block stays where it landed and is NOT warned
    // about for overlaps: unlike a pinout table, the BOM block carries no
    // positional meaning, so an overlap here is a cosmetic nuisance the user
    // fixes by dragging it — not a wrong drawing. Only pinout tables get
    // `table-overlap:` / `table-over-wire:`. Off the sheet it IS flagged
    // (`outside-sheet:block:bom:bom`), since then it does not print at all.
  }
  return {
    kind: 'bom',
    id: BOM_BLOCK_ID,
    rect,
    spec,
    pinned: !!pin,
    title: 'Bill of Materials',
    truncated
  }
}

/**
 * The length-tolerance block, at its natural size (a handful of rows, so it is
 * never truncated). Default position: right above the title block, flush with
 * its right edge — where a drawing's general tolerances are looked for — then
 * beside the BOM block, then the sheet's free corners (top-right, top-left,
 * bottom-left); the first spot inside `bounds` and clear of every block, body
 * and wire wins, else the first. Like the BOM block it carries no positional
 * meaning, so it is only flagged when it leaves the sheet, never for an overlap.
 */
function planTolerance(
  table: ToleranceTable,
  obstacles: Rect[],
  layout: FbLayout,
  pin: Vec2 | undefined,
  bounds: Rect,
  titleBlock: Rect,
  bom: Rect
): PlacedBlock {
  const spec = toleranceSheetTable(table)
  const w = tableWidth(spec.cols)
  const h = tableHeight(spec, TABLE_STYLE_SHEET, true)
  const aboveTitle: Rect = { x: titleBlock.x + titleBlock.w - w, y: titleBlock.y - TABLE_GAP - h, w, h }
  let rect: Rect = pin ? { x: pin.x, y: pin.y, w, h } : aboveTitle
  if (!pin) {
    const wires = wireObstacles(layout)
    const bodies = bodyObstacles(layout)
    const clear = (r: Rect): boolean =>
      inside(r, bounds) &&
      !obstacles.some((o) => collides(r, o)) &&
      !bodies.some((b) => collides(r, b)) &&
      !hitsWire(r, wires)
    const candidates: Rect[] = [
      aboveTitle,
      { x: bom.x + bom.w + TABLE_GAP, y: bom.y, w, h },
      { x: bounds.x + bounds.w - w, y: bounds.y, w, h },
      { x: bounds.x, y: bounds.y, w, h },
      { x: bounds.x, y: bounds.y + bounds.h - h, w, h }
    ]
    rect = candidates.find(clear) ?? aboveTitle
  }
  return {
    kind: 'tolerance',
    id: TOLERANCE_BLOCK_ID,
    rect,
    spec,
    pinned: !!pin,
    title: table.title ?? DEFAULT_TOLERANCE_TITLE
  }
}

/**
 * The sheet origin that frames the HARNESS: its bbox (bodies, branch points,
 * labels — never the blocks) less `TEMPLATE_GUTTER` on the top and left. This
 * is where the sheet sits while `drawing.sheetOrigin` is absent, and the value
 * the app pins into a document that has none.
 */
export function framedSheetOrigin(layout: FbLayout): Vec2 {
  return { x: layout.bbox.minX - TEMPLATE_GUTTER, y: layout.bbox.minY - TEMPLATE_GUTTER }
}

/**
 * Plan the whole 1:1 board: pinout tables, part pictures, BOM block, the
 * length-tolerance block (when the drawing has one), the one drawing sheet and
 * its title block, all in model mm. `layout` is injectable so
 * a caller that already ran `computeFormboard` does not pay for it twice.
 * `images` is the part photo library keyed by part number — the default empty
 * map means no picture blocks at all.
 */
export function planBoard(
  doc: HarnessDocument,
  sheet: SheetMm,
  layout: FbLayout = computeFormboard(doc),
  images: PartImages = {}
): BoardPlan {
  const printable = printableSize(sheet)
  const pinouts = connectorPinouts(doc)
  const pins = doc.drawing.blocks?.pinout ?? {}
  const picPins = doc.drawing.blocks?.picture ?? {}
  const { pics, without } = sizedPictures(doc, layout, images)
  const harness: Rect = {
    x: layout.bbox.minX,
    y: layout.bbox.minY,
    w: layout.bbox.maxX - layout.bbox.minX,
    h: layout.bbox.maxY - layout.bbox.minY
  }

  const contentOrigin = doc.drawing.sheetOrigin ?? framedSheetOrigin(layout)
  const sheetRect: Rect = { ...contentOrigin, w: printable.w, h: printable.h }
  const titleBlockRect: Rect = {
    x: sheetRect.x + sheetRect.w - TITLE_BLOCK_W,
    y: sheetRect.y + sheetRect.h - TITLE_BLOCK_H,
    w: TITLE_BLOCK_W,
    h: TITLE_BLOCK_H
  }

  // One pass: the title block is fixed with the sheet, so it is an obstacle
  // from the start.
  const extra = [titleBlockRect]
  const { tables, pictures } = placeBlocks(layout, pinouts, pics, pins, picPins, extra, sheetRect)
  const bom = planBom(
    doc,
    printable,
    harness,
    [...tables.map((t) => t.rect), ...pictures.map((p) => p.rect), ...extra],
    layout,
    doc.drawing.blocks?.bom,
    sheetRect
  )
  const toleranceTable = doc.drawing.toleranceTable
  const tolerance = toleranceTable
    ? planTolerance(
        toleranceTable,
        [...tables.map((t) => t.rect), ...pictures.map((p) => p.rect), ...extra, bom.rect],
        layout,
        doc.drawing.blocks?.tolerance,
        sheetRect,
        titleBlockRect,
        bom.rect
      )
    : undefined

  // ── Warnings, from the final geometry ─────────────────────────────────────
  const warnings: string[] = []
  const bodies = bodyObstacles(layout)
  const wires = wireObstacles(layout)
  const all = [...tables, ...pictures, bom, ...(tolerance ? [tolerance] : [])]
  all.forEach((t, i) => {
    // The BOM and tolerance blocks carry no positional meaning, so an overlap
    // there is a cosmetic nuisance the user drags away, not a wrong drawing
    // (see `planBom`). A table or a picture belongs to a specific body, so it is.
    if (t.kind === 'bom' || t.kind === 'tolerance') return
    const hitsBody = bodies.some((b) => collides(t.rect, b))
    const hitsOther = all.some((o, j) => j !== i && collides(t.rect, o.rect))
    if (hitsBody || hitsOther) warnings.push(`table-overlap:${t.id}`)
    if (hitsWire(t.rect, wires)) warnings.push(`table-over-wire:${t.id}`)
  })
  const tbHits =
    bodies.some((b) => collides(titleBlockRect, b)) ||
    hitsWire(titleBlockRect, wires) ||
    all.some((b) => collides(titleBlockRect, b.rect))
  if (tbHits) warnings.push('title-block-over-content')

  // Everything that would be cut off the one printed sheet — by its drawn
  // EXTENT (dot + designator, run + its label, label text), not by an anchor
  // point, so nothing is silently clipped off the PDF. One warning per entity.
  for (const b of layout.bodies) {
    if (!inside(bodyRect(b), sheetRect) || !inside(bodyLabelRect(b), sheetRect)) {
      warnings.push(`outside-sheet:body:${b.id}`)
    }
  }
  for (const bp of layout.branchPoints) {
    if (!pointInside(bp.pos, sheetRect)) warnings.push(`outside-sheet:branch:${bp.id}`)
  }
  for (const seg of layout.segments) {
    const label = segmentLabelRect(seg)
    if (
      !pointInside(seg.a, sheetRect) ||
      !pointInside(seg.b, sheetRect) ||
      (label !== null && !inside(label, sheetRect))
    ) {
      warnings.push(`outside-sheet:segment:${seg.id}`)
    }
  }
  for (const l of layout.labels) {
    const offBead = l.bead !== undefined && !pointInside(l.bead, sheetRect)
    if (!inside(freeLabelRect(l), sheetRect) || offBead) warnings.push(`outside-sheet:label:${l.id}`)
  }
  for (const b of all) {
    if (!inside(b.rect, sheetRect)) warnings.push(`outside-sheet:block:${b.kind}:${b.id}`)
  }

  return {
    sheet,
    printable,
    contentOrigin,
    sheetRect,
    tables,
    bom,
    ...(tolerance ? { tolerance } : {}),
    pictures,
    bodiesWithoutPicture: without,
    titleBlockRect,
    warnings
  }
}
