import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderStore, FINISHED_RETENTION_MS, hasProvenFunds, isExpiredRecord, isOrderId, newOrderId, UNFUNDED_RETENTION_MS, type OrderRecord } from "../server/store.ts";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-store-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-08T12:00:00.000Z");

function record(overrides: Partial<OrderRecord> = {}, state: Partial<OrderRecord["state"]> = {}): OrderRecord {
  const coin = { id: "a", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null };
  return {
    v: 1,
    id: newOrderId(),
    createdAt: new Date(T0).toISOString(),
    pay: "wallet",
    from: coin,
    to: { ...coin, id: "b", symbol: "USDC", chain: "arb", decimals: 6 },
    amountIn: "5000000000000000",
    amountOut: "12000000",
    minAmountOut: "11880000",
    amountInUsd: "12.5",
    amountOutUsd: "12",
    slippageBps: 100,
    timeEstimate: 30,
    fees: { appBps: 20, providerBps: 20, appAmount: "1", providerAmount: "1" },
    withdrawFee: null,
    refundFee: null,
    recipient: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    refundTo: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    sender: null,
    depositAddress: "0x" + "12".repeat(20),
    depositMemo: null,
    deadline: new Date(T0 + 30 * 60_000).toISOString(),
    termsVersion: "t",
    screening: { result: "clear", listVersion: "v", checkedAt: new Date(T0).toISOString() },
    quoteResponse: { signature: "ed25519:x" },
    state: {
      status: "waiting",
      upstreamStatus: "PENDING_DEPOSIT",
      statusSince: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
      anchor: T0,
      depositTxHash: null,
      depositForwarded: false,
      details: null,
      finishedAt: null,
      stopped: false,
      slowAlertSent: false,
      ...state,
    },
    ...overrides,
  };
}

describe("order IDs", () => {
  it("are 160 random bits, URL-safe and unique", () => {
    const ids = new Set(Array.from({ length: 2000 }, newOrderId));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{27}$/);
  });

  it("are checked before any file is touched", () => {
    for (const bad of ["", "abc", "../../etc/passwd", "A".repeat(26), "A".repeat(28), `${"A".repeat(26)}/`, `${"A".repeat(26)}.`, null, 5]) {
      expect(isOrderId(bad)).toBe(false);
    }
    const store = createOrderStore(dir);
    fs.writeFileSync(path.join(dir, "secret.json"), JSON.stringify(record()));
    expect(store.get("../secret")).toBeNull();
    expect(store.get("..%2Fsecret")).toBeNull();
  });
});

describe("order store", () => {
  it("writes one file per order and reads it back", () => {
    const store = createOrderStore(dir);
    const order = record();
    store.create(order);
    const file = path.join(dir, "orders", `${order.id}.json`);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(order);
    expect(store.get(order.id)).toEqual(order);
    expect(store.openCount()).toBe(1);
    expect(fs.readdirSync(path.join(dir, "orders"))).toEqual([`${order.id}.json`]);
  });

  it("leaves no temporary file behind and never a half-written order", () => {
    const store = createOrderStore(dir);
    const order = record();
    store.create(order);
    for (let i = 0; i < 25; i++) store.saveState(order.id, { ...order.state, updatedAt: new Date(T0 + i).toISOString() });
    const files = fs.readdirSync(path.join(dir, "orders"));
    expect(files).toEqual([`${order.id}.json`]);
    expect(() => JSON.parse(fs.readFileSync(path.join(dir, "orders", files[0]!), "utf8"))).not.toThrow();
  });

  it("writes through a temporary file that is forced to disk before it replaces the record", () => {
    const store = createOrderStore(dir);
    const order = record();
    const final = path.join(dir, "orders", `${order.id}.json`);
    // Plain spies: the real functions still run.
    const open = vi.spyOn(fs, "openSync");
    const sync = vi.spyOn(fs, "fsyncSync");
    const rename = vi.spyOn(fs, "renameSync");
    try {
      store.create(order);
      // Two things are written: the record, then the small entry that lets it be found by its deposit address.
      // Both go the same careful way; what follows looks at each.
      const opened = open.mock.calls.map((call) => ({ target: String(call[0]), flags: String(call[1]) }));
      const temps = opened.filter((call) => call.target.includes(".tmp-"));
      expect(temps).toHaveLength(2);
      const [temp, indexTemp] = temps as [(typeof temps)[number], (typeof temps)[number]];
      // The data goes to a new temporary file next to the final one, opened so that it cannot clobber anything.
      expect(temp.flags).toBe("wx");
      expect(path.dirname(temp.target)).toBe(path.dirname(final));
      expect(indexTemp.flags).toBe("wx");
      expect(path.dirname(indexTemp.target)).toBe(path.join(dir, "by-deposit"));
      // It is forced to disk, and only then renamed over the final name. The record comes first.
      expect(rename).toHaveBeenCalledTimes(2);
      expect(rename.mock.calls[0]).toEqual([temp.target, final]);
      expect(String(rename.mock.calls[1]![0])).toBe(indexTemp.target);
      expect(sync.mock.invocationCallOrder[0]!).toBeLessThan(rename.mock.invocationCallOrder[0]!);
      // Each folder is synced after its rename, so the rename itself survives a crash.
      const folders = opened.filter((call) => call.flags === "r").map((call) => call.target);
      expect(folders).toEqual([path.dirname(final), path.join(dir, "by-deposit")]);
      expect(sync.mock.invocationCallOrder[1]!).toBeGreaterThan(rename.mock.invocationCallOrder[0]!);
      expect(sync.mock.invocationCallOrder[1]!).toBeLessThan(rename.mock.invocationCallOrder[1]!);
      expect(sync.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(rename.mock.invocationCallOrder[1]!);
      expect(sync).toHaveBeenCalledTimes(4);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps the old record intact, and leaves no stray file, when a write fails half way", () => {
    const store = createOrderStore(dir);
    const order = record();
    store.create(order);
    const final = path.join(dir, "orders", `${order.id}.json`);
    const before = fs.readFileSync(final, "utf8");

    for (const failing of ["renameSync", "fsyncSync"] as const) {
      const spy = vi.spyOn(fs, failing).mockImplementation(() => {
        throw new Error("disk full");
      });
      try {
        expect(() => store.saveState(order.id, { ...order.state, status: "swapping" })).toThrow("disk full");
        expect(() => store.create(record())).toThrow("disk full");
      } finally {
        spy.mockRestore();
      }
      expect(fs.readFileSync(final, "utf8")).toBe(before);
      expect(fs.readdirSync(path.join(dir, "orders"))).toEqual([`${order.id}.json`]);
      // What is in memory still matches what is on disk.
      expect(store.get(order.id)?.state.status).toBe("waiting");
      expect(store.openCount()).toBe(1);
    }
  });

  it("refuses to overwrite an existing order", () => {
    const store = createOrderStore(dir);
    const order = record();
    store.create(order);
    expect(() => store.create({ ...order, recipient: "0x" + "99".repeat(20) })).toThrow();
    expect(store.get(order.id)?.recipient).toBe(order.recipient);
  });

  it("changes only the tracking state after creation", () => {
    const store = createOrderStore(dir);
    const order = record();
    store.create(order);
    store.saveState(order.id, { ...order.state, status: "swapping", depositTxHash: "0xabc" });
    const reread = createOrderStore(dir).get(order.id)!;
    expect(reread.state.status).toBe("swapping");
    expect({ ...reread, state: order.state }).toEqual(order);
    expect(() => store.saveState(newOrderId(), order.state)).toThrow();
  });

  it("reloads unfinished orders at start and cleans up stray temporary files", () => {
    const first = createOrderStore(dir);
    const waiting = record();
    const done = record({}, { status: "delivered", finishedAt: new Date(T0).toISOString() });
    first.create(waiting);
    first.create(done);
    fs.writeFileSync(path.join(dir, "orders", `${newOrderId()}.json.tmp-1-dead`), "{half");
    fs.writeFileSync(path.join(dir, "orders", "notes.txt"), "ignore me");
    fs.writeFileSync(path.join(dir, "orders", `${newOrderId()}.json`), "{broken json");

    const second = createOrderStore(dir);
    expect(second.open().map((o) => o.id)).toEqual([waiting.id]);
    expect(second.get(done.id)?.state.status).toBe("delivered");
    expect(fs.readdirSync(path.join(dir, "orders")).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("moves an order out of the open set when it finishes", () => {
    const store = createOrderStore(dir);
    const order = record();
    store.create(order);
    store.saveState(order.id, { ...order.state, status: "refunded", finishedAt: new Date(T0).toISOString() });
    expect(store.openCount()).toBe(0);
    expect(store.get(order.id)?.state.status).toBe("refunded");
  });
});

describe("retention", () => {
  const deadline = T0 + 30 * 60_000;

  it("deletes never-funded orders 24 hours after their deadline", () => {
    const expired = record({}, { status: "expired", finishedAt: new Date(deadline + 600_000).toISOString() });
    expect(isExpiredRecord(expired, deadline + UNFUNDED_RETENTION_MS - 1)).toBe(false);
    expect(isExpiredRecord(expired, deadline + UNFUNDED_RETENTION_MS + 1)).toBe(true);
  });

  it("never deletes an order that is still marked waiting, however old", () => {
    // "Waiting" past the deadline means the provider has not yet confirmed that nothing arrived
    // (for example during an outage). A deposit may be there, so the record stays.
    const waiting = record();
    expect(isExpiredRecord(waiting, deadline + UNFUNDED_RETENTION_MS + 1)).toBe(false);
    expect(isExpiredRecord(waiting, deadline + 365 * 86_400_000)).toBe(false);
  });

  it("deletes finished orders 30 days after they finish", () => {
    const finishedAt = T0 + 3_600_000;
    for (const status of ["delivered", "refunded", "failed"] as const) {
      const order = record({}, { status, finishedAt: new Date(finishedAt).toISOString(), depositTxHash: "0xabc" });
      expect(isExpiredRecord(order, finishedAt + FINISHED_RETENTION_MS - 1)).toBe(false);
      expect(isExpiredRecord(order, finishedAt + FINISHED_RETENTION_MS + 1)).toBe(true);
    }
  });

  it("keeps an expired order that has a deposit hash for 30 days, since it may be a late or lost deposit", () => {
    const finishedAt = deadline + 600_000;
    const order = record({}, { status: "expired", depositTxHash: "0xabc", finishedAt: new Date(finishedAt).toISOString() });
    expect(isExpiredRecord(order, deadline + UNFUNDED_RETENTION_MS + 1)).toBe(false);
    expect(isExpiredRecord(order, finishedAt + FINISHED_RETENTION_MS - 1)).toBe(false);
    expect(isExpiredRecord(order, finishedAt + FINISHED_RETENTION_MS + 1)).toBe(true);
  });

  it("never deletes an order that is still in progress", () => {
    const year = 365 * 86_400_000;
    expect(isExpiredRecord(record({}, { status: "swapping" }), T0 + year)).toBe(false);
    expect(isExpiredRecord(record({}, { status: "deposit_seen" }), T0 + year)).toBe(false);
    expect(isExpiredRecord(record({}, { status: "waiting", depositTxHash: "0xabc" }), T0 + year)).toBe(false);
  });

  it("sweeps expired files from disk", () => {
    const store = createOrderStore(dir);
    const old = record({}, { status: "delivered", finishedAt: new Date(T0).toISOString() });
    const recent = record({}, { status: "delivered", finishedAt: new Date(T0 + 29 * 86_400_000).toISOString() });
    const unpaid = record({}, { status: "expired", finishedAt: new Date(deadline + 600_000).toISOString() });
    const unconfirmed = record();
    const active = record({}, { status: "swapping" });
    for (const order of [old, recent, unpaid, unconfirmed, active]) store.create(order);
    // Listing what is due deletes nothing; the caller removes each one after its last check.
    const due = store.deletable(T0 + FINISHED_RETENTION_MS + 60_000).map((r) => r.id);
    expect(due.sort()).toEqual([old.id, unpaid.id].sort());
    expect(store.get(old.id)).not.toBeNull();
    for (const id of due) store.remove(id);
    expect(store.get(old.id)).toBeNull();
    expect(store.get(unpaid.id)).toBeNull();
    expect(store.get(recent.id)).not.toBeNull();
    expect(store.get(active.id)).not.toBeNull();
    expect(store.get(unconfirmed.id)).not.toBeNull();
    expect(fs.readdirSync(path.join(dir, "orders")).sort()).toEqual([`${recent.id}.json`, `${active.id}.json`, `${unconfirmed.id}.json`].sort());
  });

  it("never deletes an order that stopped being tracked with funds in it", () => {
    const stoppedAt = new Date(T0).toISOString();
    const longAfter = T0 + 10 * FINISHED_RETENTION_MS;
    // The provider had started on it, or we confirmed the deposit on-chain ourselves: kept until someone looks into it.
    expect(isExpiredRecord(record({}, { status: "swapping", stopped: true, finishedAt: stoppedAt }), longAfter)).toBe(false);
    expect(isExpiredRecord(record({}, { status: "deposit_too_small", stopped: true, finishedAt: stoppedAt }), longAfter)).toBe(false);
    expect(isExpiredRecord(record({}, { status: "waiting", stopped: true, finishedAt: stoppedAt, depositTxHash: "0xabc", depositVerified: true }), longAfter)).toBe(false);
    // Nothing was ever proven: it goes 30 days after tracking stopped (after one last check with the provider).
    expect(isExpiredRecord(record({}, { status: "waiting", stopped: true, finishedAt: stoppedAt }), T0 + FINISHED_RETENTION_MS - 1)).toBe(false);
    expect(isExpiredRecord(record({}, { status: "waiting", stopped: true, finishedAt: stoppedAt }), T0 + FINISHED_RETENTION_MS + 1)).toBe(true);
    expect(isExpiredRecord(record({}, { status: "deposit_seen", stopped: true, finishedAt: stoppedAt }), T0 + FINISHED_RETENTION_MS + 1)).toBe(true);
    expect(isExpiredRecord(record({}, { status: "waiting", stopped: true, finishedAt: stoppedAt, depositTxHash: "0xabc", depositVerified: false }), T0 + FINISHED_RETENTION_MS + 1)).toBe(true);
  });

  it("says funds are proven only by the provider's own progress or a deposit we confirmed", () => {
    const state = (extra: Record<string, unknown>) => record({}, extra).state;
    expect(hasProvenFunds(state({ status: "waiting" }))).toBe(false);
    expect(hasProvenFunds(state({ status: "deposit_seen" }))).toBe(false);
    expect(hasProvenFunds(state({ status: "waiting", depositTxHash: "0xabc", depositVerified: false }))).toBe(false);
    expect(hasProvenFunds(state({ status: "waiting", depositTxHash: "0xabc", depositVerified: true }))).toBe(true);
    expect(hasProvenFunds(state({ status: "swapping" }))).toBe(true);
    expect(hasProvenFunds(state({ status: "deposit_too_small" }))).toBe(true);
  });

  it("does not count an order it stopped tracking as open", () => {
    const store = createOrderStore(dir);
    store.create(record());
    const stopped = record({}, { status: "swapping", stopped: true, finishedAt: new Date(T0).toISOString() });
    store.create(stopped);
    expect(store.open()).toHaveLength(2);
    expect(store.openCount()).toBe(1);
  });
});

describe("finding an order by its deposit address", () => {
  const SOL = "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP";

  it("finds the order, whatever the capitals of a hex address", () => {
    const store = createOrderStore(dir);
    const order = record({ depositAddress: "0xAe001C67DbdC649e76BD8f41A75D1D154423D8aD" });
    store.create(order);
    store.create(record({ depositAddress: SOL }));
    expect(store.findByDeposit("0xAe001C67DbdC649e76BD8f41A75D1D154423D8aD")?.id).toBe(order.id);
    expect(store.findByDeposit("0xae001c67dbdc649e76bd8f41a75d1d154423d8ad")?.id).toBe(order.id);
    expect(store.findByDeposit("0XAE001C67DBDC649E76BD8F41A75D1D154423D8AD")).toBeNull();
    // Any other kind of address is taken letter for letter.
    expect(store.findByDeposit(SOL)).not.toBeNull();
    expect(store.findByDeposit(SOL.toLowerCase())).toBeNull();
  });

  it("finds nothing for an address that is no order's, or is not an address at all", () => {
    const store = createOrderStore(dir);
    store.create(record());
    for (const bad of ["0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83", "", "abc", "../../etc/passwd", "x".repeat(500), `${"0x" + "12".repeat(20)} `, "0x" + "12".repeat(20) + "/../x"]) expect(store.findByDeposit(bad), bad).toBeNull();
    expect(store.findByDeposit(null as unknown as string)).toBeNull();
  });

  it("opens no order when two share an address (chains that tell deposits apart by a memo)", () => {
    const store = createOrderStore(dir);
    const shared = "GAQMXQJ2UFA5ECB2JJ3GUYQF46ROPVINVWAMN7KNR3OAMDHLQ46LFRBW";
    const first = record({ depositAddress: shared, depositMemo: "1" });
    store.create(first);
    expect(store.findByDeposit(shared)?.id).toBe(first.id);
    store.create(record({ depositAddress: shared, depositMemo: "2" }));
    expect(store.findByDeposit(shared)).toBeNull();
    // Removing one of them does not make the address point at the other: it stays unanswered.
    store.remove(first.id);
    expect(store.findByDeposit(shared)).toBeNull();
  });

  it("forgets the address when the order is deleted, and keeps it across a restart", () => {
    const store = createOrderStore(dir);
    const kept = record({ depositAddress: "0x" + "34".repeat(20) }, { status: "delivered" });
    const gone = record({ depositAddress: "0x" + "56".repeat(20) });
    store.create(kept);
    store.create(gone);
    store.remove(gone.id);
    expect(store.findByDeposit(gone.depositAddress)).toBeNull();
    const restarted = createOrderStore(dir);
    expect(restarted.findByDeposit(kept.depositAddress)?.id).toBe(kept.id);
    expect(restarted.findByDeposit(gone.depositAddress)).toBeNull();
  });

  it("indexes records that were written before the index existed", () => {
    const store = createOrderStore(dir);
    const old = record({ depositAddress: "0x" + "78".repeat(20) }, { status: "refunded" });
    store.create(old);
    fs.rmSync(path.join(dir, "by-deposit"), { recursive: true, force: true });
    expect(createOrderStore(dir).findByDeposit(old.depositAddress)?.id).toBe(old.id);
  });

  it("never answers from the index alone: the record must carry the address", () => {
    const store = createOrderStore(dir);
    const order = record({ depositAddress: "0x" + "9a".repeat(20) });
    store.create(order);
    // An index entry for another address that points at this order is not believed: the order does not carry that address.
    const other = "0x" + "bc".repeat(20);
    const files = fs.readdirSync(path.join(dir, "by-deposit"));
    expect(files).toEqual([createHash("sha256").update(order.depositAddress).digest("hex")]);
    fs.writeFileSync(path.join(dir, "by-deposit", createHash("sha256").update(other).digest("hex")), order.id);
    expect(store.findByDeposit(other)).toBeNull();
    expect(createOrderStore(dir).findByDeposit(other)).toBeNull();
    expect(store.findByDeposit(order.depositAddress)?.id).toBe(order.id);
  });
});

