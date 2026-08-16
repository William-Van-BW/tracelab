/**
 * Per-tab state and cross-tab coordination.
 *
 * Recording several Agents in parallel means several tabs open at once, each
 * parked on a different Run. Two things have to hold for that to work:
 *
 *  1. "Which Run am I looking at" must be per-tab. It used to live in
 *     localStorage, which every tab shares — so the last tab to change its
 *     selection rewrote the key for all of them, and after any reload (Vite HMR
 *     triggers plenty) several tabs would come back pointing at the SAME Run and
 *     then autosave over each other. sessionStorage is per-tab and still
 *     survives reloads, which is exactly the lifetime this state wants.
 *
 *  2. Tabs have to hear about each other's writes. Each tab loads the Run list
 *     once at mount, so without a notification a Run created or edited in tab B
 *     is invisible in tab A — and tab A's stale copy can later be written back
 *     over the newer one.
 */

/** Identifies this tab for the lifetime of the tab, across reloads. */
export const TAB_ID = (() => {
  if (typeof window === "undefined") return "ssr";
  try {
    const existing = window.sessionStorage.getItem("aetf:tab-id");
    if (existing) return existing;
    const id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage.setItem("aetf:tab-id", id);
    return id;
  } catch {
    return `tab_${Math.random().toString(36).slice(2, 8)}`;
  }
})();

/**
 * `tab` — belongs to this window: current view, selected Run/Case, filters.
 * `device` — belongs to the machine: font scale, panel sizes, autosave toggle.
 */
export type StorageScope = "tab" | "device";

function storageFor(scope: StorageScope): Storage | null {
  if (typeof window === "undefined") return null;
  try { return scope === "tab" ? window.sessionStorage : window.localStorage; } catch { return null; }
}

export function readScoped(key: string, scope: StorageScope): string | null {
  try { return storageFor(scope)?.getItem(key) ?? null; } catch { return null; }
}

export function writeScoped(key: string, value: string, scope: StorageScope) {
  try { storageFor(scope)?.setItem(key, value); } catch { /* storage unavailable (privacy mode, quota) */ }
}

/* ------------------------------------------------------------------ sync */

export type RunSyncMessage =
  /** This tab wrote a Run; others should merge it instead of keeping a stale copy. */
  | { kind: "run-saved"; tabId: string; runId: string; updatedOnDisk?: string }
  /** This tab dropped a Run (trash or permanent delete). */
  | { kind: "run-removed"; tabId: string; runId: string }
  /** Periodic "I have this Run open", so a second tab on the same Run can warn. */
  | { kind: "run-focus"; tabId: string; runId: string | null }
  /** A new tab asking everyone to re-announce their focus. */
  | { kind: "who-has-what"; tabId: string };

const CHANNEL_NAME = "aetf:run-sync";

/**
 * BroadcastChannel where available. Returns a no-op transport when it is not
 * (older Safari, or a non-secure context that disallows it) so callers never
 * have to branch — parallel recording degrades to today's behaviour rather than
 * breaking.
 */
export function openRunSync(onMessage: (message: RunSyncMessage) => void) {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return { post: (message: RunSyncMessage) => { void message; }, close: () => {}, available: false };
  }
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<RunSyncMessage>) => {
    // Ignore our own echoes; BroadcastChannel does not deliver to the sender,
    // but a future transport might, and the guard is free.
    if (event.data?.tabId === TAB_ID) return;
    onMessage(event.data);
  };
  return {
    post: (message: RunSyncMessage) => { try { channel.postMessage(message); } catch { /* channel closed */ } },
    close: () => { try { channel.close(); } catch { /* already closed */ } },
    available: true,
  };
}
