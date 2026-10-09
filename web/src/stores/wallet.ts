// The connected wallet, as the rest of the interface sees it. The wallet and
// chain libraries are loaded only when the person presses Connect.

import { create } from "zustand";
import type { TokenView } from "../../../shared/api.ts";
import { isWalletChain } from "../../../shared/chains.ts";
import { api } from "../api.ts";
import { balanceCalls, readBalance } from "../lib/swap-logic.ts";

export interface WalletState {
  status: "disconnected" | "connecting" | "connected";
  /** Address in checksum form, when connected. */
  address: string | null;
  /** Our chain key for the wallet's current network, or null when it is on a network we do not support. */
  chain: string | null;
  /** True when the address has no contract code on the wallet's chain (or only hands its logic to one). Null until checked. */
  plain: boolean | null;
  /** Balances of the connected address, by coin ID, in raw units. */
  balances: Map<string, bigint>;
  error: string | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Reads the connected address's balance of one coin into `balances`. Does nothing without a wallet. */
  refreshBalance(token: { id: string; chain: string; contract: string | null }): Promise<void>;
  /**
   * Reads the connected address's balance of every coin a wallet can pay with, for the coin picker.
   * Asked through this site's own chain route; no wallet code is involved. At most once in half a minute.
   */
  loadBalances(tokens: readonly TokenView[]): Promise<void>;
}

const BALANCES_FRESH_MS = 30_000;
let balancesLoaded = { address: "", at: 0 };

export const useWallet = create<WalletState>((set, get) => ({
  status: "disconnected",
  address: null,
  chain: null,
  plain: null,
  balances: new Map(),
  error: null,
  async connect() {
    set({ status: "connecting", error: null });
    try {
      const wallet = await import("../wallet/index.ts");
      await wallet.connect();
    } catch {
      set({ status: "disconnected", error: "The wallet could not be opened. Try again." });
    }
  },
  async refreshBalance(token) {
    if (get().status !== "connected") return;
    try {
      const wallet = await import("../wallet/index.ts");
      await wallet.refreshBalance(token);
    } catch {
      // No balance is shown rather than a wrong one.
    }
  },
  async loadBalances(tokens) {
    const address = get().address;
    if (get().status !== "connected" || address === null) return;
    // Read again after half a minute, or at once when nothing is held from the last read (a wallet that left and came back).
    if (balancesLoaded.address === address && Date.now() - balancesLoaded.at < BALANCES_FRESH_MS && get().balances.size > 0) return;
    balancesLoaded = { address, at: Date.now() };
    const payable = tokens.filter((token) => token.wallet && isWalletChain(token.chain));
    const chains = [...new Set(payable.map((token) => token.chain))];
    await Promise.all(
      chains.map(async (chain) => {
        const coins = payable.filter((token) => token.chain === chain);
        // The chain route takes ten reads at a time.
        for (let start = 0; start < coins.length; start += 10) {
          const part = coins.slice(start, start + 10);
          try {
            const results = await api.chainBatch(chain, balanceCalls(part, address));
            if (get().address !== address) return;
            const next = new Map(get().balances);
            part.forEach((token, index) => {
              const balance = readBalance(results[index]);
              if (balance !== null) next.set(token.id, balance);
            });
            set({ balances: next });
          } catch {
            // A chain that cannot be read shows no balances; nothing is guessed.
          }
        }
      }),
    );
  },
  async disconnect() {
    try {
      const wallet = await import("../wallet/index.ts");
      await wallet.disconnect();
    } finally {
      set({ status: "disconnected", address: null, chain: null, plain: null, balances: new Map() });
    }
  },
}));
