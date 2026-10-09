import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { briefPoints, COIN_FAMILIES, countedFeeMicro, feeUsdMicro, isqrt, isSignInMessage, MICRO, nextWeek, pointsMicro, reducedReason, RESERVE_ASSET, REWARDS, sharePool, showPoints, SIGN_IN_STATEMENT, signInMessage, swapPointsMicro, usdToMicro, weekBounds, weekFeeMicro, weekOf, type RewardsPublic, type RewardsView } from "../shared/rewards.ts";
import { silentLogger } from "../server/log.ts";
import { createRewards, createSignIn, entryFor, orderHash, rewardsAddressOf, type PointsEntry, type Rewards, type WeekRecord } from "../server/rewards.ts";
import { checkPayoutTx, exportWeek, recordPayouts, reserveHolds, weekCsv } from "../server/rewards-tools.ts";
import { createSanctions, createStaticSanctions } from "../server/sanctions.ts";
import type { OrderRecord } from "../server/store.ts";
import { useRewards } from "../web/src/stores/rewards.ts";
import { ADDR, asOrder, ASSET, createFakeRpc, harness, putMined, transferLog, type FakeRpc, type Harness, type HarnessOptions } from "./helpers.ts";

// The wallet the Rewards page would open to have its one message signed. Here it is a stand-in
// that writes down what it was asked to sign, and signs it or refuses as a test tells it to.
const walletAsked = vi.hoisted(() => ({ messages: [] as string[], sign: null as ((message: string) => Promise<string>) | null }));
vi.mock("../web/src/wallet/sign-in.ts", () => ({
  signPlainMessage: async (message: string) => {
    walletAsked.messages.push(message);
    if (walletAsked.sign === null) throw new Error("refused in the wallet");
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
    expect(REWARDS).toMatchObject({ pointsPerUsd: 100, reducedShareBps: 1000, weeklyFullFeeUsd: 500, sessionMinutes: 30, chain: "bsc", chainId: 56, holderBoostBps: 0 });
    expect(RESERVE_ASSET).toMatchObject({ chain: "bsc", symbol: "ZEC", decimals: 18, contract: "0x1Ba42e5193dfA8B03D15dd1B86a3113bbBEF8Eeb" });
  });

  it.each([
    ["1234.5678", 20, 2_469_135n],
    ["100", 20, 200_000n],
    ["0.000001", 10_000, 1n],
    ["0.0000009", 10_000, 0n],
    ["2500", 0, 0n],
    ["1000000", 25, 2_500_000_000n],
  ])("the fee on $%s paid at %s basis points is %s millionths of a dollar, rounded down", (paid, bps, expected) => {
    expect(feeUsdMicro(paid, bps)).toBe(expected);
  });

  it.each([[undefined], [null], [""], ["1e3"], ["-5"], ["12.5.1"], [1234], ["NaN"], ["1".repeat(41)]])("no dollar value (%s) gives no fee, not a guess", (paid) => {
    expect(feeUsdMicro(paid, 20)).toBeNull();
    expect(usdToMicro(paid)).toBeNull();
  });

  it("refuses a share of the fee that is not a whole number of basis points between nothing and all", () => {
    for (const bps of [-1, 10_001, 0.5, Number.NaN]) expect(feeUsdMicro("100", bps)).toBeNull();
  });

  it.each([
    ["USDT", "USDC", "dollar_pair"],
    ["usdc", "DAI", "dollar_pair"],
    ["USDC", "USDC", "same_coin"],
    ["ETH", "eth", "same_coin"],
    // A coin and its wrapped self are one coin, whichever way round and however the symbol is written.
    ["ETH", "WETH", "same_coin"],
    ["weth", "ETH", "same_coin"],
    ["BTC", "WBTC", "same_coin"],
    ["cbBTC", "BTC", "same_coin"],
    ["WBTC", "cbBTC", "same_coin"],
    ["BNB", "WBNB", "same_coin"],
    ["wSOL", "SOL", "same_coin"],
    ["NEAR", "wNEAR", "same_coin"],
    ["ETH", "USDT", null],
    ["USDT", "BTC", null],
    ["ZEC", "SOL", null],
    // Two wrapped coins of different families are two coins, and so is a wrapped coin and a dollar coin.
    ["WETH", "WBTC", null],
    ["ETH", "WBNB", null],
    ["WETH", "USDC", null],
    ["WBTC", "ZEC", null],
  ])("a swap of %s for %s counts at the reduced share: %s", (from, to, expected) => {
    expect(reducedReason(from, to)).toBe(expected);
  });

  it("names the coins that are one coin under two names, in capitals, each in one family only", () => {
    expect(COIN_FAMILIES).toEqual([
      ["ETH", "WETH"],
      ["BTC", "WBTC", "CBBTC"],
      ["BNB", "WBNB"],
      ["SOL", "WSOL"],
      ["NEAR", "WNEAR"],
    ]);
    const all = COIN_FAMILIES.flat();
    expect(new Set(all).size).toBe(all.length);
    for (const symbol of all) expect(symbol).toBe(symbol.toUpperCase());
  });

  it("counts a reduced swap at a tenth of its fee, and any other in full", () => {
    expect(countedFeeMicro(usd(12.5), false)).toBe(usd(12.5));
    expect(countedFeeMicro(usd(12.5), true)).toBe(usd(1.25));
    expect(countedFeeMicro(9n, true)).toBe(0n);
  });

  it.each([
    [0n, 0n],
    [1n, 1n],
    [3n, 1n],
    [4n, 2n],
    [15n, 3n],
    [16n, 4n],
    [10n ** 24n, 10n ** 12n],
    [10n ** 24n - 1n, 10n ** 12n - 1n],
  ])("the whole-number square root of %s is %s", (value, root) => {
    expect(isqrt(value)).toBe(root);
    expect(() => isqrt(-1n)).toThrow();
  });

  it.each([
    [0, 0],
    [1.5, 1.5],
    [499.999999, 499.999999],
    [500, 500],
    // Beyond the ceiling: the square root of the excess, in dollars; or the excess itself, where that is less.
    [500.25, 500.25],
    [501, 501],
    [504, 502],
    [600, 510],
    [10_500, 600],
    [1_000_500, 1500],
  ])("in one week $%s of fee counts as $%s", (sum, counted) => {
    expect(weekFeeMicro(usd(sum))).toBe(usd(counted));
  });

  it("never lets more fee count for less: the count rises with the fee, and never above it", () => {
    let before = -1n;
    for (const sum of [0, 1, 499, 500, 500.000001, 500.5, 501, 750, 5000, 1e6, 1e9]) {
      const counted = weekFeeMicro(usd(sum));
      expect(counted >= before, String(sum)).toBe(true);
      expect(counted <= usd(sum), String(sum)).toBe(true);
      before = counted;
    }
  });

  it("gives a hundred points for each dollar of fee that counts, and shows them rounded down", () => {
    expect(pointsMicro(usd(1))).toBe(100n * MICRO);
    expect(pointsMicro(usd(0.025))).toBe(2_500_000n);
    expect(showPoints(pointsMicro(usd(12.3456789)))).toBe("1,234.56");
    expect(showPoints(999_999n)).toBe("0.99");
    expect(showPoints(0n)).toBe("0.00");
    expect(showPoints(-5n)).toBe("0.00");
    expect(showPoints(1_234_567_890_000n)).toBe("1,234,567.89");
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
    amountInUsd: "1250.00",
    amountOutUsd: "1245.00",
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
  it("is counted from the fee of a delivered order: 100 points for each dollar of IntentSwap's own fee", () => {
    const entry = entryFor(stored())!;
    // $1,250 paid at 20 basis points is a fee of $2.50: 250 points.
    expect(entry).toMatchObject({ v: 1, order: orderHash("A".repeat(27)), address: ALICE.address, week: "2026-W41", feeUsdMicro: "2500000", countedMicro: "2500000", reasons: [], from: { symbol: "ETH", chain: "base" }, to: { symbol: "USDT", chain: "sol" } });
    expect(pointsMicro(BigInt(entry.countedMicro))).toBe(250n * MICRO);
    // The order's own ID is not in it, nor any address but the rewards address.
    expect(JSON.stringify(entry)).not.toContain("A".repeat(27));
    expect(Object.keys(entry).sort()).toEqual(["address", "at", "countedMicro", "feeUsdMicro", "from", "order", "reasons", "to", "v", "week"]);
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

  it("a swap between two dollar coins, or of a coin for itself, counts at a tenth and says why", () => {
    const dollars = entryFor(stored({ from: { id: "a", symbol: "USDC", name: "", chain: "base", decimals: 6, contract: "x" }, to: { id: "b", symbol: "USDT", name: "", chain: "sol", decimals: 6, contract: "y" } }))!;
    expect(dollars).toMatchObject({ feeUsdMicro: "2500000", countedMicro: "250000", reasons: ["dollar_pair"] });
    const same = entryFor(stored({ from: { id: "a", symbol: "ETH", name: "", chain: "base", decimals: 18, contract: null }, to: { id: "b", symbol: "ETH", name: "", chain: "arb", decimals: 18, contract: null } }))!;
    expect(same).toMatchObject({ countedMicro: "250000", reasons: ["same_coin"] });
  });

  it("a swap of a coin for its wrapped self counts at a tenth, like the same coin on another chain", () => {
    const wrapped = entryFor(stored({ from: { id: "a", symbol: "ETH", name: "", chain: "base", decimals: 18, contract: null }, to: { id: "b", symbol: "WETH", name: "", chain: "base", decimals: 18, contract: "y" } }))!;
    expect(wrapped).toMatchObject({ feeUsdMicro: "2500000", countedMicro: "250000", reasons: ["same_coin"] });
    const bitcoin = entryFor(stored({ from: { id: "a", symbol: "cbBTC", name: "", chain: "base", decimals: 8, contract: "x" }, to: { id: "b", symbol: "BTC", name: "", chain: "btc", decimals: 8, contract: null } }))!;
    expect(bitcoin).toMatchObject({ countedMicro: "250000", reasons: ["same_coin"] });
    // The points a quote is shown to add follow the same rule.
    expect(swapPointsMicro("1265.13", 20, "ETH", "WETH")).toBe(25_302_600n);
    expect(swapPointsMicro("1265.13", 20, "WETH", "WBTC")).toBe(253_026_000n);
  });

  it("an order the provider gave no dollar value for adds an entry of no points, which says why", () => {
    expect(entryFor(stored({ amountInUsd: "" }))).toMatchObject({ feeUsdMicro: "0", countedMicro: "0", reasons: ["no_usd_value"] });
  });

  it("belongs to the week in which it was delivered, not the one in which it was made", () => {
    expect(entryFor(stored({ createdAt: new Date(MONDAY - 60_000).toISOString(), finishedAt: new Date(MONDAY + 60_000).toISOString() }))?.week).toBe("2026-W41");
    expect(entryFor(stored({ finishedAt: new Date(MONDAY - 1).toISOString() }))?.week).toBe("2026-W40");
  });
});

describe("the points a quote is shown to add", () => {
  it("are the points the server counts for the same swap once it is delivered", () => {
    const pairs = [
      [{ symbol: "ETH", chain: "base" }, { symbol: "USDT", chain: "sol" }],
      [{ symbol: "USDC", chain: "base" }, { symbol: "USDT", chain: "sol" }],
      [{ symbol: "ETH", chain: "base" }, { symbol: "ETH", chain: "arb" }],
    ] as const;
    for (const [from, to] of pairs) {
      for (const amountInUsd of ["1265.13", "0.99", "250000", "12.3456789"]) {
        const record = stored({ amountInUsd, from: { id: "a", name: "", decimals: 18, contract: null, ...from }, to: { id: "b", name: "", decimals: 6, contract: "y", ...to } });
        const entry = entryFor(record)!;
        expect(swapPointsMicro(amountInUsd, record.fees.appBps, from.symbol, to.symbol), `${from.symbol} to ${to.symbol}, $${amountInUsd}`).toBe(pointsMicro(BigInt(entry.countedMicro)));
      }
    }
  });

  it("are 100 for each dollar of the fee, a tenth of that between dollar coins, and nothing where no dollar value is known", () => {
    // $1,265.13 at 0.20% is a fee of $2.53026.
    expect(swapPointsMicro("1265.13", 20, "ETH", "USDT")).toBe(253_026_000n);
    expect(swapPointsMicro("1265.13", 20, "USDC", "USDT")).toBe(25_302_600n);
    expect(swapPointsMicro("1265.13", 20, "ETH", "eth")).toBe(25_302_600n);
    for (const none of ["", null, undefined, "1e3", "-5", "12,5"]) expect(swapPointsMicro(none, 20, "ETH", "USDT"), String(none)).toBeNull();
    expect(swapPointsMicro("1265.13", 20.5, "ETH", "USDT")).toBeNull();
  });

  it("are written short: two decimals, rounded down, with no noughts at the end", () => {
    expect(briefPoints(253_026_000n)).toBe("253.02");
    expect(briefPoints(25_302_600n)).toBe("25.3");
    expect(briefPoints(20_000_000n)).toBe("20");
    expect(briefPoints(1_234_000_000n)).toBe("1,234");
    expect(briefPoints(1_000_500_000n)).toBe("1,000.5");
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
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "3750" }));
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
    // Told once more after the restart, it is still one entry, with the fee it had the first time.
    again.recordDelivered({ ...order, amountInUsd: "999999" });
    expect(again.entriesFor(ALICE.address)).toHaveLength(1);
    expect(again.entriesFor(ALICE.address)[0]?.feeUsdMicro).toBe("2500000");
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

  it("sums an address's week under the ceiling, and keeps each address's points apart", () => {
    const rewards = createRewards(tempDir());
    // Alice: three swaps with fees of $400, $300 and $104 in one week: $804, which counts as 500 + the root of 304.
    for (const [index, paid] of ["200000", "150000", "52000"].entries()) rewards.recordDelivered(stored({ id: `${"B".repeat(26)}${index}`, amountInUsd: paid }));
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, sender: BOB.address }));
    const week = rewards.weekPoints("2026-W41");
    expect(week.get(ALICE.address)).toBe(pointsMicro(usd(500) + isqrt(usd(304) * MICRO)));
    expect(week.get(BOB.address)).toBe(250n * MICRO);
    expect([...week.keys()].sort()).toEqual([ALICE.address, BOB.address].sort());
    expect(rewards.weekPoints("2026-W42").size).toBe(0);
    const view = rewards.view(ALICE.address, MONDAY + 86_400_000);
    expect(view.week).toMatchObject({ id: "2026-W41", ceiling: true, pointsMicro: week.get(ALICE.address)!.toString() });
    expect(view.swaps).toHaveLength(3);
    // Each swap is shown with its own points; the ceiling shows in the week's total.
    expect(view.swaps.map((swap) => swap.pointsMicro).sort()).toEqual([pointsMicro(usd(104)), pointsMicro(usd(300)), pointsMicro(usd(400))].map(String).sort());
    expect(JSON.stringify(view)).not.toContain(BOB.address);
    expect(JSON.stringify(rewards.view(BOB.address, MONDAY))).not.toContain(ALICE.address);
  });

  it("closes a week once: the same pool gives the same record, another pool is refused, and a week still running cannot be closed", () => {
    const dir = tempDir();
    const rewards = quarters(dir);
    expect(() => rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end - 1, CLEAR)).toThrow(/has not ended/);
    expect(() => rewards.closeWeek("2026-41", 10n ** 18n, "ZEC", 1n, end, CLEAR)).toThrow(/not a week/);
    const closed = rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, CLEAR);
    // Alice has 250 points and Bob 750: a quarter and three quarters.
    expect(closed.shares).toEqual(
      [
        { address: ALICE.address, pointsMicro: "250000000", payout: "250000000000000000", carriedMicro: "0" },
        { address: BOB.address, pointsMicro: "750000000", payout: "750000000000000000", carriedMicro: "0" },
      ].sort((a, b) => (a.address < b.address ? -1 : 1)),
    );
    expect(BigInt(closed.paid) + BigInt(closed.left)).toBe(10n ** 18n);
    // Kept with the week: the fee that counted in it ($2.50 and $7.50), and the list its payouts were screened against.
    expect(closed).toMatchObject({ countedFeeUsdMicro: "10000000", screenedWith: "test-list", txs: [] });
    const file = fs.readFileSync(path.join(dir, "rewards", "weeks", "2026-W41.json"), "utf8");
    // Closed again a day later, and by a fresh reading of the same folder: the very same record.
    expect(rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end + 86_400_000, CLEAR)).toEqual(closed);
    expect(createRewards(dir).closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end + 2 * 86_400_000, CLEAR)).toEqual(closed);
    expect(fs.readFileSync(path.join(dir, "rewards", "weeks", "2026-W41.json"), "utf8")).toBe(file);
    expect(() => rewards.closeWeek("2026-W41", 2n * 10n ** 18n, "ZEC", 1n, end, CLEAR)).toThrow(/already closed/);
    // A swap delivered late into that week, after it was closed, does not change what was shared out.
    rewards.recordDelivered(stored({ id: "D".repeat(27), amountInUsd: "9999" }));
    expect(rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, CLEAR)).toEqual(closed);
  });

  it("works out what closing a week would write without writing it", () => {
    const dir = tempDir();
    const rewards = quarters(dir);
    const before = everything(dir);
    const plan = rewards.planWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, CLEAR);
    expect(everything(dir)).toEqual(before);
    expect(rewards.week("2026-W41")).toBeNull();
    // It refuses what closing refuses, and closing writes exactly what it showed.
    expect(() => rewards.planWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end - 1, CLEAR)).toThrow(/has not ended/);
    expect(rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, CLEAR)).toEqual(plan);
    expect(rewards.planWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end + 5, CLEAR)).toEqual(plan);
    expect(() => rewards.planWeek("2026-W41", 1n, "ZEC", 1n, end, CLEAR)).toThrow(/already closed/);
  });

  it("carries a share too small to send into the next week, as points", () => {
    const rewards = createRewards(tempDir());
    rewards.recordDelivered(stored({ amountInUsd: "5" }));
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "500000" }));
    const closed = rewards.closeWeek("2026-W41", 10n ** 15n, "ZEC", RESERVE_ASSET.minPayout, end, CLEAR);
    const alice = closed.shares.find((share) => share.address === ALICE.address)!;
    expect(alice).toMatchObject({ payout: "0", carriedMicro: "1000000" });
    // The week after, Alice starts with what was carried, and a new swap adds to it.
    expect(rewards.weekPoints("2026-W42").get(ALICE.address)).toBe(1_000_000n);
    rewards.recordDelivered(stored({ id: "E".repeat(27), finishedAt: new Date(end + 60_000).toISOString(), amountInUsd: "1000" }));
    expect(rewards.weekPoints("2026-W42").get(ALICE.address)).toBe(1_000_000n + 200n * MICRO);
    const view = rewards.view(ALICE.address, end + 120_000);
    expect(view.week).toMatchObject({ id: "2026-W42", carriedInMicro: "1000000", pointsMicro: (1_000_000n + 200n * MICRO).toString() });
    // Points are counted once in the total over all time, in the week their swap was delivered.
    expect(view.allTimeMicro).toBe((1_000_000n + 200n * MICRO).toString());
    expect(view.payouts).toEqual([]);
    expect(rewards.view(BOB.address, end).payouts).toEqual([{ week: "2026-W41", amount: closed.shares.find((share) => share.address === BOB.address)!.payout, asset: "ZEC", txs: [] }]);
  });

  it("closes a week with a pool of nothing: nothing is to be sent, and every address's points are carried", () => {
    const rewards = quarters();
    const closed = rewards.closeWeek("2026-W41", 0n, "ZEC", RESERVE_ASSET.minPayout, end, CLEAR);
    expect(closed).toMatchObject({ pool: "0", paid: "0", left: "0", totalPointsMicro: "1000000000" });
    expect(shareOf(closed, ALICE)).toEqual({ address: ALICE.address, pointsMicro: "250000000", payout: "0", carriedMicro: "250000000" });
    expect(shareOf(closed, BOB)).toEqual({ address: BOB.address, pointsMicro: "750000000", payout: "0", carriedMicro: "750000000" });
    const next = rewards.weekPoints("2026-W42");
    expect([next.get(ALICE.address), next.get(BOB.address)]).toEqual([250n * MICRO, 750n * MICRO]);
    expect(rewards.view(ALICE.address, end + 1)).toMatchObject({ payouts: [], week: { id: "2026-W42", carriedInMicro: "250000000" } });
    expect(() => rewards.closeWeek("2026-W42", -1n, "ZEC", 1n, end + WEEK_MS, CLEAR)).toThrow();
  });

  it("closes weeks in order: not while an earlier week that holds points is still open", () => {
    const rewards = createRewards(tempDir());
    // Alice's swap is delivered in week 41, Bob's in week 42.
    rewards.recordDelivered(stored());
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, finishedAt: new Date(end + 3_600_000).toISOString() }));
    const later = end + WEEK_MS;
    expect(() => rewards.planWeek("2026-W42", 10n ** 18n, "ZEC", 1n, later, CLEAR)).toThrow(/Week 2026-W41 holds points and is still open\. Close it first/);
    expect(() => rewards.closeWeek("2026-W42", 10n ** 18n, "ZEC", 1n, later, CLEAR)).toThrow(/Week 2026-W41 holds points and is still open\. Close it first/);
    expect(rewards.week("2026-W42")).toBeNull();
    rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, later, CLEAR);
    expect(rewards.closeWeek("2026-W42", 10n ** 18n, "ZEC", 1n, later, CLEAR).shares.map((share) => share.address)).toEqual([BOB.address]);
    // A week in which nothing was delivered, and into which nothing was carried, holds no points: it is no one's to wait for.
    rewards.recordDelivered(stored({ id: "D".repeat(27), finishedAt: new Date(end + 2 * WEEK_MS + 3_600_000).toISOString() }));
    expect(rewards.closeWeek("2026-W44", 10n ** 18n, "ZEC", 1n, end + 3 * WEEK_MS, CLEAR).shares).toHaveLength(1);
    // Nor is a week whose only swap added no points.
    rewards.recordDelivered(stored({ id: "E".repeat(27), amountInUsd: "", finishedAt: new Date(end + 3 * WEEK_MS + 3_600_000).toISOString() }));
    expect(rewards.weekPoints("2026-W45").size).toBe(0);
    expect(rewards.closeWeek("2026-W46", 10n ** 18n, "ZEC", 1n, end + 5 * WEEK_MS, CLEAR).shares).toEqual([]);
  });

  it("carries points through every week between: what was carried out of week 41 reaches week 43 by way of week 42", () => {
    const rewards = createRewards(tempDir());
    // Week 41: Alice's share is too small to send, and her one point is carried.
    rewards.recordDelivered(stored({ amountInUsd: "5" }));
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "500000" }));
    expect(shareOf(rewards.closeWeek("2026-W41", 10n ** 15n, "ZEC", RESERVE_ASSET.minPayout, end, CLEAR), ALICE).carriedMicro).toBe("1000000");
    // Nothing is delivered in week 42. Bob swaps again in week 43.
    rewards.recordDelivered(stored({ id: "D".repeat(27), rewardsAddress: BOB.address, amountInUsd: "500000", finishedAt: new Date(end + WEEK_MS + 3_600_000).toISOString() }));
    const after = end + 2 * WEEK_MS;
    // Week 43 is not closed over week 42's head: Alice's point is in week 42, and would be lost there.
    expect(() => rewards.closeWeek("2026-W43", 10n ** 18n, "ZEC", 1n, after, CLEAR)).toThrow(/Week 2026-W42 holds points and is still open\. Close it first, with a pool of nothing if nothing is to be paid for it\./);
    expect(rewards.week("2026-W43")).toBeNull();
    // Week 42 is closed with nothing to pay, and the point goes on.
    const middle = rewards.closeWeek("2026-W42", 0n, "ZEC", RESERVE_ASSET.minPayout, after, CLEAR);
    expect(middle.shares).toEqual([{ address: ALICE.address, pointsMicro: "1000000", payout: "0", carriedMicro: "1000000" }]);
    expect(rewards.weekPoints("2026-W43").get(ALICE.address)).toBe(1_000_000n);
    const last = rewards.closeWeek("2026-W43", 10n ** 18n, "ZEC", 1n, after, CLEAR);
    expect(shareOf(last, ALICE)).toMatchObject({ pointsMicro: "1000000", carriedMicro: "0" });
    expect(BigInt(shareOf(last, ALICE).payout) > 0n).toBe(true);
  });

  it("screens the payout list as a week is closed: a listed address is sent nothing and carries nothing, and its share stays in the reserve", () => {
    const rewards = quarters();
    // The list names Bob, in small letters: an address is the same address however it is written.
    const closed = rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, createStaticSanctions([BOB.address.toLowerCase()]));
    // Alice has her quarter and no more: Bob's three quarters are not handed to her.
    expect(shareOf(closed, ALICE)).toEqual({ address: ALICE.address, pointsMicro: "250000000", payout: "250000000000000000", carriedMicro: "0" });
    expect(shareOf(closed, BOB)).toEqual({ address: BOB.address, pointsMicro: "750000000", payout: "0", carriedMicro: "0", withheld: "750000000000000000" });
    expect(closed).toMatchObject({ pool: (10n ** 18n).toString(), paid: "250000000000000000", left: "750000000000000000", totalPointsMicro: "1000000000", screenedWith: "test-list" });
    // Nothing is carried for it, and its own view shows no payout for the week.
    expect(rewards.weekPoints("2026-W42").has(BOB.address)).toBe(false);
    expect(rewards.view(BOB.address, end + 1)).toMatchObject({ payouts: [], week: { id: "2026-W42", carriedInMicro: "0", pointsMicro: "0" } });
    expect(rewards.view(ALICE.address, end + 1).payouts).toEqual([{ week: "2026-W41", amount: "250000000000000000", asset: "ZEC", txs: [] }]);
    // And no transaction can be written down as having paid it.
    expect(() => rewards.recordPaid("2026-W41", [{ address: BOB.address, hash: `0x${"b2".repeat(32)}` }], end + 2)).toThrow(/has no payout in week 2026-W41/);
    // The same week closed against a list that names nobody sends Bob his share: the screening is what kept it back.
    expect(shareOf(quarters().closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, CLEAR), BOB)).toMatchObject({ payout: "750000000000000000", carriedMicro: "0" });
  });

  it("closes nothing while the sanctions list is missing or out of date, as no order is made without it", async () => {
    const dir = tempDir();
    const rewards = quarters(dir);
    const none = createStaticSanctions([], { available: false });
    expect(() => rewards.planWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, none)).toThrow(/sanctions list is missing or out of date, so the payouts cannot be screened\. Nothing was closed/);
    expect(() => rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, none)).toThrow(/sanctions list is missing or out of date, so the payouts cannot be screened\. Nothing was closed/);
    // Not even a week with nothing to pay.
    expect(() => rewards.closeWeek("2026-W41", 0n, "ZEC", 1n, end, none)).toThrow(/sanctions list is missing or out of date/);
    expect(fs.readdirSync(path.join(dir, "rewards", "weeks"))).toEqual([]);

    // The list service the server screens orders with, on a saved list that cannot be fetched again.
    const listDir = tempDir();
    fs.mkdirSync(path.join(listDir, "sanctions"));
    const save = (fetchedAt: number) => fs.writeFileSync(path.join(listDir, "sanctions", "sdn-addresses.json"), JSON.stringify({ publishDate: "2026-10-01", fetchedAt, addresses: [...Array.from({ length: 300 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`), BOB.address] }));
    const service = () => createSanctions({ dataDir: listDir, log: silentLogger, alerts: { send() {} }, fetchImpl: async () => Promise.reject(new Error("offline")), now: () => end });
    // Never loaded.
    expect(() => rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, service())).toThrow(/sanctions list is missing or out of date/);
    // Saved three days and an hour ago: older than the list may be for an order, so older than it may be for a payout.
    save(end - 73 * 3_600_000);
    const stale = service();
    await stale.refresh();
    expect(stale.available()).toBe(false);
    expect(() => rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, stale)).toThrow(/sanctions list is missing or out of date/);
    expect(fs.readdirSync(path.join(dir, "rewards", "weeks"))).toEqual([]);
    // Saved an hour ago: it is used, and it names Bob.
    save(end - 3_600_000);
    const fresh = service();
    await fresh.refresh();
    const closed = rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, fresh);
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
    expect(() => rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, CLEAR)).toThrow(/Week 2026-W41 has a record that cannot be read\. It was left as it is/);
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
    expect(rewards.week("2026-W41")).toBeNull();
    expect(rewards.summary(end)).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
    expect(rewards.view(ALICE.address, end).payouts).toEqual([]);
  });

  it("keeps, with each share, the transaction that paid it, and shows an address its own transfer and no one else's", () => {
    const rewards = quarters();
    rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, CLEAR);
    const forAlice = `0x${"a1".repeat(32)}`;
    const forBob = `0x${"b2".repeat(32)}`;
    const payouts = (who: { address: string }) => rewards.view(who.address, end + 10).payouts;
    // Closed and not yet sent: each sees its amount, and no transaction.
    expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: "250000000000000000", asset: "ZEC", txs: [] }]);
    // Alice's is recorded, however the address and the hash are spelled.
    const one = rewards.recordPaid("2026-W41", [{ address: ALICE.address.toLowerCase(), hash: forAlice.toUpperCase().replace("0X", "0x") }], end + 2);
    expect(shareOf(one, ALICE).tx).toBe(forAlice);
    expect(shareOf(one, BOB).tx).toBeUndefined();
    expect(one.txs).toEqual([{ hash: forAlice, recordedAt: new Date(end + 2).toISOString() }]);
    expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: "250000000000000000", asset: "ZEC", txs: [forAlice] }]);
    // Bob's is still being sent: he is not shown the transaction that paid Alice.
    expect(payouts(BOB)).toEqual([{ week: "2026-W41", amount: "750000000000000000", asset: "ZEC", txs: [] }]);
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
    rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, later, CLEAR);
    rewards.closeWeek("2026-W42", 10n ** 18n, "ZEC", 1n, later, CLEAR);
    const hash = `0x${"a1".repeat(32)}`;
    expect(rewards.weekOfTx(hash)).toBeNull();
    rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash }], later);
    expect(rewards.weekOfTx(hash.toUpperCase().replace("0X", "0x"))).toBe("2026-W41");
    expect(() => rewards.recordPaid("2026-W42", [{ address: ALICE.address, hash }], later)).toThrow(/is on record for week 2026-W41 already/);
    expect(rewards.week("2026-W42")).toMatchObject({ txs: [] });
    expect(rewards.week("2026-W42")?.shares[0]?.tx).toBeUndefined();
  });

  it("tells anyone the week's dates and what the paid weeks have on record as sent, and nothing about any address", () => {
    const rewards = quarters();
    const closed = rewards.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, CLEAR);
    // Closed but not yet paid: not on the public list.
    expect(rewards.summary(end + 1)).toMatchObject({ week: { id: "2026-W42" }, weeks: [], totalPaid: "0", weeksPaid: 0 });
    const hash = `0x${"9a".repeat(32)}`;
    // Alice's quarter is on record as sent and Bob's three quarters are not: the week has paid a quarter, whatever was worked out for it.
    rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash }], end + 2);
    expect(closed.paid).toBe((10n ** 18n).toString());
    expect(rewards.summary(end + 3)).toMatchObject({ weeks: [{ week: "2026-W41", asset: "ZEC", paid: "250000000000000000", txs: [hash] }], totalPaid: "250000000000000000", weeksPaid: 1 });
    const second = `0x${"9b".repeat(32)}`;
    rewards.recordPaid("2026-W41", [{ address: BOB.address, hash: second }], end + 4);
    const summary = rewards.summary(end + 5);
    expect(summary).toMatchObject({ weeks: [{ week: "2026-W41", asset: "ZEC", paid: (10n ** 18n).toString(), txs: [hash, second] }], totalPaid: (10n ** 18n).toString(), weeksPaid: 1 });
    expect(JSON.stringify(summary)).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
    expect(JSON.stringify(summary)).not.toMatch(/points/i);
  });

  it("still reads a week written before a share kept its own transaction, and shows nothing as sent that is not on record share by share", () => {
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
    expect(rewards.view(ALICE.address, end + 2).payouts).toEqual([{ week: "2026-W41", amount: "250", asset: "ZEC", txs: [] }]);
    // Its transaction is on record all the same, so it cannot be recorded for another week.
    expect(rewards.weekOfTx(earlier)).toBe("2026-W41");
    // A share of it can still be given the transfer that paid it.
    const own = `0x${"9c".repeat(32)}`;
    rewards.recordPaid("2026-W41", [{ address: ALICE.address, hash: own }], end + 3);
    expect(rewards.summary(end + 4)).toMatchObject({ weeks: [{ week: "2026-W41", paid: "250", txs: [own] }], totalPaid: "250", weeksPaid: 1 });
    expect(rewards.view(ALICE.address, end + 4).payouts[0]?.txs).toEqual([own]);
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
      tools.closeWeek("2026-W41", 10n ** 18n, "ZEC", 1n, end, CLEAR);
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
  const ZEC = RESERVE_ASSET.contract;
  const USDC_BSC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
  const ONE = 10n ** 18n;
  /** keccak256("Approval(address,address,uint256)"): the first topic of a token's record of an approval. */
  const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
  const word = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  /** Alice has 250 points and Bob 500 in week 41: a third and two thirds. */
  const seeded = (dir = tempDir()) => {
    const rewards = createRewards(dir);
    rewards.recordDelivered(stored());
    rewards.recordDelivered(stored({ id: "C".repeat(27), rewardsAddress: BOB.address, amountInUsd: "2500" }));
    return rewards;
  };
  /** BNB Chain as the tools see it: the reserve wallet holds this much of the payout coin. */
  const chain = (holds: bigint = 100n * ONE): FakeRpc => {
    const rpc = createFakeRpc();
    rpc.balances.set(RESERVE.toLowerCase(), holds);
    return rpc;
  };
  /** The export tool, as the script calls it. Without `close` it is a look. */
  const run = (rewards: Rewards, pool: bigint, extra: Partial<Parameters<typeof exportWeek>[0]> = {}) => exportWeek({ rewards, sanctions: CLEAR, rpc: chain(), reserve: RESERVE, week: "2026-W41", pool, asset: "ZEC", now: end, ...extra });
  const shareOf = (record: WeekRecord, who: { address: string }) => record.shares.find((share) => share.address === who.address)!;

  it("write the same list every time for the same week, and it adds up to the pool exactly", async () => {
    const rewards = seeded();
    const first = await run(rewards, 3n * ONE, { close: true });
    const second = await run(rewards, 3n * ONE, { close: true, asset: "zec", now: end + 5 * 86_400_000 });
    expect(first).toMatchObject({ closed: true, already: false });
    expect(second).toMatchObject({ closed: true, already: true });
    expect(second.csv).toBe(first.csv);
    expect(second.summary).toEqual(first.summary);
    const [alice, bob] = [ALICE.address, BOB.address].sort();
    expect(first.csv.split("\n")[0]).toBe("rewards_address,points,share,payout_zec,carried_points,withheld_zec");
    expect(first.csv.split("\n").slice(1, 3).map((line) => line.split(",")[0])).toEqual([alice, bob]);
    expect(first.csv).toContain(`${ALICE.address},250.000000,0.33333333,1,0.000000,0\n`);
    expect(first.csv).toContain(`${BOB.address},500.000000,0.66666666,2,0.000000,0\n`);
    // The week's counted fee is Alice's $2.50 and Bob's $5.
    expect(first.summary).toEqual({ week: "2026-W41", from: "2026-10-05T00:00:00.000Z", to: "2026-10-11T23:59:59.999Z", asset: "ZEC", pool: "3", paid: "3", leftInReserve: "0", withheld: "0", addresses: 2, addressesPaid: 2, addressesCarried: 0, addressesWithheld: 0, totalPoints: "750.000000", countedFeeUsd: "7.500000" });
    expect(BigInt(first.record.paid) + BigInt(first.record.left)).toBe(3n * ONE);
    expect(weekCsv(first.record)).toBe(first.csv);
  });

  it("show what closing a week would do and write nothing at all, until told to close", async () => {
    const dir = tempDir();
    const rewards = seeded(dir);
    const before = everything(dir);
    // No word to close, a plain no, and things that are not the word: each is a look.
    const looks = [await run(rewards, 3n * ONE), await run(rewards, 3n * ONE, { close: false }), await run(rewards, 3n * ONE, { close: "yes" as never }), await run(rewards, 3n * ONE, { close: 1 as never })];
    for (const look of looks) {
      expect(look).toMatchObject({ closed: false, already: false, reserveHolds: 100n * ONE });
      // All that closing would do is there to be read: the addresses, the points, the fee that counted, each share and payout, what is carried, what is kept back and what stays in the reserve.
      expect(look.summary).toEqual({ week: "2026-W41", from: "2026-10-05T00:00:00.000Z", to: "2026-10-11T23:59:59.999Z", asset: "ZEC", pool: "3", paid: "3", leftInReserve: "0", withheld: "0", addresses: 2, addressesPaid: 2, addressesCarried: 0, addressesWithheld: 0, totalPoints: "750.000000", countedFeeUsd: "7.500000" });
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
    await expect(run(rewards, 3n * ONE, { close: true, rpc })).rejects.toThrow(/The pool is 3 ZEC and the reserve wallet holds 2\. A week is not closed with more than the reserve holds\. Nothing was closed\./);
    await expect(run(rewards, 2n * ONE + 1n, { close: true, rpc })).rejects.toThrow(/Nothing was closed/);
    expect(rewards.week("2026-W41")).toBeNull();
    // BNB Chain was asked: the payout coin's own contract, about the reserve wallet.
    const asked = rpc.calls.find((call) => call.call.method === "eth_call");
    expect(asked?.chain).toBe("bsc");
    expect(JSON.stringify(asked?.call.params)).toContain(ZEC);
    expect(JSON.stringify(asked?.call.params)).toContain(`0x70a08231${RESERVE.slice(2).toLowerCase().padStart(64, "0")}`);
    expect(await reserveHolds(rpc, RESERVE)).toBe(2n * ONE);
    // The chain cannot be read: no week is closed with anything to pay, however little.
    const down = chain();
    down.down = true;
    expect(await reserveHolds(down, RESERVE)).toBeNull();
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
    await expect(run(rewards, ONE, { asset: "BNB", close: true })).rejects.toThrow(/sent in ZEC/);
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
    putMined(rpc, toBob, { from: RESERVE }, [transferLog(ZEC, RESERVE, BOB.address, 2n * ONE)]);
    await expect(recordPayouts({ rewards, rpc, reserve: RESERVE, week: "2026-W41", hashes: [toBob], now: end })).rejects.toThrow(/holds no transfer/);
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
    const record = (rewards: Rewards, rpc: FakeRpc, hashes: string[], week = "2026-W41") => recordPayouts({ rewards, rpc, reserve: RESERVE, week, hashes, now: end + 60_000 });
    /** Week 41 closed with a pool of 3: Alice is due 1 and Bob 2. */
    const closedWeek = async () => {
      const rewards = seeded();
      await run(rewards, 3n * ONE, { close: true });
      return rewards;
    };
    /** A mined, successful transaction from the reserve wallet that holds one transfer. */
    const pay = (rpc: FakeRpc, label: string, to: string, amount: bigint, options: { from?: string; token?: string } = {}) => {
      const hash = hashOf(label);
      putMined(rpc, hash, { from: RESERVE.toLowerCase(), to: options.token ?? ZEC }, [transferLog(options.token ?? ZEC, options.from ?? RESERVE, to, amount)]);
      return hash;
    };
    const none = /holds no transfer of ZEC from the reserve wallet to an address still to be paid in week 2026-W41, for exactly its payout\. Nothing was recorded\./;

    it("check that a transaction was sent by the reserve wallet and went through, and read what it holds", async () => {
      const rpc = chain();
      const good = pay(rpc, "good", ALICE.address, ONE);
      // Each of these holds a transfer that would pass: what stops it is who sent it, or that it failed.
      const foreign = hashOf("foreign");
      putMined(rpc, foreign, { from: ADDR.evm2 }, [transferLog(ZEC, RESERVE, BOB.address, 2n * ONE)]);
      const failed = hashOf("failed");
      putMined(rpc, failed, { from: RESERVE }, [transferLog(ZEC, RESERVE, BOB.address, 2n * ONE)], "0x0");
      const pending = hashOf("pending");
      rpc.txs.set(pending, { from: RESERVE });
      expect(await checkPayoutTx(rpc, RESERVE, good)).toEqual({ ok: true, transfers: [{ to: ALICE.address.toLowerCase(), amount: ONE }] });
      expect(await checkPayoutTx(rpc, RESERVE, foreign)).toEqual({ ok: false, reason: "it was not sent from the reserve wallet" });
      expect(await checkPayoutTx(rpc, RESERVE, failed)).toEqual({ ok: false, reason: "it failed on-chain" });
      expect(await checkPayoutTx(rpc, RESERVE, pending)).toEqual({ ok: false, reason: "it has not been included in a block yet" });
      expect(await checkPayoutTx(rpc, RESERVE, hashOf("unknown"))).toEqual({ ok: false, reason: "no such transaction on BNB Chain" });
      expect(await checkPayoutTx(rpc, RESERVE, "0x1234")).toEqual({ ok: false, reason: "that is not a transaction hash" });
      // What it holds is the payout coin's own record of coins leaving the reserve wallet, and nothing else.
      const mixed = hashOf("mixed");
      putMined(rpc, mixed, { from: RESERVE }, [
        transferLog(USDC_BSC, RESERVE, ALICE.address, ONE),
        transferLog(ZEC, ADDR.evm2, ALICE.address, ONE),
        { address: ZEC, topics: [APPROVAL_TOPIC, word(RESERVE), word(ADDR.evm2)], data: `0x${ONE.toString(16).padStart(64, "0")}` },
        transferLog(ZEC, RESERVE, ALICE.address, 0n),
        "not a log",
        null,
        transferLog(ZEC, RESERVE, BOB.address, 2n * ONE),
      ]);
      expect(await checkPayoutTx(rpc, RESERVE, mixed)).toEqual({ ok: true, transfers: [{ to: BOB.address.toLowerCase(), amount: 2n * ONE }] });
      rpc.down = true;
      expect(await checkPayoutTx(rpc, RESERVE, good)).toEqual({ ok: false, reason: "BNB Chain could not be read" });
    });

    it("record nothing unless every transaction passes", async () => {
      const rewards = seeded();
      const rpc = chain();
      const good = pay(rpc, "good", ALICE.address, ONE);
      await expect(record(rewards, rpc, [good])).rejects.toThrow(/not closed/);
      await run(rewards, 3n * ONE, { close: true });
      // One bad hash among good ones: nothing is recorded.
      const foreign = hashOf("foreign");
      putMined(rpc, foreign, { from: ADDR.evm2 }, [transferLog(ZEC, RESERVE, BOB.address, 2n * ONE)]);
      await expect(record(rewards, rpc, [good, foreign])).rejects.toThrow(/not sent from the reserve wallet\. Nothing was recorded/);
      const failed = hashOf("failed");
      putMined(rpc, failed, { from: RESERVE }, [transferLog(ZEC, RESERVE, BOB.address, 2n * ONE)], "0x0");
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
      putMined(rpc, approval, { from: RESERVE, to: ZEC }, [{ address: ZEC, topics: [APPROVAL_TOPIC, word(RESERVE), word(ADDR.evm2)], data: `0x${"f".repeat(64)}` }]);
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
      putMined(rpc, both, { from: RESERVE }, [transferLog(ZEC, RESERVE, ALICE.address, ONE), transferLog(ZEC, RESERVE, BOB.address, 2n * ONE)]);
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
        { week: "2026-W42", amount: ONE.toString(), asset: "ZEC", txs: [own] },
        { week: "2026-W41", amount: ONE.toString(), asset: "ZEC", txs: [paid] },
      ]);
    });

    it("leave the Rewards page saying only what is on record as sent: the week's total, and to each address its own transfer", async () => {
      const rewards = await closedWeek();
      const rpc = chain();
      const payouts = (who: { address: string }) => rewards.view(who.address, end + 120_000).payouts;
      // Closed, nothing recorded: no week is shown as paid, and each address sees its amount with no transaction.
      expect(rewards.summary(end + 1)).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
      expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: ONE.toString(), asset: "ZEC", txs: [] }]);
      const toAlice = pay(rpc, "alice", ALICE.address, ONE);
      await record(rewards, rpc, [toAlice]);
      // One payout of two is on record: the week has paid 1, not the 3 that were worked out for it.
      expect(rewards.week("2026-W41")?.paid).toBe((3n * ONE).toString());
      expect(rewards.summary(end + 2)).toMatchObject({ weeks: [{ week: "2026-W41", asset: "ZEC", paid: ONE.toString(), txs: [toAlice] }], totalPaid: ONE.toString(), weeksPaid: 1 });
      expect(payouts(ALICE)).toEqual([{ week: "2026-W41", amount: ONE.toString(), asset: "ZEC", txs: [toAlice] }]);
      expect(payouts(BOB)).toEqual([{ week: "2026-W41", amount: (2n * ONE).toString(), asset: "ZEC", txs: [] }]);
      const toBob = pay(rpc, "bob", BOB.address, 2n * ONE);
      await record(rewards, rpc, [toBob]);
      expect(rewards.summary(end + 3)).toMatchObject({ weeks: [{ week: "2026-W41", paid: (3n * ONE).toString(), txs: [toAlice, toBob] }], totalPaid: (3n * ONE).toString(), weeksPaid: 1 });
      // Each address is shown its own transfer, and not the other's.
      expect(payouts(BOB)).toEqual([{ week: "2026-W41", amount: (2n * ONE).toString(), asset: "ZEC", txs: [toBob] }]);
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
    expect(entry.feeUsdMicro).toBe(feeUsdMicro(record.amountInUsd, record.fees.appBps)!.toString());
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
    const closed = tools.closeWeek(week, 2n * 10n ** 18n, "ZEC", 1n, after, CLEAR);
    const amount = closed.shares.find((share) => share.address === ALICE.address)!.payout;
    // Closed: Alice sees her payout, being sent. Nothing is shown to anyone as paid.
    expect(await mine()).toEqual([{ week, amount, asset: "ZEC", txs: [] }]);
    expect(await anyone()).toMatchObject({ weeks: [], totalPaid: "0", weeksPaid: 0 });
    // Paid and recorded: both answers have it.
    const hash = `0x${"a1".repeat(32)}`;
    tools.recordPaid(week, [{ address: ALICE.address, hash }], after + 1);
    expect(await mine()).toEqual([{ week, amount, asset: "ZEC", txs: [hash] }]);
    expect(await anyone()).toMatchObject({ weeks: [{ week, asset: "ZEC", paid: amount, txs: [hash] }], totalPaid: amount, weeksPaid: 1 });
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

  it("tells anyone the week and the reserve, and nothing about any other address", async () => {
    const h = await start({ practice: true });
    await delivered(h, { rewardsAddress: ALICE.address });
    const none = (await h.get("/api/rewards")).body as RewardsPublic;
    expect(none.reserve).toBeNull();
    expect(none.week.id).toBe(weekOf(h.clock.t));
    expect(Date.parse(none.week.end) - Date.parse(none.week.start)).toBe(7 * 86_400_000);
    expect(JSON.stringify(none)).not.toContain(ALICE.address);
    expect((await h.get("/api/config")).body.reserveAddress).toBeNull();

    const withReserve = await start({ env: { RESERVE_ADDRESS: ADDR.evm3 } });
    // The reserve's balance of the payout coin is read from BNB Chain.
    withReserve.rpc.balances.set(ADDR.evm3.toLowerCase(), 42n * 10n ** 18n);
    const shown = (await withReserve.get("/api/rewards")).body as RewardsPublic;
    expect(shown.reserve).toEqual({ address: ADDR.evm3, asset: { symbol: "ZEC", name: "Binance-Peg ZEC", decimals: 18, contract: RESERVE_ASSET.contract }, balance: (42n * 10n ** 18n).toString() });
    expect((await withReserve.get("/api/config")).body.reserveAddress).toBe(ADDR.evm3);
    const asked = withReserve.rpc.calls.find((call) => call.call.method === "eth_call" && JSON.stringify(call.call.params).includes(RESERVE_ASSET.contract));
    expect(asked?.chain).toBe("bsc");
    expect(JSON.stringify(asked?.call.params)).toContain(`0x70a08231${ADDR.evm3.slice(2).toLowerCase().padStart(64, "0")}`);
  });

  it("shows the reserve without a figure when the chain cannot be read", async () => {
    const h = await start({ env: { RESERVE_ADDRESS: ADDR.evm3 } });
    h.rpc.down = true;
    expect(((await h.get("/api/rewards")).body as RewardsPublic).reserve).toMatchObject({ address: ADDR.evm3, balance: null });
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
