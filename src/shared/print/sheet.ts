import type { PaperSize, SheetConfig } from '@shared/model/schema'
import { PLOTTER_DEFAULT_LENGTH_MM, PLOTTER_ROLL_WIDTH_MM } from '@shared/model/schema'

/** Sheet dimensions in millimetres */
export interface SheetMm {
  wMm: number
  hMm: number
}

/** The BOM / Wiring Table / Cutlist pages are always this — only the drawing page follows `drawing.sheet`. */
export const DOCUMENT_PAGE_SHEET: SheetConfig = { paper: 'A4', orientation: 'landscape' }

/** Drawing-set page margin (mm) */
export const PAGE_MARGIN = 10
/** Printer-safe margin for the 1:1 drawing page (mm) */
export const TEMPLATE_MARGIN = 8

/** Axis-aligned rectangle in mm */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** ISO A-series portrait dimensions (width × height) in mm. `Plotter` is a roll, sized per document. */
const PORTRAIT_DIMS: Record<Exclude<PaperSize, 'Plotter'>, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  A2: { w: 420, h: 594 },
  A1: { w: 594, h: 841 },
  A0: { w: 841, h: 1189 },
}

/**
 * Sheet dimensions in mm for a `SheetConfig`.
 * Portrait: narrow × tall. Landscape: wide × short (w/h swapped).
 * `Plotter` is a roll of fixed width (`PLOTTER_ROLL_WIDTH_MM`) and chosen length
 * (`lengthMm`, default `PLOTTER_DEFAULT_LENGTH_MM`): landscape runs the roll
 * horizontally (length × width), portrait vertically (width × length).
 */
export function sheetMm(cfg: SheetConfig): SheetMm {
  if (cfg.paper === 'Plotter') {
    const len = cfg.lengthMm ?? PLOTTER_DEFAULT_LENGTH_MM
    return cfg.orientation === 'portrait'
      ? { wMm: PLOTTER_ROLL_WIDTH_MM, hMm: len }
      : { wMm: len, hMm: PLOTTER_ROLL_WIDTH_MM }
  }
  const { w, h } = PORTRAIT_DIMS[cfg.paper]
  return cfg.orientation === 'portrait' ? { wMm: w, hMm: h } : { wMm: h, hMm: w }
}

/** Returns the rectangle inset from the sheet edges by `margin` on all sides. */
export function frameRect(sheet: SheetMm, margin: number): Rect {
  return {
    x: margin,
    y: margin,
    w: sheet.wMm - 2 * margin,
    h: sheet.hMm - 2 * margin,
  }
}
