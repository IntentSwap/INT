import { describe, expect, it } from "vitest";
import {
  bpsOf,
  decimalToScaled,
  displayAmount,
  displayBps,
  displayExact,
  displayUsd,
  formatExact,
  MAX_RAW,
  parseAmount,
  parseRaw,
  priceImpactBps,
  priceToScaled,
  rateRaw,
  usdScaled,
  worseByMoreThan,
} from "../shared/amounts.ts";

describe("parseAmount", () => {
  const ok: Array<[string, number, string]> = [
    ["1", 18, "1000000000000000000"],
    ["0.5", 18, "500000000000000000"],
    [".5", 18, "500000000000000000"],
    ["5.", 6, "5000000"],
    ["0.00000001", 8, "1"],
    ["123456789.123456", 6, "123456789123456"],
    ["1000000000", 0, "1000000000"],
    ["1,5", 6, "1500000"],
    [" 2 ", 6, "2000000"],
    ["0", 6, "0"],
    ["0.000000000000000001", 18, "1"],
  ];
  it.each(ok)("parses %j with %i decimals", (input, decimals, raw) => {
    const result = parseAmount(input, decimals);
    expect(result).toEqual({ ok: true, raw: BigInt(raw) });
  });

  const bad: Array<[string, number, string]> = [
    ["", 6, "empty"],
    ["   ", 6, "empty"],
    ["abc", 6, "format"],
    ["1.2.3", 6, "format"],
    ["1,234.56", 6, "format"],
    ["1,2,3", 6, "format"],
    ["-1", 6, "format"],
    ["1e5", 6, "format"],
    ["0x10", 6, "format"],
    ["1 000", 6, "format"],
    [".", 6, "format"],
    ["0.0000001", 6, "too_many_decimals"],
    ["1.5", 0, "too_many_decimals"],
    ["1" + "0".repeat(31), 0, "too_large"],
    ["10000000000000", 18, "too_large"],
  ];
  it.each(bad)("rejects %j with %i decimals as %s", (input, decimals, reason) => {
    expect(parseAmount(input, decimals)).toEqual({ ok: false, reason });
  });

  it("accepts exactly the maximum", () => {
    expect(parseAmount("1" + "0".repeat(30), 0)).toEqual({ ok: true, raw: MAX_RAW });
  });
});

describe("parseRaw", () => {
  it.each([
    ["0", 0n],
    ["1", 1n],
    ["5000000000000000", 5000000000000000n],
  ])("accepts %j", (text, value) => expect(parseRaw(text)).toBe(value));
  it.each(["", "01", "1.0", "-1", "1e3", " 1", "abc", 5, null, undefined, "9".repeat(41)])("rejects %j", (text) => expect(parseRaw(text)).toBeNull());
});

describe("formatExact", () => {
  it.each([
    [0n, 18, "0"],
    [1n, 8, "0.00000001"],
    [500000000000000000n, 18, "0.5"],
    [123456789123456n, 6, "123456789.123456"],
    [1000000000n, 0, "1000000000"],
    [1000000n, 6, "1"],
    [1500000n, 6, "1.5"],
  ])("formats %s with %i decimals", (raw, decimals, text) => expect(formatExact(raw, decimals)).toBe(text));

  it("round-trips through parseAmount", () => {
    for (const text of ["0.00000001", "123456789.123456", "1000000000", "0.5", "42"]) {
      const parsed = parseAmount(text, 8);
      expect(parsed.ok && formatExact(parsed.raw, 8)).toBe(text);
    }
  });
});

describe("displayAmount", () => {
  // [raw, decimals, shown]
  const table: Array<[string, number, string]> = [
    // 1,000 and above: 2 decimals with grouping
    ["1000000000", 6, "1,000.00"],
    ["1234567891", 6, "1,234.56"],
    ["123456789123456", 6, "123,456,789.12"],
    ["1000000000000000", 6, "1,000,000,000.00"],
    ["1999999", 3, "1,999.99"],
    // 1 to 999: up to 4 decimals, at least 2
    ["371200000", 6, "371.20"],
    ["371234567", 6, "371.2345"],
    ["1000000", 6, "1.00"],
    ["999999999", 6, "999.9999"],
    ["5500000", 6, "5.50"],
    ["5123000", 6, "5.123"],
    // below 1: 4 significant digits, rounded down
    ["500000000000000000", 18, "0.5"],
    ["123456789", 12, "0.0001234"],
    ["999999", 6, "0.9999"],
    ["12345", 6, "0.01234"],
    ["1", 4, "0.0001"],
    ["12349", 9, "0.00001234"],
    // more than four leading zeros: subscript form
    ["1", 8, "0.0₇1"],
    ["1234", 9, "0.0₅1234"],
    ["12345678", 18, "0.0₁₀1234"],
    // zero
    ["0", 6, "0"],
  ];
  it.each(table)("shows %s (%i decimals) as %s", (raw, decimals, shown) => {
    expect(displayAmount(BigInt(raw), decimals).text).toBe(shown);
  });

  it("always rounds down", () => {
    expect(displayAmount(1999999n, 6).text).toBe("1.9999");
    expect(displayAmount(999999999999n, 6).text).toBe("999,999.99");
    expect(displayAmount(99999n, 6).text).toBe("0.09999");
  });

  it("keeps the exact value for labels and copying", () => {
    expect(displayAmount(1234n, 9)).toEqual({ text: "0.0₅1234", exact: "0.000001234" });
    expect(displayAmount(1234567891n, 6).exact).toBe("1234.567891");
  });

  it("keeps a steady length for a number that refreshes in place", () => {
    const steady = (raw: bigint, decimals: number) => displayAmount(raw, decimals, { steady: true }).text;
    // 1 to 999: always four decimals, so "311.287" and "311.3617" are the same length.
    expect(steady(311287000n, 6)).toBe("311.2870");
    expect(steady(311361700n, 6)).toBe("311.3617");
    expect(steady(1000000n, 6)).toBe("1.0000");
    // Below 1: always four significant digits.
    expect(steady(500000000000000000n, 18)).toBe("0.5000");
    expect(steady(12300n, 6)).toBe("0.01230");
    expect(steady(1200n, 9)).toBe("0.0₅1200");
    // 1,000 and above already has a fixed two decimals. Zero stays zero. Still rounded down.
    expect(steady(1234567891n, 6)).toBe("1,234.56");
    expect(steady(0n, 6)).toBe("0");
    expect(steady(1999999n, 6)).toBe("1.9999");
    // The default, for sentences and one-off figures, still drops trailing zeros.
    expect(displayAmount(311287000n, 6).text).toBe("311.287");
  });

  it("handles coins with no decimals", () => {
    expect(displayAmount(5n, 0).text).toBe("5.00");
    expect(displayAmount(5000n, 0).text).toBe("5,000.00");
  });
});

describe("displayExact", () => {
  it("shows every digit, with the whole part grouped", () => {
    expect(displayExact(1261340512n, 6)).toBe("1,261.340512");
    expect(displayExact(500000000000000000n, 18)).toBe("0.5");
    expect(displayExact(1n, 18)).toBe("0.000000000000000001");
    expect(displayExact(123456789000000n, 6)).toBe("123,456,789");
    expect(displayExact(0n, 6)).toBe("0");
  });
});

describe("displayUsd", () => {
  it.each([
    ["0", "$0.00"],
    ["0.004", "<$0.01"],
    ["0.01", "$0.01"],
    ["12.814850000000", "$12.81"],
    ["0.999", "$0.99"],
    ["1234567.891", "$1,234,567.89"],
    ["1000", "$1,000.00"],
  ])("shows %s as %s", (value, shown) => expect(displayUsd(value)).toBe(shown));
  it.each(["", "abc", "-1", "1e3", null, 5])("rejects %j", (value) => expect(displayUsd(value)).toBeNull());
});

describe("fee and price maths", () => {
  it("computes bps of an amount, rounding down", () => {
    expect(bpsOf(5000000000000000n, 20)).toBe(10000000000000n);
    expect(bpsOf(999n, 40)).toBe(3n);
    expect(bpsOf(1n, 40)).toBe(0n);
    expect(bpsOf(10n ** 30n, 500)).toBe(5n * 10n ** 28n);
  });

  it("refuses bad bps values", () => {
    expect(() => bpsOf(1n, -1)).toThrow();
    expect(() => bpsOf(1n, 1.5)).toThrow();
  });

  it("formats bps as a percentage", () => {
    expect(displayBps(20)).toBe("0.20%");
    expect(displayBps(40)).toBe("0.40%");
    expect(displayBps(100)).toBe("1.00%");
    expect(displayBps(5)).toBe("0.05%");
    expect(displayBps(250)).toBe("2.50%");
  });

  it("detects a quote that moved more than the tolerance", () => {
    // Exactly 1% worse is allowed; one unit more is not.
    expect(worseByMoreThan(1_000_000n, 990_000n, 100)).toBe(false);
    expect(worseByMoreThan(1_000_000n, 989_999n, 100)).toBe(true);
    expect(worseByMoreThan(1_000_000n, 1_000_000n, 100)).toBe(false);
    expect(worseByMoreThan(1_000_000n, 2_000_000n, 100)).toBe(false);
    expect(worseByMoreThan(1_000_000n, 999_999n, 0)).toBe(true);
    expect(worseByMoreThan(1_000_000n, 1_000_000n, 0)).toBe(false);
  });

  it("computes price impact in bps", () => {
    expect(priceImpactBps("100", "97")).toBe(300);
    expect(priceImpactBps("12.814850000000", "12.729955043988")).toBe(66);
    expect(priceImpactBps("100", "101")).toBe(0);
    expect(priceImpactBps("0", "1")).toBeNull();
    expect(priceImpactBps("x", "1")).toBeNull();
  });

  it("computes a rate without floating point", () => {
    // 0.005 ETH in, 12.734514 USDC out → 2546.9028 USDC per ETH
    expect(rateRaw(5000000000000000n, 12734514n, 18)).toBe(2546902800n);
    expect(rateRaw(0n, 1n, 18)).toBeNull();
  });

  it("scales decimal strings and prices exactly", () => {
    expect(decimalToScaled("12.5", 2)).toBe(1250n);
    expect(decimalToScaled("12.519", 2)).toBe(1251n);
    expect(decimalToScaled("7", 3)).toBe(7000n);
    expect(decimalToScaled("1e3", 3)).toBeNull();
    expect(priceToScaled(5.26)).toBe(5260000000000000000n);
    expect(priceToScaled(767.8)).toBe(767800000000000000000n);
    expect(priceToScaled(1.13427e-7)).toBe(113427000000n);
    expect(priceToScaled(0)).toBe(0n);
    expect(priceToScaled(-1)).toBeNull();
    expect(priceToScaled(Number.NaN)).toBeNull();
    expect(priceToScaled("5")).toBeNull();
  });

  it("values an amount in USD", () => {
    // 0.5 BNB at $767.80 = $383.90
    expect(usdScaled(500000000000000000n, 18, priceToScaled(767.8)!)).toBe(383900000000000000000n);
  });
});
