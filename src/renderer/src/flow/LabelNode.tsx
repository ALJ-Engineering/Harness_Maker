import type { NodeProps, Node } from '@xyflow/react'
import type { LabelNodeData } from './toFlow'

/**
 * A harness label on the formboard, drawn as a small WHITE dot the size of a
 * branch point, positioned ON its wire (anchored labels ride the segment). The
 * kind + text ("Heatshrink print: CAN H") show in the properties panel and the
 * 1:1 SVG export — the canvas dot is just a draggable marker; the full text is
 * its tooltip.
 */
export function LabelNode({ data, selected }: NodeProps<Node<LabelNodeData>>): React.JSX.Element {
  const cls =
    'node--label' +
    (selected ? ' node--label-sel' : '') +
    (data.highlighted ? ' node--label-hl' : '')
  return <div className={cls} title={data.display} />
}
