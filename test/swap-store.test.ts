// The swap card's state: what happens to the inputs and to requests in flight.
// Runs without a browser: the network is a stand-in, and time is moved by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routingOf, type Confidentiality, type QuoteView, type TokenView } from "../shared/api.ts";
import { PRIVATE_UNAVAILABLE } from "../web/src/lib/swap-logic.ts";
import { useApp } from "../web/src/stores/app.ts";
import { heardRouting, useSwap } from "../web/src/stores/swap.ts";
import { useTokens } from "../web/src/stores/tokens.ts";

const coin = (symbol: string, chain: string, decimals: number): TokenView => ({ id: `${chain}:${symbol}`, symbol, name: symbol, chain, decimals, price: "1", contract: null, wallet: false });
const ETH = coin("ETH", "base", 18);
const USDT = coin("USDT", "sol", 6);
const USDC = coin("USDC", "base", 6);
const SOL_ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const quote = (amountOut: string): QuoteView => ({
  from: ETH.id,
  to: USDT.id,
  amountIn: "500000000000000000",
  amountOut,
  minAmountOut: amountOut,
  amountInUsd: "1",
  amountOutUsd: "1",
  slippageBps: 100,
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

beforeEach(() => {
  vi.useFakeTimers();
  asked = [];
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
  useTokens.setState({ status: "ready", tokens: [ETH, USDT, USDC], byId: new Map([ETH, USDT, USDC].map((t) => [t.id, t])) });
  useSwap.setState({ fromId: ETH.id, toId: USDT.id, amountText: "", pay: "manual", recipient: "", refundTo: "", quote: null, fetchedAt: 0, loading: false, dirty: false, problem: null, impactConfirmed: false, slippageBps: 100, withoutPrivate: false });
  // The server has not said how it routes swaps. Tests of private routing say it themselves.
  useApp.setState({ config: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets promises settle and moves the clock. */
const pass = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("asking for a quote", () => {
  it("waits 400 ms after the last keystroke, and asks once", async () => {
    const swap = useSwap.getState();
    swap.setAmount("0");
    swap.setAmount("0.");
    swap.setAmount("0.5");
    await pass(399);
    expect(asked).toHaveLength(0);
    expect(useSwap.getState()).toMatchObject({ loading: true, dirty: true });
    await pass(2);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.body).toEqual({ from: ETH.id, to: USDT.id, amount: "500000000000000000", pay: "manual", slippageBps: 100 });
  });

  it("never sends a fee or a deposit address, and sends an address only once it is valid", async () => {
    const swap = useSwap.getState();
    swap.setAmount("0.5");
    swap.setRecipient("not an address");
    await pass(401);
    expect(Object.keys(asked[0]!.body).sort()).toEqual(["amount", "from", "pay", "slippageBps", "to"]);
    useSwap.getState().setRecipient(SOL_ADDRESS);
    await pass(401);
    expect(asked.at(-1)!.body).toMatchObject({ recipient: SOL_ADDRESS });
    for (const request of asked) for (const key of Object.keys(request.body)) expect(["amount", "from", "pay", "slippageBps", "to", "recipient", "refundTo", "sender"]).toContain(key);
  });

  it("sends the slippage limit the person chose, asks again when it changes, and ignores a limit outside the bounds", async () => {
    const swap = useSwap.getState();
    swap.setAmount("0.5");
    await pass(401);
    expect(asked).toHaveLength(1);
    useSwap.getState().setSlippage(50);
    await pass(401);
    expect(asked).toHaveLength(2);
    expect(asked[1]!.body).toMatchObject({ slippageBps: 50 });
    // The same limit again, or one the server would refuse: nothing changes and nothing is asked.
    for (const bad of [50, 9, 501, 0, -100, 1.5, Number.NaN]) useSwap.getState().setSlippage(bad);
    await pass(500);
    expect(asked).toHaveLength(2);
    expect(useSwap.getState().slippageBps).toBe(50);
  });

  it("cancels the request still in flight when the amount changes, and ignores its answer", async () => {
    useSwap.getState().setAmount("0.5");
    await pass(401);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.signal.aborted).toBe(false);
    // A new keystroke while the first request is unanswered.
    useSwap.getState().setAmount("0.6");
    expect(asked[0]!.signal.aborted).toBe(true);
    await pass(401);
    expect(asked).toHaveLength(2);
    expect(asked[1]!.body.amount).toBe("600000000000000000");
    // Even if the old answer were to arrive late, it is not shown.
    asked[0]!.answer(quote("111"));
    asked[1]!.answer(quote("222"));
    await pass(1);
    expect(useSwap.getState().quote?.amountOut).toBe("222");
    expect(useSwap.getState()).toMatchObject({ loading: false, dirty: false });
  });

  it("gives up on a request that is never answered, and offers another try", async () => {
    useSwap.getState().setAmount("0.5");
    await pass(401);
    await pass(20_001);
    expect(asked[0]!.signal.aborted).toBe(true);
    expect(useSwap.getState()).toMatchObject({ loading: false, quote: null, problem: { code: "network", message: "The quote is taking too long. Try again." } });
  });

  it("asks nothing when there is no amount", async () => {
    useSwap.getState().setAmount("");
    await pass(1000);
    expect(asked).toHaveLength(0);
    expect(useSwap.getState()).toMatchObject({ loading: false, quote: null });
  });
});

describe("the flip button", () => {
  it("swaps the two coins and moves what was being received into what is paid", async () => {
    useSwap.setState({ amountText: "0.5", recipient: SOL_ADDRESS, refundTo: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", quote: quote("1261340512") });
    useSwap.getState().flip();
    const state = useSwap.getState();
    expect(state.fromId).toBe(USDT.id);
    expect(state.toId).toBe(ETH.id);
    // The exact amount, every digit, in the units of the coin now being paid.
    expect(state.amountText).toBe("1261.340512");
    // Addresses were for the other chains: they do not carry over.
    expect(state).toMatchObject({ recipient: "", refundTo: "" });
    // The old numbers described the other direction, so they go, and a new quote is asked for.
    expect(state.quote).toBeNull();
    await pass(401);
    expect(asked.at(-1)!.body).toMatchObject({ from: USDT.id, to: ETH.id, amount: "1261340512" });
  });

  it("keeps the typed amount when there was no quote to take it from", () => {
    useSwap.setState({ amountText: "0.5", quote: null });
    useSwap.getState().flip();
    expect(useSwap.getState()).toMatchObject({ fromId: USDT.id, toId: ETH.id, amountText: "0.5" });
  });

  it("choosing, for one side, the coin already on the other side swaps the two", () => {
    useSwap.getState().setFrom(USDT.id);
    expect(useSwap.getState()).toMatchObject({ fromId: USDT.id, toId: ETH.id });
    useSwap.getState().setTo(USDT.id);
    expect(useSwap.getState()).toMatchObject({ fromId: ETH.id, toId: USDT.id });
  });
});

describe("routing one swap in public, by the person's own choice", () => {
  /** What the server told the page about how it routes swaps. */
  const serverRoutes = (privacyMode: Confidentiality) => useApp.setState({ config: { privacyMode } as never });
  /** Every word a request could use to name a routing level. The page sends none of them. */
  const NAMES_A_LEVEL = /confidential|routing|privacy|level|public|basic/i;
  const lastBody = () => asked.at(-1)!.body;

  it("sends nothing about routing until public routing is chosen, and then only withoutPrivate: true", async () => {
    serverRoutes("basic");
    useSwap.getState().setAmount("0.5");
    await pass(401);
    expect(asked).toHaveLength(1);
    expect(lastBody()).toEqual({ from: ETH.id, to: USDT.id, amount: "500000000000000000", pay: "manual", slippageBps: 100 });
    useSwap.getState().setWithoutPrivate(true);
    await pass(1);
    expect(asked).toHaveLength(2);
    expect(lastBody()).toEqual({ from: ETH.id, to: USDT.id, amount: "500000000000000000", pay: "manual", slippageBps: 100, withoutPrivate: true });
    // Going back to private routing: the field is gone again, not sent as false.
    useSwap.getState().setWithoutPrivate(false);
    await pass(1);
    expect(asked).toHaveLength(3);
    expect(Object.keys(lastBody())).not.toContain("withoutPrivate");
    // No request ever names a level: that is the server's setting.
    for (const request of asked) expect(Object.keys(request.body).filter((key) => NAMES_A_LEVEL.test(key))).toEqual([]);
  });

  it("asks for a new quote at once when it is chosen and when it is taken back, and drops the numbers that were for the other route", async () => {
    serverRoutes("basic");
    useSwap.getState().setAmount("0.5");
    await pass(401);
    asked[0]!.answer(quote("111"));
    await pass(1);
    expect(useSwap.getState().quote?.amountOut).toBe("111");
    useSwap.getState().setWithoutPrivate(true);
    // At once: the old numbers are gone and nothing may be pressed, before any time has passed.
    expect(useSwap.getState()).toMatchObject({ withoutPrivate: true, quote: null, loading: true, dirty: true, problem: null });
    // No 400 ms wait, as there is after a keystroke.
    await pass(1);
    expect(asked).toHaveLength(2);
    asked[1]!.answer(quote("222"));
    await pass(1);
    expect(useSwap.getState()).toMatchObject({ loading: false, dirty: false, quote: { amountOut: "222" } });
    // The same value again changes nothing and asks nothing.
    useSwap.getState().setWithoutPrivate(true);
    await pass(500);
    expect(asked).toHaveLength(2);
    // And it is asked once, not a second time when the usual pause runs out.
    useSwap.getState().setWithoutPrivate(false);
    await pass(1000);
    expect(asked).toHaveLength(3);
  });

  it("cancels the private request still in flight when public routing is chosen, and ignores its answer", async () => {
    serverRoutes("basic");
    useSwap.getState().setAmount("0.5");
    await pass(401);
    useSwap.getState().setWithoutPrivate(true);
    expect(asked[0]!.signal.aborted).toBe(true);
    await pass(1);
    asked[0]!.answer(quote("111"));
    asked[1]!.answer(quote("222"));
    await pass(1);
    expect(useSwap.getState().quote?.amountOut).toBe("222");
  });

  it("sends nothing where the server routes in public, and the choice cannot be made there", async () => {
    for (const mode of ["public", null] as const) {
      if (mode === null) useApp.setState({ config: null });
      else serverRoutes(mode);
      useSwap.getState().setAmount("0.5");
      await pass(401);
      const before = asked.length;
      // There is nothing to choose: the choice is not taken, and nothing is asked.
      useSwap.getState().setWithoutPrivate(true);
      await pass(500);
      expect(useSwap.getState().withoutPrivate, String(mode)).toBe(false);
      expect(asked, String(mode)).toHaveLength(before);
      // Even if the choice were somehow held (made while the server routed privately), it is not sent.
      useSwap.setState({ withoutPrivate: true });
      useSwap.getState().refreshNow();
      await pass(1);
      expect(Object.keys(lastBody()), String(mode)).not.toContain("withoutPrivate");
      useSwap.setState({ withoutPrivate: false });
    }
    for (const request of asked) expect(Object.keys(request.body).filter((key) => NAMES_A_LEVEL.test(key) || key === "withoutPrivate")).toEqual([]);
  });

  it("is for this swap only: a change of amount keeps it, a change of either coin clears it", async () => {
    serverRoutes("basic");
    const choose = async () => {
      useSwap.getState().setAmount("0.5");
      useSwap.getState().setWithoutPrivate(true);
      await pass(1);
      expect(lastBody()).toMatchObject({ withoutPrivate: true });
    };
    await choose();
    // Another amount of the same two coins is still this swap.
    useSwap.getState().setAmount("0.6");
    await pass(401);
    expect(useSwap.getState().withoutPrivate).toBe(true);
    expect(lastBody()).toMatchObject({ amount: "600000000000000000", withoutPrivate: true });
    // So is anything else that is not a coin: the way of paying, the slippage limit, an address.
    useSwap.getState().setPay("wallet");
    useSwap.getState().setSlippage(50);
    useSwap.getState().setRecipient(SOL_ADDRESS);
    await pass(401);
    expect(lastBody()).toMatchObject({ recipient: SOL_ADDRESS, slippageBps: 50, withoutPrivate: true });
    // Choosing again the coin that is already there changes no coin.
    useSwap.getState().setFrom(ETH.id);
    useSwap.getState().setTo(USDT.id);
    expect(useSwap.getState().withoutPrivate).toBe(true);

    // Another coin to receive.
    useSwap.getState().setTo(USDC.id);
    expect(useSwap.getState().withoutPrivate).toBe(false);
    await pass(401);
    expect(lastBody()).toMatchObject({ to: USDC.id });
    expect(Object.keys(lastBody())).not.toContain("withoutPrivate");

    // Another coin to pay.
    await choose();
    useSwap.getState().setFrom(USDT.id);
    expect(useSwap.getState()).toMatchObject({ fromId: USDT.id, toId: USDC.id, withoutPrivate: false });
    await pass(401);
    expect(Object.keys(lastBody())).not.toContain("withoutPrivate");

    // The two coins changing places, by the flip button or by choosing for one side the coin on the other.
    await choose();
    useSwap.getState().flip();
    expect(useSwap.getState()).toMatchObject({ fromId: USDC.id, toId: USDT.id, withoutPrivate: false });
    await choose();
    useSwap.getState().setFrom(USDT.id);
    expect(useSwap.getState()).toMatchObject({ fromId: USDT.id, toId: USDC.id, withoutPrivate: false });
    await pass(401);
    expect(Object.keys(lastBody())).not.toContain("withoutPrivate");
  });

  it("is over once an order has been made: the next swap starts as the server routes, with a quote to match", async () => {
    serverRoutes("basic");
    useSwap.getState().setAmount("0.5");
    useSwap.getState().setWithoutPrivate(true);
    await pass(1);
    asked.at(-1)!.answer(quote("222"));
    await pass(1);
    const before = asked.length;
    useSwap.getState().orderMade();
    // The public numbers do not stay on the card under a swap that is private again.
    expect(useSwap.getState()).toMatchObject({ withoutPrivate: false, quote: null, dirty: true });
    await pass(1);
    expect(asked).toHaveLength(before + 1);
    expect(Object.keys(lastBody())).not.toContain("withoutPrivate");
    // With no such choice in force, an order being made changes nothing here and asks nothing.
    asked.at(-1)!.answer(quote("333"));
    await pass(1);
    useSwap.getState().orderMade();
    await pass(1000);
    expect(asked).toHaveLength(before + 1);
    expect(useSwap.getState().quote?.amountOut).toBe("333");
  });

  it("holds the server's refusal of a private quote as the card's problem, with the inputs and the choice untouched", async () => {
    serverRoutes("basic");
    useSwap.getState().setAmount("0.5");
    await pass(401);
    // The everyday-outcome envelope: a 200 with the error in its body.
    asked[0]!.answer({ error: { code: "private_unavailable", message: PRIVATE_UNAVAILABLE } } as never);
    await pass(1);
    // Nothing has switched: the swap is still set to private routing, and no public quote was asked for.
    expect(useSwap.getState()).toMatchObject({ quote: null, loading: false, dirty: false, withoutPrivate: false, amountText: "0.5", problem: { code: "private_unavailable", message: PRIVATE_UNAVAILABLE } });
    expect(asked).toHaveLength(1);
    // (That it is not asked again by itself either is the refresh rule's: see refreshDue in the logic tests.)
  });

  it("when an order could not be made privately, puts the card where a refused private quote puts it", async () => {
    serverRoutes("basic");
    useSwap.getState().setAmount("0.5");
    await pass(401);
    asked[0]!.answer(quote("111"));
    await pass(1);
    // A refresh is on its way when the sheet reports the refusal: it is cancelled, and its answer is not shown.
    useSwap.getState().refreshNow();
    await pass(1);
    expect(asked).toHaveLength(2);
    useSwap.getState().privateRefused();
    expect(asked[1]!.signal.aborted).toBe(true);
    expect(useSwap.getState()).toMatchObject({ quote: null, loading: false, dirty: false, withoutPrivate: false, amountText: "0.5", problem: { code: "private_unavailable", message: PRIVATE_UNAVAILABLE, detail: {} } });
    asked[1]!.answer(quote("222"));
    await pass(1);
    expect(useSwap.getState().quote).toBeNull();
    // The choice is still the person's to make: making it asks for a public quote.
    useSwap.getState().setWithoutPrivate(true);
    await pass(1);
    expect(lastBody()).toMatchObject({ withoutPrivate: true });
    expect(useSwap.getState().problem).toBeNull();
  });
});

describe("a server whose routing setting changed after the page loaded", () => {
  // The page is told the setting once, when it loads. The server's answers about quotes say it again,
  // and where they differ the newer word stands: the page says what the server does now.
  const told = (privacyMode: Confidentiality) => useApp.setState({ config: { privacyMode, paused: false } as never });
  const mode = () => useApp.getState().config?.privacyMode ?? null;
  const routed = (routing: string, amountOut = "111") => ({ ...quote(amountOut), routing }) as QuoteView;
  const PRIVATELY = routingOf("basic");
  const IN_PUBLIC = routingOf("public");

  it("is taken to route privately once it answers with a private quote, and the rest of what it said stays as it was", async () => {
    told("public");
    useSwap.getState().setAmount("0.5");
    await pass(401);
    asked[0]!.answer(routed(PRIVATELY));
    await pass(1);
    expect(mode()).toBe("basic");
    expect(useApp.getState().config).toMatchObject({ paused: false });
    expect(useSwap.getState().quote?.routing).toBe(PRIVATELY);
  });

  it("is taken to route privately once it says private routing is not available, so the choice the card then offers is one it can take", async () => {
    told("public");
    useSwap.getState().setAmount("0.5");
    await pass(401);
    asked[0]!.answer({ error: { code: "private_unavailable", message: PRIVATE_UNAVAILABLE } } as never);
    await pass(1);
    expect(mode()).toBe("basic");
    // The button's press: taken, and sent. With the old word still standing it would have done nothing.
    useSwap.getState().setWithoutPrivate(true);
    await pass(1);
    expect(useSwap.getState().withoutPrivate).toBe(true);
    expect(asked).toHaveLength(2);
    expect(asked[1]!.body).toMatchObject({ withoutPrivate: true });
    // The public quote that was asked for as one tells nothing more: the server still routes privately.
    asked[1]!.answer(routed(IN_PUBLIC, "222"));
    await pass(1);
    expect(mode()).toBe("basic");
  });

  it("is taken to route in public once it answers with a public quote nobody asked to be public", async () => {
    told("basic");
    useSwap.getState().setAmount("0.5");
    await pass(401);
    asked[0]!.answer(routed(IN_PUBLIC));
    await pass(1);
    // The card no longer says "Private" over public quotes.
    expect(mode()).toBe("public");
  });

  it("is told nothing by an answer that names no routing, by any other problem, or before the page has its settings", async () => {
    told("basic");
    useSwap.getState().setAmount("0.5");
    await pass(401);
    asked[0]!.answer(quote("111"));
    await pass(1);
    expect(mode()).toBe("basic");
    useSwap.getState().refreshNow();
    await pass(1);
    asked[1]!.answer({ error: { code: "no_route", message: "No route for this pair right now." } } as never);
    await pass(1);
    expect(mode()).toBe("basic");
    // Nothing is made up where the server has not yet said anything at all.
    useApp.setState({ config: null });
    useSwap.getState().refreshNow();
    await pass(1);
    asked[2]!.answer(routed(PRIVATELY));
    await pass(1);
    expect(useApp.getState().config).toBeNull();
  });

  it("is taken to route privately when it would not make an order privately", () => {
    told("public");
    useSwap.getState().privateRefused();
    expect(mode()).toBe("basic");
    // And only ever its own word is taken: nothing here can be set by the page for itself.
    heardRouting(null);
    expect(mode()).toBe("basic");
  });
});
