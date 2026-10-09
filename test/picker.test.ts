// The coin picker: a view of the swap card, chains first. What it draws, how it sits in the
// browser's history, and what the card does while it is open. The parts are drawn here as the
// browser would first draw them (to plain markup, without a browser), from fixed examples. Its
// rules of order and search are tested one by one in swap-logic.test.ts, and the whole of it is
// walked in a real browser by scripts/review-shots.ts (walk name: picker-keyboard).

import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenView } from "../shared/api.ts";
import { CoinPicker } from "../web/src/components/CoinPicker.tsx";
import { SwapCard } from "../web/src/components/SwapCard.tsx";
import { CHAIN_ORDER } from "../web/src/config.ts";
import { chainColour } from "../web/src/lib/icons.ts";
import { closePicker, openPicker, usePicker, watchPickerHistory } from "../web/src/stores/picker.ts";
import { useSwap } from "../web/src/stores/swap.ts";
import { useTokens } from "../web/src/stores/tokens.ts";
import { useWallet } from "../web/src/stores/wallet.ts";

const coin = (symbol: string, chain: string, name: string, extra: Partial<TokenView> = {}): TokenView => ({ id: `${chain}:${symbol}`, symbol, name, chain, decimals: 18, price: "1", contract: null, wallet: false, ...extra });
const ETH = coin("ETH", "base", "Ethereum", { wallet: true });
const USDC = coin("USDC", "base", "USD Coin", { decimals: 6, contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", wallet: true });
const WETH = coin("WETH", "base", "Wrapped Ether", { contract: "0x4200000000000000000000000000000000000006" });
const BRETT = coin("BRETT", "base", "Brett", { contract: "0x532f27101965dd16442e59d40670faf5ebb142e4" });
const USDT_SOL = coin("USDT", "sol", "Tether USD", { decimals: 6, contract: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" });
const SOL = coin("SOL", "sol", "Solana", { decimals: 9 });
const LIST = [WETH, coin("BTC", "btc", "Bitcoin", { decimals: 8 }), USDT_SOL, coin("wNEAR", "near", "Wrapped NEAR", { decimals: 24, contract: "wrap.near" }), BRETT, coin("ZEC", "zec", "Zcash", { decimals: 8 }), coin("BNB", "bsc", "BNB"), USDC, coin("ETH", "eth", "Ethereum"), SOL, ETH, coin("USDC", "hood", "USD Coin", { decimals: 6, contract: "0x5a1c0b3e9d2f4a6b8c7d9e0f1a2b3c4d5e6f7a8b" }), coin("TRX", "tron", "TRON", { decimals: 6 })];

/** Markup as text a person would read: tags out, spaces evened. */
const read = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

interface Held {
  tokens?: TokenView[];
  status?: "loading" | "ready";
  fromId?: string;
  toId?: string;
  picker?: "from" | "to" | null;
  balances?: Map<string, bigint>;
}

/**
 * A part of the site as it is first drawn. Drawn here, outside a browser, a component reads each
 * store's first state, so what the drawing needs is put there for its length and taken away again.
 */
function draw(element: ReactElement, held: Held = {}): string {
  const tokens = held.tokens ?? LIST;
  const wanted: [{ getInitialState(): object }, Record<string, unknown>][] = [
    [useTokens, { status: held.status ?? "ready", tokens, byId: new Map(tokens.map((token) => [token.id, token])) }],
    [useSwap, { fromId: held.fromId ?? ETH.id, toId: held.toId ?? USDT_SOL.id, amountText: "", pay: "manual", recipient: "", refundTo: "", quote: null, fetchedAt: 0, loading: false, dirty: false, problem: null, withoutPrivate: false }],
    [usePicker, { side: held.picker ?? null }],
    [useWallet, held.balances === undefined ? {} : { status: "connected", address: "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83", chain: "base", balances: held.balances }],
  ];
  const before = wanted.map(([store, values]) => {
    const first = store.getInitialState() as Record<string, unknown>;
    const kept = Object.fromEntries(Object.keys(values).map((key) => [key, first[key]]));
    Object.assign(first, values);
    return [first, kept] as const;
  });
  try {
    return renderToStaticMarkup(element);
  } finally {
    for (const [first, kept] of before) Object.assign(first, kept);
  }
}

const picker = (side: "from" | "to", held: Held = {}) => draw(createElement(CoinPicker, { side, onClose: () => undefined }), held);
/** The chain tiles of a drawing, in order: each one's chain, name, whether it is chosen, and whether Tab stops at it. */
const tiles = (html: string) =>
  [...html.matchAll(/<button type="button" role="option" class="chain-tile" aria-selected="(true|false)" tabindex="(-1|0)" data-chain="([a-z0-9]+)" title="([^"]*)" style="([^"]*)">([\s\S]*?)<\/button>/g)].map((match) => ({ chain: match[3]!, name: match[4]!, chosen: match[1] === "true", tabStop: match[2] === "0", style: match[5]!, inside: match[6]! }));
/** The rows of a drawing's list of coins, in order. */
const rows = (html: string) => [...html.matchAll(/<div role="row" class="picker-row"[^>]*>[\s\S]*?(?=<div role="row" class="picker-row"|<\/div><\/div><p class="sr-only" role="status">)/g)].map((match) => match[0]);
const names = (html: string) => rows(html).map((row) => /<span class="picker-row-name">([^<]*)<\/span>/.exec(row)?.[1] ?? "");

describe("the coin picker is a view of the swap card", () => {
  const card = (held: Held = {}) => draw(createElement(SwapCard), held);

  it("with the picker closed the card holds the swap alone, and nothing of it is held back", () => {
    const html = card();
    expect(html).toMatch(/^<section class="card" aria-labelledby="swap-title" data-view="swap">/);
    expect(html).toMatch(/<div class="card-view card-swap">/);
    expect(html).not.toMatch(/card-picker|inert/);
    // The two coin selectors open it. They are plain buttons: nothing is announced as about to pop up.
    expect(html.match(/<button type="button" class="coin-button">/g)).toHaveLength(2);
  });

  it.each([
    ["from", "Select a token you pay"],
    ["to", "Select a token you receive"],
  ] as const)("open for %s: the picker is inside the card, a region named by its title, and the swap can be neither reached nor read", (side, title) => {
    const html = card({ picker: side });
    expect(html).toMatch(/^<section class="card" aria-labelledby="swap-title" data-view="picker">/);
    // The swap is still there, to come back to, but inert: no key and no screen reader reaches into it.
    expect(html).toMatch(/<div class="card-view card-swap" inert="">/);
    // The picker is the card's own child, after the swap, and a region with a name.
    const region = /<\/div><div class="card-view card-picker" role="region" aria-labelledby="([^"]+)" data-side="(from|to)">/.exec(html);
    expect(region?.[2]).toBe(side);
    expect(html).toContain(`<h2 id="${region?.[1]}" class="picker-title" tabindex="-1">${title}</h2>`);
    expect(html.endsWith("</div></section>")).toBe(true);
    // A way back stands before the title, and is the first thing in the picker.
    expect(html).toMatch(/<div class="picker-head"><button type="button" class="picker-back" aria-label="Back to the swap" title="Back">/);
  });

  it("is never a window laid over the page: no dialog, no sheet, nothing dimmed", () => {
    const html = card({ picker: "from" });
    expect(html).not.toMatch(/<dialog|class="sheet|aria-modal|scrim|backdrop/);
    const source = fs.readFileSync(path.resolve("web", "src", "components", "CoinPicker.tsx"), "utf8");
    expect(source).not.toMatch(/Sheet|<dialog|showModal|dataset\.sheet/);
    // The card draws it, and no page does.
    expect(fs.readFileSync(path.resolve("web", "src", "components", "SwapCard.tsx"), "utf8")).toMatch(/\{views\.shown !== null \? <CoinPicker key=\{views\.shown\} side=\{views\.shown\} leaving=\{pickerSide === null\} onClose=\{closePicker\} \/> : null\}\s*<\/section>/);
    expect(fs.readFileSync(path.resolve("web", "src", "pages", "SwapPage.tsx"), "utf8")).not.toMatch(/CoinPicker|coin-from|coin-to/);
  });

  it("the old pop-up picker and its chain chips are gone", () => {
    const read = (file: string) => fs.readFileSync(path.resolve("web", "src", file), "utf8");
    expect(read("stores/sheet.ts")).toMatch(/export type SheetName = "review" \| "menu" \| "slippage";/);
    expect(read("config.ts")).not.toMatch(/FEATURED_CHAINS/);
    expect(read("lib/swap-logic.ts")).not.toMatch(/OTHER_CHAINS|FEATURED_CHAINS/);
    expect(read("components/CoinPicker.tsx")).not.toMatch(/button-chip|picker-chips|"All"|Other chains/);
    for (const sheet of fs.readdirSync(path.resolve("web", "src", "styles"))) expect(read(path.join("styles", sheet)), sheet).not.toMatch(/\.picker-chips|\.picker-empty/);
    expect(read("components/CoinButton.tsx")).not.toMatch(/aria-haspopup/);
  });

  it("while the picker has the card the quote is not refreshed, and giving the card back catches up, as with a sheet", () => {
    const store = fs.readFileSync(path.resolve("web", "src", "stores", "swap.ts"), "utf8");
    expect(store).toMatch(/sheetOpen: useSheet\.getState\(\)\.current !== null \|\| usePicker\.getState\(\)\.side !== null,/);
    expect(store).toMatch(/usePicker\.subscribe\(\(picker, previous\) => \{\s*if \(picker\.side === null && previous\.side !== null && due\(\)\) void fetchQuote\(\);\s*\}\);/);
  });
});

describe("the picker's top half: chains", () => {
  it("has its own search, then every chain on the coin list as a tile, in the set order and then by name", () => {
    const html = picker("from");
    expect(html.indexOf('placeholder="Search by chain name"')).toBeGreaterThan(0);
    expect(html.indexOf('placeholder="Search by chain name"')).toBeLessThan(html.indexOf('role="listbox" aria-label="Chain"'));
    // Only chains that have a coin on the list; the first eleven in the set order, the rest by name.
    expect(tiles(html).map((tile) => tile.name)).toEqual(["BNB Chain", "Ethereum", "Solana", "Bitcoin", "Base", "Tron", "NEAR", "Robinhood Chain", "Zcash"]);
    expect([...CHAIN_ORDER]).toEqual(["bsc", "eth", "sol", "btc", "base", "arb", "op", "pol", "avax", "tron", "ton"]);
    // With every one of the eleven on the list, that is the order of the grid's first eleven tiles.
    const eleven = picker("from", { tokens: [...CHAIN_ORDER].reverse().map((chain) => coin("X", chain, "X")), fromId: "base:X", toId: "sol:X" });
    expect(tiles(eleven).map((tile) => tile.chain)).toEqual([...CHAIN_ORDER]);
  });

  it("a tile is the chain's own mark at 24 px and its name, and carries the chain's colour for the stylesheet to wash it with", () => {
    for (const tile of tiles(picker("from"))) {
      expect(tile.style, tile.chain).toBe(`--chain-colour:${chainColour(tile.chain)}`);
      expect(tile.inside, tile.chain).toContain(`<span class="chain-tile-name">${tile.name}</span>`);
      // The artwork of the strip of chains: a drawing of the site's, or (for NEAR) one of the pictures it makes from a logo.
      expect(tile.inside, tile.chain).toContain(`<img class="chain-mark" src="/chains/${tile.chain}.${tile.chain === "near" ? "webp" : "svg"}" alt="" width="24" height="24" decoding="async" loading="lazy"/>`);
    }
  });

  it("opens with the chain already in use on that side chosen, and Tab stops at that one tile", () => {
    const paying = tiles(picker("from"));
    expect(paying.filter((tile) => tile.chosen).map((tile) => tile.chain)).toEqual(["base"]);
    expect(paying.filter((tile) => tile.tabStop).map((tile) => tile.chain)).toEqual(["base"]);
    const receiving = tiles(picker("to"));
    expect(receiving.filter((tile) => tile.chosen).map((tile) => tile.chain)).toEqual(["sol"]);
    expect(receiving.filter((tile) => tile.tabStop).map((tile) => tile.chain)).toEqual(["sol"]);
  });
});

describe("the picker's bottom half: coins of the chosen chain", () => {
  it("comes after a hairline, with its own search, and lists that chain's coins alone: its own coin, the stablecoins, the rest by name", () => {
    const html = picker("from");
    const order = ['role="listbox" aria-label="Chain"', '<hr class="picker-divider"/>', 'placeholder="Search by name or paste address"', 'role="grid" aria-label="Coins on Base"'].map((part) => html.indexOf(part));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(names(html)).toEqual(["Ethereum", "USD Coin", "Brett", "Wrapped Ether"]);
    expect(names(picker("to"))).toEqual(["Solana", "Tether USD"]);
    expect(picker("to")).toContain('role="grid" aria-label="Coins on Solana"');
    expect(read(html)).toMatch(/4 coins on Base$/);
  });

  it("a row is the coin's 32 px icon, its name, and beneath it the symbol with a shortened contract and a link to the chain's explorer", () => {
    const [own, usdc] = rows(picker("from"));
    expect(usdc).toContain('<span class="coin-icon" data-size="32" aria-hidden="true">');
    expect(usdc).toMatch(/<button type="button" class="picker-pick" tabindex="-1" aria-describedby="[^"]+"><span class="picker-row-name">USD Coin<\/span><\/button>/);
    expect(usdc).toMatch(/<span id="[^"]+" class="picker-row-symbol">USDC<\/span><span class="picker-row-contract mono">0x83…2913<\/span><a class="picker-link" href="https:\/\/basescan\.org\/token\/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-label="USDC on the Base block explorer"/);
    // A chain's own coin has no contract: its symbol stands alone.
    expect(own).toContain('<span class="picker-row-name">Ethereum</span>');
    expect(own).toMatch(/class="picker-row-symbol">ETH<\/span><\/span>/);
    expect(own).not.toMatch(/picker-row-contract|picker-link/);
    // On a chain whose explorer the site has no address page for, the contract is shown without a link.
    const tether = rows(picker("to"))[1]!;
    expect(tether).toMatch(/class="picker-row-symbol">USDT<\/span><span class="picker-row-contract mono">Es9v…wNYB<\/span><\/span>/);
    expect(tether).not.toContain("picker-link");
  });

  it("the whole row chooses the coin; the link is the one other thing on it, and the arrow keys reach it, not Tab", () => {
    const html = picker("from");
    // One coin in the list is a Tab stop: the one Enter would choose. It starts at the top.
    expect(rows(html).map((row) => /class="picker-pick" tabindex="(-1|0)"/.exec(row)?.[1])).toEqual(["0", "-1", "-1", "-1"]);
    expect(rows(html)[0]).toContain('data-index="0" data-active="true"');
    expect(html).not.toMatch(/class="picker-link"[^>]*tabindex="0"/);
    // The search field says which row that is, to a screen reader, while the keyboard stays in the field.
    const active = /aria-controls="([^"]+)" aria-activedescendant="([^"]+)"/.exec(html);
    expect(html).toContain(`<div id="${active?.[1]}" class="picker-list" role="grid"`);
    expect(rows(html)[0]).toContain(`<span role="gridcell" id="${active?.[2]}" class="picker-row-main">`);
    expect(html).toMatch(/role="combobox" aria-haspopup="grid" aria-expanded="true"/);
  });

  it("marks the coin in use on this side, and the coin on the other side by what it is there", () => {
    // Both coins on one chain, so both are in the list that opens.
    const paying = rows(picker("from", { fromId: ETH.id, toId: USDC.id }));
    expect(paying[0]).toMatch(/^<div role="row" class="picker-row" aria-selected="true"/);
    expect(read(paying[0]!)).toBe("Ethereum ETH Chosen");
    expect(paying[1]).toMatch(/^<div role="row" class="picker-row" aria-selected="false"/);
    expect(read(paying[1]!)).toBe("USD Coin USDC 0x83…2913 You receive");
    // Any other coin carries no mark.
    expect(read(paying[3]!)).toBe("Wrapped Ether WETH 0x42…0006");
    const receiving = rows(picker("to", { fromId: ETH.id, toId: USDC.id }));
    expect(read(receiving[0]!)).toBe("Ethereum ETH You pay");
    expect(read(receiving[1]!)).toBe("USD Coin USDC 0x83…2913 Chosen");
    // Choosing the coin on the other side is left to the swap's own rule, which changes the two over.
    expect(fs.readFileSync(path.resolve("web", "src", "components", "CoinPicker.tsx"), "utf8")).toMatch(/const pick = \(token: TokenView\) => \{\s*if \(side === "from"\) setFrom\(token\.id\);\s*else setTo\(token\.id\);\s*onClose\(\);\s*\};/);
    expect(fs.readFileSync(path.resolve("web", "src", "stores", "swap.ts"), "utf8")).toMatch(/if \(id === toId\) set\(\{ fromId: id, toId: fromId, refundTo: "", recipient: "" \}\);/);
  });

  it("with a wallet connected, what it holds of a coin stands at the end of the coin's row", () => {
    const held = rows(picker("from", { balances: new Map([[USDC.id, 1_250_500_000n], [BRETT.id, 0n]]) }));
    expect(held[1]).toMatch(/<span role="gridcell" id="[^"]+" class="picker-row-end"><span class="picker-row-balance muted">/);
    expect(read(held[1]!)).toMatch(/^USD Coin USDC 0x83…2913 1,250\.50 /);
    // Nothing held, or nothing known: nothing shown.
    expect(held[0]).not.toContain("picker-row-balance");
    expect(held[2]).not.toContain("picker-row-balance");
    expect(rows(picker("from")).join("")).not.toContain("picker-row-balance");
    // A balance moves no row.
    expect(names(picker("from", { balances: new Map([[WETH.id, 5n]]) }))).toEqual(["Ethereum", "USD Coin", "Brett", "Wrapped Ether"]);
  });

  it("while the coin list is on its way, shows placeholders in both halves and nothing that can be pressed there", () => {
    const html = picker("from", { tokens: [], status: "loading" });
    expect(html.match(/class="skeleton skeleton-tile"/g)).toHaveLength(12);
    expect(html.match(/class="skeleton skeleton-icon"/g)).toHaveLength(5);
    expect(html).not.toMatch(/role="(listbox|option|grid|row)"/);
    expect(html).toMatch(/role="combobox" aria-haspopup="grid" aria-expanded="false" aria-autocomplete="list"/);
    // The way back is still there.
    expect(html).toContain('class="picker-back"');
  });
});

describe("the picker in the browser's history", () => {
  /** A browser's history and its events, as far as the picker uses them. Going back and forward arrive a moment later, as in a browser. */
  function browser() {
    const pages: unknown[] = [null];
    let at = 0;
    const listeners: { fn: () => void; once: boolean }[] = [];
    const arrive = () => {
      for (const listener of [...listeners]) {
        if (listener.once) listeners.splice(listeners.indexOf(listener), 1);
        listener.fn();
      }
    };
    const pushed: unknown[][] = [];
    const window = {
      history: {
        get state() {
          return pages[at];
        },
        pushState(...args: unknown[]) {
          pushed.push(args);
          pages.splice(at + 1);
          pages.push(args[0]);
          at += 1;
        },
        back() {
          queueMicrotask(() => {
            if (at === 0) return;
            at -= 1;
            arrive();
          });
        },
        forward() {
          queueMicrotask(() => {
            if (at === pages.length - 1) return;
            at += 1;
            arrive();
          });
        },
      },
      addEventListener(type: string, fn: () => void, options?: { once?: boolean }) {
        if (type === "popstate") listeners.push({ fn, once: options?.once === true });
      },
      removeEventListener(type: string, fn: () => void) {
        const index = listeners.findIndex((listener) => listener.fn === fn);
        if (type === "popstate" && index !== -1) listeners.splice(index, 1);
      },
    };
    vi.stubGlobal("window", window);
    return { window, pushed, pages: () => pages.length, at: () => at, listeners: () => listeners.length };
  }
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  let stop: () => void = () => undefined;
  afterEach(() => {
    stop();
    stop = () => undefined;
    vi.unstubAllGlobals();
  });

  it("opening adds one page of history under the same address; the browser's Back closes the picker, and the next Back is the one that leaves", async () => {
    const tab = browser();
    stop = watchPickerHistory();
    expect(usePicker.getState().side).toBeNull();
    openPicker("from");
    expect(usePicker.getState().side).toBe("from");
    // One page more, and no address given for it: the address shown stays as it was.
    expect(tab.pages()).toBe(2);
    expect(tab.pushed).toEqual([[{ picker: "from" }, ""]]);
    tab.window.history.back();
    await settled();
    expect(usePicker.getState().side).toBeNull();
    // Back on the page the picker was opened from: the next Back is the browser's own, as before.
    expect(tab.at()).toBe(0);
    // Forward opens the picker again, for the side it was open for.
    tab.window.history.forward();
    await settled();
    expect(usePicker.getState().side).toBe("from");
  });

  it("closing it any other way (Esc, the arrow, a coin chosen) closes it at once and goes back over its page, so Back does not open it again", async () => {
    const tab = browser();
    stop = watchPickerHistory();
    openPicker("to");
    closePicker();
    // At once on the page; the browser follows.
    expect(usePicker.getState().side).toBeNull();
    await settled();
    expect(tab.at()).toBe(0);
    expect(usePicker.getState().side).toBeNull();
    // Closing what is not open goes nowhere.
    closePicker();
    await settled();
    expect(tab.at()).toBe(0);
  });

  it("opened again before the browser has gone back, the picker waits for it: history never piles up", async () => {
    const tab = browser();
    stop = watchPickerHistory();
    openPicker("from");
    closePicker();
    openPicker("to");
    // Not yet: the browser is still on its way back from the first.
    expect(usePicker.getState().side).toBeNull();
    await settled();
    expect(usePicker.getState().side).toBe("to");
    expect(tab.pages()).toBe(2);
    expect(tab.at()).toBe(1);
    // Closing twice in a row goes back once.
    closePicker();
    closePicker();
    await settled();
    expect(tab.at()).toBe(0);
  });

  it("a card that comes onto the page on a picker's page of history (a reload there, Back from another page) starts closed, and the browser is taken back off that page, once", async () => {
    const tab = browser();
    // Another page, then the swap page, then the picker opened on it.
    tab.window.history.pushState(null, "", "/");
    tab.window.history.pushState({ picker: "to" }, "");
    stop = watchPickerHistory();
    // Closed from the first moment, not opened and then closed.
    expect(usePicker.getState().side).toBeNull();
    // The card being drawn a second time before the browser has gone back (as a development build does) goes back no further.
    stop();
    stop = watchPickerHistory();
    expect(usePicker.getState().side).toBeNull();
    await settled();
    // On the swap page's own page of history, one step back and no more: the next Back is the browser's own.
    expect(tab.at()).toBe(1);
    expect(tab.pages()).toBe(3);
    expect(usePicker.getState().side).toBeNull();
    // From here it is the picker's page as ever: Forward opens it, and it closes over its page.
    tab.window.history.forward();
    await settled();
    expect(usePicker.getState().side).toBe("to");
    closePicker();
    await settled();
    expect(tab.at()).toBe(1);
    // A coin selector opens it as before, on one page of history.
    openPicker("from");
    expect(usePicker.getState().side).toBe("from");
    expect(tab.at()).toBe(2);
    expect(tab.pages()).toBe(3);
  });

  it("the swap card leaving the page closes the picker and listens no more, and a page of history that is something else's opens nothing", async () => {
    const tab = browser();
    stop = watchPickerHistory();
    openPicker("to");
    expect(usePicker.getState().side).toBe("to");
    stop();
    stop = () => undefined;
    expect(usePicker.getState().side).toBeNull();
    expect(tab.listeners()).toBe(0);
    tab.window.history.pushState({ something: "else" }, "", "/docs");
    stop = watchPickerHistory();
    expect(usePicker.getState().side).toBeNull();
    await settled();
    // Nothing was a picker's page there: the browser was taken nowhere.
    expect(tab.at()).toBe(2);
  });
});
