// The site's own figures, for the Stats page: running totals, and a list of the latest swaps by
// what was sent.
//
// One rule holds all of it: THIS FILE KNOWS NOTHING OF THE RECEIVING SIDE OF ANY SWAP. Everything
// here comes from orders this server made and saw delivered, each counted once, and of such an
// order only its sending side is ever read (see `deliveryOf`): the coin that was sent and its
// chain, the amount sent and its dollar value, the transaction that paid the deposit, when the
// swap was delivered and how long that took. The coin received, its chain, the amount received,
// the receiving address, the refund address and the delivery's transaction are not read, so they
// can be neither kept nor sent. That is what keeps the two sides of a swap apart on this page.
//
// What is kept (one small file, DATA_DIR/stats/stats.json):
//
//   - totals: how many swaps, their dollar value, how long delivery took (a sum and a count);
//   - by the chain swaps were sent from: how many they were, and their dollar value;
//   - by the coin that was sent: the dollar value;
//   - the dollar value by hour (with a count) for the last 48 hours;
//   - for 48 hours, and never more than 300 of them, one row for each delivered swap: the coin
//     sent, the amount sent, the second it was delivered, and the hash of its deposit transaction.
//
// Never an order's ID and never an address. (A deposit's transaction is public on its own chain,
// and whoever opens it there sees the address that sent it.)
//
// That an order has been counted is not written here either. It is a mark on the order's own
// record, set by the order store before the totals are touched, so an order is counted at most
// once, across restarts too, and the mark goes when the order's record goes.

import fs from "node:fs";
import path from "node:path";
import { isValidTxHash } from "../shared/addresses.ts";
import type { StatsCoin, StatsFeedRow, StatsResponse, StatsShare } from "../shared/api.ts";
import { chainName } from "../shared/chains.ts";
import { MICRO, usdToMicro } from "../shared/rewards.ts";
import { writeDurable, type OrderRecord } from "./store.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** How many hours are kept by the hour, and how long a row is kept. */
const HOURS_KEPT = 48;
const ROW_AGE_MS = 48 * HOUR_MS;
/** The most rows kept, and the most sent to a page. */
const ROWS_KEPT = 300;
const ROWS_SHOWN = 20;
/** How many coins and chains the page lists. */
const TOP = 5;

/** One row, as it is kept. It is sent as it is kept: the same four things. */
export type StoredRow = StatsFeedRow;

/** The file, as it is written. Dollar values are whole millionths of a US dollar, as text. Hours are counted from 1970 in UTC. */
export interface StatsFile {
  v: 2;
  swaps: number;
  volumeMicro: string;
  /** Delivery times, in whole seconds: their sum, and how many were added up. */
  deliverySeconds: number;
  deliveriesTimed: number;
  /** Every chain a delivered swap was sent from, with how many those swaps were and their dollar value. */
  chains: Record<string, { swaps: number; volumeMicro: string }>;
  /** Every coin a delivered swap sent, with the dollar value of those swaps. */
  coins: { symbol: string; chain: string; volumeMicro: string }[];
  hours: Record<string, { swaps: number; volumeMicro: string }>;
  /** The oldest first. */
  rows: StoredRow[];
}

/**
 * The sending side of one delivered order, as it is read from the order. There is no place in it
 * for anything of the receiving side.
 */
export interface Delivery {
  /** The coin that was sent, with how many decimal places its amounts have. */
  coin: StatsFeedRow["coin"];
  /** The amount sent, in the coin's smallest unit. */
  amount: string;
  /** The provider's dollar value of what was sent, in millionths. Null when it gave none: the swap then counts with no volume. */
  usdMicro: bigint | null;
  /** The hash of the transaction that paid the deposit, on the chain it was sent from. Null when it is not known. */
  tx: string | null;
  /** How long delivery took, in whole seconds, or null when that cannot be told. */
  seconds: number | null;
  /** When it was delivered. Used for the sums by hour; never shown or kept with a row. */
  at: number;
  /** When the swap began on the sending side: the last step this server saw before the end, or the order being made. */
  began: number;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isMicro = (value: unknown): value is string => typeof value === "string" && /^\d{1,40}$/.test(value);
const isAmount = (value: unknown): value is string => typeof value === "string" && /^\d{1,80}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isChain = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9_-]{1,16}$/.test(value);
const isCoin = (value: unknown): value is StatsCoin => isObject(value) && typeof value.symbol === "string" && value.symbol.length >= 1 && value.symbol.length <= 16 && isChain(value.chain);
const isDecimals = (value: unknown): value is number => isCount(value) && value <= 30;
/** A moment to the second, as a row holds it: "2026-10-08T12:03:17Z". */
const isMoment = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value));
const isRow = (value: unknown): value is StoredRow =>
  isObject(value) && isObject(value.coin) && isCoin(value.coin) && isDecimals(value.coin.decimals) && isAmount(value.amount) && isMoment(value.at) && (value.tx === null || isValidTxHash(value.coin.chain, value.tx));

/** A moment to the second, in UTC. */
const momentOf = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/**
 * A coin as it is kept: its symbol and its chain's code, each cut to a length no address fits in.
 * (Both come from the provider's coin list and are short already.)
 */
function coinOf(ref: { symbol?: unknown; chain?: unknown }): StatsCoin {
  const symbol = typeof ref.symbol === "string" ? ref.symbol.replace(/\s+/g, "").slice(0, 16) : "";
  return { symbol: symbol === "" ? "?" : symbol, chain: isChain(ref.chain) ? ref.chain : "other" };
}

/** The longest delivery that is taken for one: anything longer is an order that was set aside and came back, and says nothing of how long a swap takes. */
const LONGEST_DELIVERY_S = 24 * 3600;

/**
 * What a delivered order adds, or null for an order that was not delivered. It is read from the
 * order's sending side alone: the coin and the amount the order was made to send, the provider's
 * dollar value of that, and the transaction that paid its deposit. The deposit's hash is the first
 * the provider names on the chain the order was sent from or, where it names none, the one this
 * server itself confirmed pays the order. A hash that was only announced is not taken: it could
 * be anyone's. The time taken runs from the last step this server saw before the end (the order
 * being made, its deposit being confirmed, the swap starting) to the delivery.
 */
function deliveryOf(record: OrderRecord): Delivery | null {
  if (record.state.status !== "delivered") return null;
  const at = Date.parse(record.state.finishedAt ?? record.state.statusSince);
  if (!Number.isFinite(at)) return null;
  const began = Math.max(Number.isFinite(record.state.anchor) ? record.state.anchor : 0, Date.parse(record.createdAt) || 0);
  const seconds = began > 0 && at >= began && at - began <= LONGEST_DELIVERY_S * 1000 ? Math.round((at - began) / 1000) : null;
  const sent = record.from;
  const coin = { ...coinOf(sent), decimals: isDecimals(sent.decimals) ? sent.decimals : 0 };
  const paid = record.state.details?.originTxs[0]?.hash ?? (record.state.depositVerified === true ? record.state.depositTxHash : null);
  return { coin, amount: record.amountIn, usdMicro: usdToMicro(record.amountInUsd), tx: isValidTxHash(coin.chain, paid) ? paid : null, seconds, at, began: began > 0 && began <= at ? began : at };
}

/**
 * The row a delivery adds to the list: the coin sent, the amount sent, the minute the swap began on
 * the sending side and the deposit's hash. The moment of delivery is a fact about the receiving
 * side, so a row does not carry it. A delivery whose amount cannot be read adds no row.
 */
function rowFor(delivery: Delivery): StoredRow | null {
  if (!isAmount(delivery.amount)) return null;
  return { coin: { symbol: delivery.coin.symbol, chain: delivery.coin.chain, decimals: delivery.coin.decimals }, amount: delivery.amount, at: momentOf(Math.floor(delivery.began / MINUTE_MS) * MINUTE_MS), tx: delivery.tx };
}

/** The same sums, as they are held while the server runs. */
interface Sums {
  swaps: number;
  volume: bigint;
  seconds: number;
  timed: number;
  chains: Map<string, { swaps: number; volume: bigint }>;
  coins: Map<string, { coin: StatsCoin; volume: bigint }>;
  hours: Map<number, { swaps: number; volume: bigint }>;
  rows: StoredRow[];
}

const empty = (): Sums => ({ swaps: 0, volume: 0n, seconds: 0, timed: 0, chains: new Map(), coins: new Map(), hours: new Map(), rows: [] });
const coinKey = (coin: StatsCoin) => JSON.stringify([coin.symbol, coin.chain]);

function toFile(sums: Sums): StatsFile {
  return {
    v: 2,
    swaps: sums.swaps,
    volumeMicro: sums.volume.toString(),
    deliverySeconds: sums.seconds,
    deliveriesTimed: sums.timed,
    chains: Object.fromEntries([...sums.chains].map(([chain, held]) => [chain, { swaps: held.swaps, volumeMicro: held.volume.toString() }])),
    coins: [...sums.coins.values()].map((held) => ({ symbol: held.coin.symbol, chain: held.coin.chain, volumeMicro: held.volume.toString() })),
    hours: Object.fromEntries([...sums.hours].map(([hour, held]) => [String(hour), { swaps: held.swaps, volumeMicro: held.volume.toString() }])),
    rows: sums.rows,
  };
}

/** The totals and the hours of a file, of either kind: neither says anything of one side of a swap or the other. */
function totalsFrom(value: Record<string, unknown>): Sums | null {
  const { swaps, volumeMicro, deliverySeconds, deliveriesTimed, hours } = value;
  if (!isCount(swaps) || !isMicro(volumeMicro) || !isCount(deliverySeconds) || !isCount(deliveriesTimed) || !isObject(hours)) return null;
  const sums = empty();
  sums.swaps = swaps;
  sums.volume = BigInt(volumeMicro);
  sums.seconds = deliverySeconds;
  sums.timed = deliveriesTimed;
  for (const [hour, held] of Object.entries(hours)) {
    if (!/^\d{1,9}$/.test(hour) || !isObject(held) || !isCount(held.swaps) || !isMicro(held.volumeMicro)) return null;
    sums.hours.set(Number(hour), { swaps: held.swaps, volume: BigInt(held.volumeMicro) });
  }
  return sums;
}

/**
 * The sums of a file written before this page kept to the sending side: one that held pairs of
 * coins, chains counted for both ends of a swap, and rows that named the coin received. Its
 * totals and its hours stand. What was sent is rebuilt from the sending coin of each of its pairs:
 * the dollar value by coin sent and by the chain it was sent from. How many swaps those were it
 * cannot say, so each chain starts from none. Everything else in it is left unread: what its
 * pairs received, the old chain sums and every row. The file is written again at once (see
 * `createStats`), and from then on none of that is on the disk.
 */
function fromOldFile(value: Record<string, unknown>): Sums | null {
  const sums = totalsFrom(value);
  if (sums === null || !Array.isArray(value.pairs)) return null;
  for (const pair of value.pairs as unknown[]) {
    if (!isObject(pair) || !isCoin(pair.from) || !isMicro(pair.volumeMicro)) return null;
    const coin = { symbol: pair.from.symbol, chain: pair.from.chain };
    const volume = BigInt(pair.volumeMicro);
    const sent = sums.coins.get(coinKey(coin)) ?? { coin, volume: 0n };
    sums.coins.set(coinKey(coin), { coin, volume: sent.volume + volume });
    const from = sums.chains.get(coin.chain) ?? { swaps: 0, volume: 0n };
    sums.chains.set(coin.chain, { swaps: from.swaps, volume: from.volume + volume });
  }
  return sums;
}

/** The sums a file holds, or null for anything that is not such a file in every part. `old` says that it was a file of the earlier kind. */
function fromFile(value: unknown): { sums: Sums; old: boolean } | null {
  if (!isObject(value)) return null;
  if (value.v === 1) {
    const sums = fromOldFile(value);
    return sums === null ? null : { sums, old: true };
  }
  const sums = value.v === 2 ? totalsFrom(value) : null;
  const { chains, coins, rows } = value;
  if (sums === null || !isObject(chains) || !Array.isArray(coins) || !Array.isArray(rows)) return null;
  for (const [chain, held] of Object.entries(chains)) {
    if (!isChain(chain) || !isObject(held) || !isCount(held.swaps) || !isMicro(held.volumeMicro)) return null;
    sums.chains.set(chain, { swaps: held.swaps, volume: BigInt(held.volumeMicro) });
  }
  for (const held of coins as unknown[]) {
    if (!isObject(held) || !isCoin(held) || !isMicro(held.volumeMicro)) return null;
    const coin = { symbol: held.symbol, chain: held.chain };
    sums.coins.set(coinKey(coin), { coin, volume: BigInt(held.volumeMicro) });
  }
  for (const row of rows as unknown[]) {
    if (!isRow(row)) return null;
    // Read part by part: whatever else a file's row might hold is not carried on.
    sums.rows.push({ coin: { symbol: row.coin.symbol, chain: row.coin.chain, decimals: row.coin.decimals }, amount: row.amount, at: row.at, tx: row.tx });
  }
  return { sums, old: false };
}

/** Drops what has aged out: hours older than are kept, rows older than 48 hours, and rows beyond the most that are kept (the oldest first). */
function prune(sums: Sums, now: number): void {
  const firstHour = Math.floor(now / HOUR_MS) - HOURS_KEPT + 1;
  for (const hour of sums.hours.keys()) if (hour < firstHour) sums.hours.delete(hour);
  const oldest = momentOf(now - ROW_AGE_MS);
  sums.rows = sums.rows.filter((row) => row.at >= oldest);
  if (sums.rows.length > ROWS_KEPT) sums.rows = sums.rows.slice(sums.rows.length - ROWS_KEPT);
}

/** Adds one delivery to the sums. What falls outside the hours or rows that are kept adds to the totals alone. */
function add(sums: Sums, delivery: Delivery, now: number): void {
  const usd = delivery.usdMicro ?? 0n;
  const coin = { symbol: delivery.coin.symbol, chain: delivery.coin.chain };
  sums.swaps += 1;
  sums.volume += usd;
  if (delivery.seconds !== null) {
    sums.seconds += delivery.seconds;
    sums.timed += 1;
  }
  // Counted for the chain it was sent from, and for no other.
  const from = sums.chains.get(coin.chain) ?? { swaps: 0, volume: 0n };
  sums.chains.set(coin.chain, { swaps: from.swaps + 1, volume: from.volume + usd });
  if (delivery.usdMicro !== null) {
    const sent = sums.coins.get(coinKey(coin)) ?? { coin, volume: 0n };
    sums.coins.set(coinKey(coin), { coin, volume: sent.volume + usd });
  }
  const hour = Math.floor(delivery.at / HOUR_MS);
  if (hour > Math.floor(now / HOUR_MS) - HOURS_KEPT) {
    const held = sums.hours.get(hour) ?? { swaps: 0, volume: 0n };
    sums.hours.set(hour, { swaps: held.swaps + 1, volume: held.volume + usd });
  }
  const row = rowFor(delivery);
  if (row !== null) {
    sums.rows.push(row);
    // The oldest first, whenever each was told of: an order found at a start may be older than rows already here.
    sums.rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
  prune(sums, now);
}

const dollars = (micro: bigint): number => Number(micro / MICRO);

/**
 * A part of a whole, in whole per cent, rounded down. A part that is more than nothing and under
 * one per cent is "<1", so that it is never said to be nothing. Nothing of anything is 0, and so is
 * anything of nothing.
 */
export function shareOf(part: bigint, whole: bigint): StatsShare {
  if (part <= 0n || whole <= 0n) return 0;
  const percent = (part * 100n) / whole;
  return percent === 0n ? "<1" : Number(percent);
}

/** The hour now running and the 23 before it: never anything older than 24 hours. */
function lastDay(sums: Sums, now: number): { swaps: number; volume: bigint } {
  const hour = Math.floor(now / HOUR_MS);
  let swaps = 0;
  let volume = 0n;
  for (const [at, held] of sums.hours) {
    if (at > hour - 24 && at <= hour) {
      swaps += held.swaps;
      volume += held.volume;
    }
  }
  return { swaps, volume };
}

/** What the page is sent, from the sums as they stand. */
function render(sums: Sums, now: number): StatsResponse {
  const recent = lastDay(sums, now);
  const byVolume = <T extends { volumeUsd: number; name: string }>(list: T[]): T[] => list.filter((item) => item.volumeUsd > 0).sort((a, b) => b.volumeUsd - a.volumeUsd || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, TOP);
  const coins = byVolume([...sums.coins.entries()].map(([name, held]) => ({ name, coin: held.coin, volumeUsd: dollars(held.volume) }))).map(({ coin, volumeUsd }) => ({ coin, volumeUsd }));
  const chains = byVolume([...sums.chains].map(([chain, held]) => ({ chain, name: chainName(chain), volumeUsd: dollars(held.volume) })));
  // Every chain a swap was sent from, in the order of their codes. Its share is worked out from the same sum the list above shows in dollars.
  const chainsUsed = [...sums.chains].map(([chain, held]) => ({ chain, swaps: held.swaps, share: shareOf(held.volume, sums.volume) })).sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0));
  // The newest first, and none older than a row is kept for. A row is sent part by part: these four things and no others.
  const oldest = momentOf(now - ROW_AGE_MS);
  const feed = sums.rows.filter((row) => row.at >= oldest).slice(-ROWS_SHOWN).reverse().map((row) => ({ coin: { symbol: row.coin.symbol, chain: row.coin.chain, decimals: row.coin.decimals }, amount: row.amount, at: row.at, tx: row.tx }));

  return {
    // How many chains have been used is the length of the list of them, so that the two are one number.
    totals: { swaps: sums.swaps, volumeUsd: dollars(sums.volume), volume24hUsd: dollars(recent.volume), chains: chainsUsed.length, deliverySeconds: sums.timed === 0 ? null : Math.round(sums.seconds / sums.timed) },
    coins,
    chains,
    chainsUsed,
    feed,
  };
}

export interface Stats {
  /**
   * Adds a delivered order to the totals, once. `claim` marks the order's own record as counted and
   * says whether this was the first time (the order store's `markCounted`); the totals are touched
   * only after it has. True when the order was added. With `write` false the file is not written:
   * for adding many at once, followed by one `save`.
   */
  recordDelivered(record: OrderRecord, claim: () => boolean, write?: boolean): boolean;
  /** Writes the sums to disk. */
  save(): void;
  /** Adds made-up deliveries, for a practice server's sample content. No route reaches it. */
  seed(deliveries: readonly Delivery[]): void;
  /** What the Stats page is sent: the figures as they stand at this moment. */
  view(): StatsResponse;
  /** Takes rows that have aged out off the disk too, whether or not a swap has been delivered since. The server does this every hour. */
  tidy(): void;
  /** True when a file was found at start that could not be read as the sums. It was set aside, and the count began again from nothing. */
  readonly setAside: boolean;
}

export function createStats(dataDir: string, options: { now?: () => number } = {}): Stats {
  const now = options.now ?? Date.now;
  const dir = path.join(dataDir, "stats");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "stats.json");
  // A half-written file a crash left behind is never the record: the record is the file it would have replaced.
  for (const name of fs.readdirSync(dir)) if (name.includes(".tmp-")) fs.rmSync(path.join(dir, name), { force: true });

  let live = empty();
  let setAside = false;
  const save = () => writeDurable(file, JSON.stringify(toFile(live)));
  if (fs.existsSync(file)) {
    let read: { sums: Sums; old: boolean } | null;
    try {
      read = fromFile(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      read = null;
    }
    if (read === null) {
      // Not written over: it is moved out of the way for a person to look at, and said in the log.
      fs.renameSync(file, `${file}.unreadable`);
      setAside = true;
    } else {
      live = read.sums;
      // A file of the earlier kind is written again at once, so that what it held of the receiving side of swaps is on the disk no longer.
      if (read.old) save();
    }
  }

  return {
    get setAside() {
      return setAside;
    },
    recordDelivered(record, claim, write = true) {
      if (record.statsCounted === true) return false;
      const delivery = deliveryOf(record);
      if (delivery === null) return false;
      // The order is marked first, and durably. If the process stops between the mark and the sums, the
      // order is missing from the totals; it can never be in them twice.
      if (!claim()) return false;
      add(live, delivery, now());
      if (write) save();
      return true;
    },
    save,
    seed(deliveries) {
      for (const delivery of deliveries) add(live, delivery, now());
      save();
    },
    view() {
      return render(live, now());
    },
    tidy() {
      const held = live.rows.length;
      prune(live, now());
      if (live.rows.length !== held) save();
    },
  };
}
