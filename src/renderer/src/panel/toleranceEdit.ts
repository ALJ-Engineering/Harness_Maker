import type { LengthToleranceBand, ToleranceTable } from '@shared/model/schema'
import { IPC_620_LENGTH_TOLERANCE } from '@shared/model/schema'
import { sortedToleranceBands } from '@shared/print/tableData'

/** The table a drawing gets when the user turns tolerances on: IPC/WHMA-A-620, default title. */
export function ipcToleranceTable(): ToleranceTable {
  return { bands: IPC_620_LENGTH_TOLERANCE.map((b) => ({ ...b })) }
}

/**
 * `table` with band `i` changed. Bands are kept shortest first, so clearing a
 * band's upper end ("and longer") moves it to the bottom. An `upToMm` of
 * `undefined` drops the key rather than storing it.
 */
export function withBand(table: ToleranceTable, i: number, patch: Partial<LengthToleranceBand>): ToleranceTable {
  const bands = table.bands.map((b, j) => {
    if (j !== i) return b
    const { upToMm, ...rest } = { ...b, ...patch }
    // `upToMm` first, as the defaults have it, so an edited band diffs cleanly in the file.
    return upToMm === undefined ? rest : { upToMm, ...rest }
  })
  return { ...table, bands: sortedToleranceBands(bands) }
}

/** `table` without band `i`. */
export function withoutBand(table: ToleranceTable, i: number): ToleranceTable {
  return { ...table, bands: table.bands.filter((_, j) => j !== i) }
}

/**
 * `table` with one more band, 1000 mm past the longest band that has an upper
 * end and with that band's tolerance, so it slots in before an open-ended last
 * band. The user then types the real figures.
 */
export function withNewBand(table: ToleranceTable): ToleranceTable {
  const last = table.bands.reduce<LengthToleranceBand | undefined>(
    (a, b) => (b.upToMm !== undefined && (a === undefined || b.upToMm > a.upToMm!) ? b : a),
    undefined
  )
  const band: LengthToleranceBand = last
    ? { ...last, upToMm: last.upToMm! + 1000 }
    : { upToMm: 1000, plus: 0, minus: 0, unit: 'mm' }
  return { ...table, bands: sortedToleranceBands([...table.bands, band]) }
}
