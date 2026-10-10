// Ghost mode, on the server. An order made in it carries a mark. The mark changes nothing about
// making the order; it decides what is kept of it. Such an order is counted in the site's totals
// and listed nowhere. Its record is deleted at the first moment the server knows that nothing more
// can happen to it and that no funds are in it: at once when it is delivered or refunded, and, when
// it ran out unpaid, when the watch for a late deposit ends. All that can be said of it afterwards,
// for 30 days, is that it finished, and in one word how.

import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toChecksumAddress } from "../shared/addresses.ts";
import { TERMS_VERSION, type CoinRef, type OrderStatus, type OrderView, type QuoteView, type StatsResponse } from "../shared/api.ts";
import { weekOf } from "../shared/rewards.ts";
import { createAlerts } from "../server/alerts.ts";
import { boot, type Booted } from "../server/boot.ts";
import { createLogger, hashId, silentLogger } from "../server/log.ts";
import { createSweeper } from "../server/maintenance.ts";
import { createOneClick, type UpstreamResult } from "../server/oneclick.ts";
import { EXPIRE_AFTER_DEADLINE_MS, GIVE_UP_AFTER_DEADLINE_MS, tracingOf } from "../server/poller.ts";
import { LIMITS, MAX_UNPAID_PER_CLIENT, RateLimiter } from "../server/ratelimit.ts";
import { createRewards } from "../server/rewards.ts";
import { createStaticSanctions, type Sanctions } from "../server/sanctions.ts";
import { createSettler } from "../server/settle.ts";
import { createStats, type StatsFile } from "../server/stats.ts";
import { createOrderStore, endedEmpty, endingOf, FINISHED_RETENTION_MS, isExpiredRecord, UNFUNDED_RETENTION_MS, WIPED_KEPT_MS, wipeDue, type OrderRecord, type OrderState, type OrderStore } from "../server/store.ts";
import { ADDR, asOrder, ASSET, eventually, FIXTURE_TOKENS, harness, outcome, putMined, type Harness, type HarnessOptions, type Reply } from "./helpers.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Where every test's clock starts, and the day that moment is in. */
const NOON = Date.parse("2026-10-08T12:00:00.000Z");
const THAT_DAY = Date.parse("2026-10-08T00:00:00.000Z");
const ROOMY = { max: 100_000, windowMs: DAY };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// Every address and hash here is made up from fixed text, so they are nobody's, and none is like any other the tests use.
const made = (label: string, bytes: number) => sha(`ghost test ${label}`).slice(0, bytes * 2);
const address = (label: string) => toChecksumAddress(`0x${made(label, 20)}`);
const txHash = (label: string) => `0x${made(label, 32)}`;
/** Whose addresses a Ghost order of these tests is made with. */
const WHO = { sender: address("sender"), recipient: address("recipient"), refundTo: address("refund"), rewards: address("rewards") };
const SWAP = { sender: WHO.sender, recipient: WHO.recipient, refundTo: WHO.refundTo };
/** The amount every order here pays, as a wallet sends it: 0.005 ETH. */
const PAID = "0x11c37937e08000";

/** All that is said of a Ghost order once its record is deleted: that it finished and, in one word, how. Without the word where it is not known. */
const gone = (ended?: "delivered" | "refunded" | "expired") => ({ error: { code: "order_deleted", message: "This order finished, and its record was deleted.", ...(ended === undefined ? {} : { detail: { ended } }) } });
/** What an ID that is no order's has always been answered. */
const NEVER = '{"error":{"code":"not_found","message":"Not found."}}';

let open: Harness[] = [];
let folders: string[] = [];
let running: Booted[] = [];
async function start(options: HarnessOptions = {}): Promise<Harness> {
  const h = await harness(options);
  open.push(h);
  return h;
}
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-ghost-"));
  folders.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(running.map((b) => new Promise<void>((resolve) => (b.server.listening ? b.stop(resolve) : resolve()))));
  running = [];
  await Promise.all(open.map((h) => h.close()));
  open = [];
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true });
  folders = [];
});

// ---- where things are kept in a data folder ----
const depositKey = (deposit: string) => (/^0x[0-9a-fA-F]+$/.test(deposit) ? deposit.toLowerCase() : deposit);
const orderFile = (dir: string, id: string) => path.join(dir, "orders", `${id}.json`);
const indexFile = (dir: string, deposit: string) => path.join(dir, "by-deposit", sha(depositKey(deposit)));
const goneDir = (dir: string) => path.join(dir, "ghost", "gone");
const goneFile = (dir: string, id: string) => path.join(goneDir(dir), sha(id));
const entriesDir = (dir: string) => path.join(dir, "rewards", "entries");
const entryFile = (dir: string, id: string) => path.join(entriesDir(dir), `${sha(id)}.json`);
const statsText = (dir: string) => fs.readFileSync(path.join(dir, "stats", "stats.json"), "utf8");
const statsFile = (dir: string) => JSON.parse(statsText(dir)) as StatsFile;
/** Every file under a folder: its path from the folder, and what it holds. */
function everyFile(dir: string, under = ""): Array<{ name: string; text: string }> {
  return fs.readdirSync(path.join(dir, under), { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(under, entry.name);
    return entry.isDirectory() ? everyFile(dir, name) : [{ name, text: fs.readFileSync(path.join(dir, name), "utf8") }];
  });
}

/**
 * Whether a text carries a value in any spelling: as it is, in lower case, in capitals, in the
 * checksum spelling of an address, and each of those without its 0x.
 */
function carries(text: string, value: string): boolean {
  const bare = value.replace(/^0x/i, "");
  const spellings = [value, value.toLowerCase(), value.toUpperCase(), bare, bare.toLowerCase(), bare.toUpperCase()];
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) spellings.push(toChecksumAddress(value), toChecksumAddress(value).slice(2));
  return spellings.some((spelling) => text.includes(spelling)) || text.toLowerCase().includes(bare.toLowerCase());
}

// ---- moving an order along ----
const ghostly = async (h: Harness, overrides: Record<string, unknown> = {}, ip?: string) => asOrder(await h.order({ ...SWAP, ghost: true, ...overrides }, ip ? { ip } : {}));
const plainly = async (h: Harness, overrides: Record<string, unknown> = {}, ip?: string) => asOrder(await h.order({ ...SWAP, ...overrides }, ip ? { ip } : {}));
/** Lets time pass and has the poller look at one order. */
async function step(h: Harness, id: string, ms: number): Promise<void> {
  h.clock.t += ms;
  h.poller.nudge(id);
  await h.poller.tick();
}
const statusOf = (h: Harness, id: string) => h.store.get(id)?.state.status ?? null;
/** What the provider says of an order from now on, whatever the practice provider would say. */
const answer = (status: string, swapDetails: unknown = {}) => (deposit: string): UpstreamResult => ({ ok: true, status: 200, data: { status, swapDetails, quoteResponse: { quote: { depositAddress: deposit } } } });
/** Paid and delivered, as the practice provider reports it: deposit seen, swapping, delivered. */
async function deliver(h: Harness, order: OrderView): Promise<void> {
  h.stub.control(order.depositAddress!, "deposit");
  await step(h, order.id, 5000);
  await step(h, order.id, 5000);
  await step(h, order.id, 15_000);
}
async function refund(h: Harness, order: OrderView): Promise<void> {
  h.stub.control(order.depositAddress!, "refund");
  await step(h, order.id, 5000);
  await step(h, order.id, 5000);
}
/** Nobody pays, and the deadline passes. */
async function runOut(h: Harness, order: OrderView): Promise<void> {
  h.clock.t = Date.parse(order.deadline) + EXPIRE_AFTER_DEADLINE_MS;
  await step(h, order.id, 1000);
}
/** A day after an order's deadline, when the watch for a late deposit ends: the clean-up pass asks the provider about it one last time. */
async function watchEnds(h: Harness, order: OrderView): Promise<void> {
  h.clock.t = Math.max(h.clock.t, Date.parse(order.deadline) + UNFUNDED_RETENTION_MS + 1000);
  await h.sweep();
}
/** The person's wallet sends the deposit and the page names the transaction, which this server finds on the chain. */
async function payByWallet(h: Harness, order: OrderView, hash: string, from = WHO.sender): Promise<Reply> {
  putMined(h.rpc, hash, { from, to: order.depositAddress, value: PAID, input: "0x" });
  return h.post(`/api/orders/${order.id}/deposit`, { txHash: hash }, { session: await h.session() });
}

/**
 * For a request made after the test has moved the clock a long way: the coin list is read again, as
 * the server does by itself every minute, and the visitor has a session of the present.
 */
async function muchLater(h: Harness, ip = "203.0.113.10"): Promise<{ session: string; ip: string }> {
  await h.tokens.refresh();
  return { session: String((await h.get("/api/config", { ip })).body.session), ip };
}

/** A stored order with every field a real one has, for tests that put records on disk themselves. */
const ETH: CoinRef = { id: ASSET.baseEth, symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null };
const USDC: CoinRef = { id: ASSET.arbUsdc, symbol: "USDC", name: "USD Coin", chain: "arb", decimals: 6, contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" };
const idOf = (n: number) => `GhostTestOrder${String(n).padStart(13, "0")}`;
const iso = (ms: number) => new Date(ms).toISOString();
function stored(n: number, extra: Partial<OrderRecord> = {}): OrderRecord {
  const at = NOON - 40_000;
  return {
    v: 1,
    id: idOf(n),
    createdAt: iso(at),
    pay: "wallet",
    from: ETH,
    to: USDC,
    amountIn: String(5_000_000_000_000_000n + BigInt(n)),
    amountOut: String(12_000_000n + BigInt(n)),
    minAmountOut: String(11_880_000n + BigInt(n)),
    amountInUsd: "250.5",
    amountOutUsd: "249.1",
    slippageBps: 100,
    timeEstimate: 30,
    fees: { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "1" },
    withdrawFee: null,
    refundFee: null,
    recipient: address(`recipient ${n}`),
    refundTo: address(`refund ${n}`),
    sender: address(`sender ${n}`),
    rewardsAddress: address(`rewards ${n}`),
    confidentiality: "public",
    depositAddress: address(`deposit ${n}`),
    depositMemo: null,
    deadline: iso(at + 30 * MINUTE),
    termsVersion: "test",
    screening: { result: "clear", listVersion: "test", checkedAt: iso(at) },
    quoteResponse: { quote: { depositAddress: address(`deposit ${n}`) }, signature: `ed25519:${made(`signature ${n}`, 32)}` },
    state: { status: "waiting", upstreamStatus: "PENDING_DEPOSIT", statusSince: iso(at), updatedAt: iso(at), anchor: at, depositTxHash: null, depositVerified: false, depositForwarded: false, details: null, finishedAt: null, stopped: false, slowAlertSent: false },
    ...extra,
  };
}
/** The same order's state once it has ended, as the poller writes it. */
function ended(record: OrderRecord, status: OrderStatus = "delivered", at = NOON): OrderState {
  const paid = txHash(`paid ${record.id}`);
  const unpaid = status === "expired";
  return {
    ...record.state,
    status,
    upstreamStatus: status === "delivered" ? "SUCCESS" : status === "refunded" ? "REFUNDED" : status === "failed" ? "FAILED" : "PENDING_DEPOSIT",
    statusSince: iso(at),
    updatedAt: iso(at),
    depositTxHash: unpaid ? null : paid,
    depositVerified: !unpaid,
    depositForwarded: !unpaid,
    details: unpaid ? null : { originTxs: [{ hash: paid, url: null }], destinationTxs: status === "delivered" ? [{ hash: txHash(`delivery ${record.id}`), url: null }] : [], depositedAmount: record.amountIn, amountIn: record.amountIn, amountOut: status === "delivered" ? record.amountOut : null, refundedAmount: status === "refunded" ? record.amountIn : null, refundReason: null },
    finishedAt: iso(at),
  };
}

// ---- the whole server, started on a folder ----
/** A pretend outside world: the provider's coin list works, everything else is unreachable. */
const network: typeof fetch = async (input) => {
  if (String(input).includes("/v0/tokens")) return new Response(JSON.stringify(FIXTURE_TOKENS));
  throw new Error("unreachable in tests");
};
function started(dir: string, env: Record<string, string>, now: () => number, lines: string[] = []): Booted {
  const booted = boot({ env: { DATA_DIR: dir, ...env }, log: createLogger((line) => lines.push(line)), fetchImpl: network, siteDir: path.join(dir, "no-site"), now });
  running.push(booted);
  return booted;
}
/** The live server, started on a folder: every order on disk is gone through once, as at any start. */
const restarted = (dir: string, now: () => number = () => NOON, lines: string[] = []) => started(dir, { NODE_ENV: "production", TRUST_PROXY_HOPS: "1" }, now, lines);

describe("an order made in Ghost mode is marked, and is made exactly as any other", () => {
  it("only the value true marks an order: its record carries the mark and its view says so; anything else is as if nothing were sent, and is never an error", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    const marked = asOrder(await h.order({ ghost: true }));
    expect(marked.ghost).toBe(true);
    expect(h.store.get(marked.id)!.ghost).toBe(true);
    expect((JSON.parse(fs.readFileSync(orderFile(h.dataDir, marked.id), "utf8")) as OrderRecord).ghost).toBe(true);
    expect((await h.get(`/api/orders/${marked.id}`)).body).toMatchObject({ id: marked.id, status: "waiting", ghost: true });

    const others: unknown[] = [false, null, "true", "yes", "on", 1, 0, {}, [], [true]];
    for (const [i, other] of [undefined, ...others].entries()) {
      const reply = await h.order(other === undefined ? {} : { ghost: other }, { ip: `198.51.100.${i + 1}` });
      expect(reply.status, JSON.stringify(other)).toBe(201);
      const order = asOrder(reply);
      expect("ghost" in order, JSON.stringify(other)).toBe(false);
      expect("ghost" in h.store.get(order.id)!, JSON.stringify(other)).toBe(false);
      expect("ghost" in (await h.get(`/api/orders/${order.id}`)).body, JSON.stringify(other)).toBe(false);
    }
  });

  it("the mark changes nothing about making the order: the provider is asked the same, the same addresses are screened, and the same record is stored", async () => {
    const screened: string[][] = [];
    const list = createStaticSanctions([], { now: () => NOON });
    const sanctions: Sanctions = { available: list.available, version: list.version, screen: (addresses) => (screened.push(addresses.map(String)), list.screen(addresses)) };
    const h = await start({ sanctions });
    const body = { ...SWAP, rewardsAddress: WHO.rewards };
    const plain = asOrder(await h.order(body));
    const marked = asOrder(await h.order({ ...body, ghost: true }));

    // What the provider was sent, preview and order: the same to the letter, in the same class of its budget, with no word of the mode.
    const previews = h.tap.quotes.filter((quote) => quote.dry === true);
    const orders = h.tap.quotes.filter((quote) => quote.dry === false);
    expect([previews.length, orders.length]).toEqual([2, 2]);
    expect(JSON.stringify(previews[1])).toBe(JSON.stringify(previews[0]));
    expect(JSON.stringify(orders[1])).toBe(JSON.stringify(orders[0]));
    expect(JSON.stringify(h.tap.quotes)).not.toMatch(/ghost/i);
    expect(h.tap.quoteClasses).toEqual(["user", "order", "user", "order"]);
    // What was screened: every address of the order, both times.
    expect(screened).toEqual([[WHO.sender, WHO.recipient, WHO.refundTo, WHO.rewards], [WHO.sender, WHO.recipient, WHO.refundTo, WHO.rewards]]);
    // What was stored: the same record, but for what the provider made up for each order, and the mark.
    const sameIn = (record: OrderRecord) => {
      const { id: _id, depositAddress: _deposit, quoteResponse: _quote, ghost: _ghost, ...rest } = record;
      return rest;
    };
    const [a, b] = [h.store.get(plain.id)!, h.store.get(marked.id)!];
    expect(sameIn(b)).toEqual(sameIn(a));
    expect([a.ghost, b.ghost]).toEqual([undefined, true]);
    // The provider's signed answer is kept with both, and each was checked against its own key before anything was stored.
    for (const record of [a, b]) expect(record.quoteResponse).toMatchObject({ signature: expect.stringMatching(/^ed25519:/), quote: { depositAddress: record.depositAddress } });
    // And what the person is shown: the same order, with the mark said on one.
    const shown = (view: OrderView) => {
      const { id: _id, depositAddress: _deposit, ghost: _ghost, ...rest } = view;
      return rest;
    };
    expect(shown(marked)).toEqual(shown(plain));
  });

  it("every check refuses a marked order as it refuses any other: the terms, where the request comes from, the session, the pause, the provider's signature and echo, the price, the screening, the disk and each limit", async () => {
    /** A clean preview's numbers, so that an order can be asked for without another preview on the way. */
    const reviewedBy = async (h: Harness) => {
      const preview = (await h.quote({ from: ASSET.baseEth, to: ASSET.arbUsdc, amount: "5000000000000000", pay: "wallet", ...SWAP })).body as QuoteView;
      return { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: preview.fees.appBps + preview.fees.providerBps, routing: preview.routing };
    };
    const refusals: Array<{ name: string; code: string; options?: HarnessOptions; ask(h: Harness, mark: Record<string, unknown>): Promise<Reply> }> = [
      { name: "terms not accepted", code: "terms", ask: (h, mark) => h.order({ ...SWAP, ...mark, termsVersion: "an-older-version" }) },
      { name: "asked from another site", code: "origin", ask: (h, mark) => h.order({ ...SWAP, ...mark, reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 0 } }, { origin: "https://elsewhere.example" }) },
      { name: "no session", code: "session", ask: (h, mark) => h.order({ ...SWAP, ...mark, reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 0 } }, { session: null }) },
      { name: "swaps paused", code: "paused", options: { env: { SWAPS_PAUSED: "true" } }, ask: (h, mark) => h.order({ ...SWAP, ...mark, reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 0 } }) },
      {
        name: "a quote whose signature does not hold",
        code: "try_later",
        async ask(h, mark) {
          const reviewed = await reviewedBy(h);
          h.tap.corruptResponse = (data) => ({ ...data, quote: { ...(data.quote as Record<string, unknown>), amountOut: "99999999999" } });
          return h.order({ ...SWAP, ...mark, reviewed });
        },
      },
      {
        name: "a quote that answers another request",
        code: "try_later",
        async ask(h, mark) {
          const reviewed = await reviewedBy(h);
          h.tap.tamperRequest = (sent) => ({ ...sent, recipient: ADDR.evm3 });
          return h.order({ ...SWAP, ...mark, reviewed });
        },
      },
      {
        name: "a price worse than the one reviewed",
        code: "price_moved",
        async ask(h, mark) {
          const reviewed = await reviewedBy(h);
          return h.order({ ...SWAP, ...mark, reviewed: { ...reviewed, amountOut: (BigInt(reviewed.amountOut) * 2n).toString() } });
        },
      },
      { name: "a listed address", code: "blocked", options: { sanctions: createStaticSanctions([WHO.recipient], { now: () => NOON }) }, ask: (h, mark) => h.order({ ...SWAP, ...mark }) },
      { name: "a listed rewards address", code: "blocked", options: { sanctions: createStaticSanctions([WHO.rewards], { now: () => NOON }) }, ask: (h, mark) => h.order({ ...SWAP, ...mark, rewardsAddress: WHO.rewards }) },
      { name: "no screening list", code: "try_later", options: { sanctions: createStaticSanctions([], { available: false }) }, ask: (h, mark) => h.order({ ...SWAP, ...mark }) },
      { name: "a full disk", code: "busy", options: { diskFull: () => true }, ask: (h, mark) => h.order({ ...SWAP, ...mark }) },
      { name: "a rewards address that is none", code: "invalid_rewards", ask: (h, mark) => h.order({ ...SWAP, ...mark, rewardsAddress: "not an address", reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 0 } }) },
      {
        name: "more orders in a minute than one visitor may make",
        code: "rate_limited",
        options: { limits: { orderPerRecipient: ROOMY } },
        async ask(h, mark) {
          for (let i = 0; i < LIMITS.orderCreate.max; i++) expect((await h.order({ ...SWAP, ...mark })).status).toBe(201);
          return h.order({ ...SWAP, ...mark });
        },
      },
      {
        name: "more orders to one receiving address than its hour allows",
        code: "rate_limited",
        options: { limits: { orderCreate: ROOMY, orderPerRecipient: { max: 2, windowMs: 3_600_000 } } },
        async ask(h, mark) {
          for (let i = 0; i < 2; i++) expect((await h.order({ ...SWAP, ...mark })).status).toBe(201);
          return h.order({ ...SWAP, ...mark });
        },
      },
      {
        name: "more unpaid orders than one visitor may have open",
        code: "rate_limited",
        options: { limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } },
        async ask(h, mark) {
          for (let i = 0; i < MAX_UNPAID_PER_CLIENT; i++) expect((await h.order({ ...SWAP, ...mark })).status).toBe(201);
          return h.order({ ...SWAP, ...mark });
        },
      },
      {
        name: "more open orders than the server holds",
        code: "busy",
        options: { maxOpenOrders: 1 },
        async ask(h, mark) {
          expect((await h.order({ ...SWAP, ...mark })).status).toBe(201);
          return h.order({ ...SWAP, ...mark }, { ip: "198.51.100.9" });
        },
      },
    ];
    for (const refusal of refusals) {
      const [plain, marked] = [await start(refusal.options), await start(refusal.options)];
      const without = await refusal.ask(plain, {});
      const withMark = await refusal.ask(marked, { ghost: true });
      expect(outcome(without), refusal.name).toBe(refusal.code);
      // The same answer, in every part, with the mark as without it.
      expect([withMark.status, withMark.body], refusal.name).toEqual([without.status, without.body]);
      expect(withMark.headers.get("retry-after"), refusal.name).toBe(without.headers.get("retry-after"));
      // And the same alert to the operator, where there is one.
      expect(marked.alerts, refusal.name).toEqual(plain.alerts);
      // Nothing was stored for a refused order, and the same number of orders either way.
      expect(marked.store.ids().length, refusal.name).toBe(plain.store.ids().length);
      // Every limit was charged the same: as many visitors counted by each, and as much left of what all visitors share.
      const charged = (h: Harness) => (Object.keys(LIMITS) as Array<keyof typeof LIMITS>).map((name) => [name, h.limiters[name].size, h.limiters[name].remaining("all")]);
      expect(charged(marked), refusal.name).toEqual(charged(plain));
      // And the provider was asked as often, in the same classes of its budget.
      expect(marked.tap.quoteClasses, refusal.name).toEqual(plain.tap.quoteClasses);
    }
  });

  it("a repeated request returns the same order, and the mode is part of what a request asks for: the same key the other way is refused", async () => {
    const h = await start();
    const preview = (await h.quote({ from: ASSET.baseEth, to: ASSET.arbUsdc, amount: "5000000000000000", pay: "wallet", ...SWAP })).body as QuoteView;
    const reviewed = { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: preview.fees.appBps + preview.fees.providerBps, routing: preview.routing };
    const body = { ...SWAP, ghost: true, reviewed, requestId: "ghost-retry-key-0123456789" };
    const first = await h.order(body);
    expect(first.status).toBe(201);
    const again = await h.order(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, ghost: true });
    // One order was asked of the provider, and one is stored.
    expect(h.tap.quotes.filter((quote) => quote.dry === false)).toHaveLength(1);
    expect(h.store.ids()).toEqual([first.body.id]);
    // The same key without the mark is another request, and is not answered with the marked order.
    const { ghost: _mark, ...unmarked } = body;
    const other = await h.order(unmarked);
    expect([other.status, outcome(other)]).toEqual([409, "conflict"]);
    // And the other way round: a key that made an order with no mark never returns it as a Ghost order.
    const plain = { ...SWAP, reviewed, requestId: "plain-retry-key-9876543210" };
    expect((await h.order(plain)).status).toBe(201);
    expect(outcome(await h.order({ ...plain, ghost: true }))).toBe("conflict");
    expect(h.store.ids()).toHaveLength(2);
  });
});

describe("the Stats page counts a Ghost order and never lists it", () => {
  /** One swap from the order being made to its delivery, paid from a wallet so that its deposit's transaction is known to this server. */
  async function swapped(mark: Record<string, unknown>) {
    const h = await start();
    const made = asOrder(await h.order({ ...SWAP, ...mark }));
    const deposit = txHash("stats deposit");
    expect((await payByWallet(h, made, deposit)).status).toBe(200);
    await step(h, made.id, 5000);
    await step(h, made.id, 5000);
    await step(h, made.id, 15_000);
    const reply = await h.get("/api/stats");
    return { h, made, deposit, stats: reply.body as StatsResponse, answer: reply.text };
  }

  it("it adds to every total exactly as any delivered order does, once, and it has no row: its deposit's transaction is in no answer and not in the file", async () => {
    const plain = await swapped({});
    const ghost = await swapped({ ghost: true });
    expect(statusOf(plain.h, plain.made.id)).toBe("delivered");
    // The ordinary order is listed, by its deposit. This is what the other is spared.
    expect(plain.stats.feed).toEqual([{ coin: { symbol: "ETH", chain: "base", decimals: 18 }, amount: plain.made.amountIn, at: "2026-10-08T12:00:00Z", tx: plain.deposit }]);
    expect(carries(statsText(plain.h.dataDir), plain.deposit)).toBe(true);

    expect(ghost.stats.feed).toEqual([]);
    // Every figure of the page is the same as for the ordinary order.
    expect({ ...ghost.stats, feed: [] }).toEqual({ ...plain.stats, feed: [] });
    expect(ghost.stats.totals).toEqual({ swaps: 1, volumeUsd: 12, volume24hUsd: 12, chains: 1, deliverySeconds: 15 });
    expect(ghost.stats.chainsUsed).toEqual([{ chain: "base", swaps: 1, share: 100 }]);
    expect(ghost.stats.chains).toEqual([{ chain: "base", name: "Base", volumeUsd: 12 }]);
    expect(ghost.stats.coins).toEqual([{ coin: { symbol: "ETH", chain: "base" }, volumeUsd: 12 }]);
    expect(ghost.stats.received).toEqual([{ coin: { symbol: "USDC", chain: "arb" }, volumeUsd: 12 }]);
    // And every sum of the file: the swaps, the volume, the hour, the chain sent from, the coin sent, the coin received and the time taken.
    const [kept, ordinary] = [statsFile(ghost.h.dataDir), statsFile(plain.h.dataDir)];
    expect(kept.rows).toEqual([]);
    expect({ ...kept, rows: [] }).toEqual({ ...ordinary, rows: [] });
    expect(kept).toMatchObject({ swaps: 1, volumeMicro: "12500000", deliverySeconds: 15, deliveriesTimed: 1, chains: { base: { swaps: 1, volumeMicro: "12500000" } }, coins: [{ symbol: "ETH", chain: "base", volumeMicro: "12500000" }], received: [{ symbol: "USDC", chain: "arb", volumeMicro: "12500000" }] });
    expect(Object.values(kept.hours)).toEqual([{ swaps: 1, volumeMicro: "12500000" }]);
    // Nothing of the order is in the answer or in the file: not its deposit's transaction, and not its amount.
    for (const text of [ghost.answer, statsText(ghost.h.dataDir)]) {
      for (const value of [ghost.deposit, ghost.made.amountIn, ghost.made.id, ghost.made.depositAddress!, WHO.sender, WHO.recipient, WHO.refundTo]) expect(carries(text, value), value).toBe(false);
    }
  });

  it("the totals do not hang on its record: with the record gone, the swap is still in them, once, at every later start, and still has no row", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    const ghost = await ghostly(h);
    const plain = await plainly(h, {}, "198.51.100.2");
    await deliver(h, ghost);
    await deliver(h, plain);
    expect(h.store.ids()).toEqual([plain.id]);
    const before = (await h.get("/api/stats")).body as StatsResponse;
    expect(before.totals).toMatchObject({ swaps: 2, volumeUsd: 25 });
    expect(before.feed.map((row) => row.amount)).toEqual([plain.amountIn]);
    const file = statsFile(h.dataDir);
    expect(file).toMatchObject({ swaps: 2, volumeMicro: "25000000", chains: { base: { swaps: 2 } } });
    // Started again, twice, on the same folder, where one record is all there is to go through: the same sums and the same one row.
    for (let i = 0; i < 2; i++) {
      restarted(h.dataDir, () => h.clock.t);
      expect(statsFile(h.dataDir)).toEqual({ ...file, v: 3 });
    }
    expect(statsFile(h.dataDir).rows.map((row) => row.amount)).toEqual([plain.amountIn]);
  });

  it("the putting-back of rows at a start passes over a Ghost order: an ordinary delivered order gets its row back, and the Ghost order beside it gets none", () => {
    const dir = tempDir();
    const store = createOrderStore(dir);
    const ordinary = stored(1);
    const ghost = stored(2, { ghost: true });
    for (const record of [ordinary, ghost]) {
      store.create(record);
      store.saveState(record.id, ended(record));
      expect(store.markCounted(record.id)).toBe(true);
    }
    // The totals as an earlier version left them: both swaps counted, and no rows.
    fs.mkdirSync(path.join(dir, "stats"), { recursive: true });
    fs.writeFileSync(path.join(dir, "stats", "stats.json"), JSON.stringify({ v: 2, swaps: 2, volumeMicro: "501000000", deliverySeconds: 80, deliveriesTimed: 2, chains: { base: { swaps: 2, volumeMicro: "501000000" } }, coins: [{ symbol: "ETH", chain: "base", volumeMicro: "501000000" }], hours: {}, rows: [] }));

    restarted(dir);
    const after = statsFile(dir);
    expect(after).toMatchObject({ v: 3, swaps: 2, volumeMicro: "501000000", chains: { base: { swaps: 2, volumeMicro: "501000000" } } });
    expect(after.rows).toEqual([{ coin: { symbol: "ETH", chain: "base", decimals: 18 }, amount: ordinary.amountIn, at: "2026-10-08T11:59:00Z", tx: txHash(`paid ${ordinary.id}`) }]);
    for (const value of [ghost.amountIn, txHash(`paid ${ghost.id}`)]) expect(carries(statsText(dir), value), value).toBe(false);
    // The ordinary order's record is still there; the Ghost order's went, as it would have at its delivery.
    expect(fs.existsSync(orderFile(dir, ordinary.id))).toBe(true);
    expect(fs.existsSync(orderFile(dir, ghost.id))).toBe(false);
  });
});

describe("a Ghost order's record is deleted at the first moment nothing more can happen to it and no funds are in it", () => {
  /** Everything the server holds of an order outside its logs: on disk and in memory. */
  const held = (h: Harness, order: OrderView) => ({
    record: fs.existsSync(orderFile(h.dataDir, order.id)),
    index: fs.existsSync(indexFile(h.dataDir, order.depositAddress!)),
    stored: h.store.get(order.id) !== null,
    listed: h.store.ids().includes(order.id),
    open: h.store.open().some((record) => record.id === order.id),
    byDeposit: h.store.findByDeposit(order.depositAddress!) !== null,
    poller: h.poller.holds(order.id),
  });
  const NOTHING = { record: false, index: false, stored: false, listed: false, open: false, byDeposit: false, poller: false };

  it("delivered: the record, its entry in the index of deposit addresses and everything held in memory for it are gone at once", async () => {
    const h = await start();
    const order = await ghostly(h);
    // Its page is open, and the wallet names its deposit: the poller and the limits now hold something for it.
    await h.get(`/api/orders/${order.id}`);
    expect((await payByWallet(h, order, txHash("wiped deposit"))).status).toBe(200);
    expect(held(h, order)).toEqual({ record: true, index: true, stored: true, listed: true, open: true, byDeposit: true, poller: true });
    expect(h.limiters.depositPerOrder.size).toBe(1);
    await step(h, order.id, 5000);
    await step(h, order.id, 5000);
    expect(statusOf(h, order.id)).toBe("swapping");
    expect(held(h, order).record).toBe(true);

    await step(h, order.id, 15_000);
    expect(held(h, order)).toEqual(NOTHING);
    expect(h.limiters.depositPerOrder.size).toBe(0);
    expect(fs.readdirSync(path.join(h.dataDir, "orders"))).toEqual([]);
    expect(fs.readdirSync(path.join(h.dataDir, "by-deposit"))).toEqual([]);
    // It is never polled again, and a pass of the poller puts nothing back.
    const asked = h.stub.calls.status;
    await step(h, order.id, 10 * MINUTE);
    expect(h.stub.calls.status).toBe(asked);
    expect(held(h, order)).toEqual(NOTHING);
  });

  it("refunded: wiped at once too, whether it was refunded whole or after a deposit that was too small", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    const whole = await ghostly(h);
    await refund(h, whole);
    expect(held(h, whole)).toEqual(NOTHING);
    expect((await h.get(`/api/orders/${whole.id}`)).body).toEqual(gone("refunded"));

    const short = await ghostly(h, {}, "198.51.100.2");
    h.stub.control(short.depositAddress!, "underpay");
    await step(h, short.id, 5000);
    // Too small a deposit is funds in the order: nothing is deleted while they are there.
    expect(statusOf(h, short.id)).toBe("deposit_too_small");
    expect(held(h, short).record).toBe(true);
    await step(h, short.id, 20_000);
    expect(held(h, short)).toEqual(NOTHING);
    expect((await h.get(`/api/orders/${short.id}`)).body).toEqual(gone("refunded"));
  });

  it("run out unpaid: not deleted at its deadline. Its record is kept and watched exactly as long as an ordinary order's, a day past the deadline, and goes in the same pass, once the provider has been asked one last time", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY, orderFind: ROOMY, orderFindDaily: ROOMY, orderFindDailyWide: ROOMY, orderFindGlobal: ROOMY } });
    const ghost = await ghostly(h);
    const ordinary = await plainly(h, {}, "198.51.100.2");
    // The provider no longer knows the address of a third, which runs out the same.
    const forgotten = await ghostly(h, {}, "198.51.100.3");
    const says = new Map<string, UpstreamResult>([[forgotten.depositAddress!, { ok: false, kind: "rejected", status: 404, message: "Deposit address not found" }]]);
    h.tap.statusReply = (deposit) => says.get(deposit) ?? null;
    for (const order of [ghost, ordinary, forgotten]) await runOut(h, order);
    const all = [ghost, ordinary, forgotten];
    const there = () => all.map((order) => fs.existsSync(orderFile(h.dataDir, order.id)));
    const kept = async (when: string) => {
      const visitor = await muchLater(h, "198.51.100.40");
      expect(all.map((order) => statusOf(h, order.id)), when).toEqual(["expired", "expired", "expired"]);
      expect(there(), when).toEqual([true, true, true]);
      expect(fs.readdirSync(goneDir(h.dataDir)), when).toEqual([]);
      // Its page shows it as any order that ran out, with the mark; and opening the page has the provider asked again, as for any such order.
      const asked = h.stub.calls.status;
      expect((await h.get(`/api/orders/${ghost.id}`)).body, when).toMatchObject({ id: ghost.id, status: "expired", ghost: true });
      await eventually(() => h.stub.calls.status === asked + 1);
      // Its deposit address still finds nothing, as at every other moment of its life. An ordinary order's finds it.
      expect((await h.post("/api/track", { depositAddress: ghost.depositAddress }, visitor)).text, when).toBe(NEVER);
      expect((await h.post("/api/track", { depositAddress: ordinary.depositAddress }, visitor)).body, when).toEqual({ id: ordinary.id });
    };
    await kept("ten minutes past the deadline");
    expect(wipeDue(h.store.get(ghost.id)!)).toBe(false);
    expect(h.store.wipe(ghost.id)).toBe(false);

    // Pass after pass of the clean-up changes nothing until a day past the deadline: not for the ordinary order, and not for the others.
    const deadline = Date.parse(ghost.deadline);
    expect(all.map((order) => Date.parse(order.deadline))).toEqual([deadline, deadline, deadline]);
    for (const hours of [1, 12, 23]) {
      h.clock.t = deadline + hours * 3_600_000;
      expect(await h.sweep(), `${hours} hours on`).toBe(0);
      expect(there(), `${hours} hours on`).toEqual([true, true, true]);
    }
    h.clock.t = deadline + UNFUNDED_RETENTION_MS - 1000;
    await h.sweep();
    await kept("a second before the watch ends");
    expect(all.map((order) => isExpiredRecord(h.store.get(order.id)!, h.clock.t))).toEqual([false, false, false]);

    // The watch ends for all three at the same moment. The provider is asked one last time about each, and has nothing new.
    h.clock.t = deadline + UNFUNDED_RETENTION_MS + 1000;
    const asked = h.tap.statusClasses.length;
    expect(await h.sweep()).toBe(3);
    expect(h.tap.statusClasses.length).toBe(asked + 3);
    expect(there()).toEqual([false, false, false]);
    for (const order of all) expect(held(h, order), order.id).toEqual(NOTHING);
    // What is left: of each Ghost order, that it finished, and the word for an order that ran out; of the ordinary one nothing, as ever.
    expect(fs.readdirSync(goneDir(h.dataDir)).sort()).toEqual([sha(ghost.id), sha(forgotten.id)].sort());
    for (const order of [ghost, forgotten]) {
      const reply = await h.get(`/api/orders/${order.id}`);
      expect([reply.status, reply.body]).toEqual([410, gone("expired")]);
      expect(fs.readFileSync(goneFile(h.dataDir, order.id), "utf8")).toBe("expired");
    }
    const plain = await h.get(`/api/orders/${ordinary.id}`);
    expect([plain.status, plain.text]).toEqual([404, NEVER]);
    expect((await h.post("/api/track", { depositAddress: ghost.depositAddress }, await muchLater(h, "198.51.100.41"))).text).toBe(NEVER);
  });

  it("a deposit that arrives late is found as for any order, on a look at the order's page or at the last check, and the order then follows the ordinary path: it is wiped when it is delivered or refunded", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    const seenOnPage = await ghostly(h);
    const seenAtLast = await ghostly(h, {}, "198.51.100.2");
    const says = new Map<string, string>();
    h.tap.statusReply = (deposit) => answer(says.get(deposit) ?? "PENDING_DEPOSIT")(deposit);
    for (const order of [seenOnPage, seenAtLast]) await runOut(h, order);
    expect([seenOnPage, seenAtLast].map((order) => statusOf(h, order.id))).toEqual(["expired", "expired"]);

    // An hour past the deadline the deposit of the first arrives after all. The person opens the order's page, and the server asks.
    h.clock.t += 3_600_000;
    says.set(seenOnPage.depositAddress!, "PROCESSING");
    expect((await h.get(`/api/orders/${seenOnPage.id}`)).body).toMatchObject({ status: "expired", ghost: true });
    await eventually(() => statusOf(h, seenOnPage.id) === "swapping");
    // It is an order with funds in it now: tracked again, kept while they are in it, and shown as it is.
    expect((await h.get(`/api/orders/${seenOnPage.id}`)).body).toMatchObject({ status: "swapping", ghost: true, depositProven: true });
    expect(fs.existsSync(orderFile(h.dataDir, seenOnPage.id))).toBe(true);
    expect(fs.readdirSync(goneDir(h.dataDir))).toEqual([]);
    says.set(seenOnPage.depositAddress!, "SUCCESS");
    await step(h, seenOnPage.id, 60_000);
    expect(statusOf(h, seenOnPage.id)).toBeNull();
    expect((await h.get(`/api/orders/${seenOnPage.id}`)).body).toEqual(gone("delivered"));
    expect(h.stats.view().totals.swaps).toBe(1);

    // Nobody looks at the second. At the last check, a day past the deadline, the provider says it is being swapped: it is kept and followed.
    says.set(seenAtLast.depositAddress!, "PROCESSING");
    await watchEnds(h, seenAtLast);
    expect(statusOf(h, seenAtLast.id)).toBe("swapping");
    expect(fs.readdirSync(path.join(h.dataDir, "orders"))).toEqual([`${seenAtLast.id}.json`]);
    expect(h.poller.holds(seenAtLast.id)).toBe(true);
    says.set(seenAtLast.depositAddress!, "REFUNDED");
    await step(h, seenAtLast.id, 60_000);
    expect((await h.get(`/api/orders/${seenAtLast.id}`)).body).toEqual(gone("refunded"));
    expect(fs.readdirSync(path.join(h.dataDir, "orders"))).toEqual([]);
    expect(fs.readdirSync(goneDir(h.dataDir)).sort()).toEqual([sha(seenOnPage.id), sha(seenAtLast.id)].sort());
  });

  it("while the provider cannot be asked at the last check, nothing is deleted; once it answers, with nothing new, the order goes as one that ran out", async () => {
    const h = await start();
    const order = await ghostly(h);
    await runOut(h, order);
    h.tap.statusReply = () => ({ ok: false, kind: "unavailable", status: 503 });
    for (let pass = 0; pass < 3; pass++) {
      await watchEnds(h, order);
      h.clock.t += 10 * MINUTE;
      expect(statusOf(h, order.id)).toBe("expired");
      expect(fs.readdirSync(goneDir(h.dataDir))).toEqual([]);
    }
    h.tap.statusReply = null;
    expect(await h.sweep()).toBe(1);
    expect((await h.get(`/api/orders/${order.id}`)).body).toEqual(gone("expired"));
  });

  it("is never wiped while it waits, while a deposit is only announced, while it swaps, when it failed or when too little was paid: its record is kept exactly as any order's is", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    const kept = { record: true, index: true, stored: true, listed: true };
    const reads = async (order: OrderView, status: string) => {
      expect(statusOf(h, order.id), status).toBe(status);
      expect(held(h, order), status).toMatchObject(kept);
      expect(fs.existsSync(goneFile(h.dataDir, order.id)), status).toBe(false);
      expect((await h.get(`/api/orders/${order.id}`)).body, status).toMatchObject({ id: order.id, ghost: true });
    };
    const order = await ghostly(h);
    await step(h, order.id, 5000);
    await reads(order, "waiting");
    h.stub.control(order.depositAddress!, "deposit");
    await step(h, order.id, 5000);
    await reads(order, "deposit_seen");
    await step(h, order.id, 5000);
    await reads(order, "swapping");

    const failed = await ghostly(h, {}, "198.51.100.2");
    h.stub.control(failed.depositAddress!, "fail");
    await step(h, failed.id, 5000);
    await reads(failed, "failed");
    const short = await ghostly(h, {}, "198.51.100.3");
    h.stub.control(short.depositAddress!, "underpay");
    await step(h, short.id, 5000);
    await reads(short, "deposit_too_small");

    // Days on, and after passes of the poller and of the clean-up, the two are still there. A failed
    // order may have funds with the provider: it waits the 30 days any finished order's record is kept.
    h.clock.t += 29 * DAY;
    h.tap.statusReply = answer("INCOMPLETE_DEPOSIT");
    await h.poller.tick();
    await h.sweep();
    await reads(failed, "failed");
    await reads(short, "deposit_too_small");
    expect(isExpiredRecord(h.store.get(failed.id)!, h.clock.t)).toBe(false);
    // Then the failed one goes as any old record does, leaving nothing at all: no fingerprint, and its ID is one that never was.
    h.clock.t += 2 * DAY;
    await h.sweep();
    expect(held(h, failed)).toMatchObject({ record: false, index: false, stored: false });
    expect(fs.existsSync(goneFile(h.dataDir, failed.id))).toBe(false);
    const after = await h.get(`/api/orders/${failed.id}`);
    expect([after.status, after.text]).toEqual([404, NEVER]);
    // The under-paid one has funds in it and has not finished: it is never deleted on its own.
    await reads(short, "deposit_too_small");
  });

  it("is never wiped while funds may be in it and it has not finished: a confirmed deposit the provider has not picked up, an order set aside with funds in it, and one that ran out with a deposit reported", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    const unseen = await ghostly(h);
    const stuck = await ghostly(h, {}, "198.51.100.2");
    const named = asOrder(await h.order({ ghost: true, from: ASSET.btc, to: ASSET.arbUsdc, amount: "1000000", pay: "manual", sender: undefined, refundTo: ADDR.btc, recipient: WHO.recipient }, { ip: "198.51.100.3" }));
    /** What the provider says of each, by its deposit address. */
    const says = new Map<string, string>();
    h.tap.statusReply = (deposit) => answer(says.get(deposit) ?? "PENDING_DEPOSIT")(deposit);
    // A deposit this server confirmed on the chain, which the provider still does not report well after the deadline.
    expect((await payByWallet(h, unseen, txHash("unseen deposit"))).status).toBe(200);
    // An order the provider is still swapping a week past its deadline: tracking stops, and the record is kept for someone to look into.
    says.set(stuck.depositAddress!, "PROCESSING");
    await step(h, stuck.id, 5000);
    expect(statusOf(h, stuck.id)).toBe("swapping");
    // An order on a chain this server cannot read, with a transaction named for it that nobody could confirm: it runs out, and may be a late or lost deposit.
    h.store.saveState(named.id, { ...h.store.get(named.id)!.state, depositTxHash: made("named deposit", 32), depositVerified: false, depositForwarded: true });

    await runOut(h, unseen);
    expect(h.store.get(unseen.id)!.state).toMatchObject({ status: "waiting", depositVerified: true, unseenAlertSent: true });
    await runOut(h, named);
    expect(statusOf(h, named.id)).toBe("expired");
    h.clock.t = Date.parse(stuck.deadline) + GIVE_UP_AFTER_DEADLINE_MS;
    await step(h, stuck.id, 1000);
    expect(h.store.get(stuck.id)!.state).toMatchObject({ status: "swapping", stopped: true, unfinishedAlertSent: true });

    for (const order of [unseen, stuck, named]) {
      expect(held(h, order), order.id).toMatchObject({ record: true, index: true, stored: true });
      expect(fs.existsSync(goneFile(h.dataDir, order.id))).toBe(false);
      expect(wipeDue(h.store.get(order.id)!)).toBe(false);
      // Asked to delete it outright, the store refuses.
      expect(h.store.wipe(order.id)).toBe(false);
      expect(fs.existsSync(orderFile(h.dataDir, order.id))).toBe(true);
    }
    // Years on, the two with funds in them are still there, whatever the clean-up does.
    h.clock.t += 1000 * DAY;
    h.tap.statusReply = () => ({ ok: false, kind: "unavailable", status: 503 });
    await h.sweep();
    for (const order of [unseen, stuck]) expect(fs.existsSync(orderFile(h.dataDir, order.id)), order.id).toBe(true);
  });

  it("the rule itself: at once, only a Ghost order's record, and only when the order is delivered or refunded; the word kept of an order is one of three", () => {
    const state = (status: OrderStatus, more: Partial<OrderState> = {}): OrderState => ({ ...stored(1).state, status, ...more });
    const atOnce: OrderState[] = [state("delivered"), state("refunded")];
    const not: OrderState[] = [
      state("waiting"),
      state("deposit_seen"),
      state("swapping"),
      state("deposit_too_small"),
      state("failed"),
      // Run out, with no deposit ever reported or with one: a deposit can still arrive late, and the record is watched as any is.
      state("expired"),
      state("expired", { depositTxHash: txHash("late") }),
      state("expired", { depositTxHash: txHash("late"), depositVerified: true }),
      state("waiting", { stopped: true, finishedAt: iso(NOON) }),
      state("swapping", { stopped: true, finishedAt: iso(NOON) }),
      state("waiting", { depositTxHash: txHash("confirmed"), depositVerified: true }),
    ];
    for (const s of atOnce) {
      expect(endedEmpty(s), s.status).toBe(true);
      expect(wipeDue(stored(1, { ghost: true, state: s })), s.status).toBe(true);
      // An order without the mark is never deleted this way, however it ended.
      expect(wipeDue(stored(1, { state: s })), s.status).toBe(false);
      expect(wipeDue(stored(1, { ghost: "true" as unknown as true, state: s })), s.status).toBe(false);
    }
    for (const s of not) {
      expect(endedEmpty(s), JSON.stringify(s)).toBe(false);
      expect(wipeDue(stored(1, { ghost: true, state: s })), JSON.stringify(s)).toBe(false);
    }
    expect((["waiting", "deposit_seen", "swapping", "deposit_too_small", "delivered", "refunded", "failed", "expired"] as const).map((status) => endingOf(state(status)))).toEqual([null, null, null, null, "delivered", "refunded", null, "expired"]);
  });

  it("the store deletes at once on that rule alone, whoever asks; and whenever the record of a Ghost order that had ended is removed, by anyone, the one word is left, and for no other record", () => {
    const dir = tempDir();
    const store = createOrderStore(dir, { now: () => NOON });
    /** An order, how it stands, whether it may be deleted at once, and the word left when its record is removed. */
    const cases: Array<[OrderRecord, OrderStatus, boolean, string | null]> = [
      [stored(1), "delivered", false, null],
      [stored(2), "refunded", false, null],
      [stored(3), "expired", false, null],
      [stored(4, { ghost: true }), "failed", false, null],
      [stored(5, { ghost: true }), "swapping", false, null],
      [stored(6, { ghost: true }), "expired", false, "expired"],
      [stored(7, { ghost: true }), "delivered", true, "delivered"],
      [stored(8, { ghost: true }), "refunded", true, "refunded"],
    ];
    const told: string[] = [];
    store.onRemoved((id) => void told.push(id));
    for (const [record, status, atOnce] of cases) {
      store.create(record);
      store.saveState(record.id, status === "swapping" ? { ...record.state, status } : ended(record, status));
      expect(store.wipe(record.id), `${record.id} ${status}`).toBe(atOnce);
      expect(fs.existsSync(orderFile(dir, record.id)), record.id).toBe(!atOnce);
      expect(fs.existsSync(indexFile(dir, record.depositAddress)), record.id).toBe(!atOnce);
      expect(fs.existsSync(goneFile(dir, record.id)), record.id).toBe(atOnce);
    }
    expect(store.wipe(idOf(99))).toBe(false);
    expect(store.wipe("not an id")).toBe(false);
    // Whatever holds something of an order in memory is told as its record goes, and only then.
    expect(told).toEqual([idOf(7), idOf(8)]);
    // Then every record that is left is removed, as the clean-up removes a record whose time is up.
    for (const [record, , atOnce] of cases) if (!atOnce) store.remove(record.id);
    expect(told).toEqual([idOf(7), idOf(8), idOf(1), idOf(2), idOf(3), idOf(4), idOf(5), idOf(6)]);
    expect(fs.readdirSync(path.join(dir, "orders"))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "by-deposit"))).toEqual([]);
    for (const [record, status, , word] of cases) {
      expect(fs.existsSync(goneFile(dir, record.id)), `${record.id} ${status}`).toBe(word !== null);
      expect(store.wiped(record.id), `${record.id} ${status}`).toEqual(word === null ? null : { ended: word });
      // The file holds the word and nothing else: not a space, not a line break.
      if (word !== null) expect(fs.readFileSync(goneFile(dir, record.id), "utf8"), record.id).toBe(word);
    }
    expect(fs.readdirSync(goneDir(dir)).sort()).toEqual([sha(idOf(6)), sha(idOf(7)), sha(idOf(8))].sort());
    expect(store.wiped("not an id")).toBeNull();
    expect(store.wiped(idOf(99))).toBeNull();
  });

  it("a deposit address that several orders share leaves the index with the last of them: no file named after an address outlives every order that used it", () => {
    const dir = tempDir();
    const store = createOrderStore(dir, { now: () => NOON });
    const shared = "GAQMXQJ2UFA5ECB2JJ3GUYQF46ROPVINVWAMN7KNR3OAMDHLQ46LFRBW";
    const ghost = stored(1, { ghost: true, depositAddress: shared, depositMemo: "1" });
    const ordinary = stored(2, { depositAddress: shared, depositMemo: "2" });
    for (const record of [ghost, ordinary]) store.create(record);
    expect(fs.readFileSync(indexFile(dir, shared), "utf8")).toBe("*");
    store.saveState(ghost.id, ended(ghost));
    expect(store.wipe(ghost.id)).toBe(true);
    // The other order still uses the address: its entry stays as it was, and still opens neither.
    expect(fs.readFileSync(indexFile(dir, shared), "utf8")).toBe("*");
    expect(store.findByDeposit(shared)).toBeNull();
    store.remove(ordinary.id);
    expect(fs.readdirSync(path.join(dir, "by-deposit"))).toEqual([]);

    // Two Ghost orders on one address: the entry goes with the second, whichever way round they end.
    const [a, b] = [stored(3, { ghost: true, depositAddress: shared, depositMemo: "3" }), stored(4, { ghost: true, depositAddress: shared, depositMemo: "4" })];
    for (const record of [a, b]) {
      store.create(record);
      store.saveState(record.id, ended(record, "refunded"));
    }
    expect(store.wipe(b.id)).toBe(true);
    expect(fs.existsSync(indexFile(dir, shared))).toBe(true);
    expect(store.wipe(a.id)).toBe(true);
    expect(fs.readdirSync(path.join(dir, "by-deposit"))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "orders"))).toEqual([]);
  });

  it("the clean-up of old records is not put out by a record that has gone already: one that ended at its last check, and one that went before its turn came", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    // Three orders on a chain this server cannot read, each with a transaction named for it, all run out: kept 30 days, then asked about one last time.
    const late = async (mark: Record<string, unknown>, n: number) => {
      const order = asOrder(await h.order({ ...mark, from: ASSET.btc, to: ASSET.arbUsdc, amount: "1000000", pay: "manual", sender: undefined, refundTo: ADDR.btc, recipient: WHO.recipient }, { ip: `198.51.100.${n}` }));
      h.store.saveState(order.id, { ...h.store.get(order.id)!.state, depositTxHash: made(`late deposit ${n}`, 32), depositVerified: false, depositForwarded: true });
      return order;
    };
    const orders = [await late({ ghost: true }, 1), await late({ ghost: true }, 2), await late({}, 3)].sort((a, b) => (a.id < b.id ? -1 : 1));
    h.tap.statusReply = answer("PENDING_DEPOSIT");
    for (const order of orders) await runOut(h, order);
    for (const order of orders) expect(statusOf(h, order.id)).toBe("expired");
    h.clock.t += FINISHED_RETENTION_MS + DAY;

    // The pass asks about them in the order of their IDs. While it asks about the first, the last one's record goes.
    const [first, , last] = orders as [OrderView, OrderView, OrderView];
    const refundedGhost = orders.find((order) => order.ghost === true)!;
    h.tap.statusReply = (deposit) => {
      if (deposit === first.depositAddress) h.store.remove(last.id);
      // The provider now says of a Ghost order that it was refunded after all: it ends at this very check, and its record goes with that.
      return deposit === refundedGhost.depositAddress ? answer("REFUNDED")(deposit) : answer("PENDING_DEPOSIT")(deposit);
    };
    await h.sweep();
    expect(h.logs.filter((line) => /sweep_failed|ghost_tidy_failed|poll_failed/.test(line))).toEqual([]);
    expect(fs.readdirSync(path.join(h.dataDir, "orders"))).toEqual([]);
    expect(fs.readdirSync(path.join(h.dataDir, "by-deposit"))).toEqual([]);
    // Each Ghost order left the word for how it ended, whichever way its record went; the ordinary order left nothing.
    const ghosts = orders.filter((order) => order.ghost === true);
    const otherGhost = ghosts.find((order) => order.id !== refundedGhost.id)!;
    const ordinary = orders.find((order) => order.ghost !== true)!;
    expect((await h.get(`/api/orders/${refundedGhost.id}`)).body).toEqual(gone("refunded"));
    expect((await h.get(`/api/orders/${otherGhost.id}`)).body).toEqual(gone("expired"));
    expect((await h.get(`/api/orders/${ordinary.id}`)).text).toBe(NEVER);
    expect(fs.readdirSync(goneDir(h.dataDir)).sort()).toEqual(ghosts.map((order) => sha(order.id)).sort());
    // And a second pass has nothing to do and nothing to trip on.
    await h.sweep();
    expect(h.logs.filter((line) => /sweep_failed|ghost_tidy_failed/.test(line))).toEqual([]);
  });
});

describe("afterwards, a Ghost order's page is told only that it finished, and how", () => {
  it("its ID is answered 410, with the one word for how it ended and nothing else of the order; an ID that never was is the 404 it always was", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    const untouched = await start();
    const neverWas = "A".repeat(27);
    const before = await h.get(`/api/orders/${neverWas}`, { ip: "198.51.100.50" });

    const delivered = await ghostly(h, { rewardsAddress: WHO.rewards });
    const deposit = txHash("answered deposit");
    expect((await payByWallet(h, delivered, deposit)).status).toBe(200);
    await step(h, delivered.id, 5000);
    await step(h, delivered.id, 5000);
    await step(h, delivered.id, 15_000);
    const refunded = await ghostly(h, {}, "198.51.100.2");
    await refund(h, refunded);
    const ranOut = await ghostly(h, {}, "198.51.100.3");
    await runOut(h, ranOut);
    await watchEnds(h, ranOut);

    const endings = [[delivered, "delivered"], [refunded, "refunded"], [ranOut, "expired"]] as const;
    for (const [order, ended] of endings) {
      const reply = await h.get(`/api/orders/${order.id}`);
      expect(reply.status, ended).toBe(410);
      expect(reply.body, ended).toEqual(gone(ended));
      // To the letter: the code, the sentence and the word, and no other field.
      expect(reply.text, ended).toBe(`{"error":{"code":"order_deleted","message":"This order finished, and its record was deleted.","detail":{"ended":"${ended}"}}}`);
      expect(reply.headers.get("cache-control"), ended).toBe("no-store");
      // The file that is kept holds that word and nothing else.
      expect(fs.readFileSync(goneFile(h.dataDir, order.id), "utf8"), ended).toBe(ended);
      // Nothing else of the order is in the answer: no amount, coin, address, hash or time.
      for (const value of [order.id, order.depositAddress!, order.amountIn, order.amountOut, order.from.symbol, order.to.symbol, WHO.sender, WHO.recipient, WHO.refundTo, WHO.rewards, deposit, "cd".repeat(32), "2026"]) expect(carries(reply.text, value), `${ended} ${value}`).toBe(false);
    }
    expect(fs.readdirSync(goneDir(h.dataDir)).sort()).toEqual(endings.map(([order]) => sha(order.id)).sort());
    // That is not a guess at an ID, and is not counted as one: the page may ask as often as any page does.
    for (let i = 0; i < LIMITS.orderMiss.max + 5; i++) expect((await h.get(`/api/orders/${delivered.id}`)).status).toBe(410);
    // Its line in the access log names no order at all.
    const goneLines = h.access.filter((entry) => entry.status === 410);
    expect(goneLines.length).toBe(3 + LIMITS.orderMiss.max + 5);
    expect(goneLines.every((entry) => entry.route === "order_read" && entry.order === undefined && entry.cid === undefined)).toBe(true);

    // A file that holds anything but one of the three words is answered without one, and nothing of what it holds is passed on.
    const tampered = ["", "delivered\n", " delivered", "Delivered", "DELIVERED", "failed", "swapping", "delivered refunded", `{"ended":"delivered"}`, `sent 5 ETH from ${WHO.sender}`, "x".repeat(5000)];
    for (const content of tampered) {
      fs.writeFileSync(goneFile(h.dataDir, refunded.id), content);
      fs.utimesSync(goneFile(h.dataDir, refunded.id), THAT_DAY / 1000, THAT_DAY / 1000);
      const reply = await h.get(`/api/orders/${refunded.id}`);
      expect([reply.status, reply.text], JSON.stringify(content.slice(0, 30))).toEqual([410, JSON.stringify(gone())]);
      expect(h.store.wiped(refunded.id), JSON.stringify(content.slice(0, 30))).toEqual({ ended: null });
    }
    // Each of the three words, written there by itself, is read.
    for (const word of ["delivered", "refunded", "expired"] as const) {
      fs.writeFileSync(goneFile(h.dataDir, refunded.id), word);
      fs.utimesSync(goneFile(h.dataDir, refunded.id), THAT_DAY / 1000, THAT_DAY / 1000);
      expect((await h.get(`/api/orders/${refunded.id}`)).body).toEqual(gone(word));
    }

    // An ID that never was: the same answer as before any Ghost order existed, and as on a server that never had one. Letter for letter.
    const after = await h.get(`/api/orders/${neverWas}`, { ip: "198.51.100.51" });
    const elsewhere = await untouched.get(`/api/orders/${neverWas}`);
    for (const reply of [before, after, elsewhere]) {
      expect([reply.status, reply.text]).toEqual([404, NEVER]);
      expect([reply.headers.get("content-type"), reply.headers.get("content-length"), reply.headers.get("cache-control")]).toEqual(["application/json; charset=utf-8", String(NEVER.length), "no-store"]);
    }
    // And it is still counted as a guess: after the usual few, the visitor is told to wait.
    const guesses: number[] = [];
    for (let i = 0; i <= LIMITS.orderMiss.max; i++) guesses.push((await h.get(`/api/orders/${"B".repeat(27)}`, { ip: "198.51.100.52" })).status);
    expect(guesses).toEqual([...Array<number>(LIMITS.orderMiss.max).fill(404), 429]);
    // Anything that is not an ID's shape is the plain 404, with no look for a fingerprint.
    for (const odd of ["nope", "A".repeat(26), `${"A".repeat(26)}.`, sha(delivered.id)]) expect((await h.get(`/api/orders/${odd}`, { ip: "198.51.100.53" })).text, odd).toBe(NEVER);
  });

  it("its deposit address finds nothing, before it is paid, while it is under way and once it has finished: the answer an address that is no order's gets, counted the same", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY, orderFind: ROOMY, orderFindDaily: ROOMY, orderFindDailyWide: ROOMY, orderFindGlobal: ROOMY } });
    const ghost = await ghostly(h);
    const ordinary = await plainly(h, {}, "198.51.100.2");
    const stranger = { session: await h.session("198.51.100.40"), ip: "198.51.100.40" };
    const miss = await h.post("/api/track", { depositAddress: address("no order's") }, stranger);
    expect([miss.status, miss.text]).toEqual([404, NEVER]);
    const sameAsAMiss = async (when: string) => {
      for (const spelling of [ghost.depositAddress!, ghost.depositAddress!.toLowerCase(), ` ${ghost.depositAddress!} `]) {
        const reply = await h.post("/api/track", { depositAddress: spelling }, stranger);
        expect([reply.status, reply.text], when).toEqual([miss.status, miss.text]);
        expect(reply.headers.get("content-length"), when).toBe(miss.headers.get("content-length"));
      }
    };
    await sameAsAMiss("waiting");
    // An ordinary order beside it is found as ever, by anyone who has its deposit address.
    expect((await h.post("/api/track", { depositAddress: ordinary.depositAddress }, stranger)).body).toEqual({ id: ordinary.id });
    // The store itself still knows whose address it is, while the record is there: the rule is the route's.
    expect(h.store.findByDeposit(ghost.depositAddress!)?.id).toBe(ghost.id);

    h.stub.control(ghost.depositAddress!, "deposit");
    await step(h, ghost.id, 5000);
    await step(h, ghost.id, 5000);
    expect(statusOf(h, ghost.id)).toBe("swapping");
    await sameAsAMiss("swapping");
    await step(h, ghost.id, 15_000);
    expect(statusOf(h, ghost.id)).toBeNull();
    await sameAsAMiss("finished");
    // Never the 410 here: that would say the address had been an order's.
    const finds = h.access.filter((entry) => entry.route === "order_find");
    expect(finds.map((entry) => entry.status).sort()).toEqual([200, ...Array<number>(10).fill(404)]);
    expect(finds.filter((entry) => entry.status === 404).every((entry) => entry.order === undefined)).toBe(true);

    // Asking after a Ghost order's address uses up the allowance for guesses, as any miss does.
    const other = await ghostly(h, {}, "198.51.100.3");
    const guesser = { session: await h.session("198.51.100.41"), ip: "198.51.100.41" };
    const statuses: number[] = [];
    for (let i = 0; i <= LIMITS.orderMiss.max; i++) statuses.push((await h.post("/api/track", { depositAddress: other.depositAddress }, guesser)).status);
    expect(statuses).toEqual([...Array<number>(LIMITS.orderMiss.max).fill(404), 429]);
  });

  it("every other route that takes its ID: a deposit sent in is answered with the same 410 and the same word, a practice control as for an ID that never was, and a retry of the request that made it makes a new order", async () => {
    const h = await start({ practice: true, limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    const preview = (await h.quote({ from: ASSET.baseEth, to: ASSET.arbUsdc, amount: "5000000000000000", pay: "wallet", ...SWAP })).body as QuoteView;
    const reviewed = { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: preview.fees.appBps + preview.fees.providerBps, routing: preview.routing };
    const body = { ...SWAP, ghost: true, reviewed, requestId: "ghost-request-key-000001" };
    const order = asOrder(await h.order(body));
    const session = await h.session();
    // While it is there, the same key with another swap is refused, as for any order.
    expect(outcome(await h.order({ ...body, amount: "6000000000000000" }))).toBe("conflict");
    await deliver(h, order);
    expect(statusOf(h, order.id)).toBeNull();
    const [chainReads, passedOn] = [h.rpc.calls.length, h.stub.calls.submits];

    const sent = await h.post(`/api/orders/${order.id}/deposit`, { txHash: txHash("too late") }, { session });
    expect([sent.status, sent.body]).toEqual([410, gone("delivered")]);
    const never = await h.post(`/api/orders/${"C".repeat(27)}/deposit`, { txHash: txHash("too late") }, { session });
    expect([never.status, never.text]).toEqual([404, NEVER]);
    // Nothing was looked up on a chain or passed to the provider for it, and nothing is held for its ID again.
    expect([h.rpc.calls.length, h.stub.calls.submits]).toEqual([chainReads, passedOn]);
    expect(h.limiters.depositPerOrder.size).toBe(0);
    expect(h.poller.holds(order.id)).toBe(false);

    for (const id of [order.id, "C".repeat(27)]) {
      const control = await h.post(`/api/practice/${id}`, { action: "deposit" });
      expect([control.status, control.text], id).toEqual([404, NEVER]);
    }

    // Nothing remembers the request that made it: its key is free, as a key never used is, even for another swap.
    const other = await h.order({ ...body, amount: "6000000000000000" });
    expect(other.status).toBe(201);
    expect(other.body.id).not.toBe(order.id);
  });

  it("what is kept is a fingerprint of its ID and one word: a file named by the SHA-256 of the ID, holding how the order ended and nothing else, dated by the day, in a folder only the server can read, gone after 30 days", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    const order = await ghostly(h);
    await deliver(h, order);
    expect(h.clock.t).toBe(NOON + 25_000);

    expect(fs.readdirSync(goneDir(h.dataDir))).toEqual([sha(order.id)]);
    expect(sha(order.id)).toMatch(/^[0-9a-f]{64}$/);
    const file = fs.statSync(goneFile(h.dataDir, order.id));
    expect(file.size).toBe("delivered".length);
    expect(fs.readFileSync(goneFile(h.dataDir, order.id), "utf8")).toBe("delivered");
    // Its date is the day the record went, and never the time of day.
    expect(file.mtimeMs).toBe(THAT_DAY);
    expect(file.mode & 0o777).toBe(0o600);
    for (const folder of [path.join(h.dataDir, "ghost"), goneDir(h.dataDir)]) expect(fs.statSync(folder).mode & 0o777, folder).toBe(0o700);
    // No file was left half-written beside it.
    expect(fs.readdirSync(path.join(h.dataDir, "ghost"))).toEqual(["gone"]);

    // A second Ghost order ends 20 days later.
    h.clock.t = NOON + 20 * DAY;
    await muchLater(h);
    const later = await ghostly(h, {}, "198.51.100.2");
    await refund(h, later);
    expect(fs.statSync(goneFile(h.dataDir, later.id)).mtimeMs).toBe(THAT_DAY + 20 * DAY);
    expect(fs.readFileSync(goneFile(h.dataDir, later.id), "utf8")).toBe("refunded");

    // For 30 days from its day the first is known to have finished, pass after pass of the clean-up.
    h.clock.t = THAT_DAY + WIPED_KEPT_MS - 1000;
    await h.sweep();
    expect((await h.get(`/api/orders/${order.id}`)).body).toEqual(gone("delivered"));
    expect(WIPED_KEPT_MS).toBe(30 * DAY);
    // Then its ID is one that never was, from that moment, whether or not the clean-up has run yet: the word goes with the fingerprint...
    h.clock.t = THAT_DAY + WIPED_KEPT_MS;
    const expired = await h.get(`/api/orders/${order.id}`, { ip: "198.51.100.60" });
    expect([expired.status, expired.text]).toEqual([404, NEVER]);
    expect(h.store.wiped(order.id)).toBeNull();
    expect(fs.existsSync(goneFile(h.dataDir, order.id))).toBe(true);
    // ...and the next pass takes the file away. The younger one stays.
    await h.sweep();
    expect(fs.readdirSync(goneDir(h.dataDir))).toEqual([sha(later.id)]);
    expect((await h.get(`/api/orders/${later.id}`)).body).toEqual(gone("refunded"));
    expect((await h.get(`/api/orders/${order.id}`, { ip: "198.51.100.61" })).text).toBe(NEVER);
    h.clock.t = THAT_DAY + 20 * DAY + WIPED_KEPT_MS;
    await h.sweep();
    expect(fs.readdirSync(goneDir(h.dataDir))).toEqual([]);
  });
});

describe("points are counted before the record goes; with no rewards address nothing at all is kept", () => {
  it("named a rewards address: its entry is on disk, and the swap is in the totals on disk, before the record is deleted; the entry holds what any swap's holds", async () => {
    const h = await start();
    const order = await ghostly(h, { rewardsAddress: WHO.rewards });
    // What is on disk at the moment the record is asked to go.
    const real = h.store.wipe.bind(h.store);
    const seen: Array<{ counted: number; entry: boolean; record: boolean }> = [];
    h.store.wipe = (id) => {
      seen.push({ counted: statsFile(h.dataDir).swaps, entry: fs.existsSync(entryFile(h.dataDir, id)), record: fs.existsSync(orderFile(h.dataDir, id)) });
      return real(id);
    };
    await deliver(h, order);
    expect(seen).toEqual([{ counted: 1, entry: true, record: true }]);
    expect(fs.existsSync(orderFile(h.dataDir, order.id))).toBe(false);

    const delivered = NOON + 25_000;
    const entry = { v: 2, order: sha(order.id), address: WHO.rewards, week: weekOf(delivered), at: iso(delivered), volumeUsdMicro: "12500000", reasons: [], from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDC", chain: "arb" } };
    expect(h.rewards.entriesFor(WHO.rewards)).toEqual([entry]);
    expect(fs.readdirSync(entriesDir(h.dataDir))).toEqual([`${sha(order.id)}.json`]);
    expect(JSON.parse(fs.readFileSync(entryFile(h.dataDir, order.id), "utf8"))).toEqual(entry);
    // The entry names the order by its fingerprint only, and holds no other address of the swap.
    const text = fs.readFileSync(entryFile(h.dataDir, order.id), "utf8");
    for (const value of [order.id, order.depositAddress!, WHO.sender, WHO.recipient, WHO.refundTo]) expect(carries(text, value), value).toBe(false);
    // Read again from the folder, as at a start, the points are the same.
    expect(createRewards(h.dataDir).entriesFor(WHO.rewards)).toEqual([entry]);
  });

  it("named none: no entry is written, and nothing in the data folder names the order, its addresses or its transactions; a refunded Ghost order adds no points either", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    const order = await ghostly(h);
    const record = h.store.get(order.id)!;
    const deposit = txHash("unnamed deposit");
    expect((await payByWallet(h, order, deposit)).status).toBe(200);
    await step(h, order.id, 5000);
    await step(h, order.id, 5000);
    const delivery = "cd".repeat(32);
    expect(h.store.get(order.id)!.state.details?.originTxs[0]?.hash).toBe(deposit);
    await step(h, order.id, 15_000);
    expect(statusOf(h, order.id)).toBeNull();
    const refunded = await ghostly(h, { rewardsAddress: WHO.rewards }, "198.51.100.2");
    await refund(h, refunded);

    expect(fs.readdirSync(entriesDir(h.dataDir))).toEqual([]);
    expect(h.rewards.entriesFor(WHO.rewards)).toEqual([]);
    // Every file the server keeps, by its name and by what it holds.
    const files = everyFile(h.dataDir);
    expect(files.map((file) => file.name).sort()).toEqual([path.join("cache", "tokens.json"), path.join("ghost", "gone", sha(order.id)), path.join("ghost", "gone", sha(refunded.id)), path.join("stats", "stats.json")].sort());
    const quote = record.quoteResponse as { signature: string; correlationId: string };
    const never = [order.id, refunded.id, order.depositAddress!, refunded.depositAddress!, WHO.sender, WHO.recipient, WHO.refundTo, WHO.rewards, deposit, delivery, quote.signature, quote.correlationId, sha(depositKey(order.depositAddress!)), hashId(order.id)];
    for (const file of files) {
      // The one thing kept is the fingerprint, which is the file's name; inside it is the one word, and nothing else.
      const fingerprint = file.name.startsWith(path.join("ghost", "gone"));
      for (const value of never) expect(carries(`${fingerprint ? "" : file.name}\n${file.text}`, value), `${value} in ${file.name}`).toBe(false);
      if (fingerprint) expect(file.text, file.name).toBe(file.name.endsWith(sha(order.id)) ? "delivered" : "refunded");
    }
  });
});

describe("no log line and no alert carries an address, a transaction or the ID of a Ghost order", () => {
  /** Everything the server wrote or sent about anything: its log, its access log, and its alerts with the keys they were sent under. */
  const written = (h: Harness) => [...h.logs, JSON.stringify(h.access), JSON.stringify(h.alerts), JSON.stringify(h.alertKeys)].join("\n");

  it("from the quote to delivered, and to refunded, through every fault on the way: an order is named by its hashed ID and by nothing else", async () => {
    const payer = address("listed payer");
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY }, sanctions: createStaticSanctions([payer], { now: () => NOON }) });
    const secrets: string[] = [WHO.sender, WHO.recipient, WHO.refundTo, WHO.rewards, payer];
    const ids: string[] = [];
    const cids: string[] = [];
    const noted = (order: OrderView) => {
      const quote = h.store.get(order.id)!.quoteResponse as { correlationId: string; signature: string };
      ids.push(order.id);
      cids.push(quote.correlationId);
      secrets.push(order.id, order.depositAddress!, sha(order.id), quote.correlationId, quote.signature);
      return order;
    };

    const preview = (await h.quote({ from: ASSET.baseEth, to: ASSET.arbUsdc, amount: "5000000000000000", pay: "wallet", ...SWAP })).body as QuoteView;
    const reviewed = { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: preview.fees.appBps + preview.fees.providerBps, routing: preview.routing };

    // One order from the quote to delivered: the person looks at its page, a first transaction is named that a listed wallet
    // paid (refused, and the operator told), then the real one. The provider answers badly three ways before it reports the swap.
    const first = noted(await ghostly(h, { rewardsAddress: WHO.rewards }));
    await h.get(`/api/orders/${first.id}`);
    const [listedTx, deposit] = [txHash("log listed"), txHash("log deposit")];
    secrets.push(listedTx, deposit, "cd".repeat(32));
    expect((await payByWallet(h, first, listedTx, payer)).status).toBe(403);
    h.stub.provider.submitDeposit = async (body) => (h.stub.control(body.depositAddress, "deposit"), { ok: true, status: 200, data: {}, cid: "cid-ghost-submit-0001" });
    cids.push("cid-ghost-submit-0001", "cid-ghost-status-0002");
    expect((await payByWallet(h, first, deposit)).status).toBe(200);
    h.tap.statusReply = () => ({ ok: false, kind: "unavailable", status: 503, cid: "cid-ghost-status-0002" });
    await step(h, first.id, 5000);
    h.tap.statusReply = () => ({ ok: true, status: 200, data: { status: "NO_SUCH_STATUS" } });
    await step(h, first.id, 5000);
    h.tap.statusReply = (address) => ({ ok: true, status: 200, data: { status: "PROCESSING", quoteResponse: { quote: { depositAddress: `${address}0` } } } });
    await step(h, first.id, 5000);
    h.tap.statusReply = () => {
      throw new Error(`could not ask about ${first.depositAddress}`);
    };
    await step(h, first.id, 5000);
    // Swapping for far longer than its estimate: the operator is told.
    h.tap.statusReply = answer("PROCESSING", { originChainTxHashes: [{ hash: deposit }] });
    await step(h, first.id, 5000);
    await step(h, first.id, 10 * MINUTE);
    expect(statusOf(h, first.id)).toBe("swapping");
    h.tap.statusReply = null;
    await step(h, first.id, 5000);
    expect(statusOf(h, first.id)).toBeNull();
    await h.get(`/api/orders/${first.id}`);

    // A second, refunded. A third whose confirmed deposit the provider never reports, and a fourth it never finishes: the operator is told of both.
    const second = noted(await ghostly(h, {}, "198.51.100.2"));
    await refund(h, second);
    const third = noted(await ghostly(h, {}, "198.51.100.3"));
    const unseen = txHash("log unseen");
    secrets.push(unseen);
    h.stub.provider.submitDeposit = async () => ({ ok: true, status: 200, data: {} });
    expect((await payByWallet(h, third, unseen)).status).toBe(200);
    h.tap.statusReply = answer("PENDING_DEPOSIT");
    await runOut(h, third);
    const fourth = noted(await ghostly(h, {}, "198.51.100.4"));
    h.tap.statusReply = answer("PROCESSING");
    await step(h, fourth.id, 5000);
    h.clock.t = Date.parse(fourth.deadline) + GIVE_UP_AFTER_DEADLINE_MS;
    await step(h, fourth.id, 1000);
    // A fifth whose quote does not hold: nothing is made, and the operator is told why in a fixed word.
    h.tap.statusReply = null;
    const fifth = await muchLater(h, "198.51.100.5");
    h.tap.corruptResponse = (data) => ({ ...data, quote: { ...(data.quote as Record<string, unknown>), amountOut: "1" } });
    expect((await h.order({ ...SWAP, ghost: true, reviewed }, fifth)).status).toBe(502);
    h.tap.corruptResponse = null;
    // A sixth the provider cannot answer for: the failed call's tracing ID is the provider's name for the request.
    h.tap.nextQuote = { ok: false, kind: "unavailable", status: 503, cid: "cid-ghost-quote-0003" };
    cids.push("cid-ghost-quote-0003");
    expect((await h.order({ ...SWAP, ghost: true, reviewed }, await muchLater(h, "198.51.100.6"))).status).toBe(503);
    await h.sweep();

    // All of it was said: each kind of line and each alert is there to be searched.
    const events = new Set(h.logs.map((line) => (JSON.parse(line) as { event: string }).event));
    for (const event of ["order_status", "status_invalid", "poll_failed", "order_gave_up", "quote_verification_failed"]) expect(events, event).toContain(event);
    expect([...new Set(h.alerts.map((alert) => alert.kind))].sort()).toEqual(["deposit_unseen", "quote_verification", "sanctions_hit", "slow_swap", "status_mismatch", "unfinished_order"]);
    for (const route of ["quote", "order_create", "order_read", "order_deposit"]) expect(h.access.some((entry) => entry.route === route), route).toBe(true);

    // Each alert as the server's own alert channel writes it to the log and sends it to the operator's webhook.
    const sentOut: string[] = [];
    const channel = createAlerts({ webhookUrl: "https://hooks.example/operator", log: createLogger((line) => sentOut.push(line)), now: () => h.clock.t, fetchImpl: async (_url, init) => (sentOut.push(String(init?.body)), new Response("ok")) });
    h.alerts.forEach((alert, i) => channel.send(alert.kind, alert.text, h.alertKeys[i]));
    expect(sentOut).toHaveLength(2 * h.alerts.length);

    const text = `${written(h)}\n${sentOut.join("\n")}`;
    for (const secret of secrets) expect(carries(text, secret), secret).toBe(false);
    // The one name an order has there is its hashed ID, as the access log has always written it.
    for (const id of ids) expect(text).toContain(hashId(id));
    const named = h.access.filter((entry) => entry.order !== undefined);
    expect(named.length).toBeGreaterThan(5);
    expect(named.every((entry) => ids.map(hashId).includes(entry.order!))).toBe(true);
    // No line of the access log carries the provider's tracing ID for any of it, whether the order was made or not.
    const lived = h.access.filter((entry) => entry.route !== "quote" && entry.route !== "config");
    expect(lived.map((entry) => entry.route).filter((route, i, all) => all.indexOf(route) === i).sort()).toEqual(["order_create", "order_deposit", "order_read"]);
    expect(lived.every((entry) => entry.cid === undefined)).toBe(true);
    expect(cids).toHaveLength(7);
    for (const cid of cids) expect(text).not.toContain(cid);
    // An alert is held back by a key, kept in memory: for an order it is the hashed ID too.
    const orderAlerts = h.alerts.map((alert, i) => ({ ...alert, key: h.alertKeys[i]! })).filter((alert) => alert.kind !== "quote_verification");
    expect(orderAlerts.length).toBeGreaterThanOrEqual(5);
    for (const alert of orderAlerts) {
      expect(ids.map(hashId), alert.kind).toContain(alert.key);
      expect(alert.text, alert.kind).toContain(alert.key);
    }
    expect(h.alertKeys.filter((key) => ids.includes(key))).toEqual([]);
    // The line about a failed status call is there to carry the provider's ID. For these orders there is none to carry, and no line.
    expect(events).not.toContain("status_failed");
    // Every line that names an order holds its hashed ID, what happened, and nothing of the order beside.
    const lines = h.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.order !== undefined);
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const line of lines) {
      expect(ids.map(hashId), String(line.event)).toContain(line.order);
      expect(Object.keys(line).filter((key) => !["t", "level", "event", "order", "status"].includes(key)), String(line.event)).toEqual([]);
    }
  });

  it("an ordinary order's lines are as they were: the provider's tracing ID is in its access line and in the line about a failed status call", async () => {
    const h = await start();
    const order = await plainly(h);
    const quote = h.store.get(order.id)!.quoteResponse as { correlationId: string };
    expect(h.access.find((entry) => entry.route === "order_create")).toMatchObject({ status: 201, order: hashId(order.id), cid: quote.correlationId, screening: "clear" });
    h.tap.statusReply = () => ({ ok: false, kind: "unavailable", status: 503, cid: "cid-plain-status-0001" });
    await step(h, order.id, 5000);
    expect(h.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === "status_failed")).toEqual([expect.objectContaining({ order: hashId(order.id), cid: "cid-plain-status-0001" })]);
    h.stub.provider.submitDeposit = async (body) => (h.stub.control(body.depositAddress, "deposit"), { ok: true, status: 200, data: {}, cid: "cid-plain-submit-0002" });
    expect((await payByWallet(h, order, txHash("plain deposit"))).status).toBe(200);
    expect(h.access.at(-1)).toMatchObject({ route: "order_deposit", status: 200, order: hashId(order.id), cid: "cid-plain-submit-0002" });
  });

  it("the provider is asked about a Ghost order with its tracing ID not kept, and about any other order as ever", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    expect(tracingOf({ ghost: true })).toBe("dropped");
    expect(tracingOf({})).toBe("kept");
    // One order at a time, each to its end, so that every call the poller makes is for that order.
    for (const [mark, how, ip] of [[{ ghost: true }, "dropped", "198.51.100.1"], [{}, "kept", "198.51.100.2"]] as const) {
      for (const list of [h.tap.quoteTracing, h.tap.statusTracing, h.tap.submitTracing]) list.length = 0;
      const order = asOrder(await h.order({ ...SWAP, ...mark }, { ip }));
      // The preview is anyone's; the quote that makes the order is asked the one way or the other.
      expect(h.tap.quoteTracing).toEqual(["kept", how]);
      expect((await payByWallet(h, order, txHash(`tracing ID ${how}`))).status).toBe(200);
      await step(h, order.id, 5000);
      await step(h, order.id, 5000);
      await step(h, order.id, 15_000);
      expect(h.tap.submitTracing).toEqual([how]);
      expect(h.tap.statusTracing).toEqual([how, how, how]);
    }
    // A hash the poller passes on later, and the last check before an old record is deleted, are asked the same way.
    const late = asOrder(await h.order({ ghost: true, from: ASSET.btc, to: ASSET.arbUsdc, amount: "1000000", pay: "manual", sender: undefined, refundTo: ADDR.btc, recipient: WHO.recipient }, { ip: "198.51.100.3" }));
    h.store.saveState(late.id, { ...h.store.get(late.id)!.state, depositTxHash: made("late hash", 32), depositVerified: false, depositForwarded: false });
    h.tap.submitTracing.length = 0;
    h.tap.statusReply = answer("PENDING_DEPOSIT");
    await step(h, late.id, 5000);
    expect(h.tap.submitTracing).toEqual(["dropped"]);
    await runOut(h, late);
    expect(statusOf(h, late.id)).toBe("expired");
    h.clock.t += FINISHED_RETENTION_MS + DAY;
    h.tap.statusTracing.length = 0;
    expect(await h.sweep()).toBe(2);
    // Two old records were due: the Ghost order's, asked about with the tracing ID dropped, and the ordinary delivered one, which needs no asking.
    expect(h.tap.statusTracing).toEqual(["dropped"]);
    expect(statusOf(h, late.id)).toBeNull();
  });

  it("the provider client itself drops the tracing ID of a call made for a Ghost order: it is in no line it logs and is not handed back; what is sent is the same", async () => {
    const lines: string[] = [];
    const sent: string[] = [];
    let reply: () => Response = () => new Response("{}");
    const client = createOneClick({
      apiKey: null,
      maxPerMin: 1000,
      allowLive: true,
      log: createLogger((line) => lines.push(line)),
      fetchImpl: async (url, init) => {
        sent.push(JSON.stringify([String(url), init?.method, init?.body ?? null]));
        return reply();
      },
    });
    const deposit = address("client deposit");
    const calls = {
      quote: (how?: "kept" | "dropped") => client.quote({ dry: false, amount: "1" }, "order", how),
      status: (how?: "kept" | "dropped") => client.status(deposit, null, "tracking", how),
      submit: (how?: "kept" | "dropped") => client.submitDeposit({ depositAddress: deposit, txHash: txHash("client") }, "tracking", how),
    };
    for (const [name, call] of Object.entries(calls)) {
      // An answer that worked, and one that failed: each carries the provider's tracing ID.
      for (const status of [200, 503]) {
        reply = () => new Response(JSON.stringify({ correlationId: "cid-client-0001", message: "said the provider" }), { status });
        lines.length = 0;
        sent.length = 0;
        const [usual, kept, dropped] = [await call(), await call("kept"), await call("dropped")];
        expect(usual.cid, name).toBe("cid-client-0001");
        expect(kept.cid, name).toBe("cid-client-0001");
        expect("cid" in dropped, name).toBe(false);
        expect([dropped.ok, dropped.status], name).toEqual([usual.ok, usual.status]);
        // The same request went out each time.
        expect(new Set(sent).size, name).toBe(1);
        expect(sent).toHaveLength(3);
        if (status === 503) {
          const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
          expect(logged.map((line) => line.cid), name).toEqual(["cid-client-0001", "cid-client-0001", undefined]);
          expect(logged.every((line) => line.event === "oneclick_error" && line.status === 503), name).toBe(true);
        }
      }
    }
  });
});

describe("a stop or a fault between the steps of a Ghost order's ending neither counts it twice nor leaves its record behind", () => {
  /** A folder as a stop at some point of the ending would leave it: a delivered Ghost order that named a rewards address, and an ordinary one beside it. */
  function stoppedAt(point: "saved" | "counted" | "points written" | "fingerprint written") {
    const dir = tempDir();
    const ghost = stored(1, { ghost: true });
    const beside = stored(2);
    // The store with nothing listening: a state is saved, and nothing is told of it.
    const store = createOrderStore(dir, { now: () => NOON });
    for (const record of [ghost, beside]) {
      store.create(record);
      store.saveState(record.id, ended(record));
    }
    // The ordinary order was dealt with whole before the stop.
    const stats = createStats(dir, { now: () => NOON });
    const rewards = createRewards(dir);
    stats.recordDelivered(store.get(beside.id)!, () => store.markCounted(beside.id));
    rewards.recordDelivered(store.get(beside.id)!);
    if (point !== "saved") expect(stats.recordDelivered(store.get(ghost.id)!, () => store.markCounted(ghost.id))).toBe(true);
    if (point === "points written" || point === "fingerprint written") expect(rewards.recordDelivered(store.get(ghost.id)!)).not.toBeNull();
    if (point === "fingerprint written") fs.writeFileSync(goneFile(dir, ghost.id), "delivered");
    return { dir, ghost, beside };
  }

  for (const point of ["saved", "counted", "points written", "fingerprint written"] as const) {
    it(`stopped once the order was ${point}, and no further: the next start finishes the job, and a start after that changes nothing`, () => {
      const { dir, ghost, beside } = stoppedAt(point);
      expect(fs.existsSync(orderFile(dir, ghost.id))).toBe(true);
      expect(statsFile(dir).swaps).toBe(point === "saved" ? 1 : 2);
      expect(fs.readdirSync(entriesDir(dir))).toHaveLength(point === "saved" || point === "counted" ? 1 : 2);

      const lines: string[] = [];
      restarted(dir, () => NOON + MINUTE, lines);
      const finished = () => {
        // Counted once: two swaps in all, each with its volume, and one row, which is the ordinary order's.
        expect(statsFile(dir)).toMatchObject({ swaps: 2, volumeMicro: "501000000", deliveriesTimed: 2, chains: { base: { swaps: 2, volumeMicro: "501000000" } }, coins: [{ symbol: "ETH", chain: "base", volumeMicro: "501000000" }], received: [{ symbol: "USDC", chain: "arb", volumeMicro: "501000000" }] });
        expect(statsFile(dir).rows.map((row) => row.amount)).toEqual([beside.amountIn]);
        // Its points written once.
        expect(fs.readdirSync(entriesDir(dir)).sort()).toEqual([`${sha(ghost.id)}.json`, `${sha(beside.id)}.json`].sort());
        expect(createRewards(dir).entriesFor(ghost.rewardsAddress!)).toHaveLength(1);
        // Its record gone, with its entry in the index, and its fingerprint left.
        expect(fs.readdirSync(path.join(dir, "orders"))).toEqual([`${beside.id}.json`]);
        expect(fs.readdirSync(path.join(dir, "by-deposit"))).toEqual([sha(depositKey(beside.depositAddress))]);
        expect(fs.readdirSync(goneDir(dir))).toEqual([sha(ghost.id)]);
        expect(fs.statSync(goneFile(dir, ghost.id)).mtimeMs).toBe(THAT_DAY);
        expect(fs.readFileSync(goneFile(dir, ghost.id), "utf8")).toBe("delivered");
      };
      finished();
      expect(lines.filter((line) => /"level":"error"/.test(line))).toEqual([]);
      const text = statsText(dir);
      restarted(dir, () => NOON + 2 * MINUTE);
      finished();
      expect(statsText(dir)).toBe(text);
    });
  }

  it("stopped between the mark on its record and the writing of the totals: the swap is left out of the totals, as any order's would be, never put in twice, and its record still goes", () => {
    const dir = tempDir();
    const store = createOrderStore(dir, { now: () => NOON });
    const ghost = stored(1, { ghost: true });
    const beside = stored(2);
    for (const record of [ghost, beside]) {
      store.create(record);
      store.saveState(record.id, ended(record));
      // Marked as counted, and the server stops before the totals are written.
      expect(store.markCounted(record.id)).toBe(true);
    }
    for (let i = 0; i < 2; i++) {
      restarted(dir, () => NOON + (i + 1) * MINUTE);
      expect(statsFile(dir)).toMatchObject({ swaps: 0, volumeMicro: "0", rows: [] });
      expect(fs.readdirSync(path.join(dir, "orders"))).toEqual([`${beside.id}.json`]);
      expect(fs.readdirSync(goneDir(dir))).toEqual([sha(ghost.id)]);
      // Its points were written all the same.
      expect(createRewards(dir).entriesFor(ghost.rewardsAddress!)).toHaveLength(1);
    }
  });

  it("a step that fails while the server keeps running leaves the record where it is, and the next clean-up pass finishes the job: counted once, points written once, record gone", async () => {
    for (const step of ["count", "totals file", "points", "deletion"] as const) {
      const h = await start();
      const order = await ghostly(h, { rewardsAddress: WHO.rewards });
      const broken = new Error("the disk would not take the write");
      const mend: Array<() => void> = [];
      if (step === "count") {
        const real = h.store.markCounted.bind(h.store);
        h.store.markCounted = () => {
          throw broken;
        };
        mend.push(() => (h.store.markCounted = real));
      } else if (step === "totals file") {
        // The file of totals cannot be put in place: a folder stands where it goes. The swap is marked as counted, and added up in memory, and the write fails.
        const file = path.join(h.dataDir, "stats", "stats.json");
        fs.rmSync(file, { force: true });
        fs.mkdirSync(file);
        mend.push(() => fs.rmdirSync(file));
      } else if (step === "points") {
        const real = h.rewards.recordDelivered.bind(h.rewards);
        h.rewards.recordDelivered = (record) => {
          if (record.state.status !== "delivered") return real(record);
          throw broken;
        };
        mend.push(() => (h.rewards.recordDelivered = real));
      } else {
        const real = h.store.wipe.bind(h.store);
        h.store.wipe = () => {
          throw broken;
        };
        mend.push(() => (h.store.wipe = real));
      }
      await deliver(h, order);
      // Nothing was deleted ahead of the step that failed: the record is whole, and the order's page still shows it.
      expect(statusOf(h, order.id), step).toBe("delivered");
      expect(fs.existsSync(orderFile(h.dataDir, order.id)), step).toBe(true);
      expect(fs.existsSync(goneFile(h.dataDir, order.id)), step).toBe(false);
      expect((await h.get(`/api/orders/${order.id}`)).body, step).toMatchObject({ id: order.id, status: "delivered", ghost: true });
      const event = step === "count" || step === "totals file" ? "stats_not_counted" : step === "points" ? "points_not_recorded" : "record_not_deleted";
      const logged = () => h.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === event);
      expect(logged(), step).toEqual([expect.objectContaining({ level: "error", order: hashId(order.id), error: "Error" })]);
      // While the fault lasts, a clean-up pass tries again, says so again, and deletes nothing.
      await h.sweep();
      expect(logged(), step).toHaveLength(2);
      expect(fs.existsSync(orderFile(h.dataDir, order.id)), step).toBe(true);
      expect(fs.existsSync(goneFile(h.dataDir, order.id)), step).toBe(false);
      // It is still not found from its deposit address.
      expect((await h.post("/api/track", { depositAddress: order.depositAddress }, { session: await h.session() })).status, step).toBe(404);

      for (const undo of mend) undo();
      await h.sweep();
      expect(statusOf(h, order.id), step).toBeNull();
      expect((await h.get(`/api/orders/${order.id}`)).body, step).toEqual(gone("delivered"));
      expect(statsFile(h.dataDir), step).toMatchObject({ swaps: 1, volumeMicro: "12500000", rows: [] });
      expect(((await h.get("/api/stats")).body as StatsResponse).totals.swaps, step).toBe(1);
      expect(h.rewards.entriesFor(WHO.rewards), step).toHaveLength(1);
      expect(fs.readdirSync(entriesDir(h.dataDir)), step).toEqual([`${sha(order.id)}.json`]);
      // And nothing is left to try: a further pass changes nothing and says nothing.
      const said = h.logs.length;
      await h.sweep();
      expect(h.logs.length, step).toBe(said);
    }
  });

  it("at a start the swap is in the totals on disk before the record goes, though the totals of the other orders are written once at the end", () => {
    const dir = tempDir();
    const before = createOrderStore(dir, { now: () => NOON });
    const records = [stored(1), stored(2, { ghost: true }), stored(3)];
    for (const record of records) {
      before.create(record);
      before.saveState(record.id, ended(record));
    }
    // The start, with the same parts the server starts with, and a look at the disk each time a record is asked to go.
    const store: OrderStore = createOrderStore(dir, { now: () => NOON });
    const stats = createStats(dir, { now: () => NOON });
    const settler = createSettler({ store, stats, rewards: createRewards(dir), log: silentLogger });
    const real = store.wipe.bind(store);
    const seen: number[] = [];
    store.wipe = (id) => {
      // Before it goes, this very swap is on disk as counted, and marked so on its own record.
      seen.push(fs.existsSync(path.join(dir, "stats", "stats.json")) ? statsFile(dir).swaps : 0);
      expect((JSON.parse(fs.readFileSync(orderFile(dir, id), "utf8")) as OrderRecord).statsCounted).toBe(true);
      return real(id);
    };
    for (const id of store.ids().sort()) expect(settler.settle(store.get(id)!, false)).toBe(id === idOf(2));
    expect(seen).toEqual([2]);
    stats.save();
    expect(statsFile(dir)).toMatchObject({ v: 3, swaps: 3 });
    expect(statsFile(dir).rows).toHaveLength(2);
  });
});

describe("an ordinary order beside a Ghost one is untouched by all of it", () => {
  it("it is listed, its record is kept its 30 days, it is found by its ID and by its deposit address, and its points are written, while the Ghost order beside it is gone", async () => {
    // The Stats page is off here, so that a delivered order is still found from its deposit address.
    const h = await start({ env: { STATS_PAGE: "off" }, limits: { orderCreate: ROOMY, orderPerRecipient: ROOMY } });
    const ghost = await ghostly(h, { rewardsAddress: WHO.rewards });
    const plain = await plainly(h, { rewardsAddress: ADDR.evm3 }, "198.51.100.2");
    await deliver(h, ghost);
    await deliver(h, plain);
    const whole = async () => {
      const { session } = await muchLater(h);
      const record = h.store.get(plain.id)!;
      expect(record.state.status).toBe("delivered");
      expect(record.ghost).toBeUndefined();
      expect(fs.existsSync(orderFile(h.dataDir, plain.id))).toBe(true);
      expect(fs.readFileSync(indexFile(h.dataDir, plain.depositAddress!), "utf8")).toBe(plain.id);
      const read = await h.get(`/api/orders/${plain.id}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ id: plain.id, status: "delivered", recipient: WHO.recipient, rewardsAddress: ADDR.evm3 });
      expect("ghost" in read.body).toBe(false);
      expect((await h.post("/api/track", { depositAddress: plain.depositAddress }, { session })).body).toEqual({ id: plain.id });
      expect(h.stats.view().feed.map((row) => row.amount)).toEqual([plain.amountIn]);
      expect(h.rewards.entriesFor(ADDR.evm3)).toHaveLength(1);
    };
    await whole();
    expect(statusOf(h, ghost.id)).toBeNull();
    expect(h.stats.view().totals.swaps).toBe(2);
    expect(fs.existsSync(goneFile(h.dataDir, plain.id))).toBe(false);

    // Twenty-nine days and many clean-up passes later it is all still there.
    h.clock.t += 29 * DAY;
    await h.sweep();
    await h.poller.tick();
    await whole();
    // Past its 30 days it goes as it always did: its ID is then one that never was, with no fingerprint left of it.
    h.clock.t += 2 * DAY;
    expect(await h.sweep()).toBe(1);
    expect(fs.readdirSync(path.join(h.dataDir, "orders"))).toEqual([]);
    const gone = await h.get(`/api/orders/${plain.id}`);
    expect([gone.status, gone.text]).toEqual([404, NEVER]);
    expect(fs.readdirSync(goneDir(h.dataDir))).toEqual([]);
    // Its points and both swaps in the totals stay.
    expect(h.rewards.entriesFor(ADDR.evm3)).toHaveLength(1);
    expect(h.rewards.entriesFor(WHO.rewards)).toHaveLength(1);
    expect(h.stats.view().totals.swaps).toBe(2);
  });
});

describe("the clean-up pass and the limits", () => {
  it("the server's own pass, as it is started, removes the fingerprints that are 30 days old and finishes a Ghost order that was left on disk", async () => {
    const dir = tempDir();
    let clock = NOON;
    const b = restarted(dir, () => clock);
    // The folder for fingerprints is there from the first start, and only the server can read it.
    for (const folder of [path.join(dir, "ghost"), goneDir(dir)]) expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    const old = sha(idOf(1));
    const young = sha(idOf(2));
    fs.writeFileSync(path.join(goneDir(dir), old), "");
    fs.writeFileSync(path.join(goneDir(dir), young), "");
    fs.utimesSync(path.join(goneDir(dir), old), (NOON - 30 * DAY) / 1000, (NOON - 30 * DAY) / 1000);
    fs.utimesSync(path.join(goneDir(dir), young), (NOON - 30 * DAY + 1000) / 1000, (NOON - 30 * DAY + 1000) / 1000);
    await b.sweep();
    expect(fs.readdirSync(goneDir(dir))).toEqual([young]);
    // The server's clock is the one that counts the 30 days.
    clock = NOON + 1000;
    await b.sweep();
    expect(fs.readdirSync(goneDir(dir))).toEqual([]);
  });

  it("a limit lets go of a key at once only when told to, and of that key alone", () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 2, windowMs: 60_000 }, () => t);
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a"), limiter.take("b")]).toEqual([true, true, false, true]);
    limiter.forget("a");
    expect(limiter.size).toBe(1);
    expect(limiter.remaining("b")).toBe(1);
    expect(limiter.take("a")).toBe(true);
    limiter.forget("never held");
    expect(limiter.size).toBe(2);
    t = 61_000;
    expect(limiter.remaining("b")).toBe(2);
  });

  it("the count of orders to a receiving address outlives a Ghost order that has finished: the mode lifts no limit", async () => {
    const h = await start({ limits: { orderCreate: ROOMY, orderPerRecipient: { max: 2, windowMs: 3_600_000 } } });
    for (let i = 0; i < 2; i++) {
      const order = await ghostly(h);
      await deliver(h, order);
      expect(statusOf(h, order.id)).toBeNull();
    }
    const third = await h.order({ ...SWAP, ghost: true });
    expect([third.status, outcome(third)]).toEqual([429, "rate_limited"]);
    // What is held for that count is one key, and it is not the address: nothing is counted under the address in any spelling.
    expect(h.limiters.orderPerRecipient.size).toBe(1);
    for (const spelling of [WHO.recipient, WHO.recipient.toLowerCase()]) expect(h.limiters.orderPerRecipient.remaining(`arb:${spelling}`), spelling).toBe(2);
    // When its hour has ended the count goes, as any does.
    h.clock.t += 3_600_000;
    expect((await h.order({ ...SWAP, ghost: true }, await muchLater(h))).status).toBe(201);
  });
});

describe("in practice mode it all works with the sample provider", () => {
  /** Starts a server and waits for it to listen, on any port that is free. */
  const listen = (booted: Booted) =>
    new Promise<AddressInfo>((resolve) => {
      const { server } = booted;
      const really = server.listen.bind(server) as (port: number, host: string | undefined, listening: () => void) => unknown;
      server.listen = ((_asked: number, host: string | undefined, listening: () => void) => {
        really(0, host, listening);
        return server;
      }) as typeof server.listen;
      booted.start(() => resolve(server.address() as AddressInfo));
    });

  it("a Ghost order made on a practice server is paid with the practice control, delivered, counted with no row, and wiped: its page is then told only that it finished, and how", async () => {
    const dir = tempDir();
    // A screening list on disk, read as the server starts: nothing outside the machine is reached.
    let clock = NOON;
    fs.mkdirSync(path.join(dir, "sanctions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sanctions", "sdn-addresses.json"), JSON.stringify({ publishDate: "2026-10-07", fetchedAt: NOON, addresses: Array.from({ length: 320 }, (_, i) => address(`listed ${i}`)) }));
    const lines: string[] = [];
    const b = started(dir, { NODE_ENV: "development", PROVIDER_STUB: "true", PORT: "24680" }, () => clock, lines);
    expect(b.practice).toBe(true);
    const base = `http://127.0.0.1:${(await listen(b)).port}`;
    const get = async (route: string) => {
      const reply = await fetch(`${base}${route}`);
      return { status: reply.status, body: (await reply.json()) as Record<string, unknown> };
    };
    const session = String((await get("/api/config")).body.session);
    const post = async (route: string, body: unknown) => {
      const reply = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", origin: base, "x-session": session }, body: JSON.stringify(body) });
      return { status: reply.status, body: (await reply.json()) as Record<string, any> };
    };
    const before = (await get("/api/stats")).body as unknown as StatsResponse;

    const swap = { from: ASSET.baseEth, to: ASSET.arbUsdc, amount: "5000000000000000", pay: "wallet", ...SWAP };
    const preview = (await post("/api/quote", swap)).body as QuoteView;
    const made = await post("/api/orders", { ...swap, ghost: true, termsVersion: TERMS_VERSION, termsAccepted: true, reviewed: { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: preview.fees.appBps + preview.fees.providerBps, routing: preview.routing } });
    expect(made.status).toBe(201);
    const order = made.body as OrderView;
    expect(order).toMatchObject({ status: "waiting", ghost: true });
    expect(fs.existsSync(orderFile(dir, order.id))).toBe(true);
    // It is not found from its deposit address on a practice server either.
    expect((await post("/api/track", { depositAddress: order.depositAddress })).status).toBe(404);

    // Paid with the practice control; half a minute on, the practice provider reports it delivered, and the server's own poller sees that.
    expect((await post(`/api/practice/${order.id}`, { action: "deposit" })).body).toEqual({ ok: true });
    clock += 30_000;
    await eventually(() => !fs.existsSync(orderFile(dir, order.id)));

    const after = await get(`/api/orders/${order.id}`);
    expect([after.status, after.body]).toEqual([410, gone("delivered")]);
    expect(fs.readFileSync(goneFile(dir, order.id), "utf8")).toBe("delivered");
    expect((await post("/api/track", { depositAddress: order.depositAddress })).status).toBe(404);
    expect((await post(`/api/practice/${order.id}`, { action: "deposit" })).status).toBe(404);
    expect(fs.existsSync(indexFile(dir, order.depositAddress!))).toBe(false);
    expect(fs.readdirSync(goneDir(dir))).toEqual([sha(order.id)]);
    expect(fs.statSync(goneFile(dir, order.id)).mtimeMs).toBe(THAT_DAY);
    // Counted in the totals, beside the sample swaps, and in no row.
    const stats = (await get("/api/stats")).body as unknown as StatsResponse;
    expect(stats.totals.swaps).toBe(before.totals.swaps + 1);
    expect(stats.feed).toEqual(before.feed);
    // The sample orders are no Ghost orders, and are all still there.
    expect(fs.readdirSync(path.join(dir, "orders")).filter((name) => name.startsWith("SampleOrder"))).toHaveLength(6);
    // And the server's own log and access log say nothing of it but its hashed ID. (The access log is written a moment after each answer.)
    const accessLog = () => everyFile(path.join(dir, "logs")).map((file) => file.text).join("\n");
    await eventually(() => /"route":"order_read","method":"GET","status":410/.test(accessLog()));
    const logged = `${lines.join("\n")}\n${accessLog()}`;
    expect(logged).toMatch(new RegExp(`"route":"order_create","method":"POST","status":201[^\n]*"order":"${hashId(order.id)}","screening":"clear"}`));
    for (const value of [order.id, order.depositAddress!, WHO.sender, WHO.recipient, WHO.refundTo, sha(order.id)]) expect(carries(logged, value), value).toBe(false);
    expect(logged).toContain(hashId(order.id));
    expect(logged).not.toMatch(/"route":"order_(create|read)"[^\n]*"cid"/);
  });
});

// The clean-up pass the tests of a single part build for themselves is the one the server builds.
describe("the parts are wired as the server wires them", () => {
  it("a clean-up pass with nothing of Ghost mode given to it still deletes old records, and one given a part that fails says so and goes on", async () => {
    const h = await start();
    const order = await plainly(h);
    await deliver(h, order);
    h.clock.t += FINISHED_RETENTION_MS + DAY;
    const lines: string[] = [];
    const bare = createSweeper({ store: h.store, poller: h.poller, log: createLogger((line) => lines.push(line)), now: () => h.clock.t, settler: { tidy: () => { throw new Error("no"); } } });
    expect(await bare()).toBe(1);
    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual(["ghost_tidy_failed", "orders_swept"]);
    expect(fs.existsSync(orderFile(h.dataDir, order.id))).toBe(false);
  });
});
