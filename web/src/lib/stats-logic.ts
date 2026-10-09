// What the Stats page says, kept apart from how it is drawn.

import type { StatsBand, StatsCoin, StatsResponse, StatsShare, StatsWhen } from "../../../shared/api.ts";
import { chainName } from "../../../shared/chains.ts";

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

/** A swap's size and time, as "Recent swaps" says them: a band and a stretch of the day, never a figure. */
export const BAND_WORDS: Readonly<Record<StatsBand, string>> = { "under-100": "under $100", "100-1k": "$100 to $1k", "1k-10k": "$1k to $10k", "over-10k": "over $10k" };
export const WHEN_WORDS: Readonly<Record<StatsWhen, string>> = { "last-hour": "in the last hour", "earlier-today": "earlier today", yesterday: "yesterday" };

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

/** One chain of the "Chains used" grid. `used` is null for a chain no delivered swap has started or ended on. */
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

/** A used chain's figures, in one line: "Base: 12 swaps, 31% of volume". */
export function chainLine(name: string, swaps: number, share: StatsShare): string {
  return `${name}: ${wholeText(swaps)} ${swaps === 1 ? "swap" : "swaps"}, ${share === "<1" ? "under 1%" : `${share}%`} of volume`;
}
