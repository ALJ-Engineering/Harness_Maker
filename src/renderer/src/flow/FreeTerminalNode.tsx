import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { TerminalNodeData } from './toFlow'

/** A free terminal (ring lug, ferrule, …) not housed in a connector. */
export function FreeTerminalNode({
  id,
  data
}: NodeProps<Node<TerminalNodeData>>): React.JSX.Element {
  return (
    <div className="node node--terminal">
      <Handle id={`ft:${id}`} type="target" position={Position.Left} />
      <div className="node__title">{data.designator}</div>
      <div className="node__sub">{data.landsOn ? `${data.kind} · ${data.landsOn}` : data.kind}</div>
    </div>
  )
}
