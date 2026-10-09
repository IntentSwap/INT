// Region blocking from a local GeoIP database with region-level data.
// The database is downloaded to DATA_DIR and refreshed weekly. In production an
// unknown location is treated as blocked.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import zlib from "node:zlib";
import maxmind, { type CityResponse, type Reader } from "maxmind";
import type { Alerts } from "./alerts.ts";
import { errorKind, type Logger } from "./log.ts";

export interface GeoVerdict {
  country: string | null;
  blocked: boolean;
  reason: "country" | "region" | "unknown" | null;
}

export interface Geo {
  check(ip: string | null): GeoVerdict;
  ready(): boolean;
}

/** Source of the free city-level database. Licensed CC BY 4.0: the site credits it on the Privacy page. */
const GEO_HOST = "download.db-ip.com";
const geoUrl = (yyyyMm: string) => `https://${GEO_HOST}/free/dbip-city-lite-${yyyyMm}.mmdb.gz`;

const REFRESH_AFTER_MS = 7 * 86_400_000;
const MAX_DB_BYTES = 600 * 1024 * 1024;

/**
 * Regions of Ukraine that are blocked: Crimea, Sevastopol, Donetsk, Luhansk,
 * Zaporizhzhia and Kherson. Databases label these differently, so both ISO
 * subdivision codes and name fragments are matched.
 */
const BLOCKED_UA_ISO = new Set(["43", "40", "14", "09", "23", "65"]);
/**
 * Spellings checked against the real database on 8 Oct 2026: it uses
 * "Crimea", "Sebastopol City", "Donetsk", "Luhansk", "Zaporizhzhia", "Zaporizhzhya Oblast",
 * "Zaporizhia", "Kherson" and "Kherson Oblast". The other fragments cover common variants.
 */
const BLOCKED_REGION_WORDS = ["crimea", "krym", "sevastopol", "sebastopol", "donetsk", "donets'k", "donets’k", "luhansk", "luhans'k", "luhans’k", "lugansk", "zaporizh", "zaporiz", "zaporozh", "kherson"];
/** A database older than this is reported even though it still loads. */
const STALE_AFTER_MS = 45 * 86_400_000;

interface GeoRecord {
  country?: { iso_code?: string };
  registered_country?: { iso_code?: string };
  subdivisions?: Array<{ iso_code?: string; names?: { en?: string } }>;
  city?: { names?: { en?: string } };
}

export function isBlockedRegion(record: GeoRecord): boolean {
  const country = record.country?.iso_code;
  if (country !== "UA" && country !== "RU") return false;
  for (const sub of record.subdivisions ?? []) {
    if (country === "UA" && sub.iso_code !== undefined && BLOCKED_UA_ISO.has(sub.iso_code)) return true;
    const name = (sub.names?.en ?? "").toLowerCase();
    if (BLOCKED_REGION_WORDS.some((word) => name.includes(word))) return true;
  }
  const city = (record.city?.names?.en ?? "").toLowerCase();
  return BLOCKED_REGION_WORDS.some((word) => city.includes(word));
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return ip === "::1" || ip === "::" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

export function evaluate(
  record: GeoRecord | null,
  blockedCountries: ReadonlySet<string>,
  blockUnknown: boolean,
): GeoVerdict {
  const country = record?.country?.iso_code?.toUpperCase() ?? null;
  if (record === null || country === null || !/^[A-Z]{2}$/.test(country)) {
    return { country: null, blocked: blockUnknown, reason: blockUnknown ? "unknown" : null };
  }
  if (blockedCountries.has(country)) return { country, blocked: true, reason: "country" };
  if (isBlockedRegion(record)) return { country, blocked: true, reason: "region" };
  return { country, blocked: false, reason: null };
}

function monthsToTry(now: number): string[] {
  const d = new Date(now);
  const current = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const p = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const previous = `${p.getUTCFullYear()}-${String(p.getUTCMonth() + 1).padStart(2, "0")}`;
  return [current, previous];
}

export interface GeoService extends Geo {
  /** Loads the database from disk and downloads a fresh one when needed. */
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createGeo(options: {
  dataDir: string;
  blockedCountries: ReadonlySet<string>;
  /** In production an unknown location is blocked and the database is required. */
  production: boolean;
  log: Logger;
  alerts: Alerts;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): GeoService {
  const { blockedCountries, production, log, alerts } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const dir = path.join(options.dataDir, "geo");
  const file = path.join(dir, "city.mmdb");
  let reader: Reader<CityResponse> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let refreshing: Promise<void> | null = null;

  async function open(target: string): Promise<Reader<CityResponse>> {
    const candidate = await maxmind.open<CityResponse>(target);
    // A database that cannot place a well-known address is not usable.
    if (candidate.get("8.8.8.8")?.country?.iso_code !== "US") throw new Error("geo database failed its self-check");
    return candidate;
  }

  async function download(): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `city.mmdb.tmp-${process.pid}`);
    for (const month of monthsToTry(now())) {
      const res = await fetchImpl(geoUrl(month), { redirect: "error", signal: AbortSignal.timeout(180_000) });
      if (res.status === 404) continue;
      if (!res.ok || res.body === null) throw new Error(`geo download failed with status ${res.status}`);
      let bytes = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          bytes += chunk.length;
          done(bytes > MAX_DB_BYTES ? new Error("geo database too large") : null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(res.body as WebReadableStream), zlib.createGunzip(), cap, fs.createWriteStream(tmp));
        const fresh = await open(tmp);
        fs.renameSync(tmp, file);
        // The file's age is read from its own date, by the same clock that later asks how old it is.
        fs.utimesSync(file, new Date(now()), new Date(now()));
        reader = fresh;
        log.info("geo_updated", { month, bytes });
        return;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    throw new Error("no geo database is published for this month or the last");
  }

  async function refreshOnce(): Promise<void> {
    let ageMs = Infinity;
    try {
      ageMs = now() - fs.statSync(file).mtimeMs;
      if (reader === null) reader = await open(file);
    } catch {
      // No usable file yet.
    }
    if (reader !== null && ageMs < REFRESH_AFTER_MS) return;
    try {
      await download();
    } catch (err) {
      log.error("geo_refresh_failed", { kind: errorKind(err) });
      if (reader === null) alerts.send("geo_down", "The region database could not be loaded. All visitors are blocked until it loads.");
      else if (ageMs > STALE_AFTER_MS) alerts.send("geo_down", `The region database could not be refreshed and is ${Math.floor(ageMs / 86_400_000)} days old. Region blocking still works but is going out of date.`);
    }
  }

  return {
    check(ip) {
      if (ip === null) return evaluate(null, blockedCountries, production);
      if (isPrivateIp(ip)) return evaluate(null, blockedCountries, production);
      if (reader === null) return evaluate(null, blockedCountries, production);
      try {
        return evaluate(reader.get(ip) as GeoRecord | null, blockedCountries, production);
      } catch {
        return evaluate(null, blockedCountries, production);
      }
    },
    ready: () => reader !== null,
    refresh() {
      refreshing ??= refreshOnce().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    start() {
      timer = setInterval(() => void this.refresh(), 6 * 3_600_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

/** Fixed answers by IP, for tests and for local development without a database. */
export function createStaticGeo(byIp: Record<string, GeoVerdict> = {}, fallback: GeoVerdict = { country: null, blocked: false, reason: null }): Geo {
  return {
    check: (ip) => (ip !== null && byIp[ip] !== undefined ? byIp[ip] : fallback),
    ready: () => true,
  };
}
