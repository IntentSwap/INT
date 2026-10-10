// Ghost mode, walked in a real browser against a practice server.
//
// What it holds the site to, with the mode on:
//   - on every route the page asks nothing of any address but the site's own, and none of the
//     wallet software's files is asked for;
//   - the browser is told to refuse anything else (a request to another site made from the page
//     itself fails), on a page that was switched into the mode and on one loaded in it;
//   - after a whole swap, from a quote to the order's end, the browser's storage holds the mode's
//     one flag and nothing else;
//   - the order's page says that its link is the only way back, and once the order has ended that
//     its record was deleted; the server then knows the order neither by its ID nor by its deposit
//     address, and the Stats page has no row for it while its totals count it;
//   - switching the mode on removes what wallet software left in the browser, and with "Also clear"
//     what the site itself kept; switching it off brings the ordinary site back with the orders
//     made earlier still listed.
//
// It also photographs the switch, the sheet, the swap card, an order's page, Rewards and Stats in the
// mode, at three widths in both themes.

import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { freshSol, testControl } from "./order-walk.ts";

export interface WalkResult {
  complaints: string[];
  shots: number;
}

/** Made up from fixed text, so it is nobody's: the refund address of the walk's orders. */
const REFUND = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
const FLAG = "ghost";

/**
 * The built files that hold the wallet software: those the ordinary site asks for only once Connect
 * is pressed. Found by doing just that, out of the mode, so that the list is never a guess.
 */
async function walletFiles(browser: Browser, practiceUrl: string, visit: (page: Page, url: string) => Promise<void>): Promise<Set<string>> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const asked: string[] = [];
  page.on("request", (request) => asked.push(request.url()));
  const origin = new URL(practiceUrl).origin;
  const files = () => new Set(asked.filter((url) => url.startsWith(`${origin}/assets/`) && url.split("?")[0]!.endsWith(".js")).map((url) => url.split("/").pop()!.split("?")[0]!));
  try {
    for (const route of ["/", "/track", "/rewards", "/stats", "/docs", "/docs/ghost-mode", "/terms", "/privacy"]) {
      await visit(page, new URL(route, practiceUrl).toString());
      await page.locator("footer").waitFor({ timeout: 20_000 });
      await page.waitForTimeout(500);
    }
    await visit(page, new URL("/", practiceUrl).toString());
    const without = files();
    await page.getByRole("button", { name: "Connect", exact: true }).first().click();
    await page.waitForTimeout(6000);
    return new Set([...files()].filter((name) => !without.has(name)));
  } finally {
    await context.close();
  }
}

/** Everything the browser keeps for the site, as key names: [local storage, session storage]. */
const kept = async (page: Page): Promise<[string[], string[]]> => JSON.parse(String(await page.evaluate("JSON.stringify([Object.keys(localStorage).sort(), Object.keys(sessionStorage).sort()])"))) as [string[], string[]];

export async function ghostWalk(browser: Browser, options: { practiceUrl: string; out: string; visit(page: Page, url: string): Promise<void> }): Promise<WalkResult> {
  const complaints: string[] = [];
  let shots = 0;
  const { practiceUrl, out, visit } = options;
  const origin = new URL(practiceUrl).origin;
  const wallet = await walletFiles(browser, practiceUrl, visit);
  if (wallet.size === 0) complaints.push("ghost: the check proves nothing: no built file of the wallet software was found to watch for");

  /** A context of one width and theme, with every request it makes written down. */
  const open = async (width: number, theme: "light" | "dark", inMode: boolean): Promise<{ context: BrowserContext; page: Page; asked: string[] }> => {
    const mobile = width < 768;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 780 : 900 }, deviceScaleFactor: 2, colorScheme: theme, hasTouch: mobile, isMobile: mobile });
    await context.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "${theme}"; });`);
    // A page loaded in the mode: the flag is there before the page's first byte is read.
    if (inMode) await context.addInitScript(`try { sessionStorage.setItem("${FLAG}", "on"); } catch {}`);
    const page = await context.newPage();
    const asked: string[] = [];
    page.on("request", (request) => asked.push(request.url()));
    return { context, page, asked };
  };
  const outside = (asked: readonly string[]) => asked.filter((url) => !url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:") && !url.startsWith("about:"));
  const walletAsked = (asked: readonly string[]) => asked.filter((url) => wallet.has(url.split("/").pop()?.split("?")[0] ?? ""));
  /** Presses the header's switch, which on a phone is in the menu. */
  const pressSwitch = async (page: Page) => {
    const button = page.locator("button.ghost-switch");
    if (await button.isVisible().catch(() => false)) return button.click();
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.locator("button.menu-ghost").click();
  };

  // ---- 1. Switching it on from the header: the sheet, the pill, the card, and what is cleared ----
  for (const [width, theme] of [[1280, "light"], [768, "dark"], [360, "light"], [360, "dark"], [768, "light"], [1280, "dark"]] as const) {
    const label = `ghost ${width} ${theme}`;
    const expectThat = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const { context, page, asked } = await open(width, theme, false);
    const shoot = async (name: string) => {
      await page.screenshot({ path: path.join(out, `ghost-${name}-${width}-${theme}.png`) });
      shots += 1;
    };
    try {
      await visit(page, new URL("/", practiceUrl).toString());
      await page.locator(".card").waitFor({ timeout: 20_000 });
      // What wallet software leaves behind, put there by hand: switching the mode on must take it out.
      await page.evaluate(`localStorage.setItem("@appkit/connections", '{"eip155":[{"accounts":[{"address":"${REFUND}"}]}]}'); localStorage.setItem("wagmi.store", '{"state":{"connections":{}}}');`);
      const before = await kept(page);
      await shoot("switch");
      await pressSwitch(page);
      const sheet = page.getByRole("dialog", { name: "Ghost mode" });
      await sheet.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      const said = (await sheet.innerText()).replace(/\s+/g, " ");
      for (const line of ["none of the wallet software is loaded", "asks nothing of any address but this site's own", "Nothing is kept in this browser but the switch itself", "its record is deleted from the server the moment it is delivered or refunded", "still public on their own chains"]) expectThat(said.includes(line), `the sheet does not say "${line}"`);
      expectThat(!/anonymous|untraceable/i.test(said), "the sheet uses a word it must never use");
      await shoot("sheet");
      // "Not now" changes nothing.
      await sheet.getByRole("button", { name: "Not now", exact: true }).click();
      await page.waitForTimeout(300);
      expectThat(!(await kept(page))[1].includes(FLAG) && (await page.locator("button.ghost-pill").count()) === 0, "\"Not now\" switched the mode on");
      await pressSwitch(page);
      await sheet.waitFor({ timeout: 10_000 });
      await sheet.getByRole("button", { name: "Turn on", exact: true }).click();
      await page.locator("button.ghost-pill").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      // On: the pill where Connect was, the flag and nothing new, the library's notes gone, the site's own earlier ones still there.
      expectThat((await page.getByRole("button", { name: "Connect", exact: true }).count()) === 0, "Connect is still offered in the mode");
      expectThat(await page.getByRole("button", { name: "Ghost mode is on. Turn off" }).isVisible(), "the header has no Ghost mode pill");
      expectThat((await page.evaluate("document.documentElement.dataset.ghost")) === "on", "the page is not marked as in the mode");
      const after = await kept(page);
      expectThat(JSON.stringify(after[1]) === JSON.stringify([FLAG]), `the tab keeps ${JSON.stringify(after[1])}, not the flag alone`);
      expectThat(!after[0].some((key) => /^@appkit|^wagmi|^wc@|walletconnect/i.test(key)), `what wallet software left is still in the browser: ${after[0].join(", ")}`);
      expectThat(before[0].filter((key) => !/^@appkit|^wagmi/.test(key)).every((key) => after[0].includes(key)), "switching the mode on removed what the site itself had kept, without being asked to");
      expectThat((await page.locator(".card").innerText()).includes("Ghost mode"), "the swap card carries no mark of the mode");
      const cardSays = (await page.locator(".card").innerText()).replace(/\s+/g, " ");
      expectThat(!/Pay without connecting|Connect wallet|Balance:|\bMax\b/.test(cardSays), `the card still speaks of connecting or of a balance: "${cardSays.slice(0, 160)}"`);
      await shoot("card");
      // The browser itself now refuses another site, asked from the page.
      const refused = await page.evaluate(`fetch("https://example.com/", { mode: "no-cors" }).then(() => "answered", () => "refused")`);
      expectThat(refused === "refused", "a request to another site made from a page in the mode was not refused");
      // Rewards and Stats in the mode.
      await visit(page, new URL("/rewards", practiceUrl).toString());
      await page.getByText("Sign-in is off in Ghost mode. Turn it off to see your points.").waitFor({ timeout: 15_000 }).catch(() => expectThat(false, "the Rewards page does not say that sign-in is off in the mode"));
      expectThat((await page.getByRole("button", { name: /Connect|Sign in/ }).count()) === 0, "the Rewards page still offers to connect or to sign in");
      await page.waitForTimeout(600);
      await shoot("rewards");
      await visit(page, new URL("/stats", practiceUrl).toString());
      await page.locator(".stats-tiles").waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1800);
      await shoot("stats");
      // Off again: the page loads itself, Connect is back, the flag is gone, and what was kept before is still there.
      await visit(page, new URL("/", practiceUrl).toString());
      await page.locator("button.ghost-pill").click();
      await page.getByRole("button", { name: "Connect", exact: true }).first().waitFor({ timeout: 20_000 }).catch(() => expectThat(false, "switching the mode off did not bring Connect back"));
      const off = await kept(page);
      expectThat(!off[1].includes(FLAG), "the flag is still kept after the mode was switched off");
      expectThat(before[0].filter((key) => !/^@appkit|^wagmi/.test(key)).every((key) => off[0].includes(key)), "what the site had kept before the mode is gone after it");
      // With "Also clear": everything the site kept goes too.
      await pressSwitch(page);
      await sheet.waitFor({ timeout: 10_000 });
      await sheet.getByRole("checkbox").check();
      await sheet.getByRole("button", { name: "Turn on", exact: true }).click();
      await page.locator("button.ghost-pill").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      const cleared = await kept(page);
      expectThat(cleared[0].length === 0 && JSON.stringify(cleared[1]) === JSON.stringify([FLAG]), `after "Also clear" the browser still keeps ${JSON.stringify(cleared)}`);
      // From switching on to here, nothing was asked of another site (the one refused try apart, which never left).
      const strangers = outside(asked).filter((url) => !url.startsWith("https://example.com/"));
      expectThat(strangers.length === 0, `the page asked another site for something: ${[...new Set(strangers)].slice(0, 4).join(", ")}`);
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    } finally {
      await context.close();
      // The walk is one visitor to the server, held to a visitor's limits: a breath between its rounds.
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }
  }

  // ---- 2. A page loaded in the mode: every route (in the first two rounds), and a whole swap ----
  let round = 0;
  for (const [width, theme] of [[1280, "light"], [360, "dark"], [768, "light"], [360, "light"], [768, "dark"], [1280, "dark"]] as const) {
    round += 1;
    const label = `ghost swap ${width} ${theme}`;
    const expectThat = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const { context, page, asked } = await open(width, theme, true);
    const shoot = async (name: string) => {
      await page.screenshot({ path: path.join(out, `ghost-${name}-${width}-${theme}.png`) });
      shots += 1;
    };
    const api = async (method: "GET" | "POST", address: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
      JSON.parse(
        String(
          await page.evaluate(
            `(async () => { const config = await (await fetch("/api/config")).json(); const res = await fetch(${JSON.stringify(address)}, { method: ${JSON.stringify(method)}, headers: { "content-type": "application/json", "x-session": config.session }, ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`} }); let parsed = {}; try { parsed = await res.json(); } catch {} return JSON.stringify({ status: res.status, body: parsed }); })()`,
          ),
        ),
      ) as { status: number; body: Record<string, unknown> };
    try {
      // Every route, loaded in the mode from its first byte.
      for (const route of round <= 2 ? ["/", "/track", "/rewards", "/stats", "/docs", "/docs/ghost-mode", "/docs/fees", "/terms", "/privacy", "/no-such-page"] : ["/"]) {
        await visit(page, new URL(route, practiceUrl).toString());
        await page.locator("footer").waitFor({ timeout: 20_000 });
        await page.waitForTimeout(900);
        expectThat((await page.evaluate("document.documentElement.dataset.ghost")) === "on", `${route}: the page is not in the mode`);
        expectThat((await page.locator('meta[http-equiv="Content-Security-Policy"]').count()) === 1, `${route}: the page carries no policy of its own for the mode`);
      }
      const blocked = await page.evaluate(`Promise.all([fetch("https://example.com/", { mode: "no-cors" }).then(() => "answered", () => "refused"), new Promise((resolve) => { const image = new Image(); image.onload = () => resolve("loaded"); image.onerror = () => resolve("refused"); image.src = "https://example.com/x.png"; })]).then((both) => both.join(","))`);
      expectThat(blocked === "refused,refused", `a page loaded in the mode let a request to another site through (${String(blocked)})`);

      // A whole swap: quote, review, order, payment, end.
      const stats = async () => (await api("GET", "/api/stats")).body as { totals?: { swaps?: number }; feed?: unknown[] };
      const statsBefore = await stats();
      await visit(page, new URL("/?amount=0.5", practiceUrl).toString());
      await page.getByLabel(/Receiving address/).fill(freshSol());
      await page.getByLabel(/Refund address/).fill(REFUND);
      await page.getByRole("button", { name: "Review swap" }).click({ timeout: 40_000 });
      const review = page.getByRole("dialog", { name: "Review swap" });
      await review.waitFor();
      await page.waitForTimeout(350);
      const reviewed = (await review.innerText()).replace(/\s+/g, " ");
      expectThat(reviewed.includes("Naming an address ties this swap's points to it. Leave it empty and this swap adds no points."), "the review does not say what naming a rewards address does");
      expectThat((await review.getByLabel(/Rewards address/).inputValue().catch(() => "missing")) === "", "the review's rewards address is not an empty field");
      expectThat(!reviewed.includes("will be listed on the Stats page"), "the review says the deposit will be listed, which is not so in the mode");
      await shoot("review");
      await review.getByRole("checkbox").check();
      await review.getByRole("button", { name: "Confirm swap" }).click();
      await page.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 40_000 });
      const id = new URL(page.url()).pathname.split("/").pop() ?? "";
      await page.getByText("This is the only way back to this order. It is not saved anywhere.").waitFor({ timeout: 15_000 }).catch(() => expectThat(false, "the order's page does not say that its link is the only way back"));
      expectThat(await page.getByRole("button", { name: /Copy link/ }).first().isVisible().catch(() => false), "the order's page offers no way to copy its link");
      const order = (await api("GET", `/api/orders/${id}`)).body as { ghost?: unknown; depositAddress?: string };
      expectThat(order.ghost === true, "the order made in the mode is not marked as one on the server");
      const deposit = String(order.depositAddress ?? "");
      // Not found by its deposit address, even while it runs.
      expectThat((await api("POST", "/api/track", { depositAddress: deposit })).status === 404, "an order made in the mode is found from its deposit address");
      await shoot("order");
      await testControl(page, "Pay in full");
      // It is delivered, and its record goes: the page says so, and keeps what it last showed.
      await page.getByText("This order has finished and its record has been deleted from the server.").waitFor({ timeout: 90_000 }).catch(() => expectThat(false, "the order's page never said that the record was deleted"));
      await page.waitForTimeout(500);
      await shoot("order-ended");
      const gone = await api("GET", `/api/orders/${id}`);
      expectThat(gone.status === 410 && (gone.body.error as { code?: string } | undefined)?.code === "order_deleted", `after its end the server answers ${gone.status} for the order, not that its record was deleted`);
      expectThat(!/0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{40,}|amount|depositAddress|recipient/.test(JSON.stringify(gone.body)), "the answer for a deleted order still holds something of it");
      expectThat((await api("POST", "/api/track", { depositAddress: deposit })).status === 404, "after its end the order is found from its deposit address");
      const statsAfter = await stats();
      // A practice server adds made-up swaps of its own as time passes, each with a row. Those apart, the totals are one
      // higher, and no new row is this order's: 0.5 ETH sent on Base.
      const had = new Set((statsBefore.feed ?? []).map((row) => JSON.stringify(row)));
      const fresh = (statsAfter.feed ?? []).filter((row) => !had.has(JSON.stringify(row))) as { coin?: { symbol?: string; chain?: string }; amount?: string }[];
      expectThat((statsAfter.totals?.swaps ?? 0) - (statsBefore.totals?.swaps ?? 0) - fresh.length === 1, `the totals count ${String(statsAfter.totals?.swaps)} swaps after the order, from ${String(statsBefore.totals?.swaps)} before, with ${fresh.length} made-up swap(s) added meanwhile`);
      expectThat(!fresh.some((row) => row.coin?.symbol === "ETH" && row.coin?.chain === "base" && row.amount === "500000000000000000"), "the order made in the mode has a row among the recent swaps");
      // A fresh load of the link: one notice, and nothing of the order.
      await visit(page, new URL(`/order/${id}`, practiceUrl).toString());
      await page.getByRole("heading", { name: "This order finished." }).waitFor({ timeout: 15_000 }).catch(() => expectThat(false, "a fresh load of a finished order's link does not say that it finished"));
      const notice = (await page.locator("main#main").innerText()).replace(/\s+/g, " ");
      expectThat(notice.includes("so its record was deleted when it finished") && !/0x[0-9a-fA-F]{6}|ETH|USDT|\d+\.\d+/.test(notice), `the notice for a finished order reads "${notice.slice(0, 200)}"`);
      await shoot("order-deleted");
      // After all of it: the flag, and nothing else.
      const end = await kept(page);
      expectThat(end[0].length === 0 && JSON.stringify(end[1]) === JSON.stringify([FLAG]), `after a whole swap in the mode the browser keeps ${JSON.stringify(end)}`);
      const cookies = await context.cookies();
      expectThat(cookies.length === 0, `the browser was given ${cookies.length} cookie(s)`);
      const strangers = outside(asked).filter((url) => !url.startsWith("https://example.com/"));
      expectThat(strangers.length === 0, `the page asked another site for something: ${[...new Set(strangers)].slice(0, 4).join(", ")}`);
      const software = walletAsked(asked);
      expectThat(software.length === 0, `wallet software was asked for in the mode: ${[...new Set(software)].join(", ")}`);
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    } finally {
      await context.close();
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }
  }

  return { complaints, shots };
}
