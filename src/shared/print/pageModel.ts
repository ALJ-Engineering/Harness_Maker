import type { SheetMm } from './sheet'

/** One rendered drawing-set page: a complete, self-contained SVG document string. */
export interface Page {
  id: string
  section: string
  /** Full `<svg …mm>` element markup for this page. */
  svg: string
}

/** An ordered set of pages sharing one sheet size. */
export interface PageSet {
  sheet: SheetMm
  pages: Page[]
}
