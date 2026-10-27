import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { newLibraryPart } from '@shared/parts/librarySchema'
import { SPECS } from '../../cli/ops'
import { full, makeLibrary } from '../../cli/testLibrary'
import { DOCUMENT_TOOLS, DOCUMENT_TOOL_ARGS, LAYOUT_SPECS } from '../../renderer/src/mcp/tools'
import { LAYOUT_SCHEMAS, OP_SCHEMAS, TOOLS, runLibraryTool } from './tools'

type Spec = Record<string, [boolean, unknown]>
const fields = (spec: Spec) => Object.keys(spec).sort()
const required = (spec: Spec) => Object.entries(spec).filter(([, [r]]) => r).map(([k]) => k).sort()

/** A schema's fields and required list match a CLI-style field table. */
function expectSameShape(schema: { properties: Record<string, object>; required?: string[] }, spec: Spec): void {
  expect(Object.keys(schema.properties).sort()).toEqual(fields(spec))
  expect([...(schema.required ?? [])].sort()).toEqual(required(spec))
}

describe('tool table', () => {
  it('apply_ops schemas match the CLI grammar, op by op', () => {
    expect(Object.keys(OP_SCHEMAS).sort()).toEqual(Object.keys(SPECS).sort())
    for (const [op, spec] of Object.entries(SPECS)) expectSameShape(OP_SCHEMAS[op as keyof typeof SPECS], spec)
  })

  it('edit_layout schemas match the layout grammar', () => {
    expect(Object.keys(LAYOUT_SCHEMAS).sort()).toEqual(Object.keys(LAYOUT_SPECS).sort())
    for (const [op, spec] of Object.entries(LAYOUT_SPECS)) expectSameShape(LAYOUT_SCHEMAS[op], spec)
  })

  it('the renderer runs exactly the renderer tools, with the arguments their schemas name', () => {
    const renderer = TOOLS.filter((t) => t.runsIn === 'renderer')
    expect(renderer.map((t) => t.name).sort()).toEqual([...DOCUMENT_TOOLS].sort())
    for (const t of renderer) expectSameShape(t.inputSchema, DOCUMENT_TOOL_ARGS[t.name])
  })

  it('tool names are unique', () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length)
  })
})

describe('library tools (main)', () => {
  let tmp: string
  let dir: string
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'harness-mcp-lib-'))
    const hsg = full(newLibraryPart('connector', 'HSG-2'))
    hsg.connector = { cavities: [{ position: '1' }, { position: '2' }] }
    dir = (await makeLibrary(tmp, [hsg, newLibraryPart('pin', 'PIN-X')], ['HSG-2'])).dir
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('library_search and library_show read the folder', async () => {
    const s = await runLibraryTool('library_search', { text: 'hsg' }, dir)
    expect(s).toMatchObject({ ok: true, result: { hits: [{ partNumber: 'HSG-2', complete: true }] } })
    const show = await runLibraryTool('library_show', { partNumber: 'PIN-X' }, dir)
    expect(show).toMatchObject({ ok: true, result: { hasDatasheet: false } })
    expect((show as { result: { incomplete: string[] } }).result.incomplete.length).toBeGreaterThan(0)
    expect(await runLibraryTool('library_show', { partNumber: 'NOPE' }, dir)).toEqual({
      ok: false,
      errors: ["no record 'NOPE' in the parts library"]
    })
  })

  it('library_put writes a complete record and refuses an incomplete one', async () => {
    const pin = full(newLibraryPart('pin', 'PIN-2'))
    const pdf = join(tmp, 'stub-datasheet.pdf') // written by makeLibrary
    expect(await runLibraryTool('library_put', { record: pin, datasheet: pdf }, dir)).toEqual({
      ok: true,
      result: { partNumber: 'PIN-2', created: true }
    })
    const r = await runLibraryTool('library_put', { record: full(newLibraryPart('pin', 'PIN-3')) }, dir)
    expect(r.ok).toBe(false)
    expect(await runLibraryTool('library_show', { partNumber: 'PIN-3' }, dir)).toMatchObject({ ok: false })
  })

  it('refuses without a library folder, or with one that does not exist', async () => {
    expect((await runLibraryTool('library_search', { text: 'x' }, undefined)).ok).toBe(false)
    expect(await runLibraryTool('library_search', { text: 'x' }, join(tmp, 'gone'))).toEqual({
      ok: false,
      errors: [`parts library folder ${join(tmp, 'gone')} does not exist`]
    })
  })

  it('checks arguments like the document tools', async () => {
    expect(await runLibraryTool('library_put', { record: [] }, dir)).toEqual({ ok: false, errors: ["arguments: 'record' must be an object"] })
    expect(await runLibraryTool('library_search', {}, dir)).toEqual({ ok: false, errors: ["arguments: missing 'text'"] })
  })
})
