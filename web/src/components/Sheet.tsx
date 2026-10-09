import { X } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { IconButton } from "./Button.tsx";

/** A drag further than this, on release, closes a bottom sheet. */
const DRAG_TO_CLOSE = 80;
/** How long the closing movement takes. The same as --motion-sheet in the token file. */
const CLOSE_MS = 250;

interface Props {
  title: string;
  onClose(): void;
  children: ReactNode;
  /** Stays at the bottom of the sheet while the rest scrolls: the place for its one button. */
  footer?: ReactNode;
  /** While true, nothing closes the sheet: not Close, not Esc, not a press outside, not a drag. For the moment something is in flight. */
  locked?: boolean;
}

/**
 * A dialog: a bottom sheet on a narrow screen, a centred panel on a wide one.
 * The browser's own modal dialog does the hard parts: focus stays inside, Esc closes,
 * the page behind cannot be used, and focus goes back to where it was on close.
 * Only one is ever open (see stores/sheet.ts).
 */
export function Sheet({ title, onClose, children, footer, locked = false }: Props) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<number | null>(null);

  // A layout effect, not an ordinary one: its clean-up runs while the dialog is still on the page.
  // Closing it then (rather than letting it simply be removed) is what returns focus to the opener.
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    // The page behind stays where it is.
    document.documentElement.dataset.sheet = "open";
    return () => {
      delete document.documentElement.dataset.sheet;
      if (element.open) element.close();
    };
  }, []);

  // Whatever opened the sheet is told once that it has closed, however it came to close.
  const told = useRef(false);
  const tellClosed = useCallback(() => {
    if (told.current) return;
    told.current = true;
    onClose();
  }, [onClose]);

  const requestClose = useCallback(() => {
    if (closing || locked) return;
    setClosing(true);
    // The closing movement runs first; this is the length of --motion-sheet.
    window.setTimeout(tellClosed, CLOSE_MS);
  }, [closing, locked, tellClosed]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (locked || event.pointerType === "mouse" || (event.target as HTMLElement).closest("button") !== null) return;
    dragFrom.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragFrom.current !== null) setDrag(Math.max(0, event.clientY - dragFrom.current));
  };
  const onPointerEnd = () => {
    if (dragFrom.current === null) return;
    dragFrom.current = null;
    if (drag > DRAG_TO_CLOSE) requestClose();
    else setDrag(0);
  };

  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-labelledby={titleId}
      data-closing={closing || undefined}
      data-dragging={drag > 0 || undefined}
      style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
      onCancel={(event) => {
        // Esc: close with the same movement as every other way out.
        event.preventDefault();
        requestClose();
      }}
      onClose={() => {
        // A browser closes a dialog on a second press of Esc whatever the page answered to the first.
        // A locked sheet is put straight back; any other is simply treated as closed.
        const element = dialog.current;
        if (element === null || element.open) return;
        if (locked) element.showModal();
        else tellClosed();
      }}
      onClick={(event) => {
        // A press on the dimmed page behind lands on the dialog itself, not on anything inside it.
        if (event.target === dialog.current) requestClose();
      }}
    >
      <div className="sheet-panel">
        <div className="sheet-head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
          <span className="sheet-handle" aria-hidden="true" />
          <div className="sheet-title-row">
            <h2 id={titleId} className="sheet-title">
              {title}
            </h2>
            <IconButton label="Close" onClick={requestClose} disabled={locked}>
              <X size={20} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        <div className="sheet-body">{children}</div>
        {footer !== undefined ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </dialog>
  );
}
