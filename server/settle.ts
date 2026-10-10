// What is done with an order each time its state is saved, and once more for every stored order
// as the server starts: it is put to the site's totals, then to the record of points, and then, if
// it was made in Ghost mode and is delivered or refunded, its record is deleted.
//
// A Ghost order's record goes at the first moment the server knows that nothing more can happen to
// the order and that no funds are in it. Delivered or refunded, that is at once, and it is done
// here. Run out unpaid, it is when the watch for a late deposit ends: such an order's record is
// kept, re-checked and at last deleted by the clean-up pass exactly as any order's is (see
// server/maintenance.ts), and if a deposit is found after all it is an order with funds in it, and
// comes back here when it is delivered or refunded. Failed, or with too small a deposit in it, it
// is kept as any such order is. Whichever way a Ghost order's record goes once the order has
// ended, the store leaves the same one thing behind (server/store.ts, `remove`).
//
// The order of the three is the rule. An order is counted (server/stats.ts), then its points are
// written (server/rewards.ts), and only then does its record go (server/store.ts, `wipe`). Each
// step is safe to do again, so a stop between any two of them loses nothing and doubles nothing:
//
//   - stopped before the count: the order is on disk, not marked as counted. The next start counts it.
//   - stopped between the count and the points: the mark is on the order's own record, so it is not
//     counted again; its points are written at the next start.
//   - stopped between the points and the deletion: the entry is a file named by the order's
//     fingerprint, and is not written twice; the record is deleted at the next start.
//
// A step that fails while the server keeps running (a disk that will not take a write) leaves the
// record where it is, and the order is put to all three again at every clean-up pass until they
// have all been done. A record is never deleted ahead of a step that failed: before it goes, the
// totals it was added to are on disk, though the write had to be made a second time. Should a step
// never be done, the record goes when any finished order's does, 30 days on.
//
// One thing a stop can still cost, as it can for any order: the mark on the order's record is
// written before the totals are, so a stop between those two leaves the swap out of the totals.
// It is never in them twice.
//
// For an order that was not made in Ghost mode the first two steps are everything: nothing here
// deletes its record.

import { errorKind, hashId, type Logger } from "./log.ts";
import type { Rewards } from "./rewards.ts";
import type { Stats } from "./stats.ts";
import { wipeDue, type OrderRecord, type OrderStore } from "./store.ts";

export interface Settler {
  /**
   * Counts the order, writes its points, and deletes its record if it is a Ghost order that is
   * delivered or refunded. True when the record was deleted. With `write` false the totals
   * are added up in memory and left for one `save` after many orders (as at a start), except for an
   * order whose record is about to go: the totals are on disk first.
   */
  settle(record: OrderRecord, write?: boolean): boolean;
  /**
   * What the clean-up pass does for Ghost mode: puts to the three steps again every order one of
   * them failed for, and removes the fingerprints of deleted orders that are 30 days old.
   */
  tidy(): void;
}

export function createSettler(parts: { store: OrderStore; stats: Pick<Stats, "recordDelivered" | "flush">; rewards: Pick<Rewards, "recordDelivered">; log: Logger }): Settler {
  const { store, stats, rewards, log } = parts;
  // Ghost orders that are delivered or refunded and whose record is still there, because a step
  // failed. Their records are on disk, so nothing is held here that is not held there.
  const left = new Set<string>();

  function settle(record: OrderRecord, write = true): boolean {
    const due = wipeDue(record);
    let kept = true;
    try {
      stats.recordDelivered(record, () => store.markCounted(record.id), write);
      if (due) stats.flush();
    } catch (err) {
      kept = false;
      log.error("stats_not_counted", { order: hashId(record.id), error: errorKind(err) });
    }
    try {
      rewards.recordDelivered(record);
    } catch (err) {
      kept = false;
      log.error("points_not_recorded", { order: hashId(record.id), error: errorKind(err) });
    }
    if (!due) return false;
    try {
      if (kept && store.wipe(record.id)) {
        left.delete(record.id);
        return true;
      }
    } catch (err) {
      log.error("record_not_deleted", { order: hashId(record.id), error: errorKind(err) });
    }
    left.add(record.id);
    return false;
  }

  return {
    settle,
    tidy() {
      for (const id of [...left]) {
        const record = store.get(id);
        if (record === null || !wipeDue(record)) left.delete(id);
        else settle(record);
      }
      store.forgetWiped();
    },
  };
}
