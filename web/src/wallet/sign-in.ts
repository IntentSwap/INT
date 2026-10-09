// The one place on this site where a wallet is asked to sign anything: the sign-in of the Rewards
// page, by which a person shows that an address is theirs before its points are shown to them.
// It is one plain message, made by the server and shown by the wallet in words. It is not a
// transaction: it moves nothing, approves nothing and costs no network fee.
//
// This is the one exception to "the wallet is asked for one plain transfer
// only". It is kept to this module, which nothing but the Rewards page's own store uses, and a
// test holds it there: paying for a swap never asks for a signature.
//
// The steps are in lib/sign-in-logic.ts: a connection being restored is waited for, the wallet is
// asked on whatever network it is on, and it is never asked to change network to sign in.

import { getAccount, signMessage, watchAccount, type Config } from "@wagmi/core";
import { stringToHex } from "viem";
import { signInWith } from "../lib/sign-in-logic.ts";
import { connect, walletConfig } from "./index.ts";
import { SIGN_IN_METHOD } from "./session.ts";

/** How long a connection that is being restored is waited for before the sign-in goes on without it. */
const SETTLE_MS = 8000;

/** Resolves once the connection is neither being made nor being restored. */
function settled(config: Config): Promise<void> {
  const moving = () => ["connecting", "reconnecting"].includes(getAccount(config).status);
  if (!moving()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    const timer = setTimeout(done, SETTLE_MS);
    const stop = watchAccount(config, { onChange: () => (moving() ? undefined : done()) });
  });
}

/** The wallet of the current connection, asked for the one signature directly: no network is named, and none is asked for. */
async function askConnection(config: Config, message: string, address: string): Promise<string> {
  const connection = config.state.current === null ? undefined : config.state.connections.get(config.state.current);
  const provider = (await connection?.connector.getProvider()) as { request?: (asked: { method: string; params: unknown[] }) => Promise<unknown> } | undefined;
  if (provider === undefined || typeof provider.request !== "function") throw new Error("The connection has no wallet to ask.");
  const signature = await provider.request({ method: SIGN_IN_METHOD, params: [stringToHex(message), address] });
  if (typeof signature !== "string") throw new Error("The wallet answered with no signature.");
  return signature;
}

/**
 * Asks the connected wallet to sign the server's sign-in message with the given address, and returns
 * the signature. `plain` is the same sign-in in plain sentences, made by the server for the same
 * code: a wallet that throws the message out as invalid, unseen, is asked to sign that instead.
 */
export async function signPlainMessage(message: string, address: string, plain: string | null = null): Promise<string> {
  const config = await walletConfig();
  return signInWith({
    status: () => getAccount(config).status,
    settled: () => settled(config),
    connect,
    direct: () => signMessage(config, { message, account: address as `0x${string}` }),
    ask: () => askConnection(config, message, address),
    askPlain: plain === null ? null : () => askConnection(config, plain, address),
  });
}
