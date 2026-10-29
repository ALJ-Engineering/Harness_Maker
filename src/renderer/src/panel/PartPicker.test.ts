import { describe, it, expect } from 'vitest'
import { firstHighlight } from './PartPicker'

describe('firstHighlight', () => {
  it('highlights nothing on a blank draft, so Enter clears the part', () => {
    expect(firstHighlight('')).toBe(-1)
    expect(firstHighlight('   ')).toBe(-1)
  })
  it('highlights the best match once there is a query', () => {
    expect(firstHighlight('0462')).toBe(0)
  })
})
