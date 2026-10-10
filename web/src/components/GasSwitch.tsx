import { useId } from "react";
import type { GasQuote, TokenView } from "../../../shared/api.ts";
import { GAS_LABEL, gasLine } from "../lib/gas-logic.ts";

interface Props {
  /** The server's preview of the gas order, or null where gas is not offered. */
  gas: GasQuote | null;
  /** The coin that would arrive: the receiving chain's own. */
  coin: Pick<TokenView, "symbol"> | null;
  on: boolean;
  onChange(on: boolean): void;
}

/**
 * "Add gas", under the receiving address: a switch, its name, and one line that says what arrives.
 * It is there only while the server offers gas for this swap, which it is asked once a valid
 * receiving address has been entered: the switch comes as the answer to the address, and goes with
 * it. Otherwise nothing of it is drawn: no switch that cannot be pressed, and no place kept for
 * one. When it comes it takes its place as the quote's line does, and everything beneath it moves
 * down by its height, once.
 * The whole row is the switch: it is pressed anywhere along it, and the keyboard reaches it like any button.
 */
export function GasSwitch({ gas, coin, on, onChange }: Props) {
  const id = useId();
  const offered = gas !== null && coin !== null;
  return (
    <div className="card-gas" data-open={offered || undefined}>
      <div className="card-gas-slot">
        {offered ? (
          <button type="button" role="switch" aria-checked={on} aria-labelledby={`${id}-name`} aria-describedby={`${id}-line`} className="gas-switch" onClick={() => onChange(!on)}>
            <span className="gas-switch-words">
              <span id={`${id}-name`} className="gas-switch-name">
                {GAS_LABEL}
              </span>
              <span id={`${id}-line`} className="gas-switch-line">
                {gasLine(gas.usd, coin.symbol)}
              </span>
            </span>
            <span className="gas-switch-track" aria-hidden="true">
              <span className="gas-switch-thumb" />
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
