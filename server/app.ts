// The HTTP application: routing, the checks every request passes through,
// and the route handlers. Built from injected parts so tests can stub them.

import { createHash } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { recoverMessageAddress } from "viem";
import { isValidTxHash, sameAddress } from "../shared/addresses.ts";
import { isDigits, worseByMoreThan } from "../shared/amounts.ts";
import {
  isEndState,
  isRouting,
  routingOf,
  TERMS_VERSION,
  type ConfigResponse,
  type OrderView,
  type StatusResponse,
  type TokensResponse,
} from "../shared/api.ts";
import { DEPOSIT_CLOSE_MS, explorerTxUrl, isWalletChain, WALLET_CHAINS, type WalletChain } from "../shared/chains.ts";
import { RESERVE_ASSET, type RewardsPublic } from "../shared/rewards.ts";
import type { AccessLog } from "./log.ts";
import type { Alerts } from "./alerts.ts";
import type { Config } from "./config.ts";
import { isPrivateIp, type Geo } from "./geo.ts";
import { errorBody, HttpError, isRecord, isSameOrigin, readJson, requestPath, securityHeaders, sendJson } from "./http.ts";
import { rateKey, resolveClientIp, truncateIp, wideKey } from "./ip.ts";
import { errorKind, hashId, type Logger } from "./log.ts";
import type { OneClick } from "./oneclick.ts";
import { EXPIRE_AFTER_DEADLINE_MS, type Poller } from "./poller.ts";
import { buildSentQuote, enforceUsdCap, mapRejection, parseSwapInput, privateUnavailable, refusesPrivate, toQuoteView, type QuoteInput } from "./quotes.ts";
import { MAX_HASH_SUBMISSIONS, MAX_UNPAID_PER_CLIENT, MAX_UNPAID_PER_NETWORK, openOrderCap, type LimitName, type Limiters } from "./ratelimit.ts";
import { decodeErc20Transfer, decodeTransferLog, hexToBigInt, parseProxyBody, type Rpc } from "./rpc.ts";
import { rewardsAddressOf, type Rewards, type SignIn } from "./rewards.ts";
import { SAMPLE, type Samples } from "./sample.ts";
import type { Sanctions } from "./sanctions.ts";
import type { SessionIssuer } from "./session.ts";
import type { StaticSite } from "./static.ts";
import type { StubAction } from "./stub-provider.ts";
import { hasProvenFunds, isOrderId, newOrderId, type OrderRecord, type OrderStore } from "./store.ts";
import type { TokenService, TokenSnapshot } from "./tokens.ts";
import { QuoteVerificationError, verifyQuoteResponse, type SentQuote, type VerifiedQuote } from "./verify.ts";

export interface AppDeps {
  config: Config;
  log: Logger;
  accessLog: AccessLog;
  alerts: Alerts;
  geo: Geo;
  sanctions: Sanctions;
  oneclick: OneClick;
  tokens: TokenService;
  store: OrderStore;
  poller: Poller;
  rpc: Rpc;
  limiters: Limiters;
  sessions: SessionIssuer;
  /** The record of points, and the sign-in of the Rewards page. */
  rewards: Rewards;
  signIn: SignIn;
  site: StaticSite | null;
  now: () => number;
  /**
   * Whether real orders may be created at the provider. True in production and
   * with the practice provider; false in plain local development, which never
   * creates a real order.
   */
  liveOrders: boolean;
  /** Extra quote-signing keys to accept. Only set with the practice provider. */
  extraSigningKeys?: readonly string[];
  /** Cap on unfinished orders. Defaults to a size the provider budget can keep tracked. */
  maxOpenOrders?: number;
  /** True when the data volume is too full to take new orders safely. */
  diskFull?: () => boolean;
  /** Practice controls. Only set with the practice provider. */
  practice?: {
    control(depositAddress: string, action: StubAction): boolean;
    /** Moves the practice server's clock forward. Never backward, and never outside practice. */
    skipAhead?(ms: number): void;
    /** Sample content, so that every screen can be seen full while practising. Never outside practice. */
    samples?: Samples;
  };
}

/** A live quote may be this much worse than the reviewed one before the person must confirm again. */
export const PRICE_TOLERANCE_BPS = 100;


interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  ipKey: string;
  /** The wider network a visitor on IPv6 belongs to (/48). Null for IPv4. */
  wideKey: string | null;
  /** Filled in by handlers for the access log. */
  logOrder?: string;
  logScreening?: string;
  logCid?: string;
}

interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  name: string;
  /** Per-IP limit for the route. Null when the handler applies its own. */
  limit: LimitName | null;
  /** A read that costs next to nothing and that an open page asks for by itself. These share an allowance of their own: see LIMITS.apiReadsGlobal. */
  cheapRead?: boolean;
  maxBody?: number;
  needsOrigin?: boolean;
  needsSession?: boolean;
  handler: (ctx: Ctx, match: RegExpExecArray, body: unknown) => Promise<{ status: number; body: unknown }>;
}

export function toOrderView(record: OrderRecord, now: number): OrderView {
  const { state } = record;
  const proven = hasProvenFunds(state);
  // A deposit we confirmed on-chain ourselves is shown as found, even before the provider reports it.
  const status = state.status === "waiting" && proven ? "deposit_seen" : state.status;
  // Until a deposit is proven, the details stay on show: "deposit seen" alone can be claimed by
  // anyone who knows the address, and must not be able to hide them from the person paying.
  const awaitingDeposit = state.status === "waiting" || state.status === "deposit_seen";
  const depositsOpen = awaitingDeposit && !proven && now < Date.parse(record.deadline) - DEPOSIT_CLOSE_MS;
  // Transactions on the paying side that the provider names are shown once it has started on the
  // order (or ended it), or once we confirmed the deposit. Before that the hash may be anyone's.
  const originKnown = proven || !awaitingDeposit;
  return {
    id: record.id,
    status,
    createdAt: record.createdAt,
    updatedAt: state.updatedAt,
    statusSince: state.statusSince,
    pay: record.pay,
    from: record.from,
    to: record.to,
    amountIn: record.amountIn,
    amountOut: record.amountOut,
    minAmountOut: record.minAmountOut,
    amountInUsd: record.amountInUsd,
    amountOutUsd: record.amountOutUsd,
    slippageBps: record.slippageBps,
    timeEstimate: record.timeEstimate,
    fees: record.fees,
    withdrawFee: record.withdrawFee,
    refundFee: record.refundFee,
    recipient: record.recipient,
    refundTo: record.refundTo,
    rewardsAddress: record.rewardsAddress ?? null,
    // As the order was made. One stored before the level was kept has none, and was public.
    routing: routingOf(record.confidentiality),
    // The deposit address is only ever read from the stored order.
    depositAddress: depositsOpen ? record.depositAddress : null,
    depositMemo: depositsOpen ? record.depositMemo : null,
    depositsOpen,
    deadline: record.deadline,
    depositTxHash: state.depositTxHash,
    // True once funds are known to be in the order. "Deposit seen" without it is only an announcement.
    depositProven: proven,
    // A link is offered only for a transaction we confirmed pays this order.
    depositTxUrl: state.depositTxHash !== null && state.depositVerified === true ? explorerTxUrl(record.from.chain, state.depositTxHash) : null,
    details: state.details === null || originKnown ? state.details : { ...state.details, originTxs: [] },
    serverNow: new Date(now).toISOString(),
  };
}

/**
 * The host a sign-in message names, or null when no message may be given. Where SITE_URL itself was
 * set, it is that address and nothing a request says. Otherwise (the live site's address being only
 * the built-in one, or none) it is the host the request was made to, and only when the page that
 * asked is on that same host: so the same build signs in on its own address and on a preview one,
 * and never hands another site a message that names it.
 */
export function signInHost(config: Pick<Config, "siteUrl" | "siteUrlSet">, hostHeader: unknown, originHeader: unknown): string | null {
  if (config.siteUrlSet && config.siteUrl !== null) return new URL(config.siteUrl).host;
  const host = typeof hostHeader === "string" ? hostHeader.slice(0, 100) : "";
  const origin = typeof originHeader === "string" && URL.canParse(originHeader) ? new URL(originHeader).host : null;
  return host !== "" && origin !== null && origin === host ? host : null;
}

export function createApp(deps: AppDeps): RequestListener {
  const { config, log, accessLog, alerts, geo, sanctions, oneclick, tokens, store, poller, rpc, limiters, sessions, rewards, signIn, site, now } = deps;
  const production = config.env === "production";
  // The provider answers private quotes only to a partner with a key. Two things are said in the log
  // once, as the server starts, so that neither is a puzzle later.
  // Nothing was set and there is no key: the site routes in public until there is one.
  if (config.privateRoutingWaitsForKey) log.warn("private_routing_waits_for_key");
  // Private routing was asked for by name with no key (the live site does not start that way, see
  // server/config.ts): only the practice provider will answer a private quote.
  if (config.privacyMode === "basic" && config.oneClickApiKey === null) log.warn("private_routing_without_partner_key");
  const baseHeaders = securityHeaders({ scriptHashes: site?.scriptHashes ?? [] });
  const NOT_FOUND = new HttpError(404, "not_found", "Not found.");

  function limited(name: LimitName, key: string, cost = 1): void {
    const limiter = limiters[name];
    if (!limiter.take(key, cost)) {
      throw new HttpError(429, "rate_limited", "Too many requests. Wait a moment and try again.", { retryAfter: limiter.retryAfter(key) });
    }
  }

  async function snapshotOrFail(): Promise<TokenSnapshot> {
    const snapshot = await tokens.snapshot();
    if (snapshot === null) throw new HttpError(503, "unavailable", "Couldn't load coins.");
    return snapshot;
  }

  function requireNotPaused(): void {
    if (config.swapsPaused) throw new HttpError(503, "paused", "Swaps are paused. Existing orders are still tracked.");
  }

  /** Asks the provider for a quote and verifies it. Never returns an unverified quote. */
  async function fetchQuote(ctx: Ctx, input: QuoteInput, dry: boolean): Promise<{ verified: VerifiedQuote; response: unknown; sent: SentQuote }> {
    const t = now();
    const sent = buildSentQuote(input, { dry, now: t, feeRecipient: config.feeRecipient, feeBps: config.feeBps, feeBpsPrivate: config.feeBpsPrivate });
    // A real quote for an order has a share of the call budget of its own, so previews cannot crowd it out.
    const result = await oneclick.quote(sent as unknown as Record<string, unknown>, dry ? "user" : "order");
    // The provider's tracing ID goes in the access log whether the call worked or not.
    if (result.cid !== undefined) ctx.logCid = result.cid;
    if (!result.ok) {
      // A private quote the provider would not give is answered "private routing is not available".
      // Nothing is asked again in public here: routing a swap in public is the person's choice alone.
      if (refusesPrivate(input, result.status)) throw privateUnavailable();
      if (result.kind === "rejected") throw mapRejection(result.message, input, result.status);
      throw new HttpError(503, "try_later", "The swap service is not responding. Try again shortly.");
    }
    try {
      const verified = verifyQuoteResponse({
        sent,
        response: result.data,
        originChain: input.from.chain,
        now: now(),
        feeRecipient: config.feeRecipient,
        ...(deps.extraSigningKeys === undefined ? {} : { extraSigningKeys: deps.extraSigningKeys }),
      });
      if (verified.correlationId !== null) ctx.logCid = verified.correlationId;
      enforceUsdCap(verified);
      return { verified, response: result.data, sent };
    } catch (err) {
      if (err instanceof QuoteVerificationError) {
        // The reason is a fixed label, never provider text.
        log.error("quote_verification_failed", { reason: err.reason, dry });
        alerts.send("quote_verification", `A ${dry ? "preview" : "live"} quote failed verification (${err.reason}). It was discarded.`, err.reason);
        throw new HttpError(502, "try_later", "We couldn't confirm that quote. Try again shortly.");
      }
      throw err;
    }
  }

  type DepositCheck = { kind: "confirmed"; payers: string[] } | { kind: "pending"; payers: string[] } | { kind: "unknown" } | { kind: "mismatch" } | { kind: "reverted" };

  /**
   * Checks through our own RPC whether a transaction pays the order's deposit address.
   *
   * "confirmed" needs the transaction to be mined and successful. For a token it also needs
   * the token's own transfer record in the receipt: a token can report success without moving
   * anything. Only a confirmed deposit counts as funds in the order.
   *
   * "pending" is a transaction that is not mined yet and reads as the right transfer. It is
   * a claim, not proof: broadcasting one costs nothing and it may never be mined.
   */
  async function inspectDeposit(record: OrderRecord, txHash: string): Promise<DepositCheck> {
    const chain = record.from.chain as WalletChain;
    const [txResult, receiptResult] = await rpc.batch(chain, [
      { method: "eth_getTransactionByHash", params: [txHash] },
      { method: "eth_getTransactionReceipt", params: [txHash] },
    ]);
    if (txResult === undefined || !txResult.ok || !isRecord(txResult.result)) return { kind: "unknown" };
    // Without an answer about the receipt we cannot tell mined from pending.
    if (receiptResult === undefined || !receiptResult.ok) return { kind: "unknown" };
    const tx = txResult.result;
    const receipt = isRecord(receiptResult.result) ? receiptResult.result : null;
    if (receipt !== null && receipt.status !== "0x1") return { kind: "reverted" };

    const to = typeof tx.to === "string" ? tx.to : "";
    // Whoever sent the transaction is screened. When the coins came out of a contract wallet,
    // the wallet named in the transfer record is the real payer and is screened as well.
    const sender = typeof tx.from === "string" && /^0x[0-9a-fA-F]{40}$/.test(tx.from) ? [tx.from] : [];
    const amountIn = BigInt(record.amountIn);

    if (record.from.contract === null) {
      const value = hexToBigInt(tx.value);
      if (!sameAddress(chain, to, record.depositAddress) || value === null || value < amountIn) return { kind: "mismatch" };
      return { kind: receipt === null ? "pending" : "confirmed", payers: sender };
    }

    if (receipt === null) {
      // Not mined: only a direct transfer can be read from the transaction itself.
      const transfer = decodeErc20Transfer(tx.input);
      const reads = transfer !== null && sameAddress(chain, to, record.from.contract) && sameAddress(chain, transfer.to, record.depositAddress) && transfer.amount >= amountIn;
      return reads ? { kind: "pending", payers: sender } : { kind: "unknown" };
    }
    // Every record of this token arriving at the deposit address counts: a wallet may pay in more than one transfer.
    let arrived = 0n;
    const payers = [...sender];
    if (Array.isArray(receipt.logs)) {
      for (const entry of (receipt.logs as unknown[]).slice(0, 200)) {
        const event = decodeTransferLog(entry);
        if (event !== null && sameAddress(chain, event.token, record.from.contract) && sameAddress(chain, event.to, record.depositAddress)) {
          arrived += event.amount;
          payers.push(event.from);
        }
      }
    }
    return arrived >= amountIn ? { kind: "confirmed", payers } : { kind: "mismatch" };
  }

  /**
   * True when a recorded transaction can no longer be the deposit: our RPC knows no
   * transaction with this hash (dropped, or replaced by the wallet), or it was mined and failed.
   */
  async function isDead(chain: WalletChain, txHash: string): Promise<boolean> {
    const [tx, receipt] = await rpc.batch(chain, [
      { method: "eth_getTransactionByHash", params: [txHash] },
      { method: "eth_getTransactionReceipt", params: [txHash] },
    ]);
    if (tx !== undefined && tx.ok && tx.result === null) return true;
    return receipt !== undefined && receipt.ok && isRecord(receipt.result) && receipt.result.status !== "0x1";
  }

  // A repeated order request (a double click, a retried connection) returns the first order instead of making another.
  // The key is tied to what was asked: the same key with a different request is refused.
  const REQUEST_TTL_MS = 10 * 60_000;
  const inFlight = new Map<string, { fingerprint: string; result: Promise<{ status: number; body: unknown }> }>();
  const recentRequests = new Map<string, { orderId: string; fingerprint: string; at: number }>();
  let lastDisagreeLog = 0;
  // Orders being created right now, counted against the open-order cap before they are stored.
  let creating = 0;
  // Which client made each open order. Kept in memory only; it is never written to disk or logged.
  const madeBy = new Map<string, { key: string; wide: string | null }>();
  // Orders each client is creating right now: they count as unpaid before they are stored.
  const creatingBy = new Map<string, number>();
  const bump = (key: string, by: number): void => {
    const next = (creatingBy.get(key) ?? 0) + by;
    if (next > 0) creatingBy.set(key, next);
    else creatingBy.delete(key);
  };
  /** Unpaid orders of one client, and of the wider network it is in, including those being created. */
  const unpaidOf = (clientKey: string, wide: string | null): { client: number; network: number } => {
    let client = creatingBy.get(clientKey) ?? 0;
    let network = wide === null ? 0 : (creatingBy.get(wide) ?? 0);
    for (const [orderId, maker] of madeBy) {
      const state = store.get(orderId)?.state;
      // Every open order that has not started swapping counts: one that is waiting, one whose
      // deposit was only announced, and one that was under-paid. Otherwise announcing a hash, or
      // sending dust, would free a place for another order.
      if (state === undefined || isEndState(state.status) || state.status === "swapping" || state.stopped) {
        madeBy.delete(orderId);
        continue;
      }
      if (maker.key === clientKey) client += 1;
      if (wide !== null && maker.wide === wide) network += 1;
    }
    return { client, network };
  };

  /**
   * The reserve wallet's balance of the payout coin, read from BNB Chain and kept for a minute.
   * Null when the chain could not be read: the page then shows the address without a figure.
   */
  let reserveSeen: { at: number; value: string | null } | null = null;
  async function reserveBalance(address: string): Promise<string | null> {
    const t = now();
    // A practice server's made-up reserve has a made-up balance; the chain is not asked about it.
    const samples = deps.practice?.samples;
    if (samples !== undefined && address === SAMPLE.reserveAddress) return samples.reserveBalance;
    if (reserveSeen !== null && t - reserveSeen.at < 60_000) return reserveSeen.value;
    let value: string | null;
    try {
      // balanceOf(address)
      const reply = await rpc.call("bsc", "eth_call", [{ to: RESERVE_ASSET.contract, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"]);
      const amount = reply.ok ? hexToBigInt(reply.result) : null;
      value = amount === null ? null : amount.toString();
    } catch {
      value = null;
    }
    // A failed read is kept for a shorter while, so that the figure comes back soon after the chain does.
    reserveSeen = { at: value === null ? t - 45_000 : t, value };
    return value;
  }

  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/api\/config$/,
      name: "config",
      cheapRead: true,
      limit: "light",
      handler: async () => {
        const t = now();
        const session = sessions.issue(t);
        const body: ConfigResponse = {
          paused: config.swapsPaused,
          practice: deps.practice !== undefined,
          // The routing level every swap is asked for with. The page says what the server does.
          privacyMode: config.privacyMode,
          testPages: !production,
          reownProjectId: config.reownProjectId,
          tokenAddress: config.tokenAddress,
          tokenPairAddress: config.tokenPairAddress,
          reserveAddress: config.reserveAddress,
          // Only a practice server has any: orders made up so that the list of recent orders can be seen full.
          sampleOrders: deps.practice?.samples?.orderIds ?? [],
          xUrl: config.xUrl,
          dexscreenerUrl: config.dexscreenerUrl,
          githubUrl: config.githubUrl,
          supportContact: config.supportContact,
          // The site's own address, where it is known: the Terms and the Privacy Policy name the site by it.
          siteUrl: config.siteUrl,
          termsVersion: TERMS_VERSION,
          session: session.token,
          sessionExpiresAt: new Date(session.expiresAt).toISOString(),
          serverNow: new Date(t).toISOString(),
        };
        return { status: 200, body };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/status$/,
      name: "status",
      cheapRead: true,
      limit: "light",
      handler: async () => ({ status: 200, body: statusBody() }),
    },
    {
      method: "GET",
      pattern: /^\/api\/tokens$/,
      name: "tokens",
      cheapRead: true,
      limit: "light",
      handler: async () => {
        const snapshot = await snapshotOrFail();
        const body: TokensResponse = {
          tokens: snapshot.views,
          updatedAt: new Date(snapshot.updatedAt).toISOString(),
          serverNow: new Date(now()).toISOString(),
        };
        return { status: 200, body };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/quote$/,
      name: "quote",
      limit: "quote",
      maxBody: 2048,
      needsOrigin: true,
      needsSession: true,
      handler: async (ctx, _match, body) => {
        requireNotPaused();
        if (!isRecord(body)) throw new HttpError(400, "bad_request", "The request could not be read.");
        const snapshot = await snapshotOrFail();
        // The routing level comes from the server's setting, never from the request.
        const input = parseSwapInput(body, snapshot.byId, false, config.privacyMode);
        // Previews from everyone together stay well under the provider budget, so orders and tracking always have room.
        limited("quoteGlobal", "all");
        const { verified } = await fetchQuote(ctx, input, true);
        return { status: 200, body: toQuoteView(input, verified, now()) };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/orders$/,
      name: "order_create",
      limit: "orderCreate",
      maxBody: 4096,
      needsOrigin: true,
      needsSession: true,
      handler: async (ctx, _match, body) => {
        requireNotPaused();
        if (!deps.liveOrders) {
          throw new HttpError(503, "unavailable", "Orders are switched off in local development. Start with PROVIDER_STUB=true to practise.");
        }
        if (!isRecord(body)) throw new HttpError(400, "bad_request", "The request could not be read.");
        if (body.termsAccepted !== true || body.termsVersion !== TERMS_VERSION) {
          throw new HttpError(409, "terms", "Accept the current Terms to continue.");
        }
        const reviewed = body.reviewed;
        if (
          !isRecord(reviewed) ||
          !isDigits(reviewed.amountOut) ||
          !isDigits(reviewed.minAmountOut) ||
          typeof reviewed.totalFeeBps !== "number" ||
          !Number.isInteger(reviewed.totalFeeBps) ||
          reviewed.totalFeeBps < 0 ||
          reviewed.totalFeeBps > 500 ||
          (reviewed.routing !== undefined && !isRouting(reviewed.routing))
        ) {
          throw new HttpError(400, "bad_request", "The reviewed quote is missing.");
        }
        // How the quote the person saw was routed, as that quote said it. Left out, it reads as public.
        const seen = { amountOut: BigInt(reviewed.amountOut), minAmountOut: BigInt(reviewed.minAmountOut), totalFeeBps: reviewed.totalFeeBps, routing: isRouting(reviewed.routing) ? reviewed.routing : routingOf("public") };
        const snapshot = await snapshotOrFail();
        // The routing level comes from the server's setting, never from the request.
        const input = parseSwapInput(body, snapshot.byId, true, config.privacyMode);
        // Where this swap's points go. The person chooses it, as they choose the receiving address;
        // the points themselves are only ever counted on this server, from the order as it is stored.
        let rewardsAddress: string | null = null;
        if (body.rewardsAddress !== undefined && body.rewardsAddress !== null && body.rewardsAddress !== "") {
          rewardsAddress = rewardsAddressOf(body.rewardsAddress);
          if (rewardsAddress === null) throw new HttpError(400, "invalid_rewards", "Enter a BNB Chain address for this swap's points, or leave the field empty.");
        }

        let requestKey: string | null = null;
        // What this request asks for, so a retry key cannot be reused for something else. The routing
        // level is part of it: the same swap asked for the other way is another request.
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([input.from.id, input.to.id, input.amount.toString(), input.pay, input.recipient, input.refundTo, input.sender, input.slippageBps, rewardsAddress, input.confidentiality]))
          .digest("base64url");
        if (body.requestId !== undefined) {
          if (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{22,64}$/.test(body.requestId)) throw new HttpError(400, "bad_request", "The request could not be read.");
          requestKey = `${ctx.ipKey}:${body.requestId}`;
          const earlier = recentRequests.get(requestKey);
          const pending = inFlight.get(requestKey);
          if ((earlier !== undefined && earlier.fingerprint !== fingerprint) || (pending !== undefined && pending.fingerprint !== fingerprint)) {
            throw new HttpError(409, "conflict", "That request was already used for a different swap. Start again.");
          }
          const existing = earlier !== undefined && now() - earlier.at < REQUEST_TTL_MS ? store.get(earlier.orderId) : null;
          if (existing !== null) {
            ctx.logOrder = hashId(existing.id);
            return { status: 200, body: toOrderView(existing, now()) };
          }
          if (pending !== undefined) return pending.result;
        }

        const create = async (): Promise<{ status: number; body: unknown }> => {
          // Every attempt that gets this far counts toward a daily ceiling, whether or not it succeeds.
          limited("orderAttemptDaily", ctx.ipKey);
          if (ctx.wideKey !== null) limited("orderAttemptDailyWide", ctx.wideKey);
          if (deps.diskFull?.()) throw new HttpError(503, "busy", "We're at capacity right now. Try again shortly.");

          // Screen every address before anything is created at the provider.
          const screening = sanctions.screen([input.sender, input.recipient, input.refundTo, rewardsAddress]);
          if (!screening.ok) {
            ctx.logScreening = screening.reason;
            if (screening.reason === "unavailable") throw new HttpError(503, "try_later", "Try again shortly.");
            throw new HttpError(403, "blocked", "This swap can't be processed.");
          }
          ctx.logScreening = "clear";

          // Quotas are reserved now, before the provider is called, so that requests arriving together
          // cannot all slip under the same limit. Whatever is reserved is given back if no order results.
          const recipientKey = `${input.to.chain}:${input.recipient.toLowerCase()}`;
          const reserved: Array<() => void> = [];
          const reserve = (name: "orderCreateDaily" | "orderCreateDailyWide" | "orderPerRecipient", key: string) => {
            const release = limiters[name].hold(key);
            if (release === null) throw new HttpError(429, "rate_limited", "Too many requests. Wait a moment and try again.", { retryAfter: limiters[name].retryAfter(key) });
            reserved.push(release);
          };
          let created = false;
          // Whatever happens below, the in-flight counts are put back.
          const settled: Array<() => void> = [];
          try {
            reserve("orderCreateDaily", ctx.ipKey);
            if (ctx.wideKey !== null) reserve("orderCreateDailyWide", ctx.wideKey);
            reserve("orderPerRecipient", recipientKey);
            const unpaid = unpaidOf(ctx.ipKey, ctx.wideKey);
            if (unpaid.client >= MAX_UNPAID_PER_CLIENT || unpaid.network >= MAX_UNPAID_PER_NETWORK) {
              throw new HttpError(429, "rate_limited", "You have several unpaid orders open. Pay one or wait for it to expire, then try again.", { retryAfter: 600 });
            }
            // Someone whose orders keep being dropped because the price "moved" is asking the provider for work nobody uses.
            if (!limiters.orderPriceMoved.has(ctx.ipKey)) {
              throw new HttpError(429, "rate_limited", "Too many requests. Wait a moment and try again.", { retryAfter: limiters.orderPriceMoved.retryAfter(ctx.ipKey) });
            }
            const { ipKey, wideKey: wide } = ctx;
            bump(ipKey, 1);
            if (wide !== null) bump(wide, 1);
            creating += 1;
            settled.push(() => {
              bump(ipKey, -1);
              if (wide !== null) bump(wide, -1);
              creating -= 1;
            });
            if (store.openCount() + creating > (deps.maxOpenOrders ?? openOrderCap(config.oneClickMaxPerMin))) {
              throw new HttpError(503, "busy", "We're at capacity right now. Try again shortly.");
            }
            // Each real order asked of the provider is counted, and stays counted even if it is then refused.
            // The client's own limits come first: a request they refuse must not use up what all clients share.
            limited("orderLiveDaily", ctx.ipKey);
            if (ctx.wideKey !== null) limited("orderLiveDailyWide", ctx.wideKey);
            limited("orderCreateGlobal", "all");

            const { verified, response, sent } = await fetchQuote(ctx, input, false);
            if (verified.depositAddress === null || verified.deadline === null) {
              throw new HttpError(502, "try_later", "We couldn't confirm that quote. Try again shortly.");
            }

            // Price check against what the person reviewed. A worse price or a higher fee needs a fresh confirmation.
            const feeBps = verified.appBps + verified.providerBps;
            const moved =
              worseByMoreThan(seen.amountOut, BigInt(verified.amountOut), PRICE_TOLERANCE_BPS) ||
              worseByMoreThan(seen.minAmountOut, BigInt(verified.minAmountOut), PRICE_TOLERANCE_BPS) ||
              feeBps > seen.totalFeeBps;
            // The routing is compared too. An order is routed the way the reviewed quote was, or it is
            // not made: the person is shown the quote for the other way, and confirms that or does not.
            const rerouted = routingOf(verified.confidentiality) !== seen.routing;
            if (moved || rerouted) {
              limiters.orderPriceMoved.take(ctx.ipKey);
              throw new HttpError(409, "price_moved", rerouted ? "This swap would be routed another way than the one you reviewed. Check the new details and confirm again." : "The price moved. Check the new numbers and confirm again.", {
                quote: toQuoteView(input, verified, now()),
                expected: true,
              });
            }

            const t = now();
            const iso = new Date(t).toISOString();
            const view = toQuoteView(input, verified, t);
            // Deposits close at whichever comes first: the moment the provider's address goes
            // inactive, or the moment refunds begin (the deadline we asked for).
            const closesAt = Math.min(Date.parse(verified.deadline), Date.parse(sent.deadline));
            const record: OrderRecord = {
              v: 1,
              id: newOrderId(),
              createdAt: iso,
              pay: input.pay,
              from: { id: input.from.id, symbol: input.from.symbol, name: input.from.name, chain: input.from.chain, decimals: input.from.decimals, contract: input.from.contract },
              to: { id: input.to.id, symbol: input.to.symbol, name: input.to.name, chain: input.to.chain, decimals: input.to.decimals, contract: input.to.contract },
              amountIn: verified.amountIn,
              amountOut: verified.amountOut,
              minAmountOut: verified.minAmountOut,
              amountInUsd: verified.amountInUsd,
              amountOutUsd: verified.amountOutUsd,
              slippageBps: input.slippageBps,
              timeEstimate: verified.timeEstimate,
              fees: view.fees,
              withdrawFee: verified.withdrawFee,
              refundFee: verified.refundFee,
              recipient: input.recipient,
              refundTo: input.refundTo,
              sender: input.sender,
              rewardsAddress,
              // The level the verified quote was asked for with. Kept with the order, and never changed.
              confidentiality: verified.confidentiality,
              depositAddress: verified.depositAddress,
              depositMemo: verified.depositMemo,
              deadline: new Date(closesAt).toISOString(),
              termsVersion: TERMS_VERSION,
              screening: screening.record,
              quoteResponse: response,
              state: {
                status: "waiting",
                upstreamStatus: "PENDING_DEPOSIT",
                statusSince: iso,
                updatedAt: iso,
                anchor: t,
                depositTxHash: null,
                depositVerified: false,
                depositForwarded: false,
                details: null,
                finishedAt: null,
                stopped: false,
                slowAlertSent: false,
              },
            };
            store.create(record);
            created = true;
            poller.track(record);
            madeBy.set(record.id, { key: ctx.ipKey, wide: ctx.wideKey });
            if (requestKey !== null) {
              recentRequests.set(requestKey, { orderId: record.id, fingerprint, at: t });
              if (recentRequests.size > 20_000) {
                for (const [key, entry] of recentRequests) if (t - entry.at > REQUEST_TTL_MS) recentRequests.delete(key);
              }
            }
            ctx.logOrder = hashId(record.id);
            return { status: 201, body: toOrderView(record, t) };
          } finally {
            for (const done of settled) done();
            if (!created) for (const release of reserved) release();
          }
        };

        if (requestKey === null) return create();
        const key = requestKey;
        const result = create().finally(() => inFlight.delete(key));
        inFlight.set(key, { fingerprint, result });
        return result;
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/orders\/([^/]{1,80})$/,
      name: "order_read",
      cheapRead: true,
      limit: "orderRead",
      handler: async (ctx, match) => {
        const id = match[1];
        const record = isOrderId(id) ? store.get(id) : null;
        if (record === null) {
          // Unknown and malformed IDs look identical, and guessing is rate limited hard.
          limited("orderMiss", ctx.ipKey);
          throw NOT_FOUND;
        }
        ctx.logOrder = hashId(record.id);
        // Someone is looking: keep this order's checks prompt, and re-check one we no longer poll.
        if (record.state.status === "expired" || record.state.stopped) void poller.recheck(record.id);
        else if (!isEndState(record.state.status)) poller.watch(record.id);
        return { status: 200, body: toOrderView(record, now()) };
      },
    },
    {
      // Finds an order by its deposit address, for the "Track order" page. It answers with the
      // order's ID and nothing else; the order page then shows what it shows to anyone who has
      // the link. An address that is no order's gets the same answer, under the same limits, as an
      // order ID that is no order's.
      method: "POST",
      pattern: /^\/api\/track$/,
      name: "order_find",
      limit: "orderRead",
      maxBody: 512,
      needsOrigin: true,
      needsSession: true,
      handler: async (ctx, _match, body) => {
        // Every look-up is charged before it is made, found or not: a deposit address is public once it
        // has been paid, and the limits themselves must not tell whether an address is one of ours.
        limited("orderFind", ctx.ipKey);
        limited("orderFindDaily", ctx.ipKey);
        if (ctx.wideKey !== null) limited("orderFindDailyWide", ctx.wideKey);
        limited("orderFindGlobal", "all");
        const address = isRecord(body) ? body.depositAddress : undefined;
        const found = typeof address === "string" ? store.findByDeposit(address.trim()) : null;
        // A privately routed order is never found this way. Its deposit address is public once it has
        // been paid, and its page shows both ends of the swap: finding the one from the other would
        // publish the very link that private routing keeps out of public records. Such an order opens
        // from its own link or ID only, and its address is answered exactly as an address that is no order's.
        const record = found !== null && found.confidentiality !== "basic" ? found : null;
        if (record === null) {
          limited("orderMiss", ctx.ipKey);
          throw NOT_FOUND;
        }
        ctx.logOrder = hashId(record.id);
        return { status: 200, body: { id: record.id } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/orders\/([^/]{1,80})\/deposit$/,
      name: "order_deposit",
      limit: "deposit",
      maxBody: 512,
      needsOrigin: true,
      needsSession: true,
      handler: async (ctx, match, body) => {
        const id = match[1];
        const record = isOrderId(id) ? store.get(id) : null;
        if (record === null) {
          limited("orderMiss", ctx.ipKey);
          throw NOT_FOUND;
        }
        ctx.logOrder = hashId(record.id);
        limited("depositPerOrder", record.id);
        const txHash = isRecord(body) ? body.txHash : undefined;
        if (!isValidTxHash(record.from.chain, txHash)) throw new HttpError(400, "bad_request", "That doesn't look like a transaction hash.");
        // An everyday outcome, not a fault: the deposit was often found before the browser got round to naming it.
        if (record.state.status !== "waiting") throw new HttpError(409, "conflict", "This order is no longer waiting for a deposit.", { expected: true });
        const walletChain = isWalletChain(record.from.chain);
        const stored = record.state.depositTxHash;
        const sameHash = stored === txHash;
        if (stored !== null) {
          // The same hash again is not an error. There is nothing more to learn about one we already
          // confirmed, or one on a chain we cannot read; a pending one is looked at again below.
          if (sameHash && (record.state.depositVerified === true || !walletChain)) return { status: 200, body: toOrderView(record, now()) };
          // A hash we confirmed on-chain is replaced only when it can no longer be the deposit: the chain
          // has dropped it, or it was mined and failed. A hash we could not confirm may be corrected
          // while the order is still waiting.
          if (!sameHash && record.state.depositVerified === true && !(walletChain && (await isDead(record.from.chain as WalletChain, stored)))) {
            throw new HttpError(409, "conflict", "A transaction was already recorded for this order.");
          }
        }
        // Corrections are for mistakes, not for a stream of guesses. A hash we can confirm is never turned away for this.
        const tooManyChanges = () => new HttpError(409, "conflict", "The transaction for this order can't be changed again. Your deposit will still be picked up automatically.");
        const changesUsedUp = !sameHash && (record.state.depositSubmissions ?? 0) >= MAX_HASH_SUBMISSIONS;
        if (changesUsedUp && !walletChain) throw tooManyChanges();

        let confirmed = false;
        if (walletChain) {
          // A transfer sent through a smart-contract wallet may not be recognisable until it is mined.
          // Either way the provider finds the deposit on its own; the hash only speeds that up.
          const check = await inspectDeposit(record, txHash);
          if (check.kind === "unknown") throw new HttpError(409, "not_verified", "We can't see that transaction yet. Your deposit will still be picked up automatically.", { expected: true });
          if (check.kind === "reverted") throw new HttpError(400, "not_verified", "That transaction failed on-chain, so nothing was deposited. Send the deposit again.", { expected: true });
          if (check.kind === "mismatch") throw new HttpError(400, "not_verified", "We couldn't match that transaction to this order. If you sent the deposit, it will still be picked up automatically.", { expected: true });
          // The wallet that actually paid is screened too; the address given when the order was made was only a claim.
          if (check.payers.length > 0) {
            const screening = sanctions.screen(check.payers);
            if (!screening.ok) {
              ctx.logScreening = screening.reason;
              if (screening.reason === "unavailable") throw new HttpError(503, "try_later", "Try again shortly.");
              alerts.send("sanctions_hit", `The wallet that paid order ${hashId(record.id)} is on the sanctions list. The transaction was not recorded or forwarded.`, record.id);
              throw new HttpError(403, "blocked", "This swap can't be processed.");
            }
          }
          // Only a mined, successful transfer is proof. A pending one is kept as a note until it is.
          confirmed = check.kind === "confirmed";
          if (changesUsedUp && !confirmed) throw tooManyChanges();
        }

        // Re-read: the order may have changed while we were checking.
        const fresh = store.get(record.id);
        if (fresh === null || fresh.state.status !== "waiting" || fresh.state.depositTxHash !== stored) {
          throw new HttpError(409, "conflict", "A transaction was already recorded for this order.");
        }
        const t = now();
        if (!sameHash || confirmed) {
          store.saveState(fresh.id, {
            ...fresh.state,
            depositTxHash: txHash,
            depositVerified: confirmed,
            depositForwarded: sameHash ? fresh.state.depositForwarded : false,
            depositSubmissions: (fresh.state.depositSubmissions ?? 0) + (sameHash ? 0 : 1),
            // Only a confirmed deposit speeds up this order's checks.
            anchor: confirmed ? t : fresh.state.anchor,
            updatedAt: new Date(t).toISOString(),
          });
        }

        // The hash is passed on at once when that can help: a confirmed deposit, or one on a chain we
        // cannot read (within a limit all clients share). A pending one waits until it is confirmed.
        // If it is not passed on here, the poller offers it later.
        const saved = store.get(fresh.id) ?? fresh;
        const worthPassing = confirmed || (!walletChain && !sameHash);
        if (worthPassing && !saved.state.depositForwarded && limiters.depositForwardGlobal.take("all")) {
          const forwarded = await oneclick.submitDeposit(
            { depositAddress: fresh.depositAddress, txHash, ...(fresh.depositMemo === null ? {} : { memo: fresh.depositMemo }) },
            confirmed ? "tracking" : "idle",
          );
          if (forwarded.cid !== undefined) ctx.logCid = forwarded.cid;
          if (forwarded.ok) {
            // Marked only if this is still the hash on record: it may have been replaced meanwhile.
            const latest = store.get(fresh.id);
            if (latest !== null && latest.state.depositTxHash === txHash && !latest.state.depositForwarded) store.saveState(latest.id, { ...latest.state, depositForwarded: true });
          }
        }
        poller.nudge(fresh.id);
        const latest = store.get(fresh.id) ?? fresh;
        return { status: 200, body: toOrderView(latest, now()) };
      },
    },
    {
      // What anyone may see of the rewards: this week's dates, the totals of the weeks already paid,
      // and the reserve wallet's own balance. No address but the reserve's, and no points at all.
      method: "GET",
      pattern: /^\/api\/rewards$/,
      name: "rewards_summary",
      cheapRead: true,
      limit: "light",
      handler: async () => {
        const t = now();
        const body: RewardsPublic = {
          ...rewards.summary(t),
          reserve: config.reserveAddress === null ? null : { address: config.reserveAddress, asset: { symbol: RESERVE_ASSET.symbol, name: RESERVE_ASSET.name, decimals: RESERVE_ASSET.decimals, contract: RESERVE_ASSET.contract }, balance: await reserveBalance(config.reserveAddress) },
          serverNow: new Date(t).toISOString(),
        };
        return { status: 200, body };
      },
    },
    {
      // The first half of signing in: a one-time code for an address, inside the plain message the wallet is to sign.
      method: "POST",
      pattern: /^\/api\/rewards\/code$/,
      name: "rewards_code",
      limit: "rewardsNonce",
      maxBody: 256,
      needsOrigin: true,
      needsSession: true,
      handler: async (ctx, _match, body) => {
        // The visitor's own limits come first (the route's, by address, and this one, by wider network):
        // a request they refuse must not use up what everyone shares.
        if (ctx.wideKey !== null) limited("rewardsNonceWide", ctx.wideKey);
        limited("rewardsNonceGlobal", "all");
        const address = rewardsAddressOf(isRecord(body) ? body.address : undefined);
        if (address === null) throw new HttpError(400, "invalid_rewards", "That is not a BNB Chain address.");
        // The message names this site, so that a wallet can warn when another site asks for it: the
        // site's own address where one is set. Where none is, it is the host this request was made to,
        // and only when the page that asked is on that same host. A name that reaches the server only
        // in a forwarding header is not taken: a program can write that header as it likes, and
        // another site could then be handed a message that names itself. (Behind a proxy that changes
        // the host, set SITE_URL.)
        const host = signInHost(config, ctx.req.headers.host, ctx.req.headers.origin);
        if (host === null) throw new HttpError(403, "origin", "Signing in is not available from this address.");
        const challenge = signIn.challenge(address, host, now());
        // The parts go with the message, so that the page can put the message together itself and
        // see that it is the one for this site and this address before the wallet is opened.
        return { status: 200, body: { message: challenge.message, nonce: challenge.nonce, issuedAt: new Date(challenge.issuedAt).toISOString(), expiresAt: new Date(challenge.expiresAt).toISOString() } };
      },
    },
    {
      // The second half: the signature. The message is the one this server made for the code; nothing the browser sends is signed over.
      method: "POST",
      pattern: /^\/api\/rewards\/session$/,
      name: "rewards_sign_in",
      limit: "rewardsSignIn",
      maxBody: 512,
      needsOrigin: true,
      needsSession: true,
      handler: async (_ctx, _match, body) => {
        const refused = new HttpError(401, "session", "That sign-in did not work. Try again.");
        if (!isRecord(body)) throw refused;
        const signature = body.signature;
        // The code is used up by this attempt, whatever comes of it.
        const held = signIn.redeem(body.nonce, now());
        if (held === null || typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw refused;
        let signer: string;
        try {
          signer = await recoverMessageAddress({ message: held.message, signature: signature as `0x${string}` });
        } catch {
          throw refused;
        }
        if (signer.toLowerCase() !== held.address.toLowerCase()) throw refused;
        const session = signIn.issue(held.address, now());
        return { status: 200, body: { address: held.address, token: session.token, expiresAt: new Date(session.expiresAt).toISOString() } };
      },
    },
    {
      // One address's own points, for whoever holds a sign-in for that address. There is no route that takes an address and answers with points.
      method: "GET",
      pattern: /^\/api\/rewards\/me$/,
      name: "rewards_read",
      limit: "rewardsRead",
      handler: async (ctx) => {
        const address = signIn.verify(ctx.req.headers["x-rewards-session"], now());
        if (address === null) throw new HttpError(401, "session", "Sign in to see your points.");
        // On a practice server, whoever signs in is given sample points to look at.
        deps.practice?.samples?.ensureFor(address, now());
        return { status: 200, body: rewards.view(address, now()) };
      },
    },
    {
      // Exists only with the practice provider: moves a practice order along.
      method: "POST",
      pattern: /^\/api\/practice\/([^/]{1,80})$/,
      name: "practice",
      limit: "light",
      maxBody: 256,
      needsOrigin: true,
      handler: async (_ctx, match, body) => {
        if (deps.practice === undefined) throw NOT_FOUND;
        const id = match[1];
        const record = isOrderId(id) ? store.get(id) : null;
        const action = isRecord(body) ? body.action : undefined;
        if (record === null) throw NOT_FOUND;
        // Two controls move the practice server's clock instead of the order: to just after this order's
        // deposit details close, or to just after it would expire. Everything on the practice server
        // moves forward together.
        if (action === "late" || action === "expire") {
          if (deps.practice.skipAhead === undefined) throw NOT_FOUND;
          const deadline = Date.parse(record.deadline);
          const target = action === "late" ? deadline - DEPOSIT_CLOSE_MS + 1000 : deadline + EXPIRE_AFTER_DEADLINE_MS + 1000;
          deps.practice.skipAhead(target - now());
          poller.nudge(record.id);
          return { status: 200, body: { ok: true } };
        }
        if (action !== "deposit" && action !== "underpay" && action !== "refund" && action !== "fail") {
          throw new HttpError(400, "bad_request", "Unknown practice action.");
        }
        if (!deps.practice.control(record.depositAddress, action)) throw NOT_FOUND;
        poller.nudge(record.id);
        return { status: 200, body: { ok: true } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/rpc\/([a-z]{2,8})$/,
      name: "rpc",
      limit: null,
      maxBody: 32_768,
      needsOrigin: true,
      needsSession: true,
      handler: async (ctx, match, body) => {
        const chain = match[1] ?? "";
        if (!(WALLET_CHAINS as readonly string[]).includes(chain)) throw NOT_FOUND;
        const parsed = parseProxyBody(body);
        if (parsed === null) throw new HttpError(400, "bad_request", "That request is not supported.");
        limited("rpc", ctx.ipKey, parsed.requests.length);
        limited("rpcGlobal", "all", parsed.requests.length);
        const results = await rpc.batch(chain as WalletChain, parsed.requests.map((r) => r.call));
        const replies = parsed.requests.map((request, i) => {
          const result = results[i];
          if (result !== undefined && result.ok) return { jsonrpc: "2.0", id: request.id, result: result.result };
          const error = result === undefined ? { code: -32603, message: "RPC unavailable" } : { code: result.code, message: result.message, ...(result.data === undefined ? {} : { data: result.data }) };
          return { jsonrpc: "2.0", id: request.id, error };
        });
        return { status: 200, body: parsed.batch ? replies : replies[0] };
      },
    },
  ];

  function statusBody(): StatusResponse {
    const status = config.swapsPaused ? "paused" : oneclick.health().degraded ? "degraded" : "ok";
    return { status, serverNow: new Date(now()).toISOString() };
  }

  async function api(ctx: Ctx, pathname: string): Promise<{ status: number; route: string; country: string | null }> {
    const { req, res } = ctx;
    const client = resolveClientIp(req, config.trustProxyHops);
    let routeName = "unknown";
    let country: string | null = null;
    try {
      // The platform's own health check reaches us from inside its network, not through the public proxy.
      // It may read /api/status only, which says nothing beyond ok, degraded or paused.
      if (pathname === "/api/status" && req.method === "GET" && !client.disagree && (client.direct || client.ip === null || isPrivateIp(client.ip))) {
        // These requests skip the region block, so together they get one small fixed allowance.
        limited("statusExempt", "all");
        sendJson(res, 200, statusBody());
        return { status: 200, route: "status", country: null };
      }

      if (client.disagree && now() - lastDisagreeLog > 60_000) {
        // At most one line a minute, and nothing the client chose goes into it.
        lastDisagreeLog = now();
        log.warn("proxy_headers_disagree");
      }
      const verdict = geo.check(client.ip);
      country = verdict.country;
      if (verdict.blocked) throw new HttpError(403, "region", "Not available in your region.");

      // The per-client limit comes first: a request it refuses must not use up the allowance everyone shares.
      limited("api", ctx.ipKey);
      if (ctx.wideKey !== null) limited("apiWide", ctx.wideKey);

      const candidates = routes.filter((r) => r.pattern.test(pathname));
      const route = candidates.find((r) => r.method === req.method);
      // Then the allowance everyone shares. The cheap reads have their own, far larger; anything else,
      // an address that is no route included, counts against the smaller one.
      limited(route?.cheapRead === true ? "apiReadsGlobal" : "apiGlobal", "all");
      if (candidates.length === 0) throw NOT_FOUND;
      if (route === undefined) throw new HttpError(405, "bad_request", "Method not allowed.");
      routeName = route.name;
      const match = route.pattern.exec(pathname);
      if (match === null) throw NOT_FOUND;

      if (route.limit !== null) limited(route.limit, ctx.ipKey);
      if (route.needsOrigin && !isSameOrigin(req, config.trustProxyHops > 0)) {
        throw new HttpError(403, "origin", "This request must come from the site itself.");
      }
      if (route.needsSession && !sessions.verify(req.headers["x-session"], now())) {
        throw new HttpError(401, "session", "Your session expired. Reload and try again.");
      }
      const body = route.method === "POST" ? await readJson(req, route.maxBody ?? 1024) : undefined;
      const result = await route.handler(ctx, match, body);
      sendJson(res, result.status, result.body);
      return { status: result.status, route: routeName, country };
    } catch (err) {
      if (err instanceof HttpError) {
        // An everyday outcome travels as a 200 with the error in the body; the access log keeps its real kind.
        sendJson(res, err.expected ? 200 : err.status, errorBody(err), err.retryAfter === undefined ? {} : { "Retry-After": String(err.retryAfter) });
        return { status: err.status, route: routeName, country };
      }
      // Never a stack trace or an upstream body.
      log.error("unhandled", { route: routeName, kind: errorKind(err) });
      sendJson(res, 500, errorBody(new HttpError(500, "unavailable", "Something went wrong. Try again.")));
      return { status: 500, route: routeName, country };
    }
  }

  return (req, res) => {
    const started = now();
    for (const [name, value] of Object.entries(baseHeaders)) res.setHeader(name, value);

    const pathname = requestPath(req);
    if (pathname === null) {
      sendJson(res, 400, errorBody(new HttpError(400, "bad_request", "Bad request.")));
      return;
    }

    const client = resolveClientIp(req, config.trustProxyHops);
    const ctx: Ctx = { req, res, ipKey: rateKey(client.ip), wideKey: wideKey(client.ip) };

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      void api(ctx, pathname)
        .then(({ status, route, country }) => {
          accessLog.write({
          route,
          method: req.method ?? "",
          status,
          ms: now() - started,
          ip: truncateIp(client.ip),
          country,
          ...(ctx.logOrder === undefined ? {} : { order: ctx.logOrder }),
          ...(ctx.logScreening === undefined ? {} : { screening: ctx.logScreening }),
          ...(ctx.logCid === undefined ? {} : { cid: ctx.logCid }),
          });
        })
        .catch(() => {
          log.error("access_log_failed");
        });
      return;
    }

    if (!limiters.pages.take(ctx.ipKey)) {
      res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60", "Cache-Control": "no-store" });
      res.end("Too many requests.");
      return;
    }
    if (site === null) {
      res.writeHead(production ? 503 : 404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("The site has not been built yet.");
      return;
    }
    site.handle(req, res, pathname);
  };
}
