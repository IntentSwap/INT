// Ghost mode: one switch, on or off, for this tab. While it is on the site loads no wallet
// software, asks nothing of any address but its own, keeps nothing in the browser, and marks the
// orders it makes so that the server deletes each one's record the moment it finishes.
//
// The switch itself is the one thing remembered: a single flag in this tab's own session storage,
// so that loading the page again does not silently turn the mode off. Nothing else is kept.
//
// Turning it on happens where the page stands: a connected wallet is let go of, what the wallet
// software left in the browser is cleared, and the page is put under a stricter content policy.
// A policy can be added to a page and never taken away, so turning it off loads the page again,
// which is also what brings the wallet software back within reach.

import { create } from "zustand";
import { clearBrowser, dropGhostFlag, ghostHolds, holdGhost } from "../lib/kept.ts";
import { letGoOfWallet } from "./wallet.ts";

export { GHOST_KEY, GHOST_ON, ghostFlag, ghostHolds } from "../lib/kept.ts";

/**
 * The content policy of a page in Ghost mode: this site's own origin, and nothing else, for every
 * kind of request a page can make. No frame, worker, plug-in or form at all, because the site has
 * none. Styles written into the page are allowed, as the site's own first screen is one; they
 * name no address, and any address a style did name would fall under the lines for images and fonts.
 *
 * The page's first script writes the same words (web/index.html) when a tab is loaded in the mode,
 * before anything else is fetched. A test holds the two to each other.
 */
export const GHOST_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "manifest-src 'self'",
  "worker-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** How long the wallet software is given to finish its own tidying after a wallet is let go of, before what it wrote meanwhile is cleared too. */
const TIDY_MS = 600;
/** How long the mode's marks are counted as coming in: twice the 200 ms they take (--motion-base in the token file). After that they are simply there. */
const ARRIVING_MS = 400;

interface GhostState {
  /** True while Ghost mode is on. Read this, and nothing else, to know. */
  on: boolean;
  /** True once the mode has been turned on from its explainer since the page was loaded, or the page was loaded with it on. Kept in memory only. */
  explained: boolean;
  /** True for a moment after the mode is turned on where the page stands: its marks come in softly then, and at no other time. */
  fresh: boolean;
  /** Turns the mode on. `clear` also removes what this browser already holds of the site. */
  turnOn(options?: { clear?: boolean }): Promise<void>;
  /** Turns the mode off, and loads the page again. */
  turnOff(): void;
}

/** Puts the page under the mode's content policy. Once there, it stays until the page is loaded again. */
function applyPolicy(): void {
  if (document.head.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null) return;
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = GHOST_POLICY;
  document.head.append(policy);
}

/** Gives the page the mode's calmer cast (see the token file) and its policy, or takes the cast away again. */
function cast(on: boolean): void {
  const root = typeof document === "undefined" ? undefined : (document.documentElement as HTMLElement | undefined);
  if (root === undefined || document.head === undefined) return;
  if (on) {
    root.dataset.ghost = "on";
    applyPolicy();
  } else delete root.dataset.ghost;
}

/**
 * Makes a change to the page as a short cross-fade from how it looked to how it looks, where the
 * browser can do that: it fades one picture of the page out over the other, so no colour is itself
 * animated. Where it cannot, or less movement is asked for, the change is simply made.
 * `changed` settles once the change is on the page; `finished`, once the fade is over.
 */
function crossFade(change: () => void): { changed: Promise<void>; finished: Promise<void> } {
  const still = typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still || typeof document === "undefined" || typeof document.startViewTransition !== "function") {
    change();
    return { changed: Promise.resolve(), finished: Promise.resolve() };
  }
  const settled = () => undefined;
  const transition = document.startViewTransition(() => {
    change();
    // The page is drawn again a moment after its stores change. The browser waits for that before it looks at the new page.
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  return { changed: transition.updateCallbackDone.then(settled, settled), finished: transition.finished.then(settled, settled) };
}

function loadPageAgain(): void {
  if (typeof window !== "undefined") window.location.reload();
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True while the mode is on its way on: a second press meanwhile does nothing. */
let turning = false;

export const useGhost = create<GhostState>((set, get) => ({
  on: ghostHolds(),
  explained: ghostHolds(),
  fresh: false,
  async turnOn(options = {}) {
    if (get().on || turning) return;
    turning = true;
    const ours = options.clear === true;
    try {
      // From this line on the page writes nothing but the flag, and the wallet software cannot be fetched.
      const flagKept = holdGhost();
      const softwareHere = await letGoOfWallet();
      await clearBrowser({ ours });
      if (softwareHere && flagKept) {
        // Wallet software that is already in this page cannot be taken out of it, and may go on
        // running. Only a fresh page is without it: what it wrote while it tidied up is cleared, and
        // the page is loaded again. It comes back in Ghost mode, by the flag, with none of it.
        await pause(TIDY_MS);
        await clearBrowser({ ours });
        loadPageAgain();
        return;
      }
      await crossFade(() => {
        cast(true);
        set({ on: true, explained: true, fresh: true });
      }).changed;
      setTimeout(() => set({ fresh: false }), ARRIVING_MS);
      // The flag could not be kept, so the page is not loaded again: the software's late notes are cleared where it stands.
      if (softwareHere) void pause(TIDY_MS).then(() => clearBrowser({ ours }));
    } finally {
      turning = false;
    }
  },
  turnOff() {
    if (!get().on) return;
    dropGhostFlag();
    void crossFade(() => {
      cast(false);
      set({ on: false, fresh: false });
    }).finished.then(loadPageAgain);
  },
}));

// A page loaded in the mode has its cast and its policy from its first script. They are put here
// once more, which changes nothing where that script ran.
if (ghostHolds()) cast(true);

/** Whether Ghost mode is on, for code that is not a component. */
export const ghostOn = (): boolean => useGhost.getState().on;

/**
 * What an order request says of Ghost mode: `ghost: true` for an order made while the mode is on,
 * and otherwise nothing at all. Only `true` is ever sent.
 */
export function ghostChoice(on: boolean): { ghost?: true } {
  return on ? { ghost: true } : {};
}
