import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { BranchNodeData } from './toFlow'

/** A routing vertex: bend (degree 2) or Y-split (degree >=3). Degree is derived. */
export function BranchNode({ id, data }: NodeProps<Node<BranchNodeData>>): React.JSX.Element {
  // The visible dot is the `.node--branch` div (6×6, the same size as a body dot, centred on the node). The
  // handles are tiny, transparent anchor points centred by LAYOUT (not transform):
  // React Flow measures a handle's connection point from its layout box, and CSS
  // `transform` does NOT move that measured point — so a transform-centred handle
  // still anchored edges off-centre. A 1×1 box at left/top 50% (right/bottom auto to
  // cancel Position.Right's right:0) sits at the node centre by layout. Stacked
  // source+target share the id so segment edges connect from either direction.
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
      className={`node node--branch${data.highlighted ? ' node--branch-hl' : ''}`}
      title="branch point"
    >
      <Handle id={`br:${id}`} type="source" position={Position.Right} style={anchor} />
      <Handle id={`br:${id}`} type="target" position={Position.Right} style={anchor} />
    </div>
  )
}
