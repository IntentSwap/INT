import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { routingOf, SLIPPAGE, SLIPPAGE_BOUNDS_WORDS, type QuoteView, type TokenView } from "../shared/api.ts";
import { displayBps } from "../shared/amounts.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NO_CHAIN_LOGO, NO_LOGO, logoProblems } from "../scripts/check-coin-logos.ts";
import { ICON_SIDE, pictureType } from "../scripts/make-coin-icons.ts";
import { ALLOWLIST } from "../server/allowlist.ts";
import { CoinIcon } from "../web/src/components/CoinIcon.tsx";
import * as icons from "../web/src/lib/icons.ts";
import { CHAIN_ICONS, CHAIN_LOGOS, COIN_ICONS, COIN_LOGOS, chainIconUrl, coinIconUrl, coinKey, coinLogoName, logoUrl } from "../web/src/lib/icons.ts";
import { DEPOSIT_CLOSE_MS, payWindowMs, sendWindowMs } from "../shared/chains.ts";
import { HEADLINE_SUB, headlineWords, POSITIONING } from "../shared/positioning.ts";
import { swapPointsMicro } from "../shared/rewards.ts";
import { readRecent, withOrder } from "../web/src/stores/orders.ts";
import { quoteAge } from "../web/src/stores/swap.ts";
import { isToken } from "../web/src/stores/tokens.ts";
import { aboutMinutes, addressParts, amountStep, cleanAmount, coinLabel, estimateUsd, lookAlikes, maxSpendable, fitAmount, isContractCode, maxAmountChars, minimumNote, minutesText, orderDiffers, parsePrefill, refreshDue, retriesItself, reviewAction, reviewSentence, shouldAnnounce, walletAddressFor, primaryAction, rateText, roundUpForDisplay, searchTokens, shortAddress, sortTokens, chainCoins, contractChain, gridMove, pickerInHistory, pickerRows, searchChains, type ActionInput, percentToBps, slippageAdvice, SLIPPAGE_CHOICES, balanceCalls, readBalance, refundFor, asksForRefund, fitLabel, pointsByDefault, appFeeWords, cardRouting, feeFree, modeTold, quoteAnnouncement, routedPrivately, routingChoice, routingNote, CARD_BUTTON_ROOM, PRIVATE_UNAVAILABLE } from "../web/src/lib/swap-logic.ts";
import { matchRoute } from "../web/src/router.ts";

const coin = (symbol: string, chain: string, extra: Partial<TokenView> = {}): TokenView => ({ id: `${chain}:${symbol}`, symbol, name: symbol, chain, decimals: 18, price: "1", contract: null, wallet: false, ...extra });
const ETH = coin("ETH", "base", { name: "Ethereum" });
const USDT_SOL = coin("USDT", "sol", { name: "Tether USD", decimals: 6, contract: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" });
const BTC = coin("BTC", "btc", { name: "Bitcoin", decimals: 8 });
const EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOL = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

describe("amount field sizing", () => {
  it("starts at 28 and steps down to 24, 20, 16, 14, 12 and 11 as the number grows", () => {
    // On a laptop the amount has 259 px of room beside the coin selector.
    expect(amountStep(0, 259)).toBe(28);
    expect(amountStep(5, 259)).toBe(28);
    expect(amountStep(15, 259)).toBe(28);
    expect(amountStep(16, 259)).toBe(24);
    expect(amountStep(17, 259)).toBe(24);
    expect(amountStep(18, 259)).toBe(20);
    expect(amountStep(21, 259)).toBe(20);
    expect(amountStep(22, 259)).toBe(16);
    expect(amountStep(26, 259)).toBe(16);
    expect(amountStep(27, 259)).toBe(14);
    expect(amountStep(30, 259)).toBe(14);
    expect(amountStep(31, 259)).toBe(12);
    expect(amountStep(35, 259)).toBe(12);
    expect(amountStep(36, 259)).toBe(11);
    expect(amountStep(40, 259)).toBe(11);
  });

  it("holds an amount with all eighteen decimals, whole, at 360 px", () => {
    // "0." and eighteen figures: what Max gives from a real balance. At 360 px the amount has 139 px of room.
    const text = "0.123456789012345678";
    expect(maxAmountChars(139)).toBeGreaterThanOrEqual(text.length);
    expect(text.length * amountStep(text.length, 139) * 0.6).toBeLessThanOrEqual(139);
    expect(fitAmount(text, maxAmountChars(139))).toBe(text);
  });

  it("fits the three test amounts at 360 px without clipping", () => {
    // At a 360 px viewport the amount has 139 px of room beside the coin selector (scripts/review-shots.ts measures the real thing).
    for (const text of ["0.00000001", "123456789.123456", "1000000000"]) {
      const size = amountStep(text.length, 139);
      expect(text.length * size * 0.6, text).toBeLessThanOrEqual(139);
    }
  });
});

describe("what may be typed as an amount", () => {
  it("takes digits and one decimal point", () => {
    expect(cleanAmount("0.5", 18)).toBe("0.5");
    expect(cleanAmount("12", 6)).toBe("12");
    expect(cleanAmount(".5", 6)).toBe(".5");
    expect(cleanAmount("5.", 6)).toBe("5.");
    expect(cleanAmount("", 6)).toBe("");
    expect(cleanAmount(" 1 000 ", 6)).toBe("1000");
  });
  it("takes a lone comma as the decimal point, as many keyboards type it", () => {
    expect(cleanAmount("1,5", 6)).toBe("1.5");
    expect(cleanAmount(",5", 6)).toBe(".5");
    // A comma beside a point, or two commas, is a thousands separator or a mistake: not taken.
    expect(cleanAmount("1,234.5", 6)).toBeNull();
    expect(cleanAmount("1,2,3", 6)).toBeNull();
  });
  it("refuses more decimals than the coin has, and anything that is not a number", () => {
    expect(cleanAmount("0.1234567", 6)).toBeNull();
    expect(cleanAmount("0.123456", 6)).toBe("0.123456");
    expect(cleanAmount("1.5", 0)).toBeNull();
    for (const text of ["abc", "-1", "1e5", "0x10", "1.2.3", "١٢٣", "1٫5"]) expect(cleanAmount(text, 18), text).toBeNull();
  });
  it("refuses what could not fit in the field", () => {
    expect(cleanAmount("1".repeat(21), 18, 21)).toBe("1".repeat(21));
    expect(cleanAmount("1".repeat(22), 18, 21)).toBeNull();
    expect(cleanAmount("1".repeat(41), 18, 100)).toBeNull();
  });
});

describe("the Max button", () => {
  const native = { decimals: 18, contract: null };
  const token = { decimals: 6, contract: "0xabc" };
  it("keeps a reserve for network fees when the coin is the chain's own", () => {
    expect(maxSpendable(1_000_000_000_000_000_000n, native, "0.001")).toBe("0.999");
    expect(maxSpendable(5_000_000_000n, { decimals: 9, contract: null }, "0.01")).toBe("4.99");
  });
  it("never goes below zero when the balance is smaller than the reserve", () => {
    expect(maxSpendable(500_000_000_000_000n, native, "0.001")).toBe("0");
    expect(maxSpendable(0n, native, "0.001")).toBe("0");
  });
  it("uses the whole balance of a token, and of a coin with no reserve set", () => {
    expect(maxSpendable(25_000_000n, token, "0.001")).toBe("25");
    expect(maxSpendable(1_234_567n, token, undefined)).toBe("1.234567");
    expect(maxSpendable(1_000_000_000_000_000_000n, native, undefined)).toBe("1");
  });
});

describe("an amount never scrolls inside its field", () => {
  it("accepts only as many characters as fit at the smallest size", () => {
    // 139 px of room at 360 px wide; one character at 11 px takes 6.6 px.
    expect(maxAmountChars(139)).toBe(21);
    expect(maxAmountChars(259)).toBe(39);
    expect(maxAmountChars(10_000)).toBe(40);
    expect(maxAmountChars(0)).toBe(8);
    // Whatever is accepted fits without clipping.
    for (const width of [139, 200, 259]) expect(maxAmountChars(width) * 11 * 0.6).toBeLessThanOrEqual(width);
  });

  it("shortens a longer amount by dropping decimals, never by rounding up or touching the whole part", () => {
    expect(fitAmount("123.123456789012345678", 21)).toBe("123.12345678901234567");
    expect(fitAmount("0.999999999999999999", 10)).toBe("0.99999999");
    expect(fitAmount("12345.6789", 6)).toBe("12345");
    expect(fitAmount("1234567890", 4)).toBe("1234567890");
    expect(fitAmount("1.5", 21)).toBe("1.5");
  });
});

describe("what a dollar minimum comes to in the coin being paid", () => {
  it("gives the amount, rounded up so that typing it is enough (the button already names the dollars)", () => {
    expect(minimumNote({ usd: "1000" }, { symbol: "BNB", decimals: 18, price: "760.4" })).toBe("That is about 1.316 BNB.");
    expect(minimumNote({ usd: "100" }, { symbol: "TRX", decimals: 6, price: "0.3123" })).toBe("That is about 320.3 TRX.");
  });
  it("says nothing without a price or a clean figure", () => {
    expect(minimumNote({ usd: "1000" }, { symbol: "BNB", decimals: 18, price: null })).toBeNull();
    expect(minimumNote({ usd: "1000" }, null)).toBeNull();
    expect(minimumNote({ usd: "1e3" }, { symbol: "BNB", decimals: 18, price: "760.4" })).toBeNull();
    expect(minimumNote({}, { symbol: "BNB", decimals: 18, price: "760.4" })).toBeNull();
  });
});

describe("small formatters", () => {
  it("writes time as about N min, never seconds", () => {
    expect(aboutMinutes(0)).toBe("about 1 min");
    expect(aboutMinutes(34)).toBe("about 1 min");
    expect(aboutMinutes(60)).toBe("about 1 min");
    expect(aboutMinutes(61)).toBe("about 2 min");
    expect(aboutMinutes(812)).toBe("about 14 min");
  });

  it("has a four…four form for the header on a phone", () => {
    expect(shortAddress(EVM, 4)).toBe("0xd8…6045");
    expect(shortAddress("0x1234", 4)).toBe("0x1234");
  });

  it("shortens an address to six…six and splits it for emphasis", () => {
    expect(shortAddress(EVM)).toBe("0xd8dA…A96045");
    expect(shortAddress("alice.near")).toBe("alice.near");
    expect(addressParts(EVM)).toEqual({ start: "0xd8dA", middle: "6BF26964aF9D7eEd9e03E53415D37a", end: "A96045" });
    expect(addressParts(EVM).start + addressParts(EVM).middle + addressParts(EVM).end).toBe(EVM);
    expect(addressParts("short")).toEqual({ start: "short", middle: "", end: "" });
  });

  it("always names the chain with the coin", () => {
    expect(coinLabel(coin("USDT", "bsc"))).toBe("USDT · BNB Chain");
    expect(coinLabel(ETH)).toBe("ETH · Base");
  });

  it("writes the rate from whole-number maths", () => {
    expect(rateText(ETH, USDT_SOL, 5000000000000000n, 12734514n)).toBe("1 ETH = 2,546.90 USDT");
    expect(rateText(USDT_SOL, ETH, 25000000n, 9990000000000000n)).toBe("1 USDT = 0.0003996 ETH");
    expect(rateText(ETH, USDT_SOL, 0n, 1n)).toBeNull();
    // A very small rate: the screen shows the short form with a subscript, a screen reader is given every digit.
    const tiny = coin("BLACKDRAGON", "near", { decimals: 24 });
    expect(rateText(USDT_SOL, tiny, 1000000n, 812345678901234567890123456789012n)).toBe("1 USDT = 812,345,678.90 BLACKDRAGON");
    expect(rateText(tiny, USDT_SOL, 10n ** 30n, 1n)).toBe("1 BLACKDRAGON = 0 USDT");
    const small = coin("WBTC", "eth", { decimals: 8 });
    expect(rateText(coin("SHIB", "eth", { decimals: 18 }), small, 10n ** 18n, 12n)).toBe("1 SHIB = 0.0₆12 WBTC");
    expect(rateText(coin("SHIB", "eth", { decimals: 18 }), small, 10n ** 18n, 12n, { spoken: true })).toBe("1 SHIB = 0.00000012 WBTC");
    // An ordinary rate is said as it is shown.
    expect(rateText(ETH, USDT_SOL, 5000000000000000n, 12734514n, { spoken: true })).toBe("1 ETH = 2,546.90 USDT");
  });

  it("rounds a minimum up, so typing the number shown always meets it", () => {
    expect(roundUpForDisplay(2725340300683302n, 18)).toBe("0.002726");
    expect(roundUpForDisplay(2725000000000000n, 18)).toBe("0.002725");
    expect(roundUpForDisplay(559731400810026n, 18)).toBe("0.0005598");
    expect(roundUpForDisplay(1234n, 6)).toBe("0.001234");
    expect(roundUpForDisplay(999950000n, 6)).toBe("1000");
    expect(roundUpForDisplay(0n, 6)).toBe("0");
  });
});

describe("coin picker order and search", () => {
  const list = [
    coin("AAVE", "eth"),
    coin("USDC", "sol"),
    coin("ZEC", "zec"),
    coin("USDT", "sol"),
    coin("ETH", "arb"),
    coin("SOL", "sol"),
    coin("NEAR", "bsc"),
    coin("USDT", "bsc"),
    coin("BTC", "btc"),
    coin("ETH", "eth"),
    coin("BNB", "bsc"),
    coin("DOGE", "doge"),
    coin("USDT", "eth"),
    coin("ARB", "arb"),
    coin("ETH", "base"),
  ];
  const names = (tokens: TokenView[]) => tokens.map((t) => `${t.symbol}@${t.chain}`);

  it("lists BNB, USDT, USDC, ETH, BTC, SOL, ZEC, NEAR first, then the rest alphabetically", () => {
    expect(names(sortTokens(list))).toEqual([
      "BNB@bsc",
      "USDT@bsc",
      "USDT@eth",
      "USDT@sol",
      "USDC@sol",
      "ETH@eth",
      "ETH@base",
      "ETH@arb",
      "BTC@btc",
      "SOL@sol",
      "ZEC@zec",
      "NEAR@bsc",
      "AAVE@eth",
      "ARB@arb",
      "DOGE@doge",
    ]);
  });

  it("puts coins the person holds right after the pinned ones", () => {
    const balances = new Map([["doge:DOGE", 5n], ["eth:AAVE", 0n]]);
    const sorted = names(sortTokens(list, balances));
    expect(sorted.slice(12)).toEqual(["DOGE@doge", "AAVE@eth", "ARB@arb"]);
  });

  it("searches by symbol and name, best matches first, within the chosen chain", () => {
    const tokens = sortTokens([ETH, USDT_SOL, BTC, coin("WETH", "eth", { name: "Wrapped Ether" }), coin("ETHFI", "eth", { name: "Ether.fi" })]);
    const found = (query: string, chain: string | null = null) => {
      const result = searchTokens(tokens, query, chain);
      return result.kind === "list" ? names(result.tokens) : result.kind;
    };
    expect(found("eth")).toEqual(["ETH@base", "ETHFI@eth", "WETH@eth"]);
    expect(found("ETH", "eth")).toEqual(["ETHFI@eth", "WETH@eth"]);
    expect(found("bitcoin")).toEqual(["BTC@btc"]);
    expect(found("tether")).toEqual(["USDT@sol"]);
    expect(found("  ")).toEqual(names(tokens));
    expect(found("zzz")).toEqual([]);
    expect(found("solana")).toEqual(["USDT@sol"]);
  });

  it("finds a listed coin by its contract, and says Not supported for any other contract", () => {
    const tokens = [ETH, USDT_SOL, coin("USDC", "base", { contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" })];
    expect(searchTokens(tokens, SOL, null)).toEqual({ kind: "list", tokens: [USDT_SOL] });
    expect(searchTokens(tokens, "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913", null).kind).toBe("list");
    expect(searchTokens(tokens, "0x1111111111111111111111111111111111111111", null)).toEqual({ kind: "unsupported" });
    expect(searchTokens(tokens, "So11111111111111111111111111111111111111112", null)).toEqual({ kind: "unsupported" });
    // A pasted contract never falls back to a look-alike by name.
    expect(searchTokens([coin("0x1111", "eth")], "0x1111111111111111111111111111111111111111", null)).toEqual({ kind: "unsupported" });
  });
});

describe("the coin picker, one chain at a time", () => {
  const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const USDC_ARB = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
  // A contract two chains share: the same address on Arbitrum and on Optimism.
  const SHARED = "0x01bff41798a0bcf287b996046ca68b395dbc1071";
  const tokens = [
    coin("WETH", "base", { name: "Wrapped Ether", contract: "0x4200000000000000000000000000000000000006" }),
    coin("BRETT", "base", { name: "Brett", contract: "0x532f27101965dd16442e59d40670faf5ebb142e4" }),
    coin("USDC", "base", { name: "USD Coin", decimals: 6, contract: USDC_BASE }),
    coin("sUSDC", "base", { name: "Spark USDC Vault", contract: "0x3128a0f7f0ea68e7b7c9b00afa7e41045828e858" }),
    coin("DAI", "base", { name: "Dai Stablecoin", contract: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb" }),
    coin("usdt", "base", { name: "Tether USD", decimals: 6, contract: "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2" }),
    ETH,
    coin("cbBTC", "base", { name: "Coinbase Wrapped BTC", decimals: 8, contract: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf" }),
    coin("USDC", "arb", { name: "USD Coin", decimals: 6, contract: USDC_ARB }),
    coin("USDT0", "arb", { name: "USDT0", decimals: 6, contract: SHARED }),
    coin("USDT0", "op", { name: "USDT0", decimals: 6, contract: SHARED }),
    coin("ETH", "arb", { name: "Ethereum" }),
    USDT_SOL,
    coin("SOL", "sol", { name: "Solana" }),
    BTC,
    coin("wNEAR", "near", { name: "Wrapped NEAR", decimals: 24, contract: "wrap.near" }),
    coin("BLACKDRAGON", "near", { name: "Black Dragon", decimals: 24, contract: "blackdragon.tkn.near" }),
  ];
  const symbols = (list: TokenView[]) => list.map((token) => token.symbol);
  const shown = (query: string, chain: string, balances?: Map<string, bigint>) => {
    const result = pickerRows(tokens, query, chain, balances);
    return result.kind === "here" || result.kind === "elsewhere" ? `${result.kind}: ${result.tokens.map((token) => `${token.symbol}@${token.chain}`).join(" ")}` : result.kind;
  };

  it("lists a chain's own coin first, then the stablecoins in their set order, then the rest by name", () => {
    expect(symbols(chainCoins(tokens, "base"))).toEqual(["ETH", "usdt", "USDC", "DAI", "BRETT", "cbBTC", "sUSDC", "WETH"]);
    // A chain's own coin is the one with no contract. A chain that has none starts with what it has.
    expect(symbols(chainCoins(tokens, "near"))).toEqual(["BLACKDRAGON", "wNEAR"]);
    expect(symbols(chainCoins(tokens, "sol"))).toEqual(["SOL", "USDT"]);
    expect(symbols(chainCoins(tokens, "btc"))).toEqual(["BTC"]);
    expect(chainCoins(tokens, "tron")).toEqual([]);
    // Only that chain's coins, and the list it was given is left as it was.
    expect(chainCoins(tokens, "base").every((token) => token.chain === "base")).toBe(true);
    expect(tokens[0]!.symbol).toBe("WETH");
  });

  it("with nothing typed, shows the chosen chain's coins and no other chain's", () => {
    expect(shown("", "base")).toBe("here: ETH@base usdt@base USDC@base DAI@base BRETT@base cbBTC@base sUSDC@base WETH@base");
    expect(shown("  ", "arb")).toBe("here: ETH@arb USDC@arb USDT0@arb");
  });

  it("puts the coins a wallet holds at the top of their chain's list, the one worth most in dollars first, and leaves the rest in the chain's own order", () => {
    // 5 USDC is worth more than 2 Wrapped Ether at a dollar each, though it is the smaller number (six decimals against eighteen).
    const held = new Map([["base:WETH", 2n * 10n ** 18n], ["base:USDC", 5_000_000n]]);
    expect(shown("", "base", held)).toBe("here: USDC@base WETH@base ETH@base usdt@base DAI@base BRETT@base cbBTC@base sUSDC@base");
    // It is the dollars that count: at its real price the Wrapped Ether comes first.
    const priced = tokens.map((token) => (token.id === "base:WETH" ? { ...token, price: "3000.5" } : token));
    expect(symbols(chainCoins(priced, "base", held)).slice(0, 3)).toEqual(["WETH", "USDC", "ETH"]);
    // A held coin with no price comes after the held coins that have one, and before every coin that is not held.
    const unpriced = tokens.map((token) => (token.id === "base:WETH" ? { ...token, price: null } : token));
    expect(symbols(chainCoins(unpriced, "base", new Map([...held, ["base:BRETT", 1n]]))).slice(0, 4)).toEqual(["USDC", "BRETT", "WETH", "ETH"]);
    // Coins worth the same keep the chain's own order among themselves.
    expect(symbols(chainCoins(tokens, "base", new Map([["base:WETH", 10n ** 18n], ["base:DAI", 10n ** 18n], ["base:ETH", 10n ** 18n]]))).slice(0, 4)).toEqual(["ETH", "DAI", "WETH", "usdt"]);
    // Holding none of a coin, or holding a coin of another chain, moves nothing.
    expect(shown("", "base", new Map([["base:WETH", 0n], ["arb:USDC", 9_000_000n]]))).toBe(shown("", "base"));
    expect(shown("", "arb", new Map([["arb:USDC", 9_000_000n]]))).toBe("here: USDC@arb ETH@arb USDT0@arb");
    // A search of the chain puts what is held first within each rank of match, and never above a better match.
    expect(shown("usd", "base", new Map([["base:USDC", 1n], ["base:sUSDC", 10n ** 18n]]))).toBe("here: USDC@base usdt@base sUSDC@base");
  });

  it("searches the chosen chain by name and symbol, best matches first, in the chain's own order within each", () => {
    expect(shown("usd", "base")).toBe("here: usdt@base USDC@base sUSDC@base");
    expect(shown("wrapped", "base")).toBe("here: cbBTC@base WETH@base");
    expect(shown("ether", "base")).toBe("here: ETH@base WETH@base");
    expect(shown("USDC", "arb")).toBe("here: USDC@arb");
  });

  it("with no match on the chosen chain, shows the matches on other chains; with none anywhere, says so", () => {
    expect(shown("sol", "base")).toBe("elsewhere: SOL@sol USDT@sol");
    expect(shown("dragon", "base")).toBe("elsewhere: BLACKDRAGON@near");
    // The other chains' coins come in the order of a list of every chain: the pinned coins first, then what is held, then by symbol.
    expect(shown("w", "sol")).toBe("elsewhere: WETH@base wNEAR@near cbBTC@base");
    expect(shown("w", "sol", new Map([["near:wNEAR", 1n]]))).toBe("elsewhere: wNEAR@near WETH@base cbBTC@base");
    expect(shown("bitcoin", "sol")).toBe("elsewhere: BTC@btc");
    // A coin on the chosen chain is never repeated under the other chains.
    expect(shown("usdc", "arb")).toBe("here: USDC@arb");
    expect(shown("zzzz", "base")).toBe("none");
  });

  it("a pasted contract: the coin on the chosen chain, or on another chain, or Not supported; never something that looks alike", () => {
    expect(shown(USDC_BASE, "base")).toBe("here: USDC@base");
    expect(shown(USDC_BASE.toUpperCase().replace("0X", "0x"), "base")).toBe("here: USDC@base");
    expect(shown(` ${USDC_ARB} `, "base")).toBe("elsewhere: USDC@arb");
    expect(shown("wrap.near", "base")).toBe("elsewhere: wNEAR@near");
    expect(shown(SOL, "base")).toBe("elsewhere: USDT@sol");
    expect(shown("0x1111111111111111111111111111111111111111", "base")).toBe("unsupported");
    expect(shown("So11111111111111111111111111111111111111112", "sol")).toBe("unsupported");
    expect(shown("nobody.near", "near")).toBe("unsupported");
  });

  it("a pasted contract takes the picker to the coin's own chain", () => {
    expect(contractChain(tokens, USDC_ARB, "base")).toBe("arb");
    expect(contractChain(tokens, ` ${USDC_ARB.toUpperCase().replace("0X", "0x")}\n`, "base")).toBe("arb");
    expect(contractChain(tokens, SOL, "base")).toBe("sol");
    expect(contractChain(tokens, "wrap.near", null)).toBe("near");
    // Already on a chain that has it: nothing moves. Where two chains share the address, the first in the chains' own order.
    expect(contractChain(tokens, USDC_ARB, "arb")).toBeNull();
    expect(contractChain(tokens, SHARED, "op")).toBeNull();
    expect(contractChain(tokens, SHARED, "base")).toBe("arb");
    // Anything that is not the contract of a listed coin moves nothing: a name, a symbol, an address nobody listed, nothing at all.
    for (const text of ["usdc", "USD Coin", "0x1111111111111111111111111111111111111111", USDC_ARB.slice(0, -1), "", "   "]) expect(contractChain(tokens, text, "base"), text).toBeNull();
    // And once there, the list shows the coin.
    expect(shown(USDC_ARB, "arb")).toBe("here: USDC@arb");
  });

  it("searches the chains by name: those that start with what was typed, then any word, then anywhere in the name", () => {
    const chains = [
      { key: "bsc", name: "BNB Chain" },
      { key: "eth", name: "Ethereum" },
      { key: "sol", name: "Solana" },
      { key: "btc", name: "Bitcoin" },
      { key: "base", name: "Base" },
      { key: "bch", name: "Bitcoin Cash" },
      { key: "hood", name: "Robinhood Chain" },
      { key: "adi", name: "ADI Chain" },
    ];
    const found = (query: string) => searchChains(chains, query).map((chain) => chain.name);
    expect(found("")).toEqual(chains.map((chain) => chain.name));
    expect(found("  ")).toEqual(chains.map((chain) => chain.name));
    expect(found("b")).toEqual(["BNB Chain", "Bitcoin", "Base", "Bitcoin Cash", "Robinhood Chain"]);
    expect(found("bit")).toEqual(["Bitcoin", "Bitcoin Cash"]);
    expect(found("SOL")).toEqual(["Solana"]);
    expect(found("chain")).toEqual(["BNB Chain", "Robinhood Chain", "ADI Chain"]);
    expect(found("cash")).toEqual(["Bitcoin Cash"]);
    expect(found("hood")).toEqual(["Robinhood Chain"]);
    // A chain's short code finds it too.
    expect(found("bsc")).toEqual(["BNB Chain"]);
    expect(found("zzz")).toEqual([]);
    // The list it was given is left as it was.
    expect(chains[0]!.key).toBe("bsc");
  });

  it("the arrow keys move within a grid three across, two across, or a list, and stop at its edges", () => {
    // Eleven chains, three across: rows of 0-2, 3-5, 6-8 and a short last row of 9-10.
    expect(gridMove(0, "ArrowRight", 11, 3)).toBe(1);
    expect(gridMove(2, "ArrowRight", 11, 3)).toBe(3);
    expect(gridMove(1, "ArrowLeft", 11, 3)).toBe(0);
    expect(gridMove(0, "ArrowLeft", 11, 3)).toBe(0);
    expect(gridMove(10, "ArrowRight", 11, 3)).toBe(10);
    expect(gridMove(1, "ArrowDown", 11, 3)).toBe(4);
    expect(gridMove(4, "ArrowUp", 11, 3)).toBe(1);
    expect(gridMove(1, "ArrowUp", 11, 3)).toBe(1);
    // Down from above the short last row goes to its last place; down from the last row goes nowhere.
    expect(gridMove(8, "ArrowDown", 11, 3)).toBe(10);
    expect(gridMove(7, "ArrowDown", 11, 3)).toBe(10);
    expect(gridMove(9, "ArrowDown", 11, 3)).toBe(9);
    expect(gridMove(5, "Home", 11, 3)).toBe(0);
    expect(gridMove(5, "End", 11, 3)).toBe(10);
    // Two across, as on a narrow phone.
    expect(gridMove(0, "ArrowDown", 11, 2)).toBe(2);
    expect(gridMove(3, "ArrowUp", 11, 2)).toBe(1);
    // A list is a grid one across: down and up are the next and the one before.
    expect(gridMove(0, "ArrowDown", 5, 1)).toBe(1);
    expect(gridMove(4, "ArrowDown", 5, 1)).toBe(4);
    expect(gridMove(0, "ArrowUp", 5, 1)).toBe(0);
    expect(gridMove(3, "End", 5, 1)).toBe(4);
    // Any other key, and a grid of nothing, move nothing; a place outside the grid is brought inside it.
    expect(gridMove(2, "Enter", 5, 1)).toBe(2);
    expect(gridMove(2, "a", 11, 3)).toBe(2);
    expect(gridMove(0, "ArrowDown", 0, 3)).toBe(0);
    expect(gridMove(99, "ArrowLeft", 5, 1)).toBe(3);
  });

  it("reads which picker a page of the browser's history is, and takes nothing else for one", () => {
    expect(pickerInHistory({ picker: "from" })).toBe("from");
    expect(pickerInHistory({ picker: "to" })).toBe("to");
    for (const state of [null, undefined, "from", 1, {}, { picker: "both" }, { picker: null }, { side: "from" }, ["from"]]) expect(pickerInHistory(state), JSON.stringify(state)).toBeNull();
  });
});

describe("prefill link", () => {
  const tokens = [coin("BNB", "bsc"), USDT_SOL, ETH];
  it("fills coins and amount from the link", () => {
    expect(parsePrefill("?from=bsc:BNB&to=sol:USDT&amount=0.5", tokens)).toEqual({ from: tokens[0], to: USDT_SOL, amount: "0.5" });
    expect(parsePrefill("?from=base:eth", tokens)).toEqual({ from: ETH });
  });
  it("writes the amount back in its plain form, so the field never says something other than what is quoted", () => {
    const tokens = [ETH, USDT_SOL];
    expect(parsePrefill("?from=base:ETH&amount=000000000000000000000000000001", tokens).amount).toBe("1");
    expect(parsePrefill("?from=base:ETH&amount=0.50", tokens).amount).toBe("0.5");
    expect(parsePrefill("?from=base:ETH&amount=1.000000000000000000", tokens).amount).toBe("1");
  });

  it("ignores anything that is not a listed coin or a plain amount, and never takes an address", () => {
    expect(parsePrefill("?from=bsc:FAKE&to=nowhere:USDT&amount=abc", tokens)).toEqual({});
    expect(parsePrefill("?from=<script>&to=javascript:alert(1)&amount=1e9", tokens)).toEqual({});
    expect(parsePrefill(`?from=bsc:BNB&recipient=${EVM}&refundTo=${EVM}&to=bsc:BNB`, tokens)).toEqual({ from: tokens[0] });
    expect(parsePrefill("?amount=-5", tokens)).toEqual({});
    expect(parsePrefill("?from=sol:USDT&amount=0.1234567", tokens)).toEqual({ from: USDT_SOL });
    expect(parsePrefill("", tokens)).toEqual({});
  });

  it("drops the amount when the coin it was an amount of is not on the list", () => {
    // 30 of an unknown coin must not turn into 30 of whichever coin is shown instead.
    expect(parsePrefill("?from=arb:NOPE&to=sol:USDT&amount=30", tokens)).toEqual({ to: USDT_SOL });
    expect(parsePrefill("?from=0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83&amount=30", tokens)).toEqual({});
    // With no coin named, the amount is of the coin already shown.
    expect(parsePrefill("?amount=0.5", tokens)).toEqual({ amount: "0.5" });
  });
});

describe("the primary button", () => {
  const base: ActionInput = {
    paused: false,
    coinsReady: true,
    from: ETH,
    to: USDT_SOL,
    amountText: "0.5",
    pay: "manual",
    walletConnected: false,
    balance: null,
    recipient: SOL,
    refundTo: EVM,
    quote: "ready",
    problem: null,
    impactUnconfirmed: false,
  };
  const label = (change: Partial<ActionInput>) => primaryAction({ ...base, ...change }).label;

  it("names the next step or the blocker, in order", () => {
    expect(label({})).toBe("Review swap");
    expect(label({ paused: true })).toBe("Swaps are paused");
    expect(label({ coinsReady: false })).toBe("Loading coins…");
    expect(label({ amountText: "" })).toBe("Enter an amount");
    expect(label({ amountText: "0" })).toBe("Enter an amount");
    expect(label({ amountText: "abc" })).toBe("Enter a valid amount");
    expect(label({ amountText: "0.0000001", from: USDT_SOL, to: ETH, recipient: EVM, refundTo: SOL })).toBe("At most 6 decimals");
    expect(label({ quote: "loading" })).toBe("Getting a quote…");
    expect(label({ recipient: "" })).toBe("Enter receiving address");
    expect(label({ recipient: EVM })).toBe("Check the receiving address");
    expect(label({ refundTo: "" })).toBe("Enter refund address");
    expect(label({ refundTo: SOL })).toBe("Check the refund address");
    expect(label({ impactUnconfirmed: true })).toBe("Confirm the price impact");
    expect(label({ quote: "expired" })).toBe("Refresh quote");
  });

  it("asks to connect a wallet before anything else in wallet mode, and checks the balance", () => {
    expect(label({ pay: "wallet" })).toBe("Connect wallet");
    // With a wallet the refund address is the wallet's own where that is safe: the card passes it in (see refundFor).
    expect(label({ pay: "wallet", walletConnected: true, refundTo: refundFor("wallet", "", EVM) })).toBe("Review swap");
    // Where the wallet's own address cannot be used, one must be entered: a wallet order has a refund address like any other.
    expect(label({ pay: "wallet", walletConnected: true, refundTo: refundFor("wallet", "", null) })).toBe("Enter refund address");
    expect(label({ pay: "wallet", walletConnected: true, refundTo: SOL })).toBe("Check the refund address");
    expect(label({ pay: "wallet", walletConnected: true, balance: 400000000000000000n })).toBe("Not enough ETH");
    expect(label({ pay: "wallet", walletConnected: true, balance: 500000000000000000n })).toBe("Review swap");
  });

  it("starts a wallet order's refund address from the wallet only where the wallet's address is known to be the person's", () => {
    // Typed always wins, in either way of paying.
    expect(refundFor("wallet", EVM, null)).toBe(EVM);
    expect(refundFor("manual", EVM, "0xother")).toBe(EVM);
    // Nothing typed: the wallet's own, if it may be offered on the paying chain; otherwise nothing.
    expect(refundFor("wallet", "", EVM)).toBe(EVM);
    expect(refundFor("wallet", "  ", EVM)).toBe(EVM);
    expect(refundFor("wallet", "", null)).toBe("");
    // Paying by hand there is no default at all.
    expect(refundFor("manual", "", EVM)).toBe("");
    // The rule behind "may be offered": a contract wallet on Arbitrum, an order paid on Base. Its address is not used.
    const contractOnArb = { address: EVM, chain: "arb", family: "evm", plain: false };
    const unknownOnArb = { address: EVM, chain: "arb", family: "evm", plain: null };
    const plainOnArb = { address: EVM, chain: "arb", family: "evm", plain: true };
    expect(refundFor("wallet", "", walletAddressFor("base", "evm", contractOnArb))).toBe("");
    expect(refundFor("wallet", "", walletAddressFor("base", "evm", unknownOnArb))).toBe("");
    expect(refundFor("wallet", "", walletAddressFor("base", "evm", plainOnArb))).toBe(EVM);
    // On the paying chain itself the wallet's address is its own, whatever kind of wallet it is.
    expect(refundFor("wallet", "", walletAddressFor("arb", "evm", contractOnArb))).toBe(EVM);
  });

  it("shows the refund address field whenever what is in it would be used, and whenever one is needed", () => {
    // Paying by hand: always.
    expect(asksForRefund("manual", false, null, "")).toBe(true);
    expect(asksForRefund("manual", true, EVM, "")).toBe(true);
    // Paying from a wallet whose own address serves: not asked for, while the field is empty.
    expect(asksForRefund("wallet", true, EVM, "")).toBe(false);
    expect(asksForRefund("wallet", true, EVM, "   ")).toBe(false);
    // No wallet yet: the next step is to connect, not to type an address.
    expect(asksForRefund("wallet", false, null, "")).toBe(false);
    // A wallet whose address cannot be used on the paying chain: asked for.
    expect(asksForRefund("wallet", true, null, "")).toBe(true);
    // Something typed is what the order would be made with (refundFor), so it is never in force unseen:
    // half-typed or whole, with or without a wallet, the field stays on the card.
    for (const typed of ["0x12", EVM]) {
      expect(asksForRefund("wallet", true, EVM, typed), typed).toBe(true);
      expect(asksForRefund("wallet", false, null, typed), typed).toBe(true);
      expect(refundFor("wallet", typed, EVM)).toBe(typed);
    }
  });

  it("gives a main button the longest of its labels that fits on one line", () => {
    expect(fitLabel(["Send 0.5 ETH", "Send ETH"], 22)).toBe("Send 0.5 ETH");
    expect(fitLabel(["Send 0.123456789012345678 ETH", "Send ETH"], 22)).toBe("Send ETH");
    // Exactly as long as the room is: it fits.
    expect(fitLabel(["1234567890123456789012", "short"], 22)).toBe("1234567890123456789012");
    // None fits: the last, which is the shortest way of saying it.
    expect(fitLabel(["a very long label indeed", "still too long here"], 5)).toBe("still too long here");
    // A minimum for a coin with a long symbol still fits the card's button.
    const longCoin = coin("BLACKDRAGON", "near", { decimals: 24 });
    const tooLow = (from: TokenView, min: string) => primaryAction({ ...base, from, problem: { code: "amount_too_low", message: "x", detail: { min } } }).label;
    expect(tooLow(ETH, "404700000000000")).toBe("Minimum is 0.0004047 ETH");
    // A nine-letter symbol: "Minimum is 0.0004047 kV-gtSOLb" is one character too long, so the "is" goes.
    expect(tooLow(coin("kV-gtSOLb", "sol", { decimals: 18 }), "404700000000000")).toBe("Minimum 0.0004047 kV-gtSOLb");
    // An eleven-letter symbol: the coin is the one on the card, and the figure alone says what is needed.
    expect(tooLow(longCoin, "1234500000000000000")).toBe("Minimum is 0.000001235");
    // A figure too long for the button by itself (a minimum of a millionth of a millionth of a coin): the plain sentence.
    expect(tooLow(longCoin, "1234500000")).toBe("Too low for this pair");
    for (const min of ["1", "1234500000", "1234500000000000000", "999900000000000000000000000"]) expect(tooLow(longCoin, min).length, min).toBeLessThanOrEqual(29);
  });

  it("shows a quote problem as the label", () => {
    const problem = (code: ActionInput["problem"] & object) => label({ problem: code });
    // The label is kept short enough for one line at 360 px; the pair is the one on screen.
    expect(problem({ code: "min_usd", message: "Minimum for this pair is $1,000 right now.", detail: { usd: "1000" } })).toBe("Minimum is $1,000 right now");
    expect(problem({ code: "min_usd", message: "Minimum for this pair is $100 right now.", detail: { usd: "100" } })).toBe("Minimum is $100 right now");
    // Without a clean figure the server's own sentence is used; nothing from the reply is trusted as markup or as a number.
    expect(problem({ code: "min_usd", message: "Minimum for this pair is $1,000 right now.", detail: { usd: "1e3" } })).toBe("Minimum for this pair is $1,000 right now.");
    expect(problem({ code: "amount_too_low", message: "x", detail: { min: "2725340300683302" } })).toBe("Minimum is 0.002726 ETH");
    expect(problem({ code: "amount_too_low", message: "x", detail: {} })).toBe("Too low for this pair");
    expect(problem({ code: "blocked", message: "x", detail: {} })).toBe("This swap can't be processed");
    expect(problem({ code: "invalid_recipient", message: "x", detail: {} })).toBe("Check the receiving address");
    expect(problem({ code: "no_route", message: "No route for this pair right now.", detail: {} })).toBe("Try again");
    expect(problem({ code: "network", message: "x", detail: {} })).toBe("Try again");
    expect(problem({ code: "try_later", message: "x", detail: {} })).toBe("Try again");
  });

  it("offers this one swap without private routing when a private quote cannot be had: a choice to press, never a switch made for the person", () => {
    const unavailable = { code: "private_unavailable", message: PRIVATE_UNAVAILABLE, detail: {} } as const;
    const action = (change: Partial<ActionInput> = {}) => primaryAction({ ...base, quote: "none", problem: unavailable, ...change });
    // Its own kind: the card acts on the kind, and only this one sets the choice.
    expect(action()).toEqual({ kind: "without-private", label: "Swap without private routing", disabled: false, busy: false });
    // One line of the button at 360 px.
    expect(action().label.length).toBeLessThanOrEqual(CARD_BUTTON_ROOM);
    // It is not "Try again": pressing it must not simply ask for the same private quote.
    expect(action().kind).not.toBe("retry");
    // The choice comes before a wallet or an address: there is nothing to connect or fill in for until there is a quote.
    expect(action({ pay: "wallet" }).kind).toBe("without-private");
    expect(action({ recipient: "", refundTo: "" }).kind).toBe("without-private");
    // What stops every swap still comes first, and so does an amount that cannot be quoted at all.
    expect(action({ paused: true })).toMatchObject({ kind: "blocked", label: "Swaps are paused" });
    expect(action({ amountText: "" })).toMatchObject({ kind: "blocked", label: "Enter an amount" });
    // With the problem gone (a public quote has arrived), the flow is as ever.
    expect(action({ problem: null, quote: "ready" })).toMatchObject({ kind: "review", label: "Review swap" });
    // The sentence the card says above the button, word for word, and it is the one the server answers with.
    expect(PRIVATE_UNAVAILABLE).toBe("Private routing is not available for this swap right now.");
    const server = fs.readdirSync(path.resolve("server")).filter((file) => file.endsWith(".ts")).map((file) => fs.readFileSync(path.resolve("server", file), "utf8")).join("\n");
    expect(server).toContain(`"private_unavailable", "${PRIVATE_UNAVAILABLE}"`);
  });

  it("is never disabled without a reason, and never enabled with nothing to do", () => {
    const cases: Array<Partial<ActionInput>> = [{}, { paused: true }, { amountText: "" }, { quote: "loading" }, { recipient: "" }, { pay: "wallet" }, { quote: "expired" }, { problem: { code: "no_route", message: "m", detail: {} } }, { problem: { code: "private_unavailable", message: "m", detail: {} } }];
    for (const change of cases) {
      const action = primaryAction({ ...base, ...change });
      expect(action.label.length).toBeGreaterThan(3);
      expect(action.disabled).toBe(action.kind === "blocked");
    }
  });
});

describe("value shown beneath the amount before a quote arrives", () => {
  const eth = { decimals: 18, price: "2530.26" };
  it("is the amount at the list price, by whole-number maths", () => {
    expect(estimateUsd("0.5", eth)).toBe("1265.130000");
    expect(estimateUsd("0.000001", eth)).toBe("0.002530");
    expect(estimateUsd("123456789.123456", { decimals: 6, price: "0.9998" })).toBe("123432097.765631");
    expect(estimateUsd("1", { decimals: 8, price: "0.000000113427" })).toBe("0.000000");
  });
  it("is empty when there is nothing to value", () => {
    expect(estimateUsd("", eth)).toBeNull();
    expect(estimateUsd("0", eth)).toBeNull();
    expect(estimateUsd("abc", eth)).toBeNull();
    expect(estimateUsd("1", { decimals: 18, price: null })).toBeNull();
    expect(estimateUsd("1", null)).toBeNull();
  });
});

describe("contract or personal wallet", () => {
  it("treats no code as a wallet and real code as a contract", () => {
    expect(isContractCode("0x")).toBe(false);
    expect(isContractCode("0x6080604052348015600f57600080fd5b50")).toBe(true);
  });
  it("treats a wallet that delegates to a contract (EIP-7702) as a wallet", () => {
    expect(isContractCode(`0xef0100${"ab".repeat(20)}`)).toBe(false);
    // The marker alone, or with anything after the address, is not that form.
    expect(isContractCode("0xef0100")).toBe(true);
    expect(isContractCode(`0xef0100${"ab".repeat(21)}`)).toBe(true);
  });
});

describe("what is read out about a refreshing quote", () => {
  const said = { key: "eth|usdt|5", amountOut: 1_000_000n, at: 0 };
  it("reads out a quote for new inputs at once", () => {
    expect(shouldAnnounce(null, said)).toBe(true);
    expect(shouldAnnounce(said, { key: "eth|usdt|6", amountOut: 1_000_001n, at: 1000 })).toBe(true);
  });
  it("stays quiet on a refresh unless the amount moved by more than 0.5%", () => {
    expect(shouldAnnounce(said, { ...said, amountOut: 1_005_000n, at: 60_000 })).toBe(false);
    expect(shouldAnnounce(said, { ...said, amountOut: 1_005_001n, at: 60_000 })).toBe(true);
    expect(shouldAnnounce(said, { ...said, amountOut: 994_999n, at: 60_000 })).toBe(true);
    expect(shouldAnnounce(said, { ...said, amountOut: 995_000n, at: 60_000 })).toBe(false);
  });
  it("never speaks more than once in 30 seconds, however far the amount moved", () => {
    expect(shouldAnnounce(said, { ...said, amountOut: 2_000_000n, at: 29_999 })).toBe(false);
    expect(shouldAnnounce(said, { ...said, amountOut: 2_000_000n, at: 30_000 })).toBe(true);
  });
});

describe("the review sheet", () => {
  const order = { from: { id: ETH.id }, to: { id: USDT_SOL.id }, amountIn: "500000000000000000", minAmountOut: "1249000000", slippageBps: 100, recipient: SOL, refundTo: EVM } as never;
  const reviewed = { from: ETH.id, to: USDT_SOL.id, amountIn: "500000000000000000", minAmountOut: "1249000000", slippageBps: 100, recipient: SOL, refundTo: EVM };
  // What a quote or an order says of its own routing: the server's words for the two ways.
  const PRIVATELY = routingOf("basic");
  const IN_PUBLIC = routingOf("public");

  it("says in one plain sentence what is sent and what is received", () => {
    expect(reviewSentence(ETH, USDT_SOL, 500000000000000000n, 1261340512n)).toBe("You send 0.5 ETH on Base. You receive about 1,261.34 USDT on Solana.");
    expect(reviewSentence(coin("BNB", "bsc"), USDT_SOL, 500000000000000000n, 371200000n)).toBe("You send 0.5 BNB on BNB Chain. You receive about 371.20 USDT on Solana.");
    // What a screen reader is given never holds a subscript: a very small amount is said in full.
    const wbtc = coin("WBTC", "eth", { decimals: 8 });
    expect(reviewSentence(USDT_SOL, wbtc, 1000n, 12n)).toBe("You send 0.001 USDT on Solana. You receive about 0.0₆12 WBTC on Ethereum.");
    expect(reviewSentence(USDT_SOL, wbtc, 1000n, 12n, { spoken: true })).toBe("You send 0.001 USDT on Solana. You receive about 0.00000012 WBTC on Ethereum.");
    expect(reviewSentence(ETH, USDT_SOL, 500000000000000000n, 1261340512n, { spoken: true })).toBe("You send 0.5 ETH on Base. You receive about 1,261.34 USDT on Solana.");
  });

  it("adds a third short sentence for a privately routed swap, and for no other", () => {
    expect(reviewSentence(ETH, USDT_SOL, 500000000000000000n, 1261340512n, { privately: true })).toBe("You send 0.5 ETH on Base. You receive about 1,261.34 USDT on Solana. Routed privately.");
    expect(reviewSentence(ETH, USDT_SOL, 500000000000000000n, 1261340512n, { privately: true, spoken: true })).toBe("You send 0.5 ETH on Base. You receive about 1,261.34 USDT on Solana. Routed privately.");
    // A public swap reads exactly as it always has: nothing is said of routing.
    expect(reviewSentence(ETH, USDT_SOL, 500000000000000000n, 1261340512n, { privately: false })).toBe(reviewSentence(ETH, USDT_SOL, 500000000000000000n, 1261340512n));
    expect(reviewSentence(ETH, USDT_SOL, 500000000000000000n, 1261340512n)).not.toMatch(/rout/i);
  });

  it("accepts the order only when it is the one that was reviewed", () => {
    expect(orderDiffers(order, reviewed)).toBeNull();
    expect(orderDiffers(order, { ...reviewed, from: "other" })).toBe("the coin you pay");
    expect(orderDiffers(order, { ...reviewed, to: "other" })).toBe("the coin you receive");
    expect(orderDiffers(order, { ...reviewed, amountIn: "500000000000000001" })).toBe("the amount you pay");
    // A limit other than the one reviewed, looser or tighter, even when the minimum still fits.
    expect(orderDiffers({ ...(order as object), slippageBps: 190 } as never, reviewed)).toBe("the slippage limit");
    expect(orderDiffers({ ...(order as object), slippageBps: 50 } as never, reviewed)).toBe("the slippage limit");
    expect(orderDiffers({ ...(order as object), slippageBps: undefined } as never, reviewed)).toBe("the slippage limit");
    expect(orderDiffers(order, { ...reviewed, recipient: EVM })).toBe("the receiving address");
    // Even a change of letter case in an address stops everything: the comparison is exact.
    expect(orderDiffers(order, { ...reviewed, refundTo: EVM.toLowerCase() })).toBe("the refund address");
  });

  it("never accepts an order made by another route than the one on screen", () => {
    const made = (routing: unknown) => ({ ...(order as object), routing }) as never;
    // The same route on both sides.
    expect(orderDiffers(made(PRIVATELY), { ...reviewed, routing: PRIVATELY })).toBeNull();
    expect(orderDiffers(made(IN_PUBLIC), { ...reviewed, routing: IN_PUBLIC })).toBeNull();
    // Reviewed as private, made in public: the one that must never pass unseen.
    expect(orderDiffers(made(IN_PUBLIC), { ...reviewed, routing: PRIVATELY })).toBe("the routing");
    // And the other way about.
    expect(orderDiffers(made(PRIVATELY), { ...reviewed, routing: IN_PUBLIC })).toBe("the routing");
    // An order that names no routing is public (one made before routing was kept): not what a private review asked for.
    expect(orderDiffers(order, { ...reviewed, routing: PRIVATELY })).toBe("the routing");
    expect(orderDiffers(order, { ...reviewed, routing: IN_PUBLIC })).toBeNull();
    // A review that names none saw a public quote: a private order is not that order.
    expect(orderDiffers(made(PRIVATELY), reviewed)).toBe("the routing");
    expect(orderDiffers(made(IN_PUBLIC), reviewed)).toBeNull();
    // Any word but the one for private is public: nothing else can pass for it.
    for (const word of ["basic", "advanced", PRIVATELY.toUpperCase(), `${PRIVATELY} `, "privately", "confidentially", true, 1, null]) expect(orderDiffers(made(word), { ...reviewed, routing: PRIVATELY }), JSON.stringify(word)).toBe("the routing");
    // Everything else is still compared: the same route does not excuse another address.
    expect(orderDiffers(made(PRIVATELY), { ...reviewed, routing: PRIVATELY, recipient: EVM })).toBe("the receiving address");
  });

  it("lets the minimum received be at most 1% under what was reviewed, never more", () => {
    const withMin = (min: string) => orderDiffers({ ...(order as object), minAmountOut: min } as never, { ...reviewed, minAmountOut: "1000000" });
    expect(withMin("1000000")).toBeNull();
    expect(withMin("2000000")).toBeNull();
    expect(withMin("990000")).toBeNull();
    expect(withMin("989999")).toBe("the minimum you receive");
    expect(withMin("not a number")).toBe("the minimum you receive");
  });

  it("names the next step on its one button, or why nothing can happen yet", () => {
    const label = (input: Partial<Parameters<typeof reviewAction>[0]>) => reviewAction({ phase: "review", quote: "ready", termsAccepted: true, ...input });
    expect(label({})).toEqual({ kind: "confirm", label: "Confirm swap", disabled: false, busy: false });
    expect(label({ termsAccepted: false })).toEqual({ kind: "none", label: "Accept the Terms to continue", disabled: true, busy: false });
    expect(label({ phase: "moved" }).label).toBe("Confirm new numbers");
    expect(label({ phase: "creating" })).toEqual({ kind: "none", label: "Creating order…", disabled: true, busy: true });
    // An old quote is never confirmed, Terms ticked or not.
    expect(label({ quote: "expired" })).toEqual({ kind: "refresh", label: "Refresh quote", disabled: false, busy: false });
    expect(label({ quote: "expired", termsAccepted: false }).kind).toBe("refresh");
    expect(label({ quote: "loading" })).toMatchObject({ kind: "none", disabled: true, busy: true });
  });

  it("cannot be confirmed in the second after new numbers arrive, nor above a large price impact without its tick", () => {
    const label = (input: Partial<Parameters<typeof reviewAction>[0]>) => reviewAction({ phase: "review", quote: "ready", termsAccepted: true, ...input });
    expect(label({ settling: true })).toEqual({ kind: "none", label: "Check the new numbers", disabled: true, busy: false });
    expect(label({ impactUnconfirmed: true })).toEqual({ kind: "none", label: "Confirm the price impact", disabled: true, busy: false });
    // Both come before the Terms: the numbers are settled first.
    expect(label({ settling: true, termsAccepted: false }).label).toBe("Check the new numbers");
    expect(label({ phase: "moved", settling: true }).disabled).toBe(true);
  });

  it("offers nothing but a way out once the order that came back was not the one reviewed", () => {
    for (const quote of ["ready", "expired", "loading"] as const) {
      expect(reviewAction({ phase: "mismatch", quote, termsAccepted: true })).toEqual({ kind: "close", label: "Close and start again", disabled: false, busy: false });
    }
  });

  it("offers nothing but to close once the server would not make the order with private routing: the choice is made on the card", () => {
    for (const quote of ["ready", "expired", "loading", "none"] as const) {
      for (const termsAccepted of [true, false]) {
        // Never "Confirm", never "Refresh quote": nothing is asked for again from the sheet, in private or in public.
        expect(reviewAction({ phase: "unavailable", quote, termsAccepted })).toEqual({ kind: "close", label: "Close", disabled: false, busy: false });
      }
    }
    expect(reviewAction({ phase: "unavailable", quote: "ready", termsAccepted: true, settling: true, impactUnconfirmed: true }).kind).toBe("close");
  });

  it("writes the time to pay in words", () => {
    expect(minutesText(payWindowMs("wallet", "base"))).toBe("30 minutes");
    expect(minutesText(payWindowMs("manual", "base"))).toBe("1 hour");
    expect(minutesText(payWindowMs("manual", "btc"))).toBe("2 hours");
    // Hours and minutes together are said as both, not as a large number of minutes.
    expect(minutesText(90 * 60_000)).toBe("1 hour 30 minutes");
    expect(minutesText(61 * 60_000)).toBe("1 hour 1 minute");
    expect(minutesText(60_000)).toBe("1 minute");
  });

  it("gives, as the time to send, two minutes less than the order's deadline", () => {
    // The last two minutes are when the deposit details are no longer shown: nobody is told they are time to send.
    for (const [pay, chain] of [["wallet", "base"], ["manual", "base"], ["manual", "btc"]] as const) expect(payWindowMs(pay, chain) - sendWindowMs(pay, chain)).toBe(DEPOSIT_CLOSE_MS);
    expect(minutesText(sendWindowMs("wallet", "base"))).toBe("28 minutes");
    expect(minutesText(sendWindowMs("manual", "base"))).toBe("58 minutes");
    expect(minutesText(sendWindowMs("manual", "btc"))).toBe("1 hour 58 minutes");
  });
});

describe("orders kept in this browser", () => {
  const order = (id: string) => ({ id, createdAt: "2026-10-08T12:00:00.000Z", from: { ...ETH, id: "x" }, to: { ...USDT_SOL, id: "y" }, amountIn: "5", amountOut: "7" }) as never;
  it("puts the newest first, lists an order once, and keeps only what the list needs", () => {
    let list = withOrder([], order("a"));
    list = withOrder(list, order("b"));
    list = withOrder(list, order("a"));
    expect(list.map((o) => o.id)).toEqual(["a", "b"]);
    expect(list[0]).toEqual({ id: "a", createdAt: "2026-10-08T12:00:00.000Z", from: { symbol: "ETH", chain: "base", decimals: 18 }, to: { symbol: "USDT", chain: "sol", decimals: 6 } });
    // No address of any kind is kept, and no amount: nothing a person typed into the swap card stays in the browser.
    expect(JSON.stringify(list)).not.toMatch(/0x|recipient|refund|deposit|amount/i);
    // A list saved by an earlier version, which held amounts, is read without them.
    const older = JSON.stringify([{ ...list[0], amountIn: "5", amountOut: "7" }]);
    expect(readRecent(older)).toEqual([list[0]]);
    expect(JSON.stringify(readRecent(older))).not.toContain("amount");
  });
  it("keeps the name of the received coin's logo, where it has one, and still no address: not even the coin's contract", () => {
    const brett = { symbol: "BRETT", chain: "base", decimals: 18, contract: "0x532f27101965dd16442e59d40670faf5ebb142e4" };
    const list = withOrder([], { id: "a", createdAt: "2026-10-08T12:00:00.000Z", from: brett, to: brett, amountIn: "5", amountOut: "7" } as never);
    expect(list[0]?.to).toEqual({ symbol: "BRETT", chain: "base", decimals: 18, logo: "brett" });
    expect(list[0]?.from).toEqual({ symbol: "BRETT", chain: "base", decimals: 18 });
    expect(JSON.stringify(list)).not.toMatch(/0x|contract|recipient|refund|deposit/i);
    expect(readRecent(JSON.stringify(list))).toEqual(list);
    // A name that could not be a logo's is not read back, and one that is no logo's draws nothing of its own.
    expect(readRecent(JSON.stringify([{ ...list[0], to: { ...list[0]!.to, logo: "../x" } }]))).toEqual([]);
    expect(logoUrl("brett")).toBe("/coins/brett.webp");
    expect(logoUrl("eth")).toBeNull();
    expect(logoUrl(undefined)).toBeNull();
  });
  it("keeps at most 50", () => {
    let list: ReturnType<typeof withOrder> = [];
    for (let i = 0; i < 60; i++) list = withOrder(list, order(`o${i}`));
    expect(list).toHaveLength(50);
    expect(list[0]?.id).toBe("o59");
  });
  it("ignores anything in storage that is not a list of orders", () => {
    expect(readRecent(null)).toEqual([]);
    expect(readRecent("not json")).toEqual([]);
    expect(readRecent('{"id":"a"}')).toEqual([]);
    const good = withOrder([], order("a"));
    expect(readRecent(JSON.stringify([...good, { id: "<script>" }, { id: "b" }, null, 5]))).toEqual(good);
  });
});

describe("the home page's first words", () => {
  // They are written twice: in the page itself, so that they are on screen before the scripts
  // arrive, and by the component that draws over them. The two must say the same thing.
  // The words are kept in one place (shared/positioning.ts), in two sets: one for
  // a site that routes swaps in public and one for a site that routes them privately. The page as
  // it is written holds the public set, and the component draws whichever set applies from that
  // file. So "the same" is held through that file: the page's words are its public set, word
  // for word, and the component has no words of its own.
  const page = fs.readFileSync(path.resolve("web", "index.html"), "utf8");
  const component = fs.readFileSync(path.resolve("web", "src", "components", "Home.tsx"), "utf8");
  const words = (html: string, className: string) => new RegExp(`<p class(?:Name)?="${className}">([\\s\\S]*?)</p>`).exec(html)?.[1]?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

  it("are the same in the page and in the component that replaces them", () => {
    const publicSet = headlineWords("public");
    // The page: the public set's headline and the one sentence under it.
    expect(words(page, "headline-title")).toBe(publicSet.map((item) => item.text).join(" "));
    expect(words(page, "headline-sub muted")).toBe(HEADLINE_SUB);
    expect(words(page, "headline-title")).toBe("Swap anything. On NEAR Intents.");
    // The same words in the accent colour, too.
    const accented = [...(/<p class="headline-title">([\s\S]*?)<\/p>/.exec(page)?.[1] ?? "").matchAll(/<span class="headline-word headline-accent"[^>]*>([^<]+)<\/span>/g)].map((match) => match[1]);
    expect(accented).toEqual(publicSet.filter((item) => item.accent).map((item) => item.text));
    // The component: both lines drawn from that file, with the public set wherever swaps are not routed privately.
    expect(component).toMatch(/<p className="headline-title">[\s\S]*?\{headlineWords\(privateOn \? "private" : "public"\)\s*\.map\(/);
    expect(component).not.toMatch(/<p className="headline-title">\s*[A-Za-z]/);
    expect(words(component, "headline-sub muted")).toBe("{HEADLINE_SUB}");
    expect(component).toMatch(/import \{[^}]*\bHEADLINE_SUB\b[^}]*\bheadlineWords\b[^}]*\} from "\.\.\/\.\.\/\.\.\/shared\/positioning\.ts";/);
    // No headline is written out in the component itself, in either set.
    for (const mode of ["public", "private"] as const) expect(component, mode).not.toContain(POSITIONING[mode].headline.plain);
  });

  it("are shown on the home page only", () => {
    expect(page).toContain('if (location.pathname === "/") document.documentElement.dataset.first = "home";');
    const css = fs.readFileSync(path.resolve("web", "src", "styles", "shell.css"), "utf8");
    expect(css).toMatch(/\.first-paint \.headline \{\s*display: none;\s*\}/);
    expect(css).toMatch(/:root\[data-first="home"\] \.first-paint \.headline \{\s*display: grid;\s*\}/);
    // The page keeps a place for the server's banner, before the header's place.
    expect(page).toMatch(/<!--banner-->\s*<div class="header"><\/div>/);
  });
});

describe("words the site never uses", () => {
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return files(full);
      return /\.(tsx?|html|css)$/.test(entry.name) ? [full] : [];
    });
  const sources = [...files(path.resolve("web", "src")), ...files(path.resolve("shared")), path.resolve("web", "index.html")];

  it("never claims what the product cannot promise, and never claims a partnership", () => {
    // Checked in everything the browser is sent, comments included.
    // One word is not on the list: the site may say
    // "private", "private swap" and "private routing", and says them only where private routing is in
    // force. "Invisible" and the two phrases are among what is never said.
    const banned = /\b(anonymous|untraceable|mixer|invisible|guaranteed?|earn|yield|apr|partner(ship)?|darkswap)\b|hidden from authorities|can(?:not|'t| not) be traced/i;
    // One word on the list is named in one place, to say what private routing is not: a page of the
    // documentation explains "how it differs from a mixer". There, in those
    // words and in no others, it may stand (as "an investment" is named once in the Terms, to say that
    // points are not one). Anywhere else, and in any other words, it is still never used.
    const docs = path.resolve("web", "src", "pages", "DocsPage.tsx");
    // (The section's own anchor is that word too: it is the section's name in an address, not a claim.)
    const NOT_ONE = /How it differs from a mixer(?:" id="mixer")?|Private routing is not a mixer\./g;
    const hits = sources.flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) => (banned.test(file === docs ? line.replace(NOT_ONE, "") : line) ? [`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim().slice(0, 80)}`] : [])),
    );
    expect(hits).toEqual([]);
    // The exception is that narrow: the same words in another file, or the word in other words, are still caught.
    expect(banned.test("Private routing works like a mixer.".replace(NOT_ONE, ""))).toBe(true);
    expect(banned.test("How it differs from a mixer, and why it is untraceable".replace(NOT_ONE, ""))).toBe(true);
    // The check can fail, and the words now allowed pass it.
    for (const sentence of ["Fully anonymous swaps.", "An untraceable route.", "Works like a mixer.", "Invisible to everyone.", "Guaranteed delivery.", "Hidden from authorities.", "A swap that cannot be traced.", "It can't be traced."]) expect(banned.test(sentence), sentence).toBe(true);
    for (const sentence of ["Private", "Use private routing", "Swap without private routing", "A private swap", PRIVATE_UNAVAILABLE, "IntentSwap takes no fee. The only fee is the provider's 0.20%.", "A privately routed swap adds points the same way.", "Routed privately.", "Public, by your choice"]) expect(banned.test(sentence), sentence).toBe(false);
  });

  it("never states a minimum in dollars in its own words: only the server's answer to a person's own quote can", () => {
    const hits = sources.flatMap((file) =>
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        // Comments may explain the rule; what is shown to people may not announce it.
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .flatMap((line, index) => (/\$\s?1,?000\b(?!,)/.test(line) ? [`${path.relative(process.cwd(), file)}:${index + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});

describe("a quote that is being replaced", () => {
  const state = { quote: { amountOut: "1" } as never, fetchedAt: 0, loading: false, dirty: false };
  it("is 'loading', not 'expired', while its replacement is on the way: nothing may be pressed in between", () => {
    expect(quoteAge(state, 30_000)).toBe("ready");
    expect(quoteAge(state, 61_000)).toBe("expired");
    expect(quoteAge({ ...state, loading: true }, 61_000)).toBe("loading");
    // A routine refresh of a quote that is still good does not block anything.
    expect(quoteAge({ ...state, loading: true }, 30_000)).toBe("ready");
    expect(quoteAge({ ...state, dirty: true }, 1000)).toBe("loading");
    expect(quoteAge({ ...state, quote: null }, 1000)).toBe("none");
  });
});

describe("which failed quotes are asked for again without anyone pressing anything", () => {
  it("only those that trying again can help", () => {
    for (const code of ["network", "try_later", "unavailable", "busy", "no_route", "rate_limited"] as const) expect(retriesItself(code), code).toBe(true);
    // A refusal, a blocked place, a pause, or something wrong with the inputs: never.
    for (const code of ["blocked", "region", "paused", "invalid_recipient", "invalid_refund", "unsupported_address", "min_usd", "amount_too_low", "too_large", "bad_request", "origin"] as const) expect(retriesItself(code), code).toBe(false);
    // "Private routing is not available": the card waits for the person. It is neither asked again nor switched by itself.
    expect(retriesItself("private_unavailable")).toBe(false);
  });
});

describe("refreshing a quote without anyone pressing anything", () => {
  const base = { typing: false, loading: false, hidden: false, sheetOpen: false, hasQuote: true, problem: null, fetchedAt: 0, now: 15_000, refreshMs: 15_000 };
  it("happens 15 seconds after the last answer", () => {
    expect(refreshDue(base)).toBe(true);
    expect(refreshDue({ ...base, now: 14_999 })).toBe(false);
  });
  it("never while typing, while a request is out, with a sheet open, or with the tab hidden", () => {
    for (const pause of ["typing", "loading", "hidden", "sheetOpen"] as const) expect(refreshDue({ ...base, [pause]: true }), pause).toBe(false);
  });
  it("never when there is nothing to refresh", () => {
    expect(refreshDue({ ...base, hasQuote: false })).toBe(false);
  });
  it("tries again by itself after a failure only when that can help", () => {
    const failed = (code: string, extra: object = {}) => refreshDue({ ...base, hasQuote: false, problem: { code, message: "x", detail: {}, ...extra } as never });
    expect(failed("network")).toBe(true);
    expect(failed("no_route")).toBe(true);
    // A refusal is never asked about again without a change of input or a press.
    for (const code of ["blocked", "region", "paused", "invalid_recipient", "min_usd", "amount_too_low"]) expect(failed(code), code).toBe(false);
    // Nor is a private quote that could not be had, however long the card is left open.
    expect(failed("private_unavailable")).toBe(false);
    expect(refreshDue({ ...base, hasQuote: false, now: 3_600_000, problem: { code: "private_unavailable", message: "x", detail: {} } })).toBe(false);
  });
  it("waits as long as the server asked after 'too many requests'", () => {
    const limited = (now: number) => refreshDue({ ...base, hasQuote: false, now, problem: { code: "rate_limited", message: "x", detail: {}, waitMs: 40_000 } });
    expect(limited(15_000)).toBe(false);
    expect(limited(39_999)).toBe(false);
    expect(limited(40_000)).toBe(true);
  });
});

describe("offering the connected wallet's address", () => {
  const WALLET = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
  const on = (chain: string | null, plain: boolean | null) => ({ address: WALLET, chain, family: chain === null ? null : "evm", plain });
  it("always offers it on the chain the wallet is on", () => {
    expect(walletAddressFor("base", "evm", on("base", null))).toBe(WALLET);
    expect(walletAddressFor("base", "evm", on("base", false))).toBe(WALLET);
  });
  it("offers it on another chain only when the wallet is known to be a plain one", () => {
    expect(walletAddressFor("arb", "evm", on("base", true))).toBe(WALLET);
    // A contract wallet's address may be someone else's, or nobody's, on another chain.
    expect(walletAddressFor("arb", "evm", on("base", false))).toBeNull();
    // Not yet checked counts as not known.
    expect(walletAddressFor("arb", "evm", on("base", null))).toBeNull();
  });
  it("never offers it on a chain of another kind, or with no wallet", () => {
    expect(walletAddressFor("sol", "solana", on("base", true))).toBeNull();
    expect(walletAddressFor("base", "evm", { address: null, chain: null, family: null, plain: null })).toBeNull();
    expect(walletAddressFor("base", "evm", on(null, true))).toBeNull();
  });
});

describe("coins that look alike", () => {
  it("finds coins that share a symbol on one chain, whatever the letter-case", () => {
    const list = [coin("USDC", "hypercore", { id: "a" }), coin("usdc", "hypercore", { id: "b" }), coin("USDC", "base", { id: "c" }), coin("ETH", "base", { id: "d" })];
    expect([...lookAlikes(list)].sort()).toEqual(["a", "b"]);
    expect(lookAlikes([ETH, USDT_SOL]).size).toBe(0);
  });
});

describe("the coin list kept in the browser", () => {
  it("is used only where each entry is a well-formed coin", () => {
    expect(isToken(ETH)).toBe(true);
    expect(isToken({ ...ETH, price: null, contract: null })).toBe(true);
    for (const bad of [null, "x", {}, { ...ETH, decimals: 1.5 }, { ...ETH, decimals: 99 }, { ...ETH, price: "1e5" }, { ...ETH, chain: "<b>" }, { ...ETH, symbol: "" }, { ...ETH, symbol: "x".repeat(25) }, { ...ETH, wallet: "yes" }, { ...ETH, name: 5 }]) expect(isToken(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("routes", () => {
  it("match the paths the server serves the app for", () => {
    expect(matchRoute("/")).toEqual({ page: "swap" });
    expect(matchRoute(`/order/${"A".repeat(27)}`)).toEqual({ page: "order", id: "A".repeat(27) });
    expect(matchRoute("/terms")).toEqual({ page: "terms" });
    expect(matchRoute("/privacy")).toEqual({ page: "privacy" });
    expect(matchRoute("/token")).toEqual({ page: "token" });
    expect(matchRoute("/order/")).toEqual({ page: "not-found" });
    expect(matchRoute("/order/a/b")).toEqual({ page: "not-found" });
    expect(matchRoute("/anything-else")).toEqual({ page: "not-found" });
  });
});

describe("bundled icons", () => {
  const files = (dir: string, kind = ".svg") => new Set(fs.readdirSync(path.resolve("web", "public", dir)).filter((f) => f.endsWith(kind)).map((f) => f.slice(0, -kind.length)));
  const publicFile = (url: string) => path.resolve("web", "public", ...url.split("/").filter((part) => part !== ""));
  /** The width and height a WebP says it has, whichever of the format's three kinds it is. Null for anything that is not a WebP. */
  const webpSize = (bytes: Buffer): [number, number] | null => {
    if (pictureType(bytes) !== "image/webp") return null;
    const kind = bytes.toString("latin1", 12, 16);
    if (kind === "VP8X") return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (kind === "VP8L") return [1 + (bytes.readUInt32LE(21) & 0x3fff), 1 + ((bytes.readUInt32LE(21) >> 14) & 0x3fff)];
    if (kind === "VP8 ") return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    return null;
  };

  it("match the files on disk exactly", () => {
    expect([...COIN_ICONS].sort()).toEqual([...files("coins")].sort());
    expect([...CHAIN_ICONS].sort()).toEqual([...files("chains")].sort());
    // The pictures made from logos: each one is named by the list, and each name on the list is a picture.
    expect([...new Set(Object.values(COIN_LOGOS))].sort()).toEqual([...files("coins", ".webp")].sort());
    expect([...CHAIN_LOGOS].sort()).toEqual([...files("chains", ".webp")].sort());
    // Nothing else is in the two folders, and no name is both a drawing and a picture.
    for (const dir of ["coins", "chains"]) expect(fs.readdirSync(path.resolve("web", "public", dir)).filter((f) => !/^[a-z0-9]+\.(svg|webp)$/.test(f)), dir).toEqual([]);
    expect([...files("coins", ".webp")].filter((name) => COIN_ICONS.has(name))).toEqual([]);
    expect([...files("chains", ".webp")].filter((name) => CHAIN_ICONS.has(name))).toEqual([]);
  });

  it("the pictures made from logos are real pictures of one size, each with its source kept beside the code", () => {
    for (const dir of ["coins", "chains"]) {
      const names = [...files(dir, ".webp")];
      expect(names.length, dir).toBeGreaterThan(0);
      for (const name of names) {
        const made = fs.readFileSync(path.resolve("web", "public", dir, `${name}.webp`));
        expect(webpSize(made), `${dir}/${name}`).toEqual([ICON_SIDE, ICON_SIDE]);
        expect(made.length, `${dir}/${name}`).toBeLessThanOrEqual(12 * 1024);
        // No colour profile, and nothing but the picture: a WebP holds no script.
        expect(made.includes("ICCP"), `${dir}/${name}`).toBe(false);
        const source = fs.readdirSync(path.resolve("web", "src", "assets", dir)).filter((f) => f.replace(/\.[^.]+$/, "") === name);
        expect(source, `${dir}/${name}`).toHaveLength(1);
        const bytes = fs.readFileSync(path.resolve("web", "src", "assets", dir, source[0]!));
        expect(pictureType(bytes), `${dir}/${source[0]}`).not.toBeNull();
        expect(bytes.length, `${dir}/${source[0]}`).toBeLessThanOrEqual(2 * 1024 * 1024);
      }
      // And no source is left without its picture.
      expect(fs.readdirSync(path.resolve("web", "src", "assets", dir)).map((f) => f.replace(/\.[^.]+$/, "")).sort(), dir).toEqual(names.sort());
    }
    // What is not a picture is told by its first bytes, whatever it is called.
    expect(pictureType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"))).toBeNull();
    expect(pictureType(Buffer.from("#!/bin/sh\n"))).toBeNull();
    expect(pictureType(Buffer.alloc(0))).toBeNull();
  });

  it("every coin that may be paid from a wallet has a logo that is a real picture, or is listed as having none in the collection", () => {
    const without: string[] = [];
    for (const allowed of ALLOWLIST) {
      const where = `${allowed.symbol} on ${allowed.chain}`;
      const url = coinIconUrl(allowed.symbol, allowed.chain, allowed.contractAddress);
      if (url === null) {
        without.push(where);
        expect(coinKey(allowed.chain, allowed.contractAddress) in NO_LOGO, `${where} has no logo, and nobody has said why`).toBe(true);
        continue;
      }
      const bytes = fs.readFileSync(publicFile(url));
      if (url.endsWith(".webp")) expect(webpSize(bytes), where).toEqual([ICON_SIDE, ICON_SIDE]);
      else expect(bytes.toString("utf8").trim().startsWith("<svg") && bytes.toString("utf8").trim().endsWith("</svg>"), where).toBe(true);
      expect(coinKey(allowed.chain, allowed.contractAddress) in NO_LOGO, `${where} has a logo and is listed as having none`).toBe(false);
    }
    // Today that is one coin, on its two chains. A new entry on the allowlist without a logo fails above until someone has looked.
    expect(without).toEqual(["cbBTC on eth", "cbBTC on base"]);
    // The check a person runs against a live list says the same of these coins, and names a coin it has never met.
    const listed = ALLOWLIST.map((allowed) => ({ id: allowed.assetId, symbol: allowed.symbol, chain: allowed.chain, contract: allowed.contractAddress }));
    expect(logoProblems(listed, path.resolve("web", "public"))).toEqual([]);
    const stranger = { id: "nep141:base-0x00000000000000000000000000000000000000aa.omft.near", symbol: "NEWCOIN", chain: "base", contract: "0x00000000000000000000000000000000000000aa" };
    expect(logoProblems([...listed, stranger], path.resolve("web", "public"))).toEqual([expect.stringMatching(/^NEWCOIN on base \(0x0{38}aa, .*\): has no logo /)]);
    expect(logoProblems([{ ...stranger, chain: "newchain" }], path.resolve("web", "public"))).toEqual([expect.stringContaining("NEWCOIN on newchain"), expect.stringMatching(/^the chain newchain: has no mark /)]);
    // An entry that is no longer true fails too: a coin with a logo is not left on the list of those without.
    for (const key of Object.keys(NO_LOGO)) expect(COIN_LOGOS[key], key).toBeUndefined();
    for (const chain of NO_CHAIN_LOGO) expect(chainIconUrl(chain), chain).toBeNull();
  });

  it("a logo belongs to one coin by its chain and contract: another coin with the same symbol is not given it", () => {
    const TRUMP = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
    expect(coinIconUrl("TRUMP", "sol", TRUMP)).toBe("/coins/trump.webp");
    // A look-alike: the same symbol on the same chain, under another contract. And the same symbol on another chain.
    expect(coinIconUrl("TRUMP", "sol", "7p7xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN")).toBeNull();
    expect(coinIconUrl("TRUMP", "eth", "0x576e2bed8f7b46d34016198911cdf9886f78bea7")).toBeNull();
    expect(coinIconUrl("TRUMP", "sol", null)).toBeNull();
    // With no contract given at all, nothing is known of the coin but its symbol: no logo is named by that.
    expect(coinIconUrl("TRUMP")).toBeNull();
    expect(coinIconUrl("TRUMP", "sol")).toBeNull();
    // A symbol dressed as another coin's does not borrow its logo either.
    expect(coinIconUrl("BRETT", "base", "0x00000000000000000000000000000000000000aa")).toBeNull();
    expect(coinIconUrl("BRETT", "base", "0x532F27101965DD16442E59D40670FAF5EBB142E4")).toBe("/coins/brett.webp");
    // An address that is not hexadecimal is the address only as it is written.
    expect(coinIconUrl("TRUMP", "sol", TRUMP.toLowerCase())).toBeNull();
    expect(coinKey("base", "0xABCDEF")).toBe("base:0xabcdef");
    expect(coinKey("sol", TRUMP)).toBe(`sol:${TRUMP}`);
    expect(coinKey("btc", null)).toBe("btc:");
    // The same asset on several chains is listed for each of them, by each one's own contract.
    expect(coinIconUrl("USD1", "eth", "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d")).toBe("/coins/usd1.webp");
    expect(coinIconUrl("USD1", "sol", "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB")).toBe("/coins/usd1.webp");
    expect(coinLogoName("sol", TRUMP)).toBe("trump");
    expect(coinLogoName("sol", null)).toBeUndefined();
    // Every name on the list is a chain and a contract, in the spelling the lookup uses.
    for (const key of Object.keys(COIN_LOGOS)) {
      const [chain, contract = ""] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      expect(key, key).toBe(coinKey(chain, contract === "" ? null : contract));
      expect(/^[a-z0-9]{2,20}$/.test(chain), key).toBe(true);
    }
  });

  it("a coin with no logo is drawn as the one plain drawing, and a chain with none the same in its badge: never as letters", () => {
    const strip = (html: string) => html.replace(/<[^>]*>/g, "");
    for (const size of [32, 24] as const) {
      const none = renderToStaticMarkup(createElement(CoinIcon, { symbol: "BLACKDRAGON", chain: "qtc", contract: "blackdragon.tkn.near", size }));
      expect(strip(none), `${size}`).toBe("");
      expect(none.match(/<svg class="no-artwork"/g), `${size}`).toHaveLength(2);
      expect(none, `${size}`).not.toContain("<img");
      expect(none, `${size}`).toContain(`<span class="coin-icon" data-size="${size}" aria-hidden="true"><span class="coin-icon-fallback"><svg class="no-artwork"`);
      expect(none, `${size}`).toContain('<span class="coin-icon-badge"><span class="coin-icon-badge-fallback"><svg class="no-artwork"');
      // The same drawing for every such coin: nothing of the coin's own name is in it.
      expect(renderToStaticMarkup(createElement(CoinIcon, { symbol: "SHITZU", chain: "qtc", contract: "token.0xshitzu.near", size }))).toBe(none);
      // A coin with a logo keeps the same place and size, so nothing moves when its picture arrives.
      const drawn = renderToStaticMarkup(createElement(CoinIcon, { symbol: "BRETT", chain: "base", contract: "0x532f27101965dd16442e59d40670faf5ebb142e4", size }));
      expect(drawn, `${size}`).toContain(`<img class="coin-icon-image" src="/coins/brett.webp" alt="" width="${size}" height="${size}" decoding="async" loading="lazy"/>`);
      expect(drawn, `${size}`).toContain('src="/chains/base.svg"');
      expect(strip(drawn), `${size}`).toBe("");
    }
    // Nothing is left that could write a coin's or a chain's first letters.
    expect(Object.keys(icons)).not.toContain("initials");
    for (const file of [path.join("components", "CoinIcon.tsx"), path.join("components", "CoinPicker.tsx"), path.join("components", "Home.tsx"), path.join("lib", "icons.ts")]) {
      expect(fs.readFileSync(path.resolve("web", "src", file), "utf8"), file).not.toMatch(/initials|\.slice\(0, [12]\)\.toUpperCase/);
    }
    for (const sheet of ["card.css", "picker.css", "tokens.css"]) expect(fs.readFileSync(path.resolve("web", "src", "styles", sheet), "utf8"), sheet).not.toMatch(/letters-small|chain-mark-letters/);
  });

  it("are plain drawings: only known drawing elements and attributes, nothing that runs, loads or links", () => {
    // An allow-list: anything not named here fails, whatever it is.
    const ELEMENTS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polygon", "polyline", "defs", "clipPath", "mask", "linearGradient", "radialGradient", "stop", "title"]);
    const ATTRIBUTES = new Set([
      "xmlns", "width", "height", "viewBox", "fill", "fill-rule", "clip-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke-dasharray",
      "opacity", "d", "id", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "x2", "y1", "y2", "points", "transform", "clip-path", "mask", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "maskUnits", "fx", "fy",
    ]);
    for (const dir of ["coins", "chains"]) {
      for (const name of files(dir)) {
        const svg = fs.readFileSync(path.resolve("web", "public", dir, `${name}.svg`), "utf8").trim();
        const where = `${dir}/${name}`;
        expect(svg.startsWith("<svg"), where).toBe(true);
        expect(/<!|<\?/.test(svg), `${where}: a declaration, comment or instruction`).toBe(false);
        for (const tag of svg.matchAll(/<\/?([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g)) {
          expect(ELEMENTS.has(tag[1] ?? ""), `${where}: element <${tag[1]}>`).toBe(true);
          for (const attribute of (tag[2] ?? "").matchAll(/\s+([\w:-]+)="([^"]*)"/g)) {
            expect(ATTRIBUTES.has(attribute[1] ?? ""), `${where}: attribute ${attribute[1]}`).toBe(true);
            // A value may point at something inside the same drawing, and nowhere else.
            const value = attribute[2] ?? "";
            if (/url\(/i.test(value)) expect(/^url\(#[\w-]+\)$/.test(value), `${where}: ${attribute[1]}="${value}"`).toBe(true);
            expect(/javascript:|data:|https?:/i.test(value) && attribute[1] !== "xmlns", `${where}: ${attribute[1]}="${value.slice(0, 40)}"`).toBe(false);
          }
        }
        // Every "<" belongs to a tag the pattern above understood: nothing was skipped over.
        const understood = [...svg.matchAll(/<\/?([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g)].length;
        expect((svg.match(/</g) ?? []).length, `${where}: something that is not a plain tag`).toBe(understood);
      }
    }
  });

  it("name NEAR's own mark for the NEAR coin and the NEAR chain alone, and nothing for a coin they do not know", () => {
    // The chain, its own coin, that coin wrapped on its own chain, and the one issued on BNB Chain.
    expect(chainIconUrl("near")).toBe("/chains/near.webp");
    expect(coinIconUrl("NEAR", "near", null)).toBe("/coins/near.webp");
    expect(coinIconUrl("wNEAR", "near", "wrap.near")).toBe("/coins/near.webp");
    expect(coinIconUrl("NEAR", "bsc", "0x1fa4a73a3f0133f0025378af00236f3abdee5d63")).toBe("/coins/near.webp");
    expect(Object.entries(COIN_LOGOS).filter(([, name]) => name === "near").map(([key]) => key).sort()).toEqual(["bsc:0x1fa4a73a3f0133f0025378af00236f3abdee5d63", "near:", "near:wrap.near"]);
    // Not by its symbol: a coin that calls itself NEAR, or is on NEAR, is not given the mark for that.
    expect(coinIconUrl("NEAR")).toBeNull();
    expect(coinIconUrl("wNEAR")).toBeNull();
    expect(coinIconUrl("NEAR", "eth", "0x00000000000000000000000000000000000000aa")).toBeNull();
    expect(coinIconUrl("stNEAR", "near", "meta-pool.near")).toBeNull();
    expect(coinIconUrl("BLACKDRAGON", "near", "blackdragon.tkn.near")).toBeNull();
    // The mark is two files and no more: no drawing of it, no other picture named for it.
    for (const dir of ["coins", "chains", "brand"]) expect(fs.readdirSync(path.resolve("web", "public", dir)).filter((f) => /near/i.test(f)), dir).toEqual(dir === "brand" ? [] : ["near.webp"]);
    expect(fs.readdirSync(path.resolve("web", "public")).filter((f) => /near/i.test(f))).toEqual([]);
    // The page's own parts that carry a brand (the header, the footer, the first screen, the share picture) name neither file.
    for (const file of [path.join("web", "index.html"), path.join("shared", "brand.ts"), ...["Shell.tsx", "Brand.tsx", "Home.tsx", "Stage.tsx", "Social.tsx"].map((name) => path.join("web", "src", "components", name))]) {
      expect(fs.readFileSync(path.resolve(file), "utf8"), file).not.toMatch(/(coins|chains)\/near|near\.(webp|svg|png)/i);
    }
    expect(coinIconUrl("ETH")).toBe("/coins/eth.svg");
    expect(coinIconUrl("ETH", "base", null)).toBe("/coins/eth.svg");
    expect(coinIconUrl("$WIF")).toBeNull();
    expect(chainIconUrl("bsc")).toBe("/chains/bsc.svg");
    expect(chainIconUrl("qtc")).toBeNull();
  });
});

describe("the slippage limit someone chooses", () => {
  it("reads a percentage as whole basis points, with a point or a comma", () => {
    const cases: [string, number | null][] = [["1", 100], ["0.5", 50], ["0,5", 50], ["2.25", 225], [" 1.0 ", 100], ["0.10", 10], ["5", 500], ["12.34", 1234], ["0.1", 10], ["", null], ["abc", null], ["1.234", null], ["-1", null], ["1e2", null], ["1..2", null], [".5", null], ["100", null], ["1%", null]];
    for (const [text, bps] of cases) expect(percentToBps(text), JSON.stringify(text)).toBe(bps);
  });

  it("offers half a percent, one and two as ready choices, all within the bounds the server allows", () => {
    expect([...SLIPPAGE_CHOICES]).toEqual([50, 100, 200]);
    for (const bps of SLIPPAGE_CHOICES) expect(slippageAdvice(bps)).toEqual({ usable: true, note: null, tone: "plain" });
  });

  it("cannot be used outside 0.10% to 5.00%, and says what a low or a high limit means", () => {
    for (const bps of [null, 0, 9, 501, 5000]) expect(slippageAdvice(bps), String(bps)).toEqual({ usable: false, note: "Choose a limit between 0.10% and 5.00%.", tone: "attention" });
    // The sentence is made from the bounds themselves, and agrees with how every other percentage is written.
    expect(SLIPPAGE_BOUNDS_WORDS).toBe(`between ${displayBps(SLIPPAGE.min)} and ${displayBps(SLIPPAGE.max)}`);
    expect(slippageAdvice(10)).toMatchObject({ usable: true, tone: "plain" });
    expect(slippageAdvice(49).note).toContain("more swaps are refunded");
    expect(slippageAdvice(201)).toMatchObject({ usable: true, tone: "attention" });
    expect(slippageAdvice(500).note).toContain("you may receive noticeably less");
  });
});

describe("reading what a wallet holds", () => {
  const OWNER = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";

  it("asks the chain for its own coin directly, and a token through its contract's balanceOf, and nothing else", () => {
    const calls = balanceCalls([{ contract: null }, { contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }], OWNER);
    expect(calls).toEqual([
      { method: "eth_getBalance", params: [OWNER, "latest"] },
      { method: "eth_call", params: [{ to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", data: `0x70a08231${"0".repeat(24)}b5590d9fe0d0902ebe80d5191dcea6fc4d35ec83` }, "latest"] },
    ]);
    // Reads only: nothing here can move or approve anything.
    for (const call of calls) expect(["eth_getBalance", "eth_call"]).toContain(call.method);
  });

  it("takes a balance only from a well-formed answer: anything else is no balance, never zero", () => {
    expect(readBalance("0x0")).toBe(0n);
    expect(readBalance("0x4563918244f40000")).toBe(5n * 10n ** 18n);
    expect(readBalance(`0x${(1000n * 10n ** 6n).toString(16).padStart(64, "0")}`)).toBe(1_000_000_000n);
    for (const bad of [undefined, null, "", "0x", "12", "0xzz", 5, {}, `0x${"f".repeat(65)}`]) expect(readBalance(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("when a quote may say how many points the swap adds", () => {
  const ordinary = { connected: true, address: EVM, chain: "base", family: "evm", plain: true };

  it("paying from an ordinary wallet, or before any wallet is connected: yes, the points go to the wallet's address", () => {
    expect(pointsByDefault("wallet", "bsc", ordinary)).toBe(true);
    expect(pointsByDefault("wallet", "bsc", { ...ordinary, chain: "bsc", plain: null })).toBe(true);
    expect(pointsByDefault("wallet", "bsc", { connected: false, address: null, chain: null, family: null, plain: null })).toBe(true);
  });

  it("sending it yourself: no, a swap adds points only if an address for them is given in the review", () => {
    expect(pointsByDefault("manual", "bsc", ordinary)).toBe(false);
    expect(pointsByDefault("manual", "bsc", { connected: false, address: null, chain: null, family: null, plain: null })).toBe(false);
  });

  it("paying from a contract wallet on another chain, or one not yet known to be ordinary: no, its address there may be someone else's", () => {
    expect(pointsByDefault("wallet", "bsc", { ...ordinary, plain: false })).toBe(false);
    expect(pointsByDefault("wallet", "bsc", { ...ordinary, plain: null })).toBe(false);
    expect(pointsByDefault("wallet", "bsc", { ...ordinary, chain: "sol", family: "solana" })).toBe(false);
  });
});

describe("private routing: what is shown, and when", () => {
  // What a quote or an order says of its own routing: the server's words for the two ways.
  const PRIVATELY = routingOf("basic");
  const IN_PUBLIC = routingOf("public");
  const fees = { appBps: 20, providerBps: 20, appAmount: "1000000000000000", providerAmount: "1000000000000000" };
  const noAppFee = { ...fees, appBps: 0, appAmount: "0" };
  const view = (routing: QuoteView["routing"] | undefined, quoteFees = fees) => ({ fees: quoteFees, ...(routing !== undefined ? { routing } : {}) });

  it("reads a quote or an order as private only by the one word for it; one that names no routing is public", () => {
    expect(routedPrivately({ routing: PRIVATELY })).toBe(true);
    expect(routedPrivately({ routing: IN_PUBLIC })).toBe(false);
    // An order made before routing was kept has no such field.
    expect(routedPrivately({})).toBe(false);
    expect(routedPrivately(null)).toBe(false);
    // Whatever the word for private is, it is that word exactly: not the provider's name for the level, not another spelling, not a yes.
    for (const other of ["basic", "advanced", PRIVATELY.toUpperCase(), `${PRIVATELY} `, "privately", "confidentially", "", true, 1, null, undefined, {}]) expect(routedPrivately({ routing: other }), JSON.stringify(other)).toBe(false);
    expect(PRIVATELY).not.toBe(IN_PUBLIC);
  });

  it("the row above the card's fields: the tag where private routing is in force, the way back after choosing public, and nothing where the server routes in public", () => {
    expect(cardRouting("basic", false)).toBe("private");
    expect(cardRouting("basic", true)).toBe("public-by-choice");
    // The server routes in public, or has not said yet: the row's left end is empty, whatever is held.
    expect(cardRouting("public", false)).toBeNull();
    expect(cardRouting("public", true)).toBeNull();
    expect(cardRouting(null, false)).toBeNull();
    expect(cardRouting(null, true)).toBeNull();
  });

  it("the routing row and the tag, in each case: public mode, private, public by choice, and an old order with no field", () => {
    // The server routes in public: nothing is said of a public quote or order. No row, no tag, no new words.
    expect(routingNote("public", view(IN_PUBLIC))).toBeNull();
    expect(routingNote("public", view(IN_PUBLIC), true)).toBeNull();
    expect(routingNote("public", view(undefined))).toBeNull();
    expect(routingNote(null, view(IN_PUBLIC))).toBeNull();
    expect(routingNote(null, view(undefined))).toBeNull();
    // The server routes privately, and so is this one: the word and the tag.
    expect(routingNote("basic", view(PRIVATELY))).toEqual({ private: true, text: "Private" });
    // Public by the person's own choice, on the card and in the review.
    expect(routingNote("basic", view(IN_PUBLIC), true)).toEqual({ private: false, text: "Public, by your choice" });
    // A public order's page does not know whose choice it was: it says only what the order is.
    expect(routingNote("basic", view(IN_PUBLIC))).toEqual({ private: false, text: "Public" });
    // An order from before routing was kept is public.
    expect(routingNote("basic", view(undefined))).toEqual({ private: false, text: "Public" });
    // An order that was itself made private still says so after the server has gone back to public routing.
    expect(routingNote("public", view(PRIVATELY))).toEqual({ private: true, text: "Private" });
    expect(routingNote(null, view(PRIVATELY))).toEqual({ private: true, text: "Private" });
    // "By your choice" is never said of a private one.
    expect(routingNote("basic", view(PRIVATELY), true)).toEqual({ private: true, text: "Private" });
    // No quote, nothing to say.
    expect(routingNote("basic", null)).toBeNull();
  });

  it("a request says one thing about routing, and only when it was chosen and the server routes privately", () => {
    expect(routingChoice("basic", true)).toEqual({ withoutPrivate: true });
    expect(routingChoice("basic", false)).toEqual({});
    expect(routingChoice("public", true)).toEqual({});
    expect(routingChoice("public", false)).toEqual({});
    expect(routingChoice(null, true)).toEqual({});
    // Never `withoutPrivate: false`, and never any other key.
    for (const mode of ["basic", "public", null] as const) for (const chosen of [true, false]) expect(Object.keys(routingChoice(mode, chosen)).filter((key) => key !== "withoutPrivate")).toEqual([]);
  });

  it("takes the server's newest word on how it routes from its answers about quotes, and only where an answer really tells", () => {
    // A private quote, and "private routing is not available", come only from a server that routes privately.
    expect(modeTold({}, view(PRIVATELY))).toBe("basic");
    expect(modeTold({ withoutPrivate: true }, view(PRIVATELY))).toBe("basic");
    expect(modeTold({}, "private_unavailable")).toBe("basic");
    // A public quote that was not asked for as one comes only from a server that routes in public.
    expect(modeTold({}, view(IN_PUBLIC))).toBe("public");
    expect(modeTold({ withoutPrivate: false }, view(IN_PUBLIC))).toBe("public");
    // One that was asked for as one tells nothing: either kind of server answers it so.
    expect(modeTold({ withoutPrivate: true }, view(IN_PUBLIC))).toBeNull();
    // A quote that names no routing, or names it in a word the page does not know, tells nothing.
    expect(modeTold({}, view(undefined))).toBeNull();
    expect(modeTold({}, { routing: "advanced" })).toBeNull();
  });

  it("the IntentSwap fee row says None for a fee of nothing, as every swap has unless the server is set to take one, and gives a fee in figures", () => {
    // No fee of IntentSwap's: the row says so in a word, in place of "0.00% · 0 ETH", however the swap is routed.
    for (const routing of [PRIVATELY, IN_PUBLIC, undefined]) expect(appFeeWords(view(routing, noAppFee)), String(routing)).toBe("None");
    // Where the server is set to take a fee, the figures its echo held are what is shown.
    expect(appFeeWords(view(PRIVATELY))).toBeNull();
    expect(appFeeWords(view(IN_PUBLIC))).toBeNull();
    expect(appFeeWords(view(undefined))).toBeNull();
    // Only a fee of nothing in both figures is said so: a real fee is never hidden behind the word.
    expect(appFeeWords(view(PRIVATELY, { ...noAppFee, appAmount: "1" }))).toBeNull();
    expect(appFeeWords(view(PRIVATELY, { ...noAppFee, appBps: 1 }))).toBeNull();
    expect(appFeeWords(null)).toBeNull();
  });

  it("points do not turn on a fee or on routing: a swap with no IntentSwap fee is shown its points like any other", () => {
    expect(feeFree(view(PRIVATELY))).toBe(false);
    expect(feeFree(view(IN_PUBLIC))).toBe(false);
    expect(feeFree(view(PRIVATELY, noAppFee))).toBe(true);
    expect(feeFree(null)).toBe(false);
    // The points a quote shows come from the dollar value of what is paid, ten to the dollar, and from nothing else.
    expect(swapPointsMicro("1265.13")).toBe(12_651_300_000n);
    // The page takes them from that value alone. Nothing that draws a quote, a review or an order asks whether there is a fee before it speaks of points.
    const read = (file: string) => fs.readFileSync(path.resolve("web", "src", file), "utf8");
    expect(read("components/QuotePanel.tsx")).toContain("const points = ready && pointsShown ? swapPointsMicro(quote.amountInUsd) : null;");
    for (const file of ["components/QuotePanel.tsx", "components/ReviewSheet.tsx", "pages/OrderPage.tsx"]) expect(read(file), file).not.toMatch(/feeFree|noPoints|adds no points: IntentSwap/);
    expect(read("lib/swap-logic.ts")).not.toMatch(/NO_FEE_NO_POINTS|adds no points: IntentSwap/);
  });

  it("tells a screen reader that a new quote is privately routed, in two words, or says nothing of routing", () => {
    expect(quoteAnnouncement(USDT_SOL, 1261340512n, false)).toBe("You receive about 1261.340512 USDT on Solana.");
    expect(quoteAnnouncement(USDT_SOL, 1261340512n, true)).toBe("You receive about 1261.340512 USDT on Solana, privately routed.");
    // The exact figure, never the subscript form of a very small amount.
    expect(quoteAnnouncement(coin("WBTC", "eth", { decimals: 8 }), 12n, true)).toBe("You receive about 0.00000012 WBTC on Ethereum, privately routed.");
  });

  it("where the server routes in public, the card, the quote, the review and an order's page are given nothing to show", () => {
    // Every rule that decides whether something new is drawn, asked with what the page holds in public mode.
    const quote = view(IN_PUBLIC);
    for (const mode of ["public", null] as const) {
      expect(cardRouting(mode, false)).toBeNull();
      expect(routingNote(mode, quote, false)).toBeNull();
      expect(routingChoice(mode, false)).toEqual({});
    }
    expect(routedPrivately(quote)).toBe(false);
    expect(appFeeWords(quote)).toBeNull();
    expect(feeFree(quote)).toBe(false);
    // And the components draw the new parts only from those rules.
    const read = (file: string) => fs.readFileSync(path.resolve("web", "src", file), "utf8");
    const card = read("components/SwapCard.tsx");
    // The card itself carries no tag: the quote's rows and the review say how a swap is routed.
    expect(card).not.toContain("routing-tag");
    expect(card).toMatch(/routing === "public-by-choice" \? \(\s*<button type="button" className="routing-switch card-routing" onClick=\{\(\) => swap\.setWithoutPrivate\(false\)\}>\s*Use private routing\s*<\/button>\s*\) : null\}/);
    expect(card).toContain("const routing = cardRouting(privacyMode, swap.withoutPrivate);");
    // The one press that sets the choice is the button of its own kind. Nothing else on the card, and no effect, sets it.
    expect(card.match(/setWithoutPrivate\(true\)/g)).toHaveLength(1);
    expect(card).toContain('else if (action.kind === "without-private") swap.setWithoutPrivate(true);');
    for (const file of ["components/QuotePanel.tsx", "components/ReviewSheet.tsx", "pages/OrderPage.tsx", "stores/swap.ts"]) expect(read(file), file).not.toMatch(/setWithoutPrivate\(true\)/);
    expect(read("components/QuotePanel.tsx")).toMatch(/\{routing !== null \? \(\s*<Row label="Routing" name="routing">/);
    expect(read("components/ReviewSheet.tsx")).toMatch(/\{routing !== null \? \(\s*<Row label="Routing" name="routing">/);
    expect(read("pages/OrderPage.tsx")).toMatch(/\{routing !== null \? \(\s*<div className="review-row" data-row="routing">/);
  });
});
