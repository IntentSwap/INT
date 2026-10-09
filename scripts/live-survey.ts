// Asks the real swap provider what it accepts today, using price previews only.
// It never creates an order: the client below refuses anything but a preview.
//
//   npx tsx scripts/live-survey.ts               one coin per chain, both directions, and the fee table
//   npx tsx scripts/live-survey.ts --all-coins   every coin, both directions (several minutes)
//
// It reports, per chain: whether a small swap is accepted in each direction (which also shows
// whether our preview stand-in address is accepted there), any minimum the provider names,
// and whether the provider answers under the coin ID we asked for. Then how a fee is split.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { priceToScaled } from "../shared/amounts.ts";
import { chainInfo } from "../shared/chains.ts";
import type { TokenView } from "../shared/api.ts";
import { loadConfig } from "../server/config.ts";
import { HttpError } from "../server/http.ts";
import { silentLogger } from "../server/log.ts";
import { createOneClick } from "../server/oneclick.ts";
import { buildSentQuote, parseSwapInput } from "../server/quotes.ts";
import { createRpc } from "../server/rpc.ts";
import { createTokenService } from "../server/tokens.ts";

const allCoins = process.argv.includes("--all-coins");
const DOLLARS = 25n;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-survey-"));
const config = loadConfig({ NODE_ENV: "development", DATA_DIR: dataDir });
// allowLive is off: this client cannot send anything but a preview.
const oneclick = createOneClick({ apiKey: null, maxPerMin: 600, allowLive: false, log: silentLogger });
const tokens = createTokenService({ oneclick, rpc: createRpc({ urls: config.rpcUrls }), alerts: { send: () => undefined }, log: silentLogger, dataDir: null });

const snapshot = await tokens.snapshot();
if (snapshot === null) {
  console.error("live-survey: the coin list did not load");
  process.exit(2);
}
const coins = [...snapshot.byId.values()];
const priced = (coin: TokenView) => coin.price !== null && Number(coin.price) > 0;

/** About $25 of a coin, in its smallest unit, by whole-number maths. */
function amountOf(coin: TokenView): string {
  const price = priceToScaled(Number(coin.price));
  if (price === null || price === 0n) return "0";
  return ((DOLLARS * 10n ** 18n * 10n ** BigInt(coin.decimals)) / price).toString();
}

interface Answer {
  /** "accepted", or the provider's own words, or ours when the request never left. */
  text: string;
  /** Coin IDs in the echoed request, when they differ from what was sent. */
  renamed: string | null;
  data: { quoteRequest?: { appFees?: Array<{ recipient: string; fee: number }> } } | null;
}

async function preview(from: TokenView, to: TokenView, feeBps: number | null = config.feeBps): Promise<Answer> {
  let sent: Record<string, unknown>;
  try {
    const input = parseSwapInput({ from: from.id, to: to.id, amount: amountOf(from), pay: "manual" }, snapshot!.byId, false);
    sent = buildSentQuote(input, { dry: true, now: Date.now(), feeRecipient: config.feeRecipient, feeBps: feeBps ?? config.feeBps, feeBpsPrivate: config.feeBpsPrivate }) as unknown as Record<string, unknown>;
  } catch (err) {
    return { text: `not sent: ${err instanceof HttpError ? err.message : "error"}`, renamed: null, data: null };
  }
  if (feeBps === null) delete sent.appFees;
  const result = await oneclick.quote(sent, "user");
  if (!result.ok) return { text: result.kind === "rejected" ? result.message : `unavailable (${result.status ?? "no reply"})`, renamed: null, data: null };
  const data = result.data as { quoteRequest?: { originAsset?: string; destinationAsset?: string; appFees?: Array<{ recipient: string; fee: number }> } };
  const echo = data.quoteRequest ?? {};
  const renamed = [echo.originAsset !== from.id ? `${from.id} answered as ${echo.originAsset}` : null, echo.destinationAsset !== to.id ? `${to.id} answered as ${echo.destinationAsset}` : null].filter((x) => x !== null);
  return { text: "accepted", renamed: renamed.length > 0 ? renamed.join("; ") : null, data };
}

/** Runs jobs a few at a time, in order. */
async function pool<T>(jobs: Array<() => Promise<T>>, width = 4): Promise<T[]> {
  const out: T[] = new Array<T>(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]!();
      }
    }),
  );
  return out;
}

const find = (chain: string, symbol: string) => coins.find((c) => c.chain === chain && c.symbol === symbol);
const baseUsdc = find("base", "USDC");
const arbUsdc = find("arb", "USDC");
if (!baseUsdc || !arbUsdc) {
  console.error("live-survey: USDC on Base or Arbitrum is not listed");
  process.exit(2);
}
const other = (coin: TokenView) => (coin.chain === "base" ? arbUsdc : baseUsdc);

// One coin per chain (the native coin when there is one), or every coin.
const chains = [...new Set(coins.map((c) => c.chain))].sort();
const chosen = allCoins ? coins.filter(priced) : chains.map((chain) => coins.find((c) => c.chain === chain && c.contract === null && priced(c)) ?? coins.find((c) => c.chain === chain && priced(c))).filter((c) => c !== undefined);

console.log(`live-survey: ${coins.length} coins on ${chains.length} chains; previews of about $${DOLLARS} for ${chosen.length} coin(s), both directions\n`);
const rows = await pool(
  chosen.map((coin) => async () => {
    const [out, back] = await Promise.all([preview(coin, other(coin)), preview(other(coin), coin)]);
    return { coin, out, back };
  }),
);

const renamed = new Set<string>();
let accepted = 0;
for (const { coin, out, back } of rows) {
  for (const answer of [out, back]) {
    if (answer.renamed !== null) renamed.add(answer.renamed);
    if (answer.text === "accepted") accepted += 1;
  }
  console.log(`${chainInfo(coin.chain).name} (${coin.chain}), ${coin.symbol}`);
  console.log(`  from it: ${out.text}`);
  console.log(`  to it:   ${back.text}`);
}
console.log(`\n${accepted} of ${rows.length * 2} previews accepted`);
console.log(renamed.size === 0 ? "every answer came back under the coin ID that was asked for" : `answered under another coin ID:\n  ${[...renamed].join("\n  ")}`);

// The same swap with different fees: what the provider says each side receives.
const baseEth = find("base", "ETH");
if (baseEth) {
  console.log("\nfee we send -> echoed to us + echoed to others (bps)");
  for (const fee of [null, 10, 20, 40, 100]) {
    const answer = await preview(baseEth, arbUsdc, fee);
    const echoed = answer.data?.quoteRequest?.appFees ?? [];
    const ours = echoed.filter((f) => f.recipient.toLowerCase() === config.feeRecipient.toLowerCase()).reduce((sum, f) => sum + f.fee, 0);
    const theirs = echoed.filter((f) => f.recipient.toLowerCase() !== config.feeRecipient.toLowerCase()).reduce((sum, f) => sum + f.fee, 0);
    console.log(`  ${fee === null ? "none" : String(fee).padStart(4)} -> ${answer.text === "accepted" ? `${ours} + ${theirs}` : answer.text}`);
  }
}

fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
