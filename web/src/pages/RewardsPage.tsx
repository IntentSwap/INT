// Points and weekly rewards. One thing to look at: this week, with its dates, its countdown and,
// after a sign-in, the points of the address that signed in. Under it: that address's swaps and
// payouts, the rules in short, and the reserve wallet where one is set.
//
// Nobody is shown another address's points. To see one's own, the wallet is asked to sign one
// plain message; the page says so before the wallet opens.

import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { displayExact } from "../../../shared/amounts.ts";
import { explorerAddressUrl, explorerTxUrl } from "../../../shared/chains.ts";
import { REWARDS, showPoints, type ReserveView, type RewardsPublic, type RewardsView } from "../../../shared/rewards.ts";
import { Address } from "../components/Address.tsx";
import { PrimaryButton, TextButton } from "../components/Button.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { TableFrame } from "../components/DocsLayout.tsx";
import { Link } from "../components/Link.tsx";
import { Reveal } from "../components/Reveal.tsx";
import { countdownText, momentText, pairText, reasonWords, RULES_IN_SHORT, weekDates, weekName } from "../lib/rewards-logic.ts";
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

/** This week: its dates and the time left in it. */
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
    </div>
  );
}

/** Beside the week: an invitation to connect and sign in, or the signed-in address's points. */
function Mine({ mine }: { mine: RewardsView | null }) {
  const wallet = useWallet();
  const rewards = useRewards();
  const signedIn = rewards.session !== null && mine !== null;
  if (signedIn) {
    const carried = BigInt(mine.week.carriedInMicro);
    return (
      <div className="rewards-mine">
        <p className="rewards-label mono">Your points this week</p>
        <p className="rewards-points mono">{showPoints(BigInt(mine.week.pointsMicro))}</p>
        <p className="muted">
          All time: <span className="mono">{showPoints(BigInt(mine.allTimeMicro))}</span>
        </p>
        {mine.week.ceiling ? <p className="muted">This week's fee is past ${REWARDS.weeklyFullFeeUsd}: the part beyond it counts for less.</p> : null}
        {carried > 0n ? <p className="muted">Includes {showPoints(carried)} carried from last week, when no payout was sent for them.</p> : null}
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
                {displayExact(BigInt(payout.amount), 18)} {payout.asset}
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

/** The reserve wallet payouts are sent from: its address, what it holds, and what has been paid from it. Not drawn at all while no reserve is set. */
function Reserve({ reserve, summary }: { reserve: ReserveView; summary: RewardsPublic }) {
  const url = explorerAddressUrl(REWARDS.chain, reserve.address);
  return (
    <section className="rewards-part" aria-labelledby="rewards-reserve">
      <h2 id="rewards-reserve" className="rewards-heading">
        The reserve
      </h2>
      <p className="muted">Payouts are sent from this wallet on BNB Chain, in {reserve.asset.name}. Its balance is read from the chain as this page opens.</p>
      <dl className="rewards-facts">
        <div className="rewards-fact">
          <dt className="rewards-label mono">Holds now</dt>
          <dd className="rewards-figure mono">{reserve.balance !== null ? `${displayExact(BigInt(reserve.balance), reserve.asset.decimals)} ${reserve.asset.symbol}` : "–"}</dd>
        </div>
        <div className="rewards-fact">
          <dt className="rewards-label mono">Paid out so far</dt>
          <dd className="rewards-figure mono">
            {displayExact(BigInt(summary.totalPaid), reserve.asset.decimals)} {reserve.asset.symbol}
          </dd>
        </div>
        <div className="rewards-fact">
          <dt className="rewards-label mono">Weeks paid</dt>
          <dd className="rewards-figure mono">{summary.weeksPaid}</dd>
        </div>
      </dl>
      <p className="rewards-address">
        <span className="token-address">
          <Address value={reserve.address} />
        </span>
        <CopyButton value={reserve.address} what="the reserve wallet's address" />
        {url !== null ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className="outbound">
            View the wallet
            <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
            <span className="sr-only">(opens the block explorer)</span>
          </a>
        ) : null}
      </p>
      {summary.weeks.length > 0 ? (
        <TableFrame label="Weeks paid from the reserve">
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
                  {displayExact(BigInt(week.paid), reserve.asset.decimals)} {week.asset}
                </td>
                {/* One transfer to each address paid. A handful are linked; more than that are counted, and can be seen on the wallet's own page (the link above). */}
                <td>{week.txs.length > 3 ? <span className="mono">{week.txs.length} transfers</span> : <TxLinks hashes={week.txs} />}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
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
  const reserve = rewards.summary?.reserve ?? null;
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

      {reserve !== null && rewards.summary !== null ? <Reserve reserve={reserve} summary={rewards.summary} /> : null}
    </section>
  );
}
