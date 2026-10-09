// The site in numbers: five totals, the chains that have been used among all the site swaps on, the
// coins and chains with the most volume sent, and a list of the latest swaps. Everything is counted
// on the server from swaps this site saw delivered, and from what they sent: nothing on this page
// says what any swap received, or where. The list gives of a swap the coin and the amount that were
// sent, when it was delivered, and a link to its deposit on the chain it was sent from.

import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { StatsCoin, StatsResponse } from "../../../shared/api.ts";
import { chainName, explorerTxUrl } from "../../../shared/chains.ts";
import { api } from "../api.ts";
import { Amount } from "../components/Amount.tsx";
import { SecondaryButton } from "../components/Button.tsx";
import { CoinIcon, NoArtwork } from "../components/CoinIcon.tsx";
import { Reveal } from "../components/Reveal.tsx";
import { chainIconUrl } from "../lib/icons.ts";
import { useCountUp, useSeen } from "../lib/reveal.ts";
import { chainsOnList } from "../lib/site-logic.ts";
import { chainGrid, chainLine, coinText, deliveredText, durationText, shortTx, usdText, wholeText, type GridChain } from "../lib/stats-logic.ts";
import { useTokens } from "../stores/tokens.ts";
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

/** A chain's mark in the grid: its own artwork, the same as on the strip of chains, or the plain drawing where the site has none. */
function GridMark({ chain }: { chain: string }) {
  const icon = chainIconUrl(chain);
  if (icon !== null) return <img className="stats-chains-mark" src={icon} alt="" width={32} height={32} decoding="async" />;
  return (
    <span className="stats-chains-mark" aria-hidden="true">
      <NoArtwork />
    </span>
  );
}

/**
 * Every chain the site swaps on, each as its mark over its name, with nothing round it. A chain that
 * has been used is in full colour and can be chosen; the others are faded and cannot. One line above
 * the grid holds the chosen chain's figures; it keeps its room while it holds none, so nothing moves.
 * The used chains light up one after another, once, when the grid first comes into view.
 */
export function ChainGrid({ chains, count, chosen, onChoose }: { chains: readonly GridChain[]; count: number; chosen: string | null; onChoose(chain: string): void }) {
  const [ref, seen] = useSeen<HTMLUListElement>();
  // Hovering is spoken of only where there is something to hover with.
  const [pointer] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches);
  const picked = chains.find((chain) => chain.key === chosen);
  // A used chain's place among the used ones, which is its turn to light up.
  const turns = new Map(chains.filter((chain) => chain.used !== null).map((chain, index) => [chain.key, index]));
  return (
    <>
      <p className="muted">
        <span className="mono stats-figure">{wholeText(count)}</span> of <span className="mono stats-figure">{wholeText(chains.length)}</span> chains used
      </p>
      <p className="stats-chains-line muted" aria-live="polite">
        {picked !== undefined && picked.used !== null ? chainLine(picked.name, picked.used.swaps, picked.used.share) : `${pointer ? "Hover or tap" : "Tap"} a chain to see its swaps and its share of volume.`}
      </p>
      <ul ref={ref} className="stats-chains" data-in={seen ? "" : undefined}>
        {chains.map((chain) => (
          <li key={chain.key}>
            {chain.used !== null ? (
              <button type="button" className="stats-chains-item" data-used="" aria-pressed={chain.key === chosen} style={{ "--i": turns.get(chain.key) } as CSSProperties} onPointerEnter={() => onChoose(chain.key)} onFocus={() => onChoose(chain.key)} onClick={() => onChoose(chain.key)}>
                <GridMark chain={chain.key} />
                <span>{chain.name}</span>
              </button>
            ) : (
              <span className="stats-chains-item">
                <GridMark chain={chain.key} />
                <span>
                  {chain.name}
                  <span className="sr-only">, not used yet</span>
                </span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </>
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

/** A coin that was sent, with its chain's badge. */
function SentIcon({ coin }: { coin: StatsCoin }) {
  return (
    <span className="stats-coins">
      <CoinIcon symbol={coin.symbol} chain={coin.chain} size={24} />
    </span>
  );
}

/**
 * A swap's deposit: its transaction's hash, shortened, as a link to that transaction on its own
 * chain's explorer. Where the site has no explorer for the chain the hash stands as plain text, and
 * where the hash is not known there is nothing.
 */
function Deposit({ chain, tx }: { chain: string; tx: string | null }) {
  if (tx === null) return null;
  const url = explorerTxUrl(chain, tx);
  if (url === null) return <span className="stats-swap-tx mono muted">{shortTx(tx)}</span>;
  return (
    <a className="stats-swap-tx mono" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Deposit transaction on ${chainName(chain)}, opens in a new tab`}>
      {shortTx(tx)}
      <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
    </a>
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

/**
 * The page under its head. `null` is the figures on their way: each of the five keeps its place.
 * `chains` is every chain on the coin list, in the order the coin picker offers them.
 */
export function StatsContent({ stats, chains }: { stats: StatsResponse | null; chains: readonly { key: string; name: string }[] }) {
  const totals = stats?.totals;
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <>
      <Reveal as="dl" className="stats-tiles">
        <Tile label="Total swaps" value={totals?.swaps} text={wholeText} />
        <Tile label="Total volume" value={totals?.volumeUsd} text={usdText} />
        <Tile label="Volume, last 24 hours" value={totals?.volume24hUsd} text={usdText} />
        <Tile label="Chains used" value={totals?.chains} text={wholeText} />
        <Tile label="Average delivery time" value={totals?.deliverySeconds} text={durationText} />
      </Reveal>

      {/* Drawn once both are known: the figures, and the list of chains they are set against. The count is the very number of the tile above. */}
      {stats !== null && chains.length > 0 ? (
        <section className="stats-part" aria-labelledby="stats-used">
          <h2 id="stats-used" className="stats-heading">
            Chains used
          </h2>
          <ChainGrid chains={chainGrid(chains, stats.chainsUsed)} count={stats.totals.chains} chosen={chosen} onChoose={setChosen} />
        </section>
      ) : null}

      {stats !== null && (stats.coins.length > 0 || stats.chains.length > 0) ? (
        <div className="stats-tops">
          <Ranked
            id="stats-coins"
            title="Top coins sent"
            rows={stats.coins.map((item) => ({
              key: JSON.stringify(item.coin),
              name: (
                <>
                  <SentIcon coin={item.coin} />
                  <span>{coinText(item.coin)}</span>
                </>
              ),
              volumeUsd: item.volumeUsd,
            }))}
          />
          <Ranked id="stats-chains" title="Top chains" rows={stats.chains.map((item) => ({ key: item.chain, name: <Chain chain={item.chain} name={item.name} />, volumeUsd: item.volumeUsd }))} />
        </div>
      ) : null}

      {/* Drawn only when there are rows. While there are none there is nothing in its place: no heading, no line saying why. */}
      {stats !== null && stats.feed.length > 0 ? (
        <section className="stats-part" aria-labelledby="stats-recent">
          <h2 id="stats-recent" className="stats-heading">
            Recent swaps
          </h2>
          <p className="muted stats-note">Each row links to the deposit on its own chain. Where it was delivered is never shown.</p>
          <ul className="stats-swaps">
            {stats.feed.map((row, index) => (
              <li key={index} className="stats-swap">
                <SentIcon coin={row.coin} />
                <span className="stats-swap-sent">
                  <Amount raw={row.amount} decimals={row.coin.decimals} symbol={row.coin.symbol} /> <span className="muted">on {chainName(row.coin.chain)}</span>
                </span>
                <time className="stats-swap-when muted" dateTime={row.at}>
                  {deliveredText(row.at)}
                </time>
                <Deposit chain={row.coin.chain} tx={row.tx} />
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
  const tokens = useTokens((state) => state.tokens);
  const chains = useMemo(() => chainsOnList(tokens), [tokens]);
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
    // The figures move as swaps are delivered: look again every minute while the page is open and on show.
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
        <p className="focus-lead muted">Counted from the swaps delivered on this site.</p>
      </Reveal>
      {/* Figures already on the page stay there if a later look fails: the next one puts them right. */}
      {stats === null && failed ? (
        <div className="stats-failed">
          <p>The figures could not be loaded.</p>
          <SecondaryButton onClick={() => void load()}>Try again</SecondaryButton>
        </div>
      ) : (
        <StatsContent stats={stats} chains={chains} />
      )}
    </section>
  );
}
