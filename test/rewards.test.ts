import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signInHost } from "../server/app.ts";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { briefPoints, isSignInMessage, MICRO, minPayoutFor, nextWeek, pointsMicro, poolShare, RESERVE_ASSET, roundedPoints, REWARDS, sharePool, showPoints, SIGN_IN_STATEMENT, signInMessage, swapPointsMicro, usdToMicro, weekBounds, weekOf, type RewardsPublic, type RewardsView } from "../shared/rewards.ts";
import { silentLogger } from "../server/log.ts";
import { createRewards, createSignIn, entryFor, orderHash, QUARTER_MS, rewardsAddressOf, type PointsEntry, type Rewards, type WeekRecord } from "../server/rewards.ts";
import { checkPayoutTx, exportWeek, poolAmount, recordPayouts, reserveHolds, rewardTokenDecimals, weekCsv } from "../server/rewards-tools.ts";
import { createSanctions, createStaticSanctions } from "../server/sanctions.ts";
import type { OrderRecord } from "../server/store.ts";
import { ESTIMATE_NOTE, shareText, usdMicroText, usdText } from "../web/src/lib/rewards-logic.ts";
import RewardsPage from "../web/src/pages/RewardsPage.tsx";
import { useRewards } from "../web/src/stores/rewards.ts";
import { ADDR, asOrder, ASSET, createFakeRpc, eventually, FIXTURE_TOKENS, harness, putMined, transferLog, type FakeRpc, type Harness, type HarnessOptions } from "./helpers.ts";

// The wallet the Rewards page would open to have its one message signed. Here it is a stand-in
// that writes down what it was asked to sign, and signs it or refuses as a test tells it to.
const walletAsked = vi.hoisted(() => ({ messages: [] as string[], sign: null as ((message: string) => Promise<string>) | null }));
vi.mock("../web/src/wallet/sign-in.ts", () => ({
  signPlainMessage: async (message: string) => {
    walletAsked.messages.push(message);
    // A refusal as a wallet answers one: the code every wallet uses for "the person said no".
    if (walletAsked.sign === null) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    return walletAsked.sign(message);
  },
}));

// Wallets for these tests, made from fixed text so that they are nobody's. Their keys guard nothing.
const wallet = (label: string) => privateKeyToAccount(`0x${createHash("sha256").update(`intentswap test wallet ${label}`).digest("hex")}`);
const ALICE = wallet("alice");
const BOB = wallet("bob");

let open: Harness[] = [];
let dirs: string[] = [];
async function start(options?: HarnessOptions): Promise<Harness> {
  const h = await harness(options);
  open.push(h);
  return h;
}
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-rewards-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(open.map((h) => h.close()));
  open = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
const MONDAY = Date.parse("2026-10-05T00:00:00.000Z");

describe("the rules for points, as numbers", () => {
  it("are the ones the site states", () => {
    expect(REWARDS).toEqual({ pointsPerUsd: 10, sessionMinutes: 30, nonceMinutes: 5, chain: "bsc", chainId: 56, holderBoostBps: 0 });
    // Rewards are paid in NEAR on BNB Chain: the Binance-Peg NEAR token there, written in its checksum spelling.
    expect(RESERVE_ASSET).toEqual({ chain: "bsc", symbol: "NEAR", name: "NEAR", decimals: 18, contract: getAddress("0x1fa4a73a3f0133f0025378af00236f3abdee5d63"), minPayout: 10n ** 14n });
    expect(minPayoutFor(18)).toBe(RESERVE_ASSET.minPayout);
    expect([minPayoutFor(6), minPayoutFor(4), minPayoutFor(0)]).toEqual([100n, 1n, 1n]);
  });

  it.each([
    // One point for every 10 cents: ten points to the dollar, in millionths of a point.
    ["1", 10_000_000n],
    ["0.10", 1_000_000n],
    ["12.34", 123_400_000n],
    ["1265.13", 12_651_300_000n],
    ["0.99", 9_900_000n],
    ["1000000", 10_000_000_000_000n],
    // Below a millionth of a dollar there is nothing to count: rounded down, never up.
    ["0.000001", 10n],
    ["0.0000009", 0n],
    ["0", 0n],
  ])("a swap of $%s adds %s millionths of a point", (paid, expected) => {
    expect(swapPointsMicro(paid)).toBe(expected);
    expect(pointsMicro(usdToMicro(paid)!)).toBe(expected);
  });

  it.each([[undefined], [null], [""], ["1e3"], ["-5"], ["12.5.1"], ["12,5"], [1234], ["NaN"], ["1".repeat(41)]])("no dollar value (%s) gives no points, not a guess", (paid) => {
    expect(usdToMicro(paid)).toBeNull();
    expect(swapPointsMicro(paid)).toBeNull();
  });

  it("gives ten points for each dollar, and shows them rounded down", () => {
    expect(pointsMicro(usd(1))).toBe(10n * MICRO);
    expect(pointsMicro(usd(0.1))).toBe(MICRO);
    expect(showPoints(pointsMicro(usd(123.456789)))).toBe("1,234.56");
    expect(showPoints(999_999n)).toBe("0.99");
    expect(showPoints(0n)).toBe("0.00");
    expect(showPoints(-5n)).toBe("0.00");
    expect(showPoints(1_234_567_890_000n)).toBe("1,234,567.89");
  });
});

describe("a wallet's share of the week's pool", () => {
  const NEAR = 10n ** 18n;
  /** A pool of so much NEAR (in its smallest unit), worth so many dollars, or with no price. */
  const pool = (amount: bigint, dollars: number | null) => ({ amount, usdMicro: dollars === null ? null : usd(dollars) });

  it("is its points out of everyone's, in hundredths of a percent, and that part of the pool in NEAR, with its dollars beside it, all rounded down", () => {
    // 250 points of 1,000, and a pool of 49.3824 NEAR worth $1,234.56: a quarter of it, 12.3456 NEAR, about $308.64.
    expect(poolShare(250n * MICRO, 1000n * MICRO, pool(493_824n * 10n ** 14n, 1234.56))).toEqual({ shareBps: 2500n, estimate: 123_456n * 10n ** 14n, estimateCents: 30_864n });
    // 1 point of 100 is 1%.
    expect(poolShare(MICRO, 100n * MICRO, pool(500n * NEAR, 2400))).toEqual({ shareBps: 100n, estimate: 5n * NEAR, estimateCents: 2400n });
    expect(shareText(poolShare(MICRO, 100n * MICRO, null).shareBps)).toBe("1.00%");
    // Rounded down, never up, to the coin's smallest unit and to the cent.
    expect(poolShare(1n, 3n, pool(100n, 100))).toEqual({ shareBps: 3333n, estimate: 33n, estimateCents: 3300n });
    expect(poolShare(2n, 3n, pool(NEAR, 0.05))).toEqual({ shareBps: 6666n, estimate: 666_600_000_000_000_000n, estimateCents: 3n });
    // All of it.
    expect(poolShare(7n, 7n, pool(42n * NEAR, 42.42))).toEqual({ shareBps: 10_000n, estimate: 42n * NEAR, estimateCents: 4242n });
  });

  it("works the estimate out from the share as it is shown, two decimals and no finer, and prices that estimate", () => {
    // A third of 1,000 NEAR worth $4,800. The share is 33.33%, so the estimate is 333.3 NEAR, not 333.333…, and its dollars are that amount's: $1,599.84.
    expect(poolShare(1n, 3n, pool(1000n * NEAR, 4800))).toEqual({ shareBps: 3333n, estimate: 3333n * NEAR / 10n, estimateCents: 159_984n });
    // Two totals that give the same share to two decimals give the same estimate to the last unit: the estimate says no more of the total than the share does.
    const one = poolShare(100_000n * MICRO, 300_000n * MICRO, pool(1000n * NEAR, 4800));
    const other = poolShare(100_000n * MICRO, 300_029n * MICRO, pool(1000n * NEAR, 4800));
    expect(other).toEqual(one);
    expect(one.estimate).toBe((1000n * NEAR * one.shareBps) / 10_000n);
  });

  it("is nothing while nobody has points, and nothing for an address with none", () => {
    const nothing = { shareBps: 0n, estimate: 0n, estimateCents: 0n };
    expect(poolShare(0n, 0n, pool(100n * NEAR, 100))).toEqual(nothing);
    // A total of nothing divides nothing, whatever an address is said to hold.
    expect(poolShare(5n * MICRO, 0n, pool(100n * NEAR, 100))).toEqual(nothing);
    expect(poolShare(0n, 100n * MICRO, pool(100n * NEAR, 100))).toEqual(nothing);
    expect(poolShare(-1n, 100n, pool(100n * NEAR, 100))).toEqual(nothing);
  });

  it("is never more than all of it: points read a moment after the total do not count for more than 100%", () => {
    expect(poolShare(150n, 100n, pool(100n * NEAR, 100))).toEqual({ shareBps: 10_000n, estimate: 100n * NEAR, estimateCents: 10_000n });
  });

  it("has no estimate while the pool is not known, and a figure in NEAR with no dollars where there is no price", () => {
    expect(poolShare(25n, 100n, null)).toEqual({ shareBps: 2500n, estimate: 0n, estimateCents: null });
    expect(poolShare(0n, 0n, null)).toEqual({ shareBps: 0n, estimate: 0n, estimateCents: null });
    expect(poolShare(25n, 100n, pool(0n, 0))).toEqual({ shareBps: 2500n, estimate: 0n, estimateCents: 0n });
    // No price for the coin just now: the estimate in NEAR is there, and nothing is said in dollars.
    expect(poolShare(25n, 100n, pool(80n * NEAR, null))).toEqual({ shareBps: 2500n, estimate: 20n * NEAR, estimateCents: null });
    expect(poolShare(0n, 100n, pool(80n * NEAR, null))).toEqual({ shareBps: 0n, estimate: 0n, estimateCents: null });
  });

  it("is written with two decimals, and dollars with their cents", () => {
    expect([shareText(100n), shareText(2500n), shareText(10_000n), shareText(7n), shareText(0n)]).toEqual(["1.00%", "25.00%", "100.00%", "0.07%", "0.00%"]);
    expect([usdText(1234n), usdText(123_456_789n), usdText(5n), usdText(0n)]).toEqual(["$12.34", "$1,234,567.89", "$0.05", "$0.00"]);
    // Millionths of a dollar are rounded down to the cent.
    expect([usdMicroText(52_275_000_000n), usdMicroText(1_999_999n), usdMicroText(9_999n)]).toEqual(["$52,275.00", "$1.99", "$0.00"]);
  });
});

describe("the week", () => {
  it.each([
    ["2026-10-05T00:00:00.000Z", "2026-W41"],
    ["2026-10-04T23:59:59.999Z", "2026-W40"],
    ["2026-10-11T23:59:59.999Z", "2026-W41"],
    ["2026-10-12T00:00:00.000Z", "2026-W42"],
    // The turn of a year: a week belongs to the year its Thursday is in.
    ["2026-12-31T12:00:00.000Z", "2026-W53"],
    ["2027-01-03T23:59:59.999Z", "2026-W53"],
    ["2027-01-04T00:00:00.000Z", "2027-W01"],
    ["2024-12-30T00:00:00.000Z", "2025-W01"],
    ["2021-01-03T12:00:00.000Z", "2020-W53"],
    ["1970-01-01T00:00:00.000Z", "1970-W01"],
  ])("%s is in week %s", (moment, week) => {
    expect(weekOf(Date.parse(moment))).toBe(week);
  });

  it("runs from Monday 00:00 UTC to the Monday after", () => {
    expect(weekBounds("2026-W41")).toEqual({ start: MONDAY, end: MONDAY + 7 * 86_400_000 });
    expect(new Date(MONDAY).getUTCDay()).toBe(1);
    expect(nextWeek("2026-W41")).toBe("2026-W42");
    expect(nextWeek("2026-W53")).toBe("2027-W01");
    // A year of 52 weeks has no 53rd.
    for (const bad of ["2025-W53", "2026-W00", "2026-W54", "2026-41", "W41", "2026-W4", ""]) expect(weekBounds(bad), bad).toBeNull();
  });

  it("every moment of a week is in that week, and the moment after it is in the next", () => {
    for (const week of ["2026-W01", "2026-W41", "2026-W53", "2027-W01", "2032-W53"]) {
      const bounds = weekBounds(week)!;
      for (const at of [bounds.start, bounds.start + 1, bounds.end - 1]) expect(weekOf(at), week).toBe(week);
      expect(weekOf(bounds.end), week).toBe(nextWeek(week));
      expect(weekOf(bounds.start - 1)).not.toBe(week);
    }
  });
});

describe("sharing a pool out by points", () => {
  const A = "0x00000000000000000000000000000000000000Aa";
  const B = "0x00000000000000000000000000000000000000bB";
  const C = "0x00000000000000000000000000000000000000Cc";

  it("rounds every share down and leaves the rest in the reserve: what is paid and what is left are exactly the pool", () => {
    const result = sharePool(1000n, new Map([[A, 1n], [B, 1n], [C, 1n]]), 0n);
    expect(result.shares.map((share) => share.payout)).toEqual([333n, 333n, 333n]);
    expect(result).toMatchObject({ paid: 999n, left: 1n, totalPoints: 3n });
    for (const [pool, points] of [
      [10n ** 18n, [7n, 11n, 13n]],
      [12_345_678_901_234_567_890n, [1n, 999_999_999n, 5n]],
      [1n, [5n, 5n, 5n]],
      [0n, [1n, 2n, 3n]],
    ] as const) {
      const shared = sharePool(pool, new Map([[A, points[0]], [B, points[1]], [C, points[2]]]), 0n);
      expect(shared.paid + shared.left).toBe(pool);
      expect(shared.shares.reduce((sum, share) => sum + share.payout, 0n)).toBe(shared.paid);
      expect(shared.left >= 0n).toBe(true);
    }
  });

  it("sends nothing under the smallest payout, and carries those points forward instead", () => {
    const result = sharePool(1000n, new Map([[A, 98n], [B, 1n], [C, 1n]]), 50n);
    expect(result.shares).toEqual([
      { address: A, points: 98n, payout: 980n, carried: 0n },
      { address: B, points: 1n, payout: 0n, carried: 1n },
      { address: C, points: 1n, payout: 0n, carried: 1n },
    ]);
    expect(result).toMatchObject({ paid: 980n, left: 20n });
  });

  it("gives the same shares, in the same order, however the points were handed in", () => {
    const one = sharePool(10n ** 18n, new Map([[C, 3n], [A, 1n], [B, 2n]]), 1n);
    const two = sharePool(10n ** 18n, new Map([[B, 2n], [C, 3n], [A, 1n]]), 1n);
    expect(one).toEqual(two);
    expect(one.shares.map((share) => share.address)).toEqual([A, B, C]);
  });

  it("leaves out an address with no points, shares nothing when nobody has any, and refuses a pool under nothing", () => {
    expect(sharePool(100n, new Map([[A, 0n], [B, 5n]]), 0n).shares.map((share) => share.address)).toEqual([B]);
    expect(sharePool(100n, new Map(), 0n)).toMatchObject({ shares: [], paid: 0n, left: 100n, totalPoints: 0n });
    expect(() => sharePool(-1n, new Map([[A, 1n]]), 0n)).toThrow();
  });
});

/** A stored order, with only what the points record reads. */
function stored(overrides: Partial<OrderRecord> & { status?: string; finishedAt?: string | null } = {}): OrderRecord {
  const { status = "delivered", finishedAt = new Date(MONDAY + 3_600_000).toISOString(), ...rest } = overrides;
  return {
    v: 1,
    id: "A".repeat(27),
    createdAt: new Date(MONDAY).toISOString(),
    pay: "wallet",
    from: { id: "base:ETH", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null },
    to: { id: "sol:USDT", symbol: "USDT", name: "Tether", chain: "sol", decimals: 6, contract: "x" },
    amountIn: "500000000000000000",
    amountOut: "1",
    minAmountOut: "1",
    amountInUsd: "25.00",
    amountOutUsd: "24.95",
    slippageBps: 100,
    timeEstimate: 30,
    fees: { appBps: 20, appAmount: "1", providerBps: 20, providerAmount: "1" },
    withdrawFee: null,
    refundFee: null,
    recipient: "r",
    refundTo: "f",
    sender: ALICE.address,
    rewardsAddress: ALICE.address,
    depositAddress: "0xae001C67DbdC649e76BD8f41A75D1D154423D8aD",
    depositMemo: null,
    deadline: new Date(MONDAY + 1_800_000).toISOString(),
    termsVersion: "t",
    screening: { result: "clear", listVersion: "v", checkedAt: new Date(MONDAY).toISOString() },
    quoteResponse: null,
    state: { status, upstreamStatus: "SUCCESS", statusSince: finishedAt ?? new Date(MONDAY).toISOString(), updatedAt: finishedAt ?? new Date(MONDAY).toISOString(), anchor: MONDAY, depositTxHash: null, depositForwarded: false, details: null, finishedAt, stopped: false, slowAlertSent: false },
    ...rest,
  } as OrderRecord;
}

describe("what a swap adds", () => {
  it("is counted from the dollar value of a delivered order: 10 points for each dollar that was paid", () => {
    const entry = entryFor(stored())!;
    // $25 paid: 250 points.
    expect(entry).toEqual({ v: 2, order: orderHash("A".repeat(27)), address: ALICE.address, week: "2026-W41", at: new Date(MONDAY + 3_600_000).toISOString(), volumeUsdMicro: "25000000", reasons: [], from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDT", chain: "sol" } });
    expect(pointsMicro(BigInt(entry.volumeUsdMicro))).toBe(250n * MICRO);
    // The order's own ID is not in it, nor any address but the rewards address.
    expect(JSON.stringify(entry)).not.toContain("A".repeat(27));
    // With cents: $1,265.13 is 12,651.30 points.
    expect(entryFor(stored({ amountInUsd: "1265.13" }))?.volumeUsdMicro).toBe("1265130000");
  });

  it("counts every delivered swap by its size alone: no fee, coin or route changes it", () => {
    const usual = entryFor(stored())!;
    // No fee of IntentSwap's, or one: the same points.
    for (const fees of [{ appBps: 0, appAmount: "0", providerBps: 20, providerAmount: "1" }, { appBps: 40, appAmount: "2", providerBps: 1, providerAmount: "1" }]) expect(entryFor(stored({ fees }))).toEqual(usual);
    // Two dollar coins, the same coin on another chain, a coin and its wrapped self: each counts in full.
    for (const [from, to] of [["USDC", "USDT"], ["ETH", "ETH"], ["ETH", "WETH"], ["cbBTC", "BTC"]] as const) {
      const entry = entryFor(stored({ from: { id: "a", symbol: from, name: "", chain: "base", decimals: 18, contract: null }, to: { id: "b", symbol: to, name: "", chain: "arb", decimals: 18, contract: null } }))!;
      expect(entry, `${from} to ${to}`).toMatchObject({ volumeUsdMicro: usual.volumeUsdMicro, reasons: [] });
    }
    // Routed privately or in public: the same.
    expect(entryFor(stored({ confidentiality: "basic" }))).toEqual(usual);
  });

  it.each(["waiting", "deposit_seen", "swapping", "refunded", "failed", "expired", "deposit_too_small"])("an order that is %s adds nothing", (status) => {
    expect(entryFor(stored({ status }))).toBeNull();
  });

  it("an order with no rewards address, or one that is not an address, adds nothing", () => {
    for (const rewardsAddress of [null, undefined, "", "0x1234", "not an address", ADDR.sol]) expect(entryFor(stored({ rewardsAddress: rewardsAddress as string | null })), String(rewardsAddress)).toBeNull();
    expect(rewardsAddressOf(ALICE.address.toLowerCase())).toBe(ALICE.address);
    expect(rewardsAddressOf(` ${ALICE.address} `)).toBe(ALICE.address);
    // A wrong mix of capitals is a mistyped address: one letter in the other case.
    const at = ALICE.address.search(/[a-fA-F]/);
    const letter = ALICE.address[at] ?? "";
    const mistyped = `${ALICE.address.slice(0, at)}${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}${ALICE.address.slice(at + 1)}`;
    expect(rewardsAddressOf(mistyped)).toBeNull();
  });

  it("an order the provider gave no dollar value for adds an entry of no points, which says why", () => {
    for (const amountInUsd of ["", "about 5", "1e3"]) expect(entryFor(stored({ amountInUsd })), amountInUsd).toMatchObject({ volumeUsdMicro: "0", reasons: ["no_usd_value"] });
  });

  it("belongs to the week in which it was delivered, not the one in which it was made", () => {
    expect(entryFor(stored({ createdAt: new Date(MONDAY - 60_000).toISOString(), finishedAt: new Date(MONDAY + 60_000).toISOString() }))?.week).toBe("2026-W41");
    expect(entryFor(stored({ finishedAt: new Date(MONDAY - 1).toISOString() }))?.week).toBe("2026-W40");
  });
});

describe("the points a quote is shown to add", () => {
  it("are the points the server counts for the same swap once it is delivered", () => {
    for (const amountInUsd of ["1265.13", "0.99", "250000", "12.3456789"]) {
      const entry = entryFor(stored({ amountInUsd }))!;
      expect(swapPointsMicro(amountInUsd), `$${amountInUsd}`).toBe(pointsMicro(BigInt(entry.volumeUsdMicro)));
    }
  });

  it("are written short: two decimals, rounded down, with no noughts at the end", () => {
    expect(briefPoints(12_651_300_000n)).toBe("12,651.3");
    expect(briefPoints(253_026_000n)).toBe("253.02");
    expect(briefPoints(20_000_000n)).toBe("20");
    expect(briefPoints(1_234_000_000n)).toBe("1,234");
    expect(briefPoints(250_000n)).toBe("0.25");
    expect(briefPoints(100_000n)).toBe("0.1");
    expect(briefPoints(9_999n)).toBe("0");
    expect(briefPoints(0n)).toBe("0");
  });
});

/** A sanctions list that names nobody. */
const CLEAR = createStaticSanctions([]);
const WEEK_MS = 7 * 86_400_000;
/** Every file and folder under a folder, with each file's time of writing and content: to see that nothing at all was written. */
const everything = (dir: string): string[] =>
  (fs.readdirSync(dir, { recursive: true }) as string[]).sort().map((name) => {
    const stat = fs.statSync(path.join(dir, name));
    return stat.isDirectory() ? `${name}/` : `${name} ${stat.mtimeMs}: ${fs.readFileSync(path.join(dir, name), "utf8")}`;
  });

describe("the record of points", () => {
  const end = MONDAY + WEEK_MS;
  /** Alice has 250 points and Bob 750 in week 41: a quarter and three quarters. */
  const quarters = (dir = tempDir()) => {
    const rewards = createRewards(dir);
    rewards.recordDelivered(stored());
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "75" }));
    return rewards;
  };
  const shareOf = (record: WeekRecord, who: { address: string }) => record.shares.find((share) => share.address === who.address)!;

  it("adds a delivered order once, however often it is told, and still has it after a restart", () => {
    const dir = tempDir();
    const rewards = createRewards(dir);
    const order = stored();
    expect(rewards.recordDelivered(order)).not.toBeNull();
    rewards.recordDelivered(order);
    rewards.recordDelivered({ ...order, amountInUsd: "999999" });
    expect(rewards.entriesFor(ALICE.address)).toHaveLength(1);
    expect(fs.readdirSync(path.join(dir, "rewards", "entries"))).toEqual([`${orderHash(order.id)}.json`]);
    const again = createRewards(dir);
    expect(again.entriesFor(ALICE.address.toLowerCase())).toEqual(rewards.entriesFor(ALICE.address));
    // Told once more after the restart, it is still one entry, with the value it had the first time.
    again.recordDelivered({ ...order, amountInUsd: "999999" });
    expect(again.entriesFor(ALICE.address)).toHaveLength(1);
    expect(again.entriesFor(ALICE.address)[0]?.volumeUsdMicro).toBe("25000000");
    expect(rewards.recordDelivered(stored({ status: "refunded" }))).toBeNull();
  });

  it("clears away a half-written entry that a crash left behind, and leaves alone one that is being written now", () => {
    const dir = tempDir();
    const entries = path.join(dir, "rewards", "entries");
    fs.mkdirSync(entries, { recursive: true });
    // Two temporary files of the kind a write makes on its way: one a moment old (another process is writing it), one two minutes old.
    const young = path.join(entries, `${"a".repeat(64)}.json.tmp-4321-0a1b2c3d`);
    const old = path.join(entries, `${"b".repeat(64)}.json.tmp-4322-0a1b2c3d`);
    fs.writeFileSync(young, '{"v":1');
    fs.writeFileSync(old, '{"v":1');
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    fs.utimesSync(old, twoMinutesAgo, twoMinutesAgo);
    const rewards = createRewards(dir);
    expect(fs.existsSync(young)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    // Neither is taken for an entry, and the record goes on as usual around the one that is left.
    rewards.recordDelivered(stored());
    expect(rewards.entriesFor(ALICE.address)).toHaveLength(1);
    expect(fs.readFileSync(young, "utf8")).toBe('{"v":1');
  });

  it("sums an address's week with no limit, and keeps each address's points apart", () => {
    const rewards = createRewards(tempDir());
    // Alice: three swaps of $200,000, $150,000 and $52,000 in one week. All of it counts: 4,020,000 points.
    for (const [index, paid] of ["200000", "150000", "52000"].entries()) rewards.recordDelivered(stored({ id: `${"B".repeat(26)}${index}`, amountInUsd: paid }));
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, sender: BOB.address }));
    const week = rewards.weekPoints("2026-W41");
    expect(week.get(ALICE.address)).toBe(4_020_000n * MICRO);
    expect(week.get(BOB.address)).toBe(250n * MICRO);
    expect([...week.keys()].sort()).toEqual([ALICE.address, BOB.address].sort());
    expect(rewards.weekPoints("2026-W42").size).toBe(0);
    const view = rewards.view(ALICE.address, MONDAY + 86_400_000);
    expect(view.week).toEqual({ id: "2026-W41", start: new Date(MONDAY).toISOString(), end: new Date(MONDAY + 7 * 86_400_000).toISOString(), pointsMicro: week.get(ALICE.address)!.toString(), carriedInMicro: "0" });
    expect(view.allTimeMicro).toBe(view.week.pointsMicro);
    expect(view.swaps).toHaveLength(3);
    // Each swap is shown with its own points, and they add up to the week's.
    expect(view.swaps.map((swap) => swap.pointsMicro).sort()).toEqual([pointsMicro(usd(52_000)), pointsMicro(usd(150_000)), pointsMicro(usd(200_000))].map(String).sort());
    expect(JSON.stringify(view)).not.toContain(BOB.address);
    expect(JSON.stringify(rewards.view(BOB.address, MONDAY))).not.toContain(ALICE.address);
  });

  it("does not read an entry written while points were counted from a fee: its file is left as it is, and adds nothing, also when its order is put to the record again at a start", () => {
    const dir = tempDir();
    const entries = path.join(dir, "rewards", "entries");
    fs.mkdirSync(entries, { recursive: true });
    // The entry of the older kind that a delivered order left behind, under that order's own name.
    const order = stored();
    const file = path.join(entries, `${orderHash(order.id)}.json`);
    const old = JSON.stringify({ v: 1, order: orderHash(order.id), address: ALICE.address, week: "2026-W41", at: new Date(MONDAY).toISOString(), feeUsdMicro: "2500000", countedMicro: "2500000", reasons: [], from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDT", chain: "sol" } });
    fs.writeFileSync(file, old);
    const rewards = createRewards(dir);
    expect(rewards.entriesFor(ALICE.address)).toEqual([]);
    expect(rewards.weekPoints("2026-W41").size).toBe(0);
    // At a start every stored delivered order is put to the record again. This one's file is there: nothing is written, and nothing is added in memory.
    rewards.recordDelivered(order);
    rewards.recordDelivered(order);
    expect(rewards.entriesFor(ALICE.address)).toEqual([]);
    expect(rewards.weekPoints("2026-W41").size).toBe(0);
    expect(rewards.view(ALICE.address, MONDAY + 86_400_000)).toMatchObject({ allTimeMicro: "0", week: { pointsMicro: "0" }, swaps: [] });
    expect(rewards.summary(MONDAY + 86_400_000).weekPointsMicro).toBe("0");
    // A fresh reading of the folder, as the payout tools make one, holds the same: nothing.
    const fresh = createRewards(dir);
    expect(fresh.entriesFor(ALICE.address)).toEqual([]);
    expect(fresh.weekPoints("2026-W41")).toEqual(rewards.weekPoints("2026-W41"));
    expect(fs.readFileSync(file, "utf8")).toBe(old);
    expect(fs.readdirSync(entries)).toEqual([`${orderHash(order.id)}.json`]);
    // Another order of the same address, with no file yet, is written down and counted as ever, in memory and on disk alike.
    rewards.recordDelivered(stored({ id: "C".repeat(27) }));
    expect(rewards.entriesFor(ALICE.address)).toHaveLength(1);
    expect(createRewards(dir).entriesFor(ALICE.address)).toEqual(rewards.entriesFor(ALICE.address));
  });

  it("closes a week once: the same pool gives the same record, another pool is refused, and a week still running cannot be closed", () => {
    const dir = tempDir();
    const rewards = quarters(dir);
    expect(() => rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end - 1, CLEAR)).toThrow(/has not ended/);
    expect(() => rewards.closeWeek("2026-41", 10n ** 18n, "NEAR", 1n, end, CLEAR)).toThrow(/not a week/);
    const closed = rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, CLEAR);
    // Alice has 250 points and Bob 750: a quarter and three quarters.
    expect(closed.shares).toEqual(
      [
        { address: ALICE.address, pointsMicro: "250000000", payout: "250000000000000000", carriedMicro: "0" },
        { address: BOB.address, pointsMicro: "750000000", payout: "750000000000000000", carriedMicro: "0" },
      ].sort((a, b) => (a.address < b.address ? -1 : 1)),
    );
    expect(BigInt(closed.paid) + BigInt(closed.left)).toBe(10n ** 18n);
    // Kept with the week: its volume ($25 and $75), and the list its payouts were screened against.
    expect(closed).toMatchObject({ v: 1, volumeUsdMicro: "100000000", totalPointsMicro: "1000000000", screenedWith: "test-list", txs: [] });
    const file = fs.readFileSync(path.join(dir, "rewards", "weeks", "2026-W41.json"), "utf8");
    // Closed again a day later, and by a fresh reading of the same folder: the very same record.
    expect(rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end + 86_400_000, CLEAR)).toEqual(closed);
    expect(createRewards(dir).closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end + 2 * 86_400_000, CLEAR)).toEqual(closed);
    expect(fs.readFileSync(path.join(dir, "rewards", "weeks", "2026-W41.json"), "utf8")).toBe(file);
    expect(() => rewards.closeWeek("2026-W41", 2n * 10n ** 18n, "NEAR", 1n, end, CLEAR)).toThrow(/already closed/);
    // A swap delivered late into that week, after it was closed, does not change what was shared out.
    rewards.recordDelivered(stored({ id: "D".repeat(27), amountInUsd: "9999" }));
    expect(rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, CLEAR)).toEqual(closed);
  });

  it("works out what closing a week would write without writing it", () => {
    const dir = tempDir();
    const rewards = quarters(dir);
    const before = everything(dir);
    const plan = rewards.planWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, CLEAR);
    expect(everything(dir)).toEqual(before);
    expect(rewards.week("2026-W41")).toBeNull();
    // It refuses what closing refuses, and closing writes exactly what it showed.
    expect(() => rewards.planWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end - 1, CLEAR)).toThrow(/has not ended/);
    expect(rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, CLEAR)).toEqual(plan);
    expect(rewards.planWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end + 5, CLEAR)).toEqual(plan);
    expect(() => rewards.planWeek("2026-W41", 1n, "NEAR", 1n, end, CLEAR)).toThrow(/already closed/);
  });

  it("carries a share too small to send into the next week, as points", () => {
    const rewards = createRewards(tempDir());
    // Alice swapped 10 cents, which is one point. Bob swapped $500,000.
    rewards.recordDelivered(stored({ amountInUsd: "0.1" }));
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "500000" }));
    const closed = rewards.closeWeek("2026-W41", 10n ** 15n, "NEAR", RESERVE_ASSET.minPayout, end, CLEAR);
    const alice = closed.shares.find((share) => share.address === ALICE.address)!;
    expect(alice).toMatchObject({ payout: "0", carriedMicro: "1000000" });
    // The week after, Alice starts with what was carried, and a new swap adds to it.
    expect(rewards.weekPoints("2026-W42").get(ALICE.address)).toBe(1_000_000n);
    rewards.recordDelivered(stored({ id: "E".repeat(27), finishedAt: new Date(end + 60_000).toISOString(), amountInUsd: "20" }));
    expect(rewards.weekPoints("2026-W42").get(ALICE.address)).toBe(1_000_000n + 200n * MICRO);
    const view = rewards.view(ALICE.address, end + 120_000);
    expect(view.week).toMatchObject({ id: "2026-W42", carriedInMicro: "1000000", pointsMicro: (1_000_000n + 200n * MICRO).toString() });
    // Points are counted once in the total over all time, in the week their swap was delivered.
    expect(view.allTimeMicro).toBe((1_000_000n + 200n * MICRO).toString());
    expect(view.payouts).toEqual([]);
    expect(rewards.view(BOB.address, end).payouts).toEqual([{ week: "2026-W41", amount: closed.shares.find((share) => share.address === BOB.address)!.payout, asset: "NEAR", decimals: 18, txs: [] }]);
  });

  it("closes a week with a pool of nothing: nothing is to be sent, and every address's points are carried", () => {
    const rewards = quarters();
    const closed = rewards.closeWeek("2026-W41", 0n, "NEAR", RESERVE_ASSET.minPayout, end, CLEAR);
    expect(closed).toMatchObject({ pool: "0", paid: "0", left: "0", totalPointsMicro: "1000000000" });
    expect(shareOf(closed, ALICE)).toEqual({ address: ALICE.address, pointsMicro: "250000000", payout: "0", carriedMicro: "250000000" });
    expect(shareOf(closed, BOB)).toEqual({ address: BOB.address, pointsMicro: "750000000", payout: "0", carriedMicro: "750000000" });
    const next = rewards.weekPoints("2026-W42");
    expect([next.get(ALICE.address), next.get(BOB.address)]).toEqual([250n * MICRO, 750n * MICRO]);
    expect(rewards.view(ALICE.address, end + 1)).toMatchObject({ payouts: [], week: { id: "2026-W42", carriedInMicro: "250000000" } });
    expect(() => rewards.closeWeek("2026-W42", -1n, "NEAR", 1n, end + WEEK_MS, CLEAR)).toThrow();
  });

  it("closes weeks in order: not while an earlier week that holds points is still open", () => {
    const rewards = createRewards(tempDir());
    // Alice's swap is delivered in week 41, Bob's in week 42.
    rewards.recordDelivered(stored());
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, finishedAt: new Date(end + 3_600_000).toISOString() }));
    const later = end + WEEK_MS;
    expect(() => rewards.planWeek("2026-W42", 10n ** 18n, "NEAR", 1n, later, CLEAR)).toThrow(/Week 2026-W41 holds points and is still open\. Close it first/);
    expect(() => rewards.closeWeek("2026-W42", 10n ** 18n, "NEAR", 1n, later, CLEAR)).toThrow(/Week 2026-W41 holds points and is still open\. Close it first/);
    expect(rewards.week("2026-W42")).toBeNull();
    rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, later, CLEAR);
    expect(rewards.closeWeek("2026-W42", 10n ** 18n, "NEAR", 1n, later, CLEAR).shares.map((share) => share.address)).toEqual([BOB.address]);
    // A week in which nothing was delivered, and into which nothing was carried, holds no points: it is no one's to wait for.
    rewards.recordDelivered(stored({ id: "D".repeat(27), finishedAt: new Date(end + 2 * WEEK_MS + 3_600_000).toISOString() }));
    expect(rewards.closeWeek("2026-W44", 10n ** 18n, "NEAR", 1n, end + 3 * WEEK_MS, CLEAR).shares).toHaveLength(1);
    // Nor is a week whose only swap added no points.
    rewards.recordDelivered(stored({ id: "E".repeat(27), amountInUsd: "", finishedAt: new Date(end + 3 * WEEK_MS + 3_600_000).toISOString() }));
    expect(rewards.weekPoints("2026-W45").size).toBe(0);
    expect(rewards.closeWeek("2026-W46", 10n ** 18n, "NEAR", 1n, end + 5 * WEEK_MS, CLEAR).shares).toEqual([]);
  });

  it("carries points through every week between: what was carried out of week 41 reaches week 43 by way of week 42", () => {
    const rewards = createRewards(tempDir());
    // Week 41: Alice's share is too small to send, and her one point is carried.
    rewards.recordDelivered(stored({ amountInUsd: "0.1" }));
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "500000" }));
    expect(shareOf(rewards.closeWeek("2026-W41", 10n ** 15n, "NEAR", RESERVE_ASSET.minPayout, end, CLEAR), ALICE).carriedMicro).toBe("1000000");
    // Nothing is delivered in week 42. Bob swaps again in week 43.
    rewards.recordDelivered(stored({ id: "D".repeat(27), rewardsAddress: BOB.address, amountInUsd: "500000", finishedAt: new Date(end + WEEK_MS + 3_600_000).toISOString() }));
    const after = end + 2 * WEEK_MS;
    // Week 43 is not closed over week 42's head: Alice's point is in week 42, and would be lost there.
    expect(() => rewards.closeWeek("2026-W43", 10n ** 18n, "NEAR", 1n, after, CLEAR)).toThrow(/Week 2026-W42 holds points and is still open\. Close it first, with a pool of nothing if nothing is to be paid for it\./);
    expect(rewards.week("2026-W43")).toBeNull();
    // Week 42 is closed with nothing to pay, and the point goes on.
    const middle = rewards.closeWeek("2026-W42", 0n, "NEAR", RESERVE_ASSET.minPayout, after, CLEAR);
    expect(middle.shares).toEqual([{ address: ALICE.address, pointsMicro: "1000000", payout: "0", carriedMicro: "1000000" }]);
    expect(rewards.weekPoints("2026-W43").get(ALICE.address)).toBe(1_000_000n);
    const last = rewards.closeWeek("2026-W43", 10n ** 18n, "NEAR", 1n, after, CLEAR);
    expect(shareOf(last, ALICE)).toMatchObject({ pointsMicro: "1000000", carriedMicro: "0" });
    expect(BigInt(shareOf(last, ALICE).payout) > 0n).toBe(true);
  });

  it("screens the payout list as a week is closed: a listed address is sent nothing and carries nothing, and its share stays in the reserve", () => {
    const rewards = quarters();
    // The list names Bob, in small letters: an address is the same address however it is written.
    const closed = rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, createStaticSanctions([BOB.address.toLowerCase()]));
    // Alice has her quarter and no more: Bob's three quarters are not handed to her.
    expect(shareOf(closed, ALICE)).toEqual({ address: ALICE.address, pointsMicro: "250000000", payout: "250000000000000000", carriedMicro: "0" });
    expect(shareOf(closed, BOB)).toEqual({ address: BOB.address, pointsMicro: "750000000", payout: "0", carriedMicro: "0", withheld: "750000000000000000" });
    expect(closed).toMatchObject({ pool: (10n ** 18n).toString(), paid: "250000000000000000", left: "750000000000000000", totalPointsMicro: "1000000000", screenedWith: "test-list" });
    // Nothing is carried for it, and its own view shows no payout for the week.
    expect(rewards.weekPoints("2026-W42").has(BOB.address)).toBe(false);
    expect(rewards.view(BOB.address, end + 1)).toMatchObject({ payouts: [], week: { id: "2026-W42", carriedInMicro: "0", pointsMicro: "0" } });
    expect(rewards.view(ALICE.address, end + 1).payouts).toEqual([{ week: "2026-W41", amount: "250000000000000000", asset: "NEAR", decimals: 18, txs: [] }]);
    // And no transaction can be written down as having paid it.
    expect(() => rewards.recordPaid("2026-W41", [{ address: BOB.address, hash: `0x${"b2".repeat(32)}` }], end + 2)).toThrow(/has no payout in week 2026-W41/);
    // The same week closed against a list that names nobody sends Bob his share: the screening is what kept it back.
    expect(shareOf(quarters().closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, CLEAR), BOB)).toMatchObject({ payout: "750000000000000000", carriedMicro: "0" });
  });

  it("closes nothing while the sanctions list is missing or out of date, as no order is made without it", async () => {
    const dir = tempDir();
    const rewards = quarters(dir);
    const none = createStaticSanctions([], { available: false });
    expect(() => rewards.planWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, none)).toThrow(/sanctions list is missing or out of date, so the payouts cannot be screened\. Nothing was closed/);
    expect(() => rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, none)).toThrow(/sanctions list is missing or out of date, so the payouts cannot be screened\. Nothing was closed/);
    // Not even a week with nothing to pay.
    expect(() => rewards.closeWeek("2026-W41", 0n, "NEAR", 1n, end, none)).toThrow(/sanctions list is missing or out of date/);
    expect(fs.readdirSync(path.join(dir, "rewards", "weeks"))).toEqual([]);

    // The list service the server screens orders with, on a saved list that cannot be fetched again.
    const listDir = tempDir();
    fs.mkdirSync(path.join(listDir, "sanctions"));
    const save = (fetchedAt: number) => fs.writeFileSync(path.join(listDir, "sanctions", "sdn-addresses.json"), JSON.stringify({ publishDate: "2026-10-01", fetchedAt, addresses: [...Array.from({ length: 300 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`), BOB.address] }));
    const service = () => createSanctions({ dataDir: listDir, log: silentLogger, alerts: { send() {} }, fetchImpl: async () => Promise.reject(new Error("offline")), now: () => end });
    // Never loaded.
    expect(() => rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, service())).toThrow(/sanctions list is missing or out of date/);
    // Saved three days and an hour ago: older than the list may be for an order, so older than it may be for a payout.
    save(end - 73 * 3_600_000);
    const stale = service();
    await stale.refresh();
    expect(stale.available()).toBe(false);
    expect(() => rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, stale)).toThrow(/sanctions list is missing or out of date/);
    expect(fs.readdirSync(path.join(dir, "rewards", "weeks"))).toEqual([]);
    // Saved an hour ago: it is used, and it names Bob.
    save(end - 3_600_000);
    const fresh = service();
    await fresh.refresh();
    const closed = rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, fresh);
    expect(shareOf(closed, BOB)).toMatchObject({ payout: "0", carriedMicro: "0", withheld: "750000000000000000" });
    expect(shareOf(closed, ALICE)).toMatchObject({ payout: "250000000000000000" });
    expect(closed.screenedWith).toBe("2026-10-01");
  });

  it("never writes over a week's record that it cannot read, and is not brought down by one", () => {
    const dir = tempDir();
    const rewards = quarters(dir);
    const file = path.join(dir, "rewards", "weeks", "2026-W41.json");
    const broken = '{"v":1,"week":"2026-W41","pool":"1","asset":"ZEC","shares":[{"address":"x"}],"txs":[]}';
    fs.writeFileSync(file, broken);
    expect(() => rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, CLEAR)).toThrow(/Week 2026-W41 has a record that cannot be read\. It was left as it is/);
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
    expect(rewards.week("2026-W41")).toBeNull();
    expect(rewards.summary(end)).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
    expect(rewards.view(ALICE.address, end).payouts).toEqual([]);
  });

  it("keeps, with each share, the transaction that paid it, and shows an address its own transfer and no one else's", () => {
    const rewards = quarters();
    rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, CLEAR);
    const forAlice = `0x${"a1".repeat(32)}`;
    const forBob = `0x${"b2".repeat(32)}`;
    const payouts = (who: { address: string }) => rewards.view(who.address, end + 10).payouts;
    // Closed and not yet sent: each sees its amount, and no transaction.
    expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: "250000000000000000", asset: "NEAR", decimals: 18, txs: [] }]);
    // Alice's is recorded, however the address and the hash are spelled.
    const one = rewards.recordPaid("2026-W41", [{ address: ALICE.address.toLowerCase(), hash: forAlice.toUpperCase().replace("0X", "0x") }], end + 2);
    expect(shareOf(one, ALICE).tx).toBe(forAlice);
    expect(shareOf(one, BOB).tx).toBeUndefined();
    expect(one.txs).toEqual([{ hash: forAlice, recordedAt: new Date(end + 2).toISOString() }]);
    expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: "250000000000000000", asset: "NEAR", decimals: 18, txs: [forAlice] }]);
    // Bob's is still being sent: he is not shown the transaction that paid Alice.
    expect(payouts(BOB)).toEqual([{ week: "2026-W41", amount: "750000000000000000", asset: "NEAR", decimals: 18, txs: [] }]);
    rewards.recordPaid("2026-W41", [{ address: BOB.address, hash: forBob }], end + 3);
    expect(payouts(BOB)[0]?.txs).toEqual([forBob]);
    expect(payouts(ALICE)[0]?.txs).toEqual([forAlice]);
    expect(JSON.stringify(rewards.view(ALICE.address, end + 10))).not.toContain(forBob.slice(2));
    expect(JSON.stringify(rewards.view(BOB.address, end + 10))).not.toContain(forAlice.slice(2));
    // A share is paid once, and only an address that is due a payout is paid at all.
    expect(() => rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash: `0x${"c3".repeat(32)}` }], end + 4)).toThrow(/has a transaction on record already/);
    expect(() => rewards.recordPaid("2026-W41", [{ address: ADDR.evm3, hash: `0x${"c3".repeat(32)}` }], end + 4)).toThrow(/has no payout in week 2026-W41/);
    expect(() => rewards.recordPaid("2026-W40", [{ address: ALICE.address, hash: `0x${"c3".repeat(32)}` }], end + 4)).toThrow(/not closed/);
    expect(rewards.week("2026-W41")?.txs.map((tx) => tx.hash)).toEqual([forAlice, forBob]);
  });

  it("keeps a transaction on record for one week only", () => {
    const rewards = createRewards(tempDir());
    // Alice alone, in week 41 and again in week 42.
    rewards.recordDelivered(stored());
    rewards.recordDelivered(stored({ id: "C".repeat(27), finishedAt: new Date(end + 3_600_000).toISOString() }));
    const later = end + WEEK_MS;
    rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, later, CLEAR);
    rewards.closeWeek("2026-W42", 10n ** 18n, "NEAR", 1n, later, CLEAR);
    const hash = `0x${"a1".repeat(32)}`;
    expect(rewards.weekOfTx(hash)).toBeNull();
    rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash }], later);
    expect(rewards.weekOfTx(hash.toUpperCase().replace("0X", "0x"))).toBe("2026-W41");
    expect(() => rewards.recordPaid("2026-W42", [{ address: ALICE.address, hash }], later)).toThrow(/is on record for week 2026-W41 already/);
    expect(rewards.week("2026-W42")).toMatchObject({ txs: [] });
    expect(rewards.week("2026-W42")?.shares[0]?.tx).toBeUndefined();
  });

  it("tells anyone the week's dates, its points as one total, and what the paid weeks have on record as sent, and nothing about any address", () => {
    const rewards = quarters();
    // Alice's 250 points and Bob's 750, as one number, with nothing to say whose they are.
    const running = rewards.summary(MONDAY + 86_400_000);
    expect(running).toMatchObject({ week: { id: "2026-W41" }, weekPointsMicro: (1000n * MICRO).toString() });
    expect(JSON.stringify(running)).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])|250000000|750000000/);
    const closed = rewards.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, CLEAR);
    // Closed but not yet paid: not on the public list.
    expect(rewards.summary(end + 1)).toMatchObject({ week: { id: "2026-W42" }, weeks: [], totalPaid: "0", weeksPaid: 0 });
    const hash = `0x${"9a".repeat(32)}`;
    // Alice's quarter is on record as sent and Bob's three quarters are not: the week has paid a quarter, whatever was worked out for it.
    rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash }], end + 2);
    expect(closed.paid).toBe((10n ** 18n).toString());
    expect(rewards.summary(end + 3)).toMatchObject({ weeks: [{ week: "2026-W41", asset: "NEAR", paid: "250000000000000000", txs: [hash] }], totalPaid: "250000000000000000", weeksPaid: 1 });
    const second = `0x${"9b".repeat(32)}`;
    rewards.recordPaid("2026-W41", [{ address: BOB.address, hash: second }], end + 4);
    const summary = rewards.summary(end + 5);
    expect(summary).toMatchObject({ weeks: [{ week: "2026-W41", asset: "NEAR", paid: (10n ** 18n).toString(), txs: [hash, second] }], totalPaid: (10n ** 18n).toString(), weeksPaid: 1 });
    expect(JSON.stringify(summary)).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
    // The one thing it says of points is the week's total: here, the week after, nothing yet.
    expect(Object.keys(summary).sort()).toEqual(["totalPaid", "week", "weekPointsMicro", "weeks", "weeksPaid"]);
    expect(summary.weekPointsMicro).toBe("0");
    expect(Object.keys(summary.week).sort()).toEqual(["end", "id", "start"]);
  });

  it("still reads a week written before a share kept its own transaction, and one closed in another coin: it is shown in its own coin, and not added to what was paid in NEAR", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "rewards", "weeks"), { recursive: true });
    const earlier = `0x${"9a".repeat(32)}`;
    const old = {
      v: 1,
      week: "2026-W41",
      closedAt: new Date(end).toISOString(),
      asset: "ZEC",
      pool: "1000",
      paid: "1000",
      left: "0",
      totalPointsMicro: "4",
      shares: [
        { address: ALICE.address, pointsMicro: "1", payout: "250", carriedMicro: "0" },
        { address: BOB.address, pointsMicro: "3", payout: "750", carriedMicro: "0" },
      ],
      txs: [{ hash: earlier, recordedAt: new Date(end + 1).toISOString() }],
    };
    fs.writeFileSync(path.join(dir, "rewards", "weeks", "2026-W41.json"), JSON.stringify(old));
    const rewards = createRewards(dir);
    expect(rewards.week("2026-W41")).toEqual(old);
    expect(rewards.summary(end + 2)).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
    // The record names its own coin and no decimals: it is read as that coin, with the 18 every coin had then.
    expect(rewards.view(ALICE.address, end + 2).payouts).toEqual([{ week: "2026-W41", amount: "250", asset: "ZEC", decimals: 18, txs: [] }]);
    // Its transaction is on record all the same, so it cannot be recorded for another week.
    expect(rewards.weekOfTx(earlier)).toBe("2026-W41");
    // A share of it can still be given the transfer that paid it.
    const own = `0x${"9c".repeat(32)}`;
    rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash: own }], end + 3);
    // It is on the list of paid weeks as what it was, and is no part of the total paid in NEAR.
    expect(rewards.summary(end + 4)).toMatchObject({ weeks: [{ week: "2026-W41", asset: "ZEC", decimals: 18, paid: "250", txs: [own] }], totalPaid: "0", weeksPaid: 0 });
    expect(rewards.view(ALICE.address, end + 4).payouts[0]).toMatchObject({ asset: "ZEC", txs: [own] });
    // It cannot be closed again in NEAR, and the tool that records payouts in NEAR records none for it.
    expect(() => rewards.closeWeek("2026-W41", 1000n, "NEAR", 1n, end + 5, CLEAR)).toThrow(/already closed, with a pool of 1000 ZEC/);
    await expect(recordPayouts({ rewards, rpc: createFakeRpc(), reserve: ADDR.evm3, token: RESERVE_ASSET.contract, week: "2026-W41", hashes: [`0x${"9d".repeat(32)}`], now: end + 6 })).rejects.toThrow(/Week 2026-W41 was closed in ZEC, not in NEAR\. Only payouts in NEAR are recorded\. Nothing was recorded\./);
  });

  it("reads a closed week's file once, and again only when the tools have changed it", () => {
    const dir = tempDir();
    // The running server's record, and the tools' own reading of the same folder, as they are in two processes.
    const server = quarters(dir);
    const tools = createRewards(dir);
    const weekReads = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([file]) => String(file).includes(path.join("rewards", "weeks"))).length;
    const reads = vi.spyOn(fs, "readFileSync");
    try {
      const ask = () => {
        const before = weekReads(reads);
        const summary = server.summary(end + 10);
        const mine = server.view(BOB.address, end + 10);
        return { summary, mine, read: weekReads(reads) - before };
      };
      // Nothing is closed: there is nothing to read.
      expect(ask()).toMatchObject({ summary: { weeksPaid: 0 }, mine: { payouts: [] }, read: 0 });
      // The tools close the week. The server's next answer has it, from one reading of the file.
      tools.closeWeek("2026-W41", 10n ** 18n, "NEAR", 1n, end, CLEAR);
      expect(ask()).toMatchObject({ summary: { weeksPaid: 0 }, mine: { payouts: [{ week: "2026-W41", txs: [] }] }, read: 1 });
      // Asked again and again, the file is not read again.
      for (let i = 0; i < 5; i++) expect(ask().read).toBe(0);
      // The tools record a payout. The next answer has that too, from one more reading.
      const hash = `0x${"b2".repeat(32)}`;
      tools.recordPaid("2026-W41", [{ address: BOB.address, hash }], end + 5);
      expect(ask()).toMatchObject({ summary: { weeksPaid: 1, totalPaid: "750000000000000000" }, mine: { payouts: [{ week: "2026-W41", txs: [hash] }] }, read: 1 });
      for (let i = 0; i < 5; i++) expect(ask().read).toBe(0);
      // A week's file taken away is gone from the next answer.
      fs.rmSync(path.join(dir, "rewards", "weeks", "2026-W41.json"));
      expect(ask()).toMatchObject({ summary: { weeksPaid: 0 }, mine: { payouts: [] }, read: 0 });
    } finally {
      reads.mockRestore();
    }
  });
});

describe("the payout tools", () => {
  const end = MONDAY + WEEK_MS;
  const RESERVE = ADDR.evm3;
  /** The reward token: NEAR on BNB Chain, by its contract there. */
  const NEAR_TOKEN = RESERVE_ASSET.contract;
  const TOKEN = { address: NEAR_TOKEN, decimals: 18 };
  const USDC_BSC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
  const ONE = 10n ** 18n;
  /** keccak256("Approval(address,address,uint256)"): the first topic of a token's record of an approval. */
  const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
  const word = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  /** Alice has 250 points and Bob 500 in week 41: a third and two thirds. */
  const seeded = (dir = tempDir()) => {
    const rewards = createRewards(dir);
    rewards.recordDelivered(stored());
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "50" }));
    return rewards;
  };
  /** BNB Chain as the tools see it: the reserve wallet holds this much NEAR. */
  const chain = (holds: bigint = 100n * ONE): FakeRpc => {
    const rpc = createFakeRpc();
    rpc.balances.set(RESERVE.toLowerCase(), holds);
    return rpc;
  };
  /** The export tool, as the script calls it. Without `close` it is a look. */
  const run = (rewards: Rewards, pool: bigint, extra: Partial<Parameters<typeof exportWeek>[0]> = {}) => exportWeek({ rewards, sanctions: CLEAR, rpc: chain(), reserve: RESERVE, token: TOKEN, week: "2026-W41", pool, asset: "NEAR", now: end, ...extra });
  const shareOf = (record: WeekRecord, who: { address: string }) => record.shares.find((share) => share.address === who.address)!;

  it("write the same list every time for the same week, and it adds up to the pool exactly", async () => {
    const rewards = seeded();
    const first = await run(rewards, 3n * ONE, { close: true });
    const second = await run(rewards, 3n * ONE, { close: true, asset: "near", now: end + 5 * 86_400_000 });
    expect(first).toMatchObject({ closed: true, already: false });
    expect(second).toMatchObject({ closed: true, already: true });
    expect(second.csv).toBe(first.csv);
    expect(second.summary).toEqual(first.summary);
    const [alice, bob] = [ALICE.address, BOB.address].sort();
    expect(first.csv.split("\n")[0]).toBe("rewards_address,points,share,payout_near,carried_points,withheld_near");
    expect(first.csv.split("\n").slice(1, 3).map((line) => line.split(",")[0])).toEqual([alice, bob]);
    expect(first.csv).toContain(`${ALICE.address},250.000000,0.33333333,1,0.000000,0\n`);
    expect(first.csv).toContain(`${BOB.address},500.000000,0.66666666,2,0.000000,0\n`);
    // The week's volume is Alice's $25 and Bob's $50, and its points are ten times that.
    expect(first.summary).toEqual({ week: "2026-W41", from: "2026-10-05T00:00:00.000Z", to: "2026-10-11T23:59:59.999Z", asset: "NEAR", pool: "3", paid: "3", leftInReserve: "0", withheld: "0", addresses: 2, addressesPaid: 2, addressesCarried: 0, addressesWithheld: 0, totalPoints: "750.000000", volumeUsd: "75.000000" });
    expect(BigInt(first.record.paid) + BigInt(first.record.left)).toBe(3n * ONE);
    expect(weekCsv(first.record)).toBe(first.csv);
  });

  it("work in NEAR, in the token's own 18 decimals: a pool of 12.5 is 12500000000000000000 of its smallest unit, each share is rounded down, and together they are never more than the pool", async () => {
    expect(poolAmount("12.5", 18)).toBe(12_500_000_000_000_000_000n);
    expect(poolAmount("0.000000000000000001", 18)).toBe(1n);
    for (const bad of ["", "twelve", "-1", "1e3", "0.0000000000000000001", "1,2,3"]) expect(() => poolAmount(bad, 18), bad).toThrow(/is not an amount of NEAR\./);
    // Alice has a third of the week's points and Bob two thirds.
    const closed = await run(seeded(), poolAmount("12.5", 18), { close: true });
    expect(closed.record).toMatchObject({ asset: "NEAR", decimals: 18, pool: "12500000000000000000", paid: "12499999999999999999", left: "1" });
    expect(shareOf(closed.record, ALICE).payout).toBe("4166666666666666666");
    expect(shareOf(closed.record, BOB).payout).toBe("8333333333333333333");
    expect(closed.record.shares.reduce((sum, share) => sum + BigInt(share.payout), 0n) <= 12_500_000_000_000_000_000n).toBe(true);
    // The list and the summary say it in NEAR, to the last decimal.
    expect(closed.summary).toMatchObject({ asset: "NEAR", pool: "12.5", paid: "12.499999999999999999", leftInReserve: "0.000000000000000001" });
    expect(closed.csv.split("\n")[0]).toBe("rewards_address,points,share,payout_near,carried_points,withheld_near");
    expect(closed.csv).toContain(`${ALICE.address},250.000000,0.33333333,4.166666666666666666,0.000000,0\n`);
    expect(closed.csv).toContain(`${BOB.address},500.000000,0.66666666,8.333333333333333333,0.000000,0\n`);

    // The built-in token has 18 decimals. Any other is asked for its own, and where it will not say, nothing is guessed.
    const rpc = chain();
    expect(await rewardTokenDecimals(rpc, NEAR_TOKEN)).toBe(18);
    expect(rpc.calls).toEqual([]);
    rpc.decimals.set(ADDR.evm2.toLowerCase(), 6);
    expect(await rewardTokenDecimals(rpc, ADDR.evm2)).toBe(6);
    expect(await rewardTokenDecimals(rpc, ADDR.evm)).toBeNull();
    // Worked in that token's units, the same pool typed the same way is another number, and the week keeps the decimals it was closed with.
    expect(poolAmount("12.5", 6)).toBe(12_500_000n);
    const six = await run(seeded(), poolAmount("12.5", 6), { close: true, rpc, token: { address: ADDR.evm2, decimals: 6 } });
    expect(six.record).toMatchObject({ asset: "NEAR", decimals: 6, pool: "12500000", paid: "12499999", left: "1" });
    expect(six.summary).toMatchObject({ pool: "12.5", paid: "12.499999" });
    expect(six.reserveHolds).toBe(100n * ONE);
  });

  it("show what closing a week would do and write nothing at all, until told to close", async () => {
    const dir = tempDir();
    const rewards = seeded(dir);
    const before = everything(dir);
    // No word to close, a plain no, and things that are not the word: each is a look.
    const looks = [await run(rewards, 3n * ONE), await run(rewards, 3n * ONE, { close: false }), await run(rewards, 3n * ONE, { close: "yes" as never }), await run(rewards, 3n * ONE, { close: 1 as never })];
    for (const look of looks) {
      expect(look).toMatchObject({ closed: false, already: false, reserveHolds: 100n * ONE });
      // All that closing would do is there to be read: the addresses, the points, the week's volume, each share and payout, what is carried, what is kept back and what stays in the reserve.
      expect(look.summary).toEqual({ week: "2026-W41", from: "2026-10-05T00:00:00.000Z", to: "2026-10-11T23:59:59.999Z", asset: "NEAR", pool: "3", paid: "3", leftInReserve: "0", withheld: "0", addresses: 2, addressesPaid: 2, addressesCarried: 0, addressesWithheld: 0, totalPoints: "750.000000", volumeUsd: "75.000000" });
      expect(look.csv).toContain(`${ALICE.address},250.000000,0.33333333,1,0.000000,0\n`);
      expect(look.csv).toContain(`${BOB.address},500.000000,0.66666666,2,0.000000,0\n`);
    }
    // A look may be had with another pool, as often as wanted: looking fixes nothing.
    expect((await run(rewards, 6n * ONE)).summary).toMatchObject({ pool: "6", paid: "6" });
    // Nothing was written: no week's record, no list, not a byte in the data folder.
    expect(everything(dir)).toEqual(before);
    expect(rewards.week("2026-W41")).toBeNull();
    expect(createRewards(dir).week("2026-W41")).toBeNull();
    // Told to close, it writes the record that a look showed.
    const closed = await run(rewards, 3n * ONE, { close: true });
    expect(closed.record).toEqual(looks[0]?.record);
    expect(createRewards(dir).week("2026-W41")).toEqual(closed.record);
    // From then on a look shows the week as it stands, and another pool is refused, looking or closing.
    expect(await run(rewards, 3n * ONE)).toMatchObject({ closed: true, already: true, record: closed.record });
    await expect(run(rewards, 6n * ONE)).rejects.toThrow(/already closed/);
    await expect(run(rewards, 6n * ONE, { close: true })).rejects.toThrow(/already closed/);
  });

  it("close nothing with a pool larger than the reserve wallet holds, or when what it holds cannot be read", async () => {
    const dir = tempDir();
    const rewards = seeded(dir);
    const rpc = chain(2n * ONE);
    await expect(run(rewards, 3n * ONE, { close: true, rpc })).rejects.toThrow(/The pool is 3 NEAR and the reserve wallet holds 2\. A week is not closed with more than the reserve holds\. Nothing was closed\./);
    await expect(run(rewards, 2n * ONE + 1n, { close: true, rpc })).rejects.toThrow(/Nothing was closed/);
    expect(rewards.week("2026-W41")).toBeNull();
    // BNB Chain was asked: the payout coin's own contract, about the reserve wallet.
    const asked = rpc.calls.find((call) => call.call.method === "eth_call");
    expect(asked?.chain).toBe("bsc");
    expect(JSON.stringify(asked?.call.params)).toContain(NEAR_TOKEN);
    expect(JSON.stringify(asked?.call.params)).toContain(`0x70a08231${RESERVE.slice(2).toLowerCase().padStart(64, "0")}`);
    expect(await reserveHolds(rpc, RESERVE, NEAR_TOKEN)).toEqual({ amount: 2n * ONE, decimals: 18 });
    // The chain cannot be read: no week is closed with anything to pay, however little.
    const down = chain();
    down.down = true;
    expect(await reserveHolds(down, RESERVE, NEAR_TOKEN)).toBeNull();
    for (const pool of [3n * ONE, 1n]) await expect(run(rewards, pool, { close: true, rpc: down }), String(pool)).rejects.toThrow(/The reserve wallet's balance could not be read from BNB Chain, so the pool could not be checked against it\. Nothing was closed\./);
    // An answer that is no number is no balance.
    const odd = chain();
    odd.batch = async (_chain, calls) => calls.map(() => ({ ok: true as const, result: "0x" }));
    await expect(run(rewards, ONE, { close: true, rpc: odd })).rejects.toThrow(/could not be read/);
    // With no reserve wallet set there is nothing to check a pool against.
    await expect(run(rewards, ONE, { close: true, reserve: null })).rejects.toThrow(/RESERVE_ADDRESS is not set, so there is no reserve wallet to check the pool against\. Nothing was closed\./);
    expect(fs.readdirSync(path.join(dir, "rewards", "weeks"))).toEqual([]);
    // A look is still to be had while the chain is down, and it says that the balance is not known.
    expect(await run(rewards, 3n * ONE, { rpc: down })).toMatchObject({ closed: false, reserveHolds: null });
    expect(await run(rewards, 3n * ONE, { reserve: null })).toMatchObject({ closed: false, reserveHolds: null });
    // Exactly what the reserve holds can be shared out.
    expect(await run(rewards, 2n * ONE, { close: true, rpc })).toMatchObject({ closed: true, already: false, reserveHolds: 2n * ONE });
    // A week that is closed is read back as it stands without the chain: by then its payouts may have left the reserve.
    expect(await run(rewards, 2n * ONE, { close: true, rpc: down })).toMatchObject({ closed: true, already: true });
  });

  it("refuse another coin, a pool under nothing, and a second pool for a closed week", async () => {
    const rewards = seeded();
    await expect(run(rewards, ONE, { asset: "BNB", close: true })).rejects.toThrow(/sent in NEAR/);
    await expect(run(rewards, -1n, { close: true })).rejects.toThrow(/less than nothing/);
    await run(rewards, ONE, { close: true });
    await expect(run(rewards, 2n * ONE, { close: true })).rejects.toThrow(/already closed/);
  });

  it("close a week with a pool of nothing, which carries every address's points and needs nothing in the reserve", async () => {
    const rewards = seeded();
    const closed = await run(rewards, 0n, { close: true, rpc: chain(0n) });
    expect(closed.summary).toMatchObject({ pool: "0", paid: "0", leftInReserve: "0", addresses: 2, addressesPaid: 0, addressesCarried: 2, addressesWithheld: 0 });
    expect(closed.csv).toContain(`${ALICE.address},250.000000,0.33333333,0,250.000000,0\n`);
    const next = rewards.weekPoints("2026-W42");
    expect([next.get(ALICE.address), next.get(BOB.address)]).toEqual([250n * MICRO, 500n * MICRO]);
  });

  it("close a week with a pool of nothing before there is any reserve wallet, or while the chain cannot be read: nothing is to be sent, so there is nothing to check", async () => {
    const down = chain();
    down.down = true;
    const unread = seeded();
    expect(await run(unread, 0n, { close: true, rpc: down })).toMatchObject({ closed: true, already: false, reserveHolds: null });
    expect(unread.week("2026-W41")).toMatchObject({ pool: "0", paid: "0" });
    const none = seeded();
    expect(await run(none, 0n, { close: true, reserve: null })).toMatchObject({ closed: true, already: false, reserveHolds: null });
    expect(none.weekPoints("2026-W42").get(ALICE.address)).toBe(250n * MICRO);
    // With anything at all to pay, both are refused as before.
    const paying = seeded();
    await expect(run(paying, 1n, { close: true, reserve: null })).rejects.toThrow(/RESERVE_ADDRESS is not set/);
    await expect(run(paying, 1n, { close: true, rpc: down })).rejects.toThrow(/could not be read/);
    expect(paying.week("2026-W41")).toBeNull();
  });

  it("screen the payout list: an address on the sanctions list is left out, shown as withheld and counted", async () => {
    const dir = tempDir();
    const rewards = seeded(dir);
    const listed = createStaticSanctions([BOB.address]);
    const look = await run(rewards, 3n * ONE, { sanctions: listed });
    // Alice is sent her third. Bob's two thirds are kept back and stay in the reserve.
    expect(look.summary).toMatchObject({ pool: "3", paid: "1", leftInReserve: "2", withheld: "2", addresses: 2, addressesPaid: 1, addressesCarried: 0, addressesWithheld: 1 });
    expect(look.csv).toContain(`${ALICE.address},250.000000,0.33333333,1,0.000000,0\n`);
    expect(look.csv).toContain(`${BOB.address},500.000000,0.66666666,0,0.000000,2\n`);
    expect(rewards.week("2026-W41")).toBeNull();
    const closed = await run(rewards, 3n * ONE, { sanctions: listed, close: true });
    expect(closed.record).toEqual(look.record);
    expect(shareOf(closed.record, BOB)).toEqual({ address: BOB.address, pointsMicro: "500000000", payout: "0", carriedMicro: "0", withheld: (2n * ONE).toString() });
    expect(shareOf(closed.record, ALICE)).toEqual({ address: ALICE.address, pointsMicro: "250000000", payout: ONE.toString(), carriedMicro: "0" });
    // Bob's own view has no payout for the week, and nothing carried.
    expect(rewards.view(BOB.address, end + 1)).toMatchObject({ payouts: [], week: { carriedInMicro: "0" } });
    // Read back later against a list that no longer names Bob, the week stands as it was closed.
    expect((await run(rewards, 3n * ONE, { close: true })).record).toEqual(closed.record);
    // A transfer to the address that was left out is no payout of this week, and is not recorded as one.
    const rpc = chain();
    const toBob = `0x${"b2".repeat(32)}`;
    putMined(rpc, toBob, { from: RESERVE }, [transferLog(NEAR_TOKEN, RESERVE, BOB.address, 2n * ONE)]);
    await expect(recordPayouts({ rewards, rpc, reserve: RESERVE, token: NEAR_TOKEN, week: "2026-W41", hashes: [toBob], now: end })).rejects.toThrow(/holds no transfer/);
  });

  it("show nothing and close nothing while the sanctions list is missing or out of date", async () => {
    const dir = tempDir();
    const rewards = seeded(dir);
    const none = createStaticSanctions([], { available: false });
    await expect(run(rewards, ONE, { sanctions: none })).rejects.toThrow(/sanctions list is missing or out of date/);
    await expect(run(rewards, ONE, { sanctions: none, close: true })).rejects.toThrow(/sanctions list is missing or out of date, so the payouts cannot be screened\. Nothing was closed/);
    expect(fs.readdirSync(path.join(dir, "rewards", "weeks"))).toEqual([]);
  });

  describe("recording what was sent", () => {
    const hashOf = (label: string) => `0x${createHash("sha256").update(`intentswap test payout ${label}`).digest("hex")}`;
    const record = (rewards: Rewards, rpc: FakeRpc, hashes: string[], week = "2026-W41") => recordPayouts({ rewards, rpc, reserve: RESERVE, token: NEAR_TOKEN, week, hashes, now: end + 60_000 });
    /** Week 41 closed with a pool of 3: Alice is due 1 and Bob 2. */
    const closedWeek = async () => {
      const rewards = seeded();
      await run(rewards, 3n * ONE, { close: true });
      return rewards;
    };
    /** A mined, successful transaction from the reserve wallet that holds one transfer. */
    const pay = (rpc: FakeRpc, label: string, to: string, amount: bigint, options: { from?: string; token?: string } = {}) => {
      const hash = hashOf(label);
      putMined(rpc, hash, { from: RESERVE.toLowerCase(), to: options.token ?? NEAR_TOKEN }, [transferLog(options.token ?? NEAR_TOKEN, options.from ?? RESERVE, to, amount)]);
      return hash;
    };
    const none = /holds no transfer of NEAR from the reserve wallet to an address still to be paid in week 2026-W41, for exactly its payout\. Nothing was recorded\./;

    it("check that a transaction was sent by the reserve wallet and went through, and read what it holds", async () => {
      const rpc = chain();
      const good = pay(rpc, "good", ALICE.address, ONE);
      // Each of these holds a transfer that would pass: what stops it is who sent it, or that it failed.
      const foreign = hashOf("foreign");
      putMined(rpc, foreign, { from: ADDR.evm2 }, [transferLog(NEAR_TOKEN, RESERVE, BOB.address, 2n * ONE)]);
      const failed = hashOf("failed");
      putMined(rpc, failed, { from: RESERVE }, [transferLog(NEAR_TOKEN, RESERVE, BOB.address, 2n * ONE)], "0x0");
      const pending = hashOf("pending");
      rpc.txs.set(pending, { from: RESERVE });
      expect(await checkPayoutTx(rpc, RESERVE, good, NEAR_TOKEN)).toEqual({ ok: true, transfers: [{ to: ALICE.address.toLowerCase(), amount: ONE }] });
      expect(await checkPayoutTx(rpc, RESERVE, foreign, NEAR_TOKEN)).toEqual({ ok: false, reason: "it was not sent from the reserve wallet" });
      expect(await checkPayoutTx(rpc, RESERVE, failed, NEAR_TOKEN)).toEqual({ ok: false, reason: "it failed on-chain" });
      expect(await checkPayoutTx(rpc, RESERVE, pending, NEAR_TOKEN)).toEqual({ ok: false, reason: "it has not been included in a block yet" });
      expect(await checkPayoutTx(rpc, RESERVE, hashOf("unknown"), NEAR_TOKEN)).toEqual({ ok: false, reason: "no such transaction on BNB Chain" });
      expect(await checkPayoutTx(rpc, RESERVE, "0x1234", NEAR_TOKEN)).toEqual({ ok: false, reason: "that is not a transaction hash" });
      // What it holds is the reward token's own record of coins leaving the reserve wallet, and nothing else.
      const mixed = hashOf("mixed");
      putMined(rpc, mixed, { from: RESERVE }, [
        transferLog(USDC_BSC, RESERVE, ALICE.address, ONE),
        transferLog(NEAR_TOKEN, ADDR.evm2, ALICE.address, ONE),
        { address: NEAR_TOKEN, topics: [APPROVAL_TOPIC, word(RESERVE), word(ADDR.evm2)], data: `0x${ONE.toString(16).padStart(64, "0")}` },
        transferLog(NEAR_TOKEN, RESERVE, ALICE.address, 0n),
        "not a log",
        null,
        transferLog(NEAR_TOKEN, RESERVE, BOB.address, 2n * ONE),
      ]);
      expect(await checkPayoutTx(rpc, RESERVE, mixed, NEAR_TOKEN)).toEqual({ ok: true, transfers: [{ to: BOB.address.toLowerCase(), amount: 2n * ONE }] });
      rpc.down = true;
      expect(await checkPayoutTx(rpc, RESERVE, good, NEAR_TOKEN)).toEqual({ ok: false, reason: "BNB Chain could not be read" });
    });

    it("record nothing unless every transaction passes", async () => {
      const rewards = seeded();
      const rpc = chain();
      const good = pay(rpc, "good", ALICE.address, ONE);
      await expect(record(rewards, rpc, [good])).rejects.toThrow(/not closed/);
      await run(rewards, 3n * ONE, { close: true });
      // One bad hash among good ones: nothing is recorded.
      const foreign = hashOf("foreign");
      putMined(rpc, foreign, { from: ADDR.evm2 }, [transferLog(NEAR_TOKEN, RESERVE, BOB.address, 2n * ONE)]);
      await expect(record(rewards, rpc, [good, foreign])).rejects.toThrow(/not sent from the reserve wallet\. Nothing was recorded/);
      const failed = hashOf("failed");
      putMined(rpc, failed, { from: RESERVE }, [transferLog(NEAR_TOKEN, RESERVE, BOB.address, 2n * ONE)], "0x0");
      await expect(record(rewards, rpc, [good, failed])).rejects.toThrow(/it failed on-chain\. Nothing was recorded/);
      expect(rewards.week("2026-W41")?.txs).toEqual([]);
      expect(rewards.week("2026-W41")?.shares.every((share) => share.tx === undefined)).toBe(true);
      await expect(record(rewards, rpc, [])).rejects.toThrow(/at least one/);
      // Given twice, in two spellings, a transaction is recorded once.
      const recorded = await record(rewards, rpc, [good, good.toUpperCase().replace("0X", "0x")]);
      expect(recorded.txs.map((tx) => tx.hash)).toEqual([good]);
      expect(shareOf(recorded, ALICE).tx).toBe(good);
      expect(shareOf(recorded, BOB).tx).toBeUndefined();
    });

    it("refuse a transaction that holds no payout on the list: an approval, another coin, another amount, an address that is due nothing", async () => {
      const rewards = await closedWeek();
      const rpc = chain();
      // The reserve wallet approves an unrelated contract to spend its coins: it came from the reserve and went through, and it pays nobody.
      const approval = hashOf("approval");
      putMined(rpc, approval, { from: RESERVE, to: NEAR_TOKEN }, [{ address: NEAR_TOKEN, topics: [APPROVAL_TOPIC, word(RESERVE), word(ADDR.evm2)], data: `0x${"f".repeat(64)}` }]);
      await expect(record(rewards, rpc, [approval])).rejects.toThrow(none);
      // A plain payment of BNB out of the reserve, with no record of any coin moving.
      const plain = hashOf("plain");
      putMined(rpc, plain, { from: RESERVE, to: ALICE.address, value: "0xde0b6b3a7640000" });
      await expect(record(rewards, rpc, [plain])).rejects.toThrow(none);
      const others: Record<string, string> = {
        "another coin, in Alice's amount": pay(rpc, "another coin", ALICE.address, ONE, { token: USDC_BSC }),
        "the payout coin out of another wallet": pay(rpc, "another wallet", ALICE.address, ONE, { from: ADDR.evm2 }),
        "one unit less than Alice's payout": pay(rpc, "less", ALICE.address, ONE - 1n),
        "one unit more": pay(rpc, "more", ALICE.address, ONE + 1n),
        "Bob's amount, to Alice": pay(rpc, "swapped", ALICE.address, 2n * ONE),
        "an address that is not on the list": pay(rpc, "stranger", ADDR.evm2, ONE),
      };
      for (const [what, hash] of Object.entries(others)) await expect(record(rewards, rpc, [hash]), what).rejects.toThrow(none);
      // One that passes does not carry one that does not.
      const good = pay(rpc, "good", ALICE.address, ONE);
      await expect(record(rewards, rpc, [good, approval])).rejects.toThrow(none);
      expect(rewards.week("2026-W41")?.txs).toEqual([]);
      expect(rewards.week("2026-W41")?.shares.every((share) => share.tx === undefined)).toBe(true);
    });

    it("take only transfers of the reward token: the same amount of any other token, from the same wallet to the same address, is no payout", async () => {
      const rewards = await closedWeek();
      const rpc = chain();
      const inUsdc = pay(rpc, "usdc", ALICE.address, ONE, { token: USDC_BSC });
      const inNear = pay(rpc, "near", ALICE.address, ONE);
      await expect(record(rewards, rpc, [inUsdc])).rejects.toThrow(none);
      expect((await checkPayoutTx(rpc, RESERVE, inUsdc, NEAR_TOKEN))).toEqual({ ok: true, transfers: [] });
      // The token is the one the server is set to, and no other: with the setting on another token, a transfer of the built-in one is refused in its turn.
      await expect(recordPayouts({ rewards, rpc, reserve: RESERVE, token: USDC_BSC, week: "2026-W41", hashes: [inNear], now: end + 60_000 })).rejects.toThrow(none);
      expect(rewards.week("2026-W41")?.txs).toEqual([]);
      expect(shareOf(await record(rewards, rpc, [inNear]), ALICE).tx).toBe(inNear);
    });

    it("write down with each payout the transaction that made it, and record a payout once", async () => {
      const rewards = await closedWeek();
      const rpc = chain();
      const toAlice = pay(rpc, "alice", ALICE.address, ONE);
      const first = await record(rewards, rpc, [toAlice]);
      expect(shareOf(first, ALICE).tx).toBe(toAlice);
      expect(shareOf(first, BOB).tx).toBeUndefined();
      // A second transfer of the same amount to Alice is no payout of this week: hers is on record.
      const again = pay(rpc, "alice again", ALICE.address, ONE);
      await expect(record(rewards, rpc, [again])).rejects.toThrow(none);
      // Two transfers to Bob given together do not both count: the second pays nothing that is still due.
      const bobOne = pay(rpc, "bob one", BOB.address, 2n * ONE);
      const bobTwo = pay(rpc, "bob two", BOB.address, 2n * ONE);
      await expect(record(rewards, rpc, [bobOne, bobTwo])).rejects.toThrow(none);
      expect(shareOf(rewards.week("2026-W41")!, BOB).tx).toBeUndefined();
      const second = await record(rewards, rpc, [bobOne]);
      expect(shareOf(second, BOB).tx).toBe(bobOne);
      expect(shareOf(second, ALICE).tx).toBe(toAlice);
      expect(second.txs.map((tx) => tx.hash)).toEqual([toAlice, bobOne]);
      // One transaction may hold several payouts: it is written down with each of them, and once in the week's list.
      const other = await closedWeek();
      const both = hashOf("both");
      putMined(rpc, both, { from: RESERVE }, [transferLog(NEAR_TOKEN, RESERVE, ALICE.address, ONE), transferLog(NEAR_TOKEN, RESERVE, BOB.address, 2n * ONE)]);
      const all = await record(other, rpc, [both]);
      expect(all.shares.map((share) => share.tx)).toEqual([both, both]);
      expect(all.txs.map((tx) => tx.hash)).toEqual([both]);
    });

    it("refuse a hash that is on record already: one transaction cannot serve two weeks", async () => {
      // Alice alone, with the same swap in week 41 and in week 42: each week, closed with a pool of 1, owes her exactly 1.
      const rewards = createRewards(tempDir());
      rewards.recordDelivered(stored());
      rewards.recordDelivered(stored({ id: "C".repeat(27), finishedAt: new Date(end + 3_600_000).toISOString() }));
      const later = end + WEEK_MS;
      await run(rewards, ONE, { close: true, now: later });
      await run(rewards, ONE, { close: true, now: later, week: "2026-W42" });
      const rpc = chain();
      const paid = pay(rpc, "week 41", ALICE.address, ONE);
      await record(rewards, rpc, [paid]);
      const asked = rpc.calls.length;
      // The same hash again for the same week.
      await expect(record(rewards, rpc, [paid])).rejects.toThrow(/it is on record already, for week 2026-W41\. Nothing was recorded\./);
      // The same hash for the next week, where Alice is due exactly what it holds.
      await expect(record(rewards, rpc, [paid.toUpperCase().replace("0X", "0x")], "2026-W42")).rejects.toThrow(/it is on record already, for week 2026-W41\. Nothing was recorded\./);
      // It is refused from the record alone: the chain is not even asked.
      expect(rpc.calls.length).toBe(asked);
      expect(rewards.week("2026-W42")).toMatchObject({ txs: [] });
      expect(rewards.week("2026-W42")?.shares[0]?.tx).toBeUndefined();
      expect(rewards.summary(later)).toMatchObject({ weeksPaid: 1, totalPaid: ONE.toString() });
      // Week 42 is paid by a transaction of its own.
      const own = pay(rpc, "week 42", ALICE.address, ONE);
      await record(rewards, rpc, [own], "2026-W42");
      expect(rewards.summary(later)).toMatchObject({ weeksPaid: 2, totalPaid: (2n * ONE).toString() });
      expect(rewards.view(ALICE.address, later).payouts).toEqual([
        { week: "2026-W42", amount: ONE.toString(), asset: "NEAR", decimals: 18, txs: [own] },
        { week: "2026-W41", amount: ONE.toString(), asset: "NEAR", decimals: 18, txs: [paid] },
      ]);
    });

    it("leave the Rewards page saying only what is on record as sent: the week's total, and to each address its own transfer", async () => {
      const rewards = await closedWeek();
      const rpc = chain();
      const payouts = (who: { address: string }) => rewards.view(who.address, end + 120_000).payouts;
      // Closed, nothing recorded: no week is shown as paid, and each address sees its amount with no transaction.
      expect(rewards.summary(end + 1)).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
      expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: ONE.toString(), asset: "NEAR", decimals: 18, txs: [] }]);
      const toAlice = pay(rpc, "alice", ALICE.address, ONE);
      await record(rewards, rpc, [toAlice]);
      // One payout of two is on record: the week has paid 1, not the 3 that were worked out for it.
      expect(rewards.week("2026-W41")?.paid).toBe((3n * ONE).toString());
      expect(rewards.summary(end + 2)).toMatchObject({ weeks: [{ week: "2026-W41", asset: "NEAR", paid: ONE.toString(), txs: [toAlice] }], totalPaid: ONE.toString(), weeksPaid: 1 });
      expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: ONE.toString(), asset: "NEAR", decimals: 18, txs: [toAlice] }]);
      expect(payouts(BOB)).toEqual([{ week: "2026-W41", amount: (2n * ONE).toString(), asset: "NEAR", decimals: 18, txs: [] }]);
      const toBob = pay(rpc, "bob", BOB.address, 2n * ONE);
      await record(rewards, rpc, [toBob]);
      expect(rewards.summary(end + 3)).toMatchObject({ weeks: [{ week: "2026-W41", paid: (3n * ONE).toString(), txs: [toAlice, toBob] }], totalPaid: (3n * ONE).toString(), weeksPaid: 1 });
      // Each address is shown its own transfer, and not the other's.
      expect(payouts(BOB)).toEqual([{ week: "2026-W41", amount: (2n * ONE).toString(), asset: "NEAR", decimals: 18, txs: [toBob] }]);
      expect(payouts(ALICE)[0]?.txs).toEqual([toAlice]);
    });
  });
});

describe("signing in on the Rewards page", () => {
  const parts = { host: "intentswap.example", address: ALICE.address, nonce: "ab".repeat(16), issuedAt: "2026-10-05T00:00:00.000Z", expiresAt: "2026-10-05T00:05:00.000Z" };

  it("asks for one plain message, laid out as a Sign-In with Ethereum message: the site, the address, a code used once and when it runs out, and nothing that could be a transaction", () => {
    const message = signInMessage(parts);
    expect(message.split("\n")).toEqual([
      "intentswap.example wants you to sign in with your Ethereum account:",
      ALICE.address,
      "",
      "Sign in to see this address's points. This is not a transaction. It moves nothing, approves nothing and costs no network fee.",
      "",
      "URI: https://intentswap.example",
      "Version: 1",
      "Chain ID: 56",
      `Nonce: ${"ab".repeat(16)}`,
      "Issued At: 2026-10-05T00:00:00.000Z",
      "Expiration Time: 2026-10-05T00:05:00.000Z",
    ]);
    expect(SIGN_IN_STATEMENT).toBe("Sign in to see this address's points. This is not a transaction. It moves nothing, approves nothing and costs no network fee.");
    // The site's address is https, but for a page on this machine, which is served over plain http.
    const uri = (host: string) => signInMessage({ ...parts, host }).split("\n")[5];
    expect([uri("127.0.0.1:8787"), uri("localhost:5173"), uri("localhost"), uri("[::1]:8787")]).toEqual(["URI: http://127.0.0.1:8787", "URI: http://localhost:5173", "URI: http://localhost", "URI: http://[::1]:8787"]);
    expect([uri("example.org:8443"), uri("localhost.evil.example"), uri("127.0.0.1.evil.example")]).toEqual(["URI: https://example.org:8443", "URI: https://localhost.evil.example", "URI: https://127.0.0.1.evil.example"]);
  });

  it("is read as a Sign-In with Ethereum message by a wallet library, which can tell this site from another", () => {
    const message = signInMessage(parts);
    const read = parseSiweMessage(message);
    expect(read).toEqual({
      domain: "intentswap.example",
      address: ALICE.address,
      statement: SIGN_IN_STATEMENT,
      uri: "https://intentswap.example",
      version: "1",
      chainId: 56,
      nonce: "ab".repeat(16),
      issuedAt: new Date("2026-10-05T00:00:00.000Z"),
      expirationTime: new Date("2026-10-05T00:05:00.000Z"),
    });
    const within = new Date("2026-10-05T00:01:00.000Z");
    expect(validateSiweMessage({ message: read, domain: "intentswap.example", address: ALICE.address, nonce: "ab".repeat(16), time: within })).toBe(true);
    // Asked for by another site, for another address, or after it has run out, it does not pass.
    expect(validateSiweMessage({ message: read, domain: "evil.example", time: within })).toBe(false);
    expect(validateSiweMessage({ message: read, domain: "intentswap.example", address: BOB.address, time: within })).toBe(false);
    expect(validateSiweMessage({ message: read, domain: "intentswap.example", time: new Date("2026-10-05T00:05:00.000Z") })).toBe(false);
    // The same is read of a message for a page on this machine.
    expect(parseSiweMessage(signInMessage({ ...parts, host: "127.0.0.1:8787" }))).toMatchObject({ domain: "127.0.0.1:8787", uri: "http://127.0.0.1:8787", chainId: 56 });
  });

  it("is known again by the page only when it is, character for character, the message for this site and this address", () => {
    const message = signInMessage(parts);
    expect(isSignInMessage(message, parts)).toBe(true);
    // Another site, another address, the address in another spelling.
    expect(isSignInMessage(signInMessage({ ...parts, host: "evil.example" }), parts)).toBe(false);
    expect(isSignInMessage(message, { ...parts, host: "www.intentswap.example" })).toBe(false);
    expect(isSignInMessage(signInMessage({ ...parts, address: BOB.address }), parts)).toBe(false);
    expect(isSignInMessage(signInMessage({ ...parts, address: ALICE.address.toLowerCase() }), parts)).toBe(false);
    // A character more or less, a line of somebody else's, other wording.
    for (const other of [`${message} `, `${message}\n`, message.slice(0, -1), `${message}\nResources:\n- https://evil.example`, message.replace("This is not a transaction. ", ""), message.replace("Chain ID: 56", "Chain ID: 1"), "", null, undefined, 5]) expect(isSignInMessage(other, parts), String(other)).toBe(false);
    // Parts that are not a code and two times: a line cannot ride in on one of them.
    const smuggled = { ...parts, nonce: `${"ab".repeat(16)}\nResources:\n- https://evil.example` };
    expect(isSignInMessage(signInMessage(smuggled), smuggled)).toBe(false);
    const later = { ...parts, expiresAt: "2026-10-05T00:05:00.000Z\nRequest ID: approve everything" };
    expect(isSignInMessage(signInMessage(later), later)).toBe(false);
    for (const bad of [{ nonce: "ab".repeat(15) }, { nonce: "AB".repeat(16) }, { nonce: undefined }, { issuedAt: undefined }, { issuedAt: "yesterday" }, { expiresAt: undefined }, { expiresAt: 5 }]) {
      const given = { ...parts, ...bad };
      expect(isSignInMessage(signInMessage(given as never), given), JSON.stringify(bad)).toBe(false);
    }
  });

  it("gives a code that works once, for five minutes, and a session that lasts thirty and is for one address only", () => {
    const signIn = createSignIn();
    const first = signIn.challenge(ALICE.address, "intentswap.example", MONDAY);
    expect(first.issuedAt).toBe(MONDAY);
    expect(first.expiresAt).toBe(MONDAY + 5 * 60_000);
    expect(first.message).toContain(ALICE.address);
    expect(first.message).toContain(first.nonce);
    // The message is the one made from its parts, and nothing else.
    expect(first.message).toBe(signInMessage({ host: "intentswap.example", address: ALICE.address, nonce: first.nonce, issuedAt: new Date(first.issuedAt).toISOString(), expiresAt: new Date(first.expiresAt).toISOString() }));
    expect(signIn.redeem(first.nonce, MONDAY + 1)).toEqual({ address: ALICE.address, message: first.message });
    // Used up.
    expect(signIn.redeem(first.nonce, MONDAY + 2)).toBeNull();
    const late = signIn.challenge(ALICE.address, "intentswap.example", MONDAY);
    expect(signIn.redeem(late.nonce, MONDAY + 5 * 60_000)).toBeNull();
    for (const bad of [undefined, null, 5, "", "zz".repeat(16), "ab".repeat(15), `${"ab".repeat(16)}0`]) expect(signIn.redeem(bad, MONDAY)).toBeNull();

    const session = signIn.issue(ALICE.address, MONDAY);
    expect(session.expiresAt).toBe(MONDAY + 30 * 60_000);
    expect(signIn.verify(session.token, MONDAY + 1)).toBe(ALICE.address);
    expect(signIn.verify(session.token, MONDAY + 30 * 60_000)).toBeNull();
    // A session cannot be turned into one for another address, or made to last longer.
    expect(signIn.verify(session.token.replace(ALICE.address.toLowerCase(), BOB.address.toLowerCase()), MONDAY + 1)).toBeNull();
    expect(signIn.verify(session.token.replace(String(session.expiresAt), String(session.expiresAt + 1)), MONDAY + 1)).toBeNull();
    // A session from another server's secret is not one.
    expect(createSignIn().verify(session.token, MONDAY + 1)).toBeNull();
    for (const bad of [undefined, null, 5, "", "r1.x.y.z", "x".repeat(300)]) expect(signIn.verify(bad, MONDAY)).toBeNull();
  });
});

/** Signs in through the routes, as the Rewards page does. */
async function signedIn(h: Harness, account: ReturnType<typeof wallet>, ip = "203.0.113.10"): Promise<string> {
  const session = await h.session(ip);
  const code = await h.post("/api/rewards/code", { address: account.address }, { session, ip });
  expect(code.status).toBe(200);
  const reply = await h.post("/api/rewards/session", { nonce: code.body.nonce, signature: await account.signMessage({ message: code.body.message }) }, { session, ip });
  expect(reply.status).toBe(200);
  expect(reply.body.address).toBe(account.address);
  return String(reply.body.token);
}

/** Makes an order and has the practice provider deliver it. */
async function delivered(h: Harness, overrides: Record<string, unknown>, ip = "203.0.113.10") {
  const order = asOrder(await h.order(overrides, { ip }));
  h.stub.control(order.depositAddress!, "deposit");
  h.clock.t += 30_000;
  await h.poller.recheck(order.id);
  expect(h.store.get(order.id)?.state.status).toBe("delivered");
  return order;
}

describe("points over the wire", () => {
  it("an order carries a rewards address the person chose, checked and screened like its other addresses", async () => {
    const h = await start({ limits: { orderCreate: { max: 100, windowMs: 60_000 } } });
    const order = asOrder(await h.order({ rewardsAddress: ALICE.address.toLowerCase() }));
    expect(order.rewardsAddress).toBe(ALICE.address);
    expect(h.store.get(order.id)?.rewardsAddress).toBe(ALICE.address);
    // Left out, or empty: the order is made and adds no points.
    expect(asOrder(await h.order({ recipient: ADDR.evm3 })).rewardsAddress).toBeNull();
    expect(asOrder(await h.order({ recipient: ADDR.evm3, rewardsAddress: "", amount: "6000000000000000" })).rewardsAddress).toBeNull();
    for (const bad of ["0x1234", ADDR.sol, 5, {}]) {
      const reply = await h.order({ rewardsAddress: bad });
      expect(reply.status, String(bad)).toBe(400);
      expect(reply.body.error).toEqual({ code: "invalid_rewards", message: "Enter a BNB Chain address for this swap's points, or leave the field empty." });
    }
    const listed = await start({ sanctions: createStaticSanctions([ALICE.address]) });
    const refused = await listed.order({ rewardsAddress: ALICE.address });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("blocked");
    expect(listed.stub.calls.liveQuotes).toBe(0);
  });

  it("points are counted on the server when an order is delivered, and nothing the browser sends can name them", async () => {
    const h = await start({ practice: true });
    const order = await delivered(h, { rewardsAddress: ALICE.address, points: "999999999", pointsMicro: "999999999", fees: { appBps: 9999 } });
    const [entry] = h.rewards.entriesFor(ALICE.address) as [PointsEntry];
    const record = h.store.get(order.id)!;
    // The order's own dollar value, as the verified quote gave it, and no fee: the server takes none here.
    expect(record.fees.appBps).toBe(0);
    expect(entry.volumeUsdMicro).toBe(usdToMicro(record.amountInUsd)!.toString());
    expect(BigInt(entry.volumeUsdMicro)).toBeGreaterThan(0n);
    expect(h.rewards.view(ALICE.address, h.clock.t).allTimeMicro).toBe((BigInt(entry.volumeUsdMicro) * 10n).toString());
    expect(entry.order).toBe(orderHash(order.id));
    // An order that ends any other way adds nothing.
    const other = asOrder(await h.order({ rewardsAddress: BOB.address, recipient: ADDR.evm3 }));
    h.stub.control(other.depositAddress!, "refund");
    h.clock.t += 30_000;
    await h.poller.recheck(other.id);
    expect(h.store.get(other.id)?.state.status).toBe("refunded");
    expect(h.rewards.entriesFor(BOB.address)).toEqual([]);
    // And a delivered order with no rewards address adds nothing either.
    await delivered(h, { recipient: ADDR.evm3, amount: "7000000000000000" });
    expect(fs.readdirSync(path.join(h.dataDir, "rewards", "entries"))).toHaveLength(1);
  });

  it("shows an address its own points after one signature, and never anyone else's", async () => {
    const h = await start({ practice: true });
    await delivered(h, { rewardsAddress: ALICE.address });
    await delivered(h, { rewardsAddress: BOB.address, recipient: ADDR.evm3 });
    // Without a sign-in: nothing.
    const without: Record<string, string>[] = [{}, { "x-rewards-session": "" }, { "x-rewards-session": "r1.9999999999999.0x0000000000000000000000000000000000000000.AAAA" }, { "x-rewards-session": await h.session() }];
    for (const headers of without) {
      const reply = await h.get("/api/rewards/me", { headers });
      expect(reply.status).toBe(401);
      expect(reply.body).toEqual({ error: { code: "session", message: "Sign in to see your points." } });
    }
    const token = await signedIn(h, ALICE);
    const mine = (await h.get("/api/rewards/me", { headers: { "x-rewards-session": token } })).body as RewardsView;
    expect(mine.address).toBe(ALICE.address);
    expect(mine.swaps).toHaveLength(1);
    expect(BigInt(mine.week.pointsMicro) > 0n).toBe(true);
    expect(JSON.stringify(mine)).not.toContain(BOB.address);
    expect(JSON.stringify(mine)).not.toContain(BOB.address.toLowerCase());
    // The sign-in is for that address only: it cannot be pointed at another by anything sent with the request.
    for (const route of [`/api/rewards/me?address=${BOB.address}`, `/api/rewards/me/${BOB.address}`, `/api/rewards/${BOB.address}`, `/api/rewards/points?address=${BOB.address}`]) {
      const reply = await h.get(route, { headers: { "x-rewards-session": token, "x-address": BOB.address } });
      expect(JSON.stringify(reply.body), route).not.toContain(BOB.address);
      if (reply.status === 200) expect((reply.body as RewardsView).address, route).toBe(ALICE.address);
    }
    // After half an hour the sign-in is over.
    h.clock.t += 30 * 60_000;
    expect((await h.get("/api/rewards/me", { headers: { "x-rewards-session": token } })).status).toBe(401);
  });

  it("a week closed, and then paid, by the tools while the server runs is in the server's next answer", async () => {
    const h = await start({ practice: true });
    await delivered(h, { rewardsAddress: ALICE.address });
    await delivered(h, { rewardsAddress: BOB.address, recipient: ADDR.evm3 });
    const token = await signedIn(h, ALICE);
    const mine = async () => ((await h.get("/api/rewards/me", { headers: { "x-rewards-session": token } })).body as RewardsView).payouts;
    const anyone = async () => (await h.get("/api/rewards")).body as RewardsPublic;
    expect(await mine()).toEqual([]);
    expect(await anyone()).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
    // The tools run in a process of their own, on the same data folder, after the week has ended.
    const week = weekOf(h.clock.t);
    const after = weekBounds(week)!.end;
    const tools = createRewards(h.dataDir);
    const closed = tools.closeWeek(week, 2n * 10n ** 18n, "NEAR", 1n, after, CLEAR);
    const amount = closed.shares.find((share) => share.address === ALICE.address)!.payout;
    // Closed: Alice sees her payout, being sent. Nothing is shown to anyone as paid.
    expect(await mine()).toEqual([{ week, amount, asset: "NEAR", decimals: 18, txs: [] }]);
    expect(await anyone()).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
    // Paid and recorded: both answers have it.
    const hash = `0x${"a1".repeat(32)}`;
    tools.recordPaid(week, [{ address: ALICE.address, hash }], after + 1);
    expect(await mine()).toEqual([{ week, amount, asset: "NEAR", decimals: 18, txs: [hash] }]);
    expect(await anyone()).toMatchObject({ weeks: [{ week, asset: "NEAR", paid: amount, txs: [hash] }], totalPaid: amount, weeksPaid: 1 });
    // What anyone is told still names no address.
    expect(JSON.stringify({ ...(await anyone()), reserve: null })).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
  });

  it("refuses a signature by another wallet, a code used twice, a code that has run out, and a request from elsewhere", async () => {
    const h = await start();
    const session = await h.session();
    const code = async (address = ALICE.address) => (await h.post("/api/rewards/code", { address }, { session })).body as { message: string; nonce: string };
    const signIn = (body: unknown, options = {}) => h.post("/api/rewards/session", body, { session, ...options });
    // Bob signs the message made for Alice.
    const one = await code();
    expect((await signIn({ nonce: one.nonce, signature: await BOB.signMessage({ message: one.message }) })).status).toBe(401);
    // Alice signs another message than the one the server made.
    const two = await code();
    expect((await signIn({ nonce: two.nonce, signature: await ALICE.signMessage({ message: `${two.message} ` }) })).status).toBe(401);
    // Alice signs a message of someone else's wording, and it is sent along: the server checks its own message, never one it is handed.
    const other = await code();
    const handed = "Sign in";
    expect((await signIn({ nonce: other.nonce, message: handed, signature: await ALICE.signMessage({ message: handed }) })).status).toBe(401);
    // A good sign-in, then the same code and signature again.
    const three = await code();
    const signature = await ALICE.signMessage({ message: three.message });
    expect((await signIn({ nonce: three.nonce, signature })).status).toBe(200);
    const replay = await signIn({ nonce: three.nonce, signature });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toEqual({ code: "session", message: "That sign-in did not work. Try again." });
    // A failed attempt uses the code up too.
    const four = await code();
    expect((await signIn({ nonce: four.nonce, signature: "0x1234" })).status).toBe(401);
    expect((await signIn({ nonce: four.nonce, signature: await ALICE.signMessage({ message: four.message }) })).status).toBe(401);
    // A code that has run out.
    const five = await code();
    const late = await ALICE.signMessage({ message: five.message });
    h.clock.t += 5 * 60_000;
    expect((await signIn({ nonce: five.nonce, signature: late })).status).toBe(401);
    // Both halves are only for this site's own pages, with the site's session.
    for (const options of [{ origin: null }, { origin: "https://evil.example" }]) {
      expect((await h.post("/api/rewards/code", { address: ALICE.address }, { session: await h.session(), ...options })).status).toBe(403);
      expect((await h.post("/api/rewards/session", { nonce: "ab".repeat(16), signature: late }, { session: await h.session(), ...options })).status).toBe(403);
    }
    expect((await h.post("/api/rewards/code", { address: ALICE.address }, { session: null })).status).toBe(401);
    expect((await h.post("/api/rewards/session", { nonce: "ab".repeat(16), signature: late }, { session: null })).status).toBe(401);
    for (const bad of ["0x1234", ADDR.sol, "", 5]) expect((await h.post("/api/rewards/code", { address: bad }, { session: await h.session() })).status).toBe(400);
  });

  it("names this site in the message to sign, and sends the parts the message is made of", async () => {
    const h = await start({ env: { SITE_URL: "https://intentswap.example" } });
    const code = (await h.post("/api/rewards/code", { address: ALICE.address.toLowerCase() }, { session: await h.session() })).body as { message: string; nonce: string; issuedAt: string; expiresAt: string };
    expect(code.message.split("\n").slice(0, 2)).toEqual(["intentswap.example wants you to sign in with your Ethereum account:", ALICE.address]);
    expect(code.message.split("\n")[5]).toBe("URI: https://intentswap.example");
    // The code, when it was made and when it runs out: with them the page can put the same message together.
    expect(code.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(code.issuedAt).toBe(new Date(h.clock.t).toISOString());
    expect(code.expiresAt).toBe(new Date(h.clock.t + 5 * 60_000).toISOString());
    expect(Object.keys(code).sort()).toEqual(["expiresAt", "issuedAt", "message", "nonce"]);
    expect(code.message).toBe(signInMessage({ host: "intentswap.example", address: ALICE.address, nonce: code.nonce, issuedAt: code.issuedAt, expiresAt: code.expiresAt }));
    expect(isSignInMessage(code.message, { host: "intentswap.example", address: ALICE.address, nonce: code.nonce, issuedAt: code.issuedAt, expiresAt: code.expiresAt })).toBe(true);
    const local = await start();
    const there = (await local.post("/api/rewards/code", { address: ALICE.address }, { session: await local.session() })).body as { message: string; nonce: string; issuedAt: string; expiresAt: string };
    const host = new URL(local.url).host;
    expect(there.message.split("\n")[0]).toBe(`${host} wants you to sign in with your Ethereum account:`);
    expect(there.message.split("\n")[5]).toBe(`URI: http://${host}`);
    expect(isSignInMessage(there.message, { host, address: ALICE.address, nonce: there.nonce, issuedAt: there.issuedAt, expiresAt: there.expiresAt })).toBe(true);
    // A name that reaches the server only in a forwarding header, which any program can write, is never
    // the name in the message: with no address of its own set, the server gives no code to a page that
    // is not on the host the request itself was made to. (Behind a proxy that changes the host, SITE_URL is set.)
    const proxied = await local.post("/api/rewards/code", { address: ALICE.address }, { session: await local.session(), origin: "https://swap.example", headers: { "x-forwarded-host": "swap.example" } });
    expect(proxied.status).toBe(403);
    expect(JSON.stringify(proxied.body)).not.toContain("swap.example");
    // A page of another site gets no message at all, whatever name it gives.
    expect((await local.post("/api/rewards/code", { address: ALICE.address }, { session: await local.session(), origin: "https://evil.example" })).status).toBe(403);
    // And where the site's own address is set, the message names that and nothing a request says.
    const named = (await h.post("/api/rewards/code", { address: ALICE.address }, { session: await h.session(), origin: "https://other.example", headers: { "x-forwarded-host": "other.example" } })).body as { message: string };
    expect(named.message.split("\n")[0]).toBe("intentswap.example wants you to sign in with your Ethereum account:");
  });

  it("names the host of the request, and only for a page on that host, where the site's address is only the built-in one", () => {
    // The live site told nothing of its address: it is the built-in one, for what the page says of itself.
    const builtIn = { siteUrl: "https://intentswap.app", siteUrlSet: false };
    // The sign-in still names the host the request was made to: its own address, or a preview one.
    expect(signInHost(builtIn, "intentswap.app", "https://intentswap.app")).toBe("intentswap.app");
    expect(signInHost(builtIn, "preview-1234.up.example.app", "https://preview-1234.up.example.app")).toBe("preview-1234.up.example.app");
    // And never for a page of another site, for no page at all, or for a host that is not said.
    expect(signInHost(builtIn, "intentswap.app", "https://evil.example")).toBeNull();
    expect(signInHost(builtIn, "preview-1234.up.example.app", "https://intentswap.app")).toBeNull();
    for (const origin of [undefined, null, "", "not an address", 5]) expect(signInHost(builtIn, "intentswap.app", origin), String(origin)).toBeNull();
    for (const host of [undefined, "", 7]) expect(signInHost(builtIn, host, "https://intentswap.app"), String(host)).toBeNull();
    // With no address at all it is the same rule.
    expect(signInHost({ siteUrl: null, siteUrlSet: false }, "127.0.0.1:8787", "http://127.0.0.1:8787")).toBe("127.0.0.1:8787");
    expect(signInHost({ siteUrl: null, siteUrlSet: false }, "127.0.0.1:8787", "https://evil.example")).toBeNull();
    // Where SITE_URL itself was set, the message names that and nothing a request says.
    const set = { siteUrl: "https://intentswap.example", siteUrlSet: true };
    for (const [host, origin] of [["intentswap.example", "https://intentswap.example"], ["other.example", "https://other.example"], [undefined, undefined]] as const) expect(signInHost(set, host, origin)).toBe("intentswap.example");
  });

  it("limits how often a sign-in can be asked for and tried", async () => {
    const h = await start({ limits: { rewardsNonce: { max: 2, windowMs: 60_000 }, rewardsSignIn: { max: 2, windowMs: 60_000 }, rewardsRead: { max: 2, windowMs: 60_000 } } });
    const session = await h.session();
    const asked: number[] = [];
    for (let i = 0; i < 3; i++) asked.push((await h.post("/api/rewards/code", { address: ALICE.address }, { session })).status);
    expect(asked).toEqual([200, 200, 429]);
    const tried: number[] = [];
    for (let i = 0; i < 3; i++) tried.push((await h.post("/api/rewards/session", { nonce: "ab".repeat(16), signature: `0x${"11".repeat(65)}` }, { session })).status);
    expect(tried).toEqual([401, 401, 429]);
    const read: number[] = [];
    for (let i = 0; i < 3; i++) read.push((await h.get("/api/rewards/me")).status);
    expect(read).toEqual([401, 401, 429]);
    // Someone else is not held up by it.
    expect((await h.post("/api/rewards/code", { address: BOB.address }, { session: await h.session("198.51.100.9"), ip: "198.51.100.9" })).status).toBe(200);
  });

  it("limits sign-in codes by the wider network too (IPv6 /48), between the limit for one address and the limit for everyone", async () => {
    const h = await start({ limits: { rewardsNonce: { max: 2, windowMs: 60_000 }, rewardsNonceWide: { max: 3, windowMs: 60_000 }, rewardsNonceGlobal: { max: 6, windowMs: 60_000 } } });
    const ask = async (ip: string) => (await h.post("/api/rewards/code", { address: ALICE.address }, { session: await h.session(ip), ip })).status;
    // Two from one /64, then that one is told to wait.
    expect([await ask("2001:db8:1:1::1"), await ask("2001:db8:1:1::2"), await ask("2001:db8:1:1::3")]).toEqual([200, 200, 429]);
    // Its neighbours in the same /48 share a larger allowance: one more, then they wait too, whichever of them asks.
    expect([await ask("2001:db8:1:2::1"), await ask("2001:db8:1:3::1"), await ask("2001:db8:1:4::1")]).toEqual([200, 429, 429]);
    // Another network, and a visitor on IPv4, who has no wider network, are not held up by it.
    expect([await ask("2001:db8:2:1::1"), await ask("198.51.100.20"), await ask("198.51.100.21")]).toEqual([200, 200, 200]);
    // Everyone together: six were answered. What the network was refused did not count against the rest; the seventh waits.
    expect(await ask("198.51.100.22")).toBe(429);
  });

  it("tells anyone the week and no pool while no reserve wallet is set", async () => {
    const h = await start({ practice: true });
    await delivered(h, { rewardsAddress: ALICE.address });
    const none = (await h.get("/api/rewards")).body as RewardsPublic;
    expect(none.pool).toBeNull();
    expect(Object.keys(none).sort()).toEqual(["pool", "serverNow", "totalPaid", "week", "weekPointsMicro", "weeks", "weeksPaid"]);
    expect(none.week.id).toBe(weekOf(h.clock.t));
    expect(Date.parse(none.week.end) - Date.parse(none.week.start)).toBe(7 * 86_400_000);
    expect(JSON.stringify(none)).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
    expect((await h.get("/api/config")).body.reserveAddress).toBeNull();
    // Nothing was asked of the chain for it.
    expect(h.rpc.calls.filter((call) => call.call.method === "eth_getBalance")).toEqual([]);
  });

  it("tells anyone the current pool: what the reserve wallet holds in NEAR on BNB Chain, with its decimals and its dollar value, read once a minute at most, with no other coin and no address but the wallet's own", async () => {
    const TOKEN = RESERVE_ASSET.contract;
    const reserve = ADDR.evm3.toLowerCase();
    /** The coin list with NEAR on BNB Chain on it, at this very contract, as the provider lists it: here at $4.80. */
    const listed = { ok: true as const, status: 200, data: [...FIXTURE_TOKENS, { assetId: "nep245:v2_1.omni.hot.tg:56_near", decimals: 18, blockchain: "bsc", symbol: "NEAR", price: 4.8, contractAddress: TOKEN.toLowerCase() }] };
    const holding = (h: Harness, near: bigint, token: string = TOKEN) => h.rpc.tokenBalances.set(`${token.toLowerCase()}:${reserve}`, near);
    const reads = (h: Harness) => h.rpc.calls.filter((call) => call.chain === "bsc" && JSON.stringify(call.call.params).toLowerCase().includes(reserve.slice(2))).length;
    const ask = async (h: Harness) => (await h.get("/api/rewards")).body as RewardsPublic;

    const h = await start({ env: { RESERVE_ADDRESS: ADDR.evm3, TOKEN_ADDRESS: ADDR.evm2 } });
    h.tap.tokensResult = listed;
    // 1,234.5678 NEAR at $4.80 is $5,925.92544. The wallet's BNB, and whatever else it holds, is no part of the pool.
    holding(h, 12_345_678n * 10n ** 14n);
    h.rpc.native.set(reserve, 50n * 10n ** 18n);
    h.rpc.tokenBalances.set(`${ADDR.evm2.toLowerCase()}:${reserve}`, 999n * 10n ** 18n);
    const first = await ask(h);
    expect(first.pool).toEqual({ address: ADDR.evm3, amount: (12_345_678n * 10n ** 14n).toString(), decimals: 18, usdMicro: "5925925440", readAt: new Date(h.clock.t).toISOString() });
    // The answer holds the wallet's own address and no other: not the reward token's contract, not the site's token.
    expect([...new Set(JSON.stringify(first).match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g))]).toEqual([ADDR.evm3]);
    expect(JSON.stringify(first)).not.toMatch(/BNB|ZEC|INT\b|coins/);
    // One thing was asked of BNB Chain: what the reward token's own contract says the wallet holds.
    const asked = h.rpc.calls.filter((call) => call.chain === "bsc" && JSON.stringify(call.call.params).toLowerCase().includes(reserve.slice(2)));
    expect(asked.map((call) => `${call.call.method} ${String((call.call.params[0] as { to?: string }).to ?? "")}`)).toEqual([`eth_call ${TOKEN}`]);
    expect(h.config.rewardTokenAddress).toBe(TOKEN);

    // Asked again within the minute, by anyone: the same figures, and the chain is not read again.
    holding(h, 3n * 10n ** 18n);
    h.clock.t += 59_000;
    expect((await h.get("/api/rewards", { ip: "198.51.100.7" })).body.pool).toEqual(first.pool);
    expect(reads(h)).toBe(1);
    // After 61 seconds it is read again.
    h.clock.t += 2_000;
    const second = await ask(h);
    expect(reads(h)).toBe(2);
    expect(second.pool).toEqual({ address: ADDR.evm3, amount: (3n * 10n ** 18n).toString(), decimals: 18, usdMicro: "14400000", readAt: new Date(h.clock.t).toISOString() });
    // A read that fails changes nothing: the last good figures stand, with the time they were read.
    h.rpc.down = true;
    h.clock.t += 61_000;
    expect((await ask(h)).pool).toEqual(second.pool);
    expect(reads(h)).toBe(3);

    // Where no read has ever worked there is no figure at all: the wallet, and nothing said of what it holds.
    const unread = await start({ env: { RESERVE_ADDRESS: ADDR.evm3 } });
    unread.rpc.down = true;
    expect((await ask(unread)).pool).toEqual({ address: ADDR.evm3, amount: null, decimals: 18, usdMicro: null, readAt: null });

    // With no price for the coin on the list just now, the amount is there and there is no dollar value.
    const unpriced = await start({ env: { RESERVE_ADDRESS: ADDR.evm3 } });
    holding(unpriced, 5n * 10n ** 18n);
    expect((await ask(unpriced)).pool).toEqual({ address: ADDR.evm3, amount: (5n * 10n ** 18n).toString(), decimals: 18, usdMicro: null, readAt: new Date(unpriced.clock.t).toISOString() });

    // Where the setting names another token, that token is the one read, with the decimals it reports itself.
    const other = await start({ env: { RESERVE_ADDRESS: ADDR.evm3, REWARD_TOKEN_ADDRESS: ADDR.evm2.toLowerCase() } });
    expect(other.config.rewardTokenAddress).toBe(ADDR.evm2);
    holding(other, 7_500_000n, ADDR.evm2);
    holding(other, 99n * 10n ** 18n);
    other.rpc.decimals.set(ADDR.evm2.toLowerCase(), 6);
    expect((await ask(other)).pool).toMatchObject({ address: ADDR.evm3, amount: "7500000", decimals: 6, usdMicro: null });
    // And if that token will not say how many decimals it has, nothing is guessed: there is no figure.
    const mute = await start({ env: { RESERVE_ADDRESS: ADDR.evm3, REWARD_TOKEN_ADDRESS: ADDR.evm } });
    holding(mute, 7_500_000n, ADDR.evm);
    expect((await ask(mute)).pool).toMatchObject({ amount: null, readAt: null });
  });

  /** A swap of so many dollars (in millionths), delivered at a moment, written straight into a server's record of points. */
  const swapped = (h: Harness, who: { address: string }, label: string, usdMicro: bigint, at: number) => h.rewards.record({ v: 2, order: orderHash(`test swap ${label}`), address: who.address, week: weekOf(at), at: new Date(at).toISOString(), volumeUsdMicro: usdMicro.toString(), reasons: [], from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDT", chain: "sol" } });

  it("tells anyone the week's points as they stood when the quarter of an hour began, rounded down to two figures: no reading gives away one swap", async () => {
    // Rounded down to two significant figures, and to whole points under ten.
    for (const [points, told] of [[14_908.237, 14_000], [2_500, 2_500], [105, 100], [99.9, 99], [10, 10], [9.7, 9], [0.99, 0], [0, 0], [1_234_567.89, 1_200_000]] as const) expect(roundedPoints(usd(points)), String(points)).toBe(usd(told));
    const h = await start();
    const ask = async () => (await h.get("/api/rewards")).body as RewardsPublic;
    // Alice swapped $250 an hour ago: 2,500 points.
    swapped(h, ALICE, "earlier", usd(250), h.clock.t - 3_600_000);
    const before = await ask();
    expect(before.weekPointsMicro).toBe("2500000000");
    // Now one swap of $1,240.8237 is delivered: 12,408.237 points. Inside this quarter of an hour the total does not move at all.
    swapped(h, BOB, "the one", 1_240_823_700n, h.clock.t + 1000);
    for (const later of [2_000, 60_000, QUARTER_MS - 3_000]) {
      h.clock.t += later - (h.clock.t % QUARTER_MS);
      expect((await ask()).weekPointsMicro, String(later)).toBe(before.weekPointsMicro);
    }
    // At the next quarter it moves: 14,908.237 points, told as 14,000. Nothing in the answer spells the swap's value, its points or the exact total.
    h.clock.t += 3_000;
    const after = await h.get("/api/rewards");
    expect((after.body as RewardsPublic).weekPointsMicro).toBe("14000000000");
    expect(after.text).not.toMatch(/1240\.?8237|12408\.?237|14908\.?237/);
    // The difference between the two readings is the rounding's, not the swap's.
    expect(BigInt((after.body as RewardsPublic).weekPointsMicro) - BigInt(before.weekPointsMicro)).toBe(11_500n * MICRO);
    // A swap delivered in the quarter that has just begun waits for the next one in its turn.
    swapped(h, ALICE, "newest", usd(5_000), h.clock.t);
    expect((await ask()).weekPointsMicro).toBe("14000000000");
  });

  it("gives a signed-in address its share and its estimate, worked out on the server: its own new points count at once, other people's from the next quarter, and the estimate comes from the rounded share", async () => {
    const TOKEN = RESERVE_ASSET.contract;
    const listed = { ok: true as const, status: 200, data: [...FIXTURE_TOKENS, { assetId: "nep245:v2_1.omni.hot.tg:56_near", decimals: 18, blockchain: "bsc", symbol: "NEAR", price: 4.8, contractAddress: TOKEN.toLowerCase() }] };
    const server = async (env: Record<string, string> = { RESERVE_ADDRESS: ADDR.evm3 }) => {
      const h = await start({ env });
      h.tap.tokensResult = listed;
      // The pool: 1,000 NEAR, worth $4,800.
      h.rpc.tokenBalances.set(`${TOKEN.toLowerCase()}:${ADDR.evm3.toLowerCase()}`, 1000n * 10n ** 18n);
      return h;
    };
    const mine = async (h: Harness, who: ReturnType<typeof wallet>, ip: string) => ((await h.get("/api/rewards/me", { headers: { "x-rewards-session": await signedIn(h, who, ip) }, ip })).body as RewardsView).share;
    const NEAR = 10n ** 18n;

    // One address alone, with 100 points from before the quarter: all of it.
    const alone = await server();
    swapped(alone, ALICE, "alone", usd(10), alone.clock.t - 3_600_000);
    expect(await mine(alone, ALICE, "203.0.113.10")).toEqual({ bps: 10_000, estimate: (1000n * NEAR).toString(), estimateCents: "480000", decimals: 18 });

    // Two addresses with 1 point and 99 from before the quarter: 1 point of 100 is 1%.
    const h = await server();
    swapped(h, ALICE, "one", usd(0.1), h.clock.t - 3_600_000);
    swapped(h, BOB, "ninety-nine", usd(9.9), h.clock.t - 3_600_000);
    expect(await mine(h, ALICE, "203.0.113.10")).toEqual({ bps: 100, estimate: (10n * NEAR).toString(), estimateCents: "4800", decimals: 18 });
    expect(await mine(h, BOB, "203.0.113.11")).toEqual({ bps: 9900, estimate: (990n * NEAR).toString(), estimateCents: "475200", decimals: 18 });
    // Alice swaps again, inside this quarter: 100 points more. Her own count at once: 101 of 200. Bob's answer does not move with her swap.
    swapped(h, ALICE, "one more", usd(10), h.clock.t + 1000);
    h.clock.t += 2000;
    expect(await mine(h, ALICE, "203.0.113.10")).toMatchObject({ bps: 5050, estimate: (505n * NEAR).toString() });
    expect(await mine(h, BOB, "203.0.113.11")).toMatchObject({ bps: 9900, estimate: (990n * NEAR).toString() });
    // From the next quarter it counts for everyone: 101 and 99 of 200.
    h.clock.t += QUARTER_MS;
    expect(await mine(h, ALICE, "203.0.113.10")).toMatchObject({ bps: 5050 });
    expect(await mine(h, BOB, "203.0.113.11")).toMatchObject({ bps: 4950, estimate: (495n * NEAR).toString(), estimateCents: "237600" });

    // The estimate is the pool times the share as it is shown, and no finer: a third is 33.33%, so 333.3 NEAR and its own dollars.
    const thirds = await server();
    swapped(thirds, ALICE, "a third", usd(1), thirds.clock.t - 3_600_000);
    swapped(thirds, BOB, "two thirds", usd(2), thirds.clock.t - 3_600_000);
    expect(await mine(thirds, ALICE, "203.0.113.10")).toEqual({ bps: 3333, estimate: (3333n * NEAR / 10n).toString(), estimateCents: "159984", decimals: 18 });
    // The signed-in answer holds the share and nothing of the week's total itself.
    const answer = await thirds.get("/api/rewards/me", { headers: { "x-rewards-session": await signedIn(thirds, ALICE) } });
    expect(Object.keys(answer.body).sort()).toEqual(["address", "allTimeMicro", "payouts", "share", "swaps", "week"]);
    expect(answer.text).not.toMatch(/"30000000"|weekPoints|total/);

    // With no reserve wallet there is a share and no estimate. With no points at all, nothing.
    const bare = await start();
    swapped(bare, ALICE, "bare", usd(1), bare.clock.t - 3_600_000);
    expect(await mine(bare, ALICE, "203.0.113.10")).toEqual({ bps: 10_000, estimate: null, estimateCents: null, decimals: 18 });
    expect(await mine(bare, BOB, "203.0.113.11")).toEqual({ bps: 0, estimate: null, estimateCents: null, decimals: 18 });
  });

  it("does not try a pool read that failed again within the minute, and answers a request that arrives during a read from that read", async () => {
    // The region check is put to every request as it comes in. Here it refuses nobody and counts them, so that the test knows when a request has arrived.
    let arrived = 0;
    const h = await start({ env: { RESERVE_ADDRESS: ADDR.evm3 }, geo: { check: () => ((arrived += 1), { country: null, blocked: false, reason: null }), ready: () => true } });
    const reads = () => h.rpc.calls.filter((call) => call.chain === "bsc" && JSON.stringify(call.call.params).toLowerCase().includes(ADDR.evm3.toLowerCase().slice(2))).length;
    const ask = async () => ((await h.get("/api/rewards")).body as RewardsPublic).pool;
    h.rpc.down = true;
    expect(await ask()).toMatchObject({ amount: null, readAt: null });
    expect(reads()).toBe(1);
    // The chain is back, and within the minute it is not asked again.
    h.rpc.down = false;
    h.rpc.tokenBalances.set(`${RESERVE_ASSET.contract.toLowerCase()}:${ADDR.evm3.toLowerCase()}`, 10n ** 18n);
    h.clock.t += 59_000;
    expect(await ask()).toMatchObject({ amount: null, readAt: null });
    expect(reads()).toBe(1);
    // After the minute it is: and two requests that arrive together are both answered from the one reading.
    h.clock.t += 2_000;
    let release: () => void = () => undefined;
    h.rpc.beforeBatch = () => new Promise<void>((resolve) => (release = resolve));
    const before = arrived;
    const together = [ask(), ask()];
    // The read is let go only once both have arrived, however long the machine takes over that: one holds the read open, and the other came in during it.
    await eventually(() => arrived === before + 2);
    h.rpc.beforeBatch = null;
    release();
    expect(await Promise.all(together)).toEqual([expect.objectContaining({ amount: (10n ** 18n).toString() }), expect.objectContaining({ amount: (10n ** 18n).toString() })]);
    expect(reads()).toBe(2);
  });

  it("no route returns another wallet's points: of everyone else there is one total, and nothing to make a list from", async () => {
    const h = await start({ practice: true, env: { RESERVE_ADDRESS: ADDR.evm3 } });
    await delivered(h, { rewardsAddress: ALICE.address });
    await delivered(h, { rewardsAddress: BOB.address, recipient: ADDR.evm3, amount: "7300000000000000" });
    const alice = h.rewards.view(ALICE.address, h.clock.t).week.pointsMicro;
    const bob = h.rewards.view(BOB.address, h.clock.t).week.pointsMicro;
    expect(BigInt(alice) > 0n && BigInt(bob) > 0n && alice !== bob).toBe(true);
    const total = (BigInt(alice) + BigInt(bob)).toString();
    /** Every value an answer holds, at any depth, as text. */
    const values = (value: unknown): string[] => (value !== null && typeof value === "object" ? Object.values(value).flatMap(values) : [String(value)]);
    // What anyone is told, with no sign-in: the rewards, the site's totals, the settings. Neither address is in any of it, nor either one's points.
    for (const route of ["/api/rewards", "/api/stats", "/api/config", "/api/status", "/api/tokens"]) {
      const reply = await h.get(route);
      expect(reply.status, route).toBe(200);
      const held = values(reply.body);
      for (const who of [ALICE.address, BOB.address]) expect(reply.text.toLowerCase(), route).not.toContain(who.toLowerCase().slice(2));
      for (const figure of [alice, bob]) expect(held, route).not.toContain(figure);
    }
    // The one figure about points is about how many everyone has together: nothing while the quarter of an
    // hour in which the two were delivered lasts, and from the next quarter the total rounded to two figures.
    expect(((await h.get("/api/rewards")).body as RewardsPublic).weekPointsMicro).toBe("0");
    h.clock.t += QUARTER_MS;
    const anyone = (await h.get("/api/rewards")).body as RewardsPublic;
    expect(anyone.weekPointsMicro).toBe(roundedPoints(BigInt(total)).toString());
    expect(anyone.weekPointsMicro).not.toBe(total);
    expect(values(anyone)).not.toContain(total);
    // Signed in, Alice is shown her own points and nothing of Bob's: not his address, not his figure.
    const token = await signedIn(h, ALICE);
    const mine = await h.get("/api/rewards/me", { headers: { "x-rewards-session": token } });
    expect((mine.body as RewardsView).week.pointsMicro).toBe(alice);
    expect(mine.text.toLowerCase()).not.toContain(BOB.address.toLowerCase().slice(2));
    expect(values(mine.body)).not.toContain(bob);
    expect(values(mine.body)).not.toContain(total);
    // No address, a session for another address, or an address in the request: nothing of anyone's points comes back.
    for (const route of [`/api/rewards?address=${BOB.address}`, `/api/rewards/${BOB.address}`, `/api/rewards/me?address=${BOB.address}`, `/api/rewards/points/${BOB.address}`]) {
      const reply = await h.get(route, { headers: { "x-address": BOB.address } });
      expect(values(reply.body), route).not.toContain(bob);
      expect(reply.text.toLowerCase(), route).not.toContain(BOB.address.toLowerCase().slice(2));
    }
  });
});

describe("the Rewards page, before the wallet is opened", () => {
  // The page's own store, with this test's server behind it and a stand-in for the wallet.
  const realFetch = globalThis.fetch;
  /** Changes what the server answered to "give me a code", as a server that had been got at would. */
  let tamper: ((code: Record<string, unknown>) => Record<string, unknown>) | null = null;
  const behind = async (h: Harness) => {
    tamper = null;
    walletAsked.messages = [];
    walletAsked.sign = (message) => ALICE.signMessage({ message });
    useRewards.setState({ session: null, mine: null, step: "idle", error: null });
    vi.stubGlobal("window", { location: { host: new URL(h.url).host } });
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      if (typeof input !== "string" || !input.startsWith("/")) return realFetch(input, init);
      const reply = await realFetch(`${h.url}${input}`, { ...init, headers: { ...(init.headers as Record<string, string>), origin: h.url, "x-forwarded-for": "203.0.113.10" } });
      if (input !== "/api/rewards/code" || tamper === null || !reply.ok) return reply;
      return new Response(JSON.stringify(tamper((await reply.json()) as Record<string, unknown>)), { status: 200, headers: { "content-type": "application/json" } });
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it("puts the server's message together again for this site and this address, and only then asks the wallet to sign it", async () => {
    const h = await start({ practice: true });
    await delivered(h, { rewardsAddress: ALICE.address });
    await behind(h);
    // The wallet gives its address in small letters; the message has it in its standard spelling.
    await useRewards.getState().signIn(ALICE.address.toLowerCase());
    expect(useRewards.getState()).toMatchObject({ step: "idle", error: null, session: { address: ALICE.address } });
    expect(useRewards.getState().mine?.swaps).toHaveLength(1);
    // The wallet was asked once, for the message that names this site and this address.
    const host = new URL(h.url).host;
    expect(walletAsked.messages).toHaveLength(1);
    expect(walletAsked.messages[0]?.split("\n").slice(0, 2)).toEqual([`${host} wants you to sign in with your Ethereum account:`, ALICE.address]);
    expect(parseSiweMessage(walletAsked.messages[0] ?? "")).toMatchObject({ domain: host, address: ALICE.address, uri: `http://${host}`, chainId: 56, statement: SIGN_IN_STATEMENT });
  });

  it("does not open the wallet for a message that names another site or another address, or that is not the message its parts make", async () => {
    const h = await start({ limits: { rewardsNonce: { max: 100, windowMs: 60_000 } } });
    const host = new URL(h.url).host;
    const changes: Record<string, (code: Record<string, unknown>) => Record<string, unknown>> = {
      "another site's name": (code) => ({ ...code, message: String(code.message).replaceAll(host, "evil.example") }),
      "another site's address under this site's name": (code) => ({ ...code, message: String(code.message).replace(`URI: http://${host}`, "URI: https://evil.example") }),
      "another address": (code) => ({ ...code, message: String(code.message).replace(ALICE.address, BOB.address) }),
      "other words": (code) => ({ ...code, message: String(code.message).replace("This is not a transaction. ", "") }),
      "a line more": (code) => ({ ...code, message: `${String(code.message)}\nResources:\n- https://evil.example` }),
      "a transaction's worth of text in place of the message": (code) => ({ ...code, message: "Approve all of your coins" }),
      "a line riding in on the code": (code) => {
        const nonce = `${String(code.nonce)}\nResources:\n- https://evil.example`;
        return { ...code, nonce, message: signInMessage({ host, address: ALICE.address, nonce, issuedAt: String(code.issuedAt), expiresAt: String(code.expiresAt) }) };
      },
      "no time of making": (code) => ({ message: code.message, nonce: code.nonce, expiresAt: code.expiresAt }),
    };
    for (const [what, change] of Object.entries(changes)) {
      await behind(h);
      tamper = change;
      await useRewards.getState().signIn(ALICE.address);
      expect(walletAsked.messages, what).toEqual([]);
      expect(useRewards.getState(), what).toMatchObject({ step: "idle", session: null, mine: null, error: "That sign-in did not work. Try again." });
    }
    // The page on another site than the one the server names: the same, with nothing changed on the way.
    await behind(h);
    vi.stubGlobal("window", { location: { host: "elsewhere.example" } });
    await useRewards.getState().signIn(ALICE.address);
    expect(walletAsked.messages).toEqual([]);
    expect(useRewards.getState().error).toBe("That sign-in did not work. Try again.");
    // Left alone, the same server's message is signed.
    await behind(h);
    await useRewards.getState().signIn(ALICE.address);
    expect(walletAsked.messages).toHaveLength(1);
    expect(useRewards.getState()).toMatchObject({ error: null, session: { address: ALICE.address } });
  });

  it("signs nobody in when the wallet refuses", async () => {
    const h = await start();
    await behind(h);
    walletAsked.sign = null;
    await useRewards.getState().signIn(ALICE.address);
    expect(walletAsked.messages).toHaveLength(1);
    expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, error: "Nothing was signed, so you are not signed in." });
  });

  it("says something else when the wallet was never asked, or could not be reached: nobody is told they refused when they did not", async () => {
    const h = await start();
    await behind(h);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      walletAsked.sign = () => Promise.reject(Object.assign(new Error(`Account ${ALICE.address} not found`), { name: "ConnectorAccountNotFoundError" }));
      await useRewards.getState().signIn(ALICE.address);
      expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, error: "The wallet could not be asked to sign. Reconnect it and try again." });
      walletAsked.sign = () => Promise.reject(Object.assign(new Error("Request already pending"), { code: -32002 }));
      await useRewards.getState().signIn(ALICE.address);
      expect(useRewards.getState()).toMatchObject({ step: "idle", session: null, error: "Open your wallet and unlock it, then sign in again." });
      // What was raised is named for whoever looks, by its name alone: never the address.
      expect(warned.mock.calls.map((call) => String(call[0]))).toEqual(["Rewards sign-in: ConnectorAccountNotFoundError", "Rewards sign-in: Error"]);
      expect(JSON.stringify(warned.mock.calls)).not.toContain(ALICE.address);
    } finally {
      warned.mockRestore();
    }
  });
});

describe("the Rewards page, as it is drawn", () => {
  const week = { id: "2026-W41", start: new Date(MONDAY).toISOString(), end: new Date(MONDAY + 7 * 86_400_000).toISOString() };
  /** The reserve wallet holds 1,234.5678 NEAR, worth $5,925.92544. */
  const POOL = { address: ADDR.evm3, amount: (12_345_678n * 10n ** 14n).toString(), decimals: 18, usdMicro: "5925925440", readAt: new Date(MONDAY + 3_600_000).toISOString() };
  const summaryOf = (pool: RewardsPublic["pool"], points: bigint, extra: Partial<RewardsPublic> = {}): RewardsPublic => ({ week, weekPointsMicro: (points * MICRO).toString(), weeks: [], totalPaid: "0", weeksPaid: 0, pool, serverNow: new Date(MONDAY + 3_600_000).toISOString(), ...extra });
  /** An address's own answer, with its share as the server works it out: out of so many points in all, of the pool handed in. */
  const mineOf = (points: bigint, of: bigint, pool: RewardsPublic["pool"], payouts: RewardsView["payouts"] = []): RewardsView => {
    const part = poolShare(points * MICRO, of * MICRO, pool === null || pool.amount === null ? null : { amount: BigInt(pool.amount), usdMicro: pool.usdMicro === null ? null : BigInt(pool.usdMicro) });
    const share = { bps: Number(part.shareBps), estimate: pool === null || pool.amount === null ? null : part.estimate.toString(), estimateCents: part.estimateCents === null ? null : part.estimateCents.toString(), decimals: 18 };
    return { address: ALICE.address, week: { ...week, pointsMicro: (points * MICRO).toString(), carriedInMicro: "0" }, allTimeMicro: (points * MICRO).toString(), swaps: [], payouts, share };
  };
  /** The page as it is first drawn from what its store holds: put there for the length of one drawing, and taken away again. */
  const draw = (summary: RewardsPublic, mine: RewardsView | null = null): string => {
    const first = useRewards.getInitialState() as unknown as Record<string, unknown>;
    const kept = { summary: first.summary, session: first.session, mine: first.mine };
    Object.assign(first, { summary, mine, session: mine === null ? null : { address: mine.address, token: "t", expiresAt: MONDAY + 7_200_000 } });
    try {
      return renderToStaticMarkup(createElement(RewardsPage));
    } finally {
      Object.assign(first, kept);
    }
  };
  /** What a person reads: tags out, and what is written for a screen reader alone left out, so that an amount is read once. */
  const read = (html: string) => html.replace(/<span class="sr-only">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

  it("has no part for the pool while no reserve wallet is set: nothing stands in its place", () => {
    const html = draw(summaryOf(null, 0n));
    expect(html).not.toMatch(/Current pool|rewards-pool|BscScan|bscscan/);
    expect(read(html)).not.toMatch(/\bpool\b|could not be read/i);
    // The week and its total are there all the same, and say that nobody has points yet.
    expect(read(html)).toContain("This week's points 0 points No points have been collected yet this week.");
    // Signed in, an address still sees its share. With no pool there is no estimate, and nothing in its place.
    const signedIn = read(draw(summaryOf(null, 1000n), mineOf(250n, 1000n, null)));
    expect(signedIn).toContain("Your share 25.00%");
    expect(signedIn).not.toMatch(/Estimated reward|An estimate\.|\$[\d,]+\.\d\d/);
  });

  it("keeps every part's room from the first drawing, before the server has answered: the week with its dates and countdown, and the pool's frame wherever the page itself names a rewards wallet", () => {
    /** The page as it is drawn before any answer, with the wallet the server wrote into the page (or none). */
    const waiting = (wallet: string | null, failed = false): string => {
      const first = useRewards.getInitialState() as unknown as Record<string, unknown>;
      const kept = { summary: first.summary, summaryFailed: first.summaryFailed, session: first.session, mine: first.mine };
      Object.assign(first, { summary: null, summaryFailed: failed, mine: null, session: null });
      vi.stubGlobal("document", { documentElement: { dataset: wallet === null ? {} : { rewardsWallet: wallet } } });
      try {
        return renderToStaticMarkup(createElement(RewardsPage));
      } finally {
        vi.unstubAllGlobals();
        Object.assign(first, kept);
      }
    };
    const parts = (html: string) => [...html.matchAll(/<(?:h2 id="rewards-[a-z]+"|p) class="(rewards-(?:label mono|count mono|heading|pool-total|address)|muted rewards-(?:dates|total-note)|skeleton rewards-total-waiting|rewards-figure mono(?: rewards-pool-line)?|muted rewards-pool-line)"/g)].map((match) => match[1]);

    // No wallet named: the week is whole (the page knows the calendar), the total's line waits in its room, and no pool is drawn.
    const bare = waiting(null);
    expect(read(bare)).toMatch(/This week \d+d \d{2}:\d{2}:\d{2} \w{3} \d+ \w{3} to \w{3} \d+ \w{3}, by the clock in UTC\./);
    expect(bare).toContain('<p class="skeleton rewards-total-waiting" aria-hidden="true"></p>');
    expect(bare).not.toMatch(/Current pool|rewards-pool|bscscan/i);

    // A wallet named: the pool's frame is there at once, with the wallet's own address and link, and room for each figure.
    const framed = waiting(ADDR.evm3);
    expect(framed).toMatch(/<h2 id="rewards-pool" class="rewards-heading">Current pool<\/h2><p class="rewards-pool-total" aria-hidden="true"><span class="skeleton rewards-waiting"><\/span><\/p><p class="rewards-figure mono rewards-pool-line"><\/p>/);
    expect(framed).toContain(`<a href="https://bscscan.com/address/${ADDR.evm3}" target="_blank" rel="noopener noreferrer" class="outbound">View the wallet on BscScan`);
    expect(read(framed)).not.toMatch(/NEAR about|\$[\d,]+\.\d\d|Read from the chain/);
    // The same parts, in the same order, before the answer and after it: nothing is put in between later.
    const answered = draw(summaryOf(POOL, 1000n));
    expect(parts(framed).map((part) => part!.replace("skeleton rewards-total-waiting", "rewards-figure mono"))).toEqual(parts(answered));
    expect(parts(answered)).toContain("rewards-pool-total");
    // Only a plain address is taken from the page, and none once the server has said it cannot be asked.
    expect(waiting("<b>not an address</b>")).not.toMatch(/Current pool/);
    expect(waiting(ADDR.evm3, true)).not.toMatch(/Current pool/);
    // What was paid from the pool stands last, after the rules, so that its arrival moves nothing above it.
    const paid = draw(summaryOf(POOL, 1000n, { weeks: [{ week: "2026-W40", paid: (5n * 10n ** 18n).toString(), asset: "NEAR", decimals: 18, txs: [] }], totalPaid: (5n * 10n ** 18n).toString(), weeksPaid: 1 }));
    expect(paid.indexOf('id="rewards-paid"')).toBeGreaterThan(paid.indexOf('id="rewards-rules"'));
    expect(read(paid)).toContain("Paid out so far: 5 NEAR over 1 week.");
  });

  it("shows the current pool as an amount of NEAR with its dollar value beneath, a link to the wallet on BscScan, and no other coin", () => {
    const html = draw(summaryOf(POOL, 1000n));
    const text = read(html);
    expect(html).toMatch(/<h2 id="rewards-pool" class="rewards-heading">Current pool<\/h2><p class="rewards-pool-total">/);
    // The amount in the site's short form, rounded down, and in full for a screen reader; its dollars beneath.
    expect(text).toContain("Current pool 1,234.56 NEAR about $5,925.92 What the rewards wallet holds in NEAR on BNB Chain");
    expect(html).toContain('<span class="sr-only">1234.5678 NEAR</span>');
    expect(text).toContain("Rewards are paid in NEAR on BNB Chain, to the address you signed in with.");
    // NEAR's own mark beside the amount, as a coin's icon, from the site's own files.
    expect(html).toMatch(/<p class="rewards-pool-total"><span class="coin-icon" data-size="32" aria-hidden="true"><img class="coin-icon-image" src="\/coins\/near\.webp"/);
    expect(html).toContain(`<a href="https://bscscan.com/address/${ADDR.evm3}" target="_blank" rel="noopener noreferrer" class="outbound">View the wallet on BscScan`);
    // Nothing else the wallet holds is listed, and nothing on the page names another coin for rewards.
    expect(text).not.toMatch(/\bZEC\b|Zcash|\$INT|\bBNB\b(?! Chain)|not counted in the total|Binance-Peg/);
    // The week's points are told as a round figure, and said to be one.
    expect(text).toContain("This week's points About 1,000 points Collected by everyone together. Brought up to date every quarter of an hour.");
    expect(read(draw(summaryOf(POOL, 14_000n)))).toContain("This week's points About 14,000 points");
    // Nobody has signed in: no points of any one address, no share, and no address but the wallet's own.
    expect(html).not.toMatch(/rewards-points|Your share|Estimated reward/);
    // (An address is drawn in three parts, so that its two ends stand out: the parts are put together again before it is looked for.)
    expect([...new Set(html.replace(/<\/?span[^>]*>/g, "").replace(/<[^>]+>/g, " ").match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g))]).toEqual([ADDR.evm3]);
    // With no price for the coin just now, the amount is shown and no dollar line.
    const unpriced = read(draw(summaryOf({ ...POOL, usdMicro: null }, 1000n)));
    expect(unpriced).toContain("Current pool 1,234.56 NEAR What the rewards wallet holds in NEAR on BNB Chain");
    expect(unpriced).not.toMatch(/about \$|\$[\d,]+\.\d\d/);
    // Before anyone has points this week: the pool is shown, and the page says so.
    const early = read(draw(summaryOf(POOL, 0n)));
    expect(early).toContain("Current pool 1,234.56 NEAR");
    expect(early).toContain("No points have been collected yet this week.");
    // Where the wallet's balance has never been read: its link, and one plain sentence.
    const unread = draw(summaryOf({ address: ADDR.evm3, amount: null, decimals: 18, usdMicro: null, readAt: null }, 0n));
    expect(read(unread)).toContain("Current pool The balance could not be read just now.");
    expect(unread).toContain("View the wallet on BscScan");
    expect(read(unread)).not.toMatch(/\$[\d,]+\.\d\d|\d NEAR/);
  });

  it("after a sign-in, shows the address its share of the week's points and what that share of the pool comes to in NEAR, with its dollars beside it, and says that it is an estimate", () => {
    const text = read(draw(summaryOf(POOL, 1000n), mineOf(250n, 1000n, POOL)));
    // 250 points of 1,000 is a quarter, and a quarter of 1,234.5678 NEAR is 308.64195: shown rounded down, with a quarter of its dollars.
    expect(text).toContain("Your points this week 250.00");
    expect(text).toContain("Your share 25.00% Estimated reward 308.6419 NEAR about $1,481.48 An estimate. Your share changes as others swap, and the pool changes until the week closes.");
    expect(ESTIMATE_NOTE).toBe("An estimate. Your share changes as others swap, and the pool changes until the week closes.");
    expect(text).not.toContain("Make a swap to collect points.");
    // 1 point of 100 is 1%.
    expect(read(draw(summaryOf(POOL, 100n), mineOf(1n, 100n, POOL)))).toContain("Your share 1.00% Estimated reward 12.3456 NEAR about $59.25");
    // The page shows what the server sent, and works nothing out from the round total anyone is told: here the two do not agree, and the server's stands.
    expect(read(draw(summaryOf(POOL, 9_000n), mineOf(250n, 1000n, POOL)))).toContain("Your share 25.00% Estimated reward 308.6419 NEAR about $1,481.48");
    // With no price for the coin: the estimate in NEAR, and nothing in dollars.
    const unpriced = read(draw(summaryOf({ ...POOL, usdMicro: null }, 1000n), mineOf(250n, 1000n, { ...POOL, usdMicro: null })));
    expect(unpriced).toContain("Your share 25.00% Estimated reward 308.6419 NEAR An estimate.");
    expect(unpriced).not.toMatch(/about \$/);
    // With no points of its own: 0%, and a short way to the swap page.
    const none = draw(summaryOf(POOL, 1000n), mineOf(0n, 1000n, POOL));
    expect(read(none)).toContain("Your share 0% Estimated reward 0 NEAR about $0.00");
    expect(none).toMatch(/<a href="\/"[^>]*>Make a swap to collect points\.<\/a>/);
  });

  it("shows what has been paid in NEAR, and a week that was paid in another coin in that coin", () => {
    const weeks = [
      { week: "2026-W40", asset: "NEAR", decimals: 18, paid: (125n * 10n ** 17n).toString(), txs: [`0x${"a1".repeat(32)}`] },
      { week: "2026-W39", asset: "ZEC", decimals: 18, paid: (3n * 10n ** 18n).toString(), txs: [`0x${"b2".repeat(32)}`] },
    ];
    const payouts = [
      { week: "2026-W40", amount: (25n * 10n ** 17n).toString(), asset: "NEAR", decimals: 18, txs: [] },
      { week: "2026-W39", amount: 10n ** 18n + "", asset: "ZEC", decimals: 18, txs: [] },
    ];
    const text = read(draw(summaryOf(POOL, 1000n, { weeks, totalPaid: (125n * 10n ** 17n).toString(), weeksPaid: 1 }), mineOf(250n, 1000n, POOL, payouts)));
    expect(text).toContain("Paid out so far: 12.5 NEAR over 1 week.");
    expect(text).toContain("Week 40, 2026 12.5 NEAR");
    expect(text).toContain("Week 39, 2026 3 ZEC");
    expect(text).toContain("Week 40, 2026 2.5 NEAR");
    expect(text).toContain("Week 39, 2026 1 ZEC");
    // With every week paid in NEAR, the page nowhere names another coin.
    expect(read(draw(summaryOf(POOL, 1000n, { weeks: weeks.slice(0, 1), totalPaid: weeks[0]!.paid, weeksPaid: 1 }), mineOf(250n, 1000n, POOL, payouts.slice(0, 1))))).not.toMatch(/\bZEC\b|Zcash/);
  });
});

describe("the reserve setting", () => {
  it("must be an address, and not the token's or the pair's", async () => {
    await expect(start({ env: { RESERVE_ADDRESS: "0x1234" } })).rejects.toThrow(/RESERVE_ADDRESS/);
    await expect(start({ env: { TOKEN_ADDRESS: ADDR.evm3, RESERVE_ADDRESS: ADDR.evm3 } })).rejects.toThrow(/RESERVE_ADDRESS/);
    const h = await start({ env: { RESERVE_ADDRESS: ADDR.evm3.toLowerCase() } });
    expect(h.config.reserveAddress).toBe(ADDR.evm3);
  });
});

// The asset list of the harness has the coins these tests swap.
void ASSET;
