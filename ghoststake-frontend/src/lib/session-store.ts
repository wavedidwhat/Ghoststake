import { clearSession, loadSession, saveSession, type StoredSession } from "./api";

/**
 * The stored session as an external store, for `useSyncExternalStore`.
 *
 * localStorage is external state, so it is subscribed to rather than
 * mirrored into component state via an effect. The `storage` listener also
 * means signing out in one tab signs out in the others.
 */

let cache: StoredSession | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === "ghoststake.session") {
      loaded = false;
      emit();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Returns a cached reference. `useSyncExternalStore` compares snapshots by
 * identity, so re-parsing the JSON per call would re-render without end.
 */
export function getSnapshot(): StoredSession | null {
  if (!loaded) {
    cache = loadSession();
    loaded = true;
  }
  return cache;
}

/** No localStorage on the server; every render starts signed out. */
export function getServerSnapshot(): StoredSession | null {
  return null;
}

export function setStoredSession(session: StoredSession) {
  saveSession(session);
  cache = session;
  loaded = true;
  emit();
}

export function clearStoredSession() {
  clearSession();
  cache = null;
  loaded = true;
  emit();
}
