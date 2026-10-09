// What a connected wallet holds, on the swap card: beside "You pay" and "You receive", for a coin
// on a network a wallet can pay on. It is read from the coin's own chain through this site's chain
// route, so the network the wallet happens to be on makes no difference, and the wallet itself is
// asked nothing. The card is drawn here as the browser would first draw it (to plain markup, without
// a browser); the coin picker's rows and their order are tested in picker.test.ts and swap-logic.test.ts.

import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenView } from "../shared/api.ts";
import { SwapCard } from "../web/src/components/SwapCard.tsx";
import { usePicker } from "../web/src/stores/picker.ts";
import { useSwap } from "../web/src/stores/swap.ts";
import { useTokens } from "../web/src/stores/tokens.ts";
import { BALANCE_FRESH_MS, noBalances, useWallet, type WalletState } from "../web/src/stores/wallet.ts";

// The one module of the site that can ask a wallet for anything. Here it only notes that it was fetched.
const walletCode = vi.hoisted(() => ({ fetched: false }));
vi.mock("../web/src/wallet/index.ts", () => {
  walletCode.fetched = true;
  return {};
});

// Made up from fixed text, so it is nobody's.
const ADDRESS = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
const coin = (symbol: string, chain: string, name: string, extra: Partial<TokenView> = {}): TokenView => ({ id: `${chain}:${symbol}`, symbol, name, chain, decimals: 18, price: "1", contract: null, wallet: false, ...extra });
const ETH = coin("ETH", "base", "Ethereum", { wallet: true });
const USDC = coin("USDC", "base", "USD Coin", { decimals: 6, contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", wallet: true });
const USDT_ARB = coin("USDT", "arb", "Tether USD", { decimals: 6, contract: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" });
const SOL = coin("SOL", "sol", "Solana", { decimals: 9 });
const BTC = coin("BTC", "btc", "Bitcoin", { decimals: 8 });
const LIST = [ETH, USDC, USDT_ARB, SOL, BTC];

/** A wallet that is connected, and on Ethereum: another network than any coin of the list is on. */
const connected = (held: Partial<WalletState> = {}): Partial<WalletState> => ({ status: "connected", address: ADDRESS, chain: "eth", plain: true, ...held });

/**
 * The swap card as it is first drawn. Drawn here, outside a browser, a component reads each store's
 * first state, so what the drawing needs is put there for its length and taken away again.
 */
function card(fromId: string, toId: string, wallet: Partial<WalletState> = {}): string {
  const wanted: [{ getInitialState(): object }, Record<string, unknown>][] = [
    [useTokens, { status: "ready", tokens: LIST, byId: new Map(LIST.map((token) => [token.id, token])) }],
    [useSwap, { fromId, toId, amountText: "", pay: "wallet", recipient: "", refundTo: "", quote: null, fetchedAt: 0, loading: false, dirty: false, problem: null, withoutPrivate: false }],
    [usePicker, { side: null }],
    [useWallet, wallet],
  ];
  const before = wanted.map(([store, values]) => {
    const first = store.getInitialState() as Record<string, unknown>;
    const kept = Object.fromEntries(Object.keys(values).map((key) => [key, first[key]]));
    Object.assign(first, values);
    return [first, kept] as const;
  });
  try {
    return renderToStaticMarkup(createElement(SwapCard));
  } finally {
    for (const [first, kept] of before) Object.assign(first, kept);
  }
}

/** The two amount fields of a drawing: "You pay", then "You receive". */
const fields = (html: string) => {
  const parts = html.split('<div class="field">').slice(1);
  expect(parts).toHaveLength(2);
  return { pay: parts[0]!, receive: parts[1]!.split('<div class="address-field')[0]! };
};
/** Markup as the eye is given it: what is only for a screen reader left out, tags out, spaces evened. */
const seen = (html: string) => html.replace(/<span class="sr-only">[^<]*<\/span>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const PLACEHOLDER = '<span class="skeleton skeleton-balance" aria-hidden="true"></span>';
const MAX = '<button type="button" class="balance-max">Max</button>';

describe("what the connected wallet holds, on the swap card", () => {
  it("is shown beside \"You pay\", with Max, while the wallet is on another network than the coin's, or on one this site does not know", () => {
    for (const chain of ["eth", "arb", null]) {
      const { pay } = fields(card(ETH.id, SOL.id, connected({ chain, balances: new Map([[ETH.id, 500_000_000_000_000_000n]]) })));
      expect(seen(pay), String(chain)).toMatch(/^You pay Balance: 0\.5 ETH Max /);
      expect(pay).toContain(MAX);
      expect(pay).not.toContain(PLACEHOLDER);
    }
    // A token is read the same way, and is shown in its own decimals.
    expect(seen(fields(card(USDC.id, SOL.id, connected({ balances: new Map([[USDC.id, 1_250_500_000n]]) }))).pay)).toMatch(/^You pay Balance: 1,250\.50 USDC Max /);
  });

  it("a balance of nothing is shown as a balance: \"Balance: 0 ETH\"", () => {
    const { pay } = fields(card(ETH.id, SOL.id, connected({ balances: new Map([[ETH.id, 0n]]) })));
    expect(seen(pay)).toMatch(/^You pay Balance: 0 ETH /);
    expect(pay).not.toContain(PLACEHOLDER);
  });

  it("a balance that could not be read shows nothing: no figure, and the quiet block that stood there while it was read is gone", () => {
    // Until it has been read, a block stands in the figure's place on the label's line, in both fields, and says nothing.
    const waiting = fields(card(ETH.id, USDC.id, connected()));
    for (const field of [waiting.pay, waiting.receive]) {
      expect(field).toMatch(/^<div class="field-head"><label class="field-label" for="amount-(in|out)">You (pay|receive)<\/label><span class="skeleton skeleton-balance" aria-hidden="true"><\/span><\/div>/);
      expect(field).not.toMatch(/Balance|balance-max/);
    }
    // The read failed: the label stands alone. Even with a figure still held for the coin, which the store never leaves there.
    for (const balances of [new Map<string, bigint>(), new Map([[ETH.id, 7n]])]) {
      const { pay } = fields(card(ETH.id, SOL.id, connected({ balances, unreadable: new Set([ETH.id]) })));
      expect(pay).toMatch(/^<div class="field-head"><label class="field-label" for="amount-in">You pay<\/label><\/div>/);
      expect(pay).not.toMatch(/Balance|balance-max|skeleton-balance/);
    }
  });

  it("beside \"You receive\" it is shown too, and without Max", () => {
    const html = card(SOL.id, USDC.id, connected({ balances: new Map([[USDC.id, 42_000_000n]]) }));
    const { pay, receive } = fields(html);
    expect(seen(receive)).toMatch(/^You receive Balance: 42\.00 USDC /);
    expect(html).not.toContain("balance-max");
    // The coin paid is on Solana, where this wallet holds nothing that can be read.
    expect(pay).not.toMatch(/Balance|skeleton-balance/);
  });

  it("a coin on a chain a wallet cannot pay on has no balance line, whatever the store holds", () => {
    const html = card(SOL.id, BTC.id, connected({ balances: new Map([[SOL.id, 7_000_000_000n], [BTC.id, 100_000_000n]]) }));
    expect(html).not.toMatch(/Balance|balance-max|skeleton-balance/);
    expect(card(SOL.id, BTC.id, connected())).not.toMatch(/Balance|balance-max|skeleton-balance/);
  });

  it("with no wallet connected there is no balance line, and the card is as it is with nothing known", () => {
    const held = new Map([[ETH.id, 500_000_000_000_000_000n], [USDC.id, 42_000_000n]]);
    for (const status of ["disconnected", "connecting"] as const) {
      const html = card(ETH.id, USDC.id, { status, balances: held });
      expect(html, status).not.toMatch(/Balance|balance-max|skeleton-balance/);
      expect(html, status).toBe(card(ETH.id, USDC.id, { status }));
    }
  });
});

describe("how a balance is read", () => {
  const session = { session: "s", sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), serverNow: new Date().toISOString() };
  const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
  /** The site's own server, as far as a balance needs it. What each chain answers, or "down" for a route that cannot be reached. */
  function server(answers: Record<string, unknown[] | "down">) {
    const asked: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string; body?: string }) => {
      const pathname = String(input);
      if (pathname === "/api/config") return new Response(JSON.stringify(session));
      asked.push({ path: pathname, body: JSON.parse(init?.body ?? "null") });
      const answer = answers[pathname.replace("/api/rpc/", "")];
      if (answer === undefined || answer === "down") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(answer.map((result, id) => ({ jsonrpc: "2.0", id, result }))));
    });
    return asked;
  }
  const state = () => useWallet.getState();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    useWallet.setState({ status: "disconnected", address: null, chain: null, plain: null, ...noBalances() });
  });

  it("from the coin's own chain through this site's chain route, for the connected address, whatever network the wallet is on; the wallet is asked nothing", async () => {
    // A wallet in the page, as a browser wallet is: anything asked of it is written down.
    const wallet = { request: vi.fn() };
    vi.stubGlobal("window", { ethereum: wallet });
    const asked = server({ base: [`0x${(5n * 10n ** 17n).toString(16)}`, word(1_250_500_000n)], arb: [word(0n)] });
    // The wallet is on Ethereum; the coins are on Base and Arbitrum.
    useWallet.setState({ ...connected(), ...noBalances() });
    await state().loadBalances(LIST);
    expect(state().balances).toEqual(new Map([[ETH.id, 5n * 10n ** 17n], [USDC.id, 1_250_500_000n], [USDT_ARB.id, 0n]]));
    expect(state().unreadable.size).toBe(0);
    // One request for each chain, holding every read of that chain: the chain's own coin directly, a token through its contract.
    // Nothing is asked about a coin on Solana or Bitcoin.
    const owner = ADDRESS.slice(2).toLowerCase().padStart(64, "0");
    expect([...asked].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "/api/rpc/arb", body: [{ jsonrpc: "2.0", id: 0, method: "eth_call", params: [{ to: USDT_ARB.contract, data: `0x70a08231${owner}` }, "latest"] }] },
      {
        path: "/api/rpc/base",
        body: [
          { jsonrpc: "2.0", id: 0, method: "eth_getBalance", params: [ADDRESS, "latest"] },
          { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC.contract, data: `0x70a08231${owner}` }, "latest"] },
        ],
      },
    ]);
    // The wallet was not asked to change network, nor for anything else: the code that talks to a wallet was not so much as fetched.
    expect(wallet.request).not.toHaveBeenCalled();
    expect(walletCode.fetched).toBe(false);
    expect(state().chain).toBe("eth");
    const read = (file: string) => fs.readFileSync(path.resolve("web", "src", file), "utf8");
    // Nor could it have been: the part of the store that reads a balance reaches for the chain route, and for no wallet code.
    const store = read("stores/wallet.ts");
    const reading = store.slice(store.indexOf("  refreshBalance(token) {"), store.indexOf("  async disconnect() {"));
    expect(reading).toContain("await api.chainBatch(chain, balanceCalls(part, address))");
    expect(reading).not.toMatch(/import\(|wallet\/index/);
    expect(read("wallet/index.ts")).not.toMatch(/getBalance|readContract|balanceOf|eth_call/);
    for (const file of ["stores/wallet.ts", "components/SwapCard.tsx", "components/CoinPicker.tsx"]) expect(read(file), file).not.toMatch(/switchTo|switchChain|wallet_/);

    // Read a moment ago, a coin is not read again; a quarter of a minute on it is, and at once when asked afresh (after a delivery).
    vi.useFakeTimers({ now: Date.now() });
    await state().loadBalances(LIST);
    expect(asked).toHaveLength(2);
    await state().loadBalances([ETH], 0);
    expect(asked).toHaveLength(3);
    vi.advanceTimersByTime(BALANCE_FRESH_MS);
    await state().loadBalances([ETH, USDC]);
    expect(asked).toHaveLength(4);
    expect((asked[3]!.body as unknown[]).length).toBe(2);
    expect(walletCode.fetched).toBe(false);
  });

  it("a read that fails leaves no figure, old or new: the coin is marked as one that could not be read, and is asked about again at the next chance", async () => {
    server({ base: [word(9n), word(1_250_500_000n)] });
    useWallet.setState({ ...connected(), ...noBalances() });
    await state().loadBalances([ETH, USDC]);
    expect(state().balances.get(ETH.id)).toBe(9n);
    // The route cannot be reached: both coins lose their figure.
    server({ base: "down" });
    await state().loadBalances([ETH, USDC], 0);
    expect(state().balances.size).toBe(0);
    expect([...state().unreadable].sort()).toEqual([ETH.id, USDC.id].sort());
    // Asked again at once, though a moment ago: one answer is a number, and one is not. That coin alone has no figure.
    const again = server({ base: [word(3n), "0x"] });
    await state().loadBalances([ETH, USDC]);
    expect(again).toHaveLength(1);
    expect(state().balances).toEqual(new Map([[ETH.id, 3n]]));
    expect([...state().unreadable]).toEqual([USDC.id]);
    // Without a wallet nothing is read at all.
    useWallet.setState({ status: "disconnected", address: null, ...noBalances() });
    const none = server({ base: [word(3n), word(4n)] });
    await state().loadBalances([ETH, USDC], 0);
    expect(none).toHaveLength(0);
    expect(state().balances.size).toBe(0);
  });
});
