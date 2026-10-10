import { lazy, Suspense, useEffect, useLayoutEffect } from "react";
import { SecondaryButton } from "../components/Button.tsx";
import { Notice } from "../components/Shell.tsx";
import { Faq } from "../components/Faq.tsx";
import { Backdrop, Headline, HomeSections } from "../components/Home.tsx";
import { SlippageSheet } from "../components/SlippageSheet.tsx";
import { SwapCard } from "../components/SwapCard.tsx";
import { useApp } from "../stores/app.ts";
import { useSheet } from "../stores/sheet.ts";
import { useSwap, visitSwap } from "../stores/swap.ts";
import { useTokens } from "../stores/tokens.ts";

// The review opens only on a press, and it is the largest part of this page. Its code travels apart
// from the first script, so that the first screen is not kept waiting for it, and is fetched ahead of
// the press: as soon as the card holds a quote, which is the first moment there is anything to review.
const loadReview = () => import("../components/ReviewSheet.tsx");
const ReviewSheet = lazy(() => loadReview().then((sheet) => ({ default: sheet.ReviewSheet })));

export function SwapPage() {
  const status = useTokens((state) => state.status);
  const load = useTokens((state) => state.load);
  const count = useTokens((state) => state.tokens.length);
  const init = useSwap((state) => state.init);
  const sheet = useSheet((state) => state.current);
  const paused = useApp((state) => state.config?.paused ?? false);
  const reload = useApp((state) => state.load);

  // The card starts fresh each time this page comes onto the screen, and is cleared as the page is left.
  // Before the first paint, so the card is never seen without its coins on the way back from another page.
  useLayoutEffect(() => visitSwap(), []);
  // The coin list arriving after the page: the card is given its coins then.
  useEffect(() => {
    if (count > 0) init(window.location.search);
  }, [count, init]);

  // The review's code is fetched once there is a quote. A fetch that fails here is tried again when the review is opened.
  const quoted = useSwap((state) => state.quote !== null);
  useEffect(() => {
    if (quoted) void loadReview().catch(() => undefined);
  }, [quoted]);

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
      {/* The page stays as it is for the moment the review's code may still be on its way. */}
      {sheet === "review" ? (
        <Suspense fallback={null}>
          <ReviewSheet />
        </Suspense>
      ) : null}
      {sheet === "slippage" ? <SlippageSheet /> : null}
    </>
  );
}
