// The Rewards page's sign-in, step by step, with a wallet made up for the test: a connection that
// is still being restored, a wallet on a network this site does not use, a person who says no,
// and a wallet that cannot be reached.

import { describe, expect, it } from "vitest";
import { failureOf, raisedName, SIGN_IN_WORDS, SignInError, signInWith, type SignInWallet } from "../web/src/lib/sign-in-logic.ts";

/** What a made-up wallet was asked, in order. */
interface Told {
  calls: string[];
}

function wallet(parts: Partial<SignInWallet> & { states?: string[] } = {}): SignInWallet & Told {
  const calls: string[] = [];
  const states = parts.states ?? ["connected"];
  let at = 0;
  return {
    calls,
    status: parts.status ?? (() => states[Math.min(at, states.length - 1)]!),
    settled: async () => {
      calls.push("settled");
      // Coming to rest moves a connection that was being restored on to what it becomes.
      if (["connecting", "reconnecting"].includes(states[Math.min(at, states.length - 1)]!)) at += 1;
      await parts.settled?.();
    },
    connect: async () => {
      calls.push("connect");
      at += 1;
      await parts.connect?.();
    },
    direct: async () => {
      calls.push("direct");
      return parts.direct ? parts.direct() : "0xsigned";
    },
    ask: async () => {
      calls.push("ask");
      return parts.ask ? parts.ask() : "0xasked";
    },
  };
}

/** An error as a wallet library raises one: a name, perhaps a code, perhaps a cause. */
const raised = (name: string, more: { code?: unknown; message?: string; cause?: unknown } = {}) => Object.assign(new Error(more.message ?? name), { name, ...more });

describe("the Rewards sign-in, step by step", () => {
  it("a connected wallet is asked once, the library's own way", async () => {
    const w = wallet();
    expect(await signInWith(w)).toBe("0xsigned");
    expect(w.calls).toEqual(["settled", "direct"]);
  });

  it("a wallet on a network this site does not use still signs in: the library stops at the network, the wallet is asked directly, and nothing asks it to change network", async () => {
    // What the library raises when the wallet's network is not the one it has on record, before it has asked the wallet anything.
    const w = wallet({ direct: () => Promise.reject(raised("ConnectorChainMismatchError", { message: "The current chain of the connector (id: 137) does not match the connection's chain (id: 8453)." })) });
    expect(await signInWith(w)).toBe("0xasked");
    // The whole of what was asked of the wallet: no connecting again, and no way to ask for a network exists in the steps at all.
    expect(w.calls).toEqual(["settled", "direct", "ask"]);
    expect(Object.keys(w).sort()).toEqual(["ask", "calls", "connect", "direct", "settled", "status"]);
  });

  it("an address on the page from a connection that is still being restored: the sign-in waits for it, and then asks", async () => {
    const w = wallet({ states: ["reconnecting", "connected"] });
    expect(await signInWith(w)).toBe("0xsigned");
    expect(w.calls).toEqual(["settled", "direct"]);
    // Restored into a state the library cannot sign from ("getChainId is not a function"): the wallet is asked directly.
    const half = wallet({ direct: () => Promise.reject(new TypeError("connection.connector.getChainId is not a function")) });
    expect(await signInWith(half)).toBe("0xasked");
  });

  it("where the restoring comes to nothing, the person is asked to connect, and the sign-in goes on from there; if they do not, it says so", async () => {
    const w = wallet({ states: ["reconnecting", "disconnected", "connected"] });
    expect(await signInWith(w)).toBe("0xsigned");
    expect(w.calls).toEqual(["settled", "connect", "settled", "direct"]);
    const left = wallet({ states: ["disconnected", "disconnected"] });
    await expect(signInWith(left)).rejects.toMatchObject({ kind: "failed", raised: "NotConnected" });
    expect(left.calls).toEqual(["settled", "connect", "settled"]);
  });

  it("a person who says no is never asked a second time", async () => {
    for (const no of [raised("UserRejectedRequestError", { code: 4001 }), raised("ProviderRpcError", { code: 4001, message: "User rejected the request." }), raised("TransactionExecutionError", { cause: raised("Error", { code: 4001 }) }), raised("Error", { message: "User denied message signature" })]) {
      const w = wallet({ direct: () => Promise.reject(no) });
      await expect(signInWith(w)).rejects.toMatchObject({ kind: "refused" });
      expect(w.calls).toEqual(["settled", "direct"]);
    }
    // Nor does a "no" to the direct asking turn into anything else.
    const w = wallet({ direct: () => Promise.reject(raised("ConnectorChainMismatchError")), ask: () => Promise.reject(raised("ProviderRpcError", { code: 4001 })) });
    await expect(signInWith(w)).rejects.toMatchObject({ kind: "refused" });
  });

  it("tells a wallet that is locked or gone from one that could not be asked, and names what was raised without anything a wallet wrote", async () => {
    const locked = wallet({ direct: () => Promise.reject(raised("ResourceUnavailableRpcError", { code: -32002, message: "Request of type 'personal_sign' already pending" })), ask: () => Promise.reject(raised("ProviderRpcError", { code: -32002 })) });
    await expect(signInWith(locked)).rejects.toMatchObject({ kind: "locked", raised: "ResourceUnavailableRpcErrorThenProviderRpcError" });
    const other = wallet({ direct: () => Promise.reject(raised("ConnectorAccountNotFoundError", { message: "Account 0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83 not found" })), ask: () => Promise.reject(new Error("The connection has no wallet to ask.")) });
    const failure = (await signInWith(other).catch((error: unknown) => error)) as SignInError;
    expect(failure).toBeInstanceOf(SignInError);
    expect(failure).toMatchObject({ kind: "failed", raised: "ConnectorAccountNotFoundErrorThenError" });
    // What is logged is the names alone: no address, and nothing else of what the wallet or the library wrote.
    expect(failure.raised).toMatch(/^[A-Za-z]+$/);
    expect(raisedName(raised("0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83 <b>"))).toBe("xbdFEDebeDDCeAFcDeCb");
    expect(raisedName("not an error")).toBe("Unknown");
    expect(failureOf(raised("ProviderDisconnectedError", { code: 4900 }))).toBe("locked");
    expect(failureOf(raised("Error", { message: "Wallet is locked" }))).toBe("locked");
    expect(failureOf(raised("Error"))).toBe("failed");
    expect(failureOf(null)).toBe("failed");
  });

  it("says one of three things, and none of them blames the person for what a wallet did", () => {
    expect(SIGN_IN_WORDS).toEqual({
      refused: "Nothing was signed, so you are not signed in.",
      locked: "Open your wallet and unlock it, then sign in again.",
      failed: "The wallet could not be asked to sign. Reconnect it and try again.",
    });
  });
});
