// Orders made in this browser. Kept only here, in this browser's own storage: the server has no
// list of anyone's orders, and nothing in this list is ever sent anywhere. An entry is the order's
// ID, when it was made and its two coins: no amount and no address, so that nothing a person typed
// into the swap card is ever kept in the browser.
//
// In Ghost mode there is no list: nothing is added to it, and what an earlier visit kept is neither
// shown nor touched (lib/kept.ts reads as empty and writes nothing while the mode holds).

import { create } from "zustand";
import type { OrderView } from "../../../shared/api.ts";
import { coinLogoName } from "../lib/icons.ts";
import { dropKept, ghostHolds, KEPT, readKept, writeKept } from "../lib/kept.ts";
import { useGhost } from "./ghost.ts";

const MAX = 50;

export interface RecentOrder {
  id: string;
  createdAt: string;
  from: { symbol: string; chain: string; decimals: number };
  /** The coin received is drawn on its row: the name of its logo is kept for that, where it has one (never its contract). */
  to: { symbol: string; chain: string; decimals: number; logo?: string };
}

function isRecent(value: unknown): value is RecentOrder {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const coin = (c: unknown) => typeof c === "object" && c !== null && typeof (c as Record<string, unknown>).symbol === "string" && typeof (c as Record<string, unknown>).chain === "string" && typeof (c as Record<string, unknown>).decimals === "number";
  const logo = (v.to as Record<string, unknown> | null)?.logo;
  if (logo !== undefined && (typeof logo !== "string" || !/^[a-z0-9]{1,24}$/.test(logo))) return false;
  return typeof v.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v.id) && typeof v.createdAt === "string" && coin(v.from) && coin(v.to);
}

/** Reads the list, dropping anything that is not in the expected shape. */
export function readRecent(raw: string | null): RecentOrder[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    // Only the parts an entry is meant to hold are taken: a list saved by an earlier version, which also held amounts, loses them here.
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, MAX).map((entry) => ({ id: entry.id, createdAt: entry.createdAt, from: { symbol: entry.from.symbol, chain: entry.from.chain, decimals: entry.from.decimals }, to: { symbol: entry.to.symbol, chain: entry.to.chain, decimals: entry.to.decimals, ...(entry.to.logo === undefined ? {} : { logo: entry.to.logo }) } })) : [];
  } catch {
    return [];
  }
}

/** Puts an order at the top of the list, once, and keeps the list to its limit. */
export function withOrder(list: RecentOrder[], order: Pick<OrderView, "id" | "createdAt" | "from" | "to">): RecentOrder[] {
  const logo = coinLogoName(order.to.chain, order.to.contract);
  const entry: RecentOrder = {
    id: order.id,
    createdAt: order.createdAt,
    from: { symbol: order.from.symbol, chain: order.from.chain, decimals: order.from.decimals },
    to: { symbol: order.to.symbol, chain: order.to.chain, decimals: order.to.decimals, ...(logo === undefined ? {} : { logo }) },
  };
  return [entry, ...list.filter((other) => other.id !== order.id)].slice(0, MAX);
}

function load(): RecentOrder[] {
  const raw = readKept(KEPT.orders);
  const list = readRecent(raw);
  // A list saved by an earlier version held amounts: it is written back at once without them.
  if (raw !== null && raw.includes("amount")) save(list);
  return list;
}

/** Without storage the list lasts only as long as this page. */
function save(list: RecentOrder[]): void {
  if (list.length === 0) dropKept(KEPT.orders);
  else writeKept(KEPT.orders, JSON.stringify(list));
}

interface OrdersState {
  orders: RecentOrder[];
  /** Saved before anything is paid, so a closed tab can find its way back to the order. */
  remember(order: Pick<OrderView, "id" | "createdAt" | "from" | "to">): void;
  /** Adds orders that are not on the list yet, each in its place by when it was made. Used on a practice server for its sample orders. */
  addOlder(orders: readonly Pick<OrderView, "id" | "createdAt" | "from" | "to">[]): void;
  /** Drops one order from the list: the server no longer has it. */
  forget(id: string): void;
  clear(): void;
}

export const useOrders = create<OrdersState>((set, get) => ({
  orders: load(),
  remember(order) {
    // An order made in Ghost mode is on no list: it is reached by its own link, and by nothing kept here.
    if (ghostHolds()) return;
    const orders = withOrder(get().orders, order);
    save(orders);
    set({ orders });
  },
  addOlder(more) {
    if (ghostHolds()) return;
    const held = new Set(get().orders.map((order) => order.id));
    const fresh = more.filter((order) => !held.has(order.id));
    if (fresh.length === 0) return;
    let orders = get().orders;
    for (const order of fresh) orders = withOrder(orders, order);
    orders = [...orders].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    save(orders);
    set({ orders });
  },
  forget(id) {
    const orders = get().orders.filter((order) => order.id !== id);
    if (orders.length === get().orders.length) return;
    save(orders);
    set({ orders });
  },
  clear() {
    save([]);
    set({ orders: [] });
  },
}));

// As Ghost mode turns on, the list on screen empties. What the browser holds of it is left as it was.
useGhost.subscribe((ghost) => {
  if (ghost.on && useOrders.getState().orders.length > 0) useOrders.setState({ orders: [] });
});
