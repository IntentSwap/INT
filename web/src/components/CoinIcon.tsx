import { chainIconUrl, coinIconUrl, logoUrl } from "../lib/icons.ts";

/**
 * The one drawing for a coin or a chain the site has no artwork for: a plain coin in outline (a
 * ring with a smaller ring inside it), the same for every one of them and never a letter. It takes
 * the colour of the words round it.
 */
export function NoArtwork({ weight = 1.5 }: { weight?: number }) {
  return (
    <svg className="no-artwork" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} aria-hidden="true">
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="2.25" />
    </svg>
  );
}

/**
 * A coin's icon with its chain badge: the one way a coin is drawn, wherever it appears. Two sizes,
 * 32 and 24. The coin is known by its chain and its contract (null for a chain's own coin), or,
 * where no contract is kept, by the name of the logo that was found for it; a coin with no artwork
 * shows the plain drawing on the same circle, and so does a chain with none in its badge; every
 * coin, the chain's own coin included, carries the badge. Decorative: the words beside it carry
 * the name.
 */
export function CoinIcon({ symbol, chain, contract, logo, size = 32 }: { symbol: string; chain: string; contract?: string | null; logo?: string; size?: 32 | 24 }) {
  const coin = logoUrl(logo) ?? coinIconUrl(symbol, chain, contract);
  const badge = chainIconUrl(chain);
  const badgeSize = size === 32 ? 14 : 10;
  return (
    <span className="coin-icon" data-size={size} aria-hidden="true">
      {coin ? <img className="coin-icon-image" src={coin} alt="" width={size} height={size} decoding="async" loading="lazy" /> : <span className="coin-icon-fallback"><NoArtwork /></span>}
      <span className="coin-icon-badge">{badge ? <img src={badge} alt="" width={badgeSize} height={badgeSize} decoding="async" loading="lazy" /> : <span className="coin-icon-badge-fallback"><NoArtwork weight={3} /></span>}</span>
    </span>
  );
}
