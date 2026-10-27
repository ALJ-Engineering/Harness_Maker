/**
 * How a part picture is SHOWN — rotation and mirroring — and the one canonical
 * form of it. LAYOUT layer, pure: no geometry, no drawing, no part data.
 *
 * These live in the model rather than beside the code that draws them
 * (`print/picture.ts`, which re-exports them) because three layers need them
 * and only one of those is the renderer: the LOADER (`serialize.ts`) canonises
 * what a file claims, the STORE canonises what an edit produces, and the
 * renderer canonises what it is handed. One definition of "identity", never
 * three — and no model → print import to get at it.
 */
import type { PictureView } from './schema'

/** No rotation, no flip — how a picture draws when the document says nothing. */
export const IDENTITY_VIEW: Readonly<PictureView> = {}

/**
 * The canonical form of a view: rotation wrapped into [0, 360) and every
 * identity key dropped, so `{}` IS the identity and two views are equal exactly
 * when their JSON is. A non-finite rotation is not a rotation — it is dropped
 * rather than propagated into `NaN` geometry.
 */
export function normaliseView(v: PictureView): PictureView {
  const out: PictureView = {}
  const r = v.rotationDeg
  if (typeof r === 'number' && Number.isFinite(r)) {
    const wrapped = ((r % 360) + 360) % 360
    if (wrapped !== 0) out.rotationDeg = wrapped
  }
  if (v.flipH) out.flipH = true
  if (v.flipV) out.flipV = true
  return out
}

/** True when the view draws the photo exactly as it is stored. */
export function isIdentityView(v: PictureView): boolean {
  return Object.keys(normaliseView(v)).length === 0
}
