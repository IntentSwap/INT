// Builds the whole application around stubs, on a real HTTP port.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { TERMS_VERSION, type OrderView, type QuoteView } from "../shared/api.ts";
import type { WalletChain } from "../shared/chains.ts";
import { createAlerts, type AlertKind } from "../server/alerts.ts";
import { ALLOWLIST } from "../server/allowlist.ts";
import { createApp, type AppDeps } from "../server/app.ts";
import { loadConfig, type Config } from "../server/config.ts";
import { createStaticGeo, type Geo } from "../server/geo.ts";
import { createLogger, type AccessEntry } from "../server/log.ts";
import { createOneClick, type OneClick, type UpstreamResult } from "../server/oneclick.ts";
import { createPoller, type Poller } from "../server/poller.ts";
import { createLimiters, type Limit, type LimitName } from "../server/ratelimit.ts";
import { createRpc, type Rpc, type RpcCall, type RpcResult } from "../server/rpc.ts";
import { createRewards, createSignIn, type Rewards, type SignIn } from "../server/rewards.ts";
import { createStaticSanctions, type Sanctions } from "../server/sanctions.ts";
import { createSessionIssuer } from "../server/session.ts";
import type { StaticSite } from "../server/static.ts";
import { createStats } from "../server/stats.ts";
import { createOrderStore, type OrderStore } from "../server/store.ts";
import { createStubProvider, type StubProvider } from "../server/stub-provider.ts";
import { createTokenService, type TokenService } from "../server/tokens.ts";

export const FIXTURE_TOKENS: unknown[] = JSON.parse(fs.readFileSync(new URL("./fixtures/tokens.json", import.meta.url), "utf8")) as unknown[];

export const ASSET = {
  baseEth: "nep141:base.omft.near",
  baseUsdc: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  arbUsdc: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  bnb: "nep245:v2_1.omni.hot.tg:56_11111111111111111111",
  solUsdt: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
  sol: "nep141:sol.omft.near",
  btc: "1cs_v1:btc:native:coin",
  zec: "nep141:zec.omft.near",
  xrp: "nep141:xrp.omft.near",
  xlm: "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz",
  pepe: "nep141:eth-0x6982508145454ce325ddbe47a25d4ec3d2311933.omft.near",
} as const;

export const ADDR = {
  evm: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  evm2: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  evm3: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  sol: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  btc: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  stellar: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
} as const;

export interface FakeRpc extends Rpc {
  /** Transactions returned by eth_getTransactionByHash, keyed by hash. */
  txs: Map<string, Record<string, unknown>>;
  /** Receipts returned by eth_getTransactionReceipt, keyed by hash. Absent means not mined yet. */
  receipts: Map<string, Record<string, unknown>>;
  /** Runs before each batch is answered. Lets a test hold a request open or change state mid-flight. */
  beforeBatch: (() => Promise<void>) | null;
  /** Overrides for on-chain decimals, keyed by lower-case contract. */
  decimals: Map<string, number>;
  /** What balanceOf answers for a holder (lower-case address), whichever token is asked about. */
  balances: Map<string, bigint>;
  /** What balanceOf answers for one token and one holder, keyed "token:holder" in lower case. Looked at before `balances`. */
  tokenBalances: Map<string, bigint>;
  /** What eth_getBalance answers for a holder (lower-case address). Anyone else holds one whole coin. */
  native: Map<string, bigint>;
  down: boolean;
  calls: Array<{ chain: string; call: RpcCall }>;
}

export function createFakeRpc(): FakeRpc {
  const rpc: FakeRpc = {
    txs: new Map(),
    receipts: new Map(),
    beforeBatch: null,
    decimals: new Map(),
    balances: new Map(),
    tokenBalances: new Map(),
    native: new Map(),
    down: false,
    calls: [],
    async batch(chain: WalletChain, calls: RpcCall[]): Promise<RpcResult[]> {
      if (rpc.beforeBatch) await rpc.beforeBatch();
      return calls.map((call): RpcResult => {
        rpc.calls.push({ chain, call });
        if (rpc.down) return { ok: false, code: -32603, message: "RPC unavailable" };
        if (call.method === "eth_call") {
          const data = String((call.params[0] as { data?: string }).data ?? "");
          const to = String((call.params[0] as { to?: string }).to).toLowerCase();
          // balanceOf(holder)
          const held = data.startsWith("0x70a08231") ? (rpc.tokenBalances.get(`${to}:0x${data.slice(-40)}`) ?? rpc.balances.get(`0x${data.slice(-40)}`)) : undefined;
          if (held !== undefined) return { ok: true, result: `0x${held.toString(16).padStart(64, "0")}` };
          const known = rpc.decimals.get(to) ?? ALLOWLIST.find((c) => c.contractAddress === to)?.decimals;
          if (known === undefined) return { ok: false, code: 3, message: "execution reverted" };
          return { ok: true, result: `0x${known.toString(16).padStart(64, "0")}` };
        }
        if (call.method === "eth_getTransactionByHash") return { ok: true, result: rpc.txs.get(String(call.params[0])) ?? null };
        if (call.method === "eth_getTransactionReceipt") return { ok: true, result: rpc.receipts.get(String(call.params[0])) ?? null };
        if (call.method === "eth_chainId") return { ok: true, result: "0x1" };
        if (call.method === "eth_getBalance") return { ok: true, result: `0x${(rpc.native.get(String(call.params[0]).toLowerCase()) ?? 10n ** 18n).toString(16)}` };
        return { ok: false, code: -32601, message: "method not found" };
      });
    },
    async call(chain, method, params) {
      const [result] = await rpc.batch(chain, [{ method, params }]);
      return result ?? { ok: false, code: -32603, message: "RPC unavailable" };
    },
  };
  return rpc;
}

/** keccak256("Transfer(address,address,uint256)"): the first topic of a token's own record of a transfer. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** A token's own record of a transfer, as a receipt holds it among its logs. */
export function transferLog(token: string, from: string, to: string, amount: bigint): Record<string, unknown> {
  const word = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  return { address: token, topics: [TRANSFER_TOPIC, word(from), word(to)], data: `0x${amount.toString(16).padStart(64, "0")}` };
}

/**
 * Puts a transaction on the fake chain as mined, with the logs its receipt holds: successful unless
 * told otherwise. Without a receipt a transaction is only pending.
 */
export function putMined(rpc: FakeRpc, hash: string, tx: Record<string, unknown>, logs: unknown[] = [], status = "0x1"): void {
  rpc.txs.set(hash, tx);
  rpc.receipts.set(hash, { status, logs });
}

export interface ProviderTap {
  /** Every quote body sent to the provider. */
  quotes: Array<Record<string, unknown>>;
  /** Changes a request before the provider sees it (the provider then signs the changed request). */
  tamperRequest: ((body: Record<string, unknown>) => Record<string, unknown>) | null;
  /** Changes a response after the provider signed it. */
  corruptResponse: ((data: Record<string, unknown>) => unknown) | null;
  /** Replaces the next quote result outright. */
  nextQuote: UpstreamResult | null;
  tokensResult: UpstreamResult | null;
  /** What the provider client reports about its own health. */
  degraded: boolean;
  /** Runs before each quote is answered, and is given what was asked. Lets a test hold a quote open at the provider. */
  beforeQuote: ((body: Record<string, unknown>) => Promise<void>) | null;
  /** When true, forwarding a deposit hash to the provider fails. */
  submitFails: boolean;
  /** Answers status requests in place of the practice provider. Returning null lets the practice provider answer. */
  statusReply: ((depositAddress: string) => UpstreamResult | null) | null;
  /** Every deposit hash passed on to the provider, as it was sent. */
  submits: Array<Record<string, unknown>>;
  /** The budget class of every quote, every status request and every forwarded hash, in order. */
  quoteClasses: string[];
  statusClasses: string[];
  submitClasses: string[];
}

export interface Harness {
  url: string;
  config: Config;
  clock: { t: number };
  stub: StubProvider;
  tap: ProviderTap;
  rpc: FakeRpc;
  store: OrderStore;
  rewards: Rewards;
  signIn: SignIn;
  poller: Poller;
  tokens: TokenService;
  dataDir: string;
  logs: string[];
  access: AccessEntry[];
  alerts: Array<{ kind: AlertKind; text: string }>;
  session(ip?: string): Promise<string>;
  get(path: string, options?: RequestOptions): Promise<Reply>;
  post(path: string, body: unknown, options?: RequestOptions): Promise<Reply>;
  quote(body: Record<string, unknown>, options?: RequestOptions): Promise<Reply>;
  order(overrides?: Record<string, unknown>, options?: RequestOptions): Promise<Reply>;
  close(): Promise<void>;
}

export interface RequestOptions {
  ip?: string;
  origin?: string | null;
  session?: string | null;
  headers?: Record<string, string>;
  rawBody?: string;
  contentType?: string;
}

export interface Reply {
  status: number;
  headers: Headers;
  body: any;
  text: string;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  geo?: Geo;
  sanctions?: Sanctions;
  liveOrders?: boolean;
  maxOpenOrders?: number;
  site?: StaticSite | null;
  practice?: boolean;
  /** Smaller limits, so a test can reach one without thousands of requests. */
  limits?: Partial<Record<LimitName, Limit>>;
  /**
   * Use the real provider, RPC and alert clients (the ones that hold the key, the RPC URLs and
   * the webhook URL) on top of this pretend network, instead of the in-process stand-ins.
   */
  network?: typeof fetch;
  diskFull?: () => boolean;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-test-"));
  // Routing is public here unless a test's own settings say otherwise, so that tests written before
  // private routing still mean what they meant. Tests of private routing set PRIVACY_MODE to "basic".
  const config = loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, TRUST_PROXY_HOPS: "1", PRIVACY_MODE: "public", REGION_BLOCK: "on", ...options.env });
  const clock = { t: Date.parse("2026-10-08T12:00:00.000Z") };
  const now = () => clock.t;
  const logs: string[] = [];
  const access: AccessEntry[] = [];
  const alerts: Harness["alerts"] = [];
  const log = createLogger((line) => logs.push(line));
  const stub = createStubProvider({ upstream: null, tokens: FIXTURE_TOKENS, now });
  const tap: ProviderTap = { quotes: [], tamperRequest: null, corruptResponse: null, nextQuote: null, tokensResult: null, degraded: false, beforeQuote: null, submitFails: false, statusReply: null, submits: [], quoteClasses: [], statusClasses: [], submitClasses: [] };

  const oneclick: OneClick = {
    tokens: async () => tap.tokensResult ?? stub.provider.tokens(),
    async quote(body, priority) {
      tap.quotes.push(body);
      tap.quoteClasses.push(priority ?? "user");
      if (tap.beforeQuote) await tap.beforeQuote(body);
      if (tap.nextQuote !== null) {
        const result = tap.nextQuote;
        tap.nextQuote = null;
        return result;
      }
      const result = await stub.provider.quote(tap.tamperRequest ? tap.tamperRequest(body) : body, priority);
      if (result.ok && tap.corruptResponse) return { ...result, data: tap.corruptResponse(result.data as Record<string, unknown>) };
      return result;
    },
    async status(address, memo, priority) {
      tap.statusClasses.push(priority ?? "user");
      return tap.statusReply?.(address) ?? stub.provider.status(address, memo, priority);
    },
    async submitDeposit(body, priority) {
      tap.submits.push({ ...body });
      tap.submitClasses.push(priority ?? "user");
      return tap.submitFails ? { ok: false, kind: "unavailable", status: 503 } : stub.provider.submitDeposit(body, priority);
    },
    health: () => ({ degraded: tap.degraded, errorRate: tap.degraded ? 1 : 0, calls: tap.degraded ? 3 : 0 }),
  };

  const rpc = createFakeRpc();
  const delivered = options.network ? createAlerts({ webhookUrl: config.alertWebhookUrl, log, fetchImpl: options.network, now }) : null;
  const alertSink = {
    send: (kind: AlertKind, text: string, dedupeKey?: string) => {
      alerts.push({ kind, text });
      delivered?.send(kind, text, dedupeKey);
    },
  };
  const realProvider = options.network ? createOneClick({ apiKey: config.oneClickApiKey, maxPerMin: 1000, allowLive: true, log, fetchImpl: options.network, now }) : null;
  const realRpc = options.network ? createRpc({ urls: config.rpcUrls, fetchImpl: options.network }) : null;
  const tokens = createTokenService({ oneclick: realProvider ?? oneclick, rpc: realRpc ?? rpc, alerts: alertSink, log, dataDir, excludedChains: config.excludedChains, now });
  const rewards = createRewards(dataDir);
  const signIn = createSignIn();
  // The site's totals are told of each saved state as the server itself tells them (see server/boot.ts).
  const stats = createStats(dataDir, { now });
  const store: OrderStore = createOrderStore(dataDir, {
    onState(record) {
      rewards.recordDelivered(record);
      stats.recordDelivered(record, () => store.markCounted(record.id));
    },
  });
  const poller = createPoller({ store, oneclick: realProvider ?? oneclick, alerts: alertSink, log, now });

  const deps: AppDeps = {
    config,
    log,
    accessLog: { write: (entry) => void access.push(entry), prune() {} },
    alerts: alertSink,
    geo: options.geo ?? createStaticGeo(),
    sanctions: options.sanctions ?? createStaticSanctions([], { now }),
    oneclick: realProvider ?? oneclick,
    tokens,
    store,
    poller,
    rpc: realRpc ?? rpc,
    limiters: createLimiters(now, options.limits),
    sessions: createSessionIssuer(),
    rewards,
    signIn,
    stats,
    site: options.site ?? null,
    now,
    liveOrders: options.liveOrders ?? true,
    extraSigningKeys: [stub.signingKey],
    ...(options.maxOpenOrders === undefined ? {} : { maxOpenOrders: options.maxOpenOrders }),
    ...(options.practice
      ? {
          practice: {
            control: stub.control,
            skipAhead(ms: number) {
              if (ms > 0) clock.t += ms;
            },
          },
        }
      : {}),
    ...(options.diskFull ? { diskFull: options.diskFull } : {}),
  };

  const server = http.createServer(createApp(deps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sessions = new Map<string, string>();

  async function send(method: string, pathname: string, body: unknown, opts: RequestOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "203.0.113.10", ...opts.headers };
    if (opts.origin !== null) headers.origin = opts.origin ?? url;
    if (opts.session) headers["x-session"] = opts.session;
    let payload: string | undefined;
    if (method === "POST") {
      headers["content-type"] = opts.contentType ?? "application/json";
      payload = opts.rawBody ?? JSON.stringify(body);
    }
    const res = await fetch(url + pathname, { method, headers, body: payload });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, headers: res.headers, body: parsed, text };
  }

  const h: Harness = {
    url,
    config,
    clock,
    stub,
    tap,
    rpc,
    store,
    rewards,
    signIn,
    poller,
    tokens,
    dataDir,
    logs,
    access,
    alerts,
    async session(ip = "203.0.113.10") {
      const cached = sessions.get(ip);
      if (cached) return cached;
      const reply = await send("GET", "/api/config", undefined, { ip });
      const token = String(reply.body.session);
      sessions.set(ip, token);
      return token;
    },
    get: (pathname, opts) => send("GET", pathname, undefined, opts),
    post: (pathname, body, opts) => send("POST", pathname, body, opts),
    async quote(body, opts = {}) {
      const session = opts.session === undefined ? await h.session(opts.ip) : opts.session;
      return send("POST", "/api/quote", body, { ...opts, session });
    },
    async order(overrides = {}, opts = {}) {
      const session = opts.session === undefined ? await h.session(opts.ip) : opts.session;
      const base: Record<string, unknown> = {
        from: ASSET.baseEth,
        to: ASSET.arbUsdc,
        amount: "5000000000000000",
        pay: "wallet",
        sender: ADDR.evm,
        recipient: ADDR.evm2,
        refundTo: ADDR.evm,
        termsVersion: TERMS_VERSION,
        termsAccepted: true,
        ...overrides,
      };
      if (base.reviewed === undefined) {
        // The preview is asked for the way the order will be: with the same choice about routing, as the page does.
        const preview = await send("POST", "/api/quote", { from: base.from, to: base.to, amount: base.amount, pay: base.pay, recipient: base.recipient, refundTo: base.refundTo, ...(base.sender ? { sender: base.sender } : {}), ...(base.slippageBps !== undefined ? { slippageBps: base.slippageBps } : {}), ...(base.withoutPrivate !== undefined ? { withoutPrivate: base.withoutPrivate } : {}) }, { ...opts, session });
        if (preview.status !== 200) throw new Error(`preview failed: ${preview.status} ${preview.text}`);
        const q = preview.body as QuoteView;
        base.reviewed = { amountOut: q.amountOut, minAmountOut: q.minAmountOut, totalFeeBps: q.fees.appBps + q.fees.providerBps, routing: q.routing };
      }
      return send("POST", "/api/orders", base, { ...opts, session });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return h;
}

/**
 * What a request came to: "ok", or the error code. Everyday outcomes (no route, price moved,
 * a transaction that cannot be matched) travel as HTTP 200 with the error in the body, so
 * tests ask for the outcome rather than the status.
 */
export function outcome(reply: Reply): string {
  const code = reply.body?.error?.code;
  if (typeof code === "string") return code;
  return reply.status >= 200 && reply.status < 300 ? "ok" : `http ${reply.status}`;
}

export function asOrder(reply: Reply): OrderView {
  if ((reply.status !== 201 && reply.status !== 200) || reply.body?.error) throw new Error(`expected an order, got ${reply.status}: ${reply.text}`);
  return reply.body as OrderView;
}

/**
 * Waits for something that happens in the background for as long as the machine takes over it,
 * instead of for a time guessed to be long enough. A machine however slow is given ten seconds.
 */
export async function eventually(seen: () => boolean): Promise<void> {
  await vi.waitUntil(seen, { timeout: 10_000, interval: 5 });
}

/**
 * Sends requests so that they are under way together on any machine, fast or slow. A request for
 * an order that reaches the provider is held open there until every other one has either been
 * answered or is held there too. Only then are they let through.
 */
export async function sentTogether(h: Harness, sends: Array<() => Promise<Reply>>): Promise<Reply[]> {
  let held = 0;
  let answered = 0;
  let letThrough: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (letThrough = resolve));
  h.tap.beforeQuote = async (body) => {
    // A preview on the way to an order is not held: only the quote that makes the order is.
    if (body.dry !== false) return;
    held += 1;
    await gate;
  };
  const replies = sends.map((send) => send().finally(() => (answered += 1)));
  await eventually(() => held + answered === sends.length);
  h.tap.beforeQuote = null;
  letThrough();
  return Promise.all(replies);
}
