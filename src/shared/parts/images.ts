/**
 * Naming rules for the parts-image library, shared by main and the renderer.
 *
 * A library file is `<sanitisePartNumber(partNumber)>.<png|jpg|jpeg>`, so a part
 * number can never escape the folder and `39-01-3045` still reads as itself.
 * The renderer needs the same two functions to key its `PartImages` map and to
 * build `<image href>` values, hence a shared module rather than `src/main`.
 */
export const PARTS_IMAGE_SCHEME = 'parts-image'

/** Everything outside `[A-Za-z0-9._-]` becomes `_` — the on-disk file stem. */
export function sanitisePartNumber(pn: string): string {
  return pn.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** URL the custom protocol serves this part's picture from. */
export function imageHref(pn: string): string {
  return `${PARTS_IMAGE_SCHEME}://img/${encodeURIComponent(pn)}`
}
