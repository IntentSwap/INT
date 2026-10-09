// Points and weekly rewards. One thing to look at: this week, with its dates, its countdown, about
// how many points everyone has together and, after a sign-in, the points of the address that
// signed in, with its share of the week's points. Under it: the current pool where a reserve wallet
// is set, that address's swaps and payouts, and the rules in short.
//
// Nobody is shown another address's points: of everyone else there is one rounded total, brought up
// to date every quarter of an hour, and no list. An address's share and its estimate are worked out
// by the server and read here as they come.
// To see one's own, the wallet is asked to sign one plain message; the page says so before the
// wallet opens.

import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { displayExact } from "../../../shared/amounts.ts";
import { explorerAddressUrl, explorerTxUrl } from "../../../shared/chains.ts";
import { RESERVE_ASSET, REWARDS, showPoints, type PoolView, type RewardsPublic, type RewardsView } from "../../../shared/rewards.ts";
import { Address } from "../components/Address.tsx";
import { Amount } from "../components/Amount.tsx";
import { PrimaryButton, TextButton } from "../components/Button.tsx";
import { CoinIcon } from "../components/CoinIcon.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { TableFrame } from "../components/DocsLayout.tsx";
import { Link } from "../components/Link.tsx";
import { Reveal } from "../components/Reveal.tsx";
import { aboutPoints, countdownText, ESTIMATE_NOTE, momentText, pairText, reasonWords, RULES_IN_SHORT, shareText, usdMicroText, usdText, weekDates, weekName } from "../lib/rewards-logic.ts";
import { shortAddress } from "../lib/swap-logic.ts";
import { useRewards } from "../stores/rewards.ts";
import { useWallet } from "../stores/wallet.ts";
import "../styles/home.css";
import "../styles/rewards.css";

/** Re-draws once a second, for the countdown. */
function useSecond(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function TxLinks({ hashes }: { hashes: readonly string[] }) {
  if (hashes.length === 0) return <span className="muted">Being sent</span>;
  return (
    <span className="rewards-txs">
      {hashes.map((hash, index) => {
        const url = explorerTxUrl(REWARDS.chain, hash);
        return url === null ? null : (
          <a key={hash} href={url} target="_blank" rel="noopener noreferrer" className="outbound">
            {hashes.length === 1 ? "Transaction" : `Transaction ${index + 1}`}
            <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
            <span className="sr-only">(opens the block explorer)</span>
          </a>
        );
      })}
    </span>
  );
}

/** This week: its dates, the time left in it, and the points of everyone together as one total. */
function Week({ summary, offset }: { summary: RewardsPublic | null; offset: number }) {
  const now = useSecond() + offset;
  if (summary === null) {
    return (
      <div className="rewards-clock">
        <p className="rewards-label mono">This week</p>
        <p className="skeleton rewards-waiting" aria-hidden="true" />
      </div>
    );
  }
  const left = Date.parse(summary.week.end) - now;
  const total = BigInt(summary.weekPointsMicro);
  return (
    <div className="rewards-clock">
      <p className="rewards-label mono">This week</p>
      {/* The clock is for the eye; a screen reader is told the dates once, not the time every second. */}
      <p className="rewards-count mono" aria-hidden="true">
        {countdownText(left)}
      </p>
      <p className="muted">
        {weekDates(summary.week.start, summary.week.end)}, by the clock in UTC. <span className="sr-only">The week closes at midnight on Sunday, UTC.</span>
        <span aria-hidden="true">Left until it closes.</span>
      </p>
      {/* One total, and no list behind it: nobody's points but one's own are shown anywhere. */}
      <div className="rewards-total">
        <p className="rewards-label mono">This week's points</p>
        {total > 0n ? (
          <>
            <p className="rewards-figure mono">{aboutPoints(total)}</p>
            <p className="muted">Collected by everyone together. Brought up to date every quarter of an hour.</p>
          </>
        ) : (
          <p className="muted">No points have been collected yet this week.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Beside the week: an invitation to connect and sign in, or the signed-in address's points, with
 * its share of the week's points and what that share of the pool comes to. Both come from the
 * server with the address's own points: nothing here works them out.
 */
function Mine({ mine }: { mine: RewardsView | null }) {
  const wallet = useWallet();
  const rewards = useRewards();
  const signedIn = rewards.session !== null && mine !== null;
  if (signedIn) {
    const carried = BigInt(mine.week.carriedInMicro);
    const own = BigInt(mine.week.pointsMicro);
    // The estimate is there where a reserve wallet is set and its balance has been read: an amount of NEAR, and its dollars where there is a price.
    const part = mine.share;
    return (
      <div className="rewards-mine">
        <p className="rewards-label mono">Your points this week</p>
        <p className="rewards-points mono">{showPoints(BigInt(mine.week.pointsMicro))}</p>
        <p className="muted">
          All time: <span className="mono">{showPoints(BigInt(mine.allTimeMicro))}</span>
        </p>
        {carried > 0n ? <p className="muted">Includes {showPoints(carried)} carried from last week, when no payout was sent for them.</p> : null}
        <dl className="rewards-facts">
          <div className="rewards-fact">
            <dt className="rewards-label mono">Your share</dt>
            <dd className="rewards-figure mono">{own > 0n ? shareText(BigInt(part.bps)) : "0%"}</dd>
          </div>
          {part.estimate !== null ? (
            <div className="rewards-fact">
              <dt className="rewards-label mono">Estimated reward</dt>
              <dd className="rewards-figure">
                <Amount raw={part.estimate} decimals={part.decimals} symbol={RESERVE_ASSET.symbol} />
              </dd>
              {/* In dollars beside it, only where there is a price for the coin just now. */}
              {part.estimateCents !== null ? <dd className="muted">about {usdText(BigInt(part.estimateCents))}</dd> : null}
            </div>
          ) : null}
        </dl>
        {part.estimate !== null ? <p className="muted">{ESTIMATE_NOTE}</p> : null}
        {own > 0n ? null : (
          <p className="muted">
            <Link href="/">Make a swap to collect points.</Link>
          </p>
        )}
        <p className="rewards-who muted">
          Signed in as <span className="mono">{shortAddress(mine.address)}</span>
          <TextButton onClick={rewards.signOut}>Sign out</TextButton>
        </p>
      </div>
    );
  }
  const busy = rewards.step !== "idle";
  return (
    <div className="rewards-mine">
      <p className="rewards-label mono">Your points</p>
      {wallet.status === "connected" && wallet.address !== null ? (
        <>
          {/* Said before the wallet opens: what it will be asked, and that it is not a payment. */}
          <p className="rewards-ask">Signing in asks your wallet to sign one plain message, to show that this address is yours. It is not a transaction: it moves nothing, approves nothing and costs no network fee.</p>
          <PrimaryButton onClick={() => void rewards.signIn(wallet.address ?? "")} disabled={busy} busy={busy}>
            {rewards.step === "signing" ? "Confirm in your wallet" : rewards.step === "checking" ? "Checking" : rewards.step === "asking" ? "One moment" : `Sign in as ${shortAddress(wallet.address)}`}
          </PrimaryButton>
        </>
      ) : (
        <>
          <p className="rewards-ask">Connect the wallet whose points you want to see. Points are shown only to the address they belong to.</p>
          <PrimaryButton onClick={() => void wallet.connect()} disabled={wallet.status === "connecting"} busy={wallet.status === "connecting"}>
            {wallet.status === "connecting" ? "Connecting" : "Connect to see your points"}
          </PrimaryButton>
        </>
      )}
      <p className="rewards-message" role="status">
        {rewards.error ?? " "}
      </p>
    </div>
  );
}

function Swaps({ mine }: { mine: RewardsView }) {
  return (
    <section className="rewards-part" aria-labelledby="rewards-swaps">
      <h2 id="rewards-swaps" className="rewards-heading">
        The swaps behind them
      </h2>
      {mine.swaps.length === 0 ? (
        <p className="muted">
          No delivered swap has this address as its rewards address. <Link href="/">Make a swap</Link> from this wallet, and it will be listed here when it is delivered.
        </p>
      ) : (
        <TableFrame label="Your swaps and their points">
          <thead>
            <tr>
              <th scope="col">Delivered (UTC)</th>
              <th scope="col">Swap</th>
              <th scope="col">Points</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {mine.swaps.map((swap) => (
              <tr key={`${swap.at}-${swap.pointsMicro}-${swap.from.symbol}-${swap.to.symbol}`}>
                <td>{momentText(swap.at)}</td>
                <th scope="row">{pairText(swap.from, swap.to)}</th>
                <td className="mono">{showPoints(BigInt(swap.pointsMicro))}</td>
                <td className="rewards-note">{reasonWords(swap.reasons)}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      )}
    </section>
  );
}

function Payouts({ mine }: { mine: RewardsView }) {
  if (mine.payouts.length === 0) return null;
  return (
    <section className="rewards-part" aria-labelledby="rewards-payouts">
      <h2 id="rewards-payouts" className="rewards-heading">
        Your payouts
      </h2>
      <TableFrame label="Payouts to your address">
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Amount</th>
            <th scope="col">Sent</th>
          </tr>
        </thead>
        <tbody>
          {mine.payouts.map((payout) => (
            <tr key={payout.week}>
              <th scope="row">{weekName(payout.week)}</th>
              <td className="mono">
                {displayExact(BigInt(payout.amount), payout.decimals)} {payout.asset}
              </td>
              <td>
                <TxLinks hashes={payout.txs} />
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
    </section>
  );
}

/**
 * The current pool: what the reserve wallet holds of the coin rewards are paid in, NEAR on BNB
 * Chain, as the server last read it, with its dollar value beneath where there is a price, and a
 * link to the wallet on the chain's own explorer so that anyone can check it; and what has been
 * paid from it. Nothing else the wallet holds is shown. Not drawn at all while no reserve wallet is set.
 */
function Pool({ pool, summary }: { pool: PoolView; summary: RewardsPublic }) {
  const url = explorerAddressUrl(REWARDS.chain, pool.address);
  return (
    <section className="rewards-part" aria-labelledby="rewards-pool">
      <h2 id="rewards-pool" className="rewards-heading">
        Current pool
      </h2>
      {pool.amount !== null ? (
        <>
          <p className="rewards-pool-total">
            <CoinIcon symbol={RESERVE_ASSET.symbol} chain={RESERVE_ASSET.chain} logo="near" size={32} />
            <Amount raw={pool.amount} decimals={pool.decimals} symbol={RESERVE_ASSET.symbol} />
          </p>
          {/* The dollar value, only where there is a price for the coin just now. */}
          {pool.usdMicro !== null ? <p className="rewards-figure mono">about {usdMicroText(BigInt(pool.usdMicro))}</p> : null}
          <p className="muted">
            What the rewards wallet holds in NEAR on BNB Chain{pool.readAt !== null ? <>, read from the chain on {momentText(pool.readAt)} UTC</> : null}. Each week's payout is sent from it, shared out by points.
          </p>
        </>
      ) : (
        <p className="muted">The balance could not be read just now.</p>
      )}
      <p className="muted">Rewards are paid in NEAR on BNB Chain, to the address you signed in with.</p>
      <p className="rewards-address">
        <span className="token-address">
          <Address value={pool.address} />
        </span>
        <CopyButton value={pool.address} what="the rewards wallet's address" />
        {url !== null ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className="outbound">
            View the wallet on BscScan
            <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
      </p>
      {summary.weeks.length > 0 ? (
        <>
          {/* The total is of what was paid in NEAR. A week paid in another coin is in the list below, in its own. */}
          {summary.weeksPaid > 0 ? (
            <p className="muted">
              Paid out so far:{" "}
              <span className="mono">
                {displayExact(BigInt(summary.totalPaid), pool.decimals)} {RESERVE_ASSET.symbol}
              </span>{" "}
              over <span className="mono">{summary.weeksPaid}</span> {summary.weeksPaid === 1 ? "week" : "weeks"}.
            </p>
          ) : null}
          <TableFrame label="Weeks paid from the pool">
            <thead>
              <tr>
                <th scope="col">Week</th>
                <th scope="col">Paid</th>
                <th scope="col">Sent</th>
              </tr>
            </thead>
            <tbody>
              {summary.weeks.map((week) => (
                <tr key={week.week}>
                  <th scope="row">{weekName(week.week)}</th>
                  <td className="mono">
                    {displayExact(BigInt(week.paid), week.decimals)} {week.asset}
                  </td>
                  {/* One transfer to each address paid. A handful are linked; more than that are counted, and can be seen on the wallet's own page (the link above). */}
                  <td>{week.txs.length > 3 ? <span className="mono">{week.txs.length} transfers</span> : <TxLinks hashes={week.txs} />}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        </>
      ) : null}
    </section>
  );
}

export default function RewardsPage() {
  const wallet = useWallet();
  const rewards = useRewards();
  const { loadSummary, refresh, signOut } = rewards;

  useEffect(() => {
    void loadSummary();
    // The week turns over and payouts are recorded while the page is open: look again every minute.
    const timer = setInterval(() => {
      void loadSummary();
      void refresh();
    }, 60_000);
    return () => clearInterval(timer);
  }, [loadSummary, refresh]);

  // A sign-in belongs to the wallet that made it. When that wallet goes, or another takes its place, it ends.
  const signedAs = rewards.session?.address ?? null;
  useEffect(() => {
    if (signedAs !== null && (wallet.address === null || wallet.address.toLowerCase() !== signedAs.toLowerCase())) signOut();
  }, [wallet.address, signedAs, signOut]);

  const mine = rewards.session !== null ? rewards.mine : null;
  const pool = rewards.summary?.pool ?? null;
  return (
    <section className="rewards" aria-labelledby="rewards-title">
      <Reveal as="header" className="focus-head">
        <p className="section-tag mono">Rewards</p>
        <h1 id="rewards-title" className="focus-title">
          Points and weekly rewards
        </h1>
        <p className="focus-lead muted">Each delivered swap adds points to the wallet behind it. Each week a payout is shared out by points.</p>
      </Reveal>

      {/* The one thing on the page: this week, and beside it your part in it. */}
      <Reveal className="rewards-week">
        <Week summary={rewards.summary} offset={rewards.clockOffset} />
        <Mine mine={mine} />
      </Reveal>

      {/* Only where a reserve wallet is set. Where none is, there is no such part and nothing in its place. */}
      {pool !== null && rewards.summary !== null ? <Pool pool={pool} summary={rewards.summary} /> : null}

      {mine !== null ? (
        <>
          <Swaps mine={mine} />
          <Payouts mine={mine} />
        </>
      ) : null}

      <section className="rewards-part" aria-labelledby="rewards-rules">
        <h2 id="rewards-rules" className="rewards-heading">
          The rules, in short
        </h2>
        <ol className="rewards-rules">
          {RULES_IN_SHORT.map((rule, index) => (
            <li key={rule}>
              <span className="mono rewards-rule-number" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>{rule}</span>
            </li>
          ))}
        </ol>
        <p>
          <Link href="/docs/rewards" className="stage-link draw">
            The rules in full
          </Link>
        </p>
      </section>

    </section>
  );
}
