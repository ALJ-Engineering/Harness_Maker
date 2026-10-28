import type { Endpoint, Gauge, HarnessDocument, Id, Vec2, WireColor } from '@shared/model/schema'
import { allDesignators } from '@shared/model/designators'
import { natCompare } from '@shared/model/anchors'
import { sameEndpoint } from '@shared/model/endpoints'
import { leadAt, sameGauge, type LeadAt } from '@shared/model/leads'
import { refOf, type LibraryPart, type PartKind } from '@shared/parts/librarySchema'
import { leadFromLibrary } from '@shared/parts/instantiate'
import { useHarnessStore } from '../renderer/src/store'
import type { LibraryContext } from './libraryContext'
import { incompleteReasons } from './rails'
import { endpointOf, parseEndRef, resolveEndRef } from './refs'
import { arrangeSchematic } from './arrange'
import type { Op } from './ops'

/**
 * Run an ops batch through the store singleton on whatever document it holds,
 * in order, stopping at the first refusal (errors prefixed `op #N (name): `).
 * Bodies the batch placed get first schematic positions (`arrangeSchematic`).
 *
 * Fs-free on purpose: the CLI (`applyOps`) and the app's MCP tools both run it.
 * It does NOT undo a refused batch — the store is left half-applied and the
 * caller restores it (the CLI resets to an empty document, the app restores
 * its snapshot through `batchEdit`).
 *
 * Rails (spec "Guard rails"): every part number an op names must be a complete
 * library record of the expected kind; every end reference must resolve to an
 * existing endpoint BEFORE the store is called; an existing connector an op
 * wires to or edits must carry a complete housing record whose cavity
 * positions equal the connector's (as sets); a wire part fixes the gauge.
 */
export function runOps(
  ops: Op[],
  lib: LibraryContext,
  opts: { placeAt?: Vec2 } = {}
): { ok: true; summary: string[]; placed: Id[] } | { ok: false; errors: string[] } {
  const run = new Batch(lib, opts.placeAt ?? { x: 0, y: 0 })
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    let errors: string[]
    try {
      errors = run.apply(op)
    } catch (e) {
      errors = [`internal error: ${(e as Error).message}`]
    }
    if (errors.length) return { ok: false, errors: errors.map((e) => `op #${i + 1} (${op.op}): ${e}`) }
  }
  const moves = arrangeSchematic(S().doc, run.placed)
  if (moves.length) S().commitNodePositions(moves, 'schematic')
  return { ok: true, summary: run.summary, placed: run.placed }
}

const S = () => useHarnessStore.getState()

const PLACE_KIND: Record<Extract<Op, { op: 'place' }>['kind'], PartKind> = {
  connector: 'connector',
  terminal: 'terminal',
  splice: 'splice'
}

const fmtGauge = (g: Gauge): string => `${g.value} ${g.unit}`

/** `"GN"` or `"GN/YE"` (base + stripes). A token is a colour code or a hex value. */
export function parseColor(s: string): WireColor | { error: string } {
  const toks = s.split('/')
  if (toks.some((t) => !/^#?[A-Za-z0-9]+$/.test(t))) return { error: `colour '${s}' is not BASE or BASE/STRIPE (e.g. GN, GN/YE)` }
  const [base, ...stripes] = toks
  return stripes.length ? { base, stripes } : { base }
}

type Resolved<T> = { ok: T } | { errors: string[] }

const fmtColor = (c: WireColor): string => [c.base, ...(c.stripes ?? [])].join('/')
const sameCode = (a: string, b: string): boolean => a.toUpperCase() === b.toUpperCase()

/**
 * Rail: a colour-specific wire record (`wire.color` set — its part number names one colour) fixes the
 * colour. A record colour without stripes fixes the base; one with stripes must match exactly. A
 * record without `wire.color` is a TYPE record and the colour stays free (spec decision 9).
 */
export function colorRail(part: LibraryPart, color: WireColor): string | null {
  const recText = part.wire?.color
  if (!recText) return null
  const rec = parseColor(recText)
  const recC: WireColor = 'error' in rec ? { base: recText } : rec
  const recStripes = recC.stripes ?? []
  const ok = recStripes.length
    ? sameCode(recC.base, color.base) &&
      recStripes.length === (color.stripes ?? []).length &&
      recStripes.every((s, i) => sameCode(s, color.stripes![i]))
    : sameCode(recC.base, color.base)
  return ok ? null : `${part.partNumber} is the ${recText} wire; colour ${fmtColor(color)} was asked for`
}

class Batch {
  readonly placed: Id[] = []
  readonly summary: string[] = []
  /** `placeAt`: where new bodies land on the formboard (the store cascades repeats). */
  constructor(
    private lib: LibraryContext,
    private placeAt: Vec2
  ) {}

  apply(op: Op): string[] {
    switch (op.op) {
      case 'place':
        return this.place(op)
      case 'wire':
        return this.wire(op)
      case 'cable':
        return this.cable(op)
      case 'cavity':
        return this.cavity(op)
      case 'set-wire':
        return this.setWire(op)
      case 'unwire':
        return this.unwire(op)
      case 'remove':
        return this.remove(op)
      default:
        return [`unknown op '${(op as { op: string }).op}'`]
    }
  }

  // ── rails ──────────────────────────────────────────────────────────────

  /** A complete library record of `kind`, or the reasons it isn't. */
  private part(pn: string, kind: PartKind): Resolved<LibraryPart> {
    const why = incompleteReasons(pn, this.lib, kind)
    if (why.length) return { errors: why }
    return { ok: this.lib.catalog.part(pn)! }
  }

  /**
   * Rail 2 for an EXISTING connector an op touches (decision 12): its housing
   * record must be complete and its cavity positions must equal the record's.
   * Bodies placed by this batch pass trivially — they were instantiated from
   * that very record.
   */
  private connectorRail(doc: HarnessDocument, connectorId: Id): string[] {
    const c = doc.connectors.find((x) => x.id === connectorId)!
    const pn = c.housing?.partNumber
    if (!pn) return [`${c.designator}: connector has no housing part number`]
    const why = incompleteReasons(pn, this.lib, 'connector')
    if (why.length) return why.map((w) => `${c.designator}: housing ${w}`)
    const rec = (this.lib.catalog.part(pn)!.connector?.cavities ?? []).map((x) => x.position)
    const have = c.cavities.map((x) => x.position)
    // Sorted lists, not sets: a hand-built duplicate position ("1, 1, 2") is a mismatch too.
    const a = [...have].sort(natCompare)
    const b = [...rec].sort(natCompare)
    if (a.length === b.length && a.every((p, i) => p === b[i])) return []
    const show = (xs: string[]) => `[${xs.join(', ')}]`
    return [`${c.designator}: cavities ${show(a)} do not match library record ${pn} ${show(b)}`]
  }

  /** Resolve end references, then rail-check every existing connector they land on. */
  private ends(refs: string[], checkConnectors = true): Resolved<Endpoint[]> {
    const doc = S().doc
    const errors: string[] = []
    const eps: Endpoint[] = []
    for (const r of refs) {
      const ep = endpointOf(doc, r)
      if ('error' in ep) errors.push(ep.error)
      else eps.push(ep)
    }
    if (errors.length) return { errors }
    if (checkConnectors) {
      const touched = new Set<Id>()
      for (const [i, ep] of eps.entries()) errors.push(...this.endRail(doc, ep, refs[i], touched))
      for (const id of touched) errors.push(...this.connectorRail(doc, id))
      if (errors.length) return { errors: [...new Set(errors)] }
    }
    return { ok: eps }
  }

  /**
   * Rails on one end an op wires to (decision 12: what the op touches): a cavity
   * must be `populated` and any pin/seal it carries must be a complete record (a
   * populated cavity with no pin is left to DRC — records may omit default
   * pins); a splice / free terminal must carry a complete part. Collects the
   * cavity's connector into `touched` for `connectorRail`.
   */
  private endRail(doc: HarnessDocument, ep: Endpoint, ref: string, touched: Set<Id>): string[] {
    const out: string[] = []
    const need = (pn: string, kind: PartKind, what: string) => {
      for (const w of incompleteReasons(pn, this.lib, kind)) out.push(`${what} ${w}`)
    }
    if (ep.type === 'cavity') {
      const c = doc.connectors.find((x) => x.cavities.some((cv) => cv.id === ep.cavityId))!
      const cv = c.cavities.find((x) => x.id === ep.cavityId)!
      touched.add(c.id)
      const at = `${c.designator}:${cv.position}`
      if (cv.status !== 'populated') out.push(`${at} is ${cv.status}; a wire cannot land in it`)
      if (cv.pin?.partNumber) need(cv.pin.partNumber, 'pin', `${at}: pin`)
      if (cv.seal?.partNumber) need(cv.seal.partNumber, 'seal', `${at}: seal`)
    } else if (ep.type === 'shield') {
      // The cable this wire lands on is touched too: its record must be complete (decision 12).
      const cab = doc.cables.find((x) => x.id === ep.cableId)!
      const pn = cab.part?.partNumber
      if (!pn) out.push(`${ref}: cable ${cab.name} has no part — complete it with a library cable record before wiring to its shield`)
      else need(pn, 'cable', `${ref}: cable`)
    } else if (ep.type === 'splice' || ep.type === 'freeTerminal') {
      const body =
        ep.type === 'splice'
          ? doc.splices.find((x) => x.id === ep.spliceId)!
          : doc.freeTerminals.find((x) => x.id === ep.terminalId)!
      const kind: PartKind = ep.type === 'splice' ? 'splice' : 'terminal'
      const pn = body.part?.partNumber
      if (!pn) out.push(`${ref} has no part — complete it with a library ${kind} record before wiring to it`)
      else need(pn, kind, `${ref}: part`)
    }
    return out
  }

  /** The one wire between two ends (either direction); zero or several is refused. */
  private oneWire(from: string, to: string, checkConnectors: boolean): Resolved<Id> {
    const r = this.ends([from, to], checkConnectors)
    if ('errors' in r) return r
    const [a, b] = r.ok
    const hits = S().doc.wires.filter(
      (w) =>
        (sameEndpoint(w.ends[0], a) && sameEndpoint(w.ends[1], b)) ||
        (sameEndpoint(w.ends[0], b) && sameEndpoint(w.ends[1], a))
    )
    if (hits.length === 0) return { errors: [`no wire between ${from} and ${to}`] }
    if (hits.length > 1) return { errors: [`${hits.length} wires between ${from} and ${to}; cannot tell which one is meant`] }
    const w = hits[0]
    const cable = S().doc.cables.find((c) => c.id === w.cableId || c.shield?.drainWireId === w.id)
    if (cable) {
      const what = cable.shield?.drainWireId === w.id ? 'the drain' : `core ${w.coreName ?? '?'}`
      // A core's colour/gauge/part come from the cable record; editing one wire would contradict it.
      return { errors: [`the wire ${from} → ${to} is ${what} of cable ${cable.name}; edit the cable (remove ${cable.name} and add it again)`] }
    }
    return { ok: w.id }
  }

  // ── ops ────────────────────────────────────────────────────────────────

  private place(op: Extract<Op, { op: 'place' }>): string[] {
    const p = this.part(op.partNumber, PLACE_KIND[op.kind])
    if ('errors' in p) return p.errors
    const doc = S().doc
    let designator: string | undefined
    if (op.designator !== undefined) {
      designator = op.designator.trim()
      if (designator.includes(':')) return [`designator '${designator}' may not contain ':'`]
      if (allDesignators(doc).includes(designator)) return [`designator '${designator}' is already taken`]
    }
    if (op.landsOn !== undefined && op.kind !== 'terminal') return [`landsOn is only for a terminal`]
    const origin = this.placeAt
    const id =
      op.kind === 'connector'
        ? S().addConnectorFromPart(origin, p.ok, (pn) => this.lib.catalog.part(pn))
        : op.kind === 'terminal'
          ? S().addFreeTerminalFromPart(origin, p.ok)
          : S().addSpliceFromPart(origin, p.ok)
    if (designator !== undefined || op.landsOn !== undefined) {
      const landsOn = op.landsOn?.trim()
      S().applyEdit((d) => {
        const body = [...d.connectors, ...d.freeTerminals, ...d.splices].find((b) => b.id === id)!
        if (designator !== undefined) body.designator = designator
        if (landsOn) {
          const ft = d.freeTerminals.find((t) => t.id === id)
          if (ft) ft.landsOn = landsOn
        }
      })
    }
    this.placed.push(id)
    const body = [...S().doc.connectors, ...S().doc.freeTerminals, ...S().doc.splices].find((b) => b.id === id)!
    this.summary.push(`placed ${op.kind} ${body.designator} (${op.partNumber})`)
    return []
  }

  private wire(op: Extract<Op, { op: 'wire' }>): string[] {
    const r = this.ends([op.from, op.to])
    if ('errors' in r) return r.errors
    const [a, b] = r.ok
    if (sameEndpoint(a, b)) return [`from and to are the same end (${op.from})`]
    const lead = leadAt(S().doc, a) ?? leadAt(S().doc, b)
    if (lead) return this.leadWire(op, a, b, lead)
    // Required unless an end is a factory lead, so the grammar leaves them optional.
    if (op.partNumber === undefined) return [`missing 'partNumber'`]
    if (op.color === undefined) return [`missing 'color'`]
    const p = this.part(op.partNumber, 'wire')
    if ('errors' in p) return p.errors
    const gauge = p.ok.wire!.gauge
    if (op.gauge && (op.gauge.value !== gauge.value || op.gauge.unit !== gauge.unit))
      return [`${op.partNumber} fixes the gauge at ${fmtGauge(gauge)}; ${fmtGauge(op.gauge)} was asked for`]
    const color = parseColor(op.color)
    if ('error' in color) return [color.error]
    const clash = colorRail(p.ok, color)
    if (clash) return [clash]
    const id = S().addWire(a, b)
    const spec = refOf(p.ok)
    S().applyEdit((d) => {
      const w = d.wires.find((x) => x.id === id)!
      w.gauge = { ...gauge }
      w.color = color
      w.spec = spec
    })
    this.summary.push(`wired ${op.from} → ${op.to} ${op.color} ${fmtGauge(gauge)} (${op.partNumber})`)
    return []
  }

  /**
   * `wire` from a cavity with a factory lead: the wire IS the lead, cut to
   * length, so it takes no wire part, and its size and colour are the lead's.
   * A `color` or `gauge` given must agree with the lead; one the lead's record
   * does not state must be given.
   */
  private leadWire(op: Extract<Op, { op: 'wire' }>, a: Endpoint, b: Endpoint, { lead, label }: LeadAt): string[] {
    if (op.partNumber !== undefined)
      return [`${label} is a factory lead: the wire is the lead itself, so leave out partNumber`]
    let color = lead.color
    if (op.color !== undefined) {
      const c = parseColor(op.color)
      if ('error' in c) return [c.error]
      if (color && fmtColor(color) !== fmtColor(c)) return [`${label}'s factory lead is ${fmtColor(color)}, not ${op.color}`]
      color = c
    }
    if (!color) return [`${label}'s factory lead has no colour on record: give color`]
    if (op.gauge && lead.gauge && !sameGauge(op.gauge, lead.gauge))
      return [`${label}'s factory lead is ${fmtGauge(lead.gauge)}; ${fmtGauge(op.gauge)} was asked for`]
    const gauge = lead.gauge ?? op.gauge
    if (!gauge) return [`${label}'s factory lead has no size on record: give gauge`]
    const id = S().addWire(a, b)
    S().applyEdit((d) => {
      const w = d.wires.find((x) => x.id === id)!
      w.gauge = { value: gauge.value, unit: gauge.unit }
      w.color = { base: color.base, ...(color.stripes ? { stripes: [...color.stripes] } : {}) }
    })
    this.summary.push(`wired ${op.from} → ${op.to} ${fmtColor(color)} ${fmtGauge(gauge)} (factory lead of ${label})`)
    return []
  }

  private cable(op: Extract<Op, { op: 'cable' }>): string[] {
    const p = this.part(op.partNumber, 'cable')
    if ('errors' in p) return p.errors
    const spec = p.ok.cable!
    const name = op.name.trim()
    if (name.includes(':')) return [`cable name '${name}' may not contain ':'`]
    if (S().doc.cables.some((c) => c.name === name)) return [`cable name '${name}' is already taken`]
    const known = spec.cores.map((c) => c.name)
    const errors: string[] = []
    const used = new Set<string>()
    for (const c of op.cores) {
      if (!known.includes(c.core)) errors.push(`${op.partNumber} has no core '${c.core}' (cores: ${known.join(', ')})`)
      else if (used.has(c.core)) errors.push(`core '${c.core}' is named twice`)
      used.add(c.core)
    }
    if (op.drain && !spec.shield) errors.push(`${op.partNumber} has no shield, so it has no drain`)
    // The store would fall back to an invented 0.5 mm² BK drain; the CLI takes it from the record only.
    else if (op.drain && !known.includes('drain'))
      errors.push(
        `${op.partNumber} has no 'drain' core — the drain's gauge and colour must come from the datasheet; add a core named 'drain'`
      )
    if (op.drain && used.has('drain')) errors.push(`core 'drain' is named alongside a drain`)
    if (errors.length) return errors
    const refs = op.cores.flatMap((c) => [c.from, c.to])
    if (op.drain) refs.push(op.drain.to)
    const r = this.ends(refs)
    if ('errors' in r) return r.errors
    const eps = r.ok
    const cores = op.cores.map((c, i) => ({ core: c.core, a: eps[2 * i], b: eps[2 * i + 1] }))
    for (const [i, c] of cores.entries()) {
      if (sameEndpoint(c.a, c.b)) return [`core '${c.core}': from and to are the same end (${op.cores[i].from})`]
    }
    const drain = op.drain ? { end: op.drain.end, to: eps[eps.length - 1] } : undefined
    const id = S().addCableFromPart(p.ok, name, cores, drain)
    if (id === null) return [`the store refused cable ${name} from ${op.partNumber}`]
    this.summary.push(
      `cable ${name} (${op.partNumber}): ${op.cores.map((c) => `${c.core} ${c.from} → ${c.to}`).join(', ')}` +
        (op.drain ? `, drain shield ${op.drain.end} → ${op.drain.to}` : '')
    )
    return []
  }

  private cavity(op: Extract<Op, { op: 'cavity' }>): string[] {
    const ref = parseEndRef(op.at)
    if ('error' in ref) return [ref.error]
    if (ref.kind !== 'cavity') return [`'${op.at}' is not a cavity (<designator>:<position>)`]
    const doc = S().doc
    const ep = resolveEndRef(doc, ref)
    if ('error' in ep) return [ep.error]
    if (ep.type !== 'cavity') return [`'${op.at}' is not a cavity`]
    const conn = doc.connectors.find((c) => c.cavities.some((cv) => cv.id === ep.cavityId))!
    const rail = this.connectorRail(doc, conn.id)
    if (rail.length) return rail
    if (op.status === 'populated') return this.populate(op, conn.id, ep.cavityId)
    const wired = doc.wires.filter((w) => w.ends.some((e) => sameEndpoint(e, ep))).length
    if (wired) return [`${op.at} has ${wired} wire(s); unwire before marking it ${op.status}`]
    let plug: LibraryPart | undefined
    if (op.status === 'plugged') {
      if (!op.plugPartNumber) return [`a plugged cavity needs plugPartNumber (the plug is a part)`]
      const p = this.part(op.plugPartNumber, 'plug')
      if ('errors' in p) return p.errors
      plug = p.ok
    } else if (op.plugPartNumber) return [`plugPartNumber is only for status 'plugged'`]
    const plugRef = plug ? refOf(plug) : undefined
    S().applyEdit((d) => {
      const cv = d.connectors.flatMap((c) => c.cavities).find((c) => c.id === ep.cavityId)!
      cv.status = op.status
      // No conductor lands here: no pin or wire seal to buy (the BOM counts them by cavity), and no lead.
      delete cv.pin
      delete cv.seal
      delete cv.lead
      if (plugRef) cv.plug = plugRef
      else delete cv.plug
    })
    this.summary.push(`cavity ${op.at} ${op.status}${op.plugPartNumber ? ` (${op.plugPartNumber})` : ''}`)
    return []
  }

  /**
   * `cavity … populated` — undo a mistaken `empty` / `plugged`: the plug is cleared and the pin
   * and seal are re-filled from the housing record's defaults for that position (left empty
   * where the record names none). A cavity that is already populated is left exactly as it is
   * (its pin/seal may have been chosen by hand).
   */
  private populate(op: Extract<Op, { op: 'cavity' }>, connectorId: Id, cavityId: Id): string[] {
    if (op.plugPartNumber) return [`plugPartNumber is only for status 'plugged'`]
    const conn = S().doc.connectors.find((c) => c.id === connectorId)!
    const cav = conn.cavities.find((c) => c.id === cavityId)!
    if (cav.status === 'populated') {
      this.summary.push(`cavity ${op.at} already populated (unchanged)`)
      return []
    }
    // connectorRail passed: the housing record is complete, so its default pin/seal records are too.
    const housing = this.lib.catalog.part(conn.housing!.partNumber)!
    const tpl = housing.connector!.cavities.find((c) => c.position === cav.position)!
    const refFor = (pn: string | undefined) => {
      if (!pn) return undefined
      const p = this.lib.catalog.part(pn)
      return p ? refOf(p) : { partNumber: pn }
    }
    const pin = refFor(tpl.defaultPin)
    const seal = refFor(tpl.defaultSeal)
    S().applyEdit((d) => {
      const cv = d.connectors.flatMap((c) => c.cavities).find((c) => c.id === cavityId)!
      cv.status = 'populated'
      delete cv.plug
      if (pin) cv.pin = pin
      else delete cv.pin
      if (seal) cv.seal = seal
      else delete cv.seal
      if (tpl.lead) cv.lead = leadFromLibrary(tpl.lead)
      else delete cv.lead
    })
    const filled = [
      pin && `pin ${pin.partNumber}`,
      seal && `seal ${seal.partNumber}`,
      tpl.lead && 'factory lead'
    ].filter(Boolean)
    this.summary.push(
      `cavity ${op.at} populated (${filled.length ? filled.join(', ') : `no default pin or seal in ${housing.partNumber}`})`
    )
    return []
  }

  private setWire(op: Extract<Op, { op: 'set-wire' }>): string[] {
    if (op.color === undefined && op.partNumber === undefined) return [`nothing to set (give color and/or partNumber)`]
    const w = this.oneWire(op.from, op.to, true)
    if ('errors' in w) return w.errors
    let color: WireColor | undefined
    if (op.color !== undefined) {
      const c = parseColor(op.color)
      if ('error' in c) return [c.error]
      color = c
    }
    let part: LibraryPart | undefined
    if (op.partNumber !== undefined) {
      const p = this.part(op.partNumber, 'wire')
      if ('errors' in p) return p.errors
      part = p.ok
    }
    const current = S().doc.wires.find((y) => y.id === w.ok)!
    // A factory lead keeps its own colour and takes no wire part (see leadWire).
    const lead = leadAt(S().doc, current.ends[0]) ?? leadAt(S().doc, current.ends[1])
    if (lead && part) return [`${lead.label} is a factory lead: the wire is the lead itself, so leave out partNumber`]
    if (lead?.lead.color && color && fmtColor(lead.lead.color) !== fmtColor(color))
      return [`${lead.label}'s factory lead is ${fmtColor(lead.lead.color)}, not ${op.color}`]
    // The colour rail against the record the wire will carry: the new one, else the one it has.
    const record = part ?? (current.spec?.partNumber ? this.lib.catalog.part(current.spec.partNumber) : undefined)
    if (record && record.kind === 'wire') {
      const clash = colorRail(record, color ?? current.color)
      if (clash) return [clash]
    }
    const spec = part ? refOf(part) : undefined
    S().applyEdit((d) => {
      const x = d.wires.find((y) => y.id === w.ok)!
      if (color) x.color = color
      if (part && spec) {
        x.spec = spec
        x.gauge = { ...part.wire!.gauge } // the wire part fixes the gauge (rail 2a)
      }
    })
    this.summary.push(
      `set wire ${op.from} → ${op.to}:${op.color ? ` colour ${op.color}` : ''}${op.partNumber ? ` part ${op.partNumber}` : ''}`
    )
    return []
  }

  private unwire(op: Extract<Op, { op: 'unwire' }>): string[] {
    // Removing a wire invents nothing, so the touched-connector rail does not apply.
    const w = this.oneWire(op.from, op.to, false)
    if ('errors' in w) return w.errors
    S().removeWires([w.ok])
    this.summary.push(`removed wire ${op.from} → ${op.to}`)
    return []
  }

  private remove(op: Extract<Op, { op: 'remove' }>): string[] {
    const doc = S().doc
    const bodies = [...doc.connectors, ...doc.freeTerminals, ...doc.splices].filter((b) => b.designator === op.ref)
    const cables = doc.cables.filter((c) => c.name === op.ref)
    const n = bodies.length + cables.length
    if (n === 0) {
      const known = [...allDesignators(doc), ...doc.cables.map((c) => c.name)]
      return [`no body or cable '${op.ref}' (have: ${known.length ? known.join(', ') : 'none'})`]
    }
    if (n > 1) return [`'${op.ref}' names ${n} bodies/cables; cannot tell which one is meant`]
    if (bodies.length) {
      const before = doc.wires.length
      S().removeElements({ bodyIds: [bodies[0].id], wireIds: [] })
      this.summary.push(`removed ${op.ref} and ${before - S().doc.wires.length} wire(s) on it`)
      return []
    }
    const cab = cables[0]
    const wireIds = doc.wires
      .filter(
        (w) =>
          w.cableId === cab.id ||
          cab.coreWireIds.includes(w.id) ||
          cab.shield?.drainWireId === w.id ||
          w.ends.some((e) => e.type === 'shield' && e.cableId === cab.id)
      )
      .map((w) => w.id)
    if (wireIds.length) S().removeWires(wireIds)
    // No store action removes a cable entity outright (removeWires drops a
    // cable once nothing references it); clear anything left that names it.
    S().applyEdit((d) => {
      d.cables = d.cables.filter((c) => c.id !== cab.id)
      d.placements = d.placements.filter((p) => p.refId !== cab.id)
      d.sleeving = d.sleeving.filter((s) => !(s.target.type === 'cable' && s.target.cableId === cab.id))
    })
    this.summary.push(`removed cable ${op.ref} and its ${wireIds.length} wire(s)`)
    return []
  }
}
