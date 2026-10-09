// Which coin and chain icons are bundled with the site. A coin or a chain with none is drawn as
// one plain shape, the same for all (see CoinIcon). The lists are checked against the files on
// disk by a test.

export const COIN_ICONS: ReadonlySet<string> = new Set(
  "aave ada adi aleo apt arb aurora avax bch bera bnb btc cow dai dash doge eth eure fogo frax gmx gno gram hapi knc link ltc mog mon move okb op pepe pol safe shib sol spx strk sui sweat trx uni usdc usde usdt usdt0 wbtc weth xaut xdai xlm xpl xrp zec".split(" "),
);

export const CHAIN_ICONS: ReadonlySet<string> = new Set(
  "adi aleo aptos arb avax base bch bera bsc btc cardano dash doge eth fogo gnosis hlevm hood hypercore ltc monad movement op plasma pol scroll sol starknet stellar sui ton tron xlayer xrp zec".split(" "),
);

/**
 * Logos made by scripts/make-coin-icons.ts, each named for one coin by its chain and its contract
 * (see coinKey), never by its symbol: a coin that only shares a symbol with one of these is another
 * coin, and is not given its logo. A chain's own coin is its chain alone. The same asset issued on
 * several chains is listed once for each.
 */
export const COIN_LOGOS: Readonly<Record<string, string>> = {
  "bsc:0x000ae314e2a2172a039b26378814c252734f556a": "aster",
  "sol:ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82": "bome",
  "base:0x532f27101965dd16442e59d40670faf5ebb142e4": "brett",
  "hood:0x020bfc650a365f8bb26819deaabf3e21291018b4": "cashcat",
  "bsc:0xaa036928c9c0df07d525b55ea8ee690bb5a628c1": "evaa",
  "base:0x98d0baa52b2d063e780de12f615f963fe8537553": "kaito",
  "sol:FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P": "melania",
  // NEAR itself: the chain's own coin, its wrapped form on its own chain, and the one issued on BNB Chain.
  "near:": "near",
  "near:wrap.near": "near",
  "bsc:0x1fa4a73a3f0133f0025378af00236f3abdee5d63": "near",
  "sol:2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv": "pengu",
  "sol:6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN": "trump",
  // Turbo on NEAR is the Ethereum token held by the bridge: its contract there is the Ethereum address itself.
  "eth:0xa35923162c49cf95e6bf26623385eb431ad920d3": "turbo",
  "sol:2Dyzu65QA9zdX1UeE7Gx71k7fiwyUK6sZdrvJ7auq5wm": "turbo",
  "near:a35923162c49cf95e6bf26623385eb431ad920d3.factory.bridge.near": "turbo",
  "eth:0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d": "usd1",
  "sol:USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB": "usd1",
  "eth:0xfa2b947eec368f42195f24f36d2af29f7c24cec2": "usdf",
  "base:0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf": "vvv",
  "sol:EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "wif",
};

/** Chains whose mark is one of the pictures made by the same script. */
export const CHAIN_LOGOS: ReadonlySet<string> = new Set(["near"]);

/**
 * How a coin is named in the list of logos: its chain and its contract (nothing after the colon
 * for a chain's own coin). An address written in hexadecimal is the same address in capitals or
 * small letters; any other kind is kept as written.
 */
export function coinKey(chain: string, contract: string | null): string {
  const address = contract ?? "";
  return `${chain}:${/^0x[0-9a-fA-F]+$/.test(address) ? address.toLowerCase() : address}`;
}

/**
 * The icon of a coin: the logo listed for its chain and contract, or else the reviewed drawing
 * its symbol names. Null when the site has neither. Where the contract is not known (it is not
 * given at all, which is not the same as a chain's own coin having none), only the symbol is used.
 */
export function coinIconUrl(symbol: string, chain?: string, contract?: string | null): string | null {
  const logo = chain === undefined || (contract !== null && typeof contract !== "string") ? undefined : COIN_LOGOS[coinKey(chain, contract)];
  if (logo !== undefined) return `/coins/${logo}.webp`;
  const key = symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
  return COIN_ICONS.has(key) ? `/coins/${key}.svg` : null;
}

/**
 * The name of the logo listed for a coin, if there is one. The list of orders kept in the browser
 * holds this name in place of the coin's contract (it keeps no address of any kind).
 */
export function coinLogoName(chain: string, contract: string | null): string | undefined {
  return COIN_LOGOS[coinKey(chain, contract)];
}

const LOGO_NAMES: ReadonlySet<string> = new Set(Object.values(COIN_LOGOS));

/** The picture a logo's name stands for. Null for a name that is none of the logos (what a browser's storage holds is not trusted). */
export function logoUrl(name: string | undefined): string | null {
  return name !== undefined && LOGO_NAMES.has(name) ? `/coins/${name}.webp` : null;
}

export function chainIconUrl(chain: string): string | null {
  if (CHAIN_LOGOS.has(chain)) return `/chains/${chain}.webp`;
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
