// What a wallet may be asked for on this site, and what the wallet window may do. Kept apart from
// the wallet library, with no import of it, so that a test can hold these to the rule: to pay, the
// wallet is asked for one plain transfer and nothing else. Never an approval or a permit, and
// never a signature. The one signature this site ever asks for is the Rewards page's sign-in:
// one plain message, asked for by one module (sign-in.ts) that only that page uses.

import { chainInfo, WALLET_CHAIN_NODE, WALLET_CHAINS } from "../../../shared/chains.ts";

/** What paying an order may ask a wallet for. `eth_sendTransaction` only ever carries the one checked transfer. */
export const PAY_METHODS = ["eth_sendTransaction", "wallet_switchEthereumChain", "wallet_addEthereumChain"] as const;

/** What the Rewards page's sign-in asks for: a signature of one plain message. Not a transaction, and never asked for anywhere else. */
export const SIGN_IN_METHOD = "personal_sign";

/** Everything a wallet may be asked for on this site. */
export const WALLET_METHODS = [...PAY_METHODS, SIGN_IN_METHOD] as const;

/**
 * What a phone wallet (WalletConnect) is asked to allow when it connects: to send a transaction,
 * change network and add a network, on the four chains this site pays on, and to sign a plain
 * message (the Rewards page's sign-in). Not to sign typed data or transactions, not to batch
 * calls, not to grant standing permissions. The node it is told about for each
 * chain is the chain's own public one, never the library maker's.
 */
export function sessionRights(): { methods: { eip155: string[] }; rpcMap: Record<string, string> } {
  return {
    methods: { eip155: [...WALLET_METHODS] },
    rpcMap: Object.fromEntries(WALLET_CHAINS.map((key) => [`eip155:${chainInfo(key).evmChainId}`, WALLET_CHAIN_NODE[key]])),
  };
}

/**
 * The wallet window's switches. Only the connection itself: no sign-in by email or social account,
 * no buying, swapping or sending inside the window, no usage reporting, and no message to sign in
 * order to "log in". Every one is off.
 */
export const WINDOW_FEATURES = {
  analytics: false,
  email: false,
  socials: false,
  swaps: false,
  onramp: false,
  send: false,
  receive: false,
  history: false,
  pay: false,
  smartSessions: false,
  reownAuthentication: false,
  legalCheckbox: false,
} as const;
