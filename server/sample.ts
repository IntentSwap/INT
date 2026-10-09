// Sample content for practice mode: past orders in every end state, points over a few weeks, two
// paid weeks, a reserve with a balance, a token with an address and three months of made-up swaps
// behind the Stats page, so that every screen can be looked at full while testing on one's own machine.
//
// It exists only in practice mode (local development with the practice provider). The live site
// never has it: production refuses to start in practice mode, nothing here runs unless practice
// is on, and a test holds both. A data folder that has been given any of it says so in a note of
// its own (rewards/SAMPLE-CONTENT), and a server that is not in practice mode will not start on
// such a folder. Every address and hash below is made up from fixed text, so they are nobody's.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { toChecksumAddress } from "../shared/addresses.ts";
import type { CoinRef, OrderDetails, OrderStatus } from "../shared/api.ts";
import { explorerTxUrl } from "../shared/chains.ts";
import { pointsMicro, RESERVE_ASSET, sharePool, weekBounds, weekOf } from "../shared/rewards.ts";
import type { Config } from "./config.ts";
import { orderHash, type PointsEntry, type Rewards, type WeekRecord } from "./rewards.ts";
import { QUARTER_MS, type Delivery, type Stats } from "./stats.ts";
import { writeDurable, type OrderRecord, type OrderStore } from "./store.ts";

const made = (label: string, bytes: number) => createHash("sha256").update(`intentswap sample ${label}`).digest("hex").slice(0, bytes * 2);
const address = (label: string) => toChecksumAddress(`0x${made(label, 20)}`);
const hash = (label: string) => `0x${made(label, 32)}`;

/** What a practice server shows where the operator has set nothing yet. */
export const SAMPLE = {
  tokenAddress: address("token"),
  tokenPairAddress: address("pair"),
  reserveAddress: address("reserve"),
  /** What the sample reserve wallet holds: 4.25 BNB, 38.5 of the payout coin and 250,000 of the token. */
  pool: { bnb: 425n * 10n ** 16n, payout: 385n * 10n ** 17n, token: 250_000n * 10n ** 18n },
} as const;

/** Where, inside a data folder, the note is kept that says the folder holds practice content. */
export const SAMPLE_MARKER = path.join("rewards", "SAMPLE-CONTENT");

/** True when a data folder holds practice content: a practice server has put some there at some time. */
export function holdsSampleContent(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, SAMPLE_MARKER));
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** What the other sample addresses swapped last week and the week before, in millionths of a US dollar ($2,000 and $1,250), times one, two or three. */
const OTHERS_USD_MICRO = [2_000_000_000n, 1_250_000_000n] as const;

const COIN: Record<string, CoinRef> = {
  baseEth: { id: "nep141:base.omft.near", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null },
  solUsdt: { id: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", symbol: "USDT", name: "Tether USD", chain: "sol", decimals: 6, contract: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
  arbUsdc: { id: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", symbol: "USDC", name: "USD Coin", chain: "arb", decimals: 6, contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  baseUsdc: { id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", symbol: "USDC", name: "USD Coin", chain: "base", decimals: 6, contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  btc: { id: "1cs_v1:btc:native:coin", symbol: "BTC", name: "Bitcoin", chain: "btc", decimals: 8, contract: null },
  bnb: { id: "nep245:v2_1.omni.hot.tg:56_11111111111111111111", symbol: "BNB", name: "BNB", chain: "bsc", decimals: 18, contract: null },
};

interface Sample {
  n: number;
  status: OrderStatus;
  /** How long ago it was made, and how long it took. */
  daysAgo: number;
  from: CoinRef;
  to: CoinRef;
  amountIn: string;
  amountOut: string;
  usd: string;
  pay: "wallet" | "manual";
  refundReason?: string;
  /** Part of the amount that arrived, for a deposit that was too small. */
  deposited?: string;
}

const SAMPLES: Sample[] = [
  { n: 1, status: "delivered", daysAgo: 1, from: COIN.baseEth!, to: COIN.solUsdt!, amountIn: "500000000000000000", amountOut: "1236150000", usd: "1240.82", pay: "wallet" },
  { n: 2, status: "delivered", daysAgo: 3, from: COIN.arbUsdc!, to: COIN.baseEth!, amountIn: "250000000", amountOut: "100412000000000000", usd: "249.91", pay: "wallet" },
  { n: 3, status: "refunded", daysAgo: 4, from: COIN.baseEth!, to: COIN.arbUsdc!, amountIn: "120000000000000000", amountOut: "297300000", usd: "297.80", pay: "wallet", refundReason: "SLIPPAGE_EXCEEDED" },
  { n: 4, status: "refunded", daysAgo: 6, from: COIN.baseUsdc!, to: COIN.solUsdt!, amountIn: "100000000", amountOut: "99310000", usd: "99.96", pay: "manual", refundReason: "PARTIAL_DEPOSIT", deposited: "40000000" },
  { n: 5, status: "failed", daysAgo: 9, from: COIN.bnb!, to: COIN.arbUsdc!, amountIn: "2000000000000000000", amountOut: "1161200000", usd: "1164.40", pay: "wallet" },
  // Made a few hours ago: an order nothing was sent to is cleared away a day after its deadline, as on the live site.
  { n: 6, status: "expired", daysAgo: 0, from: COIN.btc!, to: COIN.arbUsdc!, amountIn: "1000000", amountOut: "611900000", usd: "613.25", pay: "manual" },
];

/** A made-up order ID of the right shape: 27 characters. */
export const sampleOrderId = (n: number): string => `SampleOrder${String(n).padStart(16, "0")}`;

function sampleOrder(sample: Sample, owner: string, now: number): OrderRecord {
  const created = now - sample.daysAgo * DAY - 2 * HOUR;
  const finished = sample.status === "expired" ? created + 2 * HOUR : created + 4 * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const evm = sample.from.chain !== "btc";
  const refund = evm ? owner : "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
  const paid = hash(`deposit ${sample.n}`);
  const tx = (chain: string, value: string) => [{ hash: value, url: explorerTxUrl(chain, value) }];
  const none: OrderDetails = { originTxs: [], destinationTxs: [], depositedAmount: null, amountIn: null, amountOut: null, refundedAmount: null, refundReason: null };
  const details: OrderDetails | null =
    sample.status === "expired"
      ? null
      : sample.status === "delivered"
        ? { ...none, originTxs: tx(sample.from.chain, paid), destinationTxs: tx(sample.to.chain, hash(`delivery ${sample.n}`)), depositedAmount: sample.amountIn, amountIn: sample.amountIn, amountOut: sample.amountOut }
        : sample.status === "refunded"
          ? { ...none, originTxs: tx(sample.from.chain, paid), depositedAmount: sample.deposited ?? sample.amountIn, refundedAmount: sample.deposited ?? sample.amountIn, refundReason: sample.refundReason ?? null }
          : { ...none, originTxs: tx(sample.from.chain, paid), depositedAmount: sample.amountIn };
  // As on the site: no fee of IntentSwap's, and the provider's own 0.20%.
  const providerAmount = (BigInt(sample.amountIn) * 20n) / 10_000n;
  return {
    v: 1,
    id: sampleOrderId(sample.n),
    createdAt: iso(created),
    pay: sample.pay,
    from: sample.from,
    to: sample.to,
    amountIn: sample.amountIn,
    amountOut: sample.amountOut,
    minAmountOut: ((BigInt(sample.amountOut) * 99n) / 100n).toString(),
    amountInUsd: sample.usd,
    amountOutUsd: sample.usd,
    slippageBps: 100,
    timeEstimate: 45,
    fees: { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: providerAmount.toString() },
    withdrawFee: null,
    refundFee: null,
    recipient: sample.to.chain === "sol" ? "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" : owner,
    refundTo: refund,
    sender: sample.pay === "wallet" ? owner : null,
    rewardsAddress: evm ? owner : null,
    // Every sample order is an ordinary, publicly routed one.
    confidentiality: "public",
    // The Stats page's sample figures are made up by themselves (see sampleDeliveries); these orders are not added to them.
    statsCounted: true,
    depositAddress: evm ? address(`deposit ${sample.n}`) : `bc1q${made(`deposit ${sample.n}`, 19)}`,
    depositMemo: null,
    deadline: iso(created + (sample.pay === "wallet" ? 30 : 60) * 60_000),
    termsVersion: "sample",
    screening: { result: "clear", listVersion: "sample", checkedAt: iso(created) },
    quoteResponse: { sample: true },
    state: {
      status: sample.status,
      upstreamStatus: sample.status === "delivered" ? "SUCCESS" : sample.status === "refunded" ? "REFUNDED" : sample.status === "failed" ? "FAILED" : "PENDING_DEPOSIT",
      statusSince: iso(finished),
      updatedAt: iso(finished),
      anchor: created,
      depositTxHash: sample.status === "expired" ? null : paid,
      depositVerified: sample.status !== "expired" && evm,
      depositForwarded: sample.status !== "expired",
      details,
      finishedAt: iso(finished),
      stopped: false,
      slowAlertSent: false,
    },
  };
}

/** The pairs of the made-up swaps behind the Stats page, the first of them the commonest. */
const SAMPLE_PAIRS: readonly (readonly [string, string, string, string])[] = [
  ["ETH", "base", "USDT", "sol"],
  ["USDC", "arb", "ETH", "base"],
  ["BTC", "btc", "USDC", "arb"],
  ["ETH", "base", "USDT", "sol"],
  ["BNB", "bsc", "USDC", "arb"],
  ["USDC", "base", "USDT", "sol"],
  ["ETH", "eth", "BTC", "btc"],
  ["USDC", "arb", "ETH", "base"],
  ["SOL", "sol", "USDC", "base"],
  ["USDT", "sol", "BNB", "bsc"],
];
/** How far back the made-up swaps go the first time: 90 days, in quarters of an hour. */
const SAMPLE_QUARTERS = 90 * 96;

/**
 * Made-up deliveries for the Stats page, for the quarters of an hour from one to another: one or
 * two to most quarters, of every size, worked out from the quarter's own number, so the same
 * quarter always gives the same swaps and some days are busier than others.
 */
export function sampleDeliveries(fromQuarter: number, toQuarter: number): Delivery[] {
  const out: Delivery[] = [];
  for (let quarter = fromQuarter; quarter <= toQuarter; quarter++) {
    const bytes = createHash("sha256").update(`intentswap sample swaps ${quarter}`).digest();
    const busy = createHash("sha256").update(`intentswap sample day ${Math.floor(quarter / 96)}`).digest()[0]! % 5;
    const count = (quarter % 3 === 0 ? 1 : 0) + (bytes[0]! % 8 < busy ? 1 : 0);
    for (let n = 0; n < count; n++) {
      const at = bytes.subarray(n * 8, n * 8 + 8);
      const pair = SAMPLE_PAIRS[at[0]! % SAMPLE_PAIRS.length]!;
      // Sizes: about half under $100, a third under $1,000, most of the rest under $10,000, and now and then one above.
      const [floor, span] = at[1]! < 120 ? [8, 90] : at[1]! < 205 ? [100, 900] : at[1]! < 249 ? [1_000, 7_000] : [10_000, 24_000];
      const usdMicro = BigInt(floor) * 1_000_000n + (BigInt(at.readUInt32BE(2)) * BigInt(span) * 1_000_000n) / 0x1_0000_0000n;
      out.push({ from: { symbol: pair[0], chain: pair[1] }, to: { symbol: pair[2], chain: pair[3] }, usdMicro, seconds: 22 + (at[6]! % 55), at: quarter * QUARTER_MS + (at.readUInt16BE(6) % 900) * 1000 });
    }
  }
  return out;
}

export interface Samples {
  /** The IDs of the sample orders, newest first: a practice browser lists them under Recent orders. */
  orderIds: string[];
  /** Makes sure an address that signs in on a practice server has something to look at: points over three weeks and two paid weeks. */
  ensureFor(address: string, now: number): void;
  /** Makes sure the Stats page has made-up swaps up to the last quarter of an hour that has ended. Each quarter is filled once. */
  ensureStats(now: number): void;
  /** Makes sure this week has points in it before anyone signs in: three made-up addresses with a swap each. */
  ensureWeek(now: number): void;
  /** What the sample reserve wallet holds, in each coin's smallest unit. The chain is never asked about it. */
  pool: { bnb: bigint; payout: bigint; token: bigint };
}

/**
 * Puts the sample content in place. Only ever in practice mode: called with anything else, it
 * refuses. Safe to run at every start: what is already there is left as it is.
 */
export function seedSamples(options: { practice: boolean; dataDir: string; store: OrderStore; rewards: Rewards; stats?: Stats; now: number }): Samples {
  if (options.practice !== true) throw new Error("sample data is for practice mode only");
  const { store, rewards, stats, dataDir, now } = options;
  // Said first, before anything is put in: the folder now holds made-up orders, points and paid
  // weeks, and only a practice server may start on it (see where server/boot.ts looks for this).
  const marker = path.join(dataDir, SAMPLE_MARKER);
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, "This data folder holds practice content: orders, points, paid weeks and site totals made up for looking at the site.\nA server that is not in practice mode will not start on it.\n", { mode: 0o600 });
  }
  // The made-up swaps behind the Stats page. A note beside the totals says up to which quarter of an
  // hour they have been added, so that a quarter is never added twice, at this start or a later one.
  const through = path.join(dataDir, "stats", "sample-through");
  let filled: number | null = null;
  const ensureStats = (at: number): void => {
    if (stats === undefined) return;
    const last = Math.floor(at / QUARTER_MS) - 1;
    if (filled === null) {
      try {
        filled = Number(fs.readFileSync(through, "utf8"));
      } catch {
        filled = Number.NaN;
      }
    }
    const first = Number.isSafeInteger(filled) ? Math.max(filled + 1, last - SAMPLE_QUARTERS + 1) : last - SAMPLE_QUARTERS + 1;
    if (first > last) return;
    stats.seed(sampleDeliveries(first, last));
    filled = last;
    writeDurable(through, String(last));
  };
  ensureStats(now);
  const owner = address("owner");
  for (const sample of SAMPLES) {
    if (store.get(sampleOrderId(sample.n)) !== null) continue;
    store.create(sampleOrder(sample, owner, now));
  }

  const weeksDir = path.join(dataDir, "rewards", "weeks");
  const others = [address("holder a"), address("holder b"), address("holder c")];
  const thisWeek = weekOf(now);
  const start = weekBounds(thisWeek)?.start ?? now;
  const past = [weekOf(start - 1), weekOf(start - 7 * DAY - 1)];

  /** One delivered swap of so many US dollars (in millionths), as the points record holds it. */
  const addEntry = (who: string, label: string, at: number, volumeMicro: bigint, pair: [CoinRef, CoinRef]) => {
    const entry: PointsEntry = { v: 2, order: orderHash(`sample ${label} ${who}`), address: who, week: weekOf(at), at: new Date(at).toISOString(), volumeUsdMicro: volumeMicro.toString(), reasons: [], from: { symbol: pair[0].symbol, chain: pair[0].chain }, to: { symbol: pair[1].symbol, chain: pair[1].chain } };
    // Once: an entry that is already there is left as it is.
    rewards.record(entry);
  };

  return {
    orderIds: SAMPLES.map((sample) => sampleOrderId(sample.n)),
    pool: SAMPLE.pool,
    ensureStats,
    ensureWeek(at) {
      // Swaps of $3,400, $1,820.50 and $760 this week, by three addresses that are nobody's.
      [3_400_000_000n, 1_820_500_000n, 760_000_000n].forEach((volume, index) => addEntry(others[index]!, `this week ${thisWeek}`, Math.min(at, start + (4 + index) * HOUR), volume, [COIN.baseEth!, COIN.solUsdt!]));
    },
    ensureFor(who, at) {
      // Points in this week and in the two before it.
      // Swaps of $1,240.82, $249.91 and $100 this week, of $2,605 and $560.25 last week, and of $1,650 the week before.
      addEntry(who, "this week a", Math.min(at, start + 6 * HOUR), 1_240_820_000n, [COIN.baseEth!, COIN.solUsdt!]);
      addEntry(who, "this week b", Math.min(at, start + 30 * HOUR), 249_910_000n, [COIN.arbUsdc!, COIN.baseEth!]);
      addEntry(who, "this week c", Math.min(at, start + 31 * HOUR), 100_000_000n, [COIN.arbUsdc!, COIN.solUsdt!]);
      addEntry(who, "last week a", start - 2 * DAY, 2_605_000_000n, [COIN.bnb!, COIN.arbUsdc!]);
      addEntry(who, "last week b", start - 5 * DAY, 560_250_000n, [COIN.baseEth!, COIN.arbUsdc!]);
      addEntry(who, "two weeks ago", start - 10 * DAY, 1_650_000_000n, [COIN.baseEth!, COIN.solUsdt!]);
      others.forEach((other, index) => {
        addEntry(other, "last week", start - (2 + index) * DAY, OTHERS_USD_MICRO[0] * BigInt(index + 1), [COIN.baseEth!, COIN.solUsdt!]);
        addEntry(other, "two weeks ago", start - (9 + index) * DAY, OTHERS_USD_MICRO[1] * BigInt(index + 2), [COIN.arbUsdc!, COIN.baseEth!]);
      });
      // The two past weeks, closed and paid. Each is written once for the addresses known then; a new
      // address is added to its shares, so that whoever signs in on a practice server sees payouts.
      past.forEach((week, index) => {
        const file = path.join(weeksDir, `${week}.json`);
        const points = new Map<string, bigint>();
        const add = (holder: string, micro: bigint) => points.set(holder, (points.get(holder) ?? 0n) + micro);
        // Ten points for each dollar of the swaps above.
        others.forEach((other, at2) => add(other, pointsMicro(OTHERS_USD_MICRO[index === 0 ? 0 : 1] * BigInt(index === 0 ? at2 + 1 : at2 + 2))));
        add(who, pointsMicro(index === 0 ? 3_165_250_000n : 1_650_000_000n));
        let held: WeekRecord | null;
        try {
          held = JSON.parse(fs.readFileSync(file, "utf8")) as WeekRecord;
        } catch {
          held = null;
        }
        for (const share of held?.shares ?? []) if (!points.has(share.address)) points.set(share.address, BigInt(share.pointsMicro));
        const pool = (index === 0 ? 8n : 6n) * 10n ** 18n;
        const result = sharePool(pool, points, RESERVE_ASSET.minPayout);
        const end = weekBounds(week)?.end ?? at;
        // One made-up transaction for the week, written down with every share it paid, as the record tool writes a real one.
        const paidWith = hash(`payout ${week}`);
        const record: WeekRecord = {
          v: 1,
          week,
          closedAt: new Date(end + HOUR).toISOString(),
          asset: RESERVE_ASSET.symbol,
          pool: pool.toString(),
          paid: result.paid.toString(),
          left: result.left.toString(),
          totalPointsMicro: result.totalPoints.toString(),
          shares: result.shares.map((share) => ({ address: share.address, pointsMicro: share.points.toString(), payout: share.payout.toString(), carriedMicro: share.carried.toString(), ...(share.payout > 0n ? { tx: paidWith } : {}) })),
          txs: [{ hash: paidWith, recordedAt: new Date(end + 3 * HOUR).toISOString() }],
        };
        writeDurable(file, JSON.stringify(record));
      });
    },
  };
}

/** A practice server's settings, with the sample token and reserve standing in where none is set. Anything the operator did set is kept. */
export function withSampleSettings(config: Config): Config {
  const token = config.tokenAddress ?? SAMPLE.tokenAddress;
  return Object.freeze({
    ...config,
    tokenAddress: token,
    tokenPairAddress: config.tokenPairAddress ?? (config.tokenAddress === null ? SAMPLE.tokenPairAddress : null),
    reserveAddress: config.reserveAddress ?? SAMPLE.reserveAddress,
  });
}
