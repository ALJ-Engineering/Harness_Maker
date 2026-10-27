import { describe, it, expect } from 'vitest'
import { demoDocument, emptyDocument } from '@shared/model/document'
import { computeCutList } from '@shared/export/bom'
import { docStats } from './stats'

describe('docStats', () => {
  it('counts wires and sums known cut lengths', () => {
    const doc = demoDocument()
    const s = docStats(doc)
    expect(s.wires).toBe(doc.wires.length)
    expect(s.totalLengthMm).toBeGreaterThan(0)
  })

  it('adds nothing for a row whose length is unknown', () => {
    const doc = demoDocument()
    doc.wires.forEach((w) => {
      w.specifiedLengthMm = undefined
    })
    const before = docStats(doc).totalLengthMm

    // A cable with no specified length is a cut row with `lengthMm: null`; the
    // demo document otherwise has none, so nothing else here meets one.
    doc.cables.push({ id: 'cab-unknown', name: 'CAN-unknown', coreWireIds: [] })
    const after = docStats(doc).totalLengthMm

    // The VALUE, not just its finiteness: `Number.isFinite` cannot fail through
    // the `?? 0` guard, because JS folds `x + null` to `x` — so the old
    // assertion survived `?? 9999` too. This one catches `?? NaN` and an
    // unknown row being counted as anything at all.
    expect(after).toBe(before)
  })

  it('totals exactly 0 for an unknown-only and for an empty document', () => {
    const doc = emptyDocument()
    doc.cables.push({ id: 'cab-a', name: 'A', coreWireIds: [] })
    doc.cables.push({ id: 'cab-b', name: 'B', coreWireIds: [] })
    expect(computeCutList(doc).every((r) => r.lengthMm === null)).toBe(true)
    // `toBe(0)` distinguishes 0 from null, undefined and NaN — a "no known
    // length ⇒ the total is unknown" rewrite reads `null` on the chip.
    expect(docStats(doc).totalLengthMm).toBe(0)

    // And with NO rows at all, which is the only case a null/undefined reduce
    // seed survives to — every row folds `null + x` back to a number.
    expect(computeCutList(emptyDocument())).toHaveLength(0)
    expect(docStats(emptyDocument()).totalLengthMm).toBe(0)
  })

  it('reports the sheet label', () => {
    const doc = demoDocument()
    const s = docStats(doc)
    expect(s.sheetLabel).toMatch(/A[1-4]/)
  })

  it('labels A0 and a plotter roll with its length', () => {
    const doc = demoDocument()
    doc.drawing.sheet = { paper: 'A0', orientation: 'portrait' }
    expect(docStats(doc).sheetLabel).toBe('A0 P')
    doc.drawing.sheet = { paper: 'Plotter', orientation: 'landscape', lengthMm: 2600 }
    expect(docStats(doc).sheetLabel).toBe('Plotter 914×2600 L')
  })

  /**
   * The chip reads "N wires · X mm", and the two numbers come from different
   * places: `wires` counts `doc.wires`, the length sums `computeCutList`, which
   * EXCLUDES cable cores (you cut the cable, not its cores) and adds a jacket
   * row instead. So on a harness with a cable the chip counts conductors whose
   * length is deliberately not in the total. Pin that down, because it is the
   * pair of numbers a user actually reads.
   */
  it('sums the cut list, so a cable core is counted as a wire but not as length', () => {
    const doc = demoDocument()
    const core = doc.wires.find((w) => w.id === 'wire-1')!
    const coreLength = computeCutList(doc).find((r) => r.sourceId === 'wire-1')!.lengthMm!
    expect(coreLength).toBeGreaterThan(0)
    const loose = docStats(doc).totalLengthMm

    // Make wire-1 a core of a cable with no specified jacket length.
    core.cableId = 'cab-1'
    doc.cables.push({ id: 'cab-1', name: 'CAN-1', coreWireIds: ['wire-1'] })
    const s = docStats(doc)

    // Definitional: the total IS the cut list's known rows, nothing else.
    const rows = computeCutList(doc)
    expect(rows.some((r) => r.sourceId === 'wire-1')).toBe(false) // core dropped
    expect(s.totalLengthMm).toBe(rows.reduce((sum, r) => sum + (r.lengthMm ?? 0), 0))

    // …and the consequence: the core's length left the total. `toBeCloseTo`,
    // not `toBe`: the two sides add the same mm in a different ORDER, which
    // differs in the last float ulp (353.260527090135 vs …13493).
    expect(s.totalLengthMm).toBeCloseTo(loose - coreLength, 9)
    // while the core is still counted as a wire.
    expect(s.wires).toBe(doc.wires.length)
    expect(doc.wires.some((w) => w.id === 'wire-1')).toBe(true)
  })
})
