/**
 * The part-picture block: a framed photo of a body's primary part with its
 * designator captioned underneath. Pure SVG, drawn once and used by BOTH the
 * 1:1 drawing page (`template.ts`) and the formboard canvas node, so what the engineer
 * drags is the markup that prints.
 *
 * The block's SIZE and the `PartImage` type live here rather than in `board.ts`
 * — `board.ts` needs `pictureBlockSize` to plan a rect, so if the constants sat
 * there the two modules would import each other. `board.ts` re-exports
 * `PartImage` / `PartImages` / `PICTURE_W` / `PICTURE_MAX_H` (the same
 * one-definition-two-import-paths pattern it already uses with `template.ts`
 * for `TEMPLATE_GUTTER`), so callers may keep importing them from the planner.
 *
 * The image is never inspected here: `href` is whatever the caller can resolve
 * (`parts-image://…` on the canvas, a `data:` URI in the print window) and
 * `pxW`/`pxH` are only used for the aspect ratio.
 */
import { MIN_FONT } from '../model/anchors'
import type { PictureView } from '../model/schema'
import { IDENTITY_VIEW, isIdentityView, normaliseView } from '../model/pictureView'
import { escapeXml, fitText, fmt, svgText } from './text'

/**
 * The view helpers are DEFINED in `../model/pictureView` — the loader and the
 * store canonise a view too, and a model file must not import the print layer
 * to do it — and re-exported here because every drawing caller already takes
 * everything picture-shaped from this module. One definition, two import paths,
 * the same arrangement as `PICTURE_W` and `board.ts`.
 */
export { IDENTITY_VIEW, isIdentityView, normaliseView } from '../model/pictureView'

/** Printed width of a picture block (mm). Fixed, so a column of them lines up. */
export const PICTURE_W = 30
/**
 * Cap on the IMAGE height (mm). A portrait photo is letterboxed inside the cap
 * by `preserveAspectRatio="xMidYMid meet"` rather than growing the block.
 */
export const PICTURE_MAX_H = 30
/** Inset of the image from the frame (mm). */
export const PICTURE_PAD = 1
/** Height of the caption row under the image (mm). */
export const PICTURE_CAPTION_H = MIN_FONT * 1.6

/** One part photo, ready to reference from SVG. `pxW`/`pxH` give the aspect only. */
export interface PartImage {
  href: string
  pxW: number
  pxH: number
}

/** Part photos by part number — the picture planner's whole input. */
export type PartImages = Record<string, PartImage>

/**
 * Floor on the IMAGE height (mm): the frame's two pads plus a millimetre of
 * picture. `renderPictureBlock` draws the `<image>` at `imgH - 2 * PICTURE_PAD`,
 * so anything under `2 * PICTURE_PAD` emits a NEGATIVE height — invalid SVG,
 * which Chromium drops silently, printing an empty frame. A 1000 × 10 panorama
 * (or a `pxH` of 0 from a header the sizer misread) is exactly that case.
 */
const PICTURE_MIN_IMG_H = 2 * PICTURE_PAD + 1

/**
 * The unrotated aspect (height per unit width) of a photo, floored so a
 * degenerate header (`pxH` 0, negative or NaN) still has a positive height to
 * rotate. The floor is exactly the one `PICTURE_MIN_IMG_H` imposes downstream —
 * at 1:1 a unit height of `PICTURE_MIN_IMG_H / PICTURE_W` scales to the floor —
 * so flooring here changes no upright size, it only keeps the rotated bbox
 * (and therefore the scale that divides by it) away from zero.
 */
const MIN_UNIT_H = PICTURE_MIN_IMG_H / PICTURE_W
/**
 * ...and the same floor on the photo's WIDTH, expressed as a cap on its unit
 * height: at the height cap the drawn photo is `PICTURE_W / ih` wide, so an
 * aspect past this leaves less than `PICTURE_MIN_IMG_H` of width — a sliver, or
 * nothing at all once the pad comes off. A `pxW` of 0 (an unreadable header,
 * which `unitHeight` reads as 1) is exactly that case. Neither clamp changes a
 * real photo: 1:10 is already a pathological portrait.
 */
const MAX_UNIT_H = PICTURE_W / PICTURE_MIN_IMG_H

function unitHeight(image: PartImage): number {
  const pxW = image.pxW > 0 ? image.pxW : 1
  const pxH = image.pxH > 0 ? image.pxH : 0
  return Math.min(MAX_UNIT_H, Math.max(MIN_UNIT_H, pxH / pxW))
}

/**
 * |cos θ| and |sin θ| for θ in DEGREES, EXACT on the quarter turns — `Math.sin`
 * of `Math.PI` is 1.2e-16, not 0, which would make a half turn size a block
 * 4e-15 mm taller than no turn at all. The quarter turns are the rotations the
 * menu actually applies, so they must round-trip to the identical rect.
 */
function absTrig(deg: number): { cos: number; sin: number } {
  const r = ((deg % 360) + 360) % 360
  if (r % 90 === 0) return r % 180 === 0 ? { cos: 1, sin: 0 } : { cos: 0, sin: 1 }
  const th = (r * Math.PI) / 180
  return { cos: Math.abs(Math.cos(th)), sin: Math.abs(Math.sin(th)) }
}

/**
 * Block size (mm) for one image under one view: fixed width, an image height
 * derived from the ROTATED bounding box, and the caption row.
 *
 * The block width is fixed, so what a rotation changes is the height: a 2:1
 * photo 15 mm tall stands 30 mm tall on its side. The photo is scaled so its
 * rotated bbox fits the 30 mm width, then shrunk again if that would push the
 * bbox past `PICTURE_MAX_H` — the same two rules as upright, applied to the
 * bbox instead of the photo. `iw`/`ih` are the photo's OWN drawn size (before
 * rotation), which is what `renderPictureBlock` needs; they are not the block.
 */
export function pictureBlockSize(
  image: PartImage,
  view: PictureView = IDENTITY_VIEW
): { w: number; h: number; imgH: number; iw: number; ih: number } {
  const ih0 = unitHeight(image)
  // Canonised here as well as at every boundary: a stray NaN angle from a
  // hand-edited file would otherwise become NaN block dimensions.
  const { cos, sin } = absTrig(normaliseView(view).rotationDeg ?? 0)
  // Bounding box of the unit photo (width 1, height ih0) turned by θ.
  const bw = cos + ih0 * sin
  const bh = sin + ih0 * cos
  let s = PICTURE_W / bw
  if (s * bh > PICTURE_MAX_H) s = PICTURE_MAX_H / bh
  const imgH = Math.max(PICTURE_MIN_IMG_H, s * bh)
  return { w: PICTURE_W, imgH, h: imgH + PICTURE_CAPTION_H, iw: s, ih: s * ih0 }
}

/**
 * The block at the local origin: frame, photo, caption. `size` is
 * `pictureBlockSize` for the SAME view the planner sized the rect with, so the
 * drawn block is exactly the rect that was reserved. The caption is
 * `fitText`-clipped — a free terminal's label can be far wider than 30 mm and
 * must not run out over the drawing.
 *
 * An identity view draws the photo straight into the frame's inner rect, byte
 * for byte what this module has always emitted. A rotated or flipped one wraps
 * it in ONE transform group centred on the image area.
 */
export function renderPictureBlock(
  size: { w: number; h: number; imgH: number; iw: number; ih: number },
  image: PartImage,
  caption: string,
  view: PictureView = IDENTITY_VIEW
): string {
  const { w, h, imgH, iw, ih } = size
  const inner = w - 2 * PICTURE_PAD
  const v = normaliseView(view)
  const href = escapeXml(image.href)
  const photo = isIdentityView(v)
    ? `<image href="${href}" x="${fmt(PICTURE_PAD)}" y="${fmt(PICTURE_PAD)}" ` +
      `width="${fmt(inner)}" height="${fmt(imgH - 2 * PICTURE_PAD)}" preserveAspectRatio="xMidYMid meet"/>`
    : rotatedPhoto(href, w, imgH, iw, ih, v)
  return (
    `<g class="picture-block">` +
    `<rect x="0" y="0" width="${fmt(w)}" height="${fmt(h)}" fill="#fff" stroke="#444" stroke-width="0.3"/>` +
    photo +
    svgText(w / 2, imgH + PICTURE_CAPTION_H * 0.7, fitText(caption, MIN_FONT, inner), {
      size: MIN_FONT,
      anchor: 'middle'
    }) +
    `</g>`
  )
}

/** The photo under a non-identity view, centred on the frame's image area. */
function rotatedPhoto(href: string, w: number, imgH: number, iw: number, ih: number, v: PictureView): string {
  // The pad is taken off the FRAME, not off the photo: the photo's box is
  // shrunk until its ROTATED bounding box fits inside the frame's inner rect,
  // which is the same rule the identity path follows (draw into `w - 2p` by
  // `imgH - 2p`). Insetting the photo's own width and height instead cost a
  // height-capped portrait ~7 % of its size the moment it was flipped, since
  // such a photo is much narrower than its frame and paid the width pad twice.
  const { cos, sin } = absTrig(v.rotationDeg ?? 0)
  const bboxW = cos * iw + sin * ih
  const bboxH = sin * iw + cos * ih
  const k = Math.min((w - 2 * PICTURE_PAD) / Math.max(bboxW, EPS), (imgH - 2 * PICTURE_PAD) / Math.max(bboxH, EPS))
  const dw = Math.max(0, iw * k)
  const dh = Math.max(0, ih * k)
  const sx = v.flipH ? -1 : 1
  const sy = v.flipV ? -1 : 1
  // SVG applies a transform list RIGHT TO LEFT, so this scales in the PHOTO's
  // own axes first and then turns the result: `flipH` on a photo already
  // standing on its side reads as a vertical mirror on screen. The panel
  // thumbnail's CSS `rotate(...) scale(...)` composes the same way, which is
  // what keeps the two pictures agreeing.
  return (
    `<g transform="translate(${fmt(w / 2)} ${fmt(imgH / 2)}) rotate(${fmt(v.rotationDeg ?? 0)}) scale(${fmt(sx)} ${fmt(sy)})">` +
    `<image href="${href}" x="${fmt(-dw / 2)}" y="${fmt(-dh / 2)}" ` +
    `width="${fmt(dw)}" height="${fmt(dh)}" preserveAspectRatio="xMidYMid meet"/>` +
    `</g>`
  )
}

/** Guards the bbox divisions above; no real photo box is anywhere near this small. */
const EPS = 1e-9
