import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAddress } from "../shared/addresses.ts";
import { isRouting, routingOf, TERMS_VERSION, type OrderView, type QuoteView } from "../shared/api.ts";
import { swapPointsMicro } from "../shared/rewards.ts";
import { orderDiffers } from "../web/src/lib/swap-logic.ts";
import { toOrderView } from "../server/app.ts";
import { createStaticGeo } from "../server/geo.ts";
import type { UpstreamResult } from "../server/oneclick.ts";
import { isFunded } from "../server/poller.ts";
import { loadStaticSite } from "../server/static.ts";
import { LIMITS, MAX_HASH_SUBMISSIONS, MAX_OPEN_ORDERS, MAX_UNPAID_PER_CLIENT, MAX_UNPAID_PER_NETWORK, openOrderCap } from "../server/ratelimit.ts";
import { silentLogger } from "../server/log.ts";
import { createSanctions, createStaticSanctions } from "../server/sanctions.ts";
import { isPlaceholder, placeholderFor } from "../server/placeholders.ts";
import { createOrderStore, type OrderRecord } from "../server/store.ts";
import { ADDR, asOrder, ASSET, FIXTURE_TOKENS, harness, outcome, sentTogether, type Harness, type HarnessOptions } from "./helpers.ts";

let open: Harness[] = [];
async function start(options: HarnessOptions = {}): Promise<Harness> {
  const h = await harness(options);
  open.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(open.map((h) => h.close()));
  open = [];
});

const QUOTE = { from: ASSET.baseEth, to: ASSET.arbUsdc, amount: "5000000000000000", pay: "wallet" };
/**
 * IntentSwap takes no fee unless the server is set to, and these tests run that way. The tests of
 * what happens to a fee that is set start their server with these: 40 on a public swap (the
 * provider keeps half) and 20 on a private one (the provider adds its own beside it).
 */
const FEES = { FEE_BPS: "40", FEE_BPS_PRIVATE: "20" };

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const topicWord = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
/** A token's own record of a transfer, as it appears in a receipt. */
const transferRecord = (token: string, from: string, to: string, amount: bigint) => ({ address: token, topics: [TRANSFER_TOPIC, topicWord(from), topicWord(to)], data: `0x${amount.toString(16).padStart(64, "0")}` });
/** Puts a transaction on the fake chain as mined and successful. Without this a transaction is only pending. */
function mine(h: Harness, hash: string, tx: Record<string, unknown>, logs: unknown[] = []): void {
  h.rpc.txs.set(hash, tx);
  h.rpc.receipts.set(hash, { status: "0x1", logs });
}

describe("security headers and HTTP rules", () => {
  it("sends the security headers on every response", async () => {
    const h = await start();
    for (const reply of [await h.get("/api/status"), await h.get("/api/nope"), await h.get("/"), await h.post("/api/quote", {}, { session: null })]) {
      const csp = reply.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      // Inline styles are allowed, for the wallet window. Inline scripts never are.
      const scripts = csp.split("; ").find((part) => part.startsWith("script-src ")) ?? "";
      expect(scripts).not.toContain("unsafe-inline");
      expect(csp.replace("style-src 'self' 'unsafe-inline'", "")).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
      expect(reply.headers.get("x-frame-options")).toBe("DENY");
      expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
      expect(reply.headers.get("strict-transport-security")).toMatch(/max-age=\d{8}/);
      expect(reply.headers.get("referrer-policy")).toBe("no-referrer");
      expect(reply.headers.get("permissions-policy")).toContain("camera=()");
    }
  });

  it("marks API responses as never cached and never indexed", async () => {
    const h = await start();
    for (const pathname of ["/api/status", "/api/config", "/api/tokens", "/api/orders/unknown"]) {
      const reply = await h.get(pathname);
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(reply.headers.get("x-robots-tag")).toBe("noindex");
    }
  });

  it("sends no CORS headers and no cookies, even to another origin", async () => {
    const h = await start();
    const reply = await h.get("/api/config", { origin: "https://evil.example" });
    for (const name of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-headers", "set-cookie"]) {
      expect(reply.headers.get(name)).toBeNull();
    }
    const preflight = await fetch(`${h.url}/api/quote`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST", "x-forwarded-for": "203.0.113.10" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.status).toBeGreaterThanOrEqual(400);
  });

  it("accepts JSON only, with small bodies", async () => {
    const h = await start();
    const session = await h.session();
    expect((await h.post("/api/quote", QUOTE, { session, contentType: "text/plain" })).status).toBe(415);
    expect((await h.post("/api/quote", null, { session, rawBody: "{not json" })).status).toBe(400);
    const big = await h.post("/api/quote", { ...QUOTE, padding: "x".repeat(5000) }, { session });
    expect(big.status).toBe(413);
    expect((await h.post("/api/quote", null, { session, rawBody: "[1,2,3]" })).status).toBe(400);
  });

  it("answers unknown API paths and wrong methods with plain errors", async () => {
    const h = await start();
    const missing = await h.get("/api/does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
    expect((await h.post("/api/status", {})).status).toBe(405);
    expect((await h.get("/api/quote")).status).toBe(405);
  });

  it("answers something it did not expect with one fixed sentence: no stack, no inner message, in the reply or in the log", async () => {
    const h = await start();
    // The order store fails in a way nothing plans for, with a telling message.
    const telling = "ENOSPC at /srv/secret/path: provider said {\"apiKey\":\"abc\"}";
    h.store.get = () => {
      throw new Error(telling);
    };
    const reply = await h.get(`/api/orders/${"A".repeat(27)}`);
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ error: { code: "unavailable", message: "Something went wrong. Try again." } });
    expect(reply.text).not.toMatch(/ENOSPC|secret|apiKey|at .*\.ts|Error:/);
    const logged = h.logs.join("\n");
    expect(logged).toContain("unhandled");
    expect(logged).not.toMatch(/ENOSPC|secret\/path|apiKey/);
  });

  it("never reveals a secret in any response or log", async () => {
    const key = "aaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc";
    const rpcSecret = "https://rpc.example/v2/SUPER-SECRET-RPC-KEY";
    const hook = "https://hooks.example/services/SECRET-HOOK";
    const h = await start({ env: { ...FEES, ONECLICK_API_KEY: key, BASE_RPC_URL: rpcSecret, ALERT_WEBHOOK_URL: hook } });
    const feeRecipient = h.config.feeRecipient;
    if (feeRecipient === null) throw new Error("a fee is set, so there is a fee recipient");
    const order = asOrder(await h.order());
    const replies = [
      await h.get("/api/config"),
      await h.get("/api/status"),
      await h.get("/api/tokens"),
      await h.quote(QUOTE),
      await h.get(`/api/orders/${order.id}`),
      await h.get("/api/orders/nope"),
      await h.post("/api/rpc/base", { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { session: await h.session() }),
    ];
    const everything = replies.map((r) => r.text + JSON.stringify([...r.headers.entries()])).join("\n") + h.logs.join("\n") + JSON.stringify(h.access);
    for (const secret of [key, "SUPER-SECRET-RPC-KEY", "rpc.example", "SECRET-HOOK", feeRecipient]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("keeps wallet addresses, bodies and full IPs out of the logs", async () => {
    const h = await start();
    const order = asOrder(await h.order({}, { ip: "198.51.100.77" }));
    await h.get(`/api/orders/${order.id}`, { ip: "198.51.100.77" });
    const logged = h.logs.join("\n") + JSON.stringify(h.access);
    for (const leak of [ADDR.evm, ADDR.evm2, ADDR.evm.toLowerCase(), order.depositAddress!, order.id, "198.51.100.77"]) {
      expect(logged).not.toContain(leak);
    }
    const entry = h.access.find((e) => e.route === "order_create");
    expect(entry).toMatchObject({ status: 201, ip: "198.51.100.0", screening: "clear" });
    expect(entry?.order).toMatch(/^[0-9a-f]{12}$/);
    expect(entry?.cid).toBeTruthy();
  });
});

describe("GET /api/config, /api/status, /api/tokens", () => {
  it("returns the public settings and a session token", async () => {
    const h = await start({ env: { X_URL: "https://x.com/intentswap", GITHUB_URL: "https://github.com/intentswap/intentswap", SUPPORT_CONTACT: "help@example.org" } });
    const { body } = await h.get("/api/config");
    expect(body).toMatchObject({
      paused: false,
      practice: false,
      // How the server routes swaps. These tests run in public unless one says otherwise.
      privacyMode: "public",
      reownProjectId: "c0d68cdb58343fb95145440afe216c42",
      tokenAddress: null,
      tokenPairAddress: null,
      reserveAddress: null,
      sampleOrders: [],
      xUrl: "https://x.com/intentswap",
      // The three links behind the header's icons: one that is set travels as it was set, one that is not as the address it starts with.
      githubUrl: "https://github.com/intentswap/intentswap",
      dexscreenerUrl: "https://dexscreener.com/",
      supportContact: "help@example.org",
      // The site's own address: none here, where none is set and the server is not the live one.
      siteUrl: null,
      // Whether visitors are refused by where they are (the harness switches it on; a server told nothing has it off).
      regionBlock: true,
      // The Stats page is there unless the server is told otherwise.
      statsPage: true,
      termsVersion: TERMS_VERSION,
    });
    expect(Object.keys(body).sort()).toEqual(
      ["dexscreenerUrl", "githubUrl", "paused", "practice", "privacyMode", "regionBlock", "reownProjectId", "reserveAddress", "sampleOrders", "serverNow", "session", "sessionExpiresAt", "siteUrl", "statsPage", "supportContact", "termsVersion", "testPages", "tokenAddress", "tokenPairAddress", "xUrl"].sort(),
    );
    // Neither the fee setting nor where the fee is paid is among them. The fee a person is shown comes
    // from a quote, because the setting alone does not say what is charged.
    expect(JSON.stringify(body)).not.toMatch(/feeBps|feeRecipient|0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/i);
    expect(JSON.stringify((await (await start({ env: { FEE_BPS: "60" } })).get("/api/config")).body)).not.toMatch(/feeBps|"60"|:60[,}]/);
    // The page of component states exists outside production only.
    expect(body.testPages).toBe(true);
    const live = await start({ env: { NODE_ENV: "production", TRUST_PROXY_HOPS: "1", FEE_RECIPIENT: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", SWAPS_PAUSED: "false", SUPPORT_CONTACT: "help@intentswap.example" } });
    expect((await live.get("/api/config")).body.testPages).toBe(false);
    expect(Date.parse(body.serverNow)).toBe(h.clock.t);
  });

  it("lists coins trimmed for the interface", async () => {
    const h = await start();
    const { body, status } = await h.get("/api/tokens");
    expect(status).toBe(200);
    const eth = body.tokens.find((t: { id: string }) => t.id === ASSET.baseEth);
    expect(eth).toEqual({ id: ASSET.baseEth, symbol: "ETH", name: "Ethereum", chain: "base", decimals: 18, price: "2500", contract: null, wallet: true });
    expect(Object.keys(body.tokens[0]).sort()).toEqual(["chain", "contract", "decimals", "id", "name", "price", "symbol", "wallet"]);
    expect(body.tokens.some((t: { symbol: string }) => t.symbol.includes("DEPRECATED"))).toBe(false);
  });

  it("reports degraded while the provider keeps failing, and ok again when it recovers", async () => {
    const h = await start();
    expect((await h.get("/api/status")).body).toEqual({ status: "ok", serverNow: new Date(h.clock.t).toISOString() });
    h.tap.degraded = true;
    expect((await h.get("/api/status")).body.status).toBe("degraded");
    h.tap.degraded = false;
    expect((await h.get("/api/status")).body.status).toBe("ok");
    // Paused wins over degraded: the kill switch is the more important fact.
    const paused = await start({ env: { SWAPS_PAUSED: "true" } });
    paused.tap.degraded = true;
    expect((await paused.get("/api/status")).body.status).toBe("paused");
  });

  it("reports ok, and paused when the kill switch is on", async () => {
    const live = await start();
    expect((await live.get("/api/status")).body.status).toBe("ok");
    const paused = await start({ env: { SWAPS_PAUSED: "true" } });
    expect((await paused.get("/api/status")).body.status).toBe("paused");
    expect((await paused.get("/api/config")).body.paused).toBe(true);
  });
});

describe("POST /api/quote", () => {
  it("returns verified numbers with fees taken from the provider's echo", async () => {
    const h = await start();
    const reply = await h.quote(QUOTE);
    expect(reply.status).toBe(200);
    const q = reply.body as QuoteView;
    expect(q.amountIn).toBe("5000000000000000");
    // No fee of IntentSwap's, and the provider's own, as its echo held it.
    expect(q.fees).toEqual({ appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "10000000000000" });
    // Where a fee is set, the echo holds our share of it beside the provider's.
    const charging = await start({ env: FEES });
    expect(((await charging.quote(QUOTE)).body as QuoteView).fees).toEqual({ appBps: 20, providerBps: 20, appAmount: "10000000000000", providerAmount: "10000000000000" });
    expect(BigInt(q.minAmountOut)).toBeLessThanOrEqual(BigInt(q.amountOut));
    expect(q.slippageBps).toBe(100);
    expect(q.timeEstimate).toBe(30);
  });

  it("takes a slippage limit from the person, within fixed bounds, and nothing else about the price", async () => {
    const h = await start();
    // Half a percent: sent to the provider, echoed in the view, and the minimum is worked out from it.
    const tight = (await h.quote({ ...QUOTE, slippageBps: 50 })).body as QuoteView;
    expect(h.tap.quotes.at(-1)!.slippageTolerance).toBe(50);
    expect(tight.slippageBps).toBe(50);
    expect(BigInt(tight.minAmountOut)).toBe((BigInt(tight.amountOut) * 9950n) / 10_000n);
    const loose = (await h.quote({ ...QUOTE, slippageBps: 300 })).body as QuoteView;
    expect(loose.slippageBps).toBe(300);
    expect(BigInt(loose.minAmountOut)).toBeLessThan(BigInt(tight.minAmountOut));
    // The bounds themselves are allowed; anything outside them, or not a whole number, is refused.
    for (const ok of [10, 500]) expect((await h.quote({ ...QUOTE, slippageBps: ok })).status, String(ok)).toBe(200);
    const before = h.tap.quotes.length;
    for (const bad of [0, 9, 501, 5000, -100, 1.5, "100", null, Number.NaN, [100]]) {
      const reply = await h.quote({ ...QUOTE, slippageBps: bad });
      expect(reply.status, JSON.stringify(bad)).toBe(400);
      expect(reply.body.error.code).toBe("bad_request");
    }
    // A refused limit never reaches the provider.
    expect(h.tap.quotes.length).toBe(before);
  });

  it("keeps the slippage limit that was reviewed on the order it makes", async () => {
    const h = await start();
    const order = asOrder(await h.order({ slippageBps: 200 }));
    expect(order.slippageBps).toBe(200);
    expect(h.tap.quotes.at(-1)).toMatchObject({ dry: false, slippageTolerance: 200 });
    expect(h.store.get(order.id)?.slippageBps).toBe(200);
    // Left out: the usual one percent.
    const usual = asOrder(await h.order({ recipient: ADDR.evm3 }));
    expect(usual.slippageBps).toBe(100);
  });

  it("makes no order when the limit asked for is looser than the one that was reviewed", async () => {
    const h = await start();
    // Reviewed at one percent; the order request asks for five. The minimum would be lower than the one the person saw.
    const preview = (await h.quote({ ...QUOTE, sender: ADDR.evm, recipient: ADDR.evm2, refundTo: ADDR.evm })).body as QuoteView;
    const reviewed = { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: preview.fees.appBps + preview.fees.providerBps };
    const reply = await h.order({ slippageBps: 500, reviewed });
    expect(reply.body.error.code).toBe("price_moved");
    expect(h.store.open()).toHaveLength(0);
    // The same limit as reviewed goes through.
    expect(asOrder(await h.order({ slippageBps: 100, reviewed })).slippageBps).toBe(100);
  });

  it("sets the fee, the fee recipient and every provider field on the server", async () => {
    const h = await start({ env: { FEE_BPS: "60", FEE_RECIPIENT: ADDR.evm3 } });
    const reply = await h.quote({
      ...QUOTE,
      // Everything below is hostile input a browser might try. None of it may reach the provider.
      appFees: [{ recipient: ADDR.evm2, fee: 0 }],
      fee: 0,
      feeBps: 0,
      feeRecipient: ADDR.evm2,
      depositAddress: ADDR.evm2,
      dry: false,
      slippageTolerance: 5000,
      referral: "someone-else",
      deadline: "2099-01-01T00:00:00.000Z",
      swapType: "EXACT_OUTPUT",
      confidentiality: "advanced",
    });
    expect(reply.status).toBe(200);
    const sent = h.tap.quotes.at(-1)!;
    expect(sent.appFees).toEqual([{ recipient: ADDR.evm3.toLowerCase(), fee: 60 }]);
    expect(sent.dry).toBe(true);
    expect(sent.slippageTolerance).toBe(100);
    expect(sent.referral).toBe("intentswap");
    expect(sent.swapType).toBe("EXACT_INPUT");
    expect(sent.deadline).toBe(new Date(h.clock.t + 30 * 60_000).toISOString());
    expect(Object.keys(sent)).not.toContain("depositAddress");
    // The routing level is the server's own setting (public in these tests), whatever the request named.
    expect(sent.confidentiality).toBe("public");
    expect((reply.body as QuoteView).fees.appBps).toBe(30);
    // The whole of what is sent, field for field: a preview, and then an order.
    expect(sent).toEqual({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ASSET.baseEth,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: ASSET.arbUsdc,
      amount: QUOTE.amount,
      recipient: placeholderFor("arb"),
      recipientType: "DESTINATION_CHAIN",
      refundTo: placeholderFor("base"),
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(h.clock.t + 30 * 60_000).toISOString(),
      quoteWaitingTimeMs: 3000,
      referral: "intentswap",
      confidentiality: "public",
      appFees: [{ recipient: ADDR.evm3.toLowerCase(), fee: 60 }],
    });
    const made = await h.order({ depositType: "INTENTS", recipientType: "INTENTS", refundType: "INTENTS", quoteWaitingTimeMs: 0, destinationAsset: ASSET.sol });
    expect(made.status).toBe(201);
    expect(h.tap.quotes.at(-1)).toEqual({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ASSET.baseEth,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: ASSET.arbUsdc,
      amount: QUOTE.amount,
      recipient: ADDR.evm2,
      recipientType: "DESTINATION_CHAIN",
      refundTo: ADDR.evm,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(h.clock.t + 30 * 60_000).toISOString(),
      quoteWaitingTimeMs: 3000,
      referral: "intentswap",
      confidentiality: "public",
      connectedWallets: [ADDR.evm],
      appFees: [{ recipient: ADDR.evm3.toLowerCase(), fee: 60 }],
    });
  });

  it("uses a preview stand-in until the person gives an address, and their own address after", async () => {
    const h = await start();
    await h.quote({ ...QUOTE, pay: "manual" });
    let sent = h.tap.quotes.at(-1)!;
    expect(sent.recipient).toBe(placeholderFor("arb"));
    expect(sent.refundTo).toBe(placeholderFor("base"));
    expect(sent.deadline).toBe(new Date(h.clock.t + 60 * 60_000).toISOString());

    await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm.toLowerCase() });
    sent = h.tap.quotes.at(-1)!;
    expect(sent.recipient).toBe(ADDR.evm2);
    expect(sent.refundTo).toBe(ADDR.evm);
    expect(sent.connectedWallets).toEqual([ADDR.evm]);
  });

  it("gives slow chains a 2 hour deadline and Stellar deposits a memo", async () => {
    const h = await start();
    await h.quote({ from: ASSET.btc, to: ASSET.arbUsdc, amount: "1000000", pay: "manual" });
    expect(h.tap.quotes.at(-1)!.deadline).toBe(new Date(h.clock.t + 120 * 60_000).toISOString());
    expect(h.tap.quotes.at(-1)!.depositMode).toBeUndefined();
    await h.quote({ from: ASSET.xlm, to: ASSET.arbUsdc, amount: "1000000000", pay: "manual" });
    expect(h.tap.quotes.at(-1)!.depositMode).toBe("MEMO");
  });

  const invalid: Array<[string, Record<string, unknown>, number, string]> = [
    ["an unknown coin", { ...QUOTE, to: "nep141:fake.near" }, 400, "invalid_asset"],
    ["the same coin twice", { ...QUOTE, to: QUOTE.from }, 400, "invalid_asset"],
    ["a missing coin", { ...QUOTE, from: undefined }, 400, "invalid_asset"],
    ["a zero amount", { ...QUOTE, amount: "0" }, 400, "invalid_amount"],
    ["a decimal amount", { ...QUOTE, amount: "0.5" }, 400, "invalid_amount"],
    ["a negative amount", { ...QUOTE, amount: "-5" }, 400, "invalid_amount"],
    ["a numeric amount", { ...QUOTE, amount: 5000000000000000 }, 400, "invalid_amount"],
    ["an exponent amount", { ...QUOTE, amount: "1e18" }, 400, "invalid_amount"],
    ["an amount above 10^30", { ...QUOTE, amount: "1" + "0".repeat(31) }, 400, "too_large"],
    ["more than $1,000,000", { ...QUOTE, amount: "500000000000000000000" }, 400, "too_large"],
    ["no payment method", { ...QUOTE, pay: "card" }, 400, "bad_request"],
    ["wallet payment of a coin outside the allowlist", { from: ASSET.pepe, to: ASSET.arbUsdc, amount: "1000000000000000000000000", pay: "wallet" }, 400, "invalid_asset"],
    ["wallet payment from a chain without wallet support", { from: ASSET.sol, to: ASSET.arbUsdc, amount: "1000000000", pay: "wallet" }, 400, "invalid_asset"],
    ["a recipient on the wrong chain", { ...QUOTE, recipient: ADDR.sol }, 400, "invalid_recipient"],
    ["a mistyped recipient", { ...QUOTE, recipient: ADDR.evm.replace("d8dA", "D8dA") }, 400, "invalid_recipient"],
    ["a refund address on the wrong chain", { ...QUOTE, refundTo: ADDR.sol }, 400, "invalid_refund"],
    ["a sender on the wrong chain", { ...QUOTE, sender: ADDR.btc }, 400, "invalid_sender"],
    ["a shielded Zcash recipient", { from: ASSET.baseEth, to: ASSET.zec, amount: "5000000000000000", pay: "wallet", recipient: "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly" }, 400, "invalid_recipient"],
    ["an XRP address that carries a tag", { from: ASSET.baseEth, to: ASSET.xrp, amount: "5000000000000000", pay: "wallet", recipient: "X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ" }, 400, "invalid_recipient"],
  ];
  it.each(invalid)("rejects %s", async (_label, body, status, code) => {
    const h = await start();
    const reply = await h.quote(body);
    expect(reply.status).toBe(status);
    expect(reply.body.error.code).toBe(code);
    expect(h.tap.quotes).toHaveLength(0);
  });

  it("refuses more than 10^30 of a coin's smallest unit, whatever the coin is worth", async () => {
    const h = await start();
    // A coin priced so low that 10^30 of its smallest unit comes to a hundred dollars: the dollar limit
    // does not refuse it, so only the limit on the number itself can.
    h.tap.tokensResult = { ok: true, status: 200, data: (FIXTURE_TOKENS as Array<Record<string, unknown>>).map((t) => (t.assetId === ASSET.pepe ? { ...t, price: 1e-10 } : t)) };
    const body = { from: ASSET.pepe, to: ASSET.arbUsdc, pay: "manual" };
    const over = await h.quote({ ...body, amount: (10n ** 30n + 1n).toString() });
    expect(over.status).toBe(400);
    expect(over.body.error).toEqual({ code: "too_large", message: "That amount is too large." });
    expect(h.tap.quotes).toHaveLength(0);
    // Exactly 10^30 is let through to the provider.
    await h.quote({ ...body, amount: (10n ** 30n).toString() });
    expect(h.tap.quotes).toHaveLength(1);
  });

  it("names the right chain when an address is for another one", async () => {
    const h = await start();
    const reply = await h.quote({ ...QUOTE, to: ASSET.solUsdt, recipient: ADDR.evm });
    expect(reply.body.error.message).toBe("This address is for Ethereum. Enter a Solana address.");
    const zcash = await h.quote({ from: ASSET.baseEth, to: ASSET.zec, amount: "5000000000000000", pay: "wallet", recipient: "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly" });
    expect(zcash.body.error.message).toBe("Use a transparent Zcash address. It starts with t1 or t3.");
  });

  it("requires a same-origin request and a live session token", async () => {
    const h = await start();
    const session = await h.session();
    expect((await h.post("/api/quote", QUOTE, { session, origin: null })).body.error.code).toBe("origin");
    expect((await h.post("/api/quote", QUOTE, { session, origin: "https://evil.example" })).body.error.code).toBe("origin");
    expect((await h.post("/api/quote", QUOTE, { session: null })).body.error.code).toBe("session");
    expect((await h.post("/api/quote", QUOTE, { session: `${session}x` })).body.error.code).toBe("session");
    expect(outcome(await h.post("/api/quote", QUOTE, { session }))).toBe("ok");
    h.clock.t += 31 * 60_000;
    const expired = await h.post("/api/quote", QUOTE, { session });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("session");
    expect(h.tap.quotes).toHaveLength(1);
  });

  it("turns provider refusals into its own plain words and never passes provider text through", async () => {
    const h = await start();
    const cases: Array<[string, string, string, Record<string, unknown> | undefined]> = [
      ["Temporary swap limits: minimum swap amount is $1,000", "min_usd", "Minimum for this pair is $1,000 right now.", { usd: "1000" }],
      ["Amount is too low for bridge, try at least 2725340300683302", "amount_too_low", "That amount is too low for this pair.", { min: "2725340300683302" }],
      ["No liquidity available", "no_route", "No route for this pair right now.", undefined],
      ["Failed to get quote", "no_route", "No route for this pair right now.", undefined],
      ["tokenOut is not valid", "no_route", "No route for this pair right now.", undefined],
      // Seen in the survey of every coin on 8 Oct 2026.
      ["Quote error. NO_QUOTE", "no_route", "No route for this pair right now.", undefined],
      ["Quoting for this pair is not available", "no_route", "No route for this pair right now.", undefined],
      ["1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f is not supported as origin asset", "no_route", "No route for this pair right now.", undefined],
      ["Internal server error", "no_route", "No route for this pair right now.", undefined],
      ["<script>alert('upstream secret detail')</script>", "no_route", "No route for this pair right now.", undefined],
      ["Address is blocked by compliance policy 7781", "blocked", "This swap can't be processed.", undefined],
    ];
    for (const [message, code, shown, detail] of cases) {
      h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message };
      const reply = await h.quote(QUOTE);
      // Everyday outcomes travel as a 200 with the error in the body; a compliance refusal is a real 403.
      expect(reply.status).toBe(code === "blocked" ? 403 : 200);
      expect(reply.body.error.code).toBe(code);
      expect(reply.body.error.message).toBe(shown);
      expect(reply.body.error.detail).toEqual(detail);
      expect(reply.text).not.toContain("upstream secret");
      expect(reply.text).not.toContain("7781");
    }
  });

  it("treats a refused stand-in address as no route, and says plainly when a real address was refused", async () => {
    const h = await start();
    h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message: "recipient is not valid" };
    expect((await h.quote(QUOTE)).body.error.code).toBe("no_route");
    h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message: "recipient is not valid" };
    const refused = await h.quote({ ...QUOTE, recipient: ADDR.evm2, refundTo: ADDR.evm });
    expect(refused.body.error.code).toBe("invalid_recipient");
    expect(refused.body.error.message).toBe("The swap service didn't accept this Arbitrum address. Check it, or use another.");
    h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message: "refundTo is not valid" };
    expect((await h.quote({ ...QUOTE, recipient: ADDR.evm2, refundTo: ADDR.evm })).body.error.message).toBe(
      "The swap service didn't accept this Base address. Check it, or use another.",
    );
  });

  it("shows the neutral no-retry message when the provider refuses by status code", async () => {
    const h = await start();
    for (const status of [403, 451]) {
      h.tap.nextQuote = { ok: false, kind: "rejected", status, message: "" };
      const reply = await h.quote(QUOTE);
      expect(reply.status).toBe(403);
      expect(reply.body.error).toEqual({ code: "blocked", message: "This swap can't be processed." });
    }
  });

  it("logs the provider's tracing ID for refused and failed quotes too", async () => {
    const h = await start();
    h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message: "No liquidity available", cid: "cid-refused-1" };
    await h.quote(QUOTE);
    expect(h.access.at(-1)).toMatchObject({ route: "quote", status: 422, cid: "cid-refused-1" });
    h.tap.nextQuote = { ok: false, kind: "unavailable", status: 502, cid: "cid-failed-2" };
    await h.quote(QUOTE);
    expect(h.access.at(-1)).toMatchObject({ route: "quote", status: 503, cid: "cid-failed-2" });
  });

  it("says try again shortly when the provider is down", async () => {
    const h = await start();
    h.tap.nextQuote = { ok: false, kind: "unavailable", status: 503 };
    const reply = await h.quote(QUOTE);
    expect(reply.status).toBe(503);
    expect(reply.body.error.code).toBe("try_later");
  });

  it("is stopped by the kill switch", async () => {
    const h = await start({ env: { SWAPS_PAUSED: "true" } });
    const reply = await h.quote(QUOTE);
    expect(reply.status).toBe(503);
    expect(reply.body.error.code).toBe("paused");
    expect(h.tap.quotes).toHaveLength(0);
  });
});

describe("quote verification inside the routes", () => {
  it("discards a quote with a broken signature, alerts, and shows a neutral error", async () => {
    const h = await start();
    h.tap.corruptResponse = (data) => ({ ...data, quote: { ...(data.quote as object), amountOut: "999999999999" } });
    const reply = await h.quote(QUOTE);
    expect(reply.status).toBe(502);
    expect(reply.body.error).toEqual({ code: "try_later", message: "We couldn't confirm that quote. Try again shortly." });
    expect(h.alerts.map((a) => a.kind)).toContain("quote_verification");
  });

  it("discards a correctly signed quote that answers a different request", async () => {
    const h = await start();
    for (const change of [{ recipient: ADDR.evm3 }, { refundTo: ADDR.evm3 }, { amount: "4000000000000000" }, { destinationAsset: ASSET.baseUsdc }, { slippageTolerance: 900 }]) {
      // Only the live quote is altered; the preview before it stays honest.
      h.tap.tamperRequest = (body) => (body.dry === false ? { ...body, ...change } : body);
      const reply = await h.order();
      expect(reply.status, JSON.stringify(change)).toBe(502);
    }
    expect(h.store.openCount()).toBe(0);
    expect(h.alerts.filter((a) => a.kind === "quote_verification").length).toBeGreaterThanOrEqual(5);
  });

  it("discards a quote whose fee was raised or redirected", async () => {
    const h = await start({ env: FEES });
    h.tap.corruptResponse = (data) => {
      const request = data.quoteRequest as Record<string, unknown>;
      return { ...data, quoteRequest: { ...request, appFees: [{ recipient: ADDR.evm3, fee: 20 }, { recipient: "provider", fee: 20 }] } };
    };
    expect((await h.quote(QUOTE)).status).toBe(502);
    h.tap.corruptResponse = (data) => {
      const request = data.quoteRequest as Record<string, unknown>;
      const fees = request.appFees as Array<{ recipient: string; fee: number }>;
      return { ...data, quoteRequest: { ...request, appFees: [fees[0], { recipient: "provider", fee: 400 }] } };
    };
    expect((await h.quote(QUOTE)).status).toBe(502);
  });
});

describe("IntentSwap takes no fee unless the server is set to", () => {
  it.each(["public", "basic"] as const)("sends no fee of ours with a %s quote, preview or real, whatever a browser sends, and shows what the echo held", async (level) => {
    const h = await start({ env: { PRIVACY_MODE: level } });
    expect(h.config).toMatchObject({ feeBps: 0, feeBpsPrivate: 0, feeRecipient: null });
    // Everything a browser might send to put a fee on the swap. None of it reaches the provider.
    const hostile = { appFees: [{ recipient: ADDR.evm3, fee: 30 }], fee: 30, feeBps: 30, feeBpsPrivate: 30, feeRecipient: ADDR.evm3 };
    const preview = (await h.quote({ ...QUOTE, ...hostile })).body as QuoteView;
    expect(h.tap.quotes.at(-1)).toMatchObject({ dry: true, confidentiality: level });
    expect(Object.keys(h.tap.quotes.at(-1)!)).not.toContain("appFees");
    // The breakdown is the echo's own: nothing of ours, and the provider's entry.
    expect(preview.fees).toEqual({ appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "10000000000000" });
    const order = asOrder(await h.order(hostile));
    expect(h.tap.quotes.at(-1)).toMatchObject({ dry: false, confidentiality: level });
    expect(Object.keys(h.tap.quotes.at(-1)!)).not.toContain("appFees");
    expect(order.fees).toEqual(preview.fees);
    expect(h.store.get(order.id)?.fees).toEqual(preview.fees);
    for (const sent of h.tap.quotes) expect(JSON.stringify(sent)).not.toMatch(/appFees|"fee"/);
  });

  it.each(["public", "basic"] as const)("discards the echo of a %s quote sent with no fee that holds more than the provider's one entry, or more than the bound", async (level) => {
    const h = await start({ env: { PRIVACY_MODE: level } });
    type Fee = { recipient: string; fee: number };
    const echoing = (fees: (theirs: Fee) => unknown) => (data: Record<string, unknown>) => {
      const request = data.quoteRequest as Record<string, unknown>;
      return { ...data, quoteRequest: { ...request, appFees: fees((request.appFees as Fee[])[0]!) } };
    };
    for (const [fees, reason] of [
      [(theirs: Fee) => [theirs, { recipient: ADDR.evm3, fee: 5 }], "echo:appFees unsent recipient"],
      [(theirs: Fee) => [{ ...theirs, fee: 26 }], "echo:appFees unsent total"],
    ] as const) {
      h.tap.corruptResponse = echoing(fees);
      const reply = await h.quote(QUOTE);
      expect(reply.status, reason).toBe(502);
      expect(reply.body.error, reason).toEqual({ code: "try_later", message: "We couldn't confirm that quote. Try again shortly." });
      expect(h.alerts.at(-1)!.text, reason).toContain(`(${reason})`);
    }
    // The same for the real quote of an order: no order is made from it.
    h.tap.corruptResponse = (data) => ((data.quote as Record<string, unknown>).depositAddress === undefined ? data : echoing((theirs) => [theirs, { recipient: ADDR.evm3, fee: 5 }])(data));
    expect((await h.order()).status).toBe(502);
    expect(h.store.openCount()).toBe(0);
    // Whatever the echo holds within the rule is what is shown: the provider's fee was 1 between two dollar coins.
    h.tap.corruptResponse = echoing((theirs) => [{ ...theirs, fee: 1 }]);
    expect(((await h.quote(QUOTE)).body as QuoteView).fees).toMatchObject({ appBps: 0, providerBps: 1 });
  });

  it("discards an echo that pays this site when no fee was sent with that kind of quote", async () => {
    // A fee on private swaps only, so the server has a fee recipient, and a public quote goes out with nothing of ours.
    const h = await start({ env: { PRIVACY_MODE: "basic", FEE_BPS_PRIVATE: "20" } });
    const ours = h.config.feeRecipient;
    expect(ours).not.toBeNull();
    const inPublic = { ...QUOTE, withoutPrivate: true };
    expect(((await h.quote(inPublic)).body as QuoteView).fees).toMatchObject({ appBps: 0, providerBps: 20 });
    expect(h.tap.quotes.at(-1)!.confidentiality).toBe("public");
    expect(Object.keys(h.tap.quotes.at(-1)!)).not.toContain("appFees");
    for (const fee of [20, 1, 0]) {
      h.tap.corruptResponse = (data) => ({ ...data, quoteRequest: { ...(data.quoteRequest as Record<string, unknown>), appFees: [{ recipient: ours, fee }] } });
      const reply = await h.quote(inPublic);
      expect(reply.status, String(fee)).toBe(502);
      expect(h.alerts.at(-1)!.text, String(fee)).toContain("(echo:appFees unsent share)");
    }
    // And no order is made from such a quote.
    h.tap.corruptResponse = (data) => ((data.quote as Record<string, unknown>).depositAddress === undefined ? data : { ...data, quoteRequest: { ...(data.quoteRequest as Record<string, unknown>), appFees: [{ recipient: ours, fee: 20 }] } });
    expect((await h.order({ withoutPrivate: true })).status).toBe(502);
    expect(h.store.openCount()).toBe(0);
  });
});

describe("POST /api/orders", () => {
  it("creates an order whose deposit address and numbers come from the verified live quote", async () => {
    const h = await start({ env: FEES });
    const feeRecipient = h.config.feeRecipient ?? "";
    const reply = await h.order();
    expect(reply.status).toBe(201);
    const order = reply.body as OrderView;
    expect(order.status).toBe("waiting");
    expect(order.depositAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(order.depositsOpen).toBe(true);
    expect(order.recipient).toBe(ADDR.evm2);
    expect(order.refundTo).toBe(ADDR.evm);
    expect(order.amountIn).toBe("5000000000000000");
    expect(order.fees.appBps).toBe(20);
    expect(order.id).toMatch(/^[A-Za-z0-9_-]{27}$/);
    expect(Date.parse(order.deadline)).toBe(h.clock.t + 30 * 60_000);

    const live = h.tap.quotes.at(-1)!;
    expect(live.dry).toBe(false);
    expect(live.appFees).toEqual([{ recipient: h.config.feeRecipient, fee: 40 }]);

    const stored = JSON.parse(fs.readFileSync(path.join(h.dataDir, "orders", `${order.id}.json`), "utf8"));
    expect(stored.depositAddress).toBe(order.depositAddress);
    expect(stored.termsVersion).toBe(TERMS_VERSION);
    expect(stored.screening).toMatchObject({ result: "clear", listVersion: "test-list" });
    expect(stored.quoteResponse.signature).toMatch(/^ed25519:/);
    expect(stored.quoteResponse.quote.depositAddress).toBe(order.depositAddress);
    expect(stored.sender).toBe(ADDR.evm);
    // Every number kept with the order, and shown for it, is the verified quote's own: what is
    // received, the least that is received, the dollar value of what is paid and of what is received
    // (points are counted from the first), the two fees as the provider echoed them, and its two charges.
    const signed = stored.quoteResponse.quote as Record<string, string | undefined>;
    const echoed = stored.quoteResponse.quoteRequest.appFees as { recipient: string; fee: number }[];
    const ours = echoed.filter((entry) => entry.recipient.toLowerCase() === feeRecipient.toLowerCase()).reduce((sum, entry) => sum + entry.fee, 0);
    const theirs = echoed.reduce((sum, entry) => sum + entry.fee, 0) - ours;
    const amountIn = BigInt(signed.amountIn ?? "0");
    const expected = {
      amountOut: signed.amountOut,
      minAmountOut: signed.minAmountOut,
      amountInUsd: signed.amountInUsd,
      amountOutUsd: signed.amountOutUsd,
      fees: { appBps: ours, providerBps: theirs, appAmount: ((amountIn * BigInt(ours)) / 10_000n).toString(), providerAmount: ((amountIn * BigInt(theirs)) / 10_000n).toString() },
      withdrawFee: signed.withdrawFee ?? null,
      refundFee: signed.refundFee ?? null,
    };
    expect(ours).toBeGreaterThan(0);
    expect(theirs).toBeGreaterThan(0);
    // The two dollar values are real figures, and not one and the same: either put in the other's place would show.
    expect(signed.amountInUsd).toMatch(/^\d+\.\d+$/);
    expect(signed.amountOutUsd).toMatch(/^\d+\.\d+$/);
    expect(signed.amountInUsd).not.toBe(signed.amountOutUsd);
    for (const where of [stored, order] as Record<string, unknown>[]) expect({ amountOut: where.amountOut, minAmountOut: where.minAmountOut, amountInUsd: where.amountInUsd, amountOutUsd: where.amountOutUsd, fees: where.fees, withdrawFee: where.withdrawFee, refundFee: where.refundFee }).toEqual(expected);
  });

  it("ignores any deposit address, fee or status a browser sends", async () => {
    const h = await start({ env: FEES });
    const order = asOrder(
      await h.order({ depositAddress: ADDR.evm3, fees: { appBps: 0 }, appFees: [], status: "delivered", id: "A".repeat(27), deadline: "2099-01-01T00:00:00Z" }),
    );
    expect(order.depositAddress).not.toBe(ADDR.evm3);
    expect(order.status).toBe("waiting");
    expect(order.id).not.toBe("A".repeat(27));
    expect(order.fees.appBps).toBe(20);
    // Nor can a browser put a fee on a swap where the server takes none.
    const free = await start();
    const unpaid = asOrder(await free.order({ fees: { appBps: 30 }, appFees: [{ recipient: ADDR.evm3, fee: 30 }], feeBps: 30 }));
    expect(unpaid.fees).toMatchObject({ appBps: 0, appAmount: "0" });
    expect(Object.keys(free.tap.quotes.at(-1)!)).not.toContain("appFees");
  });

  it("requires the current Terms to be accepted", async () => {
    const h = await start();
    for (const overrides of [{ termsAccepted: false }, { termsAccepted: "true" }, { termsVersion: "old" }, { termsVersion: undefined }]) {
      const reply = await h.order(overrides);
      expect(reply.status).toBe(409);
      expect(reply.body.error.code).toBe("terms");
    }
    expect(h.stub.calls.liveQuotes).toBe(0);
  });

  it("requires real addresses: no stand-ins, no blanks", async () => {
    const h = await start();
    expect((await h.order({ recipient: placeholderFor("arb"), reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 40 } })).body.error.code).toBe("unsupported_address");
    expect((await h.order({ recipient: "", reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 40 } })).body.error.code).toBe("invalid_recipient");
    expect((await h.order({ pay: "manual", sender: undefined, refundTo: "", reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 40 } })).body.error.code).toBe("invalid_refund");
    expect((await h.order({ sender: undefined, reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 40 } })).body.error.code).toBe("invalid_sender");
    expect(h.stub.calls.liveQuotes).toBe(0);
    expect(isPlaceholder(placeholderFor("arb")!)).toBe(true);
  });

  it("requires the reviewed numbers", async () => {
    const h = await start();
    for (const reviewed of [null, {}, { amountOut: "1.5", minAmountOut: "1", totalFeeBps: 40 }, { amountOut: "1", minAmountOut: "1", totalFeeBps: "40" }, { amountOut: "1", minAmountOut: "1", totalFeeBps: -1 }]) {
      const reply = await h.order({ reviewed });
      expect(reply.status).toBe(400);
    }
    expect(h.stub.calls.liveQuotes).toBe(0);
  });

  it("stops and returns the new numbers when the price moved more than 1%", async () => {
    const h = await start();
    const preview = (await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView;
    const inflated = ((BigInt(preview.amountOut) * 102n) / 100n).toString();
    const reply = await h.order({ reviewed: { amountOut: inflated, minAmountOut: preview.minAmountOut, totalFeeBps: 40 } });
    expect(reply.status).toBe(200);
    expect(reply.body.error.code).toBe("price_moved");
    expect(reply.body.error.quote.amountOut).toBe(preview.amountOut);
    expect(reply.body.id).toBeUndefined();
    expect(h.access.at(-1)).toMatchObject({ route: "order_create", status: 409 });
    expect(h.store.openCount()).toBe(0);
    expect(fs.readdirSync(path.join(h.dataDir, "orders"))).toHaveLength(0);

    // Within 1% the order goes through.
    const slight = ((BigInt(preview.amountOut) * 1005n) / 1000n).toString();
    expect((await h.order({ reviewed: { amountOut: slight, minAmountOut: preview.minAmountOut, totalFeeBps: 40 } })).status).toBe(201);
  });

  it("stops when the minimum received or the fee is worse than reviewed", async () => {
    const h = await start({ env: FEES });
    const preview = (await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView;
    const higherMin = ((BigInt(preview.minAmountOut) * 103n) / 100n).toString();
    expect((await h.order({ reviewed: { amountOut: preview.amountOut, minAmountOut: higherMin, totalFeeBps: 40 } })).body.error.code).toBe("price_moved");
    expect((await h.order({ reviewed: { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: 39 } })).body.error.code).toBe("price_moved");
    expect(h.store.openCount()).toBe(0);
  });

  it("refuses a listed address before anything is created at the provider", async () => {
    for (const listed of [ADDR.evm2, ADDR.evm.toLowerCase(), ADDR.evm3]) {
      const h = await start({ sanctions: createStaticSanctions([listed]) });
      const reply = await h.order(listed === ADDR.evm3 ? { refundTo: ADDR.evm3 } : {});
      expect(reply.status).toBe(403);
      expect(reply.body.error).toEqual({ code: "blocked", message: "This swap can't be processed." });
      expect(h.stub.calls.liveQuotes).toBe(0);
      expect(h.store.openCount()).toBe(0);
      expect(h.access.at(-1)?.screening).toBe("listed");
    }
  });

  it("screens each of the three addresses on its own: receiving, refund, and the wallet that pays", async () => {
    // One address is on the list, and it is in one place only. Each place alone must be enough to refuse.
    const places: Array<Record<string, unknown>> = [{ recipient: ADDR.evm3 }, { refundTo: ADDR.evm3 }, { sender: ADDR.evm3 }];
    for (const place of places) {
      const h = await start({ sanctions: createStaticSanctions([ADDR.evm3]) });
      const reply = await h.order(place);
      expect(reply.status, Object.keys(place).join()).toBe(403);
      expect(reply.body.error.code).toBe("blocked");
      expect(h.stub.calls.liveQuotes).toBe(0);
      expect(h.store.openCount()).toBe(0);
    }
    // With that address nowhere in the order, it is made.
    const clean = await start({ sanctions: createStaticSanctions([ADDR.evm3]) });
    expect((await clean.order()).status).toBe(201);
  });

  it("takes an order only from this site's own pages, with a live session", async () => {
    const h = await start();
    const session = await h.session();
    const preview = (await h.quote({ ...QUOTE, sender: ADDR.evm, recipient: ADDR.evm2, refundTo: ADDR.evm })).body as QuoteView;
    const reviewed = { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: preview.fees.appBps + preview.fees.providerBps };
    for (const origin of [null, "https://evil.example"]) {
      const reply = await h.order({ reviewed }, { session, origin });
      expect(reply.status).toBe(403);
      expect(reply.body.error.code).toBe("origin");
    }
    for (const without of [null, `${session}x`]) {
      const reply = await h.order({ reviewed }, { session: without });
      expect(reply.status).toBe(401);
      expect(reply.body.error.code).toBe("session");
    }
    expect(h.stub.calls.liveQuotes).toBe(0);
    expect(h.store.openCount()).toBe(0);
    // The same request from the site's own page, with the session, is taken.
    expect((await h.order({ reviewed }, { session })).status).toBe(201);
    // And once the session has run out, it is not.
    h.clock.t += 31 * 60_000;
    const expired = await h.order({ reviewed, recipient: ADDR.evm3 }, { session });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("session");
    expect(h.store.openCount()).toBe(1);
  });

  it("refuses orders while screening is unavailable", async () => {
    const h = await start({ sanctions: createStaticSanctions([], { available: false }) });
    const reply = await h.order();
    expect(reply.status).toBe(503);
    expect(reply.body.error).toEqual({ code: "try_later", message: "Try again shortly." });
    expect(h.stub.calls.liveQuotes).toBe(0);
  });

  it("shows a neutral message and does not retry when the provider refuses for compliance", async () => {
    const h = await start();
    const preview = (await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView;
    const before = h.tap.quotes.length;
    h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message: "Recipient failed AML risk screening" };
    const reply = await h.order({ reviewed: { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: 40 } });
    expect(reply.status).toBe(403);
    expect(reply.body.error.message).toBe("This swap can't be processed.");
    expect(h.tap.quotes.length).toBe(before + 1);
  });

  it("is stopped by the kill switch, while existing orders stay readable", async () => {
    const live = await start();
    const order = asOrder(await live.order());
    const record = live.store.get(order.id)!;

    const paused = await start({ env: { SWAPS_PAUSED: "true" } });
    paused.store.create(record);
    const refused = await paused.order({ reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 40 } });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe("paused");
    expect(paused.stub.calls.liveQuotes).toBe(0);
    const read = await paused.get(`/api/orders/${order.id}`);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(order.id);
  });

  it("never creates a real order in local development without the practice provider", async () => {
    const h = await start({ liveOrders: false });
    const reply = await h.order({ reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 40 } });
    expect(reply.status).toBe(503);
    expect(h.tap.quotes.filter((q) => q.dry === false)).toHaveLength(0);
  });

  it("enforces the caps: per address, per day and open orders", async () => {
    const perRecipient = await start();
    const reviewed = ((await perRecipient.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView);
    const body = { reviewed: { amountOut: reviewed.amountOut, minAmountOut: reviewed.minAmountOut, totalFeeBps: 40 } };
    for (let i = 0; i < LIMITS.orderPerRecipient.max; i++) {
      const reply = await perRecipient.order(body, { ip: `198.51.100.${i + 1}` });
      expect(reply.status).toBe(201);
    }
    const eleventh = await perRecipient.order(body, { ip: "198.51.100.200" });
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("retry-after")).toBeTruthy();

    const capped = await start({ maxOpenOrders: 2 });
    expect((await capped.order({ ...body, recipient: ADDR.evm2 })).status).toBe(201);
    expect((await capped.order({ ...body, recipient: ADDR.evm3 })).status).toBe(201);
    const third = await capped.order({ ...body, recipient: ADDR.evm });
    expect(third.status).toBe(503);
    expect(third.body.error.code).toBe("busy");
  });

  it("limits order creation per address per day", async () => {
    const h = await start();
    const reviewed = ((await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView);
    const body = { reviewed: { amountOut: reviewed.amountOut, minAmountOut: reviewed.minAmountOut, totalFeeBps: 40 } };
    let created = 0;
    let refused = 0;
    for (let i = 0; i < LIMITS.orderCreateDaily.max + 4; i++) {
      // Step past the per-minute and per-recipient windows; the daily window still holds.
      h.clock.t += 11 * 60_000;
      // Unpaid orders past their deadline are noticed as expired, as they would be while the server runs.
      await h.poller.tick();
      const reply = await h.order(body, { ip: "192.0.2.50", session: await freshSession(h, "192.0.2.50") });
      if (reply.status === 201) created += 1;
      else if (reply.status === 429) refused += 1;
    }
    expect(created).toBe(LIMITS.orderCreateDaily.max);
    expect(refused).toBe(4);
  });
});

async function freshSession(h: Harness, ip: string): Promise<string> {
  return String((await h.get("/api/config", { ip })).body.session);
}

describe("GET /api/orders/:id", () => {
  it("returns the order from the URL alone", async () => {
    const h = await start();
    const order = asOrder(await h.order());
    const reply = await h.get(`/api/orders/${order.id}`, { origin: null, ip: "198.51.100.9" });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ id: order.id, status: "waiting", depositAddress: order.depositAddress });
    expect(Object.keys(reply.body)).not.toContain("quoteResponse");
    expect(Object.keys(reply.body)).not.toContain("sender");
    expect(Object.keys(reply.body)).not.toContain("screening");
  });

  it("answers unknown and malformed IDs identically", async () => {
    const h = await start();
    const unknown = await h.get(`/api/orders/${"A".repeat(27)}`);
    const malformed = await h.get("/api/orders/..%2F..%2Fetc%2Fpasswd", { ip: "198.51.100.2" });
    const short = await h.get("/api/orders/abc", { ip: "198.51.100.3" });
    for (const reply of [unknown, malformed, short]) {
      expect(reply.status).toBe(404);
      expect(reply.text).toBe(unknown.text);
    }
  });

  it("finds an order by its deposit address, and says only which order it is", async () => {
    const h = await start();
    const order = asOrder(await h.order());
    const session = await h.session();
    const found = await h.post("/api/track", { depositAddress: order.depositAddress }, { session });
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ id: order.id });
    // Hex addresses are found in any mix of capitals, and with space around them.
    expect((await h.post("/api/track", { depositAddress: ` ${order.depositAddress!.toLowerCase()} ` }, { session })).body).toEqual({ id: order.id });
  });

  it("does not find a delivered order by its deposit address while the Stats page lists deposits: the address must not lead to the receiving side", async () => {
    const h = await start();
    const session = await h.session();
    const order = asOrder(await h.order());
    const unknown = await h.post("/api/track", { depositAddress: "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83" }, { session, ip: "198.51.100.40" });
    // Still under way: found, as ever.
    expect((await h.post("/api/track", { depositAddress: order.depositAddress }, { session, ip: "198.51.100.41" })).body).toEqual({ id: order.id });
    // Delivered: answered exactly as an address that is no order's. Its own ID still opens it.
    h.store.saveState(order.id, { ...h.store.get(order.id)!.state, status: "delivered" });
    const after = await h.post("/api/track", { depositAddress: order.depositAddress }, { session, ip: "198.51.100.42" });
    expect(after.status).toBe(404);
    expect(after.text).toBe(unknown.text);
    expect((await h.get(`/api/orders/${order.id}`)).status).toBe(200);
    // With the Stats page off nothing lists the deposit, and a delivered order is found as before.
    const off = await start({ env: { STATS_PAGE: "off" } });
    const offSession = await off.session();
    const other = asOrder(await off.order());
    off.store.saveState(other.id, { ...off.store.get(other.id)!.state, status: "delivered" });
    expect((await off.post("/api/track", { depositAddress: other.depositAddress }, { session: offSession })).body).toEqual({ id: other.id });
  });

  it("answers an address that is no order's exactly as it answers an order ID that is no order's", async () => {
    const h = await start();
    const session = await h.session();
    const unknownId = await h.get(`/api/orders/${"A".repeat(27)}`);
    const replies = [
      await h.post("/api/track", { depositAddress: "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83" }, { session, ip: "198.51.100.10" }),
      await h.post("/api/track", { depositAddress: "not an address" }, { session, ip: "198.51.100.11" }),
      await h.post("/api/track", { depositAddress: 5 }, { session, ip: "198.51.100.12" }),
      await h.post("/api/track", {}, { session, ip: "198.51.100.13" }),
      await h.post("/api/track", { id: "A".repeat(27) }, { session, ip: "198.51.100.14" }),
    ];
    for (const reply of replies) {
      expect(reply.status).toBe(404);
      expect(reply.text).toBe(unknownId.text);
    }
  });

  it("needs the site's own session to look an address up, and limits guessing as hard as it limits guessed order IDs", async () => {
    const h = await start();
    const order = asOrder(await h.order());
    expect((await h.post("/api/track", { depositAddress: order.depositAddress }, { session: null })).status).toBe(401);
    // Another site's page cannot use a visitor's browser to ask whether an address is an order's.
    for (const origin of [null, "https://evil.example"]) {
      const foreign = await h.post("/api/track", { depositAddress: order.depositAddress }, { session: await h.session(), origin });
      expect(foreign.status).toBe(403);
      expect(foreign.body.error.code).toBe("origin");
    }
    expect((await h.get("/api/track")).status).toBe(405);
    const session = await h.session();
    let last = 0;
    // The same allowance as guessed order IDs, and the same counter: misses of both kinds add up.
    await h.get(`/api/orders/${"C".repeat(27)}`, { ip: "198.51.100.20" });
    for (let i = 1; i <= LIMITS.orderMiss.max; i++) last = (await h.post("/api/track", { depositAddress: `0x${String(i).padStart(40, "0")}` }, { session, ip: "198.51.100.20" })).status;
    expect(last).toBe(429);
    // Someone else is unaffected, and so is a real address.
    expect((await h.post("/api/track", { depositAddress: order.depositAddress }, { session, ip: "198.51.100.21" })).body).toEqual({ id: order.id });
  });

  it("counts a guessed deposit address as a guess, on the same counter as guessed order IDs", async () => {
    // The look-up's own limits are set aside here, so that only the count of misses can refuse anything.
    const day = 86_400_000;
    const roomy = { max: 100_000, windowMs: day };
    const h = await start({ limits: { orderFind: roomy, orderFindDaily: roomy, orderFindDailyWide: roomy, orderFindGlobal: roomy } });
    const order = asOrder(await h.order());
    const session = await h.session();
    const guess = (i: number, ip: string) => h.post("/api/track", { depositAddress: `0x${String(i).padStart(40, "0")}` }, { session, ip }).then((reply) => reply.status);
    const statuses: number[] = [];
    for (let i = 1; i <= LIMITS.orderMiss.max + 1; i++) statuses.push(await guess(i, "198.51.100.30"));
    // Every guess up to the allowance is a plain "not found"; the next is told to wait.
    expect(statuses.slice(0, LIMITS.orderMiss.max)).toEqual(Array(LIMITS.orderMiss.max).fill(404));
    expect(statuses[LIMITS.orderMiss.max]).toBe(429);
    // The same counter: having guessed addresses, the same visitor cannot go on to guess order IDs.
    expect((await h.get(`/api/orders/${"D".repeat(27)}`, { ip: "198.51.100.30" })).status).toBe(429);
    // An address that is found is no guess: another visitor can look real ones up without using the allowance.
    for (let i = 0; i < LIMITS.orderMiss.max + 2; i++) expect((await h.post("/api/track", { depositAddress: order.depositAddress }, { session, ip: "198.51.100.31" })).status).toBe(200);
  });

  it("limits how many orders one visitor can find by address, so a watcher of the chain cannot collect them", async () => {
    const h = await start({ maxOpenOrders: 50 });
    const order = asOrder(await h.order());
    const session = await h.session();
    const find = (ip: string) => h.post("/api/track", { depositAddress: order.depositAddress }, { session, ip });
    const statuses: number[] = [];
    for (let i = 0; i <= LIMITS.orderFind.max; i++) statuses.push((await find("198.51.100.30")).status);
    expect(statuses.slice(0, LIMITS.orderFind.max).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // The daily allowance is separate and smaller than a day of the per-minute one.
    expect(LIMITS.orderFindDaily.max).toBeLessThan(LIMITS.orderFind.max * 60);
    h.clock.t += 61_000;
    let found = 0;
    for (let minute = 0; minute < 12; minute++) {
      for (let i = 0; i < LIMITS.orderFind.max; i++) if ((await find("198.51.100.31")).status === 200) found += 1;
      h.clock.t += 61_000;
    }
    expect(found).toBe(LIMITS.orderFindDaily.max);
    // Someone else is unaffected.
    expect((await find("198.51.100.32")).status).toBe(200);
  });

  it("charges a look-up before making it, so the limits cannot tell an address of ours from any other", async () => {
    const h = await start();
    const order = asOrder(await h.order());
    const session = await h.session();
    const ask = (depositAddress: string, ip: string) => h.post("/api/track", { depositAddress }, { session, ip });
    // One visitor asks about addresses that are no order's until told to wait; an address that is an order's gets the same answer then.
    const misses: number[] = [];
    for (let i = 0; i < LIMITS.orderFind.max; i++) misses.push((await ask(`0x${String(i + 1).padStart(40, "0")}`, "198.51.100.40")).status);
    expect(misses.every((status) => status === 404)).toBe(true);
    expect((await ask(order.depositAddress!, "198.51.100.40")).status).toBe(429);
    expect((await ask("0x00000000000000000000000000000000000000aa", "198.51.100.40")).status).toBe(429);
  });

  it("limits look-ups by address per wider network and for everyone together", async () => {
    const day = 86_400_000;
    const h = await start({ limits: { orderFind: { max: 1000, windowMs: 60_000 }, orderFindDaily: { max: 3, windowMs: day }, orderFindDailyWide: { max: 5, windowMs: day }, orderFindGlobal: { max: 8, windowMs: day } } });
    const order = asOrder(await h.order());
    const session = await h.session();
    const find = (ip: string) => h.post("/api/track", { depositAddress: order.depositAddress }, { session, ip }).then((reply) => reply.status);
    // Three from one /64, then that one is told to wait.
    expect([await find("2001:db8:1:1::1"), await find("2001:db8:1:1::2"), await find("2001:db8:1:1::3"), await find("2001:db8:1:1::4")]).toEqual([200, 200, 200, 429]);
    // Its neighbours in the same /48 share a larger allowance: two more, then they wait too.
    expect([await find("2001:db8:1:2::1"), await find("2001:db8:1:3::1"), await find("2001:db8:1:4::1")]).toEqual([200, 200, 429]);
    // Everyone together: eight answered in all (five so far), then no one is, whoever asks.
    const rest: number[] = [];
    for (let i = 0; i < 4; i++) rest.push(await find(`198.51.100.${60 + i}`));
    expect(rest).toEqual([200, 200, 200, 429]);
  });

  it("holds every limit at the figure it was set to", () => {
    // The table whole. A limit changed here is a limit changed on purpose.
    const MINUTE = 60_000;
    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    expect(LIMITS).toEqual({
      api: { max: 180, windowMs: MINUTE },
      apiWide: { max: 720, windowMs: MINUTE },
      statusExempt: { max: 120, windowMs: MINUTE },
      apiGlobal: { max: 6000, windowMs: MINUTE },
      apiReadsGlobal: { max: 30_000, windowMs: MINUTE },
      pages: { max: 3000, windowMs: MINUTE },
      quote: { max: 30, windowMs: MINUTE },
      quoteGlobal: { max: 150, windowMs: MINUTE },
      orderCreate: { max: 6, windowMs: MINUTE },
      orderCreateDaily: { max: 30, windowMs: DAY },
      orderAttemptDaily: { max: 90, windowMs: DAY },
      orderLiveDaily: { max: 45, windowMs: DAY },
      orderCreateDailyWide: { max: 120, windowMs: DAY },
      orderAttemptDailyWide: { max: 360, windowMs: DAY },
      orderLiveDailyWide: { max: 180, windowMs: DAY },
      orderPriceMoved: { max: 6, windowMs: HOUR },
      orderCreateGlobal: { max: 120, windowMs: MINUTE },
      orderPerRecipient: { max: 10, windowMs: HOUR },
      orderRead: { max: 90, windowMs: MINUTE },
      rewardsNonce: { max: 10, windowMs: MINUTE },
      rewardsNonceWide: { max: 40, windowMs: MINUTE },
      rewardsNonceGlobal: { max: 600, windowMs: MINUTE },
      rewardsSignIn: { max: 10, windowMs: MINUTE },
      rewardsRead: { max: 60, windowMs: MINUTE },
      orderMiss: { max: 10, windowMs: MINUTE },
      orderFind: { max: 6, windowMs: MINUTE },
      orderFindDaily: { max: 40, windowMs: DAY },
      orderFindDailyWide: { max: 120, windowMs: DAY },
      orderFindGlobal: { max: 250, windowMs: HOUR },
      depositForwardGlobal: { max: 30, windowMs: MINUTE },
      depositPerOrder: { max: 5, windowMs: MINUTE },
      deposit: { max: 20, windowMs: MINUTE },
      rpc: { max: 120, windowMs: MINUTE },
      rpcGlobal: { max: 3000, windowMs: MINUTE },
      rpcBalances: { max: 240, windowMs: MINUTE },
      rpcBalancesGlobal: { max: 3000, windowMs: MINUTE },
      light: { max: 60, windowMs: MINUTE },
    });
    // The caps that are not rates.
    expect({ MAX_OPEN_ORDERS, MAX_UNPAID_PER_CLIENT, MAX_UNPAID_PER_NETWORK, MAX_HASH_SUBMISSIONS }).toEqual({ MAX_OPEN_ORDERS: 5000, MAX_UNPAID_PER_CLIENT: 10, MAX_UNPAID_PER_NETWORK: 40, MAX_HASH_SUBMISSIONS: 3 });
    // Open orders: twice the provider's calls a minute, never under ten, never over five thousand.
    expect([1, 5, 60, 300, 2500, 9000].map(openOrderCap)).toEqual([10, 10, 120, 600, 5000, 5000]);
  });

  it("counts an unknown order on the deposit route as a guess, like any other", async () => {
    const h = await start();
    const session = await h.session();
    let last = 0;
    for (let i = 0; i <= LIMITS.orderMiss.max; i++) last = (await h.post(`/api/orders/${"B".repeat(26)}${i % 10}/deposit`, { txHash: `0x${"ab".repeat(32)}` }, { session })).status;
    expect(last).toBe(429);
    // And the guesses made there count against guessing an order's page too.
    expect((await h.get(`/api/orders/${"C".repeat(27)}`)).status).toBe(429);
  });

  it("holds one network to forty unpaid orders, however many of its addresses make them", async () => {
    const h = await start({ limits: { orderCreate: { max: 1000, windowMs: 60_000 }, orderCreateGlobal: { max: 1000, windowMs: 60_000 }, orderCreateDaily: { max: 1000, windowMs: 86_400_000 }, orderAttemptDaily: { max: 1000, windowMs: 86_400_000 }, orderLiveDaily: { max: 1000, windowMs: 86_400_000 }, orderPerRecipient: { max: 1000, windowMs: 3_600_000 }, api: { max: 100_000, windowMs: 60_000 }, apiWide: { max: 100_000, windowMs: 60_000 }, quote: { max: 100_000, windowMs: 60_000 }, quoteGlobal: { max: 100_000, windowMs: 60_000 } } });
    const statuses: number[] = [];
    // Five addresses in each of nine /64s of one /48: each address stays under its own ten, the network does not stay under forty.
    for (let i = 0; i < MAX_UNPAID_PER_NETWORK + 1; i++) statuses.push((await h.order({ amount: String(5_000_000_000_000_000n + BigInt(i)) }, { ip: `2001:db8:7:${Math.floor(i / 5) + 1}::${(i % 5) + 1}` })).status);
    expect(statuses.slice(0, MAX_UNPAID_PER_NETWORK).every((status) => status === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // Another network is not held up by it.
    expect((await h.order({ amount: "5000000000000999" }, { ip: "2001:db8:8:1::1" })).status).toBe(201);
  });

  it("rate limits guessing hard", async () => {
    const h = await start();
    let last = 0;
    for (let i = 0; i <= LIMITS.orderMiss.max; i++) last = (await h.get(`/api/orders/${"B".repeat(26)}${i % 10}`)).status;
    expect(last).toBe(429);
    // Another address is unaffected.
    expect((await h.get(`/api/orders/${"B".repeat(27)}`, { ip: "198.51.100.44" })).status).toBe(404);
  });

  it("stops showing deposit details 2 minutes before the deadline", async () => {
    const h = await start();
    const order = asOrder(await h.order());
    h.clock.t = Date.parse(order.deadline) - 2 * 60_000 - 1000;
    expect((await h.get(`/api/orders/${order.id}`)).body.depositAddress).toBe(order.depositAddress);
    h.clock.t = Date.parse(order.deadline) - 2 * 60_000 + 1000;
    const late = await h.get(`/api/orders/${order.id}`);
    expect(late.body.depositAddress).toBeNull();
    expect(late.body.depositMemo).toBeNull();
    expect(late.body.depositsOpen).toBe(false);
  });

  it("hides a deposit's memo together with its address once deposits close", async () => {
    // A Stellar deposit is an address and a memo. Either one alone, shown too late, is an invitation to send.
    const h = await start();
    const order = asOrder(await h.order({ from: ASSET.xlm, to: ASSET.arbUsdc, amount: "1000000000", pay: "manual", sender: undefined, refundTo: ADDR.stellar }));
    expect(order.depositMemo).toMatch(/^\d+$/);
    h.clock.t = Date.parse(order.deadline) - 2 * 60_000 - 1000;
    expect((await h.get(`/api/orders/${order.id}`)).body.depositMemo).toBe(order.depositMemo);
    h.clock.t = Date.parse(order.deadline) - 2 * 60_000 + 1000;
    const late = await h.get(`/api/orders/${order.id}`);
    expect(late.body.depositAddress).toBeNull();
    expect(late.body.depositMemo).toBeNull();
  });
});

describe("POST /api/orders/:id/deposit", () => {
  const HASH = `0x${"ab".repeat(32)}`;

  async function withOrder(overrides: Record<string, unknown> = {}) {
    const h = await start();
    const order = asOrder(await h.order(overrides));
    const session = await h.session();
    return { h, order, session };
  }

  it("records a native-coin transfer that pays the order, then refuses a second hash", async () => {
    const { h, order, session } = await withOrder();
    mine(h, HASH, { to: order.depositAddress, value: "0x11c37937e08000", input: "0x" });
    const reply = await h.post(`/api/orders/${order.id}/deposit`, { txHash: HASH }, { session });
    expect(reply.status).toBe(200);
    expect(reply.body.depositTxHash).toBe(HASH);
    expect(reply.body.depositTxUrl).toBe(`https://basescan.org/tx/${HASH}`);
    // We confirmed the deposit ourselves, so the order shows it as found and no longer asks for one.
    expect(reply.body.status).toBe("deposit_seen");
    expect(reply.body.depositAddress).toBeNull();
    expect(h.stub.calls.submits).toBe(1);
    expect(h.store.get(order.id)?.state.depositForwarded).toBe(true);

    const other = `0x${"cd".repeat(32)}`;
    mine(h, other, { to: order.depositAddress, value: "0x11c37937e08000", input: "0x" });
    const replay = await h.post(`/api/orders/${order.id}/deposit`, { txHash: other }, { session });
    expect(replay.status).toBe(409);
    expect(h.store.get(order.id)?.state.depositTxHash).toBe(HASH);
    expect(h.stub.calls.submits).toBe(1);
  });

  it("does not take a payment of less than the order's amount in the chain's own coin as proof of a deposit", async () => {
    const { h, order, session } = await withOrder();
    // The order is for 0x11c37937e08000 of the coin. One unit less, to the right address, is not it.
    const short = `0x${"0b".repeat(32)}`;
    mine(h, short, { to: order.depositAddress, value: "0x11c37937e07fff", input: "0x" });
    const reply = await h.post(`/api/orders/${order.id}/deposit`, { txHash: short }, { session });
    expect(outcome(reply)).toBe("not_verified");
    expect(h.store.get(order.id)?.state).toMatchObject({ depositTxHash: null, depositForwarded: false, status: "waiting" });
    expect(h.stub.calls.submits).toBe(0);
    // The exact amount, and more than it, are.
    const exact = `0x${"0c".repeat(32)}`;
    mine(h, exact, { to: order.depositAddress, value: "0x11c37937e08000", input: "0x" });
    expect((await h.post(`/api/orders/${order.id}/deposit`, { txHash: exact }, { session })).status).toBe(200);
  });

  it("passes an order's memo on with its deposit hash, by the route and again by the later offer", async () => {
    const h = await start();
    const order = asOrder(await h.order({ from: ASSET.xlm, to: ASSET.arbUsdc, amount: "1000000000", pay: "manual", sender: undefined, refundTo: ADDR.stellar }));
    expect(order.depositMemo).toMatch(/^\d+$/);
    const hash = "ab".repeat(32);
    // The first try does not get through to the provider.
    h.tap.submitFails = true;
    await h.post(`/api/orders/${order.id}/deposit`, { txHash: hash }, { session: await h.session() });
    expect(h.tap.submits.at(-1)).toMatchObject({ depositAddress: order.depositAddress, txHash: hash, memo: order.depositMemo });
    expect(h.store.get(order.id)?.state.depositForwarded).toBe(false);
    // The offer is made again when the order is next checked, with the memo as before.
    h.tap.submitFails = false;
    const before = h.tap.submits.length;
    await h.poller.recheck(order.id);
    expect(h.tap.submits.length).toBeGreaterThan(before);
    expect(h.tap.submits.at(-1)).toMatchObject({ depositAddress: order.depositAddress, txHash: hash, memo: order.depositMemo });
    expect(h.store.get(order.id)?.state.depositForwarded).toBe(true);
    // An order without a memo sends none.
    const plain = asOrder(await h.order({ from: ASSET.btc, to: ASSET.arbUsdc, amount: "1000000", pay: "manual", sender: undefined, refundTo: ADDR.btc }));
    await h.post(`/api/orders/${plain.id}/deposit`, { txHash: "cd".repeat(32) }, { session: await h.session() });
    expect(Object.keys(h.tap.submits.at(-1) ?? {})).not.toContain("memo");
  });

  it("records a token transfer only when contract, recipient and amount match", async () => {
    const { h, order, session } = await withOrder({ from: ASSET.baseUsdc, to: ASSET.baseEth, amount: "25000000" });
    const contract = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const data = (to: string, amount: bigint) => `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
    const post = (hash: string) => h.post(`/api/orders/${order.id}/deposit`, { txHash: hash }, { session });

    const wrongContract = `0x${"01".repeat(32)}`;
    h.rpc.txs.set(wrongContract, { to: ADDR.evm3, value: "0x0", input: data(order.depositAddress!, 25000000n) });
    expect(outcome(await post(wrongContract))).toBe("not_verified");

    const wrongRecipient = `0x${"02".repeat(32)}`;
    h.rpc.txs.set(wrongRecipient, { to: contract, value: "0x0", input: data(ADDR.evm3, 25000000n) });
    expect(outcome(await post(wrongRecipient))).toBe("not_verified");

    const tooLittle = `0x${"03".repeat(32)}`;
    h.rpc.txs.set(tooLittle, { to: contract, value: "0x0", input: data(order.depositAddress!, 24999999n) });
    expect(outcome(await post(tooLittle))).toBe("not_verified");

    const approval = `0x${"04".repeat(32)}`;
    h.rpc.txs.set(approval, { to: contract, value: "0x0", input: `0x095ea7b3${order.depositAddress!.slice(2).padStart(64, "0")}${"f".repeat(64)}` });
    expect(outcome(await post(approval))).toBe("not_verified");
    expect(h.stub.calls.submits).toBe(0);
    expect(h.store.get(order.id)?.state.depositTxHash).toBeNull();

    h.clock.t += 61_000; // past the per-order window used up by the attempts above
    // Mined and "successful", but the token recorded no transfer: some tokens report success without moving anything.
    const hollow = `0x${"06".repeat(32)}`;
    mine(h, hollow, { from: ADDR.evm, to: contract, value: "0x0", input: data(order.depositAddress!, 25000000n) });
    expect(outcome(await post(hollow))).toBe("not_verified");
    expect(h.store.get(order.id)?.state.depositTxHash).toBeNull();

    const good = `0x${"05".repeat(32)}`;
    mine(h, good, { from: ADDR.evm, to: contract, value: "0x0", input: data(order.depositAddress!, 25000000n) }, [transferRecord(contract, ADDR.evm, order.depositAddress!, 25000000n)]);
    const reply = await post(good);
    expect(outcome(reply)).toBe("ok");
    expect(reply.body.depositTxUrl).toBe(`https://basescan.org/tx/${good}`);
    expect(h.stub.calls.submits).toBe(1);
  });

  it("rejects a transfer to another address, an unseen transaction and a malformed hash", async () => {
    const { h, order, session } = await withOrder();
    const post = (txHash: unknown) => h.post(`/api/orders/${order.id}/deposit`, { txHash }, { session });
    h.rpc.txs.set(HASH, { to: ADDR.evm3, value: "0x11c37937e08000", input: "0x" });
    const wrong = await post(HASH);
    expect(wrong.status).toBe(200); // an everyday outcome: carried in the body, not as a failed request
    expect(wrong.body.error.code).toBe("not_verified");
    expect(wrong.body.error.message).toBe("We couldn't match that transaction to this order. If you sent the deposit, it will still be picked up automatically.");
    const unseen = await post(`0x${"ee".repeat(32)}`);
    expect(unseen.body.error).toEqual({ code: "not_verified", message: "We can't see that transaction yet. Your deposit will still be picked up automatically." });
    expect(h.access.at(-1)).toMatchObject({ route: "order_deposit", status: 409 });
    expect((await post("0x1234")).status).toBe(400);
    expect((await post(null)).status).toBe(400);
    expect(h.stub.calls.submits).toBe(0);
  });

  it("allows at most 5 attempts per minute per order", async () => {
    const { h, order, session } = await withOrder();
    const results: string[] = [];
    for (let i = 0; i < 7; i++) results.push(outcome(await h.post(`/api/orders/${order.id}/deposit`, { txHash: `0x${String(i).repeat(64)}` }, { session, ip: `198.51.100.${i + 1}` })));
    expect(results.slice(0, 5)).toEqual(Array(5).fill("not_verified"));
    expect(results.slice(5)).toEqual(["rate_limited", "rate_limited"]);
  });

  it("only works while the order is waiting for a deposit", async () => {
    const { h, order, session } = await withOrder();
    h.stub.control(order.depositAddress!, "deposit");
    h.clock.t += 5500;
    await h.poller.tick();
    expect(h.store.get(order.id)?.state.status).toBe("deposit_seen");
    h.rpc.txs.set(HASH, { to: order.depositAddress, value: "0x11c37937e08000", input: "0x" });
    const reply = await h.post(`/api/orders/${order.id}/deposit`, { txHash: HASH }, { session });
    // Refused, and nothing recorded. It is an everyday outcome (the deposit was found before the browser
    // named it), so like the other everyday outcomes it travels as a 200 with the refusal in the body.
    expect(reply.status).toBe(200);
    expect(reply.body.error.code).toBe("conflict");
    expect(reply.body.error.message).toBe("This order is no longer waiting for a deposit.");
    expect(h.store.get(order.id)?.state.depositTxHash ?? null).toBeNull();
  });

  it("forwards a format-checked hash on chains without wallet support", async () => {
    const { h, order, session } = await withOrder({ from: ASSET.btc, to: ASSET.arbUsdc, amount: "1000000", pay: "manual", sender: undefined, refundTo: ADDR.btc });
    expect((await h.post(`/api/orders/${order.id}/deposit`, { txHash: HASH }, { session })).status).toBe(400);
    const reply = await h.post(`/api/orders/${order.id}/deposit`, { txHash: "ab".repeat(32) }, { session });
    expect(reply.status).toBe(200);
    expect(h.stub.calls.submits).toBe(1);
    expect(h.rpc.calls.filter((c) => c.call.method === "eth_getTransactionByHash")).toHaveLength(0);
  });

  it("needs a same-origin request, a session, and a real order", async () => {
    const { h, order, session } = await withOrder();
    expect((await h.post(`/api/orders/${order.id}/deposit`, { txHash: HASH }, { session, origin: "https://evil.example" })).status).toBe(403);
    expect((await h.post(`/api/orders/${order.id}/deposit`, { txHash: HASH }, { session: null })).status).toBe(401);
    expect((await h.post(`/api/orders/${"Z".repeat(27)}/deposit`, { txHash: HASH }, { session })).status).toBe(404);
  });
});

describe("region block", () => {
  const blocked = { country: "IR", blocked: true, reason: "country" as const };
  const crimea = { country: "UA", blocked: true, reason: "region" as const };

  // These tests run with the block switched on (the harness sets REGION_BLOCK=on): what it does when it is on is unchanged.
  // The two below it are the setting itself: off unless set, and then nobody is refused for where they are.
  it("switched off, serves a request from anywhere: a blocked country, a blocked region, an address that cannot be placed, or none at all", async () => {
    // A region service that would refuse every one of them, and counts how often it is asked.
    let asked = 0;
    const refusing = createStaticGeo({ "198.51.100.66": blocked, "198.51.100.67": crimea }, { country: null, blocked: true, reason: "unknown" });
    const counting = { check: (ip: string | null) => ((asked += 1), refusing.check(ip)), ready: () => false };
    const settings: Record<string, string>[] = [{ REGION_BLOCK: "off" }, { REGION_BLOCK: "" }, { REGION_BLOCK: "off", BLOCKED_COUNTRIES: "US,GB,DE" }];
    for (const env of settings) {
      const h = await start({ geo: counting, env });
      expect(h.config.regionBlock).toBe(false);
      const session = await h.session();
      for (const ip of ["198.51.100.66", "198.51.100.67", "203.0.113.5", "8.8.8.8"]) {
        expect((await h.get("/api/config", { ip })).status, ip).toBe(200);
        expect((await h.get("/api/status", { ip })).status, ip).toBe(200);
        expect((await h.get("/api/tokens", { ip })).status, ip).toBe(200);
        const quote = await h.post("/api/quote", QUOTE, { ip, session });
        expect(quote.status, ip).toBe(200);
        expect(JSON.stringify(quote.body), ip).not.toContain("region");
        // Not blocked: an order that does not exist is simply not found.
        expect((await h.get(`/api/orders/${"A".repeat(27)}`, { ip })).status, ip).toBe(404);
      }
      // A request whose address is not known at all (the proxy's headers are missing or disagree) is served too.
      expect((await h.get("/api/tokens", { headers: { "x-forwarded-for": "not an address" } })).status).toBe(200);
      // An order can be made from an address the block would have refused.
      expect(asOrder(await h.order({}, { ip: "198.51.100.66" })).status).toBe("waiting");
      // Nothing is ever said of a region, and the access log names no country.
      expect(h.access.every((entry) => entry.country === null)).toBe(true);
      expect(h.access.some((entry) => entry.status === 403)).toBe(false);
    }
    // The region service was never asked: nothing is looked up where nothing is blocked.
    expect(asked).toBe(0);
  });

  it("switched off, still limits and still screens: neither depends on a country", async () => {
    const h = await start({ env: { REGION_BLOCK: "off" }, limits: { api: { max: 3, windowMs: 60_000 } } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await h.get("/api/tokens", { ip: "198.51.100.90" })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    // Another visitor is not touched by the first one's limit: the address is still what limits are kept by.
    expect((await h.get("/api/tokens", { ip: "198.51.100.91" })).status).toBe(200);
    // A wallet address on the sanctions list is refused before anything is created at the provider, as ever.
    const screened = await start({ env: { REGION_BLOCK: "off" }, sanctions: createStaticSanctions([ADDR.evm2]) });
    const reply = await screened.order();
    expect(reply.status).toBe(403);
    expect(reply.body.error).toEqual({ code: "blocked", message: "This swap can't be processed." });
    expect(screened.stub.calls.liveQuotes).toBe(0);
    expect(screened.access.at(-1)?.screening).toBe("listed");
  });

  it("blocks every API route for a blocked country or region", async () => {
    const h = await start({ geo: createStaticGeo({ "198.51.100.66": blocked, "198.51.100.67": crimea }) });
    const session = await h.session();
    for (const ip of ["198.51.100.66", "198.51.100.67"]) {
      const replies = [
        await h.get("/api/config", { ip }),
        await h.get("/api/status", { ip }),
        await h.get("/api/tokens", { ip }),
        await h.get(`/api/orders/${"A".repeat(27)}`, { ip }),
        await h.post("/api/quote", QUOTE, { ip, session }),
        await h.post("/api/orders", {}, { ip, session }),
        await h.post(`/api/orders/${"A".repeat(27)}/deposit`, {}, { ip, session }),
        await h.post("/api/rpc/base", { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { ip }),
        await h.get("/api/anything", { ip }),
      ];
      for (const reply of replies) {
        expect(reply.status).toBe(403);
        expect(reply.body.error).toEqual({ code: "region", message: "Not available in your region." });
      }
    }
    expect(h.tap.quotes).toHaveLength(0);
    expect(h.access.filter((e) => e.country === "IR").length).toBeGreaterThan(0);
    // Everyone else is served.
    expect((await h.get("/api/config", { ip: "203.0.113.5" })).status).toBe(200);
  });

  it("cannot be bypassed by forging forwarding headers", async () => {
    // As in production: an address that cannot be resolved is blocked.
    const h = await start({ geo: createStaticGeo({ "198.51.100.66": blocked, "203.0.113.5": { country: "DE", blocked: false, reason: null } }, { country: null, blocked: true, reason: "unknown" }) });
    const get = (headers: Record<string, string>) => h.get("/api/config", { headers }).then((r) => r.status);
    // An honest request from an allowed place, with one header or both.
    expect(await get({ "x-forwarded-for": "203.0.113.5" })).toBe(200);
    expect(await get({ "x-forwarded-for": "203.0.113.5", "x-real-ip": "203.0.113.5" })).toBe(200);
    // A blocked visitor puts a clean address in front; the proxy appends the real one.
    expect(await get({ "x-forwarded-for": "203.0.113.5, 198.51.100.66" })).toBe(403);
    expect(await get({ "x-forwarded-for": "203.0.113.5, 198.51.100.66", "x-real-ip": "198.51.100.66" })).toBe(403);
    // A blocked visitor forges either header to look allowed: the two no longer agree, so the request is refused.
    expect(await get({ "x-forwarded-for": "203.0.113.5, 198.51.100.66", "x-real-ip": "203.0.113.5" })).toBe(403);
    expect(await get({ "x-forwarded-for": "203.0.113.5", "x-real-ip": "198.51.100.66" })).toBe(403);
    expect(h.logs.some((line) => line.includes("proxy_headers_disagree"))).toBe(true);
    // A disagreement never gets the health-check exemption.
    expect((await h.get("/api/status", { headers: { "x-forwarded-for": "10.0.0.1", "x-real-ip": "198.51.100.66" } })).status).toBe(403);
  });

  it("lets the platform health check read the status and nothing else", async () => {
    const h = await start({ geo: createStaticGeo({}, { country: null, blocked: true, reason: "unknown" }) });
    const direct = (pathname: string) => fetch(h.url + pathname).then((r) => r.status);
    expect(await direct("/api/status")).toBe(200);
    expect(await direct("/api/config")).toBe(403);
    expect(await direct("/api/tokens")).toBe(403);
  });
});

describe("rate limits", () => {
  it("limits quotes per address and tells the client when to retry", async () => {
    const h = await start();
    h.tap.nextQuote = null;
    const session = await h.session();
    let ok = 0;
    let limited: Awaited<ReturnType<Harness["post"]>> | null = null;
    for (let i = 0; i < LIMITS.quote.max + 1; i++) {
      const reply = await h.post("/api/quote", { ...QUOTE, to: "nep141:fake.near" }, { session });
      if (reply.status === 400) ok += 1;
      else limited = reply;
    }
    expect(ok).toBe(LIMITS.quote.max);
    expect(limited?.status).toBe(429);
    expect(limited?.body.error.code).toBe("rate_limited");
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
    // A different address is not affected, and the window resets.
    expect(outcome(await h.post("/api/quote", QUOTE, { session, ip: "198.51.100.90" }))).toBe("ok");
    h.clock.t += 61_000;
    expect(outcome(await h.post("/api/quote", QUOTE, { session: await freshSession(h, "203.0.113.10") }))).toBe("ok");
  });

  it("has a limit across all clients together on the API, on order creation and on the RPC proxy", async () => {
    // Every request comes from a different address, so only the shared limits can stop them.
    let n = 0;
    const ip = () => `198.51.${Math.floor(n / 250) + 100}.${(n++ % 250) + 1}`;

    // The cheap reads a page asks for by itself share one allowance...
    const reads = await start({ limits: { apiReadsGlobal: { max: 5, windowMs: 60_000 } } });
    const readStatuses: number[] = [];
    for (const path of ["/api/tokens", "/api/config", "/api/status", `/api/orders/${"E".repeat(27)}`, "/api/tokens", "/api/config", "/api/status"]) readStatuses.push((await reads.get(path, { ip: ip() })).status);
    expect(readStatuses).toEqual([200, 200, 200, 404, 200, 429, 429]);
    reads.clock.t += 61_000;
    expect((await reads.get("/api/tokens", { ip: ip() })).status).toBe(200);

    // ...and everything else another, which the reads do not use up, and which does not stop the reads.
    const api = await start({ limits: { apiGlobal: { max: 5, windowMs: 60_000 } } });
    for (let i = 0; i < 20; i++) expect((await api.get("/api/tokens", { ip: ip() })).status).toBe(200);
    const apiStatuses: number[] = [];
    for (let i = 0; i < 7; i++) apiStatuses.push((await api.quote(QUOTE, { ip: ip() })).status);
    expect(apiStatuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    // An address that is no route counts against it too: it cannot be used to get round the cap.
    expect((await api.get("/api/no-such-route", { ip: ip() })).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await api.get("/api/status", { ip: ip() })).status).toBe(200);
    api.clock.t += 61_000;
    expect((await api.quote(QUOTE, { ip: ip() })).status).toBe(200);

    const orders = await start({ limits: { orderCreateGlobal: { max: 2, windowMs: 60_000 } } });
    const reviewed = (await orders.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView;
    const body = { reviewed: { amountOut: reviewed.amountOut, minAmountOut: reviewed.minAmountOut, totalFeeBps: 40 } };
    const recipients = [ADDR.evm2, ADDR.evm3, ADDR.evm];
    const orderStatuses: number[] = [];
    for (const recipient of recipients) orderStatuses.push((await orders.order({ ...body, recipient }, { ip: ip() })).status);
    expect(orderStatuses).toEqual([201, 201, 429]);
    expect(orders.stub.calls.liveQuotes).toBe(2);

    const rpc = await start({ limits: { rpcGlobal: { max: 12, windowMs: 60_000 } } });
    const session = await rpc.session();
    const call = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
    expect((await rpc.post("/api/rpc/base", Array.from({ length: 10 }, () => call), { ip: ip(), session })).status).toBe(200);
    expect((await rpc.post("/api/rpc/base", [call, call], { ip: ip(), session })).status).toBe(200);
    expect((await rpc.post("/api/rpc/base", call, { ip: ip(), session })).status).toBe(429);
  });

  it("counts reads of what a wallet holds apart from every other read of a chain", async () => {
    const h = await start({ limits: { rpc: { max: 2, windowMs: 60_000 }, rpcBalances: { max: 3, windowMs: 60_000 } } });
    const session = await h.session();
    const who = { ip: "203.0.113.77", session };
    const holder = `0x${"11".repeat(20)}`;
    const own = { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [holder, "latest"] };
    const token = { jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: `0x${"22".repeat(20)}`, data: `0x70a08231${holder.slice(2).padStart(64, "0")}` }, "latest"] };
    const other = { jsonrpc: "2.0", id: 3, method: "eth_chainId", params: [] };
    // Three balance reads use up the balance allowance and none of the other.
    expect((await h.post("/api/rpc/base", [own, token, token], who)).status).toBe(200);
    expect((await h.post("/api/rpc/base", [own], who)).status).toBe(429);
    expect((await h.post("/api/rpc/base", other, who)).status).toBe(200);
    // A batch with anything else in it, and a balance read sent alone, count as ordinary reads.
    expect((await h.post("/api/rpc/base", [own, other], who)).status).toBe(429);
    expect((await h.post("/api/rpc/base", own, who)).status).toBe(200);
    expect((await h.post("/api/rpc/base", other, who)).status).toBe(429);
    // So does a call that only begins like a balance read: another function, more after the address, a gas figure, another block.
    const lookalike = await start({ limits: { rpc: { max: 4, windowMs: 60_000 }, rpcBalances: { max: 50, windowMs: 60_000 } } });
    const again = { ip: "203.0.113.78", session: await lookalike.session() };
    const call = (first: Record<string, unknown>, block: string = "latest") => [{ jsonrpc: "2.0", id: 1, method: "eth_call", params: [first, block] }];
    const data = token.params[0] as { to: string; data: string };
    const tries = [call({ to: data.to, data: "0x313ce567" }), call({ to: data.to, data: `${data.data}${"00".repeat(32)}` }), call({ ...data, gas: "0x2faf080" }), call(data, "0x1")];
    for (const batch of tries) expect((await lookalike.post("/api/rpc/base", batch, again)).status).toBe(200);
    expect((await lookalike.post("/api/rpc/base", call(data), again)).status).toBe(200);
    expect((await lookalike.post("/api/rpc/base", other, again)).status).toBe(429);
  });

  it("counts an IPv6 /64 as one client", async () => {
    const h = await start();
    for (let i = 0; i < LIMITS.light.max; i++) {
      expect((await h.get("/api/status", { ip: `2001:db8:1:2::${(i + 1).toString(16)}` })).status).toBe(200);
    }
    expect((await h.get("/api/status", { ip: "2001:db8:1:2:ffff:ffff:ffff:ffff" })).status).toBe(429);
    expect((await h.get("/api/status", { ip: "2001:db8:1:3::1" })).status).toBe(200);
  });
});

describe("POST /api/rpc/:chain", () => {
  const call = (method: string, params: unknown[] = []) => ({ jsonrpc: "2.0", id: 7, method, params });
  const rpc = async (h: Harness, chain: string, body: unknown, options: Parameters<Harness["post"]>[2] = {}) =>
    h.post(`/api/rpc/${chain}`, body, { session: await h.session(options.ip), ...options });

  it("passes allow-listed read methods", async () => {
    const h = await start();
    const reply = await rpc(h, "base", call("eth_chainId"));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ jsonrpc: "2.0", id: 7, result: "0x1" });
    const batch = await rpc(h, "bsc", [call("eth_chainId"), call("eth_getBalance", [ADDR.evm, "latest"])]);
    expect(batch.body).toHaveLength(2);
    expect(batch.body[1].result).toBe("0xde0b6b3a7640000");
  });

  it("refuses everything else", async () => {
    const h = await start();
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_getLogs", "personal_sign", "eth_sign", "debug_traceTransaction", "admin_peers", "eth_accounts"]) {
      const reply = await rpc(h, "base", call(method, []));
      expect(reply.status, method).toBe(400);
    }
    expect((await rpc(h, "base", Array.from({ length: 11 }, () => call("eth_chainId")))).status).toBe(400);
    expect((await rpc(h, "base", call("eth_getBlockByNumber", ["latest", true]))).status).toBe(400);
    expect((await rpc(h, "base", call("eth_call", [{ data: `0x${"00".repeat(9000)}` }, "latest"]))).status).toBe(400);
    expect((await rpc(h, "sol", call("eth_chainId"))).status).toBe(404);
    expect((await rpc(h, "op", call("eth_chainId"))).status).toBe(404);
    expect(h.rpc.calls.filter((c) => c.call.method !== "eth_call")).toHaveLength(0);
  });

  it("serves only the site itself: same origin and a live session token", async () => {
    const h = await start();
    expect((await rpc(h, "base", call("eth_chainId"), { origin: "https://evil.example" })).status).toBe(403);
    expect((await rpc(h, "base", call("eth_chainId"), { origin: null })).status).toBe(403);
    expect((await h.post("/api/rpc/base", call("eth_chainId"), { session: null })).status).toBe(401);
    expect((await h.post("/api/rpc/base", call("eth_chainId"), { session: "v1.0000000000000.x.y" })).status).toBe(401);
    expect(h.rpc.calls.filter((c) => c.call.method !== "eth_call")).toHaveLength(0);
  });

  it("is rate limited by number of calls", async () => {
    const h = await start();
    const ten = Array.from({ length: 10 }, () => call("eth_chainId"));
    for (let i = 0; i < LIMITS.rpc.max / 10; i++) expect((await rpc(h, "base", ten)).status).toBe(200);
    expect((await rpc(h, "base", call("eth_chainId"))).status).toBe(429);
  });
});

describe("practice controls", () => {
  it("do not exist unless the practice provider is on", async () => {
    const h = await start();
    const order = asOrder(await h.order());
    expect((await h.post(`/api/practice/${order.id}`, { action: "deposit" })).status).toBe(404);
  });

  it("move a practice order along when it is on", async () => {
    const h = await start({ practice: true });
    expect((await h.get("/api/config")).body.practice).toBe(true);
    const order = asOrder(await h.order());
    expect((await h.post(`/api/practice/${order.id}`, { action: "explode" })).status).toBe(400);
    expect((await h.post(`/api/practice/${order.id}`, { action: "fail" })).status).toBe(200);
    await h.poller.tick();
    expect((await h.get(`/api/orders/${order.id}`)).body.status).toBe("failed");
  });

  it("can move the practice clock forward: to where deposit details close, then to where the order expires", async () => {
    const h = await start({ practice: true });
    const order = asOrder(await h.order());
    const started = h.clock.t;
    expect((await h.get(`/api/orders/${order.id}`)).body.depositsOpen).toBe(true);

    expect((await h.post(`/api/practice/${order.id}`, { action: "late" })).status).toBe(200);
    // One second past the point two minutes before the deadline.
    expect(h.clock.t).toBe(Date.parse(order.deadline) - 120_000 + 1000);
    const late = (await h.get(`/api/orders/${order.id}`)).body;
    expect(late).toMatchObject({ status: "waiting", depositsOpen: false, depositAddress: null });

    expect((await h.post(`/api/practice/${order.id}`, { action: "expire" })).status).toBe(200);
    await h.poller.tick();
    expect((await h.get(`/api/orders/${order.id}`)).body.status).toBe("expired");
    // The clock only ever goes forward: asking again for an earlier point changes nothing.
    const after = h.clock.t;
    expect((await h.post(`/api/practice/${order.id}`, { action: "late" })).status).toBe(200);
    expect(h.clock.t).toBe(after);
    expect(after).toBeGreaterThan(started);
  });

  it("cannot move the clock unless the practice provider is on", async () => {
    const h = await start();
    const order = asOrder(await h.order());
    const before = h.clock.t;
    for (const action of ["late", "expire"]) expect((await h.post(`/api/practice/${order.id}`, { action })).status).toBe(404);
    expect(h.clock.t).toBe(before);
  });
});

describe("quotas, repeated requests, deposit hashes, and what the server never gives away", () => {
  const HASH = `0x${"ab".repeat(32)}`;
  const NATIVE = { value: "0x11c37937e08000", input: "0x" };

  it("one client using up its own allowance leaves everyone else's untouched", async () => {
    const h = await start({ limits: { api: { max: 5, windowMs: 60_000 }, apiReadsGlobal: { max: 12, windowMs: 60_000 } } });
    const greedy: number[] = [];
    for (let i = 0; i < 40; i++) greedy.push((await h.get("/api/status", { ip: "198.51.100.1" })).status);
    expect(greedy.filter((s) => s === 200)).toHaveLength(5);
    expect(greedy.filter((s) => s === 429)).toHaveLength(35);
    // Its 35 refused requests cost the shared allowance nothing: 7 other visitors are still served.
    for (let i = 0; i < 7; i++) expect((await h.get("/api/status", { ip: `198.51.100.${i + 10}` })).status).toBe(200);
    expect((await h.get("/api/status", { ip: "198.51.100.99" })).status).toBe(429);
  });

  it("caps previews from all clients together, below the provider budget", async () => {
    const h = await start({ limits: { quoteGlobal: { max: 3, windowMs: 60_000 } } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await h.quote(QUOTE, { ip: `198.51.100.${i + 1}` })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(h.tap.quotes).toHaveLength(3);
    // A request that fails validation does not count against it.
    const fresh = await start({ limits: { quoteGlobal: { max: 1, windowMs: 60_000 } } });
    for (let i = 0; i < 3; i++) expect((await fresh.quote({ ...QUOTE, amount: "0" })).status).toBe(400);
    expect(outcome(await fresh.quote(QUOTE))).toBe("ok");
  });

  it("spends the daily and per-address order quotas only when an order is created", async () => {
    const h = await start({ limits: { orderCreateDaily: { max: 2, windowMs: 86_400_000 }, orderPerRecipient: { max: 2, windowMs: 3_600_000 }, orderCreate: { max: 100, windowMs: 60_000 } } });
    const preview = (await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView;
    const reviewed = { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: 40 };
    // Ten failed attempts of different kinds, against the same receiving address.
    for (let i = 0; i < 5; i++) {
      h.tap.nextQuote = { ok: false, kind: "unavailable", status: 503 };
      expect((await h.order({ reviewed })).status).toBe(503);
      expect(outcome(await h.order({ reviewed: { ...reviewed, amountOut: (BigInt(reviewed.amountOut) * 2n).toString() } }))).toBe("price_moved");
    }
    // The quotas are intact: two real orders still go through, and only then is the limit reached.
    expect((await h.order({ reviewed })).status).toBe(201);
    expect((await h.order({ reviewed })).status).toBe(201);
    const third = await h.order({ reviewed });
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
    // The refused third request never reached the provider.
    expect(h.tap.quotes.filter((q) => q.dry === false)).toHaveLength(12);
  });

  it("returns the same order when the same request is sent twice", async () => {
    const h = await start();
    const preview = (await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView;
    const body = { reviewed: { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: 40 }, requestId: "retry-key-0123456789-abcdef" };
    const first = await h.order(body);
    const second = await h.order(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.depositAddress).toBe(first.body.depositAddress);
    expect(h.stub.calls.liveQuotes).toBe(1);
    expect(h.store.openCount()).toBe(1);
    // Two at the same moment (a double click) also make one order.
    const twin = { ...body, requestId: "double-click-9876543210-zyxw" };
    const [a, b] = await Promise.all([h.order(twin), h.order(twin)]);
    expect(a.body.id).toBe(b.body.id);
    expect(h.stub.calls.liveQuotes).toBe(2);
    // The key belongs to whoever sent it: another address with the same key gets its own order.
    const other = await h.order(body, { ip: "198.51.100.42" });
    expect(other.status).toBe(201);
    expect(other.body.id).not.toBe(first.body.id);
    // The key belongs to the request it was first used for: the same key for a different swap is refused.
    h.clock.t += 61_000; // a fresh minute of attempts for this client
    for (const change of [{ recipient: ADDR.evm3 }, { amount: "6000000000000000" }, { to: ASSET.baseUsdc }, { refundTo: ADDR.evm2 }]) {
      const reused = await h.order({ ...body, ...change });
      expect(reused.status, JSON.stringify(change)).toBe(409);
      expect(reused.body.error.code).toBe("conflict");
    }
    expect(h.store.openCount()).toBe(3);
    // A malformed or guessable key is refused.
    h.clock.t += 61_000;
    expect((await h.order({ ...body, requestId: "short" })).status).toBe(400);
    expect((await h.order({ ...body, requestId: "only-twenty-one-chars" })).status).toBe(400);
    expect((await h.order({ ...body, requestId: 1234567890123456 })).status).toBe(400);
  });

  it("refuses new orders while the data volume is nearly full", async () => {
    let full = true;
    const h = await start({ diskFull: () => full });
    const preview = (await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView;
    const reviewed = { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: 40 };
    const refused = await h.order({ reviewed });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe("busy");
    expect(h.stub.calls.liveQuotes).toBe(0);
    full = false;
    expect((await h.order({ reviewed })).status).toBe(201);
  });

  it("closes deposits at the earlier of the provider's deadline and the refund deadline we asked for", async () => {
    const h = await start();
    const requested = h.clock.t + 30 * 60_000;
    // The provider answers with a later deadline than we asked for, properly signed.
    h.tap.corruptResponse = (data) => {
      const quote = data.quote as Record<string, unknown>;
      return quote.depositAddress === undefined ? data : h.stub.sign({ ...data, quote: { ...quote, deadline: new Date(requested + 6 * 3_600_000).toISOString() } });
    };
    const later = asOrder(await h.order());
    expect(Date.parse(later.deadline)).toBe(requested);
    // And with an earlier one.
    h.tap.corruptResponse = (data) => {
      const quote = data.quote as Record<string, unknown>;
      return quote.depositAddress === undefined ? data : h.stub.sign({ ...data, quote: { ...quote, deadline: new Date(requested - 10 * 60_000).toISOString() } });
    };
    const earlier = asOrder(await h.order({ recipient: ADDR.evm3 }));
    expect(Date.parse(earlier.deadline)).toBe(requested - 10 * 60_000);
  });

  describe("deposit hash", () => {
    async function withOrder(overrides: Record<string, unknown> = {}, options: HarnessOptions = {}) {
      const h = await start(options);
      const order = asOrder(await h.order(overrides));
      const session = await h.session();
      const post = (txHash: string, ip?: string) => h.post(`/api/orders/${order.id}/deposit`, { txHash }, { session, ...(ip ? { ip } : {}) });
      return { h, order, post };
    }

    it("refuses a transaction that was mined and failed", async () => {
      const { h, order, post } = await withOrder({ from: ASSET.baseUsdc, to: ASSET.baseEth, amount: "25000000" });
      const contract = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
      const input = `0xa9059cbb${order.depositAddress!.slice(2).padStart(64, "0")}${(25000000n).toString(16).padStart(64, "0")}`;
      h.rpc.txs.set(HASH, { from: ADDR.evm, to: contract, value: "0x0", input });
      h.rpc.receipts.set(HASH, { status: "0x0", logs: [] });
      const reverted = await post(HASH);
      expect(outcome(reverted)).toBe("not_verified");
      expect(reverted.body.error.message).toBe("That transaction failed on-chain, so nothing was deposited. Send the deposit again.");
      expect(h.store.get(order.id)?.state.depositTxHash).toBeNull();
      expect(h.stub.calls.submits).toBe(0);
      // The same transfer, mined successfully and recorded by the token, is accepted.
      h.rpc.receipts.set(HASH, { status: "0x1", logs: [transferRecord(contract, ADDR.evm, order.depositAddress!, 25000000n)] });
      expect(outcome(await post(HASH))).toBe("ok");
      expect(h.store.get(order.id)?.state).toMatchObject({ depositTxHash: HASH, depositVerified: true });
    });

    it("recognises a token transfer sent through a smart-contract wallet from its receipt", async () => {
      const { h, order, post } = await withOrder({ from: ASSET.baseUsdc, to: ASSET.baseEth, amount: "25000000" });
      const contract = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
      const topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      const word = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
      const transferLog = (token: string, to: string, amount: bigint) => ({ address: token, topics: [topic, word(ADDR.evm3), word(to)], data: `0x${amount.toString(16).padStart(64, "0")}` });
      // The outer transaction calls the wallet contract, not the token.
      h.rpc.txs.set(HASH, { from: ADDR.evm, to: ADDR.evm3, value: "0x0", input: "0x6a761202" });

      // Not mined yet: nothing to go on.
      expect(outcome(await post(HASH))).toBe("not_verified");
      h.clock.t += 61_000; // a fresh minute of attempts for this order
      // Mined, but the event is for another token, another recipient, or too little.
      for (const logs of [[transferLog(ADDR.evm2, order.depositAddress!, 25000000n)], [transferLog(contract, ADDR.evm2, 25000000n)], [transferLog(contract, order.depositAddress!, 24999999n)], [{ address: contract, topics: [topic], data: "0x" }], "nonsense"]) {
        h.rpc.receipts.set(HASH, { status: "0x1", logs });
        expect(outcome(await post(HASH)), JSON.stringify(logs).slice(0, 60)).toBe("not_verified");
      }
      expect(h.store.get(order.id)?.state.depositTxHash).toBeNull();
      h.clock.t += 61_000;
      h.rpc.receipts.set(HASH, { status: "0x1", logs: [transferLog(ADDR.evm2, ADDR.evm2, 1n), transferLog(contract, order.depositAddress!, 25000000n)] });
      expect(outcome(await post(HASH))).toBe("ok");
      expect(h.stub.calls.submits).toBe(1);
    });

    it("accepts the same hash again, and a new hash only when the first has vanished from the chain", async () => {
      const { h, order, post } = await withOrder();
      const other = `0x${"cd".repeat(32)}`;
      mine(h, HASH, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
      mine(h, other, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
      expect(outcome(await post(HASH))).toBe("ok");
      expect(outcome(await post(HASH))).toBe("ok");
      expect(h.stub.calls.submits).toBe(1);
      // The first transaction still exists: a second one is refused.
      expect((await post(other)).status).toBe(409);
      // The chain was reorganised and no longer knows the first hash.
      h.rpc.txs.delete(HASH);
      h.rpc.receipts.delete(HASH);
      const replaced = await post(other);
      expect(replaced.status).toBe(200);
      expect(replaced.body.depositTxHash).toBe(other);
      expect(h.store.get(order.id)?.state.depositTxHash).toBe(other);
    });

    it("records only one of two submissions that arrive at the same moment", async () => {
      const { h, order, post } = await withOrder();
      const other = `0x${"cd".repeat(32)}`;
      mine(h, HASH, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
      mine(h, other, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
      // Hold both chain lookups open until both requests are in flight.
      let waiting = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      h.rpc.beforeBatch = async () => {
        waiting += 1;
        if (waiting >= 2) release();
        await gate;
      };
      const [a, b] = await Promise.all([post(HASH), post(other, "198.51.100.8")]);
      h.rpc.beforeBatch = null;
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(h.stub.calls.submits).toBe(1);
      const stored = h.store.get(order.id)?.state.depositTxHash;
      expect(stored).toBe(a.status === 200 ? HASH : other);
    });

    it("screens the wallet that actually paid, and alerts on a hit", async () => {
      const { h, order, post } = await withOrder({}, { sanctions: createStaticSanctions([ADDR.evm3]) });
      // The order was made with a clean sender; the transfer came from a listed wallet.
      h.rpc.txs.set(HASH, { from: ADDR.evm3.toLowerCase(), to: order.depositAddress, ...NATIVE });
      const reply = await post(HASH);
      expect(reply.status).toBe(403);
      expect(reply.body.error).toEqual({ code: "blocked", message: "This swap can't be processed." });
      expect(h.store.get(order.id)?.state.depositTxHash).toBeNull();
      expect(h.stub.calls.submits).toBe(0);
      const alert = h.alerts.find((a) => a.kind === "sanctions_hit");
      expect(alert).toBeDefined();
      expect(alert?.text).not.toContain(ADDR.evm3);
      expect(alert?.text).not.toContain(order.id);
      expect(h.access.at(-1)?.screening).toBe("listed");
    });

    it("does not record a hash while screening is unavailable", async () => {
      let available = true;
      const real = createStaticSanctions([]);
      const { h, order, post } = await withOrder({}, { sanctions: { available: () => available, version: () => "v", screen: (a) => (available ? real.screen(a) : { ok: false, reason: "unavailable" }) } });
      h.rpc.txs.set(HASH, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
      available = false;
      expect((await post(HASH)).status).toBe(503);
      expect(h.store.get(order.id)?.state.depositTxHash).toBeNull();
      available = true;
      expect(outcome(await post(HASH))).toBe("ok");
    });
  });

  it("applies the real screening code, loaded from a real-format list, inside the order route", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-sdn-route-"));
    try {
      const filler = Array.from({ length: 320 }, (_, i) => `<id><uid>${i}</uid><idType>Digital Currency Address - XBT</idType><idNumber>1Filler${String(i).padStart(27, "0")}</idNumber></id>`).join("");
      const xml = `<sdnList><publshInformation><Publish_Date>10/05/2026</Publish_Date></publshInformation><sdnEntry><idList>${filler}<id><uid>900</uid><idType>Digital Currency Address - ETH</idType><idNumber>${ADDR.evm3.toLowerCase()}</idNumber></id></idList></sdnEntry></sdnList>`;
      const sanctions = createSanctions({ dataDir: dir, log: silentLogger, alerts: { send() {} }, fetchImpl: async () => new Response(xml), now: () => Date.parse("2026-10-08T12:00:00.000Z") });
      const h = await start({ sanctions });
      const preview = (await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView;
      const reviewed = { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: 40 };
      // Before the list has loaded, orders are refused.
      expect((await h.order({ reviewed })).status).toBe(503);
      await sanctions.refresh();
      // A listed recipient, in a different letter case from the list, is refused.
      const blocked = await h.order({ reviewed, recipient: ADDR.evm3 });
      expect(blocked.status).toBe(403);
      expect(h.stub.calls.liveQuotes).toBe(0);
      // A clean order goes through and records the list's date.
      const order = asOrder(await h.order({ reviewed }));
      expect(h.store.get(order.id)?.screening).toMatchObject({ result: "clear", listVersion: "2026-10-05" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never reveals a secret even when the services it calls misbehave", async () => {
    const key = "aaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc";
    const rpcUrl = "https://rpc.example/v2/SUPER-SECRET-RPC-KEY";
    const hook = "https://hooks.example/services/SECRET-HOOK";
    const seen: Array<{ url: string; key: string | undefined }> = [];
    // A pretend network in which every service reflects what it was sent, or fails with it in the error text.
    const network: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, key: headers["x-api-key"] });
      if (url.includes("/v0/tokens")) return new Response(JSON.stringify(FIXTURE_TOKENS));
      if (url.includes("/v0/quote")) return new Response(JSON.stringify({ message: `rejected key ${headers["x-api-key"]} for ${rpcUrl}` }), { status: 400 });
      if (url.startsWith("https://rpc.example")) throw new Error(`connect ECONNREFUSED ${url}`);
      if (url.startsWith("https://hooks.example")) throw new Error(`webhook ${url} is down`);
      throw new Error(`unexpected request to ${url} with ${JSON.stringify(headers)}`);
    };
    const h = await start({
      env: { ONECLICK_API_KEY: key, BASE_RPC_URL: rpcUrl, BSC_RPC_URL: rpcUrl, ETH_RPC_URL: rpcUrl, ARBITRUM_RPC_URL: rpcUrl, ALERT_WEBHOOK_URL: hook },
      network,
    });
    const replies = [
      await h.get("/api/config"),
      await h.get("/api/status"),
      await h.get("/api/tokens"),
      await h.quote(QUOTE),
      await h.get("/api/orders/nope"),
      await h.post("/api/rpc/base", { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { session: await h.session() }),
      await h.post("/api/rpc/base", [{ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: ADDR.evm, data: "0x" }, "latest"] }], { session: await h.session() }),
    ];
    // Force an alert so the webhook client runs and fails.
    h.tap.degraded = false;
    await h.post("/api/quote", QUOTE, { session: await h.session() });
    const listWithBadCoin = (FIXTURE_TOKENS as Array<Record<string, unknown>>).map((t) => (t.assetId === ASSET.baseUsdc ? { ...t, decimals: 18 } : t));
    const second = await start({
      env: { ONECLICK_API_KEY: key, BASE_RPC_URL: rpcUrl, ALERT_WEBHOOK_URL: hook },
      network: async (input, init) => (String(input).includes("/v0/tokens") ? new Response(JSON.stringify(listWithBadCoin)) : network(input, init)),
    });
    replies.push(await second.get("/api/tokens"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The secrets really were in play: the key was sent to the provider, the RPC and webhook URLs were called.
    expect(seen.some((call) => call.key === key)).toBe(true);
    expect(seen.some((call) => call.url === hook)).toBe(true);
    expect(second.alerts.map((a) => a.kind)).toContain("token_mismatch");
    expect(second.logs.some((line) => line.includes("alert_delivery_failed"))).toBe(true);

    const everything = [
      ...replies.map((r) => r.text + JSON.stringify([...r.headers.entries()])),
      ...h.logs,
      ...second.logs,
      JSON.stringify(h.access),
      JSON.stringify(second.access),
      JSON.stringify(h.alerts),
      JSON.stringify(second.alerts),
    ].join("\n");
    for (const secret of [key, "aaaaaaaaaaaa", "SUPER-SECRET-RPC-KEY", "rpc.example", "SECRET-HOOK", "hooks.example", "ECONNREFUSED"]) {
      expect(everything, secret).not.toContain(secret);
    }
    // And the person still got our own plain words.
    expect(replies[3]!.body.error.message).toBe("No route for this pair right now.");
  });

  it("cuts off a body that keeps coming without declaring its size", async () => {
    const h = await start();
    const session = await h.session();
    const { request } = await import("node:http");
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(`${h.url}/api/quote`, { method: "POST", headers: { "content-type": "application/json", origin: h.url, "x-session": session, "x-forwarded-for": "203.0.113.10", "transfer-encoding": "chunked" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", (err) => {
        // The server may close the connection once it has answered; that is the cap working.
        if ((err as NodeJS.ErrnoException).code === "ECONNRESET" || (err as NodeJS.ErrnoException).code === "EPIPE") resolve({ status: 413, body: "" });
        else reject(err);
      });
      // No Content-Length: 40 chunks of 1 KB against a 2 KB limit.
      req.write('{"padding":"');
      for (let i = 0; i < 40; i++) req.write("x".repeat(1024));
      req.end('"}');
    });
    expect(reply.status).toBe(413);
    expect(h.tap.quotes).toHaveLength(0);
  });

  it("logs a header disagreement at most once a minute and never with text the client chose", async () => {
    const h = await start({ geo: createStaticGeo({}, { country: null, blocked: true, reason: "unknown" }) });
    const forged = { "x-forwarded-for": "203.0.113.5", "x-real-ip": "198.51.100.66" };
    for (let i = 0; i < 5; i++) await h.get(`/api/<script>${i}`, { headers: forged });
    const lines = () => h.logs.filter((line) => line.includes("proxy_headers_disagree"));
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).not.toContain("script");
    h.clock.t += 61_000;
    await h.get("/api/config", { headers: forged });
    expect(lines()).toHaveLength(2);
  });
});

describe("limits no one visitor can use up, and what a deposit hash proves", () => {
  const HASH = `0x${"ab".repeat(32)}`;
  const OTHER = `0x${"cd".repeat(32)}`;
  const NATIVE = { value: "0x11c37937e08000", input: "0x" };
  const reviewedFor = async (h: Harness) => {
    const preview = (await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView;
    return { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: 40 };
  };

  it("does not let refused attempts use up what all clients share", async () => {
    // 20 addresses each try an order to a listed recipient, again and again.
    const h = await start({ sanctions: createStaticSanctions([ADDR.evm3]), limits: { orderCreateGlobal: { max: 2, windowMs: 60_000 } } });
    const reviewed = await reviewedFor(h);
    for (let i = 0; i < 20; i++) expect((await h.order({ reviewed, recipient: ADDR.evm3 }, { ip: `198.51.100.${i + 1}` })).status).toBe(403);
    // The shared allowance is untouched: honest orders still go through.
    expect((await h.order({ reviewed }, { ip: "203.0.113.50" })).status).toBe(201);
    expect((await h.order({ reviewed }, { ip: "203.0.113.51" })).status).toBe(201);
    expect((await h.order({ reviewed }, { ip: "203.0.113.52" })).status).toBe(429);
    expect(h.stub.calls.liveQuotes).toBe(2);
  });

  it("caps how many attempts, and how many real provider orders, one client can cause in a day", async () => {
    const attempts = await start({ sanctions: createStaticSanctions([ADDR.evm3]), limits: { orderAttemptDaily: { max: 3, windowMs: 86_400_000 }, orderCreate: { max: 100, windowMs: 60_000 } } });
    const reviewed = await reviewedFor(attempts);
    const results: number[] = [];
    for (let i = 0; i < 5; i++) results.push((await attempts.order({ reviewed, recipient: ADDR.evm3 })).status);
    expect(results).toEqual([403, 403, 403, 429, 429]);

    // A reviewed price that is deliberately too good makes the provider issue an order that is then refused.
    const live = await start({ limits: { orderLiveDaily: { max: 2, windowMs: 86_400_000 }, orderCreate: { max: 100, windowMs: 60_000 } } });
    const honest = await reviewedFor(live);
    const inflated = { ...honest, amountOut: (BigInt(honest.amountOut) * 2n).toString() };
    expect(outcome(await live.order({ reviewed: inflated }))).toBe("price_moved");
    expect(outcome(await live.order({ reviewed: inflated }))).toBe("price_moved");
    // That is counted. The third never reaches the provider.
    expect(outcome(await live.order({ reviewed: inflated }))).toBe("rate_limited");
    expect(outcome(await live.order({ reviewed: honest }))).toBe("rate_limited");
    expect(live.stub.calls.liveQuotes).toBe(2);
    // Another client is unaffected.
    expect((await live.order({ reviewed: honest }, { ip: "198.51.100.9" })).status).toBe(201);
  });

  it("limits how many unpaid orders one client can hold open", async () => {
    const h = await start({ limits: { orderCreate: { max: 100, windowMs: 60_000 }, orderPerRecipient: { max: 100, windowMs: 3_600_000 } } });
    const reviewed = await reviewedFor(h);
    const created: OrderView[] = [];
    for (let i = 0; i < 10; i++) created.push(asOrder(await h.order({ reviewed })));
    const eleventh = await h.order({ reviewed });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.message).toBe("You have several unpaid orders open. Pay one or wait for it to expire, then try again.");
    expect(h.stub.calls.liveQuotes).toBe(10);
    // Another client is unaffected.
    expect((await h.order({ reviewed }, { ip: "198.51.100.9" })).status).toBe(201);
    // A deposit that has only been announced frees nothing...
    h.stub.control(created[0]!.depositAddress!, "deposit");
    h.clock.t += 5500;
    await h.poller.tick();
    expect(h.store.get(created[0]!.id)?.state.status).toBe("deposit_seen");
    expect((await h.order({ reviewed })).status).toBe(429);
    // ...once the swap has started, a place is free. (With this many unpaid orders, each waits its turn to be checked.)
    h.clock.t += 10_000;
    await h.poller.tick();
    expect(h.store.get(created[0]!.id)?.state.status).toBe("swapping");
    expect((await h.order({ reviewed })).status).toBe(201);
  });

  it("holds each quota from the moment a request starts, so requests arriving together cannot all slip under it", async () => {
    for (const limits of [{ orderCreateDaily: { max: 1, windowMs: 86_400_000 } }, { orderPerRecipient: { max: 1, windowMs: 3_600_000 } }] as const) {
      const h = await start({ limits });
      const reviewed = await reviewedFor(h);
      const replies = await sentTogether(h, Array.from({ length: 5 }, () => () => h.order({ reviewed })));
      expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
      expect(replies.filter((r) => r.status === 429)).toHaveLength(4);
      expect(h.stub.calls.liveQuotes).toBe(1);
    }
    const capped = await start({ maxOpenOrders: 1 });
    const reviewed = await reviewedFor(capped);
    const replies = await sentTogether(capped, Array.from({ length: 5 }, (_, i) => () => capped.order({ reviewed }, { ip: `198.51.100.${i + 1}` })));
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 503)).toHaveLength(4);
    expect(capped.store.openCount()).toBe(1);
  });

  it("gives a reserved quota back when no order results", async () => {
    const h = await start({ limits: { orderCreateDaily: { max: 1, windowMs: 86_400_000 }, orderPerRecipient: { max: 1, windowMs: 3_600_000 }, orderCreate: { max: 100, windowMs: 60_000 } } });
    const reviewed = await reviewedFor(h);
    for (let i = 0; i < 3; i++) {
      h.tap.nextQuote = { ok: false, kind: "unavailable", status: 503 };
      expect((await h.order({ reviewed })).status).toBe(503);
    }
    expect((await h.order({ reviewed })).status).toBe(201);
    expect((await h.order({ reviewed })).status).toBe(429);
  });

  it("counts an IPv6 network as one visitor at /48 as well as /64", async () => {
    const h = await start({ limits: { apiWide: { max: 6, windowMs: 60_000 } } });
    const statuses: number[] = [];
    // Eight different /64 networks inside one /48.
    for (let i = 0; i < 8; i++) statuses.push((await h.get("/api/tokens", { ip: `2001:db8:77:${i + 1}::1` })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429, 429]);
    expect((await h.get("/api/tokens", { ip: "2001:db8:78:1::1" })).status).toBe(200);
    expect((await h.get("/api/tokens", { ip: "203.0.113.77" })).status).toBe(200);
  });

  it("limits the status answers that skip the region block", async () => {
    const h = await start({ geo: createStaticGeo({}, { country: null, blocked: true, reason: "unknown" }), limits: { statusExempt: { max: 3, windowMs: 60_000 } } });
    const direct = () => fetch(`${h.url}/api/status`).then((r) => r.status);
    expect([await direct(), await direct(), await direct(), await direct()]).toEqual([200, 200, 200, 429]);
  });

  it("applies the $1,000,000 limit to the provider's own valuation, not only to the list price", async () => {
    const h = await start();
    // By list price this is $12.50; the provider's signed quote values it at over a million.
    h.tap.corruptResponse = (data) => h.stub.sign({ ...data, quote: { ...(data.quote as object), amountInUsd: "1000000.01" } });
    const over = await h.quote(QUOTE);
    expect(over.body.error).toEqual({ code: "too_large", message: "Swaps are limited to $1,000,000." });
    h.tap.corruptResponse = (data) => h.stub.sign({ ...data, quote: { ...(data.quote as object), amountInUsd: "1000000.00" } });
    expect(outcome(await h.quote(QUOTE))).toBe("ok");
  });

  it("limits page requests per visitor", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-pages-"));
    try {
      fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>IntentSwap</title>");
      const h = await start({ site: loadStaticSite(dir), limits: { pages: { max: 3, windowMs: 60_000 } } });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await h.get("/")).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      expect((await h.get("/", { ip: "198.51.100.9" })).status).toBe(200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("deposit hash", () => {
    async function withOrder(overrides: Record<string, unknown> = {}, options: HarnessOptions = {}) {
      const h = await start(options);
      const order = asOrder(await h.order(overrides));
      const session = await h.session();
      const post = (txHash: string) => h.post(`/api/orders/${order.id}/deposit`, { txHash }, { session });
      return { h, order, post };
    }
    const topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const word = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

    it("screens the wallet the coins really came from when they were sent through a contract wallet", async () => {
      // The relayer that sent the transaction is clean. The wallet named in the transfer event is listed.
      const { h, order, post } = await withOrder({ from: ASSET.baseUsdc, to: ASSET.baseEth, amount: "25000000" }, { sanctions: createStaticSanctions([ADDR.evm3]) });
      const contract = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
      const relayer = `0x${"77".repeat(20)}`;
      h.rpc.txs.set(HASH, { from: relayer, to: `0x${"88".repeat(20)}`, value: "0x0", input: "0x6a761202" });
      h.rpc.receipts.set(HASH, { status: "0x1", logs: [{ address: contract, topics: [topic, word(ADDR.evm3), word(order.depositAddress!)], data: `0x${(25000000n).toString(16).padStart(64, "0")}` }] });
      const reply = await post(HASH);
      expect(reply.status).toBe(403);
      expect(reply.body.error.code).toBe("blocked");
      expect(h.alerts.map((a) => a.kind)).toContain("sanctions_hit");
      expect(h.store.get(order.id)?.state.depositTxHash).toBeNull();
      expect(h.stub.calls.submits).toBe(0);
      // The same payment from a clean wallet is recorded.
      h.rpc.receipts.set(OTHER, { status: "0x1", logs: [{ address: contract, topics: [topic, word(ADDR.evm2), word(order.depositAddress!)], data: `0x${(25000000n).toString(16).padStart(64, "0")}` }] });
      h.rpc.txs.set(OTHER, { from: relayer, to: `0x${"88".repeat(20)}`, value: "0x0", input: "0x6a761202" });
      expect(outcome(await post(OTHER))).toBe("ok");
    });

    it("keeps a pending transaction as a note, and lets it be replaced when it fails", async () => {
      const { h, order, post } = await withOrder({ from: ASSET.baseUsdc, to: ASSET.baseEth, amount: "25000000" });
      const input = `0xa9059cbb${order.depositAddress!.slice(2).padStart(64, "0")}${(25000000n).toString(16).padStart(64, "0")}`;
      h.rpc.txs.set(HASH, { from: ADDR.evm, to: USDC_BASE, value: "0x0", input });
      // Noted while pending, but it proves nothing yet.
      const noted = await post(HASH);
      expect(outcome(noted)).toBe("ok");
      expect(noted.body).toMatchObject({ depositTxHash: HASH, depositTxUrl: null, status: "waiting" });
      expect(noted.body.depositAddress).toBe(order.depositAddress);
      expect(h.store.get(order.id)?.state).toMatchObject({ depositTxHash: HASH, depositVerified: false });
      expect(isFunded(h.store.get(order.id)!.state)).toBe(false);
      expect(h.stub.calls.submits).toBe(0);
      // It is mined and fails. Sending the same hash again says so...
      h.rpc.receipts.set(HASH, { status: "0x0", logs: [] });
      expect((await post(HASH)).body.error.message).toBe("That transaction failed on-chain, so nothing was deposited. Send the deposit again.");
      // ...and the re-sent deposit's hash takes its place.
      mine(h, OTHER, { from: ADDR.evm, to: USDC_BASE, value: "0x0", input }, [transferRecord(USDC_BASE, ADDR.evm, order.depositAddress!, 25000000n)]);
      const replaced = await post(OTHER);
      expect(outcome(replaced)).toBe("ok");
      expect(replaced.body.depositTxHash).toBe(OTHER);
      expect(h.store.get(order.id)?.state.depositVerified).toBe(true);
      // A transaction that was mined and succeeded is never replaced.
      expect((await post(`0x${"ef".repeat(32)}`)).status).toBe(409);
    });

    it("confirms a pending transaction when the same hash is sent again after it is mined", async () => {
      const { h, order, post } = await withOrder();
      h.rpc.txs.set(HASH, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
      expect((await post(HASH)).body).toMatchObject({ status: "waiting", depositTxUrl: null });
      expect(h.stub.calls.submits).toBe(0);
      // Still pending: nothing changes, however often it is sent.
      expect((await post(HASH)).body.depositTxUrl).toBeNull();
      expect(h.store.get(order.id)?.state.depositSubmissions).toBe(1);
      // Mined: now it is proof, it is linked, and it is passed on to the provider.
      h.rpc.receipts.set(HASH, { status: "0x1", logs: [] });
      const confirmed = await post(HASH);
      expect(confirmed.body).toMatchObject({ status: "deposit_seen", depositTxUrl: `https://basescan.org/tx/${HASH}` });
      expect(h.store.get(order.id)?.state).toMatchObject({ depositVerified: true, depositForwarded: true, depositSubmissions: 1 });
      expect(h.stub.calls.submits).toBe(1);
    });

    it("treats a hash it could not confirm as a note, not as proof", async () => {
      const { h, order, post } = await withOrder({ from: ASSET.btc, to: ASSET.arbUsdc, amount: "1000000", pay: "manual", sender: undefined, refundTo: ADDR.btc });
      const first = await post("ab".repeat(32));
      expect(outcome(first)).toBe("ok");
      // No link is offered for a transaction nobody has checked.
      expect(first.body.depositTxHash).toBe("ab".repeat(32));
      expect(first.body.depositTxUrl).toBeNull();
      const stored = h.store.get(order.id)!;
      expect(stored.state.depositVerified).toBe(false);
      // It does not move the order into the "funds in motion" class...
      expect(isFunded(stored.state)).toBe(false);
      // ...and the person can correct it while the order is still waiting.
      const second = await post("cd".repeat(32));
      expect(outcome(second)).toBe("ok");
      expect(second.body.depositTxHash).toBe("cd".repeat(32));
      expect(h.stub.calls.submits).toBe(2);
    });

    it("links a confirmed transaction and counts it as funds in motion", async () => {
      const { h, order, post } = await withOrder();
      mine(h, HASH, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
      const reply = await post(HASH);
      expect(reply.body.depositTxUrl).toBe(`https://basescan.org/tx/${HASH}`);
      expect(isFunded(h.store.get(order.id)!.state)).toBe(true);
    });

    it("offers the hash to the provider again when the first attempt to pass it on failed", async () => {
      const { h, order, post } = await withOrder();
      mine(h, HASH, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
      h.tap.submitFails = true;
      expect(outcome(await post(HASH))).toBe("ok");
      expect(h.store.get(order.id)?.state).toMatchObject({ depositTxHash: HASH, depositForwarded: false });
      // Sending the same hash again does not help by itself...
      expect(outcome(await post(HASH))).toBe("ok");
      expect(h.stub.calls.submits).toBe(0);
      // ...the tracker retries on its own.
      h.clock.t += 5500;
      await h.poller.tick();
      expect(h.store.get(order.id)?.state.depositForwarded).toBe(false);
      h.tap.submitFails = false;
      h.clock.t += 5500;
      await h.poller.tick();
      expect(h.stub.calls.submits).toBe(1);
      expect(h.store.get(order.id)?.state.depositForwarded).toBe(true);
      // Once passed on, it is not sent again.
      h.clock.t += 5500;
      await h.poller.tick();
      expect(h.stub.calls.submits).toBe(1);
    });
  });
});

describe("an address typed in another valid spelling", () => {
  it("is stored and returned in its one standard spelling, which is what the review sheet shows and compares", async () => {
    const h = await start();
    const lower = ADDR.evm2.toLowerCase();
    expect(lower).not.toBe(ADDR.evm2);
    // The preview already answers with the same quote either way.
    const order = asOrder(await h.order({ recipient: lower, refundTo: ADDR.evm.toLowerCase(), sender: ADDR.evm.toLowerCase() }));
    expect(order.recipient).toBe(ADDR.evm2);
    expect(order.refundTo).toBe(ADDR.evm);
    // What the review sheet does with it: normalise first, then compare exactly.
    const shown = checkAddress("arb", lower);
    expect(shown.ok && shown.address).toBe(order.recipient);
    expect(orderDiffers(order, { from: order.from.id, to: order.to.id, amountIn: order.amountIn, minAmountOut: order.minAmountOut, slippageBps: order.slippageBps, recipient: ADDR.evm2, refundTo: ADDR.evm })).toBeNull();
    // Compared as typed, it would not match: that was the fault.
    expect(orderDiffers(order, { from: order.from.id, to: order.to.id, amountIn: order.amountIn, minAmountOut: order.minAmountOut, slippageBps: order.slippageBps, recipient: lower, refundTo: ADDR.evm })).toBe("the receiving address");
  });
});

describe("the provider's call classes, proven funds, and order quotas by network", () => {
  const NATIVE = { value: "0x11c37937e08000", input: "0x" };
  const BTC_ORDER = { from: ASSET.btc, to: ASSET.arbUsdc, amount: "1000000", pay: "manual", sender: undefined, refundTo: ADDR.btc };
  const DAY = 86_400_000;
  // Receiving addresses for many orders: one hex digit repeated, never the preview stand-in (all ones).
  const to = (i: number) => `0x${(i + 2).toString(16).repeat(40)}`;
  const seenReply = (address: string, status: string, hash: string) => ({
    ok: true as const,
    status: 200,
    data: { status, quoteResponse: { quote: { depositAddress: address } }, swapDetails: { originChainTxHashes: [{ hash }], depositedAmount: "1000000" } },
  });

  it("asks for a new order's real quote in a class of its own, which previews cannot use up", async () => {
    const h = await start();
    await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm });
    expect(h.tap.quoteClasses).toEqual(["user"]);
    expect((await h.order()).status).toBe(201);
    // One more preview (for the reviewed numbers), then the real quote for the order.
    expect(h.tap.quoteClasses).toEqual(["user", "user", "order"]);
  });

  describe("what counts as funds in an order", () => {
    it("does not let transactions that were only broadcast move orders into the class that is checked first", async () => {
      const h = await start({ limits: { orderCreate: { max: 100, windowMs: 60_000 } } });
      const session = await h.session();
      // Several orders, each given the hash of a transfer that is in no block (and may never be).
      for (let i = 0; i < 4; i++) {
        const order = asOrder(await h.order({ recipient: to(i) }));
        const hash = `0x${String(i + 1).repeat(64)}`;
        h.rpc.txs.set(hash, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
        expect(outcome(await h.post(`/api/orders/${order.id}/deposit`, { txHash: hash }, { session }))).toBe("ok");
        expect(isFunded(h.store.get(order.id)!.state)).toBe(false);
      }
      expect(h.stub.calls.submits).toBe(0);
      h.clock.t += 5500;
      await h.poller.tick();
      // Every one of them is still checked as an unpaid order.
      expect(h.tap.statusClasses).toEqual(["idle", "idle", "idle", "idle"]);
      expect(h.tap.submitClasses).toEqual([]);
    });

    it("does not let 'deposit seen' for a hash nobody confirmed hide the deposit details, add a link or raise the order's priority", async () => {
      const h = await start();
      const order = asOrder(await h.order(BTC_ORDER));
      const session = await h.session();
      const bogus = "ab".repeat(32);
      expect(outcome(await h.post(`/api/orders/${order.id}/deposit`, { txHash: bogus }, { session }))).toBe("ok");
      // The provider was told about the hash and now reports the deposit as seen. Nothing has arrived.
      h.tap.statusReply = (address) => seenReply(address, "KNOWN_DEPOSIT_TX", bogus);
      h.clock.t += 5500;
      await h.poller.tick();
      const stored = h.store.get(order.id)!;
      expect(stored.state.status).toBe("deposit_seen");
      expect(isFunded(stored.state)).toBe(false);
      const view = (await h.get(`/api/orders/${order.id}`)).body as OrderView;
      expect(view.status).toBe("deposit_seen");
      // The person who has yet to pay still sees where to pay...
      expect(view.depositsOpen).toBe(true);
      expect(view.depositAddress).toBe(order.depositAddress);
      // ...and nothing presents the unchecked hash as their deposit.
      expect(view.depositTxUrl).toBeNull();
      expect(view.details?.originTxs).toEqual([]);
      expect(JSON.stringify(view)).not.toContain("mempool.space");
      // It is still checked as an unpaid order.
      h.tap.statusClasses.length = 0;
      h.clock.t += 5500;
      await h.poller.tick();
      expect(h.tap.statusClasses).toEqual(["idle"]);

      // Once the provider has started on the order the deposit is real: details close, its transaction is shown.
      h.tap.statusReply = (address) => seenReply(address, "PROCESSING", bogus);
      h.clock.t += 5500;
      await h.poller.tick();
      const later = (await h.get(`/api/orders/${order.id}`)).body as OrderView;
      expect(later.status).toBe("swapping");
      expect(later.depositAddress).toBeNull();
      expect(later.details?.originTxs).toEqual([{ hash: bogus, url: `https://mempool.space/tx/${bogus}` }]);
      expect(isFunded(h.store.get(order.id)!.state)).toBe(true);
    });

    it("keeps the deposit details on show when the provider reports a deposit as seen and nobody gave a hash", async () => {
      const h = await start();
      const order = asOrder(await h.order(BTC_ORDER));
      // Anyone can tell the provider about a transaction for any deposit address.
      h.tap.statusReply = (address) => seenReply(address, "KNOWN_DEPOSIT_TX", "cd".repeat(32));
      h.clock.t += 5500;
      await h.poller.tick();
      expect(isFunded(h.store.get(order.id)!.state)).toBe(false);
      const view = (await h.get(`/api/orders/${order.id}`)).body as OrderView;
      expect(view).toMatchObject({ status: "deposit_seen", depositsOpen: true, depositAddress: order.depositAddress });
      expect(view.details?.originTxs).toEqual([]);
    });
  });

  describe("deposit hashes, smaller points", () => {
    const HASH = `0x${"ab".repeat(32)}`;
    const data = (address: string, amount: bigint) => `0xa9059cbb${address.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;

    it("accepts a hash it can confirm even after three corrections", async () => {
      const h = await start({ limits: { depositPerOrder: { max: 100, windowMs: 60_000 } } });
      const order = asOrder(await h.order());
      const session = await h.session();
      const post = (txHash: string) => h.post(`/api/orders/${order.id}/deposit`, { txHash }, { session });
      // Three pending transactions in a row (a wallet speeding up its own transfer).
      for (const digit of ["1", "2", "3"]) {
        h.rpc.txs.set(`0x${digit.repeat(64)}`, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
        expect(outcome(await post(`0x${digit.repeat(64)}`))).toBe("ok");
      }
      // A fourth that is also only pending is turned away...
      h.rpc.txs.set(`0x${"4".repeat(64)}`, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
      expect((await post(`0x${"4".repeat(64)}`)).status).toBe(409);
      // ...but the one that was mined is taken, because it is proof.
      mine(h, HASH, { from: ADDR.evm, to: order.depositAddress, ...NATIVE });
      const confirmed = await post(HASH);
      expect(outcome(confirmed)).toBe("ok");
      expect(confirmed.body).toMatchObject({ depositTxHash: HASH, depositProven: true, status: "deposit_seen" });
    });

    it("recognises a token deposit made in two transfers within one transaction", async () => {
      const h = await start();
      const order = asOrder(await h.order({ from: ASSET.baseUsdc, to: ASSET.baseEth, amount: "25000000" }));
      const session = await h.session();
      const post = (txHash: string) => h.post(`/api/orders/${order.id}/deposit`, { txHash }, { session });
      const wallet = { from: ADDR.evm, to: ADDR.evm3, value: "0x0", input: "0x6a761202" };
      // Two parts that fall short together are not enough.
      mine(h, HASH, wallet, [transferRecord(USDC_BASE, ADDR.evm2, order.depositAddress!, 10000000n), transferRecord(USDC_BASE, ADDR.evm2, order.depositAddress!, 14999999n)]);
      expect(outcome(await post(HASH))).toBe("not_verified");
      // Parts to another address, or of another token, do not count toward the total.
      mine(h, HASH, wallet, [transferRecord(USDC_BASE, ADDR.evm2, order.depositAddress!, 10000000n), transferRecord(USDC_BASE, ADDR.evm2, ADDR.evm3, 15000000n), transferRecord(ADDR.evm2, ADDR.evm2, order.depositAddress!, 15000000n)]);
      expect(outcome(await post(HASH))).toBe("not_verified");
      mine(h, HASH, wallet, [transferRecord(USDC_BASE, ADDR.evm2, order.depositAddress!, 10000000n), transferRecord(USDC_BASE, ADDR.evm2, order.depositAddress!, 15000000n)]);
      expect(outcome(await post(HASH))).toBe("ok");
      expect(h.store.get(order.id)?.state.depositVerified).toBe(true);
      void data;
    });

    it("screens every wallet that paid a part", async () => {
      const h = await start({ sanctions: createStaticSanctions([ADDR.evm3]) });
      const order = asOrder(await h.order({ from: ASSET.baseUsdc, to: ASSET.baseEth, amount: "25000000" }));
      const session = await h.session();
      mine(h, HASH, { from: ADDR.evm, to: `0x${"88".repeat(20)}`, value: "0x0", input: "0x6a761202" }, [transferRecord(USDC_BASE, ADDR.evm2, order.depositAddress!, 10000000n), transferRecord(USDC_BASE, ADDR.evm3, order.depositAddress!, 15000000n)]);
      const reply = await h.post(`/api/orders/${order.id}/deposit`, { txHash: HASH }, { session });
      expect(reply.status).toBe(403);
      expect(h.store.get(order.id)?.state.depositTxHash).toBeNull();
    });

    it("says plainly in the order whether a deposit is proven", async () => {
      const h = await start();
      const order = asOrder(await h.order(BTC_ORDER));
      expect(order.depositProven).toBe(false);
      h.tap.statusReply = (address) => seenReply(address, "KNOWN_DEPOSIT_TX", "cd".repeat(32));
      h.clock.t += 5500;
      await h.poller.tick();
      expect((await h.get(`/api/orders/${order.id}`)).body).toMatchObject({ status: "deposit_seen", depositProven: false });
      h.tap.statusReply = (address) => seenReply(address, "PROCESSING", "cd".repeat(32));
      h.clock.t += 5500;
      await h.poller.tick();
      expect((await h.get(`/api/orders/${order.id}`)).body).toMatchObject({ status: "swapping", depositProven: true });
    });
  });

  describe("passing hashes on to the provider", () => {
    it("lets the hash of one order be set three times, then no more", async () => {
      const h = await start({ limits: { depositPerOrder: { max: 100, windowMs: 60_000 } } });
      const order = asOrder(await h.order(BTC_ORDER));
      const session = await h.session();
      const post = (txHash: string) => h.post(`/api/orders/${order.id}/deposit`, { txHash }, { session });
      for (const digit of ["1", "2", "3"]) expect(outcome(await post(digit.repeat(64)))).toBe("ok");
      // The same hash again is still fine; a fourth different one is not.
      expect(outcome(await post("3".repeat(64)))).toBe("ok");
      const fourth = await post("4".repeat(64));
      expect(fourth.status).toBe(409);
      expect(fourth.body.error.message).toBe("The transaction for this order can't be changed again. Your deposit will still be picked up automatically.");
      expect(h.store.get(order.id)?.state).toMatchObject({ depositTxHash: "3".repeat(64), depositSubmissions: 3 });
      expect(h.stub.calls.submits).toBe(3);
    });

    it("passes on unconfirmed hashes within one limit for all clients, in the class of the unpaid orders", async () => {
      const h = await start({ limits: { depositForwardGlobal: { max: 2, windowMs: 60_000 } } });
      const session = await h.session();
      const orders: OrderView[] = [];
      for (let i = 0; i < 4; i++) orders.push(asOrder(await h.order({ ...BTC_ORDER, recipient: to(i) })));
      for (const [i, order] of orders.entries()) {
        // Recorded for every order...
        expect(outcome(await h.post(`/api/orders/${order.id}/deposit`, { txHash: String(i + 1).repeat(64) }, { session }))).toBe("ok");
      }
      // ...but only two were passed on straight away, and none in the class kept for people's requests.
      expect(h.tap.submitClasses).toEqual(["idle", "idle"]);
      expect(orders.map((o) => h.store.get(o.id)!.state.depositForwarded)).toEqual([true, true, false, false]);
    });

    it("starts counting again when a hash is replaced, and marks a hash as passed on only if it is still the one on record", async () => {
      const h = await start({ limits: { depositPerOrder: { max: 100, windowMs: 60_000 } } });
      const order = asOrder(await h.order(BTC_ORDER));
      const session = await h.session();
      const post = (txHash: string) => h.post(`/api/orders/${order.id}/deposit`, { txHash }, { session });
      // The provider keeps failing: the tracker offers the first hash five times and then stops.
      h.tap.statusReply = (address) => ({ ok: true, status: 200, data: { status: "PENDING_DEPOSIT", quoteResponse: { quote: { depositAddress: address } }, swapDetails: {} } });
      h.tap.submitFails = true;
      expect(outcome(await post("1".repeat(64)))).toBe("ok");
      for (let i = 0; i < 8; i++) {
        h.clock.t += 16_000;
        await h.poller.tick();
      }
      // One attempt when it was recorded, five more by the tracker.
      expect(h.tap.submitClasses).toHaveLength(6);
      // A corrected hash gets its own five attempts.
      expect(outcome(await post("2".repeat(64)))).toBe("ok");
      for (let i = 0; i < 8; i++) {
        h.clock.t += 16_000;
        await h.poller.tick();
      }
      expect(h.tap.submitClasses).toHaveLength(12);
      expect(new Set(h.tap.submitClasses)).toEqual(new Set(["idle"]));
      expect(h.store.get(order.id)?.state.depositForwarded).toBe(false);
    });
  });

  describe("order quotas", () => {
    // Four visitors in four /64 networks of one /48, and one in another /48.
    const sameNetwork = ["2001:db8:1:1::5", "2001:db8:1:2::5", "2001:db8:1:3::5", "2001:db8:1:4::5"];
    const elsewhere = "2001:db8:2:1::5";

    it("counts created orders by the wider IPv6 network as well as by visitor", async () => {
      const h = await start({ limits: { orderCreateDailyWide: { max: 3, windowMs: DAY } } });
      const results: number[] = [];
      for (const [i, ip] of sameNetwork.entries()) results.push((await h.order({ recipient: to(i) }, { ip })).status);
      expect(results).toEqual([201, 201, 201, 429]);
      expect((await h.order({ recipient: to(5) }, { ip: elsewhere })).status).toBe(201);
      // An IPv4 visitor has no wider network and is counted once.
      expect((await h.order({ recipient: to(6) }, { ip: "198.51.100.7" })).status).toBe(201);
    });

    it("counts order attempts and real provider orders by the wider network too", async () => {
      const attempts = await start({ limits: { orderAttemptDailyWide: { max: 2, windowMs: DAY } } });
      const a: number[] = [];
      for (const [i, ip] of sameNetwork.entries()) a.push((await attempts.order({ recipient: to(i) }, { ip })).status);
      expect(a).toEqual([201, 201, 429, 429]);

      const live = await start({ limits: { orderLiveDailyWide: { max: 2, windowMs: DAY } } });
      const b: number[] = [];
      for (const [i, ip] of sameNetwork.entries()) b.push((await live.order({ recipient: to(i) }, { ip })).status);
      expect(b).toEqual([201, 201, 429, 429]);
      expect(live.stub.calls.liveQuotes).toBe(2);
    });

    it("stops a visitor whose orders keep being dropped because the price 'moved'", async () => {
      const h = await start({ limits: { orderPriceMoved: { max: 2, windowMs: 3_600_000 } } });
      const preview = (await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView;
      // Claiming to have reviewed a far better price makes every real quote look like a moved price.
      const greedy = { amountOut: (BigInt(preview.amountOut) * 10n).toString(), minAmountOut: (BigInt(preview.minAmountOut) * 10n).toString(), totalFeeBps: 40 };
      expect(outcome(await h.order({ reviewed: greedy }))).toBe("price_moved");
      expect(outcome(await h.order({ reviewed: greedy }))).toBe("price_moved");
      expect(h.stub.calls.liveQuotes).toBe(2);
      // The third is refused before the provider is asked for anything.
      const third = await h.order({ reviewed: greedy });
      expect(third.status).toBe(429);
      expect(h.stub.calls.liveQuotes).toBe(2);
      expect(h.store.openCount()).toBe(0);
      // Someone else is not affected.
      expect((await h.order({}, { ip: "198.51.100.9" })).status).toBe(201);
    });

    it("counts orders that are still being created toward the limit on unpaid orders", async () => {
      const h = await start({ limits: { orderCreate: { max: 100, windowMs: 60_000 }, orderPerRecipient: { max: 100, windowMs: 3_600_000 } } });
      for (let i = 0; i < 9; i++) expect((await h.order({ recipient: to(i % 9) })).status).toBe(201);
      const preview = (await h.quote({ ...QUOTE, recipient: ADDR.evm2, sender: ADDR.evm })).body as QuoteView;
      const reviewed = { amountOut: preview.amountOut, minAmountOut: preview.minAmountOut, totalFeeBps: 40 };
      // Six more arrive together: one that reaches the provider is held open there until the others have their answer. One place is left.
      const together = await sentTogether(h, Array.from({ length: 6 }, () => () => h.order({ reviewed })));
      expect(together.filter((r) => r.status === 201)).toHaveLength(1);
      expect(together.filter((r) => r.status === 429)).toHaveLength(5);
      expect(h.store.openCount()).toBe(10);
      // Nothing is left counted as "being created".
      h.clock.t += 31 * 60_000;
      await h.poller.tick();
    });

    it("counts every open order that has not started swapping, not only those marked waiting", async () => {
      const h = await start({ limits: { orderCreate: { max: 100, windowMs: 60_000 }, orderPerRecipient: { max: 100, windowMs: 3_600_000 } } });
      const orders: OrderView[] = [];
      for (let i = 0; i < 10; i++) orders.push(asOrder(await h.order({ recipient: to(i) })));
      expect((await h.order({ recipient: to(10) })).status).toBe(429);
      // Announcing a deposit for some, and under-paying others, frees no place...
      const announced = new Set(orders.slice(0, 4).map((o) => o.depositAddress));
      const underPaid = new Set(orders.slice(4, 7).map((o) => o.depositAddress));
      h.tap.statusReply = (address) => {
        const status = announced.has(address) ? "KNOWN_DEPOSIT_TX" : underPaid.has(address) ? "INCOMPLETE_DEPOSIT" : "PENDING_DEPOSIT";
        return { ok: true, status: 200, data: { status, quoteResponse: { quote: { depositAddress: address } }, swapDetails: {} } };
      };
      h.clock.t += 5500;
      await h.poller.tick();
      await h.poller.tick();
      expect(orders.map((o) => h.store.get(o.id)!.state.status).filter((status) => status !== "waiting")).toHaveLength(7);
      expect((await h.order({ recipient: to(10) })).status).toBe(429);
      // ...but an order that has started swapping, or has ended, does.
      const started = orders[9]!.depositAddress;
      h.tap.statusReply = (address) => ({ ok: true, status: 200, data: { status: address === started ? "PROCESSING" : "PENDING_DEPOSIT", quoteResponse: { quote: { depositAddress: address } }, swapDetails: {} } });
      h.clock.t += 16_000;
      await h.poller.tick();
      await h.poller.tick();
      expect(h.store.get(orders[9]!.id)?.state.status).toBe("swapping");
      expect((await h.order({ recipient: to(10) })).status).toBe(201);
    });

    it("charges what all clients share only after the visitor's own limits have passed", async () => {
      const h = await start({ limits: { orderLiveDaily: { max: 1, windowMs: DAY }, orderCreateGlobal: { max: 2, windowMs: 60_000 } } });
      expect((await h.order({ recipient: to(0) })).status).toBe(201);
      // This visitor is over their own limit: every further attempt is refused without touching the shared one.
      for (let i = 0; i < 3; i++) expect((await h.order({ recipient: to(i + 1) })).status).toBe(429);
      // So the one shared place that is left is still there for someone else.
      expect((await h.order({ recipient: to(5) }, { ip: "198.51.100.9" })).status).toBe(201);
      expect((await h.order({ recipient: to(6) }, { ip: "198.51.100.10" })).status).toBe(429);
    });
  });
});

describe("private routing", () => {
  // These tests set the server to route privately. Everywhere else in this file it routes in public.
  const PRIVATE: HarnessOptions = { env: { PRIVACY_MODE: "basic" } };
  // The same with a fee set on each kind of swap, for the tests of what happens to a fee.
  const PRIVATE_FEES: HarnessOptions = { env: { PRIVACY_MODE: "basic", ...FEES } };
  // What the page is told of a quote or an order that is routed privately, and of one that is not.
  const PRIVATELY = "confidential";
  const IN_PUBLIC = "public";
  const SWAP = { ...QUOTE, sender: ADDR.evm, recipient: ADDR.evm2, refundTo: ADDR.evm };
  const reviewedOf = (quote: QuoteView) => ({ amountOut: quote.amountOut, minAmountOut: quote.minAmountOut, totalFeeBps: quote.fees.appBps + quote.fees.providerBps, routing: quote.routing });
  const NOT_AVAILABLE = { error: { code: "private_unavailable", message: "Private routing is not available for this swap right now." } };
  const REROUTED = "This swap would be routed another way than the one you reviewed. Check the new details and confirm again.";
  const levels = (h: Harness, from = 0) => h.tap.quotes.slice(from).map((sent) => [sent.dry, sent.confidentiality]);

  it("names the two ways a swap is routed, and reads anything else as public", () => {
    expect(routingOf("basic")).toBe(PRIVATELY);
    expect(routingOf("public")).toBe(IN_PUBLIC);
    // (The function is given a level, as the provider names it. The word the page is told is not a level.)
    for (const other of [undefined, null, "", "advanced", "BASIC", "private", "confidential", true, 1, {}]) expect(routingOf(other), JSON.stringify(other)).toBe(IN_PUBLIC);
    expect([PRIVATELY, IN_PUBLIC].every(isRouting)).toBe(true);
    for (const other of [undefined, null, "", "basic", "advanced", "private", "Public", "CONFIDENTIAL", true]) expect(isRouting(other), JSON.stringify(other)).toBe(false);
  });

  it("sends every quote at the level the server is set to, previews and the real quote of an order alike, in both modes", async () => {
    for (const [mode, routing] of [["basic", PRIVATELY], ["public", IN_PUBLIC]] as const) {
      const h = await start({ env: { PRIVACY_MODE: mode } });
      // The page is told which it is, so that it says what the server does.
      expect((await h.get("/api/config")).body.privacyMode, mode).toBe(mode);
      const preview = await h.quote(QUOTE);
      expect(outcome(preview), mode).toBe("ok");
      expect(preview.body.routing, mode).toBe(routing);
      const order = asOrder(await h.order());
      expect(order.routing, mode).toBe(routing);
      // A preview, the preview behind the review, and the order's real quote: each names the level, and it is the setting's.
      expect(levels(h), mode).toEqual([[true, mode], [true, mode], [false, mode]]);
      expect(h.tap.quoteClasses, mode).toEqual(["user", "user", "order"]);
      for (const sent of h.tap.quotes) expect(Object.keys(sent), mode).toContain("confidentiality");
    }
  });

  it("lets nothing a browser sends raise the level or name one", async () => {
    // On a server set to public, nothing in a request makes a quote private.
    const open = await start({ env: FEES });
    const raising = [{ confidentiality: "basic" }, { confidentiality: "advanced" }, { privacy: "basic" }, { privacyMode: "basic" }, { PRIVACY_MODE: "basic" }, { routing: PRIVATELY }, { routing: "basic" }, { level: "basic" }, { private: true }, { withPrivate: true }, { withoutPrivate: false }, { withoutPrivate: true }];
    for (const extra of raising) {
      const reply = await open.quote({ ...QUOTE, ...extra });
      expect(outcome(reply), JSON.stringify(extra)).toBe("ok");
      expect(reply.body.routing, JSON.stringify(extra)).toBe(IN_PUBLIC);
      expect(open.tap.quotes.at(-1), JSON.stringify(extra)).toMatchObject({ confidentiality: "public", appFees: [{ recipient: open.config.feeRecipient, fee: 40 }] });
    }
    const made = asOrder(await open.order({ confidentiality: "basic", privacy: "basic", routing: PRIVATELY }));
    expect(made.routing).toBe(IN_PUBLIC);
    expect(open.tap.quotes.at(-1)).toMatchObject({ dry: false, confidentiality: "public" });
    expect(open.store.get(made.id)?.confidentiality).toBe("public");
    expect(new Set(open.tap.quotes.map((sent) => sent.confidentiality))).toEqual(new Set(["public"]));

    // On a server set to private, nothing in a request names a level either: not "public", and never the provider's third.
    const h = await start(PRIVATE);
    const naming = [{ confidentiality: "public" }, { confidentiality: "advanced" }, { privacy: "public" }, { privacyMode: "public" }, { routing: IN_PUBLIC }, { level: "public" }, { private: false }, { public: true }];
    for (const extra of naming) {
      const reply = await h.quote({ ...QUOTE, ...extra });
      expect(outcome(reply), JSON.stringify(extra)).toBe("ok");
      expect(reply.body.routing, JSON.stringify(extra)).toBe(PRIVATELY);
      expect(h.tap.quotes.at(-1)!.confidentiality, JSON.stringify(extra)).toBe("basic");
    }
    const order = asOrder(await h.order({ confidentiality: "public", privacy: "public", routing: IN_PUBLIC }));
    expect(order.routing).toBe(PRIVATELY);
    expect(h.tap.quotes.at(-1)).toMatchObject({ dry: false, confidentiality: "basic" });
    expect(h.store.get(order.id)?.confidentiality).toBe("basic");
    expect(new Set(h.tap.quotes.map((sent) => sent.confidentiality))).toEqual(new Set(["basic"]));
    // Nothing of the kind is passed on to the provider under any name.
    for (const sent of [...open.tap.quotes, ...h.tap.quotes]) expect(Object.keys(sent).filter((key) => /priva|routing|level|public/i.test(key))).toEqual([]);
  });

  it("honours one thing a request says about routing, withoutPrivate: true, and that only lowers the level", async () => {
    const h = await start(PRIVATE_FEES);
    // The person's explicit choice: this one swap in public.
    const lowered = await h.quote({ ...QUOTE, withoutPrivate: true });
    expect(outcome(lowered)).toBe("ok");
    expect(lowered.body.routing).toBe(IN_PUBLIC);
    expect(h.tap.quotes.at(-1)).toMatchObject({ confidentiality: "public", appFees: [{ recipient: h.config.feeRecipient, fee: 40 }] });
    // Only the value true is the choice. Anything else beside it leaves the swap private.
    for (const value of [false, "true", "yes", 1, 0, null, {}, [true], "public"]) {
      const reply = await h.quote({ ...QUOTE, withoutPrivate: value });
      expect(reply.body.routing, JSON.stringify(value)).toBe(PRIVATELY);
      expect(h.tap.quotes.at(-1)!.confidentiality, JSON.stringify(value)).toBe("basic");
    }
    for (const extra of [{ without_private: true }, { withoutprivate: true }, { WithoutPrivate: true }, { public: true }]) {
      await h.quote({ ...QUOTE, ...extra });
      expect(h.tap.quotes.at(-1)!.confidentiality, JSON.stringify(extra)).toBe("basic");
    }
    // The choice can lower the level and do nothing else: with a level named beside it, the quote is still plain public.
    for (const beside of ["advanced", "basic", "public"]) {
      await h.quote({ ...QUOTE, withoutPrivate: true, confidentiality: beside });
      expect(h.tap.quotes.at(-1)!.confidentiality, beside).toBe("public");
    }
    expect(new Set(h.tap.quotes.map((sent) => sent.confidentiality))).toEqual(new Set(["basic", "public"]));
    // The choice itself is not passed on: the provider is told a level and nothing more.
    for (const sent of h.tap.quotes) expect(Object.keys(sent)).not.toContain("withoutPrivate");

    // On a server set to public there is nothing to lower: the choice changes nothing at all.
    const open = await start();
    const plain = await open.quote(SWAP);
    const chosen = await open.quote({ ...SWAP, withoutPrivate: true });
    expect(chosen.body).toEqual(plain.body);
    expect(open.tap.quotes[1]).toEqual(open.tap.quotes[0]);
    expect(open.tap.quotes[0]!.confidentiality).toBe("public");
  });

  it("sends our private-swap fee with a private quote, shows the fees its echo holds, and refuses an echo that gives us more or pays anyone else", async () => {
    const h = await start(PRIVATE_FEES);
    const preview = (await h.quote(SWAP)).body as QuoteView;
    // FEE_BPS_PRIVATE, set to 20 here: our fee on a private swap, to our own recipient.
    expect(h.config.feeBpsPrivate).toBe(20);
    const ourFee = [{ recipient: h.config.feeRecipient, fee: 20 }];
    expect(h.tap.quotes.at(-1)!.confidentiality).toBe("basic");
    expect(h.tap.quotes.at(-1)!.appFees).toEqual(ourFee);
    // The fees shown are the echo's: ours whole, and the provider's own beside it.
    expect(preview.fees).toEqual({ appBps: 20, providerBps: 20, appAmount: "10000000000000", providerAmount: "10000000000000" });
    const order = asOrder(await h.order());
    expect(h.tap.quotes.at(-1)).toMatchObject({ dry: false, confidentiality: "basic", appFees: ourFee });
    expect(order.fees).toEqual(preview.fees);
    expect(h.store.get(order.id)?.fees).toEqual(preview.fees);

    type Fee = { recipient: string; fee: number };
    const echoing = (fees: (ours: Fee, theirs: Fee) => unknown[]) => (data: Record<string, unknown>) => {
      const request = data.quoteRequest as Record<string, unknown>;
      const [ours, theirs] = request.appFees as Fee[];
      return { ...data, quoteRequest: { ...request, appFees: fees(ours!, theirs!) } };
    };
    // Whatever the echo holds within the rules is what is shown: the provider's fee was 1 between two
    // dollar coins, and a smaller share of ours would be shown as it is.
    h.tap.corruptResponse = echoing((ours, theirs) => [ours, { ...theirs, fee: 1 }]);
    expect(((await h.quote(SWAP)).body as QuoteView).fees).toMatchObject({ appBps: 20, providerBps: 1 });
    h.tap.corruptResponse = echoing((ours, theirs) => [{ ...ours, fee: 10 }, theirs]);
    expect(((await h.quote(SWAP)).body as QuoteView).fees).toMatchObject({ appBps: 10, providerBps: 20 });

    // An echo that pays us more than was asked, does not pay us, pays anybody beside the provider, or
    // pays the provider more than the bound, is not the quote that was asked for. It is discarded.
    for (const [fees, reason] of [
      [(ours: Fee, theirs: Fee) => [{ ...ours, fee: 21 }, theirs], "echo:appFees share"],
      [(ours: Fee, theirs: Fee) => [{ ...ours, fee: 40 }, theirs], "echo:appFees share"],
      [(_ours: Fee, theirs: Fee) => [theirs], "echo:appFees recipient"],
      [(ours: Fee, theirs: Fee) => [ours, theirs, { recipient: ADDR.evm3, fee: 10 }], "echo:appFees private recipient"],
      [(ours: Fee, theirs: Fee) => [ours, { ...theirs, fee: 60 }], "echo:appFees private total"],
    ] as const) {
      h.tap.corruptResponse = echoing(fees);
      const reply = await h.quote(SWAP);
      expect(reply.status, reason).toBe(502);
      expect(reply.body.error, reason).toEqual({ code: "try_later", message: "We couldn't confirm that quote. Try again shortly." });
      expect(h.alerts.at(-1), reason).toMatchObject({ kind: "quote_verification" });
      expect(h.alerts.at(-1)!.text, reason).toContain(`(${reason})`);
    }
    // The same for the real quote of an order: no order is made from it.
    h.tap.corruptResponse = (data) => ((data.quote as Record<string, unknown>).depositAddress === undefined ? data : echoing((ours, theirs) => [{ ...ours, fee: 40 }, theirs])(data));
    expect((await h.order({ recipient: ADDR.evm3 })).status).toBe(502);
    expect(h.store.openCount()).toBe(1);

    // A public quote on the same server carries the public fee as it always did.
    h.tap.corruptResponse = null;
    const inPublic = (await h.quote({ ...SWAP, withoutPrivate: true })).body as QuoteView;
    expect(h.tap.quotes.at(-1)!.appFees).toEqual([{ recipient: h.config.feeRecipient, fee: 40 }]);
    expect(inPublic.fees).toMatchObject({ appBps: 20, providerBps: 20 });
  });

  it("takes the private-swap fee from FEE_BPS_PRIVATE alone: another figure is sent as set, and 0 sends no fee of ours at all", async () => {
    // A request cannot name a fee: whatever it carries, the server's own setting is what is sent.
    const raised = await start({ env: { PRIVACY_MODE: "basic", FEE_BPS: "40", FEE_BPS_PRIVATE: "30" } });
    const dearer = (await raised.quote({ ...SWAP, appFees: [{ recipient: ADDR.evm3, fee: 1 }], feeBps: 1, feeBpsPrivate: 1, fee: 1 })).body as QuoteView;
    expect(raised.tap.quotes.at(-1)!.appFees).toEqual([{ recipient: raised.config.feeRecipient, fee: 30 }]);
    expect(dearer.fees).toMatchObject({ appBps: 30, providerBps: 20 });
    // The public fee is its own setting, and is not touched by this one.
    await raised.quote({ ...SWAP, withoutPrivate: true });
    expect(raised.tap.quotes.at(-1)!.appFees).toEqual([{ recipient: raised.config.feeRecipient, fee: 40 }]);

    // A fee on public swaps only: there is a fee recipient, and a private quote goes out with nothing of ours.
    const free = await start({ env: { PRIVACY_MODE: "basic", FEE_BPS: "40", FEE_BPS_PRIVATE: "0" } });
    const preview = (await free.quote(SWAP)).body as QuoteView;
    expect(free.tap.quotes.at(-1)!.confidentiality).toBe("basic");
    expect(Object.keys(free.tap.quotes.at(-1)!)).not.toContain("appFees");
    expect(preview.fees).toEqual({ appBps: 0, providerBps: 20, appAmount: "0", providerAmount: "10000000000000" });
    const order = asOrder(await free.order());
    expect(Object.keys(free.tap.quotes.at(-1)!)).not.toContain("appFees");
    expect(order.fees).toEqual(preview.fees);
    // An echo with no fees at all is accepted there too; one that pays us is not.
    free.tap.corruptResponse = (data) => {
      const request = { ...(data.quoteRequest as Record<string, unknown>) };
      delete request.appFees;
      return { ...data, quoteRequest: request };
    };
    expect(((await free.quote(SWAP)).body as QuoteView).fees).toMatchObject({ appBps: 0, providerBps: 0 });
    free.tap.corruptResponse = (data) => ({ ...data, quoteRequest: { ...(data.quoteRequest as Record<string, unknown>), appFees: [{ recipient: free.config.feeRecipient, fee: 20 }] } });
    const reply = await free.quote(SWAP);
    expect(reply.status).toBe(502);
    expect(free.alerts.at(-1)!.text).toContain("(echo:appFees unsent share)");
  });

  it("discards a quote that was answered at another level than it was asked for at, both ways", async () => {
    // Asked for in private, answered in public: properly signed, and still not what was asked for.
    const h = await start(PRIVATE);
    h.tap.tamperRequest = (body) => ({ ...body, confidentiality: "public", appFees: [{ recipient: h.config.feeRecipient, fee: 40 }] });
    const preview = await h.quote(SWAP);
    expect(preview.status).toBe(502);
    expect(preview.body.error.code).toBe("try_later");
    expect(h.alerts.at(-1)!.text).toContain("(echo:confidentiality)");
    // The real quote of an order alike: the preview is honest, the order's quote comes back public, and no order is made.
    h.tap.tamperRequest = (body) => (body.dry === false ? { ...body, confidentiality: "public", appFees: [{ recipient: h.config.feeRecipient, fee: 40 }] } : body);
    expect((await h.order()).status).toBe(502);
    expect(h.store.openCount()).toBe(0);
    expect(h.alerts.at(-1)!.text).toContain("(echo:confidentiality)");
    // An echo that names no level is a public one, and one that names the provider's third level is never accepted.
    h.tap.tamperRequest = null;
    for (const level of [undefined, "advanced"]) {
      h.tap.corruptResponse = (data) => ({ ...data, quoteRequest: { ...(data.quoteRequest as Record<string, unknown>), confidentiality: level } });
      expect((await h.quote(SWAP)).status, String(level)).toBe(502);
      expect(h.alerts.at(-1)!.text).toContain("(echo:confidentiality)");
    }

    // Asked for in public, answered in private.
    const open = await start();
    open.tap.tamperRequest = (body) => ({ ...body, confidentiality: "basic" });
    expect((await open.quote(SWAP)).status).toBe(502);
    expect(open.alerts.at(-1)!.text).toContain("(echo:confidentiality)");
    open.tap.tamperRequest = (body) => (body.dry === false ? { ...body, confidentiality: "basic" } : body);
    expect((await open.order()).status).toBe(502);
    expect(open.store.openCount()).toBe(0);
    open.tap.tamperRequest = null;
    open.tap.corruptResponse = (data) => ({ ...data, quoteRequest: { ...(data.quoteRequest as Record<string, unknown>), confidentiality: "advanced" } });
    expect((await open.quote(SWAP)).status).toBe(502);
    // On that server the person's choice of public, too, is held to a public answer.
    h.tap.corruptResponse = null;
    h.tap.tamperRequest = (body) => ({ ...body, confidentiality: "basic" });
    expect((await h.quote({ ...SWAP, withoutPrivate: true })).status).toBe(502);
  });

  it("says private routing is not available for each way the provider refuses a private quote, asks nothing again in public, and makes no order", async () => {
    const h = await start({ ...PRIVATE, limits: { orderCreate: { max: 100, windowMs: 60_000 } } });
    const reviewed = reviewedOf((await h.quote(SWAP)).body as QuoteView);
    // No partner key (401), a refusal that names confidential routing, and no route.
    for (const how of ["unauthorized", "not_offered", "no_route"] as const) {
      h.stub.privateFails = how;
      const before = h.tap.quotes.length;
      const preview = await h.quote(SWAP);
      // An everyday outcome: it travels as a 200 with the error in the body, like "no route".
      expect(preview.status, how).toBe(200);
      expect(preview.body, how).toEqual(NOT_AVAILABLE);
      expect(h.access.at(-1), how).toMatchObject({ route: "quote", status: 422 });
      // The provider was asked once, in private. It was not asked again in public.
      expect(levels(h, before), how).toEqual([[true, "basic"]]);

      const order = await h.order({ reviewed });
      expect(order.status, how).toBe(200);
      expect(order.body, how).toEqual(NOT_AVAILABLE);
      expect(levels(h, before), how).toEqual([[true, "basic"], [false, "basic"]]);
      expect(h.store.open(), how).toHaveLength(0);
      expect(fs.readdirSync(path.join(h.dataDir, "orders")), how).toHaveLength(0);
    }
    // Swapping in public instead is the person's choice, and is then quoted as any public swap is.
    const chosen = await h.quote({ ...SWAP, withoutPrivate: true });
    expect(outcome(chosen)).toBe("ok");
    expect(chosen.body.routing).toBe(IN_PUBLIC);
    expect(asOrder(await h.order({ withoutPrivate: true })).routing).toBe(IN_PUBLIC);

    // The same answers in every shape the provider's client reports them in.
    h.stub.privateFails = null;
    const refusals: UpstreamResult[] = [
      { ok: false, kind: "unavailable", status: 401 },
      { ok: false, kind: "rejected", status: 401, message: "User authentication is required for confidential intent quotes" },
      { ok: false, kind: "rejected", status: 400, message: "Confidential quotes are not available for this pair" },
      { ok: false, kind: "rejected", status: 400, message: "confidentiality basic is not enabled for this account" },
      { ok: false, kind: "rejected", status: 400, message: "Confidential swaps are restricted to approved partners" },
      { ok: false, kind: "rejected", status: 400, message: "No liquidity available" },
      { ok: false, kind: "rejected", status: 400, message: "Failed to get quote" },
      { ok: false, kind: "rejected", status: 400, message: "Quote error. NO_QUOTE" },
    ];
    for (const refusal of refusals) {
      h.tap.nextQuote = refusal;
      const before = h.tap.quotes.length;
      const reply = await h.quote(SWAP, { ip: "198.51.100.61" });
      expect(reply.status, JSON.stringify(refusal)).toBe(200);
      expect(reply.body, JSON.stringify(refusal)).toEqual(NOT_AVAILABLE);
      expect(levels(h, before), JSON.stringify(refusal)).toEqual([[true, "basic"]]);
    }
    // A preview that used a stand-in address which the provider did not take is "no route" in public, and so "not available" in private.
    h.tap.nextQuote = { ok: false, kind: "rejected", status: 400, message: "recipient is not valid" };
    expect((await h.quote(QUOTE, { ip: "198.51.100.62" })).body).toEqual(NOT_AVAILABLE);
    // One pair is always refused in private by the practice provider and fine in public: anything delivered on Zcash.
    const toZcash = { from: ASSET.baseEth, to: ASSET.zec, amount: "50000000000000000", pay: "wallet" };
    expect((await h.quote(toZcash, { ip: "198.51.100.62" })).body).toEqual(NOT_AVAILABLE);
    expect((await h.quote({ ...toZcash, withoutPrivate: true }, { ip: "198.51.100.62" })).body.routing).toBe(IN_PUBLIC);
  });

  it("keeps every other outcome of a private quote as it is, and every outcome of a public one", async () => {
    const h = await start(PRIVATE);
    const asked = async (result: UpstreamResult, body: Record<string, unknown>, ip: string) => {
      h.tap.nextQuote = result;
      const reply = await h.quote(body, { ip });
      return [reply.status, outcome(reply)];
    };
    // A private quote: a minimum, an amount too low, an address the provider did not take, a compliance
    // refusal, and the provider being down or busy are said as they always were.
    const same: Array<[UpstreamResult, number, string]> = [
      [{ ok: false, kind: "rejected", status: 400, message: "Temporary swap limits: minimum swap amount is $1,000" }, 200, "min_usd"],
      [{ ok: false, kind: "rejected", status: 400, message: "Minimum swap amount is $1,000 for confidential swaps" }, 200, "min_usd"],
      [{ ok: false, kind: "rejected", status: 400, message: "Amount is too low for bridge, try at least 2725340300683302" }, 200, "amount_too_low"],
      [{ ok: false, kind: "rejected", status: 400, message: "recipient is not valid" }, 200, "invalid_recipient"],
      [{ ok: false, kind: "rejected", status: 400, message: "refundTo is not valid" }, 200, "invalid_refund"],
      [{ ok: false, kind: "rejected", status: 400, message: "Address is blocked by compliance policy 7781" }, 403, "blocked"],
      [{ ok: false, kind: "rejected", status: 451, message: "" }, 403, "blocked"],
      // A 403 is the provider's own screening refusing the swap, or this site turned away as a caller. Neither is
      // "private routing is not available": nobody is invited to try the same swap again in public.
      [{ ok: false, kind: "rejected", status: 403, message: "" }, 403, "blocked"],
      [{ ok: false, kind: "unavailable", status: 403 }, 503, "try_later"],
      [{ ok: false, kind: "unavailable", status: 503 }, 503, "try_later"],
      [{ ok: false, kind: "unavailable", status: 429 }, 503, "try_later"],
      [{ ok: false, kind: "unavailable", status: null }, 503, "try_later"],
      [{ ok: false, kind: "unavailable", status: null, budget: true }, 503, "try_later"],
    ];
    for (const [result, status, code] of same) {
      expect(await asked(result, SWAP, "198.51.100.71"), JSON.stringify(result)).toEqual([status, code]);
      expect(h.tap.quotes.at(-1)!.confidentiality).toBe("basic");
    }
    // The screening refusal in full, as the practice provider gives it: neutral words, no order, and nothing asked again in public.
    const reviewed = reviewedOf((await h.quote(SWAP, { ip: "198.51.100.73" })).body as QuoteView);
    h.stub.privateFails = "forbidden";
    const before = h.tap.quotes.length;
    const refused = await h.quote(SWAP, { ip: "198.51.100.73" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toEqual({ code: "blocked", message: "This swap can't be processed." });
    const noOrder = await h.order({ reviewed });
    expect(noOrder.status).toBe(403);
    expect(noOrder.body.error).toEqual({ code: "blocked", message: "This swap can't be processed." });
    expect(h.tap.quotes.slice(before).map((sent) => sent.confidentiality)).toEqual(["basic", "basic"]);
    expect(h.store.open()).toHaveLength(0);
    h.stub.privateFails = null;
    // A public quote, by the person's choice here and by the setting on another server: 401 and 403
    // mean what they always meant, a refusal that names confidential routing is an ordinary refusal,
    // and "no route" is "no route".
    const open = await start();
    const unchanged: Array<[UpstreamResult, number, string]> = [
      [{ ok: false, kind: "unavailable", status: 401 }, 503, "try_later"],
      [{ ok: false, kind: "unavailable", status: 403 }, 503, "try_later"],
      [{ ok: false, kind: "rejected", status: 403, message: "" }, 403, "blocked"],
      [{ ok: false, kind: "rejected", status: 451, message: "" }, 403, "blocked"],
      [{ ok: false, kind: "rejected", status: 400, message: "Confidential quotes are not available for this pair" }, 200, "no_route"],
      [{ ok: false, kind: "rejected", status: 400, message: "No liquidity available" }, 200, "no_route"],
    ];
    for (const [result, status, code] of unchanged) {
      expect(await asked(result, { ...SWAP, withoutPrivate: true }, "198.51.100.72"), JSON.stringify(result)).toEqual([status, code]);
      expect(h.tap.quotes.at(-1)!.confidentiality).toBe("public");
      open.tap.nextQuote = result;
      const reply = await open.quote(SWAP);
      expect([reply.status, outcome(reply)], JSON.stringify(result)).toEqual([status, code]);
    }
  });

  it("makes a private order from a private quote and a public order from the person's choice of public, and says which on the order and in its record", async () => {
    const h = await start(PRIVATE_FEES);
    const hidden = (await h.quote(SWAP)).body as QuoteView;
    expect(hidden.routing).toBe(PRIVATELY);
    const privateOrder = asOrder(await h.order());
    expect(privateOrder.routing).toBe(PRIVATELY);
    expect(h.tap.quotes.at(-1)).toMatchObject({ dry: false, confidentiality: "basic" });
    // The stored record keeps the level the order was made with, beside the provider's signed answer to it.
    const kept = JSON.parse(fs.readFileSync(path.join(h.dataDir, "orders", `${privateOrder.id}.json`), "utf8"));
    expect(kept.confidentiality).toBe("basic");
    expect(kept.quoteResponse.quoteRequest.confidentiality).toBe("basic");
    expect((await h.get(`/api/orders/${privateOrder.id}`)).body.routing).toBe(PRIVATELY);

    // The explicit choice: the same swap without private routing.
    const shown = (await h.quote({ ...SWAP, withoutPrivate: true })).body as QuoteView;
    expect(shown.routing).toBe(IN_PUBLIC);
    // Each shows our fee as its own echo holds it. The two can be told apart by more than the word: the amounts differ.
    expect([hidden.fees.appBps, shown.fees.appBps]).toEqual([20, 20]);
    expect(shown.amountOut).not.toBe(hidden.amountOut);
    const publicOrder = asOrder(await h.order({ withoutPrivate: true, recipient: ADDR.evm3 }));
    expect(publicOrder.routing).toBe(IN_PUBLIC);
    expect(h.tap.quotes.at(-1)).toMatchObject({ dry: false, confidentiality: "public", appFees: [{ recipient: h.config.feeRecipient, fee: 40 }] });
    const plain = JSON.parse(fs.readFileSync(path.join(h.dataDir, "orders", `${publicOrder.id}.json`), "utf8"));
    expect(plain.confidentiality).toBe("public");
    expect(plain.quoteResponse.quoteRequest.confidentiality).toBe("public");
    expect((await h.get(`/api/orders/${publicOrder.id}`)).body.routing).toBe(IN_PUBLIC);
    expect(publicOrder.fees.appBps).toBe(20);
    // The level is part of the order as it was made: tracking it changes nothing about it.
    h.stub.control(privateOrder.depositAddress!, "deposit");
    h.clock.t += 30_000;
    await h.poller.recheck(privateOrder.id);
    expect(h.store.get(privateOrder.id)).toMatchObject({ confidentiality: "basic", state: { status: "delivered" } });
    expect((await h.get(`/api/orders/${privateOrder.id}`)).body).toMatchObject({ status: "delivered", routing: PRIVATELY });

    // On a server set to public, the choice changes nothing: both orders are public ones.
    const open = await start({ env: FEES });
    for (const overrides of [{}, { withoutPrivate: true, recipient: ADDR.evm3 }]) {
      const order = asOrder(await open.order(overrides));
      expect(order.routing).toBe(IN_PUBLIC);
      expect(open.store.get(order.id)?.confidentiality).toBe("public");
      expect(open.tap.quotes.at(-1)).toMatchObject({ dry: false, confidentiality: "public", appFees: [{ recipient: open.config.feeRecipient, fee: 40 }] });
    }
  });

  it("makes no order that would be routed another way than the quote that was reviewed", async () => {
    const day = { max: 1000, windowMs: 86_400_000 };
    const h = await start({ ...PRIVATE, limits: { orderCreate: day, orderPriceMoved: day } });
    const hidden = (await h.quote(SWAP)).body as QuoteView;
    const shown = (await h.quote({ ...SWAP, withoutPrivate: true })).body as QuoteView;
    const refused = async (overrides: Record<string, unknown>, routing: string) => {
      const reply = await h.order(overrides);
      // No order: the person is shown the quote for the way it would be routed, to confirm or not.
      expect(reply.status).toBe(200);
      expect(reply.body.error).toMatchObject({ code: "price_moved", message: REROUTED });
      expect(reply.body.error.quote.routing).toBe(routing);
      expect(reply.body.id).toBeUndefined();
      expect(h.store.open()).toHaveLength(0);
    };
    // Reviewed in public, asked for without saying so: it would be private. Even where nothing but the
    // routing could differ (the numbers reviewed are generous in the second), it is not made.
    await refused({ reviewed: reviewedOf(shown) }, PRIVATELY);
    await refused({ reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 500, routing: IN_PUBLIC } }, PRIVATELY);
    // Reviewed in private, asked for in public. (The numbers reviewed are generous here, so that nothing but the routing differs.)
    await refused({ reviewed: { amountOut: "1", minAmountOut: "1", totalFeeBps: 500, routing: PRIVATELY }, withoutPrivate: true }, IN_PUBLIC);
    await refused({ reviewed: reviewedOf(hidden), withoutPrivate: true }, IN_PUBLIC);
    // A review that names no routing (a page from before routing was shown) is read as a public one.
    const unnamed = { amountOut: shown.amountOut, minAmountOut: shown.minAmountOut, totalFeeBps: 40 };
    await refused({ reviewed: unnamed }, PRIVATELY);
    // What is not one of the two words is not a review at all, and the provider is not asked.
    const before = h.tap.quotes.length;
    for (const routing of ["basic", "advanced", "private", "Confidential", "", 1, true, null, [IN_PUBLIC]]) {
      const reply = await h.order({ reviewed: { ...unnamed, routing } });
      expect(reply.status, JSON.stringify(routing)).toBe(400);
      expect(reply.body.error, JSON.stringify(routing)).toEqual({ code: "bad_request", message: "The reviewed quote is missing." });
    }
    expect(h.tap.quotes.length).toBe(before);

    // Said the same way both times, the order is made: private from a private review, public from a public one.
    const key = "routing-key-0123456789-abcdef";
    const made = await h.order({ reviewed: reviewedOf(hidden), requestId: key });
    expect(made.status).toBe(201);
    expect(made.body.routing).toBe(PRIVATELY);
    expect(asOrder(await h.order({ reviewed: unnamed, withoutPrivate: true, recipient: ADDR.evm3 })).routing).toBe(IN_PUBLIC);
    expect(asOrder(await h.order({ reviewed: reviewedOf(shown), withoutPrivate: true, recipient: ADDR.evm })).routing).toBe(IN_PUBLIC);
    // A retry under the same key returns the same order. The same swap asked for the other way under that key is another request, and is refused.
    const again = await h.order({ reviewed: reviewedOf(hidden), requestId: key });
    expect([again.status, again.body.id]).toEqual([200, made.body.id]);
    const other = await h.order({ reviewed: reviewedOf(shown), withoutPrivate: true, requestId: key });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("conflict");
    expect(h.store.open()).toHaveLength(3);

    // On a server set to public, an order reviewed as private is not made either.
    const open = await start();
    const plain = (await open.quote(SWAP)).body as QuoteView;
    const reply = await open.order({ reviewed: { ...reviewedOf(plain), routing: PRIVATELY } });
    expect(reply.body.error).toMatchObject({ code: "price_moved", message: REROUTED });
    expect(reply.body.error.quote.routing).toBe(IN_PUBLIC);
    expect(open.store.open()).toHaveLength(0);
  });

  it("reads an order stored before the routing level was kept as a public one", async () => {
    const h = await start(PRIVATE);
    const order = asOrder(await h.order());
    const record = h.store.get(order.id)!;
    expect(record.confidentiality).toBe("basic");
    expect(toOrderView(record, h.clock.t).routing).toBe(PRIVATELY);
    // The same order as it would have been written before: with no such field.
    const old = { ...record, id: "B".repeat(27), depositAddress: ADDR.evm3 } as OrderRecord;
    delete old.confidentiality;
    h.store.create(old);
    expect(JSON.parse(fs.readFileSync(path.join(h.dataDir, "orders", `${old.id}.json`), "utf8"))).not.toHaveProperty("confidentiality");
    const read = await h.get(`/api/orders/${old.id}`);
    expect(read.status).toBe(200);
    expect(read.body.routing).toBe(IN_PUBLIC);
    // And so it reads after a restart, straight from the file.
    const reopened = createOrderStore(h.dataDir).get(old.id)!;
    expect(reopened.confidentiality).toBeUndefined();
    expect(toOrderView(reopened, h.clock.t).routing).toBe(IN_PUBLIC);
    // A record can say nothing that makes its order read as private except the one level this server writes.
    for (const level of ["advanced", "private", "BASIC", "", true, null]) expect(toOrderView({ ...record, confidentiality: level as never }, h.clock.t).routing, JSON.stringify(level)).toBe(IN_PUBLIC);
  });

  it("counts a delivered private order's points from its dollar value, as a public order's are, whether or not a fee is taken", async () => {
    const delivering = (h: Harness) => async (overrides: Record<string, unknown>) => {
      const order = asOrder(await h.order(overrides));
      h.stub.control(order.depositAddress!, "deposit");
      h.clock.t += 30_000;
      await h.poller.recheck(order.id);
      expect(h.store.get(order.id)?.state.status).toBe("delivered");
      return order;
    };
    const h = await start(PRIVATE);
    const deliver = delivering(h);
    const order = await deliver({ rewardsAddress: ADDR.evm3 });
    // No fee of IntentSwap's on it, and its points are there all the same: ten for each dollar its record says was paid.
    expect(order).toMatchObject({ routing: PRIVATELY, rewardsAddress: ADDR.evm3, fees: { appBps: 0, appAmount: "0" } });
    const entries = h.rewards.entriesFor(ADDR.evm3);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ v: 2, reasons: [] });
    const volume = BigInt(entries[0]!.volumeUsdMicro);
    expect(volume).toBeGreaterThan(0n);
    expect(swapPointsMicro(h.store.get(order.id)!.amountInUsd)).toBe(volume * 10n);
    expect(h.rewards.view(ADDR.evm3, h.clock.t)).toMatchObject({ allTimeMicro: (volume * 10n).toString(), week: { pointsMicro: (volume * 10n).toString() } });
    // The same swap routed in public, by the person's choice: the same amount paid, and so the same points.
    await deliver({ rewardsAddress: ADDR.evm2, withoutPrivate: true, recipient: ADDR.evm3 });
    const counted = h.rewards.entriesFor(ADDR.evm2);
    expect(counted).toHaveLength(1);
    expect(counted[0]!.volumeUsdMicro).toBe(entries[0]!.volumeUsdMicro);
    expect(h.rewards.view(ADDR.evm2, h.clock.t).allTimeMicro).toBe(h.rewards.view(ADDR.evm3, h.clock.t).allTimeMicro);

    // Where the server is set to take a fee, the same swap adds the same points: no fee is part of the sum.
    const charging = await start(PRIVATE_FEES);
    const paidFor = await delivering(charging)({ rewardsAddress: ADDR.evm3 });
    expect(paidFor).toMatchObject({ routing: PRIVATELY, fees: { appBps: 20 } });
    expect(charging.rewards.entriesFor(ADDR.evm3).map((entry) => entry.volumeUsdMicro)).toEqual([entries[0]!.volumeUsdMicro]);

    // An order that is refunded adds nothing.
    const refunded = asOrder(await h.order({ rewardsAddress: ADDR.evm, recipient: ADDR.evm2, amount: "6000000000000000" }));
    h.stub.control(refunded.depositAddress!, "refund");
    h.clock.t += 30_000;
    await h.poller.recheck(refunded.id);
    expect(h.store.get(refunded.id)?.state.status).toBe("refunded");
    expect(h.rewards.entriesFor(ADDR.evm)).toEqual([]);
  });

  it("never finds a privately routed order from its deposit address: that would publish the link private routing keeps out of public records", async () => {
    const day = 86_400_000;
    const roomy = { max: 100_000, windowMs: day };
    const h = await start({ ...PRIVATE, limits: { orderFind: roomy, orderFindDaily: roomy, orderFindDailyWide: roomy, orderFindGlobal: roomy } });
    const hidden = asOrder(await h.order());
    const shown = asOrder(await h.order({ withoutPrivate: true, recipient: ADDR.evm3 }));
    expect([hidden.routing, shown.routing]).toEqual([PRIVATELY, IN_PUBLIC]);
    // A stranger: another address, a session of its own. The deposit address is all it has, and that is public once paid.
    const stranger = { session: await h.session(), ip: "198.51.100.40" };
    const miss = await h.post("/api/track", { depositAddress: `0x${"7".repeat(40)}` }, stranger);
    for (const spelling of [hidden.depositAddress!, hidden.depositAddress!.toLowerCase(), ` ${hidden.depositAddress!.toUpperCase().replace("0X", "0x")} `]) {
      const reply = await h.post("/api/track", { depositAddress: spelling }, stranger);
      // Exactly the answer an address that is no order's gets: nothing tells the two apart.
      expect(reply.status).toBe(404);
      expect(reply.body).toEqual(miss.body);
      expect(JSON.stringify(reply.body)).not.toContain(hidden.id);
    }
    // The same after it is paid and delivered, and for the person who made it: the order opens from its link or ID only.
    h.stub.control(hidden.depositAddress!, "deposit");
    h.clock.t += 30_000;
    await h.poller.recheck(hidden.id);
    expect(h.store.get(hidden.id)?.state.status).toBe("delivered");
    expect((await h.post("/api/track", { depositAddress: hidden.depositAddress }, stranger)).status).toBe(404);
    expect((await h.post("/api/track", { depositAddress: hidden.depositAddress }, { session: await h.session() })).status).toBe(404);
    expect((await h.get(`/api/orders/${hidden.id}`)).body).toMatchObject({ id: hidden.id, routing: PRIVATELY, status: "delivered" });
    // A public order on the same server is found as ever.
    expect((await h.post("/api/track", { depositAddress: shown.depositAddress }, stranger)).body).toEqual({ id: shown.id });

    // And it is counted as any miss is: asking after private orders' addresses uses up the allowance for guesses.
    const guesser = { session: await h.session(), ip: "198.51.100.41" };
    const statuses: number[] = [];
    for (let i = 0; i <= LIMITS.orderMiss.max; i++) statuses.push((await h.post("/api/track", { depositAddress: hidden.depositAddress }, guesser)).status);
    expect(statuses.slice(0, LIMITS.orderMiss.max)).toEqual(Array(LIMITS.orderMiss.max).fill(404));
    expect(statuses[LIMITS.orderMiss.max]).toBe(429);

    // The rule reads the level the order itself was made with, which its record keeps, and never the server's setting now.
    expect(h.store.get(hidden.id)!.confidentiality).toBe("basic");
    expect(h.store.findByDeposit(hidden.depositAddress!)?.id).toBe(hidden.id);
  });

  it("says in the log, once, when private routing is waiting for a partner key and when it was switched on without one", async () => {
    const said = (h: Harness, event: string) => h.logs.filter((line) => line.includes(`"event":"${event}"`));
    const KEY = "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc";
    // Nothing set (the test harness itself says "public", so here the setting is emptied) and no key:
    // the server routes in public, tells the page so, and says in its log that private routing is waiting.
    const waiting = await start({ env: { PRIVACY_MODE: "" } });
    expect((await waiting.get("/api/config")).body.privacyMode).toBe("public");
    expect(said(waiting, "private_routing_waits_for_key")).toHaveLength(1);
    expect(JSON.parse(said(waiting, "private_routing_waits_for_key")[0]!)).toMatchObject({ level: "warn" });
    expect(said(waiting, "private_routing_without_partner_key")).toHaveLength(0);
    expect((await waiting.quote(QUOTE)).body.routing).toBe(IN_PUBLIC);
    expect(waiting.tap.quotes.at(-1)!.confidentiality).toBe("public");
    // Nothing set and a key: private, and nothing to say.
    const keyed = await start({ env: { PRIVACY_MODE: "", ONECLICK_API_KEY: KEY } });
    expect((await keyed.get("/api/config")).body.privacyMode).toBe("basic");
    expect((await keyed.quote(QUOTE)).body.routing).toBe(PRIVATELY);
    expect(keyed.logs.filter((line) => line.includes("private_routing"))).toEqual([]);
    // Switched on by name with no key, which only a server that is not the live one can be: it says what that means.
    const bare = await start(PRIVATE);
    expect(said(bare, "private_routing_without_partner_key")).toHaveLength(1);
    expect(JSON.parse(said(bare, "private_routing_without_partner_key")[0]!)).toMatchObject({ level: "warn" });
    expect(said(bare, "private_routing_waits_for_key")).toHaveLength(0);
    // Set to public by name: nothing is waiting, and nothing is said.
    expect((await start()).logs.filter((line) => line.includes("private_routing"))).toEqual([]);
    expect((await start({ env: { PRIVACY_MODE: "public", ONECLICK_API_KEY: KEY } })).logs.filter((line) => line.includes("private_routing"))).toEqual([]);
    // Each is said at the start and not again, however many quotes follow.
    await bare.quote(QUOTE);
    await waiting.quote(QUOTE);
    expect(said(bare, "private_routing_without_partner_key")).toHaveLength(1);
    expect(said(waiting, "private_routing_waits_for_key")).toHaveLength(1);
  });
});
