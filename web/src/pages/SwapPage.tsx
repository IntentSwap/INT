import { useEffect } from "react";
import { SecondaryButton } from "../components/Button.tsx";
import { Notice } from "../components/Shell.tsx";
import { Faq } from "../components/Faq.tsx";
import { Backdrop, Headline, HomeSections } from "../components/Home.tsx";
import { ReviewSheet } from "../components/ReviewSheet.tsx";
import { SlippageSheet } from "../components/SlippageSheet.tsx";
import { SwapCard } from "../components/SwapCard.tsx";
import { useApp } from "../stores/app.ts";
import { useSheet } from "../stores/sheet.ts";
import { useSwap } from "../stores/swap.ts";
import { useTokens } from "../stores/tokens.ts";

export function SwapPage() {
  const status = useTokens((state) => state.status);
  const load = useTokens((state) => state.load);
  const count = useTokens((state) => state.tokens.length);
  const init = useSwap((state) => state.init);
  const sheet = useSheet((state) => state.current);
  const paused = useApp((state) => state.config?.paused ?? false);
  const reload = useApp((state) => state.load);

  useEffect(() => {
    if (count > 0) init(window.location.search);
  }, [count, init]);

  // What stands where the card would, when the card cannot be used. The rest of the page is unchanged.
  const instead = paused ? (
    <Notice inCard title="Swaps are paused." action={<SecondaryButton onClick={() => void reload()}>Check again</SecondaryButton>}>
      <p>New swaps can't be started right now. Orders already made are still tracked, and refunds still reach their refund address.</p>
    </Notice>
  ) : status === "failed" ? (
    <Notice inCard title="Couldn't load coins." action={<SecondaryButton onClick={() => void load()}>Try again</SecondaryButton>}>
      <p>The list of coins didn't arrive. Check your connection and try again.</p>
    </Notice>
  ) : null;

  return (
    <>
      <Backdrop />
      {/* The first screen. On a wide screen the words stand to the left of the card; otherwise above it. */}
      <div className="hero">
        <Headline />
        {instead ?? <SwapCard />}
        <p className="under-card muted">Swaps run on NEAR Intents. IntentSwap never holds your funds.</p>
      </div>
      <HomeSections />
      <Faq />
      {sheet === "review" ? <ReviewSheet /> : null}
      {sheet === "slippage" ? <SlippageSheet /> : null}
    </>
  );
}
