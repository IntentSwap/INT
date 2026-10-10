// The order page. It works from its address alone: after a reload, in another browser, on
// another device. Everything on it comes from the order as the server holds it.
//
// An order made in Ghost mode says so near the top, with a Copy link button: its link is the only
// way back to it, and its record is deleted from the server the moment it finishes. Once that has
// happened the server answers "deleted". A page that was showing the order keeps what it last
// showed, and says that this is all that is left; a fresh load of the link gets one plain notice
// and nothing of the order.

import { Check, ChevronDown, Circle, CircleDot, ExternalLink, Ghost, Minus, TriangleAlert } from "lucide-react";
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
import { clockSpan, clockTime, ending, ENDED_AS, LOOK_FOR, endingSaid, ghostLookAgain, payWindow, pollDelay, sendBy, tabTitle, orderTitle, timeline, type SaidEnding, type Step } from "../lib/order-logic.ts";
import { isPrivateMode } from "../lib/site-logic.ts";
import { aboutMinutes, appFeeWords, routingNote, type PrivacyMode } from "../lib/swap-logic.ts";
import { navigate } from "../router.ts";
import { serverNow, useApp } from "../stores/app.ts";
import { ghostOn, useGhost } from "../stores/ghost.ts";
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

/** What stands where the deposit details were, once nothing more should be sent. */
function DepositsClosed() {
  return (
    <div className="notice notice-warning" role="note">
      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
      <span>Deposits for this order are closed. Do not send now: a payment sent after the deadline may be lost.</span>
    </div>
  );
}

/** What to send, where, and by when. Shown only while the order still accepts a deposit. */
export function DepositDetails({ order, now, ticked = false }: { order: OrderView; now: number; ticked?: boolean }) {
  const [sure, setSure] = useState(ticked);
  const network = chainName(order.from.chain);
  const amount = displayExact(BigInt(order.amountIn), order.from.decimals);
  const pay = payWindow(order, now);

  if (!pay.open || order.depositAddress === null) return <DepositsClosed />;

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
 * What an order made in Ghost mode says of itself, right under its title, in the plain manner of
 * the page's own notes and in no warning colour.
 *
 * While its record is on the server: that this page's link is the only way back, with the button
 * that copies it, and that the record is deleted the moment the order finishes.
 *
 * `gone`: the server has said the record was deleted while this page was showing the order. The
 * page is then all that is left of it, and says so; there is no link worth copying any more.
 * `ended` is whether the page had seen how the order ended before that. Where it had not, it says
 * that too, and where to look.
 */
function GhostNote({ link, gone, ended, how }: { link: string; gone: boolean; ended: boolean; how: SaidEnding | null }) {
  const mark = <Ghost className="order-ghost-mark" size={20} strokeWidth={1.5} aria-hidden="true" />;
  /** The note as it reads while the record is there. `unseen`: drawn without being shown, only to keep the room it took. */
  const kept = (unseen: boolean) => (
    <div className="order-ghost-state" data-unseen={unseen || undefined} aria-hidden={unseen || undefined} inert={unseen}>
      {mark}
      <div className="order-ghost-text">
        <p className="order-ghost-lead">This is the only way back to this order. It is not saved anywhere.</p>
        <p className="order-ghost-sub muted">Its record is deleted from this site's server the moment it finishes.</p>
      </div>
      <CopyButton value={link} label="Copy link" what="to this order" />
    </div>
  );
  return (
    <div className="order-ghost" role="note">
      {gone ? (
        <div className="order-ghost-state">
          {mark}
          <div className="order-ghost-text">
            <p className="order-ghost-lead">This order has finished and its record has been deleted from the server.</p>
            <p className="order-ghost-sub muted">This page is all that is left of it; it will not load again.</p>
            {/* Where the page had not seen the order end, it says how it ended if the server still says so, and otherwise where to look. */}
            {ended ? null : <p className="order-ghost-sub muted">{how !== null ? LOOK_FOR[how] : "How it ended was not seen here. If you sent the deposit, look for the delivery at your receiving address, or for a refund at your refund address: both are in the order details below."}</p>}
          </div>
        </div>
      ) : (
        kept(false)
      )}
      {/* Where the page had seen the order end, the note's words change where they stand and the
          room they had is kept: nothing under the note moves while the ending is being read. */}
      {gone && ended ? kept(true) : null}
    </div>
  );
}

/**
 * An order as it stands: how it ended (if it has), the four steps, what to send while a deposit
 * is awaited, and its details. Everything shown comes from the order the server holds.
 * `privacyMode` is how the server routes swaps now: with it "basic", a public order's details say
 * that it was public. An order made privately says so whatever the setting is now.
 *
 * An order made in Ghost mode carries its own note under its title, whatever mode this tab is in:
 * the link may be opened later in an ordinary tab, and the order is a Ghost order all the same.
 * `gone` is for such an order once the server has said its record was deleted: the page keeps what
 * it last showed and takes away everything that would ask for something more (the deposit details,
 * the steps of an order that was still running, the hash field, the buttons that copy the link).
 */
export function OrderContent({ order, now, reconnecting, contact, onOrder, privacyMode = null, gone = false, how = null, children }: { order: OrderView; now: number; reconnecting: boolean; contact: string | null; onOrder(order: OrderView): void; privacyMode?: PrivacyMode; gone?: boolean; how?: SaidEnding | null; children?: React.ReactNode }) {
  const steps = timeline(order, now);
  const end = ending(order, contact !== null, !gone);
  const awaitingDeposit = order.status === "waiting" || (order.status === "deposit_seen" && !order.depositProven);
  const running = end === null;
  // An order whose record is gone is a Ghost order, whether or not its last answer said so.
  const ghost = order.ghost === true || gone;
  // In Ghost mode no wallet is loaded: every order is paid by sending to its deposit address.
  const ghostTab = useGhost((state) => state.on);
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
        {/* A Ghost order's link is copied from its own note, just below, where the reason is said. */}
        {ghost ? null : (
          <span className="order-copy">
            <CopyButton value={link} label="Copy link" what="to this order" />
          </span>
        )}
      </header>

      {ghost ? <GhostNote link={link} gone={gone} ended={end !== null} how={how} /> : null}

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
          ) : ghost ? null : (
            <CopyButton value={link} label="Copy link" what="to this order" />
          )}
        </div>
      ) : null}

      {/* While the order waits to be paid, paying is the next thing to do: it comes before the list of steps. */}
      {gone ? (
        // The record is gone, and the deposit address with it: nothing more may be sent there.
        awaitingDeposit ? (
          <DepositsClosed />
        ) : null
      ) : awaitingDeposit && order.pay === "wallet" && isWalletChain(order.from.chain) && !ghostTab ? (
        <WalletPay order={order} now={now} onOrder={onOrder}>
          <DepositDetails order={order} now={now} />
        </WalletPay>
      ) : awaitingDeposit ? (
        <DepositDetails order={order} now={now} />
      ) : null}

      {/* The steps of an order that was still running when its record went are not kept: how it went on from there was never seen. */}
      {gone && running ? null : (
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
      )}

      {order.depositTxUrl !== null && order.depositTxHash !== null ? <TxLinks label="Your deposit" txs={[{ hash: order.depositTxHash, url: order.depositTxUrl }]} /> : null}
      {order.details !== null && order.depositTxUrl === null ? <TxLinks label="Deposit" txs={order.details.originTxs} /> : null}
      {order.details !== null ? <TxLinks label="Delivery" txs={order.details.destinationTxs} /> : null}

      {order.status === "waiting" && !gone ? <HashField order={order} onOrder={onOrder} /> : null}

      <Summary order={order} privacyMode={privacyMode} />

      <p className="order-foot muted">
        {/* A Ghost order has said what its link is worth at the top of the page, and says it once. */}
        Order <span className="mono">{order.id}</span>.{ghost ? null : <> Keep this page's link: it is the only way back to this order.</>}
      </p>

      {children}
    </section>
  );
}

/**
 * What a fresh load of a finished Ghost order's link gets: one calm notice in the page's own frame,
 * and one way on. It is given nothing of the order and so can show nothing of it: no status, no
 * amount, no address. The server holds nothing more to say.
 */
export function OrderDeleted({ ended = null }: { ended?: SaidEnding | null }) {
  return (
    <Notice title="This order finished." action={<SecondaryButton onClick={() => navigate("/")}>Go to the swap page</SecondaryButton>}>
      {/* How it ended is the one thing the server still says of it, where it says anything. */}
      <p>
        {ended !== null ? <>{ENDED_AS[ended]} </> : null}It was made in Ghost mode, so its record was deleted when it finished. Nothing more is kept of it here.
      </p>
    </Notice>
  );
}

export default function OrderPage({ id }: { id: string }) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [missing, setMissing] = useState(false);
  // The server has said that the order's record was deleted: an order made in Ghost mode, once it has finished.
  const [deleted, setDeleted] = useState(false);
  // How it ended, where the server said so with that answer: one word, and all it still knows of the order.
  const [endedAs, setEndedAs] = useState<SaidEnding | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [now, setNow] = useState(() => serverNow());
  const practice = useApp((state) => state.config?.practice ?? false);
  const contact = useApp((state) => state.config?.supportContact ?? null);
  const privacyMode = useApp((state) => state.config?.privacyMode ?? null);
  const failures = useRef(0);

  // Ask the server, then again after a pause that depends on what it said. Nothing is asked while
  // the tab is hidden, and nothing more once the order has ended. (An order made in Ghost mode is
  // looked at a few times more after it has ended, until the server says its record is deleted.)
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    // What the order was when this page last looked.
    let seen: OrderView["status"] | null = null;
    // How many times an ended Ghost order has been looked at again.
    let looksAfterEnd = 0;
    setOrder(null);
    setMissing(false);
    setDeleted(false);
    setEndedAs(null);
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
        // (Not in Ghost mode: there is no wallet there, and no balance is read.)
        if (fresh.status === "delivered" && seen !== null && seen !== "delivered" && !ghostOn()) void useWallet.getState().loadBalances([fresh.from, fresh.to], 0);
        seen = fresh.status;
        useApp.setState({ clockOffset: Date.parse(fresh.serverNow) - Date.now() });
        next = pollDelay(fresh.status, 0);
        if (next === null && fresh.ghost === true) next = ghostLookAgain(looksAfterEnd++);
      } catch (err) {
        if (stopped || (err instanceof DOMException && err.name === "AbortError")) return;
        if (err instanceof ApiError && err.code === "order_deleted") {
          // An order made in Ghost mode has finished and its record is gone. There is nothing more to ask.
          setReconnecting(false);
          setEndedAs(endingSaid(err.detail));
          setDeleted(true);
          return;
        }
        if (err instanceof ApiError && err.code === "not_found") {
          // The server no longer has it, so this browser's own list lets go of it too.
          // (Not in Ghost mode, where nothing on this page writes to the browser: the list is left as it is.)
          if (!ghostOn()) useOrders.getState().forget(id);
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

  // The page's clock. It stops with the order: once the record is gone, what is on screen is what was last seen.
  useEffect(() => {
    if (deleted) return;
    const timer = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(timer);
  }, [deleted]);

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

  // The record was already gone when this page first asked: the notice, alone.
  if (deleted && order === null) return <OrderDeleted ended={endedAs} />;

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
    <OrderContent order={order} now={now} reconnecting={reconnecting} contact={contact} onOrder={setOrder} privacyMode={privacyMode} gone={deleted} how={endedAs}>
      {practice && running && !deleted ? (
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
