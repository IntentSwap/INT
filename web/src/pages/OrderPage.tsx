// The order page. It works from its address alone: after a reload, in another browser, on
// another device. Everything on it comes from the order as the server holds it.

import { Check, ChevronDown, Circle, CircleDot, ExternalLink, Minus, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isValidTxHash } from "../../../shared/addresses.ts";
import { displayBps, displayExact } from "../../../shared/amounts.ts";
import type { OrderView, TxRef } from "../../../shared/api.ts";
import { chainName, isWalletChain } from "../../../shared/chains.ts";
import { POSITIONING } from "../../../shared/positioning.ts";
import { REWARDS } from "../../../shared/rewards.ts";
import { api, ApiError } from "../api.ts";
import { Address } from "../components/Address.tsx";
import { PrimaryButton, SecondaryButton } from "../components/Button.tsx";
import { CoinIcon } from "../components/CoinIcon.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { PracticeLine } from "../components/PracticeLine.tsx";
import { Notice } from "../components/Shell.tsx";
import { QrCode } from "../components/QrCode.tsx";
import { WalletPay } from "../components/WalletPay.tsx";
import { clockSpan, clockTime, ending, payWindow, pollDelay, sendBy, tabTitle, orderTitle, timeline, type Step } from "../lib/order-logic.ts";
import { isPrivateMode } from "../lib/site-logic.ts";
import { aboutMinutes, appFeeWords, routingNote, type PrivacyMode } from "../lib/swap-logic.ts";
import { navigate } from "../router.ts";
import { serverNow, useApp } from "../stores/app.ts";
import { useOrders } from "../stores/orders.ts";
import { useWallet } from "../stores/wallet.ts";
import "../styles/order.css";

const STEP_WORD = { done: "Done", current: "Now", stopped: "Stopped", pending: "Next" } as const;

function StepMark({ state }: { state: Step["state"] }) {
  return (
    <span className="step-mark" data-state={state}>
      {state === "done" ? (
        <Check size={16} strokeWidth={1.5} aria-hidden="true" />
      ) : state === "current" ? (
        <CircleDot size={16} strokeWidth={1.5} aria-hidden="true" />
      ) : state === "stopped" ? (
        <Minus size={16} strokeWidth={1.5} aria-hidden="true" />
      ) : (
        <Circle size={16} strokeWidth={1.5} aria-hidden="true" />
      )}
      <span className="sr-only">{STEP_WORD[state]}: </span>
    </span>
  );
}

function TxLinks({ label, txs }: { label: string; txs: TxRef[] }) {
  if (txs.length === 0) return null;
  return (
    <p className="order-tx">
      <span className="muted">{label}</span>
      {txs.map((tx) =>
        tx.url !== null ? (
          <a key={tx.hash} href={tx.url} target="_blank" rel="noopener noreferrer" className="order-tx-link">
            <span className="mono">{`${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}`}</span>
            <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
            <span className="sr-only">(opens the block explorer)</span>
          </a>
        ) : (
          <span key={tx.hash} className="mono order-tx-plain">{`${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}`}</span>
        ),
      )}
    </p>
  );
}

/** What to send, where, and by when. Shown only while the order still accepts a deposit. */
export function DepositDetails({ order, now, ticked = false }: { order: OrderView; now: number; ticked?: boolean }) {
  const [sure, setSure] = useState(ticked);
  const network = chainName(order.from.chain);
  const amount = displayExact(BigInt(order.amountIn), order.from.decimals);
  const pay = payWindow(order, now);

  if (!pay.open || order.depositAddress === null) {
    return (
      <div className="notice notice-warning" role="note">
        <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
        <span>Deposits for this order are closed. Do not send now: a payment sent after the deadline may be lost.</span>
      </div>
    );
  }

  return (
    <section className="deposit" aria-labelledby="deposit-title">
      <div className="deposit-head">
        <h2 id="deposit-title" className="order-subtitle">
          Send your deposit
        </h2>
        <p className="deposit-clock">
          <span className="mono">{clockSpan(pay.toSend)}</span> <span className="muted">left to send, until {clockTime(sendBy(order))}</span>
        </p>
      </div>

      <p className="notice notice-warning" role="note">
        <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
        <span>
          Send only {order.from.symbol}, only on {network}, and exactly this amount{order.depositMemo !== null ? ", with the memo" : ""}. Anything else may be lost.
        </span>
      </p>

      <dl className="deposit-rows">
        <div className="deposit-row">
          <dt className="muted">Amount</dt>
          <dd>
            <span className="mono deposit-value">
              {amount} {order.from.symbol}
            </span>
            <CopyButton value={amount.replace(/,/g, "")} what="the amount" />
          </dd>
        </div>
        <div className="deposit-row">
          <dt className="muted">Network</dt>
          <dd>
            <span className="deposit-value">{network}</span>
          </dd>
        </div>
        {order.depositMemo !== null ? (
          <div className="deposit-row">
            <dt className="muted">Memo (required)</dt>
            <dd>
              <span className="mono deposit-value">{order.depositMemo}</span>
              <CopyButton value={order.depositMemo} what="the memo" />
            </dd>
          </div>
        ) : null}
      </dl>

      <label className="check">
        <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
        <span>I'm sending on {network}</span>
      </label>

      {sure ? (
        <div className="deposit-address">
          <p className="deposit-address-label">
            Deposit address<span className="muted"> · {network}</span>
          </p>
          <PracticeLine />
          <QrCode value={order.depositAddress} label={`QR code of the deposit address on ${network}`} />
          <p className="review-address-value">
            <Address value={order.depositAddress} />
          </p>
          <CopyButton value={order.depositAddress} what="the deposit address" />
          <p className="muted">
            The code holds the address only. Enter the amount{order.depositMemo !== null ? " and the memo" : ""} in your wallet yourself, and check the address there against the one above.
          </p>
        </div>
      ) : (
        <p className="deposit-locked muted">Tick the box to see the deposit address.</p>
      )}
    </section>
  );
}

/** An optional shortcut: telling us the transaction's hash lets the order be followed sooner. */
function HashField({ order, onOrder }: { order: OrderView; onOrder(order: OrderView): void }) {
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const text = hash.trim();
  const looksRight = isValidTxHash(order.from.chain, text);

  const send = async () => {
    setBusy(true);
    setMessage(null);
    try {
      onOrder(await api.submitDeposit(order.id, text));
      setHash("");
      setMessage("Noted. The order is being followed.");
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Couldn't send that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="order-fold">
      <summary>
        Already sent? Add the transaction hash
        <ChevronDown className="fold-chevron" size={16} strokeWidth={1.5} aria-hidden="true" />
      </summary>
      <div className="hash-field">
        <p className="muted">This is optional. Your deposit is found without it; the hash only lets this page follow it sooner.</p>
        <label className="sr-only" htmlFor="tx-hash">
          Transaction hash
        </label>
        <input id="tx-hash" className="hash-input mono" value={hash} onChange={(event) => setHash(event.target.value.replace(/\s+/g, "").slice(0, 130))} placeholder="Transaction hash" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
        <SecondaryButton onClick={() => void send()} disabled={busy || !looksRight} busy={busy}>
          {busy ? "Sending…" : text !== "" && !looksRight ? `Not a ${chainName(order.from.chain)} transaction hash` : "Add hash"}
        </SecondaryButton>
        <p className="hash-message" role="status">
          {message ?? " "}
        </p>
      </div>
    </details>
  );
}

function Summary({ order, privacyMode }: { order: OrderView; privacyMode: PrivacyMode }) {
  const from = order.from;
  const to = order.to;
  // How the order was routed, as it was made. A private order always says so; a public one only where the server routes privately.
  const routing = routingNote(privacyMode, order);
  const noFee = appFeeWords(order);
  return (
    <details className="order-fold">
      <summary>
        Order details
        <ChevronDown className="fold-chevron" size={16} strokeWidth={1.5} aria-hidden="true" />
      </summary>
      <dl className="review-rows">
        <div className="review-row">
          <dt className="muted">You send</dt>
          <dd>
            <span className="mono">
              {displayExact(BigInt(order.amountIn), from.decimals)} {from.symbol}
            </span>
            <span className="review-sub muted">on {chainName(from.chain)}</span>
          </dd>
        </div>
        <div className="review-row">
          <dt className="muted">You receive, about</dt>
          <dd>
            <span className="mono">
              {displayExact(BigInt(order.amountOut), to.decimals)} {to.symbol}
            </span>
            <span className="review-sub muted">on {chainName(to.chain)}</span>
          </dd>
        </div>
        {routing !== null ? (
          <div className="review-row" data-row="routing">
            <dt className="muted">Routing</dt>
            <dd>{routing.text}</dd>
          </div>
        ) : null}
        <div className="review-row">
          <dt className="muted">Minimum received</dt>
          <dd>
            <span className="mono">
              {displayExact(BigInt(order.minAmountOut), to.decimals)} {to.symbol}
            </span>
            <span className="review-sub muted">
              <span className="mono">{displayBps(order.slippageBps)}</span> slippage
            </span>
          </dd>
        </div>
        <div className="review-row">
          <dt className="muted">IntentSwap fee</dt>
          <dd>
            {noFee !== null ? (
              <span className="muted">{noFee}</span>
            ) : (
              <>
                <span className="mono">
                  {displayExact(BigInt(order.fees.appAmount), from.decimals)} {from.symbol}
                </span>
                <span className="review-sub muted mono">{displayBps(order.fees.appBps)}</span>
              </>
            )}
          </dd>
        </div>
        <div className="review-row">
          <dt className="muted">Provider fee</dt>
          <dd>
            <span className="mono">
              {displayExact(BigInt(order.fees.providerAmount), from.decimals)} {from.symbol}
            </span>
            <span className="review-sub muted mono">{displayBps(order.fees.providerBps)}</span>
          </dd>
        </div>
      </dl>
      <div className="review-address">
        <p className="review-address-label">
          Receiving address<span className="muted"> · {chainName(to.chain)}</span>
        </p>
        <p className="review-address-value">
          <Address value={order.recipient} />
        </p>
      </div>
      <div className="review-address">
        <p className="review-address-label">
          Refund address<span className="muted"> · {chainName(from.chain)}</span>
        </p>
        <p className="review-address-value">
          <Address value={order.refundTo} />
        </p>
      </div>
      <div className="review-address">
        <p className="review-address-label">
          Points<span className="muted"> · {chainName(REWARDS.chain)}</span>
        </p>
        {/* Whether an order adds points turns on its rewards address alone, never on a fee. */}
        {order.rewardsAddress !== null ? (
          <>
            <p className="review-address-value">
              <Address value={order.rewardsAddress} />
            </p>
            <p className="review-address-note muted">This swap's points go to this address when it is delivered.</p>
          </>
        ) : (
          <p className="review-address-note muted">This swap adds no points: it was made without a rewards address.</p>
        )}
      </div>
    </details>
  );
}

/**
 * An order as it stands: how it ended (if it has), the four steps, what to send while a deposit
 * is awaited, and its details. Everything shown comes from the order the server holds.
 * `privacyMode` is how the server routes swaps now: with it "basic", a public order's details say
 * that it was public. An order made privately says so whatever the setting is now.
 */
export function OrderContent({ order, now, reconnecting, contact, onOrder, privacyMode = null, children }: { order: OrderView; now: number; reconnecting: boolean; contact: string | null; onOrder(order: OrderView): void; privacyMode?: PrivacyMode; children?: React.ReactNode }) {
  const steps = timeline(order, now);
  const end = ending(order, contact !== null);
  const awaitingDeposit = order.status === "waiting" || (order.status === "deposit_seen" && !order.depositProven);
  const running = end === null;
  const link = `${window.location.origin}/order/${order.id}`;
  const contactHref = contact === null ? null : contact.startsWith("https://") ? contact : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact) ? `mailto:${contact}` : null;
  const title = (
    <h1 id="order-title" className="order-title">
      {orderTitle(order)}
    </h1>
  );

  return (
    <section className="order" aria-labelledby="order-title">
      <header className="order-head">
        <div className="order-pair">
          <CoinIcon symbol={order.from.symbol} chain={order.from.chain} contract={order.from.contract} />
          <CoinIcon symbol={order.to.symbol} chain={order.to.chain} contract={order.to.contract} />
        </div>
        <div className="order-head-text">
          {/* An order made with private routing wears the small tag beside its title. Any other order's title stands alone, as ever. */}
          {routingNote(privacyMode, order)?.private === true ? (
            <div className="order-title-row">
              {title}
              <span className="chip routing-tag" data-tone="private">
                Private
              </span>
            </div>
          ) : (
            title
          )}
          <p className="muted">
            {chainName(order.from.chain)} to {chainName(order.to.chain)}
          </p>
        </div>
        <span className="order-copy">
          <CopyButton value={link} label="Copy link" what="to this order" />
        </span>
      </header>

      <p className="order-reconnecting" role="status">
        {reconnecting ? "Reconnecting… Showing what was last known." : " "}
      </p>

      {end !== null ? (
        <div className="order-ending" data-tone={end.tone}>
          {end.tone === "good" ? (
            <span className="ending-mark" aria-hidden="true">
              <Check size={20} strokeWidth={2} />
            </span>
          ) : null}
          <h2 className="order-ending-headline">{end.headline}</h2>
          <p className="order-ending-cause">{end.cause}</p>
          {end.action === "swap-again" ? (
            <PrimaryButton onClick={() => navigate("/")}>{order.status === "expired" ? "Start a new swap" : "Swap again"}</PrimaryButton>
          ) : end.action === "contact" && contactHref !== null ? (
            <a className="button-secondary" href={contactHref} rel="noopener noreferrer">
              Contact support
            </a>
          ) : (
            <CopyButton value={link} label="Copy link" what="to this order" />
          )}
        </div>
      ) : null}

      {/* While the order waits to be paid, paying is the next thing to do: it comes before the list of steps. */}
      {awaitingDeposit && order.pay === "wallet" && isWalletChain(order.from.chain) ? (
        <WalletPay order={order} now={now} onOrder={onOrder}>
          <DepositDetails order={order} now={now} />
        </WalletPay>
      ) : awaitingDeposit ? (
        <DepositDetails order={order} now={now} />
      ) : null}

      <ol className="steps">
        {steps.map((step) => (
          <li key={step.key} className="step" data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
            <StepMark state={step.state} />
            <div className="step-body">
              <p className="step-title">{step.title}</p>
              {step.text !== "" ? <p className="step-text muted">{step.text}</p> : null}
              {step.state === "current" && running ? (
                <p className="step-time muted">
                  <span className="mono">{clockSpan(now - Date.parse(order.statusSince))}</span> elapsed
                  {step.key === "swapping" ? <> · estimate {aboutMinutes(order.timeEstimate)}</> : null}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {order.depositTxUrl !== null && order.depositTxHash !== null ? <TxLinks label="Your deposit" txs={[{ hash: order.depositTxHash, url: order.depositTxUrl }]} /> : null}
      {order.details !== null && order.depositTxUrl === null ? <TxLinks label="Deposit" txs={order.details.originTxs} /> : null}
      {order.details !== null ? <TxLinks label="Delivery" txs={order.details.destinationTxs} /> : null}

      {order.status === "waiting" ? <HashField order={order} onOrder={onOrder} /> : null}

      <Summary order={order} privacyMode={privacyMode} />

      <p className="order-foot muted">
        Order <span className="mono">{order.id}</span>. Keep this page's link: it is the only way back to this order.
      </p>

      {children}
    </section>
  );
}

export default function OrderPage({ id }: { id: string }) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [missing, setMissing] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [now, setNow] = useState(() => serverNow());
  const practice = useApp((state) => state.config?.practice ?? false);
  const contact = useApp((state) => state.config?.supportContact ?? null);
  const privacyMode = useApp((state) => state.config?.privacyMode ?? null);
  const failures = useRef(0);

  // Ask the server, then again after a pause that depends on what it said. Nothing is asked while
  // the tab is hidden, and nothing more once the order has ended.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    // What the order was when this page last looked.
    let seen: OrderView["status"] | null = null;
    setOrder(null);
    setMissing(false);
    failures.current = 0;

    const look = async () => {
      if (stopped) return;
      if (document.hidden) {
        timer = setTimeout(() => void look(), 1000);
        return;
      }
      let next: number | null;
      try {
        const fresh = await api.order(id, controller.signal);
        if (stopped) return;
        failures.current = 0;
        setReconnecting(false);
        setOrder(fresh);
        // An order seen to be delivered has changed what a connected wallet holds of its two coins: both are read afresh.
        if (fresh.status === "delivered" && seen !== null && seen !== "delivered") void useWallet.getState().loadBalances([fresh.from, fresh.to], 0);
        seen = fresh.status;
        useApp.setState({ clockOffset: Date.parse(fresh.serverNow) - Date.now() });
        next = pollDelay(fresh.status, 0);
      } catch (err) {
        if (stopped || (err instanceof DOMException && err.name === "AbortError")) return;
        if (err instanceof ApiError && err.code === "not_found") {
          // The server no longer has it, so this browser's own list lets go of it too.
          useOrders.getState().forget(id);
          setMissing(true);
          return;
        }
        // The last known state stays on screen; the page says it is trying again.
        failures.current += 1;
        setReconnecting(true);
        next = pollDelay("waiting", failures.current);
      }
      if (next !== null) timer = setTimeout(() => void look(), next);
    };
    void look();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(timer);
  }, []);

  // The tab's title tells how the order ended, for anyone who left it open in the background.
  useEffect(() => {
    document.title = tabTitle(order);
    return () => {
      // Back to the site's own title, which says how it routes swaps.
      document.title = POSITIONING[isPrivateMode(useApp.getState().config) ? "private" : "public"].title;
    };
  }, [order]);

  if (missing) {
    return (
      <Notice title="Order not found." action={<SecondaryButton onClick={() => navigate("/")}>Go to the swap page</SecondaryButton>}>
        <p>This link doesn't match an order. An order that was never paid is removed a day after its deadline.</p>
      </Notice>
    );
  }

  if (order === null) {
    return (
      <section className="order" aria-busy="true">
        <h1 className="order-title">Order</h1>
        {reconnecting ? (
          <p className="order-reconnecting" role="status">
            Reconnecting…
          </p>
        ) : (
          <div className="order-skeleton" aria-hidden="true">
            <span className="skeleton skeleton-block" />
            <span className="skeleton skeleton-block" />
            <span className="skeleton skeleton-block" />
          </div>
        )}
      </section>
    );
  }

  const running = ending(order) === null;
  return (
    <OrderContent order={order} now={now} reconnecting={reconnecting} contact={contact} onOrder={setOrder} privacyMode={privacyMode}>
      {practice && running ? (
        <details className="order-practice">
          {/* The operator's tool for moving a practice order along. It says nothing of itself and stays folded until asked for. */}
          <summary>Test controls</summary>
          <div className="states-row" role="group" aria-label="Test controls">
            {(["deposit", "underpay", "refund", "fail"] as const).map((action) => (
              <button key={action} type="button" className="button-chip" onClick={() => void api.practice(order.id, action).catch(() => undefined)}>
                {action === "deposit" ? "Pay in full" : action === "underpay" ? "Pay too little" : action === "refund" ? "Refund" : "Fail"}
              </button>
            ))}
            {/* These two move the practice server's own clock forward, for every practice order at once. */}
            {(["late", "expire"] as const).map((action) => (
              <button key={action} type="button" className="button-chip" onClick={() => void api.practice(order.id, action).then(() => window.location.reload(), () => undefined)}>
                {action === "late" ? "Skip to deposits closed" : "Skip to expired"}
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </OrderContent>
  );
}
