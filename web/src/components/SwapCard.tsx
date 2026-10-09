import { ArrowDownUp, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { displayBps } from "../../../shared/amounts.ts";
import { chainInfo, chainName } from "../../../shared/chains.ts";
import { NATIVE_RESERVE } from "../config.ts";
import { REWARDS } from "../../../shared/rewards.ts";
import { asksForRefund, cardRouting, estimateUsd, maxSpendable, minimumNote, pointsByDefault, primaryAction, PRIVATE_UNAVAILABLE, quoteAnnouncement, refundFor, routedPrivately, routingNote, shouldAnnounce, walletAddressFor, type Announced } from "../lib/swap-logic.ts";
import { useKeyboardInset, useStuck } from "../lib/use-stuck.ts";
import { useApp } from "../stores/app.ts";
import { closePicker, openPicker, usePicker, watchPickerHistory, type PickerSide } from "../stores/picker.ts";
import { useSheet } from "../stores/sheet.ts";
import { quoteAge, useSwap } from "../stores/swap.ts";
import { useTokens } from "../stores/tokens.ts";
import { useWallet } from "../stores/wallet.ts";
import { AddressField, AddressFieldPlaceholder } from "./AddressField.tsx";
import { Amount } from "./Amount.tsx";
import { AmountInput, AmountOutput, UsdValue } from "./AmountField.tsx";
import { PrimaryButton, TextButton } from "./Button.tsx";
import { CoinButton } from "./CoinButton.tsx";
import { CoinPicker } from "./CoinPicker.tsx";
import { QuotePanel } from "./QuotePanel.tsx";

/** Re-renders once a second, so a quote can be seen to expire. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** How long the card's two views take to change places. The same as --motion-sheet in the token file. */
const SLIDE_MS = 250;

/**
 * The card has two views: the swap, and the coin picker, which takes the swap's place inside the
 * card. This moves the card between them. The view being left stays on the page while it slides
 * away, and the card's height goes smoothly from the one view's to the other's; then the height is
 * the card's own again. Where the system asks for less movement, the views simply change places.
 * Nothing here scrolls the page, and the card's top edge and width never change.
 */
function useCardViews(side: PickerSide | null) {
  const card = useRef<HTMLElement>(null);
  // The picker that is on the page: it stays for the length of its slide away.
  const [shown, setShown] = useState<PickerSide | null>(side);
  const [moving, setMoving] = useState(false);
  if (side !== null && shown !== side) setShown(side);
  const was = useRef(side);
  const timer = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (was.current === side) return;
    was.current = side;
    const element = card.current;
    const settle = () => {
      if (element !== null) element.style.height = "";
      setMoving(false);
      if (side === null) setShown(null);
    };
    window.clearTimeout(timer.current);
    if (element === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      settle();
      return;
    }
    const arriving = element.querySelector<HTMLElement>(side === null ? ":scope > .card-swap" : ":scope > .card-picker");
    const going = element.querySelector<HTMLElement>(side === null ? ":scope > .card-picker" : ":scope > .card-swap");
    // Where the height starts: where it is now if the card is already on the move, and otherwise the height it had with the view being left.
    const midway = element.style.height !== "" ? element.getBoundingClientRect().height : null;
    element.style.height = "";
    const to = element.getBoundingClientRect().height;
    const from = midway ?? to - (arriving?.offsetHeight ?? 0) + (going?.offsetHeight ?? 0);
    element.style.height = `${from}px`;
    // Read once, so that the browser takes the starting height before it is given the one to go to.
    void element.offsetHeight;
    element.style.height = `${to}px`;
    setMoving(true);
    timer.current = window.setTimeout(settle, SLIDE_MS + 50);
  }, [side]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { card, shown, moving };
}

/**
 * The swap card is the page: two small tools, the coins and the amount, the receiving address, the live quote in one line, and one button.
 * Where the server routes swaps privately, the row of tools also says so at its left end; where it does not, nothing here speaks of routing.
 * Choosing a coin happens inside the card: its contents give way to the coin picker and come back when a coin is chosen.
 */
export function SwapCard() {
  useKeyboardInset();
  const swap = useSwap();
  const tokens = useTokens();
  const wallet = useWallet();
  const paused = useApp((state) => state.config?.paused ?? false);
  // How the server routes swaps. The card only ever says what the server does; it never chooses a level.
  const privacyMode = useApp((state) => state.config?.privacyMode ?? null);
  const routing = cardRouting(privacyMode, swap.withoutPrivate);
  const openSheet = useSheet((state) => state.open);
  const sheetOpen = useSheet((state) => state.current !== null);
  // The coin picker, when it has the card: for the coin paid ("from") or the coin received ("to").
  const pickerSide = usePicker((state) => state.side);
  const views = useCardViews(pickerSide);
  useEffect(() => watchPickerHistory(), []);
  // When the picker closes, the keyboard goes back to the coin selector that opened it, without scrolling the page.
  const fromButton = useRef<HTMLButtonElement>(null);
  const toButton = useRef<HTMLButtonElement>(null);
  const lastSide = useRef<PickerSide | null>(null);
  useLayoutEffect(() => {
    if (pickerSide !== null) {
      lastSide.current = pickerSide;
      return;
    }
    const opener = lastSide.current === null ? null : (lastSide.current === "from" ? fromButton : toButton).current;
    lastSide.current = null;
    opener?.focus({ preventScroll: true });
  }, [pickerSide]);
  const now = useNow();
  // Each press of the flip button turns it half a turn further.
  const [turns, setTurns] = useState(0);

  const from = swap.fromId === null ? null : (tokens.byId.get(swap.fromId) ?? null);
  const to = swap.toId === null ? null : (tokens.byId.get(swap.toId) ?? null);
  const quote = swap.quote;
  const age = quoteAge(swap, now);
  const connected = wallet.status === "connected" && wallet.address !== null;
  const walletOnOrigin = connected && from !== null && wallet.chain === from.chain;
  const balance = walletOnOrigin && from !== null ? (wallet.balances.get(from.id) ?? null) : null;
  const impact = quote?.priceImpactBps ?? null;

  // The connected wallet's address is offered where it is known to be the person's: see walletAddressFor.
  const walletInfo = { address: connected ? wallet.address : null, chain: wallet.chain, family: wallet.chain === null ? null : chainInfo(wallet.chain).family, plain: wallet.plain };
  const walletForRecipient = to !== null ? walletAddressFor(to.chain, chainInfo(to.chain).family, walletInfo) : null;
  const walletForRefund = from !== null ? walletAddressFor(from.chain, chainInfo(from.chain).family, walletInfo) : null;
  // The refund address the order would be made with: typed, or the wallet's own where that is safe (see refundFor).
  const refundTo = refundFor(swap.pay, swap.refundTo, walletForRefund);

  const action = primaryAction({
    paused,
    coinsReady: tokens.status === "ready" || tokens.status === "stale",
    from,
    to,
    amountText: swap.amountText,
    pay: swap.pay,
    walletConnected: connected,
    balance,
    recipient: swap.recipient,
    refundTo,
    quote: age,
    problem: swap.problem,
    impactUnconfirmed: impact !== null && impact > 1000 && !swap.impactConfirmed,
  });

  // The line above the button: why a quote failed, what a minimum comes to, or a wallet problem.
  const message =
    swap.problem !== null && action.kind === "retry"
      ? swap.problem.message
      : action.kind === "without-private"
        ? PRIVATE_UNAVAILABLE
        : swap.problem !== null && swap.problem.code === "min_usd"
          ? minimumNote(swap.problem.detail, from)
          : wallet.error !== null && swap.pay === "wallet"
            ? wallet.error
            : null;

  const sentinel = useRef<HTMLDivElement>(null);
  const stuck = useStuck(sentinel);

  // Read out to screen readers: a quote for new inputs, and after that only a real change
  // (more than 0.5%), at most once in 30 seconds. The numbers refresh far more often than that.
  const announced = useRef<Announced | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (quote === null || from === null || to === null || swap.loading || swap.dirty) return;
    // The routing is part of what the quote is for: the same coins and amount by the other route are read out afresh.
    const privately = routedPrivately(quote);
    const next: Announced = { key: `${from.id}|${to.id}|${quote.amountIn}|${privately ? "private" : ""}`, amountOut: BigInt(quote.amountOut), at: Date.now() };
    if (!shouldAnnounce(announced.current, next)) return;
    announced.current = next;
    // The exact figure: the short form of a very small amount ("0.0₅12") is not something that can be read aloud.
    setAnnouncement(quoteAnnouncement(to, next.amountOut, privately));
  }, [quote, from, to, swap.loading, swap.dirty]);

  const act = () => {
    if (action.kind === "connect") void wallet.connect();
    else if (action.kind === "refresh" || action.kind === "retry") swap.refreshNow();
    // The person's own choice, for this swap: a public quote is asked for, and from there the flow is as ever.
    else if (action.kind === "without-private") swap.setWithoutPrivate(true);
    else if (action.kind === "review") openSheet("review");
  };

  const max = () => {
    if (from === null || balance === null) return;
    swap.setAmount(maxSpendable(balance, from, NATIVE_RESERVE[from.chain]));
  };

  const canPayByWallet = from !== null && from.wallet;

  // The balance of the coin being paid, once the wallet is on its network.
  const refreshBalance = wallet.refreshBalance;
  const fromId = from?.id ?? null;
  useEffect(() => {
    if (walletOnOrigin && from !== null) void refreshBalance(from);
  }, [walletOnOrigin, wallet.address, fromId, refreshBalance]);

  // What the wallet holds on the chains it can pay from is read as soon as it connects, so the coin
  // picker opens with its rows already in order and nothing moves under a finger.
  const loadBalances = wallet.loadBalances;
  const coinList = tokens.tokens;
  useEffect(() => {
    if (connected && coinList.length > 0) void loadBalances(coinList);
  }, [connected, wallet.address, coinList, loadBalances]);

  // When a wallet is connected and its address is known to be the person's on the receiving chain,
  // an empty receiving address is filled from it. Never over something already typed.
  const setRecipient = swap.setRecipient;
  useEffect(() => {
    if (walletForRecipient !== null && swap.recipient === "") setRecipient(walletForRecipient);
  }, [walletForRecipient]);

  return (
    <section ref={views.card} className="card" aria-labelledby="swap-title" data-view={pickerSide === null ? "swap" : "picker"} data-moving={views.moving || undefined}>
      <h1 id="swap-title" className="sr-only">
        Swap
      </h1>

      {/* The swap itself. While the picker has the card, nothing in here can be reached or is read out. */}
      <div className="card-view card-swap" inert={pickerSide !== null}>
        {/* Above the fields, to the right: the slippage limit and a fresh quote. To the left, only where the
            server routes swaps privately: the small tag, or the way back to private routing after choosing public. */}
        <div className="card-tools">
          {routing === "private" ? (
            <span className="chip routing-tag card-routing" data-tone="private">
              Private
            </span>
          ) : routing === "public-by-choice" ? (
            <button type="button" className="routing-switch card-routing" onClick={() => swap.setWithoutPrivate(false)}>
              Use private routing
            </button>
          ) : null}
          <button type="button" className="tool" onClick={() => openSheet("slippage")} aria-haspopup="dialog" aria-label={`${displayBps(swap.slippageBps)} slippage limit. Change`} title="Slippage limit">
            <SlidersHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button type="button" className="tool" onClick={swap.refreshNow} disabled={paused || (quote === null && swap.problem === null) || swap.loading || swap.dirty} aria-label="Refresh the quote" title="Refresh the quote">
            {/* key: each quote that arrives turns the arrows once */}
            <RefreshCw key={quote?.serverNow ?? "none"} className={quote !== null ? "tool-turn" : undefined} size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>

        <div className="field">
          <div className="field-head">
            <label className="field-label" htmlFor="amount-in">
              You pay
            </label>
            {from !== null && balance !== null ? (
              <span className="balance">
                <span>
                  Balance: <Amount raw={balance} decimals={from.decimals} /> {from.symbol}
                </span>
                <button type="button" className="balance-max" onClick={max}>
                  Max
                </button>
              </span>
            ) : null}
          </div>
          <div className="field-row">
            <CoinButton ref={fromButton} token={from} label="You pay" onClick={() => openPicker("from")} />
            <div className="field-value">
              <AmountInput id="amount-in" value={swap.amountText} decimals={from?.decimals ?? 18} autoFocus={!sheetOpen && pickerSide === null} onChange={swap.setAmount} />
              <UsdValue value={quote?.amountInUsd ?? estimateUsd(swap.amountText, from)} />
            </div>
          </div>
        </div>

        <div className="flip-row">
          <button
            type="button"
            className="flip"
            onClick={() => {
              swap.flip();
              setTurns((count) => count + 1);
            }}
            style={{ "--turn": `${turns * 180}deg` } as CSSProperties}
            aria-label="Swap the two coins"
            title="Swap the two coins"
            disabled={from === null || to === null}
          >
            <ArrowDownUp size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>

        <div className="field">
          <div className="field-head">
            <label className="field-label" htmlFor="amount-out">
              You receive
            </label>
          </div>
          <div className="field-row">
            <CoinButton ref={toButton} token={to} label="You receive" onClick={() => openPicker("to")} />
            <div className="field-value">
              <AmountOutput id="amount-out" raw={quote?.amountOut ?? null} decimals={to?.decimals ?? 6} symbol={to?.symbol ?? ""} stale={swap.loading || swap.dirty} loading={swap.loading || swap.dirty} />
              <UsdValue value={quote?.amountOutUsd ?? null} />
            </div>
          </div>
        </div>

        {to !== null ? (
          <AddressField
            label="Receiving address"
            hint={`Your ${to.symbol} is sent here. Use a wallet you control.`}
            chain={to.chain}
            value={swap.recipient}
            onChange={swap.setRecipient}
            walletAddress={walletForRecipient}
            memoNote={chainInfo(to.chain).memoChain === true}
          />
        ) : (
          <AddressFieldPlaceholder label="Receiving address" />
        )}

        {/* Paying by hand a refund address is always asked for. Paying from a wallet it is asked for where the
            wallet's own cannot be used, and shown whenever it holds something typed: see asksForRefund. */}
        {from !== null && asksForRefund(swap.pay, connected, walletForRefund, swap.refundTo) ? (
          <AddressField label="Refund address" hint={`If the swap fails, your ${from.symbol} comes back here.`} chain={from.chain} value={swap.refundTo} onChange={swap.setRefundTo} walletAddress={walletForRefund} />
        ) : null}

        <QuotePanel
          quote={quote}
          from={from}
          to={to}
          loading={swap.loading || swap.dirty}
          stale={quote !== null && (swap.loading || swap.dirty)}
          held={/[1-9]/.test(swap.amountText)}
          pointsShown={pointsByDefault(swap.pay, REWARDS.chain, { connected, ...walletInfo })}
          routing={routingNote(privacyMode, quote, swap.withoutPrivate)}
          impactConfirmed={swap.impactConfirmed}
          onConfirmImpact={swap.setImpactConfirmed}
        />

        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        <p className="card-message" role="status">
          {message ?? " "}
        </p>
        {/* Pinned to the bottom of the screen while the card is taller than it, so the next step is always in view. */}
        <div className="card-submit" data-stuck={stuck || undefined}>
          <PrimaryButton onClick={act} disabled={action.disabled} busy={action.busy}>
            {action.label}
          </PrimaryButton>
        </div>
        <div ref={sentinel} className="card-submit-end" aria-hidden="true" />
        <div className="card-actions">
          {from !== null ? (
            canPayByWallet ? (
              swap.pay === "wallet" ? (
                <TextButton onClick={() => swap.setPay("manual")}>Pay without connecting</TextButton>
              ) : (
                <TextButton onClick={() => swap.setPay("wallet")}>Pay from a connected wallet</TextButton>
              )
            ) : (
              <p className="card-footnote muted">
                {from.symbol} on {chainName(from.chain)} is paid by sending it to a deposit address.
              </p>
            )
          ) : null}
        </div>
      </div>
      {views.shown !== null ? <CoinPicker key={views.shown} side={views.shown} leaving={pickerSide === null} onClose={closePicker} /> : null}
    </section>
  );
}
