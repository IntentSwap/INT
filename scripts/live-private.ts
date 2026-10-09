// Asks the real swap provider what it does with a quote that asks for confidential routing,
// using price previews only. It never creates an order: the client below refuses anything but
// a preview.
//
//   npx tsx scripts/live-private.ts                      without a partner key
//   npx tsx --env-file=.env scripts/live-private.ts      with the key the local settings file holds
//
// For a handful of pairs it asks the same preview several ways (public with no fee and with a fee
// of 40; "confidentiality": "basic" with no fee, with a fee of 20 and with a fee of 40) and prints what
// came back: accepted or the provider's own words, the level and the fees the provider echoed,
// the amount out and the time. The key itself is never printed: only whether there is one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { priceToScaled } from "../shared/amounts.ts";
import type { TokenView } from "../shared/api.ts";
import { DEV_FEE_RECIPIENT, loadConfig } from "../server/config.ts";
import { silentLogger } from "../server/log.ts";
import { createOneClick } from "../server/oneclick.ts";
import { buildSentQuote, parseSwapInput } from "../server/quotes.ts";
import { createRpc } from "../server/rpc.ts";
import { createTokenService } from "../server/tokens.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-private-"));
const config = loadConfig({ NODE_ENV: "development", DATA_DIR: dataDir });
// The address the fees tried below are sent with. The site itself sends no fee unless it is set to.
const feeRecipient = config.feeRecipient ?? DEV_FEE_RECIPIENT;
// allowLive is off: this client cannot send anything but a preview. The partner key, when the
// environment holds one, is handed to the client and goes nowhere else.
const apiKey = (process.env.ONECLICK_API_KEY ?? "").trim() || null;
const oneclick = createOneClick({ apiKey, maxPerMin: 600, allowLive: false, log: silentLogger });
console.log(`live-private: asking ${apiKey === null ? "without a partner key" : "with a partner key"}`);
const tokens = createTokenService({ oneclick, rpc: createRpc({ urls: config.rpcUrls }), alerts: { send: () => undefined }, log: silentLogger, dataDir: null, excludedChains: config.excludedChains });
const snapshot = await tokens.snapshot();
if (snapshot === null) {
  console.error("live-private: the coin list did not load");
  process.exit(2);
}
const coins = [...snapshot.byId.values()];
const find = (chain: string, symbol: string) => coins.find((coin) => coin.chain === chain && coin.symbol === symbol);

/** About so many dollars of a coin, in its smallest unit, by whole-number maths. */
function amountOf(coin: TokenView, dollars: bigint): string {
  const price = priceToScaled(Number(coin.price));
  if (price === null || price === 0n) return "0";
  return ((dollars * 10n ** 18n * 10n ** BigInt(coin.decimals)) / price).toString();
}

interface Echo {
  confidentiality?: unknown;
  appFees?: unknown;
  depositMode?: unknown;
  insured?: unknown;
}

async function ask(from: TokenView, to: TokenView, dollars: bigint, level: string | null, fee: number | null): Promise<string> {
  const input = parseSwapInput({ from: from.id, to: to.id, amount: amountOf(from, dollars), pay: "manual" }, snapshot!.byId, false);
  const sent = buildSentQuote(input, { dry: true, now: Date.now(), feeRecipient, feeBps: config.feeBps, feeBpsPrivate: config.feeBpsPrivate }) as unknown as Record<string, unknown>;
  // The request is put together by hand from here, so that each case asks exactly what its name says.
  sent.confidentiality = level ?? "public";
  if (fee === null) delete sent.appFees;
  else sent.appFees = [{ recipient: feeRecipient, fee }];
  const result = await oneclick.quote(sent, "user");
  if (!result.ok) return result.kind === "rejected" ? `refused (${result.status}): ${result.message}` : `unavailable (${result.status ?? "no reply"})`;
  const data = result.data as { quoteRequest?: Echo; quote?: { amountOut?: string; amountOutFormatted?: string; timeEstimate?: number; amountInUsd?: string; amountOutUsd?: string; depositAddress?: unknown } };
  const echo = data.quoteRequest ?? {};
  return `accepted; echo confidentiality=${JSON.stringify(echo.confidentiality)} appFees=${JSON.stringify(echo.appFees)} depositMode=${JSON.stringify(echo.depositMode)}; out ${data.quote?.amountOutFormatted ?? data.quote?.amountOut} (in $${data.quote?.amountInUsd}, out $${data.quote?.amountOutUsd}), ${data.quote?.timeEstimate}s`;
}

const PAIRS: [string, string, string, string, bigint][] = [
  ["base", "ETH", "sol", "USDT", 50n],
  ["sol", "SOL", "base", "ETH", 50n],
  ["bsc", "BNB", "sol", "USDT", 40n],
  ["bsc", "BNB", "sol", "USDT", 1500n],
  ["base", "USDC", "arb", "USDC", 50n],
  ["eth", "ETH", "btc", "BTC", 200n],
  ["btc", "BTC", "eth", "USDT", 200n],
  ["tron", "USDT", "base", "USDC", 50n],
  ["zec", "ZEC", "base", "USDC", 50n],
  ["base", "ETH", "zec", "ZEC", 50n],
];

for (const [fromChain, fromSymbol, toChain, toSymbol, dollars] of PAIRS) {
  const from = find(fromChain, fromSymbol);
  const to = find(toChain, toSymbol);
  if (!from || !to) {
    console.log(`\n${fromSymbol} on ${fromChain} to ${toSymbol} on ${toChain}: not on the coin list`);
    continue;
  }
  console.log(`\n${fromSymbol} on ${fromChain} to ${toSymbol} on ${toChain}, about $${dollars}`);
  for (const [name, level, fee] of [
    ["public, no fee           ", null, null],
    ["public, fee 40           ", null, 40],
    ["private (basic), no fee  ", "basic", null],
    ["private (basic), fee 20  ", "basic", 20],
    ["private (basic), fee 40  ", "basic", 40],
  ] as const) {
    try {
      console.log(`  ${name}: ${await ask(from, to, dollars, level, fee)}`);
    } catch (error) {
      console.log(`  ${name}: not sent: ${(error as Error).message}`);
    }
  }
}
fs.rmSync(dataDir, { recursive: true, force: true });
