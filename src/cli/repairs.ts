import type { HarnessDocument } from '@shared/model/schema'
import { parseDocument, serializeDocument } from '@shared/model/serialize'
import { reconcileDocument, type Repair } from '@shared/model/reconcile'

/**
 * The repairs the editor would make the next time it opens `doc` — a round trip
 * through the file format and `reconcileDocument`. Empty for a document the CLI
 * may save or an agent may leave in the app. Fs-free.
 */
export function repairsOnReload(doc: HarnessDocument): Repair[] {
  return reconcileDocument(parseDocument(serializeDocument(doc))).repairs
}
