// "Add gas": what the page and the server agree on (shared/gas.ts).
import { describe, expect, it } from "vitest";
import { USD_SCALE } from "../shared/amounts.ts";
import { GAS_DRIFT_BPS, GAS_SIZES_USD, GAS_USD, gasAmountOf, gasCoinFor, gasSizeFor, isGasAmount, isGasSize, ownCoinOf } from "../shared/gas.ts";

const coin = (id: string, chain: string, contract: string | null) => ({ id, chain, contract });
const SOL = coin("sol", "sol", null);
const USDC_SOL = coin("usdc-sol", "sol", "EPjF");
const ETH_BASE = coin("eth-base", "base", null);
const USDC_BASE = coin("usdc-base", "base", "0x83");
const WNEAR = coin("wnear", "near", "wrap.near");
const LIST = [SOL, USDC_SOL, ETH_BASE, USDC_BASE, WNEAR];
/** A price in whole dollars, as the coin list holds it. */
const dollars = (n: number) => BigInt(n) * USD_SCALE;

describe("the size of a gas order", () => {
  it("comes in three sizes and never more than ten dollars", () => {
    expect([...GAS_SIZES_USD]).toEqual([3, 5, 10]);
    expect(Math.max(...GAS_SIZES_USD)).toBe(10);
    expect(GAS_USD).toBe(3);
  });

  it("is three dollars unless the chain has a size of its own", () => {
    for (const chain of ["sol", "base", "arb", "op", "pol", "sui", "aptos", "ton", "a chain not yet known"]) expect(gasSizeFor(chain)).toBe(3);
    expect(gasSizeFor("eth")).toBe(5);
    expect(gasSizeFor("gnosis")).toBe(5);
    expect(gasSizeFor("tron")).toBe(10);
  });

  it("is always one of the sizes", () => {
    for (const chain of ["sol", "eth", "gnosis", "tron", "btc", ""]) expect(isGasSize(gasSizeFor(chain))).toBe(true);
    for (const other of [0, 1, 4, 11, 100, "3", null, undefined]) expect(isGasSize(other)).toBe(false);
  });
});

describe("a chain's own coin", () => {
  it("is the one coin on the chain with no contract", () => {
    expect(ownCoinOf("sol", LIST)).toBe(SOL);
    expect(ownCoinOf("base", LIST)).toBe(ETH_BASE);
  });

  it("is none where the list has none for the chain", () => {
    expect(ownCoinOf("near", LIST)).toBeNull();
    expect(ownCoinOf("tron", LIST)).toBeNull();
  });

  it("is none where the list has more than one: there must be no doubt which coin pays the fees", () => {
    expect(ownCoinOf("sol", [...LIST, coin("other", "sol", null)])).toBeNull();
  });
});

describe("the coin a gas order delivers", () => {
  it("is the receiving chain's own coin when a token is received", () => {
    expect(gasCoinFor(USDC_BASE, USDC_SOL, LIST)).toBe(SOL);
    expect(gasCoinFor(SOL, USDC_BASE, LIST)).toBe(ETH_BASE);
  });

  it("is none when the coin received is already the chain's own coin", () => {
    expect(gasCoinFor(USDC_BASE, SOL, LIST)).toBeNull();
    expect(gasCoinFor(USDC_SOL, ETH_BASE, LIST)).toBeNull();
  });

  it("is none where the chain has no own coin listed", () => {
    expect(gasCoinFor(USDC_BASE, WNEAR, LIST)).toBeNull();
  });

  it("is none when the chain's own coin is the coin being paid with", () => {
    expect(gasCoinFor(SOL, USDC_SOL, LIST)).toBeNull();
  });
});

describe("the amount of a gas order", () => {
  it("is the size in dollars at the list's price, in whole units, rounded down", () => {
    // Three dollars of a one-dollar coin with six decimals.
    expect(gasAmountOf(3, 6, dollars(1))).toBe(3_000_000n);
    // Five dollars of a coin at $4,000 with 18 decimals: 0.00125.
    expect(gasAmountOf(5, 18, dollars(4000))).toBe(1_250_000_000_000_000n);
    // Ten dollars of a coin at $3 with two decimals: 3.33, never rounded up.
    expect(gasAmountOf(10, 2, dollars(3))).toBe(333n);
  });

  it("is none without a price, or where it would come to nothing", () => {
    expect(gasAmountOf(3, 6, null)).toBeNull();
    expect(gasAmountOf(3, 6, 0n)).toBeNull();
    expect(gasAmountOf(3, 6, -1n)).toBeNull();
    // A coin with no decimals at $100,000: three dollars of it is less than one unit.
    expect(gasAmountOf(3, 0, dollars(100_000))).toBeNull();
  });

  it("is recognised as a gas amount at each size, at the price it was worked out at", () => {
    for (const usd of GAS_SIZES_USD) {
      const amount = gasAmountOf(usd, 6, dollars(1));
      expect(amount).not.toBeNull();
      expect(isGasAmount(amount ?? 0n, 6, dollars(1))).toBe(true);
    }
  });

  it("allows for the price moving a little between the review and the order, and no more", () => {
    expect(GAS_DRIFT_BPS).toBe(1_000n);
    // Worth $2.70 and $11.00 at the price now: the edges.
    expect(isGasAmount(2_700_000n, 6, dollars(1))).toBe(true);
    expect(isGasAmount(11_000_000n, 6, dollars(1))).toBe(true);
    expect(isGasAmount(2_699_999n, 6, dollars(1))).toBe(false);
    expect(isGasAmount(11_000_001n, 6, dollars(1))).toBe(false);
  });

  it("is never a way to make a second order of any size", () => {
    expect(isGasAmount(1_000_000_000n, 6, dollars(1))).toBe(false);
    expect(isGasAmount(50_000_000n, 6, dollars(1))).toBe(false);
    expect(isGasAmount(1n, 6, dollars(1))).toBe(false);
    expect(isGasAmount(0n, 6, dollars(1))).toBe(false);
    expect(isGasAmount(-3_000_000n, 6, dollars(1))).toBe(false);
  });

  it("is refused where the coin has no price to judge it by", () => {
    expect(isGasAmount(3_000_000n, 6, null)).toBe(false);
    expect(isGasAmount(3_000_000n, 6, 0n)).toBe(false);
  });
});
