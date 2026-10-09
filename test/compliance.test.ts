import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BLOCKED_COUNTRIES } from "../server/config.ts";
import { createGeo, evaluate, isBlockedRegion, isPrivateIp } from "../server/geo.ts";
import { silentLogger } from "../server/log.ts";
import { createSanctions, createStaticSanctions, parseSdn, SDN_DOWNLOAD_HOST } from "../server/sanctions.ts";
import { buildMmdb } from "./mmdb.ts";

const blocked = new Set(DEFAULT_BLOCKED_COUNTRIES);
const record = (country: string, region?: string, iso?: string, city?: string) => ({
  country: { iso_code: country },
  ...(region === undefined && iso === undefined ? {} : { subdivisions: [{ ...(iso ? { iso_code: iso } : {}), ...(region ? { names: { en: region } } : {}) }] }),
  ...(city ? { city: { names: { en: city } } } : {}),
});

describe("region rules", () => {
  it("blocks listed countries and allows others", () => {
    expect(evaluate(record("IR"), blocked, true)).toEqual({ country: "IR", blocked: true, reason: "country" });
    expect(evaluate(record("RU", "Moscow"), blocked, true)).toEqual({ country: "RU", blocked: true, reason: "country" });
    expect(evaluate(record("KP"), blocked, false).blocked).toBe(true);
    expect(evaluate(record("DE", "Berlin"), blocked, true)).toEqual({ country: "DE", blocked: false, reason: null });
    expect(evaluate(record("US", "California"), blocked, true).blocked).toBe(false);
  });

  it("blocks the listed regions of Ukraine by name, in any common spelling", () => {
    for (const name of [
      "Crimea",
      "Autonomous Republic of Crimea",
      "Krym",
      "Sevastopol",
      "Sevastopol City",
      // The spellings the real database uses (checked 8 Oct 2026).
      "Sebastopol City",
      "Zaporizhzhya Oblast",
      "Zaporiz’ka Oblast’",
      "Luhans’ka Oblast’",
      "Donets’ka Oblast’",
      "Donetsk",
      "Donetsk Oblast",
      "Donets'k",
      "Luhansk",
      "Luhansk Oblast",
      "Lugansk",
      "Zaporizhzhia",
      "Zaporizhzhya",
      "Zaporizhia",
      "Zaporozhye",
      "Kherson",
      "Kherson Oblast",
    ]) {
      expect(isBlockedRegion(record("UA", name)), name).toBe(true);
      expect(evaluate(record("UA", name), blocked, false)).toEqual({ country: "UA", blocked: true, reason: "region" });
    }
  });

  it("blocks the listed regions by ISO subdivision code", () => {
    for (const iso of ["43", "40", "14", "09", "23", "65"]) expect(isBlockedRegion(record("UA", undefined, iso)), iso).toBe(true);
    for (const iso of ["30", "32", "46", "63", "51"]) expect(isBlockedRegion(record("UA", undefined, iso)), iso).toBe(false);
  });

  it("blocks by city when the region is missing", () => {
    expect(isBlockedRegion(record("UA", undefined, undefined, "Sevastopol"))).toBe(true);
    expect(isBlockedRegion(record("UA", undefined, undefined, "Kyiv"))).toBe(false);
  });

  it("leaves the rest of Ukraine open", () => {
    for (const name of ["Kyiv City", "Kyiv", "Lviv", "Kharkiv", "Odessa", "Dnipropetrovsk", "Vinnytsia"]) {
      expect(evaluate(record("UA", name), blocked, true)).toEqual({ country: "UA", blocked: false, reason: null });
    }
    // The same words in another country mean nothing.
    expect(isBlockedRegion(record("US", "Crimea"))).toBe(false);
  });

  it("blocks an unknown location in production and allows it in development", () => {
    for (const unknown of [null, {}, { country: {} }, { country: { iso_code: "??" } }]) {
      expect(evaluate(unknown, blocked, true)).toEqual({ country: null, blocked: true, reason: "unknown" });
      expect(evaluate(unknown, blocked, false)).toEqual({ country: null, blocked: false, reason: null });
    }
  });

  it("recognises private and local addresses", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.5", "172.16.0.1", "172.31.255.255", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "203.0.113.5", "2001:db8::1", "100.128.0.1"]) expect(isPrivateIp(ip), ip).toBe(false);
  });
});

describe("region service without a database", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-geo-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("blocks everyone in production until the database loads, and alerts", async () => {
    const alerts: string[] = [];
    const geo = createGeo({
      dataDir: dir,
      blockedCountries: blocked,
      production: true,
      log: silentLogger,
      alerts: { send: (kind) => void alerts.push(kind) },
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    expect(geo.ready()).toBe(false);
    expect(geo.check("8.8.8.8")).toEqual({ country: null, blocked: true, reason: "unknown" });
    expect(geo.check(null).blocked).toBe(true);
    expect(geo.check("10.0.0.1").blocked).toBe(true);
    await geo.refresh();
    expect(geo.ready()).toBe(false);
    expect(alerts).toContain("geo_down");
    expect(geo.check("8.8.8.8").blocked).toBe(true);
  });

  it("refuses a download that is not a usable database", async () => {
    const geo = createGeo({
      dataDir: dir,
      blockedCountries: blocked,
      production: true,
      log: silentLogger,
      alerts: { send() {} },
      fetchImpl: async () => new Response("this is not gzip", { status: 200 }),
    });
    await geo.refresh();
    expect(geo.ready()).toBe(false);
    expect(fs.existsSync(path.join(dir, "geo", "city.mmdb"))).toBe(false);
    expect(fs.readdirSync(path.join(dir, "geo")).filter((n) => n.includes("tmp"))).toHaveLength(0);
  });
});

describe("region service with a real-format database", () => {
  let dir = "";
  let now = Date.parse("2026-10-08T12:00:00.000Z");
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-geo-db-"));
    now = Date.parse("2026-10-08T12:00:00.000Z");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const named = (country: string, region: string, city = region) => ({ country: { iso_code: country }, subdivisions: [{ names: { en: region } }], city: { names: { en: city } } });
  const coded = (country: string, iso: string) => ({ country: { iso_code: country }, subdivisions: [{ iso_code: iso, names: { en: "Region" } }] });

  // Two labelling styles on purpose: one database names regions in English, the other gives ISO codes.
  const database = buildMmdb({
    "8.8.8.0/24": named("US", "California", "Mountain View"),
    "5.255.255.0/24": named("RU", "Moscow"),
    "81.91.130.0/24": named("IR", "Tehran"),
    "203.0.113.0/24": named("DE", "Berlin"),
    "176.104.32.0/24": named("UA", "Kyiv City", "Kyiv"),
    "91.200.1.0/24": named("UA", "Crimea", "Simferopol"),
    "91.200.2.0/24": named("UA", "Sevastopol City", "Sevastopol"),
    "91.200.3.0/24": named("UA", "Donetsk", "Mariupol"),
    "91.200.4.0/24": named("UA", "Luhansk", "Alchevsk"),
    "91.200.5.0/24": named("UA", "Zaporizhzhya", "Melitopol"),
    "91.200.6.0/24": named("UA", "Kherson", "Nova Kakhovka"),
    "91.201.1.0/24": coded("UA", "43"),
    "91.201.2.0/24": coded("UA", "40"),
    "91.201.3.0/24": coded("UA", "14"),
    "91.201.4.0/24": coded("UA", "09"),
    "91.201.5.0/24": coded("UA", "23"),
    "91.201.6.0/24": coded("UA", "65"),
    "91.201.7.0/24": coded("UA", "46"),
    "198.18.0.0/24": { city: { names: { en: "Nowhere" } } },
  });
  const gz = zlib.gzipSync(database);

  function service(options: { fetchImpl?: typeof fetch; alerts?: string[] } = {}) {
    const requested: string[] = [];
    const geo = createGeo({
      dataDir: dir,
      blockedCountries: blocked,
      production: true,
      log: silentLogger,
      alerts: { send: (kind) => void options.alerts?.push(kind) },
      now: () => now,
      fetchImpl:
        options.fetchImpl ??
        (async (input) => {
          requested.push(String(input));
          return new Response(new Uint8Array(gz), { status: 200 });
        }),
    });
    return { geo, requested };
  }

  it("downloads, unpacks and opens the database, then gives the right verdict for each place", async () => {
    const { geo, requested } = service();
    expect(geo.ready()).toBe(false);
    await geo.refresh();
    expect(geo.ready()).toBe(true);
    expect(requested).toEqual(["https://download.db-ip.com/free/dbip-city-lite-2026-10.mmdb.gz"]);
    expect(fs.existsSync(path.join(dir, "geo", "city.mmdb"))).toBe(true);
    expect(fs.readdirSync(path.join(dir, "geo"))).toEqual(["city.mmdb"]);

    expect(geo.check("8.8.8.8")).toEqual({ country: "US", blocked: false, reason: null });
    expect(geo.check("203.0.113.77")).toEqual({ country: "DE", blocked: false, reason: null });
    expect(geo.check("176.104.32.1")).toEqual({ country: "UA", blocked: false, reason: null });
    expect(geo.check("91.201.7.1")).toEqual({ country: "UA", blocked: false, reason: null });
    expect(geo.check("5.255.255.5")).toEqual({ country: "RU", blocked: true, reason: "country" });
    expect(geo.check("81.91.130.1")).toEqual({ country: "IR", blocked: true, reason: "country" });
    for (let i = 1; i <= 6; i++) {
      expect(geo.check(`91.200.${i}.9`), `named region ${i}`).toEqual({ country: "UA", blocked: true, reason: "region" });
      expect(geo.check(`91.201.${i}.9`), `coded region ${i}`).toEqual({ country: "UA", blocked: true, reason: "region" });
    }
  });

  it("blocks whatever it cannot place: no entry, no country, private, IPv6 outside the database, or no address", async () => {
    const { geo } = service();
    await geo.refresh();
    for (const ip of ["1.2.3.4", "198.18.0.5", "10.0.0.1", "127.0.0.1", "2001:db8::1", null]) {
      expect(geo.check(ip), String(ip)).toEqual({ country: null, blocked: true, reason: "unknown" });
    }
  });

  it("uses the file on disk after a restart and downloads again only after a week", async () => {
    const first = service();
    await first.geo.refresh();
    await first.geo.refresh();
    expect(first.requested).toHaveLength(1);

    const restarted = service();
    await restarted.geo.refresh();
    expect(restarted.requested).toHaveLength(0);
    expect(restarted.geo.check("81.91.130.1").blocked).toBe(true);

    now += 6 * 86_400_000;
    await restarted.geo.refresh();
    expect(restarted.requested).toHaveLength(0);
    now += 2 * 86_400_000;
    await restarted.geo.refresh();
    expect(restarted.requested).toEqual(["https://download.db-ip.com/free/dbip-city-lite-2026-10.mmdb.gz"]);
  });

  it("falls back to last month's file when this month's is not published yet", async () => {
    const requested: string[] = [];
    const { geo } = service({
      fetchImpl: async (input) => {
        requested.push(String(input));
        return String(input).includes("2026-10") ? new Response("not yet", { status: 404 }) : new Response(new Uint8Array(gz), { status: 200 });
      },
    });
    await geo.refresh();
    expect(requested).toEqual([
      "https://download.db-ip.com/free/dbip-city-lite-2026-10.mmdb.gz",
      "https://download.db-ip.com/free/dbip-city-lite-2026-09.mmdb.gz",
    ]);
    expect(geo.ready()).toBe(true);
  });

  it("alerts when the database cannot be refreshed and is going out of date, while it keeps working", async () => {
    let failing = false;
    const alerts: Array<{ kind: string; text: string }> = [];
    const geo = createGeo({
      dataDir: dir,
      blockedCountries: blocked,
      production: true,
      log: silentLogger,
      alerts: { send: (kind, text) => void alerts.push({ kind, text }) },
      now: () => now,
      fetchImpl: async () => (failing ? new Response("down", { status: 503 }) : new Response(new Uint8Array(gz), { status: 200 })),
    });
    await geo.refresh();
    failing = true;
    // A few failed weekly refreshes are not worth an alert yet.
    now += 20 * 86_400_000;
    await geo.refresh();
    expect(alerts).toHaveLength(0);
    now += 30 * 86_400_000;
    await geo.refresh();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "geo_down" });
    expect(alerts[0]!.text).toContain("days old");
    expect(geo.check("81.91.130.1").blocked).toBe(true);
    expect(geo.check("8.8.8.8").blocked).toBe(false);
  });

  it("keeps the working database when a later download is broken", async () => {
    let body: Buffer = gz;
    const alerts: string[] = [];
    const { geo } = service({ alerts, fetchImpl: async () => new Response(new Uint8Array(body), { status: 200 }) });
    await geo.refresh();
    body = zlib.gzipSync(buildMmdb({ "9.9.9.0/24": named("CH", "Zurich") })); // opens, but fails the self-check
    now += 8 * 86_400_000;
    await geo.refresh();
    expect(geo.check("81.91.130.1")).toEqual({ country: "IR", blocked: true, reason: "country" });
    expect(geo.check("8.8.8.8").country).toBe("US");
    expect(alerts).toHaveLength(0);
    expect(fs.readdirSync(path.join(dir, "geo"))).toEqual(["city.mmdb"]);
  });
});

function sdnXml(addresses: Array<[string, string]>, date = "10/05/2026"): string {
  const ids = addresses.map(([kind, address], i) => `<id><uid>${i}</uid><idType>Digital Currency Address - ${kind}</idType><idNumber>${address}</idNumber></id>`).join("\n");
  return `<?xml version="1.0"?><sdnList><publshInformation><Publish_Date>${date}</Publish_Date><Record_Count>1</Record_Count></publshInformation><sdnEntry><uid>1</uid><idList>
<id><uid>9</uid><idType>Passport</idType><idNumber>P1234567</idNumber></id>
${ids}</idList></sdnEntry></sdnList>`;
}

const filler = (count: number): Array<[string, string]> => Array.from({ length: count }, (_, i) => ["XBT", `1Filler${String(i).padStart(27, "0")}`]);
const LISTED_ETH = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
const LISTED_TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const LISTED_BCH_LEGACY = "1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu";

describe("sanctions list parsing", () => {
  it("extracts digital-currency addresses for every chain and the publish date", () => {
    const parsed = parseSdn(sdnXml([["ETH", LISTED_ETH], ["TRX", LISTED_TRON], ["USDT", LISTED_TRON], ["SOL", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"], ...filler(300)]));
    expect(parsed.publishDate).toBe("2026-10-05");
    expect(parsed.addresses).toContain(LISTED_ETH);
    expect(parsed.addresses).toContain(LISTED_TRON);
    expect(parsed.addresses).toContain("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    expect(parsed.addresses).not.toContain("P1234567");
    expect(parsed.addresses).toHaveLength(303);
  });

  it("rejects a list that is empty, truncated or has no date", () => {
    expect(() => parseSdn(sdnXml([["ETH", LISTED_ETH]]))).toThrow();
    expect(() => parseSdn("<html>Service unavailable</html>")).toThrow();
    expect(() => parseSdn(sdnXml(filler(400)).replace(/<Publish_Date>.*?<\/Publish_Date>/, ""))).toThrow();
  });
});

describe("sanctions screening", () => {
  it("matches a listed address in any case or spelling, on any chain", () => {
    const sanctions = createStaticSanctions([LISTED_ETH, LISTED_TRON, LISTED_BCH_LEGACY]);
    expect(sanctions.screen([LISTED_ETH]).ok).toBe(false);
    expect(sanctions.screen([LISTED_ETH.toLowerCase()]).ok).toBe(false);
    expect(sanctions.screen([LISTED_ETH.toUpperCase().replace("0X", "0x")]).ok).toBe(false);
    expect(sanctions.screen([LISTED_TRON]).ok).toBe(false);
    expect(sanctions.screen(["bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a"]).ok).toBe(false);
    expect(sanctions.screen(["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", null, undefined, LISTED_TRON]).ok).toBe(false);
  });

  it("clears addresses that are not listed and records the list version", () => {
    const sanctions = createStaticSanctions([LISTED_ETH]);
    const outcome = sanctions.screen(["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", null, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
    expect(outcome).toMatchObject({ ok: true, record: { result: "clear", listVersion: "test-list" } });
    // Base58 is case-sensitive: a different case is a different address.
    expect(createStaticSanctions([LISTED_TRON]).screen([LISTED_TRON.toLowerCase()]).ok).toBe(true);
  });
});

describe("sanctions service", () => {
  let dir = "";
  let now = Date.parse("2026-10-08T12:00:00.000Z");
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-sdn-"));
    now = Date.parse("2026-10-08T12:00:00.000Z");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const xml = sdnXml([["ETH", LISTED_ETH], ...filler(320)]);
  const service = (fetchImpl: typeof fetch, alerts: string[] = []) =>
    createSanctions({ dataDir: dir, log: silentLogger, alerts: { send: (kind) => void alerts.push(kind) }, fetchImpl, now: () => now });

  it("is unavailable until the list has loaded", () => {
    const sanctions = service(async () => new Response("", { status: 500 }));
    expect(sanctions.available()).toBe(false);
    expect(sanctions.screen(["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"])).toEqual({ ok: false, reason: "unavailable" });
  });

  it("downloads, follows only the expected redirect, and screens", async () => {
    const seen: string[] = [];
    const sanctions = service(async (input) => {
      const url = String(input);
      seen.push(new URL(url).host);
      if (url.includes("sanctionslistservice")) {
        return new Response(null, { status: 302, headers: { location: `https://${SDN_DOWNLOAD_HOST}/Published/SDN.XML?sig=abc` } });
      }
      return new Response(xml, { status: 200 });
    });
    await sanctions.refresh();
    expect(seen).toEqual(["sanctionslistservice.ofac.treas.gov", SDN_DOWNLOAD_HOST]);
    // The one host a redirect is followed to, spelled out: the list service's own US government cloud bucket.
    expect(SDN_DOWNLOAD_HOST).toBe("wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com");
    expect(sanctions.available()).toBe(true);
    expect(sanctions.version()).toBe("2026-10-05");
    expect(sanctions.screen([LISTED_ETH.toLowerCase()])).toEqual({ ok: false, reason: "listed" });
    expect(sanctions.screen(["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"]).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "sanctions", "sdn-addresses.json"))).toBe(true);
  });

  it("refuses a redirect to any other host", async () => {
    const alerts: string[] = [];
    for (const location of [
      "https://evil.example/SDN.XML",
      `http://${SDN_DOWNLOAD_HOST}/x`,
      `https://${SDN_DOWNLOAD_HOST}.evil.example/x`,
      // Another bucket in the same cloud region is still somebody else's bucket.
      "https://some-other-bucket.s3.us-gov-west-1.amazonaws.com/SDN.XML",
    ]) {
      let followed = false;
      const sanctions = service(async (input) => {
        if (String(input).includes("sanctionslistservice")) return new Response(null, { status: 302, headers: { location } });
        followed = true;
        return new Response(xml, { status: 200 });
      }, alerts);
      await sanctions.refresh();
      expect(followed, location).toBe(false);
      expect(sanctions.available()).toBe(false);
    }
    expect(alerts).toContain("screening_down");
  });

  it("keeps using the cached list across a restart, refreshes daily, and goes unavailable after 72 hours", async () => {
    let downloads = 0;
    let failing = false;
    const fetchImpl: typeof fetch = async () => {
      downloads += 1;
      return failing ? new Response("down", { status: 503 }) : new Response(xml, { status: 200 });
    };
    const first = service(fetchImpl);
    await first.refresh();
    await first.refresh();
    expect(downloads).toBe(1);

    const restarted = service(fetchImpl);
    await restarted.refresh();
    expect(downloads).toBe(1);
    expect(restarted.available()).toBe(true);

    now += 25 * 3_600_000;
    await restarted.refresh();
    expect(downloads).toBe(2);

    failing = true;
    const alerts: Array<{ kind: string; text: string }> = [];
    const later = createSanctions({ dataDir: dir, log: silentLogger, alerts: { send: (kind, text) => void alerts.push({ kind, text }) }, fetchImpl, now: () => now });
    now += 48 * 3_600_000;
    await later.refresh();
    // 48 hours old: still usable, but the failed daily download is reported straight away.
    expect(later.available()).toBe(true);
    expect(later.screen([LISTED_ETH]).ok).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "screening_down" });
    expect(alerts[0]!.text).toContain("Screening continues with the list dated 2026-10-05");
    now += 25 * 3_600_000;
    await later.refresh();
    expect(later.available()).toBe(false);
    expect(later.screen(["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"])).toEqual({ ok: false, reason: "unavailable" });
    expect(alerts.at(-1)!.text).toContain("New orders are refused until it loads");
  });

  it("refuses a new list that has lost a large share of its addresses", async () => {
    let body = sdnXml([["ETH", LISTED_ETH], ...filler(1000)]);
    const alerts: string[] = [];
    const sanctions = service(async () => new Response(body, { status: 200 }), alerts);
    await sanctions.refresh();
    expect(sanctions.screen([LISTED_ETH]).ok).toBe(false);
    // A later download is well-formed but has dropped most entries, including the one we rely on.
    body = sdnXml(filler(400));
    now += 25 * 3_600_000;
    await sanctions.refresh();
    expect(sanctions.screen([LISTED_ETH]).ok).toBe(false);
    expect(alerts).toContain("screening_down");
    // A small change in size is normal and is accepted.
    body = sdnXml([["ETH", LISTED_ETH], ...filler(950)]);
    now += 2 * 3_600_000;
    await sanctions.refresh();
    expect(sanctions.version()).toBe("2026-10-05");
    expect(alerts.filter((a) => a === "screening_down")).toHaveLength(1);
  });

  it("matches a listed hex address written without its 0x prefix, and the other way round", async () => {
    const bare = "ab".repeat(32);
    const sanctions = createStaticSanctions([bare, LISTED_ETH.slice(2)]);
    expect(sanctions.screen([`0x${bare}`]).ok).toBe(false);
    expect(sanctions.screen([bare.toUpperCase()]).ok).toBe(false);
    expect(sanctions.screen([LISTED_ETH]).ok).toBe(false);
    expect(createStaticSanctions([`0x${bare}`]).screen([bare]).ok).toBe(false);
  });

  it("matches a listed TON or Starknet address in any spelling a person might type", () => {
    const ton = createStaticSanctions(["EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"]);
    expect(ton.screen(["EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"]).ok).toBe(false);
    expect(ton.screen(["EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id/sDs"]).ok).toBe(false);
    expect(ton.screen(["UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_p0p"]).ok).toBe(false);
    expect(ton.screen(["EQAWzEKcdnykvXfUNouqdS62tvrp32bCxuKS6eQrS6ISgcLo"]).ok).toBe(true);
    const starknet = createStaticSanctions(["0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb"]);
    expect(starknet.screen(["0x33068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb"]).ok).toBe(false);
  });

  it("keeps the old list when a download is broken", async () => {
    let body = xml;
    const sanctions = service(async () => new Response(body, { status: 200 }));
    await sanctions.refresh();
    body = "<html>maintenance</html>";
    now += 25 * 3_600_000;
    await sanctions.refresh();
    expect(sanctions.available()).toBe(true);
    expect(sanctions.screen([LISTED_ETH]).ok).toBe(false);
  });
});
