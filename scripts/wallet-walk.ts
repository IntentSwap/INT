// Paying from a connected wallet, walked in a real browser with a pretend wallet standing in
// for a real one. The pretend wallet announces itself the way browser wallets do, says yes or
// no when told to, and writes down every single thing it is asked. Nothing real is signed or
// sent: orders are made on the practice server, and the chain's answers are made up here.
//
// What the walk proves, for a wallet that lives in the browser (an extension):
//   - nothing of the wallet code, and no other site, is touched before "Connect" is pressed;
//   - after it, the page talks only to the three addresses the security policy names, sends no
//     usage report, and the console stays clean, also when this site's own chain route is down;
//   - the wallet is asked for its address and network, to change or add a network (with the
//     chain's own public node, never anyone's project address), and for exactly one transfer per
//     press of the pay button: the order's amount to the order's deposit address. Never an
//     approval, never a signature;
//   - a reload while a transfer is unconfirmed follows that transfer, with no wallet code and no
//     wallet, and does not offer to send it again; a transfer that fails on-chain or is replaced
//     in the wallet is told as such, and a second send takes a separate, deliberate press.
//
// An order is paid on each of the four networks a wallet can pay on: Ethereum, BNB Chain, Base and
// Arbitrum. It does not prove anything about a wallet on a phone reached through WalletConnect:
// that needs a real phone.
//
// Used by scripts/review-shots.ts (walk name: wallet).

import path from "node:path";
import type { Browser, Locator, Page, Route } from "playwright-core";
import { getAddress } from "viem";
import { axeProblems } from "./axe.ts";
import { freshSol, headerFits, orderPace, settle, testControl } from "./order-walk.ts";

// Made up from fixed text, so they are nobody's.
const WALLET = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
/** Another made-up address of the same kind, in its standard spelling, for the walk that changes the refund address in the review. */
const OTHER_REFUND = getAddress(`0x${"5e".repeat(20)}`);
const HASH = `0x${"ab".repeat(32)}`;
const NONCE = 7;
const ALLOWED_HOSTS = new Set(["api.web3modal.org", "relay.walletconnect.org", "verify.walletconnect.org"]);
/** What a wallet may be asked on this site. Anything else is a failure, whatever it is. */
const ALLOWED_ASKS = new Set([
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "net_version",
  "wallet_requestPermissions",
  "wallet_getPermissions",
  "wallet_revokePermissions",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "eth_sendTransaction",
]);
const APPROVE = "0x095ea7b3";
const NETWORKS: Record<number, { name: string; node: string }> = {
  1: { name: "Ethereum", node: "https://ethereum-rpc.publicnode.com" },
  56: { name: "BNB Chain", node: "https://bsc-dataseed.bnbchain.org" },
  8453: { name: "Base", node: "https://mainnet.base.org" },
  42161: { name: "Arbitrum", node: "https://arb1.arbitrum.io/rpc" },
};

interface Ask {
  method: string;
  params: unknown;
}

interface WalletWindow {
  __wallet: { mode: string; log: Ask[]; held: { yes(): void; no(): void } | null };
}

/** The pretend wallet. Plain text, because it runs in the page before anything else does. */
function pretendWallet(address: string, chainId: number, trusted: boolean, knows: number[]): string {
  return `(() => {
    const state = { chain: ${chainId}, mode: "accept", log: [], held: null, trusted: ${String(trusted)}, knows: ${JSON.stringify(knows)} };
    window.__wallet = state;
    const listeners = {};
    const emit = (name, value) => (listeners[name] || []).slice().forEach((fn) => fn(value));
    const hex = (n) => "0x" + n.toString(16);
    const refuse = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
    const provider = {
      on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); return provider; },
      removeListener(name, fn) { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); return provider; },
      async request({ method, params }) {
        state.log.push({ method, params: params === undefined ? null : JSON.parse(JSON.stringify(params)) });
        switch (method) {
          case "eth_requestAccounts":
            state.trusted = true;
            return ["${address}"];
          case "eth_accounts":
            // As real wallets do: no address for a site the person has not yet said yes to.
            return state.trusted ? ["${address}"] : [];
          case "eth_chainId":
            return hex(state.chain);
          case "net_version":
            return String(state.chain);
          case "wallet_requestPermissions":
          case "wallet_getPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "wallet_revokePermissions":
            return null;
          case "wallet_switchEthereumChain": {
            const wanted = parseInt(params[0].chainId, 16);
            // As real wallets do: a network the wallet has never heard of is refused with this code.
            if (!state.knows.includes(wanted)) throw Object.assign(new Error("Unrecognized chain ID."), { code: 4902 });
            state.chain = wanted;
            emit("chainChanged", hex(state.chain));
            return null;
          }
          case "wallet_addEthereumChain": {
            const added = parseInt(params[0].chainId, 16);
            state.knows.push(added);
            state.chain = added;
            emit("chainChanged", hex(state.chain));
            return null;
          }
          case "eth_sendTransaction":
            if (state.mode === "reject") throw refuse();
            if (state.mode === "hold") return new Promise((resolve, reject) => { state.held = { yes: () => resolve("${HASH}"), no: () => reject(refuse()) }; });
            return "${HASH}";
          default:
            throw Object.assign(new Error("Unsupported: " + method), { code: 4200 });
        }
      },
    };
    const icon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#444"/><circle cx="16" cy="16" r="6" fill="#fff"/></svg>');
    const detail = Object.freeze({ info: Object.freeze({ uuid: "7f0c3a0e-5b1d-4c58-9d55-1c6a6f6b2a11", name: "Test Wallet", icon, rdns: "test.wallet" }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
    document.addEventListener("securitypolicyviolation", (event) => console.error("refused by the security policy: " + event.violatedDirective + " " + event.blockedURI));
  })();`;
}

/** What the made-up chain currently says. Changed by the walk as it goes. */
interface ChainState {
  /** The sent transfer's receipt: none yet, a success, or a failure. */
  receipt: "none" | "success" | "failed";
  /** How many of the wallet's transactions are in blocks. The sent transfer is number 7. */
  count: number;
  /** The site's chain route cannot be reached. */
  down: boolean;
  /** The wallet's address holds code: it is a contract wallet, not a plain one. */
  code: boolean;
}

/** Answers for the chain, made up: a wallet with funds and no code, and a transfer whose fate the walk decides. */
function pretendChain(state: ChainState) {
  return async (route: Route): Promise<void> => {
    if (state.down) {
      await route.abort();
      return;
    }
    const posted = route.request().postDataJSON() as Ask | Ask[];
    // Several reads in one request (the coin picker's balances): each is answered, in order.
    if (Array.isArray(posted)) {
      const replies = posted.map((ask) => ({ jsonrpc: "2.0", id: ask.id ?? null, ...answer(ask) }));
      if (replies.some((reply) => !("result" in reply))) await route.continue();
      else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(replies) });
      return;
    }
    const reply = answer(posted);
    if (!("result" in reply)) {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: posted.id ?? null, result: reply.result }) });
  };

  interface Ask {
    id?: unknown;
    method?: string;
    params?: unknown[];
  }

  /** One read's answer, or nothing when the walk has none (the real route then answers). */
  function answer(body: Ask): { result: unknown } | Record<string, never> {
    const params = body.params ?? [];
    const call = (params[0] ?? {}) as { data?: string };
    let result: unknown;
    let answered = true;
    switch (body.method) {
      case "eth_getBalance":
        result = `0x${(5n * 10n ** 18n).toString(16)}`;
        break;
      case "eth_getCode":
        result = state.code ? "0x6080604052" : "0x";
        break;
      case "eth_call": {
        const data = typeof call.data === "string" ? call.data : "";
        const word = (value: bigint) => value.toString(16).padStart(64, "0");
        // balanceOf(address): 1,000 units of a six-decimal coin. getEthBalance(address): 5 of the chain's coin.
        const balance = data.includes("70a08231") ? 1000n * 10n ** 6n : data.includes("4d2301cc") ? 5n * 10n ** 18n : null;
        if (balance === null) {
          answered = false;
          break;
        }
        // Asked directly, the answer is the number. Asked through the shared "many calls in one" contract
        // (which the wallet library uses), it is a list holding one successful answer.
        result = data.startsWith("0x70a08231") ? `0x${word(balance)}` : `0x${[32n, 1n, 32n, 1n, 64n, 32n, balance].map(word).join("")}`;
        break;
      }
      case "eth_getTransactionReceipt":
        if (params[0] !== HASH) answered = false;
        else if (state.receipt === "none") result = null;
        else result = { transactionHash: HASH, transactionIndex: "0x0", blockHash: `0x${"cd".repeat(32)}`, blockNumber: "0x1000", from: WALLET.toLowerCase(), to: null, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: state.receipt === "success" ? "0x1" : "0x0", type: "0x2" };
        break;
      case "eth_getTransactionByHash":
        if (params[0] !== HASH) answered = false;
        else result = { hash: HASH, from: WALLET.toLowerCase(), nonce: `0x${NONCE.toString(16)}`, blockNumber: null };
        break;
      case "eth_getTransactionCount":
        result = `0x${state.count.toString(16)}`;
        break;
      default:
        answered = false;
    }
    return answered ? { result } : {};
  }
}

export interface WalkResult {
  complaints: string[];
  shots: number;
}

interface Setup {
  name: string;
  width: number;
  theme: "dark" | "light";
  /** The network the pretend wallet starts on, and the networks it has heard of. */
  startChain: number;
  knows: number[];
  /** The network the order is paid on. */
  payChain: number;
  /** What is swapped: the query string of the home page. */
  query: string;
  coin: "native" | "token";
  symbol: string;
  /** The wallet already trusts this site (the person connected on an earlier visit). */
  trusted: boolean;
  /** The receiving address is typed (another kind of chain) or filled in from the wallet (a chain of the same kind). */
  recipient: "typed" | "from-wallet";
  /** What happens around the transfer. */
  story: "refuse-reload-replace" | "fail-then-succeed" | "replaced-then-included" | "plain" | "contract-wallet";
  /** Everything is done from the keyboard. (The "fail-then-succeed" story is walked that way too.) */
  keys?: boolean;
}

const ALL = [1, 56, 8453, 42161];
const SETUPS: Setup[] = [
  // A phone. The wallet starts on the wrong network and is new to the site. One "no" in the wallet, then yes;
  // a reload while the transfer is unconfirmed; then the wallet replaces the transfer.
  { name: "base-eth", width: 360, theme: "dark", startChain: 1, knows: ALL, payChain: 8453, query: "?amount=0.5", coin: "native", symbol: "ETH", trusted: false, recipient: "typed", story: "refuse-reload-replace" },
  // A desktop and a token. The wallet already trusts the site: one press connects it. The transfer fails on-chain, then is sent again.
  { name: "base-usdc", width: 1280, theme: "light", startChain: 8453, knows: ALL, payChain: 8453, query: "?from=base:USDC&to=sol:USDT&amount=25", coin: "token", symbol: "USDC", trusted: true, recipient: "typed", story: "fail-then-succeed" },
  // BNB Chain, on a wallet that has never heard of it: the network is added, with the chain's own public node.
  { name: "bsc-bnb", width: 768, theme: "dark", startChain: 42161, knows: [1, 42161], payChain: 56, query: "?from=bsc:BNB&to=sol:USDT&amount=2", coin: "native", symbol: "BNB", trusted: true, recipient: "typed", story: "plain" },
  // Ethereum itself, and a token, from a wallet that is on Base: it is asked to change network, then for the one transfer.
  { name: "eth-usdt", width: 768, theme: "light", startChain: 8453, knows: ALL, payChain: 1, query: "?from=eth:USDT&to=sol:USDT&amount=40", coin: "token", symbol: "USDT", trusted: true, recipient: "typed", story: "plain" },
  // Arbitrum and a token, to a chain of the same kind: the receiving address is filled in from the wallet.
  { name: "arb-usdc", width: 1280, theme: "dark", startChain: 42161, knows: ALL, payChain: 42161, query: "?from=arb:USDC&to=base:ETH&amount=30", coin: "token", symbol: "USDC", trusted: true, recipient: "from-wallet", story: "replaced-then-included" },
  // A contract wallet (its address holds code) on Arbitrum, and an order paid on Base. Its address may be someone else's,
  // or nobody's, on Base: it is not taken as the refund address, and one has to be entered. No order is made in this one.
  { name: "contract-arb", width: 1280, theme: "dark", startChain: 42161, knows: ALL, payChain: 8453, query: "?amount=0.5", coin: "native", symbol: "ETH", trusted: true, recipient: "typed", story: "contract-wallet" },
  // The whole wallet path again at phone width, by keyboard alone: connect, type, review, tick, confirm, pay.
  // The amount has all eighteen decimals, as Max gives from a real balance: nothing may break onto a second line for it.
  { name: "base-eth-keys", width: 360, theme: "light", startChain: 8453, knows: ALL, payChain: 8453, query: "?amount=0.123456789012345678", coin: "native", symbol: "ETH", trusted: true, recipient: "typed", story: "plain", keys: true },
];

export async function walletWalk(browser: Browser, options: { baseUrl: string; practiceUrl: string; out: string; visit(page: Page, url: string): Promise<void> }): Promise<WalkResult> {
  const complaints: string[] = [];
  let shots = 0;
  const { practiceUrl, out, visit } = options;
  const ownHost = new URL(practiceUrl).host;

  // The policy the server really sends, and the scripts its page names: the measure of everything below.
  const home = await fetch(new URL("/", practiceUrl));
  const policy = home.headers.get("content-security-policy") ?? "";
  const firstLoad = new Set([...(await home.text()).matchAll(/\/assets\/[^"]+\.js/g)].map((match) => match[0]));
  if (!policy.includes("connect-src 'self' https://api.web3modal.org wss://relay.walletconnect.org;") || !policy.includes("frame-src https://verify.walletconnect.org;") || /script-src[^;]*unsafe/.test(policy) || !/script-src 'self' 'sha256-[^;']+';/.test(policy)) {
    complaints.push(`wallet: the server's security policy is not the one this walk measures against: ${policy}`);
  }

  for (const setup of SETUPS) {
    const label = `wallet ${setup.name} ${setup.width} ${setup.theme}`;
    let made = "";
    const network = NETWORKS[setup.payChain]?.name ?? "?";
    const expectThat = (ok: boolean, what: string) => {
      if (!ok) complaints.push(`${label}: ${what}`);
    };
    const mobile = setup.width < 768;
    const context = await browser.newContext({ viewport: { width: setup.width, height: mobile ? 780 : 900 }, deviceScaleFactor: 2, colorScheme: setup.theme, hasTouch: mobile, isMobile: mobile });
    await context.addInitScript(`document.addEventListener("readystatechange", () => { if (document.readyState === "interactive") document.documentElement.dataset.theme = "${setup.theme}"; });`);
    await context.addInitScript(pretendWallet(WALLET, setup.startChain, setup.trusted, setup.knows));
    const chain: ChainState = { receipt: "none", count: NONCE, down: false, code: setup.story === "contract-wallet" };
    await context.route("**/api/rpc/*", pretendChain(chain));
    const page = await context.newPage();
    let requests: string[] = [];
    // Set while the chain route is cut, and for a few seconds after: complaints about the cut may arrive late.
    let quietUntil = 0;
    page.on("request", (request) => requests.push(request.url()));
    page.on("websocket", (socket) => requests.push(socket.url()));
    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      // While the chain route is cut on purpose, the browser's own complaint about that is expected. Nothing else is.
      if (Date.now() < quietUntil && /Failed to load resource|net::ERR_FAILED|Error getting balance/.test(message.text())) return;
      complaints.push(`${label}: ${message.type()}: ${message.text().slice(0, 300)}`);
    });
    page.on("pageerror", (error) => complaints.push(`${label}: page error: ${error.message}`));
    const asks = () => page.evaluate(() => (window as unknown as WalletWindow).__wallet.log);
    const sendsAsked = async () => (await asks()).filter((ask) => ask.method === "eth_sendTransaction").length;
    const shoot = async (name: string) => {
      // A moment for a button that has just changed to finish changing.
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(out, `wallet-${name}-${setup.width}-${setup.theme}.png`), fullPage: false });
      shots += 1;
      // Every accessibility rule, on each screen photographed.
      for (const problem of await axeProblems(page)) complaints.push(`wallet ${setup.name} ${name}: ${problem}`);
    };
    const otherSites = () => [...new Set(requests.map((url) => new URL(url).host).filter((host) => host !== ownHost))];
    // Scripts of this site that the page itself does not name, other than the pages that are fetched when first opened.
    const walletCode = () => requests.filter((url) => new URL(url).host === ownHost && /\/assets\/[^/]+\.js$/.test(new URL(url).pathname) && !firstLoad.has(new URL(url).pathname) && !/\/assets\/(OrderPage|LegalPages|StatesPage|QrCode|Address|WalletPay)-/.test(url));
    // One story is walked by keyboard alone from Connect to the pay button: every control is reached
    // with Tab and worked with Enter or Space. The others use the pointer or a finger.
    const byKeyboard = setup.keys === true || setup.story === "fail-then-succeed";
    const tabTo = async (target: Locator, what: string) => {
      for (let presses = 0; presses <= 80; presses++) {
        if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
        await page.keyboard.press("Tab");
      }
      throw new Error(`the keyboard never reached ${what}`);
    };
    const activate = async (target: Locator, what: string, key: "Enter" | "Space" = "Enter") => {
      if (!byKeyboard) {
        await target.click();
        return;
      }
      await tabTo(target, what);
      await page.keyboard.press(key);
    };
    const connect = async (viaWindow: boolean) => {
      await activate(page.getByRole("button", { name: "Connect", exact: true }), "Connect");
      if (!viaWindow) return null;
      const entry = page.getByText("Test Wallet", { exact: true }).first();
      await entry.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1200);
      return entry;
    };
    const connected = page.getByRole("button", { name: /^0xb559…35eC83\s*, connected wallet\. Disconnect$/ });
    // "Send 0.5 ETH"; or "Send ETH" when the exact amount would not fit on one line of a phone.
    const send = page.getByRole("button", { name: new RegExp(`^Send( [\\d.]+)? ${setup.symbol}$`) });
    const inView = async (name: RegExp | string) => {
      const box = await page.getByRole("button", { name }).first().boundingBox();
      return box !== null && box.y >= 0 && box.y + box.height <= (page.viewportSize()?.height ?? 0);
    };

    try {
      await visit(page, new URL(`/${setup.query}`, practiceUrl).toString());

      // Before Connect: every script fetched is one the page itself names, no other site is touched, the wallet is not asked anything.
      expectThat(walletCode().length === 0, `code beyond the first page load was fetched before Connect was pressed: ${walletCode().join(", ")}`);
      expectThat(otherSites().length === 0, `another site was contacted before Connect was pressed: ${otherSites().join(", ")}`);
      expectThat((await asks()).length === 0, "the wallet was asked something before Connect was pressed");

      // Connect. A wallet new to the site is chosen from the list; one that already trusts it connects on the press alone.
      const entry = await connect(!setup.trusted);
      if (entry !== null) {
        await shoot("window");
        await entry.click();
      }
      await connected.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(800);
      expectThat((await page.locator("w3m-modal.open").count()) === 0, "the wallet window stayed open after connecting");
      // What the eye is given: six…six. (The words that follow it in the button's name are for a screen reader.)
      const shownAddress = (await connected.locator(".mono").innerText()).trim();
      expectThat(shownAddress === "0xb559…35eC83", `the header shows the address as "${shownAddress}"`);
      // With the address in it the header still fits: on a phone the name gives way to the mark, from 480 px it stays.
      const squeezed = await headerFits(page);
      expectThat(squeezed === null, `with a wallet connected, in the header ${squeezed}`);
      expectThat((await page.locator("header .wordmark-text").isVisible()) === setup.width >= 480, `at ${setup.width} px with a wallet connected the site's name is ${setup.width >= 480 ? "hidden" : "shown"}`);
      expectThat(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the header with a connected wallet makes the page scroll sideways");

      // The card, with a wallet.
      const receiving = page.getByLabel(/Receiving address/);
      if (setup.recipient === "from-wallet") {
        // A chain of the same kind, and a plain wallet: the empty field is filled in from it.
        await page.waitForFunction((want) => [...document.querySelectorAll("textarea")].some((el) => el.value === want), WALLET, { timeout: 15_000 }).catch(() => undefined);
        expectThat((await receiving.inputValue()) === WALLET, `the receiving address was not filled in from the wallet (it reads "${await receiving.inputValue()}")`);
        // A refund address typed while paying by hand is never in force unseen. Back in wallet payment the field
        // stays on the card for as long as it holds anything, half-typed or whole, and goes when it is emptied.
        const refundField = page.getByLabel(/Refund address/);
        expectThat((await refundField.count()) === 0, "paying from a wallet on the paying chain, the card asks for a refund address");
        await page.getByRole("button", { name: "Pay without connecting" }).click();
        await refundField.waitFor({ timeout: 5000 });
        await refundField.fill("0x1234");
        await page.getByRole("button", { name: "Pay from a connected wallet" }).click();
        await page.waitForTimeout(300);
        expectThat((await refundField.count()) === 1 && (await refundField.inputValue()) === "0x1234", "a half-typed refund address is still in force after changing to wallet payment, but its field is gone");
        await page.getByRole("button", { name: "Check the refund address" }).waitFor({ timeout: 40_000 }).catch(() => expectThat(false, 'with a half-typed refund address the main button does not say "Check the refund address"'));
        await shoot("card-refund-kept");
        await refundField.fill("");
        await page.waitForTimeout(300);
        expectThat((await refundField.count()) === 0, "the emptied refund field stays on the card in wallet payment");
      } else {
        expectThat((await receiving.inputValue()) === "", "a receiving address on another kind of chain was filled in from the wallet");
        if (byKeyboard) {
          await tabTo(receiving, "the receiving address");
          await page.keyboard.type(freshSol());
        } else await receiving.fill(freshSol());
      }
      await page.locator(".quote-rate").first().waitFor({ timeout: 30_000 });
      if (setup.story === "contract-wallet") {
        // The card asks for a refund address, empty, with no offer of the wallet's own; nothing can be reviewed without one.
        const refund = page.getByLabel(/Refund address/);
        await refund.waitFor({ timeout: 15_000 });
        expectThat((await refund.inputValue()) === "", "the refund address was filled in from a contract wallet that is on another chain");
        expectThat((await page.getByRole("button", { name: /Use connected wallet/ }).count()) === 0, "a contract wallet's address is offered for a chain the wallet is not on");
        const needed = page.getByRole("button", { name: "Enter refund address" });
        await needed.waitFor({ timeout: 40_000 });
        expectThat(await needed.isDisabled(), '"Enter refund address" can be pressed');
        await shoot("card-contract");
        // With one entered, the review shows that address as the refund address, and the wallet's nowhere.
        await refund.fill(OTHER_REFUND);
        await page.getByRole("button", { name: "Review swap" }).click({ timeout: 40_000 });
        const sheet = page.getByRole("dialog");
        await sheet.waitFor();
        await page.waitForTimeout(300);
        const shown = (await sheet.innerText()).replace(/\s/g, "");
        expectThat(shown.includes(OTHER_REFUND) && !shown.includes(WALLET), "the review of an order from a contract wallet on another chain shows the wallet's address");
        await shoot("review-contract");
        await page.keyboard.press("Escape");
        await sheet.waitFor({ state: "detached" });
        expectThat((await sendsAsked()) === 0, "the wallet was asked to send although no order was made");
        // Nothing more in this story: no order is made.
        continue;
      }
      if (setup.startChain === setup.payChain) {
        await page.getByText(/^Balance/).first().waitFor({ timeout: 15_000 });
        expectThat(await page.getByRole("button", { name: "Max" }).isVisible(), "no Max button beside the wallet's balance");
        // More than the wallet holds: the main button says so, and the review cannot be opened.
        const amount = page.locator("#amount-in");
        const before = await amount.inputValue();
        await amount.fill(setup.coin === "token" ? "5000" : "50");
        const short = page.getByRole("button", { name: `Not enough ${setup.symbol}` });
        await short.waitFor({ timeout: 15_000 });
        expectThat(await short.isDisabled(), `"Not enough ${setup.symbol}" can be pressed`);
        await amount.fill(before);
      }
      await page.getByRole("button", { name: "Review swap" }).waitFor({ timeout: 40_000 });
      if (setup.story === "fail-then-succeed" || setup.story === "refuse-reload-replace") {
        // The coin picker shows what the wallet holds, on every chain it can pay from, and puts those coins first after the pinned ones.
        const payChip = page.getByRole("button", { name: /^You pay: .*Change coin$/ });
        if (byKeyboard) {
          await tabTo(payChip, "the coin being paid");
          await page.keyboard.press("Enter");
        } else await payChip.click();
        const picker = page.getByRole("dialog");
        await picker.waitFor();
        const held = (symbol: string, chain: string) => picker.locator(".picker-row", { has: page.locator(".picker-row-main", { hasText: new RegExp(`^${symbol} · ${chain}$`) }) }).locator(".picker-row-balance");
        for (const [symbol, chain, amount] of [
          ["USDC", "Base", "1,000.00"],
          ["USDC", "Arbitrum", "1,000.00"],
          ["ETH", "Ethereum", "5.00"],
          ["BNB", "BNB Chain", "5.00"],
        ] as const) {
          // What the eye is given (a row far down the list is not drawn until it is scrolled to, so the text is read, not the rendering).
          const cell = held(symbol, chain).locator('[aria-hidden="true"]');
          await cell.first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => undefined);
          const shown = (await cell.count()) > 0 ? ((await cell.first().textContent()) ?? "").trim() : "(nothing)";
          expectThat(shown === amount, `the picker shows ${shown} beside ${symbol} on ${chain}, ${amount} expected`);
        }
        // A coin the wallet cannot pay with from here (another kind of chain) has no balance beside it.
        expectThat((await held("SOL", "Solana").count()) === 0, "the picker shows a balance beside a coin on a chain this wallet is not on");
        await shoot("picker-balances");
        await page.keyboard.press("Escape");
        await picker.waitFor({ state: "hidden" });
      }
      await shoot("card");
      await activate(page.getByRole("button", { name: "Review swap" }), '"Review swap"');
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await page.waitForTimeout(300);
      const review = await dialog.innerText();
      expectThat(review.replace(/\s/g, "").includes(WALLET), "the review does not show the wallet's address, in full, as the refund address");
      // Two minutes less than the order's half hour: the time in which to send, as the order's page will count it.
      expectThat(/28 min/.test(review), "the review of a wallet payment does not give 28 minutes to send");
      const change = dialog.getByRole("button", { name: /Change/ });
      expectThat(await change.isVisible(), "the refund address cannot be changed in the review");
      if (setup.story === "refuse-reload-replace") {
        // Changing the refund address: a field appears; left empty, the refund still goes back to the wallet.
        await change.click();
        await dialog.getByLabel(/New refund address/).waitFor({ timeout: 5000 });
        await dialog.getByLabel(/New refund address/).scrollIntoViewIfNeeded();
        // The address in force stays on screen in full the whole time: nothing can be confirmed without it there.
        expectThat((await dialog.innerText()).replace(/\s/g, "").includes(WALLET), "while the refund address is being changed, the address in force is not on screen in full");
        await shoot("review-change");
        // Something half-typed cannot be confirmed, and the wallet's address is still the one shown.
        await dialog.getByLabel(/New refund address/).fill("0x1234");
        expectThat((await dialog.innerText()).replace(/\s/g, "").includes(WALLET), "with a half-typed refund address, the address in force is not on screen");
        expectThat((await dialog.getByRole("button", { name: "Confirm swap" }).count()) === 0 || (await dialog.getByRole("button", { name: "Confirm swap" }).isDisabled()), "a half-typed refund address can be confirmed");
        // "Keep this address" leaves the field and drops what was half-typed.
        await dialog.getByRole("button", { name: "Keep this address" }).click();
        expectThat((await dialog.getByLabel(/New refund address/).count()) === 0, '"Keep this address" did not close the field');
        expectThat((await dialog.innerText()).replace(/\s/g, "").includes(WALLET), 'after "Keep this address" the wallet\'s address is not the refund address shown');
      }
      if (setup.name === "bsc-bnb") {
        // Another refund address, typed in lower case, carried all the way into the order: shown in full in its
        // standard spelling, kept when the field is left, and the one the order is made with.
        await change.click();
        await dialog.getByLabel(/New refund address/).fill(OTHER_REFUND.toLowerCase());
        await page.waitForTimeout(300);
        expectThat((await dialog.innerText()).replace(/\s/g, "").includes(OTHER_REFUND), "a new refund address typed in the review is not shown in full in its standard spelling");
        await dialog.getByRole("button", { name: "Keep this address" }).click();
        expectThat((await dialog.getByLabel(/New refund address/).count()) === 0, '"Keep this address" did not close the field');
        // (Read from the refund address's own block: the review also shows the wallet's address further down, as where this swap's points go.)
        const kept = (await dialog.locator(".review-address", { hasText: "Refund address" }).innerText()).replace(/\s/g, "");
        expectThat(kept.includes(OTHER_REFUND) && !kept.includes(WALLET), "after a new refund address was entered, the review does not show it (or still shows the wallet's)");
      }
      if (byKeyboard) {
        await tabTo(dialog.getByRole("checkbox"), "the Terms tick-box");
        await page.keyboard.press("Space");
      } else await dialog.getByRole("checkbox").check();
      await shoot("review");
      await orderPace();
      await activate(dialog.getByRole("button", { name: "Confirm swap" }), '"Confirm swap"');
      await page.waitForURL(/\/order\/[A-Za-z0-9_-]{20,}$/, { timeout: 30_000 });
      const id = new URL(page.url()).pathname.split("/").pop() ?? "";
      made = id;
      const order = (await (await fetch(new URL(`/api/orders/${id}`, practiceUrl))).json()) as { depositAddress: string; amountIn: string; refundTo: string; pay: string; from: { contract: string | null; symbol: string } };
      const refundWanted = setup.name === "bsc-bnb" ? OTHER_REFUND : WALLET;
      expectThat(order.pay === "wallet" && order.refundTo === refundWanted, `the order made is not a wallet order refunding to ${refundWanted} (${JSON.stringify({ pay: order.pay, refundTo: order.refundTo })})`);
      expectThat((await sendsAsked()) === 0, "the wallet was asked to send before the pay button was pressed");

      // The pay step: on the first screen, with the deposit address in full, before the wallet is opened.
      await page.getByRole("heading", { name: "Pay from your wallet" }).waitFor({ timeout: 15_000 });
      expectThat((await page.locator(".deposit").first().innerText()).replace(/\s/g, "").includes(order.depositAddress), "the deposit address is not shown in full before paying");
      const checkTransfers = async (expected: number) => {
        const log = await asks();
        for (const ask of log) expectThat(ALLOWED_ASKS.has(ask.method), `the wallet was asked for "${ask.method}"`);
        const sends = log.filter((ask) => ask.method === "eth_sendTransaction").map((ask) => (ask.params as { from?: string; to?: string; value?: string; data?: string }[])[0] ?? {});
        expectThat(sends.length === expected, `the wallet was asked to send ${sends.length} time(s), ${expected} expected`);
        for (const tx of sends) {
          const value = BigInt(tx.value ?? "0x0");
          const data = (tx.data ?? "0x").toLowerCase();
          expectThat((tx.from ?? "").toLowerCase() === WALLET.toLowerCase(), `the transfer is from ${tx.from}`);
          expectThat(!data.startsWith(APPROVE), "the wallet was asked for an approval");
          if (setup.coin === "native") {
            expectThat((tx.to ?? "").toLowerCase() === order.depositAddress.toLowerCase(), `the transfer goes to ${tx.to}, not the deposit address`);
            expectThat(value === BigInt(order.amountIn), `the transfer is for ${value}, the order for ${order.amountIn}`);
            expectThat(data === "0x", `a plain payment carried data: ${data.slice(0, 20)}`);
          } else {
            const wanted = `0xa9059cbb${order.depositAddress.slice(2).toLowerCase().padStart(64, "0")}${BigInt(order.amountIn).toString(16).padStart(64, "0")}`;
            expectThat((tx.to ?? "").toLowerCase() === (order.from.contract ?? "").toLowerCase(), `the transfer goes to ${tx.to}, not the coin's contract`);
            expectThat(value === 0n, `a token transfer sent ${value} of the chain's coin along`);
            expectThat(data === wanted, `the transfer's data is not transfer(deposit address, amount): ${data.slice(0, 80)}`);
          }
        }
        // A network is only ever added with the chain's own public node.
        for (const ask of log.filter((item) => item.method === "wallet_addEthereumChain")) {
          const added = (ask.params as { chainId?: string; rpcUrls?: string[] }[])[0] ?? {};
          const wanted = NETWORKS[Number.parseInt(added.chainId ?? "0x0", 16)]?.node;
          expectThat(JSON.stringify(added.rpcUrls) === JSON.stringify([wanted]), `the wallet was told to reach the network through ${JSON.stringify(added.rpcUrls)}`);
        }
      };
      const switchNetwork = async () => {
        const switchButton = page.getByRole("button", { name: `Switch to ${network}` });
        await switchButton.waitFor({ timeout: 15_000 });
        expectThat(await inView(`Switch to ${network}`), "the pay button is not on the first screen");
        await shoot("pay-switch");
        // The site's own chain route is cut for a moment: reading the balance fails, and must fail quietly,
        // asking no one else.
        chain.down = true;
        quietUntil = Date.now() + 60_000;
        await switchButton.click();
        await send.waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1500);
        chain.down = false;
        quietUntil = Date.now() + 5000;
        await page.waitForTimeout(5000);
        expectThat((await asks()).some((ask) => ask.method === (setup.knows.includes(setup.payChain) ? "wallet_switchEthereumChain" : "wallet_addEthereumChain")), "the wallet was not asked to change network");
      };
      if (setup.startChain !== setup.payChain) await switchNetwork();
      await send.waitFor({ timeout: 15_000 });
      expectThat(await inView(new RegExp(`^Send( [\\d.]+)? ${setup.symbol}$`)), "the pay button is not on the first screen");
      // One line, whatever the amount: with all eighteen decimals the button names the coin and leaves the figure to the row above it.
      const payBox = await send.boundingBox();
      expectThat(payBox !== null && payBox.height <= 53, `the pay button is ${Math.round(payBox?.height ?? 0)} px high: its label takes more than one line`);
      if (setup.query.includes("0.123456789012345678")) {
        expectThat(((await send.innerText()).trim()) === `Send ${setup.symbol}`, `with an 18-decimal amount the pay button reads "${(await send.innerText()).trim()}"`);
        expectThat((await page.locator(".deposit").first().innerText()).replace(/\s/g, "").includes("0.123456789012345678"), "the exact amount is not on screen above the pay button");
        expectThat(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "an 18-decimal amount makes the order's page scroll sideways");
      }
      await shoot("pay-ready");

      const press = () => activate(send, "the pay button");
      /** Connects again after a reload (the wallet's notes and its trust in the site began again with it). */
      const reconnect = async () => {
        const entry = await connect(true);
        await entry?.click();
        await connected.waitFor({ timeout: 30_000 });
        // The wallet library may have asked the wallet back to the network it last used here as it connected.
        await page.getByRole("button", { name: `Switch to ${network}` }).or(send).waitFor({ timeout: 15_000 });
        if (await page.getByRole("button", { name: `Switch to ${network}` }).isVisible()) await switchNetwork();
        await send.waitFor({ timeout: 15_000 });
      };
      const noOffer = async (when: string) => {
        expectThat((await page.getByRole("button", { name: /^(Send |Connect wallet$|Switch to (Base|Ethereum|Arbitrum|BNB Chain)$)/ }).count()) === 0, `${when} the page offers to pay`);
        expectThat(walletCode().length === 0 && otherSites().length === 0, `${when} wallet code was fetched or another site reached: ${[...walletCode(), ...otherSites()].join(", ")}`);
        expectThat((await asks()).length === 0, `${when} the wallet was asked something`);
      };

      if (setup.story === "refuse-reload-replace") {
        // The wallet's window is open and waiting: the button says so. Then the person says no.
        await page.evaluate(() => ((window as unknown as WalletWindow).__wallet.mode = "hold"));
        await send.click();
        await page.getByRole("button", { name: /Confirm in wallet/ }).waitFor({ timeout: 15_000 });
        await shoot("pay-asking");
        await page.evaluate(() => (window as unknown as WalletWindow).__wallet.held?.no());
        await page.getByText("You cancelled in your wallet. Nothing was sent.").waitFor({ timeout: 15_000 });
        await shoot("pay-cancelled");
        await send.waitFor({ timeout: 5000 });

        // Asked once more, and this time the page is reloaded while the wallet's window is still open.
        // The page that comes back cannot know what the wallet did: it says so, and does not offer Send.
        await send.click();
        await page.getByRole("button", { name: /Confirm in wallet/ }).waitFor({ timeout: 15_000 });
        await checkTransfers(2);
        requests = [];
        await visit(page, page.url());
        const check = page.getByRole("button", { name: "Check your wallet" });
        await check.waitFor({ timeout: 15_000 });
        expectThat(await check.isDisabled(), "after a reload during the wallet's prompt the main button can be pressed");
        await page.getByText(/This page was reloaded while your wallet was being asked\./).waitFor({ timeout: 5000 });
        await noOffer("after a reload during the wallet's prompt");
        await shoot("pay-unsure");
        // Sending now is the separate, deliberate step, with its warning.
        await page.getByRole("button", { name: "I did not confirm it. Send now" }).click();
        await page.getByText(/Send only if your wallet shows that no transfer for this order is on its way/).waitFor({ timeout: 5000 });
        await reconnect();
      }
      await press();
      await page.getByText("Sent. Waiting for it to be confirmed.").waitFor({ timeout: 15_000 });
      expectThat((await page.getByText("Pay another way").count()) === 0, "paying another way is offered while a transfer is on its way");
      await shoot("pay-sent");
      await checkTransfers(1);

      if (setup.story === "refuse-reload-replace") {
        // More than a minute without a receipt: the page says it is still confirming, and offers a way
        // out for someone whose wallet shows the transfer failed. Not before the minute is up.
        expectThat((await page.getByRole("button", { name: "My wallet shows it failed or was cancelled" }).count()) === 0, "the way out of an unconfirmed transfer is offered in its first minute");
        await page.getByText("Still confirming on Base.").waitFor({ timeout: 80_000 });
        expectThat(await page.getByRole("button", { name: "My wallet shows it failed or was cancelled" }).isVisible(), "after a minute unconfirmed there is no way out for a transfer the wallet shows as failed");
        expectThat(await page.getByRole("button", { name: "Sending…" }).isDisabled(), "after a minute unconfirmed the main button can send again");
        await shoot("pay-still");

        // A reload while the transfer is unconfirmed. The page follows the transfer it sent: no wallet
        // code is fetched, no wallet is asked anything, and "Send" is not offered.
        requests = [];
        await visit(page, page.url());
        const sending = page.getByRole("button", { name: "Sending…" });
        await sending.waitFor({ timeout: 15_000 });
        expectThat(await sending.isDisabled(), "after a reload the pay button can be pressed while a transfer is unconfirmed");
        expectThat((await page.getByText(/Sent\. Waiting for it to be confirmed\.|Still confirming on Base\./).count()) === 1, "after a reload the page does not say a transfer is on its way");
        await noOffer("after a reload with a transfer unconfirmed");
        await shoot("pay-reload");

        // The wallet puts another transaction in its place: the transfer's number is used, and it has no receipt.
        chain.count = NONCE + 1;
        await page.getByText(/Your wallet replaced this transfer\./).waitFor({ timeout: 30_000 });
        expectThat(await page.getByRole("button", { name: "Transfer replaced" }).isDisabled(), "after a replacement the main button can send again");
        await shoot("pay-replaced");
        // Sending again is a separate, deliberate press, and comes with a warning.
        await page.getByRole("button", { name: "I cancelled it. Send again" }).click();
        await page.getByText(/Send only if your wallet shows that no transfer for this order is on its way/).waitFor({ timeout: 5000 });
        await shoot("pay-again");
        await reconnect();
        // And now the first transfer turns out to have been included after all, just as the person
        // presses Send. The page asks about it one last time before opening the wallet, and sends nothing.
        chain.receipt = "success";
        await send.click();
        await page.getByText("Your first transfer was included after all. Nothing more was sent.").waitFor({ timeout: 15_000 });
        expectThat((await page.getByRole("button", { name: /^Send / }).count()) === 0, "Send is still on offer although the first transfer was included");
        await shoot("pay-included");
        // Not one transfer was asked of the wallet in this page's life (its notes began again with the reload).
        await checkTransfers(0);
      }

      if (setup.story === "fail-then-succeed") {
        // The transfer is included and fails. The page says nothing was deposited and offers Send again.
        chain.receipt = "failed";
        await page.getByText(/Your transfer failed on-chain, so nothing was deposited\./).waitFor({ timeout: 20_000 });
        await send.waitFor({ timeout: 5000 });
        expectThat((await page.getByText("Pay another way").count()) === 1, "after a failed transfer, paying another way is not offered");
        await shoot("pay-failed");
        chain.receipt = "none";
        await press();
        await page.getByText("Sent. Waiting for it to be confirmed.").waitFor({ timeout: 15_000 });
        await checkTransfers(2);
      }

      if (setup.story === "replaced-then-included") {
        // The count says the transfer's number is used while its receipt is not there yet: after two
        // looks the page says "replaced". Then the receipt turns up: it was included after all, and
        // the page must take that back rather than leave someone about to pay twice.
        chain.count = NONCE + 1;
        await page.getByText(/Your wallet replaced this transfer\./).waitFor({ timeout: 30_000 });
        chain.receipt = "success";
        await page.getByText(/Your wallet replaced this transfer\./).waitFor({ state: "detached", timeout: 30_000 });
        expectThat((await page.getByRole("button", { name: "I cancelled it. Send again" }).count()) === 0, "a transfer that was included after all still offers to send again");
        expectThat((await page.getByRole("button", { name: /^Send / }).count()) === 0, "a transfer that was included after all leaves Send on offer");
        await checkTransfers(1);
      }

      // The transfer is included. The practice server is told the deposit arrived; the pay step goes away.
      const sentSoFar = await sendsAsked();
      chain.receipt = "success";
      await testControl(page, "Pay in full");
      await page.getByRole("heading", { name: "Pay from your wallet" }).waitFor({ state: "detached", timeout: 30_000 });
      await page.waitForTimeout(1000);
      expectThat((await sendsAsked()) === sentSoFar, "the wallet was asked to send again after the order moved on");
      for (const ask of await asks()) expectThat(ALLOWED_ASKS.has(ask.method), `the wallet was asked for "${ask.method}"`);

      // Disconnect: the header offers Connect again.
      await connected.click();
      await page.getByRole("button", { name: "Connect", exact: true }).waitFor({ timeout: 15_000 });

      // From first to last, only the sites the security policy names, and never the usage-report address.
      const strangers = otherSites().filter((host) => !ALLOWED_HOSTS.has(host));
      expectThat(strangers.length === 0, `the page contacted ${strangers.join(", ")}`);
    } catch (error) {
      complaints.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
      // Kept out of docs/review: a capture of a failed run is for whoever is fixing it, not part of the record.
      await page.screenshot({ path: path.join(out, "..", "..", "data", `stuck-wallet-${setup.name}.png`) }).catch(() => undefined);
    } finally {
      // A walk that stopped half-way must not leave its order unpaid: a few such runs and the server refuses new ones.
      await settle(practiceUrl, made);
      await context.close();
    }
  }
  return { complaints, shots };
}
