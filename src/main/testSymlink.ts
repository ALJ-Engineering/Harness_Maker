/**
 * Test-only helper (imported by `*.test.ts` only): make a symlink, or report that the OS refused.
 *
 * Windows only lets an unelevated process create a FILE symlink with Developer Mode on, and
 * answers EPERM otherwise — the caller skips its symlink assertion with `SYMLINK_SKIP` rather than
 * failing the suite. A DIRECTORY link is made as a junction on Windows: it needs no privilege and
 * `realpath` resolves it like a symlink, so the directory tests run everywhere. The type argument
 * is ignored off Windows.
 */
import { symlink } from 'fs/promises'

export const SYMLINK_SKIP = 'this OS refused to create a symlink (Windows without Developer Mode)'

export async function trySymlink(target: string, path: string, kind: 'file' | 'dir' = 'file'): Promise<boolean> {
  try {
    await symlink(target, path, kind === 'dir' && process.platform === 'win32' ? 'junction' : kind)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false
    throw e
  }
}
