import { afterEach, describe, expect, it } from "vitest";
import { allowedTransition, applyStatus, backoffMs, EXPIRE_AFTER_DEADLINE_MS, GIVE_UP_AFTER_DEADLINE_MS, giveUp, parseDetails, pollIntervalMs, unpaidIntervalMs } from "../server/poller.ts";
import { silentLogger } from "../server/log.ts";
import { createSweeper, UNCLEAR_GRACE_MS } from "../server/maintenance.ts";
import type { UpstreamResult } from "../server/oneclick.ts";
import { isExpiredRecord, UNFUNDED_RETENTION_MS, type OrderRecord } from "../server/store.ts";
import { asOrder, ASSET, ADDR, harness, type Harness } from "./helpers.ts";

let open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.map((h) => h.close()));
  open = [];
});

async function orderIn(h: Harness, overrides: Record<string, unknown> = {}, ip?: string): Promise<OrderRecord> {
  const view = asOrder(await h.order(overrides, ip ? { ip } : {}));
  return h.store.get(view.id)!;
}

async function fresh(overrides: Record<string, unknown> = {}) {
  const h = await harness();
  open.push(h);
  const record = await orderIn(h, overrides);
  return { h, record };
}

const reply = (record: OrderRecord, status: string, swapDetails: unknown = {}) => ({
  status,
  swapDetails,
  quoteResponse: { quote: { depositAddress: record.depositAddress } },
});

describe("poll schedule", () => {
  it("is 5 s for 2 minutes, then 15 s, then 60 s after 30 minutes", () => {
    expect(pollIntervalMs(0)).toBe(5000);
    expect(pollIntervalMs(119_999)).toBe(5000);
    expect(pollIntervalMs(120_000)).toBe(15_000);
    expect(pollIntervalMs(30 * 60_000 - 1)).toBe(15_000);
    expect(pollIntervalMs(30 * 60_000)).toBe(60_000);
    expect(pollIntervalMs(5 * 3_600_000)).toBe(60_000);
  });

  it("backs off on errors up to 5 minutes", () => {
    expect(backoffMs(5000, 1)).toBe(10_000);
    expect(backoffMs(5000, 3)).toBe(40_000);
    expect(backoffMs(5000, 10)).toBe(300_000);
    expect(backoffMs(60_000, 20)).toBe(300_000);
  });
});

describe("status mapping", () => {
  it("maps every provider status to what we show", async () => {
    const { h, record } = await fresh();
    const map: Array<[string, string]> = [
      ["PENDING_DEPOSIT", "waiting"],
      ["KNOWN_DEPOSIT_TX", "deposit_seen"],
      ["PROCESSING", "swapping"],
      ["SUCCESS", "delivered"],
      ["INCOMPLETE_DEPOSIT", "deposit_too_small"],
      ["REFUNDED", "refunded"],
      ["FAILED", "failed"],
    ];
    for (const [upstream, shown] of map) {
      const update = applyStatus(record, reply(record, upstream), h.clock.t);
      expect(update.kind).toBe("state");
      if (update.kind === "state") expect(update.state.status).toBe(shown);
    }
  });

  it("marks finished orders and records when the status changed", async () => {
    const { h, record } = await fresh();
    const later = h.clock.t + 90_000;
    const update = applyStatus(record, reply(record, "SUCCESS"), later);
    if (update.kind !== "state") throw new Error("expected a state");
    expect(update.changed).toBe(true);
    expect(update.state.finishedAt).toBe(new Date(later).toISOString());
    expect(update.state.statusSince).toBe(new Date(later).toISOString());
    const same = applyStatus(record, reply(record, "PENDING_DEPOSIT"), later);
    if (same.kind !== "state") throw new Error("expected a state");
    expect(same.changed).toBe(false);
    expect(same.state.statusSince).toBe(record.state.statusSince);
    expect(same.state.finishedAt).toBeNull();
  });

  it("turns a still-waiting order into Expired 10 minutes after its deadline", async () => {
    const { record } = await fresh();
    const deadline = Date.parse(record.deadline);
    const before = applyStatus(record, reply(record, "PENDING_DEPOSIT"), deadline + EXPIRE_AFTER_DEADLINE_MS - 1);
    const after = applyStatus(record, reply(record, "PENDING_DEPOSIT"), deadline + EXPIRE_AFTER_DEADLINE_MS + 1);
    if (before.kind !== "state" || after.kind !== "state") throw new Error("expected states");
    expect(before.state.status).toBe("waiting");
    expect(after.state.status).toBe("expired");
    expect(after.state.finishedAt).not.toBeNull();
  });

  it("never moves backwards from delivered, refunded or failed", async () => {
    const { h, record } = await fresh();
    for (const final of ["delivered", "refunded", "failed"] as const) {
      const finished: OrderRecord = { ...record, state: { ...record.state, status: final, finishedAt: "2026-10-08T12:05:00.000Z" } };
      for (const upstream of ["PENDING_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"]) {
        const update = applyStatus(finished, reply(record, upstream), h.clock.t);
        if (update.kind !== "state") throw new Error("expected a state");
        expect(update.state.status).toBe(final);
        expect(update.changed).toBe(false);
      }
    }
  });

  it("lets a late deposit correct an expired order", async () => {
    const { h, record } = await fresh();
    const expired: OrderRecord = { ...record, state: { ...record.state, status: "expired", finishedAt: "2026-10-08T13:00:00.000Z" } };
    const late = Date.parse(record.deadline) + 2 * 3_600_000;
    const stillNothing = applyStatus(expired, reply(record, "PENDING_DEPOSIT"), late);
    const refunded = applyStatus(expired, reply(record, "REFUNDED"), late);
    const processing = applyStatus(expired, reply(record, "PROCESSING"), late);
    if (stillNothing.kind !== "state" || refunded.kind !== "state" || processing.kind !== "state") throw new Error("expected states");
    expect(stillNothing.state.status).toBe("expired");
    expect(refunded.state.status).toBe("refunded");
    expect(processing.state.status).toBe("swapping");
    expect(processing.state.finishedAt).toBeNull();
    void h;
  });

  it("gives up regular polling a week after the deadline, without changing what the order shows", async () => {
    const { record } = await fresh();
    const deadline = Date.parse(record.deadline);
    for (const status of ["waiting", "deposit_seen", "swapping", "deposit_too_small"] as const) {
      const stuck: OrderRecord = { ...record, state: { ...record.state, status } };
      expect(giveUp(stuck, deadline + GIVE_UP_AFTER_DEADLINE_MS - 1)).toBeNull();
      const stopped = giveUp(stuck, deadline + GIVE_UP_AFTER_DEADLINE_MS + 1);
      expect(stopped).toMatchObject({ status, stopped: true });
      expect(stopped?.finishedAt).not.toBeNull();
      // Once stopped, there is nothing more to give up.
      expect(giveUp({ ...stuck, state: stopped! }, deadline + 2 * GIVE_UP_AFTER_DEADLINE_MS)).toBeNull();
    }
    for (const status of ["delivered", "refunded", "failed", "expired"] as const) {
      expect(giveUp({ ...record, state: { ...record.state, status } }, deadline + 2 * GIVE_UP_AFTER_DEADLINE_MS)).toBeNull();
    }
  });

  it("only ever moves an order forward", async () => {
    const { h, record } = await fresh();
    const late = Date.parse(record.deadline) + EXPIRE_AFTER_DEADLINE_MS + 60_000;
    const at = (status: OrderRecord["state"]["status"]): OrderRecord => ({ ...record, state: { ...record.state, status } });
    const next = (from: OrderRecord["state"]["status"], upstream: string, when = h.clock.t) => {
      const update = applyStatus(at(from), reply(record, upstream), when);
      if (update.kind !== "state") throw new Error("expected a state");
      return { status: update.state.status, changed: update.changed, finishedAt: update.state.finishedAt };
    };
    // Funds in motion are never turned back into "waiting" or "expired" by an odd reply, even long after the deadline.
    for (const from of ["swapping", "deposit_too_small"] as const) {
      for (const upstream of ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX"]) {
        expect(next(from, upstream, late), `${from} + ${upstream}`).toEqual({ status: from, changed: false, finishedAt: null });
      }
    }
    expect(next("swapping", "INCOMPLETE_DEPOSIT").status).toBe("swapping");
    // They can only reach an end state (or, for an under-payment that was topped up, the swap).
    expect(next("swapping", "SUCCESS").status).toBe("delivered");
    expect(next("swapping", "REFUNDED").status).toBe("refunded");
    expect(next("swapping", "FAILED").status).toBe("failed");
    expect(next("deposit_too_small", "PROCESSING").status).toBe("swapping");
    expect(next("deposit_too_small", "REFUNDED").status).toBe("refunded");
    // A deposit that was only announced can fall back to waiting, and then expire normally.
    expect(next("deposit_seen", "PENDING_DEPOSIT").status).toBe("waiting");
    expect(next("deposit_seen", "PENDING_DEPOSIT", late).status).toBe("expired");
    expect(next("deposit_seen", "PROCESSING").status).toBe("swapping");
    expect(allowedTransition("waiting", "swapping")).toBe(true);
    expect(allowedTransition("expired", "waiting")).toBe(false);
    expect(allowedTransition("delivered", "swapping")).toBe(false);
  });

  it("refuses a reply about a different deposit address, and malformed replies", async () => {
    const { h, record } = await fresh();
    const other = { status: "SUCCESS", swapDetails: {}, quoteResponse: { quote: { depositAddress: "0x" + "99".repeat(20) } } };
    expect(applyStatus(record, other, h.clock.t).kind).toBe("mismatch");
    expect(applyStatus(record, null, h.clock.t).kind).toBe("invalid");
    expect(applyStatus(record, { status: "MADE_UP" }, h.clock.t).kind).toBe("invalid");
    // Text that happens to name a built-in property is not a status.
    for (const odd of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(applyStatus(record, { status: odd, swapDetails: {} }, h.clock.t).kind).toBe("invalid");
    }
    expect(applyStatus(record, { status: 5 }, h.clock.t).kind).toBe("invalid");
  });
});

describe("swap details", () => {
  it("builds explorer links from our own templates and ignores the provider's URLs", async () => {
    const { record } = await fresh();
    const originHash = `0x${"ab".repeat(32)}`;
    const destinationHash = `0x${"cd".repeat(32)}`;
    const details = parseDetails(
      {
        originChainTxHashes: [{ hash: originHash, explorerUrl: "https://evil.example/steal?x=1" }],
        destinationChainTxHashes: [{ hash: destinationHash, explorerUrl: "javascript:alert(1)" }],
        depositedAmount: "5000000000000000",
        amountIn: "5000000000000000",
        amountOut: "12000000",
        refundedAmount: "12.5",
        refundReason: "PARTIAL_DEPOSIT",
      },
      record,
    );
    expect(details).toEqual({
      originTxs: [{ hash: originHash, url: `https://basescan.org/tx/${originHash}` }],
      destinationTxs: [{ hash: destinationHash, url: `https://arbiscan.io/tx/${destinationHash}` }],
      depositedAmount: "5000000000000000",
      amountIn: "5000000000000000",
      amountOut: "12000000",
      refundedAmount: null,
      refundReason: "PARTIAL_DEPOSIT",
    });
    expect(JSON.stringify(details)).not.toContain("evil.example");
    expect(JSON.stringify(details)).not.toContain("javascript");
  });

  it("drops hashes and reasons that are not plain", async () => {
    const { record } = await fresh();
    const details = parseDetails(
      {
        originChainTxHashes: [{ hash: "<img src=x onerror=alert(1)>" }, { hash: "oddbutplainhash12345" }, "nope", { hash: 5 }],
        destinationChainTxHashes: "not a list",
        refundReason: "<script>alert(1)</script>",
      },
      record,
    );
    expect(details?.originTxs).toEqual([{ hash: "oddbutplainhash12345", url: null }]);
    expect(details?.destinationTxs).toEqual([]);
    expect(details?.refundReason).toBeNull();
    expect(parseDetails("nonsense", record)).toBeNull();
  });
});

describe("poller against a stubbed provider", () => {
  it("follows an order from deposit to delivery", async () => {
    const { h, record } = await fresh();
    const status = () => h.store.get(record.id)!.state.status;
    await h.poller.tick();
    expect(h.stub.calls.status).toBe(0); // not due for the first 5 s
    h.clock.t += 5000;
    await h.poller.tick();
    expect(h.stub.calls.status).toBe(1);
    expect(status()).toBe("waiting");

    h.stub.control(record.depositAddress, "deposit");
    h.clock.t += 5000;
    await h.poller.tick();
    expect(status()).toBe("deposit_seen");
    h.clock.t += 5000;
    await h.poller.tick();
    expect(status()).toBe("swapping");
    h.clock.t += 15_000;
    await h.poller.tick();
    expect(status()).toBe("delivered");

    const stored = h.store.get(record.id)!;
    expect(stored.state.finishedAt).not.toBeNull();
    expect(stored.state.details?.destinationTxs[0]?.url).toMatch(/^https:\/\/arbiscan\.io\/tx\/0x/);
    expect(h.store.openCount()).toBe(0);

    // A finished order is never polled again.
    const calls = h.stub.calls.status;
    h.clock.t += 10 * 60_000;
    await h.poller.tick();
    expect(h.stub.calls.status).toBe(calls);
  });

  it("slows down as an order ages", async () => {
    const { h, record } = await fresh();
    const pollsDuring = async (ms: number, step: number) => {
      const start = h.stub.calls.status;
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        h.clock.t += step;
        await h.poller.tick();
      }
      return h.stub.calls.status - start;
    };
    expect(await pollsDuring(60_000, 1000)).toBeGreaterThanOrEqual(11); // about every 5 s
    h.clock.t += 2 * 60_000;
    await h.poller.tick();
    const mid = await pollsDuring(60_000, 1000);
    expect(mid).toBeGreaterThanOrEqual(3);
    expect(mid).toBeLessThanOrEqual(5); // about every 15 s
    void record;
  });

  it("shows under-payment and then the refund", async () => {
    const { h, record } = await fresh();
    h.stub.control(record.depositAddress, "underpay");
    h.clock.t += 5000;
    await h.poller.tick();
    let stored = h.store.get(record.id)!;
    expect(stored.state.status).toBe("deposit_too_small");
    expect(stored.state.details?.depositedAmount).toBe("2500000000000000");
    expect(h.store.openCount()).toBe(1);
    // An under-paid order is checked once a minute: it only waits for its refund.
    h.clock.t += 61_000;
    await h.poller.tick();
    stored = h.store.get(record.id)!;
    expect(stored.state.status).toBe("refunded");
    expect(stored.state.details).toMatchObject({ refundedAmount: "2500000000000000", refundReason: "PARTIAL_DEPOSIT" });
  });

  it("expires an order nobody paid", async () => {
    const { h, record } = await fresh();
    h.clock.t = Date.parse(record.deadline) + EXPIRE_AFTER_DEADLINE_MS + 5000;
    await h.poller.tick();
    expect(h.store.get(record.id)!.state.status).toBe("expired");
    expect(h.store.openCount()).toBe(0);
  });

  it("re-checks an expired order when someone opens it, at most every 10 minutes", async () => {
    const { h, record } = await fresh();
    h.clock.t = Date.parse(record.deadline) + EXPIRE_AFTER_DEADLINE_MS + 5000;
    await h.poller.tick();
    h.stub.control(record.depositAddress, "refund");
    h.clock.t += 60_000;
    const before = h.stub.calls.status;
    await h.poller.recheck(record.id);
    await h.poller.recheck(record.id);
    expect(h.stub.calls.status).toBe(before + 1);
    expect(h.store.get(record.id)!.state.status).toBe("refunded");
  });

  it("backs off when the provider fails and recovers afterwards", async () => {
    const h = await harness();
    open.push(h);
    const record = await orderIn(h);
    const real = h.stub.provider.status.bind(h.stub.provider);
    let failing = true;
    let attempts = 0;
    h.stub.provider.status = async (...args) => {
      attempts += 1;
      return failing ? { ok: false, kind: "unavailable", status: 503 } : real(...args);
    };
    for (let i = 0; i < 60; i++) {
      h.clock.t += 1000;
      await h.poller.tick();
    }
    // 5 s, then 10 s, 20 s, 40 s back-off: far fewer than the 12 polls a healthy minute would see.
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(5);
    failing = false;
    h.stub.control(record.depositAddress, "fail");
    h.clock.t += 5 * 60_000;
    await h.poller.tick();
    expect(h.store.get(record.id)!.state.status).toBe("failed");
  });

  it("alerts once when a swap runs past three times its estimate", async () => {
    const { h, record } = await fresh();
    const real = h.stub.provider.status.bind(h.stub.provider);
    h.stub.provider.status = async (...args) => {
      const result = await real(...args);
      if (result.ok) (result.data as { status: string }).status = "PROCESSING";
      return result;
    };
    h.clock.t += 5000;
    await h.poller.tick();
    expect(h.store.get(record.id)!.state.status).toBe("swapping");
    expect(h.alerts.filter((a) => a.kind === "slow_swap")).toHaveLength(0);
    for (let i = 0; i < 30; i++) {
      h.clock.t += 15_000;
      await h.poller.tick();
    }
    expect(h.alerts.filter((a) => a.kind === "slow_swap")).toHaveLength(1);
    expect(h.alerts.find((a) => a.kind === "slow_swap")?.text).not.toContain(record.id);
    expect(h.store.get(record.id)!.state.slowAlertSent).toBe(true);
  });

  it("alerts and keeps the order unchanged when a status reply is for another address", async () => {
    const { h, record } = await fresh();
    h.stub.provider.status = async () => ({
      ok: true,
      status: 200,
      data: { status: "SUCCESS", swapDetails: {}, quoteResponse: { quote: { depositAddress: "0x" + "99".repeat(20) } } },
    });
    h.clock.t += 5000;
    await h.poller.tick();
    expect(h.store.get(record.id)!.state.status).toBe("waiting");
    expect(h.alerts.map((a) => a.kind)).toContain("status_mismatch");
  });

  it("expires an unpaid order only on a real answer: still waiting, or not found", async () => {
    const { h, record } = await fresh();
    const past = Date.parse(record.deadline) + EXPIRE_AFTER_DEADLINE_MS + 5000;
    const status = () => h.store.get(record.id)!.state.status;
    const answer = async (result: UpstreamResult) => {
      h.stub.provider.status = async () => result;
      h.clock.t += 6 * 60_000;
      await h.poller.tick();
    };
    h.clock.t = past;
    // Being turned away, an outage, a spent budget, or an unreadable reply prove nothing about the deposit.
    await answer({ ok: false, kind: "unavailable", status: 403 });
    await answer({ ok: false, kind: "unavailable", status: 503 });
    await answer({ ok: false, kind: "unavailable", status: null });
    await answer({ ok: false, kind: "unavailable", status: null, budget: true });
    await answer({ ok: false, kind: "rejected", status: 400, message: "bad request" });
    await answer({ ok: false, kind: "rejected", status: 403, message: "" });
    await answer({ ok: true, status: 200, data: { status: "SOMETHING_NEW" } });
    expect(status()).toBe("waiting");
    expect(h.store.openCount()).toBe(1);
    // The provider answering that it knows no such address does.
    await answer({ ok: false, kind: "rejected", status: 404, message: "Deposit address not found" });
    expect(status()).toBe("expired");
    expect(h.store.openCount()).toBe(0);
  });

  it("does not treat a not-found answer as expiry before the deadline has passed", async () => {
    const { h, record } = await fresh();
    h.stub.provider.status = async () => ({ ok: false, kind: "rejected", status: 404, message: "Deposit address not found" });
    h.clock.t += 5000;
    await h.poller.tick();
    expect(h.store.get(record.id)!.state.status).toBe("waiting");
  });

  it("gives up after a week whatever the provider answers, so nothing is polled forever", async () => {
    for (const result of [
      { ok: false, kind: "unavailable", status: 503 } as const,
      { ok: false, kind: "rejected", status: 400, message: "" } as const,
      { ok: true, status: 200, data: { status: "A_STATUS_FROM_THE_FUTURE" } } as const,
      { ok: true, status: 200, data: { status: "SUCCESS", swapDetails: {}, quoteResponse: { quote: { depositAddress: "0x" + "99".repeat(20) } } } } as const,
    ]) {
      const { h, record } = await fresh();
      // Funds were seen, then the provider stopped making sense.
      h.stub.control(record.depositAddress, "deposit");
      h.clock.t += 5000;
      await h.poller.tick();
      expect(h.store.get(record.id)!.state.status).toBe("deposit_seen");
      let calls = 0;
      h.stub.provider.status = async () => {
        calls += 1;
        return result;
      };
      h.clock.t = Date.parse(record.deadline) + GIVE_UP_AFTER_DEADLINE_MS + 60_000;
      await h.poller.tick();
      const stored = h.store.get(record.id)!;
      expect(stored.state).toMatchObject({ status: "deposit_seen", stopped: true });
      expect(stored.state.finishedAt).not.toBeNull();
      // It has left the schedule for good...
      const before = calls;
      for (let i = 0; i < 20; i++) {
        h.clock.t += 10 * 60_000;
        await h.poller.tick();
      }
      expect(calls).toBe(before);
      // ...and a look at its page re-checks it once without putting it back on the schedule.
      await h.poller.recheck(record.id);
      expect(calls).toBe(before + 1);
      h.clock.t += 60 * 60_000;
      await h.poller.tick();
      expect(calls).toBe(before + 1);
    }
  });

  it("retries soon, without backing off, when only our own call budget was spent", async () => {
    const { h, record } = await fresh();
    let attempts = 0;
    h.stub.provider.status = async () => {
      attempts += 1;
      return { ok: false, kind: "unavailable", status: null, budget: true };
    };
    for (let i = 0; i < 60; i++) {
      h.clock.t += 1000;
      await h.poller.tick();
    }
    // About every 5 seconds for the whole minute, where a provider fault would have backed off to 3 attempts.
    expect(attempts).toBeGreaterThanOrEqual(10);
    void record;
  });

  it("checks orders with funds in motion before orders nobody has paid", async () => {
    const h = await harness({ limits: { orderPerRecipient: { max: 100, windowMs: 3_600_000 } } });
    open.push(h);
    const unpaid: string[] = [];
    for (let i = 0; i < 30; i++) unpaid.push((await orderIn(h, { recipient: i % 2 ? ADDR.evm2 : ADDR.evm3 }, `198.51.100.${i + 1}`)).depositAddress);
    const funded = await orderIn(h, {}, "198.51.100.200");
    h.stub.control(funded.depositAddress, "deposit");
    h.store.saveState(funded.id, { ...funded.state, depositTxHash: `0x${"ab".repeat(32)}`, depositVerified: true });
    const order: string[] = [];
    const real = h.stub.provider.status.bind(h.stub.provider);
    h.stub.provider.status = async (address, ...rest) => {
      order.push(address);
      return real(address, ...rest);
    };
    h.clock.t += 6000;
    await h.poller.tick();
    // One pass takes a bounded batch; the funded order is in it although it was created last.
    expect(order.length).toBeLessThan(31);
    expect(order).toContain(funded.depositAddress);
    expect(order.indexOf(funded.depositAddress)).toBeLessThan(6);
  });

  it("keeps the checking of unpaid orders within its own budget, however many there are", async () => {
    // 40 unpaid orders, and a budget of 12 checks a minute for unpaid orders.
    const h = await harness({ limits: { orderPerRecipient: { max: 1000, windowMs: 3_600_000 }, orderCreate: { max: 1000, windowMs: 60_000 } } });
    open.push(h);
    for (let i = 0; i < 40; i++) await orderIn(h, {}, `198.51.${100 + Math.floor(i / 9)}.${(i % 9) + 1}`);
    const { createPoller } = await import("../server/poller.ts");
    const calls: string[] = [];
    const poller = createPoller({
      store: h.store,
      oneclick: {
        ...h.stub.provider,
        status: async (address, memo, priority) => {
          calls.push(String(priority));
          return h.stub.provider.status(address, memo, priority);
        },
      },
      alerts: { send() {} },
      log: { info() {}, warn() {}, error() {} },
      now: () => h.clock.t,
      unpaidCallsPerMin: 12,
    });
    // First pass: everything is due once.
    for (let i = 0; i < 10; i++) {
      h.clock.t += 1000;
      await poller.tick();
    }
    expect(calls.length).toBe(40);
    expect(calls.every((priority) => priority === "idle")).toBe(true);
    // After that each order waits its turn: 40 orders at 12 a minute is one check every 200 seconds each.
    calls.length = 0;
    for (let i = 0; i < 300; i++) {
      h.clock.t += 1000;
      await poller.tick();
    }
    // Five minutes at 12 a minute is 60 checks. Unstretched, 40 orders would have made well over 1,000.
    expect(calls.length).toBeGreaterThanOrEqual(40);
    expect(calls.length).toBeLessThanOrEqual(70);
  });

  it("checks an unpaid order promptly while someone is watching its page", async () => {
    const h = await harness({ limits: { orderPerRecipient: { max: 1000, windowMs: 3_600_000 }, orderCreate: { max: 1000, windowMs: 60_000 } } });
    open.push(h);
    const records: OrderRecord[] = [];
    for (let i = 0; i < 30; i++) records.push(await orderIn(h, {}, `198.51.${100 + Math.floor(i / 9)}.${(i % 9) + 1}`));
    const { createPoller } = await import("../server/poller.ts");
    const perOrder = new Map<string, number>();
    const poller = createPoller({
      store: h.store,
      oneclick: {
        ...h.stub.provider,
        status: async (address, memo, priority) => {
          perOrder.set(address, (perOrder.get(address) ?? 0) + 1);
          return h.stub.provider.status(address, memo, priority);
        },
      },
      alerts: { send() {} },
      log: { info() {}, warn() {}, error() {} },
      now: () => h.clock.t,
      unpaidCallsPerMin: 6,
    });
    const mine = records[7]!;
    for (let i = 0; i < 120; i++) {
      h.clock.t += 1000;
      if (i % 5 === 0) poller.watch(mine.id); // its page asks every 5 seconds
      await poller.tick();
    }
    // The watched order kept the usual 5-second rhythm; an unwatched one waited its turn (30 orders at 6 a minute).
    expect(perOrder.get(mine.depositAddress)!).toBeGreaterThanOrEqual(15);
    expect(perOrder.get(records[20]!.depositAddress)!).toBeLessThanOrEqual(2);
    expect(unpaidIntervalMs(5000, 30, 6)).toBe(300_000);
    expect(unpaidIntervalMs(5000, 3, 75)).toBe(5000);
    expect(unpaidIntervalMs(60_000, 0, 75)).toBe(60_000);
  });

  it("does not put an expired order back on the schedule when a look at its page finds nothing new", async () => {
    for (const answer of [
      { ok: false, kind: "rejected", status: 404, message: "Deposit address not found" } as const,
      { ok: false, kind: "unavailable", status: 503 } as const,
      { ok: false, kind: "unavailable", status: null, budget: true } as const,
      { ok: true, status: 200, data: { status: "NOT_A_STATUS" } } as const,
    ]) {
      const { h, record } = await fresh();
      h.clock.t = Date.parse(record.deadline) + EXPIRE_AFTER_DEADLINE_MS + 5000;
      await h.poller.tick();
      expect(h.store.get(record.id)!.state.status).toBe("expired");
      let calls = 0;
      h.stub.provider.status = async () => {
        calls += 1;
        return answer;
      };
      // Someone opens the page: one re-check.
      h.clock.t += 60_000;
      await h.poller.recheck(record.id);
      expect(calls).toBe(1);
      // Three hours of ticks: it must not be polled again on its own.
      for (let i = 0; i < 180; i++) {
        h.clock.t += 60_000;
        await h.poller.tick();
      }
      expect(calls, JSON.stringify(answer)).toBe(1);
      expect(h.store.get(record.id)!.state.status).toBe("expired");
    }
  });

  it("keeps the finish time of an order it stopped polling; one with funds in it is never cleaned up on its own", async () => {
    const { record } = await fresh();
    const gaveUpAt = Date.parse(record.deadline) + GIVE_UP_AFTER_DEADLINE_MS + 1;
    const stopped: OrderRecord = { ...record, state: giveUp({ ...record, state: { ...record.state, status: "deposit_seen" } }, gaveUpAt)! };
    expect(stopped.state.finishedAt).not.toBeNull();
    // Its page is opened later and the provider still reports the same, non-final, thing.
    for (const upstream of ["KNOWN_DEPOSIT_TX", "PROCESSING", "INCOMPLETE_DEPOSIT"]) {
      const update = applyStatus(stopped, reply(record, upstream), gaveUpAt + 86_400_000);
      if (update.kind !== "state") throw new Error("expected a state");
      expect(update.state.stopped).toBe(true);
      expect(update.state.finishedAt, upstream).toBe(stopped.state.finishedAt);
    }
    const { isExpiredRecord, FINISHED_RETENTION_MS } = await import("../server/store.ts");
    // Only ever announced: it is cleaned up 30 days after tracking stopped.
    const announced = applyStatus(stopped, reply(record, "KNOWN_DEPOSIT_TX"), gaveUpAt + 86_400_000);
    if (announced.kind !== "state") throw new Error("expected a state");
    expect(isExpiredRecord({ ...stopped, state: announced.state }, gaveUpAt + FINISHED_RETENTION_MS + 1)).toBe(true);
    // The provider had started on it: funds are in there, so the record stays until someone has looked.
    const later = applyStatus(stopped, reply(record, "PROCESSING"), gaveUpAt + 86_400_000);
    if (later.kind !== "state") throw new Error("expected a state");
    expect(isExpiredRecord({ ...stopped, state: later.state }, gaveUpAt + 10 * FINISHED_RETENTION_MS)).toBe(false);
  });

  it("resumes open orders after a restart", async () => {
    const { h, record } = await fresh({ from: ASSET.baseUsdc, to: ASSET.baseEth, amount: "25000000", recipient: ADDR.evm3 });
    // A second poller over the same store stands in for a restarted process.
    const { createPoller } = await import("../server/poller.ts");
    const { createOrderStore } = await import("../server/store.ts");
    const reloaded = createOrderStore(h.dataDir);
    expect(reloaded.openCount()).toBe(1);
    const again = createPoller({
      store: reloaded,
      oneclick: h.stub.provider,
      alerts: { send() {} },
      log: { info() {}, warn() {}, error() {} },
      now: () => h.clock.t,
    });
    h.stub.control(record.depositAddress, "fail");
    await again.tick();
    expect(reloaded.get(record.id)!.state.status).toBe("failed");
  });
});

describe("orders that may hold money are never dropped quietly", () => {
  const HASH = `0x${"ab".repeat(32)}`;
  const answer = (status: string, swapDetails: unknown = {}) => (address: string): UpstreamResult => ({ ok: true, status: 200, data: { status, swapDetails, quoteResponse: { quote: { depositAddress: address } } } });

  it("does not expire an order whose deposit we confirmed on-chain, and tells the operator once", async () => {
    const { h, record } = await fresh();
    h.store.saveState(record.id, { ...record.state, depositTxHash: HASH, depositVerified: true, depositForwarded: true });
    // Well past the deadline the provider still reports nothing.
    h.tap.statusReply = answer("PENDING_DEPOSIT");
    h.clock.t = Date.parse(record.deadline) + EXPIRE_AFTER_DEADLINE_MS + 1000;
    await h.poller.tick();
    expect(h.store.get(record.id)?.state).toMatchObject({ status: "waiting", stopped: false, unseenAlertSent: true });
    expect(h.tap.statusClasses.at(-1)).toBe("tracking");
    const alerts = () => h.alerts.filter((a) => a.kind === "deposit_unseen");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.text).not.toContain(record.id);
    expect(alerts()[0]?.text).not.toContain(record.depositAddress);
    // It stays tracked, and the operator is not told again.
    h.clock.t += 61_000;
    await h.poller.tick();
    expect(h.store.get(record.id)?.state.status).toBe("waiting");
    expect(alerts()).toHaveLength(1);
    // The provider forgetting the address does not expire it either.
    h.tap.statusReply = () => ({ ok: false, kind: "rejected", status: 404, message: "Deposit address not found" });
    h.clock.t += 6 * 60_000;
    await h.poller.tick();
    expect(h.store.get(record.id)?.state.status).toBe("waiting");
    // When the provider does pick it up, the order moves on as usual.
    h.tap.statusReply = answer("PROCESSING");
    h.clock.t += 6 * 60_000;
    await h.poller.tick();
    expect(h.store.get(record.id)?.state.status).toBe("swapping");
  });

  it("still expires an order with a hash nobody could confirm", async () => {
    const { h, record } = await fresh({ from: ASSET.btc, to: ASSET.arbUsdc, amount: "1000000", pay: "manual", sender: undefined, refundTo: ADDR.btc });
    h.store.saveState(record.id, { ...record.state, depositTxHash: "ab".repeat(32), depositVerified: false, depositForwarded: true });
    h.tap.statusReply = answer("PENDING_DEPOSIT");
    h.clock.t = Date.parse(record.deadline) + EXPIRE_AFTER_DEADLINE_MS + 1000;
    await h.poller.tick();
    expect(h.store.get(record.id)?.state.status).toBe("expired");
    expect(h.alerts.filter((a) => a.kind === "deposit_unseen")).toHaveLength(0);
  });

  it("tells the operator when tracking stops on an order with funds in it, and keeps the record", async () => {
    const { h, record } = await fresh();
    h.tap.statusReply = answer("PROCESSING");
    h.clock.t += 5500;
    await h.poller.tick();
    expect(h.store.get(record.id)?.state.status).toBe("swapping");
    h.clock.t = Date.parse(record.deadline) + GIVE_UP_AFTER_DEADLINE_MS + 1000;
    await h.poller.tick();
    const stopped = h.store.get(record.id)!;
    expect(stopped.state).toMatchObject({ status: "swapping", stopped: true, unfinishedAlertSent: true });
    const alerts = h.alerts.filter((a) => a.kind === "unfinished_order");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain("swapping");
    expect(alerts[0]?.text).not.toContain(record.id);
    // Years later it is still there.
    expect(isExpiredRecord(stopped, h.clock.t + 1000 * 86_400_000)).toBe(false);
    expect(h.store.deletable(h.clock.t + 1000 * 86_400_000)).toEqual([]);
  });

  it("says nothing when tracking stops on an order nobody paid", async () => {
    const { h, record } = await fresh();
    h.tap.statusReply = () => ({ ok: false, kind: "unavailable", status: 503 });
    h.clock.t = Date.parse(record.deadline) + GIVE_UP_AFTER_DEADLINE_MS + 1000;
    await h.poller.tick();
    expect(h.store.get(record.id)?.state.stopped).toBe(true);
    expect(h.alerts.filter((a) => a.kind === "unfinished_order")).toHaveLength(0);
  });

  describe("one last check before a record is deleted", () => {
    async function expired() {
      const { h, record } = await fresh();
      h.clock.t = Date.parse(record.deadline) + EXPIRE_AFTER_DEADLINE_MS + 1000;
      await h.poller.tick();
      expect(h.store.get(record.id)?.state.status).toBe("expired");
      h.clock.t = Date.parse(record.deadline) + UNFUNDED_RETENTION_MS + 1000;
      const sweep = createSweeper({ store: h.store, poller: h.poller, log: silentLogger, now: () => h.clock.t });
      return { h, record, sweep };
    }

    it("deletes a never-funded order when the provider still reports nothing", async () => {
      const { h, record, sweep } = await expired();
      expect(await h.poller.finalCheck(record.id)).toBe("gone");
      expect(await sweep()).toBe(1);
      expect(h.store.get(record.id)).toBeNull();
      // Asked in the class kept for orders with funds, which nobody can keep busy with unpaid orders.
      expect(h.tap.statusClasses.at(-1)).toBe("tracking");
    });

    it("deletes it when the provider no longer knows the address", async () => {
      const { h, record, sweep } = await expired();
      h.tap.statusReply = () => ({ ok: false, kind: "rejected", status: 404, message: "Deposit address not found" });
      expect(await sweep()).toBe(1);
      expect(h.store.get(record.id)).toBeNull();
    });

    it("keeps and follows an order when a late deposit turns out to be in progress", async () => {
      const { h, record, sweep } = await expired();
      h.tap.statusReply = answer("PROCESSING", { originChainTxHashes: [{ hash: HASH }], depositedAmount: record.amountIn });
      expect(await sweep()).toBe(0);
      const kept = h.store.get(record.id)!;
      expect(kept.state).toMatchObject({ status: "swapping", finishedAt: null, stopped: false });
      expect(h.store.openCount()).toBe(1);
      // It is tracked again, as an order with funds in it, until it ends.
      h.tap.statusClasses.length = 0;
      h.tap.statusReply = answer("SUCCESS", { originChainTxHashes: [{ hash: HASH }], destinationChainTxHashes: [{ hash: `0x${"cd".repeat(32)}` }] });
      await h.poller.tick();
      expect(h.tap.statusClasses).toEqual(["tracking"]);
      expect(h.store.get(record.id)?.state.status).toBe("delivered");
    });

    it("keeps an order that was refunded after we stopped looking, with what happened", async () => {
      const { h, record, sweep } = await expired();
      h.tap.statusReply = answer("REFUNDED", { refundedAmount: record.amountIn, refundReason: "DEADLINE_EXCEEDED" });
      expect(await sweep()).toBe(0);
      expect(h.store.get(record.id)?.state).toMatchObject({ status: "refunded", details: { refundedAmount: record.amountIn } });
    });

    it("deletes nothing while the provider cannot be asked", async () => {
      const { h, record, sweep } = await expired();
      h.tap.statusReply = () => ({ ok: false, kind: "unavailable", status: 503 });
      expect(await h.poller.finalCheck(record.id)).toBe("outage");
      expect(await sweep()).toBe(0);
      expect(h.store.get(record.id)).not.toBeNull();
      h.tap.statusReply = () => ({ ok: false, kind: "unavailable", status: null, budget: true });
      expect(await sweep()).toBe(0);
      expect(h.store.get(record.id)).not.toBeNull();
    });

    it("keeps a record the provider answers oddly about, then lets it go a week past its date", async () => {
      const { h, record, sweep } = await expired();
      // Not "not found", and not a status we understand.
      for (const reply of [{ ok: false as const, kind: "rejected" as const, status: 400, message: "Bad request" }, { ok: true as const, status: 200, data: { status: "SOMETHING_NEW" } }, { ok: true as const, status: 200, data: { status: "PENDING_DEPOSIT", quoteResponse: { quote: { depositAddress: "another" } } } }]) {
        h.tap.statusReply = () => reply;
        expect(await h.poller.finalCheck(record.id)).toBe("unclear");
        expect(await sweep()).toBe(0);
        expect(h.store.get(record.id)).not.toBeNull();
      }
      h.clock.t += UNCLEAR_GRACE_MS;
      expect(await sweep()).toBe(1);
      expect(h.store.get(record.id)).toBeNull();
    });
  });
});

describe("an under-paid order", () => {
  it("is checked at the slow rate: it only waits for its refund", async () => {
    const { h, record } = await fresh();
    h.tap.statusReply = (address) => ({ ok: true, status: 200, data: { status: "INCOMPLETE_DEPOSIT", swapDetails: {}, quoteResponse: { quote: { depositAddress: address } } } });
    h.clock.t += 5500;
    await h.poller.tick();
    expect(h.store.get(record.id)?.state.status).toBe("deposit_too_small");
    const calls = h.tap.statusClasses.length;
    // A status change normally brings the 5-second schedule back. Not here.
    for (let i = 0; i < 6; i++) {
      h.clock.t += 9000;
      await h.poller.tick();
    }
    expect(h.tap.statusClasses.length).toBe(calls);
    h.clock.t += 7000;
    await h.poller.tick();
    expect(h.tap.statusClasses.length).toBe(calls + 1);
  });
});
