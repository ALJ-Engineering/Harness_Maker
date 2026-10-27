import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { SpliceNodeData } from './toFlow'

/**
 * A conductor splice — a first-class wire endpoint. A single handle
 * (id `sp:<spliceId>`) accepts any number of wires in Loose connection mode,
 * so the splice's degree is derived from the wires that reference it.
 */
export function SpliceNode({ id, data }: NodeProps<Node<SpliceNodeData>>): React.JSX.Element {
  return (
    <div className="node node--splice">
      <Handle id={`sp:${id}`} type="source" position={Position.Right} />
      <div className="node__title">{data.designator}</div>
      <div className="node__sub">{data.kind}</div>
    </div>
  )
}
