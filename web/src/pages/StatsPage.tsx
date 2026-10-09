// The site in numbers: five totals, the last 30 days of volume, the pairs and chains with the most
// of it, and a list of recent swaps. Everything is counted on the server from swaps this site saw
// delivered. The list says of a swap only its two coins, a band for its size and a stretch of the
// day; it is not drawn at all while the server sends none.

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { StatsCoin, StatsResponse } from "../../../shared/api.ts";
import { api } from "../api.ts";
import { SecondaryButton } from "../components/Button.tsx";
import { CoinIcon } from "../components/CoinIcon.tsx";
import { Reveal } from "../components/Reveal.tsx";
import { chainIconUrl } from "../lib/icons.ts";
import { useCountUp, useSeen } from "../lib/reveal.ts";
import { BAND_WORDS, coinText, dayText, durationText, usdText, WHEN_WORDS, wholeText } from "../lib/stats-logic.ts";
import "../styles/home.css";
import "../styles/stats.css";

/** How far a bar reaches, as a share of the largest. Something that is not nothing is never drawn as nothing. */
const share = (value: number, largest: number): number => (value <= 0 || largest <= 0 ? 0 : Math.max(0.02, value / largest));
const bar = (value: number, largest: number): CSSProperties => ({ "--bar": share(value, largest) }) as CSSProperties;

/**
 * One figure. It counts up once, when it arrives; a screen reader is given the figure itself.
 * `undefined` is a figure on its way, `null` one there is nothing to say for.
 */
function Tile({ label, value, text }: { label: string; value: number | null | undefined; text(value: number): string }) {
  const shown = useCountUp(value ?? 0, typeof value === "number");
  return (
    <div className="stats-tile">
      <dt className="fact-label mono">{label}</dt>
      <dd className="stats-number mono">
        {value === undefined ? (
          <span className="skeleton stats-waiting" aria-hidden="true" />
        ) : value === null ? (
          "–"
        ) : (
          <>
            <span aria-hidden="true">{text(shown)}</span>
            <span className="sr-only">{text(value)}</span>
          </>
        )}
      </dd>
    </div>
  );
}

/** A bar to a day, on a hairline. The bars are for the eye; the same figures follow as a table for a screen reader. */
function Chart({ stats }: { stats: StatsResponse }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const { days } = stats;
  const largest = days.reduce((best, day) => (day.volumeUsd > best.volumeUsd ? day : best), days[0] ?? { day: "", volumeUsd: 0 });
  if (largest.volumeUsd === 0) return <p className="muted">{stats.totals.swaps === 0 ? "No swaps have been delivered yet." : "No swaps were delivered in the last 30 days."}</p>;
  return (
    <figure className="stats-chart">
      <figcaption className="muted">
        Largest day: <span className="mono stats-figure">{usdText(largest.volumeUsd)}</span> on {dayText(largest.day)}
      </figcaption>
      <div ref={ref} className="stats-bars" aria-hidden="true" data-in={seen ? "" : undefined}>
        {days.map((day) => (
          <span key={day.day} className="stats-bar" data-top={day === largest ? "" : undefined} style={bar(day.volumeUsd, largest.volumeUsd)} title={`${dayText(day.day)}: ${usdText(day.volumeUsd)}`} />
        ))}
      </div>
      <p className="stats-axis mono" aria-hidden="true">
        <span>{dayText(days[0]?.day ?? "")}</span>
        <span>{dayText(days.at(-1)?.day ?? "")}</span>
      </p>
      <div className="sr-only">
        <table>
          <caption>Volume by day, by the clock in UTC</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Volume</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day}>
                <th scope="row">{dayText(day.day)}</th>
                <td>{usdText(day.volumeUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** A short ranked list: a name, its volume, and under each row a thin line as long as its share of the largest. */
function Ranked({ id, title, rows }: { id: string; title: string; rows: { key: string; name: ReactNode; volumeUsd: number }[] }) {
  const largest = rows[0]?.volumeUsd ?? 0;
  return (
    <section className="stats-part" aria-labelledby={id}>
      <h2 id={id} className="stats-heading">
        {title}
      </h2>
      <ol className="stats-ranks">
        {rows.map((row, index) => (
          <li key={row.key} className="stats-rank">
            <span className="stats-rank-number mono" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="stats-rank-name">{row.name}</span>
            <span className="mono">{usdText(row.volumeUsd)}</span>
            <span className="stats-rank-bar" style={bar(row.volumeUsd, largest)} aria-hidden="true" />
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Two coins, each with its chain's badge, and what they are in words. */
function Pair({ from, to }: { from: StatsCoin; to: StatsCoin }) {
  return (
    <>
      <span className="stats-coins">
        <CoinIcon symbol={from.symbol} chain={from.chain} size={24} />
        <CoinIcon symbol={to.symbol} chain={to.chain} size={24} />
      </span>
      <span>
        {coinText(from)} to {coinText(to)}
      </span>
    </>
  );
}

function Chain({ chain, name }: { chain: string; name: string }) {
  const icon = chainIconUrl(chain);
  return (
    <>
      {icon !== null ? <img className="stats-chain" src={icon} alt="" width={20} height={20} decoding="async" loading="lazy" /> : null}
      <span>{name}</span>
    </>
  );
}

/** The page under its head. `null` is the figures on their way: each keeps its place. */
export function StatsContent({ stats }: { stats: StatsResponse | null }) {
  const totals = stats?.totals;
  return (
    <>
      <Reveal as="dl" className="stats-tiles">
        <Tile label="Total swaps" value={totals?.swaps} text={wholeText} />
        <Tile label="Total volume" value={totals?.volumeUsd} text={usdText} />
        <Tile label="Volume, last 24 hours" value={totals?.volume24hUsd} text={usdText} />
        <Tile label="Chains used" value={totals?.chains} text={wholeText} />
        <Tile label="Average delivery time" value={totals?.deliverySeconds} text={durationText} />
      </Reveal>

      <section className="stats-part" aria-labelledby="stats-daily">
        <h2 id="stats-daily" className="stats-heading">
          Daily volume, last 30 days
        </h2>
        {stats === null ? <span className="skeleton stats-chart-waiting" aria-hidden="true" /> : <Chart stats={stats} />}
      </section>

      {stats !== null && (stats.pairs.length > 0 || stats.chains.length > 0) ? (
        <div className="stats-tops">
          <Ranked id="stats-pairs" title="Top pairs" rows={stats.pairs.map((pair) => ({ key: JSON.stringify([pair.from, pair.to]), name: <Pair from={pair.from} to={pair.to} />, volumeUsd: pair.volumeUsd }))} />
          <Ranked id="stats-chains" title="Top chains" rows={stats.chains.map((item) => ({ key: item.chain, name: <Chain chain={item.chain} name={item.name} />, volumeUsd: item.volumeUsd }))} />
        </div>
      ) : null}

      {/* Drawn only when the server sends rows. While it sends none there is nothing in its place: no heading, no line saying why. */}
      {stats !== null && stats.feed !== null && stats.feed.length > 0 ? (
        <section className="stats-part" aria-labelledby="stats-recent">
          <h2 id="stats-recent" className="stats-heading">
            Recent swaps
          </h2>
          <p className="muted stats-note">Sizes and times are rounded, and rows are shown late and in mixed order, to keep any one swap from being picked out.</p>
          <ul className="stats-swaps">
            {stats.feed.map((row, index) => (
              <li key={index} className="stats-swap">
                <Pair from={row.from} to={row.to} />
                <span className="stats-swap-size muted">{BAND_WORDS[row.band]}</span>
                <span className="stats-swap-when muted">{WHEN_WORDS[row.when]}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export default function StatsPage() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    setFailed(false);
    try {
      setStats(await api.stats());
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
    // The figures move on the quarter of an hour: look again every minute while the page is open and on show.
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <section className="stats" aria-labelledby="stats-title">
      <Reveal as="header" className="focus-head">
        <p className="section-tag mono">Stats</p>
        <h1 id="stats-title" className="focus-title">
          IntentSwap in numbers
        </h1>
        <p className="focus-lead muted">Counted from the swaps delivered on this site, and brought up to date every quarter of an hour.</p>
      </Reveal>
      {/* Figures already on the page stay there if a later look fails: the next one puts them right. */}
      {stats === null && failed ? (
        <div className="stats-failed">
          <p>The figures could not be loaded.</p>
          <SecondaryButton onClick={() => void load()}>Try again</SecondaryButton>
        </div>
      ) : (
        <StatsContent stats={stats} />
      )}
    </section>
  );
}
