import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveLibraryDir, resolveLibrary, libraryDirExists } from './libraryDir'
import type { CliIO } from './io'

let home: string
const mk = (env: Record<string, string | undefined> = {}, platform: NodeJS.Platform = 'darwin'): CliIO => ({
  out: () => {},
  err: () => {},
  env,
  home,
  platform,
  readStdin: async () => '',
  stdinLines: async function* () {}
})
const settingsAt = (...rel: string[]): void => {
  const dir = join(home, ...rel.slice(0, -1))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, ...rel), JSON.stringify({ partsLibraryDir: '/lib/' + rel[rel.length - 2] }))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'harness-home-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('resolveLibrary source', () => {
  it('names the flag, the env var, or the settings file it came from', async () => {
    expect(await resolveLibrary('/flag', mk({ HARNESS_LIBRARY: '/env' }))).toEqual({ dir: '/flag', source: '--library' })
    expect(await resolveLibrary(undefined, mk({ HARNESS_LIBRARY: '/env' }))).toEqual({ dir: '/env', source: 'HARNESS_LIBRARY' })
    settingsAt('Library', 'Application Support', 'Harness Editor', 'settings.json')
    expect(await resolveLibrary(undefined, mk())).toEqual({
      dir: '/lib/Harness Editor',
      source: join(home, 'Library', 'Application Support', 'Harness Editor', 'settings.json')
    })
  })
  it('libraryDirExists: a directory yes; a missing path or a file no', async () => {
    expect(await libraryDirExists(home)).toBe(true)
    expect(await libraryDirExists(join(home, 'nope'))).toBe(false)
    writeFileSync(join(home, 'f'), 'x')
    expect(await libraryDirExists(join(home, 'f'))).toBe(false)
  })
})

describe('resolveLibraryDir', () => {
  it('flag wins over env and settings', async () => {
    settingsAt('Library', 'Application Support', 'harness-editor', 'settings.json')
    expect(await resolveLibraryDir('/flag', mk({ HARNESS_LIBRARY: '/env' }))).toBe('/flag')
  })
  it('env wins over settings', async () => {
    settingsAt('Library', 'Application Support', 'harness-editor', 'settings.json')
    expect(await resolveLibraryDir(undefined, mk({ HARNESS_LIBRARY: '/env' }))).toBe('/env')
  })
  it('reads the dev settings path when only it exists', async () => {
    settingsAt('Library', 'Application Support', 'harness-editor', 'settings.json')
    expect(await resolveLibraryDir(undefined, mk())).toBe('/lib/harness-editor')
  })
  it('reads the packaged settings path when only it exists', async () => {
    settingsAt('Library', 'Application Support', 'Harness Editor', 'settings.json')
    expect(await resolveLibraryDir(undefined, mk())).toBe('/lib/Harness Editor')
  })
  it('prefers the dev path when both exist', async () => {
    settingsAt('Library', 'Application Support', 'harness-editor', 'settings.json')
    settingsAt('Library', 'Application Support', 'Harness Editor', 'settings.json')
    expect(await resolveLibraryDir(undefined, mk())).toBe('/lib/harness-editor')
  })
  it('uses XDG_CONFIG_HOME, then ~/.config, on linux', async () => {
    settingsAt('xdg', 'harness-editor', 'settings.json')
    expect(await resolveLibraryDir(undefined, mk({ XDG_CONFIG_HOME: join(home, 'xdg') }, 'linux'))).toBe('/lib/harness-editor')
    settingsAt('.config', 'Harness Editor', 'settings.json')
    expect(await resolveLibraryDir(undefined, mk({}, 'linux'))).toBe('/lib/Harness Editor')
  })
  it('uses APPDATA on windows', async () => {
    settingsAt('roaming', 'harness-editor', 'settings.json')
    expect(await resolveLibraryDir(undefined, mk({ APPDATA: join(home, 'roaming') }, 'win32'))).toBe('/lib/harness-editor')
  })
  it('returns null when the only settings file names no library', async () => {
    const dir = join(home, 'Library', 'Application Support', 'harness-editor')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{ "theme": "light" }')
    expect(await resolveLibraryDir(undefined, mk())).toBeNull()
  })
  it('falls through a settings file with no library (or corrupt) to the next one', async () => {
    const dev = join(home, 'Library', 'Application Support', 'harness-editor')
    mkdirSync(dev, { recursive: true })
    writeFileSync(join(dev, 'settings.json'), '{ "theme": "light" }')
    settingsAt('Library', 'Application Support', 'Harness Editor', 'settings.json')
    expect(await resolveLibraryDir(undefined, mk())).toBe('/lib/Harness Editor')
    writeFileSync(join(dev, 'settings.json'), '{ not json')
    expect(await resolveLibraryDir(undefined, mk())).toBe('/lib/Harness Editor')
  })
  it('returns null with no settings anywhere', async () => {
    expect(await resolveLibraryDir(undefined, mk())).toBeNull()
  })
})
