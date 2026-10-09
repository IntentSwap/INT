// Interface settings that are decisions, not secrets. Nothing here is sensitive.

/**
 * The pair the swap card opens with.
 * The intended default is BNB on BNB Chain → USDT on Solana. While the provider's
 * $1,000 minimum on BNB Chain is in force, the card opens with a pair that works
 * for small amounts. To go back: set `from` to
 * { chain: "bsc", symbol: "BNB" }.
 */
export const DEFAULT_PAIR = {
  from: { chain: "base", symbol: "ETH" },
  to: { chain: "sol", symbol: "USDT" },
} as const;

/** The amount of the opening pair's first coin used for the example quote on the Docs page. Only the amount is fixed: every number shown comes from the quote. */
export const EXAMPLE_AMOUNT = "0.1";

/** Coins shown first in the picker, in this order. */
export const PINNED_SYMBOLS = ["BNB", "USDT", "USDC", "ETH", "BTC", "SOL", "ZEC", "NEAR"] as const;

/** Chains in the order they are offered. Anything not listed follows alphabetically. */
export const CHAIN_ORDER = ["bsc", "eth", "base", "arb", "sol", "btc", "zec", "near", "tron", "ton", "op", "pol", "avax"] as const;

/** Chains with their own chip in the picker. The rest are behind "More chains". */
export const FEATURED_CHAINS = ["bsc", "eth", "base", "arb", "sol", "btc"] as const;

/** Kept back for network fees when "Max" is pressed on a native coin (whole units). */
export const NATIVE_RESERVE: Readonly<Record<string, string>> = {
  bsc: "0.001",
  eth: "0.001",
  base: "0.0001",
  arb: "0.0001",
  sol: "0.01",
};

export const QUOTE_DEBOUNCE_MS = 400;
export const QUOTE_REFRESH_MS = 15_000;
/** A quote request with no reply after this long is given up on (the server itself answers well within it). */
export const QUOTE_TIMEOUT_MS = 20_000;
/** A quote older than this is not accepted for review without a refresh. */
export const QUOTE_EXPIRES_MS = 60_000;
/** The wallet is not opened with less than this left before the deadline. */
export const MIN_TIME_TO_PAY_MS = 5 * 60_000;

export const IMPACT_WARN_BPS = 300;
export const IMPACT_BLOCK_BPS = 1000;
export const SLOW_SWAP_SECONDS = 600;
