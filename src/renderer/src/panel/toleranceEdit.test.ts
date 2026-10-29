import { describe, it, expect } from 'vitest'
import { IPC_620_LENGTH_TOLERANCE } from '@shared/model/schema'
import { ipcToleranceTable, withBand, withNewBand, withoutBand } from './toleranceEdit'

describe('tolerance table edits', () => {
  it('starts from a copy of the IPC/WHMA-A-620 bands, with the default title', () => {
    const t = ipcToleranceTable()
    expect(t).toEqual({ bands: IPC_620_LENGTH_TOLERANCE })
    expect(t.bands[0]).not.toBe(IPC_620_LENGTH_TOLERANCE[0])
  })

  it('changes one band and keeps them shortest first; clearing "up to" makes it the open last band', () => {
    const t = ipcToleranceTable()
    expect(withBand(t, 0, { plus: 30 }).bands[0]).toEqual({ upToMm: 300, plus: 30, minus: 0, unit: 'mm' })
    const moved = withBand(t, 0, { upToMm: 2000 })
    expect(moved.bands.map((b) => b.upToMm)).toEqual([1500, 2000, 3000, 7500, undefined])
    const opened = withBand({ bands: t.bands.slice(0, 2) }, 0, { upToMm: undefined })
    expect(opened.bands).toEqual([
      { upToMm: 1500, plus: 50, minus: 0, unit: 'mm' },
      { plus: 25, minus: 0, unit: 'mm' }
    ])
    expect('upToMm' in opened.bands[1]).toBe(false)
  })

  it('adds a band 1000 mm past the longest bounded one, before the open band', () => {
    const t = withNewBand(ipcToleranceTable())
    expect(t.bands.map((b) => b.upToMm)).toEqual([300, 1500, 3000, 7500, 8500, undefined])
    expect(t.bands[4]).toEqual({ upToMm: 8500, plus: 150, minus: 0, unit: 'mm' })
    expect(withNewBand({ bands: [] }).bands).toEqual([{ upToMm: 1000, plus: 0, minus: 0, unit: 'mm' }])
  })

  it('removes a band and keeps the title', () => {
    const t = withoutBand({ title: 'Mine', bands: ipcToleranceTable().bands }, 4)
    expect(t.title).toBe('Mine')
    expect(t.bands.map((b) => b.upToMm)).toEqual([300, 1500, 3000, 7500])
  })
})
