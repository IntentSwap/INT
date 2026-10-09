// Orders made in this browser. Kept only here, in this browser's own storage: the server has no
// list of anyone's orders, and nothing in this list is ever sent anywhere.

import { create } from "zustand";
import type { OrderView } from "../../../shared/api.ts";

const KEY = "orders-v1";
const MAX = 50;

export interface RecentOrder {
  id: string;
  createdAt: string;
  from: { symbol: string; chain: string; decimals: number };
  to: { symbol: string; chain: string; decimals: number };
  amountIn: string;
  amountOut: string;
}

function isRecent(value: unknown): value is RecentOrder {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const coin = (c: unknown) => typeof c === "object" && c !== null && typeof (c as Record<string, unknown>).symbol === "string" && typeof (c as Record<string, unknown>).chain === "string" && typeof (c as Record<string, unknown>).decimals === "number";
  return typeof v.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v.id) && typeof v.createdAt === "string" && coin(v.from) && coin(v.to) && typeof v.amountIn === "string" && /^\d+$/.test(v.amountIn) && typeof v.amountOut === "string" && /^\d+$/.test(v.amountOut);
}

/** Reads the list, dropping anything that is not in the expected shape. */
export function readRecent(raw: string | null): RecentOrder[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** Puts an order at the top of the list, once, and keeps the list to its limit. */
export function withOrder(list: RecentOrder[], order: Pick<OrderView, "id" | "createdAt" | "from" | "to" | "amountIn" | "amountOut">): RecentOrder[] {
  const entry: RecentOrder = {
    id: order.id,
    createdAt: order.createdAt,
    from: { symbol: order.from.symbol, chain: order.from.chain, decimals: order.from.decimals },
    to: { symbol: order.to.symbol, chain: order.to.chain, decimals: order.to.decimals },
    amountIn: order.amountIn,
    amountOut: order.amountOut,
  };
  return [entry, ...list.filter((other) => other.id !== order.id)].slice(0, MAX);
}

function load(): RecentOrder[] {
  try {
    return readRecent(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

function save(list: RecentOrder[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // No storage: the list lasts only as long as this page.
  }
}

interface OrdersState {
  orders: RecentOrder[];
  /** Saved before anything is paid, so a closed tab can find its way back to the order. */
  remember(order: Pick<OrderView, "id" | "createdAt" | "from" | "to" | "amountIn" | "amountOut">): void;
  /** Adds orders that are not on the list yet, each in its place by when it was made. Used on a practice server for its sample orders. */
  addOlder(orders: readonly Pick<OrderView, "id" | "createdAt" | "from" | "to" | "amountIn" | "amountOut">[]): void;
  /** Drops one order from the list: the server no longer has it. */
  forget(id: string): void;
  clear(): void;
}

export const useOrders = create<OrdersState>((set, get) => ({
  orders: load(),
  remember(order) {
    const orders = withOrder(get().orders, order);
    save(orders);
    set({ orders });
  },
  addOlder(more) {
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
