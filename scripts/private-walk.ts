// Private routing, walked in a real browser on two practice servers: one where the server's setting
// is private (PRIVACY_MODE=basic) and one where it is public. Nothing real is routed anywhere: the
// practice provider stands in, and refuses private routing for anything delivered on Zcash, so that
// the "not available" path can be walked. Used by scripts/review-shots.ts (walk name: private).
//
// What the walk proves, with private routing in force:
//   - the site says so, in its set words: the headline, the first item of the stage, "What
//     private means here" in three rows in place of the line about public swaps, a Docs page;
//     and it uses none of the words it must never use;
//   - the card carries a small "Private" tag; the quote's breakdown says how the swap is routed and
//     gives IntentSwap's fee as "None", the provider's in figures and the points, as for any swap; the
//     review and the order's page say how it is routed, and the order the server holds is a private
//     one, with no fee of ours on it and the address its points go to;
//   - a private order is not found from its deposit address on the Track order page, which says so;
//   - where a private quote cannot be had the card says so plainly and offers "Swap without private
//     routing"; until that is pressed no public quote is asked for; after it, the card, the review
//     and the order's page say the swap is public by the person's own choice, and the order is;
//   - the browser cannot name the level: a request that tries is still routed as the server is set.
// And with public routing in force: none of it is on the site, anywhere, and the Docs page is not found.

import { createHash } from "node:crypto";
import path from "node:path";
import { base58 } from "@scure/base";
import type { Browser, Page } from "playwright-core";
import { axeProblems } from "./axe.ts";
import { freshSol, orderPace, seeAll, settle } from "./order-walk.ts";

export interface WalkResult {
  complaints: string[];
  shots: number;
}

const EVM = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
/** A Zcash address made up from fixed text, so it is nobody's: the two bytes that mark a transparent address, twenty bytes of a hash, and the usual check. */
const ZEC_ADDRESS = (() => {
  const body = Buffer.concat([Buffer.from([0x1c, 0xb8]), createHash("sha256").update("intentswap private walk").digest().subarray(0, 20)]);
  const check = createHash("sha256").update(createHash("sha256").update(body).digest()).digest().subarray(0, 4);
  return base58.encode(Buffer.concat([body, check]));
})();

/** Words the site never uses, in either mode. (The two that may appear only to be denied, and the one the Docs page explains the difference from, are looked for where they are allowed.) */
const NEVER = [/untraceable/i, /invisible/i, /hidden from authorities/i, /can(?:not|'t) be (?:traced|matched|linked)/i, /\banonymous(?:ly)?\b/i];

export async function privateWalk(browser: Browser, options: { privateUrl: string; publicUrl: string; out: string; visit(page: Page, url: string): Promise<void> }): Promise<WalkResult> {
  const complaints: string[] = [];
  let shots = 0;
  const { privateUrl, publicUrl, out, visit } = options;
  const made: string[] = [];

  for (const [width, theme] of [[1280, "dark"], [360, "light"], [1280, "light"], [360, "dark"]] as const) {
    const label = `private ${width} ${theme}`;
    const say = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const mobile = width < 768;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 780 : 900 }, deviceScaleFactor: 2, colorScheme: theme, hasTouch: mobile, isMobile: mobile });
    await context.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "${theme}"; });`);
    const page = await context.newPage();
    const quotes: Record<string, unknown>[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/quote") quotes.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
    });
    page.on("console", (message) => {
      // One answer of "not found" is meant: a private order looked for by its deposit address (the browser notes every such answer).
      if (/status of 404/.test(message.text()) && new URL(message.location().url).pathname === "/api/track") return;
      if (message.type() === "error" || message.type() === "warning") complaints.push(`${label}: ${message.type()}: ${message.text().slice(0, 240)} (${message.location().url})`);
    });
    page.on("pageerror", (error) => complaints.push(`${label}: page error: ${error.message}`));
    const shoot = async (name: string, whole = false) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, `private-${name}-${width}-${theme}.png`), fullPage: whole });
      shots += 1;
      for (const problem of await axeProblems(page)) complaints.push(`${label} ${name}: ${problem}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      say(overflow <= 0, `${name}: the page scrolls sideways by ${overflow}px`);
    };
    const full = width === 1280 && theme === "dark";

    try {
      const config = (await (await fetch(new URL("/api/config", privateUrl))).json()) as { privacyMode?: string };
      say(config.privacyMode === "basic", `the server that is set to private tells the page "${config.privacyMode}"`);

      // ---- What the site says ----
      await visit(page, new URL("/", privateUrl).toString());
      await page.locator(".card").waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1200);
      const headline = (await page.locator(".hero .headline-title").innerText()).replace(/\s+/g, " ").trim();
      say(headline === "Private swaps, across chains. Built on NEAR Intents.", `the headline reads "${headline}"`);
      say((await page.title()) === "IntentSwap: private swaps, across chains", `the page's title is "${await page.title()}"`);
      await shoot("hero");
      say((await page.locator(".stage-tab-title").first().innerText()).trim() === "Private cross-chain swaps", `the stage's first item is "${(await page.locator(".stage-tab-title").first().innerText()).trim()}"`);
      const section = page.locator("section", { has: page.getByRole("heading", { name: "What private means here" }) }).first();
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(900);
      const rows = (await section.innerText()).replace(/\s+/g, " ");
      for (const part of ["Still public", "Not public", "Who can see it", "not tied to each other in public records", "Private routing is not anonymity and no route guarantees it"]) say(rows.includes(part), `"What private means here" does not say "${part}"`);
      say(!/this is not a privacy tool/i.test(await page.locator("main#main").innerText()), "the line about public swaps is still on the private site");
      await section.screenshot({ path: path.join(out, `private-means-${width}-${theme}.png`) });
      shots += 1;
      await seeAll(page);
      const home = await page.locator("main#main").evaluate((main) => main.textContent ?? "");
      for (const word of NEVER) say(!word.test(home), `the home page uses a word it must never use (${String(word)})`);
      say(!/\bmixer\b/i.test(home) && !/guarantee[sd]?\b/i.test(home.replace(/no route guarantees it/gi, "")), "the home page speaks of a mixer, or of a guarantee other than to deny one");
      for (const problem of await axeProblems(page)) complaints.push(`${label} home: ${problem}`);

      // The Docs page, in the contents and at its own address.
      await visit(page, new URL("/docs/private", privateUrl).toString());
      await page.getByRole("heading", { name: "Private routing", level: 1 }).waitFor({ timeout: 20_000 });
      const docs = await page.locator(".docs-body").evaluate((body) => body.textContent ?? "");
      for (const word of NEVER) say(!word.test(docs.replace(/is not anonymity|not anonymous/gi, "")), `the Docs page on private routing uses a word it must never use (${String(word)})`);
      for (const part of [/mixer/i, /shielded/i, /screen/i, /not anonymity/i]) say(part.test(docs), `the Docs page on private routing says nothing of ${String(part)}`);
      say((await page.locator(".docs-page-link", { hasText: "Private routing" }).count()) >= 1, "the Docs' contents do not list Private routing");
      await seeAll(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await shoot("docs", true);

      // ---- The card: a private quote ----
      quotes.length = 0;
      await visit(page, new URL("/?amount=0.5", privateUrl).toString());
      await page.locator(".card-tools").waitFor({ timeout: 20_000 });
      say((await page.locator(".card-tools .routing-tag").count()) === 0, "the card carries a Private tag");
      await page.locator(".quote-rate").first().waitFor({ timeout: 30_000 });
      say(quotes.length > 0 && quotes.every((body) => !("withoutPrivate" in body) && !("confidentiality" in body) && !("routing" in body)), `the page sent something about routing with an ordinary quote: ${JSON.stringify(quotes.at(-1))}`);
      await page.locator("button.quote-summary").click();
      const routingRow = page.locator('.quote-row[data-row="routing"]');
      await routingRow.waitFor({ timeout: 5000 });
      say((await routingRow.locator("dd").innerText()).trim() === "Private", `the breakdown's routing reads "${(await routingRow.locator("dd").innerText()).trim()}"`);
      const feeRow = (await page.locator(".quote-row", { hasText: "IntentSwap fee" }).innerText()).replace(/\s+/g, " ");
      // No fee of ours, and the provider's in figures, as the provider's answer held them: 0.20% on the practice provider.
      say(/None/.test(feeRow) && !/%/.test(feeRow), `on a private quote the IntentSwap fee row reads "${feeRow}"`);
      const providerRow = (await page.locator(".quote-row", { hasText: "Provider fee" }).innerText()).replace(/\s+/g, " ");
      say(/0\.20%/.test(providerRow), `on a private quote the provider's fee row reads "${providerRow}"`);
      // And its points, as on any quote: a row in the breakdown, with a figure.
      const pointsRow = page.locator(".quote-row", { hasText: /^Points/ });
      say((await pointsRow.count()) === 1 && /\d/.test(await pointsRow.innerText().catch(() => "")), "a private quote is not shown as adding points");
      say(!/adds no points/i.test(await page.locator(".card").innerText()), "the card says a private swap adds no points");
      await page.waitForTimeout(350);
      await page.locator(".card").scrollIntoViewIfNeeded();
      await shoot("card");

      // ---- The review and the order: private ----
      if (full || (width === 360 && theme === "light")) {
        await page.getByRole("button", { name: "Pay without connecting" }).click();
        await page.getByLabel(/Receiving address/).fill(freshSol());
        await page.getByLabel(/Refund address/).fill(EVM);
        await page.getByRole("button", { name: "Review swap" }).click({ timeout: 40_000 });
        const review = page.getByRole("dialog", { name: "Review swap" });
        await review.waitFor();
        await page.waitForTimeout(350);
        say(/Routed privately\.$/.test((await review.locator(".review-sentence").first().innerText()).trim()), `the review's sentence reads "${(await review.locator(".review-sentence").first().innerText()).trim()}"`);
        say((await review.locator('.review-row[data-row="routing"] .routing-tag').innerText().catch(() => "")).trim() === "Private", "the review does not show the swap as privately routed");
        // No fee of ours, the provider's in figures, and somewhere for its points to go, as for any swap.
        const reviewed = (await review.innerText()).replace(/\s+/g, " ");
        say(/IntentSwap fee None/.test(reviewed) && /Provider fee [^%]*0\.20%/.test(reviewed), `the review of a private swap does not give its fees as the quote held them: "${reviewed.slice(0, 600)}"`);
        const rewards = review.getByLabel(/Rewards address/);
        say((await rewards.count()) === 1, "the review of a private swap has no field for a rewards address");
        await rewards.fill(EVM);
        await shoot("review");
        await review.getByRole("checkbox").check();
        await orderPace();
        await review.getByRole("button", { name: "Confirm swap" }).click();
        await page.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
        const id = new URL(page.url()).pathname.split("/").pop() ?? "";
        made.push(id);
        await page.getByRole("heading", { name: "Send your deposit" }).waitFor({ timeout: 15_000 });
        say((await page.locator(".order-title-row .routing-tag").innerText().catch(() => "")).trim() === "Private", "the order's page does not carry the Private tag");
        const order = (await (await fetch(new URL(`/api/orders/${id}`, privateUrl))).json()) as { routing?: string; fees?: { appBps?: number; providerBps?: number }; rewardsAddress?: string | null; depositAddress?: string | null };
        say(order.routing === "confidential" && order.fees?.appBps === 0 && order.fees?.providerBps === 20, `the order the server holds is routed "${order.routing}" with a fee of ours of ${order.fees?.appBps} and the provider's of ${order.fees?.providerBps}`);
        say(order.rewardsAddress === EVM, `the private order's points go to "${order.rewardsAddress}"`);
        await shoot("order");

        // A private order is not found from its deposit address: that would publish the link between its two ends.
        await visit(page, new URL("/track", privateUrl).toString());
        say((await page.locator(".focus-lead").innerText()).includes("A privately routed order opens from its link or ID only."), "the Track order page does not say that a private order opens from its link or ID only");
        await page.locator("#track-input").fill(order.depositAddress ?? "");
        await page.locator("#track-input").press("Enter");
        const answer = page.locator(".track-form [role=alert], .track-form [role=status], .track-message").first();
        await page.waitForTimeout(1500);
        say(new URL(page.url()).pathname === "/track", `a private order's deposit address led to ${new URL(page.url()).pathname}`);
        say(/No order matches that/.test(await page.locator(".focus-stage").innerText()), `looking a private order up by its deposit address answered "${(await answer.innerText().catch(() => "")).trim()}"`);
        // By its ID it opens, as it does from its link.
        await page.locator("#track-input").fill(id);
        await page.locator("#track-input").press("Enter");
        await page.waitForURL(new RegExp(`/order/${id}$`), { timeout: 15_000 }).catch(() => say(false, "a private order did not open from its ID on the Track order page"));
        await shoot("track");
      }

      // ---- Where private routing cannot be had: said plainly, and an explicit choice ----
      quotes.length = 0;
      await visit(page, new URL("/?to=zec:ZEC&amount=0.5", privateUrl).toString());
      const choice = page.locator(".card-submit .button-primary", { hasText: "Swap without private routing" });
      await choice.waitFor({ timeout: 30_000 });
      say(((await page.locator(".card-message").innerText()).trim()) === "Private routing is not available for this swap right now.", `the card's message reads "${(await page.locator(".card-message").innerText()).trim()}"`);
      await page.waitForTimeout(2500);
      say(quotes.length > 0 && quotes.every((body) => body.withoutPrivate !== true), "a public quote was asked for before the person chose one");
      say((await page.locator(".quote-rate").count()) === 0, "a quote is on show although private routing could not be had and nothing was chosen");
      const choiceBox = await choice.boundingBox();
      say(choiceBox !== null && choiceBox.height <= 49, `"Swap without private routing" takes more than one line (${Math.round(choiceBox?.height ?? 0)} px)`);
      await page.locator(".card").scrollIntoViewIfNeeded();
      await shoot("unavailable");
      await choice.click();
      await page.locator(".quote-rate").first().waitFor({ timeout: 30_000 });
      say(quotes.at(-1)?.withoutPrivate === true, `after the choice the quote was asked with ${JSON.stringify(quotes.at(-1))}`);
      say((await page.locator(".card-tools .routing-tag").count()) === 0, "the card still carries the Private tag for a swap routed in public");
      const back = page.getByRole("button", { name: "Use private routing" });
      say(await back.isVisible(), 'the card does not offer "Use private routing" once public routing was chosen');
      await page.locator("button.quote-summary").click();
      say((await page.locator('.quote-row[data-row="routing"] dd').innerText()).trim() === "Public, by your choice", `the breakdown's routing reads "${(await page.locator('.quote-row[data-row="routing"] dd').innerText()).trim()}"`);
      await page.locator(".card").scrollIntoViewIfNeeded();
      await shoot("by-choice");
      if (full) {
        await page.getByRole("button", { name: "Pay without connecting" }).click();
        await page.getByLabel(/Receiving address/).fill(ZEC_ADDRESS);
        await page.getByLabel(/Refund address/).fill(EVM);
        await page.getByRole("button", { name: "Review swap" }).click({ timeout: 40_000 });
        const review = page.getByRole("dialog", { name: "Review swap" });
        await review.waitFor();
        say(((await review.locator('.review-row[data-row="routing"] dd').innerText()).trim()) === "Public, by your choice", "the review does not say the swap is public by the person's choice");
        say(!/Routed privately/.test(await review.innerText()), "the review calls a public swap privately routed");
        await review.getByRole("checkbox").check();
        await orderPace();
        await review.getByRole("button", { name: "Confirm swap" }).click();
        await page.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
        const id = new URL(page.url()).pathname.split("/").pop() ?? "";
        made.push(id);
        await page.getByRole("heading", { name: "Send your deposit" }).waitFor({ timeout: 15_000 });
        say((await page.locator(".order-title-row .routing-tag").count()) === 0, "a public order's page carries the Private tag");
        const order = (await (await fetch(new URL(`/api/orders/${id}`, privateUrl))).json()) as { routing?: string };
        say(order.routing === "public", `the order made by the person's choice of public is routed "${order.routing}"`);
        // Taking the choice back brings private routing, and its refusal, back.
        await visit(page, new URL("/?to=zec:ZEC&amount=0.5", privateUrl).toString());
        await page.locator(".card-submit .button-primary", { hasText: "Swap without private routing" }).waitFor({ timeout: 30_000 });
        say((await page.locator(".card-tools .routing-switch").count()) === 0, "a new swap does not start out private again after one was made in public");
      }

      // ---- The browser cannot name the level ----
      if (full) {
        const session = ((await (await fetch(new URL("/api/config", privateUrl))).json()) as { session: string }).session;
        const asked = await fetch(new URL("/api/quote", privateUrl), {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": session, origin: new URL(privateUrl).origin },
          body: JSON.stringify({ from: "nep141:base.omft.near", to: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", amount: "500000000000000000", pay: "manual", confidentiality: "public", routing: "public", privacy: "off", withoutPrivate: "yes" }),
        });
        const answer = (await asked.json()) as { routing?: string };
        say(answer.routing === "confidential", `a request that named its own level was routed "${answer.routing}"`);
      }
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
      await page.screenshot({ path: path.join(out, "failures", `stuck-private-${width}-${theme}.png`) }).catch(() => undefined);
    }
    await context.close();
  }

  // ---- With public routing in force: none of it ----
  {
    const label = "private (public server)";
    const say = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    const page = await context.newPage();
    let missing = false;
    page.on("console", (message) => {
      if ((message.type() === "error" || message.type() === "warning") && !(missing && /status of 404/.test(message.text()))) complaints.push(`${label}: ${message.type()}: ${message.text().slice(0, 240)}`);
    });
    try {
      const config = (await (await fetch(new URL("/api/config", publicUrl))).json()) as { privacyMode?: string };
      say(config.privacyMode === "public", `the server that is set to public tells the page "${config.privacyMode}"`);
      for (const address of ["/", "/?amount=0.5", "/docs", "/docs/safety", "/docs/rewards", "/docs/faq", "/terms", "/privacy", "/track", "/rewards"]) {
        await visit(page, new URL(address, publicUrl).toString());
        await page.waitForTimeout(900);
        if (address === "/?amount=0.5") await page.locator(".quote-rate").first().waitFor({ timeout: 30_000 });
        const text = await page.locator("body").evaluate((body) => body.textContent ?? "");
        // The Privacy Policy keeps its name, and the header and footer link to it by that name.
        const said = text.replace(/Privacy Policy|\bPrivacy\b/g, "").match(/\bprivate(?:ly)?\b|confidential|privacy tool|private routing/gi) ?? [];
        const allowed = said.filter((word) => !/privacy tool/i.test(word));
        say(allowed.length === 0, `${address}: a site that routes in public speaks of "${[...new Set(allowed)].join('", "')}"`);
        say((await page.locator(".routing-tag, .routing-switch, [data-row='routing']").count()) === 0, `${address}: a site that routes in public shows a routing tag, switch or row`);
      }
      await visit(page, new URL("/", publicUrl).toString());
      say((await page.locator(".hero .headline-title").innerText()).replace(/\s+/g, " ").trim() === "Swap anything. On NEAR Intents.", "the public site's headline is not the public one");
      say((await page.title()) === "IntentSwap", `the public site's title is "${await page.title()}"`);
      missing = true;
      const reply = await page.goto(new URL("/docs/private", publicUrl).toString());
      say(reply?.status() === 404, `on the public site the Docs page on private routing answers ${reply?.status()}`);
      await page.getByRole("heading", { name: "Page not found." }).waitFor({ timeout: 15_000 });
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    }
    await context.close();
  }
  for (const id of made) await settle(privateUrl, id);
  return { complaints, shots };
}
