import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WALLET_CHAIN_NODE } from "../shared/chains.ts";
import { PAY_METHODS, sessionRights, SIGN_IN_METHOD, WALLET_METHODS, WINDOW_FEATURES } from "../web/src/wallet/session.ts";
import { assertSameOrder, assertTransfer, buildTransfer, checkedTransfer, readTransfer, TRANSFER_SELECTOR, TransferError, type PlainTransfer } from "../web/src/wallet/transfer.ts";

const DEPOSIT = "0xae001C67DbdC649e76BD8f41A75D1D154423D8aD";
const OTHER = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const order = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "A".repeat(27),
    pay: "wallet",
    status: "waiting",
    depositsOpen: true,
    depositAddress: DEPOSIT,
    depositMemo: null,
    amountIn: "500000000000000000",
    from: { id: "base:ETH", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null },
    ...overrides,
  }) as never;
const token = (overrides: Record<string, unknown> = {}) => order({ amountIn: "25000000", from: { id: "base:USDC", symbol: "USDC", name: "USD Coin", chain: "base", decimals: 6, contract: USDC_BASE }, ...overrides });

describe("the one transfer a wallet is asked for", () => {
  it("is a plain payment of the exact amount to the deposit address, for the chain's own coin", () => {
    expect(buildTransfer(order())).toEqual({ chainId: 8453, to: DEPOSIT, value: 500000000000000000n, data: "0x" });
    expect(buildTransfer(order({ from: { chain: "bsc", contract: null } })).chainId).toBe(56);
    expect(buildTransfer(order({ from: { chain: "eth", contract: null } })).chainId).toBe(1);
    expect(buildTransfer(order({ from: { chain: "arb", contract: null } })).chainId).toBe(42161);
  });

  it("is transfer(depositAddress, amount) on the token's contract, with no coin sent along, for a token", () => {
    const tx = buildTransfer(token());
    expect(tx.to).toBe(USDC_BASE);
    expect(tx.value).toBe(0n);
    expect(tx.data).toBe(`0xa9059cbb${"0".repeat(24)}${DEPOSIT.slice(2).toLowerCase()}${(25000000n).toString(16).padStart(64, "0")}`);
    expect(tx.data).toHaveLength(138);
  });

  it("is never an approval, a permit or anything else: only the transfer selector is ever produced", () => {
    expect(TRANSFER_SELECTOR).toBe("0xa9059cbb");
    for (const built of [buildTransfer(order()), buildTransfer(token())]) expect(built.data === "0x" || built.data.startsWith("0xa9059cbb")).toBe(true);
    // approve(address,uint256), transferFrom, permit, increaseAllowance, setApprovalForAll: none can come out of the builder or pass the gate.
    for (const selector of ["0x095ea7b3", "0x23b872dd", "0xd505accf", "0x39509351", "0xa22cb465"]) {
      const forged: PlainTransfer = { chainId: 8453, to: USDC_BASE, value: 0n, data: `${selector}${"0".repeat(24)}${DEPOSIT.slice(2).toLowerCase()}${(25000000n).toString(16).padStart(64, "0")}` };
      expect(readTransfer(forged)).toBeNull();
      expect(() => assertTransfer(forged, token())).toThrow("not a plain transfer");
    }
  });

  it("is not built for an order that no longer takes a deposit, or for a chain a wallet cannot pay on", () => {
    expect(() => buildTransfer(order({ status: "deposit_seen" }))).toThrow(TransferError);
    expect(() => buildTransfer(order({ depositsOpen: false }))).toThrow("no longer taking a deposit");
    expect(() => buildTransfer(order({ depositAddress: null }))).toThrow("no longer taking a deposit");
    expect(() => buildTransfer(order({ from: { chain: "sol", contract: null } }))).toThrow("can't be paid from a connected wallet");
    expect(() => buildTransfer(order({ from: { chain: "btc", contract: null } }))).toThrow(TransferError);
  });

  it("is not built from anything malformed", () => {
    expect(() => buildTransfer(order({ depositAddress: "0x1234" }))).toThrow("deposit address");
    expect(() => buildTransfer(order({ depositAddress: `${DEPOSIT}00` }))).toThrow("deposit address");
    for (const amountIn of ["0", "", "-5", "1.5", "0x10", "1e18", " 1", "01"]) expect(() => buildTransfer(order({ amountIn })), amountIn).toThrow("amount");
    expect(() => buildTransfer(token({ from: { chain: "base", contract: "not-a-contract" } }))).toThrow("contract");
    // A token is never sent to its own contract.
    expect(() => buildTransfer(token({ depositAddress: USDC_BASE }))).toThrow("token's own contract");
  });
});

describe("the gate before the wallet opens", () => {
  it("passes the transfer built from the order", () => {
    expect(() => assertTransfer(buildTransfer(order()), order())).not.toThrow();
    expect(() => assertTransfer(buildTransfer(token()), token())).not.toThrow();
    expect(checkedTransfer(token(), token())).toEqual(buildTransfer(token()));
  });

  it("is not built for an order that was made to be paid by hand, or whose deposit needs a memo", () => {
    expect(() => buildTransfer(order({ pay: "manual" }))).toThrow("not made to be paid from a connected wallet");
    expect(() => buildTransfer(order({ depositMemo: "184467440737" }))).toThrow("needs a memo");
    expect(() => assertTransfer(buildTransfer(order()), order({ pay: "manual" }))).toThrow(TransferError);
    expect(() => assertTransfer(buildTransfer(order()), order({ depositMemo: "1" }))).toThrow(TransferError);
  });

  it("stops when the order the server now holds is not the one on screen", () => {
    const shown = order();
    // The same order, spelled differently, is the same order.
    expect(() => checkedTransfer(order({ depositAddress: DEPOSIT.toLowerCase() }), shown)).not.toThrow();
    expect(() => assertSameOrder(shown, order())).not.toThrow();
    const changes: Record<string, unknown>[] = [
      { id: "B".repeat(27) },
      { depositAddress: OTHER },
      { amountIn: "500000000000000001" },
      { from: { id: "eth:ETH", symbol: "ETH", name: "Ethereum", chain: "eth", decimals: 18, contract: null } },
      { from: { id: "base:USDC", symbol: "USDC", name: "USD Coin", chain: "base", decimals: 6, contract: USDC_BASE } },
      { from: { id: "base:ETH", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: USDC_BASE } },
    ];
    for (const change of changes) {
      expect(() => checkedTransfer(order(change), shown), JSON.stringify(change)).toThrow("changed since the page showed it");
      expect(() => checkedTransfer(shown, order(change)), JSON.stringify(change)).toThrow("changed since the page showed it");
    }
    // An order whose address has been withdrawn on either side is never "the same".
    expect(() => assertSameOrder(order({ depositAddress: null }), order({ depositAddress: null }))).toThrow(TransferError);
  });

  it("reads back what a transaction would really do", () => {
    expect(readTransfer(buildTransfer(order()))).toEqual({ recipient: DEPOSIT, amount: 500000000000000000n, token: null });
    expect(readTransfer(buildTransfer(token()))).toEqual({ recipient: DEPOSIT.toLowerCase(), amount: 25000000n, token: USDC_BASE });
  });

  it("stops a transaction that pays another address", () => {
    expect(() => assertTransfer({ ...buildTransfer(order()), to: OTHER }, order())).toThrow("pays another address");
    const redirected = buildTransfer(token({ depositAddress: OTHER }));
    expect(() => assertTransfer(redirected, token())).toThrow("pays another address");
  });

  it("stops a transaction for another amount, by even one unit", () => {
    expect(() => assertTransfer({ ...buildTransfer(order()), value: 500000000000000001n }, order())).toThrow("another amount");
    expect(() => assertTransfer({ ...buildTransfer(order()), value: 499999999999999999n }, order())).toThrow("another amount");
    expect(() => assertTransfer(buildTransfer(token({ amountIn: "25000001" })), token())).toThrow("another amount");
  });

  it("stops a transaction for another network", () => {
    expect(() => assertTransfer({ ...buildTransfer(order()), chainId: 1 }, order())).toThrow("another network");
    expect(() => assertTransfer({ ...buildTransfer(token()), chainId: 56 }, token())).toThrow("another network");
  });

  it("stops a transaction for another coin: a token where the coin is due, the coin where a token is due, or another token", () => {
    expect(() => assertTransfer(buildTransfer(token({ amountIn: "500000000000000000" })), order())).toThrow("another coin");
    expect(() => assertTransfer(buildTransfer(order({ amountIn: "25000000" })), token())).toThrow("another coin");
    expect(() => assertTransfer({ ...buildTransfer(token()), to: OTHER }, token())).toThrow("another coin");
  });

  it("stops anything that is not a plain transfer", () => {
    const good = buildTransfer(token());
    // Coin sent along with a token call, extra data after the two words, data too short, a dirty address word, no value at all.
    expect(() => assertTransfer({ ...good, value: 1n }, token())).toThrow("not a plain transfer");
    expect(() => assertTransfer({ ...good, data: `${good.data}00` }, token())).toThrow("not a plain transfer");
    expect(() => assertTransfer({ ...good, data: good.data.slice(0, -2) }, token())).toThrow("not a plain transfer");
    expect(() => assertTransfer({ ...good, data: `0xa9059cbb${"1".repeat(24)}${good.data.slice(34)}` }, token())).toThrow("not a plain transfer");
    expect(() => assertTransfer({ ...buildTransfer(order()), value: 0n }, order())).toThrow("not a plain transfer");
    expect(() => assertTransfer({ ...buildTransfer(order()), data: "0xdeadbeef" }, order())).toThrow("not a plain transfer");
    expect(() => assertTransfer({ ...good, to: "0x123" }, token())).toThrow("not a plain transfer");
  });

  it("compares addresses as addresses, so letter-case alone never stops a correct transfer", () => {
    expect(() => assertTransfer({ ...buildTransfer(order()), to: DEPOSIT.toLowerCase() }, order())).not.toThrow();
    expect(() => assertTransfer(buildTransfer(token()), token({ from: { chain: "base", contract: USDC_BASE.toUpperCase().replace("0X", "0x") } }))).not.toThrow();
  });

  it("is checked against the order as it is now: an order that has moved on stops everything", () => {
    const built = buildTransfer(order());
    expect(() => assertTransfer(built, order({ status: "expired" }))).toThrow("no longer taking a deposit");
    expect(() => assertTransfer(built, order({ depositsOpen: false, depositAddress: null }))).toThrow("no longer taking a deposit");
  });
});

describe("the way from the gate to the wallet", () => {
  const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
  const walletModule = path.resolve("web", "src", "wallet", "index.ts");
  const squeezed = (text: string) => text.replace(/\s+/g, " ");

  it("stops whatever the builder made, if it is not the order's one plain transfer", () => {
    const good = buildTransfer(order());
    const wrong: PlainTransfer[] = [
      { ...good, to: OTHER },
      { ...good, value: good.value + 1n },
      { ...good, chainId: 1 },
      // An approval of the same amount to the deposit address, where the plain payment is due.
      { chainId: 8453, to: USDC_BASE, value: 0n, data: `0x095ea7b3${DEPOSIT.slice(2).toLowerCase().padStart(64, "0")}${(500000000000000000n).toString(16).padStart(64, "0")}` },
    ];
    for (const tx of wrong) expect(() => checkedTransfer(order(), order(), () => tx)).toThrow(TransferError);
    // A token order, and a builder that makes an approval where the transfer is due.
    const approval = { ...buildTransfer(token()), data: buildTransfer(token()).data.replace(TRANSFER_SELECTOR, "0x095ea7b3") };
    expect(() => checkedTransfer(token(), token(), () => approval)).toThrow(TransferError);
    // What the real builder makes passes, and is handed back unchanged.
    expect(checkedTransfer(order(), order(), () => good)).toBe(good);
    expect(checkedTransfer(order(), order())).toEqual(good);
  });

  it("is the only way: one request to send, fed by what the gate passed, on the network it is for", () => {
    const source = fs.readFileSync(walletModule, "utf8");
    expect(source.match(/\bsendTransaction\(/g)).toHaveLength(1);
    expect(source.match(/\bcheckedTransfer\(/g)).toHaveLength(1);
    const pay = squeezed(source.slice(source.indexOf("export async function pay("), source.indexOf("export function wasRejected(")));
    expect(pay).toContain(
      'const tx = checkedTransfer(fresh, shown); if (getAccount(config).chainId !== tx.chainId) throw new Error("wrong network"); return sendTransaction(config, { chainId: tx.chainId, to: tx.to as `0x${string}`, value: tx.value, ...(tx.data === "0x" ? {} : { data: tx.data as `0x${string}` }) }); }',
    );
    // What the module takes from the wallet library: the account, connecting, changing network, and the one send. Nothing that signs,
    // and nothing that reads a balance: balances are read through the site's own chain route, with no wallet code at all.
    expect(source).toContain('import { disconnect as wagmiDisconnect, getAccount, sendTransaction, switchChain, watchAccount, type Config } from "@wagmi/core";');
  });

  it("is in one module: no other file of the site reaches a wallet library, or asks a wallet for anything, but for the one sign-in", () => {
    const root = path.resolve("web", "src");
    const signInModule = path.join(root, "wallet", "sign-in.ts");
    const files = sources(root);
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      if (file === walletModule || file === signInModule) continue;
      const text = fs.readFileSync(file, "utf8");
      const name = path.relative(root, file);
      expect(text, name).not.toMatch(/from "(@wagmi\/|wagmi|@reown\/|@walletconnect\/|viem|ethers)/);
      expect(text, name).not.toMatch(/\b(sendTransaction|sendCalls|writeContract|signMessage|signTypedData|signTransaction)\s*\(/);
      expect(text, name).not.toMatch(/\.request\(\s*\{/);
      expect(text, name).not.toMatch(/window\.ethereum/);
    }
  });

  it("the one signature this site asks for is the Rewards page's sign-in, and paying knows nothing of it", () => {
    // The one exception: one plain message, signed to show that an address is one's own.
    const root = path.resolve("web", "src");
    const read = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
    const signIn = read("wallet/sign-in.ts");
    // From the wallet library it takes the function that signs a plain message, and uses it once; beside it only what tells
    // whether a wallet is connected. Where that route stops short, the connection's own wallet is asked for the very same
    // signature, by the one method the sign-in is allowed, once. It never asks a wallet to change network.
    expect([...signIn.matchAll(/^import .*$/gm)].map((match) => match[0])).toEqual([
      'import { getAccount, signMessage, watchAccount, type Config } from "@wagmi/core";',
      'import { stringToHex } from "viem";',
      'import { signInWith } from "../lib/sign-in-logic.ts";',
      'import { connect, walletConfig } from "./index.ts";',
      'import { SIGN_IN_METHOD } from "./session.ts";',
    ]);
    expect(signIn.match(/\bsignMessage\(/g)).toHaveLength(1);
    expect(signIn.match(/\.request\(/g)).toHaveLength(1);
    expect(signIn).toContain("await provider.request({ method: SIGN_IN_METHOD, params: [stringToHex(message), address] });");
    expect(signIn).not.toMatch(/\b(sendTransaction|sendCalls|writeContract|signTypedData|signTransaction|switchChain|wallet_switchEthereumChain|wallet_addEthereumChain|eth_sendTransaction)\b/);
    // The store hands it two texts and no others: the message it has checked, and the same sign-in in plain sentences, checked the same way.
    const store = read("stores/rewards.ts");
    expect(store).toContain('const plain = typeof code.plain === "string" && isPlainSignInMessage(code.plain, parts) ? code.plain : null;');
    expect(store).toContain("signature = await signPlainMessage(code.message, address, plain);");
    expect(store).toMatch(/if \(\(network !== null && code\.chainId !== network\) \|\| !isSignInMessage\(code\.message, \{ \.\.\.parts, /);
    // The steps it follows ask a wallet nothing themselves: they are handed the ways of asking.
    const steps = read("lib/sign-in-logic.ts");
    expect(steps).not.toMatch(/^import /m);
    expect(steps).not.toMatch(/\.request\(|signMessage|personal_sign|switchChain|sendTransaction/);
    // Only the Rewards page's own store uses it, and only the Rewards page uses that store.
    const importers = (needle: RegExp) =>
      sources(root)
        .filter((file) => needle.test(fs.readFileSync(file, "utf8")))
        .map((file) => path.relative(root, file).split(path.sep).join("/"))
        .sort();
    expect(importers(/wallet\/sign-in(\.ts)?"/)).toEqual(["stores/rewards.ts"]);
    expect(importers(/stores\/rewards(\.ts)?"/)).toEqual(["pages/RewardsPage.tsx"]);
    // Nothing on the way to paying an order mentions it, or any way of signing.
    for (const name of ["components/SwapCard.tsx", "components/ReviewSheet.tsx", "components/WalletPay.tsx", "pages/OrderPage.tsx", "pages/SwapPage.tsx", "stores/swap.ts", "stores/wallet.ts", "stores/sent.ts", "wallet/transfer.ts", "lib/swap-logic.ts", "lib/order-logic.ts"]) {
      expect(read(name), name).not.toMatch(/sign-in|signPlainMessage|stores\/rewards|personal_sign|signMessage|signTypedData/);
    }
    // The module that pays hands the sign-in the library's settings, and asks a wallet to sign nothing itself.
    expect(read("wallet/index.ts")).not.toMatch(/signPlainMessage|stores\/rewards|personal_sign|signMessage|signTypedData/);
  });
});

describe("what a wallet may be asked for", () => {
  // The rule that can never be broken: one plain transfer, and nothing else. A browser-extension
  // wallet is held to it by the gate before each request; a phone wallet is also told, when it
  // connects, which requests this site may make at all.
  it("is sending a transaction, changing network and adding a network to pay; one plain message to sign in on the Rewards page; and nothing else", () => {
    expect([...PAY_METHODS]).toEqual(["eth_sendTransaction", "wallet_switchEthereumChain", "wallet_addEthereumChain"]);
    expect(SIGN_IN_METHOD).toBe("personal_sign");
    expect([...WALLET_METHODS]).toEqual(["eth_sendTransaction", "wallet_switchEthereumChain", "wallet_addEthereumChain", "personal_sign"]);
    const rights = sessionRights();
    expect(Object.keys(rights.methods)).toEqual(["eip155"]);
    expect(rights.methods.eip155).toEqual([...WALLET_METHODS]);
    for (const never of ["eth_sign", "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4", "wallet_sendCalls", "wallet_grantPermissions", "eth_signTransaction", "eth_sendRawTransaction"]) expect(rights.methods.eip155).not.toContain(never);
  });

  it("tells a phone wallet about the four chains' own public nodes, and no one else's", () => {
    const { rpcMap } = sessionRights();
    expect(Object.keys(rpcMap).sort()).toEqual(["eip155:1", "eip155:42161", "eip155:56", "eip155:8453"]);
    for (const url of Object.values(rpcMap)) {
      expect(url.startsWith("https://")).toBe(true);
      expect(url).not.toMatch(/walletconnect|reown|web3modal/i);
    }
    // Each chain's node is that chain's: a wallet sent to another chain's node would be shown another chain.
    expect(rpcMap).toEqual({
      "eip155:1": "https://ethereum-rpc.publicnode.com",
      "eip155:56": "https://bsc-dataseed.bnbchain.org",
      "eip155:8453": "https://mainnet.base.org",
      "eip155:42161": "https://arb1.arbitrum.io/rpc",
    });
  });

  it("gives a wallet that is adding a network that chain's own public node", () => {
    // The table itself: the server reads the chains through it too when no other node is set.
    expect(WALLET_CHAIN_NODE).toEqual({
      bsc: "https://bsc-dataseed.bnbchain.org",
      eth: "https://ethereum-rpc.publicnode.com",
      base: "https://mainnet.base.org",
      arb: "https://arb1.arbitrum.io/rpc",
    });
    // And the one place a wallet is asked to change network hands over the entry for the chain asked for.
    const source = fs.readFileSync(path.resolve("web", "src", "wallet", "index.ts"), "utf8");
    expect(source).toContain("await switchChain(config, { chainId, addEthereumChainParameter: { rpcUrls: [WALLET_CHAIN_NODE[chain]] } });");
    expect(source.match(/\bswitchChain\(/g)).toHaveLength(1);
  });

  it("switches off everything the wallet window could do beyond connecting", () => {
    expect(Object.keys(WINDOW_FEATURES).length).toBeGreaterThanOrEqual(12);
    for (const [feature, on] of Object.entries(WINDOW_FEATURES)) expect(on, feature).toBe(false);
    for (const feature of ["analytics", "email", "socials", "swaps", "onramp", "send", "pay", "smartSessions", "reownAuthentication"]) expect(WINDOW_FEATURES).toHaveProperty(feature, false);
  });

  it("is what the wallet library is really given", () => {
    // The module that talks to the library must hand it exactly these, and must not carry a list of its own.
    const source = fs.readFileSync(path.resolve("web", "src", "wallet", "index.ts"), "utf8");
    expect(source).toContain("universalProviderConfigOverride: sessionRights(),");
    expect(source).toContain("features: { ...WINDOW_FEATURES },");
    expect(source).not.toMatch(/personal_sign|eth_signTypedData|signMessage|signTypedData|wallet_sendCalls|wallet_grantPermissions/);
    expect(source.match(/universalProviderConfigOverride/g)).toHaveLength(1);
  });
});

