// Ghost mode: one switch, on or off, for this tab. While it is on the site loads no wallet
// software, asks nothing of any address but its own, keeps nothing in the browser, and marks the
// orders it makes so that the server deletes each one's record the moment it finishes.
//
// The switch itself is the one thing remembered: a single flag in this tab's own session storage,
// so that loading the page again does not silently turn the mode off. Nothing else is kept.

import { create } from "zustand";

/** The one key Ghost mode keeps, in session storage, and its one value. */
export const GHOST_KEY = "ghost";
export const GHOST_ON = "on";

/** Whether this tab was left in Ghost mode. Storage that cannot be read is taken as "off". */
export function ghostFlag(): boolean {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(GHOST_KEY) === GHOST_ON;
  } catch {
    return false;
  }
}

interface GhostState {
  /** True while Ghost mode is on. Read this, and nothing else, to know. */
  on: boolean;
  /** Turns the mode on. `clear` also removes what this browser already holds of the site. */
  turnOn(options?: { clear?: boolean }): Promise<void>;
  /** Turns the mode off. */
  turnOff(): void;
}

export const useGhost = create<GhostState>((set) => ({
  on: ghostFlag(),
  async turnOn() {
    try {
      sessionStorage.setItem(GHOST_KEY, GHOST_ON);
    } catch {
      // Without storage the mode lasts until the page is loaded again.
    }
    set({ on: true });
  },
  turnOff() {
    try {
      sessionStorage.removeItem(GHOST_KEY);
    } catch {
      // Nothing was kept, so there is nothing to remove.
    }
    set({ on: false });
  },
}));

/** Whether Ghost mode is on, for code that is not a component. */
export const ghostOn = (): boolean => useGhost.getState().on;
