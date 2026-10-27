import type { NodeProps, Node } from '@xyflow/react'
import type { SheetNodeData } from './toFlow'
import { warningsCentre } from '@shared/print/drawingSet'
import { TEMPLATE_MARGIN } from '@shared/print/sheet'
import { TILE_STRIP_H } from '@shared/print/board'

/** Sheet outline colour — quiet enough to read as page furniture. */
const FURNITURE = '#9aa'

/**
 * The page itself: the ONE drawing sheet the 1:1 export prints, and the title
 * block at the bottom-right of its printable area.
 *
 * The node sits at `plan.contentOrigin` (the printable area's top-left), so
 * every coordinate in `data` is node-local mm = flow units (one flow unit is
 * one model mm in the formboard view).
 *
 * Nothing here is interactive: the whole node is `pointer-events: none` (also
 * enforced on React Flow's own wrapper in `index.css`, which sets
 * `pointer-events: all`) so a click always lands on the harness underneath it
 * rather than on the page. The warnings badge is the one exception.
 *
 * The title block SVG is `renderTitleBlock`'s own output — our markup, already
 * wrapped in `<g class="title-block">`, so the group below only positions it.
 */
export function SheetNode({ data }: NodeProps<Node<SheetNodeData>>): React.JSX.Element {
  const { printable, titleBlock, warnings } = data
  const w = printable.w
  const h = printable.h
  // `warningsCentre` only knows the codes it was written for — an unrecognised
  // one would give the badge no tooltip at all, so fall back to the raw codes.
  const centre = warningsCentre(warnings) ?? warnings.join('\n')

  return (
    <div className="node--sheet" style={{ width: w, height: h, pointerEvents: 'none' }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
        {/* The paper edge. The rect below is the PRINTABLE area, which is the
            sheet inset by `TEMPLATE_MARGIN` on all sides and by a further
            `TILE_STRIP_H` at the bottom for the info strip — so the paper is
            that much larger, and the gap between the two rects is the inset
            the builder sees as blank margin. */}
        <rect
          x={-TEMPLATE_MARGIN}
          y={-TEMPLATE_MARGIN}
          width={w + 2 * TEMPLATE_MARGIN}
          height={h + 2 * TEMPLATE_MARGIN + TILE_STRIP_H}
          fill="none"
          stroke={FURNITURE}
          strokeWidth={0.25}
          opacity={0.5}
        />
        {/* The sheet's printable area. */}
        <rect x={0} y={0} width={w} height={h} fill="none" stroke={FURNITURE} strokeWidth={0.4} />
        <g
          transform={`translate(${titleBlock.x} ${titleBlock.y})`}
          dangerouslySetInnerHTML={{ __html: titleBlock.svg }}
        />
      </svg>

      {warnings.length > 0 && (
        <div className="node--sheet-warn" title={centre} style={{ pointerEvents: 'auto' }}>
          {`⚠ ${warnings.length}`}
        </div>
      )}
    </div>
  )
}
