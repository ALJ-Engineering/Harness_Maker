import type { NodeProps, Node } from '@xyflow/react'
import type { TreatmentsNodeData } from './toFlow'

/**
 * Every sleeve and twist on the formboard — bands, sleeve callouts, lay lengths
 * — as ONE node drawing the SAME `renderTreatments` markup the PDF prints. The
 * node sits at the treatments' bounding box and its viewBox starts there, so
 * the markup's model-mm coordinates land where print puts them.
 *
 * Furniture, not harness: never dragged, selected or clicked (`pointer-events:
 * none` lets a click fall through to the segment underneath). Text may run a
 * little past the estimated box, hence `overflow: visible`.
 */
export function TreatmentsNode({ data }: NodeProps<Node<TreatmentsNodeData>>): React.JSX.Element {
  return (
    <svg
      width={data.w}
      height={data.h}
      viewBox={`${data.x} ${data.y} ${data.w} ${data.h}`}
      style={{ display: 'block', overflow: 'visible', pointerEvents: 'none' }}
      dangerouslySetInnerHTML={{ __html: data.svg }}
    />
  )
}
