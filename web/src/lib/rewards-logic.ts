// What the Rewards page says, kept apart from how it is drawn so that it can be tested.

import { chainName } from "../../../shared/chains.ts";
import { REWARDS, type PointsReason } from "../../../shared/rewards.ts";

/** Time left as days and a clock: "3d 04:12:55". Nothing left reads "0d 00:00:00". */
export function countdownText(msLeft: number): string {
  const seconds = Math.max(0, Math.floor(msLeft / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${Math.floor(seconds / 86_400)}d ${pad(Math.floor((seconds % 86_400) / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const MOMENT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

/** A week's dates in words, by the clock in UTC: "Mon 5 Oct to Sun 11 Oct". The end given is the moment the next week begins. */
export function weekDates(startIso: string, endIso: string): string {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  return `Mon ${DAY.format(start)} to Sun ${DAY.format(end - 1)}`;
}

/** A moment as a date and a time in UTC: "8 Oct, 14:05". */
export function momentText(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? MOMENT.format(at) : "";
}

/** "2026-W41" as "Week 41, 2026". */
export function weekName(week: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  return match ? `Week ${Number(match[2])}, ${match[1]}` : week;
}

const REASON_WORDS: Record<PointsReason, string> = {
  no_usd_value: "No points: the swap had no dollar value on record.",
};

/** Why a swap on the record added no points, in words. Nothing for a swap that added its points. */
export function reasonWords(reasons: readonly PointsReason[]): string {
  return reasons.map((reason) => REASON_WORDS[reason]).join(" ");
}

/** "ETH on Base to USDT on Solana". */
export function pairText(from: { symbol: string; chain: string }, to: { symbol: string; chain: string }): string {
  return `${from.symbol} on ${chainName(from.chain)} to ${to.symbol} on ${chainName(to.chain)}`;
}

/** Cents as US dollars: 1234n gives "$12.34", 123456789n gives "$1,234,567.89". */
export function usdText(cents: bigint): string {
  const whole = ((cents < 0n ? 0n : cents) / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${whole}.${((cents < 0n ? 0n : cents) % 100n).toString().padStart(2, "0")}`;
}

/** Millionths of a US dollar as dollars and cents, rounded down to the cent. */
export function usdMicroText(micro: bigint): string {
  return usdText(micro / 10_000n);
}

/** A share in hundredths of a percent, with two decimals: 100n gives "1.00%", 10000n gives "100.00%". */
export function shareText(bps: bigint): string {
  return `${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}%`;
}

/** Said under an address's share and its estimate, in these words. */
export const ESTIMATE_NOTE = "An estimate. Your share changes as others swap, and the pool changes until the week closes.";

/** The rules in short, each one a sentence, from the same numbers the server counts by. */
export const RULES_IN_SHORT: readonly string[] = [
  `A delivered swap adds ${REWARDS.pointsPerUsd} points for each $1 swapped: one point for every 10 cents of its dollar value. A swap that is refunded, fails or runs out adds none.`,
  "A week runs from Monday 00:00 to Sunday 23:59 UTC. After it closes, its payout is shared out by points: an address's share is its points out of all the points of that week. It is sent by hand on BNB Chain.",
  "Points have no money value. A payout is at IntentSwap's discretion and can change or stop.",
];
