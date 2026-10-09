import { chainName } from "../../../shared/chains.ts";
import { chainIconUrl, coinIconUrl, initials } from "../lib/icons.ts";

/**
 * A coin's icon with its chain badge: the one way a coin is drawn, wherever it appears. Two sizes,
 * 32 and 24. A coin with no artwork shows its first letters on the same circle; every coin, the
 * chain's own coin included, carries the badge. Decorative: the words beside it carry the name.
 */
export function CoinIcon({ symbol, chain, size = 32 }: { symbol: string; chain: string; size?: 32 | 24 }) {
  const coin = coinIconUrl(symbol);
  const badge = chainIconUrl(chain);
  const badgeSize = size === 32 ? 14 : 10;
  return (
    <span className="coin-icon" data-size={size} aria-hidden="true">
      {coin ? <img className="coin-icon-image" src={coin} alt="" width={size} height={size} decoding="async" loading="lazy" /> : <span className="coin-icon-fallback">{initials(symbol)}</span>}
      <span className="coin-icon-badge">{badge ? <img src={badge} alt="" width={badgeSize} height={badgeSize} decoding="async" loading="lazy" /> : <span className="coin-icon-badge-fallback">{initials(chainName(chain)).slice(0, 1)}</span>}</span>
    </span>
  );
}
