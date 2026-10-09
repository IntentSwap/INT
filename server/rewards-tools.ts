// What the two payout tools do, apart from reading the command line: showing what closing a week
// would do, closing it into a list of payouts, and checking that a payout transaction really paid
// an address on that list from the reserve wallet. Run by hand by the operator; there is no web
// route for any of it, and nothing here sends anything.

import { formatExact } from "../shared/amounts.ts";
import { isValidTxHash } from "../shared/addresses.ts";
import { MICRO, RESERVE_ASSET, weekBounds } from "../shared/rewards.ts";
import type { Rewards, WeekRecord, WeekShare } from "./rewards.ts";
import { decodeTransferLog, hexToBigInt, type Rpc } from "./rpc.ts";
import type { Sanctions } from "./sanctions.ts";

/** A whole number of millionths as a plain decimal with six places: 1234567n gives "1.234567". */
const sixPlaces = (micro: bigint): string => `${micro / MICRO}.${(micro % MICRO).toString().padStart(6, "0")}`;

/** An amount of the payout coin, from its smallest unit, as a plain decimal. */
const coins = (raw: bigint): string => formatExact(raw, RESERVE_ASSET.decimals);

/**
 * The list of payouts for a week, as a CSV: one line per rewards address, in the order of the
 * addresses, with its points, its share of the week's points, its payout, the points carried into
 * the next week, and what was kept back from an address on the sanctions list. The same week
 * always gives the same text.
 */
export function weekCsv(week: WeekRecord): string {
  const total = BigInt(week.totalPointsMicro);
  const coin = week.asset.toLowerCase();
  const lines = [`rewards_address,points,share,payout_${coin},carried_points,withheld_${coin}`];
  for (const share of week.shares) {
    const points = BigInt(share.pointsMicro);
    // The share as a decimal fraction of one, to eight places, rounded down.
    const fraction = total === 0n ? 0n : (points * 100_000_000n) / total;
    lines.push([share.address, sixPlaces(points), `${fraction / 100_000_000n}.${(fraction % 100_000_000n).toString().padStart(8, "0")}`, coins(BigInt(share.payout)), sixPlaces(BigInt(share.carriedMicro)), coins(BigInt(share.withheld ?? "0"))].join(","));
  }
  return `${lines.join("\n")}\n`;
}

export interface WeekSummary {
  week: string;
  from: string;
  to: string;
  asset: string;
  pool: string;
  /** What is to be sent: the payouts on the list, added up. */
  paid: string;
  /** What stays in the reserve: what rounding left over, shares too small to send, and what was kept back. */
  leftInReserve: string;
  /** Of that, what was kept back from addresses on the sanctions list. */
  withheld: string;
  addresses: number;
  addressesPaid: number;
  addressesCarried: number;
  addressesWithheld: number;
  totalPoints: string;
  /** The week's counted fee in US dollars, every address's together. Null for a week closed before it was kept. */
  countedFeeUsd: string | null;
}

export function weekSummary(week: WeekRecord): WeekSummary {
  const bounds = weekBounds(week.week);
  const kept = week.shares.filter((share) => share.withheld !== undefined);
  return {
    week: week.week,
    from: new Date(bounds?.start ?? 0).toISOString(),
    to: new Date((bounds?.end ?? 1) - 1).toISOString(),
    asset: week.asset,
    pool: coins(BigInt(week.pool)),
    paid: coins(BigInt(week.paid)),
    leftInReserve: coins(BigInt(week.left)),
    withheld: coins(kept.reduce((sum, share) => sum + BigInt(share.withheld ?? "0"), 0n)),
    addresses: week.shares.length,
    addressesPaid: week.shares.filter((share) => BigInt(share.payout) > 0n).length,
    addressesCarried: week.shares.filter((share) => BigInt(share.carriedMicro) > 0n).length,
    addressesWithheld: kept.length,
    totalPoints: sixPlaces(BigInt(week.totalPointsMicro)),
    countedFeeUsd: week.countedFeeUsdMicro === undefined ? null : sixPlaces(BigInt(week.countedFeeUsdMicro)),
  };
}

/**
 * What the reserve wallet holds of the payout coin, read from BNB Chain, in the coin's smallest
 * unit. Null when the chain could not be read.
 */
export async function reserveHolds(rpc: Rpc, reserve: string): Promise<bigint | null> {
  try {
    // balanceOf(address)
    const reply = await rpc.call("bsc", "eth_call", [{ to: RESERVE_ASSET.contract, data: `0x70a08231${reserve.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"]);
    return reply.ok ? hexToBigInt(reply.result) : null;
  } catch {
    return null;
  }
}

export interface WeekExport {
  /** True when the week's record is on disk: written by this run, or there already. False for a look at what closing would do. */
  closed: boolean;
  /** True when the week was closed before this run. Its record stands as it is. */
  already: boolean;
  /** What the reserve wallet held when it was asked, in the coin's smallest unit. Null when it was not asked or the chain could not be read. */
  reserveHolds: bigint | null;
  record: WeekRecord;
  csv: string;
  summary: WeekSummary;
}

/**
 * Shows what closing a week with a pool would do, and closes it only when told to.
 *
 * Without `close` nothing at all is written: the week's payouts are worked out, screened and given
 * back to be looked at. With `close` the pool is first checked against what the reserve wallet
 * holds, read from the chain: a pool larger than that, or a balance that cannot be read, closes
 * nothing. A week that is closed already is read back as it stands.
 */
export async function exportWeek(options: { rewards: Rewards; sanctions: Sanctions; rpc: Rpc; reserve: string | null; week: string; pool: bigint; asset: string; now: number; close?: boolean }): Promise<WeekExport> {
  const { rewards, week, pool } = options;
  if (options.asset.toUpperCase() !== RESERVE_ASSET.symbol) throw new Error(`Payouts are sent in ${RESERVE_ASSET.symbol}. "${options.asset}" is not it.`);
  if (pool < 0n) throw new Error("The pool cannot be less than nothing.");
  const already = rewards.week(week) !== null;
  const plan = rewards.planWeek(week, pool, RESERVE_ASSET.symbol, RESERVE_ASSET.minPayout, options.now, options.sanctions);
  if (already) return { closed: true, already: true, reserveHolds: null, record: plan, csv: weekCsv(plan), summary: weekSummary(plan) };
  const holds = options.reserve === null ? null : await reserveHolds(options.rpc, options.reserve);
  // Only the word to close closes. Anything else is a look, and a look writes nothing.
  if (options.close !== true) return { closed: false, already: false, reserveHolds: holds, record: plan, csv: weekCsv(plan), summary: weekSummary(plan) };
  // A pool of nothing sends nothing, so there is nothing to check it against: a week from before
  // there was a reserve wallet can be closed, and its points carried, without one.
  if (pool > 0n && options.reserve === null) throw new Error("RESERVE_ADDRESS is not set, so there is no reserve wallet to check the pool against. Nothing was closed.");
  if (pool > 0n && holds === null) throw new Error("The reserve wallet's balance could not be read from BNB Chain, so the pool could not be checked against it. Nothing was closed. Try again shortly.");
  if (holds !== null && pool > holds) throw new Error(`The pool is ${coins(pool)} ${RESERVE_ASSET.symbol} and the reserve wallet holds ${coins(holds)}. A week is not closed with more than the reserve holds. Nothing was closed.`);
  const record = rewards.closeWeek(week, pool, RESERVE_ASSET.symbol, RESERVE_ASSET.minPayout, options.now, options.sanctions);
  return { closed: true, already: false, reserveHolds: holds, record, csv: weekCsv(record), summary: weekSummary(record) };
}

/** One transfer of the payout coin out of the reserve wallet, as the coin's own contract recorded it. */
export interface PayoutTransfer {
  /** Who was paid, in small letters. */
  to: string;
  amount: bigint;
}

/**
 * Checks on BNB Chain that a transaction was sent by the reserve wallet and went through, and
 * reads what it holds: the payout coin's own records of coins leaving the reserve wallet. The
 * reason is given in plain words when it did not pass, so that a wrong hash is never recorded.
 */
export async function checkPayoutTx(rpc: Rpc, reserve: string, hash: string): Promise<{ ok: true; transfers: PayoutTransfer[] } | { ok: false; reason: string }> {
  if (!isValidTxHash("bsc", hash)) return { ok: false, reason: "that is not a transaction hash" };
  const [tx, receipt] = await rpc.batch("bsc", [
    { method: "eth_getTransactionByHash", params: [hash] },
    { method: "eth_getTransactionReceipt", params: [hash] },
  ]);
  if (tx === undefined || receipt === undefined || !tx.ok || !receipt.ok) return { ok: false, reason: "BNB Chain could not be read" };
  const sent = tx.result as { from?: unknown } | null;
  const done = receipt.result as { status?: unknown; logs?: unknown } | null;
  if (sent === null || typeof sent !== "object") return { ok: false, reason: "no such transaction on BNB Chain" };
  if (typeof sent.from !== "string" || sent.from.toLowerCase() !== reserve.toLowerCase()) return { ok: false, reason: "it was not sent from the reserve wallet" };
  if (done === null || typeof done !== "object") return { ok: false, reason: "it has not been included in a block yet" };
  if (done.status !== "0x1") return { ok: false, reason: "it failed on-chain" };
  const transfers: PayoutTransfer[] = [];
  for (const entry of Array.isArray(done.logs) ? (done.logs as unknown[]) : []) {
    const event = decodeTransferLog(entry);
    if (event === null || event.amount === 0n) continue;
    // Only the payout coin's own contract speaks for the payout coin. A record of the same shape from any other contract says nothing.
    if (event.token !== RESERVE_ASSET.contract.toLowerCase()) continue;
    // Only coins that left the reserve wallet are a payout from it.
    if (event.from !== reserve.toLowerCase()) continue;
    transfers.push({ to: event.to, amount: event.amount });
  }
  return { ok: true, transfers };
}

/**
 * Records payout transactions for a closed week, after checking each of them. A transaction counts
 * only for what it holds: a transfer of the payout coin from the reserve wallet to an address on
 * the week's list, for exactly that address's payout, where no transfer is on record for it. Each
 * such transfer is written down with the share it paid. A transaction that holds none, or that
 * any week has on record already, is refused, and nothing is recorded unless every one passes.
 */
export async function recordPayouts(options: { rewards: Rewards; rpc: Rpc; reserve: string; week: string; hashes: readonly string[]; now: number }): Promise<WeekRecord> {
  const { rewards, week } = options;
  const held = rewards.week(week);
  if (held === null) throw new Error(`Week ${week} is not closed. Run rewards:export for it first.`);
  if (options.hashes.length === 0) throw new Error("Give at least one transaction hash, with --tx.");
  // The payouts still to be recorded, by address. Each is taken off as a transfer is matched to it.
  const unpaid = new Map<string, WeekShare>(held.shares.filter((share) => BigInt(share.payout) > 0n && share.tx === undefined).map((share) => [share.address.toLowerCase(), share]));
  const paid: { address: string; hash: string }[] = [];
  // Each transaction once, however it is spelled and however often it is given.
  for (const hash of new Set(options.hashes.map((given) => given.toLowerCase()))) {
    const recorded = rewards.weekOfTx(hash);
    if (recorded !== null) throw new Error(`${hash}: it is on record already, for week ${recorded}. Nothing was recorded.`);
    const check = await checkPayoutTx(options.rpc, options.reserve, hash);
    if (!check.ok) throw new Error(`${hash}: ${check.reason}. Nothing was recorded.`);
    let matched = 0;
    for (const transfer of check.transfers) {
      const share = unpaid.get(transfer.to);
      // The amount must be the listed payout exactly: more or less is not that payout.
      if (share === undefined || BigInt(share.payout) !== transfer.amount) continue;
      unpaid.delete(transfer.to);
      paid.push({ address: share.address, hash });
      matched += 1;
    }
    if (matched === 0) throw new Error(`${hash}: it holds no transfer of ${RESERVE_ASSET.symbol} from the reserve wallet to an address still to be paid in week ${week}, for exactly its payout. Nothing was recorded.`);
  }
  return rewards.recordPaid(week, paid, options.now);
}
