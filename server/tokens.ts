// The coin list. Fetched from the provider, validated, checked against our
// allowlist and against the chain, cached for 60 seconds, and trimmed for the
// interface. When a refresh fails validation the last good list is served for
// up to 24 hours.

import fs from "node:fs";
import path from "node:path";
import { priceToScaled } from "../shared/amounts.ts";
import type { TokenView } from "../shared/api.ts";
import { WALLET_CHAINS, type WalletChain } from "../shared/chains.ts";
import type { Alerts } from "./alerts.ts";
import { ALLOWLIST, ALLOWLIST_BY_ID, COIN_NAMES, type AllowedCoin } from "./allowlist.ts";
import type { Logger } from "./log.ts";
import type { OneClick } from "./oneclick.ts";
import { hexToBigInt, SELECTOR_DECIMALS, type Rpc } from "./rpc.ts";

export interface Token {
  id: string;
  symbol: string;
  name: string;
  chain: string;
  decimals: number;
  /** USD price scaled by 10^18. Only for estimates and limits. */
  priceScaled: bigint;
  /** Plain decimal string of the same price. */
  price: string;
  contract: string | null;
  /** True when the coin passed every allowlist check and can be paid from a wallet. */
  wallet: boolean;
}

export interface TokenSnapshot {
  tokens: Token[];
  byId: ReadonlyMap<string, Token>;
  updatedAt: number;
  views: TokenView[];
}

export interface TokenService {
  /** Current list, refreshed when older than 60 seconds. Null when there is no usable list. */
  snapshot(): Promise<TokenSnapshot | null>;
  refresh(): Promise<void>;
}

const TTL_MS = 60_000;
const LAST_GOOD_MS = 24 * 3_600_000;
const ONCHAIN_VALID_MS = 24 * 3_600_000;

const ASSET_ID = /^[A-Za-z0-9:._-]{3,160}$/;
const CHAIN_KEY = /^[a-z0-9]{2,20}$/;
const SYMBOL = /^[A-Za-z0-9$()._-]{1,24}$/;
const CONTRACT = /^[A-Za-z0-9:._-]{1,160}$/;

/**
 * Asset IDs the provider accepts but answers under another listed ID (seen on
 * 8 Oct 2026 for Bitcoin). Offering both would show the same coin twice, and a
 * quote for the old ID fails verification because the echo names the new one.
 * Only the ID the provider answers with is offered.
 */
export const SUPERSEDED_ASSETS: ReadonlyMap<string, string> = new Map([["nep141:btc.omft.near", "1cs_v1:btc:native:coin"]]);

const NAMES: ReadonlyMap<string, string> = new Map(Object.entries(COIN_NAMES));

/** The provider tags some symbols, for example "BTC(OMNI)". People know the coin by its plain symbol. */
export function plainSymbol(symbol: string): string {
  return symbol.replace(/\(OMNI\)$/, "");
}

interface RawToken {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price: number;
  contractAddress: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates one upstream entry. Returns null when it is malformed. */
export function parseRawToken(entry: unknown): RawToken | null {
  if (!isRecord(entry)) return null;
  const { assetId, symbol, blockchain, decimals, price, contractAddress } = entry;
  if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) return null;
  if (typeof symbol !== "string" || !SYMBOL.test(symbol)) return null;
  if (typeof blockchain !== "string" || !CHAIN_KEY.test(blockchain)) return null;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return null;
  let contract: string | null = null;
  if (contractAddress !== undefined && contractAddress !== null) {
    if (typeof contractAddress !== "string" || !CONTRACT.test(contractAddress)) return null;
    contract = contractAddress;
  }
  return { assetId, symbol, blockchain, decimals, price, contractAddress: contract };
}

function scaledToDecimal(scaled: bigint): string {
  const whole = scaled / 10n ** 18n;
  const frac = (scaled % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

export type AllowlistVerdict = "ok" | "mismatch" | "not_listed";

/** Compares an upstream entry with our reviewed allowlist entry. */
export function compareWithAllowlist(raw: RawToken, allowed: AllowedCoin | undefined): AllowlistVerdict {
  if (allowed === undefined) return "not_listed";
  const upstreamContract = raw.contractAddress === null ? null : raw.contractAddress.toLowerCase();
  if (raw.blockchain !== allowed.chain || raw.decimals !== allowed.decimals || upstreamContract !== allowed.contractAddress) return "mismatch";
  return "ok";
}

interface OnChainState {
  verifiedAt: number;
  mismatch: boolean;
}

export function createTokenService(options: {
  oneclick: OneClick;
  rpc: Rpc;
  alerts: Alerts;
  log: Logger;
  dataDir: string | null;
  /** Chains whose coins are left out of the list altogether (see EXCLUDED_CHAINS). What is not on the list cannot be shown, quoted or ordered. */
  excludedChains?: ReadonlySet<string>;
  now?: () => number;
}): TokenService {
  const { oneclick, rpc, alerts, log } = options;
  const excludedChains = options.excludedChains ?? new Set<string>();
  const now = options.now ?? Date.now;
  const cacheFile = options.dataDir === null ? null : path.join(options.dataDir, "cache", "tokens.json");
  let current: TokenSnapshot | null = null;
  let lastAttempt = 0;
  let inFlight: Promise<void> | null = null;
  const onChain = new Map<string, OnChainState>();

  async function checkOnChain(): Promise<void> {
    await Promise.all(
      WALLET_CHAINS.map(async (chain: WalletChain) => {
        const coins = ALLOWLIST.filter((c) => c.chain === chain && c.contractAddress !== null);
        if (coins.length === 0) return;
        const results = await rpc.batch(
          chain,
          coins.map((c) => ({ method: "eth_call", params: [{ to: c.contractAddress, data: SELECTOR_DECIMALS }, "latest"] })),
        );
        coins.forEach((coin, i) => {
          const result = results[i];
          if (result === undefined || !result.ok) return; // RPC trouble is not a mismatch; the last result stands.
          const value = hexToBigInt(result.result);
          if (value === null) return;
          const mismatch = value !== BigInt(coin.decimals);
          onChain.set(coin.assetId, { verifiedAt: now(), mismatch });
          if (mismatch) alerts.send("token_mismatch", `On-chain decimals differ from the allowlist for ${coin.symbol} on ${coin.chain}. The coin is disabled.`, coin.assetId);
        });
      }),
    );
  }

  function build(rawList: RawToken[], t: number): TokenSnapshot {
    const tokens: Token[] = [];
    const seen = new Set<string>();
    const listed = new Set(rawList.map((raw) => raw.assetId));
    for (const raw of rawList) {
      if (seen.has(raw.assetId)) continue;
      seen.add(raw.assetId);
      if (raw.symbol.includes("DEPRECATED")) continue;
      if (excludedChains.has(raw.blockchain)) continue;
      const replacement = SUPERSEDED_ASSETS.get(raw.assetId);
      if (replacement !== undefined && listed.has(replacement)) continue;
      const priceScaled = priceToScaled(raw.price);
      if (priceScaled === null || priceScaled === 0n) continue;
      const allowed = ALLOWLIST_BY_ID.get(raw.assetId);
      const verdict = compareWithAllowlist(raw, allowed);
      if (verdict === "mismatch") {
        alerts.send("token_mismatch", `The provider's entry for ${raw.symbol} on ${raw.blockchain} differs from the allowlist. The coin is disabled.`, raw.assetId);
        continue;
      }
      let wallet = false;
      if (allowed !== undefined) {
        if (allowed.contractAddress === null) {
          wallet = true;
        } else {
          const state = onChain.get(allowed.assetId);
          if (state?.mismatch) continue;
          wallet = state !== undefined && t - state.verifiedAt < ONCHAIN_VALID_MS;
        }
      }
      tokens.push({
        id: raw.assetId,
        symbol: plainSymbol(raw.symbol),
        name: allowed?.name ?? NAMES.get(plainSymbol(raw.symbol)) ?? plainSymbol(raw.symbol),
        chain: raw.blockchain,
        decimals: raw.decimals,
        priceScaled,
        price: scaledToDecimal(priceScaled),
        contract: raw.contractAddress,
        wallet,
      });
    }
    const views: TokenView[] = tokens.map((token) => ({
      id: token.id,
      symbol: token.symbol,
      name: token.name,
      chain: token.chain,
      decimals: token.decimals,
      price: token.price,
      contract: token.contract,
      wallet: token.wallet,
    }));
    return { tokens, byId: new Map(tokens.map((token) => [token.id, token])), updatedAt: t, views };
  }

  function validate(data: unknown): RawToken[] | null {
    if (!Array.isArray(data) || data.length < 20 || data.length > 5000) return null;
    const parsed = data.map(parseRawToken).filter((token): token is RawToken => token !== null);
    // A list where many entries are malformed, or that lost more than half its coins, is not trusted.
    if (parsed.length < data.length * 0.8) return null;
    if (current !== null && parsed.length < current.tokens.length * 0.5) return null;
    return parsed;
  }

  function persist(rawList: RawToken[], t: number): void {
    if (cacheFile === null) return;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: t, tokens: rawList }));
      fs.renameSync(tmp, cacheFile);
    } catch {
      log.warn("token_cache_write_failed");
    }
  }

  function loadPersisted(t: number): void {
    if (cacheFile === null || current !== null) return;
    try {
      const saved = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { savedAt?: unknown; tokens?: unknown };
      if (typeof saved.savedAt !== "number" || t - saved.savedAt > LAST_GOOD_MS) return;
      const parsed = validate(saved.tokens);
      if (parsed !== null) current = build(parsed, saved.savedAt);
    } catch {
      // No cache yet.
    }
  }

  async function refreshOnce(): Promise<void> {
    const t = now();
    lastAttempt = t;
    loadPersisted(t);
    const upstream = await oneclick.tokens();
    const parsed = upstream.ok ? validate(upstream.data) : null;
    if (parsed === null) {
      log.warn("token_refresh_failed", { upstream: upstream.ok });
      return;
    }
    await checkOnChain();
    current = build(parsed, now());
    persist(parsed, current.updatedAt);
  }

  const service: TokenService = {
    refresh() {
      inFlight ??= refreshOnce()
        .catch(() => {
          log.warn("token_refresh_failed", { upstream: false });
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    async snapshot() {
      const t = now();
      const stale = current === null || t - current.updatedAt > TTL_MS;
      if (stale && t - lastAttempt > 5000) {
        const pending = service.refresh();
        // Wait only when there is nothing to serve yet.
        if (current === null) await pending;
      } else if (current === null && inFlight !== null) {
        await inFlight;
      }
      if (current !== null && now() - current.updatedAt > LAST_GOOD_MS) return null;
      return current;
    },
  };
  return service;
}
