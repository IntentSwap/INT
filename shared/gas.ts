// "Add gas": beside a swap, a second, small order that delivers a little of the receiving chain's
// own coin to the same receiving address, so that a wallet with nothing in it can pay that chain's
// network fees straight away. It is an ordinary order in every way: its own quote, its own deposit
// address, its own deadline and its own refund.
//
// This file holds what the page and the server must agree on: which coin a chain's own coin is,
// how big a gas order is, and how its amount is worked out. Whether one is made, how it is routed
// and where it delivers are the server's alone (server/gas.ts): the receiving address of a gas
// order is always the swap's, and its routing is always private.

import { usdScaled, USD_SCALE } from "./amounts.ts";

/** The sizes a gas order comes in, in whole US dollars, smallest first. There is none above the last. */
export const GAS_SIZES_USD = [3, 5, 10] as const;
export type GasSize = (typeof GAS_SIZES_USD)[number];

/** The usual size: about three dollars of the chain's own coin. */
export const GAS_USD: GasSize = 3;

/**
 * The chains with a size of their own, by the chain's code, each with its reason. A chain gets more
 * than the usual size where that would not pay for about three ordinary transfers of a token, or
 * where the provider will not take an order that small (as it answered previews on 10 Oct 2026).
 */
const SIZE_BY_CHAIN: ReadonlyMap<string, GasSize> = new Map<string, GasSize>([
  // Ethereum's network fee rises several-fold on a busy day: three dollars pays for three transfers of a token only on a quiet one.
  ["eth", 5],
  // The provider answers a three-dollar order to Gnosis with "no liquidity", and a five-dollar one with a quote.
  ["gnosis", 5],
  // Sending a token on Tron uses up several TRX each time: three dollars does not pay for three transfers.
  ["tron", 10],
]);

/** How many dollars of its own coin a gas order to this chain is for. */
export function gasSizeFor(chain: string): GasSize {
  return SIZE_BY_CHAIN.get(chain) ?? GAS_USD;
}

/** True for one of the sizes above, and for nothing else. */
export function isGasSize(value: unknown): value is GasSize {
  return (GAS_SIZES_USD as readonly unknown[]).includes(value);
}

interface Listed {
  id: string;
  chain: string;
  contract: string | null;
}

/**
 * A chain's own coin among the listed coins: the one coin on that chain that has no contract.
 * Null where the list has none for the chain, and also where it has more than one: a coin is
 * delivered as gas only where there is no doubt which coin pays that chain's fees.
 */
export function ownCoinOf<T extends Listed>(chain: string, coins: Iterable<T>): T | null {
  let found: T | null = null;
  for (const coin of coins) {
    if (coin.chain !== chain || coin.contract !== null) continue;
    if (found !== null) return null;
    found = coin;
  }
  return found;
}

/**
 * The coin a gas order beside this swap would deliver, or null where there is nothing to add: the
 * coin received is already its chain's own coin, the chain has none listed, or the chain's own coin
 * is the very coin being paid with (an order cannot swap a coin for itself).
 */
export function gasCoinFor<T extends Listed>(from: Listed, to: Listed, coins: Iterable<T>): T | null {
  if (to.contract === null) return null;
  const own = ownCoinOf(to.chain, coins);
  return own === null || own.id === from.id ? null : own;
}

/**
 * How much of the paying coin a gas order of `usd` dollars is, in the coin's smallest unit, at the
 * list's price for it (scaled by 10^18). Whole numbers throughout, rounded down. Null where the
 * coin has no price, or the amount would come to nothing.
 *
 * The price decides only how big the order is. What it buys is the provider's quote, verified like
 * any quote, and the person reviews the exact amount before anything is made.
 */
export function gasAmountOf(usd: GasSize, decimals: number, priceScaled: bigint | null): bigint | null {
  if (priceScaled === null || priceScaled <= 0n) return null;
  const raw = (BigInt(usd) * USD_SCALE * 10n ** BigInt(decimals)) / priceScaled;
  return raw > 0n ? raw : null;
}

/** How far the dollar value of a reviewed gas amount may be from a size, either way, in basis points: prices move between the review and the order. */
export const GAS_DRIFT_BPS = 1_000n;

/**
 * Whether an amount of the paying coin is a gas order's amount: at the list's price now, worth no
 * less than the smallest size and no more than the largest, give or take the drift above. The
 * server asks this of the amount an order request names, so that "gas" is never a way to make a
 * second order of any size.
 */
export function isGasAmount(raw: bigint, decimals: number, priceScaled: bigint | null): boolean {
  if (priceScaled === null || priceScaled <= 0n || raw <= 0n) return false;
  const worth = usdScaled(raw, decimals, priceScaled);
  const least = (BigInt(GAS_SIZES_USD[0]) * USD_SCALE * (10_000n - GAS_DRIFT_BPS)) / 10_000n;
  const most = (BigInt(GAS_SIZES_USD[GAS_SIZES_USD.length - 1] ?? GAS_USD) * USD_SCALE * (10_000n + GAS_DRIFT_BPS)) / 10_000n;
  return worth >= least && worth <= most;
}
