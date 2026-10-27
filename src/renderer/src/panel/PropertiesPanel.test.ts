import { describe, it, expect } from 'vitest'
import { bodyRemoval, commitDesignator, inspectorHeader } from './PropertiesPanel'
import { demoDocument } from '@shared/model/document'

describe('bodyRemoval (the header Remove button)', () => {
  it('labels a connector by kind and names the wires that go with it', () => {
    const doc = demoDocument()
    const conn = doc.connectors[0]
    const r = bodyRemoval(doc, { kind: 'node', id: conn.id }, 'schematic')
    expect(r?.label).toBe('Remove connector')
    const cavs = new Set(conn.cavities.map((c) => c.id))
    const n = doc.wires.filter((w) => w.ends.some((e) => e.type === 'cavity' && cavs.has(e.cavityId))).length
    expect(n).toBeGreaterThan(0)
    expect(r?.title).toBe(`Removes ${conn.designator} and ${n} wire${n === 1 ? '' : 's'}`)
  })

  it('a body with no wires says so without a count', () => {
    const doc = demoDocument()
    doc.splices.push({ id: 'sp-1', designator: 'SP1', kind: 'butt' })
    expect(bodyRemoval(doc, { kind: 'node', id: 'sp-1' }, 'schematic')).toEqual({
      label: 'Remove splice',
      title: 'Removes SP1'
    })
  })

  it('labels a free terminal', () => {
    const doc = demoDocument()
    const ft = doc.freeTerminals[0]
    expect(bodyRemoval(doc, { kind: 'node', id: ft.id }, 'schematic')?.label).toBe('Remove terminal')
  })

  it('names the demo terminal by designator', () => {
    const doc = demoDocument()
    const ft = doc.freeTerminals.find((f) => f.id === 'ft-bplus')!
    expect(bodyRemoval(doc, { kind: 'node', id: ft.id }, 'schematic')?.title).toBe('Removes T1 and 1 wire')
  })

  it('is absent on the formboard, for wires, and for unknown ids', () => {
    const doc = demoDocument()
    expect(bodyRemoval(doc, { kind: 'node', id: doc.connectors[0].id }, 'formboard')).toBeNull()
    expect(bodyRemoval(doc, { kind: 'edge', id: doc.wires[0].id }, 'schematic')).toBeNull()
    expect(bodyRemoval(doc, { kind: 'node', id: 'nope' }, 'schematic')).toBeNull()
  })
})

describe('commitDesignator', () => {
  it('trims, and refuses blank', () => {
    expect(commitDesignator('  ')).toBeNull()
    expect(commitDesignator('')).toBeNull()
    expect(commitDesignator(' SP3 ')).toBe('SP3')
  })
})

describe('inspectorHeader for terminals and splices', () => {
  it('leads with the designator', () => {
    const doc = demoDocument()
    const ft = doc.freeTerminals.find((f) => f.id === 'ft-bplus')!
    const h = inspectorHeader(doc, { kind: 'node', id: ft.id })
    expect(h.title).toBe('T1')
    expect(h.subtitle).toBe(`Free terminal · ${ft.kind}${ft.landsOn ? ` · ${ft.landsOn}` : ''}`)
    doc.splices.push({ id: 'sp-1', designator: 'SP1', kind: 'butt' })
    expect(inspectorHeader(doc, { kind: 'node', id: 'sp-1' })).toEqual({ title: 'SP1', subtitle: 'Splice · butt' })
  })
})
