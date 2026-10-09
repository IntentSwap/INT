import { Check, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TokenView } from "../../../shared/api.ts";
import { chainName } from "../../../shared/chains.ts";
import { FEATURED_CHAINS } from "../config.ts";
import { lookAlikes, OTHER_CHAINS, searchTokens, shortAddress, sortTokens } from "../lib/swap-logic.ts";
import { useSheet } from "../stores/sheet.ts";
import { useSwap } from "../stores/swap.ts";
import { useTokens } from "../stores/tokens.ts";
import { useWallet } from "../stores/wallet.ts";
import { SecondaryButton } from "./Button.tsx";
import { Amount } from "./Amount.tsx";
import { CoinIcon } from "./CoinIcon.tsx";
import { Sheet } from "./Sheet.tsx";

const SKELETON_ROWS = 8;

/**
 * The coin picker: search by symbol, name or pasted contract; filter by chain; every row
 * names the coin together with its chain. Arrow keys move, Enter picks, Esc closes.
 */
export function CoinPicker({ side }: { side: "from" | "to" }) {
  const listId = useId();
  const close = useSheet((state) => state.close);
  const tokens = useTokens((state) => state.tokens);
  const status = useTokens((state) => state.status);
  const reload = useTokens((state) => state.load);
  const fromId = useSwap((state) => state.fromId);
  const toId = useSwap((state) => state.toId);
  const setFrom = useSwap((state) => state.setFrom);
  const setTo = useSwap((state) => state.setTo);

  const [query, setQuery] = useState("");
  const [chain, setChain] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // Coins the connected wallet holds come right after the pinned ones.
  const balances = useWallet((state) => state.balances);
  const walletAddress = useWallet((state) => (state.status === "connected" ? state.address : null));
  const loadBalances = useWallet((state) => state.loadBalances);
  // With a wallet connected, what it holds is read as the picker opens.
  useEffect(() => {
    if (walletAddress !== null && tokens.length > 0) void loadBalances(tokens);
  }, [walletAddress, tokens, loadBalances]);
  const sorted = useMemo(() => sortTokens(tokens, balances), [tokens, balances]);
  const result = useMemo(() => searchTokens(sorted, query, chain), [sorted, query, chain]);
  const rows = result.kind === "list" ? result.tokens : [];
  const chosenId = side === "from" ? fromId : toId;
  // Two coins with the same symbol on the same chain are told apart by their contract.
  const twins = useMemo(() => lookAlikes(tokens), [tokens]);
  const searching = query.trim() !== "";
  // After a press on a chain chip the keyboard goes back to the search, so the arrow keys keep working.
  const choose = (next: string | null) => {
    setChain(next);
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) input.current?.focus();
  };
  const otherId = side === "from" ? toId : fromId;
  // Only chains that have a coin on the list get a chip.
  const chips = useMemo(() => FEATURED_CHAINS.filter((key) => tokens.some((token) => token.chain === key)), [tokens]);
  const hasOthers = useMemo(() => tokens.some((token) => !(FEATURED_CHAINS as readonly string[]).includes(token.chain)), [tokens]);

  // A new search starts from the top.
  useEffect(() => {
    setActive(0);
    list.current?.scrollTo({ top: 0 });
  }, [query, chain]);

  // With a mouse and keyboard the search is ready to type in. On touch that would open the keyboard unasked.
  useEffect(() => {
    if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) input.current?.focus();
  }, []);

  const pick = (token: TokenView) => {
    if (side === "from") setFrom(token.id);
    else setTo(token.id);
    close();
  };

  const move = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setActive(next);
    list.current?.children[next]?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") move(active + 1);
    else if (event.key === "ArrowUp") move(active - 1);
    else if (event.key === "Home" && rows.length > 0) move(0);
    else if (event.key === "End" && rows.length > 0) move(rows.length - 1);
    else if (event.key === "Enter") {
      const token = rows[active];
      if (token !== undefined) pick(token);
    } else return;
    event.preventDefault();
  };

  const optionId = (index: number) => `${listId}-${index}`;
  const loading = status === "loading" && tokens.length === 0;
  const hasList = status !== "failed" && !loading && result.kind === "list" && rows.length > 0;

  return (
    <Sheet title={side === "from" ? "Coin you pay" : "Coin you receive"} onClose={close} tall>
      <div className="picker">
        <label className="picker-search">
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="sr-only">Search coins</span>
          <input
            ref={input}
            className="picker-input"
            type="text"
            inputMode="search"
            enterKeyHint="done"
            role="combobox"
            // Open only while there is a list to move through: with no match there is nothing it controls.
            aria-expanded={hasList}
            aria-controls={hasList ? listId : undefined}
            aria-activedescendant={hasList ? optionId(active) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Symbol, name or contract address"
            value={query}
            onChange={(event) => setQuery(event.target.value.slice(0, 120))}
            onKeyDown={onKeyDown}
          />
        </label>

        {/* While something is being searched for, only "All" and the chosen chain stay: on a small phone with the keyboard open the list needs the room. */}
        <div className="picker-chips" role="group" aria-label="Chain">
          <button type="button" className="button-chip" aria-pressed={chain === null} onClick={() => choose(null)}>
            All
          </button>
          {chips
            .filter((key) => !searching || chain === key)
            .map((key) => (
              <button key={key} type="button" className="button-chip" aria-pressed={chain === key} onClick={() => choose(key)}>
                {chainName(key)}
              </button>
            ))}
          {hasOthers && (!searching || chain === OTHER_CHAINS) ? (
            <button type="button" className="button-chip" aria-pressed={chain === OTHER_CHAINS} onClick={() => choose(OTHER_CHAINS)}>
              Other chains
            </button>
          ) : null}
        </div>

        {status === "failed" ? (
          <div className="picker-empty" role="status">
            <p className="picker-empty-title">Couldn't load coins.</p>
            <p className="muted">The list of coins didn't arrive. Check your connection and try again.</p>
            <SecondaryButton onClick={() => void reload()}>Try again</SecondaryButton>
          </div>
        ) : loading ? (
          <ul className="picker-list" aria-hidden="true">
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <li key={index} className="picker-row">
                <span className="skeleton skeleton-icon" />
                <span className="picker-row-text">
                  <span className="skeleton skeleton-line" />
                  <span className="skeleton skeleton-line skeleton-line-short" />
                </span>
              </li>
            ))}
          </ul>
        ) : result.kind === "unsupported" ? (
          <div className="picker-empty" role="status">
            <p className="picker-empty-title">This coin is not supported.</p>
            <p className="muted">That contract is not on the list of coins that can be swapped here. Search by symbol to see what is.</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="picker-empty" role="status">
            <p className="picker-empty-title">No coins match.</p>
            <p className="muted">{chain !== null ? 'Check the spelling, or choose "All" to search every chain.' : "Check the spelling, or paste the coin's contract address."}</p>
          </div>
        ) : (
          <ul ref={list} id={listId} className="picker-list" role="listbox" aria-label="Coins">
            {rows.map((token, index) => (
              <li
                key={token.id}
                id={optionId(index)}
                className="picker-row"
                role="option"
                aria-selected={token.id === chosenId}
                data-active={index === active || undefined}
                onClick={() => pick(token)}
                onPointerMove={(event) => {
                  // A finger scrolling the list is not pointing at a row.
                  if (event.pointerType !== "touch" && index !== active) setActive(index);
                }}
              >
                <CoinIcon symbol={token.symbol} chain={token.chain} />
                <span className="picker-row-text">
                  <span className="picker-row-main">
                    <span className="picker-row-symbol">{token.symbol}</span>
                    <span className="muted"> · {chainName(token.chain)}</span>
                  </span>
                  {/* A coin whose name is its symbol (BNB) is not said twice. A coin with a twin shows its contract. */}
                  {twins.has(token.id) && token.contract !== null ? (
                    <span className="picker-row-name faint">
                      {token.name} · <span className="mono">{shortAddress(token.contract)}</span>
                    </span>
                  ) : token.name.toLowerCase() !== token.symbol.toLowerCase() ? (
                    <span className="picker-row-name faint">{token.name}</span>
                  ) : null}
                </span>
                {(balances.get(token.id) ?? 0n) > 0n ? (
                  <span className="picker-row-balance muted">
                    <Amount raw={balances.get(token.id) ?? 0n} decimals={token.decimals} />
                  </span>
                ) : null}
                {token.id === chosenId ? (
                  <span className="picker-row-mark">
                    <Check size={16} strokeWidth={1.5} aria-hidden="true" />
                    <span className="sr-only">Chosen</span>
                  </span>
                ) : token.id === otherId ? (
                  <span className="picker-row-mark muted">{side === "from" ? "You receive" : "You pay"}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="sr-only" role="status">
          {result.kind === "list" && !loading ? `${rows.length} ${rows.length === 1 ? "coin" : "coins"}` : ""}
        </p>
      </div>
    </Sheet>
  );
}
