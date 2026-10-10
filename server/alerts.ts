// Operator alerts. Sent to ALERT_WEBHOOK_URL when set, and always logged.
// Alert text never contains a wallet address, an IP or a secret.

import type { Logger } from "./log.ts";

export type AlertKind =
  | "oneclick_errors"
  | "quote_verification"
  | "token_mismatch"
  | "slow_swap"
  | "screening_down"
  | "disk"
  | "geo_down"
  | "status_mismatch"
  | "sanctions_hit"
  | "deposit_unseen"
  | "unfinished_order";

export interface Alerts {
  /**
   * `dedupeKey` tells one subject of an alert from another, so that repeats about the same one can
   * be held back. It is kept in memory for as long as that takes. For an order it is the order's
   * hashed ID (`hashId`), as in the text: never the ID itself.
   */
  send(kind: AlertKind, text: string, dedupeKey?: string): void;
}

const THROTTLE_MS: Record<AlertKind, number> = {
  oneclick_errors: 15 * 60_000,
  // The first failure for a given reason is sent at once; repeats of the same reason at most once a minute.
  quote_verification: 60_000,
  token_mismatch: 60 * 60_000,
  slow_swap: 24 * 60 * 60_000,
  screening_down: 60 * 60_000,
  disk: 6 * 60 * 60_000,
  geo_down: 6 * 60 * 60_000,
  status_mismatch: 60 * 60_000,
  sanctions_hit: 0,
  // Each of these is sent once per order (the order records that it was sent).
  deposit_unseen: 0,
  unfinished_order: 0,
};

export function createAlerts(options: {
  webhookUrl: string | null;
  log: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Alerts {
  const { webhookUrl, log } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const lastSent = new Map<string, number>();

  return {
    send(kind, text, dedupeKey = "") {
      const key = `${kind}:${dedupeKey}`;
      const t = now();
      const throttle = THROTTLE_MS[kind];
      const previous = lastSent.get(key);
      if (throttle > 0 && previous !== undefined && t - previous < throttle) {
        // Held back from the channel, so that one fault does not flood it. The log still has every occurrence.
        log.warn("alert", { kind, text, held: true });
        return;
      }
      lastSent.set(key, t);
      if (lastSent.size > 5000) {
        for (const [k, at] of lastSent) if (t - at > 24 * 60 * 60_000) lastSent.delete(k);
      }
      log.warn("alert", { kind, text });
      if (webhookUrl === null) return;
      const message = `IntentSwap alert (${kind}): ${text}`;
      // "text" suits Slack-style hooks, "content" suits Discord-style hooks.
      fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message, content: message }),
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      }).catch(() => {
        log.error("alert_delivery_failed", { kind });
      });
    },
  };
}

export const nullAlerts: Alerts = { send() {} };
