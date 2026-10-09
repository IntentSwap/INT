// The wallet connection. This file, and the libraries it brings in, are fetched only when
// the person presses Connect: nothing of it is part of the page before that.
//
// Reown AppKit shows the list of wallets; wagmi talks to the one that is chosen. The wallet
// is asked for two things only: its address and network, and (on a press of the pay button)
// one plain transfer that has passed the gate in ./transfer.ts. It is never asked to approve,
// to permit, or to sign a message.

import { createAppKit, type AppKit } from "@reown/appkit";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { EventsController, TelemetryController } from "@reown/appkit-controllers";
import UniversalProvider from "@walletconnect/universal-provider";
import { arbitrum, base, bsc, mainnet, type AppKitNetwork } from "@reown/appkit/networks";
import { disconnect as wagmiDisconnect, getAccount, getBalance, readContract, sendTransaction, switchChain, watchAccount, type Config } from "@wagmi/core";
import { erc20Abi, http } from "viem";
import { toChecksumAddress } from "../../../shared/addresses.ts";
import type { TokenView } from "../../../shared/api.ts";
import { chainInfo, isWalletChain, WALLET_CHAIN_NODE, WALLET_CHAINS } from "../../../shared/chains.ts";
import { api } from "../api.ts";
import { isContractCode } from "../lib/swap-logic.ts";
import { useApp } from "../stores/app.ts";
import { useWallet } from "../stores/wallet.ts";
import { getTheme, onThemeChange } from "../theme.ts";
import { checkedTransfer, type PayableOrder } from "./transfer.ts";
import { sessionRights, WINDOW_FEATURES } from "./session.ts";

/**
 * The four networks a wallet can pay on, under the names this site uses for them. Each carries the
 * chain's own public node as the one a wallet is told about (a phone wallet asked to add a network
 * is given the network's default node, whatever else is passed along).
 */
const withNode = (network: AppKitNetwork, key: keyof typeof WALLET_CHAIN_NODE): AppKitNetwork => ({ ...network, rpcUrls: { ...network.rpcUrls, default: { http: [WALLET_CHAIN_NODE[key]] } } }) as AppKitNetwork;
const NETWORKS: Record<string, AppKitNetwork> = { bsc: withNode(bsc, "bsc"), eth: withNode(mainnet, "eth"), base: withNode(base, "base"), arb: withNode(arbitrum, "arb") };

/** Our name for a network, from its number. Null for any network this site does not pay on. */
export function chainKeyOf(chainId: number | undefined): string | null {
  return WALLET_CHAINS.find((key) => chainInfo(key).evmChainId === chainId) ?? null;
}

// What a wallet may be asked for, and what the wallet window may do, are set in session.ts, where a test holds them to the rule.
export { WALLET_METHODS } from "./session.ts";

/** The wallet library's own settings, for the one other module that talks to a wallet (sign-in.ts). Nothing here asks a wallet for anything. */
export async function walletConfig(): Promise<Config> {
  return (await setUp()).wagmi;
}

/** How long a press of Connect waits for the library to find an already-trusted wallet before showing the list. */
const STARTUP_WAIT_MS = 4000;

let kit: AppKit | null = null;
let wagmi: Config | null = null;
let ready: Promise<{ kit: AppKit; wagmi: Config }> | null = null;

/**
 * The wallet library reports to its maker what happens in its window (the page's address, the wallets
 * shown, the address that connected), and does so even with its "analytics" switch off. This site sends
 * no such reports: the senders are replaced by nothing here, before the window is made. The site's
 * security policy refuses the destination too, so a later version that sends some other way is stopped.
 */
function silenceReports(): void {
  const nothing = () => undefined;
  EventsController.sendEvent = nothing;
  EventsController.sendWalletImpressionEvent = nothing;
  EventsController._setPendingEvent = nothing;
  EventsController._submitPendingEvents = nothing;
  TelemetryController.disable();
}

/** Reads of a chain go through our own server (which holds the node addresses), with the session token it asks for. */
function transport(key: string) {
  return http(`${window.location.origin}/api/rpc/${key}`, {
    batch: false,
    retryCount: 1,
    onFetchRequest: async (_request, init) => ({ ...init, credentials: "omit", headers: { ...(init.headers as Record<string, string> | undefined), "x-session": await api.sessionToken() } }),
  });
}

/** Makes the wallet window, once. Every other function here waits for it. */
function setUp(): Promise<{ kit: AppKit; wagmi: Config }> {
  ready ??= create().catch((error: unknown) => {
    ready = null;
    throw error;
  });
  return ready;
}

async function create(): Promise<{ kit: AppKit; wagmi: Config }> {
  silenceReports();
  const projectId = useApp.getState().config?.reownProjectId ?? "";
  const metadata = { name: "IntentSwap", description: "Swap coins across chains.", url: window.location.origin, icons: [`${window.location.origin}/apple-touch-icon.png`] };
  // The WalletConnect link is made here, not by the wallet window, so that its own reporting can be switched off.
  const universalProvider = await UniversalProvider.init({ projectId, metadata, telemetryEnabled: false, logger: "silent" });
  const networks = WALLET_CHAINS.map((key) => NETWORKS[key]).filter((network): network is AppKitNetwork => network !== undefined) as [AppKitNetwork, ...AppKitNetwork[]];
  const adapter = new WagmiAdapter({
    projectId,
    networks,
    transports: Object.fromEntries(WALLET_CHAINS.map((key) => [chainInfo(key).evmChainId, transport(key)])),
    // Nothing is kept by the server on the person's behalf, and there is no server rendering here.
    ssr: false,
  });
  // The adapter puts its maker's node behind each of our routes as a second choice. Ours are put back
  // alone, so that a failure of this site's route is a failure, and never a question (with the
  // person's address in it) to someone else.
  const routes = adapter.wagmiConfig._internal.transports as Record<number, ReturnType<typeof transport>>;
  for (const key of WALLET_CHAINS) {
    const chainId = chainInfo(key).evmChainId;
    if (chainId !== undefined) routes[chainId] = transport(key);
  }
  kit = createAppKit({
    adapters: [adapter],
    networks,
    projectId,
    metadata,
    universalProvider,
    themeMode: getTheme(),
    themeVariables: { "--w3m-font-family": "Geist, system-ui, sans-serif", "--w3m-border-radius-master": "3px", "--w3m-z-index": 60 },
    // Only the connection itself: every other thing the wallet window can do is switched off (session.ts).
    features: { ...WINDOW_FEATURES },
    enableWalletGuide: false,
    enableNetworkSwitch: false,
    allowUnsupportedChain: true,
    // No Coinbase or Base Account kit: each adds a script of its own to the page and opens a pop-up
    // window, which the site's security policy forbids. Those wallets still connect the ordinary ways:
    // as a browser extension, or through WalletConnect on a phone. The build also leaves the kits'
    // code out altogether (web/vite.config.ts), because the second switch is not honoured by this version.
    enableCoinbase: false,
    enableBaseAccount: false,
    // A phone wallet (WalletConnect) is asked for the right to do only what this site ever does:
    // send a transaction, change network, add a network, and sign the Rewards page's one plain message (session.ts).
    universalProviderConfigOverride: sessionRights(),
  });
  wagmi = adapter.wagmiConfig;
  // The library would look the connected address up with its maker, for a name and a picture this site
  // never shows. It is not asked: the address goes to the wallet, to this site's server, and nowhere else.
  kit.fetchIdentity = () => Promise.resolve({ name: null, avatar: null });
  // The wallet window follows the site's theme.
  const window_ = kit;
  onThemeChange(() => window_.setThemeMode(getTheme()));

  // The rest of the site learns about the wallet from here, and only from here.
  const sync = () => {
    if (wagmi === null) return;
    const account = getAccount(wagmi);
    if (account.status === "connected" && account.address !== undefined) {
      const address = toChecksumAddress(account.address);
      const chain = chainKeyOf(account.chainId);
      const before = useWallet.getState();
      const changed = before.address !== address || before.chain !== chain;
      useWallet.setState({ status: "connected", address, chain, error: null, ...(changed ? { plain: null, balances: new Map() } : {}) });
      if (changed && chain !== null) void checkPlain(chain, address);
    } else if (account.status === "disconnected") {
      useWallet.setState({ status: "disconnected", address: null, chain: null, plain: null, balances: new Map() });
    }
  };
  watchAccount(wagmi, { onChange: sync });
  sync();
  return { kit, wagmi };
}

/** Finds out whether the connected address is a plain wallet on its own chain (see walletAddressFor in swap-logic). */
async function checkPlain(chain: string, address: string): Promise<void> {
  try {
    const res = await fetch(`/api/rpc/${chain}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session": await api.sessionToken() },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
      credentials: "omit",
    });
    const body = (await res.json()) as { result?: unknown };
    const current = useWallet.getState();
    if (current.address === address && current.chain === chain && typeof body.result === "string") useWallet.setState({ plain: !isContractCode(body.result) });
  } catch {
    // Not known: the address is then offered on its own chain only.
  }
}

/** Opens the wallet list. Resolves once a wallet is connected, or the list is closed without one. */
export async function connect(): Promise<void> {
  const { kit: modal, wagmi: config } = await setUp();
  // A wallet that already trusts this site connects by itself as the library starts: wait for that
  // (briefly), so the list of wallets is not opened over a wallet that is already connected.
  await Promise.race([modal.ready(), new Promise((resolve) => setTimeout(resolve, STARTUP_WAIT_MS))]);
  if (getAccount(config).status === "connected") return;
  await modal.open();
  await new Promise<void>((resolve) => {
    const unsubscribe = modal.subscribeState((state) => {
      if (!state.open) {
        unsubscribe();
        resolve();
      }
    });
  });
  if (getAccount(config).status !== "connected") useWallet.setState({ status: "disconnected" });
}

export async function disconnect(): Promise<void> {
  if (wagmi === null) return;
  await wagmiDisconnect(wagmi);
}

/**
 * Asks the wallet to change to the network an order is paid on. Only ever called from a press of a button.
 * (The wallet library may itself ask a wallet to return to the network it last used on this site, at the
 * moment it connects. That is the one other request to change network a wallet can receive here.)
 */
export async function switchTo(chain: string): Promise<void> {
  const { wagmi: config } = await setUp();
  const chainId = chainInfo(chain).evmChainId;
  if (chainId === undefined || !isWalletChain(chain)) throw new Error("not a wallet network");
  // A wallet that does not know the network is told the chain's own public node, never one that carries a project's ID.
  await switchChain(config, { chainId, addEthereumChainParameter: { rpcUrls: [WALLET_CHAIN_NODE[chain]] } });
}

/** The connected address's balance of a coin, in raw units. Kept in the wallet store under the coin's ID. */
export async function refreshBalance(token: Pick<TokenView, "id" | "chain" | "contract">): Promise<void> {
  const { wagmi: config } = await setUp();
  const { address } = useWallet.getState();
  const chainId = chainInfo(token.chain).evmChainId;
  if (address === null || chainId === undefined) return;
  const owner = address as `0x${string}`;
  const raw = token.contract === null ? (await getBalance(config, { address: owner, chainId })).value : await readContract(config, { abi: erc20Abi, address: token.contract as `0x${string}`, functionName: "balanceOf", args: [owner], chainId });
  if (useWallet.getState().address !== address) return;
  useWallet.setState({ balances: new Map(useWallet.getState().balances).set(token.id, raw) });
}

/**
 * Asks the wallet for the one transfer that pays an order, and returns its hash.
 * `fresh` is the order as the server holds it at this moment; `shown` is the one on screen when the
 * button was pressed. The transaction is built from `fresh`, passed through the gate immediately
 * before it is handed over, and exactly what passed is what is sent.
 */
export async function pay(fresh: PayableOrder, shown: PayableOrder): Promise<string> {
  const { wagmi: config } = await setUp();
  const tx = checkedTransfer(fresh, shown);
  if (getAccount(config).chainId !== tx.chainId) throw new Error("wrong network");
  return sendTransaction(config, { chainId: tx.chainId, to: tx.to as `0x${string}`, value: tx.value, ...(tx.data === "0x" ? {} : { data: tx.data as `0x${string}` }) });
}

/** True when an error from the wallet means the person said no. */
export function wasRejected(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e !== null && typeof e === "object" && depth < 6; e = (e as { cause?: unknown }).cause, depth++) {
    const { name, code } = e as { name?: unknown; code?: unknown };
    if (name === "UserRejectedRequestError" || code === 4001 || code === "ACTION_REJECTED") return true;
  }
  return false;
}
