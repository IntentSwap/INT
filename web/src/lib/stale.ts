// A page left open while a new version of the site goes out still asks for parts of the old one
// (a page, the wallet's code, the sign-in), and those files are gone. When a part fails to load,
// the page is loaded again, once, which brings the new version. If a part fails again straight
// after that, nothing is reloaded a second time: the page says the site was updated and offers a
// button, so a part that truly cannot be had never turns into an endless reload.

import { useSyncExternalStore } from "react";

const KEY = "reloaded-for-new-version";
/** A second failure this soon after the automatic reload is not answered with another one. */
const SOON_MS = 60_000;

interface Surroundings {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  reload: () => void;
  now: () => number;
}

let asking = false;
const listeners = new Set<() => void>();

function surroundings(): Surroundings {
  const reload = () => window.location.reload();
  const now = () => Date.now();
  try {
    return { storage: window.sessionStorage, reload, now };
  } catch {
    return { storage: null, reload, now };
  }
}

/**
 * A part of the site did not load. Reloads the page if that has not just been tried, and says
 * which it did: "reloading", or "ask" when the person is now asked to reload instead.
 */
export function partFailedToLoad(around: Surroundings = surroundings()): "reloading" | "ask" {
  const ask = (): "ask" => {
    asking = true;
    for (const listener of listeners) listener();
    return "ask";
  };
  if (asking) return "ask";
  // With nowhere to note that a reload was tried, one cannot be told from a loop of them: ask.
  if (around.storage === null) return ask();
  let noted: string | null;
  try {
    noted = around.storage.getItem(KEY);
  } catch {
    return ask();
  }
  const last = Number(noted);
  if (noted !== null && Number.isFinite(last) && last > 0 && around.now() - last < SOON_MS) return ask();
  try {
    around.storage.setItem(KEY, String(around.now()));
  } catch {
    return ask();
  }
  around.reload();
  return "reloading";
}

/** Whether an error is a part of the site failing to load, as the browsers word it. */
export function isLoadFailure(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /dynamically imported module|Importing a module script failed|Unable to preload|Failed to fetch|ChunkLoadError|Loading chunk/i.test(text);
}

/** Listens for any late-loaded part failing, wherever it was asked for from. Returns a way to stop. */
export function watchForNewVersion(target: Pick<Window, "addEventListener" | "removeEventListener"> = window): () => void {
  // The error is left to reach whoever asked for the part: each has its own way of standing still meanwhile.
  const failed = () => void partFailedToLoad();
  target.addEventListener("vite:preloadError", failed);
  return () => target.removeEventListener("vite:preloadError", failed);
}

/** True once a reload has been tried and a part still does not load: the page then asks for a reload by hand. */
export function useSiteUpdated(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => asking,
    () => false,
  );
}

/** For tests: back to a page on which nothing has failed. */
export function forgetFailures(): void {
  asking = false;
}
