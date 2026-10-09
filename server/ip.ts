// Client IP resolution. The only trusted source is the proxy chain described
// by TRUST_PROXY_HOPS. Headers set by the client are never believed.

import type { IncomingMessage } from "node:http";
import net from "node:net";

export interface ClientIp {
  /** Normalised address, or null when it cannot be resolved through the trusted chain. */
  ip: string | null;
  /** True when the request did not come through the expected proxy chain. */
  direct: boolean;
}

function normalise(raw: string | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value.startsWith("::ffff:") && net.isIPv4(value.slice(7))) value = value.slice(7);
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  return net.isIP(value) ? value.toLowerCase() : null;
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value.join(",");
  return value ?? null;
}

/**
 * With one trusted proxy in front, the host's edge sets X-Real-IP to the
 * client's address (documented) and is expected to add the same address at
 * the right-hand end of X-Forwarded-For (not documented). Either header on its
 * own is accepted. When both are present they must agree: a mismatch means one
 * of them was forged or the proxy behaves differently than assumed, so the
 * address is treated as unknown, which is blocked in production.
 *
 * With more than one proxy, the client is the entry `hops` from the right of
 * X-Forwarded-For; anything to the left of that can be forged.
 */
export function resolveClientIp(req: IncomingMessage, hops: number): ClientIp & { disagree?: boolean } {
  const socketIp = normalise(req.socket.remoteAddress);
  if (hops <= 0) return { ip: socketIp, direct: false };
  const forwarded = header(req, "x-forwarded-for");
  const parts = forwarded === null ? [] : forwarded.split(",").map((p) => p.trim());
  const fromForwarded = forwarded !== null && parts.length >= hops ? normalise(parts[parts.length - hops]) : null;
  if (hops === 1) {
    const real = header(req, "x-real-ip");
    if (real !== null) {
      const fromReal = normalise(real);
      // Compared as addresses, not text: the same IPv6 address can be written in several ways.
      if (forwarded !== null && canonical(fromForwarded) !== canonical(fromReal)) return { ip: null, direct: false, disagree: true };
      return { ip: fromReal, direct: false };
    }
  }
  if (forwarded === null || parts.length < hops) return { ip: null, direct: true };
  return { ip: fromForwarded, direct: false };
}

function expandV6(ip: string): string[] | null {
  const [head = "", tail] = ip.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  if (tail === undefined && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((g) => g.padStart(4, "0"));
}

/** One spelling per address: IPv4 as it is, IPv6 with every group written out. Null stays null. */
function canonical(ip: string | null): string | null {
  if (ip === null || net.isIPv4(ip)) return ip;
  const groups = expandV6(ip);
  return groups === null ? ip : groups.join(":");
}

/** A second, coarser key for IPv6 visitors: their /48 network. Null for IPv4. */
export function wideKey(ip: string | null): string | null {
  if (ip === null || net.isIPv4(ip)) return null;
  const groups = expandV6(ip);
  return groups ? `${groups.slice(0, 3).join(":")}::/48` : null;
}

/** Rate-limit key: the full IPv4 address, or the /64 network of an IPv6 address. */
export function rateKey(ip: string | null): string {
  if (ip === null) return "unknown";
  if (net.isIPv4(ip)) return ip;
  const groups = expandV6(ip);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : "unknown";
}

/** Truncated form for logs: IPv4 /24, IPv6 /48. */
export function truncateIp(ip: string | null): string | null {
  if (ip === null) return null;
  if (net.isIPv4(ip)) return `${ip.split(".").slice(0, 3).join(".")}.0`;
  const groups = expandV6(ip);
  return groups ? `${groups.slice(0, 3).join(":")}::` : null;
}
