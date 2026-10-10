// "Add gas" on the swap card and in the review: when the page asks whether gas can be added (only
// once a valid receiving address is on the card), what it holds of the answer, what it draws, what
// it sends with an order and what it holds the order that comes back to.
// Runs without a browser. The card's store is loaded afresh for each test and driven as a page
// drives it, against stand-ins for the network and the browser's storage, with time moved by hand.
// The parts that are drawn are drawn as the browser first draws them (to plain markup).

import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routingOf, type Confidentiality, type GasLine, type GasQuote, type OrderView, type QuoteView, type TokenView } from "../shared/api.ts";
import { ReviewSheet } from "../web/src/components/ReviewSheet.tsx";
import { SwapCard } from "../web/src/components/SwapCard.tsx";
import { GAS_LABEL, GAS_WITHDRAWN, gasChoice, gasCoinOnCard, gasDiffers, gasKey, gasLine, gasOffered, gasPart, reviewAge, totalSent, TWO_PAYMENTS, type Age, type ReviewedGas } from "../web/src/lib/gas-logic.ts";
import { maxSpendable, primaryAction } from "../web/src/lib/swap-logic.ts";
import { useApp } from "../web/src/stores/app.ts";
import { useGhost } from "../web/src/stores/ghost.ts";
import { gasAge, useSwap } from "../web/src/stores/swap.ts";
import { useTokens } from "../web/src/stores/tokens.ts";
import { useWallet } from "../web/src/stores/wallet.ts";

const PRIVATELY = routingOf("basic");
const IN_PUBLIC = routingOf("public");

const coin = (symbol: string, chain: string, decimals: number, contract: string | null): TokenView => ({ id: `${chain}:${symbol}`, symbol, name: symbol, chain, decimals, price: "1", contract, wallet: false });
// Two chains with a coin of their own and tokens on each, and a token on a chain whose own coin is not on the list.
const ETH = coin("ETH", "base", 18, null);
const USDC = coin("USDC", "base", 6, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
const SOL = coin("SOL", "sol", 9, null);
const USDT = coin("USDT", "sol", 6, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const USDC_SOL = coin("USDC", "sol", 6, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WNEAR = coin("wNEAR", "near", 24, "wrap.near");
const LIST = [ETH, USDC, SOL, USDT, USDC_SOL, WNEAR];
const BY_ID = new Map(LIST.map((token) => [token.id, token]));
// Example addresses, made up from fixed text: they are nobody's.
const SOL_ADDRESS = "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP";
const OTHER_SOL_ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const EVM_ADDRESS = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
const OTHER_EVM_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const NEAR_ADDRESS = "example.near";

/** A preview of a gas order beside a swap paid in ETH on Base and received on Solana: about three dollars of ETH for a little SOL, privately routed. */
const gasQuote = (overrides: Partial<QuoteView> = {}): QuoteView => ({
  from: ETH.id,
  to: SOL.id,
  amountIn: "750000000000000",
  amountOut: "19000000",
  minAmountOut: "18810000",
  amountInUsd: "3",
  amountOutUsd: "2.98",
  slippageBps: 100,
  timeEstimate: 30,
  fees: { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "1500000000000" },
  withdrawFee: "5000",
  refundFee: null,
  priceImpactBps: 40,
  routing: PRIVATELY,
  serverNow: "2026-10-10T12:00:00.000Z",
  ...overrides,
});
const OFFER: GasQuote = { usd: 3, quote: gasQuote() };
/** The server's answer with that preview in it, and its answer where gas is not offered. */
const offered = (gas: GasQuote = OFFER) => ({ gas, serverNow: "2026-10-10T12:00:00.000Z" });
const NOT_OFFERED = { gas: null, serverNow: "2026-10-10T12:00:00.000Z" };

/** The swap's own quote: 0.5 ETH on Base for USDT on Solana, privately routed, with no fee of IntentSwap's. */
const QUOTE: QuoteView = {
  from: ETH.id,
  to: USDT.id,
  amountIn: "500000000000000000",
  amountOut: "1260079171",
  minAmountOut: "1247478379",
  amountInUsd: "1265.13",
  amountOutUsd: "1260.07",
  slippageBps: 100,
  timeEstimate: 34,
  fees: { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "1000000000000000" },
  withdrawFee: "302700",
  refundFee: null,
  priceImpactBps: 36,
  routing: PRIVATELY,
  serverNow: "2026-10-10T12:00:00.000Z",
};

interface Asked {
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
  answer(json: unknown, status?: number): void;
  /** The connection drops: no answer of any kind. */
  drop(): void;
}
let asked: Asked[] = [];
const askedOf = (route: string) => asked.filter((request) => request.url.endsWith(route));
const gasAsked = () => askedOf("/api/gas");
const quoteAsked = () => askedOf("/api/quote");
/** While true, a request that is cancelled is answered all the same: the stand-in for an answer already on its way back. */
let deaf = false;
/** Everything written to the browser's storage, of either kind, while a test runs. */
let written: string[][] = [];
/** The address the browser shows, as far as the card reads it. */
const address = { search: "" };

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-10T12:00:00.000Z") });
  asked = [];
  written = [];
  deaf = false;
  address.search = "";
  const storage = (kind: string) => ({
    getItem: () => null,
    setItem: (key: string, value: string) => void written.push([kind, key, value]),
    removeItem: (key: string) => void written.push([kind, key]),
  });
  vi.stubGlobal("localStorage", storage("local"));
  vi.stubGlobal("sessionStorage", storage("session"));
  vi.stubGlobal("window", { location: address });
  vi.stubGlobal("document", { hidden: false, addEventListener: () => undefined });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (String(url).endsWith("/api/config")) {
      return new Response(JSON.stringify({ session: "s", sessionExpiresAt: new Date(Date.now() + 1_800_000).toISOString(), serverNow: new Date().toISOString() }));
    }
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal as AbortSignal;
      const stays = deaf;
      signal.addEventListener("abort", () => {
        if (!stays) reject(new DOMException("aborted", "AbortError"));
      });
      asked.push({
        url: String(url),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        signal,
        answer: (json, status = 200) => resolve(new Response(JSON.stringify(json), { status })),
        drop: () => reject(new TypeError("Failed to fetch")),
      });
    });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets promises settle and moves the clock. */
const pass = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

/**
 * The swap page as a browser has just loaded it: the stores loaded afresh, the coin list and the
 * server's routing setting in place, and the page visited (which gives the card its coins: ETH on
 * Base for USDT on Solana, or the pair the address names). Nothing is typed yet: the card has no
 * receiving address, so nothing has been asked about gas.
 */
async function page(options: { mode?: Confidentiality | null; search?: string } = {}) {
  vi.resetModules();
  const swap = await import("../web/src/stores/swap.ts");
  const app = await import("../web/src/stores/app.ts");
  const tokens = await import("../web/src/stores/tokens.ts");
  const sheet = await import("../web/src/stores/sheet.ts");
  const wallet = await import("../web/src/stores/wallet.ts");
  tokens.useTokens.setState({ status: "ready", tokens: LIST, byId: BY_ID });
  const mode = options.mode === undefined ? "basic" : options.mode;
  app.useApp.setState({ config: mode === null ? null : ({ privacyMode: mode, paused: false } as never) });
  address.search = options.search ?? "";
  const leave = swap.visitSwap();
  await pass(1);
  const card = () => swap.useSwap.getState();
  return { card, leave, visitSwap: swap.visitSwap, heardRouting: swap.heardRouting, useApp: app.useApp, useSheet: sheet.useSheet, useWallet: wallet.useWallet };
}

/** The same page once a valid receiving address has been entered and the usual wait is over: the page has asked about gas, and the answer is awaited. */
async function pageAsked(options: Parameters<typeof page>[0] = {}) {
  const loaded = await page(options);
  expect(gasAsked()).toHaveLength(0);
  loaded.card().setRecipient(SOL_ADDRESS);
  await pass(401);
  return loaded;
}
/** What that page has asked: the swap's two coins, how it is paid, and the address on the card. */
const ASKED = { from: ETH.id, to: USDT.id, pay: "manual", recipient: SOL_ADDRESS };

/** And once the server has answered that gas can be added: the preview is on the card. */
async function pageWithGas(options: Parameters<typeof page>[0] = {}) {
  const loaded = await pageAsked(options);
  expect(gasAsked()).toHaveLength(1);
  gasAsked()[0]!.answer(offered());
  await pass(1);
  expect(loaded.card().gas).toEqual(OFFER);
  return loaded;
}

describe("gas is asked about only once a valid receiving address is on the card", () => {
  it("asks nothing before one is there: not as the card is given its coins, not for an amount, a way of paying, a refund address or a refresh, however long the page stands open", async () => {
    const { card } = await page();
    expect(asked).toHaveLength(0);
    card().setAmount("0.5");
    card().setPay("wallet");
    card().setPay("manual");
    card().setRefundTo(EVM_ADDRESS);
    card().setSlippage(50);
    card().refreshNow();
    await pass(120_000);
    expect(gasAsked()).toHaveLength(0);
    expect(card()).toMatchObject({ recipient: "", gas: null, gasOn: false, gasLoading: false });
    // With no preview there is no switch, and nothing to switch on.
    card().setGasOn(true);
    expect(card().gasOn).toBe(false);
    // The quote was asked for as ever, with no receiving address in it.
    expect(quoteAsked().length).toBeGreaterThan(0);
    for (const request of quoteAsked()) expect(Object.keys(request.body)).not.toContain("recipient");
  });

  it("asks nothing while the address is half-typed, is no address, or is an address of another chain", async () => {
    const { card } = await page();
    for (const text of [SOL_ADDRESS.slice(0, 1), SOL_ADDRESS.slice(0, 20), SOL_ADDRESS.slice(0, 30), `${SOL_ADDRESS}x`, "not an address", EVM_ADDRESS, NEAR_ADDRESS]) {
      card().setRecipient(text);
      expect(card(), text).toMatchObject({ recipient: text, gas: null, gasOn: false, gasLoading: false });
      await pass(401);
      expect(gasAsked(), text).toHaveLength(0);
    }
    await pass(120_000);
    expect(asked).toHaveLength(0);
  });

  it("asks when the address becomes valid, after the usual 400 ms wait, with that address in what it asks; no amount is needed", async () => {
    const { card } = await page();
    card().setRecipient(SOL_ADDRESS.slice(0, 30));
    await pass(401);
    expect(gasAsked()).toHaveLength(0);
    // The rest of it: the address is one now.
    card().setRecipient(SOL_ADDRESS);
    expect(card()).toMatchObject({ gas: null, gasOn: false, gasLoading: true });
    await pass(399);
    expect(gasAsked()).toHaveLength(0);
    await pass(2);
    expect(gasAsked()).toHaveLength(1);
    expect(gasAsked()[0]!.body).toEqual({ from: ETH.id, to: USDT.id, pay: "manual", recipient: SOL_ADDRESS });
    expect(gasAsked()[0]!.body).toEqual(ASKED);
    // Nothing is typed for an amount: no quote is asked for, and the gas preview did not wait for one.
    expect(card().amountText).toBe("");
    expect(quoteAsked()).toHaveLength(0);
    gasAsked()[0]!.answer(offered());
    await pass(1);
    expect(card()).toMatchObject({ gas: OFFER, gasOn: false, gasLoading: false });
    // Nothing more is asked while nothing changes, however long the page stands open.
    await pass(120_000);
    expect(asked).toHaveLength(1);
  });

  it("when the address is cleared or made invalid, the preview and the switch go at once and gas goes back to off; nothing is asked until there is an address again", async () => {
    for (const text of ["", SOL_ADDRESS.slice(0, 30), `${SOL_ADDRESS}x`, EVM_ADDRESS]) {
      asked = [];
      const { card } = await pageWithGas();
      card().setGasOn(true);
      expect(card(), text).toMatchObject({ gas: OFFER, gasOn: true });
      card().setRecipient(text);
      // At once: before any time has passed.
      expect(card(), text).toMatchObject({ recipient: text, gas: null, gasOn: false, gasFetchedAt: 0, gasLoading: false });
      card().setGasOn(true);
      expect(card().gasOn, text).toBe(false);
      await pass(120_000);
      expect(gasAsked(), text).toHaveLength(1);
      // The address is entered again: it is asked about afresh, and the preview comes back switched off.
      card().setRecipient(SOL_ADDRESS);
      await pass(401);
      expect(gasAsked(), text).toHaveLength(2);
      expect(gasAsked()[1]!.body, text).toEqual(ASKED);
      gasAsked()[1]!.answer(offered());
      await pass(1);
      expect(card(), text).toMatchObject({ gas: OFFER, gasOn: false });
    }
  });

  it("an address cleared while its preview is on its way: the request is cancelled, and its answer is not shown even if it arrives", async () => {
    deaf = true;
    const { card } = await pageAsked();
    expect(card().gasLoading).toBe(true);
    card().setRecipient("");
    expect(gasAsked()[0]!.signal.aborted).toBe(true);
    expect(card()).toMatchObject({ gas: null, gasOn: false, gasLoading: false });
    gasAsked()[0]!.answer(offered());
    await pass(1000);
    expect(card()).toMatchObject({ gas: null, gasOn: false, gasLoading: false });
    expect(gasAsked()).toHaveLength(1);
  });

  it("when the receiving coin changes, which clears the address, the same: nothing is asked of the new coin until an address for it is entered", async () => {
    const { card } = await pageWithGas();
    card().setGasOn(true);
    card().setTo(USDC_SOL.id);
    expect(card()).toMatchObject({ toId: USDC_SOL.id, recipient: "", gas: null, gasOn: false, gasFetchedAt: 0, gasLoading: false });
    await pass(120_000);
    expect(gasAsked()).toHaveLength(1);
    card().setRecipient(OTHER_SOL_ADDRESS);
    await pass(401);
    expect(gasAsked()).toHaveLength(2);
    expect(gasAsked()[1]!.body).toEqual({ from: ETH.id, to: USDC_SOL.id, pay: "manual", recipient: OTHER_SOL_ADDRESS });
    gasAsked()[1]!.answer(offered());
    await pass(1);
    expect(card()).toMatchObject({ gas: OFFER, gasOn: false });
    // The same receiving coin chosen again clears the address too, as choosing a coin always has: the switch goes with it.
    card().setGasOn(true);
    card().setTo(USDC_SOL.id);
    expect(card()).toMatchObject({ recipient: "", gas: null, gasOn: false });
    // And the two coins changing places clears both addresses.
    card().setRecipient(OTHER_SOL_ADDRESS);
    card().flip();
    expect(card()).toMatchObject({ fromId: USDC_SOL.id, toId: ETH.id, recipient: "", gas: null, gasOn: false, gasLoading: false });
    await pass(120_000);
    expect(gasAsked()).toHaveLength(2);
  });
});

describe("whether the page asks about gas at all", () => {

  it.each([
    ["the coin received is already its chain's own coin", { search: "?from=base:USDC&to=sol:SOL" }, SOL_ADDRESS],
    ["the server routes swaps in public", { mode: "public" as const }, SOL_ADDRESS],
    ["the server has not said how it routes swaps", { mode: null }, SOL_ADDRESS],
    ["the receiving chain's own coin is not on the list", { search: "?from=base:USDC&to=near:wNEAR" }, NEAR_ADDRESS],
    ["the chain's own coin is the very coin being paid with", { search: "?from=sol:SOL&to=sol:USDT" }, SOL_ADDRESS],
  ])("asks nothing when %s, with a valid receiving address on the card and whatever else is done to it, and there is nothing to switch on", async (_when, options, receiving) => {
    const { card } = await page(options);
    // The card is used as a person uses it: an amount, the way of paying, and a valid receiving address.
    card().setAmount("5");
    card().setPay("wallet");
    card().setPay("manual");
    card().setRecipient(receiving);
    card().refreshNow();
    await pass(60_000);
    expect(gasAsked()).toHaveLength(0);
    expect(card()).toMatchObject({ recipient: receiving, gas: null, gasOn: false, gasLoading: false });
    card().setGasOn(true);
    expect(card().gasOn).toBe(false);
    // The quote itself was asked for as ever, and with that address: it is a valid one, so its absence is not why nothing was asked about gas.
    expect(quoteAsked().length).toBeGreaterThan(0);
    expect(quoteAsked().at(-1)!.body).toMatchObject({ recipient: receiving });
  });

  it("asks nothing once the person has chosen public routing for the swap: the preview goes at once, and comes back only with private routing", async () => {
    const { card } = await pageWithGas();
    card().setGasOn(true);
    card().setWithoutPrivate(true);
    // At once: before any time has passed there is no preview and gas is off.
    expect(card()).toMatchObject({ withoutPrivate: true, gas: null, gasOn: false, gasLoading: false });
    // Another valid receiving address, and an amount: still nothing is asked.
    card().setRecipient(OTHER_SOL_ADDRESS);
    card().setAmount("0.5");
    await pass(60_000);
    expect(gasAsked()).toHaveLength(1);
    // Back to private routing: it is asked about again, and it comes back switched off.
    card().setWithoutPrivate(false);
    await pass(401);
    expect(gasAsked()).toHaveLength(2);
    expect(gasAsked()[1]!.body).toEqual({ from: ETH.id, to: USDT.id, pay: "manual", recipient: OTHER_SOL_ADDRESS });
    gasAsked()[1]!.answer(offered());
    await pass(1);
    expect(card()).toMatchObject({ gas: OFFER, gasOn: false });
  });

  it("follows the server's word on routing when it arrives after the coins, and when it changes", async () => {
    const { card, useApp, heardRouting } = await page({ mode: null });
    // A valid receiving address is on the card before the server has said how it routes: nothing is asked yet.
    card().setRecipient(SOL_ADDRESS);
    await pass(60_000);
    expect(gasAsked()).toHaveLength(0);
    // The settings arrive: the server routes privately. It is asked now, with that address.
    useApp.setState({ config: { privacyMode: "basic", paused: false } as never });
    await pass(1);
    expect(gasAsked()).toHaveLength(1);
    expect(gasAsked()[0]!.body).toEqual(ASKED);
    gasAsked()[0]!.answer(offered());
    await pass(1);
    card().setGasOn(true);
    expect(card()).toMatchObject({ gas: OFFER, gasOn: true });
    // An answer about a quote says the server now routes in public: gas is no longer offered.
    heardRouting("public");
    expect(card()).toMatchObject({ gas: null, gasOn: false });
    await pass(60_000);
    expect(gasAsked()).toHaveLength(1);
  });

  it("names nothing of the gas itself in what it asks: no amount, no address of its own, no routing", async () => {
    const { card } = await page();
    card().setAmount("0.5");
    card().setRecipient(SOL_ADDRESS);
    card().setRefundTo(EVM_ADDRESS);
    await pass(401);
    expect(gasAsked().at(-1)!.body).toEqual({ from: ETH.id, to: USDT.id, pay: "manual", recipient: SOL_ADDRESS, refundTo: EVM_ADDRESS });
    expect(gasAsked().length).toBeGreaterThan(0);
    for (const request of gasAsked()) for (const key of Object.keys(request.body)) expect(["from", "to", "pay", "recipient", "refundTo", "sender"]).toContain(key);
    // And every one of them names the receiving address on the card: gas is never asked about for no address.
    for (const request of gasAsked()) expect(request.body.recipient).toBe(SOL_ADDRESS);
  });

  it("the rule, case by case: only beside a privately routed swap, and only where there is a coin to deliver", () => {
    expect(gasCoinOnCard("basic", false, ETH, USDT, LIST)).toBe(SOL);
    expect(gasCoinOnCard("basic", false, SOL, USDC, LIST)).toBe(ETH);
    expect(gasCoinOnCard("public", false, ETH, USDT, LIST)).toBeNull();
    expect(gasCoinOnCard(null, false, ETH, USDT, LIST)).toBeNull();
    expect(gasCoinOnCard("basic", true, ETH, USDT, LIST)).toBeNull();
    expect(gasCoinOnCard("basic", false, USDC, SOL, LIST)).toBeNull();
    expect(gasCoinOnCard("basic", false, USDC, WNEAR, LIST)).toBeNull();
    expect(gasCoinOnCard("basic", false, SOL, USDT, LIST)).toBeNull();
    expect(gasCoinOnCard("basic", false, null, USDT, LIST)).toBeNull();
    expect(gasCoinOnCard("basic", false, ETH, null, LIST)).toBeNull();
  });
});

describe("what the card holds of the answer", () => {
  it("holds no preview while it is asked for, and none after a refusal, an error, a broken answer, a dropped connection or no reply at all", async () => {
    const replies: [string, (request: Asked) => void, number][] = [
      ["a refusal", (request) => request.answer(NOT_OFFERED), 1],
      ["an error", (request) => request.answer({ error: { code: "try_later", message: "Try again shortly." } }, 503), 1],
      ["an everyday refusal in an answer's own words", (request) => request.answer({ error: { code: "no_route", message: "No route for this pair right now." } }), 1],
      ["an answer that is not one", (request) => request.answer("nonsense"), 1],
      ["a dropped connection", (request) => request.drop(), 1],
      ["no reply", () => undefined, 20_001],
    ];
    for (const [name, reply, wait] of replies) {
      asked = [];
      const { card } = await pageAsked();
      // While it is asked for: nothing to show, and nothing to switch on.
      expect(card(), name).toMatchObject({ gas: null, gasOn: false, gasLoading: true });
      card().setGasOn(true);
      expect(card().gasOn, name).toBe(false);
      reply(gasAsked()[0]!);
      await pass(wait);
      expect(card(), name).toMatchObject({ gas: null, gasOn: false, gasLoading: false });
      card().setGasOn(true);
      expect(card().gasOn, name).toBe(false);
      // It is not asked again by itself.
      await pass(120_000);
      expect(gasAsked(), name).toHaveLength(1);
    }
  });

  it("is off by default, is switched on and off by the person, and only while there is a preview", async () => {
    const { card } = await pageWithGas();
    expect(card().gasOn).toBe(false);
    card().setGasOn(true);
    expect(card().gasOn).toBe(true);
    card().setGasOn(false);
    expect(card().gasOn).toBe(false);
    // The preview is a moment old: switching it on asked nothing.
    await pass(1);
    expect(gasAsked()).toHaveLength(1);
  });

  it("shows only the answer that was asked for: one for other coins, one routed in public, one of no set size or with amounts that are not whole numbers is no offer", async () => {
    const wrong: [string, unknown][] = [
      ["delivers another coin", offered({ usd: 3, quote: gasQuote({ to: USDT.id }) })],
      ["is paid with another coin", offered({ usd: 3, quote: gasQuote({ from: USDC.id }) })],
      ["is routed in public", offered({ usd: 3, quote: gasQuote({ routing: IN_PUBLIC }) })],
      ["names no routing", offered({ usd: 3, quote: (({ routing: _routing, ...rest }) => rest)(gasQuote()) })],
      ["is of no set size", offered({ usd: 50, quote: gasQuote() })],
      ["sends nothing", offered({ usd: 3, quote: gasQuote({ amountIn: "0" }) })],
      ["has an amount that is not a whole number", offered({ usd: 3, quote: gasQuote({ amountOut: "1.9e7" }) })],
      ["has no fees", offered({ usd: 3, quote: { ...gasQuote(), fees: undefined } as never })],
      ["has a network fee that is not a number", offered({ usd: 3, quote: gasQuote({ withdrawFee: "a little" }) })],
    ];
    for (const [name, answer] of wrong) expect(gasOffered(answer, ETH, SOL), name).toBeNull();
    for (const nothing of [null, undefined, "", 7, {}, NOT_OFFERED, { gas: 3 }, { gas: {} }, { gas: { usd: 3 } }]) expect(gasOffered(nothing, ETH, SOL)).toBeNull();
    expect(gasOffered(offered(), ETH, SOL)).toEqual(OFFER);
    expect(gasOffered(offered({ usd: 10, quote: gasQuote({ withdrawFee: null }) }), ETH, SOL)).toMatchObject({ usd: 10 });
    // And on the card: a preview routed in public puts no switch there.
    const { card } = await pageAsked();
    gasAsked()[0]!.answer(offered({ usd: 3, quote: gasQuote({ routing: IN_PUBLIC }) }));
    await pass(1);
    expect(card()).toMatchObject({ gas: null, gasOn: false, gasLoading: false });
  });

  it("drops the answer for an old pair of coins: the request is cancelled, and its answer is not shown even if it arrives", async () => {
    // The answer to the first question is already on its way back when the coin is changed: cancelling does not stop it.
    deaf = true;
    const { card } = await pageAsked();
    const first = gasAsked()[0]!;
    // Another coin to pay with: the receiving address stays, so the new pair is asked about after the usual wait.
    card().setFrom(USDC.id);
    expect(first.signal.aborted).toBe(true);
    await pass(401);
    expect(gasAsked()).toHaveLength(2);
    expect(gasAsked()[1]!.body).toEqual({ from: USDC.id, to: USDT.id, pay: "manual", recipient: SOL_ADDRESS });
    first.answer(offered());
    await pass(1);
    expect(card()).toMatchObject({ gas: null, gasLoading: true });
    // The newer answer is the one that is shown.
    const newer: GasQuote = { usd: 3, quote: gasQuote({ from: USDC.id, amountIn: "3000000", amountOut: "19500000" }) };
    gasAsked()[1]!.answer(offered(newer));
    await pass(1);
    expect(card()).toMatchObject({ gas: newer, gasLoading: false });
  });

  it("a cancelled request leaves the newer one alone", async () => {
    const { card } = await pageAsked();
    card().setRecipient(OTHER_SOL_ADDRESS);
    await pass(401);
    expect(gasAsked()[0]!.signal.aborted).toBe(true);
    gasAsked()[1]!.answer(offered());
    await pass(1);
    expect(card()).toMatchObject({ gas: OFFER, gasLoading: false });
  });
});

describe("gas that was switched on is for one swap", () => {
  it("goes back to off, and the old preview goes at once, when the coin received is another one", async () => {
    const { card } = await pageWithGas();
    card().setGasOn(true);
    card().setTo(USDC_SOL.id);
    expect(card()).toMatchObject({ toId: USDC_SOL.id, gasOn: false, gas: null });
    // The new pair is asked about once it has a receiving address, and its preview arrives switched off.
    card().setRecipient(SOL_ADDRESS);
    await pass(401);
    expect(gasAsked()).toHaveLength(2);
    expect(gasAsked()[1]!.body).toEqual({ from: ETH.id, to: USDC_SOL.id, pay: "manual", recipient: SOL_ADDRESS });
    gasAsked()[1]!.answer(offered());
    await pass(1);
    expect(card()).toMatchObject({ gas: OFFER, gasOn: false });
  });

  it("goes back to off, and the old preview goes at once, when the coin paid is another one, and when the two change places", async () => {
    const { card } = await pageWithGas();
    card().setGasOn(true);
    card().setFrom(USDC.id);
    expect(card()).toMatchObject({ fromId: USDC.id, gasOn: false, gas: null });
    await pass(401);
    expect(gasAsked()).toHaveLength(2);
    // The receiving address is still the one on the card: another coin to pay with does not clear it.
    expect(gasAsked()[1]!.body).toEqual({ from: USDC.id, to: USDT.id, pay: "manual", recipient: SOL_ADDRESS });
    gasAsked()[1]!.answer(offered({ usd: 3, quote: gasQuote({ from: USDC.id, amountIn: "3000000" }) }));
    await pass(1);
    card().setGasOn(true);
    expect(card().gasOn).toBe(true);
    // The flip button: what was received is now paid, and the coin now received is a chain's own. Nothing to add, and nothing asked.
    card().setTo(SOL.id);
    expect(card()).toMatchObject({ gasOn: false, gas: null });
    card().flip();
    expect(card()).toMatchObject({ fromId: SOL.id, toId: USDC.id, gasOn: false, gas: null });
  });

  it("stays on through everything that is not another coin or the loss of the address: an amount, a slippage limit, a refund address, the same paying coin chosen again", async () => {
    const { card } = await pageWithGas();
    card().setGasOn(true);
    card().setAmount("0.5");
    card().setSlippage(50);
    card().setRefundTo(EVM_ADDRESS);
    card().setFrom(ETH.id);
    expect(card()).toMatchObject({ recipient: SOL_ADDRESS, gasOn: true, gas: OFFER });
  });

  it("goes back to off once an order has been made", async () => {
    const { card } = await pageWithGas();
    card().setGasOn(true);
    card().orderMade();
    expect(card().gasOn).toBe(false);
  });

  it("is cleared with the card: leaving the page switches it off and takes the preview, a preview still on its way is not shown on the cleared card, and coming back finds it off", async () => {
    const { card, leave, visitSwap } = await pageWithGas();
    card().setGasOn(true);
    // Another valid address changes what is asked: a new preview is on its way as the page is left.
    card().setRecipient(OTHER_SOL_ADDRESS);
    await pass(401);
    expect(gasAsked()).toHaveLength(2);
    expect(card()).toMatchObject({ gasOn: true, gas: OFFER, gasLoading: true });
    leave();
    expect(card()).toMatchObject({ gasOn: false, gas: null, gasFetchedAt: 0, gasLoading: false });
    expect(gasAsked()[1]!.signal.aborted).toBe(true);
    await pass(1000);
    expect(card()).toMatchObject({ gasOn: false, gas: null, gasLoading: false });
    // Back on the page: the card has no address, so nothing is asked. Once one is entered the pair is asked about afresh, and gas is off until it is switched on again.
    visitSwap();
    await pass(60_000);
    expect(gasAsked()).toHaveLength(2);
    expect(card()).toMatchObject({ recipient: "", gasOn: false, gas: null, gasLoading: false });
    card().setRecipient(SOL_ADDRESS);
    await pass(401);
    expect(gasAsked()).toHaveLength(3);
    expect(gasAsked()[2]!.body).toEqual(ASKED);
    gasAsked()[2]!.answer(offered());
    await pass(1);
    expect(card()).toMatchObject({ gas: OFFER, gasOn: false });
  });

  it("a preview that was on its way when the card was cleared is not put on it, even if its answer arrives", async () => {
    deaf = true;
    const { card, leave } = await pageAsked();
    expect(card().gasLoading).toBe(true);
    leave();
    gasAsked()[0]!.answer(offered());
    await pass(1000);
    expect(card()).toMatchObject({ gas: null, gasOn: false, gasLoading: false });
  });

  it("nothing of it is written to the browser's storage, and no file of it reaches for the storage", async () => {
    const { card, leave, visitSwap } = await pageWithGas();
    card().setGasOn(true);
    card().setRecipient(OTHER_SOL_ADDRESS);
    card().setAmount("0.5");
    await pass(401);
    expect(gasAsked()).toHaveLength(2);
    gasAsked().at(-1)!.answer(offered());
    quoteAsked().at(-1)!.answer(QUOTE);
    await pass(1);
    expect(card()).toMatchObject({ gasOn: true, gas: OFFER, quote: QUOTE });
    card().orderMade();
    leave();
    visitSwap();
    await pass(1);
    expect(written).toEqual([]);
    const read = (file: string) => fs.readFileSync(path.resolve("web", "src", file), "utf8");
    for (const file of ["stores/swap.ts", "lib/gas-logic.ts", "components/GasSwitch.tsx", "components/SwapCard.tsx", "components/ReviewSheet.tsx"]) expect(read(file), file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|readKept|writeKept/);
  });
});

describe("when the preview is asked for again", () => {
  it("with the same pair: at one valid receiving address put in place of another, a refund address, a new way of paying or a new sender. The preview on the card stays meanwhile, and gas stays as it was switched", async () => {
    const { card, useWallet } = await pageWithGas();
    card().setGasOn(true);
    // One valid receiving address in place of another (pasted over it): there is an address throughout, so the preview and the switch stay while the new one is asked for.
    card().setRecipient(OTHER_SOL_ADDRESS);
    expect(card()).toMatchObject({ gasOn: true, gas: OFFER, gasLoading: true });
    await pass(401);
    expect(gasAsked()).toHaveLength(2);
    expect(gasAsked()[0]!.body).toEqual(ASKED);
    expect(gasAsked()[1]!.body).toEqual({ from: ETH.id, to: USDT.id, pay: "manual", recipient: OTHER_SOL_ADDRESS });
    const second: GasQuote = { usd: 3, quote: gasQuote({ amountOut: "19100000" }) };
    gasAsked()[1]!.answer(offered(second));
    await pass(1);
    expect(card()).toMatchObject({ gasOn: true, gas: second, gasLoading: false });
    // The refund address, then the first receiving address put back while that is still being asked.
    card().setRefundTo(EVM_ADDRESS);
    await pass(401);
    expect(gasAsked()[2]!.body).toEqual({ from: ETH.id, to: USDT.id, pay: "manual", recipient: OTHER_SOL_ADDRESS, refundTo: EVM_ADDRESS });
    card().setRecipient(SOL_ADDRESS);
    expect(card()).toMatchObject({ gasOn: true, gas: second, gasLoading: true });
    await pass(401);
    expect(gasAsked()).toHaveLength(4);
    expect(gasAsked()[2]!.signal.aborted).toBe(true);
    expect(gasAsked()[3]!.body).toMatchObject({ recipient: SOL_ADDRESS });
    // Paying from a wallet on the paying chain: the sender is named.
    useWallet.setState({ status: "connected", address: OTHER_EVM_ADDRESS, chain: "base" } as never);
    card().setPay("wallet");
    await pass(401);
    expect(gasAsked().at(-1)!.body).toEqual({ from: ETH.id, to: USDT.id, pay: "wallet", recipient: SOL_ADDRESS, refundTo: EVM_ADDRESS, sender: OTHER_EVM_ADDRESS });
    expect(card()).toMatchObject({ gasOn: true, gas: second });
  });

  it("not at all when what would be asked is what was asked: the same way of paying again, an amount, a slippage limit, a wallet that is not paying", async () => {
    const { card, useWallet } = await pageWithGas();
    card().setPay("manual");
    card().setAmount("0.5");
    card().setSlippage(50);
    useWallet.setState({ status: "connected", address: OTHER_EVM_ADDRESS, chain: "base" } as never);
    await pass(401);
    expect(gasAsked()).toHaveLength(1);
    expect(card()).toMatchObject({ gas: OFFER, gasLoading: false });
    expect(quoteAsked().length).toBeGreaterThan(0);
  });

  it("with the quote, every 15 seconds and at Refresh, only while gas is switched on; switched off it is not refreshed on a timer", async () => {
    const { card, useSheet } = await pageWithGas();
    card().setAmount("0.5");
    await pass(401);
    quoteAsked()[0]!.answer(QUOTE);
    await pass(1);
    // Switched off: the quote is asked for again by itself, and at Refresh. The gas preview is not.
    await pass(16_000);
    expect(quoteAsked()).toHaveLength(2);
    quoteAsked()[1]!.answer(QUOTE);
    await pass(1);
    card().refreshNow();
    await pass(1);
    expect(quoteAsked()).toHaveLength(3);
    quoteAsked()[2]!.answer(QUOTE);
    await pass(16_000);
    expect(quoteAsked()).toHaveLength(4);
    quoteAsked()[3]!.answer(QUOTE);
    await pass(1);
    expect(gasAsked()).toHaveLength(1);

    // Switched on: the preview has stood there a while, so it is asked for again at once.
    card().setGasOn(true);
    await pass(1);
    expect(gasAsked()).toHaveLength(2);
    expect(card()).toMatchObject({ gasOn: true, gas: OFFER, gasLoading: true });
    const fresh: GasQuote = { usd: 3, quote: gasQuote({ amountOut: "19200000" }) };
    gasAsked()[1]!.answer(offered(fresh));
    await pass(1);
    expect(card()).toMatchObject({ gasOn: true, gas: fresh, gasLoading: false });
    const fetched = card().gasFetchedAt;

    // From here on it is asked for with every quote: once each time, with the same question.
    await pass(16_000);
    expect(quoteAsked()).toHaveLength(5);
    expect(gasAsked()).toHaveLength(3);
    expect(gasAsked()[2]!.body).toEqual(gasAsked()[0]!.body);
    quoteAsked()[4]!.answer(QUOTE);
    gasAsked()[2]!.answer(offered(fresh));
    await pass(1);
    expect(card().gasFetchedAt).toBeGreaterThan(fetched);
    card().refreshNow();
    await pass(1);
    expect(quoteAsked()).toHaveLength(6);
    expect(gasAsked()).toHaveLength(4);
    quoteAsked()[5]!.answer(QUOTE);
    gasAsked()[3]!.answer(offered(fresh));
    await pass(1);

    // The same pauses: with a sheet open neither is asked for; when it closes, both are.
    useSheet.getState().open("review");
    await pass(40_000);
    expect(quoteAsked()).toHaveLength(6);
    expect(gasAsked()).toHaveLength(4);
    useSheet.getState().close();
    await pass(1);
    expect(quoteAsked()).toHaveLength(7);
    expect(gasAsked()).toHaveLength(5);
    quoteAsked()[6]!.answer(QUOTE);
    gasAsked()[4]!.answer(offered(fresh));
    await pass(1);

    // Switched off again: the quote goes on, the gas preview stops.
    card().setGasOn(false);
    await pass(16_000);
    expect(quoteAsked()).toHaveLength(8);
    expect(gasAsked()).toHaveLength(5);
  });

  it("a refresh that comes back with no offer switches gas off and takes the preview away; so does one that fails", async () => {
    for (const reply of [(request: Asked) => request.answer(NOT_OFFERED), (request: Asked) => request.answer({ error: { code: "try_later", message: "Try again shortly." } }, 503)]) {
      asked = [];
      const { card } = await pageWithGas();
      card().setAmount("0.5");
      await pass(401);
      quoteAsked()[0]!.answer(QUOTE);
      await pass(1);
      card().setGasOn(true);
      card().refreshNow();
      await pass(1);
      expect(gasAsked()).toHaveLength(2);
      expect(card()).toMatchObject({ gasOn: true, gas: OFFER });
      reply(gasAsked()[1]!);
      quoteAsked()[1]!.answer(QUOTE);
      await pass(1);
      expect(card()).toMatchObject({ gasOn: false, gas: null, gasLoading: false, quote: QUOTE });
      // The swap's own quote goes on as ever, without the gas.
      await pass(16_000);
      expect(quoteAsked()).toHaveLength(3);
      expect(gasAsked()).toHaveLength(2);
    }
  });
});

describe("how old a preview may be when it is confirmed", () => {
  const NOW = Date.parse("2026-10-10T12:00:00.000Z");
  const held = { gasOn: true, gas: OFFER, gasFetchedAt: NOW, gasLoading: false };

  it("is no part of the order while gas is off or there is no preview", () => {
    expect(gasAge({ ...held, gasOn: false }, NOW)).toBe("none");
    expect(gasAge({ ...held, gas: null }, NOW)).toBe("none");
  });

  it("is fit for a minute, waited for while it is asked for again, and expired after that minute, exactly as a quote", () => {
    expect(gasAge(held, NOW)).toBe("ready");
    expect(gasAge(held, NOW + 60_000)).toBe("ready");
    expect(gasAge(held, NOW + 60_001)).toBe("expired");
    expect(gasAge({ ...held, gasLoading: true }, NOW)).toBe("loading");
    expect(gasAge({ ...held, gasLoading: true }, NOW + 60_001)).toBe("loading");
  });

  it("the review acts on the quote's age until the quote is fit, and then on the preview's where gas is part of the order", () => {
    const ages: Age[] = ["none", "loading", "ready", "expired"];
    for (const quote of ages) expect(reviewAge(quote, "none"), quote).toBe(quote);
    for (const gas of ages.filter((age) => age !== "none")) expect(reviewAge("ready", gas), gas).toBe(gas);
    for (const quote of ["none", "loading", "expired"] as const) for (const gas of ages) expect(reviewAge(quote, gas)).toBe(quote);
  });
});

describe("what the order request says of gas", () => {
  it("carries gas only when it is switched on and there is a preview: the amount of that preview and its numbers, exactly", () => {
    const part = gasPart(true, OFFER, ETH, BY_ID);
    expect(part).toEqual({ usd: 3, quote: OFFER.quote, coin: SOL });
    expect(gasChoice(part)).toEqual({ gas: { amount: "750000000000000", reviewed: { amountOut: "19000000", minAmountOut: "18810000", totalFeeBps: 20, routing: PRIVATELY } } });
    // Off, or with nothing to review, the field is not there at all.
    expect(gasPart(false, OFFER, ETH, BY_ID)).toBeNull();
    expect(gasPart(true, null, ETH, BY_ID)).toBeNull();
    expect(gasChoice(null)).toEqual({});
    expect("gas" in gasChoice(null)).toBe(false);
    expect(JSON.stringify({ from: "a", ...gasChoice(gasPart(false, OFFER, ETH, BY_ID)) })).toBe('{"from":"a"}');
    // A preview of another paying coin, or of a coin that is not on the list, is no part of this order.
    expect(gasPart(true, OFFER, USDC, BY_ID)).toBeNull();
    expect(gasPart(true, OFFER, null, BY_ID)).toBeNull();
    expect(gasPart(true, { usd: 3, quote: gasQuote({ to: "sol:GONE" }) }, ETH, BY_ID)).toBeNull();
    // The fees that were on screen are added as they are, whatever the server is set to take.
    const feePart = gasPart(true, { usd: 5, quote: gasQuote({ fees: { appBps: 15, providerBps: 20, appAmount: "1", providerAmount: "2" } }) }, ETH, BY_ID);
    expect(gasChoice(feePart).gas?.reviewed.totalFeeBps).toBe(35);
  });

  it("never names where the gas goes, where a refund of it goes, which coin it is or how it is to be routed: only what was reviewed", () => {
    const sent = gasChoice(gasPart(true, OFFER, ETH, BY_ID)).gas!;
    expect(Object.keys(sent)).toEqual(["amount", "reviewed"]);
    expect(Object.keys(sent.reviewed).sort()).toEqual(["amountOut", "minAmountOut", "routing", "totalFeeBps"]);
    expect(JSON.stringify(sent)).not.toMatch(/recipient|refund|sender|address|withoutPrivate|confidentiality|privacy|"to"|"from"|"usd"/i);
    // The one word about routing is the reviewed preview's own, as with a swap's reviewed numbers: an order by another route is not made.
    expect(sent.reviewed.routing).toBe(OFFER.quote.routing);
  });

  it("the review puts it into the request it makes, from the gas on screen, and holds the order that comes back to it", () => {
    const review = fs.readFileSync(path.resolve("web", "src", "components", "ReviewSheet.tsx"), "utf8");
    const body = review.slice(review.indexOf("const body: CreateOrderBody & { requestId: string } = {"), review.indexOf("const order = await api.createOrder(body);"));
    expect(body).toContain("...gasChoice(gas),");
    expect(review).toContain("const gas = gasPart(swap.gasOn, swap.gas, from, tokens);");
    // Nowhere else is the field written.
    expect(review.replace("...gasChoice(gas),", "")).not.toMatch(/\bgas:\s/);
    // The gas order is held to the swap's own two addresses, the ones the swap's order was just held to.
    expect(review).toContain("const reviewedGas: ReviewedGas | null = gas === null ? null : { from: from.id, to: gas.coin.id, amountIn: gas.quote.amountIn, recipient, refundTo };");
    expect(review).toContain("const differs = orderDiffers(order, reviewed) ?? gasDiffers(order.gas, reviewedGas);");
    // Its numbers must settle on screen with the swap's, and its age counts with the quote's.
    expect(review).toMatch(/const quoteKey = quote === null \? null : `[^`]*\$\{gasKey\(gas\)\}`;/);
    expect(review).toContain('const age = reviewAge(quoteAge(swap, now), gas === null ? "none" : gasAge(swap, now));');
    // And once the order is made, the card is told: gas goes back to off there.
    expect(review).toContain("swap.orderMade();");
  });
});

describe("the numbers of a review with gas", () => {
  it("the total sent is the two amounts added exactly, as whole numbers", () => {
    expect(totalSent("500000000000000000", "750000000000000")).toBe(500750000000000000n);
    // Far past what a floating-point number holds exactly.
    expect(totalSent("123456789012345678901234567890", "1")).toBe(123456789012345678901234567891n);
    expect(totalSent("9007199254740993", "9007199254740993")).toBe(18014398509481986n);
    expect(totalSent("0", "3000000")).toBe(3000000n);
  });

  it("the gas order's numbers are part of what must settle on screen: any of them changing, and gas going out of the review, is a change", () => {
    const part = (overrides: Partial<QuoteView> = {}, usd = 3) => gasPart(true, { usd, quote: gasQuote(overrides) }, ETH, BY_ID);
    const key = gasKey(part());
    expect(gasKey(null)).toBe("");
    expect(key).not.toBe("");
    expect(gasKey(part())).toBe(key);
    for (const changed of [part({ amountIn: "750000000000001" }), part({ amountOut: "19000001" }), part({ minAmountOut: "18810001" }), part({ fees: { appBps: 1, providerBps: 20, appAmount: "0", providerAmount: "0" } }), part({ fees: { appBps: 0, providerBps: 21, appAmount: "0", providerAmount: "0" } }), part({}, 5)]) expect(gasKey(changed)).not.toBe(key);
  });
});

describe("the gas order that comes back is held to what was reviewed", () => {
  const REVIEWED: ReviewedGas = { from: ETH.id, to: SOL.id, amountIn: "750000000000000", recipient: SOL_ADDRESS, refundTo: EVM_ADDRESS };
  const gasOrder = (overrides: Partial<OrderView> = {}): OrderView =>
    ({
      id: "GasOrderIdForTheTests000000",
      gasOrder: true,
      from: { id: ETH.id, symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null },
      to: { id: SOL.id, symbol: "SOL", name: "Solana", chain: "sol", decimals: 9, contract: null },
      amountIn: "750000000000000",
      amountOut: "19000000",
      minAmountOut: "18810000",
      recipient: SOL_ADDRESS,
      refundTo: EVM_ADDRESS,
      routing: PRIVATELY,
      ...overrides,
    }) as OrderView;
  const made = (overrides: Partial<OrderView> = {}): GasLine => ({ made: true, order: gasOrder(overrides) });

  it("passes when it is the order that was reviewed", () => {
    expect(gasDiffers(made(), REVIEWED)).toBeNull();
  });

  it("a gas order to any address but the swap's receiving address is a mismatch, and so is a refund address that is not the swap's", () => {
    expect(gasDiffers(made({ recipient: OTHER_SOL_ADDRESS }), REVIEWED)).toBe("the address the gas goes to");
    expect(gasDiffers(made({ recipient: SOL_ADDRESS.toLowerCase() }), REVIEWED)).toBe("the address the gas goes to");
    expect(gasDiffers(made({ recipient: "" }), REVIEWED)).toBe("the address the gas goes to");
    expect(gasDiffers(made({ refundTo: OTHER_EVM_ADDRESS }), REVIEWED)).toBe("the refund address of the gas");
  });

  it("so is another paying coin, another coin delivered, another amount, and any routing but private", () => {
    expect(gasDiffers(made({ from: { ...gasOrder().from, id: USDC.id } }), REVIEWED)).toBe("the coin the gas is paid with");
    expect(gasDiffers(made({ to: { ...gasOrder().to, id: USDT.id } }), REVIEWED)).toBe("the coin that arrives as gas");
    expect(gasDiffers(made({ amountIn: "750000000000001" }), REVIEWED)).toBe("the amount sent for the gas");
    expect(gasDiffers(made({ amountIn: "7500000000000000" }), REVIEWED)).toBe("the amount sent for the gas");
    expect(gasDiffers(made({ routing: IN_PUBLIC }), REVIEWED)).toBe("the routing of the gas");
    expect(gasDiffers(made({ routing: undefined }), REVIEWED)).toBe("the routing of the gas");
  });

  it("gas that could not be added is no mismatch: the swap goes ahead, and its page says so", () => {
    expect(gasDiffers({ made: false }, REVIEWED)).toBeNull();
  });

  it("an answer that does not say what became of the gas, or names a gas order that cannot be looked at, is not the order that was reviewed", () => {
    expect(gasDiffers(undefined, REVIEWED)).toBe("the gas");
    expect(gasDiffers({ made: true, order: null, ended: "delivered" }, REVIEWED)).toBe("the gas");
  });

  it("with no gas reviewed there must be no gas order", () => {
    expect(gasDiffers(undefined, null)).toBeNull();
    expect(gasDiffers({ made: false }, null)).toBeNull();
    expect(gasDiffers(made(), null)).toBe("gas you did not ask for");
    expect(gasDiffers({ made: true, order: null, ended: "expired" }, null)).toBe("gas you did not ask for");
  });
});

// ---- What is drawn ----

/** Markup as text a person would read: tags out, spaces evened. */
const read = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** A part of the site as it is first drawn, with the stores holding what the drawing needs for its length: a ready swap of 0.5 ETH for USDT, sent by hand, on a server that routes privately. */
function draw(element: ReactElement, held: { swap?: Record<string, unknown>; ghost?: boolean; mode?: Confidentiality; wallet?: Record<string, unknown>; coins?: TokenView[] } = {}): string {
  const coins = held.coins ?? LIST;
  const wanted: [{ getInitialState(): object }, Record<string, unknown>][] = [
    [useApp, { config: { privacyMode: held.mode ?? "basic", paused: false, termsVersion: "2026-10-10", statsPage: false } }],
    [useGhost, { on: held.ghost ?? false, fresh: false }],
    [useWallet, held.wallet ?? {}],
    [useTokens, { status: "ready", tokens: coins, byId: new Map(coins.map((token) => [token.id, token])) }],
    [useSwap, { fromId: ETH.id, toId: USDT.id, amountText: "0.5", pay: "manual", recipient: SOL_ADDRESS, refundTo: EVM_ADDRESS, quote: QUOTE, fetchedAt: Date.now(), loading: false, dirty: false, problem: null, withoutPrivate: false, gasOn: false, gas: null, gasFetchedAt: 0, gasLoading: false, ...held.swap }],
  ];
  const before = wanted.map(([store, values]) => {
    const first = store.getInitialState() as Record<string, unknown>;
    const kept = Object.fromEntries(Object.keys(values).map((key) => [key, first[key]]));
    Object.assign(first, values);
    return [first, kept] as const;
  });
  try {
    return renderToStaticMarkup(element);
  } finally {
    for (const [first, kept] of before) Object.assign(first, kept);
  }
}

describe("the switch on the card", () => {
  const card = (held: Parameters<typeof draw>[1] = {}) => draw(createElement(SwapCard), held);
  const place = (html: string) => /<div class="card-gas"[^>]*>[\s\S]*?(?=<div class="address-field"|<div class="quote")/.exec(html)?.[0] ?? "";

  it("its line says the size and the coin", () => {
    expect(GAS_LABEL).toBe("Add gas");
    expect(gasLine(3, "SOL")).toBe("About $3 of SOL arrives at the same address, so a new wallet can move straight away.");
    expect(gasLine(5, "ETH")).toBe("About $5 of ETH arrives at the same address, so a new wallet can move straight away.");
    expect(gasLine(10, "TRX")).toBe("About $10 of TRX arrives at the same address, so a new wallet can move straight away.");
  });

  it("is a real switch under the receiving address, named \"Add gas\", off until it is pressed, with its one line", () => {
    const html = card({ swap: { gas: OFFER, gasFetchedAt: Date.now() } });
    const drawn = place(html);
    expect(drawn).toMatch(/^<div class="card-gas" data-open="true"><div class="card-gas-slot"><button type="button" role="switch" aria-checked="false" aria-labelledby="([^"]+)-name" aria-describedby="\1-line" class="gas-switch">/);
    expect(read(drawn)).toBe("Add gas About $3 of SOL arrives at the same address, so a new wallet can move straight away.");
    // It can be pressed: nothing about it is disabled.
    expect(drawn).not.toMatch(/disabled|aria-disabled|skeleton/);
    // Its place: after the receiving address, before the refund address and the quote.
    expect(html.indexOf("Receiving address")).toBeLessThan(html.indexOf('class="card-gas"'));
    expect(html.indexOf('class="card-gas"')).toBeLessThan(html.indexOf("Refund address"));
    expect(html.indexOf('class="card-gas"')).toBeLessThan(html.indexOf('class="quote"'));
    // Switched on, and for a size and a coin of the server's own saying.
    expect(place(card({ swap: { gas: OFFER, gasOn: true } }))).toContain('role="switch" aria-checked="true"');
    const onBase = { usd: 5, quote: gasQuote({ from: SOL.id, to: ETH.id }) };
    expect(read(place(card({ swap: { fromId: SOL.id, toId: USDC.id, recipient: EVM_ADDRESS, refundTo: SOL_ADDRESS, quote: null, gas: onBase } })))).toBe("Add gas About $5 of ETH arrives at the same address, so a new wallet can move straight away.");
  });

  it("is not there at all where gas is not offered: no switch that cannot be pressed, no words, no place kept", () => {
    for (const held of [{}, { swap: { gasLoading: true } }, { swap: { gasOn: true } }, { mode: "public" as const }]) {
      const html = card(held);
      expect(place(html)).toBe('<div class="card-gas"><div class="card-gas-slot"></div></div>');
      expect(html).not.toMatch(/role="switch"|gas-switch|skeleton-gas/);
      expect(read(html)).not.toMatch(/gas/i);
    }
    // A preview that names a coin the list does not have draws nothing either.
    expect(place(card({ swap: { gas: { usd: 3, quote: gasQuote({ to: "sol:GONE" }) } } }))).toBe('<div class="card-gas"><div class="card-gas-slot"></div></div>');
  });

  it("is the same in Ghost mode", () => {
    const plain = place(card({ swap: { gas: OFFER } }));
    const inGhost = place(card({ ghost: true, swap: { gas: OFFER } }));
    const ids = /_r_\w+_|«\w+»|:r\w*:/g;
    expect(inGhost.replace(ids, "")).toBe(plain.replace(ids, ""));
    expect(inGhost).toContain('role="switch"');
  });

  it("opens as the quote's line does, and where less movement is asked for it is simply there; the keyboard's mark is the site's own", () => {
    const css = fs.readFileSync(path.resolve("web", "src", "styles", "card.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.card-gas \{\s*display: grid;\s*grid-template-rows: 0fr;\s*transition: grid-template-rows var\(--motion-base\) var\(--ease-out\);\s*\}/);
    expect(css).toMatch(/\.card-gas\[data-open\] \{\s*grid-template-rows: 1fr;\s*\}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.card-gas,\s*\.gas-switch-thumb \{\s*transition: none;\s*\}\s*\}/);
    // At least 44 px to press, and no ring or colour of its own for the focus: the one quiet line, drawn inside its edge.
    expect(css).toMatch(/\.gas-switch \{[^}]*min-height: var\(--height-44\);/);
    expect(css).toMatch(/:root\[data-keys\] \.gas-switch:focus-visible \{\s*outline-offset: calc\(var\(--border-width\) \* -2\);\s*\}/);
    const own = [...css.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].filter((rule) => /gas/.test(rule[1]!));
    expect(own.length).toBeGreaterThan(8);
    for (const rule of own) expect(rule[2], rule[1]!.trim()).not.toMatch(/var\(--accent\)|box-shadow|outline(-color)?:[^;]*var\(--(?!border-width)/);
  });
});

describe("paying from a wallet with gas switched on: two payments of the one coin", () => {
  const input = { paused: false, coinsReady: true, from: ETH, to: USDT, amountText: "0.5", pay: "wallet" as const, walletConnected: true, balance: null as bigint | null, recipient: SOL_ADDRESS, refundTo: EVM_ADDRESS, quote: "ready" as const, problem: null, impactUnconfirmed: false };
  const GAS_AMOUNT = 750_000_000_000_000n;
  const HALF = 500_000_000_000_000_000n;

  it("a balance that covers the swap and not the gas too is said on the card's button, before anything is reviewed", () => {
    expect(primaryAction({ ...input, balance: HALF, gasAmount: GAS_AMOUNT })).toEqual({ kind: "blocked", label: "Not enough ETH with gas", disabled: true, busy: false });
    expect(primaryAction({ ...input, balance: HALF + GAS_AMOUNT - 1n, gasAmount: GAS_AMOUNT }).label).toBe("Not enough ETH with gas");
    // Exactly enough for both, to the last unit, is enough.
    expect(primaryAction({ ...input, balance: HALF + GAS_AMOUNT, gasAmount: GAS_AMOUNT }).label).toBe("Review swap");
    // Not enough for the swap itself is said as ever.
    expect(primaryAction({ ...input, balance: HALF - 1n, gasAmount: GAS_AMOUNT }).label).toBe("Not enough ETH");
    // A long symbol: the label still fits the button on one line.
    expect(primaryAction({ ...input, from: { ...ETH, symbol: "LONGSYMBOL" }, balance: HALF, gasAmount: GAS_AMOUNT }).label).toBe("Not enough with gas");
  });

  it("without gas, sending it by hand, or with a balance that is not known, nothing changes", () => {
    for (const gasAmount of [null, undefined]) expect(primaryAction({ ...input, balance: HALF, gasAmount }).label).toBe("Review swap");
    expect(primaryAction({ ...input, pay: "manual", balance: HALF, gasAmount: GAS_AMOUNT }).label).toBe("Review swap");
    expect(primaryAction({ ...input, balance: null, gasAmount: GAS_AMOUNT }).label).toBe("Review swap");
  });

  it("\"Max\" leaves room for the gas payment, on top of what it keeps back for network fees", () => {
    expect(maxSpendable(1_000_000_000_000_000_000n, ETH, "0.0001", GAS_AMOUNT)).toBe("0.99915");
    expect(maxSpendable(25_000_000n, USDC, undefined, 3_000_000n)).toBe("22");
    expect(maxSpendable(2_000_000n, USDC, undefined, 3_000_000n)).toBe("0");
    // With no gas it is what it always was.
    expect(maxSpendable(1_000_000_000_000_000_000n, ETH, "0.0001")).toBe("0.9999");
    expect(maxSpendable(1_000_000_000_000_000_000n, ETH, "0.0001", 0n)).toBe("0.9999");
  });

  it("the card counts the gas only while it is switched on", () => {
    // A wallet on Base that holds exactly the half an ETH being swapped.
    const payable = LIST.map((token) => (token.id === ETH.id ? { ...token, wallet: true } : token));
    const wallet = { status: "connected", address: EVM_ADDRESS, chain: "base", chainId: 8453, plain: true, balances: new Map([[ETH.id, HALF]]) };
    const button = (swap: Record<string, unknown>) => /<div class="card-submit"><button[^>]*>([^<]*)<\/button>/.exec(draw(createElement(SwapCard), { coins: payable, wallet, swap: { pay: "wallet", ...swap } }))?.[1];
    expect(button({ gas: OFFER, gasOn: true })).toBe("Not enough ETH with gas");
    expect(button({ gas: OFFER, gasOn: false })).toBe("Review swap");
    expect(button({})).toBe("Review swap");
    const card = fs.readFileSync(path.resolve("web", "src", "components", "SwapCard.tsx"), "utf8");
    expect(card).toContain("const gasAmount = swap.gasOn && swap.gas !== null ? BigInt(swap.gas.quote.amountIn) : null;");
    expect(card).toContain("swap.setAmount(maxSpendable(balance, from, NATIVE_RESERVE[from.chain], gasAmount ?? 0n));");
  });
});

describe("the review with gas", () => {
  const sheet = (held: Parameters<typeof draw>[1] = {}) => draw(createElement(ReviewSheet), held);
  const withGas = (swap: Record<string, unknown> = {}) => sheet({ swap: { gas: OFFER, gasOn: true, gasFetchedAt: Date.now(), ...swap } });
  const rows = (html: string) => [...html.matchAll(/<div class="review-row"[^>]*><dt class="muted">([^<]*)<\/dt>/g)].map((match) => match[1]);
  const button = (html: string) => read(/<button type="button" class="button-primary"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? "");
  const SWAP_ROWS = ["You send", "You receive, about", "Routing", "Minimum received", "Rate", "IntentSwap fee", "Provider fee", "Solana network fee", "Estimated time", "Price impact", "Time to pay"];
  const GAS_ROWS = ["You send", "You receive, about", "Routing", "IntentSwap fee", "Provider fee", "Solana network fee", "Arrives at"];

  it("has two parts and a total: the swap as ever, then \"Gas\" with what is sent, what arrives, its fees and where it goes, then what is sent in all", () => {
    const html = withGas();
    expect(rows(html)).toEqual([...SWAP_ROWS, ...GAS_ROWS, "Total sent"]);
    const part = /<section class="review-gas">[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(part).toMatch(/^<section class="review-gas"><h3 class="review-part">Gas<span class="muted"> · Solana<\/span><\/h3><dl class="review-rows">/);
    const said = read(part);
    // Exact figures: what is sent, of the coin the swap is paid with, and what arrives, of the chain's own coin.
    expect(said).toContain("You send 0.00075 ETH on Base");
    expect(said).toContain("You receive, about 0.019 SOL on Solana");
    expect(part).toContain('<span class="chip routing-tag" data-tone="private">Private</span>');
    expect(said).toContain("IntentSwap fee None");
    expect(said).toContain("Provider fee 0.0000015 ETH 0.20%");
    expect(said).toContain("Solana network fee 0.000005 SOL included above");
    expect(said).toContain("Arrives at The same receiving address");
    // No address of its own is shown for the gas: there is one receiving address in the review, the swap's.
    expect(html.match(/Receiving address/g)).toHaveLength(1);
    expect(part).not.toContain(SOL_ADDRESS);
    // The total: 0.5 + 0.00075, every digit.
    expect(read(html)).toContain("Total sent 0.50075 ETH on Base");
    // The swap's own part is drawn as it is without gas.
    const swapPart = (drawn: string) => /<dl class="review-rows">[\s\S]*?<\/dl>/.exec(drawn)?.[0] ?? "";
    expect(swapPart(html)).not.toBe("");
    expect(swapPart(html)).toBe(swapPart(sheet()));
  });

  it("says, with the plain sentences above the Terms, that there are two payments", () => {
    expect(TWO_PAYMENTS).toBe("There are two payments: one for the swap and one for the gas.");
    const html = withGas();
    expect(html).toContain(`<p class="review-plain muted">${TWO_PAYMENTS}</p>`);
    expect(read(html)).toContain(`an order cannot be changed once it is made. ${TWO_PAYMENTS} I have read and accept the Terms of Use`);
  });

  it("gives a fee of IntentSwap's in figures where the server takes one, and says so where the network fee is not known apart", () => {
    const html = withGas({ gas: { usd: 3, quote: gasQuote({ fees: { appBps: 10, providerBps: 20, appAmount: "750000000000", providerAmount: "1500000000000" }, withdrawFee: null }) } });
    const said = read(/<section class="review-gas">[\s\S]*?<\/section>/.exec(html)?.[0] ?? "");
    expect(said).toContain("IntentSwap fee 0.00000075 ETH 0.10%");
    expect(said).toContain("Solana network fee Included above");
  });

  it("without gas is the review it always was: no second part, no total, no sentence about two payments", () => {
    for (const swap of [{}, { gas: OFFER, gasOn: false }, { gas: null, gasOn: true }, { gas: OFFER, gasOn: true, fromId: USDC.id }]) {
      const html = sheet({ swap });
      if (swap.fromId === undefined) expect(rows(html)).toEqual(SWAP_ROWS);
      expect(html).not.toMatch(/review-gas|review-part|Total sent|Arrives at/);
      expect(read(html)).not.toMatch(/two payments|\bGas\b|\bgas\b/);
    }
  });

  it("a preview older than a quote may be is not confirmed: the numbers are dimmed and the button refreshes; one being asked for again is waited for", () => {
    const fresh = withGas();
    expect(button(fresh)).toBe("Accept the Terms to continue");
    expect(fresh).not.toContain("data-stale");
    const old = withGas({ gasFetchedAt: Date.now() - 60_001 });
    expect(button(old)).toBe("Refresh quote");
    expect(read(old)).toContain("This quote has expired. Refresh it to see the numbers as they are now.");
    expect(old.match(/<dl class="review-rows" data-stale="true">/g)).toHaveLength(3);
    const asking = withGas({ gasLoading: true });
    expect(button(asking)).toBe("Getting a quote…");
    // With gas off, the same old preview is nobody's business.
    expect(button(sheet({ swap: { gas: OFFER, gasOn: false, gasFetchedAt: Date.now() - 600_000 } }))).toBe("Accept the Terms to continue");
  });

  it("says in plain words when gas has gone out of a review", () => {
    expect(GAS_WITHDRAWN).toBe("Gas cannot be added right now, so it is no longer part of this order. The swap is unaffected.");
    const review = fs.readFileSync(path.resolve("web", "src", "components", "ReviewSheet.tsx"), "utf8");
    expect(review).toContain("const gasWithdrawn = hadGas && gas === null;");
    expect(review).toMatch(/\{gasWithdrawn \? \(\s*<p className="notice notice-warning" role="alert">[\s\S]*?<span>\{GAS_WITHDRAWN\}<\/span>/);
    // A review that never had gas says nothing of it.
    expect(read(sheet())).not.toContain("Gas cannot be added");
  });
});
