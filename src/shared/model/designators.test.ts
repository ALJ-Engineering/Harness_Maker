import { describe, it, expect } from 'vitest'
import { allDesignators, backfillDesignators, nextDesignator, DESIGNATOR_PREFIX } from './designators'
import { emptyDocument } from './document'
import type { FreeTerminal, Splice } from './schema'

const term = (id: string, d?: string, landsOn?: string) =>
  ({ id, kind: 'ring', designator: d, landsOn }) as unknown as FreeTerminal
const spl = (id: string, d?: string) => ({ id, kind: 'butt', designator: d }) as unknown as Splice

describe('nextDesignator', () => {
  it('starts at 1', () => expect(nextDesignator('T', [])).toBe('T1'))
  it('takes the lowest free number', () => expect(nextDesignator('T', ['T1', 'T3'])).toBe('T2'))
  it('is case-sensitive', () => expect(nextDesignator('SP', ['sp1'])).toBe('SP1'))
  it('exposes the prefixes', () =>
    expect(DESIGNATOR_PREFIX).toEqual({ connector: 'X', terminal: 'T', splice: 'SP' }))
})

describe('backfillDesignators', () => {
  it('assigns the lowest free designator, skipping existing ones', () => {
    const d = emptyDocument()
    d.freeTerminals = [term('a'), term('b', 'T1')]
    expect(backfillDesignators(d)).toBe(1)
    expect(d.freeTerminals[0].designator).toBe('T2')
  })
  it('ignores landsOn', () => {
    const d = emptyDocument()
    d.freeTerminals = [term('a', undefined, 'T1')]
    backfillDesignators(d)
    expect(d.freeTerminals[0].designator).toBe('T1')
  })
  it('treats blank as missing', () => {
    const d = emptyDocument()
    d.splices = [spl('s', '  '), spl('t')]
    expect(backfillDesignators(d)).toBe(2)
    expect(d.splices.map((s) => s.designator)).toEqual(['SP1', 'SP2'])
  })
  it('allDesignators covers connectors, terminals and splices', () => {
    const d = emptyDocument()
    d.connectors = [{ id: 'c', designator: 'X1', cavities: [] }] as never
    d.freeTerminals = [term('a', 'T1')]
    d.splices = [spl('s', 'SP1')]
    expect(allDesignators(d).sort()).toEqual(['SP1', 'T1', 'X1'])
  })
})
