// The only code that talks to the swap provider. The hostname is fixed, no
// redirect is followed, and no part of a URL comes from user input except
// query values that are encoded.

import { errorKind, type Logger } from "./log.ts";
import { readCappedText } from "./read.ts";

export const ONECLICK_ORIGIN = "https://1click.chaindefuser.com";

/**
 * Who a provider call is for. Each class has its own share of the per-minute budget:
 * - "user": a person's preview, order or deposit hash. At most 60%.
 * - "idle": checking an order nobody has paid yet. At most 25%.
 * - "tracking": following an order with funds in motion, and housekeeping. Whatever is left,
 *   which is never less than 15% and is everything when the others are quiet.
 */
export type Priority = "user" | "order" | "tracking" | "idle";

export type UpstreamResult =
  | { ok: true; status: number; data: unknown; cid?: string }
  /** The provider understood the request and refused it (a 4xx other than an authentication or rate-limit error). */
  | { ok: false; kind: "rejected"; status: number; message: string; cid?: string }
  /**
   * Network failure, timeout, 5xx, 401, 429, an unreadable reply, a call this
   * process is not allowed to make, or our own call budget being spent
   * (`budget: true`, which is not a fault of the provider).
   */
  | { ok: false; kind: "unavailable"; status: number | null; cid?: string; budget?: true };

/**
 * Share of the per-minute budget set aside for each kind of call. No other kind can use it,
 * so none of the four can be starved by the others: price previews ("user"), the real quote
 * behind a new order ("order"), orders with funds in motion ("tracking"), and orders nobody
 * has paid yet ("idle"). The remainder goes to whichever of the first three asks first.
 */
export const RESERVED_SHARE: Readonly<Record<Priority, number>> = { user: 0.25, order: 0.1, tracking: 0.3, idle: 0.2 };
/** Checking unpaid orders never uses more than its reserved share. */
export const IDLE_BUDGET_SHARE = RESERVED_SHARE.idle;
/** The most that previews can use: everything not reserved for the other three. */
export const USER_BUDGET_SHARE = 1 - RESERVED_SHARE.order - RESERVED_SHARE.tracking - RESERVED_SHARE.idle;

/** Calls a minute available for checking unpaid orders. */
export function idleBudget(maxPerMin: number): number {
  return Math.max(1, Math.floor(maxPerMin * IDLE_BUDGET_SHARE));
}

const PRIORITIES: readonly Priority[] = ["user", "order", "tracking", "idle"];

/** The provider's request-tracing ID, when a reply carries a well-formed one. */
function correlationId(data: unknown): { cid?: string } {
  if (typeof data !== "object" || data === null) return {};
  const value = (data as { correlationId?: unknown }).correlationId;
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value) ? { cid: value } : {};
}

export interface OneClick {
  tokens(): Promise<UpstreamResult>;
  quote(body: Record<string, unknown>, priority?: Priority): Promise<UpstreamResult>;
  status(depositAddress: string, depositMemo: string | null, priority?: Priority): Promise<UpstreamResult>;
  submitDeposit(body: { depositAddress: string; txHash: string; memo?: string }, priority?: Priority): Promise<UpstreamResult>;
  health(): { degraded: boolean; errorRate: number; calls: number };
}

interface Outcome {
  at: number;
  failed: boolean;
}

const WINDOW_MS = 5 * 60_000;

export function createOneClick(options: {
  apiKey: string | null;
  maxPerMin: number;
  /**
   * Whether this process may create or track real orders. Only production
   * sets it. Without it the client itself refuses anything but a price preview,
   * whatever the calling code asks for.
   */
  allowLive: boolean;
  log: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onErrorRate?: (rate: number, calls: number) => void;
}): OneClick {
  const { apiKey, maxPerMin, allowLive, log } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let outcomes: Outcome[] = [];
  let lastThree: boolean[] = [];
  let windowStart = 0;
  let used = 0;
  const usedBy: Record<Priority, number> = { user: 0, order: 0, tracking: 0, idle: 0 };
  const reserved: Record<Priority, number> = {
    user: Math.floor(maxPerMin * RESERVED_SHARE.user),
    order: Math.floor(maxPerMin * RESERVED_SHARE.order),
    tracking: Math.floor(maxPerMin * RESERVED_SHARE.tracking),
    idle: Math.floor(maxPerMin * RESERVED_SHARE.idle),
  };
  const idleCap = idleBudget(maxPerMin);

  function budget(priority: Priority): boolean {
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      used = 0;
      usedBy.user = 0;
      usedBy.order = 0;
      usedBy.tracking = 0;
      usedBy.idle = 0;
    }
    if (used >= maxPerMin) return false;
    if (priority === "idle" && usedBy.idle >= idleCap) return false;
    // Whatever the other kinds have not yet used of their reserved share stays free for them.
    let held = 0;
    for (const other of PRIORITIES) if (other !== priority) held += Math.max(0, reserved[other] - usedBy[other]);
    if (used + held >= maxPerMin) return false;
    used += 1;
    usedBy[priority] += 1;
    return true;
  }

  function record(failed: boolean): void {
    const t = now();
    outcomes.push({ at: t, failed });
    if (outcomes.length > 5000 || (outcomes[0] !== undefined && t - outcomes[0].at > WINDOW_MS)) {
      outcomes = outcomes.filter((o) => t - o.at <= WINDOW_MS).slice(-5000);
    }
    lastThree = [...lastThree, failed].slice(-3);
    const recent = outcomes.filter((o) => t - o.at <= WINDOW_MS);
    const failures = recent.filter((o) => o.failed).length;
    if (recent.length >= 10) options.onErrorRate?.(failures / recent.length, recent.length);
  }

  async function call(
    method: "GET" | "POST",
    pathname: string,
    init: { query?: Record<string, string>; body?: unknown; timeoutMs: number; maxBytes: number; priority: Priority },
  ): Promise<UpstreamResult> {
    if (!budget(init.priority)) return { ok: false, kind: "unavailable", status: null, budget: true };
    const url = new URL(pathname, ONECLICK_ORIGIN);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (apiKey !== null) headers["x-api-key"] = apiKey;
    try {
      const res = await fetchImpl(url, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: "error",
        signal: AbortSignal.timeout(init.timeoutMs),
      });
      const text = await readCappedText(res, init.maxBytes);
      let data: unknown;
      let parsed = true;
      try {
        data = JSON.parse(text);
      } catch {
        parsed = false;
      }
      const cid = correlationId(data);
      // 401 means our own key is wrong and 429 that we are calling too fast: both are our problem, not the person's.
      if (res.status >= 500 || res.status === 429 || res.status === 401) {
        record(true);
        log.warn("oneclick_error", { path: pathname, status: res.status, ...cid });
        return { ok: false, kind: "unavailable", status: res.status, ...cid };
      }
      // A 403 or 451 answer to a quote that carries the provider's own error message is a refusal of
      // that quote. Anywhere else, or in any other shape, it means we are being turned away as a
      // caller (by the provider or by something in front of it): a failure, counted and alerted on.
      if (res.status === 403 || res.status === 451) {
        const providerError = typeof data === "object" && data !== null && !Array.isArray(data) && typeof (data as { message?: unknown }).message === "string";
        if (pathname === "/v0/quote" && parsed && providerError) {
          record(false);
          return { ok: false, kind: "rejected", status: res.status, message: "", ...cid };
        }
        record(true);
        log.warn("oneclick_error", { path: pathname, status: res.status, ...cid });
        return { ok: false, kind: "unavailable", status: res.status, ...cid };
      }
      if (!parsed) {
        record(true);
        log.warn("oneclick_error", { path: pathname, status: res.status, kind: "not_json" });
        return { ok: false, kind: "unavailable", status: res.status };
      }
      record(false);
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, data, ...cid };
      const message =
        typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string"
          ? ((data as { message: string }).message).slice(0, 300)
          : "";
      return { ok: false, kind: "rejected", status: res.status, message, ...cid };
    } catch (err) {
      record(true);
      log.warn("oneclick_error", { path: pathname, kind: errorKind(err) });
      return { ok: false, kind: "unavailable", status: null };
    }
  }

  /** Refuses a call that only production may make. Nothing is sent. */
  function refused(what: string): Promise<UpstreamResult> {
    log.error("live_call_refused", { what });
    return Promise.resolve({ ok: false, kind: "unavailable", status: null });
  }

  return {
    tokens: () => call("GET", "/v0/tokens", { timeoutMs: 10_000, maxBytes: 4_000_000, priority: "tracking" }),
    quote: (body, priority = "user") => {
      if (body.dry !== true && !allowLive) return refused("order");
      return call("POST", "/v0/quote", { body, timeoutMs: 15_000, maxBytes: 200_000, priority });
    },
    status: (depositAddress, depositMemo, priority = "tracking") => {
      if (!allowLive) return refused("status");
      return call("GET", "/v0/status", {
        query: depositMemo === null ? { depositAddress } : { depositAddress, depositMemo },
        timeoutMs: 10_000,
        maxBytes: 400_000,
        priority,
      });
    },
    submitDeposit: (body, priority = "user") => {
      if (!allowLive) return refused("deposit");
      return call("POST", "/v0/deposit/submit", { body, timeoutMs: 10_000, maxBytes: 400_000, priority });
    },
    health() {
      const t = now();
      const recent = outcomes.filter((o) => t - o.at <= WINDOW_MS);
      const failures = recent.filter((o) => o.failed).length;
      return {
        degraded: lastThree.length === 3 && lastThree.every(Boolean),
        errorRate: recent.length === 0 ? 0 : failures / recent.length,
        calls: recent.length,
      };
    },
  };
}
