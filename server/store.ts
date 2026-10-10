// Order store: one JSON file per order under DATA_DIR/orders.
// Writes are durable (temp file, fsync, rename). The terms of an order never
// change after creation; only its tracking state does.
//
// What the data folder holds of an order, all of it written here:
//
//   - orders/<ID>.json: the record;
//   - by-deposit/<SHA-256 of the deposit address>: the order's ID, so that the record can be found
//     from the address without reading every one;
//   - ghost/gone/<SHA-256 of the ID>: a file of one word, left when the record of an order made in
//     Ghost mode is deleted once the order has ended, and kept 30 days. The word is how the order
//     ended: "delivered", "refunded" or "expired". It is all that is known of that order
//     afterwards: that there was one, that it finished, and how.
//
// The first two go when the record is removed, whoever removes it.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CoinRef, Confidentiality, FeeView, OrderDetails, OrderStatus, PayMethod } from "../shared/api.ts";
import { isEndState } from "../shared/api.ts";
import { DEPOSIT_ADDRESS_SHAPE } from "../shared/chains.ts";
import type { ScreeningRecord } from "./sanctions.ts";

export interface OrderState {
  status: OrderStatus;
  /** Last status string the provider reported. */
  upstreamStatus: string;
  /** When the status last changed. */
  statusSince: string;
  /** When anything in this state last changed. */
  updatedAt: string;
  /** Polling speeds up for a while after this moment (creation, or a new deposit hash). */
  anchor: number;
  depositTxHash: string | null;
  /**
   * True when we confirmed through our own RPC that the transaction pays this order.
   * False for a hash that was only format-checked (chains without wallet support).
   */
  depositVerified?: boolean;
  /** True once the hash has been passed to the provider. */
  depositForwarded: boolean;
  /** How many times a deposit hash has been set for this order. */
  depositSubmissions?: number;
  details: OrderDetails | null;
  finishedAt: string | null;
  /** True when regular polling has stopped for an order that never reached an end state. */
  stopped: boolean;
  slowAlertSent: boolean;
  /** Set once the operator has been told that a confirmed deposit was not picked up by the provider. */
  unseenAlertSent?: boolean;
  /** Set once the operator has been told that this order stopped being tracked with funds in it. */
  unfinishedAlertSent?: boolean;
}

export interface OrderRecord {
  v: 1;
  id: string;
  createdAt: string;
  pay: PayMethod;
  from: CoinRef;
  to: CoinRef;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  amountInUsd: string;
  amountOutUsd: string;
  slippageBps: number;
  timeEstimate: number;
  fees: FeeView;
  withdrawFee: string | null;
  refundFee: string | null;
  recipient: string;
  refundTo: string;
  sender: string | null;
  /** Where this swap's points go: an address on BNB Chain, or null when the swap adds none. Absent on records made before points existed. */
  rewardsAddress?: string | null;
  /**
   * The routing level the order was made with: "basic" for private routing, "public" for the
   * ordinary kind. Absent on records made before the level was kept: every one of those was public,
   * and is read as public.
   */
  confidentiality?: Confidentiality;
  depositAddress: string;
  depositMemo: string | null;
  deadline: string;
  termsVersion: string;
  screening: ScreeningRecord;
  /** The provider's signed quote, kept as the record of this transaction. */
  quoteResponse: unknown;
  /**
   * True once this order has been added to the site's totals (server/stats.ts). It is kept here, with
   * the order, so that the totals themselves hold nothing about any one order; it goes when the order goes.
   */
  statsCounted?: boolean;
  /**
   * True for an order made in Ghost mode, and absent on every other. Such an order is given no row
   * among the recent swaps, and its record is deleted at the first moment nothing more can happen to
   * the order and no funds are in it (see `wipeDue`). Nothing else about the order differs.
   */
  ghost?: true;
  state: OrderState;
}

const ID_SHAPE = /^[A-Za-z0-9_-]{27}$/;

/** 160 random bits, URL-safe. */
export function newOrderId(): string {
  return randomBytes(20).toString("base64url");
}

export function isOrderId(value: unknown): value is string {
  return typeof value === "string" && ID_SHAPE.test(value);
}

/** Never-funded orders are deleted this long after their deadline. */
export const UNFUNDED_RETENTION_MS = 24 * 3_600_000;
/** Finished orders are deleted this long after they finish. */
export const FINISHED_RETENTION_MS = 30 * 86_400_000;
/** How long it can still be said of a Ghost order that it finished and that its record was deleted: as long as a finished order's record would have been kept. */
export const WIPED_KEPT_MS = FINISHED_RETENTION_MS;
const DAY_MS = 86_400_000;

/** How an order made in Ghost mode ended, in the one word that is kept of it once its record is deleted. */
export const ENDINGS = ["delivered", "refunded", "expired"] as const;
export type Ending = (typeof ENDINGS)[number];
const isEnding = (value: string): value is Ending => (ENDINGS as readonly string[]).includes(value);

export interface OrderStore {
  create(record: OrderRecord): void;
  get(id: string): OrderRecord | null;
  /** Saves a new tracking state. The rest of the record is never rewritten with different values. */
  saveState(id: string, state: OrderState): void;
  /** Every order that has not reached an end state, including those no longer tracked. */
  open(): OrderRecord[];
  /** Orders still being tracked. */
  openCount(): number;
  /**
   * Records old enough to delete (see `isExpiredRecord`). Nothing is deleted here. Each call reads
   * at most `maxRead` files and carries on, next time, from where it stopped, so a large
   * folder is gone through a part at a time.
   */
  deletable(now: number, maxRead?: number): OrderRecord[];
  /**
   * Deletes a record, with its entry in the index of deposit addresses. Whether it may go is the
   * caller's to decide (see `deleteAfter`, and `wipe`). Where the record is that of an order made
   * in Ghost mode that had ended (delivered, refunded or run out), the one thing kept of it is left
   * in its place for 30 days: a one-way fingerprint of its ID, with the word for how it ended. Any
   * other record leaves nothing.
   */
  remove(id: string): void;
  /**
   * Deletes, now, the record of a Ghost order that the provider has declared finished with nothing
   * left in it (see `wipeDue`), as `remove` does. True when the record was deleted. False, and
   * nothing is touched, for any other order: one that is not a Ghost order, has not finished, may
   * still have funds in it, or may yet be paid late.
   */
  wipe(id: string): boolean;
  /**
   * What is known of a Ghost order whose record was deleted within the last 30 days: that it
   * finished, and how (null where the fingerprint does not say so in one of the three words). Null
   * for every other ID.
   */
  wiped(id: string): { ended: Ending | null } | null;
  /** Removes the fingerprints that are 30 days old. Returns how many went. */
  forgetWiped(): number;
  /**
   * Has `listener` told of every record that is removed, by its ID, once the record is gone, so that
   * whatever else holds something of the order in memory can let go of it.
   */
  onRemoved(listener: (id: string) => void): void;
  /**
   * The order whose deposit address this is. Null when there is none, and also when more than
   * one order shares the address (chains that tell deposits apart by a memo): an address that
   * could mean several orders opens none of them.
   */
  findByDeposit(address: string): OrderRecord | null;
  /** The ID of every order on disk. For work that must look at each of them once (the points record, at start). */
  ids(): string[];
  /**
   * Marks an order as added to the site's totals. True only the first time, and by then the mark is
   * on disk; false for an order already marked, or not there. So an order is counted at most once,
   * across restarts too.
   */
  markCounted(id: string): boolean;
}

/** How a deposit address is compared: a hex address in any mix of capitals is the same address; every other kind is taken letter for letter. */
export function depositKey(address: string): string {
  return /^0x[0-9a-fA-F]+$/.test(address) ? address.toLowerCase() : address;
}

/** Stands in the index for an address that more than one order uses. */
const SHARED = "*";

export function writeDurable(file: string, data: string, dated?: number): void {
  // Write the whole record to a temporary file, force it to disk, then swap it
  // into place in one step. A crash at any point leaves either the old record
  // or the new one, never a partial file.
  // With `dated`, the file says it was last written at that moment, and not at the one it really was.
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, data);
      if (dated !== undefined) fs.futimesSync(fd, dated / 1000, dated / 1000);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  // Make the rename itself durable.
  const dirFd = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(dirFd);
  } catch {
    // Some file systems do not support fsync on a directory.
  } finally {
    fs.closeSync(dirFd);
  }
}

function isRecordShape(value: unknown): value is OrderRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<OrderRecord>;
  return r.v === 1 && isOrderId(r.id) && typeof r.depositAddress === "string" && typeof r.deadline === "string" && typeof r.state === "object" && r.state !== null;
}

/** Should this record be deleted now? */
/**
 * True when funds are known to be in this order: the provider has started on it, or we
 * confirmed the paying transaction on-chain ourselves. A deposit that was only announced
 * ("deposit seen"), or a hash nobody could confirm, does not count: either can be claimed
 * by anyone at no cost.
 */
export function hasProvenFunds(state: OrderState): boolean {
  if (state.status === "swapping" || state.status === "deposit_too_small") return true;
  return state.depositTxHash !== null && state.depositVerified === true;
}

/**
 * "Never funded" means the provider confirmed, after the deadline, that nothing arrived
 * (the order expired) and no deposit was ever reported for it. An order still marked
 * waiting has not had that confirmation, so it is never deleted on local state alone.
 * An expired order with a deposit hash may be a late or lost deposit: kept like a finished one.
 */
function neverFunded(state: OrderState): boolean {
  return state.status === "expired" && state.depositTxHash === null;
}

/**
 * True when the provider itself has declared an order finished and nothing is left in it: it was
 * delivered, or it was refunded. Nothing more can happen to such an order. A failed order is not
 * one of these: what was paid into it may still be with the provider. Neither is one that ran out
 * unpaid: a deposit can still arrive late, and the server goes on looking for one for as long as
 * `deleteAfter` keeps the record.
 */
export function endedEmpty(state: OrderState): boolean {
  return state.status === "delivered" || state.status === "refunded";
}

/**
 * Whether a record is to be deleted now, without waiting out the time records are kept: only that
 * of an order made in Ghost mode, and only once it is delivered or refunded. Every other record is
 * kept exactly as long as it always was, a Ghost order's among them: one with funds in it until
 * that is settled, and one that ran out unpaid until the watch for a late deposit ends (the
 * clean-up pass then deletes it, as it deletes any such record).
 */
export function wipeDue(record: OrderRecord): boolean {
  return record.ghost === true && endedEmpty(record.state);
}

/** The word for how an order ended, or null for one that has not ended in one of the three ways that have a word. */
export function endingOf(state: OrderState): Ending | null {
  return isEnding(state.status) ? state.status : null;
}

/**
 * The moment from which a record may be deleted, or null when it must be kept. The caller still
 * asks the provider one last time before deleting anything the provider has not itself declared finished.
 */
export function deleteAfter(record: OrderRecord): number | null {
  const { state } = record;
  if (neverFunded(state)) return Date.parse(record.deadline) + UNFUNDED_RETENTION_MS;
  // An order we stopped tracking while funds were in it is kept until someone has looked into it.
  if (!isEndState(state.status) && hasProvenFunds(state)) return null;
  if (state.finishedAt !== null) return Date.parse(state.finishedAt) + FINISHED_RETENTION_MS;
  return null;
}

/** Whether a record is old enough to be deleted. */
export function isExpiredRecord(record: OrderRecord, now: number): boolean {
  const from = deleteAfter(record);
  return from !== null && now > from;
}

export function createOrderStore(dataDir: string, options: { onState?(record: OrderRecord): void; now?: () => number } = {}): OrderStore {
  const now = options.now ?? Date.now;
  const dir = path.join(dataDir, "orders");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileFor = (id: string) => path.join(dir, `${id}.json`);
  // A small file per deposit address, named by a hash of the address and holding the order's ID,
  // so an order can be found by its deposit address without reading every record.
  const indexDir = path.join(dataDir, "by-deposit");
  fs.mkdirSync(indexDir, { recursive: true, mode: 0o700 });
  const indexFor = (address: string) => path.join(indexDir, createHash("sha256").update(depositKey(address)).digest("hex"));
  const readIndex = (address: string): string | null => {
    try {
      return fs.readFileSync(indexFor(address), "utf8");
    } catch {
      return null;
    }
  };
  function addToIndex(record: OrderRecord): void {
    const held = readIndex(record.depositAddress);
    if (held === record.id || held === SHARED) return;
    writeDurable(indexFor(record.depositAddress), held === null ? record.id : SHARED);
  }
  // What is left of a Ghost order whose record was deleted: a file named by a one-way hash of the
  // order's ID. It holds one word, how the order ended, and nothing else: no amount, no coin, no
  // address, no hash and no time. The date it is given is the day the record went, never the time
  // of day: that date is what its 30 days are counted from. (The file system keeps a time of its
  // own for when a file was last changed, which no program can set.) From the file, and for 30
  // days, an ID that was such an order's can be told from one that never was any order's, and its
  // page can say how it ended. Nothing else can be learned from it, and the ID cannot be had back from it.
  const goneDir = path.join(dataDir, "ghost", "gone");
  fs.mkdirSync(goneDir, { recursive: true, mode: 0o700 });
  const goneFor = (id: string) => path.join(goneDir, createHash("sha256").update(id).digest("hex"));
  /** When a fingerprint says its record went, or null where there is none. */
  const goneSince = (file: string): number | null => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  };
  /** The word a fingerprint holds, if it is one of the three and the file holds nothing else. Anything else in the file is not read as a word, and is never passed on. */
  const goneWord = (file: string): Ending | null => {
    try {
      if (fs.statSync(file).size > 16) return null;
      const word = fs.readFileSync(file, "utf8");
      return isEnding(word) ? word : null;
    } catch {
      return null;
    }
  };
  const removedListeners: Array<(id: string) => void> = [];

  /** Unfinished orders stay in memory; finished ones are read from disk when asked for. */
  const live = new Map<string, OrderRecord>();
  const recent = new Map<string, OrderRecord>();
  // Where the next look for records to delete starts.
  let sweepFrom = 0;

  function readFromDisk(id: string): OrderRecord | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(fileFor(id), "utf8"));
      return isRecordShape(parsed) && parsed.id === id ? parsed : null;
    } catch {
      return null;
    }
  }

  function remember(record: OrderRecord): void {
    if (isEndState(record.state.status)) {
      live.delete(record.id);
      recent.delete(record.id);
      recent.set(record.id, record);
      if (recent.size > 500) {
        const oldest = recent.keys().next().value;
        if (oldest !== undefined) recent.delete(oldest);
      }
    } else {
      live.set(record.id, record);
    }
  }

  /** True when another record still on disk carries this record's deposit address. */
  function addressStillUsed(record: OrderRecord): boolean {
    const key = depositKey(record.depositAddress);
    for (const name of fs.readdirSync(dir)) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!isOrderId(id) || id === record.id) continue;
      const other = live.get(id) ?? readFromDisk(id);
      if (other !== null && depositKey(other.depositAddress) === key) return true;
    }
    return false;
  }

  /**
   * Takes a record's deposit address out of the index. An entry that names this record alone goes
   * with it. One that stands for several orders stays for as long as any other of them is on
   * disk, and goes with the last: no file named after an address outlives every order that used it.
   */
  function dropFromIndex(record: OrderRecord): void {
    const held = readIndex(record.depositAddress);
    if (held === record.id || (held === SHARED && !addressStillUsed(record))) fs.rmSync(indexFor(record.depositAddress), { force: true });
  }

  // Load everything once at start so tracking resumes after a restart.
  for (const folder of [indexDir, goneDir]) for (const name of fs.readdirSync(folder)) if (name.includes(".tmp-")) fs.rmSync(path.join(folder, name), { force: true });
  for (const name of fs.readdirSync(dir)) {
    if (name.includes(".tmp-")) {
      fs.rmSync(path.join(dir, name), { force: true });
      continue;
    }
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!isOrderId(id)) continue;
    const record = readFromDisk(id);
    if (record === null) continue;
    if (!isEndState(record.state.status)) live.set(id, record);
    // Every record is in the index, including any written before the index existed.
    addToIndex(record);
  }

  return {
    create(record) {
      if (!isOrderId(record.id)) throw new Error("bad order id");
      if (fs.existsSync(fileFor(record.id))) throw new Error("order id collision");
      writeDurable(fileFor(record.id), JSON.stringify(record));
      remember(record);
      addToIndex(record);
    },
    get(id) {
      if (!isOrderId(id)) return null;
      const cached = live.get(id) ?? recent.get(id);
      if (cached !== undefined) return cached;
      const record = readFromDisk(id);
      if (record !== null) remember(record);
      return record;
    },
    saveState(id, state) {
      const existing = this.get(id);
      if (existing === null) throw new Error("unknown order");
      const next: OrderRecord = { ...existing, state };
      writeDurable(fileFor(id), JSON.stringify(next));
      remember(next);
      // Told after the record is safely on disk. What listens (the points record) must never be able to undo a saved state.
      try {
        options.onState?.(next);
      } catch {
        // The listener looks after its own failures; an order's state is saved either way.
      }
    },
    open: () => [...live.values()],
    openCount: () => {
      let count = 0;
      for (const record of live.values()) if (!record.state.stopped) count += 1;
      return count;
    },
    deletable(now, maxRead = 500) {
      const out: OrderRecord[] = [];
      const names = fs.readdirSync(dir).sort();
      let read = 0;
      let visited = 0;
      for (; visited < names.length && read < maxRead; visited++) {
        const name = names[(sweepFrom + visited) % names.length] ?? "";
        const id = name.endsWith(".json") ? name.slice(0, -5) : "";
        if (!isOrderId(id)) continue;
        let record = live.get(id) ?? null;
        if (record === null) {
          record = readFromDisk(id);
          read += 1;
        }
        if (record !== null && isExpiredRecord(record, now)) out.push(record);
      }
      sweepFrom = names.length === 0 ? 0 : (sweepFrom + visited) % names.length;
      return out;
    },
    remove(id) {
      if (!isOrderId(id)) return;
      const record = this.get(id);
      if (record !== null) {
        // Of a Ghost order that had ended, the fingerprint is left, and it is written first: a stop
        // after it leaves both it and the record, and the record goes at the next start or the next
        // pass. The other way round, the order would be answered as one that never was.
        const ended = record.ghost === true ? endingOf(record.state) : null;
        if (ended !== null) writeDurable(goneFor(id), ended, Math.floor(now() / DAY_MS) * DAY_MS);
        // Then the index entry, before the record: a stop between those two leaves a record with no
        // entry, which the next start puts back, and never an entry that names a record no longer there.
        dropFromIndex(record);
      }
      fs.rmSync(fileFor(id), { force: true });
      live.delete(id);
      recent.delete(id);
      for (const listener of removedListeners) {
        try {
          listener(id);
        } catch {
          // A listener looks after its own failures; the record is gone either way.
        }
      }
    },
    wipe(id) {
      const record = this.get(id);
      if (record === null || !wipeDue(record)) return false;
      this.remove(id);
      return true;
    },
    wiped(id) {
      if (!isOrderId(id)) return null;
      const since = goneSince(goneFor(id));
      if (since === null || now() - since >= WIPED_KEPT_MS) return null;
      return { ended: goneWord(goneFor(id)) };
    },
    forgetWiped() {
      let gone = 0;
      for (const name of fs.readdirSync(goneDir)) {
        const file = path.join(goneDir, name);
        const since = goneSince(file);
        if (since === null || now() - since < WIPED_KEPT_MS) continue;
        fs.rmSync(file, { force: true });
        gone += 1;
      }
      return gone;
    },
    onRemoved(listener) {
      removedListeners.push(listener);
    },
    findByDeposit(address) {
      if (typeof address !== "string" || !DEPOSIT_ADDRESS_SHAPE.test(address)) return null;
      const id = readIndex(address);
      if (id === null || !isOrderId(id)) return null;
      const record = this.get(id);
      // The index is a pointer, never the answer: the record itself must carry this address.
      return record !== null && depositKey(record.depositAddress) === depositKey(address) ? record : null;
    },
    ids: () =>
      fs
        .readdirSync(dir)
        .map((name) => (name.endsWith(".json") ? name.slice(0, -5) : ""))
        .filter(isOrderId),
    markCounted(id) {
      const existing = this.get(id);
      if (existing === null || existing.statsCounted === true) return false;
      const next: OrderRecord = { ...existing, statsCounted: true };
      writeDurable(fileFor(id), JSON.stringify(next));
      remember(next);
      return true;
    },
  };
}
