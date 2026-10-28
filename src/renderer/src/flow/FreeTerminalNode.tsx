import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { TerminalNodeData } from './toFlow'

/**
 * A free terminal (ring lug, ferrule, …) not housed in a connector. Its one
 * handle takes any number of wires (a ring on a stud often carries several).
 * It is a `source` like every schematic wire end: React Flow draws an edge only
 * from a source handle, and a wire's first end may be this terminal
 * (ring-to-ring, `wire from: T1`) — see `handles.test.ts`.
 */
export function FreeTerminalNode({
  id,
  data
}: NodeProps<Node<TerminalNodeData>>): React.JSX.Element {
  return (
    <div className="node node--terminal">
      <Handle id={`ft:${id}`} type="source" position={Position.Left} />
      <div className="node__title">{data.designator}</div>
      <div className="node__sub">{data.landsOn ? `${data.kind} · ${data.landsOn}` : data.kind}</div>
    </div>
  )
}
