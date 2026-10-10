// Ghost mode: the switch and what it does on the page's side. While it is on, the site keeps
// nothing in the browser but the mode's own flag, fetches no wallet software, holds itself to its
// own origin by a content policy of its own, and marks the orders it makes.
//
// The stores are driven here as a page drives them, against a stand-in for the browser's storage
// that writes down every write. The parts that are drawn are drawn as the browser first draws them
// (to plain markup, without a browser).

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderView, QuoteView, TokenView } from "../shared/api.ts";
import { inlineScriptHashes } from "../server/static.ts";
import { CoinPicker } from "../web/src/components/CoinPicker.tsx";
import { GHOST_CHANGES, GHOST_STILL, GhostSheet } from "../web/src/components/GhostSheet.tsx";
import { MenuSheet } from "../web/src/components/MenuSheet.tsx";
import { LeavesSite, OutboundLink } from "../web/src/components/OutboundLink.tsx";
import { GHOST_ORDER_LINE, GHOST_REWARDS_HINT, ReviewSheet } from "../web/src/components/ReviewSheet.tsx";
import { Header } from "../web/src/components/Shell.tsx";
import { SocialLinks } from "../web/src/components/Social.tsx";
import { SwapCard } from "../web/src/components/SwapCard.tsx";
import { WalletPay } from "../web/src/components/WalletPay.tsx";
import { useApp } from "../web/src/stores/app.ts";
import { GHOST_POLICY, ghostChoice, useGhost } from "../web/src/stores/ghost.ts";
import { usePicker } from "../web/src/stores/picker.ts";
import { useSheet } from "../web/src/stores/sheet.ts";
import { useSwap } from "../web/src/stores/swap.ts";
import { useTokens } from "../web/src/stores/tokens.ts";
import { useWallet } from "../web/src/stores/wallet.ts";

// The two modules through which wallet software reaches the page. Here each only notes that it was fetched.
const walletCode = vi.hoisted(() => ({ fetched: 0, signIn: 0 }));
vi.mock("../web/src/wallet/index.ts", () => {
  walletCode.fetched += 1;
  return { connect: async () => undefined, disconnect: async () => undefined, switchTo: async () => undefined, pay: async () => "0x", wasRejected: () => false };
});
vi.mock("../web/src/wallet/sign-in.ts", () => {
  walletCode.signIn += 1;
  return { signPlainMessage: async () => "0x" };
});

const root = path.resolve("web", "src");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const page = fs.readFileSync(path.resolve("web", "index.html"), "utf8");
/** Markup as a person reads it: tags out, spaces evened. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// Made up from fixed text, so it is nobody's.
const ADDRESS = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
const coin = (symbol: string, chain: string, name: string, extra: Partial<TokenView> = {}): TokenView => ({ id: `${chain}:${symbol}`, symbol, name, chain, decimals: 18, price: "1", contract: null, wallet: false, ...extra });
const ETH = coin("ETH", "base", "Ethereum", { wallet: true });
const USDC = coin("USDC", "base", "USD Coin", { decimals: 6, contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", wallet: true });
const WETH = coin("WETH", "base", "Wrapped Ether", { contract: "0x4200000000000000000000000000000000000006" });
const USDT = coin("USDT", "sol", "Tether USD", { decimals: 6, contract: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" });
const LIST = [WETH, ETH, USDC, USDT];
const QUOTE: QuoteView = {
  from: ETH.id,
  to: USDT.id,
  amountIn: "500000000000000000",
  amountOut: "1261340512",
  minAmountOut: "1248727106",
  amountInUsd: "1265.13",
  amountOutUsd: "1260.59",
  slippageBps: 100,
  timeEstimate: 34,
  fees: { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "1000000000000000" },
  withdrawFee: "302700",
  refundFee: null,
  priceImpactBps: 36,
  serverNow: "2026-10-08T12:00:00.000Z",
};
const order = (id: string, at: string): Pick<OrderView, "id" | "createdAt" | "from" | "to"> => ({ id, createdAt: at, from: { id: ETH.id, symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null }, to: { id: USDT.id, symbol: "USDT", name: "Tether USD", chain: "sol", decimals: 6, contract: USDT.contract } });
const EARLIER = [order("EarlierOrder000000000000002", "2026-10-07T10:00:00.000Z"), order("EarlierOrder000000000000001", "2026-10-06T10:00:00.000Z")];
const earlierList = () => JSON.stringify(EARLIER.map((made) => ({ id: made.id, createdAt: made.createdAt, from: { symbol: made.from.symbol, chain: made.from.chain, decimals: made.from.decimals }, to: { symbol: made.to.symbol, chain: made.to.chain, decimals: made.to.decimals } })));
const SENT_NOTE = JSON.stringify({ [EARLIER[0]!.id]: { hash: `0x${"ab".repeat(32)}`, at: 1_790_000_000_000 } });
const COINS_KEPT = () => JSON.stringify({ savedAt: Date.now(), tokens: LIST });
/** What a wallet library leaves in a browser, under names of many kinds. One of them names the wallet's address. */
const LEFT_BY_THE_LIBRARY = { "@appkit/connections": `{"eip155":[{"accounts":[{"address":"${ADDRESS}"}]}]}`, "wagmi.store": `{"state":{"current":"x"}}`, "wc@2:core:0.3//keychain": "{}", WALLETCONNECT_DEEPLINK_CHOICE: "{}", "W3M_RECENT": "[]", "-walletlink:https://www.walletlink.org:version": "4", "some-other-name": "1" };

// ---- The browser, stood in for ----

/** One of the browser's two storages: it keeps what it is given, and writes down every write. */
function shelf(start: Record<string, string> = {}) {
  const held = new Map(Object.entries(start));
  const writes: string[] = [];
  const storage = {
    get length() {
      return held.size;
    },
    key: (index: number) => [...held.keys()][index] ?? null,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(`set ${key}`);
      held.set(key, String(value));
    },
    removeItem: (key: string) => {
      writes.push(`remove ${key}`);
      held.delete(key);
    },
  };
  return { storage, held, writes, keys: () => [...held.keys()].sort() };
}

interface Tab {
  local: ReturnType<typeof shelf>;
  session: ReturnType<typeof shelf>;
  /** What is in the page's head, as far as a policy goes. */
  head: { httpEquiv?: string; content?: string }[];
  dataset: Record<string, string>;
  reloads: { count: number };
  /** Databases removed. */
  dropped: string[];
  /** Every address asked for with fetch. */
  asked: string[];
}

/** A tab of a browser: its two storages, its databases, the page's head and root, and the site's own server. */
function tab(options: { local?: Record<string, string>; session?: Record<string, string>; databases?: string[]; lessMotion?: boolean; coinsDown?: boolean } = {}): Tab {
  const local = shelf(options.local);
  const session = shelf(options.session);
  const head: Tab["head"] = [];
  const dataset: Record<string, string> = { theme: "light" };
  const reloads = { count: 0 };
  const dropped: string[] = [];
  const asked: string[] = [];
  vi.stubGlobal("localStorage", local.storage);
  vi.stubGlobal("sessionStorage", session.storage);
  vi.stubGlobal("indexedDB", { databases: async () => (options.databases ?? []).filter((name) => !dropped.includes(name)).map((name) => ({ name, version: 1 })), deleteDatabase: (name: string) => void dropped.push(name) });
  vi.stubGlobal("document", {
    documentElement: { dataset },
    head: { append: (element: Tab["head"][number]) => void head.push(element), querySelector: () => head.find((element) => element.httpEquiv === "Content-Security-Policy") ?? null },
    createElement: () => ({}),
    hidden: false,
    addEventListener: () => undefined,
  });
  vi.stubGlobal("window", {
    location: { reload: () => void (reloads.count += 1), search: "", pathname: "/", origin: "https://intentswap.example", host: "intentswap.example" },
    // Less movement is asked for unless a test says otherwise: a change of cast is then simply made.
    matchMedia: () => ({ matches: options.lessMotion ?? true }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    scrollTo: () => undefined,
  });
  const now = () => new Date().toISOString();
  vi.stubGlobal("fetch", async (input: unknown) => {
    const address = String(input);
    asked.push(address);
    if (address === "/api/config") return new Response(JSON.stringify({ session: "s", sessionExpiresAt: new Date(Date.now() + 1_800_000).toISOString(), serverNow: now(), practice: true, sampleOrders: ["SampleOrder0000000000000001"], paused: false, privacyMode: "public", termsVersion: "2026-01-01" }));
    if (address === "/api/status") return new Response(JSON.stringify({ status: "ok", serverNow: now() }));
    if (address === "/api/tokens") {
      if (options.coinsDown) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ tokens: LIST }));
    }
    if (address.startsWith("/api/orders/")) return new Response(JSON.stringify({ ...order(address.split("/").pop() ?? "", "2026-10-05T10:00:00.000Z") }));
    return new Promise<Response>(() => undefined);
  });
  return { local, session, head, dataset, reloads, dropped, asked };
}

/** The site's stores, loaded afresh, as a page that has just been loaded has them. */
async function loaded() {
  vi.resetModules();
  const kept = await import("../web/src/lib/kept.ts");
  const ghost = await import("../web/src/stores/ghost.ts");
  const wallet = await import("../web/src/stores/wallet.ts");
  const orders = await import("../web/src/stores/orders.ts");
  const tokens = await import("../web/src/stores/tokens.ts");
  const sent = await import("../web/src/stores/sent.ts");
  const app = await import("../web/src/stores/app.ts");
  const swap = await import("../web/src/stores/swap.ts");
  const stale = await import("../web/src/lib/stale.ts");
  const theme = await import("../web/src/theme.ts");
  const rewards = await import("../web/src/stores/rewards.ts");
  return { kept, ghost, wallet, orders, tokens, sent, app, swap, stale, theme, rewards };
}

const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-10-08T12:00:00.000Z") });
  walletCode.fetched = 0;
  walletCode.signIn = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the one thing kept: the switch itself, as a flag for this tab", () => {
  it("is one key with one value, in the tab's own storage and nowhere else", async () => {
    const browser = tab();
    const { ghost, kept } = await loaded();
    expect([ghost.GHOST_KEY, ghost.GHOST_ON]).toEqual(["ghost", "on"]);
    expect([ghost.ghostFlag(), ghost.ghostOn(), ghost.ghostHolds(), ghost.useGhost.getState().on]).toEqual([false, false, false, false]);
    await ghost.useGhost.getState().turnOn();
    expect(browser.session.held.get("ghost")).toBe("on");
    expect(browser.session.keys()).toEqual(["ghost"]);
    expect(browser.local.keys()).toEqual([]);
    expect([ghost.ghostFlag(), ghost.ghostOn(), kept.ghostHolds()]).toEqual([true, true, true]);
  });

  it("a page loaded with the flag set is in the mode from its first moment; any other value, or storage that cannot be read, is off", async () => {
    tab({ session: { ghost: "on" } });
    const on = await loaded();
    expect([on.ghost.useGhost.getState().on, on.ghost.ghostHolds(), on.ghost.useGhost.getState().explained]).toEqual([true, true, true]);
    for (const value of ["off", "1", "true", "ON", ""]) {
      tab({ session: { ghost: value } });
      expect((await loaded()).ghost.useGhost.getState().on, value).toBe(false);
    }
    tab();
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("refused"); } });
    expect((await loaded()).ghost.useGhost.getState().on).toBe(false);
    vi.stubGlobal("sessionStorage", undefined);
    expect((await loaded()).ghost.useGhost.getState().on).toBe(false);
  });

  it("where the flag cannot be kept the mode still turns on, and lasts until the page is loaded again", async () => {
    const browser = tab();
    vi.stubGlobal("sessionStorage", { length: 0, key: () => null, getItem: () => null, setItem: () => { throw new Error("no room"); }, removeItem: () => undefined });
    const { ghost } = await loaded();
    await ghost.useGhost.getState().turnOn();
    expect([ghost.ghostOn(), ghost.ghostHolds()]).toEqual([true, true]);
    expect(browser.reloads.count).toBe(0);

    // Not even with wallet software in the page is such a page loaded again: it would come back out of the mode.
    // It turns on where it stands, and what the software writes as it tidies up is cleared a moment later.
    const other = tab({ local: LEFT_BY_THE_LIBRARY });
    vi.stubGlobal("sessionStorage", { length: 0, key: () => null, getItem: () => null, setItem: () => { throw new Error("no room"); }, removeItem: () => undefined });
    const site = await loaded();
    site.wallet.walletSoftwareArrived({ disconnect: async () => void setTimeout(() => other.local.storage.setItem("@appkit/connection_status", "disconnected"), 300) });
    site.wallet.useWallet.setState({ status: "connected", address: ADDRESS, chain: "base" });
    const turning = site.ghost.useGhost.getState().turnOn();
    await settle(100);
    await turning;
    expect([other.reloads.count, site.ghost.ghostOn(), other.local.keys()]).toEqual([0, true, []]);
    await settle(400);
    expect(other.local.keys()).toEqual(["@appkit/connection_status"]);
    await settle(2000);
    expect([other.reloads.count, other.local.keys()]).toEqual([0, []]);
  });

  it("the explainer is for the first time the mode is turned on since the page was loaded, and that is remembered in memory only", async () => {
    const browser = tab();
    const { ghost } = await loaded();
    expect(ghost.useGhost.getState().explained).toBe(false);
    await ghost.useGhost.getState().turnOn();
    // For a moment its marks are coming in; after that they are simply there (a card drawn again later does not bring its mark in again).
    expect([ghost.useGhost.getState().explained, ghost.useGhost.getState().fresh]).toEqual([true, true]);
    await settle(500);
    expect([ghost.useGhost.getState().explained, ghost.useGhost.getState().fresh, ghost.useGhost.getState().on]).toEqual([true, false, true]);
    // Nothing says so in the browser: the flag is still all there is.
    expect([browser.session.keys(), browser.local.keys()]).toEqual([["ghost"], []]);
    // A page loaded in the mode did not turn it on where it stands: its marks do not come in as if it had.
    tab({ session: { ghost: "on" } });
    expect((await loaded()).ghost.useGhost.getState().fresh).toBe(false);
  });

  it("turning it off takes the flag away and loads the page again, which is what ends the mode", async () => {
    const browser = tab({ session: { ghost: "on" } });
    const { ghost, kept } = await loaded();
    ghost.useGhost.getState().turnOff();
    await settle();
    expect(browser.session.keys()).toEqual([]);
    expect(ghost.useGhost.getState().on).toBe(false);
    expect(browser.dataset.ghost).toBeUndefined();
    expect(browser.reloads.count).toBe(1);
    // Until that load the page is still held: it writes nothing, and the wallet software stays out of reach.
    expect(kept.ghostHolds()).toBe(true);
    // Off when it is already off: nothing happens, and nothing is loaded again.
    const idle = tab();
    const off = await loaded();
    off.ghost.useGhost.getState().turnOff();
    await settle();
    expect([idle.reloads.count, idle.session.writes]).toEqual([0, []]);
  });
});

describe("nothing is kept in the browser while the mode is on", () => {
  it("the flag is the only key written through a whole session: an order, other coins, the theme, a part that fails to load", async () => {
    const browser = tab({ session: { ghost: "on" } });
    const site = await loaded();
    // The page loads: its settings, the coin list.
    await site.app.useApp.getState().load();
    await site.tokens.useTokens.getState().load();
    await settle();
    expect(site.tokens.useTokens.getState().status).toBe("ready");
    // The orders a server names for its list are not so much as asked for: there is no list to put them on.
    expect(browser.asked.filter((address) => address.startsWith("/api/orders/"))).toEqual([]);
    // The card: the usual pair, other coins, an amount, a try at paying from a wallet.
    const leave = site.swap.visitSwap();
    const card = site.swap.useSwap.getState();
    card.setFrom(USDC.id);
    card.setTo(ETH.id);
    card.flip();
    card.setAmount("0.5");
    card.setPay("wallet");
    card.setSlippage(50);
    // An order is made, and the pay step's notes are asked for: every one of the stores' ways of keeping something.
    const made = order("MadeInGhostMode000000000001", "2026-10-08T12:00:00.000Z");
    site.orders.useOrders.getState().remember(made);
    site.orders.useOrders.getState().addOlder(EARLIER);
    site.orders.useOrders.getState().forget(made.id);
    site.orders.useOrders.getState().clear();
    site.sent.rememberAsking(made.id, Date.now());
    site.sent.rememberSent(made.id, `0x${"cd".repeat(32)}`, Date.now());
    site.sent.doneAsking(made.id);
    site.sent.forgetSent(made.id);
    // The theme, both ways.
    site.theme.setTheme("dark");
    site.theme.setTheme("light");
    // A part of the site that will not load.
    expect(site.stale.partFailedToLoad()).toBe("ask");
    // The wallet's store and the Rewards page's, asked for everything they do.
    await site.wallet.useWallet.getState().connect();
    await site.wallet.useWallet.getState().loadBalances(LIST, 0);
    await site.wallet.useWallet.getState().disconnect();
    await site.rewards.useRewards.getState().signIn(ADDRESS, 8453);
    leave();
    await settle(2000);

    expect(browser.local.writes).toEqual([]);
    expect(browser.session.writes).toEqual([]);
    expect([browser.local.keys(), browser.session.keys()]).toEqual([[], ["ghost"]]);
    expect(browser.dropped).toEqual([]);
  });

  it("every store reads as empty, whatever an earlier visit kept, and what it kept is not touched", async () => {
    const before = { "orders-v1": earlierList(), "coins-v1": COINS_KEPT(), "sent-v1": SENT_NOTE, "orders-seeded-v1": "1" };
    const browser = tab({ local: before, session: { ghost: "on", "reloaded-for-new-version": String(Date.now() - 1000) }, coinsDown: true });
    const site = await loaded();
    expect(site.orders.useOrders.getState().orders).toEqual([]);
    expect(site.sent.sentFor(EARLIER[0]!.id)).toBeNull();
    // The coin list that was kept is not read: with the server out of reach there is no list at all.
    await site.tokens.useTokens.getState().load();
    expect([site.tokens.useTokens.getState().status, site.tokens.useTokens.getState().tokens]).toEqual(["failed", []]);
    for (const item of Object.values(site.kept.KEPT)) expect(site.kept.readKept(item), item.key).toBeNull();
    // Clearing the list of orders, in the mode, clears nothing an earlier visit kept.
    site.orders.useOrders.getState().clear();
    site.orders.useOrders.getState().forget(EARLIER[0]!.id);
    expect(Object.fromEntries(browser.local.held)).toEqual(before);
    expect(browser.local.writes).toEqual([]);
    expect(browser.session.writes).toEqual([]);
  });

  it("an order made in the mode is added to no list, even by a stray call", async () => {
    tab({ session: { ghost: "on" } });
    const site = await loaded();
    site.orders.useOrders.getState().remember(order("MadeInGhostMode000000000001", "2026-10-08T12:00:00.000Z"));
    site.orders.useOrders.getState().addOlder(EARLIER);
    expect(site.orders.useOrders.getState().orders).toEqual([]);
    // Out of the mode the same calls do keep it: the check is one that can fail.
    const browser = tab();
    const plain = await loaded();
    plain.orders.useOrders.getState().remember(order("MadeInGhostMode000000000001", "2026-10-08T12:00:00.000Z"));
    expect(plain.orders.useOrders.getState().orders).toHaveLength(1);
    expect(browser.local.keys()).toEqual(["orders-v1"]);
  });

  it("a part that fails to load is not answered with a reload, which could not be noted: the page says at once that the site was updated", async () => {
    const browser = tab({ session: { ghost: "on" } });
    const site = await loaded();
    expect(site.stale.partFailedToLoad()).toBe("ask");
    expect(site.stale.partFailedToLoad()).toBe("ask");
    expect(browser.reloads.count).toBe(0);
    expect(browser.session.keys()).toEqual(["ghost"]);
    // Out of the mode the same failure is answered with one reload, and noted.
    const ordinary = tab();
    const plain = await loaded();
    expect(plain.stale.partFailedToLoad()).toBe("reloading");
    expect([ordinary.reloads.count, ordinary.session.keys()]).toEqual([1, ["reloaded-for-new-version"]]);
  });

  it("the earlier orders are still in the browser after the mode was on and off, and are shown again", async () => {
    const browser = tab({ local: { "orders-v1": earlierList(), "coins-v1": COINS_KEPT(), "sent-v1": SENT_NOTE, "orders-seeded-v1": "1", ...LEFT_BY_THE_LIBRARY }, session: { "reloaded-for-new-version": "1790000000000", "wc@2:client:0.3//session": "[]" }, databases: ["WALLET_CONNECT_V2_INDEXED_DB"] });
    const site = await loaded();
    expect(site.orders.useOrders.getState().orders.map((made) => made.id)).toEqual(EARLIER.map((made) => made.id));
    await site.ghost.useGhost.getState().turnOn();
    // On: the list on screen is empty, and what the browser holds of the site's own is as it was.
    expect(site.orders.useOrders.getState().orders).toEqual([]);
    expect(browser.local.keys()).toEqual(["coins-v1", "orders-seeded-v1", "orders-v1", "sent-v1"]);
    expect(browser.local.held.get("orders-v1")).toBe(earlierList());
    expect(browser.session.keys()).toEqual(["ghost", "reloaded-for-new-version"]);
    // What was not the site's own is gone, under whatever name, and so is every database.
    expect(browser.dropped).toEqual(["WALLET_CONNECT_V2_INDEXED_DB"]);
    // Off, and the page loaded again: the orders are there as before.
    site.ghost.useGhost.getState().turnOff();
    await settle();
    expect(browser.reloads.count).toBe(1);
    const again = await loaded();
    expect(again.ghost.useGhost.getState().on).toBe(false);
    expect(again.orders.useOrders.getState().orders.map((made) => made.id)).toEqual(EARLIER.map((made) => made.id));
    expect(again.sent.sentFor(EARLIER[0]!.id)).not.toBeNull();
  });

  it("\"Also clear what this browser already holds\" removes every key of the site's own and everyone else's, and leaves the flag", async () => {
    const browser = tab({ local: { "orders-v1": earlierList(), "coins-v1": COINS_KEPT(), "sent-v1": SENT_NOTE, "orders-seeded-v1": "1", ...LEFT_BY_THE_LIBRARY }, session: { "reloaded-for-new-version": "1790000000000", "wc@2:client:0.3//session": "[]" }, databases: ["WALLET_CONNECT_V2_INDEXED_DB", "another"] });
    const site = await loaded();
    await site.ghost.useGhost.getState().turnOn({ clear: true });
    expect([browser.local.keys(), browser.session.keys()]).toEqual([[], ["ghost"]]);
    expect(browser.dropped).toEqual(["WALLET_CONNECT_V2_INDEXED_DB", "another"]);
    expect(site.orders.useOrders.getState().orders).toEqual([]);
    // Off again, and the page loaded again: there is nothing to show.
    site.ghost.useGhost.getState().turnOff();
    await settle();
    expect((await loaded()).orders.useOrders.getState().orders).toEqual([]);
  });

  it("no file of the site but the one helper names the browser's storage, its databases, its cookies or its caches", () => {
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
    const NAMES = /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\s*\.\s*cookie|\bcaches\s*\.|\bcookieStore\b/;
    const all = files(root);
    expect(all.length).toBeGreaterThan(60);
    const naming = all.filter((file) => NAMES.test(fs.readFileSync(file, "utf8"))).map((file) => path.relative(root, file).split(path.sep).join("/"));
    expect(naming).toEqual(["lib/kept.ts"]);
    // The helper keeps the rule in one place: every read and write it offers asks first whether the page is held.
    const helper = read("lib/kept.ts");
    for (const way of ["export function readKept(item: Kept): string | null {\n  if (holding) return null;", "export function writeKept(item: Kept, value: string): boolean {\n  if (holding) return false;", "export function dropKept(item: Kept): void {\n  if (holding) return;", "  if (holding || storage(item.area) === null) return null;"]) expect(helper).toContain(way);
    // The page itself reads one thing a tab has kept, once: the flag (see the page's first script, below).
    expect(page.match(/sessionStorage|localStorage|indexedDB|document\.cookie/g)).toEqual(["sessionStorage"]);
    // The check can fail.
    for (const sample of ["localStorage.setItem(a, b)", "window.sessionStorage", "indexedDB.open(name)", "document.cookie = x", "await caches.open(v)"]) expect(NAMES.test(sample), sample).toBe(true);
    for (const sample of ["this tab's own session storage", "readKept(KEPT.orders)", "COINS_KEPT", "storage(area)"]) expect(NAMES.test(sample), sample).toBe(false);
  });
});

describe("no wallet software while the mode is on", () => {
  it("the door refuses: nothing is fetched by Connect, by a stray call for the software, by a balance, or by the Rewards page's store", async () => {
    const browser = tab({ session: { ghost: "on" } });
    const site = await loaded();
    walletCode.fetched = 0;
    walletCode.signIn = 0;
    // A press of Connect, if one could be made: the store does not so much as say "connecting".
    const said: string[] = [];
    const stop = site.wallet.useWallet.subscribe((state) => void said.push(state.status));
    await site.wallet.useWallet.getState().connect();
    stop();
    expect(said).toEqual([]);
    expect(site.wallet.useWallet.getState()).toMatchObject({ status: "disconnected", address: null, error: null });
    await expect(site.wallet.walletSoftware()).rejects.toThrow("In Ghost mode the wallet software is not loaded.");
    // A wallet that the store is told is connected (it cannot be, here) still has no balance read for it.
    site.wallet.useWallet.setState({ status: "connected", address: ADDRESS, chain: "base" });
    await site.wallet.useWallet.getState().loadBalances(LIST, 0);
    await site.wallet.useWallet.getState().refreshBalance(ETH);
    await site.wallet.useWallet.getState().disconnect();
    await site.rewards.useRewards.getState().signIn(ADDRESS, 8453);
    expect(site.rewards.useRewards.getState()).toMatchObject({ step: "idle", error: null, session: null });
    expect([walletCode.fetched, walletCode.signIn]).toEqual([0, 0]);
    // Not the wallet's code, and not a word to the server either: no balance, no code to sign.
    expect(browser.asked).toEqual([]);
  });

  it("out of the mode the same press of Connect does fetch it: the check is one that can fail", async () => {
    tab();
    const site = await loaded();
    walletCode.fetched = 0;
    await site.wallet.useWallet.getState().connect();
    expect(walletCode.fetched).toBe(1);
    await expect(site.wallet.walletSoftware()).resolves.toBeDefined();
  });

  it("there are two late imports of wallet code in the whole site, and each stands behind the mode", () => {
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
    const late = files(root)
      .flatMap((file) => [...fs.readFileSync(file, "utf8").matchAll(/\bimport\(\s*["']([^"']*wallet\/[^"']*)["']\s*\)/g)].map((match) => `${path.relative(root, file).split(path.sep).join("/")} -> ${match[1]}`))
      .sort();
    expect(late).toEqual(["stores/rewards.ts -> ../wallet/sign-in.ts", "stores/wallet.ts -> ../wallet/index.ts"]);
    // The one door, in the wallet's store: the refusal comes before the import, and everything that needs the software asks there.
    const store = read("stores/wallet.ts");
    expect(store).toMatch(/export async function walletSoftware\(\): Promise<WalletSoftware> \{\s*if \(ghostHolds\(\)\) throw new Error\("In Ghost mode the wallet software is not loaded\."\);\s*const fetched = import\("\.\.\/wallet\/index\.ts"\);/);
    expect(store.match(/import\(/g)).toHaveLength(1);
    expect(store).toMatch(/async connect\(\) \{\s*\/\/[^\n]*\n\s*if \(ghostHolds\(\)\) return;/);
    expect(store).toContain('if (get().status !== "connected" || address === null || ghostHolds()) return;');
    expect(read("components/WalletPay.tsx")).toContain("const lib = await walletSoftware().catch(() => null);");
    // The Rewards page's store: the refusal is the first thing the sign-in does.
    expect(read("stores/rewards.ts")).toMatch(/async signIn\(address, chainId = null\) \{\s*\/\/[^\n]*\n\s*if \(ghostHolds\(\)\) return;/);
    // And the module itself, were it already in the page: it sets nothing up, and reports nothing more of a wallet.
    const module = read("wallet/index.ts");
    expect(module).toMatch(/function setUp\(\): Promise<\{ kit: AppKit; wagmi: Config \}> \{\s*if \(ghostHolds\(\)\) return Promise\.reject\(/);
    expect(module).toContain("if (wagmi === null || ghostHolds()) return;");
    expect(module.trimEnd().endsWith("walletSoftwareArrived({ disconnect });")).toBe(true);
  });

  it("nothing the page loads at once, and no page fetched later, leads to wallet code except through those two", () => {
    // The site's own imports are followed from the page's first module, late imports of pages included, and the two doors left shut.
    const resolve = (from: string, target: string): string | null => {
      const base = path.resolve(path.dirname(from), target);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      return null;
    };
    const doors = new Set(["../wallet/index.ts", "../wallet/sign-in.ts"]);
    const seen = new Set<string>();
    const packages = new Set<string>();
    const queue = [path.join(root, "main.tsx")];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = fs.readFileSync(file, "utf8").replace(/^import type [^\n]*$/gm, "");
      for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) {
        const target = match[1]!;
        const lateDoor = doors.has(target) && new RegExp(`import\\(\\s*["']${target.replace(/[.\\/]/g, "\\$&")}["']`).test(text);
        if (lateDoor) continue;
        if (!target.startsWith(".")) packages.add(target);
        else {
          const next = resolve(file, target);
          if (next !== null && /\.tsx?$/.test(next)) queue.push(next);
        }
      }
    }
    const reached = [...seen].map((file) => path.relative(root, file).split(path.sep).join("/"));
    expect(reached.length).toBeGreaterThan(50);
    for (const expected of ["App.tsx", "components/Shell.tsx", "pages/RewardsPage.tsx", "pages/OrderPage.tsx", "stores/rewards.ts", "stores/wallet.ts", "components/WalletPay.tsx"]) expect(reached).toContain(expected);
    expect(reached.filter((file) => /^wallet\/(index|sign-in)\.ts$/.test(file))).toEqual([]);
    expect([...packages].filter((name) => /^(@wagmi\/|wagmi|@reown\/|@walletconnect\/|viem|ethers)/.test(name))).toEqual([]);
  });

  it("turning the mode on with a wallet connected disconnects it through the software that is there, forgets it, and clears every key but the site's own and the flag", async () => {
    const browser = tab({ local: { "orders-v1": earlierList(), "coins-v1": COINS_KEPT(), ...LEFT_BY_THE_LIBRARY }, databases: ["WALLET_CONNECT_V2_INDEXED_DB"] });
    const site = await loaded();
    // The wallet software arrives as a press of Connect brings it, and a wallet is connected.
    await site.wallet.useWallet.getState().connect();
    const disconnect = vi.fn(async () => {
      // As the library does: it tidies up after itself a moment later, and writes as it does.
      setTimeout(() => browser.local.storage.setItem("@appkit/connection_status", "disconnected"), 300);
    });
    site.wallet.walletSoftwareArrived({ disconnect });
    site.wallet.useWallet.setState({ status: "connected", address: ADDRESS, chain: "base", chainId: 8453, plain: true, balances: new Map([[ETH.id, 5n]]), unreadable: new Set([USDC.id]) });
    const fetchedBefore = walletCode.fetched;

    const turning = site.ghost.useGhost.getState().turnOn();
    await settle(5000);
    await turning;
    expect(disconnect).toHaveBeenCalledTimes(1);
    // Nothing was fetched in order to disconnect.
    expect(walletCode.fetched).toBe(fetchedBefore);
    const wallet = site.wallet.useWallet.getState();
    expect(wallet).toMatchObject({ status: "disconnected", address: null, chain: null, chainId: null, plain: null, error: null });
    expect([wallet.balances.size, wallet.unreadable.size]).toEqual([0, 0]);
    // The site's own stay, without "Also clear". Everything else is gone, with what the library wrote as it tidied up.
    expect([browser.local.keys(), browser.session.keys()]).toEqual([["coins-v1", "orders-v1"], ["ghost"]]);
    expect(JSON.stringify(Object.fromEntries(browser.local.held)).toLowerCase()).not.toContain(ADDRESS.slice(2).toLowerCase());
    expect(browser.dropped).toEqual(["WALLET_CONNECT_V2_INDEXED_DB"]);
    // Software that is in a page cannot be taken out of it: the page is loaded again, and comes back in the mode without it.
    expect(browser.reloads.count).toBe(1);
    walletCode.fetched = 0;
    const back = await loaded();
    expect([back.ghost.useGhost.getState().on, back.wallet.useWallet.getState().status, walletCode.fetched]).toEqual([true, "disconnected", 0]);
  });

  it("with \"Also clear\" and a wallet connected, the flag alone is left", async () => {
    const browser = tab({ local: { "orders-v1": earlierList(), "coins-v1": COINS_KEPT(), "sent-v1": SENT_NOTE, ...LEFT_BY_THE_LIBRARY }, session: { "wc@2:client:0.3//session": "[]" }, databases: ["WALLET_CONNECT_V2_INDEXED_DB"] });
    const site = await loaded();
    const disconnect = vi.fn(async () => undefined);
    site.wallet.walletSoftwareArrived({ disconnect });
    site.wallet.useWallet.setState({ status: "connected", address: ADDRESS, chain: "base" });
    const turning = site.ghost.useGhost.getState().turnOn({ clear: true });
    await settle(5000);
    await turning;
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect([browser.local.keys(), browser.session.keys()]).toEqual([[], ["ghost"]]);
    expect(browser.reloads.count).toBe(1);
  });

  it("a wallet that will not answer is not waited for without end, and a page with no wallet software in it is not loaded again", async () => {
    const browser = tab({ local: LEFT_BY_THE_LIBRARY });
    const site = await loaded();
    site.wallet.walletSoftwareArrived({ disconnect: () => new Promise<void>(() => undefined) });
    site.wallet.useWallet.setState({ status: "connected", address: ADDRESS, chain: "base" });
    const turning = site.ghost.useGhost.getState().turnOn();
    await settle(10_000);
    await turning;
    expect([browser.local.keys(), browser.session.keys(), site.wallet.useWallet.getState().status]).toEqual([[], ["ghost"], "disconnected"]);
    // No software in the page: the mode turns on where the page stands.
    const plain = tab({ local: LEFT_BY_THE_LIBRARY });
    const fresh = await loaded();
    await fresh.ghost.useGhost.getState().turnOn();
    expect([plain.reloads.count, fresh.ghost.useGhost.getState().on, plain.local.keys()]).toEqual([0, true, []]);
  });

  it("a card that was to be paid from a wallet is paid by hand from the moment the mode is on, and cannot be set back", async () => {
    tab();
    const site = await loaded();
    site.tokens.useTokens.setState({ status: "ready", tokens: LIST, byId: new Map(LIST.map((token) => [token.id, token])) });
    const leave = site.swap.visitSwap();
    site.swap.useSwap.getState().setFrom(ETH.id);
    expect(site.swap.useSwap.getState().pay).toBe("wallet");
    await site.ghost.useGhost.getState().turnOn();
    expect(site.swap.useSwap.getState().pay).toBe("manual");
    site.swap.useSwap.getState().setPay("wallet");
    expect(site.swap.useSwap.getState().pay).toBe("manual");
    // Another coin a wallet could pay, the two coins changed about, the card cleared and begun again: by hand every time.
    site.swap.useSwap.getState().setFrom(USDC.id);
    site.swap.useSwap.getState().flip();
    site.swap.useSwap.getState().flip();
    expect(site.swap.useSwap.getState().pay).toBe("manual");
    site.swap.useSwap.getState().reset();
    expect(site.swap.useSwap.getState().pay).toBe("manual");
    site.swap.useSwap.getState().init("");
    expect([site.swap.useSwap.getState().fromId, site.swap.useSwap.getState().pay]).toEqual([ETH.id, "manual"]);
    leave();
  });
});

describe("the page's own content policy in the mode", () => {
  const directives = Object.fromEntries(GHOST_POLICY.split("; ").map((part) => [part.split(" ")[0]!, part.split(" ").slice(1)]));
  /** Every directive under which a page fetches something, or sends something. */
  const FETCHING = ["default-src", "script-src", "style-src", "img-src", "font-src", "connect-src", "media-src", "manifest-src", "worker-src", "child-src", "frame-src", "object-src"];

  it("allows this site's own origin and nothing else, for every kind of request; no frame, worker, plug-in or form at all", () => {
    for (const name of FETCHING) expect(Object.keys(directives), name).toContain(name);
    for (const name of FETCHING) {
      const sources = directives[name]!.filter((source) => !(name === "style-src" && source === "'unsafe-inline'"));
      expect(sources.length, name).toBe(1);
      expect(["'self'", "'none'"], name).toContain(sources[0]);
    }
    for (const name of ["connect-src", "script-src", "img-src", "font-src", "default-src"]) expect(directives[name], name).toEqual(["'self'"]);
    for (const name of ["frame-src", "child-src", "worker-src", "object-src", "form-action", "base-uri"]) expect(directives[name], name).toEqual(["'none'"]);
    // Nothing in it names another address in any form: no scheme, no host, no wildcard, no data or blob address, no script written into the page.
    expect(GHOST_POLICY).not.toMatch(/https?:|wss?:|data:|blob:|\*|[a-z0-9-]+\.[a-z]{2,}/i);
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
    expect(GHOST_POLICY).not.toMatch(/unsafe-eval|strict-dynamic/);
    expect(Object.keys(directives)).toHaveLength(14);
  });

  it("is added to the page as the mode turns on, once, with the page's calmer cast; it stays when the mode is turned off, and the cast goes", async () => {
    const browser = tab();
    const { ghost } = await loaded();
    expect([browser.head, browser.dataset.ghost]).toEqual([[], undefined]);
    await ghost.useGhost.getState().turnOn();
    expect(browser.head).toEqual([{ httpEquiv: "Content-Security-Policy", content: GHOST_POLICY }]);
    expect(browser.dataset.ghost).toBe("on");
    ghost.useGhost.getState().turnOff();
    await settle();
    expect(browser.dataset.ghost).toBeUndefined();
    // A policy cannot be taken out of a page: the page is loaded again instead.
    expect(browser.head).toHaveLength(1);
    expect(browser.reloads.count).toBe(1);
  });

  it("a page loaded in the mode has it already, from its first script: the store does not add a second", async () => {
    const browser = tab({ session: { ghost: "on" } });
    browser.head.push({ httpEquiv: "Content-Security-Policy", content: GHOST_POLICY });
    await loaded();
    expect(browser.head).toHaveLength(1);
    expect(browser.dataset.ghost).toBe("on");
  });

  it("the cast changes inside one cross-fade where the browser can make one, and not at all where less movement is asked for", async () => {
    const browser = tab({ lessMotion: false });
    let fades = 0;
    (globalThis.document as unknown as { startViewTransition: unknown }).startViewTransition = (change: () => Promise<void>) => {
      fades += 1;
      const done = Promise.resolve().then(change);
      return { updateCallbackDone: done, finished: done };
    };
    const { ghost } = await loaded();
    const turning = ghost.useGhost.getState().turnOn();
    await settle(10);
    await turning;
    expect([fades, ghost.useGhost.getState().on, browser.dataset.ghost]).toEqual([1, true, "on"]);
    ghost.useGhost.getState().turnOff();
    // The page is loaded again only when the fade is over.
    expect(browser.reloads.count).toBe(0);
    await settle(10);
    expect([fades, browser.reloads.count]).toEqual([2, 1]);

    const still = tab({ lessMotion: true });
    (globalThis.document as unknown as { startViewTransition: unknown }).startViewTransition = () => {
      fades += 1;
      return { updateCallbackDone: Promise.resolve(), finished: Promise.resolve() };
    };
    const quiet = await loaded();
    await quiet.ghost.useGhost.getState().turnOn();
    expect([fades, quiet.ghost.useGhost.getState().on, still.dataset.ghost]).toEqual([2, true, "on"]);
  });

  describe("the page's first script", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
    /** The script, run as a browser runs it, on a page whose tab holds this flag. */
    const run = (flag: string | null | "refused", pathname = "/") => {
      const head: { httpEquiv?: string; content?: string }[] = [];
      const dataset: Record<string, string> = {};
      vm.runInNewContext(script, {
        document: { documentElement: { dataset }, head: { appendChild: (element: (typeof head)[number]) => void head.push(element) }, createElement: () => ({}) },
        sessionStorage: { getItem: (key: string) => { if (flag === "refused") throw new Error("refused"); return key === "ghost" ? flag : null; } },
        location: { pathname },
      });
      return { head, dataset };
    };

    it("is the page's one script written into it, and stands before everything the page fetches", () => {
      expect(page.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toHaveLength(1);
      expect(inlineScriptHashes(page)).toHaveLength(1);
      const at = page.indexOf("<script>");
      expect(at).toBeGreaterThan(0);
      for (const fetched of ["<link", "<script type=\"module\"", "<style", "<img", "og:image"]) {
        if (page.includes(fetched)) expect(page.indexOf(fetched), fetched).toBeGreaterThan(at);
      }
      // Only the two lines that say what kind of text the page is come before it.
      expect(page.slice(page.indexOf("<head>") + 6, at).trim().split("\n").map((line) => line.trim())).toEqual(['<meta charset="utf-8" />', '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />']);
    });

    it("writes the same policy, word for word, and the cast, when the tab was left in the mode", () => {
      expect(script).toContain(`policy.content = "${GHOST_POLICY}";`);
      const on = run("on");
      expect(on.head).toEqual([{ httpEquiv: "Content-Security-Policy", content: GHOST_POLICY }]);
      expect(on.dataset).toEqual({ ghost: "on", theme: "light", first: "home" });
      // The policy is written before anything else the script does.
      expect(script.indexOf("document.head.appendChild(policy);")).toBeLessThan(script.indexOf("document.documentElement.dataset.ghost"));
      expect(script.indexOf("document.documentElement.dataset.ghost")).toBeLessThan(script.indexOf("document.documentElement.dataset.theme"));
    });

    it("writes nothing of the mode for any other tab, and starts the page in the light theme either way", () => {
      for (const flag of [null, "off", "", "ON", "refused"] as const) {
        const off = run(flag, "/track");
        expect(off.head, String(flag)).toEqual([]);
        expect(off.dataset, String(flag)).toEqual({ theme: "light" });
      }
      expect(run("on", "/docs").dataset).toEqual({ ghost: "on", theme: "light" });
    });
  });
});

describe("an order made in the mode says so, and no other order says anything of it", () => {
  it("carries ghost: true; out of the mode the field is not there at all", () => {
    expect(ghostChoice(true)).toEqual({ ghost: true });
    expect(ghostChoice(false)).toEqual({});
    expect("ghost" in ghostChoice(false)).toBe(false);
    expect(JSON.stringify({ from: "a", ...ghostChoice(false) })).toBe('{"from":"a"}');
    expect(JSON.stringify({ from: "a", ...ghostChoice(true) })).toBe('{"from":"a","ghost":true}');
  });

  it("the review puts it into the request it makes, by the mode the page is in, and keeps the order in no list", () => {
    const review = read("components/ReviewSheet.tsx");
    const body = review.slice(review.indexOf("const body: CreateOrderBody & { requestId: string } = {"), review.indexOf("const order = await api.createOrder(body);"));
    expect(body).toContain("...ghostChoice(ghost),");
    expect(review).toContain("const ghost = useGhost((state) => state.on);");
    expect(review).toContain("if (!ghost) remember(order);");
    expect(review.match(/\bremember\(order\)/g)).toHaveLength(1);
    // Nowhere else is the field written, in any spelling.
    expect(review.replace("...ghostChoice(ghost),", "")).not.toMatch(/\bghost:\s*(true|false|ghost)/);
  });
});

// ---- What is drawn ----

/** A part of the site as it is first drawn, with the stores holding what the drawing needs for its length. */
function draw(element: ReactElement, held: { ghost?: boolean; wallet?: Record<string, unknown>; swap?: Record<string, unknown>; picker?: "from" | "to" | null; sheet?: string | null; config?: Record<string, unknown> | null } = {}): string {
  const wanted: [{ getInitialState(): object }, Record<string, unknown>][] = [
    [useGhost, { on: held.ghost ?? false, fresh: false }],
    [useTokens, { status: "ready", tokens: LIST, byId: new Map(LIST.map((token) => [token.id, token])) }],
    [useSwap, { fromId: ETH.id, toId: USDT.id, amountText: "", pay: "wallet", recipient: "", refundTo: "", quote: null, fetchedAt: 0, loading: false, dirty: false, problem: null, withoutPrivate: false, ...held.swap }],
    [usePicker, { side: held.picker ?? null }],
    [useSheet, { current: held.sheet ?? null }],
    [useWallet, held.wallet ?? {}],
    [useApp, { config: held.config ?? null }],
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
const CONNECTED = { status: "connected", address: ADDRESS, chain: "base", chainId: 8453, plain: true, balances: new Map([[ETH.id, 500_000_000_000_000_000n], [USDC.id, 1_250_500_000n], [WETH.id, 7n]]) };

describe("the switch in the header", () => {
  const header = (held: Parameters<typeof draw>[1] = {}) => draw(createElement(Header), held);
  const actions = (html: string) => /<div class="header-actions">([\s\S]*)<\/div><\/header>/.exec(html)?.[1] ?? "";

  it("off: a ghost button beside the theme switch, named \"Ghost mode\", not pressed, with its words for a wide screen; and Connect", () => {
    const html = actions(header());
    expect(html).toMatch(/<button type="button" class="button-icon header-theme"[^>]*>.*?<\/button><div class="ghost-dock"><button type="button" class="ghost-switch" aria-pressed="false" aria-label="Ghost mode"><svg[^>]*class="lucide lucide-ghost"[^>]*aria-hidden="true">.*?<\/svg><span class="ghost-switch-words">Ghost mode<\/span><\/button><\/div><button type="button" class="button-secondary button-wallet">/);
    expect(html).toContain("<span>Connect</span>");
    expect(html).not.toContain("ghost-pill");
    // The site's icon size and stroke, and no tooltip.
    expect(html).toMatch(/<svg[^>]*width="20" height="20"[^>]*stroke-width="1.5"[^>]*class="lucide lucide-ghost"/);
    expect(/<div class="ghost-dock">.*?<\/div>/.exec(html)?.[0]).not.toContain("title=");
  });

  it("on: the button is pressed, the pill stands in Connect's place and turns the mode off, and there is no Connect", () => {
    const html = actions(header({ ghost: true }));
    expect(html).toMatch(/<div class="ghost-dock" data-on="true"><button type="button" class="ghost-switch" aria-pressed="true" aria-label="Ghost mode">.*?<\/button><button type="button" class="ghost-pill" aria-label="Ghost mode is on\. Turn off"><svg[^>]*class="lucide lucide-ghost ghost-pill-glyph"[^>]*aria-hidden="true">.*?<\/svg>Ghost mode<\/button><\/div><button type="button" class="button-icon header-menu"/);
    expect(html).not.toMatch(/Connect|button-wallet|lucide-wallet/);
    expect(/<div class="ghost-dock".*?<\/div>/.exec(html)?.[0]).not.toContain("title=");
    // Whatever the wallet's store holds: a connected wallet's address is not in the header either.
    const held = actions(header({ ghost: true, wallet: CONNECTED }));
    expect(held).not.toMatch(/button-wallet|0xb559|Disconnect/);
    expect(header({ ghost: true, wallet: CONNECTED })).toMatch(/<header class="header" data-wallet="disconnected">/);
    // Out of the mode the same store does put it there.
    expect(actions(header({ wallet: CONNECTED }))).toContain("connected wallet. Disconnect");
  });

  it("a press opens the explainer the first time, and after that switches at once; on, it turns the mode off", () => {
    const shell = read("components/Shell.tsx");
    const press = shell.slice(shell.indexOf("function pressGhost(): void {"), shell.indexOf("function GhostDock()"));
    expect(press.replace(/\s+/g, " ")).toContain('if (!ghost.on && !ghost.explained) { sheet.open("ghost"); return; }');
    expect(press.replace(/\s+/g, " ")).toContain("if (ghost.on) ghost.turnOff(); else void ghost.turnOn();");
    expect(shell.match(/onClick=\{pressGhost\}/g)).toHaveLength(3);
    // The sheet is the header's to open, over the whole page, and only while it is asked for.
    expect(shell).toContain("{explaining ? <GhostSheet /> : null}");
    expect(header({ sheet: "ghost" })).toContain('<h2 id="');
    expect(header()).not.toContain("<dialog");
  });

  it("on a phone the switch is a line of the menu, which says in a word whether the mode is on", () => {
    const menu = (ghost: boolean) => /<button type="button" class="menu-link menu-ghost".*?<\/button>/.exec(draw(createElement(MenuSheet), { ghost }))?.[0] ?? "";
    expect(menu(false)).toMatch(/^<button type="button" class="menu-link menu-ghost" aria-pressed="false">Ghost mode<span class="menu-ghost-state" aria-hidden="true">Off<svg/);
    expect(menu(true)).toMatch(/^<button type="button" class="menu-link menu-ghost" aria-pressed="true">Ghost mode<span class="menu-ghost-state" aria-hidden="true">On<svg/);
    const css = fs.readFileSync(path.join(root, "styles", "ghost.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // Below 480 px the header has the pill and not the switch; from 480 px the switch is in the header and its line leaves the menu.
    expect(css).toMatch(/\.ghost-switch \{\s*display: none;/);
    expect(css).toMatch(/@media \(min-width: 480px\) \{\s*\.ghost-switch \{\s*display: inline-flex;\s*\}/);
    expect(css).toMatch(/@media \(min-width: 480px\) \{[\s\S]*?\.menu-ghost \{\s*display: none;\s*\}/);
    // Its words are shown from 1280 px, and only while it is off: on, the pill says them.
    expect(css).toMatch(/@media \(min-width: 1280px\) \{[\s\S]*?\.ghost-switch\[aria-pressed="false"\] > \.ghost-switch-words \{\s*display: inline;\s*\}/);
    // The pill is never hidden at any width.
    expect(css).not.toMatch(/\.ghost-pill \{[^}]*display: none/);
  });

  it("is quiet: the neutral tint, no border, no accent, and it stands still where less movement is asked for", () => {
    const css = fs.readFileSync(path.join(root, "styles", "ghost.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/var\(--accent\)|var\(--tint-accent\)/);
    const rules = [...css.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
    for (const rule of rules.filter((item) => /ghost-dock|ghost-switch|ghost-pill|card-ghost/.test(item.selector))) expect(rule.body, rule.selector).not.toMatch(/(?<![\w-])(?:border(?!-radius)[a-z-]*|outline[a-z-]*|box-shadow)\s*:/);
    expect(css).toMatch(/\.ghost-dock\[data-on\]::before \{[^}]*background: var\(--tint-ghost\);/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation: none;[\s\S]*?\.ghost-dock\[data-fresh\]::before,\s*\.ghost-dock\[data-fresh\] > \.ghost-pill,\s*\.card-ghost\[data-fresh\] \{\s*animation: none;\s*\}/);
    // The buttons are 44 px to press.
    expect(css).toMatch(/\.ghost-switch \{[^}]*min-width: var\(--height-44\);\s*height: var\(--height-44\);/);
    expect(css).toMatch(/\.ghost-pill \{[^}]*height: var\(--height-44\);/);
  });
});

describe("the sheet that explains the mode", () => {
  const sheet = () => draw(createElement(GhostSheet));

  it("says what changes in four plain lines, what does not, and that the switch is remembered for this tab only", () => {
    const html = sheet();
    expect(html).toMatch(/<h2 id="[^"]+" class="sheet-title">Ghost mode<\/h2>/);
    expect(GHOST_CHANGES.map((change) => change.key)).toEqual(["wallet", "requests", "browser", "record"]);
    const lines = [...html.matchAll(/<li class="ghost-point"><svg[^>]*aria-hidden="true">.*?<\/svg><span>([^<]*)<\/span><\/li>/g)].map((match) => words(match[1]!));
    expect(lines).toEqual([
      "No wallet is connected, and none of the wallet software is loaded. You pay by sending to the deposit address.",
      "This page asks nothing of any address but this site's own.",
      "Nothing is kept in this browser but the switch itself, for this tab only, so that loading the page again does not turn it off.",
      "An order you make is not listed among recent swaps, and its record is deleted from the server the moment it is delivered or refunded.",
    ]);
    expect(GHOST_STILL).toBe("Your deposit and your delivery are still public on their own chains, the swap service still carries out the swap, and your internet address is still seen by your network and by this site's host.");
    expect(words(html)).toContain(`${GHOST_STILL} More about Ghost mode`);
    expect(html).toContain('<a href="/docs/ghost-mode">More<span class="sr-only"> about Ghost mode</span></a>');
  });

  it("offers one extra thing, not ticked, and two buttons that stay in view: Turn on, and Not now", () => {
    const html = sheet();
    const foot = /<div class="sheet-foot">([\s\S]*)<\/div><\/div><\/dialog>$/.exec(html)?.[1] ?? "";
    expect(foot).toMatch(/^<label class="check ghost-clear"><input type="checkbox"\/><span>Also clear what this browser already holds<span class="ghost-clear-what muted">The list of orders made in this browser, and what a connected wallet left\.<\/span><\/span><\/label>/);
    expect(foot).not.toContain("checked");
    expect(foot).toMatch(/<div class="ghost-buttons"><button type="button" class="button-secondary">Not now<\/button><button type="button" class="button-primary">Turn on<\/button><\/div>$/);
    // "Not now", Close and Esc only close it. Turning on is the one thing that turns the mode on, with what was ticked.
    const source = read("components/GhostSheet.tsx");
    expect(source).toContain("<SecondaryButton onClick={close} disabled={turning}>");
    expect(source).toContain("void turnOn({ clear });");
    expect(source.match(/turnOn\(/g)).toHaveLength(1);
    expect(source).toContain('title="Ghost mode"');
    expect(source).toContain("onClose={close}");
  });
});

describe("the swap card in the mode", () => {
  const card = (held: Parameters<typeof draw>[1] = {}) => draw(createElement(SwapCard), held);

  it("carries the mode's mark at the left end of its row of tools, beside the way back to private routing when that shows", () => {
    const tools = (html: string) => /<div class="card-tools">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    expect(tools(card({ ghost: true }))).toMatch(/^<span class="card-ghost"><svg[^>]*class="lucide lucide-ghost"[^>]*aria-hidden="true">.*?<\/svg>Ghost mode<\/span><button type="button" class="tool"/);
    expect(tools(card())).toMatch(/^<button type="button" class="tool"/);
    const both = tools(card({ ghost: true, config: { privacyMode: "basic" }, swap: { withoutPrivate: true } }));
    expect(both).toMatch(/^<span class="card-ghost">.*?<\/span><button type="button" class="routing-switch card-routing">Use private routing<\/button><button type="button" class="tool"/);
    expect(both.match(/<button type="button" class="tool"/g)).toHaveLength(2);
  });

  it("draws no balance, no Max, no Connect and no other way to pay, whatever the wallet's store holds", () => {
    const html = card({ ghost: true, wallet: CONNECTED });
    expect(html).not.toMatch(/Balance|balance-max|skeleton-balance|Max<\/button>/);
    expect(html).not.toMatch(/Pay without connecting|Pay from a connected wallet|Connect wallet|Use connected wallet/);
    // Paying is by sending to the deposit address: the refund address is asked for, as paying by hand asks for it, and the line under the button says how it is paid.
    expect(html).toContain("Refund address");
    expect(html).toContain('<p class="card-footnote muted">ETH on Base is paid by sending it to a deposit address.</p>');
    // The main button's ordinary label for the step: with nothing typed, an amount is asked for.
    expect(html).toMatch(/<button type="button" class="button-primary" disabled="" aria-disabled="true">Enter an amount<\/button>/);
    // The same card out of the mode: the balance, Max, and the other way to pay.
    const plain = card({ wallet: CONNECTED });
    expect(plain).toMatch(/Balance: /);
    expect(plain).toContain("balance-max");
    expect(plain).toContain("Pay without connecting");
    // Out of the mode with no wallet: the main button asks for one. In the mode it never does.
    expect(card({ swap: { amountText: "0.5" } })).toContain("Connect wallet");
    expect(card({ ghost: true, swap: { amountText: "0.5" } })).not.toContain("Connect wallet");
  });

  it("the coin picker shows no balance and does not put held coins first", () => {
    const names = (html: string) => [...html.matchAll(/<span class="picker-row-name">([^<]*)<\/span>/g)].map((match) => match[1]);
    const held = { wallet: CONNECTED, picker: "from" as const };
    const plain = draw(createElement(CoinPicker, { side: "from", onClose: () => undefined }), held);
    const ghost = draw(createElement(CoinPicker, { side: "from", onClose: () => undefined }), { ...held, ghost: true });
    expect(plain).toContain("picker-row-balance");
    expect(ghost).not.toContain("picker-row-balance");
    // The order of the list with no wallet at all is the order in the mode.
    const bare = draw(createElement(CoinPicker, { side: "from", onClose: () => undefined }), { picker: "from" });
    expect(names(ghost)).toEqual(names(bare));
    expect(names(plain)).not.toEqual(names(bare));
  });
});

describe("the review in the mode", () => {
  const review = (held: Parameters<typeof draw>[1] = {}) => draw(createElement(ReviewSheet), { swap: { quote: QUOTE, fetchedAt: Date.now(), amountText: "0.5", pay: "manual", recipient: "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP", refundTo: ADDRESS }, ...held });
  const points = (html: string) => /<p class="review-address-label">Points[\s\S]*?(?=<p class="review-plain)/.exec(html)?.[0] ?? "";

  it("the rewards address is there to be given, empty, with the line that says what giving it does", () => {
    const html = points(review({ ghost: true, wallet: CONNECTED }));
    expect(GHOST_REWARDS_HINT).toBe("Naming an address ties this swap's points to it. Leave it empty and this swap adds no points.");
    expect(html).toMatch(/<label for="[^"]+" class="address-label">Rewards address<\/label>/);
    expect(html).toMatch(/<textarea[^>]*placeholder="Enter BNB Chain address"[^>]*><\/textarea>/);
    expect(html).toMatch(new RegExp(`<p id="[^"]+" class="address-note" data-kind="hint"><span>${GHOST_REWARDS_HINT.replace(/'/g, "&#x27;")}</span></p>`));
    // Nothing fills it in, and nothing else is offered for it: not the wallet's address, not a button that would use one.
    expect(html).not.toMatch(/0xb559|wallet|Use connected|Choose another address/i);
    // Not even were the card's store to say that the swap is paid from that wallet (it cannot, in the mode).
    const whole = review({ ghost: true, wallet: CONNECTED, swap: { quote: QUOTE, fetchedAt: Date.now(), amountText: "0.5", pay: "wallet", recipient: "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP", refundTo: "" } });
    expect(points(whole)).not.toMatch(/0xb559|wallet|Choose another address/i);
    expect(whole.toLowerCase()).not.toContain(ADDRESS.slice(2, 12).toLowerCase());
    // Out of the mode, paying from the connected wallet, the points go to its address.
    const plain = points(review({ wallet: CONNECTED, swap: { quote: QUOTE, fetchedAt: Date.now(), amountText: "0.5", pay: "wallet", recipient: "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP", refundTo: "" } }));
    expect(plain).toContain("its points go to your wallet&#x27;s address");
  });

  it("says that the order is not listed and that its record is deleted, in place of the line about the Stats page, which is not true of it", () => {
    const LISTED = "This swap's deposit transaction will be listed on the Stats page. Which swap was delivered where is not shown.";
    expect(GHOST_ORDER_LINE).toBe("This order is not listed on the Stats page, and its record is deleted from this site's server when it is delivered or refunded.");
    const lines = (html: string) => [...html.matchAll(/<p class="review-plain muted">([\s\S]*?)<\/p>/g)].map((match) => words(match[1]!));
    // In the mode: the new line, whether or not the site has a Stats page, and never the old one.
    for (const config of [{ statsPage: true }, { statsPage: false }, null]) {
      const ghost = lines(review({ ghost: true, config }));
      expect(ghost.filter((line) => line === GHOST_ORDER_LINE), JSON.stringify(config)).toHaveLength(1);
      expect(ghost, JSON.stringify(config)).not.toContain(LISTED);
      expect(ghost.join(" "), JSON.stringify(config)).not.toContain("will be listed");
    }
    // Out of the mode: the old line where the site has a Stats page, and never the new one.
    const plain = lines(review({ config: { statsPage: true } }));
    expect(plain.filter((line) => line === LISTED)).toHaveLength(1);
    expect(plain).not.toContain(GHOST_ORDER_LINE);
    for (const config of [{ statsPage: false }, null]) {
      const none = lines(review({ config })).join(" ");
      expect(none).not.toContain("Stats page");
      expect(none).not.toContain("is deleted");
    }
    // One or the other, by one choice: the two can never both be drawn.
    expect(read("components/ReviewSheet.tsx")).toContain('{ghost ? <p className="review-plain muted">{GHOST_ORDER_LINE}</p> : statsOn ? <p className="review-plain muted">This swap\'s deposit transaction will be listed on the Stats page. Which swap was delivered where is not shown.</p> : null}');
  });

  it("the Terms, which open in a tab of their own, open in the mode too: that tab is given this tab's flag", () => {
    // A tab opened as this tab's own takes a copy of what this tab keeps for itself, which is the flag and nothing else.
    expect(review({ ghost: true })).toContain('<a href="/terms" target="_blank" rel="opener">Terms of Use</a>');
    expect(review()).toContain('<a href="/terms" target="_blank" rel="noopener">Terms of Use</a>');
  });
});

describe("an order that was to be paid from a wallet, opened in the mode", () => {
  it("shows the other way to pay it, and nothing that would reach for a wallet", () => {
    const made = { ...order("MadeBefore0000000000000001", "2026-10-08T11:59:00.000Z"), status: "waiting", pay: "wallet", depositsOpen: true, depositAddress: ADDRESS, depositMemo: null, amountIn: "500000000000000000", depositTxHash: null, deadline: "2026-10-08T13:00:00.000Z", sendBy: "2026-10-08T12:58:00.000Z" } as unknown as OrderView;
    const pay = (ghost: boolean) => draw(createElement(WalletPay, { order: made, now: Date.now(), onOrder: () => undefined }, createElement("p", { className: "by-hand" }, "Send it yourself")), { ghost });
    expect(pay(true)).toBe('<p class="by-hand">Send it yourself</p>');
    // Out of the mode the same order shows the step that pays from a wallet, with the other way folded beneath it.
    const plain = pay(false);
    expect(plain).toContain("Pay from your wallet");
    expect(plain).toContain('<p class="by-hand">Send it yourself</p>');
    expect(read("components/WalletPay.tsx")).toContain("if (ghost || !pay.open || order.depositAddress === null) return <>{children}</>;");
  });
});

describe("a link that leaves the site", () => {
  const link = (ghost: boolean) => draw(createElement(OutboundLink, { href: "https://basescan.org/tx/0xab", className: "pay-link", children: "View it" }), { ghost });

  it("is a plain link: a new tab, no hold on this window, no referrer", () => {
    expect(link(false)).toBe('<a class="pay-link" href="https://basescan.org/tx/0xab" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">View it</a>');
  });

  it("in the mode carries a small mark, with the words for a screen reader", () => {
    expect(link(true)).toMatch(/^<a class="pay-link" href="https:\/\/basescan\.org\/tx\/0xab" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" data-leaves="true">View it<span class="leaves-site"><svg[^>]*width="12" height="12"[^>]*class="lucide lucide-arrow-up-right"[^>]*aria-hidden="true">.*?<\/svg><span class="sr-only">\(leaves this site\)<\/span><\/span><\/a>$/);
    expect(draw(createElement(LeavesSite), { ghost: false })).toBe("");
    expect(draw(createElement(LeavesSite), { ghost: true })).toContain("(leaves this site)");
  });

  it("the three icon links, the pay step's link and the coin picker's are drawn by it; none of those files draws a link out of its own", () => {
    const socials = { dexscreenerUrl: "https://dexscreener.com/bsc/0xabc", githubUrl: "https://github.com/intentswap", xUrl: "https://x.com/intentswap" };
    const drawn = draw(createElement(SocialLinks, { where: "header" }), { ghost: true, config: socials });
    expect(drawn.match(/target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" data-leaves="true"/g)).toHaveLength(3);
    expect(drawn.match(/\(leaves this site\)/g)).toHaveLength(3);
    expect(draw(createElement(SocialLinks, { where: "header" }), { config: socials })).not.toContain("leaves-site");
    for (const file of ["components/Social.tsx", "components/WalletPay.tsx", "components/CoinPicker.tsx", "components/Shell.tsx", "components/GhostSheet.tsx", "components/SwapCard.tsx"]) {
      expect(read(file), file).not.toMatch(/target="_blank"[^>]*rel="noopener noreferrer"/);
    }
    for (const file of ["components/Social.tsx", "components/WalletPay.tsx", "components/CoinPicker.tsx"]) expect(read(file), file).toContain("<OutboundLink ");
    // The one component that writes them cannot be talked out of them: what a caller passes comes first, and these come last.
    expect(read("components/OutboundLink.tsx")).toMatch(/<a \{\.\.\.rest\} href=\{href\} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" data-leaves=\{ghost \|\| undefined\}>/);
  });

  it("takes whatever the anchor it replaces took, and how it opens is still its own to say", () => {
    // An anchor as the pages write one, with nothing changed but its name.
    const asWritten = draw(createElement(OutboundLink, { href: "https://bscscan.com/address/0xab", target: "_self", rel: "opener", referrerPolicy: "unsafe-url", className: "outbound", children: "View the wallet on BscScan" }), { ghost: true });
    expect(asWritten).toMatch(/^<a class="outbound" href="https:\/\/bscscan\.com\/address\/0xab" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" data-leaves="true">View the wallet on BscScan<span class="leaves-site">/);
    expect(asWritten).not.toMatch(/_self|opener"|unsafe-url/);
    // And the mark alone sits inside an anchor that stays as it is (one that opens no new tab, say).
    const inside = draw(createElement("a", { className: "button-secondary", href: "https://example.org/help", rel: "noopener noreferrer" }, "Contact support", createElement(LeavesSite)), { ghost: true });
    expect(inside).toMatch(/^<a class="button-secondary" href="https:\/\/example\.org\/help" rel="noopener noreferrer">Contact support<span class="leaves-site"><svg[^>]*>.*?<\/svg><span class="sr-only">\(leaves this site\)<\/span><\/span><\/a>$/);
  });
});
