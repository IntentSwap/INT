// Walks the interface in a real browser and saves screenshots of each state at
// 360, 768 and 1280 px in both themes. Also fails on anything the console
// complained about, any request to another site, any sideways scrolling, a main
// button that is out of view, and anything that moves when a quote arrives.
//
//   npx tsx scripts/review-shots.ts <base-url> [--practice=<url>] [scenario-or-walk-name ...]
//
// With --practice pointing at a second server started with PROVIDER_STUB=true, it also
// walks the steps that make an order (pretend orders only; that server never makes a real one).
//
// Uses the Chrome already installed on this machine. Output goes to docs/review.

import fs from "node:fs";
import path from "node:path";
import { bech32 } from "@scure/base";
import { chromium, type Page } from "playwright-core";
import { axeProblems, SAMPLES_PAGE_SKIPS } from "./axe.ts";
import { chipsWalk } from "./chips-walk.ts";
import { freshSol, orderPace, orderWalk, seeAll, settle } from "./order-walk.ts";
import { siteWalk } from "./site-walk.ts";
import { walletWalk } from "./wallet-walk.ts";
import { focusWalk } from "./focus-walk.ts";
import { privateWalk } from "./private-walk.ts";
import { rewardsWalk } from "./rewards-walk.ts";

const WIDTHS = [360, 768, 1280] as const;
const THEMES = ["dark", "light"] as const;
// Example addresses are made up from fixed text (a hash of a phrase), so they are nobody's.
const SOL = "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP";
// A token contract on Base: an address that is a contract, where a wallet is expected.
const CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const STELLAR = "GAQMXQJ2UFA5ECB2JJ3GUYQF46ROPVINVWAMN7KNR3OAMDHLQ46LFRBW";
// The longest kind of address the site accepts: a Cardano base address, 103 characters. Made from fixed bytes, so it is nobody's.
const CARDANO = bech32.encode("addr", bech32.toWords(Uint8Array.from([0x01, ...Array.from({ length: 56 }, (_, i) => (i * 7 + 3) % 256)])), 200);
const EVM = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";

interface Scenario {
  name: string;
  path: string;
  /** Brings the page to the state to be photographed. */
  run?(page: Page): Promise<void>;
  /** Photograph the screen as it is, not the whole page (for anything laid over the page). */
  screenOnly?: boolean;
  /** A page without the swap card: the checks that are about the card do not apply. */
  noCard?: boolean;
  /** Runs before the page is opened, to put the site in a state this script cannot otherwise reach. */
  before?(page: Page): Promise<void>;
  /** Failed requests that are the point of the scenario, not a fault. */
  expectedFailures?: RegExp;
  /** Runs after the photograph: what must still be checked but would undo the state the photograph is of. */
  after?(page: Page): Promise<void>;
  /** The widths at which this state exists at all. Every width when left out. */
  widths?: readonly number[];
}

// Waits for a quote. This script asks for many previews from one address, so it can run into the
// per-visitor limit; when the card offers "Try again", it waits a little and presses it.
const quoted = async (page: Page) => {
  const numbers = page.locator(".quote-rate").first();
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await numbers.waitFor({ timeout: 12_000 });
      return;
    } catch {
      const retry = page.getByRole("button", { name: "Try again" });
      if (await retry.isVisible().catch(() => false)) {
        await page.waitForTimeout(8000);
        await retry.click().catch(() => undefined);
      }
    }
  }
  await numbers.waitFor({ timeout: 1000 });
};

// The warning depends on a public chain endpoint answering, which now and then it does not: ask again.
async function contractWarning(page: Page) {
  const warning = page.locator('.address-note[data-kind="warning"]');
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByLabel(/Refund address/).fill("");
    await page.getByLabel(/Refund address/).fill(CONTRACT);
    try {
      await warning.waitFor({ timeout: 10_000 });
      return;
    } catch {
      // try once more
    }
  }
  await warning.waitFor({ timeout: 1000 });
}

/** Fills the card and opens the review. A walk that goes on to make the order gives it a receiving address of its own (see freshSol). */
async function openReview(page: Page, recipient: string = SOL) {
  await page.getByRole("button", { name: "Pay without connecting" }).click();
  await page.getByLabel(/Receiving address/).fill(recipient);
  await page.getByLabel(/Refund address/).fill(EVM);
  await quoted(page);
  await page.getByRole("button", { name: "Review swap" }).click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(300);
}

async function openPicker(page: Page) {
  await page.getByRole("button", { name: /^You pay: / }).click();
  await page.getByRole("listbox", { name: "Coins" }).waitFor();
  // Let the sheet finish arriving.
  await page.waitForTimeout(300);
}

const SCENARIOS: Scenario[] = [
  { name: "swap-empty", path: "/" },
  { name: "swap-quoted", path: "/?amount=0.5", run: quoted },
  {
    name: "swap-manual-ready",
    path: "/?amount=0.5",
    async run(page) {
      await page.getByRole("button", { name: "Pay without connecting" }).click();
      await page.getByLabel(/Receiving address/).fill(SOL);
      await page.getByLabel(/Refund address/).fill(EVM);
      await quoted(page);
      await page.getByRole("button", { name: "Review swap" }).waitFor({ timeout: 20_000 });
    },
  },
  {
    name: "swap-wrong-address",
    path: "/?amount=0.5",
    async run(page) {
      await page.getByLabel(/Receiving address/).fill(EVM);
      await page.getByRole("alert").waitFor();
    },
  },
  {
    name: "swap-minimum",
    path: "/?from=bsc:BNB&to=sol:USDT&amount=0.05",
    async run(page) {
      await page.getByRole("button", { name: /Minimum is \$1,000/ }).waitFor({ timeout: 20_000 });
    },
  },
  {
    name: "swap-long-amount",
    path: "/?amount=0.123456789012345",
    run: quoted,
  },
  {
    name: "swap-contract-warning",
    path: "/?amount=0.5",
    async run(page) {
      await page.getByRole("button", { name: "Pay without connecting" }).click();
      await contractWarning(page);
    },
  },
  {
    name: "swap-memo-chain",
    path: "/?to=stellar:XLM&amount=0.5",
    async run(page) {
      await page.getByLabel(/Receiving address/).fill(STELLAR);
      await page.locator('.address-note[data-kind="warning"]').waitFor();
    },
  },
  {
    name: "swap-long-address",
    path: "/?to=cardano:ADA&amount=0.5",
    async run(page) {
      if (CARDANO.length !== 103) throw new Error(`the test address is ${CARDANO.length} characters, not 103`);
      await page.getByLabel(/Receiving address/).fill(CARDANO);
      await page.waitForTimeout(300);
      // Wrapped, never scrolled: everything typed is on show.
      const clipped = await page.getByLabel(/Receiving address/).evaluate((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
      if (clipped) throw new Error("the long address does not fit in its field");
      const wrong = await page.locator('.address-note[data-kind="error"]').count();
      if (wrong > 0) throw new Error("a valid Cardano address was called wrong");
    },
  },
  {
    name: "page-terms",
    path: "/terms",
    noCard: true,
    async run(page) {
      await page.getByRole("heading", { name: "Terms of Use" }).waitFor();
      await page.locator(".docs-version").waitFor();
      if (/draft|pending/i.test(await page.locator("main#main").innerText())) throw new Error("the Terms still read as a draft");
    },
  },
  {
    name: "page-privacy",
    path: "/privacy",
    noCard: true,
    async run(page) {
      await page.getByRole("heading", { name: "Privacy Policy" }).waitFor();
      await page.locator(".docs-version").waitFor();
      if (/draft|pending/i.test(await page.locator("main#main").innerText())) throw new Error("the Privacy Policy still reads as a draft");
    },
  },
  {
    // Swaps are paused: the notice stands where the card would; the rest of the home page is still there.
    name: "home-paused",
    path: "/",
    noCard: true,
    async before(page) {
      await page.route("**/api/config", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, paused: true } });
      });
      await page.route("**/api/status", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, status: "paused" } });
      });
    },
    async run(page) {
      await page.getByRole("heading", { name: "Swaps are paused." }).waitFor();
      for (const heading of ["What IntentSwap does", "Three steps", "What we do, and what we don't", "Questions"]) await page.getByRole("heading", { name: heading }).waitFor({ timeout: 5000 });
      if ((await page.locator(".card").count()) !== 0) throw new Error("the swap card is shown although swaps are paused");
      // The stage says what the site does. Nothing on it is tagged live, planned or paused.
      if ((await page.locator(".stage-tag").count()) !== 0) throw new Error("the stage still carries tags");
      const first = (await page.locator(".stage-tab-title").first().innerText()).trim();
      if (first !== "Cross-chain swaps") throw new Error(`the stage's first item reads "${first}"`);
    },
  },
  {
    // The list of coins cannot be fetched, and none is kept from an earlier visit.
    name: "page-no-coins",
    path: "/",
    noCard: true,
    expectedFailures: /status of 503/,
    async before(page) {
      await page.route("**/api/tokens", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "try_later", message: "Try again shortly." } }) }));
    },
    async run(page) {
      await page.getByRole("heading", { name: "Couldn't load coins." }).waitFor({ timeout: 20_000 });
      // No count is shown that was not counted: the third fact is left out.
      if ((await page.locator(".fact").count()) !== 2) throw new Error(`with no coin list there are ${await page.locator(".fact").count()} facts; the one that counts coins should be left out`);
    },
    async after(page) {
      // The list comes back: "Try again" brings the card.
      await page.unroute("**/api/tokens");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.locator(".card").waitFor({ timeout: 20_000 });
      await page.locator(".fact").nth(2).waitFor({ timeout: 20_000 });
    },
  },
  {
    // The site's own server cannot be reached at all.
    name: "page-offline",
    path: "/",
    noCard: true,
    expectedFailures: /Failed to load resource|net::ERR/,
    async before(page) {
      await page.route("**/api/**", (route) => route.abort());
    },
    async run(page) {
      await page.getByRole("heading", { name: "Can't reach the service." }).waitFor({ timeout: 20_000 });
    },
    async after(page) {
      // The connection comes back: "Try again" brings the card.
      await page.unroute("**/api/**");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.locator(".card").waitFor({ timeout: 20_000 });
    },
  },
  {
    // While the site's server cannot be reached, the Terms can still be read: they need nothing from it.
    name: "page-offline-terms",
    path: "/terms",
    noCard: true,
    widths: [360],
    expectedFailures: /Failed to load resource|net::ERR/,
    async before(page) {
      await page.route("**/api/**", (route) => route.abort());
    },
    async run(page) {
      await page.getByRole("heading", { name: "Terms of Use" }).waitFor({ timeout: 20_000 });
    },
  },
  {
    // A page whose code cannot be fetched (the connection dropped as its link was pressed): the site
    // does not go blank. It says so, keeps its header, and offers to reload.
    name: "page-code-missing",
    path: "/docs",
    noCard: true,
    widths: [360, 1280],
    expectedFailures: /Failed to load resource|net::ERR|dynamically imported module|error loading/i,
    async before(page) {
      await page.route(/\/assets\/DocsPage-[^/]+\.js$/, (route) => route.abort());
    },
    async run(page) {
      await page.getByRole("heading", { name: "This page could not be loaded." }).waitFor({ timeout: 20_000 });
      if (!(await page.getByRole("button", { name: "Reload" }).isVisible())) throw new Error("a page that could not be loaded offers no way to reload");
      if ((await page.locator("header .wordmark").count()) !== 1) throw new Error("a page that could not be loaded has lost its header");
    },
    async after(page) {
      // Another page still opens: the failure is the one page's, not the site's.
      await page.locator("header .wordmark").click();
      await page.locator(".card").waitFor({ timeout: 20_000 });
    },
  },
  {
    // The swap provider does not answer: the card says so in the room kept for it, and offers to try again.
    name: "swap-provider-down",
    path: "/?amount=0.5",
    expectedFailures: /status of 503/,
    async before(page) {
      await page.route("**/api/quote", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "try_later", message: "The swap service is not responding. Try again shortly." } }) }));
    },
    async run(page) {
      await page.getByRole("button", { name: "Try again" }).waitFor({ timeout: 20_000 });
      await page.getByText("The swap service is not responding. Try again shortly.").waitFor();
    },
  },
  {
    // The home page, top to bottom: headline, card, the strip of chains, facts, what the site does, how it works, what we do and don't, questions.
    name: "home",
    path: "/",
    async run(page) {
      await page.getByRole("heading", { name: "What IntentSwap does" }).waitFor();
      // The third fact is counted from the live coin list.
      await page.locator(".fact").nth(2).waitFor({ timeout: 20_000 });
    },
  },
  {
    // The Docs on a paused site, which is how the site is first deployed: no quote is asked for, the
    // page says why, and no fee figure is given, because the only true one comes from a quote.
    name: "page-docs-paused",
    path: "/docs/fees",
    noCard: true,
    async before(page) {
      await page.route("**/api/config", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, paused: true } });
      });
      await page.route("**/api/status", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, status: "paused" } });
      });
      // A quote asked for while paused would be refused: the page must not ask.
      await page.route("**/api/quote", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "The Docs page asked for a quote while swaps are paused." } }) }));
    },
    async run(page) {
      const note = page.locator(".docs-example-none");
      await note.waitFor({ timeout: 20_000 });
      const text = (await note.innerText()).replace(/\s+/g, " ").trim();
      if (text !== "Swaps are paused, so no example can be quoted right now. When they are on, a real quote is shown here with every fee in it. Every quote on the swap page shows the swap fee and the network fee before you confirm.") throw new Error(`on a paused site the Docs page's fees read "${text}"`);
      // And nowhere in the fees section is there a percentage that no quote stands behind.
      const fees = await page.locator(".docs-body").innerText();
      if (/\d\s?%/.test(fees)) throw new Error(`on a paused site the Docs page's fees give a figure: "${fees.replace(/\s+/g, " ").slice(0, 200)}"`);
    },
  },
  {
    // The same page once the token exists: the server names its address (made up here) and its pair.
    name: "home-token",
    path: "/",
    async before(page) {
      await page.route("**/api/config", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, tokenAddress: EVM, tokenPairAddress: "0xae001C67DbdC649e76BD8f41A75D1D154423D8aD" } });
      });
    },
    async run(page) {
      // The section's own heading. (The stage above it has an item of the same name.)
      await page.getByRole("heading", { name: "The $INT token", level: 2 }).waitFor();
      const items = await page.locator(".stage-tab-title").allInnerTexts();
      if (items.length !== 4 || items[3]?.trim() !== "The $INT token") throw new Error(`with the token set the stage's items are ${JSON.stringify(items)}`);
    },
  },
  {
    // The token's own page. This server has no token, so it answers the page's address with a 404:
    // the walk hands the browser the site's page there, and the token's (made-up) address in the settings.
    name: "page-token",
    path: "/token",
    noCard: true,
    async before(page) {
      await page.route(/\/token$/, async (route) => {
        const home = await route.fetch({ url: new URL("/", route.request().url()).toString() });
        await route.fulfill({ response: home });
      });
      await page.route("**/api/config", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, tokenAddress: EVM, tokenPairAddress: "0xae001C67DbdC649e76BD8f41A75D1D154423D8aD" } });
      });
    },
    async run(page) {
      await page.getByRole("heading", { name: "The $INT token" }).waitFor();
      // Facts only: no card, no price, nothing to buy.
      const text = await page.locator("main#main").innerText();
      for (const word of [/\bbuy\b/i, /\bprice\b/i, /\$\d/, /roadmap/i, /reward/i]) if (word.test(text)) throw new Error(`the token page says something it must not (${String(word)})`);
      if ((await page.locator(".card").count()) > 0) throw new Error("the token page shows the swap card");
    },
  },
  {
    // The same address while there is no token: no page at all.
    name: "page-token-unset",
    path: "/token",
    noCard: true,
    expectedFailures: /status of 404/,
    async run(page) {
      await page.getByRole("heading", { name: "Page not found." }).waitFor();
    },
  },
  {
    name: "menu-open",
    path: "/",
    screenOnly: true,
    // On a wide screen the four links are in the header and there is no menu to open.
    widths: [360, 768],
    async run(page) {
      const menu = page.getByRole("button", { name: "Menu" });
      await menu.click();
      await page.getByRole("dialog").getByRole("link", { name: /Track order/ }).waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    name: "page-track",
    path: "/track",
    noCard: true,
    async run(page) {
      await page.getByRole("heading", { name: "Track an order" }).waitFor();
    },
  },
  {
    // Something that is no order: the one sentence every miss gets.
    name: "page-track-miss",
    path: "/track",
    noCard: true,
    expectedFailures: /status of 404/,
    async run(page) {
      await page.getByLabel("Order ID or deposit address").fill(EVM);
      await page.getByRole("button", { name: "Find order" }).click();
      await page.getByText("No order matches that.").waitFor({ timeout: 20_000 });
    },
  },
  {
    name: "page-docs",
    path: "/docs",
    noCard: true,
    async run(page) {
      await page.getByRole("heading", { name: "How it works", level: 1 }).waitFor();
      // The contents: beside the text on a wide screen, folded into one line above it on a narrow one.
      await page.locator(".docs-contents, .docs-fold").first().waitFor({ state: "attached" });
      if (!(await page.locator(".docs-contents").isVisible()) && !(await page.locator(".docs-fold").isVisible())) throw new Error("the Docs show no contents, folded or open");
    },
  },
  {
    name: "page-docs-fees",
    path: "/docs/fees",
    noCard: true,
    async run(page) {
      await page.getByRole("heading", { name: "Fees", level: 1 }).waitFor();
      // The example is a real quote, taken as the page opens; the page also has words for when there is none.
      await page.locator(".docs-example, .docs-example-none:not([aria-busy])").first().waitFor({ timeout: 30_000 });
    },
  },
  {
    name: "page-docs-chains",
    path: "/docs/chains",
    noCard: true,
    async run(page) {
      await page.getByRole("heading", { name: "Supported chains", level: 1 }).waitFor();
      await page.locator(".docs-chains tr").first().waitFor({ timeout: 20_000 });
    },
  },
  ...(
    [
      ["refunds", "Refunds and deadlines"],
      ["safety", "Staying safe"],
      ["rewards", "Points and weekly rewards"],
      ["faq", "Questions"],
    ] as const
  ).map(
    ([slug, title]): Scenario => ({
      name: `page-docs-${slug}`,
      path: `/docs/${slug}`,
      noCard: true,
      async run(page) {
        await page.getByRole("heading", { name: title, level: 1 }).waitFor();
      },
    }),
  ),
  {
    // The Rewards page as anyone sees it: the week and its countdown, the way in, the rules. No address's points.
    name: "page-rewards",
    path: "/rewards",
    noCard: true,
    async run(page) {
      await page.getByRole("heading", { name: "Points and weekly rewards", level: 1 }).waitFor();
      await page.locator(".rewards-count").waitFor({ timeout: 20_000 });
      await page.getByText("Connect the wallet whose points you want to see.").waitFor();
      if ((await page.locator(".rewards-points").count()) !== 0) throw new Error("the Rewards page shows points to someone who has not signed in");
    },
  },
  {
    name: "page-not-found",
    path: "/no-such-page",
    noCard: true,
    expectedFailures: /status of 404/,
    async run(page) {
      await page.getByRole("heading", { name: "Page not found." }).waitFor();
    },
  },
  {
    // What a visitor from a blocked place sees: the server refuses every data route.
    name: "page-region",
    path: "/",
    noCard: true,
    expectedFailures: /status of 403/,
    async before(page) {
      await page.route("**/api/**", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "region", message: "Not available in your region." } }) }));
    },
    async run(page) {
      await page.getByRole("heading", { name: "Not available in your region." }).waitFor();
    },
  },
  {
    // The kill switch: the server says swaps are paused.
    name: "page-paused",
    path: "/",
    noCard: true,
    async before(page) {
      await page.route("**/api/config", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, paused: true } });
      });
      await page.route("**/api/status", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, status: "paused" } });
      });
    },
    async run(page) {
      await page.getByRole("heading", { name: "Swaps are paused." }).waitFor();
    },
  },
  {
    // Every state of every component, on the page made for it.
    name: "states",
    path: "/states",
    noCard: true,
    async run(page) {
      await page.getByRole("heading", { name: "Component states" }).waitFor();
      await page.locator('.address-note[data-kind="warning"]').first().waitFor();
      await page.waitForTimeout(600);
      // The three test amounts, and the one being typed: none may be cut off or need scrolling.
      const clipped = await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>(".states-case .amount-input")].filter((input) => input.scrollWidth > input.clientWidth + 1).map((input) => input.value));
      if (clipped.length > 0) throw new Error(`these amounts do not fit in the amount field: ${clipped.join(", ")}`);
      const outputs = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".states-case .amount-output")].filter((output) => output.scrollWidth > output.clientWidth + 1).map((output) => output.textContent ?? ""));
      if (outputs.length > 0) throw new Error(`these amounts received do not fit: ${outputs.join(", ")}`);
      // Recent orders: a row gives the amount paid exactly or not at all. The sample with all eighteen
      // decimals names its coins alone; the others give their exact amounts.
      const rows = (await page.locator(".recent-row .picker-row-symbol").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
      for (const want of ["ETH to USDT", "250 USDC to ETH", "0.5 ETH to USDT", "0.0125 BTC to USDC"]) if (!rows.includes(want)) throw new Error(`the recent orders on the states page read ${JSON.stringify(rows)}; "${want}" is missing`);
      if (rows.some((row) => /0\.1234/.test(row))) throw new Error(`a recent order's row gives a shortened amount to pay: ${JSON.stringify(rows)}`);
    },
  },
  { name: "review-open", path: "/?amount=0.5", screenOnly: true, run: openReview },
  {
    name: "review-accepted",
    path: "/?amount=0.5",
    screenOnly: true,
    async run(page) {
      await openReview(page);
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Confirm swap" }).waitFor();
      // The lower half of the sheet: both addresses, the tick-box and the button.
      await page.locator(".sheet-body").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    },
  },
  { name: "picker-open", path: "/", screenOnly: true, run: openPicker },
  {
    name: "picker-search",
    path: "/",
    screenOnly: true,
    async run(page) {
      await openPicker(page);
      await page.getByRole("combobox").fill("usd");
    },
  },
  {
    name: "picker-chain",
    path: "/",
    screenOnly: true,
    async run(page) {
      await openPicker(page);
      await page.getByRole("button", { name: "Solana", exact: true }).click();
    },
  },
  {
    name: "picker-no-match",
    path: "/",
    screenOnly: true,
    async run(page) {
      await openPicker(page);
      await page.getByRole("combobox").fill("zzzz");
      await page.getByText("No coins match.").waitFor();
    },
  },
  {
    name: "picker-unsupported",
    path: "/",
    screenOnly: true,
    async run(page) {
      await openPicker(page);
      // A well-formed contract address that is not on the list.
      await page.getByRole("combobox").fill("0x1234567890123456789012345678901234567890");
      await page.getByText("Not supported.").waitFor();
    },
  },
];

const args = process.argv.slice(2);
const practiceUrl = args.find((arg) => arg.startsWith("--practice="))?.slice("--practice=".length) ?? null;
// A second practice server, set to route privately (PRIVACY_MODE=basic), for the walk of private routing.
const privateUrl = args.find((arg) => arg.startsWith("--private="))?.slice("--private=".length) ?? null;
const [baseUrl, ...only] = args.filter((arg) => !arg.startsWith("--"));
if (!baseUrl) {
  console.error("usage: review-shots.ts <base-url> [scenario-name ...]");
  process.exit(2);
}
const chosen = only.length === 0 ? SCENARIOS : SCENARIOS.filter((scenario) => only.includes(scenario.name));
// Besides the screenshots, the script walks through behaviour. Each walk has a name and can be run alone:
// layout, states-in-use, review, paste, quoting, sheet-touch, focus, picker-keyboard, slippage, reduced-motion, chips, site, order, wallet, focus-marks, private, rewards.
const walks = (name: string) => only.length === 0 || only.includes(name);

// The site limits how often one visitor may load it. This script is one visitor, so it keeps a steady pace.
let lastVisit = 0;
async function visit(page: Page, url: string): Promise<void> {
  const wait = lastVisit + 2300 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastVisit = Date.now();
  await page.goto(url, { waitUntil: "networkidle" });
}

const out = path.resolve("docs", "review");
const failures = path.resolve("data");
// A run of everything makes every screenshot afresh, so what an earlier run left behind is cleared first:
// the folder then holds this run's screens and nothing else.
if (only.length === 0) fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(failures, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const complaints: string[] = [];
const leftUnpaid: string[] = [];
// Things that could not be checked on this machine. Printed at the end; they do not fail the run.
const notes: string[] = [];
let shots = 0;
let busy = 0;

for (const scenario of chosen) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      if (scenario.widths !== undefined && !scenario.widths.includes(width)) continue;
      const mobile = width < 768;
      const context = await browser.newContext({ viewport: { width, height: mobile ? 780 : 900 }, deviceScaleFactor: 2, colorScheme: theme, hasTouch: mobile, isMobile: mobile });
      await context.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "${theme}"; });`);
      const page = await context.newPage();
      const label = `${scenario.name} ${width} ${theme}`;
      page.on("console", (message) => {
        if (message.type() !== "error" && message.type() !== "warning") return;
        // This script asks for previews far faster than a person would, so the server may tell it to
        // slow down or try again. The card shows "Try again" and the script does; that is not a fault.
        if (/\/api\/quote$/.test(message.location().url) && /status of (429|503)/.test(message.text())) {
          busy += 1;
          return;
        }
        if (scenario.expectedFailures?.test(message.text())) return;
        complaints.push(`${label}: ${message.type()}: ${message.text()}`);
      });
      page.on("pageerror", (error) => complaints.push(`${label}: page error: ${error.message}`));
      page.on("request", (request) => {
        const host = new URL(request.url()).host;
        if (host !== new URL(baseUrl).host) complaints.push(`${label}: request to another site: ${host}`);
      });
      try {
        await scenario.before?.(page);
        await visit(page, new URL(scenario.path, baseUrl).toString());
        await scenario.run?.(page);
        // Everything that comes into view on scroll is brought into view once, so that the whole page is checked and photographed.
        if (!scenario.screenOnly) await seeAll(page);
        await page.waitForTimeout(350);
        // Every accessibility rule, on the page exactly as it is about to be photographed.
        for (const problem of await axeProblems(page, scenario.path === "/states" ? SAMPLES_PAGE_SKIPS : [])) complaints.push(`${label}: ${problem}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 0) complaints.push(`${label}: page scrolls sideways by ${overflow}px`);
        // The main button must be in view without scrolling, whatever the card's height.
        await page.evaluate(() => window.scrollTo(0, 0));
        const hidden = await page.evaluate(() => {
          const button = document.querySelector(".card-submit .button-primary");
          if (!button) return "there is no main button";
          const box = button.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= window.innerHeight ? null : `the main button is out of view (${Math.round(box.top)} to ${Math.round(box.bottom)} of ${window.innerHeight})`;
        });
        if (hidden !== null && !scenario.noCard) complaints.push(`${label}: ${hidden}`);
        // A main button is one line: 48 px high. A label too long for a phone would make it taller and move what is under it.
        if (width === 360) {
          const tall = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>(".button-primary")]
              .filter((button) => button.offsetParent !== null && button.getBoundingClientRect().height > 49)
              .map((button) => `"${(button.textContent ?? "").trim()}" (${Math.round(button.getBoundingClientRect().height)} px)`),
          );
          for (const button of tall) complaints.push(`${label}: a main button's label takes more than one line: ${button}`);
        }
        // Only on the card itself: the states page shows components in narrow tiles, where the room differs.
        if (width >= 360 && !scenario.noCard) {
          const tooLong = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>(".address-note, .card-message")]
              .filter((note) => note.getBoundingClientRect().height > parseFloat(getComputedStyle(note).minHeight) + 1)
              .map((note) => note.textContent ?? ""),
          );
          for (const text of tooLong) complaints.push(`${label}: this message is longer than the room kept for it: "${text}"`);
        }
        if (scenario.screenOnly) {
          await page.screenshot({ path: path.join(out, `${scenario.name}-${width}-${theme}.png`), fullPage: false });
          shots += 1;
          await scenario.after?.(page);
          await context.close();
          continue;
        }
        // What a person sees on arrival, before scrolling, with the button held in view.
        if (scenario.name === "swap-manual-ready") {
          await page.screenshot({ path: path.join(out, `${scenario.name}-${width}-${theme}-first-screen.png`), fullPage: false });
          shots += 1;
        }
        // The whole page, laid out as it is: the screen is made as tall as the page first,
        // so the pinned button is photographed in its own place and not over the content.
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        // A picture can only be so tall before the browser starts repeating itself: a longer page is taken in parts.
        const LIMIT = 7000;
        if (height <= LIMIT) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(150);
          await page.screenshot({ path: path.join(out, `${scenario.name}-${width}-${theme}.png`), fullPage: true });
          shots += 1;
        } else {
          await page.setViewportSize({ width, height: LIMIT });
          await page.waitForTimeout(150);
          const parts = Math.ceil(height / LIMIT);
          for (let part = 0; part < parts; part++) {
            const top = part * LIMIT;
            await page.evaluate((y) => window.scrollTo(0, y), top);
            await page.waitForTimeout(250);
            const scrolled = await page.evaluate(() => window.scrollY);
            // The last part starts where the page lets it; what overlaps the part before is cut off.
            const skip = top - scrolled;
            await page.screenshot({ path: path.join(out, `${scenario.name}-${width}-${theme}-part${part + 1}.png`), clip: { x: 0, y: skip, width, height: Math.min(LIMIT, height - top) } });
            shots += 1;
          }
        }
        // The photograph is taken; now whatever would have undone the state it shows.
        if (scenario.after !== undefined) {
          await page.setViewportSize({ width, height: mobile ? 780 : 900 });
          await scenario.after(page);
        }
      } catch (error) {
        complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
        // Kept out of docs/review: a capture of a failed step is for whoever is fixing it, not part of the record.
        await page.screenshot({ path: path.join(failures, `stuck-${scenario.name}-${width}-${theme}.png`), fullPage: true }).catch(() => undefined);
      }
      await context.close();
    }
  }
}

// Nothing may move when a quote arrives or an address turns out to be wrong. The end of the card
// is measured after each step, at each width (and at 320 px, where nothing may scroll sideways either).
// The quote's place opens when an amount is typed in (the person's own doing) and is kept from then
// on: the first quote is held back here until the card has been measured with its place open and
// empty, so that what is compared is the card before the numbers and the card after them.
if (walks("layout")) {
  for (const width of [320, ...WIDTHS]) {
    const mobile = width < 768;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 780 : 900 }, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile });
    const page = await context.newPage();
    const label = `layout ${width}`;
    const cardEnd = () => page.evaluate(() => Math.round((document.querySelector(".card-submit-end")?.getBoundingClientRect().top ?? 0) + window.scrollY));
    try {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/api/quote", async (route) => {
        await held;
        await route.continue();
      });
      await visit(page, new URL("/", baseUrl).toString());
      // With no amount there is nothing where the quote will be: no rows, no dashes, no room kept.
      const idle = await page.evaluate(() => ({ height: Math.round(document.querySelector(".quote")?.getBoundingClientRect().height ?? -1), text: (document.querySelector(".quote")?.textContent ?? "").trim() }));
      if (idle.height !== 0 || idle.text !== "") complaints.push(`${label}: with no amount the quote takes ${idle.height}px and reads "${idle.text}"`);
      await page.locator("#amount-in").fill("0.5");
      await page.locator(".quote[data-open] .skeleton-rate").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(450);
      const empty = await cardEnd();
      release();
      await quoted(page);
      await page.unroute("**/api/quote");
      await page.waitForTimeout(350);
      const withQuote = await cardEnd();
      if (withQuote !== empty) complaints.push(`${label}: the card grew by ${withQuote - empty}px when the quote arrived`);
      // The quote is one line. Its breakdown opens on a press and closes on another, and takes the card back to where it was.
      const line = page.locator("button.quote-summary");
      if ((await line.getAttribute("aria-expanded")) !== "false") complaints.push(`${label}: the quote's breakdown is open before anyone asked`);
      await line.click();
      await page.getByText("Minimum received").waitFor({ timeout: 5000 });
      await page.waitForTimeout(350);
      const rows = await page.locator(".quote-row dt").allInnerTexts();
      if (JSON.stringify(rows) !== JSON.stringify(["Minimum received", "IntentSwap fee", "Provider fee", "Solana network fee", "Estimated time", "Points"])) complaints.push(`${label}: the breakdown's rows are ${JSON.stringify(rows)}`);
      // The line itself: one row from 768 px (44 px high), two below it (64 px). The rate is whole, and the time is on show.
      const lineBox = await line.evaluate((el) => {
        const rate = el.querySelector<HTMLElement>(".quote-rate");
        return { height: Math.round(el.getBoundingClientRect().height), cut: rate !== null && rate.scrollWidth > rate.clientWidth + 1 };
      });
      if (lineBox.height !== (width >= 768 ? 44 : 64) || lineBox.cut) complaints.push(`${label}: the quote's line is ${lineBox.height}px high${lineBox.cut ? " and its rate is cut short" : ""}`);
      if ((await cardEnd()) <= withQuote) complaints.push(`${label}: opening the breakdown did not show it`);
      await line.click();
      await page.waitForTimeout(350);
      if ((await cardEnd()) !== withQuote) complaints.push(`${label}: closing the breakdown left the card ${(await cardEnd()) - withQuote}px taller`);
      // Closed, the breakdown takes no room and cannot be reached by the keyboard or a screen reader.
      const closed = await page.locator(".quote-more").evaluate((el) => ({ height: Math.round(el.getBoundingClientRect().height), inert: (el as HTMLElement).inert }));
      if (closed.height !== 0 || !closed.inert) complaints.push(`${label}: closed, the breakdown is ${closed.height}px high${closed.inert ? "" : " and can still be reached"}`);
      // The longest test amount is whole in its field at 360 px and up: never cut, never scrolled.
      if (width >= 360) {
        await page.locator("#amount-in").fill("123456789.123456");
        await page.waitForTimeout(200);
        const amount = await page.locator("#amount-in").evaluate((el: HTMLInputElement) => ({ value: el.value, cut: el.scrollWidth > el.clientWidth + 1 }));
        if (amount.value !== "123456789.123456" || amount.cut) complaints.push(`${label}: the amount 123456789.123456 is ${amount.cut ? "cut off" : `kept as "${amount.value}"`}`);
        await page.locator("#amount-in").fill("0.5");
        await quoted(page);
        await page.waitForTimeout(350);
      }
      await page.getByLabel(/Receiving address/).fill(EVM);
      await page.getByRole("alert").waitFor();
      const wrong = await cardEnd();
      if (wrong !== withQuote) complaints.push(`${label}: the card grew by ${wrong - withQuote}px when the address was wrong`);
      await page.getByLabel(/Receiving address/).fill(SOL);
      await page.waitForTimeout(350);
      const right = await cardEnd();
      if (right !== withQuote) complaints.push(`${label}: the card changed by ${right - withQuote}px when a Solana address was entered`);
      // A contract where a wallet is expected: the warning arrives a moment later and must not move anything either.
      await page.getByRole("button", { name: "Pay without connecting" }).click();
      await page.waitForTimeout(200);
      const manual = await cardEnd();
      await contractWarning(page);
      const warned = await cardEnd();
      if (warned !== manual) complaints.push(`${label}: the card grew by ${warned - manual}px when the contract warning appeared`);
      // No note may need more room than is kept for it.
      const tooLong = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".address-note, .card-message")]
          .filter((note) => note.getBoundingClientRect().height > parseFloat(getComputedStyle(note).minHeight) + 1)
          .map((note) => note.textContent ?? ""),
      );
      for (const text of tooLong) complaints.push(`${label}: this message is longer than the room kept for it: "${text}"`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) complaints.push(`${label}: page scrolls sideways by ${overflow}px`);
      if (width === 320) {
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(out, "swap-address-320.png"), fullPage: true });
        shots += 1;
      }
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    }
    await context.close();
  }
}

// Hover, keyboard focus and pressed, for each kind of control: looks that only exist while something is happening.
if (walks("states-in-use")) {
  for (const theme of THEMES) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    await context.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "${theme}"; });`);
    const page = await context.newPage();
    const label = `states in use, ${theme}`;
    try {
      await visit(page, new URL("/states", baseUrl).toString());
      await page.getByRole("heading", { name: "Component states" }).waitFor();
      // The two colours the checks below compare with, as the browser itself works them out from the tokens.
      const [quietColour, accentColour] = await page.evaluate(() => {
        const probe = document.createElement("span");
        document.body.append(probe);
        probe.style.color = "var(--focus-ring)";
        const quiet = getComputedStyle(probe).color;
        probe.style.color = "var(--accent)";
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return [quiet, accent];
      });
      const controls: Array<[string, string]> = [
        ["primary", ".states-case .button-primary:not(:disabled)"],
        ["secondary", ".states-case .button-secondary:not(:disabled)"],
        ["chip", '.states-case .button-chip[aria-pressed="false"]'],
        ["text-button", ".states-case .button-text"],
        ["icon-button", ".states-case .button-icon"],
        ["flip", ".states-case .flip:not(:disabled)"],
        ["tool", ".states-case .tool:not(:disabled)"],
        ["quote-line", ".states-case button.quote-summary"],
        ["coin-button", ".states-case button.coin-button"],
        ["address", ".states-case .address-input"],
        ["amount", ".states-case .amount-input"],
        ["tick-box", ".states-case .check input:not([readonly])"],
      ];
      for (const [name, selector] of controls) {
        const control = page.locator(selector).first();
        const frame = control.locator("xpath=ancestor::div[contains(@class,'states-case')][1]");
        await control.scrollIntoViewIfNeeded();
        await control.hover();
        await page.waitForTimeout(200);
        await frame.screenshot({ path: path.join(out, `states-hover-${name}-${theme}.png`) });
        await page.mouse.move(0, 0);
        // Reached by the keyboard, a control wears one quiet line: 1 px, a neutral tone, 2 px off it (the amount's and
        // the picker's search wear it round their whole field; the quote's line just inside its edge). Never the accent.
        await control.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await page.waitForTimeout(200);
        const markOf = () =>
          control.evaluate((el) => {
            for (const node of [el, el.closest(".field"), el.closest(".picker-search")]) {
              if (node === null) continue;
              const style = getComputedStyle(node);
              if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && !/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(style.outlineColor)) return `${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}`;
            }
            return "none";
          });
        // Anything in the accent colour that the focus put there: an outline, a ring drawn as a shadow, or a border.
        const greenOn = () =>
          control.evaluate((el, accent) => {
            const found: string[] = [];
            for (const node of [el, el.closest(".field"), el.closest(".picker-search")]) {
              if (node === null) continue;
              const style = getComputedStyle(node);
              if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && style.outlineColor === accent) found.push("outline");
              if (style.boxShadow.includes(accent)) found.push("shadow");
              if ([style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor].includes(accent) && parseFloat(style.borderTopWidth) > 0) found.push("border");
            }
            return found.join(", ");
          }, accentColour);
        const mark = await markOf();
        const wanted = name === "quote-line" ? `1px ${quietColour} -2px` : `1px ${quietColour} 2px`;
        if (mark === "none") complaints.push(`${label}: ${name} shows nothing when reached by keyboard`);
        else if (mark !== wanted) complaints.push(`${label}: reached by keyboard, ${name} wears "${mark}", not "${wanted}"`);
        if ((await greenOn()) !== "") complaints.push(`${label}: reached by keyboard, ${name} has an accent-coloured ${await greenOn()}`);
        await frame.screenshot({ path: path.join(out, `states-focus-${name}-${theme}.png`) });
        // After a click there is nothing at all: no line, no ring, nothing green. (Some of these do something when pressed; here they are only samples.)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await control.click();
        await page.waitForTimeout(150);
        const byClick = await markOf();
        if (byClick !== "none") complaints.push(`${label}: ${name} wears "${byClick}" after a click`);
        if ((await greenOn()) !== "") complaints.push(`${label}: after a click, ${name} has an accent-coloured ${await greenOn()}`);
        if (name === "quote-line") await control.click();
        // And none after Escape, which gives the keyboard's mark up until Tab or an arrow key is pressed again.
        await control.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
        if ((await markOf()) !== "none") complaints.push(`${label}: ${name} still wears the keyboard's mark after Escape`);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        // Held down: the pressed look. The pointer is moved away before letting go, so nothing is actually pressed.
        const box = await control.boundingBox();
        if (box !== null) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.waitForTimeout(200);
          await frame.screenshot({ path: path.join(out, `states-pressed-${name}-${theme}.png`) });
          await page.mouse.move(0, 0);
          await page.mouse.up();
        }
        shots += 3;
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      }
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    }
    await context.close();
  }
}

// The review sheet: what it says, the Terms gate, an expired quote, and (against the practice server) making an order.
if (walks("review")) {
  const label = "review";
  const expectThat = (ok: boolean, what: string) => {
    if (!ok) complaints.push(`${label}: ${what}`);
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await context.newPage();
  try {
    await visit(page, new URL("/?amount=0.5", baseUrl).toString());
    await openReview(page);
    const dialog = page.getByRole("dialog");
    // One main button on screen: the card's own is out of sight while a sheet is open.
    expectThat(await page.evaluate(() => [...document.querySelectorAll(".card-submit")].every((bar) => getComputedStyle(bar).visibility === "hidden")), "the card's own main button is still visible beneath the open review sheet");
    expectThat((await page.locator(".button-primary").evaluateAll((buttons) => buttons.filter((button) => getComputedStyle(button).visibility !== "hidden" && (button as HTMLElement).offsetParent !== null).length)) === 1, "more than one main button is visible while the review sheet is open");
    const sentence = await dialog.locator(".review-sentence").innerText();
    expectThat(/^You send 0\.5 ETH on Base\. You receive about [\d.,]+ USDT on Solana\.$/.test(sentence), `the plain sentence reads "${sentence}"`);
    const text = await dialog.innerText();
    for (const part of ["You send", "You receive, about", "Minimum received", "Rate", "IntentSwap fee", "Provider fee", "Solana network fee", "Estimated time", "Time to pay", "58 minutes", "Receiving address", "Refund address", "Terms of Use"]) expectThat(text.includes(part), `"${part}" is missing from the review`);
    // Both addresses in full, character for character.
    const shown = (await dialog.locator(".address").allInnerTexts()).map((t) => t.replace(/\s/g, ""));
    expectThat(shown.includes(SOL) && shown.includes(EVM), `the addresses are not shown in full (${shown.join(", ")})`);
    // Nothing can be confirmed before the Terms are accepted, and the button says why.
    const gate = dialog.getByRole("button", { name: "Accept the Terms to continue" });
    expectThat((await gate.count()) === 1 && (await gate.isDisabled()), "the button does not ask for the Terms first");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Confirm swap" }).waitFor();
    // Left open for a minute, the quote is too old to confirm: dimmed, and the button fetches a new one.
    await page.waitForTimeout(62_000);
    await dialog.getByRole("button", { name: "Refresh quote" }).waitFor({ timeout: 5000 });
    expectThat((await dialog.locator(".review-rows[data-stale]").count()) === 1, "the numbers of an expired quote are not dimmed");
    await page.screenshot({ path: path.join(out, "review-expired-1280-light.png"), fullPage: false });
    shots += 1;
    await dialog.getByRole("button", { name: "Refresh quote" }).click();
    await dialog.getByRole("button", { name: "Confirm swap" }).waitFor({ timeout: 30_000 });
    expectThat((await dialog.locator(".review-rows[data-stale]").count()) === 0, "the refreshed numbers are still dimmed");
    // This server makes no orders (it is not the practice server): confirming says so and goes nowhere.
    await dialog.getByRole("button", { name: "Confirm swap" }).click();
    await dialog.locator(".review-problem").filter({ hasText: /\S/ }).waitFor({ timeout: 20_000 });
    expectThat(new URL(page.url()).pathname === "/", "a refused order still left the page");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expectThat(await page.getByRole("button", { name: /Review swap|Refresh quote|Getting a quote/ }).evaluate((el) => el === document.activeElement), "focus did not return to the main button after the review closed");
  } catch (error) {
    complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
  }
  await context.close();

  if (practiceUrl !== null) {
    const practice = await browser.newContext({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
    const page2 = await practice.newPage();
    try {
      await visit(page2, new URL("/?amount=0.5", practiceUrl).toString());
      const recipient2 = freshSol();
      await openReview(page2, recipient2);
      const dialog = page2.getByRole("dialog");
      await dialog.getByRole("checkbox").check();
      await orderPace();
      await dialog.getByRole("button", { name: "Confirm swap" }).click();
      await page2.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
      const id = new URL(page2.url()).pathname.split("/").pop() ?? "";
      leftUnpaid.push(id);
      const kept = await page2.evaluate(() => localStorage.getItem("orders-v1") ?? "");
      expectThat(kept.includes(id), "the new order was not kept in this browser before leaving the page");
      expectThat(!/0x[0-9a-fA-F]{40}/.test(kept), "an address was kept in this browser's order list");
      const order = (await (await fetch(new URL(`/api/orders/${id}`, practiceUrl))).json()) as { recipient?: string; refundTo?: string; amountIn?: string; status?: string };
      expectThat(order.recipient === recipient2 && order.refundTo === EVM && order.amountIn === "500000000000000000" && order.status === "waiting", `the order made is not the one reviewed (${JSON.stringify(order).slice(0, 200)})`);

      // Paying by hand: the address and its QR code stay hidden until the box is ticked, and the
      // code, read back from the pixels on screen, is the order's deposit address and nothing else.
      const deposit = ((await (await fetch(new URL(`/api/orders/${id}`, practiceUrl))).json()) as { depositAddress?: string }).depositAddress ?? "";
      expectThat((await page2.locator(".qr").count()) === 0 && !(await page2.locator("main#main:visible").innerText()).includes(deposit.slice(0, 12)), "the deposit address is on show before the box is ticked");
      await page2.getByLabel("I'm sending on Base").check();
      const code = page2.locator(".qr");
      await code.waitFor({ timeout: 5000 });
      await code.scrollIntoViewIfNeeded();
      const box = await code.boundingBox();
      expectThat(box !== null && Math.abs(box.width - box.height) < 1 && box.width >= 160 && box.width <= 328, `the QR code is ${box?.width} by ${box?.height}`);
      const png = (await code.screenshot()).toString("base64");
      const read = (await page2.evaluate(`(async () => {
        if (!("BarcodeDetector" in window)) return { ok: false, why: "this browser cannot read codes" };
        const image = new Image();
        image.src = "data:image/png;base64,${png}";
        await image.decode();
        try {
          const found = await new BarcodeDetector({ formats: ["qr_code"] }).detect(image);
          return { ok: true, values: found.map((item) => item.rawValue) };
        } catch (error) {
          return { ok: false, why: String(error) };
        }
      })()`)) as { ok: boolean; why?: string; values?: string[] };
      if (read.ok) expectThat(read.values?.length === 1 && read.values[0] === deposit, `the QR code reads as ${JSON.stringify(read.values)}, the deposit address is ${deposit}`);
      else complaints.push(`${label} (practice): the QR code could not be read back, so it is unchecked (${read.why})`);
      for (const theme of ["dark", "light"] as const) {
        await page2.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
        await page2.waitForTimeout(150);
        await page2.screenshot({ path: path.join(out, `order-deposit-open-360-${theme}.png`), fullPage: false });
        shots += 1;
      }
    } catch (error) {
      complaints.push(`${label} (practice): ${(error as Error).message.split("\n")[0]}`);
    }
    await practice.close();

    // The price-moved path: the request is altered on its way out, to claim that ten times as much was
    // reviewed. The server must make no order and send the real numbers back for a fresh yes.
    const moved = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
    await moved.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "dark"; });`);
    const page3 = await moved.newPage();
    try {
      let altered = 0;
      await page3.route("**/api/orders", async (route) => {
        const body = route.request().postDataJSON() as { reviewed: { amountOut: string; minAmountOut: string; totalFeeBps: number } };
        if (altered === 0) {
          altered += 1;
          body.reviewed = { ...body.reviewed, amountOut: `${body.reviewed.amountOut}0`, minAmountOut: `${body.reviewed.minAmountOut}0` };
          // Held back for a moment, so that the walk can try to close the sheet while the order is being made.
          await new Promise((done) => setTimeout(done, 2500));
          await route.continue({ postData: JSON.stringify(body) });
        } else {
          await route.continue();
        }
      });
      await visit(page3, new URL("/?amount=0.5", practiceUrl).toString());
      await openReview(page3, freshSol());
      const dialog = page3.getByRole("dialog");
      await dialog.getByRole("checkbox").check();
      await orderPace();
      await dialog.getByRole("button", { name: "Confirm swap" }).click();
      // While the order is being made, nothing closes the sheet: not Esc, not the close button, not a click outside.
      await dialog.getByRole("button", { name: /Creating order/ }).waitFor({ timeout: 5000 });
      // Esc three times: a browser closes a dialog on the second press whatever the page said to the first.
      for (let press = 0; press < 3; press++) {
        await page3.keyboard.press("Escape");
        await page3.waitForTimeout(80);
      }
      await dialog.getByRole("button", { name: "Close" }).click({ force: true, timeout: 1000 }).catch(() => undefined);
      await page3.mouse.click(8, 8);
      await page3.waitForTimeout(400);
      expectThat(await page3.evaluate(() => document.querySelector("dialog")?.open === true), "the review sheet closed while its order was being made");
      expectThat(await page3.evaluate(() => document.documentElement.dataset.sheet === "open"), "the page behind the review sheet was let go while its order was being made");
      await dialog.getByText("The price moved. No order was made.").waitFor({ timeout: 20_000 });
      expectThat(new URL(page3.url()).pathname === "/", "a moved price still left the page");
      await dialog.getByText("The price moved. No order was made.").scrollIntoViewIfNeeded();
      await page3.waitForTimeout(300);
      await page3.screenshot({ path: path.join(out, "review-price-moved-1280-dark.png"), fullPage: false });
      shots += 1;
      // The new numbers must be confirmed afresh, and not in the first instant.
      const again = dialog.getByRole("button", { name: "Confirm new numbers" });
      await again.waitFor({ timeout: 10_000 });
      await again.click();
      await page3.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
      leftUnpaid.push(new URL(page3.url()).pathname.split("/").pop() ?? "");
    } catch (error) {
      complaints.push(`${label} (price moved): ${(error as Error).message.split("\n")[0]}`);
    }
    await moved.close();

    // The order that comes back is not the one that was reviewed (its receiving address is changed
    // on the way back, as a faulty or dishonest server might). Nothing may be paid from here: the
    // sheet says what differs, leaves the page where it is, and offers only to start again.
    const forged = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, colorScheme: "dark" });
    const page4 = await forged.newPage();
    try {
      await page4.route("**/api/orders", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        if (typeof body.id === "string") leftUnpaid.push(body.id);
        await route.fulfill({ response, json: { ...body, recipient: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" } });
      });
      await visit(page4, new URL("/?amount=0.5", practiceUrl).toString());
      await openReview(page4, freshSol());
      const dialog = page4.getByRole("dialog");
      await dialog.getByRole("checkbox").check();
      await orderPace();
      await dialog.getByRole("button", { name: "Confirm swap" }).click();
      await dialog.getByText(/does not match what you reviewed \(the receiving address\)/).waitFor({ timeout: 20_000 });
      expectThat(new URL(page4.url()).pathname === "/", "an order that does not match what was reviewed was opened all the same");
      expectThat((await dialog.getByRole("button", { name: /Confirm/ }).count()) === 0, "after a mismatch the sheet still offers to confirm");
      const samples = ((await (await fetch(new URL("/api/config", practiceUrl))).json()) as { sampleOrders?: string[] }).sampleOrders ?? [];
      const keptIds = await page4.evaluate(() => (JSON.parse(localStorage.getItem("orders-v1") ?? "[]") as { id: string }[]).map((order) => order.id));
      expectThat(keptIds.every((id) => samples.includes(id)), `an order that did not match what was reviewed was kept in this browser's list (${JSON.stringify(keptIds.filter((id) => !samples.includes(id)))})`);
      await dialog.getByText(/does not match what you reviewed/).scrollIntoViewIfNeeded();
      await page4.screenshot({ path: path.join(out, "review-mismatch-360-dark.png"), fullPage: false });
      shots += 1;
      await dialog.getByRole("button", { name: "Close and start again" }).click();
      await dialog.waitFor({ state: "detached" });
    } catch (error) {
      complaints.push(`${label} (mismatch): ${(error as Error).message.split("\n")[0]}`);
    }
    await forged.close();
  }
}

// The slippage limit: chosen on its own sheet, shown in the quote and the review, and carried by the order.
if (walks("slippage") && practiceUrl !== null) {
  const label = "slippage";
  const expectThat = (ok: boolean, what: string) => {
    if (!ok) complaints.push(`${label}: ${what}`);
  };
  for (const [width, theme] of [[360, "dark"], [1280, "light"]] as const) {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 780 : 900 }, deviceScaleFactor: 2, colorScheme: theme });
    await context.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "${theme}"; });`);
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") complaints.push(`${label}: ${message.type()}: ${message.text().slice(0, 200)}`);
    });
    try {
      await visit(page, new URL("/?amount=0.5", practiceUrl).toString());
      await page.getByRole("button", { name: "Pay without connecting" }).click();
      await page.getByLabel(/Receiving address/).fill(freshSol());
      await page.getByLabel(/Refund address/).fill(EVM);
      // The limit is one of the two tools above the fields.
      const limit = page.locator(".card-tools").getByRole("button", { name: /slippage limit\. Change$/ });
      await limit.waitFor({ timeout: 40_000 });
      expectThat(((await limit.getAttribute("aria-label")) ?? "") === "1.00% slippage limit. Change", `the limit starts as "${await limit.getAttribute("aria-label")}"`);
      expectThat((await page.locator(".card-tools button").count()) === 2, `there are ${await page.locator(".card-tools button").count()} tools above the fields, not two`);
      await quoted(page);
      // The breakdown names the limit beside the minimum received.
      await page.locator("button.quote-summary").click();
      const minimumRow = page.locator(".quote-row", { hasText: "Minimum received" });
      await minimumRow.waitFor({ timeout: 5000 });
      const minimum = () => minimumRow.locator(".amount .sr-only").innerText();
      const atOne = await minimum();
      expectThat(/1\.00%\s*slippage/.test(await minimumRow.innerText()), `the breakdown's minimum reads "${(await minimumRow.innerText()).replace(/\s+/g, " ")}"`);
      await limit.click();
      const sheet = page.getByRole("dialog", { name: "Slippage limit" });
      await sheet.waitFor();
      await page.waitForTimeout(300);
      expectThat((await sheet.getByRole("button", { pressed: true }).innerText()).trim() === "1.00%", "the sheet does not show the limit in use as chosen");
      await page.screenshot({ path: path.join(out, `slippage-open-${width}-${theme}.png`), fullPage: false });
      shots += 1;
      // What cannot be used cannot be chosen, and the button says why.
      const own = sheet.getByLabel("Another limit, in percent");
      for (const bad of ["0.05", "7", "1.234", "5.01"]) {
        await own.fill(bad);
        expectThat(await sheet.getByRole("button", { name: "Choose a limit between 0.10% and 5.00%" }).isDisabled(), `"${bad}" can be used as a limit`);
      }
      // Letters cannot be typed into it at all.
      await own.fill("");
      await own.pressSequentially("ab1c");
      expectThat((await own.inputValue()) === "1", `letters typed into the limit left "${await own.inputValue()}"`);
      // A high limit comes with its warning.
      await own.fill("3");
      await sheet.getByText("A high limit: you may receive noticeably less than the quote shows.").waitFor({ timeout: 3000 });
      // A moment for the chips to finish changing: a photograph taken mid-change shows one of them half-drawn.
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(out, `slippage-high-${width}-${theme}.png`), fullPage: false });
      shots += 1;
      // Half a percent, by its ready choice.
      await sheet.getByRole("button", { name: "0.50%", exact: true }).click();
      await sheet.getByRole("button", { name: "Use 0.50%" }).click();
      await sheet.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "0.50% slippage limit. Change" }).waitFor({ timeout: 30_000 });
      await minimumRow.getByText(/0\.50%\s*slippage/).waitFor({ timeout: 40_000 });
      await page.getByRole("button", { name: "Review swap" }).waitFor({ timeout: 40_000 });
      const atHalf = await minimum();
      expectThat(atHalf !== atOne && Number(atHalf.replace(/[^\d.]/g, "")) > Number(atOne.replace(/[^\d.]/g, "")), `with a tighter limit the minimum received went from ${atOne} to ${atHalf}`);
      // The review shows the same limit, and the order that is made carries it.
      await page.getByRole("button", { name: "Review swap" }).click();
      const review = page.getByRole("dialog", { name: "Review swap" });
      await review.waitFor();
      expectThat(/0\.50%\s*slippage/.test(await review.innerText()), "the review does not show the limit that was chosen");
      await review.getByRole("checkbox").check();
      await orderPace();
      await review.getByRole("button", { name: "Confirm swap" }).click();
      await page.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
      leftUnpaid.push(new URL(page.url()).pathname.split("/").pop() ?? "");
      const made = (await (await fetch(new URL(`/api/orders/${new URL(page.url()).pathname.split("/").pop()}`, practiceUrl))).json()) as { slippageBps?: number; minAmountOut?: string; amountOut?: string };
      expectThat(made.slippageBps === 50, `the order was made with a limit of ${made.slippageBps} basis points`);
      expectThat(BigInt(made.minAmountOut ?? "0") === (BigInt(made.amountOut ?? "0") * 9950n) / 10_000n, "the order's minimum is not its amount less half a percent");
    } catch (error) {
      complaints.push(`${label} ${width}: ${(error as Error).message.split("\n")[0]}`);
      await page.screenshot({ path: path.join(failures, `stuck-slippage-${width}.png`) }).catch(() => undefined);
    }
    await context.close();
  }
}

// Where the system asks for less movement: sheets fade instead of sliding, and nothing pulses.
// 200% zoom and 320 px. A window 1280 by 900 zoomed to 200% lays the page out in 640
// by 450; a small phone is 320 wide. At both sizes every page must still work: nothing cut off,
// nothing scrolling sideways, the accessibility rules kept. At 200% the card's main button must be
// in view and the sheets must fit on the screen. The pages: home (with the coin list and the review),
// Track order, Docs, Rewards, Terms, Privacy, the token page, and, with a practice server, an
// order's page with its deposit details on show.
if (walks("zoom")) {
  const SIZES = [
    { tag: "zoom", label: "200% zoom", width: 640, height: 450 },
    { tag: "narrow", label: "320 px", width: 320, height: 640 },
  ] as const;
  const PAGES = [
    ["home", "/?amount=0.5"],
    ["track", "/track"],
    ["docs", "/docs"],
    ["rewards", "/rewards"],
    ["terms", "/terms"],
    ["privacy", "/privacy"],
    ["token", "/token"],
  ] as const;
  for (const size of SIZES) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("pageerror", (error) => complaints.push(`${size.label}: page error: ${error.message}`));
    const fits = async (what: string) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) complaints.push(`${size.label}: ${what} scrolls sideways by ${overflow}px`);
      for (const problem of await axeProblems(page)) complaints.push(`${size.label}: ${what}: ${problem}`);
      // A main button is one line here too: 48 px high, on the smallest phone as at 200%.
      const tall = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".button-primary")]
          .filter((button) => button.offsetParent !== null && button.getBoundingClientRect().height > 49)
          .map((button) => `"${(button.textContent ?? "").trim()}" (${Math.round(button.getBoundingClientRect().height)} px)`),
      );
      for (const button of tall) complaints.push(`${size.label}: ${what}: a main button's label takes more than one line: ${button}`);
    };
    const sheetFits = async (what: string) => {
      const box = await page.locator("dialog.sheet").boundingBox();
      if (box === null || box.y < 0 || box.y + box.height > size.height + 0.5 || box.x < 0 || box.x + box.width > size.width + 0.5) complaints.push(`${size.label}: ${what} does not fit on the screen (${JSON.stringify(box)})`);
    };
    // The token's page exists only on a server that has a token: the walk hands the browser the site's page there, and a made-up address.
    const withToken = async (on: boolean) => {
      if (!on) {
        await page.unroute(/\/token$/);
        await page.unroute("**/api/config");
        return;
      }
      await page.route(/\/token$/, async (route) => route.fulfill({ response: await route.fetch({ url: new URL("/", route.request().url()).toString() }) }));
      await page.route("**/api/config", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...body, tokenAddress: EVM, tokenPairAddress: "0xae001C67DbdC649e76BD8f41A75D1D154423D8aD" } });
      });
    };
    try {
      for (const [name, pathname] of PAGES) {
        if (name === "token") await withToken(true);
        await visit(page, new URL(pathname, baseUrl).toString());
        await page.locator("footer").waitFor({ timeout: 20_000 });
        if (name === "token") await page.getByRole("heading", { name: "The $INT token" }).waitFor({ timeout: 15_000 });
        if (name === "home") {
          await page.getByRole("button", { name: "Pay without connecting" }).click();
          await page.getByLabel(/Receiving address/).fill(SOL);
          await page.getByLabel(/Refund address/).fill(EVM);
          await quoted(page);
          await page.evaluate(() => window.scrollTo(0, 0));
          if (size.tag === "zoom") {
            const button = await page.locator(".card-submit .button-primary").boundingBox();
            if (button === null || button.y < 0 || button.y + button.height > size.height) complaints.push(`${size.label}: the card's main button is out of view (${JSON.stringify(button)})`);
          }
        }
        await page.waitForTimeout(300);
        await fits(`the ${name} page`);
        await page.screenshot({ path: path.join(out, `${size.tag}-${name}-${size.width}-dark.png`), fullPage: false });
        shots += 1;
        if (name === "token") await withToken(false);
        if (name === "home") {
          // The coin list and the review open and fit; the review's own button can be reached inside it.
          await page.getByRole("button", { name: /^You pay: / }).click();
          await page.getByRole("dialog").waitFor();
          await page.waitForTimeout(350);
          await sheetFits("the coin list");
          await fits("the coin list");
          await page.keyboard.press("Escape");
          await page.getByRole("dialog").waitFor({ state: "detached" });
          await page.getByRole("button", { name: "Review swap" }).click({ timeout: 40_000 });
          const review = page.getByRole("dialog");
          await review.waitFor();
          await page.waitForTimeout(350);
          await sheetFits("the review");
          await fits("the review");
          await review.getByRole("checkbox").check();
          const confirm = review.getByRole("button", { name: "Confirm swap" });
          await confirm.scrollIntoViewIfNeeded();
          const at = await confirm.boundingBox();
          if (at === null || at.y < 0 || at.y + at.height > size.height + 0.5) complaints.push(`${size.label}: the review's "Confirm swap" cannot be brought onto the screen (${JSON.stringify(at)})`);
          await page.screenshot({ path: path.join(out, `${size.tag}-review-${size.width}-dark.png`), fullPage: false });
          shots += 1;
          await page.keyboard.press("Escape");
        }
      }
      // An order's page, where the paying is done: made on the practice server, with its deposit details on show.
      if (practiceUrl !== null) {
        await visit(page, new URL("/?amount=0.5", practiceUrl).toString());
        await page.getByRole("button", { name: "Pay without connecting" }).click();
        await page.getByLabel(/Receiving address/).fill(freshSol());
        await page.getByLabel(/Refund address/).fill(EVM);
        await page.getByRole("button", { name: "Review swap" }).click({ timeout: 40_000 });
        const review = page.getByRole("dialog");
        await review.getByRole("checkbox").check();
        await orderPace();
        await review.getByRole("button", { name: "Confirm swap" }).click();
        await page.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
        leftUnpaid.push(new URL(page.url()).pathname.split("/").pop() ?? "");
        await page.getByRole("heading", { name: "Send your deposit" }).waitFor({ timeout: 15_000 });
        await page.locator(".deposit").getByRole("checkbox").check();
        await page.locator(".qr").waitFor({ timeout: 5000 });
        await page.waitForTimeout(300);
        await fits("an order's page");
        // The address and the amount to send are whole and on the page, not cut at its edge.
        const cut = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".deposit .address, .deposit-value")].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => (el.textContent ?? "").trim().slice(0, 24)));
        if (cut.length > 0) complaints.push(`${size.label}: on an order's page these are cut off: ${cut.join(", ")}`);
        await page.locator(".deposit").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, `${size.tag}-order-${size.width}-dark.png`), fullPage: false });
        shots += 1;
      }
    } catch (error) {
      complaints.push(`${size.label}: ${(error as Error).message.split("\n")[0]}`);
      await page.screenshot({ path: path.join(failures, `stuck-${size.tag}.png`) }).catch(() => undefined);
    }
    await context.close();
  }

  // The tightest the quote's breakdown ever is with each row on one line: a 480 px screen. And the longest
  // there is to say: the time of a very slow swap ("about 114 min", and in the breakdown "about 114 min ·
  // slower than most"). Every row of the breakdown keeps its line. The quote's own line is looked at at
  // 480 px, where it is two rows, and at 1280 px, where it is one: the rate is whole and the time is on show
  // at both; the points label is whole or, where there is no room for it, out of sight (never cut in half).
  for (const wide of [false, true]) {
    const context = await browser.newContext({ viewport: { width: wide ? 1280 : 480, height: 800 }, deviceScaleFactor: 2, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("pageerror", (error) => complaints.push(`480 px: page error: ${error.message}`));
    await page.route("**/api/quote", async (route) => {
      const response = await route.fetch();
      if (!response.ok()) {
        await route.fulfill({ response });
        return;
      }
      await route.fulfill({ response, json: { ...((await response.json()) as Record<string, unknown>), timeEstimate: 6840 } });
    });
    try {
      await visit(page, new URL("/?amount=0.5", baseUrl).toString());
      await quoted(page);
      const at = wide ? "1280 px" : "480 px";
      const line = await page.locator("button.quote-summary").evaluate((el) => {
        const chips = [...el.querySelectorAll<HTMLElement>(".chip")];
        const rate = el.querySelector<HTMLElement>(".quote-rate");
        const holder = el.querySelector<HTMLElement>(".quote-chips")?.getBoundingClientRect();
        return {
          height: Math.round(el.getBoundingClientRect().height),
          chips: chips.map((chip) => (chip.textContent ?? "").replace(/^, /, "").trim()),
          tones: chips.map((chip) => chip.dataset.tone ?? ""),
          // Where each label is against the one row of labels that is on show: wholly in it, wholly out of it, or cut by its edge.
          seen: chips.map((chip) => {
            const box = chip.getBoundingClientRect();
            if (holder === undefined) return "cut";
            if (box.top >= holder.bottom - 1 || box.bottom <= holder.top + 1) return "out";
            return box.left >= holder.left - 1 && box.right <= holder.right + 1 && box.top >= holder.top - 1 && box.bottom <= holder.bottom + 1 ? "in" : "cut";
          }),
          cut: rate !== null && rate.scrollWidth > rate.clientWidth + 1,
        };
      });
      if (line.height !== (wide ? 44 : 64)) complaints.push(`${at}: the quote's line is ${line.height} px high`);
      if (line.chips.length !== 2 || line.chips[0] !== "about 114 min" || !/^\+[\d.,]+ points$/.test(line.chips[1] ?? "")) complaints.push(`${at}: the quote's line carries ${JSON.stringify(line.chips)}`);
      if (line.tones[0] !== "warning") complaints.push(`${at}: a very slow swap's time is not marked as a warning on the quote's line`);
      if (line.cut || line.seen[0] !== "in" || line.seen[1] === "cut" || (!wide && line.seen[1] !== "in")) complaints.push(`${at}: the quote's line does not hold its rate, its time and its points as it should (${JSON.stringify(line)})`);
      if (wide) {
        await page.locator(".quote").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, "quote-slow-1280-dark.png"), fullPage: false });
        shots += 1;
        await context.close();
        continue;
      }
      await page.locator("button.quote-summary").click();
      await page.getByText("slower than most").waitFor({ timeout: 15_000 });
      await page.waitForTimeout(350);
      const rows = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".quote-row")].map((row) => ({ label: (row.querySelector("dt")?.textContent ?? "").trim(), height: Math.round(row.getBoundingClientRect().height) })));
      if (rows.length !== 6) complaints.push(`480 px: the quote's breakdown has ${rows.length} rows`);
      for (const row of rows) if (row.height > 25) complaints.push(`480 px: the quote's "${row.label}" row is ${row.height} px high: it takes more than one line`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) complaints.push(`480 px: the home page with a very slow swap scrolls sideways by ${overflow}px`);
      await page.locator(".quote").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, "quote-slow-480-dark.png"), fullPage: false });
      shots += 1;
    } catch (error) {
      complaints.push(`480 px: ${(error as Error).message.split("\n")[0]}`);
    }
    await context.close();
  }
}

if (walks("reduced-motion")) {
  const label = "reduced motion";
  for (const reduced of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 360, height: 780 }, reducedMotion: reduced ? "reduce" : "no-preference" });
    const page = await context.newPage();
    try {
      // The coin list is held back, so the loading placeholders are on screen to be looked at.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/api/tokens", async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(new URL("/", baseUrl).toString());
      await page.locator(".skeleton").first().waitFor({ timeout: 15_000 });
      const pulse = await page.locator(".skeleton").first().evaluate((el) => getComputedStyle(el).animationName);
      if (reduced && pulse !== "none") complaints.push(`${label}: a loading placeholder still pulses (${pulse})`);
      if (!reduced && pulse === "none") complaints.push(`${label}: the check proves nothing: a loading placeholder does not pulse even with movement allowed`);
      release();
      await page.getByRole("button", { name: /^You pay: / }).click({ timeout: 20_000 });
      const sheet = page.locator("dialog.sheet");
      await sheet.waitFor();
      const arriving = await sheet.evaluate((el) => getComputedStyle(el).animationName);
      if (reduced && arriving !== "sheet-fade-in") complaints.push(`${label}: a sheet arrives with "${arriving}", not a fade`);
      if (!reduced && arriving !== "sheet-up") complaints.push(`${label}: the check proves nothing: with movement allowed a sheet arrives with "${arriving}"`);
      await page.keyboard.press("Escape");
      const leaving = await sheet.evaluate((el) => getComputedStyle(el).animationName).catch(() => "");
      if (reduced && leaving !== "" && leaving !== "sheet-fade-out") complaints.push(`${label}: a sheet leaves with "${leaving}", not a fade`);
      await sheet.waitFor({ state: "detached" });
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    }
    await context.close();
  }
}

// The address field has no Paste button, and never fills itself in from the clipboard. Pasting into
// it with the keyboard works as in any field, and what is pasted is cleaned of spaces and line ends.
if (walks("paste")) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const label = "paste";
  try {
    await visit(page, new URL("/", baseUrl).toString());
    await page.evaluate((text) => navigator.clipboard.writeText(`  ${text}\n`), SOL);
    await page.waitForTimeout(500);
    const before = await page.getByLabel(/Receiving address/).inputValue();
    if (before !== "") complaints.push(`${label}: the field filled itself in from the clipboard ("${before}")`);
    if ((await page.getByRole("button", { name: /paste/i }).count()) !== 0) complaints.push(`${label}: there is still a Paste button`);
    // Inside the field there is the address and nothing else: no button while no wallet is connected.
    const inside = await page.locator(".address-field button").count();
    if (inside !== 0) complaints.push(`${label}: the address field holds ${inside} button(s) with no wallet connected`);
    const placeholder = await page.getByLabel(/Receiving address/).getAttribute("placeholder");
    if (placeholder !== "Enter Solana address") complaints.push(`${label}: the field's placeholder is "${placeholder}"`);
    // The label is the two words alone: the chain is named in the field, not beside its label.
    const labelText = (await page.locator(".address-field .address-label").first().innerText()).trim();
    if (labelText !== "Receiving address") complaints.push(`${label}: the field's label reads "${labelText}"`);
    await page.getByLabel(/Receiving address/).focus();
    await page.keyboard.press("ControlOrMeta+V");
    await page.waitForTimeout(300);
    const after = await page.getByLabel(/Receiving address/).inputValue();
    if (after !== SOL) complaints.push(`${label}: pasting with the keyboard gave "${after}"`);
    // And it reads the clipboard at no other time: focusing it, or typing in it, pastes nothing.
    await page.getByLabel(/Receiving address/).fill("");
    await page.getByLabel(/Receiving address/).pressSequentially("D");
    const typed = await page.getByLabel(/Receiving address/).inputValue();
    if (typed !== "D") complaints.push(`${label}: after typing one letter the field holds "${typed}"`);
  } catch (error) {
    complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
  }
  await context.close();
}

// Quoting: one request 400 ms after typing stops, a refresh every 15 seconds, and no refresh
// while a sheet is open or the tab is hidden.
if (walks("quoting")) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const label = "quoting";
  const times: number[] = [];
  let unanswered = 0;
  const isQuote = (url: string) => new URL(url).pathname === "/api/quote";
  page.on("request", (request) => {
    if (request.method() === "POST" && isQuote(request.url())) {
      times.push(Date.now());
      unanswered += 1;
    }
  });
  page.on("requestfinished", (request) => {
    if (isQuote(request.url())) unanswered -= 1;
  });
  page.on("requestfailed", (request) => {
    if (isQuote(request.url())) unanswered -= 1;
  });
  // The real price service answers in its own time. Each step below starts only once the last
  // request has been answered, so a slow answer cannot be mistaken for a missing refresh.
  const answered = async () => {
    for (let i = 0; i < 300 && unanswered > 0; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
  };
  const waitForRequests = async (count: number, withinMs: number) => {
    for (let waited = 0; waited < withinMs && times.length < count; waited += 100) await page.waitForTimeout(100);
  };
  const expectThat = (ok: boolean, what: string) => {
    if (!ok) complaints.push(`${label}: ${what}`);
  };
  try {
    await visit(page, new URL("/", baseUrl).toString());
    await page.waitForTimeout(1200);
    expectThat(times.length === 0, `asked for a quote with no amount entered (${times.length} requests)`);
    // Five keystrokes in quick succession: one request, and only after the typing has stopped.
    await page.locator("#amount-in").pressSequentially("0.123", { delay: 60 });
    // The last key went down one pause (60 ms) before this line is reached.
    const stopped = Date.now() - 60;
    await quoted(page);
    expectThat(times.length === 1, `typing five characters sent ${times.length} requests, not one`);
    expectThat((times[0] ?? 0) - stopped >= 380, `the request went out ${(times[0] ?? 0) - stopped} ms after typing stopped, sooner than 400 ms`);
    // Left alone, the quote refreshes about 15 seconds after it arrived.
    await answered();
    const arrived = Date.now();
    await waitForRequests(2, 20_000);
    expectThat(times.length === 2, `left alone for 20 seconds there were ${times.length} requests, not 2 (one refresh)`);
    const refreshGap = (times[1] ?? 0) - arrived;
    expectThat(refreshGap > 13_000 && refreshGap < 17_500, `the refresh came ${refreshGap} ms after the quote arrived, not about 15 seconds`);
    await answered();
    // With a sheet open nothing is refreshed; closing it catches up.
    await page.getByRole("button", { name: /^You pay: / }).click();
    await page.getByRole("listbox", { name: "Coins" }).waitFor();
    await page.waitForTimeout(17_000);
    expectThat(times.length === 2, `the quote was refreshed while the coin picker was open (${times.length} requests)`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await waitForRequests(3, 2500);
    expectThat(times.length === 3, `closing the picker did not catch up with one refresh (${times.length} requests)`);
    await answered();
    // With the tab hidden nothing is refreshed; coming back catches up.
    // Passed as text: the page must not depend on anything this script's own tooling adds to a function.
    const setHidden = (hidden: boolean) =>
      page.evaluate(`
        Object.defineProperty(document, "hidden", { configurable: true, get() { return ${hidden}; } });
        Object.defineProperty(document, "visibilityState", { configurable: true, get() { return ${hidden} ? "hidden" : "visible"; } });
        document.dispatchEvent(new Event("visibilitychange"));
      `);
    await setHidden(true);
    await page.waitForTimeout(17_000);
    expectThat(times.length === 3, `the quote was refreshed while the tab was hidden (${times.length} requests)`);
    await setHidden(false);
    await waitForRequests(4, 2500);
    expectThat(times.length === 4, `coming back to the tab did not refresh the quote (${times.length} requests)`);
    await answered();
    // What a screen reader is told: once for the new inputs, not again for each refresh.
    const spoken = await page.locator('.card > [role="status"].sr-only').innerText();
    expectThat(/^You receive about [\d.,]+ USDT on Solana\.$/.test(spoken), `the quote was not read out as expected ("${spoken}")`);
    expectThat((await page.locator("#amount-out").getAttribute("aria-live")) === "off", "the refreshing number is itself read out on every change");
  } catch (error) {
    complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
  }
  await context.close();
}

// Sheets on a phone: a drag of more than 80 px down closes one, a shorter drag does not, and the page behind does not scroll.
if (walks("sheet-touch")) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const label = "sheet by touch";
  const drag = async (distance: number) => {
    const head = page.locator(".sheet-title");
    const box = await head.boundingBox();
    if (box === null) throw new Error("the sheet's title was not found");
    const x = box.x + 20;
    const y = box.y + box.height / 2;
    const fire = (type: string, dy: number) =>
      head.dispatchEvent(type, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: x, clientY: y + dy, bubbles: true });
    await fire("pointerdown", 0);
    for (let step = 1; step <= 5; step++) await fire("pointermove", (distance * step) / 5);
    await fire("pointerup", distance);
  };
  try {
    await visit(page, new URL("/", baseUrl).toString());
    await page.getByRole("button", { name: /^You pay: / }).click();
    await page.getByRole("dialog").waitFor();
    await page.waitForTimeout(350);
    // The page behind stays put.
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.scrollY);
    if (after !== before) complaints.push(`${label}: the page behind the sheet scrolled by ${after - before}px`);
    if (!(await page.evaluate(() => getComputedStyle(document.body).overflow === "hidden"))) complaints.push(`${label}: the page behind the sheet is not locked`);
    // A short drag: the sheet stays.
    await drag(60);
    await page.waitForTimeout(400);
    if ((await page.getByRole("dialog").count()) !== 1) complaints.push(`${label}: a 60 px drag closed the sheet`);
    // A longer drag: it closes.
    await drag(100);
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 3000 });
    if (await page.evaluate(() => getComputedStyle(document.body).overflow === "hidden")) complaints.push(`${label}: the page stayed locked after the sheet closed`);
  } catch (error) {
    complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
  }
  await context.close();
}

// A field that has focus is never under the pinned button, on a phone-sized screen.
if (walks("focus")) {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const label = "focus on a small screen";
  try {
    await visit(page, new URL("/?amount=0.5", baseUrl).toString());
    await page.getByRole("button", { name: "Pay without connecting" }).click();
    for (const name of [/Receiving address/, /Refund address/]) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByLabel(name).focus();
      await page.waitForTimeout(250);
      const covered = await page.evaluate(() => {
        const field = document.activeElement?.closest(".address-field");
        const bar = document.querySelector(".card-submit");
        if (!field || !bar) return "the field or the button was not found";
        const box = field.getBoundingClientRect();
        const top = bar.getBoundingClientRect().top;
        return box.bottom <= top + 1 ? null : `the field ends at ${Math.round(box.bottom)}, the pinned button starts at ${Math.round(top)}`;
      });
      if (covered !== null) complaints.push(`${label}: ${String(name)}: ${covered}`);
    }
    await page.screenshot({ path: path.join(out, "swap-focus-clear-360.png"), fullPage: false });
    shots += 1;
  } catch (error) {
    complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
  }
  await context.close();
}

// The coin picker by keyboard alone: open, search, move, pick, and close; and the same-coin flip.
if (walks("picker-keyboard")) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const label = "picker by keyboard";
  const expectThat = (ok: boolean, what: string) => {
    if (!ok) complaints.push(`${label}: ${what}`);
  };
  // The chip's name as it is read aloud: "You pay: USDC on Base. Change coin".
  const coinOn = (side: "You pay" | "You receive") => page.getByRole("button", { name: new RegExp(`^${side}: `) }).evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
  try {
    await visit(page, new URL("/", baseUrl).toString());
    const pay = page.getByRole("button", { name: /^You pay: / });
    await pay.focus();
    await page.keyboard.press("Enter");
    const search = page.getByRole("combobox");
    await search.waitFor();
    expectThat(await search.evaluate((el) => el === document.activeElement), "the search field is not focused when the picker opens");
    // A press on a chain chip must not strand the keyboard: focus goes back to the search, typing
    // goes into it, and the arrows still move.
    await page.getByRole("dialog").getByRole("button", { name: "Base", exact: true }).click();
    expectThat(await search.evaluate((el) => el === document.activeElement), "focus did not go back to the search after a chain was chosen");
    await page.keyboard.press("ArrowDown");
    const firstRow = await page.locator(".picker-row[data-active]").innerText().catch(() => "");
    await page.keyboard.press("ArrowDown");
    const secondRow = await page.locator(".picker-row[data-active]").innerText().catch(() => "");
    expectThat(firstRow !== "" && secondRow !== "" && secondRow !== firstRow, `the arrow keys did not move after a chain was chosen ("${firstRow.replace(/\n/g, " ")}" then "${secondRow.replace(/\n/g, " ")}")`);
    expectThat(/Base/.test(secondRow), `with Base chosen the list shows "${secondRow.replace(/\n/g, " ")}"`);
    await page.getByRole("dialog").getByRole("button", { name: "All", exact: true }).click();
    expectThat(await search.evaluate((el) => el === document.activeElement), "focus did not go back to the search after All was chosen");
    await page.keyboard.type("usdc");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const active = await page.locator(".picker-row[data-active]").innerText();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const chosen = (await coinOn("You pay")) ?? "";
    expectThat(/USDC/.test(chosen) && chosen.includes((active.split("·")[1] ?? "").trim().split("\n")[0] ?? "?"), `Enter did not pick the highlighted coin (highlighted "${active.replace(/\n/g, " ")}", got "${chosen}")`);
    expectThat(await pay.evaluate((el) => el === document.activeElement), "focus did not return to the coin button after picking");

    // Esc closes and changes nothing.
    await page.keyboard.press("Enter");
    await search.waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    expectThat((await coinOn("You pay")) === chosen, "Esc changed the coin");
    expectThat(await pay.evaluate((el) => el === document.activeElement), "focus did not return to the coin button after Esc");

    // Tab stays inside the sheet.
    await page.keyboard.press("Enter");
    await search.waitFor();
    for (let i = 0; i < 14; i++) await page.keyboard.press("Tab");
    expectThat(await page.evaluate(() => document.activeElement?.closest("dialog") !== null), "Tab left the sheet");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });

    // Picking, for "You pay", the coin that is on the other side swaps the two.
    const before = { pay: await coinOn("You pay"), receive: await coinOn("You receive") };
    await page.keyboard.press("Enter");
    await search.waitFor();
    await page.keyboard.type("usdt");
    await page.locator(".picker-row", { hasText: "You receive" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    const after = { pay: await coinOn("You pay"), receive: await coinOn("You receive") };
    const strip = (text: string | null) => (text ?? "").replace(/^You (pay|receive): /, "");
    expectThat(strip(after.pay) === strip(before.receive) && strip(after.receive) === strip(before.pay), `picking the coin on the other side did not swap the two (${JSON.stringify(before)} then ${JSON.stringify(after)})`);
  } catch (error) {
    complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
  }
  await context.close();
}

// The two coin chips, measured (see scripts/chips-walk.ts).
if (walks("chips")) {
  const result = await chipsWalk(browser, { baseUrl, out, visit });
  complaints.push(...result.complaints);
  shots += result.shots;
}

// The four pages, the menu, Track order and the Help button (see scripts/site-walk.ts).
if (walks("site")) {
  const result = await siteWalk(browser, { baseUrl, practiceUrl, out, visit });
  complaints.push(...result.complaints);
  shots += result.shots;
}

// Pretend orders the walks above made and left unpaid are ended before the walks that make the most
// begin: the server allows one visitor only so many unpaid orders at a time.
if (practiceUrl !== null) for (const id of leftUnpaid.splice(0)) await settle(practiceUrl, id);

// The order page and the whole flow by keyboard, with pretend orders (see scripts/order-walk.ts).
if (walks("order") && practiceUrl !== null) {
  const result = await orderWalk(browser, { practiceUrl, out, visit });
  complaints.push(...result.complaints);
  shots += result.shots;
}

// Paying from a connected wallet, with a pretend wallet (see scripts/wallet-walk.ts).
if (walks("wallet") && practiceUrl !== null) {
  const result = await walletWalk(browser, { baseUrl, practiceUrl, out, visit });
  complaints.push(...result.complaints);
  shots += result.shots;
}

// Where the focus is shown and where it is not: nothing after a click or Escape, a quiet line on Tab (see scripts/focus-walk.ts).
if (walks("focus-marks")) {
  const result = await focusWalk(browser, { baseUrl: practiceUrl ?? baseUrl, out, visit });
  complaints.push(...result.complaints);
  shots += result.shots;
}

// Private routing, on a practice server set to private and on one set to public (see scripts/private-walk.ts).
if (walks("private") && privateUrl !== null && practiceUrl !== null) {
  const result = await privateWalk(browser, { privateUrl, publicUrl: practiceUrl, out, visit });
  complaints.push(...result.complaints);
  shots += result.shots;
}

// Signing in on the Rewards page, with a pretend wallet (see scripts/rewards-walk.ts).
if (walks("rewards") && practiceUrl !== null) {
  const result = await rewardsWalk(browser, { practiceUrl, out, visit });
  complaints.push(...result.complaints);
  shots += result.shots;
}

// Pretend orders the walks above made and left unpaid are ended, so they do not count against the next run.
if (practiceUrl !== null) for (const id of leftUnpaid) await settle(practiceUrl, id);

await browser.close();
for (const line of complaints) console.error(line);
// The practice server keeps the same limits as the real one, among them thirty orders a day from one
// address. One whole run makes about half of that, so a second whole run on the same day is refused
// near its end unless the practice server was started afresh (its counts are kept in memory).
if (complaints.some((line) => /status of 429/.test(line))) notes.push("an order was refused with \"too many requests\". If the practice server has already served a whole run today, start it again and repeat the run.");
for (const line of notes) console.log(`review-shots: note: ${line}`);
if (busy > 0) console.log(`review-shots: the server asked this script to slow down ${busy} time(s); each preview was tried again`);
console.log(`review-shots: ${shots} screenshots${complaints.length === 0 ? ", console clean, nothing scrolls sideways, the main button is always in view, nothing moves" : `, ${complaints.length} problem(s)`}`);
process.exit(complaints.length === 0 ? 0 : 1);
