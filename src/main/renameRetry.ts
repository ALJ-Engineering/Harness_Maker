import { rename } from 'fs/promises'

/**
 * `rename`, retried briefly on Windows — the last step of every temp-file-then-rename write.
 *
 * On Windows a rename onto an existing file fails with EPERM / EACCES / EBUSY while another
 * process has it open: antivirus, the Search indexer, OneDrive, or another machine reading a
 * shared library folder. The hold is usually gone within milliseconds, so the write retries
 * with backoff (~1.3 s in all) before giving up — what graceful-fs does too. Elsewhere, and for
 * any other error, it is a plain `rename`. Electron-free, like the rest of `src/main`'s fs code.
 */
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640]

export interface RenameRetryOptions {
  /** Defaults to `process.platform`; tests pass `win32` to exercise the retry anywhere. */
  platform?: NodeJS.Platform
  /** Defaults to `fs/promises` `rename`; tests pass one that fails on cue. */
  rename?: (from: string, to: string) => Promise<void>
}

export async function renameWithRetry(from: string, to: string, opts: RenameRetryOptions = {}): Promise<void> {
  const doRename = opts.rename ?? rename
  const delays = (opts.platform ?? process.platform) === 'win32' ? RETRY_DELAYS_MS : []
  for (let attempt = 0; ; attempt++) {
    try {
      return await doRename(from, to)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= delays.length || !code || !RETRY_CODES.has(code)) throw e
      await new Promise((r) => setTimeout(r, delays[attempt]))
    }
  }
}
