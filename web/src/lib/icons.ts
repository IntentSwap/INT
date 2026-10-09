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

/** The tone a chain is given where its mark has no colour of its own, or none that would show: a neutral grey. */
const NO_COLOUR = "#8b919b";

/**
 * A chain's own colour, taken from its mark. The picker washes a chain's tile with it, very
 * faintly. A wash has to show on a dark card and on a light one alike, so a mark that is black is
 * given the neutral grey, and a mark on a very dark ground is given the lighter tone the chain
 * itself uses. A test holds this list to the chain list: every chain has an entry.
 */
export const CHAIN_COLOURS: Readonly<Record<string, string>> = {
  bsc: "#f3ba2f",
  eth: "#627eea",
  base: "#0052ff",
  arb: "#28a0f0",
  op: "#fe0420",
  pol: "#7b3fe4",
  avax: "#e84142",
  gnosis: "#3e6957",
  bera: "#fb9942",
  monad: "#836ef9",
  xlayer: NO_COLOUR,
  plasma: "#499c88",
  scroll: NO_COLOUR,
  hood: "#ccff00",
  adi: "#fe7109",
  hypercore: "#50d2c1",
  hlevm: "#50d2c1",
  sol: "#9945ff",
  fogo: "#ff3d00",
  near: NO_COLOUR,
  btc: "#f7931a",
  ltc: "#345d9d",
  doge: "#e1b051",
  bch: "#58be92",
  dash: "#008de4",
  zec: "#ecb244",
  tron: "#c4342b",
  ton: "#0098ea",
  stellar: NO_COLOUR,
  xrp: NO_COLOUR,
  sui: "#4ba2ff",
  aptos: NO_COLOUR,
  movement: "#fbda4f",
  starknet: "#ec796b",
  cardano: "#246dd3",
  aleo: NO_COLOUR,
  qtc: NO_COLOUR,
};

/** The colour a chain's tile is washed with. A chain this site has not met yet gets the neutral grey. */
export function chainColour(chain: string): string {
  return CHAIN_COLOURS[chain] ?? NO_COLOUR;
}

/** Two letters for the fallback tile. */
export function initials(text: string): string {
  const letters = text.replace(/[^A-Za-z0-9]/g, "");
  return (letters.slice(0, 2) || "?").toUpperCase();
}
