import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_MCP_PORT, imageDirOf, MAX_RECENT_FILES, mcpPortOf, parseSettings, serializeSettings, SettingsFile, themeOf } from './settings'

describe('settings', () => {
  it('parses a good file, tolerates junk', () => {
    expect(parseSettings('nope')).toEqual({})
    expect(parseSettings('[]')).toEqual({})
  })

  it('round-trips through a file and patches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hs-'))
    try {
      const f = new SettingsFile(join(dir, 'settings.json'))
      expect(await f.read()).toEqual({})
      await f.patch({ partsLibraryDir: '/lib' })
      expect(await f.read()).toEqual({ partsLibraryDir: '/lib' })
      expect(serializeSettings({ partsLibraryDir: '/lib' })).toBe('{\n  "partsLibraryDir": "/lib"\n}\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  describe('partsLibraryDir', () => {
    it('parses and serialises the key, ignoring the removed partsImageDir', () => {
      const s = parseSettings(JSON.stringify({ partsImageDir: '/a', partsLibraryDir: '/lib', junk: 1 }))
      expect(s).toEqual({ partsLibraryDir: '/lib' })
      expect(parseSettings(serializeSettings(s))).toEqual(s)
    })
    it('ignores non-string values', () => {
      expect(parseSettings(JSON.stringify({ partsLibraryDir: 3 }))).toEqual({})
    })
    it('imageDirOf is <lib>/images, or undefined without a library', () => {
      expect(imageDirOf({})).toBeUndefined()
      expect(imageDirOf({ partsLibraryDir: '/lib' })).toBe(join('/lib', 'images'))
    })
  })

  describe('theme', () => {
    it('parses the key and ignores anything that is not dark or light', () => {
      expect(parseSettings(JSON.stringify({ theme: 'light' }))).toEqual({ theme: 'light' })
      expect(parseSettings(JSON.stringify({ theme: 'dark' }))).toEqual({ theme: 'dark' })
      expect(parseSettings(JSON.stringify({ theme: 'chartreuse' }))).toEqual({})
      expect(parseSettings(JSON.stringify({ theme: 3 }))).toEqual({})
    })

    it('keeps theme and partsLibraryDir independent', () => {
      const s = parseSettings(JSON.stringify({ partsLibraryDir: '/lib', theme: 'light' }))
      expect(s).toEqual({ partsLibraryDir: '/lib', theme: 'light' })
      expect(parseSettings(serializeSettings(s))).toEqual(s)
    })

    it('themeOf defaults to dark when unset', () => {
      expect(themeOf({})).toBe('dark')
      expect(themeOf({ partsLibraryDir: '/lib' })).toBe('dark')
      expect(themeOf({ theme: 'light' })).toBe('light')
      expect(themeOf({ theme: 'dark' })).toBe('dark')
    })
  })

  describe('recentFiles', () => {
    it('keeps the non-empty strings, in order, at most MAX_RECENT_FILES', () => {
      expect(parseSettings(JSON.stringify({ recentFiles: ['/a.json', 3, '', '/b.json'] }))).toEqual({
        recentFiles: ['/a.json', '/b.json']
      })
      const many = Array.from({ length: MAX_RECENT_FILES + 3 }, (_, i) => `/f${i}.json`)
      expect(parseSettings(JSON.stringify({ recentFiles: many })).recentFiles).toEqual(many.slice(0, MAX_RECENT_FILES))
    })

    it('drops a list that is not an array or holds nothing usable', () => {
      expect(parseSettings(JSON.stringify({ recentFiles: '/a.json' }))).toEqual({})
      expect(parseSettings(JSON.stringify({ recentFiles: [1, null] }))).toEqual({})
    })

    it('round-trips next to the other keys', () => {
      const s = parseSettings(JSON.stringify({ theme: 'light', recentFiles: ['/a.json'] }))
      expect(parseSettings(serializeSettings(s))).toEqual({ theme: 'light', recentFiles: ['/a.json'] })
    })
  })

  describe('agent access (MCP)', () => {
    it('parses mcpEnabled and an integer port in 1–65535, ignoring junk', () => {
      const s = parseSettings(JSON.stringify({ mcpEnabled: true, mcpPort: 47200 }))
      expect(s).toEqual({ mcpEnabled: true, mcpPort: 47200 })
      expect(parseSettings(serializeSettings(s))).toEqual(s)
      for (const junk of [0, 65536, 47.5, '47100', -1, null])
        expect(parseSettings(JSON.stringify({ mcpPort: junk }))).toEqual({})
      expect(parseSettings(JSON.stringify({ mcpEnabled: 'yes' }))).toEqual({})
    })

    it('mcpPortOf defaults to DEFAULT_MCP_PORT', () => {
      expect(mcpPortOf({})).toBe(DEFAULT_MCP_PORT)
      expect(mcpPortOf({ mcpPort: 5000 })).toBe(5000)
    })
  })
})
