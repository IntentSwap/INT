// What the Stats page says, kept apart from how it is drawn.

import type { StatsCoin, StatsResponse, StatsShare } from "../../../shared/api.ts";
import { chainName } from "../../../shared/chains.ts";
import { clockTime } from "./order-logic.ts";

/**
 * True where the site has its Stats page. The server's settings decide. Until they have arrived the
 * page's own mark is read: the server marks the page it serves where the Stats page is switched off
 * (server/static.ts), so the navigation is right from the first moment and nothing moves when the
 * settings come.
 */
export function statsPageOn(config: { statsPage?: unknown } | null | undefined): boolean {
  if (config === null || config === undefined) return typeof document !== "undefined" && document.documentElement.dataset.stats !== "off";
  return config.statsPage === true;
}

/**
 * When a swap began on the sending side, as "Recent swaps" writes it, on this device's clock: the date in
 * numbers, so it reads the same everywhere, then the time of day as an order's page writes one.
 * "2026-10-08, 14:05".
 */
export function whenText(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}, ${clockTime(at)}`;
}

/** A transaction's hash, shortened to its first six and its last four characters: "0x3f9a…c21e". */
export const shortTx = (hash: string): string => `${hash.slice(0, 6)}…${hash.slice(-4)}`;

/** A whole number with its thousands marked: "12,345". */
export const wholeText = (value: number): string => Math.max(0, Math.round(value)).toLocaleString("en-US");

/** Whole US dollars: "$12,345". */
export const usdText = (dollars: number): string => `$${wholeText(dollars)}`;

/** A length of time in seconds, as it is said: "48s", "1m 12s", "1h 4m". */
export function durationText(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`;
  return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`;
}

/** "ETH on Base". */
export const coinText = (coin: StatsCoin): string => `${coin.symbol} on ${chainName(coin.chain)}`;

/** One chain of the "Chains used" grid. `used` is null for a chain no delivered swap has been sent from. */
export interface GridChain {
  key: string;
  name: string;
  used: { swaps: number; share: StatsShare } | null;
}

/**
 * The chains of the "Chains used" grid: every chain on the coin list, in the order the list gives
 * them (the order of the coin picker and of the strip of chains), each with its figures if it has
 * been used. A chain that has been used and is not on the list follows them, by name, so that as
 * many chains are lit as the count of used chains says.
 */
export function chainGrid(listed: readonly { key: string; name: string }[], used: StatsResponse["chainsUsed"]): GridChain[] {
  const figures = new Map(used.map((item) => [item.chain, { swaps: item.swaps, share: item.share }]));
  const onList = new Set(listed.map((chain) => chain.key));
  const others = used.filter((item) => !onList.has(item.chain)).map((item) => ({ key: item.chain, name: chainName(item.chain) }));
  others.sort((a, b) => a.name.localeCompare(b.name));
  return [...listed, ...others].map((chain) => ({ key: chain.key, name: chain.name, used: figures.get(chain.key) ?? null }));
}

/**
 * A used chain's figures, in one line: "Base: 12 swaps, 31% of volume". A chain known to have been
 * sent from, with no count of how many swaps that was (its figures come from before they were
 * counted), is given its share alone: it is not said to have had none.
 */
export function chainLine(name: string, swaps: number, share: StatsShare): string {
  const count = swaps === 0 ? "" : `${wholeText(swaps)} ${swaps === 1 ? "swap" : "swaps"}, `;
  return `${name}: ${count}${share === "<1" ? "under 1%" : `${share}%`} of volume`;
}
