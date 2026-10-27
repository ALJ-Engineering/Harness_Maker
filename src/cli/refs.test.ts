import { describe, it, expect } from 'vitest'
import { emptyDocument } from '@shared/model/document'
import type { HarnessDocument } from '@shared/model/schema'
import { parseEndRef, resolveEndRef } from './refs'

function doc(): HarnessDocument {
  const d = emptyDocument()
  d.connectors.push({
    id: 'c1',
    designator: 'X1',
    cavities: ['10', '2', '1', 'A'].map((p) => ({ id: `cav-${p}`, position: p, status: 'populated' as const }))
  })
  d.splices.push({ id: 's1', designator: 'SP1', kind: 'butt' })
  d.freeTerminals.push({ id: 't1', designator: 'T1', kind: 'ring' })
  d.cables.push({ id: 'k1', name: 'CAN-1', coreWireIds: [], shield: { present: true } })
  d.cables.push({ id: 'k2', name: 'PWR', coreWireIds: [] })
  return d
}

describe('parseEndRef', () => {
  it('parses the four shapes', () => {
    expect(parseEndRef('X1:7')).toEqual({ kind: 'cavity', designator: 'X1', position: '7' })
    expect(parseEndRef('SP1')).toEqual({ kind: 'body', designator: 'SP1' })
    expect(parseEndRef('T1')).toEqual({ kind: 'body', designator: 'T1' })
    expect(parseEndRef('CAN-1:shield:a')).toEqual({ kind: 'shield', cable: 'CAN-1', end: 'a' })
    expect(parseEndRef('CAN-1:shield:b')).toEqual({ kind: 'shield', cable: 'CAN-1', end: 'b' })
  })
  it('refuses empty pieces and surrounding whitespace', () => {
    for (const s of ['', ':7', 'X1:', ' X1:7', 'X1:7 ', 'X1:1:2', 'CAN-1:shield:c']) {
      expect(parseEndRef(s)).toHaveProperty('error')
    }
  })
})

describe('resolveEndRef', () => {
  const r = (s: string) => {
    const ref = parseEndRef(s)
    if ('error' in ref) throw new Error(ref.error)
    return resolveEndRef(doc(), ref)
  }
  it('resolves cavities, splices, terminals and shields exactly', () => {
    expect(r('X1:2')).toEqual({ type: 'cavity', cavityId: 'cav-2' })
    expect(r('X1:A')).toEqual({ type: 'cavity', cavityId: 'cav-A' })
    expect(r('SP1')).toEqual({ type: 'splice', spliceId: 's1' })
    expect(r('T1')).toEqual({ type: 'freeTerminal', terminalId: 't1' })
    expect(r('CAN-1:shield:b')).toEqual({ type: 'shield', cableId: 'k1', end: 'b' })
  })
  it('designators are case-sensitive', () => {
    expect(r('x1:1')).toEqual({ error: expect.stringContaining("no connector 'x1'") })
    expect(r('sp1')).toHaveProperty('error')
  })
  it('positions match exactly, and the refusal lists the real positions in natural order', () => {
    expect(r('X1:01')).toEqual({ error: "X1 has no cavity '01' (positions: 1, 2, 10, A)" })
    expect(r('X1:a')).toEqual({ error: "X1 has no cavity 'a' (positions: 1, 2, 10, A)" })
  })
  it('refuses the wrong body kind for the shape', () => {
    expect(r('X1')).toEqual({ error: expect.stringContaining('X1 is a connector') })
    expect(r('SP1:1')).toEqual({ error: expect.stringContaining('SP1 is a splice') })
    expect(r('T9')).toEqual({ error: expect.stringContaining("no splice or free terminal 'T9'") })
  })
  it('refuses an unknown cable or one without a shield', () => {
    expect(r('CAN-2:shield:a')).toEqual({ error: expect.stringContaining("no cable 'CAN-2'") })
    expect(r('PWR:shield:a')).toEqual({ error: expect.stringContaining('PWR has no shield') })
  })
})
