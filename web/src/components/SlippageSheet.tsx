import { useState } from "react";
import { displayBps } from "../../../shared/amounts.ts";
import { SLIPPAGE_BOUNDS_WORDS } from "../../../shared/api.ts";
import { percentToBps, slippageAdvice, SLIPPAGE_CHOICES } from "../lib/swap-logic.ts";
import { useSheet } from "../stores/sheet.ts";
import { useSwap } from "../stores/swap.ts";
import { PrimaryButton } from "./Button.tsx";
import { Sheet } from "./Sheet.tsx";

/**
 * The slippage limit: how far the price may move against the person before the swap is not
 * made. Three ready choices and a field for another. The server holds whatever is chosen to
 * its own bounds; this sheet only keeps a choice it will accept.
 */
export function SlippageSheet() {
  const close = useSheet((state) => state.close);
  const current = useSwap((state) => state.slippageBps);
  const setSlippage = useSwap((state) => state.setSlippage);
  const ready = (SLIPPAGE_CHOICES as readonly number[]).includes(current);
  const [picked, setPicked] = useState<number | null>(ready ? current : null);
  const [own, setOwn] = useState(ready ? "" : (current / 100).toString());
  const typed = own.trim() !== "";
  const chosen = typed ? percentToBps(own) : picked;
  const advice = slippageAdvice(chosen);

  const use = () => {
    if (chosen === null || !advice.usable) return;
    setSlippage(chosen);
    close();
  };

  return (
    <Sheet
      title="Slippage limit"
      onClose={close}
      footer={
        <PrimaryButton onClick={use} disabled={chosen === null || !advice.usable}>
          {chosen !== null && advice.usable ? `Use ${displayBps(chosen)}` : `Choose a limit ${SLIPPAGE_BOUNDS_WORDS}`}
        </PrimaryButton>
      }
    >
      <div className="slippage">
        <p className="muted">If the price moves against you by more than this while your swap is under way, the swap is not made and your coins come back to your refund address.</p>
        <div className="slippage-choices" role="group" aria-label="Ready choices">
          {SLIPPAGE_CHOICES.map((bps) => (
            <button
              key={bps}
              type="button"
              className="button-chip mono"
              aria-pressed={!typed && picked === bps}
              onClick={() => {
                setPicked(bps);
                setOwn("");
              }}
            >
              {displayBps(bps)}
            </button>
          ))}
        </div>
        <div className="slippage-own">
          <label htmlFor="slippage-own">Another limit, in percent</label>
          <input
            id="slippage-own"
            className="slippage-input mono"
            value={own}
            onChange={(event) => setOwn(event.target.value.replace(/[^\d.,]/g, "").slice(0, 5))}
            inputMode="decimal"
            placeholder="0.10 to 5.00"
            autoComplete="off"
            aria-describedby="slippage-note"
          />
        </div>
        <p id="slippage-note" className="slippage-note" role="status" data-tone={advice.tone}>
          {typed || picked !== null ? (advice.note ?? " ") : " "}
        </p>
      </div>
    </Sheet>
  );
}
