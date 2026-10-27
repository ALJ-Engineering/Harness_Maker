import type { PaperSize, SheetConfig } from '@shared/model/schema'
import { PLOTTER_DEFAULT_LENGTH_MM, PLOTTER_MAX_LENGTH_MM, PLOTTER_MIN_LENGTH_MM, PLOTTER_ROLL_WIDTH_MM } from '@shared/model/schema'
import { sheetMm } from '@shared/print/sheet'

/**
 * `sheet` on another paper. `lengthMm` belongs to the plotter roll only:
 * switching TO Plotter supplies the default length when there is none,
 * switching AWAY drops the key altogether so a saved A-size sheet carries no
 * stale roll length.
 */
export function withPaper(sheet: SheetConfig, paper: PaperSize): SheetConfig {
  const { lengthMm, ...rest } = sheet
  if (paper !== 'Plotter') return { ...rest, paper }
  return { ...rest, paper, lengthMm: lengthMm ?? PLOTTER_DEFAULT_LENGTH_MM }
}

/**
 * A typed plotter length as the store takes it: whole millimetres, clamped to
 * `PLOTTER_MIN_LENGTH_MM`–`PLOTTER_MAX_LENGTH_MM` (the loader's own bounds). Undefined for anything
 * that is not a finite number — the caller then leaves the sheet alone.
 */
export function plotterLengthMm(v: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined
  return Math.min(PLOTTER_MAX_LENGTH_MM, Math.max(PLOTTER_MIN_LENGTH_MM, Math.round(v)))
}

/**
 * Read-only sheet line for the export dialog, e.g. `Plotter 914 × 2600 mm,
 * landscape` or `A3 297 × 420 mm, landscape`. The size is quoted the way the
 * paper is named — short side × long side (ISO, and a roll's width × length) —
 * and the orientation says which way it runs.
 */
export function sheetDescription(sheet: SheetConfig): string {
  if (sheet.paper === 'Plotter') {
    const len = sheet.lengthMm ?? PLOTTER_DEFAULT_LENGTH_MM
    return `Plotter ${PLOTTER_ROLL_WIDTH_MM} × ${len} mm, ${sheet.orientation}`
  }
  const { wMm, hMm } = sheetMm(sheet)
  const short = Math.min(wMm, hMm)
  const long = Math.max(wMm, hMm)
  return `${sheet.paper} ${short} × ${long} mm, ${sheet.orientation}`
}
