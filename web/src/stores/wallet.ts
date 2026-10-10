// The connected wallet, as the rest of the interface sees it. The wallet and
// chain libraries are loaded only when the person presses Connect.
//
// In Ghost mode there is no wallet. The wallet software is fetched through one door, in this file,
// and the door is shut while the mode holds: nothing of that software is requested, and nothing of
// it runs. No balance is read either, since there is no address to read one for.

import { create } from "zustand";
import type { TokenView } from "../../../shared/api.ts";
import { isWalletChain } from "../../../shared/chains.ts";
import { api } from "../api.ts";
import { ghostHolds } from "../lib/kept.ts";
import { balanceCalls, readBalance } from "../lib/swap-logic.ts";
// Only what the module looks like. This line fetches nothing: the module itself comes through the door below, when it comes at all.
import type * as walletModule from "../wallet/index.ts";

/** What is needed of a coin to read a balance of it. */
type Coin = Pick<TokenView, "id" | "chain" | "contract">;

export interface WalletState {
  status: "disconnected" | "connecting" | "connected";
  /** Address in checksum form, when connected. */
  address: string | null;
  /** Our chain key for the wallet's current network, or null when it is on a network we do not support. */
  chain: string | null;
  /** The number of the network the wallet is on, whichever it is: one of this site's or not. Null when no wallet is connected. */
  chainId: number | null;
  /** True when the address has no contract code on the wallet's chain (or only hands its logic to one). Null until checked. */
  plain: boolean | null;
  /** What the connected address holds of each coin that has been read, by coin ID, in raw units. Holding none is a balance of zero. */
  balances: Map<string, bigint>;
  /** The coins whose balance could not be read for the connected address. A coin in neither of the two has not been read yet. */
  unreadable: Set<string>;
  error: string | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Reads the connected address's balance of one coin afresh, however lately it was read. Does nothing without a wallet. */
  refreshBalance(token: Coin): Promise<void>;
  /**
   * Reads the connected address's balance of each of these coins that is on a network a wallet can
   * pay on. Asked of the coin's own chain through this site's chain route: the wallet is asked
   * nothing, and the network it is on makes no difference. A coin asked about less than `freshMs`
   * ago is not asked about again.
   */
  loadBalances(tokens: readonly Coin[], freshMs?: number): Promise<void>;
}

/** How long a balance that was read stands before the same coin is read again for the same address. */
export const BALANCE_FRESH_MS = 15_000;
/** The same for the whole coin list, which the coin picker shows: that is many reads at once, so it is made less often. */
export const LIST_FRESH_MS = 60_000;
/** When each coin was last asked about, for the connected address. */
const askedAt = new Map<string, number>();

/**
 * No balance of any coin, and no memory of when one was last asked about: what the store holds
 * before a wallet is connected, and again the moment the connected address changes or leaves.
 */
export function noBalances(): Pick<WalletState, "balances" | "unreadable"> {
  askedAt.clear();
  return { balances: new Map(), unreadable: new Set() };
}

/** The module that talks to a wallet, with the libraries it brings in. */
type WalletSoftware = typeof walletModule;

/**
 * The one door to the wallet software: every part of the site that needs it asks here, and nothing
 * else fetches it. While Ghost mode holds the door is shut, so that not even a stray call can bring
 * the software into the page.
 */
export async function walletSoftware(): Promise<WalletSoftware> {
  if (ghostHolds()) throw new Error("In Ghost mode the wallet software is not loaded.");
  const fetched = import("../wallet/index.ts");
  onItsWay = fetched.then(
    () => undefined,
    () => undefined,
  );
  return fetched;
}

/** Set once the door has been gone through: the wallet software is in this page, or on its way into it. */
let onItsWay: Promise<void> | null = null;

/** The wallet software, once it is in this page: enough of it to let go of a wallet without fetching anything. */
let inPage: Pick<WalletSoftware, "disconnect"> | null = null;

/** Called by the wallet software itself as it arrives in the page, whichever part of the site fetched it. */
export function walletSoftwareArrived(software: Pick<WalletSoftware, "disconnect">): void {
  inPage = software;
}

/** How long a wallet that is being disconnected is waited for. One that does not answer is left behind all the same. */
const LET_GO_MS = 3_000;

/** The store with no wallet in it. */
const noWallet = () => ({ status: "disconnected" as const, address: null, chain: null, chainId: null, plain: null, ...noBalances() });

/**
 * Ghost mode is turning on. A connected wallet is disconnected, through the software that
 * connected it, and the store is put back as it is before any wallet. Answers whether that
 * software is in this page, or was on its way into it: if so, only loading the page again takes it out.
 */
export async function letGoOfWallet(): Promise<boolean> {
  const waited = () => new Promise<void>((resolve) => setTimeout(resolve, LET_GO_MS));
  try {
    // Software that was asked for a moment ago is waited for, so that it is not left to arrive after the mode is on.
    if (onItsWay !== null) await Promise.race([onItsWay, waited()]);
    if (inPage !== null) await Promise.race([inPage.disconnect(), waited()]);
  } catch {
    // Whatever the wallet answered, the page keeps nothing of it.
  }
  useWallet.setState({ ...noWallet(), error: null });
  return inPage !== null || onItsWay !== null;
}

export const useWallet = create<WalletState>((set, get) => ({
  status: "disconnected",
  address: null,
  chain: null,
  chainId: null,
  plain: null,
  ...noBalances(),
  error: null,
  async connect() {
    // In Ghost mode there is no wallet to connect: nothing is fetched, and nothing is said.
    if (ghostHolds()) return;
    set({ status: "connecting", error: null });
    try {
      const wallet = await walletSoftware();
      await wallet.connect();
    } catch {
      // Ghost mode turned on meanwhile: there is no wallet, and nothing went wrong that the person need be told.
      set({ status: "disconnected", error: ghostHolds() ? null : "The wallet could not be opened. Try again." });
    }
  },
  refreshBalance(token) {
    return get().loadBalances([token], 0);
  },
  async loadBalances(tokens, freshMs = BALANCE_FRESH_MS) {
    const address = get().address;
    if (get().status !== "connected" || address === null || ghostHolds()) return;
    const now = Date.now();
    const due = tokens.filter((token) => isWalletChain(token.chain) && now - (askedAt.get(token.id) ?? -Infinity) >= freshMs);
    for (const token of due) askedAt.set(token.id, now);
    await Promise.all(
      [...new Set(due.map((token) => token.chain))].map(async (chain) => {
        const coins = due.filter((token) => token.chain === chain);
        // The chain route takes ten reads at a time.
        for (let start = 0; start < coins.length; start += 10) {
          const part = coins.slice(start, start + 10);
          // A request that fails answers for none of its coins.
          const results = await api.chainBatch(chain, balanceCalls(part, address)).catch((): unknown[] => []);
          if (get().address !== address) return;
          const balances = new Map(get().balances);
          const unreadable = new Set(get().unreadable);
          part.forEach((token, index) => {
            const balance = readBalance(results[index]);
            if (balance === null) {
              // Nothing is shown rather than a figure that may be wrong, and nothing is guessed. The coin is asked about again at the next chance.
              balances.delete(token.id);
              unreadable.add(token.id);
              askedAt.delete(token.id);
            } else {
              balances.set(token.id, balance);
              unreadable.delete(token.id);
            }
          });
          set({ balances, unreadable });
        }
      }),
    );
  },
  async disconnect() {
    try {
      // The software that connected the wallet is in the page already. It is never fetched in order to disconnect.
      await inPage?.disconnect();
    } finally {
      set(noWallet());
    }
  },
}));
