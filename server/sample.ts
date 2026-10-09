// Sample content for practice mode: past orders in every end state, points over a few weeks, two
// paid weeks, a reserve with a balance and a token with an address, so that every screen can be
// looked at full while testing on one's own machine.
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
import { RESERVE_ASSET, sharePool, weekBounds, weekOf } from "../shared/rewards.ts";
import type { Config } from "./config.ts";
import { orderHash, type PointsEntry, type Rewards, type WeekRecord } from "./rewards.ts";
import { writeDurable, type OrderRecord, type OrderStore } from "./store.ts";

const made = (label: string, bytes: number) => createHash("sha256").update(`intentswap sample ${label}`).digest("hex").slice(0, bytes * 2);
const address = (label: string) => toChecksumAddress(`0x${made(label, 20)}`);
const hash = (label: string) => `0x${made(label, 32)}`;

/** What a practice server shows where the operator has set nothing yet. */
export const SAMPLE = {
  tokenAddress: address("token"),
  tokenPairAddress: address("pair"),
  reserveAddress: address("reserve"),
  /** 1,250.5 of the payout coin. */
  reserveBalance: (12_505n * 10n ** 17n).toString(),
} as const;

/** Where, inside a data folder, the note is kept that says the folder holds practice content. */
export const SAMPLE_MARKER = path.join("rewards", "SAMPLE-CONTENT");

/** True when a data folder holds practice content: a practice server has put some there at some time. */
export function holdsSampleContent(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, SAMPLE_MARKER));
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

export interface Samples {
  /** The IDs of the sample orders, newest first: a practice browser lists them under Recent orders. */
  orderIds: string[];
  /** Makes sure an address that signs in on a practice server has something to look at: points over three weeks and two paid weeks. */
  ensureFor(address: string, now: number): void;
  reserveBalance: string;
}

/**
 * Puts the sample content in place. Only ever in practice mode: called with anything else, it
 * refuses. Safe to run at every start: what is already there is left as it is.
 */
export function seedSamples(options: { practice: boolean; dataDir: string; store: OrderStore; rewards: Rewards; now: number }): Samples {
  if (options.practice !== true) throw new Error("sample data is for practice mode only");
  const { store, rewards, dataDir, now } = options;
  // Said first, before anything is put in: the folder now holds made-up orders, points and paid
  // weeks, and only a practice server may start on it (see where server/boot.ts looks for this).
  const marker = path.join(dataDir, SAMPLE_MARKER);
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, "This data folder holds practice content: orders, points and paid weeks made up for looking at the site.\nA server that is not in practice mode will not start on it.\n", { mode: 0o600 });
  }
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

  const addEntry = (who: string, label: string, at: number, feeMicro: bigint, pair: [CoinRef, CoinRef], reasons: PointsEntry["reasons"] = []) => {
    const counted = reasons.length > 0 ? feeMicro / 10n : feeMicro;
    const entry: PointsEntry = { v: 1, order: orderHash(`sample ${label} ${who}`), address: who, week: weekOf(at), at: new Date(at).toISOString(), feeUsdMicro: feeMicro.toString(), countedMicro: counted.toString(), reasons, from: { symbol: pair[0].symbol, chain: pair[0].chain }, to: { symbol: pair[1].symbol, chain: pair[1].chain } };
    // Once: an entry that is already there is left as it is.
    rewards.record(entry);
  };

  return {
    orderIds: SAMPLES.map((sample) => sampleOrderId(sample.n)),
    reserveBalance: SAMPLE.reserveBalance,
    ensureFor(who, at) {
      // Points in this week and in the two before it.
      addEntry(who, "this week a", Math.min(at, start + 6 * HOUR), 2_481_640n, [COIN.baseEth!, COIN.solUsdt!]);
      addEntry(who, "this week b", Math.min(at, start + 30 * HOUR), 499_820n, [COIN.arbUsdc!, COIN.baseEth!]);
      addEntry(who, "this week c", Math.min(at, start + 31 * HOUR), 200_000n, [COIN.arbUsdc!, COIN.solUsdt!], ["dollar_pair"]);
      addEntry(who, "last week a", start - 2 * DAY, 5_210_000n, [COIN.bnb!, COIN.arbUsdc!]);
      addEntry(who, "last week b", start - 5 * DAY, 1_120_500n, [COIN.baseEth!, COIN.arbUsdc!]);
      addEntry(who, "two weeks ago", start - 10 * DAY, 3_300_000n, [COIN.baseEth!, COIN.solUsdt!]);
      others.forEach((other, index) => {
        addEntry(other, "last week", start - (2 + index) * DAY, BigInt(4_000_000 * (index + 1)), [COIN.baseEth!, COIN.solUsdt!]);
        addEntry(other, "two weeks ago", start - (9 + index) * DAY, BigInt(2_500_000 * (index + 2)), [COIN.arbUsdc!, COIN.baseEth!]);
      });
      // The two past weeks, closed and paid. Each is written once for the addresses known then; a new
      // address is added to its shares, so that whoever signs in on a practice server sees payouts.
      past.forEach((week, index) => {
        const file = path.join(weeksDir, `${week}.json`);
        const points = new Map<string, bigint>();
        const add = (holder: string, micro: bigint) => points.set(holder, (points.get(holder) ?? 0n) + micro);
        others.forEach((other, at2) => add(other, BigInt((index === 0 ? 4_000_000 : 2_500_000) * (index === 0 ? at2 + 1 : at2 + 2)) * 100n));
        add(who, index === 0 ? 633_050_000n : 330_000_000n);
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
