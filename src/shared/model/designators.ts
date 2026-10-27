import type { HarnessDocument } from './schema'

/** Reference-designator prefixes. Electrical identity only — never a position. */
export const DESIGNATOR_PREFIX = { connector: 'X', terminal: 'T', splice: 'SP' } as const

/** Lowest free `<prefix><n>` (n >= 1). `taken` is compared exactly (case-sensitive). */
export function nextDesignator(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let n = 1
  while (used.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

/** Every designator in the document: connectors + free terminals + splices. */
export function allDesignators(doc: HarnessDocument): string[] {
  return [...doc.connectors, ...doc.freeTerminals, ...doc.splices]
    .map((e) => e.designator)
    .filter((d): d is string => typeof d === 'string')
}

const present = (d: unknown): boolean => typeof d === 'string' && d.trim() !== ''

/**
 * In place: give every terminal/splice lacking a usable designator the lowest
 * free one, in array order, skipping all designators already in the document.
 * Returns how many were assigned.
 */
export function backfillDesignators(doc: HarnessDocument): number {
  const taken = new Set(allDesignators(doc).filter(present))
  let assigned = 0
  const fill = (items: { designator: string }[], prefix: string): void => {
    for (const e of items) {
      if (present(e.designator)) continue
      e.designator = nextDesignator(prefix, taken)
      taken.add(e.designator)
      assigned++
    }
  }
  fill(doc.freeTerminals, DESIGNATOR_PREFIX.terminal)
  fill(doc.splices, DESIGNATOR_PREFIX.splice)
  return assigned
}
