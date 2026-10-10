// What this site keeps in the browser, and the one way to it. Every read and every write of the
// browser's storage goes through this file, and a test holds that no other file of the site names
// the browser's storage at all. So one rule can be kept in one place:
//
// while Ghost mode holds, the site writes nothing, and reads as if nothing were kept. What an
// earlier visit saved stays where it is, unread, unless the person asks for it to be cleared.
//
// The one thing kept in the mode is the mode's own switch: a single flag in this tab's session
// storage, so that loading the page again does not silently turn the mode off. It is read and
// written here too, and with it this file knows whether the page is held to the mode.

/** The one key Ghost mode keeps, in session storage, and its one value. */
export const GHOST_KEY = "ghost";
export const GHOST_ON = "on";

type Area = "local" | "session";

/** One thing the site keeps: which of the browser's two storages it is in, and under what name. */
export interface Kept {
  readonly area: Area;
  readonly key: string;
}

/** Everything the site keeps besides that flag, by name. Nothing is ever written under any other key. */
export const KEPT = {
  /** The orders made in this browser (stores/orders.ts). */
  orders: { area: "local", key: "orders-v1" },
  /** The coin list, for up to 24 hours (stores/tokens.ts). */
  coins: { area: "local", key: "coins-v1" },
  /** The transfers sent from a connected wallet (stores/sent.ts). */
  sent: { area: "local", key: "sent-v1" },
  /** That the orders a server names were put on the list of orders, once (stores/app.ts). */
  listed: { area: "local", key: "orders-seeded-v1" },
  /** When the page last loaded itself again for a new version of the site (lib/stale.ts). */
  reloaded: { area: "session", key: "reloaded-for-new-version" },
} as const satisfies Record<string, Kept>;

/** One of the browser's two storages, or null where there is none or it may not be touched. */
function storage(area: Area): Storage | null {
  try {
    if (area === "local") return typeof localStorage === "undefined" ? null : localStorage;
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Whether this tab was left in Ghost mode. Storage that cannot be read is taken as "off". */
export function ghostFlag(): boolean {
  try {
    return storage("session")?.getItem(GHOST_KEY) === GHOST_ON;
  } catch {
    return false;
  }
}

/**
 * True from the moment Ghost mode is turned on until the page is next loaded. Turning the mode off
 * loads the page again, so a page that has once been held is held for as long as it lives: it
 * writes nothing, and it never fetches the wallet software.
 */
let holding = ghostFlag();

/** Whether this page is held to Ghost mode. */
export function ghostHolds(): boolean {
  return holding;
}

/**
 * Ghost mode is being turned on. From this call on nothing is written but the flag itself.
 * Answers whether the flag could be kept: where it could not, the mode lasts until the page is loaded again.
 */
export function holdGhost(): boolean {
  holding = true;
  try {
    const session = storage("session");
    if (session === null) return false;
    session.setItem(GHOST_KEY, GHOST_ON);
    return session.getItem(GHOST_KEY) === GHOST_ON;
  } catch {
    return false;
  }
}

/** Ghost mode is being turned off: the flag goes, so the next load of the page is an ordinary one. The page stays held until then. */
export function dropGhostFlag(): void {
  try {
    storage("session")?.removeItem(GHOST_KEY);
  } catch {
    // Nothing was kept, so there is nothing to remove.
  }
}

/** What is kept under a name. Null when nothing is, when there is nowhere to keep it, and always in Ghost mode. */
export function readKept(item: Kept): string | null {
  if (holding) return null;
  try {
    return storage(item.area)?.getItem(item.key) ?? null;
  } catch {
    return null;
  }
}

/** Keeps a text under a name, and answers whether it was kept: never in Ghost mode, and not where the browser refuses. */
export function writeKept(item: Kept, value: string): boolean {
  if (holding) return false;
  try {
    const kept = storage(item.area);
    if (kept === null) return false;
    kept.setItem(item.key, value);
    return true;
  } catch {
    return false;
  }
}

/** Takes away what is kept under a name. In Ghost mode nothing is touched: what an earlier visit kept stays as it was. */
export function dropKept(item: Kept): void {
  if (holding) return;
  try {
    storage(item.area)?.removeItem(item.key);
  } catch {
    // No storage: there was nothing to take away.
  }
}

/**
 * One kept thing as the two calls a caller with its own ways needs (lib/stale.ts). Null in Ghost
 * mode and where the browser has no storage: there is then nowhere to note anything.
 */
export function keptPlace(item: Kept): Pick<Storage, "getItem" | "setItem"> | null {
  if (holding || storage(item.area) === null) return null;
  return {
    getItem: () => readKept(item),
    setItem: (_key, value) => {
      if (!writeKept(item, value)) throw new Error("not kept");
    },
  };
}

/** The names of everything in one storage, read before any of it is taken out. */
function names(kept: Storage): string[] {
  const all: string[] = [];
  for (let index = 0; index < kept.length; index++) {
    const name = kept.key(index);
    if (name !== null) all.push(name);
  }
  return all;
}

/**
 * Takes out of the browser's storage, of both kinds, every entry whose text still names something:
 * a wallet's address, once the wallet is disconnected. The Ghost flag names nothing and is never among them.
 */
export function dropNaming(text: string): void {
  const named = text.toLowerCase();
  if (named === "") return;
  for (const area of ["local", "session"] as const) {
    try {
      const kept = storage(area);
      if (kept === null) continue;
      for (const name of names(kept)) if ((kept.getItem(name) ?? "").toLowerCase().includes(named)) kept.removeItem(name);
    } catch {
      // Storage that cannot be read holds nothing that can be taken out.
    }
  }
}

/** Whether an entry is one of the site's own, by the storage it is in and its name. */
function isOurs(area: Area, name: string): boolean {
  return Object.values(KEPT).some((item) => item.area === area && item.key === name);
}

/**
 * Clears what the browser holds for this site, as Ghost mode turns on. The Ghost flag always stays.
 *
 * Whatever is not the site's own goes every time: that is what the wallet software left (its notes
 * in both storages, under many names, and its databases). Names are not chased: every entry that is
 * not one of the site's own named ones is removed. The site makes no database of its own, so every
 * database there is, is one of them.
 *
 * With `ours`, the site's own entries go too: the list of orders, the coin list and the rest.
 */
export async function clearBrowser(options: { ours: boolean }): Promise<void> {
  for (const area of ["local", "session"] as const) {
    try {
      const kept = storage(area);
      if (kept === null) continue;
      for (const name of names(kept)) {
        if (area === "session" && name === GHOST_KEY) continue;
        if (!options.ours && isOurs(area, name)) continue;
        kept.removeItem(name);
      }
    } catch {
      // Storage that cannot be read holds nothing that can be taken out.
    }
  }
  try {
    // Not every browser can list its databases. One that cannot has nothing here that could be named.
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return;
    for (const { name } of await indexedDB.databases()) if (typeof name === "string") indexedDB.deleteDatabase(name);
  } catch {
    // The same: nothing that can be reached.
  }
}
