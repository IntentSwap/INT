// The sentences of the service banner. One copy, used by the page (which shows the banner) and by
// the server (which writes it into the page it sends, so that it is there from the first moment
// and nothing moves when the page's scripts arrive).

export const BANNER_WORDS = {
  paused: "Swaps are paused. Existing orders are still tracked.",
  degraded: "The swap service is slow right now. Quotes may take longer than usual.",
} as const;

export type BannerKind = keyof typeof BANNER_WORDS;

/**
 * The one thing a practice order says of itself: a line beside its deposit address. Practice mode
 * is the operator's own tool on the operator's own machine and is not otherwise shown; this line
 * stays, because an address on a screen invites a transfer.
 */
export const PRACTICE_ORDER_LINE = "Practice order. Do not send funds.";

