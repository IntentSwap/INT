import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createAlerts } from "../server/alerts.ts";
import { isSameOrigin, requestPath, securityHeaders } from "../server/http.ts";
import { rateKey, resolveClientIp, truncateIp, wideKey } from "../server/ip.ts";
import { ACCESS_LOG_DAYS, ACCESS_LOG_MAX_BYTES_PER_DAY, createAccessLog, createLogger, errorKind, hashId } from "../server/log.ts";
import { readCapped, readCappedText, TooLargeError } from "../server/read.ts";
import { createDiskGuard, DISK_FULL, DISK_THRESHOLD, diskAlert, diskUsage, createSweeper, MAX_FINAL_CHECKS_PER_SWEEP, PROVIDER_ERROR_THRESHOLD, providerErrorAlert, runMaintenance, UNCLEAR_GRACE_MS } from "../server/maintenance.ts";
import { createOneClick, IDLE_BUDGET_SHARE, idleBudget, ONECLICK_ORIGIN, RESERVED_SHARE, USER_BUDGET_SHARE } from "../server/oneclick.ts";
import { buildProvider } from "../server/provider.ts";
import { loadConfig } from "../server/config.ts";
import { deadlineMs } from "../server/quotes.ts";
import { configuredLimits, PREVIEW_SHARE, RateLimiter } from "../server/ratelimit.ts";
import { createRpc, decodeErc20Transfer, decodeTransferLog, parseProxyBody, TRANSFER_TOPIC } from "../server/rpc.ts";
import { createSessionIssuer, SESSION_TTL_MS } from "../server/session.ts";
import { boot } from "../server/boot.ts";
import { firstWords, inlineScriptHashes, loadStaticSite, privateRoutingEdits, withBanner, withCanonical, withPrivateRouting, withRewardsWallet, withSiteUrl } from "../server/static.ts";
import { BANNER_WORDS } from "../shared/banner.ts";
import { POSITIONING } from "../shared/positioning.ts";
import { EXPLORER_HOSTS, explorerTxUrl } from "../shared/chains.ts";
import { eventually } from "./helpers.ts";

const request = (headers: Record<string, string>, remoteAddress = "10.0.0.7") => ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

describe("client address", () => {
  it("uses the socket address when no proxy is trusted", () => {
    expect(resolveClientIp(request({ "x-forwarded-for": "1.2.3.4" }, "203.0.113.9"), 0)).toEqual({ ip: "203.0.113.9", direct: false });
    expect(resolveClientIp(request({}, "::ffff:203.0.113.9"), 0).ip).toBe("203.0.113.9");
  });

  it("takes the entry the trusted proxy added and ignores what the client put in front", () => {
    expect(resolveClientIp(request({ "x-forwarded-for": "203.0.113.9" }), 1).ip).toBe("203.0.113.9");
    expect(resolveClientIp(request({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.9" }), 1).ip).toBe("203.0.113.9");
    expect(resolveClientIp(request({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.1" }), 2).ip).toBe("203.0.113.9");
  });

  it("accepts the host's documented header on its own, at one hop only", () => {
    expect(resolveClientIp(request({ "x-real-ip": "203.0.113.9" }), 1)).toEqual({ ip: "203.0.113.9", direct: false });
    expect(resolveClientIp(request({ "x-real-ip": "203.0.113.9" }), 2)).toEqual({ ip: null, direct: true });
    expect(resolveClientIp(request({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), 1)).toEqual({ ip: "203.0.113.9", direct: false });
  });

  it("treats the address as unknown when the two headers disagree, whichever one was forged", () => {
    // The client forged X-Real-IP and the proxy appended the true address to X-Forwarded-For.
    expect(resolveClientIp(request({ "x-forwarded-for": "6.6.6.6, 203.0.113.9", "x-real-ip": "6.6.6.6" }), 1)).toEqual({ ip: null, direct: false, disagree: true });
    // The client forged X-Forwarded-For, the proxy passed it through and set X-Real-IP itself.
    expect(resolveClientIp(request({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "203.0.113.9" }), 1)).toEqual({ ip: null, direct: false, disagree: true });
    expect(resolveClientIp(request({ "x-forwarded-for": "garbage", "x-real-ip": "203.0.113.9" }), 1).ip).toBeNull();
  });

  it("compares the two headers as addresses, so one IPv6 address written two ways still agrees", () => {
    const same = [
      ["2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001"],
      ["2001:DB8::1", "2001:db8:0:0:0:0:0:1"],
      ["::ffff:203.0.113.9", "203.0.113.9"],
    ] as const;
    for (const [a, b] of same) {
      const resolved = resolveClientIp(request({ "x-forwarded-for": a, "x-real-ip": b }), 1);
      expect(resolved.disagree, `${a} vs ${b}`).toBeUndefined();
      expect(resolved.ip).not.toBeNull();
    }
    expect(resolveClientIp(request({ "x-forwarded-for": "2001:db8::1", "x-real-ip": "2001:db8::2" }), 1).disagree).toBe(true);
  });

  it("gives IPv6 visitors a second, wider key by /48", () => {
    expect(wideKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001::/48");
    expect(wideKey("2001:db8:1:ffff::9")).toBe(wideKey("2001:db8:1:2::1"));
    expect(wideKey("2001:db8:2::1")).not.toBe(wideKey("2001:db8:1::1"));
    expect(wideKey("203.0.113.9")).toBeNull();
    expect(wideKey(null)).toBeNull();
  });

  it("reports a request that skipped the proxy chain", () => {
    expect(resolveClientIp(request({}), 1)).toEqual({ ip: null, direct: true });
    expect(resolveClientIp(request({ "x-forwarded-for": "203.0.113.9" }), 2)).toEqual({ ip: null, direct: true });
  });

  it("rejects garbage", () => {
    expect(resolveClientIp(request({ "x-forwarded-for": "not-an-ip" }), 1).ip).toBeNull();
    expect(resolveClientIp(request({ "x-forwarded-for": "<script>" }), 1).ip).toBeNull();
  });

  it("groups IPv6 by /64 for limits and truncates addresses for logs", () => {
    expect(rateKey("203.0.113.9")).toBe("203.0.113.9");
    expect(rateKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001:0002::/64");
    expect(rateKey("2001:db8:1:2::1")).toBe(rateKey("2001:db8:1:2:ffff::9"));
    expect(rateKey("2001:db8:1:3::1")).not.toBe(rateKey("2001:db8:1:2::1"));
    expect(rateKey(null)).toBe("unknown");
    expect(truncateIp("203.0.113.9")).toBe("203.0.113.0");
    expect(truncateIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001::");
    expect(truncateIp(null)).toBeNull();
  });
});

describe("rate limiter", () => {
  it("allows the limit, refuses the next, and resets after the window", () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 }, () => t);
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, true, false]);
    expect(limiter.take("b")).toBe(true);
    expect(limiter.remaining("a")).toBe(0);
    expect(limiter.retryAfter("a")).toBe(1);
    t = 1001;
    expect(limiter.take("a")).toBe(true);
    expect(limiter.remaining("a")).toBe(2);
  });

  it("gives back what was reserved when the thing it was for did not happen", () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 }, () => 0);
    const first = limiter.hold("a");
    const second = limiter.hold("a");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Full: nothing more can be held.
    expect(limiter.hold("a")).toBeNull();
    first!();
    expect(limiter.remaining("a")).toBe(1);
    // Giving the same one back twice counts once.
    first!();
    expect(limiter.remaining("a")).toBe(1);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  it("never frees a place in a later window when something from an earlier one is given back", () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 }, () => t);
    const early = limiter.hold("a");
    // The window ends, and the next one fills up.
    t = 1500;
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    early!();
    expect(limiter.remaining("a")).toBe(0);
    expect(limiter.take("a")).toBe(false);
    // The same holds when the old window has ended and nothing new has been counted yet.
    const again = limiter.hold("b");
    t = 3000;
    again!();
    expect(limiter.remaining("b")).toBe(2);
  });

  it("counts by cost", () => {
    const limiter = new RateLimiter({ max: 10, windowMs: 1000 }, () => 0);
    expect(limiter.take("a", 10)).toBe(true);
    expect(limiter.take("a", 1)).toBe(false);
    expect(limiter.take("b", 11)).toBe(false);
  });

  it("cannot be made to forget limits by flooding it with new keys", () => {
    let t = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 }, () => t, 100);
    expect(limiter.take("victim")).toBe(true);
    for (let i = 0; i < 500; i++) limiter.take(`flood-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(100);
    expect(limiter.take("victim")).toBe(false);
    t = 2000;
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });
});

describe("session tokens", () => {
  it("verify until they expire", () => {
    const sessions = createSessionIssuer();
    const { token, expiresAt } = sessions.issue(1_700_000_000_000);
    expect(expiresAt).toBe(1_700_000_000_000 + SESSION_TTL_MS);
    expect(sessions.verify(token, 1_700_000_000_000)).toBe(true);
    expect(sessions.verify(token, expiresAt - 1)).toBe(true);
    expect(sessions.verify(token, expiresAt)).toBe(false);
  });

  it("cannot be forged, extended or reused across restarts", () => {
    const sessions = createSessionIssuer();
    const { token } = sessions.issue(1_700_000_000_000);
    const [version, expires, nonce, mac] = token.split(".") as [string, string, string, string];
    expect(sessions.verify(`${version}.${Number(expires) + 60_000}.${nonce}.${mac}`, 1_700_000_000_000)).toBe(false);
    // Change the last character of the signature to a different one.
    const altered = `${mac.slice(0, -1)}${mac.endsWith("A") ? "E" : "A"}`;
    expect(sessions.verify(`${version}.${expires}.${nonce}.${altered}`, 1_700_000_000_000)).toBe(false);
    expect(sessions.verify(`${version}.${expires}.${nonce}x.${mac}`, 1_700_000_000_000)).toBe(false);
    expect(sessions.verify(`v2.${expires}.${nonce}.${mac}`, 1_700_000_000_000)).toBe(false);
    for (const junk of ["", "a.b.c.d", null, undefined, 5, "x".repeat(500), `${token}.extra`]) expect(sessions.verify(junk, 0)).toBe(false);
    expect(createSessionIssuer().verify(token, 1_700_000_000_000)).toBe(false);
  });

  it("issues a different token every time", () => {
    const sessions = createSessionIssuer();
    expect(sessions.issue(1_700_000_000_000).token).not.toBe(sessions.issue(1_700_000_000_000).token);
  });
});

describe("same-origin check", () => {
  it("accepts only the host the request was sent to", () => {
    expect(isSameOrigin(request({ origin: "https://app.example", host: "app.example" }), false)).toBe(true);
    expect(isSameOrigin(request({ origin: "http://localhost:5173", host: "localhost:5173" }), false)).toBe(true);
    expect(isSameOrigin(request({ origin: "https://evil.example", host: "app.example" }), false)).toBe(false);
    expect(isSameOrigin(request({ origin: "https://app.example.evil.example", host: "app.example" }), false)).toBe(false);
    expect(isSameOrigin(request({ origin: "null", host: "app.example" }), false)).toBe(false);
    expect(isSameOrigin(request({ host: "app.example" }), false)).toBe(false);
    expect(isSameOrigin(request({ origin: "not a url", host: "app.example" }), false)).toBe(false);
  });

  it("uses the forwarded host only behind a trusted proxy", () => {
    const req = request({ origin: "https://app.example", host: "internal:8787", "x-forwarded-host": "app.example" });
    expect(isSameOrigin(req, true)).toBe(true);
    expect(isSameOrigin(req, false)).toBe(false);
  });
});

describe("request paths", () => {
  const path_ = (url: string) => requestPath({ url } as IncomingMessage);
  it("takes the path literally and drops the query", () => {
    expect(path_("/")).toBe("/");
    expect(path_("/api/status?x=1&y=2")).toBe("/api/status");
    expect(path_("/order/abc")).toBe("/order/abc");
    expect(path_("/a%2Fb")).toBe("/a%2Fb");
  });
  it("refuses anything that could be read as another host or folder", () => {
    for (const bad of ["", "//evil.example/api/status", "http://evil.example/", "/a/../b", "/..", "/a\\b", "/a\u0000b", "/a#b", `/${"x".repeat(600)}`, "api/status"]) {
      expect(path_(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("security header builder", () => {
  it("is exactly this policy: any change to what the browser may load has to be made here too", () => {
    const headers = securityHeaders({ scriptHashes: ["abc123="] });
    expect(headers["Content-Security-Policy"]).toBe(
      [
        "default-src 'none'",
        "script-src 'self' 'sha256-abc123='",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self' https://api.web3modal.org wss://relay.walletconnect.org",
        "frame-src https://verify.walletconnect.org",
        "manifest-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join("; "),
    );
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("access-control-allow-origin");
  });

  it("never lets a script in loosely, and never names a usage-reporting address", () => {
    const csp = securityHeaders({ scriptHashes: ["abc123="] })["Content-Security-Policy"] ?? "";
    const directive = (name: string) => csp.split("; ").find((part) => part.startsWith(`${name} `)) ?? "";
    for (const loose of ["unsafe-inline", "unsafe-eval", "unsafe-hashes", "*", "http:", "https:", "data:", "blob:"]) expect(directive("script-src"), loose).not.toContain(loose);
    // Inline styles are the one loosening (the wallet window needs them); nothing else is.
    expect(csp.replace("style-src 'self' 'unsafe-inline'", "")).not.toMatch(/unsafe-|\*/);
    expect(csp).not.toMatch(/pulse\.|analytics|sentry|google|coinbase|secure\.walletconnect|rpc\.walletconnect|reown\.com/);
    // Every outside address is a full https or wss origin: no bare schemes, no wildcards, no paths.
    const outside = csp.split(/[; ]+/).filter((word) => word.includes("://"));
    expect(outside.sort()).toEqual(["https://api.web3modal.org", "https://verify.walletconnect.org", "wss://relay.walletconnect.org"]);
  });
});

describe("RPC helpers", () => {
  it("accepts allow-listed read calls only", () => {
    const one = { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: ["0xabc", "latest"] };
    expect(parseProxyBody(one)).toEqual({ batch: false, requests: [{ id: 1, call: { method: "eth_getBalance", params: ["0xabc", "latest"] } }] });
    expect(parseProxyBody([one, one])?.requests).toHaveLength(2);
    expect(parseProxyBody({ ...one, method: "eth_feeHistory", params: ["0x4", "latest", [25, 75]] })).not.toBeNull();
    for (const bad of [
      null,
      [],
      "eth_chainId",
      { ...one, jsonrpc: "1.0" },
      { ...one, method: "eth_sendRawTransaction" },
      { ...one, method: "eth_getLogs" },
      { ...one, method: "eth_subscribe" },
      { ...one, method: 5 },
      { ...one, params: { a: 1 } },
      { ...one, params: [1, 2, 3, 4, 5] },
      { ...one, id: { nested: true } },
      { ...one, id: "x".repeat(100) },
      { ...one, method: "eth_getBlockByNumber", params: ["latest", true] },
      { ...one, method: "eth_feeHistory", params: ["0x400", "latest", []] },
      Array.from({ length: 11 }, () => one),
    ]) {
      expect(parseProxyBody(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });

  it("decodes a plain token transfer and nothing else", () => {
    const to = "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
    const data = `0xa9059cbb${"0".repeat(24)}${to}${(25000000n).toString(16).padStart(64, "0")}`;
    expect(decodeErc20Transfer(data)).toEqual({ to: `0x${to}`, amount: 25000000n });
    expect(decodeErc20Transfer(data.replace("a9059cbb", "095ea7b3"))).toBeNull(); // approve
    expect(decodeErc20Transfer(data.replace("a9059cbb", "23b872dd"))).toBeNull(); // transferFrom
    expect(decodeErc20Transfer(`${data}00`)).toBeNull();
    expect(decodeErc20Transfer(data.slice(0, -2))).toBeNull();
    expect(decodeErc20Transfer(`0xa9059cbb${"1".repeat(24)}${to}${"0".repeat(64)}`)).toBeNull(); // dirty upper bytes
    expect(decodeErc20Transfer("0x")).toBeNull();
    expect(decodeErc20Transfer(null)).toBeNull();
  });

  it("never follows a redirect and hides upstream failures", async () => {
    let init: RequestInit | undefined;
    const rpc = createRpc({
      urls: { bsc: "https://rpc.example/secret", eth: "https://rpc.example/secret", base: "https://rpc.example/secret", arb: "https://rpc.example/secret", sol: "https://rpc.example/secret" },
      fetchImpl: async (_url, options) => {
        init = options;
        return new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted: nope\u0000<b>", data: "0xdead" } }, { jsonrpc: "2.0", id: 0, result: "0x1" }]));
      },
    });
    const results = await rpc.batch("base", [{ method: "eth_chainId", params: [] }, { method: "eth_call", params: [] }]);
    expect(init?.redirect).toBe("error");
    expect(results[0]).toEqual({ ok: true, result: "0x1" });
    // The node's own words are dropped; only the code and the revert data pass.
    expect(results[1]).toEqual({ ok: false, code: 3, message: "execution reverted", data: "0xdead" });
    const down = createRpc({ urls: { bsc: "https://x", eth: "https://x", base: "https://x", arb: "https://x", sol: "https://x" }, fetchImpl: async () => { throw new Error("connect ECONNREFUSED https://rpc.example/secret"); } });
    expect(await down.call("eth", "eth_chainId", [])).toEqual({ ok: false, code: -32603, message: "RPC unavailable" });
  });
});

describe("provider client", () => {
  const log = createLogger(() => {});

  it("talks only to the fixed host, never follows redirects, and sends the key as a header", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createOneClick({
      apiKey: "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc",
      maxPerMin: 100,
      allowLive: true,
      log,
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await client.tokens();
    await client.quote({ dry: true });
    await client.status("0xabc&evil=1#frag", "memo with spaces");
    await client.submitDeposit({ depositAddress: "0xabc", txHash: "0xdef" });
    for (const call of seen) {
      expect(call.url.startsWith(`${ONECLICK_ORIGIN}/v0/`)).toBe(true);
      expect(new URL(call.url).host).toBe("1click.chaindefuser.com");
      expect(call.init?.redirect).toBe("error");
      expect((call.init?.headers as Record<string, string>)["x-api-key"]).toBe("aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc");
      expect(call.url).not.toContain("aaaaaaaaaaaa");
    }
    const status = new URL(seen[2]!.url);
    expect(status.pathname).toBe("/v0/status");
    expect(status.searchParams.get("depositAddress")).toBe("0xabc&evil=1#frag");
    expect(status.searchParams.get("depositMemo")).toBe("memo with spaces");
    expect([...status.searchParams.keys()]).toEqual(["depositAddress", "depositMemo"]);
  });

  it("separates a refusal from an outage and truncates provider text", async () => {
    let next: Response = new Response("{}");
    const client = createOneClick({ apiKey: null, maxPerMin: 100, allowLive: true, log, fetchImpl: async () => next });
    next = new Response(JSON.stringify({ message: "x".repeat(5000) }), { status: 400 });
    const refused = await client.quote({});
    expect(refused).toMatchObject({ ok: false, kind: "rejected", status: 400 });
    expect(refused.ok === false && refused.kind === "rejected" && refused.message.length).toBe(300);
    for (const status of [500, 502, 503, 429, 401]) {
      next = new Response("upstream exploded", { status });
      expect(await client.quote({})).toEqual({ ok: false, kind: "unavailable", status });
    }
    // A 403 or 451 with a readable answer to a quote is a refusal of that quote.
    for (const status of [403, 451]) {
      next = new Response(JSON.stringify({ message: "not permitted" }), { status });
      expect(await client.quote({})).toEqual({ ok: false, kind: "rejected", status, message: "" });
    }
    // Without a readable body, or on any other call, it means we are being turned away as a caller: a failure.
    next = new Response("<html>Forbidden</html>", { status: 403 });
    expect(await client.quote({})).toEqual({ ok: false, kind: "unavailable", status: 403 });
    for (const call of [() => client.status("0xabc", null), () => client.tokens(), () => client.submitDeposit({ depositAddress: "0xabc", txHash: "0x1" })]) {
      next = new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
      expect(await call()).toEqual({ ok: false, kind: "unavailable", status: 403 });
    }
    next = new Response("<html>not json</html>", { status: 200 });
    expect(await client.quote({})).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("passes on the provider's tracing ID for answers and refusals alike", async () => {
    let next: Response = new Response("{}");
    const client = createOneClick({ apiKey: null, maxPerMin: 100, allowLive: true, log, fetchImpl: async () => next });
    const cid = "ed45cc9e-ebea-4ccc-97b3-fb779336a80c";
    next = new Response(JSON.stringify({ correlationId: cid, quote: {} }), { status: 201 });
    expect((await client.quote({})).cid).toBe(cid);
    next = new Response(JSON.stringify({ correlationId: cid, message: "No liquidity available" }), { status: 400 });
    expect((await client.quote({})).cid).toBe(cid);
    next = new Response(JSON.stringify({ correlationId: cid, message: "boom" }), { status: 500 });
    expect((await client.quote({})).cid).toBe(cid);
    next = new Response(JSON.stringify({ correlationId: "<script>alert(1)</script>", message: "x" }), { status: 400 });
    expect((await client.quote({})).cid).toBeUndefined();
  });

  it("reports degraded after three failed calls in a row, and recovers", async () => {
    let fail = true;
    const rates: number[] = [];
    const client = createOneClick({
      apiKey: null,
      maxPerMin: 1000,
      allowLive: true,
      log,
      onErrorRate: (rate) => void rates.push(rate),
      fetchImpl: async () => {
        if (fail) throw new Error("network down");
        return new Response("{}");
      },
    });
    await client.tokens();
    await client.tokens();
    expect(client.health().degraded).toBe(false);
    await client.tokens();
    expect(client.health().degraded).toBe(true);
    fail = false;
    await client.tokens();
    expect(client.health().degraded).toBe(false);
    // A refusal (4xx) is the service working, not failing.
    for (let i = 0; i < 12; i++) await client.tokens();
    expect(rates.length).toBeGreaterThan(0);
    expect(rates.at(-1)).toBeLessThan(0.2);
  });

  it("gives people, unpaid orders and funded orders each their own share of the budget", async () => {
    let t = 0;
    let calls = 0;
    const make = () => createOneClick({ apiKey: null, maxPerMin: 100, allowLive: true, log, now: () => t, fetchImpl: async () => { calls += 1; return new Response("{}"); } });
    const spend = async (client: ReturnType<typeof make>, priority: "user" | "order" | "idle" | "tracking", attempts: number) => {
      const before = calls;
      let refusal: unknown = null;
      for (let i = 0; i < attempts; i++) {
        const result = priority === "user" || priority === "order" ? await client.quote({ dry: true }, priority) : await client.status("0xabc", null, priority);
        if (!result.ok) refusal = result;
      }
      return { served: calls - before, refusal };
    };

    // Previews stop at 40% of the budget, however many arrive: the rest is kept for orders.
    let client = make();
    const people = await spend(client, "user", 500);
    expect(people.served).toBe(40);
    // A spent share is marked as such, so nobody mistakes it for a provider fault.
    expect(people.refusal).toEqual({ ok: false, kind: "unavailable", status: null, budget: true });
    expect(client.health()).toMatchObject({ degraded: false, errorRate: 0 });
    // A new order's real quote still gets through: it has 10% that previews can never touch.
    expect((await spend(client, "order", 500)).served).toBe(10);
    // Unpaid orders stop at 20%, however many there are...
    expect((await spend(client, "idle", 500)).served).toBe(20);
    // ...so even with all three at full stretch, orders with funds in motion still have 30%.
    expect((await spend(client, "tracking", 500)).served).toBe(30);
    expect((await spend(client, "tracking", 1)).refusal).toEqual({ ok: false, kind: "unavailable", status: null, budget: true });

    // Unpaid orders alone can never take more than their share, so previews keep working.
    t += 60_001;
    client = make();
    expect((await spend(client, "idle", 500)).served).toBe(20);
    expect((await spend(client, "user", 500)).served).toBe(40);

    // Orders with funds in motion cannot take everything either: however many there are
    // (or are made to seem), people can still get previews and place orders.
    t += 60_001;
    client = make();
    expect((await spend(client, "tracking", 500)).served).toBe(45);
    expect((await spend(client, "user", 500)).served).toBe(25);
    expect((await spend(client, "order", 500)).served).toBe(10);
    expect((await spend(client, "idle", 500)).served).toBe(20);

    // The part nobody has reserved goes to whichever asks first.
    t += 60_001;
    client = make();
    expect((await spend(client, "order", 500)).served).toBe(25);
    expect((await spend(client, "user", 500)).served).toBe(25);
    expect((await spend(client, "tracking", 500)).served).toBe(30);

    expect(RESERVED_SHARE).toEqual({ user: 0.25, order: 0.1, tracking: 0.3, idle: 0.2 });
    expect(USER_BUDGET_SHARE).toBeCloseTo(0.4, 10);
    expect(IDLE_BUDGET_SHARE).toBe(0.2);
    expect(idleBudget(300)).toBe(60);
    expect(idleBudget(1)).toBe(1);
  });

  it("lets through only as many previews as the provider budget has room for", () => {
    // The limit on previews from all visitors is the most the provider client would serve anyway.
    expect(PREVIEW_SHARE).toBeCloseTo(USER_BUDGET_SHARE, 10);
    expect(configuredLimits(300).quoteGlobal).toEqual({ max: 120, windowMs: 60_000 });
    expect(configuredLimits(10).quoteGlobal).toEqual({ max: 4, windowMs: 60_000 });
    expect(configuredLimits(300).depositForwardGlobal).toEqual({ max: 30, windowMs: 60_000 });
  });

  it("keeps every kind of call possible at the smallest budget the configuration allows", async () => {
    let calls = 0;
    const client = createOneClick({ apiKey: null, maxPerMin: 10, allowLive: true, log, now: () => 0, fetchImpl: async () => { calls += 1; return new Response("{}"); } });
    for (let i = 0; i < 20; i++) await client.status("0xabc", null, "tracking");
    expect(calls).toBe(5);
    for (let i = 0; i < 20; i++) await client.quote({ dry: true }, "user");
    expect(calls).toBe(7);
    for (let i = 0; i < 20; i++) await client.quote({ dry: true }, "order");
    expect(calls).toBe(8);
    for (let i = 0; i < 20; i++) await client.status("0xabc", null, "idle");
    expect(calls).toBe(10);
  });

  it("starts a fresh budget each minute", async () => {
    let t = 0;
    let calls = 0;
    const client = createOneClick({ apiKey: null, maxPerMin: 10, allowLive: true, log, now: () => t, fetchImpl: async () => { calls += 1; return new Response("{}"); } });
    for (let i = 0; i < 20; i++) await client.quote({ dry: true }, "user");
    expect(calls).toBe(4);
    t = 60_001;
    await client.quote({ dry: true }, "user");
    expect(calls).toBe(5);
  });

  it("treats a 403 as a refusal of one quote only when it carries the provider's own error message", async () => {
    let next: Response = new Response("{}");
    const client = createOneClick({ apiKey: null, maxPerMin: 100, allowLive: true, log, fetchImpl: async () => next });
    next = new Response(JSON.stringify({ message: "Recipient is not permitted", correlationId: "abcd1234-ef" }), { status: 403 });
    expect(await client.quote({ dry: true })).toEqual({ ok: false, kind: "rejected", status: 403, message: "", cid: "abcd1234-ef" });
    // A block page or firewall answer in JSON is us being turned away, not this person: a failure.
    for (const body of [{ error: "Forbidden" }, { blocked: true, reason: "ip" }, ["forbidden"], "forbidden", { message: 403 }]) {
      next = new Response(JSON.stringify(body), { status: 403 });
      expect(await client.quote({ dry: true }), JSON.stringify(body)).toMatchObject({ ok: false, kind: "unavailable", status: 403 });
    }
    // Three such answers in a row show up as degraded.
    expect(client.health().degraded).toBe(true);
  });

  it("refuses to create or track a real order unless it was built for production", async () => {
    let calls = 0;
    const lines: string[] = [];
    const client = createOneClick({ apiKey: null, maxPerMin: 100, allowLive: false, log: createLogger((line) => lines.push(line)), fetchImpl: async () => { calls += 1; return new Response("{}", { status: 201 }); } });
    // Previews and the coin list are allowed.
    expect((await client.quote({ dry: true })).ok).toBe(true);
    expect((await client.tokens()).ok).toBe(true);
    expect(calls).toBe(2);
    // Anything else never leaves the process, however it is asked for.
    for (const body of [{ dry: false }, {}, { dry: "true" }, { dry: 1 }, { dry: null }]) {
      expect(await client.quote(body as Record<string, unknown>)).toEqual({ ok: false, kind: "unavailable", status: null });
    }
    expect(await client.status("0xabc", null)).toEqual({ ok: false, kind: "unavailable", status: null });
    expect(await client.submitDeposit({ depositAddress: "0xabc", txHash: "0x1" })).toEqual({ ok: false, kind: "unavailable", status: null });
    expect(calls).toBe(2);
    expect(lines.filter((l) => l.includes("live_call_refused"))).toHaveLength(7);
  });
});

describe("choosing the provider", () => {
  const log = createLogger(() => {});
  const FEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const tokens = JSON.parse(fs.readFileSync(new URL("./fixtures/tokens.json", import.meta.url), "utf8")) as unknown[];
  const setup = (env: Record<string, string>) => {
    const sent: Array<{ path: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const path_ = new URL(String(url)).pathname;
      sent.push({ path: path_, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
      return new Response(JSON.stringify(path_ === "/v0/tokens" ? tokens : { fromRealProvider: true }), { status: path_ === "/v0/quote" ? 201 : 200 });
    };
    return { ...buildProvider({ config: loadConfig(env), log, fetchImpl }), sent };
  };
  const quote = { originAsset: "nep141:base.omft.near", destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", amount: "5000000000000000", slippageTolerance: 100, deadline: new Date(Date.now() + 1_800_000).toISOString(), appFees: [{ recipient: "0x00000000000000000000000000000000000000fe", fee: 40 }] };

  it("production talks to the real provider and may create orders", async () => {
    const p = setup({ NODE_ENV: "production", DATA_DIR: "/data", TRUST_PROXY_HOPS: "1", FEE_RECIPIENT: FEE });
    expect(p.liveOrders).toBe(true);
    expect(p.stub).toBeNull();
    await p.oneclick.quote({ ...quote, dry: false });
    await p.oneclick.status("0xabc", null);
    await p.oneclick.submitDeposit({ depositAddress: "0xabc", txHash: "0x1" });
    expect(p.sent.map((call) => call.path)).toEqual(["/v0/quote", "/v0/status", "/v0/deposit/submit"]);
  });

  it("development without the practice provider can only ask for previews", async () => {
    const p = setup({ NODE_ENV: "development" });
    expect(p.liveOrders).toBe(false);
    expect(p.stub).toBeNull();
    expect((await p.oneclick.quote({ ...quote, dry: true })).ok).toBe(true);
    expect((await p.oneclick.quote({ ...quote, dry: false })).ok).toBe(false);
    expect((await p.oneclick.status("0xabc", null)).ok).toBe(false);
    expect((await p.oneclick.submitDeposit({ depositAddress: "0xabc", txHash: "0x1" })).ok).toBe(false);
    expect(p.sent).toEqual([{ path: "/v0/quote", body: { ...quote, dry: true } }]);
  });

  it("development with the practice provider answers orders locally and sends only previews out", async () => {
    const p = setup({ NODE_ENV: "development", PROVIDER_STUB: "true" });
    expect(p.liveOrders).toBe(true);
    expect(p.stub).not.toBeNull();
    await p.oneclick.tokens();
    expect((await p.oneclick.quote({ ...quote, dry: true })).ok).toBe(true);
    const live = await p.oneclick.quote({ ...quote, dry: false });
    if (!live.ok) throw new Error("expected a practice order");
    const deposit = (live.data as { quote: { depositAddress: string } }).quote.depositAddress;
    expect((await p.oneclick.status(deposit, null)).ok).toBe(true);
    expect((await p.oneclick.submitDeposit({ depositAddress: deposit, txHash: "0x1" })).ok).toBe(true);
    expect(p.sent.map((call) => call.path)).toEqual(["/v0/tokens", "/v0/quote"]);
    expect(p.sent.every((call) => call.body === null || call.body.dry === true)).toBe(true);
  });
});

describe("deadlines", () => {
  it("is 30 minutes for wallet payment, 60 for manual, and 2 hours on slow chains", () => {
    expect(deadlineMs("wallet", "base")).toBe(30 * 60_000);
    expect(deadlineMs("manual", "base")).toBe(60 * 60_000);
    expect(deadlineMs("manual", "sol")).toBe(60 * 60_000);
    for (const chain of ["btc", "ltc", "doge", "bch", "dash", "zec"]) expect(deadlineMs("manual", chain)).toBe(120 * 60_000);
  });
});

describe("explorer links", () => {
  it("are built only from our templates, for plain hashes", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(explorerTxUrl("bsc", hash)).toBe(`https://bscscan.com/tx/${hash}`);
    expect(explorerTxUrl("sol", "5".repeat(88))).toBe(`https://solscan.io/tx/${"5".repeat(88)}`);
    expect(explorerTxUrl("aptos", hash)).toBe(`https://explorer.aptoslabs.com/txn/${hash}?network=mainnet`);
    expect(explorerTxUrl("unknownchain", hash)).toBeNull();
    expect(explorerTxUrl("monad", hash)).toBeNull();
    for (const evil of ["../../evil", "x?redirect=https://evil.example", "javascript:alert(1)", "a b", "<script>", ""]) {
      expect(explorerTxUrl("eth", evil)).toBeNull();
    }
  });

  it("point only to a fixed set of hosts", () => {
    expect(EXPLORER_HOSTS.has("etherscan.io")).toBe(true);
    expect(EXPLORER_HOSTS.has("bscscan.com")).toBe(true);
    for (const host of EXPLORER_HOSTS) expect(host).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
  });
});

describe("logs", () => {
  let dir = "";
  let opened: MockInstance<typeof fs.createWriteStream>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-log-"));
    opened = vi.spyOn(fs, "createWriteStream");
  });
  afterEach(() => {
    opened.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  /**
   * The access log writes its files in the background. This waits until every line handed to it so
   * far is in its file, however long the machine takes over that: each file the log has opened is
   * watched until nothing written to it is still waiting.
   */
  const written = () => eventually(() => opened.mock.results.every((file) => (file.value as fs.WriteStream).writableLength === 0));

  it("writes one JSON line per event", () => {
    const lines: string[] = [];
    const log = createLogger((line) => lines.push(line));
    log.info("listening", { port: 1 });
    log.error("bad", {});
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", event: "listening", port: 1 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ level: "error", event: "bad" });
  });

  it("hashes order IDs and names errors without their messages", () => {
    expect(hashId("A".repeat(27))).toMatch(/^[0-9a-f]{12}$/);
    expect(hashId("A".repeat(27))).toBe(hashId("A".repeat(27)));
    expect(hashId("A".repeat(27))).not.toBe(hashId("B".repeat(27)));
    expect(errorKind(new TypeError("secret detail https://rpc.example/key"))).toBe("TypeError");
    expect(errorKind("text")).toBe("string");
  });

  it("keeps access logs for 14 days and no longer", async () => {
    const day = 86_400_000;
    let now = Date.parse("2026-10-20T10:00:00.000Z");
    for (const date of ["2026-10-01", "2026-10-05", "2026-10-06", "2026-10-19"]) fs.writeFileSync(path.join(dir, `access-${date}.log`), "{}\n");
    fs.writeFileSync(path.join(dir, "unrelated.txt"), "keep");
    const access = createAccessLog(dir, () => now);
    access.write({ route: "status", method: "GET", status: 200, ms: 1, ip: "203.0.113.0", country: "DE" });
    await written(); // the day's file is opened in the background
    access.prune();
    const left = () => fs.readdirSync(dir).sort();
    expect(left()).toEqual(["access-2026-10-06.log", "access-2026-10-19.log", "access-2026-10-20.log", "unrelated.txt"]);
    expect(ACCESS_LOG_DAYS).toBe(14);
    now += 20 * day;
    access.prune();
    expect(left()).toEqual(["unrelated.txt"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("stops a day's access log at a fixed size, so a flood cannot fill the disk the orders live on", async () => {
    let now = Date.parse("2026-10-20T10:00:00.000Z");
    const access = createAccessLog(dir, () => now, 2000);
    const entry = { route: "status", method: "GET", status: 429, ms: 1, ip: "203.0.113.0", country: "DE" };
    for (let i = 0; i < 500; i++) access.write(entry);
    await written();
    const file = path.join(dir, "access-2026-10-20.log");
    const text = fs.readFileSync(file, "utf8");
    expect(text.length).toBeLessThanOrEqual(2000 + 200);
    expect(text.split("\n").filter((l) => l.includes("daily size limit reached"))).toHaveLength(1);
    // The next day starts a fresh file with a fresh allowance.
    now += 86_400_000;
    for (let i = 0; i < 3; i++) access.write(entry);
    await written();
    expect(fs.readFileSync(path.join(dir, "access-2026-10-21.log"), "utf8").trim().split("\n")).toHaveLength(3);
    // A restart on the same day continues from the size already on disk.
    const restarted = createAccessLog(dir, () => now - 86_400_000, 2000);
    for (let i = 0; i < 50; i++) restarted.write(entry);
    await written();
    expect(fs.readFileSync(file, "utf8").length).toBeLessThanOrEqual(2000 + 400);
    expect(ACCESS_LOG_MAX_BYTES_PER_DAY * ACCESS_LOG_DAYS).toBeLessThan(1024 * 1024 * 1024);
  });
});

describe("alerts", () => {
  it("posts to the webhook, throttles repeats, and never throws when delivery fails", async () => {
    let t = 0;
    const posts: Array<{ url: string; body: Record<string, string>; redirect: unknown }> = [];
    const lines: string[] = [];
    const alerts = createAlerts({
      webhookUrl: "https://hooks.example/abc",
      log: createLogger((line) => lines.push(line)),
      now: () => t,
      fetchImpl: async (url, init) => {
        posts.push({ url: String(url), body: JSON.parse(String(init?.body)), redirect: init?.redirect });
        throw new Error("webhook down");
      },
    });
    alerts.send("token_mismatch", "USDC differs", "usdc");
    alerts.send("token_mismatch", "USDC differs", "usdc");
    alerts.send("token_mismatch", "DAI differs", "dai");
    // A verification failure is sent at once; a repeat of the same reason within a minute is not.
    alerts.send("quote_verification", "signature failed", "signature");
    alerts.send("quote_verification", "signature failed", "signature");
    alerts.send("quote_verification", "fees changed", "echo:appFees total");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posts).toHaveLength(4); // two coins, two different verification reasons; both repeats were held back
    // The log has every occurrence, the two held back from the channel included, and marks those two.
    const logged = lines.filter((line) => line.includes('"event":"alert"')).map((line) => JSON.parse(line) as { kind: string; text: string; held?: boolean });
    expect(logged).toHaveLength(6);
    expect(logged.filter((entry) => entry.held === true).map((entry) => entry.text)).toEqual(["USDC differs", "signature failed"]);
    expect(logged.filter((entry) => entry.held === undefined)).toHaveLength(4);
    expect(posts[0]).toMatchObject({ url: "https://hooks.example/abc", redirect: "error" });
    expect(posts[0]!.body.text).toBe("IntentSwap alert (token_mismatch): USDC differs");
    expect(posts[0]!.body.content).toBe(posts[0]!.body.text);
    t = 61 * 60_000;
    alerts.send("token_mismatch", "USDC differs", "usdc");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posts).toHaveLength(5);
    expect(lines.join("\n")).not.toContain("hooks.example");
    expect(lines.some((l) => l.includes("alert_delivery_failed"))).toBe(true);
  });

  it("only logs when no webhook is set", () => {
    const lines: string[] = [];
    let called = false;
    const alerts = createAlerts({ webhookUrl: null, log: createLogger((line) => lines.push(line)), fetchImpl: async () => { called = true; return new Response(""); } });
    alerts.send("disk", "The data volume is 80% full.");
    expect(called).toBe(false);
    expect(lines[0]).toContain("The data volume is 80% full.");
  });
});

describe("site serving", () => {
  let dir = "";
  let server: http.Server;
  let url = "";
  const THEME = "document.documentElement.dataset.theme='dark'";

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-site-"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><head><script>${THEME}</script><script type="module" src="/assets/app-abc123.js"></script></head><body><div id="root"></div>${" ".repeat(600)}</body></html>`);
    fs.writeFileSync(path.join(dir, "assets", "app-abc123.js"), `console.log("app");${"/* pad */".repeat(100)}`);
    fs.writeFileSync(path.join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    fs.mkdirSync(path.join(dir, "coins"));
    fs.mkdirSync(path.join(dir, "chains"));
    fs.writeFileSync(path.join(dir, "coins", "eth.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    fs.writeFileSync(path.join(dir, "chains", "base.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    fs.writeFileSync(path.join(dir, "robots.txt"), "User-agent: *");
    fs.writeFileSync(path.join(dir, "notes.exe"), "should never be served");
    fs.writeFileSync(path.join(dir, "..", `outside-${path.basename(dir)}.txt`), "outside the build folder");
    const site = loadStaticSite(dir)!;
    server = http.createServer((req, res) => {
      const pathname = requestPath(req);
      if (pathname === null) {
        res.writeHead(400);
        res.end();
        return;
      }
      site.handle(req, res, pathname);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(path.join(dir, "..", `outside-${path.basename(dir)}.txt`), { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hashes the inline theme script for the Content-Security-Policy", () => {
    const site = loadStaticSite(dir)!;
    expect(site.scriptHashes).toHaveLength(1);
    expect(inlineScriptHashes(`<script>${THEME}</script>`)).toEqual(site.scriptHashes);
    expect(inlineScriptHashes('<script src="/a.js"></script>')).toEqual([]);
  });

  it("returns null when there is no build", () => {
    expect(loadStaticSite(path.join(dir, "missing"))).toBeNull();
  });

  it("serves the app shell for its own routes", async () => {
    for (const route of ["/", "/track", "/docs", "/docs/fees", "/docs/chains", "/docs/refunds", "/docs/safety", "/docs/ghost-mode", "/docs/rewards", "/docs/faq", "/rewards", "/terms", "/privacy", `/order/${"A".repeat(27)}`]) {
      const res = await fetch(url + route);
      expect(res.status, route).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  it("serves the page of component states only when told test pages exist", async () => {
    // As loaded in beforeEach (the way production loads it): an unknown path.
    const live = await fetch(`${url}/states`);
    expect(live.status).toBe(404);
    expect(live.headers.get("cache-control")).toBe("no-store");
    // Outside production the same path is one of the site's own pages.
    const withTests = loadStaticSite(dir, { testPages: true })!;
    const other = http.createServer((req, res) => void withTests.handle(req, res, requestPath(req) ?? "/"));
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const res = await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/states`);
    expect(res.status).toBe(200);
    other.closeAllConnections();
    await new Promise<void>((resolve) => other.close(() => resolve()));
  });

  it("serves the token's page only once the token has an address", async () => {
    // As loaded in beforeEach: no token yet, so its address is an unknown path like any other.
    const before = await fetch(`${url}/token`);
    expect(before.status).toBe(404);
    expect(before.headers.get("cache-control")).toBe("no-store");
    const withToken = loadStaticSite(dir, { tokenPage: true })!;
    const other = http.createServer((req, res) => void withToken.handle(req, res, requestPath(req) ?? "/"));
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/token`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    // Setting the token does not bring the test pages with it.
    expect((await fetch(`${base}/states`)).status).toBe(404);
    other.closeAllConnections();
    await new Promise<void>((resolve) => other.close(() => resolve()));
  });

  it("writes the share image's full address into the page only when the site's own address is known", async () => {
    const page = '<!doctype html><html><head><title>IntentSwap</title>\n    <meta property="og:image" content="/share.png" />\n<script>var a = 1;</script></head><body><div id="root"></div></body></html>';
    expect(withSiteUrl(page, "https://intentswap.example")).toContain('<meta property="og:image" content="https://intentswap.example/share.png" />');
    expect(withSiteUrl(page, "https://intentswap.example")).toContain('<meta property="og:url" content="https://intentswap.example/" />');
    // Nothing but a plain address is ever written into the page, whoever calls this.
    for (const bad of ['https://exa"mple.org', "https://a$'b.org", "https://a.org/x", "https://a.org?x", "javascript:alert(1)", "https://a.org "]) expect(() => withSiteUrl(page, bad), bad).toThrow();
    // The page is changed in exactly two places and nowhere else.
    expect(withSiteUrl(page, "https://a.org").match(/<script>/g)).toHaveLength(1);
    fs.writeFileSync(path.join(dir, "index.html"), page);
    const served = async (site: NonNullable<ReturnType<typeof loadStaticSite>>) => {
      const other = http.createServer((req, res) => void site.handle(req, res, requestPath(req) ?? "/"));
      await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
      const text = await (await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/`)).text();
      other.closeAllConnections();
      await new Promise<void>((resolve) => other.close(() => resolve()));
      return text;
    };
    // With no address the page is served exactly as built; with one, the image's address is whole.
    const without = loadStaticSite(dir)!;
    const withAddress = loadStaticSite(dir, { siteUrl: "https://intentswap.example" })!;
    expect(await served(without)).toBe(page);
    expect(await served(loadStaticSite(dir, { siteUrl: null })!)).toBe(page);
    // And the page says which address is its own: the home page's here.
    expect(await served(withAddress)).toBe(withCanonical(withSiteUrl(page, "https://intentswap.example"), "https://intentswap.example", "/"));
    expect(await served(withAddress)).toContain('<link rel="canonical" href="https://intentswap.example/" />');
    // Only a plain address of a page, at a plain address of a site, is ever written.
    for (const bad of ["docs", "/docs?x=1", '/"><script>', "/docs/../x", "/a b"]) expect(() => withCanonical(page, "https://a.org", bad), bad).toThrow();
    expect(() => withCanonical(page, 'https://a"b.org', "/docs")).toThrow();
    // The inline script's hash, which the security policy carries, is the same either way.
    expect(withAddress.scriptHashes).toEqual(without.scriptHashes);
    expect(withAddress.scriptHashes).toHaveLength(1);
    // A server with a rewards wallet writes its address into the page, so the Rewards page draws the pool's frame at once; one without writes nothing.
    const wallet = "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83";
    const withWallet = loadStaticSite(dir, { rewardsWallet: wallet })!;
    expect(await served(withWallet)).toBe(withRewardsWallet(page, wallet));
    expect(withRewardsWallet('<!doctype html><html lang="en"><head></head></html>', wallet)).toBe(`<!doctype html><html lang="en" data-rewards-wallet="${wallet}"><head></head></html>`);
    expect(await served(loadStaticSite(dir, { rewardsWallet: null })!)).toBe(page);
    expect(await served(without)).not.toContain("data-rewards-wallet");
    // Only a plain address is ever written.
    for (const bad of ["", "0x1234", `${wallet}"><script>`, "not an address"]) expect(() => withRewardsWallet(page, bad), bad).toThrow();
    expect(withWallet.scriptHashes).toEqual(without.scriptHashes);
  });

  it("writes the service banner into the page when the server has one to show, and only then", () => {
    const page = '<!doctype html><html><head><title>IntentSwap</title></head><body><div id="root"><div class="app first-paint"><!--banner--><div class="header"></div></div></div></body></html>';
    expect(withBanner(page, [])).toBe(page);
    expect(withBanner(page, ["paused"])).toContain(`<div class="banner"><p>${BANNER_WORDS.paused}</p></div><div class="header"></div>`);
    expect(withBanner(page, ["paused", "degraded"])).toContain(`<div class="banner"><p>${BANNER_WORDS.paused}</p><p>${BANNER_WORDS.degraded}</p></div>`);
    // Practice mode has no banner: it is not among the things a banner can say.
    expect(Object.keys(BANNER_WORDS).sort()).toEqual(["degraded", "paused"]);
    // Loaded from disk: no banner unless asked for, and the script hash is the same either way.
    fs.writeFileSync(path.join(dir, "index.html"), page.replace("</head>", "<script>var a = 1;</script></head>"));
    const plain = loadStaticSite(dir)!;
    const paused = loadStaticSite(dir, { banner: ["paused"] })!;
    expect(paused.scriptHashes).toEqual(plain.scriptHashes);
    // The sentences the server writes are the ones the page itself shows.
    const shell = fs.readFileSync(path.resolve("web", "src", "components", "Shell.tsx"), "utf8");
    for (const kind of ["paused", "degraded"]) expect(shell).toContain(`{BANNER_WORDS.${kind}}`);
    expect(shell).not.toMatch(/practice/i);
  });

  // ---- The site's first words, and the one page that exists only where swaps are routed privately ----
  // What the site says follows what the server does. One build holds both sets of words; the server serves the
  // page with the set that is true of it.
  const builtPage = () => fs.readFileSync(path.resolve("web", "index.html"), "utf8");
  const count = (text: string, part: string) => text.split(part).length - 1;
  /** What a browser is sent for an address, by a site loaded with these options. */
  const answer = async (options: Parameters<typeof loadStaticSite>[1], route = "/") => {
    const site = loadStaticSite(dir, options)!;
    const other = http.createServer((req, res) => void site.handle(req, res, requestPath(req) ?? "/"));
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const res = await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}${route}`);
    const body = await res.text();
    other.closeAllConnections();
    await new Promise<void>((resolve) => other.close(() => resolve()));
    return { status: res.status, body, cache: res.headers.get("cache-control"), robots: res.headers.get("x-robots-tag"), hashes: site.scriptHashes };
  };

  it("the page as it is written holds the public first words, each in its place and nowhere else", () => {
    const page = builtPage();
    const places = firstWords("public");
    expect(places.map((place) => place.what)).toEqual(["the mark on the page itself", "the description", "the title", "the title of a link preview", "the description of a link preview", "the share image", "what the share image says", "the headline", "the sentence under the headline"]);
    // If the page's words are ever changed without shared/positioning.ts, this is where it shows: nothing is then served half changed.
    for (const place of places) expect(count(page, place.html), place.what).toBe(1);
    expect(page).toContain(`<title>${POSITIONING.public.title}</title>`);
    expect(page).toContain(`<meta name="description" content="${POSITIONING.public.description}" />`);
    // Two lines: what the site does, then what it is built on.
    expect(page).toContain('<span class="headline-line"><span class="headline-word" style="--i: 0">Swap</span> <span class="headline-word" style="--i: 1">anything.</span></span> <span class="headline-line"><span class="headline-word headline-accent" style="--i: 2">On</span>');
    // The page as written says nothing of private swaps and carries no mark.
    expect(page).not.toMatch(/\bprivate|confidential|data-routing/i);
  });

  it("where swaps are routed privately, writes the private first words into the page: the headline, the title, and what a link preview shows", () => {
    const page = builtPage();
    const served = withPrivateRouting(page);
    const edits = privateRoutingEdits();
    // Every place that holds the first words is changed but the sentence under the headline, which is the same in both sets.
    expect(edits.map((edit) => edit.what)).toEqual(firstWords("public").map((place) => place.what).filter((what) => what !== "the sentence under the headline"));
    for (const edit of edits) {
      expect(count(page, edit.from), edit.what).toBe(1);
      expect(count(served, edit.from), edit.what).toBe(0);
      expect(count(served, edit.to), edit.what).toBe(1);
    }
    for (const place of firstWords("private")) expect(count(served, place.html), place.what).toBe(1);
    // Word for word.
    expect(served).toContain('<html lang="en" data-routing="private">');
    expect(served).toContain("<title>IntentSwap: private swaps, across chains</title>");
    expect(served).toContain('<meta name="description" content="Private swaps, across chains. Built on NEAR Intents." />');
    expect(served).toContain('<meta property="og:title" content="IntentSwap: private swaps, across chains" />');
    expect(served).toContain('<meta property="og:description" content="Private swaps, across chains. Built on NEAR Intents." />');
    expect(served).toContain('<meta property="og:image" content="/share-private.png" />');
    expect(served).toContain('<meta property="og:image:alt" content="IntentSwap. Private swaps, across chains. Built on NEAR Intents." />');
    expect(served).toContain(
      '<p class="headline-title"><span class="headline-line"><span class="headline-word" style="--i: 0">Private</span> <span class="headline-word" style="--i: 1">swaps,</span> <span class="headline-word" style="--i: 2">across</span> <span class="headline-word" style="--i: 3">chains.</span></span> <span class="headline-line"><span class="headline-word headline-accent" style="--i: 4">Built</span> <span class="headline-word headline-accent" style="--i: 5">on</span> <span class="headline-word headline-accent" style="--i: 6">NEAR</span> <span class="headline-word headline-accent" style="--i: 7">Intents.</span></span></p>',
    );
    expect(served).toContain('<p class="headline-sub muted">One coin in, another out, across chains. Every fee is shown before you confirm.</p>');
    // Nothing of the public set is left, and nothing else in the page is touched: the same lines, and the same script.
    for (const gone of ["Swap anything", "Swap any coin to any coin", 'content="/share.png"', "<title>IntentSwap</title>", '<html lang="en">']) expect(served, gone).not.toContain(gone);
    const [before, after] = [page.split("\n"), served.split("\n")];
    expect(after).toHaveLength(before.length);
    expect(before.filter((line, index) => line !== after[index])).toHaveLength(edits.length);
    expect(inlineScriptHashes(served)).toEqual(inlineScriptHashes(page));
    // Done twice, it changes nothing more; and a page without those places is left as it is.
    expect(withPrivateRouting(served)).toBe(served);
    expect(withPrivateRouting("<!doctype html><title>Something else</title>")).toBe("<!doctype html><title>Something else</title>");
  });

  it("serves the page exactly as built where swaps are routed in public, and with the private words where they are routed privately", async () => {
    const page = builtPage();
    fs.writeFileSync(path.join(dir, "index.html"), page);
    // Routed in public, or told nothing: byte for byte the page as built.
    const told = await answer({ privateRouting: false });
    expect(told.body).toBe(page);
    expect((await answer({})).body).toBe(page);
    expect((await answer(undefined)).body).toBe(page);
    // Routed privately: the private words and the mark, from the first byte, on every address that is a page of the site.
    const privately = await answer({ privateRouting: true });
    expect(privately.body).toBe(withPrivateRouting(page));
    expect(privately.body).toContain('<html lang="en" data-routing="private">');
    expect(privately.body).toContain("<title>IntentSwap: private swaps, across chains</title>");
    expect((await answer({ privateRouting: true }, "/docs")).body).toBe(privately.body);
    // The inline script's hash, which the security policy carries, is the same either way.
    expect(privately.hashes).toEqual(told.hashes);
    expect(privately.hashes).toHaveLength(1);
    // With the site's own address known, the share image's full address names the private image; in public it names the one it always did.
    const withAddress = await answer({ privateRouting: true, siteUrl: "https://intentswap.example" });
    expect(withAddress.body).toContain('<meta property="og:image" content="https://intentswap.example/share-private.png" />');
    expect(withAddress.body).toContain('<meta property="og:url" content="https://intentswap.example/" />');
    expect(withAddress.body).not.toContain("/share.png");
    expect((await answer({ siteUrl: "https://intentswap.example" })).body).toContain('<meta property="og:image" content="https://intentswap.example/share.png" />');
    expect((await answer({ siteUrl: "https://intentswap.example" })).body).toBe(withCanonical(withSiteUrl(page, "https://intentswap.example"), "https://intentswap.example", "/"));
    // Each page that may be indexed names its own address; an order's page and an unknown address name none, and neither does a site that knows no address of its own.
    for (const address of ["/docs", "/track", "/rewards", "/terms", "/privacy", "/docs/fees"]) expect((await answer({ siteUrl: "https://intentswap.example" }, address)).body, address).toContain(`<link rel="canonical" href="https://intentswap.example${address}" />`);
    expect((await answer({ siteUrl: "https://intentswap.example" }, "/docs")).body.match(/rel="canonical"/g)).toHaveLength(1);
    for (const address of [`/order/${"A".repeat(27)}`, "/nowhere", "/docs/private"]) expect((await answer({ siteUrl: "https://intentswap.example" }, address)).body, address).not.toContain('rel="canonical"');
    expect((await answer({}, "/docs")).body).not.toContain('rel="canonical"');
    // The banner is written into either page alike.
    expect((await answer({ privateRouting: true, banner: ["paused"] })).body).toBe(withBanner(withPrivateRouting(page), ["paused"]));
  });

  it("serves the page on private routing only where swaps are routed privately", async () => {
    // As loaded in beforeEach (told nothing of routing), and told that swaps are routed in public: an unknown path like any other.
    const before = await fetch(`${url}/docs/private`);
    expect(before.status).toBe(404);
    expect(before.headers.get("cache-control")).toBe("no-store");
    expect(before.headers.get("x-robots-tag")).toBe("noindex");
    expect(await answer({ privateRouting: false }, "/docs/private")).toMatchObject({ status: 404, cache: "no-store", robots: "noindex" });
    // Not even with everything else switched on.
    expect((await answer({ testPages: true, tokenPage: true, siteUrl: "https://intentswap.example", banner: ["paused"] }, "/docs/private")).status).toBe(404);
    // Routed privately: one of the site's own pages.
    const page = await answer({ privateRouting: true }, "/docs/private");
    expect(page).toMatchObject({ status: 200, cache: "no-cache", robots: null });
    expect(page.body).toContain('<div id="root">');
    // Its address is exact, and it brings no other page with it.
    for (const near of ["/docs/private/", "/docs/Private", "/docs/private/more", "/docs/privately", "/private", "/states", "/token"]) expect((await answer({ privateRouting: true }, near)).status, near).toBe(404);
    // Every other page of the documentation is there either way, the page on Ghost mode among them.
    for (const privateRouting of [false, true]) for (const route of ["/docs", "/docs/fees", "/docs/chains", "/docs/refunds", "/docs/safety", "/docs/ghost-mode", "/docs/rewards", "/docs/faq"]) expect((await answer({ privateRouting }, route)).status, route).toBe(200);
    // Its address is exact too.
    for (const privateRouting of [false, true]) for (const near of ["/docs/ghost", "/docs/ghost-mode/", "/docs/Ghost-mode", "/docs/ghost-modes", "/ghost-mode"]) expect((await answer({ privateRouting }, near)).status, near).toBe(404);
  });

  it("the server tells the site which it is: the page it serves and the settings it gives agree", async () => {
    fs.mkdirSync(path.join(dir, "site"));
    fs.writeFileSync(path.join(dir, "site", "index.html"), builtPage());
    const started: { stop(): Promise<void> }[] = [];
    const serve = async (env: Record<string, string>) => {
      const booted = boot({
        env: { NODE_ENV: "development", DATA_DIR: fs.mkdtempSync(path.join(dir, "data-")), ...env },
        log: createLogger(() => {}),
        fetchImpl: async () => {
          throw new Error("unreachable in tests");
        },
        siteDir: path.join(dir, "site"),
      });
      // Only the pages are asked for here, so none of the server's background work is started.
      await new Promise<void>((resolve) => booted.server.listen(0, "127.0.0.1", resolve));
      started.push({
        stop: () =>
          new Promise<void>((resolve) => {
            booted.server.closeAllConnections();
            booted.server.close(() => resolve());
          }),
      });
      const base = `http://127.0.0.1:${(booted.server.address() as AddressInfo).port}`;
      const home = await fetch(`${base}/`);
      return { mode: booted.config.privacyMode, home: await home.text(), doc: (await fetch(`${base}/docs/private`)).status };
    };
    try {
      // Private routing asked for: the private words, the mark, and the page that explains it.
      const privately = await serve({ PRIVACY_MODE: "basic" });
      expect(privately.mode).toBe("basic");
      expect(privately.home).toContain('<html lang="en" data-routing="private">');
      expect(privately.home).toContain("<title>IntentSwap: private swaps, across chains</title>");
      expect(privately.doc).toBe(200);
      // Public routing, by name or because nothing was said and there is no partner key: the page as built, and no such page.
      for (const env of [{ PRIVACY_MODE: "public" }, {}] as Record<string, string>[]) {
        const inPublic = await serve(env);
        expect(inPublic.mode, JSON.stringify(env)).toBe("public");
        expect(inPublic.home, JSON.stringify(env)).not.toMatch(/data-routing|\bprivate\b/i);
        expect(inPublic.home, JSON.stringify(env)).toContain("<title>IntentSwap</title>");
        expect(inPublic.doc, JSON.stringify(env)).toBe(404);
      }
    } finally {
      await Promise.all(started.map((server) => server.stop()));
    }
  });

  it("never caches or indexes order pages", async () => {
    const res = await fetch(`${url}/order/${"A".repeat(27)}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const home = await fetch(`${url}/`);
    expect(home.headers.get("cache-control")).toBe("no-cache");
    expect(home.headers.get("x-robots-tag")).toBeNull();
  });

  it("answers unknown paths with the shell and a 404", async () => {
    // ("/docs/private" among them: as loaded here, the site has been told nothing of private routing, and that page exists only where it is in force.)
    for (const route of ["/nope", "/assets/missing.js", "/order", "/order/a/b", "/index.html/x", "/.env", "/package.json", "/docs/", "/docs/nothing", "/docs/fees/more", "/docs/FEES", "/docs/private"]) {
      const res = await fetch(url + route);
      expect(res.status, route).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("serves hashed assets with long caching and compression", async () => {
    const res = await fetch(`${url}/assets/app-abc123.js`, { headers: { "accept-encoding": "br" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await res.text()).toContain('console.log("app")');
    const etag = res.headers.get("etag")!;
    expect((await fetch(`${url}/assets/app-abc123.js`, { headers: { "if-none-match": etag } })).status).toBe(304);
  });

  it("lets a browser keep icons for a day, and asks again each time for everything else that has no fingerprint in its name", async () => {
    // Opening the coin picker shows dozens of icons; without this each one would be asked about every time.
    for (const file of ["/coins/eth.svg", "/chains/base.svg", "/favicon.svg"]) {
      const res = await fetch(url + file);
      expect(res.status, file).toBe(200);
      expect(res.headers.get("cache-control"), file).toBe("public, max-age=86400");
    }
    expect((await fetch(`${url}/robots.txt`)).headers.get("cache-control")).toBe("no-cache");
  });

  it("cannot be walked out of the build folder", async () => {
    const outside = `outside-${path.basename(dir)}.txt`;
    const get = (raw: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(`${url}${raw}`, { path: raw }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });
    for (const raw of [`/../${outside}`, `/%2e%2e/${outside}`, `/assets/../../${outside}`, `/..%2f${outside}`, `//${outside}`, "/notes.exe"]) {
      const res = await get(raw);
      expect(res.body, raw).not.toContain("outside the build folder");
      expect(res.body, raw).not.toContain("should never be served");
      expect([400, 404], raw).toContain(res.status);
    }
  });

  it("answers HEAD without a body and refuses other methods", async () => {
    const head = await fetch(`${url}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await fetch(`${url}/`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${url}/`, { method: "DELETE" })).status).toBe(405);
  });
});

describe("reading replies from outside services", () => {
  const stream = (chunks: number, size: number, headers: Record<string, string> = {}) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < chunks; i++) controller.enqueue(new Uint8Array(size).fill(97));
          controller.close();
        },
      }),
      { headers },
    );

  it("returns a body within the cap", async () => {
    expect(await readCappedText(new Response("hello"), 10)).toBe("hello");
    expect((await readCapped(stream(4, 250), 1000)).length).toBe(1000);
    expect(await readCappedText(new Response(null), 10)).toBe("");
  });

  it("stops at the cap instead of buffering an endless or oversized reply", async () => {
    await expect(readCapped(stream(5, 250), 1000)).rejects.toBeInstanceOf(TooLargeError);
    // A declared size over the cap is refused without reading anything.
    await expect(readCapped(stream(1, 10, { "content-length": "5000" }), 1000)).rejects.toBeInstanceOf(TooLargeError);
    // An endless stream is cut off as soon as it passes the cap.
    let produced = 0;
    const endless = new Response(
      new ReadableStream({
        pull(controller) {
          produced += 1;
          controller.enqueue(new Uint8Array(1024));
        },
      }),
    );
    await expect(readCapped(endless, 10 * 1024)).rejects.toBeInstanceOf(TooLargeError);
    expect(produced).toBeLessThan(40);
  });

  it("is what the provider and RPC clients use", async () => {
    const big = () => stream(50, 100_000);
    const client = createOneClick({ apiKey: null, maxPerMin: 100, allowLive: true, log: createLogger(() => {}), fetchImpl: async () => big() });
    expect(await client.quote({ dry: true })).toEqual({ ok: false, kind: "unavailable", status: null });
    const rpc = createRpc({ urls: { bsc: "https://x", eth: "https://x", base: "https://x", arb: "https://x", sol: "https://x" }, fetchImpl: async () => big() });
    expect(await rpc.call("eth", "eth_chainId", [])).toEqual({ ok: false, code: -32603, message: "RPC unavailable" });
  });
});

describe("token transfer events", () => {
  const topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const word = (hex40: string) => `0x${"0".repeat(24)}${hex40}`;
  const log = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", topics: [topic, word("11".repeat(20)), word("22".repeat(20))], data: `0x${(25000000n).toString(16).padStart(64, "0")}` };

  it("are decoded from a receipt log", () => {
    expect(decodeTransferLog(log)).toEqual({ token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", from: `0x${"11".repeat(20)}`, to: `0x${"22".repeat(20)}`, amount: 25000000n });
    expect(TRANSFER_TOPIC).toBe(topic);
  });

  it("are refused when anything about them is off", () => {
    for (const bad of [
      null,
      "log",
      { ...log, address: "0x1234" },
      { ...log, topics: [topic] },
      { ...log, topics: [topic, log.topics[1], log.topics[2], log.topics[2]] }, // an NFT transfer has four topics
      { ...log, topics: ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", log.topics[1], log.topics[2]] }, // Approval
      { ...log, topics: [topic, `0x${"1".repeat(64)}`, log.topics[2]] },
      { ...log, data: "0x" },
      { ...log, data: `0x${"0".repeat(128)}` },
      { ...log, topics: "none" },
    ]) {
      expect(decodeTransferLog(bad), JSON.stringify(bad)?.slice(0, 70)).toBeNull();
    }
  });
});

describe("upkeep and alert thresholds", () => {
  const collect = () => {
    const sent: Array<{ kind: string; text: string }> = [];
    return { sent, alerts: { send: (kind: string, text: string) => void sent.push({ kind, text }) } };
  };

  it("alerts when more than 20% of provider calls failed, and not at or below that", () => {
    const { sent, alerts } = collect();
    expect(providerErrorAlert(alerts, 0.2, 50)).toBe(false);
    expect(providerErrorAlert(alerts, 0.1999, 50)).toBe(false);
    expect(providerErrorAlert(alerts, 0, 50)).toBe(false);
    expect(providerErrorAlert(alerts, Number.NaN, 50)).toBe(false);
    expect(sent).toHaveLength(0);
    expect(providerErrorAlert(alerts, 0.21, 50)).toBe(true);
    expect(providerErrorAlert(alerts, 1, 12)).toBe(true);
    expect(sent).toEqual([
      { kind: "oneclick_errors", text: "21% of 50 calls to the swap provider failed in the last 5 minutes." },
      { kind: "oneclick_errors", text: "100% of 12 calls to the swap provider failed in the last 5 minutes." },
    ]);
    expect(PROVIDER_ERROR_THRESHOLD).toBe(0.2);
  });

  it("alerts when the data volume is more than 70% full", () => {
    const { sent, alerts } = collect();
    expect(diskUsage({ blocks: 1000, bavail: 300 })).toBeCloseTo(0.7, 10);
    expect(diskUsage({ blocks: 1000n, bavail: 250n })).toBeCloseTo(0.75, 10);
    expect(diskUsage({ blocks: 0, bavail: 0 })).toBeNull();
    expect(diskAlert(alerts, 0.7)).toBe(false);
    expect(diskAlert(alerts, 0.5)).toBe(false);
    expect(diskAlert(alerts, null)).toBe(false);
    expect(sent).toHaveLength(0);
    expect(diskAlert(alerts, 0.71)).toBe(true);
    expect(sent).toEqual([{ kind: "disk", text: "The data volume is 71% full." }]);
    expect(DISK_THRESHOLD).toBe(0.7);
  });

  it("prunes logs and limits, and checks the disk in one pass, without ever throwing", () => {
    const { sent, alerts } = collect();
    const done: string[] = [];
    const lines: string[] = [];
    const parts = {
      accessLog: { write() {}, prune: () => void done.push("prune") },
      limiters: { api: { sweep: () => void done.push("limits") } } as never,
      dataDir: "data",
      alerts,
      log: createLogger((line) => lines.push(line)),
    };
    expect(runMaintenance({ ...parts, statfs: () => ({ blocks: 100, bavail: 10 }) })).toBeCloseTo(0.9, 10);
    expect(done).toEqual(["prune", "limits"]);
    expect(sent).toEqual([{ kind: "disk", text: "The data volume is 90% full." }]);
    let used: number | null = 0;
    expect(() => {
      used = runMaintenance({
        ...parts,
        statfs: () => {
          throw new Error("no such volume");
        },
      });
    }).not.toThrow();
    expect(used).toBeNull();
    expect(lines.some((l) => l.includes("disk_check_failed"))).toBe(true);
  });

  it("still measures the disk when the rest of the upkeep fails", () => {
    const { sent, alerts } = collect();
    const lines: string[] = [];
    const used = runMaintenance({
      accessLog: {
        write() {},
        prune: () => {
          throw new Error("logs folder unreadable");
        },
      },
      limiters: {} as never,
      dataDir: "data",
      alerts,
      log: createLogger((line) => lines.push(line)),
      statfs: () => ({ blocks: 100, bavail: 3 }),
    });
    expect(used).toBeCloseTo(0.97, 10);
    expect(sent).toEqual([{ kind: "disk", text: "The data volume is 97% full." }]);
    expect(lines.some((l) => l.includes("maintenance_failed"))).toBe(true);
  });

  describe("deleting old order records", () => {
    const DAY = 86_400_000;
    // A record with only what the sweeper looks at. `finishedAt` decides when it became due.
    const order = (id: string, status: string, dueSince = 0) => ({ id, deadline: new Date(0).toISOString(), state: { status, depositTxHash: "0xabc", finishedAt: new Date(dueSince - 30 * DAY).toISOString() } }) as never;
    const setup = (records: unknown[], verdicts: Record<string, "gone" | "changed" | "unclear" | "outage">, clock = { t: 0 }) => {
      const removed: string[] = [];
      const asked: string[] = [];
      const lines: string[] = [];
      const left = () => (records as Array<{ id: string }>).filter((r) => !removed.includes(r.id));
      const run = createSweeper({
        store: { deletable: () => left(), remove: (id: string) => void removed.push(id) } as never,
        poller: { finalCheck: async (id: string) => (asked.push(id), verdicts[id] ?? "outage") },
        log: createLogger((line) => lines.push(line)),
        now: () => clock.t,
      });
      return { removed, asked, lines, run, clock };
    };

    it("deletes at once what the provider itself declared finished, and asks about everything else first", async () => {
      const s = setup([order("delivered", "delivered"), order("refunded", "refunded"), order("failed", "failed"), order("expired", "expired"), order("stopped", "waiting")], { expired: "gone", stopped: "gone" });
      expect(await s.run()).toBe(5);
      expect(s.asked).toEqual(["expired", "stopped"]);
      expect(s.removed).toEqual(["delivered", "refunded", "failed", "expired", "stopped"]);
    });

    it("keeps an order when the last check finds that something happened after all", async () => {
      const s = setup([order("late", "expired"), order("quiet", "expired")], { late: "changed", quiet: "gone" });
      expect(await s.run()).toBe(1);
      expect(s.removed).toEqual(["quiet"]);
      expect(s.lines.some((l) => l.includes("orders_swept") && l.includes('"removed":1') && l.includes('"kept":1'))).toBe(true);
    });

    it("is not held up by a record the provider gives no clear answer about", async () => {
      const s = setup([order("odd", "expired"), order("b", "expired"), order("c", "expired")], { odd: "unclear", b: "gone", c: "gone" });
      expect(await s.run()).toBe(2);
      expect(s.asked).toEqual(["odd", "b", "c"]);
      expect(s.removed).toEqual(["b", "c"]);
      // It is asked about again next round, and kept while the answer stays unclear.
      expect(await s.run()).toBe(0);
      expect(s.asked).toEqual(["odd", "b", "c", "odd"]);
    });

    it("deletes a record that is still unclear a week past its date, and says so in the log", async () => {
      const clock = { t: UNCLEAR_GRACE_MS - 1000 };
      const s = setup([order("odd", "expired")], { odd: "unclear" }, clock);
      expect(await s.run()).toBe(0);
      clock.t = UNCLEAR_GRACE_MS + 1000;
      expect(await s.run()).toBe(1);
      expect(s.removed).toEqual(["odd"]);
      expect(s.lines.some((l) => l.includes("orders_swept") && l.includes('"forced":1'))).toBe(true);
    });

    it("stops asking for the round when the provider cannot be reached, and deletes nothing it could not ask about", async () => {
      const s = setup([order("a", "expired"), order("b", "expired"), order("done", "delivered")], { a: "outage", b: "gone" });
      expect(await s.run()).toBe(1);
      expect(s.asked).toEqual(["a"]);
      expect(s.removed).toEqual(["done"]);
    });

    it("asks about a limited number in one round, and takes the rest in turn in later rounds", async () => {
      const many = Array.from({ length: MAX_FINAL_CHECKS_PER_SWEEP + 20 }, (_, i) => order(`o${i}`, "expired"));
      const clock = { t: 1000 };
      const s = setup(many, Object.fromEntries(many.map((_, i) => [`o${i}`, "unclear" as const])), clock);
      expect(await s.run()).toBe(0);
      expect(s.asked).toHaveLength(MAX_FINAL_CHECKS_PER_SWEEP);
      // Next round starts with those not asked yet, so none is passed over for ever.
      clock.t = 2000;
      await s.run();
      expect(new Set(s.asked).size).toBe(MAX_FINAL_CHECKS_PER_SWEEP + 20);
    });

    it("never throws, and never runs twice at once", async () => {
      const lines: string[] = [];
      const broken = createSweeper({
        store: {
          deletable: () => {
            throw new Error("orders folder unreadable");
          },
        } as never,
        poller: { finalCheck: async () => "gone" },
        log: createLogger((line) => lines.push(line)),
        now: () => 0,
      });
      await expect(broken()).resolves.toBe(0);
      expect(lines.some((l) => l.includes("sweep_failed"))).toBe(true);

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let asked = 0;
      const slow = createSweeper({
        store: { deletable: () => [order("a", "expired")], remove() {} } as never,
        poller: {
          finalCheck: async () => {
            asked += 1;
            await gate;
            return "gone";
          },
        },
        log: createLogger(() => {}),
        now: () => 0,
      });
      const first = slow();
      const second = slow();
      release();
      await Promise.all([first, second]);
      expect(asked).toBe(1);
    });
  });

  it("keeps refusing orders on a full disk when a later reading fails", () => {
    const guard = createDiskGuard();
    expect(guard.full()).toBe(false);
    guard.record(null);
    expect(guard.full()).toBe(false);
    guard.record(0.95);
    expect(guard.full()).toBe(false); // the limit is "more than 95%"
    guard.record(0.951);
    expect(guard.full()).toBe(true);
    guard.record(null); // a failed reading changes nothing
    expect(guard.full()).toBe(true);
    expect(guard.used()).toBeCloseTo(0.951, 10);
    guard.record(0.4);
    expect(guard.full()).toBe(false);
    expect(DISK_FULL).toBe(0.95);
  });
});

describe("practice addresses", () => {
  it("are well-formed on every chain, so a practice order passes the same checks as a real one", async () => {
    const { practiceAddress } = await import("../server/stub-provider.ts");
    const { checkAddress } = await import("../shared/addresses.ts");
    const { CHAINS } = await import("../shared/chains.ts");
    for (const chain of CHAINS.keys()) {
      for (let i = 0; i < 5; i++) {
        const address = practiceAddress(chain);
        expect(checkAddress(chain, address).ok, `${chain} ${address}`).toBe(true);
      }
    }
    expect(practiceAddress("eth")).not.toBe(practiceAddress("eth"));
  });
});

describe("practice provider", () => {
  it("uses the real provider for read-only previews and never for a real order", async () => {
    const { createStubProvider } = await import("../server/stub-provider.ts");
    const upstreamCalls: Array<Record<string, unknown>> = [];
    const tokens = JSON.parse(fs.readFileSync(new URL("./fixtures/tokens.json", import.meta.url), "utf8")) as unknown[];
    const upstream = {
      tokens: async () => ({ ok: true as const, status: 200, data: tokens }),
      quote: async (body: Record<string, unknown>) => {
        upstreamCalls.push(body);
        return { ok: true as const, status: 201, data: { from: "upstream" } };
      },
      status: async () => {
        throw new Error("the practice provider must not ask the real provider for a status");
      },
      submitDeposit: async () => {
        throw new Error("the practice provider must not submit a deposit to the real provider");
      },
      health: () => ({ degraded: false, errorRate: 0, calls: 0 }),
    };
    const stub = createStubProvider({ upstream });
    await stub.provider.tokens();
    const body = {
      dry: true,
      originAsset: "nep141:base.omft.near",
      destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
      amount: "5000000000000000",
      slippageTolerance: 100,
      deadline: new Date(Date.now() + 1_800_000).toISOString(),
      appFees: [{ recipient: "0x00000000000000000000000000000000000000fe", fee: 40 }],
    };
    expect(await stub.provider.quote(body)).toMatchObject({ data: { from: "upstream" } });
    expect(upstreamCalls).toHaveLength(1);

    const live = await stub.provider.quote({ ...body, dry: false });
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls.every((call) => call.dry === true)).toBe(true);
    if (!live.ok) throw new Error("expected a practice quote");
    const quote = (live.data as { quote: { depositAddress: string } }).quote;
    expect(quote.depositAddress).toMatch(/^0x[0-9a-f]{40}$/);

    expect((await stub.provider.status(quote.depositAddress, null)).ok).toBe(true);
    expect((await stub.provider.submitDeposit({ depositAddress: quote.depositAddress, txHash: "0x1" })).ok).toBe(true);
    expect(await stub.provider.status("0x" + "00".repeat(20), null)).toMatchObject({ ok: false, kind: "rejected", status: 404 });
    expect(stub.control("0x" + "00".repeat(20), "fail")).toBe(false);
  });

  it("makes an order up with the fee the real provider's preview of that pair showed, so that confirming does not say the price moved when only a made-up fee differed", async () => {
    const { createStubProvider } = await import("../server/stub-provider.ts");
    const tokens = JSON.parse(fs.readFileSync(new URL("./fixtures/tokens.json", import.meta.url), "utf8")) as unknown[];
    const clock = 1_000_000;
    // The real provider's preview, as it answers one sent with no fee: its own entry alone, at the figure it charges for the pair.
    let charged: unknown = 1;
    const upstream = {
      tokens: async () => ({ ok: true as const, status: 200, data: tokens }),
      quote: async () => ({ ok: true as const, status: 201, data: { quote: {}, quoteRequest: { appFees: [{ recipient: "provider.near", fee: charged }] } } }),
      status: async () => ({ ok: false as const, kind: "unavailable" as const, status: null }),
      submitDeposit: async () => ({ ok: false as const, kind: "unavailable" as const, status: null }),
      health: () => ({ degraded: false, errorRate: 0, calls: 0 }),
    };
    const stub = createStubProvider({ upstream, now: () => clock });
    await stub.provider.tokens();
    const pair = { originAsset: "nep141:base.omft.near", destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", amount: "5000000000000000", slippageTolerance: 100, deadline: new Date(clock + 1_800_000).toISOString(), refundTo: "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83", recipient: "0xb5590d9FE0D0902ebe80D5191DCeA6Fc4D35eC83" };
    const feeOf = (answer: unknown) => (answer as { ok: true; data: { quoteRequest: { appFees: { fee: number }[] } } }).data.quoteRequest.appFees.map((entry) => entry.fee);
    // Before any preview of the pair, an order made up here carries the provider's usual 20.
    expect(feeOf(await stub.provider.quote({ ...pair, dry: false }, "order"))).toEqual([20]);
    // The preview came from the real provider at 1: the order made up next for the same pair carries 1.
    await stub.provider.quote({ ...pair, dry: true }, "user");
    expect(feeOf(await stub.provider.quote({ ...pair, dry: false }, "order"))).toEqual([1]);
    // Another pair is untouched, and so is an order sent with a fee of ours.
    expect(feeOf(await stub.provider.quote({ ...pair, destinationAsset: pair.originAsset, originAsset: pair.destinationAsset, amount: "5000000", dry: false }, "order"))).toEqual([20]);
    expect(feeOf(await stub.provider.quote({ ...pair, dry: false, appFees: [{ recipient: "0x00000000000000000000000000000000000000fe", fee: 40 }] }, "order"))).toEqual([20, 20]);
    // Only a plain figure within the provider's usual range is taken from a preview.
    for (const odd of [21, -1, 1.5, "1", null]) {
      charged = odd;
      await stub.provider.quote({ ...pair, dry: true }, "user");
      expect(feeOf(await stub.provider.quote({ ...pair, dry: false }, "order"))).toEqual([1]);
    }
  });

  it("makes a preview up itself when the real provider does not answer, and passes a refusal on as it is", async () => {
    const { createStubProvider, UPSTREAM_REST_MS } = await import("../server/stub-provider.ts");
    const tokens = JSON.parse(fs.readFileSync(new URL("./fixtures/tokens.json", import.meta.url), "utf8")) as unknown[];
    let clock = 1_000_000;
    let answer: "refuse" | "down" | "hang" | "fine" = "fine";
    let asked = 0;
    const upstream = {
      tokens: async () => ({ ok: true as const, status: 200, data: tokens }),
      quote: (): Promise<{ ok: true; status: number; data: unknown } | { ok: false; kind: "rejected"; status: number; message: string } | { ok: false; kind: "unavailable"; status: null }> => {
        asked += 1;
        if (answer === "refuse") return Promise.resolve({ ok: false, kind: "rejected", status: 400, message: "Amount is too low for bridge, try at least 1000" });
        if (answer === "down") return Promise.resolve({ ok: false, kind: "unavailable", status: null });
        if (answer === "hang") return new Promise(() => undefined);
        return Promise.resolve({ ok: true, status: 201, data: { from: "upstream" } });
      },
      status: async () => ({ ok: false as const, kind: "unavailable" as const, status: null }),
      submitDeposit: async () => ({ ok: false as const, kind: "unavailable" as const, status: null }),
      health: () => ({ degraded: false, errorRate: 0, calls: 0 }),
    };
    const stub = createStubProvider({ upstream, now: () => clock, previewWaitMs: 20 });
    await stub.provider.tokens();
    const body = {
      dry: true,
      originAsset: "nep141:base.omft.near",
      destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
      amount: "5000000000000000",
      slippageTolerance: 100,
      deadline: new Date(clock + 1_800_000).toISOString(),
      appFees: [{ recipient: "0x00000000000000000000000000000000000000fe", fee: 40 }],
    };
    const madeUp = (result: unknown) => (result as { ok: boolean; data?: { quote?: { amountOut?: string } } }).ok && typeof (result as { data: { quote: { amountOut: string } } }).data.quote.amountOut === "string";

    // A refusal is the real provider's answer: it is passed on, and the real provider is still asked next time.
    answer = "refuse";
    expect(await stub.provider.quote(body)).toMatchObject({ ok: false, kind: "rejected", status: 400 });
    answer = "fine";
    expect(await stub.provider.quote(body)).toMatchObject({ data: { from: "upstream" } });
    expect(stub.calls.madeUpPreviews).toBe(0);

    // No answer at all: the preview is made up here, at once on the next try, without asking again for a minute.
    answer = "down";
    expect(madeUp(await stub.provider.quote(body))).toBe(true);
    expect(asked).toBe(3);
    answer = "fine";
    expect(madeUp(await stub.provider.quote(body))).toBe(true);
    expect(asked).toBe(3);
    clock += UPSTREAM_REST_MS;
    expect(await stub.provider.quote(body)).toMatchObject({ data: { from: "upstream" } });
    expect(asked).toBe(4);

    // An answer that never comes: waited for up to the short limit, and not beyond it. The limit is counted on a
    // pretend timer, so that how long the machine takes over anything else is no part of what is measured.
    answer = "hang";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let given: unknown = null;
      void stub.provider.quote(body).then((result) => (given = result));
      await vi.advanceTimersByTimeAsync(19);
      expect(given).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(given).not.toBeNull();
      expect(madeUp(given)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(stub.calls.madeUpPreviews).toBe(3);

    // Told to keep to itself (the practice clock was moved), it never asks the real provider for a preview again.
    answer = "fine";
    clock += UPSTREAM_REST_MS;
    stub.localOnly();
    const afterLocal = asked;
    expect(madeUp(await stub.provider.quote(body))).toBe(true);
    clock += 10 * UPSTREAM_REST_MS;
    expect(madeUp(await stub.provider.quote(body))).toBe(true);
    expect(asked).toBe(afterLocal);

    // A real order never goes to the real provider, whatever its state.
    const before = asked;
    expect((await stub.provider.quote({ ...body, dry: false })).ok).toBe(true);
    expect(asked).toBe(before);
  });

  it("answers a private quote itself: the level it was asked for, our fee whole beside its own, a little less out, and nothing sent to the real provider", async () => {
    const { createStubProvider, NO_PRIVATE_CHAIN, PRIVATE_EXTRA_BPS, PRIVATE_PROVIDER_BPS } = await import("../server/stub-provider.ts");
    const tokens = JSON.parse(fs.readFileSync(new URL("./fixtures/tokens.json", import.meta.url), "utf8")) as unknown[];
    const ours = { recipient: "0x00000000000000000000000000000000000000fe", fee: 40 };
    const body = {
      dry: true,
      originAsset: "nep141:base.omft.near",
      destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
      amount: "5000000000000000",
      slippageTolerance: 100,
      deadline: new Date(Date.now() + 1_800_000).toISOString(),
    };
    interface Answer {
      quote: { amountOut: string };
      quoteRequest: { confidentiality: string; appFees: Array<{ recipient: string; fee: number }> };
    }
    const local = createStubProvider({ upstream: null, tokens });
    const made = async (extra: Record<string, unknown>): Promise<Answer> => {
      const result = await local.provider.quote({ ...body, ...extra });
      if (!result.ok) throw new Error("expected a practice quote");
      return result.data as Answer;
    };

    // The echo names the level that was asked for, and "public" when none was.
    const publicPlain = await made({});
    const publicWithFee = await made({ appFees: [ours], confidentiality: "public" });
    const asPrivate = await made({ confidentiality: "basic" });
    expect(publicPlain.quoteRequest.confidentiality).toBe("public");
    expect(publicWithFee.quoteRequest.confidentiality).toBe("public");
    expect(asPrivate.quoteRequest.confidentiality).toBe("basic");
    // A public echo carries our share (half of what was sent) and the provider's. A private one, as the real provider's did
    // in the previews of 9 Oct 2026, carries our fee whole and the provider's own 20 beside it, to another account of the
    // provider's; sent with no fee of ours, it holds the provider's entry alone.
    expect(PRIVATE_PROVIDER_BPS).toBe(20);
    expect(publicWithFee.quoteRequest.appFees.map((entry) => entry.fee)).toEqual([20, 20]);
    expect(publicWithFee.quoteRequest.appFees[0]?.recipient).toBe(ours.recipient);
    expect(asPrivate.quoteRequest.appFees).toEqual([{ recipient: expect.any(String), fee: 20 }]);
    const theirs = asPrivate.quoteRequest.appFees[0]!;
    expect(theirs.recipient).not.toBe(publicWithFee.quoteRequest.appFees[1]!.recipient);
    expect(theirs.recipient).not.toBe(ours.recipient);
    const privateWithFee = await made({ confidentiality: "basic", appFees: [{ ...ours, fee: 20 }] });
    expect(privateWithFee.quoteRequest.appFees).toEqual([{ recipient: ours.recipient, fee: 20 }, theirs]);
    expect((await made({ confidentiality: "basic", appFees: [ours] })).quoteRequest.appFees).toEqual([ours, theirs]);
    // Its own fee on a private quote is its own figure, whatever ours is: it is not a share of ours, as on a public quote.
    expect((await made({ confidentiality: "basic", appFees: [{ ...ours, fee: 100 }] })).quoteRequest.appFees).toEqual([{ ...ours, fee: 100 }, theirs]);
    expect((await made({ appFees: [{ ...ours, fee: 100 }] })).quoteRequest.appFees.map((entry) => entry.fee)).toEqual([50, 50]);
    // A private quote gives a fixed 10 basis points less than the same request asked in public...
    const [plain, hidden, withFee, hiddenWithFee] = [publicPlain, asPrivate, publicWithFee, privateWithFee].map((answer) => BigInt(answer.quote.amountOut)) as [bigint, bigint, bigint, bigint];
    expect(PRIVATE_EXTRA_BPS).toBe(10);
    expect(hidden).toBeLessThan(plain);
    expect(((plain - hidden) * 10_000n) / plain).toBe(BigInt(PRIVATE_EXTRA_BPS));
    // ...and our fee is taken from it as from a public one. With this site's fee on each (40 sent in public, of which half
    // is the provider's; 20 in private, beside the provider's 20) the fees come to the same, and the 10 less is all that differs.
    expect(hiddenWithFee).toBeLessThan(hidden);
    expect(hiddenWithFee).toBeLessThan(withFee);
    expect(((withFee - hiddenWithFee) * 10_000n) / withFee).toBe(BigInt(PRIVATE_EXTRA_BPS));

    // The switch: every private quote, preview or real, fails in the way named, as the provider's client would report it. Public quotes go on as before.
    const ways = [
      ["unauthorized", { ok: false, kind: "unavailable", status: 401 }],
      ["forbidden", { ok: false, kind: "rejected", status: 403, message: "" }],
      ["not_offered", { ok: false, kind: "rejected", status: 400, message: expect.stringMatching(/confidential/i) }],
      ["no_route", { ok: false, kind: "rejected", status: 400, message: "No liquidity available" }],
    ] as const;
    expect(local.privateFails).toBeNull();
    for (const [how, answer] of ways) {
      local.privateFails = how;
      expect(await local.provider.quote({ ...body, confidentiality: "basic" }), how).toEqual(answer);
      expect(await local.provider.quote({ ...body, dry: false, confidentiality: "basic" }), how).toEqual(answer);
      expect((await local.provider.quote({ ...body, appFees: [ours] })).ok, how).toBe(true);
    }
    local.privateFails = null;
    expect((await local.provider.quote({ ...body, confidentiality: "basic" })).ok).toBe(true);

    // One kind of pair is always refused in private and fine in public: anything delivered on Zcash.
    expect(NO_PRIVATE_CHAIN).toBe("zec");
    const toZcash = { ...body, destinationAsset: "nep141:zec.omft.near" };
    expect(await local.provider.quote({ ...toZcash, confidentiality: "basic" })).toEqual({ ok: false, kind: "rejected", status: 400, message: expect.stringMatching(/confidential/i) });
    expect((await local.provider.quote({ ...toZcash, appFees: [ours] })).ok).toBe(true);
    expect((await local.provider.quote({ ...toZcash, confidentiality: "public" })).ok).toBe(true);
    // Paid from Zcash, a private quote is given like any other.
    expect((await local.provider.quote({ ...body, originAsset: "nep141:zec.omft.near", amount: "100000000", confidentiality: "basic" })).ok).toBe(true);

    // The provider's third level is answered as the real provider answers it without a partner key, and anything else is no level at all.
    expect(await local.provider.quote({ ...body, confidentiality: "advanced" })).toEqual({ ok: false, kind: "unavailable", status: 401 });
    expect(await local.provider.quote({ ...body, confidentiality: "secret" })).toMatchObject({ ok: false, kind: "rejected", status: 400 });

    // With the real provider behind it: a public preview is passed on, as before. A private one never is.
    const passedOn: Array<Record<string, unknown>> = [];
    const upstream = {
      tokens: async () => ({ ok: true as const, status: 200, data: tokens }),
      quote: async (sent: Record<string, unknown>) => {
        passedOn.push(sent);
        return { ok: true as const, status: 201, data: { from: "upstream" } };
      },
      status: async () => ({ ok: false as const, kind: "unavailable" as const, status: null }),
      submitDeposit: async () => ({ ok: false as const, kind: "unavailable" as const, status: null }),
      health: () => ({ degraded: false, errorRate: 0, calls: 0 }),
    };
    const practice = createStubProvider({ upstream });
    await practice.provider.tokens();
    expect(await practice.provider.quote({ ...body, appFees: [ours] })).toMatchObject({ data: { from: "upstream" } });
    expect(await practice.provider.quote({ ...body, appFees: [ours], confidentiality: "public" })).toMatchObject({ data: { from: "upstream" } });
    expect(passedOn).toHaveLength(2);
    const kept = await practice.provider.quote({ ...body, confidentiality: "basic" });
    expect(kept).toMatchObject({ ok: true, data: { quoteRequest: { confidentiality: "basic" } } });
    expect((await practice.provider.quote({ ...toZcash, confidentiality: "basic" })).ok).toBe(false);
    expect((await practice.provider.quote({ ...body, confidentiality: "advanced" })).ok).toBe(false);
    expect(passedOn).toHaveLength(2);
    // And making private previews up here does not stop public ones being passed on.
    expect(await practice.provider.quote({ ...body, appFees: [ours] })).toMatchObject({ data: { from: "upstream" } });
    expect(practice.calls.madeUpPreviews).toBe(0);
  });
});
