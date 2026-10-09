// What the Stats page says, kept apart from how it is drawn.

import type { StatsBand, StatsCoin, StatsWhen } from "../../../shared/api.ts";
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

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "2026-10-08" as "8 Oct". */
export function dayText(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(at) ? DAY.format(at) : day;
}

/** "ETH on Base". */
export const coinText = (coin: StatsCoin): string => `${coin.symbol} on ${chainName(coin.chain)}`;
