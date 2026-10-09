// The contract between the browser and our server.
// Amounts are always raw integer strings in the coin's smallest unit.

export const TERMS_VERSION = "2026-10-09";

export type PayMethod = "wallet" | "manual";

/** What we show for an order. */
export type OrderStatus =
  | "waiting"
  | "deposit_seen"
  | "swapping"
  | "delivered"
  | "deposit_too_small"
  | "refunded"
  | "failed"
  | "expired";

/** States after which nothing more will happen. */
export const END_STATES: readonly OrderStatus[] = ["delivered", "refunded", "failed", "expired"];

export function isEndState(status: OrderStatus): boolean {
  return END_STATES.includes(status);
}

/** Provider status → what we show. "expired" is our own state and is set by the poller. */
export const STATUS_MAP: ReadonlyMap<string, OrderStatus> = new Map([
  ["PENDING_DEPOSIT", "waiting"],
  ["KNOWN_DEPOSIT_TX", "deposit_seen"],
  ["PROCESSING", "swapping"],
  ["SUCCESS", "delivered"],
  ["INCOMPLETE_DEPOSIT", "deposit_too_small"],
  ["REFUNDED", "refunded"],
  ["FAILED", "failed"],
]);

/**
 * How a swap is routed at the provider, in the provider's own words. "basic" is its confidential
 * routing: the deposit and the delivery are not tied to each other in public records. "public" is
 * the ordinary kind. The level is this server's setting. No request can name one.
 */
export type Confidentiality = "basic" | "public";

/** The same thing as the page is told it, for one quote or one order. */
export type Routing = "confidential" | "public";

/** What the page is told for a level. Anything but "basic" reads as public: an order stored before levels were kept has none. */
export function routingOf(level: unknown): Routing {
  return level === "basic" ? "confidential" : "public";
}

/** True for one of the two words above, and for nothing else. */
export function isRouting(value: unknown): value is Routing {
  return value === routingOf("basic") || value === routingOf("public");
}

export interface TokenView {
  id: string;
  symbol: string;
  name: string;
  chain: string;
  decimals: number;
  /** USD price as a plain decimal string, or null when unknown. */
  price: string | null;
  /** Token contract or mint. Null for native coins. */
  contract: string | null;
  /** True when this coin can be paid from a connected wallet. */
  wallet: boolean;
}

export interface TokensResponse {
  tokens: TokenView[];
  updatedAt: string;
  serverNow: string;
}

export interface ConfigResponse {
  /** True outside production: the page of component states may be shown. */
  testPages: boolean;
  paused: boolean;
  /** True only in local development with the practice provider. No real swaps happen. */
  practice: boolean;
  /** How this server routes swaps: "basic" asks the provider for its confidential routing, "public" for the ordinary kind. What the site says about itself follows this. */
  privacyMode: Confidentiality;
  /** The wallet weekly payouts are sent from, on BNB Chain, or null while none is set. */
  reserveAddress: string | null;
  /** Orders made up for practice mode, so that the list of recent orders can be seen full. Always empty on the live site. */
  sampleOrders: string[];
  reownProjectId: string;
  tokenAddress: string | null;
  /** The token's trading pair on BNB Chain, when one has been set. */
  tokenPairAddress: string | null;
  xUrl: string | null;
  /** The two other links behind the header's icons. Null while unset: the icon is then shown and goes nowhere. */
  dexscreenerUrl: string | null;
  githubUrl: string | null;
  supportContact: string | null;
  termsVersion: string;
  /** Short-lived token required by the quote and order routes. */
  session: string;
  sessionExpiresAt: string;
  serverNow: string;
}

export interface StatusResponse {
  status: "ok" | "degraded" | "paused";
  serverNow: string;
}

/**
 * The slippage limit: how far the price may move against the person before the swap is not made
 * and their coins come back. In basis points. The server holds every request to these bounds.
 */
export const SLIPPAGE = { default: 100, min: 10, max: 500 } as const;

const percent = (bps: number): string => `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;
/** The bounds in words, made from the numbers above so that no sentence can disagree with them. */
export const SLIPPAGE_BOUNDS_WORDS = `between ${percent(SLIPPAGE.min)} and ${percent(SLIPPAGE.max)}`;

export interface QuoteBody {
  from: string;
  to: string;
  amount: string;
  pay: PayMethod;
  /** The slippage limit in basis points. The usual 1% when left out. */
  slippageBps?: number;
  recipient?: string;
  refundTo?: string;
  /** Connected wallet address on the origin chain, when there is one. */
  sender?: string;
  /**
   * True when the person chose to route this one swap in public. It only means something while the
   * server's setting is "basic", and only `true` is read. It is the one thing a request can say
   * about routing: it can lower the level for one swap, and nothing can raise it.
   */
  withoutPrivate?: boolean;
}

export interface FeeView {
  /** Our fee, in bps of the input amount. */
  appBps: number;
  /** The provider's fee, in bps of the input amount. */
  providerBps: number;
  /** Both fees as raw amounts of the input coin. */
  appAmount: string;
  providerAmount: string;
}

export interface QuoteView {
  from: string;
  to: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  amountInUsd: string;
  amountOutUsd: string;
  slippageBps: number;
  /** Seconds, as estimated by the provider. */
  timeEstimate: number;
  fees: FeeView;
  /** Network fee the provider takes from the output, raw output units. Already inside amountOut. */
  withdrawFee: string | null;
  /** Fee the provider takes from a refund, raw input units. */
  refundFee: string | null;
  priceImpactBps: number | null;
  /**
   * How this quote was asked for and verified: "confidential" or "public". The server sends it
   * with every quote. (Marked optional only so that examples written before it still fit; a
   * missing one reads as public.)
   */
  routing?: Routing;
  serverNow: string;
}

export interface ReviewedNumbers {
  amountOut: string;
  minAmountOut: string;
  /** appBps + providerBps the person saw. */
  totalFeeBps: number;
  /** The routing of the quote the person saw, as that quote said it. Left out, it is read as public. An order that would be routed the other way is not made. */
  routing?: Routing;
}

export interface CreateOrderBody {
  from: string;
  to: string;
  amount: string;
  pay: PayMethod;
  /** The slippage limit the reviewed numbers were worked out with, in basis points. The usual 1% when left out. */
  slippageBps?: number;
  recipient: string;
  refundTo: string;
  sender?: string;
  /** Where this swap's points go: an address on BNB Chain. Left out, or empty, the swap adds no points. */
  rewardsAddress?: string;
  /** True when the person chose to route this one swap in public, as in the quote that was reviewed. Only `true` is read. */
  withoutPrivate?: boolean;
  reviewed: ReviewedNumbers;
  termsVersion: string;
  termsAccepted: true;
  /** Random, at least 22 characters, the same on every retry of this one order: a retry then returns the first order instead of making a second. */
  requestId?: string;
}

export interface CoinRef {
  id: string;
  symbol: string;
  name: string;
  chain: string;
  decimals: number;
  contract: string | null;
}

export interface TxRef {
  hash: string;
  /** Built from our own explorer allowlist. Null when we have no explorer for the chain. */
  url: string | null;
}

export interface OrderDetails {
  originTxs: TxRef[];
  destinationTxs: TxRef[];
  depositedAmount: string | null;
  amountIn: string | null;
  amountOut: string | null;
  refundedAmount: string | null;
  refundReason: string | null;
}

export interface OrderView {
  id: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  /** When the current status began. */
  statusSince: string;
  pay: PayMethod;
  from: CoinRef;
  to: CoinRef;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  amountInUsd: string;
  amountOutUsd: string;
  slippageBps: number;
  timeEstimate: number;
  fees: FeeView;
  withdrawFee: string | null;
  refundFee: string | null;
  recipient: string;
  refundTo: string;
  /** Where this swap's points go, or null when it adds none. */
  rewardsAddress: string | null;
  /**
   * How this order is routed: "confidential" or "public", as it was made. The server sends it with
   * every order; one stored before routing was kept reads as public. (Marked optional only so that
   * examples written before it still fit.)
   */
  routing?: Routing;
  /** Null once deposits are closed (2 minutes before the deadline) or the order has moved on. */
  depositAddress: string | null;
  depositMemo: string | null;
  depositsOpen: boolean;
  /** After this time the deposit address goes inactive and a deposit may be lost. */
  deadline: string;
  depositTxHash: string | null;
  /** True once funds are known to be in the order: the provider has started on it, or we confirmed the deposit on-chain. */
  depositProven: boolean;
  depositTxUrl: string | null;
  details: OrderDetails | null;
  serverNow: string;
}

export type ErrorCode =
  | "bad_request"
  | "invalid_amount"
  | "invalid_asset"
  | "invalid_recipient"
  | "invalid_rewards"
  | "invalid_refund"
  | "invalid_sender"
  | "unsupported_address"
  | "session"
  | "origin"
  | "paused"
  | "region"
  | "rate_limited"
  | "not_found"
  | "too_large"
  | "no_route"
  | "private_unavailable"
  | "min_usd"
  | "amount_too_low"
  | "blocked"
  | "price_moved"
  | "terms"
  | "try_later"
  | "busy"
  | "conflict"
  | "not_verified"
  | "unavailable";

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    /** Plain words, safe to show. Never an upstream message. */
    message: string;
    /** Small structured extras, such as a minimum amount. */
    detail?: Record<string, string | number>;
    /** Present on "price_moved": the fresh numbers to confirm. */
    quote?: QuoteView;
  };
}
