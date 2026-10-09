// The site's own figures, for the Stats page: running totals, and a short list of recent swaps
// too rounded to point at any one of them.
//
// Everything here comes from orders this server made and saw delivered, each counted once. What is
// kept (one small file, DATA_DIR/stats/stats.json) is sums and rounded rows only:
//
//   - totals: how many swaps, their dollar value, how long delivery took (a sum and a count), the
//     dollar value and the number of swaps by chain, and the dollar value by pair of coins;
//   - the dollar value by hour (with a count) for the last 48 hours;
//   - for 48 hours, one row for each swap: the two coins and their chains, a band for its size, and
//     the quarter of an hour from which it may be shown.
//
// Never an address, a transaction hash, an amount, a time, an order's ID or anything made from one.
// A row is rounded as it is made, before it is kept (see `rowFor`): the exact figures of a delivery
// are in memory for the length of one function call and are written nowhere.
//
// That an order has been counted is not written here either. It is a mark on the order's own
// record, set by the order store before the totals are touched, so an order is counted at most
// once, across restarts too, and the mark goes when the order's record goes.
//
// What is shown moves on the quarter of an hour, and only then: the figures a visitor is sent are
// those of everything delivered before the quarter began. So the moment a figure changes says no
// more of when a swap was delivered than its row does.

import fs from "node:fs";
import path from "node:path";
import { STATS_BANDS, type StatsBand, type StatsCoin, type StatsFeedRow, type StatsResponse, type StatsShare, type StatsWhen } from "../shared/api.ts";
import { chainName } from "../shared/chains.ts";
import { MICRO, usdToMicro } from "../shared/rewards.ts";
import { writeDurable, type OrderRecord } from "./store.ts";

export const QUARTER_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A quarter of an hour, counted in quarters of a day. */
const QUARTERS_A_DAY = DAY_MS / QUARTER_MS;

/** How many hours are kept by the hour, and how long a row is kept (in quarters of an hour: 48 hours). */
const HOURS_KEPT = 48;
const ROW_QUARTERS_KEPT = (48 * HOUR_MS) / QUARTER_MS;
/** The most rows kept, and the most sent to a page. */
const ROWS_KEPT = 300;
const ROWS_SHOWN = 20;
/** How many pairs and chains the page lists. */
const TOP = 5;

/** One row as it is kept. `quarter` is the quarter of an hour, counted from 1970, from whose start the row may be shown. */
export interface StoredRow {
  from: StatsCoin;
  to: StatsCoin;
  band: StatsBand;
  quarter: number;
}

/** The file, as it is written. Dollar values are whole millionths of a US dollar, as text. Hours are counted from 1970 in UTC. */
export interface StatsFile {
  v: 1;
  swaps: number;
  volumeMicro: string;
  /** Delivery times, in whole seconds: their sum, and how many were added up. */
  deliverySeconds: number;
  deliveriesTimed: number;
  /** Every chain a delivered swap started or ended on, with the dollar value of those swaps. */
  chains: Record<string, string>;
  /** The same chains, with how many swaps those were. A swap from a chain to the same chain is one. */
  chainSwaps: Record<string, number>;
  pairs: { from: StatsCoin; to: StatsCoin; volumeMicro: string }[];
  hours: Record<string, { swaps: number; volumeMicro: string }>;
  rows: StoredRow[];
}

/**
 * One delivery, as it is read from an order. It lives in memory for as long as it takes to add it
 * up, and is never written down as it is.
 */
export interface Delivery {
  from: StatsCoin;
  to: StatsCoin;
  /** The provider's dollar value of what was paid, in millionths. Null when it gave none: the swap then counts with no volume. */
  usdMicro: bigint | null;
  /** How long delivery took, in whole seconds, or null when that cannot be told. */
  seconds: number | null;
  /** When it was delivered. */
  at: number;
}

/** The band a dollar value falls in. Each band includes its lower bound. */
export function bandOf(usdMicro: bigint): StatsBand {
  if (usdMicro < 100n * MICRO) return "under-100";
  if (usdMicro < 1_000n * MICRO) return "100-1k";
  if (usdMicro < 10_000n * MICRO) return "1k-10k";
  return "over-10k";
}

/**
 * The quarter of an hour from which a delivery's row may be shown: fifteen minutes after the
 * delivery, rounded up to the next quarter. So a row is first shown between 15 and 30 minutes after
 * its swap was delivered.
 */
export function showQuarter(deliveredAt: number): number {
  return Math.ceil((deliveredAt + QUARTER_MS) / QUARTER_MS);
}

/**
 * A coin as it is kept: its symbol and its chain's code, each cut to a length no address or
 * transaction hash fits in. (Both come from the provider's coin list and are short already.)
 */
function coinOf(ref: { symbol?: unknown; chain?: unknown }): StatsCoin {
  const symbol = typeof ref.symbol === "string" ? ref.symbol.replace(/\s+/g, "").slice(0, 16) : "";
  const chain = typeof ref.chain === "string" && /^[a-z0-9_-]{1,16}$/.test(ref.chain) ? ref.chain : "other";
  return { symbol: symbol === "" ? "?" : symbol, chain };
}

/** The longest delivery that is taken for one: anything longer is an order that was set aside and came back, and says nothing of how long a swap takes. */
const LONGEST_DELIVERY_S = 24 * 3600;

/**
 * What a delivered order adds, or null for an order that was not delivered. The dollar value is the
 * provider's value of what was paid, as the order's record holds it. The time taken runs
 * from the last step this server saw before the end (the order being made, its deposit being
 * confirmed, the swap starting) to the delivery.
 */
function deliveryOf(record: OrderRecord): Delivery | null {
  if (record.state.status !== "delivered") return null;
  const at = Date.parse(record.state.finishedAt ?? record.state.statusSince);
  if (!Number.isFinite(at)) return null;
  const began = Math.max(Number.isFinite(record.state.anchor) ? record.state.anchor : 0, Date.parse(record.createdAt) || 0);
  const seconds = began > 0 && at >= began && at - began <= LONGEST_DELIVERY_S * 1000 ? Math.round((at - began) / 1000) : null;
  return { from: coinOf(record.from), to: coinOf(record.to), usdMicro: usdToMicro(record.amountInUsd), seconds, at };
}

/**
 * The row a delivery adds to the list, already rounded: the two coins, the band its size falls in,
 * and the quarter of an hour it may be shown from. Nothing else of the delivery goes into it.
 * A delivery with no dollar value has no band, and adds no row.
 */
function rowFor(delivery: Delivery): StoredRow | null {
  if (delivery.usdMicro === null) return null;
  return { from: delivery.from, to: delivery.to, band: bandOf(delivery.usdMicro), quarter: showQuarter(delivery.at) };
}

/** The same sums, as they are held while the server runs. */
interface Sums {
  swaps: number;
  volume: bigint;
  seconds: number;
  timed: number;
  chains: Map<string, { swaps: number; volume: bigint }>;
  pairs: Map<string, { from: StatsCoin; to: StatsCoin; volume: bigint }>;
  hours: Map<number, { swaps: number; volume: bigint }>;
  rows: StoredRow[];
}

const empty = (): Sums => ({ swaps: 0, volume: 0n, seconds: 0, timed: 0, chains: new Map(), pairs: new Map(), hours: new Map(), rows: [] });
const pairKey = (from: StatsCoin, to: StatsCoin) => JSON.stringify([from.symbol, from.chain, to.symbol, to.chain]);
/** Rows are kept in an order that says nothing of the order they were delivered in: by quarter, then by what they say. */
const rowOrder = (a: StoredRow, b: StoredRow) => a.quarter - b.quarter || (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);

function toFile(sums: Sums): StatsFile {
  return {
    v: 1,
    swaps: sums.swaps,
    volumeMicro: sums.volume.toString(),
    deliverySeconds: sums.seconds,
    deliveriesTimed: sums.timed,
    chains: Object.fromEntries([...sums.chains].map(([chain, held]) => [chain, held.volume.toString()])),
    chainSwaps: Object.fromEntries([...sums.chains].map(([chain, held]) => [chain, held.swaps])),
    pairs: [...sums.pairs.values()].map((pair) => ({ from: pair.from, to: pair.to, volumeMicro: pair.volume.toString() })),
    hours: Object.fromEntries([...sums.hours].map(([hour, held]) => [String(hour), { swaps: held.swaps, volumeMicro: held.volume.toString() }])),
    rows: sums.rows,
  };
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isMicro = (value: unknown): value is string => typeof value === "string" && /^\d{1,40}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCoin = (value: unknown): value is StatsCoin => isObject(value) && typeof value.symbol === "string" && value.symbol.length >= 1 && value.symbol.length <= 16 && typeof value.chain === "string" && /^[a-z0-9_-]{1,16}$/.test(value.chain);
const isRow = (value: unknown): value is StoredRow => isObject(value) && isCoin(value.from) && isCoin(value.to) && (STATS_BANDS as readonly unknown[]).includes(value.band) && isCount(value.quarter);

/**
 * The sums a file holds, or null for anything that is not such a file in every part. A file written
 * before swaps were counted by chain has no counts: its chains start from none. What such a file
 * kept by the day is not read, and so is gone the next time the file is written.
 */
function fromFile(value: unknown): Sums | null {
  if (!isObject(value) || value.v !== 1) return null;
  const { swaps, volumeMicro, deliverySeconds, deliveriesTimed, chains, chainSwaps = {}, pairs, hours, rows } = value;
  if (!isCount(swaps) || !isMicro(volumeMicro) || !isCount(deliverySeconds) || !isCount(deliveriesTimed)) return null;
  if (!isObject(chains) || !isObject(chainSwaps) || !isObject(hours) || !Array.isArray(pairs) || !Array.isArray(rows)) return null;
  const sums = empty();
  sums.swaps = swaps;
  sums.volume = BigInt(volumeMicro);
  sums.seconds = deliverySeconds;
  sums.timed = deliveriesTimed;
  for (const [chain, volume] of Object.entries(chains)) {
    const count = Object.hasOwn(chainSwaps, chain) ? chainSwaps[chain] : 0;
    if (!/^[a-z0-9_-]{1,16}$/.test(chain) || !isMicro(volume) || !isCount(count)) return null;
    sums.chains.set(chain, { swaps: count, volume: BigInt(volume) });
  }
  for (const pair of pairs as unknown[]) {
    if (!isObject(pair) || !isCoin(pair.from) || !isCoin(pair.to) || !isMicro(pair.volumeMicro)) return null;
    sums.pairs.set(pairKey(pair.from, pair.to), { from: { symbol: pair.from.symbol, chain: pair.from.chain }, to: { symbol: pair.to.symbol, chain: pair.to.chain }, volume: BigInt(pair.volumeMicro) });
  }
  for (const [hour, held] of Object.entries(hours)) {
    if (!/^\d{1,9}$/.test(hour) || !isObject(held) || !isCount(held.swaps) || !isMicro(held.volumeMicro)) return null;
    sums.hours.set(Number(hour), { swaps: held.swaps, volume: BigInt(held.volumeMicro) });
  }
  for (const row of rows as unknown[]) {
    if (!isRow(row)) return null;
    // Read part by part: whatever else a file's row might hold is not carried on.
    sums.rows.push({ from: { symbol: row.from.symbol, chain: row.from.chain }, to: { symbol: row.to.symbol, chain: row.to.chain }, band: row.band, quarter: row.quarter });
  }
  return sums;
}

const copyOf = (sums: Sums): Sums => fromFile(toFile(sums)) ?? empty();

/** Drops what has aged out: hours older than are kept, rows older than 48 hours, and rows beyond the most that are kept (the oldest first). */
function prune(sums: Sums, now: number): void {
  const firstHour = Math.floor(now / HOUR_MS) - HOURS_KEPT + 1;
  for (const hour of sums.hours.keys()) if (hour < firstHour) sums.hours.delete(hour);
  const firstQuarter = Math.floor(now / QUARTER_MS) - ROW_QUARTERS_KEPT;
  sums.rows = sums.rows.filter((row) => row.quarter >= firstQuarter);
  if (sums.rows.length > ROWS_KEPT) sums.rows = sums.rows.slice(sums.rows.length - ROWS_KEPT);
}

/** Adds one delivery to the sums. What falls outside the hours or rows that are kept adds to the totals alone. */
function add(sums: Sums, delivery: Delivery, now: number): void {
  const usd = delivery.usdMicro ?? 0n;
  sums.swaps += 1;
  sums.volume += usd;
  if (delivery.seconds !== null) {
    sums.seconds += delivery.seconds;
    sums.timed += 1;
  }
  // Once for the chain it left and once for the chain it arrived on: once only when they are the same chain.
  for (const chain of new Set([delivery.from.chain, delivery.to.chain])) {
    const held = sums.chains.get(chain) ?? { swaps: 0, volume: 0n };
    sums.chains.set(chain, { swaps: held.swaps + 1, volume: held.volume + usd });
  }
  if (delivery.usdMicro !== null) {
    const key = pairKey(delivery.from, delivery.to);
    const held = sums.pairs.get(key);
    if (held === undefined) sums.pairs.set(key, { from: delivery.from, to: delivery.to, volume: usd });
    else held.volume += usd;
  }
  const hour = Math.floor(delivery.at / HOUR_MS);
  if (hour > Math.floor(now / HOUR_MS) - HOURS_KEPT) {
    const held = sums.hours.get(hour) ?? { swaps: 0, volume: 0n };
    sums.hours.set(hour, { swaps: held.swaps + 1, volume: held.volume + usd });
  }
  // The row is made here, rounded, and it is the row that is kept. The delivery itself is not.
  const row = rowFor(delivery);
  if (row !== null && row.quarter >= Math.floor(now / QUARTER_MS) - ROW_QUARTERS_KEPT) {
    sums.rows.push(row);
    sums.rows.sort(rowOrder);
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

/**
 * When a row's swap was delivered, in the three words the page has for it, or null for a row that
 * may not be shown: one whose quarter has not come, or one from before yesterday. A row's swap was
 * delivered in the quarter of an hour two before its own, so "in the last hour" is said only for
 * the row's first half hour on show, while it is certainly true.
 */
export function whenOf(rowQuarter: number, quarter: number): StatsWhen | null {
  if (rowQuarter > quarter) return null;
  if (quarter - rowQuarter <= 1) return "last-hour";
  const today = Math.floor(quarter / QUARTERS_A_DAY);
  const delivered = Math.floor((rowQuarter - 2) / QUARTERS_A_DAY);
  if (delivered === today) return "earlier-today";
  return delivered === today - 1 ? "yesterday" : null;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** What the page is sent, from the sums as they stood when a quarter of an hour began. */
function render(sums: Sums, quarter: number, feedMin: number, random: () => number): StatsResponse {
  const now = quarter * QUARTER_MS;
  const recent = lastDay(sums, now);
  const byVolume = <T extends { volumeUsd: number; name: string }>(list: T[]): T[] => list.filter((item) => item.volumeUsd > 0).sort((a, b) => b.volumeUsd - a.volumeUsd || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, TOP);
  const pairs = byVolume([...sums.pairs.entries()].map(([name, pair]) => ({ name, from: pair.from, to: pair.to, volumeUsd: dollars(pair.volume) }))).map(({ from, to, volumeUsd }) => ({ from, to, volumeUsd }));
  const chains = byVolume([...sums.chains].map(([chain, held]) => ({ chain, name: chainName(chain), volumeUsd: dollars(held.volume) })));
  // Every chain that has been used, in the order of their codes. Its share is worked out from the same sum the list above shows in dollars.
  const chainsUsed = [...sums.chains].map(([chain, held]) => ({ chain, swaps: held.swaps, share: shareOf(held.volume, sums.volume) })).sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0));

  let feed: StatsFeedRow[] | null = null;
  // The list is there only while enough swaps were delivered in the last 24 hours for a row to be one among several.
  if (recent.swaps >= feedMin) {
    const groups: Record<StatsWhen, StatsFeedRow[]> = { "last-hour": [], "earlier-today": [], yesterday: [] };
    for (const row of sums.rows) {
      const when = whenOf(row.quarter, quarter);
      // Only these four things are sent. The quarter a row is kept under is not among them.
      if (when !== null) groups[when].push({ from: row.from, to: row.to, band: row.band, when });
    }
    feed = [...shuffled(groups["last-hour"], random), ...shuffled(groups["earlier-today"], random), ...shuffled(groups.yesterday, random)].slice(0, ROWS_SHOWN);
  }

  return {
    // How many chains have been used is the length of the list of them, so that the two are one number.
    totals: { swaps: sums.swaps, volumeUsd: dollars(sums.volume), volume24hUsd: dollars(recent.volume), chains: chainsUsed.length, deliverySeconds: sums.timed === 0 ? null : Math.round(sums.seconds / sums.timed) },
    pairs,
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
  /** What the Stats page is sent: the same answer for a whole quarter of an hour. */
  view(): StatsResponse;
  /** True when a file was found at start that could not be read as the sums. It was set aside, and the count began again from nothing. */
  readonly setAside: boolean;
}

export function createStats(dataDir: string, options: { feedMin: number; now?: () => number; random?: () => number }): Stats {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const dir = path.join(dataDir, "stats");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "stats.json");
  // A half-written file a crash left behind is never the record: the record is the file it would have replaced.
  for (const name of fs.readdirSync(dir)) if (name.includes(".tmp-")) fs.rmSync(path.join(dir, name), { force: true });

  let live = empty();
  let setAside = false;
  if (fs.existsSync(file)) {
    let read: Sums | null;
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
      live = read;
    }
  }

  // What is shown: the sums as they stood when the present quarter of an hour began, and the answer made from them.
  let shown: { quarter: number; sums: Sums; body: StatsResponse | null } | null = null;
  const turn = (): { quarter: number; sums: Sums; body: StatsResponse | null } => {
    const quarter = Math.floor(now() / QUARTER_MS);
    if (shown === null || quarter > shown.quarter) {
      prune(live, now());
      shown = { quarter, sums: copyOf(live), body: null };
    }
    return shown;
  };
  const take = (delivery: Delivery): void => {
    const current = turn();
    add(live, delivery, now());
    // A delivery from before the quarter began, told of only now (an order found at start), belongs to what is shown already.
    if (delivery.at < current.quarter * QUARTER_MS) {
      add(current.sums, delivery, now());
      current.body = null;
    }
  };
  const save = () => writeDurable(file, JSON.stringify(toFile(live)));

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
      take(delivery);
      if (write) save();
      return true;
    },
    save,
    seed(deliveries) {
      for (const delivery of deliveries) take(delivery);
      save();
    },
    view() {
      const current = turn();
      current.body ??= render(current.sums, current.quarter, options.feedMin, random);
      return current.body;
    },
  };
}
