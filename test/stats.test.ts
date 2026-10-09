// The Stats page's figures: what is counted, what is kept, and the one thing that can never reach
// the page, its route or its file: anything of the receiving side of a swap.
//
// Orders are made here with every field a real one has, the two sides of each differing in every
// one of them, put through the order store as the server puts them, and the totals are then read
// the way a visitor reads them.

import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type Booted } from "../server/boot.ts";
import { createLogger, hashId } from "../server/log.ts";
import { createStats, shareOf, type Delivery, type Stats, type StatsFile } from "../server/stats.ts";
import { createOrderStore, FINISHED_RETENTION_MS, type OrderRecord, type OrderState, type OrderStore } from "../server/store.ts";
import { formatExact } from "../shared/amounts.ts";
import type { CoinRef, Confidentiality, OrderStatus, StatsResponse } from "../shared/api.ts";
import { chainInfo, chainName } from "../shared/chains.ts";
import { chainGrid, whenText, shortTx, statsPageOn } from "../web/src/lib/stats-logic.ts";
import { ChainGrid, StatsContent } from "../web/src/pages/StatsPage.tsx";
import { navItems } from "../web/src/router.ts";
import { asOrder, FIXTURE_TOKENS, harness, type Harness } from "./helpers.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Noon on a Thursday. */
const NOON = Date.parse("2026-10-08T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const ETH: CoinRef = { id: "nep141:base.omft.near", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null };
const USDC: CoinRef = { id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", symbol: "USDC", name: "USD Coin", chain: "arb", decimals: 6, contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" };
const USDT: CoinRef = { id: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", symbol: "USDT", name: "Tether USD", chain: "sol", decimals: 6, contract: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" };
const BTC: CoinRef = { id: "1cs_v1:btc:native:coin", symbol: "BTC", name: "Bitcoin", chain: "btc", decimals: 8, contract: null };
const DAI: CoinRef = { id: "nep141:op-0xda10009cbd5d07dd0cecc66161fc93d7c9000da1.omft.near", symbol: "DAI", name: "Dai Stablecoin", chain: "op", decimals: 18, contract: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1" };
const ZEC: CoinRef = { id: "1cs_v1:zec:native:coin", symbol: "ZEC", name: "Zcash", chain: "zec", decimals: 8, contract: null };

// Everything an order holds is made up from fixed text: nobody's.
const made = (label: string, bytes: number) => createHash("sha256").update(`stats test ${label}`).digest("hex").slice(0, bytes * 2);
/** A transaction hash of the shape its chain's hashes have. */
const txOn = (chain: string, label: string) => (chainInfo(chain).family === "evm" ? `0x${made(label, 32)}` : made(label, 32));

interface Swap {
  usd?: string;
  from?: CoinRef;
  to?: CoinRef;
  /** The amount sent, in the coin's smallest unit. */
  amountIn?: string;
  /** How long before its delivery the order was made, in seconds. */
  took?: number;
  confidentiality?: Confidentiality;
}

const orderId = (n: number) => `StatsTestOrder${String(n).padStart(13, "0")}`;

/** An order as it is made: waiting, with every field a real one has, and no two orders alike in any of them. */
function order(n: number, createdAt: number, swap: Swap = {}): OrderRecord {
  const from = swap.from ?? ETH;
  const to = swap.to ?? USDT;
  return {
    v: 1,
    id: orderId(n),
    createdAt: iso(createdAt),
    pay: "wallet",
    from,
    to,
    amountIn: swap.amountIn ?? String(512_345_678_901_234_567n + BigInt(n) * 1_000_000_007n),
    amountOut: String(1_236_154_321n + BigInt(n) * 1_000_003n),
    minAmountOut: String(1_223_792_777n + BigInt(n) * 1_000_003n),
    amountInUsd: swap.usd ?? "1240.82",
    amountOutUsd: `${7_654_321 + n}.15`,
    slippageBps: 100,
    timeEstimate: 45,
    fees: { appBps: 20, providerBps: 20, appAmount: "1024691357802469", providerAmount: "1024691357802469" },
    withdrawFee: null,
    refundFee: null,
    recipient: chainInfo(to.chain).family === "evm" ? `0x${made(`recipient ${n}`, 20)}` : `Rcv${made(`recipient ${n}`, 20)}`,
    refundTo: `0x${made(`refund ${n}`, 20)}`,
    sender: `0x${made(`sender ${n}`, 20)}`,
    rewardsAddress: `0x${made(`rewards ${n}`, 20)}`,
    confidentiality: swap.confidentiality ?? "public",
    depositAddress: `0x${made(`deposit ${n}`, 20)}`,
    depositMemo: `memo-${made(`memo ${n}`, 6)}`,
    deadline: iso(createdAt + 30 * MINUTE),
    termsVersion: "test",
    screening: { result: "clear", listVersion: "test", checkedAt: iso(createdAt) },
    quoteResponse: { quote: { depositAddress: `0x${made(`deposit ${n}`, 20)}` }, signature: `ed25519:${made(`signature ${n}`, 32)}` },
    state: { status: "waiting", upstreamStatus: "PENDING_DEPOSIT", statusSince: iso(createdAt), updatedAt: iso(createdAt), anchor: createdAt, depositTxHash: null, depositVerified: false, depositForwarded: false, details: null, finishedAt: null, stopped: false, slowAlertSent: false },
  };
}

/** The transaction that paid an order's deposit, on the chain it was sent from; and the one that delivered it, on the chain it was received on. */
const depositOf = (record: OrderRecord) => txOn(record.from.chain, `paid ${record.id}`);
const deliveryOf = (record: OrderRecord) => txOn(record.to.chain, `delivery ${record.id}`);

/** The time a row carries: the minute the swap began on the sending side (here, the order being made). Never the moment of delivery. */
const begunText = (record: OrderRecord): string => `${new Date(Math.floor(Math.max(record.state.anchor, Date.parse(record.createdAt)) / 60_000) * 60_000).toISOString().slice(0, 19)}Z`;

/** The same order's state once it has ended, as the poller writes it. */
function ended(record: OrderRecord, at: number, status: OrderStatus = "delivered"): OrderState {
  const paid = depositOf(record);
  return {
    ...record.state,
    status,
    upstreamStatus: status === "delivered" ? "SUCCESS" : status === "refunded" ? "REFUNDED" : status === "failed" ? "FAILED" : "PENDING_DEPOSIT",
    statusSince: iso(at),
    updatedAt: iso(at),
    depositTxHash: status === "expired" ? null : paid,
    depositVerified: status !== "expired",
    depositForwarded: status !== "expired",
    details: status === "expired" ? null : { originTxs: [{ hash: paid, url: null }], destinationTxs: status === "delivered" ? [{ hash: deliveryOf(record), url: null }] : [], depositedAmount: record.amountIn, amountIn: record.amountIn, amountOut: status === "delivered" ? record.amountOut : null, refundedAmount: status === "refunded" ? record.amountIn : null, refundReason: null },
    finishedAt: iso(at),
  };
}

/**
 * Everything of an order that the Stats page, its route and its file may never hold, in every way
 * it could be written: the whole of its receiving side, every address, and what names the order.
 */
function neverOf(record: OrderRecord): string[] {
  const { to } = record;
  const delivered = deliveryOf(record);
  const receiving = [to.symbol, to.name, to.id, to.contract ?? to.id, `"${to.chain}"`, chainName(to.chain), record.amountOut, record.minAmountOut, formatExact(BigInt(record.amountOut), to.decimals), formatExact(BigInt(record.minAmountOut), to.decimals), record.amountOutUsd, record.amountOutUsd.split(".")[0]!, record.recipient, delivered, delivered.replace(/^0x/, "")];
  const addresses = [record.refundTo, record.sender!, record.rewardsAddress!, record.depositAddress, record.depositMemo!];
  const names = [record.id, hashId(record.id), createHash("sha256").update(record.id).digest("hex")];
  return [...receiving, ...addresses, ...names];
}

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-stats-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Site {
  dir: string;
  clock: { t: number };
  stats: Stats;
  store: OrderStore;
  /** Makes an order and ends it at the clock's time. Delivered unless told otherwise. */
  end(n: number, swap?: Swap, status?: OrderStatus): OrderRecord;
  /** What a visitor is sent at a moment. */
  at(ms: number): StatsResponse;
  file(): StatsFile;
  /** The file as it is on the disk, letter for letter. */
  text(): string;
}

/**
 * The totals and the order store, wired as the server wires them, on a clock the test moves. Given
 * a folder that has been used before, it is that server started again: every order on disk is put
 * to the totals once more.
 */
function site(options: { dir?: string; t?: number } = {}): Site {
  const dir = options.dir ?? tempDir();
  const clock = { t: options.t ?? NOON };
  const stats = createStats(dir, { now: () => clock.t });
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
    end(n, swap = {}, status = "delivered") {
      const record = order(n, clock.t - (swap.took ?? 40) * 1000, swap);
      store.create(record);
      store.saveState(record.id, ended(record, clock.t, status));
      return store.get(record.id)!;
    },
    at(ms) {
      clock.t = ms;
      return stats.view();
    },
    file: () => JSON.parse(text()) as StatsFile,
    text,
  };
}

describe("the totals", () => {
  it("count delivered swaps by what they sent, as they are delivered: how many, their dollar value, the chains sent from, the time taken, the coins sent", () => {
    const s = site();
    s.clock.t = NOON + 2 * MINUTE;
    s.end(1, { usd: "1240.82", took: 40 });
    s.clock.t = NOON + 7 * MINUTE;
    s.end(2, { usd: "249.91", took: 61, from: USDC, to: ETH });
    s.end(3, { usd: "99.999999", took: 30 });
    // The provider gave no dollar value: a swap with no volume.
    s.end(4, { usd: "", took: 100, from: BTC, to: USDC });

    // Nothing waits: the figures are those of this moment.
    const shown = s.stats.view();
    expect(shown.totals).toEqual({ swaps: 4, volumeUsd: 1590, volume24hUsd: 1590, chains: 3, deliverySeconds: 58 });
    expect(shown.coins).toEqual([
      { coin: { symbol: "ETH", chain: "base" }, volumeUsd: 1340 },
      { coin: { symbol: "USDC", chain: "arb" }, volumeUsd: 249 },
    ]);
    expect(shown.chains).toEqual([
      { chain: "base", name: "Base", volumeUsd: 1340 },
      { chain: "arb", name: "Arbitrum", volumeUsd: 249 },
    ]);
    expect(shown.feed).toHaveLength(4);
  });

  it("chains count the sending side only: a chain is used when a swap was sent from it, its swaps are those sent from it, and its share is of the volume sent", () => {
    const s = site();
    s.end(1, { usd: "600", from: ETH, to: USDT });
    // From Base to Base.
    s.end(2, { usd: "300", from: ETH, to: { ...USDC, chain: "base" } });
    s.end(3, { usd: "100", from: USDC, to: BTC });
    // The provider gave no dollar value: the swap is counted for the chain it was sent from, with no volume.
    s.end(4, { usd: "", from: ZEC, to: DAI });

    const shown = s.stats.view();
    // In the order of the chains' codes. Solana, Bitcoin and Optimism only ever received: they are not there.
    expect(shown.chainsUsed).toEqual([
      { chain: "arb", swaps: 1, share: 10 },
      { chain: "base", swaps: 2, share: 90 },
      { chain: "zec", swaps: 1, share: 0 },
    ]);
    // The "Chains used" figure is the length of that list.
    expect(shown.totals.chains).toBe(3);
    expect(shown.totals.chains).toBe(shown.chainsUsed.length);
    // The share is of the very sum the list of top chains shows in dollars.
    expect(shown.chains.map((item) => [item.chain, item.volumeUsd])).toEqual([["base", 900], ["arb", 100]]);
    // Outside the totals of coins received, which name a coin and its chain and no swap, no chain a swap arrived on is named.
    for (const received of ['"sol"', '"btc"', '"op"', "Solana", "Bitcoin", "Optimism"]) expect(JSON.stringify({ ...shown, received: null }) + JSON.stringify({ ...s.file(), received: [] }), received).not.toContain(received);
    // Kept as counted, and whole after a restart.
    expect(s.file().chains).toEqual({ base: { swaps: 2, volumeMicro: "900000000" }, arb: { swaps: 1, volumeMicro: "100000000" }, zec: { swaps: 1, volumeMicro: "0" } });
    expect(site({ dir: s.dir }).stats.view()).toEqual(shown);
  });

  it("a chain's share of volume is whole per cent, rounded down; under one per cent it is said to be under one, and not nothing", () => {
    expect([shareOf(31n, 100n), shareOf(319_999n, 1_000_000n), shareOf(999_999n, 1_000_000n), shareOf(1_000_000n, 1_000_000n), shareOf(10_000n, 1_000_000n)]).toEqual([31, 31, 99, 100, 1]);
    expect([shareOf(1n, 1_000_000n), shareOf(9_999n, 1_000_000n)]).toEqual(["<1", "<1"]);
    // No volume: nothing of something, and anything of nothing.
    expect([shareOf(0n, 1_000_000n), shareOf(0n, 0n)]).toEqual([0, 0]);

    const s = site();
    s.end(1, { usd: "99999.5", from: ETH, to: USDT });
    s.end(2, { usd: "0.5", from: USDC, to: BTC });
    expect(s.stats.view().chainsUsed).toEqual([
      { chain: "arb", swaps: 1, share: "<1" },
      { chain: "base", swaps: 1, share: 99 },
    ]);
    // Swaps with no dollar value at all: the chain has its swap, and no share of nothing.
    const none = site();
    none.end(1, { usd: "" });
    expect(none.stats.view()).toMatchObject({ totals: { swaps: 1, volumeUsd: 0, chains: 1 }, chainsUsed: [{ chain: "base", swaps: 1, share: 0 }] });
  });

  it("a file of the earlier kind is read, and what it held of the receiving side of swaps is off the disk at once: its totals stand, what was sent is rebuilt from its pairs, and its rows are dropped", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "stats"), { recursive: true });
    const coin = (symbol: string, chain: string) => ({ symbol, chain });
    const before = {
      v: 1,
      swaps: 7,
      volumeMicro: "2600000000",
      deliverySeconds: 280,
      deliveriesTimed: 7,
      // Each swap counted for the chain it left and for the chain it arrived on.
      chains: { base: "2000000000", sol: "2000000000", arb: "600000000", btc: "600000000" },
      chainSwaps: { base: 5, sol: 5, arb: 2, btc: 2 },
      pairs: [
        { from: coin("ETH", "base"), to: coin("USDT", "sol"), volumeMicro: "1500000000" },
        { from: coin("USDC", "base"), to: coin("USDT", "sol"), volumeMicro: "500000000" },
        { from: coin("USDC", "arb"), to: coin("BTC", "btc"), volumeMicro: "600000000" },
      ],
      days: { [String(Math.floor(NOON / DAY))]: "2600000000" },
      hours: { [String(Math.floor(NOON / HOUR) - 1)]: { swaps: 7, volumeMicro: "2600000000" } },
      rows: [{ from: coin("ETH", "base"), to: coin("USDT", "sol"), band: "1k-10k", quarter: Math.floor(NOON / (15 * MINUTE)) }],
    };
    const file = path.join(dir, "stats", "stats.json");
    fs.writeFileSync(file, JSON.stringify(before));
    // The check has something to find.
    for (const held of ["USDT", '"sol"', "BTC", '"btc"']) expect(fs.readFileSync(file, "utf8")).toContain(held);

    // Read at a start, and written again before anything else is done.
    const stats = createStats(dir, { now: () => NOON });
    expect(stats.setAside).toBe(false);
    expect(fs.readdirSync(path.join(dir, "stats"))).toEqual(["stats.json"]);
    const text = fs.readFileSync(file, "utf8");
    for (const gone of ["USDT", '"sol"', "BTC", '"btc"', "pairs", '"to"', '"from"', "band", "quarter", "days", "chainSwaps"]) expect(text, gone).not.toContain(gone);
    const kept = JSON.parse(text) as StatsFile;
    expect(Object.keys(kept).sort()).toEqual(["chains", "coins", "deliveriesTimed", "deliverySeconds", "hours", "received", "rows", "swaps", "v", "volumeMicro"]);
    expect(kept).toMatchObject({ v: 2, swaps: 7, volumeMicro: "2600000000", rows: [] });
    // What was sent, from each pair's sending coin. How many swaps a chain sent the old file cannot say.
    expect(kept.coins).toEqual([{ symbol: "ETH", chain: "base", volumeMicro: "1500000000" }, { symbol: "USDC", chain: "base", volumeMicro: "500000000" }, { symbol: "USDC", chain: "arb", volumeMicro: "600000000" }]);
    expect(kept.chains).toEqual({ base: { swaps: 0, volumeMicro: "2000000000" }, arb: { swaps: 0, volumeMicro: "600000000" } });

    const shown = stats.view();
    expect(shown.totals).toEqual({ swaps: 7, volumeUsd: 2600, volume24hUsd: 2600, chains: 2, deliverySeconds: 40 });
    expect(shown.coins.map((item) => `${item.coin.symbol} ${item.coin.chain} ${item.volumeUsd}`)).toEqual(["ETH base 1500", "USDC arb 600", "USDC base 500"]);
    expect(shown.chainsUsed).toEqual([{ chain: "arb", swaps: 0, share: 23 }, { chain: "base", swaps: 0, share: 76 }]);
    expect(shown.feed).toEqual([]);
    // A swap delivered from now on is counted on top of what was there.
    const s = site({ dir });
    expect(s.file().v).toBe(3);
    s.end(1, { usd: "400", from: ETH, to: BTC });
    expect(s.stats.view()).toMatchObject({ totals: { swaps: 8, volumeUsd: 3000, chains: 2 }, chainsUsed: [{ chain: "arb", swaps: 0, share: 20 }, { chain: "base", swaps: 1, share: 80 }] });
    expect(s.stats.view().feed).toHaveLength(1);
  });

  it("a file from before rows were kept as long as their orders is put right once, at a start: a delivered order still on disk gets its row back and is counted for its chain, the totals do not move, and a second start changes nothing", () => {
    /** A folder with one delivered order that is already counted, and a file of totals as given. */
    const folder = (file: object) => {
      const dir = tempDir();
      const store = createOrderStore(dir);
      const made = order(1, NOON - 40_000, { usd: "3.4" });
      store.create(made);
      store.saveState(made.id, ended(made, NOON));
      expect(store.markCounted(made.id)).toBe(true);
      fs.mkdirSync(path.join(dir, "stats"), { recursive: true });
      fs.writeFileSync(path.join(dir, "stats", "stats.json"), JSON.stringify(file));
      return { dir, record: store.get(made.id)! };
    };
    const totals = { swaps: 1, volumeMicro: "3400000", deliverySeconds: 40, deliveriesTimed: 1, coins: [{ symbol: "ETH", chain: "base", volumeMicro: "3400000" }], hours: {} };
    const rowOf = (record: OrderRecord) => ({ coin: { symbol: "ETH", chain: "base", decimals: 18 }, amount: record.amountIn, at: begunText(record), tx: depositOf(record) });

    // The swap was counted by the first Stats page: it is in the totals, its chain has its volume and no swap, and it has no row.
    const first = folder({ v: 2, ...totals, chains: { base: { swaps: 0, volumeMicro: "3400000" } }, rows: [] });
    const s = site({ dir: first.dir, t: NOON + HOUR });
    const shown = s.stats.view();
    expect(shown.totals).toEqual({ swaps: 1, volumeUsd: 3, volume24hUsd: 0, chains: 1, deliverySeconds: 40 });
    expect(shown.chainsUsed).toEqual([{ chain: "base", swaps: 1, share: 100 }]);
    expect(shown.coins).toEqual([{ coin: { symbol: "ETH", chain: "base" }, volumeUsd: 3 }]);
    expect(shown.feed).toEqual([rowOf(first.record)]);
    expect(s.file()).toMatchObject({ v: 3, swaps: 1, volumeMicro: "3400000", chains: { base: { swaps: 1, volumeMicro: "3400000" } }, rows: [rowOf(first.record)] });
    // Started again, and again: the file is the same to the letter.
    const text = s.text();
    for (let start = 0; start < 2; start++) {
      const again = site({ dir: first.dir, t: NOON + HOUR });
      expect(again.text()).toBe(text);
      expect(again.stats.view()).toEqual(shown);
    }

    // The swap was counted for its chain when it was delivered, and only its row had gone (rows used to go after 48 hours): the row comes back, and the count stays.
    const aged = folder({ v: 2, ...totals, chains: { base: { swaps: 1, volumeMicro: "3400000" } }, rows: [] });
    expect(site({ dir: aged.dir, t: NOON + 3 * DAY }).stats.view()).toMatchObject({ totals: { swaps: 1, volumeUsd: 3 }, chainsUsed: [{ chain: "base", swaps: 1, share: 100 }], feed: [rowOf(aged.record)] });
    // The file holds the order's row already: nothing is added.
    const whole = folder({ v: 2, ...totals, chains: { base: { swaps: 1, volumeMicro: "3400000" } }, rows: [] });
    fs.writeFileSync(path.join(whole.dir, "stats", "stats.json"), JSON.stringify({ v: 2, ...totals, chains: { base: { swaps: 1, volumeMicro: "3400000" } }, rows: [rowOf(whole.record)] }));
    expect(site({ dir: whole.dir, t: NOON + HOUR }).stats.view()).toMatchObject({ totals: { swaps: 1 }, chainsUsed: [{ chain: "base", swaps: 1, share: 100 }], feed: [rowOf(whole.record)] });
    // A file that says it has been put right is left as it is, whatever it lacks.
    const done = folder({ v: 3, ...totals, chains: { base: { swaps: 0, volumeMicro: "3400000" } }, rows: [] });
    expect(site({ dir: done.dir, t: NOON + HOUR }).stats.view()).toMatchObject({ totals: { swaps: 1 }, chainsUsed: [{ chain: "base", swaps: 0, share: 100 }], feed: [] });
  });

  it("the last 24 hours end on the hour, and hours that have aged out are dropped while the totals stay", () => {
    const s = site();
    s.clock.t = NOON + 10 * MINUTE;
    s.end(1, { usd: "500" });
    expect(s.at(NOON + 15 * MINUTE).totals.volume24hUsd).toBe(500);
    // Still inside 24 hours a quarter before the same hour comes round, and outside once it has.
    expect(s.at(NOON + DAY - 15 * MINUTE).totals.volume24hUsd).toBe(500);
    const next = s.at(NOON + DAY);
    expect(next.totals).toMatchObject({ swaps: 1, volumeUsd: 500, volume24hUsd: 0 });
    // A month on, a swap delivered then is alone in the hours that are kept.
    const later = NOON + 31 * DAY;
    expect(s.at(later).totals).toMatchObject({ swaps: 1, volumeUsd: 500, volume24hUsd: 0 });
    s.clock.t = later + MINUTE;
    s.end(2, { usd: "20" });
    expect(s.at(later + 15 * MINUTE).totals).toMatchObject({ swaps: 2, volumeUsd: 520, volume24hUsd: 20 });
    expect(Object.keys(s.file().hours)).toHaveLength(1);
  });

  it("an order is counted once: not at a second saving of its state, not from a copy of it that is not marked, not after a restart", () => {
    const s = site();
    s.clock.t = NOON + MINUTE;
    const record = s.end(1, { usd: "300" });
    // The mark is on the order's own record, on disk.
    expect(record.statsCounted).toBe(true);
    expect((JSON.parse(fs.readFileSync(path.join(s.dir, "orders", `${record.id}.json`), "utf8")) as OrderRecord).statsCounted).toBe(true);
    // The poller saves the state again (a detail arrived).
    s.store.saveState(record.id, { ...record.state, updatedAt: iso(s.clock.t + 1000) });
    // The same order, as it stood before it was marked: the order store says it has been counted.
    const { statsCounted: _mark, ...unmarked } = record;
    expect(s.stats.recordDelivered(unmarked, () => s.store.markCounted(record.id))).toBe(false);
    expect(s.at(NOON + 15 * MINUTE)).toMatchObject({ totals: { swaps: 1, volumeUsd: 300 }, feed: [{ amount: record.amountIn }] });

    // The server is started again on the same folder, and goes over every order on disk.
    const again = site({ dir: s.dir, t: NOON + 20 * MINUTE });
    expect(again.at(NOON + 30 * MINUTE)).toEqual(s.at(NOON + 30 * MINUTE));
    expect(again.stats.view().totals).toEqual({ swaps: 1, volumeUsd: 300, volume24hUsd: 300, chains: 1, deliverySeconds: 40 });
    expect(again.stats.view().feed).toHaveLength(1);
    // A delivery that was saved a moment before a stop, and never told to the totals, is counted at the next start.
    const missed = order(2, NOON + 21 * MINUTE, { usd: "50" });
    fs.writeFileSync(path.join(s.dir, "orders", `${missed.id}.json`), JSON.stringify({ ...missed, state: ended(missed, NOON + 22 * MINUTE) }));
    const third = site({ dir: s.dir, t: NOON + 25 * MINUTE });
    expect(third.at(NOON + 30 * MINUTE)).toMatchObject({ totals: { swaps: 2, volumeUsd: 350 }, feed: [{ amount: missed.amountIn }, { amount: record.amountIn }] });
    expect(site({ dir: s.dir, t: NOON + 26 * MINUTE }).at(NOON + 30 * MINUTE).totals).toMatchObject({ swaps: 2, volumeUsd: 350 });
  });
});

describe("the Stats page, its route and its file know nothing of the receiving side of any swap", () => {
  describe.each(["public", "basic"] as const)("with swaps routed as %s", (mode) => {
    let h: Harness;
    afterEach(async () => {
      await h.close();
    });

    it("no receiving coin, receiving chain, amount out, receiving or refund address or delivery hash is in the file, in any answer or in any row", async () => {
      h = await harness({ env: { PRIVACY_MODE: mode } });
      const statsFile = path.join(h.dataDir, "stats", "stats.json");
      const records: OrderRecord[] = [];
      const answers: string[] = [];
      // The two sides of each differ in every field. No coin and no chain that is received here is ever sent.
      const swaps: Swap[] = [
        { usd: "1240.82", from: ETH, to: USDT },
        // Both chains of one kind: the delivery's hash has the very shape of a deposit's.
        { usd: "249.91", from: USDC, to: DAI },
        { usd: "61.07", from: ETH, to: BTC },
        { usd: "12870.5", from: USDC, to: ZEC },
      ];
      for (const [index, swap] of swaps.entries()) {
        const createdAt = h.clock.t + index * 61_003;
        const record = order(index + 1, createdAt, { ...swap, confidentiality: mode });
        h.store.create(record);
        h.clock.t = createdAt + 47_219;
        h.store.saveState(record.id, ended(record, h.clock.t));
        records.push(h.store.get(record.id)!);
        // What a visitor is sent after each delivery, and not only at the end.
        const reply = await h.get("/api/stats");
        expect(reply.status).toBe(200);
        answers.push(reply.text);
      }
      const reply = await h.get("/api/stats");
      const kept = fs.readFileSync(statsFile, "utf8");
      // The check has something to check: every swap is counted and listed, the newest first, by what it sent.
      expect(reply.body.totals.swaps).toBe(4);
      const rows = [...records].reverse().map((record) => ({ coin: { symbol: record.from.symbol, chain: record.from.chain, decimals: record.from.decimals }, amount: record.amountIn, at: begunText(record), tx: depositOf(record) }));
      expect(reply.body.feed).toEqual(rows);
      expect((JSON.parse(kept) as StatsFile).rows).toEqual([...rows].reverse());
      // An order's two hashes differ, and it is the deposit's that a row holds.
      for (const record of records) expect(depositOf(record)).not.toBe(deliveryOf(record));
      expect(deliveryOf(records[1]!)).toMatch(/^0x[0-9a-f]{64}$/);

      const never = new Set(records.flatMap(neverOf));
      expect(never.size).toBeGreaterThan(70);
      // The coin a swap delivered is named in one place only, the totals by coin: a coin, its chain and dollars, and no swap. Those apart, nothing of the receiving side is anywhere.
      const totals = (JSON.parse(kept) as StatsFile).received ?? [];
      expect(totals.length).toBeGreaterThan(0);
      for (const total of totals) expect(Object.keys(total).sort()).toEqual(["chain", "symbol", "volumeMicro"]);
      for (const total of (reply.body as StatsResponse).received ?? []) expect(Object.keys(total).sort()).toEqual(["coin", "volumeUsd"]);
      const beside = (text: string) => JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), received: null });
      for (const [where, text] of [["the file", beside(kept)], ["the answers", [...answers, reply.text].map(beside).join("\n")], ["the rows", JSON.stringify(reply.body.feed)]] as const) {
        for (const secret of never) expect(text.toLowerCase().includes(secret.toLowerCase()), `${where} hold ${secret}`).toBe(false);
      }

      // What is there instead, part by part.
      expect(Object.keys(reply.body).sort()).toEqual(["chains", "chainsUsed", "coins", "feed", "received", "totals"]);
      expect(Object.keys(reply.body.totals).sort()).toEqual(["chains", "deliverySeconds", "swaps", "volume24hUsd", "volumeUsd"]);
      for (const item of reply.body.coins) expect([Object.keys(item).sort(), Object.keys(item.coin).sort()]).toEqual([["coin", "volumeUsd"], ["chain", "symbol"]]);
      for (const item of reply.body.chains) expect(Object.keys(item).sort()).toEqual(["chain", "name", "volumeUsd"]);
      for (const item of reply.body.chainsUsed) expect(Object.keys(item).sort()).toEqual(["chain", "share", "swaps"]);
      const file = JSON.parse(kept) as StatsFile;
      expect(Object.keys(file).sort()).toEqual(["chains", "coins", "deliveriesTimed", "deliverySeconds", "hours", "received", "rows", "swaps", "v", "volumeMicro"]);
      for (const row of [...reply.body.feed, ...file.rows]) {
        expect(Object.keys(row).sort()).toEqual(["amount", "at", "coin", "tx"]);
        expect(Object.keys(row.coin).sort()).toEqual(["chain", "decimals", "symbol"]);
      }
      for (const item of file.coins) expect(Object.keys(item).sort()).toEqual(["chain", "symbol", "volumeMicro"]);
      // Only what was sent from: Base and Arbitrum.
      expect(Object.keys(file.chains).sort()).toEqual(["arb", "base"]);
      expect(reply.body.chainsUsed.map((item: { chain: string }) => item.chain)).toEqual(["arb", "base"]);
      // The same headers as any other answer.
      expect(reply.headers.get("content-security-policy")).toBe((await h.get("/api/status")).headers.get("content-security-policy"));
      expect(reply.headers.get("cache-control")).toBe("no-store");
    });
  });

  it("a coin's name is cut to a length no address fits in, whatever the coin list says", () => {
    const s = site();
    const record = s.end(1, { usd: "10", from: { ...ETH, symbol: `0x${made("long symbol", 20)}`, chain: `Rcv${made("long chain", 20)}` } });
    const text = s.text() + JSON.stringify(s.stats.view());
    expect(text).not.toContain(record.from.symbol);
    expect(text).not.toContain(record.from.chain);
    expect(s.stats.view().feed[0]!.coin).toEqual({ symbol: record.from.symbol.slice(0, 16), chain: "other", decimals: 18 });
  });
});

/** A page's words, without its markup. */
const words = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
/** A coin list's chains, as the page is handed them: in the order the coin picker offers them. */
const LISTED = [{ key: "bsc", name: "BNB Chain" }, { key: "eth", name: "Ethereum" }, { key: "sol", name: "Solana" }, { key: "base", name: "Base" }, { key: "qtc", name: "Quantus" }];

describe("chains used", () => {
  const stats: StatsResponse = { totals: { swaps: 13, volumeUsd: 1500, volume24hUsd: 400, chains: 2, deliverySeconds: 72 }, coins: [], received: null, chains: [], chainsUsed: [{ chain: "base", swaps: 12, share: 31 }, { chain: "sol", swaps: 1, share: "<1" }], feed: [] };
  /** The grid's chains as they are drawn, in order: what each says, and whether it can be pressed. */
  const drawn = (markup: string) => {
    const grid = /<ul class="stats-chains">(.*?)<\/ul>/.exec(markup)?.[1] ?? "";
    return [...grid.matchAll(/<li>(.*?)<\/li>/g)].map((item) => ({ says: words(item[1]!).trim(), button: item[1]!.startsWith('<button type="button" class="stats-chains-item" data-used=""'), faded: item[1]!.startsWith('<span class="stats-chains-item">') }));
  };

  it("the page draws every chain on the coin list in the list's order: a used one in full colour, to be pressed, and any other faded and said to be not used", () => {
    const markup = renderToStaticMarkup(createElement(StatsContent, { stats, chains: LISTED }));
    expect(drawn(markup)).toEqual([
      { says: "BNB Chain , not used yet", button: false, faded: true },
      { says: "Ethereum , not used yet", button: false, faded: true },
      { says: "Solana", button: true, faded: false },
      { says: "Base", button: true, faded: false },
      { says: "Quantus , not used yet", button: false, faded: true },
    ]);
    // Above the grid, the count: the very number of the "Chains used" tile.
    expect(words(markup)).toContain("Chains used 2 of 5 chains used");
    expect(markup).toContain('<dt class="fact-label mono">Chains used</dt><dd class="stats-number mono"><span aria-hidden="true">0</span><span class="sr-only">2</span></dd>');
    // Nothing is chosen yet: the line says what choosing does, and is read out when it changes.
    expect(markup).toContain('<p class="stats-chains-line muted" aria-live="polite">Tap a chain to see its swaps and its share of volume.</p>');
    expect(markup).not.toContain('aria-pressed="true"');
    // Only a used chain's mark lights up, each in its turn.
    expect([...markup.matchAll(/data-used="" aria-pressed="false" style="--i:(\d+)"/g)].map((match) => match[1])).toEqual(["0", "1"]);
    // While the coin list is not there, there is no grid to set the figures against.
    expect(renderToStaticMarkup(createElement(StatsContent, { stats, chains: [] }))).not.toMatch(/class="stats-chains"|stats-used/);
  });

  it("a chosen chain's swaps and share of volume are said in the one line above the grid, and nothing of an unused chain", () => {
    const line = (chosen: string | null, used = stats.chainsUsed) => /<p class="stats-chains-line muted" aria-live="polite">(.*?)<\/p>/.exec(renderToStaticMarkup(createElement(ChainGrid, { chains: chainGrid(LISTED, used), count: used.length, chosen, onChoose: () => undefined })))?.[1];
    expect(line("base")).toBe("Base: 12 swaps, 31% of volume");
    expect(line("sol")).toBe("Solana: 1 swap, under 1% of volume");
    expect(line("base", [{ chain: "base", swaps: 12_345, share: 0 }])).toBe("Base: 12,345 swaps, 0% of volume");
    // A chain whose swaps were never counted (its figures are from a file of the earlier kind) is not said to have had none.
    expect(line("base", [{ chain: "base", swaps: 0, share: 76 }])).toBe("Base: 76% of volume");
    expect(line("eth")).toBe("Tap a chain to see its swaps and its share of volume.");
    expect(line(null)).toBe("Tap a chain to see its swaps and its share of volume.");
    // The chosen chain is marked as the one pressed.
    const markup = renderToStaticMarkup(createElement(ChainGrid, { chains: chainGrid(LISTED, stats.chainsUsed), count: 2, chosen: "base", onChoose: () => undefined }));
    expect([...markup.matchAll(/aria-pressed="true"[^>]*>.*?<span>([^<]+)<\/span>/g)].map((match) => match[1])).toEqual(["Base"]);
    // A used chain that is not on the coin list follows the list's own, so that as many are lit as the count says.
    expect(chainGrid(LISTED, [...stats.chainsUsed, { chain: "zec", swaps: 2, share: 4 }]).map((chain) => `${chain.key} ${chain.used === null ? "faded" : "lit"}`)).toEqual(["bsc faded", "eth faded", "sol lit", "base lit", "qtc faded", "zec lit"]);
  });
});

describe("recent swaps", () => {
  it("only a delivered swap is listed, and only a delivered swap is counted: not one that was refunded, that failed, that ran out or that is still under way", () => {
    const s = site();
    const delivered = s.end(1, { usd: "150" });
    s.end(2, { usd: "150" }, "refunded");
    s.end(3, { usd: "150" }, "failed");
    s.end(4, { usd: "150" }, "expired");
    // Under way: one waiting to be paid, one whose deposit has been seen, one being swapped.
    for (const [n, status] of [[5, "waiting"], [6, "deposit_seen"], [7, "swapping"]] as const) {
      const record = order(n, s.clock.t - 40_000, { usd: "150" });
      s.store.create(record);
      s.store.saveState(record.id, { ...ended(record, s.clock.t), status, upstreamStatus: "PROCESSING", finishedAt: null });
    }
    const shown = s.stats.view();
    expect(shown.totals).toEqual({ swaps: 1, volumeUsd: 150, volume24hUsd: 150, chains: 1, deliverySeconds: 40 });
    expect(shown.feed).toEqual([{ coin: { symbol: "ETH", chain: "base", decimals: 18 }, amount: delivered.amountIn, at: begunText(delivered), tx: depositOf(delivered) }]);
    expect(s.file().rows).toEqual(shown.feed);
    // Only the delivered order's record is marked as counted.
    expect(s.store.ids().filter((id) => s.store.get(id)!.statsCounted === true)).toEqual([delivered.id]);
    // One of them is delivered after all: it is listed then, and not before.
    const late = s.store.get(orderId(7))!;
    s.clock.t += 90_000;
    s.store.saveState(late.id, ended(late, s.clock.t));
    expect(s.stats.view().feed.map((row) => row.amount)).toEqual([late.amountIn, delivered.amountIn]);
    expect(s.stats.view().totals.swaps).toBe(2);
  });

  it("a row is there at once and from the first swap, the newest first: the coin and the amount sent, the minute the swap began and its deposit's hash, and nothing else; the moment of delivery is in no row", () => {
    const s = site();
    expect(s.stats.view().feed).toEqual([]);
    // Delivered at a moment that is no round one, forty seconds after the order was made (12:02:37).
    s.clock.t = NOON + 3 * MINUTE + 17_123;
    const first = s.end(1, { usd: "150", amountIn: "1000000000000000000" });
    // The same moment: one swap, and its row.
    const row = { coin: { symbol: "ETH", chain: "base", decimals: 18 }, amount: "1000000000000000000", at: "2026-10-08T12:02:00Z", tx: depositOf(first) };
    expect(s.stats.view().feed).toEqual([row]);
    expect(s.file().rows).toEqual([row]);
    // When it was delivered is a fact about the receiving side: neither the answer nor the file holds it.
    expect(first.state.finishedAt).toContain("12:03:17");
    expect(JSON.stringify(s.stats.view())).not.toContain("12:03");
    expect(JSON.stringify(s.file())).not.toContain("12:03");
    expect(Object.keys(s.stats.view().feed[0]!).sort()).toEqual(["amount", "at", "coin", "tx"]);
    expect(Object.keys(s.stats.view().feed[0]!.coin).sort()).toEqual(["chain", "decimals", "symbol"]);
    // A second, five seconds later, stands above it.
    s.clock.t += 5000;
    const second = s.end(2, { usd: "20", from: USDC, to: BTC, amountIn: "20000000" });
    expect(s.stats.view().feed).toEqual([{ coin: { symbol: "USDC", chain: "arb", decimals: 6 }, amount: "20000000", at: "2026-10-08T12:02:00Z", tx: depositOf(second) }, row]);

    // Many more: the page is sent the newest twenty, and the file keeps the newest 300.
    const many: Delivery[] = Array.from({ length: 320 }, (_, index) => ({ coin: { symbol: "ETH", chain: "base", decimals: 18 }, amount: String(index + 1), usdMicro: 1_000_000n, tx: null, seconds: 30, at: s.clock.t + (index + 1) * 1000, began: s.clock.t + (index + 1) * 1000 - 30_000 }));
    s.clock.t += 321_000;
    s.stats.seed(many);
    expect(s.stats.view().feed.map((item) => item.amount)).toEqual(Array.from({ length: 20 }, (_, index) => String(320 - index)));
    expect(s.file().rows).toHaveLength(300);
    expect(s.file().rows[0]!.amount).toBe("21");
    expect(s.stats.view().totals.swaps).toBe(322);
    // A row is listed for as long as a finished order's record is kept, and no longer: there after two days and a day short of the
    // thirty, gone after them. The server's hourly tidying takes it off the disk. The totals keep its swap.
    const listed = s.clock.t;
    expect(s.at(listed + 2 * DAY + MINUTE).feed).toHaveLength(20);
    expect(s.at(listed + FINISHED_RETENTION_MS - DAY).feed).toHaveLength(20);
    expect(s.at(listed + FINISHED_RETENTION_MS + MINUTE).feed).toEqual([]);
    expect(s.file().rows).toHaveLength(300);
    s.stats.tidy();
    expect(s.file().rows).toEqual([]);
    const last = s.end(3, { usd: "5", amountIn: "7" });
    expect(s.file().rows.map((item) => item.amount)).toEqual(["7"]);
    expect(s.stats.view()).toMatchObject({ totals: { swaps: 323 }, feed: [{ amount: "7", tx: depositOf(last) }] });
  });

  it("from an order to its row: a swap made on the running server, paid, and delivered as the provider reports it, is in the answer at once with a link's worth of its deposit, and is counted for the chain it was sent from", async () => {
    const h = await harness();
    try {
      expect((await h.get("/api/stats")).body).toMatchObject({ totals: { swaps: 0, chains: 0 }, chainsUsed: [], feed: [] });
      const made = asOrder(await h.order());
      // Paid. Half a minute on, the provider reports the swap done, naming the deposit's transaction on the sending chain and the delivery's on the other.
      h.stub.control(made.depositAddress!, "deposit");
      h.clock.t += 30_000;
      await h.poller.recheck(made.id);
      const record = h.store.get(made.id)!;
      expect(record.state.status).toBe("delivered");
      const deposit = record.state.details!.originTxs[0]!.hash;
      const delivery = record.state.details!.destinationTxs[0]!.hash;
      expect([deposit, delivery].every((hash) => /^0x[0-9a-f]{64}$/.test(hash)) && deposit !== delivery).toBe(true);

      const reply = await h.get("/api/stats");
      const stats = reply.body as StatsResponse;
      expect(stats.feed).toEqual([{ coin: { symbol: made.from.symbol, chain: made.from.chain, decimals: made.from.decimals }, amount: made.amountIn, at: begunText(record), tx: deposit }]);
      expect(begunText(record)).toBe("2026-10-08T12:00:00Z");
      expect(stats.totals).toMatchObject({ swaps: 1, chains: 1 });
      expect(stats.chainsUsed).toEqual([{ chain: made.from.chain, swaps: 1, share: 100 }]);
      expect(reply.text).not.toContain(delivery.slice(2));
      // And on the page: the row's link to the deposit on its own chain's explorer, and the chain counted among those used.
      const markup = renderToStaticMarkup(createElement(StatsContent, { stats, chains: LISTED }));
      expect(markup).toContain(`<a class="stats-swap-tx mono" href="https://basescan.org/tx/${deposit}" target="_blank" rel="noopener noreferrer">${shortTx(deposit)}<`);
      expect(words(markup)).toContain("1 of 5 chains used");
    } finally {
      await h.close();
    }
  });

  it("the hash is the deposit's: the first the provider names on the sending chain, or else the one this server confirmed; never one that was only announced, and never the delivery's", () => {
    const s = site();
    const state = (n: number, change: (record: OrderRecord, ended: OrderState) => OrderState, swap: Swap = { from: ETH, to: DAI }) => {
      const record = order(n, s.clock.t - 40_000, { usd: "150", ...swap });
      s.store.create(record);
      s.clock.t += 1000;
      const end = ended(record, s.clock.t);
      s.store.saveState(record.id, change(record, end));
      return s.store.get(record.id)!;
    };
    const another = (label: string) => txOn("base", label);
    // The provider names two transactions on the sending chain, and the order's own note is of another: the provider's first.
    const named = state(1, (record, end) => ({ ...end, depositTxHash: another("announced 1"), depositVerified: false, details: { ...end.details!, originTxs: [{ hash: depositOf(record), url: null }, { hash: another("second 1"), url: null }] } }));
    // The provider names none: the transaction this server confirmed pays the order.
    const confirmed = state(2, (_record, end) => ({ ...end, depositTxHash: another("confirmed 2"), depositVerified: true, details: { ...end.details!, originTxs: [] } }));
    // The provider names none, and the order's own hash was only announced: no hash, and the swap is listed all the same.
    const announced = state(3, (_record, end) => ({ ...end, depositTxHash: another("announced 3"), depositVerified: false, details: { ...end.details!, originTxs: [] } }));
    // Nothing known of how it was paid at all.
    const unknown = state(4, (_record, end) => ({ ...end, depositTxHash: null, depositVerified: false, details: null }));
    // What the provider names is no hash of the sending chain's kind: it is not taken.
    const misshapen = state(5, (_record, end) => ({ ...end, depositTxHash: null, depositVerified: false, details: { ...end.details!, originTxs: [{ hash: "not-a-hash-of-this-chain", url: null }] } }));

    const feed = s.stats.view().feed;
    expect(feed.map((row) => row.tx)).toEqual([null, null, null, another("confirmed 2"), depositOf(named)]);
    expect(feed.map((row) => row.amount)).toEqual([misshapen, unknown, announced, confirmed, named].map((record) => record.amountIn));
    // Every one of them was delivered from Base to Optimism, where a hash has the same shape: no delivery's hash is anywhere.
    const text = s.text() + JSON.stringify(s.stats.view());
    for (const record of [named, confirmed, announced, unknown, misshapen]) {
      expect(deliveryOf(record)).toMatch(/^0x[0-9a-f]{64}$/);
      expect(text).not.toContain(deliveryOf(record).slice(2));
    }
    for (const label of ["announced 1", "second 1", "announced 3"]) expect(text).not.toContain(another(label).slice(2));
  });

  it("the page draws a row as what was sent, when, and a link to its deposit that opens in a new tab; with no explorer the hash is plain words, with no hash there is none; and with no rows the list says so in the same room", () => {
    const base = txOn("base", "page base");
    const monad = txOn("monad", "page monad");
    const stats: StatsResponse = {
      totals: { swaps: 3, volumeUsd: 1500, volume24hUsd: 400, chains: 2, deliverySeconds: 72 },
      coins: [{ coin: { symbol: "ETH", chain: "base" }, volumeUsd: 1500 }],
      received: [{ coin: { symbol: "USDT", chain: "sol" }, volumeUsd: 1500 }],
      chains: [{ chain: "base", name: "Base", volumeUsd: 1500 }],
      chainsUsed: [{ chain: "base", swaps: 3, share: 100 }],
      feed: [
        { coin: { symbol: "ETH", chain: "base", decimals: 18 }, amount: "500000000000000000", at: "2026-10-08T12:03:17Z", tx: base },
        // A chain the site has no explorer for.
        { coin: { symbol: "MON", chain: "monad", decimals: 18 }, amount: "2000000000000000000", at: "2026-10-08T11:40:02Z", tx: monad },
        { coin: { symbol: "USDC", chain: "arb", decimals: 6 }, amount: "25000000", at: "2026-10-07T23:59:59Z", tx: null },
      ],
    };
    const markup = renderToStaticMarkup(createElement(StatsContent, { stats, chains: LISTED }));
    const rows = [...markup.matchAll(/<li class="stats-swap">(.*?)<\/li>/g)].map((match) => match[1]!);
    expect(rows).toHaveLength(3);
    // The heading, and under it the one line that says what a row is and is not.
    expect(words(markup)).toContain("Recent swaps Each row links to the deposit on its own chain. Which swap was delivered where is never shown.");
    // What was sent, and when, on the clock of whoever reads it.
    expect(words(rows[0]!)).toContain(`0.5 ETH on Base ${whenText("2026-10-08T12:03:17Z")} `);
    expect(rows[0]).toContain('<time class="stats-swap-when muted" dateTime="2026-10-08T12:03:17Z">');
    expect(whenText("2026-10-08T12:03:17Z")).toMatch(/^2026-10-0[89], \d{2}:\d{2}$/);
    // The deposit: a shortened hash that leads to the transaction on its own chain's explorer, in a new tab.
    expect(shortTx(base)).toBe(`${base.slice(0, 6)}…${base.slice(-4)}`);
    expect(shortTx(base)).toHaveLength(11);
    // The link is named by what it shows, and then, for a screen reader alone, by what it is: no name is put over the visible one.
    const link = /<a class="stats-swap-tx mono" href="([^"]+)" target="_blank" rel="noopener noreferrer">(.*?)<\/a>/.exec(rows[0]!);
    expect(link?.[1]).toBe(`https://basescan.org/tx/${base}`);
    expect(link?.[2]).toMatch(new RegExp(`^${shortTx(base)}<span class="sr-only"> deposit transaction on Base \\(opens in a new tab\\)</span><svg [^>]*aria-hidden="true"`));
    expect(words(link![2]!).trim()).toBe(`${shortTx(base)} deposit transaction on Base (opens in a new tab)`);
    // No explorer: the same words, and no link. No hash: neither.
    expect(words(rows[1]!)).toContain("2 MON on Monad");
    expect(rows[1]).toContain(`<span class="stats-swap-tx mono muted">${shortTx(monad)}</span>`);
    expect(rows[1]).not.toContain("<a ");
    expect(words(rows[2]!)).toContain("25 USDC on Arbitrum");
    expect(rows[2]).not.toContain("stats-swap-tx");
    // Every link on the page that leaves the site is such a deposit.
    expect([...markup.matchAll(/<a [^>]*href="(https?:[^"]+)"/g)].map((match) => match[1])).toEqual([`https://basescan.org/tx/${base}`]);
    // The coins sent, in place of pairs.
    expect(words(markup)).toContain("Top coins sent 01 ETH on Base $1,500");
    expect(words(markup)).not.toMatch(/Top pairs| to [A-Z]+ on |rounded|earlier today|in the last hour/);

    // No rows: the heading and its line stay where they are, and the list's own room says that there are none.
    const without = renderToStaticMarkup(createElement(StatsContent, { stats: { ...stats, feed: [] }, chains: LISTED }));
    expect(words(without)).toContain("Recent swaps Each row links to the deposit on its own chain. Which swap was delivered where is never shown. No swaps yet.");
    // The three lists stand in their order above it, the coins received between the other two.
    expect(words(markup)).toMatch(/Top coins sent .* Top coins received .* Top chains .* Recent swaps/);
    expect(without).not.toContain('class="stats-swap"');
  });
});

describe("the page stands still while it loads", () => {
  // A coin counted in whole units, so that a row's amount is read as its number.
  const coin = { symbol: "ETH", chain: "base", decimals: 0 };
  const row = (n: number) => ({ coin, amount: String(n), at: "2026-10-08T12:03:00Z", tx: null });
  const some = (rows: number): StatsResponse => ({
    totals: { swaps: rows, volumeUsd: 1500, volume24hUsd: 400, chains: rows === 0 ? 0 : 1, deliverySeconds: rows === 0 ? null : 72 },
    coins: rows === 0 ? [] : [{ coin: { symbol: "ETH", chain: "base" }, volumeUsd: 1500 }],
    received: null,
    chains: rows === 0 ? [] : [{ chain: "base", name: "Base", volumeUsd: 1500 }],
    chainsUsed: rows === 0 ? [] : [{ chain: "base", swaps: rows, share: 100 }],
    feed: Array.from({ length: rows }, (_, index) => row(rows - index)),
  });
  const draw = (stats: StatsResponse | null) => renderToStaticMarkup(createElement(StatsContent, { stats, chains: LISTED }));
  /** The page's parts in the order they stand: the five figures, then each part by its heading. */
  const parts = (markup: string) => [...markup.matchAll(/<dl class="stats-tiles"|<h2 id="([^"]+)"/g)].map((match) => match[1] ?? "tiles");
  /** Each list's room, in order: how many rows it is kept for, and what stands in it. */
  const rooms = (markup: string) =>
    [...markup.matchAll(/<div class="stats-room[^"]*" style="--rows:(\d+)">(.*?)<\/div>(?=<\/section>)/g)].map((match) => ({
      rows: Number(match[1]),
      waiting: (match[2]!.match(/class="skeleton stats-waiting-row"/g) ?? []).length,
      held: (match[2]!.match(/<li class="stats-(?:swap|rank)">(?!<span class="skeleton)/g) ?? []).length,
      says: /<p class="stats-none muted">([^<]*)<\/p>/.exec(match[2]!)?.[1] ?? null,
    }));
  const ORDER = ["tiles", "stats-used", "stats-coins", "stats-chains", "stats-recent"];

  it("every part is in its place, with its room, before the answer comes; the same parts stand in the same order once it has, whether it holds twenty swaps, one or none", () => {
    const waiting = draw(null);
    expect(parts(waiting)).toEqual(ORDER);
    // Five figures on their way, each in the line its figure will stand in.
    expect((waiting.match(/<dd class="stats-number mono"><span class="skeleton stats-waiting" aria-hidden="true"><\/span><\/dd>/g) ?? []).length).toBe(5);
    // The list of swaps and the two ranked lists: room for five rows each, with five rows on their way.
    expect(rooms(waiting)).toEqual([{ rows: 5, waiting: 5, held: 0, says: null }, { rows: 5, waiting: 5, held: 0, says: null }, { rows: 5, waiting: 5, held: 0, says: null }]);
    // Every chain, none of them lit yet, and the count's line kept for the count.
    expect((waiting.match(/<span class="stats-chains-item">/g) ?? []).length).toBe(LISTED.length);
    expect(waiting).not.toContain("data-used");
    expect(waiting).toContain('<p class="muted">\u00a0</p><p class="stats-chains-line muted" aria-live="polite">');

    // Twenty swaps: the newest five in the room, and a button for the rest. One swap: one row in the same room. None: the room says so.
    const full = draw(some(20));
    expect(parts(full)).toEqual(ORDER);
    // The two lists first, then the swaps, which stand last on the page.
    expect(rooms(full)).toEqual([{ rows: 5, waiting: 0, held: 1, says: null }, { rows: 5, waiting: 0, held: 1, says: null }, { rows: 5, waiting: 0, held: 5, says: null }]);
    expect(full).toContain('<button type="button" class="button-text" aria-expanded="false" aria-controls="stats-swaps">Show more</button>');
    expect([...full.matchAll(/<span class="amount mono" title="(\d+) ETH">/g)].map((match) => match[1])).toEqual(["20", "19", "18", "17", "16"]);
    const one = draw(some(1));
    expect(parts(one)).toEqual(ORDER);
    expect(rooms(one)).toEqual([{ rows: 5, waiting: 0, held: 1, says: null }, { rows: 5, waiting: 0, held: 1, says: null }, { rows: 5, waiting: 0, held: 1, says: null }]);
    const none = draw(some(0));
    expect(parts(none)).toEqual(ORDER);
    expect(rooms(none)).toEqual([{ rows: 5, waiting: 0, held: 0, says: "No swaps yet." }, { rows: 5, waiting: 0, held: 0, says: "No swaps yet." }, { rows: 5, waiting: 0, held: 0, says: "No swaps yet." }]);
    // Five swaps or fewer: nothing more to show, and no button. The heading's line is there for it all the same.
    for (const markup of [waiting, one, none, draw(some(5))]) {
      expect(markup).not.toContain("Show more");
      expect(markup).toContain('<div class="stats-head"><h2 id="stats-recent" class="stats-heading">Recent swaps</h2></div>');
    }
  });

  it("no part of the page is given a name that hides the words it shows", () => {
    /** Every element with a name of its own whose visible words are not part of that name. */
    const hidden = (markup: string) =>
      [...markup.matchAll(/<(\w+)\b[^>]*\baria-label="([^"]*)"[^>]*>(.*?)<\/\1>/g)]
        .map((match) => ({ name: match[2]!, shown: words(match[3]!.replace(/<(\w+)[^>]*(?:class="sr-only"|aria-hidden="true")[^>]*>.*?<\/\1>/g, " ")).trim() }))
        .filter((item) => item.shown !== "" && !item.name.toLowerCase().includes(item.shown.toLowerCase()));
    const stats: StatsResponse = { ...some(20), chainsUsed: [{ chain: "base", swaps: 20, share: 100 }], feed: Array.from({ length: 20 }, (_, index) => ({ ...row(index + 1), tx: txOn("base", `named ${index}`) })) };
    for (const markup of [draw(null), draw(stats), draw(some(0))]) expect(hidden(markup)).toEqual([]);
    // A used chain's button is named by the chain's own name, as it is shown.
    expect(draw(stats)).toMatch(/<button type="button" class="stats-chains-item" data-used="" aria-pressed="false" style="--i:0">(?:(?!aria-label).)*<span>Base<\/span><\/button>/);
    // The check can fail: a link named over its visible hash is found.
    expect(hidden('<a href="/x" aria-label="Deposit transaction on Base, opens in a new tab">0x12ab…9f3c<svg aria-hidden="true"></svg></a>')).toEqual([{ name: "Deposit transaction on Base, opens in a new tab", shown: "0x12ab…9f3c" }]);
    expect(hidden('<a href="/x" aria-label="0x12ab…9f3c, deposit transaction on Base">0x12ab…9f3c</a>')).toEqual([]);
  });
});

describe("the switch, and practice mode", () => {
  let running: Booted[] = [];
  afterEach(async () => {
    await Promise.all(running.map((b) => new Promise<void>((resolve) => (b.server.listening ? b.stop(resolve) : resolve()))));
    running = [];
  });
  // A pretend outside world: the provider's coin list works, everything else is unreachable.
  const network: typeof fetch = async (input) => {
    if (String(input).includes("/v0/tokens")) return new Response(JSON.stringify(FIXTURE_TOKENS));
    throw new Error("unreachable in tests");
  };
  /** A whole server, started as the entry point starts it, on a folder and a built page of its own. */
  async function server(env: Record<string, string>, dataDir = tempDir()): Promise<{ url: string; dataDir: string; get(address: string): Promise<{ status: number; text: string; json: any }> }> {
    const siteDir = tempDir();
    fs.writeFileSync(path.join(siteDir, "index.html"), `<!doctype html>\n<html lang="en">\n<head><title>IntentSwap</title></head><body><div id="root"></div></body></html>`);
    const booted = boot({ env: { NODE_ENV: "development", DATA_DIR: dataDir, PORT: String(20000 + Math.floor(Math.random() * 20000)), ...env }, log: createLogger(() => undefined), fetchImpl: network, siteDir, now: () => NOON + 5 * MINUTE });
    running.push(booted);
    const { port } = await new Promise<AddressInfo>((resolve) => booted.start(() => resolve(booted.server.address() as AddressInfo)));
    const url = `http://127.0.0.1:${port}`;
    return {
      url,
      dataDir,
      async get(address) {
        const res = await fetch(url + address);
        const text = await res.text();
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          // A page, not data.
        }
        return { status: res.status, text, json };
      },
    };
  }

  it("STATS_PAGE off: the link, the page's address and its data route are gone, like any that never were; on, all three are there", async () => {
    const off = await server({ STATS_PAGE: "off", SITE_URL: "http://127.0.0.1" });
    expect((await off.get("/api/config")).json.statsPage).toBe(false);
    const route = await off.get("/api/stats");
    const none = await off.get("/api/no-such-route");
    expect(route.status).toBe(404);
    expect(route.text).toBe(none.text);
    const page = await off.get("/stats");
    expect(page.status).toBe(404);
    expect(page.text).toBe((await off.get("/no-such-page")).text);
    // The page it serves says so from its first byte, so that no link is drawn and taken away again.
    expect(page.text).toContain('<html lang="en" data-stats="off">');
    expect(navItems(statsPageOn({ statsPage: false })).map((item) => item.label)).toEqual(["Swap", "Track order", "Rewards", "Docs"]);

    const on = await server({ SITE_URL: "http://127.0.0.1" });
    expect((await on.get("/api/config")).json.statsPage).toBe(true);
    expect((await on.get("/api/stats")).status).toBe(200);
    const shown = await on.get("/stats");
    expect(shown.status).toBe(200);
    expect(shown.text).toContain('<html lang="en">');
    expect(shown.text).toContain('<link rel="canonical" href="http://127.0.0.1/stats" />');
    expect(navItems(statsPageOn({ statsPage: true })).map((item) => `${item.label} ${item.href}`)).toEqual(["Swap /", "Track order /track", "Rewards /rewards", "Stats /stats", "Docs /docs"]);
    // Settings that say nothing of it, as from a server that has no such page: no link.
    expect(navItems(statsPageOn({}))).toHaveLength(4);
  });

  it("a practice server has made-up swaps to show, added once, each a sending side with a hash that is plainly no real one; a server that is not one has none", async () => {
    const practice = await server({ PROVIDER_STUB: "true" });
    const stats = (await practice.get("/api/stats")).json as StatsResponse;
    expect(stats.totals.swaps).toBeGreaterThan(2000);
    expect(stats.totals.volume24hUsd).toBeGreaterThan(1000);
    expect(stats.coins).toHaveLength(5);
    expect(stats.chains).toHaveLength(5);
    // Several chains have been sent from, each with its swaps, so the grid of chains shows some lit and some not.
    expect(stats.chainsUsed.length).toBeGreaterThanOrEqual(5);
    expect(stats.totals.chains).toBe(stats.chainsUsed.length);
    expect(stats.chainsUsed.every((used) => used.swaps > 100)).toBe(true);
    // Twenty rows: an amount and a moment to each, and one figure repeated from end to end for a hash.
    expect(stats.feed).toHaveLength(20);
    for (const row of stats.feed) {
      expect(Object.keys(row).sort()).toEqual(["amount", "at", "coin", "tx"]);
      expect(BigInt(row.amount)).toBeGreaterThan(0n);
      expect(row.at).toMatch(/^2026-10-0[78]T\d{2}:\d{2}:\d{2}Z$/);
      expect(row.tx).toMatch(/^(?:0x)?([1-9])\1{63,}$/);
    }
    expect([...stats.feed].map((row) => row.at).sort().reverse()).toEqual(stats.feed.map((row) => row.at));
    // The folder says what it holds, and the live site does not start on it (see boot.test.ts).
    expect(fs.existsSync(path.join(practice.dataDir, "rewards", "SAMPLE-CONTENT"))).toBe(true);
    // Started again at the same moment, it adds nothing: each quarter of an hour is filled once.
    await new Promise<void>((resolve) => running.pop()!.stop(resolve));
    const again = await server({ PROVIDER_STUB: "true" }, practice.dataDir);
    expect(((await again.get("/api/stats")).json as StatsResponse).totals).toEqual(stats.totals);

    const plain = await server({});
    expect((await plain.get("/api/stats")).json).toEqual({ totals: { swaps: 0, volumeUsd: 0, volume24hUsd: 0, chains: 0, deliverySeconds: null }, coins: [], received: null, chains: [], chainsUsed: [], feed: [] });
    expect(fs.readdirSync(path.join(plain.dataDir, "stats")).filter((name) => name !== "stats.json")).toEqual([]);
  });
});
