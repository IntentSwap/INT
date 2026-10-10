// Pure rules behind "Add gas" on the swap card and in the review. No browser APIs here, so every rule is unit-tested.
//
// Gas is a second, small order beside a swap: a little of the receiving chain's own coin, sent to
// the swap's receiving address (see shared/gas.ts). The page decides almost nothing about it. Once
// a valid receiving address is on the card (and not before: see buildGasBody in stores/swap.ts), it
// asks the server whether gas can be added, and shows a switch only where the answer is a preview;
// it sends back the amount and the numbers of the preview the person reviewed, and nothing else;
// and it holds the gas order that comes back to what was reviewed, as it does the swap.

import { isDigits } from "../../../shared/amounts.ts";
import type { CreateOrderBody, GasLine, GasQuote, QuoteView, TokenView } from "../../../shared/api.ts";
import { gasCoinFor, isGasSize } from "../../../shared/gas.ts";
import { routedPrivately, type PrivacyMode } from "./swap-logic.ts";

/** The switch's name on the card. */
export const GAS_LABEL = "Add gas";
/** Said in the review before an order with gas is confirmed. */
export const TWO_PAYMENTS = "There are two payments: one for the swap and one for the gas.";
/** Said in the review when gas was part of it and no longer is: its preview was refused when it was asked for again. */
export const GAS_WITHDRAWN = "Gas cannot be added right now, so it is no longer part of this order. The swap is unaffected.";

/** The one line under the switch's name: how much arrives, of which coin, and why it helps. */
export function gasLine(usd: number, symbol: string): string {
  return `About $${usd} of ${symbol} arrives at the same address, so a new wallet can move straight away.`;
}

/**
 * The coin a gas order beside the swap on the card would deliver, or null where gas cannot be
 * added and nothing is asked of the server at all. As far as the page can tell by itself: gas goes
 * only beside a privately routed swap, so the server must route privately and the person must not
 * have chosen public routing for this swap; and the pair must have a coin to deliver (gasCoinFor).
 * (Where there is such a coin, the card still asks nothing until it has a valid receiving address.)
 */
export function gasCoinOnCard(mode: PrivacyMode, withoutPrivate: boolean, from: TokenView | null, to: TokenView | null, coins: Iterable<TokenView>): TokenView | null {
  if (mode !== "basic" || withoutPrivate || from === null || to === null) return null;
  return gasCoinFor(from, to, coins);
}

/**
 * The preview in the server's answer about gas, or null where gas is not offered. An answer is
 * shown only if it is the one that was asked for: paid with the swap's coin, delivering the
 * receiving chain's own coin, in one of the set sizes, privately routed, with amounts that are
 * whole numbers. Anything else is read as "not offered": the card then shows no switch.
 */
export function gasOffered(answer: unknown, from: Pick<TokenView, "id">, coin: Pick<TokenView, "id">): GasQuote | null {
  if (typeof answer !== "object" || answer === null) return null;
  const gas = (answer as { gas?: unknown }).gas;
  if (typeof gas !== "object" || gas === null) return null;
  const { usd, quote } = gas as Partial<GasQuote>;
  if (!isGasSize(usd) || typeof quote !== "object" || quote === null) return null;
  if (quote.from !== from.id || quote.to !== coin.id) return null;
  // A gas order is never routed in public. A preview that is not private is not one of a gas order.
  if (!routedPrivately(quote)) return null;
  if (!isDigits(quote.amountIn) || !isDigits(quote.amountOut) || !isDigits(quote.minAmountOut) || BigInt(quote.amountIn) === 0n) return null;
  const fees = quote.fees as Partial<QuoteView["fees"]> | undefined;
  if (typeof fees !== "object" || fees === null || !Number.isInteger(fees.appBps) || !Number.isInteger(fees.providerBps) || !isDigits(fees.appAmount) || !isDigits(fees.providerAmount)) return null;
  if (quote.withdrawFee !== null && !isDigits(quote.withdrawFee)) return null;
  return { usd, quote };
}

/** The gas order as the review shows it: the preview, and the coin it delivers. */
export interface GasPart extends GasQuote {
  coin: TokenView;
}

/**
 * The gas that is part of the order being reviewed, or null where there is none: gas is switched
 * off, there is no preview, or the preview is not of this swap's paying coin and a listed coin.
 * Only what this returns is shown in the review, added to the total, and sent with the order.
 */
export function gasPart(on: boolean, gas: GasQuote | null, from: Pick<TokenView, "id"> | null, coins: ReadonlyMap<string, TokenView>): GasPart | null {
  if (!on || gas === null || from === null || gas.quote.from !== from.id) return null;
  const coin = coins.get(gas.quote.to) ?? null;
  return coin === null ? null : { usd: gas.usd, quote: gas.quote, coin };
}

/**
 * What an order request says of gas: the amount of the preview that was reviewed and its numbers,
 * when gas is part of the order, and otherwise nothing at all. Where the gas goes, where a refund
 * of it goes, which coin it delivers and how it is routed are no part of a request: the server sets each.
 */
export function gasChoice(part: GasPart | null): Pick<CreateOrderBody, "gas"> {
  if (part === null) return {};
  const { quote } = part;
  return { gas: { amount: quote.amountIn, reviewed: { amountOut: quote.amountOut, minAmountOut: quote.minAmountOut, totalFeeBps: quote.fees.appBps + quote.fees.providerBps, ...(quote.routing !== undefined ? { routing: quote.routing } : {}) } } };
}

/** What is sent in all: the swap's amount and the gas order's, of the one coin both are paid with. Whole numbers, added exactly. */
export function totalSent(swapAmountIn: string, gasAmountIn: string): bigint {
  return BigInt(swapAmountIn) + BigInt(gasAmountIn);
}

/**
 * The gas order's numbers as one piece of text, for telling when what is on screen has changed:
 * new numbers must be on screen for a moment before they can be confirmed, and so must gas going
 * out of the review. Empty where gas is no part of the order.
 */
export function gasKey(part: GasPart | null): string {
  if (part === null) return "";
  const { quote } = part;
  return `|gas|${part.usd}|${quote.to}|${quote.amountIn}|${quote.amountOut}|${quote.minAmountOut}|${quote.fees.appBps}|${quote.fees.providerBps}`;
}

/** How old a quote or a preview is, for the review: nothing there, being asked for, fit to confirm, or too old. */
export type Age = "none" | "loading" | "ready" | "expired";

/**
 * The age the review acts on. It is the quote's, until the quote is fit to confirm; then, where gas
 * is part of the order, its preview must be fit too: one being asked for again is waited for, and
 * one too old is refreshed first, exactly as an old quote is. (`gas` is "none" where there is no gas.)
 */
export function reviewAge(quote: Age, gas: Age): Age {
  return quote === "ready" && gas !== "none" ? gas : quote;
}

/** What the person had in front of them of the gas order when they confirmed. The two addresses are the swap's own. */
export interface ReviewedGas {
  /** The coin both orders are paid with. */
  from: string;
  /** The coin the gas order delivers: the receiving chain's own. */
  to: string;
  amountIn: string;
  recipient: string;
  refundTo: string;
}

/**
 * Compares what the server says became of the gas with what was reviewed. Returns what differs, or
 * null when nothing does. Nothing is paid unless this is null.
 *
 * With gas reviewed: a gas order that was made must go to the swap's own receiving address, refund
 * to the swap's own refund address, be paid with the same coin, deliver the coin that was shown,
 * be for the amount that was shown, and be privately routed. "Could not be added" differs from
 * nothing: no gas order exists, the swap is whole, and its page says so. An answer that does not
 * say what became of the gas is not the order that was reviewed.
 * With no gas reviewed: there must be no gas order.
 */
export function gasDiffers(line: GasLine | undefined, reviewed: ReviewedGas | null): string | null {
  if (reviewed === null) return line !== undefined && line.made ? "gas you did not ask for" : null;
  if (line === undefined) return "the gas";
  if (!line.made) return null;
  const order = line.order;
  if (order === null) return "the gas";
  if (order.recipient !== reviewed.recipient) return "the address the gas goes to";
  if (order.refundTo !== reviewed.refundTo) return "the refund address of the gas";
  if (order.from.id !== reviewed.from) return "the coin the gas is paid with";
  if (order.to.id !== reviewed.to) return "the coin that arrives as gas";
  if (order.amountIn !== reviewed.amountIn) return "the amount sent for the gas";
  if (!routedPrivately(order)) return "the routing of the gas";
  return null;
}
