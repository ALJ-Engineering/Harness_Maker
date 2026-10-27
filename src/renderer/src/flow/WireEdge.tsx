import { EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { screenStroke } from './screenColors'
import { runLabel } from '@shared/model/formboard'
import { currentTheme, type ThemeName } from '../useTheme'

export interface WireEdgeData extends Record<string, unknown> {
  base: string
  stripes?: string[]
  gauge?: string
  highlighted?: boolean
  /**
   * The theme this edge was projected for. React Flow re-renders an edge on a
   * DATA change, not when `<html data-theme>` flips, so the toggle only
   * repaints the wires because `toFlow` puts the theme here. The
   * `currentTheme()` fallback covers callers that project without one.
   */
  theme?: ThemeName
}

/**
 * Wire edge that renders the conductor's base colour plus a dashed overlay per
 * stripe colour (the base shows through the gaps — the usual candy-stripe look).
 * Selection thickens the line; the gauge label is drawn at the midpoint.
 */
export function WireEdge(props: EdgeProps): React.JSX.Element {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } =
    props
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  })

  const d = (data ?? { base: 'GY' }) as WireEdgeData
  const width = selected ? 4 : 2
  const stripes = d.stripes ?? []
  const theme = d.theme ?? currentTheme()

  return (
    <>
      {d.highlighted && (
        <path
          d={path}
          style={{ stroke: '#fb8c00', strokeWidth: width + 6, fill: 'none', opacity: 0.4 }}
        />
      )}
      {/* Base conductor colour. Keeps the react-flow class so selection halo
          + hover CSS still apply. */}
      <path
        className="react-flow__edge-path"
        d={path}
        style={{ stroke: screenStroke(d.base, theme), strokeWidth: width, fill: 'none' }}
      />
      {stripes.map((s, i) => (
        <path
          key={`${s}-${i}`}
          d={path}
          style={{
            stroke: screenStroke(s, theme),
            strokeWidth: width,
            fill: 'none',
            strokeDasharray: '7 7',
            strokeDashoffset: i * 7
          }}
        />
      ))}
      {(() => {
        const labelText = runLabel(d.gauge, null)
        return labelText ? (
          <EdgeLabelRenderer>
            <div
              className={`wire-label${selected ? ' wire-label--sel' : ''}`}
              style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            >
              {labelText}
            </div>
          </EdgeLabelRenderer>
        ) : null
      })()}
    </>
  )
}
