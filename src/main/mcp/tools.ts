import { existsSync } from 'fs'
import type { ToolOutcome } from '../../shared/mcp'
import { obj, str, type Check, type FieldSpec, type OpName } from '../../cli/ops'
import { libraryPutText, librarySearch, libraryShow } from '../../cli/library'

/**
 * The in-app MCP server's tool table: what `tools/list` answers, where each tool
 * runs, and the three library tools that run here in main (they read and write
 * the library folder on disk; the document tools run in the renderer,
 * `src/renderer/src/mcp/tools.ts`).
 *
 * The JSON Schemas are hand-written for the client's benefit (an agent reads
 * them to build a call); the tools validate again themselves with the CLI's
 * field tables, so the error text an agent sees is the CLI's. `tools.test.ts`
 * checks the schemas against those tables.
 */
export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, object>; required?: string[]; additionalProperties: false }
  runsIn: 'main' | 'renderer'
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
}

/** What the server tells an agent about working in the app (MCP `instructions`). */
export const INSTRUCTIONS = `You are editing the wire-harness drawing that is OPEN in Harness Editor, live: the user sees every change on the canvas as it happens.

- Start with get_document; get_layout for the formboard geometry; check for design-rule findings, the wiring table and connector pinouts.
- Connectivity goes through apply_ops (the same op grammar as the \`harness apply\` CLI), formboard geometry through edit_layout, sheet and title block through set_drawing.
- Every edit call is ONE undo step for the user and all or nothing: if any op is refused, nothing changes and the errors say why.
- Every part must be a complete parts-library record: find one with library_search / library_show. Only add records (library_put) the user asked for or confirmed — the library is shared.
- Lengths and positions are millimetres.
- Save (save_document) only when the user asks you to.`

const string = { type: 'string', minLength: 1 } as const
const text = { type: 'string' } as const
const num = { type: 'number' } as const
const object = (properties: Record<string, object>, required: string[] = []) =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }) as const

/** The `apply_ops` grammar as JSON Schema — `src/cli/ops.ts` `SPECS`, op by op. */
export const OP_SCHEMAS: Record<OpName, ReturnType<typeof object>> = {
  place: object(
    { kind: { enum: ['connector', 'terminal', 'splice'] }, partNumber: string, designator: string, landsOn: string },
    ['kind', 'partNumber']
  ),
  wire: object(
    {
      from: string,
      to: string,
      partNumber: string,
      color: string,
      gauge: object({ value: { type: 'number', exclusiveMinimum: 0 }, unit: { enum: ['mm2', 'AWG'] } }, ['value', 'unit'])
    },
    ['from', 'to', 'partNumber', 'color']
  ),
  cable: object(
    {
      partNumber: string,
      name: string,
      cores: { type: 'array', minItems: 1, items: object({ core: string, from: string, to: string }, ['core', 'from', 'to']) },
      drain: object({ end: { enum: ['a', 'b'] }, to: string }, ['end', 'to'])
    },
    ['partNumber', 'name', 'cores']
  ),
  cavity: object({ at: string, status: { enum: ['empty', 'plugged', 'populated'] }, plugPartNumber: string }, ['at', 'status']),
  'set-wire': object({ from: string, to: string, color: string, partNumber: string }, ['from', 'to']),
  unwire: object({ from: string, to: string }, ['from', 'to']),
  remove: object({ ref: string }, ['ref'])
}

/** The `edit_layout` grammar — `LAYOUT_SPECS` in the renderer's tools. */
export const LAYOUT_SCHEMAS: Record<string, ReturnType<typeof object>> = {
  move: object({ node: string, x: num, y: num }, ['node', 'x', 'y']),
  branch: object({ segment: string, x: num, y: num }, ['segment']),
  merge: object({ from: string, into: string }, ['from', 'into']),
  'segment-length': object(
    { segment: string, mm: { type: ['number', 'null'], exclusiveMinimum: 0 }, fit: { enum: ['from', 'to'] } },
    ['segment', 'mm']
  )
}

/** One batch item: any of the ops, each `{ op: <name>, ...its fields }`. */
const batchOf = (schemas: Record<string, ReturnType<typeof object>>) => ({
  type: 'array',
  items: {
    oneOf: Object.entries(schemas).map(([op, s]) => ({
      ...s,
      properties: { op: { enum: [op] }, ...s.properties },
      required: ['op', ...(s.required ?? [])]
    }))
  }
})

const approval = object({ name: text, date: text })

const READ = { readOnlyHint: true, openWorldHint: false }
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

export const TOOLS: ToolDef[] = [
  {
    name: 'get_document',
    runsIn: 'renderer',
    annotations: READ,
    description:
      'The open document: its file path (null if never saved), whether it has unsaved changes, the drawing sheet and title block, ' +
      'every body (connector / terminal / splice) by designator with its part number, the wire count, and the cables.',
    inputSchema: object({})
  },
  {
    name: 'get_layout',
    runsIn: 'renderer',
    annotations: READ,
    description:
      'The formboard — the 1:1 manufacturing drawing — in mm: body positions by designator, branch points {id, x, y}, and every ' +
      'segment (limb) {id, from, to, wires, lengthMm, drawnLengthMm, specifiedLengthMm, broken}. `from`/`to` are a designator ' +
      'or a branch point id. lengthMm is what the cut list uses (the typed length if set, else the drawn one); broken means the ' +
      'typed length no longer matches the drawing. edit_layout names nodes and segments by these ids.',
    inputSchema: object({})
  },
  {
    name: 'check',
    runsIn: 'renderer',
    annotations: READ,
    description:
      'Design-rule findings (the same as the app\'s DRC panel), the wiring table, connector pinouts and the part numbers that ' +
      'are not complete library records — the same result as `harness check`, for the open document.',
    inputSchema: object({})
  },
  {
    name: 'apply_ops',
    runsIn: 'renderer',
    annotations: EDIT,
    description: `Edit the open document's connectivity with a batch of operations — the grammar of the \`harness apply\` CLI. All or nothing, and ONE undo step for the user; a refusal says which op and why ("op #N (name): …").

Ends are named by designator: "X1:7" (cavity 7 of connector X1), "SP1" / "T1" (a splice / free terminal), "CAN-1:shield:a" (shield end a of cable CAN-1). Every part number must be a complete parts-library record of the right kind.

- place {kind: connector|terminal|splice, partNumber, designator?, landsOn? (terminal only)} — lands at the centre of the user's view; the designator defaults to the next free one (X1, T1, SP1…)
- wire {from, to, partNumber (a wire record — it fixes the gauge), color ("GN", or base/stripe "GN/YE"), gauge?}
- cable {partNumber (a cable record), name, cores: [{core, from, to}], drain?: {end: a|b, to}}
- cavity {at: "X1:3", status: empty|plugged|populated, plugPartNumber? (plugged only)}
- set-wire {from, to, color?, partNumber?} — a plain wire, not a cable core
- unwire {from, to}
- remove {ref: a designator or a cable name} — a body takes its wires with it`,
    inputSchema: object({ ops: batchOf(OP_SCHEMAS) }, ['ops'])
  },
  {
    name: 'edit_layout',
    runsIn: 'renderer',
    annotations: EDIT,
    description: `Edit the formboard geometry in mm. All or nothing, ONE undo step. Bodies are named by designator, branch points and segments by the ids get_layout lists.

- move {node, x, y} — put a body or branch point at (x, y)
- branch {segment, x?, y?} — insert a branch point on a limb (default: its midpoint); the limb becomes two segments with new ids
- merge {from, into} — fuse branch point "from" into "into"; limbs running between the same points become one shared bundle
- segment-length {segment, mm (null clears it), fit?: from|to} — the limb's manufacturing length; with fit, the drawing is redrawn to match by moving that end of the limb, and everything beyond it, along the limb`,
    inputSchema: object({ ops: batchOf(LAYOUT_SCHEMAS) }, ['ops'])
  },
  {
    name: 'set_drawing',
    runsIn: 'renderer',
    annotations: EDIT,
    description:
      'Set the drawing sheet (paper A4–A0 or a Plotter roll with lengthMm, portrait or landscape) and/or merge fields into ' +
      'the title block. Approvals ({name, date}) are replaced whole. One undo step.',
    inputSchema: object({
      sheet: object(
        { paper: { enum: ['A4', 'A3', 'A2', 'A1', 'A0', 'Plotter'] }, orientation: { enum: ['portrait', 'landscape'] }, lengthMm: num },
        ['paper', 'orientation']
      ),
      titleBlock: object({
        title: text,
        partNumber: text,
        description: text,
        revision: text,
        drawnBy: approval,
        engApproved: approval,
        mfgApproved: approval,
        qa: approval,
        confidentiality: text
      })
    })
  },
  {
    name: 'select',
    runsIn: 'renderer',
    annotations: READ,
    description:
      'Select an element in the editor so the user can see what you mean: a designator, a cable name, or a segment / branch ' +
      'point / wire id. Does not pan or zoom; refused when no visible view draws it (segments and branch points are on the ' +
      'formboard, wires in the schematic).',
    inputSchema: object({ ref: string }, ['ref'])
  },
  {
    name: 'save_document',
    runsIn: 'renderer',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description:
      'Save the open document to its own file, overwriting it. Refused for a document that has never been saved (the user ' +
      'must use Save As). Only when the user asks.',
    inputSchema: object({})
  },
  {
    name: 'library_search',
    runsIn: 'main',
    annotations: READ,
    description:
      'Find parts-library records whose part number, manufacturer or description contains the text (case-insensitive). ' +
      '`complete` says whether apply_ops can use the part.',
    inputSchema: object({ text: string }, ['text'])
  },
  {
    name: 'library_show',
    runsIn: 'main',
    annotations: READ,
    description:
      'One parts-library record in full (its JSON is the shape library_put takes), whether its datasheet PDF and its ' +
      'picture are in the library, and what it lacks to be complete.',
    inputSchema: object({ partNumber: string }, ['partNumber'])
  },
  {
    name: 'library_put',
    runsIn: 'main',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description:
      'Add or replace a parts-library record, as `harness library put` does. `record` is the record JSON (library_show an ' +
      'existing part of the same kind for the shape): partNumber, kind, description, manufacturer, datasheetUrl, plus the ' +
      'kind\'s own block (connector.cavities, wire.gauge, cable.cores…). `datasheet` is a PDF URL (downloaded) or local path. ' +
      '`picture` is the part\'s photo, a PNG or JPEG of at most 5 MB, as a URL or local path; it replaces any picture the ' +
      'part had. Other formats (WebP, GIF…) are refused: convert them first. A picture is optional; to give an existing ' +
      'part one, put its library_show record again with `picture`. ' +
      'Refused, and nothing written, unless the record ends up complete. The library is shared: only add parts the user asked ' +
      'for or confirmed.',
    inputSchema: object({ record: { type: 'object' }, datasheet: string, picture: string }, ['record'])
  }
]

const isRecord: Check = (v) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? null : 'must be an object')

const LIBRARY_ARGS: Record<string, Record<string, FieldSpec>> = {
  library_search: { text: [true, str] },
  library_show: { partNumber: [true, str] },
  library_put: { record: [true, isRecord], datasheet: [false, str], picture: [false, str] }
}

/** Run a main-side (library) tool against the library folder `dir` (from settings; undefined when none is set). */
export async function runLibraryTool(name: string, args: unknown, dir: string | undefined): Promise<ToolOutcome> {
  const refuse = (...errors: string[]): ToolOutcome => ({ ok: false, errors })
  const spec = LIBRARY_ARGS[name]
  if (!spec) return refuse(`unknown tool '${name}'`)
  const bad = obj(spec)(args ?? {})
  if (bad) return refuse(`arguments: ${bad}`)
  if (!dir) return refuse('no parts library folder is set — the user chooses one in Settings ▸ Parts library folder…')
  if (!existsSync(dir)) return refuse(`parts library folder ${dir} does not exist`)
  const a = args as Record<string, unknown>
  try {
    if (name === 'library_search') return { ok: true, result: await librarySearch(dir, a.text as string) }
    if (name === 'library_show') {
      const pn = a.partNumber as string
      const r = await libraryShow(dir, pn)
      if (r === null) return refuse(`no record '${pn}' in the parts library`)
      if ('unreadable' in r) return refuse(`${pn}: the record file is unreadable: ${r.unreadable}`)
      return { ok: true, result: r }
    }
    const r = await libraryPutText(dir, JSON.stringify(a.record), 'record', {
      datasheet: a.datasheet as string | undefined,
      picture: a.picture as string | undefined
    })
    return r.ok ? { ok: true, result: { partNumber: r.partNumber, created: r.created } } : refuse(...r.problems)
  } catch (e) {
    return refuse(`internal error: ${(e as Error).message}`)
  }
}
