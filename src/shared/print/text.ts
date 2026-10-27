import { PT_TO_MM } from '../model/anchors'

/** Points-to-mm conversion factor, re-exported for print-layer callers. */
export const PT = PT_TO_MM

/** Formats a number to 2 decimal places, trimming trailing zeros. */
export const fmt = (n: number): string => Number(n.toFixed(2)).toString()

/** Escapes text for safe inclusion inside SVG/XML content or attributes. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Per-glyph advance in em for a generic sans (Helvetica/Arial metrics, rounded).
const NARROW = new Set('iljtfI.,:;\'|! '.split(''))
const WIDE = new Set('mwMW@%')
const UPPER_DIGIT = /[A-Z0-9]/

function glyphEm(ch: string): number {
  if (ch === ' ') return 0.28
  if (NARROW.has(ch)) return 0.3
  if (WIDE.has(ch)) return 0.85
  if (UPPER_DIGIT.test(ch)) return 0.6
  return 0.52
}

/** Estimates the rendered width in mm of `text` set at `fontMm` em-height. */
export function estimateTextWidthMm(text: string, fontMm: number): number {
  let em = 0
  for (const ch of text) em += glyphEm(ch)
  return em * fontMm
}

/**
 * Returns `text` unchanged if it fits within `maxWMm` at `fontMm`, otherwise
 * clips it and appends an ellipsis so the result fits. Returns '…' alone if
 * even that does not fit.
 */
export function fitText(text: string, fontMm: number, maxWMm: number): string {
  if (estimateTextWidthMm(text, fontMm) <= maxWMm) return text
  const chars = [...text]
  while (chars.length > 0) {
    chars.pop()
    const candidate = chars.join('').trimEnd() + '…'
    if (estimateTextWidthMm(candidate, fontMm) <= maxWMm) return candidate
  }
  return '…'
}

/**
 * Greedily word-wraps `text` into at most `maxLines` lines that each fit
 * within `maxWMm` at `fontMm`. Every line — including non-final ones — is
 * passed through `fitText` so a single word wider than `maxWMm` is clipped
 * with an ellipsis rather than overflowing; the final line is likewise
 * `fitText`-clipped when the text is longer than `maxLines` lines can hold.
 * Never splits a word except when clipping an already-overflowing line.
 */
export function wrapText(text: string, fontMm: number, maxWMm: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lines: string[] = []
  let idx = 0
  while (lines.length < maxLines - 1 && idx < words.length) {
    let cur = fitText(words[idx], fontMm, maxWMm)
    idx++
    while (idx < words.length && estimateTextWidthMm(`${cur} ${words[idx]}`, fontMm) <= maxWMm) {
      cur += ` ${words[idx]}`
      idx++
    }
    lines.push(cur)
  }
  if (idx < words.length) {
    lines.push(fitText(words.slice(idx).join(' '), fontMm, maxWMm))
  }
  return lines
}

/** Renders a single-line SVG `<text>` element with escaped content. */
export function svgText(
  x: number,
  y: number,
  text: string,
  opts: { size?: number; anchor?: 'start' | 'middle' | 'end'; weight?: 'bold'; fill?: string; cls?: string } = {},
): string {
  const a: string[] = [`x="${fmt(x)}"`, `y="${fmt(y)}"`]
  if (opts.cls) a.push(`class="${opts.cls}"`)
  if (opts.size != null) a.push(`font-size="${fmt(opts.size)}"`)
  if (opts.anchor) a.push(`text-anchor="${opts.anchor}"`)
  if (opts.weight) a.push(`font-weight="${opts.weight}"`)
  if (opts.fill) a.push(`fill="${opts.fill}"`)
  return `<text ${a.join(' ')}>${escapeXml(text)}</text>`
}
