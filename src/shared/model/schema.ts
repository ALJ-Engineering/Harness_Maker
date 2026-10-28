/**
 * Wire harness editor — data schema (draft v0.1)
 *
 * LIVE SOURCE OF TRUTH for the running app. Mirrors docs/harness-schema.ts
 * (the design-spec snapshot). When you change shapes here, update the spec doc
 * + docs/harness-schema.ts in the same change so they don't drift.
 *
 * Two layers, one document:
 *   1. ELECTRICAL MODEL — connectivity + parts. The source of truth. No geometry.
 *   2. LAYOUT OVERLAY   — geometry in millimetres. References electrical entities
 *                         by id only. Drives the drawing and 1:1 print.
 *   3. ANNOTATIONS      — physical treatments (sleeving, twist) and labels that
 *                         bridge the two (reference electrical, carry geometry).
 *
 * Rule: the electrical model never stores positions; the layout never stores
 * connectivity. The only link between them is stable ids.
 */

// ──────────────────────────────── Common ────────────────────────────────

/** Stable, opaque id (uuid / nanoid). Never reused, never derived from content. */
export type Id = string
export type Mm = number
export type Degrees = number

/** Pointer into the parts library. Library is truth. */
export interface PartRef {
  partNumber: string
  manufacturer?: string
  description?: string // cached for display only
}

export type GaugeUnit = 'mm2' | 'AWG'
export interface Gauge {
  value: number
  unit: GaugeUnit
}

/** IEC 60757 base colour + optional stripe(s). Store abbrev ("RD") or hex. */
export interface WireColor {
  base: string
  stripes?: string[] // e.g. ["WH"] => red/white
}

export interface Vec2 {
  x: Mm
  y: Mm
}

// ─────────────────────────── Electrical model ───────────────────────────

export type CavityStatus = 'populated' | 'plugged' | 'empty'

/** A position inside a connector housing. */
export interface Cavity {
  id: Id // global stable id (what endpoints reference)
  position: string // alphanumeric label on the housing: "1", "A", "A1"
  status: CavityStatus
  pin?: PartRef // terminal crimped in; required when status==="populated"
  seal?: PartRef // optional wire seal
  plug?: PartRef // cavity plug; used when status==="plugged"
}

export interface Connector {
  id: Id
  designator: string // reference designator: "X1", "J3"
  housing?: PartRef
  gender?: 'male' | 'female' | 'hybrid'
  mates?: Id // optional: connector this mates with
  cavities: Cavity[] // any number
  notes?: string
}

export type FreeTerminalKind =
  | 'ring'
  | 'ferrule'
  | 'eyelet'
  | 'blade'
  | 'fork'
  | 'bare'
  | 'tinned'

/** A wire end that is NOT in a connector (ring lug, ferrule, bare end, ...). */
export interface FreeTerminal {
  id: Id
  designator: string // reference designator: "T1" (electrical identity, never a position)
  kind: FreeTerminalKind
  part?: PartRef
  seal?: PartRef // e.g. heat-shrink ring terminal
  landsOn?: string // stud / post note: "B+ stud", "M6 GND"
}

export type SpliceKind = 'butt' | 'solder_sleeve' | 'clip' | 'weld' | 'ultrasonic'

/** A conductor junction. First-class endpoint. Degree is derived from wires. */
export interface Splice {
  id: Id
  designator: string // reference designator: "SP1"
  kind: SpliceKind
  part?: PartRef
}

/**
 * One end of a single conductor. The `type` discriminator is what lets pins,
 * splices, ring/ferrule terminals, and cable shields all be wire endpoints.
 */
export type Endpoint =
  | { type: 'cavity'; cavityId: Id } // a pin in a connector
  | { type: 'splice'; spliceId: Id }
  | { type: 'freeTerminal'; terminalId: Id }
  | { type: 'shield'; cableId: Id; end: 'a' | 'b' } // terminate a cable shield

/**
 * The conductor primitive: ONE cut length of ONE conductor between exactly two
 * endpoints. Connectivity is a multigraph — a cavity may appear in many wires.
 * "A wire with a splice in it" = two Wires that share the same Splice endpoint.
 * Electrical nets / continuity are DERIVED by graph traversal, not stored.
 */
export interface Wire {
  id: Id
  ends: [Endpoint, Endpoint]
  gauge: Gauge
  color: WireColor
  spec?: PartRef // wire part (alloy / insulation / rating)
  cableId?: Id // set on a cable core and on a drain built by addCableFromPart (legacy drains / shield terminations may lack it)
  coreName?: string // cable cores only: the library record's core name (identity beyond colour)
  corePair?: string // cable cores only: the library record's pair label; cores sharing it are twisted together
  specifiedLengthMm?: Mm // manual override of the 1:1 computed length; finite and ≥0 (0 = an explicit zero-length strap); absent = derive from the route
  addLengthMm?: Mm // strip/termination/service-loop allowance ADDED to the derived length; ignored if specifiedLengthMm set; finite and ≥0
  notes?: string
}

/** A purchased multi-core assembly: one part, one jacket, cut as one piece. */
export interface Cable {
  id: Id
  name: string // "CAN-1"
  part?: PartRef
  coreWireIds: Id[] // the Wire records that are this cable's cores
  jacketColor?: string
  twistedPair?: boolean // pre-twisted from the reel (vs. loose Twist treatment)
  specifiedLengthMm?: Mm // manual jacket cut length until jacket routing exists (mirrors Wire); finite and ≥0
  shield?: {
    present: boolean
    drainWireId?: Id // a Wire whose endpoint type is "shield"
  }
}

// ──────────────────────────── Layout overlay ────────────────────────────

export type PaperSize = 'A4' | 'A3' | 'A2' | 'A1' | 'A0' | 'Plotter'
export interface SheetConfig {
  paper: PaperSize
  orientation: 'portrait' | 'landscape'
  /** Roll length in mm — meaningful only for `'Plotter'` (the width is fixed at `PLOTTER_ROLL_WIDTH_MM`). */
  lengthMm?: number
}

export interface Approval {
  name?: string
  date?: string
}

export interface TitleBlock {
  title?: string
  partNumber?: string
  description?: string
  revision?: string
  drawnBy?: Approval
  engApproved?: Approval
  mfgApproved?: Approval
  qa?: Approval
  confidentiality?: string
}

/**
 * How a part picture is SHOWN for one body in THIS document — free-angle
 * rotation plus mirroring. Layout-layer geometry keyed by an electrical id: the
 * photo in the library is never touched, and another document showing the same
 * part is unaffected. Identity (upright, unmirrored) is stored as ABSENT, never
 * as a zeroed record.
 */
export interface PictureView {
  /** Clockwise on screen (SVG y-down convention), normalised to [0, 360). */
  rotationDeg?: number
  flipH?: boolean
  flipV?: boolean
}

/**
 * Where the user has parked a drawing block. LAYOUT layer: geometry keyed by an
 * electrical id, never connectivity. An absent entry means "auto-placed" — the
 * board planner (`print/board.ts`) picks a spot next to the connector.
 */
export interface DrawingBlocks {
  /** Pinned top-left of a pinout table, MODEL mm, keyed by connector or free-terminal id. */
  pinout?: Record<Id, Vec2>
  /** Pinned top-left of the BOM summary block, MODEL mm. */
  bom?: Vec2
  /** Pinned top-left of a part-picture block, MODEL mm, keyed by connector / free-terminal / splice id. */
  picture?: Record<Id, Vec2>
  /**
   * Orientation of a part-picture block, keyed by body id. Separate from
   * `picture` because the two are independent: an AUTO-placed picture can still
   * be rotated, and pinning one must not freeze its orientation.
   */
  pictureView?: Record<Id, PictureView>
}

export interface DrawingConfig {
  units: 'mm' // fixed
  printScale: 1 // 1:1 — never "fit to page"
  /** Paper for the one 1:1 DRAWING page. Document pages (BOM, wiring, cutlist) are always A4 landscape. */
  sheet: SheetConfig
  /** Model mm of the PRINTABLE area's top-left (the point `BoardPlan.contentOrigin` names). Absent = derived from content. */
  sheetOrigin?: Vec2
  /** @deprecated read-only compatibility; never written. */
  sheets?: SheetConfig[]
  titleBlock?: TitleBlock
  blocks?: DrawingBlocks
}

/** Position for any node-like electrical entity that occupies a point. */
export interface Placement {
  refId: Id // Connector | Splice | FreeTerminal | Cable (shield anchor)
  /** Formboard DOT CENTRE in model mm — every wire on this body lands here; drives routing and length. */
  pos: Vec2
  schematicPos?: Vec2 // schematic diagram position; falls back to `pos` if unset
  rotation?: Degrees // schematic only — a formboard dot has no rotation
  schematicExitSide?: 'left' | 'right' | 'top' | 'bottom' | 'nearest' // schematic pin exit side; falls back to right. 'nearest': each wire leaves its pin row on the side (left/right) facing its other end — inline parts
  schematicPinOrderReversed?: boolean // schematic only: mirror the symbol top↔bottom (last pin on top); absent = natural order
}

/** A routing vertex. Degree 2 = direction change; degree ≥3 = Y-split. */
export interface BranchPoint {
  id: Id
  pos: Vec2
  tie?: PartRef // optional tape/tie/cap at the branch (for BOM)
}

/**
 * A routing node is a branch point or a PLACED BODY. One body = one dot = one
 * anchor: a limb that reaches a connector reaches the connector, whichever
 * cavities its wires land in — that is `wireRoutes[].path`'s business. (Was
 * keyed per Endpoint before 0.4.0, which made N wires from one connector N
 * coincident segments; see the 2026-08-28 spec §1.1.)
 */
export type RouteNode =
  | { type: 'branch'; branchId: Id }
  | { type: 'body'; refId: Id }

/** An edge of the loom between two routing nodes — a "branch" / limb. Straight. */
export interface Segment {
  id: Id
  from: RouteNode
  to: RouteNode
  /**
   * Manufacturing length in mm, typed by the user. When set it OVERRIDES the drawn
   * (geometry-derived) length for the cut list, sleeving and tape; the drawing keeps
   * its geometry, and a mismatch of BROKEN_LENGTH_TOL_MM or more reads as "broken".
   */
  specifiedLengthMm?: number
  // geometry (and true 1:1 length) is derived from the two nodes' positions
}

/** A wire's physical path through the loom: ordered segments end[0] → end[1]. */
export interface WireRoute {
  wireId: Id
  path: Id[] // ordered Segment ids
}

/**
 * Loose wires loomed together over a set of segments. A BUILD grouping, not
 * electrical (contrast Cable, which is a part). Its segments form a tree;
 * it Y-splits at branch points.
 */
export interface Bundle {
  id: Id
  name?: string
  segmentIds: Id[]
  memberWireIds: Id[]
  /** Loom tape / spiral wrap consumed over this bundle's run. Optional: a bundle
   *  is a build grouping first — only a taped/wrapped one buys a part. Feeds one
   *  length-based BOM line (Σ of the member segments' lengths). */
  part?: PartRef
}

// ──────────────────────── Annotations / treatments ──────────────────────

/** A contiguous run along the loom, used by sleeving and twist spans. */
export interface Span {
  segmentIds: Id[] // contiguous
  startFraction?: number // 0..1 into the first segment (default 0)
  endFraction?: number // 0..1 into the last segment (default 1)
}

export type SleevingType = 'braided' | 'convoluted' | 'heatshrink' | 'pvc' | 'tape'

/** A covering over a SPAN (not the whole length — ends stay exposed for breakouts). */
export interface Sleeving {
  id: Id
  target:
    | { type: 'wire'; wireId: Id }
    | { type: 'bundle'; bundleId: Id }
    | { type: 'cable'; cableId: Id }
  span: Span
  sleevingType: SleevingType
  size?: string // ID / nominal diameter
  color?: string
  part?: PartRef
}

/** Twisted grouping of LOOSE wires (cables use Cable.twistedPair). */
export interface Twist {
  id: Id
  wireIds: Id[] // 2+ wires
  span: Span
  layLengthMm?: Mm // optional twist pitch spec
}

export type LabelTarget =
  | { type: 'wire'; wireId: Id }
  | { type: 'bundle'; bundleId: Id }
  | { type: 'branch'; segmentId: Id } // a limb of the loom
  | { type: 'branchPoint'; branchId: Id }

export type LabelKind = 'callout' | 'wireMarker' | 'flag' | 'heatshrinkPrint'

export interface Label {
  id: Id
  target: LabelTarget
  kind: LabelKind
  text: string
  pos: Vec2 // draggable position
  /**
   * Pins the label to a SEGMENT so it rides the loom (drag-by-reference). When
   * set, the on-wire bead position is derived as lerp(from, to, fraction) of the
   * segment's resolved node positions and `pos` is ignored; dragging only slides
   * the label along that segment's line (fraction clamped to [0,1]).
   * Absent for branchPoint-target (and legacy free) labels, which use `pos`.
   */
  anchor?: { segmentId: Id; fraction: number }
  leader?: boolean // draw a leader line to the target
}

// ─────────────────────────── Top-level document ─────────────────────────

export interface HarnessDocument {
  schemaVersion: string

  // 1. Electrical model
  connectors: Connector[]
  freeTerminals: FreeTerminal[]
  splices: Splice[]
  wires: Wire[]
  cables: Cable[]

  // 2. Layout overlay
  drawing: DrawingConfig
  placements: Placement[]
  branchPoints: BranchPoint[]
  segments: Segment[]
  wireRoutes: WireRoute[]
  bundles: Bundle[]

  // 3. Annotations / treatments
  sleeving: Sleeving[]
  twists: Twist[]
  labels: Label[]
}

export const SCHEMA_VERSION = '0.6.1'

/** Plotter roll: fixed width, document-chosen length (mm). */
export const PLOTTER_ROLL_WIDTH_MM = 914
export const PLOTTER_DEFAULT_LENGTH_MM = 2000
/** Shortest roll cut: one roll width — a shorter sheet leaves no room for the title block / BOM frame. */
export const PLOTTER_MIN_LENGTH_MM = 914
export const PLOTTER_MAX_LENGTH_MM = 5000

export const DEFAULT_SHEET: SheetConfig = { paper: 'A3', orientation: 'landscape' }
export const DEFAULT_CONFIDENTIALITY =
  'This document contains confidential and proprietary information. It may not be reproduced or disclosed, in whole or in part, without written authorization.'
