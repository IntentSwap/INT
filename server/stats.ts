// The site's own figures, for the Stats page: running totals, and a list of the latest swaps by
// what was sent.
//
// One rule holds all of it: OF THE RECEIVING SIDE OF A SWAP THIS FILE KEEPS ONE THING, A TOTAL BY
// COIN. Everything here comes from orders this server made and saw delivered, each counted once.
// Of such an order the sending side is read (see `deliveryOf`): the coin that was sent and its
// chain, the amount sent and its dollar value, the transaction that paid the deposit, when the
// swap was delivered and how long that took. Of the receiving side only the coin and its chain
// are read, and they are added to that coin's running total of dollars and to nothing else: no
// row names them. The amount received, the receiving address, the refund address and the
// delivery's transaction are not read, so they can be neither kept nor sent. That is what keeps
// the two sides of a swap apart on this page.
//
// What is kept (one small file, DATA_DIR/stats/stats.json):
//
//   - totals: how many swaps, their dollar value, how long delivery took (a sum and a count);
//   - by the chain swaps were sent from: how many they were, and their dollar value;
//   - by the coin that was sent: the dollar value;
//   - the dollar value by hour (with a count) for the last 48 hours;
//   - for as long as a finished order's record is kept, and never more than 300 of them, one row
//     for each delivered swap: the coin sent, the amount sent, the minute the swap began, and the
//     hash of its deposit transaction.
//
// Never an order's ID and never an address. (A deposit's transaction is public on its own chain,
// and whoever opens it there sees the address that sent it.)
//
// An order made in Ghost mode is in the totals and nowhere else. It adds to every sum above as any
// delivered order does, once, and it is given no row, at no time: its deposit's transaction is not
// read at all.
//
// A gas order (the small second order "Add gas" makes beside a swap) is not a swap. Delivered, it
// adds its dollars wherever dollars are summed: the total, its hour, the coin it sent, the coin it
// delivered, and the chain it was sent from. It adds nothing that counts swaps: not to the number
// of swaps, not to its chain's, not to its hour's, and not to the time deliveries take. It is
// given no row. And a chain that only a gas order was sent from is not yet a chain a swap was sent
// from: it is listed nowhere until one is.
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
import { FINISHED_RETENTION_MS, writeDurable, type OrderRecord } from "./store.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** How many hours are kept by the hour. */
const HOURS_KEPT = 48;
/** How long a row is kept: as long as the record of a finished order is, so that every delivered swap the site still holds can be listed. */
const ROW_AGE_MS = FINISHED_RETENTION_MS;
/** The most rows kept, and the most sent to a page. */
const ROWS_KEPT = 300;
const ROWS_SHOWN = 20;
/** How many coins and chains the page lists. */
const TOP = 5;

/** One row, as it is kept. It is sent as it is kept: the same four things. */
export type StoredRow = StatsFeedRow;

/**
 * The file, as it is written. Dollar values are whole millionths of a US dollar, as text. Hours are
 * counted from 1970 in UTC. `v` is 3 once the delivered orders on disk have been gone through for
 * their rows (see `createStats`); a file that says 2 has that still to come.
 */
export interface StatsFile {
  v: 2 | 3;
  swaps: number;
  volumeMicro: string;
  /** Delivery times, in whole seconds: their sum, and how many were added up. */
  deliverySeconds: number;
  deliveriesTimed: number;
  /**
   * Every chain a delivered order was sent from, with how many swaps those were and their dollar
   * value. `gasOnly` is there, and true, on a chain that so far only gas orders were sent from: its
   * dollars are kept, and it is not among the chains used until a swap is sent from it.
   */
  chains: Record<string, { swaps: number; volumeMicro: string; gasOnly?: true }>;
  /** Every coin a delivered swap sent, with the dollar value of those swaps. */
  coins: { symbol: string; chain: string; volumeMicro: string }[];
  /** Every coin a delivered swap delivered, with the dollar value of those swaps: a total by coin and nothing by swap. Absent in a file made before it was kept. */
  received?: { symbol: string; chain: string; volumeMicro: string }[];
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
  /** The coin that was delivered. It adds to that coin's total of dollars received and to nothing else. */
  to?: StatsCoin;
  /** True for an order made in Ghost mode: it adds to the sums and is given no row. */
  unlisted?: true;
  /** True for a gas order: it adds its dollars to the sums, is counted as no swap, and is given no row. */
  gas?: true;
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
 * being made, its deposit being confirmed, the swap starting) to the delivery. Of an order made in
 * Ghost mode the deposit's transaction is not read: such an order is for the sums alone. Nor is
 * it read of a gas order, which is for the dollar sums alone (see `add`).
 */
function deliveryOf(record: OrderRecord): Delivery | null {
  if (record.state.status !== "delivered") return null;
  const at = Date.parse(record.state.finishedAt ?? record.state.statusSince);
  if (!Number.isFinite(at)) return null;
  const began = Math.max(Number.isFinite(record.state.anchor) ? record.state.anchor : 0, Date.parse(record.createdAt) || 0);
  const seconds = began > 0 && at >= began && at - began <= LONGEST_DELIVERY_S * 1000 ? Math.round((at - began) / 1000) : null;
  const sent = record.from;
  const coin = { ...coinOf(sent), decimals: isDecimals(sent.decimals) ? sent.decimals : 0 };
  const sums = { coin, amount: record.amountIn, usdMicro: usdToMicro(record.amountInUsd), seconds, at, began: began > 0 && began <= at ? began : at, to: coinOf(record.to) };
  if (record.gasOrder === true) return { ...sums, tx: null, gas: true };
  if (record.ghost === true) return { ...sums, tx: null, unlisted: true };
  const paid = record.state.details?.originTxs[0]?.hash ?? (record.state.depositVerified === true ? record.state.depositTxHash : null);
  return { ...sums, tx: isValidTxHash(coin.chain, paid) ? paid : null };
}

/**
 * The row a delivery adds to the list: the coin sent, the amount sent, the minute the swap began on
 * the sending side and the deposit's hash. The moment of delivery is a fact about the receiving
 * side, so a row does not carry it. A delivery whose amount cannot be read adds no row, and
 * neither does that of an order made in Ghost mode: not as it is delivered, and not when the rows
 * of orders already counted are put back at a start. Nor does a gas order's, at either moment: the
 * list is of swaps.
 */
function rowFor(delivery: Delivery): StoredRow | null {
  if (delivery.gas === true) return null;
  if (delivery.unlisted === true) return null;
  if (!isAmount(delivery.amount)) return null;
  return { coin: { symbol: delivery.coin.symbol, chain: delivery.coin.chain, decimals: delivery.coin.decimals }, amount: delivery.amount, at: momentOf(Math.floor(delivery.began / MINUTE_MS) * MINUTE_MS), tx: delivery.tx };
}

/** What is held for a chain orders were sent from. `gasOnly` is true while only gas orders were: see the file's shape above. */
interface ChainSum {
  swaps: number;
  volume: bigint;
  gasOnly?: true;
}

/** A chain a swap has been sent from: every chain that is held, but one that only gas orders were sent from. */
const used = (chain: ChainSum): boolean => chain.gasOnly !== true;

/** The same sums, as they are held while the server runs. */
interface Sums {
  swaps: number;
  volume: bigint;
  seconds: number;
  timed: number;
  chains: Map<string, ChainSum>;
  coins: Map<string, { coin: StatsCoin; volume: bigint }>;
  received: Map<string, { coin: StatsCoin; volume: bigint }>;
  hours: Map<number, { swaps: number; volume: bigint }>;
  rows: StoredRow[];
}

const empty = (): Sums => ({ swaps: 0, volume: 0n, seconds: 0, timed: 0, chains: new Map(), coins: new Map(), received: new Map(), hours: new Map(), rows: [] });
const coinKey = (coin: StatsCoin) => JSON.stringify([coin.symbol, coin.chain]);

function toFile(sums: Sums, v: StatsFile["v"]): StatsFile {
  return {
    v,
    swaps: sums.swaps,
    volumeMicro: sums.volume.toString(),
    deliverySeconds: sums.seconds,
    deliveriesTimed: sums.timed,
    chains: Object.fromEntries([...sums.chains].map(([chain, held]) => [chain, { swaps: held.swaps, volumeMicro: held.volume.toString(), ...(used(held) ? {} : { gasOnly: true as const }) }])),
    coins: [...sums.coins.values()].map((held) => ({ symbol: held.coin.symbol, chain: held.coin.chain, volumeMicro: held.volume.toString() })),
    received: [...sums.received.values()].map((held) => ({ symbol: held.coin.symbol, chain: held.coin.chain, volumeMicro: held.volume.toString() })),
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

/** The sums a file holds, and which kind of file it was, or null for anything that is not such a file in every part. */
function fromFile(value: unknown): { sums: Sums; v: 1 | 2 | 3 } | null {
  if (!isObject(value)) return null;
  if (value.v === 1) {
    const sums = fromOldFile(value);
    return sums === null ? null : { sums, v: 1 };
  }
  const sums = value.v === 2 || value.v === 3 ? totalsFrom(value) : null;
  const { chains, coins, rows } = value;
  if (sums === null || !isObject(chains) || !Array.isArray(coins) || !Array.isArray(rows)) return null;
  for (const [chain, held] of Object.entries(chains)) {
    if (!isChain(chain) || !isObject(held) || !isCount(held.swaps) || !isMicro(held.volumeMicro) || (held.gasOnly !== undefined && held.gasOnly !== true)) return null;
    // Only a chain no swap is counted for can be one that gas orders alone were sent from.
    sums.chains.set(chain, { swaps: held.swaps, volume: BigInt(held.volumeMicro), ...(held.gasOnly === true && held.swaps === 0 ? { gasOnly: true as const } : {}) });
  }
  for (const held of coins as unknown[]) {
    if (!isObject(held) || !isCoin(held) || !isMicro(held.volumeMicro)) return null;
    const coin = { symbol: held.symbol, chain: held.chain };
    sums.coins.set(coinKey(coin), { coin, volume: BigInt(held.volumeMicro) });
  }
  for (const held of (Array.isArray(value.received) ? value.received : []) as unknown[]) {
    if (!isObject(held) || !isCoin(held) || !isMicro(held.volumeMicro)) return null;
    const coin = { symbol: held.symbol, chain: held.chain };
    sums.received.set(coinKey(coin), { coin, volume: BigInt(held.volumeMicro) });
  }
  for (const row of rows as unknown[]) {
    if (!isRow(row)) return null;
    // Read part by part: whatever else a file's row might hold is not carried on.
    sums.rows.push({ coin: { symbol: row.coin.symbol, chain: row.coin.chain, decimals: row.coin.decimals }, amount: row.amount, at: row.at, tx: row.tx });
  }
  return { sums, v: value.v === 3 ? 3 : 2 };
}

/** Drops what has aged out: hours older than are kept, rows older than a finished order's record is kept, and rows beyond the most that are kept (the oldest first). */
function prune(sums: Sums, now: number): void {
  const firstHour = Math.floor(now / HOUR_MS) - HOURS_KEPT + 1;
  for (const hour of sums.hours.keys()) if (hour < firstHour) sums.hours.delete(hour);
  const oldest = momentOf(now - ROW_AGE_MS);
  sums.rows = sums.rows.filter((row) => row.at >= oldest);
  if (sums.rows.length > ROWS_KEPT) sums.rows = sums.rows.slice(sums.rows.length - ROWS_KEPT);
}

/**
 * Adds one delivery to the sums. What falls outside the hours or rows that are kept adds to the
 * totals alone. A gas order adds its dollars to each sum a swap's dollars are added to, and one
 * swap to none of them.
 */
function add(sums: Sums, delivery: Delivery, now: number): void {
  const usd = delivery.usdMicro ?? 0n;
  const coin = { symbol: delivery.coin.symbol, chain: delivery.coin.chain };
  // How many swaps this is: one, or none for a gas order.
  const swaps = delivery.gas === true ? 0 : 1;
  sums.swaps += swaps;
  sums.volume += usd;
  if (delivery.seconds !== null && swaps === 1) {
    sums.seconds += delivery.seconds;
    sums.timed += 1;
  }
  // Counted for the chain it was sent from, and for no other. A chain first heard of from a gas
  // order is marked as one that only gas orders were sent from, and the mark goes with the first swap.
  const from = sums.chains.get(coin.chain) ?? { swaps: 0, volume: 0n, ...(swaps === 0 ? { gasOnly: true as const } : {}) };
  sums.chains.set(coin.chain, { swaps: from.swaps + swaps, volume: from.volume + usd, ...(swaps === 0 && !used(from) ? { gasOnly: true as const } : {}) });
  if (delivery.usdMicro !== null) {
    const sent = sums.coins.get(coinKey(coin)) ?? { coin, volume: 0n };
    sums.coins.set(coinKey(coin), { coin, volume: sent.volume + usd });
    // The coin it delivered: added to that coin's total, and kept nowhere else. No row and no other figure names it.
    if (delivery.to !== undefined) {
      const got = sums.received.get(coinKey(delivery.to)) ?? { coin: delivery.to, volume: 0n };
      sums.received.set(coinKey(delivery.to), { coin: delivery.to, volume: got.volume + usd });
    }
  }
  const hour = Math.floor(delivery.at / HOUR_MS);
  if (hour > Math.floor(now / HOUR_MS) - HOURS_KEPT) {
    const held = sums.hours.get(hour) ?? { swaps: 0, volume: 0n };
    sums.hours.set(hour, { swaps: held.swaps + swaps, volume: held.volume + usd });
  }
  const row = rowFor(delivery);
  if (row !== null) list(sums, row);
  prune(sums, now);
}

/** Puts a row on the list. The oldest first, whenever each was told of: an order found at a start may be older than rows already there. */
function list(sums: Sums, row: StoredRow): void {
  sums.rows.push(row);
  sums.rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
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
function render(sums: Sums, now: number, receivedMin: number): StatsResponse {
  const recent = lastDay(sums, now);
  const byVolume = <T extends { volumeUsd: number; name: string }>(list: T[]): T[] => list.filter((item) => item.volumeUsd > 0).sort((a, b) => b.volumeUsd - a.volumeUsd || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, TOP);
  const coins = byVolume([...sums.coins.entries()].map(([name, held]) => ({ name, coin: held.coin, volumeUsd: dollars(held.volume) }))).map(({ coin, volumeUsd }) => ({ coin, volumeUsd }));
  // A chain that only gas orders were sent from is in neither list of chains: no swap was sent from it yet. Its dollars are in the total.
  const sentFrom = [...sums.chains].filter(([, held]) => used(held));
  const chains = byVolume(sentFrom.map(([chain, held]) => ({ chain, name: chainName(chain), volumeUsd: dollars(held.volume) })));
  // The coins delivered, as totals only, once the site has delivered enough swaps. Which swap delivered which is in no figure.
  const received = sums.swaps >= receivedMin ? byVolume([...sums.received.entries()].map(([name, held]) => ({ name, coin: held.coin, volumeUsd: dollars(held.volume) }))).map(({ coin, volumeUsd }) => ({ coin, volumeUsd })) : null;
  // Every chain a swap was sent from, in the order of their codes. Its share is worked out from the same sum the list above shows in dollars.
  const chainsUsed = sentFrom.map(([chain, held]) => ({ chain, swaps: held.swaps, share: shareOf(held.volume, sums.volume) })).sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0));
  // The newest first, and none older than a row is kept for. A row is sent part by part: these four things and no others.
  const oldest = momentOf(now - ROW_AGE_MS);
  const feed = sums.rows.filter((row) => row.at >= oldest).slice(-ROWS_SHOWN).reverse().map((row) => ({ coin: { symbol: row.coin.symbol, chain: row.coin.chain, decimals: row.coin.decimals }, amount: row.amount, at: row.at, tx: row.tx }));

  return {
    // How many chains have been used is the length of the list of them, so that the two are one number.
    totals: { swaps: sums.swaps, volumeUsd: dollars(sums.volume), volume24hUsd: dollars(recent.volume), chains: chainsUsed.length, deliverySeconds: sums.timed === 0 ? null : Math.round(sums.seconds / sums.timed) },
    coins,
    received,
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
   *
   * At a start every order on disk is put to this once more, and `save` is called after the last.
   * An order that is already counted adds nothing then, with one exception, made once for a file
   * from before rows were kept as long as their orders: see `createStats`.
   */
  recordDelivered(record: OrderRecord, claim: () => boolean, write?: boolean): boolean;
  /** Writes the sums to disk. Called after every order on disk has been gone through at a start, it also ends that going-through. */
  save(): void;
  /**
   * Writes the sums to disk if the file is behind them: something was added with the write left for
   * later, or a write failed. Otherwise it does nothing. For the moment before an order's record is
   * deleted, when what the order added must be on disk already.
   */
  flush(): void;
  /** Adds made-up deliveries, for a practice server's sample content. No route reaches it. */
  seed(deliveries: readonly Delivery[]): void;
  /** What the Stats page is sent: the figures as they stand at this moment. */
  view(): StatsResponse;
  /** Takes rows that have aged out off the disk too, whether or not a swap has been delivered since. The server does this every hour. */
  tidy(): void;
  /** True when a file was found at start that could not be read as the sums. It was set aside, and the count began again from nothing. */
  readonly setAside: boolean;
}

export function createStats(dataDir: string, options: { now?: () => number; receivedMin?: number } = {}): Stats {
  const now = options.now ?? Date.now;
  // How many swaps the site must have delivered before the totals of coins received are shown.
  const receivedMin = options.receivedMin ?? 1;
  const dir = path.join(dataDir, "stats");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "stats.json");
  // A half-written file a crash left behind is never the record: the record is the file it would have replaced.
  for (const name of fs.readdirSync(dir)) if (name.includes(".tmp-")) fs.rmSync(path.join(dir, name), { force: true });

  let live = empty();
  let setAside = false;
  // The one repair. A file made before rows were kept as long as their orders is short of rows: an
  // order counted by the first Stats page never had a row of this kind, nor a swap counted for the
  // chain it was sent from, and a row once aged out after 48 hours. So for such a file, once, the
  // delivered orders still on disk that are already counted are gone through as the server starts
  // (it puts every order on disk to `recordDelivered`). Each one's row is worked out exactly as a
  // new delivery's is. Where the file holds no such row, the row is listed, and the order's swap
  // is counted for its chain if the chains' counts do not yet add up to every swap there is (when
  // they do, it was counted for its chain as it was delivered, and only its row had gone). Nothing
  // is added to the totals or to any dollar sum: those were added when the order was first
  // counted. `mending` is true until that is done; the file then says so (`v: 3`), and it is never
  // done again. `held` is the rows the file came with, each standing for one order. An order that
  // has no row is no part of this: one made in Ghost mode, and a gas order, which is no swap and
  // is counted for no chain.
  let mending = false;
  const held = new Map<string, number>();
  // True while the sums in memory hold something the file does not.
  let unwritten = false;
  const write = () => {
    writeDurable(file, JSON.stringify(toFile(live, mending ? 2 : 3)));
    unwritten = false;
  };
  const mend = (record: OrderRecord): void => {
    const delivery = deliveryOf(record);
    const row = delivery === null ? null : rowFor(delivery);
    if (delivery === null || row === null) return;
    const key = JSON.stringify(row);
    const has = held.get(key) ?? 0;
    if (has > 0) {
      held.set(key, has - 1);
      return;
    }
    list(live, row);
    let counted = 0;
    for (const chain of live.chains.values()) counted += chain.swaps;
    if (counted < live.swaps) {
      const from = live.chains.get(delivery.coin.chain) ?? { swaps: 0, volume: 0n };
      // A swap was sent from this chain: whatever it was marked as before, it is a chain that was used.
      live.chains.set(delivery.coin.chain, { swaps: from.swaps + 1, volume: from.volume });
    }
  };
  if (fs.existsSync(file)) {
    let read: { sums: Sums; v: 1 | 2 | 3 } | null;
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
      mending = read.v !== 3;
      for (const row of live.rows) held.set(JSON.stringify(row), (held.get(JSON.stringify(row)) ?? 0) + 1);
      // A file of the earliest kind is written again at once, so that what it held of the receiving side of swaps is on the disk no longer.
      if (read.v === 1) write();
    }
  }

  return {
    get setAside() {
      return setAside;
    },
    recordDelivered(record, claim, andWrite = true) {
      if (record.statsCounted === true) {
        if (mending) mend(record);
        return false;
      }
      const delivery = deliveryOf(record);
      if (delivery === null) return false;
      // The order is marked first, and durably. If the process stops between the mark and the sums, the
      // order is missing from the totals; it can never be in them twice.
      if (!claim()) return false;
      add(live, delivery, now());
      unwritten = true;
      if (andWrite) write();
      return true;
    },
    flush() {
      if (unwritten) write();
    },
    save() {
      mending = false;
      held.clear();
      prune(live, now());
      write();
    },
    seed(deliveries) {
      for (const delivery of deliveries) add(live, delivery, now());
      write();
    },
    view() {
      return render(live, now(), receivedMin);
    },
    tidy() {
      const before = live.rows.length;
      prune(live, now());
      if (live.rows.length !== before) write();
    },
  };
}
