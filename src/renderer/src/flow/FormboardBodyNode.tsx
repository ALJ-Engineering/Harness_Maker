import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { FormboardBodyData } from './toFlow'

// Label offset from the DISC CENTRE, in screen units. Deliberately NOT
// `BODY_LABEL_OFFSET`: that offset is print-scale, sized off the 3.6 mm printed
// dot, while the on-screen dot is a 6-unit disc (`SCREEN_DOT`) — reusing it
// would drop the text on top of the dot. Same shape as print (right of,
// slightly above); scaled to the screen glyph.
const SCREEN_DOT = 6
const SCREEN_LABEL_DX = SCREEN_DOT / 2 + 3
const SCREEN_LABEL_DY = -3.5

/**
 * A formboard body — connector, free terminal or splice — drawn as ONE dot
 * (the printed glyph is `BODY_DOT_R`; on screen a 6×6 disc, `.node--fb-dot`,
 * the same size as a branch point) with a single centred handle whose id is the
 * route-node key `n:<refId>`. The label is a non-interactive sibling so the
 * drag target stays the dot.
 */
export function FormboardBodyNode({
  data,
  selected
}: NodeProps<Node<FormboardBodyData>>): React.JSX.Element {
  // Tiny transparent anchors centred by LAYOUT, not transform: React Flow
  // measures a handle's connection point from its layout box (see BranchNode).
  const anchor = {
    width: 1,
    height: 1,
    minWidth: 0,
    minHeight: 0,
    background: 'transparent',
    border: 'none',
    left: '50%',
    top: '50%',
    right: 'auto' as const,
    bottom: 'auto' as const,
    transform: 'translate(-50%,-50%)'
  }
  return (
    <div
      className={`node node--fb-dot node--fb-dot-${data.kind}${data.highlighted ? ' node--branch-hl' : ''}${selected ? ' node--fb-dot-selected' : ''}`}
      title={data.label}
    >
      <Handle id={data.handleId} type="source" position={Position.Right} style={anchor} />
      <Handle id={data.handleId} type="target" position={Position.Right} style={anchor} />
      <div
        className="node--fb-dot__label"
        style={{ left: SCREEN_DOT / 2 + SCREEN_LABEL_DX, top: SCREEN_DOT / 2 + SCREEN_LABEL_DY }}
      >
        {data.label}
      </div>
    </div>
  )
}
