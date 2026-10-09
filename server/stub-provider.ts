// A practice swap provider for local development and automated tests.
//
// It never moves funds and never creates anything at the real provider. Price
// previews can still come from the real API (read-only); real orders are made
// up here, signed with a throwaway key that exists only in this process, and
// stepped through their statuses on a timer or by the practice controls.
//
// It answers quotes at both routing levels the site uses: "public", and "basic" (the provider's
// private routing). A private quote echoes our fee whole, with the provider's own beside it, and
// gives a little less out. Private
// previews are always made up here and never sent on: the real provider answers them only to a
// partner with a key. One kind of pair is always refused in private and fine in public (any pair
// that delivers on Zcash), so that the "not available" path can be reached while practising.
//
// The server refuses to start with this enabled in production.

import { generateKeyPairSync, randomBytes, randomUUID, sign as edSign, type KeyObject } from "node:crypto";
import { quoteHash } from "@defuse-protocol/one-click-sdk-typescript";
import { blake2b } from "@noble/hashes/blake2b";
import { sha256 } from "@noble/hashes/sha2";
import { base32, base58, base58xrp, base64url, bech32, bech32m, createBase58check } from "@scure/base";
import { priceToScaled } from "../shared/amounts.ts";
import { chainInfo } from "../shared/chains.ts";
import type { OneClick, UpstreamResult } from "./oneclick.ts";

export type StubAction = "deposit" | "underpay" | "refund" | "fail";

/**
 * The ways the real provider can refuse a private quote, as its client reports each:
 * - "unauthorized": HTTP 401, as it answers when there is no partner key.
 * - "forbidden": HTTP 403 with a message of the provider's own, as its screening refuses a swap. The site tells that as a refusal of the swap, never as "private routing is not available".
 * - "not_offered": a 400 whose words name confidential routing.
 * - "no_route": a 400 that says there is no route.
 */
export type PrivateFailure = "unauthorized" | "forbidden" | "not_offered" | "no_route";

export interface StubProvider {
  provider: OneClick;
  /** Public half of the throwaway signing key, in the provider's "ed25519:…" form. */
  signingKey: string;
  /** Signs an arbitrary response with the same key. For tests. */
  sign(response: Record<string, unknown>): Record<string, unknown>;
  /** Moves a practice order along. Returns false when the deposit address is unknown. */
  control(depositAddress: string, action: StubAction): boolean;
  /**
   * From now on previews are made up here and the real provider is no longer asked. Used once the
   * practice clock has been moved: the real provider stamps its answers with the real time, which
   * a server on another clock would rightly refuse as stale.
   */
  localOnly(): void;
  /** A switch for tests: while set, every private quote fails in this way. Public quotes are not touched. Null (the usual state) lets them through. */
  privateFails: PrivateFailure | null;
  /** Number of provider calls made, by kind. For tests. `madeUpPreviews` counts previews answered here because the real provider did not answer. */
  calls: { tokens: number; dryQuotes: number; liveQuotes: number; status: number; submits: number; madeUpPreviews: number };
}

interface StubOrder {
  response: Record<string, unknown>;
  amountIn: string;
  amountOut: string;
  originChain: string;
  destinationChain: string;
  script: StubAction | null;
  scriptAt: number;
  depositHash: string | null;
}

interface StubToken {
  assetId: string;
  blockchain: string;
  decimals: number;
  price: number;
}

const PROVIDER_FEE_ACCOUNT = "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd";
/** Where the provider's own fee on a private quote goes: another account than a public quote's, as at the real provider. */
const PRIVATE_FEE_ACCOUNT = "2238fd089f1c92b206c218cd16b8676cb98964e0d50f8ab729c6396a81e07805";
/** The provider's own fee on a private quote, in basis points, as the real provider was seen to charge it. */
export const PRIVATE_PROVIDER_BPS = 20;
/** What a private quote gives less of, in basis points, on top of the fees. Made up (the real provider's private quotes came out a little lower too), so that a private quote and a public one can be told apart. */
export const PRIVATE_EXTRA_BPS = 10;
/** A private quote that delivers on this chain is always refused here; a public one is not. */
export const NO_PRIVATE_CHAIN = "zec";
/** The provider's words for a level it does not know. */
const UNKNOWN_LEVEL = "confidentiality must be one of the following values: public, basic, advanced";
/** Made-up words, in the provider's manner, for a private quote it does not offer. */
const NOT_OFFERED = "Confidential quotes are not available for this pair";

function privateFailure(how: PrivateFailure): UpstreamResult {
  switch (how) {
    case "unauthorized":
      return { ok: false, kind: "unavailable", status: 401 };
    case "forbidden":
      return { ok: false, kind: "rejected", status: 403, message: "" };
    case "not_offered":
      return { ok: false, kind: "rejected", status: 400, message: NOT_OFFERED };
    case "no_route":
      return { ok: false, kind: "rejected", status: 400, message: "No liquidity available" };
  }
}
const b58check = createBase58check(sha256);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** A random, well-formed address for a chain. Nobody holds its key: it is for practice only. */
export function practiceAddress(chain: string): string {
  const family = chainInfo(chain).family;
  const random = (n: number) => Uint8Array.from(randomBytes(n));
  const versioned = (version: number[]) => b58check.encode(Uint8Array.from([...version, ...random(20)]));
  switch (family) {
    case "evm":
      return `0x${randomBytes(20).toString("hex")}`;
    case "solana":
      return base58.encode(random(32));
    case "near":
      return randomBytes(32).toString("hex");
    case "bitcoin":
    case "bitcoincash":
      return versioned([0x00]);
    case "litecoin":
      return versioned([0x30]);
    case "dogecoin":
      return versioned([0x1e]);
    case "dash":
      return versioned([0x4c]);
    case "zcash":
      return versioned([0x1c, 0xb8]);
    case "tron":
      return versioned([0x41]);
    case "sui":
    case "aptos":
      return `0x${randomBytes(32).toString("hex")}`;
    case "starknet":
      // A Starknet address is below 2^251, so the first two hex digits are at most 07.
      return `0x0${((randomBytes(1)[0] ?? 0) & 7).toString(16)}${randomBytes(31).toString("hex")}`;
    case "xrp": {
      const body = Uint8Array.from([0x00, ...random(20)]);
      return base58xrp.encode(Uint8Array.from([...body, ...sha256(sha256(body)).subarray(0, 4)]));
    }
    case "stellar": {
      const body = Uint8Array.from([0x30, ...random(32)]);
      const crc = crc16(body);
      return base32.encode(Uint8Array.from([...body, crc & 0xff, crc >> 8]));
    }
    case "ton": {
      const body = Uint8Array.from([0x51, 0x00, ...random(32)]);
      const crc = crc16(body);
      return base64url.encode(Uint8Array.from([...body, crc >> 8, crc & 0xff]));
    }
    case "cardano":
      return bech32.encode("addr", bech32.toWords(Uint8Array.from([0x61, ...random(28)])), 120);
    case "aleo":
      return bech32m.encode("aleo", bech32m.toWords(random(32)), 90);
    case "quantus": {
      const body = Uint8Array.from([((189 & 0xfc) >> 2) | 0x40, (189 >> 8) | ((189 & 0x03) << 6), ...random(32)]);
      const hash = blake2b(Uint8Array.from([...new TextEncoder().encode("SS58PRE"), ...body]), { dkLen: 64 });
      return base58.encode(Uint8Array.from([...body, hash[0] ?? 0, hash[1] ?? 0]));
    }
    default:
      return `practice-${randomBytes(16).toString("hex")}`;
  }
}

function formatUnits(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? (raw / base).toString() : `${raw / base}.${frac}`;
}

function publicKeyText(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return `ed25519:${base58.encode(der.subarray(der.length - 32))}`;
}

export interface QuoteSigner {
  publicKey: string;
  /** Returns the response with a signature over its current contents. */
  sign(response: Record<string, unknown>): Record<string, unknown>;
}

/** A throwaway signing key in the provider's format. Practice and tests only. */
export function createQuoteSigner(): QuoteSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKeyText(publicKey),
    sign(response) {
      const message = new TextEncoder().encode(quoteHash(response as never));
      return { ...response, signature: `ed25519:${base58.encode(edSign(null, message, privateKey))}` };
    },
  };
}

/** A preview waits this long for the real provider. */
export const PREVIEW_WAIT_MS = 4000;
/** After the real provider fails to answer a preview, it is not asked again for this long. */
export const UPSTREAM_REST_MS = 60_000;

export function createStubProvider(options: {
  /** Real provider client for read-only calls (coin list and price previews). Null keeps everything local. */
  upstream: OneClick | null;
  /** Coin list used when there is no upstream. */
  tokens?: unknown[];
  now?: () => number;
  /** How long a preview waits for the real provider before it is made up here. */
  previewWaitMs?: number;
}): StubProvider {
  const now = options.now ?? Date.now;
  const { upstream } = options;
  const signer = createQuoteSigner();
  const orders = new Map<string, StubOrder>();
  const calls = { tokens: 0, dryQuotes: 0, liveQuotes: 0, status: 0, submits: 0, madeUpPreviews: 0 };
  const previewWaitMs = options.previewWaitMs ?? PREVIEW_WAIT_MS;
  // While this is in the future, previews are made up here and the real provider is not asked.
  let restUntil = 0;
  let tokenCache: StubToken[] = [];

  function remember(list: unknown): void {
    if (!Array.isArray(list)) return;
    tokenCache = list.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const { assetId, blockchain, decimals, price } = entry;
      if (typeof assetId !== "string" || typeof blockchain !== "string" || typeof decimals !== "number" || typeof price !== "number") return [];
      return [{ assetId, blockchain, decimals, price }];
    });
  }
  remember(options.tokens);

  function makeQuote(body: Record<string, unknown>): UpstreamResult {
    // The routing level: "public" when none is named, as at the real provider. "advanced" is
    // answered as the real provider answers it without a partner key.
    const level = body.confidentiality ?? "public";
    if (level === "advanced") return { ok: false, kind: "unavailable", status: 401 };
    if (level !== "public" && level !== "basic") return { ok: false, kind: "rejected", status: 400, message: UNKNOWN_LEVEL };
    const asPrivate = level === "basic";
    if (asPrivate && stub.privateFails !== null) return privateFailure(stub.privateFails);
    const origin = tokenCache.find((t) => t.assetId === body.originAsset);
    const destination = tokenCache.find((t) => t.assetId === body.destinationAsset);
    if (!origin) return { ok: false, kind: "rejected", status: 400, message: "tokenIn is not valid" };
    if (!destination) return { ok: false, kind: "rejected", status: 400, message: "tokenOut is not valid" };
    if (asPrivate && destination.blockchain === NO_PRIVATE_CHAIN) return privateFailure("not_offered");
    const priceIn = priceToScaled(origin.price);
    const priceOut = priceToScaled(destination.price);
    if (typeof body.amount !== "string" || !/^\d+$/.test(body.amount) || priceIn === null || priceOut === null || priceOut === 0n) {
      return { ok: false, kind: "rejected", status: 400, message: "Failed to get quote" };
    }
    const amountIn = BigInt(body.amount);
    const usdIn = (amountIn * priceIn) / 10n ** BigInt(origin.decimals); // scaled 1e18
    if (usdIn < 10n ** 17n) return { ok: false, kind: "rejected", status: 400, message: "No liquidity available" };

    // Mirrors what the real provider was seen to do. On a public quote our fee is halved and its own
    // share has a 20 bps floor. On a private quote our fee comes back whole, and the provider's own
    // 20 is added beside it; sent with no fee of ours, the echo holds the provider's entry alone.
    const fees = Array.isArray(body.appFees) ? (body.appFees as unknown[]) : [];
    const first = isRecord(fees[0]) ? fees[0] : null;
    const sentBps = first !== null && typeof first.fee === "number" ? first.fee : 0;
    const ours = asPrivate ? sentBps : Math.floor(sentBps / 2);
    const theirs = asPrivate ? PRIVATE_PROVIDER_BPS : Math.max(Math.ceil(sentBps / 2), 20);
    const providerAccount = asPrivate ? PRIVATE_FEE_ACCOUNT : PROVIDER_FEE_ACCOUNT;
    const echoedFees = first === null ? [{ recipient: providerAccount, fee: theirs }] : [
      { recipient: first.recipient, fee: ours },
      { recipient: providerAccount, fee: theirs },
    ];
    const net = (amountIn * BigInt(10_000 - ours - theirs - (asPrivate ? PRIVATE_EXTRA_BPS : 0))) / 10_000n;
    const slippage = typeof body.slippageTolerance === "number" ? body.slippageTolerance : 100;
    const amountOut = (net * priceIn * 10n ** BigInt(destination.decimals)) / (priceOut * 10n ** BigInt(origin.decimals));
    if (amountOut <= 0n) return { ok: false, kind: "rejected", status: 400, message: "No liquidity available" };
    const minAmountOut = (amountOut * BigInt(10_000 - slippage)) / 10_000n;
    const usdOut = (amountOut * priceOut) / 10n ** BigInt(destination.decimals);

    const dry = body.dry === true;
    const quote: Record<string, unknown> = {
      amountIn: amountIn.toString(),
      amountInFormatted: formatUnits(amountIn, origin.decimals),
      amountInUsd: formatUnits(usdIn / 10n ** 6n, 12),
      minAmountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      amountOutFormatted: formatUnits(amountOut, destination.decimals),
      amountOutUsd: formatUnits(usdOut / 10n ** 6n, 12),
      minAmountOut: minAmountOut.toString(),
      timeEstimate: 30,
      refundFee: "1000",
      withdrawFee: "100",
    };
    let depositAddress: string | null = null;
    if (!dry) {
      depositAddress = practiceAddress(origin.blockchain);
      quote.depositAddress = depositAddress;
      quote.deadline = body.deadline;
      quote.timeWhenInactive = body.deadline;
      if (body.depositMode === "MEMO") quote.depositMemo = String(100000 + Math.floor(Math.random() * 900000));
    }
    const response = signer.sign({
      quote,
      quoteRequest: { ...body, depositMode: body.depositMode ?? "SIMPLE", confidentiality: level, insured: false, appFees: echoedFees },
      timestamp: new Date(now()).toISOString(),
      correlationId: randomUUID(),
    });
    if (depositAddress !== null) {
      orders.set(depositAddress, {
        response,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        originChain: origin.blockchain,
        destinationChain: destination.blockchain,
        script: null,
        scriptAt: 0,
        depositHash: null,
      });
    }
    return { ok: true, status: 201, data: response };
  }

  function statusOf(order: StubOrder): { status: string; details: Record<string, unknown> } {
    const elapsed = now() - order.scriptAt;
    const tx = (hash: string) => [{ hash, explorerUrl: "https://example.invalid/practice" }];
    const base: Record<string, unknown> = { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] };
    const depositTx = order.depositHash ?? `0x${"ab".repeat(32)}`;
    switch (order.script) {
      case null:
        return { status: "PENDING_DEPOSIT", details: base };
      case "deposit": {
        const seen = { ...base, originChainTxHashes: tx(depositTx), depositedAmount: order.amountIn };
        if (elapsed < 6000) return { status: "KNOWN_DEPOSIT_TX", details: seen };
        if (elapsed < 20_000) return { status: "PROCESSING", details: seen };
        return {
          status: "SUCCESS",
          details: { ...seen, destinationChainTxHashes: tx(`0x${"cd".repeat(32)}`), amountIn: order.amountIn, amountOut: order.amountOut },
        };
      }
      case "underpay": {
        const half = (BigInt(order.amountIn) / 2n).toString();
        const seen = { ...base, originChainTxHashes: tx(depositTx), depositedAmount: half };
        if (elapsed < 20_000) return { status: "INCOMPLETE_DEPOSIT", details: seen };
        return { status: "REFUNDED", details: { ...seen, refundedAmount: half, refundReason: "PARTIAL_DEPOSIT" } };
      }
      case "refund": {
        const seen = { ...base, originChainTxHashes: tx(depositTx), depositedAmount: order.amountIn };
        if (elapsed < 8000) return { status: "PROCESSING", details: seen };
        return { status: "REFUNDED", details: { ...seen, refundedAmount: order.amountIn, refundReason: "SLIPPAGE_EXCEEDED" } };
      }
      case "fail":
        return { status: "FAILED", details: { ...base, originChainTxHashes: tx(depositTx), depositedAmount: order.amountIn } };
    }
  }

  const provider: OneClick = {
    async tokens() {
      calls.tokens += 1;
      if (upstream !== null) {
        const result = await upstream.tokens();
        if (result.ok) remember(result.data);
        return result;
      }
      return { ok: true, status: 200, data: options.tokens ?? [] };
    },
    async quote(body, priority) {
      if (body.dry === true) {
        calls.dryQuotes += 1;
        // Read-only previews may use the real provider. Anything else never leaves this process.
        if (upstream === null) return makeQuote(body);
        // A private preview is not sent on either. Without a partner key the real provider refuses
        // every one, which would count against it as a failure and leave public previews made up here too.
        if (body.confidentiality !== undefined && body.confidentiality !== "public") return makeQuote(body);
        if (now() < restUntil) {
          calls.madeUpPreviews += 1;
          return makeQuote(body);
        }
        // Practice must not hang on someone else's service. A preview comes from the real provider
        // when it answers promptly; a refusal from it is passed on as it is. When it does not answer
        // (down, slow, or holding this machine back), the preview is made up here instead, and the
        // real provider is left alone for a minute.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const slow = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), previewWaitMs);
        });
        const real = await Promise.race([upstream.quote(body, priority), slow]);
        clearTimeout(timer);
        if (real !== null && (real.ok || real.kind === "rejected")) return real;
        restUntil = now() + UPSTREAM_REST_MS;
        calls.madeUpPreviews += 1;
        return makeQuote(body);
      }
      calls.liveQuotes += 1;
      return makeQuote(body);
    },
    async status(depositAddress) {
      calls.status += 1;
      const order = orders.get(depositAddress);
      if (order === undefined) return { ok: false, kind: "rejected", status: 404, message: "Deposit address not found" };
      const { status, details } = statusOf(order);
      return {
        ok: true,
        status: 200,
        data: { correlationId: randomUUID(), quoteResponse: order.response, status, updatedAt: new Date(now()).toISOString(), swapDetails: details },
      };
    },
    async submitDeposit(body) {
      calls.submits += 1;
      const order = orders.get(body.depositAddress);
      if (order === undefined) return { ok: false, kind: "rejected", status: 400, message: "Deposit address not found" };
      if (order.script === null) {
        order.script = "deposit";
        order.scriptAt = now();
        order.depositHash = body.txHash;
      }
      return { ok: true, status: 200, data: {} };
    },
    health: () => upstream?.health() ?? { degraded: false, errorRate: 0, calls: 0 },
  };

  const stub: StubProvider = {
    provider,
    signingKey: signer.publicKey,
    sign: signer.sign,
    calls,
    privateFails: null,
    localOnly() {
      restUntil = Number.POSITIVE_INFINITY;
    },
    control(depositAddress, action) {
      const order = orders.get(depositAddress);
      if (order === undefined) return false;
      order.script = action;
      order.scriptAt = now();
      return true;
    },
  };
  return stub;
}
