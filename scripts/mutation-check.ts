// Switches off one protection at a time and checks that the test suite notices.
// Every change is made in a throwaway copy of the project, never in the project
// itself, so an interrupted run cannot leave a protection switched off.
//
//   npx tsx scripts/mutation-check.ts            every protection (about half an hour: the whole test suite runs once for each)
//   npx tsx scripts/mutation-check.ts verify     only those whose file or label contains "verify" (several words may be given)
//
// A protection that can be removed without any test failing is reported as MISSED.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Mutation {
  file: string;
  /** Exact text to find. */
  find: string;
  /** What to put in its place. */
  replace: string;
  /** What is being switched off, in a few words. */
  label: string;
}

const M: Mutation[] = [
  // ---- quote verification ----
  { file: "server/verify.ts", find: "for (const key of [ONECLICK_SIGNING_KEY, ...(options.extraSigningKeys ?? [])]) {", replace: "for (const key of [...(options.extraSigningKeys ?? [])]) {", label: "the pinned signing key is used" },
  { file: "server/verify.ts", find: 'if (!signed) reject("signature");', replace: "", label: "the signature is checked" },
  { file: "server/verify.ts", find: "if (quoteRequest[key] !== sent[key]) reject(`echo:${key}`);", replace: "", label: "the echoed request is compared" },
  { file: "server/verify.ts", find: "    if (ours !== 1) reject(\"echo:appFees recipient\");\n    if (appBps < 1 || appBps > sentFee.fee) reject(\"echo:appFees share\");\n    if (appBps + providerBps", replace: "    if (appBps < 1 || appBps > sentFee.fee) reject(\"echo:appFees share\");\n    if (appBps + providerBps", label: "the fee recipient is checked" },
  { file: "server/verify.ts", find: 'if (appBps + providerBps > maxTotalFeeBps(sentFee.fee)) reject("echo:appFees total");', replace: "", label: "the total fee is bounded" },
  { file: "server/verify.ts", find: 'if (Math.abs(stamped - now) > MAX_TIMESTAMP_SKEW_MS) reject("stale timestamp");', replace: "", label: "a stale response is refused" },
  { file: "server/verify.ts", find: 'if (amountIn !== BigInt(sent.amount)) reject("quote:amountIn differs from request");', replace: "", label: "the amount in matches the request" },
  { file: "server/verify.ts", find: 'if (STRICT_DEPOSIT_FAMILIES.has(chainInfo(originChain).family) && !checkAddress(originChain, quote.depositAddress).ok) reject("quote:depositAddress format");', replace: "", label: "the deposit address is a real address of the chain" },

  // ---- order creation ----
  { file: "server/app.ts", find: "          if (!screening.ok) {\n            ctx.logScreening = screening.reason;\n            if (screening.reason === \"unavailable\") throw new HttpError(503, \"try_later\", \"Try again shortly.\");\n            throw new HttpError(403, \"blocked\", \"This swap can't be processed.\");\n          }\n          ctx.logScreening = \"clear\";", replace: '          ctx.logScreening = "clear";', label: "addresses are screened before an order" },
  { file: "server/app.ts", find: "              worseByMoreThan(seen.amountOut, BigInt(verified.amountOut), PRICE_TOLERANCE_BPS) ||", replace: "", label: "a moved price needs a new confirmation" },
  { file: "server/app.ts", find: "              feeBps > seen.totalFeeBps;", replace: "              false;", label: "a higher fee needs a new confirmation" },
  { file: "server/app.ts", find: '            reserve("orderPerRecipient", recipientKey);', replace: "", label: "orders per receiving address are limited" },
  { file: "server/app.ts", find: '            reserve("orderCreateDaily", ctx.ipKey);', replace: "", label: "orders per client per day are limited" },
  { file: "server/app.ts", find: '            limited("orderLiveDaily", ctx.ipKey);', replace: "", label: "real provider orders per client per day are limited" },
  { file: "server/app.ts", find: '          limited("orderAttemptDaily", ctx.ipKey);', replace: "", label: "order attempts per client per day are limited" },
  { file: "server/app.ts", find: "            if (unpaid.client >= MAX_UNPAID_PER_CLIENT || unpaid.network >= MAX_UNPAID_PER_NETWORK) {", replace: "            if (false) {", label: "unpaid orders per client are limited" },
  { file: "server/app.ts", find: "            bump(ipKey, 1);", replace: "", label: "orders still being created count as unpaid" },
  { file: "server/app.ts", find: "            if (ctx.wideKey !== null) reserve(\"orderCreateDailyWide\", ctx.wideKey);", replace: "", label: "created orders are counted by /48" },
  { file: "server/app.ts", find: "          if (ctx.wideKey !== null) limited(\"orderAttemptDailyWide\", ctx.wideKey);", replace: "", label: "order attempts are counted by /48" },
  { file: "server/app.ts", find: "            if (ctx.wideKey !== null) limited(\"orderLiveDailyWide\", ctx.wideKey);", replace: "", label: "real provider orders are counted by /48" },
  { file: "server/app.ts", find: "              limiters.orderPriceMoved.take(ctx.ipKey);", replace: "", label: "'price moved' outcomes are limited per visitor" },
  { file: "server/app.ts", find: "            limited(\"orderLiveDaily\", ctx.ipKey);\n            if (ctx.wideKey !== null) limited(\"orderLiveDailyWide\", ctx.wideKey);\n            limited(\"orderCreateGlobal\", \"all\");", replace: "            limited(\"orderCreateGlobal\", \"all\");\n            limited(\"orderLiveDaily\", ctx.ipKey);\n            if (ctx.wideKey !== null) limited(\"orderLiveDailyWide\", ctx.wideKey);", label: "the shared order limit is charged after the visitor's own" },
  { file: "server/app.ts", find: "            if (!created) for (const release of reserved) release();", replace: "", label: "a reserved quota is given back" },
  { file: "server/app.ts", find: "          if ((earlier !== undefined && earlier.fingerprint !== fingerprint) || (pending !== undefined && pending.fingerprint !== fingerprint)) {", replace: "          if (false) {", label: "a retry key is tied to its request" },
  { file: "server/app.ts", find: "            const closesAt = Math.min(Date.parse(verified.deadline), Date.parse(sent.deadline));", replace: "            const closesAt = Date.parse(verified.deadline);", label: "deposits close at the earlier deadline" },
  { file: "server/app.ts", find: 'if (deps.diskFull?.()) throw new HttpError(503, "busy", "We\'re at capacity right now. Try again shortly.");', replace: "", label: "orders are refused on a full disk" },
  { file: "server/app.ts", find: "        if (!deps.liveOrders) {", replace: "        if (false) {", label: "development creates no real order (route)" },
  { file: "server/quotes.ts", find: "  const fee = privately ? options.feeBpsPrivate : options.feeBps;", replace: "  const fee = privately ? options.feeBpsPrivate : options.feeBps - 1;", label: "the fee comes from configuration" },
  { file: "server/quotes.ts", find: "if (forOrder && (isPlaceholder(recipient) || isPlaceholder(refundTo))) {", replace: "if (false) {", label: "a preview stand-in cannot be used in an order" },
  { file: "server/quotes.ts", find: "const stand = forOrder ? null : placeholderFor(to.chain);", replace: "const stand = placeholderFor(to.chain);", label: "an order needs a receiving address" },
  { file: "server/quotes.ts", find: 'if (usd !== null && usd > MAX_USD * 100n) throw new HttpError(400, "too_large", "Swaps are limited to $1,000,000.", { expected: true });', replace: "", label: "the $1,000,000 limit on the provider's valuation" },

  // ---- deposit hash ----
  { file: "server/app.ts", find: 'if (fresh === null || fresh.state.status !== "waiting" || fresh.state.depositTxHash !== stored) {', replace: "if (fresh === null) {", label: "the order is re-read before a hash is recorded" },
  { file: "server/app.ts", find: 'if (receipt !== null && receipt.status !== "0x1") return { kind: "reverted" };', replace: "", label: "a failed transaction is refused" },
  { file: "server/app.ts", find: "          payers.push(event.from);", replace: "", label: "every wallet that paid a part is screened" },
  { file: "server/app.ts", find: "    return arrived >= amountIn ? { kind: \"confirmed\", payers } : { kind: \"mismatch\" };", replace: "    return arrived > 0n ? { kind: \"confirmed\", payers } : { kind: \"mismatch\" };", label: "the parts of a token deposit must add up to the order's amount" },
  { file: "server/app.ts", find: "        if (event !== null && sameAddress(chain, event.token, record.from.contract) && sameAddress(chain, event.to, record.depositAddress)) {", replace: "        if (event !== null && sameAddress(chain, event.to, record.depositAddress)) {", label: "only the order's own token counts as a deposit" },
  { file: "server/app.ts", find: "          confirmed = check.kind === \"confirmed\";", replace: "          confirmed = true;", label: "only a mined, successful transfer is proof of a deposit" },
  { file: "server/app.ts", find: "      return { kind: receipt === null ? \"pending\" : \"confirmed\", payers: sender };", replace: "      return { kind: \"confirmed\", payers: sender };", label: "a pending native transfer is not proof" },
  { file: "server/app.ts", find: "        if (changesUsedUp && !walletChain) throw tooManyChanges();", replace: "", label: "a hash that cannot be checked can be changed only a few times" },
  { file: "server/app.ts", find: "          if (changesUsedUp && !confirmed) throw tooManyChanges();", replace: "", label: "a pending hash can be changed only a few times" },
  { file: "server/app.ts", find: " && limiters.depositForwardGlobal.take(\"all\")", replace: "", label: "hashes passed straight on are limited for all clients" },
  { file: "server/app.ts", find: "            confirmed ? \"tracking\" : \"idle\",", replace: "            \"tracking\",", label: "an unconfirmed hash travels in the unpaid class" },
  { file: "server/app.ts", find: "  const depositsOpen = awaitingDeposit && !proven && now", replace: "  const depositsOpen = state.status === \"waiting\" && now", label: "deposit details stay on show until a deposit is proven" },
  { file: "server/app.ts", find: "  const originKnown = proven || !awaitingDeposit;", replace: "  const originKnown = true;", label: "an unchecked hash is not shown as the deposit" },
  { file: "server/app.ts", find: "            const screening = sanctions.screen(check.payers);", replace: "            const screening = sanctions.screen([]);", label: "the paying wallet is screened" },
  { file: "server/app.ts", find: "          if (!sameHash && record.state.depositVerified === true && !(walletChain && (await isDead(record.from.chain as WalletChain, stored)))) {", replace: "          if (false) {", label: "a confirmed hash cannot be replaced" },
  { file: "server/app.ts", find: "    depositTxUrl: state.depositTxHash !== null && state.depositVerified === true ? explorerTxUrl(record.from.chain, state.depositTxHash) : null,", replace: "    depositTxUrl: state.depositTxHash !== null ? explorerTxUrl(record.from.chain, state.depositTxHash) : null,", label: "no link for an unconfirmed hash" },
  { file: "server/app.ts", find: "depositAddress: depositsOpen ? record.depositAddress : null,", replace: "depositAddress: record.depositAddress,", label: "the deposit address is hidden near the deadline" },

  // ---- request handling ----
  { file: "server/app.ts", find: 'if (verdict.blocked) throw new HttpError(403, "region", "Not available in your region.");', replace: "", label: "the region block" },
  { file: "server/app.ts", find: "      if (config.regionBlock) {\n        const verdict = geo.check(client.ip);", replace: "      {\n        const verdict = geo.check(client.ip);", label: "with the region block off, nobody is refused for where they are and nothing is looked up" },
  { file: "server/boot.ts", find: "  if (production && config.regionBlock) {", replace: "  if (production) {", label: "with the region block off, there is no region service and nothing is fetched for one" },
  { file: "server/config.ts", find: "  const regionBlock = regionAsked === \"on\";", replace: "  const regionBlock = regionAsked !== \"off\";", label: "the region block is off unless it is set to on" },
  { file: "server/config.ts", find: "  const extra = regionBlock ? read(env, \"BLOCKED_COUNTRIES\") : null;", replace: "  const extra = read(env, \"BLOCKED_COUNTRIES\");", label: "with the region block off, BLOCKED_COUNTRIES is not read" },
  { file: "web/src/pages/LegalPages.tsx", find: "  const regionBlock = useApp((state) => state.config?.regionBlock === true);", replace: "  const regionBlock = true;", label: "the Privacy Policy speaks of working out a country only where the region block is on" },
  { file: "server/app.ts", find: 'if (config.swapsPaused) throw new HttpError(503, "paused", "Swaps are paused. Existing orders are still tracked.");', replace: "", label: "the kill switch" },
  { file: "server/app.ts", find: "      limited(\"api\", ctx.ipKey);\n      if (ctx.wideKey !== null)", replace: "      limited(\"apiGlobal\", \"all\");\n      limited(\"api\", ctx.ipKey);\n      if (ctx.wideKey !== null)", label: "the per-client limit is charged before the shared one" },
  { file: "server/app.ts", find: "      if (ctx.wideKey !== null) limited(\"apiWide\", ctx.wideKey);", replace: "", label: "IPv6 is also counted by /48" },
  { file: "server/app.ts", find: '        limited("statusExempt", "all");', replace: "", label: "the status exemption is limited" },
  { file: "server/app.ts", find: '        limited("quoteGlobal", "all");', replace: "", label: "previews from all clients are capped" },
  { file: "server/app.ts", find: "      needsSession: true,\n      handler: async (ctx, match, body) => {\n        const chain = match[1] ?? \"\";", replace: '      handler: async (ctx, match, body) => {\n        const chain = match[1] ?? "";', label: "the RPC proxy needs a session" },
  { file: "server/app.ts", find: "    if (!limiters.pages.take(ctx.ipKey)) {", replace: "    if (false) {", label: "page requests are limited" },
  { file: "server/http.ts", find: "  if (req.headers.host === originHost) return true;", replace: "  if (originHost.length > 0) return true;", label: "the same-origin check" },
  { file: "server/http.ts", find: "    if (size > maxBytes) {\n      req.destroy();", replace: "    if (false) {\n      req.destroy();", label: "the streamed body cap" },
  { file: "server/session.ts", find: "      return Number(expires) > now;", replace: "      return true;", label: "sessions expire" },
  { file: "server/session.ts", find: "if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;", replace: "", label: "the session signature is checked" },
  { file: "server/ip.ts", find: "if (forwarded !== null && canonical(fromForwarded) !== canonical(fromReal)) return { ip: null, direct: false, disagree: true };", replace: "", label: "disagreeing address headers are refused" },
  { file: "server/rpc.ts", find: '  "eth_chainId",\n  "eth_blockNumber",', replace: '  "eth_chainId",\n  "eth_sendRawTransaction",\n  "eth_blockNumber",', label: "the RPC proxy allows reads only" },

  // ---- provider client ----
  { file: "server/oneclick.ts", find: 'if (body.dry !== true && !allowLive) return refused("order");', replace: "", label: "development creates no real order (client)" },
  { file: "server/oneclick.ts", find: "    if (used + held >= maxPerMin) return false;", replace: "", label: "each kind of call keeps its reserved share of the budget" },
  { file: "server/app.ts", find: "dry ? \"user\" : \"order\");", replace: "\"user\");", label: "a new order's real quote has a budget class of its own" },
  { file: "server/app.ts", find: "      if (state === undefined || isEndState(state.status) || state.status === \"swapping\" || state.stopped) {", replace: "      if (state === undefined || state.status !== \"waiting\") {", label: "every open order that has not started swapping counts toward the visitor's limit" },
  { file: "server/ratelimit.ts", find: "Math.floor(providerCallsPerMin * PREVIEW_SHARE)", replace: "Math.floor(providerCallsPerMin / 2)", label: "previews are let through only as far as the budget has room" },
  { file: "server/oneclick.ts", find: "    if (priority === \"idle\" && usedBy.idle >= idleCap) return false;", replace: "", label: "unpaid orders never use more than their share" },
  { file: "server/oneclick.ts", find: '        if (pathname === "/v0/quote" && parsed && providerError) {', replace: '        if (parsed) {', label: "a 403 is a refusal only for a quote with the provider's message" },

  // ---- order tracking and storage ----
  { file: "server/poller.ts", find: "  if (from === to) return true;\n  if (from === \"delivered\"", replace: '  if (from !== undefined) return true;\n  if (from === "delivered"', label: "an order only moves forward" },
  { file: "server/poller.ts", find: 'const notFound = result.kind === "rejected" && result.status === 404;', replace: 'const notFound = result.kind === "rejected";', label: "only a not-found answer expires an order" },
  { file: "server/poller.ts", find: "      if (ended) {\n        schedule.delete(id);\n        return;\n      }\n      if (abandon(fresh)) return;", replace: "      if (abandon(fresh)) return;", label: "an ended order stays off the schedule" },
  { file: "server/poller.ts", find: "    finishedAt: finished ? (previous.finishedAt ?? iso) : previous.stopped ? previous.finishedAt : null,", replace: "    finishedAt: finished ? (previous.finishedAt ?? iso) : null,", label: "a stopped order keeps its finish time" },
  { file: "server/poller.ts", find: "    if (!isFunded(record.state) && !watched(record.id)) base = unpaidIntervalMs(base, unpaidCount(), unpaidCallsPerMin);", replace: "", label: "unpaid orders wait their turn" },
  { file: "server/poller.ts", find: "    await forwardIfNeeded(record);", replace: "", label: "a hash is offered to the provider again" },
  { file: "server/store.ts", find: "  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString(\"hex\")}`;\n  try {", replace: '  fs.writeFileSync(file, data);\n  if (data.length >= 0) return;\n  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;\n  try {', label: "order writes are durable" },
  { file: "server/store.ts", find: 'const neverFunded = state.status === "expired" && state.depositTxHash === null;', replace: 'const neverFunded = state.depositTxHash === null && (state.status === "expired" || state.status === "waiting");', label: "a waiting order is never swept" },
  { file: "server/store.ts", find: "  if (state.status === \"swapping\" || state.status === \"deposit_too_small\") return true;", replace: "  if (state.status === \"swapping\" || state.status === \"deposit_too_small\" || state.status === \"deposit_seen\") return true;", label: "'deposit seen' alone is not funds in an order" },
  { file: "server/store.ts", find: "  if (!isEndState(state.status) && hasProvenFunds(state)) return null;", replace: "", label: "an unfinished order with funds in it is never deleted" },
  { file: "server/store.ts", find: "      for (const record of live.values()) if (!record.state.stopped) count += 1;", replace: "      for (const record of live.values()) if (record.id.length > 0) count += 1;", label: "an order no longer tracked is not counted as open" },
  { file: "server/poller.ts", find: " && !hasProvenFunds(previous)) status = \"expired\";", replace: ") status = \"expired\";", label: "a confirmed deposit is never expired on our own say-so" },
  { file: "server/poller.ts", find: "fresh.state.status === \"waiting\" && !isFunded(fresh.state) && t >", replace: "fresh.state.status === \"waiting\" && t >", label: "a confirmed deposit survives a not-found answer" },
  { file: "server/poller.ts", find: "    const latest = alertIfUnseen({ ...fresh, state });", replace: "    const latest = { ...fresh, state };", label: "the operator is told of a confirmed deposit nobody picked up" },
  { file: "server/poller.ts", find: "      if (isFunded(stopped) && stopped.unfinishedAlertSent !== true) {", replace: "      if (false) {", label: "the operator is told when tracking stops with funds in an order" },
  { file: "server/poller.ts", find: "    if (isWalletChain(record.from.chain) && state.depositVerified !== true) return;", replace: "", label: "a pending hash is not passed on" },
  { file: "server/poller.ts", find: "earlier !== undefined && earlier.hash === state.depositTxHash ? earlier.attempts : 0;", replace: "earlier !== undefined ? earlier.attempts : 0;", label: "a replaced hash gets its own attempts" },
  { file: "server/poller.ts", find: "      if (update.state.status === fresh.state.status) return \"gone\";", replace: "      if (update.state.status.length > 0) return \"gone\";", label: "a late deposit found at the last check is kept" },
  { file: "server/poller.ts", find: "        if (result.kind === \"rejected\") return result.status === 404 ? \"gone\" : \"unclear\";\n        return \"outage\";", replace: "        return \"gone\";", label: "nothing is deleted while the provider cannot be asked" },
  { file: "server/poller.ts", find: "        if (result.kind === \"rejected\") return result.status === 404 ? \"gone\" : \"unclear\";", replace: "        if (result.kind === \"rejected\") return \"gone\";", label: "only a not-found answer means an order is gone" },
  { file: "server/poller.ts", find: "      if (update.kind !== \"state\") return \"unclear\";", replace: "      if (update.kind !== \"state\") return \"gone\";", label: "an answer we cannot read deletes nothing" },
  { file: "server/poller.ts", find: "        result = await oneclick.status(record.depositAddress, record.depositMemo, \"tracking\");\n      } catch {\n        return \"outage\";", replace: "        result = await oneclick.status(record.depositAddress, record.depositMemo, \"idle\");\n      } catch {\n        return \"outage\";", label: "last checks do not depend on the unpaid-orders share" },
  { file: "server/poller.ts", find: "    if (record.state.status === \"deposit_too_small\") base = Math.max(base, 60_000);", replace: "", label: "an under-paid order is checked at the slow rate" },
  { file: "server/maintenance.ts", find: "        if (verdict === \"gone\") {", replace: "        if (verdict !== \"changed\") {", label: "only a clear answer allows a deletion" },
  { file: "server/maintenance.ts", find: "        if (verdict === \"outage\") break;", replace: "        if (verdict === \"outage\" || verdict === \"unclear\") break;", label: "an unclear record does not hold up the rest" },
  { file: "server/maintenance.ts", find: "          if (from !== null && now() > from + UNCLEAR_GRACE_MS) {", replace: "          if (from !== null) {", label: "an unclear record is kept for a week past its date" },
  { file: "server/maintenance.ts", find: "      toAsk.sort((a, b) => (lastAsked.get(a.id) ?? 0) - (lastAsked.get(b.id) ?? 0));", replace: "", label: "records are asked about in turn" },
  { file: "server/maintenance.ts", find: "        if (SETTLED.includes(record.state.status)) {", replace: "        if (record.id.length > 0) {", label: "unsettled orders are asked about before deletion" },
  { file: "server/maintenance.ts", find: "      for (const record of toAsk.slice(0, MAX_FINAL_CHECKS_PER_SWEEP)) {", replace: "      for (const record of toAsk) {", label: "last checks are limited per round" },
  { file: "server/ratelimit.ts", find: "      if (this.buckets.get(key) === bucket && bucket.resetAt > this.now()) bucket.count = Math.max(0, bucket.count - cost);", replace: "      const current = this.buckets.get(key);\n      if (current !== undefined) current.count = Math.max(0, current.count - cost);", label: "a give-back never frees a place in a later window" },

  // ---- compliance ----
  { file: "server/geo.ts", find: 'return { country: null, blocked: blockUnknown, reason: blockUnknown ? "unknown" : null };', replace: "return { country: null, blocked: false, reason: null };", label: "an unknown location is blocked" },
  { file: "server/geo.ts", find: '"sebastopol", ', replace: "", label: "the region spelling the real database uses" },
  { file: "server/sanctions.ts", find: "available: () => index !== null && now() - fetchedAt < STALE_AFTER_MS,", replace: "available: () => index !== null,", label: "a stale sanctions list is not used" },
  { file: "server/sanctions.ts", find: "target.host !== SDN_DOWNLOAD_HOST", replace: "false", label: "only the expected download host is followed" },
  { file: "server/sanctions.ts", find: 'if (addressCount > 0 && parsed.addresses.length < addressCount * MIN_SHARE_OF_PREVIOUS) throw new Error("sanctions list shrank sharply");', replace: "", label: "a shrunken sanctions list is refused" },
  { file: "server/address-variants.ts", find: "  for (const spelling of tonSpellings(text)) out.add(spelling);", replace: "", label: "every TON spelling is screened" },

  // ---- configuration ----
  { file: "server/config.ts", find: 'if (production && providerStub) fail("PROVIDER_STUB", "is for local development only");', replace: "", label: "the practice provider is refused in production" },
  { file: "server/config.ts", find: 'const swapsPaused = bool(env, "SWAPS_PAUSED", production);', replace: 'const swapsPaused = bool(env, "SWAPS_PAUSED", false);', label: "swaps are paused by default in production" },
  { file: "server/config.ts", find: 'if (production && read(env, "TRUST_PROXY_HOPS") === null) fail("TRUST_PROXY_HOPS", "is required in production (1 on Railway)");', replace: "", label: "the proxy setting is required in production" },
  { file: "server/boot.ts", find: 'const listenHost = stub === null ? undefined : "127.0.0.1";', replace: "const listenHost = undefined;", label: "the practice provider listens locally only" },
  { file: "server/boot.ts", find: "    diskFull: () => diskGuard.full(),\n    ...(stub === null", replace: "    ...(stub === null", label: "the disk guard is wired to the routes" },
  { file: "server/maintenance.ts", find: "      if (used !== null) last = used;", replace: "      last = used;", label: "the disk guard keeps its last reading" },

  // ---- coins, money and addresses ----
  { file: "server/tokens.ts", find: "        alerts.send(\"token_mismatch\", `The provider's entry for ${raw.symbol} on ${raw.blockchain} differs from the allowlist. The coin is disabled.`, raw.assetId);\n        continue;", replace: "", label: "a coin that differs from the allowlist is disabled" },
  { file: "server/tokens.ts", find: "          if (state?.mismatch) continue;", replace: "", label: "a coin whose on-chain decimals differ is disabled" },
  { file: "server/tokens.ts", find: "      if (replacement !== undefined && listed.has(replacement)) continue;", replace: "", label: "a renamed coin is offered once" },
  { file: "shared/amounts.ts", find: "return actual * BPS < reviewed * (BPS - BigInt(bps));", replace: "return actual * BPS < reviewed * (BPS - BigInt(bps) - 1n);", label: "the price tolerance is exact" },
  { file: "shared/amounts.ts", find: 'if (frac.length > decimals) return { ok: false, reason: "too_many_decimals" };', replace: "", label: "extra decimals are refused" },
  { file: "shared/addresses.ts", find: '  if (!singleCase && input !== checksummed) return "checksum";', replace: "", label: "an address checksum is checked" },
  { file: "shared/addresses.ts", find: '  return SOLANA_NOT_WALLETS.has(input) ? "burn" : input;', replace: "  return input;", label: "Solana program addresses are refused" },
  { file: "shared/addresses.ts", find: '  if ((CASH_CHARSET.indexOf(body.charAt(33)) & 0b11) !== 0) return "format";', replace: "", label: "one spelling per Bitcoin Cash address" },
  { file: "shared/addresses.ts", find: "  if (!/^[qp][qpzr][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{40}$/.test(body)) return \"format\";", replace: '  if (!/^[qp][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{41}$/.test(body)) return "format";', label: "Bitcoin Cash size bits are checked" },

  // ---- in the browser: the wallet transfer and the review step ----
  { file: "web/src/wallet/transfer.ts", find: "  if (!sameAddress(chain, read.recipient, deposit)) throw new TransferError(\"The transaction pays another address.\");", replace: "", label: "the wallet transfer must pay the order's deposit address" },
  { file: "web/src/wallet/transfer.ts", find: "  if (read.amount !== amount) throw new TransferError(\"The transaction is for another amount.\");", replace: "", label: "the wallet transfer must be for the exact amount" },
  { file: "web/src/wallet/transfer.ts", find: "  if (tx.chainId !== chainId) throw new TransferError(\"The transaction is for another network.\");", replace: "", label: "the wallet transfer must be on the order's network" },
  { file: "web/src/wallet/transfer.ts", find: "  if ((read.token === null) !== (token === null) || (read.token !== null && token !== null && !sameAddress(chain, read.token, token))) throw new TransferError(\"The transaction is for another coin.\");", replace: "", label: "the wallet transfer must be of the order's coin" },
  { file: "web/src/wallet/transfer.ts", find: " || tx.data.slice(0, 10).toLowerCase() !== TRANSFER_SELECTOR", replace: "", label: "only a transfer call passes the gate (never an approval)" },
  { file: "web/src/wallet/transfer.ts", find: " || tx.value !== 0n) return null;", replace: ") return null;", label: "no coin rides along with a token transfer" },
  { file: "web/src/wallet/transfer.ts", find: "  if (order.status !== \"waiting\" || !order.depositsOpen || order.depositAddress === null) throw new TransferError(\"This order is no longer taking a deposit.\");\n", replace: "  if (order.depositAddress === null) throw new TransferError(\"This order is no longer taking a deposit.\");\n", label: "nothing is built for an order that has moved on" },
  { file: "web/src/wallet/transfer.ts", find: "  if (order.pay !== \"wallet\") throw new TransferError(\"This order was not made to be paid from a connected wallet.\");\n", replace: "", label: "only an order made to be paid from a wallet is paid from one" },
  { file: "web/src/wallet/transfer.ts", find: "  if (order.depositMemo !== null) throw new TransferError(\"This deposit needs a memo, which a wallet transfer cannot carry.\");\n", replace: "", label: "a deposit that needs a memo is never paid by a plain transfer" },
  { file: "web/src/wallet/transfer.ts", find: "  assertSameOrder(shown, fresh);\n", replace: "", label: "the order paid is the order on screen" },
  { file: "web/src/wallet/transfer.ts", find: "    sameAddress(fresh.from.chain, shown.depositAddress, fresh.depositAddress) &&\n", replace: "", label: "the deposit address paid is the one on screen" },
  { file: "web/src/wallet/transfer.ts", find: "    shown.amountIn === fresh.amountIn &&\n", replace: "", label: "the amount paid is the one on screen" },
  { file: "web/src/lib/order-logic.ts", find: "  return order.depositTxHash !== null ? \"sent\" : \"idle\";", replace: "  return \"idle\";", label: "a reload does not offer Send again for an order that has a transfer on record" },
  { file: "web/src/lib/order-logic.ts", find: "  if (input.phase === \"replaced\") return { kind: \"none\", label: \"Transfer replaced\", disabled: true, busy: false };\n", replace: "", label: "after a replacement, sending again is not on the main button" },
  { file: "web/src/lib/order-logic.ts", find: "  if (phase === \"sent\" && pendingMs > 60_000) return", replace: "  if (phase === \"sent\") return", label: "no second send is offered in a transfer's first minute" },
  { file: "web/src/lib/order-logic.ts", find: "open: order.depositsOpen && Date.parse(order.deadline) - now > DEPOSIT_CLOSE_MS };", replace: "open: order.depositsOpen && Date.parse(order.deadline) - now > 0 };", label: "the page hides deposit details two minutes before the deadline" },
  { file: "web/src/lib/transfer-watch.ts", find: "  return receipt.status === \"0x1\" ? \"mined\" : \"reverted\";", replace: "  return \"mined\";", label: "a failed transfer is not taken for a deposit" },
  { file: "web/src/lib/transfer-watch.ts", find: "  if (included === null || included <= nonce) return", replace: "  if (included === null || included < nonce) return", label: "a transfer still waiting for its turn is not called replaced" },
  { file: "web/src/lib/transfer-watch.ts", find: "  return { sighting: second ?? \"replaced\", known: { from, nonce } };", replace: "  return { sighting: \"replaced\", known: { from, nonce } };", label: "a transfer included at the last moment is not called replaced" },
  { file: "server/http.ts", find: "    \"style-src 'self' 'unsafe-inline'\",", replace: "    \"style-src 'self' 'unsafe-inline'\",\n    \"script-src-attr 'unsafe-inline'\",", label: "nothing is added to the security policy unnoticed" },
  { file: "server/http.ts", find: "connect: [\"https://api.web3modal.org\", \"wss://relay.walletconnect.org\"],", replace: "connect: [\"https://api.web3modal.org\", \"wss://relay.walletconnect.org\", \"https://pulse.walletconnect.org\"],", label: "the usage-report address stays out of the security policy" },
  { file: "scripts/check-build.ts", find: "    if (WALLET_CODE.test(raw.toString(\"utf8\"))) problems.push(", replace: "    if (false) problems.push(", label: "wallet code in the first page load fails the build" },
  { file: "scripts/check-build.ts", find: "    if (!TOP_LEVEL.has(name)) problems.push(", replace: "    if (false) problems.push(", label: "a file the site is not known to publish fails the build" },
  { file: "scripts/check-build.ts", find: "    if (NEAR_PICTURE.test(place) && !NEAR_ICON.test(place)) problems.push(", replace: "    if (false) problems.push(", label: "NEAR's own mark published anywhere but as the icon of the NEAR coin and of the NEAR chain fails the build" },
  { file: "scripts/check-build.ts", find: "    if (twin === undefined) sizes.css += zlib.gzipSync(Buffer.from(inline, \"utf8\"), { level: 9 }).length;", replace: "", label: "styles written into the page count toward the CSS budget" },
  { file: "server/boot.ts", find: "      if (!Number.isFinite(ms) || ms <= 0) return false;", replace: "", label: "the practice clock ignores what is not a finite, positive number" },
  { file: "scripts/check-build.ts", find: "      if (!fs.existsSync(path.join(dist, dep))) problems.push(`${path.relative(dist, file)}: needs ${dep}, which is not in the build`);", replace: "", label: "a stylesheet that later code needs must be in the build" },
  { file: "scripts/check-build.ts", find: "    if (!fs.existsSync(path.join(dist, link[1] ?? \"\"))) problems.push(`index.html names ${link[1]}, which is not in the build`);", replace: "", label: "a stylesheet the page names must be in the build" },
  { file: "server/config.ts", find: "  if (production && !swapsPaused && supportContact === null) fail(", replace: "  if (false) fail(", label: "swaps cannot be switched on in production with no support contact" },
  { file: "web/src/lib/order-logic.ts", find: "  const andWrite = hasContact ? \", and contact support\" : \"\";", replace: "  const andWrite = \", and contact support\";", label: "nobody is told to contact support where no contact is published" },
  { file: "web/src/lib/order-logic.ts", find: "              Date.parse(order.deadline) - now <= DEPOSIT_CLOSE_MS", replace: "              false", label: "the first step stops asking for a deposit once deposits are closed" },
  { file: "server/static.ts", find: "  return html.replace(BANNER_PLACE, () => banner);", replace: "  return html;", label: "the service banner is written into the page the server sends" },
  { file: "web/src/lib/order-logic.ts", find: "              : `Send ${sent} before ${clockTime(sendBy(order))}.`,", replace: "              : `Send ${sent} before ${clockTime(Date.parse(order.deadline))}.`,", label: "the first step names the time to send by, not the deadline" },
  { file: "shared/chains.ts", find: "  return payWindowMs(pay, originChain) - DEPOSIT_CLOSE_MS;", replace: "  return payWindowMs(pay, originChain);", label: "the time to send is two minutes less than the order's deadline" },
  { file: "web/src/lib/order-logic.ts", find: "toSend: Math.max(0, sendBy(order) - now),", replace: "toSend: Math.max(0, Date.parse(order.deadline) - now),", label: "the countdown runs to the time to send by" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (input.refundTo.trim() === \"\") return blocked(\"Enter refund address\");", replace: "  if (input.pay === \"manual\" && input.refundTo.trim() === \"\") return blocked(\"Enter refund address\");", label: "an order paid from a wallet needs a refund address too" },
  { file: "web/src/lib/swap-logic.ts", find: "  return pay === \"wallet\" ? (walletOnPayingChain ?? \"\") : \"\";", replace: "  return walletOnPayingChain ?? \"\";", label: "only a wallet order starts from the wallet's address" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (typed.trim() !== \"\") return true;\n  return walletConnected && walletOnPayingChain === null;", replace: "  return walletConnected && walletOnPayingChain === null;", label: "a typed refund address is never in force with its field hidden" },
  { file: "web/src/lib/order-logic.ts", find: "label: fitLabel([`Send ${amount}`, `Send ${coin}`], PAY_BUTTON_ROOM),", replace: "label: `Send ${amount}`,", label: "the pay button's label fits one line whatever the amount" },
  { file: "web/src/lib/swap-logic.ts", find: "  return candidates.find((label) => label.length <= room) ?? candidates[candidates.length - 1] ?? \"\";", replace: "  return candidates[0] ?? \"\";", label: "a main button is given the longest label that fits" },
  { file: "web/src/lib/order-logic.ts", find: "  return exact.length <= 12 ? exact : null;", replace: "  return exact.slice(0, 12);", label: "a title or a list row never gives a shortened amount to pay" },
  { file: "server/alerts.ts", find: "        log.warn(\"alert\", { kind, text, held: true });\n", replace: "", label: "an alert held back from the channel is still written to the log" },
  { file: "web/src/wallet/session.ts", find: "export const PAY_METHODS = [\"eth_sendTransaction\", \"wallet_switchEthereumChain\", \"wallet_addEthereumChain\"] as const;", replace: "export const PAY_METHODS = [\"eth_sendTransaction\", \"wallet_switchEthereumChain\", \"wallet_addEthereumChain\", \"eth_signTypedData_v4\"] as const;", label: "paying never asks a wallet for the right to sign typed data" },
  { file: "web/src/wallet/session.ts", find: "export const SIGN_IN_METHOD = \"personal_sign\";", replace: "export const SIGN_IN_METHOD = \"eth_sign\";", label: "the sign-in asks for a plain message to be signed, never a raw one" },
  { file: "web/src/wallet/session.ts", find: "export const WALLET_METHODS = [...PAY_METHODS, SIGN_IN_METHOD] as const;", replace: "export const WALLET_METHODS = [...PAY_METHODS, SIGN_IN_METHOD, \"wallet_sendCalls\"] as const;", label: "a wallet is asked for nothing beyond paying and the one sign-in" },
  { file: "web/src/wallet/sign-in.ts", find: "import { signMessage } from \"@wagmi/core\";", replace: "import { signMessage, signTypedData } from \"@wagmi/core\";", label: "the sign-in module takes one function from the wallet library" },
  { file: "web/src/wallet/index.ts", find: "    universalProviderConfigOverride: sessionRights(),\n", replace: "", label: "a phone wallet's session is narrowed to what this site does" },
  { file: "web/src/wallet/session.ts", find: "  reownAuthentication: false,", replace: "  reownAuthentication: true,", label: "the wallet window never asks for a message to be signed to log in" },
  // ---- the token page and the site's own address ----
  { file: "server/static.ts", find: "...(options.tokenPage ? TOKEN_ROUTES : [])", replace: "...TOKEN_ROUTES", label: "the token page exists only once the token has an address" },
  { file: "server/config.ts", find: "    if (parsed.pathname !== \"/\" || parsed.search !== \"\" || parsed.hash !== \"\") fail(\"SITE_URL\", \"must be the site's address alone, for example https://example.org\");", replace: "", label: "the site's own address is an origin and nothing more" },
  { file: "server/config.ts", find: "    siteUrl = parsed.origin;", replace: "", label: "the site's own address is kept as an origin" },
  { file: "server/static.ts", find: "if (rel === \"/index.html\" && typeof options.siteUrl === \"string\") raw =", replace: "if (rel === \"/index.html\") raw =", label: "the page is served as built when the site's address is not set" },
  { file: "server/app.ts", find: "        const record = found !== null && found.confidentiality !== \"basic\" ? found : null;\n        if (record === null) {\n          limited(\"orderMiss\", ctx.ipKey);", replace: "        const record = found !== null && found.confidentiality !== \"basic\" ? found : null;\n        if (record === null) {", label: "guessing deposit addresses is limited as hard as guessing order IDs" },
  { file: "server/app.ts", find: "      name: \"order_find\",\n      limit: \"orderRead\",\n      maxBody: 512,\n      needsOrigin: true,\n      needsSession: true,", replace: "      name: \"order_find\",\n      limit: \"orderRead\",\n      maxBody: 512,\n      needsOrigin: true,", label: "looking an order up by deposit address needs the site's session" },
  { file: "server/store.ts", find: "      return record !== null && depositKey(record.depositAddress) === depositKey(address) ? record : null;", replace: "      return record;", label: "an order is found by deposit address only if its record carries that address" },
  { file: "server/store.ts", find: "    writeDurable(indexFor(record.depositAddress), held === null ? record.id : SHARED);", replace: "    writeDurable(indexFor(record.depositAddress), record.id);", label: "an address shared by two orders opens neither" },
  { file: "web/src/lib/swap-logic.ts", find: "  const coinKnown = params.get(\"from\") === null || from !== undefined;", replace: "  const coinKnown = true;", label: "an amount in a link is dropped when its coin is not on the list" },
  { file: "web/src/lib/site-logic.ts", find: "  if (tokenSet) all.push({ key: \"token\",", replace: "  all.push({ key: \"token\",", label: "the token is among what the site does only once its address is set" },
  { file: "server/app.ts", find: "        limited(\"orderFind\", ctx.ipKey);\n        limited(\"orderFindDaily\", ctx.ipKey);\n", replace: "", label: "look-ups by deposit address are limited per visitor" },
  { file: "server/app.ts", find: "        if (ctx.wideKey !== null) limited(\"orderFindDailyWide\", ctx.wideKey);\n", replace: "", label: "look-ups by deposit address are limited per wider network" },
  { file: "server/app.ts", find: "        limited(\"orderFindGlobal\", \"all\");\n", replace: "", label: "look-ups by deposit address are limited for all visitors together" },
  { file: "web/src/lib/transfer-watch.ts", find: "      if (look.sighting === \"replaced\" && replacedBefore) return", replace: "      if (look.sighting === \"replaced\") return", label: "a transfer is called replaced only on two looks in a row" },
  { file: "web/src/lib/transfer-watch.ts", find: "    return verdict(await read(\"eth_getTransactionReceipt\", [hash])) === \"mined\" ? \"included\" : \"clear\";", replace: "    await read(\"eth_getTransactionReceipt\", [hash]);\n    return \"clear\";", label: "a first transfer that was included stops a second" },
  { file: "web/src/lib/transfer-watch.ts", find: "  } catch {\n    return \"unknown\";\n  }", replace: "  } catch {\n    return \"clear\";\n  }", label: "a second transfer is not sent when the first cannot be checked" },
  { file: "web/src/lib/order-logic.ts", find: "  if (wasAsking) return \"unsure\";\n", replace: "", label: "a reload while the wallet was being asked does not offer Send afresh" },
  { file: "web/src/lib/order-logic.ts", find: "  if (input.phase === \"unsure\") return { kind: \"none\", label: \"Check your wallet\", disabled: true, busy: false };\n", replace: "", label: "after such a reload, sending is not on the main button" },
  { file: "web/src/lib/track-logic.ts", find: "    if (first.kind !== \"none\" || input.address === null) return first;", replace: "    return first;", label: "text that could be an ID or an address is tried as both" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (order.recipient !== reviewed.recipient) return \"the receiving address\";", replace: "", label: "the order's receiving address is compared with what was reviewed" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (order.refundTo !== reviewed.refundTo) return \"the refund address\";", replace: "", label: "the order's refund address is compared with what was reviewed" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (order.amountIn !== reviewed.amountIn) return \"the amount you pay\";", replace: "", label: "the order's amount is compared with what was reviewed" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (order.slippageBps !== reviewed.slippageBps) return \"the slippage limit\";", replace: "", label: "the order's slippage limit is compared with the one reviewed" },
  { file: "server/config.ts", find: "    if (!SITE_ORIGIN.test(parsed.origin)) fail(\"SITE_URL\", \"must be the site's address alone, for example https://example.org\");", replace: "", label: "the site's own address holds nothing a page may not" },
  { file: "server/static.ts", find: "  if (!SITE_ORIGIN.test(siteUrl)) throw new Error(\"the site's address is not a plain origin\");\n  // Functions, not strings", replace: "  // Functions, not strings", label: "nothing but a plain address is written into the page" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (worseByMoreThan(BigInt(reviewed.minAmountOut), BigInt(order.minAmountOut), REVIEW_TOLERANCE_BPS)) return \"the minimum you receive\";", replace: "", label: "the order's minimum is compared with what was reviewed" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (input.settling) return { kind: \"none\", label: \"Check the new numbers\", disabled: true, busy: false };", replace: "", label: "new numbers cannot be confirmed in the first second" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (input.impactUnconfirmed) return { kind: \"none\", label: \"Confirm the price impact\", disabled: true, busy: false };", replace: "", label: "a large price impact needs its tick in the review sheet" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (input.phase === \"mismatch\") return { kind: \"close\", label: \"Close and start again\", disabled: false, busy: false };", replace: "", label: "nothing is confirmed after a mismatch" },
  { file: "web/src/lib/swap-logic.ts", find: "  return wallet.plain === true ? wallet.address : null;", replace: "  return wallet.address;", label: "a contract wallet's address is not offered on another chain" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (input.problem !== null && !retriesItself(input.problem.code)) return false;", replace: "", label: "a refused quote is not asked for again by itself" },
  { file: "web/src/lib/swap-logic.ts", find: "Math.max(input.refreshMs, input.problem?.waitMs ?? 0)", replace: "input.refreshMs", label: "the wait the server names is kept" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (input.typing || input.loading || input.hidden || input.sheetOpen) return false;", replace: "  if (input.typing || input.loading) return false;", label: "no refresh while a sheet is open or the tab is hidden" },
  { file: "web/src/stores/swap.ts", find: "  if (now - state.fetchedAt > QUOTE_EXPIRES_MS) return state.loading ? \"loading\" : \"expired\";", replace: "  if (now - state.fetchedAt > QUOTE_EXPIRES_MS) return \"expired\";", label: "an expired quote being replaced cannot be acted on" },

  // ---- the wallet's gate, where requests may come from, and screening when an order is made ----
  { file: "web/src/wallet/transfer.ts", find: "  const tx = build(fresh);\n  assertTransfer(tx, fresh);\n", replace: "  const tx = build(fresh);\n", label: "what was built passes the gate before it is handed on" },
  { file: "web/src/wallet/index.ts", find: "  const tx = checkedTransfer(fresh, shown);\n", replace: "  const tx = checkedTransfer(shown, shown);\n", label: "the wallet is sent what the gate passed for the order as the server holds it now" },
  { file: "web/src/wallet/index.ts", find: "  if (getAccount(config).chainId !== tx.chainId) throw new Error(\"wrong network\");\n", replace: "", label: "nothing is sent while the wallet is on another network" },
  { file: "web/src/wallet/index.ts", find: "addEthereumChainParameter: { rpcUrls: [WALLET_CHAIN_NODE[chain]] }", replace: "addEthereumChainParameter: { rpcUrls: [WALLET_CHAIN_NODE.base] }", label: "a wallet adding a network is given that chain's node" },
  { file: "shared/chains.ts", find: "  bsc: \"https://bsc-dataseed.bnbchain.org\",\n", replace: "  bsc: \"https://mainnet.base.org\",\n", label: "each chain's public node is that chain's own" },
  { file: "server/app.ts", find: "      name: \"order_create\",\n      limit: \"orderCreate\",\n      maxBody: 4096,\n      needsOrigin: true,\n", replace: "      name: \"order_create\",\n      limit: \"orderCreate\",\n      maxBody: 4096,\n", label: "an order is taken only from this site's own pages" },
  { file: "server/app.ts", find: "      name: \"order_create\",\n      limit: \"orderCreate\",\n      maxBody: 4096,\n      needsOrigin: true,\n      needsSession: true,\n", replace: "      name: \"order_create\",\n      limit: \"orderCreate\",\n      maxBody: 4096,\n      needsOrigin: true,\n", label: "making an order needs a session" },
  { file: "server/app.ts", find: "      name: \"order_find\",\n      limit: \"orderRead\",\n      maxBody: 512,\n      needsOrigin: true,\n", replace: "      name: \"order_find\",\n      limit: \"orderRead\",\n      maxBody: 512,\n", label: "an address is looked up only from this site's own pages" },
  { file: "server/app.ts", find: "sanctions.screen([input.sender, input.recipient, input.refundTo, rewardsAddress])", replace: "sanctions.screen([input.recipient, input.refundTo, rewardsAddress])", label: "the paying wallet's address is screened when an order is made" },
  { file: "server/app.ts", find: "sanctions.screen([input.sender, input.recipient, input.refundTo, rewardsAddress])", replace: "sanctions.screen([input.sender, input.refundTo, rewardsAddress])", label: "the receiving address is screened when an order is made" },
  { file: "server/app.ts", find: "sanctions.screen([input.sender, input.recipient, input.refundTo, rewardsAddress])", replace: "sanctions.screen([input.sender, input.recipient, rewardsAddress])", label: "the refund address is screened when an order is made" },
  { file: "server/app.ts", find: "sanctions.screen([input.sender, input.recipient, input.refundTo, rewardsAddress])", replace: "sanctions.screen([input.sender, input.recipient, input.refundTo])", label: "the rewards address is screened when an order is made" },
  { file: "server/app.ts", find: "    depositMemo: depositsOpen ? record.depositMemo : null,\n", replace: "    depositMemo: record.depositMemo,\n", label: "the memo is hidden with the deposit address once deposits close" },
  { file: "server/quotes.ts", find: "  if (amount > MAX_RAW) throw new HttpError(400, \"too_large\", \"That amount is too large.\");\n", replace: "", label: "an amount is at most 10^30 of the coin's smallest unit" },
  { file: "server/sanctions.ts", find: "export const SDN_DOWNLOAD_HOST = \"wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com\";", replace: "export const SDN_DOWNLOAD_HOST = \"published.s3.us-gov-west-1.amazonaws.com\";", label: "the sanctions list's download host is the named one" },

  // ---- what the provider is told, what is stored of its answer, and the limits on orders ----
  { file: "server/app.ts", find: " || value === null || value < amountIn) return { kind: \"mismatch\" };", replace: " || value === null) return { kind: \"mismatch\" };", label: "a payment of less than the amount, in the chain's own coin, is no proof of a deposit" },
  { file: "server/quotes.ts", find: "    recipientType: \"DESTINATION_CHAIN\",", replace: "    recipientType: \"INTENTS\",", label: "the provider is told to deliver on the destination chain" },
  { file: "server/quotes.ts", find: "    depositType: \"ORIGIN_CHAIN\",", replace: "    depositType: \"INTENTS\",", label: "the provider is told the deposit comes on the paying chain" },
  { file: "server/quotes.ts", find: "    refundType: \"ORIGIN_CHAIN\",", replace: "    refundType: \"INTENTS\",", label: "the provider is told to refund on the paying chain" },
  { file: "server/app.ts", find: "              amountOut: verified.amountOut,\n", replace: "              amountOut: verified.amountIn,\n", label: "the amount received that is stored is the verified quote's" },
  { file: "server/app.ts", find: "              minAmountOut: verified.minAmountOut,\n", replace: "              minAmountOut: \"1\",\n", label: "the minimum received that is stored is the verified quote's" },
  { file: "server/app.ts", find: "              withdrawFee: verified.withdrawFee,\n", replace: "              withdrawFee: null,\n", label: "the network fee that is stored is the verified quote's" },
  { file: "server/verify.ts", find: "      if (typeof fee !== \"number\" || !Number.isInteger(fee) || fee < 0 || fee > 500) reject(\"echo:appFees fee\");\n      if (sameFeeRecipient(entry.recipient, sentFee.recipient)) {", replace: "      if (typeof fee !== \"number\" || !Number.isInteger(fee) || fee > 500) reject(\"echo:appFees fee\");\n      if (sameFeeRecipient(entry.recipient, sentFee.recipient)) {", label: "a fee under nothing in the echo is refused" },
  { file: "web/src/stores/sent.ts", find: "{ hash: earlier?.hash ?? null, at, asking: true }", replace: "{ hash: null, at, asking: true }", label: "asking the wallet again does not forget the first transfer" },
  { file: "web/src/stores/sent.ts", find: "  else notes[orderId] = { hash: note.hash, at: note.at };", replace: "  else delete notes[orderId];", label: "a wallet that answers without sending leaves the first transfer on record" },
  { file: "server/app.ts", find: "      log.error(\"unhandled\", { route: routeName, kind: errorKind(err) });\n      sendJson(res, 500, errorBody(new HttpError(500, \"unavailable\", \"Something went wrong. Try again.\")));", replace: "      log.error(\"unhandled\", { route: routeName, kind: String(err) });\n      sendJson(res, 500, errorBody(new HttpError(500, \"unavailable\", String(err))));", label: "an unexpected error is answered with one fixed sentence" },
  { file: "server/app.ts", find: "{ depositAddress: fresh.depositAddress, txHash, ...(fresh.depositMemo === null ? {} : { memo: fresh.depositMemo }) },", replace: "{ depositAddress: fresh.depositAddress, txHash },", label: "a deposit hash is passed on with the order's memo (the route)" },
  { file: "server/poller.ts", find: "{ depositAddress: record.depositAddress, txHash: state.depositTxHash, ...(record.depositMemo === null ? {} : { memo: record.depositMemo }) },", replace: "{ depositAddress: record.depositAddress, txHash: state.depositTxHash },", label: "a deposit hash is passed on with the order's memo (the later offer)" },
  { file: "server/ratelimit.ts", find: "  orderCreate: { max: 6, windowMs: MINUTE },", replace: "  orderCreate: { max: 6000, windowMs: MINUTE },", label: "the limit on orders a minute is the figure it was set to" },
  { file: "server/ratelimit.ts", find: "export const MAX_UNPAID_PER_NETWORK = 40;", replace: "export const MAX_UNPAID_PER_NETWORK = 40_000;", label: "unpaid orders per network are limited to forty" },
  { file: "server/app.ts", find: "unpaid.client >= MAX_UNPAID_PER_CLIENT || unpaid.network >= MAX_UNPAID_PER_NETWORK", replace: "unpaid.client >= MAX_UNPAID_PER_CLIENT", label: "unpaid orders are counted by network as well as by address" },
  { file: "server/ratelimit.ts", find: "  return Math.min(MAX_OPEN_ORDERS, Math.max(10, providerCallsPerMin * 2));", replace: "  return Math.min(MAX_OPEN_ORDERS, Math.max(10, providerCallsPerMin * 200));", label: "open orders are held to twice the provider's calls a minute" },

  // ---- points and the sign-in ----
  { file: "server/rewards.ts", find: "  if (record.state.status !== \"delivered\") return null;", replace: "", label: "only a delivered order adds points" },
  { file: "server/rewards.ts", find: "    if (recorded.has(entry.order)) return;\n    recorded.add(entry.order);", replace: "    recorded.add(entry.order);", label: "an order adds its points once" },
  { file: "server/rewards.ts", find: "      nonces.delete(nonce);\n      if (held === undefined || held.expiresAt <= now) return null;", replace: "      if (held === undefined || held.expiresAt <= now) return null;", label: "a sign-in code is used up by one attempt" },
  { file: "server/rewards.ts", find: "      if (held === undefined || held.expiresAt <= now) return null;", replace: "      if (held === undefined) return null;", label: "a sign-in code runs out" },
  { file: "server/rewards.ts", find: "      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;", replace: "", label: "a rewards session is checked against the server's secret" },
  { file: "server/rewards.ts", find: "      return Number(expires) > now ? toChecksumAddress(address) : null;", replace: "      return toChecksumAddress(address);", label: "a rewards session runs out" },
  { file: "server/app.ts", find: "        if (signer.toLowerCase() !== held.address.toLowerCase()) throw refused;", replace: "", label: "the signature of a sign-in must be the address's own" },
  { file: "server/app.ts", find: "signer = await recoverMessageAddress({ message: held.message, signature: signature as `0x${string}` });", replace: "signer = await recoverMessageAddress({ message: String((body as { message?: unknown }).message ?? held.message), signature: signature as `0x${string}` });", label: "the message signed for a sign-in is the server's own, never one the browser sends" },
  { file: "server/app.ts", find: "        if (address === null) throw new HttpError(401, \"session\", \"Sign in to see your points.\");", replace: "        if (address === null) return { status: 200, body: rewards.view(String(ctx.req.headers[\"x-address\"] ?? \"\"), now()) };", label: "points are shown only with a sign-in" },
  { file: "server/app.ts", find: "          rewardsAddress = rewardsAddressOf(body.rewardsAddress);\n          if (rewardsAddress === null) throw", replace: "          rewardsAddress = String(body.rewardsAddress);\n          if (rewardsAddress === null) throw", label: "a rewards address must be a real address" },
  // Points are counted from a delivered swap's dollar value alone, ten to the dollar. (There is no weekly ceiling and no reduced share any more, so nothing here switches one off.)
  { file: "shared/rewards.ts", find: "  return volumeMicro * BigInt(REWARDS.pointsPerUsd);", replace: "  return volumeMicro;", label: "a swap adds ten points for each dollar of its value" },
  { file: "server/rewards.ts", find: "  const volume = usdToMicro(record.amountInUsd);", replace: "  const volume = record.fees.appBps === 0 ? 0n : usdToMicro(record.amountInUsd);", label: "points are counted from a swap's value, whatever fee it carried" },
  { file: "server/rewards.ts", find: "    const volume = entries.filter((entry) => entry.week === week).reduce((total, entry) => total + BigInt(entry.volumeUsdMicro), 0n);", replace: "    const volume = entries.reduce((total, entry) => total + BigInt(entry.volumeUsdMicro), 0n);", label: "a week's points are the points of that week's swaps only" },
  { file: "shared/rewards.ts", find: "    return payout >= minPayout && payout > 0n ?", replace: "    return payout > 0n ?", label: "a share under the smallest payout is carried forward, not sent" },
  { file: "shared/rewards.ts", find: "  return volume === null ? null : pointsMicro(volume);", replace: "  return volume === null ? null : volume;", label: "the points a quote shows are counted as the server will count them" },
  // The pool and the week's total on the Rewards page: one total for everyone, a share worked out from it, and one reading of the chain a minute.
  { file: "server/rewards.ts", find: "        weekPointsMicro: weekPoints.toString(),\n", replace: "        weekPointsMicro: weekPoints.toString(),\n        holders: [...self.weekPoints(week)].map(([address, points]) => ({ address, points: points.toString() })),\n", label: "the answer anyone gets holds the week's points as one total, and no wallet's own" },
  { file: "shared/rewards.ts", find: "  if (totalMicro <= 0n || mineMicro <= 0n) return { shareBps: 0n, estimateCents: 0n };", replace: "  if (mineMicro <= 0n) return { shareBps: 0n, estimateCents: 0n };", label: "a share of the pool is nothing while nobody has points" },
  { file: "shared/rewards.ts", find: "  const mine = mineMicro > totalMicro ? totalMicro : mineMicro;", replace: "  const mine = mineMicro;", label: "a share of the pool is never more than all of it" },
  { file: "server/app.ts", find: "    if (poolTriedAt === null || now() - poolTriedAt >= POOL_READ_EVERY_MS) {", replace: "    if (poolTriedAt === null || now() - poolTriedAt >= 0) {", label: "the reserve wallet's balances are read from the chain once a minute at most" },
  { file: "server/rewards.ts", find: "        if (held.pool !== pool.toString() || held.asset !== asset) throw new Error(", replace: "        if (false) throw new Error(", label: "a closed week cannot be closed again with another pool" },
  { file: "server/rewards.ts", find: "      if (now < bounds.end) throw new Error(", replace: "      if (false) throw new Error(", label: "a week still running cannot be closed" },
  { file: "server/rewards-tools.ts", find: "  if (typeof sent.from !== \"string\" || sent.from.toLowerCase() !== reserve.toLowerCase()) return { ok: false, reason: \"it was not sent from the reserve wallet\" };", replace: "", label: "a payout is recorded only when it came from the reserve wallet" },
  { file: "server/rewards-tools.ts", find: "  if (done.status !== \"0x1\") return { ok: false, reason: \"it failed on-chain\" };", replace: "", label: "a payout that failed on-chain is not recorded" },
  { file: "server/sample.ts", find: "  if (options.practice !== true) throw new Error(\"sample data is for practice mode only\");", replace: "", label: "sample content is refused outside practice mode" },
  { file: "server/boot.ts", find: "  const samples = stub === null ? null : seedSamples({ practice: true,", replace: "  const samples = seedSamples({ practice: true,", label: "sample content is put in place only by a practice server" },
  // ---- the payout tools, the sign-in message, and the rest of points and rewards ----
  { file: "server/rewards.ts", find: "        if (!screening.ok) return { ...mine, payout: \"0\", carriedMicro: \"0\", withheld: share.payout.toString() };\n", replace: "", label: "an address on the sanctions list is left off the payout list" },
  { file: "server/rewards.ts", find: "carriedMicro: \"0\", withheld: share.payout.toString() };", replace: "carriedMicro: share.points.toString(), withheld: share.payout.toString() };", label: "nothing is carried forward for an address that was left off the payout list" },
  { file: "server/rewards.ts", find: "      if (!sanctions.available()) throw new Error(NOT_SCREENED);\n", replace: "", label: "no week is closed while the sanctions list is missing or out of date" },
  { file: "server/rewards.ts", find: "        if (share === undefined || BigInt(share.payout) === 0n) throw new Error(", replace: "        if (share === undefined) throw new Error(", label: "no transaction is recorded as paying a share that was kept back or carried" },
  { file: "server/rewards-tools.ts", find: "  if (options.close !== true) return {", replace: "  if (false) return {", label: "a look at what closing would do writes nothing: only the word to close closes a week" },
  { file: "server/rewards-tools.ts", find: "  if (holds !== null && pool > holds) throw new Error(", replace: "  if (false) throw new Error(", label: "a week is not closed with a pool larger than the reserve wallet holds" },
  { file: "server/rewards-tools.ts", find: "  if (pool > 0n && holds === null) throw new Error(", replace: "  if (false) throw new Error(", label: "a week is not closed when the reserve wallet's balance cannot be read" },
  { file: "server/rewards-tools.ts", find: "  if (pool > 0n && holds === null) throw new Error(", replace: "  if (holds === null) throw new Error(", label: "a week with nothing to pay can be closed without a reserve wallet to read" },
  { file: "server/rewards-tools.ts", find: "  if (pool > 0n && options.reserve === null) throw new Error(\"RESERVE_ADDRESS is not set, so there is no reserve wallet to check the pool against. Nothing was closed.\");\n", replace: "", label: "a week is not closed while no reserve wallet is set to check the pool against" },
  { file: "server/rewards.ts", find: "      if (fs.existsSync(weekFile(week))) throw new Error(", replace: "      if (false) throw new Error(", label: "a week's record that cannot be read is never written over" },
  { file: "server/rewards.ts", find: "      if (open !== null) throw new Error(", replace: "      if (false) throw new Error(", label: "a week is not closed while an earlier week that holds points is open" },
  { file: "server/rewards.ts", find: "      if (after < week) candidates.add(after);\n", replace: "", label: "a week that holds only points carried into it must be closed before a later one" },
  { file: "server/rewards-tools.ts", find: "  if (pool < 0n) throw new Error(\"The pool cannot be less than nothing.\");", replace: "  if (pool <= 0n) throw new Error(\"The pool cannot be less than nothing.\");", label: "a week nothing is paid for can still be closed, so that its points are carried" },
  { file: "server/rewards-tools.ts", find: "    if (recorded !== null) throw new Error(", replace: "    if (false) throw new Error(", label: "a transaction on record for any week is not recorded again (the tool)" },
  { file: "server/rewards.ts", find: "        if (other !== null) throw new Error(", replace: "        if (false) throw new Error(", label: "a transaction is on record for one week only (the record itself)" },
  { file: "server/rewards-tools.ts", find: "    if (event.token !== RESERVE_ASSET.contract.toLowerCase()) continue;\n", replace: "", label: "only the payout coin's own record of a transfer counts as a payout" },
  { file: "server/rewards-tools.ts", find: "    if (event.from !== reserve.toLowerCase()) continue;\n", replace: "", label: "only coins that left the reserve wallet count as a payout" },
  { file: "server/rewards-tools.ts", find: "      if (share === undefined || BigInt(share.payout) !== transfer.amount) continue;", replace: "      if (share === undefined) continue;", label: "a transfer counts as a payout only for exactly the listed amount" },
  { file: "server/rewards-tools.ts", find: "    if (matched === 0) throw new Error(", replace: "    if (false) throw new Error(", label: "a transaction that pays nobody on the week's list is not recorded" },
  { file: "server/rewards-tools.ts", find: " && share.tx === undefined).map((share) => [share.address.toLowerCase(), share]));", replace: ").map((share) => [share.address.toLowerCase(), share]));", label: "a payout that has a transfer on record is not matched to a second one" },
  { file: "server/rewards-tools.ts", find: "      unpaid.delete(transfer.to);\n", replace: "", label: "two transfers given together do not both count for one payout" },
  { file: "server/rewards.ts", find: "        if (share.tx !== undefined) throw new Error(", replace: "        if (false) throw new Error(", label: "the transaction on record for a share is never written over" },
  { file: "server/rewards.ts", find: "        share.tx = hash;\n", replace: "", label: "the transaction that paid a share is kept with that share" },
  { file: "server/rewards.ts", find: "        const sent = item.shares.filter((share) => share.tx !== undefined && BigInt(share.payout) > 0n);", replace: "        const sent = item.shares.filter((share) => item.txs.length > 0 && BigInt(share.payout) > 0n);", label: "what a week is shown to have paid is the shares with a transfer on record, not the total worked out" },
  { file: "server/rewards.ts", find: "txs: share.tx === undefined ? [] : [share.tx] }] : [];", replace: "txs: item.txs.map((tx) => tx.hash) }] : [];", label: "an address is shown the transfer that paid it, and no other address's" },
  { file: "server/rewards.ts", find: "    volumeUsdMicro: (volume ?? 0n).toString(),", replace: "    volumeUsdMicro: (record.from.symbol === record.to.symbol ? 0n : (volume ?? 0n)).toString(),", label: "a swap of a coin for the same coin counts like any other: no route changes a swap's points" },
  { file: "web/src/stores/rewards.ts", find: "      if (!isSignInMessage(code.message, { host: window.location.host, address: asking, nonce: code.nonce, issuedAt: code.issuedAt, expiresAt: code.expiresAt })) {", replace: "      if (false) {", label: "the wallet is opened only for the sign-in message of this site and this address" },
  { file: "shared/rewards.ts", find: "  return message === signInMessage({ host: parts.host, address: parts.address, nonce, issuedAt, expiresAt });", replace: "  return typeof message === \"string\" && message.includes(parts.host) && message.includes(parts.address);", label: "the page knows the sign-in message only character for character" },
  { file: "shared/rewards.ts", find: "  if (typeof nonce !== \"string\" || !NONCE_SHAPE.test(nonce)) return false;\n", replace: "", label: "nothing but a code can stand where the sign-in code stands in the message" },
  { file: "shared/rewards.ts", find: "    `${input.host} wants you to sign in with your Ethereum account:`,", replace: "    `${input.host} asks you to sign in with your BNB Chain address:`,", label: "the sign-in message is laid out so that a wallet can read which site is asking" },
  { file: "server/app.ts", find: "        if (ctx.wideKey !== null) limited(\"rewardsNonceWide\", ctx.wideKey);\n", replace: "", label: "sign-in codes are limited per wider network" },
  { file: "server/app.ts", find: "        if (ctx.wideKey !== null) limited(\"rewardsNonceWide\", ctx.wideKey);\n        limited(\"rewardsNonceGlobal\", \"all\");\n", replace: "        limited(\"rewardsNonceGlobal\", \"all\");\n        if (ctx.wideKey !== null) limited(\"rewardsNonceWide\", ctx.wideKey);\n", label: "the shared limit on sign-in codes is charged after the network's own" },
  { file: "server/ratelimit.ts", find: "  rewardsNonceWide: { max: 40, windowMs: MINUTE },", replace: "  rewardsNonceWide: { max: 40_000, windowMs: MINUTE },", label: "the limit on sign-in codes per network is the figure it was set to" },
  { file: "server/rewards.ts", find: "    if (held !== undefined && held.stamp === stamp) return held.record;\n", replace: "", label: "a closed week's file is not read again while it has not changed" },
  { file: "server/rewards.ts", find: "    if (held !== undefined && held.stamp === stamp) return held.record;", replace: "    if (held !== undefined) return held.record;", label: "a week's file that the tools have changed is read again" },
  { file: "server/rewards.ts", find: "    if (Date.now() - fs.statSync(file).mtimeMs > STALE_TMP_MS) fs.rmSync(file, { force: true });", replace: "    fs.rmSync(file, { force: true });", label: "a temporary file that another process is still writing is not cleared away" },
  { file: "server/boot.ts", find: "      log.error(\"points_not_recorded\", { order: hashId(id), error: errorKind(err) });", replace: "      throw err;", label: "one order that cannot be put to the points record does not stop the server starting" },
  { file: "server/app.ts", find: "              amountInUsd: verified.amountInUsd,\n", replace: "              amountInUsd: \"1\",\n", label: "the dollar value paid that is stored is the verified quote's" },
  { file: "server/app.ts", find: "              amountOutUsd: verified.amountOutUsd,\n", replace: "              amountOutUsd: verified.amountInUsd,\n", label: "the dollar value received that is stored is the verified quote's" },
  { file: "server/boot.ts", find: "    if (config.env === \"production\") throw new ConfigError(\"DATA_DIR: this folder holds practice content", replace: "    if (false) throw new ConfigError(\"DATA_DIR: this folder holds practice content", label: "the live site does not start on a data folder that holds practice content" },
  { file: "server/sample.ts", find: "  if (!fs.existsSync(marker)) {", replace: "  if (false) {", label: "a data folder given practice content says so in a note of its own" },
  { file: "server/app.ts", find: "        if (host === null) throw new HttpError(403, \"origin\", \"Signing in is not available from this address.\");\n", replace: "        if (host === null) return { status: 200, body: {} };\n", label: "no sign-in code is given to a page that is not on the host the request itself was made to" },
  { file: "server/app.ts", find: "  if (config.siteUrlSet && config.siteUrl !== null) return new URL(config.siteUrl).host;\n", replace: "", label: "where the site's own address is set, the sign-in message names it and nothing a request says" },
  { file: "server/tokens.ts", find: "      if (excludedChains.has(raw.blockchain)) continue;\n", replace: "", label: "a coin on an excluded chain never reaches the coin list" },
  { file: "server/config.ts", find: "  const excludedChains = new Set(DEFAULT_EXCLUDED_CHAINS);", replace: "  const excludedChains = new Set<string>();", label: "the built-in list of excluded chains stands whatever the setting says" },
  { file: "server/config.ts", find: "      excludedChains.add(key);", replace: "      void key;", label: "a chain named in the setting is excluded too" },
  { file: "web/src/lib/site-logic.ts", find: "(typeof value === \"string\" && /^https:\\/\\/[^\\s\"'<>]+$/.test(value) ? value : null)", replace: "(typeof value === \"string\" ? value : null)", label: "only an https link is ever put behind one of the three icons" },
  { file: "server/config.ts", find: "  if (!/^https:\\/\\/dexscreener\\.com\\/", replace: "  if (false && !/^https:\\/\\/dexscreener\\.com\\/", label: "the DexScreener link is held to DexScreener's own site" },
  { file: "server/config.ts", find: "  if (!/^https:\\/\\/github\\.com\\/", replace: "  if (false && !/^https:\\/\\/github\\.com\\/", label: "the GitHub link is held to GitHub's own site" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (pay !== \"wallet\") return false;\n  if (!wallet.connected) return true;", replace: "  if (!wallet.connected) return true;", label: "the quote says nothing of points when the swap is sent by hand" },
  { file: "web/src/lib/swap-logic.ts", find: "  return walletAddressFor(rewardsChain, \"evm\", wallet) !== null;", replace: "  return true;", label: "the quote says nothing of points for a wallet whose address is not known to be the person's on the rewards chain" },
  { file: "web/src/styles/base.css", find: ":focus-visible {\n  outline: none;\n}\n\n:root[data-keys]", replace: ":focus-visible {\n  outline: var(--border-width) solid var(--accent);\n}\n\n:root[data-keys]", label: "nothing is outlined in the accent colour for having the focus" },
  { file: "web/src/styles/base.css", find: ":root[data-keys] :focus-visible {\n  outline: var(--border-width) solid var(--focus-ring);", replace: ":focus-visible {\n  outline: var(--border-width) solid var(--focus-ring);", label: "the keyboard's quiet line is drawn only while the keyboard is moving about" },
  { file: "web/src/lib/keys.ts", find: "  const pointer = () => {\n    moving = false;\n    delete root.dataset.keys;", replace: "  const pointer = () => {\n    moving = false;", label: "any press of a pointer takes the keyboard's mark away" },
  { file: "web/src/styles/picker.css", find: ".picker-search:focus-within {\n  border-color: var(--border-strong);\n}", replace: ".picker-search:focus-within {\n  border-color: var(--border-strong);\n  box-shadow: 0 0 0 var(--border-width) var(--accent);\n}", label: "a text field being typed in shows its hairline and nothing else" },
  // ---- the coin picker, inside the swap card ----
  { file: "web/src/components/SwapCard.tsx", find: "<div className=\"card-view card-swap\" inert={pickerSide !== null}>", replace: "<div className=\"card-view card-swap\">", label: "the swap cannot be reached while the coin picker has the card" },
  { file: "web/src/stores/picker.ts", find: "  if (pickerInHistory(window.history.state) === null || leaving) return;\n  stepBack();", replace: "  return;", label: "closing the coin picker goes back over the page of history it added" },
  { file: "web/src/stores/picker.ts", find: "  closePicker();\n  window.addEventListener(\"popstate\", sync);", replace: "  sync();\n  window.addEventListener(\"popstate\", sync);", label: "a card that comes onto the page starts with the coin picker closed, whatever page of history the browser is on" },
  { file: "web/src/stores/swap.ts", find: "  return clearCard;\n", replace: "  return () => undefined;\n", label: "leaving the swap page clears the card" },
  { file: "web/src/stores/swap.ts", find: "    dropPending();\n    set(FRESH);", replace: "    set(FRESH);", label: "a quote still on its way when the card is cleared is not shown on the fresh card" },
  { file: "web/src/stores/picker.ts", find: "  window.history.pushState({ picker: side }, \"\");", replace: "", label: "opening the coin picker adds a page of history, so the browser's Back returns to the swap" },
  { file: "web/src/stores/swap.ts", find: "    sheetOpen: useSheet.getState().current !== null || usePicker.getState().side !== null,", replace: "    sheetOpen: useSheet.getState().current !== null,", label: "no refresh while the coin picker has the card" },
  { file: "web/src/config.ts", find: "export const CHAIN_ORDER = [\"bsc\", \"eth\", \"sol\", \"btc\", \"base\", \"arb\", \"op\", \"pol\", \"avax\", \"tron\", \"ton\"] as const;", replace: "export const CHAIN_ORDER = [\"bsc\", \"eth\", \"base\", \"arb\", \"sol\", \"btc\", \"op\", \"pol\", \"avax\", \"tron\", \"ton\"] as const;", label: "the coin picker offers the chains in the set order" },
  { file: "web/src/lib/swap-logic.ts", find: "  const group = (token: TokenView) => (token.contract === null ? 0 : stable(token.symbol) < STABLE_SYMBOLS.length ? 1 : 2);", replace: "  const group = (token: TokenView) => (token.contract === null ? 0 : 2);", label: "the coin picker lists a chain's stablecoins right after the chain's own coin" },
  { file: "web/src/lib/swap-logic.ts", find: "  const elsewhere = everywhere.tokens.filter((token) => token.chain !== chain);\n  return elsewhere.length > 0 ? { kind: \"elsewhere\", tokens: elsewhere } : { kind: \"none\" };", replace: "  return { kind: \"none\" };", label: "with no match on the chosen chain the coin picker shows the matches on other chains" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (chains.length === 0 || (shown !== null && chains.includes(shown))) return null;", replace: "  if (chains.length === 0) return null;", label: "a pasted contract moves the coin picker only when the chain being shown does not have that coin" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (everywhere.kind === \"unsupported\") return { kind: \"unsupported\" };", replace: "  if (everywhere.kind === \"unsupported\") return { kind: \"none\" };", label: "a contract that is not listed is said to be not supported in the coin picker" },
  { file: "web/src/styles/card.css", find: "  .card,\n  .card-view {\n    transition: none;\n  }", replace: "  .card-view {\n    transition: none;\n  }", label: "where less movement is asked for, the card's height is not animated as the coin picker opens" },
  { file: "web/src/styles/picker.css", find: "  border-color: color-mix(in srgb, var(--chain-colour) 60%, var(--text-muted));", replace: "  border-color: var(--accent);", label: "the chosen chain in the coin picker is told by its own colour, never the accent" },
  { file: "web/src/styles/picker.css", find: "  .picker-row[data-active] {\n    --coin-ring: var(--card-solid-hover);\n    background: var(--hover-tint);", replace: "  .picker-row[data-active] {\n    --coin-ring: var(--card-solid-hover);\n    background: var(--hover-tint);\n    border: var(--border-width) solid var(--border-strong);", label: "the coin picker's highlighted row is a soft tint and never a border" },
  { file: "web/src/styles/card.css", find: "  background: var(--card-tint);\n  -webkit-backdrop-filter", replace: "  background: var(--surface);\n  -webkit-backdrop-filter", label: "the swap card is see-through" },
  { file: "web/src/components/Shell.tsx", find: "        {usable ? <SocialLinks where=\"header\" /> : null}\n", replace: "        <StatusDot />\n", label: "the header carries the three icon links and no status dot" },
  { file: "web/src/styles/home.css", find: ".stage[data-running][data-waiting] .stage-tab[aria-selected=\"true\"] .stage-progress-fill {", replace: ".stage[data-running][data-waiting] .stage-progress-fill {", label: "the stage waits while the pointer is over it" },
  // ---- private routing (PRIVACY_MODE) ----
  { file: "server/verify.ts", find: "if ((quoteRequest.confidentiality ?? \"public\") !== level) reject(\"echo:confidentiality\");", replace: "", label: "the echoed routing level must be the level that was sent" },
  { file: "server/verify.ts", find: "if (level !== \"basic\" && level !== \"public\") reject(\"sent confidentiality\");", replace: "", label: "a quote is verified only at one of the two routing levels this site asks for" },
  { file: "server/verify.ts", find: "  if (sentFees.length > 1) reject(\"sent fees\");\n", replace: "", label: "a quote that went out with more than one fee is never accepted" },
  { file: "server/verify.ts", find: "      if (ourRecipient !== null && sameFeeRecipient(entry.recipient, ourRecipient)) reject(\"echo:appFees unsent share\");\n", replace: "", label: "the echo of a quote sent with no fee pays this site nothing" },
  { file: "server/verify.ts", find: "    if (echoedFees.length > 1) reject(\"echo:appFees unsent recipient\");\n", replace: "", label: "the echo of a quote sent with no fee holds one entry at most, the provider's own" },
  { file: "server/verify.ts", find: "if (providerBps > MAX_PROVIDER_FEE_BPS) reject(\"echo:appFees unsent total\");", replace: "", label: "the provider's one entry in the echo of a quote sent with no fee is bounded" },
  { file: "server/verify.ts", find: "      if (typeof fee !== \"number\" || !Number.isInteger(fee) || fee < 0 || fee > 500) reject(\"echo:appFees fee\");\n      // We asked for no fee.", replace: "      if (typeof fee !== \"number\" || !Number.isInteger(fee) || fee > 500) reject(\"echo:appFees fee\");\n      // We asked for no fee.", label: "a fee under nothing in the echo of a quote sent with no fee is refused" },
  { file: "server/verify.ts", find: "if (others > 1) reject(\"echo:appFees private recipient\");", replace: "", label: "the echo of a private quote pays nobody beside the provider" },
  { file: "server/verify.ts", find: "if (providerBps > MAX_PROVIDER_FEE_BPS) reject(\"echo:appFees private total\");", replace: "", label: "the provider's own fee on a private quote is bounded" },
  { file: "server/quotes.ts", find: "  const confidentiality: Confidentiality = privacyMode === \"basic\" && body.withoutPrivate !== true ? \"basic\" : \"public\";", replace: "  const confidentiality: Confidentiality = body.confidentiality === \"basic\" || (privacyMode === \"basic\" && body.withoutPrivate !== true) ? \"basic\" : \"public\";", label: "nothing a request says can raise the routing level" },
  { file: "server/quotes.ts", find: "  const confidentiality: Confidentiality = privacyMode === \"basic\" && body.withoutPrivate !== true ? \"basic\" : \"public\";", replace: "  const confidentiality: Confidentiality = privacyMode === \"basic\" && body.confidentiality !== \"public\" && body.withoutPrivate !== true ? \"basic\" : \"public\";", label: "a request cannot name the routing level" },
  { file: "server/quotes.ts", find: "  const confidentiality: Confidentiality = privacyMode === \"basic\" && body.withoutPrivate !== true ? \"basic\" : \"public\";", replace: "  const confidentiality: Confidentiality = privacyMode === \"basic\" && !body.withoutPrivate ? \"basic\" : \"public\";", label: "only the value true asks for a swap without private routing" },
  { file: "server/quotes.ts", find: "    confidentiality: input.confidentiality,\n", replace: "    confidentiality: \"public\",\n", label: "every quote is sent at the routing level worked out for it" },
  { file: "server/quotes.ts", find: "  if (fee > 0) {", replace: "  if (fee >= 0) {", label: "with a fee setting at nothing, no fee of ours is sent with that kind of quote" },
  { file: "server/quotes.ts", find: "    routing: routingOf(verified.confidentiality),", replace: "    routing: routingOf(\"public\"),", label: "a quote says how it was routed, as it was verified" },
  { file: "server/quotes.ts", find: "  if (asPrivate && /confidential/.test(text)) return privateUnavailable();\n", replace: "", label: "a refusal of a private quote that names confidential routing is answered as private routing not available" },
  { file: "server/quotes.ts", find: "  const noRoute = (): HttpError => (asPrivate ? privateUnavailable() : new HttpError(422, \"no_route\", \"No route for this pair right now.\", { expected: true }));", replace: "  const noRoute = (): HttpError => new HttpError(422, \"no_route\", \"No route for this pair right now.\", { expected: true });", label: "no route for a private quote is answered as private routing not available" },
  { file: "server/app.ts", find: "      if (refusesPrivate(input, result.status)) throw privateUnavailable();\n", replace: "", label: "a private quote the provider answers 401 is answered as private routing not available" },
  { file: "server/app.ts", find: "        const input = parseSwapInput(body, snapshot.byId, false, config.privacyMode);", replace: "        const input = parseSwapInput(body, snapshot.byId, false);", label: "previews are sent at the server's routing level" },
  { file: "server/app.ts", find: "        const input = parseSwapInput(body, snapshot.byId, true, config.privacyMode);", replace: "        const input = parseSwapInput(body, snapshot.byId, true);", label: "an order's real quote is sent at the server's routing level" },
  { file: "server/app.ts", find: "            const rerouted = routingOf(verified.confidentiality) !== seen.routing;", replace: "            const rerouted = false;", label: "no order is made routed another way than the quote that was reviewed" },
  { file: "server/app.ts", find: "          (reviewed.routing !== undefined && !isRouting(reviewed.routing))\n", replace: "          false\n", label: "a review that names a routing that is not one is refused" },
  { file: "server/app.ts", find: "input.slippageBps, rewardsAddress, input.confidentiality]))", replace: "input.slippageBps, rewardsAddress]))", label: "a retry key is tied to the routing of its request" },
  { file: "server/app.ts", find: "              confidentiality: verified.confidentiality,\n", replace: "", label: "an order's record keeps the routing level it was made with" },
  { file: "server/app.ts", find: "    routing: routingOf(record.confidentiality),", replace: "    routing: routingOf(\"basic\"),", label: "an order with no routing level on record is shown as public" },
  { file: "server/app.ts", find: "          privacyMode: config.privacyMode,", replace: "          privacyMode: \"public\",", label: "the page is told the routing level in force" },
  { file: "server/app.ts", find: "        feeRecipient: config.feeRecipient,\n        ...(deps.extraSigningKeys", replace: "        ...(deps.extraSigningKeys", label: "a private quote's echo is checked against this site's own fee recipient" },
  { file: "server/app.ts", find: "  if (config.privateRoutingWaitsForKey) log.warn(\"private_routing_waits_for_key\");\n", replace: "", label: "the log says at start that private routing is waiting for a key" },
  { file: "server/app.ts", find: "  if (config.privacyMode === \"basic\" && config.oneClickApiKey === null) log.warn(\"private_routing_without_partner_key\");\n", replace: "", label: "the log says at start that private routing is on with no key" },
  { file: "shared/api.ts", find: "export function routingOf(level: unknown): Routing {\n  return level === \"basic\" ?", replace: "export function routingOf(level: unknown): Routing {\n  return level !== \"public\" ?", label: "only the one level this server writes reads as private routing" },
  { file: "server/config.ts", find: "  const privacyMode: Confidentiality = privacyAsked ?? (oneClickApiKey === null ? \"public\" : \"basic\");", replace: "  const privacyMode: Confidentiality = privacyAsked ?? \"public\";", label: "with a key and nothing set, swaps are routed privately" },
  { file: "server/config.ts", find: "  const privacyMode: Confidentiality = privacyAsked ?? (oneClickApiKey === null ? \"public\" : \"basic\");", replace: "  const privacyMode: Confidentiality = privacyAsked ?? \"basic\";", label: "with no key and nothing set, the site starts and routes in public" },
  { file: "server/config.ts", find: "  if (privacyAsked !== null && privacyAsked !== \"basic\" && privacyAsked !== \"public\") fail(\"PRIVACY_MODE\", 'must be \"basic\" or \"public\"');\n", replace: "", label: "a routing setting that is neither basic nor public stops the server" },
  { file: "server/config.ts", find: "  if (production && privacyAsked === \"basic\" && oneClickApiKey === null) {", replace: "  if (false) {", label: "the live site does not start with private routing asked for and no key" },
  { file: "server/config.ts", find: "  const privateRoutingWaitsForKey = privacyAsked === null && oneClickApiKey === null;", replace: "  const privateRoutingWaitsForKey = false;", label: "the server knows when private routing is waiting for a key" },
  { file: "server/stub-provider.ts", find: "        if (body.confidentiality !== undefined && body.confidentiality !== \"public\") return makeQuote(body);\n", replace: "", label: "the practice provider sends no private preview to the real provider" },
  { file: "web/src/lib/swap-logic.ts", find: "  return mode === \"basic\" && withoutPrivate ? { withoutPrivate: true } : {};", replace: "  return withoutPrivate ? { withoutPrivate: true } : { withoutPrivate: false };", label: "the page says nothing of routing in a request unless public routing was chosen for this swap" },
  { file: "web/src/lib/swap-logic.ts", find: "    if (code === \"private_unavailable\") return { kind: \"without-private\", label: \"Swap without private routing\", disabled: false, busy: false };\n", replace: "", label: "where a private quote cannot be had, the card offers the swap without private routing" },
  { file: "web/src/lib/swap-logic.ts", find: "  if (routedPrivately(order) !== routedPrivately(reviewed)) return \"the routing\";\n", replace: "", label: "the page accepts no order made by another route than the one that was on screen" },
  { file: "scripts/check-build.ts", find: "    if (found !== 1) problems.push(", replace: "    if (false) problems.push(", label: "the build holds the first words in the form the server rewrites for a privately routed site" },
  // ---- the private-swap fee (FEE_BPS_PRIVATE) and points on private swaps ----
  { file: "server/quotes.ts", find: "  const fee = privately ? options.feeBpsPrivate : options.feeBps;", replace: "  const fee = options.feeBps;", label: "a private quote carries the private-swap fee, not the public one" },
  { file: "server/quotes.ts", find: "  const fee = privately ? options.feeBpsPrivate : options.feeBps;", replace: "  const fee = privately ? options.feeBpsPrivate + 1 : options.feeBps;", label: "a private quote's fee is the setting exactly" },
  { file: "server/config.ts", find: "  const feeBpsPrivate = int(env, \"FEE_BPS_PRIVATE\", 0, 0, 300);", replace: "  const feeBpsPrivate = int(env, \"FEE_BPS_PRIVATE\", 20, 0, 300);", label: "IntentSwap takes no fee on a private swap unless one is set" },
  { file: "server/config.ts", find: "  const feeBpsPrivate = int(env, \"FEE_BPS_PRIVATE\", 0, 0, 300);", replace: "  const feeBpsPrivate = int(env, \"FEE_BPS_PRIVATE\", 0, 0, 3000);", label: "the private-swap fee is bounded" },
  { file: "server/config.ts", find: "  const feeBps = int(env, \"FEE_BPS\", 0, 0, 300);", replace: "  const feeBps = int(env, \"FEE_BPS\", 40, 0, 300);", label: "IntentSwap takes no fee on a public swap unless one is set" },
  { file: "server/config.ts", find: "      if (production) fail(\"FEE_RECIPIENT\", \"is required while FEE_BPS or FEE_BPS_PRIVATE is above 0\");\n", replace: "", label: "the live server does not start with a fee set and no fee recipient" },
  { file: "server/config.ts", find: "  if (feeCharged) {\n    if (feeRecipient === null) {", replace: "  if (feeRecipient === null || feeCharged) {\n    if (feeRecipient === null) {", label: "the server starts without a fee recipient while no fee is set" },
  { file: "server/app.ts", find: "feeBps: config.feeBps, feeBpsPrivate: config.feeBpsPrivate });", replace: "feeBps: config.feeBps, feeBpsPrivate: config.feeBps });", label: "the server sends its own private-swap setting with a private quote" },
  { file: "server/verify.ts", find: "    if (ourRecipient === null || !sameFeeRecipient(sentFee.recipient, ourRecipient) || !Number.isInteger(sentFee.fee) || sentFee.fee < 1) reject(\"sent fees\");\n", replace: "", label: "a private quote that went out with a fee for anyone but this site is never accepted" },
  { file: "server/verify.ts", find: "    if (ours !== 1) reject(\"echo:appFees recipient\");\n    if (appBps < 1 || appBps > sentFee.fee) reject(\"echo:appFees share\");\n    // One entry beside ours", replace: "    if (appBps < 1 || appBps > sentFee.fee) reject(\"echo:appFees share\");\n    // One entry beside ours", label: "the echo of a private quote pays this site exactly once" },
  { file: "server/verify.ts", find: "    if (appBps < 1 || appBps > sentFee.fee) reject(\"echo:appFees share\");\n    // One entry beside ours", replace: "    // One entry beside ours", label: "the echo of a private quote never pays this site more than was sent, or nothing" },
  { file: "server/verify.ts", find: "      if (typeof fee !== \"number\" || !Number.isInteger(fee) || fee < 0 || fee > 500) reject(\"echo:appFees fee\");\n      if (sameFeeRecipient(entry.recipient, ourRecipient)) {", replace: "      if (typeof fee !== \"number\" || !Number.isInteger(fee) || fee > 500) reject(\"echo:appFees fee\");\n      if (sameFeeRecipient(entry.recipient, ourRecipient)) {", label: "a fee under nothing in the echo of a private quote is refused" },
  { file: "server/stub-provider.ts", find: "    const ours = asPrivate ? sentBps : Math.floor(sentBps / 2);", replace: "    const ours = Math.floor(sentBps / 2);", label: "the practice provider echoes a private quote's fee whole, as the real one does" },
  { file: "server/stub-provider.ts", find: "    const theirs = asPrivate ? PRIVATE_PROVIDER_BPS : Math.max(Math.ceil(sentBps / 2), 20);", replace: "    const theirs = Math.max(Math.ceil(sentBps / 2), 20);", label: "the practice provider adds its own fee beside a private quote's" },
  { file: "server/app.ts", find: "        const record = found !== null && found.confidentiality !== \"basic\" ? found : null;", replace: "        const record = found;", label: "a privately routed order is never found from its deposit address" },
  { file: "server/quotes.ts", find: "  return input.confidentiality === \"basic\" && status === 401;", replace: "  return input.confidentiality === \"basic\" && (status === 401 || status === 403);", label: "a screening refusal of a private quote is not told as private routing not available" },
  { file: "web/src/components/ReviewSheet.tsx", find: "          {walletRewards !== null && rewardsTyped === \"\" && !editingRewards ? (", replace: "          {privately ? null : walletRewards !== null && rewardsTyped === \"\" && !editingRewards ? (", label: "a private swap's review offers a rewards address like any other" },
  { file: "web/src/components/ReviewSheet.tsx", find: "          {walletRewards !== null && rewardsTyped === \"\" && !editingRewards ? (", replace: "          {noFee !== null ? null : walletRewards !== null && rewardsTyped === \"\" && !editingRewards ? (", label: "the review of a swap with no IntentSwap fee offers a rewards address like any other" },
  { file: "web/src/components/QuotePanel.tsx", find: "  const points = ready && pointsShown ?", replace: "  const points = ready && pointsShown && routing?.private !== true ?", label: "a private quote shows its points" },
  { file: "web/src/components/QuotePanel.tsx", find: "  const points = ready && pointsShown ?", replace: "  const points = ready && pointsShown && quote.fees.appBps > 0 ?", label: "a quote with no IntentSwap fee shows its points like any other" },
  { file: "web/src/pages/OrderPage.tsx", find: "        {order.rewardsAddress !== null ? (", replace: "        {order.rewardsAddress !== null && order.fees.appBps > 0 ? (", label: "an order with no IntentSwap fee says where its points go like any other" },
  { file: "web/src/lib/swap-logic.ts", find: "  return view !== null && view.fees.appBps === 0 && /^0+$/.test(view.fees.appAmount);", replace: "  return view !== null && view.fees.appBps === 0;", label: "only a fee of nothing in both figures is said as None" },
  { file: "web/src/lib/swap-logic.ts", find: "  return feeFree(view) ? \"None\" : null;", replace: "  return feeFree(view) || routedPrivately(view as { routing?: unknown }) ? \"None\" : null;", label: "a private swap's IntentSwap fee is given in figures" },
  { file: "web/src/pages/TrackPage.tsx", find: "{privateOn ? <> A privately routed order opens from its link or ID only.</> : null}", replace: "<> A privately routed order opens from its link or ID only.</>", label: "the Track order page speaks of private orders only where swaps are routed privately" },
  { file: "server/app.ts", find: "  if (config.siteUrlSet && config.siteUrl !== null) return new URL(config.siteUrl).host;", replace: "  if (config.siteUrl !== null) return new URL(config.siteUrl).host;", label: "the built-in site address does not pin the sign-in to itself" },
  { file: "server/app.ts", find: "  return host !== \"\" && origin !== null && origin === host ? host : null;", replace: "  return host !== \"\" ? host : null;", label: "a sign-in message is given only to a page on the host the request was made to" },
  { file: "server/config.ts", find: "  if (siteUrl === null && production) siteUrl = DEFAULT_SITE_URL;", replace: "  if (siteUrl === null) siteUrl = DEFAULT_SITE_URL;", label: "only the live site takes the built-in site address" },
  { file: "server/static.ts", find: "  if (!/^\\/[A-Za-z0-9/_-]{0,80}$/.test(pathname)) throw new Error(\"not an address of a page\");\n", replace: "", label: "only a plain address of a page is written into a canonical link" },
  { file: "server/static.ts", find: "  if (!SITE_ORIGIN.test(siteUrl)) throw new Error(\"the site's address is not a plain origin\");\n  if (!/^\\/[A-Za-z0-9/_-]{0,80}$/.test(pathname))", replace: "  if (!/^\\/[A-Za-z0-9/_-]{0,80}$/.test(pathname))", label: "a canonical link is written only at a plain address of a site" },
  { file: "server/static.ts", find: "known && !orderPage ? pageAt(pathname) : index", replace: "known ? pageAt(pathname) : index", label: "an order's page names no canonical address" },

  // ---- the Stats page ----
  { file: "server/stats.ts", find: "band: bandOf(delivery.usdMicro), quarter: showQuarter(delivery.at) };", replace: "band: bandOf(delivery.usdMicro), quarter: Math.floor(delivery.at / 1000) };", label: "a recent swap's row is kept with a quarter of an hour, never the time of its delivery" },
  { file: "server/stats.ts", find: "  if (recent.swaps >= feedMin) {", replace: "  if (recent.swaps >= 0) {", label: "recent swaps are listed only while enough were delivered in the last 24 hours" },
  { file: "server/stats.ts", find: "      if (!claim()) return false;", replace: "      claim();", label: "an order is added to the site's totals once" },
  { file: "server/app.ts", find: "    ...(config.statsPage ? [statsRoute] : []),", replace: "    statsRoute,", label: "the Stats page's data route is gone where the page is switched off" },
];

const only = process.argv.slice(2);
const chosen = only.length === 0 ? M : M.filter((m) => only.some((word) => m.file.includes(word) || m.label.includes(word)));
const missed: string[] = [];
const notFound: string[] = [];
let caught = 0;

// The copy: everything the tests need, with the installed packages linked rather than copied.
const root = process.cwd();
const copy = fs.mkdtempSync(path.join(os.tmpdir(), "intentswap-mutation-"));
// Screenshots and local notes are no part of what the tests read, and there can be hundreds of megabytes of them.
const SKIP = new Set(["node_modules", ".git", "data", "dist", "review", "notes"]);
// A local secrets file is never copied anywhere. Only the example file, which holds no values, goes along.
const copied = (source: string) => {
  const name = path.basename(source);
  return !SKIP.has(name) && (!name.startsWith(".env") || name === ".env.example");
};
fs.cpSync(root, copy, { recursive: true, filter: copied });
fs.symlinkSync(path.join(root, "node_modules"), path.join(copy, "node_modules"), "dir");
process.on("exit", () => fs.rmSync(copy, { recursive: true, force: true }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(130));

const testsPass = () => spawnSync("npx", ["vitest", "run"], { cwd: copy, encoding: "utf8" }).status === 0;

// The suite must pass before anything is changed, or a failure would prove nothing.
if (!testsPass()) {
  console.error("mutation-check: the tests do not pass as the code stands. Fix that first.");
  process.exit(2);
}

for (const mutation of chosen) {
  const file = path.join(copy, mutation.file);
  const original = fs.readFileSync(file, "utf8");
  if (!original.includes(mutation.find)) {
    notFound.push(`${mutation.file}: ${mutation.label}`);
    console.log(`NOT FOUND  ${mutation.label}`);
    continue;
  }
  fs.writeFileSync(file, original.replace(mutation.find, mutation.replace));
  const failed = !testsPass();
  fs.writeFileSync(file, original);
  if (failed) caught += 1;
  else missed.push(`${mutation.file}: ${mutation.label}`);
  console.log(`${failed ? "caught   " : "MISSED   "}  ${mutation.label}`);
}

console.log(`\nmutation-check: ${caught} of ${chosen.length} caught`);
for (const line of missed) console.log(`  missed: ${line}`);
for (const line of notFound) console.log(`  not found (the code changed; update this script): ${line}`);
process.exit(missed.length === 0 && notFound.length === 0 ? 0 : 1);
