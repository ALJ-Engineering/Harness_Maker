import { strokeForColor } from '@shared/model/colors'

/**
 * Wire colour for the SCREEN. The printed drawing must draw a black wire black,
 * so `shared/model/colors.ts` is left alone and this wrapper handles the one
 * case a dark canvas breaks: near-black strokes, which vanish against
 * `--canvas-bg`. Print never imports this module.
 */

/**
 * `--wire-black` (dark theme): what a black conductor is drawn with on a dark canvas.
 * Deliberately duplicates the `--wire-black` token in `index.css` — this module is
 * imported by `screenColors.test.ts`, which runs in node with no DOM, so it cannot read
 * a CSS variable. Change both together.
 */
export const DARK_WIRE_BLACK = '#e8e9ec'

/** Below this relative luminance a stroke is treated as near-black. */
export const NEAR_BLACK_LUMINANCE = 0.18

/** Relative luminance of a `#rgb`/`#rrggbb` colour, sRGB channels 0–1, unweighted by gamma. */
export function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Screen stroke for a `WireColor.base`: the print colour, lifted if it would vanish. */
export function screenStroke(base: string, theme: 'dark' | 'light'): string {
  const stroke = strokeForColor(base)
  if (theme !== 'dark') return stroke
  return relativeLuminance(stroke) < NEAR_BLACK_LUMINANCE ? DARK_WIRE_BLACK : stroke
}
