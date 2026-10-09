import { displayAmount } from "../../../shared/amounts.ts";

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/**
 * A coin amount in its short form. Always rounded down. Very small numbers use the subscript
 * form (0.0₅1234). What is on screen is hidden from screen readers, which are given the exact
 * value as ordinary text instead: a label on a plain span is something they may skip.
 */
export function Amount({ raw, decimals, symbol, steady = false }: { raw: bigint | string; decimals: number; symbol?: string; steady?: boolean }) {
  const { text, exact } = displayAmount(typeof raw === "string" ? BigInt(raw) : raw, decimals, { steady });
  const match = new RegExp(`^(0\\.0)([${SUBSCRIPT}]+)(\\d+)$`).exec(text);
  const full = symbol ? `${exact} ${symbol}` : exact;
  return (
    <span className="amount mono" title={full}>
      <span aria-hidden="true">
        {match ? (
          <>
            {match[1]}
            <span className="amount-sub">{[...(match[2] ?? "")].map((ch) => SUBSCRIPT.indexOf(ch)).join("")}</span>
            {match[3]}
          </>
        ) : (
          text
        )}
        {symbol ? ` ${symbol}` : ""}
      </span>
      <span className="sr-only">{full}</span>
    </span>
  );
}

/**
 * A line of text that holds an amount. When the amount is so small that the screen shows it with a
 * subscript, a screen reader is given the same line with the exact value in its place.
 */
export function Said({ text, spoken }: { text: string; spoken: string }) {
  if (text === spoken) return <>{text}</>;
  return (
    <>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{spoken}</span>
    </>
  );
}
