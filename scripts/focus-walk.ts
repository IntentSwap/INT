// Where the focus is shown, and where it is not, walked in a real browser. Used by
// scripts/review-shots.ts (walk name: focus-marks).
//
// The rule: nothing is outlined in green, or at all, for having the focus
// after a click, a tap, Escape, a theme switch, a sheet or the coin picker opening or closing, or the page arriving.
// Someone moving about with Tab or the arrow keys sees one quiet line round where they are: 1 px,
// a neutral tone, 2 px off. Any press of a pointer takes it away again.
//
// What the walk proves, on the swap page, Track order, the Docs, the Rewards page, the Terms and
// the page of component states, in both themes:
//   - given the focus without the keyboard, no control on the page shows an outline of any colour,
//     nor a ring, border or glow in the accent colour;
//   - after a click on the theme switch, on a coin selector, in the coin picker (its search field,
//     its first row, a chain's tile) and after Escape closes the picker, the same;
//   - after Tab, the control that has the focus wears the quiet line, and it is not the accent;
//     the arrow keys in the coin picker's search move a soft tint and no border; a click takes the line away.

import type { Browser, Page } from "playwright-core";

export interface WalkResult {
  complaints: string[];
  shots: number;
}

/** Runs in the page. Gives every control the focus in turn, as a script does (no key is pressed), and lists any that then shows a line, or anything in the accent colour. */
const SWEEP = `(() => {
  const probe = document.createElement("span");
  document.body.append(probe);
  probe.style.color = "var(--accent)";
  const accent = getComputedStyle(probe).color;
  probe.remove();
  const before = document.activeElement;
  const found = [];
  let looked = 0;
  for (const el of document.querySelectorAll('a[href], a[role="link"], button:not(:disabled), input:not(:disabled), textarea, select, summary, [tabindex]')) {
    if (el.closest("w3m-modal") !== null || el.offsetParent === null) continue;
    el.focus({ preventScroll: true });
    if (document.activeElement !== el) continue;
    looked += 1;
    for (const node of [el, el.closest(".field"), el.closest(".picker-search"), el.closest(".picker-row"), el.closest(".address-field")]) {
      if (node === null) continue;
      const style = getComputedStyle(node);
      const what = (node.className && String(node.className).split(" ")[0]) || node.tagName.toLowerCase();
      if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && !/rgba\\(\\d+, \\d+, \\d+, 0\\)|transparent/.test(style.outlineColor)) found.push(what + ": an outline of " + style.outlineWidth + " " + style.outlineColor);
      if (style.boxShadow.includes(accent)) found.push(what + ": an accent-coloured ring");
      if (node !== el.closest(".ending") && parseFloat(style.borderTopWidth) > 0 && style.borderTopColor === accent) found.push(what + ": an accent-coloured border");
    }
  }
  if (before instanceof HTMLElement) before.focus({ preventScroll: true }); else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  return { looked, found: [...new Set(found)].slice(0, 6) };
})()`;

/** Runs in the page. What the control that has the focus (or the field around it) wears: "none", or "<width> <colour> <offset>". Also whether anything on it is in the accent colour. */
const WORN = `(() => {
  const probe = document.createElement("span");
  document.body.append(probe);
  probe.style.color = "var(--accent)";
  const accent = getComputedStyle(probe).color;
  probe.style.color = "var(--focus-ring)";
  const quiet = getComputedStyle(probe).color;
  probe.remove();
  const el = document.activeElement;
  let mark = "none";
  let green = false;
  if (el instanceof HTMLElement && el !== document.body) {
    for (const node of [el, el.closest(".field"), el.closest(".picker-search"), el.closest(".picker-row")]) {
      if (node === null) continue;
      const style = getComputedStyle(node);
      if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && !/rgba\\(\\d+, \\d+, \\d+, 0\\)|transparent/.test(style.outlineColor)) {
        if (mark === "none") mark = style.outlineWidth + " " + (style.outlineColor === quiet ? "quiet" : style.outlineColor) + " " + style.outlineOffset;
        if (style.outlineColor === accent) green = true;
      }
      if (style.boxShadow.includes(accent)) green = true;
    }
  }
  return { mark, green, on: el instanceof HTMLElement ? (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40) : "" };
})()`;

interface Worn {
  mark: string;
  green: boolean;
  on: string;
}

export async function focusWalk(browser: Browser, options: { baseUrl: string; out: string; visit(page: Page, url: string): Promise<void> }): Promise<WalkResult> {
  const complaints: string[] = [];
  const { baseUrl, visit } = options;

  for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
    await context.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "${theme}"; });`);
    const page = await context.newPage();
    const say = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`focus marks, ${theme}: ${what}`);
    };
    const worn = () => page.evaluate(WORN) as Promise<Worn>;
    const quietOnly = async (after: string) => {
      const now = await worn();
      say(now.mark === "none" && !now.green, `${after}, "${now.on}" wears ${now.mark}${now.green ? " and something in the accent colour" : ""}`);
    };
    try {
      // ---- Every page: given the focus without the keyboard, nothing is outlined and nothing turns green ----
      for (const address of ["/", "/?amount=0.5", "/track", "/docs", "/docs/fees", "/rewards", "/terms", "/states"]) {
        await visit(page, new URL(address, baseUrl).toString());
        await page.waitForTimeout(900);
        const swept = (await page.evaluate(SWEEP)) as { looked: number; found: string[] };
        say(swept.looked >= 8, `${address}: only ${swept.looked} controls were found to look at`);
        say(swept.found.length === 0, `${address}: given the focus without the keyboard, ${swept.found.join("; ")}`);
      }

      // ---- The swap page, by pointer: the page arriving, the theme switch, a coin selector, the picker, Escape ----
      await visit(page, new URL("/", baseUrl).toString());
      await page.getByRole("button", { name: /^You pay: / }).waitFor({ timeout: 20_000 });
      await page.waitForTimeout(600);
      // The amount has the focus as the page arrives, and shows nothing but its caret.
      await quietOnly("as the page arrives");
      const toggle = page.getByRole("button", { name: /^Switch to the (Light|Dark) theme$/ });
      await toggle.click();
      await page.waitForTimeout(200);
      await quietOnly("after the theme switch is clicked");
      await page.getByRole("button", { name: /^Switch to the (Light|Dark) theme$/ }).click();
      await page.waitForTimeout(200);
      await quietOnly("after the theme switch is clicked back");
      for (const name of [/^IntentSwap on GitHub$/, /^Connect$/]) {
        const control = page.locator("header").getByRole(name.source.includes("GitHub") ? "link" : "button", { name });
        const box = await control.first().boundingBox();
        if (box !== null) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        // The wallet's own window is fetched when Connect is first pressed, and opens some seconds later. Escape is
        // pressed once it is there, so that it is not left to open over the steps that follow.
        if (name.source.includes("Connect")) await page.locator("w3m-modal.open").waitFor({ state: "attached", timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(300);
        await page.keyboard.press("Escape");
        await page.locator("w3m-modal.open").waitFor({ state: "detached", timeout: 5000 }).catch(() => undefined);
        await quietOnly(`after ${String(name)} in the header is clicked`);
      }
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Swap" }).click();
      await quietOnly("after a link in the header is clicked");
      // The coin selector opens the picker inside the card: its coin search has the focus, its first row is the one Enter would choose.
      await page.getByRole("button", { name: /^You pay: / }).click();
      await page.getByRole("region", { name: "Select a token you pay" }).waitFor();
      await page.waitForTimeout(400);
      await quietOnly("with the coin picker just opened by a click");
      const firstRow = await page.locator(".picker-row").first().evaluate((row) => {
        const style = getComputedStyle(row);
        return { outline: style.outlineStyle === "none" || parseFloat(style.outlineWidth) === 0 ? "none" : `${style.outlineWidth} ${style.outlineColor}`, border: style.borderTopWidth, active: row.hasAttribute("data-active") };
      });
      say(firstRow.outline === "none" && firstRow.border === "0px", `the picker's first row has an outline of ${firstRow.outline} and a border of ${firstRow.border}`);
      // The arrow keys move the highlight: a soft tint, and no border on the row.
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
      const highlighted = await page.locator(".picker-row[data-active]").first().evaluate((row) => {
        const style = getComputedStyle(row);
        return { outline: style.outlineStyle === "none" || parseFloat(style.outlineWidth) === 0 ? "none" : `${style.outlineWidth} ${style.outlineColor}`, border: style.borderTopWidth, tint: style.backgroundColor, second: row.getAttribute("data-index") };
      });
      say(highlighted.second === "1" && highlighted.outline === "none" && highlighted.border === "0px" && !/rgba\(0, 0, 0, 0\)|transparent/.test(highlighted.tint), `the row the arrow keys are on (row ${highlighted.second}) has an outline of ${highlighted.outline}, a border of ${highlighted.border} and a fill of ${highlighted.tint}`);
      // Every control in the picker, given the focus without the keyboard: nothing is outlined, and nothing turns green.
      const inPicker = (await page.evaluate(SWEEP)) as { looked: number; found: string[] };
      say(inPicker.looked >= 20, `only ${inPicker.looked} controls were found to look at with the coin picker open`);
      say(inPicker.found.length === 0, `in the coin picker, given the focus without the keyboard, ${inPicker.found.join("; ")}`);
      // A chain chosen with a click: its tile is told by its own colour, with no outline and nothing green; the focus goes to the coin search, quietly.
      await page.getByRole("option", { name: "Solana", exact: true }).click();
      await page.getByRole("grid", { name: "Coins on Solana" }).waitFor();
      await page.waitForTimeout(150);
      await quietOnly("after a chain was chosen with a click");
      const chosenTile = (await page.evaluate(`(() => {
        const probe = document.createElement("span");
        document.body.append(probe);
        probe.style.color = "var(--accent)";
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const style = getComputedStyle(document.querySelector('.chain-tile[aria-selected="true"]'));
        return { outline: style.outlineStyle === "none" || parseFloat(style.outlineWidth) === 0 ? "none" : style.outlineWidth + " " + style.outlineColor, green: style.borderTopColor === accent || style.boxShadow.includes(accent) || style.backgroundColor === accent, ring: style.boxShadow, edge: style.borderTopWidth };
      })()`)) as { outline: string; green: boolean; ring: string; edge: string };
      say(chosenTile.outline === "none" && !chosenTile.green && chosenTile.ring === "none" && chosenTile.edge === "1px", `the chosen chain's tile has an outline of ${chosenTile.outline}, a ring of ${chosenTile.ring}, an edge of ${chosenTile.edge}${chosenTile.green ? " and something in the accent colour" : ""}`);
      // Escape closes the picker and hands the focus back to the selector: nothing is drawn round it.
      await page.keyboard.press("Escape");
      await page.locator(".card-picker").waitFor({ state: "detached" });
      await page.waitForTimeout(200);
      await quietOnly("after Escape closed the coin picker");
      // The same by clicking a coin: the picker closes, the focus goes back, nothing is drawn.
      await page.getByRole("button", { name: /^You receive: / }).click();
      await page.getByRole("region", { name: "Select a token you receive" }).waitFor();
      await page.waitForTimeout(400);
      await page.locator(".picker-row").nth(1).click();
      await page.locator(".card-picker").waitFor({ state: "detached" });
      await page.waitForTimeout(200);
      await quietOnly("after a coin was chosen with a click");
      // A click into the address field: its hairline comes up, and nothing else.
      const address = page.getByLabel(/Receiving address/);
      const restBorder = await address.evaluate((el) => getComputedStyle(el).borderTopColor);
      await address.click();
      await page.waitForTimeout(150);
      await quietOnly("after a click into the receiving address");
      const typingBorder = await address.evaluate((el) => `${getComputedStyle(el).borderTopWidth} ${getComputedStyle(el).borderTopColor}`);
      say(typingBorder.startsWith("1px ") && !typingBorder.endsWith(restBorder), `a text field being typed in has a border of ${typingBorder} (at rest ${restBorder})`);

      // ---- By keyboard: Tab shows the quiet line, a click takes it away ----
      await page.keyboard.press("Tab");
      await page.waitForTimeout(150);
      const tabbed = await worn();
      say(tabbed.mark === "1px quiet 2px" || tabbed.mark === "1px quiet -2px", `after Tab, "${tabbed.on}" wears ${tabbed.mark}, not the quiet line`);
      say(!tabbed.green, `after Tab, "${tabbed.on}" has something in the accent colour`);
      for (let presses = 0; presses < 6; presses++) {
        await page.keyboard.press("Tab");
        await page.waitForTimeout(80);
        const next = await worn();
        say((next.mark === "1px quiet 2px" || next.mark === "1px quiet -2px") && !next.green, `moving on with Tab, "${next.on}" wears ${next.mark}${next.green ? " with the accent colour" : ""}`);
      }
      // Shift+Tab is the same key the other way.
      await page.keyboard.press("Shift+Tab");
      await page.waitForTimeout(80);
      say((await worn()).mark.startsWith("1px quiet"), "going back with Shift+Tab shows no quiet line");
      // Any press of a pointer takes the line away until the next Tab or arrow key.
      await page.mouse.click(8, 300);
      await page.waitForTimeout(100);
      await page.getByRole("button", { name: /^You pay: / }).focus();
      await quietOnly("after a click on the page, with the focus then moved by a script");
      await page.keyboard.press("Tab");
      await page.waitForTimeout(100);
      say((await worn()).mark.startsWith("1px quiet"), "after a click, the next Tab does not bring the quiet line back");
      // Opened from the keyboard, the coin picker takes the focus without showing a line (the picker opening is not someone moving about).
      await page.getByRole("button", { name: /^You pay: / }).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await page.getByRole("region", { name: "Select a token you pay" }).waitFor();
      await page.waitForTimeout(400);
      await quietOnly("with the coin picker opened by Enter");
      // Moving on with Tab inside the picker: the quiet line on each stop (the chain search, a chain's tile, the coin search, a coin's row), never the accent.
      await page.keyboard.press("Shift+Tab");
      for (let presses = 0; presses < 4; presses++) {
        const next = await worn();
        say((next.mark === "1px quiet 2px" || next.mark === "1px quiet -2px") && !next.green, `moving through the coin picker with Tab, "${next.on}" wears ${next.mark}${next.green ? " with the accent colour" : ""}`);
        await page.keyboard.press("Tab");
        await page.waitForTimeout(80);
      }
      await page.keyboard.press("Escape");
      await page.locator(".card-picker").waitFor({ state: "detached" });
      await page.waitForTimeout(200);
      await quietOnly("after Escape closed a picker that the keyboard opened");
      // The same for a sheet: opened from the keyboard, it takes the focus without showing a line.
      const limit = page.getByRole("button", { name: /slippage limit\. Change$/ });
      await limit.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await page.getByRole("dialog", { name: "Slippage limit" }).waitFor();
      await page.waitForTimeout(350);
      await quietOnly("with a sheet opened by Enter");
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      await page.waitForTimeout(200);
      await quietOnly("after Escape closed a sheet that the keyboard opened");
    } catch (error) {
      complaints.push(`focus marks, ${theme}: ${(error as Error).message.split("\n")[0]}`);
    }
    await context.close();
  }
  return { complaints, shots: 0 };
}
