// Order store: one JSON file per order under DATA_DIR/orders.
// Writes are durable (temp file, fsync, rename). The terms of an order never
// change after creation; only its tracking state does.

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
  remove(id: string): void;
  /**
   * The order whose deposit address this is. Null when there is none, and also when more than
   * one order shares the address (chains that tell deposits apart by a memo): an address that
   * could mean several orders opens none of them.
   */
  findByDeposit(address: string): OrderRecord | null;
  /** The ID of every order on disk. For work that must look at each of them once (the points record, at start). */
  ids(): string[];
}

/** How a deposit address is compared: a hex address in any mix of capitals is the same address; every other kind is taken letter for letter. */
export function depositKey(address: string): string {
  return /^0x[0-9a-fA-F]+$/.test(address) ? address.toLowerCase() : address;
}

/** Stands in the index for an address that more than one order uses. */
const SHARED = "*";

export function writeDurable(file: string, data: string): void {
  // Write the whole record to a temporary file, force it to disk, then swap it
  // into place in one step. A crash at any point leaves either the old record
  // or the new one, never a partial file.
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, data);
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
 * The moment from which a record may be deleted, or null when it must be kept. The caller still
 * asks the provider one last time before deleting anything the provider has not itself declared finished.
 */
export function deleteAfter(record: OrderRecord): number | null {
  const { state } = record;
  // "Never funded" means the provider confirmed, after the deadline, that nothing arrived
  // (the order expired) and no deposit was ever reported for it. An order still marked
  // waiting has not had that confirmation, so it is never deleted on local state alone.
  // An expired order with a deposit hash may be a late or lost deposit: kept like a finished one.
  const neverFunded = state.status === "expired" && state.depositTxHash === null;
  if (neverFunded) return Date.parse(record.deadline) + UNFUNDED_RETENTION_MS;
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

export function createOrderStore(dataDir: string, options: { onState?(record: OrderRecord): void } = {}): OrderStore {
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

  // Load everything once at start so tracking resumes after a restart.
  for (const name of fs.readdirSync(indexDir)) if (name.includes(".tmp-")) fs.rmSync(path.join(indexDir, name), { force: true });
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
      // The index entry goes with the record, when it names this record alone.
      const record = this.get(id);
      if (record !== null && readIndex(record.depositAddress) === id) fs.rmSync(indexFor(record.depositAddress), { force: true });
      fs.rmSync(fileFor(id), { force: true });
      live.delete(id);
      recent.delete(id);
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
  };
}
