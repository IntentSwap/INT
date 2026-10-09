// Money maths. Everything here works on BigInt and digit strings.
// No floating point is used for any amount that is sent, stored or compared.

/** Largest raw amount the server accepts (10^30 smallest units). */
export const MAX_RAW = 10n ** 30n;

export const BPS = 10_000n;

const DIGITS = /^\d+$/;

export function isDigits(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 40 && DIGITS.test(value);
}

/** Parses a canonical raw integer string ("0" or no leading zeros). */
export function parseRaw(value: unknown): bigint | null {
  if (!isDigits(value)) return null;
  if (value.length > 1 && value.startsWith("0")) return null;
  return BigInt(value);
}

export type ParseAmountResult =
  | { ok: true; raw: bigint }
  | { ok: false; reason: "empty" | "format" | "too_many_decimals" | "too_large" };

/**
 * Parses what a person typed into an amount field.
 * Digits and one decimal point. A comma counts as the decimal point only when
 * it is the single separator in the text.
 */
export function parseAmount(input: string, decimals: number): ParseAmountResult {
  let text = input.trim();
  if (text === "") return { ok: false, reason: "empty" };
  const commas = (text.match(/,/g) ?? []).length;
  const dots = (text.match(/\./g) ?? []).length;
  if (commas === 1 && dots === 0) text = text.replace(",", ".");
  else if (commas > 0) return { ok: false, reason: "format" };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return { ok: false, reason: "format" };
  const [whole = "", frac = ""] = text.split(".");
  if (frac.length > decimals) return { ok: false, reason: "too_many_decimals" };
  if (whole.length > 31) return { ok: false, reason: "too_large" };
  const raw = BigInt(whole === "" ? "0" : whole) * 10n ** BigInt(decimals) + BigInt(frac === "" ? "0" : frac.padEnd(decimals, "0"));
  if (raw > MAX_RAW) return { ok: false, reason: "too_large" };
  return { ok: true, raw };
}

/** Exact value with no grouping and no trailing zeros. Used for deposits, review and copying. */
export function formatExact(raw: bigint, decimals: number): string {
  if (raw < 0n) throw new RangeError("negative amount");
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" || decimals === 0 ? whole.toString() : `${whole}.${frac}`;
}

function group(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const SUBSCRIPT = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

function subscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPT[Number(d)])
    .join("");
}

export interface AmountDisplay {
  /** Short form for the interface. Always rounded down. */
  text: string;
  /** Exact value, for the accessible label and for copying. */
  exact: string;
}

/**
 * Short display form.
 * 1,000 and above: 2 decimals with grouping. 1 to 999: up to 4 decimals.
 * Below 1: 4 significant digits. More than four leading zeros: subscript form.
 * Always rounds down, so a received amount is never overstated.
 */
export function displayAmount(raw: bigint, decimals: number, options: { steady?: boolean } = {}): AmountDisplay {
  // "steady" is for a number that refreshes in place: it keeps every digit of its precision,
  // trailing zeros included, so its length does not change from one quote to the next.
  const steady = options.steady === true;
  const exact = formatExact(raw, decimals);
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0");
  if (raw === 0n) return { text: "0", exact };
  if (whole >= 1000n) {
    return { text: `${group(whole)}.${frac.slice(0, 2).padEnd(2, "0")}`, exact };
  }
  if (whole >= 1n) {
    const padded = frac.slice(0, 4).padEnd(4, "0");
    return { text: `${whole}.${steady ? padded : padded.replace(/0{1,2}$/, "")}`, exact };
  }
  const zeros = frac.length - frac.replace(/^0+/, "").length;
  const digits = frac.slice(zeros, zeros + 4);
  const significant = steady ? digits : digits.replace(/0+$/, "");
  if (digits.replace(/0+$/, "") === "") return { text: "0", exact };
  if (zeros > 4) return { text: `0.0${subscript(zeros)}${significant}`, exact };
  return { text: `0.${"0".repeat(zeros)}${significant}`, exact };
}

/**
 * An amount for a screen reader: the short form, unless that is written with a subscript (a very
 * small number, "0.0₅1234"), which cannot be read out. Then it is the exact value.
 */
export function spokenAmount(raw: bigint, decimals: number): string {
  const { text, exact } = displayAmount(raw, decimals);
  return /[₀-₉]/.test(text) ? exact : text;
}

/** The exact full value with the whole part grouped in threes: "1,261.340512". For review and deposit figures, where nothing may be rounded. */
export function displayExact(raw: bigint, decimals: number): string {
  const [whole = "0", frac] = formatExact(raw, decimals).split(".");
  return frac === undefined ? group(BigInt(whole)) : `${group(BigInt(whole))}.${frac}`;
}

/** Converts a plain decimal string ("12.8148") to an integer scaled by 10^scale, rounding down. */
export function decimalToScaled(value: unknown, scale: number): bigint | null {
  if (typeof value !== "string" || value.length > 60 || !/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(frac.slice(0, scale).padEnd(scale, "0") || "0");
}

/** USD to 2 decimals. Under a cent shows "<$0.01". Input is a plain decimal string. */
export function displayUsd(value: unknown): string | null {
  const micro = decimalToScaled(value, 6);
  if (micro === null) return null;
  if (micro === 0n) return "$0.00";
  if (micro < 10_000n) return "<$0.01";
  const cents = micro / 10_000n;
  return `$${group(cents / 100n)}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** amount × bps / 10,000, rounded down. */
export function bpsOf(raw: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError("bad bps");
  return (raw * BigInt(bps)) / BPS;
}

/** "0.20%" from 20 bps. */
export function displayBps(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError("bad bps");
  const whole = Math.trunc(bps / 100);
  return `${whole}.${String(bps % 100).padStart(2, "0")}%`;
}

/** True when `actual` is lower than `reviewed` by more than `bps`. */
export function worseByMoreThan(reviewed: bigint, actual: bigint, bps: number): boolean {
  return actual * BPS < reviewed * (BPS - BigInt(bps));
}

/** Price impact in bps: 1 − outUsd / inUsd, never below zero. Null when unknown. */
export function priceImpactBps(amountInUsd: unknown, amountOutUsd: unknown): number | null {
  const a = decimalToScaled(amountInUsd, 8);
  const b = decimalToScaled(amountOutUsd, 8);
  if (a === null || b === null || a === 0n) return null;
  if (b >= a) return 0;
  return Number(((a - b) * BPS) / a);
}

/** Output units received for one whole input unit, in raw output units. */
export function rateRaw(amountIn: bigint, amountOut: bigint, decimalsIn: number): bigint | null {
  if (amountIn <= 0n) return null;
  return (amountOut * 10n ** BigInt(decimalsIn)) / amountIn;
}

/**
 * Converts a JSON number price to an integer scaled by 10^18.
 * Prices only feed USD estimates and limits, never an amount that moves.
 */
export function priceToScaled(price: unknown): bigint | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price >= 1e15) return null;
  // The shortest exact text for the number ("5.26"), or fixed notation when that would use an exponent.
  const text = String(price);
  return decimalToScaled(/^\d+(\.\d+)?$/.test(text) ? text : price.toFixed(18), 18);
}

/** USD value of a raw amount, scaled by 10^18. */
export function usdScaled(raw: bigint, decimals: number, priceScaled18: bigint): bigint {
  return (raw * priceScaled18) / 10n ** BigInt(decimals);
}

export const USD_SCALE = 10n ** 18n;
