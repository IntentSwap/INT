// Regular upkeep and the alert thresholds that go with it.

import fs from "node:fs";
import type { Alerts } from "./alerts.ts";
import { errorKind, type AccessLog, type Logger } from "./log.ts";
import type { OrderStatus } from "../shared/api.ts";
import type { Poller } from "./poller.ts";
import type { Limiters } from "./ratelimit.ts";
import type { Settler } from "./settle.ts";
import { deleteAfter, type OrderRecord, type OrderStore } from "./store.ts";

/** Alert when more than this share of provider calls failed over 5 minutes. */
export const PROVIDER_ERROR_THRESHOLD = 0.2;
/** Alert when the data volume is fuller than this. */
export const DISK_THRESHOLD = 0.7;
/** Refuse new orders when the data volume is fuller than this: an order that cannot be saved must not be created. */
export const DISK_FULL = 0.95;

/** Sends the provider-errors alert when the failure rate is over the threshold. Returns whether it did. */
export function providerErrorAlert(alerts: Alerts, rate: number, calls: number): boolean {
  if (!(rate > PROVIDER_ERROR_THRESHOLD)) return false;
  alerts.send("oneclick_errors", `${Math.round(rate * 100)}% of ${calls} calls to the swap provider failed in the last 5 minutes.`);
  return true;
}

/** Share of the volume in use, from file-system statistics. Null when it cannot be worked out. */
export function diskUsage(stats: { blocks: number | bigint; bavail: number | bigint }): number | null {
  const blocks = Number(stats.blocks);
  const available = Number(stats.bavail);
  if (!Number.isFinite(blocks) || !Number.isFinite(available) || blocks <= 0) return null;
  return Math.min(1, Math.max(0, 1 - available / blocks));
}

/** Sends the disk alert when usage is over the threshold. Returns whether it did. */
export function diskAlert(alerts: Alerts, used: number | null): boolean {
  if (used === null || !(used > DISK_THRESHOLD)) return false;
  alerts.send("disk", `The data volume is ${Math.round(used * 100)}% full.`);
  return true;
}

export function runMaintenance(options: {
  accessLog: AccessLog;
  limiters: Limiters;
  dataDir: string;
  alerts: Alerts;
  log: Logger;
  statfs?: (dir: string) => { blocks: number | bigint; bavail: number | bigint };
}): number | null {
  const { accessLog, limiters, dataDir, alerts, log } = options;
  const statfs = options.statfs ?? ((dir: string) => fs.statfsSync(dir));
  try {
    accessLog.prune();
    for (const limiter of Object.values(limiters)) limiter.sweep();
  } catch (err) {
    log.error("maintenance_failed", { kind: errorKind(err) });
  }
  // The disk is measured on its own: a failure above must not hide a full disk.
  return measureDisk({ dataDir, alerts, log, statfs });
}

/** Statuses the provider itself declared final. Nothing more can happen to these orders. */
const SETTLED: readonly OrderStatus[] = ["delivered", "refunded", "failed"];
/** Most last checks with the provider in one round, so a backlog cannot use up the call budget. */
export const MAX_FINAL_CHECKS_PER_SWEEP = 30;
/** A record the provider gives no clear answer about is deleted this long after its date regardless. */
export const UNCLEAR_GRACE_MS = 7 * 86_400_000;

/**
 * Deletes order records that are past their retention time. An order the provider has not
 * itself declared finished is asked about one last time first: if anything happened to it
 * after we stopped looking (a late deposit, a refund), it is updated and kept instead.
 *
 * One awkward record never holds up the rest. An unclear answer skips that record until the
 * next round (and a week past its date it is deleted anyway, and logged). Only an outage ends
 * the round. Records are asked about in turn, least recently asked first.
 *
 * Each round begins with what Ghost mode leaves to it (`settler.tidy`): an order made in that mode
 * whose record should have gone as it was delivered or refunded, and did not, is put to its ending
 * again, and the fingerprints of deleted orders that are 30 days old are removed. A failure there
 * is logged, and the round goes on.
 *
 * A Ghost order that ran out unpaid is deleted here and nowhere else, by the rules above: a day
 * after its deadline, once the provider has been asked one last time and has nothing new. Its
 * record is kept not a moment longer than any such order's, and not a moment less. (The store
 * leaves the fingerprint of a Ghost order that had ended, whoever removes its record.)
 */
export function createSweeper(options: { store: OrderStore; poller: Pick<Poller, "finalCheck">; log: Logger; now: () => number; settler?: Pick<Settler, "tidy"> }): () => Promise<number> {
  const { store, poller, log, now, settler } = options;
  const lastAsked = new Map<string, number>();
  let running = false;
  // When a record goes, whoever removes it, so does the note of when it was last asked about.
  store.onRemoved((id) => void lastAsked.delete(id));

  return async function sweep(): Promise<number> {
    if (running) return 0;
    running = true;
    let removed = 0;
    let kept = 0;
    let unclear = 0;
    let forced = 0;
    try {
      settler?.tidy();
    } catch (err) {
      log.error("ghost_tidy_failed", { kind: errorKind(err) });
    }
    try {
      const due = store.deletable(now());
      const dueIds = new Set(due.map((record) => record.id));
      for (const id of lastAsked.keys()) if (!dueIds.has(id)) lastAsked.delete(id);
      const toAsk: OrderRecord[] = [];
      for (const record of due) {
        if (SETTLED.includes(record.state.status)) {
          store.remove(record.id);
          removed += 1;
        } else {
          toAsk.push(record);
        }
      }
      toAsk.sort((a, b) => (lastAsked.get(a.id) ?? 0) - (lastAsked.get(b.id) ?? 0));
      for (const record of toAsk.slice(0, MAX_FINAL_CHECKS_PER_SWEEP)) {
        const verdict = await poller.finalCheck(record.id);
        // No answer at all: nothing more can be learned this round.
        if (verdict === "outage") break;
        lastAsked.set(record.id, now());
        if (verdict === "gone") {
          store.remove(record.id);
          lastAsked.delete(record.id);
          removed += 1;
        } else if (verdict === "changed") {
          kept += 1;
        } else {
          unclear += 1;
          const from = deleteAfter(record);
          if (from !== null && now() > from + UNCLEAR_GRACE_MS) {
            store.remove(record.id);
            lastAsked.delete(record.id);
            removed += 1;
            forced += 1;
          }
        }
      }
    } catch (err) {
      log.error("sweep_failed", { kind: errorKind(err) });
    } finally {
      running = false;
    }
    if (removed > 0 || kept > 0 || unclear > 0) log.info("orders_swept", { removed, kept, unclear, forced });
    return removed;
  };
}

/** Measures the data volume and alerts when it is filling up. Null when it cannot be measured. */
export function measureDisk(options: {
  dataDir: string;
  alerts: Alerts;
  log: Logger;
  statfs?: (dir: string) => { blocks: number | bigint; bavail: number | bigint };
}): number | null {
  const statfs = options.statfs ?? ((dir: string) => fs.statfsSync(dir));
  try {
    const used = diskUsage(statfs(options.dataDir));
    diskAlert(options.alerts, used);
    return used;
  } catch (err) {
    options.log.error("disk_check_failed", { kind: errorKind(err) });
    return null;
  }
}

/** How often the disk is measured. Far more often than the hourly upkeep, because it guards new orders. */
export const DISK_CHECK_MS = 60_000;

/** The disk guard: remembers the last good measurement, so one failed reading never switches it off. */
export function createDiskGuard(): { record(used: number | null): void; full(): boolean; used(): number | null } {
  let last: number | null = null;
  return {
    record(used) {
      if (used !== null) last = used;
    },
    full: () => last !== null && last > DISK_FULL,
    used: () => last,
  };
}
