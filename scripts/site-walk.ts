// The wider site, walked in a real browser: the four pages in the header, the menu that stands
// in for them on a narrow screen, Track order, the home page around the card, and the Help
// button. Used by scripts/review-shots.ts (walk name: site).
//
// What the walk proves:
//   - the four links are in the header on a wide screen, mark the page you are on, work by
//     keyboard, and the browser's Back button goes back;
//   - on a narrow screen they are in a menu sheet instead, which closes when a page is chosen;
//   - the card is on the first screen of a phone and of a laptop, with its main button in view;
//   - the Help button floats in the corner without lying over the card, the main button or a
//     panel, and steps out of the way while it would lie over anything to press or type into;
//     on a phone it waits while the card's main button is pinned, does not float on an order's
//     page at all, and is in the menu;
//   - none of the four pages fetches any wallet code, or touches another site, before Connect;
//   - the third fact tile shows the same counts as the live coin list;
//   - Track order opens an order from its ID, its link or its deposit address (pretend orders on
//     the practice server), and answers anything else with one sentence that tells nothing.

import path from "node:path";
import type { Browser, Page } from "playwright-core";
import { axeProblems } from "./axe.ts";
import { freshSol, headerFits, orderPace, seeAll, settle } from "./order-walk.ts";

const SOL = "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP";
const EVM = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
const NAMES = ["Swap", "Track order", "Docs", "Rewards"];

export interface WalkResult {
  complaints: string[];
  shots: number;
}

/**
 * The Help button floats in a corner and steps out of the way of anything that can be pressed there.
 * So at any moment it is either on show, or something to press lies where it would be: never hidden for nothing.
 */
async function helpShownOrCovering(page: Page): Promise<boolean> {
  if (await page.locator(".help").isVisible()) return true;
  return page.evaluate(() => {
    const help = document.querySelector(".help");
    if (help === null) return false;
    const box = help.getBoundingClientRect();
    for (const control of document.querySelectorAll("main a, main button, main summary, main input, main textarea, main select, main label, footer a, footer button")) {
      const other = control.getBoundingClientRect();
      if (other.width > 0 && other.height > 0 && other.left < box.right && other.right > box.left && other.top < box.bottom && other.bottom > box.top) return true;
    }
    return false;
  });
}

export async function siteWalk(browser: Browser, options: { baseUrl: string; practiceUrl: string | null; out: string; visit(page: Page, url: string): Promise<void> }): Promise<WalkResult> {
  const complaints: string[] = [];
  let shots = 0;
  const { baseUrl, practiceUrl, out, visit } = options;
  const label = "site";
  const expectThat = (ok: boolean, what: string) => {
    if (!ok) complaints.push(`${label}: ${what}`);
  };
  const watch = (page: Page, expected: () => RegExp | null) => {
    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      if (/\/api\/quote$/.test(message.location().url) && /status of (429|503)/.test(message.text())) return;
      if (expected()?.test(message.text())) return;
      complaints.push(`${label}: ${message.type()}: ${message.text().slice(0, 300)}`);
    });
    page.on("pageerror", (error) => complaints.push(`${label}: page error: ${error.message}`));
  };
  const boxOf = async (page: Page, selector: string) => page.locator(selector).first().boundingBox();
  const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });
    shots += 1;
  };
  const overlaps = (a: { x: number; y: number; width: number; height: number } | null, b: { x: number; y: number; width: number; height: number } | null) =>
    a !== null && b !== null && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  /**
   * Scrolls a page from top to bottom and, wherever the floating Help is on show, checks that nothing
   * that can be pressed or typed into lies under it. It must also be on show somewhere, or the check proves nothing.
   */
  const helpStaysClear = async (page: Page, what: string, mustShow = true) => {
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    const screen = page.viewportSize()?.height ?? 780;
    let shown = 0;
    for (let top = 0; top < total; top += Math.round(screen / 4)) {
      await page.evaluate((y) => window.scrollTo(0, y), top);
      await page.waitForTimeout(150);
      const under = await page.evaluate(() => {
        const help = document.querySelector<HTMLElement>(".help");
        if (help === null) return { shown: false, over: null };
        const style = getComputedStyle(help);
        const box = help.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || box.width === 0) return { shown: false, over: null };
        for (const control of document.querySelectorAll<HTMLElement>("main a, main button, main summary, main input, main textarea, main select, main label, footer a, footer button")) {
          const other = control.getBoundingClientRect();
          if (other.width === 0 || other.height === 0 || getComputedStyle(control).visibility === "hidden") continue;
          if (other.left < box.right && other.right > box.left && other.top < box.bottom && other.bottom > box.top) return { shown: true, over: (control.textContent ?? control.tagName).trim().slice(0, 40) };
        }
        return { shown: true, over: null };
      });
      if (under.shown) shown += 1;
      expectThat(under.over === null, `${what}: ${top} px down, the Help button lies over "${under.over}"`);
    }
    if (mustShow) expectThat(shown > 0, `${what}: the Help button is never on show, anywhere down the page`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
  };

  // ---- A laptop: the links in the header ----
  const wide = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: "dark" });
  const desk = await wide.newPage();
  watch(desk, () => null);
  try {
    await visit(desk, new URL("/", baseUrl).toString());
    const nav = desk.getByRole("navigation", { name: "Main" });
    expectThat(JSON.stringify(await nav.getByRole("link").allInnerTexts()) === JSON.stringify(NAMES), `the header's links are ${JSON.stringify(await nav.getByRole("link").allInnerTexts())}`);
    expectThat(!(await desk.getByRole("button", { name: "Menu" }).isVisible()), "a menu button is shown on a wide screen");
    // After the links: the theme toggle, then the wallet button, in that order, and the name on the left.
    const toggle = desk.getByRole("button", { name: /^Switch to the (Light|Dark) theme$/ });
    const connect = desk.getByRole("button", { name: "Connect", exact: true });
    expectThat((await toggle.isVisible()) && (await connect.isVisible()), "the header of a wide screen lacks the theme toggle or the wallet button");
    const [navBox, toggleBox, connectBox] = [await nav.boundingBox(), await toggle.boundingBox(), await connect.boundingBox()];
    expectThat(navBox !== null && toggleBox !== null && connectBox !== null && navBox.x + navBox.width <= toggleBox.x && toggleBox.x + toggleBox.width <= connectBox.x, "the header's order is not links, theme toggle, wallet button");
    expectThat(await desk.locator("header .wordmark-text").isVisible(), "the header of a wide screen does not show the site's name");
    const themeBefore = await desk.evaluate(() => document.documentElement.dataset.theme);
    await toggle.click();
    expectThat((await desk.evaluate(() => document.documentElement.dataset.theme)) !== themeBefore, "the theme toggle did not change the theme");
    await desk.getByRole("button", { name: /^Switch to the (Light|Dark) theme$/ }).click();
    expectThat((await desk.evaluate(() => document.documentElement.dataset.theme)) === themeBefore, "a second press of the theme toggle did not change the theme back");
    const current = async () => (await nav.locator('[aria-current="page"]').allInnerTexts()).join(",");
    expectThat((await current()) === "Swap", `on the home page the marked link is "${await current()}"`);

    // The card is on the first screen of a laptop, with the headline to its left and its main button in view.
    const card = await boxOf(desk, ".card");
    const headline = await boxOf(desk, ".headline");
    expectThat(card !== null && headline !== null && headline.x + headline.width <= card.x && headline.y < 768 / 2 && card.y < 768 / 2, `on a laptop the headline is not beside the card on the first screen (headline ${JSON.stringify(headline)}, card ${JSON.stringify(card)})`);
    // The headline's words have come up, each one, and stand where they will stay.
    await desk.waitForTimeout(1200);
    const words = await desk.locator(".headline-word").evaluateAll((spans) => spans.map((span) => ({ text: span.textContent ?? "", opacity: getComputedStyle(span).opacity, moved: getComputedStyle(span).transform })));
    expectThat(words.map((word) => word.text).join(" ") === "Swap anything. On NEAR Intents.", `the headline reads "${words.map((word) => word.text).join(" ")}"`);
    expectThat(words.every((word) => word.opacity === "1" && (word.moved === "none" || word.moved === "matrix(1, 0, 0, 1, 0, 0)")), "a word of the headline has not finished coming up");
    const main = await boxOf(desk, ".card-submit .button-primary");
    expectThat(main !== null && main.y + main.height <= 768, "the card's main button is below the first screen of a laptop");
    expectThat(await desk.locator(".help").isVisible(), "on a laptop there is no Help button on the home page");
    expectThat(!overlaps(await boxOf(desk, ".help"), main), "the Help button lies over the main button");
    expectThat(!overlaps(await boxOf(desk, ".help"), card), "the Help button lies over the card");

    // The chains pass under the first screen, and stop under the pointer.
    const strip = desk.locator(".strip");
    await strip.scrollIntoViewIfNeeded();
    await desk.locator(".strip-item").first().waitFor({ timeout: 20_000 });
    const trackAt = () => desk.locator(".strip-track").evaluate((track) => track.getBoundingClientRect().left);
    const first = await trackAt();
    await desk.waitForTimeout(900);
    const second = await trackAt();
    expectThat(second < first, "the strip of chains does not move");
    await strip.hover();
    await desk.waitForTimeout(200);
    const held = await trackAt();
    await desk.waitForTimeout(700);
    expectThat(Math.abs((await trackAt()) - held) < 0.5, "the strip of chains does not stop under the pointer");
    await desk.mouse.move(0, 0);
    expectThat((await desk.locator(".strip-track").getAttribute("aria-hidden")) === "true" && (await strip.locator(".sr-only").innerText()).startsWith("Chains on the coin list: "), "the strip of chains is not given to a screen reader once, as a sentence");

    // The third fact is the live list's own count, counted up to once it is in view. Three facts, no boxes.
    const list = ((await (await fetch(new URL("/api/tokens", baseUrl))).json()) as { tokens: { chain: string }[] }).tokens;
    const reach = desk.locator(".fact").nth(2);
    await reach.scrollIntoViewIfNeeded();
    await desk.waitForTimeout(1500);
    const wanted = [String(list.length), String(new Set(list.map((token) => token.chain)).size)];
    expectThat(JSON.stringify(await reach.locator(".fact-number").allInnerTexts()) === JSON.stringify(wanted), `the third fact shows ${JSON.stringify(await reach.locator(".fact-number").allInnerTexts())} and the live list has ${wanted.join(" coins on ")} chains`);
    expectThat(JSON.stringify(await reach.locator(".sr-only").allInnerTexts()) === JSON.stringify(wanted), "the third fact does not give a screen reader the counts themselves");
    expectThat((await desk.locator(".fact").count()) === 3, `there are ${await desk.locator(".fact").count()} facts`);
    const boxed = await desk.locator(".fact, .statement, .token-fact, .faq-item").evaluateAll((items) => items.filter((item) => {
      const style = getComputedStyle(item);
      return Number.parseFloat(style.borderLeftWidth) > 0 && Number.parseFloat(style.borderRightWidth) > 0 && Number.parseFloat(style.borderTopWidth) > 0 && Number.parseFloat(style.borderBottomWidth) > 0;
    }).length);
    expectThat(boxed === 0, `${boxed} of the facts, statements and questions have a border on all four sides`);

    // What IntentSwap does: one stage, three things (four once the token has an address), one on show at a time.
    const stage = desk.locator(".stage");
    await stage.scrollIntoViewIfNeeded();
    const tabs = stage.getByRole("tab");
    expectThat(JSON.stringify(await stage.locator(".stage-tab-title").allInnerTexts()) === JSON.stringify(["Cross-chain swaps", "Order tracking and automatic refunds", "Points and weekly rewards"]), `the stage's items are ${JSON.stringify(await stage.locator(".stage-tab-title").allInnerTexts())}`);
    expectThat((await stage.getByText(/^(Live|Planned|Paused|Soon)$/).count()) === 0, "an item of the stage carries a tag");
    const onShow = async () => (await stage.locator('.stage-panel[data-active] .stage-title').innerText()).trim();
    const selected = async () => tabs.evaluateAll((all) => all.findIndex((tab) => tab.getAttribute("aria-selected") === "true"));
    expectThat((await onShow()) === "Cross-chain swaps" && (await selected()) === 0, `the stage opens on "${await onShow()}"`);
    // It moves on by itself after six seconds, and waits while the pointer is over it.
    await desk.mouse.move(0, 0);
    await stage.locator('.stage-panel[data-active] .stage-title', { hasText: "Order tracking and automatic refunds" }).waitFor({ timeout: 9000 }).catch(() => expectThat(false, "the stage did not move on by itself within nine seconds"));
    await stage.locator(".stage-view").hover();
    await desk.waitForTimeout(7500);
    expectThat((await onShow()) === "Order tracking and automatic refunds", "the stage moved on while the pointer was over it");
    await desk.mouse.move(0, 0);
    // The arrows, and from then on it stays where it is put.
    await stage.getByRole("button", { name: "Next" }).click();
    await desk.waitForTimeout(800);
    expectThat((await onShow()) === "Points and weekly rewards" && (await selected()) === 2, `after Next the stage shows "${await onShow()}"`);
    await desk.mouse.move(0, 0);
    await desk.waitForTimeout(7500);
    expectThat((await onShow()) === "Points and weekly rewards", "the stage went on moving by itself after it was taken in hand");
    await stage.getByRole("button", { name: "Previous" }).click();
    await desk.waitForTimeout(800);
    expectThat((await onShow()) === "Order tracking and automatic refunds", `after Previous the stage shows "${await onShow()}"`);
    // The arrow keys, on its row of items: right, right (round to the first), left (round to the last), Home.
    await tabs.nth(1).focus();
    for (const [key, title] of [["ArrowRight", "Points and weekly rewards"], ["ArrowRight", "Cross-chain swaps"], ["ArrowLeft", "Points and weekly rewards"], ["Home", "Cross-chain swaps"]] as const) {
      await desk.keyboard.press(key);
      await desk.waitForTimeout(700);
      expectThat((await onShow()) === title, `after ${key} the stage shows "${await onShow()}", not "${title}"`);
      expectThat(await tabs.nth(await selected()).evaluate((tab) => tab === document.activeElement), `after ${key} the focus is not on the item on show`);
    }
    // Only the item on show can be reached; the others are out of the way of the keyboard and of a screen reader.
    expectThat((await stage.locator(".stage-panel:not([data-active])").evaluateAll((panels) => panels.filter((panel) => !(panel as HTMLElement).inert).length)) === 0, "an item of the stage that is not on show can still be reached");
    await shot(desk, "site-stage-1366-dark");
    expectThat((await desk.getByRole("heading", { name: "The $INT token" }).count()) === 0, "the token section is shown although no token address is set");

    // How it works: each step comes into view as it is reached, and the drawing lights part by part.
    const diagram = desk.locator(".diagram");
    await desk.locator(".how-step").last().scrollIntoViewIfNeeded();
    await desk.waitForTimeout(1600);
    expectThat((await desk.locator(".how-step[data-in]").count()) === 3 && (await diagram.getAttribute("data-reached")) === "3", `after scrolling through "How it works" ${await desk.locator(".how-step[data-in]").count()} steps are on show and the drawing has reached ${await diagram.getAttribute("data-reached")}`);
    expectThat((await diagram.locator(".diagram-part").evaluateAll((parts) => parts.every((part) => getComputedStyle(part).opacity === "1"))) === true, "a part of the drawing is still faint after its step was reached");
    await desk.evaluate(() => window.scrollTo(0, 0));

    // No page of the four brings any of the wallet's code with it, or touches another site, before Connect
    // is pressed. Judged by what the fetched scripts contain, not by what they are called.
    const walletMark = /walletconnect\.org|web3modal\.org|w3m-modal/;
    for (const address of ["/", "/track", "/docs", "/rewards"]) {
      const fresh = await wide.newPage();
      const scripts: string[] = [];
      const strangers: string[] = [];
      fresh.on("request", (request) => {
        const url = new URL(request.url());
        if (url.host !== new URL(baseUrl).host) strangers.push(url.host);
        else if (/\/assets\/[^/]+\.js$/.test(url.pathname)) scripts.push(request.url());
      });
      await visit(fresh, new URL(address, baseUrl).toString());
      await fresh.waitForTimeout(1500);
      expectThat(strangers.length === 0, `${address} contacted ${[...new Set(strangers)].join(", ")} before Connect was pressed`);
      expectThat(scripts.length > 0, `${address} fetched no scripts at all, so nothing was checked`);
      for (const script of scripts) expectThat(!walletMark.test(await (await fetch(script)).text()), `${address} fetched wallet code before Connect was pressed (${new URL(script).pathname})`);
      // From 768 px up the Help button floats on every page, clear of whatever the page is about.
      const help = await boxOf(fresh, ".help");
      expectThat(help !== null && (await helpShownOrCovering(fresh)), `on ${address} there is no Help button on a wide screen, and nothing to press where it would be`);
      for (const part of [".card", ".focus-stage", ".rewards-week", ".docs-body", ".button-primary"]) if ((await fresh.locator(part).count()) > 0) expectThat(!overlaps(help, await boxOf(fresh, part)), `on ${address} the Help button lies over ${part}`);
      await fresh.close();
    }

    // By keyboard: Tab reaches the links in order, Enter follows one, Back goes back.
    await desk.locator("header .wordmark").focus();
    for (const name of NAMES) {
      await desk.keyboard.press("Tab");
      expectThat((await desk.evaluate(() => document.activeElement?.textContent ?? "")).trim() === name, `Tab from the wordmark did not reach "${name}" in order`);
    }
    await nav.getByRole("link", { name: "Docs" }).focus();
    await desk.keyboard.press("Enter");
    await desk.getByRole("heading", { name: "How it works", level: 1 }).waitFor({ timeout: 15_000 });
    expectThat(new URL(desk.url()).pathname === "/docs" && (await current()) === "Docs", `after choosing Docs the page is ${desk.url()} and the marked link is "${await current()}"`);
    // The documentation: contents on the left, the text in the middle, the page's own headings on the right.
    const contents = desk.getByRole("navigation", { name: "Contents" });
    const here = desk.getByRole("navigation", { name: "On this page" });
    expectThat((await contents.isVisible()) && (await here.isVisible()), "on a wide screen the docs lack their contents or their list of this page's headings");
    const [contentsBox, docsBody, hereBox] = [await contents.boundingBox(), await boxOf(desk, ".docs-body"), await here.boundingBox()];
    expectThat(contentsBox !== null && docsBody !== null && hereBox !== null && contentsBox.x + contentsBox.width <= docsBody.x && docsBody.x + docsBody.width <= hereBox.x, "on a wide screen the docs are not laid out as contents, text, this page's headings");
    expectThat(docsBody !== null && docsBody.width <= 600, `the docs' reading column is ${Math.round(docsBody?.width ?? 0)} px wide: too long a line to read`);
    expectThat(JSON.stringify(await contents.locator(".docs-page-link").allInnerTexts()) === JSON.stringify(["How it works", "Fees", "Supported chains", "Refunds and deadlines", "Staying safe", "Points and weekly rewards", "Questions", "Terms of Use", "Privacy Policy"]), `the docs' contents are ${JSON.stringify(await contents.locator(".docs-page-link").allInnerTexts())}`);
    expectThat((await contents.locator('.docs-page-link[aria-current="page"]').innerText()) === "How it works", "the docs' contents do not mark the page being read");
    // Next, at the foot of the page, leads to the next page; Previous leads back.
    await desk.getByRole("navigation", { name: "More pages" }).getByRole("link", { name: /Next/ }).click();
    await desk.getByRole("heading", { name: "Fees", level: 1 }).waitFor({ timeout: 15_000 });
    expectThat(new URL(desk.url()).pathname === "/docs/fees" && (await current()) === "Docs", `Next from the first page of the docs led to ${desk.url()}`);
    await desk.getByRole("navigation", { name: "More pages" }).getByRole("link", { name: /Previous/ }).click();
    await desk.getByRole("heading", { name: "How it works", level: 1 }).waitFor({ timeout: 15_000 });
    // A page from the contents; then one of its headings from "On this page": it comes to the top and is marked, in both lists.
    await contents.getByRole("link", { name: "Refunds and deadlines" }).click();
    await desk.getByRole("heading", { name: "Refunds and deadlines", level: 1 }).waitFor({ timeout: 15_000 });
    expectThat(new URL(desk.url()).pathname === "/docs/refunds", `choosing a page in the docs' contents led to ${desk.url()}`);
    for (const figure of ["28 minutes", "58 minutes", "1 hour 58 minutes", "2 minutes"]) expectThat((await desk.locator(".docs-body").innerText()).includes(figure), `the docs do not give "${figure}" among the deadlines`);
    await desk.setViewportSize({ width: 1366, height: 500 });
    await here.getByRole("link", { name: "What may be lost" }).click();
    await desk.waitForTimeout(500);
    const lost = await boxOf(desk, "#lost");
    expectThat(lost !== null && lost.y >= 60 && lost.y < 300, `choosing a heading in "On this page" did not bring it to the top, clear of the header (it is at ${lost?.y})`);
    expectThat(new URL(desk.url()).hash === "#lost", "a heading's link does not put its address in the address bar");
    for (const list of [here, contents]) expectThat((await list.locator('[aria-current="location"]').innerText()).trim() === "What may be lost", "the heading being read is not marked in the docs' lists");
    await desk.evaluate(() => window.scrollTo(0, 0));
    await desk.waitForTimeout(400);
    expectThat((await here.locator('[aria-current="location"]').innerText()).trim() === "The time to send", "back at the top of the page the first heading is not the one marked");
    await desk.setViewportSize({ width: 1366, height: 768 });
    // Each heading has a link to itself, and a warning is a note with a rule down its side, not a box.
    expectThat((await desk.locator(".docs-body h2 .heading-anchor").count()) === (await desk.locator(".docs-body h2").count()) && (await desk.locator(".docs-body h2").count()) >= 3, "a heading of the docs has no link to itself");
    const callout = await desk.locator(".callout").first().evaluate((note) => ({ left: Number.parseFloat(getComputedStyle(note).borderLeftWidth), top: Number.parseFloat(getComputedStyle(note).borderTopWidth), right: Number.parseFloat(getComputedStyle(note).borderRightWidth) }));
    expectThat(callout.left > 0 && callout.top === 0 && callout.right === 0, "a warning in the docs is drawn as a box");
    await shot(desk, "site-docs-refunds-1366-dark");
    // The Terms and the Privacy Policy are in the same layout, at the end of the same contents.
    await contents.getByRole("link", { name: "Terms of Use" }).click();
    await desk.getByRole("heading", { name: "Terms of Use", level: 1 }).waitFor({ timeout: 15_000 });
    expectThat((await here.getByRole("link").count()) === 13 && (await desk.getByText(/draft/i).count()) === 0, `the Terms show ${await here.getByRole("link").count()} sections under "On this page", or still call themselves a draft`);
    await desk.goto(new URL("/", baseUrl).toString(), { waitUntil: "networkidle" });
    await desk.locator(".card").waitFor({ timeout: 15_000 });
    await nav.getByRole("link", { name: "Rewards" }).click();
    await desk.getByRole("heading", { name: "Points and weekly rewards", level: 1 }).waitFor({ timeout: 15_000 });
    expectThat((await current()) === "Rewards", `on Rewards the marked link is "${await current()}"`);
    // Before anyone has signed in: the week and its countdown, the rules, a way to connect; nobody's points, and no address.
    await desk.locator(".rewards-count").waitFor({ timeout: 15_000 });
    const clock = (await desk.locator(".rewards-count").innerText()).trim();
    expectThat(/^\d+d \d{2}:\d{2}:\d{2}$/.test(clock), `the week's countdown reads "${clock}"`);
    await desk.waitForTimeout(1200);
    expectThat((await desk.locator(".rewards-count").innerText()).trim() !== clock, "the week's countdown does not count");
    expectThat(await desk.getByRole("button", { name: "Connect to see your points" }).isVisible(), "the Rewards page does not offer to connect");
    expectThat((await desk.locator(".rewards-rules li").count()) === 5, `the Rewards page gives ${await desk.locator(".rewards-rules li").count()} rules in short`);
    const rewards = await desk.locator("main#main").innerText();
    expectThat(!/0x[0-9a-fA-F]{6}/.test(rewards) && (await desk.locator(".rewards-points").count()) === 0, "the Rewards page shows an address or a number of points to someone who has not signed in");
    expectThat((await desk.getByRole("heading", { name: "The reserve" }).count()) === 0, "the Rewards page shows a reserve although no reserve address is set");
    await desk.goto(new URL("/", baseUrl).toString(), { waitUntil: "networkidle" });
    await desk.locator(".card").waitFor({ timeout: 15_000 });

    // Help leads to the questions.
    await desk.getByRole("link", { name: "Help" }).click();
    await desk.getByRole("heading", { name: "Questions" }).waitFor({ timeout: 15_000 });
    await desk.waitForTimeout(400);
    const faq = await desk.getByRole("heading", { name: "Questions" }).boundingBox();
    expectThat(new URL(desk.url()).pathname === "/" && faq !== null && faq.y >= 0 && faq.y < 768, "the Help button did not bring the questions into view");
  } catch (error) {
    complaints.push(`${label} (wide): ${(error as Error).message.split("\n")[0]}`);
    await desk.screenshot({ path: path.join(out, "..", "..", "data", "stuck-site-wide.png") }).catch(() => undefined);
  }
  await wide.close();

  // ---- The site's own icons: each is served by the site, as what it is, and the tab's is drawn for the eye ----
  {
    const label = "icons";
    const say = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const served = new Map<string, Buffer>();
    for (const [address, type] of [
      ["/favicon.ico", "image/x-icon"],
      ["/favicon-32.png", "image/png"],
      ["/apple-touch-icon.png", "image/png"],
      ["/icon-192.png", "image/png"],
      ["/icon-512.png", "image/png"],
      ["/site.webmanifest", "application/manifest+json; charset=utf-8"],
    ] as const) {
      const reply = await fetch(new URL(address, baseUrl));
      say(reply.status === 200 && reply.headers.get("content-type") === type, `${address} is answered ${reply.status} as ${reply.headers.get("content-type")}`);
      served.set(address, Buffer.from(await reply.arrayBuffer()));
    }
    // The page's head names them, and every one it names is at this site.
    const head = await (await fetch(new URL("/", baseUrl))).text();
    const named = [...head.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"]*)"/g)].map((link) => link[1] ?? "");
    say(named.join(" ") === "/favicon.ico /favicon-32.png /apple-touch-icon.png /site.webmanifest", `the page's head names these icons: ${named.join(" ")}`);
    // The three sizes inside favicon.ico, each a picture of its own, drawn from the very bytes the site sent
    // (a page at another address may not embed the site's files): as a tab shows it, and enlarged.
    const ico = served.get("/favicon.ico")!;
    const frames = new Map<number, string>();
    for (let index = 0; index < ico.readUInt16LE(4); index++) {
      const at = 6 + 16 * index;
      frames.set(ico[at]!, `data:image/png;base64,${ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8)).toString("base64")}`);
    }
    say([...frames.keys()].join(" ") === "16 32 48", `favicon.ico holds the sizes ${[...frames.keys()].join(", ")}`);
    const touch = `data:image/png;base64,${served.get("/apple-touch-icon.png")!.toString("base64")}`;
    const strip = (ground: string, ink: string) =>
      `<div style="background:${ground};color:${ink};padding:12px 16px;display:flex;gap:24px;align-items:center;font:13px system-ui"><span style="display:inline-flex;gap:8px;align-items:center;background:rgba(127,127,127,.18);border-radius:8px 8px 0 0;padding:8px 14px"><img src="${frames.get(16)}" width="16" height="16">IntentSwap</span><img src="${frames.get(32)}" width="32" height="32"><img src="${frames.get(48)}" width="48" height="48"><img src="${frames.get(16)}" width="96" height="96" style="image-rendering:pixelated"><img src="${touch}" width="60" height="60" style="border-radius:13px"></div>`;
    const sheet = await (await browser.newContext({ viewport: { width: 720, height: 200 }, deviceScaleFactor: 2 })).newPage();
    await sheet.setContent(`<!doctype html><body style="margin:0">${strip("#202124", "#e8eaed")}${strip("#dee1e6", "#202124")}</body>`, { waitUntil: "load" });
    await sheet.screenshot({ path: path.join(out, "brand-tab-icon.png") });
    shots += 1;
    await sheet.context().close();
  }

  // ---- A kept copy of the coin list, and no live one ----
  const kept = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  const later = await kept.newPage();
  let down = false;
  watch(later, () => (down ? /status of 503/ : null));
  try {
    // A first visit, which keeps the list in the browser.
    await visit(later, new URL("/", baseUrl).toString());
    await later.locator(".fact .fact-number").first().waitFor({ state: "attached", timeout: 20_000 });
    expectThat((await later.evaluate(() => Object.keys(localStorage).some((key) => (localStorage.getItem(key) ?? "").includes('"tokens"')))) === true, "the coin list is not kept in the browser for a later visit");
    // A later visit, on which the list cannot be fetched: the card still works from the kept copy, and nothing is counted as live.
    down = true;
    await later.route("**/api/tokens", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "try_later", message: "Try again shortly." } }) }));
    await visit(later, new URL("/", baseUrl).toString());
    await later.locator("button.coin-button").nth(1).waitFor({ timeout: 20_000 });
    await later.waitForTimeout(500);
    expectThat((await later.locator(".fact").count()) === 2 && (await later.locator(".fact .skeleton").count()) === 0, `from a kept copy of the coin list the page shows ${await later.locator(".fact").count()} facts: the count must not be called live, and its place must not be left waiting`);
    await visit(later, new URL("/docs/chains", baseUrl).toString());
    await later.getByText("The live list of coins could not be loaded just now.").waitFor({ timeout: 20_000 });
    expectThat((await later.locator(".docs-chains tr").count()) === 0, "the docs list chains from a kept copy of the coin list as if it were live");
  } catch (error) {
    complaints.push(`${label} (kept list): ${(error as Error).message.split("\n")[0]}`);
  }
  await kept.close();

  // ---- 768 px: the menu by keyboard, and the Help button as an icon ----
  const middle = await browser.newContext({ viewport: { width: 768, height: 1024 }, colorScheme: "light" });
  const tablet = await middle.newPage();
  watch(tablet, () => null);
  try {
    await visit(tablet, new URL("/", baseUrl).toString());
    const help = tablet.locator(".help");
    expectThat(await help.isVisible(), "at 768 px there is no Help button");
    const helpBox = await boxOf(tablet, ".help");
    expectThat(helpBox !== null && helpBox.width <= 48 && (await tablet.locator(".help-label").evaluate((el) => el.getBoundingClientRect().width)) <= 1, `at 768 px the Help button is ${helpBox?.width} wide: its label should be for screen readers only`);
    expectThat((await help.getAttribute("title")) === "Help" && (await help.innerText()).trim() === "Help", "the Help button has no name for a screen reader");
    expectThat(!overlaps(helpBox, await boxOf(tablet, ".card")), "at 768 px the Help button lies over the card");
    await helpStaysClear(tablet, "the home page at 768 px");

    // The menu, with the keyboard alone: reach its button, open it, move to a page, choose it.
    await tablet.locator("header .wordmark").focus();
    const menuButton = tablet.getByRole("button", { name: "Menu" });
    for (let presses = 0; presses < 12 && !(await menuButton.evaluate((el) => el === document.activeElement)); presses++) await tablet.keyboard.press("Tab");
    expectThat(await menuButton.evaluate((el) => el === document.activeElement), "the keyboard does not reach the menu button");
    await tablet.keyboard.press("Enter");
    const sheet = tablet.getByRole("dialog");
    await sheet.waitFor();
    expectThat(await tablet.evaluate(() => document.activeElement?.closest("dialog") !== null), "focus is not inside the menu once it is open");
    const docs = sheet.getByRole("link", { name: "Docs" });
    for (let presses = 0; presses < 12 && !(await docs.evaluate((el) => el === document.activeElement)); presses++) await tablet.keyboard.press("Tab");
    expectThat(await docs.evaluate((el) => el === document.activeElement), "the keyboard does not reach Docs in the menu");
    await tablet.keyboard.press("Enter");
    await tablet.getByRole("heading", { name: "How it works", level: 1 }).waitFor({ timeout: 15_000 });
    expectThat((await tablet.getByRole("dialog").count()) === 0 && new URL(tablet.url()).pathname === "/docs", "choosing Docs in the menu by keyboard did not open it and close the menu");
    // Below 1024 px the contents are one line at the top of the page, which opens.
    const fold = tablet.locator(".docs-fold");
    expectThat((await fold.isVisible()) && !(await tablet.locator(".docs-contents").isVisible()), "at 768 px the docs' contents are not folded into a line at the top");
    await fold.locator("summary").click();
    expectThat(await fold.getByRole("link", { name: "Staying safe" }).isVisible(), "the docs' folded contents do not open");
    await fold.locator("summary").click();
    // Down the whole of the Docs at this width, where the contents list is part of the page: Help never over a link or a question.
    await tablet.locator("footer").waitFor({ timeout: 15_000 });
    await helpStaysClear(tablet, "the Docs at 768 px");
    // Esc closes the menu and gives the focus back to its button.
    await menuButton.focus();
    await tablet.keyboard.press("Enter");
    await tablet.getByRole("dialog").waitFor();
    await tablet.keyboard.press("Escape");
    await tablet.getByRole("dialog").waitFor({ state: "detached" });
    expectThat(await menuButton.evaluate((el) => el === document.activeElement), "focus did not return to the menu button when the menu closed");
  } catch (error) {
    complaints.push(`${label} (768): ${(error as Error).message.split("\n")[0]}`);
    await tablet.screenshot({ path: path.join(out, "..", "..", "data", "stuck-site-768.png") }).catch(() => undefined);
  }
  await middle.close();

  // ---- A phone: the menu, and Track order ----
  const home = practiceUrl ?? baseUrl;
  const narrow = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, colorScheme: "dark", hasTouch: true, isMobile: true });
  const phone = await narrow.newPage();
  let missing = false;
  // Pretend orders this walk makes: ended when it is over, so they do not sit unpaid.
  const made: string[] = [];
  watch(phone, () => (missing ? /status of 404/ : null));
  try {
    await visit(phone, new URL("/?amount=0.5", home).toString());
    expectThat(!(await phone.getByRole("navigation", { name: "Main" }).isVisible()), "the header's links are shown on a phone, where there is no room for them");
    // The card is on the first screen, with its main button in view and Help clear of it.
    await phone.locator(".quote-rate").first().waitFor({ timeout: 30_000 });
    const card = await boxOf(phone, ".card");
    expectThat(card !== null && card.y < 780 / 2, `on a phone the card starts at ${card?.y}: the headline pushes it down`);
    const main = await boxOf(phone, ".card-submit .button-primary");
    expectThat(main !== null && main.y >= 0 && main.y + main.height <= 780, "on a phone the card's main button is not in view");
    // While the main button is pinned, the Help button is out of the way: it would lie over the card.
    expectThat(!(await phone.locator(".help").isVisible()), "on a phone the Help button floats over the card while the main button is pinned");
    await phone.screenshot({ path: path.join(out, "site-home-360-dark.png"), fullPage: false });
    shots += 1;
    // Past the card it is there, in the corner, clear of everything that can be pressed around it.
    await phone.getByRole("heading", { name: "What IntentSwap does" }).scrollIntoViewIfNeeded();
    await phone.waitForTimeout(400);
    // The stage answers a finger: a swipe to the left brings the next item, one to the right the one before.
    const stage = phone.locator(".stage");
    const view = stage.locator(".stage-view");
    await view.scrollIntoViewIfNeeded();
    const showing = async () => (await stage.locator(".stage-panel[data-active] .stage-title").innerText()).trim();
    const swipe = (from: number, to: number) =>
      view.evaluate(
        (element, [start, end]) => {
          // (Written out twice rather than with a helper: the page knows nothing of this script's own tooling.)
          const at = element.getBoundingClientRect();
          element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 7, clientX: at.left + (start ?? 0), clientY: at.top + at.height / 2 }));
          element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", pointerId: 7, clientX: at.left + (end ?? 0), clientY: at.top + at.height / 2 }));
        },
        [from, to],
      );
    const firstItem = await showing();
    await swipe(260, 80);
    await phone.waitForTimeout(800);
    const nextItem = await showing();
    expectThat(nextItem !== firstItem, "a swipe to the left did not bring the stage's next item");
    await swipe(80, 260);
    await phone.waitForTimeout(800);
    expectThat((await showing()) === firstItem, "a swipe to the right did not bring the stage's item before");
    await swipe(150, 165);
    await phone.waitForTimeout(500);
    expectThat((await showing()) === firstItem, "a touch that is not a swipe moved the stage");
    await phone.screenshot({ path: path.join(out, "site-stage-360-dark.png"), fullPage: false });
    shots += 1;
    expectThat(await helpShownOrCovering(phone), "on a phone the Help button does not come back once the card is scrolled past, though nothing to press lies where it would be");
    const help = await boxOf(phone, ".help");
    expectThat(help !== null && help.x + help.width <= 360 && help.y + help.height <= 780, "on a phone the Help button is not wholly on screen");
    await phone.screenshot({ path: path.join(out, "site-home-help-360-dark.png"), fullPage: false });
    shots += 1;
    // All the way down the home page, questions and footer included: never over anything that can be pressed.
    await helpStaysClear(phone, "the home page on a phone");
    await phone.evaluate(() => window.scrollTo(0, 0));
    await phone.waitForTimeout(300);

    // On a phone the header shows the site's name, in full, and nothing in the header is squeezed or pushed off screen.
    const name = phone.locator("header .wordmark-text");
    expectThat((await name.isVisible()) && ((await name.innerText()).trim() === "IntentSwap"), "the phone's header does not show the name IntentSwap");
    const fits = await headerFits(phone);
    expectThat(fits === null, `in the phone's header ${fits}`);
    expectThat(!(await phone.getByRole("button", { name: /^Switch to the (Light|Dark) theme$/ }).isVisible()), "the theme toggle is in the phone's header as well as in its menu");

    await phone.getByRole("button", { name: "Menu" }).tap();
    const menu = phone.getByRole("dialog");
    await menu.waitFor();
    // The theme is changed from the menu on a phone, and changed back.
    const startTheme = await phone.evaluate(() => document.documentElement.dataset.theme);
    await menu.getByRole("button", { name: "Switch theme" }).tap();
    expectThat((await phone.evaluate(() => document.documentElement.dataset.theme)) !== startTheme, "the menu's theme button did not change the theme");
    await menu.getByRole("button", { name: "Switch theme" }).tap();
    expectThat((await phone.evaluate(() => document.documentElement.dataset.theme)) === startTheme, "the menu's theme button did not change the theme back");
    // The menu's own lines: the four pages and Help. (Its three icon links, at its foot, are checked with the header's.)
    expectThat(JSON.stringify((await menu.locator("a.menu-link").allInnerTexts()).map((text) => text.split("\n")[0]?.trim())) === JSON.stringify([...NAMES, "Help"]), `the menu lists ${JSON.stringify(await menu.locator("a.menu-link").allInnerTexts())}`);
    expectThat(((await menu.locator('[aria-current="page"]').innerText()).split("\n")[0] ?? "").trim() === "Swap", "the menu does not mark the page you are on");
    expectThat(!(await phone.locator(".help").isVisible()), "the Help button shows through the menu");
    await menu.getByRole("link", { name: /Track order/ }).tap();
    await phone.getByRole("heading", { name: "Track an order" }).waitFor({ timeout: 15_000 });
    expectThat((await phone.getByRole("dialog").count()) === 0, "the menu stayed open after a page was chosen");
    expectThat(new URL(phone.url()).pathname === "/track", `the menu's Track order led to ${phone.url()}`);

    // The floating Help is here too, clear of the field and of the button. Where the list of this browser's orders
    // runs under its corner it steps out of the way (each row is something to press), and is shown wherever nothing is.
    await phone.waitForTimeout(900);
    const onTrack = await boxOf(phone, ".help");
    const helpShown = await phone.locator(".help").isVisible();
    const underHelp = onTrack === null ? 0 : await phone.locator("main a, main button, main textarea, footer a").evaluateAll((controls, box) => controls.filter((control) => { const other = control.getBoundingClientRect(); return other.width > 0 && other.left < box.x + box.width && other.right > box.x && other.top < box.y + box.height && other.bottom > box.y; }).length, onTrack);
    expectThat(!overlaps(onTrack, await boxOf(phone, ".focus-stage")) || !helpShown, "on a phone's Track order page the Help button lies over the field");
    expectThat(helpShown === (underHelp === 0), `on a phone's Track order page the Help button is ${helpShown ? "shown over" : "hidden with"} ${underHelp} thing(s) to press under its corner`);

    // Track order: what is not an order ID or an address cannot be looked for at all.
    const field = phone.getByLabel("Order ID or deposit address");
    expectThat(await phone.getByRole("button", { name: "Enter order ID or address" }).isDisabled(), "an empty field can be looked for");
    await field.fill("hello there");
    expectThat(await phone.getByRole("button", { name: "Not an order ID or address" }).isDisabled(), "text that is no ID and no address can be looked for");

    // An address and an ID that are no order's get the same sentence.
    missing = true;
    const said: string[] = [];
    for (const miss of [EVM, "z".repeat(27), SOL]) {
      await field.fill(miss);
      await phone.getByRole("button", { name: "Find order" }).tap();
      await phone.getByText("No order matches that.").waitFor({ timeout: 20_000 });
      said.push(await phone.locator("#track-message").innerText());
      expectThat(new URL(phone.url()).pathname === "/track", "a miss left the Track order page");
    }
    expectThat(new Set(said).size === 1, `misses of different kinds are answered differently: ${JSON.stringify(said)}`);
    await phone.screenshot({ path: path.join(out, "site-track-miss-360-dark.png"), fullPage: false });
    shots += 1;
    missing = false;

    if (practiceUrl !== null) {
      // A pretend order, then found three ways: by its ID, by its link, by its deposit address in other capitals.
      await visit(phone, new URL("/?amount=0.5", practiceUrl).toString());
      await phone.getByRole("button", { name: "Pay without connecting" }).tap();
      await phone.getByLabel(/Receiving address/).fill(freshSol());
      await phone.getByLabel(/Refund address/).fill(EVM);
      await phone.getByRole("button", { name: "Review swap" }).tap({ timeout: 40_000 });
      const review = phone.getByRole("dialog");
      await review.getByRole("checkbox").check();
      await orderPace();
      await review.getByRole("button", { name: "Confirm swap" }).tap();
      await phone.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
      const id = new URL(phone.url()).pathname.split("/").pop() ?? "";
      made.push(id);
      const deposit = ((await (await fetch(new URL(`/api/orders/${id}`, practiceUrl))).json()) as { depositAddress: string }).depositAddress;
      // On a phone an order's page has no floating Help: the first screen there is the pay step, and
      // nothing may lie over it. Help is in the menu (checked next) and in the footer.
      await phone.locator("footer").waitFor({ timeout: 15_000 });
      expectThat(!(await phone.locator(".help").isVisible()), "on a phone a floating Help lies over an order's page");
      expectThat((await phone.locator("footer").getByRole("link", { name: "FAQ" }).count()) === 1, "on a phone an order's page has no link to the questions in its footer");
      // On an order's own page the menu marks Track order.
      await phone.getByRole("button", { name: "Menu" }).tap();
      expectThat(await phone.getByRole("dialog").getByRole("link", { name: "Help" }).isVisible(), "on a phone the menu has no Help");
      expectThat(((await phone.getByRole("dialog").locator('[aria-current="page"]').innerText()).split("\n")[0] ?? "").trim() === "Track order", "on an order's page the menu does not mark Track order");
      await phone.keyboard.press("Escape");
      await phone.getByRole("dialog").waitFor({ state: "detached" });
      for (const [how, text] of [
        ["its ID", id],
        ["its link", new URL(`/order/${id}`, practiceUrl).toString()],
        ["its deposit address", deposit.toLowerCase()],
      ] as const) {
        await visit(phone, new URL("/track", practiceUrl).toString());
        await phone.getByLabel("Order ID or deposit address").fill(text);
        await phone.keyboard.press("Enter");
        await phone.waitForURL(new RegExp(`/order/${id}$`), { timeout: 20_000 }).catch(() => undefined);
        expectThat(new URL(phone.url()).pathname === `/order/${id}`, `Track order did not open the order from ${how} (it is at ${phone.url()})`);
      }
      // The look-up says which order, and nothing about it.
      const config = (await (await fetch(new URL("/api/config", practiceUrl))).json()) as { session: string };
      const found = await fetch(new URL("/api/track", practiceUrl), { method: "POST", headers: { "content-type": "application/json", "x-session": config.session, origin: new URL(practiceUrl).origin }, body: JSON.stringify({ depositAddress: deposit }) });
      expectThat(JSON.stringify(await found.json()) === JSON.stringify({ id }), "the look-up by deposit address answers with more than the order's ID");
    }
  } catch (error) {
    complaints.push(`${label} (phone): ${(error as Error).message.split("\n")[0]}`);
    await phone.screenshot({ path: path.join(out, "..", "..", "data", "stuck-site-phone.png") }).catch(() => undefined);
  }
  await narrow.close();
  if (practiceUrl !== null) for (const id of made) await settle(practiceUrl, id);

  // ---- A chain that is left off the site (the Abstract chain, by default) is nowhere on it ----
  // The real provider lists it; this server's coin list must not, and so neither may any page.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
    const page = await context.newPage();
    watch(page, () => null);
    try {
      const listed = ((await (await fetch(new URL("/api/tokens", baseUrl))).json()) as { tokens: { chain: string }[] }).tokens;
      expectThat(listed.length > 0 && !listed.some((token) => token.chain === "abs"), `the coin list has ${listed.filter((token) => token.chain === "abs").length} coins on the excluded chain (of ${listed.length})`);
      const chains = new Set(listed.map((token) => token.chain)).size;
      // The home page: the strip of chains, and the fact that counts coins and chains.
      await visit(page, new URL("/", baseUrl).toString());
      await page.locator(".strip-item").first().waitFor({ timeout: 20_000 });
      await page.locator(".fact").nth(2).waitFor({ timeout: 20_000 });
      const home = await page.locator("main#main").evaluate((main) => main.textContent ?? "");
      expectThat(!/abstract/i.test(home), "the home page names the Abstract chain");
      const reach = (await page.locator(".fact").nth(2).evaluate((fact) => fact.textContent ?? "")).replace(/\s+/g, " ");
      expectThat(reach.includes(String(listed.length)) && reach.includes(String(chains)), `the home page's count reads "${reach}", but the list has ${listed.length} coins on ${chains} chains`);
      // The picker: its chain chips and its rows.
      await page.getByRole("button", { name: /^You pay: / }).click();
      await page.getByRole("listbox", { name: "Coins" }).waitFor();
      const picker = await page.getByRole("dialog").evaluate((sheet) => sheet.textContent ?? "");
      expectThat(!/abstract/i.test(picker), "the coin picker names the Abstract chain");
      await page.getByRole("combobox").fill("abstract");
      await page.getByText("No coins match.").waitFor({ timeout: 5000 }).catch(() => expectThat(false, 'searching the picker for "abstract" finds something'));
      await page.keyboard.press("Escape");
      // The Docs' table of chains, and its count.
      await visit(page, new URL("/docs/chains", baseUrl).toString());
      await page.locator(".docs-chains tr").first().waitFor({ timeout: 20_000 });
      const docs = await page.locator("main#main").evaluate((main) => main.textContent ?? "");
      expectThat(!/abstract/i.test(docs), "the Docs' list of chains names the Abstract chain");
      expectThat((await page.locator(".docs-chains tr").count()) === chains, `the Docs list ${await page.locator(".docs-chains tr").count()} chains, the coin list has ${chains}`);
    } catch (error) {
      complaints.push(`${label} (excluded chain): ${(error as Error).message.split("\n")[0]}`);
    }
    await context.close();
  }

  // ---- The right of the header: three icon links, the theme, the wallet. No clock and no status dot. ----
  // Photographed at 360, 768 and 1280 px in both themes. The three links are walked twice: as the site
  // stands before the operator has set their addresses (an icon that goes nowhere), and with addresses set.
  const NAMES_OF_ICONS = ["IntentSwap on DexScreener", "IntentSwap on GitHub", "IntentSwap on X"];
  const SET = { dexscreenerUrl: "https://dexscreener.com/bsc/0xae001c67dbdc649e76bd8f41a75d1d154423d8ad", githubUrl: "https://github.com/intentswap/intentswap", xUrl: "https://x.com/intentswap" };
  for (const theme of ["dark", "light"] as const) {
    for (const width of [360, 768, 1280] as const) {
      const where = `header ${width} ${theme}`;
      const mobile = width < 768;
      const context = await browser.newContext({ viewport: { width, height: mobile ? 780 : 800 }, deviceScaleFactor: 2, colorScheme: theme, hasTouch: mobile, isMobile: mobile });
      await context.addInitScript(`try { localStorage.setItem("theme", "${theme}"); } catch {}`);
      const page = await context.newPage();
      watch(page, () => null);
      const say = (ok: boolean, what: string) => {
        if (!ok) complaints.push(`${where}: ${what}`);
      };
      try {
        await visit(page, new URL("/", baseUrl).toString());
        await page.locator(".header .button-wallet").waitFor({ timeout: 20_000 });
        await page.waitForTimeout(600);
        const header = page.locator("header.header");
        say((await header.locator(".status, .status-dot").count()) === 0, "the header still has a status dot");
        say((await header.getByRole("button", { name: "Recent orders" }).count()) === 0, "the header still has the clock for recent orders");
        const icons = header.locator('.social[data-where="header"] .social-link');
        const inHeader = await header.locator('.social[data-where="header"]').isVisible();
        say(inHeader === width >= 768, `at ${width} px the three icons are ${inHeader ? "shown" : "not shown"} in the header`);
        if (inHeader) {
          const drawn = await icons.evaluateAll((links) =>
            links.map((link) => {
              const box = link.getBoundingClientRect();
              const mark = link.querySelector("svg")?.getBoundingClientRect();
              return { name: link.getAttribute("aria-label"), x: Math.round(box.x), size: `${box.width}x${box.height}`, mark: `${mark?.width}x${mark?.height}`, colour: getComputedStyle(link).color, href: link.getAttribute("href") };
            }),
          );
          say(JSON.stringify(drawn.map((icon) => icon.name)) === JSON.stringify(NAMES_OF_ICONS), `the header's icons are ${JSON.stringify(drawn.map((icon) => icon.name))}`);
          say(drawn.every((icon) => icon.size === "36x36" && icon.mark === "20x20"), `the header's icons are drawn at ${JSON.stringify(drawn.map((icon) => `${icon.mark} in ${icon.size}`))}`);
          const muted = await page.evaluate(() => {
            const probe = document.createElement("span");
            probe.className = "muted";
            document.body.append(probe);
            const colour = getComputedStyle(probe).color;
            probe.remove();
            return colour;
          });
          say(drawn.every((icon) => icon.colour === muted), `at rest the header's icons are ${JSON.stringify(drawn.map((icon) => icon.colour))}, not the quiet text colour ${muted}`);
          // Then the theme, then the wallet.
          const toggle = await header.getByRole("button", { name: /^Switch to the (Light|Dark) theme$/ }).boundingBox();
          const wallet = await header.locator(".button-wallet").boundingBox();
          const last = await icons.last().boundingBox();
          say(last !== null && toggle !== null && wallet !== null && last.x + last.width <= toggle.x && toggle.x + toggle.width <= wallet.x, "the header's order is not icons, theme, wallet");
          // Under the pointer an icon takes the full text colour.
          await icons.first().hover();
          await page.waitForTimeout(200);
          const text = await page.evaluate(() => getComputedStyle(document.body).color);
          say((await icons.first().evaluate((link) => getComputedStyle(link).color)) === text, "under the pointer an icon does not take the text colour");
          await page.mouse.move(0, 0);
          // Nothing is set on this server: each icon leads to the address it starts with (DexScreener's front page, the
          // project's repository, its account on X), in a new tab, telling the other site nothing of where the visitor came from.
          say(JSON.stringify(drawn.map((icon) => icon.href)) === JSON.stringify(["https://dexscreener.com/", "https://github.com/IntentSwap/INT", "https://x.com/intentswap_"]), `with nothing set the icons lead to ${JSON.stringify(drawn.map((icon) => icon.href))}`);
          const how = await icons.evaluateAll((links) => links.map((link) => `${link.getAttribute("target")} ${link.getAttribute("rel")}`));
          say(how.every((value) => value === "_blank noopener noreferrer"), `the icons open as ${JSON.stringify(how)}`);
          await page.evaluate(() => window.scrollTo(0, 0));
        } else {
          // On a phone they are a row at the foot of the menu.
          await page.getByRole("button", { name: "Menu" }).tap();
          const menu = page.getByRole("dialog", { name: "Menu" });
          await menu.waitFor();
          await page.waitForTimeout(350);
          const row = menu.locator('.social[data-where="menu"] .social-link');
          say(JSON.stringify(await row.evaluateAll((links) => links.map((link) => link.getAttribute("aria-label")))) === JSON.stringify(NAMES_OF_ICONS), "the menu does not end with the three icons");
          const sizes = await row.evaluateAll((links) => links.map((link) => `${link.getBoundingClientRect().width}x${link.getBoundingClientRect().height}`));
          say(sizes.every((size) => size === "44x44"), `on a touch screen the icons are ${JSON.stringify(sizes)} to press, not 44x44`);
          const lastLine = await menu.locator(".menu-link").last().boundingBox();
          const rowBox = await row.first().boundingBox();
          say(lastLine !== null && rowBox !== null && rowBox.y >= lastLine.y + lastLine.height, "the icons are not at the foot of the menu");
          await page.screenshot({ path: path.join(out, `header-menu-${width}-${theme}.png`), fullPage: false });
          shots += 1;
          for (const problem of await axeProblems(page)) complaints.push(`${where} (menu): ${problem}`);
          await page.keyboard.press("Escape");
          await menu.waitFor({ state: "detached" });
        }
        // The pointer is parked well away first, so the three marks are photographed at rest.
        await page.mouse.move(8, 400);
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(out, `header-${width}-${theme}.png`), clip: { x: 0, y: 0, width, height: 80 } });
        shots += 1;
        // The footer has the same three, and no status line: no "Service is running" and no dot.
        const footer = page.locator("footer.footer");
        await footer.scrollIntoViewIfNeeded();
        say(JSON.stringify(await footer.locator(".social .social-link").evaluateAll((links) => links.map((link) => link.getAttribute("aria-label")))) === JSON.stringify(NAMES_OF_ICONS), "the footer does not have the three icons");
        say((await footer.locator(".status, .status-dot").count()) === 0 && !/Service is running|service is slow|Swaps are paused/i.test(await footer.innerText()), "the footer still shows the service's status");
        // Everything that comes up on scrolling has come up before the page is judged.
        await seeAll(page);
        await footer.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await footer.screenshot({ path: path.join(out, `footer-${width}-${theme}.png`) });
        shots += 1;
        for (const problem of await axeProblems(page)) complaints.push(`${where}: ${problem}`);

        // With the three addresses set (as the server sends them once the operator has set them): each icon leads there, in a new tab, and tells the other site nothing.
        if (theme === "dark") {
          await page.route("**/api/config", async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, json: { ...((await response.json()) as Record<string, unknown>), ...SET } });
          });
          await visit(page, new URL("/", baseUrl).toString());
          await page.locator('footer .social-link[href]').first().waitFor({ timeout: 20_000 });
          const set = await page.locator("footer .social-link").evaluateAll((links) => links.map((link) => `${link.getAttribute("href")} ${link.getAttribute("target")} ${link.getAttribute("rel")}`));
          say(JSON.stringify(set) === JSON.stringify([SET.dexscreenerUrl, SET.githubUrl, SET.xUrl].map((href) => `${href} _blank noopener noreferrer`)), `with addresses set the footer's icons are ${JSON.stringify(set)}`);
          if (inHeader) {
            const top = await icons.evaluateAll((links) => links.map((link) => `${link.getAttribute("href")} ${link.getAttribute("target")} ${link.getAttribute("rel")}`));
            say(JSON.stringify(top) === JSON.stringify(set), `with addresses set the header's icons are ${JSON.stringify(top)}`);
          }
          await seeAll(page);
          for (const problem of await axeProblems(page)) complaints.push(`${where} (addresses set): ${problem}`);
        }
      } catch (error) {
        complaints.push(`${where}: ${(error as Error).message.split("\n")[0]}`);
      }
      await context.close();
    }
  }
  return { complaints, shots };
}
