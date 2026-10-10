// Small HTTP helpers: errors, JSON bodies, security headers.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiErrorBody, ErrorCode, GasLine, QuoteView } from "../shared/api.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail: Record<string, string | number> | undefined;
  readonly quote: QuoteView | undefined;
  /** What is still known of a deleted swap's gas order: goes with "order_deleted" only. */
  readonly gas: GasLine | undefined;
  readonly retryAfter: number | undefined;
  /**
   * True for an outcome that is a normal part of using the product (no route for
   * a pair, an amount under the minimum, a price that moved). These are answered
   * with HTTP 200 and the error in the body, so that an everyday outcome is not
   * reported by the browser as a failed request. `status` still names the kind.
   */
  readonly expected: boolean;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra: { detail?: Record<string, string | number>; quote?: QuoteView; gas?: GasLine; retryAfter?: number; expected?: boolean } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = extra.detail;
    this.quote = extra.quote;
    this.gas = extra.gas;
    this.retryAfter = extra.retryAfter;
    this.expected = extra.expected ?? false;
  }
}

export function errorBody(err: HttpError): ApiErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.detail ? { detail: err.detail } : {}),
      ...(err.quote ? { quote: err.quote } : {}),
      ...(err.gas ? { gas: err.gas } : {}),
    },
  };
}

/**
 * What the wallet window (Reown AppKit) needs from other sites, and no more: each entry says what
 * it is for. Nothing here is for usage reporting: the library's reports go to another address,
 * which stays refused.
 */
export const WALLET_SOURCES = {
  /** The list of wallets and their icons; the WalletConnect relay that carries messages to a phone wallet. */
  connect: ["https://api.web3modal.org", "wss://relay.walletconnect.org"],
  /** WalletConnect's check that lets a phone wallet show which site is asking. */
  frame: ["https://verify.walletconnect.org"],
} as const;

/** Headers sent with every response. */
export function securityHeaders(options: { scriptHashes: readonly string[] }): Record<string, string> {
  const scripts = ["'self'", ...options.scriptHashes.map((h) => `'sha256-${h}'`)].join(" ");
  const csp = [
    "default-src 'none'",
    `script-src ${scripts}`,
    // The wallet window writes its styles into the page as it opens, so inline styles are allowed.
    // Scripts are not: only this site's own files and the one hashed snippet ever run.
    "style-src 'self' 'unsafe-inline'",
    // blob: is how the wallet window shows the wallet icons it has fetched.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${WALLET_SOURCES.connect.join(" ")}`,
    `frame-src ${WALLET_SOURCES.frame.join(" ")}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), browsing-topics=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length),
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
    ...extra,
  });
  res.end(payload);
}

/** Reads a small JSON body. Rejects other content types and anything over the size limit. */
export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "bad_request", "Send JSON.");
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "bad_request", "Request too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      throw new HttpError(413, "bad_request", "Request too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "bad_request", "The request could not be read.");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when the Origin header names the host the request was sent to.
 * Behind a trusted proxy the original host arrives in X-Forwarded-Host.
 */
export function isSameOrigin(req: IncomingMessage, behindProxy: boolean): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (originHost === "") return false;
  if (req.headers.host === originHost) return true;
  const forwarded = req.headers["x-forwarded-host"];
  return behindProxy && typeof forwarded === "string" && forwarded === originHost;
}

/**
 * The path of a request, taken literally: no decoding and no URL resolution,
 * so "//host/x" or "/a/../b" can never be read as something else. Null when
 * the request target is not a plain absolute path.
 */
export function requestPath(req: IncomingMessage): string | null {
  const raw = req.url ?? "";
  const cut = raw.indexOf("?");
  const pathname = cut === -1 ? raw : raw.slice(0, cut);
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.length > 512) return null;
  if (/[\0\\#]/.test(pathname) || pathname.split("/").includes("..")) return null;
  return pathname;
}
