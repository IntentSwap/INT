// Points and weekly rewards: the record on disk and everything worked out from it.
//
// Points are counted here and nowhere else, from orders this server made, verified and stored, at
// the moment one is delivered. The browser can never submit, name or change a number of points.
// One small file per swap that adds points (DATA_DIR/rewards/entries) and one per closed week
// (DATA_DIR/rewards/weeks). An entry names its order only by a one-way hash; it holds the rewards
// address, the swap's value in dollars, the two coins and the time. These are transaction records
// and are kept as such.
//
// Points are counted from a swap's value: ten for each US dollar. An entry written while they were
// counted from a fee (v: 1) holds no value of the swap, and is not read: its file is left where it
// is, and adds nothing. A week closed then is still read, as it was written.
//
// A week is closed by a tool the operator runs by hand, in another process (see rewards-tools.ts).
// Closing screens the payout list against the sanctions list, and a week is closed only once every
// earlier week that holds points has been.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkAddress, toChecksumAddress } from "../shared/addresses.ts";
import { nextWeek, pointsMicro, poolShare, RESERVE_ASSET, REWARDS, roundedPoints, sharePool, plainSignInMessage, signInMessage, usdToMicro, weekBounds, weekOf, type PointsReason, type RewardsSummary, type RewardsView, type Share } from "../shared/rewards.ts";
import type { Sanctions } from "./sanctions.ts";
import { writeDurable, type OrderRecord } from "./store.ts";

export interface PointsEntry {
  v: 2;
  /** sha256 of the order's ID, in hex. The ID itself is not kept here. */
  order: string;
  /** The rewards address, in its standard spelling. */
  address: string;
  week: string;
  /** When the swap was delivered. */
  at: string;
  /** The swap's value: the provider's dollar value of what was paid, in millionths of a US dollar. Its points are ten times this. */
  volumeUsdMicro: string;
  /** Empty, or why the swap added no points. */
  reasons: PointsReason[];
  from: { symbol: string; chain: string };
  to: { symbol: string; chain: string };
}

export interface WeekShare {
  address: string;
  pointsMicro: string;
  /** What is to be sent to the address, in the coin's smallest unit. Nothing when the share was too small to send, or was kept back. */
  payout: string;
  carriedMicro: string;
  /**
   * Only on a share that was kept back: the address was on the sanctions list when the week was
   * closed. The amount it would have been sent, in the coin's smallest unit. Nothing is sent to it
   * and nothing is carried for it; the amount stays in the reserve and is not handed to the others.
   */
  withheld?: string;
  /** The transaction that paid this share, once it has been sent, checked on-chain and recorded. Absent until then, and on records written before it was kept. */
  tx?: string;
}

export interface WeekRecord {
  v: 1;
  week: string;
  closedAt: string;
  /** The coin the week was closed in, by its symbol. A week is shown and added up in its own coin, whatever rewards are paid in now. */
  asset: string;
  /** That coin's decimals. Absent on a record written before it was kept, when every coin a week was closed in had 18. */
  decimals?: number;
  /** The pool that was shared out, what is to be sent of it, and what stays in the reserve, in the coin's smallest unit. */
  pool: string;
  paid: string;
  left: string;
  totalPointsMicro: string;
  /** The week's volume, every address's swaps together, in millionths of a US dollar. Absent on records written before it was kept. */
  volumeUsdMicro?: string;
  /** The date of the sanctions list the payouts were screened against. Absent on records written before payouts were screened. */
  screenedWith?: string;
  shares: WeekShare[];
  /** The payout transactions, once they have been sent and recorded. Which share each one paid is kept with the share. */
  txs: { hash: string; recordedAt: string }[];
}

/** A quarter of an hour: how often what anyone is told of the week's points is brought up to date. */
export const QUARTER_MS = 900_000;

/** The decimals of the coin a week was closed in: 18 where its record does not say. */
export const decimalsOf = (week: Pick<WeekRecord, "decimals">): number => week.decimals ?? 18;

const WEEK_SHAPE = /^\d{4}-W\d{2}$/;
const ORDER_HASH_SHAPE = /^[0-9a-f]{64}$/;
const lower = (address: string) => address.toLowerCase();

export const orderHash = (id: string): string => createHash("sha256").update(id).digest("hex");

/** A rewards address as given, checked: a valid address of the rewards chain in its standard spelling, or null. */
export function rewardsAddressOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const check = checkAddress(REWARDS.chain, value.trim());
  return check.ok ? toChecksumAddress(check.address) : null;
}

/**
 * The entry a delivered order adds, or null when it adds none: an order that was not delivered, or
 * that names no rewards address. An order whose dollar value the provider did not give adds an
 * entry of no points, which says why.
 */
export function entryFor(record: OrderRecord): PointsEntry | null {
  if (record.state.status !== "delivered") return null;
  const address = rewardsAddressOf(record.rewardsAddress ?? null);
  if (address === null) return null;
  const at = record.state.finishedAt ?? record.state.statusSince;
  const when = Date.parse(at);
  if (!Number.isFinite(when)) return null;
  // The swap's value alone: the dollar value of what was paid, as the order's record holds it.
  // No fee, coin or route is read: every delivered swap counts by its size.
  const volume = usdToMicro(record.amountInUsd);
  return {
    v: 2,
    order: orderHash(record.id),
    address,
    week: weekOf(when),
    at: new Date(when).toISOString(),
    volumeUsdMicro: (volume ?? 0n).toString(),
    reasons: volume === null ? ["no_usd_value"] : [],
    from: { symbol: record.from.symbol, chain: record.from.chain },
    to: { symbol: record.to.symbol, chain: record.to.chain },
  };
}

function isEntry(value: unknown): value is PointsEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<PointsEntry>;
  return e.v === 2 && typeof e.order === "string" && ORDER_HASH_SHAPE.test(e.order) && typeof e.address === "string" && typeof e.week === "string" && WEEK_SHAPE.test(e.week) && typeof e.volumeUsdMicro === "string" && /^\d+$/.test(e.volumeUsdMicro) && Array.isArray(e.reasons);
}

const isDigits = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);

/** A share as a week's file holds it. One written before a share kept its own transaction has none, and is read all the same. */
function isShare(value: unknown): value is WeekShare {
  if (typeof value !== "object" || value === null) return false;
  const share = value as Partial<WeekShare>;
  return typeof share.address === "string" && isDigits(share.pointsMicro) && isDigits(share.payout) && isDigits(share.carriedMicro) && (share.withheld === undefined || isDigits(share.withheld)) && (share.tx === undefined || typeof share.tx === "string");
}

function isWeekRecord(value: unknown): value is WeekRecord {
  if (typeof value !== "object" || value === null) return false;
  const w = value as Partial<WeekRecord>;
  return w.v === 1 && typeof w.week === "string" && WEEK_SHAPE.test(w.week) && isDigits(w.pool) && typeof w.asset === "string" && (w.decimals === undefined || (Number.isInteger(w.decimals) && w.decimals >= 0 && w.decimals <= 36)) && Array.isArray(w.shares) && w.shares.every(isShare) && Array.isArray(w.txs) && w.txs.every((tx) => typeof tx === "object" && tx !== null && typeof (tx as { hash?: unknown }).hash === "string");
}

/** How old a temporary file must be before it is taken for one a crash left behind. A write takes a moment; a minute is far longer than any. */
const STALE_TMP_MS = 60_000;

/**
 * Clears away a half-written file that a crash left behind. A young one is left alone: it may be a
 * write in progress in another process (the server writes entries while a payout tool starts).
 */
function removeStaleTmp(file: string): void {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > STALE_TMP_MS) fs.rmSync(file, { force: true });
  } catch {
    // Gone already: whoever was writing it has finished.
  }
}

/** Said when the payouts of a week cannot be screened. The week is then not closed. */
const NOT_SCREENED = "The sanctions list is missing or out of date, so the payouts cannot be screened. Nothing was closed. Try again once the list has loaded.";

export interface Rewards {
  /** Adds the entry of a delivered order, once. Safe to call again for the same order. */
  recordDelivered(record: OrderRecord): PointsEntry | null;
  /** Writes an entry down, once. What recordDelivered does with the entry it worked out; also how a practice server's sample entries are put in. No route reaches it. */
  record(entry: PointsEntry): void;
  entriesFor(address: string): PointsEntry[];
  /** Every address's points for a week, in millionths: its own swaps, plus what was carried in from the week before. */
  weekPoints(week: string): Map<string, bigint>;
  week(week: string): WeekRecord | null;
  weeks(): WeekRecord[];
  /**
   * What closing a week would write down, worked out and not written: the pool shared out by points,
   * with every address that is due a payout screened against the sanctions list. It refuses whatever
   * closing refuses. For a week that is closed already it gives the record as it stands.
   */
  planWeek(week: string, pool: bigint, asset: string, minPayout: bigint, now: number, sanctions: Sanctions, decimals?: number): WeekRecord;
  /** Closes a week: works out what planWeek does and writes it down. Closing the same week again with the same pool gives the same record. */
  closeWeek(week: string, pool: bigint, asset: string, minPayout: bigint, now: number, sanctions: Sanctions, decimals?: number): WeekRecord;
  /** The week a transaction is on record for, or null. */
  weekOfTx(hash: string): string | null;
  /**
   * Writes down which transaction paid which share of a closed week. The tool that calls it has
   * checked each transaction on-chain first. A share is paid once, and a transaction is on record
   * for one week only.
   */
  recordPaid(week: string, paid: readonly { address: string; hash: string }[], now: number): WeekRecord;
  /**
   * One address's own points, with its share of the week's points and what that share of the pool
   * comes to. The pool is handed in by whoever asks (its amount in the coin's smallest unit, its
   * value in millionths of a dollar or null, the coin's decimals), or null where there is none.
   */
  view(address: string, now: number, pool?: { amount: bigint; usdMicro: bigint | null; decimals: number } | null): RewardsView;
  summary(now: number): RewardsSummary;
}

export function createRewards(dataDir: string): Rewards {
  const entriesDir = path.join(dataDir, "rewards", "entries");
  const weeksDir = path.join(dataDir, "rewards", "weeks");
  fs.mkdirSync(entriesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(weeksDir, { recursive: true, mode: 0o700 });

  /** Every entry, by the lower-case form of its address, and the order hashes already recorded. */
  const byAddress = new Map<string, PointsEntry[]>();
  const recorded = new Set<string>();
  const remember = (entry: PointsEntry) => {
    if (recorded.has(entry.order)) return;
    recorded.add(entry.order);
    const list = byAddress.get(lower(entry.address));
    if (list === undefined) byAddress.set(lower(entry.address), [entry]);
    else list.push(entry);
  };
  for (const name of fs.readdirSync(entriesDir)) {
    if (name.includes(".tmp-")) {
      removeStaleTmp(path.join(entriesDir, name));
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(entriesDir, name), "utf8"));
      if (isEntry(parsed) && name === `${parsed.order}.json`) remember(parsed);
    } catch {
      // A file that cannot be read is not an entry. It is left where it is for a person to look at.
    }
  }

  // Closed weeks are written by a tool run by hand, in another process. A week's file is read and
  // parsed once and kept. It is read again only when the file has changed (another file has taken
  // its place, or its size or its time of writing differ), so that a request for the Rewards page
  // does not read every closed week from disk again.
  const weekFile = (week: string) => path.join(weeksDir, `${week}.json`);
  const kept = new Map<string, { stamp: string; record: WeekRecord | null }>();
  const readWeek = (week: string): WeekRecord | null => {
    if (!WEEK_SHAPE.test(week)) return null;
    let stamp: string;
    try {
      const stat = fs.statSync(weekFile(week));
      stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      kept.delete(week);
      return null;
    }
    const held = kept.get(week);
    if (held !== undefined && held.stamp === stamp) return held.record;
    let record: WeekRecord | null = null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(weekFile(week), "utf8"));
      if (isWeekRecord(parsed) && parsed.week === week) record = parsed;
    } catch {
      // A file that cannot be read is not a week's record. It is left where it is for a person to look at.
    }
    kept.set(week, { stamp, record });
    return record;
  };
  const readWeeks = (): WeekRecord[] =>
    fs
      .readdirSync(weeksDir)
      .filter((name) => /^\d{4}-W\d{2}\.json$/.test(name))
      .sort()
      .flatMap((name) => {
        const week = readWeek(name.slice(0, -5));
        return week === null ? [] : [week];
      });

  /** An address's own swaps in a week, before anything carried in: their volume, summed, and the points for it. */
  const ownWeek = (entries: readonly PointsEntry[], week: string, before?: number): { volume: bigint; points: bigint } => {
    // With a moment given, only the swaps delivered before it are counted.
    const volume = entries.filter((entry) => entry.week === week && (before === undefined || Date.parse(entry.at) < before)).reduce((total, entry) => total + BigInt(entry.volumeUsdMicro), 0n);
    return { volume, points: pointsMicro(volume) };
  };
  /** A week's volume, every address's swaps together, in millionths of a dollar. */
  const weekVolume = (week: string): bigint => {
    let total = 0n;
    for (const entries of byAddress.values()) total += ownWeek(entries, week).volume;
    return total;
  };
  /** What a closed week carried forward for each address: shares too small to send, and every share of a week nothing was paid for. */
  const carriedFrom = (week: WeekRecord | null): Map<string, bigint> => new Map((week?.shares ?? []).filter((share) => BigInt(share.carriedMicro) > 0n).map((share) => [lower(share.address), BigInt(share.carriedMicro)]));
  const previousWeek = (week: string): string | null => {
    const bounds = weekBounds(week);
    return bounds === null ? null : weekOf(bounds.start - 1);
  };
  /**
   * The earliest week before one that holds points and has not been closed, or null. A week holds
   * points when a swap was delivered in it, or when a closed week carried points into it. Points
   * are carried from one week into the next and no further, so a week left open between two closed
   * ones would lose what was carried into it. (Weeks are written so that they sort as text.)
   */
  const earlierOpenWeek = (week: string): string | null => {
    const candidates = new Set<string>();
    for (const entries of byAddress.values()) for (const entry of entries) if (entry.week < week) candidates.add(entry.week);
    for (const closed of readWeeks()) {
      if (closed.week >= week || carriedFrom(closed).size === 0) continue;
      const after = nextWeek(closed.week);
      if (after < week) candidates.add(after);
    }
    for (const candidate of [...candidates].sort()) if (readWeek(candidate) === null && self.weekPoints(candidate).size > 0) return candidate;
    return null;
  };

  /**
   * Every address's points for a week, by the lower-case form of the address: its own swaps, plus
   * what was carried in from the week before. With a moment given, only swaps delivered before it.
   */
  const pointsOf = (week: string, before?: number): Map<string, { address: string; points: bigint }> => {
    const out = new Map<string, { address: string; points: bigint }>();
    for (const [key, entries] of byAddress) {
      const { points } = ownWeek(entries, week, before);
      if (points > 0n) out.set(key, { address: entries[0]?.address ?? key, points });
    }
    const earlier = previousWeek(week);
    const closedBefore = earlier === null ? null : readWeek(earlier);
    const carried = carriedFrom(closedBefore);
    for (const share of closedBefore?.shares ?? []) {
      const amount = carried.get(lower(share.address)) ?? 0n;
      if (amount === 0n) continue;
      const held = out.get(lower(share.address));
      out.set(lower(share.address), { address: held?.address ?? share.address, points: (held?.points ?? 0n) + amount });
    }
    return out;
  };

  /**
   * The week's points as they stood when the current quarter of an hour began: everyone's together,
   * and each address's own. Worked out once in a quarter and kept for it, so that what anyone is
   * told of the week's total moves four times an hour and not with each swap, and so that no
   * request adds up the whole record again. A swap delivered inside the quarter is not in it, and
   * neither is one written down late: both join at the next quarter.
   */
  let quarter: { start: number; week: string; total: bigint; own: Map<string, bigint> } | null = null;
  const quarterOf = (now: number) => {
    const start = Math.floor(now / QUARTER_MS) * QUARTER_MS;
    const week = weekOf(now);
    if (quarter === null || quarter.start !== start || quarter.week !== week) {
      const own = new Map<string, bigint>();
      let total = 0n;
      for (const [key, item] of pointsOf(week, start)) {
        own.set(key, item.points);
        total += item.points;
      }
      quarter = { start, week, total, own };
    }
    return quarter;
  };

  const self: Rewards = {
    recordDelivered(record) {
      const entry = entryFor(record);
      if (entry === null) return null;
      self.record(entry);
      return entry;
    },
    record(entry) {
      if (!isEntry(entry)) return;
      const file = path.join(entriesDir, `${entry.order}.json`);
      // The file is the record. Where one is there already it stands as it is, and nothing is added
      // here: an entry that was read from it at start is in memory already, and a file that could not
      // be read as an entry (one of the older kind) adds nothing. So what is in memory is always what
      // a fresh reading of the folder would hold, and nothing appears now that would be gone at the next start.
      if (fs.existsSync(file)) return;
      writeDurable(file, JSON.stringify(entry));
      remember(entry);
    },
    entriesFor: (address) => [...(byAddress.get(lower(address)) ?? [])],
    weekPoints(week) {
      return new Map([...pointsOf(week).values()].map((item) => [item.address, item.points]));
    },
    week: readWeek,
    weeks: readWeeks,
    planWeek(week, pool, asset, minPayout, now, sanctions, decimals = RESERVE_ASSET.decimals) {
      const bounds = weekBounds(week);
      if (bounds === null) throw new Error(`"${week}" is not a week. Write it as 2026-W41.`);
      if (now < bounds.end) throw new Error(`Week ${week} has not ended yet. It ends on ${new Date(bounds.end).toISOString()}.`);
      const held = readWeek(week);
      if (held !== null) {
        if (held.pool !== pool.toString() || held.asset !== asset) throw new Error(`Week ${week} is already closed, with a pool of ${held.pool} ${held.asset}. A closed week is not closed again with another.`);
        return held;
      }
      // A file that is there and cannot be read as a week's record is never written over.
      if (fs.existsSync(weekFile(week))) throw new Error(`Week ${week} has a record that cannot be read. It was left as it is. Look at rewards/weeks/${week}.json in the data folder.`);
      const open = earlierOpenWeek(week);
      if (open !== null) throw new Error(`Week ${open} holds points and is still open. Close it first, with a pool of nothing if nothing is to be paid for it.`);
      // Screened with the list order creation uses, and by the same rule: no usable list, no payout list.
      if (!sanctions.available()) throw new Error(NOT_SCREENED);
      const result = sharePool(pool, self.weekPoints(week), minPayout);
      let paid = 0n;
      const shares = result.shares.map((share: Share): WeekShare => {
        const mine = { address: share.address, pointsMicro: share.points.toString() };
        if (share.payout === 0n) return { ...mine, payout: "0", carriedMicro: share.carried.toString() };
        // One address at a time, so that the one that is listed is known.
        const screening = sanctions.screen([share.address]);
        if (!screening.ok && screening.reason === "unavailable") throw new Error(NOT_SCREENED);
        // A listed address is sent nothing and carries nothing. Its share was worked out with everyone's
        // points, its own among them, so what it would have had stays in the reserve.
        if (!screening.ok) return { ...mine, payout: "0", carriedMicro: "0", withheld: share.payout.toString() };
        paid += share.payout;
        return { ...mine, payout: share.payout.toString(), carriedMicro: "0" };
      });
      return {
        v: 1,
        week,
        closedAt: new Date(now).toISOString(),
        asset,
        decimals,
        pool: pool.toString(),
        paid: paid.toString(),
        left: (pool - paid).toString(),
        totalPointsMicro: result.totalPoints.toString(),
        volumeUsdMicro: weekVolume(week).toString(),
        screenedWith: sanctions.version() ?? "",
        shares,
        txs: [],
      };
    },
    closeWeek(week, pool, asset, minPayout, now, sanctions, decimals) {
      const closed = readWeek(week) !== null;
      const record = self.planWeek(week, pool, asset, minPayout, now, sanctions, decimals);
      // A week that is closed already stands as it was written: it is read back, never written again.
      if (!closed) writeDurable(weekFile(week), JSON.stringify(record));
      return record;
    },
    weekOfTx(hash) {
      const wanted = hash.toLowerCase();
      for (const item of readWeeks()) {
        if (item.txs.some((tx) => tx.hash.toLowerCase() === wanted) || item.shares.some((share) => share.tx?.toLowerCase() === wanted)) return item.week;
      }
      return null;
    },
    recordPaid(week, paid, now) {
      const held = readWeek(week);
      if (held === null) throw new Error(`Week ${week} is not closed. Close it first.`);
      if (paid.length === 0) return held;
      const shares = held.shares.map((share) => ({ ...share }));
      const hashes: string[] = [];
      for (const item of paid) {
        const hash = item.hash.toLowerCase();
        const share = shares.find((candidate) => lower(candidate.address) === lower(item.address));
        if (share === undefined || BigInt(share.payout) === 0n) throw new Error(`${item.address} has no payout in week ${week}.`);
        if (share.tx !== undefined) throw new Error(`The payout to ${share.address} in week ${week} has a transaction on record already.`);
        share.tx = hash;
        if (!hashes.includes(hash)) hashes.push(hash);
      }
      // One transaction, one week: a hash that any week has on record is not written down again.
      for (const hash of hashes) {
        const other = self.weekOfTx(hash);
        if (other !== null) throw new Error(`Transaction ${hash} is on record for week ${other} already. A transaction is recorded once.`);
      }
      const at = new Date(now).toISOString();
      const next: WeekRecord = { ...held, shares, txs: [...held.txs, ...hashes.map((hash) => ({ hash, recordedAt: at }))] };
      writeDurable(weekFile(week), JSON.stringify(next));
      return next;
    },
    view(address, now, pool = null) {
      const entries = self.entriesFor(address).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      const week = weekOf(now);
      const bounds = weekBounds(week);
      const closed = readWeeks();
      const own = ownWeek(entries, week);
      const before = previousWeek(week);
      const carriedIn = carriedFrom(closed.find((item) => item.week === before) ?? null).get(lower(address)) ?? 0n;
      const weeksWithEntries = new Set(entries.map((entry) => entry.week));
      let allTime = 0n;
      for (const item of weeksWithEntries) allTime += ownWeek(entries, item).points;
      // The share: this address's points now, out of the week's total as it stood when the quarter
      // began with this address's own newer points put in place of its older ones. So a person's own
      // new swap counts at once, and everybody else's a quarter late: the answer to one address
      // never moves with another's swap inside the quarter.
      const mine = own.points + carriedIn;
      const snapshot = quarterOf(now);
      const part = poolShare(mine, snapshot.total - (snapshot.own.get(lower(address)) ?? 0n) + mine, pool);
      return {
        address: toChecksumAddress(address),
        week: { id: week, start: new Date(bounds?.start ?? now).toISOString(), end: new Date(bounds?.end ?? now).toISOString(), pointsMicro: (own.points + carriedIn).toString(), carriedInMicro: carriedIn.toString() },
        allTimeMicro: allTime.toString(),
        swaps: entries.slice(0, 200).map((entry) => ({ at: entry.at, week: entry.week, from: entry.from, to: entry.to, pointsMicro: pointsMicro(BigInt(entry.volumeUsdMicro)).toString(), reasons: entry.reasons })),
        // Its own payout and its own transfer, and no other address's: none yet until that transfer is on record.
        payouts: closed
          .flatMap((item) => {
            const share = item.shares.find((candidate) => lower(candidate.address) === lower(address));
            return share !== undefined && BigInt(share.payout) > 0n ? [{ week: item.week, amount: share.payout, asset: item.asset, decimals: decimalsOf(item), txs: share.tx === undefined ? [] : [share.tx] }] : [];
          })
          .reverse(),
        share: { bps: Number(part.shareBps), estimate: pool === null ? null : part.estimate.toString(), estimateCents: part.estimateCents === null ? null : part.estimateCents.toString(), decimals: pool?.decimals ?? RESERVE_ASSET.decimals },
      };
    },
    summary(now) {
      const week = weekOf(now);
      const bounds = weekBounds(week);
      // What a week has paid is what is on record as sent: the shares that have a transfer of their own.
      // What was worked out when the week was closed is not counted until then.
      const paidWeeks = readWeeks().flatMap((item) => {
        const sent = item.shares.filter((share) => share.tx !== undefined && BigInt(share.payout) > 0n);
        if (sent.length === 0) return [];
        const paid = sent.reduce((sum, share) => sum + BigInt(share.payout), 0n);
        // Its transactions, each once, in the order they were recorded.
        const mine = new Set(sent.map((share) => share.tx ?? ""));
        const inOrder = item.txs.map((tx) => tx.hash).filter((hash) => mine.has(hash));
        return [{ week: item.week, asset: item.asset, decimals: decimalsOf(item), paid, txs: [...new Set([...inOrder, ...mine])] }];
      });
      const paidNow = paidWeeks.filter((item) => item.asset === RESERVE_ASSET.symbol);
      return {
        week: { id: week, start: new Date(bounds?.start ?? now).toISOString(), end: new Date(bounds?.end ?? now).toISOString() },
        // The week's points as one number, with no address to it: as they stood when this quarter of an
        // hour began, and rounded down to two significant figures. Nothing finer is told to anyone.
        weekPointsMicro: roundedPoints(quarterOf(now).total).toString(),
        weeks: paidWeeks.map((item) => ({ week: item.week, asset: item.asset, decimals: item.decimals, paid: item.paid.toString(), txs: item.txs })).reverse(),
        // Added up in the coin rewards are paid in now. A week that was paid in another coin is on the list above, in its own.
        totalPaid: paidNow.reduce((sum, item) => sum + item.paid, 0n).toString(),
        weeksPaid: paidNow.length,
      };
    },
  };
  return self;
}

/** The week after a closed one: where points carried forward are counted. Used by the tools to say so. */
export const weekAfter = nextWeek;

// ---- Signing in on the Rewards page ----

export interface SignIn {
  /** A one-time code for an address, and the message to sign. */
  challenge(address: string, host: string, now: number, chainId?: number): { message: string; plain: string; nonce: string; issuedAt: number; expiresAt: number; chainId: number };
  /** The address a code was issued for and the two texts either of which was to be signed: the message, and the same in plain sentences. The code is used up by asking. */
  redeem(nonce: unknown, now: number): { address: string; message: string; plain: string } | null;
  /** A session for an address, once its signature has been checked. */
  issue(address: string, now: number): { token: string; expiresAt: number };
  /** The address a session is for, or null. */
  verify(token: unknown, now: number): string | null;
}

/** How far before the moment of asking a sign-in message says it was made. */
const ISSUED_BEFORE_MS = 60_000;

/** The most one-time codes kept at once. Beyond it the oldest are dropped: a flood of requests cannot fill the memory. */
const MAX_NONCES = 20_000;

export function createSignIn(secret: Buffer = randomBytes(32)): SignIn {
  const nonces = new Map<string, { address: string; message: string; plain: string; expiresAt: number }>();
  const sign = (payload: string) => createHmac("sha256", secret).update(`rewards.${payload}`).digest("base64url");
  return {
    challenge(address, host, now, chainId = REWARDS.chainId) {
      const nonce = randomBytes(16).toString("hex");
      const expiresAt = now + REWARDS.nonceMinutes * 60_000;
      // A wallet that reads the message refuses one "issued" later than its own clock says it is: the
      // time written is a little before now, so that a wallet whose clock runs behind still takes it.
      const issuedAt = now - ISSUED_BEFORE_MS;
      const parts = { host, address, nonce, issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), chainId };
      const message = signInMessage(parts);
      const plain = plainSignInMessage(parts);
      for (const [key, held] of nonces) if (held.expiresAt <= now) nonces.delete(key);
      while (nonces.size >= MAX_NONCES) {
        const oldest = nonces.keys().next().value;
        if (oldest === undefined) break;
        nonces.delete(oldest);
      }
      nonces.set(nonce, { address, message, plain, expiresAt });
      return { message, plain, nonce, issuedAt, expiresAt, chainId };
    },
    redeem(nonce, now) {
      if (typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return null;
      const held = nonces.get(nonce);
      // Used up whether or not what follows succeeds: a code is good for one attempt.
      nonces.delete(nonce);
      if (held === undefined || held.expiresAt <= now) return null;
      return { address: held.address, message: held.message, plain: held.plain };
    },
    issue(address, now) {
      const expiresAt = now + REWARDS.sessionMinutes * 60_000;
      const payload = `r1.${expiresAt}.${lower(address)}`;
      return { token: `${payload}.${sign(payload)}`, expiresAt };
    },
    verify(token, now) {
      if (typeof token !== "string" || token.length > 200) return null;
      const parts = token.split(".");
      if (parts.length !== 4 || parts[0] !== "r1") return null;
      const [version, expires, address, mac] = parts as [string, string, string, string];
      if (!/^\d{13}$/.test(expires) || !/^0x[0-9a-f]{40}$/.test(address)) return null;
      const expected = Buffer.from(sign(`${version}.${expires}.${address}`));
      const given = Buffer.from(mac);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      return Number(expires) > now ? toChecksumAddress(address) : null;
    },
  };
}
