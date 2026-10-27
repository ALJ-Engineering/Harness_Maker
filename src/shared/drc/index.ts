import type { HarnessDocument, Id, PartRef } from '../model/schema'
import type { PartCatalog } from '../parts/catalog'
import { isValidLengthMm, wireLength, segmentLengthBroken, segmentLengthMm } from '../model/geometry'
import { computeNets } from '../model/nets'
import { isSpanContiguous } from '../model/treatments'
import { branchDegree, isSelfLoopSegment, spliceDegree } from '../model/topology'
import { sortedCavities } from '../model/anchors'
import { endpointBodyId } from '../model/endpoints'
import type { EntityRef, Finding } from './types'

export type { Severity, EntityRef, Finding } from './types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collect all cavity ids referenced by any wire endpoint. */
function wiredCavityIds(doc: HarnessDocument): Set<Id> {
  const set = new Set<Id>()
  for (const w of doc.wires) {
    for (const e of w.ends) {
      if (e.type === 'cavity') set.add(e.cavityId)
    }
  }
  return set
}


// ─── Structural rules ─────────────────────────────────────────────────────────

function ruleUnconnectedPopulatedCavity(doc: HarnessDocument): Finding[] {
  const wired = wiredCavityIds(doc)
  const findings: Finding[] = []
  for (const conn of doc.connectors) {
    for (const cav of sortedCavities(conn)) {
      if (cav.status === 'populated' && !wired.has(cav.id)) {
        findings.push({
          ruleId: 'unconnected-populated-cavity',
          severity: 'error',
          message: `Cavity ${conn.designator}.${cav.position} is populated but has no wire`,
          refs: [{ kind: 'cavity', id: cav.id }]
        })
      }
    }
  }
  return findings
}

function rulePopulatedWithoutPin(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  for (const conn of doc.connectors) {
    for (const cav of sortedCavities(conn)) {
      if (cav.status === 'populated' && !cav.pin) {
        findings.push({
          ruleId: 'populated-without-pin',
          severity: 'warning',
          message: `Cavity ${conn.designator}.${cav.position} is populated but has no pin PartRef`,
          refs: [{ kind: 'cavity', id: cav.id }]
        })
      }
    }
  }
  return findings
}

function ruleEmptyCavityWired(doc: HarnessDocument): Finding[] {
  const wired = wiredCavityIds(doc)
  const findings: Finding[] = []
  // Build a map from cavityId → { status, label } for fast lookup
  type CavInfo = { status: string; label: string }
  const cavityInfo = new Map<Id, CavInfo>()
  for (const conn of doc.connectors) {
    for (const cav of sortedCavities(conn)) {
      cavityInfo.set(cav.id, { status: cav.status, label: `${conn.designator}.${cav.position}` })
    }
  }
  for (const cavId of wired) {
    const info = cavityInfo.get(cavId)
    if (info?.status === 'empty') {
      findings.push({
        ruleId: 'empty-cavity-wired',
        severity: 'warning',
        message: `Cavity ${info.label} has status 'empty' but is referenced by a wire`,
        refs: [{ kind: 'cavity', id: cavId }]
      })
    }
  }
  return findings
}

function ruleSpliceDegree(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  for (const splice of doc.splices) {
    // Derived degree, self-loop-safe: a wire looping splice→same splice counts once.
    const count = spliceDegree(doc, splice.id)
    if (count < 2) {
      findings.push({
        ruleId: 'splice-degree',
        severity: 'error',
        message: `Splice ${splice.id} is referenced by ${count} wire(s); must be ≥2`,
        refs: [{ kind: 'splice', id: splice.id }]
      })
    }
  }
  return findings
}

function ruleBranchPointDegree(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  for (const bp of doc.branchPoints) {
    // Derived degree, self-loop-safe (see model/topology.ts).
    const count = branchDegree(doc, bp.id)
    if (count < 2) {
      findings.push({
        ruleId: 'branchpoint-degree',
        severity: 'error',
        message: `BranchPoint ${bp.id} is referenced by ${count} segment(s); must be ≥2`,
        refs: [{ kind: 'branchPoint', id: bp.id }]
      })
    }
  }
  return findings
}

/**
 * A segment whose two ends resolve to the SAME route node — a zero-length loop.
 * The store never creates one (`applyMergeBranchPoints` drops a loop the instant
 * a merge would make one), so this only fires on a hand-authored or externally
 * edited document. It matters because a self-loop contributes nothing to the
 * loom but still occupies a routing slot: it is 0 mm on the cut list and it
 * makes the node it hangs off look busier than it is.
 */
function ruleSelfLoopSegment(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  for (const s of doc.segments) {
    if (!isSelfLoopSegment(s)) continue
    findings.push({
      ruleId: 'self-loop-segment',
      severity: 'error',
      message: `Segment ${s.id} starts and ends at the same node (zero-length self-loop)`,
      refs: [{ kind: 'segment', id: s.id }]
    })
  }
  return findings
}

/**
 * A hand-entered millimetre override that is not a physical length: negative,
 * NaN or non-finite. The store rejects these at the action boundary
 * (`setWireLengthOverride` / `setWireAllowance`), so this rule exists for
 * documents that already contain one — hand-edited JSON, or a file written
 * before the boundary check landed. **Zero is legal** (an explicit zero-length
 * override), so it is not flagged.
 *
 * Covers every mm override in the model: `Wire.specifiedLengthMm`,
 * `Wire.addLengthMm`, `Cable.specifiedLengthMm`.
 */
function ruleInvalidSpecifiedLength(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  const check = (v: number | undefined, what: string, ref: EntityRef): void => {
    if (v === undefined || isValidLengthMm(v)) return
    findings.push({
      ruleId: 'invalid-specified-length',
      severity: 'error',
      message: `${what} is ${v} — must be a finite length ≥ 0 mm (or absent to derive it)`,
      refs: [ref]
    })
  }
  for (const w of doc.wires) {
    check(w.specifiedLengthMm, `Wire ${w.id} length override`, { kind: 'wire', id: w.id })
    check(w.addLengthMm, `Wire ${w.id} allowance`, { kind: 'wire', id: w.id })
  }
  for (const cab of doc.cables) {
    check(cab.specifiedLengthMm, `Cable ${cab.name ?? cab.id} length override`, {
      kind: 'cable',
      id: cab.id
    })
  }
  return findings
}

/**
 * A limb whose typed manufacturing length (`Segment.specifiedLengthMm`) no longer
 * matches its drawn length (`segmentLengthBroken`: ≥ BROKEN_LENGTH_TOL_MM apart).
 * The cut list and PDF already use the typed value, so nothing is wrong
 * electrically — but the 1:1 formboard is not to scale along that limb, and
 * its label prints red. A warning, so an export with a red label shows in the
 * DRC list; the label's rescale arrows clear it.
 */
/** At most one decimal, trailing ".0" dropped — hides float noise (899.9999999999999 → 900). */
function fmtMm(v: number): string {
  return String(Math.round(v * 10) / 10)
}

function ruleSegmentLengthOffScale(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  for (const s of doc.segments) {
    if (!segmentLengthBroken(doc, s.id)) continue
    const typed = s.specifiedLengthMm!
    const drawn = segmentLengthMm(doc, s.id)!
    findings.push({
      ruleId: 'segment-length-off-scale',
      severity: 'warning',
      message: `Limb typed ${fmtMm(typed)} mm but drawn ${Math.round(drawn)} mm — press an arrow on its label to rescale`,
      refs: [{ kind: 'segment', id: s.id }]
    })
  }
  return findings
}

function ruleUnroutedWire(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  for (const w of doc.wires) {
    const len = wireLength(doc, w.id)
    if (len.source !== 'unknown') continue
    // A jumper WITHIN one body (two cavities of the same connector, say) has no
    // limb between its ends — both land on the same dot — so it can never be
    // geometry-derived and the store creates no segment for it. That is a
    // prompt for a specified length, not a broken route: warn, don't error.
    const a = endpointBodyId(doc, w.ends[0])
    const b = endpointBodyId(doc, w.ends[1])
    const jumper = a !== null && a === b
    // A cable's drain (cableId + a shield end on that same cable) takes its
    // length with the cable and has no limb of its own — mirror of the jumper
    // exception above, but not a warning: nothing to specify.
    if (w.cableId != null && w.ends.some((e) => e.type === 'shield' && e.cableId === w.cableId)) continue
    findings.push({
      ruleId: 'unrouted-wire',
      severity: jumper ? 'warning' : 'error',
      message: jumper
        ? `Wire ${w.id} is a jumper within one body — set a specified length (mm)`
        : `Wire ${w.id} has no valid route (length unknown)`,
      refs: [{ kind: 'wire', id: w.id }]
    })
  }
  return findings
}

function ruleShieldWithoutDrain(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  for (const cab of doc.cables) {
    if (!cab.shield?.present) continue
    const drainId = cab.shield.drainWireId
    if (!drainId) {
      findings.push({
        ruleId: 'shield-without-drain',
        severity: 'error',
        message: `Cable ${cab.name} has a shield but no drain wire`,
        refs: [{ kind: 'cable', id: cab.id }]
      })
      continue
    }
    // Verify the drain wire's endpoints include a shield endpoint for this cable
    const drainWire = doc.wires.find((w) => w.id === drainId)
    if (!drainWire) {
      findings.push({
        ruleId: 'shield-without-drain',
        severity: 'error',
        message: `Cable ${cab.name} drain wire id ${drainId} not found`,
        refs: [{ kind: 'cable', id: cab.id }]
      })
      continue
    }
    const hasShieldEndpoint = drainWire.ends.some(
      (e) => e.type === 'shield' && e.cableId === cab.id
    )
    if (!hasShieldEndpoint) {
      findings.push({
        ruleId: 'shield-without-drain',
        severity: 'error',
        message: `Cable ${cab.name} drain wire ${drainId} has no shield endpoint for this cable`,
        refs: [{ kind: 'cable', id: cab.id }, { kind: 'wire', id: drainId }]
      })
    }
  }
  return findings
}

function ruleOrphanedRoute(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  const wireIds = new Set(doc.wires.map((w) => w.id))
  const segmentIds = new Set(doc.segments.map((s) => s.id))
  for (const route of doc.wireRoutes) {
    if (!wireIds.has(route.wireId)) {
      findings.push({
        ruleId: 'orphaned-route',
        severity: 'warning',
        message: `WireRoute references unknown wire ${route.wireId}`,
        refs: []
      })
      continue
    }
    for (const segId of route.path) {
      if (!segmentIds.has(segId)) {
        findings.push({
          ruleId: 'orphaned-route',
          severity: 'warning',
          message: `WireRoute for wire ${route.wireId} references unknown segment ${segId}`,
          refs: [{ kind: 'wire', id: route.wireId }, { kind: 'segment', id: segId }]
        })
      }
    }
  }
  return findings
}

/**
 * Every wire endpoint must reference a live electrical entity. A wire whose end
 * points at a deleted cavity/splice/terminal/cable renders as "cavity ?" on the
 * cut list; with `specifiedLengthMm` set it even shows a concrete length, so the
 * `unrouted-wire` rule never catches it. Flag it structurally instead.
 */
function ruleDanglingEndpoint(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  const cavityIds = new Set<Id>()
  for (const c of doc.connectors) for (const cv of c.cavities) cavityIds.add(cv.id)
  const spliceIds = new Set(doc.splices.map((s) => s.id))
  const terminalIds = new Set(doc.freeTerminals.map((t) => t.id))
  const cableIds = new Set(doc.cables.map((c) => c.id))
  for (const w of doc.wires) {
    for (const e of w.ends) {
      let missing: string | null = null
      if (e.type === 'cavity' && !cavityIds.has(e.cavityId)) missing = `cavity ${e.cavityId}`
      else if (e.type === 'splice' && !spliceIds.has(e.spliceId)) missing = `splice ${e.spliceId}`
      else if (e.type === 'freeTerminal' && !terminalIds.has(e.terminalId))
        missing = `free terminal ${e.terminalId}`
      else if (e.type === 'shield' && !cableIds.has(e.cableId)) missing = `cable ${e.cableId}`
      if (missing) {
        findings.push({
          ruleId: 'dangling-endpoint',
          severity: 'error',
          message: `Wire ${w.id} has an endpoint referencing a non-existent ${missing}`,
          refs: [{ kind: 'wire', id: w.id }]
        })
      }
    }
  }
  return findings
}

/**
 * Member-id references (cable cores + drain, twist members, bundle members, and
 * all span/bundle segment ids) must resolve to live entities. These are silently
 * `.filter(Boolean)`-dropped elsewhere, so a "3-core" cable missing a core, or a
 * treatment over a deleted segment, would otherwise pass DRC clean.
 */
function ruleDanglingMember(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  const wireIds = new Set(doc.wires.map((w) => w.id))
  const segIds = new Set(doc.segments.map((s) => s.id))
  const flagWire = (id: Id, ctx: string): void => {
    if (!wireIds.has(id))
      findings.push({
        ruleId: 'dangling-member',
        severity: 'error',
        message: `${ctx} references a non-existent wire ${id}`,
        refs: []
      })
  }
  const flagSeg = (id: Id, ctx: string): void => {
    if (!segIds.has(id))
      findings.push({
        ruleId: 'dangling-member',
        severity: 'error',
        message: `${ctx} references a non-existent segment ${id}`,
        refs: [{ kind: 'segment', id }]
      })
  }
  const cableIds = new Set(doc.cables.map((c) => c.id))
  for (const cab of doc.cables) {
    for (const id of cab.coreWireIds) flagWire(id, `Cable ${cab.name} core`)
    if (cab.shield?.drainWireId) flagWire(cab.shield.drainWireId, `Cable ${cab.name} drain`)
  }
  // The other direction of the cable↔core link (R1): a legacy/hand-edited file
  // can hold a core wire whose cable was deleted. The BOM skips cores (the cable
  // is the BOM line), so such a wire vanishes from BOTH reports without this.
  for (const w of doc.wires) {
    if (w.cableId != null && !cableIds.has(w.cableId))
      findings.push({
        ruleId: 'dangling-member',
        severity: 'error',
        message: `Wire ${w.id} cableId references a non-existent cable ${w.cableId}`,
        refs: [{ kind: 'wire', id: w.id }]
      })
  }
  for (const tw of doc.twists) {
    for (const id of tw.wireIds) flagWire(id, `Twist ${tw.id} member`)
    for (const id of tw.span.segmentIds) flagSeg(id, `Twist ${tw.id} span`)
  }
  for (const bnd of doc.bundles) {
    for (const id of bnd.memberWireIds) flagWire(id, `Bundle ${bnd.id} member`)
    for (const id of bnd.segmentIds) flagSeg(id, `Bundle ${bnd.id}`)
  }
  for (const sl of doc.sleeving) {
    for (const id of sl.span.segmentIds) flagSeg(id, `Sleeving ${sl.id} span`)
  }
  return findings
}

/**
 * A label's target and (if present) its bead anchor must resolve to a live
 * entity/segment. Hand-edited JSON — or a code path that GCs a segment/branch
 * point without pruning the labels pointing at it — otherwise renders a
 * silently-dropped or dangling label with no other DRC signal.
 */
function ruleDanglingLabelRef(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  const segIds = new Set(doc.segments.map((s) => s.id))
  for (const l of doc.labels) {
    const missing: string[] = []
    const target = l.target
    if (target.type === 'branch' && !segIds.has(target.segmentId)) missing.push(`target segment ${target.segmentId}`)
    if (target.type === 'branchPoint' && !doc.branchPoints.some((b) => b.id === target.branchId)) missing.push(`target branch point ${target.branchId}`)
    if (target.type === 'wire' && !doc.wires.some((w) => w.id === target.wireId)) missing.push(`target wire ${target.wireId}`)
    if (target.type === 'bundle' && !doc.bundles.some((b) => b.id === target.bundleId)) missing.push(`target bundle ${target.bundleId}`)
    if (l.anchor && !segIds.has(l.anchor.segmentId)) missing.push(`anchor segment ${l.anchor.segmentId}`)
    if (missing.length)
      findings.push({
        ruleId: 'dangling-label-ref',
        severity: 'error',
        message: `Label "${l.text}" references missing ${missing.join(', ')}`,
        refs: []
      })
  }
  return findings
}

/**
 * A Span must be ONE contiguous run along the loom (schema.ts) — `spanLengthMm`
 * trims a head and a tail off the FIRST and LAST segment, and
 * `applyInsertBranchPoint` remaps fractions on that basis, so a span made of
 * disconnected pieces silently produces a wrong sleeve/twist length.
 * The store rejects such a span at creation (R2); this catches documents that
 * already contain one. Spans with a MISSING segment are skipped — that is
 * `dangling-member`'s report, and flagging both would double-count one defect.
 */
function ruleNonContiguousSpan(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  const segIds = new Set(doc.segments.map((s) => s.id))
  const check = (id: Id, kind: string, segmentIds: Id[]): void => {
    if (segmentIds.length === 0) return
    if (segmentIds.some((sid) => !segIds.has(sid))) return // dangling-member owns it
    if (isSpanContiguous(doc, segmentIds)) return
    findings.push({
      ruleId: 'non-contiguous-span',
      severity: 'error',
      message: `${kind} ${id} span is not one contiguous run (${segmentIds.length} segments); its length is not meaningful`,
      refs: segmentIds.map((sid) => ({ kind: 'segment' as const, id: sid }))
    })
  }
  for (const sl of doc.sleeving) check(sl.id, 'Sleeving', sl.span.segmentIds)
  for (const tw of doc.twists) check(tw.id, 'Twist', tw.span.segmentIds)
  return findings
}

/**
 * A treatment whose span covers no segments contributes a 0 mm line to the BOM
 * and draws nothing. It is a legal AUTHORING intermediate — the twist UI creates
 * a twist before its wires are co-routed — so this is `info`, not a defect; the
 * topology ops remove a span they themselves emptied (R3).
 */
function ruleEmptySpan(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  const flag = (id: Id, kind: string): void => {
    findings.push({
      ruleId: 'empty-span',
      severity: 'info',
      message: `${kind} ${id} covers no segments (0 mm)`,
      refs: []
    })
  }
  for (const sl of doc.sleeving) if (sl.span.segmentIds.length === 0) flag(sl.id, 'Sleeving')
  for (const tw of doc.twists) if (tw.span.segmentIds.length === 0) flag(tw.id, 'Twist')
  return findings
}

// ─── Net / group / PartRef rules ─────────────────────────────────────────────

type Net = ReturnType<typeof computeNets>[number]

function ruleGaugeMismatchInNet(doc: HarnessDocument, nets: Net[]): Finding[] {
  const findings: Finding[] = []
  const wireById = new Map(doc.wires.map((w) => [w.id, w]))
  for (const net of nets) {
    if (net.wireIds.length < 2) continue
    const wires = net.wireIds.map((id) => wireById.get(id)).filter(Boolean) as typeof doc.wires
    const gauges = wires.map((w) => `${w.gauge.value}:${w.gauge.unit}`)
    const unique = new Set(gauges)
    if (unique.size > 1) {
      findings.push({
        ruleId: 'gauge-mismatch-in-net',
        severity: 'warning',
        message: `Net contains wires with mixed gauges: ${[...unique].join(', ')}`,
        refs: net.wireIds.map((id) => ({ kind: 'wire' as const, id }))
      })
    }
  }
  return findings
}

function ruleColourMismatchInNet(doc: HarnessDocument, nets: Net[]): Finding[] {
  const findings: Finding[] = []
  const wireById = new Map(doc.wires.map((w) => [w.id, w]))
  for (const net of nets) {
    if (net.wireIds.length < 2) continue
    const wires = net.wireIds.map((id) => wireById.get(id)).filter(Boolean) as typeof doc.wires
    const colours = wires.map((w) => w.color.base)
    const unique = new Set(colours)
    if (unique.size > 1) {
      findings.push({
        ruleId: 'colour-mismatch-in-net',
        severity: 'info',
        message: `Net contains wires with mixed colours: ${[...unique].join(', ')}`,
        refs: net.wireIds.map((id) => ({ kind: 'wire' as const, id }))
      })
    }
  }
  return findings
}

function ruleGaugeMismatchInGroup(doc: HarnessDocument): Finding[] {
  const findings: Finding[] = []
  const wireById = new Map(doc.wires.map((w) => [w.id, w]))

  // Check cable cores
  for (const cable of doc.cables) {
    if (cable.coreWireIds.length < 2) continue
    const wires = cable.coreWireIds.map((id) => wireById.get(id)).filter(Boolean) as typeof doc.wires
    const gauges = wires.map((w) => `${w.gauge.value}:${w.gauge.unit}`)
    const unique = new Set(gauges)
    if (unique.size > 1) {
      findings.push({
        ruleId: 'gauge-mismatch-in-group',
        severity: 'warning',
        message: `Cable ${cable.name} cores have mixed gauges: ${[...unique].join(', ')}`,
        refs: cable.coreWireIds.map((id) => ({ kind: 'wire' as const, id }))
      })
    }
  }

  // Check twist members
  for (const twist of doc.twists) {
    if (twist.wireIds.length < 2) continue
    const wires = twist.wireIds.map((id) => wireById.get(id)).filter(Boolean) as typeof doc.wires
    const gauges = wires.map((w) => `${w.gauge.value}:${w.gauge.unit}`)
    const unique = new Set(gauges)
    if (unique.size > 1) {
      findings.push({
        ruleId: 'gauge-mismatch-in-group',
        severity: 'warning',
        message: `Twist contains wires with mixed gauges: ${[...unique].join(', ')}`,
        refs: twist.wireIds.map((id) => ({ kind: 'wire' as const, id }))
      })
    }
  }

  return findings
}

function ruleStaleOrUnresolvedPartRef(doc: HarnessDocument, catalog: PartCatalog): Finding[] {
  const findings: Finding[] = []

  /** Check a single PartRef and emit a finding if it is unresolved or stale. */
  function checkRef(ref: PartRef | undefined, contextMsg: string): void {
    if (!ref) return
    const entry = catalog.resolve(ref.partNumber)
    if (!entry) {
      findings.push({
        ruleId: 'stale-or-unresolved-partref',
        severity: 'warning',
        message: `Unresolved part ${ref.partNumber} (${contextMsg})`,
        refs: []
      })
    } else if (ref.description && ref.description !== entry.description) {
      findings.push({
        ruleId: 'stale-or-unresolved-partref',
        severity: 'warning',
        message: `Stale description for ${ref.partNumber}: cached "${ref.description}" vs catalog "${entry.description}" (${contextMsg})`,
        refs: []
      })
    }
  }

  for (const conn of doc.connectors) {
    checkRef(conn.housing, `connector ${conn.designator} housing`)
    for (const cav of sortedCavities(conn)) {
      checkRef(cav.pin, `${conn.designator}.${cav.position} pin`)
      checkRef(cav.seal, `${conn.designator}.${cav.position} seal`)
      checkRef(cav.plug, `${conn.designator}.${cav.position} plug`)
    }
  }

  for (const ft of doc.freeTerminals) {
    checkRef(ft.part, `freeTerminal ${ft.id} part`)
    checkRef(ft.seal, `freeTerminal ${ft.id} seal`)
  }

  for (const splice of doc.splices) {
    checkRef(splice.part, `splice ${splice.id} part`)
  }

  for (const wire of doc.wires) {
    checkRef(wire.spec, `wire ${wire.id} spec`)
  }

  for (const cable of doc.cables) {
    checkRef(cable.part, `cable ${cable.name} part`)
  }

  for (const sleeving of doc.sleeving) {
    checkRef(sleeving.part, `sleeving ${sleeving.id} part`)
  }

  for (const bundle of doc.bundles) {
    checkRef(bundle.part, `bundle ${bundle.name ?? bundle.id} loom tape`)
  }

  for (const bp of doc.branchPoints) {
    checkRef(bp.tie, `branchPoint ${bp.id} tie`)
  }

  return findings
}

/**
 * A segment end that resolves to nothing. Route nodes are body-keyed (0.4.0),
 * so a `body` end must name a placed-entity id (connector, free terminal,
 * splice or cable) and a `branch` end must name a branch point.
 *
 * The load migration DELIBERATELY leaves a sentinel `missing:<json>` refId when
 * a pre-0.4 endpoint node had no owning body — "DRC reports it, we do not
 * invent one". Nothing reported it: `resolveNodePos` returns null, so the limb
 * silently has no length, prints nowhere, and drops out of the cut list. This
 * is that rule.
 */
function ruleUnresolvedRouteNode(doc: HarnessDocument): Finding[] {
  const bodies = new Set<Id>([
    ...doc.connectors.map((c) => c.id),
    ...doc.freeTerminals.map((f) => f.id),
    ...doc.splices.map((s) => s.id),
    ...doc.cables.map((c) => c.id)
  ])
  const branches = new Set<Id>(doc.branchPoints.map((b) => b.id))
  const findings: Finding[] = []
  for (const seg of doc.segments) {
    for (const node of [seg.from, seg.to]) {
      const [what, refId] =
        node.type === 'body'
          ? (['body', node.refId] as const)
          : (['branch point', node.branchId] as const)
      const known = node.type === 'body' ? bodies : branches
      if (known.has(refId)) continue
      findings.push({
        ruleId: 'unresolved-route-node',
        severity: 'error',
        message: `Segment ${seg.id} references a missing ${what} ${refId}`,
        refs: [{ kind: 'segment', id: seg.id }]
      })
    }
  }
  return findings
}

/** One error per designator carried by two or more bodies (connector / terminal / splice). */
function ruleDuplicateDesignator(doc: HarnessDocument): Finding[] {
  const byDesignator = new Map<string, EntityRef[]>()
  const add = (d: string | undefined, ref: EntityRef): void => {
    if (typeof d !== 'string' || d.trim() === '') return
    const refs = byDesignator.get(d) ?? []
    refs.push(ref)
    byDesignator.set(d, refs)
  }
  for (const c of doc.connectors) add(c.designator, { kind: 'connector', id: c.id })
  for (const f of doc.freeTerminals) add(f.designator, { kind: 'freeTerminal', id: f.id })
  for (const s of doc.splices) add(s.designator, { kind: 'splice', id: s.id })
  const findings: Finding[] = []
  for (const [d, refs] of byDesignator) {
    if (refs.length < 2) continue
    findings.push({
      ruleId: 'duplicate-designator',
      severity: 'error',
      message: `Designator ${d} is used by ${refs.length} bodies`,
      refs
    })
  }
  return findings
}

// ─── Runner ───────────────────────────────────────────────────────────────────

type RuleFn = (doc: HarnessDocument) => Finding[]

const STRUCTURAL_RULES: RuleFn[] = [
  ruleUnconnectedPopulatedCavity,
  rulePopulatedWithoutPin,
  ruleEmptyCavityWired,
  ruleSpliceDegree,
  ruleBranchPointDegree,
  ruleSelfLoopSegment,
  ruleUnresolvedRouteNode,
  ruleInvalidSpecifiedLength,
  ruleSegmentLengthOffScale,
  ruleUnroutedWire,
  ruleShieldWithoutDrain,
  ruleOrphanedRoute,
  ruleDanglingEndpoint,
  ruleDanglingMember,
  ruleDanglingLabelRef,
  ruleNonContiguousSpan,
  ruleEmptySpan,
  ruleDuplicateDesignator
]

/**
 * Run all DRC rules against the document. Pass an optional catalog to enable
 * catalog-dependent rules (stale-or-unresolved-partref).
 */
export function runDrc(doc: HarnessDocument, catalog?: PartCatalog): Finding[] {
  const findings: Finding[] = STRUCTURAL_RULES.flatMap((rule) => rule(doc))
  const nets = computeNets(doc)
  findings.push(...ruleGaugeMismatchInNet(doc, nets))
  findings.push(...ruleColourMismatchInNet(doc, nets))
  findings.push(...ruleGaugeMismatchInGroup(doc))
  if (catalog) {
    findings.push(...ruleStaleOrUnresolvedPartRef(doc, catalog))
  }
  return findings
}
