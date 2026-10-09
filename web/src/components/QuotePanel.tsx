import { ChevronDown, TriangleAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { displayBps } from "../../../shared/amounts.ts";
import type { QuoteView, TokenView } from "../../../shared/api.ts";
import { chainName } from "../../../shared/chains.ts";
import { briefPoints, swapPointsMicro } from "../../../shared/rewards.ts";
import { IMPACT_BLOCK_BPS, IMPACT_WARN_BPS, SLOW_SWAP_SECONDS } from "../config.ts";
import { aboutMinutes, appFeeWords, feeFree, rateText, type RoutingNote } from "../lib/swap-logic.ts";
import { Amount, Said } from "./Amount.tsx";

interface Props {
  quote: QuoteView | null;
  from: TokenView | null;
  to: TokenView | null;
  loading: boolean;
  /** True while a newer quote is on its way: the old numbers stay, thinned. */
  stale: boolean;
  /** True while an amount is typed in. The quote's place is kept from then on, whatever comes of the quote, so that nothing moves when it arrives. */
  held?: boolean;
  /** Whether this swap's points have somewhere to go by default (see pointsByDefault). Where they have not, the line says nothing of points. */
  pointsShown?: boolean;
  /** What the breakdown's first row says of this quote's routing (see routingNote). Null where the server routes in public: there is then no such row. */
  routing?: RoutingNote | null;
  /** Open the breakdown from the start. Only the page of component states uses it. */
  startOpen?: boolean;
  impactConfirmed: boolean;
  onConfirmImpact(value: boolean): void;
}

function Row({ label, children, tall = false, name }: { label: string; children: React.ReactNode; tall?: boolean; name?: string }) {
  return (
    <div className="quote-row" data-tall={tall || undefined} data-row={name}>
      <dt className="muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * An amount with a short note beside it: "0.20% · 0.001 ETH". On a narrow screen the two
 * are stacked, amount first, so neither is ever broken across lines. `lead` says which
 * comes first when they share a line.
 */
function Pair({ main, sub, lead }: { main: React.ReactNode; sub: React.ReactNode; lead: "main" | "sub" }) {
  const dot = (
    <span className="quote-dot muted" aria-hidden="true">
      ·
    </span>
  );
  return (
    <span className="quote-pair" data-lead={lead}>
      {lead === "main" ? <span className="quote-main">{main}</span> : <span className="quote-sub muted">{sub}</span>}
      {dot}
      {lead === "main" ? <span className="quote-sub muted">{sub}</span> : <span className="quote-main">{main}</span>}
    </span>
  );
}

/**
 * The quote. Nothing at all until an amount is typed in; then one line: the rate, the points this
 * swap adds, and how long it takes. Pressing the line opens the rest (minimum received, the three
 * fees, the time, the points). The line's place is kept from the moment there is an amount, and its height never
 * changes, so a quote arriving or refreshing moves nothing. The line itself says nothing of routing;
 * where the server routes privately, the rest begins with a row that does.
 */
export function QuotePanel({ quote, from, to, loading, stale, held = false, pointsShown = true, routing = null, startOpen = false, impactConfirmed, onConfirmImpact }: Props) {
  const id = useId();
  const [expanded, setExpanded] = useState(startOpen);
  const ready = quote !== null && from !== null && to !== null;
  // A breakdown that was open belongs to the quote it was opened on. When that quote is gone, so is it.
  useEffect(() => {
    if (!ready && !startOpen) setExpanded(false);
  }, [ready, startOpen]);

  const first = loading && !ready;
  const open = ready || first || held;
  const impact = ready ? quote.priceImpactBps : null;
  const slow = ready && quote.timeEstimate > SLOW_SWAP_SECONDS;
  // Points are counted from the IntentSwap fee the quote shows. A quote with none adds none: nothing is said of points then.
  const points = ready && pointsShown && !feeFree(quote) ? swapPointsMicro(quote.amountInUsd, quote.fees.appBps, from.symbol, to.symbol) : null;
  const noFee = ready ? appFeeWords(quote) : null;
  const shown = ready && expanded;

  return (
    <div className="quote" data-open={open || undefined} data-stale={stale || undefined} data-expanded={shown || undefined}>
      <div className="quote-slot">
        {open ? (
          <div className="quote-body">
            {ready ? (
              <button type="button" className="quote-summary" aria-expanded={expanded} aria-controls={`${id}-more`} onClick={() => setExpanded((value) => !value)}>
                <span className="sr-only">Quote: </span>
                <span className="quote-rate mono">
                  <Said text={rateText(from, to, BigInt(quote.amountIn), BigInt(quote.amountOut)) ?? ""} spoken={rateText(from, to, BigInt(quote.amountIn), BigInt(quote.amountOut), { spoken: true }) ?? ""} />
                </span>
                {/* The time comes first here and is drawn last (the row runs from the right): where the line has no room
                    for both labels, it is the points that go to a second row, out of sight, and never the time or the rate.
                    The points are also a row of the breakdown. */}
                <span className="quote-chips">
                  <span className="chip" data-tone={slow ? "warning" : undefined}>
                    <span className="sr-only">, </span>
                    {slow ? <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" /> : null}
                    {aboutMinutes(quote.timeEstimate)}
                  </span>
                  {points !== null && points > 0n ? (
                    <span className="chip" data-tone="points">
                      <span className="sr-only">, </span>+{briefPoints(points)} points
                    </span>
                  ) : null}
                </span>
                <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" />
                <span className="sr-only">. {expanded ? "Hide" : "Show"} the fees</span>
              </button>
            ) : (
              // The line's place, kept: a quiet shimmer while a first quote is fetched, and nothing where none could be had.
              <div className="quote-summary" data-empty={!first || undefined} aria-hidden="true">
                {first ? (
                  <>
                    <span className="skeleton skeleton-rate" />
                    <span className="skeleton skeleton-chip" />
                  </>
                ) : null}
              </div>
            )}
            <div className="quote-more" id={`${id}-more`} inert={!shown}>
              <div className="quote-more-inner">
                {ready ? (
                  <dl className="quote-rows">
                    {routing !== null ? (
                      <Row label="Routing" name="routing">
                        {routing.text}
                      </Row>
                    ) : null}
                    <Row label="Minimum received" tall>
                      <Pair
                        lead="main"
                        main={<Amount raw={quote.minAmountOut} decimals={to.decimals} symbol={to.symbol} steady />}
                        sub={
                          <>
                            <span className="mono">{displayBps(quote.slippageBps)}</span> slippage
                          </>
                        }
                      />
                    </Row>
                    <Row label="IntentSwap fee" tall>
                      {noFee !== null ? <span className="muted">{noFee}</span> : <Pair lead="sub" main={<Amount raw={quote.fees.appAmount} decimals={from.decimals} symbol={from.symbol} />} sub={<span className="mono">{displayBps(quote.fees.appBps)}</span>} />}
                    </Row>
                    <Row label="Provider fee" tall>
                      <Pair lead="sub" main={<Amount raw={quote.fees.providerAmount} decimals={from.decimals} symbol={from.symbol} />} sub={<span className="mono">{displayBps(quote.fees.providerBps)}</span>} />
                    </Row>
                    {/* The fee is already inside the amount shown above. */}
                    <Row label={`${chainName(to.chain)} network fee`} tall>
                      {quote.withdrawFee !== null && BigInt(quote.withdrawFee) > 0n ? <Pair lead="main" main={<Amount raw={quote.withdrawFee} decimals={to.decimals} symbol={to.symbol} />} sub="included" /> : <span className="muted">Included</span>}
                    </Row>
                    <Row label="Estimated time" tall>
                      {slow ? (
                        <Pair
                          lead="main"
                          main={
                            <span className="quote-slow">
                              <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
                              <span>{aboutMinutes(quote.timeEstimate)}</span>
                            </span>
                          }
                          sub="slower than most"
                        />
                      ) : (
                        aboutMinutes(quote.timeEstimate)
                      )}
                    </Row>
                    {points !== null && points > 0n ? (
                      <Row label="Points" tall>
                        <Pair lead="main" main={<span className="mono">+{briefPoints(points)}</span>} sub="when delivered" />
                      </Row>
                    ) : null}
                  </dl>
                ) : null}
              </div>
            </div>
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
                    <input type="checkbox" checked={impactConfirmed} onChange={(event) => onConfirmImpact(event.target.checked)} />
                    <span>I understand and want to continue</span>
                  </label>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
