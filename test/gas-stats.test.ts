// "Add gas" in the site's totals and in the record of points. A delivered gas order adds its
// dollars wherever dollars are summed, and its points to the rewards address, once. It is not a
// swap: it adds to no count of swaps, has no row among the recent swaps and no delivery time, and
// a chain that only a gas order was sent from is not yet a chain a swap was sent from.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toChecksumAddress } from "../shared/addresses.ts";
import type { CoinRef, OrderStatus, OrderView, StatsResponse } from "../shared/api.ts";
import { pointsMicro, weekOf } from "../shared/rewards.ts";
import { gasIdOf } from "../server/gas.ts";
import { silentLogger } from "../server/log.ts";
import { createRewards, orderHash } from "../server/rewards.ts";
import { createSettler } from "../server/settle.ts";
import { createStats, type Stats, type StatsFile } from "../server/stats.ts";
import { createOrderStore, type OrderRecord, type OrderState, type OrderStore } from "../server/store.ts";
import { asOrder, ASSET, harness, putMined, type Harness, type HarnessOptions } from "./helpers.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Noon on a Thursday. */
const NOON = Date.parse("2026-10-08T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// Everything an order holds is made up from fixed text: nobody's.
const made = (label: string, bytes: number) => sha(`gas stats test ${label}`).slice(0, bytes * 2);
const address = (label: string) => toChecksumAddress(`0x${made(label, 20)}`);

const ETH: CoinRef = { id: "nep141:base.omft.near", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null };
const USDC: CoinRef = { id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", symbol: "USDC", name: "USD Coin", chain: "arb", decimals: 6, contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" };
/** Ether on Arbitrum: what a gas order beside a swap to Arbitrum delivers. */
const ETH_ARB: CoinRef = { id: "nep141:arb.omft.near", symbol: "ETH", name: "Ethereum", chain: "arb", decimals: 18, contract: null };
const USDT_SOL: CoinRef = { id: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", symbol: "USDT", name: "Tether USD", chain: "sol", decimals: 6, contract: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" };
const SOL: CoinRef = { id: "nep141:sol.omft.near", symbol: "SOL", name: "Solana", chain: "sol", decimals: 9, contract: null };

interface Made {
  usd?: string;
  from?: CoinRef;
  to?: CoinRef;
  /** How long before its delivery the order was made, in seconds. */
  took?: number;
  gasOrder?: true;
  ghost?: true;
}
const orderId = (n: number) => `GasStatsOrder${String(n).padStart(14, "0")}`;

/** An order as it is made: waiting, with every field a real one has. A gas order is one with the mark, and is otherwise an order like any other. */
function order(n: number, createdAt: number, how: Made = {}): OrderRecord {
  return {
    v: 1,
    id: orderId(n),
    createdAt: iso(createdAt),
    pay: "wallet",
    from: how.from ?? ETH,
    to: how.to ?? (how.gasOrder === true ? ETH_ARB : USDC),
    amountIn: String(100_000_000_000_000_000n + BigInt(n) * 1_000_000_007n),
    amountOut: String(249_000_000n + BigInt(n)),
    minAmountOut: String(246_000_000n + BigInt(n)),
    amountInUsd: how.usd ?? (how.gasOrder === true ? "3" : "250"),
    amountOutUsd: "248.7",
    slippageBps: 100,
    timeEstimate: 30,
    fees: { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "200000000000000" },
    withdrawFee: null,
    refundFee: null,
    recipient: address(`recipient ${n}`),
    refundTo: address(`refund ${n}`),
    sender: address(`sender ${n}`),
    rewardsAddress: address(`rewards ${n}`),
    confidentiality: "basic",
    depositAddress: address(`deposit ${n}`),
    depositMemo: null,
    deadline: iso(createdAt + 30 * MINUTE),
    termsVersion: "test",
    screening: { result: "clear", listVersion: "test", checkedAt: iso(createdAt) },
    quoteResponse: { quote: { depositAddress: address(`deposit ${n}`) }, signature: `ed25519:${made(`signature ${n}`, 32)}` },
    ...(how.gasOrder === true ? { gasOrder: true as const } : {}),
    ...(how.ghost === true ? { ghost: true as const } : {}),
    state: { status: "waiting", upstreamStatus: "PENDING_DEPOSIT", statusSince: iso(createdAt), updatedAt: iso(createdAt), anchor: createdAt, depositTxHash: null, depositVerified: false, depositForwarded: false, details: null, finishedAt: null, stopped: false, slowAlertSent: false },
  };
}
/** The transaction that paid an order's deposit. */
const depositOf = (record: OrderRecord) => `0x${made(`paid ${record.id}`, 32)}`;
/** The same order's state once it has ended, as the poller writes it. */
function ended(record: OrderRecord, at: number, status: OrderStatus = "delivered"): OrderState {
  const paid = depositOf(record);
  const unpaid = status === "expired";
  return {
    ...record.state,
    status,
    upstreamStatus: status === "delivered" ? "SUCCESS" : status === "refunded" ? "REFUNDED" : "PENDING_DEPOSIT",
    statusSince: iso(at),
    updatedAt: iso(at),
    depositTxHash: unpaid ? null : paid,
    depositVerified: !unpaid,
    depositForwarded: !unpaid,
    details: unpaid ? null : { originTxs: [{ hash: paid, url: null }], destinationTxs: [], depositedAmount: record.amountIn, amountIn: record.amountIn, amountOut: status === "delivered" ? record.amountOut : null, refundedAmount: status === "refunded" ? record.amountIn : null, refundReason: null },
    finishedAt: iso(at),
  };
}

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-gas-stats-"));
  dirs.push(dir);
  return dir;
};
let open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.map((h) => h.close()));
  open = [];
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Site {
  dir: string;
  clock: { t: number };
  stats: Stats;
  store: OrderStore;
  /** Makes an order and ends it at the clock's time. Delivered unless told otherwise. */
  end(n: number, how?: Made, status?: OrderStatus): OrderRecord;
  view(): StatsResponse;
  file(): StatsFile;
  text(): string;
}
/**
 * The totals and the order store, wired as the server wires them. Given a folder that has been
 * used before, it is that server started again: every order on disk is put to the totals once more.
 */
function site(options: { dir?: string; t?: number; receivedMin?: number } = {}): Site {
  const dir = options.dir ?? tempDir();
  const clock = { t: options.t ?? NOON };
  const stats = createStats(dir, { now: () => clock.t, ...(options.receivedMin === undefined ? {} : { receivedMin: options.receivedMin }) });
  const store: OrderStore = createOrderStore(dir, { onState: (record) => void stats.recordDelivered(record, () => store.markCounted(record.id)) });
  for (const id of store.ids()) {
    const record = store.get(id);
    if (record !== null) stats.recordDelivered(record, () => store.markCounted(id), false);
  }
  stats.save();
  const text = () => fs.readFileSync(path.join(dir, "stats", "stats.json"), "utf8");
  return {
    dir,
    clock,
    stats,
    store,
    end(n, how = {}, status = "delivered") {
      const record = order(n, clock.t - (how.took ?? 40) * 1000, how);
      store.create(record);
      store.saveState(record.id, ended(record, clock.t, status));
      return store.get(record.id) as OrderRecord;
    },
    view: () => stats.view(),
    file: () => JSON.parse(text()) as StatsFile,
    text,
  };
}
const HOUR_OF_NOON = String(Math.floor(NOON / HOUR));
const base = (coin: string, volumeUsd: number) => ({ coin: { symbol: coin, chain: "base" }, volumeUsd });

describe("a delivered gas order adds its dollars, and is not a swap", () => {
  it("a delivered pair is one swap and one row, with the dollars of both orders in every sum of dollars", () => {
    const s = site();
    const swap = s.end(1, { usd: "250", took: 40 });
    const gas = s.end(2, { usd: "3", took: 70, gasOrder: true });
    const shown = s.view();
    // One swap, the dollars of both, and the time the swap took: the gas order's 70 seconds are in no average.
    expect(shown.totals).toEqual({ swaps: 1, volumeUsd: 253, volume24hUsd: 253, chains: 1, deliverySeconds: 40 });
    // Sent: both were paid with ETH on Base. Received: each order's own coin.
    expect(shown.coins).toEqual([base("ETH", 253)]);
    expect(shown.received).toEqual([{ coin: { symbol: "USDC", chain: "arb" }, volumeUsd: 250 }, { coin: { symbol: "ETH", chain: "arb" }, volumeUsd: 3 }]);
    // The chain they were sent from: one swap, and the volume of both.
    expect(shown.chains).toEqual([{ chain: "base", name: "Base", volumeUsd: 253 }]);
    expect(shown.chainsUsed).toEqual([{ chain: "base", swaps: 1, share: 100 }]);
    // One row, the swap's. Nothing of the gas order is in any row.
    expect(shown.feed).toEqual([expect.objectContaining({ amount: swap.amountIn, tx: depositOf(swap) })]);
    expect(JSON.stringify(shown.feed)).not.toContain(gas.amountIn);
    expect(JSON.stringify(shown) + s.text()).not.toContain(depositOf(gas).slice(2));
    // As it is kept.
    expect(s.file()).toMatchObject({ swaps: 1, volumeMicro: "253000000", deliverySeconds: 40, deliveriesTimed: 1, chains: { base: { swaps: 1, volumeMicro: "253000000" } }, coins: [{ symbol: "ETH", chain: "base", volumeMicro: "253000000" }], hours: { [HOUR_OF_NOON]: { swaps: 1, volumeMicro: "253000000" } } });
    expect(s.file().rows).toHaveLength(1);
    expect(s.text()).not.toContain("gasOnly");
    // Each of the two is marked as counted on its own record.
    expect([s.store.get(swap.id)?.statsCounted, s.store.get(gas.id)?.statsCounted]).toEqual([true, true]);

    // In the other order, gas first: the same figures.
    const other = site();
    other.end(2, { usd: "3", took: 70, gasOrder: true });
    other.end(1, { usd: "250", took: 40 });
    expect(other.view()).toEqual(shown);
    expect(other.text()).not.toContain("gasOnly");
  });

  it("a gas order alone adds its dollars and nothing else: no swap, no row, no delivery time, and its chain is not a chain a swap was sent from", () => {
    const s = site();
    const gas = s.end(1, { usd: "3", gasOrder: true });
    const shown = s.view();
    expect(shown.totals).toEqual({ swaps: 0, volumeUsd: 3, volume24hUsd: 3, chains: 0, deliverySeconds: null });
    expect(shown.coins).toEqual([base("ETH", 3)]);
    expect(shown.feed).toEqual([]);
    // No chain is listed as used, in either list of chains: no swap was sent from Base yet.
    expect(shown.chainsUsed).toEqual([]);
    expect(shown.chains).toEqual([]);
    // The coins received are shown once a swap has been delivered, and none has.
    expect(shown.received).toBeNull();
    // The dollars are kept for its chain, with the mark that only gas orders were sent from it, and for its hour, with no swap.
    expect(s.file()).toMatchObject({ swaps: 0, volumeMicro: "3000000", deliverySeconds: 0, deliveriesTimed: 0, rows: [], chains: { base: { swaps: 0, volumeMicro: "3000000", gasOnly: true } }, hours: { [HOUR_OF_NOON]: { swaps: 0, volumeMicro: "3000000" } }, received: [{ symbol: "ETH", chain: "arb", volumeMicro: "3000000" }] });
    expect(s.store.get(gas.id)?.statsCounted).toBe(true);

    // A second gas order from the same chain: more dollars, still no swap and no chain.
    s.end(2, { usd: "5", gasOrder: true });
    expect(s.view()).toMatchObject({ totals: { swaps: 0, volumeUsd: 8, chains: 0, deliverySeconds: null }, chainsUsed: [], chains: [], feed: [] });
    expect(s.file().chains).toEqual({ base: { swaps: 0, volumeMicro: "8000000", gasOnly: true } });

    // The first swap sent from that chain makes it a chain that was used, with everything sent from it in its volume.
    const swap = s.end(3, { usd: "250" });
    expect(s.view()).toMatchObject({ totals: { swaps: 1, volumeUsd: 258, chains: 1, deliverySeconds: 40 }, chainsUsed: [{ chain: "base", swaps: 1, share: 100 }], chains: [{ chain: "base", name: "Base", volumeUsd: 258 }], feed: [{ amount: swap.amountIn }] });
    expect(s.file().chains).toEqual({ base: { swaps: 1, volumeMicro: "258000000" } });
    expect(s.view().received).toEqual([{ coin: { symbol: "USDC", chain: "arb" }, volumeUsd: 250 }, { coin: { symbol: "ETH", chain: "arb" }, volumeUsd: 8 }]);
  });

  it("a gas order sent from a chain no swap was sent from leaves the chains that were used as they are, and its dollars are in the total they are shares of", () => {
    const s = site();
    s.end(1, { usd: "250" });
    // Paid with USDT on Solana, for SOL: nobody has swapped from Solana.
    s.end(2, { usd: "10", gasOrder: true, from: USDT_SOL, to: SOL });
    const shown = s.view();
    expect(shown.totals).toMatchObject({ swaps: 1, volumeUsd: 260, chains: 1 });
    expect(shown.chainsUsed).toEqual([{ chain: "base", swaps: 1, share: 96 }]);
    expect(shown.chains).toEqual([{ chain: "base", name: "Base", volumeUsd: 250 }]);
    expect(shown.totals.chains).toBe(shown.chainsUsed.length);
    // The coin it sent is among the coins sent, by its dollars.
    expect(shown.coins).toEqual([base("ETH", 250), { coin: { symbol: "USDT", chain: "sol" }, volumeUsd: 10 }]);
    expect(s.file().chains).toEqual({ base: { swaps: 1, volumeMicro: "250000000" }, sol: { swaps: 0, volumeMicro: "10000000", gasOnly: true } });
    // A gas order sent from a chain that is used adds to that chain's volume and to nothing that counts.
    s.end(3, { usd: "3", gasOrder: true });
    expect(s.view().chainsUsed).toEqual([{ chain: "base", swaps: 1, share: 96 }]);
    expect(s.file().chains.base).toEqual({ swaps: 1, volumeMicro: "253000000" });
  });

  it("only a delivered gas order adds anything: one that was refunded, or ran out, adds nothing at all", () => {
    const s = site();
    s.end(1, { gasOrder: true }, "refunded");
    s.end(2, { gasOrder: true }, "expired");
    expect(s.view()).toMatchObject({ totals: { swaps: 0, volumeUsd: 0, chains: 0 }, coins: [], feed: [] });
    expect(s.file().chains).toEqual({});
  });

  it("a gas order is counted once: not at a second saving of its state, not from a copy that is not marked, and not after a restart", () => {
    const s = site();
    s.end(1, { usd: "250" });
    const gas = s.end(2, { usd: "3", gasOrder: true });
    s.store.saveState(gas.id, { ...gas.state, updatedAt: iso(s.clock.t + 1000) });
    const { statsCounted: _mark, ...unmarked } = gas;
    expect(s.stats.recordDelivered(unmarked, () => s.store.markCounted(gas.id))).toBe(false);
    const shown = s.view();
    expect(shown.totals).toMatchObject({ swaps: 1, volumeUsd: 253 });
    // Started again on the same folder, and again: the same figures, and the same file to the letter.
    const text = s.text();
    for (let start = 0; start < 2; start++) {
      const again = site({ dir: s.dir });
      expect(again.view()).toEqual(shown);
      expect(again.text()).toBe(text);
    }
  });

  it("after a restart a chain that only gas orders were sent from is still not listed, and a gas delivery saved a moment before the stop is counted as what it is", () => {
    const s = site();
    s.end(1, { usd: "3", gasOrder: true });
    const again = site({ dir: s.dir });
    expect(again.view()).toEqual(s.view());
    expect(again.view()).toMatchObject({ totals: { swaps: 0, volumeUsd: 3, chains: 0 }, chainsUsed: [], chains: [], feed: [] });
    expect(again.file().chains).toEqual({ base: { swaps: 0, volumeMicro: "3000000", gasOnly: true } });

    // Delivered, saved, and never told to the totals: the next start counts it, as a gas order and not as a swap.
    const missed = order(2, NOON + MINUTE, { usd: "5", gasOrder: true });
    fs.writeFileSync(path.join(s.dir, "orders", `${missed.id}.json`), JSON.stringify({ ...missed, state: ended(missed, NOON + 2 * MINUTE) }));
    const swap = order(3, NOON + MINUTE, { usd: "250" });
    fs.writeFileSync(path.join(s.dir, "orders", `${swap.id}.json`), JSON.stringify({ ...swap, state: ended(swap, NOON + 2 * MINUTE) }));
    const third = site({ dir: s.dir, t: NOON + 5 * MINUTE });
    expect(third.view()).toMatchObject({ totals: { swaps: 1, volumeUsd: 258, chains: 1 }, chainsUsed: [{ chain: "base", swaps: 1, share: 100 }], feed: [{ amount: swap.amountIn }] });
    expect(third.view().feed).toHaveLength(1);
    expect(site({ dir: s.dir, t: NOON + 6 * MINUTE }).view()).toEqual(third.view());
  });

  it("the one repair at a start, of a file from before rows were kept as long as their orders, gives a counted gas order no row and counts it for no chain", () => {
    const dir = tempDir();
    const store = createOrderStore(dir);
    const swap = order(1, NOON - 40_000, { usd: "250" });
    const gas = order(2, NOON - 40_000, { usd: "3", gasOrder: true });
    for (const record of [swap, gas]) {
      store.create(record);
      store.saveState(record.id, ended(record, NOON));
      expect(store.markCounted(record.id)).toBe(true);
    }
    // Both were counted when they were delivered: the totals hold the dollars of both and one swap. The file has no rows, and its chain has no swap counted.
    fs.mkdirSync(path.join(dir, "stats"), { recursive: true });
    fs.writeFileSync(path.join(dir, "stats", "stats.json"), JSON.stringify({ v: 2, swaps: 1, volumeMicro: "253000000", deliverySeconds: 40, deliveriesTimed: 1, chains: { base: { swaps: 0, volumeMicro: "253000000" } }, coins: [{ symbol: "ETH", chain: "base", volumeMicro: "253000000" }], hours: {}, rows: [] }));
    const s = site({ dir, t: NOON + HOUR });
    const shown = s.view();
    // The swap has its row back and is counted for its chain. The gas order has neither.
    expect(shown.feed).toEqual([expect.objectContaining({ amount: swap.amountIn })]);
    expect(shown.chainsUsed).toEqual([{ chain: "base", swaps: 1, share: 100 }]);
    expect(shown.totals).toMatchObject({ swaps: 1, volumeUsd: 253, chains: 1, deliverySeconds: 40 });
    expect(s.file()).toMatchObject({ v: 3, swaps: 1, volumeMicro: "253000000", chains: { base: { swaps: 1, volumeMicro: "253000000" } } });
    expect(s.file().rows).toHaveLength(1);
    // Started again: nothing moves.
    const text = s.text();
    expect(site({ dir, t: NOON + HOUR }).text()).toBe(text);

    // The same repair where the gas order is all there is on disk: no row, no count, and the file is as it was but for saying it has been gone through.
    const alone = tempDir();
    const only = createOrderStore(alone);
    const lone = order(3, NOON - 40_000, { usd: "3", gasOrder: true });
    only.create(lone);
    only.saveState(lone.id, ended(lone, NOON));
    only.markCounted(lone.id);
    fs.mkdirSync(path.join(alone, "stats"), { recursive: true });
    fs.writeFileSync(path.join(alone, "stats", "stats.json"), JSON.stringify({ v: 2, swaps: 1, volumeMicro: "3000000", deliverySeconds: 0, deliveriesTimed: 0, chains: { base: { swaps: 0, volumeMicro: "3000000" } }, coins: [], hours: {}, rows: [] }));
    expect(site({ dir: alone, t: NOON + HOUR }).file()).toMatchObject({ v: 3, swaps: 1, chains: { base: { swaps: 0, volumeMicro: "3000000" } }, rows: [] });
  });

  it("a gas order made in Ghost mode is in the dollar sums and nowhere else, like any gas order; beside its Ghost swap, the pair is one swap and no row", () => {
    const s = site();
    s.end(1, { usd: "3", gasOrder: true, ghost: true });
    expect(s.view()).toMatchObject({ totals: { swaps: 0, volumeUsd: 3, chains: 0, deliverySeconds: null }, feed: [], chainsUsed: [] });
    s.end(2, { usd: "250", ghost: true });
    expect(s.view()).toMatchObject({ totals: { swaps: 1, volumeUsd: 253, chains: 1, deliverySeconds: 40 }, feed: [], chainsUsed: [{ chain: "base", swaps: 1, share: 100 }] });
    expect(s.file().rows).toEqual([]);
    expect(site({ dir: s.dir }).view()).toEqual(s.view());
  });

  it("the mark that only gas orders were sent from a chain is read from the file as it is written, and as nothing else", () => {
    const write = (chains: Record<string, unknown>) => {
      const dir = tempDir();
      fs.mkdirSync(path.join(dir, "stats"), { recursive: true });
      fs.writeFileSync(path.join(dir, "stats", "stats.json"), JSON.stringify({ v: 3, swaps: 2, volumeMicro: "9000000", deliverySeconds: 0, deliveriesTimed: 0, chains, coins: [], hours: {}, rows: [] }));
      return createStats(dir, { now: () => NOON });
    };
    // A chain with swaps counted for it is a chain that was used, whatever the mark says.
    expect(write({ base: { swaps: 2, volumeMicro: "9000000", gasOnly: true } }).view().chainsUsed).toEqual([{ chain: "base", swaps: 2, share: 100 }]);
    // A chain of a file from before there were gas orders has no mark, and is used: also one that no swap is counted for.
    expect(write({ base: { swaps: 0, volumeMicro: "9000000" } }).view().chainsUsed).toEqual([{ chain: "base", swaps: 0, share: 100 }]);
    expect(write({ base: { swaps: 0, volumeMicro: "9000000", gasOnly: true } }).view()).toMatchObject({ chainsUsed: [], chains: [], totals: { chains: 0, volumeUsd: 9 } });
    // Anything else in its place is not this file: it is set aside, and not read as a guess.
    for (const odd of [false, "true", 1, null]) expect(write({ base: { swaps: 0, volumeMicro: "9000000", gasOnly: odd } }).setAside, JSON.stringify(odd)).toBe(true);
  });
});

describe("on the running server: volume and points are counted once for each order of a pair", () => {
  const WHO = { sender: address("sender"), recipient: address("recipient"), refundTo: address("refund"), rewards: address("rewards") };
  const PEOPLE = { sender: WHO.sender, recipient: WHO.recipient, refundTo: WHO.refundTo };
  const SWAP_AMOUNT = "5000000000000000";
  const GAS_AMOUNT = "1200000000000000";
  async function start(options: HarnessOptions = {}): Promise<Harness> {
    const h = await harness({ ...options, env: { PRIVACY_MODE: "basic", ...options.env } });
    open.push(h);
    return h;
  }
  /** A swap with gas, as the page asks for one, with the swap's points going to a rewards address. */
  async function pair(h: Harness, extra: Record<string, unknown> = {}): Promise<OrderView> {
    const session = await h.session();
    const preview = (await h.post("/api/gas", { from: ASSET.baseEth, to: ASSET.arbUsdc, pay: "wallet", ...PEOPLE }, { session })).body.gas.quote;
    const gas = { amount: preview.amountIn, reviewed: { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: preview.fees.appBps + preview.fees.providerBps, routing: preview.routing } };
    return asOrder(await h.order({ ...PEOPLE, rewardsAddress: WHO.rewards, gas, ...extra }));
  }
  async function step(h: Harness, id: string, ms: number): Promise<void> {
    h.clock.t += ms;
    h.poller.nudge(id);
    await h.poller.tick();
  }
  /** Paid from the wallet (so that the deposit's transaction is known to this server) and delivered. */
  async function payAndDeliver(h: Harness, id: string, label: string): Promise<string> {
    const record = h.store.get(id) as OrderRecord;
    const hash = `0x${made(label, 32)}`;
    putMined(h.rpc, hash, { from: WHO.sender, to: record.depositAddress, value: `0x${BigInt(record.amountIn).toString(16)}`, input: "0x" });
    expect((await h.post(`/api/orders/${id}/deposit`, { txHash: hash }, { session: await h.session() })).status).toBe(200);
    await step(h, id, 5000);
    await step(h, id, 5000);
    await step(h, id, 15_000);
    return hash;
  }
  const entryFile = (h: Harness, id: string) => path.join(h.dataDir, "rewards", "entries", `${sha(id)}.json`);
  /** The server started again on the same folder: every order on disk is put to the totals and to the points once more, as at any start. */
  function startedAgain(h: Harness) {
    const rewards = createRewards(h.dataDir);
    const stats = createStats(h.dataDir, { now: () => h.clock.t });
    const store: OrderStore = createOrderStore(h.dataDir, { now: () => h.clock.t });
    const settler = createSettler({ store, stats, rewards, log: silentLogger });
    for (const id of store.ids()) {
      const record = store.get(id);
      if (record !== null) settler.settle(record, false);
    }
    stats.save();
    return { rewards, stats, store };
  }

  it("a pair made, paid and delivered: one swap and one row on the Stats page with the dollars of both, and the points of each order written once to the swap's rewards address", async () => {
    const h = await start();
    const order = await pair(h);
    const gasId = gasIdOf(order.id);
    const swapPaid = await payAndDeliver(h, order.id, "swap deposit");
    const gasPaid = await payAndDeliver(h, gasId, "gas deposit");
    expect([h.store.get(order.id), h.store.get(gasId)]).toMatchObject([{ state: { status: "delivered" }, statsCounted: true, gas: "made" }, { state: { status: "delivered" }, statsCounted: true, gasOrder: true }]);

    // The Stats page: 12.5 and 3 dollars, one swap, one row, which is the swap's.
    const reply = await h.get("/api/stats");
    const stats = reply.body as StatsResponse;
    expect(stats.totals).toMatchObject({ swaps: 1, volumeUsd: 15, volume24hUsd: 15, chains: 1 });
    expect(stats.coins).toEqual([base("ETH", 15)]);
    expect(stats.chainsUsed).toEqual([{ chain: "base", swaps: 1, share: 100 }]);
    expect(stats.feed).toEqual([{ coin: { symbol: "ETH", chain: "base", decimals: 18 }, amount: SWAP_AMOUNT, at: expect.any(String), tx: swapPaid }]);
    // Nothing of the gas order is listed: not its amount, and not its deposit's transaction.
    expect(reply.text).not.toContain(GAS_AMOUNT);
    expect(reply.text).not.toContain(gasPaid.slice(2));
    const file = JSON.parse(fs.readFileSync(path.join(h.dataDir, "stats", "stats.json"), "utf8")) as StatsFile;
    expect(file).toMatchObject({ swaps: 1, volumeMicro: "15500000", deliveriesTimed: 1, chains: { base: { swaps: 1, volumeMicro: "15500000" } } });
    expect(file.rows).toHaveLength(1);

    // The points: an entry for each order, each by its own value, both for the address the swap named.
    const entries = h.rewards.entriesFor(WHO.rewards);
    expect(entries.map((entry) => [entry.order, entry.volumeUsdMicro, entry.to.symbol, entry.to.chain]).sort()).toEqual(
      [[orderHash(order.id), "12500000", "USDC", "arb"], [orderHash(gasId), "3000000", "ETH", "arb"]].sort(),
    );
    expect(entries.every((entry) => entry.address === WHO.rewards && entry.reasons.length === 0)).toBe(true);
    expect(fs.readdirSync(path.join(h.dataDir, "rewards", "entries")).sort()).toEqual([`${sha(order.id)}.json`, `${sha(gasId)}.json`].sort());
    // Ten points to the dollar, on $15.50: 155 points, once.
    expect(h.rewards.weekPoints(weekOf(h.clock.t))).toEqual(new Map([[WHO.rewards, pointsMicro(15_500_000n)]]));
    expect(pointsMicro(15_500_000n)).toBe(155_000_000n);

    // Counted once, whatever is saved again afterwards, and after a restart.
    for (const id of [order.id, gasId]) {
      const record = h.store.get(id) as OrderRecord;
      h.store.saveState(id, { ...record.state, updatedAt: iso(h.clock.t + 1000) });
    }
    expect(((await h.get("/api/stats")).body as StatsResponse).totals).toMatchObject({ swaps: 1, volumeUsd: 15 });
    expect(h.rewards.entriesFor(WHO.rewards)).toHaveLength(2);
    const again = startedAgain(h);
    expect(again.stats.view()).toEqual((await h.get("/api/stats")).body);
    expect(again.rewards.entriesFor(WHO.rewards)).toHaveLength(2);
    expect(again.rewards.weekPoints(weekOf(h.clock.t))).toEqual(new Map([[WHO.rewards, 155_000_000n]]));
  });

  it("only the gas order is paid: its dollars and its points are counted, and there is no swap, no row and no chain used", async () => {
    const h = await start();
    const order = await pair(h);
    const gasId = gasIdOf(order.id);
    await payAndDeliver(h, gasId, "gas deposit alone");
    const stats = (await h.get("/api/stats")).body as StatsResponse;
    expect(stats.totals).toMatchObject({ swaps: 0, volumeUsd: 3, chains: 0, deliverySeconds: null });
    expect(stats).toMatchObject({ feed: [], chainsUsed: [], chains: [], coins: [base("ETH", 3)] });
    expect(h.rewards.entriesFor(WHO.rewards).map((entry) => [entry.order, entry.volumeUsdMicro])).toEqual([[orderHash(gasId), "3000000"]]);
    expect(fs.existsSync(entryFile(h, order.id))).toBe(false);
    // The same after a restart.
    const again = startedAgain(h);
    expect(again.stats.view()).toEqual(stats);
    expect(again.rewards.entriesFor(WHO.rewards)).toHaveLength(1);
    // A gas order asked for with no rewards address adds no points, like any order that names none.
    const none = await start();
    const unnamed = await pair(none, { rewardsAddress: undefined });
    await payAndDeliver(none, gasIdOf(unnamed.id), "gas deposit unnamed");
    expect(fs.readdirSync(path.join(none.dataDir, "rewards", "entries"))).toEqual([]);
    expect(((await none.get("/api/stats")).body as StatsResponse).totals).toMatchObject({ swaps: 0, volumeUsd: 3 });
  });

  it("in Ghost mode: both are counted in the totals with no row, both leave their points, and both records are deleted", async () => {
    const h = await start();
    const order = await pair(h, { ghost: true });
    const gasId = gasIdOf(order.id);
    await payAndDeliver(h, gasId, "ghost gas deposit");
    // The gas order's record went the moment it was delivered, after it was counted and its points were written.
    expect(h.store.ids()).toEqual([order.id]);
    expect(((await h.get("/api/stats")).body as StatsResponse).totals).toMatchObject({ swaps: 0, volumeUsd: 3, chains: 0 });
    expect(fs.existsSync(entryFile(h, gasId))).toBe(true);
    await payAndDeliver(h, order.id, "ghost swap deposit");
    expect(h.store.ids()).toEqual([]);
    expect(fs.readdirSync(path.join(h.dataDir, "orders"))).toEqual([]);

    const stats = (await h.get("/api/stats")).body as StatsResponse;
    expect(stats.totals).toMatchObject({ swaps: 1, volumeUsd: 15, chains: 1 });
    expect(stats.chainsUsed).toEqual([{ chain: "base", swaps: 1, share: 100 }]);
    // No rows: neither order of a Ghost pair is ever listed.
    expect(stats.feed).toEqual([]);
    expect((JSON.parse(fs.readFileSync(path.join(h.dataDir, "stats", "stats.json"), "utf8")) as StatsFile).rows).toEqual([]);
    expect(h.rewards.entriesFor(WHO.rewards).map((entry) => entry.volumeUsdMicro).sort()).toEqual(["12500000", "3000000"]);
    // The same after a restart: nothing is counted again, and nothing is listed.
    const again = startedAgain(h);
    expect(again.stats.view()).toEqual(stats);
    expect(again.rewards.entriesFor(WHO.rewards)).toHaveLength(2);
    expect(again.rewards.weekPoints(weekOf(h.clock.t))).toEqual(new Map([[WHO.rewards, 155_000_000n]]));
  });
});
