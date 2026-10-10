import { GlobeLock, SaveOff, Trash2, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { useGhost } from "../stores/ghost.ts";
import { useSheet } from "../stores/sheet.ts";
import { PrimaryButton, SecondaryButton } from "./Button.tsx";
import { Link } from "./Link.tsx";
import { Sheet } from "./Sheet.tsx";

/** What changes while Ghost mode is on, as the person meets it: one plain sentence each. */
export const GHOST_CHANGES = [
  { key: "wallet", Icon: Unplug, text: "No wallet is connected, and none of the wallet software is loaded. You pay by sending to the deposit address." },
  { key: "requests", Icon: GlobeLock, text: "This page asks nothing of any address but this site's own." },
  { key: "browser", Icon: SaveOff, text: "Nothing is kept in this browser but the switch itself, for this tab only, so that loading the page again does not turn it off." },
  { key: "record", Icon: Trash2, text: "An order you make is not listed among recent swaps, and its record is deleted from the server the moment it finishes." },
] as const;

/** What the mode does not change, said as plainly. */
export const GHOST_STILL = "Your deposit and your delivery are still public on their own chains, the swap service still carries out the swap, and your internet address is still seen by your network and by this site's host.";

/**
 * The sheet that explains Ghost mode, shown before the mode is first turned on since the page was
 * loaded: what changes, in four lines; what does not; and the one extra thing turning it on can do,
 * which is to clear what this browser already holds. "Turn on" turns it on. "Not now", Close and Esc
 * close the sheet and change nothing.
 */
export function GhostSheet() {
  const close = useSheet((state) => state.close);
  const turnOn = useGhost((state) => state.turnOn);
  const [clear, setClear] = useState(false);
  // From the press of "Turn on" until the mode is on. Usually no time at all; a connected wallet is let go of first.
  const [turning, setTurning] = useState(false);

  // The sheet leaves in the very moment the mode comes on, so that the two are one change on the screen.
  useEffect(
    () =>
      useGhost.subscribe((ghost) => {
        if (ghost.on) close();
      }),
    [close],
  );

  const confirm = () => {
    if (turning) return;
    setTurning(true);
    void turnOn({ clear });
  };

  return (
    <Sheet
      title="Ghost mode"
      onClose={close}
      locked={turning}
      footer={
        <>
          <label className="check ghost-clear">
            <input type="checkbox" checked={clear} onChange={(event) => setClear(event.target.checked)} disabled={turning} />
            <span>
              Also clear what this browser already holds
              <span className="ghost-clear-what muted">The list of orders made in this browser, and what a connected wallet left.</span>
            </span>
          </label>
          <div className="ghost-buttons">
            <SecondaryButton onClick={close} disabled={turning}>
              Not now
            </SecondaryButton>
            <PrimaryButton onClick={confirm} disabled={turning} busy={turning}>
              {turning ? "Turning on…" : "Turn on"}
            </PrimaryButton>
          </div>
        </>
      }
    >
      <div className="ghost-sheet">
        <p className="ghost-lead">While it is on, four things change.</p>
        <ul className="ghost-points">
          {GHOST_CHANGES.map(({ key, Icon, text }) => (
            <li key={key} className="ghost-point">
              <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
        <p className="ghost-still muted">
          {GHOST_STILL}{" "}
          <Link href="/docs/ghost-mode" onNavigate={close}>
            More<span className="sr-only"> about Ghost mode</span>
          </Link>
        </p>
      </div>
    </Sheet>
  );
}
