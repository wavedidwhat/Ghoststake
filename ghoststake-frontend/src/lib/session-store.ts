import { clearSession, loadSession, saveSession, type StoredSession } from "./api";

/**
 * The stored session, exposed as an external store for `useSyncExternalStore`.
 *
 * localStorage genuinely *is* an external store, so reading it in an effect
 * and mirroring it into component state was the wrong shape — it makes React
 * render once with a value it knows is stale, and React 19's
 * `set-state-in-effect` lint rule flags exactly that. Subscribing instead
 * removes the mirrored copy entirely.
 *
 * The `storage` event listener is a free bonus of doing it this way: signing
 * out in one tab now signs out in every other tab, which is the behaviour a
 * user already expects from a session.
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
 * Must return a cached reference, not a fresh object: `useSyncExternalStore`
 * compares snapshots by identity, and re-parsing JSON on every call would
 * produce a new object each time and loop forever.
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
