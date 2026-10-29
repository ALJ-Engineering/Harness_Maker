/// <reference types="vite/client" />

// Shape of the preload bridge (src/preload/index.ts) as seen by the renderer.
// Kept in sync by hand to avoid importing Electron types into the web context.
interface OpenResult {
  path: string
  content: string
}
type MenuAction =
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

interface ExportFile {
  suffix: string
  content: string
}

interface PdfPart {
  html: string
  widthMm: number
  heightMm: number
}

interface ExportPdfArgs {
  parts: PdfPart[]
  defaultPath?: string
  title?: string
}

interface PartImageInfo {
  href: string
  pxW: number
  pxH: number
}

interface PartImageError {
  error: string
}

interface LibraryListingDto {
  parts: import('@shared/parts/librarySchema').LibraryPart[]
  datasheets: string[]
  errors: { file: string; error: string }[]
}

interface PreloadApi {
  platform: string
  openDocument: () => Promise<OpenResult | null>
  openRecentDocument: (path: string) => Promise<OpenResult | { error: string }>
  addRecentFile: (path: string) => Promise<void>
  saveDocument: (path: string, content: string) => Promise<string>
  saveDocumentAs: (content: string, defaultPath?: string) => Promise<string | null>
  exportFiles: (
    files: ExportFile[],
    defaultPath?: string,
    title?: string
  ) => Promise<string[] | null>
  exportPdf: (args: ExportPdfArgs) => Promise<string | null>
  setDirty: (dirty: boolean) => void
  partsGetImageDir: () => Promise<string | null>
  partsListImages: () => Promise<Record<string, PartImageInfo>>
  partsImportImage: (
    partNumber: string,
    srcPath?: string
  ) => Promise<PartImageInfo | PartImageError | null>
  partsRemoveImage: (partNumber: string) => Promise<boolean>
  partsImageDataUrl: (partNumber: string) => Promise<string | null>
  libraryLogoDataUrl: () => Promise<string | null>
  pathForFile: (file: File) => string
  libraryGetDir: () => Promise<string | null>
  libraryChooseDir: () => Promise<string | null>
  libraryList: () => Promise<LibraryListingDto>
  libraryWritePart: (
    part: import('@shared/parts/librarySchema').LibraryPart
  ) => Promise<{ ok: true } | { error: string }>
  libraryDeletePart: (partNumber: string, withFiles: boolean) => Promise<boolean>
  libraryImportDatasheet: (
    partNumber: string,
    srcPath?: string
  ) => Promise<{ ok: true } | { error: string } | null>
  libraryOpenDatasheet: (partNumber: string) => Promise<{ ok: true } | { error: string }>
  libraryRemoveDatasheet: (partNumber: string) => Promise<boolean>
  onLibraryChanged: (cb: () => void) => () => void
  onSettingsChanged: (cb: () => void) => () => void
  onMenuAction: (cb: (action: MenuAction) => void) => () => void
  onOpenRecent: (cb: (path: string) => void) => () => void
  onMcpCall: (
    handler: (name: string, args: unknown) => Promise<import('@shared/mcp').ToolOutcome>
  ) => () => void
  getTheme: () => Promise<'dark' | 'light'>
  setTheme: (theme: 'dark' | 'light') => Promise<void>
}

declare module '*.png?inline' {
  const src: string
  export default src
}

declare global {
  interface Window {
    api: PreloadApi
  }
}

export {}
