import { describe, expect, it } from "vitest";
import { lastLook, lookAt, watchReceipt, watchTransfer, type ChainRead } from "../web/src/lib/transfer-watch.ts";

const HASH = `0x${"ab".repeat(32)}`;
const FROM = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";

/** A pretend chain: what it answers can be changed between looks, and every question is written down. */
function chain(state: { receipt?: unknown; tx?: unknown; count?: string; receiptLater?: unknown }) {
  const asked: string[] = [];
  let receiptAsks = 0;
  const read: ChainRead = (method) => {
    asked.push(method);
    if (method === "eth_getTransactionReceipt") {
      receiptAsks += 1;
      return Promise.resolve(receiptAsks > 1 && state.receiptLater !== undefined ? state.receiptLater : (state.receipt ?? null));
    }
    if (method === "eth_getTransactionByHash") return Promise.resolve(state.tx ?? null);
    if (method === "eth_getTransactionCount") return Promise.resolve(state.count ?? "0x0");
    return Promise.reject(new Error(`unexpected ${method}`));
  };
  return { read, asked, state };
}
const tx = { from: FROM, nonce: "0x7" };

describe("one look at a sent transfer", () => {
  it("says included only for an explicit success, and failed for any other receipt", async () => {
    expect((await lookAt(chain({ receipt: { status: "0x1" } }).read, HASH, { from: null, nonce: null })).sighting).toBe("mined");
    for (const status of ["0x0", "0x2", undefined, 1, "1", "0x01"]) expect((await lookAt(chain({ receipt: { status } }).read, HASH, { from: null, nonce: null })).sighting, String(status)).toBe("reverted");
  });

  it("asks nothing more once there is a receipt", async () => {
    const c = chain({ receipt: { status: "0x1" } });
    await lookAt(c.read, HASH, { from: null, nonce: null });
    expect(c.asked).toEqual(["eth_getTransactionReceipt"]);
  });

  it("is still on its way while the chain does not know it, or knows it and has not reached its number", async () => {
    expect(await lookAt(chain({}).read, HASH, { from: null, nonce: null })).toEqual({ sighting: "pending", known: { from: null, nonce: null } });
    // Seven transactions included so far (numbers 0 to 6): number 7 is next, not yet used.
    expect(await lookAt(chain({ tx, count: "0x7" }).read, HASH, { from: null, nonce: null })).toEqual({ sighting: "pending", known: { from: FROM, nonce: 7n } });
  });

  it("was replaced when its number has been used and it has no receipt", async () => {
    const c = chain({ tx, count: "0x8" });
    expect((await lookAt(c.read, HASH, { from: null, nonce: null })).sighting).toBe("replaced");
    // The receipt is asked for a second time before saying so.
    expect(c.asked).toEqual(["eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getTransactionCount", "eth_getTransactionReceipt"]);
  });

  it("was not replaced if it was itself included between the two questions", async () => {
    expect((await lookAt(chain({ tx, count: "0x8", receiptLater: { status: "0x1" } }).read, HASH, { from: null, nonce: null })).sighting).toBe("mined");
    expect((await lookAt(chain({ tx, count: "0x8", receiptLater: { status: "0x0" } }).read, HASH, { from: null, nonce: null })).sighting).toBe("reverted");
  });

  it("does not look the transaction up again once its sender and number are known", async () => {
    const c = chain({ count: "0x7" });
    await lookAt(c.read, HASH, { from: FROM, nonce: 7n });
    expect(c.asked).toEqual(["eth_getTransactionReceipt", "eth_getTransactionCount"]);
  });

  it("takes nothing on trust from a malformed answer", async () => {
    for (const bad of [{ from: "0x1234", nonce: "0x7" }, { from: FROM, nonce: "7" }, { from: FROM }, "0xabc", 5]) expect((await lookAt(chain({ tx: bad, count: "0xff" }).read, HASH, { from: null, nonce: null })).sighting, JSON.stringify(bad)).toBe("pending");
    expect((await lookAt(chain({ tx, count: "lots" }).read, HASH, { from: null, nonce: null })).sighting).toBe("pending");
  });
});

describe("following a transfer", () => {
  const noWait = () => Promise.resolve();

  it("keeps looking until there is an answer", async () => {
    const c = chain({ tx, count: "0x7" });
    let looks = 0;
    const read: ChainRead = (method, params) => {
      if (method === "eth_getTransactionReceipt") looks += 1;
      if (looks === 4) c.state.receipt = { status: "0x1" };
      return c.read(method, params);
    };
    expect(await watchTransfer({ read, hash: HASH, signal: new AbortController().signal, wait: noWait })).toBe("mined");
    expect(looks).toBe(4);
  });

  it("says replaced only when two looks in a row say so", async () => {
    // One look says replaced, the next finds the receipt after all (the two nodes were a block apart): included.
    let receiptAsks = 0;
    const lagging: ChainRead = (method) => {
      if (method === "eth_getTransactionReceipt") {
        receiptAsks += 1;
        return Promise.resolve(receiptAsks >= 3 ? { status: "0x1" } : null);
      }
      if (method === "eth_getTransactionByHash") return Promise.resolve(tx);
      return Promise.resolve("0x8");
    };
    expect(await watchTransfer({ read: lagging, hash: HASH, signal: new AbortController().signal, wait: noWait })).toBe("mined");

    // Replaced on every look: said on the second, not the first.
    let waits = 0;
    const gone = chain({ tx, count: "0x8" });
    expect(await watchTransfer({ read: gone.read, hash: HASH, signal: new AbortController().signal, wait: () => { waits += 1; return Promise.resolve(); } })).toBe("replaced");
    expect(waits).toBe(1);

    // Replaced, then not (the count was wrong for a moment), then replaced twice: only then.
    let counts = 0;
    const wobbly: ChainRead = (method) => {
      if (method === "eth_getTransactionReceipt") return Promise.resolve(null);
      if (method === "eth_getTransactionByHash") return Promise.resolve(tx);
      counts += 1;
      return Promise.resolve(counts === 2 ? "0x7" : "0x8");
    };
    let rounds = 0;
    expect(await watchTransfer({ read: wobbly, hash: HASH, signal: new AbortController().signal, wait: () => { rounds += 1; return Promise.resolve(); } })).toBe("replaced");
    expect(rounds).toBe(3);
  });

  it("keeps asking for the receipt of a transfer that was called replaced, in case it was included after all", async () => {
    let asks = 0;
    const read: ChainRead = (method) => {
      expect(method).toBe("eth_getTransactionReceipt");
      asks += 1;
      if (asks === 2) return Promise.reject(new Error("offline"));
      return Promise.resolve(asks >= 4 ? { status: "0x1" } : null);
    };
    expect(await watchReceipt({ read, hash: HASH, signal: new AbortController().signal, wait: noWait })).toBe("mined");
    expect(asks).toBe(4);
    expect(await watchReceipt({ read: () => Promise.resolve({ status: "0x0" }), hash: HASH, signal: new AbortController().signal, wait: noWait })).toBe("reverted");
    const stop = new AbortController();
    stop.abort();
    expect(await watchReceipt({ read, hash: HASH, signal: stop.signal, wait: noWait })).toBeNull();
  });

  it("tries again when the chain cannot be asked", async () => {
    let calls = 0;
    const read: ChainRead = () => {
      calls += 1;
      return calls < 3 ? Promise.reject(new Error("offline")) : Promise.resolve({ status: "0x0" });
    };
    expect(await watchTransfer({ read, hash: HASH, signal: new AbortController().signal, wait: noWait })).toBe("reverted");
  });

  it("stops without an answer when told to", async () => {
    const stop = new AbortController();
    let waits = 0;
    const result = await watchTransfer({
      read: chain({}).read,
      hash: HASH,
      signal: stop.signal,
      wait: () => {
        waits += 1;
        if (waits === 2) stop.abort();
        return Promise.resolve();
      },
    });
    expect(result).toBeNull();
    expect(waits).toBe(2);
  });
});

describe("the last look before a second transfer", () => {
  it("stops the second transfer when the first was included after all", async () => {
    expect(await lastLook(() => Promise.resolve({ status: "0x1" }), HASH)).toBe("included");
  });

  it("lets it go ahead when the first has no receipt, or failed", async () => {
    expect(await lastLook(() => Promise.resolve(null), HASH)).toBe("clear");
    expect(await lastLook(() => Promise.resolve({ status: "0x0" }), HASH)).toBe("clear");
  });

  it("does not guess when the chain cannot be asked", async () => {
    expect(await lastLook(() => Promise.reject(new Error("offline")), HASH)).toBe("unknown");
  });

  it("asks one question and no more", async () => {
    const asked: string[] = [];
    await lastLook((method) => {
      asked.push(method);
      return Promise.resolve(null);
    }, HASH);
    expect(asked).toEqual(["eth_getTransactionReceipt"]);
  });
});

