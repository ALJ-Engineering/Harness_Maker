import type { NodeProps, Node } from '@xyflow/react'
import type { TerminalNodeData } from './toFlow'
import { FourSideHandles } from './SideHandles'

/**
 * A free terminal (ring lug, ferrule, …) not housed in a connector. It is one
 * electrical point taking any number of wires (a ring on a stud often carries
 * several), with a handle on each side so every wire meets it on the side
 * facing its other end (`FourSideHandles`).
 */
export function FreeTerminalNode({
  id,
  data
}: NodeProps<Node<TerminalNodeData>>): React.JSX.Element {
  return (
    <div className="node node--terminal">
      <FourSideHandles endpoint={{ type: 'freeTerminal', terminalId: id }} used={data.sides} />
      <div className="node__title">{data.designator}</div>
      <div className="node__sub">{data.landsOn ? `${data.kind} · ${data.landsOn}` : data.kind}</div>
    </div>
  )
}
