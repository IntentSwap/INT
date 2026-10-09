import { ChevronDown } from "lucide-react";
import type { TokenView } from "../../../shared/api.ts";
import { chainName } from "../../../shared/chains.ts";
import { CoinIcon } from "./CoinIcon.tsx";

/**
 * The coin selector: opens the coin picker. Always names the coin together with its chain. The name
 * read aloud is made of the words on the button, in the order they are shown, with a few unseen words
 * between them: someone who speaks to their device can say what they see.
 */
export function CoinButton({ token, label, onClick }: { token: TokenView | null; label: string; onClick(): void }) {
  if (token === null) {
    return (
      <span className="coin-button coin-button-loading" aria-hidden="true">
        <span className="skeleton skeleton-coin" />
      </span>
    );
  }
  return (
    <button type="button" className="coin-button" onClick={onClick} aria-haspopup="dialog">
      <span className="sr-only">{label}: </span>
      <CoinIcon symbol={token.symbol} chain={token.chain} size={24} />
      <span className="coin-button-text">
        <span className="coin-button-symbol">{token.symbol}</span>
        <span className="sr-only"> on </span>
        <span className="coin-button-chain muted">{chainName(token.chain)}</span>
      </span>
      <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" />
      <span className="sr-only">. Change coin</span>
    </button>
  );
}
