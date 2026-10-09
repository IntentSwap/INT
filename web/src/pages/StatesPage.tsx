// Every state of every component on one page, to be looked over and for the screenshot run.
// Nothing here talks to the server: all of it is drawn from the fixed examples below.

import { bech32 } from "@scure/base";
import { ArrowDownUp, Check, Moon, RefreshCw, SlidersHorizontal, Sun, TriangleAlert, Wallet, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { routingOf, type OrderView, type QuoteView, type TokenView } from "../../../shared/api.ts";
import type { RecentOrder } from "../stores/orders.ts";
import { chainName } from "../../../shared/chains.ts";
import { Address } from "../components/Address.tsx";
import { AddressField } from "../components/AddressField.tsx";
import { Amount } from "../components/Amount.tsx";
import { AmountInput, AmountOutput, UsdValue } from "../components/AmountField.tsx";
import { Wordmark } from "../components/Brand.tsx";
import { IconButton, PrimaryButton, SecondaryButton, TextButton } from "../components/Button.tsx";
import { CoinButton } from "../components/CoinButton.tsx";
import { CoinIcon } from "../components/CoinIcon.tsx";
import { QuotePanel } from "../components/QuotePanel.tsx";
import { RecentList } from "../components/RecentList.tsx";
import { Notice } from "../components/Shell.tsx";
import { SOCIAL_MARKS } from "../components/Social.tsx";
import { socialLinks } from "../lib/site-logic.ts";
import { PayPanel } from "../components/WalletPay.tsx";
import { payAction, payMessage, paySecondary, type PayAction, type PayPhase } from "../lib/order-logic.ts";
import { COIN_ICONS } from "../lib/icons.ts";
import { NO_FEE_NO_POINTS, PRIVATE_UNAVAILABLE, primaryAction, reviewAction, reviewSentence, routingNote, type PrivacyMode } from "../lib/swap-logic.ts";
import { DepositDetails, OrderContent } from "./OrderPage.tsx";
import { setTheme, useTheme } from "../theme.ts";
import "../styles/states.css";

const coin = (symbol: string, chain: string, name: string, decimals: number, extra: Partial<TokenView> = {}): TokenView => ({ id: `${chain}:${symbol}`, symbol, name, chain, decimals, price: "1", contract: null, wallet: false, ...extra });
const ETH = coin("ETH", "base", "Ethereum", 18, { price: "2530.26", wallet: true });
const USDT = coin("USDT", "sol", "Tether USD", 6);
const HOOD = coin("USDC", "hood", "USD Coin", 6);
const UNKNOWN = coin("BLACKDRAGON", "near", "Black Dragon", 24);

// Example addresses are made up from fixed text (a hash of a phrase), so they are nobody's.
const SOL_ADDRESS = "DZrFMBPK8J5Jf6KYNDrj4mo2QYAGgQaxsxyyCwQtAWjP";
const EVM_ADDRESS = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
// The longest kind of address the site accepts: a Cardano base address, 103 characters. Made from fixed bytes, so it is nobody's.
const LONG_ADDRESS = bech32.encode("addr", bech32.toWords(Uint8Array.from([0x01, ...Array.from({ length: 56 }, (_, i) => (i * 7 + 3) % 256)])), 200);
const STELLAR_ADDRESS = "GAQMXQJ2UFA5ECB2JJ3GUYQF46ROPVINVWAMN7KNR3OAMDHLQ46LFRBW";

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
  fees: { appBps: 20, providerBps: 20, appAmount: "1000000000000000", providerAmount: "1000000000000000" },
  withdrawFee: "302700",
  refundFee: null,
  priceImpactBps: 36,
  routing: routingOf("public"),
  serverNow: "2026-10-08T12:00:00.000Z",
};
// The same swap with private routing: the same fees, and a little less out.
const PRIVATE_QUOTE: QuoteView = { ...QUOTE, amountOut: "1260079171", minAmountOut: "1247478379", amountOutUsd: "1259.33", routing: routingOf("basic") };
// And where the server is set to take no fee of its own on a private swap.
const NO_FEE_QUOTE: QuoteView = { ...PRIVATE_QUOTE, fees: { ...QUOTE.fees, appBps: 0, appAmount: "0" } };

// A fixed moment, so the page looks the same every time it is photographed.
const NOW = Date.parse("2026-10-08T12:10:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const HASH = `0x${"3f".repeat(32)}`;

function order(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: "Ex4mpleOrderIdForTheStates0",
    status: "waiting",
    createdAt: at(-10),
    updatedAt: at(-1),
    statusSince: at(-1),
    pay: "manual",
    from: { id: ETH.id, symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, contract: null },
    to: { id: USDT.id, symbol: "USDT", name: "Tether USD", chain: "sol", decimals: 6, contract: "x" },
    amountIn: QUOTE.amountIn,
    amountOut: QUOTE.amountOut,
    minAmountOut: QUOTE.minAmountOut,
    amountInUsd: QUOTE.amountInUsd,
    amountOutUsd: QUOTE.amountOutUsd,
    slippageBps: 100,
    timeEstimate: 34,
    fees: QUOTE.fees,
    withdrawFee: QUOTE.withdrawFee,
    refundFee: null,
    recipient: SOL_ADDRESS,
    refundTo: EVM_ADDRESS,
    rewardsAddress: null,
    routing: routingOf("public"),
    depositAddress: "0xae001C67DbdC649e76BD8f41A75D1D154423D8aD",
    depositMemo: null,
    depositsOpen: true,
    deadline: at(50),
    depositTxHash: null,
    depositProven: false,
    depositTxUrl: null,
    details: null,
    serverNow: new Date(NOW).toISOString(),
    ...overrides,
  };
}
const details = (extra: Partial<NonNullable<OrderView["details"]>>): NonNullable<OrderView["details"]> => ({ originTxs: [], destinationTxs: [], depositedAmount: null, amountIn: null, amountOut: null, refundedAmount: null, refundReason: null, ...extra });
const DEPOSIT_TX = { hash: HASH, url: `https://basescan.org/tx/${HASH}` };

/** The coins the picker shows first, each on a chain it lives on, then every other coin that has artwork. */
const ICON_SAMPLES: [string, string][] = [
  ["BNB", "bsc"],
  ["USDT", "bsc"],
  ["USDC", "base"],
  ["ETH", "eth"],
  ["ETH", "base"],
  ["ETH", "arb"],
  ["BTC", "btc"],
  ["SOL", "sol"],
  ["USDT", "sol"],
  ["ZEC", "zec"],
  ["NEAR", "near"],
  ["USDT", "tron"],
  ...[...COIN_ICONS]
    .sort()
    .filter((symbol) => !["bnb", "usdt", "usdc", "eth", "btc", "sol", "zec"].includes(symbol))
    .map((symbol): [string, string] => [symbol.toUpperCase(), "eth"]),
];

const RECENT: RecentOrder[] = [
  // An amount with all eighteen decimals: its row names the coins alone (an amount to pay is never shortened).
  { id: "Ex4mpleOrderIdForTheStates3", createdAt: at(-2), from: { symbol: "ETH", chain: "base", decimals: 18 }, to: { symbol: "USDT", chain: "sol", decimals: 6 }, amountIn: "123456789012345678", amountOut: "311204118" },
  { id: "Ex4mpleOrderIdForTheStates2", createdAt: at(-4), from: { symbol: "USDC", chain: "base", decimals: 6 }, to: { symbol: "ETH", chain: "arb", decimals: 18 }, amountIn: "250000000", amountOut: "98000000000000000" },
  { id: "Ex4mpleOrderIdForTheStates1", createdAt: at(-90), from: { symbol: "ETH", chain: "base", decimals: 18 }, to: { symbol: "USDT", chain: "sol", decimals: 6 }, amountIn: "500000000000000000", amountOut: "1261340512" },
  { id: "Ex4mpleOrderIdForTheStates0", createdAt: at(-3000), from: { symbol: "BTC", chain: "btc", decimals: 8 }, to: { symbol: "USDC", chain: "base", decimals: 6 }, amountIn: "1250000", amountOut: "1342100000" },
];

const WALLET_ORDER = order({ pay: "wallet", deadline: at(28) });
const payBase = { connected: true, walletChain: "base", order: WALLET_ORDER, balance: 10n ** 18n, left: 28 * 60_000 } as const;
const said = (phase: PayPhase, pendingMs = 0) => payMessage(phase, "Base", pendingMs);

/** Every state of the pay step on an order paid from a connected wallet. */
const PAY_STATES: { label: string; action: PayAction; text: string | null; tone: "plain" | "attention"; link: string | null; secondary?: string | null }[] = [
  { label: "no wallet connected (after a reload)", action: payAction({ ...payBase, phase: "idle", connected: false, walletChain: null }), text: null, tone: "plain", link: null },
  { label: "the wallet is on another network", action: payAction({ ...payBase, phase: "idle", walletChain: "eth" }), text: null, tone: "plain", link: null },
  { label: "the network could not be changed", action: payAction({ ...payBase, phase: "idle", walletChain: "eth" }), text: "Your wallet could not change network. Choose Base in your wallet, then try again.", tone: "attention", link: null },
  { label: "not enough of the coin", action: payAction({ ...payBase, phase: "idle", balance: 10n ** 17n }), text: null, tone: "plain", link: null },
  { label: "ready to send", action: payAction({ ...payBase, phase: "idle" }), text: null, tone: "plain", link: null },
  { label: "waiting for a yes in the wallet", action: payAction({ ...payBase, phase: "asking" }), text: null, tone: "plain", link: null },
  { label: "cancelled in the wallet", action: payAction({ ...payBase, phase: "rejected" }), text: said("rejected")?.text ?? null, tone: "plain", link: null },
  { label: "sent, not yet confirmed", action: payAction({ ...payBase, phase: "sent" }), text: said("sent")?.text ?? null, tone: "plain", link: DEPOSIT_TX.url, secondary: paySecondary("sent", 0) },
  { label: "sent more than a minute ago (also what a reload shows)", action: payAction({ ...payBase, phase: "sent" }), text: said("sent", 90_000)?.text ?? null, tone: "plain", link: DEPOSIT_TX.url, secondary: paySecondary("sent", 90_000) },
  { label: "the transfer failed on-chain", action: payAction({ ...payBase, phase: "failed" }), text: said("failed")?.text ?? null, tone: "attention", link: null },
  { label: "the wallet replaced the transfer (sped up or cancelled)", action: payAction({ ...payBase, phase: "replaced" }), text: said("replaced")?.text ?? null, tone: "attention", link: DEPOSIT_TX.url, secondary: paySecondary("replaced", 0) },
  { label: "sending a second time, after saying the first failed or was cancelled", action: payAction({ ...payBase, phase: "again" }), text: said("again")?.text ?? null, tone: "attention", link: null },
  { label: "the wallet refused the transfer", action: payAction({ ...payBase, phase: "idle" }), text: "Your wallet could not send the transfer. Nothing was sent. Check the network and your balance, then try again.", tone: "attention", link: null },
  { label: "too close to the deadline", action: payAction({ ...payBase, phase: "idle", left: 4 * 60_000 }), text: null, tone: "plain", link: null },
];


const ORDERS: Array<{ label: string; order: OrderView; reconnecting?: boolean; privacyMode?: PrivacyMode }> = [
  { label: "Waiting for the deposit", order: order() },
  { label: "Made with private routing: the tag beside the title, and a row in the details (open them)", order: order({ amountOut: PRIVATE_QUOTE.amountOut, minAmountOut: PRIVATE_QUOTE.minAmountOut, fees: PRIVATE_QUOTE.fees, routing: routingOf("basic") }), privacyMode: "basic" },
  { label: "A public order where the server routes privately: its details say so (open them)", order: order(), privacyMode: "basic" },
  { label: "Waiting, a deposit that needs a memo", order: order({ from: { id: "stellar:XLM", symbol: "XLM", name: "Stellar", chain: "stellar", decimals: 7, contract: null }, amountIn: "25000000000", depositAddress: STELLAR_ADDRESS, depositMemo: "184467440737", refundTo: STELLAR_ADDRESS }) },
  { label: "Waiting, deposits closed (2 minutes before the deadline)", order: order({ depositsOpen: false, depositAddress: null, deadline: at(1) }) },
  { label: "Deposit seen", order: order({ status: "deposit_seen", depositProven: true, depositAddress: null, depositsOpen: false, depositTxHash: HASH, depositTxUrl: DEPOSIT_TX.url }) },
  { label: "Swapping", order: order({ status: "swapping", depositProven: true, depositAddress: null, depositsOpen: false, details: details({ originTxs: [DEPOSIT_TX] }) }) },
  { label: "Swapping, past twice its estimate", order: order({ status: "swapping", statusSince: at(-9), depositProven: true, depositAddress: null, depositsOpen: false, details: details({ originTxs: [DEPOSIT_TX] }) }) },
  { label: "Delivered", order: order({ status: "delivered", depositProven: true, depositAddress: null, depositsOpen: false, details: details({ originTxs: [DEPOSIT_TX], destinationTxs: [{ hash: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW", url: null }], amountOut: "1261900000" }) }) },
  { label: "Refunded", order: order({ status: "refunded", depositProven: true, depositAddress: null, depositsOpen: false, details: details({ originTxs: [DEPOSIT_TX], refundedAmount: "499000000000000000", refundReason: "SLIPPAGE_EXCEEDED" }) }) },
  { label: "Deposit too small", order: order({ status: "deposit_too_small", depositProven: true, depositAddress: null, depositsOpen: false, details: details({ originTxs: [DEPOSIT_TX], depositedAmount: "250000000000000000" }) }) },
  { label: "Failed", order: order({ status: "failed", depositProven: true, depositAddress: null, depositsOpen: false, depositTxHash: HASH }) },
  { label: "Expired", order: order({ status: "expired", depositAddress: null, depositsOpen: false, deadline: at(-20) }) },
  { label: "Connection lost: the last known state stays", order: order({ status: "swapping", depositProven: true, depositAddress: null, depositsOpen: false }), reconnecting: true },
];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="states-group">
      <h2 className="states-title">{title}</h2>
      {children}
    </section>
  );
}

function Case({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="states-case" data-wide={wide || undefined}>
      <p className="states-label muted">{label}</p>
      {children}
    </div>
  );
}

const never = () => undefined;

/** The card's two tools, as they stand at the right end of the row above its fields. */
const CARD_TOOLS = (
  <>
    <button type="button" className="tool" aria-label="1.00% slippage limit. Change" title="Slippage limit">
      <SlidersHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
    </button>
    <button type="button" className="tool" aria-label="Refresh the quote" title="Refresh the quote">
      <RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />
    </button>
  </>
);

/** The card's button when a private quote could not be had, worked out by the card's own rule. */
const NOT_AVAILABLE = primaryAction({
  paused: false,
  coinsReady: true,
  from: ETH,
  to: USDT,
  amountText: "0.5",
  pay: "manual",
  walletConnected: false,
  balance: null,
  recipient: SOL_ADDRESS,
  refundTo: EVM_ADDRESS,
  quote: "none",
  problem: { code: "private_unavailable", message: PRIVATE_UNAVAILABLE, detail: {} },
  impactUnconfirmed: false,
});

export default function StatesPage() {
  const theme = useTheme();
  const [typed, setTyped] = useState("0.5");
  const [address, setAddress] = useState("");
  const [impact, setImpact] = useState(false);
  const [ticked, setTicked] = useState(false);

  return (
    <main className="main states" id="main">
      <header className="states-head">
        <Wordmark />
        <h1 className="states-heading">Component states</h1>
        <SecondaryButton onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "Light theme" : "Dark theme"}</SecondaryButton>
      </header>

      <Group title="Buttons">
        <Case label="Primary">
          <PrimaryButton>Review swap</PrimaryButton>
        </Case>
        <Case label="Primary, cannot act: the label says why">
          <PrimaryButton disabled>Enter an amount</PrimaryButton>
        </Case>
        <Case label="Primary, working">
          <PrimaryButton disabled busy>
            Getting a quote…
          </PrimaryButton>
        </Case>
        <Case label="Secondary">
          <SecondaryButton>
            <Wallet size={16} strokeWidth={1.5} aria-hidden="true" />
            Connect
          </SecondaryButton>
        </Case>
        <Case label="Secondary, disabled">
          <SecondaryButton disabled>Connecting…</SecondaryButton>
        </Case>
        <Case label="Chips: default, chosen, with an icon">
          <div className="states-row">
            <button type="button" className="button-chip" aria-pressed="false">
              Ethereum
            </button>
            <button type="button" className="button-chip" aria-pressed="true">
              All
            </button>
            <button type="button" className="button-chip">
              <Wallet size={16} strokeWidth={1.5} aria-hidden="true" />
              Wallet
            </button>
          </div>
        </Case>
        <Case label="Text button and link">
          <div className="states-row">
            <TextButton>Pay without connecting</TextButton>
            <a href="/terms">Terms of Use</a>
          </div>
        </Case>
        <Case label="Chips and a text button that cannot be pressed">
          <div className="states-row">
            <button type="button" className="button-chip" disabled>
              Ethereum
            </button>
            <button type="button" className="button-chip" disabled>
              <Wallet size={16} strokeWidth={1.5} aria-hidden="true" />
              Wallet
            </button>
            <TextButton disabled>Change</TextButton>
          </div>
        </Case>
        <Case label="Icon buttons">
          <div className="states-row">
            <IconButton label="Close">
              <X size={20} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
            <IconButton label="Switch theme">{theme === "dark" ? <Sun size={20} strokeWidth={1.5} aria-hidden="true" /> : <Moon size={20} strokeWidth={1.5} aria-hidden="true" />}</IconButton>
            <button type="button" className="flip states-flip" aria-label="Swap the two coins">
              <ArrowDownUp size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button type="button" className="flip states-flip" aria-label="Swap the two coins" disabled>
              <ArrowDownUp size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        </Case>
        <Case label="The card's tools: the slippage limit, a fresh quote, and one that cannot be pressed">
          <div className="states-row">
            <button type="button" className="tool" aria-label="1.00% slippage limit. Change" title="Slippage limit">
              <SlidersHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button type="button" className="tool" aria-label="Refresh the quote" title="Refresh the quote">
              <RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button type="button" className="tool" aria-label="Refresh the quote" title="Refresh the quote" disabled>
              <RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        </Case>
        <Case label="Tick-box: empty and ticked">
          <label className="check">
            <input type="checkbox" checked={ticked} onChange={(event) => setTicked(event.target.checked)} />
            <span>I have read and accept the Terms of Use.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked readOnly />
            <span>I understand and want to continue</span>
          </label>
        </Case>
        <Case label="Tick-box that cannot be changed: empty and ticked">
          <label className="check">
            <input type="checkbox" disabled />
            <span>I have read and accept the Terms of Use.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked disabled readOnly />
            <span>I have read and accept the Terms of Use.</span>
          </label>
        </Case>
      </Group>

      <Group title="Amounts">
        <Case label="Amount field: typing (try the three test amounts)">
          <div className="field">
            <div className="field-head">
              <span className="field-label">You pay</span>
              <span className="balance">
                <span>
                  Balance: <Amount raw="1234567890000000000" decimals={18} /> ETH
                </span>
                <button type="button" className="balance-max">
                  Max
                </button>
              </span>
            </div>
            <div className="field-row">
              <CoinButton token={ETH} label="You pay" onClick={never} />
              <div className="field-value">
                <AmountInput id="states-amount" value={typed} decimals={18} autoFocus={false} onChange={setTyped} />
                <UsdValue value="1265.13" />
              </div>
            </div>
          </div>
        </Case>
        {(["0.00000001", "123456789.123456", "1000000000"] as const).map((value) => (
          <Case key={value} label={`Amount field: ${value}`}>
            <div className="field">
              <div className="field-head">
                <span className="field-label">You pay</span>
              </div>
              <div className="field-row">
                <CoinButton token={ETH} label="You pay" onClick={never} />
                <div className="field-value">
                  <AmountInput id={`states-${value}`} value={value} decimals={18} autoFocus={false} onChange={never} />
                  <UsdValue value={null} />
                </div>
              </div>
            </div>
          </Case>
        ))}
        <Case label="Empty">
          <div className="field">
            <div className="field-head">
              <span className="field-label">You pay</span>
            </div>
            <div className="field-row">
              <CoinButton token={null} label="You pay" onClick={never} />
              <div className="field-value">
                <AmountInput id="states-empty" value="" decimals={18} autoFocus={false} onChange={never} />
                <UsdValue value={null} />
              </div>
            </div>
          </div>
        </Case>
        <Case label="Amount received: first load, ready, refreshing">
          <div className="field">
            <div className="field-head">
              <span className="field-label">You receive</span>
            </div>
            <div className="field-row">
              <CoinButton token={USDT} label="You receive" onClick={never} />
              <div className="field-value">
                <AmountOutput id="states-out-loading" raw={null} decimals={6} symbol="USDT" stale={false} loading />
                <UsdValue value={null} />
              </div>
            </div>
          </div>
          <div className="field">
            <div className="field-head">
              <span className="field-label">You receive</span>
            </div>
            <div className="field-row">
              <CoinButton token={USDT} label="You receive" onClick={never} />
              <div className="field-value">
                <AmountOutput id="states-out-ready" raw="1261340512" decimals={6} symbol="USDT" stale={false} loading={false} />
                <UsdValue value="1260.59" />
              </div>
            </div>
          </div>
          <div className="field">
            <div className="field-head">
              <span className="field-label">You receive</span>
            </div>
            <div className="field-row">
              <CoinButton token={HOOD} label="You receive" onClick={never} />
              <div className="field-value">
                <AmountOutput id="states-out-stale" raw="1261340512" decimals={6} symbol="USDC" stale loading />
                <UsdValue value="1260.59" />
              </div>
            </div>
          </div>
        </Case>
        <Case label="Small amounts and the exact value">
          <p>
            <Amount raw="1234" decimals={9} symbol="SOL" /> · <Amount raw="12345678" decimals={18} symbol="ETH" /> · <Amount raw="371200000" decimals={6} symbol="USDT" /> · <Amount raw="1234567891" decimals={6} symbol="USDT" />
          </p>
        </Case>
      </Group>

      <Group title="Coins">
        <Case label="Coin buttons: wallet coin, long chain name, no icon, loading">
          <div className="states-row">
            <CoinButton token={ETH} label="You pay" onClick={never} />
            <CoinButton token={HOOD} label="You pay" onClick={never} />
            <CoinButton token={UNKNOWN} label="You pay" onClick={never} />
            <CoinButton token={null} label="You pay" onClick={never} />
          </div>
        </Case>
        <Case label="Every coin icon on the list, with its chain badge, at 32 px" wide>
          <ul className="states-icons">
            {ICON_SAMPLES.map(([symbol, chain]) => (
              <li key={`${symbol}-${chain}`}>
                <CoinIcon symbol={symbol} chain={chain} />
                <span className="muted">
                  {symbol} · {chainName(chain)}
                </span>
              </li>
            ))}
          </ul>
        </Case>
        <Case label="The same at 24 px, and a coin with no artwork" wide>
          <ul className="states-icons">
            {ICON_SAMPLES.slice(0, 12).map(([symbol, chain]) => (
              <li key={`${symbol}-${chain}`}>
                <CoinIcon symbol={symbol} chain={chain} size={24} />
                <span className="muted">{symbol}</span>
              </li>
            ))}
            <li>
              <CoinIcon symbol="BLACKDRAGON" chain="near" />
              <span className="muted">No artwork, 32</span>
            </li>
            <li>
              <CoinIcon symbol="BLACKDRAGON" chain="near" size={24} />
              <span className="muted">No artwork, 24</span>
            </li>
          </ul>
        </Case>
        <Case label="Picker rows: plain, under the arrow keys, chosen, on the other side, loading">
          <ul className="picker-list states-list">
            {[
              { token: ETH, active: false, mark: null },
              { token: USDT, active: true, mark: null },
              { token: HOOD, active: false, mark: "chosen" },
              { token: UNKNOWN, active: false, mark: "You receive" },
            ].map(({ token, active, mark }) => (
              <li key={token.id} className="picker-row" data-active={active || undefined}>
                <CoinIcon symbol={token.symbol} chain={token.chain} />
                <span className="picker-row-text">
                  <span className="picker-row-main">
                    <span className="picker-row-symbol">{token.symbol}</span>
                    <span className="muted"> · {chainName(token.chain)}</span>
                  </span>
                  <span className="picker-row-name faint">{token.name}</span>
                </span>
                {mark === "chosen" ? (
                  <span className="picker-row-mark">
                    <Check size={16} strokeWidth={1.5} aria-hidden="true" />
                  </span>
                ) : mark !== null ? (
                  <span className="picker-row-mark muted">{mark}</span>
                ) : null}
              </li>
            ))}
            <li className="picker-row">
              <span className="skeleton skeleton-icon" />
              <span className="picker-row-text">
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-line skeleton-line-short" />
              </span>
            </li>
          </ul>
        </Case>
        <Case label="Picker: nothing found, and a contract that is not listed">
          <div className="picker-empty">
            <p className="picker-empty-title">No coins match.</p>
            <p className="muted">Check the spelling, or choose "All" to search every chain.</p>
          </div>
          <div className="picker-empty">
            <p className="picker-empty-title">This coin is not supported.</p>
            <p className="muted">That contract is not on the list of coins that can be swapped here. Search by symbol to see what is.</p>
          </div>
        </Case>
      </Group>

      <Group title="Addresses">
        <Case label="Empty, with its hint">
          <AddressField label="Receiving address" hint="Your USDT is sent here. Use a wallet you control." chain="sol" value={address} onChange={setAddress} walletAddress={null} />
        </Case>
        <Case label="Valid">
          <AddressField label="Receiving address" hint="Your USDT is sent here. Use a wallet you control." chain="sol" value={SOL_ADDRESS} onChange={never} walletAddress={null} />
        </Case>
        <Case label="For another chain">
          <AddressField label="Receiving address" hint="Your USDT is sent here. Use a wallet you control." chain="sol" value={EVM_ADDRESS} onChange={never} walletAddress={null} />
        </Case>
        <Case label="A contract where a wallet is expected">
          <AddressField label="Refund address" hint="If the swap fails, your ETH comes back here." chain="base" value={EVM_ADDRESS} onChange={never} walletAddress={null} contractCheck={async () => true} />
        </Case>
        <Case label="A chain where exchanges ask for a memo">
          <AddressField label="Receiving address" chain="stellar" value={STELLAR_ADDRESS} onChange={never} walletAddress={null} memoNote />
        </Case>
        <Case label="With a connected wallet to use">
          <AddressField label="Receiving address" hint="Your ETH is sent here. Use a wallet you control." chain="arb" value="" onChange={never} walletAddress={EVM_ADDRESS} />
        </Case>
        <Case label="The longest address, 103 characters">
          <AddressField label="Receiving address" hint="Your ADA is sent here. Use a wallet you control." chain="cardano" value={LONG_ADDRESS} onChange={never} walletAddress={null} />
        </Case>
        <Case label="Shown in full, ends emphasised">
          <p className="review-address-value">
            <Address value={SOL_ADDRESS} />
          </p>
          <p className="review-address-value">
            <Address value={LONG_ADDRESS} />
          </p>
        </Case>
      </Group>

      <Group title="Quote">
        <Case label="No amount yet: nothing is shown" wide>
          <QuotePanel quote={null} from={ETH} to={USDT} loading={false} stale={false} impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="First load" wide>
          <QuotePanel quote={null} from={ETH} to={USDT} loading stale={false} held impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="Ready: one line (press it to see the fees)" wide>
          <QuotePanel quote={QUOTE} from={ETH} to={USDT} loading={false} stale={false} held impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="Ready, opened: the fees" wide>
          <QuotePanel quote={QUOTE} from={ETH} to={USDT} loading={false} stale={false} held startOpen impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="Sending it yourself: nothing is said of points until an address for them is given" wide>
          <QuotePanel quote={QUOTE} from={ETH} to={USDT} loading={false} stale={false} held pointsShown={false} impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="A swap between two dollar coins: a tenth of the points" wide>
          <QuotePanel quote={{ ...QUOTE, amountIn: "1265130000", amountInUsd: "1265.13", fees: { ...QUOTE.fees, appAmount: "2530260", providerAmount: "2530260" } }} from={HOOD} to={USDT} loading={false} stale={false} held impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="Refreshing: old numbers dimmed" wide>
          <QuotePanel quote={QUOTE} from={ETH} to={USDT} loading stale held startOpen impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="A slow swap" wide>
          <QuotePanel quote={{ ...QUOTE, timeEstimate: 812 }} from={ETH} to={USDT} loading={false} stale={false} held startOpen impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="A very slow swap: the time still fits its line" wide>
          <QuotePanel quote={{ ...QUOTE, timeEstimate: 6840 }} from={ETH} to={USDT} loading={false} stale={false} held startOpen impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="Price impact above 3%" wide>
          <QuotePanel quote={{ ...QUOTE, priceImpactBps: 420 }} from={ETH} to={USDT} loading={false} stale={false} impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="Price impact above 10%: needs a tick" wide>
          <QuotePanel quote={{ ...QUOTE, priceImpactBps: 1350 }} from={ETH} to={USDT} loading={false} stale={false} impactConfirmed={impact} onConfirmImpact={setImpact} />
        </Case>
        <Case label="A long chain name and no network fee stated" wide>
          <QuotePanel quote={{ ...QUOTE, withdrawFee: null }} from={ETH} to={HOOD} loading={false} stale={false} held startOpen impactConfirmed={false} onConfirmImpact={never} />
        </Case>
      </Group>

      <Group title="Review">
        <Case label="The review sheet's button, in each state">
          {(
            [
              { phase: "review", quote: "ready", termsAccepted: false },
              { phase: "review", quote: "ready", termsAccepted: true },
              { phase: "creating", quote: "ready", termsAccepted: true },
              { phase: "moved", quote: "ready", termsAccepted: true },
              { phase: "review", quote: "ready", termsAccepted: true, settling: true },
              { phase: "review", quote: "ready", termsAccepted: true, impactUnconfirmed: true },
              { phase: "review", quote: "expired", termsAccepted: true },
              { phase: "review", quote: "loading", termsAccepted: true },
              { phase: "mismatch", quote: "ready", termsAccepted: true },
              { phase: "unavailable", quote: "ready", termsAccepted: true },
            ] as const
          ).map((input, index) => {
            const action = reviewAction(input);
            return (
              <PrimaryButton key={index} disabled={action.disabled} busy={action.busy}>
                {action.label}
              </PrimaryButton>
            );
          })}
        </Case>
        <Case label="What the line above the button can say">
          <p className="review-problem" data-kind="plain">
            This quote has expired. Refresh it to see the numbers as they are now.
          </p>
          <p className="review-problem" data-kind="error">
            The order that came back does not match what you reviewed (the receiving address). Nothing was sent, and nothing should be sent to it.
          </p>
          <p className="review-problem" data-kind="error">
            This swap can't be processed.
          </p>
          <p className="review-problem" data-kind="error">
            {PRIVATE_UNAVAILABLE} No order was made.
          </p>
          <p className="notice notice-warning" role="note">
            <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>The price moved. No order was made. Check the new numbers and confirm again.</span>
          </p>
        </Case>
        <Case label="The card when a quote could not be had">
          <p className="card-message">No route for this pair right now.</p>
          <PrimaryButton>Try again</PrimaryButton>
          <p className="card-message">The quote is taking too long. Try again.</p>
          <PrimaryButton>Try again</PrimaryButton>
        </Case>
      </Group>

      <Group title="Private routing">
        <Case label="The tag">
          <div className="states-row">
            <span className="chip routing-tag" data-tone="private">
              Private
            </span>
          </div>
        </Case>
        <Case label="The card's row above the fields: private routing in force">
          <div className="card-tools">
            <span className="chip routing-tag card-routing" data-tone="private">
              Private
            </span>
            {CARD_TOOLS}
          </div>
        </Case>
        <Case label="The same row after choosing public routing for this swap: the way back">
          <div className="card-tools">
            <button type="button" className="routing-switch card-routing">
              Use private routing
            </button>
            {CARD_TOOLS}
          </div>
        </Case>
        <Case label="The same row where the server routes in public: its left end is empty">
          <div className="card-tools">{CARD_TOOLS}</div>
        </Case>
        <Case label="A private quote, opened: the routing, the two fees and the points" wide>
          <QuotePanel quote={PRIVATE_QUOTE} from={ETH} to={USDT} loading={false} stale={false} held startOpen routing={routingNote("basic", PRIVATE_QUOTE)} impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="A private quote: one line, with its points" wide>
          <QuotePanel quote={PRIVATE_QUOTE} from={ETH} to={USDT} loading={false} stale={false} held routing={routingNote("basic", PRIVATE_QUOTE)} impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="A private quote where IntentSwap is set to take no fee, opened: the fee row says so, and nothing is said of points" wide>
          <QuotePanel quote={NO_FEE_QUOTE} from={ETH} to={USDT} loading={false} stale={false} held startOpen routing={routingNote("basic", NO_FEE_QUOTE)} impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="A public quote by the person's own choice, opened" wide>
          <QuotePanel quote={QUOTE} from={ETH} to={USDT} loading={false} stale={false} held startOpen routing={routingNote("basic", QUOTE, true)} impactConfirmed={false} onConfirmImpact={never} />
        </Case>
        <Case label="Private routing could not be had: the card's message and its button">
          <p className="card-message" role="status">
            {PRIVATE_UNAVAILABLE}
          </p>
          <PrimaryButton>{NOT_AVAILABLE.label}</PrimaryButton>
        </Case>
        <Case label="The review's first words for a private swap">
          <p className="review-sentence">{reviewSentence(ETH, USDT, BigInt(PRIVATE_QUOTE.amountIn), BigInt(PRIVATE_QUOTE.amountOut), { privately: true })}</p>
        </Case>
        <Case label="The review's routing row: private, and public by choice">
          {[routingNote("basic", PRIVATE_QUOTE), routingNote("basic", QUOTE, true)].map((note) =>
            note === null ? null : (
              <dl key={note.text} className="review-rows">
                <div className="review-row" data-row="routing">
                  <dt className="muted">Routing</dt>
                  <dd>
                    {note.private ? (
                      <span className="chip routing-tag" data-tone="private">
                        {note.text}
                      </span>
                    ) : (
                      note.text
                    )}
                  </dd>
                </div>
              </dl>
            ),
          )}
        </Case>
        <Case label="The review's words on points for a swap IntentSwap takes no fee on">
          <div className="review-address">
            <p className="review-address-label">Points</p>
            <p className="review-address-note muted">{NO_FEE_NO_POINTS}</p>
          </div>
        </Case>
      </Group>

      <Group title="Whole-page messages">
        {(
          [
            ["Couldn't load coins.", "The list of coins didn't arrive. Check your connection and try again.", "Try again"],
            ["Can't reach the service.", "Check your connection, then try again.", "Try again"],
            ["Swaps are paused.", "New swaps can't be started right now. Orders already made are still tracked, and refunds still reach their refund address.", "Check again"],
            ["Not available in your region.", "IntentSwap can't be used from where you are.", null],
            ["Page not found.", "There is nothing at this address.", "Go to the swap page"],
            ["Order not found.", "This link doesn't match an order. An order that was never paid is removed a day after its deadline.", "Go to the swap page"],
          ] as const
        ).map(([title, body, action]) => (
          <Case key={title} label={title}>
            <Notice title={title} action={action !== null ? <SecondaryButton>{action}</SecondaryButton> : undefined}>
              <p>{body}</p>
            </Notice>
          </Case>
        ))}
      </Group>

      <Group title="Orders">
        {ORDERS.map(({ label, order: example, reconnecting, privacyMode }) => (
          <Case key={label} label={label} wide>
            <OrderContent order={example} now={NOW} reconnecting={reconnecting ?? false} contact="help@example.org" onOrder={never} privacyMode={privacyMode ?? null} />
          </Case>
        ))}
      </Group>

      <Group title="Recent orders">
        <Case label="Orders made in this browser, newest first" wide>
          <RecentList orders={RECENT} onOpen={never} onClear={never} />
        </Case>
        <Case label="None yet" wide>
          <RecentList orders={[]} onOpen={never} onClear={never} />
        </Case>
      </Group>

      <Group title="Paying an order">
        <Case label="Sending it yourself: the box ticked, address and QR code on show" wide>
          <DepositDetails order={order()} now={NOW} ticked />
        </Case>
        <Case label="Sending it yourself, with a memo" wide>
          <DepositDetails order={ORDERS[1]!.order} now={NOW} ticked />
        </Case>
        {PAY_STATES.map(({ label, action, text, tone, link, secondary }) => (
          <Case key={label} label={`From a wallet: ${label}`} wide>
            <PayPanel order={WALLET_ORDER} now={NOW} action={action} text={text} tone={tone} link={link} onAct={never} secondary={secondary ? { label: secondary, onPress: never } : null}>
              {null}
            </PayPanel>
          </Case>
        ))}
      </Group>

      <Group title="Messages">
        <Case label="Warning and danger notices">
          <p className="notice notice-warning" role="note">
            <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>The price moved. No order was made. Check the new numbers and confirm again.</span>
          </p>
          <div className="notice notice-danger" role="note">
            <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
            <div>
              <p>Price impact is 13.50%. You would lose a large part of the value of what you pay.</p>
            </div>
          </div>
        </Case>
        <Case label="Banners">
          <div className="banner states-banner">
            <p>Swaps are paused. Existing orders are still tracked.</p>
          </div>
          <div className="banner states-banner">
            <p>The swap service is slow right now. Quotes may take longer than usual.</p>
          </div>
          <div className="banner states-banner">
            <p>Practice mode. Nothing here is a real swap and no address shown can receive funds.</p>
          </div>
        </Case>
        <Case label="The three icon links: each with an address, and each without one (the same to look at)">
          <ul className="social">
            {socialLinks({ dexscreenerUrl: "https://dexscreener.com/bsc/0x0000000000000000000000000000000000000000", githubUrl: "https://github.com/intentswap", xUrl: "https://x.com/intentswap" }).map((link) => (
              <li key={link.key}>
                <a className="social-link" href={link.href ?? undefined} target="_blank" rel="noopener noreferrer" aria-label={link.label}>
                  {SOCIAL_MARKS[link.key]}
                </a>
              </li>
            ))}
            {socialLinks(null).map((link) => (
              <li key={link.key}>
                <a className="social-link" role="link" aria-disabled="true" aria-label={link.label}>
                  {SOCIAL_MARKS[link.key]}
                </a>
              </li>
            ))}
          </ul>
        </Case>
        <Case label="Toast">
          <div className="toast states-toast">Copied</div>
        </Case>
        <Case label="Skeletons">
          <div className="states-row">
            <span className="skeleton skeleton-amount states-skeleton" />
            <span className="skeleton skeleton-value" />
            <span className="skeleton skeleton-coin" />
          </div>
        </Case>
      </Group>
    </main>
  );
}
