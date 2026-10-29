import { posix, win32 } from 'path'
import { MAX_RECENT_FILES } from './settings'

/**
 * File ▸ Open Recent, the pure half: the list rules and the menu labels.
 * Electron-free so vitest can load it; `recentFilesIpc.ts` persists the list in
 * settings.json and rebuilds the menu. `platform` is a parameter, not
 * `process.platform`, so both path flavours are testable on any OS.
 */

/** Windows paths are case-insensitive: `C:\A.json` and `c:\a.json` are one file. */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** `path` moved to (or added at) the front, at most `MAX_RECENT_FILES` long. */
export function withRecent(list: readonly string[], path: string, platform: NodeJS.Platform): string[] {
  return [path, ...withoutRecent(list, path, platform)].slice(0, MAX_RECENT_FILES)
}

/** The list with `path` dropped. */
export function withoutRecent(list: readonly string[], path: string, platform: NodeJS.Platform): string[] {
  return list.filter((p) => !samePath(p, path, platform))
}

/**
 * The menu label for the `index`th recent file: "loom.harness.json — C:\looms".
 * Off macOS the first nine get an access key (`&1` … `&9`), and a literal `&`
 * in the path is doubled so it shows instead of becoming one.
 */
export function recentLabel(path: string, index: number, platform: NodeJS.Platform): string {
  const p = platform === 'win32' ? win32 : posix
  const text = `${p.basename(path)} — ${p.dirname(path)}`
  if (platform === 'darwin') return text
  return `${index < 9 ? `&${index + 1} ` : ''}${text.replace(/&/g, '&&')}`
}
