// JSON-RPC access to the wallet chains through our own configured endpoints.
// Used for token checks, deposit confirmation and the small read-only proxy.
// RPC URLs can contain keys, so they are never logged or returned.

import { WALLET_CHAINS, type WalletChain } from "../shared/chains.ts";
import { readCappedText } from "./read.ts";

export interface RpcCall {
  method: string;
  params: unknown[];
}

export type RpcResult = { ok: true; result: unknown } | { ok: false; code: number; message: string; data?: string };

export interface Rpc {
  batch(chain: WalletChain, calls: RpcCall[]): Promise<RpcResult[]>;
  call(chain: WalletChain, method: string, params: unknown[]): Promise<RpcResult>;
}

const MAX_RESPONSE_BYTES = 2_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toResult(entry: unknown): RpcResult {
  if (!isRecord(entry)) return { ok: false, code: -32603, message: "RPC error" };
  if (isRecord(entry.error)) {
    // The node's own error text is never passed on. The numeric code and any
    // revert data are, because the wallet library needs them to explain a failed simulation.
    const { code, data } = entry.error;
    const numeric = typeof code === "number" && Number.isInteger(code) ? code : -32603;
    return {
      ok: false,
      code: numeric,
      message: numeric === 3 ? "execution reverted" : "RPC error",
      ...(typeof data === "string" && /^0x[0-9a-fA-F]{0,2048}$/.test(data) ? { data } : {}),
    };
  }
  if (!("result" in entry)) return { ok: false, code: -32603, message: "RPC error" };
  return { ok: true, result: entry.result };
}

export function createRpc(options: { urls: Readonly<Record<WalletChain | "sol", string>>; fetchImpl?: typeof fetch }): Rpc {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function batch(chain: WalletChain, calls: RpcCall[]): Promise<RpcResult[]> {
    if (!WALLET_CHAINS.includes(chain)) throw new Error("unsupported chain");
    if (calls.length === 0) return [];
    const payload = calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params }));
    const failed = (): RpcResult[] => calls.map(() => ({ ok: false, code: -32603, message: "RPC unavailable" }));
    try {
      const res = await fetchImpl(options.urls[chain], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return failed();
      const text = await readCappedText(res, MAX_RESPONSE_BYTES);
      const parsed: unknown = JSON.parse(text);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const byId = new Map<number, unknown>();
      for (const entry of entries) if (isRecord(entry) && typeof entry.id === "number") byId.set(entry.id, entry);
      return calls.map((_, id) => toResult(byId.get(id)));
    } catch {
      return failed();
    }
  }

  return {
    batch,
    async call(chain, method, params) {
      const [result] = await batch(chain, [{ method, params }]);
      return result ?? { ok: false, code: -32603, message: "RPC unavailable" };
    },
  };
}

// ---- Read-only proxy rules ----

const PROXY_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_getCode",
  "eth_getBlockByNumber",
]);

export const MAX_PROXY_BATCH = 10;

export interface ProxyRequest {
  id: string | number | null;
  call: RpcCall;
}

/** Validates a browser JSON-RPC body against the allowlist. Returns null when it is not acceptable. */
export function parseProxyBody(body: unknown): { requests: ProxyRequest[]; batch: boolean } | null {
  const batch = Array.isArray(body);
  const items: unknown[] = batch ? (body as unknown[]) : [body];
  if (items.length === 0 || items.length > MAX_PROXY_BATCH) return null;
  const requests: ProxyRequest[] = [];
  for (const item of items) {
    if (!isRecord(item) || item.jsonrpc !== "2.0" || typeof item.method !== "string") return null;
    if (!PROXY_METHODS.has(item.method)) return null;
    const id = item.id;
    if (!(id === null || id === undefined || typeof id === "number" || (typeof id === "string" && id.length <= 64))) return null;
    const params = item.params ?? [];
    if (!Array.isArray(params) || params.length > 4) return null;
    if (JSON.stringify(params).length > 8192) return null;
    // Whole blocks with every transaction are never needed and are large.
    if (item.method === "eth_getBlockByNumber" && params[1] !== false) return null;
    if (item.method === "eth_feeHistory") {
      const count = typeof params[0] === "string" ? Number.parseInt(params[0], 16) : Number(params[0]);
      if (!Number.isInteger(count) || count < 1 || count > 20) return null;
    }
    requests.push({ id: id ?? null, call: { method: item.method, params } });
  }
  return { requests, batch };
}

/**
 * True for a batch that only reads balances: a chain's own coin (`eth_getBalance`) or a token's
 * `balanceOf`. The page reads many of these at once for a connected wallet, so they are counted
 * apart from every other read: however many coins are listed, reading what a wallet holds can never
 * use up the allowance that a payment and the check of a recipient's address draw on.
 */
export function isBalanceBatch(parsed: { requests: ProxyRequest[]; batch: boolean }): boolean {
  if (!parsed.batch) return false;
  return parsed.requests.every(({ call }) => {
    if (call.method === "eth_getBalance") return true;
    if (call.method !== "eth_call") return false;
    // The call a balance read is, and nothing more: a contract and `balanceOf` of one address, at the latest block.
    const [first, block] = call.params as unknown[];
    if (!isRecord(first) || Object.keys(first).some((key) => key !== "to" && key !== "data")) return false;
    if (block !== undefined && block !== "latest") return false;
    return typeof first.to === "string" && typeof first.data === "string" && new RegExp(`^${SELECTOR_BALANCE_OF}0{24}[0-9a-f]{40}$`).test(first.data.toLowerCase());
  });
}

// ---- Small ABI helpers ----

export const SELECTOR_BALANCE_OF = "0x70a08231";

export const SELECTOR_DECIMALS = "0x313ce567";
export const SELECTOR_TRANSFER = "0xa9059cbb";

/** Decodes `transfer(address,uint256)` call data. Null when the data is anything else. */
export function decodeErc20Transfer(input: unknown): { to: string; amount: bigint } | null {
  if (typeof input !== "string" || !/^0xa9059cbb[0-9a-fA-F]{128}$/.test(input)) return null;
  const toWord = input.slice(10, 74);
  if (!/^0{24}/.test(toWord)) return null;
  return { to: `0x${toWord.slice(24).toLowerCase()}`, amount: BigInt(`0x${input.slice(74, 138)}`) };
}

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Decodes an ERC-20 Transfer event from a receipt log. Null for any other log. */
export function decodeTransferLog(log: unknown): { token: string; from: string; to: string; amount: bigint } | null {
  if (!isRecord(log) || typeof log.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(log.address)) return null;
  const { topics, data } = log;
  if (!Array.isArray(topics) || topics.length !== 3 || topics[0] !== TRANSFER_TOPIC) return null;
  const [, from, to] = topics as unknown[];
  const word = /^0x0{24}[0-9a-fA-F]{40}$/;
  if (typeof from !== "string" || typeof to !== "string" || !word.test(from) || !word.test(to)) return null;
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data)) return null;
  return { token: log.address.toLowerCase(), from: `0x${from.slice(26).toLowerCase()}`, to: `0x${to.slice(26).toLowerCase()}`, amount: BigInt(data) };
}

export function hexToBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return null;
  return BigInt(value);
}
