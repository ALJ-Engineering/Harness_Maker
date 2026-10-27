/**
 * CLI-bundle stand-in for the bare `zustand` specifier (wired ONLY in
 * `scripts/build-cli.mjs`). Real `zustand`'s `create` imports React for its
 * hook; the CLI only ever calls `useHarnessStore.getState()`, so this builds the
 * same store on `zustand/vanilla`'s `createStore` and hands back a function
 * that carries the store API but throws if anyone calls it as a hook.
 * Supports both `create(init)` and the curried `create<T>()(init)` the store uses.
 * Middleware (`zustand/middleware/immer`) still resolves to the real package.
 */
import { createStore, type StateCreator, type StoreApi } from 'zustand/vanilla'

type Initializer = StateCreator<unknown, [], []>
type BoundStore = (() => never) & StoreApi<unknown>

function bind(init: Initializer): BoundStore {
  const api: StoreApi<unknown> = createStore(init)
  const hook = (() => {
    throw new Error('harness CLI: a zustand store was called as a React hook; use .getState() instead')
  }) as BoundStore
  return Object.assign(hook, api)
}

export function create(init?: Initializer): BoundStore | ((init: Initializer) => BoundStore) {
  return init ? bind(init) : bind
}
