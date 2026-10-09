import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";
import { PrimaryButton } from "../components/Button.tsx";
import { RecentList } from "../components/RecentList.tsx";
import { Reveal } from "../components/Reveal.tsx";
import { isPrivateMode } from "../lib/site-logic.ts";
import { findOrder, readTrackInput, TRACK_WORDS, type TrackOutcome } from "../lib/track-logic.ts";
import { navigate } from "../router.ts";
import { useApp } from "../stores/app.ts";
import { useOrders } from "../stores/orders.ts";
import "../styles/home.css";

/** Turns the server's answer to a look into one of four plain outcomes. Anything unexpected reads as "not found". */
function outcome(error: unknown): TrackOutcome {
  if (error instanceof ApiError) {
    if (error.code === "rate_limited") return { kind: "wait" };
    if (error.code === "network") return { kind: "offline" };
  }
  return { kind: "none" };
}

/**
 * One field: an order's link or ID, or the deposit address that was paid. It leads to that order's
 * page and shows nothing itself. Under it, the orders made in this browser, when there are any.
 */
export default function TrackPage() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const orders = useOrders((state) => state.orders);
  const clear = useOrders((state) => state.clear);
  const area = useRef<HTMLTextAreaElement>(null);
  // Where swaps are routed privately, such an order is not found from its deposit address, and the page says so.
  const privateOn = useApp((state) => isPrivateMode(state.config));
  // Grow with the text, so that what was pasted wraps instead of running out of sight.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + (element.offsetHeight - element.clientHeight)}px`;
  }, [text]);
  const input = readTrackInput(text);
  const ready = input.id !== null || input.address !== null;

  const look = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setMessage(null);
    const result = await findOrder(input, {
      byId: (id) =>
        api
          .order(id, AbortSignal.timeout(15_000))
          .then((): TrackOutcome => ({ kind: "found", id }))
          .catch(outcome),
      byAddress: (address) =>
        api
          .track(address)
          .then((found): TrackOutcome => ({ kind: "found", id: found.id }))
          .catch(outcome),
    });
    setBusy(false);
    if (result.kind === "found") navigate(`/order/${result.id}`);
    else setMessage(TRACK_WORDS[result.kind]);
  };

  return (
    <section className="focus-page" aria-labelledby="track-title">
      <Reveal as="header" className="focus-head">
        <p className="section-tag mono">Track order</p>
        <h1 id="track-title" className="focus-title">
          Track an order
        </h1>
        <p className="focus-lead muted">
          Paste the order's link or ID, or the deposit address you sent to. It opens that order's page.{privateOn ? <> A privately routed order opens from its link or ID only.</> : null}
        </p>
      </Reveal>
      {/* The one thing on the page: a field, with a soft light behind it. */}
      <div className="focus-stage">
        <form className="track-form" onSubmit={(event) => void look(event)} noValidate>
          {/* The card's own address field: its label inside it, and a box that wraps, so that a long address or link is shown whole. */}
          <div className="address-field">
            <div className="address-head">
              <label className="address-label" htmlFor="track-input">
                Order ID or deposit address
              </label>
            </div>
            <textarea
              ref={area}
              id="track-input"
              className="address-input mono"
              rows={1}
              value={text}
              onChange={(event) => {
                setText(event.target.value.replace(/\s+/g, "").slice(0, 300));
                setMessage(null);
              }}
              onKeyDown={(event) => {
                // Enter looks the order up; it never starts a new line.
                if (event.key !== "Enter") return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
              placeholder="Link, order ID or address"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby="track-message"
            />
          </div>
          <p id="track-message" className="track-message" role="status" data-tone={message !== null ? "attention" : undefined}>
            {message ?? " "}
          </p>
          <PrimaryButton type="submit" disabled={!ready || busy} busy={busy}>
            {busy ? "Looking…" : ready ? "Find order" : text.trim() === "" ? "Enter order ID or address" : "Not an order ID or address"}
          </PrimaryButton>
        </form>
      </div>
      {/* The orders made in this browser. Not drawn at all while there are none. */}
      {orders.length > 0 ? (
        <section className="track-recent" aria-labelledby="track-recent-title">
          <h2 id="track-recent-title" className="track-recent-title">
            Orders made in this browser
          </h2>
          <RecentList orders={orders} onClear={clear} onOpen={(id) => navigate(`/order/${id}`)} />
        </section>
      ) : null}
    </section>
  );
}
