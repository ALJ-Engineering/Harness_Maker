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
