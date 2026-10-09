import { describe, expect, it } from "vitest";
import { toChecksumAddress } from "../shared/addresses.ts";
import { ConfigError, DEFAULT_BLOCKED_COUNTRIES, DEFAULT_DEXSCREENER_URL, DEFAULT_GITHUB_URL, DEFAULT_SITE_URL, DEFAULT_X_URL, describeConfig, DEV_FEE_RECIPIENT, isSupportContact, loadConfig } from "../server/config.ts";

const FEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const KEY = "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc";
const production = (extra: Record<string, string> = {}) => ({ NODE_ENV: "production", DATA_DIR: "/data", TRUST_PROXY_HOPS: "1", FEE_RECIPIENT: FEE, ...extra });

function problem(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
  return "accepted";
}

describe("configuration", () => {
  it("treats an unset NODE_ENV as production", () => {
    expect(problem({})).toBe("DATA_DIR: is required in production");
    expect(loadConfig(production()).env).toBe("production");
  });

  it("has safe production defaults", () => {
    const config = loadConfig(production());
    expect(config).toMatchObject({
      port: 8787,
      trustProxyHops: 1,
      oneClickApiKey: null,
      oneClickMaxPerMin: 300,
      feeBps: 40,
      swapsPaused: true,
      providerStub: false,
      reownProjectId: "c0d68cdb58343fb95145440afe216c42",
      tokenAddress: null,
      // The project's own account on X stands behind the X icon unless another is named.
      xUrl: "https://x.com/intentswap_",
      supportContact: null,
      alertWebhookUrl: null,
    });
    expect(config.feeRecipient).toBe(FEE.toLowerCase());
    expect([...config.blockedCountries].sort()).toEqual([...DEFAULT_BLOCKED_COUNTRIES].sort());
    expect(Object.keys(config.rpcUrls).sort()).toEqual(["arb", "base", "bsc", "eth", "sol"]);
  });

  it("blocks every country on the provider's list by default", () => {
    for (const code of ["AF", "BY", "CF", "CU", "CD", "GW", "HT", "IR", "LY", "ML", "MM", "NI", "KP", "RU", "SO", "SS", "SD", "SY", "VE", "YE", "ZW"]) {
      expect(DEFAULT_BLOCKED_COUNTRIES).toContain(code);
    }
    expect(DEFAULT_BLOCKED_COUNTRIES).toHaveLength(21);
  });

  it("requires a real fee recipient, a data folder and the proxy setting in production", () => {
    expect(problem({ NODE_ENV: "production", DATA_DIR: "/data", TRUST_PROXY_HOPS: "1" })).toBe("FEE_RECIPIENT: is required in production");
    expect(problem({ NODE_ENV: "production", FEE_RECIPIENT: FEE, TRUST_PROXY_HOPS: "1" })).toBe("DATA_DIR: is required in production");
    // Guessing the proxy setting would either block every visitor or trust a forged address, so it must be stated.
    expect(problem({ NODE_ENV: "production", DATA_DIR: "/data", FEE_RECIPIENT: FEE })).toBe("TRUST_PROXY_HOPS: is required in production (1 on Railway)");
    expect(loadConfig(production({ TRUST_PROXY_HOPS: "0" })).trustProxyHops).toBe(0);
    expect(loadConfig({ NODE_ENV: "development" }).trustProxyHops).toBe(0);
  });

  it("wants the fee recipient in its checksum form in production, so a typo cannot send fees to nobody", () => {
    expect(problem(production({ FEE_RECIPIENT: toChecksumAddress(DEV_FEE_RECIPIENT) }))).toBe("FEE_RECIPIENT: is still the development placeholder");
    expect(problem(production({ FEE_RECIPIENT: FEE.toLowerCase() }))).toBe("FEE_RECIPIENT: must be copied in its mixed-case (checksum) form, exactly as the wallet shows it");
    expect(problem(production({ FEE_RECIPIENT: FEE.toUpperCase().replace("0X", "0x") }))).toBe("FEE_RECIPIENT: must be copied in its mixed-case (checksum) form, exactly as the wallet shows it");
    // One wrong character in the mixed-case form is caught by the checksum.
    expect(problem(production({ FEE_RECIPIENT: FEE.replace("d8dA", "d8dB") }))).toBe("FEE_RECIPIENT: must be a 0x address or a NEAR account");
    expect(loadConfig(production({ FEE_RECIPIENT: FEE })).feeRecipient).toBe(FEE.toLowerCase());
    // Development is lenient.
    expect(loadConfig({ NODE_ENV: "development", FEE_RECIPIENT: FEE.toLowerCase() }).feeRecipient).toBe(FEE.toLowerCase());
  });

  it("allows a placeholder fee recipient in development only", () => {
    const dev = loadConfig({ NODE_ENV: "development" });
    expect(dev.feeRecipient).toBe(DEV_FEE_RECIPIENT);
    expect(dev.swapsPaused).toBe(false);
  });

  it("accepts a NEAR account as the fee recipient", () => {
    expect(loadConfig(production({ FEE_RECIPIENT: "fees.intentswap.near" })).feeRecipient).toBe("fees.intentswap.near");
  });

  it("refuses the practice provider in production and behind any proxy", () => {
    expect(problem(production({ PROVIDER_STUB: "true" }))).toBe("PROVIDER_STUB: is for local development only");
    expect(problem({ NODE_ENV: "development", PROVIDER_STUB: "true", TRUST_PROXY_HOPS: "1" })).toBe("PROVIDER_STUB: cannot be used behind a proxy; it is for this machine only");
    expect(loadConfig({ NODE_ENV: "development", PROVIDER_STUB: "true" }).providerStub).toBe(true);
  });

  const invalid: Array<[string, Record<string, string>, string]> = [
    ["NODE_ENV", { NODE_ENV: "staging" }, "NODE_ENV"],
    ["PORT", production({ PORT: "eighty" }), "PORT"],
    ["PORT range", production({ PORT: "70000" }), "PORT"],
    ["PORT zero", production({ PORT: "0" }), "PORT"],
    ["TRUST_PROXY_HOPS", production({ TRUST_PROXY_HOPS: "-1" }), "TRUST_PROXY_HOPS"],
    ["TRUST_PROXY_HOPS range", production({ TRUST_PROXY_HOPS: "9" }), "TRUST_PROXY_HOPS"],
    ["ONECLICK_API_KEY", production({ ONECLICK_API_KEY: "not-a-key" }), "ONECLICK_API_KEY"],
    ["ONECLICK_MAX_PER_MIN", production({ ONECLICK_MAX_PER_MIN: "5" }), "ONECLICK_MAX_PER_MIN"],
    ["a routing level this site never asks for", production({ PRIVACY_MODE: "advanced", ONECLICK_API_KEY: KEY }), "PRIVACY_MODE"],
    ["a routing level that is no level", production({ PRIVACY_MODE: "yes" }), "PRIVACY_MODE"],
    ["FEE_RECIPIENT", production({ FEE_RECIPIENT: "0x1234" }), "FEE_RECIPIENT"],
    ["FEE_RECIPIENT checksum", production({ FEE_RECIPIENT: FEE.replace("d8dA", "D8dA") }), "FEE_RECIPIENT"],
    ["FEE_BPS too low", production({ FEE_BPS: "19" }), "FEE_BPS"],
    ["FEE_BPS too high", production({ FEE_BPS: "301" }), "FEE_BPS"],
    ["FEE_BPS decimal", production({ FEE_BPS: "40.5" }), "FEE_BPS"],
    ["SWAPS_PAUSED", production({ SWAPS_PAUSED: "yes" }), "SWAPS_PAUSED"],
    ["BLOCKED_COUNTRIES", production({ BLOCKED_COUNTRIES: "US,Germany" }), "BLOCKED_COUNTRIES"],
    ["BSC_RPC_URL", production({ BSC_RPC_URL: "not a url" }), "BSC_RPC_URL"],
    ["ETH_RPC_URL http", production({ ETH_RPC_URL: "http://rpc.example" }), "ETH_RPC_URL"],
    ["BASE_RPC_URL local http", production({ BASE_RPC_URL: "http://localhost:8545" }), "BASE_RPC_URL"],
    ["ARBITRUM_RPC_URL credentials", production({ ARBITRUM_RPC_URL: "https://user:pass@rpc.example" }), "ARBITRUM_RPC_URL"],
    ["BASE_RPC_URL password only", production({ BASE_RPC_URL: "https://:pass@rpc.example" }), "BASE_RPC_URL"],
    ["ETH_RPC_URL username only", production({ ETH_RPC_URL: "https://user@rpc.example" }), "ETH_RPC_URL"],
    ["ALERT_WEBHOOK_URL credentials", production({ ALERT_WEBHOOK_URL: "https://user:pass@hooks.example/x" }), "ALERT_WEBHOOK_URL"],
    ["SUPPORT_CONTACT script link", production({ SUPPORT_CONTACT: "javascript:alert(1)" }), "SUPPORT_CONTACT"],
    ["SUPPORT_CONTACT data link", production({ SUPPORT_CONTACT: "data:text/html,hello" }), "SUPPORT_CONTACT"],
    ["SUPPORT_CONTACT http link", production({ SUPPORT_CONTACT: "http://example.org/help" }), "SUPPORT_CONTACT"],
    ["SUPPORT_CONTACT plain words", production({ SUPPORT_CONTACT: "call me maybe" }), "SUPPORT_CONTACT"],
    ["SUPPORT_CONTACT too long", production({ SUPPORT_CONTACT: `${"a".repeat(100)}@example.org` }), "SUPPORT_CONTACT"],
    ["SOLANA_RPC_URL", production({ SOLANA_RPC_URL: "ftp://rpc.example" }), "SOLANA_RPC_URL"],
    ["REOWN_PROJECT_ID", production({ REOWN_PROJECT_ID: "abc" }), "REOWN_PROJECT_ID"],
    ["TOKEN_ADDRESS", production({ TOKEN_ADDRESS: "0x1234" }), "TOKEN_ADDRESS"],
    ["a pair address that is not an address", production({ TOKEN_ADDRESS: FEE, TOKEN_PAIR_ADDRESS: "0x1234" }), "TOKEN_PAIR_ADDRESS"],
    ["a pair with no token", production({ TOKEN_PAIR_ADDRESS: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }), "TOKEN_PAIR_ADDRESS"],
    ["a pair that is the token itself", production({ TOKEN_ADDRESS: FEE, TOKEN_PAIR_ADDRESS: FEE.toLowerCase() }), "TOKEN_PAIR_ADDRESS"],
    ["X_URL", production({ X_URL: "https://example.com/intentswap" }), "X_URL"],
    ["X_URL script", production({ X_URL: "javascript:alert(1)" }), "X_URL"],
    ["a DexScreener link on another site", production({ DEXSCREENER_URL: "https://dexscreener.com.example.org/bsc/0xabc" }), "DEXSCREENER_URL"],
    ["a DexScreener link that is not https", production({ DEXSCREENER_URL: "http://dexscreener.com/bsc/0xabc" }), "DEXSCREENER_URL"],
    ["a DexScreener link with a query", production({ DEXSCREENER_URL: "https://dexscreener.com/bsc/0xabc?ref=x" }), "DEXSCREENER_URL"],
    ["a DexScreener link that is a script", production({ DEXSCREENER_URL: "javascript:alert(1)" }), "DEXSCREENER_URL"],
    ["a GitHub link on another site", production({ GITHUB_URL: "https://github.example.org/intentswap" }), "GITHUB_URL"],
    ["a GitHub link that is not https", production({ GITHUB_URL: "http://github.com/intentswap" }), "GITHUB_URL"],
    ["a GitHub link with markup in it", production({ GITHUB_URL: "https://github.com/intentswap/<b>" }), "GITHUB_URL"],
    ["a list of excluded chains that is not chain codes", production({ EXCLUDED_CHAINS: "abs; drop table" }), "EXCLUDED_CHAINS"],
    ["SUPPORT_CONTACT", production({ SUPPORT_CONTACT: "<script>alert(1)</script>" }), "SUPPORT_CONTACT"],
    ["ALERT_WEBHOOK_URL", production({ ALERT_WEBHOOK_URL: "http://hooks.example/x" }), "ALERT_WEBHOOK_URL"],
    ["a site address that is not https", production({ SITE_URL: "http://intentswap.example" }), "SITE_URL"],
    ["a site address with a path", production({ SITE_URL: "https://intentswap.example/app" }), "SITE_URL"],
    ["a site address with a query", production({ SITE_URL: "https://intentswap.example/?a=1" }), "SITE_URL"],
    ["a site address with a login", production({ SITE_URL: "https://user:pw@intentswap.example" }), "SITE_URL"],
    ["a site address that is no address", production({ SITE_URL: '"><script>alert(1)</script>' }), "SITE_URL"],
    // A URL may carry these in its host. A page may not.
    ["a site address with a quote in its host", production({ SITE_URL: 'https://exa"mple.org' }), "SITE_URL"],
    ["a site address with an apostrophe in its host", production({ SITE_URL: "https://exa'mple.org" }), "SITE_URL"],
    ["a site address with a dollar sign in its host", production({ SITE_URL: "https://a$'b.org" }), "SITE_URL"],
    ["a site address with an ampersand in its host", production({ SITE_URL: "https://a&b.org" }), "SITE_URL"],
  ];
  it.each(invalid)("refuses a bad %s", (_label, env, variable) => {
    const message = problem(env);
    expect(message.startsWith(`${variable}:`)).toBe(true);
  });

  it("never repeats a bad value in the error, because it may be a secret", () => {
    const secret = "sk-very-secret-value-123";
    for (const variable of ["ONECLICK_API_KEY", "BSC_RPC_URL", "ALERT_WEBHOOK_URL", "FEE_RECIPIENT", "PORT", "SUPPORT_CONTACT<"]) {
      const message = problem(production({ [variable.replace("<", "")]: variable.endsWith("<") ? `${secret}<` : secret }));
      expect(message).not.toContain(secret);
    }
  });

  it("accepts good values", () => {
    const config = loadConfig(
      production({
        PORT: "3000",
        TRUST_PROXY_HOPS: "1",
        ONECLICK_API_KEY: "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc",
        ONECLICK_MAX_PER_MIN: "600",
        FEE_BPS: "60",
        SWAPS_PAUSED: "false",
        BLOCKED_COUNTRIES: "us, gb",
        BSC_RPC_URL: "https://bsc.example/v1/key123",
        TOKEN_ADDRESS: FEE.toLowerCase(),
        X_URL: "https://x.com/intentswap",
        DEXSCREENER_URL: "https://dexscreener.com/bsc/0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
        GITHUB_URL: "https://github.com/intentswap/intentswap",
        SUPPORT_CONTACT: "help@intentswap.example",
        ALERT_WEBHOOK_URL: "https://hooks.example/services/abc",
      }),
    );
    expect(config).toMatchObject({ port: 3000, trustProxyHops: 1, feeBps: 60, swapsPaused: false, oneClickMaxPerMin: 600, tokenAddress: FEE, tokenPairAddress: null });
    // The three links behind the header's icons. Each is optional; none is set until the operator sets it.
    expect(config).toMatchObject({ xUrl: "https://x.com/intentswap", dexscreenerUrl: "https://dexscreener.com/bsc/0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", githubUrl: "https://github.com/intentswap/intentswap" });
    // Each has an address to start from, in every place a server runs: the project's account on X, its repository, and
    // DexScreener's front page until the token has a page of its own there.
    expect([DEFAULT_X_URL, DEFAULT_GITHUB_URL, DEFAULT_DEXSCREENER_URL]).toEqual(["https://x.com/intentswap_", "https://github.com/IntentSwap/INT", "https://dexscreener.com/"]);
    const started = { xUrl: DEFAULT_X_URL, githubUrl: DEFAULT_GITHUB_URL, dexscreenerUrl: DEFAULT_DEXSCREENER_URL };
    expect(loadConfig(production({}))).toMatchObject(started);
    for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "test" }]) expect(loadConfig(env)).toMatchObject(started);
    expect(loadConfig(production({ X_URL: " ", GITHUB_URL: "", DEXSCREENER_URL: "  " }))).toMatchObject(started);
    // The token's own page, once it has one, is still held to DexScreener's site and to a plain path.
    expect(loadConfig(production({ DEXSCREENER_URL: "https://dexscreener.com" })).dexscreenerUrl).toBe("https://dexscreener.com/");
    for (const wrong of ["https://dexscreener.com.evil.example/", "https://dexscreener.com/?q=1", "https://dexscreener.com/a/b/c/d", "https://evil.example/dexscreener.com/"]) expect(problem(production({ DEXSCREENER_URL: wrong })), wrong).toMatch(/^DEXSCREENER_URL: /);
    expect(loadConfig(production({ GITHUB_URL: "https://github.com/intentswap" })).githubUrl).toBe("https://github.com/intentswap");
    // The pair is optional, and is kept in the same standard spelling as the token.
    expect(loadConfig(production({ TOKEN_ADDRESS: FEE, TOKEN_PAIR_ADDRESS: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" })).tokenPairAddress).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(config.blockedCountries.has("US")).toBe(true);
    expect(config.blockedCountries.has("GB")).toBe(true);
    expect(config.rpcUrls.bsc).toBe("https://bsc.example/v1/key123");
  });

  it("needs a support contact before swaps are switched on in production, and not while they are paused", () => {
    expect(loadConfig(production()).swapsPaused).toBe(true);
    expect(loadConfig(production()).supportContact).toBeNull();
    expect(problem(production({ SWAPS_PAUSED: "false" })).startsWith("SUPPORT_CONTACT: is required before swaps are switched on")).toBe(true);
    expect(loadConfig(production({ SWAPS_PAUSED: "false", SUPPORT_CONTACT: "help@intentswap.example" })).swapsPaused).toBe(false);
    // Local development needs none.
    expect(loadConfig({ NODE_ENV: "development", SWAPS_PAUSED: "false" }).supportContact).toBeNull();
  });

  describe("FEE_BPS_PRIVATE, IntentSwap's fee on a privately routed swap", () => {
    it("is 20 unless it is set, whatever the public fee is, and is in the summary that goes to the log", () => {
      expect(loadConfig(production()).feeBpsPrivate).toBe(20);
      expect(loadConfig(production({ FEE_BPS: "60" }))).toMatchObject({ feeBps: 60, feeBpsPrivate: 20 });
      expect(loadConfig({ NODE_ENV: "development" }).feeBpsPrivate).toBe(20);
      // Left empty is left unset.
      for (const empty of ["", "  "]) expect(loadConfig(production({ FEE_BPS_PRIVATE: empty })).feeBpsPrivate).toBe(20);
      expect(describeConfig(loadConfig(production()))).toMatchObject({ feeBps: 40, feeBpsPrivate: 20 });
    });

    it("is its own setting: a whole number from 0 to 300, and the public fee is not touched by it", () => {
      for (const [set, held] of [["0", 0], ["1", 1], ["20", 20], ["35", 35], ["300", 300]] as const) expect(loadConfig(production({ FEE_BPS_PRIVATE: set })), set).toMatchObject({ feeBps: 40, feeBpsPrivate: held });
      expect(describeConfig(loadConfig(production({ FEE_BPS_PRIVATE: "0" })))).toMatchObject({ feeBpsPrivate: 0 });
    });

    it("stops the server on anything else, and names the setting", () => {
      for (const wrong of ["-1", "301", "20.5", "twenty", "0x14", "1e2", "20 bps"]) expect(problem(production({ FEE_BPS_PRIVATE: wrong })), wrong).toMatch(/^FEE_BPS_PRIVATE: /);
    });
  });

  describe("PRIVACY_MODE, how swaps are routed", () => {
    // The three places a server runs. The live one is told the least it must be told, and nothing about routing.
    const places: Array<[string, Record<string, string>]> = [["production", production()], ["development", { NODE_ENV: "development" }], ["test", { NODE_ENV: "test" }]];
    const WAITS = { privacyMode: "public", privateRoutingWaitsForKey: true };

    it("left unset: private where there is a partner key, and public until there is one, so a site told nothing always starts", () => {
      for (const [place, env] of places) {
        // With a key the provider answers private quotes, so that is how swaps are routed.
        expect(loadConfig({ ...env, ONECLICK_API_KEY: KEY }), place).toMatchObject({ privacyMode: "basic", privateRoutingWaitsForKey: false });
        // Without one it could not work. The server starts, routes in public, and knows that private routing is waiting for a key.
        expect(loadConfig(env), place).toMatchObject(WAITS);
        // Left empty is left unset.
        expect(loadConfig({ ...env, PRIVACY_MODE: "" }), place).toMatchObject(WAITS);
        expect(loadConfig({ ...env, PRIVACY_MODE: "  " }), place).toMatchObject(WAITS);
        expect(loadConfig({ ...env, PRIVACY_MODE: " ", ONECLICK_API_KEY: KEY }).privacyMode, place).toBe("basic");
      }
      // The mode in force, and whether it is waiting, are in the summary that goes to the log.
      expect(describeConfig(loadConfig(production()))).toMatchObject(WAITS);
      expect(describeConfig(loadConfig(production({ ONECLICK_API_KEY: KEY })))).toMatchObject({ privacyMode: "basic", privateRoutingWaitsForKey: false });
    });

    it("basic, written out: private, and the live site does not start that way without a partner key", () => {
      for (const [place, env] of places) expect(loadConfig({ ...env, PRIVACY_MODE: "basic", ONECLICK_API_KEY: KEY }), place).toMatchObject({ privacyMode: "basic", privateRoutingWaitsForKey: false });
      // Asked for by name where it cannot work: the live site would answer every swap "not available", so it says what to set and stops.
      expect(problem(production({ PRIVACY_MODE: "basic" }))).toBe("PRIVACY_MODE: asks for private routing, and the provider answers private quotes only to a partner with a key. Add ONECLICK_API_KEY, or set PRIVACY_MODE=public");
      // Development and tests start: there private routing can be tried with the practice provider, which needs no key.
      for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "test" }]) expect(loadConfig({ ...env, PRIVACY_MODE: "basic" })).toMatchObject({ privacyMode: "basic", privateRoutingWaitsForKey: false });
    });

    it("public, written out: public whatever else is set, and nothing is waiting", () => {
      for (const [place, env] of places) {
        expect(loadConfig({ ...env, PRIVACY_MODE: "public" }), place).toMatchObject({ privacyMode: "public", privateRoutingWaitsForKey: false });
        expect(loadConfig({ ...env, PRIVACY_MODE: "public", ONECLICK_API_KEY: KEY }), place).toMatchObject({ privacyMode: "public", privateRoutingWaitsForKey: false });
      }
    });

    it("anything else stops the server wherever it runs, the provider's third level among them", () => {
      for (const bad of ["advanced", "private", "Basic", "PUBLIC", "true", "off", "basic,public", "basic public"]) {
        for (const [place, env] of places) {
          expect(problem({ ...env, PRIVACY_MODE: bad }), `${bad} in ${place}`).toBe('PRIVACY_MODE: must be "basic" or "public"');
          expect(problem({ ...env, PRIVACY_MODE: bad, ONECLICK_API_KEY: KEY }), `${bad} in ${place}`).toBe('PRIVACY_MODE: must be "basic" or "public"');
        }
      }
    });
  });

  it("keeps the site's own address as an origin: the project's own on the live site unless another is given, and none elsewhere", () => {
    expect(DEFAULT_SITE_URL).toBe("https://intentswap.app");
    // The live site told nothing: its address is the project's own, and the setting is known not to have been made.
    expect(loadConfig(production())).toMatchObject({ siteUrl: DEFAULT_SITE_URL, siteUrlSet: false });
    expect(loadConfig(production({ SITE_URL: "  " }))).toMatchObject({ siteUrl: DEFAULT_SITE_URL, siteUrlSet: false });
    // Set, it is taken as given, and is known to have been set (the sign-in then names it and nothing else).
    expect(loadConfig(production({ SITE_URL: "https://intentswap.example" }))).toMatchObject({ siteUrl: "https://intentswap.example", siteUrlSet: true });
    expect(loadConfig(production({ SITE_URL: DEFAULT_SITE_URL }))).toMatchObject({ siteUrl: DEFAULT_SITE_URL, siteUrlSet: true });
    // A development or test server has none of its own: nothing it serves claims to be the live site.
    for (const env of [{ NODE_ENV: "development" }, { NODE_ENV: "test" }]) expect(loadConfig(env)).toMatchObject({ siteUrl: null, siteUrlSet: false });
    expect(loadConfig(production({ SITE_URL: "https://IntentSwap.example/" })).siteUrl).toBe("https://intentswap.example");
    expect(loadConfig(production({ SITE_URL: "https://intentswap.example:8443" })).siteUrl).toBe("https://intentswap.example:8443");
  });

  it("accepts a support contact that is an email address, an https link or a handle", () => {
    for (const contact of ["help@intentswap.example", "support+swaps@mail.example.org", "https://t.me/intentswap_help", "https://example.org/support?topic=swap", "@intentswap"]) {
      expect(isSupportContact(contact), contact).toBe(true);
      expect(loadConfig(production({ SUPPORT_CONTACT: contact })).supportContact).toBe(contact);
    }
    for (const contact of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "mailto:a@b.co", "//evil.example", "https://user:pw@example.org", "https://localhost", "a@b", "@", "<b>@x.co", "x y@z.co", ""]) {
      expect(isSupportContact(contact), contact).toBe(false);
    }
  });

  it("lets BLOCKED_COUNTRIES add to the built-in list but never remove from it", () => {
    const config = loadConfig(production({ BLOCKED_COUNTRIES: "US" }));
    for (const code of DEFAULT_BLOCKED_COUNTRIES) expect(config.blockedCountries.has(code)).toBe(true);
    expect(config.blockedCountries.size).toBe(DEFAULT_BLOCKED_COUNTRIES.length + 1);
  });

  it("is frozen", () => {
    const config = loadConfig(production());
    expect(() => {
      (config as { feeBps: number }).feeBps = 0;
    }).toThrow();
  });

  it("describes itself for the log without secrets or full RPC URLs", () => {
    const config = loadConfig(
      production({
        ONECLICK_API_KEY: "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc",
        BSC_RPC_URL: "https://bsc.example/v1/SECRET-PATH-KEY",
        ALERT_WEBHOOK_URL: "https://hooks.example/services/SECRET-HOOK",
      }),
    );
    const text = JSON.stringify(describeConfig(config));
    for (const secret of ["aaaaaaaaaaaa", "SECRET-PATH-KEY", "SECRET-HOOK", "hooks.example", FEE.toLowerCase()]) expect(text).not.toContain(secret);
    expect(text).toContain("bsc.example");
    expect(describeConfig(config)).toMatchObject({ partnerKey: true, alerts: true, feeRecipientSet: true });
  });
});
