// Facts the wider pages show (home, docs), kept apart from how they are drawn so they can be tested.

import type { TokenView } from "../../../shared/api.ts";
import { chainInfo, chainName } from "../../../shared/chains.ts";
import { CHAIN_ORDER } from "../config.ts";

export interface Feature {
  key: "swaps" | "tracking" | "rewards" | "ghost" | "token";
  title: string;
  text: string;
  /** Where to go to use it or to read more. */
  link: { href: string; label: string };
}

/**
 * True where the server routes swaps privately (its PRIVACY_MODE is "basic"). Whatever the site
 * says of private swaps, it says only where this is true; everywhere else it reads as it always has.
 *
 * The server's settings decide. Until they have arrived, the page's own mark is read: the server
 * writes it into the page it serves where private routing is in force (server/static.ts), so the
 * first words on screen are already the right ones and nothing changes when the settings come.
 * The settings are typed loosely on purpose: an answer without the field reads as public.
 */
export function isPrivateMode(config: { privacyMode?: unknown } | null | undefined): boolean {
  if (config === null || config === undefined) return typeof document !== "undefined" && document.documentElement.dataset.routing === "private";
  return config.privacyMode === "basic";
}

/**
 * What IntentSwap does: each item is something that works on the site today. The token is among
 * them only once its contract address has been set on the server; until then it is simply not on
 * the list. Nothing here is a plan.
 *
 * Where swaps are routed privately the first item says so. Where they are not, the list is the one
 * it always was. What is said of points is the same either way: a privately routed swap adds them
 * as any other does.
 *
 * Ghost mode is on the list everywhere: its switch is in the header however swaps are routed. What
 * is said of it here is what it does and, in the last sentence, the first thing it does not.
 */
export function features(tokenSet: boolean, privateRouting = false): readonly Feature[] {
  const all: Feature[] = [
    privateRouting
      ? { key: "swaps", title: "Private cross-chain swaps", text: "Swap a coin on one chain for a coin on another. Swaps are routed with NEAR Intents' confidential routing, so what you send and what you receive are not tied to each other in public records. Every fee is shown before you confirm.", link: { href: "/docs/private", label: "How private routing works" } }
      : { key: "swaps", title: "Cross-chain swaps", text: "Swap a coin on one chain for a coin on another. Quotes, orders and delivery run on NEAR Intents, and every fee is shown before you confirm.", link: { href: "/docs", label: "How a swap works" } },
    { key: "tracking", title: "Order tracking and automatic refunds", text: "Every order has its own page, which follows the deposit, the swap and the delivery. If a swap fails, the provider sends your coins back to your refund address.", link: { href: "/track", label: "Track an order" } },
    { key: "rewards", title: "Points and weekly rewards", text: "Each delivered swap adds points to the wallet behind it: 10 for each $1 swapped. Each week a payout is shared out by points. Payouts are at IntentSwap's discretion and can change.", link: { href: "/rewards", label: "See your points" } },
    { key: "ghost", title: "Ghost mode", text: "One switch in the header. While it is on, the site loads no wallet and keeps nothing in your browser but the switch itself, and deletes your order's record once it is delivered or refunded. Your deposit and your delivery are still public on-chain.", link: { href: "/docs/ghost-mode", label: "How Ghost mode works" } },
  ];
  if (tokenSet) all.push({ key: "token", title: "The $INT token", text: "The token's contract address, its chain and its trading pair are shown on this site, each with a link to the chain's own explorer.", link: { href: "/token", label: "The token's facts" } });
  return all;
}

/**
 * "What private means here": the three rows the home page shows where swaps are routed privately,
 * and only there. They say what the provider itself says of its confidential routing and no more:
 * the two ends of a swap are public, the link between them is not in public records, and nobody
 * promises that it stays so.
 */
export const PRIVATE_MEANS: readonly { label: string; text: string }[] = [
  { label: "Still public", text: "Your deposit on the chain you send from, its amount and the wallet it came from; the delivery on the chain you receive on." },
  { label: "Not public", text: "The link between your deposit and your delivery. The swap is processed with NEAR Intents' confidential routing, so the two are not tied to each other in public records." },
  { label: "Who can see it", text: "The provider's confidential system, us for what is needed to run your order, and anyone who has the order's link: its page shows both ends. Private routing is not anonymity and no route guarantees it: amounts and timing can still give hints, and the provider does not promise complete confidentiality." },
];

export type SocialKey = "dexscreener" | "github" | "x";

/**
 * The three icon links, in the order they are shown: DexScreener, GitHub, X. Each has the name read
 * aloud for it and the address it leads to. The address is null while the server has none set, and
 * also for anything that is not an https link: the icon is then shown and leads nowhere.
 */
export function socialLinks(config: { dexscreenerUrl?: string | null; githubUrl?: string | null; xUrl?: string | null } | null): { key: SocialKey; label: string; href: string | null }[] {
  const safe = (value: string | null | undefined) => (typeof value === "string" && /^https:\/\/[^\s"'<>]+$/.test(value) ? value : null);
  return [
    { key: "dexscreener", label: "IntentSwap on DexScreener", href: safe(config?.dexscreenerUrl) },
    { key: "github", label: "IntentSwap on GitHub", href: safe(config?.githubUrl) },
    { key: "x", label: "IntentSwap on X", href: safe(config?.xUrl) },
  ];
}

/** How many coins and chains a coin list holds. Null for an empty list: no number is better than a wrong one. */
export function listCounts(tokens: readonly Pick<TokenView, "chain">[]): { coins: number; chains: number } | null {
  return tokens.length === 0 ? null : { coins: tokens.length, chains: new Set(tokens.map((token) => token.chain)).size };
}

/** The chains on a coin list, each with how many of its coins can be swapped, in the order the picker offers them. */
export function chainsOnList(tokens: readonly Pick<TokenView, "chain">[]): { key: string; name: string; coins: number; slow: boolean }[] {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token.chain, (counts.get(token.chain) ?? 0) + 1);
  const rank = (key: string) => {
    const index = (CHAIN_ORDER as readonly string[]).indexOf(key);
    return index === -1 ? CHAIN_ORDER.length : index;
  };
  return [...counts.entries()]
    .map(([key, coins]) => ({ key, name: chainName(key), coins, slow: chainInfo(key).slow === true }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.name.localeCompare(b.name));
}
