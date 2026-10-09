// The swap card's state and its live quote.
//
// A quote is asked for 400 ms after the person stops typing and again every
// 15 seconds. Refreshing pauses while they type, while a sheet is open or the
// coin picker has the card, and while the tab is hidden; it resumes when the
// tab comes back. A newer request always cancels an older one.
//
// Routing is the server's setting. The one thing kept here about it is the
// person's choice to route this one swap in public (`withoutPrivate`), which is
// sent only where the server routes privately and only when it was chosen.
//
// The card always starts fresh. Whenever the swap page comes onto the screen the
// card is as a first visit finds it, and whenever the page is left the card is
// cleared (see visitSwap). Nothing typed into it is written to the browser's
// storage: it lives in this page's memory, and only for as long as the swap page is shown.
// (An order, once made, is another matter: it is noted in the list of this browser's orders. See stores/orders.ts.)

import { create } from "zustand";
import { checkAddress } from "../../../shared/addresses.ts";
import { formatExact, parseAmount } from "../../../shared/amounts.ts";
import { SLIPPAGE, type Confidentiality, type PayMethod, type QuoteBody, type QuoteView, type TokenView } from "../../../shared/api.ts";
import { api, ApiError } from "../api.ts";
import { DEFAULT_PAIR, QUOTE_DEBOUNCE_MS, QUOTE_EXPIRES_MS, QUOTE_REFRESH_MS, QUOTE_TIMEOUT_MS } from "../config.ts";
import { modeTold, parsePrefill, PRIVATE_UNAVAILABLE, refreshDue, routingChoice, type PrivacyMode, type QuoteProblem } from "../lib/swap-logic.ts";
import { useApp } from "./app.ts";
import { usePicker } from "./picker.ts";
import { useSheet } from "./sheet.ts";
import { findToken, useTokens } from "./tokens.ts";
import { useWallet } from "./wallet.ts";

interface SwapState {
  fromId: string | null;
  toId: string | null;
  amountText: string;
  pay: PayMethod;
  recipient: string;
  refundTo: string;
  impactConfirmed: boolean;
  /** The slippage limit asked for, in basis points. The usual 1% until the person chooses another. */
  slippageBps: number;
  /**
   * True when the person chose to route this one swap in public. It is theirs for this swap only:
   * a change of either coin clears it, and so does an order being made. A change of amount keeps it.
   */
  withoutPrivate: boolean;
  /** The last good quote. While a newer one loads it stays on screen, dimmed. */
  quote: QuoteView | null;
  fetchedAt: number;
  loading: boolean;
  /** True from the moment an input changes until a quote for the new inputs arrives. */
  dirty: boolean;
  problem: QuoteProblem | null;
  init(search: string): void;
  setAmount(text: string): void;
  setFrom(id: string): void;
  setTo(id: string): void;
  flip(): void;
  setPay(pay: PayMethod): void;
  setRecipient(text: string): void;
  setRefundTo(text: string): void;
  setImpactConfirmed(value: boolean): void;
  setSlippage(bps: number): void;
  /** Chooses public routing for this swap, or goes back to private. Either way a new quote is asked for at once. */
  setWithoutPrivate(value: boolean): void;
  /** An order has been made of this swap: the choice that was for it is over. */
  orderMade(): void;
  /** The server would not make an order with private routing: the card says so and offers the choice, as it does for a quote. */
  privateRefused(): void;
  refreshNow(): void;
  /** Puts the card back as a first visit finds it, before any coin is chosen for it. Whatever was on its way to the old card is dropped. */
  reset(): void;
}

/** What the card holds before anything is typed or chosen, and before the coin list has given it its usual pair. */
const FRESH = {
  fromId: null,
  toId: null,
  amountText: "",
  pay: "wallet",
  recipient: "",
  refundTo: "",
  impactConfirmed: false,
  slippageBps: SLIPPAGE.default,
  withoutPrivate: false,
  quote: null,
  fetchedAt: 0,
  loading: false,
  dirty: false,
  problem: null,
} satisfies Partial<SwapState>;

let debounce: ReturnType<typeof setTimeout> | undefined;
let typing = false;
let controller: AbortController | null = null;
let started = false;

/** Ends what is on its way to the card: the wait after a keystroke, and a request in flight, whose answer is then not shown (see fetchQuote). */
function dropPending(): void {
  typing = false;
  if (debounce !== undefined) clearTimeout(debounce);
  controller?.abort();
  controller = null;
}

function coin(id: string | null): TokenView | null {
  return id === null ? null : (useTokens.getState().byId.get(id) ?? null);
}

/** How the server routes swaps, as it told the page. Null until it has. */
function privacyMode(): PrivacyMode {
  return useApp.getState().config?.privacyMode ?? null;
}

/**
 * The server says how it routes swaps when the page loads, and its answers about quotes say it
 * again (see modeTold). Where an answer differs, the setting was changed after the page loaded,
 * and the newer word stands: the page says what the server does now, and a choice it offers is
 * one the server will read. This only ever reads the server's word. The page still chooses nothing.
 */
export function heardRouting(mode: Confidentiality | null): void {
  const { config } = useApp.getState();
  if (mode !== null && config !== null && config.privacyMode !== mode) useApp.setState({ config: { ...config, privacyMode: mode } });
}

/** The choice about routing belongs to one pair of coins. When either coin is another one, it is over. */
function pairChanged(fromId: string | null, toId: string | null): void {
  const now = useSwap.getState();
  if (now.withoutPrivate && (now.fromId !== fromId || now.toId !== toId)) useSwap.setState({ withoutPrivate: false });
}

/** Wallet payment is offered only for coins on the reviewed allowlist. */
function defaultPay(from: TokenView | null): PayMethod {
  return from !== null && from.wallet ? "wallet" : "manual";
}

function buildBody(state: SwapState): QuoteBody | null {
  const from = coin(state.fromId);
  const to = coin(state.toId);
  if (from === null || to === null) return null;
  const parsed = parseAmount(state.amountText, from.decimals);
  if (!parsed.ok || parsed.raw === 0n) return null;
  // Routing is never named here. Only the person's own choice of public routing is sent, and only where it means something.
  const body: QuoteBody = { from: from.id, to: to.id, amount: parsed.raw.toString(), pay: state.pay, slippageBps: state.slippageBps, ...routingChoice(privacyMode(), state.withoutPrivate) };
  // Addresses are sent only once they are valid; until then the server previews with a stand-in.
  const recipient = checkAddress(to.chain, state.recipient);
  if (recipient.ok) body.recipient = recipient.address;
  const wallet = useWallet.getState();
  if (state.pay === "wallet" && wallet.address !== null && wallet.chain === from.chain) body.sender = wallet.address;
  const refund = checkAddress(from.chain, state.refundTo);
  if (refund.ok) body.refundTo = refund.address;
  return body;
}

async function fetchQuote(): Promise<void> {
  const state = useSwap.getState();
  const body = buildBody(state);
  controller?.abort();
  if (body === null) {
    controller = null;
    useSwap.setState({ quote: null, loading: false, dirty: false, problem: null });
    return;
  }
  const mine = new AbortController();
  controller = mine;
  useSwap.setState({ loading: true });
  // A reply that never comes must not leave the card waiting for ever: after a while it counts as no reply.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    mine.abort();
  }, QUOTE_TIMEOUT_MS);
  try {
    const quote = await api.quote(body, mine.signal);
    if (controller !== mine) return;
    heardRouting(modeTold(body, quote));
    useSwap.setState({ quote, fetchedAt: Date.now(), loading: false, dirty: false, problem: null });
  } catch (err) {
    if (controller !== mine) return;
    if (err instanceof DOMException && err.name === "AbortError" && !timedOut) return;
    const problem: QuoteProblem =
      err instanceof ApiError
        ? { code: err.code, message: err.message, detail: err.detail, ...(err.retryAfter !== null ? { waitMs: err.retryAfter * 1000 } : {}) }
        : timedOut
          ? { code: "network", message: "The quote is taking too long. Try again.", detail: {} }
          : { code: "network", message: "Can't reach the service. Check your connection.", detail: {} };
    if (problem.code === "private_unavailable") heardRouting(modeTold(body, "private_unavailable"));
    // The inputs are kept. The old numbers no longer describe them, so they go.
    // The time is recorded for failures too, so the next attempt waits its 15 seconds like any refresh.
    useSwap.setState({ quote: null, fetchedAt: Date.now(), loading: false, dirty: false, problem });
  } finally {
    clearTimeout(timer);
  }
}

/** Called after any change to what is being quoted. */
function inputChanged(keepOld: boolean): void {
  typing = true;
  if (debounce !== undefined) clearTimeout(debounce);
  controller?.abort();
  controller = null;
  const state = useSwap.getState();
  const willQuote = buildBody(state) !== null;
  useSwap.setState({ problem: null, impactConfirmed: false, loading: willQuote, dirty: willQuote, ...(keepOld && willQuote ? {} : { quote: null }) });
  debounce = setTimeout(() => {
    typing = false;
    void fetchQuote();
  }, QUOTE_DEBOUNCE_MS);
}

function due(): boolean {
  const state = useSwap.getState();
  return refreshDue({
    typing,
    loading: state.loading,
    hidden: document.hidden,
    // The coin picker takes the card's place as a sheet covers it: the numbers are not on show, and are not refreshed.
    sheetOpen: useSheet.getState().current !== null || usePicker.getState().side !== null,
    hasQuote: state.quote !== null,
    problem: state.problem,
    fetchedAt: state.fetchedAt,
    now: Date.now(),
    refreshMs: QUOTE_REFRESH_MS,
  });
}

function start(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    if (due()) void fetchQuote();
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && due()) void fetchQuote();
  });
  // A sheet closing is a moment to catch up. So is the coin picker giving the card back.
  useSheet.subscribe((sheet, previous) => {
    if (sheet.current === null && previous.current !== null && due()) void fetchQuote();
  });
  usePicker.subscribe((picker, previous) => {
    if (picker.side === null && previous.side !== null && due()) void fetchQuote();
  });
  // Connecting or switching a wallet changes who is paying.
  useWallet.subscribe((wallet, previous) => {
    if (wallet.address !== previous.address || wallet.chain !== previous.chain) inputChanged(true);
  });
}

export const useSwap = create<SwapState>((set, get) => ({
  ...FRESH,

  init(search) {
    start();
    const { tokens } = useTokens.getState();
    if (tokens.length === 0) return;
    const current = get();
    if (current.fromId !== null && coin(current.fromId) !== null && coin(current.toId) !== null) return;
    const prefill = parsePrefill(search, tokens);
    const from = prefill.from ?? findToken(tokens, DEFAULT_PAIR.from.chain, DEFAULT_PAIR.from.symbol) ?? tokens[0] ?? null;
    const usualTo = findToken(tokens, DEFAULT_PAIR.to.chain, DEFAULT_PAIR.to.symbol) ?? null;
    let to = prefill.to ?? usualTo;
    // The same coin on both sides is no swap: fall back to the usual coin to receive, or failing that any other.
    if (to === null || to.id === from?.id) to = usualTo !== null && usualTo.id !== from?.id ? usualTo : (tokens.find((token) => token.id !== from?.id) ?? null);
    set({ fromId: from?.id ?? null, toId: to?.id ?? null, amountText: prefill.amount ?? "", pay: defaultPay(from) });
    if (prefill.amount !== undefined) inputChanged(false);
  },

  setAmount(text) {
    set({ amountText: text });
    inputChanged(true);
  },

  setFrom(id) {
    const { fromId, toId } = get();
    // Choosing the coin already on the other side swaps the two.
    if (id === toId) set({ fromId: id, toId: fromId, refundTo: "", recipient: "" });
    else set({ fromId: id, refundTo: "" });
    set({ pay: defaultPay(coin(get().fromId)) });
    pairChanged(fromId, toId);
    inputChanged(false);
  },

  setTo(id) {
    const { fromId, toId } = get();
    if (id === fromId) {
      set({ toId: id, fromId: toId, refundTo: "", recipient: "" });
      set({ pay: defaultPay(coin(get().fromId)) });
    } else set({ toId: id, recipient: "" });
    pairChanged(fromId, toId);
    inputChanged(false);
  },

  flip() {
    const { fromId, toId, quote } = get();
    const to = coin(toId);
    // The two coins change places and what was being received becomes what is paid.
    const amountText = quote !== null && to !== null ? formatExact(BigInt(quote.amountOut), to.decimals) : get().amountText;
    set({ fromId: toId, toId: fromId, amountText, recipient: "", refundTo: "" });
    set({ pay: defaultPay(coin(get().fromId)) });
    pairChanged(fromId, toId);
    inputChanged(false);
  },

  setPay(pay) {
    set({ pay });
    inputChanged(true);
  },

  setRecipient(text) {
    const to = coin(get().toId);
    const wasValid = to !== null && checkAddress(to.chain, get().recipient).ok;
    set({ recipient: text });
    // A new quote is needed only when the address the server will use has changed.
    if (to !== null && (checkAddress(to.chain, text).ok || wasValid)) inputChanged(true);
  },

  setRefundTo(text) {
    const from = coin(get().fromId);
    const wasValid = from !== null && checkAddress(from.chain, get().refundTo).ok;
    set({ refundTo: text });
    if (from !== null && (checkAddress(from.chain, text).ok || wasValid)) inputChanged(true);
  },

  setImpactConfirmed(value) {
    set({ impactConfirmed: value });
  },

  setSlippage(bps) {
    // Whole basis points within the bounds the server holds every request to; anything else is ignored.
    if (!Number.isInteger(bps) || bps < SLIPPAGE.min || bps > SLIPPAGE.max || bps === get().slippageBps) return;
    set({ slippageBps: bps });
    inputChanged(false);
  },

  setWithoutPrivate(value) {
    // The choice means something only where the server routes privately; elsewhere there is nothing to choose.
    if (value === get().withoutPrivate || (value && privacyMode() !== "basic")) return;
    set({ withoutPrivate: value });
    // The numbers on screen were for the other route: they go, and new ones are asked for without the usual pause.
    inputChanged(false);
    get().refreshNow();
  },

  orderMade() {
    get().setWithoutPrivate(false);
  },

  privateRefused() {
    typing = false;
    if (debounce !== undefined) clearTimeout(debounce);
    controller?.abort();
    controller = null;
    heardRouting(modeTold({}, "private_unavailable"));
    // As when a quote is answered so: the numbers go, the inputs stay, and nothing is asked again by itself.
    set({ quote: null, fetchedAt: Date.now(), loading: false, dirty: false, problem: { code: "private_unavailable", message: PRIVATE_UNAVAILABLE, detail: {} } });
  },

  refreshNow() {
    typing = false;
    if (debounce !== undefined) clearTimeout(debounce);
    void fetchQuote();
  },

  reset() {
    dropPending();
    set(FRESH);
  },
}));

/** Clears the card, and closes the two sheets that are the card's own. The menu is the site's, and is left as it is. */
function clearCard(): void {
  useSwap.getState().reset();
  const sheet = useSheet.getState();
  if (sheet.current === "review" || sheet.current === "slippage") sheet.close();
}

/**
 * The swap page always starts fresh. Called as the swap page comes onto the screen, however the
 * person came to it: a first visit, a reload, a link or the logo from another page, "Swap again"
 * on an order, the browser's Back or Forward. The card is cleared, and then given its usual pair,
 * or what the address says (a link's pair and amount: once, on arrival). Returns what to call as
 * the page is left: the card is cleared then too, so nothing typed outlives the page it was typed on.
 */
export function visitSwap(): () => void {
  clearCard();
  useSwap.getState().init(window.location.search);
  return clearCard;
}

/** Whether the quote on screen is too old to review without refreshing. */
export function quoteAge(state: Pick<SwapState, "quote" | "fetchedAt" | "loading" | "dirty">, now: number): "none" | "loading" | "ready" | "expired" {
  // Numbers left on screen from before an input changed are not a quote for the new inputs.
  if (state.dirty) return "loading";
  if (state.quote === null) return state.loading ? "loading" : "none";
  // An expired quote that is already being replaced is "loading": nothing may be pressed in the meantime.
  if (now - state.fetchedAt > QUOTE_EXPIRES_MS) return state.loading ? "loading" : "expired";
  return "ready";
}
