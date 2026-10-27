import { describe, it, expect } from 'vitest'
import { imageSize } from './imageSize'

const png = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const v = new DataView(b.buffer)
  v.setUint32(16, w)
  v.setUint32(20, h)
  return b
}

/** FFD8, an APP0 segment, then SOF0 with h/w. */
const jpeg = (w: number, h: number, sof = 0xc0): Uint8Array => {
  const b = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, sof, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03
  ])
  const v = new DataView(b.buffer)
  v.setUint16(13, h)
  v.setUint16(15, w)
  return b
}

describe('imageSize', () => {
  it('reads PNG IHDR', () => expect(imageSize(png(640, 480))).toEqual({ type: 'png', w: 640, h: 480 }))

  it('reads baseline and progressive JPEG SOF', () => {
    expect(imageSize(jpeg(800, 600))).toEqual({ type: 'jpeg', w: 800, h: 600 })
    expect(imageSize(jpeg(800, 600, 0xc2))).toEqual({ type: 'jpeg', w: 800, h: 600 })
  })

  it('returns null for non-images and truncated files', () => {
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(imageSize(new TextEncoder().encode('<svg/>'))).toBeNull()
    expect(imageSize(png(1, 1).slice(0, 20))).toBeNull()
  })
})
