import { describe, it, expect } from 'vitest'
import { emptyDocument } from '@shared/model/document'
import type { Endpoint, HarnessDocument } from '@shared/model/schema'
import { parseHandleId, sideHandleId } from '@shared/model/endpoints'
import { documentToFlow } from './toFlow'
import { facingSide } from './wireSides'

/**
 * The layout from the screenshot that prompted this: a DCDC connector, ring
 * terminals on both sides of things, a fuse wired from both sides.
 *
 *   DCDC (0,100)   BAT_GND (400,100)                 VCU_GND (900,100)
 *                  BAT_12V (400,250)   FUSE (650,250)  VCU_12V (900,250)
 *                                                    TOP (900,-300), straight above VCU_GND
 */
function loom(fuseExit?: 'nearest'): HarnessDocument {
  const doc = emptyDocument()
  doc.connectors.push(
    { id: 'dcdc', designator: 'DCDC', cavities: [{ id: 'd1', position: '1', status: 'populated' }, { id: 'd2', position: '2', status: 'populated' }] },
    { id: 'fuse', designator: 'FUSE', cavities: [{ id: 'f1', position: '1', status: 'populated' }, { id: 'f2', position: '2', status: 'populated' }] }
  )
  for (const id of ['bat_gnd', 'bat_12v', 'vcu_gnd', 'vcu_12v', 'top'])
    doc.freeTerminals.push({ id, designator: id.toUpperCase(), kind: 'ring' })
  const at: Record<string, [number, number]> = {
    dcdc: [0, 100], bat_gnd: [400, 100], vcu_gnd: [900, 100], bat_12v: [400, 250],
    fuse: [650, 250], vcu_12v: [900, 250], top: [900, -300]
  }
  for (const [refId, [x, y]] of Object.entries(at))
    doc.placements.push({
      refId,
      pos: { x, y },
      schematicPos: { x, y },
      ...(refId === 'fuse' && fuseExit ? { schematicExitSide: fuseExit } : {})
    })
  const ft = (terminalId: string): Endpoint => ({ type: 'freeTerminal', terminalId })
  const cav = (cavityId: string): Endpoint => ({ type: 'cavity', cavityId })
  const wire = (id: string, a: Endpoint, b: Endpoint): void => {
    doc.wires.push({ id, ends: [a, b], gauge: { value: 2.5, unit: 'mm2' }, color: { base: 'RD' } })
  }
  wire('dcdc-gnd', cav('d1'), ft('bat_gnd'))
  wire('gnd-gnd', ft('bat_gnd'), ft('vcu_gnd'))
  wire('from-above', ft('top'), ft('vcu_gnd'))
  wire('bat-fuse', ft('bat_12v'), cav('f1'))
  wire('fuse-vcu', cav('f2'), ft('vcu_12v'))
  return doc
}
const handles = (doc: HarnessDocument, id: string): [string, string] => {
  const e = documentToFlow(doc).edges.find((x) => x.id === id)!
  return [e.sourceHandle!, e.targetHandle!]
}

describe('which side a wire meets a body on', () => {
  it('a ring with a wire on each side takes each on the side facing it', () => {
    const doc = loom()
    expect(handles(doc, 'dcdc-gnd')[1]).toBe('ft:bat_gnd|left')
    expect(handles(doc, 'gnd-gnd')).toEqual(['ft:bat_gnd|right', 'ft:vcu_gnd|left'])
  })

  it('a wire from straight above enters at the top, and leaves its source at the bottom', () => {
    expect(handles(loom(), 'from-above')).toEqual(['ft:top|bottom', 'ft:vcu_gnd|top'])
  })

  it('a connector keeps its exit side; "nearest" gives each pin the side facing its wire', () => {
    // Default (right): FUSE pin 1 leaves right even though BAT_12V is to its left.
    expect(handles(loom(), 'bat-fuse')).toEqual(['ft:bat_12v|right', 'cav:f1'])
    const nearest = loom('nearest')
    expect(handles(nearest, 'bat-fuse')).toEqual(['ft:bat_12v|right', 'cav:f1|left'])
    expect(handles(nearest, 'fuse-vcu')).toEqual(['cav:f2|right', 'ft:vcu_12v|left'])
  })

  it('tells each terminal which of its sides carry a wire, so the rest can stay hidden', () => {
    const sides = (id: string) => {
      const n = documentToFlow(loom()).nodes.find((x) => x.id === id)!
      return [...((n.data as { sides?: string[] }).sides ?? [])].sort()
    }
    expect(sides('bat_gnd')).toEqual(['left', 'right'])
    expect(sides('vcu_gnd')).toEqual(['left', 'top'])
  })

  it('every side parses back to the same endpoint', () => {
    for (const side of ['left', 'top', 'right', 'bottom'] as const) {
      const ep: Endpoint = { type: 'freeTerminal', terminalId: 'bat_gnd' }
      expect(parseHandleId(sideHandleId(ep, side))).toEqual(ep)
    }
    expect(parseHandleId('cav:f1|left')).toEqual({ type: 'cavity', cavityId: 'f1' })
  })

  it('facingSide splits at 45°, ties going to the sides', () => {
    const c = { x: 0, y: 0 }
    expect(facingSide(c, { x: -10, y: 9 })).toBe('left')
    expect(facingSide(c, { x: 10, y: -10 })).toBe('right')
    expect(facingSide(c, { x: 3, y: -10 })).toBe('top')
    expect(facingSide(c, { x: -3, y: 10 })).toBe('bottom')
  })
})
