// Private routing on the swap card, the review and an order's page: what is drawn, and when.
// The parts are drawn here as the browser would first draw them (to plain markup, without a
// browser), from fixed examples. The rules behind them are tested one by one in
// swap-logic.test.ts; this holds the components to those rules.

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routingOf, type Confidentiality, type OrderView, type QuoteView, type TokenView } from "../shared/api.ts";
import { QuotePanel } from "../web/src/components/QuotePanel.tsx";
import { ReviewSheet } from "../web/src/components/ReviewSheet.tsx";
import { SwapCard } from "../web/src/components/SwapCard.tsx";
import { PRIVATE_UNAVAILABLE, routingNote } from "../web/src/lib/swap-logic.ts";
import { OrderContent } from "../web/src/pages/OrderPage.tsx";
import { useApp } from "../web/src/stores/app.ts";
import { useSwap } from "../web/src/stores/swap.ts";
import { useTokens } from "../web/src/stores/tokens.ts";

const PRIVATELY = routingOf("basic");
const IN_PUBLIC = routingOf("public");

const coin = (symbol: string, chain: string, decimals: number): TokenView => ({ id: `${chain}:${symbol}`, symbol, name: symbol, chain, decimals, price: "1", contract: null, wallet: false });
const ETH = coin("ETH", "base", 18);
const USDT = coin("USDT", "sol", 6);
// Example addresses, made up from fixed text: they are nobody's.
const SOL_ADDRESS = "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP";
const EVM_ADDRESS = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";

const PUBLIC_QUOTE: QuoteView = {
  from: ETH.id,
  to: USDT.id,
  amountIn: "500000000000000000",
  amountOut: "1261340512",
  minAmountOut: "1248727106",
  amountInUsd: "1265.13",
  amountOutUsd: "1260.59",
  slippageBps: 100,
  timeEstimate: 34,
  // As the site runs: no fee of IntentSwap's, and the provider's own.
  fees: { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "1000000000000000" },
  withdrawFee: "302700",
  refundFee: null,
  priceImpactBps: 36,
  routing: IN_PUBLIC,
  serverNow: "2026-10-08T12:00:00.000Z",
};
// The same swap routed privately: the same fees, and a little less out.
const PRIVATE_QUOTE: QuoteView = { ...PUBLIC_QUOTE, amountOut: "1260079171", minAmountOut: "1247478379", routing: PRIVATELY };
// And as it comes from a server set to take a fee of its own.
const FEE_QUOTE: QuoteView = { ...PRIVATE_QUOTE, fees: { ...PUBLIC_QUOTE.fees, appBps: 20, appAmount: "1000000000000000" } };

const NOW = Date.parse("2026-10-08T12:10:00.000Z");
function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "Ex4mpleOrderIdForTheTests00",
    status: "delivered",
    createdAt: new Date(NOW - 600_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    statusSince: new Date(NOW).toISOString(),
    pay: "manual",
    from: { id: ETH.id, symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null },
    to: { id: USDT.id, symbol: "USDT", name: "Tether USD", chain: "sol", decimals: 6, contract: "x" },
    amountIn: PUBLIC_QUOTE.amountIn,
    amountOut: PUBLIC_QUOTE.amountOut,
    minAmountOut: PUBLIC_QUOTE.minAmountOut,
    amountInUsd: PUBLIC_QUOTE.amountInUsd,
    amountOutUsd: PUBLIC_QUOTE.amountOutUsd,
    slippageBps: 100,
    timeEstimate: 34,
    fees: PUBLIC_QUOTE.fees,
    withdrawFee: null,
    refundFee: null,
    recipient: SOL_ADDRESS,
    refundTo: EVM_ADDRESS,
    rewardsAddress: null,
    depositAddress: null,
    depositMemo: null,
    depositsOpen: false,
    deadline: new Date(NOW + 3_000_000).toISOString(),
    depositTxHash: null,
    depositProven: true,
    depositTxUrl: null,
    details: null,
    serverNow: new Date(NOW).toISOString(),
    ...overrides,
  };
}

/** Markup as text a person would read: tags out, spaces evened. */
const read = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** Every word this feature adds to a page. Where the server routes in public, none of them may be drawn. */
const NEW_WORDS = /Private|private|Routing|routing|Public|by your choice|Routed|routed/;

/** What the swap card's own store holds for a drawing: a ready swap of 0.5 ETH for USDT, sent by hand, unless a test says otherwise. */
type Held = Partial<Pick<ReturnType<typeof useSwap.getState>, "quote" | "problem" | "withoutPrivate" | "pay">>;
/** How the server routes swaps for a drawing, and what the card holds. Set before each drawing; a test changes what it needs. */
let mode: Confidentiality | null = null;
let held: Held = {};

/**
 * A part of the site as it is first drawn. Drawn here, outside a browser, a component reads each
 * store's first state, so what the drawing needs is put there for its length and taken away again.
 */
function draw(element: ReactElement): string {
  const wanted: [{ getInitialState(): object }, Record<string, unknown>][] = [
    [useApp, { config: mode === null ? null : { privacyMode: mode, paused: false, termsVersion: "2026-10-09" } }],
    [useTokens, { status: "ready", tokens: [ETH, USDT], byId: new Map([ETH, USDT].map((token) => [token.id, token])) }],
    [useSwap, { fromId: ETH.id, toId: USDT.id, amountText: "0.5", pay: "manual", recipient: SOL_ADDRESS, refundTo: EVM_ADDRESS, quote: null, fetchedAt: Date.now(), loading: false, dirty: false, problem: null, withoutPrivate: false, ...held }],
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
const serverRoutes = (privacyMode: Confidentiality | null) => {
  mode = privacyMode;
};

beforeEach(() => {
  // An order's page builds its own link from the address it is on.
  vi.stubGlobal("window", { location: { origin: "https://example.org", search: "" } });
  mode = null;
  held = {};
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the quote's breakdown", () => {
  const panel = (quote: QuoteView, mode: Confidentiality | null, byChoice = false) => draw(createElement(QuotePanel, { quote, from: ETH, to: USDT, loading: false, stale: false, held: true, startOpen: true, routing: routingNote(mode, quote, byChoice), impactConfirmed: false, onConfirmImpact: () => undefined }));
  const rows = (html: string) => [...html.matchAll(/<div class="quote-row"[^>]*><dt class="muted">([^<]*)<\/dt>/g)].map((match) => match[1]);

  it("a private quote: the routing first, then no fee of IntentSwap's, the provider's in figures and the points, as on any quote", () => {
    const html = panel(PRIVATE_QUOTE, "basic");
    expect(rows(html)).toEqual(["Routing", "Minimum received", "IntentSwap fee", "Provider fee", "Solana network fee", "Estimated time", "Points"]);
    expect(html).toMatch(/<div class="quote-row" data-row="routing"><dt class="muted">Routing<\/dt><dd>Private<\/dd><\/div>/);
    expect(html).toMatch(/<dt class="muted">IntentSwap fee<\/dt><dd><span class="muted">None<\/span><\/dd>/);
    expect(read(html)).not.toMatch(/0\.00%/);
    expect(read(html)).toMatch(/Provider fee 0\.20%/);
    // $1,265.13 paid: 12,651.3 points, ten to the dollar. They are a public quote's for the same amount.
    expect(read(html)).toMatch(/Points \+12,651\.3 /);
    const pointsOf = (drawn: string) => /<div class="quote-row"[^>]*><dt class="muted">Points<\/dt>[\s\S]*?<\/div>/.exec(drawn)?.[0] ?? "";
    expect(pointsOf(html)).not.toBe("");
    expect(pointsOf(html)).toBe(pointsOf(panel(PUBLIC_QUOTE, "basic", true)));
  });

  it("a private quote from a server set to take a fee: the fee row gives it in figures, and the points are the same", () => {
    const html = panel(FEE_QUOTE, "basic");
    expect(rows(html)).toEqual(["Routing", "Minimum received", "IntentSwap fee", "Provider fee", "Solana network fee", "Estimated time", "Points"]);
    expect(read(html)).toMatch(/IntentSwap fee 0\.20%/);
    expect(read(html)).toMatch(/Provider fee 0\.20%/);
    expect(read(html)).not.toMatch(/None/);
    // No fee is part of the sum: the points are those of the same swap with no fee.
    const pointsOf = (drawn: string) => /<div class="quote-row"[^>]*><dt class="muted">Points<\/dt>[\s\S]*?<\/div>/.exec(drawn)?.[0] ?? "";
    expect(pointsOf(html)).not.toBe("");
    expect(pointsOf(html)).toBe(pointsOf(panel(PRIVATE_QUOTE, "basic")));
  });

  it("the line itself shows nothing new: the rate, the time and the chevron", () => {
    const line = (html: string) => /<button type="button" class="quote-summary"[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
    expect(read(line(panel(PRIVATE_QUOTE, "basic")))).not.toMatch(NEW_WORDS);
    expect(read(line(panel(PUBLIC_QUOTE, "basic", true)))).not.toMatch(NEW_WORDS);
  });

  it("a public quote by the person's own choice: the routing row says so, and the fee and the points are as ever", () => {
    const html = panel(PUBLIC_QUOTE, "basic", true);
    expect(rows(html)).toEqual(["Routing", "Minimum received", "IntentSwap fee", "Provider fee", "Solana network fee", "Estimated time", "Points"]);
    expect(html).toMatch(/data-row="routing"><dt class="muted">Routing<\/dt><dd>Public, by your choice<\/dd>/);
    expect(read(html)).toMatch(/IntentSwap fee None Provider fee 0\.20%/);
  });

  it("where the server routes in public: no row, no new word, and markup the same as before there was such a thing", () => {
    for (const mode of ["public", null] as const) {
      const html = panel(PUBLIC_QUOTE, mode);
      expect(rows(html)).toEqual(["Minimum received", "IntentSwap fee", "Provider fee", "Solana network fee", "Estimated time", "Points"]);
      expect(read(html), String(mode)).not.toMatch(NEW_WORDS);
      expect(html).not.toMatch(/data-row|routing-tag/);
      // The same as a quote from before routing was named, drawn with no word about routing at all.
      const { routing: _routing, ...before } = PUBLIC_QUOTE;
      const plain = draw(createElement(QuotePanel, { quote: before, from: ETH, to: USDT, loading: false, stale: false, held: true, startOpen: true, impactConfirmed: false, onConfirmImpact: () => undefined }));
      expect(html.replace(/_r_\w+_|«\w+»|:r\w*:/g, "")).toBe(plain.replace(/_r_\w+_|«\w+»|:r\w*:/g, ""));
    }
  });
});

describe("the swap card", () => {
  const card = () => draw(createElement(SwapCard));
  const tools = (html: string) => /<div class="card-tools">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  const button = (html: string) => read(/<div class="card-submit"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "");
  const message = (html: string) => read(/<p class="card-message" role="status">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "");

  it("where private routing is in force: the small tag at the left end of the row of tools, before the two tools", () => {
    serverRoutes("basic");
    const row = tools(card());
    expect(row).toMatch(/^<span class="chip routing-tag card-routing" data-tone="private">Private<\/span><button type="button" class="tool"/);
    expect(row.match(/class="tool"/g)).toHaveLength(2);
    expect(row).not.toContain("routing-switch");
  });

  it("after choosing public routing for this swap: a quiet word-button in the tag's place, and no tag", () => {
    serverRoutes("basic");
    held = { withoutPrivate: true, quote: PUBLIC_QUOTE };
    const row = tools(card());
    expect(row).toMatch(/^<button type="button" class="routing-switch card-routing">Use private routing<\/button><button type="button" class="tool"/);
    expect(row).not.toContain("routing-tag");
    expect(row.match(/class="tool"/g)).toHaveLength(2);
  });

  it("where the server routes in public, or has not said: the row holds its two tools and nothing else, and the card has no new word", () => {
    for (const mode of ["public", null] as const) {
      serverRoutes(mode);
      held = { quote: PUBLIC_QUOTE };
      const html = card();
      expect(tools(html), String(mode)).toMatch(/^<button type="button" class="tool"/);
      expect(tools(html).match(/<button|<span/g), String(mode)).toHaveLength(2);
      expect(html).not.toMatch(/routing-tag|routing-switch|card-routing|data-row/);
      expect(read(html), String(mode)).not.toMatch(NEW_WORDS);
      expect(button(html)).toBe("Review swap");
    }
  });

  it("when a private quote cannot be had: the one message says so, and the button offers this swap without private routing", () => {
    serverRoutes("basic");
    held = { quote: null, problem: { code: "private_unavailable", message: "whatever the server wrote", detail: {} } };
    const html = card();
    expect(message(html)).toBe(PRIVATE_UNAVAILABLE);
    expect(button(html)).toBe("Swap without private routing");
    expect(html).toMatch(/<div class="card-submit"><button type="button" class="button-primary">Swap without private routing<\/button>/);
    // Nothing has switched: the swap is still set to private routing, and the card still says so.
    expect(tools(html)).toContain("routing-tag");
    expect(tools(html)).not.toContain("routing-switch");
  });

  it("a private quote on the card: one line for the quote, and the same said of points as for a public one", () => {
    const pointsOn = (drawn: string) => read(drawn).match(/[+\d.,]* ?points/gi) ?? [];
    serverRoutes("basic");
    held = { quote: PUBLIC_QUOTE, pay: "wallet", withoutPrivate: true };
    const inPublic = pointsOn(card());
    // Paying from a wallet, the quote's line and its breakdown both speak of points.
    expect(inPublic.length).toBeGreaterThan(0);
    expect(inPublic.join(" ")).toMatch(/\+[\d.,]+ points/);
    held = { quote: PRIVATE_QUOTE, pay: "wallet" };
    const html = card();
    expect(pointsOn(html)).toEqual(inPublic);
    expect(html).toMatch(/data-row="routing"><dt class="muted">Routing<\/dt><dd>Private<\/dd>/);
    // A quote with a fee of IntentSwap's on it says the same of points: no fee is part of the sum.
    held = { quote: FEE_QUOTE, pay: "wallet" };
    expect(pointsOn(card())).toEqual(inPublic);
  });
});

describe("the review sheet", () => {
  const sheet = () => draw(createElement(ReviewSheet));
  const rows = (html: string) => [...html.matchAll(/<div class="review-row"[^>]*><dt class="muted">([^<]*)<\/dt>/g)].map((match) => match[1]);
  const sentence = (html: string) => read(/<p class="review-sentence"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "");
  const points = (html: string) => read(/<p class="review-address-label">Points[\s\S]*?(?=<p class="review-plain)/.exec(html)?.[0] ?? "");

  it("a private swap: the third short sentence, the routing row with the tag near the top, no fee of IntentSwap's, and somewhere for the points to go", () => {
    serverRoutes("basic");
    held = { quote: PRIVATE_QUOTE };
    const html = sheet();
    expect(sentence(html)).toBe("You send 0.5 ETH on Base. You receive about 1,260.07 USDT on Solana. Routed privately.");
    expect(rows(html).slice(0, 4)).toEqual(["You send", "You receive, about", "Routing", "Minimum received"]);
    expect(html).toMatch(/<div class="review-row" data-row="routing"><dt class="muted">Routing<\/dt><dd><span class="chip routing-tag" data-tone="private">Private<\/span><\/dd><\/div>/);
    expect(html).toMatch(/<dt class="muted">IntentSwap fee<\/dt><dd><span class="muted">None<\/span><\/dd>/);
    expect(read(html)).toMatch(/Provider fee 0\.001 ETH 0\.20%/);
    // A swap with no fee of IntentSwap's has somewhere for its points to go, like any other.
    expect(points(html)).toMatch(/^Points · BNB Chain /);
    expect(html).toContain("Rewards address");
    expect(read(html)).not.toMatch(/adds no points: IntentSwap/);
  });

  it("a private swap the server takes a fee on: the fee row gives it in figures, and the place for the points is the same", () => {
    serverRoutes("basic");
    held = { quote: FEE_QUOTE };
    const html = sheet();
    expect(read(html)).toMatch(/IntentSwap fee 0\.001 ETH 0\.20%/);
    expect(points(html)).toMatch(/^Points · BNB Chain /);
    expect(html).toContain("Rewards address");
    held = { quote: PRIVATE_QUOTE };
    expect(points(html)).toBe(points(sheet()));
  });

  it("public by the person's own choice: the routing row says so in words, with no tag, and the rest is as ever", () => {
    serverRoutes("basic");
    held = { quote: PUBLIC_QUOTE, withoutPrivate: true };
    const html = sheet();
    expect(sentence(html)).toBe("You send 0.5 ETH on Base. You receive about 1,261.34 USDT on Solana.");
    expect(html).toMatch(/<div class="review-row" data-row="routing"><dt class="muted">Routing<\/dt><dd>Public, by your choice<\/dd><\/div>/);
    expect(html).not.toContain("routing-tag");
    expect(read(html)).toMatch(/IntentSwap fee None/);
    expect(points(html)).toMatch(/^Points · BNB Chain /);
    expect(html).toContain("Rewards address");
  });

  it("where the server routes in public: no routing row, no third sentence, no new word", () => {
    for (const mode of ["public", null] as const) {
      serverRoutes(mode);
      held = { quote: PUBLIC_QUOTE };
      const html = sheet();
      expect(sentence(html)).toBe("You send 0.5 ETH on Base. You receive about 1,261.34 USDT on Solana.");
      expect(rows(html).slice(0, 3)).toEqual(["You send", "You receive, about", "Minimum received"]);
      expect(html).not.toMatch(/routing-tag|data-row/);
      expect(read(html), String(mode)).not.toMatch(NEW_WORDS);
      expect(points(html)).toMatch(/^Points · BNB Chain /);
    }
  });
});

describe("an order's page", () => {
  const page = (example: OrderView, mode: Confidentiality | null) => draw(createElement(OrderContent, { order: example, now: NOW, reconnecting: false, contact: null, onOrder: () => undefined, privacyMode: mode }));
  const head = (html: string) => /<div class="order-head-text">([\s\S]*?)<p class="muted">/.exec(html)?.[1] ?? "";
  const rows = (html: string) => [...html.matchAll(/<div class="review-row"[^>]*><dt class="muted">([^<]*)<\/dt>/g)].map((match) => match[1]);
  const privateOrder = order({ routing: PRIVATELY, amountOut: PRIVATE_QUOTE.amountOut, minAmountOut: PRIVATE_QUOTE.minAmountOut, fees: PRIVATE_QUOTE.fees });
  // An order as it was kept before routing was: the field is not there at all.
  const { routing: _routing, ...oldOrder } = order({ routing: IN_PUBLIC });

  it("an order made with private routing: the tag beside the title, and a row in its details, whatever the server's setting is now", () => {
    for (const mode of ["basic", "public", null] as const) {
      const html = page(privateOrder, mode);
      expect(head(html), String(mode)).toBe('<div class="order-title-row"><h1 id="order-title" class="order-title">0.5 ETH to USDT</h1><span class="chip routing-tag" data-tone="private">Private</span></div>');
      expect(rows(html).slice(0, 4)).toEqual(["You send", "You receive, about", "Routing", "Minimum received"]);
      expect(html).toMatch(/<div class="review-row" data-row="routing"><dt class="muted">Routing<\/dt><dd>Private<\/dd><\/div>/);
      // Its fee row and its points read as any order's do: no fee of IntentSwap's, and points that turn on its rewards address alone.
      expect(html).toMatch(/<dt class="muted">IntentSwap fee<\/dt><dd><span class="muted">None<\/span><\/dd>/);
      expect(read(html)).toContain("This swap adds no points: it was made without a rewards address.");
      expect(read(page({ ...privateOrder, rewardsAddress: "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83" }, mode))).toContain("This swap's points go to this address when it is delivered.");
      // One made where the server took a fee gives it in figures, and says the same of its points.
      const paid = page({ ...privateOrder, fees: FEE_QUOTE.fees, rewardsAddress: "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83" }, mode);
      expect(read(paid)).toMatch(/IntentSwap fee 0\.001 ETH 0\.20%/);
      expect(read(paid)).toContain("This swap's points go to this address when it is delivered.");
      expect(read(html)).not.toMatch(/IntentSwap takes no fee on it/);
    }
  });

  it("a public order where the server routes privately: a row that says Public, and no tag", () => {
    for (const example of [order({ routing: IN_PUBLIC }), oldOrder as OrderView]) {
      const html = page(example, "basic");
      expect(head(html)).toBe('<h1 id="order-title" class="order-title">0.5 ETH to USDT</h1>');
      expect(html).toMatch(/<div class="review-row" data-row="routing"><dt class="muted">Routing<\/dt><dd>Public<\/dd><\/div>/);
      expect(html).not.toContain("routing-tag");
    }
  });

  it("a public order where the server routes in public: nothing of routing, and an old order with no field reads the same", () => {
    const drawn = [order({ routing: IN_PUBLIC }), oldOrder as OrderView].flatMap((example) => (["public", null] as const).map((mode) => page(example, mode)));
    for (const html of drawn) {
      expect(head(html)).toBe('<h1 id="order-title" class="order-title">0.5 ETH to USDT</h1>');
      expect(rows(html)).toEqual(["You send", "You receive, about", "Minimum received", "IntentSwap fee", "Provider fee"]);
      expect(html).not.toMatch(/routing-tag|data-row|order-title-row/);
      expect(read(html)).not.toMatch(NEW_WORDS);
      expect(read(html)).toContain("This swap adds no points: it was made without a rewards address.");
    }
    // Four drawings of the same order, one markup.
    expect(new Set(drawn).size).toBe(1);
  });
});

describe("the page of component states", () => {
  it("draws, and holds a sample of each new state", async () => {
    const { default: StatesPage } = await import("../web/src/pages/StatesPage.tsx");
    const html = draw(createElement(StatesPage));
    const group = /<h2 class="states-title">Private routing<\/h2>([\s\S]*?)<h2 class="states-title">/.exec(html)?.[1] ?? "";
    // The tag by itself.
    expect(group).toMatch(/<div class="states-row"><span class="chip routing-tag" data-tone="private">Private<\/span><\/div>/);
    // The card's row above the fields in its three states: the tag, the way back, and its left end empty.
    const toolRows = [...group.matchAll(/<div class="card-tools">([\s\S]*?)<\/div>/g)].map((match) => match[1] ?? "");
    expect(toolRows).toHaveLength(3);
    expect(toolRows[0]).toMatch(/^<span class="chip routing-tag card-routing" data-tone="private">Private<\/span><button type="button" class="tool"/);
    expect(toolRows[1]).toMatch(/^<button type="button" class="routing-switch card-routing">Use private routing<\/button><button type="button" class="tool"/);
    expect(toolRows[2]).toMatch(/^<button type="button" class="tool"/);
    for (const row of toolRows) expect(row.match(/class="tool"/g)).toHaveLength(2);
    // A private quote's breakdown, and a public one by choice.
    expect(group).toMatch(/data-row="routing"><dt class="muted">Routing<\/dt><dd>Private<\/dd>/);
    expect(group).toMatch(/<dt class="muted">IntentSwap fee<\/dt><dd><span class="muted">None<\/span><\/dd>/);
    expect(group).toMatch(/data-row="routing"><dt class="muted">Routing<\/dt><dd>Public, by your choice<\/dd>/);
    // The message and the button for "not available".
    expect(group).toContain(`<p class="card-message" role="status">${PRIVATE_UNAVAILABLE}</p>`);
    expect(group).toMatch(/<button type="button" class="button-primary">Swap without private routing<\/button>/);
    // The review: its first words, its routing row both ways, and its words on points.
    expect(read(group)).toContain("You send 0.5 ETH on Base. You receive about 1,260.07 USDT on Solana. Routed privately.");
    expect(group).toMatch(/<div class="review-row" data-row="routing"><dt class="muted">Routing<\/dt><dd><span class="chip routing-tag" data-tone="private">Private<\/span><\/dd><\/div>/);
    expect(group).toMatch(/<div class="review-row" data-row="routing"><dt class="muted">Routing<\/dt><dd>Public, by your choice<\/dd><\/div>/);
    // And a quote from a server set to take a fee: the row then gives it in figures.
    expect(read(group)).toMatch(/IntentSwap fee 0\.20%/);
    expect(read(html)).not.toMatch(/adds no points: IntentSwap/);
    // The review's own button and line when an order could not be made privately, and the two orders.
    expect(html).toMatch(/<button type="button" class="button-primary">Close<\/button>/);
    expect(read(html)).toContain(`${PRIVATE_UNAVAILABLE} No order was made.`);
    expect(html).toMatch(/<div class="order-title-row"><h1 id="order-title" class="order-title">0\.5 ETH to USDT<\/h1><span class="chip routing-tag" data-tone="private">Private<\/span><\/div>/);
    expect(html).toMatch(/<div class="review-row" data-row="routing"><dt class="muted">Routing<\/dt><dd>Public<\/dd><\/div>/);
    // Everything else on the page is drawn as where the server routes in public: the other samples gained no new part.
    const rest = html.replace(/<h2 class="states-title">Private routing<\/h2>[\s\S]*?(?=<h2 class="states-title">)/, "");
    expect(rest.match(/routing-tag/g)).toHaveLength(1);
    expect(rest.match(/data-row="routing"/g)).toHaveLength(2);
    expect(rest).not.toContain("routing-switch");
  });
});
