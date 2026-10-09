import { ChevronDown, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { displayExact } from "../../../shared/amounts.ts";
import type { OrderView } from "../../../shared/api.ts";
import { chainName, explorerTxUrl } from "../../../shared/chains.ts";
import { api } from "../api.ts";
import { clockSpan, clockTime, payAction, payMessage, paySecondary, payWindow, sendBy, startingPhase, type PayAction, type PayPhase } from "../lib/order-logic.ts";
import { lastLook, watchReceipt, watchTransfer } from "../lib/transfer-watch.ts";
import { doneAsking, forgetSent, rememberAsking, rememberSent, sentFor, wasAsking } from "../stores/sent.ts";
import { useWallet } from "../stores/wallet.ts";
import { Address } from "./Address.tsx";
import { PrimaryButton, TextButton } from "./Button.tsx";
import { PracticeLine } from "./PracticeLine.tsx";

/**
 * Paying an order from a connected wallet. The wallet is opened only by a press of the button
 * here, and is asked for one thing: a plain transfer of the order's exact amount to the order's
 * deposit address. The address is shown in full first, so it can be matched in the wallet.
 */
export function WalletPay({ order, now, onOrder, children }: { order: OrderView; now: number; onOrder(order: OrderView): void; children?: React.ReactNode }) {
  const wallet = useWallet();
  // A transfer sent before this page was opened is followed, not offered again. It is known from the
  // order itself (once the server has seen it on the chain) or from this browser's own note of having sent it.
  const [earlier] = useState(() => sentFor(order.id));
  const [phase, setPhase] = useState<PayPhase>(() => startingPhase({ depositTxHash: order.depositTxHash ?? earlier?.hash ?? null }, wasAsking(earlier, now)));
  const [note, setNote] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(order.depositTxHash ?? earlier?.hash ?? null);
  // When the transfer now being followed was sent. Unknown (zero) for one this browser did not send: it reads as "still confirming".
  const [sentAt, setSentAt] = useState(earlier !== null && earlier.hash !== null && earlier.asking !== true && (order.depositTxHash === null || order.depositTxHash === earlier.hash) ? earlier.at : 0);
  // The hash is told to the server when it is first sent, and again when the transfer is included.
  const [fresh, setFresh] = useState(false);
  const from = order.from;
  const network = chainName(from.chain);
  const connected = wallet.status === "connected" && wallet.address !== null;
  const balance = connected && wallet.chain === from.chain ? (wallet.balances.get(from.id) ?? null) : null;
  const pay = payWindow(order, now);
  const action = payAction({ phase, connected, walletChain: wallet.chain, order, balance, left: pay.left });
  const refreshBalance = wallet.refreshBalance;
  const orderId = order.id;
  const latestOnOrder = useRef(onOrder);
  latestOnOrder.current = onOrder;

  // The balance of the coin being paid, read once the wallet is on the right network.
  useEffect(() => {
    if (connected && wallet.chain === from.chain) void refreshBalance(from);
  }, [connected, wallet.address, wallet.chain, from.id, refreshBalance]);

  // A hash that appears on the order while nothing is under way here (reported from another tab, or
  // typed into the box below) is a transfer that was sent: follow it.
  useEffect(() => {
    if (phase === "idle" && order.depositTxHash !== null) {
      setHash(order.depositTxHash);
      setPhase("sent");
    }
  }, [phase, order.depositTxHash]);

  // A sent transfer is followed until it is included, fails or is replaced. Nothing of the wallet
  // is needed for this, so it also runs after a reload, with no wallet connected.
  useEffect(() => {
    if (phase !== "sent" || hash === null) return;
    const stop = new AbortController();
    /** Tells the server the transaction's hash. Told again once the transfer is included: that is what confirms it. */
    const report = () =>
      void api
        .submitDeposit(orderId, hash)
        .then((next) => latestOnOrder.current(next))
        .catch(() => undefined);
    if (fresh) report();
    void watchTransfer({ read: (method, params) => api.chainRead(from.chain, method, params), hash, signal: stop.signal }).then((outcome) => {
      if (outcome === "mined") report();
      else if (outcome === "reverted") {
        // Nothing is on its way any more: the note of having sent it goes, and sending is offered again.
        forgetSent(orderId);
        setPhase("failed");
      } else if (outcome === "replaced") setPhase("replaced");
    });
    return () => stop.abort();
  }, [phase, hash, fresh, orderId, from.chain]);

  // A transfer that was called replaced, or whose fate is not known after a reload, is still looked
  // for, also while the person is on the step of sending again: if its receipt turns up, it was
  // included after all, and the page says so and takes Send away.
  useEffect(() => {
    if ((phase !== "replaced" && phase !== "unsure" && phase !== "again") || hash === null) return;
    const stop = new AbortController();
    void watchReceipt({ read: (method, params) => api.chainRead(from.chain, method, params), hash, signal: stop.signal }).then((outcome) => {
      if (outcome === "mined") setPhase("sent");
      else if (outcome === "reverted") {
        forgetSent(orderId);
        setPhase("failed");
      }
    });
    return () => stop.abort();
  }, [phase, hash, orderId, from.chain]);

  const act = async () => {
    setNote(null);
    if (action.kind === "connect") {
      void wallet.connect();
      return;
    }
    if (action.kind !== "switch" && action.kind !== "send") return;
    const lib = await import("../wallet/index.ts");
    if (action.kind === "switch") {
      try {
        await lib.switchTo(from.chain);
      } catch (error) {
        if (!lib.wasRejected(error)) setNote(`Your wallet could not change network. Choose ${network} in your wallet, then try again.`);
      }
      return;
    }
    const before = phase;
    // An earlier transfer is on record: one last question about it, at the last moment. If it went
    // through after all, nothing more is sent; if the chain cannot be asked, nothing is sent on a guess.
    if (hash !== null) {
      const first = await lastLook((method, params) => api.chainRead(from.chain, method, params), hash);
      if (first === "included") {
        setPhase("sent");
        setNote("Your first transfer was included after all. Nothing more was sent.");
        return;
      }
      if (first === "unknown") {
        setNote("Your first transfer could not be checked just now, so nothing was sent. Try again in a moment.");
        return;
      }
    }
    setPhase("asking");
    // Written down before the wallet opens: if the page is reloaded while it is open, the page that
    // comes back knows it cannot tell what the wallet did.
    rememberAsking(order.id, now);
    try {
      // What is paid is the order as the server holds it at this moment, checked against the one on screen.
      const current = await api.order(order.id);
      const txHash = await lib.pay(current, order);
      onOrder(current);
      // Written down in this browser at once, before anything else can go wrong: a reload from here on follows this transfer.
      rememberSent(order.id, txHash, now);
      setHash(txHash);
      setSentAt(now);
      setFresh(true);
      setPhase("sent");
    } catch (error) {
      // The wallet answered, and sent nothing.
      doneAsking(order.id);
      if (lib.wasRejected(error)) setPhase("rejected");
      else {
        // Back to where the person was: a second send that could not be made keeps its warning.
        setPhase(before);
        setNote(error instanceof Error && error.name === "TransferError" ? `${error.message} Nothing was sent.` : "Your wallet could not send the transfer. Nothing was sent. Check the network and your balance, then try again.");
      }
    }
  };

  const pendingMs = sentAt === 0 ? Number.POSITIVE_INFINITY : now - sentAt;
  const message = payMessage(phase, network, pendingMs);
  const link = hash !== null && (phase === "sent" || phase === "replaced") ? explorerTxUrl(from.chain, hash) : null;
  const secondary = paySecondary(phase, pendingMs);

  if (!pay.open || order.depositAddress === null) return <>{children}</>;

  return (
    <PayPanel
      order={order}
      now={now}
      action={action}
      text={note ?? message?.text ?? null}
      tone={note !== null ? "attention" : (message?.tone ?? "plain")}
      link={link}
      onAct={() => void act()}
      secondary={secondary !== null ? { label: secondary, onPress: () => setPhase("again") } : null}
    >
      {/* Not offered while a transfer is in the wallet or on its way: a second payment may be slow or impossible to get back. */}
      {phase === "idle" || phase === "rejected" || phase === "failed" ? children : undefined}
    </PayPanel>
  );
}

/** What the pay step shows. Everything it says comes in from outside, so each state can be looked at on its own. */
export function PayPanel({
  order,
  now,
  action,
  text,
  tone,
  link,
  onAct,
  secondary = null,
  children,
}: {
  order: OrderView;
  now: number;
  action: PayAction;
  text: string | null;
  tone: "plain" | "attention";
  link: string | null;
  onAct(): void;
  /** A second, lesser control under the message: the deliberate way to send once more. */
  secondary?: { label: string; onPress(): void } | null;
  children?: React.ReactNode;
}) {
  const from = order.from;
  const network = chainName(from.chain);
  const pay = payWindow(order, now);
  if (order.depositAddress === null) return null;

  return (
    <section className="deposit" aria-labelledby="pay-title">
      <div className="deposit-head">
        <h2 id="pay-title" className="order-subtitle">
          Pay from your wallet
        </h2>
        <p className="deposit-clock">
          <span className="mono">{clockSpan(pay.toSend)}</span> <span className="muted">left to send, until {clockTime(sendBy(order))}</span>
        </p>
      </div>

      <p className="muted">Your wallet will ask you to confirm one transfer and nothing else. Before you confirm, check that it shows this address and this amount.</p>

      <div className="deposit-address">
        <p className="deposit-address-label">
          Deposit address<span className="muted"> · {network}</span>
        </p>
        <PracticeLine />
        <p className="review-address-value">
          <Address value={order.depositAddress} />
        </p>
      </div>
      <dl className="deposit-rows">
        <div className="deposit-row">
          <dt className="muted">Amount</dt>
          <dd>
            <span className="mono deposit-value">
              {displayExact(BigInt(order.amountIn), from.decimals)} {from.symbol}
            </span>
          </dd>
        </div>
        <div className="deposit-row">
          <dt className="muted">Network</dt>
          <dd>
            <span className="deposit-value">{network}</span>
          </dd>
        </div>
      </dl>

      <PrimaryButton onClick={onAct} disabled={action.disabled} busy={action.busy}>
        {action.label}
      </PrimaryButton>
      <p className="pay-message" data-tone={tone} role="status">
        {text ?? " "}
        {link !== null ? (
          <>
            {" "}
            <a href={link} target="_blank" rel="noopener noreferrer" className="pay-link">
              View it
              <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
              <span className="sr-only">(opens the block explorer)</span>
            </a>
          </>
        ) : null}
      </p>
      {secondary !== null ? <TextButton onClick={secondary.onPress}>{secondary.label}</TextButton> : null}

      {children !== undefined && children !== null ? (
        <details className="order-fold">
          <summary>
            Pay another way: send it yourself
            <ChevronDown className="fold-chevron" size={16} strokeWidth={1.5} aria-hidden="true" />
          </summary>
          {children}
        </details>
      ) : null}
    </section>
  );
}
