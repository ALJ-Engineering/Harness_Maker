import type { HarnessDocument } from './schema'
import { SCHEMA_VERSION } from './schema'

/** A valid, empty document — every array present so callers never null-check. */
export function emptyDocument(): HarnessDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    connectors: [],
    freeTerminals: [],
    splices: [],
    wires: [],
    cables: [],
    drawing: {
      units: 'mm',
      printScale: 1,
      sheet: { paper: 'A3', orientation: 'landscape' }
    },
    placements: [],
    branchPoints: [],
    segments: [],
    wireRoutes: [],
    bundles: [],
    sleeving: [],
    twists: [],
    labels: []
  }
}

/**
 * A tiny demo harness so the canvas isn't empty on first launch: two connectors
 * and a ring lug on a battery stud, wired X1.1→X2.A and X1.2→ring lug. Pure
 * electrical truth + placements; no routing graph yet (that's phase 2).
 */
export function demoDocument(): HarnessDocument {
  const doc = emptyDocument()

  doc.connectors = [
    {
      id: 'conn-x1',
      designator: 'X1',
      gender: 'female',
      cavities: [
        { id: 'cav-x1-1', position: '1', status: 'populated' },
        { id: 'cav-x1-2', position: '2', status: 'populated' },
        { id: 'cav-x1-3', position: '3', status: 'empty' }
      ]
    },
    {
      id: 'conn-x2',
      designator: 'X2',
      gender: 'male',
      cavities: [
        { id: 'cav-x2-a', position: 'A', status: 'populated' },
        { id: 'cav-x2-b', position: 'B', status: 'empty' }
      ]
    }
  ]

  doc.freeTerminals = [
    { id: 'ft-bplus', designator: 'T1', kind: 'ring', landsOn: 'B+ stud' }
  ]

  doc.wires = [
    {
      id: 'wire-1',
      ends: [
        { type: 'cavity', cavityId: 'cav-x1-1' },
        { type: 'cavity', cavityId: 'cav-x2-a' }
      ],
      gauge: { value: 0.5, unit: 'mm2' },
      color: { base: 'RD' }
    },
    {
      id: 'wire-2',
      ends: [
        { type: 'cavity', cavityId: 'cav-x1-2' },
        { type: 'freeTerminal', terminalId: 'ft-bplus' }
      ],
      gauge: { value: 2.5, unit: 'mm2' },
      color: { base: 'BK' }
    }
  ]

  // Placement `pos` is the formboard DOT CENTRE (schema 0.4.0) — roughly where
  // the old right-hand pin columns sat, so the demo still reads as a harness.
  doc.placements = [
    { refId: 'conn-x1', pos: { x: 52, y: 60 } },
    { refId: 'conn-x2', pos: { x: 372, y: 60 }, schematicExitSide: 'left' }, // pins face X1
    { refId: 'ft-bplus', pos: { x: 360, y: 233 } }
  ]

  // Limbs run BODY to BODY: the dot every wire on X1 lands on, to X2's dot.
  doc.segments = [
    { id: 'seg-1', from: { type: 'body', refId: 'conn-x1' }, to: { type: 'body', refId: 'conn-x2' } },
    { id: 'seg-2', from: { type: 'body', refId: 'conn-x1' }, to: { type: 'body', refId: 'ft-bplus' } }
  ]
  doc.wireRoutes = [
    { wireId: 'wire-1', path: ['seg-1'] },
    { wireId: 'wire-2', path: ['seg-2'] }
  ]

  return doc
}

/**
 * DRC test fixture — intentionally invalid in specific, documented ways.
 *
 * Built on top of demoDocument() with four deliberate violations injected:
 *   1. A populated cavity with no wire              → unconnected-populated-cavity (error)
 *   2. A splice referenced by exactly one wire      → splice-degree (error)
 *   3. A cable with shield.present but no drain     → shield-without-drain (error)
 *   4. A wire with no route                         → unrouted-wire (error)
 *
 * The document remains structurally valid (all arrays present, ids stable).
 */
export function brokenDemoDocument(): HarnessDocument {
  const doc = demoDocument()

  // 1. Add a connector with a populated cavity that has no wire
  //    cav-broken-1 is wired (via wire-unrouted below); cav-broken-2 is populated but never wired
  doc.connectors.push({
    id: 'conn-broken',
    designator: 'X9',
    cavities: [
      { id: 'cav-broken-1', position: '1', status: 'populated' },
      { id: 'cav-broken-2', position: '2', status: 'populated' }
    ]
  })

  // 2. Add a splice that is only referenced by one wire (degree < 2)
  doc.splices.push({ id: 'splice-broken', designator: 'SP1', kind: 'butt' })
  doc.wires.push({
    id: 'wire-broken-splice',
    ends: [
      { type: 'cavity', cavityId: 'cav-x1-3' },
      { type: 'splice', spliceId: 'splice-broken' }
    ],
    gauge: { value: 0.5, unit: 'mm2' },
    color: { base: 'GN' }
  })
  // Provide a route for this wire so it doesn't also fire unrouted-wire
  doc.segments.push({
    id: 'seg-broken-splice',
    from: { type: 'body', refId: 'conn-x1' },
    to: { type: 'body', refId: 'splice-broken' }
  })
  // Note: splice has no placement, so segmentLengthMm will be null → wireLength 'unknown'
  // That means this wire ALSO fires unrouted-wire. That is acceptable — we only need ≥4 distinct ruleIds.

  // 3. Add a cable with shield.present but no drain wire
  doc.cables.push({
    id: 'cable-broken',
    name: 'CAN-broken',
    coreWireIds: [],
    shield: { present: true }
    // no drainWireId
  })

  // 4. Add a wire with no route (no wireRoute entry)
  doc.wires.push({
    id: 'wire-unrouted',
    ends: [
      { type: 'cavity', cavityId: 'cav-x2-b' },
      { type: 'cavity', cavityId: 'cav-broken-1' }
    ],
    gauge: { value: 1.0, unit: 'mm2' },
    color: { base: 'YE' }
  })
  // Intentionally no wireRoute for 'wire-unrouted'
  // Note: this also means cav-x2-b and cav-broken-1 are now wired,
  // but cav-broken-1 is populated → unconnected-populated-cavity won't fire for it.
  // cav-x2-b is 'empty' and now wired → empty-cavity-wired fires too (bonus).

  return doc
}
