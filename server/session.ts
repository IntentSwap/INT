// Short-lived tokens for the quote and order routes. They are issued by
// /api/config and signed with a secret that exists only in this process.
// They are not logins and carry no identity; they stop the routes from being
// used as a public API by scripts that never loaded the site.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_MS = 30 * 60_000;

export interface SessionIssuer {
  issue(now: number): { token: string; expiresAt: number };
  verify(token: unknown, now: number): boolean;
}

export function createSessionIssuer(secret: Buffer = randomBytes(32)): SessionIssuer {
  const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");
  return {
    issue(now) {
      const expiresAt = now + SESSION_TTL_MS;
      const payload = `v1.${expiresAt}.${randomBytes(9).toString("base64url")}`;
      return { token: `${payload}.${sign(payload)}`, expiresAt };
    },
    verify(token, now) {
      if (typeof token !== "string" || token.length > 200) return false;
      const parts = token.split(".");
      if (parts.length !== 4 || parts[0] !== "v1") return false;
      const [version, expires, nonce, mac] = parts as [string, string, string, string];
      if (!/^\d{13}$/.test(expires)) return false;
      const expected = Buffer.from(sign(`${version}.${expires}.${nonce}`));
      const given = Buffer.from(mac);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
      return Number(expires) > now;
    },
  };
}
