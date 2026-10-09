// Notes on the page whether the keyboard is being used to move about. The site shows where the
// focus is only then (one quiet line; see base.css), so nothing is ever outlined after a click, a
// tap, Escape, a sheet opening or closing, or the page arriving.
//
// The note is made by Tab and by the arrow keys (outside a text field, where they only move the
// caret). It is taken away by any press of a mouse, a finger or a pen, by Escape, and whenever the
// focus moves for any other reason than one of those keys: a sheet that opens and takes the focus,
// or closes and hands it back, is not someone moving about with the keyboard.

const MOVES = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** True for a place where the arrow keys move a caret, not the focus. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true;
  // The coin picker's search is a field too, but there the up and down arrows move along the list.
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range"].includes(target.type) && target.getAttribute("role") !== "combobox";
}

export function watchKeys(root: HTMLElement = document.documentElement): () => void {
  // True from the moment one of the keys goes down until it comes up: a move of the focus in between is that key's doing.
  let moving = false;
  const down = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      delete root.dataset.keys;
      return;
    }
    if (!MOVES.has(event.key) || (event.key !== "Tab" && typing(event.target))) return;
    moving = true;
    root.dataset.keys = "";
  };
  const up = (event: KeyboardEvent) => {
    if (MOVES.has(event.key)) moving = false;
  };
  const pointer = () => {
    moving = false;
    delete root.dataset.keys;
  };
  const focus = () => {
    if (!moving) delete root.dataset.keys;
  };
  window.addEventListener("keydown", down, true);
  window.addEventListener("keyup", up, true);
  window.addEventListener("pointerdown", pointer, true);
  window.addEventListener("focusin", focus, true);
  return () => {
    window.removeEventListener("keydown", down, true);
    window.removeEventListener("keyup", up, true);
    window.removeEventListener("pointerdown", pointer, true);
    window.removeEventListener("focusin", focus, true);
  };
}
