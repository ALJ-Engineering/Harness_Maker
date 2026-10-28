import { describe, it, expect } from 'vitest'
import type { Connection, Edge } from '@xyflow/react'
import { reconnectOutcome } from './reconnectGesture'

/** wire-1: X1 pin 1 (end 0) → X2 pin A (end 1), as `documentToFlow` draws it. */
const edge: Edge = {
  id: 'wire-1',
  source: 'conn-x1',
  target: 'conn-x2',
  sourceHandle: 'cav:cav-x1-1',
  targetHandle: 'cav:cav-x2-a'
}
const conn = (source: string, sourceHandle: string, target: string, targetHandle: string): Connection => ({
  source,
  sourceHandle,
  target,
  targetHandle
})

describe('reconnectOutcome', () => {
  it('the target end dropped on another pin moves end 1', () => {
    expect(reconnectOutcome(edge, conn('conn-x1', 'cav:cav-x1-1', 'conn-x2', 'cav:cav-x2-b'))).toEqual({
      end: 1,
      to: { type: 'cavity', cavityId: 'cav-x2-b' }
    })
  })

  it('the source end dropped on a terminal moves end 0', () => {
    expect(reconnectOutcome(edge, conn('ft-1', 'ft:ft-1', 'conn-x2', 'cav:cav-x2-a'))).toEqual({
      end: 0,
      to: { type: 'freeTerminal', terminalId: 'ft-1' }
    })
  })

  it('nothing for a drop back on the same pin, a change at both ends, or a handle that is not a wire end', () => {
    expect(reconnectOutcome(edge, conn('conn-x1', 'cav:cav-x1-1', 'conn-x2', 'cav:cav-x2-a'))).toBeNull()
    expect(reconnectOutcome(edge, conn('sp', 'sp:sp', 'ft', 'ft:ft'))).toBeNull()
    expect(reconnectOutcome(edge, conn('conn-x1', 'cav:cav-x1-1', 'x', 'bogus:1'))).toBeNull()
  })
})
