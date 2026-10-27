import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, join } from 'path'

export type ThemeName = 'dark' | 'light'

/**
 * App settings, persisted as JSON next to the app's user data. Electron-free so
 * vitest can load it; `partsImagesIpc.ts` supplies the real path.
 */
export interface Settings {
  /** The parts library folder (`parts/ images/ datasheets/`). Pictures live in its `images/`. */
  partsLibraryDir?: string
  /** UI theme. Absent means the default, `dark`. Never enters HarnessDocument. */
  theme?: ThemeName
}

/** The theme to render with: the stored one, or `dark` on a fresh install. */
export function themeOf(s: Settings): ThemeName {
  return s.theme ?? 'dark'
}

export const LIBRARY_SUBDIRS = {
  parts: 'parts',
  images: 'images',
  datasheets: 'datasheets',
  /** `logo.svg|png|jpg|jpeg` for the title block (`branding.ts`). */
  branding: 'branding'
} as const

/** Where pictures live: the library's images folder, or nowhere until a library is set. */
export function imageDirOf(s: Settings): string | undefined {
  return s.partsLibraryDir ? join(s.partsLibraryDir, LIBRARY_SUBDIRS.images) : undefined
}

/** Never throws: anything that isn't a settings object reads as "no settings". */
export function parseSettings(text: string): Settings {
  try {
    const raw = JSON.parse(text) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const r = raw as Record<string, unknown>
    const out: Settings = {}
    if (typeof r.partsLibraryDir === 'string') out.partsLibraryDir = r.partsLibraryDir
    if (r.theme === 'dark' || r.theme === 'light') out.theme = r.theme
    return out
  } catch {
    return {}
  }
}

export function serializeSettings(s: Settings): string {
  return JSON.stringify(s, null, 2) + '\n'
}

/** Read/patch the settings file. A missing or corrupt file reads as `{}`. */
export class SettingsFile {
  constructor(private readonly path: string) {}

  async read(): Promise<Settings> {
    try {
      return parseSettings(await readFile(this.path, 'utf-8'))
    } catch {
      return {}
    }
  }

  async patch(p: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.read()), ...p }
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, serializeSettings(next), 'utf-8')
    return next
  }
}
