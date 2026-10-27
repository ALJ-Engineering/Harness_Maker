// Pure, unique key per electrical endpoint. Used as React Flow handle ids and as route-node keys.

import type { Endpoint, HarnessDocument, Id, RouteNode } from './schema'

/** A unique string key that uniquely identifies an electrical endpoint. */
export function endpointHandleId(ep: Endpoint): string {
  switch (ep.type) {
    case 'cavity':
      return `cav:${ep.cavityId}`
    case 'freeTerminal':
      return `ft:${ep.terminalId}`
    case 'splice':
      return `sp:${ep.spliceId}`
    case 'shield':
      return `sh:${ep.cableId}:${ep.end}`
  }
}

/** Inverse of endpointHandleId: parse a handle id back to an Endpoint. */
export function parseHandleId(handleId: string): Endpoint | null {
  const [kind, ...rest] = handleId.split(':')
  switch (kind) {
    case 'cav':
      return { type: 'cavity', cavityId: rest.join(':') }
    case 'ft':
      return { type: 'freeTerminal', terminalId: rest.join(':') }
    case 'sp':
      return { type: 'splice', spliceId: rest.join(':') }
    case 'sh': {
      const end = rest.pop()
      if (end !== 'a' && end !== 'b') return null
      return { type: 'shield', cableId: rest.join(':'), end }
    }
    default:
      return null
  }
}

/** True if two endpoints denote the same electrical point (would be a self-loop). */
export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return endpointHandleId(a) === endpointHandleId(b)
}

/** Route-node key of a placed body. Same key space as `b:<branchId>` (geometry.ts). */
export function bodyKey(refId: Id): string {
  return `n:${refId}`
}

export function bodyNode(refId: Id): RouteNode {
  return { type: 'body', refId }
}

/** The placed entity a wire end physically lands on: connector / terminal / splice / cable. */
export function endpointBodyId(doc: HarnessDocument, ep: Endpoint): Id | null {
  switch (ep.type) {
    case 'cavity':
      return doc.connectors.find((c) => c.cavities.some((cv) => cv.id === ep.cavityId))?.id ?? null
    case 'freeTerminal':
      return doc.freeTerminals.some((f) => f.id === ep.terminalId) ? ep.terminalId : null
    case 'splice':
      return doc.splices.some((s) => s.id === ep.spliceId) ? ep.spliceId : null
    case 'shield':
      return ep.cableId
  }
}

/** `bodyKey(endpointBodyId(...))`, or null when the owner does not exist. */
export function endpointBodyKey(doc: HarnessDocument, ep: Endpoint): string | null {
  const id = endpointBodyId(doc, ep)
  return id ? bodyKey(id) : null
}
