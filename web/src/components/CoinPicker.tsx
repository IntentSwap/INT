import { ArrowLeft, Check, ExternalLink, Search } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import type { TokenView } from "../../../shared/api.ts";
import { chainName, explorerAddressUrl } from "../../../shared/chains.ts";
import { chainColour, chainIconUrl, initials } from "../lib/icons.ts";
import { chainsOnList } from "../lib/site-logic.ts";
import { coinLabel, contractChain, gridMove, lookAlikes, pickerRows, searchChains, shortAddress, type PickerRows } from "../lib/swap-logic.ts";
import type { PickerSide } from "../stores/picker.ts";
import { useSwap } from "../stores/swap.ts";
import { useTokens } from "../stores/tokens.ts";
import { useWallet } from "../stores/wallet.ts";
import { Amount } from "./Amount.tsx";
import { CoinIcon } from "./CoinIcon.tsx";

const SKELETON_TILES = 12;
const SKELETON_ROWS = 5;
const MOVES = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"];

/** True where there is a mouse and a keyboard: a search field may then take the keyboard unasked. On touch that would open the on-screen keyboard. */
const finePointer = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/** A chain's mark at 24 px: its own artwork, the same as on the strip of chains, or its first letters where the site has none. */
function ChainMark({ chain }: { chain: string }) {
  const url = chainIconUrl(chain);
  if (url !== null) return <img className="chain-mark" src={url} alt="" width={24} height={24} decoding="async" loading="lazy" />;
  return (
    <span className="chain-mark chain-mark-letters" aria-hidden="true">
      {initials(chainName(chain))}
    </span>
  );
}

/**
 * One chain in the picker's grid: its mark and its name on a very faint wash of its own colour.
 * The colour is data (lib/icons.ts); the stylesheet only mixes it in.
 */
export function ChainTile({ chain, name, selected, tabbable = false, onChoose }: { chain: string; name: string; selected: boolean; tabbable?: boolean; onChoose?(event: MouseEvent<HTMLButtonElement>): void }) {
  return (
    <button type="button" role="option" className="chain-tile" aria-selected={selected} tabIndex={tabbable ? 0 : -1} data-chain={chain} title={name} style={{ "--chain-colour": chainColour(chain) } as CSSProperties} onClick={onChoose}>
      <ChainMark chain={chain} />
      <span className="chain-tile-name">{name}</span>
    </button>
  );
}

interface RowProps {
  token: TokenView;
  /** The row's place in the list, and the list's own name for it. */
  index: number;
  id: string;
  /** The row Enter would choose: the one the arrow keys or the pointer are on. */
  active: boolean;
  /** The coin already in use on this side. */
  chosen: boolean;
  /** "You receive" or "You pay" when this is the coin on the other side of the swap. */
  otherSide: string | null;
  /** A row for a coin on another chain than the one being shown: it names its chain. */
  elsewhere: boolean;
  /** Shares its symbol and chain with another coin: its contract is what tells them apart. */
  twin: boolean;
  balance: bigint;
  onPick?(): void;
  onPoint?(): void;
}

/**
 * One coin in the picker's list: its icon, its name, and beneath the name its symbol with a
 * shortened contract address and a small link to the chain's explorer (a chain's own coin has no
 * contract, and shows its symbol alone). The whole row chooses the coin; the link is the one thing
 * on it that does something else.
 */
export function CoinRow({ token, index, id, active, chosen, otherSide, elsewhere, twin, balance, onPick, onPoint }: RowProps) {
  const explorer = token.contract === null ? null : explorerAddressUrl(token.chain, token.contract, "token");
  const showContract = token.contract !== null && (!elsewhere || twin);
  const hasEnd = balance > 0n || chosen || otherSide !== null;
  return (
    <div
      role="row"
      className="picker-row"
      aria-selected={chosen}
      data-index={index}
      data-active={active || undefined}
      onPointerMove={(event) => {
        // A finger scrolling the list is not pointing at a row.
        if (event.pointerType !== "touch" && !active) onPoint?.();
      }}
    >
      <CoinIcon symbol={token.symbol} chain={token.chain} />
      <span className="picker-row-text">
        <span role="gridcell" id={id} className="picker-row-main">
          <button type="button" className="picker-pick" tabIndex={active ? 0 : -1} aria-describedby={hasEnd ? `${id}-sub ${id}-end` : `${id}-sub`} onClick={onPick} onFocus={onPoint}>
            <span className="picker-row-name">{token.name}</span>
          </button>
        </span>
        <span role="gridcell" className="picker-row-sub">
          <span id={`${id}-sub`} className="picker-row-symbol">
            {elsewhere ? coinLabel(token) : token.symbol}
          </span>
          {showContract && token.contract !== null ? <span className="picker-row-contract mono">{shortAddress(token.contract, 4)}</span> : null}
          {showContract && explorer !== null ? (
            <a className="picker-link" href={explorer} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-label={`${token.symbol} on the ${chainName(token.chain)} block explorer`} title="View on the block explorer">
              <ExternalLink size={12} strokeWidth={1.5} aria-hidden="true" />
            </a>
          ) : null}
        </span>
      </span>
      {hasEnd ? (
        <span role="gridcell" id={`${id}-end`} className="picker-row-end">
          {balance > 0n ? (
            <span className="picker-row-balance muted">
              <Amount raw={balance} decimals={token.decimals} />
            </span>
          ) : null}
          {chosen ? (
            <span className="picker-row-mark">
              <Check size={16} strokeWidth={1.5} aria-hidden="true" />
              <span className="sr-only">Chosen</span>
            </span>
          ) : otherSide !== null ? (
            <span className="picker-row-mark muted">{otherSide}</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** What the picker says in place of a list. */
export function PickerNote({ title, children }: { title: string; children?: string }) {
  return (
    <div className="picker-note" role="status">
      <p className="picker-note-title">{title}</p>
      {children !== undefined ? <p className="muted">{children}</p> : null}
    </div>
  );
}

/**
 * The coin picker: a view of the swap card itself, never a window laid over the page. Chains
 * first: a search and a grid of every chain on the coin list, with the chain already in use on
 * this side chosen. Beneath a hairline, the coins of the chosen chain alone, with a search by name
 * or by a pasted contract address. Tab goes from one search to the grid, to the other search and
 * to the list; the arrow keys move within the grid and the list; Enter chooses; Esc and the
 * browser's Back button return to the swap.
 */
export function CoinPicker({ side, leaving = false, onClose }: { side: PickerSide; leaving?: boolean; onClose(): void }) {
  const titleId = useId();
  const listId = useId();
  const headingId = useId();
  const tokens = useTokens((state) => state.tokens);
  const byId = useTokens((state) => state.byId);
  const loading = useTokens((state) => state.status === "loading" && state.tokens.length === 0);
  const fromId = useSwap((state) => state.fromId);
  const toId = useSwap((state) => state.toId);
  const setFrom = useSwap((state) => state.setFrom);
  const setTo = useSwap((state) => state.setTo);
  const chosenId = side === "from" ? fromId : toId;
  const otherId = side === "from" ? toId : fromId;

  const title = useRef<HTMLHeadingElement>(null);
  const chainInput = useRef<HTMLInputElement>(null);
  const coinInput = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // ---- Chains ----
  const chains = useMemo(() => chainsOnList(tokens), [tokens]);
  // The chain being shown. It starts as the chain of the coin in use on this side, and from then on
  // only this picker changes it: choosing a coin, which closes the picker, moves nothing on its way out.
  const inUse = chosenId === null ? null : (byId.get(chosenId)?.chain ?? null);
  const [picked, setPicked] = useState<string | null>(inUse);
  if (picked === null && inUse !== null) setPicked(inUse);
  const chain = picked ?? chains[0]?.key ?? null;
  const [chainQuery, setChainQuery] = useState("");
  const tiles = useMemo(() => searchChains(chains, chainQuery), [chains, chainQuery]);
  // The one tile Tab stops at: where the arrow keys last were, or the chosen chain, or the first.
  const [reached, setReached] = useState<string | null>(null);
  const tabStop = tiles.some((tile) => tile.key === reached) ? reached : tiles.some((tile) => tile.key === chain) ? chain : (tiles[0]?.key ?? null);

  /** Brings a chain's tile into the part of the grid that is on show, clear of the fade at its foot. The page itself is not scrolled. */
  const showTile = (key: string | null) => {
    const box = grid.current;
    const tile = key === null ? null : (box?.querySelector<HTMLElement>(`[data-chain="${key}"]`) ?? null);
    if (!box || tile === null) return;
    const fade = parseFloat(getComputedStyle(box).paddingBottom) || 0;
    const top = tile.offsetTop;
    const bottom = top + tile.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight - fade) box.scrollTop = bottom - (box.clientHeight - fade);
  };
  // The chosen chain is in view when the picker opens, and whenever it changes.
  useLayoutEffect(() => {
    showTile(chain);
  }, [chain, tiles]);

  const chooseChain = (key: string, byPointer: boolean) => {
    setPicked(key);
    setReached(key);
    // After a press on a chain the keyboard goes to the coin search, so typing and the arrow keys carry on from there.
    // Chosen with the keyboard, the chain keeps the focus: the person is still among the chains.
    if (byPointer && finePointer()) coinInput.current?.focus({ preventScroll: true });
  };

  const focusTile = (key: string) => {
    setReached(key);
    const tile = grid.current?.querySelector<HTMLElement>(`[data-chain="${key}"]`);
    tile?.focus({ preventScroll: true });
    showTile(key);
    tile?.scrollIntoView({ block: "nearest" });
  };

  const onGridKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!MOVES.includes(event.key)) return;
    const from = tiles.findIndex((tile) => tile.key === (event.target as HTMLElement).dataset.chain);
    if (from === -1) return;
    event.preventDefault();
    const columns = grid.current === null ? 1 : getComputedStyle(grid.current).gridTemplateColumns.split(" ").length;
    // Up from the first row of chains is the chain search.
    if (event.key === "ArrowUp" && from < columns) {
      chainInput.current?.focus();
      return;
    }
    const next = tiles[gridMove(from, event.key, tiles.length, columns)];
    if (next !== undefined) focusTile(next.key);
  };

  const onChainSearchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    const first = tiles[0];
    if (first === undefined) return;
    if (event.key === "ArrowDown") focusTile(tabStop ?? first.key);
    // Enter takes the best match.
    else if (event.key === "Enter") chooseChain(first.key, false);
    else return;
    event.preventDefault();
  };

  // ---- Coins ----
  const balances = useWallet((state) => state.balances);
  const walletAddress = useWallet((state) => (state.status === "connected" ? state.address : null));
  const loadBalances = useWallet((state) => state.loadBalances);
  // With a wallet connected, what it holds is read as the picker opens.
  useEffect(() => {
    if (walletAddress !== null && tokens.length > 0) void loadBalances(tokens);
  }, [walletAddress, tokens, loadBalances]);

  const [query, setQuery] = useState("");
  const result = useMemo<PickerRows>(() => (chain === null ? { kind: "here", tokens: [] } : pickerRows(tokens, query, chain, balances)), [tokens, query, chain, balances]);
  const rows = result.kind === "here" || result.kind === "elsewhere" ? result.tokens : [];
  const elsewhere = result.kind === "elsewhere";
  // Two coins with the same symbol on the same chain are told apart by their contract.
  const twins = useMemo(() => lookAlikes(tokens), [tokens]);
  const [active, setActive] = useState(0);
  const hasList = !loading && rows.length > 0;
  const rowId = (index: number) => `${listId}-${index}`;

  // A new search, or another chain, starts from the top.
  useEffect(() => {
    setActive(0);
    scroller.current?.scrollTo({ top: 0 });
  }, [query, chain]);

  const search = (text: string) => {
    const next = text.slice(0, 120);
    setQuery(next);
    // A pasted contract address that is a listed coin on another chain: the picker goes to that chain and shows the coin.
    const home = contractChain(tokens, next, chain);
    if (home !== null) {
      setPicked(home);
      setReached(home);
      setChainQuery("");
    }
  };

  const pick = (token: TokenView) => {
    if (side === "from") setFrom(token.id);
    else setTo(token.id);
    onClose();
  };

  /** Moves the highlight, from the search field: the keyboard stays where it is typing. */
  const highlight = (index: number) => {
    setActive(index);
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onCoinSearchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (rows.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") highlight(gridMove(active, event.key, rows.length, 1));
    else if (event.key === "Enter") {
      const token = rows[active];
      if (token !== undefined) pick(token);
    } else return;
    event.preventDefault();
  };

  /** The arrow keys inside the list: up and down between coins, right to a coin's explorer link and left back from it. */
  const onListKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!MOVES.includes(event.key)) return;
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".picker-row");
    if (row === null) return;
    const index = Number(row.dataset.index);
    const onLink = target.classList.contains("picker-link");
    event.preventDefault();
    if (event.key === "ArrowRight") {
      if (!onLink) row.querySelector<HTMLElement>(".picker-link")?.focus();
    } else if (event.key === "ArrowLeft") {
      if (onLink) row.querySelector<HTMLElement>(".picker-pick")?.focus();
    } else if (event.key === "ArrowUp" && index === 0) {
      // Up from the first coin is the coin search.
      coinInput.current?.focus();
    } else {
      const next = gridMove(index, event.key, rows.length, 1);
      setActive(next);
      list.current?.querySelector<HTMLElement>(`[data-index="${next}"] .picker-pick`)?.focus();
    }
  };

  // The keyboard goes into the picker as it opens: to the coin search where there is a mouse and a keyboard,
  // and to the picker's title on a touch screen, where a search field would bring the on-screen keyboard up unasked.
  // Never by scrolling the page.
  useEffect(() => {
    (finePointer() ? coinInput.current : title.current)?.focus({ preventScroll: true });
  }, []);

  // Esc returns to the swap, wherever in the page the keyboard is. A sheet open over the page closes itself first,
  // and so does anything else that lies over the page without being part of it (the wallet's own window): that is
  // told by what is on top at the middle of the screen.
  useEffect(() => {
    if (leaving) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const top = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      const covered = top !== null && top !== document.body && top !== document.documentElement && document.getElementById("root")?.contains(top) === false;
      if (document.querySelector("dialog[open]") !== null || covered) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [leaving, onClose]);

  const shownChain = chain === null ? "" : chainName(chain);
  const said = loading
    ? ""
    : result.kind === "here"
      ? `${rows.length} ${rows.length === 1 ? "coin" : "coins"} on ${shownChain}`
      : result.kind === "elsewhere"
        ? `No match on ${shownChain}. ${rows.length} on other chains`
        : "";

  return (
    <div className="card-view card-picker" role="region" aria-labelledby={titleId} data-side={side} inert={leaving}>
      <div className="picker-head">
        <button type="button" className="picker-back" onClick={onClose} aria-label="Back to the swap" title="Back">
          <ArrowLeft size={20} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <h2 ref={title} id={titleId} className="picker-title" tabIndex={-1}>
          {side === "from" ? "Select a token you pay" : "Select a token you receive"}
        </h2>
      </div>

      <label className="picker-search">
        <Search size={16} strokeWidth={1.5} aria-hidden="true" />
        <span className="sr-only">Search by chain name</span>
        <input
          ref={chainInput}
          className="picker-input"
          type="text"
          inputMode="search"
          enterKeyHint="done"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Search by chain name"
          // The down arrow leaves this field for the grid of chains: it counts as moving about with the keyboard (see lib/keys.ts).
          data-arrows=""
          value={chainQuery}
          onChange={(event) => setChainQuery(event.target.value.slice(0, 40))}
          onKeyDown={onChainSearchKeys}
        />
      </label>
      {loading ? (
        <div className="picker-chains" aria-hidden="true">
          {Array.from({ length: SKELETON_TILES }, (_, index) => (
            <span key={index} className="skeleton skeleton-tile" />
          ))}
        </div>
      ) : tiles.length === 0 ? (
        <div className="picker-chains picker-chains-none">
          <PickerNote title="No chain matches.">Check the spelling: every chain on the coin list is here.</PickerNote>
        </div>
      ) : (
        <div ref={grid} className="picker-chains" role="listbox" aria-label="Chain" onKeyDown={onGridKeys}>
          {tiles.map((tile) => (
            <ChainTile key={tile.key} chain={tile.key} name={tile.name} selected={tile.key === chain} tabbable={tile.key === tabStop} onChoose={(event) => chooseChain(tile.key, event.detail > 0)} />
          ))}
        </div>
      )}

      <hr className="picker-divider" />

      <label className="picker-search">
        <Search size={16} strokeWidth={1.5} aria-hidden="true" />
        <span className="sr-only">Search by name or paste address</span>
        <input
          ref={coinInput}
          className="picker-input"
          type="text"
          inputMode="search"
          enterKeyHint="done"
          role="combobox"
          aria-haspopup="grid"
          // Open only while there is a list to move through: with no match there is nothing it controls.
          aria-expanded={hasList}
          aria-controls={hasList ? listId : undefined}
          aria-activedescendant={hasList ? rowId(active) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Search by name or paste address"
          value={query}
          onChange={(event) => search(event.target.value)}
          onKeyDown={onCoinSearchKeys}
        />
      </label>
      <div ref={scroller} className="picker-coins">
        {loading ? (
          <div className="picker-list" aria-hidden="true">
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <div key={index} className="picker-row">
                <span className="skeleton skeleton-icon" />
                <span className="picker-row-text">
                  <span className="skeleton skeleton-line" />
                  <span className="skeleton skeleton-line skeleton-line-short" />
                </span>
              </div>
            ))}
          </div>
        ) : result.kind === "unsupported" ? (
          <PickerNote title="Not supported.">That contract is not on the list of coins that can be swapped here. Search by name to see what is.</PickerNote>
        ) : rows.length === 0 ? (
          <PickerNote title="No coins match.">Check the spelling, or paste the coin's contract address.</PickerNote>
        ) : (
          <>
            {elsewhere ? (
              <h3 id={headingId} className="picker-heading">
                On other chains
              </h3>
            ) : null}
            <div ref={list} id={listId} className="picker-list" role="grid" aria-label={elsewhere ? undefined : `Coins on ${shownChain}`} aria-labelledby={elsewhere ? headingId : undefined} onKeyDown={onListKeys}>
              {rows.map((token, index) => (
                <CoinRow
                  key={token.id}
                  token={token}
                  index={index}
                  id={rowId(index)}
                  active={index === active}
                  chosen={token.id === chosenId}
                  otherSide={token.id === otherId ? (side === "from" ? "You receive" : "You pay") : null}
                  elsewhere={elsewhere}
                  twin={twins.has(token.id)}
                  balance={balances.get(token.id) ?? 0n}
                  onPick={() => pick(token)}
                  onPoint={() => setActive(index)}
                />
              ))}
            </div>
          </>
        )}
      </div>
      <p className="sr-only" role="status">
        {said}
      </p>
    </div>
  );
}
