import { describe, it, expect } from 'vitest'
import { demoDocument } from '@shared/model/document'
import type { EntityRef } from '@shared/drc'
import { refFlowTarget, resolveJumpTarget } from './drcJump'

const doc = demoDocument()

/** The two views, named so the expectations below read as prose. */
const SCHEMATIC = 'schematic' as const
const FORMBOARD = 'formboard' as const

describe('refFlowTarget — which element stands for a DRC ref in one view', () => {
  it('a body is the same node in both views', () => {
    for (const kind of ['connector', 'splice', 'freeTerminal'] as const) {
      const ref: EntityRef = { kind, id: 'body-1' }
      expect(refFlowTarget(doc, ref, SCHEMATIC)).toEqual({ kind: 'node', id: 'body-1' })
      expect(refFlowTarget(doc, ref, FORMBOARD)).toEqual({ kind: 'node', id: 'body-1' })
    }
  })

  // The branch that changed in Task 7: the schematic projection has no branch
  // points at all, so claiming one would send a jump to a pane that cannot show
  // it — and, single-pane, render the finding as clickable-but-dead.
  it('a branch point is a formboard node and nothing in the schematic', () => {
    const ref: EntityRef = { kind: 'branchPoint', id: 'bp-1' }
    expect(refFlowTarget(doc, ref, FORMBOARD)).toEqual({ kind: 'node', id: 'bp-1' })
    expect(refFlowTarget(doc, ref, SCHEMATIC)).toBeNull()
  })

  it('a cavity resolves to its OWNING connector node, in both views', () => {
    const ref: EntityRef = { kind: 'cavity', id: 'cav-x1-2' }
    expect(refFlowTarget(doc, ref, SCHEMATIC)).toEqual({ kind: 'node', id: 'conn-x1' })
    expect(refFlowTarget(doc, ref, FORMBOARD)).toEqual({ kind: 'node', id: 'conn-x1' })
  })

  it('a cavity nothing owns resolves to nothing', () => {
    const ref: EntityRef = { kind: 'cavity', id: 'cav-nope' }
    expect(refFlowTarget(doc, ref, SCHEMATIC)).toBeNull()
    expect(refFlowTarget(doc, ref, FORMBOARD)).toBeNull()
  })

  it('a wire is a schematic edge and nothing on the formboard', () => {
    const ref: EntityRef = { kind: 'wire', id: 'wire-1' }
    expect(refFlowTarget(doc, ref, SCHEMATIC)).toEqual({ kind: 'edge', id: 'wire-1' })
    expect(refFlowTarget(doc, ref, FORMBOARD)).toBeNull()
  })

  it('a segment is a formboard edge and nothing in the schematic', () => {
    const ref: EntityRef = { kind: 'segment', id: 'seg-1' }
    expect(refFlowTarget(doc, ref, FORMBOARD)).toEqual({ kind: 'edge', id: 'seg-1' })
    expect(refFlowTarget(doc, ref, SCHEMATIC)).toBeNull()
  })

  it('things that are neither node nor edge resolve to nothing in either view', () => {
    for (const kind of ['cable', 'sleeving', 'twist'] as const) {
      const ref: EntityRef = { kind, id: 'x' }
      expect(refFlowTarget(doc, ref, SCHEMATIC)).toBeNull()
      expect(refFlowTarget(doc, ref, FORMBOARD)).toBeNull()
    }
  })
})

describe('resolveJumpTarget — the focused pane first, then the other visible one', () => {
  it('takes the FIRST view that resolves, so a tie goes to the focused pane', () => {
    const ref: EntityRef = { kind: 'cavity', id: 'cav-x2-a' }
    expect(resolveJumpTarget(doc, ref, [SCHEMATIC, FORMBOARD])).toEqual({
      kind: 'node',
      id: 'conn-x2'
    })
    expect(resolveJumpTarget(doc, ref, [FORMBOARD, SCHEMATIC])).toEqual({
      kind: 'node',
      id: 'conn-x2'
    })
  })

  it('falls through to the other visible pane when the focused one cannot show it', () => {
    // Focused pane is the schematic; only the formboard draws branch points.
    expect(resolveJumpTarget(doc, { kind: 'branchPoint', id: 'bp-1' }, [SCHEMATIC, FORMBOARD])).toEqual(
      { kind: 'node', id: 'bp-1' }
    )
    // …and the mirror case: focused formboard, wire only in the schematic.
    expect(resolveJumpTarget(doc, { kind: 'wire', id: 'wire-1' }, [FORMBOARD, SCHEMATIC])).toEqual({
      kind: 'edge',
      id: 'wire-1'
    })
  })

  it('no-ops when the one visible view cannot show it (the single-pane case)', () => {
    expect(resolveJumpTarget(doc, { kind: 'branchPoint', id: 'bp-1' }, [SCHEMATIC])).toBeNull()
    expect(resolveJumpTarget(doc, { kind: 'segment', id: 'seg-1' }, [SCHEMATIC])).toBeNull()
    expect(resolveJumpTarget(doc, { kind: 'wire', id: 'wire-1' }, [FORMBOARD])).toBeNull()
  })

  it('no-ops on an empty view list rather than throwing', () => {
    expect(resolveJumpTarget(doc, { kind: 'wire', id: 'wire-1' }, [])).toBeNull()
  })
})
