import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { LibraryPart } from '../shared/parts/librarySchema'
import type { McpCall, McpReply, ToolOutcome } from '../shared/mcp'

export interface OpenResult {
  path: string
  content: string
}
export type MenuAction =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'undo'
  | 'redo'
  | 'exportDrawingSet'
  | 'exportBom'
  | 'openLibrary'
  | 'refreshPartRefs'

/** One derived file in an export: written as a chosen base name + this suffix. */
export interface ExportFile {
  suffix: string
  content: string
}

/** One page-size run of an export: already-paginated HTML plus its page size. */
export interface PdfPart {
  html: string
  widthMm: number
  heightMm: number
}

/**
 * Args for `doc:exportPdf`: render every part to a PDF at a chosen path. The
 * drawing set is two parts of different paper sizes (the 1:1 drawing page + A4
 * document pages); main renders one per part and merges them into one file.
 */
export interface ExportPdfArgs {
  parts: PdfPart[]
  defaultPath?: string
  title?: string
}

/** One picture in the parts image library, as the renderer sees it. */
export interface PartImageInfo {
  href: string
  pxW: number
  pxH: number
}

/** A rejected import: the reason, for the renderer to show. */
export interface PartImageError {
  error: string
}

/** `library:list`'s shape: the parts library's parts, which stems have a datasheet, and parse errors. */
export interface LibraryListingDto {
  parts: LibraryPart[]
  datasheets: string[]
  errors: { file: string; error: string }[]
}

/**
 * Bridge exposed to the renderer as `window.api`. Keep this surface small and
 * explicit — the renderer is untrusted with respect to the OS. All filesystem
 * access goes through these IPC calls; the renderer never touches fs directly.
 */
const api = {
  platform: process.platform,

  /** Show open dialog + read file. Resolves null if the user cancels. */
  openDocument: (): Promise<OpenResult | null> => ipcRenderer.invoke('doc:open'),

  /** Read a file from File ▸ Open Recent. Main reads only a path that is on the list. */
  openRecentDocument: (path: string): Promise<OpenResult | { error: string }> =>
    ipcRenderer.invoke('doc:openRecent', path),

  /** Put a document that was just opened or saved at the top of File ▸ Open Recent. */
  addRecentFile: (path: string): Promise<void> => ipcRenderer.invoke('recent:add', path),

  /** Write `content` to a known `path`. Resolves the path written. */
  saveDocument: (path: string, content: string): Promise<string> =>
    ipcRenderer.invoke('doc:save', { path, content }),

  /** Show save dialog + write. Resolves the chosen path, or null if cancelled. */
  saveDocumentAs: (content: string, defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('doc:saveAs', { content, defaultPath }),

  /** Export derived files (SVG/CSV/HTML) from one save dialog. Null if cancelled. */
  exportFiles: (
    files: ExportFile[],
    defaultPath?: string,
    title?: string
  ): Promise<string[] | null> => ipcRenderer.invoke('doc:exportFiles', { files, defaultPath, title }),

  /** Render the paginated parts to one PDF via a save dialog. Null if cancelled. */
  exportPdf: (args: ExportPdfArgs): Promise<string | null> =>
    ipcRenderer.invoke('doc:exportPdf', args),

  /** Tell main whether the document has unsaved changes (drives the close guard). */
  setDirty: (dirty: boolean): void => ipcRenderer.send('doc:dirty', dirty),

  /** The configured parts image folder, or null if the user has not set one. */
  partsGetImageDir: (): Promise<string | null> => ipcRenderer.invoke('parts:getImageDir'),

  /** The whole library, keyed by sanitised part number (the file stem). */
  partsListImages: (): Promise<Record<string, PartImageInfo>> =>
    ipcRenderer.invoke('parts:listImages'),

  /**
   * Copy a picture into the library for `partNumber`; file dialog if no
   * `srcPath`. `null` = cancelled or no library folder; `{ error }` = the file
   * was rejected (not a regular file, over 5 MB, not PNG/JPEG).
   */
  partsImportImage: (
    partNumber: string,
    srcPath?: string
  ): Promise<PartImageInfo | PartImageError | null> =>
    ipcRenderer.invoke('parts:importImage', { partNumber, srcPath }),

  /** Delete this part's library file. False if it had none. */
  partsRemoveImage: (partNumber: string): Promise<boolean> =>
    ipcRenderer.invoke('parts:removeImage', partNumber),

  /** Inline data URL for export. Null if absent or over the 5 MB cap. */
  partsImageDataUrl: (partNumber: string): Promise<string | null> =>
    ipcRenderer.invoke('parts:imageDataUrl', partNumber),

  /** The title-block logo from `<library>/branding/logo.*` as a data URL; null if none. */
  libraryLogoDataUrl: (): Promise<string | null> => ipcRenderer.invoke('library:logoDataUrl'),

  /** OS path of a dropped File (drag-and-drop import). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** The configured parts library folder, or null if the user has not set one. */
  libraryGetDir: (): Promise<string | null> => ipcRenderer.invoke('library:getDir'),

  /** Directory picker for the parts library folder. Null if cancelled. */
  libraryChooseDir: (): Promise<string | null> => ipcRenderer.invoke('library:chooseDir'),

  /** The whole parts library: parsed parts, which stems have a datasheet, and parse errors. */
  libraryList: (): Promise<LibraryListingDto> => ipcRenderer.invoke('library:list'),

  /** Validate then write a library part to disk. */
  libraryWritePart: (part: LibraryPart): Promise<{ ok: true } | { error: string }> =>
    ipcRenderer.invoke('library:writePart', part),

  /** Delete a library part's record, optionally its picture and datasheet too. */
  libraryDeletePart: (partNumber: string, withFiles: boolean): Promise<boolean> =>
    ipcRenderer.invoke('library:deletePart', partNumber, withFiles),

  /**
   * Copy a PDF into the library as this part's datasheet; file dialog if no
   * `srcPath`. `null` = cancelled or no library folder; `{ error }` = rejected.
   */
  libraryImportDatasheet: (
    partNumber: string,
    srcPath?: string
  ): Promise<{ ok: true } | { error: string } | null> =>
    ipcRenderer.invoke('library:importDatasheet', { partNumber, srcPath }),

  /** Open a part's datasheet (local PDF or its `datasheetUrl`) in the OS. */
  libraryOpenDatasheet: (partNumber: string): Promise<{ ok: true } | { error: string }> =>
    ipcRenderer.invoke('library:openDatasheet', partNumber),

  /** Delete a part's datasheet file. False if it had none. */
  libraryRemoveDatasheet: (partNumber: string): Promise<boolean> =>
    ipcRenderer.invoke('library:removeDatasheet', partNumber),

  /** Subscribe to parts-library changes. Returns an unsubscribe function. */
  onLibraryChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('library:changed', listener)
    return () => ipcRenderer.removeListener('library:changed', listener)
  },

  /** Subscribe to settings changes made in main. Returns an unsubscribe function. */
  onSettingsChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },

  /** UI theme, persisted in userData/settings.json. Defaults to 'dark'. */
  getTheme: (): Promise<'dark' | 'light'> => ipcRenderer.invoke('settings:getTheme'),
  setTheme: (theme: 'dark' | 'light'): Promise<void> =>
    ipcRenderer.invoke('settings:setTheme', theme),

  /** Subscribe to File-menu actions. Returns an unsubscribe function. */
  onMenuAction: (cb: (action: MenuAction) => void): (() => void) => {
    const listener = (_e: unknown, action: MenuAction): void => cb(action)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  },

  /** File ▸ Open Recent ▸ <file> was clicked. Returns an unsubscribe. */
  onOpenRecent: (cb: (path: string) => void): (() => void) => {
    const listener = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('menu:openRecent', listener)
    return () => ipcRenderer.removeListener('menu:openRecent', listener)
  },

  /**
   * Serve the MCP server's document tools (main → renderer request/response):
   * main sends `mcp:call`, the handler's outcome goes back on `mcp:result` with
   * the same id. Main refuses calls at once while no handler is registered
   * (`mcp:ready`). Returns an unsubscribe function.
   */
  onMcpCall: (handler: (name: string, args: unknown) => Promise<ToolOutcome>): (() => void) => {
    const listener = (_e: unknown, call: McpCall): void => {
      void handler(call.name, call.args)
        .catch((e: unknown): ToolOutcome => ({ ok: false, errors: [`internal error: ${(e as Error).message}`] }))
        .then((outcome) => ipcRenderer.send('mcp:result', { id: call.id, outcome } satisfies McpReply))
    }
    ipcRenderer.on('mcp:call', listener)
    ipcRenderer.send('mcp:ready', true)
    return () => {
      ipcRenderer.removeListener('mcp:call', listener)
      ipcRenderer.send('mcp:ready', false)
    }
  }
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose preload api:', error)
  }
} else {
  // contextIsolation disabled — only used as a fallback.
  // @ts-expect-error attach to window
  window.api = api
}
