import type { PictureView } from '@shared/model/schema'
import { Field, NumberEdit } from './fields'

/**
 * The *Picture* row shared by the connector / free-terminal / splice editors.
 *
 * A picture belongs to a PART, not to this body, so the row is only meaningful
 * once the part-number field above it is filled in — hence the two guard
 * states: no library folder yet (offer the chooser) and no part number yet
 * (say so). *Remove* deletes the shared library file, so it confirms first and
 * names what else it affects.
 *
 * Under it sit the ORIENTATION controls — the same rotation and flips the
 * formboard's right-click menu applies, per document and per body, so the panel
 * can dial an exact angle the menu's fixed steps cannot reach. They appear only
 * once there is a picture to turn.
 *
 * Presentational: every action is a callback, and `image.href` is whatever the
 * caller can resolve (`parts-image://…` in the app).
 */
export function PictureRow({
  partNumber,
  image,
  dir,
  onChoose,
  onRemove,
  onChooseDir,
  view,
  onRotation,
  onFlip
}: {
  partNumber?: string
  image?: { href: string }
  dir: string | null
  onChoose: () => void
  onRemove: () => void
  onChooseDir: () => void
  /** How this document shows the photo; absent (or `{}`) means upright and unmirrored. */
  view?: PictureView
  onRotation?: (deg: number) => void
  onFlip?: (axis: 'h' | 'v') => void
}): React.JSX.Element {
  const rot = view?.rotationDeg ?? 0
  const flipH = view?.flipH ?? false
  const flipV = view?.flipV ?? false
  const orientation = dir && partNumber && image && (onRotation || onFlip)
  return (
    <>
      <Field label="Picture">
        {!dir ? (
          <button className="panel__add" onClick={onChooseDir}>
            Set the parts library folder…
          </button>
        ) : !partNumber ? (
          <span className="panel__hint">set a part number first</span>
        ) : (
          <div className="picture-row">
            {image ? (
              <img
                className="picture-row__thumb"
                src={image.href}
                alt=""
                // CSS transforms apply RIGHT TO LEFT, so this reads "mirror, then
                // turn" — the same order as the SVG's `rotate(θ) scale(sx sy)`,
                // which is what keeps the thumbnail and the printed block agreeing.
                style={{ transform: `rotate(${rot}deg) scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})` }}
              />
            ) : (
              <span className="panel__hint">no picture</span>
            )}
            <button className="panel__add" onClick={onChoose}>
              Choose…
            </button>
            {image && (
              <button
                className="panel__add"
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove the picture for ${partNumber} from the library? Every document using this part loses it.`
                    )
                  )
                    onRemove()
                }}
              >
                Remove
              </button>
            )}
          </div>
        )}
      </Field>
      {/* Siblings, not children: `Field` is a <label>, and a nested one would
          make a click on the rotation box focus the picture row instead. */}
      {orientation && (
        <>
          <Field label="Rotation (°)">
            {/* No min/max: `NumberEdit` REVERTS an out-of-range entry, so a
                bounded field would silently swallow 360 or −45. The store
                normalises whatever is committed into [0, 360) instead, and the
                field re-reads the normalised value. */}
            <NumberEdit value={rot} step={15} onCommit={(v) => onRotation?.(v ?? 0)} />
          </Field>
          <Field label="Flip">
            <div className="picture-row">
              <button
                className={`panel__add picture-row__toggle${flipH ? ' is-on' : ''}`}
                onClick={() => onFlip?.('h')}
              >
                Flip H
              </button>
              <button
                className={`panel__add picture-row__toggle${flipV ? ' is-on' : ''}`}
                onClick={() => onFlip?.('v')}
              >
                Flip V
              </button>
            </div>
          </Field>
        </>
      )}
    </>
  )
}
