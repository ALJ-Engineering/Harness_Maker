import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { newLibraryPart, type LibraryPart } from '@shared/parts/librarySchema'
import { emptyDocument } from '@shared/model/document'
import { wiringTable } from '@shared/print/tableData'
import type { HarnessDocument } from '@shared/model/schema'
import type { LibraryContext } from './session'
import { loadHarness, saveHarness } from './session'
import { applyOps } from './apply'
import { parseOps, type Op } from './ops'
import { full, makeLibrary } from './testLibrary'
import { useHarnessStore } from '../renderer/src/store'

let tmp: string
let lib: LibraryContext
let file: string

const mm05 = { value: 0.5, unit: 'mm2' as const }

function connector(pn: string, positions: string[], pin = 'PIN-1'): LibraryPart {
  const c = full(newLibraryPart('connector', pn))
  c.connector = { cavities: positions.map((position) => ({ position, defaultPin: pin })) }
  return c
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'harness-apply-'))
  const wire = full(newLibraryPart('wire', 'W-05'))
  wire.wire = { gauge: mm05 }
  const cable = full(newLibraryPart('cable', 'CAB-2'))
  cable.cable = {
    cores: [
      { name: 'CAN_H', color: 'WH', gauge: mm05, pair: 'A' },
      { name: 'CAN_L', color: 'BU', gauge: mm05, pair: 'A' },
      { name: 'drain', color: 'BK', gauge: { value: 0.35, unit: 'mm2' } }
    ],
    shield: { drain: true }
  }
  const noDs = connector('HSG-NODS', ['1', '2'])
  const wire075 = full(newLibraryPart('wire', 'W-075'))
  wire075.wire = { gauge: { value: 0.75, unit: 'mm2' } }
  const wireGn = full(newLibraryPart('wire', 'W-GN'))
  wireGn.wire = { gauge: mm05, color: 'GN' }
  const wireGnYe = full(newLibraryPart('wire', 'W-GNYE'))
  wireGnYe.wire = { gauge: mm05, color: 'GN/YE' }
  // Shielded, but the record lists no 'drain' core: the drain's gauge/colour are unknown.
  const cabNoDrainCore = full(newLibraryPart('cable', 'CAB-NDC'))
  cabNoDrainCore.cable = {
    cores: [
      { name: 'CAN_H', color: 'WH', gauge: mm05, pair: 'A' },
      { name: 'CAN_L', color: 'BU', gauge: mm05, pair: 'A' }
    ],
    shield: { drain: true }
  }
  const sealed = full(newLibraryPart('connector', 'HSG-S'))
  sealed.connector = {
    cavities: [
      { position: '1', defaultPin: 'PIN-1', defaultSeal: 'SEAL-1' },
      { position: '2' }
    ]
  }
  const cabNoDs = full(newLibraryPart('cable', 'CAB-NODS'))
  cabNoDs.cable = { cores: [{ name: '1', color: 'WH', gauge: mm05 }] }
  lib = await makeLibrary(
    tmp,
    [
      connector('HSG-4', ['1', '2', '3', '4']),
      noDs,
      full(newLibraryPart('pin', 'PIN-1')),
      full(newLibraryPart('splice', 'SPL-1')),
      full(newLibraryPart('terminal', 'RING-1')),
      full(newLibraryPart('plug', 'PLUG-1')),
      wire,
      wire075,
      wireGn,
      wireGnYe,
      cable,
      cabNoDs,
      cabNoDrainCore,
      full(newLibraryPart('seal', 'SEAL-1')),
      sealed
    ],
    ['HSG-4', 'PIN-1', 'SPL-1', 'RING-1', 'PLUG-1', 'W-05', 'W-075', 'W-GN', 'W-GNYE', 'CAB-2', 'SEAL-1', 'CAB-NDC', 'HSG-S']
  )
  file = join(tmp, 'a.harness.json')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const twoConnectors: Op[] = [
  { op: 'place', kind: 'connector', partNumber: 'HSG-4' },
  { op: 'place', kind: 'connector', partNumber: 'HSG-4' }
]
const gn = (from: string, to: string, extra: Partial<Extract<Op, { op: 'wire' }>> = {}): Op => ({
  op: 'wire',
  from,
  to,
  partNumber: 'W-05',
  color: 'GN',
  ...extra
})

async function create(ops: Op[]) {
  return applyOps(file, ops, lib, { create: true })
}
async function edit(ops: Op[]) {
  return applyOps(file, ops, lib, { create: false })
}
const docOnDisk = async (): Promise<HarnessDocument> => (await loadHarness(file)).doc
const rows = (doc: HarnessDocument) => wiringTable(doc).rows.map((r) => `${r.from} → ${r.to}`)
function errorsOf(r: Awaited<ReturnType<typeof applyOps>>): string[] {
  if (r.ok) throw new Error(`expected a refusal, got ok: ${r.summary.join('; ')}`)
  return r.errors
}
/** A hand-built document saved straight to `file` (as if drawn in the app). */
async function seed(mutate: (d: HarnessDocument) => void): Promise<void> {
  const d = emptyDocument()
  mutate(d)
  await saveHarness(file, d)
}

describe('applyOps — happy path', () => {
  it('places X1/X2 and wires X1:1 → X2:1 GN with a complete wire part', async () => {
    const r = await create([...twoConnectors, gn('X1:1', 'X2:1')])
    expect(r.ok).toBe(true)
    const doc = await docOnDisk()
    expect(doc.connectors.map((c) => c.designator)).toEqual(['X1', 'X2'])
    expect(rows(doc)).toEqual(['X1.1 → X2.1'])
    expect(doc.wires[0]).toMatchObject({ gauge: mm05, color: { base: 'GN' }, spec: { partNumber: 'W-05' } })
    expect((await loadHarness(file)).repairs).toEqual([])
  })

  it('never writes drawing.sheetOrigin — the CLI leaves the sheet framed by the planner (spec §1)', async () => {
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1')])).ok).toBe(true)
    expect((await docOnDisk()).drawing.sheetOrigin).toBeUndefined()
    expect(readFileSync(file, 'utf8')).not.toContain('sheetOrigin')
    // …and an edit of an existing file without one does not add it either.
    expect((await edit([gn('X1:2', 'X2:2')])).ok).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('sheetOrigin')
    expect(useHarnessStore.getState().loadMigrations).toEqual([])
  })

  it('a striped colour, an explicit designator, a splice and a terminal landing on a stud', async () => {
    const r = await create([
      { op: 'place', kind: 'connector', partNumber: 'HSG-4', designator: 'X7' },
      { op: 'place', kind: 'splice', partNumber: 'SPL-1' },
      { op: 'place', kind: 'terminal', partNumber: 'RING-1', landsOn: 'B+ stud' },
      gn('X7:1', 'SP1', { color: 'GN/YE', gauge: mm05 }),
      gn('SP1', 'T1')
    ])
    expect(r.ok).toBe(true)
    const doc = await docOnDisk()
    expect(doc.connectors[0].designator).toBe('X7')
    expect(doc.freeTerminals[0]).toMatchObject({ designator: 'T1', landsOn: 'B+ stud', part: { partNumber: 'RING-1' } })
    expect(doc.wires[0].color).toEqual({ base: 'GN', stripes: ['YE'] })
    expect(rows(doc)).toHaveLength(2)
  })

  it('builds a CAN cable with a drain to a cavity', async () => {
    const r = await create([
      ...twoConnectors,
      {
        op: 'cable',
        partNumber: 'CAB-2',
        name: 'CAN-1',
        cores: [
          { core: 'CAN_H', from: 'X1:1', to: 'X2:1' },
          { core: 'CAN_L', from: 'X1:2', to: 'X2:2' }
        ],
        drain: { end: 'a', to: 'X1:3' }
      }
    ])
    expect(r.ok).toBe(true)
    const doc = await docOnDisk()
    expect(doc.cables).toHaveLength(1)
    expect(doc.wires.filter((w) => w.cableId === doc.cables[0].id)).toHaveLength(3)
    expect(rows(doc)).toEqual(['X1.1 → X2.1', 'X1.2 → X2.2', 'CAN-1 shield a → X1.3'])
  })

  it('marks cavities empty/plugged, edits and removes a wire by its end pair', async () => {
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1'), gn('X1:2', 'X2:2')])).ok).toBe(true)
    const r = await edit([
      { op: 'cavity', at: 'X1:4', status: 'empty' },
      { op: 'cavity', at: 'X2:4', status: 'plugged', plugPartNumber: 'PLUG-1' },
      { op: 'set-wire', from: 'X2:1', to: 'X1:1', color: 'RD' },
      { op: 'unwire', from: 'X1:2', to: 'X2:2' }
    ])
    expect(r.ok).toBe(true)
    const doc = await docOnDisk()
    const cav = (d: string, p: string) =>
      doc.connectors.find((c) => c.designator === d)!.cavities.find((c) => c.position === p)!
    expect(cav('X1', '4')).toMatchObject({ status: 'empty' })
    expect(cav('X1', '4').pin).toBeUndefined()
    expect(cav('X2', '4')).toMatchObject({ status: 'plugged', plug: { partNumber: 'PLUG-1' } })
    expect(doc.wires).toHaveLength(1)
    expect(doc.wires[0].color).toEqual({ base: 'RD' })
  })

  it('remove X1 cascades its wires', async () => {
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1'), gn('X2:2', 'X2:3')])).ok).toBe(true)
    expect((await edit([{ op: 'remove', ref: 'X1' }])).ok).toBe(true)
    const doc = await docOnDisk()
    expect(doc.connectors.map((c) => c.designator)).toEqual(['X2'])
    expect(rows(doc)).toEqual(['X2.2 → X2.3'])
    expect(doc.placements).toHaveLength(1)
  })
})

describe('applyOps — all or nothing', () => {
  it('a 7-op batch whose 7th op fails leaves the file byte-identical and names op #7', async () => {
    expect((await create(twoConnectors)).ok).toBe(true)
    const before = readFileSync(file)
    const errors = errorsOf(
      await edit([
        { op: 'place', kind: 'connector', partNumber: 'HSG-4' },
        { op: 'place', kind: 'splice', partNumber: 'SPL-1' },
        gn('X1:1', 'X2:1'),
        gn('X1:2', 'SP1'),
        gn('X3:1', 'SP1'),
        { op: 'cavity', at: 'X3:4', status: 'empty' },
        gn('X1:3', 'X2:9')
      ])
    )
    expect(errors[0]).toMatch(/^op #7 \(wire\): /)
    expect(errors[0]).toContain("X2 has no cavity '9' (positions: 1, 2, 3, 4)")
    expect(readFileSync(file).equals(before)).toBe(true)
    expect(readdirSync(tmp).sort()).toEqual(['a.harness.json', 'lib', 'stub-datasheet.pdf'])
  })

  it('--create with a failing op writes no file at all', async () => {
    errorsOf(await create([...twoConnectors, gn('X1:1', 'X9:1')]))
    expect(existsSync(file)).toBe(false)
  })

  it('every end resolves before any store call: an unknown designator or position is refused, nothing written', async () => {
    expect((await create(twoConnectors)).ok).toBe(true)
    const before = readFileSync(file)
    for (const bad of [gn('X1:1', 'X9:1'), gn('X1:5', 'X2:1'), gn('X1:1', 'SP4'), gn('X1:1', 'NOPE:shield:a')]) {
      const errors = errorsOf(await edit([bad]))
      expect(errors[0]).toMatch(/^op #1 \(wire\): /)
      expect(readFileSync(file).equals(before)).toBe(true)
    }
    const cableErr = errorsOf(
      await edit([
        { op: 'cable', partNumber: 'CAB-2', name: 'CAN-1', cores: [{ core: 'CAN_H', from: 'X1:1', to: 'X2:1' }], drain: { end: 'a', to: 'X3:1' } }
      ])
    )
    expect(cableErr[0]).toContain("no connector 'X3'")
    expect(readFileSync(file).equals(before)).toBe(true)
  })

  it('refuses to --create over an existing file, and to edit a missing one', async () => {
    expect((await create(twoConnectors)).ok).toBe(true)
    expect(errorsOf(await create([]))[0]).toContain('already exists')
    expect(errorsOf(await applyOps(join(tmp, 'none.harness.json'), [], lib, { create: false }))[0]).toMatch(/cannot read/)
  })
})

describe('applyOps — end references', () => {
  beforeEach(async () => {
    expect((await create(twoConnectors)).ok).toBe(true)
  })
  it('designators are case-sensitive: x1:1 is refused', async () => {
    expect(errorsOf(await edit([gn('x1:1', 'X2:1')]))[0]).toContain("no connector 'x1'")
  })
  it('positions match exactly: X1:01 is refused with the real positions listed', async () => {
    expect(errorsOf(await edit([gn('X1:01', 'X2:1')]))[0]).toBe(
      "op #1 (wire): X1 has no cavity '01' (positions: 1, 2, 3, 4)"
    )
  })
})

describe('applyOps — part rails', () => {
  it('a part whose datasheet file is missing is refused, naming it', async () => {
    const errors = errorsOf(await create([{ op: 'place', kind: 'connector', partNumber: 'HSG-NODS' }]))
    expect(errors).toEqual(['op #1 (place): HSG-NODS: no datasheet file'])
    expect(existsSync(file)).toBe(false)
  })
  it('a part of the wrong kind, or not in the library, is refused', async () => {
    expect(errorsOf(await create([{ op: 'place', kind: 'splice', partNumber: 'HSG-4' }]))[0]).toContain(
      'HSG-4: is a connector, expected splice'
    )
    expect(errorsOf(await create([...twoConnectors, gn('X1:1', 'X2:1', { partNumber: 'W-XX' })]))[0]).toContain(
      'W-XX: not in library'
    )
    expect(
      errorsOf(await create([...twoConnectors, { op: 'cavity', at: 'X1:1', status: 'plugged', plugPartNumber: 'PIN-1' }]))[0]
    ).toContain('PIN-1: is a pin, expected plug')
  })
  it('an explicit gauge that differs from the wire part is refused; an equal one is accepted', async () => {
    const errors = errorsOf(await create([...twoConnectors, gn('X1:1', 'X2:1', { gauge: { value: 0.75, unit: 'mm2' } })]))
    expect(errors[0]).toBe('op #3 (wire): W-05 fixes the gauge at 0.5 mm2; 0.75 mm2 was asked for')
    expect(existsSync(file)).toBe(false)
    expect(errorsOf(await create([...twoConnectors, gn('X1:1', 'X2:1', { gauge: { value: 0.5, unit: 'AWG' } })]))[0]).toContain(
      'fixes the gauge'
    )
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1', { gauge: mm05 })])).ok).toBe(true)
  })
  it('a taken designator is refused', async () => {
    expect(
      errorsOf(await create([...twoConnectors, { op: 'place', kind: 'splice', partNumber: 'SPL-1', designator: 'X2' }]))[0]
    ).toBe("op #3 (place): designator 'X2' is already taken")
  })
})

describe('applyOps — touched existing connectors', () => {
  const handBuilt = (housing: string | undefined, positions: string[], designator = 'X1') => (d: HarnessDocument) => {
    const id = `hb-${designator}`
    d.connectors.push({
      id,
      designator,
      ...(housing ? { housing: { partNumber: housing } } : {}),
      cavities: positions.map((p) => ({ id: `${id}-${p}`, position: p, status: 'populated' as const }))
    })
    d.placements.push({ refId: id, pos: { x: 0, y: 0 }, schematicPos: { x: 0, y: 0 } })
  }

  it('an untouched incomplete connector does not block the batch', async () => {
    await seed(handBuilt(undefined, ['1', '2'], 'X9'))
    const r = await edit([...twoConnectors, gn('X1:1', 'X2:1')])
    expect(r.ok).toBe(true)
    const doc = await docOnDisk()
    expect(doc.connectors.map((c) => c.designator)).toEqual(['X9', 'X1', 'X2'])
  })

  it('wiring to a hand-built connector whose cavities differ from its record is refused, listing both', async () => {
    await seed(handBuilt('HSG-4', ['1', '2', '3']))
    const before = readFileSync(file)
    const errors = errorsOf(await edit([{ op: 'place', kind: 'connector', partNumber: 'HSG-4' }, gn('X1:1', 'X2:1')]))
    expect(errors).toEqual([
      'op #2 (wire): X1: cavities [1, 2, 3] do not match library record HSG-4 [1, 2, 3, 4]'
    ])
    expect(readFileSync(file).equals(before)).toBe(true)
  })

  it('touching a hand-built connector without a housing part, or with an incomplete one, is refused', async () => {
    await seed(handBuilt(undefined, ['1']))
    expect(errorsOf(await edit([{ op: 'cavity', at: 'X1:1', status: 'empty' }]))).toEqual([
      'op #1 (cavity): X1: connector has no housing part number'
    ])
    await seed(handBuilt('HSG-NODS', ['1', '2']))
    expect(errorsOf(await edit([{ op: 'cavity', at: 'X1:1', status: 'empty' }]))).toEqual([
      'op #1 (cavity): X1: housing HSG-NODS: no datasheet file'
    ])
  })

  it('a hand-built connector that matches its complete record can be wired', async () => {
    await seed(handBuilt('HSG-4', ['4', '3', '2', '1']))
    expect((await edit([{ op: 'place', kind: 'connector', partNumber: 'HSG-4' }, gn('X1:1', 'X2:1')])).ok).toBe(true)
  })
})

describe('applyOps — cable members', () => {
  it('set-wire / unwire on a cable core or drain is refused, saying to edit the cable', async () => {
    expect(
      (
        await create([
          ...twoConnectors,
          { op: 'cable', partNumber: 'CAB-2', name: 'CAN-1', cores: [{ core: 'CAN_H', from: 'X1:1', to: 'X2:1' }], drain: { end: 'b', to: 'X2:3' } }
        ])
      ).ok
    ).toBe(true)
    expect(errorsOf(await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', color: 'RD' }]))).toEqual([
      'op #1 (set-wire): the wire X1:1 → X2:1 is core CAN_H of cable CAN-1; edit the cable (remove CAN-1 and add it again)'
    ])
    expect(errorsOf(await edit([{ op: 'unwire', from: 'X2:3', to: 'CAN-1:shield:b' }]))[0]).toContain('is the drain of cable CAN-1')
    expect((await edit([{ op: 'remove', ref: 'CAN-1' }])).ok).toBe(true)
    const doc = await docOnDisk()
    expect(doc.cables).toEqual([])
    expect(doc.wires).toEqual([])
  })
})

describe('applyOps — wire matching and refusals', () => {
  beforeEach(async () => {
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1'), gn('X1:1', 'X2:1'), gn('X1:2', 'X2:2')])).ok).toBe(true)
  })
  it('set-wire / unwire refuse zero or several matches', async () => {
    expect(errorsOf(await edit([{ op: 'unwire', from: 'X1:1', to: 'X2:1' }]))[0]).toContain('2 wires')
    expect(errorsOf(await edit([{ op: 'set-wire', from: 'X1:3', to: 'X2:3', color: 'RD' }]))[0]).toContain('no wire')
  })
  it('cavity status on a wired cavity is refused', async () => {
    expect(errorsOf(await edit([{ op: 'cavity', at: 'X1:2', status: 'empty' }]))[0]).toContain('has 1 wire')
  })
})

describe('applyOps — wire colour rail', () => {
  it('wire: a colour-specific record refuses another colour, naming the record and both colours', async () => {
    expect(errorsOf(await create([...twoConnectors, gn('X1:1', 'X2:1', { partNumber: 'W-GN', color: 'WH' })]))).toEqual([
      'op #3 (wire): W-GN is the GN wire; colour WH was asked for'
    ])
    expect(existsSync(file)).toBe(false)
  })
  it('wire: the matching colour is accepted (base compared, case-insensitive)', async () => {
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1', { partNumber: 'W-GN', color: 'gn' })])).ok).toBe(true)
  })
  it('wire: a striped record colour must match exactly', async () => {
    expect(errorsOf(await create([...twoConnectors, gn('X1:1', 'X2:1', { partNumber: 'W-GNYE', color: 'GN' })]))[0]).toBe(
      'op #3 (wire): W-GNYE is the GN/YE wire; colour GN was asked for'
    )
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1', { partNumber: 'W-GNYE', color: 'GN/YE' })])).ok).toBe(true)
  })
  it('wire: a type record (no wire.color) takes any colour', async () => {
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1', { color: 'WH' }), gn('X1:2', 'X2:2', { color: 'RD/BK' })])).ok).toBe(true)
  })
  it('set-wire: a new colour against the wire\'s colour-specific record is refused; matching is accepted', async () => {
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1', { partNumber: 'W-GN' })])).ok).toBe(true)
    expect(errorsOf(await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', color: 'WH' }]))).toEqual([
      'op #1 (set-wire): W-GN is the GN wire; colour WH was asked for'
    ])
    expect((await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', color: 'GN' }])).ok).toBe(true)
  })
  it('set-wire: a new colour-specific record must match the wire\'s colour (given or existing)', async () => {
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1', { color: 'WH' })])).ok).toBe(true)
    expect(errorsOf(await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', partNumber: 'W-GN' }]))).toEqual([
      'op #1 (set-wire): W-GN is the GN wire; colour WH was asked for'
    ])
    expect(errorsOf(await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', partNumber: 'W-GN', color: 'RD' }]))[0]).toContain(
      'colour RD was asked for'
    )
    expect((await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', partNumber: 'W-GN', color: 'GN' }])).ok).toBe(true)
    expect((await docOnDisk()).wires[0]).toMatchObject({ color: { base: 'GN' }, spec: { partNumber: 'W-GN' } })
  })
  it('set-wire: a type record takes any colour', async () => {
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1')])).ok).toBe(true)
    expect((await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', color: 'VT' }])).ok).toBe(true)
  })
})

describe('final review — drain core (I3)', () => {
  const canCable = (pn: string): Op => ({
    op: 'cable',
    partNumber: pn,
    name: 'CAN-1',
    cores: [
      { core: 'CAN_H', from: 'X1:1', to: 'X2:1' },
      { core: 'CAN_L', from: 'X1:2', to: 'X2:2' }
    ],
    drain: { end: 'a', to: 'X1:3' }
  })
  it('a drain on a shielded cable record with no drain core is refused; nothing written', async () => {
    expect(errorsOf(await create([...twoConnectors, canCable('CAB-NDC')]))).toEqual([
      "op #3 (cable): CAB-NDC has no 'drain' core — the drain's gauge and colour must come from the datasheet; add a core named 'drain'"
    ])
    expect(existsSync(file)).toBe(false)
  })
  it('the same cable without a drain is accepted', async () => {
    const { drain: _d, ...noDrain } = canCable('CAB-NDC') as Extract<Op, { op: 'cable' }>
    expect((await create([...twoConnectors, noDrain])).ok).toBe(true)
  })
  it('with a drain core the drain takes its gauge and colour from the record', async () => {
    expect((await create([...twoConnectors, canCable('CAB-2')])).ok).toBe(true)
    const drain = (await docOnDisk()).wires.find((w) => w.ends.some((e) => e.type === 'shield'))!
    expect(drain).toMatchObject({ gauge: { value: 0.35, unit: 'mm2' }, color: { base: 'BK' } })
  })
})

describe('final review — cavity populated', () => {
  const sealedPair: Op[] = [
    { op: 'place', kind: 'connector', partNumber: 'HSG-S' },
    { op: 'place', kind: 'connector', partNumber: 'HSG-S' }
  ]
  const cav = async (at: string) => {
    const [d, p] = at.split(':')
    return (await docOnDisk()).connectors.find((c) => c.designator === d)!.cavities.find((c) => c.position === p)!
  }
  it('undoes a mistaken empty: populated, pin and seal re-filled from the housing record, wireable again', async () => {
    expect((await create([...sealedPair, { op: 'cavity', at: 'X1:1', status: 'empty' }])).ok).toBe(true)
    expect(await cav('X1:1')).toEqual(expect.not.objectContaining({ pin: expect.anything() }))
    const r = await edit([{ op: 'cavity', at: 'X1:1', status: 'populated' }, gn('X1:1', 'X2:1')])
    expect(r).toMatchObject({ ok: true, summary: ['cavity X1:1 populated (pin PIN-1, seal SEAL-1)', expect.stringContaining('wired X1:1')] })
    expect(await cav('X1:1')).toMatchObject({ status: 'populated', pin: { partNumber: 'PIN-1' }, seal: { partNumber: 'SEAL-1' } })
  })
  it('undoes a plugged cavity: plug cleared; a position the record gives no defaults stays without pin/seal', async () => {
    expect((await create([...sealedPair, { op: 'cavity', at: 'X1:2', status: 'plugged', plugPartNumber: 'PLUG-1' }])).ok).toBe(true)
    const r = await edit([{ op: 'cavity', at: 'X1:2', status: 'populated' }])
    expect(r).toMatchObject({ ok: true, summary: ['cavity X1:2 populated (no default pin or seal in HSG-S)'] })
    const c = await cav('X1:2')
    expect(c.status).toBe('populated')
    expect(c.plug).toBeUndefined()
    expect(c.pin).toBeUndefined()
    expect(c.seal).toBeUndefined()
  })
  it('an already populated (and wired) cavity is left unchanged; plugPartNumber is refused', async () => {
    expect((await create([...sealedPair, gn('X1:1', 'X2:1')])).ok).toBe(true)
    const before = await cav('X1:1')
    expect(await edit([{ op: 'cavity', at: 'X1:1', status: 'populated' }])).toMatchObject({
      ok: true,
      summary: ['cavity X1:1 already populated (unchanged)']
    })
    expect(await cav('X1:1')).toEqual(before)
    expect(errorsOf(await edit([{ op: 'cavity', at: 'X1:2', status: 'populated', plugPartNumber: 'PLUG-1' }]))).toEqual([
      "op #1 (cavity): plugPartNumber is only for status 'plugged'"
    ])
  })
  it('parseOps accepts populated', () => {
    expect(parseOps([{ op: 'cavity', at: 'X1:1', status: 'populated' }])).toEqual([{ op: 'cavity', at: 'X1:1', status: 'populated' }])
  })
})

describe('final review — a wire end on a cable shield checks the cable record', () => {
  const build = async () =>
    expect(
      (
        await create([
          ...twoConnectors,
          { op: 'cable', partNumber: 'CAB-2', name: 'CAN-1', cores: [{ core: 'CAN_H', from: 'X1:1', to: 'X2:1' }] }
        ])
      ).ok
    ).toBe(true)
  const setCablePart = async (pn: string | undefined) => {
    const d = await docOnDisk()
    if (pn) d.cables[0].part = { partNumber: pn }
    else delete d.cables[0].part
    await saveHarness(file, d)
  }
  it('a complete cable record: the shield wire is accepted', async () => {
    await build()
    expect((await edit([gn('CAN-1:shield:a', 'X1:2')])).ok).toBe(true)
  })
  it('a cable with no part is refused', async () => {
    await build()
    await setCablePart(undefined)
    expect(errorsOf(await edit([gn('CAN-1:shield:a', 'X1:2')]))).toEqual([
      'op #1 (wire): CAN-1:shield:a: cable CAN-1 has no part — complete it with a library cable record before wiring to its shield'
    ])
  })
  it('a cable whose record is incomplete or not a cable is refused, naming it', async () => {
    await build()
    await setCablePart('CAB-NODS')
    expect(errorsOf(await edit([gn('CAN-1:shield:a', 'X1:2')]))).toEqual([
      'op #1 (wire): CAN-1:shield:a: cable CAB-NODS: no datasheet file'
    ])
    await setCablePart('W-05')
    expect(errorsOf(await edit([gn('CAN-1:shield:a', 'X1:2')]))[0]).toContain('W-05: is a wire, expected cable')
  })
})

describe('parseOps', () => {
  it('accepts a well-formed batch', () => {
    const ops = [...twoConnectors, gn('X1:1', 'X2:1', { gauge: mm05 }), { op: 'remove', ref: 'X1' }]
    expect(parseOps(ops)).toEqual(ops)
  })
  it('refuses a non-array, an unknown op, a missing or unknown field, a bad enum or gauge', () => {
    expect(parseOps({})).toEqual({ error: 'the batch must be a JSON array of operations' })
    expect(parseOps([{ op: 'move' }])).toHaveProperty('error', expect.stringMatching(/^op #1: 'op' must be one of/))
    expect(parseOps([{ op: 'wire', from: 'X1:1', to: 'X2:1', color: 'GN' }])).toEqual({ error: "op #1 (wire): missing 'partNumber'" })
    expect(parseOps([{ op: 'wire', from: 'X1:1', to: 'X2:1', color: 'GN', partNumber: 'W', colour: 'RD' }])).toEqual({
      error: "op #1 (wire): unknown field 'colour'"
    })
    expect(parseOps([{ op: 'place', kind: 'housing', partNumber: 'P' }])).toHaveProperty('error', expect.stringContaining("'kind' must be one of"))
    expect(parseOps([gn('a', 'b', { gauge: { value: 0.5, unit: 'mm' } as never })])).toHaveProperty('error', expect.stringContaining("'gauge'"))
    expect(parseOps([{ op: 'cable', partNumber: 'C', name: 'N', cores: [] }])).toHaveProperty('error', expect.stringContaining("'cores'"))
  })
})

const canCore = (from: string, to: string, partNumber = 'CAB-2'): Op => ({
  op: 'cable',
  partNumber,
  name: 'CAN-1',
  cores: [{ core: 'CAN_H', from, to }]
})

/** Hand-built X1 (HSG-4 housing) and X2 with a hand-drawn wire X1:1 → X2:1, saved as if from the app. */
async function seedHandBuilt(x1Positions: string[], cav: Partial<HarnessDocument['connectors'][0]['cavities'][0]> = {}) {
  await seed((d) => {
    d.connectors.push({
      id: 'x1',
      designator: 'X1',
      housing: { partNumber: 'HSG-4' },
      cavities: x1Positions.map((p, i) => ({ id: `x1-${i}`, position: p, status: 'populated' as const, ...cav }))
    })
    d.connectors.push({
      id: 'x2',
      designator: 'X2',
      housing: { partNumber: 'HSG-4' },
      cavities: ['1', '2', '3', '4'].map((p) => ({ id: `x2-${p}`, position: p, status: 'populated' as const }))
    })
    d.splices.push({ id: 'sp', designator: 'SP1', kind: 'butt' })
    d.freeTerminals.push({ id: 'ft', designator: 'T1', kind: 'ring', part: { partNumber: 'MADE-UP-RING' } })
    for (const id of ['x1', 'x2', 'sp', 'ft']) d.placements.push({ refId: id, pos: { x: 0, y: 0 } })
    d.wires.push({ id: 'w1', ends: [{ type: 'cavity', cavityId: 'x1-0' }, { type: 'cavity', cavityId: 'x2-1' }], gauge: mm05, color: { base: 'GY' } })
  })
}

describe('fix round 1 — cavity status', () => {
  beforeEach(async () => {
    expect(
      (await create([...twoConnectors, { op: 'cavity', at: 'X1:4', status: 'empty' }, { op: 'cavity', at: 'X2:4', status: 'plugged', plugPartNumber: 'PLUG-1' }])).ok
    ).toBe(true)
  })
  it('a wire into an empty or plugged cavity is refused', async () => {
    expect(errorsOf(await edit([gn('X1:4', 'X2:1')]))).toEqual(['op #1 (wire): X1:4 is empty; a wire cannot land in it'])
    expect(errorsOf(await edit([gn('X1:1', 'X2:4')]))).toEqual(['op #1 (wire): X2:4 is plugged; a wire cannot land in it'])
  })
  it('a cable core into an empty or plugged cavity is refused', async () => {
    expect(errorsOf(await edit([canCore('X1:4', 'X2:1')]))).toEqual(['op #1 (cable): X1:4 is empty; a wire cannot land in it'])
    expect(errorsOf(await edit([canCore('X1:1', 'X2:4')]))).toEqual(['op #1 (cable): X2:4 is plugged; a wire cannot land in it'])
  })
})

describe('fix round 1 — touched splices, terminals, pins and seals', () => {
  it('a splice with no part, or a terminal with a made-up part, is refused as an end', async () => {
    await seedHandBuilt(['1', '2', '3', '4'])
    expect(errorsOf(await edit([gn('X1:2', 'SP1')]))).toEqual([
      'op #1 (wire): SP1 has no part — complete it with a library splice record before wiring to it'
    ])
    expect(errorsOf(await edit([gn('X1:2', 'T1')]))).toEqual(['op #1 (wire): T1: part MADE-UP-RING: not in library'])
    expect(errorsOf(await edit([canCore('X1:2', 'T1')]))[0]).toContain('MADE-UP-RING: not in library')
  })
  it('a touched cavity with a made-up pin or seal is refused; one with no pin is not', async () => {
    await seedHandBuilt(['1', '2', '3', '4'], { pin: { partNumber: 'MADE-UP-PIN' } })
    expect(errorsOf(await edit([gn('X1:2', 'X2:2')]))).toEqual(['op #1 (wire): X1:2: pin MADE-UP-PIN: not in library'])
    expect(errorsOf(await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', color: 'RD' }]))[0]).toContain('X1:1: pin MADE-UP-PIN')
    await seedHandBuilt(['1', '2', '3', '4'], { pin: { partNumber: 'PIN-1' }, seal: { partNumber: 'MADE-UP-SEAL' } })
    expect(errorsOf(await edit([canCore('X1:2', 'X2:2')]))).toEqual(['op #1 (cable): X1:2: seal MADE-UP-SEAL: not in library'])
    await seedHandBuilt(['1', '2', '3', '4'], { pin: { partNumber: 'PIN-1' }, seal: { partNumber: 'SEAL-1' } })
    expect((await edit([gn('X1:2', 'X2:2')])).ok).toBe(true)
    await seedHandBuilt(['1', '2', '3', '4'])
    expect((await edit([gn('X1:2', 'X2:2')])).ok).toBe(true)
  })
})

describe('fix round 1 — rails on cable and set-wire', () => {
  it('cable part completeness', async () => {
    expect(errorsOf(await create([...twoConnectors, canCore('X1:1', 'X2:1', 'CAB-NODS')]))).toEqual([
      'op #3 (cable): CAB-NODS: no datasheet file'
    ])
  })
  it('set-wire part completeness', async () => {
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1')])).ok).toBe(true)
    expect(errorsOf(await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', partNumber: 'W-XX' }]))).toEqual([
      'op #1 (set-wire): W-XX: not in library'
    ])
    expect(errorsOf(await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', partNumber: 'HSG-4' }]))[0]).toContain(
      'HSG-4: is a connector, expected wire'
    )
  })
  it('the connector rail applies to cable ends and to set-wire ends', async () => {
    await seedHandBuilt(['1', '2', '3'])
    const mismatch = 'X1: cavities [1, 2, 3] do not match library record HSG-4 [1, 2, 3, 4]'
    expect(errorsOf(await edit([canCore('X1:2', 'X2:2')]))).toEqual([`op #1 (cable): ${mismatch}`])
    expect(errorsOf(await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', color: 'RD' }]))).toEqual([`op #1 (set-wire): ${mismatch}`])
  })
  it('set-wire with a new wire part takes that part\'s gauge (rail 2a)', async () => {
    expect((await create([...twoConnectors, gn('X1:1', 'X2:1')])).ok).toBe(true)
    expect((await edit([{ op: 'set-wire', from: 'X1:1', to: 'X2:1', partNumber: 'W-075' }])).ok).toBe(true)
    expect((await docOnDisk()).wires[0]).toMatchObject({ gauge: { value: 0.75, unit: 'mm2' }, spec: { partNumber: 'W-075' }, color: { base: 'GN' } })
  })
})

describe('fix round 1 — minor', () => {
  it('M1: a refused batch leaves no half-applied document or history in the store', async () => {
    errorsOf(await create([...twoConnectors, gn('X1:1', 'X9:1')]))
    const st = useHarnessStore.getState()
    expect(st.doc.connectors).toEqual([])
    expect(st.past).toEqual([])
    expect(st.filePath).toBeNull()
  })
  it('M2: duplicate hand-built positions do not match the record', async () => {
    await seedHandBuilt(['1', '1', '2', '3', '4'])
    expect(errorsOf(await edit([gn('X1:3', 'X2:3')]))).toEqual([
      'op #1 (wire): X1: cavities [1, 1, 2, 3, 4] do not match library record HSG-4 [1, 2, 3, 4]'
    ])
  })
  it('M4: removing a cable also clears the twist, label and sleeving on it; the save is clean', async () => {
    expect(
      (
        await create([
          ...twoConnectors,
          { op: 'cable', partNumber: 'CAB-2', name: 'CAN-1', cores: [{ core: 'CAN_H', from: 'X1:1', to: 'X2:1' }, { core: 'CAN_L', from: 'X1:2', to: 'X2:2' }] }
        ])
      ).ok
    ).toBe(true)
    const doc = await docOnDisk()
    const cab = doc.cables[0]
    const seg = doc.wireRoutes[0].path
    doc.twists.push({ id: 'tw', wireIds: [...cab.coreWireIds], span: { segmentIds: seg } })
    doc.labels.push({ id: 'lb', target: { type: 'wire', wireId: cab.coreWireIds[0] }, kind: 'callout', text: 'CAN', pos: { x: 0, y: 0 } })
    doc.sleeving.push({ id: 'sl', target: { type: 'cable', cableId: cab.id }, span: { segmentIds: seg }, sleevingType: 'braided' })
    await saveHarness(file, doc)
    expect((await edit([{ op: 'remove', ref: 'CAN-1' }])).ok).toBe(true)
    const after = await loadHarness(file)
    expect(after.repairs).toEqual([])
    expect([after.doc.cables, after.doc.twists, after.doc.labels, after.doc.sleeving]).toEqual([[], [], [], []])
  })
})
