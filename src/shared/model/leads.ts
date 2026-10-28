// Factory-fitted leads (`Cavity.lead`): which wires are a part's own lead, and how a lead compares with its wire.

import type { CavityLead, Endpoint, Gauge, HarnessDocument, Wire } from './schema'

/** A cavity's factory lead, with the `X1.2` label the DRC messages and tables use for it. */
export interface LeadAt {
  lead: CavityLead
  label: string
}

/** The factory lead at `ep`, or null when `ep` is not a cavity that has one. */
export function leadAt(doc: HarnessDocument, ep: Endpoint): LeadAt | null {
  if (ep.type !== 'cavity') return null
  for (const c of doc.connectors) {
    const cv = c.cavities.find((x) => x.id === ep.cavityId)
    if (cv) return cv.lead ? { lead: cv.lead, label: `${c.designator}.${cv.position}` } : null
  }
  return null
}

/**
 * The lead `w` is, when one of its ends is a cavity with a factory lead: the
 * wire is then the part's own lead, cut to length, not wire off a reel.
 */
export function wireLead(doc: HarnessDocument, w: Wire): LeadAt | null {
  return leadAt(doc, w.ends[0]) ?? leadAt(doc, w.ends[1])
}

/** Conductor cross-section in mm²; AWG by the standard formula (14 AWG ≈ 2.08 mm²). */
export function gaugeMm2(g: Gauge): number {
  if (g.unit === 'mm2') return g.value
  const d = 0.127 * Math.pow(92, (36 - g.value) / 39)
  return (Math.PI / 4) * d * d
}

/** The same conductor size to within 10 %: 14 AWG and 2 mm² match, 14 AWG and 2.5 mm² do not. */
export function sameGauge(a: Gauge, b: Gauge): boolean {
  const x = gaugeMm2(a)
  const y = gaugeMm2(b)
  return Math.abs(x - y) <= 0.1 * Math.max(x, y)
}

/** "2.08 mm² RD, 203 mm": what is known about a lead; "" when nothing is. */
export function describeLead(lead: CavityLead): string {
  const size = lead.gauge ? `${lead.gauge.value} ${lead.gauge.unit === 'mm2' ? 'mm²' : 'AWG'}` : ''
  const colour = lead.color ? [lead.color.base, ...(lead.color.stripes ?? [])].join('/') : ''
  const wire = [size, colour].filter(Boolean).join(' ')
  const length = lead.lengthMm != null ? `${lead.lengthMm} mm` : ''
  return [wire, length].filter(Boolean).join(', ')
}
