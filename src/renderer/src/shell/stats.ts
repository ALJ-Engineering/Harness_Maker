import type { HarnessDocument, SheetConfig } from '@shared/model/schema'
import { PLOTTER_DEFAULT_LENGTH_MM, PLOTTER_ROLL_WIDTH_MM } from '@shared/model/schema'
import { computeCutList } from '@shared/export/bom'

/**
 * The numbers the bottom bar's stats chip shows. Pure; derived on demand.
 *
 * A cut row with no known length (`lengthMm: null` — an 'ea' part, or a run
 * whose contributors are all unknown) contributes 0, never `NaN`: the chip is a
 * running total, not a claim that every length is known.
 *
 * Callers memoise this on `doc` — the cut list walks every wire.
 */
export function docStats(doc: HarnessDocument): {
  wires: number
  totalLengthMm: number
  sheetLabel: string
} {
  const rows = computeCutList(doc)
  const totalLengthMm = rows.reduce((sum, r) => sum + (r.lengthMm ?? 0), 0)
  return { wires: doc.wires.length, totalLengthMm, sheetLabel: sheetLabel(doc.drawing.sheet) }
}

/**
 * Short sheet name for the stats chip: `A3 L`, or for a plotter roll its
 * size as width × length (`Plotter 914×2600 L`) — the roll's length is the
 * only thing that tells two plotter sheets apart.
 */
export function sheetLabel(sheet: SheetConfig): string {
  const o = sheet.orientation === 'portrait' ? 'P' : 'L'
  if (sheet.paper !== 'Plotter') return `${sheet.paper} ${o}`
  return `Plotter ${PLOTTER_ROLL_WIDTH_MM}×${sheet.lengthMm ?? PLOTTER_DEFAULT_LENGTH_MM} ${o}`
}
