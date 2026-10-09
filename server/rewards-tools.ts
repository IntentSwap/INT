// What the two payout tools do, apart from reading the command line: showing what closing a week
// would do, closing it into a list of payouts, and checking that a payout transaction really paid
// an address on that list from the reserve wallet. Run by hand by the operator; there is no web
// route for any of it, and nothing here sends anything.

import { formatExact, parseAmount } from "../shared/amounts.ts";
import { isValidTxHash } from "../shared/addresses.ts";
import { MICRO, minPayoutFor, RESERVE_ASSET, weekBounds } from "../shared/rewards.ts";
import { decimalsOf, type Rewards, type WeekRecord, type WeekShare } from "./rewards.ts";
import { decodeTransferLog, hexToBigInt, SELECTOR_DECIMALS, type Rpc, type RpcCall } from "./rpc.ts";
import type { Sanctions } from "./sanctions.ts";

/** A whole number of millionths as a plain decimal with six places: 1234567n gives "1.234567". */
const sixPlaces = (micro: bigint): string => `${micro / MICRO}.${(micro % MICRO).toString().padStart(6, "0")}`;

/** An amount of a coin, from its smallest unit, as a plain decimal. */
const coins = (raw: bigint, decimals: number): string => formatExact(raw, decimals);

/**
 * The coin rewards are paid in, as the tools need it: the token's contract on BNB Chain, and its
 * decimals. Every amount the tools take, work out and write down is of this token, in its own
 * smallest unit.
 */
export interface RewardToken {
  address: string;
  decimals: number;
}

/**
 * The reward token's decimals: 18 for the built-in token, and for any other the figure that token
 * itself reports on BNB Chain. Null when it could not be read: nothing is then guessed.
 */
export async function rewardTokenDecimals(rpc: Rpc, token: string): Promise<number | null> {
  if (token.toLowerCase() === RESERVE_ASSET.contract.toLowerCase()) return RESERVE_ASSET.decimals;
  try {
    const reply = await rpc.call("bsc", "eth_call", [{ to: token, data: SELECTOR_DECIMALS }, "latest"]);
    const value = reply.ok ? hexToBigInt(reply.result) : null;
    return value === null || value > 36n ? null : Number(value);
  } catch {
    return null;
  }
}

/** A pool as it is typed ("12.5"), as an amount of the reward token in its smallest unit. Anything that is not an amount of it is refused. */
export function poolAmount(text: string, decimals: number): bigint {
  const amount = parseAmount(text, decimals);
  if (!amount.ok) throw new Error(`"${text}" is not an amount of ${RESERVE_ASSET.symbol}.`);
  return amount.raw;
}

/**
 * The list of payouts for a week, as a CSV: one line per rewards address, in the order of the
 * addresses, with its points (ten for each dollar it swapped, and what was carried in), its share
 * of the week's points, its payout, the points carried into the next week, and what was kept back
 * from an address on the sanctions list. The same week always gives the same text.
 */
export function weekCsv(week: WeekRecord): string {
  const total = BigInt(week.totalPointsMicro);
  const coin = week.asset.toLowerCase();
  const decimals = decimalsOf(week);
  const lines = [`rewards_address,points,share,payout_${coin},carried_points,withheld_${coin}`];
  for (const share of week.shares) {
    const points = BigInt(share.pointsMicro);
    // The share as a decimal fraction of one, to eight places, rounded down.
    const fraction = total === 0n ? 0n : (points * 100_000_000n) / total;
    lines.push([share.address, sixPlaces(points), `${fraction / 100_000_000n}.${(fraction % 100_000_000n).toString().padStart(8, "0")}`, coins(BigInt(share.payout), decimals), sixPlaces(BigInt(share.carriedMicro)), coins(BigInt(share.withheld ?? "0"), decimals)].join(","));
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
  /** The week's volume in US dollars, every address's swaps together. Null for a week closed before it was kept. */
  volumeUsd: string | null;
}

export function weekSummary(week: WeekRecord): WeekSummary {
  const bounds = weekBounds(week.week);
  const kept = week.shares.filter((share) => share.withheld !== undefined);
  const decimals = decimalsOf(week);
  return {
    week: week.week,
    from: new Date(bounds?.start ?? 0).toISOString(),
    to: new Date((bounds?.end ?? 1) - 1).toISOString(),
    asset: week.asset,
    pool: coins(BigInt(week.pool), decimals),
    paid: coins(BigInt(week.paid), decimals),
    leftInReserve: coins(BigInt(week.left), decimals),
    withheld: coins(kept.reduce((sum, share) => sum + BigInt(share.withheld ?? "0"), 0n), decimals),
    addresses: week.shares.length,
    addressesPaid: week.shares.filter((share) => BigInt(share.payout) > 0n).length,
    addressesCarried: week.shares.filter((share) => BigInt(share.carriedMicro) > 0n).length,
    addressesWithheld: kept.length,
    totalPoints: sixPlaces(BigInt(week.totalPointsMicro)),
    volumeUsd: week.volumeUsdMicro === undefined ? null : sixPlaces(BigInt(week.volumeUsdMicro)),
  };
}

/**
 * What the reserve wallet holds of the reward token, in the token's smallest unit, with the token's
 * decimals: one request to BNB Chain for both. Null when the chain could not be read.
 */
export async function reserveHolds(rpc: Rpc, reserve: string, token: string): Promise<{ amount: bigint; decimals: number } | null> {
  // balanceOf(address)
  const calls: RpcCall[] = [{ method: "eth_call", params: [{ to: token, data: `0x70a08231${reserve.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"] }];
  // The built-in token's decimals are known. Any other token is asked for its own.
  const known = token.toLowerCase() === RESERVE_ASSET.contract.toLowerCase();
  if (!known) calls.push({ method: "eth_call", params: [{ to: token, data: SELECTOR_DECIMALS }, "latest"] });
  try {
    const [amount, decimals] = (await rpc.batch("bsc", calls)).map((reply) => (reply.ok ? hexToBigInt(reply.result) : null));
    if (amount === null || amount === undefined) return null;
    if (known) return { amount, decimals: RESERVE_ASSET.decimals };
    return decimals === null || decimals === undefined || decimals > 36n ? null : { amount, decimals: Number(decimals) };
  } catch {
    return null;
  }
}

export interface WeekExport {
  /** True when the week's record is on disk: written by this run, or there already. False for a look at what closing would do. */
  closed: boolean;
  /** True when the week was closed before this run. Its record stands as it is. */
  already: boolean;
  /** What the reserve wallet held of the reward token when it was asked, in the token's smallest unit. Null when it was not asked or the chain could not be read. */
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
export async function exportWeek(options: { rewards: Rewards; sanctions: Sanctions; rpc: Rpc; reserve: string | null; token: RewardToken; week: string; pool: bigint; asset: string; now: number; close?: boolean }): Promise<WeekExport> {
  const { rewards, week, pool, token } = options;
  const symbol = RESERVE_ASSET.symbol;
  if (options.asset.toUpperCase() !== symbol) throw new Error(`Payouts are sent in ${symbol}. "${options.asset}" is not it.`);
  if (pool < 0n) throw new Error("The pool cannot be less than nothing.");
  const already = rewards.week(week) !== null;
  const plan = rewards.planWeek(week, pool, symbol, minPayoutFor(token.decimals), options.now, options.sanctions, token.decimals);
  if (already) return { closed: true, already: true, reserveHolds: null, record: plan, csv: weekCsv(plan), summary: weekSummary(plan) };
  const holds = options.reserve === null ? null : ((await reserveHolds(options.rpc, options.reserve, token.address))?.amount ?? null);
  // Only the word to close closes. Anything else is a look, and a look writes nothing.
  if (options.close !== true) return { closed: false, already: false, reserveHolds: holds, record: plan, csv: weekCsv(plan), summary: weekSummary(plan) };
  // A pool of nothing sends nothing, so there is nothing to check it against: a week from before
  // there was a reserve wallet can be closed, and its points carried, without one.
  if (pool > 0n && options.reserve === null) throw new Error("RESERVE_ADDRESS is not set, so there is no reserve wallet to check the pool against. Nothing was closed.");
  if (pool > 0n && holds === null) throw new Error("The reserve wallet's balance could not be read from BNB Chain, so the pool could not be checked against it. Nothing was closed. Try again shortly.");
  if (holds !== null && pool > holds) throw new Error(`The pool is ${coins(pool, token.decimals)} ${symbol} and the reserve wallet holds ${coins(holds, token.decimals)}. A week is not closed with more than the reserve holds. Nothing was closed.`);
  const record = rewards.closeWeek(week, pool, symbol, minPayoutFor(token.decimals), options.now, options.sanctions, token.decimals);
  return { closed: true, already: false, reserveHolds: holds, record, csv: weekCsv(record), summary: weekSummary(record) };
}

/** One transfer of the reward token out of the reserve wallet, as the token's own contract recorded it. */
export interface PayoutTransfer {
  /** Who was paid, in small letters. */
  to: string;
  amount: bigint;
}

/**
 * Checks on BNB Chain that a transaction was sent by the reserve wallet and went through, and
 * reads what it holds: the reward token's own records of coins leaving the reserve wallet. A
 * transfer of any other token is no payout, whatever it is called and however much it is. The
 * reason is given in plain words when it did not pass, so that a wrong hash is never recorded.
 */
export async function checkPayoutTx(rpc: Rpc, reserve: string, hash: string, token: string): Promise<{ ok: true; transfers: PayoutTransfer[] } | { ok: false; reason: string }> {
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
    // Only the reward token's own contract speaks for the reward token. A record of the same shape from any other contract says nothing.
    if (event.token !== token.toLowerCase()) continue;
    // Only coins that left the reserve wallet are a payout from it.
    if (event.from !== reserve.toLowerCase()) continue;
    transfers.push({ to: event.to, amount: event.amount });
  }
  return { ok: true, transfers };
}

/**
 * Records payout transactions for a closed week, after checking each of them. A transaction counts
 * only for what it holds: a transfer of the reward token from the reserve wallet to an address on
 * the week's list, for exactly that address's payout, where no transfer is on record for it. Each
 * such transfer is written down with the share it paid. A transaction that holds none, or that
 * any week has on record already, is refused, and nothing is recorded unless every one passes.
 */
export async function recordPayouts(options: { rewards: Rewards; rpc: Rpc; reserve: string; token: string; week: string; hashes: readonly string[]; now: number }): Promise<WeekRecord> {
  const { rewards, week } = options;
  const held = rewards.week(week);
  if (held === null) throw new Error(`Week ${week} is not closed. Run rewards:export for it first.`);
  // A week closed in another coin was to be paid in that coin. A transfer of this one is not its payout.
  if (held.asset !== RESERVE_ASSET.symbol) throw new Error(`Week ${week} was closed in ${held.asset}, not in ${RESERVE_ASSET.symbol}. Only payouts in ${RESERVE_ASSET.symbol} are recorded. Nothing was recorded.`);
  if (options.hashes.length === 0) throw new Error("Give at least one transaction hash, with --tx.");
  // The payouts still to be recorded, by address. Each is taken off as a transfer is matched to it.
  const unpaid = new Map<string, WeekShare>(held.shares.filter((share) => BigInt(share.payout) > 0n && share.tx === undefined).map((share) => [share.address.toLowerCase(), share]));
  const paid: { address: string; hash: string }[] = [];
  // Each transaction once, however it is spelled and however often it is given.
  for (const hash of new Set(options.hashes.map((given) => given.toLowerCase()))) {
    const recorded = rewards.weekOfTx(hash);
    if (recorded !== null) throw new Error(`${hash}: it is on record already, for week ${recorded}. Nothing was recorded.`);
    const check = await checkPayoutTx(options.rpc, options.reserve, hash, options.token);
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
