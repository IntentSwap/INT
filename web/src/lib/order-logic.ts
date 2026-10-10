// Pure rules behind the order page: what each step says, what an ended order says, and when
// to look again. No browser APIs here, so every rule is unit-tested.

import { displayExact } from "../../../shared/amounts.ts";
import { isEndState, type OrderStatus, type OrderView } from "../../../shared/api.ts";
import { chainName, DEPOSIT_CLOSE_MS } from "../../../shared/chains.ts";
import { fitLabel, PAY_BUTTON_ROOM, shortAddress } from "./swap-logic.ts";

/** "stopped": the step an order was at when it ended without delivering. */
export type StepState = "done" | "current" | "stopped" | "pending";

export interface Step {
  key: "deposit" | "seen" | "swapping" | "delivered";
  title: string;
  /** One sentence for the step as it stands. Empty for a step that has not been reached. */
  text: string;
  state: StepState;
}

const ORDER: Record<OrderStatus, number> = {
  waiting: 0,
  expired: 0,
  deposit_seen: 1,
  deposit_too_small: 1,
  swapping: 2,
  failed: 2,
  refunded: 2,
  delivered: 4,
};

/** "14:05": the time of day on this device's clock. */
export function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "29:41" or "1:02:10": time left or elapsed, never negative. */
export function clockSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

/** What is left of the estimate for the swapping step, as "about N min", or null once it has run past twice the estimate. */
export function swapTimeLeft(order: Pick<OrderView, "timeEstimate" | "statusSince">, now: number): string | null {
  const elapsed = Math.max(0, now - Date.parse(order.statusSince)) / 1000;
  const estimate = Math.max(order.timeEstimate, 60);
  if (elapsed > 2 * estimate) return null;
  const left = Math.max(1, Math.ceil((estimate - elapsed) / 60));
  return `about ${left} min`;
}

/**
 * The four steps of an order: waiting for the deposit, deposit seen, swapping, delivered.
 * `now` is the server's clock. An order that ended any other way keeps the steps it completed;
 * the step it stopped at is marked "stopped", and the ending is told by `ending()`.
 */
export function timeline(order: OrderView, now: number): Step[] {
  const reached = ORDER[order.status];
  const ended = isEndState(order.status) || order.status === "deposit_too_small";
  const state = (index: number): StepState => (order.status === "delivered" || index < reached ? "done" : index === reached ? (ended ? "stopped" : "current") : "pending");
  const sent = `${displayExact(BigInt(order.amountIn), order.from.decimals)} ${order.from.symbol}`;
  const received = order.details?.amountOut ?? order.amountOut;
  const left = order.status === "swapping" ? swapTimeLeft(order, now) : null;

  return [
    {
      key: "deposit",
      title: "Waiting for deposit",
      text:
        state(0) === "done"
          ? `${sent} sent.`
          : order.status === "expired"
            ? "No deposit arrived before the deadline."
            : // In the last two minutes nothing more should be sent: the step must not go on asking for it.
              Date.parse(order.deadline) - now <= DEPOSIT_CLOSE_MS
              ? "Deposits are closed. Checking whether one arrived."
              : `Send ${sent} before ${clockTime(sendBy(order))}.`,
      state: state(0),
    },
    {
      key: "seen",
      title: "Deposit seen",
      text: state(1) === "pending" ? "" : state(1) === "done" ? "Deposit confirmed." : order.status === "deposit_too_small" ? "Less than the full amount arrived." : "Deposit found. Waiting for confirmations.",
      state: state(1),
    },
    {
      key: "swapping",
      title: "Swapping",
      text:
        state(2) === "pending"
          ? ""
          : state(2) === "done"
            ? "Swapped."
            : order.status !== "swapping"
              ? ""
              : left === null
                ? "Taking longer than usual. If the swap fails, the provider refunds you automatically."
                : `Swapping. ${left.charAt(0).toUpperCase()}${left.slice(1)} left.`,
      state: state(2),
    },
    {
      key: "delivered",
      title: "Delivered",
      // The same exact figure as in the ending above the steps: one amount, one way of writing it.
      text: order.status === "delivered" ? `${displayExact(BigInt(received), order.to.decimals)} ${order.to.symbol} sent to ${shortAddress(order.recipient)}.` : "",
      state: order.status === "delivered" ? "done" : "pending",
    },
  ];
}

export interface Ending {
  headline: string;
  /** One line: what happened, and what to keep or expect. */
  cause: string;
  action: "swap-again" | "copy-link" | "contact";
  /** How the ending reads: good news, a plain fact, or something that needs attention. */
  tone: "good" | "plain" | "attention";
}

/** Plain words for the reasons the swap service gives for a refund. Its own codes are never shown. */
const REFUND_REASONS: Record<string, string> = {
  SLIPPAGE_EXCEEDED: "The price moved beyond the limit you accepted.",
  DEADLINE_EXCEEDED: "The deposit arrived after the deadline.",
  PARTIAL_DEPOSIT: "Less than the full amount was sent.",
  INCOMPLETE_DEPOSIT: "Less than the full amount was sent.",
};

/**
 * How an order ended: a headline, one line of cause, and the one thing worth doing next. Null while it is still running.
 * `linkLeads` is false for an order whose record the server has deleted (an order made in Ghost mode, once it has
 * finished): its page's link leads nowhere any more, so what is worth keeping is named as the order's ID.
 */
export function ending(order: OrderView, hasContact = true, linkLeads = true): Ending | null {
  // "Contact support" is only said where there is a contact to give. (A site that takes real swaps always has one: the server will not switch swaps on without it.)
  const andWrite = hasContact ? ", and contact support" : "";
  const thisLink = linkLeads ? "this page's link" : "this order's ID";
  const from = order.from;
  const amount = (raw: string | null | undefined, fallback: string, decimals: number) => displayExact(BigInt(raw ?? fallback), decimals);
  switch (order.status) {
    case "delivered":
      return {
        headline: "Delivered",
        cause: `${amount(order.details?.amountOut, order.amountOut, order.to.decimals)} ${order.to.symbol} was sent to your ${chainName(order.to.chain)} address.`,
        action: "swap-again",
        tone: "good",
      };
    case "refunded": {
      const reason = REFUND_REASONS[order.details?.refundReason ?? ""] ?? "The swap could not be completed.";
      const refunded = order.details?.refundedAmount ?? null;
      return {
        headline: "Refunded",
        cause: `${reason} ${refunded !== null ? `${amount(refunded, "0", from.decimals)} ${from.symbol} was` : `Your ${from.symbol} was`} returned to your refund address, ${shortAddress(order.refundTo)}, on ${chainName(from.chain)}.`,
        action: "swap-again",
        tone: "plain",
      };
    }
    case "deposit_too_small": {
      const arrived = order.details?.depositedAmount ?? null;
      return {
        headline: "Deposit too small",
        cause: `${arrived !== null ? `${amount(arrived, "0", from.decimals)} of ${amount(order.amountIn, "0", from.decimals)} ${from.symbol} arrived` : `Less than ${amount(order.amountIn, "0", from.decimals)} ${from.symbol} arrived`}. It is returned to your refund address by the deadline. Nothing more needs sending.`,
        action: "copy-link",
        tone: "attention",
      };
    }
    case "failed":
      return {
        headline: "Swap failed",
        cause: `The swap could not be completed. Keep ${thisLink} and your deposit transaction hash${andWrite}.`,
        action: "contact",
        tone: "attention",
      };
    case "expired":
      return {
        headline: "Expired",
        cause:
          order.depositTxHash !== null
            ? `No deposit was confirmed before the deadline. Keep ${thisLink} and your deposit transaction hash${andWrite}.`
            : `No deposit arrived before the deadline. If you did send coins, keep the transaction hash and ${thisLink}${andWrite}.`,
        action: order.depositTxHash !== null ? "contact" : "swap-again",
        tone: "plain",
      };
    default:
      return null;
  }
}

/** How long to wait before asking the server again. Null when the order has ended and there is nothing more to learn. */
export function pollDelay(status: OrderStatus, failures: number): number | null {
  if (isEndState(status)) return null;
  // After a failed attempt: 5 s, 10 s, 20 s, then every 30 s.
  if (failures > 0) return Math.min(30_000, 5000 * 2 ** (failures - 1));
  return status === "deposit_too_small" ? 30_000 : 5000;
}

/**
 * An order made in Ghost mode is looked at a few more times after it has ended. Its record is
 * deleted from the server the moment it finishes, and the order's page says so only once the
 * server has said it. `looks` is how many such looks have been made already. Null when no more are
 * made: an order that ended with coins still in it is kept until that has been dealt with, and
 * there is then nothing to wait for.
 */
export function ghostLookAgain(looks: number): number | null {
  return [2000, 5000, 10_000, 20_000, 30_000][looks] ?? null;
}

/** The browser tab's title: the ending, when there is one. */
export function tabTitle(order: OrderView | null): string {
  const end = order === null ? null : ending(order);
  return end !== null ? `${end.headline} · IntentSwap` : "Order · IntentSwap";
}

/**
 * The amount to pay as a heading or a list row may give it: the exact figure where that is short
 * enough to stay on one line of a phone (twelve characters), and otherwise nothing. A longer one
 * is left out, never shortened: a rounded amount to pay would read as exact, and someone sending
 * by hand could type it and pay too little. The exact amount is on the order's page, in the
 * Amount row, with its own Copy button.
 */
export function headingAmount(amountIn: string, decimals: number): string | null {
  const exact = displayExact(BigInt(amountIn), decimals);
  return exact.length <= 12 ? exact : null;
}

/** An order's title: "0.5 ETH to USDT", or "ETH to USDT" where the amount is too long to give exactly (see headingAmount). */
export function orderTitle(order: { amountIn: string; from: { symbol: string; decimals: number }; to: { symbol: string } }): string {
  const amount = headingAmount(order.amountIn, order.from.decimals);
  const coins = `${order.from.symbol} to ${order.to.symbol}`;
  return amount === null ? coins : `${amount} ${coins}`;
}

/** The time to send by: two minutes before the order's deadline, when the deposit details are taken away. The pages name this time, never the deadline itself. */
export function sendBy(order: Pick<OrderView, "deadline">): number {
  return Date.parse(order.deadline) - DEPOSIT_CLOSE_MS;
}

/**
 * Time left to pay, and whether the deposit details are still on show. `now` is the server's clock.
 * `left` runs to the order's deadline (the wallet's own cut-off is measured against it); `toSend`
 * runs to the time to send by, and is what a person is shown.
 */
export function payWindow(order: Pick<OrderView, "deadline" | "depositsOpen">, now: number): { left: number; toSend: number; open: boolean } {
  // The server stops giving out the deposit details two minutes before the deadline. The page applies
  // the same rule to what it already holds, so the details also go when the server cannot be reached.
  return { left: Math.max(0, Date.parse(order.deadline) - now), toSend: Math.max(0, sendBy(order) - now), open: order.depositsOpen && Date.parse(order.deadline) - now > DEPOSIT_CLOSE_MS };
}

/**
 * Where a payment from a wallet stands.
 *  - idle: nothing has been sent for this order.
 *  - asking: the wallet's window is open.
 *  - sent: a transfer was sent and is being followed (in this visit, or found on record after a reload).
 *  - rejected: the person said no in the wallet. Nothing was sent.
 *  - failed: the transfer was included and failed. Nothing was deposited.
 *  - replaced: the wallet put another transaction in its place: a faster copy, or a cancel. Which, cannot be told.
 *  - unsure: the page was reloaded while the wallet was being asked, so what the wallet did is not known here.
 *  - again: the person has said the earlier transfer failed, was cancelled or was never confirmed, and wants to send.
 */
export type PayPhase = "idle" | "asking" | "sent" | "rejected" | "failed" | "replaced" | "unsure" | "again";

export interface PayAction {
  kind: "connect" | "switch" | "send" | "none";
  label: string;
  disabled: boolean;
  busy: boolean;
}

/**
 * Where to start when the page is opened: an order that already carries a transaction hash has had a
 * transfer sent for it. The page follows that transfer; it does not offer "Send" as if nothing had happened.
 */
export function startingPhase(order: Pick<OrderView, "depositTxHash">, wasAsking = false): PayPhase {
  // The wallet was open when the page was last here, and never answered this page: it may have sent.
  if (wasAsking) return "unsure";
  return order.depositTxHash !== null ? "sent" : "idle";
}

/**
 * The pay button on an order paid from a connected wallet: always the next step, or the reason
 * nothing can happen. The wallet is only ever opened by a press of this button.
 */
export function payAction(input: {
  phase: PayPhase;
  connected: boolean;
  /** Our name for the network the wallet is on, or null when it is on one this site does not pay on. */
  walletChain: string | null;
  order: Pick<OrderView, "from" | "amountIn">;
  /** The wallet's balance of the coin, when known. */
  balance: bigint | null;
  /** Time left before the deadline, in ms. */
  left: number;
}): PayAction {
  const coin = input.order.from.symbol;
  const network = chainName(input.order.from.chain);
  if (input.phase === "asking") return { kind: "none", label: "Confirm in wallet…", disabled: true, busy: true };
  if (input.phase === "sent") return { kind: "none", label: "Sending…", disabled: true, busy: true };
  // Sending once more after a replacement is a separate, deliberate step (see paySecondary).
  if (input.phase === "replaced") return { kind: "none", label: "Transfer replaced", disabled: true, busy: false };
  if (input.phase === "unsure") return { kind: "none", label: "Check your wallet", disabled: true, busy: false };
  // Too close to the deadline for a transfer to be sure of arriving in time.
  if (input.left < 5 * 60_000) return { kind: "none", label: "Too close to the deadline", disabled: true, busy: false };
  if (!input.connected) return { kind: "connect", label: "Connect wallet", disabled: false, busy: false };
  if (input.walletChain !== input.order.from.chain) return { kind: "switch", label: `Switch to ${network}`, disabled: false, busy: false };
  if (input.balance !== null && input.balance < BigInt(input.order.amountIn)) return { kind: "none", label: `Not enough ${coin}`, disabled: true, busy: false };
  // The exact amount is in the row right above the button, and in the wallet's own prompt. The button
  // repeats it where it fits on one line; an 18-decimal amount does not, and is then left to those two.
  const amount = `${displayExact(BigInt(input.order.amountIn), input.order.from.decimals)} ${coin}`;
  return { kind: "send", label: fitLabel([`Send ${amount}`, `Send ${coin}`], PAY_BUTTON_ROOM), disabled: false, busy: false };
}

/** What is said beneath the pay button. Plain facts; a cancelled prompt is not an error. */
export function payMessage(phase: PayPhase, network: string, pendingMs: number): { text: string; tone: "plain" | "attention" } | null {
  if (phase === "rejected") return { text: "You cancelled in your wallet. Nothing was sent.", tone: "plain" };
  if (phase === "failed") return { text: "Your transfer failed on-chain, so nothing was deposited. Only the network fee was spent. You can try again.", tone: "attention" };
  if (phase === "replaced") return { text: "Your wallet replaced this transfer. If you sped it up, the new one is picked up here when it arrives. If you cancelled it, nothing left your wallet.", tone: "attention" };
  if (phase === "unsure") return { text: "This page was reloaded while your wallet was being asked. If you confirmed there, the transfer is on its way and is picked up here when it arrives. If you did not, nothing was sent.", tone: "attention" };
  if (phase === "again") return { text: "Send only if your wallet shows that no transfer for this order is on its way: none was confirmed, or the one sent failed or was cancelled. If two go through, the second may be slow or impossible to get back.", tone: "attention" };
  if (phase === "sent") return pendingMs > 60_000 ? { text: `Still confirming on ${network}.`, tone: "plain" } : { text: "Sent. Waiting for it to be confirmed.", tone: "plain" };
  return null;
}

/**
 * The way to send a second time, kept apart from the main button: offered only when the first
 * transfer was replaced, or has gone unconfirmed for more than a minute. Null otherwise.
 */
export function paySecondary(phase: PayPhase, pendingMs: number): string | null {
  if (phase === "replaced") return "I cancelled it. Send again";
  if (phase === "unsure") return "I did not confirm it. Send now";
  if (phase === "sent" && pendingMs > 60_000) return "My wallet shows it failed or was cancelled";
  return null;
}

/** How an order made in Ghost mode ended, as the server says it of one whose record it has deleted: one word, and all it still knows. */
export type SaidEnding = "delivered" | "refunded" | "expired";

/** That word, from what came with the server's "deleted" answer. Null when it said none, or anything else. */
export function endingSaid(detail: Record<string, unknown> | null | undefined): SaidEnding | null {
  const ended = detail?.ended;
  return ended === "delivered" || ended === "refunded" || ended === "expired" ? ended : null;
}

/** The one sentence that says it. */
export const ENDED_AS: Record<SaidEnding, string> = {
  delivered: "It was delivered.",
  refunded: "It was refunded.",
  expired: "It ran out without being paid.",
};

/** Where to look for what a finished order sent back, when the page did not see it end. */
export const LOOK_FOR: Record<SaidEnding, string> = {
  delivered: "It was delivered: look for the delivery at your receiving address, in the order details below.",
  refunded: "It was refunded: look for the refund at your refund address, in the order details below.",
  expired: "It ran out without being paid.",
};

