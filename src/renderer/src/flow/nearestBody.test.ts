import { describe, it, expect } from 'vitest'
import { nearestBody } from './nearestBody'
import type { FbBody } from '@shared/model/formboard'

const body = (id: string, x: number, y: number): FbBody => ({
  id,
  kind: 'connector',
  pos: { x, y },
  label: id,
  labelPos: { x, y }
})

describe('nearestBody — the image drop target', () => {
  it('picks the closest body inside the radius', () => {
    const bodies = [body('a', 0, 0), body('b', 10, 0), body('c', 100, 100)]
    expect(nearestBody(bodies, { x: 7, y: 0 }, 8)?.id).toBe('b')
    expect(nearestBody(bodies, { x: 3, y: 0 }, 8)?.id).toBe('a')
  })

  it('returns null when the nearest body is further than maxMm', () => {
    expect(nearestBody([body('a', 0, 0)], { x: 8.1, y: 0 }, 8)).toBeNull()
  })

  it('the radius is inclusive, and an empty board has no target', () => {
    expect(nearestBody([body('a', 0, 0)], { x: 8, y: 0 }, 8)?.id).toBe('a')
    expect(nearestBody([], { x: 0, y: 0 }, 8)).toBeNull()
  })
})
