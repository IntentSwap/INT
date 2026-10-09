// Server-side status tracking. Open orders are reloaded from disk at start and
// polled until they reach an end state: every 5 s for 2 minutes, then every
// 15 s, then every 60 s after 30 minutes. Errors back off.

import { isValidTxHash } from "../shared/addresses.ts";
import { isDigits } from "../shared/amounts.ts";
import { isEndState, STATUS_MAP, type OrderDetails, type OrderStatus, type TxRef } from "../shared/api.ts";
import { explorerTxUrl, isWalletChain } from "../shared/chains.ts";
import type { Alerts } from "./alerts.ts";
import { hashId, type Logger } from "./log.ts";
import type { OneClick, Priority } from "./oneclick.ts";
import { hasProvenFunds, type OrderRecord, type OrderState, type OrderStore } from "./store.ts";

/** A waiting order becomes "expired" this long after its deadline. */
export const EXPIRE_AFTER_DEADLINE_MS = 10 * 60_000;
/** Regular polling of an unfinished order stops this long after its deadline. */
export const GIVE_UP_AFTER_DEADLINE_MS = 7 * 86_400_000;
const LAZY_RECHECK_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_IN_FLIGHT = 6;

export function pollIntervalMs(sinceAnchorMs: number): number {
  if (sinceAnchorMs < 2 * 60_000) return 5000;
  if (sinceAnchorMs < 30 * 60_000) return 15_000;
  return 60_000;
}

export function backoffMs(base: number, errors: number): number {
  return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(errors, 8));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function txRefs(list: unknown, chain: string): TxRef[] {
  if (!Array.isArray(list)) return [];
  const out: TxRef[] = [];
  for (const item of list.slice(0, 5)) {
    const hash = isRecord(item) ? item.hash : null;
    if (typeof hash !== "string" || !/^[A-Za-z0-9+/=_:.-]{8,128}$/.test(hash)) continue;
    // The link always comes from our own explorer templates, never from the provider's URL.
    out.push({ hash, url: isValidTxHash(chain, hash) ? explorerTxUrl(chain, hash) : null });
  }
  return out;
}

export function parseDetails(swapDetails: unknown, record: OrderRecord): OrderDetails | null {
  if (!isRecord(swapDetails)) return null;
  const raw = (value: unknown): string | null => (isDigits(value) ? value : null);
  const reason = swapDetails.refundReason;
  const details: OrderDetails = {
    originTxs: txRefs(swapDetails.originChainTxHashes, record.from.chain),
    destinationTxs: txRefs(swapDetails.destinationChainTxHashes, record.to.chain),
    depositedAmount: raw(swapDetails.depositedAmount),
    amountIn: raw(swapDetails.amountIn),
    amountOut: raw(swapDetails.amountOut),
    refundedAmount: raw(swapDetails.refundedAmount),
    refundReason: typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(reason) ? reason : null,
  };
  // Nothing to show yet: keep it as "no details" so an unchanged order is not rewritten.
  const empty =
    details.originTxs.length === 0 &&
    details.destinationTxs.length === 0 &&
    details.depositedAmount === null &&
    details.amountIn === null &&
    details.amountOut === null &&
    details.refundedAmount === null &&
    details.refundReason === null;
  return empty ? null : details;
}

export type StatusUpdate =
  | { kind: "state"; state: OrderState; changed: boolean }
  | { kind: "mismatch" }
  | { kind: "invalid" };

/** Statuses that mean funds have arrived. They are never replaced by "waiting" or "expired". */
const FUNDED: readonly OrderStatus[] = ["swapping", "deposit_too_small"];

/**
 * Decides whether a provider status may replace the one we hold.
 * An order only moves forward. A deposit that was merely announced
 * ("deposit seen") may fall back to waiting, because the provider reports that
 * state before the transfer is confirmed. Once funds are in ("swapping",
 * "deposit too small") the only way on is to an end state.
 */
export function allowedTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true;
  if (from === "delivered" || from === "refunded" || from === "failed") return false;
  if (FUNDED.includes(from)) return to === "delivered" || to === "refunded" || to === "failed" || (from === "deposit_too_small" && to === "swapping");
  if (from === "expired") return to !== "waiting";
  return true;
}

/** Pure state transition from a provider status response. */
export function applyStatus(record: OrderRecord, response: unknown, now: number): StatusUpdate {
  if (!isRecord(response) || typeof response.status !== "string") return { kind: "invalid" };
  const mapped = STATUS_MAP.get(response.status);
  if (mapped === undefined) return { kind: "invalid" };

  // The response must be about this order's deposit address.
  const quoteResponse = response.quoteResponse;
  const echoed = isRecord(quoteResponse) && isRecord(quoteResponse.quote) ? quoteResponse.quote.depositAddress : undefined;
  if (echoed !== undefined && echoed !== record.depositAddress) return { kind: "mismatch" };

  const previous = record.state;
  // Delivered, refunded and failed are final: nothing the provider says afterwards changes them.
  if (previous.status === "delivered" || previous.status === "refunded" || previous.status === "failed") {
    return { kind: "state", state: previous, changed: false };
  }
  const deadline = Date.parse(record.deadline);

  // "Expired" is ours: a waiting order the provider still reports as waiting 10 minutes after its deadline.
  // Never when we confirmed a deposit on-chain ourselves: that order stays open until the provider accounts for it.
  let status: OrderStatus = mapped;
  if (status === "waiting" && now > deadline + EXPIRE_AFTER_DEADLINE_MS && !hasProvenFunds(previous)) status = "expired";
  // A reply that would move the order backwards changes nothing at all.
  if (!allowedTransition(previous.status, status)) return { kind: "state", state: previous, changed: false };

  const details = parseDetails(response.swapDetails, record) ?? previous.details;
  const iso = new Date(now).toISOString();
  const statusChanged = status !== previous.status;
  const detailsChanged = JSON.stringify(details) !== JSON.stringify(previous.details);
  const finished = isEndState(status);

  const state: OrderState = {
    ...previous,
    status,
    upstreamStatus: response.status,
    statusSince: statusChanged ? iso : previous.statusSince,
    updatedAt: statusChanged || detailsChanged ? iso : previous.updatedAt,
    anchor: statusChanged && !finished ? now : previous.anchor,
    details,
    // An order we stopped polling keeps the time it was set aside, so it is still cleaned up on schedule.
    finishedAt: finished ? (previous.finishedAt ?? iso) : previous.stopped ? previous.finishedAt : null,
    stopped: finished ? false : previous.stopped,
  };
  const changed = statusChanged || detailsChanged || state.stopped !== previous.stopped || state.finishedAt !== previous.finishedAt || state.upstreamStatus !== previous.upstreamStatus;
  return { kind: "state", state, changed };
}

/**
 * Regular polling of an order that never reached an end state stops a week
 * after its deadline, whatever the provider has or has not answered. The
 * record is kept (see the store's retention rules) and is still re-checked
 * when someone opens its page.
 */
export function giveUp(record: OrderRecord, now: number): OrderState | null {
  const { state } = record;
  if (isEndState(state.status) || state.stopped) return null;
  if (now <= Date.parse(record.deadline) + GIVE_UP_AFTER_DEADLINE_MS) return null;
  const iso = new Date(now).toISOString();
  return { ...state, stopped: true, finishedAt: state.finishedAt ?? iso, updatedAt: iso };
}

/**
 * Funds are in motion: the provider is working on the order, or we confirmed the paying
 * transaction ourselves. "Deposit seen" alone is not enough, because the provider reports
 * it for a hash it was merely told about.
 */
export function isFunded(state: OrderState): boolean {
  return hasProvenFunds(state);
}

/**
 * How often an unpaid order nobody is looking at is checked. The usual schedule applies
 * until there are more of them than the budget for unpaid orders can cover; then each
 * waits its turn, so the total never exceeds that budget.
 */
export function unpaidIntervalMs(scheduleMs: number, unpaidOrders: number, unpaidCallsPerMin: number): number {
  const turn = Math.ceil((unpaidOrders / Math.max(1, unpaidCallsPerMin)) * 60_000);
  return Math.max(scheduleMs, turn);
}

/** An order counts as watched for this long after its page last asked about it. */
export const WATCHED_MS = 60_000;
const MAX_FORWARD_ATTEMPTS = 5;

export type FinalVerdict = "gone" | "changed" | "unclear" | "outage";

export interface Poller {
  /** Starts tracking a new order. */
  track(record: OrderRecord): void;
  /** Notes that someone is looking at this order's page, which keeps its checks prompt. */
  watch(id: string): void;
  /** Runs one polling pass. Exposed for tests. */
  tick(): Promise<void>;
  /** Checks one order now, used when a page asks about an order we no longer poll. */
  recheck(id: string, priority?: Priority): Promise<void>;
  /** Makes an order due immediately, after a deposit hash arrives. */
  nudge(id: string): void;
  /**
   * Asks the provider one last time about an order that is about to be deleted.
   * "gone": nothing new, it may be deleted. "changed": something happened, the order was
   * updated and is tracked again. "unclear": the provider answered, but not in a way that
   * settles it. "outage": no answer at all (the provider is down, or our call budget is spent).
   */
  finalCheck(id: string): Promise<FinalVerdict>;
  start(): void;
  stop(): void;
}

interface Schedule {
  nextAt: number;
  errors: number;
}

export function createPoller(options: {
  store: OrderStore;
  oneclick: OneClick;
  alerts: Alerts;
  log: Logger;
  now?: () => number;
  /** Provider calls a minute that checking unpaid orders may use. */
  unpaidCallsPerMin?: number;
}): Poller {
  const { store, oneclick, alerts, log } = options;
  const now = options.now ?? Date.now;
  const unpaidCallsPerMin = options.unpaidCallsPerMin ?? 75;
  const schedule = new Map<string, Schedule>();
  const lastLazy = new Map<string, number>();
  const lastViewed = new Map<string, number>();
  const forwardAttempts = new Map<string, { hash: string; attempts: number }>();

  const watched = (id: string): boolean => now() - (lastViewed.get(id) ?? -Infinity) < WATCHED_MS;
  const unpaidCount = (): number => store.open().reduce((n, record) => n + (isFunded(record.state) || record.state.stopped ? 0 : 1), 0);
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;

  function plan(record: OrderRecord, errors: number): void {
    const t = now();
    let base = pollIntervalMs(t - record.state.anchor);
    // An under-paid order only waits for its refund at the deadline: there is nothing to hurry for.
    if (record.state.status === "deposit_too_small") base = Math.max(base, 60_000);
    // An unpaid order nobody is watching waits its turn when there are many of them.
    if (!isFunded(record.state) && !watched(record.id)) base = unpaidIntervalMs(base, unpaidCount(), unpaidCallsPerMin);
    schedule.set(record.id, { nextAt: t + (errors > 0 ? backoffMs(base, errors) : base), errors });
  }

  /** A deposit hash we hold but could not pass on is offered to the provider again, a few times. */
  async function forwardIfNeeded(record: OrderRecord): Promise<void> {
    const { state } = record;
    if (state.depositTxHash === null || state.depositForwarded || state.status !== "waiting") {
      forwardAttempts.delete(record.id);
      return;
    }
    // On a chain we can read, a hash is passed on only once we confirmed it: until then it is a claim.
    if (isWalletChain(record.from.chain) && state.depositVerified !== true) return;
    // The count belongs to one hash: a replaced hash starts again.
    const earlier = forwardAttempts.get(record.id);
    const attempts = earlier !== undefined && earlier.hash === state.depositTxHash ? earlier.attempts : 0;
    if (attempts >= MAX_FORWARD_ATTEMPTS) return;
    forwardAttempts.set(record.id, { hash: state.depositTxHash, attempts: attempts + 1 });
    const result = await oneclick.submitDeposit(
      { depositAddress: record.depositAddress, txHash: state.depositTxHash, ...(record.depositMemo === null ? {} : { memo: record.depositMemo }) },
      // A hash nobody could confirm travels with the unpaid orders, so a pile of them cannot crowd out anything else.
      isFunded(state) ? "tracking" : "idle",
    );
    const fresh = store.get(record.id);
    if (result.ok && fresh !== null && fresh.state.depositTxHash === state.depositTxHash && !fresh.state.depositForwarded) {
      store.saveState(record.id, { ...fresh.state, depositForwarded: true });
      forwardAttempts.delete(record.id);
    }
  }

  /** Tells the operator, once, about a deposit we confirmed on-chain that the provider has not picked up well after the deadline. */
  function alertIfUnseen(record: OrderRecord): OrderRecord {
    const { state } = record;
    if (state.status !== "waiting" || !isFunded(state) || state.unseenAlertSent === true) return record;
    if (now() <= Date.parse(record.deadline) + EXPIRE_AFTER_DEADLINE_MS) return record;
    alerts.send("deposit_unseen", `Order ${hashId(record.id)} has a deposit confirmed on-chain, but the provider still reports nothing ${Math.round(EXPIRE_AFTER_DEADLINE_MS / 60_000)} minutes after its deadline. It stays open and is still tracked.`, record.id);
    const next = { ...state, unseenAlertSent: true };
    store.saveState(record.id, next);
    return { ...record, state: next };
  }

  async function check(id: string, priority: Priority): Promise<void> {
    const record = store.get(id);
    if (record === null) {
      schedule.delete(id);
      return;
    }
    const errors = schedule.get(id)?.errors ?? 0;
    await forwardIfNeeded(record);
    const result = await oneclick.status(record.depositAddress, record.depositMemo, priority);
    const fresh = store.get(id);
    if (fresh === null) return;
    // An order that has already ended is only ever here because someone opened its page.
    // Whatever comes back, it does not return to the schedule unless its status really changes.
    const ended = isEndState(fresh.state.status);

    // Whatever the provider answered, an order a week past its deadline leaves the regular schedule.
    // One that already left it (and is only being re-checked because someone opened its page) stays out.
    const abandon = (latest: OrderRecord): boolean => {
      if (latest.state.stopped) {
        schedule.delete(id);
        return true;
      }
      let stopped = giveUp(latest, now());
      if (stopped === null) return false;
      if (isFunded(stopped) && stopped.unfinishedAlertSent !== true) {
        // Funds went in and the provider never reported an end. The record is kept until someone has looked into it.
        alerts.send("unfinished_order", `Order ${hashId(id)} has had funds in it for a week past its deadline without finishing (last status: ${stopped.status}). Tracking has stopped; the record is kept. Check it with the provider.`, id);
        stopped = { ...stopped, unfinishedAlertSent: true };
      }
      store.saveState(id, stopped);
      schedule.delete(id);
      log.warn("order_gave_up", { order: hashId(id), status: stopped.status });
      return true;
    };

    if (!result.ok) {
      if (result.cid !== undefined) log.warn("status_failed", { order: hashId(id), cid: result.cid });
      const t = now();
      // The provider says it does not know this address, and the deadline is well past: nobody paid.
      const notFound = result.kind === "rejected" && result.status === 404;
      if (notFound && fresh.state.status === "waiting" && !isFunded(fresh.state) && t > Date.parse(fresh.deadline) + EXPIRE_AFTER_DEADLINE_MS) {
        const iso = new Date(t).toISOString();
        store.saveState(id, { ...fresh.state, status: "expired", statusSince: iso, updatedAt: iso, finishedAt: iso });
        schedule.delete(id);
        return;
      }
      if (ended) {
        schedule.delete(id);
        return;
      }
      if (abandon(fresh)) return;
      alertIfUnseen(fresh);
      // Our own call budget being spent is not an error: try again soon, without backing off.
      if (result.kind === "unavailable" && result.budget) {
        schedule.set(id, { nextAt: t + 5000, errors });
        return;
      }
      plan(fresh, errors + 1);
      return;
    }
    const update = applyStatus(fresh, result.data, now());
    if (update.kind === "mismatch") {
      alerts.send("status_mismatch", `A status reply did not match the stored deposit address for order ${hashId(id)}.`, id);
      if (ended) schedule.delete(id);
      else if (!abandon(fresh)) plan(fresh, errors + 1);
      return;
    }
    if (update.kind === "invalid") {
      log.warn("status_invalid", { order: hashId(id) });
      if (ended) schedule.delete(id);
      else if (!abandon(fresh)) plan(fresh, errors + 1);
      return;
    }
    let state = update.state;
    if (
      state.status === "swapping" &&
      !state.slowAlertSent &&
      now() - Date.parse(state.statusSince) > 3 * Math.max(fresh.timeEstimate, 60) * 1000
    ) {
      alerts.send("slow_swap", `Order ${hashId(id)} has been swapping for more than three times its estimate.`, id);
      state = { ...state, slowAlertSent: true };
      store.saveState(id, state);
    } else if (update.changed) {
      store.saveState(id, state);
    }
    if (update.changed) log.info("order_status", { order: hashId(id), status: state.status });
    if (isEndState(state.status)) {
      schedule.delete(id);
      return;
    }
    const latest = alertIfUnseen({ ...fresh, state });
    if (!abandon(latest)) plan(latest, 0);
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const t = now();
      // Pick up anything that is open but not yet scheduled (for example after a restart).
      for (const record of store.open()) {
        if (!schedule.has(record.id) && !record.state.stopped) schedule.set(record.id, { nextAt: t, errors: 0 });
      }
      // Orders with funds in motion are checked first, then unpaid orders someone is watching,
      // then the rest; among equals, the longest overdue first.
      const urgency = (id: string): number => {
        const state = store.get(id)?.state;
        if (state === undefined) return 3;
        if (isFunded(state)) return 0;
        return watched(id) ? 1 : 2;
      };
      const due = [...schedule.entries()]
        .filter(([, s]) => s.nextAt <= t)
        .map(([id, s]) => ({ id, nextAt: s.nextAt, urgency: urgency(id) }))
        .sort((a, b) => a.urgency - b.urgency || a.nextAt - b.nextAt)
        .slice(0, MAX_IN_FLIGHT * 4)
        .map((entry) => [entry.id] as const);
      const queue = due.map(([id]) => id);
      const workers: Promise<void>[] = [];
      const run = async (): Promise<void> => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          // Push the next attempt out now so a slow call is not started twice.
          const entry = schedule.get(id);
          if (entry) entry.nextAt = now() + 30_000;
          try {
            const state = store.get(id)?.state;
            await check(id, state !== undefined && isFunded(state) ? "tracking" : "idle");
          } catch {
            log.error("poll_failed", { order: hashId(id) });
          }
        }
      };
      for (let i = 0; i < Math.min(MAX_IN_FLIGHT, queue.length); i++) workers.push(run());
      await Promise.all(workers);
    } finally {
      ticking = false;
    }
  }

  return {
    track(record) {
      schedule.set(record.id, { nextAt: now() + 5000, errors: 0 });
    },
    tick,
    watch(id) {
      const t = now();
      const first = !watched(id);
      lastViewed.set(id, t);
      if (lastViewed.size > 20_000) {
        for (const [key, at] of lastViewed) if (t - at > WATCHED_MS) lastViewed.delete(key);
      }
      // An unpaid order that was waiting its turn is brought forward to the usual schedule.
      const entry = schedule.get(id);
      const record = first && entry !== undefined ? store.get(id) : null;
      if (record && entry && !isFunded(record.state)) entry.nextAt = Math.min(entry.nextAt, t + pollIntervalMs(t - record.state.anchor));
    },
    async recheck(id, priority = "idle") {
      const t = now();
      const last = lastLazy.get(id) ?? 0;
      if (t - last < LAZY_RECHECK_MS) return;
      lastLazy.set(id, t);
      if (lastLazy.size > 10_000) {
        for (const [key, at] of lastLazy) if (t - at > LAZY_RECHECK_MS) lastLazy.delete(key);
      }
      try {
        await check(id, priority);
      } catch {
        log.error("poll_failed", { order: hashId(id) });
      }
    },
    nudge(id) {
      const entry = schedule.get(id);
      if (entry) entry.nextAt = now();
      else if (store.get(id) !== null) schedule.set(id, { nextAt: now(), errors: 0 });
    },
    async finalCheck(id) {
      const record = store.get(id);
      if (record === null) return "gone";
      let result;
      try {
        // In the class kept for orders with funds in motion: there are few of these calls, and the
        // class for unpaid orders can be kept busy by anyone with unpaid orders of their own.
        result = await oneclick.status(record.depositAddress, record.depositMemo, "tracking");
      } catch {
        return "outage";
      }
      if (!result.ok) {
        // The provider no longer knows the address: there is nothing left to learn.
        if (result.kind === "rejected") return result.status === 404 ? "gone" : "unclear";
        return "outage";
      }
      const fresh = store.get(id);
      if (fresh === null) return "gone";
      const update = applyStatus(fresh, result.data, now());
      if (update.kind !== "state") return "unclear";
      if (update.state.status === fresh.state.status) return "gone";
      // Something happened after all: keep the order and follow it again.
      store.saveState(id, update.state);
      log.info("order_status", { order: hashId(id), status: update.state.status, late: true });
      if (!isEndState(update.state.status) && !update.state.stopped) schedule.set(id, { nextAt: now(), errors: 0 });
      return "changed";
    },
    start() {
      timer = setInterval(() => void tick(), 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
