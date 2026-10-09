// Checks the real server code against the real swap provider, using price
// previews only. It never creates an order: every request is forced to be a
// preview, and order creation is switched off.
//
//   npx tsx scripts/live-check.ts
//
// Run it before a release and whenever the provider announces a change.
// It prints one line per check and exits non-zero if any fails.

import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { base58, bech32 } from "@scure/base";
import { checkAddress, toChecksumAddress } from "../shared/addresses.ts";
import type { QuoteView } from "../shared/api.ts";
import { createApp } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { createStaticGeo } from "../server/geo.ts";
import { nullAccessLog, silentLogger } from "../server/log.ts";
import { createOneClick, type OneClick } from "../server/oneclick.ts";
import { createPoller } from "../server/poller.ts";
import { buildSentQuote, parseSwapInput } from "../server/quotes.ts";
import { createLimiters } from "../server/ratelimit.ts";
import { createRpc } from "../server/rpc.ts";
import { createStaticSanctions } from "../server/sanctions.ts";
import { createSessionIssuer } from "../server/session.ts";
import { createOrderStore } from "../server/store.ts";
import { createTokenService } from "../server/tokens.ts";
import { createRewards, createSignIn } from "../server/rewards.ts";
import { verifyQuoteResponse } from "../server/verify.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-live-"));
const config = loadConfig({ NODE_ENV: "development", DATA_DIR: dataDir });
// allowLive is off: the client itself refuses anything but a preview.
const real = createOneClick({ apiKey: null, maxPerMin: 60, allowLive: false, log: silentLogger });

// The guard: nothing but a preview can leave this process.
const previewsOnly: OneClick = {
  ...real,
  quote(body, priority) {
    if (body.dry !== true) throw new Error("live-check refuses to send anything but a preview");
    return real.quote(body, priority);
  },
  status: () => Promise.reject(new Error("live-check does not ask for order statuses")),
  submitDeposit: () => Promise.reject(new Error("live-check does not submit deposits")),
};

const alerts: string[] = [];
const alertSink = { send: (kind: string, text: string) => void alerts.push(`${kind}: ${text}`) };
const rpc = createRpc({ urls: config.rpcUrls });
const tokens = createTokenService({ oneclick: previewsOnly, rpc, alerts: alertSink, log: silentLogger, dataDir: null });
const store = createOrderStore(dataDir);
const app = createApp({
  config,
  log: silentLogger,
  accessLog: nullAccessLog,
  alerts: alertSink,
  geo: createStaticGeo(),
  sanctions: createStaticSanctions([]),
  oneclick: previewsOnly,
  tokens,
  store,
  poller: createPoller({ store, oneclick: previewsOnly, alerts: alertSink, log: silentLogger }),
  rpc,
  limiters: createLimiters(),
  sessions: createSessionIssuer(),
  rewards: createRewards(dataDir),
  signIn: createSignIn(),
  site: null,
  now: Date.now,
  liveOrders: false,
});

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

const session = String(((await (await fetch(`${url}/api/config`)).json()) as { session: string }).session);
const post = async (route: string, body: unknown) => {
  const res = await fetch(url + route, { method: "POST", headers: { "content-type": "application/json", origin: url, "x-session": session }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const list = (await (await fetch(`${url}/api/tokens`)).json()) as { tokens?: Array<{ id: string; symbol: string; chain: string; wallet: boolean; decimals: number; price: string | null }> };
const coins = list.tokens ?? [];
check("coin list loads from the provider", coins.length > 50, `${coins.length} coins`);
check("allowlisted coins confirmed on-chain", coins.filter((c) => c.wallet).length >= 15, `${coins.filter((c) => c.wallet).length} wallet-payable`);

const find = (chain: string, symbol: string) => coins.find((c) => c.chain === chain && c.symbol === symbol);
const usd = (coin: { decimals: number; price: string | null }, dollars: number) => {
  // Whole-number maths: dollars × 10^decimals ÷ price, with the price scaled to six places.
  const [whole = "0", frac = ""] = (coin.price ?? "1").split(".");
  const priceMicro = BigInt(whole) * 1_000_000n + BigInt(frac.slice(0, 6).padEnd(6, "0"));
  return ((BigInt(dollars) * 1_000_000n * 10n ** BigInt(coin.decimals)) / priceMicro).toString();
};

const pairs: Array<[string, string, string, string, "wallet" | "manual", number]> = [
  ["base", "ETH", "arb", "USDC", "wallet", 25],
  ["arb", "USDC", "sol", "USDT", "wallet", 25],
  ["sol", "USDT", "base", "ETH", "manual", 25],
  ["btc", "BTC", "eth", "USDC", "manual", 200],
  ["eth", "ETH", "zec", "ZEC", "wallet", 200],
  ["stellar", "XLM", "base", "USDC", "manual", 25],
];
for (const [fromChain, fromSymbol, toChain, toSymbol, pay, dollars] of pairs) {
  const from = find(fromChain, fromSymbol);
  const to = find(toChain, toSymbol);
  const label = `preview ${fromSymbol} on ${fromChain} to ${toSymbol} on ${toChain}, verified`;
  if (!from || !to) {
    check(label, false, "coin not listed");
    continue;
  }
  const reply = await post("/api/quote", { from: from.id, to: to.id, amount: usd(from, dollars), pay });
  const quote = reply.body as unknown as QuoteView;
  const good = reply.status === 200 && reply.body.error === undefined && BigInt(quote.amountOut) > 0n && BigInt(quote.minAmountOut) <= BigInt(quote.amountOut) && quote.fees.appBps === config.feeBps / 2;
  check(label, good, good ? `we keep ${quote.fees.appBps} bps, provider ${quote.fees.providerBps} bps, about ${quote.timeEstimate} s` : JSON.stringify(reply.body));
}

// The previews above used the built-in stand-in addresses. A person's quote carries their own:
// a checksummed EVM address with the connected wallet as sender, a Solana address, a bech32
// Bitcoin refund address. These are made from fixed text, so they belong to no one.
const bytes = (label: string, length: number) => createHash("sha256").update(`intentswap live-check ${label}`).digest().subarray(0, length);
const evmAddress = (label: string) => toChecksumAddress(`0x${Buffer.from(bytes(label, 20)).toString("hex")}`);
const walletA = evmAddress("wallet a");
const walletB = evmAddress("wallet b");
const solAddress = base58.encode(bytes("solana", 32));
const btcAddress = bech32.encode("bc", [0, ...bech32.toWords(bytes("bitcoin", 20))]);
check("the made-up addresses pass our own validators", [checkAddress("base", walletA), checkAddress("arb", walletB), checkAddress("sol", solAddress), checkAddress("btc", btcAddress)].every((r) => r.ok));

const withAddresses: Array<[string, string, string, string, Record<string, string>, number]> = [
  ["base", "ETH", "arb", "USDC", { pay: "wallet", sender: walletA, recipient: walletB, refundTo: walletA }, 25],
  ["arb", "USDC", "sol", "USDT", { pay: "wallet", sender: walletA, recipient: solAddress, refundTo: walletA }, 25],
  ["btc", "BTC", "base", "USDC", { pay: "manual", recipient: walletB, refundTo: btcAddress }, 200],
];
for (const [fromChain, fromSymbol, toChain, toSymbol, extra, dollars] of withAddresses) {
  const from = find(fromChain, fromSymbol);
  const to = find(toChain, toSymbol);
  const label = `preview with a person's addresses, ${fromSymbol} on ${fromChain} to ${toSymbol} on ${toChain}${extra.sender ? ", wallet as sender" : ""}`;
  if (!from || !to) {
    check(label, false, "coin not listed");
    continue;
  }
  const reply = await post("/api/quote", { from: from.id, to: to.id, amount: usd(from, dollars), ...extra });
  const quote = reply.body as unknown as QuoteView;
  check(label, reply.status === 200 && reply.body.error === undefined && BigInt(quote.amountOut) > 0n, reply.body.error === undefined ? "verified" : JSON.stringify(reply.body));
}

// The minimum on BNB Chain is reported in our own words, when it applies.
const bnb = find("bsc", "BNB");
const solUsdt = find("sol", "USDT");
if (bnb && solUsdt) {
  const reply = await post("/api/quote", { from: bnb.id, to: solUsdt.id, amount: usd(bnb, 25), pay: "manual" });
  const error = reply.body.error as { code?: string; message?: string } | undefined;
  check("a small BNB Chain preview is answered cleanly", reply.status === 200 && (error === undefined || error.code === "min_usd"), error === undefined ? "no minimum in force" : String(error.message));
}

// A tampered copy of a real, signed response must fail, with the real pinned key and no extra keys.
const baseEth = find("base", "ETH");
const arbUsdc = find("arb", "USDC");
const snapshot = await tokens.snapshot();
if (baseEth && arbUsdc && snapshot) {
  const input = parseSwapInput({ from: baseEth.id, to: arbUsdc.id, amount: usd(baseEth, 25), pay: "wallet" }, snapshot.byId, false);
  const sent = buildSentQuote(input, { dry: true, now: Date.now(), feeRecipient: config.feeRecipient, feeBps: config.feeBps, feeBpsPrivate: config.feeBpsPrivate });
  const result = await previewsOnly.quote(sent as unknown as Record<string, unknown>);
  if (result.ok) {
    const verify = (response: unknown) => {
      try {
        verifyQuoteResponse({ sent, response, originChain: "base", now: Date.now() });
        return "accepted";
      } catch (err) {
        return (err as { reason?: string }).reason ?? "error";
      }
    };
    const data = result.data as { quote: Record<string, string>; quoteRequest: Record<string, unknown> };
    check("a genuine response passes with the pinned key alone", verify(data) === "accepted");
    check("one changed digit in the amount out is caught", verify({ ...data, quote: { ...data.quote, amountOut: `${data.quote.amountOut}0` } }) === "signature");
    check("a changed recipient is caught", verify({ ...data, quoteRequest: { ...data.quoteRequest, recipient: "0x2222222222222222222222222222222222222222" } }) === "signature");
    const fees = data.quoteRequest.appFees as Array<{ recipient: string; fee: number }>;
    check("a redirected fee is caught although fees are unsigned", verify({ ...data, quoteRequest: { ...data.quoteRequest, appFees: fees.map((f, i) => (i === 0 ? { ...f, recipient: "0x2222222222222222222222222222222222222222" } : f)) } }) === "echo:appFees recipient");
  } else {
    check("a genuine response passes with the pinned key alone", false, "the provider did not answer");
  }
}

check("no alert was raised", alerts.length === 0, alerts.join("; "));

// What this script cannot reach, because it would need a real order:
console.log("not checked here: a real order's deposit address, the order status reply, and passing a deposit hash on.");

server.closeAllConnections();
server.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failures === 0 ? "live-check: all checks passed" : `live-check: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
