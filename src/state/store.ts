import { useSyncExternalStore } from 'react'

export interface Store<T> {
  get(): T
  set(update: Partial<T> | ((state: T) => Partial<T>)): void
  subscribe(listener: () => void): () => void
}

/**
 * Minimal external store. React reads it through useStore; the canvas
 * renderer subscribes directly and redraws without re-rendering React.
 */
export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(update) {
      const patch = typeof update === 'function' ? update(state) : update
      state = { ...state, ...patch }
      listeners.forEach((l) => l())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * Subscribes a component to one slice. The selector must return a stable
 * value (a primitive or an existing reference), never a fresh object/array.
 */
export function useStore<T, U>(store: Store<T>, selector: (state: T) => U): U {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()))
}
