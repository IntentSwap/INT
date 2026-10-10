// Add gas in words: the Docs' page on it, the question, the home page's line, and what the other
// pages say of paying where a swap can have gas added. The pages are drawn here as a browser first
// draws them (to plain markup, without a browser).
//
// Gas is only ever added beside a privately routed swap. So everything said of it is said only
// where swaps are routed privately, and where they are not the site reads as it did before:
// no page, no question, no line, and not the word.
//
// The switch itself, the review, the order's page and the server's side of it have tests of their own.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestPath } from "../server/http.ts";
import { loadStaticSite } from "../server/static.ts";
import { CHAINS } from "../shared/chains.ts";
import { GAS_SIZES_USD, GAS_USD, gasSizeFor } from "../shared/gas.ts";
import { DOC_SLUGS, docSlugs, GAS_DOC_SLUG, isDocSlug, PRIVATE_DOC_SLUG, PRIVATE_ONLY_DOC_SLUGS } from "../shared/pages.ts";
import { Faq, questions } from "../web/src/components/Faq.tsx";
import { HomeSections } from "../web/src/components/Home.tsx";
import { DOC_PAGES, docExists, docHref, docPages, GAS_DOC, gasSizes, listed, neighbours } from "../web/src/lib/docs-logic.ts";
import { features } from "../web/src/lib/site-logic.ts";
import DocsPage from "../web/src/pages/DocsPage.tsx";
import { PrivacyPage, TermsPage } from "../web/src/pages/LegalPages.tsx";
import { matchRoute } from "../web/src/router.ts";
import { useApp } from "../web/src/stores/app.ts";
import { NEVER } from "./words.ts";

const root = path.resolve("web", "src");
const source = (file: string) => fs.readFileSync(path.join(root, ...file.split("/")), "utf8");
/** One function of a file, from its first line to the line that closes it. */
const part = (text: string, opening: string) => {
  const start = text.indexOf(opening);
  if (start === -1) throw new Error(`no "${opening}"`);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end === -1 ? undefined : end + 2);
};

/** The server's settings for a site with nothing else set: routed privately, routed in public, and each without its Stats page. */
const ROUTED_PRIVATELY = { supportContact: null, tokenAddress: null, tokenPairAddress: null, paused: false, privacyMode: "basic", statsPage: true };
const ROUTED_IN_PUBLIC = { ...ROUTED_PRIVATELY, privacyMode: "public" };
const WITHOUT_STATS = { ...ROUTED_PRIVATELY, statsPage: false };
/** Every way a site can be that does not route swaps privately: the settings have not arrived, they say public, or they say nothing of routing. */
const NOT_PRIVATE: (readonly [string, object | null])[] = [
  ["before the server's settings have arrived", null],
  ["with swaps routed in public", ROUTED_IN_PUBLIC],
  ["with a server that says nothing of routing", { supportContact: null, tokenAddress: null, tokenPairAddress: null, paused: false }],
];

/**
 * A page of the site as it is drawn with the given settings from the server (null: they have not
 * arrived). A page drawn here, outside a browser, reads the settings store's first state, so the
 * settings are put there for the length of one drawing and taken away again.
 */
function draw(page: () => ReactElement, config: object | null = ROUTED_PRIVATELY): string {
  const first = useApp.getInitialState() as { config: unknown };
  const before = first.config;
  first.config = config;
  try {
    return renderToStaticMarkup(page());
  } finally {
    first.config = before;
  }
}
/** The words of a piece of markup, as they are read. */
const words = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,:;])/g, "$1")
    .trim();
/** A page of the documentation without what is round it: its title, its first sentence and its sections. */
const body = (markup: string) => /<article[\s\S]*<\/article>/.exec(markup)?.[0] ?? "";
const sections = (markup: string) => [...markup.matchAll(/<h2 id="([^"]+)" data-title="([^"]+)"/g)].map((match) => `${match[1]}: ${match[2]}`);
/** One section of a page of the documentation, from its heading to the next. */
const section = (markup: string, id: string) => words(new RegExp(`<h2 id="${id}"[\\s\\S]*?(?=<h2 id="|<nav class="docs-turn"|</article>)`).exec(markup)?.[0] ?? "").replace("Link to this section ", "");

const docsPage = (slug: Parameters<typeof DocsPage>[0]["slug"]) => () => createElement(DocsPage, { slug });
const gasDocs = docsPage(GAS_DOC_SLUG);
const faq = () => createElement(Faq);
const home = () => createElement(HomeSections);
const terms = () => createElement(TermsPage);
const privacy = () => createElement(PrivacyPage);

// ---- The sentences, word for word ----
const LEAD = "A switch on the swap card. With it on, a second, small order delivers a little of the receiving chain's own coin to the same address as your swap, so that a wallet with nothing in it can pay network fees and move what arrived straight away.";
const FAQ_ANSWER =
  "A switch on the swap card, shown where gas can be added. A new wallet has none of its chain's own coin to pay network fees with, so a coin that arrives there, such as USDC on Solana, cannot be moved. With Add gas on, a second, small order delivers a little of the chain's own coin to the same receiving address, by the same private route as the swap, so the new wallet needs no funding from an old one. There are two payments: one for the swap, and one for the gas. How Add gas works";
const HOME_LINE = "A switch on the swap card, where gas can be added. With it on, a second, small order delivers a little of the receiving chain's own coin to the same address, by the same private route, so a new wallet can move what arrived straight away. There are two payments.";
// What four pages say of paying, where a swap can have gas added: each in the place where the page speaks of one transfer.
const GUIDE_PAY = "Pay the order from a connected wallet, which is asked for one transfer and nothing else, or send the exact amount yourself to the deposit address shown. With Add gas there are two orders, and each is paid in this way: one transfer for the swap, and a second for the gas.";
const SAFETY_WALLET =
  "To pay an order your wallet is asked for one transfer: the order's amount, to the order's deposit address. Paying never asks it to approve spending or to sign a message. With Add gas there are two orders, so your wallet is asked for two transfers, one after the other: one for the swap, and a second for the gas. Each is a plain transfer of that order's amount to that order's own deposit address.";
const FAQ_WALLET = "No. You can connect a wallet and pay with one transfer, or pay without connecting by sending to the deposit address shown for your order, from any wallet. With Add gas there are two orders, and so two payments: two transfers from a connected wallet, or two deposit addresses to send to.";
const HOME_STEP = "Send one transfer from your wallet, or to the deposit address shown; with Add gas on, a second for the gas. The order's page follows it to the end.";
const TERMS_PARAGRAPH = "With Add gas switched on, confirming makes two orders: one for the swap, and one for the gas. Each is an order of its own, with its own deposit address, deadline and refund, and each is paid separately. If the gas order cannot be made, the swap is made all the same.";
const PRIVACY_ITEM =
  "Add gas. When gas is added to a swap, the gas order is a second order of its own, kept as any order is and for as long. The swap's record notes whether its gas order was made, and the gas order's record that it is one. The gas order's ID is worked out from the swap's, which is how the swap's page shows both; neither record holds the other's ID. A delivered gas order adds its value in US dollars to the running totals, with no row of its own and without being counted as a swap, and its points are written down as set out under Points. Where the two are made in Ghost mode, each is deleted as set out under Ghost mode, below.";
// The same four places where swaps are routed in public: as they have always read.
const GUIDE_PAY_PUBLIC = "Pay the order from a connected wallet, which is asked for one transfer and nothing else, or send the exact amount yourself to the deposit address shown. Either way, you send the coins yourself.";
const SAFETY_WALLET_PUBLIC = "To pay an order your wallet is asked for one transfer: the order's amount, to the order's deposit address. Paying never asks it to approve spending or to sign a message. One page asks for a signature, and it is not this one";
const FAQ_WALLET_PUBLIC = "No. You can connect a wallet and pay with one transfer, or pay without connecting by sending to the deposit address shown for your order, from any wallet. What happens if a swap fails?";
const HOME_STEP_PUBLIC = "Send one transfer from your wallet, or to the deposit address shown. The order's page follows it to the end.";

describe("the Docs' page on Add gas", () => {
  it("is a page at /docs/add-gas only where swaps are routed privately, and is in the contents after 'Ghost mode'", () => {
    expect(GAS_DOC_SLUG).toBe("add-gas");
    expect(docHref(GAS_DOC_SLUG)).toBe("/docs/add-gas");
    expect(isDocSlug("add-gas")).toBe(true);
    // The router reads the address as one page of the documentation, and nothing near it as a page at all.
    expect(matchRoute("/docs/add-gas")).toEqual({ page: "docs", slug: "add-gas" });
    for (const near of ["/docs/add", "/docs/gas", "/docs/add-gas/", "/docs/Add-gas", "/docs/add_gas", "/docs/add--gas", "/docs/add-gas-more", "/add-gas"]) expect(matchRoute(near).page, near).toBe("not-found");
    // The pages that exist only where swaps are routed privately are two: the one on private routing, and this one.
    expect([...PRIVATE_ONLY_DOC_SLUGS]).toEqual([PRIVATE_DOC_SLUG, GAS_DOC_SLUG]);
    expect(docSlugs(true)).toContain("add-gas");
    expect(docSlugs(false)).not.toContain("add-gas");
    expect([...docSlugs(false)]).toEqual(DOC_SLUGS.filter((slug) => slug !== "private" && slug !== "add-gas"));
    expect(docExists(GAS_DOC_SLUG, true)).toBe(true);
    expect(docExists(GAS_DOC_SLUG, false)).toBe(false);
    // In the contents: after "Ghost mode", before "Points and weekly rewards"; where swaps are routed in public, nowhere.
    expect(GAS_DOC).toEqual({ href: "/docs/add-gas", title: "Add gas", group: "Guide" });
    const pages = docPages(true).map((page) => page.href);
    expect(pages.indexOf("/docs/add-gas")).toBe(pages.indexOf("/docs/ghost-mode") + 1);
    expect(pages.indexOf("/docs/add-gas")).toBe(pages.indexOf("/docs/rewards") - 1);
    expect(DOC_SLUGS.indexOf("add-gas")).toBe(DOC_SLUGS.indexOf("ghost-mode") + 1);
    expect(neighbours("/docs/add-gas", docPages(true))).toMatchObject({ previous: { href: "/docs/ghost-mode" }, next: { href: "/docs/rewards" } });
    for (const list of [DOC_PAGES, docPages(false)]) expect(list.some((page) => page.href === GAS_DOC.href || /gas/i.test(page.title))).toBe(false);
    expect(neighbours("/docs/add-gas", docPages(false))).toEqual({ previous: null, next: null });
    // Whatever asks without saying how swaps are routed is given the public answer, so the page cannot be listed by oversight.
    expect(neighbours("/docs/add-gas")).toEqual({ previous: null, next: null });
    // As drawn: its title, its place in the contents of every page of the documentation, and the pages before and after it.
    const markup = draw(gasDocs);
    expect(markup).toContain("<h1>Add gas</h1>");
    expect(markup).toContain('<a href="/docs/add-gas" class="docs-page-link" aria-current="page">Add gas</a>');
    for (const other of [docsPage(null), docsPage("fees"), docsPage("ghost-mode"), docsPage("faq"), privacy, terms]) expect(draw(other)).toContain('<a href="/docs/add-gas" class="docs-page-link">Add gas</a>');
    expect(markup).toMatch(/<a href="\/docs\/ghost-mode" class="docs-turn-link" data-way="previous">/);
    expect(markup).toMatch(/<a href="\/docs\/rewards" class="docs-turn-link" data-way="next">/);
    expect(draw(docsPage("ghost-mode"))).toMatch(/<a href="\/docs\/add-gas" class="docs-turn-link" data-way="next">/);
    expect(draw(docsPage("rewards"))).toMatch(/<a href="\/docs\/add-gas" class="docs-turn-link" data-way="previous">/);
  });

  describe("the server's own answer for its address", () => {
    let dir = "";
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-gas-words-"));
      fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><head><title>IntentSwap</title></head><body><div id="root"></div>${" ".repeat(600)}</body></html>`);
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    /** What a browser is sent for an address, by a site loaded with these options. */
    const answer = async (options: Parameters<typeof loadStaticSite>[1], route: string) => {
      const site = loadStaticSite(dir, options)!;
      const server = http.createServer((req, res) => void site.handle(req, res, requestPath(req) ?? "/"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`);
      const text = await res.text();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return { status: res.status, body: text, cache: res.headers.get("cache-control"), robots: res.headers.get("x-robots-tag") };
    };

    it("is the site's page where swaps are routed privately, and 'not found' everywhere else", async () => {
      // Told nothing of routing, and told that swaps are routed in public: an unknown path like any other.
      for (const options of [{}, { privateRouting: false }, { privateRouting: false, statsPage: true, tokenPage: true, testPages: true, siteUrl: "https://intentswap.example" }]) {
        expect(await answer(options, "/docs/add-gas"), JSON.stringify(options)).toMatchObject({ status: 404, cache: "no-store", robots: "noindex" });
      }
      // Routed privately: one of the site's own pages, and it names its own address where the site knows its own.
      const page = await answer({ privateRouting: true }, "/docs/add-gas");
      expect(page).toMatchObject({ status: 200, cache: "no-cache", robots: null });
      expect(page.body).toContain('<div id="root">');
      expect((await answer({ privateRouting: true, siteUrl: "https://intentswap.example" }, "/docs/add-gas")).body).toContain('<link rel="canonical" href="https://intentswap.example/docs/add-gas" />');
      // Its address is exact, and the page on private routing is still there beside it.
      for (const near of ["/docs/add-gas/", "/docs/Add-gas", "/docs/add-gas/more", "/docs/add-gass", "/docs/add", "/docs/gas", "/add-gas"]) expect((await answer({ privateRouting: true }, near)).status, near).toBe(404);
      expect((await answer({ privateRouting: true }, "/docs/private")).status).toBe(200);
      expect((await answer({ privateRouting: false }, "/docs/private")).status).toBe(404);
    });
  });

  it("has these sections, in this order", () => {
    for (const config of [ROUTED_PRIVATELY, WITHOUT_STATS]) {
      expect(sections(draw(gasDocs, config))).toEqual(["what: What it does", "when: When the switch is there", "payments: Two payments", "alone: Each order stands alone", "where: Where the gas goes", "cost: What it costs", "points: Points and totals", "ghost-mode: In Ghost mode"]);
    }
  });

  it("says what it does: a second, small order that delivers a little of the chain's own coin to the same address", () => {
    const markup = draw(gasDocs);
    expect(words(markup)).toContain(`Add gas ${LEAD}`);
    const what = section(markup, "what");
    for (const sentence of [
      "Each chain has a coin of its own, and its network fees are paid in that coin: SOL on Solana, for example.",
      "When a swap delivers another coin to a new, empty wallet, such as USDC on Solana, the coins arrive and cannot be moved, because the wallet has none of the chain's own coin to pay a fee with.",
      "With Add gas switched on, a second, small order is made beside the swap. It delivers a little of the receiving chain's own coin to the same receiving address, so the wallet can pay network fees and move what arrived straight away.",
      // Nothing but orders and transfers.
      "No contract is involved. It is done with ordinary orders and plain transfers. IntentSwap never holds your funds.",
    ])
      expect(what, sentence).toContain(sentence);
  });

  it("gives the sizes the server itself uses: about $3, and more only on the chains that have a size of their own", () => {
    // The rule (shared/gas.ts): three dollars, five on Ethereum and Gnosis, ten on Tron, and never more.
    expect([...GAS_SIZES_USD]).toEqual([3, 5, 10]);
    expect(gasSizes()).toEqual({ usual: 3, larger: [{ usd: 5, chains: ["Ethereum", "Gnosis"] }, { usd: 10, chains: ["Tron"] }] });
    // Worked out from that rule over every chain the site knows: no chain with a size of its own is left out, and none is named that has not.
    const named = gasSizes().larger.flatMap((size) => size.chains);
    for (const chain of CHAINS.values()) expect(named.includes(chain.name), chain.key).toBe(gasSizeFor(chain.key) !== GAS_USD);
    for (const size of gasSizes().larger) for (const name of size.chains) expect(gasSizeFor([...CHAINS.values()].find((chain) => chain.name === name)?.key ?? "")).toBe(size.usd);
    expect(section(draw(gasDocs), "what")).toContain("A gas order is for about $3. On Ethereum and Gnosis it is about $5 and on Tron about $10. The review shows how much of the chain's own coin arrives, before you confirm.");
    // Names are said as a sentence says them.
    expect([listed([]), listed(["A"]), listed(["A", "B"]), listed(["A", "B", "C"])]).toEqual(["", "A", "A and B", "A, B and C"]);
  });

  it("says when the switch is there, and that where it is not offered there is none", () => {
    const markup = draw(gasDocs);
    const when = section(markup, "when");
    expect(markup.match(/<h2 id="when"[\s\S]*?<\/ul>/)?.[0].match(/<li>/g)).toHaveLength(5);
    for (const sentence of [
      "The switch is on the swap card, under the receiving address. It is offered when all of these are so:",
      "The coin you receive is not its chain's own coin. USDC on Solana is one such: fees there are paid in SOL.",
      "The swap is privately routed. Gas is offered only beside a privately routed swap.",
      "A valid receiving address is on the card. Gas is for that address, so the switch arrives once it is entered.",
      "The coin you pay with is not the receiving chain's own coin. An order cannot swap a coin for itself.",
      "The swap service will take the small order just then.",
      "Where it is not offered, there is no switch.",
    ])
      expect(when, sentence).toContain(sentence);
  });

  it("says that there are two payments, by deposit address and from a wallet, and that they are never combined", () => {
    const markup = draw(gasDocs);
    const payments = section(markup, "payments");
    for (const sentence of [
      "The gas order is paid with the same coin as the swap. So there are two payments: one for the swap, and one for the gas.",
      "Sending it yourself: two deposit addresses, one for each order, and two separate transfers.",
      // From a wallet: plain transfers, and never anything else.
      "Paying from a connected wallet: two plain transfers, one after the other, each confirmed in your wallet. Nothing else is ever asked of the wallet, and never an approval of spending.",
      "Two separate transfers, never combined. Each order has its own deposit address and its own amount. Send each amount to its own address.",
    ])
      expect(payments, sentence).toContain(sentence);
    expect(markup).toMatch(/<h2 id="payments"[\s\S]*?<aside class="callout" data-tone="warning">[\s\S]*?<p class="callout-title">Two separate transfers, never combined\.<\/p>/);
  });

  it("says that each order stands alone, and what happens when only one is paid or the gas order cannot be made", () => {
    const alone = section(draw(gasDocs), "alone");
    for (const sentence of [
      "The gas order is an ordinary order, with its own quote, its own deposit address, its own deadline and its own refund. Neither order waits for the other.",
      "Only the swap is paid: the swap is delivered. The gas order runs out unpaid, and nothing is lost.",
      "Only the gas is paid: the gas arrives.",
      "The gas order cannot be made at the moment you confirm: the swap is made all the same, and its page says that gas was not added.",
    ])
      expect(alone, sentence).toContain(sentence);
  });

  it("says that the gas goes only to the swap's receiving address, only ever by private routing, and that this is not anonymity", () => {
    const markup = draw(gasDocs);
    expect(section(markup, "where")).toBe(
      "Where the gas goes Always to the swap's receiving address. No other address can be given for it. The gas order is only ever routed privately, like the swap beside it. So the gas arrives by the same private route, and a new wallet needs no funding from an old one. Its deposit and its delivery are still public transfers, as the swap's are. With gas there are two of each, close together in time: two deposits from the paying wallet, and two deliveries to the receiving address. Private routing is not anonymity. How private routing works",
    );
    expect(markup).toMatch(/<h2 id="where"[\s\S]*?<a href="\/docs\/private">How private routing works<\/a>/);
  });

  it("says what it costs as the site says what any order costs, with no figure of its own", () => {
    const cost = section(draw(gasDocs), "cost");
    expect(cost).toBe("What it costs IntentSwap takes no fee on either order. The provider's fee and the receiving chain's network fee apply to the gas order as to any order, and both are shown before you confirm.");
    // The figures of a fee are on the Fees page, read from a quote. This page gives none.
    expect(words(body(draw(gasDocs)))).not.toMatch(/%|basis points|\bbps\b/i);
  });

  it("says what a delivered gas order adds: points as any order, its dollars to the volume, and neither a swap to the count nor a row to the list", () => {
    const withStats = draw(gasDocs);
    expect(section(withStats, "points")).toBe("Points and totals A delivered gas order adds points as any order does. On the Stats page its value in US dollars is counted in the volume. It is not counted as another swap, and it has no row among the recent swaps.");
    expect(withStats).toMatch(/<h2 id="points"[\s\S]*?<a href="\/docs\/rewards">points<\/a>[\s\S]*?<a href="\/stats">Stats page<\/a>/);
    // Where the site has no Stats page, it names none.
    const without = draw(gasDocs, WITHOUT_STATS);
    expect(section(without, "points")).toBe("Points and totals A delivered gas order adds points as any order does. The server's running totals count its value in US dollars in the volume. It is not counted as another swap, and no row is kept for it.");
    expect(body(without)).not.toMatch(/Stats page|href="\/stats"/);
  });

  it("says that it works in Ghost mode, and that each of the two records is deleted when its own order finishes", () => {
    const markup = draw(gasDocs);
    expect(section(markup, "ghost-mode")).toBe("In Ghost mode Add gas works in Ghost mode. Both orders are then made in Ghost mode, and the record of each is deleted when that order is delivered or refunded.");
    expect(markup).toMatch(/<h2 id="ghost-mode"[\s\S]*?<a href="\/docs\/ghost-mode">Ghost mode<\/a>/);
  });
});

describe("the question on Add gas", () => {
  it("is asked only where swaps are routed privately, once, after the question on Ghost mode", () => {
    const ids = questions(true).map((item) => item.id);
    expect(ids.filter((id) => id === "add-gas")).toHaveLength(1);
    expect(ids.indexOf("add-gas")).toBe(ids.indexOf("ghost-mode") + 1);
    expect(ids.indexOf("add-gas")).toBe(ids.indexOf("points") - 1);
    expect(questions(true).find((item) => item.id === "add-gas")).toMatchObject({ question: "What is Add gas?", privateOnly: true });
    expect(questions(false).map((item) => item.id)).not.toContain("add-gas");
    expect(questions(false).some((item) => /gas/i.test(item.question))).toBe(false);
  });

  it("is answered in four plain sentences and a link to the page that explains the rest, on the home page and in the Docs", () => {
    for (const config of [ROUTED_PRIVATELY, WITHOUT_STATS]) {
      for (const page of [faq, docsPage("faq")]) {
        const markup = draw(page, config);
        expect(words(markup)).toContain(`What is Add gas? ${page === faq ? "" : "Link to this section "}${FAQ_ANSWER}`);
        expect(markup).toContain('<a href="/docs/add-gas">How Add gas works</a>');
      }
    }
    expect(FAQ_ANSWER.replace(" How Add gas works", "").match(/[.](?= |$)/g)).toHaveLength(4);
  });
});

describe("the home page's line for Add gas", () => {
  it("is on the list of what the site does only where swaps are routed privately, in the list's own manner: a title, a few sentences, a link", () => {
    for (const tokenSet of [false, true]) {
      expect(features(tokenSet, true).find((feature) => feature.key === "gas")).toEqual({ key: "gas", title: "Add gas", text: HOME_LINE, link: { href: "/docs/add-gas", label: "How Add gas works" } });
      // After Ghost mode, and before the token where there is one.
      expect(features(tokenSet, true).map((feature) => feature.key)).toEqual(["swaps", "tracking", "rewards", "ghost", "gas", ...(tokenSet ? ["token"] : [])]);
      // Routed in public, or asked without saying how swaps are routed: it is not on the list, and nothing on the list speaks of gas.
      for (const list of [features(tokenSet, false), features(tokenSet)]) {
        expect(list.map((feature) => feature.key)).toEqual(["swaps", "tracking", "rewards", "ghost", ...(tokenSet ? ["token"] : [])]);
        expect(JSON.stringify(list)).not.toMatch(/gas/i);
      }
    }
    // Of the length of the others: no more than a line or two longer than the longest of them.
    const others = features(true, true).filter((feature) => feature.key !== "gas");
    expect(HOME_LINE.length).toBeLessThanOrEqual(Math.max(...others.map((feature) => feature.text.length)) + 30);
    // It leads to a page that exists wherever the line is shown.
    expect(matchRoute("/docs/add-gas")).toEqual({ page: "docs", slug: "add-gas" });
    expect(docExists(GAS_DOC_SLUG, true)).toBe(true);
  });

  it("is drawn on the stage as the others are: its number, its words, its link and a drawing of its own", () => {
    const markup = draw(home);
    expect(words(markup)).toContain(`Add gas ${HOME_LINE} How Add gas works`);
    expect(markup).toMatch(/<a href="\/docs\/add-gas" class="stage-link draw">How Add gas works/);
    // Every item has a tab, a panel and a drawing.
    const count = features(false, true).length;
    expect(count).toBe(5);
    expect(markup.match(/<button type="button" role="tab"/g)).toHaveLength(count);
    expect(markup.match(/<div role="tabpanel"/g)).toHaveLength(count);
    expect(markup.match(/<div class="stage-art"><svg class="art" viewBox="0 0 280 200" aria-hidden="true" focusable="false">/g)).toHaveLength(count);
    // The drawing is in the line style of the others: the same marks, the same strokes, nothing coloured by itself, and no movement of its own.
    const stage = source("components/Stage.tsx");
    const art = part(stage, "function GasArt()");
    expect(art).toMatch(/className="art-quiet"[^>]*strokeDasharray="2 8"/);
    for (const mark of ["art-line", "art-ink", "art-accent", "art-accent-fill", "art-count"]) expect(art, mark).toContain(mark);
    expect([...art.matchAll(/className="([^"]+)"/g)].flatMap((match) => (match[1] ?? "").split(" ")).filter((name) => !["art", "art-quiet", "art-line", "art-ink", "art-accent", "art-accent-fill", "art-count"].includes(name))).toEqual([]);
    expect(art).not.toMatch(/fill=|stroke=|style=|#[0-9a-f]{3,6}/i);
    expect(stage).toContain("gas: GasArt,");
  });
});

/** The words the site never uses of points and rewards, wherever they would stand. */
const REWARDS_NEVER = /\b(?:earn(?:s|ed|ing)?|yield(?:s)?|returns|APR|APY|passive|profit(?:s)?|income|interest|invest(?:ment|ing)?|dividend(?:s)?|airdrop(?:s)?|free money|risk-free)\b/i;
/**
 * What is never promised of a wallet, of gas or of a route: that anything cannot be linked or
 * traced, that a link is broken, cut or gone, or that anything is wholly or always private.
 */
const PROMISE = new RegExp(
  [
    "can(?:not|'t| not) be (?:linked|traced|tracked|matched|followed|identified|seen|connected|tied)",
    "\\b(?:unlink\\w*|untrac\\w*|anonym\\w*|invisib\\w*|guarant\\w*|secret\\w*|incognito|stealth\\w*)\\b",
    "(?:no|without (?:a|any)|breaks? the|cuts? the|removes? the|hides? the) (?:link|trace|trail|connection)\\b",
    "(?:fully|completely|totally|always|truly) (?:private|confidential|hidden|separate)",
    "(?:no one|nobody|no-one) (?:can|will) (?:see|know|tell|link|trace)",
    "\\bhid(?:e|es|den|ing)\\b|\\bconceal\\w*",
  ].join("|"),
  "i",
);
/** Nothing is said to be on its way, and nothing of what the swap service will or will not take beyond its own answer. */
const NOT_SAID = /coming soon|not yet|\bsoon\b|\bplanned\b|\bminimums?\b|\bat least \$|\bno liquidity\b|\bBNB Chain\b|\bBitcoin\b/i;
/** The sentence that says what private routing is not, as the wording test allows it: it denies the word, and is no promise. */
const allowed = (text: string) => text.replace(/Private routing is not anonymity/g, "");

describe("what the site says of Add gas, taken together", () => {
  /** Every text of the feature, as it is drawn: the page whole, with and without the Stats page, and each sentence that is the feature's own on another page. */
  const texts = (): (readonly [string, string])[] => [
    ["Docs, Add gas", words(body(draw(gasDocs)))],
    ["Docs, Add gas (no Stats page)", words(body(draw(gasDocs, WITHOUT_STATS)))],
    ["the question", FAQ_ANSWER],
    ["the home page's line", HOME_LINE],
    ["Docs, How it works: paying", GUIDE_PAY],
    ["Docs, Staying safe: the wallet", SAFETY_WALLET],
    ["the question on connecting a wallet", FAQ_WALLET],
    ["the home page's third step", HOME_STEP],
    ["the Terms", TERMS_PARAGRAPH],
    ["the Privacy Policy", PRIVACY_ITEM],
  ];
  /** The three that are about the feature and nothing else: the page, the answer, the line. */
  const three = () => texts().slice(0, 4);

  it("each of those sentences is on its page, word for word, where swaps are routed privately", () => {
    for (const config of [ROUTED_PRIVATELY, WITHOUT_STATS]) {
      expect(section(draw(docsPage(null), config), "pay")).toContain(GUIDE_PAY);
      expect(section(draw(docsPage("safety"), config), "wallet")).toContain(SAFETY_WALLET);
      for (const page of [faq, docsPage("faq")]) expect(words(draw(page, config))).toContain(FAQ_WALLET);
      expect(words(draw(home, config))).toContain(`Pay and track ${HOME_STEP}`);
      expect(section(draw(terms, config), "how-a-swap-works")).toContain(`You then pay it, either from a connected wallet or by sending to the deposit address shown. ${TERMS_PARAGRAPH} Blockchain transfers cannot be undone.`);
      expect(section(draw(privacy, config), "what-is-kept-on-the-server-and-for-how-long")).toContain(`${PRIVACY_ITEM} Ghost mode. An order made in Ghost mode is marked as one.`);
    }
    // The two pages of the documentation name the feature as a link to its page.
    expect(draw(docsPage(null))).toMatch(/<h2 id="pay"[\s\S]*?With <a href="\/docs\/add-gas">Add gas<\/a> there are two orders/);
    expect(draw(docsPage("safety"))).toMatch(/<h2 id="wallet"[\s\S]*?With <a href="\/docs\/add-gas">Add gas<\/a> there are two orders/);
    // The Privacy Policy's item names no Stats page, so it reads the same where the site has none; and the Terms keep their sections and their numbers.
    expect(PRIVACY_ITEM).not.toMatch(/Stats page/);
    expect(sections(draw(terms)).length).toBe(sections(draw(terms, ROUTED_IN_PUBLIC)).length + 1);
  });

  it("uses none of the words the site never uses, and none of the words it never uses of points", () => {
    const all = texts();
    expect(all).toHaveLength(10);
    for (const [where, text] of all) {
      expect(text.length, where).toBeGreaterThan(100);
      expect(NEVER.exec(allowed(text))?.[0] ?? null, where).toBeNull();
      expect(REWARDS_NEVER.exec(text)?.[0] ?? null, where).toBeNull();
    }
    // The words it does use of points are the site's own.
    expect(words(body(draw(gasDocs)))).toContain("A delivered gas order adds points as any order does.");
    // A check that can fail.
    for (const sentence of ["Gas arrives anonymously.", "An untraceable top-up.", "Guaranteed to arrive.", "It works like a mixer."]) expect(NEVER.test(sentence), sentence).toBe(true);
    for (const sentence of ["Earn points on gas.", "The yield on gas.", "Gas returns more points.", "A 5% APR."]) expect(REWARDS_NEVER.test(sentence), sentence).toBe(true);
  });

  it("the page, the answer and the line each say that there are two payments, that the gas goes to the same receiving address, and that it is privately routed", () => {
    for (const [where, text] of three()) {
      expect(text, where).toMatch(/\btwo payments\b/);
      expect(text, where).toMatch(/to the same (?:receiving )?address\b/);
      expect(text, where).toMatch(/\bby the same private route\b/);
    }
    // The page says both in full: no other address can be given for the gas, and no other routing.
    const page = words(body(draw(gasDocs)));
    expect(page).toContain("Always to the swap's receiving address. No other address can be given for it.");
    expect(page).toContain("The gas order is only ever routed privately, like the swap beside it.");
    expect(page).toContain("So there are two payments: one for the swap, and one for the gas.");
  });

  it("never promises that a wallet cannot be linked or traced, or more of a route than the provider says of it", () => {
    for (const [where, text] of texts()) expect(PROMISE.exec(allowed(text))?.[0] ?? null, where).toBeNull();
    // What is said instead is what it does: the gas arrives by the same private route, so a new wallet needs no funding from an old one.
    expect(words(body(draw(gasDocs)))).toContain("So the gas arrives by the same private route, and a new wallet needs no funding from an old one.");
    expect(FAQ_ANSWER).toContain("by the same private route as the swap, so the new wallet needs no funding from an old one");
    // Wherever a page speaks of that route, the same page says that private routing is not anonymity, and that both ends are still public.
    expect(words(body(draw(gasDocs)))).toContain("Its deposit and its delivery are still public transfers, as the swap's are. With gas there are two of each, close together in time: two deposits from the paying wallet, and two deliveries to the receiving address. Private routing is not anonymity.");
    for (const page of [faq, docsPage("faq"), home]) expect(words(draw(page))).toContain("Private routing is not anonymity");
    // A check that can fail.
    for (const sentence of [
      "The new wallet cannot be linked to the old one.",
      "A wallet that can't be traced.",
      "Gas with no link to your old wallet.",
      "It breaks the link between your wallets.",
      "An unlinkable wallet.",
      "The gas is always private.",
      "Nobody can tell where the gas came from.",
      "It hides where the gas came from.",
    ])
      expect(PROMISE.test(sentence), sentence).toBe(true);
    for (const sentence of ["So the gas arrives by the same private route, and a new wallet needs no funding from an old one.", "The gas order is only ever routed privately, like the swap beside it.", "No other address can be given for it.", "the coins arrive and cannot be moved"]) expect(PROMISE.test(sentence), sentence).toBe(false);
  });

  it("says nothing is on its way, and nothing of what the swap service will not take but that the switch is then not there", () => {
    for (const [where, text] of texts()) expect(NOT_SAID.exec(text)?.[0] ?? null, where).toBeNull();
    for (const sentence of ["Add gas is coming soon to more chains.", "The minimum is $3.", "Not offered to BNB Chain.", "Gas to Bitcoin needs at least $10."]) expect(NOT_SAID.test(sentence), sentence).toBe(true);
  });

  it("always calls it Add gas: capital A, small g", () => {
    for (const [where, text] of texts()) expect(text.match(/\badd gas\b/gi)?.filter((name) => name !== "Add gas") ?? [], where).toEqual([]);
    for (const file of ["pages/DocsPage.tsx", "pages/LegalPages.tsx", "components/Faq.tsx", "components/Home.tsx", "lib/site-logic.ts", "lib/docs-logic.ts"]) expect(source(file).match(/\badd gas\b/gi)?.filter((name) => name !== "Add gas") ?? [], file).toEqual([]);
  });
});

/** A page says that paying is one transfer. (Not the one plain message of the Rewards sign-in, which is no transfer.) */
const ONE_TRANSFER = /\b(?:one|a single|only one|just one) (?:plain )?transfer\b/i;
/** The parts of a drawn page that each stand by themselves: a section of the documentation, a question, a step or an item of the home page. */
const parts = (markup: string) => markup.split(/(?=<h2\b|<details\b|<li class="how-step"|<li class="statement"|<div role="tabpanel")/).map(words);

describe("what a wallet is asked for, where a swap can have gas added", () => {
  /** Every page of words, as it stands on a site that routes swaps in this way. */
  const pages = (privateRouting: boolean): (readonly [string, () => ReactElement])[] => [["the home page", home], ["the questions", faq], ["Docs, How it works", docsPage(null)], ...docSlugs(privateRouting).map((slug) => [`Docs, ${slug}`, docsPage(slug)] as const), ["the Terms", terms], ["the Privacy Policy", privacy]];

  it("no page says that paying is one transfer without saying, in the same place, that with Add gas there are two", () => {
    for (const config of [ROUTED_PRIVATELY, WITHOUT_STATS]) {
      const saying = pages(true).flatMap(([label, page]) => parts(draw(page, config)).filter((text) => ONE_TRANSFER.test(text)).map((text) => [label, text] as const));
      // The places that say it: the third step of the home page, the question on connecting a wallet (on the home page and in the Docs), and two sections of the documentation.
      expect(saying.map(([label]) => label)).toEqual(["the home page", "the questions", "Docs, How it works", "Docs, safety", "Docs, faq"]);
      for (const [label, text] of saying) {
        expect(text, label).toContain("Add gas");
        expect(text, label).toMatch(/\btwo (?:orders|transfers|payments)\b|\ba second for the gas\b/);
      }
    }
  });

  it("the page on what a wallet is asked for says that a second request is then expected, and still that nothing but a transfer ever is", () => {
    const wallet = section(draw(docsPage("safety")), "wallet");
    expect(wallet).toContain(SAFETY_WALLET);
    expect(wallet).toContain("Anything else is not IntentSwap. If a page in IntentSwap's name asks your wallet to approve spending, or to sign anything while you are paying, close it.");
  });

  it("is a check that can fail", () => {
    for (const sentence of ["Your wallet is asked for one transfer.", "Pay with one plain transfer.", "A single transfer pays the order.", "Only one transfer is ever asked for."]) expect(ONE_TRANSFER.test(sentence), sentence).toBe(true);
    // Two transfers are not one, and the one plain message of the Rewards sign-in is no transfer.
    for (const sentence of ["It is asked for two transfers, one after the other.", "signing one plain message", "a second for the gas"]) expect(ONE_TRANSFER.test(sentence), sentence).toBe(false);
    expect(parts('<h2 id="a">A</h2><p>one transfer</p><h2 id="b">B</h2><p>With Add gas, two.</p>').filter((text) => ONE_TRANSFER.test(text))).toEqual(["A one transfer"]);
  });

  it("the README states the rule the code keeps: one plain transfer for each order", () => {
    const readme = fs.readFileSync(path.resolve("README.md"), "utf8");
    expect(readme).toContain("- The wallet is asked for one plain transfer for each order: one for a swap, and a second when gas is added. Never an approval, a permit or a message signature.");
    expect(readme).toContain("└─ one transfer per order");
    expect(readme).not.toMatch(/asked for one plain transfer\.|signs one transfer/);
  });
});

describe("where swaps are routed in public, nothing on the site speaks of Add gas", () => {
  const pages: (readonly [string, () => ReactElement])[] = [["the home page", home], ["the questions", faq], ["Docs, How it works", docsPage(null)], ...docSlugs(false).map((slug) => [`Docs, ${slug}`, docsPage(slug)] as const), ["the Terms", terms], ["the Privacy Policy", privacy]];

  describe.each(NOT_PRIVATE)("as drawn %s", (_when, config) => {
    it.each(pages)("%s does not say the word, and leads to no page about it", (_name, page) => {
      const markup = draw(page, config);
      expect(words(markup).length).toBeGreaterThan(30);
      expect(words(markup)).not.toMatch(/\bgas\b/i);
      expect(markup).not.toMatch(/\/docs\/add-gas|add-gas/);
    });

    it("what the pages say of paying is what they have always said", () => {
      expect(section(draw(docsPage(null), config), "pay")).toContain(GUIDE_PAY_PUBLIC);
      expect(section(draw(docsPage("safety"), config), "wallet")).toContain(SAFETY_WALLET_PUBLIC);
      expect(words(draw(faq, config))).toContain(FAQ_WALLET_PUBLIC);
      expect(words(draw(home, config))).toContain(`Pay and track ${HOME_STEP_PUBLIC}`);
      expect(section(draw(terms, config), "how-a-swap-works")).toContain("You then pay it, either from a connected wallet or by sending to the deposit address shown. Blockchain transfers cannot be undone.");
    });
  });

  it("the page itself is not a page there: the site's own router asks whether it exists before any page of the documentation is drawn", () => {
    expect(docExists(GAS_DOC_SLUG, false)).toBe(false);
    for (const slug of [null, ...docSlugs(false)]) expect(docExists(slug, false), String(slug)).toBe(true);
    const app = source("App.tsx");
    expect(app).toMatch(/const route: Route = matched\.page === "docs" && !docExists\(matched\.slug, privateOn\) && boot !== "loading" \? \{ page: "not-found" \} : matched;/);
    expect(app.indexOf('route.page === "docs" && !docExists(route.slug, privateOn)')).toBeGreaterThan(-1);
    expect(app.indexOf('route.page === "docs" && !docExists(route.slug, privateOn)')).toBeLessThan(app.indexOf("<DocsPage slug={route.slug} />"));
  });
});

describe("the README's section on Add gas", () => {
  const readme = fs.readFileSync(path.resolve("README.md"), "utf8");
  const about = /\n## Add gas\n[\s\S]*?(?=\n## )/.exec(readme)?.[0] ?? "";
  const flat = about.replace(/\s+/g, " ");

  it("says what it is and what the server does: a second ordinary order to the swap's receiving address, only ever privately routed, its sizes, its preview, and what pairs the two", () => {
    expect(about.length).toBeGreaterThan(1500);
    for (const sentence of [
      "a second, small order is made beside the swap",
      "The server sets the gas order's receiving address: always exactly the swap's.",
      "Privately, and only ever privately.",
      "About $3 of the paying coin, at the coin list's price; $5 to Ethereum and Gnosis, $10 to Tron.",
      "`POST /api/gas` says whether gas can be added beside a swap",
      "It answers `gas: null` wherever gas is not offered",
      "The gas order's ID is derived from the swap's",
      "Nothing else pairs the two but the records themselves",
      "Two payments, never combined.",
      "`/docs/add-gas` is \"Page not found.\"",
    ])
      expect(flat, sentence).toContain(sentence);
    // The sizes it gives are the ones the code holds.
    expect([GAS_USD, gasSizeFor("eth"), gasSizeFor("gnosis"), gasSizeFor("tron"), GAS_SIZES_USD[GAS_SIZES_USD.length - 1]]).toEqual([3, 5, 5, 10, 10]);
  });

  it("names no folder of anyone's machine, and uses none of the words the site never uses", () => {
    // (Put together from parts, so that this file does not hold what it looks for.)
    expect(about).not.toMatch(new RegExp(["/Us", "ers/|/ho", "me/|/pri", "vate/|~/|[A-Z]:\\\\"].join("")));
    expect(NEVER.exec(about)?.[0] ?? null).toBeNull();
    expect(PROMISE.exec(about)?.[0] ?? null).toBeNull();
  });
});
