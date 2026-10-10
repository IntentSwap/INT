// Ghost mode on the pages: what each one draws with the mode on and with it off, and what the
// site says of the mode. The pages are drawn here as a browser first draws them (to plain markup,
// without a browser). Whether the mode is on is known at that first drawing, so what is drawn here
// is what a person sees from the first moment, with nothing arriving later to move the page.
//
// The switch itself, the wallet, the stores and the server's side of it have tests of their own.

import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routingOf, TERMS_VERSION, type OrderView } from "../shared/api.ts";
import { DOC_SLUGS, docSlugs, GHOST_DOC_SLUG, isDocSlug } from "../shared/pages.ts";
import type { RewardsPublic } from "../shared/rewards.ts";
import { Faq, questions } from "../web/src/components/Faq.tsx";
import { HomeSections } from "../web/src/components/Home.tsx";
import { RecentHidden, RecentList } from "../web/src/components/RecentList.tsx";
import { DOC_PAGES, docExists, docHref, docPages } from "../web/src/lib/docs-logic.ts";
import { ending, endingSaid, ghostLookAgain, pollDelay } from "../web/src/lib/order-logic.ts";
import { features } from "../web/src/lib/site-logic.ts";
import DocsPage from "../web/src/pages/DocsPage.tsx";
import { PrivacyPage, TermsPage } from "../web/src/pages/LegalPages.tsx";
import { OrderContent, OrderDeleted } from "../web/src/pages/OrderPage.tsx";
import RewardsPage from "../web/src/pages/RewardsPage.tsx";
import { StatsContent } from "../web/src/pages/StatsPage.tsx";
import TrackPage from "../web/src/pages/TrackPage.tsx";
import { matchRoute } from "../web/src/router.ts";
import { useApp } from "../web/src/stores/app.ts";
import { useGhost } from "../web/src/stores/ghost.ts";
import { useOrders, type RecentOrder } from "../web/src/stores/orders.ts";
import { useRewards } from "../web/src/stores/rewards.ts";
import { useWallet } from "../web/src/stores/wallet.ts";
import { NEVER } from "./words.ts";

const root = path.resolve("web", "src");
const source = (file: string) => fs.readFileSync(path.join(root, ...file.split("/")), "utf8");
/** A file's text without its comments: what is written for whoever reads the code is shown to nobody. */
const shown = (file: string) =>
  source(file)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\w])\/\/[^\n]*/g, "$1");
/** One function of a file, from its first line to the line that closes it. */
const part = (text: string, opening: string) => {
  const start = text.indexOf(opening);
  if (start === -1) throw new Error(`no "${opening}"`);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end === -1 ? undefined : end + 2);
};

/** The server's settings for a site with nothing else set, routed in public, and the same routed privately. Each with and without its Stats page. */
const SETTINGS = { supportContact: null, tokenAddress: null, tokenPairAddress: null, paused: false, privacyMode: "public", statsPage: true };
const ROUTED_PRIVATELY = { ...SETTINGS, privacyMode: "basic" };
const WITHOUT_STATS = { ...SETTINGS, statsPage: false };

/** Two orders as this browser's own list holds them. */
const KEPT: RecentOrder[] = [
  { id: "KeptOrderMadeInNormalMode01", createdAt: "2026-10-08T12:00:00.000Z", from: { symbol: "ETH", chain: "base", decimals: 18 }, to: { symbol: "USDT", chain: "sol", decimals: 6 } },
  { id: "KeptOrderMadeInNormalMode02", createdAt: "2026-10-07T09:30:00.000Z", from: { symbol: "USDC", chain: "eth", decimals: 6 }, to: { symbol: "BNB", chain: "bsc", decimals: 18 } },
];

interface Held {
  /** Whether Ghost mode is on in the tab that draws. Off unless a test says so. */
  ghost?: boolean;
  config?: object | null;
  /** What this browser's own list of orders holds. */
  orders?: RecentOrder[];
  rewards?: Partial<ReturnType<typeof useRewards.getState>>;
}

/**
 * A part of the site as it is first drawn. Drawn here, outside a browser, a component reads each
 * store's first state, so what the drawing needs is put there for its length and taken away again.
 * The mode is put in both places it is read from: the first state (a component's first drawing)
 * and the state as it stands (code that is not a component).
 */
function draw(element: () => ReactElement, held: Held = {}): string {
  const wanted: [{ getInitialState(): object }, Record<string, unknown>][] = [
    [useGhost, { on: held.ghost === true }],
    [useApp, { config: held.config === undefined ? SETTINGS : held.config }],
    [useOrders, { orders: held.orders ?? [] }],
    [useRewards, { summary: null, summaryFailed: false, session: null, mine: null, step: "idle", error: null, ...held.rewards }],
  ];
  const before = wanted.map(([store, values]) => {
    const first = store.getInitialState() as Record<string, unknown>;
    const kept = Object.fromEntries(Object.keys(values).map((key) => [key, first[key]]));
    Object.assign(first, values);
    return [first, kept] as const;
  });
  useGhost.setState({ on: held.ghost === true });
  try {
    return renderToStaticMarkup(element());
  } finally {
    for (const [first, kept] of before) Object.assign(first, kept);
    useGhost.setState({ on: false });
  }
}

/**
 * One element of a drawn page, whole: from the tag it opens with to the tag that closes it, with
 * everything inside. Empty when the page has no such element.
 */
function element(markup: string, opening: string): string {
  const start = markup.indexOf(opening);
  if (start === -1) return "";
  const tag = /^<([a-z0-9]+)/.exec(opening)?.[1] ?? "div";
  const marks = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  marks.lastIndex = start;
  let depth = 0;
  for (let mark = marks.exec(markup); mark !== null; mark = marks.exec(markup)) {
    depth += mark[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return markup.slice(start, mark.index + mark[0].length);
  }
  return "";
}
/** What is inside it. */
const inside = (whole: string) => whole.replace(/^<[^>]+>/, "").replace(/<\/[a-z0-9]+>$/, "");

/** What is hidden from everyone: a part drawn only to keep its room (see the order's page). */
const UNSEEN = '<div class="order-ghost-state" data-unseen="true" aria-hidden="true" inert="">';
const seen = (markup: string) => markup.replace(element(markup, UNSEEN) || "\u0000", "");
/** The words of a drawn page, as they are read. What is written for a screen reader alone is left in: it is read too. */
const words = (markup: string) => plain(seen(markup));
/** The words of a piece of markup, whatever it is. */
const plain = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const rewardsPage = () => createElement(RewardsPage);
const trackPage = () => createElement(TrackPage);
const docsPage = (slug: Parameters<typeof DocsPage>[0]["slug"]) => () => createElement(DocsPage, { slug });
const ghostDocs = docsPage(GHOST_DOC_SLUG);
const privacy = () => createElement(PrivacyPage);
const terms = () => createElement(TermsPage);
const faq = () => createElement(Faq);
const home = () => createElement(HomeSections);

// ---- The sentences, word for word ----
const SIGN_IN_OFF = "Sign-in is off in Ghost mode. Turn it off to see your points.";
const ONLY_WAY_BACK = "This is the only way back to this order. It is not saved anywhere.";
const DELETED_WHEN_IT_FINISHES = "Its record is deleted from this site's server the moment it finishes.";
const ALL_THAT_IS_LEFT = "This order has finished and its record has been deleted from the server. This page is all that is left of it; it will not load again.";
const ENDING_NOT_SEEN = "How it ended was not seen here. If you sent the deposit, look for the delivery at your receiving address, or for a refund at your refund address: both are in the order details below.";
const NOTICE = "This order finished. It was made in Ghost mode, so its record was deleted when it finished. Nothing more is kept of it here.";
const LIST_NOT_SHOWN = "Orders made in this browser are not shown in Ghost mode.";
const OWN_LINK_ONLY = "An order made in Ghost mode opens from its own link only.";
const FAQ_ANSWER =
  "A switch in the header. While it is on, this site loads no wallet software and keeps nothing in your browser but the switch itself, and the record of an order you make is deleted from its server the moment the order finishes. It does not make a swap less public: the deposit and the delivery are still public transfers, the swap service still carries out the swap, and your network and this site's host still see your network address. How Ghost mode works";
const HOME_LINE = "One switch in the header. While it is on, the site loads no wallet and keeps nothing in your browser but the switch itself, and your order's record is deleted from the server the moment it finishes. Your deposit and your delivery are still public on-chain.";

describe("the Rewards page in Ghost mode", () => {
  const MONDAY = Date.parse("2026-10-05T00:00:00.000Z");
  const week = { id: "2026-W41", start: new Date(MONDAY).toISOString(), end: new Date(MONDAY + 7 * 86_400_000).toISOString() };
  // Made up from fixed text: it is nobody's.
  const POOL = { address: "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83", amount: (12_345_678n * 10n ** 14n).toString(), decimals: 18, usdMicro: "5925925440", readAt: new Date(MONDAY + 3_600_000).toISOString() };
  const summary: RewardsPublic = { week, weekPointsMicro: "59805000000", weeks: [], totalPaid: "0", weeksPaid: 0, pool: POOL, serverNow: new Date(MONDAY + 3_600_000).toISOString() };
  /** The part beside the week: the invitation to sign in, or what stands in its place. */
  const mine = (markup: string) => inside(element(markup, '<div class="rewards-mine">'));

  // The page counts the week down by the clock: both drawings are made at one moment, so that only the mode differs between them.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(MONDAY + 2 * 86_400_000);
  });
  afterEach(() => vi.useRealTimers());

  it("draws one line where the invitation to sign in stands, and nothing else of the sign-in", () => {
    const markup = draw(rewardsPage, { ghost: true, rewards: { summary } });
    expect(mine(markup)).toBe(`<p class="rewards-label mono">Your points</p><p class="rewards-ask">${SIGN_IN_OFF}</p>`);
    // No control that opens a wallet or signs in, no sentence about signing, and no line kept for what a sign-in came to.
    expect(mine(markup)).not.toMatch(/<button|rewards-message/);
    expect(words(markup)).not.toMatch(/Connect|Sign in as|Signing in asks|Confirm in your wallet|Sign out|Signed in as/);
    // The one button left on the page copies the rewards wallet's address.
    expect([...markup.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((button) => words(button[0]))).toEqual(["Copy the rewards wallet's address"]);
  });

  it("out of the mode, draws the invitation as ever, and not that line", () => {
    const markup = draw(rewardsPage, { rewards: { summary } });
    expect(words(mine(markup))).toBe("Your points Connect the wallet whose points you want to see. Points are shown only to the address they belong to. Connect to see your points");
    expect(mine(markup)).toMatch(/<button type="button" class="button-primary"[^>]*>Connect to see your points<\/button>/);
    expect(words(markup)).not.toMatch(/Ghost mode/);
  });

  it("shows the week, its total, the pool and the rules the same in both: only the part beside the week differs", () => {
    const without = (markup: string) => markup.replace(mine(markup), "");
    const on = draw(rewardsPage, { ghost: true, rewards: { summary } });
    const off = draw(rewardsPage, { rewards: { summary } });
    expect(without(on)).toBe(without(off));
    for (const kept of ["This week 5d 00:00:00 Mon 5 Oct to Sun 11 Oct, UTC time.", "This week's points 59,805 points", "Current pool 1,234.56 NEAR", "The rules, in short", "The rules in full"]) expect(words(on), kept).toContain(kept);
    // Before the server has answered, too: the frame is the same, so nothing moves between the modes as the page loads.
    expect(without(draw(rewardsPage, { ghost: true }))).toBe(without(draw(rewardsPage)));
  });

  it("shows nobody's own points in the mode, even where a sign-in was made before it was turned on", () => {
    const signedIn = {
      summary,
      session: { address: POOL.address, token: "t", expiresAt: MONDAY + 3 * 86_400_000 },
      mine: { address: POOL.address, week: { ...week, pointsMicro: "250000000", carriedInMicro: "0" }, allTimeMicro: "250000000", swaps: [], payouts: [], share: { bps: 42, estimate: null, estimateCents: null, decimals: 18 } },
    };
    expect(words(draw(rewardsPage, { rewards: signedIn }))).toContain("Your points this week 250.00 All time: 250.00 Your share 0.42% Signed in as");
    const on = draw(rewardsPage, { ghost: true, rewards: signedIn });
    expect(words(mine(on))).toBe(`Your points ${SIGN_IN_OFF}`);
    expect(words(on)).not.toMatch(/Your points this week|Your share|The swaps behind them|Signed in as|Sign out/);
    // And the page ends that sign-in as soon as it is on screen.
    expect(source("pages/RewardsPage.tsx")).toMatch(/useEffect\(\(\) => \{\s*if \(ghost\) signOut\(\);\s*\}, \[ghost, signOut\]\);/);
    expect(source("pages/RewardsPage.tsx")).toContain("const mine = !ghost && rewards.session !== null ? rewards.mine : null;");
  });

  it("reaches no wallet code in the mode: the wallet's state is not so much as read", () => {
    // Every look at the wallet's state is counted, and each way of loading wallet software is stood in for by one that would be noticed.
    const first = useWallet.getInitialState() as unknown as Record<string, unknown>;
    const kept = Object.getOwnPropertyDescriptors(first);
    let looks = 0;
    const opened = vi.fn(() => Promise.resolve());
    for (const key of ["status", "address", "chain", "chainId", "error"]) {
      const value = first[key];
      Object.defineProperty(first, key, { configurable: true, enumerable: true, get: () => ((looks += 1), value) });
    }
    Object.assign(first, { connect: opened, disconnect: opened, loadBalances: opened, refreshBalance: opened });
    try {
      draw(rewardsPage, { ghost: true, rewards: { summary } });
      draw(rewardsPage, { ghost: true });
      expect(looks).toBe(0);
      // The same drawing out of the mode does look: the check above is one that can fail.
      draw(rewardsPage, { rewards: { summary } });
      expect(looks).toBeGreaterThan(0);
      expect(opened).not.toHaveBeenCalled();
    } finally {
      Object.defineProperties(first, kept);
    }
  });

  it("by its own code: only the part that is not drawn in the mode looks at the wallet, opens one or signs in", () => {
    const page = shown("pages/RewardsPage.tsx");
    // One part or the other, decided at the first drawing.
    expect(page).toContain("const ghost = useGhost((state) => state.on);");
    expect(page).toContain("{ghost ? <SignInOff /> : <Mine mine={mine} />}");
    // The wallet's store is used in one place, inside that part; so are the two calls that load wallet software.
    const invitation = part(page, "function Mine(");
    for (const call of ["useWallet(", "wallet.connect(", "rewards.signIn("]) {
      expect(page.split(call).length - 1, call).toBe(1);
      expect(invitation, call).toContain(call);
    }
    // What stands in its place is words alone.
    const line = part(page, "function SignInOff(");
    expect(line).not.toMatch(/use[A-Z]\w*\(|<button|Button|onClick|wallet|rewards\./);
    expect(line).toContain(SIGN_IN_OFF);
    // And what the page itself does when it opens asks this site's own server for the week, and nothing of a wallet.
    const whole = part(page, "export default function RewardsPage()");
    expect(whole).not.toMatch(/useWallet|wallet\.|\.connect\(|\.signIn\(/);
    expect(page).not.toMatch(/import\([^)]*wallet/);
  });
});

// ---- An order's page ----
// Example addresses, made up from fixed text: they are nobody's.
const SOL_ADDRESS = "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP";
const EVM_ADDRESS = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
const DEPOSIT_ADDRESS = "0x8a3F0c2D9b7E41a65C0dE2f3B4c5D6e7F8091A2b";
const NOW = Date.parse("2026-10-10T12:10:00.000Z");
const ORDER_ID = "Ex4mpleOrderIdForTheTests00";

/** An order waiting for its deposit, sent by hand, unless a test says otherwise. */
function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: ORDER_ID,
    status: "waiting",
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    statusSince: new Date(NOW - 60_000).toISOString(),
    pay: "manual",
    from: { id: "base:ETH", symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null },
    to: { id: "sol:USDT", symbol: "USDT", name: "Tether USD", chain: "sol", decimals: 6, contract: "x" },
    amountIn: "500000000000000000",
    amountOut: "1261340512",
    minAmountOut: "1248727106",
    amountInUsd: "1265.13",
    amountOutUsd: "1260.59",
    slippageBps: 100,
    timeEstimate: 34,
    fees: { appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "1000000000000000" },
    withdrawFee: null,
    refundFee: null,
    recipient: SOL_ADDRESS,
    refundTo: EVM_ADDRESS,
    rewardsAddress: null,
    routing: routingOf("public"),
    depositAddress: DEPOSIT_ADDRESS,
    depositMemo: null,
    depositsOpen: true,
    deadline: new Date(NOW + 3_000_000).toISOString(),
    depositTxHash: null,
    depositProven: false,
    depositTxUrl: null,
    details: null,
    serverNow: new Date(NOW).toISOString(),
    ...overrides,
  };
}
const DEPOSIT_TX = "0x74832746c4358350a8956a2f666a90aa8f56d20ec03174eb3848f52307ab1c17";
const swapping = (overrides: Partial<OrderView> = {}) => order({ status: "swapping", depositAddress: null, depositsOpen: false, depositProven: true, depositTxHash: DEPOSIT_TX, ...overrides });
const delivered = (overrides: Partial<OrderView> = {}) =>
  order({ status: "delivered", depositAddress: null, depositsOpen: false, depositProven: true, depositTxHash: DEPOSIT_TX, details: { originTxs: [{ hash: DEPOSIT_TX, url: null }], destinationTxs: [], depositedAmount: "500000000000000000", amountIn: "500000000000000000", amountOut: "1261340512", refundedAmount: null, refundReason: null }, ...overrides });

describe("an order made in Ghost mode, on its own page", () => {
  beforeEach(() => vi.stubGlobal("window", { location: { origin: "https://intentswap.example", search: "" } }));
  afterEach(() => vi.unstubAllGlobals());

  const page = (example: OrderView, held: Held & { gone?: boolean } = {}) => draw(() => createElement(OrderContent, { order: example, now: NOW, reconnecting: false, contact: null, onOrder: () => undefined, gone: held.gone === true }), held);
  /** The order's own note, as it is seen. */
  const note = (markup: string) => element(seen(markup), '<div class="order-ghost" role="note">');
  const buttons = (markup: string) => [...seen(markup).matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((button) => words(button[0]));

  it("says near the top that its link is the only way back, with a Copy link button, and that its record is deleted the moment it finishes", () => {
    const markup = page(order({ ghost: true }));
    expect(words(note(markup))).toBe(`${ONLY_WAY_BACK} ${DELETED_WHEN_IT_FINISHES} Copy link to this order`);
    expect(note(markup)).toMatch(/<p class="order-ghost-lead">This is the only way back to this order\. It is not saved anywhere\.<\/p><p class="order-ghost-sub muted">Its record is deleted from this site&#x27;s server the moment it finishes\.<\/p><\/div><button type="button" class="button-chip">/);
    // The one button that copies the link is the note's own: the header has none, and the link is said once on the page.
    expect(buttons(markup).filter((name) => name === "Copy link to this order")).toHaveLength(1);
    expect(markup).not.toContain('class="order-copy"');
    expect(words(markup)).not.toContain("Keep this page's link");
    expect(words(markup).endsWith(`Order ${ORDER_ID} .`)).toBe(true);
    // It comes right under the order's title, before anything to do or to read of the order's progress.
    expect(markup.indexOf('class="order-ghost"')).toBeGreaterThan(markup.indexOf("</header>"));
    expect(markup.indexOf('class="order-ghost"')).toBeLessThan(markup.indexOf('class="order-reconnecting"'));
    expect(markup.indexOf('class="order-ghost"')).toBeLessThan(markup.indexOf('class="deposit"'));
    // In the plain manner of a note, and in no warning colour.
    expect(note(markup)).not.toMatch(/notice-warning|notice-danger|data-tone/);
    const css = source("styles/order.css");
    const rules = [...css.matchAll(/(\.order-ghost[^{]*)\{([^}]*)\}/g)].map((rule) => rule[2]!).join("\n");
    expect(rules).toContain("border-left: var(--rule-height) solid var(--border-strong);");
    expect(rules).toContain("background: var(--tint-neutral);");
    expect(rules).not.toMatch(/--warning|--danger|--accent|--tint-warning|--tint-accent/);
  });

  it("says none of it for any other order, whose page is as it always was", () => {
    for (const held of [{}, { ghost: true }]) {
      const markup = page(order(), held);
      expect(markup).not.toContain("order-ghost");
      expect(words(markup)).not.toMatch(/Ghost mode|not saved anywhere|moment it finishes/);
      expect(markup).toContain('<span class="order-copy"><button type="button" class="button-chip">');
      expect(words(markup).endsWith(`Order ${ORDER_ID} . Keep this page's link: it is the only way back to this order.`)).toBe(true);
    }
  });

  it("says it from the first moment the order is on screen, whatever mode the tab is in now, and at every stage of the order", () => {
    for (const held of [{}, { ghost: true }]) {
      for (const example of [order({ ghost: true }), swapping({ ghost: true }), delivered({ ghost: true }), order({ ghost: true, status: "failed", depositsOpen: false, depositAddress: null })]) {
        expect(words(note(page(example, held))), example.status).toBe(`${ONLY_WAY_BACK} ${DELETED_WHEN_IT_FINISHES} Copy link to this order`);
      }
    }
  });

  it("in the mode, offers no payment from a wallet for any order: the deposit details stand alone", () => {
    const fromWallet = order({ pay: "wallet" });
    // Out of the mode such an order is paid from the wallet, as ever.
    expect(page(fromWallet)).toContain('id="pay-title"');
    for (const example of [fromWallet, { ...fromWallet, ghost: true as const }]) {
      const markup = page(example, { ghost: true });
      expect(markup).not.toContain('id="pay-title"');
      expect(markup).toContain('<section class="deposit" aria-labelledby="deposit-title">');
      expect(words(markup)).not.toMatch(/Connect wallet|Your wallet will ask/);
    }
  });

  describe("once the server says its record is deleted, on a page that was showing it", () => {
    it("keeps the ending the page last had on screen, and says that this page is all that is left", () => {
      const before = page(delivered({ ghost: true }));
      const after = page(delivered({ ghost: true }), { gone: true });
      expect(words(note(after))).toBe(ALL_THAT_IS_LEFT);
      // Everything of the delivered order is still there: how it ended, with its amount, the four steps, the deposit, the details.
      for (const kept of ["Delivered 1,261.340512 USDT was sent to your Solana address. Swap again", "Waiting for deposit 0.5 ETH sent.", "Swapped.", "Deposit 0x74832746…ab1c17", "Order details", `Order ${ORDER_ID} .`]) expect(words(after), kept).toContain(kept);
      expect(after.match(/<li class="step" data-state="done"/g)).toHaveLength(4);
      // Only the note's words have changed: the rest of the page is, to the letter, what it was.
      const rest = (markup: string) => seen(markup).replace(note(markup), "");
      expect(rest(after)).toBe(rest(before));
      // Nothing copies the link any more, and nothing says the link leads back.
      expect(buttons(after)).toEqual(["Swap again"]);
      expect(words(after)).not.toMatch(/only way back|Copy link|Keep this page's link/);
    });

    it("keeps the room the note had, unseen, so that nothing under it moves as the ending is read", () => {
      const after = page(delivered({ ghost: true }), { gone: true });
      const unseen = element(after, UNSEEN);
      expect(element(after, '<div class="order-ghost" role="note">')).toContain(unseen);
      // The very words and button it stood on before, kept from the eye, from a screen reader and from the keyboard.
      expect(plain(unseen)).toBe(`${ONLY_WAY_BACK} ${DELETED_WHEN_IT_FINISHES} Copy link to this order`);
      expect(source("styles/order.css")).toMatch(/\.order-ghost-state \{\s*grid-area: 1 \/ 1;/);
      expect(source("styles/order.css")).toMatch(/\.order-ghost-state\[data-unseen\] \{\s*visibility: hidden;\s*\}/);
      // While the record is there, and where the page had not seen the ending, there is nothing unseen.
      expect(page(delivered({ ghost: true }))).not.toContain("data-unseen");
      expect(page(swapping({ ghost: true }), { gone: true })).not.toContain("data-unseen");
    });

    it("where the order was still running, keeps no step and no way to pay, and says that how it ended was not seen", () => {
      for (const example of [swapping({ ghost: true }), order({ ghost: true }), order({ ghost: true, status: "deposit_seen", depositProven: true, depositAddress: null, depositsOpen: false })]) {
        const markup = page(example, { gone: true });
        expect(words(note(markup)), example.status).toBe(`${ALL_THAT_IS_LEFT} ${ENDING_NOT_SEEN}`);
        // Nothing that shows the order as still going, and nothing to send to.
        expect(markup, example.status).not.toMatch(/class="steps"|class="step"|class="deposit"|deposit-address|order-fold"><summary>Already sent/);
        expect(words(markup), example.status).not.toMatch(/Send your deposit|Tick the box|left to send|elapsed|Swapping|Waiting for deposit|Add the transaction hash/);
        expect(markup, example.status).not.toContain(DEPOSIT_ADDRESS);
        expect(buttons(markup), example.status).toEqual([]);
        // What it was, and where it was to go, is still there to check against the chains.
        expect(words(markup), example.status).toContain("Order details");
        expect(markup, example.status).toContain(SOL_ADDRESS.slice(0, 6));
      }
      // An order that was still waiting to be paid says, in the page's own words for it, that nothing more may be sent.
      expect(words(page(order({ ghost: true }), { gone: true }))).toContain("Deposits for this order are closed. Do not send now: a payment sent after the deadline may be lost.");
      expect(words(page(swapping({ ghost: true }), { gone: true }))).not.toContain("Deposits for this order are closed");
    });

    it("never tells the person to keep a link that leads nowhere: what is worth keeping is the order's ID", () => {
      const expired = order({ ghost: true, status: "expired", depositAddress: null, depositsOpen: false });
      // While the record is there, the ending says what it says of any order.
      expect(words(page(expired))).toContain("Expired No deposit arrived before the deadline. If you did send coins, keep the transaction hash and this page's link.");
      const after = words(page(expired, { gone: true }));
      expect(after).toContain("Expired No deposit arrived before the deadline. If you did send coins, keep the transaction hash and this order's ID.");
      expect(after).not.toMatch(/this page's link|Copy link/);
      // The ID is still on the page, at its foot.
      expect(after.endsWith(`Order ${ORDER_ID} .`)).toBe(true);
      // The same for the other endings that name the link, with and without a contact to write to.
      expect(ending(order({ status: "failed" }), true, false)?.cause).toBe("The swap could not be completed. Keep this order's ID and your deposit transaction hash, and contact support.");
      expect(ending(order({ status: "expired", depositTxHash: DEPOSIT_TX }), false, false)?.cause).toBe("No deposit was confirmed before the deadline. Keep this order's ID and your deposit transaction hash.");
      // And nothing changes for an order whose link still leads to it.
      for (const example of [order({ status: "failed" }), order({ status: "expired" }), delivered(), order({ status: "refunded" })]) expect(ending(example, true, true)).toEqual(ending(example, true));
    });

    it("an order whose last answer did not carry the mark is treated the same: only an order made in Ghost mode is ever answered so", () => {
      const markup = page(delivered(), { gone: true });
      expect(words(note(markup))).toBe(ALL_THAT_IS_LEFT);
      expect(markup).not.toContain('class="order-copy"');
    });
  });

  describe("on a fresh load of its link, once it has finished", () => {
    const notice = () => draw(() => createElement(OrderDeleted));

    it("says only that the order finished and that its record was deleted, with one way on", () => {
      expect(words(notice())).toBe(`IntentSwap ${NOTICE} Go to the swap page`);
      expect(notice()).toBe(
        '<section class="notice-page"><header class="notice-head"><p class="notice-tag mono">IntentSwap</p><h1 class="notice-title">This order finished.</h1><div class="notice-lead muted"><p>It was made in Ghost mode, so its record was deleted when it finished. Nothing more is kept of it here.</p></div></header><button type="button" class="button-secondary">Go to the swap page</button></section>',
      );
    });

    it("holds nothing of an order: no status, no amount, no coin, no address, no ID, and nowhere to look for one", () => {
      const text = words(notice());
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/Delivered|Refunded|Expired|Failed|Swapping|Waiting|deposit|refund|sent|received|ETH|USDT|\bto your\b|address|0x|Track|ID\b|link/i);
      // It is given nothing of the order to show, and the page draws it alone.
      const code = shown("pages/OrderPage.tsx");
      // It is handed one thing: how the order ended, one of three words, which is all the server still says of it.
      expect(code).toContain("export function OrderDeleted({ ended = null }: { ended?: SaidEnding | null }) {");
      expect(part(code, "export function OrderDeleted(")).not.toMatch(/\border\.|\{order\b|\bid\b|props|window|location|use[A-Z]\w*\(/);
      expect(code).toContain("if (deleted && order === null) return <OrderDeleted ended={endedAs} />;");
      expect(code.indexOf("if (deleted && order === null) return <OrderDeleted ended={endedAs} />;")).toBeLessThan(code.indexOf("if (order === null) {"));
      // With the word, the notice says it in one sentence before the rest, and still nothing else of the order.
      for (const [ended, said] of [["delivered", "It was delivered."], ["refunded", "It was refunded."], ["expired", "It ran out without being paid."]] as const) {
        expect(words(draw(() => createElement(OrderDeleted, { ended })))).toContain(`This order finished. ${said} It was made in Ghost mode, so its record was deleted when it finished. Nothing more is kept of it here.`);
      }
      expect(endingSaid({ ended: "delivered" })).toBe("delivered");
      for (const odd of [undefined, null, {}, { ended: "swapping" }, { ended: 1 }, { ended: "Delivered" }]) expect(endingSaid(odd as Record<string, unknown>)).toBeNull();
    });

    it("is the same in both modes", () => {
      expect(draw(() => createElement(OrderDeleted), { ghost: true })).toBe(notice());
    });
  });

  describe("how the page comes to say so", () => {
    const code = source("pages/OrderPage.tsx");

    it("takes the server's answer that the record is deleted, stops asking, and stops its clock", () => {
      // The answer is known by its code, as the server's errors are; nothing more is asked after it.
      expect(code).toMatch(/if \(err instanceof ApiError && err\.code === "order_deleted"\) \{\s*\/\/[^\n]*\n\s*setReconnecting\(false\);\s*setEndedAs\(endingSaid\(err\.detail\)\);\s*setDeleted\(true\);\s*return;\s*\}/);
      // It comes before the look that would count as a failed try, so the page never says "Reconnecting" of an order that is gone.
      expect(code.indexOf('err.code === "order_deleted"')).toBeLessThan(code.indexOf("failures.current += 1;"));
      // The order the page was showing is kept as it was, and handed on as gone.
      expect(code).toContain("<OrderContent order={order} now={now} reconnecting={reconnecting} contact={contact} onOrder={setOrder} privacyMode={privacyMode} gone={deleted} how={endedAs}>");
      expect(code).toMatch(/useEffect\(\(\) => \{\s*if \(deleted\) return;\s*const timer = setInterval\(\(\) => setNow\(serverNow\(\)\), 1000\);/);
      // Another order opened in the same tab starts afresh.
      expect(code).toMatch(/setOrder\(null\);\s*setMissing\(false\);\s*setDeleted\(false\);/);
    });

    it("looks at an ended order made in Ghost mode a few times more, so as to learn that its record is gone, and then no more", () => {
      expect(code).toContain("if (next === null && fresh.ghost === true) next = ghostLookAgain(looksAfterEnd++);");
      expect([0, 1, 2, 3, 4].map(ghostLookAgain)).toEqual([2000, 5000, 10_000, 20_000, 30_000]);
      // After those it stops: an order that ended with coins still in it is kept on the server, and there is nothing to wait for.
      for (const looks of [5, 6, 50]) expect(ghostLookAgain(looks)).toBeNull();
      // Any other ended order is not looked at again, as ever.
      for (const status of ["delivered", "refunded", "failed", "expired"] as const) expect(pollDelay(status, 0)).toBeNull();
    });

    it("writes nothing to the browser in the mode: its own list is left as it is, and no balance is read", () => {
      expect(code).toContain("if (!ghostOn()) useOrders.getState().forget(id);");
      expect(code).toContain('if (fresh.status === "delivered" && seen !== null && seen !== "delivered" && !ghostOn()) void useWallet.getState().loadBalances([fresh.from, fresh.to], 0);');
      // Nothing on the page, or in the parts of it that are this page's own, touches the browser's storage itself.
      for (const file of ["pages/OrderPage.tsx", "pages/TrackPage.tsx", "pages/RewardsPage.tsx", "pages/DocsPage.tsx", "pages/LegalPages.tsx", "components/RecentList.tsx", "components/Faq.tsx", "components/Home.tsx", "lib/order-logic.ts"]) {
        expect(shown(file), file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      }
      // The only other store of this page's that writes is used by one call each.
      expect(shown("pages/OrderPage.tsx").match(/useOrders\./g)).toHaveLength(1);
    });
  });
});

describe("the Track order page in Ghost mode", () => {
  it("draws no list of the orders made in this browser, whatever the browser holds, and one line in its place", () => {
    const markup = draw(trackPage, { ghost: true, orders: KEPT });
    expect(markup).not.toMatch(/track-recent|recent-list|recent-row|recent-note/);
    expect(markup).not.toMatch(/\/order\/|KeptOrder/);
    expect(words(markup)).not.toMatch(/Clear history|ETH to USDT|USDC to BNB|kept only in this browser/);
    expect(markup).toContain(`<p class="recent-hidden muted">${LIST_NOT_SHOWN}</p>`);
    // The line is the last thing on the page, where the list would be: after the field and its button.
    expect(markup.indexOf("recent-hidden")).toBeGreaterThan(markup.indexOf('class="track-form"'));
    expect(markup.endsWith(`<p class="recent-hidden muted">${LIST_NOT_SHOWN}</p></section>`)).toBe(true);
    // The same line whether this browser holds orders or none: the page says nothing of what is kept.
    expect(draw(trackPage, { ghost: true })).toBe(markup);
  });

  it("keeps the field for an order's link, its ID or a deposit address", () => {
    const markup = draw(trackPage, { ghost: true, orders: KEPT });
    expect(markup).toContain('<label class="address-label" for="track-input">Order ID or deposit address</label>');
    expect(markup).toMatch(/<textarea id="track-input"/);
    expect(markup).toMatch(/<button type="submit" class="button-primary"[^>]*>Enter order ID or address<\/button>/);
  });

  it("out of the mode, draws the list again with the same stored orders", () => {
    const markup = draw(trackPage, { orders: KEPT });
    expect(markup).toContain('<section class="track-recent" aria-labelledby="track-recent-title"><h2 id="track-recent-title" class="track-recent-title">Orders made in this browser</h2>');
    expect([...markup.matchAll(/<a class="recent-row" href="\/order\/([^"]+)"/g)].map((row) => row[1])).toEqual(KEPT.map((kept) => kept.id));
    expect(words(markup)).toContain("ETH to USDT");
    expect(words(markup)).toContain("Clear history");
    expect(markup).not.toContain("recent-hidden");
    expect(words(markup)).not.toContain(LIST_NOT_SHOWN);
    // With nothing stored there is no list and no line: nothing stands where the list would.
    expect(draw(trackPage)).not.toMatch(/track-recent|recent-hidden/);
  });

  it("the list itself is never drawn in the mode, whoever asks for it", () => {
    const list = () => createElement(RecentList, { orders: KEPT, onOpen: () => undefined, onClear: () => undefined });
    expect(draw(list, { ghost: true })).toBe(`<p class="recent-hidden muted">${LIST_NOT_SHOWN}</p>`);
    expect(draw(() => createElement(RecentHidden))).toBe(`<p class="recent-hidden muted">${LIST_NOT_SHOWN}</p>`);
    expect(draw(list)).toMatch(/^<div class="recent"><ul class="recent-list">/);
  });

  it("says, in both modes, that an order made in Ghost mode opens from its own link only", () => {
    // Said to everyone: the person who needs it most has closed the tab the order was made in, and is no longer in the mode.
    for (const held of [{}, { ghost: true }, { config: ROUTED_PRIVATELY }, { config: WITHOUT_STATS }, { config: null }]) expect(words(draw(trackPage, held))).toContain(OWN_LINK_ONLY);
    expect(words(draw(trackPage, { config: WITHOUT_STATS }))).toContain(`Paste the order's link or ID, or the deposit address you sent to. It opens that order's page. ${OWN_LINK_ONLY}`);
    expect(words(draw(trackPage))).toContain(`Once an order has been delivered, it opens from its link or ID only. ${OWN_LINK_ONLY}`);
    expect(words(draw(trackPage, { config: ROUTED_PRIVATELY }))).toContain(`A privately routed order, and any order once it has been delivered, opens from its link or ID only. ${OWN_LINK_ONLY}`);
  });

  it("leads a finished Ghost order's link or ID to that order's own page, which says what there is to say", () => {
    expect(source("pages/TrackPage.tsx")).toMatch(/\.catch\(\(error: unknown\) => \(error instanceof ApiError && error\.code === "order_deleted" \? \{ kind: "found", id \} : outcome\(error\)\)\)/);
  });
});

describe("the Docs' page on Ghost mode", () => {
  const sections = (markup: string) => [...markup.matchAll(/<h2 id="([^"]+)" data-title="([^"]+)"/g)].map((match) => `${match[1]}: ${match[2]}`);
  const section = (markup: string, id: string) => words(new RegExp(`<h2 id="${id}"[\\s\\S]*?(?=<h2 id="|<nav class="docs-turn")`).exec(markup)?.[0] ?? "");

  it("is a page at /docs/ghost-mode, however swaps are routed, and is in the contents after 'Staying safe'", () => {
    expect(GHOST_DOC_SLUG).toBe("ghost-mode");
    expect(docHref(GHOST_DOC_SLUG)).toBe("/docs/ghost-mode");
    expect(isDocSlug("ghost-mode")).toBe(true);
    expect(matchRoute("/docs/ghost-mode")).toEqual({ page: "docs", slug: "ghost-mode" });
    for (const privateRouting of [false, true]) {
      // The server answers the addresses on this list with the site's page; the site's own router shows the page wherever it exists.
      expect(docSlugs(privateRouting), String(privateRouting)).toContain("ghost-mode");
      expect(docExists(GHOST_DOC_SLUG, privateRouting)).toBe(true);
      const pages = docPages(privateRouting).map((page) => page.href);
      expect(pages.indexOf("/docs/ghost-mode")).toBe(pages.indexOf("/docs/rewards") - 1);
      expect(pages.indexOf("/docs/ghost-mode")).toBeGreaterThan(pages.indexOf("/docs/safety"));
    }
    expect(DOC_SLUGS.indexOf("ghost-mode")).toBe(DOC_SLUGS.indexOf("private") + 1);
    expect(DOC_PAGES).toContainEqual({ href: "/docs/ghost-mode", title: "Ghost mode", group: "Guide" });
    // As drawn: its title, its place in the contents of every page of the documentation, and the pages before and after it.
    const markup = draw(ghostDocs);
    expect(markup).toContain("<h1>Ghost mode</h1>");
    expect(markup).toContain('<a href="/docs/ghost-mode" class="docs-page-link" aria-current="page">Ghost mode</a>');
    for (const other of [docsPage(null), docsPage("fees"), docsPage("faq"), privacy, terms]) expect(draw(other)).toContain('<a href="/docs/ghost-mode" class="docs-page-link">Ghost mode</a>');
    expect(markup).toMatch(/<a href="\/docs\/safety" class="docs-turn-link" data-way="previous">/);
    expect(markup).toMatch(/<a href="\/docs\/rewards" class="docs-turn-link" data-way="next">/);
    expect(draw(ghostDocs, { config: ROUTED_PRIVATELY })).toMatch(/<a href="\/docs\/private" class="docs-turn-link" data-way="previous">/);
  });

  it("has these sections, in this order", () => {
    expect(sections(draw(ghostDocs))).toEqual(["what: What it is", "does: What it does", "not: What it does not do", "kept: What is still kept", "same: What it does not change", "switch: Turning it on and off"]);
    // Where swaps are routed privately, one more, on how the two sit side by side.
    expect(sections(draw(ghostDocs, { config: ROUTED_PRIVATELY }))).toEqual(["what: What it is", "does: What it does", "not: What it does not do", "kept: What is still kept", "same: What it does not change", "private-routing: Ghost mode and private routing", "switch: Turning it on and off"]);
  });

  it("says what it is: one switch, in the header", () => {
    const text = words(draw(ghostDocs));
    expect(text).toContain("One switch in the header. While it is on, this site loads no wallet software, asks nothing of any other site and keeps nothing in your browser but the switch itself, and the record of an order you make is deleted from its server when the order finishes. This page says what that covers, and what it does not.");
    expect(section(draw(ghostDocs), "what")).toContain("Ghost mode is one switch, in the header. With it on, a swap works as it always does: a quote, a review, an order, a deposit, a delivery. What changes is what the site loads, what it asks of other sites, and what it and your browser keep. It changes how the site is used, not the swap. The swap itself is the same, and as public as any other.");
  });

  it("says the five things it does, each with its one true detail", () => {
    const does = section(draw(ghostDocs), "does");
    expect(draw(ghostDocs).match(/<h2 id="does"[\s\S]*?<\/ul>/)?.[0].match(/<li>/g)).toHaveLength(5);
    for (const sentence of [
      "Five things, for as long as the switch is on.",
      // The switch: remembered for the tab only, and gone with the tab.
      "The switch is the one thing remembered. It is kept as a single on/off flag for this tab, so that loading the page again does not turn Ghost mode off. It ends when the tab is closed.",
      // No wallet, and so no sign-in on the Rewards page.
      "No wallet is loaded. The wallet software is not fetched at all, so there is no Connect and no balance is read. A wallet that was connected is disconnected, and what its software left in your browser is removed. You pay by sending to the order's deposit address, from any wallet. The Rewards sign-in needs a wallet, so it is off too.",
      // Nothing goes to anyone else; links out still work.
      "Nothing is asked of any other site. The page asks nothing of any address but this site's own, and tells your browser to refuse anything else. A link that leaves the site still works as a plain link: it opens in a new tab, carries a small mark that says it leaves this site, and does not tell the other site where you came from.",
      // Nothing kept in the browser; earlier orders come back unless they were cleared.
      'Nothing is kept in your browser. No list of your orders, no copy of the coin list, no note of any kind: only the switch itself. Orders you made earlier, in normal mode, are not shown while Ghost mode is on. They are there again when you turn it off, unless you chose "Also clear what this browser already holds" when you turned it on.',
      // On the server: deleted the moment it finishes; its own link only; never by its deposit address.
      "An order's record is deleted when it finishes. An order made in Ghost mode is marked as one. The moment it is delivered or refunded, or its deadline passes unpaid, its record is deleted from the server. Until then its own link is the only way back to it: it is on no list, and it is never found from its deposit address. After that the link says only that the order finished.",
      "Keep the order's link. It is the only way back to an order made in Ghost mode, and it is not saved anywhere. The order's page has a Copy link button.",
    ])
      expect(does, sentence).toContain(sentence);
  });

  it("says, in a section of its own, each thing it does not do", () => {
    const markup = draw(ghostDocs);
    const not = section(markup, "not");
    expect(markup).toMatch(/<h2 id="not"[\s\S]*?<aside class="callout" data-tone="warning">[\s\S]*?<p class="callout-title">Ghost mode does not make a swap less public\.<\/p>/);
    for (const sentence of [
      "Ghost mode does not make a swap less public. It is about what this site and your browser keep. It changes nothing on any blockchain.",
      // The deposit and the delivery are still public on their own chains.
      "The deposit and the delivery are still public. Each is an ordinary transfer on its own chain, where anyone can see the addresses and the amounts. So is a refund.",
      // The swap provider still handles the swap.
      "The swap service still carries out the swap. NEAR Intents receives what it does for any swap (the coins, the amounts and your addresses) and keeps its own records.",
      // The person's network address is still seen by their network and by this site's host.
      "Your network address is still seen. By your own network, and by this site's host, which stands in front of the server and may keep its own record of each request. This site's own access log is kept as for any visit, with the address in a shortened form. The Privacy Policy says what each holds.",
      // And the browser's own record of the pages opened is the browser's.
      "Your browser's own history is not cleared. The browser lists the pages you open, an order's link among them, as it does for any site. That list is the browser's, not this site's.",
    ])
      expect(not, sentence).toContain(sentence);
    expect(markup).toMatch(/<h2 id="not"[\s\S]*?<a href="\/privacy">Privacy Policy<\/a>/);
  });

  it("says what is still kept of an order made in the mode, and what the mode does not change", () => {
    const kept = section(draw(ghostDocs), "kept");
    for (const sentence of [
      "Once an order made in Ghost mode has finished, this is all the server still holds of it.",
      "A one-way fingerprint of the order's ID, for 30 days. It is there so that the order's link can say that the order finished, where it would otherwise say that there is no such order. The ID itself is not kept.",
      "Its place in the totals. The Stats page counts it in its totals: the swaps, the volume, the chains and the coins. It has no row among the recent swaps, and its deposit transaction is never listed.",
      "Its points, if you named a rewards address. They are counted before the record is deleted, and kept as any points are: a one-way fingerprint of the order's ID, the rewards address, the swap's value in US dollars, its two coins and their chains, and the time. Leave the rewards address empty and the swap adds no points, and none of this is kept.",
      "Lines in the logs. The server's logs name an order by a one-way fingerprint only, and are kept as for any order. For an order made in Ghost mode they carry no address and no transaction hash.",
      "One kind of order is kept longer. An order that fails with coins still in it is kept until that has been dealt with, as any order is, and deleted then.",
      // What follows from the deletion for a payment that comes too late.
      "Pay before the order's deadline. A deposit sent after the deadline may be lost, as for any order. With the record deleted, there is no deposit address and no amount left here to check a late payment against.",
    ])
      expect(kept, sentence).toContain(sentence);
    // Where the site has no Stats page, the totals are the server's own and no page is named.
    const without = section(draw(ghostDocs, { config: WITHOUT_STATS }), "kept");
    expect(without).toContain("Its place in the totals. The server's running totals count it: the swaps, the volume, the chains and the coins. No row is kept for it.");
    expect(words(draw(ghostDocs, { config: WITHOUT_STATS }))).not.toMatch(/Stats page/);
    expect(section(draw(ghostDocs), "same")).toContain("Ghost mode switches off no check and adds no fee. The quote and the provider's signature on it are checked, the limits apply, and every address is screened against the sanctions list, as for any order. A swap costs what it costs in normal mode, and its quote shows every fee before you confirm.");
  });

  it("says how it sits beside private routing only where swaps are routed privately, and nothing of private swaps anywhere else", () => {
    const privately = draw(ghostDocs, { config: ROUTED_PRIVATELY });
    expect(section(privately, "private-routing")).toContain("They are two separate things. Private routing is how the swap service routes a swap. Ghost mode is what this site and this browser keep. Either can be on without the other. Swaps on this site are routed privately, so an order made in Ghost mode is routed privately too. How private routing works");
    expect(privately).toMatch(/<h2 id="private-routing"[\s\S]*?<a href="\/docs\/private">How private routing works<\/a>/);
    // Outside that section the page says nothing of it. (What is left is its name in the contents, which every page carries.)
    const outside = words(privately.replace(/<section class="prose-section" aria-labelledby="private-routing">[\s\S]*?<\/section>/, "")).replaceAll("Private routing", "");
    expect(outside).not.toMatch(/\b(?:private(?:ly)?|confidential(?:ity|ly)?)\b/i);
    for (const config of [SETTINGS, WITHOUT_STATS, null]) {
      const markup = draw(ghostDocs, { config });
      expect(words(markup)).not.toMatch(/\b(?:private(?:ly)?|confidential(?:ity|ly)?)\b/i);
      expect(markup).not.toMatch(/\/docs\/private|private-routing/);
    }
  });

  it("ends with how to turn it on and off", () => {
    const markup = draw(ghostDocs);
    expect(sections(markup).at(-1)).toBe("switch: Turning it on and off");
    expect(section(markup, "switch")).toContain(
      'Press the Ghost mode button in the header. The first time since the page was loaded, a short sheet says what the mode does and asks "Turn on" or "Not now". The same sheet offers "Also clear what this browser already holds", which removes what the site kept here in normal mode. While it is on, the header shows "Ghost mode" where Connect would be. Press that to turn it off. The page then loads itself again, in normal mode. Closing the tab turns it off as well.',
    );
  });

  it("the guide's page on tracking says that an order made in the mode is found from its own link only", () => {
    for (const config of [SETTINGS, ROUTED_PRIVATELY, WITHOUT_STATS]) {
      const markup = draw(docsPage(null), { config });
      expect(words(markup)).toContain("An order made in Ghost mode is found from its own link only, and only until it finishes.");
      expect(markup).toContain('An order made in <a href="/docs/ghost-mode">Ghost mode</a> is found from its own link only');
    }
  });
});

describe("the Privacy Policy on Ghost mode", () => {
  const GHOST_PARAGRAPH = (rows: string) =>
    `Ghost mode. An order made in Ghost mode is marked as one. While it runs, the server keeps it as it keeps any order. The moment it finishes (it is delivered or refunded, or its deadline passes unpaid) its record is deleted; one that fails with coins still in it is kept until it has been dealt with, as any order is. After the deletion the server still holds three things of it: a one-way fingerprint of the order's ID, for 30 days, so that the order's link can say that the order finished; its place in the running totals, ${rows}; and, if the order has a rewards address, its points, which are written down before the record is deleted and kept as set out under Points. The logs name it by a one-way fingerprint, as they name any order, and hold neither an address nor a transaction hash of it. It is never found from its deposit address. Ghost mode changes nothing else on this page: the access log and your network address are treated as for any visit, the host keeps its own record of each request, the swap service receives what it does for any swap and keeps its own records, and every transfer is public on its blockchain.`;
  const section = (markup: string, id: string) => new RegExp(`<h2 id="${id}"[\\s\\S]*?(?=<h2 id="|<nav class="docs-turn")`).exec(markup)?.[0] ?? "";

  it("has one paragraph on it, among what is kept on the server, with a link to the page that explains it", () => {
    for (const config of [SETTINGS, ROUTED_PRIVATELY]) {
      const markup = draw(privacy, { config });
      const server = section(markup, "what-is-kept-on-the-server-and-for-how-long");
      expect(words(server)).toContain(GHOST_PARAGRAPH("with no row among the Stats page's recent swaps and no listing of its deposit transaction"));
      expect(server).toContain('<strong>Ghost mode.</strong> An order made in <a href="/docs/ghost-mode">Ghost mode</a> is marked as one.');
      // The last of that section's list, after everything it refers to.
      expect(server.match(/<li>/g)).toHaveLength(10);
      expect(server.lastIndexOf("<li>")).toBe(server.indexOf("<li><strong>Ghost mode.</strong>"));
      expect(markup.match(/<strong>Ghost mode\.<\/strong>/g)).toHaveLength(1);
    }
    // Where the site has no Stats page, it names none.
    const without = words(draw(privacy, { config: WITHOUT_STATS }));
    expect(without).toContain(GHOST_PARAGRAPH("with no row kept for it"));
    expect(without).not.toMatch(/Stats page/);
  });

  it("makes the page's other sentences true of an order made in the mode: when an order is deleted, and what is listed", () => {
    const text = words(draw(privacy));
    expect(text).toContain("An order that was never paid is deleted 24 hours after its deadline. Other orders are deleted 30 days after they finish. An order made in Ghost mode is deleted sooner than either: the moment it finishes (see Ghost mode, below). An unfinished order that has coins in it is kept until it has been dealt with.");
    expect(text).toContain("Stats. Every delivered swap, except one made in Ghost mode, is listed on the Stats page");
    expect(text).not.toMatch(/Every delivered swap is listed/);
    expect(words(draw(privacy, { config: WITHOUT_STATS }))).toContain("one row for each delivered swap, except one made in Ghost mode: the coin sent");
    // The page on private routing says the same of what the Stats page lists.
    expect(words(draw(docsPage("private"), { config: ROUTED_PRIVATELY }))).toContain("The Stats page lists the deposit transaction of every delivered swap, privately routed or not, except one made in Ghost mode:");
  });

  it("says what the browser keeps in the mode: the one flag, for the tab", () => {
    const markup = draw(privacy);
    const browser = section(markup, "what-is-kept-in-your-browser");
    const items = [...browser.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((item) => words(item[1]!));
    expect(items).toHaveLength(7);
    expect(items.at(-1)).toBe(
      "While Ghost mode is on, none of the above is written. One thing is kept: a flag for this tab that says the mode is on, so that loading the page again does not turn it off. It ends when the tab is closed. The list of orders you made earlier is not shown while the mode is on, and is still there when you turn it off, unless you chose to clear what this browser already holds. No wallet-connection software is loaded, and the notes it left from an earlier connection are removed.",
    );
  });

  it("carries the version that orders are held to, as the Terms do: one label for both pages", () => {
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const page of [privacy, terms]) expect(draw(page)).toContain(`<p class="docs-version muted">Version ${TERMS_VERSION}</p>`);
    // The label is the date of the text. This text was last changed on the day Ghost mode was written into it.
    expect(TERMS_VERSION >= "2026-10-10").toBe(true);
  });
});

describe("the question on Ghost mode", () => {
  it("is asked everywhere, once, after the question on who can see a swap", () => {
    for (const privateRouting of [false, true]) {
      const ids = questions(privateRouting).map((item) => item.id);
      expect(ids.filter((id) => id === "ghost-mode")).toHaveLength(1);
      expect(ids.indexOf("ghost-mode")).toBe(ids.indexOf("public") + 1);
      expect(questions(privateRouting).find((item) => item.id === "ghost-mode")?.question).toBe("What is Ghost mode?");
    }
  });

  it("is answered in three plain sentences and a link to the page that explains the rest, on the home page and in the Docs", () => {
    for (const config of [SETTINGS, ROUTED_PRIVATELY, null]) {
      for (const page of [faq, docsPage("faq")]) {
        const markup = draw(page, { config });
        expect(words(markup)).toContain(`What is Ghost mode? ${page === faq ? "" : "Link to this section "}${FAQ_ANSWER}`);
        expect(markup).toContain('<a href="/docs/ghost-mode">How Ghost mode works</a>');
      }
    }
    expect(FAQ_ANSWER.replace(" How Ghost mode works", "").match(/[.](?= |$)/g)).toHaveLength(3);
    // The answer on finding an order again says what is different for an order made in the mode.
    expect(words(draw(faq))).toContain("Orders made in this browser are also listed on the Track order page. An order made in Ghost mode is on no list: its own link is the only way back to it.");
  });
});

describe("the home page's line for Ghost mode", () => {
  it("is on the list of what the site does, in the list's own manner: a title, a few sentences, a link", () => {
    for (const [tokenSet, privateRouting] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      const item = features(tokenSet, privateRouting).find((feature) => feature.key === "ghost");
      expect(item).toEqual({ key: "ghost", title: "Ghost mode", text: HOME_LINE, link: { href: "/docs/ghost-mode", label: "How Ghost mode works" } });
      // After points, and before the token where there is one.
      expect(features(tokenSet, privateRouting).map((feature) => feature.key)).toEqual(["swaps", "tracking", "rewards", "ghost", ...(tokenSet ? ["token"] : [])]);
    }
    // No longer than the longest of the others, and it ends on the first thing the mode does not do.
    const others = features(true, true).filter((feature) => feature.key !== "ghost");
    expect(HOME_LINE.length).toBeLessThanOrEqual(Math.max(...others.map((feature) => feature.text.length)) + 30);
    expect(HOME_LINE.endsWith("Your deposit and your delivery are still public on-chain.")).toBe(true);
  });

  it("is drawn on the stage as the others are: its number, its words, its link and a drawing of its own", () => {
    const markup = draw(home);
    expect(words(markup)).toContain(`Ghost mode ${HOME_LINE} How Ghost mode works`);
    expect(markup).toMatch(/<a href="\/docs\/ghost-mode" class="stage-link draw">How Ghost mode works/);
    // Every item has a tab, a panel and a drawing.
    const count = features(false).length;
    expect(markup.match(/<button type="button" role="tab"/g)).toHaveLength(count);
    expect(markup.match(/<div role="tabpanel"/g)).toHaveLength(count);
    expect(markup.match(/<div class="stage-art"><svg class="art" viewBox="0 0 280 200" aria-hidden="true" focusable="false">/g)).toHaveLength(count);
    // The drawing is in the line style of the others: the same marks, the same strokes, nothing coloured by itself.
    const stage = source("components/Stage.tsx");
    const art = part(stage, "function GhostArt()");
    expect(art).toMatch(/className="art-quiet"[^>]*strokeDasharray="2 8"/);
    for (const mark of ["art-line", "art-accent", "art-count", "art-kept"]) expect(art, mark).toContain(mark);
    expect(art).not.toMatch(/fill=|stroke=|style=|#[0-9a-f]{3,6}/i);
    expect(stage).toContain("ghost: GhostArt,");
    // Its movement is a fading and nothing else, and where the system asks for less movement it does not move at all.
    const css = source("styles/home.css");
    expect(css).toMatch(/\.stage\[data-seen\] \[data-active\] \.art-kept \{\s*animation: art-off /);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.stage\[data-seen\] \[data-active\] \.art-kept,/);
  });
});

describe("the Stats page", () => {
  it("is the same in both modes, and what it says under 'Recent swaps' stays true of an order made in Ghost mode", () => {
    const stats = { totals: { swaps: 13, volumeUsd: 1500, volume24hUsd: 400, chains: 2, deliverySeconds: 72 }, coins: [], received: null, chains: [], chainsUsed: [{ chain: "base", swaps: 12, share: 31 }], feed: [] };
    const page = () => createElement(StatsContent, { stats, chains: [{ key: "base", name: "Base" }] });
    expect(draw(page, { ghost: true })).toBe(draw(page));
    // Such an order is counted in the totals and never listed. The line speaks of the rows there are, and says nothing of every swap.
    expect(words(draw(page))).toContain("Recent swaps Each row links to the deposit on its own chain. Which swap was delivered where is never shown.");
    const code = shown("pages/StatsPage.tsx");
    expect(code).not.toMatch(/every delivered swap|each delivered swap|all delivered swaps|every swap/i);
    // Nothing on the page reads the mode: it changes only through the header it shares with every page.
    expect(source("pages/StatsPage.tsx")).not.toMatch(/ghost/i);
  });
});

describe("what the site says of Ghost mode, taken together", () => {
  beforeEach(() => vi.stubGlobal("window", { location: { origin: "https://intentswap.example", search: "" } }));
  afterEach(() => vi.unstubAllGlobals());

  const content = (example: OrderView, gone = false) => () => createElement(OrderContent, { order: example, now: NOW, reconnecting: false, contact: null, onOrder: () => undefined, gone });
  /** Every text of the feature, as it is drawn: each page in and out of the mode, however swaps are routed, with and without the Stats page. */
  const texts = (): (readonly [string, string])[] => {
    const out: [string, string][] = [];
    for (const [routed, config] of [["public", SETTINGS], ["private", ROUTED_PRIVATELY], ["no Stats page", WITHOUT_STATS]] as const) {
      for (const ghost of [false, true]) {
        const held = { config, ghost, orders: KEPT };
        const where = `${routed}, ${ghost ? "in the mode" : "out of it"}`;
        out.push([`Docs, Ghost mode (${where})`, words(draw(ghostDocs, held))]);
        out.push([`Docs, How it works (${where})`, words(draw(docsPage(null), held))]);
        out.push([`the Privacy Policy (${where})`, words(draw(privacy, held))]);
        out.push([`the questions (${where})`, words(draw(faq, held))]);
        out.push([`the home page (${where})`, words(draw(home, held))]);
        out.push([`Track order (${where})`, words(draw(trackPage, held))]);
        out.push([`Rewards (${where})`, words(draw(rewardsPage, held))]);
        out.push([`an order waiting (${where})`, words(draw(content(order({ ghost: true })), held))]);
        out.push([`an order delivered and deleted (${where})`, words(draw(content(delivered({ ghost: true }), true), held))]);
        out.push([`an order deleted unseen (${where})`, words(draw(content(swapping({ ghost: true }), true), held))]);
        out.push([`the notice (${where})`, words(draw(() => createElement(OrderDeleted), held))]);
      }
    }
    return out;
  };
  /** The sentences that are the feature's own, wherever they are drawn. */
  const OWN = [SIGN_IN_OFF, ONLY_WAY_BACK, DELETED_WHEN_IT_FINISHES, ALL_THAT_IS_LEFT, ENDING_NOT_SEEN, NOTICE, LIST_NOT_SHOWN, OWN_LINK_ONLY, FAQ_ANSWER, HOME_LINE];
  /** The same sentences that say what private routing is not, as the wording test allows them: they are no word about Ghost mode. */
  const allowed = (text: string) => text.replace(/Private routing is not anonymity/g, "").replace(/no route guarantees it/gi, "");

  it("uses none of the words the site never uses, on any page, in or out of the mode", () => {
    const all = texts();
    expect(all).toHaveLength(66);
    for (const [where, text] of all) {
      expect(text.length, where).toBeGreaterThan(30);
      expect(NEVER.test(allowed(text)), where).toBe(false);
    }
    for (const sentence of OWN) expect(NEVER.test(sentence), sentence).toBe(false);
  });

  it("uses none of the words that would promise more than it does, and never says that anything is on its way", () => {
    // Of Ghost mode the site says what is kept and what is not. It never says that a person is hidden, safe or unseen,
    // that nothing at all is kept, or that a rule does not apply; and nothing about it is said to be coming.
    const MORE = new RegExp(
      [
        "\\b(?:secret\\w*|stealth\\w*|incognito|untrace\\w*|hid(?:e|es|den|ing)|conceal\\w*|cloak\\w*|vanish\\w*|disappear\\w*|eras(?:e|es|ed|ing)|shred\\w*|burn(?:s|ed|ing)?)\\b",
        "\\b(?:no|zero|without)[- ](?:logs?|logging|records?|tracking|trace|footprint)\\b",
        "\\bnothing (?:at all )?is (?:kept|stored|logged|recorded)(?! in your browser)\\b",
        "\\b(?:safe|protected|shielded) from\\b|\\bprotects? you\\b",
        "coming soon|not yet|\\bsoon\\b|\\bplanned\\b",
        "\\b(?:without|skips?|skipping) (?:the )?(?:screening|checks?|limits?)\\b|\\bno (?:screening|checks|limits)\\b",
      ].join("|"),
      "i",
    );
    for (const sentence of OWN) expect(MORE.test(sentence), sentence).toBe(false);
    // The pages that are about the mode and nothing else are held to it whole.
    for (const config of [SETTINGS, ROUTED_PRIVATELY, WITHOUT_STATS]) {
      const page = draw(ghostDocs, { config });
      const body = words(/<article[\s\S]*<\/article>/.exec(page)?.[0] ?? "");
      expect(body.length).toBeGreaterThan(2000);
      expect(MORE.exec(body)?.[0] ?? null).toBeNull();
    }
    const privacyPage = draw(privacy);
    for (const item of [...privacyPage.matchAll(/<li>((?:(?!<li>)[\s\S])*?Ghost mode[\s\S]*?)<\/li>/g)].map((match) => words(match[1]!))) expect(MORE.test(item), item.slice(0, 60)).toBe(false);
    // A check that can fail.
    for (const sentence of ["Ghost mode hides you.", "A secret swap.", "No logs are kept.", "Nothing is kept.", "Nothing is stored, anywhere.", "You are safe from prying eyes.", "Ghost orders skip screening.", "More is coming soon.", "It leaves no record.", "Your order vanishes."]) expect(MORE.test(sentence), sentence).toBe(true);
    for (const sentence of ["Nothing is kept in your browser.", "Its record is deleted from this site's server the moment it finishes.", "Ghost mode switches off no check and adds no fee.", "The server's logs name an order by a one-way fingerprint only."]) expect(MORE.test(sentence), sentence).toBe(false);
  });

  it("always calls it Ghost mode: capital G, small m, and never by another name", () => {
    for (const [where, text] of texts()) {
      const named = [...text.matchAll(/ghost(?:[ -]\w+)?/gi)].map((match) => match[0]);
      expect(named.filter((name) => name !== "Ghost mode"), where).toEqual([]);
    }
    // In the files themselves, outside the names the code gives things, the word stands only in "Ghost mode".
    const files = ["pages/RewardsPage.tsx", "pages/OrderPage.tsx", "pages/TrackPage.tsx", "pages/DocsPage.tsx", "pages/LegalPages.tsx", "components/Faq.tsx", "components/RecentList.tsx", "components/Home.tsx", "lib/site-logic.ts"];
    const CODE = /useGhost|ghostOn|ghostLookAgain|ghostTab|GhostNote|GhostMode|GhostArt|GHOST_DOC_SLUG|order-ghost[\w-]*|stores\/ghost\.ts|\/docs\/ghost-mode|"ghost-mode"|"ghost"|<Ghost\b|\bGhost,|\bghost\b(?! mode)/g;
    for (const file of files) expect(shown(file).replace(CODE, "").match(/ghost(?! mode)|(?<!\bGhost) mode\b.{0}ghost|GHOST|Ghost Mode|ghost mode/gi)?.filter((name) => name !== "Ghost") ?? [], file).toEqual([]);
    // It is a different thing from private routing, and is never called private.
    for (const sentence of OWN) expect(sentence).not.toMatch(/\bprivate|confidential/i);
  });

  it("the Docs, the Privacy Policy and the questions say the same of what is kept and what is not", () => {
    for (const config of [SETTINGS, ROUTED_PRIVATELY, WITHOUT_STATS]) {
      const docs = words(draw(ghostDocs, { config }));
      const policy = words(draw(privacy, { config }));
      const answer = words(draw(faq, { config }));
      // When the record is deleted: the moment the order finishes, said by each in its own sentence.
      expect(docs).toContain("The moment it is delivered or refunded, or its deadline passes unpaid, its record is deleted from the server.");
      expect(policy).toContain("The moment it finishes (it is delivered or refunded, or its deadline passes unpaid) its record is deleted");
      expect(answer).toContain("the record of an order you make is deleted from its server the moment the order finishes");
      // The one thing kept in the browser: the switch itself. Nobody says "nothing" without it.
      for (const text of [docs, policy, answer, HOME_LINE]) {
        const nothing = text.match(/keeps nothing in your browser[^.]*\./g) ?? [];
        for (const sentence of nothing) expect(sentence).toContain("but the switch itself");
      }
      expect(docs).toContain("only the switch itself");
      expect(policy).toContain("One thing is kept: a flag for this tab that says the mode is on");
      // What the server still holds: the fingerprint for 30 days, the totals, the points of an order that named an address.
      for (const text of [docs, policy]) {
        expect(text).toMatch(/one-way fingerprint of the order's ID, for 30 days/i);
        // An order that named a rewards address has more kept of it, for as long as points are kept, and both say so.
        expect(text).toMatch(/if (?:you named|the order has) a rewards address/i);
        expect(text).toMatch(/place in the (?:running )?totals/);
        expect(text).toMatch(/its points/i);
        expect(text).toMatch(/fails with coins still in it is kept until (?:that|it) has been dealt with/);
        expect(text).toContain("never found from its deposit address");
        expect(text).not.toMatch(/\b(?:14|7|60|90) days\b[^.]*fingerprint|fingerprint[^.]*\b(?:14|7|60|90) days\b/);
      }
      // What it does not do, in all three: the transfers are public, the swap service does the swap, the network address is seen.
      expect(docs).toContain("The deposit and the delivery are still public.");
      expect(answer).toContain("the deposit and the delivery are still public transfers");
      expect(policy).toContain("every transfer is public on its blockchain");
      expect(docs).toContain("The swap service still carries out the swap.");
      expect(answer).toContain("the swap service still carries out the swap");
      expect(policy).toContain("the swap service receives what it does for any swap and keeps its own records");
      expect(docs).toContain("Your network address is still seen.");
      expect(answer).toContain("your network and this site's host still see your network address");
      expect(policy).toContain("the access log and your network address are treated as for any visit, the host keeps its own record of each request");
      // The host's record, which the mode does not change, is still described by the policy as it is for any visit.
      expect(policy).toContain("may keep its own record of each request for its own period: the time, your full network address and the address requested.");
      // And none of them says that a check or a fee is different.
      expect(docs).toContain("Ghost mode switches off no check and adds no fee.");
      for (const text of [docs, policy, answer]) expect(text).not.toMatch(/Ghost mode[^.]*\b(?:is not|are not|isn't) screened|no screening|lower fee|higher fee|costs (?:more|less)/i);
    }
  });

  it("the order's own page, the Track order page and the Docs agree on how such an order is reached", () => {
    const docs = words(draw(ghostDocs));
    expect(docs).toContain("Until then its own link is the only way back to it");
    expect(ONLY_WAY_BACK).toContain("the only way back to this order");
    expect(OWN_LINK_ONLY).toContain("its own link only");
    expect(words(draw(faq))).toContain("its own link is the only way back to it");
    // After it has finished the link says only that it finished: the Docs and the notice say the same.
    expect(docs).toContain("After that the link says only that the order finished.");
    expect(NOTICE).toMatch(/^This order finished\./);
  });
});
