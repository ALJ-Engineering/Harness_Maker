/**
 * Pixel dimensions from an image's header only — no decode, no dependency.
 * PNG dimensions live in the IHDR that always follows the 8-byte signature;
 * JPEG dimensions live in the first SOF marker, which is why the segment chain
 * has to be walked (baseline SOF0 and progressive SOF2 are both accepted).
 */
export interface ImageSize {
  type: 'png' | 'jpeg'
  w: number
  h: number
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function imageSize(buf: Uint8Array): ImageSize | null {
  if (buf.length >= 24 && PNG_SIG.every((b, i) => buf[i] === b)) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const w = v.getUint32(16)
    const h = v.getUint32(20)
    return w > 0 && h > 0 ? { type: 'png', w, h } : null
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let i = 2
    while (i + 9 <= buf.length) {
      if (buf[i] !== 0xff) return null
      const marker = buf[i + 1]
      // Standalone markers carry no length word.
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2
        continue
      }
      const len = v.getUint16(i + 2)
      // C4 = DHT, C8 = JPG extension, CC = DAC — same range, not frame headers.
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        const h = v.getUint16(i + 5)
        const w = v.getUint16(i + 7)
        return w > 0 && h > 0 ? { type: 'jpeg', w, h } : null
      }
      i += 2 + len
    }
  }
  return null
}
