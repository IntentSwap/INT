// Pure rules behind the swap card. No browser APIs here, so every rule is unit-tested.

import { checkAddress } from "../../../shared/addresses.ts";
import { decimalToScaled, displayAmount, formatExact, parseAmount, spokenAmount, usdScaled, worseByMoreThan } from "../../../shared/amounts.ts";
import { routingOf, SLIPPAGE, SLIPPAGE_BOUNDS_WORDS, type Confidentiality, type ErrorCode, type OrderView, type PayMethod, type QuoteView, type Routing, type TokenView } from "../../../shared/api.ts";
import { chainName } from "../../../shared/chains.ts";
import { CHAIN_ORDER, FEATURED_CHAINS, PINNED_SYMBOLS } from "../config.ts";

/** Font sizes the amount field steps through as the number grows. */
export const AMOUNT_STEPS = [28, 24, 20, 16, 14, 12, 11] as const;
export type AmountStep = (typeof AMOUNT_STEPS)[number];
/** Width of one character of the mono typeface, as a share of the font size. */
export const MONO_ADVANCE = 0.6;

/** The largest step at which `length` characters fit in `widthPx`. Never clips: falls back to the smallest step. */
export function amountStep(length: number, widthPx: number): AmountStep {
  for (const size of AMOUNT_STEPS) {
    if (Math.max(1, length) * size * MONO_ADVANCE <= widthPx) return size;
  }
  return 11;
}

/** How many characters fit at the smallest step. The amount field accepts no more, so it never has to scroll. */
export function maxAmountChars(widthPx: number): number {
  const smallest = AMOUNT_STEPS[AMOUNT_STEPS.length - 1] ?? 11;
  return Math.max(8, Math.min(40, Math.floor(widthPx / (smallest * MONO_ADVANCE))));
}

/** Shortens an amount to `maxChars` by dropping decimals from the end. Never rounds up, never touches the whole part. */
export function fitAmount(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const point = text.indexOf(".");
  if (point === -1) return text;
  const kept = text.slice(0, Math.max(point, maxChars));
  return kept.endsWith(".") ? kept.slice(0, -1) : kept;
}

/**
 * What may be typed into the amount field: digits and one decimal point. A lone comma counts
 * as the point (as it is typed on many keyboards). More decimals than the coin has, more than
 * `maxChars` characters, or anything else, gives null, and the keystroke is simply not taken.
 */
export function cleanAmount(text: string, decimals: number, maxChars = 40): string | null {
  let value = text.replace(/\s/g, "");
  const commas = (value.match(/,/g) ?? []).length;
  const dots = (value.match(/\./g) ?? []).length;
  if (commas === 1 && dots === 0) value = value.replace(",", ".");
  if (value !== "" && !/^(\d+\.?\d*|\.\d*)$/.test(value)) return null;
  const [, frac = ""] = value.split(".");
  if (frac.length > decimals) return null;
  if (value.length > Math.min(40, maxChars)) return null;
  return value;
}

/**
 * What "Max" puts in the amount field: the whole balance, less a reserve for network fees when
 * the coin is the chain's own (a transfer of everything would leave nothing to pay for itself).
 * Never negative. `reserveText` is in whole coins, from the settings.
 */
export function maxSpendable(balance: bigint, token: Pick<TokenView, "decimals" | "contract">, reserveText: string | undefined): string {
  let reserve = 0n;
  if (token.contract === null && reserveText !== undefined) {
    const parsed = parseAmount(reserveText, token.decimals);
    if (parsed.ok) reserve = parsed.raw;
  }
  return formatExact(balance > reserve ? balance - reserve : 0n, token.decimals);
}

/** "about N min": never seconds, never less than a minute. */
export function aboutMinutes(seconds: number): string {
  return `about ${Math.max(1, Math.ceil(seconds / 60))} min`;
}

/** Six characters, an ellipsis, six characters. Short strings are left alone. */
export function shortAddress(address: string, keep = 6): string {
  return address.length <= keep * 2 + 2 ? address : `${address.slice(0, keep)}…${address.slice(-keep)}`;
}

/** Splits an address into its emphasised ends and its middle. */
export function addressParts(address: string): { start: string; middle: string; end: string } {
  if (address.length <= 12) return { start: address, middle: "", end: "" };
  return { start: address.slice(0, 6), middle: address.slice(6, -6), end: address.slice(-6) };
}

/** "USDT · BNB Chain": a coin is always shown with its chain. */
export function coinLabel(token: Pick<TokenView, "symbol" | "chain">): string {
  return `${token.symbol} · ${chainName(token.chain)}`;
}

function chainRank(chain: string): number {
  const i = (CHAIN_ORDER as readonly string[]).indexOf(chain);
  return i === -1 ? CHAIN_ORDER.length : i;
}

/**
 * Picker order: the pinned coins first (BNB, USDT, USDC, ETH, BTC, SOL, ZEC, NEAR),
 * then coins the person holds, then everything else by symbol. Within a symbol,
 * chains follow the agreed chain order.
 */
export function sortTokens(tokens: TokenView[], balances: ReadonlyMap<string, bigint> = new Map()): TokenView[] {
  const pinned = (symbol: string) => {
    const i = (PINNED_SYMBOLS as readonly string[]).indexOf(symbol);
    return i === -1 ? PINNED_SYMBOLS.length : i;
  };
  const group = (token: TokenView) => (pinned(token.symbol) < PINNED_SYMBOLS.length ? 0 : (balances.get(token.id) ?? 0n) > 0n ? 1 : 2);
  return [...tokens].sort((a, b) => {
    const byGroup = group(a) - group(b);
    if (byGroup !== 0) return byGroup;
    if (group(a) === 0) {
      const byPin = pinned(a.symbol) - pinned(b.symbol);
      if (byPin !== 0) return byPin;
    } else {
      const bySymbol = a.symbol.localeCompare(b.symbol, "en", { sensitivity: "base" });
      if (bySymbol !== 0) return bySymbol;
    }
    return chainRank(a.chain) - chainRank(b.chain) || chainName(a.chain).localeCompare(chainName(b.chain), "en");
  });
}

/** The chain filter that stands for every chain without a chip of its own. */
export const OTHER_CHAINS = "other";

export type SearchResult = { kind: "list"; tokens: TokenView[] } | { kind: "unsupported" };

function looksLikeContract(text: string): boolean {
  return /^0x[0-9a-fA-F]{40,64}$/.test(text) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) || /^[a-z0-9._-]+\.near$/.test(text);
}

/**
 * Search by symbol, name, or a pasted contract address. A symbol or name search
 * only ever returns listed coins. A pasted contract that is not listed says so
 * rather than showing something that merely looks similar.
 */
export function searchTokens(tokens: TokenView[], query: string, chain: string | null): SearchResult {
  const featured = FEATURED_CHAINS as readonly string[];
  const inChain = chain === null ? tokens : chain === OTHER_CHAINS ? tokens.filter((token) => !featured.includes(token.chain)) : tokens.filter((token) => token.chain === chain);
  const text = query.trim();
  if (text === "") return { kind: "list", tokens: inChain };
  const lower = text.toLowerCase();
  const byContract = tokens.filter((token) => token.contract !== null && token.contract.toLowerCase() === lower);
  if (byContract.length > 0) return { kind: "list", tokens: byContract };
  if (looksLikeContract(text)) return { kind: "unsupported" };
  const score = (token: TokenView): number => {
    const symbol = token.symbol.toLowerCase();
    const name = token.name.toLowerCase();
    if (symbol === lower) return 0;
    if (symbol.startsWith(lower)) return 1;
    // A name matches from the start of any of its words ("ether" finds "Wrapped Ether", not "Tether").
    if (name.split(/[\s.-]+/).some((word) => word.startsWith(lower))) return 2;
    if (symbol.includes(lower)) return 3;
    if (chainName(token.chain).toLowerCase().startsWith(lower)) return 4;
    return -1;
  };
  const scored = inChain.map((token) => ({ token, score: score(token) })).filter((entry) => entry.score >= 0);
  // A stable sort keeps the picker order within each rank.
  scored.sort((a, b) => a.score - b.score);
  return { kind: "list", tokens: scored.map((entry) => entry.token) };
}

/** Reads `?from=bsc:BNB&to=sol:USDT&amount=0.5`. Only coins on the list are accepted, and never an address. The amount is rewritten in its plain form. */
export function parsePrefill(search: string, tokens: TokenView[]): { from?: TokenView; to?: TokenView; amount?: string } {
  const params = new URLSearchParams(search);
  const find = (value: string | null): TokenView | undefined => {
    if (value === null) return undefined;
    const match = /^([a-z0-9]{2,20}):([A-Za-z0-9$.()_-]{1,24})$/.exec(value);
    if (!match) return undefined;
    const symbol = (match[2] ?? "").toLowerCase();
    return tokens.find((token) => token.chain === match[1] && token.symbol.toLowerCase() === symbol);
  };
  const out: { from?: TokenView; to?: TokenView; amount?: string } = {};
  const from = find(params.get("from"));
  const to = find(params.get("to"));
  if (from) out.from = from;
  if (to && to.id !== from?.id) out.to = to;
  const amount = params.get("amount");
  // An amount is an amount of the coin the link names. When that coin is not on the list the amount
  // means nothing here, and is not applied to whichever coin is shown instead.
  const coinKnown = params.get("from") === null || from !== undefined;
  if (amount !== null && coinKnown && /^\d{1,30}(\.\d{1,30})?$/.test(amount)) {
    const decimals = from?.decimals ?? 18;
    const parsed = parseAmount(amount, decimals);
    // Written back in its plain form: "000001" from a link is shown as "1", so the field never says something other than what is quoted.
    if (parsed.ok) out.amount = formatExact(parsed.raw, decimals);
  }
  return out;
}

export interface QuoteProblem {
  code: ErrorCode | "network";
  message: string;
  detail: Record<string, string | number>;
  /** How long the server asked us to wait before asking again, when it said. */
  waitMs?: number;
}

/**
 * Whether a failed quote is asked for again by itself. Only when trying again can help without
 * anything changing: the connection, a busy moment, a pair with no route just now. A refusal
 * (a blocked address, a blocked region, a pause) and anything wrong with the inputs is not. Nor is
 * "private routing is not available": the card then waits for the person, who may choose to swap
 * without it or press Refresh. Nothing is asked again, and nothing is switched, by itself.
 */
export function retriesItself(code: QuoteProblem["code"]): boolean {
  return code === "network" || code === "try_later" || code === "unavailable" || code === "busy" || code === "no_route" || code === "rate_limited" || code === "session";
}

/* ---- Private routing ----
   The server routes swaps privately or in public, and tells the page which (`privacyMode`). The
   page never chooses a level. It can say one thing: "not private, for this one swap", when the
   person asks for that. Everything below is shown only where it applies: with the server routing
   in public, the card, the review and an order's page say nothing of routing at all. */

/** The server's routing setting as the page knows it. Null until the server has said. */
export type PrivacyMode = Confidentiality | null;

/** What is said when a private quote, or a private order, could not be had. The card and the review say it in the same words. */
export const PRIVATE_UNAVAILABLE = "Private routing is not available for this swap right now.";

/** What the review says of points for a swap IntentSwap takes no fee on, in place of where the points go. */
export const NO_FEE_NO_POINTS = "This swap adds no points: IntentSwap takes no fee on it.";

/**
 * Whether a quote or an order is routed privately, by its own word. One that says nothing (an
 * order made before routing was kept) is public, and so is any word but the one for private.
 */
export function routedPrivately(view: { routing?: unknown } | null): boolean {
  return view !== null && view.routing === routingOf("basic");
}

/**
 * What a quote request or an order request says about routing: `withoutPrivate: true` when the
 * person chose public routing for this swap and the server routes privately, and otherwise nothing
 * at all. The same rule for both requests, so an order is asked for as its quote was.
 */
export function routingChoice(mode: PrivacyMode, withoutPrivate: boolean): { withoutPrivate?: true } {
  return mode === "basic" && withoutPrivate ? { withoutPrivate: true } : {};
}

/**
 * What an answer about a quote tells of the server's own routing setting, or null when it tells
 * nothing. A private quote, and "private routing is not available", come only from a server that
 * routes privately. A public quote that was not asked for as one comes only from a server that
 * routes in public; one that was asked for as one tells nothing either way.
 */
export function modeTold(asked: { withoutPrivate?: boolean }, answer: { routing?: unknown } | "private_unavailable"): Confidentiality | null {
  if (answer === "private_unavailable" || routedPrivately(answer)) return "basic";
  return answer.routing === routingOf("public") && asked.withoutPrivate !== true ? "public" : null;
}

/**
 * What the left end of the row above the card's fields holds, for the swap being set up.
 *  - "private": the small tag. Private routing is in force for this swap.
 *  - "public-by-choice": the person chose public routing for this swap. The way back is offered.
 *  - null: nothing. The server routes in public (or has not said yet).
 */
export function cardRouting(mode: PrivacyMode, withoutPrivate: boolean): "private" | "public-by-choice" | null {
  if (mode !== "basic") return null;
  return withoutPrivate ? "public-by-choice" : "private";
}

/** What a row about routing says, and whether the small tag goes with it. */
export interface RoutingNote {
  private: boolean;
  text: string;
}

/**
 * What is said about the routing of a quote or an order, or null when nothing is. A private one
 * always says so, whatever the server's setting is now: an order made privately stays so. A public
 * one says so only while the server routes privately, where it is the exception; `byChoice` is
 * true when it is this person's own choice for the swap on the card.
 */
export function routingNote(mode: PrivacyMode, view: { routing?: unknown } | null, byChoice = false): RoutingNote | null {
  if (view === null) return null;
  if (routedPrivately(view)) return { private: true, text: "Private" };
  if (mode !== "basic") return null;
  return { private: false, text: byChoice ? "Public, by your choice" : "Public" };
}

/**
 * True for a quote or an order with no IntentSwap fee at all. Only a privately routed swap can be
 * one, and only where the server is set to take no fee on those. Such a swap adds no points:
 * points are counted from that fee.
 */
export function feeFree(view: { fees: { appBps: number; appAmount: string } } | null): boolean {
  return view !== null && view.fees.appBps === 0 && /^0+$/.test(view.fees.appAmount);
}

/** What the "IntentSwap fee" row says in place of "0.00% · 0 ETH". Null where the fee is given in figures, as ever. */
export function appFeeWords(view: Pick<QuoteView, "fees"> | null): string | null {
  return feeFree(view) ? "None" : null;
}

/** What a screen reader is told of a new quote. The exact figure: the short form of a very small amount is not something that can be read aloud. */
export function quoteAnnouncement(to: Pick<TokenView, "symbol" | "chain" | "decimals">, amountOut: bigint, privately: boolean): string {
  return `You receive about ${formatExact(amountOut, to.decimals)} ${to.symbol} on ${chainName(to.chain)}${privately ? ", privately routed" : ""}.`;
}

export interface ActionInput {
  paused: boolean;
  coinsReady: boolean;
  from: TokenView | null;
  to: TokenView | null;
  amountText: string;
  pay: PayMethod;
  walletConnected: boolean;
  /** The connected wallet's balance of the origin coin, when known. */
  balance: bigint | null;
  recipient: string;
  refundTo: string;
  quote: "none" | "loading" | "ready" | "expired";
  problem: QuoteProblem | null;
  /** True when price impact is over 10% and the tick-box is not ticked. */
  impactUnconfirmed: boolean;
}

/** "without-private": a private quote could not be had, and the button offers this one swap in public. Pressing it is the person's choice; nothing switches by itself. */
export type ActionKind = "review" | "connect" | "refresh" | "retry" | "without-private" | "blocked";

export interface PrimaryAction {
  kind: ActionKind;
  /** The next step, or the reason nothing can happen yet. Never empty. */
  label: string;
  disabled: boolean;
  busy: boolean;
}

const blocked = (label: string, busy = false): PrimaryAction => ({ kind: "blocked", label, disabled: true, busy });

/**
 * The one button's label: always the next step or the blocker.
 * It is never disabled without saying why.
 */
export function primaryAction(input: ActionInput): PrimaryAction {
  const { from, to } = input;
  if (input.paused) return blocked("Swaps are paused");
  if (!input.coinsReady || from === null || to === null) return blocked("Loading coins…", true);

  const parsed = parseAmount(input.amountText, from.decimals);
  if (!parsed.ok) {
    if (parsed.reason === "empty") return blocked("Enter an amount");
    if (parsed.reason === "too_many_decimals") return blocked(`At most ${from.decimals} decimals`);
    if (parsed.reason === "too_large") return blocked("That amount is too large");
    return blocked("Enter a valid amount");
  }
  if (parsed.raw === 0n) return blocked("Enter an amount");

  if (input.problem !== null) {
    const { code, detail, message } = input.problem;
    if (code === "min_usd") {
      // Short enough for one line at 360 px. The pair is the one on screen, so it is not repeated.
      const usd = typeof detail.usd === "string" && /^\d{1,12}$/.test(detail.usd) ? detail.usd.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : null;
      return blocked(usd === null ? message : `Minimum is $${usd} right now`);
    }
    if (code === "amount_too_low") {
      const min = typeof detail.min === "string" && /^\d+$/.test(detail.min) ? BigInt(detail.min) : null;
      if (min === null) return blocked("Too low for this pair");
      // The coin is the one on the card, so with a long symbol the figure alone still says what is needed.
      const least = roundUpForDisplay(min, from.decimals);
      return blocked(fitLabel([`Minimum is ${least} ${from.symbol}`, `Minimum ${least} ${from.symbol}`, `Minimum is ${least}`, "Too low for this pair"], CARD_BUTTON_ROOM));
    }
    if (code === "too_large") return blocked(message);
    if (code === "paused") return blocked("Swaps are paused");
    if (code === "region") return blocked("Not available in your region");
    if (code === "invalid_recipient" || code === "invalid_refund" || code === "unsupported_address") return blocked(code === "invalid_refund" ? "Check the refund address" : "Check the receiving address");
    if (code === "blocked") return blocked("This swap can't be processed");
    // The card says why above the button; the button is the explicit choice. One line at 360 px.
    if (code === "private_unavailable") return { kind: "without-private", label: "Swap without private routing", disabled: false, busy: false };
    // Anything else is worth another try.
    return { kind: "retry", label: "Try again", disabled: false, busy: false };
  }

  if (input.pay === "wallet" && !input.walletConnected) return { kind: "connect", label: "Connect wallet", disabled: false, busy: false };
  if (input.pay === "wallet" && input.balance !== null && input.balance < parsed.raw) return blocked(`Not enough ${from.symbol}`);

  if (input.quote === "none" || input.quote === "loading") return blocked("Getting a quote…", true);

  if (input.recipient.trim() === "") return blocked("Enter receiving address");
  if (!checkAddress(to.chain, input.recipient).ok) return blocked("Check the receiving address");
  // Every order needs a refund address. Paying from a wallet it is the wallet's own where that is
  // known to be the person's on the paying chain (see refundFor); where it is not, one must be entered.
  if (input.refundTo.trim() === "") return blocked("Enter refund address");
  if (!checkAddress(from.chain, input.refundTo).ok) return blocked("Check the refund address");
  if (input.impactUnconfirmed) return blocked("Confirm the price impact");
  if (input.quote === "expired") return { kind: "refresh", label: "Refresh quote", disabled: false, busy: false };
  return { kind: "review", label: "Review swap", disabled: false, busy: false };
}

/**
 * The first of the given labels that fits a main button on one line of a phone, or the last of
 * them when none does. The labels are given longest first: the full one, then shorter ways of
 * saying it. Fit is judged by length: `room` is the number of characters that fit, digits being
 * the widest (29 on the swap card at 360 px, 22 on an order's pay step, which is narrower).
 */
export function fitLabel(candidates: readonly string[], room: number): string {
  return candidates.find((label) => label.length <= room) ?? candidates[candidates.length - 1] ?? "";
}

/** How many characters fit on one line of the swap card's main button at 360 px. */
export const CARD_BUTTON_ROOM = 29;
/** The same for the pay step on an order's page, which sits inside a panel and is narrower. */
export const PAY_BUTTON_ROOM = 22;

/**
 * A minimum shown to a person is rounded UP to four significant digits, so that
 * typing the number shown always meets the minimum.
 */
export function roundUpForDisplay(raw: bigint, decimals: number): string {
  if (raw <= 0n) return "0";
  const digits = raw.toString();
  const keep = 4;
  if (digits.length <= keep) return formatExact(raw, decimals);
  const scale = 10n ** BigInt(digits.length - keep);
  const rounded = ((raw + scale - 1n) / scale) * scale;
  return formatExact(rounded, decimals);
}

/** "1 ETH = 2,496.40 USDT" */
export function rateText(from: TokenView, to: TokenView, amountIn: bigint, amountOut: bigint, options: { spoken?: boolean } = {}): string | null {
  if (amountIn <= 0n) return null;
  const perUnit = (amountOut * 10n ** BigInt(from.decimals)) / amountIn;
  // "spoken" is the wording for a screen reader: a very small number in full, not in its subscript form.
  return `1 ${from.symbol} = ${options.spoken === true ? spokenAmount(perUnit, to.decimals) : displayAmount(perUnit, to.decimals).text} ${to.symbol}`;
}

/**
 * What an amount is worth at the coin list's price, as a plain decimal string for displayUsd.
 * Shown beneath the amount until a quote brings the provider's own figure. Null when unknown.
 */
export function estimateUsd(amountText: string, token: Pick<TokenView, "decimals" | "price"> | null): string | null {
  if (token === null || token.price === null) return null;
  const parsed = parseAmount(amountText, token.decimals);
  const price = decimalToScaled(token.price, 18);
  if (!parsed.ok || parsed.raw === 0n || price === null) return null;
  const micro = usdScaled(parsed.raw, token.decimals, price) / 10n ** 12n;
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`;
}

/**
 * Whether the code stored at an address makes it a contract rather than a personal wallet.
 * No code is a plain wallet. So is a wallet that has handed its logic to a contract
 * (EIP-7702): its code is the 3-byte marker 0xef0100 followed by a 20-byte address.
 */
export function isContractCode(code: string): boolean {
  if (code === "0x" || code === "0x0") return false;
  return !/^0xef0100[0-9a-fA-F]{40}$/.test(code);
}

/**
 * What a minimum in dollars comes to in the coin being paid (from the list price, rounded up so
 * that typing it is enough). The button already names the dollar figure, so this adds only the
 * amount. Null when there is no clean figure or no price to work it out from.
 */
export function minimumNote(detail: Record<string, unknown>, from: Pick<TokenView, "symbol" | "decimals" | "price"> | null): string | null {
  const usd = typeof detail.usd === "string" && /^\d{1,12}$/.test(detail.usd) ? detail.usd : null;
  const price = from === null ? null : decimalToScaled(from.price, 18);
  if (usd === null || from === null || price === null || price === 0n) return null;
  // usd × 10^18 × 10^decimals ÷ price, rounded up.
  const top = BigInt(usd) * 10n ** 18n * 10n ** BigInt(from.decimals);
  const raw = (top + price - 1n) / price;
  return `That is about ${roundUpForDisplay(raw, from.decimals)} ${from.symbol}.`;
}

/** What was last read out to a screen reader about the quote. */
export interface Announced {
  /** The inputs the quote was for: coins and amount. */
  key: string;
  amountOut: bigint;
  at: number;
}

/**
 * Whether a new quote should be read out. A quote for new inputs always is. A refresh of the
 * same inputs is read out only when the amount has moved by more than 0.5% since the last time
 * something was said, and never more often than once in 30 seconds.
 */
export function shouldAnnounce(last: Announced | null, next: Announced): boolean {
  if (last === null || last.key !== next.key) return true;
  if (next.at - last.at < 30_000) return false;
  const moved = next.amountOut > last.amountOut ? next.amountOut - last.amountOut : last.amountOut - next.amountOut;
  // More than 0.5%: moved / last > 5 / 1000, in whole numbers.
  return moved * 1000n > last.amountOut * 5n;
}

/** "You send 0.5 BNB on BNB Chain. You receive about 371.20 USDT on Solana." For a privately routed swap, and only then, a third short sentence: "Routed privately." */
export function reviewSentence(from: TokenView, to: TokenView, amountIn: bigint, amountOut: bigint, options: { spoken?: boolean; privately?: boolean } = {}): string {
  const received = options.spoken === true ? spokenAmount(amountOut, to.decimals) : displayAmount(amountOut, to.decimals).text;
  return `You send ${formatExact(amountIn, from.decimals)} ${from.symbol} on ${chainName(from.chain)}. You receive about ${received} ${to.symbol} on ${chainName(to.chain)}.${options.privately === true ? " Routed privately." : ""}`;
}

/** What the person had in front of them when they confirmed. */
export interface Reviewed {
  from: string;
  to: string;
  amountIn: string;
  minAmountOut: string;
  /** The limit on how far the price may move, as shown in the review. */
  slippageBps: number;
  recipient: string;
  refundTo: string;
  /** Where the swap's points go, as shown in the review. Null when the swap adds none. Left out by callers from before points existed. */
  rewardsAddress?: string | null;
  /** How the quote on screen was routed, as that quote said it. Left out, it reads as public, as a quote that names no routing does. */
  routing?: Routing;
}

/** The furthest the minimum received may fall short of what was reviewed, in basis points. The server uses the same figure. */
export const REVIEW_TOLERANCE_BPS = 100;

/**
 * Compares the order the server made with what was reviewed. The coins, the amount paid, both
 * addresses, the routing and the slippage limit must match exactly; the minimum received may be at
 * most 1% lower. Returns what differs, or null when the order is the one that was confirmed.
 * Nothing is paid unless this is null.
 */
export function orderDiffers(order: Pick<OrderView, "from" | "to" | "amountIn" | "minAmountOut" | "slippageBps" | "recipient" | "refundTo"> & { rewardsAddress?: string | null; routing?: Routing }, reviewed: Reviewed): string | null {
  if (order.from.id !== reviewed.from) return "the coin you pay";
  if (order.to.id !== reviewed.to) return "the coin you receive";
  if (order.amountIn !== reviewed.amountIn) return "the amount you pay";
  if (order.recipient !== reviewed.recipient) return "the receiving address";
  if (order.refundTo !== reviewed.refundTo) return "the refund address";
  // An order is never made by another route than the one on screen. Either side that names no routing is public.
  if (routedPrivately(order) !== routedPrivately(reviewed)) return "the routing";
  if (reviewed.rewardsAddress !== undefined && (order.rewardsAddress ?? null) !== reviewed.rewardsAddress) return "the rewards address";
  // A looser limit than the one reviewed could hide inside the 1% allowed below: it is compared on its own.
  if (order.slippageBps !== reviewed.slippageBps) return "the slippage limit";
  if (!/^\d+$/.test(order.minAmountOut) || !/^\d+$/.test(reviewed.minAmountOut)) return "the minimum you receive";
  if (worseByMoreThan(BigInt(reviewed.minAmountOut), BigInt(order.minAmountOut), REVIEW_TOLERANCE_BPS)) return "the minimum you receive";
  return null;
}

/** "unavailable": the server would not make the order with private routing. No order was made, and the sheet offers only a way out: the choice is made on the card. */
export type ReviewPhase = "review" | "creating" | "moved" | "mismatch" | "unavailable";
export interface ReviewAction {
  kind: "confirm" | "refresh" | "close" | "none";
  label: string;
  disabled: boolean;
  busy: boolean;
}

/** The review sheet's one button: the next step, or the reason nothing can happen yet. */
export function reviewAction(input: {
  phase: ReviewPhase;
  quote: "none" | "loading" | "ready" | "expired";
  termsAccepted: boolean;
  /** New numbers arrived a moment ago: nothing can be confirmed until they have been on screen long enough to read. */
  settling?: boolean;
  /** The price impact is above the level that needs a tick, and the tick is not there. */
  impactUnconfirmed?: boolean;
}): ReviewAction {
  if (input.phase === "creating") return { kind: "none", label: "Creating order…", disabled: true, busy: true };
  // The order that came back was not the one reviewed. Nothing more is confirmed from this sheet.
  if (input.phase === "mismatch") return { kind: "close", label: "Close and start again", disabled: false, busy: false };
  // Private routing could not be had for the order. Nothing is confirmed from here, and nothing is switched from here either.
  if (input.phase === "unavailable") return { kind: "close", label: "Close", disabled: false, busy: false };
  if (input.quote === "loading") return { kind: "none", label: "Getting a quote…", disabled: true, busy: true };
  // An old quote is never confirmed: the numbers are dimmed and the button fetches new ones.
  if (input.quote === "expired" || input.quote === "none") return { kind: "refresh", label: "Refresh quote", disabled: false, busy: false };
  if (input.settling) return { kind: "none", label: "Check the new numbers", disabled: true, busy: false };
  if (input.impactUnconfirmed) return { kind: "none", label: "Confirm the price impact", disabled: true, busy: false };
  if (!input.termsAccepted) return { kind: "none", label: "Accept the Terms to continue", disabled: true, busy: false };
  return { kind: "confirm", label: input.phase === "moved" ? "Confirm new numbers" : "Confirm swap", disabled: false, busy: false };
}

/**
 * Whether it is time to ask for the quote again without anyone pressing anything: 15 seconds
 * after the last answer, and never while the person is typing, a request is already out, a sheet
 * is open or the tab is hidden. After a failure only when trying again can help, and no sooner
 * than the server asked.
 */
export function refreshDue(input: { typing: boolean; loading: boolean; hidden: boolean; sheetOpen: boolean; hasQuote: boolean; problem: QuoteProblem | null; fetchedAt: number; now: number; refreshMs: number }): boolean {
  if (input.typing || input.loading || input.hidden || input.sheetOpen) return false;
  if (!input.hasQuote && input.problem === null) return false;
  // A refusal is not asked about again by itself: only a change of input, or the person, tries again.
  if (input.problem !== null && !retriesItself(input.problem.code)) return false;
  return input.now >= input.fetchedAt + Math.max(input.refreshMs, input.problem?.waitMs ?? 0);
}

/** "28 minutes", "1 hour", "1 hour 58 minutes", "2 hours". */
export function minutesText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const whole = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return rest === 0 ? whole : `${whole} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

/**
 * The refund address an order is made with: what the person typed, or, paying from a wallet and
 * with nothing typed, the wallet's own address where it may be offered on the paying chain
 * (`walletOnPayingChain`, from walletAddressFor). Empty when there is neither: a refund address
 * must then be entered. The wallet's address is never used for a chain it is not known to be the
 * person's on.
 */
export function refundFor(pay: PayMethod, typed: string, walletOnPayingChain: string | null): string {
  if (typed.trim() !== "") return typed;
  return pay === "wallet" ? (walletOnPayingChain ?? "") : "";
}

/**
 * Whether the card shows the refund address field. Always when paying by hand. Paying from a
 * wallet: when the wallet's own address cannot be used on the paying chain, and whenever the field
 * holds anything, because what is typed there is what the order would be made with (see refundFor)
 * and must never be in force unseen.
 */
export function asksForRefund(pay: PayMethod, walletConnected: boolean, walletOnPayingChain: string | null, typed: string): boolean {
  if (pay === "manual") return true;
  if (typed.trim() !== "") return true;
  return walletConnected && walletOnPayingChain === null;
}

/**
 * Whether the connected wallet's address may be offered as an address on `chain`.
 * Always on the chain the wallet is on. On another chain of the same family only when the
 * wallet is known to be a plain one: a contract wallet's address may belong to someone else,
 * or to no one, on a different chain.
 */
export function walletAddressFor(chain: string, family: string, wallet: { address: string | null; chain: string | null; family: string | null; plain: boolean | null }): string | null {
  if (wallet.address === null || wallet.chain === null) return null;
  if (wallet.chain === chain) return wallet.address;
  if (wallet.family !== family || family !== "evm") return null;
  return wallet.plain === true ? wallet.address : null;
}

/**
 * Whether a swap's points have somewhere to go without the person doing anything more, which is
 * when the quote may say "+N points". Paying from a wallet they go to the wallet's own address,
 * where that is known to be the person's on the rewards chain too (an ordinary wallet; not a
 * contract wallet on another chain); before a wallet is connected that is what will happen for an
 * ordinary one. Sending it yourself, a swap adds points only if an address is given in the review,
 * so nothing is promised before then.
 */
export function pointsByDefault(pay: "wallet" | "manual", rewardsChain: string, wallet: { connected: boolean; address: string | null; chain: string | null; family: string | null; plain: boolean | null }): boolean {
  if (pay !== "wallet") return false;
  if (!wallet.connected) return true;
  return walletAddressFor(rewardsChain, "evm", wallet) !== null;
}

/** Coins that share their symbol and chain with another coin on the list: these need their contract shown to be told apart. */
export function lookAlikes(tokens: ReadonlyArray<Pick<TokenView, "id" | "symbol" | "chain">>): Set<string> {
  const seen = new Map<string, string[]>();
  for (const token of tokens) {
    const key = `${token.chain}:${token.symbol.toLowerCase()}`;
    seen.set(key, [...(seen.get(key) ?? []), token.id]);
  }
  return new Set([...seen.values()].filter((ids) => ids.length > 1).flat());
}

/** "1.5" (or "1,5") is 150 basis points. Null for anything that is not a plain percentage with at most two decimals. */
export function percentToBps(text: string): number | null {
  const match = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
}

/** The slippage limits offered as ready choices, in basis points. */
export const SLIPPAGE_CHOICES = [50, 100, 200] as const;

/**
 * What to say about a slippage limit someone is about to choose. Outside the allowed bounds it
 * cannot be used; low and high limits within them each come with one plain consequence.
 */
export function slippageAdvice(bps: number | null): { usable: boolean; note: string | null; tone: "plain" | "attention" } {
  if (bps === null || bps < SLIPPAGE.min || bps > SLIPPAGE.max) return { usable: false, note: `Choose a limit ${SLIPPAGE_BOUNDS_WORDS}.`, tone: "attention" };
  if (bps < 50) return { usable: true, note: "A low limit: more swaps are refunded when the price moves.", tone: "plain" };
  if (bps > 200) return { usable: true, note: "A high limit: you may receive noticeably less than the quote shows.", tone: "attention" };
  return { usable: true, note: null, tone: "plain" };
}

/** `balanceOf(address)`: the one read of a token contract this site makes. */
const BALANCE_OF = "0x70a08231";

/** The chain reads that give an address's balance of each coin: the chain's own coin directly, a token through its contract. */
export function balanceCalls(tokens: readonly Pick<TokenView, "contract">[], address: string): { method: string; params: unknown[] }[] {
  const owner = address.slice(2).toLowerCase().padStart(64, "0");
  return tokens.map((token) => (token.contract === null ? { method: "eth_getBalance", params: [address, "latest"] } : { method: "eth_call", params: [{ to: token.contract, data: `${BALANCE_OF}${owner}` }, "latest"] }));
}

/** A balance as the chain gives it: a hex quantity, or one 32-byte word. Null for anything else, which is shown as no balance rather than as zero. */
export function readBalance(result: unknown): bigint | null {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(result)) return null;
  return BigInt(result);
}

