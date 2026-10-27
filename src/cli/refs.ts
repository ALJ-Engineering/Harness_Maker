import type { Endpoint, HarnessDocument } from '@shared/model/schema'
import { sortedCavities } from '@shared/model/anchors'

/**
 * The end-reference grammar every op uses to name a wire end — by DESIGNATOR,
 * never by id or geometry:
 *   `X1:7`           cavity at position "7" of connector X1
 *   `SP1`, `T1`      that splice / free terminal
 *   `CAN-1:shield:a` shield end a of the cable named CAN-1
 * Matching is exact and case-sensitive (designators are stored trimmed; a
 * cavity position is a string, so "07" is not "7").
 */
export type EndRef =
  | { kind: 'cavity'; designator: string; position: string }
  | { kind: 'body'; designator: string }
  | { kind: 'shield'; cable: string; end: 'a' | 'b' }

export function parseEndRef(s: string): EndRef | { error: string } {
  if (typeof s !== 'string' || s === '') return { error: 'empty end reference' }
  if (s !== s.trim()) return { error: `end reference '${s}' has surrounding whitespace` }
  const shield = /^(.+):shield:(.*)$/.exec(s)
  if (shield) {
    const [, cable, end] = shield
    if (end !== 'a' && end !== 'b') return { error: `'${s}': a shield end is 'a' or 'b'` }
    return { kind: 'shield', cable, end }
  }
  const parts = s.split(':')
  if (parts.length === 1) return { kind: 'body', designator: s }
  if (parts.length > 2) return { error: `'${s}' is not <designator>:<position>, <designator> or <cable>:shield:<a|b>` }
  const [designator, position] = parts
  if (!designator || !position) return { error: `'${s}' is not <designator>:<position>` }
  return { kind: 'cavity', designator, position }
}

const list = (xs: string[]): string => (xs.length ? xs.join(', ') : 'none')

export function formatEndRef(r: EndRef): string {
  if (r.kind === 'cavity') return `${r.designator}:${r.position}`
  if (r.kind === 'body') return r.designator
  return `${r.cable}:shield:${r.end}`
}

/** Resolve against the CURRENT document. Refuses anything ambiguous rather than picking one. */
export function resolveEndRef(doc: HarnessDocument, ref: EndRef): Endpoint | { error: string } {
  const kindOf = (d: string): string | null => {
    if (doc.connectors.some((c) => c.designator === d)) return 'a connector'
    if (doc.splices.some((x) => x.designator === d)) return 'a splice'
    if (doc.freeTerminals.some((x) => x.designator === d)) return 'a free terminal'
    return null
  }
  if (ref.kind === 'cavity') {
    const conns = doc.connectors.filter((c) => c.designator === ref.designator)
    if (conns.length === 0) {
      const k = kindOf(ref.designator)
      if (k) return { error: `${ref.designator} is ${k} and has no cavities; name it as '${ref.designator}'` }
      return { error: `no connector '${ref.designator}' (connectors: ${list(doc.connectors.map((c) => c.designator))})` }
    }
    if (conns.length > 1) return { error: `designator '${ref.designator}' names ${conns.length} connectors` }
    const conn = conns[0]
    const hits = conn.cavities.filter((c) => c.position === ref.position)
    if (hits.length === 0) {
      return {
        error: `${conn.designator} has no cavity '${ref.position}' (positions: ${list(sortedCavities(conn).map((c) => c.position))})`
      }
    }
    if (hits.length > 1) return { error: `${conn.designator} has ${hits.length} cavities at position '${ref.position}'` }
    return { type: 'cavity', cavityId: hits[0].id }
  }
  if (ref.kind === 'body') {
    const sp = doc.splices.filter((x) => x.designator === ref.designator)
    const ft = doc.freeTerminals.filter((x) => x.designator === ref.designator)
    if (sp.length + ft.length === 0) {
      if (doc.connectors.some((c) => c.designator === ref.designator))
        return { error: `${ref.designator} is a connector; name a cavity as '${ref.designator}:<position>'` }
      const known = [...doc.splices, ...doc.freeTerminals].map((x) => x.designator)
      return { error: `no splice or free terminal '${ref.designator}' (have: ${list(known)})` }
    }
    if (sp.length + ft.length > 1 || doc.connectors.some((c) => c.designator === ref.designator))
      return { error: `designator '${ref.designator}' names more than one body` }
    return sp.length ? { type: 'splice', spliceId: sp[0].id } : { type: 'freeTerminal', terminalId: ft[0].id }
  }
  const cabs = doc.cables.filter((c) => c.name === ref.cable)
  if (cabs.length === 0) return { error: `no cable '${ref.cable}' (cables: ${list(doc.cables.map((c) => c.name))})` }
  if (cabs.length > 1) return { error: `cable name '${ref.cable}' names ${cabs.length} cables` }
  if (!cabs[0].shield?.present) return { error: `${ref.cable} has no shield` }
  return { type: 'shield', cableId: cabs[0].id, end: ref.end }
}

/** Parse + resolve in one step; the error carries the reference text. */
export function endpointOf(doc: HarnessDocument, s: string): Endpoint | { error: string } {
  const ref = parseEndRef(s)
  if ('error' in ref) return ref
  return resolveEndRef(doc, ref)
}
