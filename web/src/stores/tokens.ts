// The coin list, loaded from our server and kept for up to 24 hours as a fallback.

import { create } from "zustand";
import type { TokenView } from "../../../shared/api.ts";
import { api } from "../api.ts";

const CACHE_KEY = "coins-v1";
const CACHE_MS = 24 * 3_600_000;

interface TokensState {
  status: "loading" | "ready" | "stale" | "failed";
  tokens: TokenView[];
  byId: Map<string, TokenView>;
  load(): Promise<void>;
}

/** A coin entry in the shape the site expects. */
export function isToken(value: unknown): value is TokenView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length <= 200 &&
    typeof v.symbol === "string" &&
    v.symbol.length >= 1 &&
    v.symbol.length <= 24 &&
    typeof v.name === "string" &&
    v.name.length <= 80 &&
    typeof v.chain === "string" &&
    /^[a-z0-9]{2,20}$/.test(v.chain) &&
    typeof v.decimals === "number" &&
    Number.isInteger(v.decimals) &&
    v.decimals >= 0 &&
    v.decimals <= 30 &&
    (v.price === null || (typeof v.price === "string" && /^\d+(\.\d+)?$/.test(v.price))) &&
    (v.contract === null || (typeof v.contract === "string" && v.contract.length <= 130)) &&
    typeof v.wallet === "boolean"
  );
}

function readCache(): TokenView[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { savedAt?: number; tokens?: TokenView[] };
    if (typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > CACHE_MS || !Array.isArray(parsed.tokens)) return null;
    // What was kept is checked like anything else that comes from outside: only well-formed coins are used.
    const tokens = parsed.tokens.filter(isToken);
    return tokens.length > 0 ? tokens : null;
  } catch {
    return null;
  }
}

function index(tokens: TokenView[]): Map<string, TokenView> {
  return new Map(tokens.map((token) => [token.id, token]));
}

export const useTokens = create<TokensState>((set) => ({
  status: "loading",
  tokens: [],
  byId: new Map(),
  async load() {
    try {
      const { tokens } = await api.tokens();
      set({ status: "ready", tokens, byId: index(tokens) });
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), tokens }));
      } catch {
        // No storage: the list simply is not kept for next time.
      }
    } catch {
      const cached = readCache();
      if (cached !== null) set({ status: "stale", tokens: cached, byId: index(cached) });
      else set({ status: "failed" });
    }
  },
}));

export function findToken(tokens: TokenView[], chain: string, symbol: string): TokenView | undefined {
  return tokens.find((token) => token.chain === chain && token.symbol === symbol);
}
