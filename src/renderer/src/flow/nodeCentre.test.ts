import { describe, it, expect } from 'vitest'
import type { Node } from '@xyflow/react'
import { nodeCentre } from './nodeCentre'

describe('nodeCentre', () => {
  it('a centre-origin node (a formboard dot) is centred on its position', () => {
    const dot: Node = { id: 'c1', position: { x: 40, y: 70 }, origin: [0.5, 0.5], data: {}, measured: { width: 6, height: 6 } }
    expect(nodeCentre(dot)).toEqual({ x: 40, y: 70 })
  })

  it('a top-left-origin block is centred by half its data size', () => {
    const table: Node = { id: 'tbl:X1', position: { x: 10, y: 20 }, data: { w: 60, h: 30 } }
    expect(nodeCentre(table)).toEqual({ x: 40, y: 35 })
  })

  it('falls back to the measured size', () => {
    const n: Node = { id: 'n', position: { x: 0, y: 0 }, data: {}, measured: { width: 8, height: 4 } }
    expect(nodeCentre(n)).toEqual({ x: 4, y: 2 })
  })
})
