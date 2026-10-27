import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import type { ConnectorNodeData } from './toFlow'

/**
 * A connector housing. Each cavity is a row with a React Flow handle
 * (id `cav:<cavityId>`) so wires anchor to specific pins, not the housing.
 */
export function ConnectorNode({ data }: NodeProps<Node<ConnectorNodeData>>): React.JSX.Element {
  const handlePosition = data.exitSide === 'left' ? Position.Left : Position.Right
  const exitClass = data.exitSide === 'left' ? ' node--exit-left' : ''
  return (
    <div className={`node node--connector${exitClass}`}>
      <div className="node__title">{data.designator}</div>
      <div className="node__cavities">
        {data.cavities.map((cv) => (
          <div key={cv.id} className={`cavity cavity--${cv.status}`}>
            <span className="cavity__pos">{cv.position}</span>
            <Handle
              id={`cav:${cv.id}`}
              type="source"
              position={handlePosition}
              className="cavity__handle"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
