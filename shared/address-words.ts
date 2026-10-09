// The words shown for each address problem. Shared by the server and the interface so they never drift apart.

import type { AddressError } from "./addresses.ts";
import { chainName } from "./chains.ts";

/**
 * What happened, then what to do, naming the chain. Each fits on one line under an address
 * field on a wide screen, and on two on a phone, with the longest chain name: the room for it
 * is kept free there, and a longer sentence would push the page down.
 */
const WORDS: Record<AddressError, (chain: string) => string> = {
  empty: (chain) => `Enter ${article(chain)} ${chain} address.`,
  format: (chain) => `That is not ${article(chain)} ${chain} address. Check it.`,
  checksum: (chain) => `That ${chain} address has a typo. Check it.`,
  burn: () => "That address can't receive funds. Enter a wallet address.",
  zcash_shielded: () => "Use a transparent Zcash address. It starts with t1 or t3.",
  xrp_tag: () => "This XRP address needs a tag, which isn't supported.",
  stellar_muxed: () => "This Stellar address has a memo, which isn't supported.",
  testnet: (chain) => `That is a test address. Enter ${article(chain)} ${chain} address.`,
};

/** When the text is a valid address for another chain, say which, and which chain is wanted. */
export function addressMessage(chainKey: string, error: AddressError, looksLike: string | null): string {
  const chain = chainName(chainKey);
  if (looksLike !== null) return `This address is for ${looksLike}. Enter ${article(chain)} ${chain} address.`;
  return WORDS[error](chain);
}

function article(word: string): string {
  return /^[AEIOX]/.test(word) && !/^(Uni|Eu)/.test(word) ? "an" : "a";
}
