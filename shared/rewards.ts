// The rules for points and weekly rewards, as numbers and as plain functions, in one place. The
// server counts by them, the tools that close a week use them, and the site's pages state them,
// so the three cannot come apart. Every amount is a whole number: US dollars in millionths
// ("micro"), points in millionths, coins in their smallest unit. No floating point anywhere.
//
// Points are counted from the size of a delivered swap and from nothing else: the provider's US
// dollar value of what was paid. No fee, no coin and no route is any part of the sum.

export const REWARDS = {
  /** Points for each US dollar of a delivered swap's value: one point for every 10 cents. */
  pointsPerUsd: 10,
  /** How long a sign-in on the Rewards page lasts, in minutes. */
  sessionMinutes: 30,
  /** How long the one-time code of a sign-in is good for, in minutes. */
  nonceMinutes: 5,
  /** The chain a rewards address is on, and payouts are sent on. */
  chain: "bsc",
  /** The same chain by its number, as a wallet knows it. The sign-in message names it. */
  chainId: 56,
  /** A boost for holders of the token. Off in this version; the place for it is kept. */
  holderBoostBps: 0,
} as const;

/** The coin a payout is sent in: Binance-Peg ZEC on BNB Chain (read from the chain on 9 Oct 2026: symbol ZEC, 18 decimals). */
export const RESERVE_ASSET = {
  chain: "bsc",
  symbol: "ZEC",
  name: "Binance-Peg ZEC",
  decimals: 18,
  contract: "0x1Ba42e5193dfA8B03D15dd1B86a3113bbBEF8Eeb",
  /** The smallest payout that is sent, in the coin's smallest unit (0.0001 ZEC). A smaller share is carried into the next week as points. */
  minPayout: 100_000_000_000_000n,
} as const;

export const MICRO = 1_000_000n;

/** Why a swap that is on the record added no points: the provider gave no dollar value for it. */
export type PointsReason = "no_usd_value";

/** A decimal string of US dollars ("1234.5678") as millionths of a dollar, rounded down. Null for anything that is not a plain decimal. */
export function usdToMicro(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 40 || !/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole = "0", frac = ""] = value.split(".");
  return BigInt(whole) * MICRO + BigInt(frac.slice(0, 6).padEnd(6, "0"));
}

/** Points for a swap's volume (US dollars in millionths), in millionths of a point: ten points to the dollar. */
export function pointsMicro(volumeMicro: bigint): bigint {
  return volumeMicro * BigInt(REWARDS.pointsPerUsd);
}

/** Millionths of a point as text with two decimals, rounded down: 123456789n gives "123.45". */
export function showPoints(micro: bigint): string {
  const hundredths = (micro < 0n ? 0n : micro) / 10_000n;
  const whole = (hundredths / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

/**
 * The points one swap adds when it is delivered, in millionths of a point, from the dollar value a
 * quote gives for what is paid. The same sum the server does for the delivered order. Null when
 * the provider gave no dollar value.
 */
export function swapPointsMicro(amountInUsd: unknown): bigint | null {
  const volume = usdToMicro(amountInUsd);
  return volume === null ? null : pointsMicro(volume);
}

/** Points as they are shown in a small label: two decimals, rounded down, with no noughts at the end. 20000000n gives "20", 250000n gives "0.25". */
export function briefPoints(micro: bigint): string {
  return showPoints(micro).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

const DAY_MS = 86_400_000;

/**
 * The week a moment belongs to, as the ISO week ("2026-W41"): weeks run from Monday 00:00 UTC to
 * Sunday 23:59 UTC, and a week belongs to the year its Thursday is in.
 */
export function weekOf(ms: number): string {
  const day = Math.floor(ms / DAY_MS);
  // 1 January 1970 was a Thursday. Days since the Monday before it:
  const monday = day - ((((day + 3) % 7) + 7) % 7);
  const thursday = new Date((monday + 3) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const firstThursday = Math.floor(Date.UTC(year, 0, 4) / DAY_MS);
  const firstMonday = firstThursday - ((((firstThursday + 3) % 7) + 7) % 7);
  const week = Math.floor((monday - firstMonday) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The first and the last millisecond-exclusive bound of an ISO week: Monday 00:00 UTC, and the Monday after. Null for anything that is not a week. */
export function weekBounds(week: string): { start: number; end: number } | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  if (number < 1 || number > 53) return null;
  const jan4 = Math.floor(Date.UTC(year, 0, 4) / DAY_MS);
  const firstMonday = jan4 - ((((jan4 + 3) % 7) + 7) % 7);
  const start = (firstMonday + (number - 1) * 7) * DAY_MS;
  // A year has 52 or 53 weeks; "W53" of a year that has 52 is not a week.
  if (weekOf(start) !== week) return null;
  return { start, end: start + 7 * DAY_MS };
}

/** The week after one. */
export function nextWeek(week: string): string {
  const bounds = weekBounds(week);
  if (bounds === null) throw new RangeError(`not a week: ${week}`);
  return weekOf(bounds.end);
}

export interface Share {
  address: string;
  points: bigint;
  /** The payout, in the coin's smallest unit. Zero when the share is under the smallest payout that is sent. */
  payout: bigint;
  /** Points carried into the next week, because the share was too small to send. */
  carried: bigint;
}

/**
 * Shares a pool out by points: an address's share is its points out of all the points handed in.
 * Whole-number maths, every share rounded down; what is left stays in the reserve. An address whose share is under the smallest payout gets nothing this week and
 * keeps its points for the next. The result depends only on what is passed in: the same week
 * closed twice gives the same shares, in the same order (by address).
 */
export function sharePool(pool: bigint, points: ReadonlyMap<string, bigint>, minPayout: bigint): { shares: Share[]; paid: bigint; left: bigint; totalPoints: bigint } {
  if (pool < 0n || minPayout < 0n) throw new RangeError("a pool and a smallest payout cannot be negative");
  // In the order of the addresses, read without regard to capitals.
  const key = (address: string) => address.toLowerCase();
  const entries = [...points.entries()].filter(([, value]) => value > 0n).sort(([a], [b]) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const totalPoints = entries.reduce((sum, [, value]) => sum + value, 0n);
  const shares: Share[] = entries.map(([address, value]) => {
    const payout = totalPoints === 0n ? 0n : (pool * value) / totalPoints;
    return payout >= minPayout && payout > 0n ? { address, points: value, payout, carried: 0n } : { address, points: value, payout: 0n, carried: value };
  });
  const paid = shares.reduce((sum, share) => sum + share.payout, 0n);
  return { shares, paid, left: pool - paid, totalPoints };
}

/** What one address is shown of its own points. Nothing here is about any other address. */
export interface RewardsView {
  address: string;
  week: { id: string; start: string; end: string; pointsMicro: string; carriedInMicro: string };
  allTimeMicro: string;
  swaps: { at: string; week: string; from: { symbol: string; chain: string }; to: { symbol: string; chain: string }; pointsMicro: string; reasons: PointsReason[] }[];
  payouts: { week: string; amount: string; asset: string; txs: string[] }[];
}

/** What anyone may see: this week's dates, and of the closed weeks only their totals. No address but the reserve's own. */
export interface RewardsSummary {
  week: { id: string; start: string; end: string };
  weeks: { week: string; asset: string; paid: string; txs: string[] }[];
  totalPaid: string;
  weeksPaid: number;
}

/** What the Rewards page is told about the reserve wallet: its address, the coin, and its balance as read from the chain (null when the chain could not be read). Absent while no reserve is set. */
export interface ReserveView {
  address: string;
  asset: { symbol: string; name: string; decimals: number; contract: string };
  balance: string | null;
}

/** The answer to "what may anyone see": the summary, and the reserve when one is set. */
export interface RewardsPublic extends RewardsSummary {
  reserve: ReserveView | null;
  serverNow: string;
}

/** What a sign-in message is made of: the site's host as the browser knows it, the address in its standard spelling, the one-time code and the two times. */
export interface SignInParts {
  host: string;
  address: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

/** What the sign-in message says it is for. One line, in plain words. */
export const SIGN_IN_STATEMENT = "Sign in to see this address's points. This is not a transaction. It moves nothing, approves nothing and costs no network fee.";

/**
 * The sign-in message a wallet is asked to sign on the Rewards page, and nowhere else. It is laid
 * out as a "Sign-In with Ethereum" message is (EIP-4361): the site that asks, the address, one
 * plain sentence, then the site's address, the chain, a code used once and the two times. A wallet
 * that knows the layout reads which site is asking, and can warn when it is not the site the page
 * is on. Plain words; no transaction.
 */
export function signInMessage(input: SignInParts): string {
  // A page on this machine is served over plain http. Every other host is https.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(input.host);
  return [
    `${input.host} wants you to sign in with your Ethereum account:`,
    input.address,
    "",
    SIGN_IN_STATEMENT,
    "",
    `URI: ${local ? "http" : "https"}://${input.host}`,
    "Version: 1",
    `Chain ID: ${REWARDS.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expiresAt}`,
  ].join("\n");
}

const NONCE_SHAPE = /^[0-9a-f]{32}$/;
const TIME_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * True when a message is, character for character, the sign-in message of this host and this
 * address, made from a code and two times and nothing else. The Rewards page asks this before it
 * opens the wallet: a message that names another site or another address, or that carries a line
 * more than these, is never put in front of a wallet to be signed.
 */
export function isSignInMessage(message: unknown, parts: { host: string; address: string; nonce: unknown; issuedAt: unknown; expiresAt: unknown }): boolean {
  const { nonce, issuedAt, expiresAt } = parts;
  if (typeof nonce !== "string" || !NONCE_SHAPE.test(nonce)) return false;
  if (typeof issuedAt !== "string" || !TIME_SHAPE.test(issuedAt) || typeof expiresAt !== "string" || !TIME_SHAPE.test(expiresAt)) return false;
  return message === signInMessage({ host: parts.host, address: parts.address, nonce, issuedAt, expiresAt });
}
