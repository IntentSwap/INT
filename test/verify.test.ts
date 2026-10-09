import { describe, expect, it, vi } from "vitest";
import { createStubProvider } from "../server/stub-provider.ts";
import { MAX_PRIVATE_PROVIDER_FEE_BPS, maxTotalFeeBps, ONECLICK_SIGNING_KEY, QuoteVerificationError, verifyQuoteResponse, type SentQuote } from "../server/verify.ts";
import { ADDR, ASSET, FIXTURE_TOKENS } from "./helpers.ts";

// The provider's signature check is wrapped so one test can observe which key it is given.
// Every other test runs the real check.
type SignatureCheck = (response: unknown, key?: string) => boolean;
const wrapped = vi.hoisted(() => ({ check: vi.fn<SignatureCheck>(), real: null as SignatureCheck | null }));
vi.mock("@defuse-protocol/one-click-sdk-typescript", async (original) => {
  const actual = await original<{ verifyQuoteSignature: SignatureCheck }>();
  wrapped.real = actual.verifyQuoteSignature;
  wrapped.check.mockImplementation(wrapped.real);
  return { ...actual, verifyQuoteSignature: wrapped.check };
});

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const FEE_RECIPIENT = "0x00000000000000000000000000000000000000fe";

function sentQuote(overrides: Partial<SentQuote> = {}): SentQuote {
  return {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: ASSET.baseEth,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ASSET.arbUsdc,
    amount: "5000000000000000",
    recipient: ADDR.evm2,
    recipientType: "DESTINATION_CHAIN",
    refundTo: ADDR.evm,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(NOW + 30 * 60_000).toISOString(),
    quoteWaitingTimeMs: 3000,
    referral: "intentswap",
    confidentiality: "public",
    appFees: [{ recipient: FEE_RECIPIENT, fee: 40 }],
    ...overrides,
  };
}

async function signedBy(sent: SentQuote, change: (body: Record<string, unknown>) => Record<string, unknown> = (b) => b) {
  const stub = createStubProvider({ upstream: null, tokens: FIXTURE_TOKENS, now: () => NOW });
  const result = await stub.provider.quote(change(sent as unknown as Record<string, unknown>));
  if (!result.ok) throw new Error("stub refused the quote");
  return { response: result.data as Record<string, any>, key: stub.signingKey, stub };
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof QuoteVerificationError) return err.reason;
    throw err;
  }
  return "accepted";
}

const check = (sent: SentQuote, response: unknown, key: string, originChain = "base", now = NOW) =>
  reason(() => verifyQuoteResponse({ sent, response, originChain, now, extraSigningKeys: [key] }));

/** A private quote as the server sends one: the level "basic", and no fee of ours. */
/** A private quote as this site sends one: our fee on a private swap, to our own recipient. */
function privateQuote(overrides: Partial<SentQuote> = {}): SentQuote {
  return sentQuote({ confidentiality: "basic", appFees: [{ recipient: FEE_RECIPIENT, fee: 20 }], ...overrides });
}
/** The same with no fee of ours at all, as it is sent where FEE_BPS_PRIVATE is 0. */
function feeFreeQuote(overrides: Partial<SentQuote> = {}): SentQuote {
  const sent = privateQuote(overrides);
  delete sent.appFees;
  return sent;
}
/** Verifies a private quote. Our fee recipient is passed in, because a private request does not name it. */
const verifyPrivate = (sent: SentQuote, response: unknown, key: string) => verifyQuoteResponse({ sent, response, originChain: "base", now: NOW, extraSigningKeys: [key], feeRecipient: FEE_RECIPIENT });
const checkPrivate = (sent: SentQuote, response: unknown, key: string) => reason(() => verifyPrivate(sent, response, key));

describe("verifyQuoteResponse", () => {
  it("accepts a genuine live quote and reads the fees from the echo", async () => {
    const sent = sentQuote();
    const { response, key } = await signedBy(sent);
    const verified = verifyQuoteResponse({ sent, response, originChain: "base", now: NOW, extraSigningKeys: [key] });
    expect(verified).toMatchObject({
      amountIn: "5000000000000000",
      appBps: 20,
      providerBps: 20,
      confidentiality: "public",
      depositAddress: response.quote.depositAddress,
      deadline: sent.deadline,
      depositMemo: null,
      timeEstimate: 30,
    });
    expect(BigInt(verified.minAmountOut)).toBeLessThanOrEqual(BigInt(verified.amountOut));
  });

  it("accepts a genuine preview and gives it no deposit address", async () => {
    const sent = sentQuote({ dry: true });
    const { response, key } = await signedBy(sent);
    const verified = verifyQuoteResponse({ sent, response, originChain: "base", now: NOW, extraSigningKeys: [key] });
    expect(verified.depositAddress).toBeNull();
    expect(verified.deadline).toBeNull();
  });

  it("rejects a quote signed by any key that is not pinned", async () => {
    const sent = sentQuote();
    const { response } = await signedBy(sent);
    expect(reason(() => verifyQuoteResponse({ sent, response, originChain: "base", now: NOW }))).toBe("signature");
    const other = await signedBy(sent);
    expect(check(sent, response, other.key)).toBe("signature");
  });

  it("checks the signature with the provider's pinned key, and with nothing else unless told to", async () => {
    const sent = sentQuote();
    const { response, key } = await signedBy(sent);
    const keysTried: string[] = [];
    // Stand in for the provider's signature check: record which key is asked about, and say yes
    // only for the pinned one. (A response signed by the real key cannot be kept in the repository.)
    wrapped.check.mockImplementation((_response: unknown, candidate?: string) => {
      keysTried.push(String(candidate));
      return candidate === "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
    });
    try {
      expect(reason(() => verifyQuoteResponse({ sent, response, originChain: "base", now: NOW }))).toBe("accepted");
      expect(keysTried).toEqual(["ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc"]);
      expect(ONECLICK_SIGNING_KEY).toBe(keysTried[0]);
      // A check that says no for the pinned key is final when no other key was supplied.
      keysTried.length = 0;
      wrapped.check.mockImplementation((_response: unknown, candidate?: string) => {
        keysTried.push(String(candidate));
        return false;
      });
      expect(reason(() => verifyQuoteResponse({ sent, response, originChain: "base", now: NOW }))).toBe("signature");
      expect(keysTried).toEqual([ONECLICK_SIGNING_KEY]);
      // The practice key is consulted only when it is passed in, and only after the pinned one.
      keysTried.length = 0;
      reason(() => verifyQuoteResponse({ sent, response, originChain: "base", now: NOW, extraSigningKeys: [key] }));
      expect(keysTried).toEqual([ONECLICK_SIGNING_KEY, key]);
    } finally {
      wrapped.check.mockImplementation(wrapped.real!);
    }
  });

  it("rejects any change to a signed field", async () => {
    const sent = sentQuote();
    const { response, key } = await signedBy(sent);
    const tamper = (path: "quote" | "quoteRequest", field: string, value: unknown) => ({ ...response, [path]: { ...response[path], [field]: value } });
    for (const altered of [
      tamper("quote", "amountOut", (BigInt(response.quote.amountOut) + 1n).toString()),
      tamper("quote", "minAmountOut", "1"),
      tamper("quote", "depositAddress", "0x" + "66".repeat(20)),
      tamper("quote", "deadline", new Date(NOW + 90 * 60_000).toISOString()),
      tamper("quoteRequest", "recipient", ADDR.evm3),
      tamper("quoteRequest", "refundTo", ADDR.evm3),
      tamper("quoteRequest", "amount", "1"),
      { ...response, timestamp: new Date(NOW + 1000).toISOString() },
      { ...response, signature: response.signature.slice(0, -2) + "11" },
    ]) {
      expect(check(sent, altered, key)).toBe("signature");
    }
  });

  it("rejects a properly signed quote that answers a different request", async () => {
    const sent = sentQuote();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ recipient: ADDR.evm3 }, "echo:recipient"],
      [{ refundTo: ADDR.evm3 }, "echo:refundTo"],
      [{ amount: "4000000000000000" }, "echo:amount"],
      [{ originAsset: ASSET.arbUsdc, destinationAsset: ASSET.baseEth }, "echo:originAsset"],
      [{ destinationAsset: ASSET.baseUsdc }, "echo:destinationAsset"],
      [{ slippageTolerance: 500 }, "echo:slippageTolerance"],
      [{ swapType: "FLEX_INPUT" }, "echo:swapType"],
      [{ dry: true }, "echo:dry"],
      [{ depositType: "INTENTS" }, "echo:depositType"],
      [{ recipientType: "INTENTS" }, "echo:recipientType"],
      [{ refundType: "INTENTS" }, "echo:refundType"],
      [{ referral: "someone-else" }, "echo:referral"],
      [{ deadline: new Date(NOW + 31 * 60_000).toISOString() }, "echo:deadline"],
      [{ depositMode: "MEMO" }, "echo:depositMode"],
    ];
    for (const [change, expected] of cases) {
      const { response, key } = await signedBy(sent, (body) => ({ ...body, ...change }));
      expect(check(sent, response, key), JSON.stringify(change)).toBe(expected);
    }
  });

  it("rejects modes we never ask for", async () => {
    const sent = sentQuote();
    const { response, key } = await signedBy(sent);
    const withRequest = (extra: Record<string, unknown>) => ({ ...response, quoteRequest: { ...response.quoteRequest, ...extra } });
    expect(check(sent, withRequest({ confidentiality: "advanced" }), key)).toBe("echo:confidentiality");
    expect(check(sent, withRequest({ insured: true }), key)).toBe("echo:insured");
    expect(check(sent, withRequest({ rebates: [{ recipient: "x.near", share: 100 }] }), key)).toBe("echo:rebates");
  });

  it("holds the echoed routing level to the level that was sent, both ways, and never accepts the third level", async () => {
    const withLevel = (response: Record<string, any>, level: unknown) => ({ ...response, quoteRequest: { ...response.quoteRequest, confidentiality: level } });
    // Asked for in public: the echo says "public", or names no level at all. Nothing else will do.
    const sent = sentQuote();
    const { response, key } = await signedBy(sent);
    expect(response.quoteRequest.confidentiality).toBe("public");
    expect(check(sent, response, key)).toBe("accepted");
    expect(check(sent, withLevel(response, undefined), key)).toBe("accepted");
    for (const level of ["basic", "advanced", "BASIC", "Public", "", 1, true, ["public"]]) expect(check(sent, withLevel(response, level), key), JSON.stringify(level)).toBe("echo:confidentiality");
    // Asked for in private: the echo says "basic". An echo that names no level is a public one.
    const priv = privateQuote();
    const answered = await signedBy(priv);
    expect(answered.response.quoteRequest.confidentiality).toBe("basic");
    expect(checkPrivate(priv, answered.response, answered.key)).toBe("accepted");
    expect(verifyPrivate(priv, answered.response, answered.key).confidentiality).toBe("basic");
    for (const level of ["public", undefined, null, "advanced", "Basic", "", true]) expect(checkPrivate(priv, withLevel(answered.response, level), answered.key), JSON.stringify(level)).toBe("echo:confidentiality");
    // The same when the provider itself answers at the other level, properly signed: a private
    // request answered in public, and a public request answered in private.
    const madePublic = await signedBy(priv, (body) => ({ ...body, confidentiality: "public" }));
    expect(checkPrivate(priv, madePublic.response, madePublic.key)).toBe("echo:confidentiality");
    const madePrivate = await signedBy(sent, (body) => ({ ...body, confidentiality: "basic" }));
    expect(check(sent, madePrivate.response, madePrivate.key)).toBe("echo:confidentiality");
    // A quote can only be verified at one of the two levels this site asks for. Were one ever sent
    // at the third, no echo would make it acceptable, not even one that agrees with it.
    const third = sentQuote({ confidentiality: "advanced" as never });
    expect(check(third, withLevel(response, "advanced"), key)).toBe("sent confidentiality");
    expect(check(third, response, key)).toBe("sent confidentiality");
  });

  it("holds a private quote's echo to our fee, never more than was sent, and to one entry of the provider's own beside it", async () => {
    const priv = privateQuote();
    const { response, key } = await signedBy(priv);
    const withFees = (appFees: unknown) => ({ ...response, quoteRequest: { ...response.quoteRequest, appFees } });
    const ours = { recipient: FEE_RECIPIENT, fee: 20 };
    const provider = { recipient: "provider-account", fee: 20 };
    // What the stand-in provider echoes, as the real one did in the previews of 9 Oct 2026: our fee whole, and its own 20 beside it.
    expect(response.quoteRequest.appFees).toEqual([ours, { recipient: expect.any(String), fee: 20 }]);
    expect(verifyPrivate(priv, response, key)).toMatchObject({ appBps: 20, providerBps: 20, confidentiality: "basic" });
    // The figures are the echo's own. The provider's fee was 1 between two dollar coins; a smaller share of ours would be shown as it is.
    expect(verifyPrivate(priv, withFees([ours, { recipient: "provider-account", fee: 1 }]), key)).toMatchObject({ appBps: 20, providerBps: 1 });
    expect(verifyPrivate(priv, withFees([{ ...ours, fee: 10 }, provider]), key)).toMatchObject({ appBps: 10, providerBps: 20 });
    expect(verifyPrivate(priv, withFees([provider, ours]), key)).toMatchObject({ appBps: 20, providerBps: 20 });
    expect(verifyPrivate(priv, withFees([ours]), key)).toMatchObject({ appBps: 20, providerBps: 0 });
    expect(verifyPrivate(priv, withFees([{ recipient: FEE_RECIPIENT.toUpperCase().replace("0X", "0x"), fee: 20 }, provider]), key)).toMatchObject({ appBps: 20, providerBps: 20 });
    // Our fee is never more than was sent, never nothing, and is there exactly once.
    expect(checkPrivate(priv, withFees([{ ...ours, fee: 21 }, provider]), key)).toBe("echo:appFees share");
    expect(checkPrivate(priv, withFees([{ ...ours, fee: 0 }, provider]), key)).toBe("echo:appFees share");
    expect(checkPrivate(priv, withFees([provider]), key)).toBe("echo:appFees recipient");
    for (const none of [undefined, null, []]) expect(checkPrivate(priv, withFees(none), key), String(none)).toBe("echo:appFees recipient");
    expect(checkPrivate(priv, withFees([{ ...ours, fee: 10 }, { ...ours, fee: 10 }, provider]), key)).toBe("echo:appFees recipient");
    // Nobody beside the provider is paid.
    expect(checkPrivate(priv, withFees([ours, provider, { recipient: ADDR.evm3, fee: 5 }]), key)).toBe("echo:appFees private recipient");
    expect(checkPrivate(priv, withFees([ours, provider, { recipient: "other-account", fee: 0 }]), key)).toBe("echo:appFees private recipient");
    // The provider's own fee is bounded as the total of a public quote sent with no fee would be.
    expect(MAX_PRIVATE_PROVIDER_FEE_BPS).toBe(maxTotalFeeBps(0));
    expect(MAX_PRIVATE_PROVIDER_FEE_BPS).toBe(25);
    expect(checkPrivate(priv, withFees([ours, { recipient: "provider-account", fee: 25 }]), key)).toBe("accepted");
    expect(checkPrivate(priv, withFees([ours, { recipient: "provider-account", fee: 26 }]), key)).toBe("echo:appFees private total");
    // Entries are read as strictly as a public quote's.
    for (const fee of [-1, 20.5, "20", 501]) expect(checkPrivate(priv, withFees([ours, { recipient: "provider-account", fee }]), key), String(fee)).toBe("echo:appFees fee");
    expect(checkPrivate(priv, withFees([ours, "provider-account"]), key)).toBe("echo:appFees entry");
    expect(checkPrivate(priv, withFees("none"), key)).toBe("echo:appFees");
    expect(checkPrivate(priv, withFees([ours, provider, provider, provider, provider]), key)).toBe("echo:appFees");
    // A private quote that went out with a fee for anybody but us, with two fees, or with a fee of nothing spelled out, is not one this site sends.
    expect(checkPrivate(privateQuote({ appFees: [{ recipient: ADDR.evm3, fee: 20 }] }), response, key)).toBe("sent fees");
    expect(checkPrivate(privateQuote({ appFees: [ours, ours] }), response, key)).toBe("sent fees");
    for (const fee of [0, -1, 0.5]) expect(checkPrivate(privateQuote({ appFees: [{ recipient: FEE_RECIPIENT, fee }] }), response, key), String(fee)).toBe("sent fees");
    // Without being told where our fee is paid, a private quote cannot be checked, so it is not accepted.
    expect(check(priv, response, key)).toBe("sent fees");
    // A public quote is checked as it always was: it must carry our fee, so the provider's entry alone will not do.
    const sent = sentQuote();
    const answered = await signedBy(sent);
    expect(check(sent, { ...answered.response, quoteRequest: { ...answered.response.quoteRequest, appFees: [provider] } }, answered.key)).toBe("echo:appFees recipient");
    expect(check(sentQuote({ appFees: undefined }), answered.response, answered.key)).toBe("sent fees");
  });

  it("a private quote sent with no fee of ours may pay us nothing: the provider's own entry, or none at all", async () => {
    // FEE_BPS_PRIVATE=0: nothing of ours goes with the request.
    const free = feeFreeQuote();
    const { response, key } = await signedBy(free);
    const withFees = (appFees: unknown) => ({ ...response, quoteRequest: { ...response.quoteRequest, appFees } });
    const provider = { recipient: "provider-account", fee: 20 };
    expect(response.quoteRequest.appFees).toHaveLength(1);
    expect(JSON.stringify(response.quoteRequest.appFees).toLowerCase()).not.toContain(FEE_RECIPIENT.toLowerCase());
    expect(verifyPrivate(free, response, key)).toMatchObject({ appBps: 0, providerBps: 20, confidentiality: "basic" });
    expect(verifyPrivate(free, withFees([provider]), key)).toMatchObject({ appBps: 0, providerBps: 20 });
    expect(verifyPrivate(free, withFees([provider, { recipient: FEE_RECIPIENT, fee: 0 }]), key)).toMatchObject({ appBps: 0, providerBps: 20 });
    for (const none of [undefined, null, []]) expect(verifyPrivate(free, withFees(none), key)).toMatchObject({ appBps: 0, providerBps: 0 });
    // An echo that pays us is not the quote that was asked for: no fee was sent.
    expect(checkPrivate(free, withFees([{ recipient: FEE_RECIPIENT, fee: 20 }]), key)).toBe("echo:appFees private share");
    expect(checkPrivate(free, withFees([{ recipient: FEE_RECIPIENT.toUpperCase().replace("0X", "0x"), fee: 1 }, provider]), key)).toBe("echo:appFees private share");
    // Nor is one that pays anybody beside the provider, or pays the provider more than the bound.
    expect(checkPrivate(free, withFees([provider, { recipient: ADDR.evm3, fee: 5 }]), key)).toBe("echo:appFees private recipient");
    expect(checkPrivate(free, withFees([{ recipient: "provider-account", fee: 26 }]), key)).toBe("echo:appFees private total");
    // The echo of a quote that carried our fee is not the echo of this one.
    const paid = await signedBy(privateQuote());
    expect(checkPrivate(free, { ...response, quoteRequest: { ...response.quoteRequest, appFees: paid.response.quoteRequest.appFees } }, key)).toBe("echo:appFees private share");
  });

  it("checks the fees itself, because the signature does not cover them", async () => {
    const sent = sentQuote();
    const { response, key } = await signedBy(sent);
    const withFees = (appFees: unknown) => ({ ...response, quoteRequest: { ...response.quoteRequest, appFees } });
    const provider = { recipient: "provider-account", fee: 20 };
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT, fee: 20 }, provider]), key)).toBe("accepted");
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT.toUpperCase().replace("0X", "0x"), fee: 20 }, provider]), key)).toBe("accepted");
    expect(check(sent, withFees([{ recipient: ADDR.evm3, fee: 20 }, provider]), key)).toBe("echo:appFees recipient");
    expect(check(sent, withFees([provider]), key)).toBe("echo:appFees recipient");
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT, fee: 10 }, { recipient: FEE_RECIPIENT, fee: 10 }, provider]), key)).toBe("echo:appFees recipient");
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT, fee: 41 }]), key)).toBe("echo:appFees share");
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT, fee: 0 }, provider]), key)).toBe("echo:appFees share");
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT, fee: 20 }, { recipient: "provider-account", fee: 26 }]), key)).toBe("echo:appFees total");
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT, fee: 20 }, { recipient: "provider-account", fee: 480 }]), key)).toBe("echo:appFees total");
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT, fee: 20.5 }, provider]), key)).toBe("echo:appFees fee");
    // A fee under nothing could hide a large one beside it: ours 20, another of 400 and another of -390 would add up to 30.
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT, fee: 20 }, { recipient: "provider-account", fee: 400 }, { recipient: "other-account", fee: -390 }]), key)).toBe("echo:appFees fee");
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT, fee: 20 }, { recipient: "provider-account", fee: -1 }]), key)).toBe("echo:appFees fee");
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT, fee: 20 }, { recipient: "provider-account", fee: 501 }]), key)).toBe("echo:appFees fee");
    expect(check(sent, withFees([{ recipient: FEE_RECIPIENT, fee: "20" }, provider]), key)).toBe("echo:appFees fee");
    expect(check(sent, withFees([]), key)).toBe("echo:appFees");
    expect(check(sent, withFees(undefined), key)).toBe("echo:appFees");
  });

  it("bounds the total fee by what was sent", () => {
    expect(maxTotalFeeBps(40)).toBe(45);
    expect(maxTotalFeeBps(20)).toBe(35);
    expect(maxTotalFeeBps(100)).toBe(100);
    expect(maxTotalFeeBps(300)).toBe(300);
  });

  it("checks every number and deposit detail of a correctly signed live quote", async () => {
    const sent = sentQuote();
    const { response, key, stub } = await signedBy(sent);
    // Each case alters the quote and signs it again with the same key, so only our own checks can catch it.
    const resigned = (quotePatch: Record<string, unknown>, requestPatch: Record<string, unknown> = {}) =>
      stub.sign({ ...response, quote: { ...response.quote, ...quotePatch }, quoteRequest: { ...response.quoteRequest, ...requestPatch } });
    const out = BigInt(response.quote.amountOut);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ depositAddress: "has spaces in it, not an address" }, "quote:depositAddress"],
      [{ depositAddress: "tooshort" }, "quote:depositAddress"],
      [{ depositAddress: undefined }, "quote:depositAddress"],
      [{ depositAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" }, "quote:depositAddress format"],
      [{ depositAddress: sent.recipient }, "quote:depositAddress equals a user address"],
      [{ depositAddress: sent.refundTo }, "quote:depositAddress equals a user address"],
      [{ deadline: undefined }, "quote:deadline"],
      [{ deadline: "tomorrow" }, "quote:deadline"],
      [{ deadline: new Date(NOW + 60_000).toISOString() }, "quote:deadline out of range"],
      [{ depositMemo: "has spaces" }, "quote:depositMemo"],
      [{ timeWhenInactive: "soon" }, "quote:timeWhenInactive"],
      [{ amountIn: "4999999999999999" }, "quote:amountIn differs from request"],
      [{ amountIn: "05000000000000000" }, "quote amounts"],
      [{ minAmountIn: "5000000000000001" }, "quote:minAmountIn"],
      [{ amountOut: "0", minAmountOut: "0" }, "quote:amountOut"],
      [{ minAmountOut: (out + 1n).toString() }, "quote:amountOut"],
      [{ minAmountOut: ((out * 90n) / 100n).toString() }, "quote:minAmountOut below slippage"],
      [{ amountOut: "12.5" }, "quote amounts"],
      [{ amountInUsd: "about twelve" }, "quote usd"],
      [{ timeEstimate: -5 }, "quote:timeEstimate"],
      [{ timeEstimate: "30" }, "quote:timeEstimate"],
      [{ refundFee: "1.5" }, "quote:refundFee"],
      [{ withdrawFee: -1 }, "quote:withdrawFee"],
      [{ virtualChainRecipient: "0x" + "77".repeat(20) }, "quote:virtualChainRecipient"],
      [{ customRecipientMsg: "hello" }, "quote:customRecipientMsg"],
      [{ chainDepositAddresses: [] }, "quote:chainDepositAddresses"],
    ];
    for (const [patch, expected] of cases) {
      expect(check(sent, resigned(patch), key), JSON.stringify(patch)).toBe(expected);
    }
    // Sanity: the unaltered quote, signed again, still passes.
    expect(check(sent, resigned({}), key)).toBe("accepted");
  });

  it("does not turn away a genuine quote over details that do no harm", async () => {
    const sent = sentQuote();
    const { response, key, stub } = await signedBy(sent);
    const resigned = (quotePatch: Record<string, unknown>) => stub.sign({ ...response, quote: { ...response.quote, ...quotePatch } });
    // A deadline far in the future is fine: deposits close at the earlier of it and the one we asked for.
    expect(check(sent, resigned({ deadline: new Date(NOW + 72 * 3_600_000).toISOString() }), key)).toBe("accepted");
    // A memo we did not ask for is kept, not refused: dropping it would lose the deposit.
    const withMemo = resigned({ depositMemo: "123456" });
    expect(check(sent, withMemo, key)).toBe("accepted");
    expect(verifyQuoteResponse({ sent, response: withMemo, originChain: "base", now: NOW, extraSigningKeys: [key] }).depositMemo).toBe("123456");
  });

  it("checks the deposit address strictly only where a chain has a single spelling", async () => {
    const ton = sentQuote({ originAsset: "nep245:v2_1.omni.hot.tg:1117_", amount: "20000000000", refundTo: "UQAREREREREREREREREREREREREREREREREREREREREREbvW" });
    const signedTon = await signedBy(ton);
    expect(check(ton, signedTon.response, signedTon.key, "ton")).toBe("accepted");
    // TON's raw form, and an Aptos address with its leading zeros trimmed, are genuine spellings.
    for (const [chain, address] of [["ton", `0:${"ab".repeat(32)}`], ["aptos", `0x${"ab".repeat(30)}`], ["starknet", `0x${"ab".repeat(26)}`]] as const) {
      const altered = signedTon.stub.sign({ ...signedTon.response, quote: { ...signedTon.response.quote, depositAddress: address } });
      expect(check(ton, altered, signedTon.key, chain), `${chain} ${address}`).toBe("accepted");
    }
    // Something that is not an address at all is still refused there.
    const junk = signedTon.stub.sign({ ...signedTon.response, quote: { ...signedTon.response.quote, depositAddress: "not an address" } });
    expect(check(ton, junk, signedTon.key, "ton")).toBe("quote:depositAddress");
  });

  it("refuses a preview that carries a deposit address", async () => {
    const sent = sentQuote({ dry: true });
    const { response, key, stub } = await signedBy(sent);
    const altered = stub.sign({ ...response, quote: { ...response.quote, depositAddress: "0x" + "66".repeat(20) } });
    expect(check(sent, altered, key)).toBe("dry quote carries a deposit address");
  });

  it("checks deposit details on a correctly signed live quote", async () => {
    // A live quote for a Solana origin must carry a Solana-shaped deposit address.
    const sent = sentQuote({ originAsset: ASSET.solUsdt, destinationAsset: ASSET.arbUsdc, amount: "20000000", refundTo: ADDR.sol });
    const { response, key } = await signedBy(sent);
    expect(check(sent, response, key, "sol")).toBe("accepted");
    // The same signed quote is refused when it is checked as an EVM order.
    expect(check(sent, response, key, "base")).toBe("quote:depositAddress format");
    // A deposit address must be a real address of the origin chain on every chain we can check, not only the wallet chains.
    const bitcoin = sentQuote({ originAsset: ASSET.btc, amount: "1000000", refundTo: ADDR.btc });
    const signedBitcoin = await signedBy(bitcoin);
    expect(check(bitcoin, signedBitcoin.response, signedBitcoin.key, "btc")).toBe("accepted");
    for (const wrong of ["TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "0x" + "66".repeat(20), "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb"]) {
      const altered = signedBitcoin.stub.sign({ ...signedBitcoin.response, quote: { ...signedBitcoin.response.quote, depositAddress: wrong } });
      expect(check(bitcoin, altered, signedBitcoin.key, "btc"), wrong).toBe("quote:depositAddress format");
    }
  });

  it("refuses a response whose own timestamp is far from now", async () => {
    const sent = sentQuote();
    const { response, key } = await signedBy(sent);
    expect(check(sent, response, key, "base", NOW + 9 * 60_000)).toBe("accepted");
    expect(check(sent, response, key, "base", NOW + 11 * 60_000)).toBe("stale timestamp");
    expect(check(sent, response, key, "base", NOW - 11 * 60_000)).toBe("stale timestamp");
  });

  it("compares the deposit address with the person's addresses without regard to case", async () => {
    const sent = sentQuote();
    const { response, key, stub } = await signedBy(sent);
    for (const mine of [sent.recipient.toLowerCase(), sent.refundTo.toLowerCase(), sent.recipient.toUpperCase().replace("0X", "0x")]) {
      const altered = stub.sign({ ...response, quote: { ...response.quote, depositAddress: mine } });
      expect(check(sent, altered, key), mine).toBe("quote:depositAddress equals a user address");
    }
  });

  it("requires a memo exactly when one was asked for", async () => {
    const stellar = sentQuote({ originAsset: ASSET.xlm, amount: "1000000000", refundTo: ADDR.stellar, depositMode: "MEMO" });
    const withMemo = await signedBy(stellar);
    expect(withMemo.response.quote.depositMemo).toMatch(/^\d{6}$/);
    const verified = verifyQuoteResponse({ sent: stellar, response: withMemo.response, originChain: "stellar", now: NOW, extraSigningKeys: [withMemo.key] });
    expect(verified.depositMemo).toBe(withMemo.response.quote.depositMemo);
    const stripped = withMemo.stub.sign({ ...withMemo.response, quote: { ...withMemo.response.quote, depositMemo: undefined } });
    expect(check(stellar, stripped, withMemo.key, "stellar")).toBe("quote:memo expected");
    const odd = withMemo.stub.sign({ ...withMemo.response, quote: { ...withMemo.response.quote, depositMemo: "<b>1</b>" } });
    expect(check(stellar, odd, withMemo.key, "stellar")).toBe("quote:depositMemo");
  });

  it("rejects malformed responses outright", async () => {
    const sent = sentQuote();
    const { response, key } = await signedBy(sent);
    expect(check(sent, null, key)).toBe("response is not an object");
    expect(check(sent, "ok", key)).toBe("response is not an object");
    expect(check(sent, [], key)).toBe("response is not an object");
    expect(check(sent, { ...response, quote: undefined }, key)).toBe("missing quote or quoteRequest");
    expect(check(sent, { ...response, signature: undefined }, key)).toBe("missing signature");
    expect(check(sent, { ...response, signature: "ed25519:short" }, key)).toBe("missing signature");
    expect(check(sent, { ...response, timestamp: "yesterday" }, key)).toBe("missing timestamp");
  });

  it("rejects numbers that make no sense, even when signed", async () => {
    // The stub signs whatever amount it is asked for; verification compares it with what we sent.
    const sent = sentQuote();
    const doubled = await signedBy(sentQuote({ amount: "10000000000000000" }));
    expect(check(sent, doubled.response, doubled.key)).toBe("echo:amount");
  });
});
