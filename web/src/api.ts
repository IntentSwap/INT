// The browser's only line to the outside: our own server. It never calls the
// swap provider and never holds a key.

import type { ApiErrorBody, ConfigResponse, CreateOrderBody, ErrorCode, OrderView, QuoteBody, QuoteView, StatusResponse, TokensResponse } from "../../shared/api.ts";
import type { RewardsPublic, RewardsView } from "../../shared/rewards.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | "network";
  readonly detail: Record<string, string | number>;
  readonly quote: QuoteView | null;
  /** Seconds the server asked us to wait before trying again, when it said. */
  readonly retryAfter: number | null;

  constructor(status: number, code: ErrorCode | "network", message: string, detail: Record<string, string | number> = {}, quote: QuoteView | null = null, retryAfter: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.quote = quote;
    this.retryAfter = retryAfter;
  }
}

const ORDER_TIMEOUT_MS = 30_000;

let session: { token: string; expiresAt: number } | null = null;

export function rememberSession(config: ConfigResponse): void {
  // How long the token lasts is worked out on the server's clock and counted on this device's:
  // a device whose clock is wrong would otherwise think every token had already expired, or never would.
  const lifetime = Date.parse(config.sessionExpiresAt) - Date.parse(config.serverNow);
  session = { token: config.session, expiresAt: Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 0) };
}

async function parse<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const error = (body as ApiErrorBody | null)?.error;
  // An everyday outcome (no route, an amount under the minimum) arrives as a 200 with an error in the body.
  if (res.ok && (error === undefined || error === null)) return body as T;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    const wait = Number(res.headers.get("retry-after"));
    throw new ApiError(res.status, error.code, error.message, error.detail ?? {}, error.quote ?? null, Number.isFinite(wait) && wait > 0 ? Math.min(wait, 3600) : null);
  }
  throw new ApiError(res.status, "unavailable", "Something went wrong. Try again.");
}

async function send<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal, extra: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method === "POST" && session !== null) headers["x-session"] = session.token;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), ...(signal ? { signal } : {}), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof DOMException && err.name === "TimeoutError") throw new ApiError(0, "network", "That took too long. Try again.");
    throw new ApiError(0, "network", "Can't reach the service. Check your connection.");
  }
  return parse<T>(res);
}

async function fetchConfig(): Promise<ConfigResponse> {
  const config = await send<ConfigResponse>("GET", "/api/config");
  rememberSession(config);
  return config;
}

/** POST with a live session token: fetched when missing or about to expire, and renewed once if the server says it has expired. */
async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  if (session === null || session.expiresAt - Date.now() < 60_000) await fetchConfig();
  try {
    return await send<T>("POST", path, body, signal);
  } catch (err) {
    if (err instanceof ApiError && err.code === "session") {
      await fetchConfig();
      return send<T>("POST", path, body, signal);
    }
    throw err;
  }
}

export const api = {
  config: fetchConfig,
  status: () => send<StatusResponse>("GET", "/api/status"),
  tokens: () => send<TokensResponse>("GET", "/api/tokens"),
  quote: (body: QuoteBody, signal: AbortSignal) => post<QuoteView>("/api/quote", body, signal),
  /**
   * Makes an order. Given up on after 30 seconds: the request carries a label (`requestId`), so
   * trying again with the same label returns the order that was made, if one was, and never a second.
   */
  createOrder: (body: CreateOrderBody & { requestId: string }) => post<OrderView>("/api/orders", body, AbortSignal.timeout(ORDER_TIMEOUT_MS)),
  order: (id: string, signal?: AbortSignal) => send<OrderView>("GET", `/api/orders/${encodeURIComponent(id)}`, undefined, signal),
  submitDeposit: (id: string, txHash: string) => post<OrderView>(`/api/orders/${encodeURIComponent(id)}/deposit`, { txHash }),
  /** Finds an order by its deposit address. Answers with the order's ID, or "not found" exactly as an unknown order ID does. */
  track: (depositAddress: string) => post<{ id: string }>("/api/track", { depositAddress }, AbortSignal.timeout(15_000)),
  practice: (id: string, action: string) => post<{ ok: true }>(`/api/practice/${encodeURIComponent(id)}`, { action }),
  /** What anyone may see of the rewards: the week's dates, the weeks already paid, the reserve. */
  rewards: () => send<RewardsPublic>("GET", "/api/rewards"),
  /** The first half of the Rewards page's sign-in: the message to sign for an address, with its one-time code. */
  rewardsCode: (address: string) => post<{ message: string; nonce: string; issuedAt: string; expiresAt: string }>("/api/rewards/code", { address }, AbortSignal.timeout(15_000)),
  /** The second half: the signature, for a sign-in that lasts half an hour. */
  rewardsSession: (nonce: string, signature: string) => post<{ address: string; token: string; expiresAt: string }>("/api/rewards/session", { nonce, signature }, AbortSignal.timeout(15_000)),
  /** One's own points, with a sign-in. */
  rewardsMine: (token: string) => send<RewardsView>("GET", "/api/rewards/me", undefined, AbortSignal.timeout(15_000), { "x-rewards-session": token }),
  /**
   * One read of a chain through this site's own route. Returns the plain result; throws when the
   * route cannot be reached or refuses the call.
   */
  async chainRead(chain: string, method: string, params: unknown[]): Promise<unknown> {
    const body = await post<{ result?: unknown; error?: unknown }>(`/api/rpc/${encodeURIComponent(chain)}`, { jsonrpc: "2.0", id: 1, method, params }, AbortSignal.timeout(15_000));
    if (body === null || typeof body !== "object" || !("result" in body)) throw new ApiError(502, "unavailable", "The chain could not be read.");
    return body.result;
  },
  /**
   * Several reads of a chain in one request (at most ten). Returns one result per read, in order;
   * a read the node refused or failed comes back as undefined.
   */
  async chainBatch(chain: string, calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    const body = await post<unknown>(
      `/api/rpc/${encodeURIComponent(chain)}`,
      calls.map((call, id) => ({ jsonrpc: "2.0", id, method: call.method, params: call.params })),
      AbortSignal.timeout(15_000),
    );
    const replies = Array.isArray(body) ? body : [];
    return calls.map((_, id) => (replies.find((reply) => typeof reply === "object" && reply !== null && (reply as { id?: unknown }).id === id) as { result?: unknown } | undefined)?.result);
  },
  /** The session token for the RPC proxy, renewed when needed. */
  async sessionToken(): Promise<string> {
    if (session === null || session.expiresAt - Date.now() < 60_000) await fetchConfig();
    return session?.token ?? "";
  },
};
