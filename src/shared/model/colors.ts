/**
 * IEC 60757 colour-abbreviation → SVG stroke colour. Shared by the interactive
 * canvas (flow/toFlow) and the SVG exporter so both draw wires identically.
 */
const IEC_STROKE: Record<string, string> = {
  BK: '#222',
  BN: '#6d4c41',
  RD: '#c62828',
  OG: '#ef6c00',
  YE: '#f9a825',
  GN: '#2e7d32',
  BU: '#1565c0',
  VT: '#6a1b9a',
  GY: '#777',
  WH: '#9e9e9e',
  PK: '#ec407a',
  // Protective-earth / chassis ground (IEC 60757, EN 50525). Mandatory on EV /
  // battery systems; a single stroke can't show both tones, so approximate green.
  GNYE: '#4caf50',
  TQ: '#26a69a',
  SR: '#b0bec5',
  GD: '#c9a227'
}

/** A valid 3- or 6-digit hex colour (so a user `base` can't break out of the SVG attr). */
const HEX_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/

/** Map an IEC colour abbreviation (or a `#hex`) to an SVG stroke colour. */
export function strokeForColor(base: string): string {
  if (base.startsWith('#')) return HEX_RE.test(base) ? base : '#555'
  return IEC_STROKE[base.toUpperCase()] ?? '#555'
}

/** IEC 60757 colour-abbreviation → human-readable name, for table display. */
const IEC_NAME: Record<string, string> = {
  BK: 'Black',
  BN: 'Brown',
  RD: 'Red',
  OG: 'Orange',
  YE: 'Yellow',
  GN: 'Green',
  BU: 'Blue',
  VT: 'Violet',
  GY: 'Grey',
  WH: 'White',
  PK: 'Pink',
  GNYE: 'Green/Yellow',
  TQ: 'Turquoise',
  SR: 'Silver',
  GD: 'Gold'
}

/** Human-readable colour name for a `WireColor.base`: IEC abbreviation → name,
 *  a `#hex` passes through unchanged, an unknown abbreviation passes through
 *  unchanged (as authored, not upper-cased). */
export function colorName(base: string): string {
  if (base.startsWith('#')) return base
  return IEC_NAME[base.toUpperCase()] ?? base
}

/** Every IEC colour code the app draws, in picker order: `{ code: 'BK', name: 'Black' }`. */
export const IEC_COLORS: readonly { code: string; name: string }[] = Object.entries(IEC_NAME).map(
  ([code, name]) => ({ code, name })
)

/** True for a listed IEC code (any case) or a valid `#hex`; anything else draws as grey. */
export function isKnownColor(base: string): boolean {
  return base.startsWith('#') ? HEX_RE.test(base) : base.toUpperCase() in IEC_NAME
}

/**
 * Common non-IEC abbreviations (US / SAE style) → the IEC code, so a search for
 * "BLK" finds Black. Search only: the stored code is always the IEC one.
 */
const ALIASES: Record<string, string> = {
  BLK: 'BK',
  BRN: 'BN',
  RED: 'RD',
  ORN: 'OG',
  ORG: 'OG',
  YEL: 'YE',
  GRN: 'GN',
  BLU: 'BU',
  VIO: 'VT',
  PUR: 'VT',
  GRY: 'GY',
  GRA: 'GY',
  WHT: 'WH',
  PNK: 'PK',
  TRQ: 'TQ',
  SIL: 'SR',
  GLD: 'GD'
}

/**
 * The colour picker's rows for a typed query: every colour for an empty query,
 * else those whose code, alias or name matches — exact code/alias first, then
 * code/alias prefix, then name prefix, then name substring, each in
 * `IEC_COLORS` order. "BLK" → Black; "gn" → Green, Green/Yellow; "#f00" → none.
 */
export function searchColors(query: string): { code: string; name: string }[] {
  const q = query.trim().toUpperCase()
  if (!q) return [...IEC_COLORS]
  const rank = ({ code, name }: { code: string; name: string }): number => {
    const keys = [code, ...Object.keys(ALIASES).filter((a) => ALIASES[a] === code)]
    const n = name.toUpperCase()
    if (keys.includes(q)) return 0
    if (keys.some((k) => k.startsWith(q))) return 1
    if (n.startsWith(q)) return 2
    if (n.includes(q)) return 3
    return -1
  }
  return IEC_COLORS.map((c, i) => ({ c, i, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c)
}
