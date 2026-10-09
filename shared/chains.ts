// Chain registry. Keys are the provider's `blockchain` values.
// Explorer links are built only from the templates in this file.

export type ChainFamily =
  | "evm"
  | "solana"
  | "bitcoin"
  | "litecoin"
  | "dogecoin"
  | "bitcoincash"
  | "dash"
  | "zcash"
  | "near"
  | "tron"
  | "ton"
  | "stellar"
  | "xrp"
  | "sui"
  | "aptos"
  | "starknet"
  | "cardano"
  | "aleo"
  | "quantus"
  | "generic";

export interface ChainInfo {
  key: string;
  name: string;
  family: ChainFamily;
  /** EVM chain ID, when the chain is an EVM network. */
  evmChainId?: number;
  /** Transaction link template. `{hash}` is replaced with a validated hash. */
  txUrl?: string;
  /** Slow, Bitcoin-type chain: deposits get a longer deadline. */
  slow?: boolean;
  /** Deposits to exchanges on this chain often need a memo or tag. */
  memoChain?: boolean;
}

const list: ChainInfo[] = [
  { key: "bsc", name: "BNB Chain", family: "evm", evmChainId: 56, txUrl: "https://bscscan.com/tx/{hash}" },
  { key: "eth", name: "Ethereum", family: "evm", evmChainId: 1, txUrl: "https://etherscan.io/tx/{hash}" },
  { key: "base", name: "Base", family: "evm", evmChainId: 8453, txUrl: "https://basescan.org/tx/{hash}" },
  { key: "arb", name: "Arbitrum", family: "evm", evmChainId: 42161, txUrl: "https://arbiscan.io/tx/{hash}" },
  { key: "op", name: "Optimism", family: "evm", evmChainId: 10, txUrl: "https://optimistic.etherscan.io/tx/{hash}" },
  { key: "pol", name: "Polygon", family: "evm", evmChainId: 137, txUrl: "https://polygonscan.com/tx/{hash}" },
  { key: "avax", name: "Avalanche", family: "evm", evmChainId: 43114, txUrl: "https://snowtrace.io/tx/{hash}" },
  { key: "gnosis", name: "Gnosis", family: "evm", evmChainId: 100, txUrl: "https://gnosisscan.io/tx/{hash}" },
  { key: "bera", name: "Berachain", family: "evm", evmChainId: 80094, txUrl: "https://berascan.com/tx/{hash}" },
  { key: "monad", name: "Monad", family: "evm", evmChainId: 143 },
  { key: "xlayer", name: "X Layer", family: "evm", evmChainId: 196, txUrl: "https://www.oklink.com/xlayer/tx/{hash}" },
  { key: "plasma", name: "Plasma", family: "evm", evmChainId: 9745 },
  { key: "scroll", name: "Scroll", family: "evm", evmChainId: 534352, txUrl: "https://scrollscan.com/tx/{hash}" },
  { key: "hood", name: "Robinhood Chain", family: "evm" },
  { key: "adi", name: "ADI Chain", family: "evm", evmChainId: 36900 },
  { key: "hypercore", name: "Hyperliquid", family: "evm" },
  { key: "hlevm", name: "HyperEVM", family: "evm", evmChainId: 999 },
  { key: "sol", name: "Solana", family: "solana", txUrl: "https://solscan.io/tx/{hash}" },
  { key: "fogo", name: "Fogo", family: "solana" },
  { key: "near", name: "NEAR", family: "near", txUrl: "https://nearblocks.io/txns/{hash}" },
  { key: "btc", name: "Bitcoin", family: "bitcoin", slow: true, txUrl: "https://mempool.space/tx/{hash}" },
  { key: "ltc", name: "Litecoin", family: "litecoin", slow: true, txUrl: "https://blockchair.com/litecoin/transaction/{hash}" },
  { key: "doge", name: "Dogecoin", family: "dogecoin", slow: true, txUrl: "https://blockchair.com/dogecoin/transaction/{hash}" },
  { key: "bch", name: "Bitcoin Cash", family: "bitcoincash", slow: true, txUrl: "https://blockchair.com/bitcoin-cash/transaction/{hash}" },
  { key: "dash", name: "Dash", family: "dash", slow: true, txUrl: "https://blockchair.com/dash/transaction/{hash}" },
  { key: "zec", name: "Zcash", family: "zcash", slow: true, txUrl: "https://blockchair.com/zcash/transaction/{hash}" },
  { key: "tron", name: "Tron", family: "tron", txUrl: "https://tronscan.org/#/transaction/{hash}" },
  { key: "ton", name: "TON", family: "ton", memoChain: true, txUrl: "https://tonviewer.com/transaction/{hash}" },
  { key: "stellar", name: "Stellar", family: "stellar", memoChain: true, txUrl: "https://stellar.expert/explorer/public/tx/{hash}" },
  { key: "xrp", name: "XRP Ledger", family: "xrp", memoChain: true, txUrl: "https://xrpscan.com/tx/{hash}" },
  { key: "sui", name: "Sui", family: "sui", txUrl: "https://suiscan.xyz/mainnet/tx/{hash}" },
  { key: "aptos", name: "Aptos", family: "aptos", txUrl: "https://explorer.aptoslabs.com/txn/{hash}?network=mainnet" },
  { key: "movement", name: "Movement", family: "aptos" },
  { key: "starknet", name: "Starknet", family: "starknet", txUrl: "https://voyager.online/tx/{hash}" },
  { key: "cardano", name: "Cardano", family: "cardano", txUrl: "https://cardanoscan.io/transaction/{hash}" },
  { key: "aleo", name: "Aleo", family: "aleo" },
  { key: "qtc", name: "Quantus", family: "quantus" },
];

export const CHAINS: ReadonlyMap<string, ChainInfo> = new Map(list.map((c) => [c.key, c]));

/** Chains where Core supports paying from a connected wallet. One code path. */
export const WALLET_CHAINS = ["bsc", "eth", "base", "arb"] as const;
export type WalletChain = (typeof WALLET_CHAINS)[number];

export function isWalletChain(key: string): key is WalletChain {
  return (WALLET_CHAINS as readonly string[]).includes(key);
}

export function chainInfo(key: string): ChainInfo {
  return CHAINS.get(key) ?? { key, name: key.toUpperCase(), family: "generic" };
}

export function chainName(key: string): string {
  return chainInfo(key).name;
}

const HASH_SHAPE = /^[A-Za-z0-9+/=_-]{16,128}$/;

/** Builds an explorer link from our own templates, or null when we have none. */
export function explorerTxUrl(chainKey: string, hash: string): string | null {
  const template = CHAINS.get(chainKey)?.txUrl;
  if (!template || !HASH_SHAPE.test(hash)) return null;
  return template.replace("{hash}", encodeURIComponent(hash));
}

/**
 * A link to an address (or, with `token`, to a token's own page) on the explorer of a network a
 * wallet can pay on. Built from the same templates as the transaction links, so it can only point
 * at those explorers. Null for any other chain, and for anything that is not a 0x address.
 */
export function explorerAddressUrl(chainKey: string, address: string, kind: "address" | "token" = "address"): string | null {
  const template = CHAINS.get(chainKey)?.txUrl;
  if (!template || !isWalletChain(chainKey) || !/^0x[0-9a-fA-F]{40}$/.test(address) || !template.endsWith("/tx/{hash}")) return null;
  return `${template.slice(0, -"/tx/{hash}".length)}/${kind}/${address}`;
}

/** Hosts that explorer links may point to. Derived from the templates above. */
export const EXPLORER_HOSTS: ReadonlySet<string> = new Set(
  list.flatMap((c) => (c.txUrl ? [new URL(c.txUrl.replace("{hash}", "x")).host] : [])),
);

/**
 * A public node for each network a wallet can pay on. Two uses: the server reads the chain through
 * it when no other node is set, and a wallet that does not yet know a network is given it when
 * asked to add that network. Never an address that carries a key or a project's ID.
 */
export const WALLET_CHAIN_NODE: Record<WalletChain, string> = {
  bsc: "https://bsc-dataseed.bnbchain.org",
  eth: "https://ethereum-rpc.publicnode.com",
  base: "https://mainnet.base.org",
  arb: "https://arb1.arbitrum.io/rpc",
};

/**
 * The shape of any deposit address the provider may hand out, whatever the chain: what the server
 * accepts in a signed quote, and so what "Track order" must be able to find again.
 */
export const DEPOSIT_ADDRESS_SHAPE = /^[A-Za-z0-9:._+/=-]{20,128}$/;

/** Deposit details stop being shown this long before an order's deadline: a payment sent later may not arrive in time. */
export const DEPOSIT_CLOSE_MS = 2 * 60_000;

/**
 * How long a person has to pay after an order is made, after which refunds begin:
 * 30 minutes when paying from a connected wallet, 60 when sending by hand, 2 hours on slow chains.
 */
export function payWindowMs(pay: "wallet" | "manual", originChain: string): number {
  const MINUTE = 60_000;
  if (chainInfo(originChain).slow) return 120 * MINUTE;
  return pay === "wallet" ? 30 * MINUTE : 60 * MINUTE;
}

/**
 * How long a person has to SEND: the order's deadline less the two minutes in which the deposit
 * details are no longer shown. This is the time the pages name and count down to, so that nobody
 * reads those last two minutes as time in which to send.
 */
export function sendWindowMs(pay: "wallet" | "manual", originChain: string): number {
  return payWindowMs(pay, originChain) - DEPOSIT_CLOSE_MS;
}
