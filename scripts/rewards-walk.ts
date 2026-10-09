// Signing in on the Rewards page, walked in a real browser with a pretend wallet standing in for a
// real one. The wallet's key is made up from fixed text, so it is nobody's; it signs the one plain
// message it is shown, here in this script, and writes down everything it is asked. The server is
// the practice server, which gives whoever signs in sample points and payouts to look at.
//
// What the walk proves, on a laptop and on a phone, in both themes between them:
//   - before a sign-in the page shows the week, the way in and the rules, and no address's points;
//   - the page says what the wallet will be asked before the wallet opens, and the wallet is then
//     asked for one thing only: to sign the server's own plain message, which names this site and
//     the address in the standard sign-in layout, and says it is not a transaction. Never a
//     transfer, never an approval;
//   - a refusal in the wallet signs nobody in, and says so;
//   - signed in, the address sees its points for the week and all time, the swaps behind them and
//     its payouts; nothing on the page is about any other address but the reserve's own;
//   - signing out, or loading the page again, takes the points off the screen: the sign-in is kept
//     in the page's memory and nowhere else.
//
// Used by scripts/review-shots.ts (walk name: rewards).

import { createHash } from "node:crypto";
import path from "node:path";
import type { Browser, Page } from "playwright-core";
import { privateKeyToAccount } from "viem/accounts";
import { axeProblems } from "./axe.ts";
import { seeAll } from "./order-walk.ts";

export interface WalkResult {
  complaints: string[];
  shots: number;
}

interface Ask {
  method: string;
  params: unknown;
}

interface WalletWindow {
  __wallet: { mode: string; log: Ask[] };
  __signMessage(hex: string): Promise<string>;
}

// Made up from fixed text: a key that holds nothing and is nobody's.
const ACCOUNT = privateKeyToAccount(`0x${createHash("sha256").update("intentswap rewards walk wallet").digest("hex")}`);
/** BNB Chain, where a rewards address lives. */
const CHAIN = 56;
/** What a wallet may be asked on the Rewards page. Anything else is a failure, whatever it is. */
const ALLOWED_ASKS = new Set(["eth_requestAccounts", "eth_accounts", "eth_chainId", "net_version", "wallet_requestPermissions", "wallet_getPermissions", "wallet_revokePermissions", "personal_sign"]);

/** The pretend wallet. Plain text, because it runs in the page before anything else does. Signing is done outside the page, by this script. */
function pretendWallet(address: string): string {
  return `(() => {
    const state = { mode: "accept", log: [] };
    window.__wallet = state;
    const listeners = {};
    const refuse = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
    const provider = {
      on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); return provider; },
      removeListener(name, fn) { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); return provider; },
      async request({ method, params }) {
        state.log.push({ method, params: params === undefined ? null : JSON.parse(JSON.stringify(params)) });
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return ["${address}"];
          case "eth_chainId":
            return "0x" + (${CHAIN}).toString(16);
          case "net_version":
            return "${CHAIN}";
          case "wallet_requestPermissions":
          case "wallet_getPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "wallet_revokePermissions":
            return null;
          case "personal_sign":
            if (state.mode === "reject") throw refuse();
            return window.__signMessage(params[0]);
          default:
            throw Object.assign(new Error("Unsupported: " + method), { code: 4200 });
        }
      },
    };
    const icon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#444"/><circle cx="16" cy="16" r="6" fill="#fff"/></svg>');
    const detail = Object.freeze({ info: Object.freeze({ uuid: "2b1f6c1e-8a53-4f0e-b6a0-51c3f4a7d9e2", name: "Test Wallet", icon, rdns: "test.wallet" }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
    document.addEventListener("securitypolicyviolation", (event) => console.error("refused by the security policy: " + event.violatedDirective + " " + event.blockedURI));
  })();`;
}

export async function rewardsWalk(browser: Browser, options: { practiceUrl: string; out: string; visit(page: Page, url: string): Promise<void> }): Promise<WalkResult> {
  const complaints: string[] = [];
  let shots = 0;
  const { practiceUrl, out, visit } = options;
  const host = new URL(practiceUrl).host;
  const short = `${ACCOUNT.address.slice(0, 6)}…${ACCOUNT.address.slice(-6)}`;

  for (const [width, theme] of [[1280, "dark"], [360, "light"]] as const) {
    const label = `rewards ${width} ${theme}`;
    const expectThat = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const mobile = width < 768;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 780 : 900 }, deviceScaleFactor: 2, colorScheme: theme, hasTouch: mobile, isMobile: mobile });
    await context.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "${theme}"; });`);
    await context.addInitScript(pretendWallet(ACCOUNT.address));
    const signed: string[] = [];
    await context.exposeFunction("__signMessage", async (hex: string) => {
      signed.push(Buffer.from(hex.replace(/^0x/, ""), "hex").toString("utf8"));
      return ACCOUNT.signMessage({ message: { raw: hex as `0x${string}` } });
    });
    const page = await context.newPage();
    const answers: { url: string; body: string }[] = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/api/rewards")) void response.text().then((body) => answers.push({ url: response.url(), body })).catch(() => undefined);
    });
    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      complaints.push(`${label}: ${message.type()}: ${message.text().slice(0, 300)} (${message.location().url})`);
    });
    page.on("pageerror", (error) => complaints.push(`${label}: page error: ${error.message}`));
    const asks = () => page.evaluate(() => (window as unknown as WalletWindow).__wallet.log);
    const mode = (value: "accept" | "reject") => page.evaluate((to) => ((window as unknown as WalletWindow).__wallet.mode = to), value);
    const shoot = async (name: string) => {
      await seeAll(page);
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(out, `rewards-${name}-${width}-${theme}.png`), fullPage: true });
      shots += 1;
      for (const problem of await axeProblems(page)) complaints.push(`${label} ${name}: ${problem}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      // When it does, the complaint names what reaches past the screen's edge (the innermost such things).
      const past = overflow <= 0 ? [] : await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")].filter((el) => el.closest(".table-frame table") === null && el.getBoundingClientRect().right > window.innerWidth + 0.5 && ![...el.children].some((child) => child.closest(".table-frame table") === null && child.getBoundingClientRect().right > window.innerWidth + 0.5)).map((el) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? "").trim().slice(0, 30)}"`).slice(0, 4));
      expectThat(overflow <= 0, `${name}: the page scrolls sideways by ${overflow}px (${past.join("; ")})`);
    };

    try {
      await visit(page, new URL("/rewards", practiceUrl).toString());
      await page.getByRole("heading", { name: "Points and weekly rewards", level: 1 }).waitFor({ timeout: 20_000 });
      await page.locator(".rewards-count").waitFor({ timeout: 20_000 });

      // Before a sign-in: the way in, and nobody's points.
      expectThat((await page.locator(".rewards-points").count()) === 0, "points are shown before anyone has signed in");
      expectThat((await asks()).length === 0, "the wallet was asked something before anything was pressed");
      await page.getByText("Connect the wallet whose points you want to see. Points are shown only to the address they belong to.").waitFor({ timeout: 5000 });

      // Connect. The page then says what the wallet will be asked, before the wallet is opened for it.
      await page.getByRole("button", { name: "Connect to see your points" }).click();
      const signIn = page.getByRole("button", { name: `Sign in as ${short}` });
      await signIn.waitFor({ timeout: 40_000 });
      await page.getByText("Signing in asks your wallet to sign one plain message, to show that this address is yours. It is not a transaction: it moves nothing, approves nothing and costs no network fee.").waitFor({ timeout: 5000 });
      expectThat(!(await asks()).some((ask) => ask.method === "personal_sign"), "the wallet was asked to sign before Sign in was pressed");
      expectThat((await page.locator(".rewards-points").count()) === 0, "points are shown to a wallet that is connected but has not signed in");

      // Refused in the wallet: nobody is signed in, and the page says so.
      await mode("reject");
      await signIn.click();
      await page.getByText("Nothing was signed, so you are not signed in.").waitFor({ timeout: 20_000 });
      expectThat((await page.locator(".rewards-points").count()) === 0, "points are shown after the signature was refused");
      await signIn.waitFor({ timeout: 5000 });
      if (width === 1280) await shoot("refused");

      // Signed: the points of this address.
      await mode("accept");
      await signIn.click();
      await page.locator(".rewards-points").waitFor({ timeout: 30_000 });
      await page.getByText(`Signed in as ${short}`).waitFor({ timeout: 5000 }).catch(() => expectThat(false, "the page does not say which address is signed in"));

      // What the wallet was asked, all of it: its address and network, and the one message, twice (once refused).
      const log = await asks();
      const strangers = [...new Set(log.map((ask) => ask.method).filter((method) => !ALLOWED_ASKS.has(method)))];
      expectThat(strangers.length === 0, `the wallet was asked for something else: ${strangers.join(", ")}`);
      expectThat(log.filter((ask) => ask.method === "personal_sign").length === 2, `the wallet was asked to sign ${log.filter((ask) => ask.method === "personal_sign").length} times for one refusal and one sign-in`);
      expectThat(signed.length === 1, `${signed.length} messages were signed for one sign-in`);
      const message = signed[0] ?? "";
      const lines = message.split("\n");
      // Laid out as a "Sign-In with Ethereum" message, so that a wallet can tell which site is asking and warn when it is another.
      expectThat(lines[0] === `${host} wants you to sign in with your Ethereum account:` && lines[1] === ACCOUNT.address, `the message signed begins "${lines.slice(0, 2).join(" / ")}"`);
      expectThat(message.includes(`\nURI: ${new URL(practiceUrl).origin}\n`) && message.includes("\nVersion: 1\n") && message.includes("\nChain ID: 56\n"), "the message signed does not name this site's address, its version and BNB Chain as a sign-in message does");
      expectThat(message.includes("This is not a transaction. It moves nothing, approves nothing and costs no network fee."), "the message signed does not say that it is not a transaction");
      expectThat(/^Nonce: [0-9a-f]{32}$/m.test(message) && /^Expiration Time: \d{4}-\d\d-\d\dT/m.test(message), "the message signed carries no one-time code or no time at which it runs out");

      // Signed in: this week and all time, the swaps behind them, the payouts.
      const points = (await page.locator(".rewards-points").innerText()).trim();
      expectThat(/^[\d,]+\.\d\d$/.test(points), `this week's points read "${points}"`);
      await page.getByRole("heading", { name: "The swaps behind them" }).waitFor({ timeout: 10_000 });
      const swaps = await page.getByRole("region", { name: "Your swaps and their points" }).locator("tbody tr").count();
      expectThat(swaps >= 3, `the signed-in address is shown ${swaps} swaps`);
      await page.getByRole("heading", { name: "Your payouts" }).waitFor({ timeout: 10_000 });
      const payouts = await page.getByRole("region", { name: "Payouts to your address" }).locator("tbody tr").count();
      expectThat(payouts === 2, `the signed-in address is shown ${payouts} payouts, not the two sample weeks`);
      await page.getByRole("heading", { name: "Current pool" }).waitFor({ timeout: 10_000 });
      const pooled = (await page.locator(".rewards-pool-total").innerText()).trim();
      expectThat(/^\$[\d,]+\.\d\d$/.test(pooled), `the current pool reads "${pooled}"`);
      // Beside the address's own points: its share of the week's total, and what that share of the pool comes to.
      const part = (await page.locator(".rewards-mine").innerText()).replace(/\s+/g, " ");
      expectThat(/Your share [\d.]+% Estimated reward \$[\d,]+\.\d\d An estimate\. Your share changes as others swap, and the pool changes until the week closes\./i.test(part), `the signed-in address's share reads "${part}"`);
      // No address on the page but this one (in short) and the reserve's.
      const text = await page.locator("main#main").innerText();
      // (An address is 40 hex figures and no more: a transaction's hash, which is longer, is not one.)
      const shown = [...new Set((text.replace(/\s+/g, "").match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []).map((address) => address.toLowerCase()))];
      const reserve = ((JSON.parse(answers.find((answer) => new URL(answer.url).pathname === "/api/rewards")?.body ?? "{}") as { pool?: { address?: string } | null }).pool?.address ?? "").toLowerCase();
      expectThat(shown.every((address) => address === reserve || address === ACCOUNT.address.toLowerCase()), `the page shows an address that is neither the signed-in one nor the reserve's: ${shown.join(", ")}`);
      // And what the server answered names no other address either.
      const mine = answers.find((answer) => new URL(answer.url).pathname === "/api/rewards/me")?.body ?? "";
      const named = [...new Set((mine.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []).map((address) => address.toLowerCase()))];
      expectThat(mine !== "" && named.length === 1 && named[0] === ACCOUNT.address.toLowerCase(), `the answer with the signed-in address's points names ${named.length} addresses`);
      await shoot("signed-in");

      // The sign-in is in the page's memory only: nothing of it is kept by the browser.
      const kept = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
      const token = (JSON.parse(answers.find((answer) => new URL(answer.url).pathname === "/api/rewards/session")?.body ?? "{}") as { token?: string }).token ?? "";
      expectThat(token !== "" && !kept.includes(token), "the sign-in is kept in the browser's storage");

      // Signing out takes the points off the screen.
      await page.getByRole("button", { name: "Sign out" }).click();
      await signIn.waitFor({ timeout: 10_000 });
      expectThat((await page.locator(".rewards-points").count()) === 0 && (await page.getByRole("heading", { name: "Your payouts" }).count()) === 0, "points or payouts are still shown after signing out");

      // Sign in again, then load the page afresh: not signed in, and the wallet is not asked to sign by itself.
      await signIn.click();
      await page.locator(".rewards-points").waitFor({ timeout: 30_000 });
      await visit(page, new URL("/rewards", practiceUrl).toString());
      await page.locator(".rewards-count").waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      expectThat((await page.locator(".rewards-points").count()) === 0, "points are shown after the page was loaded again, without a new sign-in");
      expectThat(!(await asks()).some((ask) => ask.method === "personal_sign"), "the wallet was asked to sign as the page loaded");

      // The swap page, with the same wallet connected: nothing there asks for a signature.
      await visit(page, new URL("/?amount=0.5", practiceUrl).toString());
      await page.locator(".quote-rate").first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(800);
      expectThat(!(await asks()).some((ask) => ask.method === "personal_sign"), "the swap page asked the wallet to sign");
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
      await page.screenshot({ path: path.join(out, "failures", `stuck-rewards-${width}.png`) }).catch(() => undefined);
    }
    await context.close();
  }
  return { complaints, shots };
}
