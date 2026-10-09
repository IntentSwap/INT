// The coin picker, walked in a real browser. Used by scripts/review-shots.ts (walk name: picker;
// the older name picker-keyboard runs it too).
//
// The picker is a view of the swap card: chains above, the coins of the chosen chain beneath.
// What the walk proves:
//   - it opens and closes inside the card: no dialog, nothing dimmed, the page not locked, the card's
//     left edge, top edge and width unchanged, the swap out of reach while it is open, and the
//     address shown the same throughout;
//   - the card's height goes smoothly from one view's to the other's, and while it does (measured on
//     every frame) the page does not scroll and the card's top edge does not move; where the system
//     asks for less movement the views change places at once;
//   - the grid of chains: three across (two on a narrow phone), every chain on the coin list, in the
//     set order, tiles all one size, about four rows on show with the rest scrolling inside the grid,
//     a long name cut short, the chain in use chosen as it opens and told by its own colour, never
//     the accent;
//   - searching the chains, and that choosing a chain shows that chain's coins alone, in their order;
//   - searching the coins; a pasted contract address going to its own chain; an address that is not
//     listed saying "Not supported"; a search with no match here showing the matches on other chains;
//   - the keyboard: where the focus goes on opening, Tab's order, the arrow keys in the grid and in
//     the list, Enter choosing, Esc and the browser's Back button returning to the swap, and the
//     focus going back to the coin selector that opened the picker;
//   - choosing, for one side, the coin that is on the other side changes the two over.

import path from "node:path";
import type { Browser, Page } from "playwright-core";

export interface WalkResult {
  complaints: string[];
  shots: number;
}

interface Listed {
  symbol: string;
  name: string;
  chain: string;
  contract: string | null;
}

/** The chains in the order the grid offers them, by the names on their tiles. The rest follow by name. */
const FIRST_CHAINS = ["BNB Chain", "Ethereum", "Solana", "Bitcoin", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "Tron", "TON"];

/** Runs in the page. What the picker looks like at this moment. */
const STATE = `(() => {
  const card = document.querySelector(".card");
  const picker = document.querySelector(".card-picker");
  const swap = document.querySelector(".card-swap");
  const box = card.getBoundingClientRect();
  const probe = document.createElement("span");
  document.body.append(probe);
  probe.style.color = "var(--accent)";
  const accent = getComputedStyle(probe).color;
  probe.remove();
  const tiles = [...document.querySelectorAll(".chain-tile")].map((tile) => {
    const r = tile.getBoundingClientRect();
    const style = getComputedStyle(tile);
    const name = tile.querySelector(".chain-tile-name");
    const mark = tile.querySelector(".chain-mark");
    return { name: name.textContent, chosen: tile.getAttribute("aria-selected") === "true", tab: tile.tabIndex, x: Math.round(r.x), w: r.width, h: r.height, border: style.borderTopColor, borderWidth: style.borderTopWidth, fill: style.backgroundColor, shadow: style.boxShadow, weight: style.fontWeight, cut: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow, mark: mark ? Math.round(mark.getBoundingClientRect().width) + "x" + Math.round(mark.getBoundingClientRect().height) : "none", art: mark ? mark.tagName : "" };
  });
  const grid = document.querySelector(".picker-chains");
  const list = document.querySelector(".picker-list[role=grid]");
  const rows = [...document.querySelectorAll(".picker-list[role=grid] .picker-row")].map((row) => {
    const icon = row.querySelector(".coin-icon");
    const link = row.querySelector(".picker-link");
    return { name: row.querySelector(".picker-row-name").textContent, symbol: row.querySelector(".picker-row-symbol").textContent, contract: row.querySelector(".picker-row-contract") ? row.querySelector(".picker-row-contract").textContent : null, link: link && getComputedStyle(link).display !== "none" ? link.href : null, end: row.querySelector(".picker-row-end") ? row.querySelector(".picker-row-end").textContent.trim() : "", active: row.hasAttribute("data-active"), chosen: row.getAttribute("aria-selected") === "true", icon: icon ? Math.round(icon.getBoundingClientRect().width) : 0, h: row.getBoundingClientRect().height };
  });
  const active = document.activeElement;
  return {
    open: picker !== null && card.dataset.view === "picker",
    title: picker ? picker.querySelector(".picker-title").textContent : "",
    labelled: picker ? picker.getAttribute("role") === "region" && document.getElementById(picker.getAttribute("aria-labelledby")) === picker.querySelector(".picker-title") : false,
    inCard: picker ? picker.parentElement === card : false,
    card: { x: box.x, top: box.top + window.scrollY, width: box.width, height: box.height },
    scrollY: window.scrollY,
    address: location.href,
    dialog: document.querySelector("dialog[open]") !== null,
    locked: getComputedStyle(document.body).overflow === "hidden" || document.documentElement.hasAttribute("data-sheet"),
    swapInert: swap.inert === true,
    swapSeen: getComputedStyle(swap).visibility !== "hidden",
    help: document.querySelector(".help") ? getComputedStyle(document.querySelector(".help")).visibility : "",
    accent,
    placeholders: [...document.querySelectorAll(".card-picker .picker-input")].map((input) => input.placeholder),
    chainSearch: document.querySelector(".card-picker .picker-input:not([role])") ? document.querySelector(".card-picker .picker-input:not([role])").value : "",
    tiles,
    columns: grid && grid.getAttribute("role") === "listbox" ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
    grid: grid ? { h: grid.clientHeight, all: grid.scrollHeight, top: grid.scrollTop, mask: getComputedStyle(grid).maskImage || getComputedStyle(grid).webkitMaskImage, y: grid.getBoundingClientRect().y } : null,
    listName: list ? (list.getAttribute("aria-label") || (document.getElementById(list.getAttribute("aria-labelledby") || "") || {}).textContent || "") : "",
    rows,
    coins: document.querySelector(".picker-coins") ? { h: document.querySelector(".picker-coins").clientHeight, all: document.querySelector(".picker-coins").scrollHeight } : null,
    note: document.querySelector(".picker-coins .picker-note-title") ? document.querySelector(".picker-coins .picker-note-title").textContent : "",
    heading: document.querySelector(".picker-heading") ? document.querySelector(".picker-heading").textContent : "",
    focus: active === null || active === document.body ? "" : active.classList.contains("picker-input") ? (active.getAttribute("role") === "combobox" ? "coin search" : "chain search") : active.classList.contains("chain-tile") ? "chain " + active.querySelector(".chain-tile-name").textContent : active.classList.contains("picker-pick") ? "coin " + active.textContent : active.classList.contains("picker-link") ? "link " + active.closest(".picker-row").querySelector(".picker-row-name").textContent : active.classList.contains("picker-back") ? "back" : active.classList.contains("picker-title") ? "title" : active.classList.contains("coin-button") ? "selector " + active.textContent.replace(/\\s+/g, " ").trim() : active.closest(".card-swap") ? "in the swap" : "outside the card",
  };
})()`;

interface Tile {
  name: string;
  chosen: boolean;
  tab: number;
  x: number;
  w: number;
  h: number;
  border: string;
  borderWidth: string;
  fill: string;
  shadow: string;
  weight: string;
  cut: boolean;
  ellipsis: string;
  mark: string;
  art: string;
}

interface Row {
  name: string;
  symbol: string;
  contract: string | null;
  link: string | null;
  end: string;
  active: boolean;
  chosen: boolean;
  icon: number;
  h: number;
}

interface State {
  open: boolean;
  title: string;
  labelled: boolean;
  inCard: boolean;
  card: { x: number; top: number; width: number; height: number };
  scrollY: number;
  address: string;
  dialog: boolean;
  locked: boolean;
  swapInert: boolean;
  swapSeen: boolean;
  help: string;
  accent: string;
  placeholders: string[];
  chainSearch: string;
  tiles: Tile[];
  columns: number;
  grid: { h: number; all: number; top: number; mask: string; y: number } | null;
  listName: string;
  rows: Row[];
  coins: { h: number; all: number } | null;
  note: string;
  heading: string;
  focus: string;
}

/**
 * Runs in the page. Presses the thing named by the selector and then, on every frame for half a
 * second, notes where the page is scrolled to and where the card stands. The press and the first
 * note are made in one go, so nothing of the change is missed.
 */
const WATCH = (selector: string) => `(async () => {
  const card = document.querySelector(".card");
  const seen = [];
  const note = () => { const box = card.getBoundingClientRect(); seen.push({ y: window.scrollY, top: Math.round((box.top + window.scrollY) * 100) / 100, left: Math.round(box.left * 100) / 100, width: Math.round(box.width * 100) / 100, height: Math.round(box.height * 100) / 100, moving: card.hasAttribute("data-moving") }); };
  note();
  document.querySelector(${JSON.stringify(selector)}).click();
  const until = performance.now() + 500;
  while (performance.now() < until) { await new Promise((resolve) => requestAnimationFrame(resolve)); note(); }
  return seen;
})()`;

interface Frame {
  y: number;
  top: number;
  left: number;
  width: number;
  height: number;
  moving: boolean;
}

export async function pickerWalk(browser: Browser, options: { baseUrl: string; out: string; visit(page: Page, url: string): Promise<void> }): Promise<WalkResult> {
  const complaints: string[] = [];
  let shots = 0;
  const { baseUrl, out, visit } = options;
  const home = new URL("/", baseUrl).toString();
  const listed = ((await (await fetch(new URL("/api/tokens", baseUrl))).json()) as { tokens: Listed[] }).tokens;
  const on = (chain: string) => listed.filter((token) => token.chain === chain);
  const chainCount = new Set(listed.map((token) => token.chain)).size;

  const state = (page: Page) => page.evaluate(STATE) as Promise<State>;
  const pay = (page: Page) => page.getByRole("button", { name: /^You pay: / });
  const receive = (page: Page) => page.getByRole("button", { name: /^You receive: / });
  const region = (page: Page, side: "pay" | "receive" = "pay") => page.getByRole("region", { name: `Select a token you ${side}` });
  const chainSearch = (page: Page) => page.getByPlaceholder("Search by chain name");
  const coinSearch = (page: Page) => page.getByPlaceholder("Search by name or paste address");
  const tile = (page: Page, name: string) => page.getByRole("option", { name, exact: true });
  /** The words on a coin selector, as they are read aloud: "You pay: USDC on Base. Change coin". (Without its icon, which is a picture and says nothing.) */
  const selector = async (page: Page, side: "pay" | "receive") =>
    (
      (await (side === "pay" ? pay(page) : receive(page)).evaluate((el) => {
        const copy = el.cloneNode(true) as HTMLElement;
        copy.querySelector(".coin-icon")?.remove();
        return copy.textContent;
      })) ?? ""
    )
      .replace(/\s+/g, " ")
      .trim();
  const openFor = async (page: Page, side: "pay" | "receive" = "pay") => {
    await (side === "pay" ? pay(page) : receive(page)).click();
    await region(page, side).waitFor();
    // The two views have changed places.
    await page.waitForTimeout(400);
  };
  const closed = async (page: Page) => {
    await page.locator(".card-picker").waitFor({ state: "detached", timeout: 5000 });
  };

  /** The site always opens in its light theme. For a dark page the theme is set at the last moment before the site's own scripts run, which is where the site reads it. */
  const themed = (theme: "dark" | "light") => `document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "${theme}"; });`;

  // ---- By pointer and by keyboard, on a wide screen, in both themes ----
  for (const theme of ["dark", "light"] as const) {
    const label = `picker, ${theme}`;
    const expectThat = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
    await context.addInitScript(themed(theme));
    const page = await context.newPage();
    page.on("pageerror", (error) => complaints.push(`${label}: page error: ${error.message}`));
    try {
      await visit(page, home);
      await pay(page).waitFor({ timeout: 20_000 });
      await page.waitForTimeout(400);
      expectThat((await page.evaluate(() => document.documentElement.dataset.theme)) === theme, `the page is not in the ${theme} theme`);
      const before = await state(page);
      const paying = await selector(page, "pay");
      const receiving = await selector(page, "receive");
      const usedChain = /on (.+)\. Change coin$/.exec(paying)?.[1] ?? "";
      const usedKey = usedChain === "Base" ? "base" : "";
      expectThat(usedKey !== "", `the walk expects the card to open with a coin on Base (it reads "${paying}")`);
      expectThat(!before.open && !before.swapInert && before.swapSeen, "before anything is pressed the swap is not the card's view");

      // ---- Opening: inside the card, nothing laid over the page ----
      await openFor(page);
      let now = await state(page);
      expectThat(now.open && now.inCard && now.labelled && now.title === "Select a token you pay", `the picker is not a named region inside the card (${JSON.stringify({ open: now.open, inCard: now.inCard, labelled: now.labelled, title: now.title })})`);
      expectThat(!now.dialog && !now.locked, "opening the picker opened a dialog or locked the page");
      expectThat(now.swapInert && !now.swapSeen, `with the picker open the swap is ${now.swapInert ? "" : "not "}inert and ${now.swapSeen ? "still drawn" : "not drawn"}`);
      // The Help button that floats in the corner steps aside for the picker, as it does for a sheet: nothing lies over a list that is being pressed.
      expectThat(before.help === "visible" && now.help === "hidden", `the floating Help button is ${before.help} with the swap on show and ${now.help} with the picker open`);
      expectThat(now.card.x === before.card.x && now.card.top === before.card.top && now.card.width === before.card.width, `the card moved or changed width when the picker opened (${JSON.stringify(before.card)} then ${JSON.stringify(now.card)})`);
      expectThat(now.card.height !== before.card.height, "the card's height did not change to fit the picker");
      expectThat(now.scrollY === before.scrollY, `opening the picker scrolled the page from ${before.scrollY} to ${now.scrollY}`);
      expectThat(now.address === before.address, `opening the picker changed the address shown to ${now.address}`);
      expectThat(JSON.stringify(now.placeholders) === JSON.stringify(["Search by chain name", "Search by name or paste address"]), `the two search fields read ${JSON.stringify(now.placeholders)}`);
      expectThat(now.focus === "coin search", `with a mouse and a keyboard, the focus on opening is on "${now.focus}", not the coin search`);
      // The way back comes first, then the title.
      const head = await page.locator(".picker-head").evaluate((el) => [...el.children].map((child) => child.className));
      expectThat(JSON.stringify(head) === JSON.stringify(["picker-back", "picker-title"]), `the picker's head holds ${JSON.stringify(head)}`);

      // ---- The grid of chains ----
      expectThat(now.columns === 3, `the chains are ${now.columns} across at 1280 px, not three`);
      expectThat(now.tiles.length === chainCount, `the grid has ${now.tiles.length} chains, the coin list ${chainCount}`);
      const names = now.tiles.map((item) => item.name);
      const expectFirst = FIRST_CHAINS.filter((name) => names.includes(name));
      expectThat(JSON.stringify(names.slice(0, expectFirst.length)) === JSON.stringify(expectFirst), `the grid starts ${JSON.stringify(names.slice(0, 11))}`);
      const rest = names.slice(expectFirst.length);
      expectThat(JSON.stringify(rest) === JSON.stringify([...rest].sort((a, b) => a.localeCompare(b))), `after the first eleven the chains are not in order of name: ${JSON.stringify(rest)}`);
      expectThat(now.tiles.every((item) => item.w === now.tiles[0]!.w && item.h === 44), `the tiles are not all one size, 44 px high: ${JSON.stringify([...new Set(now.tiles.map((item) => `${item.w}x${item.h}`))])}`);
      expectThat(now.tiles.every((item) => item.mark === "24x24"), `a chain's mark is not 24 px: ${JSON.stringify([...new Set(now.tiles.map((item) => item.mark))])}`);
      expectThat(now.tiles.filter((item) => item.art === "IMG").length >= now.tiles.length - 3, "most chains do not show their own artwork");
      // About four rows on show; the rest scrolls inside the grid, whose foot fades out.
      const rowsOnShow = (now.grid?.h ?? 0) / 52;
      expectThat(rowsOnShow >= 4 && rowsOnShow < 5, `the grid shows ${rowsOnShow.toFixed(2)} rows of chains`);
      expectThat((now.grid?.all ?? 0) > (now.grid?.h ?? 0), "the grid of chains does not scroll inside its own area");
      expectThat(/linear-gradient/.test(now.grid?.mask ?? ""), `the grid's foot does not fade (${now.grid?.mask})`);
      // The chain in use on this side is chosen, is the one Tab stops at, and is told by its own colour.
      const chosen = now.tiles.filter((item) => item.chosen);
      expectThat(chosen.length === 1 && chosen[0]!.name === usedChain && chosen[0]!.tab === 0 && now.tiles.filter((item) => item.tab === 0).length === 1, `the picker opened with ${JSON.stringify(chosen.map((item) => item.name))} chosen, the coin in use is on ${usedChain}`);
      const plain = now.tiles.find((item) => !item.chosen && item.name === "Ethereum");
      if (chosen[0] !== undefined && plain !== undefined) {
        expectThat(chosen[0].border !== plain.border && chosen[0].fill !== plain.fill, "the chosen chain's tile has the same edge or the same wash as any other");
        expectThat(chosen[0].border !== now.accent && !chosen[0].shadow.includes(now.accent) && chosen[0].shadow === "none", `the chosen chain is marked with the accent or a ring (edge ${chosen[0].border}, shadow ${chosen[0].shadow})`);
        expectThat(chosen[0].borderWidth === "1px" && plain.borderWidth === "1px", "a chain's tile has an edge heavier than a hairline");
      }
      // Every tile carries a wash, and two chains of different colours carry different ones.
      expectThat(now.tiles.every((item) => !/rgba\(0, 0, 0, 0\)|transparent/.test(item.fill)), "a chain's tile has no wash at all");
      expectThat(new Set(now.tiles.map((item) => item.fill)).size >= 15, `the tiles carry only ${new Set(now.tiles.map((item) => item.fill)).size} different washes`);

      // ---- The list: the chosen chain's coins alone, in their order ----
      const ownCoins = on(usedKey);
      expectThat(now.listName === `Coins on ${usedChain}`, `the list is named "${now.listName}"`);
      expectThat(now.rows.length === ownCoins.length && now.rows.every((row) => ownCoins.some((token) => token.name === row.name && token.symbol === row.symbol)), `the list shows ${now.rows.length} coins, ${usedChain} has ${ownCoins.length}`);
      const native = ownCoins.find((token) => token.contract === null);
      expectThat(native !== undefined && now.rows[0]?.name === native.name && now.rows[0]?.contract === null && now.rows[0]?.link === null && now.rows[0]?.symbol === native.symbol, `the list does not start with the chain's own coin, shown by its symbol alone (${JSON.stringify(now.rows[0])})`);
      const stable = now.rows.findIndex((row) => row.symbol === "USDC");
      expectThat(stable === 1, `USDC is at place ${stable + 1} on ${usedChain}'s list, not right after the chain's own coin`);
      const afterStable = now.rows.slice(2).map((row) => row.name);
      expectThat(JSON.stringify(afterStable) === JSON.stringify([...afterStable].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))), `after the stablecoins the coins are not in order of name: ${JSON.stringify(afterStable)}`);
      expectThat(now.rows.every((row) => row.icon === 32 && row.h >= 44), "a coin's icon is not 32 px, or its row is under 44 px");
      const usdc = now.rows[stable];
      const usdcListed = ownCoins.find((token) => token.symbol === "USDC");
      expectThat(usdc !== undefined && usdcListed?.contract !== null && usdc.contract === `${usdcListed?.contract?.slice(0, 4)}…${usdcListed?.contract?.slice(-4)}` && usdc.link === `https://basescan.org/token/${usdcListed?.contract}`, `USDC's row shows ${JSON.stringify(usdc)}`);
      expectThat(now.rows[0]?.chosen === true && /Chosen/.test(now.rows[0]?.end ?? ""), "the coin in use on this side is not marked as chosen");
      expectThat((now.coins?.all ?? 0) > (now.coins?.h ?? 0), "the list of coins does not scroll inside its own area");
      await page.screenshot({ path: path.join(out, `picker-walk-open-1280-${theme}.png`) });
      shots += 1;

      // ---- Searching the chains ----
      await chainSearch(page).fill("sol");
      now = await state(page);
      expectThat(JSON.stringify(now.tiles.map((item) => item.name)) === JSON.stringify(["Solana"]), `searching the chains for "sol" shows ${JSON.stringify(now.tiles.map((item) => item.name))}`);
      expectThat(now.listName === `Coins on ${usedChain}`, "typing in the chain search changed the list of coins before a chain was chosen");
      await chainSearch(page).fill("zzzz");
      await page.getByText("No chain matches.").waitFor({ timeout: 3000 });
      expectThat((await state(page)).card.height === now.card.height, "the card changed height when no chain matched");
      // Enter takes the best match.
      await chainSearch(page).fill("sola");
      await chainSearch(page).press("Enter");
      now = await state(page);
      expectThat(now.listName === "Coins on Solana" && now.tiles.find((item) => item.name === "Solana")?.chosen === true, `Enter in the chain search did not choose Solana (the list is "${now.listName}")`);
      expectThat(now.rows.length === on("sol").length && now.rows[0]?.symbol === "SOL", `with Solana chosen the list shows ${now.rows.length} coins, starting with ${now.rows[0]?.symbol}`);
      // A token on a chain whose explorer the site has no address page for: its contract, and no link.
      const tether = now.rows.find((row) => row.symbol === "USDT");
      expectThat(tether !== undefined && tether.contract !== null && tether.link === null, `USDT on Solana shows ${JSON.stringify(tether)}`);
      await chainSearch(page).fill("");
      now = await state(page);
      expectThat(now.tiles.length === chainCount && now.tiles.filter((item) => item.chosen).map((item) => item.name).join() === "Solana", "clearing the chain search did not bring every chain back with Solana still chosen");

      // ---- Choosing a chain with the pointer: its coins alone, and the keyboard is not stranded ----
      await tile(page, "Arbitrum").click();
      now = await state(page);
      expectThat(now.listName === "Coins on Arbitrum" && now.rows.length === on("arb").length, `with Arbitrum chosen the list is "${now.listName}" with ${now.rows.length} coins (the coin list has ${on("arb").length})`);
      expectThat(now.focus === "coin search", `after a press on a chain the focus is on "${now.focus}", not the coin search`);
      expectThat(now.rows[0]?.active === true, "the first coin is not the one Enter would choose");
      await page.keyboard.press("ArrowDown");
      const first = (await state(page)).rows.findIndex((row) => row.active);
      await page.keyboard.press("ArrowDown");
      now = await state(page);
      const second = now.rows.findIndex((row) => row.active);
      expectThat(first === 1 && second === 2 && now.focus === "coin search", `the arrow keys in the coin search moved the highlight to ${first} and then ${second}, with the focus on "${now.focus}"`);

      // ---- Searching the coins, and Enter ----
      await page.keyboard.type("usd");
      now = await state(page);
      expectThat(now.rows.length >= 2 && now.rows.every((row) => /usd/i.test(row.symbol) || /usd/i.test(row.name)) && now.rows[0]?.active === true, `searching Arbitrum's coins for "usd" shows ${JSON.stringify(now.rows.map((row) => row.symbol))}`);
      await page.keyboard.press("ArrowDown");
      const highlighted = (await state(page)).rows.find((row) => row.active);
      await page.keyboard.press("Enter");
      await closed(page);
      await page.waitForTimeout(100);
      now = await state(page);
      const picked = await selector(page, "pay");
      expectThat(highlighted !== undefined && picked === `You pay: ${highlighted.symbol} on Arbitrum. Change coin`, `Enter did not pick the highlighted coin (highlighted ${JSON.stringify(highlighted?.symbol)}, the selector reads "${picked}")`);
      expectThat(now.focus.startsWith("selector You pay"), `after a coin was chosen the focus is on "${now.focus}", not the coin selector that opened the picker`);
      expectThat(!now.open && !now.swapInert && now.swapSeen, "after a coin was chosen the swap is not back");
      expectThat(now.help === "visible", `after the picker closed the floating Help button is ${now.help}`);
      expectThat(now.card.x === before.card.x && now.card.top === before.card.top && now.card.width === before.card.width && now.scrollY === before.scrollY, `after the picker closed the card or the page is not where it was (${JSON.stringify(now.card)}, scrolled to ${now.scrollY})`);
      expectThat(now.address === before.address, `after the picker closed the address shown is ${now.address}`);

      // ---- Esc closes and changes nothing; the focus goes back ----
      await page.keyboard.press("Enter");
      await region(page).waitFor();
      now = await state(page);
      expectThat(now.tiles.find((item) => item.chosen)?.name === "Arbitrum" && now.focus === "coin search", `opened again, the picker has ${now.tiles.find((item) => item.chosen)?.name} chosen and the focus on "${now.focus}"`);
      await page.keyboard.press("Escape");
      await closed(page);
      await page.waitForTimeout(100);
      expectThat((await selector(page, "pay")) === picked, "Esc changed the coin");
      expectThat((await state(page)).focus.startsWith("selector You pay"), "focus did not return to the coin selector after Esc");

      // ---- Tab: the way back, the chain search, the grid, the coin search, the list; never the swap ----
      await page.keyboard.press("Enter");
      await region(page).waitFor();
      await page.waitForTimeout(350);
      await page.locator(".picker-back").focus();
      const order = [(await state(page)).focus];
      for (let presses = 0; presses < 5; presses++) {
        await page.keyboard.press("Tab");
        order.push((await state(page)).focus);
      }
      now = await state(page);
      const firstCoin = now.rows[0]?.name ?? "?";
      expectThat(JSON.stringify(order.slice(0, 5)) === JSON.stringify(["back", "chain search", "chain Arbitrum", "coin search", `coin ${firstCoin}`]), `Tab goes through ${JSON.stringify(order)}`);
      expectThat(order[5] === "outside the card", `after the list of coins Tab goes to "${order[5]}"`);
      for (let presses = 0; presses < 12; presses++) {
        await page.keyboard.press("Tab");
        expectThat((await state(page)).focus !== "in the swap", "Tab reached the swap while the picker was open");
      }

      // ---- The arrow keys in the grid; Enter chooses and the focus stays among the chains ----
      await chainSearch(page).focus();
      await page.keyboard.press("ArrowDown");
      now = await state(page);
      expectThat(now.focus === "chain Arbitrum", `the down arrow in the chain search went to "${now.focus}"`);
      const at = now.tiles.findIndex((item) => item.name === "Arbitrum");
      await page.keyboard.press("ArrowRight");
      expectThat((await state(page)).focus === `chain ${now.tiles[at + 1]?.name}`, `the right arrow went from Arbitrum to "${(await state(page)).focus}"`);
      await page.keyboard.press("ArrowDown");
      expectThat((await state(page)).focus === `chain ${now.tiles[at + 4]?.name}`, `the down arrow went to "${(await state(page)).focus}", not one row down`);
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowUp");
      expectThat((await state(page)).focus === "chain Arbitrum", `left and up did not come back to Arbitrum ("${(await state(page)).focus}")`);
      await page.keyboard.press("Home");
      expectThat((await state(page)).focus === `chain ${now.tiles[0]?.name}`, "Home did not go to the first chain");
      // Up from the first row is the chain search; down comes back.
      await page.keyboard.press("ArrowUp");
      expectThat((await state(page)).focus === "chain search", "up from the first row of chains did not go to the chain search");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowDown");
      const target = (await state(page)).focus;
      // The quiet line, just inside the tile's own edge, and nothing in the accent colour.
      const worn = await page.evaluate(`(() => { const style = getComputedStyle(document.activeElement); const probe = document.createElement("span"); document.body.append(probe); probe.style.color = "var(--focus-ring)"; const quiet = getComputedStyle(probe).color; probe.remove(); return { line: style.outlineStyle + " " + style.outlineWidth + " " + (style.outlineColor === quiet ? "quiet" : style.outlineColor) + " " + style.outlineOffset, border: style.borderTopColor, shadow: style.boxShadow }; })()`) as { line: string; border: string; shadow: string };
      expectThat(worn.line === "solid 1px quiet -2px" && worn.border !== now.accent && worn.shadow === "none", `a chain reached by the arrow keys wears ${JSON.stringify(worn)}`);
      await page.screenshot({ path: path.join(out, `picker-walk-keys-grid-1280-${theme}.png`) });
      shots += 1;
      await page.keyboard.press("Enter");
      now = await state(page);
      expectThat(target === `chain ${now.tiles.find((item) => item.chosen)?.name}` && now.focus === target, `Enter on "${target}" chose ${now.tiles.find((item) => item.chosen)?.name} and left the focus on "${now.focus}"`);
      expectThat(now.listName === `Coins on ${target.replace(/^chain /, "")}`, `after Enter on "${target}" the list is "${now.listName}"`);

      // ---- The arrow keys in the list; Enter chooses ----
      await tile(page, "Base").click();
      await page.keyboard.press("Tab");
      now = await state(page);
      expectThat(now.focus === `coin ${now.rows[0]?.name}`, `Tab from the coin search went to "${now.focus}"`);
      await page.keyboard.press("ArrowDown");
      now = await state(page);
      expectThat(now.focus === `coin ${now.rows[1]?.name}` && now.rows[1]?.active === true, `the down arrow in the list went to "${now.focus}"`);
      // The quiet line goes round the whole row, inside its edge.
      const rowLine = await page.evaluate(`(() => { const row = document.activeElement.closest(".picker-row"); const style = getComputedStyle(row); const own = getComputedStyle(document.activeElement); const probe = document.createElement("span"); document.body.append(probe); probe.style.color = "var(--focus-ring)"; const quiet = getComputedStyle(probe).color; probe.remove(); return style.outlineStyle + " " + style.outlineWidth + " " + (style.outlineColor === quiet ? "quiet" : style.outlineColor) + " " + style.outlineOffset + " / " + own.outlineStyle; })()`);
      expectThat(rowLine === "solid 1px quiet -2px / none", `a coin reached by the arrow keys wears "${rowLine}"`);
      // Right is the coin's link to the explorer, left comes back; the link is no Tab stop.
      await page.keyboard.press("ArrowRight");
      expectThat((await state(page)).focus === `link ${now.rows[1]?.name}`, `the right arrow on a coin went to "${(await state(page)).focus}"`);
      await page.screenshot({ path: path.join(out, `picker-walk-keys-list-1280-${theme}.png`) });
      shots += 1;
      await page.keyboard.press("ArrowLeft");
      expectThat((await state(page)).focus === `coin ${now.rows[1]?.name}`, "the left arrow did not come back from the link to its coin");
      await page.keyboard.press("End");
      expectThat((await state(page)).focus === `coin ${now.rows[now.rows.length - 1]?.name}`, "End did not go to the last coin");
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowUp");
      expectThat((await state(page)).focus === "coin search", "up from the first coin did not go to the coin search");
      await page.keyboard.press("Tab");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const wanted = (await state(page)).rows[2];
      await page.keyboard.press("Enter");
      await closed(page);
      await page.waitForTimeout(100);
      expectThat((await selector(page, "pay")) === `You pay: ${wanted?.symbol} on Base. Change coin`, `Enter on a coin in the list did not choose it (wanted ${wanted?.symbol}, the selector reads "${await selector(page, "pay")}")`);
      expectThat((await state(page)).focus.startsWith("selector You pay"), "focus did not return to the coin selector after a coin was chosen from the list");

      // ---- A pasted contract address goes to its own chain; one that is not listed says so ----
      const elsewhere = on("arb").find((token) => token.symbol === "USDC");
      await pay(page).click();
      await region(page).waitFor();
      await chainSearch(page).fill("bit");
      await coinSearch(page).fill(elsewhere?.contract ?? "");
      now = await state(page);
      expectThat(now.tiles.find((item) => item.chosen)?.name === "Arbitrum" && now.listName === "Coins on Arbitrum" && now.rows.length === 1 && now.rows[0]?.symbol === "USDC", `a pasted contract of USDC on Arbitrum shows ${JSON.stringify({ chosen: now.tiles.find((item) => item.chosen)?.name, list: now.listName, rows: now.rows.map((row) => row.symbol) })}`);
      expectThat(now.chainSearch === "" && now.tiles.length === chainCount, "the jump to the coin's chain left the chain search hiding it");
      // Its tile is in the part of the grid that is on show.
      const seenTile = await tile(page, "Arbitrum").evaluate((el) => {
        const grid = el.closest(".picker-chains")!.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return box.top >= grid.top - 1 && box.bottom <= grid.bottom - 23;
      });
      expectThat(seenTile, "the chain a pasted contract went to is not in view in the grid");
      await coinSearch(page).fill("0x1234567890123456789012345678901234567890");
      await page.getByText("Not supported.").waitFor({ timeout: 3000 });
      now = await state(page);
      expectThat(now.note === "Not supported." && now.rows.length === 0, `an address that is not listed shows "${now.note}" and ${now.rows.length} coins`);
      expectThat(now.tiles.find((item) => item.chosen)?.name === "Arbitrum", "an address that is not listed moved the picker to another chain");
      // A far chain: the picker goes there, and brings its tile up from below the fold.
      const farToken = on("sui").find((token) => token.contract !== null) ?? on("stellar").find((token) => token.contract !== null) ?? null;
      if (farToken !== null) {
        await coinSearch(page).fill(farToken.contract ?? "");
        now = await state(page);
        const farTile = now.tiles.find((item) => item.chosen);
        expectThat(now.rows.length === 1 && now.rows[0]?.symbol === farToken.symbol && farTile !== undefined && (now.grid?.top ?? 0) > 0, `a pasted contract on a chain far down the grid shows ${JSON.stringify({ chosen: farTile?.name, rows: now.rows.map((row) => row.symbol), scrolled: now.grid?.top })}`);
      } else complaints.push(`${label}: the coin list has no token on a chain far down the grid to paste`);
      expectThat((await state(page)).scrollY === before.scrollY, "a pasted address scrolled the page");

      // ---- No match on this chain: the matches on other chains, under their heading ----
      await tile(page, "Bitcoin").click();
      await coinSearch(page).fill("usdt");
      now = await state(page);
      // Each of them names its chain beside its symbol.
      expectThat(now.heading === "On other chains" && now.listName === "On other chains" && now.rows.length >= 3 && now.rows.every((row) => /^[^·]*usdt[^·]* · \S/i.test(row.symbol)) && now.rows[0]?.symbol === "USDT · BNB Chain", `searching Bitcoin's coins for "usdt" shows ${JSON.stringify({ heading: now.heading, rows: now.rows.map((row) => row.symbol) })}`);
      await page.screenshot({ path: path.join(out, `picker-walk-other-chains-1280-${theme}.png`) });
      shots += 1;
      await coinSearch(page).fill("zzzz");
      await page.getByText("No coins match.").waitFor({ timeout: 3000 });
      expectThat((await state(page)).heading === "", "with no match anywhere the heading for other chains is still there");
      // Choosing one of the other chains' coins chooses it, chain and all.
      await coinSearch(page).fill("usdt");
      const other = (await state(page)).rows[1];
      await page.locator(".picker-row").nth(1).click();
      await closed(page);
      expectThat((await selector(page, "pay")) === `You pay: ${other?.symbol.replace(" · ", " on ")}. Change coin`, `choosing "${other?.symbol}" from the other chains left the selector reading "${await selector(page, "pay")}"`);

      // ---- The coin on the other side is marked, and choosing it changes the two over ----
      const sides = { pay: await selector(page, "pay"), receive: await selector(page, "receive") };
      const otherChain = /on (.+)\. Change coin$/.exec(sides.receive)?.[1] ?? "";
      expectThat(sides.receive === receiving, `the coin received changed while only the coin paid was being chosen ("${receiving}" then "${sides.receive}")`);
      await pay(page).click();
      await region(page).waitFor();
      await tile(page, otherChain).click();
      const marked = page.locator(".picker-row", { hasText: "You receive" });
      expectThat((await marked.count()) === 1, `on ${otherChain} ${await marked.count()} coins are marked "You receive"`);
      await marked.click();
      await closed(page);
      const after = { pay: await selector(page, "pay"), receive: await selector(page, "receive") };
      const strip = (text: string) => text.replace(/^You (pay|receive): /, "");
      expectThat(strip(after.pay) === strip(sides.receive) && strip(after.receive) === strip(sides.pay), `picking the coin on the other side did not swap the two (${JSON.stringify(sides)} then ${JSON.stringify(after)})`);
      // And the same from the other side: the picker for the coin received marks the coin paid.
      await receive(page).click();
      await region(page, "receive").waitFor();
      now = await state(page);
      expectThat(now.title === "Select a token you receive" && now.tiles.find((item) => item.chosen)?.name === (/on (.+)\. Change coin$/.exec(after.receive)?.[1] ?? "?"), `the picker for the coin received opened as "${now.title}" with ${now.tiles.find((item) => item.chosen)?.name} chosen`);
      await page.locator(".picker-back").click();
      await closed(page);
      await page.waitForTimeout(100);
      expectThat((await state(page)).focus.startsWith("selector You receive"), `after the arrow closed the picker the focus is on "${(await state(page)).focus}", not the selector that opened it`);

      // ---- The browser's Back button returns to the swap; the next Back leaves, as before ----
      await pay(page).click();
      await region(page).waitFor();
      await page.goBack();
      await closed(page);
      await page.waitForTimeout(150);
      now = await state(page);
      expectThat(page.url() === home && !now.open && now.swapSeen, `Back from the picker left the page at ${page.url()} with the picker ${now.open ? "open" : "closed"}`);
      expectThat(now.focus.startsWith("selector You pay"), `after Back closed the picker the focus is on "${now.focus}"`);
      // Forward is the picker again; Esc from there goes back over its page of history.
      await page.goForward();
      await region(page).waitFor({ timeout: 3000 });
      await page.keyboard.press("Escape");
      await closed(page);
      await page.waitForTimeout(250);
      expectThat(page.url() === home, `after Forward and Esc the address shown is ${page.url()}`);
      await page.goBack();
      await page.waitForTimeout(400);
      expectThat(page.url() !== home, "with the picker closed, Back did not leave the page: the picker left a page of history behind");
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
      await page.screenshot({ path: path.join(out, "..", "..", "data", "stuck-picker-walk.png") }).catch(() => undefined);
    }
    await context.close();
  }

  // ---- The height: smooth, and the page never jumps. On a wide screen and a phone, at the top of the page and scrolled a little. ----
  for (const setup of [
    { width: 1280, height: 900, mobile: false, reduced: false, theme: "dark" },
    { width: 360, height: 780, mobile: true, reduced: false, theme: "dark" },
    { width: 360, height: 780, mobile: true, reduced: false, theme: "light" },
    { width: 1280, height: 900, mobile: false, reduced: true, theme: "light" },
  ] as const) {
    const label = `picker height ${setup.width} ${setup.theme}${setup.reduced ? ", less movement" : ""}`;
    const expectThat = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const context = await browser.newContext({ viewport: { width: setup.width, height: setup.height }, colorScheme: setup.theme, hasTouch: setup.mobile, isMobile: setup.mobile, reducedMotion: setup.reduced ? "reduce" : "no-preference" });
    await context.addInitScript(themed(setup.theme));
    const page = await context.newPage();
    page.on("pageerror", (error) => complaints.push(`${label}: page error: ${error.message}`));
    try {
      await visit(page, home);
      await pay(page).waitFor({ timeout: 20_000 });
      await page.waitForTimeout(500);
      for (const scrolled of [0, 48]) {
        await page.evaluate((y) => window.scrollTo(0, y), scrolled);
        await page.waitForTimeout(150);
        const start = await state(page);
        for (const [what, press] of [
          ["opening", "button.coin-button"],
          ["closing", ".picker-back"],
        ] as const) {
          const frames = (await page.evaluate(WATCH(press))) as Frame[];
          const [firstFrame, lastFrame] = [frames[0]!, frames[frames.length - 1]!];
          expectThat(frames.length >= 12, `${what}: only ${frames.length} frames were seen`);
          expectThat(frames.every((frame) => frame.y === firstFrame.y), `${what}, scrolled to ${scrolled}: the page scrolled (${[...new Set(frames.map((frame) => frame.y))].join(", ")})`);
          expectThat(frames.every((frame) => frame.top === firstFrame.top && frame.left === firstFrame.left && frame.width === firstFrame.width), `${what}, scrolled to ${scrolled}: the card's top, left or width moved (${JSON.stringify([...new Set(frames.map((frame) => `${frame.top}/${frame.left}/${frame.width}`))])})`);
          expectThat(firstFrame.height !== lastFrame.height, `${what}: the card's height did not change`);
          const [low, high] = [Math.min(firstFrame.height, lastFrame.height), Math.max(firstFrame.height, lastFrame.height)];
          expectThat(frames.every((frame) => frame.height >= low - 0.5 && frame.height <= high + 0.5), `${what}: the card's height went outside the two views' heights (${Math.min(...frames.map((frame) => frame.height))} to ${Math.max(...frames.map((frame) => frame.height))}, the views are ${low} and ${high})`);
          const steps = new Set(frames.map((frame) => frame.height)).size;
          const between = frames.filter((frame) => frame.height > low + 1 && frame.height < high - 1).length;
          if (setup.reduced) {
            expectThat(steps === 2 && between === 0 && frames.every((frame) => !frame.moving), `${what}: with less movement asked for, the height took ${steps} values and ${between} frames were part-way`);
          } else {
            // A change of some 150 px over a quarter of a second: many frames part-way, each one further along than the last.
            expectThat(between >= 6, `${what}: the height was part-way on only ${between} frames: it jumps instead of moving`);
            const growing = lastFrame.height > firstFrame.height;
            expectThat(frames.every((frame, index) => index === 0 || (growing ? frame.height >= frames[index - 1]!.height - 0.01 : frame.height <= frames[index - 1]!.height + 0.01)), `${what}: the height did not move one way only`);
            expectThat(!lastFrame.moving, `${what}: half a second on, the card is still marked as moving`);
          }
          const end = await state(page);
          expectThat(end.open === (what === "opening"), `${what}: the picker is ${end.open ? "open" : "closed"} afterwards`);
          // The height the page set for the change is taken away again: the card is its own height.
          expectThat((await page.locator(".card").evaluate((el) => (el as HTMLElement).style.height)) === "", `${what}: the card is left with a set height`);
        }
        const finish = await state(page);
        expectThat(finish.card.height === start.card.height && finish.scrollY === start.scrollY && finish.card.top === start.card.top, `after opening and closing, scrolled to ${scrolled}, the card is ${JSON.stringify(finish.card)} at ${finish.scrollY}; it was ${JSON.stringify(start.card)} at ${start.scrollY}`);
      }
      if (setup.reduced) {
        await pay(page).click();
        await region(page).waitFor();
        const still = await page.evaluate(`(() => ({ picker: getComputedStyle(document.querySelector(".card-picker")).animationName, card: getComputedStyle(document.querySelector(".card")).transitionDuration, view: getComputedStyle(document.querySelector(".card-swap")).transitionDuration }))()`) as { picker: string; card: string; view: string };
        expectThat(still.picker === "none" && /^0s(, 0s)*$/.test(still.card) && /^0s(, 0s)*$/.test(still.view), `with less movement asked for the picker still moves (${JSON.stringify(still)})`);
      } else if (!setup.mobile) {
        // The check above proves something: with movement allowed, the picker does slide and the height is animated.
        await pay(page).click();
        const moves = await page.evaluate(`(() => ({ picker: getComputedStyle(document.querySelector(".card-picker")).animationName, card: getComputedStyle(document.querySelector(".card")).transitionProperty + " " + getComputedStyle(document.querySelector(".card")).transitionDuration }))()`) as { picker: string; card: string };
        expectThat(moves.picker === "card-view-in" && moves.card === "height 0.25s", `with movement allowed the picker arrives with "${moves.picker}" and the card animates "${moves.card}"`);
        await region(page).waitFor();
      }
      if (setup.mobile) {
        // ---- On a phone: the same view inside the card, not a sheet; the page is free to scroll; the keyboard is not brought up ----
        await pay(page).click();
        await region(page).waitFor();
        await page.waitForTimeout(400);
        const now = await state(page);
        expectThat(now.open && now.inCard && !now.dialog && !now.locked, "on a phone the picker is not the same view inside the card");
        expectThat(now.columns === 2, `on a narrow phone the chains are ${now.columns} across, not two`);
        expectThat(now.focus === "title", `on a touch screen the focus on opening is on "${now.focus}" (a search field would bring the keyboard up unasked)`);
        expectThat(now.tiles.every((item) => item.h >= 44 && item.w === now.tiles[0]!.w), "on a phone a chain's tile is under 44 px or the tiles differ in size");
        const long = now.tiles.find((item) => item.name === "Robinhood Chain");
        expectThat(long !== undefined && long.ellipsis === "ellipsis", "a long chain name is not set to be cut short with an ellipsis");
        expectThat(now.rows.every((row) => row.h >= 44), "on a phone a coin's row is under 44 px");
        // Everything that can be pressed is at least 44 px. The small link to the explorer, which could not be that
        // without lying in the way of the row it is on, is left out on a touch screen: the contract stands alone.
        const reach = await page.evaluate(`(() => { const links = [...document.querySelectorAll(".picker-link")]; const back = getComputedStyle(document.querySelector(".picker-back"), "::after"); return { links: links.length, shown: links.filter((link) => getComputedStyle(link).display !== "none").length, contracts: document.querySelectorAll(".picker-row-contract").length, back: [parseFloat(back.width), parseFloat(back.height)], fields: [...document.querySelectorAll(".picker-search")].map((field) => field.getBoundingClientRect().height) }; })()`) as { links: number; shown: number; contracts: number; back: number[]; fields: number[] };
        expectThat(reach.back.every((side) => side >= 44) && reach.fields.length === 2 && reach.fields.every((height) => height >= 44), `on a touch screen something in the picker is under 44 px to press (${JSON.stringify(reach)})`);
        expectThat(reach.links > 0 && reach.shown === 0 && reach.contracts >= reach.links, `on a touch screen ${reach.shown} of ${reach.links} explorer links are shown, beside ${reach.contracts} contracts`);
        // The page behind is not held: it scrolls as ever, and comes back to where it was when the picker closes.
        const at = now.scrollY;
        await page.mouse.move(180, 120);
        await page.mouse.wheel(0, 320);
        await page.waitForTimeout(250);
        const moved = (await state(page)).scrollY;
        expectThat(moved > at, `with the picker open the page did not scroll (${at} then ${moved})`);
        await page.screenshot({ path: path.join(out, `picker-walk-scrolled-360-${setup.theme}.png`) });
        shots += 1;
        await page.locator(".picker-row").nth(1).click();
        await closed(page);
        await page.waitForTimeout(300);
        const back = await state(page);
        expectThat(back.scrollY === at, `after a coin was chosen with the page scrolled to ${moved}, the page is at ${back.scrollY}; it was at ${at} when the picker opened`);
        expectThat(back.card.top === now.card.top && back.card.x === now.card.x && back.card.width === now.card.width, "after the picker closed on a phone the card is not where it was");
      }
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    }
    await context.close();
  }

  return { complaints, shots };
}
