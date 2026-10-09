// Reviewed list of coins that may be paid from a connected wallet.
//
// A wallet transfer is only ever built from an entry in this file. The
// provider's list is compared against it on every refresh, and each token
// contract's on-chain decimals() is compared too. Any difference disables the
// coin and raises an alert.
//
// To add a coin: confirm the contract address from the issuer's own site and
// the chain's explorer, confirm it is a plain token (no fee on transfer, no
// rebasing), then add it here in lower case.

import type { WalletChain } from "../shared/chains.ts";

export interface AllowedCoin {
  assetId: string;
  chain: WalletChain;
  /** Lower-case token contract. Null for the chain's native coin. */
  contractAddress: string | null;
  decimals: number;
  symbol: string;
  name: string;
  /** File name under web/public/coins, without extension. */
  icon: string;
}

export const ALLOWLIST: readonly AllowedCoin[] = [
  // BNB Chain
  { assetId: "nep245:v2_1.omni.hot.tg:56_11111111111111111111", chain: "bsc", contractAddress: null, decimals: 18, symbol: "BNB", name: "BNB", icon: "bnb" },
  { assetId: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g", chain: "bsc", contractAddress: "0x55d398326f99059ff775485246999027b3197955", decimals: 18, symbol: "USDT", name: "Tether USD", icon: "usdt" },
  { assetId: "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r", chain: "bsc", contractAddress: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18, symbol: "USDC", name: "USD Coin", icon: "usdc" },

  // Ethereum
  { assetId: "nep141:eth.omft.near", chain: "eth", contractAddress: null, decimals: 18, symbol: "ETH", name: "Ethereum", icon: "eth" },
  { assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", chain: "eth", contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, symbol: "USDT", name: "Tether USD", icon: "usdt" },
  { assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", chain: "eth", contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, symbol: "USDC", name: "USD Coin", icon: "usdc" },
  { assetId: "nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near", chain: "eth", contractAddress: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18, symbol: "DAI", name: "Dai", icon: "dai" },
  { assetId: "nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near", chain: "eth", contractAddress: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8, symbol: "WBTC", name: "Wrapped Bitcoin", icon: "wbtc" },
  { assetId: "nep141:eth-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near", chain: "eth", contractAddress: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", decimals: 8, symbol: "cbBTC", name: "Coinbase Wrapped BTC", icon: "cbbtc" },
  { assetId: "nep141:eth-0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.omft.near", chain: "eth", contractAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", decimals: 18, symbol: "WETH", name: "Wrapped Ether", icon: "weth" },
  { assetId: "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near", chain: "eth", contractAddress: "0x514910771af9ca656af840dff83e8264ecf986ca", decimals: 18, symbol: "LINK", name: "Chainlink", icon: "link" },
  { assetId: "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near", chain: "eth", contractAddress: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", decimals: 18, symbol: "UNI", name: "Uniswap", icon: "uni" },
  { assetId: "nep141:eth-0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9.omft.near", chain: "eth", contractAddress: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", decimals: 18, symbol: "AAVE", name: "Aave", icon: "aave" },

  // Base
  { assetId: "nep141:base.omft.near", chain: "base", contractAddress: null, decimals: 18, symbol: "ETH", name: "Ethereum", icon: "eth" },
  { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", chain: "base", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, symbol: "USDC", name: "USD Coin", icon: "usdc" },
  { assetId: "nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near", chain: "base", contractAddress: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", decimals: 8, symbol: "cbBTC", name: "Coinbase Wrapped BTC", icon: "cbbtc" },
  { assetId: "nep141:base-0x4200000000000000000000000000000000000006.omft.near", chain: "base", contractAddress: "0x4200000000000000000000000000000000000006", decimals: 18, symbol: "WETH", name: "Wrapped Ether", icon: "weth" },

  // Arbitrum
  { assetId: "nep141:arb.omft.near", chain: "arb", contractAddress: null, decimals: 18, symbol: "ETH", name: "Ethereum", icon: "eth" },
  { assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", chain: "arb", contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6, symbol: "USDC", name: "USD Coin", icon: "usdc" },
  { assetId: "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near", chain: "arb", contractAddress: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6, symbol: "USDT0", name: "USDT0", icon: "usdt" },
  { assetId: "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near", chain: "arb", contractAddress: "0x912ce59144191c1204e64559fe8253a0e49e6548", decimals: 18, symbol: "ARB", name: "Arbitrum", icon: "arb" },
  { assetId: "nep141:arb-0x82af49447d8a07e3bd95bd0d56f35241523fbab1.omft.near", chain: "arb", contractAddress: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", decimals: 18, symbol: "WETH", name: "Wrapped Ether", icon: "weth" },
];

export const ALLOWLIST_BY_ID: ReadonlyMap<string, AllowedCoin> = new Map(ALLOWLIST.map((c) => [c.assetId, c]));

/** Display names for coins that are not on the wallet allowlist. Keyed by symbol. */
export const COIN_NAMES: Readonly<Record<string, string>> = {
  BNB: "BNB",
  ETH: "Ethereum",
  WETH: "Wrapped Ether",
  BTC: "Bitcoin",
  WBTC: "Wrapped Bitcoin",
  wBTC: "Wrapped Bitcoin",
  cbBTC: "Coinbase Wrapped BTC",
  xBTC: "xBTC",
  hemiBTC: "Hemi Bitcoin",
  SOL: "Solana",
  USDT: "Tether USD",
  USDT0: "USDT0",
  USDC: "USD Coin",
  USDCx: "USDCx",
  sUSDC: "Savings USDC",
  DAI: "Dai",
  xDAI: "xDAI",
  USD1: "USD1",
  USDe: "Ethena USDe",
  USDf: "Falcon USD",
  USDG: "Global Dollar",
  USAD: "USAD",
  FRAX: "Frax",
  EURe: "Monerium EUR",
  GBPe: "Monerium GBP",
  XAUT: "Tether Gold",
  ZEC: "Zcash",
  NEAR: "NEAR",
  wNEAR: "Wrapped NEAR",
  stNEAR: "Staked NEAR",
  DOGE: "Dogecoin",
  LTC: "Litecoin",
  BCH: "Bitcoin Cash",
  DASH: "Dash",
  XRP: "XRP",
  TRX: "TRON",
  GRAM: "Toncoin",
  TON: "Toncoin",
  XLM: "Stellar Lumens",
  SUI: "Sui",
  APT: "Aptos",
  ADA: "Cardano",
  STRK: "Starknet",
  ALEO: "Aleo",
  MOVE: "Movement",
  BERA: "Berachain",
  MON: "Monad",
  OKB: "OKB",
  XPL: "Plasma",
  POL: "Polygon",
  AVAX: "Avalanche",
  OP: "Optimism",
  ARB: "Arbitrum",
  GNO: "Gnosis",
  COW: "CoW Protocol",
  SAFE: "Safe",
  LINK: "Chainlink",
  UNI: "Uniswap",
  AAVE: "Aave",
  GMX: "GMX",
  KNC: "Kyber Network",
  PEPE: "Pepe",
  SHIB: "Shiba Inu",
  TURBO: "Turbo",
  MOG: "Mog Coin",
  SPX: "SPX6900",
  BRETT: "Brett",
  $WIF: "dogwifhat",
  BOME: "Book of Meme",
  TRUMP: "Official Trump",
  MELANIA: "Melania",
  PENGU: "Pudgy Penguins",
  AURORA: "Aurora",
  SWEAT: "Sweat Economy",
  HAPI: "HAPI",
  INX: "Infinex",
  ADI: "ADI",
  ASTER: "Aster",
  RHEA: "Rhea",
  EVAA: "EVAA",
  KAITO: "Kaito",
  VVV: "Venice",
  COCA: "COCA",
  FOGO: "Fogo",
  QTC: "Quantus",
  nrUsdt: "Rhea USDT",
  mpDAO: "Meta Pool DAO",
  CFI: "ConsumerFi",
  LOUD: "Loud",
  TITN: "Titan",
  PONS: "Pons",
  CASHCAT: "Cash Cat",
};
