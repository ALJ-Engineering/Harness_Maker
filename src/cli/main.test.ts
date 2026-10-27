import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { newLibraryPart } from '@shared/parts/librarySchema'
import { main, USAGE } from './main'
import type { CliIO } from './io'
import { full } from './testLibrary'
import { loadHarness } from './session'

let tmp: string
let out: string[]
let err: string[]
let stdin = ''
const mm05 = { value: 0.5, unit: 'mm2' as const }

const io = (env: Record<string, string | undefined> = {}): CliIO => ({
  out: (s) => out.push(s),
  err: (s) => err.push(s),
  env,
  home: tmp,
  platform: 'darwin',
  readStdin: async () => stdin
})
const run = (...argv: string[]) => main(argv, io())
const json = () => JSON.parse(out[out.length - 1])
const rec = (name: string, o: object) => {
  const f = join(tmp, name + '.json')
  writeFileSync(f, JSON.stringify(o))
  return f
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'harness-main-'))
  out = []
  err = []
  stdin = ''
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

async function buildLibrary(): Promise<string> {
  const lib = join(tmp, 'lib')
  mkdirSync(lib)
  const pdf = join(tmp, 'ds.pdf')
  writeFileSync(pdf, '%PDF-1.4\n%%EOF\n')
  const hsg = full(newLibraryPart('connector', 'HSG-2'))
  hsg.connector = { cavities: [{ position: '1', defaultPin: 'PIN-1' }, { position: '2', defaultPin: 'PIN-1' }] }
  const pin = full(newLibraryPart('pin', 'PIN-1'))
  const wire = full(newLibraryPart('wire', 'W-05'))
  wire.wire = { gauge: mm05 }
  for (const [n, p] of [['pin', pin], ['hsg', hsg], ['wire', wire]] as const) {
    expect(await run('library', 'put', rec(n, p), '--datasheet', pdf, '--library', lib)).toBe(0)
  }
  out = []
  return lib
}

describe('harness commands', () => {
  it('new -> library put -> apply -> check --json: two wiring rows, wired cavities not flagged', async () => {
    const lib = await buildLibrary()
    const file = join(tmp, 'h.harness.json')
    expect(await run('new', file)).toBe(0)
    expect(existsSync(file)).toBe(true)
    const ops = [
      { op: 'place', kind: 'connector', partNumber: 'HSG-2' },
      { op: 'place', kind: 'connector', partNumber: 'HSG-2' },
      { op: 'wire', from: 'X1:1', to: 'X2:1', partNumber: 'W-05', color: 'RD' },
      { op: 'wire', from: 'X1:2', to: 'X2:2', partNumber: 'W-05', color: 'BK' }
    ]
    stdin = JSON.stringify(ops)
    expect(await run('apply', file, '-', '--library', lib), err.join('')).toBe(0)
    out = []
    expect(await run('check', file, '--library', lib, '--json')).toBe(0)
    const r = json()
    expect(r.wiring).toHaveLength(2)
    expect(r.wiring[0]).toMatchObject({ from: expect.any(String), to: expect.any(String), size: '0.5 mm²', conductorPn: 'W-05' })
    expect(r.pinouts).toHaveLength(2)
    expect(r.incompleteParts).toEqual([])
    const unconn = r.findings.filter((f: { ruleId: string }) => f.ruleId === 'unconnected-populated-cavity')
    expect(unconn).toEqual([])
  })

  it('a file from new and from apply loads through the app\'s parse+reconcile path with no repair or migration notice', async () => {
    const lib = await buildLibrary()
    const a = join(tmp, 'a.harness.json')
    const b = join(tmp, 'b.harness.json')
    await run('new', a)
    stdin = JSON.stringify([
      { op: 'place', kind: 'connector', partNumber: 'HSG-2' },
      { op: 'place', kind: 'connector', partNumber: 'HSG-2' },
      { op: 'wire', from: 'X1:1', to: 'X2:1', partNumber: 'W-05', color: 'RD' }
    ])
    expect(await run('apply', b, '-', '--create', '--library', lib)).toBe(0)
    for (const f of [a, b]) {
      const r = await loadHarness(f)
      expect(r.repairs).toEqual([])
      expect(r.migrated).toEqual([])
    }
  })

  it('apply from a file path, --create, and a refusal exits 1 with the problem named', async () => {
    const lib = await buildLibrary()
    const file = join(tmp, 'c.harness.json')
    const opsFile = rec('ops', [{ op: 'place', kind: 'connector', partNumber: 'HSG-2' }])
    expect(await run('apply', file, opsFile, '--create', '--library', lib)).toBe(0)
    expect(out.join('')).toContain('placed connector X1 (HSG-2)')
    const before = readFileSync(file, 'utf8')
    err = []
    const bad = rec('bad', [{ op: 'place', kind: 'connector', partNumber: 'NOPE' }])
    expect(await run('apply', file, bad, '--library', lib)).toBe(1)
    expect(err.join('')).toContain('NOPE')
    expect(readFileSync(file, 'utf8')).toBe(before)
    err = []
    expect(await run('apply', file, rec('junk', { a: 1 }), '--library', lib)).toBe(1)
    expect(err.join('')).toContain('JSON array')
    out = []
    expect(await run('apply', file, opsFile, '--library', lib, '--json')).toBe(0)
    expect(json()).toMatchObject({ ok: true })
  })

  it('apply and library refuse clearly with no library folder', async () => {
    const file = join(tmp, 'n.harness.json')
    expect(await run('new', file)).toBe(0) // a library is optional for new
    expect(await run('apply', file, rec('ops', []))).toBe(1)
    expect(err.join('')).toMatch(/no parts library folder — pass --library or set HARNESS_LIBRARY/)
    err = []
    expect(await run('library', 'search', 'x')).toBe(1)
    expect(err.join('')).toMatch(/no parts library folder/)
  })

  it('library dir: the folder, where it came from, and whether it exists', async () => {
    const lib = join(tmp, 'lib')
    expect(await main(['library', 'dir', '--library', lib, '--json'], io())).toBe(0)
    expect(json()).toEqual({ dir: lib, source: '--library', exists: false })
    mkdirSync(lib)
    expect(await main(['library', 'dir', '--json'], io({ HARNESS_LIBRARY: lib }))).toBe(0)
    expect(json()).toEqual({ dir: lib, source: 'HARNESS_LIBRARY', exists: true })
    const settings = join(tmp, 'Library', 'Application Support', 'harness-editor', 'settings.json')
    mkdirSync(join(settings, '..'), { recursive: true })
    writeFileSync(settings, JSON.stringify({ partsLibraryDir: lib }))
    out = []
    expect(await run('library', 'dir')).toBe(0)
    expect(out.join('\n')).toBe(`${lib}\nfrom: ${settings}\nexists`)
  })

  it('library dir with nothing configured refuses (JSON on stdout with --json)', async () => {
    expect(await run('library', 'dir', '--json')).toBe(1)
    expect(json()).toEqual({ ok: false, errors: ['no parts library folder — pass --library or set HARNESS_LIBRARY'] })
    expect(await run('library', 'dir', 'extra')).toBe(2)
  })

  it('a library folder that does not exist is refused by apply and every library subcommand, and nothing is created', async () => {
    const missing = join(tmp, 'no-such-lib')
    const file = join(tmp, 'm.harness.json')
    const want = `parts library folder ${missing} does not exist`
    expect(await run('apply', file, rec('ops', []), '--create', '--library', missing, '--json')).toBe(1)
    expect(json()).toEqual({ ok: false, errors: [want] })
    expect(existsSync(file)).toBe(false)
    const part = rec('p', full(newLibraryPart('pin', 'PIN-1')))
    for (const args of [['put', part], ['show', 'PIN-1'], ['search', 'x']]) {
      out = []
      expect(await run('library', ...args, '--library', missing, '--json')).toBe(1)
      expect(json()).toEqual({ ok: false, errors: [want] })
    }
    expect(existsSync(missing)).toBe(false)
  })

  it('library show / search on an unreadable record file: "present but unreadable", listed apart from hits', async () => {
    const lib = await buildLibrary()
    writeFileSync(join(lib, 'parts', 'SEAL-2.json'), '{"partNumber": "SEAL-2"')
    expect(await run('library', 'show', 'SEAL-2', '--library', lib, '--json')).toBe(1)
    expect(json()).toEqual({ ok: false, errors: ['SEAL-2: present but unreadable: not valid JSON'] })
    expect(await run('library', 'show', 'SEAL-9', '--library', lib, '--json')).toBe(1)
    expect(json()).toEqual({ ok: false, errors: ['SEAL-9: not in library'] })
    expect(await run('library', 'search', 'PIN', '--library', lib, '--json')).toBe(0)
    expect(json()).toMatchObject({ hits: [{ partNumber: 'PIN-1' }], unreadable: [{ file: 'SEAL-2.json', error: 'not valid JSON' }] })
    out = []
    expect(await run('library', 'search', 'PIN', '--library', lib)).toBe(0)
    expect(out.join('\n')).toContain('unreadable record files (not searched):\n  SEAL-2.json: not valid JSON')
  })

  it('check with a library folder that does not exist: incompleteParts null and a note', async () => {
    const file = join(tmp, 'n.harness.json')
    await run('new', file)
    const missing = join(tmp, 'no-such-lib')
    out = []
    expect(await run('check', file, '--library', missing, '--json')).toBe(0)
    const r = json()
    expect(r.incompleteParts).toBeNull()
    expect(r.notes).toEqual([`parts library folder ${missing} does not exist; incomplete parts were not computed`])
    out = []
    expect(await run('check', file, '--library', missing)).toBe(0)
    expect(out.join('')).toContain(`note: parts library folder ${missing} does not exist`)
  })

  it('check without a library still reports and says the incomplete list is unavailable', async () => {
    const file = join(tmp, 'n.harness.json')
    await run('new', file)
    out = []
    expect(await run('check', file)).toBe(0)
    expect(out.join('')).toMatch(/incomplete parts: unavailable/)
    out = []
    expect(await run('check', file, '--json')).toBe(0)
    expect(json().incompleteParts).toBeNull()
  })

  it('check lists incomplete parts (information, exit 0)', async () => {
    const lib = await buildLibrary()
    const file = join(tmp, 'h.harness.json')
    await run('new', file)
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.splices.push({ id: 's1', designator: 'SP1', kind: 'butt', part: { partNumber: 'GHOST' } })
    writeFileSync(file, JSON.stringify(doc))
    out = []
    const code = await run('check', file, '--library', lib, '--json')
    expect(code).toBe(0)
    expect(json().incompleteParts).toEqual([{ partNumber: 'GHOST', reasons: ['GHOST: not in library'] }])
  })

  it('show: bodies by designator with part numbers, wire count, cables', async () => {
    const lib = await buildLibrary()
    const file = join(tmp, 'h.harness.json')
    await run('new', file)
    stdin = JSON.stringify([
      { op: 'place', kind: 'connector', partNumber: 'HSG-2' },
      { op: 'place', kind: 'connector', partNumber: 'HSG-2' },
      { op: 'wire', from: 'X1:1', to: 'X2:1', partNumber: 'W-05', color: 'RD' }
    ])
    await run('apply', file, '-', '--library', lib)
    out = []
    expect(await run('show', file, '--json')).toBe(0)
    expect(json()).toMatchObject({ bodies: [{ designator: 'X1', partNumber: 'HSG-2' }, { designator: 'X2' }], wireCount: 1, cables: [] })
    out = []
    expect(await run('show', file)).toBe(0)
    expect(out.join('')).toMatch(/X1\s+connector\s+HSG-2/)
    expect(out.join('')).toMatch(/wires: 1/)
  })

  it('library show/search are wired through', async () => {
    const lib = await buildLibrary()
    out = []
    expect(await run('library', 'search', 'hsg', '--library', lib)).toBe(0)
    expect(out.join('')).toContain('HSG-2')
    out = []
    expect(await run('library', 'show', 'HSG-2', '--library', lib, '--json')).toBe(0)
    expect(json()).toMatchObject({ part: { partNumber: 'HSG-2' }, hasDatasheet: true, incomplete: [] })
    expect(await run('library', 'show', 'ZZZ', '--library', lib)).toBe(1)
  })

  it('check on a missing file exits 1 with "cannot open"; new refuses an existing file', async () => {
    expect(await run('check', join(tmp, 'missing.json'))).toBe(1)
    expect(err.join('')).toContain('cannot open')
    const f = join(tmp, 'x.json')
    await run('new', f)
    err = []
    expect(await run('new', f)).toBe(1)
    expect(err.join('')).toContain('already exists')
  })

  it('unknown command exits 2; missing args exit 2; usage lists the commands', async () => {
    expect(await run('frobnicate')).toBe(2)
    expect(await run('check')).toBe(2)
    expect(await run('apply', 'a')).toBe(2)
    expect(USAGE).toMatch(/new <file>/)
    expect(USAGE).toMatch(/check <file>/)
  })

  it('--json refusals print one {ok:false, errors} object on stdout with exit 1', async () => {
    const f = join(tmp, 'j.harness.json')
    await run('new', f)
    const cases: string[][] = [
      ['library', 'put', rec('r', {}), '--json'],
      ['library', 'show', 'X', '--json'],
      ['library', 'search', 'x', '--json'],
      ['apply', f, rec('o', []), '--json'],
      ['check', join(tmp, 'missing.json'), '--json'],
      ['new', f, '--json']
    ]
    for (const argv of cases) {
      out = []
      err = []
      const code = await run(...argv)
      expect(code, argv.join(' ')).toBe(1)
      expect(out, argv.join(' ')).toHaveLength(1)
      const o = JSON.parse(out[0])
      expect(o.ok).toBe(false)
      expect(o.errors.length).toBeGreaterThan(0)
      expect(err).toEqual([])
    }
  })

  it('check reports a body placed off the pinned drawing sheet as an outside-sheet finding', async () => {
    const f = join(tmp, 'off.harness.json')
    await run('new', f)
    const doc = JSON.parse(readFileSync(f, 'utf8'))
    // The CLI never writes sheetOrigin; without one the plan frames the content
    // and nothing can be outside, so pin the sheet here (A3 landscape from 0,0).
    doc.drawing.sheetOrigin = { x: 0, y: 0 }
    doc.connectors.push(
      { id: 'c-in', designator: 'X1', cavities: [] },
      { id: 'c-off', designator: 'X9', cavities: [] }
    )
    doc.placements.push({ refId: 'c-in', pos: { x: 100, y: 100 } }, { refId: 'c-off', pos: { x: 5000, y: 100 } })
    writeFileSync(f, JSON.stringify(doc))
    out = []
    expect(await run('check', f, '--json')).toBe(0)
    const off = json().findings.filter((x: { ruleId: string }) => x.ruleId === 'outside-sheet')
    expect(off).toEqual([expect.objectContaining({ severity: 'warning', message: 'X9 is outside the drawing sheet' })])
    out = []
    await run('check', f)
    expect(out.join('\n')).toMatch(/\[outside-sheet\] X9 is outside the drawing sheet/)
  })

  it('check reports a typed limb length that no longer matches the drawing as segment-length-off-scale', async () => {
    const f = join(tmp, 'typed.harness.json')
    await run('new', f)
    const doc = JSON.parse(readFileSync(f, 'utf8'))
    doc.connectors.push({ id: 'c1', designator: 'X1', cavities: [] }, { id: 'c2', designator: 'X2', cavities: [] })
    doc.placements.push({ refId: 'c1', pos: { x: 0, y: 0 } }, { refId: 'c2', pos: { x: 300, y: 0 } })
    doc.segments.push({ id: 'sg', from: { type: 'body', refId: 'c1' }, to: { type: 'body', refId: 'c2' }, specifiedLengthMm: 450 })
    writeFileSync(f, JSON.stringify(doc))
    out = []
    expect(await run('check', f, '--json')).toBe(0)
    const off = json().findings.filter((x: { ruleId: string }) => x.ruleId === 'segment-length-off-scale')
    expect(off).toEqual([
      {
        ruleId: 'segment-length-off-scale',
        severity: 'warning',
        message: 'Limb typed 450 mm but drawn 300 mm — press an arrow on its label to rescale',
        refs: [{ kind: 'segment', id: 'sg' }]
      }
    ])
    out = []
    await run('check', f)
    expect(out.join('\n')).toMatch(/\[segment-length-off-scale\] Limb typed 450 mm but drawn 300 mm/)
  })

  it('check reports what the editor would repair', async () => {
    const f = join(tmp, 'rep.harness.json')
    await run('new', f)
    const doc = JSON.parse(readFileSync(f, 'utf8'))
    doc.wireRoutes.push({ wireId: 'ghost', segmentIds: [] })
    writeFileSync(f, JSON.stringify(doc))
    out = []
    expect(await run('check', f, '--json')).toBe(0)
    expect(json().repairs).toEqual([expect.stringContaining('ghost')])
    expect(json().migrated).toEqual([])
    out = []
    await run('check', f)
    expect(out.join('')).toMatch(/would repair this file on open: .*ghost/)
  })

  it('unknown flag exits 2; --help/-h after a command prints usage with exit 0', async () => {
    expect(await run('check', 'f', '--bogus')).toBe(2)
    out = []
    expect(await run('check', '-h')).toBe(0)
    expect(out.join('')).toContain('Usage:')
    out = []
    expect(await run('library', 'put', '--help')).toBe(0)
    expect(out.join('')).toContain('Usage:')
  })
})
