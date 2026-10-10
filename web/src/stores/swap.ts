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
//
// In Ghost mode no wallet is connected, so a swap is always paid by sending to its deposit address:
// the card's way of paying is "manual" there, and cannot be set to anything else.
//
// "Add gas" is held here too: whether the person switched it on (`gasOn`), and the server's preview
// of the gas order that could be added (`gas`). The preview is asked for only where gas can apply
// (see gasCoinOnCard), and only once a valid receiving address is on the card: gas is for an
// address, so the switch comes as the answer to one being entered, and a visit that enters none
// asks the provider nothing. From then on it is asked for at the moments a quote is asked for again,
// and needs no amount. When the address is cleared or is no longer valid, the preview goes at once
// and gas is switched off. While gas is switched on the preview is refreshed with the quote;
// switched off, it is not refreshed on a timer. Anything but a good preview means "not offered":
// there is then no preview, and gas is switched off.

import { create } from "zustand";
import { checkAddress } from "../../../shared/addresses.ts";
import { formatExact, parseAmount } from "../../../shared/amounts.ts";
import { SLIPPAGE, type Confidentiality, type GasBody, type GasQuote, type PayMethod, type QuoteBody, type QuoteView, type TokenView } from "../../../shared/api.ts";
import { api, ApiError } from "../api.ts";
import { DEFAULT_PAIR, QUOTE_DEBOUNCE_MS, QUOTE_EXPIRES_MS, QUOTE_REFRESH_MS, QUOTE_TIMEOUT_MS } from "../config.ts";
import { gasCoinOnCard, gasOffered, type Age } from "../lib/gas-logic.ts";
import { ghostHolds } from "../lib/kept.ts";
import { modeTold, parsePrefill, PRIVATE_UNAVAILABLE, refreshDue, routingChoice, type PrivacyMode, type QuoteProblem } from "../lib/swap-logic.ts";
import { useApp } from "./app.ts";
import { useGhost } from "./ghost.ts";
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
  /**
   * True when the person switched "Add gas" on. Off until they do, and theirs for this swap only:
   * a change of either coin switches it off, and so does an order being made. Nothing remembers it.
   */
  gasOn: boolean;
  /**
   * The gas order that could be added beside this swap, as the server previews it. Null until a valid
   * receiving address is on the card, while it is first asked for, wherever the server does not offer
   * it, and wherever gas cannot apply: the card then shows no switch at all.
   */
  gas: GasQuote | null;
  gasFetchedAt: number;
  /** True while a gas preview is waited for. One that is on screen meanwhile is not confirmed (see gasAge). */
  gasLoading: boolean;
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
  /** Switches "Add gas" on or off. It can be switched on only while there is a preview: where there is none, there is no switch. */
  setGasOn(value: boolean): void;
  /** An order has been made of this swap: the choices that were for it are over. */
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
  gasOn: false,
  gas: null,
  gasFetchedAt: 0,
  gasLoading: false,
} satisfies Partial<SwapState>;

let debounce: ReturnType<typeof setTimeout> | undefined;
let typing = false;
let controller: AbortController | null = null;
let started = false;
// The gas preview has its own wait and its own request: neither holds up a quote, and a quote holds up neither.
let gasDebounce: ReturnType<typeof setTimeout> | undefined;
let gasController: AbortController | null = null;
/** What the gas preview on the card, or on its way to it, was asked with. Null when nothing was asked, or the asking failed. */
let gasAskedWith: string | null = null;

/** Ends what is on its way to the card of gas: the wait before asking, and a request in flight, whose answer is then not shown (see fetchGas). */
function dropGasPending(): void {
  if (gasDebounce !== undefined) clearTimeout(gasDebounce);
  gasDebounce = undefined;
  gasController?.abort();
  gasController = null;
  gasAskedWith = null;
}

/** True while a gas preview is about to be asked for, or is being asked for. */
function gasOnItsWay(): boolean {
  return gasDebounce !== undefined || gasController !== null;
}

/** Ends what is on its way to the card: the wait after a keystroke, and a request in flight, whose answer is then not shown (see fetchQuote). The same for the gas preview. */
function dropPending(): void {
  typing = false;
  if (debounce !== undefined) clearTimeout(debounce);
  controller?.abort();
  controller = null;
  dropGasPending();
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

/** The choice about routing belongs to one pair of coins. When either coin is another one, it is over. So is gas that was switched on. */
function pairChanged(fromId: string | null, toId: string | null): void {
  const now = useSwap.getState();
  const another = now.fromId !== fromId || now.toId !== toId;
  if (now.withoutPrivate && another) useSwap.setState({ withoutPrivate: false });
  gasInputChanged(another);
}

/** Wallet payment is offered only for coins on the reviewed allowlist, and never in Ghost mode, where there is no wallet. */
function defaultPay(from: TokenView | null): PayMethod {
  return !ghostHolds() && from !== null && from.wallet ? "wallet" : "manual";
}

/** The addresses a request about the card carries. Each is sent only once it is valid; until then the server previews with a stand-in. */
function knownAddresses(state: SwapState, from: TokenView, to: TokenView): Pick<QuoteBody, "recipient" | "sender" | "refundTo"> {
  const known: Pick<QuoteBody, "recipient" | "sender" | "refundTo"> = {};
  const recipient = checkAddress(to.chain, state.recipient);
  if (recipient.ok) known.recipient = recipient.address;
  const wallet = useWallet.getState();
  if (state.pay === "wallet" && wallet.address !== null && wallet.chain === from.chain) known.sender = wallet.address;
  const refund = checkAddress(from.chain, state.refundTo);
  if (refund.ok) known.refundTo = refund.address;
  return known;
}

function buildBody(state: SwapState): QuoteBody | null {
  const from = coin(state.fromId);
  const to = coin(state.toId);
  if (from === null || to === null) return null;
  const parsed = parseAmount(state.amountText, from.decimals);
  if (!parsed.ok || parsed.raw === 0n) return null;
  // Routing is never named here. Only the person's own choice of public routing is sent, and only where it means something.
  return { from: from.id, to: to.id, amount: parsed.raw.toString(), pay: state.pay, slippageBps: state.slippageBps, ...routingChoice(privacyMode(), state.withoutPrivate), ...knownAddresses(state, from, to) };
}

/**
 * What is asked of the server about gas for the card as it stands, with the two coins an answer is
 * held to. Null where gas cannot be added (see gasCoinOnCard), and until a valid receiving address
 * is on the card: nothing is asked then. So every preview is of gas for a real address, never for
 * the server's stand-in. It names the swap's coins, how it is paid and its addresses, and nothing
 * of the gas itself: no amount, no address of its own and no routing. Those are the server's.
 */
function buildGasBody(state: SwapState): { body: GasBody; from: TokenView; coin: TokenView } | null {
  const from = coin(state.fromId);
  const to = coin(state.toId);
  const own = gasCoinOnCard(privacyMode(), state.withoutPrivate, from, to, useTokens.getState().tokens);
  if (from === null || to === null || own === null) return null;
  const addresses = knownAddresses(state, from, to);
  // Gas is for a receiving address. Before there is one, the provider is asked nothing and the card has no switch.
  if (addresses.recipient === undefined) return null;
  return { body: { from: from.id, to: to.id, pay: state.pay, ...addresses }, from, coin: own };
}

/**
 * Asks whether gas can be added beside the swap on the card. Only a good preview is an offer: a
 * refusal, an error and a reply that never comes all mean "not offered", and then there is no
 * preview and gas that was switched on is switched off. A newer request cancels an older one, and
 * an answer that is no longer the newest is not shown. A preview already on the card stays there
 * while it is asked for again.
 */
async function fetchGas(): Promise<void> {
  if (gasDebounce !== undefined) clearTimeout(gasDebounce);
  gasDebounce = undefined;
  gasController?.abort();
  const asked = buildGasBody(useSwap.getState());
  if (asked === null) {
    gasController = null;
    gasAskedWith = null;
    useSwap.setState({ gasOn: false, gas: null, gasFetchedAt: 0, gasLoading: false });
    return;
  }
  const mine = new AbortController();
  gasController = mine;
  gasAskedWith = JSON.stringify(asked.body);
  useSwap.setState({ gasLoading: true });
  // As for a quote: a reply that never comes counts, after a while, as no reply.
  const timer = setTimeout(() => mine.abort(), QUOTE_TIMEOUT_MS);
  let gas: GasQuote | null = null;
  let failed = false;
  try {
    gas = gasOffered(await api.gas(asked.body, mine.signal), asked.from, asked.coin);
  } catch {
    failed = true;
  } finally {
    clearTimeout(timer);
  }
  if (gasController !== mine) return;
  gasController = null;
  // After a failure the same question may be put again at the next change; after an answer it is not.
  if (failed) gasAskedWith = null;
  if (gas === null) useSwap.setState({ gasOn: false, gas: null, gasFetchedAt: 0, gasLoading: false });
  else useSwap.setState({ gas, gasFetchedAt: Date.now(), gasLoading: false });
}

/**
 * Called after a change to anything a gas preview is asked with: either coin, the way of paying, a
 * valid address, the sender, how the swap is routed. Where the question comes to the same as the
 * one already answered, or on its way, nothing is asked. Where there is no longer anything to ask
 * (the receiving address was cleared or is no longer valid, or gas can no longer be added), the
 * preview goes at once and gas that was switched on is switched off. Another pair of coins is
 * another swap, with the same end: off, and the old preview gone at once. Otherwise (one valid
 * address typed over another, the way of paying, the sender) the preview on the card stays until
 * the new one arrives, as a quote's numbers do. The question waits as a quote does after a
 * keystroke, so a receiving address is asked about 400 ms after it becomes valid; it is put
 * `atOnce` only when the server's word on routing arrives, when nobody is typing.
 */
function gasInputChanged(anotherPair: boolean, atOnce = false): void {
  const asked = buildGasBody(useSwap.getState());
  const askedWith = asked === null ? null : JSON.stringify(asked.body);
  if (askedWith === gasAskedWith && (askedWith !== null || useSwap.getState().gas === null)) return;
  dropGasPending();
  if (asked === null || anotherPair) useSwap.setState({ gasOn: false, gas: null, gasFetchedAt: 0, gasLoading: asked !== null });
  else useSwap.setState({ gasLoading: true });
  if (asked === null) return;
  gasAskedWith = askedWith;
  if (atOnce) void fetchGas();
  else gasDebounce = setTimeout(() => void fetchGas(), QUOTE_DEBOUNCE_MS);
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
  // While gas is switched on, its preview is asked for again with every quote, so the two are reviewed
  // equally fresh. Switched off, it is left as it is. (A preview already on its way is not asked for twice.)
  if (state.gasOn && !gasOnItsWay()) void fetchGas();
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
    if (wallet.address !== previous.address || wallet.chain !== previous.chain) {
      inputChanged(true);
      gasInputChanged(false);
    }
  });
  // Gas goes only beside a privately routed swap. The server's word on how it routes may arrive after the coins, or change (see heardRouting).
  useApp.subscribe((app, previous) => {
    if ((app.config?.privacyMode ?? null) !== (previous.config?.privacyMode ?? null)) gasInputChanged(false, true);
  });
  // Ghost mode turning on changes how it is paid: a card that was to be paid from a wallet is now paid by hand.
  useGhost.subscribe((ghost, previous) => {
    if (ghost.on && !previous.on && useSwap.getState().pay !== "manual") useSwap.getState().setPay("manual");
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
    // Nothing is asked about gas here: the card has its coins and no receiving address yet (a link never carries one).
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
    if (pay === "wallet" && ghostHolds()) return;
    set({ pay });
    inputChanged(true);
    gasInputChanged(false);
  },

  setRecipient(text) {
    const to = coin(get().toId);
    const wasValid = to !== null && checkAddress(to.chain, get().recipient).ok;
    set({ recipient: text });
    // A new quote is needed only when the address the server will use has changed. The same goes for the gas preview.
    if (to !== null && (checkAddress(to.chain, text).ok || wasValid)) {
      inputChanged(true);
      gasInputChanged(false);
    }
  },

  setRefundTo(text) {
    const from = coin(get().fromId);
    const wasValid = from !== null && checkAddress(from.chain, get().refundTo).ok;
    set({ refundTo: text });
    if (from !== null && (checkAddress(from.chain, text).ok || wasValid)) {
      inputChanged(true);
      gasInputChanged(false);
    }
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
    // Gas goes only beside a privately routed swap: with public routing chosen it is not offered, and with private routing back it is asked about again.
    gasInputChanged(false);
    get().refreshNow();
  },

  setGasOn(value) {
    if (value === get().gasOn || (value && get().gas === null)) return;
    set({ gasOn: value });
    // Switched on, the preview is about to be reviewed: one that has stood on the card for a while is asked for again at once.
    if (value && Date.now() - get().gasFetchedAt >= QUOTE_REFRESH_MS && !gasOnItsWay()) void fetchGas();
  },

  orderMade() {
    // Gas was for the swap that has just been made. The next one starts without it.
    set({ gasOn: false });
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
    set(ghostHolds() ? { ...FRESH, pay: "manual" } : FRESH);
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

/**
 * The same for the gas preview, where gas is switched on: "none" where gas is no part of the swap.
 * A preview that is being asked for again is waited for, and one as old as an expired quote is not
 * reviewed without a refresh.
 */
export function gasAge(state: Pick<SwapState, "gasOn" | "gas" | "gasFetchedAt" | "gasLoading">, now: number): Age {
  if (!state.gasOn || state.gas === null) return "none";
  if (state.gasLoading) return "loading";
  return now - state.gasFetchedAt > QUOTE_EXPIRES_MS ? "expired" : "ready";
}
