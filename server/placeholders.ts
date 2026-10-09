// The provider validates both addresses even on a price preview. Before a
// person has typed an address, a preview uses the fixed stand-in below.
//
// These are used for previews (dry quotes) ONLY. A real order is refused if
// either of its addresses equals a stand-in. Each one was checked against the
// live API on 8 Oct 2026; none is a wallet we control.

import { chainInfo, type ChainFamily } from "../shared/chains.ts";

const EVM = "0x1111111111111111111111111111111111111111";
const HEX32 = `0x${"11".repeat(32)}`;

const BY_FAMILY: Partial<Record<ChainFamily, string>> = {
  evm: EVM,
  solana: "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2",
  near: "11".repeat(32),
  bitcoin: "12ZEw5Hcv1hTb6YUQJ69y1V7uhcoDz92PH",
  litecoin: "LLnCCHbSzfwWquEdaS5TF2Yt7uz5Qb1SZ1",
  dogecoin: "D6hLULEGDRbk86j58t5iWmeinqM6acA16V",
  dash: "XcF5mKwWsiv3k394GBQNpYAuk3CVJ48Xnp",
  bitcoincash: "12ZEw5Hcv1hTb6YUQJ69y1V7uhcoDz92PH",
  zcash: "t1KRqwQhktLV4BjbNLiuH6pb3AMoszZKcQB",
  tron: "TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV",
  xrp: "rpZNAnHcvr6TbaY7QJa9yrVfu6coDz9pPH",
  stellar: "GAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCF6M",
  ton: "UQAREREREREREREREREREREREREREREREREREREREREREbvW",
  sui: HEX32,
  aptos: HEX32,
  starknet: `0x01${"11".repeat(31)}`,
  cardano: "addr1vyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygatvcjl",
  aleo: "aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc",
  quantus: "qzjqcX6UoeVpFp2Gscqt477KwiR9A2ss6RDgMLaxqCf3fA7rK",
};

const ALL = new Set(Object.values(BY_FAMILY).map((a) => a.toLowerCase()));

/** Stand-in address for a chain, or null when we have none (a preview then needs a real address). */
export function placeholderFor(chainKey: string): string | null {
  return BY_FAMILY[chainInfo(chainKey).family] ?? null;
}

/** True when an address is one of the preview stand-ins. Real orders must never use one. */
export function isPlaceholder(address: string): boolean {
  return ALL.has(address.toLowerCase());
}

export const PLACEHOLDER_FAMILIES = BY_FAMILY;
