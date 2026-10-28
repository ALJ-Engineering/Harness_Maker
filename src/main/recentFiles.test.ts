import { describe, it, expect } from 'vitest'
import { MAX_RECENT_FILES } from './settings'
import { recentLabel, samePath, withRecent, withoutRecent } from './recentFiles'

describe('recent files list', () => {
  it('puts a new file first and moves a known one to the front', () => {
    expect(withRecent([], '/a.json', 'linux')).toEqual(['/a.json'])
    expect(withRecent(['/a.json', '/b.json', '/c.json'], '/c.json', 'linux')).toEqual([
      '/c.json',
      '/a.json',
      '/b.json'
    ])
  })

  it(`keeps at most ${MAX_RECENT_FILES}, dropping the oldest`, () => {
    const full = Array.from({ length: MAX_RECENT_FILES }, (_, i) => `/f${i}.json`)
    const next = withRecent(full, '/new.json', 'linux')
    expect(next).toHaveLength(MAX_RECENT_FILES)
    expect(next[0]).toBe('/new.json')
    expect(next).not.toContain(full[MAX_RECENT_FILES - 1])
  })

  it('treats Windows paths case-insensitively, other paths exactly', () => {
    expect(samePath('C:\\Looms\\A.json', 'c:\\looms\\a.json', 'win32')).toBe(true)
    expect(samePath('/Looms/A.json', '/looms/a.json', 'darwin')).toBe(false)
    expect(withRecent(['C:\\Looms\\A.json'], 'c:\\looms\\a.json', 'win32')).toEqual(['c:\\looms\\a.json'])
    expect(withoutRecent(['C:\\A.json', 'C:\\B.json'], 'c:\\a.json', 'win32')).toEqual(['C:\\B.json'])
  })
})

describe('recentLabel', () => {
  it('shows the file name, then its folder', () => {
    expect(recentLabel('/home/t/looms/can.harness.json', 0, 'darwin')).toBe('can.harness.json — /home/t/looms')
    expect(recentLabel('C:\\looms\\can.harness.json', 0, 'win32')).toBe('&1 can.harness.json — C:\\looms')
  })

  it('gives the first nine an access key off macOS, and doubles a literal &', () => {
    expect(recentLabel('/x/a.json', 8, 'linux')).toBe('&9 a.json — /x')
    expect(recentLabel('/x/a.json', 9, 'linux')).toBe('a.json — /x')
    expect(recentLabel('C:\\R&D\\a.json', 0, 'win32')).toBe('&1 a.json — C:\\R&&D')
    expect(recentLabel('/R&D/a.json', 0, 'darwin')).toBe('a.json — /R&D')
  })
})
