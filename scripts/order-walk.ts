// The order page and the whole flow, walked in a real browser against the practice server
// (pretend orders only). Used by scripts/review-shots.ts (walk name: order).
//
// What the walk proves:
//   - quote, review, order and deposit details can all be reached and worked by keyboard alone,
//     on a phone-sized screen;
//   - the order page works from its address alone: after a reload, and in a browser that has
//     never seen the order;
//   - when the connection drops the page says "Reconnecting…" and keeps what it last knew;
//   - every ending is reached, says what happened, and is there again from its address alone:
//     delivered, deposit too small, refunded, failed and (with the practice clock moved on) expired;
//   - a deposit that needs a memo shows it, and deposit details close two minutes before the deadline;
//   - the list of recent orders is kept in this browser only, and "Clear history" empties it;
//   - an address that is no order answers "Order not found".

import { randomBytes } from "node:crypto";
import path from "node:path";
import { base58 } from "@scure/base";
import type { Browser, Locator, Page } from "playwright-core";
import { axeProblems } from "./axe.ts";

// Made up from fixed text, so they are nobody's.
const EVM = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
const STELLAR = "GAQMXQJ2UFA5ECB2JJ3GUYQF46ROPVINVWAMN7KNR3OAMDHLQ46LFRBW";

export interface WalkResult {
  complaints: string[];
  shots: number;
}

/**
 * A Solana address that is no one's, new each time it is asked for. The server allows only so many
 * orders an hour to one receiving address, as it should; a run of these walks makes more than that,
 * so every order a walk makes is sent to an address of its own.
 */
export const freshSol = (): string => base58.encode(randomBytes(32));

/**
 * Looks at the header as it is drawn: nothing in it may run past its edge, be cut short, or be
 * squeezed (a button under 44 px wide has been). Returns what is wrong, or null.
 */
export function headerFits(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const header = document.querySelector(".header");
    if (header === null) return "there is no header";
    const edge = header.getBoundingClientRect().right;
    for (const el of header.querySelectorAll<HTMLElement>(".wordmark, .wordmark-text, .header-actions > *")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0) continue;
      const what = (el.getAttribute("aria-label") ?? el.textContent ?? el.className).trim().slice(0, 24);
      if (box.right > edge + 0.5) return `"${what}" runs past the header's edge`;
      if (el.scrollWidth > el.clientWidth + 1) return `"${what}" is cut short`;
      if (el.matches("button") && box.width < 44 - 0.5) return `the button "${what}" is ${Math.round(box.width)} px wide`;
    }
    return null;
  });
}

const confirmedAt: number[] = [];
/**
 * Waits, if need be, before a walk confirms an order. The server lets one visitor make six orders
 * a minute, as it should; these walks press Confirm faster than a person would, all from one
 * address. Rather than be refused, a walk about to make a sixth order inside a minute waits until
 * the first of them is more than a minute old.
 */
export async function orderPace(): Promise<void> {
  const WINDOW_MS = 65_000;
  while (confirmedAt.length > 0 && Date.now() - (confirmedAt[0] ?? 0) > WINDOW_MS) confirmedAt.shift();
  if (confirmedAt.length >= 5) {
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS - (Date.now() - (confirmedAt[0] ?? 0))));
    confirmedAt.shift();
  }
  confirmedAt.push(Date.now());
}

/**
 * Ends a pretend order that a walk would otherwise leave unpaid. The server limits how many unpaid
 * orders one visitor may have open; a walk that leaves its orders lying about would, a few runs
 * later, be refused new ones.
 */
export async function settle(practiceUrl: string, id: string): Promise<void> {
  if (id === "") return;
  await fetch(new URL(`/api/practice/${id}`, practiceUrl), { method: "POST", headers: { "content-type": "application/json", origin: new URL(practiceUrl).origin }, body: JSON.stringify({ action: "fail" }) }).catch(() => undefined);
}

/**
 * Presses one of the controls that move a practice order along ("Pay in full", "Refund" and so on).
 * They are folded away at the foot of a practice order, under "Test controls": the fold is opened first.
 */
export async function testControl(page: Page, name: string): Promise<void> {
  const fold = page.locator("details.order-practice");
  await fold.waitFor({ timeout: 15_000 });
  if (!(await fold.evaluate((element) => (element as HTMLDetailsElement).open))) await fold.locator("summary").click();
  await page.getByRole("button", { name, exact: true }).click();
}

/**
 * Scrolls through the whole page and back to its top. Parts of a page come into view as they are
 * scrolled to, once; after this they all have, so the page can be photographed and checked whole.
 */
export async function seeAll(page: Page): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = Math.max(300, Math.floor((page.viewportSize()?.height ?? 800) * 0.7));
  for (let y = 0; y <= height; y += step) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await page.waitForTimeout(100);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  // The longest entrance, and the stagger of the last of its children.
  await page.waitForTimeout(1000);
}

/** Presses Tab until the control has the focus. Fails if the keyboard never gets there. */
async function tabTo(page: Page, target: Locator, what: string, limit = 80): Promise<void> {
  for (let presses = 0; presses <= limit; presses++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`the keyboard never reached ${what}`);
}

export async function orderWalk(browser: Browser, options: { practiceUrl: string; out: string; visit(page: Page, url: string): Promise<void> }): Promise<WalkResult> {
  const complaints: string[] = [];
  let shots = 0;
  const { practiceUrl, out, visit } = options;
  const label = "order";
  const expectThat = (ok: boolean, what: string) => {
    if (!ok) complaints.push(`${label}: ${what}`);
  };

  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, colorScheme: "dark", permissions: ["clipboard-read", "clipboard-write"] });
  await context.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "dark"; });`);
  const page = await context.newPage();
  // While the connection is cut on purpose, the browser's own complaints about it are expected.
  // So is its note of the "not found" answer when an address that is no order is opened on purpose.
  let cut = false;
  let missing = false;
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    if (cut && /Failed to load resource|net::ERR/.test(message.text())) return;
    if (missing && /status of 404/.test(message.text())) return;
    complaints.push(`${label}: ${message.type()}: ${message.text().slice(0, 300)}`);
  });
  page.on("pageerror", (error) => complaints.push(`${label}: page error: ${error.message}`));
  const shoot = async (name: string) => {
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate(`document.documentElement.dataset.theme = "${theme}"`);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(out, `order-${name}-360-${theme}.png`), fullPage: false });
      shots += 1;
      // Every accessibility rule, on each screen photographed, in each theme.
      for (const problem of await axeProblems(page)) complaints.push(`order ${name} ${theme}: ${problem}`);
    }
    await page.evaluate(`document.documentElement.dataset.theme = "dark"`);
    // An order's title is one line on a phone, also with the longest amount a title gives (twelve characters).
    const lines = await page.evaluate(() => {
      const title = document.querySelector("#order-title");
      return title === null ? 1 : Math.round(title.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(title).lineHeight));
    });
    if (lines > 1) complaints.push(`order ${name}: the order's title takes ${lines} lines on a phone`);
  };

  /** Makes a pretend order with the mouse and lands on its page. Returns the order's ID. */
  const makeOrder = async (amount = "0.5"): Promise<string> => {
    await visit(page, new URL(`/?amount=${amount}`, practiceUrl).toString());
    await page.getByRole("button", { name: "Pay without connecting" }).click();
    await page.getByLabel(/Receiving address/).fill(freshSol());
    await page.getByLabel(/Refund address/).fill(EVM);
    await page.getByRole("button", { name: "Review swap" }).click({ timeout: 40_000 });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox").check();
    await orderPace();
    await dialog.getByRole("button", { name: "Confirm swap" }).click();
    await page.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
    return new URL(page.url()).pathname.split("/").pop() ?? "";
  };
  const ending = (headline: string) => page.locator(".order-ending-headline", { hasText: headline });
  // Every order this walk opens, noted as its page is reached. Whatever is still unpaid at the end
  // (one it leaves on purpose, or any it never got to finish because a step failed) is settled then.
  const unpaid: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const id = /^\/order\/([A-Za-z0-9_-]{20,})$/.exec(new URL(frame.url()).pathname)?.[1];
    if (id !== undefined && !unpaid.includes(id)) unpaid.push(id);
  });
  /** An ending must be there again from the order's address alone: after a reload, and in a browser that never saw the order. */
  const reopened = async (headline: string) => {
    const address = page.url();
    await visit(page, address);
    await ending(headline).waitFor({ timeout: 15_000 }).catch(() => expectThat(false, `after a reload the order no longer shows "${headline}"`));
    const other = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const elsewhere = await other.newPage();
    await visit(elsewhere, address);
    await elsewhere
      .locator(".order-ending-headline", { hasText: headline })
      .waitFor({ timeout: 15_000 })
      .catch(() => expectThat(false, `in another browser the order does not show "${headline}"`));
    await other.close();
  };

  try {
    // ---- The whole flow by keyboard alone, on a phone-sized screen ----
    await visit(page, new URL("/", practiceUrl).toString());
    await tabTo(page, page.getByLabel("You pay", { exact: false }).and(page.locator("input")), "the amount field");
    await page.keyboard.type("0.5");
    await tabTo(page, page.getByRole("button", { name: "Pay without connecting" }), '"Pay without connecting"');
    await page.keyboard.press("Enter");
    // The two address fields come before that button in the page: go back up to them.
    await page.getByLabel(/Receiving address/).waitFor();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await tabTo(page, page.getByLabel(/Receiving address/), "the receiving address");
    await page.keyboard.type(freshSol());
    await tabTo(page, page.getByLabel(/Refund address/), "the refund address");
    await page.keyboard.type(EVM);
    const review = page.getByRole("button", { name: "Review swap" });
    await review.waitFor({ timeout: 40_000 });
    await tabTo(page, review, '"Review swap"');
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await tabTo(page, dialog.getByRole("checkbox"), "the Terms tick-box");
    await page.keyboard.press("Space");
    const confirm = dialog.getByRole("button", { name: "Confirm swap" });
    await orderPace();
    await tabTo(page, confirm, '"Confirm swap"');
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
    const first = new URL(page.url()).pathname.split("/").pop() ?? "";
    const sending = page.getByLabel("I'm sending on Base");
    await sending.waitFor({ timeout: 15_000 });
    await tabTo(page, sending, "the deposit tick-box");
    await page.keyboard.press("Space");
    await page.locator(".qr").waitFor({ timeout: 5000 });
    await tabTo(page, page.getByRole("button", { name: "Copy the deposit address" }), "the address's Copy button");

    // What a Copy button puts on the clipboard is the plain value, whatever the screen shows.
    const made = (await (await fetch(new URL(`/api/orders/${first}`, practiceUrl))).json()) as { depositAddress: string };
    const copied = async (button: string) => {
      await page.getByRole("button", { name: button }).click();
      await page.waitForTimeout(150);
      return page.evaluate(() => navigator.clipboard.readText());
    };
    expectThat((await copied("Copy the deposit address")) === made.depositAddress, "Copy did not put the deposit address on the clipboard");
    expectThat((await page.getByRole("button", { name: "Copied the deposit address" }).count()) === 1, 'the Copy button does not say "Copied"');
    expectThat((await copied("Copy the amount")) === "0.5", `Copy put "${await page.evaluate(() => navigator.clipboard.readText())}" on the clipboard for the amount`);
    expectThat((await copied("Copy link to this order")) === new URL(`/order/${first}`, practiceUrl).toString(), "Copy link did not put this order's link on the clipboard");

    // ---- The page itself ----
    const steps = await page.locator(".order ol li").allInnerTexts();
    expectThat(steps.length === 4 && ["Waiting for deposit", "Deposit seen", "Swapping", "Delivered"].every((title, i) => (steps[i] ?? "").includes(title)), `the timeline reads ${JSON.stringify(steps.map((step) => step.split("\n")[0]))}`);
    expectThat((await page.title()).endsWith("IntentSwap"), `the tab's title is "${await page.title()}"`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shoot("waiting");

    // From its address alone: after a reload, and in a browser that has never seen it.
    await visit(page, page.url());
    await page.getByText("Waiting for deposit").first().waitFor({ timeout: 15_000 });
    const other = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const elsewhere = await other.newPage();
    await visit(elsewhere, new URL(`/order/${first}`, practiceUrl).toString());
    await elsewhere.getByText("Waiting for deposit").first().waitFor({ timeout: 15_000 });
    expectThat((await elsewhere.evaluate(() => localStorage.getItem("orders-v1") ?? "")).includes(first) === false, "opening an order's link added it to that browser's list");
    await other.close();

    // The connection drops: the page says so and keeps what it last knew. Then it comes back.
    cut = true;
    await page.route("**/api/orders/*", (route) => route.abort());
    await page.getByText(/Reconnecting…/).waitFor({ timeout: 30_000 });
    expectThat(await page.getByText("Waiting for deposit").first().isVisible(), "the last known state went away when the connection dropped");
    await page.evaluate(() => window.scrollTo(0, 0));
    await shoot("reconnecting");
    await page.unroute("**/api/orders/*");
    await page.getByText(/Reconnecting…/).waitFor({ state: "detached", timeout: 60_000 });
    cut = false;

    // ---- Each ending ----
    await testControl(page, "Pay in full");
    await page.getByText(/Swapping/).first().waitFor({ timeout: 60_000 });
    await ending("Delivered").waitFor({ timeout: 120_000 });
    expectThat(/USDT was sent to your Solana address\./.test(await page.locator(".order-ending-cause").innerText()), "the delivered order does not say what was sent where");
    expectThat(await page.getByRole("button", { name: "Swap again" }).isVisible(), 'a delivered order does not offer "Swap again"');
    expectThat((await page.title()).startsWith("Delivered"), `the tab's title of a delivered order is "${await page.title()}"`);
    expectThat((await page.locator(".qr").count()) === 0 && (await page.getByText("Send your deposit").count()) === 0, "deposit details are still on show on a delivered order");
    await page.evaluate(() => window.scrollTo(0, 0));
    await shoot("delivered");
    await reopened("Delivered");

    const second = await makeOrder();
    await testControl(page, "Pay too little");
    await ending("Deposit too small").waitFor({ timeout: 120_000 });
    expectThat(/Nothing more needs sending\./.test(await page.locator(".order-ending-cause").innerText()), "the too-small ending does not say that nothing more needs sending");
    await shoot("too-small");
    await reopened("Deposit too small");

    const third = await makeOrder();
    await testControl(page, "Refund");
    await ending("Refunded").waitFor({ timeout: 120_000 });
    expectThat(/returned to your refund address, 0xb559…35eC83, on Base\./.test(await page.locator(".order-ending-cause").innerText()), "the refunded ending does not say where the coins went back to");
    await shoot("refunded");
    await reopened("Refunded");

    // This one with a twelve-character amount, the longest an order's title gives in full.
    const fourth = await makeOrder("0.1234567891");
    expectThat((await page.locator("#order-title").innerText()).trim() === "0.1234567891 ETH to USDT", `an order of 0.1234567891 ETH is titled "${(await page.locator("#order-title").innerText()).trim()}"`);
    await testControl(page, "Fail");
    await ending("Swap failed").waitFor({ timeout: 120_000 });
    // What to keep is always said. "Contact support" is said only where a contact is published (this practice server has none).
    const failedCause = await page.locator(".order-ending-cause").innerText();
    expectThat(/Keep this page's link and your deposit transaction hash/.test(failedCause), "the failed ending does not say what to keep");
    expectThat(!/support/i.test(failedCause), 'with no contact published, the failed ending still says "contact support"');
    await shoot("failed");
    await reopened("Swap failed");

    // ---- A deposit that needs a memo: the memo is shown, and its Copy button copies it ----
    await visit(page, new URL("/?from=stellar:XLM&to=sol:USDT&amount=500", practiceUrl).toString());
    await page.getByLabel(/Receiving address/).fill(freshSol());
    await page.getByLabel(/Refund address/).fill(STELLAR);
    await page.getByRole("button", { name: "Review swap" }).click({ timeout: 40_000 });
    await page.getByRole("dialog").getByRole("checkbox").check();
    await orderPace();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm swap" }).click();
    await page.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
    const fifth = new URL(page.url()).pathname.split("/").pop() ?? "";
    const withMemo = (await (await fetch(new URL(`/api/orders/${fifth}`, practiceUrl))).json()) as { depositMemo: string | null };
    expectThat(typeof withMemo.depositMemo === "string" && withMemo.depositMemo.length > 0, "an order paid from Stellar has no memo");
    await page.getByText("Memo (required)").waitFor({ timeout: 15_000 });
    expectThat((await page.locator(".deposit").innerText()).includes("with the memo"), "the warning of a memo order does not mention the memo");
    await page.getByRole("button", { name: "Copy the memo" }).click();
    await page.waitForTimeout(150);
    expectThat((await page.evaluate(() => navigator.clipboard.readText())) === withMemo.depositMemo, "Copy did not put the memo on the clipboard");
    await shoot("memo");

    // ---- Time passes (the practice server's clock is moved forward): deposits close, then the order expires ----
    const sixth = await makeOrder();
    await page.getByLabel("I'm sending on Base").check();
    await page.locator(".qr").waitFor({ timeout: 5000 });
    await testControl(page, "Skip to deposits closed");
    await page.getByText("Deposits for this order are closed.").waitFor({ timeout: 20_000 });
    expectThat((await page.locator(".qr").count()) === 0 && (await page.getByText("Deposit address").count()) === 0, "the deposit details are still on show two minutes before the deadline");
    const closed = (await (await fetch(new URL(`/api/orders/${sixth}`, practiceUrl))).json()) as { depositAddress: string | null; status: string };
    expectThat(closed.depositAddress === null && closed.status === "waiting", "the server still gives out the deposit address two minutes before the deadline");
    await shoot("deposits-closed");
    await testControl(page, "Skip to expired");
    await ending("Expired").waitFor({ timeout: 60_000 });
    expectThat(await page.getByRole("button", { name: "Start a new swap" }).isVisible(), 'an expired order does not offer "Start a new swap"');
    expectThat((await page.locator('.step[data-state="current"]').count()) === 0, "an expired order still shows a step as under way");
    await shoot("expired");
    await reopened("Expired");

    // ---- The orders made in this browser: on the Track order page, newest first, and cleared on request ----
    const expiredOrder = page.url();
    // The header has no clock for them, and the menu no line: the list has one home.
    expectThat((await page.getByRole("button", { name: "Recent orders" }).count()) === 0, "the header still has a button for recent orders");
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog", { name: "Menu" }).waitFor();
    expectThat((await page.getByRole("dialog").getByText("Recent orders").count()) === 0, "the menu still offers recent orders");
    await page.getByRole("dialog").getByRole("link", { name: /Track order/ }).click();
    const recent = page.locator(".track-recent");
    await recent.waitFor({ timeout: 15_000 });
    await page.getByRole("heading", { name: "Orders made in this browser" }).waitFor({ timeout: 5000 });
    // Under the field, not above it.
    const fieldEnd = await page.locator(".track-form").evaluate((el) => el.getBoundingClientRect().bottom);
    const listStart = await recent.evaluate((el) => el.getBoundingClientRect().top);
    expectThat(listStart >= fieldEnd, `the list of orders starts at ${Math.round(listStart)}, above the end of the field at ${Math.round(fieldEnd)}`);
    await page.waitForTimeout(600);
    const links = await recent.locator("a.recent-row").evaluateAll((rows) => rows.map((row) => (row as HTMLAnchorElement).pathname.split("/").pop() ?? ""));
    // The six made in this walk, newest first. (A practice server adds its sample orders, which are older, after them.)
    const walked = [sixth, fifth, fourth, third, second, first];
    expectThat(JSON.stringify(links.filter((id) => walked.includes(id))) === JSON.stringify(walked) && JSON.stringify(links.slice(0, walked.length)) === JSON.stringify(walked), `the list of orders made in this browser is ${JSON.stringify(links)}`);
    expectThat((await recent.innerText()).includes("This list is kept only in this browser."), "the list does not say that it lives only in this browser");
    await shoot("recent");
    // A row opens its order.
    await recent.locator("a.recent-row").first().click();
    await page.waitForURL(new RegExp(`/order/${sixth}$`), { timeout: 15_000 });
    await page.goBack();
    await recent.waitFor({ timeout: 15_000 });
    // The page's words have come up again before anything more is done on it.
    await page.waitForTimeout(900);
    await recent.getByRole("button", { name: "Clear history" }).click();
    // With nothing to list, nothing is drawn: no heading, no empty box.
    await recent.waitFor({ state: "detached", timeout: 5000 });
    expectThat((await page.getByRole("heading", { name: "Orders made in this browser" }).count()) === 0, "with the list cleared its heading is still on the page");
    expectThat((await page.evaluate(() => localStorage.getItem("orders-v1") ?? "")).includes(first) === false, "Clear history left the orders in the browser's storage");
    await shoot("recent-empty");
    // Clearing the list changes no order: its link still opens it, as it was.
    await visit(page, expiredOrder);
    await ending("Expired").waitFor({ timeout: 15_000 }).catch(() => expectThat(false, "clearing the list changed the order behind its link"));

    // ---- No such order ----
    missing = true;
    await visit(page, new URL(`/order/${"z".repeat(27)}`, practiceUrl).toString());
    await page.getByText("Order not found.").waitFor({ timeout: 15_000 });
    await shoot("not-found");
    missing = false;

    // ---- The FAQ: reached by its link from another page, and when its link is opened directly ----
    const faq = page.getByRole("heading", { name: "Questions" });
    const faqInView = async () => {
      const box = await faq.boundingBox();
      return box !== null && box.y >= 0 && box.y < 780;
    };
    await visit(page, new URL("/terms", practiceUrl).toString());
    await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "FAQ" }).click();
    await faq.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    expectThat(new URL(page.url()).pathname === "/" && new URL(page.url()).hash === "#faq", `the FAQ link led to ${page.url()}`);
    expectThat(await faqInView(), "the FAQ link from another page did not bring the questions into view");
    await visit(page, new URL("/#faq", practiceUrl).toString());
    await faq.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);
    expectThat(await faqInView(), "opening the FAQ's link directly did not bring the questions into view");
    // A question opens and closes by keyboard.
    const question = page.locator(".faq-item summary").first();
    await question.focus();
    await page.keyboard.press("Enter");
    expectThat(await page.locator(".faq-item").first().evaluate((el) => (el as HTMLDetailsElement).open), "a question did not open with Enter");
    await shoot("faq");
  } catch (error) {
    complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    // Kept out of docs/review: a capture of a failed run is for whoever is fixing it, not part of the record.
    await page.screenshot({ path: path.join(out, "..", "..", "data", "stuck-order.png") }).catch(() => undefined);
  }
  for (const id of unpaid) await settle(practiceUrl, id);
  await context.close();
  return { complaints, shots };
}
