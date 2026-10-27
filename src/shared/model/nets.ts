import type { HarnessDocument, Id } from './schema'
import { endpointHandleId } from './endpoints'

export interface Net {
  id: string
  wireIds: Id[]
  endpointKeys: string[]
}

/** Connected conductor sets, derived through shared endpoints + cable shields. */
export function computeNets(doc: HarnessDocument): Net[] {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    if (!parent.has(k)) parent.set(k, k)
    let r = k
    while (parent.get(r) !== r) r = parent.get(r)!
    // path-compress
    let c = k
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n }
    return r
  }
  const union = (a: string, b: string): void => { parent.set(find(a), find(b)) }

  for (const w of doc.wires) union(endpointHandleId(w.ends[0]), endpointHandleId(w.ends[1]))
  // a cable shield is a single conductor spanning both ends
  for (const c of doc.cables) {
    if (c.shield?.present) union(`sh:${c.id}:a`, `sh:${c.id}:b`)
  }

  const byRoot = new Map<string, Net>()
  for (const w of doc.wires) {
    const root = find(endpointHandleId(w.ends[0]))
    let net = byRoot.get(root)
    if (!net) { net = { id: root, wireIds: [], endpointKeys: [] }; byRoot.set(root, net) }
    net.wireIds.push(w.id)
    for (const e of w.ends) {
      const k = endpointHandleId(e)
      if (!net.endpointKeys.includes(k)) net.endpointKeys.push(k)
    }
  }
  return [...byRoot.values()]
}
