import { describe, it, expect } from 'vitest'
import {
  pictureBlockSize,
  renderPictureBlock,
  normaliseView,
  isIdentityView,
  IDENTITY_VIEW,
  PICTURE_CAPTION_H,
  PICTURE_PAD,
  PICTURE_W,
  PICTURE_MAX_H
} from './picture'

describe('picture block', () => {
  it('sizes a square image to PICTURE_W × PICTURE_W + caption', () => {
    const s = pictureBlockSize({ href: 'x', pxW: 400, pxH: 400 })
    expect(s.w).toBe(PICTURE_W)
    expect(s.imgH).toBe(PICTURE_W)
    expect(s.h).toBe(PICTURE_W + PICTURE_CAPTION_H)
  })

  it('a wide image is shorter; a tall image is capped at PICTURE_MAX_H', () => {
    expect(pictureBlockSize({ href: 'x', pxW: 600, pxH: 300 }).imgH).toBe(15)
    expect(pictureBlockSize({ href: 'x', pxW: 300, pxH: 900 }).imgH).toBe(PICTURE_MAX_H)
  })

  it('floors a panorama so the <image> height never goes negative (M6)', () => {
    // 1000 × 10 gives an aspect height of 0.3 mm; the drawn image is
    // imgH − 2 × PICTURE_PAD, i.e. −1.7 mm — invalid SVG that Chromium drops.
    const s = pictureBlockSize({ href: 'x', pxW: 1000, pxH: 10 })
    expect(s.imgH).toBe(2 * PICTURE_PAD + 1)
    expect(s.h).toBe(s.imgH + PICTURE_CAPTION_H)
    const drawn = renderPictureBlock(s, { href: 'x', pxW: 1000, pxH: 10 }, 'C1')
    expect(drawn).toContain('height="1"') // the image rect, 1 mm, not −1.7
    expect(drawn).not.toMatch(/height="-/)
  })

  it('a non-positive pxH falls back to the floor, not to a zero-height frame (M6)', () => {
    for (const pxH of [0, -5, Number.NaN]) {
      const s = pictureBlockSize({ href: 'x', pxW: 1000, pxH })
      expect(s.imgH).toBe(2 * PICTURE_PAD + 1)
      expect(s.imgH - 2 * PICTURE_PAD).toBeGreaterThan(0)
    }
  })

  it('renders an <image> with meet aspect and an escaped caption', () => {
    const img = { href: 'parts-image://img/A%26B', pxW: 1, pxH: 1 }
    const svg = renderPictureBlock(pictureBlockSize(img), img, 'C1 & co')
    expect(svg).toContain('<image href="parts-image://img/A%26B"')
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"')
    expect(svg).toContain('C1 &amp; co')
  })

  it('clips a caption too wide for the frame rather than overflowing it', () => {
    const sq = { href: 'x', pxW: 1, pxH: 1 }
    const svg = renderPictureBlock(pictureBlockSize(sq), sq, 'ring → a very long stud name indeed')
    expect(svg).toContain('…</text>')
    expect(svg).not.toContain('indeed')
  })
})

describe('picture view (rotate + flip)', () => {
  it('normalises rotation into [0, 360) and drops identity keys', () => {
    expect(normaliseView({ rotationDeg: 450 })).toEqual({ rotationDeg: 90 })
    expect(normaliseView({ rotationDeg: -90 })).toEqual({ rotationDeg: 270 })
    expect(normaliseView({ rotationDeg: 720 })).toEqual({})
    expect(normaliseView({ rotationDeg: 0, flipH: false, flipV: false })).toEqual({})
    expect(normaliseView({ flipH: true })).toEqual({ flipH: true })
    expect(normaliseView({ rotationDeg: Number.NaN })).toEqual({})
    expect(normaliseView({ rotationDeg: Number.POSITIVE_INFINITY })).toEqual({})
  })

  it('isIdentityView is true for exactly the views that draw unchanged', () => {
    expect(isIdentityView(IDENTITY_VIEW)).toBe(true)
    expect(isIdentityView({ rotationDeg: 360, flipV: false })).toBe(true)
    expect(isIdentityView({ rotationDeg: 90 })).toBe(false)
    expect(isIdentityView({ flipV: true })).toBe(false)
  })

  it('a quarter turn swaps the aspect: the 2:1 photo that was 15 mm tall fills the 30 mm cap', () => {
    const img = { href: 'x', pxW: 600, pxH: 300 }
    expect(pictureBlockSize(img).imgH).toBe(15)
    const r = pictureBlockSize(img, { rotationDeg: 90 })
    // Upright the photo is 30 × 15; on its side its bbox is 15 wide × 30 tall,
    // which hits PICTURE_MAX_H, so the drawn photo keeps its 30 × 15 own size
    // and the block grows to the full cap.
    expect(r.w).toBe(PICTURE_W)
    expect(r.imgH).toBe(PICTURE_MAX_H)
    expect(r.h).toBe(PICTURE_MAX_H + PICTURE_CAPTION_H)
    expect(r.iw).toBe(30)
    expect(r.ih).toBe(15)
  })

  it('a half turn is the same size as no turn at all', () => {
    const img = { href: 'x', pxW: 600, pxH: 300 }
    expect(pictureBlockSize(img, { rotationDeg: 180 })).toEqual(pictureBlockSize(img))
  })

  it('a square on the diagonal shrinks to fit the 30 mm frame', () => {
    const img = { href: 'x', pxW: 400, pxH: 400 }
    const r = pictureBlockSize(img, { rotationDeg: 45 })
    // bbox side = (|cos45| + |sin45|) × iw = √2 × iw = 30 ⇒ iw = 30/√2.
    expect(r.iw).toBeCloseTo(30 / Math.SQRT2, 9)
    expect(r.ih).toBeCloseTo(30 / Math.SQRT2, 9)
    expect(r.imgH).toBeCloseTo(30, 9)
  })

  it('flips never change the size', () => {
    const img = { href: 'x', pxW: 600, pxH: 300 }
    for (const v of [{ flipH: true }, { flipV: true }, { rotationDeg: 90, flipH: true, flipV: true }]) {
      const { flipH: _h, flipV: _v, ...rot } = v as { rotationDeg?: number; flipH?: boolean; flipV?: boolean }
      expect(pictureBlockSize(img, v)).toEqual(pictureBlockSize(img, rot))
    }
  })

  it('a degenerate image survives a quarter turn with no negative, zero or infinite size', () => {
    const bad = [0, -5, Number.NaN]
    const cases = [
      ...bad.map((pxH) => ({ pxW: 1000, pxH })),
      ...bad.map((pxW) => ({ pxW, pxH: 400 })),
      { pxW: 0, pxH: 0 }
    ]
    for (const { pxW, pxH } of cases) {
      const img = { href: 'x', pxW, pxH }
      const r = pictureBlockSize(img, { rotationDeg: 90 })
      for (const n of [r.w, r.h, r.imgH, r.iw, r.ih]) expect(Number.isFinite(n)).toBe(true)
      expect(r.iw).toBeGreaterThan(0)
      expect(r.ih).toBeGreaterThan(0)
      const svg = renderPictureBlock(r, img, 'C1', { rotationDeg: 90 })
      expect(svg).not.toMatch(/(width|height)="-/)
      // Nothing collapses to an invisible sliver either: a photo whose aspect
      // is missing or absurd still gets a millimetre of picture in both axes.
      const m = /<image [^>]*width="([\d.-]+)" height="([\d.-]+)"/.exec(svg)!
      expect(Number(m[1])).toBeGreaterThanOrEqual(1)
      expect(Number(m[2])).toBeGreaterThanOrEqual(1)
    }
  })

  it('a flip or a half turn paints the photo at exactly the size the identity view does', () => {
    // A height-capped portrait: the photo does not fill its frame's width, so
    // taking the pad off the PHOTO instead of the frame shrank it (~7 %).
    const img = { href: 'x', pxW: 300, pxH: 600 }
    /** The `<image>` box, and the photo painted inside it by `xMidYMid meet`. */
    const painted = (view: { rotationDeg?: number; flipH?: boolean }): { w: number; h: number } => {
      const svg = renderPictureBlock(pictureBlockSize(img, view), img, 'C1', view)
      const m = /<image [^>]*width="([\d.-]+)" height="([\d.-]+)"/.exec(svg)!
      const k = Math.min(Number(m[1]) / img.pxW, Number(m[2]) / img.pxH)
      return { w: k * img.pxW, h: k * img.pxH }
    }
    const upright = painted({})
    // The frame is 30 wide with a 30 mm cap on the image; a 1:2 photo inset by
    // one pad all round paints 14 × 28.
    expect(upright).toEqual({ w: 14, h: 28 })
    expect(painted({ flipH: true })).toEqual(upright)
    expect(painted({ rotationDeg: 180 })).toEqual(upright)
  })

  it('normalises the view it is handed, so a nonsense angle cannot become NaN geometry', () => {
    const img = { href: 'x', pxW: 400, pxH: 300 }
    expect(pictureBlockSize(img, { rotationDeg: Number.NaN })).toEqual(pictureBlockSize(img))
    expect(pictureBlockSize(img, { rotationDeg: 450 })).toEqual(pictureBlockSize(img, { rotationDeg: 90 }))
  })

  it('the identity view draws the block it always drew — no transform group', () => {
    const img = { href: 'x', pxW: 400, pxH: 300 }
    const s = pictureBlockSize(img)
    const plain = renderPictureBlock(s, img, 'C1')
    expect(plain).toBe(renderPictureBlock(s, img, 'C1', { rotationDeg: 720, flipH: false }))
    expect(plain).not.toContain('rotate(')
    expect(plain).toContain(`<image href="x" x="${PICTURE_PAD}" y="${PICTURE_PAD}"`)
  })

  it('a rotated + flipped view draws the photo in a centred transform group', () => {
    const img = { href: 'x', pxW: 600, pxH: 300 }
    const view = { rotationDeg: 90, flipH: true }
    const s = pictureBlockSize(img, view)
    const svg = renderPictureBlock(s, img, 'C1', view)
    // Centre of the frame's image area, then rotate, then mirror in x.
    expect(svg).toContain(`<g transform="translate(15 ${s.imgH / 2}) rotate(90) scale(-1 1)">`)
    // On its side the photo's 30 × 15 box stands 15 wide × 30 tall, so the pad
    // binds on the frame's HEIGHT: 28/30 of the box, i.e. 28 × 14, centred on
    // the origin. (The pad comes off the frame, not off the photo — insetting
    // the photo's own axes would have cost it a further millimetre each way.)
    const k = (30 - 2 * PICTURE_PAD) / 30
    expect(svg).toContain(
      `<image href="x" x="${(-30 * k) / 2}" y="${(-15 * k) / 2}" width="${30 * k}" height="${15 * k}" preserveAspectRatio="xMidYMid meet"/>`
    )
  })

  it('a flip alone still mirrors — scale(-1 1) with no rotation', () => {
    const img = { href: 'x', pxW: 400, pxH: 400 }
    const svg = renderPictureBlock(pictureBlockSize(img, { flipV: true }), img, 'C1', { flipV: true })
    expect(svg).toContain('rotate(0) scale(1 -1)')
  })
})
