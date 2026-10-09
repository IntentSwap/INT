// Fee helpers. The fee is set by the server from FEE_BPS and FEE_RECIPIENT.
// What is shown to a person always comes from the fees echoed in the quote.

import { bpsOf } from "../shared/amounts.ts";
import type { FeeView } from "../shared/api.ts";

/** Fee recipients are 0x addresses or NEAR accounts; both compare without regard to case. */
export function sameFeeRecipient(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function feeView(amountIn: bigint, appBps: number, providerBps: number): FeeView {
  return {
    appBps,
    providerBps,
    appAmount: bpsOf(amountIn, appBps).toString(),
    providerAmount: bpsOf(amountIn, providerBps).toString(),
  };
}
