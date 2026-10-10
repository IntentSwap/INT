// The order page. It works from its address alone: after a reload, in another browser, on
// another device. Everything on it comes from the order as the server holds it.
//
// An order made in Ghost mode says so near the top, with a Copy link button: its link is the only
// way back to it, and its record is deleted from the server the moment it is delivered or refunded. Once that has
// happened the server answers "deleted". A page that was showing the order keeps what it last
// showed, and says that this is all that is left; a fresh load of the link gets one plain notice
// and nothing of the order.
//
// A swap that gas was added to is two orders on one page, reached by the swap's link. The swap's
// four steps are as ever; beneath them one compact line tells of the gas order, and while that
// order waits for its deposit it is paid here too, beside the swap and apart from it: its own
// address, its own amount, its own time left. The page goes on looking until both have ended.

import { Check, ChevronDown, Circle, CircleDot, ExternalLink, Ghost, Minus, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isValidTxHash } from "../../../shared/addresses.ts";
import { displayBps, displayExact } from "../../../shared/amounts.ts";
import type { GasLine, OrderView, TxRef } from "../../../shared/api.ts";
import { chainName, isWalletChain } from "../../../shared/chains.ts";
import { POSITIONING } from "../../../shared/positioning.ts";
import { REWARDS } from "../../../shared/rewards.ts";
import { api, ApiError } from "../api.ts";
import { Address } from "../components/Address.tsx";
import { Amount } from "../components/Amount.tsx";
import { PrimaryButton, SecondaryButton } from "../components/Button.tsx";
import { CoinIcon } from "../components/CoinIcon.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { PracticeLine } from "../components/PracticeLine.tsx";
import { Notice } from "../components/Shell.tsx";
import { QrCode } from "../components/QrCode.tsx";
import { WalletPay } from "../components/WalletPay.tsx";
import { awaitsDeposit, clockSpan, clockTime, ending, ENDED_AS, LOOK_FOR, endingSaid, firstSent, gasDue, gasKept, gasLookAgain, gasOrderFor, gasOrderOf, gasPlaced, gasPollDelay, gasWords, ghostLookAgain, lookAgain, pageTitle, payWindow, pollDelay, sendBy, tabTitle, timeline, TWO_TRANSFERS, type SaidEnding, type Step } from "../lib/order-logic.ts";
import { isPrivateMode } from "../lib/site-logic.ts";
import { aboutMinutes, appFeeWords, routingNote, type PrivacyMode } from "../lib/swap-logic.ts";
import { navigate } from "../router.ts";
import { serverNow, useApp } from "../stores/app.ts";
import { ghostOn, useGhost } from "../stores/ghost.ts";
import { useOrders } from "../stores/orders.ts";
import { sentFor } from "../stores/sent.ts";
import { useWallet } from "../stores/wallet.ts";
import "../styles/order.css";
import { OutboundLink } from "../components/OutboundLink.tsx";

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
          <OutboundLink key={tx.hash} href={tx.url} className="order-tx-link">
            <span className="mono">{`${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}`}</span>
            <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
            <span className="sr-only">(opens the block explorer)</span>
          </OutboundLink>
        ) : (
          <span key={tx.hash} className="mono order-tx-plain">{`${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}`}</span>
        ),
      )}
    </p>
  );
}

/** Which of a swap's two deposits a block is: the swap's own, or the gas order's. Left out for an order that stands alone. */
type Part = "swap" | "gas";

/** What stands where the deposit details were, once nothing more should be sent. */
function DepositsClosed({ part }: { part?: Part }) {
  return (
    <div className="notice notice-warning" role="note">
      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
      <span>Deposits for {part === "gas" ? "the gas order" : "this order"} are closed. Do not send now: a payment sent after the deadline may be lost.</span>
    </div>
  );
}

/**
 * What to send, where, and by when. Shown only while the order still accepts a deposit.
 * Where a swap has a gas order beside it there are two of these, one for each, and `part` names
 * which is which: each is that order's own address, amount and time left, and closes by itself.
 */
export function DepositDetails({ order, now, ticked = false, part }: { order: OrderView; now: number; ticked?: boolean; part?: Part }) {
  const [sure, setSure] = useState(ticked);
  const network = chainName(order.from.chain);
  const amount = displayExact(BigInt(order.amountIn), order.from.decimals);
  const pay = payWindow(order, now);
  // Two blocks can be on the page at once: each heading has a name of its own.
  const titleId = part === "gas" ? "gas-deposit-title" : "deposit-title";

  if (!pay.open || order.depositAddress === null) return <DepositsClosed part={part} />;

  return (
    <section className="deposit" aria-labelledby={titleId}>
      <div className="deposit-head">
        <h2 id={titleId} className="order-subtitle">
          {part === "gas" ? "Gas deposit" : part === "swap" ? "Swap deposit" : "Send your deposit"}
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

/**
 * An optional shortcut: telling us the transaction's hash lets the order be followed sooner.
 * A swap with gas has one of these for each of its two orders. Each sends the hash to the order it
 * was given, by that order's own ID, and hands back that order's own answer.
 */
function HashField({ order, onOrder, part }: { order: OrderView; onOrder(order: OrderView): void; part?: Part }) {
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const text = hash.trim();
  const looksRight = isValidTxHash(order.from.chain, text);
  const fieldId = part === "gas" ? "gas-tx-hash" : "tx-hash";

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
        {part === "gas" ? "Already sent the gas? Add its transaction hash" : part === "swap" ? "Already sent the swap? Add its transaction hash" : "Already sent? Add the transaction hash"}
        <ChevronDown className="fold-chevron" size={16} strokeWidth={1.5} aria-hidden="true" />
      </summary>
      <div className="hash-field">
        <p className="muted">This is optional. Your deposit is found without it; the hash only lets this page follow it sooner.</p>
        <label className="sr-only" htmlFor={fieldId}>
          {part === "gas" ? "Transaction hash of the gas deposit" : "Transaction hash"}
        </label>
        <input id={fieldId} className="hash-input mono" value={hash} onChange={(event) => setHash(event.target.value.replace(/\s+/g, "").slice(0, 130))} placeholder="Transaction hash" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
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

/**
 * An order's own numbers and addresses, folded away. `gas`: the order is a gas order, shown on its
 * own page or beneath the swap it was made with, and its details are named as the gas order's.
 * `beside`: it is shown on the swap's page, whose foot names the swap's ID only, so the gas order's
 * own ID is given here.
 */
function Summary({ order, privacyMode, gas = false, beside = false }: { order: OrderView; privacyMode: PrivacyMode; gas?: boolean; beside?: boolean }) {
  const from = order.from;
  const to = order.to;
  const which = gas ? "This gas order" : "This swap";
  // How the order was routed, as it was made. A private order always says so; a public one only where the server routes privately.
  const routing = routingNote(privacyMode, order);
  const noFee = appFeeWords(order);
  return (
    <details className="order-fold">
      <summary>
        {gas ? "Gas order details" : "Order details"}
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
            <p className="review-address-note muted">{which}'s points go to this address when it is delivered.</p>
          </>
        ) : (
          <p className="review-address-note muted">{which} adds no points: it was made without a rewards address.</p>
        )}
      </div>
      {beside ? (
        <p className="order-foot muted">
          Gas order <span className="mono">{order.id}</span>.
        </p>
      ) : null}
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
 *
 * `gasOpen`: the gas order made with it is still running, and is shown beneath. The link then still
 * leads somewhere, to that gas order, until it has finished too: the note says so, and does not
 * say that the page will not load again.
 */
function GhostNote({ link, gone, ended, how, gasOpen }: { link: string; gone: boolean; ended: boolean; how: SaidEnding | null; gasOpen: boolean }) {
  const mark = <Ghost className="order-ghost-mark" size={20} strokeWidth={1.5} aria-hidden="true" />;
  /** The note as it reads while the record is there. `unseen`: drawn without being shown, only to keep the room it took. */
  const kept = (unseen: boolean) => (
    <div className="order-ghost-state" data-unseen={unseen || undefined} aria-hidden={unseen || undefined} inert={unseen}>
      {mark}
      <div className="order-ghost-text">
        <p className="order-ghost-lead">This is the only way back to this order. It is not saved anywhere.</p>
        <p className="order-ghost-sub muted">Its record is deleted from this site's server the moment it is delivered or refunded.</p>
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
            <p className="order-ghost-sub muted">{gasOpen ? "Its gas order is still open, below. This page's link is the way back to it until that has finished too." : "This page is all that is left of it; it will not load again."}</p>
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
 * The compact second line of a swap with gas, beneath the swap's four steps: "Gas", about how much
 * of the chain's own coin arrives while it may still arrive, and the gas order's own state in plain
 * words. Where gas could not be added it is one sentence. Marked as a step is marked, so the two
 * read alike. Once delivered, its delivery is linked as the swap's is.
 *
 * `belongs` is false for a gas order that is not the swap's own: the line is then the one sentence
 * that says so, and nothing of that order is drawn with it.
 */
function GasRow({ gas, now, hasContact, belongs = true }: { gas: GasLine; now: number; hasContact: boolean; belongs?: boolean }) {
  const line = gasWords(gas, now, hasContact, belongs);
  const order = belongs ? gasOrderOf(gas) : null;
  return (
    <div className="gas-line" data-state={line.mark}>
      <StepMark state={line.mark} />
      <div className="step-body">
        {line.state !== null ? (
          <p className="gas-line-head">
            <span className="step-title">Gas</span>
            {order !== null && line.mark === "current" ? (
              <span className="muted">
                about <Amount raw={order.amountOut} decimals={order.to.decimals} symbol={order.to.symbol} />
              </span>
            ) : null}
            <span className="gas-line-state">{line.state}</span>
          </p>
        ) : null}
        <p className={line.state !== null ? "step-text muted" : "step-text"}>{line.text}</p>
        {order !== null && order.depositTxUrl !== null && order.depositTxHash !== null ? <TxLinks label="Gas deposit" txs={[{ hash: order.depositTxHash, url: order.depositTxUrl }]} /> : null}
        {order !== null && order.details !== null ? <TxLinks label="Gas delivery" txs={order.details.destinationTxs} /> : null}
      </div>
    </div>
  );
}

/**
 * Paying the gas order, while it waits for its deposit: the same two ways as the swap, and the gas
 * order's own address, amount and time left in either. From a connected wallet it is the second of
 * two transfers: `held` while the swap's has not been sent, and then it is not on show. In Ghost
 * mode there is no wallet, and it is paid by sending to its deposit address.
 */
function GasPay({ gasOrder, now, onGas, held }: { gasOrder: OrderView; now: number; onGas(order: OrderView): void; held: boolean }) {
  const ghostTab = useGhost((state) => state.on);
  const byHand = <DepositDetails order={gasOrder} now={now} part="gas" />;
  if (ghostTab || gasOrder.pay !== "wallet" || !isWalletChain(gasOrder.from.chain)) return byHand;
  return (
    <WalletPay order={gasOrder} now={now} onOrder={onGas} part="second" held={held}>
      {byHand}
    </WalletPay>
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
 *
 * `gas` is what is known of the gas order asked for with this swap (as the swap's own answer says
 * it, unless the page knows better), and `onGas` takes a fresh view of that order. The gas order is
 * an order of its own and is shown as one: its line, its deposit and its hash field follow its own
 * state, whatever the swap's is, and stay when the swap's record has gone and its own has not.
 *
 * The page holds the pair to itself. The gas order it shows and takes payment for must be this
 * swap's own: the same receiving address, the same refund address, the same coin paid, the swap's
 * receiving chain (gasBelongs). One that is not is offered no way to be paid, here or from a wallet:
 * no deposit, no pay step, no hash field. The gas line says that it does not match, and the swap
 * itself is paid and followed as any order is.
 */
export function OrderContent({
  order,
  now,
  reconnecting,
  contact,
  onOrder,
  privacyMode = null,
  gone = false,
  how = null,
  gas = order.gas ?? null,
  onGas = () => undefined,
  children,
}: {
  order: OrderView;
  now: number;
  reconnecting: boolean;
  contact: string | null;
  onOrder(order: OrderView): void;
  privacyMode?: PrivacyMode;
  gone?: boolean;
  how?: SaidEnding | null;
  gas?: GasLine | null;
  onGas?(order: OrderView): void;
  children?: React.ReactNode;
}) {
  const steps = timeline(order, now);
  const end = ending(order, contact !== null, !gone);
  const awaitingDeposit = awaitsDeposit(order);
  const running = end === null;
  // The gas order, where there is one and it is this swap's own, and whether it is still to be paid.
  const gasOrder = gasOrderFor(order, gas);
  const gasAwaits = gasOrder !== null && awaitsDeposit(gasOrder);
  // A gas order is known, and it is not this swap's: nothing of it is offered, and the gas line says so.
  const mismatch = gasOrder === null && gasOrderOf(gas) !== null;
  // The swap's deposit is named as the swap's wherever the gas order's stands beside it.
  const part = gasAwaits ? "swap" : undefined;
  // A transfer this browser sent for the swap: in this visit, or (by its own note) an earlier one. The gas order's is asked of a wallet only after it.
  const [sentHere, setSentHere] = useState(() => sentFor(order.id)?.hash ?? null);
  // An order whose record is gone is a Ghost order, whether or not its last answer said so.
  const ghost = order.ghost === true || gone;
  // In Ghost mode no wallet is loaded: every order is paid by sending to its deposit address.
  const ghostTab = useGhost((state) => state.on);
  const link = `${window.location.origin}/order/${order.id}`;
  const contactHref = contact === null ? null : contact.startsWith("https://") ? contact : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact) ? `mailto:${contact}` : null;
  const title = (
    <h1 id="order-title" className="order-title">
      {pageTitle(order)}
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

      {ghost ? <GhostNote link={link} gone={gone} ended={end !== null} how={how} gasOpen={gasOrder !== null && gasPollDelay(gas) !== null} /> : null}

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
        // With a gas order still to be paid this is the first of two transfers, and the wallet must hold enough for both.
        <WalletPay order={order} now={now} onOrder={onOrder} part={gasDue(order, gas) > 0n ? "first" : null} alsoDue={gasDue(order, gas)} onSent={setSentHere}>
          <DepositDetails order={order} now={now} part={part} />
        </WalletPay>
      ) : awaitingDeposit ? (
        <>
          {gasAwaits ? <p className="pay-pair">{TWO_TRANSFERS}</p> : null}
          <DepositDetails order={order} now={now} part={part} />
        </>
      ) : null}

      {/* The gas order is paid beneath the swap, and apart from it. Its own record decides whether it still can be, not the swap's. */}
      {gasOrder !== null && gasAwaits ? <GasPay gasOrder={gasOrder} now={now} onGas={onGas} held={!gone && !firstSent(order, sentHere)} /> : null}

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

      {/* The gas order's line comes after everything of the swap's own progress, its transactions included: what is under the line is the gas order's. */}
      {gas !== null ? <GasRow gas={gas} now={now} hasContact={contact !== null} belongs={!mismatch} /> : null}

      {order.status === "waiting" && !gone ? <HashField order={order} onOrder={onOrder} part={gasOrder !== null ? "swap" : undefined} /> : null}
      {gasOrder !== null && gasOrder.status === "waiting" ? <HashField order={gasOrder} onOrder={onGas} part="gas" /> : null}

      <Summary order={order} privacyMode={privacyMode} gas={order.gasOrder === true} />
      {gasOrder !== null ? <Summary order={gasOrder} privacyMode={privacyMode} gas beside /> : null}

      <p className="order-foot muted">
        {/* A Ghost order has said what its link is worth at the top of the page, and says it once. */}
        {order.gasOrder === true ? "Gas order" : "Order"} <span className="mono">{order.id}</span>.{ghost ? null : <> Keep this page's link: it is the only way back to this order.</>}
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

/**
 * What a fresh load of a finished Ghost mode swap's link shows beneath the notice, while the gas
 * order made with that swap is still known: the gas order, in the order page's own frame. Nothing of
 * the swap is here, for nothing of it is kept. The link is still the one way back to the gas order,
 * so its line is here, and its deposit and hash field while it waits to be paid.
 *
 * Here the gas order cannot be held against its swap (gasBelongs): the server has deleted the
 * swap's record and says nothing of it but how it ended, so there is nothing to compare with. What
 * is shown is the gas order as the server gives it under the swap's own link.
 */
export function GasAlone({ gas, now, reconnecting, contact, onGas, children }: { gas: GasLine; now: number; reconnecting: boolean; contact: string | null; onGas(order: OrderView): void; children?: React.ReactNode }) {
  const gasOrder = gasOrderOf(gas);
  return (
    <section className="order" aria-labelledby="gas-alone-title">
      <header className="gas-alone-head">
        <h2 id="gas-alone-title" className="order-subtitle">
          Gas order
        </h2>
        <p className="muted">{gasOrder !== null ? "Made with the swap above, and an order of its own. This page's link is the only way back to it." : "Made with the swap above, and an order of its own."}</p>
      </header>

      <p className="order-reconnecting" role="status">
        {reconnecting ? "Reconnecting… Showing what was last known." : " "}
      </p>

      {gasOrder !== null && awaitsDeposit(gasOrder) ? <GasPay gasOrder={gasOrder} now={now} onGas={onGas} held={false} /> : null}

      <GasRow gas={gas} now={now} hasContact={contact !== null} />

      {gasOrder !== null && gasOrder.status === "waiting" ? <HashField order={gasOrder} onOrder={onGas} part="gas" /> : null}
      {gasOrder !== null ? <Summary order={gasOrder} privacyMode={null} gas beside /> : null}

      {children}
    </section>
  );
}

/** What moves a practice order along, each with the word on its button. */
const MOVES = [
  ["deposit", "Pay in full"],
  ["underpay", "Pay too little"],
  ["refund", "Refund"],
  ["fail", "Fail"],
] as const;

/**
 * The operator's tool for moving a practice order along. It says nothing of itself and stays folded
 * until asked for. A swap with gas is two orders, and each is moved by itself: the gas order has the
 * same controls as the swap, and they act on the gas order's own ID.
 */
function TestControls({ swap, gasOrder }: { swap: OrderView | null; gasOrder: OrderView | null }) {
  return (
    <details className="order-practice">
      <summary>Test controls</summary>
      {swap !== null ? (
        <div className="states-row" role="group" aria-label="Test controls">
          {MOVES.map(([action, label]) => (
            <button key={action} type="button" className="button-chip" onClick={() => void api.practice(swap.id, action).catch(() => undefined)}>
              {label}
            </button>
          ))}
          {/* These two move the practice server's own clock forward, for every practice order at once. */}
          {(["late", "expire"] as const).map((action) => (
            <button key={action} type="button" className="button-chip" onClick={() => void api.practice(swap.id, action).then(() => window.location.reload(), () => undefined)}>
              {action === "late" ? "Skip to deposits closed" : "Skip to expired"}
            </button>
          ))}
        </div>
      ) : null}
      {gasOrder !== null ? (
        <div className="states-row" role="group" aria-label="Test controls for the gas order">
          {MOVES.map(([action, label]) => (
            <button key={action} type="button" className="button-chip" onClick={() => void api.practice(gasOrder.id, action).catch(() => undefined)}>
              Gas: {label.toLowerCase()}
            </button>
          ))}
        </div>
      ) : null}
    </details>
  );
}

export default function OrderPage({ id }: { id: string }) {
  const [order, setOrder] = useState<OrderView | null>(null);
  // What is known of the gas order asked for with the swap. It comes with the swap's own answers, and with the answer that the swap's record is deleted.
  const [gas, setGas] = useState<GasLine | null>(null);
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
  // A swap with gas is two orders: the page goes on asking until both have ended, and, where the
  // swap's record is deleted first, until the gas order's is gone too.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    // What the order was when this page last looked.
    let seen: OrderView["status"] | null = null;
    // How many times an ended Ghost order has been looked at again.
    let looksAfterEnd = 0;
    // The same for the gas order of a swap whose record is gone.
    let gasLooksAfterEnd = 0;
    setOrder(null);
    setMissing(false);
    setDeleted(false);
    setEndedAs(null);
    setGas(null);
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
        // The gas line comes with the swap's answer. Where an answer says nothing of it, what was last known stays on the page.
        setGas((before) => gasKept(before, fresh.gas));
        // An order seen to be delivered has changed what a connected wallet holds of its two coins: both are read afresh.
        // (Not in Ghost mode: there is no wallet there, and no balance is read.)
        if (fresh.status === "delivered" && seen !== null && seen !== "delivered" && !ghostOn()) void useWallet.getState().loadBalances([fresh.from, fresh.to], 0);
        seen = fresh.status;
        useApp.setState({ clockOffset: Date.parse(fresh.serverNow) - Date.now() });
        next = pollDelay(fresh.status, 0);
        if (next === null && fresh.ghost === true) next = ghostLookAgain(looksAfterEnd++);
        // The gas order beside the swap is followed to its own end: the page stops only when both have ended.
        next = lookAgain(next, fresh.gas);
      } catch (err) {
        if (stopped || (err instanceof DOMException && err.name === "AbortError")) return;
        // The answer that a swap's record is deleted still tells of its gas order, while that is known. The gas line
        // is kept on the page, and the page goes on looking, for the gas order's sake, until that is gone too.
        const beside = err instanceof ApiError && err.code === "order_deleted" ? err.gas : null;
        if (beside !== null) {
          failures.current = 0;
          setGas(beside);
          const gasOrder = gasOrderOf(beside);
          if (gasOrder !== null) useApp.setState({ clockOffset: Date.parse(gasOrder.serverNow) - Date.now() });
          const again = gasLookAgain(beside, gasLooksAfterEnd);
          if (gasPollDelay(beside) === null) gasLooksAfterEnd += 1;
          if (again !== null) timer = setTimeout(() => void look(), again);
        }
        if (err instanceof ApiError && err.code === "order_deleted") {
          // An order made in Ghost mode has finished and its record is gone. Nothing more is asked of the swap itself.
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

  // A gas order still running after its swap's record has gone has a time to send by of its own: the
  // clock runs on for it, and stops when it has ended or is gone too.
  const gasRunsOn = deleted && gasPollDelay(gas) !== null;
  useEffect(() => {
    if (!gasRunsOn) return;
    const timer = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(timer);
  }, [gasRunsOn]);

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

  /** A fresh view of the gas order, from paying it or naming its transaction: it goes into the gas line, and nowhere else. */
  const placeGas = (view: OrderView) => setGas((line) => gasPlaced(line, view));
  const gasOrder = gasOrderOf(gas);
  // The swap can be moved while its record is here and it has not ended; the gas order, the same, by itself.
  const swapRuns = order !== null && !deleted && ending(order) === null;
  const gasRuns = gasOrder !== null && ending(gasOrder) === null;
  const controls = practice && (swapRuns || gasRuns) ? <TestControls swap={swapRuns ? order : null} gasOrder={gasRuns ? gasOrder : null} /> : null;

  // The swap's record was already gone when this page first asked, and its gas order is still known: the notice, and beneath it the gas order.
  if (deleted && order === null && gas !== null) {
    return (
      <>
        <OrderDeleted ended={endedAs} />
        <GasAlone gas={gas} now={now} reconnecting={reconnecting} contact={contact} onGas={placeGas}>
          {controls}
        </GasAlone>
      </>
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

  return (
    <OrderContent order={order} now={now} reconnecting={reconnecting} contact={contact} onOrder={setOrder} privacyMode={privacyMode} gone={deleted} how={endedAs} gas={gas} onGas={placeGas}>
      {controls}
    </OrderContent>
  );
}
