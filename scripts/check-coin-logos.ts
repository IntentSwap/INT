// Fails when a coin on a running site's list has no logo, naming each one. For whoever runs the
// site, after the provider has listed new coins:
//
//   npm run check:logos -- http://127.0.0.1:8799
//
// (the address is the site to ask; the one above is the default). A coin has a logo when the icon
// lookup the page itself uses (web/src/lib/icons.ts) names a picture for it and that picture is a
// file under web/public. A coin with none is still drawn, as the plain drawing every such coin
// gets, so nothing is broken while this fails: it says that a coin is waiting for its logo.
//
// The coins below were looked for, by chain and contract, in the collection the logos come from
// (see "Credits" in the README) and are not in it. They are let through, so that the check passes
// today and fails only for a coin nobody has looked at. An entry whose coin has since been given
// a logo fails the check too: the list holds no more than what is true.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chainIconUrl, coinIconUrl, coinKey } from "../web/src/lib/icons.ts";

const NOT_THERE = "no logo in the collection";

/** Coins known to have no logo, each named by its chain and contract as the icon lookup names it, with its symbol for whoever reads the list. */
export const NO_LOGO: Readonly<Record<string, string>> = {
  "aleo:usad": "USAD",
  "aleo:usdcx": "USDCx",
  "base:0x0382e3fee4a420bd446367d468a6f00225853420": "CFI",
  "base:0x0bb69b79bc829e1cfcc34a740110886d98d2bd14": "gtUSDCp",
  "base:0x1c4a802fd6b591bb71daa01d8335e43719048b24": "sUSDC",
  "base:0x3388d158fdcc31398b99478420e6945cdaace009": "mwUSDC",
  "base:0x7429743f8adbbe932b27bc02267b0e70f1ba688b": "sparkUSDC",
  "base:0x959fc04dbf97a27073f89237cd62605f4d1b906d": "COCA",
  "base:0xc2bc2a4cd04358281c7cf36a057fc15e5552b18b": "SSC1_PIT",
  "base:0xc343558b52b5757e3d59f0fe12ad33b52d3e2dd2": "laUSDC",
  "base:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC",
  "base:0xe62bfbe57763ec24c0f130426f34dbce11fc5b06": "TITN",
  "bsc:0x4c067de26475e1cefee8b8d1f6e2266b33a2372e": "RHEA",
  "bsc:0x5382555840ef9f54ef6d3ee5da60f12bcabf4b87": "nrUsdt",
  "eth:0x06ea695b91700071b161a434fed42d1dcbad9f00": "hemiBTC",
  "eth:0x0f38f1ce62776d4a0038bc6cac66877a5687383b": "TLO",
  "eth:0xaf08e292d62df255f7953665a44ed65f0380aa60": "steakUSDC",
  "eth:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC",
  "eth:0xdef1b2d939edc0e4d35806c59b3166f790175afe": "INX",
  "gnosis:0x5cb9073902f2035222b9749f8fb0c9bfe5527108": "GBPe",
  "hood:0x39dbed3a2bd333467115de45665cc57f813c4571": "PONS",
  // The collection's picture for this one is the chain's own mark, not the coin's logo: it is not used.
  "hood:0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG",
  "hypercore:0x20b8c9d2f022ffd2aea4f7962b7b1d8b": "wNEAR",
  "movement:0xba11833544a2f99eec743f41a228ca6ffa7f13c3b6b04681d5a79a8b75ff225e": "USDCx",
  "near:blackdragon.tkn.near": "BLACKDRAGON",
  "near:cfi.consumer-fi.near": "CFI",
  "near:itlx.intellex_xyz.near": "ITLX",
  "near:jambo-1679.meme-cooking.near": "JAMBO",
  "near:kat.token0.near": "NearKat",
  "near:lsd-usdt.rhealab.near": "nrUsdt",
  "near:meta-pool.near": "stNEAR",
  "near:mpdao-token.near": "mpDAO",
  "near:npro.nearmobile.near": "NPRO",
  "near:purge-558.meme-cooking.near": "PURGE",
  "near:qtc.omft.near": "QTC",
  "near:token.0xshitzu.near": "SHITZU",
  "near:token.publicailab.near": "PUBLIC",
  "near:token.rhealab.near": "RHEA",
  "pol:0x7b12598e3616261df1c05ec28de0d2fb10c1f206": "COCA",
  "qtc:": "QTC",
  "sol:3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG": "wNEAR",
  "sol:3tMdx4g4grCgqHjELqALfTPnZnG1BLwsPntD3tGREgvp": "sUSDC",
  "sol:415bGhU9GtBPPnbtz9csVfcEvFSkVMWJKxQQYAggCUBQ": "wNEARKAT",
  "sol:5EBsGgVTubrd7ShJgE89k6nC2bnLzqGCjXb2ejrhtdBK": "kV-gtSOLb",
  "sol:6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr": "NEARKAT",
  "sol:8SMMso8Muv8d6i4WmMDthKt6TN1ysN6937sx3DKLXZqB": "RHEA",
  "sol:AXCp86262ZPfpcV9bmtmtnzmJSL5sD99mCVJD4GR9vS": "PUBLIC",
  "sol:CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn": "xBTC",
  "sol:EJZJpNa4tDZ3kYdcRZgaAtaKm3fLJ5akmyPkCaKmfWvd": "LOUD",
};

/** Chains known to have no mark of their own, for the same reason. */
export const NO_CHAIN_LOGO: ReadonlySet<string> = new Set(["qtc"]);

export interface ListedCoin {
  id: string;
  symbol: string;
  chain: string;
  contract: string | null;
}

/** What is wrong with a list of coins: one line for each coin or chain without a logo, and for each entry above that is no longer true. */
export function logoProblems(tokens: readonly ListedCoin[], publicDir: string): string[] {
  const problems: string[] = [];
  const there = (url: string) => fs.existsSync(path.join(publicDir, url));
  for (const token of tokens) {
    const key = coinKey(token.chain, token.contract);
    const url = coinIconUrl(token.symbol, token.chain, token.contract);
    const where = `${token.symbol} on ${token.chain} (${token.contract ?? "the chain's own coin"}, ${token.id})`;
    if (url !== null && !there(url)) problems.push(`${where}: its logo ${url} is not a file of the site`);
    else if (url !== null && key in NO_LOGO) problems.push(`${where}: has a logo now, and is still listed as having none (take "${key}" out of the list in scripts/check-coin-logos.ts)`);
    else if (url === null && !(key in NO_LOGO)) problems.push(`${where}: has no logo (add one, or list "${key}" in scripts/check-coin-logos.ts with the reason)`);
  }
  for (const chain of new Set(tokens.map((token) => token.chain))) {
    const url = chainIconUrl(chain);
    if (url !== null && !there(url)) problems.push(`the chain ${chain}: its mark ${url} is not a file of the site`);
    else if (url === null && !NO_CHAIN_LOGO.has(chain)) problems.push(`the chain ${chain}: has no mark (add one, or list it in scripts/check-coin-logos.ts with the reason)`);
  }
  return problems;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const site = process.argv[2] ?? "http://127.0.0.1:8799";
  let tokens: ListedCoin[];
  try {
    const answer = await fetch(new URL("/api/tokens", site), { signal: AbortSignal.timeout(20_000) });
    if (!answer.ok) throw new Error(`answered ${answer.status}`);
    const body = (await answer.json()) as { tokens?: unknown };
    if (!Array.isArray(body.tokens) || body.tokens.length === 0) throw new Error("gave no list of coins");
    tokens = body.tokens as ListedCoin[];
  } catch (error) {
    console.error(`check-coin-logos: ${site} ${(error as Error).message} (is the site running there?)`);
    process.exit(1);
  }
  const problems = logoProblems(tokens, path.resolve("web", "public"));
  const waiting = tokens.filter((token) => coinKey(token.chain, token.contract) in NO_LOGO);
  console.log(`check-coin-logos: ${tokens.length} coins listed, ${tokens.length - waiting.length} with a logo, ${waiting.length} shown as the plain drawing (${NOT_THERE})`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-coin-logos: ${problem}`);
    process.exit(1);
  }
  console.log("check-coin-logos: ok");
}
