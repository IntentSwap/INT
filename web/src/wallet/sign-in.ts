// The one place on this site where a wallet is asked to sign anything: the sign-in of the Rewards
// page, by which a person shows that an address is theirs before its points are shown to them.
// It is one plain message, made by the server and shown by the wallet in words. It is not a
// transaction: it moves nothing, approves nothing and costs no network fee.
//
// This is the one exception to "the wallet is asked for one plain transfer
// only". It is kept to this module, which nothing but the Rewards page's own store uses, and a
// test holds it there: paying for a swap never asks for a signature.

import { signMessage } from "@wagmi/core";
import { walletConfig } from "./index.ts";

/** Asks the connected wallet to sign the server's sign-in message with the given address, and returns the signature. */
export async function signPlainMessage(message: string, address: string): Promise<string> {
  return signMessage(await walletConfig(), { message, account: address as `0x${string}` });
}
