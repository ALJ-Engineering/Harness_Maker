import type { EntityRef } from '@shared/drc'
import type { Id, RouteNode, SheetConfig, TitleBlock, Vec2 } from '@shared/model/schema'
import { PLOTTER_DEFAULT_LENGTH_MM, PLOTTER_MAX_LENGTH_MM, PLOTTER_MIN_LENGTH_MM } from '@shared/model/schema'
import { computeFormboard } from '@shared/model/formboard'
import { serializeDocument } from '@shared/model/serialize'
import type { ToolOutcome } from '@shared/mcp'
import { useHarnessStore } from '../store'
import { obj, oneOf, parseBatch, parseOps, str, type Check, type FieldSpec } from '../../../cli/ops'
import { runOps } from '../../../cli/batch'
import { checkDocument } from '../../../cli/check'
import { showDocument } from '../../../cli/show'
import { repairsOnReload } from '../../../cli/repairs'
import type { LibraryContext } from '../../../cli/libraryContext'

/**
 * The document tools of the in-app MCP server: what an agent can read and do
 * to the OPEN document. Main forwards a call here (`mcp:call`); `AppShell`
 * supplies the context and sends the outcome back.
 *
 * Every edit runs inside `batchEdit`, so a call is ONE undo step for the user
 * and all or nothing: a refusal leaves the document, its history and the dirty
 * flag exactly as they were. Edits reuse the CLI's grammar and rails
 * (`src/cli/`), so an agent gets the same answers here as from `harness apply`.
 *
 * No `window` in this module: `ToolContext` carries everything that needs the
 * app, so the tools run under vitest against the store singleton.
 */
export interface ToolContext {
  /** The parts library, listed fresh (a part an agent just added must resolve); null when no folder is set. */
  library: () => Promise<LibraryContext | null>
  /** Formboard mm where `apply_ops` places new bodies — the focused pane's centre. */
  placeAt: () => Vec2
  /** Select an element in the shell; false when no visible pane can draw it. */
  select: (ref: EntityRef) => boolean
  /** Write the serialised document to `path`; resolves to the path written. */
  save: (path: string, text: string) => Promise<string>
}

const S = () => useHarnessStore.getState()
const refuse = (...errors: string[]): ToolOutcome => ({ ok: false, errors })
const done = (result: unknown): ToolOutcome => ({ ok: true, result })

const num: Check = (v) => (typeof v === 'number' && Number.isFinite(v) ? null : 'must be a finite number')
const text: Check = (v) => (typeof v === 'string' ? null : 'must be a string')
const list: Check = (v) => (Array.isArray(v) ? null : 'must be an array')
const lengthOrNull: Check = (v) =>
  v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0) ? null : 'must be a length in mm above 0, or null to clear it'

const approval = obj({ name: [false, text], date: [false, text] })

/** Each tool's arguments. Unknown fields are refused, as in the op grammar. Main's JSON Schemas are checked against this. */
export const DOCUMENT_TOOL_ARGS: Record<string, Record<string, FieldSpec>> = {
  get_document: {},
  get_layout: {},
  check: {},
  apply_ops: { ops: [true, list] },
  edit_layout: { ops: [true, list] },
  set_drawing: {
    sheet: [
      false,
      obj({
        paper: [true, oneOf('A4', 'A3', 'A2', 'A1', 'A0', 'Plotter')],
        orientation: [true, oneOf('portrait', 'landscape')],
        lengthMm: [false, num]
      })
    ],
    titleBlock: [
      false,
      obj({
        title: [false, text],
        partNumber: [false, text],
        description: [false, text],
        revision: [false, text],
        drawnBy: [false, approval],
        engApproved: [false, approval],
        mfgApproved: [false, approval],
        qa: [false, approval],
        confidentiality: [false, text]
      })
    ]
  },
  select: { ref: [true, str] },
  save_document: {}
}

/** The tools this module runs — main's tool table must name exactly these as renderer tools. */
export const DOCUMENT_TOOLS = Object.keys(DOCUMENT_TOOL_ARGS)

export async function runTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const spec = DOCUMENT_TOOL_ARGS[name]
  if (!spec) return refuse(`unknown tool '${name}'`)
  const a = args ?? {}
  const bad = obj(spec)(a)
  if (bad) return refuse(`arguments: ${bad}`)
  const r = a as Record<string, unknown>
  try {
    switch (name) {
      case 'get_document':
        return getDocument()
      case 'get_layout':
        return getLayout()
      case 'check':
        return await check(ctx)
      case 'apply_ops':
        return await applyOps(r.ops, ctx)
      case 'edit_layout':
        return editLayout(r.ops)
      case 'set_drawing':
        return setDrawing(r as { sheet?: SheetConfig; titleBlock?: Partial<TitleBlock> })
      case 'select':
        return select(r.ref as string, ctx)
      case 'save_document':
        return await save(ctx)
    }
  } catch (e) {
    return refuse(`internal error: ${(e as Error).message}`)
  }
  return refuse(`unknown tool '${name}'`)
}

// ── reads ──────────────────────────────────────────────────────────────────

function getDocument(): ToolOutcome {
  const { doc, filePath, dirty } = S()
  return done({
    filePath,
    dirty,
    sheet: doc.drawing.sheet,
    titleBlock: doc.drawing.titleBlock ?? {},
    ...showDocument(doc)
  })
}

const r1 = (n: number | null | undefined): number | null => (n == null ? null : Math.round(n * 10) / 10)

/** Body designators by id (connectors, free terminals, splices). */
function designators(): Map<Id, string> {
  const { doc } = S()
  return new Map([...doc.connectors, ...doc.freeTerminals, ...doc.splices].map((b) => [b.id, b.designator]))
}

function getLayout(): ToolOutcome {
  const { doc } = S()
  const fb = computeFormboard(doc)
  const names = designators()
  const node = (n: RouteNode): string => (n.type === 'body' ? (names.get(n.refId) ?? n.refId) : n.branchId)
  const drawn = new Map(fb.segments.map((s) => [s.id, s]))
  return done({
    units: 'mm',
    bodies: fb.bodies.map((b) => ({ designator: names.get(b.id) ?? b.id, kind: b.kind, x: r1(b.pos.x), y: r1(b.pos.y) })),
    branchPoints: fb.branchPoints.map((b) => ({ id: b.id, x: r1(b.pos.x), y: r1(b.pos.y) })),
    segments: doc.segments.map((s) => {
      const f = drawn.get(s.id)
      return {
        id: s.id,
        from: node(s.from),
        to: node(s.to),
        wires: f?.wireIds.length ?? 0,
        lengthMm: r1(f?.lengthMm),
        drawnLengthMm: r1(f?.drawnLengthMm),
        specifiedLengthMm: s.specifiedLengthMm ?? null,
        broken: f?.broken ?? false
      }
    })
  })
}

async function check(ctx: ToolContext): Promise<ToolOutcome> {
  const lib = await ctx.library()
  const { doc, loadRepairs, loadMigrations } = S()
  return done({
    ...checkDocument(doc, lib),
    repairs: loadRepairs.map((r) => r.message),
    migrated: loadMigrations,
    notes: lib ? [] : ['no parts library folder is set; incomplete parts were not computed']
  })
}

// ── edits ──────────────────────────────────────────────────────────────────

/**
 * Run `body` as one undoable edit. It returns errors (refuse: everything is
 * restored) or a summary; the result must not be a document the editor would
 * repair on its next open — the CLI's save rail, applied before the edit stays.
 */
function edit(body: () => string[] | { summary: string[] }): ToolOutcome {
  let out: ToolOutcome = refuse('internal error: the edit did not run')
  S().batchEdit(() => {
    const r = body()
    if (Array.isArray(r)) {
      out = refuse(...r)
      return false
    }
    const repairs = repairsOnReload(S().doc)
    if (repairs.length) {
      out = refuse(`refused: the document would need repairs when next opened: ${repairs.map((x) => x.message).join('; ')}`)
      return false
    }
    out = done({ summary: r.summary })
    return true
  })
  return out
}

async function applyOps(raw: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const ops = parseOps(raw)
  if ('error' in ops) return refuse(ops.error)
  const lib = await ctx.library()
  if (!lib) return refuse('no parts library folder is set — the user chooses one in Settings ▸ Parts library folder…')
  const placeAt = ctx.placeAt()
  return edit(() => {
    const run = runOps(ops, lib, { placeAt })
    return run.ok ? { summary: run.summary } : run.errors
  })
}

export type LayoutOp =
  | { op: 'move'; node: string; x: number; y: number }
  | { op: 'branch'; segment: string; x?: number; y?: number }
  | { op: 'merge'; from: string; into: string }
  | { op: 'segment-length'; segment: string; mm: number | null; fit?: 'from' | 'to' }

/** The `edit_layout` grammar — formboard geometry, named by designator (bodies) or id (branch points, segments). */
export const LAYOUT_SPECS: Record<LayoutOp['op'], Record<string, FieldSpec>> = {
  move: { node: [true, str], x: [true, num], y: [true, num] },
  branch: { segment: [true, str], x: [false, num], y: [false, num] },
  merge: { from: [true, str], into: [true, str] },
  'segment-length': { segment: [true, str], mm: [true, lengthOrNull], fit: [false, oneOf('from', 'to')] }
}

function editLayout(raw: unknown): ToolOutcome {
  const ops = parseBatch<LayoutOp>(raw, LAYOUT_SPECS)
  if ('error' in ops) return refuse(ops.error)
  return edit(() => {
    const summary: string[] = []
    for (const [i, op] of ops.entries()) {
      const r = layoutOp(op)
      if (Array.isArray(r)) return r.map((e) => `op #${i + 1} (${op.op}): ${e}`)
      summary.push(r.line)
    }
    return { summary }
  })
}

const fmtPos = (x: number, y: number): string => `(${r1(x)}, ${r1(y)}) mm`

function layoutOp(op: LayoutOp): string[] | { line: string } {
  const { doc } = S()
  const segment = (id: string) =>
    doc.segments.some((s) => s.id === id) ? null : `no segment '${id}' (get_layout lists them)`
  const branch = (id: string) =>
    doc.branchPoints.some((b) => b.id === id) ? null : `no branch point '${id}' (get_layout lists them)`
  switch (op.op) {
    case 'move': {
      const bodies = [...designators()].filter(([, d]) => d === op.node).map(([id]) => id)
      if (bodies.length > 1) return [`designator '${op.node}' names ${bodies.length} bodies`]
      const id = bodies[0] ?? (doc.branchPoints.some((b) => b.id === op.node) ? op.node : null)
      if (!id) return [`no body or branch point '${op.node}' (bodies by designator, branch points by id from get_layout)`]
      S().commitNodePositions([{ refId: id, pos: { x: op.x, y: op.y } }], 'physical')
      return { line: `moved ${op.node} to ${fmtPos(op.x, op.y)}` }
    }
    case 'branch': {
      const e = segment(op.segment)
      if (e) return [e]
      if ((op.x === undefined) !== (op.y === undefined)) return [`give both x and y, or neither (the limb's midpoint)`]
      let pos: Vec2
      if (op.x !== undefined && op.y !== undefined) pos = { x: op.x, y: op.y }
      else {
        const f = computeFormboard(doc).segments.find((s) => s.id === op.segment)
        if (!f) return [`segment '${op.segment}' is not drawn (an end has no position); give x and y`]
        pos = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 }
      }
      const id = S().insertBranchPoint(op.segment, pos)
      if (id === null) return [`could not insert a branch point on '${op.segment}'`]
      return { line: `inserted branch point ${id} on ${op.segment} at ${fmtPos(pos.x, pos.y)} (the limb is now two segments; get_layout lists them)` }
    }
    case 'merge': {
      const e = [branch(op.from), branch(op.into)].filter((x): x is string => x !== null)
      if (e.length) return e
      if (op.from === op.into) return [`from and into are the same branch point`]
      if (!S().mergeBranchPoints(op.from, op.into)) return [`could not merge ${op.from} into ${op.into}`]
      return { line: `merged branch point ${op.from} into ${op.into}` }
    }
    case 'segment-length': {
      const e = segment(op.segment)
      if (e) return [e]
      if (op.fit && op.mm === null) return [`fit needs a length (mm)`]
      const changed = S().setSegmentLength(op.segment, op.mm)
      let line = op.mm === null ? `cleared the length of ${op.segment}` : `${op.segment} is ${op.mm} mm`
      if (!changed) line += ' (unchanged)'
      if (op.fit) {
        const r = S().rescaleSegment(op.segment, op.fit)
        if (r === 'loop') return [`${op.segment} is on a loop, so its '${op.fit}' side cannot move on its own; move nodes instead`]
        if (r === 'unresolved' || r === 'no-segment') return [`${op.segment} could not be redrawn (${r})`]
        if (r === 'ok') line += `; redrawn by moving its '${op.fit}' side`
      }
      return { line }
    }
  }
}

function setDrawing(a: { sheet?: SheetConfig; titleBlock?: Partial<TitleBlock> }): ToolOutcome {
  if (!a.sheet && !a.titleBlock) return refuse('nothing to set (give sheet and/or titleBlock)')
  let sheet: SheetConfig | undefined
  if (a.sheet) {
    const { paper, orientation, lengthMm } = a.sheet
    if (paper === 'Plotter') {
      const l = lengthMm ?? PLOTTER_DEFAULT_LENGTH_MM
      if (l < PLOTTER_MIN_LENGTH_MM || l > PLOTTER_MAX_LENGTH_MM)
        return refuse(`sheet: lengthMm must be ${PLOTTER_MIN_LENGTH_MM}–${PLOTTER_MAX_LENGTH_MM} mm for a plotter roll`)
      sheet = { paper, orientation, lengthMm: l }
    } else {
      if (lengthMm !== undefined) return refuse(`sheet: lengthMm is only for paper 'Plotter'`)
      sheet = { paper, orientation }
    }
  }
  return edit(() => {
    const summary: string[] = []
    if (sheet) {
      S().setSheet(sheet)
      summary.push(`sheet ${sheet.paper} ${sheet.orientation}${sheet.lengthMm ? ` ${sheet.lengthMm} mm` : ''}`)
    }
    if (a.titleBlock) {
      S().setTitleBlock(a.titleBlock)
      summary.push(`title block: ${Object.keys(a.titleBlock).join(', ')}`)
    }
    return { summary }
  })
}

function select(ref: string, ctx: ToolContext): ToolOutcome {
  const { doc } = S()
  const by = <T extends { id: Id }>(xs: T[], hit: (x: T) => boolean, kind: EntityRef['kind']): EntityRef[] =>
    xs.filter(hit).map((x) => ({ kind, id: x.id }))
  const hits = [
    ...by(doc.connectors, (c) => c.designator === ref, 'connector'),
    ...by(doc.freeTerminals, (t) => t.designator === ref, 'freeTerminal'),
    ...by(doc.splices, (s) => s.designator === ref, 'splice'),
    ...by(doc.cables, (c) => c.name === ref, 'cable'),
    ...by(doc.segments, (s) => s.id === ref, 'segment'),
    ...by(doc.branchPoints, (b) => b.id === ref, 'branchPoint'),
    ...by(doc.wires, (w) => w.id === ref, 'wire')
  ]
  if (hits.length === 0) return refuse(`nothing named '${ref}' (a designator, cable name, or a segment / branch point / wire id)`)
  if (hits.length > 1) return refuse(`'${ref}' names ${hits.length} elements; cannot tell which one is meant`)
  if (!ctx.select(hits[0])) return refuse(`${ref} is not drawn in the visible view(s) — a segment or branch point shows on the formboard, a wire in the schematic`)
  return done({ selected: ref, kind: hits[0].kind })
}

async function save(ctx: ToolContext): Promise<ToolOutcome> {
  const { doc, filePath } = S()
  if (!filePath) return refuse('the document has never been saved; the user must Save As first (File ▸ Save As…)')
  const written = await ctx.save(filePath, serializeDocument(doc))
  // `doc`, not the current one: an edit made while writing is not on disk.
  S().markSaved(written, doc)
  return done({ path: written })
}
