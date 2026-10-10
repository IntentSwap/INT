// The swap page always starts fresh: leaving it and coming back shows the card as a first visit
// does, and nothing typed into the card is written to the browser's storage.
// Runs without a browser: the network and the browser's storage are stand-ins, and time is moved by hand.

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuoteView, TokenView } from "../shared/api.ts";
import { useApp } from "../web/src/stores/app.ts";
import { useSheet } from "../web/src/stores/sheet.ts";
import { useSwap, visitSwap } from "../web/src/stores/swap.ts";
import { useTokens } from "../web/src/stores/tokens.ts";

const coin = (symbol: string, chain: string, decimals: number, wallet: boolean): TokenView => ({ id: `${chain}:${symbol}`, symbol, name: symbol, chain, decimals, price: "1", contract: null, wallet });
const ETH = coin("ETH", "base", 18, true);
const USDT = coin("USDT", "sol", 6, false);
const USDC = coin("USDC", "base", 6, true);
const COINS = { status: "ready" as const, tokens: [ETH, USDT, USDC], byId: new Map([ETH, USDT, USDC].map((token) => [token.id, token])) };
// What the person types. Made up from fixed text, so the addresses are nobody's.
const AMOUNT = "417.3";
const RECEIVING = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const REFUND = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";

const quote = (amountOut: string): QuoteView => ({
  from: USDC.id,
  to: USDT.id,
  amountIn: "417300000",
  amountOut,
  minAmountOut: amountOut,
  amountInUsd: "417.3",
  amountOutUsd: "417",
  slippageBps: 50,
  timeEstimate: 30,
  fees: { appBps: 20, providerBps: 20, appAmount: "1", providerAmount: "1" },
  withdrawFee: null,
  refundFee: null,
  priceImpactBps: 0,
  serverNow: "2026-10-08T12:00:00.000Z",
});

interface Asked {
  body: Record<string, unknown>;
  signal: AbortSignal;
  answer(view: QuoteView): void;
}
let asked: Asked[] = [];
/** Everything written to the browser's storage, of either kind, while a test runs. */
let written: string[][] = [];
/** The address the browser shows, as far as the card reads it. There is no history here at all: a card that touched it would fail. */
const address = { search: "" };

beforeEach(() => {
  vi.useFakeTimers();
  asked = [];
  written = [];
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
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      asked.push({ body: JSON.parse(String(init.body)) as Record<string, unknown>, signal, answer: (view) => resolve(new Response(JSON.stringify(view))) });
    });
  });
  useTokens.setState(COINS);
  useSwap.getState().reset();
  useSheet.setState({ current: null });
  // A server that routes privately, so that the person's choice of public routing can be made and seen to be cleared.
  useApp.setState({ config: { privacyMode: "basic" } as never });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets promises settle and moves the clock. */
const pass = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};
/** What a card holds, without the things it can do. */
const held = (state: object) => Object.fromEntries(Object.entries(state).filter(([, value]) => typeof value !== "function"));

describe("the swap page always starts fresh", () => {
  it("leaving the page clears the card, an answer still on its way is not shown, coming back finds the card of a first visit, and nothing typed is written to the browser's storage", async () => {
    // A first visit: the usual pair, and nothing else.
    const leave = visitSwap();
    const first = held(useSwap.getState());
    expect(first).toEqual({ fromId: ETH.id, toId: USDT.id, amountText: "", pay: "wallet", recipient: "", refundTo: "", impactConfirmed: false, slippageBps: 100, withoutPrivate: false, quote: null, fetchedAt: 0, loading: false, dirty: false, problem: null, gasOn: false, gas: null, gasFetchedAt: 0, gasLoading: false });

    // The card is filled as a person fills it: another coin, an amount, paying by hand, both addresses, a slippage limit, and a quote on screen.
    const swap = useSwap.getState();
    swap.setFrom(USDC.id);
    swap.setTo(ETH.id);
    swap.flip();
    swap.setFrom(USDC.id);
    swap.setTo(USDT.id);
    swap.setAmount(AMOUNT);
    swap.setPay("manual");
    swap.setRecipient(RECEIVING);
    swap.setRefundTo(REFUND);
    swap.setSlippage(50);
    await pass(401);
    asked.at(-1)!.answer(quote("416900000"));
    await pass(1);
    // Their own choice of public routing, which asks for a quote at once: answered. Then a tick, the review opened, and a refresh that is still unanswered.
    swap.setWithoutPrivate(true);
    await pass(1);
    asked.at(-1)!.answer(quote("416900000"));
    await pass(1);
    swap.setImpactConfirmed(true);
    useSheet.getState().open("review");
    swap.refreshNow();
    await pass(1);
    const flying = asked.at(-1)!;
    expect(flying.signal.aborted).toBe(false);
    const filled = held(useSwap.getState());
    expect(filled).toMatchObject({ fromId: USDC.id, toId: USDT.id, amountText: AMOUNT, pay: "manual", recipient: RECEIVING, refundTo: REFUND, impactConfirmed: true, slippageBps: 50, withoutPrivate: true, quote: { amountOut: "416900000" }, loading: true });
    // Every part of the card that a person or a quote can change has been changed: none is the same as on the first visit.
    // (All but what the card holds of "Add gas": no gas can be added beside these coins. That part is filled, and seen to be cleared, in gas-card.test.ts.)
    for (const key of Object.keys(first)) if (key !== "dirty" && key !== "problem" && key !== "toId" && !key.startsWith("gas")) expect(filled[key], key).not.toEqual(first[key]);

    // The person goes to another page. The card is cleared there and then: it holds what a card holds before it is given its coins.
    leave();
    expect(held(useSwap.getState())).toEqual(held(useSwap.getInitialState()));
    expect(held(useSwap.getState())).toMatchObject({ fromId: null, toId: null, amountText: "", recipient: "", refundTo: "", quote: null });
    // The review went with it, and the request that was in flight was cancelled.
    expect(useSheet.getState().current).toBeNull();
    expect(flying.signal.aborted).toBe(true);
    // Its answer arriving all the same, and the wait after a keystroke running out, put nothing on the cleared card.
    flying.answer(quote("555"));
    await pass(1000);
    expect(held(useSwap.getState())).toEqual(held(useSwap.getInitialState()));
    const requests = asked.length;

    // They come back, by whatever way. The card is the card of a first visit, part for part.
    visitSwap();
    expect(held(useSwap.getState())).toEqual(first);
    // And it is the card of a browser that never saw any of this: the same code, loaded anew, and visited once.
    vi.resetModules();
    const untouched = await import("../web/src/stores/swap.ts");
    (await import("../web/src/stores/tokens.ts")).useTokens.setState(COINS);
    expect(untouched.useSwap).not.toBe(useSwap);
    untouched.visitSwap();
    expect(held(useSwap.getState())).toEqual(held(untouched.useSwap.getState()));
    // Nothing is asked for on a card with no amount, and no late answer is waited for.
    await pass(1000);
    expect(asked).toHaveLength(requests);
    expect(held(useSwap.getState())).toEqual(first);

    // Through all of it nothing was written to the browser's storage: no amount, no address, no pair, nothing at all.
    expect(written).toEqual([]);
    for (const typed of [AMOUNT, "417300000", RECEIVING, REFUND, USDC.id]) expect(JSON.stringify(written)).not.toContain(typed);
  });

  it("a link's pair and amount fill the card once, on arrival: not again while the person stays, not after coming back by another address, and again at the link's own address", async () => {
    const link = `?from=base:USDC&to=sol:USDT&amount=${AMOUNT}`;
    address.search = link;
    const leave = visitSwap();
    expect(useSwap.getState()).toMatchObject({ fromId: USDC.id, toId: USDT.id, amountText: AMOUNT });
    await pass(401);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.body).toMatchObject({ from: USDC.id, to: USDT.id, amount: "417300000" });
    // The person changes the amount. The coin list arriving again, which gives a card its coins, does not put the link's amount back.
    useSwap.getState().setAmount("2");
    useSwap.getState().init(address.search);
    expect(useSwap.getState().amountText).toBe("2");
    // Away, and back by the "Swap" link: the address says nothing, and the card is the usual one.
    leave();
    address.search = "";
    const leaveAgain = visitSwap();
    expect(useSwap.getState()).toMatchObject({ fromId: ETH.id, toId: USDT.id, amountText: "", quote: null });
    // Away, and back with the browser's Back button to the link's own address, which still says what it said.
    leaveAgain();
    address.search = link;
    visitSwap();
    expect(useSwap.getState()).toMatchObject({ fromId: USDC.id, toId: USDT.id, amountText: AMOUNT });
  });

  it("the swap page calls for it as it comes and goes, \"Swap again\" leads to the swap page and carries nothing, and no part of the card reaches for the browser's storage", () => {
    const read = (file: string) => fs.readFileSync(path.resolve("web", "src", file), "utf8");
    // Once as the page comes onto the screen, and what it returns as the page is left.
    expect(read("pages/SwapPage.tsx")).toMatch(/useLayoutEffect\(\(\) => visitSwap\(\), \[\]\);/);
    expect(read("pages/OrderPage.tsx")).toMatch(/<PrimaryButton onClick=\{\(\) => navigate\("\/"\)\}>\{order\.status === "expired" \? "Start a new swap" : "Swap again"\}<\/PrimaryButton>/);
    for (const file of ["stores/swap.ts", "stores/picker.ts", "stores/sheet.ts", "pages/SwapPage.tsx", "components/SwapCard.tsx", "components/ReviewSheet.tsx", "components/SlippageSheet.tsx", "components/CoinPicker.tsx", "components/AddressField.tsx", "components/AmountField.tsx", "components/QuotePanel.tsx"]) {
      expect(read(file), file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });
});
