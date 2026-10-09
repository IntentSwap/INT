import { afterEach, describe, expect, it } from "vitest";
import { ALLOWLIST } from "../server/allowlist.ts";
import { compareWithAllowlist, parseRawToken } from "../server/tokens.ts";
import { checkAddress } from "../shared/addresses.ts";
import { loadConfig } from "../server/config.ts";
import { chainInfo } from "../shared/chains.ts";
import { chainsOnList, listCounts } from "../web/src/lib/site-logic.ts";
import { CHAIN_ICONS } from "../web/src/lib/icons.ts";
import { ADDR, asOrder, ASSET, FIXTURE_TOKENS, harness, type Harness, type HarnessOptions } from "./helpers.ts";

let open: Harness[] = [];
async function start(options: HarnessOptions = {}): Promise<Harness> {
  const h = await harness(options);
  open.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(open.map((h) => h.close()));
  open = [];
});

const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDC_BASE_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function listWith(change: (token: Record<string, unknown>) => Record<string, unknown> | null): unknown[] {
  return (FIXTURE_TOKENS as Array<Record<string, unknown>>).flatMap((token) => {
    const next = change({ ...token });
    return next === null ? [] : [next];
  });
}

describe("the allowlist itself", () => {
  it("has unique, well-formed entries on wallet chains only", () => {
    const ids = new Set<string>();
    for (const coin of ALLOWLIST) {
      expect(ids.has(coin.assetId)).toBe(false);
      ids.add(coin.assetId);
      expect(["bsc", "eth", "base", "arb"]).toContain(coin.chain);
      if (coin.contractAddress !== null) {
        expect(coin.contractAddress).toBe(coin.contractAddress.toLowerCase());
        expect(checkAddress(coin.chain, coin.contractAddress).ok).toBe(true);
      }
      expect(coin.decimals).toBeGreaterThanOrEqual(0);
      expect(coin.name.length).toBeGreaterThan(0);
    }
    for (const chain of ["bsc", "eth", "base", "arb"]) {
      expect(ALLOWLIST.filter((c) => c.chain === chain && c.contractAddress === null)).toHaveLength(1);
    }
  });
});

describe("parsing the provider's list", () => {
  it("accepts well-formed entries", () => {
    expect(parseRawToken({ assetId: ASSET.baseEth, symbol: "ETH", blockchain: "base", decimals: 18, price: 2500 })).toEqual({
      assetId: ASSET.baseEth,
      symbol: "ETH",
      blockchain: "base",
      decimals: 18,
      price: 2500,
      contractAddress: null,
    });
  });

  it("drops malformed entries", () => {
    const good = { assetId: ASSET.baseEth, symbol: "ETH", blockchain: "base", decimals: 18, price: 2500 };
    for (const bad of [
      null,
      "ETH",
      { ...good, assetId: "has spaces" },
      { ...good, assetId: "<script>" },
      { ...good, symbol: "<b>ETH</b>" },
      { ...good, symbol: "" },
      { ...good, blockchain: "Base Chain" },
      { ...good, decimals: 18.5 },
      { ...good, decimals: -1 },
      { ...good, decimals: 99 },
      { ...good, decimals: "18" },
      { ...good, price: -1 },
      { ...good, price: Number.POSITIVE_INFINITY },
      { ...good, price: "2500" },
      { ...good, contractAddress: "0x12 34" },
      { ...good, contractAddress: 5 },
    ]) {
      expect(parseRawToken(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("compares an entry with the allowlist", () => {
    const allowed = ALLOWLIST.find((c) => c.assetId === USDC_BASE)!;
    const raw = { assetId: USDC_BASE, symbol: "USDC", blockchain: "base", decimals: 6, price: 1, contractAddress: USDC_BASE_CONTRACT };
    expect(compareWithAllowlist(raw, allowed)).toBe("ok");
    expect(compareWithAllowlist({ ...raw, contractAddress: USDC_BASE_CONTRACT.toUpperCase().replace("0X", "0x") }, allowed)).toBe("ok");
    expect(compareWithAllowlist({ ...raw, decimals: 18 }, allowed)).toBe("mismatch");
    expect(compareWithAllowlist({ ...raw, contractAddress: "0x" + "66".repeat(20) }, allowed)).toBe("mismatch");
    expect(compareWithAllowlist({ ...raw, contractAddress: null }, allowed)).toBe("mismatch");
    expect(compareWithAllowlist({ ...raw, blockchain: "arb" }, allowed)).toBe("mismatch");
    expect(compareWithAllowlist(raw, undefined)).toBe("not_listed");
  });
});

describe("coin list service", () => {
  it("marks allowlisted coins as wallet-payable once the chain confirms their decimals", async () => {
    const h = await start();
    const snapshot = (await h.tokens.snapshot())!;
    const wallet = snapshot.tokens.filter((t) => t.wallet).map((t) => t.id);
    expect(wallet.sort()).toEqual(ALLOWLIST.map((c) => c.assetId).sort());
    expect(snapshot.byId.get(ASSET.solUsdt)?.wallet).toBe(false);
    expect(snapshot.byId.get(ASSET.pepe)?.wallet).toBe(false);
    expect(h.rpc.calls.filter((c) => c.call.method === "eth_call").length).toBe(ALLOWLIST.filter((c) => c.contractAddress !== null).length);
  });

  it("hides deprecated coins and coins without a price", async () => {
    const h = await start();
    h.tap.tokensResult = { ok: true, status: 200, data: listWith((t) => (t.assetId === ASSET.sol ? { ...t, price: 0 } : t)) };
    const snapshot = (await h.tokens.snapshot())!;
    expect(snapshot.tokens.some((t) => t.symbol.includes("DEPRECATED"))).toBe(false);
    expect(snapshot.byId.has(ASSET.sol)).toBe(false);
    expect(snapshot.byId.has(ASSET.solUsdt)).toBe(true);
  });

  it("disables a coin and alerts when the provider's entry differs from the allowlist", async () => {
    const h = await start();
    h.tap.tokensResult = {
      ok: true,
      status: 200,
      data: listWith((t) => (t.assetId === USDC_BASE ? { ...t, contractAddress: "0x" + "66".repeat(20) } : t)),
    };
    const snapshot = (await h.tokens.snapshot())!;
    expect(snapshot.byId.has(USDC_BASE)).toBe(false);
    expect(snapshot.byId.get(ASSET.baseEth)?.wallet).toBe(true);
    const alert = h.alerts.find((a) => a.kind === "token_mismatch");
    expect(alert?.text).toContain("USDC");
    expect(alert?.text).toContain("base");

    const decimals = await start();
    decimals.tap.tokensResult = { ok: true, status: 200, data: listWith((t) => (t.assetId === USDC_BASE ? { ...t, decimals: 18 } : t)) };
    expect((await decimals.tokens.snapshot())!.byId.has(USDC_BASE)).toBe(false);
    expect(decimals.alerts.map((a) => a.kind)).toContain("token_mismatch");
  });

  it("disables a coin and alerts when the chain reports different decimals", async () => {
    const h = await start();
    h.rpc.decimals.set(USDC_BASE_CONTRACT, 18);
    const snapshot = (await h.tokens.snapshot())!;
    expect(snapshot.byId.has(USDC_BASE)).toBe(false);
    expect(h.alerts.map((a) => a.kind)).toContain("token_mismatch");
    // Other coins are unaffected.
    expect(snapshot.byId.get(ASSET.arbUsdc)?.wallet).toBe(true);
  });

  it("keeps a coin listed but not wallet-payable while the chain cannot be reached", async () => {
    const h = await start();
    h.rpc.down = true;
    const snapshot = (await h.tokens.snapshot())!;
    const usdc = snapshot.byId.get(USDC_BASE);
    expect(usdc).toBeDefined();
    expect(usdc?.wallet).toBe(false);
    // Native coins need no contract check.
    expect(snapshot.byId.get(ASSET.baseEth)?.wallet).toBe(true);
    expect(h.alerts).toHaveLength(0);
  });

  it("offers one Bitcoin entry, under the ID the provider answers with", async () => {
    const h = await start();
    const snapshot = (await h.tokens.snapshot())!;
    const bitcoin = snapshot.tokens.filter((t) => t.chain === "btc");
    expect(bitcoin).toHaveLength(1);
    expect(bitcoin[0]).toMatchObject({ id: "1cs_v1:btc:native:coin", symbol: "BTC", name: "Bitcoin" });
    expect(snapshot.byId.has("nep141:btc.omft.near")).toBe(false);
    // A quote for the old ID is refused before it reaches the provider.
    const reply = await h.quote({ from: "nep141:btc.omft.near", to: ASSET.arbUsdc, amount: "1000000", pay: "manual" });
    expect(reply.body.error.code).toBe("invalid_asset");
    expect(h.tap.quotes).toHaveLength(0);
  });

  it("keeps the old ID if the provider ever stops listing the new one", async () => {
    const h = await start();
    h.tap.tokensResult = { ok: true, status: 200, data: listWith((t) => (t.assetId === "1cs_v1:btc:native:coin" ? null : t)) };
    const snapshot = (await h.tokens.snapshot())!;
    expect(snapshot.tokens.filter((t) => t.chain === "btc").map((t) => t.id)).toEqual(["nep141:btc.omft.near"]);
  });

  it("is not confused by provider text that matches a built-in property name", async () => {
    const h = await start();
    h.tap.tokensResult = { ok: true, status: 200, data: [...FIXTURE_TOKENS, { assetId: "nep141:odd.near", symbol: "constructor", blockchain: "near", decimals: 18, price: 1 }, { assetId: "nep141:odd2.near", symbol: "toString", blockchain: "near", decimals: 18, price: 1 }] };
    const snapshot = (await h.tokens.snapshot())!;
    expect(snapshot.byId.get("nep141:odd.near")?.name).toBe("constructor");
    expect(snapshot.byId.get("nep141:odd2.near")?.name).toBe("toString");
    for (const view of snapshot.views) expect(typeof view.name).toBe("string");
  });

  it("caches for 60 seconds", async () => {
    const h = await start();
    await h.tokens.snapshot();
    await h.tokens.snapshot();
    h.clock.t += 59_000;
    await h.tokens.snapshot();
    expect(h.stub.calls.tokens).toBe(1);
    h.clock.t += 2000;
    await h.tokens.snapshot();
    await h.tokens.refresh();
    expect(h.stub.calls.tokens).toBe(2);
  });

  it("serves the last good list for up to 24 hours when refreshes fail validation", async () => {
    const h = await start();
    const good = (await h.tokens.snapshot())!;
    for (const broken of [
      { ok: true, status: 200, data: [] } as const,
      { ok: true, status: 200, data: "not a list" } as const,
      { ok: true, status: 200, data: FIXTURE_TOKENS.slice(0, 25) } as const, // lost more than half
      { ok: true, status: 200, data: FIXTURE_TOKENS.map(() => ({ junk: true })) } as const,
      { ok: false, kind: "unavailable", status: 503 } as const,
    ]) {
      h.tap.tokensResult = broken;
      h.clock.t += 61_000;
      await h.tokens.refresh();
      const served = await h.tokens.snapshot();
      expect(served?.tokens.length).toBe(good.tokens.length);
      expect(served?.updatedAt).toBe(good.updatedAt);
    }
    h.clock.t = good.updatedAt + 24 * 3_600_000 + 1000;
    expect(await h.tokens.snapshot()).toBeNull();
    const reply = await h.get("/api/tokens");
    expect(reply.status).toBe(503);
    expect(reply.body.error).toEqual({ code: "unavailable", message: "Couldn't load coins." });
  });

  it("recovers from disk after a restart while the provider is down", async () => {
    const h = await start();
    await h.tokens.snapshot();
    const { createTokenService } = await import("../server/tokens.ts");
    const restarted = createTokenService({
      oneclick: { ...h.stub.provider, tokens: async () => ({ ok: false, kind: "unavailable", status: null }) },
      rpc: h.rpc,
      alerts: { send() {} },
      log: { info() {}, warn() {}, error() {} },
      dataDir: h.dataDir,
      now: () => h.clock.t + 3_600_000,
    });
    const snapshot = await restarted.snapshot();
    expect(snapshot?.byId.has(ASSET.baseEth)).toBe(true);
  });
});

describe("chains that are left off the site", () => {
  // Two coins on the Abstract chain, as the provider lists them: the chain's own coin and a token.
  const ABS_ETH = "nep141:abs.omft.near";
  const ABS_TOKEN = "nep141:abs-0x2a3a1ee4d3b8b9a1d8d6d7c2ed1f3c5b6a7c8d9e.omft.near";
  const withAbstract = [
    ...FIXTURE_TOKENS,
    { assetId: ABS_ETH, symbol: "ETH", blockchain: "abs", decimals: 18, price: 2500 },
    { assetId: ABS_TOKEN, symbol: "PENGU", blockchain: "abs", decimals: 18, price: 0.03, contractAddress: "0x2a3a1ee4d3b8b9a1d8d6d7c2ed1f3c5b6a7c8d9e" },
  ];

  it("by default the Abstract chain's coins never reach the coin list, and the counts are made without them", async () => {
    const h = await start();
    const plain = (await h.get("/api/tokens")).body.tokens as { id: string; chain: string }[];
    h.tap.tokensResult = { ok: true, status: 200, data: withAbstract };
    h.clock.t += 61_000;
    await h.tokens.refresh();
    const listed = (await h.get("/api/tokens")).body.tokens as { id: string; chain: string }[];
    expect(listed.some((token) => token.chain === "abs")).toBe(false);
    expect(listed.map((token) => token.id).sort()).toEqual(plain.map((token) => token.id).sort());
    const snapshot = (await h.tokens.snapshot())!;
    expect(snapshot.byId.has(ABS_ETH) || snapshot.byId.has(ABS_TOKEN)).toBe(false);
    // What the pages count and list (the facts, the strip of chains, the Docs' table, the picker's chips) comes from this list alone.
    expect(listCounts(listed)).toEqual(listCounts(plain));
    expect(chainsOnList(listed).map((chain) => chain.key)).not.toContain("abs");
    expect(chainsOnList(listed)).toEqual(chainsOnList(plain));
  });

  it("the check proves something: a chain is listed until it is excluded, and it is the exclusion that takes it off", async () => {
    const usual = await start();
    const onTron = (await usual.tokens.snapshot())!.tokens.filter((token) => token.chain === "tron").length;
    expect(onTron).toBeGreaterThan(0);
    const without = await start({ env: { EXCLUDED_CHAINS: "tron" } });
    const snapshot = (await without.tokens.snapshot())!;
    expect(snapshot.tokens.some((token) => token.chain === "tron")).toBe(false);
    expect(snapshot.tokens).toHaveLength((await usual.tokens.snapshot())!.tokens.length - onTron);
  });

  it("no setting brings the Abstract chain back: the setting adds to the built-in list and cannot take from it", async () => {
    for (const setting of ["none", "tron", "", "ABS", "-abs", "!abs"]) {
      let h: Harness;
      try {
        h = await start({ env: { EXCLUDED_CHAINS: setting } });
      } catch (error) {
        // A value that is not a list of chain codes stops the server starting, which also brings nothing back.
        expect(String(error), setting).toMatch(/EXCLUDED_CHAINS/);
        continue;
      }
      expect(h.config.excludedChains.has("abs"), setting).toBe(true);
      h.tap.tokensResult = { ok: true, status: 200, data: withAbstract };
      expect((await h.tokens.snapshot())!.tokens.some((token) => token.chain === "abs"), setting).toBe(false);
    }
  });

  it("a quote or an order that names a coin on an excluded chain is refused like any unknown coin, before it reaches the provider", async () => {
    const h = await start();
    h.tap.tokensResult = { ok: true, status: 200, data: withAbstract };
    for (const body of [
      { from: ABS_ETH, to: ASSET.arbUsdc, amount: "1000000000000000000", pay: "manual" },
      { from: ASSET.baseEth, to: ABS_TOKEN, amount: "500000000000000000", pay: "manual", recipient: ADDR.evm2 },
    ]) {
      const quote = await h.quote(body);
      expect(quote.status).toBe(400);
      expect(quote.body.error.code).toBe("invalid_asset");
      const unknown = await h.quote({ ...body, from: body.from === ABS_ETH ? "nep141:no-such-coin.near" : body.from, to: body.to === ABS_TOKEN ? "nep141:no-such-coin.near" : body.to });
      expect(quote.body.error).toEqual(unknown.body.error);
    }
    // (An order is sent with the numbers its review showed; here they are made up, since no preview can be had.)
    const reviewed = { amountOut: "1", minAmountOut: "1", totalFeeBps: 40 };
    const order = await h.order({ from: ABS_ETH, reviewed });
    expect(order.status).toBe(400);
    expect(order.body.error.code).toBe("invalid_asset");
    const other = await h.order({ to: ABS_TOKEN, recipient: ADDR.evm2, reviewed });
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe("invalid_asset");
    expect(h.tap.quotes).toHaveLength(0);
    expect(h.store.ids()).toHaveLength(0);
  });

  it("the list of excluded chains is a setting that adds to the built-in one, and anything that is not a chain code is refused at start", () => {
    const env = { NODE_ENV: "test", DATA_DIR: "data" };
    expect([...loadConfig(env).excludedChains]).toEqual(["abs"]);
    expect([...loadConfig({ ...env, EXCLUDED_CHAINS: "  " }).excludedChains]).toEqual(["abs"]);
    expect([...loadConfig({ ...env, EXCLUDED_CHAINS: "abs, Tron ,adi," }).excludedChains]).toEqual(["abs", "tron", "adi"]);
    expect([...loadConfig({ ...env, EXCLUDED_CHAINS: "tron" }).excludedChains]).toEqual(["abs", "tron"]);
    for (const bad of ["abs;tron", "abs tron", "<abs>", "a".repeat(33)]) expect(() => loadConfig({ ...env, EXCLUDED_CHAINS: bad }), bad).toThrow(/^EXCLUDED_CHAINS: /);
  });

  it("an order made before its chain was excluded is still shown, and still tracked to its end", async () => {
    const before = await start();
    const order = asOrder(await before.order());
    const record = before.store.get(order.id)!;
    expect(record.to.chain).toBe("arb");

    const after = await start({ env: { EXCLUDED_CHAINS: "arb" } });
    expect(((await after.get("/api/tokens")).body.tokens as { chain: string }[]).some((token) => token.chain === "arb")).toBe(false);
    after.store.create(record);
    const read = await after.get(`/api/orders/${order.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: order.id, status: "waiting", to: { symbol: "USDC", chain: "arb" }, depositAddress: order.depositAddress });
    // The provider says the swap is done: the order's page says so too.
    after.tap.statusReply = (address) => ({ ok: true as const, status: 200, data: { status: "SUCCESS", quoteResponse: { quote: { depositAddress: address } }, swapDetails: { originChainTxHashes: [{ hash: `0x${"ab".repeat(32)}` }], depositedAmount: record.amountIn, amountOut: record.amountOut } } });
    after.clock.t = before.clock.t + 6000;
    await after.poller.recheck(order.id);
    expect(after.store.get(order.id)?.state.status).toBe("delivered");
    expect((await after.get(`/api/orders/${order.id}`)).body.status).toBe("delivered");
    // And nothing new can be started on that chain.
    expect((await after.quote({ from: ASSET.baseEth, to: record.to.id, amount: "500000000000000000", pay: "manual" })).body.error.code).toBe("invalid_asset");
  });

  it("nothing of the Abstract chain is left in the site's own tables: no name, no icon, no explorer", () => {
    expect(chainInfo("abs")).toEqual({ key: "abs", name: "ABS", family: "generic" });
    expect(CHAIN_ICONS.has("abs")).toBe(false);
  });
});
