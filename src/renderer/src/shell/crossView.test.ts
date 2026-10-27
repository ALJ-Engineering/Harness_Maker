import { describe, it, expect } from 'vitest'
import { emptyDocument } from '@shared/model/document'
import { crossViewIds } from './crossView'

// w1 runs s1 → s2 (a trunk then a breakout); w2 shares the trunk s1 and leaves
// by s3. Built by hand because the demo harness has only one-segment routes, on
// which "every segment of the route" and "the first segment" cannot be told apart.
const doc = emptyDocument()
doc.connectors.push({ id: 'X1', designator: 'X1', cavities: [] })
doc.wireRoutes.push({ wireId: 'w1', path: ['s1', 's2'] }, { wireId: 'w2', path: ['s1', 's3'] })
const longRoute = doc.wireRoutes[0]
const shared = { id: 's1' }

describe('crossViewIds — a selection in one view, highlighted in the other', () => {
  it('a schematic wire lights every segment of its route on the formboard', () => {
    expect(crossViewIds(doc, new Set([longRoute.wireId]), 'formboard')).toEqual(new Set(['s1', 's2']))
  })

  it('a formboard segment lights every wire routed through it in the schematic', () => {
    expect(crossViewIds(doc, new Set([shared.id]), 'schematic')).toEqual(new Set(['w1', 'w2']))
    expect(crossViewIds(doc, new Set(['s3']), 'schematic')).toEqual(new Set(['w2']))
  })

  it('a wire id means nothing in the schematic, a segment id nothing on the formboard', () => {
    expect(crossViewIds(doc, new Set([longRoute.wireId]), 'schematic').size).toBe(0)
    expect(crossViewIds(doc, new Set([shared.id]), 'formboard').size).toBe(0)
  })

  it('a body selection adds nothing — it is already the same node in both views', () => {
    expect(crossViewIds(doc, new Set([doc.connectors[0].id]), 'formboard').size).toBe(0)
    expect(crossViewIds(doc, new Set([doc.connectors[0].id]), 'schematic').size).toBe(0)
  })
})
