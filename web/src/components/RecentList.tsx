import { chainName } from "../../../shared/chains.ts";
import { useGhost } from "../stores/ghost.ts";
import type { RecentOrder } from "../stores/orders.ts";
import { SecondaryButton } from "./Button.tsx";
import { CoinIcon } from "./CoinIcon.tsx";

/** "2026-10-08, 14:05" on this device's clock: numbers only, so it reads the same everywhere. */
function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}, ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** What stands in the list's place while Ghost mode is on: one quiet line, and nothing of any order. */
export function RecentHidden() {
  return <p className="recent-hidden muted">Orders made in this browser are not shown in Ghost mode.</p>;
}

/**
 * The orders made in this browser, newest first, or the one line that says there are none. The list is kept in this browser and nowhere else. It is shown on the Track order page.
 * In Ghost mode it is not drawn at all, whoever asks for it: no row, no count, no "Clear history".
 */
export function RecentList({ orders, onOpen, onClear }: { orders: RecentOrder[]; onOpen(id: string): void; onClear(): void }) {
  const ghost = useGhost((state) => state.on);
  if (ghost) return <RecentHidden />;
  return (
    <div className="recent">
      {orders.length === 0 ? (
        <p className="recent-empty">No swaps yet in this browser.</p>
      ) : (
        <ul className="recent-list">
          {orders.map((order) => (
            <li key={order.id}>
              <a
                className="recent-row"
                href={`/order/${order.id}`}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                  event.preventDefault();
                  onOpen(order.id);
                }}
              >
                <CoinIcon symbol={order.to.symbol} chain={order.to.chain} logo={order.to.logo} />
                <span className="recent-row-text">
                  <span className="recent-row-main">
                    {/* The two coins and no amount: the list keeps none (see stores/orders.ts). The order's own page gives the figures. */}
                    {order.from.symbol} to {order.to.symbol}
                  </span>
                  <span className="recent-row-sub muted">
                    {chainName(order.from.chain)} to {chainName(order.to.chain)} · {when(order.createdAt)}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="recent-note muted">This list is kept only in this browser. Clearing it does not change the orders: each can still be opened with its link.</p>
      <SecondaryButton onClick={onClear} disabled={orders.length === 0}>
        Clear history
      </SecondaryButton>
    </div>
  );
}
