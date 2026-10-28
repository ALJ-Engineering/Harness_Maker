import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { endpointHandleId, sideHandleId } from '@shared/model/endpoints'
import type { ConnectorNodeData } from './toFlow'

/**
 * A connector housing. Each cavity is a row with a React Flow handle
 * (id `cav:<cavityId>`) so wires anchor to specific pins, not the housing —
 * on the exit side, or with `'nearest'` one on each side of the row
 * (`cav:<cavityId>|left` / `|right`), for the projection to pick per wire.
 */
export function ConnectorNode({ data }: NodeProps<Node<ConnectorNodeData>>): React.JSX.Element {
  const both = data.exitSide === 'nearest'
  const handlePosition = data.exitSide === 'left' ? Position.Left : Position.Right
  const exitClass = both ? ' node--exit-both' : data.exitSide === 'left' ? ' node--exit-left' : ''
  return (
    <div className={`node node--connector${exitClass}`}>
      <div className="node__title">{data.designator}</div>
      <div className="node__cavities">
        {data.cavities.map((cv) => (
          <div key={cv.id} className={`cavity cavity--${cv.status}`}>
            <span className="cavity__pos">{cv.position}</span>
            {both ? (
              <>
                <Handle
                  id={sideHandleId({ type: 'cavity', cavityId: cv.id }, 'left')}
                  type="source"
                  position={Position.Left}
                  className="cavity__handle"
                />
                <Handle
                  id={sideHandleId({ type: 'cavity', cavityId: cv.id }, 'right')}
                  type="source"
                  position={Position.Right}
                  className="cavity__handle"
                />
              </>
            ) : (
              <Handle
                id={endpointHandleId({ type: 'cavity', cavityId: cv.id })}
                type="source"
                position={handlePosition}
                className="cavity__handle"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
