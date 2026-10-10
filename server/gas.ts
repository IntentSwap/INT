// "Add gas", the server's part: what a gas order is made from, and how it is found again.
//
// A gas order is a second, small, ordinary order beside a swap (shared/gas.ts says what the page
// and the server agree on). Three things about it are decided here and nowhere else, and no
// request can say otherwise:
//
//   - where it delivers: the swap's receiving address, and no other;
//   - where it refunds: the swap's refund address;
//   - how it is routed: privately, or it is not made.
//
// They hold by construction. A gas order's input is made from the swap's own input, after that
// has been checked, and from nothing else: this file never sees a request.
//
// The two orders are paired by one thing only: the gas order's ID is worked out from the swap's.
// There is no index of pairs, and a gas order's record holds nothing that leads back to its swap.

import { createHash } from "node:crypto";
import { gasAmountOf, gasCoinFor, gasSizeFor } from "../shared/gas.ts";
import { SLIPPAGE_BPS, type QuoteInput } from "./quotes.ts";
import type { Token } from "./tokens.ts";

/**
 * The ID of the gas order made beside a swap: the first 27 characters of the SHA-256 of "gas:" and
 * the swap's ID, in URL-safe base64. It has the shape of any order's ID, and is found from the
 * swap's ID by anyone who holds that. The swap's ID cannot be had back from it.
 */
export function gasIdOf(swapId: string): string {
  return createHash("sha256").update(`gas:${swapId}`).digest("base64url").slice(0, 27);
}

/**
 * The input of the gas order beside a swap, or null where none is made.
 *
 * Everything in it is the swap's, as the swap's input holds it: the coin paid with, the way of
 * paying, the sender, the receiving address and the refund address. Three things are its own. The
 * coin it delivers is the receiving chain's own coin (so the receiving address, checked for that
 * chain, is an address of the coin's chain). Its amount is the one given. Its slippage limit is
 * the usual one, whatever the swap's is: a gas order's preview is always worked out with the usual
 * limit, and the order is made with what was previewed.
 *
 * It is routed privately, always. Where the swap itself is not (the server routes in public, or
 * the person chose public routing for this swap) there is no gas order: a public one would publish
 * the very link between two wallets that gas by this route is there to avoid. And there is none
 * where there is no coin to deliver (see `gasCoinFor`).
 */
export function gasInputFor(input: QuoteInput, coins: Iterable<Token>, amount: bigint): QuoteInput | null {
  if (input.confidentiality !== "basic") return null;
  const to = gasCoinFor(input.from, input.to, coins);
  if (to === null) return null;
  return { ...input, to, amount, slippageBps: SLIPPAGE_BPS, confidentiality: "basic" };
}

/**
 * How much of the paying coin a gas order to a chain is, when one is previewed: the chain's size in
 * dollars, at the list's price for the coin. Null where the coin has no price.
 */
export function gasPreviewAmount(from: Token, toChain: string): bigint | null {
  return gasAmountOf(gasSizeFor(toChain), from.decimals, from.priceScaled);
}
