import type { HarnessDocument, Vec2 } from '../model/schema'
import type { FbLayout } from '../model/formboard'
import { computeFormboard, lengthLabel, labelDisplayText, LABEL_FONT, MIN_FONT, BODY_DOT_R } from '../model/formboard'
import { strokeForColor } from '../model/colors'

/**
 * Render the harness to a standalone, print-ready SVG string.
 *
 * Coordinates are millimetres: the <svg> is sized in `mm` with a 1:1 viewBox so
 * a printed segment equals its true modelled length (spec's locked 1:1 print).
 *
 * Drawing iterates the shared FbLayout from computeFormboard(doc) — the same
 * geometry used by the on-screen formboard view, so SVG == view by construction.
 */

const MARGIN = 12

const fmt = (n: number): string => Number(n.toFixed(2)).toString()

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const pointsToD = (pts: Vec2[]): string => {
  if (pts.length === 0) return ''
  const [first, ...rest] = pts
  return `M ${fmt(first.x)} ${fmt(first.y)}` + rest.map((p) => ` L ${fmt(p.x)} ${fmt(p.y)}`).join('')
}

export interface DrawingRenderOpts {
  /** Multiply text sizes and stroke widths by this so they stay constant when the group is scaled by 1/textScale. Default 1. */
  textScale?: number
  /** Include the 100 mm scale bar under the bbox. Default true (documentToSvg behaviour). */
  scaleBar?: boolean
}

/** The harness drawing as an SVG fragment in MODEL mm (no wrapper, no translate). */
export function renderDrawingGroup(layout: FbLayout, opts: DrawingRenderOpts = {}): string {
  const ts = opts.textScale ?? 1
  // Round to the printed 2-decimal value first, then scale — so at ts=1 this
  // reproduces the exact literal (byte-identical), and at ts>1 it scales the
  // value actually shown rather than re-rounding raw irrational constants
  // (e.g. LABEL_FONT = 4.2333…) to a different result.
  const f = (mm: number): string => fmt(Number(mm.toFixed(2)) * ts)
  const { minX, maxY } = layout.bbox

  const parts: string[] = []

  // ── Segments (drawn under bodies) ──────────────────────────────────────────
  for (const seg of layout.segments) {
    const ax = fmt(seg.a.x)
    const ay = fmt(seg.a.y)
    const bx = fmt(seg.b.x)
    const by = fmt(seg.b.y)
    const mx = fmt((seg.a.x + seg.b.x) / 2)

    if (seg.bundle) {
      // Grey bundle band — multiple wires share this segment
      parts.push(
        `<path class="segment segment--bundle" d="M ${ax} ${ay} L ${bx} ${by}" stroke="#999" stroke-width="${f(3)}" fill="none" stroke-linecap="round"/>`
      )
      // Wire count label
      parts.push(
        `<text class="segment-label" x="${mx}" y="${fmt((seg.a.y + seg.b.y) / 2 - 1.5 * ts)}" font-size="${f(MIN_FONT)}" text-anchor="middle">${escapeXml(String(seg.wireIds.length))}</text>`
      )
    } else {
      // Single wire — coloured
      const stroke = seg.colour ? strokeForColor(seg.colour) : '#bbb'
      parts.push(
        `<path class="segment" d="M ${ax} ${ay} L ${bx} ${by}" stroke="${stroke}" stroke-width="${f(1)}" fill="none" stroke-linecap="round"/>`
      )
      // Dashed stripe overlays
      if (seg.stripes?.length) {
        for (const stripe of seg.stripes) {
          const sStroke = strokeForColor(stripe)
          parts.push(
            `<path class="segment-stripe" d="M ${ax} ${ay} L ${bx} ${by}" stroke="${sStroke}" stroke-width="${f(1)}" stroke-dasharray="2 2" fill="none"/>`
          )
        }
      }
      // Length label near midpoint (no wire size on the formboard)
      {
        const labelText = lengthLabel(seg.lengthMm)
        if (labelText) {
          // A broken typed length (not to scale along this limb) prints red — a
          // literal, never a theme token (print path).
          const fill = seg.broken ? ' fill="#d32f2f"' : ''
          parts.push(
            `<text class="segment-label" x="${mx}" y="${fmt((seg.a.y + seg.b.y) / 2 - 1 * ts)}" font-size="${f(MIN_FONT)}" text-anchor="middle"${fill}>${escapeXml(labelText)}</text>`
          )
        }
      }
    }
  }

  // ── Bodies: one dot per placed connector / terminal / splice + its label ──
  for (const body of layout.bodies) {
    parts.push(
      `<circle class="body body-${body.kind}" cx="${fmt(body.pos.x)}" cy="${fmt(body.pos.y)}" r="${fmt(BODY_DOT_R)}" fill="#333"/>`
    )
    parts.push(
      `<text class="body-label" x="${fmt(body.labelPos.x)}" y="${fmt(body.labelPos.y + LABEL_FONT * 0.35 * ts)}" font-size="${f(LABEL_FONT)}" font-weight="bold" text-anchor="start">${escapeXml(body.label)}</text>`
    )
  }

  // ── Branch points ──────────────────────────────────────────────────────────
  for (const bp of layout.branchPoints) {
    parts.push(
      `<circle class="branch-point" cx="${fmt(bp.pos.x)}" cy="${fmt(bp.pos.y)}" r="${f(1.8)}" fill="#333"/>`
    )
  }

  // ── Treatments (sleeving + twist) ──────────────────────────────────────────
  for (const t of layout.treatments) {
    const d = pointsToD(t.points)
    if (!d) continue
    if (t.kind === 'sleeving') {
      parts.push(
        `<path class="treatment treatment--sleeving" d="${d}" stroke="#4a90d9" stroke-width="${f(4)}" fill="none" stroke-linecap="round" stroke-opacity="0.45"/>`
      )
    } else {
      parts.push(
        `<path class="treatment treatment--twist" d="${d}" stroke="#e8a020" stroke-width="${f(4)}" fill="none" stroke-linecap="round" stroke-opacity="0.45" stroke-dasharray="3 2"/>`
      )
      if (t.layLengthMm != null) {
        const a = t.points[0]
        const b = t.points[t.points.length - 1]
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        parts.push(
          `<text class="treatment-label" x="${fmt(mx)}" y="${fmt(my - 2 * ts)}" font-size="${f(MIN_FONT)}" text-anchor="middle" fill="#9a6500">lay ${fmt(t.layLengthMm)} mm</text>`
        )
      }
    }
  }

  // ── Labels ─────────────────────────────────────────────────────────────────
  for (const lbl of layout.labels) {
    if (lbl.leader) {
      parts.push(
        `<line class="label-leader" x1="${fmt(lbl.pos.x)}" y1="${fmt(lbl.pos.y)}" x2="${fmt(lbl.leader.x)}" y2="${fmt(lbl.leader.y)}" stroke="#666" stroke-width="${f(0.4)}" stroke-dasharray="1.5 1" fill="none"/>`
      )
      parts.push(`<circle class="label-bead" cx="${fmt(lbl.leader.x)}" cy="${fmt(lbl.leader.y)}" r="${f(0.9)}" fill="#444"/>`)
    }
    parts.push(
      `<text class="label" x="${fmt(lbl.pos.x)}" y="${fmt(lbl.pos.y)}" font-size="${f(MIN_FONT)}" fill="#222">${escapeXml(labelDisplayText(lbl.kind, lbl.text))}</text>`
    )
  }

  // ── Scale bar (100 mm manufacturing check) ─────────────────────────────────
  if (opts.scaleBar !== false) {
    const barY = maxY + 4
    parts.push(
      `<g class="scale-bar">` +
        `<line x1="${fmt(minX)}" y1="${fmt(barY)}" x2="${fmt(minX + 100)}" y2="${fmt(barY)}" stroke="#000" stroke-width="${f(0.5)}"/>` +
        `<line x1="${fmt(minX)}" y1="${fmt(barY - 1.5 * ts)}" x2="${fmt(minX)}" y2="${fmt(barY + 1.5 * ts)}" stroke="#000" stroke-width="${f(0.5)}"/>` +
        `<line x1="${fmt(minX + 100)}" y1="${fmt(barY - 1.5 * ts)}" x2="${fmt(minX + 100)}" y2="${fmt(barY + 1.5 * ts)}" stroke="#000" stroke-width="${f(0.5)}"/>` +
        `<text x="${fmt(minX + 50)}" y="${fmt(barY - 2 * ts)}" font-size="${f(MIN_FONT)}" text-anchor="middle">100 mm — verify at 1:1</text>` +
      `</g>`
    )
  }

  return parts.join('\n')
}

export function documentToSvg(doc: HarnessDocument): string {
  const layout = computeFormboard(doc)
  const { bbox } = layout

  const minX = bbox.minX
  const minY = bbox.minY
  const maxX = bbox.maxX
  const maxY = bbox.maxY

  // Title block constants
  const TB_ROW_H = 5 // height of each key:value row
  const TB_PAD = 2   // inner padding
  const TB_W = 60    // fixed width of the title block
  const titleBlockEntries = doc.drawing.titleBlock
    ? Object.entries(doc.drawing.titleBlock).filter((e): e is [string, string] => typeof e[1] === 'string')
    : []
  const hasTitleBlock = titleBlockEntries.length > 0
  const tbH = hasTitleBlock ? TB_PAD * 2 + titleBlockEntries.length * TB_ROW_H : 0

  const bboxW = maxX - minX
  const bboxH = maxY - minY

  const width = Math.max(bboxW + 2 * MARGIN, 100 + 2 * MARGIN)
  // Base height: content + margin + 8 (scale bar clearance). Extend for title block.
  const heightBase = bboxH + 2 * MARGIN + 8
  const height = hasTitleBlock ? heightBase + tbH + 4 : heightBase
  // Translate so content sits at MARGIN inside a 0-origin viewBox.
  const dx = MARGIN - minX
  const dy = MARGIN - minY

  const drawingBody = renderDrawingGroup(layout)

  const barY = maxY + 4
  const parts: string[] = []

  // ── Title block (bottom-right, on top of everything) ──────────────────────
  if (hasTitleBlock) {
    const tbX = Math.max(minX, maxX - TB_W)
    const tbY = barY + 4
    parts.push(`<g class="title-block">`)
    parts.push(
      `<rect x="${fmt(tbX)}" y="${fmt(tbY)}" width="${TB_W}" height="${fmt(tbH)}" fill="#f9f9f9" stroke="#444" stroke-width="0.4"/>`
    )
    titleBlockEntries.forEach(([key, value], i) => {
      const ry = tbY + TB_PAD + i * TB_ROW_H
      if (i > 0) {
        parts.push(
          `<line x1="${fmt(tbX)}" y1="${fmt(ry - TB_PAD / 2)}" x2="${fmt(tbX + TB_W)}" y2="${fmt(ry - TB_PAD / 2)}" stroke="#ccc" stroke-width="0.3"/>`
        )
      }
      parts.push(
        `<text x="${fmt(tbX + TB_PAD)}" y="${fmt(ry + 3.2)}" font-size="${MIN_FONT}" fill="#666">${escapeXml(key)}:</text>`
      )
      parts.push(
        `<text x="${fmt(tbX + TB_W / 2)}" y="${fmt(ry + 3.2)}" font-size="${MIN_FONT}" fill="#222">${escapeXml(value)}</text>`
      )
    })
    parts.push(`</g>`)
  }

  const body = hasTitleBlock ? drawingBody + '\n' + parts.join('\n') : drawingBody

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}mm" height="${fmt(height)}mm" ` +
    `viewBox="0 0 ${fmt(width)} ${fmt(height)}" font-family="sans-serif">\n` +
    `<g transform="translate(${fmt(dx)} ${fmt(dy)})">\n` +
    body +
    `\n</g>\n</svg>\n`
  )
}
