// Sanctions screening against the OFAC SDN list's digital-currency addresses,
// for every chain. The list is downloaded daily and cached on disk. When it is
// missing or stale, order creation is refused.

import fs from "node:fs";
import path from "node:path";
import type { Alerts } from "./alerts.ts";
import { addressVariants, canonical } from "./address-variants.ts";
import { errorKind, type Logger } from "./log.ts";
import { readCappedText } from "./read.ts";

const SDN_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";
/** The list service redirects to its own US government cloud bucket. Only that exact host is followed. */
export const SDN_DOWNLOAD_HOST = "wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com";
/** A new download with fewer than this share of the addresses we already hold is treated as broken. */
const MIN_SHARE_OF_PREVIOUS = 0.8;

const REFRESH_AFTER_MS = 24 * 3_600_000;
/** Older than this and the list is treated as unavailable. */
const STALE_AFTER_MS = 72 * 3_600_000;
const MAX_LIST_BYTES = 200 * 1024 * 1024;
/** A parse that finds fewer addresses than this is rejected as broken. */
const MIN_ADDRESSES = 300;

export interface ScreeningRecord {
  result: "clear";
  listVersion: string;
  checkedAt: string;
}

export type ScreeningOutcome =
  | { ok: true; record: ScreeningRecord }
  | { ok: false; reason: "listed" | "unavailable" };

export interface Sanctions {
  available(): boolean;
  version(): string | null;
  screen(addresses: Array<string | null | undefined>): ScreeningOutcome;
}

export interface SanctionsService extends Sanctions {
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

interface CacheFile {
  publishDate: string;
  fetchedAt: number;
  addresses: string[];
}

export function parseSdn(xml: string): { publishDate: string; addresses: string[] } {
  const publish = /<Publish_Date>\s*(\d{2})\/(\d{2})\/(\d{4})\s*<\/Publish_Date>/.exec(xml);
  if (!publish) throw new Error("sanctions list has no publish date");
  const publishDate = `${publish[3]}-${publish[1]}-${publish[2]}`;
  const found = new Set<string>();
  const pattern = /<idType>\s*Digital Currency Address - [^<]{1,20}<\/idType>\s*<idNumber>\s*([^<\s]{6,200})\s*<\/idNumber>/g;
  for (const match of xml.matchAll(pattern)) {
    const address = match[1];
    if (address !== undefined) found.add(address);
  }
  if (found.size < MIN_ADDRESSES) throw new Error("sanctions list parse found too few addresses");
  return { publishDate, addresses: [...found].sort() };
}

function buildIndex(addresses: string[]): Set<string> {
  const index = new Set<string>();
  for (const address of addresses) for (const variant of addressVariants(address)) index.add(variant);
  return index;
}

export function createSanctions(options: {
  dataDir: string;
  log: Logger;
  alerts: Alerts;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): SanctionsService {
  const { log, alerts } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const dir = path.join(options.dataDir, "sanctions");
  const file = path.join(dir, "sdn-addresses.json");
  let index: Set<string> | null = null;
  let publishDate: string | null = null;
  let fetchedAt = 0;
  let addressCount = 0;
  let timer: NodeJS.Timeout | null = null;
  let refreshing: Promise<void> | null = null;

  function loadFromDisk(): void {
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8")) as CacheFile;
      if (typeof cached.publishDate !== "string" || typeof cached.fetchedAt !== "number" || !Array.isArray(cached.addresses)) return;
      if (cached.addresses.length < MIN_ADDRESSES || !cached.addresses.every((a) => typeof a === "string")) return;
      index = buildIndex(cached.addresses);
      addressCount = cached.addresses.length;
      publishDate = cached.publishDate;
      fetchedAt = cached.fetchedAt;
    } catch {
      // No cache yet.
    }
  }

  async function download(): Promise<string> {
    const first = await fetchImpl(SDN_URL, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
    let res = first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get("location");
      const target = location === null ? null : new URL(location);
      if (target === null || target.protocol !== "https:" || target.host !== SDN_DOWNLOAD_HOST) {
        throw new Error("sanctions list redirected to an unexpected host");
      }
      res = await fetchImpl(target, { redirect: "error", signal: AbortSignal.timeout(120_000) });
    }
    if (!res.ok) throw new Error(`sanctions list download failed with status ${res.status}`);
    return readCappedText(res, MAX_LIST_BYTES);
  }

  async function refreshOnce(): Promise<void> {
    if (index === null) loadFromDisk();
    if (index !== null && now() - fetchedAt < REFRESH_AFTER_MS) return;
    try {
      const parsed = parseSdn(await download());
      // Sanctions lists grow slowly. One that suddenly lost a large share of its addresses is a broken download.
      if (addressCount > 0 && parsed.addresses.length < addressCount * MIN_SHARE_OF_PREVIOUS) throw new Error("sanctions list shrank sharply");
      const cache: CacheFile = { publishDate: parsed.publishDate, fetchedAt: now(), addresses: parsed.addresses };
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, file);
      index = buildIndex(parsed.addresses);
      addressCount = parsed.addresses.length;
      publishDate = parsed.publishDate;
      fetchedAt = cache.fetchedAt;
      log.info("sanctions_updated", { publishDate, addresses: parsed.addresses.length });
    } catch (err) {
      log.error("sanctions_refresh_failed", { kind: errorKind(err) });
      // A failed daily download is reported at once, not only when the list has become too old to use.
      alerts.send(
        "screening_down",
        service.available()
          ? `The sanctions list could not be refreshed. Screening continues with the list dated ${publishDate ?? "unknown"} until it is 72 hours old; after that new orders are refused.`
          : "The sanctions list could not be refreshed and there is no usable copy. New orders are refused until it loads.",
      );
    }
  }

  const service: SanctionsService = {
    available: () => index !== null && now() - fetchedAt < STALE_AFTER_MS,
    version: () => publishDate,
    screen(addresses) {
      if (index === null || publishDate === null || !service.available()) return { ok: false, reason: "unavailable" };
      for (const address of addresses) {
        if (address === null || address === undefined) continue;
        for (const variant of addressVariants(address)) if (index.has(variant)) return { ok: false, reason: "listed" };
        if (index.has(canonical(address))) return { ok: false, reason: "listed" };
      }
      return { ok: true, record: { result: "clear", listVersion: publishDate, checkedAt: new Date(now()).toISOString() } };
    },
    refresh() {
      refreshing ??= refreshOnce().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    start() {
      timer = setInterval(() => void service.refresh(), 3_600_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
  return service;
}

/** A fixed list, for tests. */
export function createStaticSanctions(listed: string[], options: { available?: boolean; now?: () => number } = {}): Sanctions {
  const index = buildIndex(listed);
  const now = options.now ?? Date.now;
  return {
    available: () => options.available ?? true,
    version: () => "test-list",
    screen(addresses) {
      if (options.available === false) return { ok: false, reason: "unavailable" };
      for (const address of addresses) {
        if (!address) continue;
        if (addressVariants(address).some((v) => index.has(v))) return { ok: false, reason: "listed" };
      }
      return { ok: true, record: { result: "clear", listVersion: "test-list", checkedAt: new Date(now()).toISOString() } };
    },
  };
}
