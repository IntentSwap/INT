import { PRACTICE_ORDER_LINE } from "../../../shared/banner.ts";
import { useApp } from "../stores/app.ts";

/**
 * The one line a practice order carries, beside its deposit address. Nothing else on the site
 * says that practice mode is on; this does, because an address on a screen invites a transfer.
 * On the live site it is never drawn: the server there cannot be in practice mode.
 */
export function PracticeLine() {
  const practice = useApp((state) => state.config?.practice ?? false);
  return practice ? <p className="practice-line">{PRACTICE_ORDER_LINE}</p> : null;
}
