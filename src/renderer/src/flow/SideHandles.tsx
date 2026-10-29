import { Handle, Position } from '@xyflow/react'
import { sideHandleId, type HandleSide } from '@shared/model/endpoints'
import type { Endpoint } from '@shared/model/schema'

const SIDES: [HandleSide, Position][] = [
  ['left', Position.Left],
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom]
]

/**
 * A handle on every side of a one-point body (a free terminal, a splice). All
 * four are the same endpoint; the projection gives each wire the side facing
 * its other end (`wireSides.ts`), and a new wire can start from any of them.
 * Each is a `source`, like every schematic wire end (see `handles.test.ts`).
 *
 * `used` are the sides wires meet it on. The others are `handle--spare`:
 * hidden until the body is hovered, so a terminal shows a dot only where a
 * wire is — or on its left while it has none, as before.
 */
export function FourSideHandles({ endpoint, used }: { endpoint: Endpoint; used?: HandleSide[] }): React.JSX.Element {
  const shown = used?.length ? used : ['left']
  return (
    <>
      {SIDES.map(([side, position]) => (
        <Handle
          key={side}
          id={sideHandleId(endpoint, side)}
          type="source"
          position={position}
          className={shown.includes(side) ? undefined : 'handle--spare'}
        />
      ))}
    </>
  )
}
