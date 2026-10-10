// The contract between the browser and our server.
// Amounts are always raw integer strings in the coin's smallest unit.

export const TERMS_VERSION = "2026-10-10";

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
  /** The site's own address (scheme and host), or null where none is known. */
  siteUrl: string | null;
  /** True where the server refuses visitors by where they are. The Privacy Policy says that a country is worked out only then. */
  regionBlock: boolean;
  /** True where the Stats page is switched on. Where it is not, the site has no link to it and its address is no page. */
  statsPage: boolean;
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

/** A coin as the Stats page names it: its symbol and its chain's code. */
export interface StatsCoin {
  symbol: string;
  chain: string;
}

/** A share of the total volume as the Stats page says it: whole per cent, rounded down, or "<1" for a share that is more than nothing and under one per cent. */
export type StatsShare = number | "<1";

/**
 * One line of "Recent swaps": the sending side of one delivered swap. These four things and nothing
 * else. Nothing of the receiving side is here: not the coin received, not its chain, not the amount
 * received, not the receiving address, not the delivery's transaction. And no order, and no address
 * of any kind.
 */
export interface StatsFeedRow {
  /** The coin that was sent, with how many decimal places its amounts have. */
  coin: StatsCoin & { decimals: number };
  /** The amount sent, in the coin's smallest unit. */
  amount: string;
  /** When the swap began on the sending side, by the server's clock, to the minute: "2026-10-08T12:03:00Z". Never the moment of delivery. */
  at: string;
  /** The hash of the transaction that paid the deposit, on the chain the coin was sent from. Null when it is not known. */
  tx: string | null;
}

/**
 * What the Stats page is sent. Every dollar figure is a whole number of US dollars, rounded down.
 * Everything in it is counted from what swaps sent: it says nothing of what any swap received, or where.
 */
export interface StatsResponse {
  totals: {
    swaps: number;
    volumeUsd: number;
    /** The hour now running and the 23 before it. */
    volume24hUsd: number;
    /** How many chains a delivered swap has been sent from. */
    chains: number;
    /** The average, in seconds. Null while no delivery has been timed. */
    deliverySeconds: number | null;
  };
  /** The five coins with the most volume sent, largest first. */
  coins: { coin: StatsCoin; volumeUsd: number }[];
  /** The five coins with the most volume delivered, largest first: totals only. Null until the site has delivered enough swaps for the list to be shown. */
  received: { coin: StatsCoin; volumeUsd: number }[] | null;
  /** The five chains with the most volume sent from them, largest first. */
  chains: { chain: string; name: string; volumeUsd: number }[];
  /**
   * Every chain a delivered swap has been sent from, by its code: how many swaps were sent from it,
   * and its share of the total volume. As many entries as `totals.chains` says.
   */
  chainsUsed: { chain: string; swaps: number; share: StatsShare }[];
  /** The latest delivered swaps, the newest first. */
  feed: StatsFeedRow[];
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

/**
 * What the page sends to ask whether gas can be added beside a swap: the swap's two coins, how it
 * is paid, and its addresses where they are known. The swap's amount is no part of it: a gas order
 * has a size of its own. Nothing here says where the gas would go or how it would be routed: the
 * server delivers it to the swap's receiving address, by private routing, or does not offer it.
 */
export interface GasBody {
  from: string;
  /** The coin the swap receives. The gas is that coin's chain's own coin. */
  to: string;
  pay: PayMethod;
  recipient?: string;
  refundTo?: string;
  sender?: string;
}

/** A gas order as it would be made now: its size, and the provider's verified preview of it. */
export interface GasQuote {
  /** The size, in whole US dollars: 3, 5 or 10 (shared/gas.ts). */
  usd: number;
  /** The preview. `from` is the coin the swap is paid with, `to` the receiving chain's own coin, `amountIn` what the gas order would be sent. Always privately routed. */
  quote: QuoteView;
}

/** The answer about gas. `gas` is null wherever it is not offered, whatever the reason: the page then shows no switch. */
export interface GasResponse {
  gas: GasQuote | null;
  serverNow: string;
}

/**
 * What a swap's page is told of the gas order asked for with it.
 *  - `made: false`: gas was asked for and could not be added when the swap was made. The swap is unaffected.
 *  - `made: true` with an order: the gas order as it stands, an ordinary order with its own deposit address, deadline and state.
 *  - `made: true` with no order: the gas order was made in Ghost mode and has finished, so its record is deleted; `ended` is the one word kept of it.
 * Once the gas order's record is no longer kept and nothing is known of how it ended, the swap is sent no `gas` at all.
 */
export type GasLine = { made: false } | { made: true; order: OrderView } | { made: true; order: null; ended: "delivered" | "refunded" | "expired" };

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
  /**
   * True for an order made in Ghost mode. Only `true` is read. Such an order has no row among the
   * recent swaps, and its record is deleted from the server once nothing more can happen to it and no
   * funds are in it: at once when it is delivered or refunded, and, when it ran out unpaid, when the
   * watch for a late deposit ends. It switches off no check: the quote, the provider's signature, the
   * limits and the screening apply as to any order.
   */
  ghost?: boolean;
  /**
   * Present when the person switched "Add gas" on: the gas order as they reviewed it. `amount` is
   * what it is sent, of the coin the swap is paid with, and `reviewed` its numbers. That is all a
   * request can say of it. Its receiving address is the swap's, its refund address the swap's, the
   * coin it delivers the receiving chain's own, its routing private: the server sets each, and
   * reads none of them from here. Where it cannot be made, the swap is made all the same.
   */
  gas?: { amount: string; reviewed: ReviewedNumbers };
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
  /** Present, and true, for an order made in Ghost mode: its page says that its record is deleted when it finishes. */
  ghost?: true;
  /** Present on a swap that gas was asked for with: what became of that. Absent on every other order. */
  gas?: GasLine;
  /** Present, and true, on a gas order itself, opened by its own ID. It is sent no `gas` of its own. */
  gasOrder?: true;
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
  // An order made in Ghost mode that has finished: its record was deleted. Answered with status 410. Where it is known how the
  // order ended, `detail.ended` says so in one word ("delivered", "refunded" or "expired"); nothing else is known of it.
  | "order_deleted"
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
    /** Present on "order_deleted" for a swap whose gas order is still known: the one link leads to both until each is gone. */
    gas?: GasLine;
  };
}
