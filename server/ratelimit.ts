// In-memory rate limits. One server instance, so no shared store is needed.

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Fixed-window counter per key, with a cap on tracked keys so it cannot grow without bound. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: Limit;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(limit: Limit, now: () => number = Date.now, maxKeys = 100_000) {
    this.limit = limit;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  /** Counts one request. Returns false when the key is over its limit. */
  take(key: string, cost = 1): boolean {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= t) {
      if (bucket === undefined && this.buckets.size >= this.maxKeys) {
        this.sweep(t);
        // Still full: refuse new keys rather than forget existing limits.
        if (this.buckets.size >= this.maxKeys) return false;
      }
      bucket = { count: 0, resetAt: t + this.limit.windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count + cost > this.limit.max) return false;
    bucket.count += cost;
    return true;
  }

  /**
   * Counts one request, like `take`, and returns a function that gives it back when the thing it
   * was reserved for did not happen. Null when the key is over its limit. Giving back only ever
   * affects the window the request was counted in: once that window has ended it does nothing,
   * so it can never free a place in a later one.
   */
  hold(key: string, cost = 1): (() => void) | null {
    if (!this.take(key, cost)) return null;
    const bucket = this.buckets.get(key);
    let released = false;
    return () => {
      if (released || bucket === undefined) return;
      released = true;
      if (this.buckets.get(key) === bucket && bucket.resetAt > this.now()) bucket.count = Math.max(0, bucket.count - cost);
    };
  }

  /** True when `take` would succeed for this key, without counting anything. */
  has(key: string, cost = 1): boolean {
    return this.remaining(key) >= cost;
  }

  /** Requests left for a key in the current window. */
  remaining(key: string): number {
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= this.now()) return this.limit.max;
    return Math.max(0, this.limit.max - bucket.count);
  }

  /** Seconds until the key's window resets. */
  retryAfter(key: string): number {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000));
  }

  sweep(t: number = this.now()): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= t) this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Every limit in one place. Keys are per IP (IPv6 by /64) unless noted. */
export const LIMITS = {
  /** Everything under /api, per IP. A person using the site makes well under 60 calls a minute. */
  api: { max: 180, windowMs: MINUTE },
  /** Everything under /api, per IPv6 /48: one network cannot pose as thousands of visitors. */
  apiWide: { max: 720, windowMs: MINUTE },
  /** Status requests that skip the region block (the host's health check), all together. */
  statusExempt: { max: 120, windowMs: MINUTE },
  /** Everything under /api except the cheap reads below, all clients together. */
  apiGlobal: { max: 6000, windowMs: MINUTE },
  /**
   * The reads an open page asks for by itself (settings, status, the coin list, an order's state),
   * all clients together. They cost next to nothing, and an order's page asks again every few
   * seconds: counted with everything else, a few hundred open orders would use up the allowance
   * above and shut every route to everyone. Each still has its own limit per address.
   */
  apiReadsGlobal: { max: 30_000, windowMs: MINUTE },
  /**
   * Static files and pages, per IP. One first visit with the coin picker opened is about a hundred
   * small files, and one address can be a whole office or a mobile network, so this is generous:
   * the files are served from memory and cost next to nothing.
   */
  pages: { max: 3000, windowMs: MINUTE },
  /** Price previews, per IP. Typing an amount and the 15-second refresh need about 10 a minute. */
  quote: { max: 30, windowMs: MINUTE },
  /** Price previews, all clients together. The server sets this to the share of the provider call budget that previews can use. */
  quoteGlobal: { max: 150, windowMs: MINUTE },
  orderCreate: { max: 6, windowMs: MINUTE },
  /** Orders created, per IP per day. */
  orderCreateDaily: { max: 30, windowMs: DAY },
  /** Order attempts that got as far as being checked, per IP per day, whether or not they succeeded. */
  orderAttemptDaily: { max: 90, windowMs: DAY },
  /** Real orders asked of the provider, per IP per day. Counted even when the result is then refused. */
  orderLiveDaily: { max: 45, windowMs: DAY },
  /** The same three, per IPv6 /48: one network cannot multiply its allowance by using many addresses. */
  orderCreateDailyWide: { max: 120, windowMs: DAY },
  orderAttemptDailyWide: { max: 360, windowMs: DAY },
  orderLiveDailyWide: { max: 180, windowMs: DAY },
  /** Orders that were asked of the provider and then dropped because the price had moved, per IP. */
  orderPriceMoved: { max: 6, windowMs: HOUR },
  /** Order creation, all clients together. */
  orderCreateGlobal: { max: 120, windowMs: MINUTE },
  /** Orders per receiving address. */
  orderPerRecipient: { max: 10, windowMs: HOUR },
  orderRead: { max: 90, windowMs: MINUTE },
  /**
   * Asking for a sign-in code on the Rewards page: per IP, per wider network (IPv6 /48) and for
   * everyone together. A person asks once. The middle one keeps a single network, which can speak
   * from thousands of addresses, from using up what everyone shares.
   */
  rewardsNonce: { max: 10, windowMs: MINUTE },
  rewardsNonceWide: { max: 40, windowMs: MINUTE },
  rewardsNonceGlobal: { max: 600, windowMs: MINUTE },
  /** Signing in on the Rewards page, per IP. Each attempt costs a signature check. */
  rewardsSignIn: { max: 10, windowMs: MINUTE },
  /** Reading one's own points, per IP. The page asks once on sign-in and again now and then. */
  rewardsRead: { max: 60, windowMs: MINUTE },
  /** Lookups of order IDs that do not exist, per IP. */
  orderMiss: { max: 10, windowMs: MINUTE },
  /**
   * Look-ups of an order by its deposit address, found or not: a person looks for one or two; anything
   * that looks for many is harvesting. Per IP, per wider network (/48), and for all visitors together.
   */
  orderFind: { max: 6, windowMs: MINUTE },
  orderFindDaily: { max: 40, windowMs: DAY },
  orderFindDailyWide: { max: 120, windowMs: DAY },
  // For all visitors together the count is by the hour, not the day: enough addresses to use it up
  // can be found by someone who wants the search switched off, and by the hour that lasts only as
  // long as they keep at it. An order's own link and ID are never affected.
  orderFindGlobal: { max: 250, windowMs: HOUR },
  /** Deposit hashes passed straight on to the provider, all clients together. The server sets this to a tenth of the provider call budget. */
  depositForwardGlobal: { max: 30, windowMs: MINUTE },
  /** Deposit-hash submissions, per order. */
  depositPerOrder: { max: 5, windowMs: MINUTE },
  deposit: { max: 20, windowMs: MINUTE },
  rpc: { max: 120, windowMs: MINUTE },
  rpcGlobal: { max: 3000, windowMs: MINUTE },
  /** Reads of what a connected wallet holds, counted apart from every other read of a chain (see isBalanceBatch). */
  rpcBalances: { max: 240, windowMs: MINUTE },
  rpcBalancesGlobal: { max: 3000, windowMs: MINUTE },
  light: { max: 60, windowMs: MINUTE },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

export type Limiters = Record<LimitName, RateLimiter>;

export function createLimiters(now: () => number = Date.now, overrides: Partial<Record<LimitName, Limit>> = {}): Limiters {
  const out = {} as Limiters;
  for (const name of Object.keys(LIMITS) as LimitName[]) out[name] = new RateLimiter(overrides[name] ?? LIMITS[name], now);
  return out;
}

/** Upper bound on open (unfinished) orders, whatever the provider budget. */
export const MAX_OPEN_ORDERS = 5000;

/**
 * Open orders the server will hold at once, sized to what it can keep tracking:
 * at the slowest cadence each order needs one provider call a minute, so twice
 * the per-minute budget keeps every order checked at least every few minutes
 * even while people are using most of the budget.
 */
export function openOrderCap(providerCallsPerMin: number): number {
  return Math.min(MAX_OPEN_ORDERS, Math.max(10, providerCallsPerMin * 2));
}

/** Most orders one client may have open at once that have not started swapping. */
export const MAX_UNPAID_PER_CLIENT = 10;
/** The same, for one IPv6 /48. */
export const MAX_UNPAID_PER_NETWORK = 40;
/** How many times the deposit hash of one order may be set. */
export const MAX_HASH_SUBMISSIONS = 3;

/** The most of the provider call budget that previews may use. Must match USER_BUDGET_SHARE in oneclick.ts (a test checks it). */
export const PREVIEW_SHARE = 0.4;

/** Limits that depend on configuration. */
export function configuredLimits(providerCallsPerMin: number): Partial<Record<LimitName, Limit>> {
  return {
    // Previews can never use more of the provider budget than this (see RESERVED_SHARE in oneclick.ts),
    // so there is no point in letting more of them through to be refused there.
    quoteGlobal: { max: Math.max(4, Math.floor(providerCallsPerMin * PREVIEW_SHARE)), windowMs: MINUTE },
    depositForwardGlobal: { max: Math.max(2, Math.floor(providerCallsPerMin / 10)), windowMs: MINUTE },
  };
}
