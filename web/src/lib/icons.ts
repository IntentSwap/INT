// Which coin and chain icons are bundled with the site. Anything else falls
// back to the first two letters on a plain tile. The lists are checked against
// the files on disk by a test.

export const COIN_ICONS: ReadonlySet<string> = new Set(
  "aave ada adi aleo apt arb aurora avax bch bera bnb btc cow dai dash doge eth eure fogo frax gmx gno gram hapi knc link ltc mog mon move okb op pepe pol safe shib sol spx strk sui sweat trx uni usdc usde usdt usdt0 wbtc weth xaut xdai xlm xpl xrp zec".split(" "),
);

export const CHAIN_ICONS: ReadonlySet<string> = new Set(
  "adi aleo aptos arb avax base bch bera bsc btc cardano dash doge eth fogo gnosis hlevm hood hypercore ltc monad movement op plasma pol scroll sol starknet stellar sui ton tron xlayer xrp zec".split(" "),
);

export function coinIconUrl(symbol: string): string | null {
  const key = symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
  return COIN_ICONS.has(key) ? `/coins/${key}.svg` : null;
}

export function chainIconUrl(chain: string): string | null {
  return CHAIN_ICONS.has(chain) ? `/chains/${chain}.svg` : null;
}

/** Two letters for the fallback tile. */
export function initials(text: string): string {
  const letters = text.replace(/[^A-Za-z0-9]/g, "");
  return (letters.slice(0, 2) || "?").toUpperCase();
}
