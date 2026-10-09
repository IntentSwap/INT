// Builds provider quote requests, and turns provider answers into our own
// views and plain-word errors. Whether a fee of ours goes with a quote, how
// much and to whom come from server configuration only; nothing a browser
// sends can change them. The same goes for the routing level: it is the
// server's setting, and the one thing a request can say about it is "not
// private, this once".

import { addressMessage } from "../shared/address-words.ts";
import { checkAddress } from "../shared/addresses.ts";
import { MAX_RAW, decimalToScaled, parseRaw, priceImpactBps, usdScaled, USD_SCALE } from "../shared/amounts.ts";
import { routingOf, SLIPPAGE, SLIPPAGE_BOUNDS_WORDS, type Confidentiality, type PayMethod, type QuoteView, type Routing } from "../shared/api.ts";
import { chainName, payWindowMs } from "../shared/chains.ts";

export { addressMessage };
import { feeView } from "./fees.ts";
import { HttpError } from "./http.ts";
import { isPlaceholder, placeholderFor } from "./placeholders.ts";
import type { Token } from "./tokens.ts";
import type { SentQuote, VerifiedQuote } from "./verify.ts";

/** The slippage limit when a request names none. */
export const SLIPPAGE_BPS = SLIPPAGE.default;
export const QUOTE_WAIT_MS = 3000;
export const REFERRAL = "intentswap";
export const MAX_USD = 1_000_000n;

/** When refunds begin if the swap has not completed. The interface shows the same figure before an order is made. */
export function deadlineMs(pay: PayMethod, originChain: string): number {
  return payWindowMs(pay, originChain);
}

/** Validates a user address for a chain or throws the matching 400. */
export function requireAddress(chainKey: string, value: unknown, code: "invalid_recipient" | "invalid_refund" | "invalid_sender"): string {
  const check = checkAddress(chainKey, value);
  if (!check.ok) throw new HttpError(400, code, addressMessage(chainKey, check.error, check.looksLike), { detail: { reason: check.error } });
  return check.address;
}

export interface QuoteInput {
  from: Token;
  to: Token;
  amount: bigint;
  pay: PayMethod;
  recipient: string;
  refundTo: string;
  sender: string | null;
  usedPlaceholder: boolean;
  /** The slippage limit asked for, in basis points, within the bounds this site allows. */
  slippageBps: number;
  /** The routing level this swap is asked for with: the server's setting, or "public" when the person chose that for this one swap. */
  confidentiality: Confidentiality;
}

/**
 * Validates the parts of a quote or order request that both routes share. `privacyMode` is the
 * server's routing setting; the routes pass it in, and it is never read from the request.
 */
export function parseSwapInput(body: Record<string, unknown>, byId: ReadonlyMap<string, Token>, forOrder: boolean, privacyMode: Confidentiality = "public"): QuoteInput {
  const { from: fromId, to: toId, pay } = body;
  if (typeof fromId !== "string" || typeof toId !== "string") throw new HttpError(400, "invalid_asset", "Choose both coins.");
  const from = byId.get(fromId);
  const to = byId.get(toId);
  if (from === undefined || to === undefined) throw new HttpError(400, "invalid_asset", "That coin is not available right now.");
  if (from.id === to.id) throw new HttpError(400, "invalid_asset", "Choose two different coins.");
  if (pay !== "wallet" && pay !== "manual") throw new HttpError(400, "bad_request", "Choose how to pay.");
  if (pay === "wallet" && !from.wallet) throw new HttpError(400, "invalid_asset", `${from.symbol} on ${chainName(from.chain)} can't be paid from a connected wallet. Pay without connecting instead.`);

  const amount = parseRaw(body.amount);
  if (amount === null || amount <= 0n) throw new HttpError(400, "invalid_amount", "Enter an amount.");
  if (amount > MAX_RAW) throw new HttpError(400, "too_large", "That amount is too large.");
  if (usdScaled(amount, from.decimals, from.priceScaled) > MAX_USD * USD_SCALE) {
    throw new HttpError(400, "too_large", "Swaps are limited to $1,000,000.");
  }

  // The slippage limit: a whole number of basis points within the allowed bounds, or the usual one.
  const asked = body.slippageBps;
  if (asked !== undefined && (typeof asked !== "number" || !Number.isInteger(asked) || asked < SLIPPAGE.min || asked > SLIPPAGE.max)) {
    throw new HttpError(400, "bad_request", `Choose a slippage limit ${SLIPPAGE_BOUNDS_WORDS}.`);
  }
  const slippageBps = asked ?? SLIPPAGE_BPS;

  let usedPlaceholder = false;
  const sender = body.sender === undefined || body.sender === null ? null : requireAddress(from.chain, body.sender, "invalid_sender");
  if (forOrder && pay === "wallet" && sender === null) throw new HttpError(400, "invalid_sender", "Connect a wallet first.");

  let recipient: string;
  if (body.recipient === undefined || body.recipient === null || body.recipient === "") {
    const stand = forOrder ? null : placeholderFor(to.chain);
    if (stand === null) throw new HttpError(400, "invalid_recipient", "Enter a receiving address.", { detail: { reason: "empty" } });
    recipient = stand;
    usedPlaceholder = true;
  } else {
    recipient = requireAddress(to.chain, body.recipient, "invalid_recipient");
  }

  let refundTo: string;
  if (body.refundTo === undefined || body.refundTo === null || body.refundTo === "") {
    const stand = sender ?? (forOrder ? null : placeholderFor(from.chain));
    if (stand === null) throw new HttpError(400, "invalid_refund", "Enter a refund address.", { detail: { reason: "empty" } });
    refundTo = stand;
    if (sender === null) usedPlaceholder = true;
  } else {
    refundTo = requireAddress(from.chain, body.refundTo, "invalid_refund");
  }

  // A real order can never carry a preview stand-in.
  if (forOrder && (isPlaceholder(recipient) || isPlaceholder(refundTo))) {
    throw new HttpError(400, "unsupported_address", "That address can't be used.");
  }

  // The routing level is the server's. A request may say one thing about it: "not private, this
  // once" (withoutPrivate, and only the value true). It cannot raise the level or name one: no
  // other field of the request is read for it.
  const confidentiality: Confidentiality = privacyMode === "basic" && body.withoutPrivate !== true ? "basic" : "public";
  return { from, to, amount, pay, recipient, refundTo, sender, usedPlaceholder, slippageBps, confidentiality };
}

export function buildSentQuote(input: QuoteInput, options: { dry: boolean; now: number; feeRecipient: string | null; feeBps: number; feeBpsPrivate: number }): SentQuote {
  // Our fee is the server's own setting, one for each way of routing. Nothing of the request is read for it.
  const privately = input.confidentiality === "basic";
  const fee = privately ? options.feeBpsPrivate : options.feeBps;
  const sent: SentQuote = {
    dry: options.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: input.slippageBps,
    originAsset: input.from.id,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: input.to.id,
    amount: input.amount.toString(),
    recipient: input.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(options.now + deadlineMs(input.pay, input.from.chain)).toISOString(),
    quoteWaitingTimeMs: QUOTE_WAIT_MS,
    referral: REFERRAL,
    // Said in every request, public ones too, so that the echo can be held to it.
    confidentiality: input.confidentiality,
  };
  // IntentSwap takes no fee unless the setting for this way of routing is above 0. At 0 nothing of
  // ours goes with the quote: no fee, and no address of ours. Only a fee above 0 is ever sent.
  if (fee > 0) {
    // A fee is set only together with where it is paid (server/config.ts). One with nowhere to go is never sent.
    if (options.feeRecipient === null) throw new Error("a fee is set and no fee recipient is");
    sent.appFees = [{ recipient: options.feeRecipient, fee }];
  }
  // Stellar deposits need a memo; other chains reject the field.
  if (input.from.chain === "stellar") sent.depositMode = "MEMO";
  if (input.sender !== null) sent.connectedWallets = [input.sender];
  return sent;
}

export function toQuoteView(input: QuoteInput, verified: VerifiedQuote, now: number): QuoteView & { routing: Routing } {
  return {
    from: input.from.id,
    to: input.to.id,
    amountIn: verified.amountIn,
    amountOut: verified.amountOut,
    minAmountOut: verified.minAmountOut,
    amountInUsd: verified.amountInUsd,
    amountOutUsd: verified.amountOutUsd,
    slippageBps: input.slippageBps,
    timeEstimate: verified.timeEstimate,
    fees: feeView(BigInt(verified.amountIn), verified.appBps, verified.providerBps),
    withdrawFee: verified.withdrawFee,
    refundFee: verified.refundFee,
    priceImpactBps: priceImpactBps(verified.amountInUsd, verified.amountOutUsd),
    // How the quote was asked for, which verification held the provider's answer to.
    routing: routingOf(verified.confidentiality),
    serverNow: new Date(now).toISOString(),
  };
}

/** Rejects a quote whose USD value is over the limit, using the provider's own valuation. */
export function enforceUsdCap(verified: VerifiedQuote): void {
  const usd = decimalToScaled(verified.amountInUsd, 2);
  if (usd !== null && usd > MAX_USD * 100n) throw new HttpError(400, "too_large", "Swaps are limited to $1,000,000.", { expected: true });
}

/**
 * What a person is told when the provider will not give a private quote for their swap. An
 * everyday outcome: they may then choose to swap without private routing. That choice is theirs;
 * the server never asks again in public by itself.
 */
export function privateUnavailable(): HttpError {
  return new HttpError(422, "private_unavailable", "Private routing is not available for this swap right now.", { expected: true });
}

/**
 * True when the provider's answer to a private quote says that private routing itself is refused
 * to this site: 401, which is how it answers a private quote that comes without a partner's key.
 * The same answer to a public quote means what it always meant. The quote route asks this first,
 * before anything below is tried.
 *
 * A 403 is not among them. The provider issues a partner's key with no approval step, so a 403 to
 * a private quote is what it is to a public one: the provider's own screening refusing the swap
 * (told in neutral words, with no invitation to try another way), or this site turned away as a caller.
 */
export function refusesPrivate(input: QuoteInput, status: number | null): boolean {
  return input.confidentiality === "basic" && status === 401;
}

/**
 * Turns a provider refusal into our own error. The provider's text is matched
 * against known patterns and never passed through.
 */
export function mapRejection(message: string, input: QuoteInput, status = 400): HttpError {
  // A refusal by status code is a compliance refusal: neutral words, and nothing that invites a retry.
  if (status === 403 || status === 451) return new HttpError(403, "blocked", "This swap can't be processed.");
  const asPrivate = input.confidentiality === "basic";
  // "No route" for a private quote is said as "private routing is not available": asked for in
  // public, the same swap may well find a route, and if it does not, that attempt says so itself.
  const noRoute = (): HttpError => (asPrivate ? privateUnavailable() : new HttpError(422, "no_route", "No route for this pair right now.", { expected: true }));
  const text = message.toLowerCase();
  const minUsd = /minimum swap amount is \$\s?([\d,]{1,12})/.exec(text);
  if (minUsd) {
    const usd = (minUsd[1] ?? "").replace(/,/g, "");
    const shown = usd.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return new HttpError(422, "min_usd", `Minimum for this pair is $${shown} right now.`, { detail: { usd }, expected: true });
  }
  const tooLow = /amount is too low[^0-9]*(\d{1,40})?/.exec(text);
  if (tooLow) {
    const min = tooLow[1];
    return new HttpError(422, "amount_too_low", "That amount is too low for this pair.", min === undefined ? { expected: true } : { detail: { min }, expected: true });
  }
  // A refusal of a private quote that names confidential routing is about private routing.
  if (asPrivate && /confidential/.test(text)) return privateUnavailable();
  if (/recipient is not valid/.test(text)) {
    if (input.usedPlaceholder) return noRoute();
    // Our own check accepted this address, so say what happened rather than call it malformed.
    return new HttpError(400, "invalid_recipient", `The swap service didn't accept this ${chainName(input.to.chain)} address. Check it, or use another.`, { detail: { reason: "refused" }, expected: true });
  }
  if (/refundto is not valid/.test(text)) {
    if (input.usedPlaceholder) return noRoute();
    return new HttpError(400, "invalid_refund", `The swap service didn't accept this ${chainName(input.from.chain)} address. Check it, or use another.`, { detail: { reason: "refused" }, expected: true });
  }
  if (/sanction|complian|blocked|restrict|prohibit|forbidden|not allowed|aml|risk/.test(text)) {
    return new HttpError(403, "blocked", "This swap can't be processed.");
  }
  return noRoute();
}
