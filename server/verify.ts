// Verification of every quote that comes back from the swap provider.
//
// 1. The shape is checked field by field.
// 2. The provider's signature is checked against a key pinned here.
// 3. The request echoed in the response is compared with what we sent.
// 4. The numbers are checked for sanity.
//
// The signature covers the swap itself (coins, amount, both addresses, deadline,
// the amounts out, and the deposit address). It does not cover fees, so the
// echoed fees are checked here against what we asked for.
//
// A quote is asked for at one of two routing levels, "public" or "basic" (the
// provider's private routing). The echo must name the level that was sent, and
// a private quote carries no fee of ours.

import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { checkAddress, sameAddress } from "../shared/addresses.ts";
import { decimalToScaled, isDigits, parseRaw } from "../shared/amounts.ts";
import type { Confidentiality } from "../shared/api.ts";
import { chainInfo, DEPOSIT_ADDRESS_SHAPE } from "../shared/chains.ts";
import { sameFeeRecipient } from "./fees.ts";

/**
 * The provider's quote-signing key. It is published only inside the provider's
 * SDK (constant ONE_CLICK_MANAGER_PUB_KEY, version 0.1.26). Pinned here so that
 * a dependency update cannot change it silently.
 */
export const ONECLICK_SIGNING_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

export interface SentQuote {
  dry: boolean;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  deadline: string;
  quoteWaitingTimeMs: number;
  referral: string;
  /** The routing level asked for. Always sent, never left to the provider's default, and compared with the echo. */
  confidentiality: Confidentiality;
  /** Our fee. A private quote is sent without it: the provider's Terms say the app fee does not apply to one. */
  appFees?: Array<{ recipient: string; fee: number }>;
  depositMode?: "MEMO";
  connectedWallets?: string[];
}

export interface VerifiedQuote {
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  amountInUsd: string;
  amountOutUsd: string;
  timeEstimate: number;
  refundFee: string | null;
  withdrawFee: string | null;
  /** Our share and the provider's share, from the echoed fees. Our share of a private quote is always nothing. */
  appBps: number;
  providerBps: number;
  /** The routing level the quote was asked for with, and that its echo confirmed. */
  confidentiality: Confidentiality;
  correlationId: string | null;
  /** Live quotes only. */
  depositAddress: string | null;
  depositMemo: string | null;
  /** When the provider says the deposit address goes inactive. */
  deadline: string | null;
  timeWhenInactive: string | null;
}

/** Chain families whose addresses have a single spelling, so a deposit address can be checked strictly. */
const STRICT_DEPOSIT_FAMILIES: ReadonlySet<string> = new Set(["evm", "solana", "bitcoin", "litecoin", "dogecoin", "bitcoincash", "dash", "zcash", "near", "tron", "stellar", "xrp", "cardano", "aleo", "quantus"]);

/** A quote's own timestamp may differ from our clock by at most this much. */
export const MAX_TIMESTAMP_SKEW_MS = 10 * 60_000;

export class QuoteVerificationError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`quote verification failed: ${reason}`);
    this.name = "QuoteVerificationError";
    this.reason = reason;
  }
}

function reject(reason: string): never {
  throw new QuoteVerificationError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max = 300): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Highest total fee we accept in an echo, given the fee we sent. */
export function maxTotalFeeBps(sentBps: number): number {
  return Math.max(sentBps, Math.ceil(sentBps / 2) + 25);
}

/**
 * Highest fee of the provider's own that we accept in the echo of a private quote. There the
 * provider leaves our fee whole and adds its own beside it: 20 in the previews of 9 Oct 2026 (1
 * between two dollar coins), whatever fee of ours went with the request. If its own fee turns out
 * higher, quotes are refused (reason "echo:appFees private total") until this figure is raised on
 * purpose.
 */
export const MAX_PRIVATE_PROVIDER_FEE_BPS = maxTotalFeeBps(0);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function time(value: unknown): number | null {
  if (!str(value, 40) || !ISO_TIME.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function verifyQuoteResponse(options: {
  sent: SentQuote;
  response: unknown;
  originChain: string;
  now: number;
  /** Extra keys to accept. Only ever set for the practice provider in development and tests. */
  extraSigningKeys?: readonly string[];
  /**
   * Where our fee is paid. A private quote is sent without a fee, so its request does not say;
   * the echo of one must still pay this address nothing. Needed for a private quote.
   */
  feeRecipient?: string;
}): VerifiedQuote {
  const { sent, response, originChain, now } = options;
  if (!isRecord(response)) reject("response is not an object");
  const { quote, quoteRequest, signature, timestamp, correlationId } = response;
  if (!isRecord(quote) || !isRecord(quoteRequest)) reject("missing quote or quoteRequest");
  if (!str(signature) || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) reject("missing signature");
  const stamped = time(timestamp);
  if (stamped === null) reject("missing timestamp");
  // An old response replayed later is refused even before its other fields are compared.
  if (Math.abs(stamped - now) > MAX_TIMESTAMP_SKEW_MS) reject("stale timestamp");

  // ---- 2. Signature ----
  let signed = false;
  for (const key of [ONECLICK_SIGNING_KEY, ...(options.extraSigningKeys ?? [])]) {
    try {
      signed = verifyQuoteSignature(response as never, key);
    } catch {
      signed = false;
    }
    if (signed) break;
  }
  if (!signed) reject("signature");

  // ---- 3. Echo ----
  const exact: Array<keyof SentQuote> = [
    "dry",
    "swapType",
    "slippageTolerance",
    "originAsset",
    "depositType",
    "destinationAsset",
    "amount",
    "recipient",
    "recipientType",
    "refundTo",
    "refundType",
    "referral",
  ];
  for (const key of exact) {
    if (quoteRequest[key] !== sent[key]) reject(`echo:${key}`);
  }
  const echoedDeadline = time(quoteRequest.deadline);
  if (echoedDeadline === null || echoedDeadline !== Date.parse(sent.deadline)) reject("echo:deadline");
  const echoedMode = quoteRequest.depositMode ?? "SIMPLE";
  if (echoedMode !== (sent.depositMode ?? "SIMPLE")) reject("echo:depositMode");
  // The routing level is ours to choose and goes with every quote. The echo must name the same
  // one ("public" when it names none): a private quote answered as a public one would be routed in
  // public, and a public one answered as private would carry no fee. Only the two levels this site
  // uses can be asked for, so "advanced" is never accepted.
  const level = sent.confidentiality;
  if (level !== "basic" && level !== "public") reject("sent confidentiality");
  if ((quoteRequest.confidentiality ?? "public") !== level) reject("echo:confidentiality");
  if (quoteRequest.insured !== undefined && quoteRequest.insured !== false) reject("echo:insured");
  for (const key of ["virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg", "rebates"]) {
    const value = quoteRequest[key];
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) reject(`echo:${key}`);
  }
  for (const key of ["virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg", "chainDepositAddresses"]) {
    if (quote[key] !== undefined && quote[key] !== null) reject(`quote:${key}`);
  }

  // Fees are not covered by the signature, so they are checked here.
  let appBps = 0;
  let providerBps = 0;
  if (level === "basic") {
    // A private quote. Its echo holds our fee, to our own recipient and never more than we sent,
    // and beside it one entry of the provider's own. The figures shown and stored are the echo's.
    // With FEE_BPS_PRIVATE at 0 nothing of ours is sent, and the echo may then pay us nothing.
    const ourRecipient = options.feeRecipient;
    const sentFees = sent.appFees ?? [];
    const sentFee = sentFees[0] ?? null;
    if (sentFees.length > 1 || ourRecipient === undefined) reject("sent fees");
    if (sentFee !== null && (!sameFeeRecipient(sentFee.recipient, ourRecipient) || !Number.isInteger(sentFee.fee) || sentFee.fee < 1)) reject("sent fees");
    const echoedFees = quoteRequest.appFees ?? [];
    if (!Array.isArray(echoedFees) || echoedFees.length > 4) reject("echo:appFees");
    let ours = 0;
    let others = 0;
    for (const entry of echoedFees as unknown[]) {
      if (!isRecord(entry) || !str(entry.recipient, 100)) reject("echo:appFees entry");
      const fee = entry.fee;
      if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 0 || fee > 500) reject("echo:appFees fee");
      if (sameFeeRecipient(entry.recipient, ourRecipient)) {
        ours += 1;
        appBps += fee;
      } else {
        others += 1;
        providerBps += fee;
      }
    }
    if (sentFee === null) {
      // We asked for no fee. An echo that pays us one is not the quote we asked for.
      if (appBps !== 0) reject("echo:appFees private share");
    } else {
      if (ours !== 1) reject("echo:appFees recipient");
      if (appBps < 1 || appBps > sentFee.fee) reject("echo:appFees share");
    }
    // One entry beside ours is the provider's own. A second would be a fee for somebody else.
    if (others > 1) reject("echo:appFees private recipient");
    if (providerBps > MAX_PRIVATE_PROVIDER_FEE_BPS) reject("echo:appFees private total");
  } else {
    const sentFees = sent.appFees ?? [];
    const sentFee = sentFees[0];
    if (sentFees.length !== 1 || sentFee === undefined) reject("sent fees");
    const echoedFees = quoteRequest.appFees;
    if (!Array.isArray(echoedFees) || echoedFees.length === 0 || echoedFees.length > 4) reject("echo:appFees");
    let ours = 0;
    for (const entry of echoedFees as unknown[]) {
      if (!isRecord(entry) || !str(entry.recipient, 100)) reject("echo:appFees entry");
      const fee = entry.fee;
      if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 0 || fee > 500) reject("echo:appFees fee");
      if (sameFeeRecipient(entry.recipient, sentFee.recipient)) {
        ours += 1;
        appBps += fee;
      } else {
        providerBps += fee;
      }
    }
    if (ours !== 1) reject("echo:appFees recipient");
    if (appBps < 1 || appBps > sentFee.fee) reject("echo:appFees share");
    if (appBps + providerBps > maxTotalFeeBps(sentFee.fee)) reject("echo:appFees total");
  }

  // ---- 4. Numbers ----
  const amountIn = parseRaw(quote.amountIn);
  const minAmountIn = parseRaw(quote.minAmountIn);
  const amountOut = parseRaw(quote.amountOut);
  const minAmountOut = parseRaw(quote.minAmountOut);
  if (amountIn === null || minAmountIn === null || amountOut === null || minAmountOut === null) reject("quote amounts");
  if (amountIn !== BigInt(sent.amount)) reject("quote:amountIn differs from request");
  if (minAmountIn > amountIn) reject("quote:minAmountIn");
  if (amountOut <= 0n || minAmountOut <= 0n || minAmountOut > amountOut) reject("quote:amountOut");
  // Minimum out can never be below what the slippage setting allows (1 unit of rounding room).
  const floor = (amountOut * BigInt(10_000 - sent.slippageTolerance)) / 10_000n;
  if (minAmountOut + 1n < floor) reject("quote:minAmountOut below slippage");
  if (decimalToScaled(quote.amountInUsd, 6) === null || decimalToScaled(quote.amountOutUsd, 6) === null) reject("quote usd");
  const timeEstimate = quote.timeEstimate;
  if (typeof timeEstimate !== "number" || !Number.isFinite(timeEstimate) || timeEstimate < 0 || timeEstimate > 86_400) reject("quote:timeEstimate");
  const optionalRaw = (value: unknown, name: string): string | null => {
    if (value === undefined || value === null) return null;
    if (!isDigits(value)) reject(`quote:${name}`);
    return value;
  };
  const refundFee = optionalRaw(quote.refundFee, "refundFee");
  const withdrawFee = optionalRaw(quote.withdrawFee, "withdrawFee");

  const verified: VerifiedQuote = {
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    minAmountOut: minAmountOut.toString(),
    amountInUsd: quote.amountInUsd as string,
    amountOutUsd: quote.amountOutUsd as string,
    timeEstimate: Math.round(timeEstimate),
    refundFee,
    withdrawFee,
    appBps,
    providerBps,
    confidentiality: level,
    correlationId: str(correlationId, 80) && /^[A-Za-z0-9-]+$/.test(correlationId) ? correlationId : null,
    depositAddress: null,
    depositMemo: null,
    deadline: null,
    timeWhenInactive: null,
  };

  if (sent.dry) {
    if (quote.depositAddress !== undefined && quote.depositAddress !== null) reject("dry quote carries a deposit address");
    return verified;
  }

  // ---- Live quotes ----
  if (!str(quote.depositAddress, 128) || !DEPOSIT_ADDRESS_SHAPE.test(quote.depositAddress)) reject("quote:depositAddress");
  // Where a chain writes an address in exactly one way, the deposit address must be a well-formed
  // address of that chain. Chains with several accepted spellings (TON, Sui, Aptos, Starknet) and
  // chains we know nothing about keep the shape check above: there the signature is the guarantee,
  // and a stricter rule could turn away a genuine quote.
  if (STRICT_DEPOSIT_FAMILIES.has(chainInfo(originChain).family) && !checkAddress(originChain, quote.depositAddress).ok) reject("quote:depositAddress format");
  if (sameAddress(originChain, quote.depositAddress, sent.recipient) || sameAddress(originChain, quote.depositAddress, sent.refundTo)) {
    reject("quote:depositAddress equals a user address");
  }
  const deadline = time(quote.deadline);
  if (deadline === null) reject("quote:deadline");
  // There must be time to pay. There is no upper limit: deposits close at the earlier of this
  // time and the deadline we asked for, so a far-off value from the provider does no harm.
  if (deadline < now + 5 * 60_000) reject("quote:deadline out of range");
  let timeWhenInactive: string | null = null;
  if (quote.timeWhenInactive !== undefined && quote.timeWhenInactive !== null) {
    if (time(quote.timeWhenInactive) === null) reject("quote:timeWhenInactive");
    timeWhenInactive = quote.timeWhenInactive as string;
  }
  let depositMemo: string | null = null;
  if (quote.depositMemo !== undefined && quote.depositMemo !== null && quote.depositMemo !== "") {
    if (!str(quote.depositMemo, 64) || !/^[A-Za-z0-9_-]+$/.test(quote.depositMemo)) reject("quote:depositMemo");
    depositMemo = quote.depositMemo;
  }
  // A memo is required when we asked for one. One that arrives unasked is kept and shown:
  // dropping it would lose the deposit, and it is covered by the signature.
  if (sent.depositMode === "MEMO" && depositMemo === null) reject("quote:memo expected");

  return {
    ...verified,
    depositAddress: quote.depositAddress as string,
    depositMemo,
    deadline: new Date(deadline).toISOString(),
    timeWhenInactive,
  };
}
