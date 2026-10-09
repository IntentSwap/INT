// Measures the pages in a real browser and fails when they fall short:
//   - Lighthouse, as a phone on a slow connection would load them: performance 90 or more,
//     accessibility 100, layout shift 0.05 at most, largest paint within 3.5 seconds (the site's
//     own budget is 2 and is not met; see LATEST_PAINT_MS below);
//   - the axe accessibility rules (see scripts/axe.ts for exactly which), in both themes, at phone
//     and desktop width: no finding at all.
//
// The pages: the home page, Track order, Docs, Rewards, Terms and Privacy; the token's page, where
// the site has one; and an order's page, the one a person pays on, where an order can be made up
// (a site in practice mode). What was left out is printed.
//
//   npx tsx scripts/page-quality.ts [address of the running site]
//
// With no address it starts the built site itself in practice mode, with a made-up token address
// (npm run build first), and stops it afterwards. Uses the Chrome already installed on this machine.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lighthouse from "lighthouse";
import { chromium, type Browser } from "playwright-core";
import { axeProblems } from "./axe.ts";
import { freshSol, settle } from "./order-walk.ts";

/** The least each page may score, out of 100. */
const LEAST = { performance: 90, accessibility: 100 } as const;
/** The most the page may move while it loads (the site's own budget). */
const MOST_SHIFT = 0.05;
/**
 * The latest the largest paint may come, in milliseconds. The site's own budget is 2,000, and it
 * is NOT met: the swap card is drawn by script, and on this connection the script cannot arrive
 * sooner (about 2,900 today). Until the page is drawn on the server, this line keeps the figure
 * from getting much worse unnoticed: the measurement moves by a few hundred milliseconds from
 * run to run, so the line sits that far above it. Lower it when the budget is met.
 */
const LATEST_PAINT_MS = 3_500;
/** The pages that are always there. The token's page and an order's page are added below when the site has them. */
const PAGES = ["/", "/track", "/docs", "/rewards", "/terms", "/privacy"];
/** Made up from fixed text, so it is nobody's: the token's address on the site this script starts, and the pretend order's refund address. */
const MADE_UP = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
const DEBUG_PORT = 9337;
const OWN_PORT = 8796;

let site = process.argv[2];
let server: ChildProcess | null = null;
let dataDir: string | null = null;
if (site === undefined) {
  if (!fs.existsSync(path.resolve("web", "dist", "index.html"))) {
    console.error("page-quality: the site is not built. Run npm run build first.");
    process.exit(1);
  }
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-quality-"));
  server = spawn(process.execPath, [path.resolve("node_modules", "tsx", "dist", "cli.mjs"), path.resolve("server", "index.ts")], {
    env: { ...process.env, NODE_ENV: "development", PROVIDER_STUB: "true", PORT: String(OWN_PORT), DATA_DIR: dataDir, TOKEN_ADDRESS: MADE_UP },
    stdio: "ignore",
  });
  site = `http://127.0.0.1:${OWN_PORT}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const up = await fetch(new URL("/api/status", site)).then(
      (res) => res.ok,
      () => false,
    );
    if (up) break;
    if (Date.now() > deadline) {
      server.kill();
      console.error("page-quality: the site did not start within 30 seconds");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Makes a pretend order as a person paying by hand would, and returns its ID. Only on a site in practice mode. */
async function pretendOrder(browser: Browser, address: string): Promise<string> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const tab = await context.newPage();
    await tab.goto(new URL("/?amount=0.5", address).toString(), { waitUntil: "networkidle" });
    await tab.getByRole("button", { name: "Pay without connecting" }).click();
    await tab.getByLabel(/Receiving address/).fill(freshSol());
    await tab.getByLabel(/Refund address/).fill(MADE_UP);
    await tab.getByRole("button", { name: "Review swap" }).click({ timeout: 40_000 });
    const dialog = tab.getByRole("dialog");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Confirm swap" }).click();
    await tab.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
    return new URL(tab.url()).pathname.split("/").pop() ?? "";
  } finally {
    await context.close();
  }
}
/** An order's page is named without its ID: the ID is different on every run and tells nothing. */
const named = (page: string) => (page.startsWith("/order/") ? "an order's page" : page);

const problems: string[] = [];
const pages = [...PAGES];
const config = (await (await fetch(new URL("/api/config", site))).json()) as { practice?: boolean; tokenAddress?: string | null };
if ((config.tokenAddress ?? null) !== null) pages.push("/token");
else console.log("page-quality: left out: the token's page (this site has no token address set)");
let order = "";
// On a build machine the browser's own sandbox is often not available to an ordinary user. Only this site's own pages are opened.
const browser = await chromium.launch({ channel: "chrome", headless: true, args: [`--remote-debugging-port=${DEBUG_PORT}`, ...(process.env.CI ? ["--no-sandbox"] : [])] });
try {
  if (config.practice === true) {
    order = await pretendOrder(browser, site);
    pages.push(`/order/${order}`);
  } else console.log("page-quality: left out: an order's page (an order can only be made up on a site in practice mode)");
  for (const page of pages) {
    const result = await lighthouse(new URL(page, site).toString(), { port: DEBUG_PORT, output: "json", logLevel: "error", onlyCategories: ["performance", "accessibility"] });
    if (result === undefined) {
      problems.push(`${named(page)}: Lighthouse gave no result`);
      continue;
    }
    const { categories, audits } = result.lhr;
    const score = (name: keyof typeof LEAST) => Math.round((categories[name]?.score ?? 0) * 100);
    const shown = (id: string) => audits[id]?.displayValue ?? "?";
    console.log(`page-quality: ${named(page)}: performance ${score("performance")}, accessibility ${score("accessibility")}, first paint ${shown("first-contentful-paint")}, largest paint ${shown("largest-contentful-paint")}, layout shift ${shown("cumulative-layout-shift")}`);
    for (const name of ["performance", "accessibility"] as const) {
      if (score(name) < LEAST[name]) problems.push(`${named(page)}: ${name} is ${score(name)}, under ${LEAST[name]}`);
    }
    const shift = audits["cumulative-layout-shift"]?.numericValue;
    if (typeof shift !== "number" || shift > MOST_SHIFT) problems.push(`${named(page)}: the page moves while it loads (layout shift ${shift?.toFixed(3) ?? "unknown"}, ${MOST_SHIFT} at most)`);
    const paint = audits["largest-contentful-paint"]?.numericValue;
    if (typeof paint !== "number" || paint > LATEST_PAINT_MS) problems.push(`${named(page)}: the largest paint comes at ${paint === undefined ? "an unknown time" : `${Math.round(paint)} ms`}, later than ${LATEST_PAINT_MS} ms`);
    // What cost the points, so that a failure says where to look.
    for (const ref of categories.accessibility?.auditRefs ?? []) {
      const audit = audits[ref.id];
      if (audit !== undefined && audit.score !== null && audit.score < 1) problems.push(`${named(page)}: accessibility: ${audit.title}`);
    }
  }

  let looked = 0;
  for (const theme of ["dark", "light"] as const) {
    for (const width of [360, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
      await context.addInitScript((value) => {
        try {
          localStorage.setItem("theme", value);
        } catch {
          // storage unavailable
        }
      }, theme);
      const tab = await context.newPage();
      for (const page of pages) {
        await tab.goto(new URL(page, site).toString(), { waitUntil: "networkidle" });
        await tab.locator("footer").waitFor();
        for (const problem of await axeProblems(tab)) problems.push(`${named(page)} at ${width} px, ${theme}: ${problem}`);
        looked += 1;
      }
      await context.close();
    }
  }
  console.log(`page-quality: axe looked at ${looked} screens`);
} finally {
  await browser.close();
  // The pretend order is not left unpaid behind on a site that goes on running.
  await settle(site, order);
  server?.kill();
  if (dataDir !== null) fs.rmSync(dataDir, { recursive: true, force: true });
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`page-quality: ${problem}`);
  process.exit(1);
}
console.log("page-quality: ok");
