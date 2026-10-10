// Pure rules behind the order page: what each step says, what an ended order says, and when
// to look again. No browser APIs here, so every rule is unit-tested.

import { sameAddress } from "../../../shared/addresses.ts";
import { displayExact } from "../../../shared/amounts.ts";
import { isEndState, type GasLine, type OrderStatus, type OrderView } from "../../../shared/api.ts";
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
  /** What the other of a swap's two orders still needs of the same coin, in its smallest unit (see gasDue). Nothing when left out. */
  alsoDue?: bigint;
  /** True for the second of two transfers while the first has not been sent (see firstSent). */
  held?: boolean;
}): PayAction {
  const coin = input.order.from.symbol;
  const network = chainName(input.order.from.chain);
  if (input.phase === "asking") return { kind: "none", label: "Confirm in wallet…", disabled: true, busy: true };
  if (input.phase === "sent") return { kind: "none", label: "Sending…", disabled: true, busy: true };
  // Sending once more after a replacement is a separate, deliberate step (see paySecondary).
  if (input.phase === "replaced") return { kind: "none", label: "Transfer replaced", disabled: true, busy: false };
  if (input.phase === "unsure") return { kind: "none", label: "Check your wallet", disabled: true, busy: false };
  // The second of two transfers is not asked for before the first was sent: until then this button opens no wallet.
  if (input.held === true) return { kind: "none", label: "Send the swap first", disabled: true, busy: false };
  // Too close to the deadline for a transfer to be sure of arriving in time.
  if (input.left < 5 * 60_000) return { kind: "none", label: "Too close to the deadline", disabled: true, busy: false };
  if (!input.connected) return { kind: "connect", label: "Connect wallet", disabled: false, busy: false };
  if (input.walletChain !== input.order.from.chain) return { kind: "switch", label: `Switch to ${network}`, disabled: false, busy: false };
  if (input.balance !== null && input.balance < BigInt(input.order.amountIn)) return { kind: "none", label: `Not enough ${coin}`, disabled: true, busy: false };
  // Two orders paid with one coin: while both are still to be paid, the wallet must hold enough for both.
  if (input.balance !== null && input.balance < BigInt(input.order.amountIn) + (input.alsoDue ?? 0n)) return { kind: "none", label: fitLabel([`Not enough ${coin} for both`, "Not enough for both"], PAY_BUTTON_ROOM), disabled: true, busy: false };
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

// ---- A swap with gas ----
// Beside such a swap stands a second, small order that delivers a little of the receiving chain's
// own coin to the same receiving address. It is an order in its own right: its own deposit address,
// its own amount, its own deadline and its own end. The swap's page shows it as one compact line
// beneath the four steps and lets it be paid beside the swap. The rules of that are below.

/** The gas order itself, where the line carries one. Null where gas was not added, and where the order's record is gone. */
export function gasOrderOf(gas: GasLine | null | undefined): OrderView | null {
  return gas !== null && gas !== undefined && gas.made && gas.order !== null ? gas.order : null;
}

/** Whether an order is still to be paid: no deposit has been seen for it, or the one seen is not yet known to be in it. */
export function awaitsDeposit(order: Pick<OrderView, "status" | "depositProven">): boolean {
  return order.status === "waiting" || (order.status === "deposit_seen" && !order.depositProven);
}

/**
 * Whether a gas order is this swap's own: another order than the swap, paid with the swap's coin,
 * delivering the receiving chain's own coin (one with no contract) on the swap's receiving chain, to
 * the swap's own receiving address, and refunded to the swap's own refund address.
 *
 * The server makes every gas order so, from the swap's own request, and nothing a request says can
 * change it. The page holds the pair to it all the same: it never asks for a payment to a gas order
 * that would deliver anywhere but where the swap delivers. Addresses are compared as addresses of
 * their chain, so letter-case alone never parts a pair.
 */
export function gasBelongs(swap: Pick<OrderView, "id" | "from" | "to" | "recipient" | "refundTo">, gasOrder: Pick<OrderView, "id" | "from" | "to" | "recipient" | "refundTo">): boolean {
  if (gasOrder.id === swap.id) return false;
  if (gasOrder.from.id !== swap.from.id) return false;
  if (gasOrder.to.chain !== swap.to.chain) return false;
  if (gasOrder.to.contract !== null) return false;
  if (!sameAddress(swap.to.chain, gasOrder.recipient, swap.recipient)) return false;
  if (!sameAddress(swap.from.chain, gasOrder.refundTo, swap.refundTo)) return false;
  return true;
}

/**
 * The gas order a swap's page shows as that swap's and takes payment for: the one its gas line
 * carries, where that is the swap's own (see gasBelongs). Null where the line carries none, and
 * where the one it carries is not the swap's.
 */
export function gasOrderFor(swap: Parameters<typeof gasBelongs>[0], gas: GasLine | null | undefined): OrderView | null {
  const order = gasOrderOf(gas);
  return order !== null && gasBelongs(swap, order) ? order : null;
}

/** The one line a swap's page says when gas was asked for and could not be added. */
export const GAS_NOT_ADDED = "Gas was not added. Your swap is unaffected.";

/** The one line it says of a gas order that is not the swap's own. Nothing of that order is shown beside it, and no way to pay it. */
export const GAS_MISMATCH = "The gas order shown does not match this swap, and nothing should be sent to the gas order.";

/** What stands above the two deposits, the swap's and the gas's, when both are on show. */
export const TWO_TRANSFERS = "These are two separate transfers. Send each to its own address; do not combine them.";

/** The title of an order's own page. A gas order opened by its own ID says that it is one. */
export function pageTitle(order: Parameters<typeof orderTitle>[0] & Pick<OrderView, "gasOrder">): string {
  return order.gasOrder === true ? `Gas: ${orderTitle(order)}` : orderTitle(order);
}

export interface GasWords {
  /** How the line is marked, as a step is: still going, done, or stopped. */
  mark: Exclude<StepState, "pending">;
  /** Its state in a word or two. Null where the line is one plain sentence: gas was not added. */
  state: string | null;
  /** What that means, in a sentence or two. */
  text: string;
}

/** The word for how a gas order ended, where one word is all that is left of it. */
const GAS_ENDED: Record<SaidEnding, string> = { delivered: "Delivered", refunded: "Refunded", expired: "Ran out" };

/**
 * The gas line of a swap's page: the gas order's own state in plain words, whatever that state is.
 * `now` is the server's clock. A gas order that ran out with nothing sent to it says so, and that
 * nothing is lost: that is how it ends when only the swap was paid. `belongs` is false for a gas
 * order that is not the swap's own (see gasBelongs): the line then says that, whatever state that
 * order is in.
 */
export function gasWords(gas: GasLine, now: number, hasContact = true, belongs = true): GasWords {
  if (!gas.made) return { mark: "stopped", state: null, text: GAS_NOT_ADDED };
  // Made in Ghost mode and finished: one word is all the server still says of it.
  if (gas.order === null) return { mark: gas.ended === "delivered" ? "done" : "stopped", state: GAS_ENDED[gas.ended], text: `${ENDED_AS[gas.ended]} It was made in Ghost mode, so its record was deleted when it finished.` };
  if (!belongs) return { mark: "stopped", state: null, text: GAS_MISMATCH };
  const order = gas.order;
  const from = order.from;
  const paid = (raw: string) => displayExact(BigInt(raw), from.decimals);
  const keep = `Keep this page's link and its deposit transaction hash${hasContact ? ", and contact support" : ""}.`;
  switch (order.status) {
    case "waiting":
      // In the last two minutes nothing more should be sent to it: the line stops saying that it waits.
      return { mark: "current", state: "Waiting", text: payWindow(order, now).open ? "Waiting for its deposit." : "Its deposit is closed. Checking whether one arrived." };
    case "deposit_seen":
      return { mark: "current", state: "Seen", text: "Its deposit was seen. Waiting for confirmations." };
    case "swapping":
      return { mark: "current", state: "Swapping", text: `Its deposit is confirmed. Swapping it for ${order.to.symbol}.` };
    case "delivered":
      // What really arrived, where the provider reports it: the same exact figure, written the same way, as the swap's own last step.
      return { mark: "done", state: "Delivered", text: `${displayExact(BigInt(order.details?.amountOut ?? order.amountOut), order.to.decimals)} ${order.to.symbol} sent to ${shortAddress(order.recipient)}.` };
    case "deposit_too_small": {
      const arrived = order.details?.depositedAmount ?? null;
      return { mark: "stopped", state: "Deposit too small", text: `${arrived !== null ? `${paid(arrived)} of ${paid(order.amountIn)} ${from.symbol} arrived` : `Less than ${paid(order.amountIn)} ${from.symbol} arrived`}. It is returned to your refund address by the deadline. Nothing more needs sending.` };
    }
    case "refunded": {
      const reason = REFUND_REASONS[order.details?.refundReason ?? ""] ?? "The gas could not be delivered.";
      const refunded = order.details?.refundedAmount ?? null;
      return { mark: "stopped", state: "Refunded", text: `${reason} ${refunded !== null ? `${paid(refunded)} ${from.symbol} was` : `Your ${from.symbol} was`} returned to your refund address, ${shortAddress(order.refundTo)}, on ${chainName(from.chain)}.` };
    }
    case "failed":
      return { mark: "stopped", state: "Failed", text: `The gas could not be delivered. ${keep}` };
    case "expired":
      // A transaction was named for it and never confirmed: coins may be in it, and the line does not say that nothing is lost.
      return { mark: "stopped", state: "Ran out", text: order.depositTxHash !== null ? `No deposit was confirmed before its deadline. ${keep}` : "It ran out unpaid: nothing was sent to it and nothing is lost." };
  }
}

/** When to look again for the gas order's sake. Null when there is none to follow: gas was not added, its record is gone, or it has ended. */
export function gasPollDelay(gas: GasLine | null | undefined): number | null {
  const order = gasOrderOf(gas);
  return order === null ? null : pollDelay(order.status, 0);
}

/**
 * When a swap's page looks again. A swap with gas is two orders, and the page goes on looking until
 * both have ended. `swapWait` is what the swap alone asks for: null once it has ended and nothing
 * more is to be learned of it. Null only when neither order asks for another look.
 */
export function lookAgain(swapWait: number | null, gas: GasLine | null | undefined): number | null {
  const gasWait = gasPollDelay(gas);
  return swapWait === null ? gasWait : gasWait === null ? swapWait : Math.min(swapWait, gasWait);
}

/**
 * Once a swap's record is deleted (it was made in Ghost mode, and has finished), its page goes on
 * looking for the sake of its gas order: as often as for any running order while that one runs, a
 * few times more once it has ended, so as to learn that its record has gone too, and not at all
 * once nothing is left of it but a word. `looksAfterEnd` is how many looks have been made since it ended.
 */
export function gasLookAgain(gas: GasLine | null | undefined, looksAfterEnd: number): number | null {
  const order = gasOrderOf(gas);
  if (order === null) return null;
  return pollDelay(order.status, 0) ?? ghostLookAgain(looksAfterEnd);
}

/** What is known of the gas line after an answer: what the answer says of it or, where it says nothing, what was known before. */
export function gasKept(before: GasLine | null, said: GasLine | null | undefined): GasLine | null {
  return said ?? before;
}

/**
 * A fresh view of the gas order, put into the line. Only a view of the very order the line already
 * carries is taken; a view of any other order, the swap's own included, leaves the line as it was.
 */
export function gasPlaced(line: GasLine | null, view: OrderView): GasLine | null {
  return gasOrderOf(line)?.id === view.id ? { made: true, order: view } : line;
}

/**
 * Whether the first of the two transfers, the swap's own, has been sent. The second, the gas
 * order's, is asked of a wallet only after it. `sentHere` is the hash of a transfer this browser
 * sent for the swap, when it sent one. With no transfer on record the swap's own state decides: one
 * that still waits has not been paid, and one that ran out never was.
 */
export function firstSent(swap: Pick<OrderView, "status" | "depositTxHash">, sentHere: string | null): boolean {
  if (sentHere !== null || swap.depositTxHash !== null) return true;
  return swap.status !== "waiting" && swap.status !== "expired";
}

/**
 * What the gas order beside a swap still needs of the coin the swap is paid with, in the coin's
 * smallest unit: its whole amount while it waits with nothing sent to it, and nothing otherwise.
 * The pay button of the swap adds it to the swap's own amount when it checks the wallet's balance.
 * Only the swap's own gas order counts: one paid with another coin, or not the swap's at all, is no part of it.
 */
export function gasDue(swap: Parameters<typeof gasBelongs>[0], gas: GasLine | null | undefined): bigint {
  const order = gasOrderFor(swap, gas);
  if (order === null) return 0n;
  return order.status === "waiting" && order.depositsOpen && order.depositTxHash === null ? BigInt(order.amountIn) : 0n;
}

/** Which of a swap's two transfers a pay step is for: the swap's, with the gas's to follow, or the gas's. Null for an order paid alone. */
export type PayPart = "first" | "second";

/** The heading of a pay step and its opening lines. The wallet is asked for one plain transfer each time, whichever it is. */
export function payWords(part: PayPart | null): { title: string; lead: string } {
  const check = "Before you confirm, check that it shows this address and this amount.";
  if (part === "first") return { title: "Send the swap: 1 of 2", lead: `There are two transfers, each confirmed in your wallet: this one for the swap, then one for the gas. Your wallet is asked for nothing else. ${check}` };
  if (part === "second") return { title: "Now send the gas: 2 of 2", lead: `The second transfer is for the gas, and goes to an address of its own. Your wallet will ask you to confirm it and nothing else. ${check}` };
  return { title: "Pay from your wallet", lead: `Your wallet will ask you to confirm one transfer and nothing else. ${check}` };
}

/**
 * What is said beneath the pay button of the first transfer: what any pay step says and, once it
 * was sent, that the gas is the next step. The second step appears on the page at that moment, and
 * this line, which is read aloud as it changes, is what points to it.
 */
export function firstPayMessage(phase: PayPhase, network: string, pendingMs: number): { text: string; tone: "plain" | "attention" } | null {
  const said = payMessage(phase, network, pendingMs);
  return phase === "sent" && said !== null ? { text: `${said.text} Now send the gas, in the step below.`, tone: said.tone } : said;
}

/**
 * What is said beneath the pay button of the second transfer. Saying no to it changes nothing for
 * the swap, and the gas order can be paid until its own time to send by (`until`); left alone, it
 * runs out by itself.
 */
export function gasPayMessage(phase: PayPhase, network: string, pendingMs: number, until: string): { text: string; tone: "plain" | "attention" } | null {
  const left = `You can send the gas until ${until}. Left unpaid, the gas order runs out by itself and nothing is lost.`;
  if (phase === "idle") return { text: `Your swap goes on either way. ${left}`, tone: "plain" };
  if (phase === "rejected") return { text: `You cancelled in your wallet. Nothing was sent for the gas, and your swap is unaffected. ${left}`, tone: "plain" };
  return payMessage(phase, network, pendingMs);
}
