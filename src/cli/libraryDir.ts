import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { parseSettings } from '../main/settings'
import type { CliIO } from './io'

/** App-data folder names, dev first (electron-vite dev) then packaged (productName). */
const APP_DIRS = ['harness-editor', 'Harness Editor']

/** The app's settings.json candidates, dev build first. */
export function settingsPaths(io: CliIO): string[] {
  let base: string
  if (io.platform === 'darwin') base = join(io.home, 'Library', 'Application Support')
  else if (io.platform === 'win32') base = io.env.APPDATA || join(io.home, 'AppData', 'Roaming')
  else base = io.env.XDG_CONFIG_HOME || join(io.home, '.config')
  return APP_DIRS.map((d) => join(base, d, 'settings.json'))
}

/** Where the library folder came from: the flag, the env var, or the settings file's path. */
export type LibrarySource = '--library' | 'HARNESS_LIBRARY' | string

/**
 * The parts library folder: `--library` flag, then `HARNESS_LIBRARY`, then `partsLibraryDir` from the
 * first existing app settings file that names one. `null` when none is configured.
 */
export async function resolveLibrary(
  flag: string | undefined,
  io: CliIO
): Promise<{ dir: string; source: LibrarySource } | null> {
  if (flag) return { dir: flag, source: '--library' }
  if (io.env.HARNESS_LIBRARY) return { dir: io.env.HARNESS_LIBRARY, source: 'HARNESS_LIBRARY' }
  for (const p of settingsPaths(io)) {
    let text: string
    try {
      text = await readFile(p, 'utf8')
    } catch {
      continue
    }
    let dir: string | undefined
    try {
      dir = parseSettings(text).partsLibraryDir
    } catch {
      continue
    }
    if (dir) return { dir, source: p }
  }
  return null
}

export async function resolveLibraryDir(flag: string | undefined, io: CliIO): Promise<string | null> {
  return (await resolveLibrary(flag, io))?.dir ?? null
}

/** True when `dir` exists and is a directory. */
export async function libraryDirExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}
