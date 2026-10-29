import type { NodeProps, Node } from '@xyflow/react'
import type { SpliceNodeData } from './toFlow'
import { FourSideHandles } from './SideHandles'

/**
 * A conductor splice — a first-class wire endpoint taking any number of wires
 * in Loose connection mode, so its degree is derived from the wires that
 * reference it. A handle on each side, like a free terminal's.
 */
export function SpliceNode({ id, data }: NodeProps<Node<SpliceNodeData>>): React.JSX.Element {
  return (
    <div className="node node--splice">
      <FourSideHandles endpoint={{ type: 'splice', spliceId: id }} used={data.sides} />
      <div className="node__title">{data.designator}</div>
      <div className="node__sub">{data.kind}</div>
    </div>
  )
}
