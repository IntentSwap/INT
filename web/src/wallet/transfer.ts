// The one transaction the wallet is ever asked for: a plain transfer of exactly the order's
// amount to the order's deposit address. Built from the stored order and nothing else, then
// taken apart again and compared with that order before any wallet is opened. No approval,
// no permit, no message to sign: this file can produce nothing but a transfer.
//
// No wallet or chain library is used here, so the rule can be tested on its own.

import { sameAddress } from "../../../shared/addresses.ts";
import type { OrderView } from "../../../shared/api.ts";
import { chainInfo, isWalletChain } from "../../../shared/chains.ts";

/** `transfer(address,uint256)`: the only contract call this site ever asks a wallet to make. */
export const TRANSFER_SELECTOR = "0xa9059cbb";

export interface PlainTransfer {
  /** The network the wallet must be on. */
  chainId: number;
  /** For a coin: the deposit address. For a token: the token's contract. */
  to: string;
  /** Raw units of the chain's own coin sent with the transaction. Zero for a token. */
  value: bigint;
  /** Empty for a coin. For a token: `transfer(depositAddress, amount)`. */
  data: string;
}

export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferError";
  }
}

/** The parts of an order the transfer is built from and checked against. */
export type PayableOrder = Pick<OrderView, "id" | "pay" | "from" | "amountIn" | "depositAddress" | "depositMemo" | "status" | "depositsOpen">;

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const word = (hex: string) => hex.toLowerCase().padStart(64, "0");

/** What the order says must be paid, checked for sense before anything is built from it. */
function facts(order: PayableOrder): { chainId: number; chain: string; deposit: string; amount: bigint; token: string | null } {
  if (order.status !== "waiting" || !order.depositsOpen || order.depositAddress === null) throw new TransferError("This order is no longer taking a deposit.");
  // Only an order that was made to be paid from a wallet, and whose deposit needs nothing a plain transfer cannot carry.
  if (order.pay !== "wallet") throw new TransferError("This order was not made to be paid from a connected wallet.");
  if (order.depositMemo !== null) throw new TransferError("This deposit needs a memo, which a wallet transfer cannot carry.");
  const chain = order.from.chain;
  const chainId = chainInfo(chain).evmChainId;
  if (!isWalletChain(chain) || chainId === undefined) throw new TransferError("This coin can't be paid from a connected wallet.");
  if (!HEX_ADDRESS.test(order.depositAddress)) throw new TransferError("The deposit address is not in the expected form.");
  if (!/^[1-9]\d{0,39}$/.test(order.amountIn)) throw new TransferError("The amount is not in the expected form.");
  const token = order.from.contract;
  if (token !== null && !HEX_ADDRESS.test(token)) throw new TransferError("The token's contract is not in the expected form.");
  // A token's contract is never a place to send the token itself.
  if (token !== null && sameAddress(chain, token, order.depositAddress)) throw new TransferError("The deposit address is the token's own contract.");
  return { chainId, chain, deposit: order.depositAddress, amount: BigInt(order.amountIn), token };
}

/** Builds the transfer for an order: the chain's own coin as a plain payment, a token as `transfer(depositAddress, amount)`. */
export function buildTransfer(order: PayableOrder): PlainTransfer {
  const { chainId, deposit, amount, token } = facts(order);
  if (token === null) return { chainId, to: deposit, value: amount, data: "0x" };
  return { chainId, to: token, value: 0n, data: `${TRANSFER_SELECTOR}${word(deposit.slice(2))}${word(amount.toString(16))}` };
}

/** What a transaction would do, read back from the transaction itself. Null when it is anything but a plain transfer. */
export function readTransfer(tx: PlainTransfer): { recipient: string; amount: bigint; token: string | null } | null {
  if (!HEX_ADDRESS.test(tx.to)) return null;
  if (tx.data === "0x" || tx.data === "") return tx.value > 0n ? { recipient: tx.to, amount: tx.value, token: null } : null;
  // A token transfer: the selector, then exactly two 32-byte words, and no coin sent along.
  if (!/^0x[0-9a-fA-F]+$/.test(tx.data) || tx.data.length !== 10 + 128 || tx.data.slice(0, 10).toLowerCase() !== TRANSFER_SELECTOR || tx.value !== 0n) return null;
  const first = tx.data.slice(10, 74);
  // An address fills the last 20 bytes of its word; the first 12 must be empty.
  if (!/^0{24}/.test(first)) return null;
  return { recipient: `0x${first.slice(24)}`, amount: BigInt(`0x${tx.data.slice(74)}`), token: tx.to };
}

/**
 * The gate. Takes a transaction apart and checks it against the stored order: the network,
 * who receives, which token (or none), and the exact amount. Throws when anything differs.
 * Nothing is handed to a wallet unless this has passed on the very transaction being sent.
 */
export function assertTransfer(tx: PlainTransfer, order: PayableOrder): void {
  const { chainId, chain, deposit, amount, token } = facts(order);
  const read = readTransfer(tx);
  if (read === null) throw new TransferError("The transaction is not a plain transfer.");
  if (tx.chainId !== chainId) throw new TransferError("The transaction is for another network.");
  if ((read.token === null) !== (token === null) || (read.token !== null && token !== null && !sameAddress(chain, read.token, token))) throw new TransferError("The transaction is for another coin.");
  if (!sameAddress(chain, read.recipient, deposit)) throw new TransferError("The transaction pays another address.");
  if (read.amount !== amount) throw new TransferError("The transaction is for another amount.");
}

/**
 * The order just fetched from the server must be the one the person is looking at: the same order,
 * paying the same address the same amount of the same coin. Throws when anything differs.
 */
export function assertSameOrder(shown: PayableOrder, fresh: PayableOrder): void {
  const same =
    shown.id === fresh.id &&
    shown.depositAddress !== null &&
    fresh.depositAddress !== null &&
    sameAddress(fresh.from.chain, shown.depositAddress, fresh.depositAddress) &&
    shown.amountIn === fresh.amountIn &&
    shown.from.id === fresh.from.id &&
    shown.from.chain === fresh.from.chain &&
    (shown.from.contract ?? "").toLowerCase() === (fresh.from.contract ?? "").toLowerCase();
  if (!same) throw new TransferError("This order changed since the page showed it. Reload the page and check it again.");
}

/**
 * Builds the transfer and passes it through the gate. The only way this site makes something for a wallet to sign.
 * `fresh` is the order as the server holds it now; `shown` is the one on screen when the button was pressed.
 * The builder can be handed in only so that a test can hand in a wrong one and see the gate stop what it made:
 * whatever builds the transfer, nothing leaves here that the gate has not passed.
 */
export function checkedTransfer(fresh: PayableOrder, shown: PayableOrder, build: (order: PayableOrder) => PlainTransfer = buildTransfer): PlainTransfer {
  assertSameOrder(shown, fresh);
  const tx = build(fresh);
  assertTransfer(tx, fresh);
  return tx;
}
