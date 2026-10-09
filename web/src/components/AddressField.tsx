import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { addressMessage } from "../../../shared/address-words.ts";
import { checkAddress } from "../../../shared/addresses.ts";
import { chainInfo, chainName, isWalletChain } from "../../../shared/chains.ts";
import { api } from "../api.ts";
import { isContractCode } from "../lib/swap-logic.ts";

interface Props {
  label: string;
  /** What this address is for, in a few words under the label. */
  hint?: string;
  chain: string;
  value: string;
  onChange(value: string): void;
  /** The connected wallet's address, when it can be used here. */
  walletAddress: string | null;
  /** Show the note about exchange memos (receiving addresses on chains that use them). */
  memoNote?: boolean;
  /** Replaces the question put to our server about whether an address is a contract. Only the page of component states uses it. */
  contractCheck?: (chain: string, address: string, signal: AbortSignal) => Promise<boolean | null>;
}

/** Asks our own server whether an address on a wallet chain is a contract. Null when it cannot tell. */
async function isContract(chain: string, address: string, signal: AbortSignal): Promise<boolean | null> {
  try {
    const res = await fetch(`/api/rpc/${chain}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session": await api.sessionToken() },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
      signal,
      credentials: "omit",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown };
    return typeof body.result === "string" ? isContractCode(body.result) : null;
  } catch {
    return null;
  }
}

/** Holds the field's place while the coin list is on its way: when the list arrives, nothing below the field moves. */
export function AddressFieldPlaceholder({ label }: { label: string }) {
  return (
    <div className="address-field" aria-hidden="true">
      <div className="address-head">
        <span className="address-label">{label}</span>
      </div>
      <div className="address-input" />
      <p className="address-note" />
    </div>
  );
}

/**
 * An address field: one input with its label inside it. It checks as you type, names the right
 * chain when the address is for another one, and never fills itself in from the clipboard or from
 * history. The one thing that fills it for the person is "Use connected wallet", when they press it.
 */
export function AddressField({ label, hint, chain, value, onChange, walletAddress, memoNote = false, contractCheck = isContract }: Props) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const [contract, setContract] = useState(false);
  const text = value.trim();
  const check = text === "" ? null : checkAddress(chain, text);
  const error = check !== null && !check.ok ? addressMessage(chain, check.error, check.looksLike) : null;
  const valid = check !== null && check.ok ? check.address : null;

  // Grow with the text, so a long address wraps instead of scrolling sideways.
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    // The box is sized with its border, the text is measured without it: add the border back, or the last line is clipped by it.
    element.style.height = `${element.scrollHeight + (element.offsetHeight - element.clientHeight)}px`;
  }, [value]);

  // A contract where a wallet is expected is worth a warning, not a refusal.
  useEffect(() => {
    setContract(false);
    if (valid === null || !isWalletChain(chain) || chainInfo(chain).family !== "evm") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void contractCheck(chain, valid, controller.signal).then((answer) => {
        if (answer === true && !controller.signal.aborted) setContract(true);
      });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [chain, valid, contractCheck]);

  // One line under the field (two on a phone), always in the same place, so nothing below it
  // moves: what is wrong comes first, then a warning, then the plain hint. Every text here is
  // written to fit that room; scripts/review-shots.ts checks that it does.
  const note: { kind: "error" | "warning" | "hint"; text: string } | null =
    error !== null
      ? { kind: "error", text: error }
      : contract
        ? { kind: "warning", text: "A contract, not a wallet. Check it can receive coins." }
        : memoNote
          ? { kind: "warning", text: "Exchange address? It may need a memo. We can't add one." }
          : hint
            ? { kind: "hint", text: hint }
            : null;

  return (
    <div
      className="address-field"
      ref={field}
      onFocus={() => {
        // Never leave the field being typed in under the pinned button.
        field.current?.scrollIntoView({ block: "nearest" });
      }}
    >
      <div className="address-head">
        {/* The label says what the address is for. Which chain it is on is said in the field itself, until something is typed. */}
        <label htmlFor={id} className="address-label">
          {label}
        </label>
        {walletAddress !== null && walletAddress !== valid ? (
          <button type="button" className="address-use" onClick={() => onChange(walletAddress)}>
            Use connected wallet
          </button>
        ) : null}
      </div>
      <textarea
        ref={area}
        id={id}
        className="address-input mono"
        rows={1}
        value={value}
        placeholder={`Enter ${chainName(chain)} address`}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={error !== null || undefined}
        aria-describedby={note !== null ? `${id}-note` : undefined}
        data-invalid={error !== null || undefined}
        onChange={(event) => onChange(event.target.value.replace(/\s+/g, ""))}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
      />
      <p id={`${id}-note`} className="address-note" data-kind={note?.kind} role={note?.kind === "error" ? "alert" : undefined}>
        {note?.kind === "warning" ? <TriangleAlert className="address-note-icon" size={16} strokeWidth={1.5} aria-hidden="true" /> : null}
        {note !== null ? <span>{note.text}</span> : null}
      </p>
    </div>
  );
}
