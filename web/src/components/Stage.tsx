// "What IntentSwap does": one large panel that shows one thing at a time, with a small drawing
// for each. It moves to the next every six seconds by itself until someone takes it in hand
// (a press, a key, a swipe); under the pointer or the keyboard's focus it waits. Where the system
// asks for less movement it never moves by itself.

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useCallback, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { features, isPrivateMode, type Feature } from "../lib/site-logic.ts";
import { useLessMotion, useSeen } from "../lib/reveal.ts";
import { useApp } from "../stores/app.ts";
import { Link } from "./Link.tsx";

/** A coin leaves one chain's mark, crosses in an arc and arrives at another's as a different coin. */
function SwapArt() {
  return (
    <svg className="art" viewBox="0 0 280 200" aria-hidden="true" focusable="false">
      <path className="art-quiet" d="M40 116A130 130 0 0 1 240 116" strokeDasharray="2 8" />
      <rect className="art-line" x="18" y="140" width="44" height="44" rx="12" />
      <path className="art-line" d="M32 162h16M40 154v16" />
      <rect className="art-line" x="218" y="140" width="44" height="44" rx="12" />
      <path className="art-line" d="M230 156h20M230 168h20" />
      <g className="art-traveller">
        <g className="art-coin-out">
          <circle className="art-ink" cx="140" cy="70" r="14" />
          <circle className="art-ink" cx="140" cy="70" r="5" />
        </g>
        <g className="art-coin-in">
          <circle className="art-accent" cx="140" cy="70" r="14" />
          <circle className="art-accent-fill" cx="140" cy="70" r="6" />
        </g>
      </g>
    </svg>
  );
}

/** A line of four steps fills from the left, and a tick lands on the last. */
function TrackArt() {
  return (
    <svg className="art" viewBox="0 0 280 200" aria-hidden="true" focusable="false">
      <path className="art-quiet" d="M40 100h200" />
      <path className="art-accent art-fill-line" d="M40 100h200" />
      {[40, 107, 173, 240].map((x, index) => (
        <g key={x} className="art-stop" data-stop={index}>
          <circle className="art-stop-ring" cx={x} cy="100" r={index === 3 ? 16 : 9} />
          <circle className="art-stop-on" cx={x} cy="100" r={index === 3 ? 16 : 9} />
        </g>
      ))}
      <path className="art-tick" d="M232 100l6 6 11-13" />
    </svg>
  );
}

/** The seven days of a week as bars that rise, and a ring that closes round the week's count. */
function PointsArt() {
  return (
    <svg className="art" viewBox="0 0 280 200" aria-hidden="true" focusable="false">
      <path className="art-quiet" d="M36 150h150" />
      {[38, 58, 46, 74, 52, 88, 64].map((height, index) => (
        <rect key={index} className="art-bar" data-bar={index} x={42 + index * 20} y={150 - height} width="8" height={height} rx="4" />
      ))}
      <circle className="art-line" cx="228" cy="100" r="30" />
      <circle className="art-accent art-count" cx="228" cy="100" r="30" />
      <path className="art-ink" d="M218 100h20M228 90v20" />
    </svg>
  );
}

/** The token as a coin with its name on it, and one ring round it. */
function TokenArt() {
  return (
    <svg className="art" viewBox="0 0 280 200" aria-hidden="true" focusable="false">
      <circle className="art-quiet" cx="140" cy="100" r="72" strokeDasharray="2 8" />
      <circle className="art-line" cx="140" cy="100" r="50" />
      <circle className="art-accent art-count" cx="140" cy="100" r="50" />
      <text className="art-word" x="140" y="107" textAnchor="middle">
        $INT
      </text>
    </svg>
  );
}

/**
 * Ghost mode: three things a site would keep go out one after another, each leaving only the
 * dashed outline of where it stood, and the ghost comes up beside them.
 */
function GhostArt() {
  const ghost = "M212 60a32 32 0 0 0-32 32v48l12-12 10 10 10-10 10 10 10-10 12 12V92a32 32 0 0 0-32-32z";
  return (
    <svg className="art" viewBox="0 0 280 200" aria-hidden="true" focusable="false">
      {[58, 100, 142].map((y, index) => (
        <g key={y}>
          <rect className="art-quiet" x="36" y={y - 14} width="96" height="28" rx="14" strokeDasharray="2 8" />
          <g className="art-kept" data-kept={index}>
            <rect className="art-line" x="36" y={y - 14} width="96" height="28" rx="14" />
            <circle className="art-line" cx="54" cy={y} r="4" />
            <path className="art-line" d={`M68 ${y}h${index === 1 ? 32 : 48}`} />
          </g>
        </g>
      ))}
      <path className="art-line" d={ghost} />
      <g className="art-count">
        <path className="art-accent" d={ghost} />
        <path className="art-accent" d="M200 90v6M224 90v6" />
      </g>
    </svg>
  );
}

/**
 * Add gas: two orders, a larger and a smaller, lead to one address. The coin received is already
 * there, and a small coin lands beside it.
 */
function GasArt() {
  return (
    <svg className="art" viewBox="0 0 280 200" aria-hidden="true" focusable="false">
      <rect className="art-line" x="28" y="62" width="88" height="28" rx="14" />
      <path className="art-line" d="M46 76h36" />
      <rect className="art-line" x="28" y="110" width="56" height="28" rx="14" />
      <path className="art-line" d="M46 124h12" />
      <path className="art-quiet" d="M126 76h40" strokeDasharray="2 8" />
      <path className="art-quiet" d="M94 124h72" strokeDasharray="2 8" />
      <rect className="art-line" x="176" y="52" width="76" height="96" rx="16" />
      <circle className="art-ink" cx="214" cy="82" r="14" />
      <circle className="art-ink" cx="214" cy="82" r="5" />
      <g className="art-count">
        <circle className="art-accent" cx="214" cy="122" r="9" />
        <circle className="art-accent-fill" cx="214" cy="122" r="3" />
      </g>
    </svg>
  );
}

const ART: Record<Feature["key"], () => React.JSX.Element> = { swaps: SwapArt, tracking: TrackArt, rewards: PointsArt, ghost: GhostArt, gas: GasArt, token: TokenArt };

/** A swipe has to travel this far, in pixels, to count as one. */
const SWIPE = 40;

export function Stage() {
  const tokenSet = useApp((state) => (state.config?.tokenAddress ?? null) !== null);
  // Where swaps are routed privately, the first item says so.
  const privateOn = useApp((state) => isPrivateMode(state.config));
  const items = features(tokenSet, privateOn);
  const id = useId();
  const [index, setIndex] = useState(0);
  // Moves by itself until someone takes it in hand; from then on it stays where it is put.
  const [byItself, setByItself] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const lessMotion = useLessMotion();
  const [ref, seen] = useSeen<HTMLDivElement>(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const swipeFrom = useRef<number | null>(null);
  const current = Math.min(index, items.length - 1);
  const running = byItself && !lessMotion && seen;

  const go = useCallback(
    (next: number, byHand: boolean) => {
      setIndex((next + items.length) % items.length);
      if (byHand) setByItself(false);
    },
    [items.length],
  );

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const to = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : step !== 0 ? (current + step + items.length) % items.length : null;
    if (to === null) return;
    event.preventDefault();
    go(to, true);
    tabs.current[to]?.focus();
  };

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    swipeFrom.current = event.pointerType === "mouse" ? null : event.clientX;
  };
  const onUp = (event: PointerEvent<HTMLDivElement>) => {
    const from = swipeFrom.current;
    swipeFrom.current = null;
    if (from === null) return;
    const moved = event.clientX - from;
    if (Math.abs(moved) >= SWIPE) go(current + (moved < 0 ? 1 : -1), true);
  };

  return (
    <div
      ref={ref}
      className="stage"
      data-seen={seen || undefined}
      data-running={running || undefined}
      data-waiting={waiting || undefined}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setWaiting(true);
      }}
      onPointerLeave={() => setWaiting(false)}
      onFocus={() => setWaiting(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setWaiting(false);
      }}
    >
      <div className="stage-rail" role="tablist" aria-label="What IntentSwap does" onKeyDown={onKey}>
        {items.map((item, at) => (
          <button
            key={item.key}
            ref={(element) => {
              tabs.current[at] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${item.key}`}
            className="stage-tab"
            aria-selected={at === current}
            aria-controls={`${id}-panel-${item.key}`}
            tabIndex={at === current ? 0 : -1}
            onClick={() => go(at, true)}
          >
            <span className="stage-number mono" aria-hidden="true">
              {String(at + 1).padStart(2, "0")}
            </span>
            <span className="stage-tab-title">{item.title}</span>
            {/* The line under the item on show fills in the time the stage stays on it. When it is full, the stage moves on. */}
            <span className="stage-progress" aria-hidden="true">
              <span
                className="stage-progress-fill"
                onAnimationEnd={() => {
                  if (at === current && running) go(current + 1, false);
                }}
              />
            </span>
          </button>
        ))}
      </div>

      <div className="stage-view" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => (swipeFrom.current = null)}>
        {items.map((item, at) => {
          const Art = ART[item.key];
          const active = at === current;
          return (
            <div key={item.key} role="tabpanel" id={`${id}-panel-${item.key}`} aria-labelledby={`${id}-tab-${item.key}`} className="stage-panel" data-active={active || undefined} data-side={at < current ? "before" : at > current ? "after" : undefined} inert={!active}>
              <div className="stage-words">
                <p className="stage-count mono" aria-hidden="true">
                  {String(at + 1).padStart(2, "0")} <span className="faint">/ {String(items.length).padStart(2, "0")}</span>
                </p>
                <h3 className="stage-title">{item.title}</h3>
                <p className="stage-text muted">{item.text}</p>
                <Link href={item.link.href} className="stage-link draw">
                  {item.link.label}
                  <ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />
                </Link>
              </div>
              <div className="stage-art">
                <Art />
              </div>
            </div>
          );
        })}
      </div>

      <div className="stage-arrows">
        <button type="button" className="button-icon stage-arrow" onClick={() => go(current - 1, true)} aria-label="Previous" title="Previous">
          <ArrowLeft size={20} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button type="button" className="button-icon stage-arrow" onClick={() => go(current + 1, true)} aria-label="Next" title="Next">
          <ArrowRight size={20} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
