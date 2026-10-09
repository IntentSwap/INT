import { TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { checkAddress } from "../../../shared/addresses.ts";
import { displayBps, displayExact } from "../../../shared/amounts.ts";
import type { CreateOrderBody } from "../../../shared/api.ts";
import { chainInfo, chainName, sendWindowMs } from "../../../shared/chains.ts";
import { REWARDS } from "../../../shared/rewards.ts";
import { api, ApiError } from "../api.ts";
import { IMPACT_BLOCK_BPS, IMPACT_WARN_BPS } from "../config.ts";
import { aboutMinutes, appFeeWords, feeFree, minutesText, modeTold, NO_FEE_NO_POINTS, orderDiffers, PRIVATE_UNAVAILABLE, rateText, refundFor, reviewAction, reviewSentence, routedPrivately, routingChoice, routingNote, walletAddressFor, type ReviewPhase, type Reviewed } from "../lib/swap-logic.ts";
import { clockTime } from "../lib/order-logic.ts";
import { navigate } from "../router.ts";
import { useApp } from "../stores/app.ts";
import { useOrders } from "../stores/orders.ts";
import { useSheet } from "../stores/sheet.ts";
import { heardRouting, quoteAge, useSwap } from "../stores/swap.ts";
import { useTokens } from "../stores/tokens.ts";
import { useWallet } from "../stores/wallet.ts";
import { Address } from "./Address.tsx";
import { Said } from "./Amount.tsx";
import { CoinIcon } from "./CoinIcon.tsx";
import { AddressField } from "./AddressField.tsx";
import { PrimaryButton, TextButton } from "./Button.tsx";
import { Sheet } from "./Sheet.tsx";

/** A random label for one confirmation, so that a retried request returns the same order instead of making a second. */
function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

/** Pads two exact amounts of one coin to the same number of decimals, so their points line up one above the other. */
function alignedPair(a: string, b: string): [string, string] {
  const decimals = (text: string) => (text.includes(".") ? text.length - text.indexOf(".") - 1 : 0);
  const most = Math.max(decimals(a), decimals(b));
  const pad = (text: string) => (most === 0 ? text : `${text.includes(".") ? text : `${text}.`}${"0".repeat(most - decimals(text))}`);
  return [pad(a), pad(b)];
}

/** A space that a line never breaks at: a number and its unit stay on one line together. */
const NBSP = "\u00a0";

function Row({ label, children, name }: { label: string; children: React.ReactNode; name?: string }) {
  return (
    <div className="review-row" data-row={name}>
      <dt className="muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The last look before an order is made: every number in full, both addresses in full,
 * how long there is to pay, and the Terms. Confirming makes the order; it moves no funds.
 * Where the server routes swaps privately, it also says how this one is routed, and the order is
 * asked for by that route and no other.
 */
export function ReviewSheet() {
  const close = useSheet((state) => state.close);
  const swap = useSwap();
  const tokens = useTokens((state) => state.byId);
  const wallet = useWallet();
  const termsVersion = useApp((state) => state.config?.termsVersion ?? "");
  const privacyMode = useApp((state) => state.config?.privacyMode ?? null);
  const remember = useOrders((state) => state.remember);

  const [phase, setPhase] = useState<ReviewPhase>("review");
  const [accepted, setAccepted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [editingRefund, setEditingRefund] = useState(false);
  // Where this swap's points go: what is typed here, or the wallet's own address when paying from one.
  const [rewardsText, setRewardsText] = useState("");
  const [editingRewards, setEditingRewards] = useState(false);
  // True when the numbers were replaced because the route changed, not the price.
  const [rerouted, setRerouted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const requestId = useRef(newRequestId());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const from = swap.fromId === null ? null : (tokens.get(swap.fromId) ?? null);
  const to = swap.toId === null ? null : (tokens.get(swap.toId) ?? null);
  const quote = swap.quote;
  const age = quoteAge(swap, now);
  // How this swap is routed, as the quote on screen says it. With the server routing in public, nothing is said.
  const routing = routingNote(privacyMode, quote, swap.withoutPrivate);
  const privately = routedPrivately(quote);
  const noFee = appFeeWords(quote);
  // A swap IntentSwap takes no fee on adds no points: they are counted from that fee, as the quote shows it.
  const noPoints = feeFree(quote);
  // Addresses are shown, sent and compared in their one standard spelling (the letter-case that
  // carries the checksum, for example). The server stores that spelling; anything else typed here
  // would come back looking different and stop the order.
  const standard = (chain: string | undefined, text: string) => {
    const check = chain === undefined ? null : checkAddress(chain, text.trim());
    return check !== null && check.ok ? check.address : text.trim();
  };
  // Paying from a wallet, the refund goes back to that wallet unless the person names another address
  // here. The wallet's own address is used only where it is known to be the person's on the paying
  // chain: on that chain itself, or on another of the same kind when the wallet is a plain one.
  const walletRefund =
    from === undefined || from === null || wallet.status !== "connected"
      ? null
      : walletAddressFor(from.chain, chainInfo(from.chain).family, { address: wallet.address, chain: wallet.chain, family: wallet.chain === null ? null : chainInfo(wallet.chain).family, plain: wallet.plain });
  const refundTo = standard(from?.chain, refundFor(swap.pay, swap.refundTo, walletRefund));
  const recipient = standard(to?.chain, swap.recipient);
  const refundValid = from !== null && checkAddress(from.chain, refundTo).ok;
  // While another refund address is being typed, the one that would be used if "Confirm" were
  // pressed now stays on screen in full: the wallet's own until what is typed is a valid address.
  const shownRefund = refundValid ? refundTo : standard(from?.chain, walletRefund ?? "");
  // Points belong to an address on BNB Chain. Paying from a wallet, that is the wallet's own address,
  // where it is known to be the person's there too (an ordinary wallet; not a contract wallet on
  // another chain). Sending it yourself, an address can be given, or the swap adds no points.
  const walletRewards =
    swap.pay !== "wallet" || wallet.status !== "connected" ? null : walletAddressFor(REWARDS.chain, chainInfo(REWARDS.chain).family, { address: wallet.address, chain: wallet.chain, family: wallet.chain === null ? null : chainInfo(wallet.chain).family, plain: wallet.plain });
  const rewardsTyped = rewardsText.trim();
  // Where a swap adds no points no address for them is shown, and so none is sent: nothing is in force unseen.
  const rewardsTo = noPoints ? "" : rewardsTyped !== "" ? standard(REWARDS.chain, rewardsTyped) : (walletRewards ?? "");
  const rewardsValid = rewardsTo === "" || checkAddress(REWARDS.chain, rewardsTo).ok;
  const keepRefund = () => {
    // Leaves the field. Something half-typed is dropped; a valid new address stays the refund address.
    if (!refundValid) swap.setRefundTo("");
    setEditingRefund(false);
  };

  // Every new set of numbers must be on screen for a moment before it can be confirmed, and needs
  // its own tick when the price impact is large: a yes given to one quote is not a yes to the next.
  const quoteKey = quote === null ? null : `${quote.amountIn}|${quote.amountOut}|${quote.minAmountOut}|${quote.fees.appBps}|${quote.fees.providerBps}|${privately ? "private" : ""}`;
  const firstKey = useRef(quoteKey);
  const [settling, setSettling] = useState(false);
  const [impactAccepted, setImpactAccepted] = useState(false);
  useEffect(() => {
    if (quoteKey === null || quoteKey === firstKey.current) return;
    firstKey.current = quoteKey;
    setImpactAccepted(false);
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), 1000);
    return () => clearTimeout(timer);
  }, [quoteKey]);
  const impact = quote?.priceImpactBps ?? null;
  const impactUnconfirmed = impact !== null && impact > IMPACT_BLOCK_BPS && !impactAccepted;

  const action = useMemo(() => reviewAction({ phase, quote: age, termsAccepted: accepted, settling, impactUnconfirmed }), [phase, age, accepted, settling, impactUnconfirmed]);

  // Nothing to review: the inputs changed underneath the sheet (for example the wallet was disconnected).
  if (from === null || to === null) return null;

  // Numbers that can no longer be confirmed stay on screen, dimmed: an old quote, and one the server would not make an order of.
  const stale = age === "expired" || age === "loading" || phase === "unavailable";

  // However the sheet comes to close. After "private routing is not available" the card takes over:
  // it says the same sentence and offers the choice. Nothing is asked for again from here.
  const leave = () => {
    if (phase === "unavailable") swap.privateRefused();
    close();
  };

  const confirm = async () => {
    if (quote === null || !refundValid || !rewardsValid) return;
    setPhase("creating");
    setProblem(null);
    const reviewed: Reviewed = { from: from.id, to: to.id, amountIn: quote.amountIn, minAmountOut: quote.minAmountOut, slippageBps: quote.slippageBps, recipient, refundTo, rewardsAddress: rewardsTo === "" ? null : rewardsTo, ...(quote.routing !== undefined ? { routing: quote.routing } : {}) };
    const body: CreateOrderBody & { requestId: string } = {
      from: from.id,
      to: to.id,
      amount: quote.amountIn,
      pay: swap.pay,
      // The limit the reviewed numbers were worked out with, not whatever the card holds by now.
      slippageBps: quote.slippageBps,
      recipient,
      refundTo,
      ...(swap.pay === "wallet" && wallet.address !== null ? { sender: wallet.address } : {}),
      ...(rewardsTo !== "" ? { rewardsAddress: rewardsTo } : {}),
      // The person's choice of public routing, exactly as the quote was asked for. No level is ever named.
      ...routingChoice(privacyMode, swap.withoutPrivate),
      // With the numbers goes the routing of the quote that was on screen, in that quote's own word: the server makes no order by another route.
      reviewed: { amountOut: quote.amountOut, minAmountOut: quote.minAmountOut, totalFeeBps: quote.fees.appBps + quote.fees.providerBps, ...(quote.routing !== undefined ? { routing: quote.routing } : {}) },
      termsVersion,
      termsAccepted: true,
      requestId: requestId.current,
    };
    try {
      const order = await api.createOrder(body);
      // The order must be the one that was reviewed. If anything differs, nothing is paid.
      const differs = orderDiffers(order, reviewed);
      if (differs !== null) {
        // Nothing more is confirmed from this sheet: the only way on is to close it and start again.
        setPhase("mismatch");
        setProblem(`The order that came back does not match what you reviewed (${differs}). Nothing was sent, and nothing should be sent to it.`);
        return;
      }
      // Kept in this browser before anything is paid, so a closed tab can find the order again.
      remember(order);
      close();
      // A choice of public routing was for this swap. The next one starts as the server routes.
      swap.orderMade();
      navigate(`/order/${order.id}`);
    } catch (err) {
      // The review is gone (the person left the swap page before the answer came): the card it was of is gone too, and takes no numbers.
      if (useSheet.getState().current !== "review") return;
      if (err instanceof ApiError && err.code === "price_moved" && err.quote !== null) {
        // No order was made. The new numbers take the place of the old ones and need a fresh yes.
        // So does a new route: the server makes no order by another route than the one reviewed, and says which it would be.
        setRerouted(routedPrivately(err.quote) !== privately);
        heardRouting(modeTold(body, err.quote));
        useSwap.setState({ quote: err.quote, fetchedAt: Date.now(), loading: false, dirty: false, problem: null });
        setPhase("moved");
        return;
      }
      if (err instanceof ApiError && err.code === "private_unavailable") {
        // No order was made, and none is made in public instead: that is the person's choice, and it is made on the card.
        setPhase("unavailable");
        setProblem(`${PRIVATE_UNAVAILABLE} No order was made.`);
        return;
      }
      setPhase("review");
      setProblem(err instanceof ApiError ? err.message : "Something went wrong. Nothing was sent. Try again.");
      // The label of a request the server would not accept under it is not used again.
      if (err instanceof ApiError && err.code === "conflict") requestId.current = newRequestId();
    }
  };

  const act = () => {
    if (action.kind === "refresh") swap.refreshNow();
    else if (action.kind === "confirm") void confirm();
    else if (action.kind === "close") leave();
  };

  // The time to send in, as the order's page will count it: two minutes less than the order's own deadline.
  const payWindow = minutesText(sendWindowMs(swap.pay, from.chain));
  const [receiveText, minimumText] = quote === null ? ["", ""] : alignedPair(displayExact(BigInt(quote.amountOut), to.decimals), displayExact(BigInt(quote.minAmountOut), to.decimals));

  return (
    <Sheet
      title="Review swap"
      onClose={leave}
      locked={phase === "creating"}
      footer={
        <>
          <p className="review-problem" role="alert" data-kind={problem !== null ? "error" : "plain"}>
            {problem ?? (!refundValid && quote !== null ? "Enter a valid refund address above." : !rewardsValid && quote !== null ? "Enter a valid rewards address above, or clear that field." : age === "expired" ? "This quote has expired. Refresh it to see the numbers as they are now." : " ")}
          </p>
          <PrimaryButton onClick={act} disabled={action.disabled || (action.kind === "confirm" && (!refundValid || !rewardsValid))} busy={action.busy}>
            {action.label}
          </PrimaryButton>
        </>
      }
    >
      <div className="review">
        {quote !== null ? (
          <p className="review-sentence" data-stale={stale || undefined}>
            <Said text={reviewSentence(from, to, BigInt(quote.amountIn), BigInt(quote.amountOut), { privately })} spoken={reviewSentence(from, to, BigInt(quote.amountIn), BigInt(quote.amountOut), { spoken: true, privately })} />
          </p>
        ) : (
          <p className="review-sentence muted">The quote is being refreshed.</p>
        )}

        {phase === "moved" ? (
          <p className="notice notice-warning" role="alert">
            <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>{rerouted ? "This swap would be routed another way than the one you reviewed. No order was made. Check the new details and confirm again." : "The price moved. No order was made. Check the new numbers and confirm again."}</span>
          </p>
        ) : null}

        {quote !== null ? (
          <dl className="review-rows" data-stale={stale || undefined}>
            <Row label="You send">
              <span className="review-coin">
                <CoinIcon symbol={from.symbol} chain={from.chain} size={24} />
                <span className="mono">
                  {displayExact(BigInt(quote.amountIn), from.decimals)}{NBSP}{from.symbol}
                </span>
              </span>
              <span className="review-sub muted">on {chainName(from.chain)}</span>
            </Row>
            <Row label="You receive, about">
              <span className="review-coin">
                <CoinIcon symbol={to.symbol} chain={to.chain} size={24} />
                <span className="mono">
                  {receiveText}{NBSP}{to.symbol}
                </span>
              </span>
              <span className="review-sub muted">on {chainName(to.chain)}</span>
            </Row>
            {routing !== null ? (
              <Row label="Routing" name="routing">
                {routing.private ? (
                  <span className="chip routing-tag" data-tone="private">
                    {routing.text}
                  </span>
                ) : (
                  routing.text
                )}
              </Row>
            ) : null}
            <Row label="Minimum received">
              <span className="mono">
                {minimumText} {to.symbol}
              </span>
              <span className="review-sub muted">
                <span className="mono">{displayBps(quote.slippageBps)}</span> slippage
              </span>
            </Row>
            <Row label="Rate">
              <span className="mono">
                <Said text={rateText(from, to, BigInt(quote.amountIn), BigInt(quote.amountOut)) ?? ""} spoken={rateText(from, to, BigInt(quote.amountIn), BigInt(quote.amountOut), { spoken: true }) ?? ""} />
              </span>
            </Row>
            <Row label="IntentSwap fee">
              {noFee !== null ? (
                <span className="muted">{noFee}</span>
              ) : (
                <>
                  <span className="mono">
                    {displayExact(BigInt(quote.fees.appAmount), from.decimals)} {from.symbol}
                  </span>
                  <span className="review-sub muted mono">{displayBps(quote.fees.appBps)}</span>
                </>
              )}
            </Row>
            <Row label="Provider fee">
              <span className="mono">
                {displayExact(BigInt(quote.fees.providerAmount), from.decimals)} {from.symbol}
              </span>
              <span className="review-sub muted mono">{displayBps(quote.fees.providerBps)}</span>
            </Row>
            <Row label={`${chainName(to.chain)} network fee`}>
              {quote.withdrawFee !== null && BigInt(quote.withdrawFee) > 0n ? (
                <>
                  <span className="mono">
                    {displayExact(BigInt(quote.withdrawFee), to.decimals)} {to.symbol}
                  </span>
                  <span className="review-sub muted">included above</span>
                </>
              ) : (
                <span className="muted">Included above</span>
              )}
            </Row>
            <Row label="Estimated time">{aboutMinutes(quote.timeEstimate)}</Row>
            {impact !== null ? (
              <Row label="Price impact">
                <span className={`mono${impact > IMPACT_WARN_BPS ? " review-impact" : ""}`} data-level={impact > IMPACT_BLOCK_BPS ? "danger" : impact > IMPACT_WARN_BPS ? "warning" : undefined}>
                  {displayBps(impact)}
                </span>
              </Row>
            ) : null}
            <Row label="Time to pay">
              {payWindow}
              <span className="review-sub muted">until about {clockTime(now + sendWindowMs(swap.pay, from.chain))} if you confirm now</span>
            </Row>
          </dl>
        ) : null}

        {impact !== null && impact > IMPACT_WARN_BPS && impact <= IMPACT_BLOCK_BPS ? (
          <p className="notice notice-warning" role="note">
            <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>Price impact is {displayBps(impact)}. You receive noticeably less than the market value of what you pay.</span>
          </p>
        ) : null}
        {impact !== null && impact > IMPACT_BLOCK_BPS ? (
          <div className="notice notice-danger" role="note">
            <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
            <div>
              <p>Price impact is {displayBps(impact)}. You would lose a large part of the value of what you pay.</p>
              <label className="check">
                <input type="checkbox" checked={impactAccepted} onChange={(event) => setImpactAccepted(event.target.checked)} disabled={phase === "creating" || phase === "mismatch" || phase === "unavailable"} />
                <span>I understand and want to continue</span>
              </label>
            </div>
          </div>
        ) : null}

        <div className="review-address">
          <p className="review-address-label">
            Receiving address<span className="muted"> · {chainName(to.chain)}</span>
          </p>
          <p className="review-address-value">
            <Address value={recipient} />
          </p>
        </div>

        <div className="review-address">
          <p className="review-address-label">
            Refund address<span className="muted"> · {chainName(from.chain)}</span>
          </p>
          {editingRefund ? (
            <>
              {/* The address in force, in full, the whole time: nothing can be confirmed without it on screen. */}
              {shownRefund !== "" ? (
                <p className="review-address-value">
                  <Address value={shownRefund} />
                </p>
              ) : null}
              <AddressField label="New refund address" hint={`If the swap fails, your ${from.symbol} comes back here.`} chain={from.chain} value={swap.refundTo} onChange={swap.setRefundTo} walletAddress={swap.pay === "wallet" ? walletRefund : null} />
              <p className="review-address-note muted">
                <TextButton onClick={keepRefund} disabled={phase === "creating"}>
                  Keep this address
                </TextButton>
              </p>
            </>
          ) : (
            <>
              <p className="review-address-value">
                <Address value={refundTo} />
              </p>
              <p className="review-address-note muted">
                If the swap fails, your {from.symbol} comes back here.{" "}
                {swap.pay === "wallet" ? (
                  <TextButton onClick={() => setEditingRefund(true)} disabled={phase === "creating"}>
                    Change
                  </TextButton>
                ) : null}
              </p>
            </>
          )}
        </div>

        <div className="review-address">
          <p className="review-address-label">
            Points{noPoints ? null : <span className="muted"> · {chainName(REWARDS.chain)}</span>}
          </p>
          {noPoints ? (
            <p className="review-address-note muted">{NO_FEE_NO_POINTS}</p>
          ) : walletRewards !== null && rewardsTyped === "" && !editingRewards ? (
            <>
              <p className="review-address-value">
                <Address value={walletRewards} />
              </p>
              <p className="review-address-note muted">
                When this swap is delivered, its points go to your wallet's address.{" "}
                <TextButton onClick={() => setEditingRewards(true)} disabled={phase === "creating"}>
                  Choose another address
                </TextButton>
              </p>
            </>
          ) : (
            <AddressField
              label="Rewards address"
              hint={walletRewards !== null ? "Left empty, the points go to your wallet's address." : "Optional. Without one, this swap adds no points."}
              chain={REWARDS.chain}
              value={rewardsText}
              onChange={setRewardsText}
              walletAddress={null}
            />
          )}
        </div>

        <p className="review-plain muted">
          Confirming makes the order, with a final quote taken at that moment. If that quote is more than 1% worse than the numbers above, no order is made and you are shown the new numbers first. Nothing leaves your wallet until you pay, and an order cannot be changed once it is made.
        </p>

        <label className="check">
          <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} disabled={phase === "creating" || phase === "mismatch" || phase === "unavailable"} />
          <span>
            I have read and accept the{" "}
            <a href="/terms" target="_blank" rel="noopener">
              Terms of Use
            </a>
            .
          </span>
        </label>
      </div>
    </Sheet>
  );
}
