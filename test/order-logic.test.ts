import { describe, expect, it } from "vitest";
import { routingOf, type OrderView } from "../shared/api.ts";
import { clockSpan, clockTime, ending, payAction, payMessage, paySecondary, payWindow, pollDelay, sendBy, startingPhase, swapTimeLeft, tabTitle, timeline, orderTitle, headingAmount } from "../web/src/lib/order-logic.ts";
import { appFeeWords, feeFree, orderDiffers, routedPrivately, routingNote } from "../web/src/lib/swap-logic.ts";

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const RECIPIENT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "A".repeat(27),
    status: "waiting",
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    statusSince: new Date(T0).toISOString(),
    pay: "manual",
    from: { id: "base:ETH", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null },
    to: { id: "sol:USDT", symbol: "USDT", name: "Tether USD", chain: "sol", decimals: 6, contract: "x" },
    amountIn: "500000000000000000",
    amountOut: "1261340512",
    minAmountOut: "1248727106",
    amountInUsd: "1265.13",
    amountOutUsd: "1260.59",
    slippageBps: 100,
    timeEstimate: 34,
    fees: { appBps: 20, providerBps: 20, appAmount: "1000000000000000", providerAmount: "1000000000000000" },
    withdrawFee: null,
    refundFee: null,
    recipient: RECIPIENT,
    refundTo: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    rewardsAddress: null,
    depositAddress: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    depositMemo: null,
    depositsOpen: true,
    deadline: new Date(T0 + 60 * 60_000).toISOString(),
    depositTxHash: null,
    depositProven: false,
    depositTxUrl: null,
    details: null,
    serverNow: new Date(T0).toISOString(),
    ...overrides,
  };
}

describe("the four steps", () => {
  const states = (o: OrderView, now = T0) => timeline(o, now).map((step) => step.state);

  it("moves through waiting, deposit seen, swapping and delivered", () => {
    expect(states(order())).toEqual(["current", "pending", "pending", "pending"]);
    expect(states(order({ status: "deposit_seen" }))).toEqual(["done", "current", "pending", "pending"]);
    expect(states(order({ status: "swapping" }))).toEqual(["done", "done", "current", "pending"]);
    expect(states(order({ status: "delivered" }))).toEqual(["done", "done", "done", "done"]);
  });

  it("keeps the steps an order completed when it ends another way", () => {
    // The step it stopped at is "stopped", never "current": nothing is still running.
    expect(states(order({ status: "expired" }))).toEqual(["stopped", "pending", "pending", "pending"]);
    expect(states(order({ status: "deposit_too_small" }))).toEqual(["done", "stopped", "pending", "pending"]);
    expect(states(order({ status: "refunded" }))).toEqual(["done", "done", "stopped", "pending"]);
    expect(states(order({ status: "failed" }))).toEqual(["done", "done", "stopped", "pending"]);
    for (const status of ["expired", "deposit_too_small", "refunded", "failed", "delivered"] as const) expect(states(order({ status })), status).not.toContain("current");
  });

  it("says the set sentence at each step, with the exact amount and the chain's coin", () => {
    const first = timeline(order(), T0)[0]!;
    expect(first.title).toBe("Waiting for deposit");
    expect(first.text).toMatch(/^Send 0\.5 ETH before \d\d:\d\d\.$/);
    expect(timeline(order({ status: "deposit_seen" }), T0)[1]!.text).toBe("Deposit found. Waiting for confirmations.");
    expect(timeline(order({ status: "swapping" }), T0)[2]!.text).toBe("Swapping. About 1 min left.");
    expect(timeline(order({ status: "delivered" }), T0)[3]!.text).toBe("1,261.340512 USDT sent to 7xKXtg…osgAsU.");
  });

  it("stops asking for the deposit once deposits are closed, two minutes before the deadline", () => {
    const waiting = order();
    const deadline = Date.parse(waiting.deadline);
    expect(timeline(waiting, deadline - 2 * 60_000 - 1)[0]!.text).toMatch(/^Send 0\.5 ETH before \d\d:\d\d\.$/);
    expect(timeline(waiting, deadline - 2 * 60_000)[0]!.text).toBe("Deposits are closed. Checking whether one arrived.");
    expect(timeline(waiting, deadline - 1)[0]!.text).toBe("Deposits are closed. Checking whether one arrived.");
    // Once the order has expired, the step says what happened.
    expect(timeline(order({ status: "expired" }), deadline + 1)[0]!.text).toBe("No deposit arrived before the deadline.");
  });

  it("gives an order's title the exact amount where it is short, and no amount at all where it is not", () => {
    expect(orderTitle(order())).toBe("0.5 ETH to USDT");
    // Twelve characters is the most that stays on the title's line on a phone.
    expect(orderTitle(order({ amountIn: "123456789100000000" }))).toBe("0.1234567891 ETH to USDT");
    expect(orderTitle(order({ amountIn: "123456789120000000" }))).toBe("ETH to USDT");
    // All eighteen decimals: the amount is left out, never rounded. A rounded amount to pay would read as
    // exact, and someone sending by hand could type it and pay too little.
    const long = orderTitle(order({ amountIn: "999999999999999999" }));
    expect(long).toBe("ETH to USDT");
    expect(long).not.toMatch(/\d/);
    // The same rule for a row of the recent-orders list, which holds less than a whole order.
    expect(orderTitle({ amountIn: "500000000000000000", from: { symbol: "ETH", decimals: 18 }, to: { symbol: "USDT" } })).toBe("0.5 ETH to USDT");
    expect(headingAmount("500000000000000000", 18)).toBe("0.5");
    expect(headingAmount("1261340512", 6)).toBe("1,261.340512");
    expect(headingAmount("999999999999999999", 18)).toBeNull();
    expect(headingAmount("12613405120000", 6)).toBeNull();
  });

  it("uses what really arrived, when the provider reports it", () => {
    const done = order({ status: "delivered", details: { originTxs: [], destinationTxs: [], depositedAmount: null, amountIn: null, amountOut: "1262000000", refundedAmount: null, refundReason: null } });
    expect(timeline(done, T0)[3]!.text).toBe("1,262 USDT sent to 7xKXtg…osgAsU.");
  });

  it("says so when a swap runs past twice its estimate", () => {
    const swapping = order({ status: "swapping", timeEstimate: 120 });
    expect(swapTimeLeft(swapping, T0)).toBe("about 2 min");
    expect(swapTimeLeft(swapping, T0 + 90_000)).toBe("about 1 min");
    // Past the estimate but not yet twice it: still "about 1 min", never zero and never seconds.
    expect(swapTimeLeft(swapping, T0 + 200_000)).toBe("about 1 min");
    expect(swapTimeLeft(swapping, T0 + 241_000)).toBeNull();
    expect(timeline(swapping, T0 + 241_000)[2]!.text).toBe("Taking longer than usual. If the swap fails, the provider refunds you automatically.");
    // A very short estimate is treated as a minute, so the warning does not come after a few seconds.
    expect(swapTimeLeft(order({ status: "swapping", timeEstimate: 5 }), T0 + 100_000)).toBe("about 1 min");
  });
});

describe("how an order ended", () => {
  const details = (extra: object) => ({ originTxs: [], destinationTxs: [], depositedAmount: null, amountIn: null, amountOut: null, refundedAmount: null, refundReason: null, ...extra });

  it("has no ending while it is running", () => {
    for (const status of ["waiting", "deposit_seen", "swapping"] as const) expect(ending(order({ status }))).toBeNull();
  });

  it("delivered: the exact amount, the chain, and Swap again", () => {
    expect(ending(order({ status: "delivered" }))).toEqual({ headline: "Delivered", cause: "1,261.340512 USDT was sent to your Solana address.", action: "swap-again", tone: "good" });
  });

  it("refunded: the amount, where it went, and why in plain words", () => {
    const refunded = ending(order({ status: "refunded", details: details({ refundedAmount: "499000000000000000", refundReason: "SLIPPAGE_EXCEEDED" }) }));
    expect(refunded).toEqual({ headline: "Refunded", cause: "The price moved beyond the limit you accepted. 0.499 ETH was returned to your refund address, 0xd8dA…A96045, on Base.", action: "swap-again", tone: "plain" });
    // A reason we do not know is never shown as the provider wrote it.
    const unknown = ending(order({ status: "refunded", details: details({ refundReason: "SOME_NEW_CODE" }) }));
    expect(unknown?.cause).toBe("The swap could not be completed. Your ETH was returned to your refund address, 0xd8dA…A96045, on Base.");
    expect(JSON.stringify(unknown)).not.toContain("SOME_NEW_CODE");
  });

  it("deposit too small: what arrived, and what happens next", () => {
    const small = ending(order({ status: "deposit_too_small", details: details({ depositedAmount: "250000000000000000" }) }));
    expect(small).toEqual({ headline: "Deposit too small", cause: "0.25 of 0.5 ETH arrived. It is returned to your refund address by the deadline. Nothing more needs sending.", action: "copy-link", tone: "attention" });
  });

  it("failed and expired: what to keep and who to contact", () => {
    expect(ending(order({ status: "failed" }))).toMatchObject({ headline: "Swap failed", action: "contact" });
    expect(ending(order({ status: "expired" }))).toMatchObject({ headline: "Expired", action: "swap-again" });
    // What to keep is the hash AND the order's link (support asks for the order), in every branch.
    expect(ending(order({ status: "expired" }))?.cause).toBe("No deposit arrived before the deadline. If you did send coins, keep the transaction hash and this page's link, and contact support.");
    expect(ending(order({ status: "expired", depositTxHash: "0xabc" }))).toMatchObject({ action: "contact" });
    // Where no contact is published, nobody is told to "contact support": the sentence says what to keep, and stops.
    expect(ending(order({ status: "failed" }), false)?.cause).toBe("The swap could not be completed. Keep this page's link and your deposit transaction hash.");
    expect(ending(order({ status: "expired" }), false)?.cause).toBe("No deposit arrived before the deadline. If you did send coins, keep the transaction hash and this page's link.");
    expect(ending(order({ status: "expired", depositTxHash: "0xabc" }), false)?.cause).toBe("No deposit was confirmed before the deadline. Keep this page's link and your deposit transaction hash.");
    for (const status of ["failed", "expired"] as const) expect(ending(order({ status }), false)?.cause).not.toMatch(/support/i);
    expect(ending(order({ status: "failed" }), true)?.cause).toBe("The swap could not be completed. Keep this page's link and your deposit transaction hash, and contact support.");
  });

  it("puts the ending in the tab's title", () => {
    expect(tabTitle(order({ status: "delivered" }))).toBe("Delivered · IntentSwap");
    expect(tabTitle(order({ status: "refunded" }))).toBe("Refunded · IntentSwap");
    expect(tabTitle(order())).toBe("Order · IntentSwap");
    expect(tabTitle(null)).toBe("Order · IntentSwap");
  });
});

describe("looking again", () => {
  it("asks every 5 seconds while an order is running, slowly when it only waits for a refund, and never once it has ended", () => {
    expect(pollDelay("waiting", 0)).toBe(5000);
    expect(pollDelay("deposit_seen", 0)).toBe(5000);
    expect(pollDelay("swapping", 0)).toBe(5000);
    expect(pollDelay("deposit_too_small", 0)).toBe(30_000);
    for (const status of ["delivered", "refunded", "failed", "expired"] as const) expect(pollDelay(status, 0)).toBeNull();
  });

  it("backs off while the connection is down", () => {
    expect([1, 2, 3, 4, 9].map((failures) => pollDelay("swapping", failures))).toEqual([5000, 10_000, 20_000, 30_000, 30_000]);
  });
});

describe("time", () => {
  it("writes a span as minutes and seconds, with hours when needed", () => {
    expect(clockSpan(0)).toBe("0:00");
    expect(clockSpan(59_999)).toBe("0:59");
    expect(clockSpan(29 * 60_000 + 41_000)).toBe("29:41");
    expect(clockSpan(62 * 60_000 + 10_000)).toBe("1:02:10");
    expect(clockSpan(-5000)).toBe("0:00");
  });

  it("knows how long is left to pay, and when the details are no longer on show", () => {
    // What a person is shown is the time left to send: it runs out two minutes before the deadline does.
    expect(payWindow(order(), T0)).toEqual({ left: 3_600_000, toSend: 3_480_000, open: true });
    expect(payWindow(order({ depositsOpen: false }), T0)).toEqual({ left: 3_600_000, toSend: 3_480_000, open: false });
    expect(payWindow(order(), T0 + 3_700_000)).toEqual({ left: 0, toSend: 0, open: false });
    // Two minutes before the deadline the details go, whatever the server last said; the time to send reaches nought at that same moment.
    expect(payWindow(order(), T0 + 3_600_000 - 120_001)).toEqual({ left: 120_001, toSend: 1, open: true });
    expect(payWindow(order(), T0 + 3_600_000 - 120_000)).toEqual({ left: 120_000, toSend: 0, open: false });
    expect(sendBy(order())).toBe(T0 + 3_600_000 - 120_000);
  });

  it("names the time to send by, never the deadline itself, in the first step", () => {
    const waiting = order();
    const named = /before (\d\d:\d\d)\.$/.exec(timeline(waiting, T0)[0]!.text)?.[1];
    expect(named).toBe(clockTime(sendBy(waiting)));
    expect(named).not.toBe(clockTime(Date.parse(waiting.deadline)));
  });
});

describe("the pay button on an order paid from a wallet", () => {
  const base = { phase: "idle" as const, connected: true, walletChain: "base", order: order(), balance: 10n ** 18n, left: 30 * 60_000 };
  it("is always the next step, or the reason nothing can happen", () => {
    expect(payAction({ ...base, connected: false, walletChain: null })).toEqual({ kind: "connect", label: "Connect wallet", disabled: false, busy: false });
    expect(payAction({ ...base, walletChain: "eth" })).toEqual({ kind: "switch", label: "Switch to Base", disabled: false, busy: false });
    expect(payAction({ ...base, walletChain: null })).toMatchObject({ kind: "switch", label: "Switch to Base" });
    expect(payAction({ ...base, balance: 499999999999999999n })).toEqual({ kind: "none", label: "Not enough ETH", disabled: true, busy: false });
    expect(payAction(base)).toEqual({ kind: "send", label: "Send 0.5 ETH", disabled: false, busy: false });
    // The button repeats the exact amount where it fits on one line of a phone. An 18-decimal amount does not:
    // the button then names the coin, and the amount stays in the row above it and in the wallet's own prompt.
    const long = { ...base, order: order({ amountIn: "123456789012345678" }) };
    expect(payAction(long)).toEqual({ kind: "send", label: "Send ETH", disabled: false, busy: false });
    expect(payAction({ ...base, order: order({ amountIn: "123456789000000000" }) }).label).toBe("Send 0.123456789 ETH");
    for (const amountIn of ["1", "500000000000000000", "123456789012345678", "999999999999999999999"]) expect(payAction({ ...base, balance: 10n ** 30n, order: order({ amountIn }) }).label.length).toBeLessThanOrEqual(22);
    // The balance may not be known yet: the wallet itself will refuse a transfer it cannot afford.
    expect(payAction({ ...base, balance: null }).kind).toBe("send");
    // Exactly enough is enough.
    expect(payAction({ ...base, balance: 500000000000000000n }).kind).toBe("send");
  });
  it("says what the wallet is doing while it is doing it, and cannot be pressed twice", () => {
    expect(payAction({ ...base, phase: "asking" })).toEqual({ kind: "none", label: "Confirm in wallet…", disabled: true, busy: true });
    expect(payAction({ ...base, phase: "sent" })).toEqual({ kind: "none", label: "Sending…", disabled: true, busy: true });
  });
  it("does not open the wallet with less than five minutes left", () => {
    expect(payAction({ ...base, left: 5 * 60_000 - 1 })).toEqual({ kind: "none", label: "Too close to the deadline", disabled: true, busy: false });
    expect(payAction({ ...base, left: 5 * 60_000 }).kind).toBe("send");
  });
  it("offers another try after a cancelled or failed attempt", () => {
    for (const phase of ["rejected", "failed"] as const) expect(payAction({ ...base, phase })).toEqual({ kind: "send", label: "Send 0.5 ETH", disabled: false, busy: false });
  });
  it("does not offer Send on the main button after a replacement: that takes a separate, deliberate press", () => {
    expect(payAction({ ...base, phase: "replaced" })).toEqual({ kind: "none", label: "Transfer replaced", disabled: true, busy: false });
    expect(paySecondary("replaced", 0)).toBe("I cancelled it. Send again");
    expect(payAction({ ...base, phase: "again" })).toEqual({ kind: "send", label: "Send 0.5 ETH", disabled: false, busy: false });
    expect(payMessage("again", "Base", 0)?.tone).toBe("attention");
    expect(payMessage("again", "Base", 0)?.text).toContain("only if your wallet shows that no transfer for this order is on its way");
  });
  it("offers a way out of a transfer that never confirms, but not in its first minute", () => {
    expect(paySecondary("sent", 60_000)).toBeNull();
    expect(paySecondary("sent", 60_001)).toBe("My wallet shows it failed or was cancelled");
    for (const phase of ["idle", "asking", "rejected", "failed", "again"] as const) expect(paySecondary(phase, 600_000), phase).toBeNull();
  });
  it("does not offer Send afresh after a reload that happened while the wallet was being asked", () => {
    // What the wallet did is not known: it may have sent. Sending takes the separate step, as after a replacement.
    expect(startingPhase({ depositTxHash: null }, true)).toBe("unsure");
    expect(startingPhase({ depositTxHash: `0x${"ab".repeat(32)}` }, true)).toBe("unsure");
    expect(payAction({ ...base, phase: "unsure" })).toEqual({ kind: "none", label: "Check your wallet", disabled: true, busy: false });
    expect(payAction({ ...base, phase: "unsure", connected: false, walletChain: null }).kind).toBe("none");
    expect(paySecondary("unsure", 0)).toBe("I did not confirm it. Send now");
    expect(payMessage("unsure", "Base", 0)).toMatchObject({ tone: "attention" });
    expect(payMessage("unsure", "Base", 0)?.text).toContain("If you did not, nothing was sent.");
  });
  it("starts from 'sent' when the order already carries a transaction hash, so a reload never offers Send afresh", () => {
    expect(startingPhase({ depositTxHash: null })).toBe("idle");
    expect(startingPhase({ depositTxHash: `0x${"ab".repeat(32)}` })).toBe("sent");
    expect(payAction({ ...base, phase: startingPhase({ depositTxHash: `0x${"ab".repeat(32)}` }) }).kind).toBe("none");
    // Even with no wallet connected: following a transfer needs none.
    expect(payAction({ ...base, phase: "sent", connected: false, walletChain: null })).toEqual({ kind: "none", label: "Sending…", disabled: true, busy: true });
  });
  it("states plainly what happened to an attempt", () => {
    expect(payMessage("rejected", "Base", 0)).toEqual({ text: "You cancelled in your wallet. Nothing was sent.", tone: "plain" });
    expect(payMessage("replaced", "Base", 0)?.text).toContain("If you cancelled it, nothing left your wallet.");
    expect(payMessage("sent", "BNB Chain", 30_000)?.text).toBe("Sent. Waiting for it to be confirmed.");
    expect(payMessage("sent", "BNB Chain", 61_000)?.text).toBe("Still confirming on BNB Chain.");
    expect(payMessage("failed", "Base", 0)?.tone).toBe("attention");
    expect(payMessage("idle", "Base", 0)).toBeNull();
  });
});

describe("how an order's page says it was routed", () => {
  const PRIVATELY = routingOf("basic");
  const IN_PUBLIC = routingOf("public");
  const noAppFee = { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "1000000000000000" };
  // An order as the server kept it before routing was kept: the field is not there at all.
  const old = order();
  const inPublic = order({ routing: IN_PUBLIC });
  // A private order made where the server is set to take a fee, and one as orders are made unless it is: with no fee of IntentSwap's.
  const privately = order({ routing: PRIVATELY });
  const unpaid = order({ routing: PRIVATELY, fees: noAppFee });

  it("an order with no routing field at all is public", () => {
    expect("routing" in old).toBe(false);
    expect(routedPrivately(old)).toBe(false);
    expect(routedPrivately(inPublic)).toBe(false);
    expect(routedPrivately(privately)).toBe(true);
  });

  it("where the server routes in public, a public order's page says nothing of routing: no tag, no row", () => {
    for (const mode of ["public", null] as const) {
      expect(routingNote(mode, old)).toBeNull();
      expect(routingNote(mode, inPublic)).toBeNull();
    }
  });

  it("an order made with private routing says so, with the tag, whatever the server's setting is now", () => {
    for (const mode of ["basic", "public", null] as const) expect(routingNote(mode, privately), String(mode)).toEqual({ private: true, text: "Private" });
  });

  it("where the server routes privately, a public order's details say that it was public, and it wears no tag", () => {
    expect(routingNote("basic", inPublic)).toEqual({ private: false, text: "Public" });
    expect(routingNote("basic", old)).toEqual({ private: false, text: "Public" });
  });

  it("a private order's fee row and points read as a public order's do, and an order with no IntentSwap fee says so", () => {
    for (const paid of [old, inPublic, privately]) {
      expect(appFeeWords(paid)).toBeNull();
      expect(feeFree(paid)).toBe(false);
    }
    expect(privately.fees.appBps).toBeGreaterThan(0);
    expect(appFeeWords(unpaid)).toBe("None");
    expect(feeFree(unpaid)).toBe(true);
  });

  it("is the order that was reviewed only when it was made by the route that was on screen", () => {
    const reviewed = (o: OrderView, routing?: OrderView["routing"]) => ({ from: o.from.id, to: o.to.id, amountIn: o.amountIn, minAmountOut: o.minAmountOut, slippageBps: o.slippageBps, recipient: o.recipient, refundTo: o.refundTo, rewardsAddress: o.rewardsAddress, ...(routing !== undefined ? { routing } : {}) });
    expect(orderDiffers(privately, reviewed(privately, PRIVATELY))).toBeNull();
    expect(orderDiffers(inPublic, reviewed(inPublic, IN_PUBLIC))).toBeNull();
    expect(orderDiffers(inPublic, reviewed(inPublic, PRIVATELY))).toBe("the routing");
    expect(orderDiffers(old, reviewed(old, PRIVATELY))).toBe("the routing");
    expect(orderDiffers(privately, reviewed(privately, IN_PUBLIC))).toBe("the routing");
    expect(orderDiffers(privately, reviewed(privately))).toBe("the routing");
  });
});
