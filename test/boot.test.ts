import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boot, practiceClock, type Booted } from "../server/boot.ts";
import { privateKeyToAccount } from "viem/accounts";
import { ConfigError, loadConfig } from "../server/config.ts";
import { SAMPLE, sampleOrderId, seedSamples, withSampleSettings } from "../server/sample.ts";
import { createLogger } from "../server/log.ts";
import { TERMS_VERSION } from "../shared/api.ts";
import { ADDR, ASSET, FIXTURE_TOKENS } from "./helpers.ts";

const FEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
let dir = "";
let running: Booted[] = [];
let lines: string[] = [];
let outbound: string[] = [];
let providerDown = false;

// A pretend outside world: the provider's coin list works, everything else is unreachable.
const network: typeof fetch = async (input) => {
  const url = String(input);
  outbound.push(new URL(url).host + new URL(url).pathname);
  if (providerDown && url.includes("1click")) throw new Error("provider unreachable");
  if (url.includes("/v0/tokens")) return new Response(JSON.stringify(FIXTURE_TOKENS));
  throw new Error("unreachable in tests");
};

function start(env: Record<string, string>, statfs?: () => { blocks: number; bavail: number }): Booted {
  const booted = boot({
    env: { DATA_DIR: dir, ...env },
    log: createLogger((line) => lines.push(line)),
    fetchImpl: network,
    siteDir: path.join(dir, "no-site"),
    ...(statfs ? { statfs } : {}),
  });
  running.push(booted);
  return booted;
}

// The live server as it is told the least it must be told. No fee is set, so no fee recipient is needed: it starts without one.
const production = (extra: Record<string, string> = {}) => ({ NODE_ENV: "production", TRUST_PROXY_HOPS: "1", ...extra });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-boot-"));
  lines = [];
  outbound = [];
  providerDown = false;
});
afterEach(async () => {
  await Promise.all(running.map((b) => new Promise<void>((resolve) => (b.server.listening ? b.stop(resolve) : resolve()))));
  running = [];
  fs.rmSync(dir, { recursive: true, force: true });
});

const listen = (booted: Booted) =>
  new Promise<AddressInfo>((resolve) => {
    booted.start(() => resolve(booted.server.address() as AddressInfo));
  });
const port = () => String(20000 + Math.floor(Math.random() * 20000));

describe("the practice clock", () => {
  it("only goes forward, and ignores anything that is not a finite, positive number of milliseconds", () => {
    let real = 1_000;
    const clock = practiceClock(() => real);
    expect(clock.now()).toBe(1_000);
    for (const bad of [0, -1, -60_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "60000" as unknown as number, undefined as unknown as number, null as unknown as number]) {
      expect(clock.skipAhead(bad), String(bad)).toBe(false);
      expect(clock.now(), String(bad)).toBe(1_000);
    }
    expect(clock.skipAhead(60_000)).toBe(true);
    expect(clock.now()).toBe(61_000);
    // The machine's own time still passes underneath, and a second move adds to the first.
    real = 2_000;
    expect(clock.skipAhead(500)).toBe(true);
    expect(clock.now()).toBe(62_500);
  });
});

describe("start-up wiring", () => {
  it("production, told nothing of regions: no region service at all, nobody refused, and nothing to wait for", async () => {
    for (const env of [production(), production({ REGION_BLOCK: "off" }), production({ REGION_BLOCK: "off", BLOCKED_COUNTRIES: "US,GB" })]) {
      const b = start(env);
      expect(b.config.regionBlock).toBe(false);
      // Ready at once, and no address is refused: one it cannot place, a private one, or none.
      expect(b.geo.ready()).toBe(true);
      for (const ip of ["8.8.8.8", "5.255.255.5", "81.91.130.1", "10.0.0.1", null]) expect(b.geo.check(ip), String(ip)).toEqual({ country: null, blocked: false, reason: null });
      expect(outbound).toEqual([]);
    }
    // Started, it listens and answers at once, and fetches the coin list and the sanctions list only:
    // the region database is never asked for, and nothing is written to disk for it.
    const b = start(production({ PORT: port() }));
    const address = await listen(b);
    const status = await fetch(`http://127.0.0.1:${address.port}/api/status`, { headers: { "x-forwarded-for": "81.91.130.1" } });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { status: string }).status).toBe("paused");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(outbound.some((o) => o.startsWith("download.db-ip.com"))).toBe(false);
    expect(outbound.some((o) => /db-ip|dbip/i.test(o))).toBe(false);
    expect(fs.readdirSync(dir).some((name) => /geo|dbip|mmdb/i.test(name))).toBe(false);
    expect(lines.some((line) => /"event":"geo_/.test(line))).toBe(false);
  });

  it("production with REGION_BLOCK=on: real orders allowed, every interface, region block on and failing closed", () => {
    const b = start(production({ REGION_BLOCK: "on" }));
    expect(b.config.regionBlock).toBe(true);
    expect(b.liveOrders).toBe(true);
    expect(b.practice).toBe(false);
    expect(b.listenHost).toBeUndefined();
    // The real region service, with no database loaded yet: everyone is blocked.
    expect(b.geo.ready()).toBe(false);
    expect(b.geo.check("8.8.8.8")).toEqual({ country: null, blocked: true, reason: "unknown" });
    // Screening has no list yet either: unavailable, so no order could be created.
    expect(b.sanctions.available()).toBe(false);
    // Nothing went out just from building the server.
    expect(outbound).toEqual([]);
  });

  it("development: no real orders, no region block", () => {
    const b = start({ NODE_ENV: "development" });
    expect(b.liveOrders).toBe(false);
    expect(b.practice).toBe(false);
    expect(b.geo.check("8.8.8.8").blocked).toBe(false);
  });

  it("private routing and the partner key: a server told nothing starts in public and says private routing is waiting; told to be private without a key, the live site does not start", () => {
    const KEY = "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc";
    const said = (event: string) => lines.filter((line) => line.includes(`"event":"${event}"`));
    // Nothing set and no key, on the live site and in development alike: it starts, routes in public, and says so once, as a warning.
    for (const env of [production(), { NODE_ENV: "development" }]) {
      lines = [];
      const b = start(env);
      expect(b.config, env.NODE_ENV).toMatchObject({ privacyMode: "public", privateRoutingWaitsForKey: true });
      expect(said("private_routing_waits_for_key"), env.NODE_ENV).toHaveLength(1);
      expect(JSON.parse(said("private_routing_waits_for_key")[0]!), env.NODE_ENV).toMatchObject({ level: "warn" });
      expect(said("starting")[0], env.NODE_ENV).toContain('"privacyMode":"public"');
      expect(said("private_routing_without_partner_key"), env.NODE_ENV).toHaveLength(0);
    }
    // With a key and nothing else set, routing is private and there is nothing to say.
    lines = [];
    expect(start(production({ ONECLICK_API_KEY: KEY })).config.privacyMode).toBe("basic");
    expect(said("starting")[0]).toContain('"privacyMode":"basic"');
    // Set to public by name, likewise: nothing is waiting.
    expect(start(production({ PRIVACY_MODE: "public" })).config.privacyMode).toBe("public");
    expect(start(production({ PRIVACY_MODE: "public", ONECLICK_API_KEY: KEY })).config.privacyMode).toBe("public");
    expect(lines.filter((line) => line.includes("private_routing"))).toEqual([]);

    // Private routing asked for by name with no key. The live site would answer every swap "not available": it does not start.
    lines = [];
    expect(() => start(production({ PRIVACY_MODE: "basic" }))).toThrow(ConfigError);
    expect(() => start(production({ PRIVACY_MODE: "basic" }))).toThrow(/^PRIVACY_MODE: asks for private routing, and the provider answers private quotes only to a partner with a key\. Add ONECLICK_API_KEY, or set PRIVACY_MODE=public$/);
    expect(lines).toEqual([]);
    // Development starts that way, for the practice provider's sake, and says which answers it will get.
    expect(start({ NODE_ENV: "development", PRIVACY_MODE: "basic" }).config.privacyMode).toBe("basic");
    expect(said("private_routing_without_partner_key")).toHaveLength(1);
    expect(JSON.parse(said("private_routing_without_partner_key")[0]!)).toMatchObject({ level: "warn" });
    expect(said("private_routing_waits_for_key")).toHaveLength(0);
    // None of this sent anything anywhere, or opened a port.
    expect(outbound).toEqual([]);
    expect(lines.some((line) => line.includes('"event":"listening"'))).toBe(false);
  });

  it("with the practice provider it listens on this machine only", async () => {
    const b = start({ NODE_ENV: "development", PROVIDER_STUB: "true", PORT: port() });
    expect(b.practice).toBe(true);
    expect(b.liveOrders).toBe(true);
    expect(b.listenHost).toBe("127.0.0.1");
    const address = await listen(b);
    expect(address.address).toBe("127.0.0.1");
    const status = await fetch(`http://127.0.0.1:${address.port}/api/status`);
    expect(await status.json()).toMatchObject({ status: "ok" });
    const config = (await (await fetch(`http://127.0.0.1:${address.port}/api/config`)).json()) as { practice: boolean };
    expect(config.practice).toBe(true);
    expect(lines.some((l) => l.includes("practice_provider_on"))).toBe(true);
    expect(lines.some((l) => l.includes('"localOnly":true'))).toBe(true);
  });

  it("with the practice provider it has sample content to look at: orders in every end state, a token, a reserve, and points for whoever signs in", async () => {
    const b = start({ NODE_ENV: "development", PROVIDER_STUB: "true", PORT: port() });
    const { port: at } = await listen(b);
    const get = async (route: string, headers: Record<string, string> = {}) => (await fetch(`http://127.0.0.1:${at}${route}`, { headers })).json() as Promise<Record<string, unknown>>;
    const config = (await get("/api/config")) as { sampleOrders: string[]; tokenAddress: string; tokenPairAddress: string; reserveAddress: string; session: string };
    expect(config.sampleOrders).toHaveLength(6);
    expect(config).toMatchObject({ tokenAddress: SAMPLE.tokenAddress, tokenPairAddress: SAMPLE.tokenPairAddress, reserveAddress: SAMPLE.reserveAddress });
    const statuses: string[] = [];
    for (const id of config.sampleOrders) statuses.push(String((await get(`/api/orders/${id}`)).status));
    expect(statuses).toEqual(["delivered", "delivered", "refunded", "refunded", "failed", "expired"]);
    expect(statuses.filter((status) => status === "delivered").length).toBeGreaterThanOrEqual(2);
    // The reserve's balance is the sample one, and the chain is not asked for it.
    const rewards = (await get("/api/rewards")) as { reserve: { address: string; balance: string }; weeks: unknown[] };
    expect(rewards.reserve).toMatchObject({ address: SAMPLE.reserveAddress, balance: SAMPLE.reserveBalance });
    // Whoever signs in is given points over three weeks and two paid weeks.
    const account = privateKeyToAccount(`0x${"7".repeat(64)}`);
    const post = async (route: string, body: unknown) => (await fetch(`http://127.0.0.1:${at}${route}`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${at}`, "x-session": config.session }, body: JSON.stringify(body) })).json() as Promise<Record<string, string>>;
    const code = await post("/api/rewards/code", { address: account.address });
    const session = await post("/api/rewards/session", { nonce: code.nonce, signature: await account.signMessage({ message: String(code.message) }) });
    const mine = (await get("/api/rewards/me", { "x-rewards-session": String(session.token) })) as { swaps: { week: string }[]; payouts: { txs: string[] }[]; week: { pointsMicro: string } };
    expect(new Set(mine.swaps.map((swap) => swap.week)).size).toBe(3);
    expect(mine.payouts).toHaveLength(2);
    for (const payout of mine.payouts) expect(payout.txs).toHaveLength(1);
    expect(BigInt(mine.week.pointsMicro) > 0n).toBe(true);
    expect(((await get("/api/rewards")) as { weeks: unknown[] }).weeks).toHaveLength(2);
    // Started again on the same folder: the same six orders, not twelve.
    await new Promise<void>((resolve) => b.stop(resolve));
    const again = start({ NODE_ENV: "development", PROVIDER_STUB: "true", PORT: port() });
    const second = await listen(again);
    expect(((await (await fetch(`http://127.0.0.1:${second.port}/api/config`)).json()) as { sampleOrders: string[] }).sampleOrders).toEqual(config.sampleOrders);
    expect(fs.readdirSync(path.join(dir, "orders")).filter((name) => name.startsWith("SampleOrder"))).toHaveLength(6);
  });

  it("keeps what the operator has set: a practice server with its own token shows that token, and invents no pair for it", () => {
    const base = start({ NODE_ENV: "development", PROVIDER_STUB: "true", PORT: port(), TOKEN_ADDRESS: ADDR.evm3 });
    void base;
    const config = loadConfig({ NODE_ENV: "development", PROVIDER_STUB: "true", DATA_DIR: dir, TOKEN_ADDRESS: ADDR.evm3 });
    expect(withSampleSettings(config)).toMatchObject({ tokenAddress: ADDR.evm3, tokenPairAddress: null, reserveAddress: SAMPLE.reserveAddress });
    const bare = loadConfig({ NODE_ENV: "development", PROVIDER_STUB: "true", DATA_DIR: dir });
    expect(withSampleSettings(bare)).toMatchObject({ tokenAddress: SAMPLE.tokenAddress, tokenPairAddress: SAMPLE.tokenPairAddress, reserveAddress: SAMPLE.reserveAddress });
  });

  it("sample content never exists outside practice mode", async () => {
    // Asked for without practice mode, it refuses.
    expect(() => seedSamples({ practice: false, dataDir: dir, store: null as never, rewards: null as never, now: 0 })).toThrow(/practice mode only/);
    // A server that is not in practice mode has none: no sample orders, no token, no reserve, no points, no closed week.
    for (const env of [{ NODE_ENV: "development", PORT: port() }, production({ PORT: port() })]) {
      const b = start(env);
      expect(b.practice, env.NODE_ENV).toBe(false);
      const { port: at } = await listen(b);
      const config = (await (await fetch(`http://127.0.0.1:${at}/api/config`)).json()) as Record<string, unknown>;
      // (A production server in this test has no location database, and answers every visitor "not available": it says nothing at all.)
      if (env.NODE_ENV === "development") expect(config).toMatchObject({ practice: false, sampleOrders: [], tokenAddress: null, tokenPairAddress: null, reserveAddress: null });
      else expect(JSON.stringify(config)).not.toMatch(/SampleOrder|sampleOrders":\["/);
      expect((await fetch(`http://127.0.0.1:${at}/api/orders/${sampleOrderId(1)}`)).status).not.toBe(200);
      await new Promise<void>((resolve) => b.stop(resolve));
    }
    expect(fs.readdirSync(path.join(dir, "orders"))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "rewards", "entries"))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "rewards", "weeks"))).toEqual([]);
    // The live site cannot be in practice mode at all.
    expect(() => start(production({ PROVIDER_STUB: "true" }))).toThrow(ConfigError);
    // And the one place that asks for sample content asks only when the practice provider is there.
    const source = fs.readFileSync(path.resolve("server", "boot.ts"), "utf8");
    expect(source.match(/seedSamples\(/g)).toHaveLength(1);
    expect(source).toContain("const samples = stub === null ? null : seedSamples({ practice: true,");
    expect(source).toContain("const shown = stub === null ? config : withSampleSettings(config);");
    for (const file of fs.readdirSync(path.resolve("server")).filter((name) => name.endsWith(".ts") && name !== "boot.ts" && name !== "sample.ts")) {
      expect(fs.readFileSync(path.resolve("server", file), "utf8"), file).not.toMatch(/seedSamples|withSampleSettings/);
    }
  });

  it("a practice server leaves a note in its data folder, and the live site does not start on a folder that has one", () => {
    const note = path.join(dir, "rewards", "SAMPLE-CONTENT");
    expect(fs.existsSync(note)).toBe(false);
    expect(start({ NODE_ENV: "development", PROVIDER_STUB: "true", PORT: port() }).practice).toBe(true);
    expect(fs.readFileSync(note, "utf8")).toMatch(/This data folder holds practice content/);
    expect(fs.readdirSync(path.join(dir, "orders")).filter((name) => name.startsWith("SampleOrder"))).toHaveLength(6);
    // The live site does not start on that folder: its orders, points and paid weeks are made up.
    expect(() => start(production({ PORT: port() }))).toThrow(ConfigError);
    expect(() => start(production({ PORT: port() }))).toThrow(/DATA_DIR: this folder holds practice content \(it has a file rewards\/SAMPLE-CONTENT\)\. The live site does not start on it\. Give this server a data folder of its own\./);
    expect(lines.some((line) => line.includes("listening"))).toBe(false);
    // Plain development on a developer's own machine starts, and says in its log what the folder holds.
    expect(lines.some((line) => line.includes("practice_content_in_data_folder"))).toBe(false);
    expect(start({ NODE_ENV: "development", PORT: port() }).practice).toBe(false);
    expect(lines.some((line) => line.includes("practice_content_in_data_folder"))).toBe(true);
    // A practice server starts on it again.
    expect(start({ NODE_ENV: "development", PROVIDER_STUB: "true", PORT: port() }).practice).toBe(true);
    // The note alone is enough to be refused, and without it the same folder is started on.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-boot-other-"));
    try {
      fs.mkdirSync(path.join(other, "rewards"));
      fs.writeFileSync(path.join(other, "rewards", "SAMPLE-CONTENT"), "");
      expect(() => start(production({ DATA_DIR: other }))).toThrow(/holds practice content/);
      fs.rmSync(path.join(other, "rewards", "SAMPLE-CONTENT"));
      expect(start(production({ DATA_DIR: other })).practice).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("starts even when a stored order cannot be put to the points record: it says so in the log, and the other orders are still counted", () => {
    const orders = path.join(dir, "orders");
    fs.mkdirSync(orders, { recursive: true });
    const finished = "2026-10-06T10:00:00.000Z";
    const coin = (symbol: string, chain: string) => ({ id: `${chain}:${symbol}`, symbol, name: symbol, chain, decimals: 18, contract: null });
    const put = (id: string, depositAddress: string, extra: Record<string, unknown> = {}) =>
      fs.writeFileSync(
        path.join(orders, `${id}.json`),
        JSON.stringify({
          v: 1,
          id,
          createdAt: finished,
          pay: "wallet",
          from: coin("ETH", "base"),
          to: coin("BNB", "bsc"),
          amountIn: "500000000000000000",
          amountOut: "1",
          minAmountOut: "1",
          amountInUsd: "1250.00",
          amountOutUsd: "1245.00",
          slippageBps: 100,
          timeEstimate: 30,
          fees: { appBps: 20, appAmount: "1", providerBps: 20, providerAmount: "1" },
          withdrawFee: null,
          refundFee: null,
          recipient: ADDR.evm2,
          refundTo: ADDR.evm,
          sender: ADDR.evm,
          rewardsAddress: ADDR.evm,
          depositAddress,
          depositMemo: null,
          deadline: finished,
          termsVersion: "t",
          screening: { result: "clear", listVersion: "v", checkedAt: finished },
          quoteResponse: null,
          state: { status: "delivered", upstreamStatus: "SUCCESS", statusSince: finished, updatedAt: finished, anchor: 0, depositTxHash: null, depositForwarded: false, details: null, finishedAt: finished, stopped: false, slowAlertSent: false },
          ...extra,
        }),
      );
    // Two delivered orders. The first is a record with no fees on it, as a fault or an older version might leave one: working out its points fails.
    put("A".repeat(27), ADDR.evm2, { fees: undefined });
    put("B".repeat(27), ADDR.evm3);
    const b = start(production());
    expect(b.liveOrders).toBe(true);
    const failures = lines.filter((line) => line.includes("points_not_recorded"));
    expect(failures).toHaveLength(1);
    expect(JSON.parse(failures[0] ?? "{}")).toMatchObject({ level: "error", event: "points_not_recorded", error: "TypeError" });
    // The order is named in the log by a hash, never by its ID.
    expect(failures[0]).not.toContain("A".repeat(27));
    // The order after it was still put to the record.
    expect(fs.readdirSync(path.join(dir, "rewards", "entries"))).toHaveLength(1);
  });

  it("without it, it listens on every interface and serves the API", async () => {
    const b = start({ NODE_ENV: "development", PORT: port() });
    const address = await listen(b);
    expect(["::", "0.0.0.0"]).toContain(address.address);
    const tokens = (await (await fetch(`http://127.0.0.1:${address.port}/api/tokens`)).json()) as { tokens: unknown[] };
    expect(tokens.tokens.length).toBeGreaterThan(20);
    // Starting up fetched the coin list and tried the sanctions list; nothing else.
    expect(outbound.some((o) => o === "1click.chaindefuser.com/v0/tokens")).toBe(true);
    expect(outbound.every((o) => /^(1click\.chaindefuser\.com|sanctionslistservice\.ofac\.treas\.gov|[a-z0-9.-]+)\//.test(o))).toBe(true);
    expect(outbound.some((o) => o.includes("/v0/quote") || o.includes("/v0/status") || o.includes("/v0/deposit"))).toBe(false);
  });

  it("sizes the shared preview limit from the provider budget", () => {
    const b = start(production({ ONECLICK_MAX_PER_MIN: "40" }));
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (b.limiters.quoteGlobal.take("all")) allowed += 1;
    // Four tenths of the budget: all that previews can ever use of it.
    expect(allowed).toBe(16);
  });

  it("refuses new orders above 95% disk use, and keeps refusing when a later reading fails", () => {
    let reading: () => { blocks: number; bavail: number } = () => ({ blocks: 1000, bavail: 500 });
    const b = start(production(), () => reading());
    expect(b.diskFull()).toBe(false);
    b.maintain();
    expect(b.diskFull()).toBe(false);
    reading = () => ({ blocks: 1000, bavail: 40 });
    b.maintain();
    expect(b.diskFull()).toBe(true);
    expect(lines.some((l) => l.includes('"kind":"disk"') && l.includes("96% full"))).toBe(true);
    reading = () => {
      throw new Error("volume unreadable");
    };
    b.maintain();
    expect(b.diskFull()).toBe(true);
    reading = () => ({ blocks: 1000, bavail: 500 });
    b.maintain();
    expect(b.diskFull()).toBe(false);
  });

  it("a full disk reaches the order route of the running server", async () => {
    let reading = { blocks: 1000, bavail: 40 };
    const b = start({ NODE_ENV: "development", PROVIDER_STUB: "true", PORT: port() }, () => reading);
    const address = await listen(b);
    const base = `http://127.0.0.1:${address.port}`;
    const config = (await (await fetch(`${base}/api/config`)).json()) as { session: string };
    const order = async () => {
      const reply = await fetch(`${base}/api/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base, "x-session": config.session },
        body: JSON.stringify({
          from: ASSET.baseEth,
          to: ASSET.arbUsdc,
          amount: "5000000000000000",
          pay: "wallet",
          sender: ADDR.evm,
          recipient: ADDR.evm2,
          refundTo: ADDR.evm,
          termsVersion: TERMS_VERSION,
          termsAccepted: true,
          reviewed: { amountOut: "12000000", minAmountOut: "11880000", totalFeeBps: 40 },
        }),
      });
      return ((await reply.json()) as { error?: { code: string } }).error?.code ?? "ok";
    };
    // Starting up measured the disk: 96% used, so the order is turned away as "busy".
    expect(b.diskFull()).toBe(true);
    expect(await order()).toBe("busy");
    // With room again the same order gets past the disk check (and stops later, at screening or price).
    reading = { blocks: 1000, bavail: 500 };
    b.maintain();
    expect(await order()).not.toBe("busy");
  });

  it("alerts when the provider keeps failing", async () => {
    providerDown = true;
    const b = start(production());
    for (let i = 0; i < 12; i++) await b.oneclick.tokens();
    expect(lines.some((l) => l.includes('"event":"alert"') && l.includes("oneclick_errors") && l.includes("100% of"))).toBe(true);
    expect(b.oneclick.health().degraded).toBe(true);
  });

  it("stops on a bad setting, naming it, before anything else happens", () => {
    expect(() => start({ NODE_ENV: "production" })).toThrow(ConfigError);
    expect(() => start(production({ FEE_BPS: "301" }))).toThrow(/FEE_BPS/);
    // A fee with nowhere to be paid: the server does not start, for a fee on either kind of swap.
    expect(() => start(production({ FEE_BPS: "40" }))).toThrow(/FEE_RECIPIENT: is required while FEE_BPS or FEE_BPS_PRIVATE is above 0/);
    expect(() => start(production({ FEE_BPS_PRIVATE: "20" }))).toThrow(/FEE_RECIPIENT/);
    expect(() => start(production({ PROVIDER_STUB: "true" }))).toThrow(/PROVIDER_STUB/);
    expect(outbound).toEqual([]);
    expect(lines.some((l) => l.includes("listening"))).toBe(false);
  });

  it("never logs a secret while starting", async () => {
    // With a fee set, so that there is a fee recipient to keep out of the log.
    const b = start(production({ FEE_BPS: "40", FEE_RECIPIENT: FEE, ONECLICK_API_KEY: "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc", BASE_RPC_URL: "https://rpc.example/v2/SECRET-RPC-KEY", ALERT_WEBHOOK_URL: "https://hooks.example/SECRET-HOOK", PORT: port() }));
    await listen(b);
    expect(b.config.feeRecipient).toBe(FEE.toLowerCase());
    const text = lines.join("\n");
    for (const secret of ["aaaaaaaaaaaa", "SECRET-RPC-KEY", "SECRET-HOOK", "hooks.example", FEE.toLowerCase()]) expect(text).not.toContain(secret);
    expect(text).toContain('"event":"starting"');
  });
});
