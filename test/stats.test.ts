// The Stats page's figures: what is counted, what is kept, and what can never reach the page.
//
// Orders are made here with every address, hash, amount and time known, put through the order
// store as the server puts them, and the totals are then read the way a visitor reads them.

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
import { bandOf, createStats, shareOf, showQuarter, whenOf, QUARTER_MS, type Stats, type StatsFile } from "../server/stats.ts";
import { createOrderStore, type OrderRecord, type OrderState, type OrderStore } from "../server/store.ts";
import { formatExact } from "../shared/amounts.ts";
import type { CoinRef, Confidentiality, OrderStatus, StatsResponse } from "../shared/api.ts";
import { chainGrid, statsPageOn } from "../web/src/lib/stats-logic.ts";
import { ChainGrid, StatsContent } from "../web/src/pages/StatsPage.tsx";
import { navItems } from "../web/src/router.ts";
import { FIXTURE_TOKENS, harness, type Harness } from "./helpers.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Noon on a Thursday, on the quarter of an hour. */
const NOON = Date.parse("2026-10-08T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const ETH: CoinRef = { id: "nep141:base.omft.near", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null };
const USDT: CoinRef = { id: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", symbol: "USDT", name: "Tether USD", chain: "sol", decimals: 6, contract: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" };
const USDC: CoinRef = { id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", symbol: "USDC", name: "USD Coin", chain: "arb", decimals: 6, contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" };
const BTC: CoinRef = { id: "1cs_v1:btc:native:coin", symbol: "BTC", name: "Bitcoin", chain: "btc", decimals: 8, contract: null };

// Everything about an order that must never reach the Stats page. Made up from fixed text: nobody's.
const made = (label: string, bytes: number) => createHash("sha256").update(`stats test ${label}`).digest("hex").slice(0, bytes * 2);
const SECRET = {
  recipient: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  refundTo: `0x${made("refund", 20)}`,
  sender: `0x${made("sender", 20)}`,
  rewards: `0x${made("rewards", 20)}`,
  memo: "memo-4471-0098",
  amountIn: "512345678901234567",
  amountOut: "1236154321",
};

interface Swap {
  usd?: string;
  from?: CoinRef;
  to?: CoinRef;
  /** How long before its delivery the order was made, in seconds. */
  took?: number;
  confidentiality?: Confidentiality;
}

const orderId = (n: number) => `StatsTestOrder${String(n).padStart(13, "0")}`;

/** An order as it is made: waiting, with every field a real one has. */
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
    amountIn: SECRET.amountIn,
    amountOut: SECRET.amountOut,
    minAmountOut: "1223792777",
    amountInUsd: swap.usd ?? "1240.82",
    amountOutUsd: "1236.15",
    slippageBps: 100,
    timeEstimate: 45,
    fees: { appBps: 20, providerBps: 20, appAmount: "1024691357802469", providerAmount: "1024691357802469" },
    withdrawFee: null,
    refundFee: null,
    recipient: SECRET.recipient,
    refundTo: SECRET.refundTo,
    sender: SECRET.sender,
    rewardsAddress: SECRET.rewards,
    confidentiality: swap.confidentiality ?? "public",
    depositAddress: `0x${made(`deposit ${n}`, 20)}`,
    depositMemo: SECRET.memo,
    deadline: iso(createdAt + 30 * MINUTE),
    termsVersion: "test",
    screening: { result: "clear", listVersion: "test", checkedAt: iso(createdAt) },
    quoteResponse: { quote: { depositAddress: `0x${made(`deposit ${n}`, 20)}` }, signature: `ed25519:${made(`signature ${n}`, 32)}` },
    state: { status: "waiting", upstreamStatus: "PENDING_DEPOSIT", statusSince: iso(createdAt), updatedAt: iso(createdAt), anchor: createdAt, depositTxHash: null, depositVerified: false, depositForwarded: false, details: null, finishedAt: null, stopped: false, slowAlertSent: false },
  };
}

/** The same order's state once it has ended, as the poller writes it. */
function ended(record: OrderRecord, at: number, status: OrderStatus = "delivered"): OrderState {
  const n = record.id.slice(-4);
  const paid = `0x${made(`paid ${n}`, 32)}`;
  return {
    ...record.state,
    status,
    upstreamStatus: status === "delivered" ? "SUCCESS" : status === "refunded" ? "REFUNDED" : status === "failed" ? "FAILED" : "PENDING_DEPOSIT",
    statusSince: iso(at),
    updatedAt: iso(at),
    depositTxHash: status === "expired" ? null : paid,
    depositVerified: status !== "expired",
    depositForwarded: status !== "expired",
    details: status === "expired" ? null : { originTxs: [{ hash: paid, url: null }], destinationTxs: status === "delivered" ? [{ hash: made(`delivery ${n}`, 32), url: null }] : [], depositedAmount: record.amountIn, amountIn: record.amountIn, amountOut: status === "delivered" ? record.amountOut : null, refundedAmount: status === "refunded" ? record.amountIn : null, refundReason: null },
    finishedAt: iso(at),
  };
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
}

/**
 * The totals and the order store, wired as the server wires them, on a clock the test moves. Given
 * a folder that has been used before, it is that server started again: every order on disk is put
 * to the totals once more.
 */
function site(options: { dir?: string; feedMin?: number; random?: () => number; t?: number } = {}): Site {
  const dir = options.dir ?? tempDir();
  const clock = { t: options.t ?? NOON };
  const stats = createStats(dir, { feedMin: options.feedMin ?? 10, now: () => clock.t, ...(options.random ? { random: options.random } : {}) });
  const store: OrderStore = createOrderStore(dir, { onState: (record) => void stats.recordDelivered(record, () => store.markCounted(record.id)) });
  for (const id of store.ids()) {
    const record = store.get(id);
    if (record !== null) stats.recordDelivered(record, () => store.markCounted(id), false);
  }
  stats.save();
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
    file: () => JSON.parse(fs.readFileSync(path.join(dir, "stats", "stats.json"), "utf8")) as StatsFile,
  };
}

describe("the totals", () => {
  it("count delivered swaps: how many, their dollar value, the chains, the time taken, the pairs", () => {
    const s = site();
    s.clock.t = NOON + 2 * MINUTE;
    s.end(1, { usd: "1240.82", took: 40 });
    s.clock.t = NOON + 7 * MINUTE;
    s.end(2, { usd: "249.91", took: 61, from: USDC, to: ETH });
    s.end(3, { usd: "99.999999", took: 30 });
    // The provider gave no dollar value: a swap with no volume.
    s.end(4, { usd: "", took: 100, from: BTC, to: USDC });
    // What was refunded, failed or ran out adds nothing.
    s.end(5, {}, "refunded");
    s.end(6, {}, "failed");
    s.end(7, {}, "expired");

    // What is shown moves on the quarter of an hour, and not before.
    expect(s.at(NOON + 14 * MINUTE + 59_999).totals.swaps).toBe(0);
    const shown = s.at(NOON + 15 * MINUTE);
    expect(shown.totals).toEqual({ swaps: 4, volumeUsd: 1590, volume24hUsd: 1590, chains: 4, deliverySeconds: 58 });
    expect(shown.pairs).toEqual([
      { from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDT", chain: "sol" }, volumeUsd: 1340 },
      { from: { symbol: "USDC", chain: "arb" }, to: { symbol: "ETH", chain: "base" }, volumeUsd: 249 },
    ]);
    // A swap counts for the chain it starts on and the chain it ends on.
    expect(shown.chains).toEqual([
      { chain: "base", name: "Base", volumeUsd: 1590 },
      { chain: "sol", name: "Solana", volumeUsd: 1340 },
      { chain: "arb", name: "Arbitrum", volumeUsd: 249 },
    ]);
  });

  it("a chain's swaps: one for the chain a swap left and one for the chain it arrived on, one only when both are the same chain, none for an order that was not delivered", () => {
    const s = site();
    s.end(1, { usd: "600", from: ETH, to: USDT });
    // From Base to Base.
    s.end(2, { usd: "300", from: ETH, to: { ...USDC, chain: "base" } });
    s.end(3, { usd: "100", from: USDC, to: BTC });
    // The provider gave no dollar value: the swap is counted for its chains, with no volume.
    s.end(4, { usd: "", from: BTC, to: { ...ETH, chain: "eth" } });
    // What was refunded, failed or ran out is counted for no chain, a chain nothing else used among them.
    s.end(5, { from: { ...ETH, chain: "op" }, to: USDT }, "refunded");
    s.end(6, { from: BTC, to: USDT }, "failed");
    s.end(7, { from: USDC, to: BTC }, "expired");

    const shown = s.at(NOON + 15 * MINUTE);
    // In the order of the chains' codes, each with its share of the $1,000 delivered.
    expect(shown.chainsUsed).toEqual([
      { chain: "arb", swaps: 1, share: 10 },
      { chain: "base", swaps: 2, share: 90 },
      { chain: "btc", swaps: 2, share: 10 },
      { chain: "eth", swaps: 1, share: 0 },
      { chain: "sol", swaps: 1, share: 60 },
    ]);
    // The "Chains used" figure is the length of that list.
    expect(shown.totals.chains).toBe(5);
    expect(shown.totals.chains).toBe(shown.chainsUsed.length);
    // The share is of the very sum the list of top chains shows in dollars.
    expect(shown.chains.map((item) => [item.chain, item.volumeUsd])).toEqual([["base", 900], ["sol", 600], ["arb", 100], ["btc", 100]]);
    // Kept beside the volume, and whole after a restart.
    expect(s.file().chainSwaps).toEqual({ base: 2, sol: 1, arb: 1, btc: 2, eth: 1 });
    expect(site({ dir: s.dir, t: NOON + 15 * MINUTE }).stats.view().chainsUsed).toEqual(shown.chainsUsed);
  });

  it("a chain's share of volume is whole per cent, rounded down; under one per cent it is said to be under one, and not nothing", () => {
    expect([shareOf(31n, 100n), shareOf(319_999n, 1_000_000n), shareOf(999_999n, 1_000_000n), shareOf(1_000_000n, 1_000_000n), shareOf(10_000n, 1_000_000n)]).toEqual([31, 31, 99, 100, 1]);
    expect([shareOf(1n, 1_000_000n), shareOf(9_999n, 1_000_000n)]).toEqual(["<1", "<1"]);
    // No volume: nothing of something, and anything of nothing.
    expect([shareOf(0n, 1_000_000n), shareOf(0n, 0n)]).toEqual([0, 0]);

    const s = site();
    s.end(1, { usd: "99999.5", from: ETH, to: USDT });
    s.end(2, { usd: "0.5", from: USDC, to: BTC });
    expect(s.at(NOON + 15 * MINUTE).chainsUsed).toEqual([
      { chain: "arb", swaps: 1, share: "<1" },
      { chain: "base", swaps: 1, share: 99 },
      { chain: "btc", swaps: 1, share: "<1" },
      { chain: "sol", swaps: 1, share: 99 },
    ]);
    // Swaps with no dollar value at all: each chain has its swaps, and no share of nothing.
    const none = site();
    none.end(1, { usd: "" });
    expect(none.at(NOON + 15 * MINUTE)).toMatchObject({ totals: { swaps: 1, volumeUsd: 0, chains: 2 }, chainsUsed: [{ chain: "base", swaps: 1, share: 0 }, { chain: "sol", swaps: 1, share: 0 }] });
  });

  it("a file kept before swaps were counted by chain is read: its totals stand, its chains begin with no swaps, and what it kept by the day is dropped", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "stats"), { recursive: true });
    const coin = (symbol: string, chain: string) => ({ symbol, chain });
    const before = {
      v: 1,
      swaps: 7,
      volumeMicro: "2000000000",
      deliverySeconds: 280,
      deliveriesTimed: 7,
      chains: { base: "2000000000", sol: "500000000" },
      pairs: [{ from: coin("ETH", "base"), to: coin("USDT", "sol"), volumeMicro: "500000000" }],
      days: { [String(Math.floor(NOON / DAY))]: "2000000000" },
      hours: { [String(Math.floor(NOON / HOUR) - 1)]: { swaps: 7, volumeMicro: "2000000000" } },
      rows: [],
    };
    fs.writeFileSync(path.join(dir, "stats", "stats.json"), JSON.stringify(before));
    const s = site({ dir });
    expect(s.stats.setAside).toBe(false);
    expect(fs.readdirSync(path.join(dir, "stats"))).toEqual(["stats.json"]);
    const shown = s.at(NOON + 15 * MINUTE);
    expect(shown.totals).toEqual({ swaps: 7, volumeUsd: 2000, volume24hUsd: 2000, chains: 2, deliverySeconds: 40 });
    expect(shown.chainsUsed).toEqual([{ chain: "base", swaps: 0, share: 100 }, { chain: "sol", swaps: 0, share: 25 }]);
    // Written again, it is a file of today's kind: counts by chain, and nothing by the day.
    expect(Object.keys(s.file()).sort()).toEqual(["chainSwaps", "chains", "deliveriesTimed", "deliverySeconds", "hours", "pairs", "rows", "swaps", "v", "volumeMicro"]);
    expect(s.file().chainSwaps).toEqual({ base: 0, sol: 0 });
    // A swap delivered from now on is counted on top of what was there.
    s.end(1, { usd: "2000", from: ETH, to: BTC });
    expect(s.at(NOON + 30 * MINUTE).chainsUsed).toEqual([{ chain: "base", swaps: 1, share: 100 }, { chain: "btc", swaps: 1, share: 50 }, { chain: "sol", swaps: 0, share: 12 }]);
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
    expect(s.at(NOON + 15 * MINUTE).totals).toMatchObject({ swaps: 1, volumeUsd: 300 });

    // The server is started again on the same folder, and goes over every order on disk.
    const again = site({ dir: s.dir, t: NOON + 20 * MINUTE });
    expect(again.at(NOON + 30 * MINUTE)).toEqual(s.at(NOON + 30 * MINUTE));
    expect(again.stats.view().totals).toEqual({ swaps: 1, volumeUsd: 300, volume24hUsd: 300, chains: 2, deliverySeconds: 40 });
    // A delivery that was saved a moment before a stop, and never told to the totals, is counted at the next start.
    const missed = order(2, NOON + 21 * MINUTE, { usd: "50" });
    fs.writeFileSync(path.join(s.dir, "orders", `${missed.id}.json`), JSON.stringify({ ...missed, state: ended(missed, NOON + 22 * MINUTE) }));
    const third = site({ dir: s.dir, t: NOON + 25 * MINUTE });
    expect(third.at(NOON + 30 * MINUTE).totals).toMatchObject({ swaps: 2, volumeUsd: 350 });
    expect(site({ dir: s.dir, t: NOON + 26 * MINUTE }).at(NOON + 30 * MINUTE).totals).toMatchObject({ swaps: 2, volumeUsd: 350 });
  });
});

describe("what is kept and sent holds nothing of any one order", () => {
  it("a swap's size is one of four bands, each including its lower bound", () => {
    const usd = (dollars: number, micro = 0) => BigInt(dollars) * 1_000_000n + BigInt(micro);
    expect([usd(0), usd(99, 999_999), usd(100), usd(999, 999_999), usd(1000), usd(9999, 999_999), usd(10_000), usd(5_000_000)].map(bandOf)).toEqual(["under-100", "under-100", "100-1k", "100-1k", "1k-10k", "1k-10k", "over-10k", "over-10k"]);
  });

  describe.each(["public", "basic"] as const)("with swaps routed as %s", (mode) => {
    let h: Harness;
    afterEach(async () => {
      await h.close();
    });

    it("no address, hash, order ID, amount or time of an order is in the files or in what the page is sent", async () => {
      h = await harness({ env: { PRIVACY_MODE: mode, STATS_FEED_MIN: "3" } });
      const records: OrderRecord[] = [];
      const times: number[] = [];
      [
        { usd: "1240.82" },
        { usd: "249.91", from: USDC, to: ETH },
        { usd: "61.07", from: BTC, to: USDC },
        { usd: "12870.5", from: ETH, to: BTC },
      ].forEach((swap, index) => {
        const createdAt = h.clock.t + index * 61_003;
        const record = order(index + 1, createdAt, { ...swap, confidentiality: mode });
        h.store.create(record);
        h.clock.t = createdAt + 47_219;
        h.store.saveState(record.id, ended(record, h.clock.t));
        records.push(h.store.get(record.id)!);
        times.push(createdAt, h.clock.t, createdAt + 30 * MINUTE);
      });
      // Long enough for every row to be on show.
      h.clock.t += 45 * MINUTE;
      const reply = await h.get("/api/stats");
      expect(reply.status).toBe(200);
      const sent = reply.text;
      const statsDir = path.join(h.dataDir, "stats");
      const kept = fs.readdirSync(statsDir).map((name) => fs.readFileSync(path.join(statsDir, name), "utf8")).join("\n");
      // The check has something to check: the swaps are counted and listed.
      expect(reply.body.totals.swaps).toBe(4);
      expect(reply.body.feed).toHaveLength(4);
      expect(kept).toContain('"rows":[{');

      const never = new Set<string>();
      for (const record of records) {
        const details = record.state.details!;
        for (const text of [record.id, hashId(record.id), createHash("sha256").update(record.id).digest("hex"), record.recipient, record.refundTo, record.sender!, record.rewardsAddress!, record.depositAddress, record.depositMemo!, record.state.depositTxHash!, details.originTxs[0]!.hash, details.destinationTxs[0]!.hash]) never.add(text);
        // Amounts, as they are stored and as a person reads them, in and out, and their dollar values.
        for (const text of [record.amountIn, record.amountOut, record.minAmountOut, formatExact(BigInt(record.amountIn), record.from.decimals), formatExact(BigInt(record.amountOut), record.to.decimals), record.amountInUsd, record.amountOutUsd]) never.add(text);
        for (const text of [record.createdAt, record.deadline, record.state.finishedAt!, record.state.statusSince]) never.add(text);
      }
      // Times, as numbers too: in milliseconds and in seconds.
      for (const ms of times) for (const text of [String(ms), String(Math.floor(ms / 1000))]) never.add(text);
      expect(never.size).toBeGreaterThan(60);
      for (const [where, text] of [["the files", kept], ["the answer", sent]] as const) {
        for (const secret of never) expect(text.includes(secret), `${where} hold ${secret}`).toBe(false);
        for (const secret of never) expect(text.toLowerCase().includes(secret.toLowerCase()), `${where} hold ${secret} in other letters`).toBe(false);
        // And nothing of the shape of any of them: no address or hash in hex, no run of letters and
        // figures long enough to be an address, a hash or an order's ID, no time of day, no date with
        // a time, and no figure with a decimal point.
        expect(text).not.toMatch(/0x[0-9a-fA-F]{6,}/);
        expect(text).not.toMatch(/[A-Za-z0-9_-]{24,}/);
        expect(text).not.toMatch(/\d{1,2}:\d{2}/);
        expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
        expect(text).not.toMatch(/\d\.\d/);
      }

      // What is there instead, part by part.
      expect(Object.keys(reply.body).sort()).toEqual(["chains", "chainsUsed", "feed", "pairs", "totals"]);
      for (const used of reply.body.chainsUsed) expect(Object.keys(used).sort()).toEqual(["chain", "share", "swaps"]);
      for (const row of reply.body.feed) {
        expect(Object.keys(row).sort()).toEqual(["band", "from", "to", "when"]);
        expect(Object.keys(row.from).sort()).toEqual(["chain", "symbol"]);
        expect(Object.keys(row.to).sort()).toEqual(["chain", "symbol"]);
      }
      expect(reply.body.feed.map((row: { band: string }) => row.band).sort()).toEqual(["100-1k", "1k-10k", "over-10k", "under-100"]);
      const file = JSON.parse(fs.readFileSync(path.join(statsDir, "stats.json"), "utf8")) as StatsFile;
      expect(Object.keys(file).sort()).toEqual(["chainSwaps", "chains", "deliveriesTimed", "deliverySeconds", "hours", "pairs", "rows", "swaps", "v", "volumeMicro"]);
      for (const row of file.rows) {
        expect(Object.keys(row).sort()).toEqual(["band", "from", "quarter", "to"]);
        expect(Object.keys(row.from).sort()).toEqual(["chain", "symbol"]);
        // The one time a row has: a quarter of an hour, at least fifteen minutes after any of the deliveries.
        expect(Number.isInteger(row.quarter)).toBe(true);
      }
      // The same headers as any other answer, and the route's own limit.
      expect(reply.headers.get("content-security-policy")).toBe((await h.get("/api/status")).headers.get("content-security-policy"));
      expect(reply.headers.get("cache-control")).toBe("no-store");
    });
  });

  it("a coin's name is cut to a length no address fits in, whatever the coin list says", () => {
    const s = site({ feedMin: 1 });
    s.end(1, { usd: "10", from: { ...ETH, symbol: SECRET.refundTo }, to: { ...USDT, chain: SECRET.recipient } });
    const text = JSON.stringify(s.file()) + JSON.stringify(s.at(NOON + 30 * MINUTE));
    expect(text).not.toContain(SECRET.refundTo);
    expect(text).not.toContain(SECRET.recipient);
    expect(text).not.toMatch(/[A-Za-z0-9_-]{24,}/);
  });
});

/** A page's words, without its markup. */
const words = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** A coin list's chains, as the page is handed them: in the order the coin picker offers them. */
const LISTED = [{ key: "bsc", name: "BNB Chain" }, { key: "eth", name: "Ethereum" }, { key: "sol", name: "Solana" }, { key: "base", name: "Base" }, { key: "qtc", name: "Quantus" }];

describe("chains used", () => {
  const stats: StatsResponse = { totals: { swaps: 13, volumeUsd: 1500, volume24hUsd: 400, chains: 2, deliverySeconds: 72 }, pairs: [], chains: [], chainsUsed: [{ chain: "base", swaps: 12, share: 31 }, { chain: "sol", swaps: 1, share: "<1" }], feed: null };
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
    expect(renderToStaticMarkup(createElement(StatsContent, { stats, chains: [] }))).not.toContain("stats-chains");
  });

  it("a chosen chain's swaps and share of volume are said in the one line above the grid, and nothing of an unused chain", () => {
    const line = (chosen: string | null, used = stats.chainsUsed) => /<p class="stats-chains-line muted" aria-live="polite">(.*?)<\/p>/.exec(renderToStaticMarkup(createElement(ChainGrid, { chains: chainGrid(LISTED, used), count: used.length, chosen, onChoose: () => undefined })))?.[1];
    expect(line("base")).toBe("Base: 12 swaps, 31% of volume");
    expect(line("sol")).toBe("Solana: 1 swap, under 1% of volume");
    expect(line("base", [{ chain: "base", swaps: 12_345, share: 0 }])).toBe("Base: 12,345 swaps, 0% of volume");
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
  it("a row is first shown on the quarter of an hour that comes at least fifteen minutes after its delivery", () => {
    const at = (text: string) => Date.parse(`2026-10-08T${text}Z`);
    expect(showQuarter(at("12:03:00")) * QUARTER_MS).toBe(at("12:30:00"));
    expect(showQuarter(at("12:00:00")) * QUARTER_MS).toBe(at("12:15:00"));
    expect(showQuarter(at("12:00:00.001")) * QUARTER_MS).toBe(at("12:30:00"));
    expect(showQuarter(at("12:14:59.999")) * QUARTER_MS).toBe(at("12:30:00"));

    const s = site({ feedMin: 1 });
    s.clock.t = at("12:03:00");
    s.end(1, { usd: "150" });
    // Counted, and the list is there, but the row is not on it until its quarter.
    expect(s.at(at("12:15:00"))).toMatchObject({ totals: { swaps: 1 }, feed: [] });
    expect(s.at(at("12:29:59.999")).feed).toEqual([]);
    expect(s.at(at("12:30:00")).feed).toEqual([{ from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDT", chain: "sol" }, band: "100-1k", when: "last-hour" }]);
  });

  it("a row says when in three words, is left out once it is older than yesterday, and stands in mixed order within its words", () => {
    const at = (day: number, text: string) => Date.parse(`2026-10-0${day}T${text}:00Z`);
    const first = site({ feedMin: 1, random: () => 0.999999, t: at(6, "12:30") });
    // Each of a size of its own, so that it can be told in the list.
    first.end(1, { usd: "20000" });
    first.clock.t = at(7, "10:00");
    first.end(2, { usd: "5" });
    first.clock.t = at(7, "23:50");
    first.end(3, { usd: "500" });
    first.clock.t = at(8, "09:00");
    first.end(4, { usd: "5000" });
    first.clock.t = at(8, "10:05");
    first.end(5, { usd: "50000" });
    first.clock.t = at(8, "11:20");
    first.end(6, { usd: "7", from: USDC, to: ETH });
    first.clock.t = at(8, "11:40");
    first.end(7, { usd: "700", from: USDC, to: ETH });
    // Delivered ten minutes ago: not on the list.
    first.clock.t = at(8, "11:50");
    first.end(8, { usd: "7000", from: USDC, to: ETH });

    const said = (stats: StatsResponse) => (stats.feed ?? []).map((row) => `${row.when} ${row.from.symbol} ${row.band}`);
    // Left as they are kept (the source of chance always answers "the last one").
    expect(said(first.at(at(8, "12:00")))).toEqual(["last-hour USDC under-100", "last-hour USDC 100-1k", "earlier-today ETH 1k-10k", "earlier-today ETH over-10k", "yesterday ETH under-100", "yesterday ETH 100-1k"]);
    // The same rows from the same file, with another source of chance: each group in another order, and the groups where they were.
    const second = site({ dir: first.dir, feedMin: 1, random: () => 0, t: at(8, "12:00") });
    expect(said(second.stats.view())).toEqual(["last-hour USDC 100-1k", "last-hour USDC under-100", "earlier-today ETH over-10k", "earlier-today ETH 1k-10k", "yesterday ETH 100-1k", "yesterday ETH under-100"]);
    // An hour on, the last two have left "the last hour"; at midnight "earlier today" is "yesterday", and yesterday's are gone.
    expect(said(first.at(at(8, "13:00"))).filter((row) => row.startsWith("last-hour"))).toEqual([]);
    expect(said(first.at(at(9, "00:00")))).toEqual(["yesterday ETH 1k-10k", "yesterday ETH over-10k", "yesterday USDC under-100", "yesterday USDC 100-1k", "yesterday USDC 1k-10k"]);
    expect(whenOf(100, 99)).toBeNull();

    // Rows are kept in an order of their own, not the order they were delivered in.
    const order = site({ feedMin: 1 });
    order.end(1, { usd: "5000" });
    order.end(2, { usd: "50" });
    order.end(3, { usd: "500" });
    expect(order.file().rows.map((row) => row.band)).toEqual(["100-1k", "1k-10k", "under-100"]);
    // Rows older than 48 hours are not kept.
    order.clock.t = NOON + 2 * DAY + 30 * MINUTE;
    order.end(4, { usd: "50000" });
    expect(order.file().rows.map((row) => row.band)).toEqual(["over-10k"]);
  });

  it("the list is not there at all while fewer than STATS_FEED_MIN swaps were delivered in the last 24 hours", async () => {
    const s = site();
    for (let n = 1; n <= 9; n++) s.end(n, { usd: "150" });
    expect(s.at(NOON + 30 * MINUTE)).toMatchObject({ totals: { swaps: 9 }, feed: null });
    s.end(10, { usd: "150" });
    expect(s.at(NOON + HOUR).feed).toHaveLength(10);
    // A day on, the ten are outside the 24 hours: two more are not enough.
    s.clock.t = NOON + DAY + 20 * MINUTE;
    s.end(11, { usd: "150" });
    s.end(12, { usd: "150" });
    expect(s.at(NOON + DAY + HOUR)).toMatchObject({ totals: { swaps: 12 }, feed: null });

    // The setting: ten unless it says otherwise, and the server answers by it.
    const h = await harness({ env: { STATS_FEED_MIN: "2" } });
    try {
      expect(h.config.statsFeedMin).toBe(2);
      const one = order(1, h.clock.t - 40_000);
      h.store.create(one);
      h.store.saveState(one.id, ended(one, h.clock.t));
      h.clock.t += 30 * MINUTE;
      expect((await h.get("/api/stats")).body.feed).toBeNull();
      const two = order(2, h.clock.t - 40_000);
      h.store.create(two);
      h.store.saveState(two.id, ended(two, h.clock.t));
      h.clock.t += 30 * MINUTE;
      expect((await h.get("/api/stats")).body.feed).toHaveLength(2);
    } finally {
      await h.close();
    }
  });

  it("the page draws no list, and nothing in its place, while it is sent none", () => {
    const stats: StatsResponse = { totals: { swaps: 3, volumeUsd: 1500, volume24hUsd: 400, chains: 2, deliverySeconds: 72 }, pairs: [{ from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDT", chain: "sol" }, volumeUsd: 1500 }], chains: [{ chain: "base", name: "Base", volumeUsd: 1500 }], chainsUsed: [{ chain: "base", swaps: 3, share: 100 }, { chain: "sol", swaps: 3, share: 100 }], feed: null };
    const without = renderToStaticMarkup(createElement(StatsContent, { stats, chains: LISTED }));
    expect(words(without)).toContain("Top pairs");
    expect(words(without)).not.toMatch(/Recent swaps|rounded|in the last hour/);
    expect(without).not.toContain("stats-swap");
    const withRows = words(renderToStaticMarkup(createElement(StatsContent, { stats: { ...stats, feed: [{ from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDT", chain: "sol" }, band: "100-1k", when: "earlier-today" }] }, chains: LISTED })));
    expect(withRows).toContain("Recent swaps");
    expect(withRows).toContain("ETH on Base to USDT on Solana $100 to $1k earlier today");
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

  it("a practice server has made-up swaps to show, added once; a server that is not one has none", async () => {
    const practice = await server({ PROVIDER_STUB: "true" });
    const stats = (await practice.get("/api/stats")).json as StatsResponse;
    expect(stats.totals.swaps).toBeGreaterThan(2000);
    expect(stats.totals.volume24hUsd).toBeGreaterThan(1000);
    expect(stats.pairs).toHaveLength(5);
    expect(stats.chains).toHaveLength(5);
    // Several chains have been used, each with its swaps, so the grid of chains shows some lit and some not.
    expect(stats.chainsUsed.length).toBeGreaterThanOrEqual(5);
    expect(stats.totals.chains).toBe(stats.chainsUsed.length);
    expect(stats.chainsUsed.every((used) => used.swaps > 100)).toBe(true);
    expect(stats.feed?.length).toBeGreaterThanOrEqual(10);
    // The folder says what it holds, and the live site does not start on it (see boot.test.ts).
    expect(fs.existsSync(path.join(practice.dataDir, "rewards", "SAMPLE-CONTENT"))).toBe(true);
    // Started again at the same moment, it adds nothing: each quarter of an hour is filled once.
    await new Promise<void>((resolve) => running.pop()!.stop(resolve));
    const again = await server({ PROVIDER_STUB: "true" }, practice.dataDir);
    expect(((await again.get("/api/stats")).json as StatsResponse).totals).toEqual(stats.totals);

    const plain = await server({});
    expect((await plain.get("/api/stats")).json).toMatchObject({ totals: { swaps: 0, volumeUsd: 0, volume24hUsd: 0, chains: 0, deliverySeconds: null }, pairs: [], chains: [], chainsUsed: [], feed: null });
    expect(fs.readdirSync(path.join(plain.dataDir, "stats")).filter((name) => name !== "stats.json")).toEqual([]);
  });
});
