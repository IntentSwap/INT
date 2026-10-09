import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { displayAmount, displayUsd, formatExact } from "../../../shared/amounts.ts";
import { amountStep, cleanAmount, fitAmount, maxAmountChars } from "../lib/swap-logic.ts";

/** The room an amount has on the card at its full width, until the page has measured the real one. */
const AMOUNT_WIDTH = 256;

/** Measures an element's width, so the number can step down in size instead of clipping. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

interface InputProps {
  id: string;
  value: string;
  decimals: number;
  autoFocus: boolean;
  onChange(value: string): void;
}

export function AmountInput({ id, value, decimals, autoFocus, onChange }: InputProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const input = useRef<HTMLInputElement>(null);
  const size = amountStep(Math.max(value.length, 1), width || AMOUNT_WIDTH);
  // What fits at the smallest size. Nothing longer is accepted, so the number never scrolls inside its field.
  const maxChars = maxAmountChars(width || AMOUNT_WIDTH);

  // An amount that arrived some other way (Max, a link, a narrower screen) is shortened to fit, decimals first.
  useEffect(() => {
    if (width > 0 && value.length > maxChars) {
      const fitted = fitAmount(value, maxChars);
      if (fitted !== value) onChange(fitted);
    }
  }, [value, maxChars, width, onChange]);

  // Focus on arrival only, and for mouse and keyboard users only (on touch it would open the keyboard
  // unasked). Never again afterwards: when a sheet closes, focus belongs to whatever opened it.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    if (autoFocus && window.matchMedia("(hover: hover) and (pointer: fine)").matches) input.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  return (
    <div className="amount-row" ref={ref}>
      <input
        ref={input}
        id={id}
        className="amount-input mono"
        data-size={size}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="0"
        value={value}
        onChange={(event) => {
          const cleaned = cleanAmount(event.target.value, decimals, maxChars);
          // Anything that is not part of a number is simply not typed.
          if (cleaned !== null) onChange(cleaned);
        }}
      />
    </div>
  );
}

interface OutputProps {
  id: string;
  raw: string | null;
  decimals: number;
  symbol: string;
  stale: boolean;
  loading: boolean;
}

/** The amount to be received. Same sizing rule as the input; a skeleton only before the first number. */
export function AmountOutput({ id, raw, decimals, symbol, stale, loading }: OutputProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  // Steady precision: the number refreshes every few seconds and must not change length as it does.
  const text = raw === null ? null : displayAmount(BigInt(raw), decimals, { steady: true }).text;
  // When the number changes, the one it replaces stays for a moment and fades out beneath the new one.
  const shown = useRef<string | null>(text);
  const [leaving, setLeaving] = useState<string | null>(null);
  useEffect(() => {
    const before = shown.current;
    shown.current = text;
    if (before === null || text === null || before === text) return;
    setLeaving(before);
    const timer = setTimeout(() => setLeaving(null), 200);
    return () => clearTimeout(timer);
  }, [text]);

  if (raw === null || text === null) {
    return (
      <div className="amount-row" ref={ref}>
        {loading ? (
          <span className="skeleton skeleton-amount" aria-hidden="true" />
        ) : (
          <output id={id} className="amount-output mono amount-empty" data-size={28} aria-live="off">
            0
          </output>
        )}
        {loading ? <span className="sr-only">Getting a quote</span> : null}
      </div>
    );
  }
  const exact = formatExact(BigInt(raw), decimals);
  const size = amountStep(Math.max(text.length, leaving?.length ?? 0), width || AMOUNT_WIDTH);
  return (
    <div className="amount-row amount-stack" ref={ref}>
      {leaving !== null ? (
        <span className="amount-output mono fade-out" data-size={size} aria-hidden="true">
          {leaving}
        </span>
      ) : null}
      {/* An output is read out on every change by default. This one refreshes every 15 seconds, so it stays quiet; the card reads out what matters. */}
      {/* key: a changed number fades in rather than counting up */}
      <output id={id} key={text} className="amount-output mono fade-in" data-size={size} data-stale={stale || undefined} aria-live="off" aria-label={`${exact} ${symbol}`} title={`${exact} ${symbol}`}>
        {text}
      </output>
    </div>
  );
}

export function UsdValue({ value }: { value: string | null }) {
  const text = value === null ? null : displayUsd(value);
  return <span className="usd muted">{text ?? " "}</span>;
}
