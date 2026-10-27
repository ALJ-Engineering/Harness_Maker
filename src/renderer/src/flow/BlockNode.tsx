import type { NodeProps, Node } from '@xyflow/react'
import type { BlockNodeData } from './toFlow'

/**
 * A pinout table or the BOM summary block, drawn on the formboard canvas with
 * the SAME `renderTable` markup the PDF prints — the projection hands us the
 * exact SVG string `template.ts` puts on the drawing page, so the canvas and the page
 * are the same pixels (spec §5, "what you see is what prints").
 *
 * One flow unit is one model mm in this view, so `data.w`/`data.h` (plan mm)
 * are used verbatim as both the element size and the SVG viewBox.
 *
 * The markup is ours (built by `renderTable` from document data, escaped
 * there), never user-supplied HTML — hence `dangerouslySetInnerHTML`, which is
 * the only way to hand a pre-rendered SVG string to React.
 *
 * Dragging one pins it: `commitDrag` writes `drawing.blocks` and the planner
 * then leaves it alone. `pinned` is a display state only — the store owns it.
 */
export function BlockNode({ data, selected }: NodeProps<Node<BlockNodeData>>): React.JSX.Element {
  return (
    <div
      className={`node--block${data.pinned ? ' node--block-pinned' : ''}${selected ? ' node--block-selected' : ''}`}
      style={{ width: data.w, height: data.h }}
      title={data.pinned ? 'Pinned — right-click to reset' : 'Auto-placed — drag to pin'}
    >
      <svg
        width={data.w}
        height={data.h}
        viewBox={`0 0 ${data.w} ${data.h}`}
        style={{ display: 'block' }}
        dangerouslySetInnerHTML={{ __html: data.svg }}
      />
    </div>
  )
}
