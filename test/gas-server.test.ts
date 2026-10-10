// "Add gas", on the server. Beside a swap, a second, small, ordinary order delivers a little of the
// receiving chain's own coin to the swap's receiving address. These tests hold the server to what
// that means:
//
//   - the gas order goes to the swap's receiving address and refunds to the swap's refund address,
//     and nothing a request says can change either;
//   - it is routed privately, or it is not offered and not made;
//   - it is made by the very path every order is made by, so every check and every limit applies
//     to it on its own;
//   - whatever stops it, the swap is made and stands.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toChecksumAddress } from "../shared/addresses.ts";
import type { GasQuote, OrderView, QuoteView } from "../shared/api.ts";
import { gasIdOf, gasInputFor, gasPreviewAmount } from "../server/gas.ts";
import { hashId } from "../server/log.ts";
import { EXPIRE_AFTER_DEADLINE_MS } from "../server/poller.ts";
import type { QuoteInput } from "../server/quotes.ts";
import { LIMITS, MAX_UNPAID_PER_CLIENT } from "../server/ratelimit.ts";
import { createStaticSanctions, type Sanctions } from "../server/sanctions.ts";
import { createOrderStore, isOrderId, newOrderId, WIPED_KEPT_MS, type OrderRecord } from "../server/store.ts";
import { createStubProvider } from "../server/stub-provider.ts";
import type { Token } from "../server/tokens.ts";
import { ADDR, asOrder, ASSET, eventually, FIXTURE_TOKENS, harness, outcome, putMined, type Harness, type HarnessOptions, type Reply, type RequestOptions } from "./helpers.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOON = Date.parse("2026-10-08T12:00:00.000Z");
const THAT_DAY = Date.parse("2026-10-08T00:00:00.000Z");
const ROOMY = { max: 100_000, windowMs: DAY };
/** Room for a test that makes many orders: every limit that counts requests or orders, wide open. The caps on unpaid orders are not limits of this kind, and stay. */
const WIDE = { quote: ROOMY, orderCreate: ROOMY, orderPerRecipient: ROOMY } as const;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// Every address and hash here is made up from fixed text, so they are nobody's.
const made = (label: string, bytes: number) => sha(`gas test ${label}`).slice(0, bytes * 2);
const address = (label: string) => toChecksumAddress(`0x${made(label, 20)}`);
const txHash = (label: string) => `0x${made(label, 32)}`;
const WHO = { sender: address("sender"), recipient: address("recipient"), refundTo: address("refund"), rewards: address("rewards") };
/** Somebody else's addresses: where a request might try to send the gas, or its refund. */
const ELSE = { recipient: address("another recipient"), refundTo: address("another refund"), sender: address("another sender") };

/** Ether on Arbitrum: the own coin of the chain the swaps of these tests deliver on, and so the coin their gas orders deliver. */
const ARB_ETH = "nep141:arb.omft.near";
const ETH_ETH = "nep141:eth.omft.near";
const ETH_USDC = "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near";
const TRON_USDT = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
const TRX = "nep141:tron.omft.near";
const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** The swap every test starts from: 0.005 ETH on Base, paid from a wallet, for USDC on Arbitrum. */
const SWAP = { from: ASSET.baseEth, to: ASSET.arbUsdc, pay: "wallet", sender: WHO.sender, recipient: WHO.recipient, refundTo: WHO.refundTo } as const;
const PEOPLE = { sender: WHO.sender, recipient: WHO.recipient, refundTo: WHO.refundTo };
/** Three dollars of ETH at the list's $2,500: what a gas order to Arbitrum is sent. */
const GAS_AMOUNT = "1200000000000000";
const SWAP_AMOUNT = "5000000000000000";

let open: Harness[] = [];
/** A server set to route privately, as the live site is: gas is offered only there. */
async function start(options: HarnessOptions = {}): Promise<Harness> {
  const h = await harness({ ...options, env: { PRIVACY_MODE: "basic", ...options.env } });
  open.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(open.map((h) => h.close()));
  open = [];
});

// ---- asking ----
async function askGas(h: Harness, body: Record<string, unknown> = {}, opts: RequestOptions = {}): Promise<Reply> {
  const session = opts.session === undefined ? await h.session(opts.ip) : opts.session;
  return h.post("/api/gas", { ...SWAP, ...body }, { ...opts, session });
}
/** The preview of a gas order, where it is offered. */
async function gasFor(h: Harness, body: Record<string, unknown> = {}, opts: RequestOptions = {}): Promise<GasQuote> {
  const reply = await askGas(h, body, opts);
  expect([reply.status, reply.body.gas === null], reply.text).toEqual([200, false]);
  return reply.body.gas as GasQuote;
}
const reviewedOf = (quote: QuoteView) => ({ amountOut: quote.amountOut, minAmountOut: quote.minAmountOut, totalFeeBps: quote.fees.appBps + quote.fees.providerBps, routing: quote.routing });
/** What a request for an order says of the gas the person reviewed: its amount, and its numbers. */
const askedFor = (gas: GasQuote) => ({ amount: gas.quote.amountIn, reviewed: reviewedOf(gas.quote) });
/** A swap with gas, asked for the way the page asks: the gas previewed, the swap previewed, then the one request for both. */
async function pair(h: Harness, overrides: Record<string, unknown> = {}, opts: RequestOptions = {}): Promise<Reply> {
  const gas = askedFor(await gasFor(h, {}, opts));
  return h.order({ ...PEOPLE, gas, ...overrides }, opts);
}

// ---- looking ----
const live = (h: Harness) => h.tap.quotes.filter((sent) => sent.dry === false);
const isGasQuote = (sent: Record<string, unknown>) => sent.destinationAsset === ARB_ETH;
const record = (h: Harness, id: string) => h.store.get(id) as OrderRecord;
const read = async (h: Harness, id: string) => (await h.get(`/api/orders/${id}`)).body as OrderView;
/** The log lines of one kind, as they were written. */
const logged = (h: Harness, event: string) => h.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === event);
/** Whether a text carries a value, in any mix of capitals and with or without its 0x. */
const carries = (text: string, value: string) => text.toLowerCase().includes(value.replace(/^0x/i, "").toLowerCase());
/** The key the count of orders to a receiving address is kept under. */
const recipientKey = (chain: string, recipient: string) => createHash("sha256").update(`${chain}:${recipient.toLowerCase()}`).digest("base64url");

// ---- moving an order along ----
async function step(h: Harness, id: string, ms: number): Promise<void> {
  h.clock.t += ms;
  h.poller.nudge(id);
  await h.poller.tick();
}
/** Paid and delivered, as the practice provider reports it: deposit seen, swapping, delivered. */
async function deliver(h: Harness, id: string, depositAddress: string): Promise<void> {
  h.stub.control(depositAddress, "deposit");
  await step(h, id, 5000);
  await step(h, id, 5000);
  await step(h, id, 15_000);
}
async function refund(h: Harness, id: string, depositAddress: string): Promise<void> {
  h.stub.control(depositAddress, "refund");
  await step(h, id, 5000);
  await step(h, id, 5000);
}
/** A sanctions list that is asked as the server asks it, and remembers what it was asked. Clear until told to list an address. */
function screening(): { sanctions: Sanctions; asked: string[][]; list(addresses: string[]): void; fail(): void } {
  let current = createStaticSanctions([], { now: () => NOON });
  let failing = false;
  const asked: string[][] = [];
  return {
    asked,
    list: (addresses) => void (current = createStaticSanctions(addresses, { now: () => NOON })),
    fail: () => void (failing = true),
    sanctions: {
      available: () => current.available(),
      version: () => current.version(),
      screen(addresses) {
        asked.push(addresses.map(String));
        // An address is in the words of the failure, to show that no such word reaches a log.
        if (failing) throw new TypeError(`screening broke on ${WHO.recipient}`);
        return current.screen(addresses);
      },
    },
  };
}

describe("a gas order's ID is worked out from its swap's", () => {
  it("is the first 27 characters of the SHA-256 of 'gas:' and the swap's ID, in URL-safe base64: the shape of any order's ID", () => {
    expect(gasIdOf("A".repeat(27))).toBe("9vHGRf2AH9utxsQTZASrh-Bw9dj");
    expect(gasIdOf("GasTestOrder000000000000001")).toBe("rApY9WZf0EAhv1cOAeqZLW8_b5l");
    for (let i = 0; i < 200; i++) {
      const swap = newOrderId();
      const gas = gasIdOf(swap);
      expect(isOrderId(gas), swap).toBe(true);
      expect(gas).toBe(createHash("sha256").update(`gas:${swap}`).digest("base64url").slice(0, 27));
      // The same every time it is asked, and never the swap's own.
      expect(gasIdOf(swap)).toBe(gas);
      expect(gas).not.toBe(swap);
      // A gas order has no gas order of its own: the ID worked out from its ID is yet another.
      expect(gasIdOf(gas)).not.toBe(gas);
      expect(gasIdOf(gas)).not.toBe(swap);
    }
  });

  it("two swaps never share a gas order", () => {
    const swaps = Array.from({ length: 5000 }, () => newOrderId());
    expect(new Set(swaps.map(gasIdOf)).size).toBe(swaps.length);
    // IDs that differ in one letter, or only in the case of one, lead to different gas orders.
    expect(new Set(["A".repeat(27), `${"A".repeat(26)}B`, `${"A".repeat(26)}a`, `a${"A".repeat(26)}`].map(gasIdOf)).size).toBe(4);
  });
});

describe("a gas order's input is made from the swap's own input and from nothing else", () => {
  const coin = (id: string, symbol: string, chain: string, contract: string | null, dollars: number): Token => ({ id, symbol, name: symbol, chain, decimals: contract === null ? 18 : 6, priceScaled: BigInt(dollars) * 10n ** 18n, price: String(dollars), contract, wallet: true });
  const ETH_BASE = coin("eth-base", "ETH", "base", null, 2500);
  const USDC_BASE = coin("usdc-base", "USDC", "base", "0x83", 1);
  const ETH_ARB = coin("eth-arb", "ETH", "arb", null, 2500);
  const USDC_ARB = coin("usdc-arb", "USDC", "arb", "0xaf", 1);
  const USDC_NEAR = coin("usdc-near", "USDC", "near", "usdc.near", 1);
  const COINS = [ETH_BASE, USDC_BASE, ETH_ARB, USDC_ARB, USDC_NEAR];
  const swap = (change: Partial<QuoteInput> = {}): QuoteInput => ({ from: ETH_BASE, to: USDC_ARB, amount: 5_000_000_000_000_000n, pay: "wallet", recipient: WHO.recipient, refundTo: WHO.refundTo, sender: WHO.sender, usedPlaceholder: false, slippageBps: 100, confidentiality: "basic", ...change });

  it("the same payer, the same way of paying, the same receiving and refund address; the receiving chain's own coin, the gas amount, private routing", () => {
    const input = swap();
    expect(gasInputFor(input, COINS, 1_200_000_000_000_000n)).toEqual({ ...input, to: ETH_ARB, amount: 1_200_000_000_000_000n });
    // Paid by hand, with no sender: the same of the gas order.
    const byHand = swap({ pay: "manual", sender: null });
    expect(gasInputFor(byHand, COINS, 7n)).toEqual({ ...byHand, to: ETH_ARB, amount: 7n });
    // The swap's own input is left as it was.
    expect(input).toEqual(swap());
  });

  it("there is none beside a swap that is not privately routed: a gas order is never public", () => {
    expect(gasInputFor(swap({ confidentiality: "public" }), COINS, 1_200_000_000_000_000n)).toBeNull();
    // Whatever is made is private, whatever else is true of the swap.
    for (const change of [{}, { pay: "manual" as const }, { slippageBps: 500 }, { usedPlaceholder: true }]) expect(gasInputFor(swap(change), COINS, 1n)?.confidentiality).toBe("basic");
  });

  it("there is none where there is no coin to deliver: the coin received is the chain's own, the chain lists none, or the chain's own coin is the one paid with", () => {
    expect(gasInputFor(swap({ to: ETH_ARB }), COINS, 1n)).toBeNull();
    expect(gasInputFor(swap({ to: USDC_NEAR }), COINS, 1n)).toBeNull();
    expect(gasInputFor(swap({ from: ETH_ARB, to: USDC_ARB }), COINS, 1n)).toBeNull();
    // Paid with a token, for a token on another chain: there is something to add, that chain's own coin.
    expect(gasInputFor(swap({ from: USDC_ARB, to: USDC_BASE }), COINS, 1n)).toMatchObject({ from: USDC_ARB, to: ETH_BASE });
  });

  it("its slippage limit is the usual one, whatever the swap's is: the order is made with what its preview was worked out with", () => {
    for (const slippageBps of [10, 100, 300, 500]) expect(gasInputFor(swap({ slippageBps }), COINS, 1n)?.slippageBps).toBe(100);
  });

  it("its previewed amount is the chain's size in dollars at the list's price for the paying coin", () => {
    // $3 of ETH at $2,500; $5 to Ethereum; $10 to Tron.
    expect(gasPreviewAmount(ETH_BASE, "arb")).toBe(1_200_000_000_000_000n);
    expect(gasPreviewAmount(ETH_BASE, "eth")).toBe(2_000_000_000_000_000n);
    expect(gasPreviewAmount(ETH_BASE, "tron")).toBe(4_000_000_000_000_000n);
    expect(gasPreviewAmount(USDC_BASE, "arb")).toBe(3_000_000n);
    expect(gasPreviewAmount({ ...USDC_BASE, priceScaled: 0n }, "arb")).toBeNull();
  });
});

describe("POST /api/gas: whether gas can be added beside a swap", () => {
  it("offers it with its size and a verified, privately routed preview: the receiving chain's own coin, to the swap's receiving address", async () => {
    const h = await start();
    const reply = await askGas(h);
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body).sort()).toEqual(["gas", "serverNow"]);
    expect(reply.body.serverNow).toBe(new Date(NOON).toISOString());
    const gas = reply.body.gas as GasQuote;
    expect(gas.usd).toBe(3);
    expect(gas.quote).toMatchObject({ from: ASSET.baseEth, to: ARB_ETH, amountIn: GAS_AMOUNT, amountInUsd: "3", routing: "confidential", slippageBps: 100 });
    // IntentSwap's fee is the server's setting, which is none: the provider's own is all there is.
    expect(gas.quote.fees).toMatchObject({ appBps: 0, appAmount: "0", providerBps: 20 });
    expect(BigInt(gas.quote.amountOut)).toBeGreaterThan(0n);
    // What the provider was asked: a preview, in private, of that coin, for the swap's own addresses.
    expect(h.tap.quotes).toHaveLength(1);
    expect(h.tap.quotes[0]).toMatchObject({ dry: true, confidentiality: "basic", originAsset: ASSET.baseEth, destinationAsset: ARB_ETH, amount: GAS_AMOUNT, recipient: WHO.recipient, refundTo: WHO.refundTo, connectedWallets: [WHO.sender], slippageTolerance: 100 });
    expect(Object.keys(h.tap.quotes[0]!)).not.toContain("appFees");
    // A preview like any other: in the class of the provider's budget that previews have.
    expect(h.tap.quoteClasses).toEqual(["user"]);
    expect(h.access.at(-1)).toMatchObject({ route: "gas", status: 200 });
  });

  it("the size is the receiving chain's: three dollars, five to Ethereum, ten to Tron, each at the list's price for the paying coin", async () => {
    const h = await start();
    // With no addresses yet: the page asks as soon as the two coins are chosen.
    const bare = { recipient: undefined, refundTo: undefined, sender: undefined, pay: "manual" };
    const sizes: Array<[string, string, number, string]> = [
      [ASSET.arbUsdc, ARB_ETH, 3, "1200000000000000"],
      [ETH_USDC, ETH_ETH, 5, "2000000000000000"],
      [TRON_USDT, TRX, 10, "4000000000000000"],
      [ASSET.solUsdt, ASSET.sol, 3, "1200000000000000"],
    ];
    for (const [to, own, usd, amount] of sizes) {
      const gas = await gasFor(h, { ...bare, to });
      expect([gas.usd, gas.quote.to, gas.quote.amountIn], to).toEqual([usd, own, amount]);
      expect(h.tap.quotes.at(-1), to).toMatchObject({ dry: true, confidentiality: "basic", destinationAsset: own, amount });
    }
    // Paid with a dollar coin: three dollars of it.
    const gas = await gasFor(h, { ...bare, from: ASSET.baseUsdc, to: ASSET.solUsdt });
    expect([gas.usd, gas.quote.from, gas.quote.to, gas.quote.amountIn]).toEqual([3, ASSET.baseUsdc, ASSET.sol, "3000000"]);
  });

  it("offers none, and asks the provider nothing, where there is nothing to add: the coin received is the chain's own, the chain lists none, or the chain's own coin is the one paid with", async () => {
    const h = await start();
    const bare = { recipient: undefined, refundTo: undefined, sender: undefined, pay: "manual" };
    const none: Array<[string, Record<string, unknown>]> = [
      ["the coin received is the chain's own coin", { ...bare, to: ASSET.sol }],
      ["the coin received is the chain's own coin, on the paying chain's twin", { ...bare, to: ARB_ETH }],
      ["the receiving chain lists no coin of its own", { ...bare, to: NEAR_USDC }],
      ["the chain's own coin is the coin paid with", { ...bare, from: ARB_ETH, to: ASSET.arbUsdc }],
    ];
    for (const [why, body] of none) {
      const reply = await askGas(h, body);
      expect([reply.status, reply.body], why).toEqual([200, { gas: null, serverNow: new Date(NOON).toISOString() }]);
    }
    expect(h.tap.quotes).toEqual([]);
    // And none of these used up any of what previews from everyone share.
    expect(h.limiters.quoteGlobal.remaining("all")).toBe(LIMITS.quoteGlobal.max);
  });

  it("offers none where the server routes in public, whatever the request says: a gas order is never asked for in public", async () => {
    for (const env of [{ PRIVACY_MODE: "public" }, { PRIVACY_MODE: "" }]) {
      const h = await start({ env });
      for (const extra of [{}, { confidentiality: "basic" }, { withoutPrivate: false }, { routing: "confidential" }, { private: true }]) {
        const reply = await askGas(h, extra);
        expect([reply.status, reply.body.gas], JSON.stringify(extra)).toEqual([200, null]);
      }
      expect(h.tap.quotes).toEqual([]);
    }
  });

  it("offers none where the paying coin gives no amount: a size that comes to less than one unit of it", async () => {
    // A coin with no decimal places at $100,000: three dollars of it is nothing at all.
    const BIG = "nep141:base-0x00000000000000000000000000000000000000b1.omft.near";
    const h = await start();
    h.tap.tokensResult = { ok: true, status: 200, data: [...FIXTURE_TOKENS, { assetId: BIG, decimals: 0, blockchain: "base", symbol: "BIG", price: 100000, priceUpdatedAt: "2026-10-08T11:59:00.000Z", contractAddress: "0x00000000000000000000000000000000000000b1" }] };
    const reply = await askGas(h, { from: BIG, pay: "manual", sender: undefined });
    expect([reply.status, reply.body.gas]).toEqual([200, null]);
    expect(h.tap.quotes).toEqual([]);
    // The coin is on the list, and paid with any other coin the same swap is offered gas.
    expect(((await h.get("/api/tokens")).body.tokens as Array<{ id: string }>).some((token) => token.id === BIG)).toBe(true);
    expect((await gasFor(h, { pay: "manual", sender: undefined })).quote.to).toBe(ARB_ETH);
  });

  it("offers none when the provider will not have it: its minimum, too low an amount, no route, no private routing, a refusal, no answer, or an answer that cannot be confirmed", async () => {
    const h = await start({ limits: WIDE });
    const NONE = { gas: null, serverNow: new Date(NOON).toISOString() };
    const refusals: Array<[string, () => void]> = [
      ["the provider's minimum", () => void (h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message: "Minimum swap amount is $10" })],
      ["an amount it finds too low", () => void (h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message: "Amount is too low for bridge, try at least 4000000000000000" })],
      ["no route", () => void (h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message: "No liquidity available" })],
      ["no partner key for private quotes", () => void (h.stub.privateFails = "unauthorized")],
      ["private routing not offered for the pair", () => void (h.stub.privateFails = "not_offered")],
      ["no private route", () => void (h.stub.privateFails = "no_route")],
      ["a refusal of the swap", () => void (h.stub.privateFails = "forbidden")],
      ["a refusal of the receiving address", () => void (h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message: "recipient is not valid" })],
      ["a refusal of the refund address", () => void (h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message: "refundTo is not valid" })],
      ["no answer", () => void (h.tap.nextQuote = { ok: false, kind: "unavailable", status: 503 })],
      ["this site's own share of the provider's budget being spent", () => void (h.tap.nextQuote = { ok: false, kind: "unavailable", status: null, budget: true })],
      ["an answer whose signature does not hold", () => void (h.tap.corruptResponse = (data) => ({ ...data, quote: { ...(data.quote as Record<string, unknown>), amountOut: "99999999999999999" } }))],
      ["an answer to another request", () => void (h.tap.tamperRequest = (sent) => ({ ...sent, recipient: ELSE.recipient }))],
      ["an answer in public to a private request", () => void (h.tap.tamperRequest = (sent) => ({ ...sent, confidentiality: "public" }))],
    ];
    for (const [why, arrange] of refusals) {
      arrange();
      const before = h.tap.quotes.length;
      const reply = await askGas(h);
      expect([reply.status, reply.body], why).toEqual([200, NONE]);
      // It was asked, in private, as a preview: the answer is the provider's, and not a list of chains.
      expect(h.tap.quotes.slice(before), why).toMatchObject([{ dry: true, confidentiality: "basic", destinationAsset: ARB_ETH }]);
      h.stub.privateFails = null;
      h.tap.nextQuote = null;
      h.tap.corruptResponse = null;
      h.tap.tamperRequest = null;
    }
    // An answer that could not be confirmed is still told to the operator, as for any quote.
    expect(h.alerts.map((alert) => alert.kind)).toEqual(["quote_verification", "quote_verification", "quote_verification"]);
    // And with the provider answering again, gas is offered again: nothing was remembered against the pair.
    expect((await gasFor(h)).quote.to).toBe(ARB_ETH);
  });

  it("reads the swap's two coins, its way of paying and its three addresses, and nothing else: no amount, no slippage limit, no word about routing, no address for the gas", async () => {
    const h = await start({ limits: WIDE });
    await gasFor(h);
    const plain = h.tap.quotes[0]!;
    const tricks: Record<string, unknown>[] = [
      { withoutPrivate: true },
      { withoutPrivate: "true", confidentiality: "public", routing: "public", privacy: "public" },
      { amount: "5000000000000000000" },
      { amount: "1", usd: 10, size: 10, gasUsd: 10 },
      { slippageBps: 500 },
      { slippageTolerance: 500 },
      { gas: { amount: "9", recipient: ELSE.recipient, refundTo: ELSE.refundTo, to: ASSET.sol } },
      { gasRecipient: ELSE.recipient, gasRefundTo: ELSE.refundTo, gasTo: ASSET.sol, gasFrom: ASSET.arbUsdc },
      { destinationAsset: ASSET.sol, originAsset: ASSET.arbUsdc, recipientType: "INTENTS", dry: false, appFees: [{ recipient: ELSE.recipient, fee: 100 }] },
      { ghost: true, rewardsAddress: WHO.rewards, requestId: "a-request-key-0123456789" },
    ];
    for (const extra of tricks) {
      const gas = await gasFor(h, extra);
      expect(gas.quote, JSON.stringify(extra)).toMatchObject({ to: ARB_ETH, amountIn: GAS_AMOUNT, routing: "confidential", slippageBps: 100 });
      // Letter for letter what was asked without it.
      expect(h.tap.quotes.at(-1), JSON.stringify(extra)).toEqual(plain);
    }
    // Every request the provider ever had from this route: a preview, in private.
    expect(new Set(h.tap.quotes.map((sent) => `${String(sent.dry)} ${String(sent.confidentiality)}`))).toEqual(new Set(["true basic"]));
  });

  it("holds the swap to every check a quote holds it to, and refuses what a quote refuses, in the same words", async () => {
    const h = await start({ limits: WIDE });
    const bad: Record<string, unknown>[] = [
      { from: "nep141:no-such-coin.near" },
      { to: "nep141:no-such-coin.near" },
      { from: undefined },
      { to: 7 },
      { to: ASSET.baseEth },
      { pay: "card" },
      { pay: undefined },
      { recipient: "0x1234" },
      { recipient: ADDR.sol },
      { refundTo: "not an address" },
      { sender: "0xnope" },
      // A coin that cannot be paid from a wallet, asked for that way.
      { from: ASSET.btc, pay: "wallet", sender: undefined, refundTo: undefined },
    ];
    for (const change of bad) {
      const asGas = await askGas(h, change);
      const asQuote = await h.quote({ ...SWAP, amount: SWAP_AMOUNT, ...change });
      expect(asGas.status, JSON.stringify(change)).toBe(400);
      expect([asGas.status, asGas.body], JSON.stringify(change)).toEqual([asQuote.status, asQuote.body]);
    }
    expect((await h.post("/api/gas", ["not", "a", "record"], { session: await h.session() })).status).toBe(400);
    expect(h.tap.quotes).toEqual([]);
  });

  it("is asked only from the site's own pages, with a session, while swaps are on, and counts as a preview against every limit previews have", async () => {
    const h = await start({ limits: { quote: { max: 3, windowMs: MINUTE } } });
    expect(outcome(await askGas(h, {}, { session: null }))).toBe("session");
    expect(outcome(await askGas(h, {}, { origin: "https://elsewhere.example" }))).toBe("origin");
    expect((await h.get("/api/gas")).status).toBe(405);
    const large = await h.post("/api/gas", { ...SWAP, padding: "x".repeat(2100) }, { session: await h.session() });
    expect(large.status).toBe(413);
    expect(h.tap.quotes).toEqual([]);
    // The visitor's own allowance of previews: gas and swap previews are counted together. (The four requests above each used one.)
    const visitor = { ip: "198.51.100.7" };
    expect((await askGas(h, {}, visitor)).body.gas).not.toBeNull();
    expect(outcome(await h.quote({ ...SWAP, amount: SWAP_AMOUNT }, visitor))).toBe("ok");
    expect((await askGas(h, {}, visitor)).body.gas).not.toBeNull();
    const over = await askGas(h, {}, visitor);
    expect([over.status, outcome(over)]).toEqual([429, "rate_limited"]);

    // What previews from everyone share: a limit of this site's own is an error, and never "not offered".
    const shared = await start({ limits: { quoteGlobal: { max: 1, windowMs: MINUTE } } });
    expect(outcome(await shared.quote({ ...SWAP, amount: SWAP_AMOUNT }))).toBe("ok");
    const refused = await askGas(shared);
    expect([refused.status, outcome(refused), refused.body.gas]).toEqual([429, "rate_limited", undefined]);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect(shared.tap.quotes).toHaveLength(1);

    const paused = await start({ env: { SWAPS_PAUSED: "true" } });
    expect(outcome(await askGas(paused))).toBe("paused");
    expect(paused.tap.quotes).toEqual([]);
  });
});

describe("POST /api/orders with gas: two orders, each made by the one path", () => {
  it("makes the swap and the gas order: two records, two deposit addresses, each with its own quote and its own screening, and the gas order goes exactly where the swap goes", async () => {
    const screened = screening();
    const h = await start({ sanctions: screened.sanctions });
    const gas = await gasFor(h);
    const reply = await h.order({ ...PEOPLE, rewardsAddress: WHO.rewards, gas: askedFor(gas) });
    expect(reply.status).toBe(201);
    const order = asOrder(reply);
    const gasId = gasIdOf(order.id);

    // Two records, and nothing else.
    expect(h.store.ids().sort()).toEqual([order.id, gasId].sort());
    const [swap, added] = [record(h, order.id), record(h, gasId)];
    // The swap is the swap it always was, and says that its gas order was made.
    expect(swap).toMatchObject({ from: { id: ASSET.baseEth }, to: { id: ASSET.arbUsdc }, amountIn: SWAP_AMOUNT, recipient: WHO.recipient, refundTo: WHO.refundTo, sender: WHO.sender, rewardsAddress: WHO.rewards, confidentiality: "basic", gas: "made" });
    expect("gasOrder" in swap).toBe(false);
    // The gas order: the same payer, the same coin paid with, the same receiving address and refund address; the chain's own coin; private.
    expect(added).toMatchObject({ gasOrder: true, pay: "wallet", from: swap.from, to: { id: ARB_ETH, symbol: "ETH", chain: "arb", contract: null }, amountIn: GAS_AMOUNT, amountInUsd: "3", recipient: WHO.recipient, refundTo: WHO.refundTo, sender: WHO.sender, rewardsAddress: WHO.rewards, confidentiality: "basic", slippageBps: 100, termsVersion: swap.termsVersion });
    expect([added.recipient, added.refundTo, added.sender]).toEqual([swap.recipient, swap.refundTo, swap.sender]);
    expect(added.to.chain).toBe(swap.to.chain);
    // It holds nothing that leads back to its swap, and no gas of its own.
    expect("gas" in added).toBe(false);
    expect(carries(JSON.stringify(added), order.id)).toBe(false);
    // The numbers are those of its own verified quote, which are the ones that were previewed.
    expect([added.amountOut, added.minAmountOut, added.fees]).toEqual([gas.quote.amountOut, gas.quote.minAmountOut, gas.quote.fees]);
    expect(added.fees).toMatchObject({ appBps: 0, appAmount: "0" });

    // Each has its own deposit address, its own signed quote from the provider and its own screening.
    expect(added.depositAddress).not.toBe(swap.depositAddress);
    for (const made of [swap, added]) {
      expect(made.quoteResponse).toMatchObject({ signature: expect.stringMatching(/^ed25519:/), quote: { depositAddress: made.depositAddress }, quoteRequest: { dry: false, recipient: WHO.recipient, refundTo: WHO.refundTo, confidentiality: "basic" } });
      expect(made.screening).toEqual({ result: "clear", listVersion: "test-list", checkedAt: new Date(NOON).toISOString() });
      expect(h.poller.holds(made.id)).toBe(true);
    }
    expect((swap.quoteResponse as { signature: string }).signature).not.toBe((added.quoteResponse as { signature: string }).signature);
    expect(screened.asked).toEqual([[WHO.sender, WHO.recipient, WHO.refundTo, WHO.rewards], [WHO.sender, WHO.recipient, WHO.refundTo, WHO.rewards]]);

    // The provider was asked for two real orders, each in the class real orders have: the swap, then the gas order.
    expect(live(h)).toMatchObject([
      { destinationAsset: ASSET.arbUsdc, amount: SWAP_AMOUNT, recipient: WHO.recipient, refundTo: WHO.refundTo, confidentiality: "basic" },
      { destinationAsset: ARB_ETH, amount: GAS_AMOUNT, recipient: WHO.recipient, refundTo: WHO.refundTo, confidentiality: "basic", originAsset: ASSET.baseEth, connectedWallets: [WHO.sender], slippageTolerance: 100 },
    ]);
    expect(h.tap.quoteClasses).toEqual(["user", "user", "order", "order"]);
    for (const sent of live(h)) expect(Object.keys(sent)).not.toContain("appFees");

    // What the person is told: the swap, and with it the gas order as it stands, an order of its own.
    expect(order).toMatchObject({ id: order.id, status: "waiting", depositAddress: swap.depositAddress, recipient: WHO.recipient, routing: "confidential" });
    expect("gasOrder" in order).toBe(false);
    expect(order.gas).toEqual({ made: true, order: expect.objectContaining({ id: gasId, gasOrder: true, status: "waiting", depositAddress: added.depositAddress, depositsOpen: true, amountIn: GAS_AMOUNT, recipient: WHO.recipient, refundTo: WHO.refundTo, routing: "confidential", rewardsAddress: WHO.rewards, to: added.to, from: added.from, deadline: added.deadline }) });
    const shown = (order.gas as { order: OrderView }).order;
    expect("gas" in shown).toBe(false);
    expect("ghost" in shown).toBe(false);
    // Nothing was logged about a gas order that was made, and the request's own line is the swap's.
    expect(logged(h, "gas_not_made")).toEqual([]);
    expect(h.access.at(-1)).toMatchObject({ route: "order_create", status: 201, order: hashId(order.id), screening: "clear", cid: (swap.quoteResponse as { correlationId: string }).correlationId });
  });

  it("nothing a request says can send the gas, or its refund, anywhere but where the swap's go, change its coin, or make it public", async () => {
    const h = await start({ limits: WIDE });
    const gas = askedFor(await gasFor(h));
    const elsewhere = { recipient: ELSE.recipient, refundTo: ELSE.refundTo, sender: ELSE.sender };
    const tricks: Record<string, unknown>[] = [
      { gas: { ...gas, ...elsewhere } },
      { gas: { ...gas, to: ASSET.sol, from: ASSET.arbUsdc, pay: "manual" } },
      { gas: { ...gas, confidentiality: "public", withoutPrivate: true, routing: "public", privacy: "public" } },
      { gas: { ...gas, slippageBps: 500, rewardsAddress: address("other rewards"), ghost: true, id: "A".repeat(27), gasOrder: false, termsVersion: "none" } },
      { gas: { ...gas, destinationAsset: ASSET.sol, originAsset: ASSET.arbUsdc, recipientType: "INTENTS", refundType: "INTENTS", appFees: [{ recipient: ELSE.recipient, fee: 100 }], deadline: "2030-01-01T00:00:00.000Z" } },
      { gas: { ...gas, swap: elsewhere, order: elsewhere, quote: elsewhere, input: elsewhere } },
      { gas, gasRecipient: ELSE.recipient, gasRefundTo: ELSE.refundTo, gasSender: ELSE.sender, gasTo: ASSET.sol, gasFrom: ASSET.arbUsdc },
      { gas, gasOrder: { ...elsewhere, to: ASSET.sol }, gasConfidentiality: "public", gasWithoutPrivate: true, gasId: "A".repeat(27), gasOf: "A".repeat(27) },
      { gas, confidentiality: "public", routing: "public", privacy: "public", level: "public" },
    ];
    for (const [i, trick] of tricks.entries()) {
      const visitor = { ip: `198.51.100.${i + 1}` };
      const order = asOrder(await h.order({ ...PEOPLE, ...trick }, visitor));
      const [swap, added] = [record(h, order.id), record(h, gasIdOf(order.id))];
      const why = JSON.stringify(trick).slice(0, 80);
      expect(order.gas, why).toMatchObject({ made: true, order: { id: added.id } });
      // The gas order is where the swap is, to the letter, and the swap is where the person said.
      expect([added.recipient, added.refundTo, added.sender], why).toEqual([WHO.recipient, WHO.refundTo, WHO.sender]);
      expect([swap.recipient, swap.refundTo, swap.sender], why).toEqual([WHO.recipient, WHO.refundTo, WHO.sender]);
      expect(added, why).toMatchObject({ gasOrder: true, from: { id: ASSET.baseEth }, to: { id: ARB_ETH }, pay: "wallet", amountIn: GAS_AMOUNT, confidentiality: "basic", slippageBps: 100, rewardsAddress: null });
      expect("ghost" in added, why).toBe(false);
      expect(added.id, why).toBe(gasIdOf(swap.id));
      // What the provider was asked for it, and what it signed.
      expect(live(h).at(-1), why).toMatchObject({ destinationAsset: ARB_ETH, originAsset: ASSET.baseEth, recipient: WHO.recipient, refundTo: WHO.refundTo, connectedWallets: [WHO.sender], confidentiality: "basic", recipientType: "DESTINATION_CHAIN", refundType: "ORIGIN_CHAIN", slippageTolerance: 100 });
      expect(Object.keys(live(h).at(-1)!), why).not.toContain("appFees");
      expect((added.quoteResponse as { quoteRequest: Record<string, unknown> }).quoteRequest, why).toMatchObject({ recipient: WHO.recipient, refundTo: WHO.refundTo, destinationAsset: ARB_ETH, confidentiality: "basic" });
    }
    // In all of it, nobody else's address was sent to the provider, stored or screened, and nothing was asked for in public.
    const everything = JSON.stringify(h.tap.quotes) + h.store.ids().map((id) => JSON.stringify(h.store.get(id))).join("");
    for (const other of Object.values(ELSE)) expect(carries(everything, other), other).toBe(false);
    expect(new Set(h.tap.quotes.map((sent) => sent.confidentiality))).toEqual(new Set(["basic"]));
  });

  it("a gas order is never asked of the provider in public: beside a swap routed in public there is none, by the person's choice or by the server's setting", async () => {
    // The person chose public routing for this swap: the swap is made that way, and no gas order is made at all.
    const h = await start();
    const gas = askedFor(await gasFor(h));
    const chosen = await h.order({ ...PEOPLE, withoutPrivate: true, gas });
    expect(chosen.status).toBe(201);
    const order = asOrder(chosen);
    expect(order).toMatchObject({ routing: "public", status: "waiting", gas: { made: false } });
    expect(h.store.ids()).toEqual([order.id]);
    expect(record(h, order.id)).toMatchObject({ confidentiality: "public", gas: "not_made" });
    // One real order was asked for, the swap, and no quote for the chain's own coin went out in public: not a preview, not an order.
    expect(live(h)).toMatchObject([{ destinationAsset: ASSET.arbUsdc, confidentiality: "public" }]);
    expect(h.tap.quotes.filter((sent) => isGasQuote(sent) && sent.confidentiality !== "basic")).toEqual([]);
    expect(logged(h, "gas_not_made")).toEqual([expect.objectContaining({ level: "info", order: hashId(order.id), reason: "not_offered" })]);

    // A server that routes in public: the same, whatever the request says of the gas order's routing.
    const open2 = await start({ env: { PRIVACY_MODE: "public" } });
    const made = asOrder(await open2.order({ ...PEOPLE, gas: { ...gas, confidentiality: "basic", routing: "confidential" } }));
    expect(made).toMatchObject({ routing: "public", gas: { made: false } });
    expect(open2.store.ids()).toEqual([made.id]);
    expect(open2.tap.quotes.filter(isGasQuote)).toEqual([]);
    expect(open2.tap.quotes.every((sent) => sent.confidentiality === "public")).toBe(true);
  });

  it("switched off as a whole (ADD_GAS=off): the preview answers not offered and asks the provider nothing, and a request that asks for gas all the same gets its swap and no gas order", async () => {
    // What a page left open from before the switch would still send: a preview made while gas was on.
    const on = await start();
    const gas = askedFor(await gasFor(on));
    const h = await start({ env: { ADD_GAS: "off" } });
    const asked = h.tap.quotes.length;
    const reply = await askGas(h);
    expect([reply.status, reply.body.gas]).toEqual([200, null]);
    expect(h.tap.quotes.length).toBe(asked);
    const order = asOrder(await h.order({ ...PEOPLE, gas }));
    expect(order).toMatchObject({ status: "waiting", amountIn: SWAP_AMOUNT, gas: { made: false } });
    expect(h.store.get(gasIdOf(order.id))).toBeNull();
    // The provider was asked for the swap alone.
    expect(live(h)).toMatchObject([{ destinationAsset: ASSET.arbUsdc }]);
    expect(logged(h, "gas_not_made").at(-1)).toMatchObject({ order: hashId(order.id), reason: "off" });
    // A swap asked for without gas is as ever.
    const plain = asOrder(await h.order({ ...PEOPLE }, { ip: "198.51.100.9" }));
    expect("gas" in plain).toBe(false);
  });

  it("gas is never a way to make a second order of any size: an amount outside the band of a gas order is not made, and the swap is", async () => {
    const h = await start({ limits: WIDE });
    const gas = askedFor(await gasFor(h));
    // The receiving chain's size is $3. Worth $50, $500, $3.31 and $2.69 at the list's $2,500, and one unit; then the
    // amounts of the larger sizes, $5, $10 and $11: a gas order is of its own chain's size, and of no other.
    for (const [i, amount] of ["20000000000000000", "200000000000000000", "1324000000000000", "1076000000000000", "1", "2000000000000000", "4000000000000000", "4400000000000000"].entries()) {
      const before = live(h).length;
      const order = asOrder(await h.order({ ...PEOPLE, gas: { ...gas, amount } }, { ip: `198.51.100.${i + 1}` }));
      expect(order, amount).toMatchObject({ status: "waiting", amountIn: SWAP_AMOUNT, gas: { made: false } });
      expect(h.store.get(gasIdOf(order.id)), amount).toBeNull();
      // The provider was asked for the swap alone.
      expect(live(h).slice(before), amount).toMatchObject([{ destinationAsset: ASSET.arbUsdc }]);
      expect(logged(h, "gas_not_made").at(-1), amount).toMatchObject({ order: hashId(order.id), reason: "amount" });
    }
    // The edges of the band are a gas order's: $2.70 and $3.30 (with numbers reviewed for that amount).
    for (const [i, amount] of ["1080000000000000", "1320000000000000"].entries()) {
      // The numbers a preview of that amount would give: the practice provider's are in proportion.
      const scaled = (value: string) => ((BigInt(value) * BigInt(amount)) / BigInt(GAS_AMOUNT)).toString();
      const reviewed = { ...gas.reviewed, amountOut: scaled(gas.reviewed.amountOut), minAmountOut: scaled(gas.reviewed.minAmountOut) };
      const order = asOrder(await h.order({ ...PEOPLE, gas: { amount, reviewed } }, { ip: `198.51.100.${i + 20}` }));
      expect(order.gas, amount).toMatchObject({ made: true, order: { amountIn: amount } });
    }
  });

  it("a request whose gas is not in the shape of one is refused whole, before anything is made; left out or null, no gas is asked for", async () => {
    const h = await start({ limits: WIDE });
    const gas = askedFor(await gasFor(h));
    const swap = (await h.quote({ ...SWAP, amount: SWAP_AMOUNT })).body as QuoteView;
    const reviewed = reviewedOf(swap);
    const malformed: unknown[] = [
      "yes",
      true,
      1,
      [],
      [gas],
      {},
      { amount: gas.amount },
      { reviewed: gas.reviewed },
      { ...gas, amount: "0" },
      { ...gas, amount: "-1200000000000000" },
      { ...gas, amount: "01200000000000000" },
      { ...gas, amount: "1.2" },
      { ...gas, amount: "1e15" },
      { ...gas, amount: 1200000000000000 },
      { ...gas, amount: "" },
      { ...gas, amount: "9".repeat(41) },
      { ...gas, reviewed: null },
      { ...gas, reviewed: "seen" },
      { ...gas, reviewed: { ...gas.reviewed, amountOut: "12.5" } },
      { ...gas, reviewed: { ...gas.reviewed, minAmountOut: undefined } },
      { ...gas, reviewed: { ...gas.reviewed, totalFeeBps: "20" } },
      { ...gas, reviewed: { ...gas.reviewed, totalFeeBps: 20.5 } },
      { ...gas, reviewed: { ...gas.reviewed, totalFeeBps: -1 } },
      { ...gas, reviewed: { ...gas.reviewed, totalFeeBps: 501 } },
      { ...gas, reviewed: { ...gas.reviewed, routing: "basic" } },
      { ...gas, reviewed: { ...gas.reviewed, routing: "private" } },
    ];
    const attempts = () => h.limiters.orderAttemptDaily.remaining("203.0.113.10");
    const left = attempts();
    for (const value of malformed) {
      const reply = await h.order({ ...PEOPLE, reviewed, gas: value });
      expect([reply.status, reply.body], JSON.stringify(value).slice(0, 60)).toEqual([400, { error: { code: "bad_request", message: "The reviewed gas quote is missing." } }]);
    }
    // Nothing was made, nothing was asked of the provider for an order, and no attempt was counted.
    expect(h.store.ids()).toEqual([]);
    expect(live(h)).toEqual([]);
    expect(attempts()).toBe(left);

    // Left out, or null: an order as ever, told nothing of gas, with nothing of gas on its record.
    for (const [i, none] of [{}, { gas: null }, { gas: undefined }].entries()) {
      const order = asOrder(await h.order({ ...PEOPLE, reviewed, ...none }, { ip: `198.51.100.${i + 1}` }));
      expect("gas" in order, JSON.stringify(none)).toBe(false);
      expect("gas" in record(h, order.id), JSON.stringify(none)).toBe(false);
      expect("gas" in (await read(h, order.id)), JSON.stringify(none)).toBe(false);
      expect(h.store.get(gasIdOf(order.id)), JSON.stringify(none)).toBeNull();
    }
    expect(live(h)).toHaveLength(3);
    expect(logged(h, "gas_not_made")).toEqual([]);
  });

  it("where there is no coin to deliver, or the gas was not reviewed as privately routed, none is made, the provider is not asked for one, and the swap is made", async () => {
    const h = await start({ limits: WIDE });
    const gas = askedFor(await gasFor(h));
    // A swap that receives the chain's own coin: there is nothing to add.
    const native = asOrder(await h.order({ ...PEOPLE, to: ARB_ETH, gas }));
    expect(native).toMatchObject({ to: { id: ARB_ETH }, gas: { made: false } });
    expect(logged(h, "gas_not_made").at(-1)).toMatchObject({ reason: "not_offered" });
    // The gas order's numbers were reviewed as public, or with no word of routing: it is not asked for.
    const { routing: _routing, ...unsaid } = gas.reviewed;
    for (const [i, reviewed] of [{ ...gas.reviewed, routing: "public" }, unsaid].entries()) {
      const before = live(h).length;
      const order = asOrder(await h.order({ ...PEOPLE, gas: { ...gas, reviewed } }, { ip: `198.51.100.${i + 1}` }));
      expect(order.gas).toEqual({ made: false });
      expect(live(h).slice(before)).toMatchObject([{ destinationAsset: ASSET.arbUsdc }]);
      expect(logged(h, "gas_not_made").at(-1)).toMatchObject({ order: hashId(order.id), reason: "routing" });
      // No "price moved" was counted against the visitor for it.
      expect(h.limiters.orderPriceMoved.remaining(`198.51.100.${i + 1}`)).toBe(LIMITS.orderPriceMoved.max);
    }
    expect(h.store.ids()).toHaveLength(3);
  });

  it("a swap with a slippage limit of its own still has its gas order, made with the usual limit its preview was worked out with", async () => {
    const h = await start({ limits: WIDE });
    for (const [i, slippageBps] of [10, 300, 500].entries()) {
      const order = asOrder(await pair(h, { slippageBps }, { ip: `198.51.100.${i + 1}` }));
      expect(order, String(slippageBps)).toMatchObject({ slippageBps, gas: { made: true, order: { slippageBps: 100 } } });
      expect([record(h, order.id).slippageBps, record(h, gasIdOf(order.id)).slippageBps]).toEqual([slippageBps, 100]);
      expect(live(h).slice(-2).map((sent) => sent.slippageTolerance)).toEqual([slippageBps, 100]);
    }
  });

  it("IntentSwap's fee on a gas order is the server's setting for a private swap and nothing else: none unless one is set, and never a figure of the request's", async () => {
    // Set to take a fee on private swaps: the gas order, a private order like any other, carries exactly that.
    const h = await start({ env: { FEE_BPS: "40", FEE_BPS_PRIVATE: "20" } });
    const gas = await gasFor(h, { appFees: [{ recipient: ELSE.recipient, fee: 1 }], feeBps: 1, fee: 1 });
    expect(gas.quote.fees).toMatchObject({ appBps: 20, providerBps: 20 });
    const ours = [{ recipient: h.config.feeRecipient, fee: 20 }];
    expect(h.tap.quotes.at(-1)!.appFees).toEqual(ours);
    const order = asOrder(await h.order({ ...PEOPLE, gas: { ...askedFor(gas), fee: 0, appFees: [] } }));
    expect(order.gas).toMatchObject({ made: true, order: { fees: { appBps: 20, providerBps: 20 } } });
    expect(live(h).map((sent) => sent.appFees)).toEqual([ours, ours]);
    // As the site is set by default, there is no fee of ours on either order (see the first test of this group): nothing is sent, and nothing is stored.
    const free = await start();
    const made = asOrder(await pair(free));
    expect([record(free, made.id).fees.appBps, record(free, gasIdOf(made.id)).fees.appBps]).toEqual([0, 0]);
    expect(free.tap.quotes.every((sent) => !("appFees" in sent))).toBe(true);
  });

  it("paid by deposit address, with no sender: the gas order is paid the same way, and refunds where the swap refunds", async () => {
    const h = await start();
    const byHand = { pay: "manual", sender: undefined };
    const gas = askedFor(await gasFor(h, byHand));
    const order = asOrder(await h.order({ recipient: WHO.recipient, refundTo: WHO.refundTo, ...byHand, gas }));
    const added = record(h, gasIdOf(order.id));
    expect(order).toMatchObject({ pay: "manual", gas: { made: true, order: { pay: "manual", depositAddress: added.depositAddress } } });
    expect(added).toMatchObject({ pay: "manual", sender: null, recipient: WHO.recipient, refundTo: WHO.refundTo, deadline: record(h, order.id).deadline });
    expect(Object.keys(live(h).at(-1)!)).not.toContain("connectedWallets");
  });
});

describe("whatever stops the gas order, the swap is made and stands", () => {
  const isGasOrderQuote = (sent: Record<string, unknown>) => sent.dry === false && isGasQuote(sent);
  /** Has the provider answer the gas order's real quote, and only that, in a given way. */
  const answering = (h: Harness, result: NonNullable<Harness["tap"]["nextQuote"]>) => {
    h.tap.beforeQuote = async (sent) => {
      if (isGasOrderQuote(sent)) h.tap.nextQuote = result;
    };
  };
  interface Stopped {
    name: string;
    /** The fixed word the log gives for why. */
    reason: string;
    options?: () => HarnessOptions;
    /** Arranged after the server has started and before anything is asked. */
    arrange?(h: Harness): void | Promise<void>;
    /** What the request for the order carries of the gas, from what was previewed. */
    gas?(asked: ReturnType<typeof askedFor>): unknown;
    /** How many real orders the provider is asked for by the one request. Two unless the gas order is stopped before the provider is asked. */
    asked?: number;
    /** Where the visitor asks from, where that matters: an address on a wider network that is counted as one. */
    ip?: string;
    after?(h: Harness, order: OrderView): void;
  }
  const listing = screening();
  const failing = screening();
  let diskAsked = 0;
  const stopped: Stopped[] = [
    { name: "the provider refuses it: too low an amount", reason: "amount_too_low", arrange: (h) => answering(h, { ok: false, kind: "rejected", status: 400, message: "Amount is too low for bridge, try at least 4000000000000000" }) },
    { name: "the provider refuses it: its minimum", reason: "min_usd", arrange: (h) => answering(h, { ok: false, kind: "rejected", status: 400, message: "Minimum swap amount is $10" }) },
    { name: "the provider has no private route for it", reason: "private_unavailable", arrange: (h) => answering(h, { ok: false, kind: "rejected", status: 400, message: "No liquidity available" }) },
    { name: "the provider answers a private quote 401", reason: "private_unavailable", arrange: (h) => answering(h, { ok: false, kind: "unavailable", status: 401 }) },
    { name: "the provider's screening refuses it", reason: "blocked", arrange: (h) => answering(h, { ok: false, kind: "rejected", status: 403, message: "" }) },
    { name: "the provider does not answer", reason: "try_later", arrange: (h) => answering(h, { ok: false, kind: "unavailable", status: 503 }) },
    {
      name: "the price moved beyond the tolerance: its own reviewed numbers are what it is held to",
      reason: "price_moved",
      gas: (asked) => ({ ...asked, reviewed: { ...asked.reviewed, amountOut: (BigInt(asked.reviewed.amountOut) * 2n).toString() } }),
      after: (h) => expect(h.limiters.orderPriceMoved.remaining("203.0.113.10")).toBe(LIMITS.orderPriceMoved.max - 1),
    },
    { name: "its minimum received is worse than the one reviewed", reason: "price_moved", gas: (asked) => ({ ...asked, reviewed: { ...asked.reviewed, minAmountOut: ((BigInt(asked.reviewed.minAmountOut) * 102n) / 100n).toString() } }) },
    { name: "its fee is higher than the one reviewed", reason: "price_moved", gas: (asked) => ({ ...asked, reviewed: { ...asked.reviewed, totalFeeBps: asked.reviewed.totalFeeBps - 1 } }) },
    {
      name: "its quote's signature does not hold",
      reason: "try_later",
      arrange: (h) => void (h.tap.corruptResponse = (data) => (isGasOrderQuote(data.quoteRequest as Record<string, unknown>) ? { ...data, quote: { ...(data.quote as Record<string, unknown>), amountOut: "99999999999999999" } } : data)),
      after: (h) => expect(h.alerts).toMatchObject([{ kind: "quote_verification" }]),
    },
    {
      name: "its quote answers another request: another receiving address",
      reason: "try_later",
      arrange: (h) => void (h.tap.tamperRequest = (sent) => (isGasOrderQuote(sent) ? { ...sent, recipient: ELSE.recipient } : sent)),
      after: (h) => expect(h.alerts.map((alert) => alert.text)).toEqual([expect.stringContaining("(echo:recipient)")]),
    },
    {
      name: "its quote answers another request: another refund address",
      reason: "try_later",
      arrange: (h) => void (h.tap.tamperRequest = (sent) => (isGasOrderQuote(sent) ? { ...sent, refundTo: ELSE.refundTo } : sent)),
      after: (h) => expect(h.alerts.map((alert) => alert.text)).toEqual([expect.stringContaining("(echo:refundTo)")]),
    },
    {
      name: "its quote was answered in public",
      reason: "try_later",
      arrange: (h) => void (h.tap.tamperRequest = (sent) => (isGasOrderQuote(sent) ? { ...sent, confidentiality: "public" } : sent)),
      after: (h) => expect(h.alerts.map((alert) => alert.text)).toEqual([expect.stringContaining("(echo:confidentiality)")]),
    },
    {
      name: "the screening finds a listed address when the gas order is screened",
      reason: "blocked",
      asked: 1,
      options: () => ({ sanctions: listing.sanctions }),
      // Clear when the swap is screened, and listed by the time the gas order is: each order is screened when it is made.
      arrange: (h) => void (h.tap.beforeQuote = async (sent) => void (sent.dry === false && listing.list([WHO.recipient]))),
      after: () => expect(listing.asked).toHaveLength(2),
    },
    {
      name: "something breaks that nobody foresaw",
      reason: "error",
      asked: 1,
      options: () => ({ sanctions: failing.sanctions }),
      arrange: (h) => void (h.tap.beforeQuote = async (sent) => void (sent.dry === false && failing.fail())),
      after: (h, order) => expect(logged(h, "gas_order_failed")).toEqual([expect.objectContaining({ level: "error", order: hashId(order.id), kind: "TypeError" })]),
    },
    { name: "the disk has filled by the time it is made", reason: "busy", asked: 1, options: () => ({ diskFull: () => diskAsked++ >= 1 }) },
    { name: "the server holds as many open orders as it can once the swap is made", reason: "busy", asked: 1, options: () => ({ maxOpenOrders: 1 }) },
    { name: "the receiving address has had its orders for the hour", reason: "rate_limited", asked: 1, options: () => ({ limits: { orderPerRecipient: { max: 1, windowMs: HOUR } } }) },
    { name: "the visitor has made their orders for the day", reason: "rate_limited", asked: 1, options: () => ({ limits: { orderCreateDaily: { max: 1, windowMs: DAY } } }) },
    { name: "the visitor has used their attempts for the day", reason: "rate_limited", asked: 1, options: () => ({ limits: { orderAttemptDaily: { max: 1, windowMs: DAY } } }) },
    { name: "the visitor has asked the provider for their real orders of the day", reason: "rate_limited", asked: 1, options: () => ({ limits: { orderLiveDaily: { max: 1, windowMs: DAY } } }) },
    { name: "everyone together has made the orders of this minute", reason: "rate_limited", asked: 1, options: () => ({ limits: { orderCreateGlobal: { max: 1, windowMs: MINUTE } } }) },
    // A visitor on IPv6 is also counted by the wider network they are in, and so is each of their two orders.
    { name: "the visitor's wider network has made its orders for the day", reason: "rate_limited", asked: 1, ip: "2001:db8:5:1::7", options: () => ({ limits: { orderCreateDailyWide: { max: 1, windowMs: DAY } } }) },
    { name: "the visitor's wider network has used its attempts for the day", reason: "rate_limited", asked: 1, ip: "2001:db8:5:1::7", options: () => ({ limits: { orderAttemptDailyWide: { max: 1, windowMs: DAY } } }) },
    { name: "the visitor's wider network has asked the provider for its real orders of the day", reason: "rate_limited", asked: 1, ip: "2001:db8:5:1::7", options: () => ({ limits: { orderLiveDailyWide: { max: 1, windowMs: DAY } } }) },
    {
      name: "the visitor's orders keep being dropped because the price moved",
      reason: "rate_limited",
      asked: 1,
      options: () => ({ limits: { orderPriceMoved: { max: 1, windowMs: HOUR } } }),
      // The allowance is still there when the swap is made, and used up by the time the gas order is.
      arrange: (h) => void (h.tap.beforeQuote = async (sent) => void (sent.dry === false && h.limiters.orderPriceMoved.take("203.0.113.10"))),
    },
  ];

  it.each(stopped)("$name", async (how) => {
    const h = await start(how.options?.());
    await how.arrange?.(h);
    const from = how.ip === undefined ? {} : { ip: how.ip };
    const asked = askedFor(await gasFor(h, {}, from));
    const reply = await h.order({ ...PEOPLE, rewardsAddress: WHO.rewards, gas: how.gas?.(asked) ?? asked, requestId: "the-one-request-0123456789" }, from);

    // The swap is made, whole: an order like any other, waiting for its deposit.
    expect(reply.status).toBe(201);
    const order = asOrder(reply);
    const swap = record(h, order.id);
    expect(order).toMatchObject({ status: "waiting", depositsOpen: true, depositAddress: swap.depositAddress, amountIn: SWAP_AMOUNT, recipient: WHO.recipient, refundTo: WHO.refundTo, rewardsAddress: WHO.rewards, routing: "confidential", to: { id: ASSET.arbUsdc } });
    expect(swap).toMatchObject({ recipient: WHO.recipient, refundTo: WHO.refundTo, sender: WHO.sender, confidentiality: "basic", state: { status: "waiting" }, screening: { result: "clear" } });
    expect(h.poller.holds(order.id)).toBe(true);
    // And it is told, in one plain fact, that gas was not added. Its record says the same, for every later look.
    expect(order.gas).toEqual({ made: false });
    expect(swap.gas).toBe("not_made");
    expect((await read(h, order.id)).gas).toEqual({ made: false });
    // There is no gas order: no record, nothing tracked, and one order in the store.
    expect(h.store.get(gasIdOf(order.id))).toBeNull();
    expect(h.store.ids()).toEqual([order.id]);
    expect(h.poller.holds(gasIdOf(order.id))).toBe(false);
    expect(live(h)).toHaveLength(how.asked ?? 2);
    expect(live(h)[0]).toMatchObject({ destinationAsset: ASSET.arbUsdc });
    // Whatever was reserved for the gas order was given back: the receiving address has had one order, not two.
    expect(h.limiters.orderPerRecipient.remaining(recipientKey("arb", WHO.recipient))).toBe((how.options?.().limits?.orderPerRecipient?.max ?? LIMITS.orderPerRecipient.max) - 1);
    // The request's line in the access log is the swap's: made, and screened clear.
    expect(h.access.at(-1)).toMatchObject({ route: "order_read" });
    expect(h.access.find((entry) => entry.route === "order_create")).toMatchObject({ status: 201, order: hashId(order.id), screening: "clear" });

    // One line says that it was not made, and why in a fixed word: no address, and nothing of the provider's own words.
    expect(logged(h, "gas_not_made")).toEqual([expect.objectContaining({ level: "info", order: hashId(order.id), reason: how.reason })]);
    expect(Object.keys(logged(h, "gas_not_made")[0]!).sort()).toEqual(["event", "level", "order", "reason", "t"]);
    for (const line of h.logs) for (const value of [...Object.values(WHO), ...Object.values(ELSE), order.id, swap.depositAddress, "too low", "liquidity", "Minimum"]) expect(carries(line, value), `${value} in ${line}`).toBe(false);
    how.after?.(h, order);

    // A retry of the same request is answered with the same swap and the same fact, and makes nothing.
    const again = await h.order({ ...PEOPLE, rewardsAddress: WHO.rewards, gas: how.gas?.(asked) ?? asked, requestId: "the-one-request-0123456789", reviewed: { amountOut: swap.amountOut, minAmountOut: swap.minAmountOut, totalFeeBps: 20, routing: "confidential" } }, from);
    expect([again.status, again.body.id, again.body.gas]).toEqual([200, order.id, { made: false }]);
    expect(h.store.ids()).toEqual([order.id]);
    expect(live(h)).toHaveLength(how.asked ?? 2);
  });

  it("the visitor already has as many unpaid orders open as one may: the swap takes the last place, and the gas order is not made", async () => {
    const h = await start({ limits: WIDE });
    const reviewed = reviewedOf((await h.quote({ ...SWAP, amount: SWAP_AMOUNT })).body as QuoteView);
    for (let i = 0; i < MAX_UNPAID_PER_CLIENT - 1; i++) expect((await h.order({ ...PEOPLE, reviewed })).status).toBe(201);
    const order = asOrder(await pair(h));
    expect(order.gas).toEqual({ made: false });
    expect(logged(h, "gas_not_made")).toMatchObject([{ reason: "rate_limited" }]);
    expect(h.store.ids()).toHaveLength(MAX_UNPAID_PER_CLIENT);
    // And the next swap is refused as ever: the caps count every order, a gas order like any other.
    expect(outcome(await h.order({ ...PEOPLE, reviewed }))).toBe("rate_limited");

    // With room for one pair less a place: a gas order that is made takes a place of its own.
    const roomy = await start({ limits: WIDE });
    const numbers = reviewedOf((await roomy.quote({ ...SWAP, amount: SWAP_AMOUNT })).body as QuoteView);
    for (let i = 0; i < MAX_UNPAID_PER_CLIENT - 2; i++) expect((await roomy.order({ ...PEOPLE, reviewed: numbers })).status).toBe(201);
    expect(asOrder(await pair(roomy)).gas).toMatchObject({ made: true });
    expect(roomy.store.ids()).toHaveLength(MAX_UNPAID_PER_CLIENT);
    expect(outcome(await roomy.order({ ...PEOPLE, reviewed: numbers }))).toBe("rate_limited");
  });

  it("what stops the swap stops both: nothing is made, and the gas order is not tried", async () => {
    const h = await start({ limits: WIDE });
    const gas = askedFor(await gasFor(h));
    const swap = reviewedOf((await h.quote({ ...SWAP, amount: SWAP_AMOUNT })).body as QuoteView);
    // The swap's own reviewed numbers are what the swap is held to: a price worse than they say, and the person confirms again.
    const moved = await h.order({ ...PEOPLE, gas, reviewed: { ...swap, amountOut: (BigInt(swap.amountOut) * 2n).toString() } });
    expect(outcome(moved)).toBe("price_moved");
    // The fresh numbers to confirm are the swap's, never the gas order's.
    expect(moved.body.error.quote).toMatchObject({ from: ASSET.baseEth, to: ASSET.arbUsdc, amountIn: SWAP_AMOUNT });
    expect("gas" in moved.body.error).toBe(false);
    // The gas order's good numbers did not carry the swap, and the swap's did not carry the gas order (see the cases above).
    const badSignature = (data: Record<string, unknown>) => ((data.quoteRequest as Record<string, unknown>).dry === false ? { ...data, quote: { ...(data.quote as Record<string, unknown>), amountOut: "1" } } : data);
    h.tap.corruptResponse = badSignature;
    expect((await h.order({ ...PEOPLE, gas, reviewed: swap }, { ip: "198.51.100.2" })).status).toBe(502);
    h.tap.corruptResponse = null;
    expect((await h.order({ ...PEOPLE, gas, reviewed: swap, termsVersion: "an-older-version" }, { ip: "198.51.100.3" })).status).toBe(409);
    expect(h.store.ids()).toEqual([]);
    // Two real quotes were asked for, each for a swap, and none for a gas order.
    expect(live(h)).toMatchObject([{ destinationAsset: ASSET.arbUsdc }, { destinationAsset: ASSET.arbUsdc }]);
    expect(logged(h, "gas_not_made")).toEqual([]);
  });
});

describe("every limit counts each of the two orders", () => {
  it("a pair is two orders to the receiving address, two of the visitor's day, two attempts and two real orders asked of the provider", async () => {
    const h = await start();
    const order = asOrder(await pair(h));
    expect(order.gas).toMatchObject({ made: true });
    const ip = "203.0.113.10";
    expect(h.limiters.orderPerRecipient.remaining(recipientKey("arb", WHO.recipient))).toBe(LIMITS.orderPerRecipient.max - 2);
    expect(h.limiters.orderCreateDaily.remaining(ip)).toBe(LIMITS.orderCreateDaily.max - 2);
    expect(h.limiters.orderAttemptDaily.remaining(ip)).toBe(LIMITS.orderAttemptDaily.max - 2);
    expect(h.limiters.orderLiveDaily.remaining(ip)).toBe(LIMITS.orderLiveDaily.max - 2);
    expect(h.limiters.orderCreateGlobal.remaining("all")).toBe(LIMITS.orderCreateGlobal.max - 2);
    // One request for both: the count of requests a minute is of requests.
    expect(h.limiters.orderCreate.remaining(ip)).toBe(LIMITS.orderCreate.max - 1);
    expect(h.store.openCount()).toBe(2);
  });

  it("a receiving address that may have two orders in its hour has them in one pair, and a third order is refused", async () => {
    const h = await start({ limits: { orderPerRecipient: { max: 2, windowMs: HOUR } } });
    expect(asOrder(await pair(h)).gas).toMatchObject({ made: true });
    const third = await h.order({ ...PEOPLE }, { ip: "198.51.100.2" });
    expect([third.status, outcome(third)]).toEqual([429, "rate_limited"]);
    expect(h.store.ids()).toHaveLength(2);
    // Another receiving address has its own two: the swap to it, and that swap's gas order.
    expect(asOrder(await pair(h, { recipient: ELSE.recipient }, { ip: "198.51.100.3" })).gas).toMatchObject({ made: true, order: { recipient: ELSE.recipient } });
    expect(outcome(await h.order({ ...PEOPLE, recipient: ELSE.recipient }, { ip: "198.51.100.4" }))).toBe("rate_limited");
  });

  it("a gas order is made for the swap's own receiving address even when its preview was asked for another: the address is the swap's, and the provider signs for that", async () => {
    const h = await start();
    // Previewed with one receiving address, ordered with a swap to another: the numbers are the same, and the address is the swap's.
    const gas = askedFor(await gasFor(h, { recipient: ELSE.recipient }));
    const order = asOrder(await h.order({ ...PEOPLE, gas }));
    expect(order.gas).toMatchObject({ made: true, order: { recipient: WHO.recipient } });
    expect(record(h, gasIdOf(order.id)).recipient).toBe(WHO.recipient);
    expect(live(h).map((sent) => sent.recipient)).toEqual([WHO.recipient, WHO.recipient]);
  });
});

describe("a repeated request returns the same pair", () => {
  it("the same key again is answered with the first swap and its gas order as they stand, and makes nothing; the gas asked for is part of what a key is tied to", async () => {
    const h = await start();
    const gas = askedFor(await gasFor(h));
    const reviewed = reviewedOf((await h.quote({ ...SWAP, amount: SWAP_AMOUNT })).body as QuoteView);
    const body = { ...PEOPLE, gas, reviewed, requestId: "gas-retry-key-0123456789ab" };
    const first = await h.order(body);
    expect(first.status).toBe(201);
    const order = asOrder(first);
    const again = await h.order(body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(again.body.gas.order.id).toBe(gasIdOf(order.id));
    // Two real orders were asked of the provider, and two are stored: one pair.
    expect(live(h)).toHaveLength(2);
    expect(h.store.ids().sort()).toEqual([order.id, gasIdOf(order.id)].sort());

    // The same key for the same swap without gas, or with gas of another amount, is another request.
    const { gas: _gas, ...without } = body;
    const others: Record<string, unknown>[] = [without, { ...body, gas: { ...gas, amount: "1300000000000000" } }, { ...body, gas: null }];
    for (const other of others) {
      const reply = await h.order(other);
      expect([reply.status, outcome(reply)], JSON.stringify(other.gas ?? null)).toEqual([409, "conflict"]);
    }
    // And the other way round: a key that made a swap without gas never returns it for a request with gas.
    const plain = { ...without, requestId: "plain-retry-key-9876543210" };
    expect((await h.order(plain, { ip: "198.51.100.2" })).status).toBe(201);
    expect(outcome(await h.order({ ...plain, gas }, { ip: "198.51.100.2" }))).toBe("conflict");
    expect(h.store.ids()).toHaveLength(3);
    // The reviewed numbers of the gas are not part of the key: the same request sent again is the same request.
    const sameAgain = await h.order({ ...body, gas: { ...gas, reviewed: { ...gas.reviewed, amountOut: "1" } } });
    expect([sameAgain.status, sameAgain.body.id]).toEqual([200, order.id]);
  });

  it("a second request that arrives while the gas order is being made waits, and is answered with the pair: never with the swap before its gas order is known", async () => {
    const h = await start();
    const gas = askedFor(await gasFor(h));
    const reviewed = reviewedOf((await h.quote({ ...SWAP, amount: SWAP_AMOUNT })).body as QuoteView);
    const body = { ...PEOPLE, gas, reviewed, requestId: "double-click-9876543210-gas" };
    let held = false;
    let letThrough: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (letThrough = resolve));
    h.tap.beforeQuote = async (sent) => {
      if (sent.dry !== false || !isGasQuote(sent)) return;
      held = true;
      await gate;
    };
    const first = h.order(body);
    await eventually(() => held);
    // The swap is stored, and its gas order is at the provider.
    expect(h.store.ids()).toHaveLength(1);
    let answered = false;
    const second = h.order(body).finally(() => (answered = true));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(answered).toBe(false);
    letThrough();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body).toEqual(a.body);
    expect(a.body.gas).toMatchObject({ made: true, order: { id: gasIdOf(a.body.id) } });
    expect(h.store.ids()).toHaveLength(2);
    expect(live(h)).toHaveLength(2);
  });
});

describe("the swap's page is told of its gas order, and the gas order opens by its own ID", () => {
  it("a look at the swap shows the gas order as it moves: waiting, deposit seen, swapping, delivered; and each of the two stands alone", async () => {
    const h = await start();
    const order = asOrder(await pair(h));
    const gasId = gasIdOf(order.id);
    const added = record(h, gasId);
    const gasOf = async () => (await read(h, order.id)).gas as { made: true; order: OrderView };
    expect((await gasOf()).order).toMatchObject({ id: gasId, gasOrder: true, status: "waiting", depositAddress: added.depositAddress, depositsOpen: true });

    // Only the gas is paid: it arrives, and the swap goes on waiting.
    h.stub.control(added.depositAddress, "deposit");
    await step(h, gasId, 5000);
    expect((await gasOf()).order).toMatchObject({ status: "deposit_seen", depositProven: false });
    await step(h, gasId, 5000);
    expect((await gasOf()).order).toMatchObject({ status: "swapping", depositProven: true, depositAddress: null });
    await step(h, gasId, 15_000);
    const delivered = await read(h, order.id);
    expect(delivered).toMatchObject({ status: "waiting", depositsOpen: true, gas: { made: true, order: { id: gasId, gasOrder: true, status: "delivered", details: { amountOut: added.amountOut } } } });
    // The line is the gas order's own view, to the letter: what its own ID opens.
    const own = await read(h, gasId);
    expect((delivered.gas as { order: OrderView }).order).toEqual({ ...own, serverNow: delivered.serverNow });
    expect(own).toMatchObject({ id: gasId, gasOrder: true, status: "delivered", recipient: WHO.recipient, refundTo: WHO.refundTo, to: { id: ARB_ETH }, routing: "confidential" });
    expect("gas" in own).toBe(false);
    // The record of the swap never changed for it: the line is read from the gas order each time.
    expect(record(h, order.id)).toMatchObject({ gas: "made", state: { status: "waiting" } });
  });

  it("a gas order that is refunded, and one that runs out unpaid, are shown as that; the swap beside it is delivered all the same", async () => {
    const h = await start({ limits: WIDE });
    const refunded = asOrder(await pair(h));
    await refund(h, gasIdOf(refunded.id), record(h, gasIdOf(refunded.id)).depositAddress);
    expect((await read(h, refunded.id)).gas).toMatchObject({ made: true, order: { status: "refunded", details: { refundedAmount: GAS_AMOUNT } } });

    // Only the swap is paid: it is delivered, and the gas order runs out with nothing lost.
    const paid = asOrder(await pair(h, {}, { ip: "198.51.100.2" }));
    const gasId = gasIdOf(paid.id);
    await deliver(h, paid.id, paid.depositAddress!);
    expect(await read(h, paid.id)).toMatchObject({ status: "delivered", gas: { made: true, order: { status: "waiting" } } });
    h.clock.t = Date.parse(record(h, gasId).deadline) + EXPIRE_AFTER_DEADLINE_MS;
    await step(h, gasId, 1000);
    expect(await read(h, paid.id)).toMatchObject({ status: "delivered", gas: { made: true, order: { id: gasId, status: "expired", depositAddress: null, depositsOpen: false } } });
  });

  it("a look at the swap keeps the gas order's checks as prompt as a look at the gas order would: one that ran out is asked about again", async () => {
    const h = await start();
    const order = asOrder(await pair(h));
    const gasId = gasIdOf(order.id);
    const added = record(h, gasId);
    h.clock.t = Date.parse(added.deadline) + EXPIRE_AFTER_DEADLINE_MS;
    await step(h, gasId, 1000);
    await step(h, order.id, 1000);
    expect([record(h, order.id).state.status, record(h, gasId).state.status]).toEqual(["expired", "expired"]);
    const asked: string[] = [];
    h.tap.statusReply = (depositAddress) => {
      asked.push(depositAddress);
      return null;
    };
    await read(h, order.id);
    // Both were asked about: the swap by the look at it, and its gas order with it.
    await eventually(() => asked.includes(added.depositAddress) && asked.includes(record(h, order.id).depositAddress));
  });

  it("naming a deposit for the swap is answered with the swap and its gas line; named for the gas order by its own ID, with the gas order", async () => {
    const h = await start();
    const order = asOrder(await pair(h));
    const gasId = gasIdOf(order.id);
    const added = record(h, gasId);
    const session = await h.session();
    // The wallet's first transfer pays the swap, and its second pays the gas order: two plain transfers, each to its own address.
    putMined(h.rpc, txHash("swap deposit"), { from: WHO.sender, to: order.depositAddress, value: `0x${BigInt(SWAP_AMOUNT).toString(16)}`, input: "0x" });
    putMined(h.rpc, txHash("gas deposit"), { from: WHO.sender, to: added.depositAddress, value: `0x${BigInt(GAS_AMOUNT).toString(16)}`, input: "0x" });
    const forSwap = await h.post(`/api/orders/${order.id}/deposit`, { txHash: txHash("swap deposit") }, { session });
    expect(forSwap.status).toBe(200);
    expect(forSwap.body).toMatchObject({ id: order.id, depositTxHash: txHash("swap deposit"), depositProven: true, gas: { made: true, order: { id: gasId, gasOrder: true, status: "waiting", depositTxHash: null } } });
    // The same hash again: the answer that returns early keeps the line too.
    expect((await h.post(`/api/orders/${order.id}/deposit`, { txHash: txHash("swap deposit") }, { session })).body.gas).toMatchObject({ made: true, order: { id: gasId } });
    // A transfer that pays one of the two is not taken for the other's deposit.
    expect(outcome(await h.post(`/api/orders/${gasId}/deposit`, { txHash: txHash("swap deposit") }, { session }))).toBe("not_verified");
    const forGas = await h.post(`/api/orders/${gasId}/deposit`, { txHash: txHash("gas deposit") }, { session });
    expect(forGas.status).toBe(200);
    expect(forGas.body).toMatchObject({ id: gasId, gasOrder: true, depositTxHash: txHash("gas deposit"), depositProven: true });
    expect("gas" in forGas.body).toBe(false);
    expect((await read(h, order.id)).gas).toMatchObject({ made: true, order: { depositTxHash: txHash("gas deposit"), depositProven: true } });
  });

  it("a swap whose payer is on the sanctions list is kept, and its gas order is kept with it: made in Ghost mode, neither record is deleted at its end", async () => {
    const payer = address("listed payer");
    const h = await start({ sanctions: createStaticSanctions([payer], { now: () => NOON }) });
    const order = asOrder(await pair(h, { ghost: true }));
    const gasId = gasIdOf(order.id);
    const session = await h.session();
    // A transaction is named for the swap that a listed wallet paid. It is refused and the swap is marked; its gas order is marked with it.
    putMined(h.rpc, txHash("listed deposit"), { from: payer, to: order.depositAddress, value: `0x${BigInt(SWAP_AMOUNT).toString(16)}`, input: "0x" });
    expect((await h.post(`/api/orders/${order.id}/deposit`, { txHash: txHash("listed deposit") }, { session })).status).toBe(403);
    expect(record(h, order.id)).toMatchObject({ ghost: true, held: true });
    expect(record(h, gasId)).toMatchObject({ ghost: true, gasOrder: true, held: true });
    // The gas order is paid and delivered. A Ghost order's record would go at once; this one is kept, as its swap's is.
    await deliver(h, gasId, record(h, gasId).depositAddress);
    expect(record(h, gasId)).toMatchObject({ held: true, state: { status: "delivered" } });
    expect(h.store.wiped(gasId)).toBeNull();
  });

  it("a gas order whose own payer is on the list is kept by itself: it leads back to no swap, and the swap is left as it was", async () => {
    const payer = address("listed gas payer");
    const h = await start({ sanctions: createStaticSanctions([payer], { now: () => NOON }) });
    const order = asOrder(await pair(h));
    const gasId = gasIdOf(order.id);
    putMined(h.rpc, txHash("listed gas deposit"), { from: payer, to: record(h, gasId).depositAddress, value: `0x${BigInt(GAS_AMOUNT).toString(16)}`, input: "0x" });
    expect((await h.post(`/api/orders/${gasId}/deposit`, { txHash: txHash("listed gas deposit") }, { session: await h.session() })).status).toBe(403);
    expect(record(h, gasId)).toMatchObject({ gasOrder: true, held: true });
    expect(record(h, order.id).held).toBeUndefined();
    // Nothing was made or marked at the ID a gas order of the gas order would have.
    expect(h.store.get(gasIdOf(gasId))).toBeNull();
  });

  it("a gas order is never found by its deposit address: before it is paid, while it is under way and once it is delivered, its address is answered as an address that is no order's", async () => {
    const h = await start({ limits: { orderFind: ROOMY, orderFindDaily: ROOMY, orderMiss: ROOMY } });
    const order = asOrder(await pair(h));
    const gasId = gasIdOf(order.id);
    const added = record(h, gasId);
    const session = await h.session();
    const miss = await h.post("/api/track", { depositAddress: address("no order's") }, { session });
    expect([miss.status, miss.body]).toEqual([404, { error: { code: "not_found", message: "Not found." } }]);
    const sameAsAMiss = async (when: string) => {
      for (const spelling of [added.depositAddress, added.depositAddress.toLowerCase(), ` ${added.depositAddress} `]) {
        const reply = await h.post("/api/track", { depositAddress: spelling }, { session });
        expect([reply.status, reply.text], when).toEqual([miss.status, miss.text]);
      }
    };
    await sameAsAMiss("waiting");
    // The store knows whose address it is: the rule is the route's.
    expect(h.store.findByDeposit(added.depositAddress)?.id).toBe(gasId);
    h.stub.control(added.depositAddress, "deposit");
    await step(h, gasId, 5000);
    await step(h, gasId, 5000);
    await sameAsAMiss("swapping");
    await step(h, gasId, 15_000);
    expect(record(h, gasId).state.status).toBe("delivered");
    await sameAsAMiss("delivered");
    expect(h.access.filter((entry) => entry.route === "order_find").every((entry) => entry.status === 404 && entry.order === undefined)).toBe(true);

    // The rule is that it is privately routed, and it always is. An ordinary public order is found, on a server that routes in public.
    const publicly = await start({ env: { PRIVACY_MODE: "public" } });
    const ordinary = asOrder(await publicly.order({ ...PEOPLE }));
    expect((await publicly.post("/api/track", { depositAddress: ordinary.depositAddress }, { session: await publicly.session() })).body).toEqual({ id: ordinary.id });
  });

  it("once nothing is known of the gas order any more, the swap is told nothing of gas; and no order is told of a gas order it never asked for", async () => {
    const h = await start();
    const order = asOrder(await pair(h));
    const gasId = gasIdOf(order.id);
    // The gas order's record is deleted when its time is up, as any order's is. It was not made in Ghost mode, so nothing is kept of it.
    h.store.remove(gasId);
    const after = await read(h, order.id);
    expect("gas" in after).toBe(false);
    expect(after).toMatchObject({ id: order.id, status: "waiting" });
    expect(record(h, order.id).gas).toBe("made");

    // An order that asked for no gas is told of none, even if a record should stand where its gas order would.
    const plain = asOrder(await h.order({ ...PEOPLE }, { ip: "198.51.100.2" }));
    h.store.create({ ...record(h, plain.id), id: gasIdOf(plain.id), depositAddress: address("a stray deposit"), gasOrder: true });
    expect("gas" in (await read(h, plain.id))).toBe(false);
    // And a swap whose gas was made is shown only a gas order at that ID: any other record there is not its gas order.
    const third = asOrder(await pair(h, {}, { ip: "198.51.100.3" }));
    const real = record(h, gasIdOf(third.id));
    h.store.remove(real.id);
    const { gasOrder: _mark, ...unmarked } = real;
    h.store.create(unmarked);
    expect("gas" in (await read(h, third.id))).toBe(false);
  });
});

describe("the store marks a swap once with what came of its gas order", () => {
  it("noteGas writes the mark durably, the first time only, and never on a gas order or on an order that is not there", async () => {
    const h = await start();
    const order = asOrder(await h.order({ ...PEOPLE }));
    const file = path.join(h.dataDir, "orders", `${order.id}.json`);
    const before = record(h, order.id);
    expect("gas" in (JSON.parse(fs.readFileSync(file, "utf8")) as OrderRecord)).toBe(false);
    expect(h.store.noteGas(order.id, false)).toBe(true);
    expect((JSON.parse(fs.readFileSync(file, "utf8")) as OrderRecord).gas).toBe("not_made");
    // What was written once is never written over, either way.
    expect(h.store.noteGas(order.id, true)).toBe(false);
    expect(h.store.noteGas(order.id, false)).toBe(false);
    expect(record(h, order.id).gas).toBe("not_made");
    expect((JSON.parse(fs.readFileSync(file, "utf8")) as OrderRecord).gas).toBe("not_made");
    // Read again from the disk by a store started on the same folder.
    expect(createOrderStore(h.dataDir).get(order.id)?.gas).toBe("not_made");
    // The rest of the record is as it was.
    expect(record(h, order.id)).toEqual({ ...before, gas: "not_made" });

    const paired = asOrder(await pair(h, {}, { ip: "198.51.100.2" }));
    expect(record(h, paired.id).gas).toBe("made");
    expect(h.store.noteGas(paired.id, false)).toBe(false);
    // A gas order has no gas order of its own.
    expect(h.store.noteGas(gasIdOf(paired.id), true)).toBe(false);
    expect("gas" in record(h, gasIdOf(paired.id))).toBe(false);
    expect(h.store.noteGas("A".repeat(27), true)).toBe(false);
    expect(h.store.noteGas("not an id", true)).toBe(false);
  });

  it("a mark that cannot be written does not fail the swap: both orders are made, the answer says so, and the operator's log says the mark is missing", async () => {
    const h = await start();
    const noteGas = h.store.noteGas.bind(h.store);
    h.store.noteGas = () => {
      throw new Error(`the disk would not take ${WHO.recipient}`);
    };
    const reply = await pair(h);
    h.store.noteGas = noteGas;
    expect(reply.status).toBe(201);
    const order = asOrder(reply);
    expect(order.gas).toMatchObject({ made: true, order: { id: gasIdOf(order.id), status: "waiting" } });
    expect(h.store.ids()).toHaveLength(2);
    expect(logged(h, "gas_not_noted")).toEqual([expect.objectContaining({ level: "error", order: hashId(order.id), kind: "Error" })]);
    for (const line of h.logs) expect(carries(line, WHO.recipient)).toBe(false);
    // Without the mark the swap's later views say nothing of gas. The gas order is there, and opens by its own ID.
    expect("gas" in (await read(h, order.id))).toBe(false);
    expect(await read(h, gasIdOf(order.id))).toMatchObject({ gasOrder: true, status: "waiting", recipient: WHO.recipient });
  });

  it("the mark survives every later saving of the swap's state", async () => {
    const h = await start();
    const order = asOrder(await pair(h));
    await deliver(h, order.id, order.depositAddress!);
    expect(record(h, order.id)).toMatchObject({ gas: "made", statsCounted: true, state: { status: "delivered" } });
    expect((await read(h, order.id)).gas).toMatchObject({ made: true, order: { status: "waiting" } });
  });
});

describe("in Ghost mode both orders are Ghost orders, and the swap's one link leads to both until each is gone", () => {
  const SAID = "This order finished, and its record was deleted.";
  /** What an ID that is no order's has always been answered. */
  const NEVER = '{"error":{"code":"not_found","message":"Not found."}}';
  const orderFile = (h: Harness, id: string) => path.join(h.dataDir, "orders", `${id}.json`);
  const goneFile = (h: Harness, id: string) => path.join(h.dataDir, "ghost", "gone", sha(id));
  /** Writes over what is kept of a deleted order, leaving the day it is dated by as it was. */
  const rewrite = (h: Harness, id: string, content: string) => {
    fs.writeFileSync(goneFile(h, id), content);
    fs.utimesSync(goneFile(h, id), THAT_DAY / 1000, THAT_DAY / 1000);
  };
  const ghostPair = async (h: Harness, overrides: Record<string, unknown> = {}, opts: RequestOptions = {}) => asOrder(await pair(h, { ghost: true, ...overrides }, opts));

  it("both records carry the mark, both are asked of the provider with its tracing ID dropped, and both views say so", async () => {
    const h = await start();
    const order = await ghostPair(h);
    const gasId = gasIdOf(order.id);
    expect([record(h, order.id).ghost, record(h, gasId).ghost]).toEqual([true, true]);
    expect(record(h, gasId)).toMatchObject({ gasOrder: true, recipient: WHO.recipient, refundTo: WHO.refundTo, confidentiality: "basic" });
    expect(order).toMatchObject({ ghost: true, gas: { made: true, order: { id: gasId, ghost: true, gasOrder: true, status: "waiting" } } });
    expect(await read(h, gasId)).toMatchObject({ id: gasId, ghost: true, gasOrder: true });
    // The two previews, then the two real quotes: each real one with the provider's tracing ID dropped as its reply is read.
    expect(h.tap.quoteTracing).toEqual(["kept", "kept", "dropped", "dropped"]);
    // What the provider was asked says nothing of the mode, for either order.
    expect(JSON.stringify(h.tap.quotes)).not.toMatch(/ghost/i);
    // The request's line in the access log: the swap's hashed ID, and no tracing ID of either quote.
    const line = h.access.find((entry) => entry.route === "order_create")!;
    expect(line).toMatchObject({ status: 201, order: hashId(order.id), screening: "clear" });
    expect("cid" in line).toBe(false);

    // Not marked, neither is: the mode is the swap's, and the gas order is made as the swap is.
    const plain = asOrder(await pair(h, {}, { ip: "198.51.100.2" }));
    expect(["ghost" in record(h, plain.id), "ghost" in record(h, gasIdOf(plain.id))]).toEqual([false, false]);
    // And a Ghost swap whose gas order could not be made is a Ghost swap, told so in the same plain fact.
    const gas = askedFor(await gasFor(h));
    const alone = asOrder(await h.order({ ...PEOPLE, ghost: true, gas: { ...gas, amount: "1" } }, { ip: "198.51.100.3" }));
    expect(alone).toMatchObject({ ghost: true, gas: { made: false } });
    expect(record(h, alone.id)).toMatchObject({ ghost: true, gas: "not_made" });
  });

  it("the gas order's record is deleted the moment it is delivered or refunded, and the swap is then told the one word kept of how it ended", async () => {
    const h = await start({ limits: WIDE });
    for (const [i, ending] of (["delivered", "refunded"] as const).entries()) {
      const order = await ghostPair(h, {}, { ip: `198.51.100.${i + 1}` });
      const gasId = gasIdOf(order.id);
      const added = record(h, gasId);
      if (ending === "delivered") await deliver(h, gasId, added.depositAddress);
      else await refund(h, gasId, added.depositAddress);
      // Its record is gone, with its entry in the index of deposit addresses; one word is kept of it.
      expect(h.store.get(gasId), ending).toBeNull();
      expect(fs.existsSync(orderFile(h, gasId)), ending).toBe(false);
      expect(h.store.findByDeposit(added.depositAddress), ending).toBeNull();
      expect(fs.readFileSync(goneFile(h, gasId), "utf8"), ending).toBe(ending);
      expect(h.poller.holds(gasId), ending).toBe(false);
      // The swap's record is there, untouched, and its page is told how its gas order ended: the word, and nothing else of it.
      const shown = await read(h, order.id);
      expect(shown, ending).toMatchObject({ id: order.id, status: "waiting", ghost: true });
      expect(shown.gas, ending).toEqual({ made: true, order: null, ended: ending });
      for (const value of [gasId, added.depositAddress, added.amountOut]) expect(carries(JSON.stringify(shown.gas), value), ending).toBe(false);
      // The gas order's own ID is answered as any deleted Ghost order's is.
      const own = await h.get(`/api/orders/${gasId}`);
      expect([own.status, own.body], ending).toEqual([410, { error: { code: "order_deleted", message: SAID, detail: { ended: ending } } }]);
    }
  });

  it("the swap's record deleted first: its ID is answered 410 with the gas order as it stands, on a read and on a deposit sent in; once the gas order has gone too, with the word for how that ended; after 30 days, as an ID that never was", async () => {
    const h = await start();
    const order = await ghostPair(h);
    const gasId = gasIdOf(order.id);
    const added = record(h, gasId);
    await deliver(h, order.id, order.depositAddress!);
    expect([h.store.get(order.id), record(h, gasId).state.status]).toEqual([null, "waiting"]);

    // The one link still leads to the gas order: the swap is said to have finished, and the gas order is shown as an order.
    const reply = await h.get(`/api/orders/${order.id}`);
    expect(reply.status).toBe(410);
    expect(Object.keys(reply.body.error).sort()).toEqual(["code", "detail", "gas", "message"]);
    expect(reply.body.error).toMatchObject({ code: "order_deleted", message: SAID, detail: { ended: "delivered" } });
    expect(reply.body.error.gas).toEqual({ made: true, order: await read(h, gasId) });
    expect(reply.body.error.gas.order).toMatchObject({ id: gasId, ghost: true, gasOrder: true, status: "waiting", depositAddress: added.depositAddress, depositsOpen: true, recipient: WHO.recipient });
    // Of the swap itself, nothing but the word: no amount, no address of its own, no ID.
    const { gas: _gasLine, ...ofTheSwap } = reply.body.error as Record<string, unknown>;
    for (const value of [order.id, order.depositAddress!, order.amountOut, SWAP_AMOUNT]) expect(carries(JSON.stringify(ofTheSwap), value), value).toBe(false);
    // A deposit sent in for the swap is answered the same.
    const sent = await h.post(`/api/orders/${order.id}/deposit`, { txHash: txHash("too late") }, { session: await h.session() });
    expect([sent.status, sent.body.error.gas.order.id]).toEqual([410, gasId]);
    // The page may ask as often as any page does: that is no guess at an ID, and its line in the access log names no order.
    for (let i = 0; i < LIMITS.orderMiss.max + 3; i++) expect((await h.get(`/api/orders/${order.id}`)).status).toBe(410);
    const lines = h.access.filter((entry) => entry.status === 410);
    expect(lines.length).toBe(LIMITS.orderMiss.max + 5);
    expect(lines.every((entry) => entry.order === undefined && entry.cid === undefined)).toBe(true);
    // And the gas order goes on by itself: it is paid, and arrives.
    await deliver(h, gasId, added.depositAddress);
    expect(h.store.get(gasId)).toBeNull();

    // Both are gone: the swap's word, and its gas order's.
    const after = await h.get(`/api/orders/${order.id}`);
    expect(after.status).toBe(410);
    expect(after.text).toBe(`{"error":{"code":"order_deleted","message":"${SAID}","detail":{"ended":"delivered"},"gas":{"made":true,"order":null,"ended":"delivered"}}}`);
    // The gas order's own ID has no gas order of its own to tell of.
    expect((await h.get(`/api/orders/${gasId}`)).text).toBe(`{"error":{"code":"order_deleted","message":"${SAID}","detail":{"ended":"delivered"}}}`);
    expect(h.store.ids()).toEqual([]);

    // Thirty days on, nothing is known of either: both are IDs that never were.
    h.clock.t += WIPED_KEPT_MS;
    for (const id of [order.id, gasId]) {
      const late = await h.get(`/api/orders/${id}`, { ip: "198.51.100.9" });
      expect([late.status, late.text], id).toEqual([404, NEVER]);
    }
  });

  it("a Ghost order with no gas is answered exactly as before there was such a thing; a word that cannot be read is left out, of the swap or of its gas order, and nothing of the file is passed on", async () => {
    const h = await start({ limits: WIDE });
    // No gas was asked for: the 410 is the one it always was, to the letter.
    const alone = asOrder(await h.order({ ...PEOPLE, ghost: true }));
    await deliver(h, alone.id, alone.depositAddress!);
    expect((await h.get(`/api/orders/${alone.id}`)).text).toBe(`{"error":{"code":"order_deleted","message":"${SAID}","detail":{"ended":"delivered"}}}`);

    const order = await ghostPair(h, {}, { ip: "198.51.100.2" });
    const gasId = gasIdOf(order.id);
    await deliver(h, order.id, order.depositAddress!);
    // The swap's own word cannot be read: the answer goes without it, and still leads to the gas order.
    rewrite(h, order.id, `sent from ${WHO.sender}`);
    const unread = await h.get(`/api/orders/${order.id}`);
    expect(unread.status).toBe(410);
    expect(Object.keys(unread.body.error).sort()).toEqual(["code", "gas", "message"]);
    expect(unread.body.error.gas).toMatchObject({ made: true, order: { id: gasId, status: "waiting" } });
    rewrite(h, order.id, "delivered");

    await refund(h, gasId, record(h, gasId).depositAddress);
    expect((await h.get(`/api/orders/${order.id}`)).body.error.gas).toEqual({ made: true, order: null, ended: "refunded" });
    // The gas order's word cannot be read: nothing is said of gas at all, and nothing of what the file holds is passed on.
    for (const content of ["", "Refunded", "failed", "refunded\n", `{"ended":"refunded"}`, `to ${WHO.recipient}`, "x".repeat(5000)]) {
      rewrite(h, gasId, content);
      const reply = await h.get(`/api/orders/${order.id}`);
      expect([reply.status, reply.text], JSON.stringify(content.slice(0, 20))).toEqual([410, `{"error":{"code":"order_deleted","message":"${SAID}","detail":{"ended":"delivered"}}}`]);
    }
    for (const word of ["delivered", "refunded", "expired"] as const) {
      rewrite(h, gasId, word);
      expect((await h.get(`/api/orders/${order.id}`)).body.error.gas).toEqual({ made: true, order: null, ended: word });
    }
  });

  it("only a deleted Ghost swap's ID is told of a gas order: an ID that is no order's is told nothing, whatever stands at the ID worked out from it", async () => {
    const h = await start({ limits: WIDE });
    const order = await ghostPair(h);
    const template = record(h, gasIdOf(order.id));
    // An ID that never was an order's, with a live gas order's record standing where its gas order would be.
    const neverWas = "N".repeat(27);
    h.store.create({ ...template, id: gasIdOf(neverWas), depositAddress: address("a stray deposit") });
    const reply = await h.get(`/api/orders/${neverWas}`, { ip: "198.51.100.40" });
    expect([reply.status, reply.text]).toEqual([404, NEVER]);
    // The same with only the word of a finished one there.
    const other = "M".repeat(27);
    fs.writeFileSync(goneFile(h, gasIdOf(other)), "delivered");
    fs.utimesSync(goneFile(h, gasIdOf(other)), THAT_DAY / 1000, THAT_DAY / 1000);
    expect((await h.get(`/api/orders/${other}`, { ip: "198.51.100.40" })).text).toBe(NEVER);
    // And it is counted as the guess it is.
    const guesses: number[] = [];
    for (let i = 0; i <= LIMITS.orderMiss.max; i++) guesses.push((await h.get(`/api/orders/${neverWas}`, { ip: "198.51.100.41" })).status);
    expect(guesses).toEqual([...Array<number>(LIMITS.orderMiss.max).fill(404), 429]);

    // A swap that was not made in Ghost mode leaves nothing behind when its record goes, and its ID is then no order's: its gas order is opened by its own ID alone.
    const plain = asOrder(await pair(h, {}, { ip: "198.51.100.2" }));
    h.store.remove(plain.id);
    const removed = await h.get(`/api/orders/${plain.id}`, { ip: "198.51.100.42" });
    expect([removed.status, removed.text]).toEqual([404, NEVER]);
    expect((await read(h, gasIdOf(plain.id))).gasOrder).toBe(true);
  });
});

describe("practice mode offers the switch: the practice provider answers a gas order's private preview and its private order", () => {
  it("a private quote of a gas order's size is made up by the practice provider itself, as a preview and as an order, and is never sent on to the real provider", async () => {
    const passedOn: Array<Record<string, unknown>> = [];
    const upstream = {
      tokens: async () => ({ ok: true as const, status: 200, data: FIXTURE_TOKENS }),
      quote: async (sent: Record<string, unknown>) => {
        passedOn.push(sent);
        return { ok: false as const, kind: "unavailable" as const, status: 401 };
      },
      status: async () => ({ ok: false as const, kind: "unavailable" as const, status: null }),
      submitDeposit: async () => ({ ok: false as const, kind: "unavailable" as const, status: null }),
      health: () => ({ degraded: false, errorRate: 0, calls: 0 }),
    };
    const practice = createStubProvider({ upstream, now: () => NOON });
    await practice.provider.tokens();
    const asked = { swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: ASSET.baseEth, depositType: "ORIGIN_CHAIN", destinationAsset: ARB_ETH, amount: GAS_AMOUNT, recipient: WHO.recipient, recipientType: "DESTINATION_CHAIN", refundTo: WHO.refundTo, refundType: "ORIGIN_CHAIN", deadline: new Date(NOON + 30 * MINUTE).toISOString(), quoteWaitingTimeMs: 3000, referral: "intentswap", confidentiality: "basic" };
    // Three dollars of ETH for ETH on another chain, in private: answered, with the provider's own fee and nothing of ours.
    const preview = await practice.provider.quote({ ...asked, dry: true });
    expect(preview).toMatchObject({ ok: true, data: { quote: { amountIn: GAS_AMOUNT, amountInUsd: "3" }, quoteRequest: { dry: true, confidentiality: "basic", recipient: WHO.recipient, appFees: [{ fee: 20 }] } } });
    const order = await practice.provider.quote({ ...asked, dry: false }, "order");
    expect(order).toMatchObject({ ok: true, data: { quote: { amountIn: GAS_AMOUNT, depositAddress: expect.stringMatching(/^0x[0-9a-f]{40}$/) }, quoteRequest: { dry: false, confidentiality: "basic" } } });
    // The other sizes, and a dollar coin paying.
    for (const [destinationAsset, amount] of [[ETH_ETH, "2000000000000000"], [TRX, "4000000000000000"], [ASSET.sol, GAS_AMOUNT]] as const) expect((await practice.provider.quote({ ...asked, dry: true, destinationAsset, amount })).ok, destinationAsset).toBe(true);
    expect((await practice.provider.quote({ ...asked, dry: true, originAsset: ASSET.baseUsdc, amount: "3000000" })).ok).toBe(true);
    expect(passedOn).toEqual([]);
    // What it refuses, it still refuses: an amount worth less than ten cents has no route, at any level.
    expect(await practice.provider.quote({ ...asked, dry: true, amount: "30000000000000" })).toMatchObject({ ok: false, kind: "rejected", message: "No liquidity available" });
  });

  it("on a practice server that routes privately, gas is offered, the pair is made, and each of the two is moved along by its own practice control", async () => {
    const h = await start({ practice: true });
    expect((await h.get("/api/config")).body).toMatchObject({ practice: true, privacyMode: "basic" });
    const order = asOrder(await pair(h));
    const gasId = gasIdOf(order.id);
    expect(order.gas).toMatchObject({ made: true, order: { id: gasId, status: "waiting" } });
    // The practice control is given the gas order's own ID: it is an order like any other.
    expect((await h.post(`/api/practice/${gasId}`, { action: "deposit" })).body).toEqual({ ok: true });
    await h.poller.tick();
    expect(await read(h, order.id)).toMatchObject({ status: "waiting", gas: { made: true, order: { status: "deposit_seen" } } });
    h.clock.t += 25_000;
    h.poller.nudge(gasId);
    await h.poller.tick();
    expect(await read(h, order.id)).toMatchObject({ status: "waiting", gas: { made: true, order: { status: "delivered" } } });
    // And where the practice provider refuses private routing (any pair that delivers on Zcash), there is nothing to offer: no token is received there.
    expect((await askGas(h, { to: ASSET.zec, recipient: undefined, pay: "manual", sender: undefined })).body.gas).toBeNull();
  });
});
