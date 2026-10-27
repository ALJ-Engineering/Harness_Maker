import type { Id } from './schema'

/**
 * Generate a stable, opaque id. Uses the platform crypto UUID (available in
 * both the Electron renderer and the Node main process). Ids are never reused
 * and never derived from content (spec §3).
 */
export function newId(): Id {
  return globalThis.crypto.randomUUID()
}
